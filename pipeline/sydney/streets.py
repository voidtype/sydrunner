"""Street surfaces: carriageway, footpath and kerb, per tile.

The city was rendering on a bare grey plane. A player standing in what should be
Botany Road stood in nothing at all, which is the single loudest realism failure
in the build -- more than any facade detail, because it is underfoot and constant.

OSM gives centrelines, not surfaces, so this module turns lines into three
polygon layers and then into geometry:

    carriageway   the road itself, 0.02 m over the ground
    kerb          the sandstone step that bounds it, 0.02 -> 0.15
    footpath      the paved band flanking it, 0.15 m over the ground

All three are clearances above the terrain, not absolute heights -- see the
fourth decision below for how a polygon triangulated in 2D ends up following a
hill to within float32.

Four decisions carry the whole module.

**Union, not per-way ribbons.** Buffering each centreline and emitting the quads
separately produces overlapping coplanar polygons at every intersection, every
way split, and every dual-carriageway pair -- which is to say several times per
block. Coplanar overlap z-fights, and z-fighting on the surface directly under
the player is the most visible artefact a renderer can produce. The ribbons are
unioned into one polygon per tile so an intersection is a single surface.

**Derive, never re-derive.** The kerb is `carriageway.buffer(w) - carriageway`
and the footpath is everything else minus that same buffer, so the seam between
each pair of layers is one shared boundary by construction rather than two
computations that have to agree. Minkowski addition distributes over union, so
buffering the union once is identical to buffering every ribbon by half-width
plus w and unioning -- and it is one call instead of thousands.

The one thing that subtraction cannot be trusted with is a gap in the union
narrower than the buffer that spans it, because the buffer closes it and the
difference then calls the whole gap kerb. Two OSM ways of one street diverging
by two degrees leave exactly such a gap, and what comes out is a sandstone blade
several metres long lying across the road. So the union is CLOSED at the kerb
width before the kerb is taken off it -- see `GORE_MITRE_LIMIT`.

**Clip last, simplify never.** Adjacent tiles must butt exactly: a gap shows the
ground through the road, an overlap z-fights. Both tiles build from every way
within `SELECT_MARGIN` of their own bounds, so the geometry either side of a shared
edge is built from the same inputs and is identical; clipping both to their own
bounds then cuts along the same line at the same coordinates. That guarantee is
why nothing is simplified *after* the union -- Douglas-Peucker looks at a whole
ring, so two tiles would thin a shared edge differently and the seam would open.
Vertex count is controlled where it is safe instead: on each centreline before
it is buffered (deterministic per way, so every tile buffers the same line) and
in the buffer's own segment count.

**Bridges draw nothing here.** A way tagged `bridge` or `viaduct` is not on the
ground and stopped contributing to any of the three layers when `decks.py`
arrived; what it leaves behind is bare ground, which is what the ground under a
viaduct is. It is not quite a clean deletion -- the kerb has to be held out of
the plan it vacated or a sandstone blade appears across the road at every
touchdown -- and the whole of that is the `DECK_EDGE` block below.

**Every surface is draped on the terrain**, at its own offset above it: the
heights below are now clearances over the ground rather than absolute y. That
needs vertices, because a 2D triangulation of a 120 m block of Botany Road is
two triangles and two triangles cannot follow a dip. Where they come from is the
fourth decision, and it has its own block comment under "Following the ground".
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import config, mesh
from .merge import Building
from .sources import osm

# --- Surface heights ---------------------------------------------------------
# Clearances *above the terrain*, not absolute y. The player controller steps
# 0.42 m without help, so a 0.13 m kerb needs no collision of its own and none is
# emitted: the collision payload stays exactly the building prisms it always was.
CARRIAGEWAY_Y = 0.02  # clear of the terrain surface, well under any step
FOOTPATH_Y = 0.15  # standard Australian kerb exposure
KERB_WIDTH = 0.15  # the exposed top of the kerb, in plan

# --- Plan widths -------------------------------------------------------------

# Paved band beyond the kerb, by road class. Motorways and ramps get none -- a
# 3 m concrete verge along the Eastern Distributor is not a thing that exists,
# and drawing one there is worse than drawing nothing.
FOOTPATH_WIDTH = {
    "motorway": 0.0,
    "motorway_link": 0.0,
    "trunk_link": 0.0,
    "primary_link": 0.0,
    "secondary_link": 0.0,
    "tertiary_link": 0.0,
    "service": 1.5,  # laneways and driveways: a strip, not a promenade
    "living_street": 2.5,
}
FOOTPATH_WIDTH_DEFAULT = 3.0

# Standalone footways and cycleways -- park paths, plazas, arcades -- get their
# own ribbon in the footpath layer at 2 m overall.
FOOTWAY_HALF_WIDTH = 1.0

# --- Bridges are not ground --------------------------------------------------
#
# **A way tagged `bridge` or `viaduct` contributes nothing to any layer here.**
# It used to contribute a carriageway like any other, which drew the Western
# Distributor as asphalt draped over Darling Harbour at 43% of bank and the
# Cahill Expressway up a 52% cliff at Circular Quay -- and `roadgrade.py` could
# not help, because it had already, correctly, excluded bridges from the terrain
# solve on the grounds that a deck's height says nothing about the ground under
# it. The exclusion without this was the worst of both: not conformed, and still
# drawn on the ground it was not conformed to. `decks.py` now builds them as
# real elevated ribbons at their own solved elevation.
#
# What is left behind is *nothing*, and that is the correct answer rather than a
# gap. Where a real street runs underneath, it draws its own carriageway from its
# own way and is unaffected. Where the bridge way was the only way over that
# ground -- a viaduct over water, over a rail corridor, over a park -- the ground
# has no asphalt on it, which is what the ground under a viaduct looks like.
#
# The one thing that cannot simply be dropped is the KERB. The kerb is
# `carriageway.buffer(KERB_WIDTH) - carriageway`, so the moment a bridge stops
# contributing, the ground road that meets it ends in a flat cap and the buffer
# wraps a 13 cm sandstone blade straight across the carriageway at every
# touchdown -- the same artefact `GORE_MITRE_LIMIT` exists to remove, arriving by
# a different route. So the bridges' plan is kept, grown by `DECK_EDGE`, and both
# the kerb polygon and the kerb *face* are held out of it. That is the same
# reasoning `_on_tile_edge` uses and it is the same statement: this is not where
# the road ends, it is where it leaves the ground.
#
# `DECK_EDGE` is `KERB_WIDTH` plus a centimetre. It has to exceed the kerb buffer
# or the blade survives at its own width, and it must not be large or it would
# start eating the kerb of a genuine street passing under the viaduct -- at
# 16 cm the widest thing it can reach is the kerb of a road whose asphalt is
# already under the deck.
DECK_EDGE = KERB_WIDTH + 0.01

# OSM's `width` tag is user-entered and occasionally describes the whole road
# reserve rather than the carriageway. Clamped so one bad tag cannot paint a
# 300 m square of asphalt over a suburb.
MIN_ROAD_WIDTH = 2.5
MAX_ROAD_WIDTH = 40.0

# --- Tessellation cost -------------------------------------------------------

# Centreline simplification, applied once per way before any tile sees it.
# OSM centrelines are surveyed to a couple of metres, so a quarter-metre of
# Douglas-Peucker removes digitising noise and nothing else. Footways are
# noisier and only 2 m wide, so they take more.
SIMPLIFY_STREET = 0.25
SIMPLIFY_FOOTWAY = 0.40

# Segments per quarter circle in each buffer. The chord error is radius *
# (1 - cos(90/n degrees)): 7 cm on a 3.75 m carriageway corner at 3, and under a
# millimetre on the 0.15 m kerb at 1, where a rounder corner would cost as many
# vertices as the road itself for no visible gain.
QUAD_SEGS_ROAD = 3
QUAD_SEGS_FOOTPATH = 2
QUAD_SEGS_KERB = 1

# Ways within this distance of a tile's bounds contribute to it. Must exceed the
# widest surface any single way can produce -- half of MAX_ROAD_WIDTH plus the
# footpath band -- or a tile would miss a way that reaches into it and its edge
# would stop matching its neighbour's.
SELECT_MARGIN = 30.0

# Fragments below this are dropped. Subtracting building footprints from the
# footpath band leaves slivers along every wall; each one costs vertices, and
# none of them is a footpath.
MIN_PART_AREA = 0.5

# --- Hairline gores ----------------------------------------------------------
#
# OSM splits a street into a way per block, per carriageway and per turn lane,
# and two ways of the same street routinely diverge by a degree or two where
# they meet. Two 11 m ribbons crossing at 2.4 degrees overlap almost everywhere
# and leave a hairline WEDGE of not-road between them, tapering to a point at
# the junction -- a digitising artefact, not a gap in the road.
#
# The kerb buffer cannot tell the difference. Minkowski addition fills any gap
# narrower than twice the kerb width, so `kerb_outer - carriageway` hands the
# whole tip of that wedge to the KERB layer: a sandstone blade tapering from
# 30 cm to nothing over the 7 m it takes a 2.4 degree wedge to open past
# `2 * KERB_WIDTH`, lying diagonally across what is otherwise continuous
# asphalt and standing 13 cm proud of it, with a kerb face down both sides.
# Measured where Oxford Street meets Flinders Street it is 5.5 m long; over the
# inner ring there were 411 of them longer than 3 m before this went in.
#
# The fix is a morphological CLOSING of the carriageway at exactly the kerb
# width, before the kerb is derived from it: dilate, then erode. Every gap the
# kerb buffer was going to swallow is asphalt instead, and the kerb is only ever
# the band around a road with no hairline notches left in it. Nothing else can
# reach the wedge -- it is narrower than the buffer that creates it, so no
# threshold on the kerb polygon afterwards can separate it from the real band it
# is joined to.
#
# BOTH BUFFERS ARE MITRED, and that is what makes it free rather than a 1.9x
# vertex bill. With round joins the erosion fillets every reflex corner in the
# network and the dilation's chords never come back, so the carriageway ring
# comes out at 1.86-1.97x the vertices it went in with -- and the kerb face
# stands on that ring, so that is 1.9x the most expensive layer per square metre
# in the tile, to remove 411 triangles. A mitred dilation puts a convex corner
# at the exact point the offsets meet and a mitred erosion takes it straight
# back, so on six measured tiles the ring comes out within 1% of where it
# started and the only thing that changed is that the wedges are gone.
#
# The limit is the same 2.0 `contact.MITRE_LIMIT` settled on, for the same
# reason and after the same 11 m spear: an uncapped mitre on a 10 degree corner
# is a spike, and trading one spike for another is not a fix. Past the limit the
# corner bevels and the erosion nicks a few square centimetres back off it,
# which cannot open a hole -- `kerb_outer` is derived from the CLOSED
# carriageway below, so the kerb takes back exactly what the road gives up and
# the two still tile `kerb_outer` between them with nothing over and nothing
# short.
GORE_MITRE_LIMIT = 2.0

# --- Degenerate output -------------------------------------------------------

# Triangles thinner than this, measured in plan as twice the area over the
# longest edge, are not written.
#
# They are ear-clip and facet-cut offcuts: `_conform` cuts every surface against
# a lattice its boundary was not built on, so wherever a kerb line grazes a
# facet corner the piece it leaves is a strip a few microns wide and metres
# long. `mesh.winding_agreement` already has to exclude them from the winding
# statistic because a triangle whose shortest altitude is a fraction of a
# float32 ulp has a cross product made entirely of its own rounding; this is the
# same triangles, declined at the point they are made instead.
#
# ONE MILLIMETRE, and the number is the module family's existing answer rather
# than a new one: `contact.MIN_SEGMENT` calls two vertices this close the same
# vertex, on this same lattice, for this same reason. Over six tiles it drops
# 3.2% of the flat-layer triangles and 1.3 m^2 of 339,661 -- four parts per
# million of paved surface, in slots a millimetre wide. That is a different
# trade from `MIN_PIECE_AREA` above, which refuses to drop a fifth of a square
# metre because each piece of it would be 20 cm of terrain showing through the
# asphalt: 20 cm is a pothole and 1 mm is not a thing that can be seen.
#
# A triangle WITH AN EDGE ON THE CLIP LINE is kept whatever its shape, and that
# is the seam guarantee rather than a nicety. Two tiles triangulate their own
# side of a shared edge independently, so there is no reason the offcut one of
# them declines is an offcut the other one also has -- and a millimetre of
# daylight along a tile line is still a line of daylight. Keeping every triangle
# that touches the boundary leaves the boundary itself exactly as clipped.
MIN_TRIANGLE_ALTITUDE = 1e-3

# Two ring vertices closer than this are the same vertex, and the step between
# them carries no kerb face. `terrain.densify` only inserts a crossing strictly
# inside a segment, but two of the lattice's three families of lines can cross
# within a hair of each other, and the quad standing on a micron-long step is
# two triangles 13 cm tall whose normal is entirely rounding. Same constant and
# same argument as `contact.MIN_SEGMENT`, which meets the same lattice.
MIN_SEGMENT = 1e-3

# --- Following the ground ----------------------------------------------------
#
# Everything paved is draped on the terrain at its own clearance above it, and
# the whole difficulty is what happens *between* the vertices. A 2D
# triangulation of a 120 m block of Botany Road is two triangles, and two
# triangles cannot follow a dip: measured on six inner-ring tiles the carriageway
# sinks a metre and a half below the ground at p99 and 17 m at worst, which is
# not a road with an error in it, it is a road inside a hill.
#
# **The fix is to cut every surface against the terrain's own facets** -- see
# `terrain.Terrain.facets`. The ground the client draws is piecewise planar, so a
# surface piece that lies inside one facet is exactly parallel to it and the 2 cm
# it is lifted by is the 2 cm it keeps, everywhere, with no tolerance anywhere in
# the calculation.
#
# Two cheaper rules were built and measured first, and both are recorded here
# because they look obviously sufficient and are not. Splitting every triangle
# until no edge exceeds 32 m costs 4.8x the triangles and still buries the road
# by 1.15 m at worst. Splitting adaptively wherever the ground deviates from the
# chord by more than 2 cm costs 22x -- because a piecewise-linear ground deviates
# from *every* chord that crosses a facet edge, so the test fires on nearly every
# segment and buys, at that price, a worst case of 32 cm. Conforming costs 2.2x
# and the error is zero. It is the easiest trade in the pipeline.
#
# What it also buys, for free: two tiles cut against the same global lattice
# split a shared seam segment identically, and the carriageway surface and the
# kerb face standing on its edge take their crossings from the same lattice, so
# both of the seams this module has always had to defend are defended by
# construction rather than by two computations agreeing.

# Pieces smaller than this are dropped after the cut, and it is deliberately
# almost nothing -- one square centimetre.
#
# A dropped piece here is not a sliver being tidied away, it is a *hole in the
# road*, which is a different thing from `MIN_PART_AREA` above discarding a
# sliver of footpath beside a wall. Set at the 0.05 m^2 that looked obviously
# harmless it removes half a square metre of carriageway across six tiles in a
# hundred-odd pinholes, each of them 20 cm of terrain showing through the
# asphalt. Set here it removes 0.9 cm^2 in total and costs 34 triangles, which is
# 0.4% -- so there is nothing to trade and the holes simply do not exist.
MIN_PIECE_AREA = 1e-4

SLOT_CARRIAGEWAY = "road_asphalt"
SLOT_FOOTPATH = "footpath_concrete"
SLOT_KERB = "kerb_sandstone"

# --- Named centrelines --------------------------------------------------------
#
# The one thing this module produces that is not a surface: a per-tile list of
# every named carriageway's centreline, for `tiles.write_street_names` and the
# client's "you are on King Street" readout.
#
# It exists because the client had no way to answer that mid-block. Street
# *names* reached it for the first time with the furniture blades, but a blade
# stands at a junction and names one of the two streets meeting there, so the
# nearest blade to a point halfway down a long block is up to a hundred metres
# away and is as likely to name the cross street as the one under your feet.
# Naming a point properly means projecting it onto the network, and the network
# is what this section ships.

# Douglas-Peucker tolerance for the exported centreline, metres.
#
# Six times the `SIMPLIFY_STREET` the surfaces are drawn from, and it is a
# different job with a different tolerance for error. A surface's simplification
# is visible -- a corner cut by more than a few centimetres is a kink in the
# asphalt. This is read only by a nearest-distance query whose decisions are at
# 3 m (the corner rule) and 40 m (the search radius), so 1.5 m of chord error is
# a fortieth of the smallest thing it decides. It roughly halves the point count
# against the surfaces' own lines and is still five times finer than the width
# of the street it describes.
NAME_SIMPLIFY = 1.5

# How far past its own edge a tile carries a named centreline, metres.
#
# A tile's sidecar is loaded with the tile, and the client queries every
# *resident* tile -- so a street just over the seam is found in the neighbour's
# file and this margin is not what makes the readout correct. What it is for is
# the moment before that: a tile whose neighbour is still in flight, and a player
# standing two metres inside the seam with the street they are on beginning one
# metre outside it. 40 m is the locator's own search radius, so the overlap is
# exactly the width of the query and never less.
NAME_MARGIN = 40.0

# The format's two u8 fields. A tile at this size holds 30-60 named ways and a
# 500 m run decimated at 1.5 m is a few dozen points, so neither is close -- the
# caps are enforced rather than assumed because a u8 that overflows writes a
# valid file that decodes to the wrong street.
MAX_TILE_NAMES = 255
MAX_SEGMENT_POINTS = 255


@dataclass
class NamedSegment:
    """One run of one named street, clipped to a tile and decimated."""

    name: str
    # (N, 2) ENU metres, N >= 2.
    points: np.ndarray


@dataclass
class TileSurfaces:
    """One tile's three layers, already clipped to its bounds."""

    carriageway: BaseGeometry
    kerb: BaseGeometry
    footpath: BaseGeometry
    # The plan the bridge ways vacated -- see `_build_surfaces` and `DECK_EDGE`.
    # Not a layer: nothing is drawn on it. It is a mask the kerb is kept out of,
    # carried on this record because `_emit_kerb_face` needs the same one the
    # kerb polygon was cut with and re-deriving it would be a second computation
    # that could disagree.
    deck_plan: BaseGeometry = None  # type: ignore[assignment]

    def is_empty(self) -> bool:
        return self.carriageway.is_empty and self.kerb.is_empty and self.footpath.is_empty


class StreetNetwork:
    """Every OSM way that becomes a paved surface, indexed for tile queries.

    Built once per run. Buffering is memoised per way because a way is asked for
    by every tile it touches -- typically two to four, and the widest arterials
    a dozen -- and buffering is the single most expensive call in the module.
    """

    def __init__(self, roads: list[osm.OsmRoad], buildings: list[Building]) -> None:
        self._roads = roads
        self._lines = [
            LineString(r.line).simplify(SIMPLIFY_FOOTWAY if r.is_foot else SIMPLIFY_STREET)
            for r in roads
        ]
        self._tree = STRtree(self._lines)
        self._ribbons: dict[int, Polygon] = {}
        self._footpath_bands: dict[int, Polygon] = {}
        # One tile's built layers, kept for the next caller. `build_tile` asks
        # for the same key twice -- once to emit the road surfaces and once for
        # the park grass, which has to have the carriageway cut out of it -- and
        # `surfaces` is the most expensive call in the pipeline. A single entry
        # is the whole cache: tiles are built one at a time and in order, so a
        # larger one would hold geometry nothing is going to ask for again.
        self._last_surfaces: tuple[str, TileSurfaces] | None = None

        # Footprints come from the already-merged building set rather than a
        # fresh read of the ledger: it is the same data, and indexing it by
        # bounds rather than by owning tile is what catches the warehouse whose
        # centroid is in the next tile but whose wall is on this street.
        self._obstacles = [_footprint(b) for b in buildings]
        self._obstacles = [p for p in self._obstacles if p is not None]
        self._obstacle_tree = STRtree(self._obstacles)

    @classmethod
    def load(cls, radius_m: float, buildings: list[Building]) -> StreetNetwork:
        roads = [
            r
            for r in osm.read_roads(radius_m)
            # Underground ways carry no surface. Left in, the Cross City and
            # Eastern Distributor tunnels drive asphalt straight through
            # Darlinghurst blocks that have no road on them.
            if r.layer >= 0 and not r.tunnel
        ]
        return cls(roads, buildings)

    def __len__(self) -> int:
        return len(self._roads)

    # --- Read access for other modules ---------------------------------------
    # `vegetation.py` plants along these same centrelines and has to agree with
    # this module about where the kerb is to within a few centimetres, so it asks
    # rather than re-deriving. Exposed as accessors rather than by reaching into
    # the attributes so the memoised buffering stays private.

    @property
    def roads(self) -> list[osm.OsmRoad]:
        return self._roads

    def centreline(self, i: int) -> LineString:
        """The simplified centreline of way `i` -- the one the surfaces are
        built from, not the raw OSM geometry, so an offset taken from it lands
        parallel to the kerb that was actually drawn."""
        return self._lines[i]

    def half_width(self, i: int) -> float:
        """Half the carriageway of way `i`, metres. The kerb face stands here."""
        return self._half_width(i)

    def footpath_width(self, i: int) -> float:
        """The paved band flanking way `i`, metres, or 0 where it gets none.

        Exposed for `mesh.AwningNetwork`, which needs "is there a footpath here
        at all" to decide whether a wall can carry an awning over one, and which
        cannot import this module -- the dependency runs the other way. Zero is
        the answer for every motorway and every link, and an awning over the
        Eastern Distributor is exactly the failure this prevents.
        """
        r = self._roads[i]
        if r.is_foot:
            return 0.0
        return FOOTPATH_WIDTH.get(r.highway, FOOTPATH_WIDTH_DEFAULT)

    def ways_near(self, geom: BaseGeometry) -> list[int]:
        """Indices of ways whose bounds intersect `geom`."""
        return [int(i) for i in self._tree.query(geom)]

    def buildings_near(self, geom: BaseGeometry) -> list[Polygon]:
        """Building footprints whose bounds intersect `geom`."""
        return [self._obstacles[int(i)] for i in self._obstacle_tree.query(geom)]

    # --- Geometry per way ----------------------------------------------------

    def _half_width(self, i: int) -> float:
        r = self._roads[i]
        if r.is_foot:
            return FOOTWAY_HALF_WIDTH
        return min(max(r.width, MIN_ROAD_WIDTH), MAX_ROAD_WIDTH) * 0.5

    def _ribbon(self, i: int) -> Polygon:
        """The carriageway (or footway) ribbon for one way.

        Flat caps, not round: OSM splits a single street into a way per block, so
        round caps would put a semicircular bulge at every split. Flat caps let
        two ways that share an end point abut exactly, and the union closes the
        join.
        """
        p = self._ribbons.get(i)
        if p is None:
            r = self._roads[i]
            p = self._lines[i].buffer(
                self._half_width(i),
                cap_style="flat",
                join_style="round",
                quad_segs=QUAD_SEGS_FOOTPATH if r.is_foot else QUAD_SEGS_ROAD,
            )
            self._ribbons[i] = p
        return p

    def _footpath_band(self, i: int) -> Polygon | None:
        """Carriageway plus its flanking paved band, for one street way."""
        r = self._roads[i]
        width = FOOTPATH_WIDTH.get(r.highway, FOOTPATH_WIDTH_DEFAULT)
        if width <= 0.0:
            return None
        p = self._footpath_bands.get(i)
        if p is None:
            p = self._lines[i].buffer(
                self._half_width(i) + width,
                cap_style="flat",
                join_style="round",
                quad_segs=QUAD_SEGS_FOOTPATH,
            )
            self._footpath_bands[i] = p
        return p

    # --- Tile coverage -------------------------------------------------------

    def tile_keys(self) -> set[str]:
        """Every tile any street surface could reach.

        Deliberately a superset, from way bounds rather than built geometry: a
        tile that turns out to hold nothing is emitted once, recorded empty, and
        never revisited, whereas a tile wrongly left out is a hole in the world
        that nothing in the output would report.
        """
        s = config.TILE_SIZE
        out: set[str] = set()
        for i, line in enumerate(self._lines):
            reach = self._half_width(i) + FOOTPATH_WIDTH_DEFAULT + KERB_WIDTH
            e0, n0, e1, n1 = line.bounds
            for tx in range(math.floor((e0 - reach) / s), math.floor((e1 + reach) / s) + 1):
                for tz in range(math.floor((n0 - reach) / s), math.floor((n1 + reach) / s) + 1):
                    out.add(f"{tx}_{tz}")
        return out

    # --- Named centrelines ---------------------------------------------------

    def named_segments(self, tile_key: str) -> list[NamedSegment]:
        """Every named carriageway crossing this tile, as decimated centrelines.

        Three filters, and each of them is the difference between a readout that
        can be trusted and one that cannot.

        **Named only.** An unnamed way cannot be read out, so carrying it would
        cost bytes to describe a street the client can only ever call `null` --
        and worse, it would be the nearest thing to the player often enough to
        suppress the named street twenty metres away. 3,162 of the inner ring's
        10,466 carriageways are unnamed, which is 30%: they are driveways, car
        park aisles, roundabout links and the unnamed halves of dual
        carriageways.

        **Carriageways only -- `is_foot` is skipped.** A footway is not a street
        you are *on* in the sense a readout means. There are 18,249 of them in
        the inner ring against 10,466 carriageways and 1,358 carry a name, so
        this is the filter that does the most work: without it a player walking
        down Crown Street would be told they are in whichever arcade or park
        path happens to run behind the shops.

        **Clipped to the tile plus `NAME_MARGIN`, not to the way's whole run.**
        A way is a way per block in OSM but the arterials are not: Parramatta
        Road arrives as a handful of ways kilometres long. Filing the whole run
        under every tile it touches would multiply the payload by the number of
        tiles crossed, and the query only ever looks 40 m.

        The clip produces one segment per continuous run inside the box, so a
        street that leaves the tile and comes back -- which the margin makes
        common on a corner -- is two records rather than one with a jump in it.
        Distance to a polyline with a jump in it is distance to the jump.
        """
        e0, n0, e1, n1 = _tile_bounds(tile_key)
        m = NAME_MARGIN
        clip_box = box(e0 - m, n0 - m, e1 + m, n1 + m)

        out: list[NamedSegment] = []
        seen_names: set[str] = set()
        for idx in self._tree.query(clip_box):
            i = int(idx)
            r = self._roads[i]
            if r.is_foot or not r.name:
                continue
            name = " ".join(r.name.split())
            if not name:
                continue
            # The name table is indexed by a u8. A tile past the cap keeps the
            # names it already has and drops the rest, rather than writing an
            # index that wraps -- see `MAX_TILE_NAMES`.
            if name not in seen_names and len(seen_names) >= MAX_TILE_NAMES:
                continue
            piece = self._lines[i].intersection(clip_box)
            if piece.is_empty:
                continue
            for line in _linestrings(piece):
                # `preserve_topology=False` is the plain Douglas-Peucker rather
                # than the variant that refuses to collapse a ring: there is no
                # ring here and no topology to preserve, and the guarded version
                # keeps vertices this has no use for.
                simple = line.simplify(NAME_SIMPLIFY, preserve_topology=False)
                pts = np.asarray(simple.coords, dtype=np.float64)
                if len(pts) < 2:
                    continue
                for chunk in _chunk_polyline(pts, MAX_SEGMENT_POINTS):
                    out.append(NamedSegment(name=name, points=chunk))
                    seen_names.add(name)
        return out

    # --- Tile layers ---------------------------------------------------------

    def surfaces(self, tile_key: str) -> TileSurfaces:
        """Build and clip one tile's three layers."""
        if self._last_surfaces is not None and self._last_surfaces[0] == tile_key:
            return self._last_surfaces[1]
        surf = self._build_surfaces(tile_key)
        self._last_surfaces = (tile_key, surf)
        return surf

    def _build_surfaces(self, tile_key: str) -> TileSurfaces:
        e0, n0, e1, n1 = _tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)

        selected = self._tree.query(tile_box.buffer(SELECT_MARGIN))
        ribbons: list[Polygon] = []
        bands: list[Polygon] = []
        decks: list[Polygon] = []
        for i in selected:
            i = int(i)
            if self._roads[i].is_foot:
                bands.append(self._ribbon(i))
                continue
            if self._roads[i].bridge:
                # A bridge carriageway is not on the ground and no longer draws
                # any -- see `DECK_EDGE`. Its plan is kept because the kerb has
                # to be kept out of it.
                decks.append(self._ribbon(i))
                continue
            ribbons.append(self._ribbon(i))
            band = self._footpath_band(i)
            if band is not None:
                bands.append(band)

        empty = Polygon()
        deck_plan = unary_union(decks).buffer(DECK_EDGE) if decks else empty
        carriageway = unary_union(ribbons) if ribbons else empty
        if carriageway.is_empty:
            kerb_outer = empty
            kerb = empty
        else:
            # Close the hairline wedges between diverging ways FIRST, so the
            # kerb is derived from a road that has none left in it -- see the
            # `GORE_MITRE_LIMIT` block. `kerb_outer` grows the closed road
            # rather than the raw union, which is what keeps the carriageway
            # inside it by construction however the mitre cap bevelled a corner.
            carriageway = _close_hairline_gores(carriageway)
            kerb_outer = carriageway.buffer(
                KERB_WIDTH, join_style="round", quad_segs=QUAD_SEGS_KERB
            )
            kerb = kerb_outer.difference(carriageway)
            if not deck_plan.is_empty:
                kerb = kerb.difference(deck_plan)

        footpath = unary_union(bands) if bands else empty
        if not footpath.is_empty and not kerb_outer.is_empty:
            footpath = footpath.difference(kerb_outer)
        if not footpath.is_empty:
            footpath = self._subtract_buildings(footpath)

        return TileSurfaces(
            carriageway=_clip(carriageway, tile_box),
            kerb=_clip(kerb, tile_box),
            footpath=_clip(footpath, tile_box),
            deck_plan=deck_plan,
        )

    def _subtract_buildings(self, footpath: BaseGeometry) -> BaseGeometry:
        """Take the buildings out of the paved band.

        A footpath band derived from a centreline runs straight under any
        building set close to the street -- which in a terrace suburb is all of
        them. The surface would be hidden by the walls above it, but it would
        still be drawn, still be shaded, and still be there the moment anything
        opens a wall.
        """
        hits = self._obstacle_tree.query(footpath)
        if len(hits) == 0:
            return footpath
        return footpath.difference(unary_union([self._obstacles[int(i)] for i in hits]))

    # --- Emission ------------------------------------------------------------

    def emit(
        self,
        tile_key: str,
        slots: dict[str, mesh.MeshBuffers],
        origin: tuple[float, float],
        terrain=None,
    ) -> None:
        """Tessellate one tile's layers into its material slots, draped on `terrain`."""
        surf = self.surfaces(tile_key)
        if surf.is_empty():
            return

        for slot in (SLOT_CARRIAGEWAY, SLOT_FOOTPATH, SLOT_KERB):
            slots[slot].building_indexed = False

        bounds = _tile_bounds(tile_key)
        _emit_flat(
            slots[SLOT_CARRIAGEWAY], surf.carriageway, CARRIAGEWAY_Y, origin, terrain, bounds
        )
        _emit_flat(slots[SLOT_FOOTPATH], surf.footpath, FOOTPATH_Y, origin, terrain, bounds)
        _emit_flat(slots[SLOT_KERB], surf.kerb, FOOTPATH_Y, origin, terrain, bounds)
        _emit_kerb_face(
            slots[SLOT_KERB], surf.carriageway, origin, bounds, terrain, surf.deck_plan
        )


# --- Helpers -----------------------------------------------------------------


def _tile_bounds(tile_key: str) -> tuple[float, float, float, float]:
    tx, tz = (int(v) for v in tile_key.split("_"))
    s = config.TILE_SIZE
    return (tx * s, tz * s, (tx + 1) * s, (tz + 1) * s)


def _linestrings(geom: BaseGeometry) -> list[LineString]:
    """Every LineString in `geom`, flattened.

    Clipping a line to a box can return a LineString, a MultiLineString, a Point
    where the line grazes a corner, or a GeometryCollection of both -- so this
    walks by type rather than by testing for `geoms`. Points are dropped: a
    zero-length touch is not a run of street.
    """
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


def _chunk_polyline(pts: np.ndarray, limit: int) -> list[np.ndarray]:
    """Split a polyline so no piece exceeds `limit` points.

    The pieces **share an end point**, so the union of the chunks covers exactly
    the same run as the original -- split without the overlap and the query gets
    a gap one segment wide at every join, which reads as the street not being
    there for the two metres that matter.

    Nothing in the inner ring reaches the limit; a 500 m tile plus its margins
    decimated at 1.5 m tops out around 60 points on the most sinuous way in the
    build. This is here because the point count is a u8 and the day a stage adds
    a 3 km ring road is not the day to find that out.
    """
    if len(pts) <= limit:
        return [pts]
    out: list[np.ndarray] = []
    start = 0
    while start < len(pts) - 1:
        end = min(start + limit, len(pts))
        out.append(pts[start:end])
        start = end - 1
    return out


def _footprint(b: Building) -> Polygon | None:
    ring = mesh._ring_open(b.ring)
    if len(ring) < 3:
        return None
    poly = Polygon(ring, [h for h in b.holes if len(h) >= 3])
    if not poly.is_valid:
        poly = poly.buffer(0)
    return None if poly.is_empty or poly.geom_type != "Polygon" else poly


def _clip(geom: BaseGeometry, tile_box: Polygon) -> BaseGeometry:
    return geom if geom.is_empty else geom.intersection(tile_box)


def _close_hairline_gores(carriageway: BaseGeometry) -> BaseGeometry:
    """The carriageway union with every notch narrower than a kerb filled in.

    Dilate by `KERB_WIDTH` and erode by the same, which is the closing of the
    union under a disc of that radius: it fills exactly the gaps that
    `carriageway.buffer(KERB_WIDTH)` was going to fill anyway, and by filling
    them here they become road instead of kerb. See the `GORE_MITRE_LIMIT`
    block for why they exist, why nothing downstream can undo them, and why both
    halves are mitred.

    Deterministic per tile in the way this module needs, and the argument is the
    same one the header makes for clipping last. A closing reads no further than
    twice its radius -- 30 cm here -- and every way that can put geometry within
    30 cm of a tile edge is selected by BOTH tiles sharing it, since
    `SELECT_MARGIN` is 30 m and the widest a single way can reach is 23.15. The
    two unions are therefore identical over metres of ground either side of the
    seam, and an operation with a 30 cm reach cannot tell them apart.

    That is the argument; the measurement is that it is not quite free. Over
    twelve shared edges, the worst disagreement between the two tiles' layer
    boundaries goes from 4.5e-13 m without this call to 3.2e-8 m with it -- GEOS
    does its noding over the whole polygon, so an input that is identical near
    the seam and different a kilometre away comes back different in the last
    ulp. Thirty-two nanometres is 1/950th of the float32 quantum the tiles ship
    at (30.5 microns at tile-local range), so the shipped vertices are still the
    same numbers; and in the one case in a thousand where two of them straddle a
    rounding boundary, what opens is 30 microns of a seam. That is a thousand
    times finer than `MIN_TRIANGLE_ALTITUDE` already calls invisible, and it is
    the whole price of the blades.
    """
    if carriageway.is_empty:
        return carriageway
    closed = carriageway.buffer(
        KERB_WIDTH, join_style="mitre", mitre_limit=GORE_MITRE_LIMIT
    ).buffer(-KERB_WIDTH, join_style="mitre", mitre_limit=GORE_MITRE_LIMIT)
    return closed if closed.is_valid else _repair_closing(closed)


def _repair_closing(closed: BaseGeometry) -> BaseGeometry:
    """Make an invalid closing valid again, keeping every square metre of it.

    **A mitred closing can return an invalid polygon, and the next overlay dies
    on it.** Measured on tile `-18_20` at the middle stage -- the ramp gore where
    the M4 splits at Homebush -- the raw union of 102 ribbons is valid, and the
    dilate/erode above turns it into `Self-intersection[-8693.94255079797
    10494.035792536]`: a mitre spike sharp enough that the erosion folds the ring
    onto itself at a point. Nothing complains until `kerb_outer.difference(...)`
    two lines later, which fails to node and raises

        TopologyException: found non-noded intersection between
        LINESTRING (-8693.94 10494, -8693.94 10494) and ... itself

    -- a zero-length segment, which is what a fold reduces to. That killed a
    whole middle build four minutes in, having already emitted 474 tiles.

    `make_valid` rather than the usual `buffer(0)`, and the difference matters
    for a *road*: `buffer(0)` resolves a self-touch by choosing one
    interpretation and can drop the smaller lobe entirely, which is a hole in the
    carriageway that nothing downstream would report. `make_valid` splits the
    touch into separate valid pieces and preserves the area -- measured here,
    +0.064 m2 against `buffer(0)`'s +0.032, both of which are the pinch being
    closed rather than anything being lost. The polygonal filter is because
    `make_valid` may hand back a collection with stray linework in it, which is
    the same reason `_parts` filters by type rather than trusting a name.

    **Only called when the closing is actually invalid**, and that guard is the
    point rather than an optimisation: a tile whose closing is valid comes
    through this file byte-identical to how it did before this function existed,
    so an already-shipped stage cannot be quietly re-cut by a repair aimed at a
    tile in another one.
    """
    repaired = shapely.make_valid(closed)
    parts = [
        p
        for p in (repaired.geoms if hasattr(repaired, "geoms") else [repaired])
        if p.geom_type in ("Polygon", "MultiPolygon") and not p.is_empty
    ]
    if not parts:
        # Nothing polygonal survived, which would be a closing that was entirely
        # degenerate. Hand back the input: an invalid road is a worse thing than
        # an empty one only if something downstream then fails on it, and the
        # caller's own overlay is what would.
        return closed
    return unary_union(parts)


def _drop_slivers(
    tris: np.ndarray, verts: np.ndarray, bounds: tuple[float, float, float, float] | None
) -> np.ndarray:
    """Triangles worth writing: everything but the sub-millimetre offcuts.

    See `MIN_TRIANGLE_ALTITUDE` for the threshold and for why a triangle with an
    edge on the clip line is kept regardless of how thin it is.
    """
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    u, v = b - a, c - a
    twice = np.abs(u[:, 0] * v[:, 1] - u[:, 1] * v[:, 0])
    longest = np.maximum(
        np.maximum(np.hypot(u[:, 0], u[:, 1]), np.hypot(c[:, 0] - b[:, 0], c[:, 1] - b[:, 1])),
        np.hypot(v[:, 0], v[:, 1]),
    )
    altitude = np.divide(twice, longest, out=np.zeros_like(twice), where=longest > 0.0)
    thin = altitude < MIN_TRIANGLE_ALTITUDE
    if not thin.any():
        return tris
    if bounds is not None:
        thin &= ~(
            _on_tile_edge(a, b, bounds)
            | _on_tile_edge(b, c, bounds)
            | _on_tile_edge(c, a, bounds)
        )
    return tris[~thin]


def _parts(geom: BaseGeometry) -> list[Polygon]:
    """Polygon parts worth drawing, wound exterior-CCW / holes-CW.

    The orientation is not cosmetic: `_emit_kerb_face` reads the interior side
    of each ring off the winding, and shapely inherits whatever winding the
    overlay happened to produce.
    """
    if geom.is_empty:
        return []
    # `hasattr(geoms)` rather than a Multi* name test: subtracting touching
    # polygons routinely yields a GeometryCollection with stray linework in it,
    # and a name test would silently discard every polygon inside one.
    candidates = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    return [
        orient(p, 1.0) for p in candidates if p.geom_type == "Polygon" and p.area >= MIN_PART_AREA
    ]


def _conform(part: Polygon, terrain) -> list[Polygon]:
    """Cut one polygon into pieces, each lying inside a single terrain facet.

    `shapely.intersects` first and `shapely.intersection` only on the hits: the
    facets come from a bounding box, so a diagonal arterial's box is mostly empty
    and the predicate is an order of magnitude cheaper than the overlay it saves.
    """
    facets = np.asarray(terrain.facets(part.bounds), dtype=object)
    hits = facets[shapely.intersects(part, facets)] if len(facets) else facets
    if len(hits) == 0:
        # Unreachable for a polygon of positive area -- the facets come from its
        # own bounding box. Falls back to the uncut part rather than to nothing,
        # because the two ways this could be wrong are not symmetric: an uncut
        # piece is a road that follows the ground less exactly, and an empty list
        # is a road that is not there.
        return [part]
    out: list[Polygon] = []
    for piece in shapely.intersection(part, hits):
        if piece.is_empty:
            continue
        # An overlay can return a GeometryCollection with stray linework in it
        # wherever the road grazes a facet edge, so the parts are filtered by
        # type rather than assumed, exactly as in `_parts`.
        for p in piece.geoms if hasattr(piece, "geoms") else [piece]:
            if p.geom_type == "Polygon" and p.area >= MIN_PIECE_AREA:
                out.append(p)
    return out


def _world_uv(pts: np.ndarray) -> np.ndarray:
    """Planar UVs in **world** metres, matching the roof convention (x, z).

    World rather than tile-local, unlike a roof: a footpath's expansion-joint
    grid and, later, its lane markings have to run unbroken across a tile seam,
    and 500 m is not a whole number of 1.2 m slabs.
    """
    return np.column_stack((pts[:, 0], -pts[:, 1]))


def _emit_flat(
    buf: mesh.MeshBuffers,
    geom: BaseGeometry,
    y: float,
    origin: tuple[float, float],
    terrain=None,
    bounds: tuple[float, float, float, float] | None = None,
) -> None:
    """Triangulate a polygon layer and drape it `y` metres above the ground."""
    oe, on = origin
    for part in _parts(geom):
        for poly in [part] if terrain is None else _conform(part, terrain):
            tris, verts2d = mesh._triangulate(
                np.asarray(poly.exterior.coords),
                [np.asarray(h.coords) for h in poly.interiors],
            )
            if len(tris) == 0:
                continue
            tris = _drop_slivers(tris, verts2d, bounds)
            if len(tris) == 0:
                continue
            n = len(verts2d)
            ground = _ground(terrain, verts2d[:, 0], verts2d[:, 1], n)
            pos = np.column_stack((verts2d[:, 0] - oe, ground + y, -(verts2d[:, 1] - on)))
            buf.add_surface(pos, _ground_normals(terrain, verts2d, n), _world_uv(verts2d), tris)


def _ground(terrain, east, north, n: int) -> np.ndarray:
    """Terrain height under a set of ENU points, or a plane at zero without one."""
    if terrain is None:
        return np.zeros(n)
    return np.asarray(terrain.sample(east, north), dtype=np.float64)


def _ground_normals(terrain, verts2d: np.ndarray, n: int) -> np.ndarray:
    """Per-vertex normals for a draped surface.

    A road keeping a flat-up normal while the verge beside it shades to the slope
    is the tell that the road is a decal rather than part of the ground, and it
    shows most on exactly the hills this pass exists to put back. The gradient
    comes from `terrain.slope`, which takes a central difference over one post
    spacing -- the same span the client's terrain mesh differences its own grid
    over, so the road and the ground it lies on shade together.
    """
    if terrain is None:
        return np.tile((0.0, 1.0, 0.0), (n, 1))
    de, dn = terrain.slope(verts2d[:, 0], verts2d[:, 1])
    # Height field in renderer axes: x = east, z = -north, so dy/dx = de and
    # dy/dz = -dn, and the normal of y = f(x, z) is (-dy/dx, 1, -dy/dz).
    nrm = np.column_stack((-de, np.ones(n), dn))
    return nrm / np.linalg.norm(nrm, axis=1)[:, None]


def _emit_kerb_face(
    buf: mesh.MeshBuffers,
    carriageway: BaseGeometry,
    origin: tuple[float, float],
    bounds: tuple[float, float, float, float],
    terrain=None,
    deck_plan: BaseGeometry | None = None,
) -> None:
    """The vertical step from carriageway up to footpath.

    A closed quad strip around every ring of the carriageway, sharing its
    vertices between adjacent segments: the strip is 13 cm high, so the averaged
    normal at a corner is indistinguishable from a hard one and halves the
    vertex count of what is otherwise the most expensive layer per square metre
    in the tile.

    Segments lying along the tile boundary are skipped. They are not kerb -- they
    are where the clip cut the road in half, and the road continues on the other
    side. Emitted, they would put a 13 cm wall straight across every street at
    every 500 m tile line, which is both visible and something the player walks
    into.

    **Segments inside `deck_plan` are skipped for exactly the same reason**, and
    it is the same wall: the road does not end at a bridge touchdown, it leaves
    the ground there. See the `DECK_EDGE` block.

    The ring is densified at every terrain facet crossing first, which is the
    one-dimensional form of what `_conform` does to the surface beside it -- and
    it has to be the same lattice, or the strip and the road it stands on would
    have different vertices along the boundary they share.
    """
    oe, on = origin
    for poly in _parts(carriageway):
        for ring in (poly.exterior, *poly.interiors):
            coords = np.asarray(ring.coords)
            pts = mesh._ring_open(
                coords if terrain is None else terrain.densify(coords)
            )
            n = len(pts)
            if n < 3:
                continue
            nxt = np.roll(pts, -1, axis=0)

            # Segment normals. `_parts` has already put every ring through
            # `orient(p, 1.0)` -- exterior counter-clockwise, holes clockwise,
            # the same convention `merge.orient_footprint` states for footprints
            # -- so the carriageway is always on the left of travel and the face,
            # which is seen from the road rather than from the footpath, looks
            # left. The strip's winding follows from the same fact: `tris` below
            # is written for a left-looking face and agrees with these normals
            # rather than being tested against them.
            step = nxt - pts
            length = np.hypot(step[:, 0], step[:, 1])
            drawn = (length > MIN_SEGMENT) & ~_on_tile_edge(pts, nxt, bounds)
            if deck_plan is not None and not deck_plan.is_empty:
                mid = pts + step * 0.5
                drawn &= ~shapely.intersects_xy(deck_plan, mid[:, 0], mid[:, 1])
            safe = np.where(length > MIN_SEGMENT, length, 1.0)
            # ENU left of travel is (-dn, de); world x = east, z = -north.
            seg = np.column_stack((-step[:, 1] / safe, np.zeros(n), -step[:, 0] / safe))
            seg[~drawn] = 0.0
            if not drawn.any():
                continue

            # A vertex belongs to two segments; average, and fall back to the
            # outgoing segment where the two cancel on a spike.
            #
            # THE THRESHOLD STAYS AT EXACT CANCELLATION, and that was measured
            # rather than left alone. `sydney winding-audit` finds two triangles
            # in the whole inner ring whose interpolated normal crosses behind
            # their own face, both at a carriageway ring that doubles back at
            # about 135 degrees, and the obvious fix is to widen this test until
            # those corners take the plain segment normal instead of the average.
            # Doing that is much worse: a vertex serves the segment arriving at
            # it as well as the one leaving, so handing it the outgoing normal
            # fixes one side by breaking the other, and at a 120 degree threshold
            # the same audit went from 2 bad triangles to 4,690.
            #
            # What a crease too sharp to smooth across actually needs is a SPLIT
            # vertex -- two normals at one position, a hard edge -- which is a
            # different pass and a different kind of change. Two faces in 4.13 M
            # with a lit corner on a 13 cm kerb is the price of not making it,
            # and it is a shading blemish rather than a culling fault: the strip
            # winds correctly either way, so nothing is ever missing.
            vn = seg + np.roll(seg, 1, axis=0)
            mag = np.linalg.norm(vn, axis=1)[:, None]
            vn = np.where(mag > 1e-6, vn / np.where(mag > 1e-6, mag, 1.0), seg)

            x = pts[:, 0] - oe
            z = -(pts[:, 1] - on)
            # Both rails follow the ground, so the kerb keeps its 13 cm exposure
            # all the way down a hill instead of running out of it at the bottom.
            ground = _ground(terrain, pts[:, 0], pts[:, 1], n)
            pos = np.concatenate(
                (
                    np.column_stack((x, ground + CARRIAGEWAY_Y, z)),
                    np.column_stack((x, ground + FOOTPATH_Y, z)),
                )
            )
            uvs = np.tile(_world_uv(pts), (2, 1))
            i = np.arange(n)[drawn]
            j = (i + 1) % n
            tris = np.concatenate(
                (
                    np.column_stack((j, i, i + n)),
                    np.column_stack((j, i + n, j + n)),
                )
            )
            buf.add_surface(pos, np.concatenate((vn, vn)), uvs, tris)


def _on_tile_edge(
    a: np.ndarray, b: np.ndarray, bounds: tuple[float, float, float, float], eps: float = 1e-6
) -> np.ndarray:
    """Which segments lie along one of the four clip lines.

    Both ends must sit on the *same* edge. A segment running from the west edge
    to the north edge is a genuine road boundary crossing the corner, and testing
    each end against the box as a whole would throw it away.
    """
    e0, n0, e1, n1 = bounds
    out = np.zeros(len(a), dtype=bool)
    for axis, value in ((0, e0), (0, e1), (1, n0), (1, n1)):
        out |= (np.abs(a[:, axis] - value) < eps) & (np.abs(b[:, axis] - value) < eps)
    return out
