"""Terrace rows mapped as one polygon, cut back into individual houses.

WHY THIS PASS EXISTS. OSM's Sydney mapping is inconsistent about terraces in a
way that costs more than any other single data problem in the inner ring. Some
mappers trace each house; plenty trace the whole row as one way, 30-130 m long
and 9-23 m deep, tagged `building=terrace` or nothing at all. The pipeline then
treats that way as one building, and one building means one material draw, one
facade seed, one continuous window rhythm and one dead-flat parapet running the
length of a city block. A Darlington street that should read as twenty houses
reads as one enormous shed.

It is worse than cosmetic, because the classifier cannot even name it. Its
terrace test asks for a minimum-rectangle short side under 8.5 m -- which for a
whole row is the row's *depth*, around 10-14 m, while the long side is the row's
*length*. So the row fails the one test that exists for it and lands in
walkup/interwar_apartment/warehouse instead, taking those archetypes' materials,
bay widths and floor heights with it.

So: detect those polygons, cut them perpendicular to the long axis into
dwelling-width slices, and let the ordinary classifier see each slice. Nothing
downstream needs to know this happened. A slice is a `Building` like any other,
and the terrace test it was always going to pass now gets a footprint shaped the
way that test expects.

## The one rule that makes detection safe

Every threshold here is negotiable except this one: **the short side must be at
least 8.5 m.** That is not a tuned number, it is `attributes.classify`'s own
terrace threshold read backwards. A footprint whose short side is under 8.5 m is
*already* classified as a single terrace and is already correct -- cutting it
would slice one house into four crosswise chunks, front room from back room,
which is the worst thing this module could possibly do. At or above 8.5 m the
short side cannot be a single dwelling's frontage and must be its depth, so the
long axis is a run of frontages. The two rules partition the space with no
overlap and no gap, which is why they can be trusted together.

## Two tiers, because a tag is worth more than a measurement

`building=terrace` means, in OSM's own words, a row of dwellings. Where it is
present the geometry only has to be plausible. Where it is absent -- `yes`, or
untagged, or a Microsoft footprint -- geometry carries the whole argument and
the bar goes up: longer, narrower, more rectangular, bigger, and unnamed. A
named building is an institution or an apartment block ("Bridgeview", "Atlas
Apartments Building C", "Sydney Metro Site Office"); terrace rows do not have
names. That one exclusion removes most of the false positives on its own.

Conservative on purpose. A missed row stays as it is today, which is a known and
survivable ugliness. A school or a warship cut into 5.8 m houses is a new and
much louder wrong -- HMAS Vampire is 118 m long, 14 m in the beam, low-rise and
rectangular, and only its `building=ship` tag keeps it off this list.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from shapely.geometry import Polygon

from . import mesh
from .attributes import _STREAM_FRONTAGE, INNER_SUBURB_RADIUS, _stable_seed, _uniform
from .merge import ROW_SLICE_SEP, Building, orient_footprint

# --- Frontage ----------------------------------------------------------------

# Sydney's terrace frontage. The stock was built to imperial lot widths -- 20 ft
# for a worker's cottage, 25 ft for a standard terrace, 30 ft for a wide one --
# so 5.8 m is a hair under 19 ft and sits just below the middle of what actually
# got built. Deliberately at the narrow end: an under-estimate cuts a row into
# one house too many, which reads as a slightly narrow terrace; an over-estimate
# cuts it into one too few, which reads as a semi and defeats the exercise.
TARGET_FRONTAGE = 5.8

# Hard bounds on any one slice. Below 4.8 m the window grid has no room for a
# bay plus its reveals and the house reads as a pillar; above 7.2 m it stops
# reading as a terrace at all.
MIN_FRONTAGE = 4.8
MAX_FRONTAGE = 7.2

# How far a cut may wander from the even division, metres. Applied to the cut
# *position*, not to the width -- see `_cut_positions` for why that distinction
# is the whole trick.
FRONTAGE_JITTER = 0.5

# --- Detection ---------------------------------------------------------------

# Below this the min-rect short side is a dwelling frontage, not a row depth,
# and `attributes.classify` is already reading the building correctly. See the
# module docstring: this is the load-bearing threshold.
MIN_ROW_DEPTH = 8.5

# A row's depth is the house depth. Untagged, cap it at the depth of a plain
# terrace so a 16 m-deep block of flats cannot qualify. Tagged `building=terrace`
# the cap goes out to 24 m, because Sydney rows with their rear wings mapped as
# part of the outline genuinely run that deep -- Darlington and Chippendale are
# full of 20-23 m ones and they are the most valuable rows in the extent.
MAX_ROW_DEPTH = 16.0
MAX_ROW_DEPTH_TAGGED = 24.0

# Past 140 m a single OSM way is not a terrace row, it is a whole block traced
# in one go or a railway platform canopy.
MAX_ROW_LENGTH = 140.0

# How many dwellings the long side has to imply before the polygon is worth
# cutting. Four with a row tag, six without: a shorter run is as likely to be
# one deep house or a pair of semis, and getting that wrong is expensive.
MIN_DWELLINGS_TAGGED = 4
MIN_DWELLINGS_UNTAGGED = 6

# How much of its own minimum rectangle the footprint has to fill. An L-shaped
# or block-ring polygon at 0.4 is not a row with a common frontage line, and
# slicing it produces disconnected fragments.
MIN_RECTANGULARITY = 0.6

# Extra geometry the untagged tier has to clear on its own.
MIN_ELONGATION_UNTAGGED = 2.6
MIN_AREA_UNTAGGED = 400.0

# Low-rise, because a terrace is. Only *stated* values are tested -- an inferred
# height cannot be evidence here, since it comes from the archetype and the
# wrong archetype is the symptom this pass exists to cure. Three storeys rather
# than two: Paddington and Glebe rows run to three and they are real terraces.
MAX_ROW_LEVELS = 3
MAX_ROW_HEIGHT = 12.0

# OSM says this is a row of dwellings. Believed, subject to the geometry above.
ROW_TAGS = frozenset({"terrace", "semidetached_house", "townhouses"})

# OSM says this is one building containing many dwellings, which is the opposite
# claim. Never split, at any geometry.
BLOCK_TAGS = frozenset({"apartments", "flats", "units", "dormitory", "hotel", "hostel"})

# Anything that is not housing. Broader than `attributes.TYPE_HINTS` because
# this list only has to answer "could this conceivably be a row of houses", and
# for `ship`, `roof` and `station` the answer is a cheap no. The cost asymmetry
# runs entirely one way: a tag missing from here risks a sliced warship, a tag
# wrongly in here costs one un-split row.
NON_RESIDENTIAL_TAGS = frozenset({
    "warehouse", "industrial", "factory", "shed", "hangar", "storage_tank", "silo",
    "retail", "supermarket", "commercial", "office", "kiosk", "fuel",
    "school", "college", "university", "kindergarten", "church", "chapel",
    "cathedral", "mosque", "synagogue", "temple", "monastery", "shrine",
    "hospital", "civic", "public", "government", "fire_station", "police",
    "train_station", "transportation", "station", "museum", "stadium",
    "grandstand", "sports_hall", "sports_centre", "pavilion", "greenhouse",
    "roof", "carport", "garage", "garages", "parking", "service", "construction",
    "toilets", "boathouse", "ship", "pub", "bar", "restaurant", "cafe",
    "bunker", "water_tower", "military", "barn", "stable", "farm_auxiliary",
    "tent", "container", "hut", "cabin",
})

# Generic tags a slice must not carry forward. `building=residential` or
# `=house` on a 90 m polygon is a statement about the whole row, and once the
# row has been cut that statement has been consumed: `attributes.TYPE_HINTS`
# short-circuits `residential` straight to walkup, which would hand a 5.8 m
# house a 3.6 m bay width and aluminium sliders. Row tags are kept, because they
# already say "terrace" and that is exactly what the slice is.
GENERIC_TAGS_TO_CLEAR = frozenset({"residential", "house", "detached", "yes"})

# --- Party wall ---------------------------------------------------------------

# Adjacent slices share a wall, and both sides get walls built, so without this
# the two faces are exactly coplanar and z-fight across the entire party wall of
# every house in the row -- a shimmering seam that crawls with the camera and is
# far more visible than any gap.
#
# 15 mm per side, so 30 mm between neighbours. Chosen against two constraints
# pulling opposite ways. It has to survive `merge.store`, which rounds ring
# coordinates to 1 cm; on a cut line at an arbitrary bearing that perturbs each
# face by at most 0.5 * sqrt(2) = 7 mm, so 30 mm of design separation cannot
# round to zero. And it has to be invisible, which 30 mm at any distance a player
# stands from a terrace comfortably is -- narrower than the mortar course beside
# it.
#
# The alternative was to skip generating the shared faces altogether: fewer
# triangles, no gap at all. Rejected because it costs far more than it saves.
# `mesh.build_walls` accumulates its `u` coordinate along the ring specifically
# so a window rhythm survives a corner, and dropping edges out of that walk
# breaks the invariant the accumulator exists to hold. Each slice would also
# stop being a closed prism, which `write_collision` and the roof triangulation
# both assume. And it would need per-edge adjacency threaded from here into the
# mesh builder. The inset is one constant and touches nothing downstream, at a
# cost of four triangles a house -- about 19k over the inner ring, against 1.5 M.
#
# The 2-3 cm step this leaves between two neighbours' parapets at roof level is
# not a defect. It is the point: see `attributes.parapet_jitter`.
PARTY_WALL_INSET = 0.015

# A slice smaller than this is not a house, it is a corner the cut clipped off a
# non-rectangular row. Folded into its neighbour rather than emitted.
MIN_SLICE_AREA = 25.0

# The slices must between them still cover the ground the row covered.
#
# THIS IS THE GUARD THAT MAKES `_largest_part` SAFE, and it earns its place by
# catching a case no threshold above does. A staggered row -- houses stepping
# back one by one down a slope, which is how half of Glebe is built -- has a
# minimum rectangle at an angle to its own frontages, so a cut perpendicular to
# that rectangle crosses the steps rather than the party walls and lands one
# house in two disconnected pieces. `_largest_part` then discards the smaller,
# and the row quietly loses a third of its floor area to a rule that was written
# for a one-metre offcut.
#
# So rather than trying to detect staggering up front, the cut is simply checked
# afterwards against the only thing that matters: a split row must stand on the
# same ground the whole row did. The party-wall insets are the one designed loss,
# and they are bounded -- (n-1) cuts at 2 x 15 mm across the depth, against
# n frontages of at least 4.8 m, is at most 0.03 / 5.8 = 0.52% however long the
# row is. Anything under 98% lost ground to something else, and that row is left
# whole: an un-split mega-facade is a known ugliness, a house-sized hole in a
# terrace row is a new one.
MIN_AREA_CONSERVED = 0.98


@dataclass
class RowReport:
    """What the split did, for the build log.

    Frontages are carried out whole rather than pre-summarised because the
    failure this pass is prone to -- a division that drifts and leaves a 3 m or a
    9 m house at one end of every row -- is invisible in a count and obvious in a
    range.
    """

    rows_tagged: int = 0
    rows_geometry: int = 0
    slices: int = 0
    lengths: list[float] = field(default_factory=list)
    frontages: list[float] = field(default_factory=list)
    slivers_merged: int = 0
    multipart_cuts: int = 0
    rows_not_conserved: int = 0

    @property
    def rows(self) -> int:
        return self.rows_tagged + self.rows_geometry


# --- Detection ----------------------------------------------------------------


def _low_rise(b: Building) -> bool:
    """Only what OSM actually stated; see MAX_ROW_LEVELS on why inference is out."""
    if b.levels is not None and b.levels > MAX_ROW_LEVELS:
        return False
    return b.stated_height is None or b.stated_height <= MAX_ROW_HEIGHT


def row_kind(b: Building, poly: Polygon, long_side: float, short_side: float) -> str | None:
    """'tagged', 'geometry', or None if this footprint must not be cut."""
    t = b.building_type
    if t in NON_RESIDENTIAL_TAGS or t in BLOCK_TAGS:
        return None
    if math.hypot(*b.centroid) >= INNER_SUBURB_RADIUS:
        return None
    if not _low_rise(b):
        return None
    if short_side < MIN_ROW_DEPTH or long_side > MAX_ROW_LENGTH:
        return None
    rect_area = long_side * short_side
    if rect_area <= 1.0 or poly.area / rect_area <= MIN_RECTANGULARITY:
        return None

    if t in ROW_TAGS:
        if short_side > MAX_ROW_DEPTH_TAGGED:
            return None
        if long_side < MIN_DWELLINGS_TAGGED * TARGET_FRONTAGE:
            return None
        return "tagged"

    # No tag saying "row". Geometry has to carry it alone.
    if b.name:
        return None
    if short_side > MAX_ROW_DEPTH or poly.area < MIN_AREA_UNTAGGED:
        return None
    if long_side / short_side < MIN_ELONGATION_UNTAGGED:
        return None
    if long_side < MIN_DWELLINGS_UNTAGGED * TARGET_FRONTAGE:
        return None
    return "geometry"


# --- Cutting ------------------------------------------------------------------


def slice_id(parent_id: str, index: int) -> str:
    """Stable across rebuilds, because everything downstream seeds off it.

    The parent id is already stable per source -- `merge` namespaces OSM ways
    with `o`, and `msbuildings._stable_id` quantises Microsoft centroids to 10 cm
    for exactly this reason -- and the index counts from the same end of the same
    axis every build, so the whole id is. That matters more here than elsewhere:
    the index is the only thing separating one house's material, facade seed and
    parapet height from its neighbour's, so an unstable index would repaint and
    re-step the entire row on every build.
    """
    return f"{parent_id}{ROW_SLICE_SEP}{index}"


def _cut_positions(parent_id: str, length: float) -> list[float]:
    """Cut offsets along the long axis, 0 to `length` inclusive.

    JITTER THE CUTS, NOT THE WIDTHS. Drawing each frontage independently as
    5.8 +/- 0.5 leaves the last slice absorbing the accumulated error, which over
    a 23-house row is a random walk with a standard deviation near 1.4 m and a
    tail well outside any bound worth having -- one house in the row comes out
    2 m or 10 m wide. Jittering the *positions* makes the error zero-sum by
    construction: every cut is displaced from its even division independently,
    both ends are pinned, and each frontage is the difference of two neighbouring
    displacements.

    The walk is then clamped so no frontage can leave [MIN, MAX] even where two
    adjacent jitters conspire, with the clamp also reserving room for every slice
    still to come -- which is what lets the last slice absorb the remainder and
    still be a house. That interval is never empty, because the even division
    `length / n` is itself inside the bounds by the choice of `n`.
    """
    n = max(2, round(length / TARGET_FRONTAGE))
    # `n` from rounding puts `base` in [5.8 - 2.9/n, 5.8 + 2.9/n], inside
    # [4.8, 7.2] for every n >= 2. Clamped anyway: a row at the very edge of the
    # length filter should degrade quietly rather than trip an assertion.
    base = min(max(length / n, MIN_FRONTAGE), MAX_FRONTAGE)

    out = [0.0]
    for i in range(1, n):
        u = _uniform(_stable_seed(slice_id(parent_id, i)), _STREAM_FRONTAGE)
        ideal = i * base + (2.0 * u - 1.0) * FRONTAGE_JITTER
        remaining = n - i
        lo = max(out[-1] + MIN_FRONTAGE, length - remaining * MAX_FRONTAGE)
        hi = min(out[-1] + MAX_FRONTAGE, length - remaining * MIN_FRONTAGE)
        out.append(min(max(ideal, lo), max(lo, hi)))
    out.append(length)
    return out


def _band(
    centre: np.ndarray,
    long_axis: np.ndarray,
    short_axis: np.ndarray,
    half_short: float,
    u0: float,
    u1: float,
) -> Polygon:
    """A rectangle spanning [u0, u1] along the long axis, in ENU."""
    # Overshoot the short axis: the minimum rectangle only touches the polygon,
    # and an exact fit leaves float-noise slivers along the front and back walls.
    v = half_short + 2.0
    corners = (
        centre + long_axis * u0 - short_axis * v,
        centre + long_axis * u1 - short_axis * v,
        centre + long_axis * u1 + short_axis * v,
        centre + long_axis * u0 + short_axis * v,
    )
    return Polygon([(float(p[0]), float(p[1])) for p in corners])


def _largest_part(geom) -> tuple[Polygon | None, bool]:
    """(one polygon, whether the cut produced more than one piece).

    A row whose outline steps in and out -- a rear wing on every second house, a
    corner shop -- can hand back two disconnected pieces for one slice. The
    larger is the house; the other is a metre of the neighbour's back wall and
    belongs to the neighbour's slice, which claims it there.
    """
    if geom is None or geom.is_empty:
        return None, False
    if geom.geom_type == "Polygon":
        return geom, False
    parts = [g for g in getattr(geom, "geoms", ()) if g.geom_type == "Polygon" and not g.is_empty]
    if not parts:
        return None, False
    return max(parts, key=lambda g: g.area), len(parts) > 1


def _absorb_slivers(parts: list[Polygon]) -> tuple[list[Polygon], int]:
    """Fold sub-`MIN_SLICE_AREA` pieces into the neighbour they abut.

    Union rather than drop, so a split row still covers the ground its footprint
    did. A sliver sits at one end of the run or against a notch, so its only
    neighbour along the long axis is the piece before it -- or, for a leading
    sliver, the piece after. The union can leave a shape whose min-rect is no
    longer 5.8 m wide, and that is correct: absorbing a 2 m tail makes one 7.8 m
    house, which is what the ground actually says is there.
    """
    kept: list[Polygon] = []
    merged = 0
    for p in parts:
        if p.area >= MIN_SLICE_AREA or not kept:
            kept.append(p)
            continue
        u = kept[-1].union(p)
        fixed, _ = _largest_part(u if u.is_valid else u.buffer(0))
        if fixed is not None:
            kept[-1] = fixed
            merged += 1
    # A leading sliver has no earlier neighbour, so it goes forwards instead.
    if len(kept) > 1 and kept[0].area < MIN_SLICE_AREA:
        u = kept[0].union(kept[1])
        fixed, _ = _largest_part(u if u.is_valid else u.buffer(0))
        if fixed is not None:
            kept[1] = fixed
            kept.pop(0)
            merged += 1
    return kept, merged


def _slice_building(parent: Building, index: int, poly: Polygon) -> Building:
    """One slice as a `Building`, inheriting everything the parent stated.

    The ring goes through `orient_footprint` because a slice is a *clip result*
    and not the parent's ring: GEOS decides the winding of an overlay output,
    the parent's winding does not survive into it, and a slice is a `Building`
    like any other and owes the same invariant. Without this the row slicer
    would be a second source of mixed winding downstream of the one this fixes
    -- and rows are 4,184 of the inner ring's buildings, all of them terraces,
    which is the stock the facade grammar is aimed at.
    """
    c = poly.centroid
    btype = parent.building_type
    if btype in GENERIC_TAGS_TO_CLEAR:
        btype = None
    ring, holes = orient_footprint(
        np.asarray(poly.exterior.coords, dtype=np.float64),
        [np.asarray(h.coords, dtype=np.float64) for h in poly.interiors],
    )
    return Building(
        id=slice_id(parent.id, index),
        source=parent.source,
        ring=ring,
        holes=holes,
        area=float(poly.area),
        centroid=(float(c.x), float(c.y)),
        osm_id=parent.osm_id,
        name=parent.name,
        building_type=btype,
        # Stated levels and height pass to every slice: a surveyed two storeys is
        # two storeys for each house in the row, not for the row as an object.
        levels=parent.levels,
        stated_height=parent.stated_height,
        ms_height=parent.ms_height,
        material=parent.material,
        colour=parent.colour,
        roof_shape=parent.roof_shape,
        roof_material=parent.roof_material,
        start_date=parent.start_date,
        heritage=parent.heritage,
        amenity=parent.amenity,
        shop=parent.shop,
    )


def split_row(b: Building, frame, report: RowReport) -> list[Building] | None:
    """Cut one row into slices, or None if the cut did not produce a row.

    CUT WITH BANDS, NOT WITH LINES. `shapely.ops.split` against a cutting line
    has to decide which side of an exactly-collinear edge each vertex falls on,
    which on a footprint whose walls run parallel to the cut is precisely the
    case it handles worst -- and it fails by returning the polygon uncut, with no
    error. Intersecting with a rectangle is the same operation stated as an area,
    robust for the same reason any clip is: no vertex has to be classified, and
    holes, notches and concavities come out of it intact and already assigned to
    whichever slice they fall in.
    """
    centre, long_axis, short_axis, half_long, half_short = frame
    poly = Polygon(b.ring, b.holes)
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon":
        return None

    cuts = _cut_positions(b.id, 2.0 * half_long)
    pieces: list[Polygon] = []
    # Counted locally and committed only if the row survives every check below,
    # so the report describes what was emitted rather than what was attempted.
    multipart = 0
    for i in range(len(cuts) - 1):
        # Inset off every *internal* cut only. The two ends of the run are the
        # row's real end walls and stay flush with the parent outline, so a split
        # row occupies exactly the ground the polygon always did.
        u0 = -half_long + cuts[i] + (PARTY_WALL_INSET if i > 0 else 0.0)
        u1 = -half_long + cuts[i + 1] - (PARTY_WALL_INSET if i + 2 < len(cuts) else 0.0)
        part, split_in_two = _largest_part(
            poly.intersection(_band(centre, long_axis, short_axis, half_short, u0, u1))
        )
        if part is not None and not part.is_valid:
            part, _ = _largest_part(part.buffer(0))
        if part is None:
            continue
        multipart += int(split_in_two)
        pieces.append(part)

    if len(pieces) < 2:
        return None
    kept, merged = _absorb_slivers(pieces)
    if len(kept) < 2:
        return None
    if sum(p.area for p in kept) < MIN_AREA_CONSERVED * poly.area:
        report.rows_not_conserved += 1
        return None
    report.slivers_merged += merged
    report.multipart_cuts += multipart
    return [_slice_building(b, i, p) for i, p in enumerate(kept)]


def _frontage_of(b: Building, frame) -> float:
    """A slice's extent along the parent row's long axis, for the report.

    Measured in the parent's frame rather than as the slice's own min-rect short
    side, because after a sliver absorption those are no longer the same number,
    and the frontage -- what someone standing on the footpath sees -- is the one
    worth reporting.
    """
    long_axis = np.asarray(frame[1], dtype=np.float64)
    t = mesh._ring_open(b.ring) @ long_axis
    return float(t.max() - t.min())


def split_rows(buildings: list[Building]) -> tuple[list[Building], RowReport]:
    """Replace every detected row with its slices, in place of the parent.

    Runs after `merge` and before `attributes`, which is the only window where it
    can. Earlier and the merge would have to reason about Microsoft footprints
    overlapping slices of the same building rather than whole ones; later and the
    classifier has already seen the row, which is the whole problem.
    """
    report = RowReport()
    out: list[Building] = []
    for b in buildings:
        poly = Polygon(b.ring, b.holes)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty or poly.geom_type != "Polygon":
            out.append(b)
            continue
        # Borrowed from `mesh` rather than re-derived: which of the minimum
        # rectangle's two edges is the long one, and which way its axes point, is
        # exactly the arithmetic a second copy would eventually disagree with.
        frame = mesh._oriented_rect(mesh._ring_open(b.ring))
        if frame is None:
            out.append(b)
            continue
        half_long, half_short = frame[3], frame[4]
        kind = row_kind(b, poly, 2.0 * half_long, 2.0 * half_short)
        if kind is None:
            out.append(b)
            continue

        slices = split_row(b, frame, report)
        if slices is None:
            out.append(b)
            continue

        if kind == "tagged":
            report.rows_tagged += 1
        else:
            report.rows_geometry += 1
        report.slices += len(slices)
        report.lengths.append(2.0 * half_long)
        report.frontages.extend(_frontage_of(s, frame) for s in slices)
        out.extend(slices)
    return out, report
