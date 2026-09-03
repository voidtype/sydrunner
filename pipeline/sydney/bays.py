"""Kerb bays, and who owns them.

The user's report: "when a car pulls in it must be to an empty spot, and when it
leaves it must clear up that spot. they should never overlap."

Before this module the two fleets did not know about each other at all.
`parking.py` laid 23,020 static cars along the kerbs; `game/traffic.ts` derived a
kerb bay for each end of each route *at decode time*, from the ways block, with
no knowledge of the static fleet and no knowledge of any other route. So a
schedule car pulled into a bay that already held a parked one, and two routes
whose ends met at the same corner both claimed the same three metres of gutter.
Measured on the shipped world over 360 samples of the inner 1.5 km: 1,163
parked-on-parked pairs between different routes and 654 parked-on-static ones.

---------------------------------------------------------------------------
ONE GRID, ONE LEDGER, ONE OWNER.

Every kerb in the extent already has a canonical bay grid, because `parking.py`
walks one: `CLEAR_OF_JUNCTION + k * BAY_SPACING` along a way's centreline,
`half_width - KERB_OFFSET` to one side of it. That grid exists on every way,
whether or not `parking.PARKING_CLASSES` chose to fill it -- filling is a
*policy* about where Sydney parks, and the grid is the geometry underneath it.

So this module hands each route end a bay **off that same grid**, walking
outward from the route's own end until it finds one nothing else has, and
records the claim. The result travels in `.lanes.bin` v2, which means:

  * The client and the Bun server read the assignment rather than deriving it,
    so they cannot derive it differently. That is the whole reason this moved
    into the pipeline -- the old code was one function evaluated twice, and its
    inputs (which ways happen to be in *this* tile's sidecar) are not the same
    on a server holding every tile and a client holding nine.
  * The static fleet is untouched. `parking.py` is not modified and no
    `.cars.bin` is re-emitted; a route walks around the static cars rather than
    the static cars being told to leave a hole. Both directions produce the same
    invariant, and this one re-emits one sidecar family instead of two and
    cannot move a single one of the 23,020 cars a player has already seen.

---------------------------------------------------------------------------
WHY THE TEST IS A RECTANGLE AND NOT A GRID KEY.

A discrete `(way, side, bay index)` ledger is tempting and it is not enough. Two
different OSM ways routinely reach the same asphalt -- a street mapped twice, a
slip lane that was not tagged as one, a roundabout arm -- which is exactly why
`parking._clear_of_each_other` exists and drops the pairs it finds. A claim
keyed by grid slot would be blind to all of them.

So the ledger holds oriented rectangles in a plain spatial hash, and a bay is
free when its own rectangle touches nothing already in it. The rectangle is the
*conservative* footprint: `RESERVE_HALF_LENGTH` covers the longest body in
`parking.BODY_MIX` at the largest scale the client's per-car jitter can draw it,
plus a margin, and is still under half `parking.BAY_SPACING` so two cars in
adjacent bays of one kerb do not reject each other.

---------------------------------------------------------------------------
DETERMINISM.

Routes are arbitrated in a canonical order -- `(rid, first vertex)` -- rather
than in whatever order `lanes._trails` produced them, so the ledger's answer is
a function of the world and not of the walk. Everything else here is geometry.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from shapely.geometry import Point

from . import parking, streets

# --- What a claim is ----------------------------------------------------------

# How far along the route from its own end the bay would ideally sit, metres.
# `traffic.PARK_INSET_M`'s number and its argument: a route end is a graph node,
# which is a junction, and a car parked in the middle of an intersection is a
# worse artefact than the pop the park stages exist to remove.
PARK_INSET_M = 8.0

# How far the search may walk from there, metres of arc. Ten bays at
# `parking.BAY_SPACING`. Wider buys very little -- a route end that cannot find
# a free bay within sixty metres is on a kerb that is genuinely full -- and
# costs a car that parks a long way from where its route starts, which reads as
# the car having driven up the street before its route began.
WINDOW_M = 60.0

# The reserved footprint, metres. Deliberately larger than any car actually
# drawn and deliberately smaller than half `parking.BAY_SPACING`:
#
#   * The longest body is the 5.4 m van and the client draws every car at
#     `0.96 + 0.08 * hash` scale, so the longest body ever drawn is 5.616 m --
#     2.808 m of half-length. 2.9 covers it with 9 cm to spare.
#   * Two cars in adjacent bays of one kerb are 6.0 m apart, and 2.9 + 2.9 = 5.8
#     leaves 20 cm between their reserved rectangles. Any larger and every bay
#     beside an occupied one would be refused, which would empty the kerb rather
#     than share it.
#
# The width is the 1.9 m van at the same scale (0.988) plus a margin.
RESERVE_HALF_LENGTH = 2.9
RESERVE_HALF_WIDTH = 1.05

# The most lateral travel a pull-out may make, metres. `traffic.MAX_KERB_SHIFT`,
# and the same argument: a car sliding five metres sideways in two and a half
# seconds reads as a glitch rather than as a driver indicating. A bay whose
# offset from the lane exceeds this is refused and the walk continues.
MAX_KERB_SHIFT = 5.0

# How far from a route end a way has to be to be its kerb, metres.
# `traffic.KERB_SEARCH_RADIUS`, which is `lanes.LANE_OFFSET_MAX` plus room for
# the mitre a corner puts in `lanes._offset_left`.
KERB_SEARCH_RADIUS = 9.0

# There is deliberately **no minimum** lateral shift. v1 refused any bay under
# 0.25 m off the lane and called it "no kerb", which quietly deleted the bays on
# every road around 12 m wide -- where `lanes._lane_offset`'s 5 m ceiling and
# `half_width - KERB_OFFSET` happen to coincide -- even though a car parked hard
# against that kerb is exactly where it belongs. A shift of zero is a real bay
# whose lane happens to run through it, and the flags byte, not the geometry,
# is what says whether an end has one.

# The share of a route's own duration either park stage may consume, as
# route-time. **This is the only constraint the client's ramp arithmetic needs
# from this module**, and it is what makes the two independent: given
# `parkT0 <= 0.25 * duration` and `duration - parkT1 <= 0.25 * duration`, the
# client's `buildParkPhases` can always choose ramp spans that are monotone and
# that leave a driving stage between them, whatever `PULL_OUT_SECONDS` happens
# to be over there. See the derivation in `game/traffic.ts`.
MAX_PARK_SHARE = 0.25

# Below this a route gets no park stages at all, seconds. `traffic.MIN_PARK_DURATION`.
MIN_PARK_DURATION = 2.0

# Spatial hash cell, metres. A little over the reserved footprint's long axis so
# a rectangle never spans more than two cells in either direction.
CELL_M = 8.0


@dataclass
class Bay:
    """One claimed kerb bay, as the client will read it.

    `t` is route-time and `(off_e, off_n)` is the vector **from the lane point
    at that route-time to the bay centre**, in ENU metres. A delta rather than a
    position because the client applies it to a point it has already computed
    from the polyline in the same file: `poseCar` is
    `lane(driveT) + off * lateral`, so the parked car lands exactly here without
    the sidecar having to carry a second copy of the geometry, and without this
    module having to know what tile origin the route will be written against.
    """

    t: float
    off_e: float
    off_n: float


class _Hash:
    """Oriented rectangles in a uniform grid. Insert, and ask what touches."""

    def __init__(self) -> None:
        self._cells: dict[tuple[int, int], list[tuple]] = {}

    @staticmethod
    def _rect(e: float, n: float, ce: float, cn: float, hl: float, hw: float) -> tuple:
        return (e, n, ce, cn, hl, hw)

    def _span(self, e: float, n: float, hl: float, hw: float):
        r = math.hypot(hl, hw)
        return (
            math.floor((e - r) / CELL_M),
            math.floor((e + r) / CELL_M),
            math.floor((n - r) / CELL_M),
            math.floor((n + r) / CELL_M),
        )

    def add(self, e: float, n: float, ce: float, cn: float, hl: float, hw: float) -> None:
        rect = self._rect(e, n, ce, cn, hl, hw)
        x0, x1, y0, y1 = self._span(e, n, hl, hw)
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                self._cells.setdefault((cx, cy), []).append(rect)

    def clear(self, e: float, n: float, ce: float, cn: float, hl: float, hw: float) -> bool:
        """True when this rectangle touches nothing already in the hash."""
        x0, x1, y0, y1 = self._span(e, n, hl, hw)
        seen: set[int] = set()
        for cx in range(x0, x1 + 1):
            for cy in range(y0, y1 + 1):
                for other in self._cells.get((cx, cy), ()):
                    key = id(other)
                    if key in seen:
                        continue
                    seen.add(key)
                    if _obb_overlap(e, n, ce, cn, hl, hw, *other):
                        return False
        return True


def _obb_overlap(
    ae: float, an: float, ac: float, as_: float, ahl: float, ahw: float,
    be: float, bn: float, bc: float, bs: float, bhl: float, bhw: float,
) -> bool:
    """Two oriented rectangles, by the separating-axis theorem.

    `(c, s)` is the unit heading; the rectangle's own axes are `(c, s)` along
    and `(s, -c)` across, which is the same left-hand pair `lanes._offset_left`
    and `parking._bay_point` use, so a heading here means what it means
    everywhere else in the pipeline.

    Written out rather than handed to shapely because it runs a few million
    times over the extent and `affinity.rotate` plus `intersects` is three
    orders of magnitude dearer per call.
    """
    de = be - ae
    dn = bn - an
    for lx, ly in ((ac, as_), (as_, -ac), (bc, bs), (bs, -bc)):
        d = abs(de * lx + dn * ly)
        ra = ahl * abs(ac * lx + as_ * ly) + ahw * abs(as_ * lx - ac * ly)
        rb = bhl * abs(bc * lx + bs * ly) + bhw * abs(bs * lx - bc * ly)
        if d > ra + rb:
            return False
    return True


class BayLedger:
    """Every kerb bay in the extent, and the single car that owns it."""

    def __init__(
        self,
        street_network: streets.StreetNetwork,
        parking_network: parking.ParkingNetwork | None,
    ) -> None:
        self._streets = street_network
        self._parking = parking_network
        self._hash = _Hash()
        # Way indices whose candidate cars are already in the hash.
        self._static_seen: set[int] = set()
        self.stats: dict[str, int] = {
            "ends": 0,
            "assigned": 0,
            # Of those, the ones that took the lane rather than a kerb bay.
            "assigned_lane": 0,
            "no_way": 0,
            "no_free_bay": 0,
            "too_short": 0,
            "walked_bays": 0,
            "static_reserved": 0,
            # Why a walked bay was refused. These are the diagnostic that turns
            # "half the route ends found nothing" from a mystery into a number
            # with a cause, and they are per *bay* rather than per end.
            "refuse_time": 0,
            "refuse_shift": 0,
            "refuse_taken": 0,
            "refuse_offgrid": 0,
        }

    # --- The static fleet, lazily ---------------------------------------------

    def _absorb_static(self, east: float, north: float) -> None:
        """Put every static car that could reach this point into the ledger.

        Two things about this are deliberate.

        **The candidate list, not the emitted one.** `parking._cars_on_way`
        skips the per-tile trunk, overlap and cap filters, so it can name a car
        `parking.instances` will go on to drop. That is the conservative
        direction and it is the same promise `power.py` already relies on: a
        route walking around a car that was never emitted costs one bay, where a
        route parking on a car that *was* emitted costs the invariant.

        **`SELECT_MARGIN` and not a bay's own reach.** `ways_near` is a query
        against way *bounding boxes*, and a car stands up to `half_width` --
        twenty metres on the widest arterial -- off its own centreline. A radius
        sized to the bay would miss the way that puts a car beside it while
        keeping its own bounds further away. Thirty metres is
        `parking.SELECT_MARGIN`, which is the number that module already uses
        for exactly this question, and the cost of over-reaching is nil: the
        per-way absorb is memoised on both sides.
        """
        if self._parking is None:
            return
        region = Point(east, north).buffer(parking.SELECT_MARGIN)
        for i in self._parking._streets.ways_near(region):
            if i in self._static_seen:
                continue
            self._static_seen.add(i)
            for car in self._parking._cars_on_way(i):
                self._hash.add(
                    car.east, car.north,
                    math.cos(car.heading), math.sin(car.heading),
                    RESERVE_HALF_LENGTH, RESERVE_HALF_WIDTH,
                )
                self.stats["static_reserved"] += 1

    # --- Assignment -----------------------------------------------------------

    def assign(self, routes: list) -> None:
        """Give every route the two bays its cars park in.

        Canonical order, not `_trails` order: the ledger is greedy and a greedy
        pass whose input order came out of a graph walk would move bays around
        the city whenever an unrelated way was retagged.
        """
        ordered = sorted(
            routes,
            key=lambda r: (int(r.rid), round(float(r.pts[0, 0]), 3), round(float(r.pts[0, 1]), 3)),
        )
        for r in ordered:
            duration = float(r.t[-1])
            if duration < MIN_PARK_DURATION:
                self.stats["too_short"] += 2
                self.stats["ends"] += 2
                continue
            # A joint in a chain is driven through and claims no gutter; see
            # `lanes._chain`.
            r.bay0 = None if getattr(r, "joint0", False) else self._claim(r, duration, near=True)
            r.bay1 = None if getattr(r, "joint1", False) else self._claim(r, duration, near=False)

    def _claim(self, route, duration: float, near: bool) -> Bay | None:
        """Walk this end's kerb outward until a bay comes free.

        **The walk is along the route, not along one way.** The obvious version
        finds the way beside the route end, snaps to its bay grid and steps the
        grid index -- and it starves, because a route end sits *at a junction*,
        which is where a way ends. Measured that way over the inner 1.6 km: 1.36
        bays walked per route end, because the fifth of ten trials had already
        run off the end of the way and there was no way to follow the route onto
        the next one. Stepping the *route's own arc* and snapping whatever kerb
        is beside it at each step follows the road through the corner, which is
        what a driver looking for a park does.
        """
        self.stats["ends"] += 1
        pts = np.asarray(route.pts, dtype=np.float64)
        t = np.asarray(route.t, dtype=np.float64)

        trials = int(WINDOW_M / parking.BAY_SPACING) + 1
        seen: set[tuple[int, int, int]] = set()
        found_way = False
        for n in range(trials):
            seed = _point_at_arc(pts, PARK_INSET_M + n * parking.BAY_SPACING, from_end=not near)
            if seed is None:
                break
            se, sn, de, dn = seed

            pick = self._nearest_way(se, sn, de, dn)
            if pick is None:
                continue
            way, side, line, offset = pick
            found_way = True

            # Snap to the canonical grid: the same
            # `CLEAR_OF_JUNCTION + k * BAY_SPACING` stations `parking._build_side`
            # walks, so a schedule car parked here lands *in the row* the static
            # fleet is parked in rather than half a bay out of it. A way too
            # short to carry the grid at all -- under 26 m, which is
            # `parking._build_cars_on_way`'s own floor -- has no static cars on
            # it either, so the bay is taken at the arc position instead and
            # there is nothing for it to line up with.
            s = float(line.project(Point(se, sn)))
            k_max = _bay_count(line.length)
            if k_max > 0:
                k = min(max(round((s - parking.CLEAR_OF_JUNCTION) / parking.BAY_SPACING), 0), k_max - 1)
                station = parking.CLEAR_OF_JUNCTION + k * parking.BAY_SPACING
            else:
                # No canonical grid on a way this short -- `parking.py` puts no
                # static cars on one either, so there is nothing to line up
                # with. Take the bay at the arc position and key it by a
                # quantised station so two trials a bay apart are still two
                # trials.
                k = -1 - int(s / parking.BAY_SPACING)
                station = s
            if (way, side, k) in seen:
                continue
            seen.add((way, side, k))

            self.stats["walked_bays"] += 1
            # `parking.py`'s own bay constructor, reached through the class
            # rather than copied. The underscore is that module's business and
            # this is the same package: copying the four lines would be a second
            # definition of where a bay is, which is precisely the drift this
            # whole module exists to remove.
            bay = parking.ParkingNetwork._bay_point(line, station, offset * side)
            if bay is None:
                continue
            be, bn, _tx, _ty = bay

            fit = _project_onto_route(pts, t, be, bn, near)
            if fit is None:
                self.stats["refuse_offgrid"] += 1
                continue
            park_t, le, ln, hd_e, hd_n = fit

            # The two bounds the client's ramp arithmetic needs. See MAX_PARK_SHARE.
            # A bay past them is past them for every further bay in the same
            # direction as well, so the walk stops rather than grinding through
            # ten trials it has already ruled out.
            if near:
                if park_t < 0.0 or park_t > duration * MAX_PARK_SHARE:
                    self.stats["refuse_time"] += 1
                    break
            else:
                inset = duration - park_t
                if inset < 0.0 or inset > duration * MAX_PARK_SHARE:
                    self.stats["refuse_time"] += 1
                    break

            off_e = be - le
            off_n = bn - ln
            if math.hypot(off_e, off_n) > MAX_KERB_SHIFT:
                self.stats["refuse_shift"] += 1
                continue

            # The rectangle is tested at the car's *drawn* pose: the bay centre,
            # at the heading the route polyline has there. Not the way's tangent
            # -- the client turns the car with the route, so a check against the
            # way would be checking a car nobody draws.
            self._absorb_static(be, bn)
            if not self._hash.clear(be, bn, hd_e, hd_n, RESERVE_HALF_LENGTH, RESERVE_HALF_WIDTH):
                self.stats["refuse_taken"] += 1
                continue

            self._hash.add(be, bn, hd_e, hd_n, RESERVE_HALF_LENGTH, RESERVE_HALF_WIDTH)
            self.stats["assigned"] += 1
            return Bay(t=park_t, off_e=off_e, off_n=off_n)

        # Last resort: the lane itself.
        #
        # A route end with no free kerb still has to choose between two
        # failures. Give it no park stage and its cars wink in and out *at road
        # speed in the middle of a lane*, which is the exact artefact the park
        # stages were added to remove and which the user reported. Let it dwell
        # where it drives and it is a car stopped eight metres short of a
        # junction -- which is what a car at a red light is, and which v1 already
        # did for every end that found no kerb.
        #
        # What is new is that the lane spot goes through the same ledger. So it
        # is only taken when nothing else is standing there, and once taken
        # nothing else may stand there either: the invariant survives the
        # fallback rather than being suspended by it.
        for n in range(trials):
            seed = _point_at_arc(pts, PARK_INSET_M + n * parking.BAY_SPACING, from_end=not near)
            if seed is None:
                break
            se, sn, _de, _dn = seed
            fit = _project_onto_route(pts, t, se, sn, near)
            if fit is None:
                continue
            park_t, le, ln, hd_e, hd_n = fit
            if near:
                if park_t < 0.0 or park_t > duration * MAX_PARK_SHARE:
                    break
            elif not (0.0 <= duration - park_t <= duration * MAX_PARK_SHARE):
                break
            self._absorb_static(le, ln)
            if not self._hash.clear(le, ln, hd_e, hd_n, RESERVE_HALF_LENGTH, RESERVE_HALF_WIDTH):
                continue
            self._hash.add(le, ln, hd_e, hd_n, RESERVE_HALF_LENGTH, RESERVE_HALF_WIDTH)
            self.stats["assigned"] += 1
            self.stats["assigned_lane"] += 1
            return Bay(t=park_t, off_e=0.0, off_n=0.0)

        self.stats["no_free_bay" if found_way else "no_way"] += 1
        return None

    def _nearest_way(self, east: float, north: float, de: float, dn: float):
        """The way this route end is running along, and which kerb is its left.

        The kerb a car parks against is the one on its **left**, which is the
        whole of spec 7.7's left-hand traffic reduced to a sign. Left of a
        heading `(de, dn)` in ENU is `(-dn, de)`, and `parking._bay_point` puts
        `side = +1` on the left of the *way's* own tangent -- so the side that
        is left of travel is the sign of the dot product of the two tangents.
        """
        best = None
        best_d = KERB_SEARCH_RADIUS
        p = Point(east, north)
        for i in self._streets.ways_near(p.buffer(KERB_SEARCH_RADIUS)):
            road = self._streets.roads[i]
            if road.is_foot:
                continue
            line = self._streets.centreline(i)
            d = float(line.distance(p))
            if d >= best_d:
                continue
            offset = self._streets.half_width(i) - parking.KERB_OFFSET
            if offset <= 0.0:
                continue
            tangent = _tangent_at(line, float(line.project(p)))
            if tangent is None:
                continue
            tx, ty = tangent
            along = tx * de + ty * dn
            if abs(along) < 1e-6:
                continue
            best_d = d
            best = (i, 1 if along > 0.0 else -1, line, offset)
        return best


def _bay_count(length: float) -> int:
    """`parking._build_side`'s own bay count for a way of this length."""
    last = length - parking.CLEAR_OF_JUNCTION
    if last <= parking.CLEAR_OF_JUNCTION:
        return 0
    return int((last - parking.CLEAR_OF_JUNCTION) / parking.BAY_SPACING) + 1


def _tangent_at(line, s: float) -> tuple[float, float] | None:
    a = line.interpolate(max(s - 0.5, 0.0))
    b = line.interpolate(min(s + 0.5, line.length))
    dx, dy = b.x - a.x, b.y - a.y
    n = math.hypot(dx, dy)
    if n < 1e-6:
        return None
    return (dx / n, dy / n)


def _point_at_arc(pts: np.ndarray, metres: float, from_end: bool):
    """The point `metres` of arc into a polyline, and the unit direction there.

    The direction is always the **direction of travel**, whichever end the walk
    started from, because the side of the road a car parks on is a fact about
    travel and not about the walk.
    """
    n = len(pts)
    if n < 2:
        return None
    acc = 0.0
    for s in range(n - 1):
        i = n - 2 - s if from_end else s
        de = pts[i + 1, 0] - pts[i, 0]
        dn = pts[i + 1, 1] - pts[i, 1]
        seg = math.hypot(de, dn)
        if seg <= 0.0:
            continue
        if acc + seg >= metres:
            u = (metres - acc) / seg
            if from_end:
                u = 1.0 - u
            return (
                pts[i, 0] + u * de,
                pts[i, 1] + u * dn,
                de / seg,
                dn / seg,
            )
        acc += seg
    # Shorter than the inset: take the far end and the last direction with
    # length in it.
    for s in range(n - 1):
        i = n - 2 - s
        de = pts[i + 1, 0] - pts[i, 0]
        dn = pts[i + 1, 1] - pts[i, 1]
        seg = math.hypot(de, dn)
        if seg > 0.0:
            j = 0 if from_end else n - 1
            return (pts[j, 0], pts[j, 1], de / seg, dn / seg)
    return None


# How much of the route either end's search may reach along, metres of arc. The
# window plus the inset plus a car, so the projection below cannot lock onto a
# lobe of a route that loops back near its own start.
_PROJECT_REACH_M = WINDOW_M + PARK_INSET_M + 12.0


def _project_onto_route(pts: np.ndarray, t: np.ndarray, east: float, north: float, near: bool):
    """Route-time at the point on the polyline nearest `(east, north)`.

    **Linear in `t`, not in arc length**, which is the one thing about this that
    could quietly be wrong. The client's `poseCar` interpolates position
    linearly in route-time within a segment -- `u = (driveT - t[lo]) / span`
    then `x = x0 + u * (x1 - x0)` -- so the parametric position of the foot of
    the perpendicular *is* the fraction of the segment's time, and reading it as
    a fraction of arc would put the bay somewhere the car never passes on a
    segment that spans a speed change.

    The heading comes back as **this segment's** direction, which is what the
    client's `poseCar` will use for the same route-time -- its binary search
    lands in the same interval. The one case where the two could disagree is a
    foot clamped to exactly `u = 1`, where `park_t == t[i+1]` and `poseCar`'s
    `t[mid] <= driveT` test steps into the *next* segment: at a corner that is a
    car reserved at one heading and drawn at another. Nudging `u` under 1 does
    not fix it, because `park_t` is written as an f32 and the nudge is below its
    resolution on a route a hundred seconds long. It is left alone and measured
    instead: over the first 180 rebuilt tiles, 4,239 claimed bays produced zero
    reserved-rectangle overlaps against each other and zero against the 414,936
    static cars, so the six metres of bay pitch absorbs it.

    Returns `(route_time, lane_east, lane_north, heading_east, heading_north)`.
    """
    n = len(pts)
    best_d2 = float("inf")
    best = None
    acc = 0.0
    for s in range(n - 1):
        i = n - 2 - s if not near else s
        ae, an = pts[i, 0], pts[i, 1]
        be, bn = pts[i + 1, 0], pts[i + 1, 1]
        de, dn = be - ae, bn - an
        l2 = de * de + dn * dn
        if l2 <= 0.0:
            continue
        # The reach is tested **after** this segment is considered, not before.
        # Tested before, a route whose very first segment is longer than the
        # reach -- an arterial with 200 m between vertices -- has no segment
        # projected at all and the whole end silently loses its bay. That was
        # 429 of 1,280 walked bays over the inner 1.6 km before it was fixed.
        u = ((east - ae) * de + (north - an) * dn) / l2
        u = min(max(u, 0.0), 1.0)
        fe = ae + u * de
        fn = an + u * dn
        d2 = (east - fe) ** 2 + (north - fn) ** 2
        if d2 < best_d2:
            best_d2 = d2
            span = float(t[i + 1] - t[i])
            inv = 1.0 / math.sqrt(l2)
            best = (float(t[i]) + u * span, fe, fn, de * inv, dn * inv)
        acc += math.sqrt(l2)
        if acc > _PROJECT_REACH_M:
            break
    return best
