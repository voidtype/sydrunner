"""Where the water is, how deep the bed under it sits, and the sheets that draw it.

The harbour was bare dirt. Every other module in this pipeline drapes something
onto `Terrain.sample`, and `terrain.py`'s own header says why the water was left
out -- *"nothing is rendered on the water"* -- with the consequence that Sydney's
single most recognisable feature, from Circular Quay to Blackwattle Bay, rendered
as the same dry buff ground as a car park. This module is the answer to that
sentence.

It produces three things and they are all one decision, taken once:

  1. **The water polygons**, in ENU metres, each with the height its surface sits
     at. See `load`.
  2. **A bed under them.** `conform` pulls the terrain lattice down under every
     water polygon, exactly the way `roadgrade.conform` pulls it onto the roads,
     and for the same structural reason: the surface is one global lattice, so
     doing it there and once is what keeps two tiles' shared edge posts the same
     elements of the same array. Without it the DEM's own sea -- terrarium clamps
     the ocean to exactly 0 m AHD -- is *coplanar* with the water plane over
     twenty square kilometres, which is the worst z-fight a renderer can be
     handed.
  3. **The sheets**, per tile and once for the whole extent, which are what the
     client actually draws. See `tile_sheets` and `far_sheets`.

---------------------------------------------------------------------------
**The sea is a polygon here, and the spec said it would not be.**

The OSM convention is that the ocean is *not* mapped as an area: it is bounded by
`natural=coastline` ways, land on the left of the direction of travel, and a
consumer is expected to polygonise them against its own extent boundary. That is
what `polygonise_sea` does. **Which source actually supplies the water depends on
the stage, and both are real:**

  * At the **inner** stage the harbour comes entirely from `natural=water`
    multipolygons -- Port Jackson (51.2 km2), Sydney Harbour (26.2 km2), Middle
    Harbour, Parramatta River, Iron Cove -- which are hand-mapped, carry names
    and carry their islands as holes. The 12 coastline ways inside that extent
    are 8.1 km of fragments around Botany Bay that close no face and correctly
    yield nothing.
  * At the **middle** stage the coastline is the only thing that can give you the
    Tasman Sea: 149 ways, 134.5 km of linework, one 96.9 km chain running clean
    across the extent, polygonising to 317.8 km2 of ocean. No `natural=water`
    polygon covers open sea and none ever will.

So the two are unioned rather than one replacing the other, and `water-audit`
prints which supplied what. Getting that union wrong is not a cosmetic matter:
the first version of the vote in `polygonise_sea` claimed 960.41 km2 of a 961
km2 extent and cut a seabed under the whole city. Read that function's header
before touching it, and `MAX_WATER_SHARE` for the gate that now stands in front
of the terrain.

---------------------------------------------------------------------------
**Every water body carries its own surface height, and the alternative is a
crater.**

The obvious model is one sea level for all water, and it is right for everything
tidal -- the harbour, the bays, the river. It is catastrophically wrong for the
nine ponds in Centennial Park, which sit on ground 25 to 40 m above AHD: put
their surface at sea level and the bed conform digs a forty-metre pit through
the middle of a park.

So the mapped polygons are unioned first and then classified **per connected
component**, which is both the cheaper question and the more meaningful one --
Port Jackson and Sydney Harbour are two overlapping relations describing one
piece of water, and unioning them is what stops the same square metre being
counted, levelled and drawn twice.

Each component is then measured *inside itself* rather than around its edge, and
the difference decides the whole classification. Terrarium is a land DEM: it
knows nothing about a pond, so the ground it reports inside one is the park
around it, 25 to 42 m up. Over the sea it has no soundings at all and is clamped
to exactly 0 m AHD. Measured over this extent the split is not close -- the
harbour component reads 0.01 m above sea level at its 10th percentile and the
next-lowest inland component reads 2.66 -- so `TIDAL_MARGIN_M` is a wide gap
rather than a tuned threshold.

A tidal component is pinned to **exactly** sea level, pinned rather than
measured, because two bays that each measured their own level would meet at a
step in the middle of the harbour. Anything else keeps its own measured surface,
a hand's breadth below its bank.

The boundary was tried first and does not work. `terrain.py`'s header already
says why: the 60 m Gaussian pulls the shore up by averaging the hill behind it,
and it quotes Blackwattle Bay reading 11.9 m against a real 3. Sampled that way
Port Jackson's own shoreline reads 2.8 m above sea level and Sydney Harbour's
3.1, which put the two on different levels and split the harbour into terraces.

The bed then follows the surface rather than the datum: `OPEN_DEPTH_M` under a
harbour, `POND_DEPTH_M` under a pond, because a park pond is ankle-deep in life
and a three-metre one would be a swimming pool with a lawn around it.

---------------------------------------------------------------------------
**The waterline is a post-resolution artefact and the conform is shaped around
that.**

The lattice is 31.25 m. The water's edge is a polygon boundary with metre
detail, and no rule at the posts can put the terrain's zero crossing exactly on
it. What *can* be guaranteed, and is:

  * every post inside a water polygon is **at least** `SHORE_CLEARANCE_M` below
    that polygon's surface, so no ground pokes through a drawn sheet; and
  * every post outside one, within reach of it, is **at least at** the surface,
    so there is no dry ground below the waterline for the player to walk into.

Between an inside post and an outside post the rendered surface is linear, so it
crosses the waterline somewhere in that cell -- within one post of the mapped
shore, always on the correct side of both. The `FEATHER_IN_M` ramp is what keeps
the inside post near the boundary shallow rather than at full depth: without it
the crossing lands most of a post *outside* the polygon, and the shore reads as
the water standing proud of a trench.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from dataclasses import field as dc_field
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import linemerge, polygonize, unary_union

from . import config
from .sources import osm

# --- What counts as water ------------------------------------------------------

# `natural=water` is the whole of the tagged source, and the exclusions are the
# two that would put water where a player stands. A `natural=water` polygon that
# is also a building is a mapping error or a rooftop feature; one under
# `MIN_BODY_AREA` is a fountain basin or a farm dam of no consequence, and each
# costs a sheet, a level group and a run of the conform.
#
# Deliberately *not* excluded: `water=wastewater`. There are 33 of them in the
# extent, they are open water, and a treatment pond reads as water from a street
# whatever is in it.
MIN_BODY_AREA = 200.0

# The surface of tidal water, metres AHD. Zero rather than a tide state: AHD was
# defined at mean sea level, terrarium clamps the ocean to exactly this, and
# `index.json`'s `sea_level_y` -- which the client has always used to place the
# far plane -- is derived from the same number. Putting the water anywhere else
# would make this the second opinion about where the sea is.
SURFACE_AHD = 0.0

# How far above sea level a component may read inside itself and still be called
# tidal.
#
# A property of the *DEM* rather than of the tide, and a wide gap rather than a
# tuned threshold: over this extent the harbour component reads 0.01 m and the
# lowest inland one 2.66 m, so anything between about 1 and 2.5 gives the same
# answer. See the header.
TIDAL_MARGIN_M = 2.0

# Where a component's own level is read: a low quantile of the terrain sampled on
# a grid *inside* it. The quantile rather than the minimum, because a single
# pixel of a neighbouring inlet reaching into a pond's bounding box would drag
# the minimum to sea level and flood the park.
BODY_QUANTILE = 0.10

# The most interior samples one component's level is measured from. A budget, not
# an accuracy target: the harbour's bounding box is 9 km square and a 10 m grid
# over it is 810,000 points to answer a question a few thousand already settle.
BODY_MAX_SAMPLES = 20_000
BODY_MIN_STATION_M = 10.0

# How far the bed sits below the surface. Two numbers, because a harbour and a
# duck pond are not the same object -- see the header.
OPEN_DEPTH_M = 3.5
POND_DEPTH_M = 1.0

# The least a post inside a polygon may be below that polygon's surface. Small,
# because it applies right at the shore where the bed is shallow in life, and
# non-zero because zero is the coplanar case this module exists to remove: 0.4 m
# is over a hundred times the depth buffer's resolution at the 1.8 km streaming
# radius (1.9 cm at 300 m, 1.9 m at 1,800 m -- and at 1,800 m the near sheet is
# not what is drawn).
SHORE_CLEARANCE_M = 0.4

# The two feather bands, metres. Both are one post spacing, and that is the only
# width either can sensibly be: the lattice cannot represent a ramp finer than a
# post, and a ramp wider than one spends real ground on a transition nobody can
# see under the water.
FEATHER_IN_M = config.TILE_SIZE / config.TERRAIN_GRID
FEATHER_OUT_M = config.TILE_SIZE / config.TERRAIN_GRID

# The most of the extent that may plausibly be water before the build stops.
#
# **A gate against a wrong sea, and it is a gate rather than a warning because
# of what is downstream of it.** The middle stage assembled 960.41 km2 inside a
# 961 km2 extent and nothing objected: `conform` cut 981,498 of 986,049 posts to
# a seabed, every landmark in Sydney read -3.5 m AHD, and the build carried on
# for four minutes emitting 474 drowned tiles before it crashed on something
# else. The terrain conformance is the point of no return -- after it there is
# no un-drowned surface left to notice with -- so the check belongs here, in
# `load`, before `Terrain.load` has written a single post.
#
# 0.60 is set against both real stages with room either side: the inner extent
# is 24.5% water and the middle 40.4% (33.1% of open ocean plus the harbour and
# the rivers). The failure it exists to catch is ~100%, so anything from 0.55 to
# 0.8 would do and the point is only that the gap is enormous. A genuinely
# oceanic extent -- a stage centred offshore -- would trip it, and that is the
# right conversation to have with a person rather than a default.
MAX_WATER_SHARE = 0.60


# The same ceiling for the coastline alone, as `verify_coastline` applies it.
#
# Tighter than `MAX_WATER_SHARE`, and it can be: this one is measured against a
# *known* answer rather than guarding an unknown build. The middle extract's
# ocean is 33.1% of its extent and the inner extract has no coastline at all, so
# 45% sits half way between the truth and the 99.9% the bug produced.
MAX_COASTLINE_SHARE = 0.45


class WaterSanityError(RuntimeError):
    """The assembled water is not a plausible amount of water. See `MAX_WATER_SHARE`."""


# Bodies whose surfaces are within this of each other share a sheet. A pond and
# the pond next to it in the same park differ by centimetres of DEM noise, and
# two sheets a hair apart would be two draws and a visible seam where they meet.
LEVEL_TOLERANCE_M = 0.25

# How far past the mapped edge a sheet is *allowed* to reach, metres, before the
# underwater clip trims it back.
#
# Half a post for tidal water, and it is safe to be that generous only because
# `_wet_pieces` clips every piece to the ground it is actually over: water is
# drawn past the polygon exactly where the ground there is under sea level, which
# is the interpolation band between a wet post and the dry post beside it and
# nowhere else. Without the overlap that band is a dry gutter up to 40 cm deep
# running along every flat shore in the extent, because the ground crosses sea
# level *outside* the polygon there.
#
# Ponds get almost none, because the argument inverts: the land downhill of a
# pond is legitimately below the pond's surface -- that is what a bank is -- and
# a 15 m overlap around Busbys Pond would run water down the hill.
SHORE_OVERLAP_M = 15.0
POND_OVERLAP_M = 0.5

# The least water a sheet is drawn over, metres.
#
# The clip's own margin, and it is a depth-buffer number rather than a visual
# one. Where the ground crosses the surface the two are coplanar by definition,
# and depth resolution at range d with a 0.1 m near plane is about
# `d^2 / (near * 2^24)` -- 5.4 cm at 300 m. So a sheet drawn all the way to zero
# thickness z-fights in a band along every shoreline whose width is set by how
# flat the shore is. Trimming at 5 cm puts the edge past that at every distance
# the shore is read at, and the ground's own `polygonOffset` (see
# `client/src/world/ground.ts`) already pushes it further back again.
#
# What it costs is a strip of very shallow water on the flattest shores: 5 cm
# over a beach falling at 1:70 is 3.5 m of water not drawn. That strip reads as
# wet sand, which is what it is.
MIN_DRAWN_DEPTH_M = 0.05


@dataclass
class WaterBody:
    """One connected body of water, in ENU metres, with the height it sits at.

    A *component of the union* rather than a mapped polygon -- see `load` -- so
    its `name` and `source` are borrowed from the largest input polygon that
    covers it and are for the audit's benefit alone.
    """

    polygon: Polygon
    surface: float  # metres above the datum
    tidal: bool
    name: str
    source: str  # 'natural=water' or 'coastline'
    # What the terrain read *inside* this component before anything moved it,
    # metres above the datum. The number the tidal classification turned on, kept
    # so `water-audit` can print it rather than re-deriving it.
    shore: float


@dataclass
class WaterLevel:
    """Every body at one surface height, unioned. What the sheets are cut from."""

    surface: float
    geom: BaseGeometry
    tidal: bool
    bodies: int

    @property
    def depth(self) -> float:
        return OPEN_DEPTH_M if self.tidal else POND_DEPTH_M


@dataclass
class WaterField:
    """The extent's water: the bodies, the levels, and the numbers behind them."""

    bodies: list[WaterBody]
    levels: list[WaterLevel]
    sea_level_y: float
    stats: dict = dc_field(default_factory=dict)

    @property
    def area(self) -> float:
        return float(sum(lvl.geom.area for lvl in self.levels))

    def is_empty(self) -> bool:
        return not self.levels


# --- Reading -------------------------------------------------------------------


def _extent_box(radius_m: float) -> Polygon:
    """The square the water is clipped to: the terrain lattice's own reach.

    Matched to `Terrain.load`'s `reach` rather than to the build radius, so the
    water covers exactly the ground the lattice can hold and the far sheet ends
    where the far terrain does.
    """
    reach = int(math.ceil(radius_m / config.TILE_SIZE) + 1) * config.TERRAIN_GRID
    half = reach * (config.TILE_SIZE / config.TERRAIN_GRID)
    return box(-half, -half, half, half)


def _read_tagged(radius_m: float, path: Path) -> list[tuple[Polygon, str]]:
    """`natural=water` polygons inside the radius, part by part, with their names.

    Kept part by part rather than reduced to the largest ring the way a building
    is, for `osm.read_green`'s reason: Port Jackson is one relation whose parts
    are the harbour and every bay off it, and taking the biggest would drop
    Rushcutters, Rose and Double Bay in one go.
    """
    from . import geo

    bbox = geo.bbox_geodetic_for_radius(radius_m)
    geoms, attrs = osm._read_layer(path, "multipolygons", bbox)

    out: list[tuple[Polygon, str]] = []
    for geom, a in zip(geoms, attrs):
        if a.get("natural") != "water":
            continue
        # A rooftop pool or a water tank mapped on a building outline. Painting
        # water at ground level under a footprint is the one way this read can
        # put the harbour inside a warehouse.
        if a.get("building"):
            continue
        proj = osm._project(geom)
        if proj.is_empty:
            continue
        name = str(a.get("name") or "")
        for poly in proj.geoms if proj.geom_type == "MultiPolygon" else [proj]:
            if poly.geom_type != "Polygon" or poly.area < MIN_BODY_AREA:
                continue
            out.append((poly, name))
    return out


# How the left-hand rule is put to a face, and the three numbers that decide it.
#
# `PROBE_M` is how far off the way a probe steps, and `PROBE_FRACTION` caps that
# at a share of the segment it came from: a metre off the midpoint of a 30 cm
# segment lands past the *next* bend, on the wrong side, and a real coastline is
# full of 30 cm segments.
#
# `SEA_DOMINANCE` is the ratio of right-side to left-side evidence a face needs
# before it is called sea, and `MIN_SEA_EVIDENCE_M` is the floor under the
# winner. Together they are what makes a face with probes on *both* sides -- the
# signature of a coastline that does not partition the extent -- come out as
# nothing rather than as everything. See the header of `polygonise_sea`.
PROBE_M = 1.0
PROBE_FRACTION = 0.45
SEA_DOMINANCE = 3.0
MIN_SEA_EVIDENCE_M = 100.0


def polygonise_sea(ways: list[LineString], extent: Polygon) -> BaseGeometry | None:
    """Coastline ways -> the sea face, by the left-hand rule. `None` for none.

    The OSM convention: a coastline way is directed with **land on its left**, so
    the sea is on its right. Noding the ways together with the extent's own
    boundary and polygonising gives a set of faces, and a probe stepped to the
    right of a segment lands in the sea face.

    ---------------------------------------------------------------------------
    **The rule is a length-weighted vote, and the first version -- "any right-hand
    probe claims the face" -- drowned a city.**

    Run against the middle extent's real coastline it returned 960.41 km2 of sea
    inside a 961 km2 extent: the whole box. The cause is not the left/right sign,
    which is correct and always was. It is that the coastline **did not partition
    the extent at all** -- the ways stopped 400 m short of the boundary, so
    `polygonize` closed no face against it and handed back one face covering
    everything. With a single face, the probes on the left and the probes on the
    right are *in the same face*, and a rule that claims a face on any right-hand
    hit claims it. Everything downstream then behaved perfectly: 981,498 of
    986,049 posts were cut to a seabed and every landmark in Sydney read -3.5 m.
    A synthetic closed island cannot reproduce that, because a closed ring always
    partitions its box -- which is why `verify_polygonise` now carries an open
    coastline that does not.

    So each face accumulates the *length* of coastline claiming it from either
    side, and it is sea only if the right-hand evidence beats the left-hand by
    `SEA_DOMINANCE`. On the real middle coastline that is 101.15 km against
    0.00 km for the sea face and 0.00 against 90.43 km for the land -- decisive,
    because a coastline that genuinely divides a box has *all* of one side in one
    face. Where it does not divide the box, both scores land on the same face,
    neither dominates, and this returns `None`: no sea rather than all sea, which
    is the only safe direction for this to fail in.

    Weighting by length rather than counting is what makes the noise harmless: a
    hairpin or a noding artefact is a handful of sub-metre segments, and they are
    worth centimetres against tens of kilometres of open coast.
    """
    clipped = [w.intersection(extent) for w in ways]
    parts: list[LineString] = []
    for c in clipped:
        if c.is_empty:
            continue
        for ln in c.geoms if hasattr(c, "geoms") else [c]:
            if ln.geom_type == "LineString" and ln.length > 1.0:
                parts.append(ln)
    if not parts:
        return None

    faces = [
        f
        for f in polygonize(unary_union(parts + [extent.exterior]))
        if f.geom_type == "Polygon" and f.area >= MIN_BODY_AREA
    ]
    if not faces:
        return None

    right: list[tuple[float, float]] = []
    left: list[tuple[float, float]] = []
    weight: list[float] = []
    for ln in parts:
        pts = np.asarray(ln.coords)
        for a, b in itertools.pairwise(pts):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy)
            if length < 1e-9:
                continue
            step = min(PROBE_M, PROBE_FRACTION * length) / length
            mx, my = (a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5
            # Right of the direction of travel is (dy, -dx); left is (-dy, dx).
            right.append((mx + dy * step, my - dx * step))
            left.append((mx - dy * step, my + dx * step))
            weight.append(length)
    if not weight:
        return None

    wt = np.asarray(weight)
    tree = shapely.STRtree(faces)

    def evidence(points: list[tuple[float, float]]) -> np.ndarray:
        hits = tree.query(shapely.points(np.asarray(points)), predicate="within")
        total = np.zeros(len(faces))
        # `hits` is (2, n): the probe index and the face index it landed in. A
        # probe that landed in no face -- one stepped over the extent boundary --
        # simply does not appear.
        np.add.at(total, hits[1], wt[hits[0]])
        return total

    sea_evidence = evidence(right)
    land_evidence = evidence(left)
    sea = [
        face
        for i, face in enumerate(faces)
        if sea_evidence[i] >= MIN_SEA_EVIDENCE_M
        and sea_evidence[i] > land_evidence[i] * SEA_DOMINANCE
    ]
    return unary_union(sea) if sea else None


# How far past the extent's own edge the coastline is read, metres.
#
# **The coastline has to cross the boundary, not stop near it**, and that is the
# other half of the middle stage's drowning. The read used to be
# `bbox_geodetic_for_radius(radius_m)` -- the *build* radius, 15 km -- while the
# extent box the water is clipped to is the terrain lattice's reach, 15.5 km. So
# the ways came back 400 m short of the boundary, `polygonize` had nothing to
# close a face against, and the whole box came back as one face.
#
# The read is therefore keyed to the extent box rather than to the radius, plus
# this margin so the last way genuinely straddles the edge rather than ending on
# it. Measured on the middle extract: at the extent's own half-width the faces
# are already correct (641.6 km2 of land, 317.8 of sea) and 2 km of margin does
# not move them by a square metre -- it is there so that a coastline whose last
# node happens to sit a metre inside cannot recreate this.
COASTLINE_READ_MARGIN_M = 2000.0


def read_coastline(extent: Polygon, path: Path = osm.PBF_PATH) -> list[LineString]:
    """Every `natural=coastline` way reaching the extent, in ENU metres.

    Read to the extent box plus `COASTLINE_READ_MARGIN_M` rather than to the
    build radius -- see that constant, which is half of why the middle stage
    drowned. Separated from the polygonisation so `verify_coastline` can put the
    real linework through the real rule without a build.
    """
    from . import geo

    half = float(extent.bounds[2])
    bbox = geo.bbox_geodetic_for_radius(half + COASTLINE_READ_MARGIN_M)
    geoms, attrs = osm._read_layer(path, "lines", bbox)

    ways: list[LineString] = []
    for geom, a in zip(geoms, attrs):
        if a.get("natural") != "coastline":
            continue
        proj = osm._project(geom)
        for ln in proj.geoms if proj.geom_type == "MultiLineString" else [proj]:
            if ln.geom_type == "LineString" and ln.length > 1.0:
                ways.append(ln)
    return ways


def verify_polygonise() -> list[str]:
    """Self-check for the left-hand rule, in the client's `verify*` spirit.

    The one path in this module the extent's own data cannot exercise, and the
    one whose failure is *inverted* rather than absent: pick the wrong side and
    the "sea" is the land, so the harbour comes out as a polygon covering
    Newtown. That renders as a perfectly plausible flood with no error anywhere.

    A square walked both ways round, and the two answers are opposites.

    Anticlockwise in this east/north frame is the **island**: at its eastern side
    the way heads north, so the left hand points west, into the square -- land on
    the left, sea outside. Reverse the way and the same square is a **lake**: the
    land is now outside it and the sea is the square itself.

    Both are asserted, because a rule that returned the whole extent regardless
    of direction would pass either one on its own. This check is what caught the
    convention being stated backwards the first time it was written down.

    **And then a closed ring turned out to be the easy case.** The middle stage
    drowned on a coastline that does not partition the extent at all -- an island
    always does, which is why this passed while the city went under -- so the
    third and fourth cases below are open coastlines: one that crosses the box
    and must produce a sensible sea, and one that stops short of the boundary and
    must produce **nothing**. The fourth is the regression test for the 960.41
    km2 of sea inside a 961 km2 extent.
    """
    failures: list[str] = []
    extent = box(-1000.0, -1000.0, 1000.0, 1000.0)
    corners = [(-200.0, -200.0), (200.0, -200.0), (200.0, 200.0), (-200.0, 200.0)]
    island = LineString([*corners, corners[0]])
    lake = LineString([*corners[::-1], corners[-1]])

    outside = polygonise_sea([island], extent)
    if outside is None:
        failures.append("polygonise_sea found no sea at all around a square island.")
    elif abs(outside.area - (extent.area - 160_000.0)) > 1.0:
        failures.append(
            f"Around an island the sea came out at {outside.area:.0f} m2 against the "
            f"{extent.area - 160_000.0:.0f} m2 outside it. The left-hand rule has picked the "
            f"land, which floods the city."
        )

    inside = polygonise_sea([lake], extent)
    if inside is None:
        failures.append("polygonise_sea found no sea inside a lake wound the other way.")
    elif abs(inside.area - 160_000.0) > 1.0:
        failures.append(
            f"With the way reversed the sea came out at {inside.area:.0f} m2 against the "
            f"160,000 m2 of the square itself. The rule is not reading the direction at all."
        )

    # --- The open coastline that *does* cross the box: a ragged north-south line
    # a little east of centre, with the hairpin and the sub-metre segments a real
    # coastline is full of. Heading north with land on the left (west) puts the
    # sea in the eastern third.
    spine = [(300.0, -1400.0), (280.0, -600.0), (330.0, -200.0)]
    # A 60 cm hairpin: two segments whose right-hand probe at a fixed metre would
    # step clean over the neck and land on the land side. Length weighting is
    # what makes them harmless.
    spine += [(330.4, -199.7), (329.8, -199.4), (330.2, -199.1)]
    spine += [(250.0, 400.0), (380.0, 900.0), (350.0, 1400.0)]
    crossing = LineString(spine)
    east = polygonise_sea([crossing], extent)
    if east is None:
        failures.append(
            "polygonise_sea found no sea for an open coastline crossing the extent. "
            "A coastline that partitions the box has to produce one."
        )
    else:
        share = east.area / extent.area
        if not (0.15 < share < 0.45):
            failures.append(
                f"An open coastline down the eastern third of the extent produced "
                f"{100 * share:.1f}% of it as sea, outside the 15-45% the geometry implies. "
                f"The vote has picked the land."
            )
        elif east.centroid.x < 0:
            failures.append(
                f"The sea came out west of centre (centroid x {east.centroid.x:.0f}) for a "
                f"coastline with the land on its western side. The left-hand rule is inverted."
            )

    # --- And the case that drowned the middle stage: an open coastline whose
    # ends stop *inside* the extent, so it closes no face against the boundary
    # and `polygonize` returns the whole box as one. There is no sea to be had
    # here and the only safe answer is none.
    short = LineString([(300.0, -900.0), (280.0, 0.0), (330.0, 900.0)])
    nothing = polygonise_sea([short], extent)
    if nothing is not None:
        failures.append(
            f"A coastline that stops {100.0:.0f} m short of the extent boundary at both ends "
            f"-- so the box is a single face -- was read as {nothing.area / extent.area * 100:.1f}% "
            f"sea. It must be None: with one face the left-hand and right-hand probes are in "
            f"the *same* face, and claiming it is how 960.41 km2 of seabed was cut under "
            f"Sydney. See `polygonise_sea`."
        )

    # --- And the gate behind all of it, at the three shares that matter: the two
    # the real stages produce, and the one the bug did. Exercised rather than
    # trusted, because a ceiling with the comparison the wrong way round would
    # pass every build until the day it was needed.
    for area, extent_area, want_raise, label in (
        (19.80e6, 81.0e6, False, "the inner stage's 24.5%"),
        (381.95e6, 961.0e6, False, "the middle stage's 39.7%"),
        (960.41e6, 961.0e6, True, "the drowned middle stage's 99.9%"),
    ):
        try:
            guard_share(area, extent_area, "self-check")
            raised = False
        except WaterSanityError:
            raised = True
        if raised != want_raise:
            failures.append(
                f"guard_share {'refused' if raised else 'accepted'} {label}, and it must "
                f"{'accept' if not want_raise else 'refuse'} it. MAX_WATER_SHARE is "
                f"{MAX_WATER_SHARE}."
            )
    return failures


def coastline_reach(ways: list[LineString], extent: Polygon) -> tuple[int, int, float]:
    """(chains, chains that can close a face, km of linework inside the extent).

    The structural question that decides whether "no sea" is an answer or a
    fault. `polygonize` can only close a face against linework that either forms
    a ring or runs from one part of the extent's boundary to another, so a
    coastline made of disconnected fragments in the middle of the box produces
    nothing and *should*.

    Both stages need this to be measured rather than assumed. The inner extract
    has 12 coastline ways -- fragments around Botany Bay, 9 km south of the
    origin and nowhere near a boundary -- which partition nothing and correctly
    yield no sea; the middle extract has one 96.9 km chain that runs clean
    across, and which had better yield an ocean.
    """
    clipped = []
    for w in ways:
        c = w.intersection(extent)
        if c.is_empty:
            continue
        for ln in c.geoms if hasattr(c, "geoms") else [c]:
            if ln.geom_type == "LineString" and ln.length > 1.0:
                clipped.append(ln)
    if not clipped:
        return 0, 0, 0.0

    merged = linemerge(unary_union(clipped))
    chains = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    edge = extent.exterior
    spanning = 0
    for c in chains:
        if c.is_closed:
            spanning += 1
            continue
        # A millimetre: the ends were produced *by* the clip against this very
        # boundary, so they are on it exactly or not at all.
        ends = (shapely.Point(c.coords[0]), shapely.Point(c.coords[-1]))
        if all(edge.distance(p) < 1e-3 for p in ends):
            spanning += 1
    return len(chains), spanning, sum(c.length for c in clipped) / 1000.0


def verify_coastline(radius_m: float, path: Path = osm.PBF_PATH) -> list[str]:
    """The left-hand rule against the **real** coastline at a given radius.

    The synthetic cases in `verify_polygonise` are the shape of the argument;
    this is the argument against the data that broke it. It reads the extract,
    runs the same `read_coastline` -> `polygonise_sea` path a build runs, and
    asserts the answer is a plausible fraction of the extent rather than all of
    it.

    Cheap to state and not cheap to run -- it is a `lines` read over the whole
    extent -- so it is a `water-audit` flag rather than part of every build. The
    build has `MAX_WATER_SHARE` for that, and this is what tells you *why* the
    build refused.
    """
    failures: list[str] = []
    extent = _extent_box(radius_m)
    ways = read_coastline(extent, path)
    if not ways:
        # Not a failure. The inner extract has none, and the tagged polygons are
        # the whole of its water.
        return failures

    chains, spanning, km = coastline_reach(ways, extent)
    sea = polygonise_sea(ways, extent)
    if sea is None:
        if spanning == 0:
            # Fragments that reach no boundary and close no ring. There is no
            # face to be had and none should be claimed -- this is the inner
            # extract, and it is the *correct* answer rather than a fault.
            return failures
        failures.append(
            f"{len(ways):,} coastline ways at {radius_m / 1000:.0f} km ({km:,.1f} km inside the "
            f"extent, {chains} chains of which {spanning} can close a face) produced no sea at "
            f"all. Linework that spans the extent has to partition it, so either the "
            f"polygonisation is dropping it or the vote is finding evidence on both sides of "
            f"every face."
        )
        return failures

    share = sea.area / extent.area
    if share > MAX_COASTLINE_SHARE:
        failures.append(
            f"The coastline at {radius_m / 1000:.0f} km polygonised to {sea.area / 1e6:,.2f} km2 "
            f"of sea over a {extent.area / 1e6:,.2f} km2 extent -- {100 * share:.1f}%, past the "
            f"{100 * MAX_COASTLINE_SHARE:.0f}% this check allows. That is the signature of the "
            f"land face being claimed: the middle stage read 99.9% here and cut a seabed under "
            f"the whole city."
        )
    return failures


# --- Classification ------------------------------------------------------------


def _body_level(poly: Polygon, sample) -> float:
    """What the terrain reads *inside* one component, metres above the datum.

    A low quantile of a grid of interior samples. Inside rather than around the
    edge -- see the header -- and a quantile rather than a minimum, because one
    pixel of a neighbouring inlet reaching into a pond's bounding box would drag
    a minimum to sea level and flood the park.

    Falls back to the representative point for a component too small or too thin
    to catch a grid node, which at `MIN_BODY_AREA` is a 200 m2 sliver.
    """
    e0, n0, e1, n1 = poly.bounds
    span = max(e1 - e0, 1.0) * max(n1 - n0, 1.0)
    step = max(BODY_MIN_STATION_M, math.sqrt(span / BODY_MAX_SAMPLES))
    xs = np.arange(e0 + step * 0.5, e1, step)
    ys = np.arange(n0 + step * 0.5, n1, step)
    if len(xs) and len(ys):
        ex = np.repeat(xs[None, :], len(ys), axis=0).ravel()
        en = np.repeat(ys[:, None], len(xs), axis=1).ravel()
        keep = shapely.contains_xy(poly, ex, en)
        if keep.any():
            h = np.asarray(sample(ex[keep], en[keep]), dtype=np.float64)
            return float(np.quantile(h, BODY_QUANTILE))
    p = poly.representative_point()
    return float(sample(p.x, p.y))


def load(radius_m: float, sample, sea_level_y: float, path: Path = osm.PBF_PATH) -> WaterField:
    """Assemble every body of water in the extent, with its surface height.

    `sample(east, north)` is the ground as it stands *before* this module touches
    it -- `Terrain.sample` after the road conform, which is where `Terrain.load`
    calls this from. Passed in rather than imported for `roadgrade.solve`'s
    reason: this module must not depend on the thing that is about to consume it.

    `sea_level_y` is where 0 m AHD sits in the datum's frame, which is
    `-Terrain.base_elevation`. Handed in for the same reason.

    **The union comes before the classification**, and that ordering is what makes
    the rest of the module simple: Port Jackson and Sydney Harbour are two
    overlapping relations describing one piece of water, so unioning first turns
    "which bodies are the same water" into "which polygons are one component" and
    stops 6.5 km2 of harbour being counted twice.
    """
    extent = _extent_box(radius_m)
    stats = {
        "coastline_ways": 0,
        "coastline_area": 0.0,
        "tagged_parts": 0,
        "dropped_small": 0,
    }

    sources: list[tuple[Polygon, str, str]] = []
    # Counted as *ways read* rather than as "did it work", which is what this
    # used to be: the inner extract has 12 of them and they polygonise to
    # nothing, and a stat that reported 0 for that made the audit's own coastline
    # line disagree with the build's. `coastline_area` is the one that says
    # whether they contributed.
    ways = read_coastline(extent, path)
    stats["coastline_ways"] = len(ways)
    sea = polygonise_sea(ways, extent) if ways else None
    if sea is not None:
        for poly in sea.geoms if hasattr(sea, "geoms") else [sea]:
            if poly.geom_type != "Polygon" or poly.area < MIN_BODY_AREA:
                continue
            sources.append((poly, "sea", "coastline"))
            stats["coastline_area"] += poly.area

    for poly, name in _read_tagged(radius_m, path):
        clipped = poly.intersection(extent)
        if clipped.is_empty:
            continue
        for part in clipped.geoms if hasattr(clipped, "geoms") else [clipped]:
            if part.geom_type != "Polygon":
                continue
            if part.area < MIN_BODY_AREA:
                stats["dropped_small"] += 1
                continue
            sources.append((part, name, "natural=water"))
            stats["tagged_parts"] += 1

    if not sources:
        return WaterField(bodies=[], levels=[], sea_level_y=sea_level_y, stats=stats)

    merged = shapely.make_valid(unary_union([s[0] for s in sources]))
    components = [
        p
        for p in (merged.geoms if hasattr(merged, "geoms") else [merged])
        if p.geom_type == "Polygon" and p.area >= MIN_BODY_AREA
    ]
    stats["components"] = len(components)

    bodies: list[WaterBody] = []
    for comp in components:
        level = _body_level(comp, sample)
        tidal = level <= sea_level_y + SURFACE_AHD + TIDAL_MARGIN_M
        bodies.append(
            WaterBody(
                polygon=comp,
                # Tidal water is *pinned* to sea level rather than given its own
                # measurement: two bays that each measured their own would meet
                # at a step in the middle of the harbour.
                surface=sea_level_y + SURFACE_AHD if tidal else level - 0.1,
                tidal=tidal,
                name=_name_for(comp, sources),
                source=_source_for(comp, sources),
                shore=level,
            )
        )

    field = WaterField(
        bodies=bodies, levels=_group_levels(bodies), sea_level_y=sea_level_y, stats=stats
    )

    # The gate. Before anything has touched the terrain -- see `MAX_WATER_SHARE`.
    stats["extent_m2"] = float(extent.area)
    stats["share"] = field.area / extent.area if extent.area > 0 else 0.0
    biggest = max(bodies, key=lambda b: b.polygon.area, default=None)
    guard_share(
        field.area,
        extent.area,
        f"{len(bodies)} bodies; the largest is "
        + (
            "(none)"
            if biggest is None
            else f"{biggest.name or 'unnamed'} at {biggest.polygon.area / 1e6:,.2f} km2"
            f" from {biggest.source}"
        )
        + f".\n  coastline sources {stats['coastline_ways']}, covering "
        f"{stats['coastline_area'] / 1e6:,.2f} km2; tagged parts {stats['tagged_parts']:,}.\n"
        f"  The usual cause is a coastline that does not partition the extent, which makes "
        f"the whole box one face -- run `sydney water-audit --coastline-radius "
        f"{int(radius_m)}` to see what the left-hand rule made of it.",
    )
    return field


def guard_share(area_m2: float, extent_m2: float, detail: str = "") -> None:
    """Raise unless the assembled water is a plausible share of the extent.

    A function rather than three lines inside `load` so that the ceiling can be
    *exercised* -- see `verify_polygonise`, which runs it at the two shares the
    real stages produce and at the one the bug did. A gate nobody has watched
    fail is a gate nobody knows the sense of.
    """
    share = area_m2 / extent_m2 if extent_m2 > 0 else 0.0
    if share <= MAX_WATER_SHARE:
        return
    raise WaterSanityError(
        f"{area_m2 / 1e6:,.2f} km2 of water assembled over a {extent_m2 / 1e6:,.2f} km2 "
        f"extent -- {100 * share:.1f}%, past the {100 * MAX_WATER_SHARE:.0f}% ceiling. "
        f"Refusing to cut a seabed under it."
        + (f"\n  {detail}" if detail else "")
    )


def _pick_source(comp: Polygon, sources: list[tuple[Polygon, str, str]]) -> tuple[Polygon, str, str] | None:
    """The largest input polygon whose interior meets this component.

    For the audit only -- nothing geometric depends on it. A component is a union
    and has no tags of its own, and "Port Jackson" is a far more useful line in a
    report than "component 0".
    """
    point = comp.representative_point()
    hits = [s for s in sources if s[0].intersects(point)]
    if not hits:
        hits = [s for s in sources if s[0].intersects(comp)]
    return max(hits, key=lambda s: s[0].area) if hits else None


def _name_for(comp: Polygon, sources: list[tuple[Polygon, str, str]]) -> str:
    picked = _pick_source(comp, sources)
    return picked[1] if picked else ""


def _source_for(comp: Polygon, sources: list[tuple[Polygon, str, str]]) -> str:
    picked = _pick_source(comp, sources)
    return picked[2] if picked else "natural=water"


def _group_levels(bodies: list[WaterBody]) -> list[WaterLevel]:
    """Bucket bodies by surface height and union each bucket.

    Tidal bodies all carry the identical pinned float, so they collapse into one
    level by equality rather than by tolerance -- the harbour is one sheet, and
    it is one sheet because it is one number rather than because the tolerance
    happened to cover it.
    """
    if not bodies:
        return []
    order = sorted(bodies, key=lambda b: (not b.tidal, b.surface))
    groups: list[list[WaterBody]] = []
    for b in order:
        if groups and groups[-1][0].tidal == b.tidal and abs(groups[-1][0].surface - b.surface) <= LEVEL_TOLERANCE_M:
            groups[-1].append(b)
        else:
            groups.append([b])

    levels: list[WaterLevel] = []
    for g in groups:
        geom = unary_union([b.polygon for b in g])
        if not geom.is_valid:
            geom = shapely.make_valid(geom)
        if geom.is_empty:
            continue
        levels.append(
            WaterLevel(
                # The area-weighted mean of the bucket, which for the tidal
                # bucket is exactly the pinned value it went in with.
                surface=float(sum(b.surface * b.polygon.area for b in g) / sum(b.polygon.area for b in g)),
                geom=geom,
                tidal=g[0].tidal,
                bodies=len(g),
            )
        )
    return levels


# --- The conformance -----------------------------------------------------------


def _shore_distance(pts, boundary, reach: float, fast: bool) -> np.ndarray:
    """Metres from each post to the waterline, or `+inf` past `reach`.

    `fast=False` is the form this replaced -- every post against the whole
    boundary -- kept callable rather than deleted, because it is the reference
    `verify_conform_fast` compares against and a reference nobody can run is a
    claim rather than a check.
    """
    if not fast:
        return shapely.distance(pts, boundary)
    # `dwithin(pts, boundary, reach)` on a bare (Multi)LineString is NOT indexed:
    # GEOS extracts every line component and runs pointToSegment for every post,
    # so it is cheaper than `distance` by a constant and no better in order --
    # still posts × coastline. Sampled on the tidal level of the 60 km field
    # (a 121 × 121 km bounding box, ~11.5 M posts, one boundary of ~5,800
    # rings), the stack sat in `dwithin_func -> computeFacetDistance ->
    # pointToSegment` for a quarter of an hour without returning. That is why a
    # one-tile proof build was paying an hour of setup before emitting anything.
    #
    # So the near band is found from an index instead. The boundary is split into
    # its constituent line parts, filed in an STRtree, and each post asks the tree
    # for the parts within `reach` -- a logarithmic query. Only the posts with a
    # hit ever pay for a real distance, and that distance is against the whole
    # boundary as before, so the value is identical; only the *work* to decide
    # who needs it has changed. Bit-for-bit results are asserted by
    # `verify_conform_fast` against the reference above.
    parts = shapely.get_parts(boundary)
    if len(parts) == 0:
        return np.full(len(pts), np.inf)
    tree = shapely.STRtree(parts)
    hit_pts = np.unique(tree.query(pts, predicate="dwithin", distance=reach)[0])
    dist = np.full(len(pts), np.inf)
    if len(hit_pts):
        dist[hit_pts] = shapely.distance(pts[hit_pts], boundary)
    return dist


def conform(
    heights: np.ndarray, p0: int, q0: int, spacing: float, field: WaterField,
    fast: bool = True,
) -> dict:
    """Cut the bed in, and hold the land at the waterline. In place.

    `heights[qi, pi]` is the post at east `(p0 + pi) * spacing`, north
    `(q0 + qi) * spacing` -- `terrain._Lattice`'s layout, taken apart here so this
    module needs nothing from that one, exactly as `roadgrade.conform` does.

    Post-major rather than segment-major, which is the opposite of the road
    conformance and is right for the opposite reason: a road is ten thousand
    short segments each reaching a handful of posts, and water is a handful of
    very large polygons each reaching tens of thousands. So the query is
    vectorised the other way round -- one `contains_xy` and one `distance` per
    level over the posts in its bounding box.

    Runs **after** the road conform and therefore wins under a water polygon. No
    road *centreline* is under one -- bridges are excluded from the road solve
    entirely (`roadgrade._is_conformable`), so the Anzac Bridge and the Harbour
    Bridge never asked for ground here -- but that is not the same as the two
    passes not meeting, and the difference is measured rather than assumed: a
    foreshore street's conformance plateau reaches `roadgrade.LATTICE_REACH_M`
    past its corridor and therefore owns posts inside the harbour, which this cut
    then takes down by up to twenty metres in one lattice cell. 810 of the 823
    carriageway segments `road-grade-audit` finds over 15% are within 35 m of
    mapped water, against 13 without this pass. See `terrain.Terrain.load` for
    the whole of that argument and `cli._tidal_plan` for how the audit reports
    it. `water-audit` reports the polygon overlap.
    """
    if field.is_empty():
        return {"posts": int(heights.size), "wet": 0, "held": 0}

    q_n, p_n = heights.shape
    pi = np.arange(p_n)
    qi = np.arange(q_n)
    east = (pi + p0) * spacing
    north = (qi + q0) * spacing
    grid_e = np.repeat(east[None, :], q_n, axis=0)
    grid_n = np.repeat(north[:, None], p_n, axis=1)

    natural = heights.astype(np.float64)
    bed = np.full(heights.shape, np.inf)
    hold = np.full(heights.shape, -np.inf)
    wet = np.zeros(heights.shape, dtype=bool)
    held = np.zeros(heights.shape, dtype=bool)
    reach = max(FEATHER_OUT_M, spacing) * 1.5

    for lvl in field.levels:
        e0, n0, e1, n1 = lvl.geom.bounds
        # Only the posts this level can reach. A pond is forty metres across and
        # the lattice is nine kilometres.
        cols = np.where((east >= e0 - reach) & (east <= e1 + reach))[0]
        rows = np.where((north >= n0 - reach) & (north <= n1 + reach))[0]
        if len(cols) == 0 or len(rows) == 0:
            continue
        sub = np.ix_(rows, cols)
        shape = (len(rows), len(cols))
        ex = grid_e[sub].ravel()
        en = grid_n[sub].ravel()

        # --- THE BOUNDING BOX IS THE RIGHT FILTER FOR A POND AND NO FILTER AT
        #     ALL FOR THE OCEAN, and that is what made this the slowest call in
        #     the build.
        #
        # The comment above is about a pond, and for a pond it is exact. The
        # tidal level is the Pacific: its bounding box is the whole extent, so
        # `ex, en` is every post in the lattice -- ~11.5 M at 60 km, not the
        # 986 k the note was written against -- and the two calls below then ran
        # every one of them against the entire coastline. Four stack samples
        # twenty minutes apart during a five-tile `--only` run all landed inside
        # this `distance`, and the setup had not finished at 49 minutes.
        #
        # **The distance is only ever read where it is small.** `u` clips at
        # `FEATHER_IN_M` and `wants_hold` needs `dist <= FEATHER_OUT_M`, so a
        # post further than that from the shore has its distance computed,
        # smoothstepped and thrown away. Everything beyond the band is
        # `+inf`, which the two consumers already handle exactly right: `u`
        # clips to 1 -- full depth, which is what a post in the middle of the
        # ocean gets -- and `dist <= FEATHER_OUT_M` is false. So this is a
        # filter, not an approximation, and `verify_conform_fast` asserts the
        # two forms agree element-wise on the real field rather than arguing it.
        #
        # `reach` rather than `max(FEATHER_IN_M, FEATHER_OUT_M)`: it is the band
        # the correctness argument needs times 1.5, it is already the number the
        # bounding box was widened by, and the margin means no tie between
        # `dwithin`'s predicate and `distance`'s arithmetic can land on the one
        # post where `wants_hold` would flip.
        pts = shapely.points(ex, en)
        boundary = lvl.geom.boundary

        # Prepared, and this is the other half of the cost. `contains_xy` over
        # eleven million posts against an unprepared ocean is a linear scan of
        # its rings per post; prepared, it is an index lookup. The predicate is
        # the same predicate -- preparing changes what it costs, never what it
        # answers -- so `inside` stays exact over the whole disc, which it has
        # to: `wants_bed` is true for most of the extent and there is no band to
        # restrict it to.
        if fast:
            shapely.prepare(lvl.geom)
            shapely.prepare(boundary)

        inside = shapely.contains_xy(lvl.geom, ex, en)
        dist = _shore_distance(pts, boundary, reach, fast)

        # Inside: the bed, ramping from the shore clearance at the boundary to
        # full depth one post in. Smoothstep rather than linear so the bed is C1
        # where it meets the plateau and there is no crease along the shore.
        u = np.clip(dist / FEATHER_IN_M, 0.0, 1.0)
        ramp = u * u * (3.0 - 2.0 * u)
        target = lvl.surface - (SHORE_CLEARANCE_M + (lvl.depth - SHORE_CLEARANCE_M) * ramp)

        # The hold is for **tidal water only**, and the reason is a measured
        # disaster rather than a nicety. Sea level is a global surface and no dry
        # ground in the extent is legitimately under it, so holding the band
        # around the harbour at it costs nothing and closes the trench. A pond is
        # the opposite: it is held up by its own bank, the ground downhill of it
        # falls away within a post by design, and holding that band at the pond's
        # surface lifted real ground by up to 24.3 m -- a plateau around every
        # pond in Centennial Park.
        wants_bed = inside.reshape(shape)
        wants_hold = (
            ((~inside) & (dist <= FEATHER_OUT_M)).reshape(shape)
            if lvl.tidal
            else np.zeros(shape, dtype=bool)
        )
        bed[sub] = np.where(wants_bed, np.minimum(bed[sub], target.reshape(shape)), bed[sub])
        hold[sub] = np.where(wants_hold, np.maximum(hold[sub], lvl.surface), hold[sub])
        wet[sub] |= wants_bed
        held[sub] |= wants_hold

    # Both accumulators are resolved in one pass at the end, and the order is the
    # whole reason for two of them. A pond that abuts tidal water puts its own
    # feather band over the harbour's posts, and applying the two levels in
    # sequence would let the pond's `hold` lift the harbour's bed back to the
    # pond's surface. Being *inside* any water wins over being beside any other,
    # unconditionally.
    out = np.where(wet, np.minimum(natural, bed), natural)
    out = np.where(held & ~wet, np.maximum(out, hold), out)
    moved = np.abs(out - natural)
    heights[:] = out.astype(heights.dtype)
    wet_moved = moved[wet]
    # `held & ~wet`, not `held`: a post can be inside one level and inside
    # another's feather band at once -- every pond that abuts the harbour has
    # some -- and counting its *cut* as a lift reported a 10.65 m rise of ground
    # that had not moved up at all.
    lifted = moved[held & ~wet]
    return {
        "posts": int(heights.size),
        "wet": int(wet.sum()),
        "held": int((held & ~wet).sum()),
        "cut_p50": float(np.percentile(wet_moved, 50)) if wet_moved.size else 0.0,
        "cut_max": float(wet_moved.max()) if wet_moved.size else 0.0,
        "lifted_max": float(lifted.max()) if lifted.size else 0.0,
        "levels": len(field.levels),
    }


def verify_conform_fast(
    field: WaterField, heights: np.ndarray, p0: int, q0: int, spacing: float
) -> list[str]:
    """The near-boundary filter changes what `conform` costs and nothing else.

    Runs the shipped path and the form it replaced over the **same lattice from
    the same field**, and compares the conformed heights, the wet mask, the held
    mask and every reported statistic. Not "close" -- `np.array_equal` on the
    heights, which is bit equality, because the whole claim is that a post more
    than `reach` from the shore reads its distance through two clamps that
    saturate, so the filter is exact rather than tolerable.

    A tolerance here would be the wrong instrument twice over: it would pass a
    filter that is subtly wrong at the shore, and it would pass one that is
    catastrophically wrong in the deep ocean, where `u` clips to 1 either way
    and any error hides.

    Returns the failures, empty when the two agree.
    """
    out: list[str] = []
    a = heights.copy()
    b = heights.copy()
    stats_fast = conform(a, p0, q0, spacing, field, fast=True)
    stats_ref = conform(b, p0, q0, spacing, field, fast=False)
    if not np.array_equal(a, b):
        bad = int(np.count_nonzero(a != b))
        worst = float(np.abs(a.astype(np.float64) - b.astype(np.float64)).max())
        out.append(
            f"{bad:,} of {a.size:,} conformed posts differ between the filtered and "
            f"unfiltered distance, worst {worst:.6f} m"
        )
    for key in sorted(set(stats_fast) | set(stats_ref)):
        if stats_fast.get(key) != stats_ref.get(key):
            out.append(f"stat {key}: filtered {stats_fast.get(key)!r} against "
                       f"unfiltered {stats_ref.get(key)!r}")
    return out


# --- The sheets ----------------------------------------------------------------


@dataclass
class WaterSheet:
    """One flat run of water, triangulated, ready for a sidecar.

    `verts` is (N, 2) in ENU metres and `depth` is (N,) metres of water over the
    bed at that vertex. The depth is a **vertex attribute rather than a shader
    lookup** because the client has no way to sample the terrain in a fragment,
    and it interpolates exactly rather than approximately: every triangle here
    lies inside a single terrain facet, the facet is planar, so `surface - ground`
    is linear across it and the three corners determine it everywhere between.
    """

    surface: float
    verts: np.ndarray
    depth: np.ndarray
    tris: np.ndarray

    @property
    def triangles(self) -> int:
        return len(self.tris)


def _parts(geom: BaseGeometry, min_area: float) -> list[Polygon]:
    if geom.is_empty:
        return []
    from shapely.geometry.polygon import orient

    candidates = list(geom.geoms) if hasattr(geom, "geoms") else [geom]
    return [
        orient(p, 1.0)
        for p in candidates
        if p.geom_type == "Polygon" and p.area >= min_area
    ]


def _sheet_from_pieces(surface: float, pieces: list[Polygon], sample) -> WaterSheet | None:
    """Triangulate a set of already-cut pieces into one sheet."""
    from . import mesh

    verts: list[np.ndarray] = []
    tris: list[np.ndarray] = []
    base = 0
    for poly in pieces:
        t, v = mesh._triangulate(
            np.asarray(poly.exterior.coords),
            [np.asarray(h.coords) for h in poly.interiors],
        )
        if len(t) == 0:
            continue
        verts.append(v)
        tris.append(np.asarray(t) + base)
        base += len(v)
    if not verts:
        return None
    v = np.concatenate(verts)
    ground = np.asarray(sample(v[:, 0], v[:, 1]), dtype=np.float64)
    # Clamped at zero: a vertex on the shore can land a few millimetres over the
    # surface where the mapped edge and the lattice disagree, and a negative
    # depth is a shore tint the client would read as an inverted one.
    depth = np.maximum(surface - ground, 0.0)
    return WaterSheet(surface=surface, verts=v, depth=depth, tris=np.concatenate(tris))


def _wet_pieces(poly: BaseGeometry, terrain, surface: float) -> list[Polygon]:
    """Cut a polygon to the terrain's facets and keep only what is under water.

    **Both halves matter and they are the same walk**, which is why this does not
    call `streets._conform` even though the first half is exactly that function.

    *The facet cut* is what makes a per-vertex quantity exact rather than nearly
    right: a sheet spanning a whole 31.25 m cell would carry a depth that is the
    bilinear interpolation of its corners while the ground under it is two flat
    triangles, and the shore tint would run tens of centimetres out of step with
    the bed it describes.

    *The underwater clip* is what stops the ground coming through the water, and
    it needs the facet's own plane -- which `streets._conform` has and throws
    away. Inside one facet the ground is planar and the surface is constant, so
    "where is there water" is a half-plane, and clipping to it is exact. Without
    it the water is drawn over every square metre of the mapped polygon, and a
    31.25 m lattice cannot put its zero crossing on a shoreline: measured over
    the eight rebuilt harbour tiles, 1,644 of 7,590 sheet vertices stood over
    ground *above* the water, the worst by 31 m, wherever the shore is a cliff.
    Trimmed here, the drawn edge is the ground's own waterline -- which is the
    one the player can actually see.
    """
    from shapely.geometry import Polygon as ShapelyPolygon

    e0, n0, e1, n1 = poly.bounds
    facets = np.asarray(terrain.facets((e0, n0, e1, n1)), dtype=object)
    if len(facets) == 0:
        return []
    hits = facets[shapely.intersects(poly, facets)]
    reach = 4.0 * terrain.spacing

    out: list[Polygon] = []
    for facet in hits:
        piece = poly.intersection(facet)
        if piece.is_empty:
            continue
        corners = np.asarray(facet.exterior.coords)[:3]
        h = np.asarray(terrain.sample(corners[:, 0], corners[:, 1]), dtype=np.float64)
        # The facet's plane, from its own three corners: h = h0 + a*dx + b*dy.
        d1 = corners[1] - corners[0]
        d2 = corners[2] - corners[0]
        det = d1[0] * d2[1] - d1[1] * d2[0]
        if abs(det) < 1e-9:
            continue
        a = ((h[1] - h[0]) * d2[1] - (h[2] - h[0]) * d1[1]) / det
        b = (d1[0] * (h[2] - h[0]) - d2[0] * (h[1] - h[0])) / det
        # `surface - MIN_DRAWN_DEPTH_M - h0` is how far the plane may rise from
        # the first corner before the water is too thin to draw.
        room = surface - MIN_DRAWN_DEPTH_M - h[0]
        grad = math.hypot(a, b)
        if grad < 1e-9:
            # A level facet: the whole of it is under or over, with no line to
            # cut on. Every facet of the harbour's own floor is one of these.
            if room >= 0.0:
                out.extend(_parts(piece, 1e-4))
            continue
        # The half-plane `a*dx + b*dy <= room`, as a rectangle four post spacings
        # long -- comfortably past a facet, whose longest side is 44 m.
        nx, ny = a / grad, b / grad
        offset = room / grad
        cx = corners[0][0] + nx * offset
        cy = corners[0][1] + ny * offset
        tx_, ty = -ny, nx
        half = ShapelyPolygon(
            (
                (cx + tx_ * reach, cy + ty * reach),
                (cx - tx_ * reach, cy - ty * reach),
                (cx - tx_ * reach - nx * 2 * reach, cy - ty * reach - ny * 2 * reach),
                (cx + tx_ * reach - nx * 2 * reach, cy + ty * reach - ny * 2 * reach),
            )
        )
        wet = piece.intersection(half)
        if not wet.is_empty:
            out.extend(_parts(wet, 1e-4))
    return out


def tile_sheets(field: WaterField, tile_key: str, terrain) -> list[WaterSheet]:
    """One tile's water: clipped to the tile, to the facets and to the ground."""
    tx, tz = (int(v) for v in tile_key.split("_"))
    s = config.TILE_SIZE
    cell = box(tx * s, tz * s, (tx + 1) * s, (tz + 1) * s)

    out: list[WaterSheet] = []
    for lvl in field.levels:
        if not lvl.geom.intersects(cell):
            continue
        # The overlap is applied to the *water* and then clipped to the tile, so
        # a sheet still stops dead on the tile boundary and two neighbours meet
        # exactly. See `SHORE_OVERLAP_M`.
        grown = lvl.geom.buffer(
            SHORE_OVERLAP_M if lvl.tidal else POND_OVERLAP_M, join_style=2
        )
        clipped = grown.intersection(cell)
        if clipped.is_empty:
            continue
        pieces: list[Polygon] = []
        for part in _parts(clipped, 1.0):
            pieces.extend(_wet_pieces(part, terrain, lvl.surface))
        sheet = _sheet_from_pieces(lvl.surface, pieces, terrain.sample)
        if sheet is not None and sheet.triangles:
            out.append(sheet)
    return out


# Cell size of the far sheet's cut, metres.
#
# A triangle budget rather than an accuracy target, on `tiles.FAR_MAX_POSTS`'
# terms: the far water is always resident and always drawn, and the only thing
# its tessellation decides is how finely the shore tint varies -- the waves are
# analytic in the fragment shader and want no vertices at all. 250 m over the
# extent's 19.8 km2 of water is about 700 triangles.
FAR_CELL_M = 250.0

# How far the far sheet sits below the near ones, metres.
#
# The two overlap wherever a streamed tile has water in it, and they are the same
# surface: without a separation they are coplanar, which is the exact artefact
# this module exists to remove, one layer up. 0.35 m is under the depth buffer's
# resolution nowhere it matters (1.9 cm at 300 m) and is invisible as a step
# because the near sheet always sits on top and is opaque.
FAR_SINK_M = 0.35


# How hard the far sheet's outline is simplified, metres.
#
# The cut against `FAR_CELL_M` costs a few hundred triangles and the *coastline*
# costs the rest: Port Jackson's boundary carries 7,119 vertices at metre detail,
# every one of which survives into a cell piece. Three metres takes the far layer
# from 10,279 triangles to a third of that and is a tenth of a pixel at the
# 1,800 m streaming radius, which is the nearest this sheet is ever the one being
# looked at -- inside it there is a tile with the exact outline on it.
FAR_SIMPLIFY_M = 3.0


def far_sheets(field: WaterField, terrain) -> list[WaterSheet]:
    """The extent's tidal water as one coarse sheet, in ENU metres.

    What fills the harbour where there is no tile at all -- 52 of the 176 tiles
    water touches earn no tile, because a tile is emitted only where there is
    something to stand on -- and what carries the water to the horizon past the
    streaming radius. `tiles.write_far_water` is what turns it into world
    coordinates.

    **Tidal levels only.** A pond is at most 5.4 ha and is inside the streaming
    radius by construction (they are all in Centennial Park and Victoria Park),
    so its own tile draws it; adding the 36 inland levels here would put 36 more
    sheets and two thirds of the triangles into an always-resident file to draw
    ponds that are two pixels across at the range this is seen from.
    """
    out: list[WaterSheet] = []
    for lvl in field.levels:
        if not lvl.tidal:
            continue
        e0, n0, e1, n1 = lvl.geom.bounds
        cells = [
            box(x, y, x + FAR_CELL_M, y + FAR_CELL_M)
            for x in np.arange(math.floor(e0 / FAR_CELL_M), math.ceil(e1 / FAR_CELL_M)) * FAR_CELL_M
            for y in np.arange(math.floor(n0 / FAR_CELL_M), math.ceil(n1 / FAR_CELL_M)) * FAR_CELL_M
        ]
        if not cells:
            continue
        coarse = lvl.geom.simplify(FAR_SIMPLIFY_M)
        if coarse.is_empty or not coarse.is_valid:
            coarse = lvl.geom
        grid = np.asarray(cells, dtype=object)
        hits = grid[shapely.intersects(coarse, grid)]
        pieces: list[Polygon] = []
        for piece in shapely.intersection(coarse, hits):
            pieces.extend(_parts(piece, 1.0))
        sheet = _sheet_from_pieces(lvl.surface - FAR_SINK_M, pieces, terrain.sample)
        if sheet is not None and sheet.triangles:
            out.append(sheet)
    return out
