"""Height resolution and archetype classification (spec sections 6.2, 6.3).

Two jobs, in order:

  1. Decide a height for every building, from the best source available, and
     record *which* source it came from so a later LiDAR pass can overwrite only
     the guesses and leave measured values alone.
  2. Classify every building into one of the ten archetypes, which is what
     selects its facade grammar, floor height, bay width -- and the *distribution*
     its wall material is drawn from. Not the material itself: one material per
     archetype is what made every terrace in the city the same red brick, and
     MATERIAL_MIX below is the fix.

The classifier is deliberately signal-based rather than tag-based. Only 25% of
Sydney's OSM buildings state their storey count and 1.4% state a material, so a
tag-driven classifier would leave three quarters of the city unclassified. What
is always available is geometry: footprint area, how rectangular it is, how
elongated, how close its neighbours are, and how far from the CBD it sits. Those
five signals separate a terrace from a warehouse from a tower reliably.
"""

from __future__ import annotations

import math
import zlib
from dataclasses import dataclass, field

import numpy as np
from scipy.spatial import cKDTree
from shapely.geometry import Polygon

from .merge import Building

# --- Archetypes ---------------------------------------------------------------


@dataclass(frozen=True)
class Archetype:
    """Everything the facade grammar needs to know about a building class."""

    name: str
    floor_height: float  # typical upper-storey floor-to-floor, metres
    ground_floor_height: float  # ground storey, taller in commercial classes
    bay_width: float  # facade bay module, metres (spec section 6.3)
    window_width_ratio: float  # fraction of the bay that is glazed
    sill_height: float  # metres above its floor
    head_height: float  # metres above its floor
    reveal_depth: float  # metres the window sits back from the wall plane
    # The archetype's signature material, and *only* a fallback now: what a
    # building is actually made of is drawn per building from MATERIAL_MIX below.
    # This field survives because it names the class in one word, and because a
    # new archetype added without a mix entry has to land somewhere sensible.
    material: str
    roof_form: str
    max_levels: int


ARCHETYPES: dict[str, Archetype] = {
    # 1-2 storeys, narrow deep footprint, row-adjacent, inner suburb.
    "terrace": Archetype(
        "terrace", 3.2, 3.4, 2.4, 0.42, 0.9, 2.9, 0.22, "brick_red", "parapet", 3
    ),
    # Detached red-brick era house, gable/hip roof, verandah.
    "federation": Archetype(
        "federation", 3.1, 3.2, 3.0, 0.38, 1.0, 2.6, 0.18, "brick_red", "hip", 2
    ),
    # 3-4 storeys, rectangular, cream/brown brick, flat parapet.
    "interwar_apartment": Archetype(
        "interwar_apartment", 3.0, 3.4, 3.2, 0.40, 1.0, 2.5, 0.20, "brick_cream", "parapet", 5
    ),
    # 3-5 storeys, cream brick, horizontal balcony bands, aluminium sliders.
    "walkup": Archetype(
        "walkup", 2.8, 3.0, 3.6, 0.55, 0.9, 2.4, 0.14, "brick_cream", "flat", 6
    ),
    # 6-20 storeys concrete, deep reveals, precast grid, vertical fins.
    "brutalist": Archetype(
        "brutalist", 3.5, 4.5, 2.7, 0.55, 0.8, 2.9, 0.35, "concrete_precast", "flat", 25
    ),
    # 20+ storeys glass, curtain wall, spandrel bands, no reveal.
    "tower": Archetype(
        "tower", 3.6, 5.5, 1.5, 0.94, 0.0, 3.2, 0.03, "curtain_wall", "flat", 100
    ),
    # Large footprint, low, irregular. Corrugated cladding, sawtooth roof.
    "warehouse": Archetype(
        "warehouse", 6.0, 6.0, 6.0, 0.30, 3.4, 5.2, 0.10, "corrugated_steel", "sawtooth", 3
    ),
    # Detached, 1 storey, outer suburb. Tile roof, garage, aluminium windows.
    "brick_veneer": Archetype(
        "brick_veneer", 2.7, 2.7, 3.4, 0.44, 1.0, 2.3, 0.12, "brick_brown", "hip", 2
    ),
    # Ground floor on a retail street: full-width glazing, awning, signage band.
    "retail_strip": Archetype(
        "retail_strip", 3.2, 4.2, 3.0, 0.80, 0.6, 3.0, 0.16, "render_painted", "parapet", 4
    ),
    # 4-8 storeys, post-2000, mixed render/glass, projecting balconies.
    "modern_infill": Archetype(
        "modern_infill", 3.1, 4.0, 3.4, 0.70, 0.5, 2.7, 0.10, "render_painted", "flat", 12
    ),
}

# Anything OSM explicitly says about the building type is worth more than an
# inference from geometry, so these short-circuit the classifier.
TYPE_HINTS: dict[str, str] = {
    "terrace": "terrace",
    "house": "brick_veneer",
    "detached": "brick_veneer",
    "semidetached_house": "terrace",
    "bungalow": "federation",
    "apartments": "walkup",
    "residential": "walkup",
    "dormitory": "walkup",
    "warehouse": "warehouse",
    "industrial": "warehouse",
    "factory": "warehouse",
    "shed": "warehouse",
    "hangar": "warehouse",
    "retail": "retail_strip",
    "supermarket": "retail_strip",
    "commercial": "brutalist",
    "office": "brutalist",
    "hotel": "modern_infill",
    "church": "federation",
    "school": "interwar_apartment",
    "hospital": "brutalist",
    "garage": "brick_veneer",
    "garages": "brick_veneer",
    "carport": "brick_veneer",
    "roof": "warehouse",
    "civic": "brutalist",
    "public": "brutalist",
    "university": "brutalist",
    "train_station": "brutalist",
}

# OSM `building:material` -> our trim-sheet material names (spec section 7.3).
MATERIAL_MAP = {
    "brick": "brick_red",
    "red_brick": "brick_red",
    "brick_veneer": "brick_brown",
    "concrete": "concrete_precast",
    "reinforced_concrete": "concrete_precast",
    "cement_block": "concrete_precast",
    "sandstone": "sandstone",
    "stone": "sandstone",
    "limestone": "sandstone",
    "glass": "curtain_wall",
    "metal": "corrugated_steel",
    "metal_sheet": "corrugated_steel",
    "steel": "corrugated_steel",
    "corrugated_iron": "corrugated_steel",
    "plaster": "render_painted",
    "render": "render_painted",
    "stucco": "render_painted",
    "timber": "fibro",
    "wood": "fibro",
    "fibre_cement": "fibro",
    "tile": "brick_red",
}

# What each archetype is actually made of, as a weighted draw per building.
#
# WHY THIS IS A DISTRIBUTION AND NOT A CONSTANT. Until this table existed every
# building of an archetype got `ARCHETYPES[...].material`, so 6,973 of the 6,982
# terraces in the inner ring were the same dark red brick and 2,933 of the 3,085
# walk-ups were the same cream. Only 1.4% of Sydney's OSM buildings state a
# material, so that one mapping decided the colour of the entire city and whole
# streets rendered as a single flat tone. A real Newtown or Alexandria street is
# nothing like that: the terrace row is original face brick, then render painted
# cream in about 1975, then face brick, then render painted sage last year, then
# a brown-brick infill. The variety is *per building* because each house was
# painted by a different owner in a different decade -- it is not per street, not
# per block, and not per suburb, and any of those would read as zoning.
#
# The shares are Sydney inner-ring stock rather than a national mix, and the one
# that carries the most weight is `terrace`: 35% painted render is the inner-west
# signature and spec 7.3's "painted render in inner-west pastels" is largely about
# those buildings. `fibro` and `sandstone` are small on purpose -- a fibro-clad
# terrace is a rear addition brought round the front and a sandstone one is a
# genuine 1840s survivor, and both exist in numbers you could count on a street.
#
# `brutalist` and `tower` are deliberately single-entry: concrete and curtain wall
# dominance is what those classes *are*, and they are written as one-element mixes
# rather than left out so that the draw has one code path and so that adding
# variation later is an edit here rather than a new branch.
#
# Weights are normalised at draw time, so they do not have to sum to 1 -- but they
# all do, because a column that does not sum to 100 is a typo more often than it
# is a decision.
MATERIAL_MIX: dict[str, tuple[tuple[str, float], ...]] = {
    "terrace": (
        ("brick_red", 0.40),
        ("render_painted", 0.35),
        ("brick_cream", 0.10),
        ("fibro", 0.08),
        ("sandstone", 0.07),
    ),
    "federation": (
        ("brick_red", 0.55),
        ("render_painted", 0.20),
        ("brick_brown", 0.15),
        ("fibro", 0.10),
    ),
    "interwar_apartment": (
        ("brick_cream", 0.55),
        ("brick_brown", 0.25),
        ("brick_red", 0.15),
        ("render_painted", 0.05),
    ),
    "walkup": (
        ("brick_cream", 0.50),
        ("brick_brown", 0.20),
        ("render_painted", 0.15),
        ("brick_red", 0.15),
    ),
    "warehouse": (
        ("brick_red", 0.45),
        ("corrugated_steel", 0.25),
        ("concrete_precast", 0.20),
        ("render_painted", 0.10),
    ),
    "retail_strip": (
        ("render_painted", 0.50),
        ("brick_red", 0.30),
        ("brick_cream", 0.10),
        ("sandstone", 0.10),
    ),
    "brick_veneer": (
        ("brick_brown", 0.50),
        ("brick_red", 0.25),
        ("brick_cream", 0.15),
        ("fibro", 0.10),
    ),
    "modern_infill": (
        ("render_painted", 0.50),
        ("concrete_precast", 0.30),
        ("curtain_wall", 0.20),
    ),
    "brutalist": (("concrete_precast", 1.0),),
    "tower": (("curtain_wall", 1.0),),
}

# --- Matching pairs ----------------------------------------------------------
#
# A street of independent draws is not what a street looks like either. Terraces
# were built in pairs and short rows by one builder in one year, and a pair that
# has never been repainted separately still shares a wall colour -- so a real row
# has a rhythm of singles with the occasional matching two or three in it.
#
# One in seven buildings copying its nearest same-archetype neighbour produces
# that rhythm without producing zoning: the expected run length stays just over
# one, so pairs are common, triples are rare and a whole street syncing is
# impossible by construction (see `_copy_neighbour_runs` on why copies never
# chain).
RUN_PROBABILITY = 0.15

# How far a "neighbour" can be and still be the same builder's work. Terrace
# centroids sit 5-7 m apart, a pair of Federation houses 12-18 m; past 30 m the
# nearest same-archetype building is across a street or a park and sharing a
# colour with it would read as an accident rather than as a pair.
RUN_RADIUS = 30.0

# How many nearest neighbours to look through for one of the same archetype.
# Eight covers a terrace surrounded by shops and reaches the 30 m cap in all but
# pathologically dense CBD blocks, where the copy is simply skipped.
NEIGHBOUR_K = 8

# Independent streams off one building seed, so no two decisions taken from the
# same id can correlate. Arbitrary odd constants; only distinctness matters, and
# keeping every stream in one list is what makes that checkable at a glance.
#
# The two row streams matter more than the others, because a row's slices differ
# from each other *only* in their id index. If the frontage jitter and the
# parapet jitter shared a stream, every house cut wider than its neighbours would
# also be the taller one, and the row would read as a single ramp rather than as
# twenty separately-built houses.
_STREAM_MATERIAL = 0x5F1D
_STREAM_RUN = 0xB7E1
_STREAM_FRONTAGE = 0x2C9D  # where `rows.py` puts the cut between two houses
_STREAM_PARAPET = 0xD3A7  # how far one house's roofline steps off its neighbour's

ROOF_SHAPE_MAP = {
    "flat": "flat",
    "skillion": "skillion",
    "gabled": "gable",
    "gambrel": "gable",
    "half-hipped": "hip",
    "hipped": "hip",
    "pyramidal": "hip",
    "sawtooth": "sawtooth",
    "dome": "dome",
    "round": "dome",
    "onion": "dome",
}


# --- Footprint geometry metrics ----------------------------------------------


@dataclass
class Metrics:
    """Cheap shape descriptors that carry most of the classification signal."""

    width: float  # short side of the minimum-area rectangle
    depth: float  # long side
    elongation: float  # depth / width, >= 1
    rectangularity: float  # footprint area / its min-area rectangle area, <= 1
    radius_from_cbd: float
    neighbour_gap: float  # metres to the nearest other footprint, inf if alone
    neighbours_50m: int


@dataclass(frozen=True)
class Neighbourhood:
    """Each building's nearest few neighbours, straight off the same cKDTree.

    Threaded out of `compute_metrics` rather than rebuilt because the tree over
    every centroid in the extent is the single most expensive thing in this
    module, and the material pass needs exactly what the classifier already
    asked it for -- who is next door, and how far away.

    Column 0 of both arrays is the building itself, at distance zero. Missing
    neighbours (fewer buildings than `NEIGHBOUR_K`) come back from SciPy as an
    index of `len(buildings)` at infinite distance, so callers must range-check.
    """

    index: np.ndarray  # (N, K) int, indices into the building list
    distance: np.ndarray  # (N, K) float, centroid to centroid in metres


def _min_area_rect(poly: Polygon) -> tuple[float, float]:
    """(short side, long side) of the minimum-area enclosing rectangle."""
    rect = poly.minimum_rotated_rectangle
    if rect.geom_type != "Polygon":
        return 0.0, 0.0
    pts = np.asarray(rect.exterior.coords)[:4]
    e0 = float(np.hypot(*(pts[1] - pts[0])))
    e1 = float(np.hypot(*(pts[2] - pts[1])))
    return (min(e0, e1), max(e0, e1))


def compute_metrics(buildings: list[Building]) -> tuple[list[Metrics], Neighbourhood]:
    """Shape and neighbourhood metrics for every building, vectorised where possible.

    Returns the neighbour lists alongside, because the material pass needs them
    and this is where the tree that answers them already exists.
    """
    cents = np.array([b.centroid for b in buildings], dtype=np.float64)
    radii = np.hypot(cents[:, 0], cents[:, 1])

    tree = cKDTree(cents)
    neighbours_50m = np.array([len(tree.query_ball_point(c, 50.0)) - 1 for c in cents])

    # Approximate the gap between footprints as centre distance minus each
    # polygon's equivalent radius. Exact polygon-to-polygon distance for 280k
    # buildings is not worth the minutes it costs; row-adjacency only needs to be
    # distinguished from detached, and this does that.
    #
    # `k` runs out to NEIGHBOUR_K rather than 2 so the material pass can find a
    # neighbour of the *same archetype* rather than merely the closest one; the
    # classifier still uses only column 1, and the extra columns cost one traversal
    # of a tree that is being walked anyway.
    # Floored at 2 so the result is always the 2-D shape the column indexing
    # below assumes -- SciPy returns 1-D arrays for k=1, and a single-building
    # extent is a real case at the very edge of a stage.
    k = max(2, min(NEIGHBOUR_K, len(cents)))
    dists, idx = tree.query(cents, k=k, workers=-1)
    nearest = dists[:, 1]
    eq_radius = np.sqrt(np.array([b.area for b in buildings]) / math.pi)

    out: list[Metrics] = []
    for i, b in enumerate(buildings):
        poly = Polygon(b.ring)
        if not poly.is_valid:
            poly = poly.buffer(0)
        w, d = _min_area_rect(poly) if not poly.is_empty else (0.0, 0.0)
        rect_area = w * d
        gap = float(nearest[i] - eq_radius[i] - eq_radius[idx[i, 1]])
        out.append(
            Metrics(
                width=w,
                depth=d,
                elongation=(d / w) if w > 0.5 else 1.0,
                rectangularity=(b.area / rect_area) if rect_area > 1.0 else 0.0,
                radius_from_cbd=float(radii[i]),
                neighbour_gap=max(gap, -5.0),
                neighbours_50m=int(neighbours_50m[i]),
            )
        )
    return out, Neighbourhood(index=idx, distance=dists)


# --- Retail frontage ----------------------------------------------------------

RETAIL_SEARCH_RADIUS = 28.0  # metres from a building centroid to a shop/cafe node


def mark_retail(buildings: list[Building], retail_points: np.ndarray) -> int:
    """Flag buildings whose ground floor should get the shopfront treatment.

    The spec calls this the single highest-value rule in the grammar -- it is
    what makes King Street and Redfern Street read correctly. Driven by actual
    mapped retail presence rather than road classification, because Sydney's
    retail strips sit on residentially-classed streets as often as not.
    """
    if len(retail_points) == 0:
        return 0
    tree = cKDTree(retail_points)
    n = 0
    for b in buildings:
        # A shop mapped as a node inside the building, or one very close by on
        # the same strip, both indicate a retail ground floor.
        if b.shop or b.amenity in ("cafe", "restaurant", "fast_food", "pub", "bar", "bank"):
            b.retail = True
            n += 1
            continue
        if tree.query_ball_point(b.centroid, RETAIL_SEARCH_RADIUS, return_length=True):
            b.retail = True
            n += 1
    return n


# --- Height -------------------------------------------------------------------

# Era-typical floor-to-floor used when converting a storey count to a height.
# Deliberately not a single constant: 55 levels of curtain wall at 3.2 m would
# make Salesforce Tower 60 m too short.
def _floor_height_for(archetype: str) -> float:
    return ARCHETYPES[archetype].floor_height


def resolve_height(b: Building, m: Metrics, archetype: str) -> tuple[float, str]:
    """Best available height, and the name of the source it came from.

    Priority, highest first:
      lidar_p99  -- measured (filled by the LiDAR pass, not here)
      osm_height -- a surveyed `height` tag
      osm_levels -- storey count times era floor height, plus a parapet
      ms_ml      -- Microsoft's ML height, but only where it is plausible
      inferred   -- area, context and distance from the CBD
    """
    arch = ARCHETYPES[archetype]

    if b.stated_height:
        return b.stated_height, "osm_height"

    if b.levels:
        fh = _floor_height_for(archetype)
        gh = arch.ground_floor_height
        h = gh + max(b.levels - 1, 0) * fh
        # Parapet or roof edge sits above the top slab on flat-roofed classes.
        if arch.roof_form in ("flat", "parapet"):
            h += 0.9
        return h, "osm_levels"

    # Microsoft's ML heights top out around 31 m across the whole of Sydney and
    # sit at a 4.5 m median, so they are eave heights for low-rise and simply
    # absent for anything tall. Trusted only in the range where that is a
    # sensible reading, and only for classes that live in that range.
    if b.ms_height and 2.0 <= b.ms_height <= 24.0 and arch.max_levels <= 6:
        return max(b.ms_height, arch.ground_floor_height), "ms_ml"

    # Nothing stated. Infer a storey count from the archetype's typical form,
    # nudged by footprint size and how central the building is.
    levels = _inferred_levels(m, archetype)
    h = arch.ground_floor_height + max(levels - 1, 0) * arch.floor_height
    if arch.roof_form in ("flat", "parapet"):
        h += 0.9
    return h, "inferred"


def _inferred_levels(m: Metrics, archetype: str) -> int:
    """Storey count guess for a building with no stated levels or height."""
    base = {
        "terrace": 2,
        "federation": 1,
        "interwar_apartment": 3,
        "walkup": 3,
        "brutalist": 8,
        "tower": 24,
        "warehouse": 1,
        "brick_veneer": 1,
        "retail_strip": 2,
        "modern_infill": 5,
        }[archetype]

    # Central buildings are taller for the same footprint. Ramp is gentle and
    # capped so it never invents a tower in Marrickville.
    if m.radius_from_cbd < 1_200:
        base += 2
    elif m.radius_from_cbd < 3_000:
        base += 1

    # A big footprint in a dense block usually means more storeys, not just more
    # ground area -- but not for warehouses, where big and low is the whole point.
    if archetype not in ("warehouse", "brick_veneer") and m.width > 18 and m.neighbours_50m > 6:
        base += 1

    return max(1, min(base, ARCHETYPES[archetype].max_levels))


# --- Parapet step -------------------------------------------------------------

# How far one house in a row may sit above or below the even height, metres.
#
# THIS IS THE SIGNATURE OF A TERRACE ROW and it is the reason `rows.py` exists at
# all. Cutting a row into houses gets the material and the window rhythm varying
# house to house, but every slice still resolves to the same height -- same
# archetype, same inferred storey count, same arithmetic -- so the parapet comes
# out as one ruler-straight line the length of the block, which is exactly the
# mega-facade read the split was meant to kill. A real row steps: the ground
# falls away, each builder finished at a slightly different course, and a century
# of separate re-roofing did the rest.
#
# +/- 0.35 m against a ~10.7 m terrace is a 7% band. Enough that the step is
# unmistakable in silhouette against the sky, small enough that no house looks
# like it belongs to a different row.
PARAPET_JITTER = 0.35

# Only classes that have a parapet or a shallow street-facing roofline. A hip or
# gable roof already varies in silhouette, and stepping a warehouse would just
# read as bad data.
PARAPET_JITTER_ARCHETYPES = frozenset({"terrace", "federation"})


def parapet_jitter(b: Building) -> float:
    """Metres to add to one row-slice's height. Zero for everything else.

    SURVEYED DATA WINS. A slice whose parent carried an OSM `height` tag is left
    exactly where the tag puts it: someone measured that row, and inventing a
    35 cm step on top of a measurement would make the one building in the street
    with real data the one building that is wrong. Every other height in the row
    is an inference from the archetype, and an inference has no business being
    identical across twenty houses.
    """
    if not b.row_slice or b.archetype not in PARAPET_JITTER_ARCHETYPES:
        return 0.0
    if b.height_source == "osm_height":
        return 0.0
    return (2.0 * _uniform(_stable_seed(b.id), _STREAM_PARAPET) - 1.0) * PARAPET_JITTER


# --- Classification -----------------------------------------------------------

INNER_SUBURB_RADIUS = 7_000.0  # terraces and Federation stock live inside this
CBD_RADIUS = 1_400.0


def classify(b: Building, m: Metrics) -> str:
    """Assign one of the ten archetypes (spec section 6.2).

    Ordered as a decision list, strongest signal first. Height and storey count
    are checked before shape, because a stated 55 levels settles the question no
    matter what the footprint looks like.
    """
    levels = b.levels
    stated_h = b.stated_height
    # Effective height if anything is stated, for the tall-building tests.
    h = stated_h or (levels * 3.3 if levels else None)

    # --- Unambiguous height classes
    if h is not None and h >= 66:  # ~20 storeys
        return "tower"
    if h is not None and h >= 21:  # ~6 storeys
        # Post-2000 stock reads as modern infill rather than 60s-70s concrete.
        return "modern_infill" if _is_modern(b) else "brutalist"

    # --- Residential mid-rise is an era signal in its own right.
    # Sydney's interwar flats and post-war walk-ups top out at four or five
    # storeys because neither had lifts. A residential building of five storeys
    # or more is post-1990 stock almost without exception, so storey count
    # substitutes for the `start_date` tag that 99.9% of buildings lack.
    if levels and levels >= 5 and b.building_type in (
        "apartments", "residential", "house", "detached", "terrace", None
    ):
        return "modern_infill"

    # --- Explicit type tag
    if b.building_type and (hint := TYPE_HINTS.get(b.building_type)):
        # A retail-tagged ground floor overrides the residential reading, but a
        # warehouse with a shop in it is still a warehouse.
        if b.retail and hint in ("terrace", "brick_veneer", "walkup", "federation"):
            return "retail_strip"
        return hint

    # --- Warehouse / industrial: large, low, irregular
    if b.area > 900 and (m.rectangularity < 0.82 or m.width > 24) and (h is None or h < 18):
        return "warehouse"
    if b.area > 2_500:
        return "warehouse"

    # --- Retail strip: shopfront presence and a street wall
    if b.retail and m.neighbour_gap < 4.0 and b.area < 900:
        return "retail_strip"

    # --- Terrace: narrow, deep, row-adjacent, inner suburb
    if (
        m.radius_from_cbd < INNER_SUBURB_RADIUS
        and m.width < 8.5
        and m.elongation > 1.8
        and m.neighbour_gap < 3.0
        and b.area < 320
    ):
        return "terrace"

    # --- Apartment blocks: rectangular, mid-size, several storeys implied
    if b.area > 380 and m.rectangularity > 0.78:
        if m.radius_from_cbd < INNER_SUBURB_RADIUS:
            return "interwar_apartment" if not _is_modern(b) else "modern_infill"
        return "walkup"

    # --- Detached houses. Federation stock inside the inner ring, brick veneer
    #     in the outer suburbs -- the single most reliable era proxy available.
    if m.radius_from_cbd < INNER_SUBURB_RADIUS:
        return "federation" if b.area > 110 else "terrace"
    return "brick_veneer"


def _is_modern(b: Building) -> bool:
    """Post-2000 construction, from `start_date` where present.

    Falls back to material: a stated glass or render facade on a mid-rise is a
    contemporary building far more often than not.
    """
    if b.start_date:
        digits = "".join(c for c in b.start_date[:4] if c.isdigit())
        if len(digits) == 4:
            return int(digits) >= 2000
    if b.heritage:
        return False
    return b.material in ("glass", "render", "plaster", "stucco")


def roof_form_for(b: Building, archetype: str) -> str:
    """Roof form: OSM's `roof:shape` where stated, else the archetype default.

    The LiDAR RANSAC pass overwrites this wherever it gets a confident plane fit.
    """
    if b.roof_shape and (mapped := ROOF_SHAPE_MAP.get(b.roof_shape)):
        return mapped
    return ARCHETYPES[archetype].roof_form


# --- Material --------------------------------------------------------------


def _stable_seed(building_id: str) -> int:
    """A 32-bit seed for one building, identical on every rebuild.

    Same philosophy as the facade seed in `mesh.facade_params`: derived from the
    building id and nothing else, so it survives a re-download of the sources.
    `merge.py` namespaces the id per source and `msbuildings._stable_id` quantises
    the Microsoft ones to 10 cm precisely so that this kind of thing holds still.

    Deliberately a *different function* of that id, though. `facade_params` takes
    `int(id[-8:], 16)` and hands it to the shader, where it drives the
    per-building value tint; a material draw reading the same number would be
    correlated with it, and every brick building in the city would draw its tint
    from the same corner of the seed range. CRC-32 over the whole id costs
    nothing, is unsalted -- unlike `hash()`, which is randomised per process and
    would repaint the city on every run -- and decorrelates the two.
    """
    return zlib.crc32(building_id.encode("utf-8"))


def _uniform(seed: int, stream: int) -> float:
    """A stable uniform in [0, 1) for one building and one decision.

    The splitmix32 finaliser: it is what turns a CRC -- which is linear, and whose
    low bits over sequential OSM way ids are anything but independent -- into
    something a threshold comparison can be trusted against. `stream` separates
    decisions, so widening the material table cannot shift which buildings copy a
    neighbour and vice versa.
    """
    x = (seed ^ (stream * 0x9E3779B1)) & 0xFFFFFFFF
    x ^= x >> 16
    x = (x * 0x7FEB352D) & 0xFFFFFFFF
    x ^= x >> 15
    x = (x * 0x846CA68B) & 0xFFFFFFFF
    x ^= x >> 16
    return x / 4_294_967_296.0


def stated_material(b: Building) -> str | None:
    """What OSM says the building is made of, or None if it says nothing.

    Separate from the draw because "stated wins absolutely" is a rule with two
    halves: a stated material is used, *and* it is immune to the neighbour-run
    copy below. A surveyed sandstone church does not get repainted because the
    hall next door was.
    """
    if b.material and (mapped := MATERIAL_MAP.get(b.material)):
        return mapped
    return None


def draw_material(building_id: str, archetype: str) -> str:
    """Draw this building's material from its archetype's distribution.

    Deterministic in the id, so the same building is the same colour on every
    build. Weights are normalised here rather than assumed, so MATERIAL_MIX can be
    edited without anyone having to do arithmetic to keep it valid.
    """
    mix = MATERIAL_MIX.get(archetype)
    if not mix:
        return ARCHETYPES[archetype].material
    u = _uniform(_stable_seed(building_id), _STREAM_MATERIAL) * sum(w for _, w in mix)
    acc = 0.0
    for name, weight in mix:
        acc += weight
        if u < acc:
            return name
    return mix[-1][0]  # only reachable on floating-point slop at the top end


def material_for(b: Building, archetype: str) -> str:
    """The single-building answer: OSM if it stated one, otherwise the draw."""
    return stated_material(b) or draw_material(b.id, archetype)


def _copy_neighbour_runs(
    buildings: list[Building], neighbours: Neighbourhood, fixed: list[bool]
) -> int:
    """Give one building in seven its nearest same-archetype neighbour's material.

    This is what turns a field of independent draws into a street. Independent
    draws produce an even stipple -- every house different from both its
    neighbours, which is as artificial as every house being the same and is the
    same mistake `parking.py` documents about occupancy rolls. Real rows come in
    matching pairs and the occasional matching three, because they were built and
    painted together.

    THE COPIES READ FROM A SNAPSHOT, and that is the whole design. If B copied A
    and C then copied B's *new* material, the copies would chain and a run would
    grow to whatever length the 0.15 roll happened to give it -- which at a
    hundred buildings a street means whole streets syncing to one colour, the
    exact failure this is shaped to avoid. Reading the pre-copy draw caps every
    run at two by construction, except where a third building independently drew
    the same material, which is the frequency a third matching house should have
    anyway.

    Buildings with an OSM-stated material neither copy nor are skipped as a
    source: stated wins for them, and a stated neighbour is still a real
    neighbour to match.

    One case is knowingly left alone. Two buildings that are each other's nearest
    same-archetype neighbour and that both roll a copy simply swap materials --
    about 2% of buildings -- which produces no pair. It is harmless: both sides
    still hold a valid draw from the same distribution, so the histogram does not
    move and only that one pairing is lost.
    """
    n = len(buildings)
    drawn = [b.material for b in buildings]
    copied = 0
    for i, b in enumerate(buildings):
        if fixed[i]:
            continue
        if _uniform(_stable_seed(b.id), _STREAM_RUN) >= RUN_PROBABILITY:
            continue
        for col in range(1, neighbours.index.shape[1]):
            j = int(neighbours.index[i, col])
            # SciPy pads short neighbour lists with `n` at infinite distance, and
            # the radius cap is monotonic in the column, so a miss ends the scan.
            if j >= n:
                break
            if neighbours.distance[i, col] > RUN_RADIUS:
                break
            if buildings[j].archetype != b.archetype:
                continue
            if drawn[j] != drawn[i]:
                b.material = drawn[j]
                copied += 1
            break
    return copied


@dataclass
class AttributeReport:
    """What the attribute pass did, for the build log.

    Materials are reported as well as archetypes because they are now a *draw*
    rather than a mapping, and a distribution that has silently collapsed -- a
    mis-normalised weight, a typo'd slot name falling through to the fallback --
    looks exactly like a correct one from the outside. The histogram is the only
    thing that says otherwise, so it is printed on every build.
    """

    archetypes: dict[str, int]
    materials: dict[str, int]
    by_archetype: dict[str, dict[str, int]]
    osm_stated: int
    neighbour_runs: int
    # Row slices only, and reported separately because the whole point of
    # `rows.py` is what the classifier does with them: a slice that comes out as
    # anything but terrace means the split produced a footprint the classifier
    # does not recognise, and the row will render as twenty narrow walk-ups.
    slices: int = 0
    slice_archetypes: dict[str, int] = field(default_factory=dict)
    parapets_stepped: int = 0


def apply(buildings: list[Building], retail_points: np.ndarray) -> AttributeReport:
    """Run the whole attribute pass in place."""
    mark_retail(buildings, retail_points)
    metrics, neighbours = compute_metrics(buildings)

    counts: dict[str, int] = {}
    slice_counts: dict[str, int] = {}
    stepped = 0
    fixed: list[bool] = []
    for b, m in zip(buildings, metrics):
        arch = classify(b, m)
        b.archetype = arch
        b.height, b.height_source = resolve_height(b, m, arch)
        # After the height is resolved, because the jitter is a modifier on it
        # and needs `height_source` to know whether a surveyor got there first.
        if step := parapet_jitter(b):
            b.height = max(b.height + step, 2.4)
            stepped += 1
        b.roof_form = roof_form_for(b, arch)
        # Read before the assignment overwrites it: `b.material` arrives holding
        # OSM's raw string and leaves holding one of `mesh.MATERIALS`.
        osm_said = stated_material(b)
        fixed.append(osm_said is not None)
        b.material = osm_said or draw_material(b.id, arch)
        if b.levels is None:
            a = ARCHETYPES[arch]
            b.levels = max(1, round((b.height - a.ground_floor_height) / a.floor_height) + 1)
        counts[arch] = counts.get(arch, 0) + 1
        if b.row_slice:
            slice_counts[arch] = slice_counts.get(arch, 0) + 1

    runs = _copy_neighbour_runs(buildings, neighbours, fixed)

    materials: dict[str, int] = {}
    by_archetype: dict[str, dict[str, int]] = {}
    for b in buildings:
        materials[b.material] = materials.get(b.material, 0) + 1
        by_archetype.setdefault(b.archetype, {})
        by_archetype[b.archetype][b.material] = by_archetype[b.archetype].get(b.material, 0) + 1

    return AttributeReport(
        archetypes=counts,
        materials=materials,
        by_archetype=by_archetype,
        osm_stated=sum(fixed),
        neighbour_runs=runs,
        slices=sum(1 for b in buildings if b.row_slice),
        slice_archetypes=slice_counts,
        parapets_stepped=stepped,
    )
