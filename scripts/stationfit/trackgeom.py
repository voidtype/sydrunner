#!/usr/bin/env python3
"""The two sets of track centrelines Phase 0c matches: the drawing's and the
world's.

THE DRAWING'S. A station CAD sheet draws every running line as a sleeper
ladder -- two rails with a tick across them every few points -- and it draws
that ladder on nothing else. Not on a platform, not on a road, not on a
building. So the midpoints of those ticks are a sample of the drawn track
centrelines and of very little else, which makes them a far cleaner track
detector than any long-chain heuristic: a fence, a coping and a kerb are all
long lines parallel to the corridor, and none of them is hatched.

Measured over the corpus the tick is 2.5 page points long regardless of the
sheet's scale, so it is plotted symbology and its *length* says nothing about
metres per point. Its *position* is what matters.

THE WORLD'S. `data/scratch/rail/rail.bin` carries one polyline per line per
direction, decoded here by `railbin.py`. Those are service routes through a
baked rail graph, not surveyed four-foot centres: two directions of the same
line can sit 20 m apart at a suburban station and can swap sides through a
crossover. What they are reliable about is the corridor -- where it runs, how
it curves, how many tracks are in the fan and how they group across it. At
Strathfield the bake's eight tracks group [1][2][2][2][1] across the corridor
and so do the drawing's, which is the fingerprint this phase matches.
"""
from __future__ import annotations
import json, math
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CAD = ROOT / "data" / "scratch" / "stationcad"

TICK_MIN_PT = 1.2
TICK_MAX_PT = 4.5
TICK_PERP_DEG = 45.0   # a tick must be at least this far off the corridor axis
TICK_RUN_PT = 9.0      # how far along the corridor the next sleeper may be
TICK_RUN_PERP_PT = 1.1 # how tightly a run must share one centreline
TICK_RUN_MIN_PT = 45.0 # a run shorter than this is a word, not a track


def load_sheet(slug: str) -> dict:
    """The extracted sheet, all of it in PDF page space, y up. No flip: see
    the COORDINATE SPACE note in scripts/stationcad.py."""
    d = json.loads((CAD / f"{slug}.json").read_text())
    mb = d["source"]["media_box"]
    d["W"] = mb[2] - mb[0]
    d["H"] = mb[3] - mb[1]
    return d


def _segments(sheet: dict):
    for p in sheet["paths"]:
        pts = p["points"]
        for i in range(1, len(pts)):
            yield pts[i - 1], pts[i]


def dominant_axis(sheet: dict, min_len: float = 3.0):
    """Length-weighted mean direction of the sheet's long segments, mod 180
    via the doubled angle. Rail drawings are overwhelmingly corridor-parallel
    line work, so this is the corridor."""
    sx = sy = 0.0
    for a, b in _segments(sheet):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < min_len:
            continue
        th = math.atan2(dy, dx) * 2
        sx += math.cos(th) * L
        sy += math.sin(th) * L
    if sx == 0 and sy == 0:
        return 1.0, 0.0
    th = math.atan2(sy, sx) / 2
    return math.cos(th), math.sin(th)


def sleeper_ticks(sheet: dict, axis, strung: bool = True) -> np.ndarray:
    """Midpoints of the short cross-corridor strokes: one sample per drawn
    sleeper, i.e. a point cloud along every drawn track centreline.

    Length and direction alone are not enough. On the 111 sheets whose text was
    converted to outlines, every glyph of "PLATFORM 4" is a closed path made of
    short strokes, plenty of them across the corridor, and the lettering runs
    along the platform -- so raw ticks put a dense line of false sleepers down
    the middle of every platform, which is exactly where the fit must find
    none. `strung` therefore keeps only ticks that are part of a LADDER: a
    neighbour ahead and a neighbour behind along the corridor, both within
    1.2 pt of the same centreline. Sleepers satisfy that by construction and
    glyph strokes, which scatter over the height of the letter, do not.
    """
    ux, uy = axis
    cmax = math.cos(math.radians(90.0 - TICK_PERP_DEG))
    out = []
    for a, b in _segments(sheet):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < TICK_MIN_PT or L > TICK_MAX_PT:
            continue
        if abs((dx / L) * ux + (dy / L) * uy) > cmax:
            continue
        out.append(((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5))
    if not out:
        return np.zeros((0, 2))
    q = np.asarray(out, dtype=np.float64)
    if not strung or len(q) < 3:
        return q
    from scipy.spatial import cKDTree
    u = np.array([ux, uy])
    v = np.array([-uy, ux])
    a = q @ u
    b = q @ v
    # chain ticks that share a centreline: same perpendicular to within a
    # point, consecutive along the corridor. Chaining rather than a fixed
    # band, so a curving track stays one run.
    tree = cKDTree(np.column_stack([a / TICK_RUN_PT, b / TICK_RUN_PERP_PT]))
    parent = np.arange(len(q))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, j in tree.query_pairs(1.0):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    roots = np.array([find(i) for i in range(len(q))])
    keep = np.zeros(len(q), dtype=bool)
    for r in np.unique(roots):
        m = roots == r
        if a[m].max() - a[m].min() >= TICK_RUN_MIN_PT:
            keep[m] = True
    return q[keep]


def tick_axis(sheet: dict) -> tuple[float, float] | None:
    """The corridor direction implied by the ticks themselves: they are drawn
    across the track, so the perpendicular of their mean direction is the
    corridor. An independent second opinion on `dominant_axis`, which a sheet
    carrying a large second view at another rotation can mislead."""
    sx = sy = 0.0
    for a, b in _segments(sheet):
        dx, dy = b[0] - a[0], b[1] - a[1]
        L = math.hypot(dx, dy)
        if L < TICK_MIN_PT or L > TICK_MAX_PT:
            continue
        th = math.atan2(dy, dx) * 2
        sx += math.cos(th) * L
        sy += math.sin(th) * L
    if sx == 0 and sy == 0:
        return None
    th = math.atan2(sy, sx) / 2 + math.pi / 2
    return math.cos(th), math.sin(th)


def corridor_ticks(sheet: dict):
    """The corridor axis and the sleeper ticks on it, decided together.

    `dominant_axis` is length-weighted over the sheet's segments and is
    normally the corridor, because rail drawings are corridor-parallel line
    work. On sheets that draw long sleepers it is the SLEEPERS: at Petersham
    733 sleepers about 5 pt long outweigh two rails and four platform edges,
    and the dominant axis comes out 84 degrees from the track. Everything
    downstream then measures along for across and finds nothing.

    So the axis is not asserted, it is chosen: run the extraction on each
    candidate direction and keep the one that actually produces a ladder. A
    wrong axis produces almost none, because a sleeper run is only a run when
    you look along the track.
    """
    cands = []
    d = dominant_axis(sheet)
    t = tick_axis(sheet)
    for base in (d, t):
        if base is None:
            continue
        cands.append(base)
        cands.append((-base[1], base[0]))
    best = (None, np.zeros((0, 2)))
    for ax in cands:
        q = sleeper_ticks(sheet, ax)
        if len(q) > len(best[1]):
            best = (ax, q)
    if best[0] is None:
        return d, np.zeros((0, 2))
    return best


def main_band(ticks: np.ndarray, axis, gap_pt: float = 60.0):
    """The largest group of tick runs that sit together across the corridor.

    Many sheets carry more than one view, and a concourse plan or a second
    track group drawn elsewhere on the page hatches its tracks too. At
    Chatswood the raw ticks span 193 m across the corridor against the 31 m the
    bake has there, and those far-off ticks drag the fit off the railway. One
    similarity transform cannot cover two views anyway -- Phase 0b reached the
    same conclusion and recorded `validRegionPt` -- so the sheet is cut at the
    first cross-corridor gap wider than `gap_pt` and the busiest group kept.
    """
    if len(ticks) < 3:
        return ticks, 0
    v = np.array([-axis[1], axis[0]])
    p = ticks @ v
    order = np.argsort(p)
    ps = p[order]
    cuts = np.where(np.diff(ps) > gap_pt)[0] + 1
    groups = np.split(order, cuts)
    best = max(groups, key=len)
    return ticks[np.sort(best)], len(ticks) - len(best)


def axis_chains(sheet: dict, axis, min_len: float = 20.0, tol_deg: float = 25.0):
    """Long, near-straight runs of line work within `tol_deg` of the corridor.

    A platform coping is one of these. So is a rail, a fence, a canopy edge and
    a kerb -- which is why this is no use as a track detector and every use as a
    PLATFORM detector once the track fit has already said where the platforms
    must be. Inside a band the tracks are known to bracket, the long chains are
    the platform's edges, and their ends are the platform's ends.
    """
    ux, uy = axis
    cos_tol = math.cos(math.radians(tol_deg))
    out = []

    def flush(run):
        if len(run) < 2:
            return
        q = np.asarray(run, float)
        seg = np.hypot(*(q[1:] - q[:-1]).T)
        L = float(seg.sum())
        if L < min_len:
            return
        d = q[-1] - q[0]
        dl = float(np.hypot(*d))
        if dl < 0.85 * L or dl < 1e-6:
            return
        if abs((d[0] / dl) * ux + (d[1] / dl) * uy) < cos_tol:
            return
        out.append(q)

    for p in sheet["paths"]:
        pts = p["points"]
        if len(pts) < 2:
            continue
        run = [pts[0]]
        for i in range(1, len(pts)):
            a, b = pts[i - 1], pts[i]
            if math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6:
                continue
            if len(run) >= 2:
                pv, pp = run[-1], run[-2]
                d1 = math.atan2(pv[1] - pp[1], pv[0] - pp[0])
                d2 = math.atan2(b[1] - a[1], b[0] - a[0])
                dd = abs(d2 - d1)
                if dd > math.pi:
                    dd = 2 * math.pi - dd
                if dd > 0.35:
                    flush(run)
                    run = [a]
            if not run:
                run = [a]
            run.append(b)
        flush(run)
    return out


def merge_intervals(iv, gap: float):
    if not iv:
        return []
    iv = sorted(iv)
    out = [list(iv[0])]
    for a, b in iv[1:]:
        if a <= out[-1][1] + gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def drawn_bbox(sheet: dict):
    xs = [q[0] for p in sheet["paths"] for q in p["points"]]
    ys = [q[1] for p in sheet["paths"] for q in p["points"]]
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


# --- the world side ----------------------------------------------------------

def densify(pts: np.ndarray, step: float) -> np.ndarray:
    out = []
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        L = float(np.hypot(*(b - a)))
        n = max(1, int(L / step))
        for k in range(n):
            out.append(a + (b - a) * (k / n))
    out.append(pts[-1])
    return np.asarray(out)


def _near_slabs(run: np.ndarray, slabs, tol: float) -> bool:
    """Does this run of track pass alongside one of the station's platforms?"""
    for s in slabs:
        u = np.array([s["ux"], s["uz"]])
        v = np.array([-s["uz"], s["ux"]])
        rel = run - np.array([s["x"], s["z"]])
        a = np.abs(rel @ u) - s["halfLength"]
        b = np.abs(rel @ v) - s["halfWidth"]
        d = np.hypot(np.maximum(a, 0), np.maximum(b, 0))
        if d.min() < tol:
            return True
    return False


def world_tracks(dirs, centre, radius: float, step: float = 2.0,
                 slabs=None, slab_tol: float = 25.0) -> np.ndarray:
    """Every baked track vertex within `radius` of the station, densified.

    Deduplicated on a 1 m lattice: ten services share the same rails through
    the inner suburbs and would otherwise weight one corridor ten times.

    Filtered to the station's own corridor when `slabs` are given. A different
    railway passing nearby is a distractor, not evidence: at Museum the Metro
    and the North Shore line run 105 m and 107 m away through their own tunnels
    and the sheet draws neither of them, so leaving them in the target only
    offers the fit somewhere wrong to land.
    """
    out = []
    for d in dirs:
        p = d["xyz"][:, [0, 2]]
        m = np.hypot(p[:, 0] - centre[0], p[:, 1] - centre[1]) < radius
        if m.sum() < 2:
            continue
        idx = np.where(m)[0]
        # contiguous runs only, so a line that leaves and returns is not bridged
        splits = np.where(np.diff(idx) != 1)[0] + 1
        for run in np.split(idx, splits):
            if len(run) < 2:
                continue
            q = p[run]
            if slabs and not _near_slabs(q, slabs, slab_tol):
                continue
            out.append(densify(q, step))
    if not out:
        return np.zeros((0, 2))
    q = np.vstack(out)
    key = np.round(q, 0)
    _, keep = np.unique(key, axis=0, return_index=True)
    return q[np.sort(keep)]


def world_axis(tracks: np.ndarray, centre, radius: float = 250.0):
    """Corridor bearing at the station, from the baked tracks themselves."""
    m = np.hypot(tracks[:, 0] - centre[0], tracks[:, 1] - centre[1]) < radius
    p = tracks[m]
    if len(p) < 3:
        p = tracks
    d = np.diff(p, axis=0)
    L = np.hypot(d[:, 0], d[:, 1])
    ok = (L > 0.1) & (L < 20.0)
    if ok.sum() < 3:
        return 1.0, 0.0
    th = np.arctan2(d[ok, 1], d[ok, 0]) * 2
    sx = float((np.cos(th) * L[ok]).sum())
    sy = float((np.sin(th) * L[ok]).sum())
    a = math.atan2(sy, sx) / 2
    return math.cos(a), math.sin(a)


def slab_rects(slabs):
    """Slab corner rectangles, world coordinates, for the platform check."""
    out = []
    for s in slabs:
        cs = []
        for sa, sp in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x = s["x"] + s["ux"] * sa * s["halfLength"] - s["uz"] * sp * s["halfWidth"]
            z = s["z"] + s["uz"] * sa * s["halfLength"] + s["ux"] * sp * s["halfWidth"]
            cs.append((x, z))
        out.append(np.asarray(cs))
    return out


def slabs_of(station: dict):
    """Port of scripts/stationfit/osm.mjs `slabsOf`: OSM maps an island once
    per platform number, so overlapping parallel faces are one slab."""
    faces = [f for f in station.get("faces", []) if f["halfLength"] > 5]
    used = [False] * len(faces)
    slabs = []
    for i, a in enumerate(faces):
        if used[i]:
            continue
        group = [i]
        used[i] = True
        for j in range(i + 1, len(faces)):
            if used[j]:
                continue
            b = faces[j]
            if abs(a["ux"] * b["ux"] + a["uz"] * b["uz"]) < 0.985:
                continue
            dx, dz = b["x"] - a["x"], b["z"] - a["z"]
            if abs(-dx * a["uz"] + dz * a["ux"]) > a["halfWidth"] + b["halfWidth"] + 1.0:
                continue
            if abs(dx * a["ux"] + dz * a["uz"]) > max(a["halfLength"], b["halfLength"]) * 0.6:
                continue
            group.append(j)
            used[j] = True
        g = [faces[k] for k in group]
        m = max(g, key=lambda f: f["halfLength"])
        a0, a1, p0, p1 = math.inf, -math.inf, math.inf, -math.inf
        for f in g:
            for sa in (-f["halfLength"], f["halfLength"]):
                for sp in (-f["halfWidth"], f["halfWidth"]):
                    x = f["x"] + f["ux"] * sa - f["uz"] * sp
                    z = f["z"] + f["uz"] * sa + f["ux"] * sp
                    dx, dz = x - m["x"], z - m["z"]
                    A = dx * m["ux"] + dz * m["uz"]
                    P = -dx * m["uz"] + dz * m["ux"]
                    a0, a1 = min(a0, A), max(a1, A)
                    p0, p1 = min(p0, P), max(p1, P)
        ca, cp = (a0 + a1) / 2, (p0 + p1) / 2
        refs = sorted({r for f in g for r in (f.get("refs") or [])})
        slabs.append({
            "refs": refs,
            "x": m["x"] + m["ux"] * ca - m["uz"] * cp,
            "z": m["z"] + m["uz"] * ca + m["ux"] * cp,
            "ux": m["ux"], "uz": m["uz"],
            "halfLength": (a1 - a0) / 2,
            "halfWidth": (p1 - p0) / 2,
        })
    return slabs


def slugify(name: str) -> str:
    s = name.replace(" Station", "").replace(" station", "").strip()
    out = []
    for ch in s.lower():
        out.append(ch if ch.isalnum() else "-")
    s = "".join(out)
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")


ALIAS = {
    "mt-colah": "mount-colah",
    "mt-druitt": "mount-druitt",
    "mt-kuring-gai": "mount-kuring-gai",
    "blacktown-platforms-1-2": "blacktown",
    "blacktown-platforms-3-7": "blacktown",
}
