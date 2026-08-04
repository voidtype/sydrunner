"""Timber power poles and the wires strung between them, per tile.

Spec section 7.2 calls this **the highest recognition-per-triangle feature in
the project**, and it is not an exaggeration. A Sydney inner-suburban street has
a line of hardwood poles down one side and four or five conductors sagging
between them, and nothing else in the built environment says *Australia* --
rather than "a generic western city" -- so cheaply. Europe buries its cables and
North America uses a different pole. Trees fixed the skyline, cars fixed the
gutter; this fixes the space in between, which is otherwise the emptiest part of
the frame.

Architecturally this is `parking.py` again, which is `vegetation.py` again: a
network built once for the whole run, per-tile emission, a binary sidecar, and
client-side instanced geometry streamed and disposed with the tile. Anything
that reads oddly here is worth checking against those two first.

**Where a pole goes.** Two sources, in priority order:

  a. Mapped `power=pole` nodes. Surveyed positions, used exactly as given and
     never moved. There are only 23 of them in the inner ring -- OSM's Australian
     power mapping is transmission-first and the LV distribution network is
     almost entirely unmapped -- so this source is a rounding error today and the
     right one to honour anyway.
  b. Procedural infill along residential-class ways, **one side only**, at 35-45 m.
     One side is not a simplification: a real Australian LV street run is single
     sided, with service drops crossing to the houses opposite. Poles on both
     kerbs is what an American street looks like, and it would also double the
     count for no recognition gain.

A way that carries *any* mapped pole gets no procedural infill at all -- see
`_build_poles_on_way`. Mixing the two puts an invented run alongside a surveyed
one and produces a double line, which is worse than either.

**Where the pole stands across the street.** `half_width + KERB_WIDTH +
KERB_SETBACK`: on the footpath, 0.4 m behind the kerb face, taken from
`streets.StreetNetwork` rather than re-derived on the same argument
`vegetation.py` and `parking.py` both make -- the kerb that was actually drawn is
the one the pole has to line up with. That puts it 0.6 m outside the street
tree line and 1.6 m outside the parked cars, which is the arithmetic the two
keep-outs below are sized against and the reason neither of them is the obvious
radius test.

**A tree moves a pole, it does not delete one.** The keep-outs shift the pole
along the street before giving up on it (`_place`), because a pole run is
*regular and continuous* and that continuity is the whole read. Dropping one
pole in a 40 m chain opens an 80 m gap, which breaks the chain (below) and
leaves a visible hole in the line. A real linesman moves the pole two metres and
so does this.

**Wires.** Poles along one way, ordered by distance along it, form a chain, and
consecutive poles get a span. A chain breaks at a gap over `MAX_SPAN` -- which,
at a 35-45 m pitch, means a chain breaks exactly where a pole could not be
placed at all. Since OSM splits a way at almost every junction, a chain is
naturally one block long and no span crosses an intersection. Carrying a line
*through* a corner needs ways joined end to end by name and class and is a
follow-up, named in the README rather than smuggled in here.

**A span belongs to the tile containing its midpoint**, and carries absolute
endpoints -- one of which is routinely outside that tile. Any other convention
loses spans at a seam: assigning by endpoint emits a cross-seam span twice or
not at all depending on which way the test rounds, and clipping at the tile
boundary would need the client to stitch two half-catenaries back into one curve.
The midpoint is unique, cheap, and the resulting geometry is at most half a span
(30 m) outside its tile's bounds, which is well inside the streamer's load
radius and its per-tile cull box.

Determinism is inherited whole: every position, height, kind and lean is a pure
function of the OSM id, the side and the nominal distance along the way -- never
of the tile, the iteration order or the run. Two tiles asking about the same
street get the same chain and each keeps its own half.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import pairwise

from shapely.geometry import LineString, Point, box
from shapely.geometry.base import BaseGeometry
from shapely.strtree import STRtree

from . import config, parking, streets, vegetation
from .sources import osm

# The same SplitMix64 the trees and the cars are placed with, imported rather
# than copied for the reason `parking.py` gives: two copies of a hash drift, and
# the determinism argument above rests on this being one function. The constants
# mixed in below keep this module's streams independent of the other two, so a
# pole and a car at the same place still make unrelated decisions.
from .vegetation import _hash, _osm_int, _unit

# --- Pole kinds ---------------------------------------------------------------
# The u8 written into the sidecar. APPEND ONLY -- the client keys its geometry
# table off these integers, exactly as it does for tree species and car bodies.

STANDARD = 0
TRANSFORMER = 1  # a pole-mounted distribution transformer on the upper shaft

KIND_COUNT = 2

KIND_NAME = {STANDARD: "standard", TRANSFORMER: "transformer"}

# How many poles carry a transformer. A pole-mount serves 10-20 houses, which at
# a 40 m pitch and ~4 houses a span is one pole in thirteen or so. Seven per cent
# is inside that and errs low: a transformer is a big grey lump at eye-catching
# height and too many of them turn a street into a substation.
TRANSFORMER_RATE = 0.07

# --- Where poles go -----------------------------------------------------------

# Classes that get a procedural run. This is the inner-suburban distribution
# network, so it is the streets people live on and nothing else.
#
# The exclusions matter more than the list. `secondary` and above carry their
# LV underground through the inner city and would put a pole line down Cleveland
# Street; `service` is laneways, driveways and car park aisles and is the most
# numerous class in the extent -- a pole every 40 m down every back lane is both
# wrong and, at that class's total length, the largest instance count in the
# build. Rear-lane poles are genuinely a Sydney thing and they are also
# genuinely *different* furniture, so they are a follow-up rather than a
# one-word addition here.
POLE_CLASSES = {"residential", "unclassified", "living_street", "tertiary"}

# No procedural poles within this of the ENU origin, metres.
#
# Sydney's CBD has no overhead distribution at all -- it was undergrounded
# before the war and the whole tower district is fed from basement substations
# -- so a pole line down Pitt Street is the same class of error as a
# right-hand-drive car, and it would stand in front of the one part of the city
# with real surveyed building heights. Left out, this module puts 46 poles in
# the tile containing Hunter, Bligh, Castlereagh and Phillip Streets, because
# OSM tags most of the CBD grid `unclassified` and `tertiary`.
#
# The real boundary is Ausgrid's undergrounding footprint, which is a polygon
# nobody publishes, and a circle centred on Town Hall is the stand-in. 1,300 m
# is set from both sides: it reaches Circular Quay (1.25 km) and Central
# (1.30 km), which is the extent of the undergrounded core, and it stops short
# of Surry Hills, Darlinghurst, Chippendale and Redfern -- which are the most
# pole-lined suburbs in the city and exactly what spec 7.2's "inner-suburban
# streets" means. What it costs is the northern tip of Surry Hills and
# Woolloomooloo, both of which do have overhead in life. What it must never do
# is grow to `vegetation.CBD_RADIUS`: at 1,500 m it starts eating the suburbs
# this feature exists for.
#
# A *surveyed* pole inside the radius is still emitted. If someone has mapped a
# `power=pole` node on Kent Street then there is a pole on Kent Street, and this
# module is not in a position to argue.
CBD_RADIUS = 1300.0

# Nominal pitch along the kerb, and the jitter either side of it, so a run comes
# out at 35-45 m and never reads as a measured interval. The spec says "~40 m"
# and a real Sydney LV span is 30-50 m depending on when the street was built.
SPACING = 40.0
SPACING_JITTER = 5.0

# How far behind the kerb *face* the pole stands. The kerb face is at
# `half_width` and its exposed top runs to `half_width + KERB_WIDTH`, so this
# puts the pole 0.4 m onto the footpath -- outside the carriageway, hard against
# the kerb line, which is where it is in life and is also the only place it can
# be without standing in the parking bays.
KERB_SETBACK = 0.4

# Pole height, metres, drawn per pole. A Sydney LV pole is 9.5-11.5 m out of the
# ground with about 1.8 m more buried, and the variation is real rather than
# decorative: a run of identical heights over undulating ground is one of the
# two things that make a procedural pole line read as procedural. (The other is
# dead-vertical lean, which the client handles from `tilt_seed`.)
HEIGHT_MIN = 9.5
HEIGHT_MAX = 11.5

# The height the client builds its pole geometry at, before scaling each
# instance by `height / NOMINAL_HEIGHT`.
#
# **This constant and `CROSSARM_BELOW_TOP` must match `client/src/world/power.ts`.**
# They are what makes a wire end exactly on a crossarm rather than 5 cm off it:
# the client scales the whole pole in Y, so the crossarm on a 9.5 m pole lands at
# `9.5 * (1 - 0.55/10.5)` above the ground and not at `9.5 - 0.55`. The
# attachment height below is written with that same factor in it, so the two
# cannot disagree. See `wire_attachment_y`.
NOMINAL_HEIGHT = 10.5
CROSSARM_BELOW_TOP = 0.55

# The conductor ties off this far under the crossarm: the length of the
# insulator stub hanging from the arm's underside, which the client draws. The
# catenary sags *further* below this, so it is the reference height the sag is
# measured down from and not the lowest point of the wire.
WIRE_BELOW_CROSSARM = 0.3

# The longest gap two consecutive poles may have and still be wired together.
# At a 35-45 m pitch this fires only where a pole was skipped entirely, which is
# what it is for: a 90 m span reaching over a missing pole would sag through the
# roof of the house it passes.
MAX_SPAN = 60.0

# Carriageway half-width below which no poles are placed. Under this the OSM
# `width` tag is describing a lane, not a street, and the footpath the pole
# would stand on does not exist.
MIN_HALF_WIDTH = 2.0

# A way shorter than this gets nothing: two junction keep-outs plus one span is
# the minimum that produces a *line* rather than a lone pole.
MIN_WAY_LENGTH = 2.0 * 8.0 + SPACING - SPACING_JITTER

# --- Keep-outs ----------------------------------------------------------------

# No pole within this of a junction. Sight lines, corner splays and the fact
# that a real corner pole is a stay-wired termination rather than a straight
# intermediate -- which is different furniture and is not modelled. Measured
# from the junction *node* on the cross street's centreline, exactly as
# `vegetation.CLEAR_OF_JUNCTION` and `parking.CLEAR_OF_JUNCTION` are.
CLEAR_OF_JUNCTION = 8.0

# Clearance from a tree trunk, measured centre to centre.
#
# Unlike the car test below this one has teeth, and the arithmetic says why
# before anything renders: a street tree stands at `half_width + KERB_WIDTH +
# vegetation.VERGE_OFFSET` and a pole at `half_width + KERB_WIDTH +
# KERB_SETBACK`, so the two are 0.6 m apart *across* the footpath by
# construction. The test is therefore almost entirely about how close they are
# *along* the street, and at 2.0 m it fires whenever a trunk is within 1.9 m of
# the pole's nominal position -- roughly one candidate in four on a well-planted
# street, since trees run at 12-18 m and poles at 35-45 m.
#
# Which is exactly why `_place` shifts before it drops. One pole in four deleted
# would break one chain in four.
CLEAR_OF_TREE = 2.0

# Clearance from a parked car's *body*, not its centre.
#
# The obvious test -- no pole within 1.5 m of a car -- is a no-op, and it is
# worth writing down that it is, because it would sit here for years looking
# like a safety check. A pole is at `half_width + 0.55` and a car's centreline
# at `half_width - 1.05`, so a pole is **always** at least 1.60 m from any car
# on its own kerb and further from one on the other; no radius under 1.6 can
# ever fire and any radius over it deletes every pole on every parked street.
#
# What is actually wanted is that the pole is not standing *in* a car, so this
# is the oriented-box test `parking._clear_of_trunks` uses for the mirror-image
# problem: the pole is transformed into the car's own frame and checked against
# its half-extents plus this. 0.5 m leaves the normal geometry 0.2 m of margin
# (1.60 - 0.9 - 0.5) and still catches the cases that are real -- a bay on the
# far kerb of a street narrow enough for the two to meet, a way mapped twice, a
# slip lane that was never tagged as one.
CLEAR_OF_CAR = 0.5

# Clearance from a building footprint. Small, because a pole against a shopfront
# is normal in this city -- there are hundreds of them on Crown Street. This
# only catches the case where the road width is overstated enough to put the
# footpath inside a wall.
CLEAR_OF_BUILDING = 0.7

# How far along the street `_place` may shift a pole to clear an obstruction,
# and the steps it tries, in order. Symmetric and ordered nearest-first so the
# run stays as close to its nominal pitch as the street allows.
SHIFT_STEPS: tuple[float, ...] = (0.0, 2.0, -2.0, 4.0, -4.0)

# How far off a centreline a mapped `power=pole` node may be and still be treated
# as belonging to that way -- which is what puts it in a chain. Generous,
# because a surveyed pole is digitised from imagery and lands anywhere across
# the nature strip, and because the alternative to a slightly wrong chain is no
# chain at all.
MAPPED_CORRIDOR = 6.0
MAPPED_CORRIDOR_MAX = 18.0

# --- Budget -------------------------------------------------------------------

# Per-tile ceiling. The inner ring's busiest tile lands at a fraction of this;
# it is here for the reason `MAX_TREES_PER_TILE` and `MAX_CARS_PER_TILE` are,
# which is that a silent 900-instance tile is a frame spike nobody would
# attribute to this file.
#
#
# It is set well clear of the measured distribution rather than near it, and the
# reason is that the cap and the span ownership rule interact badly: a pole
# dropped here can leave a span in a *neighbouring* tile with nothing at one end,
# because that tile owns the span and knows nothing about this tile's budget.
# The inner ring measures p50 37, p90 71, max 110 -- a terrace grid in Paddington
# or Surry Hills carries twice the street length per square kilometre of anywhere
# else -- so a ceiling of 80 clipped 172 poles off the top, and this one does not
# fire at all. The build warns if it ever does.
MAX_POLES_PER_TILE = 160

# Ways within this of a tile's bounds can put a pole or a span midpoint inside
# it. Must exceed half the longest span plus the widest offset any way produces
# -- 30 + 20.55 -- because a span whose midpoint lands in this tile can be
# generated from a centreline that far outside it.
SELECT_MARGIN = 60.0


@dataclass
class Pole:
    """One pole, in ENU metres. Tile-local conversion happens at write time."""

    east: float
    north: float
    # Terrain height at the pole's foot, metres above the datum. Sampled here so
    # the client does not repeat the lookup -- it has the tile's height grid, but
    # a pole is one of the few things placed *before* that grid is interpolated
    # and the sidecar is four bytes cheaper than the code to do it twice.
    ground_y: float
    height: float
    kind: int
    # Drives the client's up-to-1.5-degree lean. A dead-vertical run reads as CAD.
    tilt_seed: int
    # 'mapped' | 'street'. Carried so the build can report the split rather than
    # a single number that hides which source did the work.
    origin: str = "street"


@dataclass
class Span:
    """One wire run between two pole tops, in ENU metres with absolute y.

    Both endpoints are absolute: a span is emitted once, into the tile holding
    its midpoint, and one of its ends is routinely in the tile next door.
    """

    a_east: float
    a_north: float
    a_y: float
    b_east: float
    b_north: float
    b_y: float

    @property
    def mid_east(self) -> float:
        return 0.5 * (self.a_east + self.b_east)

    @property
    def mid_north(self) -> float:
        return 0.5 * (self.a_north + self.b_north)

    @property
    def length(self) -> float:
        return math.hypot(self.b_east - self.a_east, self.b_north - self.a_north)


@dataclass
class TilePower:
    """One tile's share of the network."""

    poles: list[Pole] = field(default_factory=list)
    spans: list[Span] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.poles and not self.spans


def wire_attachment_y(ground_y: float, height: float) -> float:
    """Absolute y a conductor is tied off at, on a pole of `height`.

    The one piece of arithmetic this module shares with the client, so it is one
    function rather than an expression written out twice in two languages.

    The subtlety is the scale. The client builds *one* pole geometry at
    `NOMINAL_HEIGHT`, with the crossarm `CROSSARM_BELOW_TOP` under the top and
    the insulator stub `WIRE_BELOW_CROSSARM` under that, and scales each instance
    in Y by `height / NOMINAL_HEIGHT`. So the tie-off on a 9.5 m pole is at
    `9.5 * (1 - 0.85/10.5)` above the ground and **not** at `9.5 - 0.85`: the
    obvious subtraction is wrong by 3 cm on a short pole and 3 cm the other way
    on a tall one, which is the width of the conductor. Writing it as one factor
    makes the two ends agree exactly instead of nearly.

    The lean does not enter into it, and that is by construction: the client
    tilts each pole about *this* height rather than about its foot, so a leaning
    pole moves its base by 20 cm -- where nothing marks where the base was
    supposed to be -- and holds its crossarm exactly where the wire expects it.
    """
    return ground_y + height * (
        1.0 - (CROSSARM_BELOW_TOP + WIRE_BELOW_CROSSARM) / NOMINAL_HEIGHT
    )


class PowerNetwork:
    """Every pole and every span in the extent, indexed for tile queries.

    Built once per run, like `StreetNetwork`, `VegetationNetwork` and
    `ParkingNetwork`, and for the same reason: a way is asked about by every tile
    it touches, and walking it -- which here means a terrain sample and four
    spatial queries per candidate -- is far more expensive than the lookup.
    """

    def __init__(
        self,
        street_network: streets.StreetNetwork,
        veg_network: vegetation.VegetationNetwork,
        parking_network: parking.ParkingNetwork,
        mapped: list[osm.OsmPoi],
        terrain=None,
    ) -> None:
        self._streets = street_network
        self._veg = veg_network
        self._parking = parking_network
        self._terrain = terrain
        self._pole_cache: dict[int, list[Pole]] = {}
        self._span_cache: dict[int, list[Span]] = {}

        # Junction proxies: the end points of every street-class way. Built the
        # same way the other two modules build theirs, with the same caveat --
        # OSM splits a way at a junction almost without exception, so the ends
        # are where the corners are, and it over-reports because a way also
        # splits where the name or the speed limit changes. Over-reporting costs
        # a shifted pole; under-reporting puts one in a corner splay.
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

        self.stats: dict[str, int] = {
            "mapped_nodes": len(mapped),
            "mapped_on_way": 0,
            "mapped_orphan": 0,
            "ways_mapped": 0,
            "ways_considered": 0,
            "ways_cbd": 0,
            "ways_poled": 0,
            "candidates": 0,
            "placed": 0,
            "shifted": 0,
            "drop_junction": 0,
            "drop_tree": 0,
            "drop_car": 0,
            "drop_building": 0,
            "drop_cap": 0,
            "chains": 0,
            "chain_breaks": 0,
            "spans": 0,
        }

        # Mapped nodes, assigned to the way they run beside. Done once here
        # rather than per way, because the assignment is a nearest-way search and
        # a way must be able to ask "do I own any of these?" in constant time --
        # that question is what suppresses its procedural infill.
        self._mapped_by_way: dict[int, list[tuple[float, osm.OsmPoi]]] = {}
        self._orphans_by_tile: dict[str, list[Pole]] = {}
        self._assign_mapped(mapped)

        # Tallied over the poles actually *emitted*, so the reported split
        # describes what is in the world rather than what was proposed.
        # Accumulated in `instances`, which the build calls exactly once per tile.
        self.emitted_poles = 0
        self.emitted_spans = 0
        self.emitted_transformers = 0
        self.emitted_mapped = 0
        self.span_length_total = 0.0
        self.span_length_max = 0.0

    # --- Mapped nodes ---------------------------------------------------------

    def _assign_mapped(self, mapped: list[osm.OsmPoi]) -> None:
        """Attach each surveyed pole to the way it stands beside.

        A pole with no way within reach is kept as an *orphan*: it is still a
        real surveyed object and is still emitted, it simply has nothing to be
        chained to. Orphans are bucketed by tile here rather than searched for
        later, because they have no way for `ways_near` to find them by.
        """
        for poi in mapped:
            p = Point(poi.east, poi.north)
            best: tuple[float, int] | None = None
            for i in self._streets.ways_near(p.buffer(MAPPED_CORRIDOR_MAX)):
                road = self._streets.roads[i]
                if road.is_foot:
                    continue
                line = self._streets.centreline(i)
                d = line.distance(p)
                # A pole belongs to the way whose *kerb* it is nearest, not the
                # way whose centreline it is nearest: a node beside a 20 m
                # arterial is 10 m from that centreline and might be 9 m from a
                # laneway's, and it is the arterial's pole.
                reach = self._streets.half_width(i) + streets.KERB_WIDTH + MAPPED_CORRIDOR
                if d > min(reach, MAPPED_CORRIDOR_MAX):
                    continue
                edge = d - self._streets.half_width(i)
                if best is None or edge < best[0]:
                    best = (edge, i)
            if best is None:
                self.stats["mapped_orphan"] += 1
                pole = self._make_pole(
                    poi.east, poi.north, _hash(_osm_int(poi.osm_id), 0x50E), origin="mapped"
                )
                key = _tile_key_of(poi.east, poi.north)
                self._orphans_by_tile.setdefault(key, []).append(pole)
                continue
            self.stats["mapped_on_way"] += 1
            i = best[1]
            s = self._streets.centreline(i).project(Point(poi.east, poi.north))
            self._mapped_by_way.setdefault(i, []).append((s, poi))
        self.stats["ways_mapped"] = len(self._mapped_by_way)

    # --- Tile coverage --------------------------------------------------------

    def tile_keys(self) -> set[str]:
        """Tiles that an orphan mapped pole puts something into.

        Deliberately *not* every tile this module can reach: a tile with a street
        in it is already in `streets.tile_keys()`, and a tile with nothing but a
        surveyed pole in it is the one case nothing else in the build would
        emit.
        """
        return set(self._orphans_by_tile)

    def poles_near(self, region: BaseGeometry) -> list[Pole]:
        """Every pole standing near `region`, from both sources.

        Exposed for `furniture.py`, which has to know where the poles are before
        it can decide a stretch of kerb is free for a wheelie bin -- and which
        cannot ask per tile: a pole a metre over a tile line still stands in a
        bin cluster on the other side of it.

        Deliberately *not* the per-tile answer, on exactly the argument
        `vegetation.trees_near` makes for the mirror case. It skips the per-tile
        cap, so it can return a pole that `instances` will go on to drop. That is
        the conservative direction for a keep-out and it is also the stable one:
        a bin's fate must not depend on how crowded the tile it happens to sit in
        turned out to be.
        """
        out: list[Pole] = []
        for i in self._streets.ways_near(region):
            out.extend(self._poles_on_way(i))
        # The orphans are bucketed by tile rather than by way, so they are the one
        # source `ways_near` cannot reach. Three tiles covers any region a
        # keep-out asks about -- but rather than reason about that, take the
        # bounds and walk every tile they touch.
        e0, n0, e1, n1 = region.bounds
        s = config.TILE_SIZE
        for tx in range(math.floor(e0 / s), math.floor(e1 / s) + 1):
            for tz in range(math.floor(n0 / s), math.floor(n1 / s) + 1):
                out.extend(self._orphans_by_tile.get(f"{tx}_{tz}", ()))
        return out

    def instances(self, tile_key: str) -> TilePower:
        """Every pole standing inside one tile, and every span it owns."""
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        region = box(e0, n0, e1, n1).buffer(SELECT_MARGIN)

        def inside(east: float, north: float) -> bool:
            # Half-open on the upper edge, so an object exactly on a tile line
            # lands in one tile and not in both.
            return e0 <= east < e1 and n0 <= north < n1

        poles: list[Pole] = []
        spans: list[Span] = []
        for i in self._streets.ways_near(region):
            poles.extend(p for p in self._poles_on_way(i) if inside(p.east, p.north))
            spans.extend(s for s in self._spans_on_way(i) if inside(s.mid_east, s.mid_north))
        poles.extend(self._orphans_by_tile.get(tile_key, []))

        # Ordered before anything greedy runs over it, so the cap below cannot
        # depend on which way `ways_near` happened to return first.
        poles.sort(key=lambda p: (p.east, p.north))
        spans.sort(key=lambda s: (s.mid_east, s.mid_north))
        poles = self._cap(poles)

        out = TilePower(poles, spans)
        self._tally(out)
        return out

    def _cap(self, poles: list[Pole]) -> list[Pole]:
        """Hold a tile under `MAX_POLES_PER_TILE`, surveyed poles first."""
        if len(poles) <= MAX_POLES_PER_TILE:
            return poles
        self.stats["drop_cap"] += len(poles) - MAX_POLES_PER_TILE
        mapped = [p for p in poles if p.origin == "mapped"]
        street = [p for p in poles if p.origin != "mapped"]
        keep = max(MAX_POLES_PER_TILE - len(mapped), 0)
        # Thinned by hashed rank rather than by list order, so a tile over budget
        # loses an even spread rather than one corner of itself.
        return mapped + sorted(street, key=lambda p: p.tilt_seed)[:keep]

    def _tally(self, out: TilePower) -> None:
        self.emitted_poles += len(out.poles)
        self.emitted_spans += len(out.spans)
        for p in out.poles:
            if p.kind == TRANSFORMER:
                self.emitted_transformers += 1
            if p.origin == "mapped":
                self.emitted_mapped += 1
        for s in out.spans:
            length = s.length
            self.span_length_total += length
            self.span_length_max = max(self.span_length_max, length)

    # --- Per-way generation ---------------------------------------------------

    def _poles_on_way(self, i: int) -> list[Pole]:
        cached = self._pole_cache.get(i)
        if cached is not None:
            return cached
        out = self._build_poles_on_way(i)
        self._pole_cache[i] = out
        return out

    def _build_poles_on_way(self, i: int) -> list[Pole]:
        """Every pole along one way, ordered by distance along it.

        Order is not cosmetic here the way it is in the other two modules: it is
        what makes `_spans_on_way` a walk over consecutive pairs rather than a
        sort of its own.
        """
        mapped = self._mapped_by_way.get(i)
        if mapped:
            # Mapped wins wholesale. A surveyed run and an invented one threaded
            # between it is a double line, and there is no rule that reliably
            # separates "this half of the street is mapped" from "these two nodes
            # are all anyone got around to".
            return [
                self._make_pole(
                    poi.east, poi.north, _hash(_osm_int(poi.osm_id), 0x50E), origin="mapped"
                )
                for _, poi in sorted(mapped, key=lambda sp: sp[0])
            ]

        road = self._streets.roads[i]
        # A bridge carries its services in the deck, not on poles beside it -- and
        # since `decks.py` took the bridge ways off the ground, a pole here would
        # stand on whatever the viaduct flies over. See `streets.DECK_EDGE`.
        if road.is_foot or road.bridge or road.highway not in POLE_CLASSES:
            return []
        self.stats["ways_considered"] += 1

        line = self._streets.centreline(i)
        length = line.length
        if length < MIN_WAY_LENGTH:
            return []
        # Tested at the way's centroid rather than per pole, so a street on the
        # boundary is either poled or not rather than half of each -- a run that
        # stops in the middle of a block reads as a bug, where a street with no
        # poles at all reads as a street with underground power, which is what it
        # is. See `CBD_RADIUS`.
        c = line.centroid
        if c.x * c.x + c.y * c.y <= CBD_RADIUS * CBD_RADIUS:
            self.stats["ways_cbd"] += 1
            return []
        half = self._streets.half_width(i)
        if half < MIN_HALF_WIDTH:
            return []

        way_id = _osm_int(road.osm_id)
        # One side, chosen by the way's own id. Always-left would put every pole
        # line in the suburb on the same side of every street, which reads as a
        # rule rather than as a network; the real choice was made block by block
        # by whichever side had fewer driveways in 1925.
        side = 1 if _unit(_hash(way_id, 0x50E5), 0) < 0.5 else -1
        offset = (half + streets.KERB_WIDTH + KERB_SETBACK) * side

        out: list[Pole] = []
        # Start a junction keep-out in from the end, plus a hashed phase, so a
        # street does not always begin with a pole at exactly 8 m and two
        # adjacent blocks do not line their first poles up across the corner.
        s = CLEAR_OF_JUNCTION + _unit(_hash(way_id, 0x9017), 1) * SPACING * 0.5
        while s < length - CLEAR_OF_JUNCTION:
            h = _hash(way_id, side, int(s * 100.0), 0x504E)
            self.stats["candidates"] += 1
            pole = self._place(line, s, offset, h)
            if pole is not None:
                out.append(pole)
            s += SPACING + (_unit(h, 3) - 0.5) * 2.0 * SPACING_JITTER
        if out:
            self.stats["ways_poled"] += 1
        return out

    def _place(self, line: LineString, s: float, offset: float, h: int) -> Pole | None:
        """One pole at `s` along the way, shifted along it if something is there.

        The shift is the point. Every draw that gives the pole its identity --
        height, kind, lean -- comes off `h`, which is hashed from the *nominal*
        distance, so a pole that moves two metres to miss a tree is the same pole
        rather than a different one, and the run keeps its pitch. Only when the
        whole `SHIFT_STEPS` window is blocked is a pole given up on, which is
        rare enough that the resulting chain break is nearly always a real
        obstruction rather than an unlucky sample.
        """
        # The reason reported is the *first* one encountered, which is the one
        # that stopped the nominal position; the shifted attempts are only ever
        # asking whether it could have been saved, and reporting the last of
        # them would blame whichever obstruction happened to be four metres away.
        reason: str | None = None
        for k, delta in enumerate(SHIFT_STEPS):
            pos = _offset_point(line, s + delta, offset)
            if pos is None:
                continue
            east, north = pos
            blocked = self._blocked_at(east, north)
            if blocked is None:
                if k:
                    self.stats["shifted"] += 1
                self.stats["placed"] += 1
                return self._make_pole(east, north, h)
            if reason is None:
                reason = blocked
        # `None` only when every shift ran off the end of the way, which the
        # `CLEAR_OF_JUNCTION` inset makes nearly impossible; a junction is the
        # honest thing to call it.
        self.stats[reason or "drop_junction"] += 1
        return None

    def _blocked_at(self, east: float, north: float) -> str | None:
        """The first keep-out this position fails, or `None` if it is clear.

        Ordered cheapest first, and the two exact tests -- the oriented box
        against a car and the polygon distance to a wall -- run last so they run
        least.
        """
        p = Point(east, north)
        if self._junctions is not None and len(self._junctions.query(p.buffer(CLEAR_OF_JUNCTION))):
            return "drop_junction"
        for t in self._veg.trees_near(p.buffer(CLEAR_OF_TREE)):
            if (t.east - east) ** 2 + (t.north - north) ** 2 < CLEAR_OF_TREE**2:
                return "drop_tree"
        if not self._clear_of_cars(east, north):
            return "drop_car"
        for poly in self._streets.buildings_near(p.buffer(CLEAR_OF_BUILDING)):
            if poly.distance(p) < CLEAR_OF_BUILDING:
                return "drop_building"
        return None

    def _clear_of_cars(self, east: float, north: float) -> bool:
        """Is this position outside every parked car's footprint?

        See `CLEAR_OF_CAR` for why this is the oriented box and not a radius.
        Cars are taken from the per-*way* generation rather than the per-tile
        answer, on exactly the argument `vegetation.trees_near` makes for the
        mirror case: the per-tile answer applies filters and a cap that depend on
        how crowded a tile turned out to be, and a pole's fate must not.
        """
        reach = parking.CAR_HALF_LENGTH + CLEAR_OF_CAR
        for car in self._parking.cars_near(Point(east, north).buffer(reach)):
            c, sn = math.cos(car.heading), math.sin(car.heading)
            de, dn = east - car.east, north - car.north
            along = de * c + dn * sn
            across = -de * sn + dn * c
            if abs(along) < reach and abs(across) < parking.CAR_HALF_WIDTH + CLEAR_OF_CAR:
                return False
        return True

    def _make_pole(self, east: float, north: float, h: int, origin: str = "street") -> Pole:
        ground = 0.0 if self._terrain is None else float(self._terrain.sample(east, north))
        return Pole(
            east=east,
            north=north,
            ground_y=ground,
            height=HEIGHT_MIN + (HEIGHT_MAX - HEIGHT_MIN) * _unit(h, 4),
            kind=TRANSFORMER if _unit(h, 5) < TRANSFORMER_RATE else STANDARD,
            tilt_seed=h & 0xFF,
            origin=origin,
        )

    # --- Chains ---------------------------------------------------------------

    def _spans_on_way(self, i: int) -> list[Span]:
        cached = self._span_cache.get(i)
        if cached is not None:
            return cached
        out = self._build_spans_on_way(i)
        self._span_cache[i] = out
        return out

    def _build_spans_on_way(self, i: int) -> list[Span]:
        """Wire consecutive poles along one way together.

        One span line per pole pair, carrying two visual conductors that the
        client derives -- see `tiles.write_power`. Emitting one line rather than
        two halves the sidecar and, more usefully, means the two strands cannot
        drift apart in the data.
        """
        poles = self._poles_on_way(i)
        if len(poles) < 2:
            return []
        out: list[Span] = []
        chains = 1
        for a, b in pairwise(poles):
            gap = math.hypot(b.east - a.east, b.north - a.north)
            if gap > MAX_SPAN:
                self.stats["chain_breaks"] += 1
                chains += 1
                continue
            out.append(
                Span(
                    a_east=a.east,
                    a_north=a.north,
                    a_y=wire_attachment_y(a.ground_y, a.height),
                    b_east=b.east,
                    b_north=b.north,
                    b_y=wire_attachment_y(b.ground_y, b.height),
                )
            )
        if out:
            self.stats["chains"] += chains
            self.stats["spans"] += len(out)
        return out


# --- Helpers ------------------------------------------------------------------


def _offset_point(line: LineString, s: float, offset: float) -> tuple[float, float] | None:
    """A point `offset` metres to the left of the way at distance `s`.

    Left of travel for a positive offset, matching the winding convention
    `streets._emit_kerb_face` reads its normals off and `vegetation._verge_point`
    and `parking._bay_point` both share, so no two modules in this pipeline
    disagree about which side of a street they are on.
    """
    if s < 0.0 or s > line.length:
        return None
    a = line.interpolate(max(s - 0.5, 0.0))
    b = line.interpolate(min(s + 0.5, line.length))
    dx, dy = b.x - a.x, b.y - a.y
    n = math.hypot(dx, dy)
    if n < 1e-6:
        return None
    c = line.interpolate(s)
    return (c.x - dy / n * offset, c.y + dx / n * offset)


def _tile_key_of(east: float, north: float) -> str:
    s = config.TILE_SIZE
    return f"{math.floor(east / s)}_{math.floor(north / s)}"


def load_mapped_poles(radius_m: float) -> list[osm.OsmPoi]:
    """Every surveyed `power=pole` node in the extent.

    `osm.read_pois` already extracts them -- the tag has been recognised since
    the POI reader was written for spec 7.2 -- so this is a filter and not a new
    source.
    """
    return [p for p in osm.read_pois(radius_m) if p.kind == "pole"]
