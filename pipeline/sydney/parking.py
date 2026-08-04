"""Parked cars along the kerbs, per tile.

Spec section 7.7 asks for **left-hand traffic with parked cars facing
accordingly**, and the second half of that phrase is the whole module. A Sydney
kerb is a near-continuous line of parked cars: they are the single densest
man-made object in the street, they sit at eye level, and without them every
road reads as a film set an hour before call. Trees fixed the skyline; this
fixes the gutter.

Architecturally this is `vegetation.py` again, and deliberately so -- a network
built once for the whole run, per-tile instance emission, a binary sidecar, and
client-side instanced meshes streamed and disposed with the tile. Anything that
reads oddly here is worth checking against that file first, because the two are
meant to be the same shape.

**Where a car goes.** Parallel bays every 6 m along both kerbs of the classes
people actually park on, offset from the centreline by `half_width - 1.05` so
the car sits hard against the kerb and *inside* the carriageway. That offset is
taken from `streets.StreetNetwork` rather than re-derived, on the same argument
`vegetation.py` makes about the verge: the kerb face that was actually drawn is
the one the car has to line up with, to a centimetre.

**Which bays are full.** Not an independent roll per bay. Real kerbs cluster --
four cars nose to tail outside a block of flats, then a driveway, then two more
-- and independent rolls at a 55% rate produce a stipple that reads as noise
from any distance. Occupancy is generated as alternating *runs*: 2-5 occupied
bays, then a gap sized so the long-run fill lands on the target. The difference
between the two is not subtle at a hundred metres.

**Which way it faces.** Left-hand traffic. On the left kerb of a two-way street
the adjacent lane travels with the way, so the car does too; on the right kerb
it travels against, so the car faces back down the street. That is a *sign*, and
signs are exactly the kind of thing that is wrong for six months without anyone
noticing, so it is stated as an invariant and counted at build time -- see
`kerb_side_sign` and the audit it feeds in `cli.py`.

Determinism is inherited whole from `vegetation.py`: every bay is generated from
its source way and then assigned to whichever tile contains it, never generated
from the tile, and every decision along the way is a pure function of the OSM id,
the side and the bay index. Two tiles asking about the same street get the same
list and each keeps its own half.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from shapely import affinity
from shapely.geometry import LineString, Point, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from . import streets, vegetation

# The same SplitMix64 the trees are placed with, imported rather than copied: two
# copies of a hash drift, and the whole determinism argument above rests on this
# being one function. The streams are kept apart by the constants mixed in below,
# so a car and a tree at the same place still make independent decisions.
from .vegetation import _hash, _osm_int, _pick, _unit

# --- Body types ---------------------------------------------------------------
# The u8 written into the sidecar. APPEND ONLY -- the client keys its geometry
# table off these integers, exactly as it does for tree species.

SEDAN = 0
HATCH = 1
SUV = 2
UTE = 3
VAN = 4

BODY_COUNT = 5

BODY_NAME = {SEDAN: "sedan", HATCH: "hatch", SUV: "suv", UTE: "ute", VAN: "van"}

# This is 2026 Sydney, not 1996 Sydney. The mid-size sedan that would have been
# half of this list thirty years ago has been eaten by the mid-size SUV, and a
# kerb full of Camrys is a period detail as loud as a wrong sun. The ute is the
# other giveaway -- a HiLux or a Ranger on a suburban kerb is unremarkable here
# and reads as a work site anywhere else.
BODY_MIX: tuple[tuple[int, float], ...] = (
    (SUV, 0.35),
    (SEDAN, 0.25),
    (HATCH, 0.25),
    (UTE, 0.10),
    (VAN, 0.05),
)

# --- Colours ------------------------------------------------------------------
# Index into the client's palette. APPEND ONLY, same reason.

WHITE = 0
SILVER = 1
GREY = 2
BLACK = 3
BLUE = 4
RED = 5
GREEN = 6
BEIGE = 7

COLOUR_COUNT = 8

COLOUR_NAME = {
    WHITE: "white",
    SILVER: "silver",
    GREY: "grey",
    BLACK: "black",
    BLUE: "blue",
    RED: "red",
    GREEN: "green",
    BEIGE: "beige",
}

# The Australian car park, which is overwhelmingly achromatic: white, silver,
# grey and black are 70% of it between them. That is not a simplification made
# for the palette's convenience -- it is what the VFACTS registration figures
# say, and it is why a street of randomly hued cars looks like a toy box. The
# eight per cent of red and ten of blue are the whole colour budget, and they
# are what stop the row reading as monochrome.
COLOUR_MIX: tuple[tuple[int, float], ...] = (
    (WHITE, 0.30),
    (SILVER, 0.15),
    (GREY, 0.10),
    (BLACK, 0.15),
    (BLUE, 0.10),
    (RED, 0.08),
    (GREEN, 0.05),
    (BEIGE, 0.07),
)

# --- Where parking happens ----------------------------------------------------

# Classes with kerbside parking. The exclusions are the interesting half:
#
#   motorway / trunk / primary   clearways. Nobody parks on Anzac Parade or the
#                                Cahill Expressway, and a line of cars along one
#                                would be the loudest error in the build.
#   service                      laneways, driveways and car park aisles, and by
#                                far the most numerous class in the extent. The
#                                same argument `vegetation.py` makes about not
#                                planting a tree every fifteen metres down every
#                                back lane applies with more force to a two-tonne
#                                object at 6 m spacing.
#   *_link                       ramps and slip lanes -- junction geometry, and
#                                the junction keep-out below would delete most of
#                                them anyway.
#   footways                     self-evidently.
PARKING_CLASSES = {"residential", "unclassified", "living_street", "tertiary", "secondary"}

# Fill rate, as the long-run fraction of **all** bays occupied -- which is not
# the same number as the occupancy of the bays a driver could legally use, and
# the difference is where these values come from.
#
# Nothing here knows about driveways. OSM does not map them at anything like the
# completeness this would need, and the brief for this feature says as much, so
# every metre of kerb is treated as a bay. In a real terrace or bungalow suburb
# something like a quarter of the kerb is crossover, hydrant, bus zone or corner
# splay and can never hold a car at all. Add the resident-permit and 2P zoning
# that empties an inner-suburb kerb by the middle of the afternoon and a *real*
# 55% occupancy of the usable kerb is about a third of the bays this module
# generates.
#
# The measured consequence, at the inner ring: 0.55/0.35 emits 40,000 cars with
# a per-tile p50 of 182 and 54 tiles over the 300 ceiling, which is both over the
# render budget this feature was scoped against and -- because the cap then fires
# on a quarter of the tiles -- a density that stops meaning anything at the top
# end. 0.32/0.19 emits 23,020 at a p50 of 110, and the cap touches exactly one
# tile. These two numbers are the density dial for this feature and nothing else
# is: raising them raises the count almost linearly until the cap starts biting.
#
# Two rates, because a residential street holds resident parking all day and a
# tertiary or secondary road is a clearway on at least one side for part of it.
QUIET_CLASSES = {"residential", "unclassified", "living_street"}
FILL_QUIET = 0.32
FILL_BUSY = 0.19

# Bay pitch along the kerb. A parallel bay in the Australian standard is 6.0-6.6 m
# for an unconstrained kerb; 6.0 with a car 4.2-5.4 m long leaves the 0.6-1.8 m
# of slop that a real row has, without ever letting two bodies touch.
BAY_SPACING = 6.0

# How far in from the kerb face the car's centreline sits. Half a car's width
# (0.9 m) plus 0.15 m of gutter, so the body is hard against the kerb and wholly
# inside the carriageway.
KERB_OFFSET = 1.05

# Occupied runs, in bays. 2-5 is what a kerb outside a terrace row looks like:
# long enough to read as a queue, short enough that the gaps -- driveways,
# crossings, the space someone just left -- are frequent.
#
# The run is the whole reason the occupancy is generated this way rather than as
# an independent roll per bay. At a 32% rate, independent rolls put one car every
# three bays, evenly, everywhere -- a stipple that reads as *noise* at any
# distance and as nothing at all from a hundred metres. Runs of three or four
# with real gaps between them read as a street. Same car count, entirely
# different image.
RUN_MIN = 2
RUN_MAX = 5
MEAN_RUN = (RUN_MIN + RUN_MAX) / 2.0

# --- Keep-outs ----------------------------------------------------------------

# No car within this of a junction. Two reasons and they agree: sight lines at a
# corner, and the fact that a real Sydney corner is yellow-lined for about this
# far in both directions. It is measured from the junction *node*, which sits on
# the centreline of the cross street, so the effective clearance along the kerb
# is this less about half the cross street's width.
CLEAR_OF_JUNCTION = 10.0

# The bay's half-extents, metres. Sized to the longest body in the table (the
# 5.4 m van) plus a little, so one keep-out serves every body type -- a per-body
# footprint would make the exclusion depend on a draw that happens after it.
CAR_HALF_LENGTH = 2.7
CAR_HALF_WIDTH = 0.9
# The smallest circle containing that footprint, for the keep-outs that test a
# radius rather than the oriented rectangle.
BAY_RADIUS = math.hypot(CAR_HALF_LENGTH, CAR_HALF_WIDTH)

# Clearance around a tree trunk. See `_clear_of_trunks` for why this is an
# oriented-box test and not the obvious radius.
TRUNK_CLEARANCE = 0.35

# Carriageway half-width below which nothing parks: a 5.2 m road with cars on it
# is a laneway, and OSM's `width` tag on a residential street occasionally says
# so when the street is nothing of the sort.
MIN_HALF_WIDTH = 2.6
# ... and below which only one side parks. Two rows of cars plus a lane to drive
# between them needs about 6.8 m of carriageway; under that, a real street is
# signposted to one side. The side is hashed per way rather than always being the
# left, because always-left puts every car in every narrow lane in the suburb
# facing the same way, which reads as a rule rather than as a street.
BOTH_SIDES_HALF_WIDTH = 3.4

# Cars parked against the traffic, as a fraction. Illegal, ubiquitous, and one of
# those details whose absence is felt rather than noticed: a row in which every
# single car agrees is as synthetic as a row of identically spaced trees.
WRONG_WAY = 0.04

# Per-car heading jitter, radians. Two degrees is about what a competent parallel
# park leaves against the kerb line.
HEADING_JITTER = math.radians(2.0)

# Per-tile ceiling. The inner ring's busiest tile lands well under this; it is
# here for the same reason `MAX_TREES_PER_TILE` is, which is that a silent
# 900-instance tile is a frame spike nobody would attribute to this file.
MAX_CARS_PER_TILE = 300

# Ways within this of a tile's bounds can put a car inside it. Must exceed the
# widest offset any way produces, which is half of `streets.MAX_ROAD_WIDTH`.
SELECT_MARGIN = 30.0


@dataclass
class Car:
    """One parked car, in ENU metres. Tile-local conversion happens at write time."""

    east: float
    north: float
    # Renderer Y rotation, radians. Equal to `atan2(facing_north, facing_east)`
    # in ENU -- see `_heading` for why those are the same number.
    heading: float
    body: int
    colour: int
    seed: int
    # Unit vector from the centreline out towards the kerb this car is against.
    # Carried only so the left-hand-traffic invariant can be checked numerically
    # after the fact rather than asserted in a comment; it is not written to the
    # sidecar and the client never sees it.
    kerb_east: float
    kerb_north: float
    # Parked against the traffic. Counted separately in the audit, because these
    # are the cars that are *supposed* to fail the invariant.
    wrong_way: bool


def kerb_side_sign(car: Car) -> float:
    """`cross_z(facing, outward kerb normal)`. Positive means the kerb is on the
    car's **left**, which is what left-hand traffic requires.

    This is the whole of spec 7.7's "parked cars facing accordingly", reduced to
    a sign that can be counted. In a right-hand-traffic city every one of these
    is negative, and the two builds are otherwise indistinguishable from any
    statistic -- same count, same spacing, same colours -- which is exactly why
    it is worth a function and a tally rather than a comment.
    """
    return math.cos(car.heading) * car.kerb_north - math.sin(car.heading) * car.kerb_east


class ParkingNetwork:
    """Every parked car in the extent, indexed for tile queries.

    Built once per run, like `StreetNetwork` and `VegetationNetwork`, and for the
    same reason: a way is asked about by every tile it touches, and walking it is
    far more expensive than the lookup.
    """

    def __init__(
        self,
        street_network: streets.StreetNetwork,
        veg_network: vegetation.VegetationNetwork,
    ) -> None:
        self._streets = street_network
        self._veg = veg_network
        self._cache: dict[int, list[Car]] = {}

        # Junction proxies: the end points of every street-class way. Built the
        # same way `VegetationNetwork` builds its own and with the same caveat --
        # OSM splits a way at a junction almost without exception, so the ends
        # are where the corners are, and it over-reports because a way also
        # splits where the name or the speed limit changes. Over-reporting costs
        # a few bays; under-reporting puts a car across a corner splay.
        #
        # Duplicated rather than shared because a junction is a *street* fact and
        # its natural home is `streets.py`; hoisting it there is a follow-up, not
        # something this feature should do on its way past.
        ends: list[Point] = []
        for i, r in enumerate(street_network.roads):
            if r.is_foot:
                continue
            coords = list(street_network.centreline(i).coords)
            if len(coords) < 2:
                continue
            ends.append(Point(coords[0]))
            ends.append(Point(coords[-1]))
        self._junctions = STRtree(ends) if ends else None

        # Why each candidate bay was thrown away. Reported by the build, because
        # "18,000 cars" says nothing about whether the placement rules are doing
        # what they claim and a yield table says most of it.
        self.stats: dict[str, int] = {
            "ways_considered": 0,
            "ways_parked": 0,
            "ways_one_side": 0,
            "bays": 0,
            "unoccupied": 0,
            "placed": 0,
            "drop_junction": 0,
            "drop_building": 0,
            "drop_tree": 0,
            "drop_overlap": 0,
            "drop_cap": 0,
            "wrong_way": 0,
        }

        # Tallied over the cars actually *emitted*, not the ones generated, so
        # the reported mixes describe what is in the world rather than what was
        # proposed. Accumulated in `instances`, which the build calls exactly
        # once per tile -- calling it twice for the same tile would double-count
        # here and nowhere else.
        self.emitted = 0
        self.body_counts: dict[int, int] = dict.fromkeys(BODY_NAME, 0)
        self.colour_counts: dict[int, int] = dict.fromkeys(COLOUR_NAME, 0)
        # The left-hand-traffic audit. `kerb_left` should be every emitted car
        # bar the deliberate wrong-way ones; see `kerb_side_sign`.
        self.kerb_left = 0
        self.kerb_right = 0
        self.emitted_wrong_way = 0

    # --- Tile coverage -------------------------------------------------------

    def instances(self, tile_key: str) -> list[Car]:
        """Every car standing inside one tile."""
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)

        def inside(c: Car) -> bool:
            # Half-open on the upper edge, so a car exactly on a tile line lands
            # in one tile and not in both.
            return e0 <= c.east < e1 and n0 <= c.north < n1

        cars: list[Car] = []
        for i in self._streets.ways_near(tile_box.buffer(SELECT_MARGIN)):
            cars.extend(c for c in self._cars_on_way(i) if inside(c))
        if not cars:
            return []

        # Order is fixed before anything greedy runs over it, so that the two
        # filters below cannot depend on which way `ways_near` happened to return
        # first. Without this a rebuild could keep a different car out of an
        # overlapping pair, which is a one-car diff nobody would ever chase.
        cars.sort(key=lambda c: (c.east, c.north))

        cars = self._clear_of_trunks(cars, tile_box)
        cars = self._clear_of_each_other(cars)
        cars = self._cap(cars)
        self._tally(cars)
        return cars

    def cars_near(self, region: BaseGeometry) -> list[Car]:
        """Every candidate car standing near `region`, from every way that
        reaches it.

        Exposed for `power.py`, which has to know where the bodies are before it
        can decide a pole is not standing in one, and cannot ask per tile: a car
        two metres over a tile line is still in the way of a pole on this side of
        it. This is `vegetation.trees_near` from the other end of the same
        relationship, and it makes the same three promises.

        Deliberately *not* the per-tile answer. It skips the trunk test, the
        overlap test and the per-tile cap, so it can return a car that
        `instances` will go on to drop. That is the conservative direction for a
        keep-out and it is also the stable one -- a pole's fate should not depend
        on how crowded the tile it happens to sit in turned out to be. It also
        touches none of the emitted-car tallies, which belong to `instances`
        alone: `_cars_on_way` is memoised, so asking here only ever warms a cache
        that the tile pass was going to fill anyway.
        """
        out: list[Car] = []
        for i in self._streets.ways_near(region):
            out.extend(self._cars_on_way(i))
        return out

    def _tally(self, cars: list[Car]) -> None:
        self.emitted += len(cars)
        for c in cars:
            self.body_counts[c.body] += 1
            self.colour_counts[c.colour] += 1
            if c.wrong_way:
                self.emitted_wrong_way += 1
            if kerb_side_sign(c) > 0.0:
                self.kerb_left += 1
            else:
                self.kerb_right += 1

    def _cap(self, cars: list[Car]) -> list[Car]:
        """Hold a tile under `MAX_CARS_PER_TILE`.

        Thinned by hashed rank rather than by list order, so a tile over budget
        loses an even spread of its cars and keeps its spacing -- the brief for
        this feature is explicit that a crowded tile should shed *occupancy* and
        never stretch the 6 m pitch, and dropping by seed is the cheapest way to
        do exactly that.
        """
        if len(cars) <= MAX_CARS_PER_TILE:
            return cars
        self.stats["drop_cap"] += len(cars) - MAX_CARS_PER_TILE
        return sorted(cars, key=lambda c: c.seed)[:MAX_CARS_PER_TILE]

    # --- Per-way generation --------------------------------------------------

    def _cars_on_way(self, i: int) -> list[Car]:
        cached = self._cache.get(i)
        if cached is not None:
            return cached
        out = self._build_cars_on_way(i)
        self._cache[i] = out
        return out

    def _build_cars_on_way(self, i: int) -> list[Car]:
        road = self._streets.roads[i]
        # Nobody parks on a bridge, and since `decks.py` took the bridge ways off
        # the ground there is no longer any asphalt under one to park on: a bay
        # here would be a row of cars floating over a creek. See `streets.DECK_EDGE`.
        if road.is_foot or road.bridge or road.highway not in PARKING_CLASSES:
            return []
        self.stats["ways_considered"] += 1

        line = self._streets.centreline(i)
        length = line.length
        if length < 2.0 * CLEAR_OF_JUNCTION + BAY_SPACING:
            return []

        half = self._streets.half_width(i)
        if half < MIN_HALF_WIDTH:
            return []

        way_id = _osm_int(road.osm_id)
        # A one-way way gets its left kerb only. On a genuine one-way street both
        # sides are legal in NSW, so this under-fills the CBD by a few hundred
        # cars -- and it is worth every one of them, because the other thing
        # `oneway` marks is *half of a divided road*, where the "right kerb" is
        # the median and there is no kerb there at all. Parking a line of cars
        # down the middle of Anzac Parade is a worse error than not parking them
        # along William Street, and there is no tag that separates the two cases.
        #
        # It also makes the left-hand-traffic invariant total: every car this
        # module emits, on every class, has the kerb on its left unless it is one
        # of the deliberate wrong-way four per cent.
        if road.oneway:
            sides: tuple[int, ...] = (1,)
        elif half < BOTH_SIDES_HALF_WIDTH:
            sides = (1 if _unit(_hash(way_id, 0x5DE), 0) < 0.5 else -1,)
            self.stats["ways_one_side"] += 1
        else:
            sides = (1, -1)

        fill = FILL_QUIET if road.highway in QUIET_CLASSES else FILL_BUSY
        offset = half - KERB_OFFSET
        out: list[Car] = []
        for side in sides:
            out.extend(self._build_side(i, way_id, line, length, offset * side, side, fill))
        if out:
            self.stats["ways_parked"] += 1
        return out

    def _build_side(
        self,
        i: int,
        way_id: int,
        line: LineString,
        length: float,
        offset: float,
        side: int,
        fill: float,
    ) -> list[Car]:
        """Walk one kerb of one way, in runs."""
        # Both ends start a junction keep-out in, so the first bays are not
        # generated only to be thrown away by the test below. The test still runs
        # -- it is what catches the cross streets in the middle of the block.
        last = length - CLEAR_OF_JUNCTION
        n_bays = int((last - CLEAR_OF_JUNCTION) / BAY_SPACING) + 1
        if n_bays <= 0:
            return []

        # Alternating runs of occupied and empty bays. The gap length is derived
        # from the fill target rather than chosen, so `FILL_*` above means what it
        # says: with occupied runs averaging `MEAN_RUN`, a mean gap of
        # `MEAN_RUN * (1 - f) / f` puts the long-run occupancy at exactly `f`.
        mean_gap = MEAN_RUN * (1.0 - fill) / fill
        # Which phase the way starts in is hashed, so a street does not always
        # begin with a full run at its western end.
        occupied = _unit(_hash(way_id, side, 0x9A5E), 0) < 0.5

        out: list[Car] = []
        k = 0
        run = 0
        while k < n_bays:
            h = _hash(way_id, side, run, 0xCA25)
            if occupied:
                span = RUN_MIN + int(_unit(h, 1) * (RUN_MAX - RUN_MIN + 1))
                span = min(span, RUN_MAX)
                for j in range(span):
                    if k + j >= n_bays:
                        break
                    self.stats["bays"] += 1
                    car = self._place(i, way_id, line, CLEAR_OF_JUNCTION + (k + j) * BAY_SPACING,
                                      offset, side)
                    if car is not None:
                        out.append(car)
            else:
                span = max(1, round(mean_gap * (0.5 + _unit(h, 2))))
                self.stats["bays"] += min(span, n_bays - k)
                self.stats["unoccupied"] += min(span, n_bays - k)
            k += span
            run += 1
            occupied = not occupied
        return out

    def _place(
        self, i: int, way_id: int, line: LineString, s: float, offset: float, side: int
    ) -> Car | None:
        """One bay, or `None` if something in the world is already there."""
        bay = self._bay_point(line, s, offset)
        if bay is None:
            return None
        east, north, tx, ty = bay
        p = Point(east, north)

        if self._junctions is not None and len(self._junctions.query(p.buffer(CLEAR_OF_JUNCTION))):
            self.stats["drop_junction"] += 1
            return None

        # A building inside the carriageway means the road width is overstated or
        # the footprint is, and either way the car is in a wall. Tested as a
        # circle rather than the oriented box the trees get: it is cheaper, and
        # unlike a trunk a wall that close is a data error rather than something
        # to park beside, so there is nothing to be gained from being exact about
        # which centimetre it starts at.
        #
        # The radius is the footprint's *circumradius* and not its half-length. A
        # 2.7 m circle leaves the four corners of the bay outside it, and a wall
        # sitting in that crescent slips through -- measured at one car in two
        # thousand over the inner ring, which is one visible car in a wall.
        for poly in self._streets.buildings_near(p.buffer(BAY_RADIUS)):
            if poly.distance(p) < BAY_RADIUS:
                self.stats["drop_building"] += 1
                return None

        h = _hash(way_id, side, int(s * 100.0), 0x0CAB)
        wrong = _unit(h, 3) < WRONG_WAY
        if wrong:
            self.stats["wrong_way"] += 1
        self.stats["placed"] += 1
        return Car(
            east=east,
            north=north,
            heading=self._heading(tx, ty, side, wrong, _unit(h, 4)),
            body=_pick(BODY_MIX, _unit(h, 5)),
            colour=_pick(COLOUR_MIX, _unit(h, 6)),
            seed=h & 0xFFFF,
            # Outward from the centreline towards this car's kerb: the left
            # normal of travel for `side = +1`, matching the winding convention
            # `_bay_point` and `streets._emit_kerb_face` share.
            kerb_east=-ty * side,
            kerb_north=tx * side,
            wrong_way=wrong,
        )

    @staticmethod
    def _bay_point(
        line: LineString, s: float, offset: float
    ) -> tuple[float, float, float, float] | None:
        """The bay centre `offset` metres left of the way at distance `s`, and
        the unit tangent there.

        Same construction as `vegetation._verge_point`, and it returns the
        tangent as well because this module needs to know which way the street
        runs and that file does not.
        """
        a = line.interpolate(max(s - 0.5, 0.0))
        b = line.interpolate(min(s + 0.5, line.length))
        dx, dy = b.x - a.x, b.y - a.y
        n = math.hypot(dx, dy)
        if n < 1e-6:
            return None
        tx, ty = dx / n, dy / n
        c = line.interpolate(s)
        return (c.x - ty * offset, c.y + tx * offset, tx, ty)

    @staticmethod
    def _heading(tx: float, ty: float, side: int, wrong: bool, jitter: float) -> float:
        """Which way the car points, as the renderer's Y rotation.

        Left-hand traffic, stated as the arithmetic rather than as a rule: the
        lane next to the **left** kerb travels with the way, the lane next to the
        right kerb travels against it, and a parked car faces the traffic it is
        parked in. So the facing is the way tangent times `side`.

        The conversion to a Y rotation is the one line in this module worth
        checking rather than trusting. World axes are x = east, y = up,
        z = -north, and the client builds a car with its nose along local +X. A
        rotation of theta about Y sends local +X to world `(cos t, 0, -sin t)`,
        and the facing `(fe, fn)` in ENU is world `(fe, 0, -fn)`. Equate the two
        and `cos t = fe`, `sin t = fn` -- so the rotation is just the ENU bearing
        measured as `atan2(north, east)`, with no axis flip anywhere in it.
        """
        d = -1.0 if wrong else 1.0
        fe, fn = tx * side * d, ty * side * d
        return math.atan2(fn, fe) + (jitter - 0.5) * 2.0 * HEADING_JITTER

    # --- Per-tile keep-outs ---------------------------------------------------

    def _clear_of_trunks(self, cars: list[Car], tile_box: BaseGeometry) -> list[Car]:
        """Drop any car whose bay has a tree standing in it.

        The obvious test -- no car within 2.5 m of a tree -- is wrong here, and
        the arithmetic says so before any of it renders. A street tree stands at
        `half_width + KERB_WIDTH + VERGE_OFFSET` and a car at
        `half_width - 1.05`, so a tree directly beside a car is *always* exactly
        0.15 + 1.0 + 1.05 = 2.20 m away. A 2.5 m radius therefore deletes every
        car that has a tree next to it, which on a leafy inner-suburb street is
        one car in every two or three -- a systematic gap-toothed kerb wherever
        the planting is best.

        What is actually wanted is that the trunk is not *in* the bay, so the
        test is the oriented box: the trunk is transformed into the car's own
        frame and checked against its half-extents. That leaves 1.3 m of
        clearance beside a normal street tree and still catches the cases that
        matter -- a surveyed OSM node digitised into the carriageway, a park
        specimen overhanging a kerb, a tree on the far side of a street narrow
        enough for the two to meet.

        Trees are taken from a region larger than the tile because a trunk two
        metres over a tile line still stands in a bay on this side of it.
        """
        trees = self._veg.trees_near(tile_box.buffer(CAR_HALF_LENGTH + TRUNK_CLEARANCE))
        if not trees:
            return cars
        index = STRtree([Point(t.east, t.north) for t in trees])

        out: list[Car] = []
        reach = CAR_HALF_LENGTH + TRUNK_CLEARANCE
        for car in cars:
            c, s = math.cos(car.heading), math.sin(car.heading)
            blocked = False
            for j in index.query(Point(car.east, car.north).buffer(reach)):
                t = trees[int(j)]
                de, dn = t.east - car.east, t.north - car.north
                along = de * c + dn * s
                across = -de * s + dn * c
                if abs(along) < reach and abs(across) < CAR_HALF_WIDTH + TRUNK_CLEARANCE:
                    blocked = True
                    break
            if blocked:
                self.stats["drop_tree"] += 1
            else:
                out.append(car)
        return out

    def _clear_of_each_other(self, cars: list[Car]) -> list[Car]:
        """Drop any car that interpenetrates one already kept.

        The 6 m pitch guarantees this along a single kerb; what it says nothing
        about is two *different* ways reaching the same asphalt -- a street
        mapped twice, a slip lane that was not tagged as one, a roundabout arm.
        Rare, and a pair of interpenetrating cars is the sort of artefact a
        player photographs, so the check is cheap insurance rather than a hot
        path. Exact rectangle-against-rectangle, because two cars meeting at a
        right angle at a corner are 3 m apart at the centres and not overlapping
        at all, and any radius that catches them also deletes the legitimate pair
        parked either side of a 6 m living street.
        """
        # No spatial index: `instances` has already sorted by easting, so every
        # car that could possibly reach this one is in a contiguous window ending
        # at the last car kept, and the scan stops the moment it leaves it. The
        # window is two footprint *circumradii* rather than two half-lengths --
        # the widest two rectangles can be apart and still touch is corner to
        # corner, and a window of 5.4 m instead of 5.69 quietly missed four
        # overlapping pairs in the inner ring when this was first written.
        kept: list[Car] = []
        boxes: list[BaseGeometry] = []
        reach = 2.0 * BAY_RADIUS
        for car in cars:
            rect = self._footprint(car)
            clash = False
            for j in range(len(kept) - 1, -1, -1):
                if car.east - kept[j].east > reach:
                    break
                if boxes[j].intersects(rect):
                    clash = True
                    break
            if clash:
                self.stats["drop_overlap"] += 1
                continue
            kept.append(car)
            boxes.append(rect)
        return kept

    @staticmethod
    def _footprint(car: Car) -> BaseGeometry:
        rect = box(
            car.east - CAR_HALF_LENGTH,
            car.north - CAR_HALF_WIDTH,
            car.east + CAR_HALF_LENGTH,
            car.north + CAR_HALF_WIDTH,
        )
        return affinity.rotate(rect, car.heading, origin=(car.east, car.north), use_radians=True)
