#!/usr/bin/env python3
"""Phase 0c: georeference the station CAD corpus by its TRACK CENTRELINES.

Phase 0b (`fit.mjs`) fits the platform lettering to the OSM platform
rectangles. That works, and 62 sheets came out of it, but it fails exactly
where the game needs it most. The inner stations are the big sheets, and the
big sheets are the ones whose text was converted to outlines, so the lettering
carries no identity and the fit is left matching platform arrangements -- which
is weak enough to have produced a false accept at Lidcombe. Worse, a platform
rectangle has no distinguishable ends, so a 180-degree reading of the sheet
fits about as well as the truth and 33 sheets were rejected as ambiguous.

This phase matches geometry that every sheet has whether or not its lettering
survived, and that is asymmetric along the corridor:

  * the drawing's track centrelines, recovered from the sleeper hatching (see
    `trackgeom.sleeper_ticks` -- a tick is drawn across a track and across
    nothing else, so tick midpoints sample the drawn centrelines);
  * the world's track centrelines, the baked polylines in rail.bin.

A railway curves, and the curve is not symmetric end for end, so along-corridor
position and the 180-degree question are answered by the same evidence that
answers everything else. And the inner stations have MORE tracks in more
complicated fans, which is more signal, not less.

The transform is the same object Phase 0b solves and is written in the same
frame: world = A p + t, p in PDF page points (y up), world x east z south,
A orientation-REVERSING because a plan is drawn looking down and page y up is
north-ish while world z is south. `PLAN_IS_UNMIRRORED` in fit.mjs is the
measurement behind that, and this phase imposes it too.

Search: the corridor bearing is known on both sides to about a degree, so
rotation is a short sweep around two hypotheses 180 degrees apart; scale is
bounded by the sheet-coverage habit (300-900 m of railway per sheet); and
translation is a dense corridor-aligned grid scored against a Gaussian reward
image of the baked tracks. The best few placements are then refined against the
exact point-to-track distance and gated.

Idempotent and resumable: same inputs, same trackfit.json. `--only <slug>`
refits one station in place.

    uv run scripts/stationfit/trackfit.py [--only <slug>] [--jobs N]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.ndimage import distance_transform_edt
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parent))
from railbin import load_bake, directions          # noqa: E402
import trackgeom as tg                             # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
CAD = ROOT / "data" / "scratch" / "stationcad"
OUT = CAD / "trackfit.json"
SKIP = {"summary.json", "fit.json", "trackfit.json", "buildings.json",
        "extract_failures.json"}

# --- gates -------------------------------------------------------------------
# Same principle as Phase 0b and mostly the same numbers: a platform is ~10 m
# wide, so an error approaching half of that cannot be trusted to put a
# structure on the right side of the track. Track matching has far more
# correspondences than lettering did, so the residual gate is tighter.
# 4 m, not the 8 m Phase 0b uses on platform lettering. A track fit that is
# RIGHT comes out at about a metre -- the median over the accepted set is
# 0.84 m -- because it has hundreds of correspondences rather than four. So a
# residual near half a platform width is not a slightly worse fit of the same
# kind, it is a different answer. Dulwich Hill is the measurement behind the
# number: it passed at 4.36 m, and the overlay shows the drawn corridor and
# the baked one bowing apart across the sheet with a platform slab lying
# diagonally over both.
RAIL_RMS_ACCEPT = 4.0        # m, RMS baked-track-vertex -> nearest drawn tick
RAIL_P95_ACCEPT = 12.0       # m. Not the maximum: the bake routes services
                             # through crossovers the drawing need not agree
                             # with, so one vertex 20 m out is the bake being
                             # a graph, not the fit being wrong.
RAIL_COVER_ACCEPT = 0.85     # of the core corridor must be drawn on the sheet
# The corridor the sheet is required to explain. STATIONS.md records the sheets
# as spanning "479 m median" of railway; that is the PAGE width times the
# scale, and most of the page is margin, title block and a second view. The
# railway actually DRAWN -- measured here as the along-corridor span of the
# sleeper hatching over the 62 sheets Phase 0b accepted -- is 205 m at the
# median, 174 m at the 10th percentile. So the corridor a sheet can fairly be
# asked to account for is about +/- 85 m, not +/- 240 m.
CORE_RADIUS_M = 85.0
SCALE_RANGE = (0.22, 0.85)   # m per page point
COVERAGE_M = (300.0, 900.0)  # railway spanned by the sheet width
MIN_TICKS = 250              # a sheet with less hatching than this has no fit
# Determinacy. A straight, featureless corridor lets the drawing slide along
# itself; that is not a fit, it is a guess, and the gate has to say so.
ALONG_PROBE_M = 30.0
ALONG_MIN_DROP = 0.15
CROSS_PROBE_M = 12.0
CROSS_MIN_DROP = 0.30
FLIP_MIN_MARGIN = 1.12       # best must beat the best 180-degree reading
# The Lidcombe catcher, and the one gate that is independent of the objective:
# a platform slab has no sleepers on it. If the fit is one band out, the slab
# lands on a track and this fires.
PLATFORM_TICK_RATIO = 0.30
# The platforms are what fix along-corridor position, so they are held to it.
PLATFORM_OFFSET_M = 14.0     # drawn coping centre vs OSM slab centre, along
PLATFORM_LEN_RATIO = (0.78, 1.30)
PLATFORM_QUALITY = 0.70      # mean end-to-end overlap, drawn against OSM
PLATFORM_SPREAD_M = 16.0     # how far the platforms may disagree with each other
SIGMA_M = 5.0                # coarse reward width; ~half a track spacing
SHARP_SIGMA_M = 1.5          # the width the final look and the gates use
SCALE_PROBE = 0.08
SCALE_MIN_DROP = 0.10

WORLD_RADIUS = 900.0         # baked track kept within this of the station


# --- the objective -----------------------------------------------------------

class Target:
    """The world side, prepared once per station: a Gaussian reward image over
    the baked track centrelines, plus a KD-tree for exact scoring."""

    def __init__(self, tracks: np.ndarray, centre, cell: float = 2.0,
                 half: float = WORLD_RADIUS, sigma: float = SIGMA_M,
                 core_radius: float = CORE_RADIUS_M):
        self.centre = np.asarray(centre, float)
        self.cell = cell
        self.half = half
        self.sigma = sigma
        self.tracks = tracks
        self.tree = cKDTree(tracks) if len(tracks) else None
        self.core = tracks[np.hypot(tracks[:, 0] - self.centre[0],
                                    tracks[:, 1] - self.centre[1]) < core_radius]
        n = int(2 * half / cell)
        occ = np.ones((n, n), dtype=bool)
        ij = np.floor((tracks - self.centre + half) / cell).astype(int)
        ok = (ij[:, 0] >= 0) & (ij[:, 0] < n) & (ij[:, 1] >= 0) & (ij[:, 1] < n)
        occ[ij[ok, 1], ij[ok, 0]] = False
        self.dist = distance_transform_edt(occ) * cell
        self.G = np.exp(-0.5 * (self.dist / sigma) ** 2).astype(np.float32)
        self.n = n

    def sharpen(self, sigma: float):
        """The same target with a tighter reward. The 5 m reward is what makes
        the coarse search find the corridor at all; it is also what makes the
        answer nearly blind to scale, because moving an outer track 3 m barely
        changes exp(-d^2/2*25). The final look is taken at 1.5 m, where it
        does."""
        import copy
        o = copy.copy(self)
        o.sigma = sigma
        o.G = np.exp(-0.5 * (self.dist / sigma) ** 2).astype(np.float32)
        return o

    def reward(self, q: np.ndarray) -> np.ndarray:
        """G sampled at world points, 0 outside the image."""
        ij = np.floor((q - self.centre + self.half) / self.cell).astype(np.int64)
        ok = (ij[:, 0] >= 0) & (ij[:, 0] < self.n) & (ij[:, 1] >= 0) & (ij[:, 1] < self.n)
        out = np.zeros(len(q), dtype=np.float32)
        out[ok] = self.G[ij[ok, 1], ij[ok, 0]]
        return out

    def exact_reward(self, q: np.ndarray) -> np.ndarray:
        d, _ = self.tree.query(q)
        return np.exp(-0.5 * (d / self.sigma) ** 2)


def amat(theta: float, scale: float) -> np.ndarray:
    """The orientation-reversing similarity: A = s * [[c, s],[s, -c]].
    A page direction at angle phi comes out at world bearing theta - phi."""
    c, s = math.cos(theta), math.sin(theta)
    return scale * np.array([[c, s], [s, -c]])


def forward_score(target: Target, P: np.ndarray, A: np.ndarray, t: np.ndarray,
                  exact: bool = False) -> float:
    q = P @ A.T + t
    r = target.exact_reward(q) if exact else target.reward(q)
    return float(r.mean())


def combined(target: Target, P: np.ndarray, A: np.ndarray, t: np.ndarray,
             sigma: float, exact_fwd: bool = False) -> tuple[float, float, float]:
    """sqrt(forward * reverse).

    Forward alone is maximised by shoving every drawn tick onto one rail.
    Reverse alone is maximised by shrinking the sheet until it only has to
    explain a few metres of railway -- which is exactly what the first version
    of this file did at Allawah, settling on 0.274 m/pt against a true 0.389
    and covering 139 baked track points instead of 400. Their geometric mean is
    maximised only by a placement that explains the drawing with the world and
    the world with the drawing.

    The reverse denominator is therefore FIXED: `target.core`, every baked
    track vertex within 200 m of the station, chosen once and never varied by
    the candidate. A sheet spans 479 m of railway at the median, so a sheet
    that cannot explain the middle 400 m of its own corridor is not a fit.
    """
    q = P @ A.T + t
    f = float(target.exact_reward(q).mean()) if exact_fwd else float(target.reward(q).mean())
    tree = cKDTree(q)
    d, _ = tree.query(target.core)
    r = float(np.exp(-0.5 * (d / sigma) ** 2).mean())
    return math.sqrt(f * r), f, r


# --- what the tracks cannot say ----------------------------------------------
#
# The track fit pins rotation, scale and cross-corridor position hard: the
# drawn ladders land on the baked centrelines to about a metre. It is weak on
# the other two things, and honestly so:
#
#  * ALONG the corridor, because a railway through a suburban station is close
#    to straight over the ~205 m a sheet draws, so sliding the drawing 30 m
#    along it costs the objective a few per cent.
#  * The 180-DEGREE reading, because with handedness already imposed the rival
#    is the sheet turned end for end, and a symmetric track fan maps onto
#    itself. Strathfield's eight tracks group [1][2][2][2][1] across the
#    corridor -- a palindrome.
#
# Both are answered by the platforms, which the tracks have now placed the fit
# accurately enough to identify without any of Phase 0b's guessing about which
# platform is which: the slab says where to look, and what is found there is
# the drawn coping. Its ENDS are the along-corridor answer, and its length and
# offset against the OSM slab are what the end-for-end reading gets wrong.

def platform_match(chains_world, slabs, along_window=70.0):
    """Drawn platform extents against OSM slab extents, in the slab's frame."""
    out = []
    for s in slabs:
        u = np.array([s["ux"], s["uz"]])
        v = np.array([-s["uz"], s["ux"]])
        cen = np.array([s["x"], s["z"]])
        iv = []
        for q in chains_world:
            rel = q - cen
            a = rel @ u
            b = rel @ v
            inband = (np.abs(b) < s["halfWidth"] + 1.5) & (np.abs(a) < s["halfLength"] + along_window)
            if inband.mean() < 0.7:
                continue
            aa = a[inband]
            if aa.max() - aa.min() < 20.0:
                continue
            iv.append((float(aa.min()), float(aa.max())))
        merged = tg.merge_intervals(iv, gap=10.0)
        if not merged:
            out.append(None)
            continue
        a0, a1 = max(merged, key=lambda m: m[1] - m[0])
        out.append({"refs": s["refs"], "drawn": [a0, a1],
                    "centreOffsetM": (a0 + a1) / 2.0,
                    "lengthRatio": (a1 - a0) / (2 * s["halfLength"]),
                    "weight": a1 - a0})
    return out


def platform_quality(pm, slabs, shift=0.0):
    """Fraction of each slab covered by the drawn coping, after `shift` along
    the corridor, averaged over the slabs. 1.0 is a perfect end-to-end match;
    a slab with nothing drawn on it scores 0 and drags the station down, which
    is the point -- Phase 0b's Lidcombe false accept used two of three."""
    if not pm:
        return 0.0
    tot = 0.0
    for p, s in zip(pm, slabs):
        if p is None:
            continue
        a0, a1 = p["drawn"][0] - shift, p["drawn"][1] - shift
        hl = s["halfLength"]
        inter = max(0.0, min(a1, hl) - max(a0, -hl))
        union = max(a1, hl) - min(a0, -hl)
        tot += inter / max(1e-6, union)
    return tot / len(slabs)


def best_shift(pm):
    ws = [(p["centreOffsetM"], p["weight"]) for p in pm if p is not None]
    if not ws:
        return None
    w = sum(x[1] for x in ws)
    return sum(a * b for a, b in ws) / max(1e-6, w)


def building_density(sheet_pts_tree, n_pts, A, t, ob, radius_m=25.0):
    """How busy the drawing is where OSM puts the station building.

    A crude anchor and known to be crude -- Phase 0b measures the two sources
    agreeing to 19.7 m at the median -- but it is INDEPENDENT of both the
    tracks and the platforms, and a sheet read end for end puts the building
    on the far side of the corridor where the drawing has a car park."""
    if ob is None:
        return None
    p = (np.asarray(ob, float) - t) @ np.linalg.inv(A).T
    r_pt = radius_m / _scale_of(A)
    return len(sheet_pts_tree.query_ball_point(p, r_pt)) / max(1, n_pts)


def _scale_of(A):
    return math.sqrt(abs(A[0][0] * A[1][1] - A[0][1] * A[1][0]))


NOT_A_STATION = ("substation", "signal", "zone", "works", "depot", "shed")


def osm_building_anchor(lst):
    """Port of fit.mjs `osmBuildingAnchor`."""
    if not lst:
        return None
    def clean(b):
        n = (b.get("name") or "").lower()
        return not any(k in n for k in NOT_A_STATION)
    named = [b for b in lst if clean(b) and b["dist"] < 80
             and (b.get("building") == "train_station" or "station" in (b.get("name") or "").lower())]
    pool = named or [b for b in lst if clean(b) and b["dist"] < 45 and b["area"] > 20]
    if not pool:
        return None
    bx = bz = w = 0.0
    for b in pool:
        r = np.asarray(b["ring"], float)
        c = r.mean(axis=0)
        bx += c[0] * b["area"]
        bz += c[1] * b["area"]
        w += b["area"]
    return [bx / w, bz / w]


# --- one station -------------------------------------------------------------

def fit_station(slug: str, st: dict, dirs_lite, buildings, prev0b=None, verbose=False) -> dict:
    rec = {"slug": slug, "accept": False, "confidence": "rejected", "reason": None,
           "station": st["name"], "method": "track"}
    sheet = tg.load_sheet(slug)
    rec["name"] = sheet["station"]["name"]
    centre = np.array([st["x"], st["z"]], float)

    slabs = tg.slabs_of(st)
    rec["osmSlabs"] = len(slabs)
    if not slabs:
        rec["reason"] = "station carries no measured platform polygon"
        return rec
    tracks = tg.world_tracks(dirs_lite, centre, WORLD_RADIUS, step=2.0, slabs=slabs)
    if len(tracks) < 200:
        rec["reason"] = "the bake carries no track polyline alongside this station's platforms"
        return rec

    ax, ticks = tg.corridor_ticks(sheet)
    ticks, dropped = tg.main_band(ticks, ax)
    rec["ticks"] = int(len(ticks))
    rec["ticksOffMainBand"] = int(dropped)
    rec["pageAxisDeg"] = round(math.degrees(math.atan2(ax[1], ax[0])) % 180, 2)
    if len(ticks) < MIN_TICKS:
        rec["reason"] = (f"only {len(ticks)} sleeper ticks recovered from the drawing "
                         f"(needs {MIN_TICKS}); this sheet does not hatch its tracks")
        return rec

    bbox = tg.drawn_bbox(sheet)
    # Score on a subsample; measure and gate on all of them.
    rng = np.random.default_rng(12345)
    idx = np.sort(rng.choice(len(ticks), 900, replace=False)) if len(ticks) > 900 else np.arange(len(ticks))
    P = ticks[idx]
    Pc = P.mean(axis=0)
    Pcoarse = P[::max(1, len(P) // 380)]
    Pcc = Pcoarse.mean(axis=0)

    target = Target(tracks, centre)
    if len(target.core) < 60:
        rec["reason"] = "the bake carries too little track within 200 m of this station"
        return rec
    wax = tg.world_axis(tracks, centre)
    psi = math.atan2(wax[1], wax[0])

    # Two independent readings of the page's corridor direction: the length
    # weighted dominant axis, and the perpendicular of the sleeper ticks. A
    # sheet with a big second view at another rotation can mislead the first.
    phis = {round(math.atan2(ax[1], ax[0]), 4)}

    theta0 = {}
    for phi in phis:
        for flip in (0, 1):
            theta0.setdefault(flip, []).append(psi + phi + flip * math.pi)
    thetas = []
    for flip, bases in theta0.items():
        for base in bases:
            for k in (-4, -2, 0, 2, 4):
                thetas.append((flip, (base + math.radians(k)) % (2 * math.pi)))
    thetas = sorted(set((f, round(t, 4)) for f, t in thetas))

    scales = []
    s = SCALE_RANGE[0]
    while s <= SCALE_RANGE[1]:
        if COVERAGE_M[0] <= sheet["W"] * s <= COVERAGE_M[1]:
            scales.append(s)
        s *= 1.05
    if not scales:
        rec["reason"] = "sheet width admits no scale inside the coverage habit"
        return rec

    # translation grid, corridor aligned: the drawing slides mostly along
    u = np.array(wax)
    v = np.array([-u[1], u[0]])
    along = np.arange(-280.0, 280.1, 8.0)
    across = np.arange(-60.0, 60.1, 3.0)
    grid = centre + (along[:, None, None] * u + across[None, :, None] * v).reshape(-1, 2)

    best = []
    for flip, theta in thetas:
        for sc in scales:
            A = amat(theta, sc)
            q0 = (Pcoarse - Pcc) @ A.T    # centred: t is then the world image of Pcc
            vals = np.empty(len(grid), dtype=np.float32)
            for i in range(0, len(grid), 192):
                chunk = grid[i:i + 192]
                qq = (q0[None, :, :] + chunk[:, None, :]).reshape(-1, 2)
                vals[i:i + 192] = target.reward(qq).reshape(len(chunk), -1).mean(axis=1)
            order = np.argsort(-vals)[:3]
            for k in order:
                best.append((float(vals[k]), flip, theta, sc, grid[k]))
    best.sort(key=lambda b: -b[0])

    def make(theta, sc, tc, pc):
        return {"theta": theta, "scale": sc, "t": tc - (pc @ amat(theta, sc).T)}

    def refine(c, iters=70):
        theta, sc, t = c["theta"], c["scale"], np.asarray(c["t"], float).copy()
        step_th, step_s, step_t = math.radians(1.2), 0.03, 8.0
        cur = combined(target, P, amat(theta, sc), t, SIGMA_M)[0]
        for _ in range(iters):
            improved = False
            for dth in (-step_th, step_th):
                s2 = combined(target, P, amat(theta + dth, sc), t, SIGMA_M)[0]
                if s2 > cur:
                    cur, theta, improved = s2, theta + dth, True
                    break
            for ds in (-step_s, step_s):
                sc2 = sc * (1 + ds)
                if not (SCALE_RANGE[0] <= sc2 <= SCALE_RANGE[1]):
                    continue
                A2 = amat(theta, sc2)
                t2 = (t + Pc @ amat(theta, sc).T) - Pc @ A2.T   # page centroid pinned
                s2 = combined(target, P, A2, t2, SIGMA_M)[0]
                if s2 > cur:
                    cur, sc, t, improved = s2, sc2, t2, True
                    break
            for dt in (np.array([step_t, 0.0]), np.array([-step_t, 0.0]),
                       np.array([0.0, step_t]), np.array([0.0, -step_t])):
                s2 = combined(target, P, amat(theta, sc), t + dt, SIGMA_M)[0]
                if s2 > cur:
                    cur, t, improved = s2, t + dt, True
                    break
            if not improved:
                step_th *= 0.5
                step_s *= 0.5
                step_t *= 0.5
                if step_t < 0.2:
                    break
        return {"score": cur, "theta": theta, "scale": sc, "t": t,
                "flip": c.get("flip", 0)}

    # Rank on the COMBINED score, not the coarse one. The coarse pass scores
    # only the forward term -- how well the drawn ticks land on baked track --
    # and that term is a mean over ticks, so it does not care how much railway
    # the sheet claims to cover: a sheet stretched 30% too big can put its
    # ticks on the corridor just as happily. Scale is pinned by the reverse
    # term, so the reverse term has to be in the ranking before anything is
    # thrown away.
    scored = []
    for val, flip, theta, sc, tc in best:
        c = make(theta, sc, tc, Pcc)
        c["flip"] = flip
        c["score"] = combined(target, Pcoarse, amat(theta, sc), c["t"], SIGMA_M)[0]
        scored.append(c)
    scored.sort(key=lambda c: -c["score"])

    # Refine the best few of EACH orientation separately. The 180-degree
    # reading is not an also-ran to be discovered by luck; it is the rival the
    # whole method exists to settle, so it is always given its own search.
    per_flip = {}
    seen = set()
    for c in scored:
        key = (c["flip"], round(c["theta"], 2), round(c["scale"], 2),
               int(round(float(c["t"][0]) / 30)), int(round(float(c["t"][1]) / 30)))
        if key in seen:
            continue
        seen.add(key)
        lst = per_flip.setdefault(c["flip"], [])
        if len(lst) < 6:
            lst.append(c)

    refined = []
    for flip, lst in per_flip.items():
        refined.extend(refine(c) for c in lst)
    if not refined:
        rec["reason"] = "no admissible placement"
        return rec
    refined.sort(key=lambda c: -c["score"])

    # --- the platforms decide along-position and the end-for-end question
    chains = tg.axis_chains(sheet, ax, min_len=40.0)
    sheet_pts = np.vstack([p["points"] for p in sheet["paths"] if len(p["points"]) >= 2])
    sheet_tree = cKDTree(sheet_pts)
    ob = osm_building_anchor(buildings.get(st["name"]))
    u_w = np.array(wax)
    v_w = np.array([-u_w[1], u_w[0]])

    def settle(c):
        """Apply the along-corridor shift the drawn copings ask for, then score
        the result on tracks AND platforms together."""
        A_ = amat(c["theta"], c["scale"])
        t_ = np.asarray(c["t"], float).copy()
        cw = [q @ A_.T + t_ for q in chains]
        pm = platform_match(cw, slabs)
        sh = best_shift(pm)
        if sh is not None and abs(sh) < 120.0:
            t_ = t_ - sh * u_w
            cw = [q @ A_.T + t_ for q in chains]
            pm = platform_match(cw, slabs)
        q = platform_quality(pm, slabs)
        trk = combined(target, P, A_, t_, SIGMA_M)[0]
        bd = building_density(sheet_tree, len(sheet_pts), A_, t_, ob)
        dcore, _ = cKDTree(ticks @ A_.T + t_).query(target.core)
        return {"theta": c["theta"], "scale": c["scale"], "t": t_, "flip": c["flip"],
                "trackScore": trk, "platQuality": q, "buildDensity": bd,
                "coveredFrac": float((dcore < 6.0).mean()),
                "pm": pm, "shiftM": sh,
                "score": trk * (0.25 + 0.75 * q) * (1.0 + 4.0 * (bd or 0.0))}

    settled = [settle(c) for c in refined[:10]]
    # The tracks are the primary evidence and the platforms only choose among
    # placements that already explain the corridor. Without this, a candidate
    # that lands the platform ends nicely while missing the railway outscores
    # one that has the railway right, because the platform and building
    # factors swing further than the track term does.
    solid = [c for c in settled if c["coveredFrac"] >= 0.75]
    pool = sorted(solid or settled, key=lambda c: -c["score"])
    rest = [c for c in settled if not any(c is d for d in pool)]
    settled = pool + sorted(rest, key=lambda c: -c["score"])
    top = settled[0]
    rivals = [c for c in settled if c["flip"] != top["flip"]]
    rival = max(rivals, key=lambda c: c["score"]) if rivals else None

    # --- final look, at a reward sharp enough to see scale
    sharp = target.sharpen(SHARP_SIGMA_M)

    def sharp_refine(c, iters=40):
        theta, sc, tt = c["theta"], c["scale"], np.asarray(c["t"], float).copy()
        st_th, st_s, st_t = math.radians(0.3), 0.015, 3.0
        cur = combined(sharp, P, amat(theta, sc), tt, SHARP_SIGMA_M)[0]
        for _ in range(iters):
            moved = False
            for dth in (-st_th, st_th):
                v = combined(sharp, P, amat(theta + dth, sc), tt, SHARP_SIGMA_M)[0]
                if v > cur:
                    cur, theta, moved = v, theta + dth, True
                    break
            for ds in (-st_s, st_s):
                s2 = sc * (1 + ds)
                if not (SCALE_RANGE[0] <= s2 <= SCALE_RANGE[1]):
                    continue
                A2 = amat(theta, s2)
                t2 = (tt + Pc @ amat(theta, sc).T) - Pc @ A2.T
                v = combined(sharp, P, A2, t2, SHARP_SIGMA_M)[0]
                if v > cur:
                    cur, sc, tt, moved = v, s2, t2, True
                    break
            for dt in (np.array([st_t, 0.0]), np.array([-st_t, 0.0]),
                       np.array([0.0, st_t]), np.array([0.0, -st_t])):
                v = combined(sharp, P, amat(theta, sc), tt + dt, SHARP_SIGMA_M)[0]
                if v > cur:
                    cur, tt, moved = v, tt + dt, True
                    break
            if not moved:
                st_th *= 0.5; st_s *= 0.5; st_t *= 0.5
                if st_t < 0.15:
                    break
        return theta, sc, tt, cur

    th_s, sc_s, t_s, sharp_score = sharp_refine(top)
    top = dict(top, theta=th_s, scale=sc_s, t=t_s)
    top.update(zip(("theta", "scale", "t"), (th_s, sc_s, t_s)))
    # re-settle the platforms at the sharpened transform
    top = settle(top)

    A = amat(top["theta"], top["scale"])
    t = top["t"]
    Ai = np.linalg.inv(A)

    # Is the scale determined by anything? An 8 per cent stretch about the page
    # centroid keeps every drawn track on a baked track when the corridor is
    # two parallel lines, so at a plain suburban station the answer is no --
    # and an undetermined scale is an error of 8 per cent of a platform length,
    # 13 m, at the ends. Measured, not assumed, and gated.
    sharp_base = combined(sharp, P, A, t, SHARP_SIGMA_M)[0] or 1e-9
    sdrop = 1.0
    for f in (1 - SCALE_PROBE, 1 + SCALE_PROBE):
        A2 = amat(top["theta"], top["scale"] * f)
        t2 = (t + Pc @ A.T) - Pc @ A2.T
        sdrop = min(sdrop, 1.0 - combined(sharp, P, A2, t2, SHARP_SIGMA_M)[0] / sharp_base)

    # --- residuals, on every tick, not the subsample
    qall = ticks @ A.T + t
    tick_tree = cKDTree(qall)
    dw, _ = tick_tree.query(target.core)
    dwc = np.minimum(dw, 30.0)
    rail_rms = float(np.sqrt((dwc ** 2).mean()))
    rail_p95 = float(np.percentile(dw, 95))
    rail_max = float(dw.max())
    cover6 = float((dw < 6.0).mean())
    d_fwd, _ = target.tree.query(qall)
    inw = np.hypot(qall[:, 0] - centre[0], qall[:, 1] - centre[1]) < WORLD_RADIUS

    rec["transform"] = {
        "a": [[round(float(A[0][0]), 6), round(float(A[0][1]), 6)],
              [round(float(A[1][0]), 6), round(float(A[1][1]), 6)]],
        "t": [round(float(t[0]), 3), round(float(t[1]), 3)],
        "scaleMPerPt": round(float(top["scale"]), 5),
        "mirror": False,
    }
    up = [A[0][1], A[1][1]]
    rec["transform"]["pageUpBearingDeg"] = round(
        (math.degrees(math.atan2(up[0], -up[1])) + 360) % 360, 2)
    rec["pageCoverageM"] = int(round(sheet["W"] * top["scale"]))
    rec["score"] = round(float(top["score"]), 4)
    rec["railFit"] = {
        "coreTrackPoints": int(len(target.core)),
        "coreRadiusM": CORE_RADIUS_M,
        "rmsM": round(rail_rms, 2),
        "p95M": round(rail_p95, 2),
        "maxM": round(rail_max, 2),
        "coveredFrac": round(cover6, 3),
    }
    rec["tickFit"] = {
        "ticks": int(len(ticks)),
        "medianToTrackM": round(float(np.median(d_fwd[inw])), 2) if inw.sum() else None,
        "fracWithin6m": round(float((d_fwd[inw] < 6.0).mean()), 3) if inw.sum() else None,
    }

    # --- what the platforms said
    pm = top["pm"]
    found = sum(1 for p in pm if p is not None)
    rec["platformFit"] = {
        "quality": round(float(top["platQuality"]), 3),
        "alongShiftM": round(float(top["shiftM"]), 1) if top["shiftM"] is not None else None,
        "found": found,
        # centreOffsetM is the residual AFTER the along shift: `settle` applies
        # the shift and re-measures, so what is left is the disagreement
        # between this platform's drawn ends and the OSM slab's.
        "slabs": [None if p is None else {
            "refs": p["refs"],
            "centreOffsetM": round(float(p["centreOffsetM"]), 1),
            "drawnLengthM": round(float(p["drawn"][1] - p["drawn"][0]), 1),
            "osmLengthM": round(float(2 * s["halfLength"]), 1),
            "lengthRatio": round(float(p["lengthRatio"]), 3),
        } for p, s in zip(pm, slabs)],
    }
    rec["buildingDensity"] = (round(float(top["buildDensity"]), 5)
                              if top["buildDensity"] is not None else None)

    # --- determinacy: displace the answer and see whether it minds.
    # Scored on the WHOLE objective -- tracks, platform ends and building
    # together -- because that is what the accept rests on. The tracks alone
    # barely notice a 30 m slide; the platform ends notice immediately.
    def full_at(dt):
        A_ = A
        t_ = t + dt
        cw = [q @ A_.T + t_ for q in chains]
        pm_ = platform_match(cw, slabs)
        qq = platform_quality(pm_, slabs)
        trk = combined(target, P, A_, t_, SIGMA_M)[0]
        bd = building_density(sheet_tree, len(sheet_pts), A_, t_, ob)
        return trk * (0.25 + 0.75 * qq) * (1.0 + 4.0 * (bd or 0.0))

    base = top["score"] or 1e-9
    along_drop = 1.0 - max(full_at(ALONG_PROBE_M * u_w), full_at(-ALONG_PROBE_M * u_w)) / base
    cross_drop = 1.0 - max(full_at(CROSS_PROBE_M * v_w), full_at(-CROSS_PROBE_M * v_w)) / base
    rec["determinacy"] = {
        "scaleDrop": round(float(sdrop), 3),
        "scaleProbe": SCALE_PROBE,
        "alongDrop": round(float(along_drop), 3),
        "crossDrop": round(float(cross_drop), 3),
        "flipMargin": round(float(base / rival["score"]), 3) if rival and rival["score"] > 1e-9 else None,
        "rivalScore": round(float(rival["score"]), 4) if rival else None,
    }

    # --- the check that is independent of everything above: a platform has no
    # sleepers on it. Measured against the two track bands immediately either
    # side of the same slab, same shape, same area -- so it is a local
    # comparison that no global normalisation can distort. This is the gate
    # Phase 0b did not have, and Lidcombe is why it exists: a reading one
    # platform band out puts the slab where the drawing has hatching.
    plat = []
    for s in slabs:
        u_s = np.array([s["ux"], s["uz"]])
        v_s = np.array([-s["uz"], s["ux"]])
        hl = s["halfLength"] * 0.8
        cen_s = np.array([s["x"], s["z"]])
        rel = qall - cen_s
        a_, b_ = rel @ u_s, rel @ v_s
        # The reference band is the nearest BAKED track either side of the
        # slab, not an offset guessed from the polygon: OSM's island platforms
        # come out 10 to 19 m wide across the corpus, so a guessed offset lands
        # on ballast at one station and past the far rail at the next. Both
        # counts are per metre of band width, so they compare directly.
        trel = target.core - cen_s
        ta, tb = trel @ u_s, trel @ v_s
        inner = max(2.0, s["halfWidth"] * 0.5)

        def count(centre_perp, halfw):
            return int(((np.abs(a_) < hl) & (np.abs(b_ - centre_perp) < halfw)).sum())

        on_w = min(inner, 3.5)
        on = count(0.0, on_w) / on_w
        nb = 0.0
        for sign in (1.0, -1.0):
            sel = (np.abs(ta) < hl) & (sign * tb > inner) & (np.abs(tb) < 30.0)
            if sel.sum() < 5:
                continue
            nb = max(nb, count(float(np.median(tb[sel])), 3.0) / 3.0)
        plat.append({"refs": s["refs"], "onSlabPerM": round(on, 2),
                     "onNearestTrackPerM": round(nb, 2),
                     "ratio": round(on / nb, 3) if nb > 0 else None})
    informative = [p for p in plat if p["onNearestTrackPerM"] >= 4.0]
    rec["platformCheck"] = {
        "slabs": plat,
        "informative": len(informative),
        "worstRatio": round(max((p["ratio"] for p in informative), default=0.0), 3),
    }

    # page region the transform means anything over
    rec["validRegionPt"] = [round(float(bbox[0]), 1), round(float(bbox[1]), 1),
                            round(float(bbox[2]), 1), round(float(bbox[3]), 1)]

    # --- the other method, where it fired
    #
    # Two methods agreeing is far better evidence than either alone, and where
    # they disagree the disagreement is the error bar. Measured the only way
    # that means anything to somebody placing a staircase: take the drawing's
    # own sleeper ticks, put them through both transforms, and report how far
    # apart in METRES the two answers put the same piece of drawing.
    if prev0b is not None and prev0b.get("transform"):
        A0 = np.array(prev0b["transform"]["a"], float)
        t0 = np.array(prev0b["transform"]["t"], float)
        q0 = ticks @ A0.T + t0
        d = np.hypot(*(q0 - qall).T)
        b0 = math.degrees(math.atan2(A0[1][0], A0[0][0]))
        b1 = math.degrees(math.atan2(A[1][0], A[0][0]))
        db = (b1 - b0 + 180) % 360 - 180
        rec["phase0b"] = {
            "accepted": bool(prev0b.get("accept")),
            "confidence": prev0b.get("confidence"),
            "scaleMPerPt": prev0b["transform"]["scaleMPerPt"],
            "scaleRatio": round(float(top["scale"] / prev0b["transform"]["scaleMPerPt"]), 4),
            "bearingDeltaDeg": round(float(db), 2),
            "medianDisagreementM": round(float(np.median(d)), 1),
            "maxDisagreementM": round(float(d.max()), 1),
        }

    # --- gate
    bad = []
    if rail_rms > RAIL_RMS_ACCEPT:
        bad.append(f"track RMS {rail_rms:.1f} m over {RAIL_RMS_ACCEPT} m")
    if rail_p95 > RAIL_P95_ACCEPT:
        bad.append(f"95th-percentile track offset {rail_p95:.1f} m over {RAIL_P95_ACCEPT} m")
    if cover6 < RAIL_COVER_ACCEPT:
        bad.append(f"only {cover6*100:.0f}% of the corridor within "
                   f"{CORE_RADIUS_M:.0f} m of the station is drawn on the sheet")
    if not (COVERAGE_M[0] <= rec["pageCoverageM"] <= COVERAGE_M[1]):
        bad.append(f"sheet would span {rec['pageCoverageM']} m of railway")
    if found < len(slabs):
        bad.append(f"no drawn platform found for {len(slabs)-found} of {len(slabs)} "
                   "OSM slabs, which leaves the reading unchecked")
    else:
        for p, s in zip(pm, slabs):
            off = abs(p["centreOffsetM"])
            if off > PLATFORM_OFFSET_M:
                bad.append(f"platform {'/'.join(map(str, p['refs']))} sits {off:.0f} m "
                           "along the corridor from where OSM has it")
            if not (PLATFORM_LEN_RATIO[0] <= p["lengthRatio"] <= PLATFORM_LEN_RATIO[1]):
                bad.append(f"platform {'/'.join(map(str, p['refs']))} comes out "
                           f"{p['lengthRatio']*100:.0f}% of its OSM length")
    if found >= 2:
        offs = [p["centreOffsetM"] for p in pm if p is not None]
        spread = max(offs) - min(offs)
        rec["platformFit"]["offsetSpreadM"] = round(float(spread), 1)
        if spread > PLATFORM_SPREAD_M:
            bad.append(f"the drawn platforms disagree with each other by {spread:.0f} m "
                       "along the corridor, so nothing here fixes where the sheet sits")
    if top["platQuality"] < PLATFORM_QUALITY:
        bad.append(f"the drawn platforms cover only {top['platQuality']*100:.0f}% of the "
                   "OSM slabs end to end")
    if sdrop < SCALE_MIN_DROP:
        bad.append(f"stretching the sheet {SCALE_PROBE*100:.0f}% costs only {sdrop*100:.0f}% -- "
                   "this corridor is two parallel lines and does not say what the scale is")
    if along_drop < ALONG_MIN_DROP:
        bad.append(f"slides {ALONG_PROBE_M:.0f} m along the corridor for only "
                   f"{along_drop*100:.0f}% worse -- nothing here fixes it along the line")
    if cross_drop < CROSS_MIN_DROP:
        bad.append(f"slides {CROSS_PROBE_M:.0f} m across the corridor for only "
                   f"{cross_drop*100:.0f}% worse")
    fm = rec["determinacy"]["flipMargin"]
    if fm is None:
        bad.append("no 180-degree rival was evaluated")
    elif fm < FLIP_MIN_MARGIN:
        bad.append(f"the sheet read end-for-end fits within {fm:.2f}x -- "
                   "nothing separates the two")
    if not informative:
        bad.append("the drawing hatches nothing beside the platforms, so the "
                   "one-band-out check could not be made")
    elif rec["platformCheck"]["worstRatio"] > PLATFORM_TICK_RATIO:
        bad.append(f"an OSM platform lands on drawn sleepers at "
                   f"{rec['platformCheck']['worstRatio']:.2f} of the density of the track "
                   "beside it -- the fit is a track band out")

    rec["accept"] = not bad
    rec["reason"] = "; ".join(bad) if bad else None
    if rec["accept"]:
        rec["confidence"] = (
            "high" if rail_rms <= 2.0 and top["platQuality"] >= 0.85 and (fm or 0) >= 1.6
            else "good" if rail_rms <= 3.5 and top["platQuality"] >= 0.78
            else "fair")
    return rec


# --- driver ------------------------------------------------------------------

_CTX = {}


def _init():
    bake = load_bake()
    _CTX["dirs"] = directions(bake)
    _CTX["stations"] = {s["name"]: s for s in bake["stations"]}
    by = {}
    for s in bake["stations"]:
        by[tg.slugify(s["name"])] = s
    _CTX["by"] = by
    bp = CAD / "buildings.json"
    _CTX["buildings"] = json.loads(bp.read_text()) if bp.exists() else {}
    fp = CAD / "fit.json"
    _CTX["fit0b"] = ({r["slug"]: r for r in json.loads(fp.read_text())["stations"]}
                     if fp.exists() else {})


def _one(slug: str) -> dict:
    if "by" not in _CTX:
        _init()
    st = _CTX["by"].get(slug) or _CTX["by"].get(tg.ALIAS.get(slug, ""))
    if st is None:
        return {"slug": slug, "accept": False, "confidence": "rejected", "method": "track",
                "reason": "not in the rail bake -- outside the 60 km world extent, or renamed"}
    try:
        return fit_station(slug, st, _CTX["dirs"], _CTX["buildings"], _CTX["fit0b"].get(slug))
    except Exception as e:  # noqa: BLE001
        return {"slug": slug, "accept": False, "confidence": "rejected", "method": "track",
                "station": st["name"], "reason": f"{type(e).__name__}: {e}"}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) - 2))
    args = ap.parse_args()

    slugs = sorted(f.stem for f in CAD.glob("*.json") if f.name not in SKIP)
    if args.only:
        slugs = [s for s in slugs if s == args.only]

    records = []
    if args.jobs <= 1 or len(slugs) == 1:
        _init()
        for i, s in enumerate(slugs, 1):
            records.append(_one(s))
            print(f"  {i}/{len(slugs)} {s}", file=sys.stderr)
    else:
        with ProcessPoolExecutor(max_workers=args.jobs) as pool:
            for i, r in enumerate(pool.map(_one, slugs, chunksize=1), 1):
                records.append(r)
                if i % 10 == 0:
                    print(f"  {i}/{len(slugs)}", file=sys.stderr)

    records.sort(key=lambda r: r["slug"])
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(),
        "method": "track centrelines: sleeper-tick midpoints from the CAD against "
                  "the baked rail polylines in data/scratch/rail/rail.bin",
        "frame": "world = A * p + t, p in PDF page points (x right, y UP from the "
                 "MediaBox bottom-left, exactly as scripts/stationcad.py writes them); "
                 "world x east, z south, metres. A is orientation-reversing.",
        "gates": {
            "RAIL_RMS_ACCEPT": RAIL_RMS_ACCEPT, "RAIL_P95_ACCEPT": RAIL_P95_ACCEPT,
            "CORE_RADIUS_M": CORE_RADIUS_M,
            "RAIL_COVER_ACCEPT": RAIL_COVER_ACCEPT, "SCALE_RANGE": list(SCALE_RANGE),
            "COVERAGE_M": list(COVERAGE_M), "MIN_TICKS": MIN_TICKS,
            "ALONG_PROBE_M": ALONG_PROBE_M, "ALONG_MIN_DROP": ALONG_MIN_DROP,
            "CROSS_PROBE_M": CROSS_PROBE_M, "CROSS_MIN_DROP": CROSS_MIN_DROP,
            "FLIP_MIN_MARGIN": FLIP_MIN_MARGIN,
            "PLATFORM_TICK_RATIO": PLATFORM_TICK_RATIO, "SIGMA_M": SIGMA_M,
            "PLATFORM_OFFSET_M": PLATFORM_OFFSET_M, "PLATFORM_QUALITY": PLATFORM_QUALITY,
            "PLATFORM_SPREAD_M": PLATFORM_SPREAD_M, "SHARP_SIGMA_M": SHARP_SIGMA_M,
            "SCALE_PROBE": SCALE_PROBE, "SCALE_MIN_DROP": SCALE_MIN_DROP,
            "PLATFORM_LEN_RATIO": list(PLATFORM_LEN_RATIO),
        },
        "counts": {"total": len(records),
                   "accepted": sum(1 for r in records if r["accept"]),
                   "rejected": sum(1 for r in records if not r["accept"])},
        "stations": records,
    }
    if args.only and OUT.exists():
        prev = json.loads(OUT.read_text())
        merged = [r for r in prev["stations"] if r["slug"] != args.only] + records
        merged.sort(key=lambda r: r["slug"])
        prev["stations"] = merged
        prev["generated"] = payload["generated"]
        prev["counts"] = {"total": len(merged),
                          "accepted": sum(1 for r in merged if r["accept"]),
                          "rejected": sum(1 for r in merged if not r["accept"])}
        OUT.write_text(json.dumps(prev, indent=1))
        print(json.dumps(prev["counts"]))
    else:
        OUT.write_text(json.dumps(payload, indent=1))
        print(json.dumps(payload["counts"]))


if __name__ == "__main__":
    main()
