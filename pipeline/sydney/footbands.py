"""The footpath bands the client walks people along, moved off the parked cars.

`client/src/game/pedestrians.ts` says it adds no geometry to this pipeline, and
that is still true: a pedestrian band is `centreline +/- (halfWidth +
KERB_WIDTH + footpathWidth / 2)`, derived at decode time from the ways block
`tiles.write_lanes` already emits. This module does not change that. It adds two
numbers per way per side to the same block -- how far the band is pushed away
from the kerb, and which stretches of it are not walked at all -- and the client
applies them to the polyline it was already building.

---------------------------------------------------------------------------
WHY A BAND HAS TO BE TOLD ABOUT A PARKED CAR AT ALL.

A pedestrian is a closed-form function of `(band, tick)`. There is no mover, no
steering and no collision query anywhere on that path -- that is the whole
design and `pedestrians.ts`' header argues it -- so a walker cannot avoid
anything. Whatever the band runs through, the walker walks through. Parked cars
are the one population dense enough, and at eye level enough, for that to be
visible: over four dense inner-suburb tiles -- Surry Hills, Redfern,
Paddington, Newtown -- 155 of 92,152 band samples stood inside a bay box, which
is 28 distinct cars with somebody walking out of the boot. After this pass it
is 0.

**It is never the way's own cars.** `parking.KERB_OFFSET` puts a body's
centreline `half_width - 1.05` from the centreline and its outer face 0.15 m
*inside* the kerb; the band is at `half_width + 0.15 + footpathWidth / 2`,
which is 1.8 m further out at the narrowest footpath this build lays. A car and
a band belonging to the same way cannot touch, and the arithmetic is what says
so. Every offender is a **different** way's car -- a corner, a slip lane, a
service road beside a main road, a street OSM has mapped twice. That is the
same shape as `clash-check`'s `FURNITURE_ON_ROAD`, and it has the same answer:
the keep-out is applied to the result, once, against everything in reach,
rather than taught to the placer that cannot see the other way.

---------------------------------------------------------------------------
TWO MOVES, IN THIS ORDER, AND THE SECOND ONLY WHERE THE FIRST CANNOT REACH.

**1. Inset.** Push the whole band away from the carriageway by the tenth of a
metre that leaves the least of it inside a box -- the least, rather than the
first that leaves none, because a band with one car parked *along* it and
another lying *across* it can never be cleared by a lateral move, and taking
the inset anyway turns two cuts into one. It is one float on the wire, it keeps
the band continuous, and a pedestrian half a metre further up the footpath is
not a thing anybody can see. Over eleven emitted tiles: 12 of the 36 offending
bands take one, capped at `INSET_MAX_M`.

**A band is never inset into a building.** The footpath is bounded on the far
side by a wall, and a walker inside one is worse than a walker inside a car:
`streets.py` subtracts every footprint out of the paved band, so the concrete
genuinely stops there. Each candidate inset is tested against the footprints in
reach and refused if it puts more samples inside one than the band already had
-- *more*, not *any*, because a band under a first-floor overhang starts with
some and refusing on that would refuse every awning in the CBD.

**2. Cut.** Where no inset clears the band -- a car lying *across* the
footpath, which is what a bay on the cross street at a corner is, and no
lateral move gets past it -- the blocked stretch is cut out and the band
becomes two. 34 of the 36 are this case, which is what the arithmetic above
predicts: the offender is always a *different* way's car, and a different way
at a corner crosses this one. A cut costs band length, which is the number this
pass reports -- 186 m of 45,503 over the four tiles, 0.4% -- and the
alternative is a walker emerging through a windscreen.

Cuts are expressed in the way's **vertex-index space** -- `2.5` is halfway along
the third segment -- and not in metres of arc. The band has exactly one vertex
per centreline vertex whatever the inset is, so index space is the one
parameterisation the two polylines share; an arc length measured on the offset
polyline would mean something different the moment the inset changed, and the
client would have to re-derive it to use it.

---------------------------------------------------------------------------
THE GEOMETRY HERE IS `buildBand`'S, RESTATED, AND THAT IS A REAL RISK.

This module builds the same offset polyline the client builds -- per-segment
unit directions, the per-vertex average of the two either side, the left normal
of that -- because it has to test the points the client will actually place
people on. Two implementations of one polyline is exactly the drift
`write_lanes` exists to prevent, so the duplication is fenced from both ends:
`verify_footbands` puts a synthetic way through this file's offset and asserts
the sign and the distance, and `game/pedestrians.verifyPedestrians` asserts the
same two facts about the same synthetic way through the real decoder. A change
to either side that moves the band breaks one of them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

from . import parking, streets

# The half-extents of the box a body occupies. `parking.CAR_HALF_LENGTH` and
# `CAR_HALF_WIDTH` are the bay's own, sized to the longest body in the table, and
# they are the same rectangle `server/clash-check.ts` convicts a car with.
BAY_HALF_LENGTH_M = parking.CAR_HALF_LENGTH
BAY_HALF_WIDTH_M = parking.CAR_HALF_WIDTH

# How much room a walking body needs beside the box. `client/src/player/
# controller.PLAYER_RADIUS`, which `game/combat.CAPSULE_RADIUS` sets a
# pedestrian's own capsule from -- so this is the radius of the thing that must
# not overlap the car, and not a chosen margin.
PED_CLEAR_M = 0.34

# The search. A tenth of a metre is finer than anything downstream resolves and
# coarse enough that the whole search is twenty tries; two metres is past the
# far kerb of the widest footpath `streets.FOOTPATH_WIDTH` lays, so an inset
# that has not worked by then is not going to.
INSET_STEP_M = 0.1
INSET_MAX_M = 2.0

# How finely the band is walked for the **building** test, which is a guard and
# not a measurement -- `blocked_ranges` clips the bay boxes exactly and samples
# nothing. Half a metre is finer than any footprint edge this has to notice.
WALL_SAMPLE_M = 0.5

# `game/pedestrians.NARROW_FOOTPATH_M`. Under this the client lays one band up
# the middle of the footpath rather than two, and this file has to make the same
# choice or it fits an inset to a band nobody builds.
NARROW_FOOTPATH_M = 2.0

# A cut is widened by this at each end, so a walker does not reappear with their
# shoulder in the bumper. One body radius, on the same argument as `PED_CLEAR_M`.
CUT_PAD_M = PED_CLEAR_M

# Below this, a surviving run is not worth writing: `game/pedestrians.MIN_BAND_M`
# is 16 m and the client drops anything shorter, so a cut that leaves 3 m of
# footpath either side has cut the whole band and the report should say so.
MIN_RUN_M = 16.0


@dataclass
class BandFit:
    """What one way's two bands need. Sides are indexed as `buildBand`'s are."""

    inset: list[float] = field(default_factory=lambda: [0.0, 0.0])
    cuts: list[list[tuple[float, float]]] = field(default_factory=lambda: [[], []])
    # Metres of band this fit costs, for the report. Not written to the sidecar.
    lost_m: float = 0.0

    def is_empty(self) -> bool:
        return not any(self.inset) and not self.cuts[0] and not self.cuts[1]


def band_points(
    pts: np.ndarray, side: int, offset: float
) -> np.ndarray:
    """`game/pedestrians.buildBand`'s offset polyline, in ENU.

    `pts` is `(n, 2)` of (east, north). Side 0 walks on the **left** of the
    way's direction of travel, which in ENU is the `(-dn, de)` normal -- the
    same sign `parking._bay_point` and `streets._emit_kerb_face` share, and the
    same one `buildBand` writes as `(dz, -dx)` in renderer axes.
    """
    n = len(pts)
    if n < 2:
        return pts.copy()
    seg = np.diff(pts, axis=0)
    d2 = np.einsum("ij,ij->i", seg, seg)
    dirs = np.zeros_like(seg)
    for i in range(n - 1):
        if d2[i] < 1e-12:
            # A repeated vertex: carry the previous direction rather than divide
            # by zero, and fall back to due east at the head. `buildBand` does
            # the identical thing for the identical reason.
            dirs[i] = dirs[i - 1] if i > 0 else (1.0, 0.0)
        else:
            dirs[i] = seg[i] / math.sqrt(d2[i])
    avg = np.zeros((n, 2), dtype=np.float64)
    avg[0] = dirs[0]
    avg[n - 1] = dirs[n - 2]
    for i in range(1, n - 1):
        a = dirs[i - 1] + dirs[i]
        m2 = float(a[0] * a[0] + a[1] * a[1])
        avg[i] = dirs[i - 1] if m2 < 1e-12 else a / math.sqrt(m2)
    sign = offset if side == 0 else -offset
    out = np.empty_like(avg)
    out[:, 0] = pts[:, 0] - avg[:, 1] * sign
    out[:, 1] = pts[:, 1] + avg[:, 0] * sign
    return out


def _walk(band: np.ndarray) -> np.ndarray:
    """Points along a band about `WALL_SAMPLE_M` apart. The building test only."""
    n = len(band)
    if n < 2:
        return band.copy()
    seg = np.hypot(np.diff(band[:, 0]), np.diff(band[:, 1]))
    counts = np.maximum(1, np.ceil(seg / WALL_SAMPLE_M).astype(np.int64))
    total = int(counts.sum())
    idx = np.repeat(np.arange(n - 1, dtype=np.int64), counts)
    starts = np.repeat(np.cumsum(counts) - counts, counts)
    f = ((np.arange(total, dtype=np.float64) - starts) / np.repeat(counts, counts))[:, None]
    out = band[idx] + (band[idx + 1] - band[idx]) * f
    return np.vstack((out, band[-1:]))


def _merge(ranges: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Overlapping index-space ranges, unioned, in order."""
    if not ranges:
        return []
    ranges = sorted(ranges)
    out = [ranges[0]]
    for a, b in ranges[1:]:
        if a <= out[-1][1]:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


class BayField:
    """The bay boxes in reach, as an oriented-rectangle test.

    Built once a tile from `parking.ParkingNetwork.cars_near`, which is
    deliberately the *conservative* answer -- it skips the trunk test, the
    overlap test and the per-tile cap, so it can offer a car `instances` will go
    on to drop. That is the right direction for a keep-out and it is the same
    call `power.py` makes for the same reason.
    """

    def __init__(self, cars) -> None:
        self.count = len(cars)
        if not cars:
            self._xy = np.zeros((0, 2))
            return
        self._xy = np.array([(c.east, c.north) for c in cars], dtype=np.float64)
        h = np.array([c.heading for c in cars], dtype=np.float64)
        # Along the body and across it. `parking._heading` derives the rotation
        # as the ENU bearing `atan2(north, east)` of the facing, so the facing is
        # `(cos h, sin h)` in ENU and the across-axis is its left normal. The
        # jitter that heading carries is in here with it, which is the point:
        # the box has to be the one the client draws.
        self._along = np.column_stack((np.cos(h), np.sin(h)))
        self._across = np.column_stack((-np.sin(h), np.cos(h)))
        self._reach = math.hypot(
            BAY_HALF_LENGTH_M + PED_CLEAR_M, BAY_HALF_WIDTH_M + PED_CLEAR_M
        )

    def near(self, pts: np.ndarray) -> np.ndarray:
        """Which cars could possibly reach a band, from its bounding box alone.

        Computed once per band and reused for all twenty candidate insets, which
        is what keeps the search from being a few hundred oriented-rectangle
        tests per sample: a tile holds a few hundred cars and a band is beside
        a handful of them.
        """
        if self.count == 0 or len(pts) == 0:
            return np.zeros(0, dtype=np.int64)
        lo = pts.min(axis=0) - (self._reach + INSET_MAX_M)
        hi = pts.max(axis=0) + (self._reach + INSET_MAX_M)
        return np.flatnonzero(
            (self._xy[:, 0] >= lo[0]) & (self._xy[:, 0] <= hi[0])
            & (self._xy[:, 1] >= lo[1]) & (self._xy[:, 1] <= hi[1])
        )

    def blocked(
        self, band: np.ndarray, which: np.ndarray
    ) -> list[tuple[float, float]]:
        """Which stretches of a band lie inside a bay box, in index space, **exactly**.

        Not sampled. Each band segment is clipped against each box in its own
        frame -- two slabs, `|along| <= HL` and `|across| <= HW` -- and the
        surviving parameter interval is the stretch of that segment inside the
        box. `i + t` for a segment `i` is index space, which is what the sidecar
        carries, so the answer needs no second conversion.

        **The exactness is the point and it was bought.** The first version of
        this walked the band at 40 cm and asked whether each point was inside a
        box, which is a fine test for a body lying *along* the band and a poor
        one for a corner: a box clipped at its corner overlaps a few centimetres
        of arc, two sample sets at different phases disagree about whether it is
        there at all, and six such grazes survived a fit that believed itself
        clean. A clip has no phase.

        Returns merged ranges over all of `which`, in order. Empty is clear.
        """
        n = len(band)
        if len(which) == 0 or n < 2:
            return []
        p0 = band[:-1]
        d = np.diff(band, axis=0)
        along = self._along[which]
        across = self._across[which]
        # (segments, cars) for each of the four scalars the clip needs.
        r = p0[:, None, :] - self._xy[None, which, :]
        a0 = np.einsum("skj,kj->sk", r, along)
        b0 = np.einsum("skj,kj->sk", r, across)
        da = d @ along.T
        db = d @ across.T
        lo = np.zeros(a0.shape)
        hi = np.ones(a0.shape)
        for s0, sd, half in (
            (a0, da, BAY_HALF_LENGTH_M + PED_CLEAR_M),
            (b0, db, BAY_HALF_WIDTH_M + PED_CLEAR_M),
        ):
            parallel = np.abs(sd) < 1e-12
            safe = np.where(parallel, 1.0, sd)
            u0 = (-half - s0) / safe
            u1 = (half - s0) / safe
            slab_lo = np.minimum(u0, u1)
            slab_hi = np.maximum(u0, u1)
            # A segment parallel to a slab is either wholly inside it or wholly
            # outside, and `-inf .. inf` / `inf .. -inf` says which without a
            # branch per element.
            inside = np.abs(s0) <= half
            slab_lo = np.where(parallel, np.where(inside, -np.inf, np.inf), slab_lo)
            slab_hi = np.where(parallel, np.where(inside, np.inf, -np.inf), slab_hi)
            lo = np.maximum(lo, slab_lo)
            hi = np.minimum(hi, slab_hi)
        seg, car = np.nonzero(hi > lo)
        if len(seg) == 0:
            return []
        return _merge(
            [(float(i + lo[i, k]), float(i + hi[i, k])) for i, k in zip(seg, car)]
        )


class WallField:
    """The building footprints in reach. `street_network.buildings_near`'s set."""

    def __init__(self, polys) -> None:
        from shapely.strtree import STRtree

        self._polys = [p for p in polys if not p.is_empty]
        self._tree = STRtree(self._polys) if self._polys else None
        self.count = len(self._polys)

    def inside(self, pts: np.ndarray) -> int:
        """How many samples stand inside a footprint."""
        if self._tree is None or len(pts) == 0:
            return 0
        import shapely

        hit = self._tree.query(shapely.points(pts), predicate="within")
        # `query` over an array returns a (2, k) array of
        # (input index, tree index) pairs.
        return int(len(np.unique(hit[0]))) if hit.size else 0


def _pad_cuts(
    cuts: list[tuple[float, float]], band: np.ndarray
) -> list[tuple[float, float]]:
    """Widen each cut by `CUT_PAD_M` at both ends, in index space, and merge."""
    if not cuts:
        return []
    seg = np.hypot(np.diff(band[:, 0]), np.diff(band[:, 1]))
    seg = np.where(seg > 1e-6, seg, 1e-6)
    n = len(band)

    def pad(t: float, sign: int) -> float:
        i = min(max(int(math.floor(t)), 0), n - 2)
        return t + sign * CUT_PAD_M / float(seg[i])

    widened = [(max(0.0, pad(a, -1)), min(float(n - 1), pad(b, 1))) for a, b in cuts]
    widened.sort()
    merged = [widened[0]]
    for a, b in widened[1:]:
        if a <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], b))
        else:
            merged.append((a, b))
    return merged


def _cut_length(band: np.ndarray, cuts: list[tuple[float, float]]) -> float:
    """Metres of band the cuts remove, plus any surviving run under `MIN_RUN_M`."""
    seg = np.hypot(np.diff(band[:, 0]), np.diff(band[:, 1]))
    cum = np.concatenate(([0.0], np.cumsum(seg)))

    def arc(t: float) -> float:
        i = min(max(int(math.floor(t)), 0), len(seg) - 1)
        return float(cum[i] + seg[i] * (t - i))

    total = float(cum[-1])
    lost = 0.0
    at = 0.0
    for a, b in cuts:
        run = arc(a) - at
        if 0.0 < run < MIN_RUN_M:
            lost += run
        lost += arc(b) - arc(a)
        at = arc(b)
    run = total - at
    if 0.0 < run < MIN_RUN_M:
        lost += run
    return min(lost, total)


def _blocked_m(band: np.ndarray, ranges: list[tuple[float, float]]) -> float:
    """Metres of band inside a box, over `ranges`. The search's objective."""
    if not ranges:
        return 0.0
    seg = np.hypot(np.diff(band[:, 0]), np.diff(band[:, 1]))
    total = 0.0
    for a, b in ranges:
        i0 = min(max(int(math.floor(a)), 0), len(seg) - 1)
        i1 = min(max(int(math.floor(b)), 0), len(seg) - 1)
        if i0 == i1:
            total += (b - a) * float(seg[i0])
            continue
        total += (i0 + 1 - a) * float(seg[i0])
        total += float(seg[i0 + 1 : i1].sum())
        total += (b - i1) * float(seg[i1])
    return total


def fit_tile(tile, bays: BayField, walls: WallField, stats: dict) -> dict[int, BandFit]:
    """One `lanes.TileLanes`' bands, fitted past the bays. Keyed by way index.

    `stats` is accumulated across the whole build by the caller: `bands`,
    `blocked`, `inset`, `cut`, `refused_by_wall`, `lost_m`, `inset_max_m`.
    """
    out: dict[int, BandFit] = {}
    if bays.count == 0:
        return out
    for wi, w in enumerate(tile.ways):
        fw = float(w.footpath_width)
        if not (fw > 0.0) or len(w.pts) < 2:
            continue
        pts = np.asarray(w.pts, dtype=np.float64)
        base = float(w.half_width) + streets.KERB_WIDTH + fw * 0.5
        sides = 1 if fw < NARROW_FOOTPATH_M else 2
        fit = BandFit()
        for side in range(sides):
            stats["bands"] += 1
            band = band_points(pts, side, base)
            which = bays.near(band)
            ranges = bays.blocked(band, which)
            if not ranges:
                continue
            stats["blocked"] += 1
            walls0 = walls.inside(_walk(band))
            # The best inset is the one that leaves the least band inside a box,
            # not the first that leaves none: a band with a car parked *along*
            # it and another lying *across* it can never be cleared by a lateral
            # move, and taking the inset anyway is what turns a band that would
            # have been cut in two places into one cut in one place.
            best_d = 0.0
            best_band = band
            best_ranges = ranges
            best_m = _blocked_m(band, ranges)
            steps = int(round(INSET_MAX_M / INSET_STEP_M))
            refused = False
            for k in range(1, steps + 1):
                d = k * INSET_STEP_M
                cand = band_points(pts, side, base + d)
                r = bays.blocked(cand, which)
                m = _blocked_m(cand, r)
                if m >= best_m:
                    continue
                if walls.inside(_walk(cand)) > walls0:
                    # This inset would put the band further into a wall than it
                    # already was. A wider one only goes deeper, so stop asking.
                    refused = True
                    break
                best_d, best_m, best_band, best_ranges = d, m, cand, r
                if not r:
                    break
            if best_d > 0.0:
                fit.inset[side] = best_d
                stats["inset"] += 1
                stats["inset_max_m"] = max(stats["inset_max_m"], best_d)
            if refused and best_ranges:
                stats["refused_by_wall"] += 1
            if not best_ranges:
                continue
            # What no lateral move reaches: cut it out.
            cuts = _pad_cuts(best_ranges, best_band)
            if not cuts:
                continue
            fit.cuts[side] = cuts
            lost = _cut_length(best_band, cuts)
            fit.lost_m += lost
            stats["cut"] += 1
            stats["lost_m"] += lost
        if not fit.is_empty():
            out[wi] = fit
    return out


def new_stats() -> dict:
    return {
        "bands": 0,
        "blocked": 0,
        "inset": 0,
        "cut": 0,
        "refused_by_wall": 0,
        "lost_m": 0.0,
        "inset_max_m": 0.0,
    }


def verify_footbands() -> list[str]:
    """The control: the offset this file builds is the one the client builds.

    A synthetic way due north, whose left is due west, checked for **side, sign
    and distance** -- the three things `game/pedestrians.verifyPedestrians`
    checks from the other end of the same wire, on the same synthetic way. That
    is the whole point: if this file and `buildBand` ever disagree about which
    side of the road a band is on, one of the two controls fails rather than a
    suburb quietly filling with people walking down the middle of the street.

    Run from `cmd_build`'s self-check gate, beside `decks.verify_decks`.
    """
    bad: list[str] = []
    # Due north in ENU is (0, +1); its left normal is (-1, 0), due west.
    pts = np.array([(0.0, 0.0), (0.0, 10.0), (0.0, 20.0)], dtype=np.float64)
    left = band_points(pts, 0, 3.0)
    right = band_points(pts, 1, 3.0)
    if not np.allclose(left[:, 0], -3.0):
        bad.append(f"footbands: side 0 of a due-north way is at east {left[0, 0]:.2f}, not -3")
    if not np.allclose(right[:, 0], 3.0):
        bad.append(f"footbands: side 1 of a due-north way is at east {right[0, 0]:.2f}, not +3")
    if not np.allclose(left[:, 1], pts[:, 1]):
        bad.append("footbands: an offset band moved along the way as well as across it")

    # A right-angle bend. `buildBand` averages the two **unit** segment
    # directions and renormalises, so the corner vertex stands exactly `offset`
    # from the centreline on the bisector -- it does *not* mitre out to
    # `offset / cos(45 deg)`, and the band therefore pinches in a little at a
    # sharp corner. That is the client's behaviour, this file has to match it,
    # and the number is asserted rather than described so a change to either is
    # a failure rather than a surprise.
    bend = np.array([(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], dtype=np.float64)
    b = band_points(bend, 0, 2.0)
    got = math.hypot(b[1, 0] - 10.0, b[1, 1] - 0.0)
    if abs(got - 2.0) > 1e-9:
        bad.append(f"footbands: a right-angle corner offsets by {got:.3f} m, not 2.000")
    # ...on the bisector, which for east-then-north is north-west.
    if not (b[1, 0] < 10.0 and b[1, 1] > 0.0):
        bad.append(f"footbands: a corner's offset points at ({b[1, 0]:.2f}, {b[1, 1]:.2f})")

    # A box squarely on the band is found, and the same box a body's width off
    # it is not. Through the real `BayField` and the real sample walk.
    class _Car:
        def __init__(self, e: float, n: float, h: float) -> None:
            self.east, self.north, self.heading = e, n, h

    line = np.array([(0.0, 0.0), (0.0, 40.0)], dtype=np.float64)
    band = band_points(line, 0, 3.0)
    on = BayField([_Car(-3.0, 20.0, 0.5 * math.pi)])
    hit = on.blocked(band, on.near(band))
    if not hit:
        bad.append("footbands: a bay box standing on the band is not found")
    # ...and the legal neighbour: the same body, parked along the same band,
    # a body's width plus the clearance further from it. A control that could
    # only ever convict proves nothing -- `merge.verify`'s argument.
    off = BayField(
        [_Car(-3.0 - (BAY_HALF_WIDTH_M + PED_CLEAR_M + 0.2), 20.0, 0.5 * math.pi)]
    )
    if off.blocked(band, off.near(band)):
        bad.append("footbands: a bay box clear of the band is reported as on it")

    # The clip is exact, so the stretch it names is the box's own length plus
    # two clearances, to the millimetre. A sampled test could only ever say
    # "about", and the six corner grazes that survived one are why this is
    # asserted rather than described. The way is 40 m in one segment, so index
    # space is arc / 40.
    if hit:
        want = 2.0 * (BAY_HALF_LENGTH_M + PED_CLEAR_M) / 40.0
        got = hit[0][1] - hit[0][0]
        if abs(got - want) > 1e-9:
            bad.append(
                f"footbands: a box lying along the band blocks {got * 40:.3f} m of it,"
                f" not {want * 40:.3f}"
            )
    # A box lying *across* the band blocks its own width, not its length --
    # which is the case no inset can clear and the reason cuts exist.
    across = BayField([_Car(-3.0, 20.0, 0.0)])
    ha = across.blocked(band, across.near(band))
    if len(ha) != 1:
        bad.append(f"footbands: a box across the band makes {len(ha)} blocked ranges")
    else:
        want = 2.0 * (BAY_HALF_WIDTH_M + PED_CLEAR_M) / 40.0
        if abs((ha[0][1] - ha[0][0]) - want) > 1e-9:
            bad.append(
                f"footbands: a box across the band blocks"
                f" {(ha[0][1] - ha[0][0]) * 40:.3f} m, not {want * 40:.3f}"
            )

    # ...and the cut it produces covers it and no more than it.
    cuts = _pad_cuts(hit, band)
    if len(cuts) != 1:
        bad.append(f"footbands: one box makes {len(cuts)} cuts")
    elif not (cuts[0][0] > 0.0 and cuts[0][1] < len(band) - 1):
        bad.append("footbands: a box in the middle of a band cuts the whole band")
    return bad
