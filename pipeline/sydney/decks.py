"""Elevated road decks: the bridges and viaducts, taken off the ground.

Every way OSM tags `bridge` or `viaduct` was, until this module, drawn as
ordinary asphalt draped on the terrain. `roadgrade.py` had already -- correctly
-- excluded them from the street-elevation solve, on the grounds that a deck's
height is not a statement about the ground under it; but nothing then took them
off the ground, so the exclusion only made them worse. The measured result over
the inner ring, from `road-grade-audit`:

    bridges   grade  p50 2.96%  p95 11.41%  p99 32.57%  max 52.58%
              bank   p50 2.62%  p95 11.20%  p99 39.14%  max 44.73%

-- which is the Western Distributor banked at 43% across Darling Harbour, the
Cahill Expressway climbing a 52% cliff out of Circular Quay, and 783 m2 of
asphalt lying on the water under the Anzac Bridge approach. None of those is a
road with an error in it. They are roads drawn in the wrong place.

So this module does the other half: it takes the bridge ways out of
`streets.py`'s ground union (see `StreetNetwork._build_surfaces`) and rebuilds
them as **decks** -- a ribbon at its own solved elevation, with a girder, solid
parapets, piers to the ground, and collision that a player can stand on and walk
under.

---------------------------------------------------------------------------
**Where the elevation comes from: the graph already knows.**

A bridge does not need a new source of truth, because the thing that decides its
height is where it lands. A bridge way's end nodes are shared -- as exact
coordinates, the same float twice, `roadgrade._graph`'s argument -- with the
ground ways it joins, and those ways have a solved elevation that the terrain
has already been conformed onto. So a touchdown is not estimated; it is *read*,
as `terrain.sample(node) + streets.CARRIAGEWAY_Y`, which is exactly the height
the ground asphalt is drawn at. **A deck therefore meets the road at both ends
with no lip at all**, and that continuity is the one property in this module
worth more than any other -- a 2 cm step at 12 m/s is a stumble the player
cannot see the cause of.

Between the touchdowns the profile is solved rather than interpolated, because
the interesting cases are not single spans. 120 of the 264 bridge carriageways in
the inner ring touch no ground way at either end: the Western Distributor's ramp
stack and the Cahill Expressway are *chains* of bridge ways, kilometres long,
whose only contact with the ground is at the far ends. So the bridge ways are
wired into their own graph -- one node per shared coordinate, exactly as the
street solve does it -- and every free node is solved by

  1. a weighted harmonic interpolation from the pinned touchdowns, which on a
     straight chain is a straight grade between them and on a branch hanging off
     one is flat at the junction's height, which is what a ramp gore is;
  2. a lift so no deck is under the ground it flies over;
  3. a two-sided Lipschitz projection at `MAX_GRADE`, pins held, which is
     `roadgrade._lipschitz`'s machinery at a tighter ceiling -- 7% rather than
     15%, because a structure is graded to a design standard where a street is
     graded to whatever the hill does.

The pins are not moved by any of the three. Where a touchdown genuinely demands
more than 7% -- a short ramp off a high viaduct -- the clamp gives way and the
touchdown wins, which is the right way round.

---------------------------------------------------------------------------
**What is suppressed, and why the Harbour Bridge is not here.**

`landmarks.py` builds the Harbour Bridge by hand, deck included, and its deck is
already walkable collision. The OSM ways for the Bradfield Highway and the Cahill
approach run straight down the middle of it, so a generic deck built from them
would stand inside the hero one -- two decks, z-fighting, at 49 m over the
harbour. Every bridge centreline is therefore **clipped** against the hero
bridge's plan footprint before anything else happens, and the parts outside it
survive. Clipped rather than dropped whole: `Bradfield Highway` is a 1,147 m way
of which 605 m is the hero's, and the 542 m of approach viaduct at Milsons Point
is a real elevated road that nothing else would draw.

---------------------------------------------------------------------------
**Materials, and why no slot was appended.** The running surface is
`road_asphalt` and everything structural is `footpath_concrete` -- both already
street slots, both already `building_indexed = False`. A `deck_concrete` slot
would have been nicer to look at and would have cost a lockstep change to
`client/src/world/streamer.ts`'s shared-material map and to `far.ts`'s
`FAR_TINT` length guard, which is import-time fatal if it is missed. A girder
soffit in footpath concrete reads as formwork; that is a trade worth taking to
leave the client untouched.

**Collision is the format that already shipped.** A deck segment is a
`landmarks.Prism` -- a plan ring and `[base, base + height]` -- which is what
`tiles.write_collision` has written since terrain arrived and what the Harbour
Bridge's own deck is made of. `base` at the soffit puts the volume over a
player's head so they walk under it; the top is standable through
`CollisionWorld.roofHeight`. Nothing about the payload changes.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union

from . import geo, streets
from .sources import osm

# --- The profile solve ---------------------------------------------------------

# Stations along a deck, metres. Half `roadgrade.STATION_M`, and it is the
# collision that sets it rather than the geometry: a prism has one `base` and one
# `height`, so a sloping deck is a staircase whose step is `station * grade`.
# `player/controller.ts` steps 0.42 m without help, so at the 7% ceiling below a
# 6 m station gives a 0.42 m step exactly at the worst case and less everywhere
# else. `landmarks._deck_run` picked the same number for the same reason.
STATION_M = 6.0

# The grade ceiling on a solved deck.
#
# 7% rather than the streets' 15%, because the two are different objects: a
# street is graded to whatever the hill does and Sydney's hills reach 1:6.5, and
# a structure is graded to a design standard. Austroads' desirable maximum for a
# motorway grade is 6% and the Cahill Expressway's own ramps are about 5.5%,
# which is the number `landmarks.py` builds the Harbour Bridge's approaches at.
#
# It is a ceiling on the *free* nodes only. A touchdown is a measurement and is
# never moved to satisfy it -- see the header.
MAX_GRADE = 0.07

# Sweeps allowed for the Lipschitz projection. A violation propagates one edge a
# sweep; the longest bridge chain in the extent is the Western Distributor's, at
# about 3 km, which is 500 stations.
MAX_SWEEPS = 600

# Iterations of the harmonic solve. It is a conjugate gradient on a graph
# Laplacian of a few thousand nodes, which converges in tens; the cap is a
# guard rather than a budget.
MAX_CG = 400

# Rounds of "lift clear of the ground, then clamp the grade". See `_solve`.
FLOOR_ROUNDS = 3

# --- The structure -------------------------------------------------------------

# How far the deck's structural edge stands outside the carriageway it carries,
# metres. A bridge is wider than its traffic lanes -- the barrier, the kerb and
# the edge beam all live out here -- and without it the parapet would stand on
# the outside lane.
EDGE_MARGIN_M = 0.6

# The girder, metres deep. A real box girder under a 12 m urban viaduct is 1.2 to
# 1.8 m; this is the shallow end of that because the number that matters is the
# *soffit*, and a deeper girder eats the clearance a player walks under.
GIRDER_DEPTH_M = 1.0

# How far the soffit may sink below the ground before it is clamped up, metres.
#
# A bridge way at grade -- a culvert crossing, which is what the median 33 m
# bridge way in this extent is -- would otherwise bury a metre of fascia in the
# terrain to draw nothing. Clamped here it becomes a 25 cm edge beam, which is
# what the parapet of an at-grade crossing looks like.
GIRDER_BURY_M = 0.25

# The parapet: a solid barrier the player cannot walk off and can still jump.
PARAPET_HEIGHT_M = 1.05
PARAPET_THICK_M = 0.40

# The clearance under the deck below which no parapet is drawn, metres.
#
# The point at which a "bridge" stops being a structure and becomes a piece of
# road over a pipe. Drawing a barrier down both sides of a 30 m culvert crossing
# in a suburban street puts a wall across every driveway on it.
PARAPET_MIN_CLEARANCE_M = 0.8

# Piers: how far apart, how big, and the clearance under which none is drawn.
#
# 30 m is a plausible span for a concrete viaduct and is what the Western
# Distributor actually uses through Darling Harbour. Piers stand in water quite
# happily and are meant to -- most of that viaduct's do.
PIER_SPACING_M = 30.0
PIER_ALONG_M = 1.8
PIER_ACROSS_M = 2.6
PIER_MIN_CLEARANCE_M = 2.5
# How far a pier is sunk below the ground so it never stands on a visible sliver
# of its own base where the terrain facet under it tilts.
PIER_BURY_M = 1.5

# --- Collision -----------------------------------------------------------------

# The rise over the ground at which a deck earns a collision prism, metres.
#
# Under it the terrain is already the floor and a prism 2 cm over it would be a
# volume that does nothing. Over it the player has to be stood on the deck rather
# than on the ground beneath it.
PRISM_MIN_RISE_M = 0.35

# The clearance at which the prism's base lifts off the ground, metres.
#
# Below this the prism runs from the ground up, which makes the touchdown ramp a
# solid embankment the player walks up continuously; above it the base is the
# soffit and the player walks *under* the deck. 2.6 m clears a 1.8 m player with
# room to jump, and the transition is continuous because the two forms share the
# same top.
WALK_UNDER_M = 2.6

# --- Suppression ---------------------------------------------------------------

# How far past the hero bridge's own plan a generic deck is still suppressed.
SUPPRESS_MARGIN_M = 8.0

# Runs shorter than this, left over after the hero clip, are dropped: a 4 m stub
# of viaduct is two triangles and a collision prism describing nothing.
MIN_RUN_M = 8.0

SLOT_DECK = "road_asphalt"
SLOT_STRUCTURE = "footpath_concrete"


@dataclass
class DeckRun:
    """One continuous elevated run, solved and stationed.

    A *run* rather than a way: the hero clip can cut one OSM way into two pieces
    either side of the Harbour Bridge, and each piece is its own ribbon.
    """

    road: osm.OsmRoad
    pts: np.ndarray  # (N, 2) station centres, ENU
    deck_y: np.ndarray  # (N,) running surface, world metres
    ground: np.ndarray  # (N,) terrain under each station
    half_width: float  # to the structural edge, not the traffic lane

    @property
    def length(self) -> float:
        return float(np.hypot(*np.diff(self.pts, axis=0).T).sum())

    @property
    def clearance(self) -> np.ndarray:
        return self.deck_y - self.ground


class DeckNetwork:
    """Every bridge carriageway in the extent, as a solved elevated deck."""

    def __init__(self, runs: list[DeckRun], stats: dict) -> None:
        self.runs = runs
        self.stats = stats
        self._by_tile: dict[str, list[tuple[DeckRun, int, int]]] | None = None

    # --- Construction ---------------------------------------------------------

    @classmethod
    def load(
        cls,
        radius_m: float,
        terrain,
        suppress: Polygon | None = None,
        roads: list[osm.OsmRoad] | None = None,
    ) -> DeckNetwork:
        """Solve every bridge way in the extent against the conformed ground.

        `terrain` must be the *conformed* lattice -- the one `Terrain.load`
        returns and every other module reads -- because the touchdown heights are
        read straight off it and a deck solved against the raw DEM would land a
        couple of metres away from the asphalt it is supposed to meet.
        """
        if roads is None:
            roads = osm.read_roads(radius_m)
        bridges = [r for r in roads if _is_deck(r)]
        ground_nodes = {
            _key(p)
            for r in roads
            if _is_ground_carriageway(r)
            for p in r.line
        }

        clipped: list[tuple[osm.OsmRoad, np.ndarray]] = []
        suppressed_m = 0.0
        for r in bridges:
            line = LineString(r.line)
            if suppress is not None and suppress.intersects(line):
                inside = line.intersection(suppress)
                suppressed_m += float(getattr(inside, "length", 0.0))
                outside = line.difference(suppress)
            else:
                outside = line
            for piece in _linestrings(outside):
                pts = np.asarray(piece.coords, dtype=np.float64)
                if len(pts) >= 2 and piece.length >= MIN_RUN_M:
                    clipped.append((r, pts))

        runs, solve_stats = _solve(clipped, ground_nodes, terrain)
        stats = {
            "bridge_ways": len(bridges),
            "bridge_length_m": sum(
                float(np.hypot(*np.diff(r.line, axis=0).T).sum()) for r in bridges
            ),
            "suppressed_m": suppressed_m,
            "runs": len(runs),
            "deck_length_m": sum(r.length for r in runs),
            **solve_stats,
        }
        if runs:
            grade = np.concatenate(
                [np.abs(np.diff(r.deck_y)) / np.maximum(np.hypot(*np.diff(r.pts, axis=0).T), 1e-6)
                 for r in runs if len(r.pts) > 1]
            )
            clear = np.concatenate([r.clearance for r in runs])
            stats.update(
                grade_p50=float(np.percentile(grade, 50)),
                grade_p95=float(np.percentile(grade, 95)),
                grade_max=float(grade.max()),
                over_max=int((grade > MAX_GRADE + 1e-6).sum()),
                segments=len(grade),
                clear_p50=float(np.percentile(clear, 50)),
                clear_max=float(clear.max()),
                clear_min=float(clear.min()),
                elevated_share=float((clear > PARAPET_MIN_CLEARANCE_M).mean()),
            )
        return cls(runs, stats)

    def __len__(self) -> int:
        return len(self.runs)

    # --- Tile coverage --------------------------------------------------------

    def _index(self) -> dict[str, list[tuple[DeckRun, int, int]]]:
        """Segments grouped by the tile holding their midpoint, in run order.

        A segment belongs to one tile and one only, which is the same rule
        `landmarks.prisms_by_tile` uses for the Harbour Bridge's deck and is what
        makes walking a viaduct across a seam walking off one tile's prisms and
        onto the next's. The value is a list of `(run, first, last)` station
        spans so a tile can emit each of its pieces as one welded strip rather
        than as a pile of loose quads.
        """
        if self._by_tile is not None:
            return self._by_tile
        out: dict[str, list[tuple[DeckRun, int, int]]] = {}
        for run in self.runs:
            mid = 0.5 * (run.pts[:-1] + run.pts[1:])
            keys = [geo.tile_for_enu(float(e), float(n)).key for e, n in mid]
            start = 0
            for k in range(1, len(keys) + 1):
                if k == len(keys) or keys[k] != keys[start]:
                    out.setdefault(keys[start], []).append((run, start, k))
                    start = k
        self._by_tile = out
        return out

    def tile_keys(self) -> set[str]:
        return set(self._index())

    def height_max(self, tile_key: str) -> float:
        """How far this tile's tallest deck stands over the ground under it.

        A *height*, not a world y, because that is what `TileResult.height_max`
        means everywhere else -- it is a building's storey height, and the client
        sizes each tile's cull box from it against the tile's own ground range.
        A tile that is nothing but harbour and a viaduct has no building at all,
        so without this the Western Distributor over Darling Harbour is culled
        the moment the player is not standing on it.
        """
        spans = self._index().get(tile_key)
        if not spans:
            return 0.0
        return max(
            float(run.clearance[lo : hi + 1].max()) + PARAPET_HEIGHT_M for run, lo, hi in spans
        )

    # --- Collision ------------------------------------------------------------

    def prisms(self, tile_key: str) -> list:
        """This tile's deck and parapet volumes, as `landmarks.Prism` records.

        One prism per segment, its top at the segment's midpoint, which is what
        makes a sloping deck a staircase the player can walk -- see `STATION_M`
        for why 6 m is the step. A segment lying on the ground gets none at all:
        the terrain is already the floor there, and a volume 2 cm over it would
        do nothing but cost bytes.

        **The base is the soffit only where there is room to walk under it.**
        Below `WALK_UNDER_M` of headroom the prism runs from just under the
        ground instead, which turns the touchdown ramp into a solid embankment --
        and that is a continuity requirement rather than a nicety: a prism whose
        base is over the player's head is one they walk *under*, so a ramp that
        switched to a floating deck at 1 m of clearance would be a road the
        player falls through for its first ten metres. The two forms share the
        same top, so the transition is seamless.
        """
        from .landmarks import Prism

        out: list = []
        for run, lo, hi in self._index().get(tile_key, []):
            hw = run.half_width
            for i in range(lo, hi):
                a, c = run.pts[i], run.pts[i + 1]
                rise = max(run.clearance[i], run.clearance[i + 1])
                if rise < PRISM_MIN_RISE_M:
                    continue
                top = 0.5 * (run.deck_y[i] + run.deck_y[i + 1])
                ground = 0.5 * (run.ground[i] + run.ground[i + 1])
                soffit = top - GIRDER_DEPTH_M
                base = soffit if soffit - ground >= WALK_UNDER_M else ground - 0.5
                ring = _segment_ring(a, c, hw)
                out.append(Prism(ring, float(base), float(top - base), "deck"))
                if min(run.clearance[i], run.clearance[i + 1]) >= PARAPET_MIN_CLEARANCE_M:
                    for side in (1.0, -1.0):
                        off = side * (hw - PARAPET_THICK_M * 0.5)
                        out.append(
                            Prism(
                                _segment_ring(a, c, PARAPET_THICK_M * 0.5, offset=off),
                                float(top),
                                PARAPET_HEIGHT_M,
                                "parapet",
                            )
                        )
        return out

    # --- Emission -------------------------------------------------------------

    def emit(self, tile_key: str, slots: dict, origin: tuple[float, float]) -> None:
        """Tessellate this tile's share of every deck crossing it.

        Takes no terrain, unlike `streets.StreetNetwork.emit`, and the absence is
        the point: a deck is the one paved surface in the build that is *not*
        draped, so there is nothing to cut against the terrain's facets and no
        clearance to keep over them. Its height came out of the solve and the
        ground under it is only ever consulted for where to stop a pier.
        """
        spans = self._index().get(tile_key)
        if not spans:
            return
        for slot in (SLOT_DECK, SLOT_STRUCTURE):
            slots[slot].building_indexed = False
        for run, lo, hi in spans:
            _emit_run(slots, run, lo, hi, origin)


# --- Selection -----------------------------------------------------------------


def _is_deck(r: osm.OsmRoad) -> bool:
    """A carriageway carried over something else.

    Footways are out, and the omission is deliberate rather than an oversight: a
    footbridge is 2 m wide, there are 670 of them in the inner ring against 264
    carriageways, and a deck with a girder and piers under a park footbridge is
    more wrong than the draped ribbon it would replace. They keep draping, which
    is what `roadgrade.py` decided about footways for its own reasons.

    Tunnelled and below-ground ways are out because they carry no surface at all
    -- `streets.StreetNetwork.load` has always dropped them.
    """
    return r.bridge and not r.is_foot and not r.tunnel and r.layer >= 0


def _is_ground_carriageway(r: osm.OsmRoad) -> bool:
    """A way whose elevation the terrain has been conformed onto.

    Exactly `roadgrade._is_conformable`, restated here rather than imported so
    the two can be seen to be the same set: these are the ways whose solved
    height the ground already carries, which is what makes a touchdown readable
    off `terrain.sample` instead of estimated.
    """
    return r.layer >= 0 and not r.tunnel and not r.bridge and not r.is_foot


def _key(p) -> tuple[int, int]:
    """A vertex's identity, to the millimetre -- `roadgrade._key`'s rule.

    Two ways that meet share the OSM node they meet at, and a shared node is the
    same geodetic coordinate through the same transform, so it is the same float
    twice. Rounding finds it exactly rather than within a tolerance.
    """
    return (round(float(p[0]) * 1000.0), round(float(p[1]) * 1000.0))


def _linestrings(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    if hasattr(geom, "geoms"):
        out: list[LineString] = []
        for part in geom.geoms:
            out.extend(_linestrings(part))
        return out
    return []


def hero_bridge_zone(anchors: dict, zones: dict) -> Polygon:
    """The plan the Harbour Bridge's own deck occupies, as one polygon.

    `landmarks.suppression_zones`' bridge zone is the two pylon pairs and the OSM
    deck outline, and it is deliberately *not* the whole corridor -- its job is
    to stop a generic building standing inside a pylon, and the terraces under
    the approach viaducts are real. That is the wrong shape for this: the hero
    model builds `BRIDGE_TOTAL_LENGTH` of deck, 1,149 m including both approach
    viaducts, and every metre of it would have a generic deck inside it.

    So the zone is unioned with the hero deck's own footprint, taken from the
    same frame `landmarks.build_bridge` builds it in -- the two pylon centroids
    -- so the two cannot drift apart.
    """
    from . import landmarks as lm

    centre, along, across = lm._bridge_frame(anchors)
    half_len = lm.BRIDGE_TOTAL_LENGTH * 0.5
    half_w = lm.BRIDGE_DECK_WIDTH * 0.5 + SUPPRESS_MARGIN_M
    corners = [
        centre + along * s + across * t
        for s, t in ((-half_len, -half_w), (half_len, -half_w), (half_len, half_w), (-half_len, half_w))
    ]
    merged = unary_union([Polygon(corners), zones["bridge"]])
    return merged if merged.geom_type == "Polygon" else merged.convex_hull


# --- The solve -----------------------------------------------------------------


def _solve(clipped, ground_nodes: set, terrain) -> tuple[list[DeckRun], dict]:
    """Station every run, wire them into one graph, and solve the profile."""
    if not clipped:
        return [], {"nodes": 0, "pinned": 0, "components": 0, "unpinned_components": 0}

    # Which vertices are junctions, so a station always lands on one: a way
    # ending in the middle of another way has to be one unknown, not two.
    seen: dict[tuple[int, int], int] = {}
    for _, pts in clipped:
        for k in {_key(p) for p in pts}:
            seen[k] = seen.get(k, 0) + 1

    node_id: dict[tuple[int, int], int] = {}
    stations: list[np.ndarray] = []
    node_of: list[np.ndarray] = []
    edges: list[tuple[int, int]] = []
    edge_len: list[float] = []
    n_nodes = 0

    for _, pts in clipped:
        ss, sp = _stations(pts, seen, ground_nodes)
        ids = np.empty(len(sp), dtype=np.int64)
        for k, p in enumerate(sp):
            key = _key(p)
            # Only a *shared* coordinate is a shared unknown. A uniform station
            # in the middle of a span is unique to its own run by construction,
            # and keying it would weld two viaducts that happen to cross in plan.
            if seen.get(key, 0) > 1 or key in ground_nodes:
                nid = node_id.get(key)
                if nid is None:
                    nid = node_id[key] = n_nodes
                    n_nodes += 1
            else:
                nid = n_nodes
                n_nodes += 1
            ids[k] = nid
        for k in range(len(sp) - 1):
            if ids[k] != ids[k + 1]:
                edges.append((int(ids[k]), int(ids[k + 1])))
                edge_len.append(float(ss[k + 1] - ss[k]))
        stations.append(sp)
        node_of.append(ids)

    edge = np.asarray(edges, dtype=np.int64).reshape(-1, 2)
    elen = np.maximum(np.asarray(edge_len, dtype=np.float64), 1e-3)

    pos = np.zeros((n_nodes, 2))
    for sp, ids in zip(stations, node_of):
        pos[ids] = sp
    ground = np.asarray(terrain.sample(pos[:, 0], pos[:, 1]), dtype=np.float64)

    pinned = np.zeros(n_nodes, dtype=bool)
    for key, nid in node_id.items():
        if key in ground_nodes:
            pinned[nid] = True
    h = ground + streets.CARRIAGEWAY_Y

    comps, n_comp, unpinned = _components(edge, n_nodes, pinned)
    # A component that reaches no ground way at all -- a ramp whose only other
    # end is a tunnel portal, or a viaduct cut by the extent edge. Its dangling
    # ends are pinned to the ground instead, which is where a ramp does in fact
    # go; a component with no dangling end either (a closed loop of viaduct, of
    # which there are none here) takes its lowest node.
    if unpinned:
        degree = np.bincount(edge.ravel(), minlength=n_nodes)
        for c in unpinned:
            members = np.flatnonzero(comps == c)
            ends = members[degree[members] <= 1]
            pinned[ends if len(ends) else members[np.argmin(ground[members])]] = True

    # Harmonic first, then the floor and the clamp **alternately**, ending on the
    # floor. The order is not cosmetic and the single pass it replaces was wrong:
    # the Lipschitz projection lowers nodes, so lifting a dipped span clear of
    # the ground and then clamping put five viaducts back under it -- up to
    # 1.14 m on the Cahill's 417 m run, which is a buried deck with a hole in the
    # road over it, since `streets.py` has already stopped drawing ground asphalt
    # there. Alternating converges in two rounds and the third is the guard;
    # what is left over after the last floor is the terrain's own grade under a
    # deck that is lying on it, which is a crossing at grade and not a defect.
    h = _harmonic(h, edge, elen, pinned)
    free = ~pinned
    floor = ground + streets.CARRIAGEWAY_Y
    for _ in range(FLOOR_ROUNDS):
        h[free] = np.maximum(h[free], floor[free])
        h = _lipschitz(h, edge, MAX_GRADE * elen, pinned)
    h[free] = np.maximum(h[free], floor[free])

    runs: list[DeckRun] = []
    for (road, _), sp, ids in zip(clipped, stations, node_of):
        if len(sp) < 2:
            continue
        runs.append(
            DeckRun(
                road=road,
                pts=sp,
                deck_y=h[ids].copy(),
                ground=ground[ids].copy(),
                half_width=_half_width(road),
            )
        )
    return runs, {
        "nodes": int(n_nodes),
        "pinned": int(pinned.sum()),
        "components": int(n_comp),
        "unpinned_components": len(unpinned),
    }


def _half_width(r: osm.OsmRoad) -> float:
    """Half the structure, metres -- the carriageway plus its edge beam.

    The carriageway half is `streets.py`'s own clamp, read from that module so
    the deck and the ground road it meets are the same width at the touchdown
    and the seam between them is a seam rather than a step sideways.
    """
    lane = min(max(r.width, streets.MIN_ROAD_WIDTH), streets.MAX_ROAD_WIDTH) * 0.5
    return lane + EDGE_MARGIN_M


def _stations(pts: np.ndarray, seen: dict, ground_nodes: set) -> tuple[np.ndarray, np.ndarray]:
    """Uniform stations along a run, with every junction vertex folded in.

    `roadgrade._graph`'s rule, and for its reason: a T-junction into the middle
    of a way has to land *on* a station or the two ways cannot share an unknown.
    A junction always wins the slot it lands in, and a uniform station within a
    metre of one is dropped -- a 1 cm edge would be a weld the smoother cannot
    tell from a real one.
    """
    step = np.hypot(*np.diff(pts, axis=0).T)
    s = np.concatenate(([0.0], np.cumsum(step)))
    total = float(s[-1])
    want = list(np.linspace(0.0, total, max(round(total / STATION_M) + 1, 2)))
    forced: dict[float, bool] = {}
    for k, p in enumerate(pts):
        key = _key(p)
        if seen.get(key, 0) > 1 or key in ground_nodes or k in (0, len(pts) - 1):
            want.append(float(s[k]))
            forced[round(float(s[k]), 6)] = True
    want.sort()
    keep = [want[0]]
    for v in want[1:]:
        if v - keep[-1] > 1.0:
            keep.append(v)
        elif round(v, 6) in forced:
            keep[-1] = v
    ss = np.asarray(keep)
    idx = np.clip(np.searchsorted(s, ss, side="right") - 1, 0, len(step) - 1)
    frac = (ss - s[idx]) / np.where(step[idx] > 0.0, step[idx], 1.0)
    return ss, pts[idx] + (pts[idx + 1] - pts[idx]) * frac[:, None]


def _components(edge: np.ndarray, n: int, pinned: np.ndarray):
    """Connected components of the deck graph, and which of them hold no pin."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components

    if len(edge) == 0:
        return np.arange(n), n, [c for c in range(n) if not pinned[c]]
    g = coo_matrix(
        (np.ones(len(edge)), (edge[:, 0], edge[:, 1])), shape=(n, n)
    )
    n_comp, labels = connected_components(g, directed=False)
    has_pin = np.zeros(n_comp, dtype=bool)
    np.logical_or.at(has_pin, labels, pinned)
    return labels, n_comp, [int(c) for c in np.flatnonzero(~has_pin)]


def _harmonic(h: np.ndarray, edge: np.ndarray, elen: np.ndarray, pinned: np.ndarray) -> np.ndarray:
    """Interpolate the free nodes from the pinned ones over the graph.

    Minimises `sum_edges (h_j - h_i)^2 / len` with the pinned values held, which
    on a straight chain between two touchdowns is a constant grade and on a
    branch hanging off one is flat at the junction's height. That second case is
    the one worth naming: a ramp gore where three bridge ways meet and only the
    trunk reaches the ground gets the trunk's height across the whole gore, which
    is what a gore is -- one surface, not three.

    Conjugate gradients on the free block, with the same argument
    `roadgrade._smooth` makes for it: the operator is symmetric positive definite
    once a component holds a pin, it never materialises a fill-in, and a fixed
    sequence of dot products on a fixed input returns the same floats every run.
    """
    free = ~pinned
    if not free.any() or len(edge) == 0:
        return h
    w = 1.0 / elen
    i, j = edge[:, 0], edge[:, 1]
    n = len(h)

    def lap(x: np.ndarray) -> np.ndarray:
        flow = w * (x[i] - x[j])
        return np.bincount(i, weights=flow, minlength=n) - np.bincount(
            j, weights=flow, minlength=n
        )

    fixed = np.where(pinned, h, 0.0)
    b = -lap(fixed)[free]
    diag = (np.bincount(i, weights=w, minlength=n) + np.bincount(j, weights=w, minlength=n))[free]
    diag = np.where(diag > 0.0, diag, 1.0)

    def matvec(xf: np.ndarray) -> np.ndarray:
        full = np.zeros(n)
        full[free] = xf
        return lap(full)[free]

    x = h[free].copy()
    r = b - matvec(x)
    m = 1.0 / diag
    zr = m * r
    p = zr.copy()
    rz = float(r @ zr)
    for _ in range(MAX_CG):
        if rz <= 1e-14 * max(len(b), 1):
            break
        ap = matvec(p)
        denom = float(p @ ap)
        if abs(denom) < 1e-300:
            break
        alpha = rz / denom
        x += alpha * p
        r -= alpha * ap
        zr = m * r
        rz_next = float(r @ zr)
        p = zr + (rz_next / rz) * p
        rz = rz_next
    out = h.copy()
    out[free] = x
    return out


def _lipschitz(
    h: np.ndarray, edge: np.ndarray, limit: np.ndarray, pinned: np.ndarray
) -> np.ndarray:
    """The nearest profile obeying every edge's height budget, pins held fixed.

    `roadgrade._lipschitz`'s two one-sided projections and their average, with
    one difference that is the whole reason this is not a call into that module:
    **the pinned nodes are restored after every sweep.** A touchdown is a
    measurement of where the ground asphalt is, and a projection that moved it to
    satisfy a grade ceiling would buy a gentler ramp with a step at the bottom of
    it -- which is the one defect a player can feel and cannot see.

    So the budget is honoured everywhere it can be and gives way at a touchdown
    that genuinely demands more, which is the right way round: the Cahill
    Expressway's ramps really do climb 5.5% out of a portal that really is where
    it is.
    """
    if len(edge) == 0:
        return h
    i, j = edge[:, 0], edge[:, 1]
    hold = h[pinned]

    def relax(sign: float) -> np.ndarray:
        out = (sign * h).copy()
        held = sign * hold
        for _ in range(MAX_SWEEPS):
            before = out.sum()
            np.minimum.at(out, j, out[i] + limit)
            np.minimum.at(out, i, out[j] + limit)
            out[pinned] = held
            if out.sum() == before:
                break
        return sign * out

    return 0.5 * (relax(1.0) + relax(-1.0))


# --- Geometry ------------------------------------------------------------------


def _segment_ring(a: np.ndarray, b: np.ndarray, half: float, offset: float = 0.0) -> np.ndarray:
    """A plan rectangle covering one segment, `2 * half` wide, in ENU.

    `offset` slides it across the deck, which is what puts a parapet's volume on
    the edge rather than down the middle.
    """
    d = b - a
    n = float(np.hypot(d[0], d[1]))
    u = d / n if n > 1e-9 else np.array([1.0, 0.0])
    left = np.array([-u[1], u[0]])
    c = left * offset
    return np.asarray(
        [
            a + c - left * half,
            b + c - left * half,
            b + c + left * half,
            a + c + left * half,
        ],
        dtype=np.float64,
    )


def _frames(pts: np.ndarray) -> np.ndarray:
    """Unit left-of-travel plan normals at each station.

    Averaged across the two segments meeting at a station, so the ribbon's edges
    are continuous through a bend instead of stepping sideways by the width of
    the deck times the turn angle.
    """
    d = np.diff(pts, axis=0)
    n = np.hypot(d[:, 0], d[:, 1])
    u = d / np.where(n[:, None] > 1e-9, n[:, None], 1.0)
    acc = np.zeros_like(pts)
    acc[:-1] += u
    acc[1:] += u
    m = np.hypot(acc[:, 0], acc[:, 1])
    u = acc / np.where(m[:, None] > 1e-9, m[:, None], 1.0)
    return np.column_stack((-u[:, 1], u[:, 0]))


def _w(e: float, n: float, y: float, origin: tuple[float, float]) -> np.ndarray:
    """ENU + height -> the renderer's frame. x = east, y = up, z = -north."""
    return np.array([e - origin[0], y, -(n - origin[1])])


def _quad(buf, p0, p1, p2, p3, normal, origin) -> None:
    """One planar quad, wound so its face agrees with `normal`.

    The winding is *derived* rather than asserted: the cross product of the first
    two edges is tested against the intended normal and the ring reversed if they
    disagree. Every face in this module is built from a frame that flips sign
    with the direction of travel and with which side of the deck it is on, and
    working each of those out by hand is how a hole appears in one viaduct out of
    forty with nothing in the output to say so. `winding-audit` checks the
    result; this is what makes it pass by construction.

    UVs are in **world** metres, not tile-local, which is `streets._world_uv`'s
    convention and is load-bearing for the same reason: a deck's asphalt has to
    run in step with the asphalt it meets at the touchdown, and 500 m is not a
    whole number of lane markings. A vertical face takes its second coordinate
    from height, so the formwork joints on a fascia stay level.
    """
    pts = [np.asarray(p, dtype=np.float64) for p in (p0, p1, p2, p3)]
    nrm = np.asarray(normal, dtype=np.float64)
    mag = float(np.linalg.norm(nrm))
    if mag < 1e-12:
        return
    nrm = nrm / mag
    face = np.cross(pts[1] - pts[0], pts[2] - pts[0])
    if float(face @ nrm) < 0.0:
        pts = pts[::-1]
    verts = np.asarray(pts)
    wx = verts[:, 0] + origin[0]
    wz = verts[:, 2] - origin[1]
    if abs(nrm[1]) > 0.7:
        uv = np.column_stack((wx, wz))
    else:
        uv = np.column_stack((wx + wz, verts[:, 1]))
    buf.add_surface(verts, np.tile(nrm, (4, 1)), uv, np.asarray([[0, 1, 2], [0, 2, 3]]))


def _box(buf, ring: np.ndarray, base: float, top: float, origin) -> None:
    """A vertical prism from a plan ring -- the piers, and nothing else."""
    n = len(ring)
    centre = ring.mean(axis=0)
    for k in range(n):
        a, b = ring[k], ring[(k + 1) % n]
        mid = 0.5 * (a + b)
        out = mid - centre
        _quad(
            buf,
            _w(a[0], a[1], base, origin),
            _w(b[0], b[1], base, origin),
            _w(b[0], b[1], top, origin),
            _w(a[0], a[1], top, origin),
            (out[0], 0.0, -out[1]),
            origin,
        )


def _emit_run(slots, run: DeckRun, lo: int, hi: int, origin) -> None:
    """One tile's share of one deck: surface, girder, parapets and piers."""
    deck = slots[SLOT_DECK]
    struct = slots[SLOT_STRUCTURE]
    pts = run.pts
    left = _frames(pts)
    hw = run.half_width
    dy = run.deck_y
    clear = run.clearance
    # The soffit, clamped so an at-grade crossing draws an edge beam instead of
    # burying a metre of girder in the terrain. See `GIRDER_BURY_M`.
    soffit = np.maximum(
        dy - GIRDER_DEPTH_M, np.minimum(run.ground - GIRDER_BURY_M, dy - 0.05)
    )

    def edge_pt(i: int, side: float, y: float) -> np.ndarray:
        p = pts[i] + left[i] * (side * hw)
        return _w(p[0], p[1], y, origin)

    for i in range(lo, hi):
        j = i + 1
        # Running surface, up.
        _quad(
            deck,
            edge_pt(i, -1.0, dy[i]), edge_pt(j, -1.0, dy[j]),
            edge_pt(j, 1.0, dy[j]), edge_pt(i, 1.0, dy[i]),
            (0.0, 1.0, 0.0), origin,
        )
        # Soffit, down.
        _quad(
            struct,
            edge_pt(i, -1.0, soffit[i]), edge_pt(j, -1.0, soffit[j]),
            edge_pt(j, 1.0, soffit[j]), edge_pt(i, 1.0, soffit[i]),
            (0.0, -1.0, 0.0), origin,
        )
        # The two fascias.
        for side in (1.0, -1.0):
            out = left[i] * side
            _quad(
                struct,
                edge_pt(i, side, soffit[i]), edge_pt(j, side, soffit[j]),
                edge_pt(j, side, dy[j]), edge_pt(i, side, dy[i]),
                (out[0], 0.0, -out[1]), origin,
            )
        if min(clear[i], clear[j]) < PARAPET_MIN_CLEARANCE_M:
            continue
        # Parapets: a solid barrier standing on the deck's own edge. Three faces
        # -- outer, inner and cap -- and no end caps, because consecutive
        # segments abut and the run's two ends are either a touchdown or the
        # next tile's geometry.
        for side in (1.0, -1.0):
            out = left[i] * side
            outer = side * hw
            inner = side * (hw - PARAPET_THICK_M)
            for off, nrm in ((outer, out), (inner, -out)):
                _quad(
                    struct,
                    edge_pt(i, off / hw, dy[i]), edge_pt(j, off / hw, dy[j]),
                    edge_pt(j, off / hw, dy[j] + PARAPET_HEIGHT_M),
                    edge_pt(i, off / hw, dy[i] + PARAPET_HEIGHT_M),
                    (nrm[0], 0.0, -nrm[1]), origin,
                )
            _quad(
                struct,
                edge_pt(i, inner / hw, dy[i] + PARAPET_HEIGHT_M),
                edge_pt(j, inner / hw, dy[j] + PARAPET_HEIGHT_M),
                edge_pt(j, outer / hw, dy[j] + PARAPET_HEIGHT_M),
                edge_pt(i, outer / hw, dy[i] + PARAPET_HEIGHT_M),
                (0.0, 1.0, 0.0), origin,
            )

    _emit_piers(struct, run, lo, hi, soffit, origin)


def _emit_piers(struct, run: DeckRun, lo: int, hi: int, soffit, origin) -> None:
    """Rectangular piers to the ground, on the stations that carry one.

    Placed on stations rather than at a fixed chainage so a pier is always under
    a solved height rather than under an interpolation of two, and only where the
    soffit genuinely clears the ground -- a pier under an at-grade crossing is a
    block of concrete standing in the road.

    Piers stand **in water** wherever the deck does, and that is correct rather
    than tolerated: the Western Distributor's viaduct through Darling Harbour is
    carried on piers in the bay, and so is every other bridge in this extent that
    crosses one.
    """
    pts = run.pts
    step = np.hypot(*np.diff(pts, axis=0).T)
    chain = np.concatenate(([0.0], np.cumsum(step)))
    every = max(round(PIER_SPACING_M / STATION_M), 1)
    for i in range(lo, hi + 1):
        if i == 0 or i == len(pts) - 1:
            continue
        if round(float(chain[i]) / STATION_M) % every:
            continue
        if soffit[i] - run.ground[i] < PIER_MIN_CLEARANCE_M:
            continue
        ring = _segment_ring(
            pts[i] - _along(pts, i) * PIER_ALONG_M * 0.5,
            pts[i] + _along(pts, i) * PIER_ALONG_M * 0.5,
            PIER_ACROSS_M * 0.5,
        )
        _box(struct, ring, float(run.ground[i] - PIER_BURY_M), float(soffit[i]), origin)


def _along(pts: np.ndarray, i: int) -> np.ndarray:
    d = pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]
    n = float(np.hypot(d[0], d[1]))
    return d / n if n > 1e-9 else np.array([1.0, 0.0])
