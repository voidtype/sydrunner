"""Spec 8.3's two powerups, placed where Sydney's real ones are.

The clause this module exists for is the first line of section 8.3, and it is
the whole design brief: *"Both from live OSM data -- the point is that they
exist where the real thing exists."* Nothing here invents a position. Every
point emitted is a station entrance, a station, or a cafe that somebody mapped.

  * **"Training"** -- `railway=station`, `railway=subway_entrance` and
    `railway=train_station_entrance`. +40% punch damage, +25% speed, 45 s,
    respawning 90 s after pickup. Sparse and contested by construction: there
    are 25 of them over the inner ring against 811 cafes.
  * **"Flat White"** -- `amenity=cafe`. +60% speed, +100% jump, -20% damage,
    30 s. Spec 8.3's own words for these are *"the abundant low-stakes pickup
    that keeps traversal interesting between station runs"*, and 811 in a 4 km
    circle is exactly that.

Spec 8.3 offers `amenity=pub` -> "Schooner" as an alternative and says to
implement the cafe by default, so the 213 pubs in the inner ring are parsed by
`osm.read_pois` and ignored here.

Architecturally this is `furniture.py` again, which is `power.py` again: one
network built for the whole run, per-tile emission, a binary sidecar, and
client-side geometry streamed and disposed with the tile. What is *not* like
those three is that nothing here is procedural -- there is no spacing rule, no
per-way roll and no hashing, because the position of a powerup is a fact about
Sydney rather than a decision this pipeline gets to make. The only judgement
calls are which mapped points to keep and, when a mapped point is inside a
building, where on the ground outside it to stand.

---------------------------------------------------------------------------
**Stations are mapped three different ways and only one of them is a node.**

The obvious reading of 8.3 -- filter `read_pois` for `railway=station` -- gets
22 points over the inner ring and **not one of the heavy-rail stations the spec
names**. Central and Redfern are closed *ways* tagged `railway=station`, which
GDAL's OSM driver leaves in the `lines` layer because `railway` is not one of
the keys it treats as area-forming; the 22 nodes it does return are the light
rail (Pyrmont Bay, The Star, Convention, Paddy's Markets) plus the Metro and
the North Shore. The platforms of a heavy-rail station are `railway=stop`
nodes, one per platform, which is a different object again and is not an
entrance.

So the source is two readers rather than one: `osm.read_pois` for the nodes and
`osm.read_station_areas` for the closed ways. That takes the inner ring from 22
stations with no Central in them to 25 with Central, Redfern, Museum and
St James -- three of the six stations spec 8.3 name-checks are inside the 4 km
ring at all (Newtown at 4.24 km, Erskineville at 4.20 and Green Square at 4.20
are 200-240 m outside it and arrive with `--stage middle`).

**Entrances win where they are mapped, and the station point stands in where
they are not.** 8.3 says *"Touch a station entrance"*, and an entrance is the
better objective for the reason the spec gives -- it is a doorway on a footpath
that several players converge on. But only the CBD's underground stations have
their entrances mapped: 100 entrance nodes over the inner ring, all of them at
eleven stations. Every suburban platform station has none. So each entrance is
attached to its nearest station within `ENTRANCE_LINK`, and a station that
attracted no entrance emits its own point instead. Central emits four entrances
and no concourse point; Macdonaldtown emits one point at the station.

**Four per station, and 40 m apart.** Wynyard has ten mapped entrance nodes and
Town Hall six, which as objectives is not a contested point, it is a carpet.
`MAX_PER_STATION` keeps the four furthest apart -- the four that actually
surround the block -- and `DEDUPE_RADIUS` drops any second point within 40 m of
one already taken, which is what removes the pairs OSM maps at either side of
the same stair head.

---------------------------------------------------------------------------
**86% of cafe nodes are inside a building, and that is the one measurement this
module rests on.**

Measured over the inner ring against the OSM footprints: 696 of 811 cafes, 65
of 100 station entrances and 8 of 22 station nodes sit inside a footprint. That
is not bad mapping -- a cafe *is* inside a building, and a subway entrance
genuinely is inside the lobby it opens off. It is a problem for a pickup you
have to walk into: the collision payload is the building prisms, so a point at
the mapped coordinate is a point behind a wall, and 86% of the abundant pickup
would be unreachable.

`_free_point` is the answer and it is exact rather than sampled. Take a disc of
`reach` around the mapped point, subtract every footprint within it buffered by
`CLEARANCE`, and ask shapely for the nearest point of what is left. Because the
free region is a real polygon, `nearest_points` returns the true nearest
standable position rather than the nearest of some lattice, and it does it in
one call.

Two refinements on top of that, and both are one line:

  * **A point already outside a building is never moved.** The test is
    membership of the blocked region, not distance to it, so a cafe with tables
    on the footpath stays exactly where it was mapped. 14% of cafes and 36% of
    station nodes take this path.
  * **Paving wins over open ground.** The free region is intersected with the
    street network's own footpath band -- `half_width + KERB_WIDTH +
    footpath_width`, taken from `streets.StreetNetwork` rather than re-derived,
    on the argument `power.py` and `furniture.py` both make -- and the nearest
    point of *that* is used when it is non-empty. A cafe on a corner block
    otherwise snaps into the back lane behind it, which is nearer than the
    street it fronts and is not where anybody walks in.

The reach differs by kind and the reason is architectural rather than tuned. A
cafe's frontage is its own wall, so 12 m clears any inner-city shopfront and its
awning; a station entrance can be deep inside a concourse -- Wynyard's are 20 m
in -- so stations get 30 m. Failing to find anything inside the reach leaves the
point where it was mapped rather than dropping it, which is the conservative
direction: an unreachable icon is a fair sight better than a missing objective,
and it is counted so the build report says how often it happened.

---------------------------------------------------------------------------
**No collision, no server, no cap on how many a player may hold.** The sidecar
is positions and a kind byte; every gameplay number in 8.3 lives in
`client/src/game/powerups.ts`, where the combat constants already live, for the
same reason `tiles.write_furniture` keeps the bin palette on the client: a byte
here that repeated one of them would be a byte that could disagree.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from shapely.geometry import Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree

from . import config, streets
from .merge import Building
from .sources import osm

# --- Kinds --------------------------------------------------------------------
# The u8 written into the sidecar. APPEND ONLY -- the client keys its geometry
# and its whole modifier table off these integers, exactly as it does for tree
# species, car bodies, pole kinds and bin lids.

TRAINING = 0  # a station or a station entrance
FLAT_WHITE = 1  # a cafe

KIND_COUNT = 2

KIND_NAME = {TRAINING: "training", FLAT_WHITE: "flat white"}

# --- Which mapped points become objectives ------------------------------------

# How far an entrance may be from the station it belongs to, metres.
#
# Generous, and it has to be: Wynyard's MetCentre entrance is 120 m from the
# station node and Central's Chalmers Street exits are 180 m from the concourse
# node, because a city station is a block long. What stops it over-reaching is
# that it attaches to the *nearest* station rather than to every station in
# range, and the nearest station to a Town Hall entrance is Town Hall even when
# St James is 300 m away.
ENTRANCE_LINK = 250.0

# Entrance points kept per station.
#
# Wynyard has ten mapped entrances and Town Hall six. Ten objectives on one
# block is not a contested point, it is a carpet -- and it is also ten icons
# inside one another, since several of them are the two sides of the same stair.
# Four is the number of street corners a city block has, and taking the four
# that are furthest apart (see `_thin_to`) is what makes them read as the
# corners of the station rather than as a cluster at one end of it.
MAX_PER_STATION = 4

# No two station points closer than this, metres. Removes the pairs OSM maps at
# either side of one stair head, and any entrance that duplicates the station
# node it stands on.
DEDUPE_RADIUS = 40.0

# The same idea for cafes, at the scale a cafe is.
#
# Much smaller, and deliberately: two cafes 20 m apart on King Street are two
# cafes and both should be pickups -- that abundance is the point of them. What
# this removes is the same business mapped twice (a node inside the building and
# a second on the awning), which is what the inner ring's duplicate pairs
# actually are.
CAFE_DEDUPE = 7.0

# --- Getting out of the building ----------------------------------------------

# How far a mapped point may be moved to stand on ground, metres. See the header
# for why these two differ.
SNAP_REACH_STATION = 30.0
SNAP_REACH_CAFE = 12.0

# The fallback reach, used only when nothing inside the first one is clear at
# all, metres.
#
# It exists because of a specific and numerous case: a cafe in a shopping
# arcade, a food court or a station concourse. 61 of the inner ring's 811 cafes
# are mapped somewhere no part of a 12 m disc is outside a building, and it is
# not bad mapping -- Gong Cha in the QVB really is 57 m from the nearest
# footpath, because the QVB is a city block. Measured over those 61, the
# distance needed to reach open ground runs 21 m at the median, 32 at p90 and
# 57 at the worst, so 65 clears all of them with margin.
#
# Two stages rather than one large reach, and that ordering is the whole point:
# a single 65 m radius would let an ordinary corner cafe snap two streets away
# whenever the nearest free ground happened to be a car park, where this only
# ever fires on a point that has no alternative at all.
SNAP_REACH_WIDE = 65.0

# How far clear of a wall a powerup has to stand, metres.
#
# `controller.PLAYER_RADIUS` is 0.34 and the collision resolve pushes a player's
# circle out of a prism, so a point 0.5 m off a wall is a point a player can put
# their chest on. Rounded up from that rather than chosen: it is the smallest
# clearance at which the 1.6 m pickup radius is reachable from every direction
# the player can approach from.
CLEARANCE = 0.6

# Ways within this of the snap disc can contribute paving to it, metres. Must
# exceed the widest band any way produces -- half of `streets.MAX_ROAD_WIDTH`
# plus the kerb and the footpath.
PAVING_MARGIN = 30.0

# --- Tiles --------------------------------------------------------------------

# Ceiling per tile, on the same terms as `furniture.MAX_BINS_PER_TILE`: a
# runaway count is a runaway sidecar and a runaway draw call, and a ceiling that
# is never reached costs nothing. The densest inner-ring tile carries 47.
MAX_PER_TILE = 150


@dataclass
class Powerup:
    """One pickup, in ENU metres."""

    east: float
    north: float
    # Terrain height plus `streets.FOOTPATH_Y`, exactly as `furniture.Bin` does
    # and for the same reason: a snapped point stands on paving by construction,
    # and 15 cm is the difference between an icon floating over the footpath and
    # one floating over the dirt under it. Sampled here so the client repeats no
    # lookup.
    ground_y: float
    kind: int
    # Carried for the build report only -- nothing downstream reads either of
    # these, exactly as `furniture.NamePost.names` is carried and unread.
    #
    # `name` is the point's own OSM name, which for an entrance is the *exit*
    # ("Exit 5: Chalmers Street") and is no use for identifying a station.
    # `station` is the name of the anchor the entrance was attached to, which is
    # what lets `cli._report_powerups` say Central has four rather than counting
    # four things called Exit-something.
    name: str | None = None
    station: str | None = None
    # How this point was resolved: 'entrance', 'station', 'cafe'. Report-only.
    source: str = ""


@dataclass
class TilePowerups:
    """One tile's share."""

    points: list[Powerup] = field(default_factory=list)

    def is_empty(self) -> bool:
        return not self.points


class PowerupNetwork:
    """Every powerup in the extent, bucketed by tile.

    Built once per run. It queries the street network read-only for the paving
    the snap prefers, and takes the building footprints directly rather than
    through `streets.buildings_near`, because that accessor returns the
    *obstacle* set the street surfaces are cut against and this needs the same
    polygons for a different question.

    Unlike every other instanced network here there is no per-way work and no
    caching: the whole extent's points are resolved in the constructor, because
    the deduplication is global (an entrance belongs to the nearest station,
    which may be in the tile next door) and doing it per tile would emit a
    different set at every seam.
    """

    def __init__(
        self,
        street_network: streets.StreetNetwork,
        buildings: list[Building],
        pois: list[osm.OsmPoi],
        station_areas: list[osm.OsmPoi],
        terrain=None,
    ) -> None:
        self._streets = street_network
        self._terrain = terrain

        self.stats: dict[str, int] = {
            "station_nodes": 0,
            "station_areas": 0,
            "entrance_nodes": 0,
            "cafe_nodes": 0,
            "entrances_orphan": 0,
            "stations_with_entrances": 0,
            "stations_bare": 0,
            "drop_per_station": 0,
            "drop_proximity": 0,
            "drop_cafe_duplicate": 0,
            "snap_as_mapped": 0,
            "snap_footpath": 0,
            "snap_open": 0,
            # Points that needed the second, wider disc: a cafe inside a city
            # block with no open ground within its own reach at all.
            "snap_wide": 0,
            "snap_failed": 0,
            "drop_tile_cap": 0,
        }
        # Metres moved by the snap, for the report. A distribution rather than a
        # mean, because the interesting question is whether anything moved
        # *absurdly* far, and a mean of 800 points hides one 29 m outlier.
        self.snap_distances: list[float] = []

        # Footprints, indexed on their own. The archetype is irrelevant here --
        # unlike `furniture.FurnitureNetwork`'s frontage test, this wants every
        # solid thing a player cannot stand in, which is every building.
        self._footprints = [
            poly for b in buildings for poly in (streets._footprint(b),) if poly is not None
        ]
        self._footprint_tree = STRtree(self._footprints) if self._footprints else None

        stations = [p for p in pois if p.kind == "station"]
        entrances = [p for p in pois if p.kind == "station_entrance"]
        cafes = [p for p in pois if p.kind == "cafe"]
        self.stats["station_nodes"] = len(stations)
        self.stats["station_areas"] = len(station_areas)
        self.stats["entrance_nodes"] = len(entrances)
        self.stats["cafe_nodes"] = len(cafes)

        anchors = stations + station_areas
        points = self._resolve_stations(anchors, entrances)
        points += self._resolve_cafes(cafes)

        self._by_tile: dict[str, list[Powerup]] = {}
        for p in points:
            self._by_tile.setdefault(_tile_key_of(p.east, p.north), []).append(p)
        for bucket in self._by_tile.values():
            bucket.sort(key=lambda p: (p.east, p.north))

        # Tallied over what is actually emitted, so the report describes the
        # world rather than what was proposed.
        self.emitted = [0] * KIND_COUNT

    # --- Tile coverage --------------------------------------------------------

    def tile_keys(self) -> set[str]:
        """Tiles this module puts something into.

        Every powerup is a mapped POI in a built-up place, so in practice this
        is a subset of the tiles the buildings and the streets already claim. It
        is here so a station in a tile with nothing else on it -- a platform in
        a rail corridor -- cannot silently lose its tile.
        """
        return set(self._by_tile)

    def instances(self, tile_key: str) -> TilePowerups:
        """Everything standing inside one tile."""
        points = list(self._by_tile.get(tile_key, ()))
        if len(points) > MAX_PER_TILE:
            self.stats["drop_tile_cap"] += len(points) - MAX_PER_TILE
            # Stations first, then cafes: a cap that thinned indiscriminately
            # would drop the sparse contested objective to keep three more of the
            # abundant one, which is exactly backwards. Inside a kind the order
            # is already positional and stable.
            points.sort(key=lambda p: (p.kind, p.east, p.north))
            points = sorted(points[:MAX_PER_TILE], key=lambda p: (p.east, p.north))
        out = TilePowerups(points)
        for p in points:
            self.emitted[p.kind] += 1
        return out

    # --- Stations -------------------------------------------------------------

    def _resolve_stations(
        self, anchors: list[osm.OsmPoi], entrances: list[osm.OsmPoi]
    ) -> list[Powerup]:
        """Entrances where they are mapped, the station itself where they are not.

        The grouping is the whole of it. Each entrance is attached to the nearest
        anchor within `ENTRANCE_LINK`; an anchor that collected any entrance
        emits none of its own, and an anchor that collected none emits one point
        at itself. Entrances too far from any anchor -- a stray Metro stair on
        a block of its own -- form their own group, so they are still objectives
        and are still capped and deduplicated.
        """
        groups: dict[str, list[osm.OsmPoi]] = {}
        station_of: dict[str, str | None] = {}
        for e in entrances:
            best: int | None = None
            best_d = ENTRANCE_LINK
            for i, a in enumerate(anchors):
                d = math.hypot(e.east - a.east, e.north - a.north)
                if d < best_d:
                    best_d = d
                    best = i
            if best is None:
                self.stats["entrances_orphan"] += 1
                key = f"orphan:{e.osm_id}"
                station_of[key] = e.name
            else:
                key = f"station:{best}"
                station_of[key] = anchors[best].name
            groups.setdefault(key, []).append(e)

        # Anchors that attracted nothing stand in for themselves.
        for i, a in enumerate(anchors):
            key = f"station:{i}"
            if key in groups:
                self.stats["stations_with_entrances"] += 1
            else:
                self.stats["stations_bare"] += 1
                groups[key] = [a]
                station_of[key] = a.name

        # Deterministic across runs: the group order is the anchor order, which
        # is the reader's order, and inside a group `_thin_to` is a pure function
        # of the coordinates.
        accepted: list[Powerup] = []
        taken: list[tuple[float, float]] = []
        for key in sorted(groups):
            members = groups[key]
            kept = _thin_to(members, MAX_PER_STATION)
            self.stats["drop_per_station"] += len(members) - len(kept)
            for m in kept:
                if any(
                    math.hypot(m.east - e, m.north - n) < DEDUPE_RADIUS for e, n in taken
                ):
                    self.stats["drop_proximity"] += 1
                    continue
                east, north = self._free_point(m.east, m.north, SNAP_REACH_STATION)
                taken.append((east, north))
                accepted.append(
                    Powerup(
                        east=east,
                        north=north,
                        ground_y=self._footpath_y(east, north),
                        kind=TRAINING,
                        name=m.name,
                        station=station_of.get(key),
                        source="entrance" if m.kind == "station_entrance" else "station",
                    )
                )
        return accepted

    # --- Cafes ----------------------------------------------------------------

    def _resolve_cafes(self, cafes: list[osm.OsmPoi]) -> list[Powerup]:
        """Every mapped cafe, deduplicated at shopfront scale and stood outside.

        No selection at all beyond the duplicate test, and that is the point:
        spec 8.3 calls these the abundant pickup, so thinning them by any rule
        would be inventing scarcity the city does not have.
        """
        out: list[Powerup] = []
        taken: list[tuple[float, float]] = []
        # Positional order, so the survivor of a duplicate pair does not depend
        # on which way the reader happened to return them.
        for c in sorted(cafes, key=lambda p: (p.east, p.north)):
            if any(math.hypot(c.east - e, c.north - n) < CAFE_DEDUPE for e, n in taken):
                self.stats["drop_cafe_duplicate"] += 1
                continue
            east, north = self._free_point(c.east, c.north, SNAP_REACH_CAFE)
            taken.append((east, north))
            out.append(
                Powerup(
                    east=east,
                    north=north,
                    ground_y=self._footpath_y(east, north),
                    kind=FLAT_WHITE,
                    name=c.name,
                    source="cafe",
                )
            )
        return out

    # --- Standing it on the ground --------------------------------------------

    def _free_point(self, east: float, north: float, reach: float) -> tuple[float, float]:
        """The nearest place outside a building, preferring paving. See the header.

        Returns the input unchanged when it is already clear, and also when
        nothing inside `SNAP_REACH_WIDE` is clear at all -- the conservative
        direction, and counted either way.
        """
        p = Point(east, north)
        disc = p.buffer(reach, quad_segs=16)
        obstacles = self._footprints_near(disc)
        if not obstacles:
            self.stats["snap_as_mapped"] += 1
            return east, north

        blocked = unary_union([f.buffer(CLEARANCE) for f in obstacles])
        if not blocked.covers(p):
            self.stats["snap_as_mapped"] += 1
            return east, north

        free = disc.difference(blocked)
        if free.is_empty:
            # Inside a city block. Widen once, and only once -- see
            # `SNAP_REACH_WIDE` for why this is a second stage rather than a
            # bigger first one.
            disc = p.buffer(SNAP_REACH_WIDE, quad_segs=24)
            wide = self._footprints_near(disc)
            blocked = unary_union([f.buffer(CLEARANCE) for f in wide]) if wide else None
            free = disc if blocked is None else disc.difference(blocked)
            if free.is_empty:
                self.stats["snap_failed"] += 1
                return east, north
            self.stats["snap_wide"] += 1

        paving = self._paving_near(disc)
        paved = free if paving is None else free.intersection(paving)
        if paved.is_empty:
            target = free
            self.stats["snap_open"] += 1
        else:
            target = paved
            self.stats["snap_footpath"] += 1

        q = nearest_points(p, target)[1]
        self.snap_distances.append(float(p.distance(q)))
        return float(q.x), float(q.y)

    def _footprints_near(self, region: BaseGeometry) -> list[Polygon]:
        if self._footprint_tree is None:
            return []
        return [
            f
            for i in self._footprint_tree.query(region)
            for f in (self._footprints[int(i)],)
            if f.intersects(region)
        ]

    def _paving_near(self, region: BaseGeometry) -> BaseGeometry | None:
        """Carriageway plus footpath over every way reaching this disc.

        Built from `StreetNetwork`'s own centreline, half width and footpath
        width rather than from a re-derived offset, on exactly the argument
        `power.py` makes about the kerb: the surface a player stands on is the
        one the pipeline actually drew, so ask the module that drew it.
        """
        probe = region.buffer(PAVING_MARGIN)
        bands = []
        for i in self._streets.ways_near(probe):
            reach = (
                self._streets.half_width(i)
                + streets.KERB_WIDTH
                + self._streets.footpath_width(i)
            )
            bands.append(self._streets.centreline(i).buffer(reach, quad_segs=6))
        if not bands:
            return None
        return unary_union(bands)

    def _footpath_y(self, east: float, north: float) -> float:
        """Absolute y of the paving. `furniture._footpath_y`, restated for the
        one reason that module's comment gives: a powerup snapped clear of a
        building stands on the footpath, not in the ground under it."""
        ground = 0.0 if self._terrain is None else float(self._terrain.sample(east, north))
        return ground + streets.FOOTPATH_Y


# --- Helpers ------------------------------------------------------------------


def _thin_to(items: list[osm.OsmPoi], limit: int) -> list[osm.OsmPoi]:
    """Keep `limit` of these, the ones furthest apart.

    Farthest-point sampling from the centroid outward, which is O(n*limit) on
    n <= 10 and is the only rule that gives the answer this needs: taking the
    first four in list order picks four entrances at one end of Wynyard, and
    taking four at random is not reproducible. Starting from the point furthest
    from the group's own centroid rather than from an arbitrary member is what
    makes it a pure function of the coordinates.
    """
    if len(items) <= limit:
        return list(items)
    cx = sum(p.east for p in items) / len(items)
    cy = sum(p.north for p in items) / len(items)
    remaining = sorted(items, key=lambda p: (p.east, p.north))
    first = max(remaining, key=lambda p: math.hypot(p.east - cx, p.north - cy))
    kept = [first]
    remaining.remove(first)
    while len(kept) < limit and remaining:
        nxt = max(
            remaining,
            key=lambda p: min(math.hypot(p.east - k.east, p.north - k.north) for k in kept),
        )
        kept.append(nxt)
        remaining.remove(nxt)
    return kept


def _tile_key_of(east: float, north: float) -> str:
    s = config.TILE_SIZE
    return f"{math.floor(east / s)}_{math.floor(north / s)}"


def load_powerup_pois(radius_m: float) -> tuple[list[osm.OsmPoi], list[osm.OsmPoi]]:
    """The two readers this module needs, in one call.

    Returns `(point_pois, station_areas)`. The first is `osm.read_pois` whole --
    `PowerupNetwork` does its own filtering because it needs three of the kinds
    and the caller should not have to know which. The second is the closed ways
    the header explains, and it is the only reason `osm.read_station_areas`
    exists at all.
    """
    return osm.read_pois(radius_m), osm.read_station_areas(radius_m)


def _tile_bounds(tile_key: str) -> tuple[float, float, float, float]:
    """Only used by the self-test below; kept beside `_tile_key_of` so the two
    conventions cannot drift."""
    tx, tz = (int(v) for v in tile_key.split("_"))
    s = config.TILE_SIZE
    return (tx * s, tz * s, (tx + 1) * s, (tz + 1) * s)


def audit_tiling(net: PowerupNetwork) -> list[str]:
    """Every point is inside the tile it was filed under, and in exactly one.

    Cheap, and it guards the one thing about this module that could be wrong
    without a picture: a point filed a tile off is a powerup the client never
    fetches, because the streamer only asks for `.pow.bin` on tiles whose index
    entry says they have some.
    """
    failures: list[str] = []
    seen: set[int] = set()
    for key, points in net._by_tile.items():
        e0, n0, e1, n1 = _tile_bounds(key)
        region = box(e0, n0, e1, n1)
        for p in points:
            if not (e0 <= p.east < e1 and n0 <= p.north < n1):
                failures.append(
                    f"powerup at ({p.east:.1f}, {p.north:.1f}) is filed under tile {key},"
                    f" whose bounds are {region.bounds}."
                )
            ident = id(p)
            if ident in seen:
                failures.append(f"powerup at ({p.east:.1f}, {p.north:.1f}) is in two tiles.")
            seen.add(ident)
    return failures
