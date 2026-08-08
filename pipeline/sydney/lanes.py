"""Living traffic: the lane graph, and the timetable the cars run to.

The user asked to "make the cars drive around and knock u over". This module is
the offline half of that. It emits one sidecar per tile -- `<key>.lanes.bin` --
and everything the client and the Bun server need to put moving cars in the
streets is in it. **Nothing about a moving car is ever on the wire.**

---------------------------------------------------------------------------
WHY THE SCHEDULE IS BAKED RATHER THAN SIMULATED.

Sixteen players share one city. If traffic were simulated -- cars with velocity,
integrated per tick -- then either the server owns it and pays for it on the
wire (a few hundred moving cars at any useful density is more bandwidth than
the whole player protocol), or each client owns its own and no two players see
the same street.

So a car is not a thing that is stepped. A car is a **lookup**:

    position(tick) = the point on route R at the time (tick - departure)

Every quantity in that expression is in this file's output. The routes, the
speed profile along them, the departure headway and the phase all travel in the
sidecar the client already streams and the server already reads at boot. Two
processes that have read the same bytes and are given the same tick produce the
same answer with no history, no state to synchronise and no drift -- which is
also what makes a car's hit on a player predictable on the client and
authoritative on the server without a single new byte in `net/protocol.ts`.

---------------------------------------------------------------------------
THE ONE IDEA THAT MAKES THE RUNTIME CHEAP: BAKE **TIME**, NOT DISTANCE.

The obvious form is a polyline with cumulative *arc length* and a speed profile,
which makes `position(t)` an integral and a search. Instead every route vertex
carries the **cumulative time to reach it**, seconds from the route's start,
with the speed caps, the corner slowdowns and the traffic-light dwells already
folded in. Then:

    find i with T[i] <= t < T[i+1]        (binary search over a sorted f32 run)
    u = (t - T[i]) / (T[i+1] - T[i])      (one divide)
    p = P[i] + u * (P[i+1] - P[i])        (three lerps)

No square roots, no trigonometry, no integration -- which is not a performance
argument but a *determinism* one. `game/footy.ts`'s header sets the rule this
follows: `Math.sin`, `Math.cos`, `Math.pow` and `Math.hypot` are all
implementation-defined in ECMAScript and V8 and JavaScriptCore genuinely differ
in the last place. A lookup made of subtract, divide, multiply and add is exact
on both, so the browser and the Bun server agree bit for bit about where every
car in Sydney is. A dwell at a red light is not a state machine either; it is
simply two vertices at the same point with three seconds between their `T`s.

---------------------------------------------------------------------------
ROUTES PARTITION THE LANE GRAPH. THEY DO NOT SAMPLE IT.

Cars do not collide with each other -- they are trams on rails, conceptually,
and that is deliberate: the feature the user asked for is *being run over*, not
traffic physics. But two cars occupying the same three metres of Pitt Street
looks like a bug even if nothing depends on it, so the geometry rules it out
rather than the simulation.

`_trails` walks the directed lane graph and consumes each directed edge exactly
once. Every route is edge-disjoint from every other, so no two routes ever share
a lane; and within one route, cars depart at a headway strictly greater than the
longest dwell on it, which is exactly the condition for two cars on the same
timetable never to coincide (they can only meet where the timetable is
*constant*, and a dwell shorter than the headway is too short to be caught in).
Between those two the whole city is collision-free by construction and no
runtime check exists at all.

---------------------------------------------------------------------------
LEFT-HAND TRAFFIC, WHICH IS THE ONE THING WORTH STATING IN AXES.

This is Australia. A car drives on the **left of its direction of travel**.

In the ENU frame this module works in, the left of a heading `d` is
`(-d_north, d_east)`. In the renderer's axes -- x east, z south -- that same
vector is `(d_z, -d_x)`, and the client's `verifyTraffic` asserts exactly that
sign against a synthetic north-running way: a car heading north must be offset
to the **west**. Getting it backwards produces a city where every car is in the
oncoming lane, which is both instantly recognisable to anybody who has been to
Sydney and completely invisible to a test that only checks that cars are on
roads.

---------------------------------------------------------------------------
THE SIDECAR IS DESIGNED FOR THE PASS AFTER THIS ONE.

`<key>.lanes.bin` carries two blocks, and only the second is about cars.

The **ways block** is the drivable street network as geometry: per way-span, a
polyline with the solved elevation on it, the kerb-to-kerb half width, the
footpath band width beside it, the class and the one-way flag. Nothing in the
traffic runtime reads it. It is there because a footpath is
`centreline +/- (halfCarriageway + KERB_WIDTH + footpathWidth/2)`, and a
pedestrians pass that wants people walking the footpaths should be able to
derive its paths from a file that already exists rather than adding a second
pipeline traversal of the same OSM ways with a second set of width constants
that can disagree with `streets.py`. The widths written here are read out of
`streets.py` at emit time for that reason -- they are the same numbers that
decided where the asphalt and the concrete were actually drawn.

The **routes block** is the traffic timetable described above.

---------------------------------------------------------------------------
HEIGHT: THREE SOURCES, ONE RULE.

A lane vertex's y must sit on the asphalt the player is standing on to within a
few centimetres, and the asphalt has three different authors:

  * **Ground streets** are draped on the conformed terrain, so the height is
    `terrain.sample(...) + streets.CARRIAGEWAY_Y`. The terrain has already been
    pulled onto `roadgrade.py`'s solved street profile, so this *is* the solved
    elevation -- reading it back off the lattice rather than out of the solve is
    what guarantees the number matches the triangles that were emitted.
  * **Generic bridges** are `decks.py`'s elevated ribbons, and their running
    surface is `DeckRun.deck_y` at the nearest station. A ground sample there
    would put the car in the water under the Anzac Bridge.
  * **The Harbour Bridge** is the hero model and was deliberately clipped out of
    the generic deck pass, so it has no `DeckRun` at all. `HeroDeck` rebuilds
    its profile from the same three constants `landmarks.build_bridge` uses --
    the pylon frame, the 49 m AHD deck and the 5.5% approach ramps -- so traffic
    runs over the real bridge at the real deck height. See `HeroDeck`.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import Point, Polygon
from shapely.prepared import prep

from . import bays, geo, streets
from .sources import osm

# --- What carries traffic -----------------------------------------------------

# Classes a scheduled car will drive. `service` is deliberately absent: it is
# 3,960 ways of driveway, loading dock and car-park aisle, and a car nosing out
# of a Woolworths service lane at 40 km/h is the one place this feature would
# read as a bug rather than as a city. Footways and cycleways are absent for the
# obvious reason. Both still appear in the *ways* block -- see the header.
DRIVABLE = {
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "residential", "unclassified", "living_street",
}

# Free-flow speed by class, metres per second. Australian urban defaults: 50
# km/h is the residential signed limit and 13.9 m/s is 50 km/h, but a
# residential street with parked cars either side is not driven at the sign, so
# the smaller classes run under it. Motorway decks get 80 km/h, which is what
# the Cahill and the Western Distributor are posted at.
FREE_SPEED = {
    "motorway": 22.2, "motorway_link": 16.7,
    "trunk": 16.7, "trunk_link": 13.9,
    "primary": 15.3, "primary_link": 11.1,
    "secondary": 13.9, "secondary_link": 11.1,
    "tertiary": 13.6, "tertiary_link": 11.1,
    "residential": 11.1, "unclassified": 11.1, "living_street": 5.6,
}
FREE_SPEED_DEFAULT = 11.1

# Departure headway by class, seconds -- how often a new car sets off along a
# route. This is the density dial, and it is per class because an arterial and a
# back street do not carry the same traffic. Every route also raises its own
# headway above its longest dwell; see `_headway`.
HEADWAY = {
    "motorway": 5.0, "motorway_link": 8.0,
    "trunk": 6.5, "trunk_link": 9.0,
    "primary": 7.0, "primary_link": 10.0,
    "secondary": 9.0, "secondary_link": 11.0,
    "tertiary": 12.0, "tertiary_link": 14.0,
    "residential": 20.0, "unclassified": 18.0, "living_street": 28.0,
}
HEADWAY_DEFAULT = 18.0

# Share of routes kept, by class. The back streets of Surry Hills do not carry a
# car every seventeen seconds all day, and thinning by *route* rather than by
# raising the headway further is what keeps the streets that do have traffic
# looking busy while the ones that do not look empty -- which is what a suburb
# actually looks like. Hashed per route, so it is stable across builds.
KEEP_SHARE = {
    "residential": 0.55,
    "unclassified": 0.6,
    "living_street": 0.4,
    "tertiary": 0.85,
    "tertiary_link": 0.85,
}
KEEP_SHARE_DEFAULT = 1.0

# --- Lane geometry ------------------------------------------------------------

# How far left of the centreline a car drives, as a fraction of the carriageway
# width, on a two-way street. A quarter of the width is the centre of the
# nearside lane by definition, and it is the number that puts a 1.8 m car in a
# 7.5 m residential street with 1.1 m either side of it.
LANE_FRACTION = 0.25

# Bounds on that offset. The floor stops a 3 m laneway putting its car half on
# the footpath; the ceiling stops a mis-tagged 40 m "width" putting one in the
# next block. Both are in metres from the centreline.
LANE_OFFSET_MIN = 1.5
LANE_OFFSET_MAX = 5.0

# A one-way carriageway narrower than this is driven down the middle -- which is
# what people do in a one-way lane, and what stops the car hugging a kerb that
# is 1.2 m away.
ONEWAY_CENTRE_WIDTH = 8.0

# --- The speed profile --------------------------------------------------------

# Lateral acceleration a scheduled car will accept through a corner, m/s^2. 2.5
# is comfortable-brisk: it puts a 90 degree turn across a 12 m intersection at
# about 5 m/s, which is what turning a corner in a city looks like.
CORNER_LATERAL = 2.5

# Longitudinal limits, m/s^2. Braking is the one that matters -- without it a
# route would step from 14 m/s to 5 m/s between two vertices 4 m apart, and the
# car would visibly snap. 2.2 is a relaxed city stop.
BRAKE = 2.2
ACCEL = 1.6

# Nothing crawls below this except at a dwell, m/s. A route with a very tight
# corner in it would otherwise take a minute to cross one intersection.
MIN_SPEED = 2.5

# --- Signals ------------------------------------------------------------------

# How close a surveyed `highway=traffic_signals` node has to be to a lane graph
# node for that node to be signalised, metres. The OSM nodes are per *approach*
# -- one per stop line -- and they sit on the way itself, so this is small.
SIGNAL_SNAP_M = 12.0

# The red a car waits out at a signalised node, seconds. A range rather than a
# number so a route through five sets of lights is not five identical pauses,
# hashed per (route, node) so it is the same wait in every process. The upper
# bound is load-bearing: `_headway` keeps every route's headway above its
# longest dwell, which is what makes two cars on one route impossible.
DWELL_MIN = 2.5
DWELL_MAX = 7.0

# Share of signalised nodes a route actually stops at. A car that stopped at
# every light would make the city read as gridlock; two in three is what a green
# wave on an arterial looks like from the footpath.
DWELL_SHARE = 0.66

# --- Routes -------------------------------------------------------------------

# Longest route, metres, and the number is a trade between two visible things.
#
# A car exists for exactly one traversal of its route -- it appears at the first
# vertex and is gone at the last -- so **short routes mean frequent pops**, and
# a car materialising thirty metres up the street is the one artefact of this
# whole design a player can actually catch. Long routes push those pops further
# away and make them rarer.
#
# The other side is streaming. A route belongs to the tile holding its *first*
# vertex and is materialised only while that tile is resident, so a route may
# reach this far outside its owner. Against the client's 1.8 km streaming radius
# and a ~500 m draw radius for the cars themselves, 800 m leaves every route
# that could put a car in view owned by a tile that is comfortably loaded.
MAX_ROUTE_M = 800.0

# Shortest route worth scheduling, metres. Below this a route is a stub off the
# end of a cul-de-sac, and a car that drives 20 m and vanishes is worse than no
# car.
MIN_ROUTE_M = 45.0

# Vertex cap per route. Purely a format bound -- the count is a u16 and nothing
# in the extent comes close -- but it is asserted rather than assumed.
MAX_ROUTE_POINTS = 512

# Closest two route vertices may be, metres. See `_dedupe`, which is where the
# f32 argument for this number lives.
MIN_VERTEX_GAP = 0.05

# --- Sidecar ------------------------------------------------------------------

LANES_MAGIC = 0x454E414C  # 'LANE' little-endian
# v2 added the two kerb bays a route's cars park in -- see `bays.py`. The bump
# is not optional: v1 carried no bay at all and the client *derived* one from
# the ways block, which is precisely the drift this version exists to end, so a
# v1 file read by a v2 client would silently go back to deriving.
LANES_VERSION = 2

# The class byte in the sidecar, in this order. **Append only** -- an index in a
# file already on disk must keep meaning what it meant, exactly as
# `mesh.MATERIALS` is append-only for the same reason. Anything unrecognised is
# written as the last entry.
#
# **Must match `LANE_CLASSES` in `client/src/game/traffic.ts`.**
LANE_CLASSES = (
    "motorway", "motorway_link",
    "trunk", "trunk_link",
    "primary", "primary_link",
    "secondary", "secondary_link",
    "tertiary", "tertiary_link",
    "residential", "unclassified", "living_street", "service",
    "other",
)
_CLASS_INDEX = {name: i for i, name in enumerate(LANE_CLASSES)}


def class_index(highway: str) -> int:
    return _CLASS_INDEX.get(highway, len(LANE_CLASSES) - 1)


# --- The clock ----------------------------------------------------------------

# Ticks per second the timetable is denominated in, and the instant tick zero
# sits at. Both travel in `index.json` so the client and the Bun server read
# them rather than repeating them.
#
# **The traffic clock is UNIX time, not the server's tick counter**, and that is
# a decision worth its paragraph. The simulation tick would be the obvious
# clock -- it is what `game/footy.ts` is deterministic against -- but it is
# private to `net/client.ts` on the browser side and reaching it would mean a
# protocol field, which this feature is specifically built to avoid; and it
# restarts at zero when the server process does, which would teleport every car
# in Sydney on a deploy. Wall-clock time has neither problem: both ends already
# have it, it costs nothing, and it survives a restart.
#
# What it costs is clock skew. Two NTP-disciplined machines differ by tens of
# milliseconds, which at 14 m/s is a few tens of centimetres of car. A badly set
# clock is worse, and the failure is graceful in the direction that matters:
# the *server* is authoritative for whether a car hit you, the client merely
# predicts it, and `net/client.ts`'s existing correction covers the difference
# exactly as it covers any other misprediction.
TRAFFIC_HZ = 60
# 2026-01-01T00:00:00Z. An epoch near the build rather than 1970 so the tick
# number stays inside 2^31 for over a year, which keeps every integer hash
# derived from it in exact int32 range.
TRAFFIC_EPOCH_MS = 1_767_225_600_000


def manifest(net: LaneNetwork | None) -> dict | None:
    """The `lanes` block in `index.json`. `None` for a world with no lane graph."""
    if net is None:
        return None
    s = net.stats
    return {
        "version": LANES_VERSION,
        "hz": TRAFFIC_HZ,
        "epoch_ms": TRAFFIC_EPOCH_MS,
        "classes": list(LANE_CLASSES),
        "routes": int(s.get("routes", 0)),
        "live_cars": int(s.get("live_cars", 0)),
        "route_length_m": round(float(s.get("route_length_m", 0.0)), 1),
        "way_spans": int(s.get("way_spans", 0)),
        "signal_nodes": int(s.get("signal_nodes", 0)),
        # The kerb bays, v2's whole reason for existing. `bay_ends` is two per
        # route and `bay_assigned` is how many of them found a bay nothing else
        # owns; the difference is the number the client reports as "dwells at
        # the lane offset instead". Carried here so a pipeline change that
        # started starving the arbitration shows up in the index rather than
        # only in a check nobody runs. See `bays.py`.
        "bay_ends": int(s.get("bay_ends", 0)),
        "bay_assigned": int(s.get("bay_assigned", 0)),
        "bay_no_way": int(s.get("bay_no_way", 0)),
        "bay_no_free": int(s.get("bay_no_free_bay", 0)),
        "bay_reserve_half_m": [bays.RESERVE_HALF_LENGTH, bays.RESERVE_HALF_WIDTH],
        # What a consumer needs to put people on the footpaths beside these
        # ways without opening `streets.py`. See `tiles.write_lanes`.
        "kerb_width_m": streets.KERB_WIDTH,
        "carriageway_y_m": streets.CARRIAGEWAY_Y,
        "footpath_y_m": streets.FOOTPATH_Y,
    }

# Node identity. Two way vertices are the same junction when they round to the
# same centimetre, which is `roadgrade._key`'s rule and OSM's own precision.
_QUANT = 100.0


def _key(p) -> tuple[int, int]:
    return (round(float(p[0]) * _QUANT), round(float(p[1]) * _QUANT))


def _hash(*parts: int) -> int:
    """Murmur-ish integer hash. Stable across processes and languages.

    The same shape the client uses, and for the same reason `game/footy.ts`
    gives: an integer hash of `Math.imul`, xor and shift is exact everywhere,
    where a float PRNG is not. Nothing produced here is re-derived at runtime --
    every hashed choice is baked into the file -- but keeping the two the same
    means a future runtime choice can use the identical function.
    """
    h = 0x811C9DC5
    for p in parts:
        h ^= (int(p) * 0x27D4EB2D) & 0xFFFFFFFF
        h = ((h ^ (h >> 15)) * 0x85EBCA6B) & 0xFFFFFFFF
    return (h ^ (h >> 13)) & 0xFFFFFFFF


def _unit(h: int) -> float:
    """A hash as a float in [0, 1)."""
    return h / 4294967296.0


# --- The Harbour Bridge -------------------------------------------------------


class HeroDeck:
    """The Bradfield Highway's running surface over the hero Harbour Bridge.

    `decks.py` clips every generic bridge centreline against
    `decks.hero_bridge_zone`, so the ways that cross the harbour have no
    `DeckRun` and no solved elevation of any kind -- the deck they run on is
    authored geometry in `landmarks.build_bridge` rather than a solve. Without
    this class, traffic over the bridge would either be dropped or would be
    sampled off the terrain and drive along the harbour bed sixty metres under
    the deck.

    The profile is rebuilt from `landmarks`' own three constants and its own
    pylon frame, so it cannot drift from the geometry the player is standing on:
    a level deck at `BRIDGE_DECK_AHD` for the published 1,149 m, then the 5.5%
    approach ramps off both ends. `landmarks.build_bridge` stops each ramp where
    it meets the ground; this does the same thing by clamping to the terrain,
    which lands the lane on the touchdown at the same place without needing the
    stepped search.
    """

    def __init__(self, anchors: dict, zone: Polygon, terrain) -> None:
        from . import landmarks as lm

        centre, along, _across = lm._bridge_frame(anchors)
        self._centre = centre
        self._along = along
        self._half_len = lm.BRIDGE_TOTAL_LENGTH * 0.5
        self._deck_y = -terrain.base_elevation + lm.BRIDGE_DECK_AHD
        self._grade = lm.BRIDGE_RAMP_GRADE
        self._reach = lm.BRIDGE_RAMP_MAX
        self._zone = prep(zone)
        self._bounds = zone.bounds
        self._terrain = terrain
        self.covered = 0

    def covers(self, east: float, north: float) -> bool:
        # The box first. This runs on every vertex of every bridge way in the
        # extent and the polygon test is two orders of magnitude dearer than the
        # four comparisons that reject almost all of them.
        x0, y0, x1, y1 = self._bounds
        if east < x0 or east > x1 or north < y0 or north > y1:
            return False
        inside = bool(self._zone.contains(Point(east, north)))
        if inside:
            self.covered += 1
        return inside

    def height(self, east: float, north: float) -> float:
        """Deck y at a point inside the zone. Never below the ground under it."""
        s = float(
            (east - self._centre[0]) * self._along[0]
            + (north - self._centre[1]) * self._along[1]
        )
        over = abs(s) - self._half_len
        y = self._deck_y if over <= 0.0 else self._deck_y - self._grade * min(over, self._reach)
        ground = float(np.asarray(self._terrain.sample(east, north)).reshape(-1)[0])
        return max(y, ground + streets.CARRIAGEWAY_Y)


# --- Records ------------------------------------------------------------------


@dataclass
class WaySpan:
    """One drivable-or-service way, clipped to one tile, as reusable geometry.

    Not a lane and not a route: this is the *street*, with the two widths that
    let a consumer derive anything that runs beside it. See the header.
    """

    osm_id: int
    highway: str
    oneway: bool
    half_width: float  # centreline to kerb
    footpath_width: float  # the paved band beyond the kerb, 0 where there is none
    pts: np.ndarray  # (N, 2) ENU
    y: np.ndarray  # (N,) world metres, on the running surface


@dataclass
class Route:
    """One car route: a lane-offset polyline and the timetable along it."""

    rid: int
    highway: str
    pts: np.ndarray  # (N, 2) ENU, already offset into the left-hand lane
    y: np.ndarray  # (N,)
    t: np.ndarray  # (N,) cumulative seconds from the route's start
    headway: float  # seconds between departures
    phase: float  # seconds, this route's own offset into the headway
    tile: str = ""
    # Vertex indices carrying a signalised junction. Consumed by `_timetable`
    # and then thrown away: a dwell is two identical points with time between
    # them by the time anything reads the file.
    stops: list[int] = field(default_factory=list)
    # The kerb bay this route's cars sit in before they depart, and the one they
    # pull into at the far end. `None` where the arbitration found nothing free
    # -- that end then has no park stage at all and the car winks in and out at
    # the lane offset, which is the pre-v2 behaviour for a route with no kerb.
    # Assigned by `bays.BayLedger.assign` after `_schedule`, because it needs
    # the timetable that gives a bay a route-time. See `bays.py`.
    bay0: bays.Bay | None = None
    bay1: bays.Bay | None = None

    @property
    def duration(self) -> float:
        return float(self.t[-1])

    @property
    def live(self) -> int:
        """How many cars are on this route at any instant."""
        return max(1, math.ceil(self.duration / self.headway))

    @property
    def length(self) -> float:
        return float(np.hypot(*np.diff(self.pts, axis=0).T).sum())


@dataclass
class _Arc:
    """A stretch of one way between two graph nodes. Undirected."""

    road: osm.OsmRoad
    pts: np.ndarray
    y: np.ndarray
    a: tuple[int, int]
    b: tuple[int, int]


@dataclass
class _Edge:
    """One direction of an arc. This is what a route is a chain of."""

    arc: _Arc
    forward: bool
    used: bool = False

    @property
    def tail(self) -> tuple[int, int]:
        return self.arc.a if self.forward else self.arc.b

    @property
    def head(self) -> tuple[int, int]:
        return self.arc.b if self.forward else self.arc.a

    def line(self) -> tuple[np.ndarray, np.ndarray]:
        if self.forward:
            return self.arc.pts, self.arc.y
        return self.arc.pts[::-1], self.arc.y[::-1]


@dataclass
class TileLanes:
    ways: list[WaySpan] = field(default_factory=list)
    routes: list[Route] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.ways and not self.routes


# --- The network --------------------------------------------------------------


class LaneNetwork:
    """Every drivable lane in the extent, and the cars scheduled onto it."""

    def __init__(self, ways: list[WaySpan], routes: list[Route], stats: dict) -> None:
        self.stats = stats
        self._by_tile: dict[str, TileLanes] = {}
        for w in ways:
            mid = 0.5 * (w.pts[:-1] + w.pts[1:])
            # A span is already clipped to one tile by `_split_by_tile`, so its
            # midpoints agree; the first is enough and is cheaper than a mode.
            key = geo.tile_for_enu(float(mid[0, 0]), float(mid[0, 1])).key
            self._by_tile.setdefault(key, TileLanes()).ways.append(w)
        for r in routes:
            self._by_tile.setdefault(r.tile, TileLanes()).routes.append(r)

    @classmethod
    def load(
        cls,
        radius_m: float,
        terrain,
        roads: list[osm.OsmRoad],
        deck_network=None,
        hero: HeroDeck | None = None,
        signal_nodes: list | None = None,
        street_network=None,
        parking_network=None,
    ) -> LaneNetwork:
        """Build the lane graph, the routes and the per-tile way spans."""
        height = _HeightField(terrain, deck_network, hero)

        # The ways block is broader than the traffic: `service` is in it because
        # a laneway has a footpath beside it, and a pedestrians pass reading this
        # file should not have to go back to OSM for one class.
        surface = [r for r in roads if not r.is_foot and not r.tunnel]
        spans = _split_by_tile(surface, height)

        drivable = [r for r in surface if r.highway in DRIVABLE]
        arcs, nodes = _arcs(drivable, height, signal_nodes)
        signals = _signalised(nodes, signal_nodes or [])
        routes, trail_stats = _trails(arcs, signals, height)
        routes = _schedule(routes, signals)

        # The kerb bays, **after** the timetable and before anything is written.
        # A bay is a route-time, so it cannot be chosen until `_schedule` has
        # given the route one; and it is a claim on ground the static fleet may
        # already hold, so it cannot be chosen by a per-tile decoder that has
        # never seen `parking.py`. See `bays.py`, which is the whole argument.
        bay_stats: dict[str, int] = {}
        if street_network is not None:
            ledger = bays.BayLedger(street_network, parking_network)
            ledger.assign(routes)
            bay_stats = {f"bay_{k}": v for k, v in ledger.stats.items()}

        stats = {
            "surface_ways": len(surface),
            "drivable_ways": len(drivable),
            "way_spans": len(spans),
            "way_points": int(sum(len(w.pts) for w in spans)),
            "graph_nodes": len(nodes),
            "arcs": len(arcs),
            "signal_nodes": len(signals),
            "surveyed_signals": len(signal_nodes or []),
            "routes": len(routes),
            "route_points": int(sum(len(r.pts) for r in routes)),
            "route_length_m": float(sum(r.length for r in routes)),
            "live_cars": int(sum(r.live for r in routes)),
            "duration_p50": float(np.percentile([r.duration for r in routes], 50)) if routes else 0.0,
            "hero_bridge_points": hero.covered if hero is not None else 0,
            **trail_stats,
            **height.stats,
            **bay_stats,
        }
        return cls(spans, routes, stats)

    # --- Tile coverage --------------------------------------------------------

    def tile_keys(self) -> set[str]:
        return set(self._by_tile)

    def instances(self, tile_key: str) -> TileLanes:
        return self._by_tile.get(tile_key, TileLanes())


class _HeightField:
    """Where the asphalt is, whichever of the three authors drew it."""

    def __init__(self, terrain, deck_network, hero: HeroDeck | None) -> None:
        self._terrain = terrain
        self._hero = hero
        # Keyed by OSM id and **not** by object identity, which is the bug this
        # comment exists to prevent coming back: `DeckNetwork.load` re-reads the
        # OSM extract, so its `OsmRoad` records are different Python objects from
        # the street network's even though they describe the same ways. Keyed by
        # `id()` the lookup silently missed every deck in the build and put the
        # Western Distributor's traffic on the harbour bed.
        self._runs: dict[int, list] = {}
        if deck_network is not None:
            for run in deck_network.runs:
                self._runs.setdefault(_osm_id(run.road.osm_id), []).append(run)
        self._cache: dict[int, np.ndarray] = {}
        self.stats = {"hero_points": 0, "deck_points": 0, "ground_points": 0, "orphan_bridges": 0}

    def of(self, road: osm.OsmRoad, pts: np.ndarray) -> np.ndarray:
        """Solved surface height at each vertex of a way's *whole* line.

        Memoised on the road, because the ways block and the lane graph each ask
        for the same way once and the deck lookup is the dearest thing in the
        build that is not a solve.
        """
        if len(pts) == len(road.line):
            hit = self._cache.get(id(road))
            if hit is not None:
                return hit
        out = self._solve(road, pts)
        if len(pts) == len(road.line):
            self._cache[id(road)] = out
        return out

    def at(self, road: osm.OsmRoad, pts: np.ndarray) -> np.ndarray:
        """The same, for points that are not on the way's own line.

        A lane is offset two metres off the centreline, and on a street with any
        camber or cross-fall that is a measurable height difference -- the car
        has to sit on the ground *under itself*, not on the ground under the
        white line. Uncached, because these points are per route rather than per
        way and there is nothing to share.
        """
        return self._solve(road, pts)

    def _solve(self, road: osm.OsmRoad, pts: np.ndarray) -> np.ndarray:
        out = np.empty(len(pts), dtype=np.float64)
        ground = np.asarray(self._terrain.sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
        ground = ground.reshape(-1) + streets.CARRIAGEWAY_Y
        runs = self._runs.get(_osm_id(road.osm_id), ())
        for i, (e, n) in enumerate(pts):
            if road.bridge and self._hero is not None and self._hero.covers(float(e), float(n)):
                out[i] = self._hero.height(float(e), float(n))
                self.stats["hero_points"] += 1
                continue
            if road.bridge and runs:
                y = _deck_height(runs, float(e), float(n))
                if y is not None:
                    out[i] = y
                    self.stats["deck_points"] += 1
                    continue
            if road.bridge:
                self.stats["orphan_bridges"] += 1
            out[i] = ground[i]
            self.stats["ground_points"] += 1
        return out


def _deck_height(runs: list, east: float, north: float) -> float | None:
    """`DeckRun.deck_y` at the foot of the nearest station segment."""
    best_d = float("inf")
    best_y = None
    for run in runs:
        a = run.pts[:-1]
        b = run.pts[1:]
        ab = b - a
        ap = np.array([east, north]) - a
        denom = (ab * ab).sum(axis=1)
        t = np.clip((ap * ab).sum(axis=1) / np.where(denom > 0.0, denom, 1.0), 0.0, 1.0)
        foot = a + t[:, None] * ab
        d = np.hypot(foot[:, 0] - east, foot[:, 1] - north)
        k = int(np.argmin(d))
        if float(d[k]) < best_d:
            best_d = float(d[k])
            best_y = float(run.deck_y[k] + t[k] * (run.deck_y[k + 1] - run.deck_y[k]))
    # Past about a half-tile the nearest run is a different bridge entirely and
    # its height says nothing about this point.
    return best_y if best_d < 60.0 else None


# --- The ways block -----------------------------------------------------------


def _split_by_tile(roads: list[osm.OsmRoad], height: _HeightField) -> list[WaySpan]:
    """Cut every surface way into per-tile spans, as `decks._index` does.

    A span rather than a whole way, so a 900 m stretch of Parramatta Road is not
    written into four tiles four times over. The rule is `decks.py`'s verbatim --
    a segment belongs to the tile holding its midpoint -- which is what makes the
    spans of one way butt exactly across a seam instead of overlapping or
    leaving a gap.
    """
    out: list[WaySpan] = []
    for r in roads:
        pts = np.asarray(r.line, dtype=np.float64)
        if len(pts) < 2:
            continue
        y = height.of(r, pts)
        half = 0.5 * min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH)
        foot = streets.FOOTPATH_WIDTH.get(r.highway, streets.FOOTPATH_WIDTH_DEFAULT)
        mid = 0.5 * (pts[:-1] + pts[1:])
        keys = [geo.tile_for_enu(float(e), float(n)).key for e, n in mid]
        start = 0
        for k in range(1, len(keys) + 1):
            if k == len(keys) or keys[k] != keys[start]:
                out.append(
                    WaySpan(
                        osm_id=_osm_id(r.osm_id),
                        highway=r.highway,
                        oneway=bool(r.oneway),
                        half_width=float(half),
                        footpath_width=float(foot),
                        pts=pts[start : k + 1],
                        y=y[start : k + 1],
                    )
                )
                start = k
    return out


def _osm_id(raw: str) -> int:
    try:
        return int(raw) & 0xFFFFFFFF
    except (TypeError, ValueError):
        return 0


# --- The lane graph -----------------------------------------------------------


def _arcs(
    roads: list[osm.OsmRoad], height: _HeightField, signal_nodes: list | None = None
) -> tuple[list[_Arc], dict]:
    """Split every drivable way at the vertices it shares with another one.

    OSM splits a way at most junctions already, but not all of them: a street
    that carries the same name and the same tags straight through a T is one
    way, and the leg of the T meets it at an *interior* vertex. Splitting on
    shared vertices rather than on way ends is what makes that T a junction a
    route can turn at, and it costs one pass over the vertices.

    **Ways are also split at a surveyed traffic signal**, whether or not
    anything else touches them there. Without it a signal that OSM put on the
    stop line of an unsplit through street lands mid-arc, is not a graph node,
    and a car sails through the red -- which was 65% of the signals in the
    extent before this clause.
    """
    shared: dict[tuple[int, int], int] = {}
    for r in roads:
        for p in r.line:
            k = _key(p)
            shared[k] = shared.get(k, 0) + 1
    for p in signal_nodes or ():
        # A signal sits *on* a way vertex in OSM, so this only has to name the
        # vertex rather than find the nearest point on the line.
        k = _key((p.east, p.north))
        if k in shared:
            shared[k] = max(shared[k], 2)

    arcs: list[_Arc] = []
    nodes: dict[tuple[int, int], list[int]] = {}
    for r in roads:
        pts = np.asarray(r.line, dtype=np.float64)
        if len(pts) < 2:
            continue
        y = height.of(r, pts)
        cuts = [0]
        for i in range(1, len(pts) - 1):
            if shared.get(_key(pts[i]), 0) > 1:
                cuts.append(i)
        cuts.append(len(pts) - 1)
        for lo, hi in itertools.pairwise(cuts):
            if hi - lo < 1:
                continue
            sub = pts[lo : hi + 1]
            if float(np.hypot(*np.diff(sub, axis=0).T).sum()) < 1.0:
                continue
            a, b = _key(sub[0]), _key(sub[-1])
            if a == b:
                continue  # a loop back onto its own node: nothing to drive
            arcs.append(_Arc(road=r, pts=sub, y=y[lo : hi + 1], a=a, b=b))
            nodes.setdefault(a, []).append(len(arcs) - 1)
            nodes.setdefault(b, []).append(len(arcs) - 1)
    return arcs, nodes


def _signalised(nodes: dict, signal_nodes: list) -> set:
    """Graph nodes with a surveyed traffic signal on them.

    The OSM nodes are per approach -- one per stop line -- so several of them
    land on the arms of one intersection and every arm's node is correctly
    signalised. No clustering is wanted here, unlike `furniture.py`, which is
    placing one post per junction rather than deciding where a car waits.
    """
    if not nodes or not signal_nodes:
        return set()
    keys = list(nodes)
    grid: dict[tuple[int, int], list[int]] = {}
    cell = SIGNAL_SNAP_M
    for i, k in enumerate(keys):
        gx = math.floor((k[0] / _QUANT) / cell)
        gy = math.floor((k[1] / _QUANT) / cell)
        grid.setdefault((gx, gy), []).append(i)

    out = set()
    for p in signal_nodes:
        gx = math.floor(p.east / cell)
        gy = math.floor(p.north / cell)
        best, best_d = None, SIGNAL_SNAP_M
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in grid.get((gx + dx, gy + dy), ()):
                    k = keys[i]
                    d = math.hypot(k[0] / _QUANT - p.east, k[1] / _QUANT - p.north)
                    if d < best_d:
                        best, best_d = k, d
        if best is not None:
            out.add(best)
    return out


def _trails(arcs: list[_Arc], signals: set, height: _HeightField) -> tuple[list[Route], dict]:
    """Decompose the directed lane graph into edge-disjoint routes.

    Every directed edge is consumed exactly once, which is the whole of the
    "two cars never share a lane" guarantee -- see the header. The walk prefers
    the straightest continuation because that is what a road does through an
    intersection, and falls back to a hashed choice among the rest so a route
    that must turn turns the same way in every build.
    """
    edges: list[_Edge] = []
    for arc in arcs:
        if not _one_way(arc.road):
            edges.append(_Edge(arc, True))
            edges.append(_Edge(arc, False))
        else:
            edges.append(_Edge(arc, not _reversed_one_way(arc.road)))

    out_of: dict[tuple[int, int], list[int]] = {}
    for i, e in enumerate(edges):
        out_of.setdefault(e.tail, []).append(i)

    # Seed order: the fringe first. Starting every trail at a node with more
    # incoming than outgoing edges is the standard trail-decomposition trick and
    # it is what stops the walk stranding a dead-end stub that nothing can then
    # reach -- which would show up as a suburban cul-de-sac with no cars while
    # the through street beside it had two routes.
    order = sorted(range(len(edges)), key=lambda i: (len(out_of.get(edges[i].tail, ())), i))

    routes: list[Route] = []
    stats = {"trail_edges": 0, "trail_splits": 0, "trail_dropped": 0}
    for seed in order:
        if edges[seed].used:
            continue
        chain: list[_Edge] = []
        run = 0.0
        cur = seed
        while True:
            e = edges[cur]
            e.used = True
            chain.append(e)
            stats["trail_edges"] += 1
            run += _edge_length(e)
            if run >= MAX_ROUTE_M:
                break
            nxt = _continue(edges, out_of.get(e.head, ()), e)
            if nxt is None:
                break
            cur = nxt
        routes.extend(_emit_chain(chain, signals, stats, height))
    return routes, stats


def _one_way(road: osm.OsmRoad) -> bool:
    return bool(road.oneway)


def _reversed_one_way(road: osm.OsmRoad) -> bool:
    """`oneway=-1`: the traffic runs against the way's digitised direction.

    `sources/osm.py` folds `-1` into the boolean, so this reads the raw tag back
    off the record when it is there. Absent, everything one-way runs forward,
    which is what it did before this module existed.
    """
    return bool(getattr(road, "oneway_reverse", False))


def _edge_length(e: _Edge) -> float:
    pts = e.arc.pts
    return float(np.hypot(*np.diff(pts, axis=0).T).sum())


def _continue(edges: list[_Edge], candidates, prev: _Edge) -> int | None:
    """The next unused edge out of a node: straightest wins, hash breaks ties."""
    pts, _ = prev.line()
    inbound = pts[-1] - pts[-2]
    norm = math.hypot(float(inbound[0]), float(inbound[1]))
    if norm < 1e-9:
        return None
    ix, iy = float(inbound[0]) / norm, float(inbound[1]) / norm

    best, best_score = None, -2.0
    for i in candidates:
        e = edges[i]
        if e.used:
            continue
        # A route may not immediately turn back down the arc it just came along.
        if e.arc is prev.arc:
            continue
        line, _ = e.line()
        out = line[1] - line[0]
        d = math.hypot(float(out[0]), float(out[1]))
        if d < 1e-9:
            continue
        cos = (ix * float(out[0]) + iy * float(out[1])) / d
        # A U-turn is never a continuation. Anything up to a right-angle turn is.
        if cos < -0.2:
            continue
        score = cos + 0.05 * _unit(_hash(i, 0x5A17))
        if score > best_score:
            best, best_score = i, score
    return best


def _emit_chain(
    chain: list[_Edge], signals: set, stats: dict, height: _HeightField
) -> list[Route]:
    """Turn a chain of directed edges into one lane-offset polyline route."""
    if not chain:
        return []
    pts: list[np.ndarray] = []
    ys: list[float] = []
    stops: list[int] = []
    highway = chain[0].arc.road.highway
    for e in chain:
        line, _ = e.line()
        off = _lane_offset(e.arc.road)
        lane = _offset_left(line, off)
        # Height at the *lane*, not at the centreline. See `_HeightField.at`.
        y = height.at(e.arc.road, lane)
        if pts:
            # The junction vertex is shared: the previous edge ended on it and
            # this one starts on it. Two offset lanes do not land on the same
            # point there, so the joint is welded by averaging -- which is what
            # puts the car on the inside of the corner rather than clipping it.
            joint = 0.5 * (pts[-1] + lane[0])
            pts[-1] = joint
            ys[-1] = 0.5 * (ys[-1] + float(y[0]))
            if e.tail in signals:
                stops.append(len(pts) - 1)
            lane = lane[1:]
            y = y[1:]
        pts.extend(lane)
        ys.extend(float(v) for v in y)

    p = np.asarray(pts, dtype=np.float64)
    yy = np.asarray(ys, dtype=np.float64)
    p, yy, stops = _dedupe(p, yy, stops)
    if len(p) < 2:
        stats["trail_dropped"] += 1
        return []

    out: list[Route] = []
    for lo, hi in _chunks(p):
        sub = p[lo : hi + 1]
        length = float(np.hypot(*np.diff(sub, axis=0).T).sum())
        if length < MIN_ROUTE_M:
            stats["trail_dropped"] += 1
            continue
        if lo > 0:
            stats["trail_splits"] += 1
        out.append(
            Route(
                rid=0,
                highway=highway,
                pts=sub,
                y=yy[lo : hi + 1],
                t=np.zeros(hi + 1 - lo),
                headway=0.0,
                phase=0.0,
                stops=[s - lo for s in stops if lo <= s <= hi],
            )
        )
    return out


def _chunks(pts: np.ndarray) -> list[tuple[int, int]]:
    """Vertex spans within both caps, cut so that consecutive spans share a vertex.

    The length cap has to be enforced here rather than only in `_trails`: the
    walk stops when the running total *reaches* the cap, so a chain whose last
    edge is 300 m long overshoots by 300 m, and one arc of the Warringah Freeway
    is longer than the cap on its own. Splitting the polyline is exact where
    refusing the edge would leave a stretch of motorway with no traffic at all.
    """
    n = len(pts)
    seg = np.hypot(*np.diff(pts, axis=0).T) if n > 1 else np.zeros(0)
    out: list[tuple[int, int]] = []
    lo = 0
    while lo < n - 1:
        run = 0.0
        hi = lo
        while hi < n - 1 and hi - lo < MAX_ROUTE_POINTS - 1:
            run += float(seg[hi])
            hi += 1
            if run >= MAX_ROUTE_M:
                break
        out.append((lo, hi))
        lo = hi
    return out or [(0, max(0, n - 1))]


def _dedupe(pts: np.ndarray, y: np.ndarray, stops: list[int]):
    """Drop coincident vertices.

    Two reasons, and the second is the one that bites. A zero-length segment is
    a divide by zero in `_timetable`; and a segment short enough to take a few
    tens of microseconds to cross produces two cumulative times that are the
    *same f32* once the route is a hundred seconds long, which turns the client's
    binary search into a divide by zero of its own. `MIN_VERTEX_GAP` at the
    slowest speed on the profile is 20 ms, which is four orders of magnitude
    clear of an f32 step at that magnitude.

    The last vertex is kept in place rather than dropped -- it is where the
    route ends -- by moving it onto the last surviving index.
    """
    keep = [0]
    for i in range(1, len(pts)):
        d = math.hypot(float(pts[i, 0] - pts[keep[-1], 0]), float(pts[i, 1] - pts[keep[-1], 1]))
        if d > MIN_VERTEX_GAP:
            keep.append(i)
    if keep[-1] != len(pts) - 1:
        keep[-1] = len(pts) - 1
    remap = {old: new for new, old in enumerate(keep)}
    moved = sorted({remap[s] for s in stops if s in remap})
    return pts[keep], y[keep], moved


def _lane_offset(road: osm.OsmRoad) -> float:
    """How far left of the centreline this way's traffic runs, metres."""
    width = min(max(road.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH)
    if road.oneway and width < ONEWAY_CENTRE_WIDTH:
        return 0.0
    off = width * LANE_FRACTION
    return float(min(max(off, LANE_OFFSET_MIN), LANE_OFFSET_MAX))


def _offset_left(pts: np.ndarray, offset: float) -> np.ndarray:
    """Shift a polyline to the left of its own direction of travel.

    LEFT-HAND TRAFFIC. In ENU the left of a heading `(de, dn)` is `(-dn, de)`;
    see the header for the same statement in renderer axes and for the check
    that asserts it. Interior vertices use the average of the two adjacent
    directions, which keeps the offset line continuous through a bend without
    the mitre blow-up a true offset would have at a hairpin.
    """
    if offset == 0.0 or len(pts) < 2:
        return pts.copy()
    d = np.diff(pts, axis=0)
    n = np.hypot(d[:, 0], d[:, 1])
    n = np.where(n > 1e-9, n, 1.0)
    d = d / n[:, None]
    dirs = np.empty_like(pts)
    dirs[0] = d[0]
    dirs[-1] = d[-1]
    if len(pts) > 2:
        mid = d[:-1] + d[1:]
        m = np.hypot(mid[:, 0], mid[:, 1])
        # A perfect hairpin averages to zero; keep the incoming direction there.
        mid = np.where(m[:, None] > 1e-6, mid / np.where(m > 1e-6, m, 1.0)[:, None], d[:-1])
        dirs[1:-1] = mid
    left = np.column_stack((-dirs[:, 1], dirs[:, 0]))
    return pts + left * offset


# --- The timetable ------------------------------------------------------------


def _schedule(routes: list[Route], signals: set) -> list[Route]:
    """Give every route an id, a speed profile, a timetable and a headway."""
    kept: list[Route] = []
    for i, r in enumerate(routes):
        rid = _hash(i, 0x7A2F, len(r.pts)) & 0x7FFFFFFF
        share = KEEP_SHARE.get(r.highway, KEEP_SHARE_DEFAULT)
        if share < 1.0 and _unit(_hash(rid, 0x0BED)) >= share:
            continue
        r.rid = rid
        pts, y, t, longest = _timetable(r, r.stops)
        r.pts, r.y, r.t = pts, y, t
        r.headway = _headway(r.highway, longest)
        # The phase is what decorrelates two routes that meet at a junction.
        # Hashed off the route id so it is the same in every process and stable
        # across a rebuild that does not change the geometry.
        r.phase = float(_unit(_hash(rid, 0x1D0C)) * r.headway)
        r.tile = geo.tile_for_enu(float(r.pts[0, 0]), float(r.pts[0, 1])).key
        kept.append(r)
    return kept


def _timetable(route: Route, stops: list[int]):
    """The route's polyline with its timetable, corners and red lights included.

    Returns `(pts, y, t, longest_dwell)` -- **the polyline comes back changed**,
    and that is the whole of how a car stops at a red light. A dwell is emitted
    as the *same vertex twice* with time between the two copies: the client's
    lookup then interpolates between two identical points and the car is
    genuinely stationary for those seconds. Folding the wait into the following
    segment's travel time instead would have the car creep through the
    intersection at walking pace, which is not what a red light looks like.
    """
    pts = route.pts
    n = len(pts)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    seg = np.maximum(seg, 1e-3)
    free = FREE_SPEED.get(route.highway, FREE_SPEED_DEFAULT)

    # --- Corner caps, per vertex.
    v = np.full(n, free)
    for i in range(1, n - 1):
        a = pts[i] - pts[i - 1]
        b = pts[i + 1] - pts[i]
        da = math.hypot(float(a[0]), float(a[1]))
        db = math.hypot(float(b[0]), float(b[1]))
        if da < 1e-6 or db < 1e-6:
            continue
        cos = max(-1.0, min(1.0, float(a[0] * b[0] + a[1] * b[1]) / (da * db)))
        turn = math.acos(cos)
        if turn < 0.05:
            continue
        radius = max(min(da, db) / max(turn, 1e-3), 1.0)
        v[i] = min(v[i], max(MIN_SPEED, math.sqrt(CORNER_LATERAL * radius)))
    # A route does *not* stop dead at either end -- it is a stretch of a longer
    # journey and the car is created and retired at speed, so the ends keep the
    # free speed.
    #
    # A signalised node does. Pinning it to the crawl here rather than only
    # adding the dwell is what makes the two sweeps below brake the car into the
    # intersection and accelerate it out: without it a car arrives at 14 m/s,
    # stops for four seconds in one frame and leaves at 14 m/s again, which
    # reads as a dropped frame rather than as a red light.
    for i in stops:
        if 0 < i < n - 1:
            v[i] = MIN_SPEED

    # --- Braking backward, acceleration forward. Both are the same sweep and
    # both are what stop the profile stepping between two adjacent vertices.
    for i in range(n - 2, -1, -1):
        v[i] = min(v[i], math.sqrt(v[i + 1] ** 2 + 2.0 * BRAKE * float(seg[i])))
    for i in range(1, n):
        v[i] = min(v[i], math.sqrt(v[i - 1] ** 2 + 2.0 * ACCEL * float(seg[i - 1])))
    v = np.maximum(v, MIN_SPEED)

    out_p: list[np.ndarray] = []
    out_y: list[float] = []
    out_t: list[float] = []
    clock = 0.0
    longest = 0.0
    stop_set = set(stops)
    for i in range(n):
        out_p.append(pts[i])
        out_y.append(float(route.y[i]))
        out_t.append(clock)
        # The wait, as a second copy of this vertex. Never at the two ends: a
        # route's first vertex is where the car is created and stopping there
        # would make it materialise and sit still, which is the one way a
        # spawning car draws attention to itself.
        if (
            0 < i < n - 1
            and i in stop_set
            and _unit(_hash(route.rid, i, 0x0DEC)) < DWELL_SHARE
        ):
            dwell = DWELL_MIN + (DWELL_MAX - DWELL_MIN) * _unit(_hash(route.rid, i, 0x51CD))
            longest = max(longest, dwell)
            clock += dwell
            out_p.append(pts[i])
            out_y.append(float(route.y[i]))
            out_t.append(clock)
        if i < n - 1:
            speed = max(0.5 * (float(v[i]) + float(v[i + 1])), MIN_SPEED)
            clock += float(seg[i]) / speed
    return np.asarray(out_p), np.asarray(out_y), np.asarray(out_t), longest


def _headway(highway: str, longest_dwell: float) -> float:
    """Seconds between departures on one route.

    **Strictly greater than the longest dwell on the route**, and that is the
    condition the header's collision-free claim rests on: two cars on one
    timetable can only occupy the same point where the timetable is constant,
    and a dwell shorter than the headway cannot hold two cars at once.
    """
    base = HEADWAY.get(highway, HEADWAY_DEFAULT)
    return float(max(base, longest_dwell + 1.5))
