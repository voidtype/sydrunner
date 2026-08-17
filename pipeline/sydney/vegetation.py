"""Vegetation: park ground surfaces and tree instances, per tile.

Spec section 7.5 is unusually blunt about what matters here: *species* matter more
than quality, and **no oaks, no maples, no conifers -- they read American
instantly**. So this module's job is not to grow good trees. It is to put the
right six silhouettes in the right places, in the right numbers, and to leave the
February colour to the client.

Two outputs, from three sources.

**The park surface** is a new material slot, `park_grass`, emitted the way
`streets.py` emits its three: polygons unioned per tile, clipped to the tile last,
cut against the terrain facets, world-metre UVs, no `_BLDIDX`. It sits one
centimetre over the ground -- one under the carriageway, and the carriageway is
cut out of it anyway, so the ordering is belt and braces. It is what stops a park rendering as the same
bare dirt as a car park, which is what every green space in the city did before
this existed.

**Tree instances** come from three sources, in this priority order, because they
are three different qualities of truth:

  a. Mapped `natural=tree` nodes. Sydney's inner suburbs carry ~12,000 of them
     and they are surveyed positions, so they are never moved, never thinned and
     never overridden. Where OSM knows the genus -- a few dozen specimens in the
     Botanic Gardens and the Domain -- it picks the species too.
  b. Procedural street trees, **only where the mapping is sparse**. That
     qualifier is the whole design of this source: a street that has already been
     surveyed does not get a second, invented row of trees threaded between the
     real ones. `_way_is_mapped` is what decides, and without it the leafy
     already-mapped suburbs come out at twice the real density while the
     unmapped ones stay bare -- exactly backwards.
  c. Park interiors, scattered. A Sydney park is mostly open grass with big
     specimen trees standing in it, not a forest, so the density is low and the
     count a park is given has its already-mapped trees subtracted from it. Hyde
     Park is mapped tree by tree; it must not also receive 400 invented ones.

**Determinism across a tile boundary** is the constraint that shapes the rest.
Every position is generated from its *source object* -- one way, one park polygon,
one node -- and then assigned to whichever tile contains it, never generated from
the tile. Two tiles asking about the same street get the same list and each keeps
its own half, so no tree is emitted twice and none falls down the crack. This is
the same guarantee `streets.py` gets by building from a margin and clipping last,
arrived at from the other direction: there is nothing to clip because a point is
either inside the tile or it is not.

The hash below is what makes that true. Every jitter, dropout, species pick and
size draw is a pure function of stable integers -- an OSM id, a side, a distance
along the way in centimetres -- so nothing depends on iteration order, on the
tile, or on the run.
"""

from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import config, mesh, streets
from .sources import osm

# --- Species ------------------------------------------------------------------
# The u8 written into the sidecar. APPEND ONLY, for the same reason the material
# list is: the client keys its geometry table off these integers.

FIG = 0  # Moreton Bay fig -- massive, buttressed. Parks, and the odd street giant
PLANE = 1  # London plane -- the CBD street tree
JACARANDA = 2  # not flowering in February. Plain green, and the client keeps it so
PAPERBARK = 3  # melaleuca -- narrow, upright, near-white trunk
BRUSH_BOX = 4  # lophostemon -- the default inner-suburb street tree
EUCALYPT = 5  # open, irregular, sparse enough to see the trunk through

SPECIES_COUNT = 6

# (height min, height max, canopy *spread* min, spread max), metres.
#
# Spread, not radius: arborists quote a canopy by its diameter and a Moreton Bay
# fig's is genuinely wider than the tree is tall. The sidecar carries the radius,
# so these are halved on the way out -- stated here rather than in the numbers so
# they can be checked against a nursery catalogue as written.
SPECIES_SIZE: dict[int, tuple[float, float, float, float]] = {
    FIG: (15.0, 22.0, 18.0, 28.0),
    PLANE: (10.0, 14.0, 8.0, 12.0),
    JACARANDA: (8.0, 12.0, 8.0, 12.0),
    PAPERBARK: (8.0, 14.0, 4.0, 6.5),
    BRUSH_BOX: (10.0, 15.0, 6.5, 9.5),
    EUCALYPT: (12.0, 20.0, 8.0, 14.0),
}

SPECIES_NAME = {
    FIG: "moreton_bay_fig",
    PLANE: "plane",
    JACARANDA: "jacaranda",
    PAPERBARK: "paperbark",
    BRUSH_BOX: "brush_box",
    EUCALYPT: "eucalypt",
}

# --- What a size in the sidecar actually does ---------------------------------
#
# The client does not model a tree at the size it is given. It builds *one*
# geometry per species at a nominal size and scales each instance
# `(radius / nominalRadius, height / nominalHeight, radius / nominalRadius)` --
# a **non-uniform** scale, applied to a silhouette that was authored by hand.
# `world/vegetation.ts` states the assumption that makes that safe:
#
#     "The draw in the pipeline correlates height with spread, so the two scale
#      factors stay within about 20% of each other and the distortion never
#      reads as a distortion."
#
# `_size` below honours that: height and spread come off one normalised draw, so
# the two factors move together. An OSM-tagged size was the one path that did
# not, and it produced the worst artefact vegetation has shipped. A
# `diameter_crown=33 m` node with no taxon was assigned **paperbark** by
# context -- nominal radius 2.6 m -- and then handed a radius of 16.5, so the
# client scaled a paperbark 6.35x across and 0.82x up: three flat green discs
# fifteen metres wide floating over a two-metre stub of trunk. Two of those in a
# frame is a photograph of "giant floating polyhedra", and nothing in the build
# said a word about it.
#
# So a measurement is no longer applied *to* a species. It is used to place the
# instance on that species' own size curve -- the same curve `_size` draws from
# -- which keeps the two scale factors in step by construction and makes the
# species a consequence of the measurement rather than an unrelated guess.

# The nominal size the client authors each species at is exactly the midpoint of
# `SPECIES_SIZE`, on all six -- see `nominal_size`. It is re-derived rather than
# repeated so the two files cannot drift apart silently.

# How far past the top of its own range a *measured* specimen may be placed,
# in units of that range. 1.6 lets the biggest fig in the extent come out at a
# 34 m crown on a 26 m trunk and holds every species' instance scale at or under
# 1.6x nominal, with the two axes never more than 8% apart. Past this the
# geometry stops being the thing it was authored as.
MEASURED_T_MAX = 1.6

# And the floor, for the same reason at the other end: a `height=3` sapling is
# smaller than any of the six is authored as, and taking it literally scaled a
# paperbark to 0.27 of its height and 0.88 of its width -- a green pancake a
# metre off the ground. Symmetric with the ceiling so both ends of the curve
# keep the two scale factors in step.
MEASURED_T_MIN = -0.4

# Beyond these a tag is not a measurement of a tree. `sources.osm` rejects the
# gross cases at the read; these are the botanical backstop, generous on purpose
# -- the widest crown ever recorded is a banyan at about 60 m and the tallest
# tree on earth is 116 m, so anything over them is a mis-keyed circumference, a
# building height or a typo, and the ordinary species draw is a better answer
# than a clamp of it would be.
IMPLAUSIBLE_SPREAD = 60.0
IMPLAUSIBLE_HEIGHT = 70.0

# `circumference` is deliberately not read anywhere. Four nodes in the extent
# carry it and it is the *trunk girth*, not the crown -- reading it as a spread
# is precisely the confusion that produces a 40 m canopy on a street tree.

# Genus and species fragments that appear in Sydney OSM tagging, mapped to the
# six. Matched as substrings against a lower-cased tag value, longest first, so
# `ficus macrophylla` resolves before a bare `ficus` would matter.
#
# The palms are a deliberate substitution and not an oversight. 184 nodes in the
# inner ring are tagged `taxon=Arecaceae` -- the Hyde Park and Botanic Gardens
# date palms, which are real and prominent -- and there is no palm in the six.
# Paperbark is the closest silhouette available: a single narrow crown high on a
# bare pale trunk. A seventh species is the right fix and is named as a follow-up.
TAXON_SPECIES: tuple[tuple[str, int], ...] = (
    ("ficus", FIG),
    ("moreton bay fig", FIG),
    ("morton bay fig", FIG),  # the spelling that is actually in the extent
    ("platanus", PLANE),
    ("plane tree", PLANE),
    ("jacaranda", JACARANDA),
    ("melaleuca", PAPERBARK),
    ("leptospermum", PAPERBARK),
    ("callistemon", PAPERBARK),
    ("paperbark", PAPERBARK),
    ("lophostemon", BRUSH_BOX),
    ("tristania", BRUSH_BOX),  # the old name; still widely tagged
    ("brush box", BRUSH_BOX),
    ("eucalyptus", EUCALYPT),
    ("corymbia", EUCALYPT),
    ("angophora", EUCALYPT),
    ("gum", EUCALYPT),
    # Palms -- see above.
    ("arecaceae", PAPERBARK),
    ("phoenix", PAPERBARK),
    ("washingtonia", PAPERBARK),
    ("livistona", PAPERBARK),
    ("jubaea", PAPERBARK),
    ("butia", PAPERBARK),
    ("palm", PAPERBARK),
)

# --- Placement rules ----------------------------------------------------------

SLOT_PARK_GRASS = "park_grass"

# One centimetre above the terrain. Under the carriageway's 0.02 and the
# footpath's 0.15, so that even where a subtraction leaves a sliver the paved
# surface is the one drawn.
PARK_GRASS_Y = 0.01

# Classes that get a procedural street tree where the mapping is sparse.
#
# `service` is excluded and that is not an oversight: it is laneways, driveways
# and car park aisles, and it is the most numerous class in the extent. A tree
# every fifteen metres down every Sydney back lane would be both wrong and the
# single largest instance count in the build.
STREET_TREE_CLASSES = {"residential", "tertiary", "tertiary_link", "unclassified", "living_street"}
# Inside the CBD the tree-lined streets are the arterials -- Macquarie Street,
# College Street, Hyde Park's edges -- so these two classes join in there and
# nowhere else. Motorways and trunks never do at any distance.
CBD_TREE_CLASSES = {"primary", "secondary"}

# Within this of the ENU origin counts as the CBD: it picks the plane trees, and
# it is what lets the two classes above be planted.
CBD_RADIUS = 1500.0

# Where the tree stands, measured out from the kerb face. The kerb itself is at
# `half_width + KERB_WIDTH`; a Sydney street tree sits about a metre back from it
# on the verge, which is inside the footpath band rather than beyond it.
VERGE_OFFSET = 1.0

# Nominal spacing along the verge and the jitter either side of it, so a row runs
# 12-18 m and never reads as a measured interval.
SPACING = 15.0
SPACING_JITTER = 3.0

# Fraction of candidate positions thrown away. Without it a street is a planted
# colonnade -- every position filled, evenly, on both sides -- which is the single
# most synthetic thing procedural placement can produce. A third missing is what
# a real street looks like after fifty years of removals and failed replantings.
DROPOUT = 0.35

# Keep-out radii, metres.
CLEAR_OF_BUILDING = 3.0  # no canopy pushed through a shopfront
CLEAR_OF_JUNCTION = 8.0  # sight lines at a corner, and it is where the ramps are
CLEAR_OF_MAPPED = 6.0  # never crowd a surveyed tree with an invented one
CLEAR_IN_PARK = 8.0  # specimen trees stand apart; this is not a plantation

# A way is treated as already surveyed -- and gets no procedural trees at all --
# once it carries more than one mapped tree per this many metres. Set against the
# 15 m nominal spacing above with room to spare, so "sparse" means genuinely
# sparse rather than merely less than fully planted.
MAPPED_WAY_SPACING = 40.0

# Park scatter: one tree per this many square metres of plantable park, before
# the mapped trees already standing in it are subtracted.
PARK_TREE_AREA = 420.0
# No specimen tree within this of the park's edge -- they would hang over the
# fence and, more to the point, over the footpath geometry.
PARK_EDGE_SETBACK = 3.0

# Species mixes, as (species, weight). Parks get the big three; residential
# streets get the inner-suburb three; the CBD gets planes and nothing else.
PARK_MIX: tuple[tuple[int, float], ...] = ((FIG, 0.30), (EUCALYPT, 0.40), (JACARANDA, 0.30))
STREET_MIX: tuple[tuple[int, float], ...] = (
    (BRUSH_BOX, 0.50),
    (JACARANDA, 0.30),
    (PAPERBARK, 0.20),
)

# Per-tile instance ceiling. A big park can scatter past it; street trees and
# mapped trees never do, and neither is ever the thing dropped -- the scatter is
# thinned first and only then, as a backstop nothing in the inner ring reaches,
# the procedural street rows.
MAX_TREES_PER_TILE = 400

# Ways and parks within this of a tile's bounds can put a tree inside it. Must
# exceed the widest verge offset any way produces plus the scatter's own reach.
SELECT_MARGIN = 40.0


@dataclass
class Tree:
    """One instance, in ENU metres. Tile-local conversion happens at write time."""

    east: float
    north: float
    height: float
    canopy_radius: float
    species: int
    seed: int
    # 'mapped' | 'street' | 'park'. Carried so the per-tile cap can shed the
    # invented trees and keep the surveyed ones, and so the build can report the
    # split rather than a single number that hides which source did the work.
    origin: str


# --- Hashing ------------------------------------------------------------------
# SplitMix64. Every random-looking decision in this module comes through here, so
# that it is a pure function of stable integers and not of iteration order.

_MASK = (1 << 64) - 1


def _mix(x: int) -> int:
    x = (x + 0x9E3779B97F4A7C15) & _MASK
    x = ((x ^ (x >> 30)) * 0xBF58476D1CE4E5B9) & _MASK
    x = ((x ^ (x >> 27)) * 0x94D049BB133111EB) & _MASK
    return x ^ (x >> 31)


def _hash(*parts: int) -> int:
    h = 0
    for p in parts:
        h = _mix(h ^ (int(p) & _MASK))
    return h


def _unit(h: int, stream: int = 0) -> float:
    """A value in [0, 1) from hash `h`. `stream` gives independent draws."""
    return (_mix(h ^ (stream * 0x9E3779B97F4A7C15)) >> 11) * (1.0 / (1 << 53))


def _pick(mix: tuple[tuple[int, float], ...], u: float) -> int:
    """Weighted choice from a (value, weight) table."""
    total = sum(w for _, w in mix)
    x = u * total
    for value, w in mix:
        x -= w
        if x <= 0.0:
            return value
    return mix[-1][0]


def _osm_int(osm_id: str) -> int:
    """An OSM id as an integer, tolerating the blanks and the odd non-numeric."""
    try:
        return int(osm_id)
    except (TypeError, ValueError):
        return _hash(*(ord(c) for c in (osm_id or "?")[:8]))


# --- Species and size ---------------------------------------------------------


def species_from_taxon(taxon: str) -> int | None:
    """Map an OSM genus/species/taxon string onto the six. `None` if unknown."""
    if not taxon:
        return None
    for fragment, sp in TAXON_SPECIES:
        if fragment in taxon:
            return sp
    return None


def _size(species: int, h: int, street: bool) -> tuple[float, float]:
    """Draw a height and canopy radius for one instance.

    Height and spread come off the *same* normalised draw plus a small
    independent wobble, because in a real row of one species the tall trees are
    also the wide ones -- drawing them independently produces tall thin trees
    beside short fat ones, which reads as two species badly modelled rather than
    as one species at two ages.

    A street tree draws from the lower part of the range. Kerbside trees are
    pruned away from the wires and the awnings and are simply smaller than the
    same species standing in a park, and the exception -- spec 7.5's "occasional
    street giants" -- is the fig, which is not in the street mix anyway and only
    reaches the kerb as a surveyed node.
    """
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    t = _unit(h, 1)
    if street:
        t *= 0.7
    wobble = (_unit(h, 2) - 0.5) * 0.25
    height = h_lo + (h_hi - h_lo) * t
    spread = s_lo + (s_hi - s_lo) * min(max(t + wobble, 0.0), 1.0)
    return height, spread * 0.5


# --- Measured size ------------------------------------------------------------


def nominal_size(species: int) -> tuple[float, float]:
    """The (height, canopy radius) the client authors this species' geometry at.

    `world/vegetation.ts`'s `NOMINAL` table, re-derived rather than repeated: it
    is the midpoint of `SPECIES_SIZE` on all six, height and radius alike. An
    instance's scale factors are `radius / nominalRadius` across and
    `height / nominalHeight` up, so these are the two numbers every size in the
    sidecar is ultimately measured against -- which is what `sydney
    vegetation-audit` checks, and re-deriving them here is what makes the check
    possible from this side at all.
    """
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    return (h_lo + h_hi) * 0.5, (s_lo + s_hi) * 0.25


def instance_scale(species: int, height: float, radius: float) -> tuple[float, float]:
    """`(sxz, sy)` -- exactly the scale the client will apply to this instance."""
    nom_h, nom_r = nominal_size(species)
    return radius / nom_r, height / nom_h


def _plausible(v: float | None, ceiling: float) -> bool:
    """Is a tagged length a measurement of a tree at all?"""
    return v is not None and 0.5 <= v <= ceiling


def _t_for(species: int, height: float | None, spread: float | None) -> float | None:
    """Where a measurement sits on a species' own size curve, or `None`.

    The inverse of `_size`'s parametrisation, so a measurement that lands inside
    the species' range comes back out of `size_from_measurement` unchanged to the
    millimetre -- a 20 m crown on a Moreton Bay fig is drawn at 20 m, not at
    whatever the nearest authored value happens to be.
    """
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    ts = []
    if spread is not None and s_hi > s_lo:
        ts.append((spread - s_lo) / (s_hi - s_lo))
    if height is not None and h_hi > h_lo:
        ts.append((height - h_lo) / (h_hi - h_lo))
    if not ts:
        return None
    # Both stated is rare -- no node in the inner ring does it -- but averaging
    # is the only answer that does not silently discard one of two measurements
    # of the same specimen.
    return sum(ts) / len(ts)


def species_for_measurement(
    height: float | None, spread: float | None, preferred: int
) -> int:
    """Which of the six can carry a measured size, `preferred` winning ties.

    The species is a *consequence* of the measurement whenever the two disagree,
    and that is the whole repair. Context assignment picks a paperbark for an
    untagged node in an inner-suburb street, which is right on average and wrong
    for the one node in a thousand that OSM measured a 33 m crown on -- and the
    old code kept the paperbark and stretched it 6.35x. A 33 m crown is a fig;
    saying so costs nothing and removes the distortion at its source.
    """
    # The species context or the taxon already chose keeps the tree whenever it
    # can carry the measurement without being pushed past its own ceiling.
    t = _t_for(preferred, height, spread)
    if t is not None and MEASURED_T_MIN <= t <= MEASURED_T_MAX:
        return preferred
    # How far outside its own range a species has to be pushed to carry this
    # measurement. Inside the range costs nothing, so the species whose authored
    # range actually contains it wins.
    def cost(sp: int) -> float:
        u = _t_for(sp, height, spread)
        if u is None:
            return float("inf")
        return max(u - 1.0, 0.0) + max(-u, 0.0)

    # Seeded with `preferred` rather than with infinity, so a tie goes to the
    # species the taxon or the context already chose instead of to whichever of
    # the six happens to be first in the enumeration.
    best, best_cost = preferred, cost(preferred)
    for sp in range(SPECIES_COUNT):
        c = cost(sp)
        if c < best_cost - 1e-9:
            best, best_cost = sp, c
    return best


def size_from_measurement(
    species: int, height: float | None, spread: float | None
) -> tuple[float, float]:
    """`(height, canopy radius)` for a tree OSM stated a size for.

    Both come off one `t`, exactly as `_size` draws them, so the client's two
    scale factors move together whatever the tag said. A measurement inside the
    species' range is reproduced exactly; one outside it is clamped at
    `MEASURED_T_MAX` and the tree comes out large rather than impossible.
    """
    t = _t_for(species, height, spread)
    if t is None:
        return _size(species, 0, street=False)
    t = min(max(t, MEASURED_T_MIN), MEASURED_T_MAX)
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    return h_lo + (h_hi - h_lo) * t, (s_lo + (s_hi - s_lo) * t) * 0.5


# --- The network --------------------------------------------------------------


class VegetationNetwork:
    """Every green polygon and every tree in the extent, indexed for tile queries.

    Built once per run, like `StreetNetwork`, and for the same reason: a way is
    asked about by every tile it touches, and the generation along it is far more
    expensive than the lookup.
    """

    def __init__(
        self,
        greens: list[osm.OsmGreen],
        mapped: list[osm.OsmTree],
        street_network: streets.StreetNetwork,
        rail_envelope=None,
    ) -> None:
        # The railway, as a plan keep-out. `None` where the build has no rail
        # bake to read, in which case nothing is kept out and `railenv.load`
        # has already said so.
        self._rail = rail_envelope
        #: Trees dropped for standing in the corridor, by source, for the report.
        self.rail_dropped: Counter[str] = Counter()
        self._greens = greens
        self._green_polys = [g.polygon for g in greens]
        self._green_tree = STRtree(self._green_polys) if greens else None
        self._streets = street_network

        self._mapped = mapped
        self._mapped_xy = np.asarray(
            [(t.east, t.north) for t in mapped], dtype=np.float64
        ) if mapped else np.zeros((0, 2))
        self._mapped_tree = (
            STRtree([Point(t.east, t.north) for t in mapped]) if mapped else None
        )

        # Junction proxies: the end points of every street-class way. OSM splits
        # a way at a junction almost without exception, so the ends are where the
        # corners are. It over-reports -- a way also splits where the name or the
        # speed limit changes mid-block -- and that is the right way to be wrong,
        # because the cost is one missing tree and the alternative is a tree in
        # the middle of a corner splay.
        ends: list[Point] = []
        for i, r in enumerate(street_network.roads):
            if r.is_foot:
                continue
            coords = np.asarray(street_network.centreline(i).coords)
            if len(coords) < 2:
                continue
            ends.append(Point(coords[0]))
            ends.append(Point(coords[-1]))
        self._junctions = STRtree(ends) if ends else None

        self._street_cache: dict[int, list[Tree]] = {}
        self._park_cache: dict[int, list[Tree]] = {}

    @classmethod
    def load(
        cls,
        radius_m: float,
        street_network: streets.StreetNetwork,
        rail_envelope=None,
    ) -> VegetationNetwork:
        return cls(
            osm.read_green(radius_m), osm.read_trees(radius_m), street_network,
            rail_envelope,
        )

    # --- Reporting -----------------------------------------------------------

    @property
    def green_count(self) -> int:
        return len(self._greens)

    @property
    def mapped_count(self) -> int:
        return len(self._mapped)

    @property
    def green_area(self) -> float:
        return float(sum(p.area for p in self._green_polys))

    # --- Tile coverage -------------------------------------------------------

    def tile_keys(self) -> set[str]:
        """Every tile any vegetation could reach.

        A superset, from bounds rather than from built geometry, on the same
        argument `streets.tile_keys` makes: a tile emitted and found empty costs
        one pass, and a tile wrongly omitted is a park that is not in the world
        and nothing in the output says so. This is what makes a park-only tile --
        no buildings, no streets, just grass -- get emitted at all.
        """
        s = config.TILE_SIZE
        out: set[str] = set()

        def add_bounds(e0: float, n0: float, e1: float, n1: float) -> None:
            for tx in range(math.floor(e0 / s), math.floor(e1 / s) + 1):
                for tz in range(math.floor(n0 / s), math.floor(n1 / s) + 1):
                    out.add(f"{tx}_{tz}")

        for poly in self._green_polys:
            add_bounds(*poly.bounds)
        for t in self._mapped:
            add_bounds(t.east, t.north, t.east, t.north)
        return out

    # --- The park surface ----------------------------------------------------

    def surface(self, tile_key: str) -> BaseGeometry:
        """One tile's grass polygon: green, minus buildings, minus the road."""
        if self._green_tree is None:
            return Polygon()
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)

        hits = self._green_tree.query(tile_box)
        if len(hits) == 0:
            return Polygon()
        green = unary_union([self._green_polys[int(i)] for i in hits])
        if green.is_empty:
            return Polygon()

        # Buildings out. Park kiosks, grandstands, amenities blocks and the
        # occasional apartment tower whose site is tagged `landuse=grass` all sit
        # inside these polygons, and grass drawn under a wall is grass that
        # appears the moment anything opens one.
        obstacles = self._streets.buildings_near(green)
        if obstacles:
            green = green.difference(unary_union(obstacles))

        # Road out. The carriageway is one centimetre above this surface, which
        # is far too little to survive depth quantisation at any distance, and
        # Art Gallery Road runs straight through the Domain. Kerb included --
        # it is the same computation and it removes the sliver along the edge.
        surf = self._streets.surfaces(tile_key)
        paved = [g for g in (surf.carriageway, surf.kerb) if not g.is_empty]
        if paved and not green.is_empty:
            green = green.difference(unary_union(paved))

        # Clipped last, per `streets.py`'s rule: both neighbours of a seam build
        # from the same source polygons, so cutting each to its own bounds cuts
        # along the same line at the same coordinates and the two butt exactly.
        return streets._clip(green, tile_box)

    def emit_surface(
        self,
        tile_key: str,
        slots: dict[str, mesh.MeshBuffers],
        origin: tuple[float, float],
        terrain=None,
    ) -> None:
        """Tessellate the tile's grass into its material slot, draped on `terrain`."""
        green = self.surface(tile_key)
        if green.is_empty:
            return
        # Belongs to no building and reads no facade parameters, exactly like the
        # street slots -- so it leaves `_BLDIDX` off the primitive entirely.
        slots[SLOT_PARK_GRASS].building_indexed = False
        # Draped through the same call the roads go through, which is the point
        # of that being one function: the grass and the carriageway cut out of it
        # are densified by the same rule and sampled at the same points, so they
        # cannot part company along the boundary they share.
        streets._emit_flat(slots[SLOT_PARK_GRASS], green, PARK_GRASS_Y, origin, terrain)

    # --- Instances -----------------------------------------------------------

    def _candidates_near(
        self, region: BaseGeometry
    ) -> tuple[list[Tree], list[Tree], list[Tree]]:
        """Every candidate from the three sources whose position falls near
        `region`, kept apart by source and before any per-tile filtering."""
        mapped = self._mapped_in(region)
        street: list[Tree] = []
        for i in self._streets.ways_near(region):
            street.extend(self._street_trees(i))
        park: list[Tree] = []
        if self._green_tree is not None:
            for i in self._green_tree.query(region):
                park.extend(self._park_trees(int(i)))
        return mapped, street, park

    def trees_near(self, region: BaseGeometry) -> list[Tree]:
        """Every candidate tree standing near `region`, from all three sources.

        Exposed for `parking.py`, which has to know where the trunks are before
        it can decide whether a bay is free, and cannot ask per tile: a trunk two
        metres over a tile line still stands in a bay on the other side of it.

        Deliberately *not* the per-tile answer. It skips the road test and the
        per-tile cap, so it can return a tree that `instances` will go on to
        drop. That is the conservative direction for a keep-out and it is also
        the stable one -- a bay's fate should not depend on how crowded the tile
        it happens to sit in turned out to be.
        """
        mapped, street, park = self._candidates_near(region)
        return mapped + street + park

    def instances(self, tile_key: str) -> list[Tree]:
        """Every tree standing inside one tile, from all three sources."""
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)
        margin = tile_box.buffer(SELECT_MARGIN)

        def inside(t: Tree) -> bool:
            # Half-open on the upper edge so a tree exactly on a tile line lands
            # in one tile and not in both.
            return e0 <= t.east < e1 and n0 <= t.north < n1

        all_mapped, all_street, all_park = self._candidates_near(margin)
        mapped = [t for t in all_mapped if inside(t)]
        street = [t for t in all_street if inside(t)]
        park = [t for t in all_park if inside(t)]

        # Anything standing on the road is dropped, whatever produced it. The
        # verge offset guarantees a tree clears *its own* carriageway; it says
        # nothing about the cross street it was placed next to, and a scattered
        # park tree knows about no road at all. The tile's carriageway is already
        # clipped to the tile and every candidate here is inside the tile, so the
        # test is exact rather than merely close.
        surf = self._streets.surfaces(tile_key)
        if not surf.carriageway.is_empty:
            road = surf.carriageway
            street = [t for t in street if not road.contains(Point(t.east, t.north))]
            park = [t for t in park if not road.contains(Point(t.east, t.north))]

        # And anything standing in the railway, whatever produced it.
        #
        # HERE RATHER THAN IN THE THREE GENERATORS, and for the reason the road
        # test above is here: this is the one place all three sources have
        # landed, so a keep-out written once cannot be a keep-out two of them
        # have and the third does not. `_position_is_clear` looked like the
        # place -- it holds the junction, mapped-tree and building keep-outs --
        # but it is only ever asked about a *street* tree, and the trees in the
        # corridor are not street trees. Measured over the shipped world, of the
        # trees inside the corridor the split is scattered park interiors and
        # surveyed nodes, not procedural rows.
        #
        # **A surveyed tree is dropped too**, which is the one place this module
        # overrides OSM. Everywhere else a mapped node is *"never moved, never
        # thinned and never overridden"*. Inside the rail corridor the carve has
        # taken the ground away, so keeping the node means a surveyed tree
        # hanging in a trench -- and the two claims cannot both be honoured. The
        # corridor is the narrower and better-surveyed of the two geometries, so
        # it wins, and the count is reported by source so the override is
        # visible rather than silent.
        if self._rail is not None:
            def clear(t: Tree) -> bool:
                if not self._rail.in_corridor(t.east, t.north):
                    return True
                self.rail_dropped[t.origin] += 1
                return False

            mapped = [t for t in mapped if clear(t)]
            street = [t for t in street if clear(t)]
            park = [t for t in park if clear(t)]

        return self._cap(mapped, street, park)

    @staticmethod
    def _cap(mapped: list[Tree], street: list[Tree], park: list[Tree]) -> list[Tree]:
        """Hold a tile under `MAX_TREES_PER_TILE`, cheapest source first.

        Order is the point. Mapped trees are surveyed and are never dropped.
        Street trees are the ones the city is read by at eye level. Park scatter
        is the one source whose density is a guess in the first place, so it is
        the one that gives -- and it gives by hashed rank rather than by list
        order, so thinning a tile removes an even spread rather than one corner
        of the park.
        """
        budget = MAX_TREES_PER_TILE - len(mapped) - len(street)
        if budget < len(park):
            park = sorted(park, key=lambda t: t.seed)[: max(budget, 0)]
        out = mapped + street + park
        if len(out) > MAX_TREES_PER_TILE:
            # Only reachable when the surveyed and street trees alone exceed the
            # ceiling, which no tile in the inner ring does. Kept because a
            # silent 900-instance tile is a frame spike nobody would attribute.
            keep = max(MAX_TREES_PER_TILE - len(mapped), 0)
            out = mapped + sorted(street, key=lambda t: t.seed)[:keep]
        return out

    # --- Source (a): mapped nodes --------------------------------------------

    def _mapped_in(self, region: BaseGeometry) -> list[Tree]:
        if self._mapped_tree is None:
            return []
        out: list[Tree] = []
        for i in self._mapped_tree.query(region):
            t = self._mapped[int(i)]
            h = _hash(_osm_int(t.osm_id), 0x7EE)
            species = species_from_taxon(t.taxon)
            if species is None:
                species = self._context_species(t.east, t.north, h)

            # What OSM actually measured, after the botanical backstop. 44 nodes
            # in the inner ring state one of these; the rest fall through to the
            # ordinary draw.
            measured_h = t.height if _plausible(t.height, IMPLAUSIBLE_HEIGHT) else None
            measured_s = (
                t.crown_diameter
                if _plausible(t.crown_diameter, IMPLAUSIBLE_SPREAD)
                else None
            )

            if measured_h is None and measured_s is None:
                # A surveyed tree in a park is a park specimen and takes the
                # full size range; one on a street is a street tree and takes
                # the pruned one.
                in_park = self._in_plantable_green(t.east, t.north)
                height, radius = _size(species, h, street=not in_park)
            else:
                # A measurement decides the species as well as the size -- see
                # `species_for_measurement`. The taxon, where OSM states one,
                # still wins: `Ficus macrophylla` is a fig at whatever size it
                # was measured at, and only its `t` moves.
                if species_from_taxon(t.taxon) is None:
                    species = species_for_measurement(measured_h, measured_s, species)
                height, radius = size_from_measurement(species, measured_h, measured_s)

            out.append(
                Tree(t.east, t.north, height, radius, species, h & 0xFF, "mapped")
            )
        return out

    # --- Source (b): procedural street trees ----------------------------------

    def _street_trees(self, i: int) -> list[Tree]:
        """Every candidate along one way, already filtered against everything
        that does not depend on which tile is asking."""
        cached = self._street_cache.get(i)
        if cached is not None:
            return cached
        out = self._build_street_trees(i)
        self._street_cache[i] = out
        return out

    def _build_street_trees(self, i: int) -> list[Tree]:
        road = self._streets.roads[i]
        line = self._streets.centreline(i)
        length = line.length
        # A street tree does not grow on a bridge, and since `decks.py` took the
        # bridge ways off the ground it would be rooted in whatever the viaduct
        # flies over -- the harbour, in three cases. See `streets.DECK_EDGE`.
        if road.is_foot or road.bridge or length < 24.0:
            return []

        cbd = self._is_cbd(line)
        if road.highway in STREET_TREE_CLASSES:
            pass
        elif cbd and road.highway in CBD_TREE_CLASSES:
            pass
        else:
            return []

        if self._way_is_mapped(i, line, length):
            return []

        way_id = _osm_int(road.osm_id)
        offset = self._streets.half_width(i) + streets.KERB_WIDTH + VERGE_OFFSET
        out: list[Tree] = []

        for side in (-1, 1):
            # Start a whole spacing in from the end rather than at it: an end is
            # a junction until proved otherwise, and the junction test below
            # would throw the first two away anyway.
            s = SPACING * 0.5
            while s < length - CLEAR_OF_JUNCTION:
                # The step is hashed off the *current* distance, so the sequence
                # is deterministic even though each step depends on the last.
                h = _hash(way_id, side, int(s * 100.0))
                step = SPACING + (_unit(h, 3) - 0.5) * 2.0 * SPACING_JITTER
                if _unit(h, 4) < DROPOUT:
                    s += step
                    continue
                pos = self._verge_point(line, s, offset * side)
                if pos is None:
                    s += step
                    continue
                east, north = pos
                if not self._position_is_clear(east, north):
                    s += step
                    continue
                species = PLANE if cbd else _pick(STREET_MIX, _unit(h, 5))
                height, radius = _size(species, h, street=True)
                out.append(Tree(east, north, height, radius, species, h & 0xFF, "street"))
                s += step
        return out

    def _verge_point(
        self, line: LineString, s: float, offset: float
    ) -> tuple[float, float] | None:
        """A point `offset` metres to the left of the way at distance `s`.

        Left of travel for a positive offset, matching the winding convention
        `streets._emit_kerb_face` reads its normals off, so the two modules
        disagree about nothing.
        """
        a = line.interpolate(max(s - 0.5, 0.0))
        b = line.interpolate(min(s + 0.5, line.length))
        dx, dy = b.x - a.x, b.y - a.y
        n = math.hypot(dx, dy)
        if n < 1e-6:
            return None
        c = line.interpolate(s)
        return (c.x - dy / n * offset, c.y + dx / n * offset)

    def _position_is_clear(self, east: float, north: float) -> bool:
        """The three keep-outs that do not depend on the tile."""
        p = Point(east, north)
        if self._junctions is not None:
            if len(self._junctions.query(p.buffer(CLEAR_OF_JUNCTION))) > 0:
                return False
        if self._mapped_tree is not None:
            if len(self._mapped_tree.query(p.buffer(CLEAR_OF_MAPPED))) > 0:
                return False
        for poly in self._streets.buildings_near(p.buffer(CLEAR_OF_BUILDING)):
            if poly.distance(p) < CLEAR_OF_BUILDING:
                return False
        return True

    def _way_is_mapped(self, i: int, line: LineString, length: float) -> bool:
        """Has this street already been surveyed tree by tree?

        The corridor is the carriageway plus the verge plus a couple of metres of
        slop, because a mapped street tree is digitised from imagery and lands
        anywhere across the nature strip.
        """
        if self._mapped_tree is None:
            return False
        corridor = self._streets.half_width(i) + streets.KERB_WIDTH + VERGE_OFFSET + 2.5
        found = len(self._mapped_tree.query(line.buffer(corridor)))
        return found >= 2 and found >= length / MAPPED_WAY_SPACING

    # --- Source (c): park scatter ---------------------------------------------

    def _park_trees(self, i: int) -> list[Tree]:
        cached = self._park_cache.get(i)
        if cached is not None:
            return cached
        out = self._build_park_trees(i)
        self._park_cache[i] = out
        return out

    def _build_park_trees(self, i: int) -> list[Tree]:
        green = self._greens[i]
        if not green.plantable:
            return []
        poly = green.polygon

        # Trees stand back from the boundary. A park narrower than twice the
        # setback has no interior to speak of -- a nature strip, a traffic island
        # -- and gets nothing, which is correct.
        region = poly.buffer(-PARK_EDGE_SETBACK)
        if region.is_empty:
            return []

        target = int(region.area / PARK_TREE_AREA)
        if target <= 0:
            return []

        # Subtract what is already there. This is what keeps Hyde Park -- mapped
        # tree by tree, hundreds of them -- from receiving a second invented
        # forest on top of the real one, and it does it without a special case:
        # a well-mapped park simply has no budget left.
        if self._mapped_tree is not None:
            target -= len(self._mapped_tree.query(poly))
        if target <= 0:
            return []

        # Poisson-ish: one jittered sample per cell of a grid sized to the target
        # count. Cheap, deterministic, and it cannot clump the way independent
        # uniform samples do -- which matters here because a clump of Moreton Bay
        # figs is a forest and the whole brief is that a park is not one.
        cell = math.sqrt(region.area / target)
        e0, n0, e1, n1 = region.bounds
        park_id = _osm_int(green.osm_id)
        placed: list[Tree] = []
        placed_xy: list[tuple[float, float]] = []

        for gx in range(int(math.floor(e0 / cell)), int(math.floor(e1 / cell)) + 1):
            for gz in range(int(math.floor(n0 / cell)), int(math.floor(n1 / cell)) + 1):
                h = _hash(park_id, gx, gz)
                east = (gx + _unit(h, 6)) * cell
                north = (gz + _unit(h, 7)) * cell
                p = Point(east, north)
                if not region.contains(p):
                    continue
                if self._mapped_tree is not None:
                    if len(self._mapped_tree.query(p.buffer(CLEAR_IN_PARK))) > 0:
                        continue
                if any(
                    (east - x) ** 2 + (north - z) ** 2 < CLEAR_IN_PARK**2
                    for x, z in placed_xy
                ):
                    continue
                if any(
                    q.distance(p) < CLEAR_OF_BUILDING
                    for q in self._streets.buildings_near(p.buffer(CLEAR_OF_BUILDING))
                ):
                    continue
                species = _pick(PARK_MIX, _unit(h, 8))
                height, radius = _size(species, h, street=False)
                placed.append(Tree(east, north, height, radius, species, h & 0xFF, "park"))
                placed_xy.append((east, north))
        return placed

    # --- Context --------------------------------------------------------------

    def _is_cbd(self, geom: BaseGeometry) -> bool:
        c = geom.centroid
        return c.x * c.x + c.y * c.y <= CBD_RADIUS * CBD_RADIUS

    def _in_plantable_green(self, east: float, north: float) -> bool:
        if self._green_tree is None:
            return False
        p = Point(east, north)
        return any(
            self._greens[int(i)].plantable and self._green_polys[int(i)].contains(p)
            for i in self._green_tree.query(p)
        )

    def _context_species(self, east: float, north: float, h: int) -> int:
        """What a tree of unstated species is, from where it stands.

        The order is a claim about Sydney and not just a fallback chain: a tree
        inside a park is a specimen tree, a tree in the CBD is a plane because
        the council planted plane trees there for a century, and a tree anywhere
        else in the inner suburbs is one of the three the nurseries sold.
        """
        if self._in_plantable_green(east, north):
            return _pick(PARK_MIX, _unit(h, 9))
        if east * east + north * north <= CBD_RADIUS * CBD_RADIUS:
            return PLANE
        return _pick(STREET_MIX, _unit(h, 10))
