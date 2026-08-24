"""Vegetation: green ground surfaces and plant instances, per tile.

Spec section 7.5 is unusually blunt about what matters here: *species* matter more
than quality, and **no oaks, no maples, no conifers -- they read American
instantly**. So this module's job is not to grow good trees. It is to put the
right six silhouettes in the right places, in the right numbers, and to leave the
February colour to the client.

Two outputs, from three sources.

**The green surfaces** are three material slots -- `park_grass`, `bush_floor`
and `wetland_mud` -- emitted the way `streets.py` emits its three: polygons
unioned per tile, clipped to the tile last, cut against the terrain facets,
world-metre UVs, no `_BLDIDX`. They sit one centimetre over the ground -- one
under the carriageway, and the carriageway is cut out of them anyway, so the
ordering is belt and braces. They are what stops a park rendering as the same
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
  d. **Bushland interiors, scattered.** Everything (c) is not: the national
     parks, the reserves, the scrub, the heath and the mangroves. Its own
     source rather than a density constant on (c), because a stand of forest
     and a lawn with figs on it disagree about the density, the species, the
     size draw, the ground under them and whether the instances are trees at
     all. See "The bushland round" below.

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

===============================================================================
THE BUSHLAND ROUND
===============================================================================

The report was *"national park etc need more default tree coverage"*, and the
cause was never missing data. `sources.osm`'s green read looked at four leisure
values, four landuse values and one natural value, and **not one bushland tag
was among them** -- the header of that block admitted as much and deferred
`natural=wood` and `natural=scrub` as "a project of its own". Counted over the
extract and clipped to the emitted world box, the tags it never read carry
**2,917 km2 of ground** against the **272 km2** it did. Lane Cove National Park
carries three of them and was in none of the sets, which is why a player
standing in it saw bare brown hills.

`sources.osm.GREEN_COVER` is the fix on the read side: six cover classes, a
rank that settles an overlap by specificity, and the whole essay for why.
This module is what the classes then *mean*.

---------------------------------------------------------------------------
A SURFACE PER CLASS, and there are three of them rather than six.

    park_grass    mown. Parks, gardens, ovals, verges, cemeteries. Unchanged.
    bush_floor    forest, scrub, heath and rough. Sandstone grit, leaf litter
                  and grey-green understorey.
    wetland_mud   wetland. Estuarine mud and saltmarsh.

Four classes share `bush_floor` on purpose. At eye level the ground under a
dry sclerophyll forest, a scrub, a heath and a golf-course rough is the same
thing -- sandstone gravel, bark litter and dry sedge -- and the difference
between those four is *three-dimensional*: it is the height and the density of
what is standing on it, which is the instances' job. Painting four ground
colours to say what four scatters already say would be spending a material slot
to repeat something.

`wetland_mud` is the one that could not share, and the reason is that it is not
vegetation-coloured at all. Sydney's mangroves are real and prominent -- Badu
at Homebush, the Lane Cove and Georges River reaches, Bicentennial Park -- and
they stand on grey-brown tidal mud. Dry leaf litter on tidal mud is a worse
answer than the bare dirt it replaces. Where the tide is actually over the mud
the water sheet draws above it and wins on its own height, exactly the way the
carriageway wins over the grass, so this needs no water subtraction of its own.

The three are **disjoint by construction**. `surfaces` takes the classes in
rank order and subtracts every better-ranked union out of each worse-ranked
one, so the mown picnic lawn inside Lane Cove is cut out of the forest floor
rather than z-fighting with it, and no square metre of ground is painted twice.

---------------------------------------------------------------------------
DENSITY, AND THE ARITHMETIC THAT SAYS IT CANNOT BE THE REAL ONE.

The ecology first, because the budget has to be argued against something.
Sydney's bushland is overwhelmingly **Sydney Coastal Dry Sclerophyll Forest**
on Hawkesbury sandstone, with Turpentine-Ironbark and Blue Gum High Forest on
the shale caps and coastal heath on the plateau edges. Benson & Howell's *Taken
for Granted: the bushland of Sydney and its suburbs* and the NSW BioNet
vegetation benchmarks for the Sydney Basin put a dry sclerophyll stand at
roughly **300-600 stems/ha** over 10 cm DBH, of which the **canopy layer --
the dominant and codominant eucalypts, which is what an instance with a crown
actually is -- is 100-200/ha**. Coastal heath is not trees at any density: it
is a continuous 0.3-1.5 m shrub layer, and its stem count is in the thousands.

Now the arithmetic, which is the whole engineering content of this round.
**2,917 km2 at 150 canopy stems a hectare is 43.8 million trees.** That is not
instanceable, and it is not close. So the near field and the far field are two
different answers, and the near field is a budget rather than an ecology:

  * The client holds one geometry per species and draws a tile's instances as
    one `InstancedMesh` per species present. The most expensive frame the built
    world has is the CBD spawn on the streamer's own 1.8 km radius, and it is
    measured in two files that measured the *same camera*. `world/cars.ts`:
    **3,759 parked cars at 398 k triangles, alongside 5,914 trees and 520 k**,
    plus ~23 k of traffic movers. `world/vegetation.ts`: 232 k of buildings and
    streets. **1,173,000 triangles, and it ships** -- and that is a floor,
    because the crowd, the police, the furniture, the power spans and the
    nameplates are all in that frame and in neither number.
  * A bushland tile carries **none** of the cars, none of the crowd, none of
    the furniture, and ~2,800 triangles of static mesh against an urban tile's
    12,600 median.
  * So the ceiling is **parity on the whole frame**: a 25-tile bushland view
    must cost no more than the 25-tile CBD view already does. That is
    (1,173,000 - 25 x 2,800) / 25 = **44,100 triangles of canopy a tile**, and
    `BUSH_TRIANGLE_BUDGET` takes 40,000 of them -- 91% of the CBD frame, with
    the margin left where the shadow pass wants it. That constant's own comment
    carries the shadow arithmetic and the one number that comes out worse.

**A budget is not what gets a forest, though, and it is worth being blunt about
why.** A hundred canopy stems a hectare over 25 ha is 2,500 stems. At the 96
triangles the four real bushland silhouettes average, that is 240,000 triangles
a tile -- six times any budget this frame can carry under any reading of it. The
first cut of this round set the budget at 28,000 and got **11.6 stems a
hectare**, which is *sparser than the mown park next door* at 24, and shipping a
bushland round whose forests are thinner than Hyde Park would have been the same
defect with more code around it.

So the per-stem cost is the lever, and it is the only one:

    stems wanted     2,500 a tile, for 100/ha over 25 ha
    budget           40,000 triangles
    therefore        16 triangles a stem, and there is no arguing with it

`BUSH_TREE` is **14** -- a three-sided trunk cone and one octahedral crown, 12
vertices, a tenth of a eucalypt. Nine stems in ten are drawn with it and the
tenth carries the full silhouette, picked by the same hash as everything else so
that the detailed ones are spread evenly through the stand. `FOREST_MIX` holds
the arithmetic and the honest name for it, which is a **stochastic level of
detail** standing in for the distance tier the client does not have. It buys
**71 canopy stems a hectare at ~80% canopy cover**, against 11.6 and 13%.

The impostor tier is still what unlocks the rest and is still the next round: a
camera-facing pair of quads is 4 triangles, so the same 40,000 carries 10,000
stems -- and, more to the point, it makes the detail a function of *distance*
rather than of a hash, which is what it should always have been. The seam is
where `world/vegetation.ts` has always said it is. It is refused here because it
is a client rendering round and this is a data round, and mixing the two would
make neither reviewable.

Two more things the budget buys for nothing. Bushland trees draw from the **top**
of their species' size range rather than the middle (a forest gum is 18-20 m
with a 13 m crown, not the 14 m pruned street tree `_size` draws by default),
which is what takes 71 stems a hectare to 80% cover rather than to 45%. And the
shrub is a quarter of a tree, so heath and scrub get 65 and 62 stems a hectare
where a tree-priced budget would have given them nine.

---------------------------------------------------------------------------
TWO NEW SILHOUETTES, AND WHAT THEY COST.

`BUSH_TREE` is the first and the budget essay above is its whole argument: nine
stems in ten in every bushland class, 14 triangles, and the only reason a forest
is a forest rather than a lawn with gum trees on it.

`SHRUB` is the second, and it is added because **heath and scrub cannot be told
at all without it**. They are 3,075 polygons and 33
km2, they are what the Royal, the clifftops and half the coastal reserves
actually are, and the two alternatives are both worse than the defect: 15 m
eucalypts on a coastal heath is a lie about the landscape, and nothing on it is
the bare ground this round exists to remove. A eucalypt scaled to 1.5 m is not
an option either -- it is a doll's-house gum tree, and `vegetation-audit`'s
whole subject is instances scaled away from what they were authored as.

The cost of each is one row in every table keyed by species (six of them here,
three in `world/vegetation.ts`), one more `InstancedMesh` on a tile that has any,
and one new geometry. `SHRUB` is **24 triangles** -- three octahedral lobes and
no trunk, against the eucalypt's 100 and the fig's 162 -- because a shrub seen in
mass needs a lumpy outline and nothing else, and it is the only reason heath is
affordable at 65 stems a hectare. `BUSH_TREE` is 14 and shares its octahedron.

Both are cheaper than the six they stand beside, and that is the whole point:
this round's currency is triangles, and every one of them buys a stem.

---------------------------------------------------------------------------
THE FAR FIELD IS COLOUR, AND IMPOSTORS ARE REFUSED WITH A REASON.

Past the streaming radius there are no instances at all: the horizon is
`far-terrain.bin`, a 243 x 243 post heightfield at 500 m wearing `ground.ts`'s
dry-buff-soil material -- which is why the hills read brown in the screenshot
even where this module *does* emit green, and it is half the defect.
(`far.ts`'s `FAR_TINT` was named as the cause; it is not. That table is indexed
by a *building's* wall material and `far.bin` holds nothing but buildings, so
its `park_grass` row has never been read by anything. The rows still have to
exist -- the file throws at import if the table is shorter than `MATERIALS` --
and the two new slots get one each.)

So the far field gets a **cover channel**: `far-cover.bin`, one u8 per far
terrain post naming the dominant cover class in that 500 m cell, 59 kB for the
whole 60 km world. `ground.ts` mixes a per-class canopy colour into the dirt on
the far ground alone, and Ku-ring-gai reads as forest from 20 km for the price
of a byte per quarter square kilometre.

**Impostor clumps in the far layer are refused this round.** Colour carries the
hills because at 2 km a forested ridge *is* a colour -- the individual crowns
subtend under an arcminute and what the eye reads is the tone and the way it
follows the terrain, both of which the cover channel gives exactly. An impostor
would buy silhouette at the ridge line, which is real but is second-order, and
it would cost a new payload, a new per-hex slice, a new eviction rule and a new
draw. It belongs in the same round as the near-field impostor above, sharing
its geometry and its argument.

---------------------------------------------------------------------------
THE UPGRADE PATH, because it is real and it is the next data round.

None of this round needed new data -- the polygons were already in the extract
and the counts above are the proof. The three sources that would replace the
per-class constants with measurements, recorded here so the option is on the
record rather than rediscovered:

  * **Meta/WRI High Resolution Canopy Height** -- 1 m global canopy height,
    CC-BY 4.0, COGs on AWS Open Data (`dataforgood-fb-forestsv2`). Local
    maxima on it are individual crowns *with heights*, everywhere in the world
    box, which turns density and size from a class constant into a measurement
    and catches the cleared ground inside a polygon OSM calls forest.
  * **NSW State Vegetation Type Map** (SEED, free) -- the Plant Community Type
    per patch, which is how a sandstone gully forest gets a different species
    mix from a coastal heath instead of both taking `FOREST_MIX`.
  * **Greater Sydney Region Tree Canopy 2022** (data.nsw.gov.au, free) --
    canopy percentage per mesh block. This one is not a source, it is the
    **calibration target**: an audit asking *"is our canopy within N% of the
    measured canopy, per mesh block"* is the honest gate for the round that
    raises the density, and it is worth naming now even though it is not built.
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
SHRUB = 6  # not a tree. The heath and scrub layer -- see the header
BUSH_TREE = 7  # a tree drawn cheap. 14 triangles, and the reason a forest exists

SPECIES_COUNT = 8

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
    # Not a nursery catalogue entry, because a shrub is not a nursery item: this
    # is the range a Sydney coastal-heath and dry-sclerophyll shrub layer
    # actually occupies. Banksia ericifolia, Hakea, Leptospermum and the
    # tea-trees run 0.9 m on an exposed clifftop to 2.8 m in a sheltered gully,
    # and they are consistently a little wider than they are tall because they
    # are wind-pruned rather than pruned for a crown.
    # **Proportional on purpose**: 0.9/2.7 and 1.1/3.3 are both exactly 1:3, so
    # `_size` draws a shrub whose two client scale factors are *equal* at every
    # point of the curve rather than merely close. Nothing else in this table is
    # proportional and nothing else needs to be -- a tree's ranges are narrow
    # against its own midpoint (a eucalypt swings +/-25%) and the mismatch
    # disappears into the tolerance. A shrub swings +/-50%, which doubles every
    # relative error in the draw, and the first cut of this row (0.9, 2.8, 1.1,
    # 3.2) put seven instances past `vegetation-audit`'s 1.15 aspect limit.
    SHRUB: (0.9, 2.7, 1.1, 3.3),
    # **Deliberately identical to `EUCALYPT`**, because it is one. `BUSH_TREE`
    # is not a different plant and is not a different stratum: it is the same
    # tree with a tenth of the triangles, and giving it a smaller range would
    # make a forest visibly two-tiered along a line the ecology does not draw.
    BUSH_TREE: (12.0, 20.0, 8.0, 14.0),
}

#: The six a *measured* tree may be assigned to. `SHRUB` and `BUSH_TREE` are
#: excluded and for two different reasons: a shrub is not a tree at all, and a
#: bush tree is a low-detail draw -- a specimen OSM went to the trouble of
#: measuring a 33 m crown on is exactly the tree that should get the full
#: silhouette. See `species_for_measurement`.
MEASURABLE_SPECIES = (FIG, PLANE, JACARANDA, PAPERBARK, BRUSH_BOX, EUCALYPT)

#: How hard `_size`'s spread wobble blows on each species, as a multiple of the
#: 0.25 of `t` every tree gets. Absent means 1.0, and **1.0 is exact in IEEE754**
#: -- multiplying by it cannot move a single existing instance by a bit, which is
#: what lets this be added without re-emitting the city.
#:
#: Only the shrub is turned down, and the reason is the same one its size row
#: gives: the wobble is an absolute displacement in `t`, so what it does to the
#: *ratio* of the two scale factors depends on how wide a species' range is
#: against its own midpoint. On a eucalypt +/-0.125 of `t` is 6.8% of the nominal
#: radius; on a shrub it is 12.2%, and at the bottom of the curve that is enough
#: to push the aspect past what the client's non-uniform instance scale can carry
#: without the thing reading as a squashed version of itself. 0.4 puts the
#: shrub's worst aspect at 1.06 against a limit of 1.15.
SIZE_WOBBLE: dict[int, float] = {SHRUB: 0.4}

# Triangles per species in the client's authored geometry, and it is here so the
# per-tile budget can be spent in the unit that actually costs -- see
# `BUSH_TRIANGLE_BUDGET`. A cap in *instances* prices a 24-triangle shrub the
# same as a 162-triangle fig, which is wrong by a factor of seven in the one
# direction that decides whether a heath is affordable.
#
# **An upper bound per stem, not an exact cost**, since the tree-variety round:
# the client draws `BUSH_TREE` as one of four crown archetypes and one of them
# -- the dead spar, at 5% of stems -- is twelve triangles rather than fourteen.
# So a forest tile spends about 13.9 a stem against the 14 budgeted here and
# comes in marginally under. `world/vegetation.ts`'s `verifyVegetationCost` is
# what holds that direction: an archetype may be cheaper than the number below
# and may never be dearer.
#
# Derived rather than measured, and the derivation is the whole check on it:
# `world/vegetation.ts`'s `buildSpecies` builds each species out of `cone` --
# `2 * sides` triangles -- and `lobe`, an icosahedron at 20, or `blob`, an
# octahedron at 8. Counting the calls in that switch gives the column below, and
# `VegetationAssets.triangles` computes the same numbers from the built
# geometry, so `verifyCanopy` asserts the two agree at boot rather than leaving
# this table to rot the first time a lobe is added to a crown.
SPECIES_TRIANGLES: dict[int, int] = {
    FIG: 162,  # 2 trunk cones(8) + 3 limb cones(5) + 5 lobes
    PLANE: 72,  # 1 cone(6) + 3 lobes
    JACARANDA: 88,  # 1 cone(6) + 2 cones(4) + 3 lobes
    PAPERBARK: 64,  # 2 cones(6) + 2 lobes
    BRUSH_BOX: 72,  # 1 cone(6) + 3 lobes
    EUCALYPT: 100,  # 2 cones(6) + 2 cones(4) + 3 lobes
    SHRUB: 24,  # 3 blobs, no trunk
    BUSH_TREE: 14,  # 1 cone(3) + 1 blob
}

SPECIES_NAME = {
    FIG: "moreton_bay_fig",
    PLANE: "plane",
    JACARANDA: "jacaranda",
    PAPERBARK: "paperbark",
    BRUSH_BOX: "brush_box",
    EUCALYPT: "eucalypt",
    SHRUB: "shrub",
    BUSH_TREE: "bush_tree",
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
SLOT_BUSH_FLOOR = "bush_floor"
SLOT_WETLAND_MUD = "wetland_mud"

#: Which slot each cover class paints. Four classes share `bush_floor`; see the
#: header for why that is a decision rather than an economy.
COVER_SLOT: dict[str, str] = {
    osm.COVER_MOWN: SLOT_PARK_GRASS,
    osm.COVER_ROUGH: SLOT_BUSH_FLOOR,
    osm.COVER_FOREST: SLOT_BUSH_FLOOR,
    osm.COVER_SCRUB: SLOT_BUSH_FLOOR,
    osm.COVER_HEATH: SLOT_BUSH_FLOOR,
    osm.COVER_WETLAND: SLOT_WETLAND_MUD,
}

#: Every slot this module can emit, in the order the client's `MATERIALS` list
#: has them. Read by `tiles.py` and by `canopy-audit`, so a slot added above
#: cannot be forgotten by either.
GREEN_SLOTS = (SLOT_PARK_GRASS, SLOT_BUSH_FLOOR, SLOT_WETLAND_MUD)

#: The cover class as the number `far-cover.bin` packs into three bits, and the
#: **only** place the horizon's byte and this module's strings meet.
#:
#: `client/src/world/cover.ts` holds the same seven, in the same order, with the
#: colour each of them paints the far ground. Zero is "nothing growing here" and
#: is never written by a class -- it is what an empty cell is, and it is what the
#: apron ring round the heightfield gets.
COVER_CODE: dict[str, int] = {
    osm.COVER_MOWN: 1,
    osm.COVER_ROUGH: 2,
    osm.COVER_FOREST: 3,
    osm.COVER_SCRUB: 4,
    osm.COVER_HEATH: 5,
    osm.COVER_WETLAND: 6,
}

#: The resolution of the coverage fraction in the low five bits. Must match
#: `cover.ts`'s `COVER_STEPS`.
COVER_STEPS = 31

# One centimetre above the terrain. Under the carriageway's 0.02 and the
# footpath's 0.15, so that even where a subtraction leaves a sliver the paved
# surface is the one drawn. All three green slots take it: they are cut disjoint
# from each other before they are emitted, so there is no ordering between them
# to express and putting them at different heights would only invent one.
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

# --- Bushland -----------------------------------------------------------------
#
# Everything from here to `SELECT_MARGIN` is the fourth source. The header holds
# the argument; these are the numbers, and each one is stated with what it is
# short of rather than as though it were the ecology.

#: **No jacaranda and no plane anywhere below.** Both are exotics -- a jacaranda
#: is Brazilian and a plane is a European street tree -- and neither occurs in
#: Sydney bushland at all. Putting them there is spec 7.5's "reads American
#: instantly" with a different passport, and it is the one thing about these
#: mixes that would be visible to somebody who has actually walked in Garigal.
#:
#: Sandstone dry sclerophyll is *Eucalyptus*, *Corymbia* and *Angophora*, which
#: is one silhouette here; turpentine and blackbutt read as the denser vertical
#: oval the brush box is authored as; the gullies carry tea-tree and
#: paperbark; and the fig stands in for the occasional rainforest emergent in a
#: sheltered gully, which is a real and striking thing in the Lane Cove and
#: Berowra valleys.
#:
#: ---------------------------------------------------------------------------
#: **NINE STEMS IN TEN ARE `BUSH_TREE`, AND THAT IS THE ROUND'S CENTRAL TRADE.**
#:
#: A mix is the only channel the pipeline has for saying "draw this one cheaply",
#: so the level of detail lives in the species table rather than beside it. The
#: arithmetic is in the header and it is short: a 500 m tile is 25 ha, the draw
#: budget is 40,000 triangles, and a hundred canopy stems a hectare is 2,500
#: stems -- which is **16 triangles a stem**. There is no mesh at 96 triangles
#: that gets there and no budget that makes one affordable. `BUSH_TREE` is 14.
#:
#: The tenth that is not cheap is what stops a stand reading as a field of
#: sticks: it is picked by the same hash as everything else, so it is spread
#: evenly through the stand, and within fifty metres of a player standing in
#: Lane Cove about six of the sixty stems around them carry the full silhouette.
#:
#: **It is a stochastic level of detail and not a stratum**, which is the honest
#: description and is worth being plain about: the same stem draws cheap whether
#: it is four hundred metres away or four, because the pipeline does not know
#: where the camera will be and the client has no distance tier yet. That tier is
#: the impostor round the header names; when it lands, this mix collapses back to
#: the four real species and the detail becomes a function of distance, which is
#: what it should always have been.
FOREST_MIX: tuple[tuple[int, float], ...] = (
    (BUSH_TREE, 0.900),
    (EUCALYPT, 0.058),
    (BRUSH_BOX, 0.018),
    (PAPERBARK, 0.014),
    (FIG, 0.010),
)
#: What stands *over* a scrub: mallee-form gums and tea-tree, and not much else.
#: Same nine-in-ten, same reason.
SCRUB_TREE_MIX: tuple[tuple[int, float], ...] = (
    (BUSH_TREE, 0.90),
    (EUCALYPT, 0.06),
    (PAPERBARK, 0.04),
)
#: Paddock trees and golf-course plantings, and **the one mix with no cheap draw
#: in it**. A golf course's trees are figs and gums standing alone on mown grass
#: at eight to a hectare: they are read individually, there are few enough to
#: afford, and a cheap silhouette standing by itself on a fairway is a stick with
#: nothing around it to hide in.
ROUGH_MIX: tuple[tuple[int, float], ...] = ((EUCALYPT, 0.50), (BRUSH_BOX, 0.30), (FIG, 0.20))
#: Grey mangrove, and paperbark is the honest stand-in of the six: a dense low
#: crown on a pale trunk, which is what *Avicennia marina* looks like from a
#: boat. Exactly the substitution the palms already get, and named the same way
#: rather than pretended about.
WETLAND_MIX: tuple[tuple[int, float], ...] = ((BUSH_TREE, 0.90), (PAPERBARK, 0.10))

#: `cover -> (shrub area, tree area, tree mix)`. Square metres of that class'
#: ground per instance; `None` means the class does not carry that layer at all.
#:
#: Each row is set so a tile covered wall to wall by that one class lands **at**
#: `BUSH_TRIANGLE_BUDGET` rather than far over it. That is the opposite of
#: generating at the ecological density and thinning to fit: nine trees made to
#: keep one is nine times the build for the same picture.
#:
#: The figure beside each row is measured rather than predicted -- one 25 ha tile
#: of that class alone, through `instances`, counting the emitted stems and their
#: triangles after the cap.
BUSH_DENSITY: dict[str, tuple[float | None, float | None, tuple[tuple[int, float], ...]]] = {
    # 71 canopy stems a hectare, against an ecological 100-200 for the canopy
    # layer of Sydney coastal dry sclerophyll. At a 5.7 m mean crown radius that
    # is ~76% canopy cover: a forest with sky through it, which is what an open
    # forest is, rather than the 11 stems and 13% cover a full-mesh budget
    # bought. It was ~80% on a 6.0 m mean before the tree layer's size draw
    # became a reverse-J -- see `BUSH_T_TOP`, which spends those four points on
    # a stand that has seedlings and emergents in it instead of one age class.
    osm.COVER_FOREST: (None, 140.0, FOREST_MIX),
    # 62 shrubs and 4 gums a hectare. A real coastal scrub is nearer 800 shrubs,
    # so this is still the class the budget shortchanges hardest -- a scrub is
    # *all* stems and there is nothing else in it to spend on.
    osm.COVER_SCRUB: (160.0, 2600.0, SCRUB_TREE_MIX),
    # 65 shrubs a hectare and no trees at any density: a heath with a tree on it
    # is not a heath, which is the whole reason this class exists separately from
    # scrub. A real coastal heath is 1,000+ stems, but they are 40 cm apart and
    # the eye reads the mat rather than the stems.
    osm.COVER_HEATH: (155.0, None, ()),
    # 59 shrubs and 4 mangroves a hectare, nine tenths of it shrub. The one class
    # that is mostly shrub *because that is what it looks like* rather than
    # because a shrub is cheap: a mangrove stand is dense and low.
    osm.COVER_WETLAND: (170.0, 2600.0, WETLAND_MIX),
    # 5.9 trees a hectare, all of them full meshes, and the only row well under
    # budget on purpose. A golf course and a paddock are open ground with trees
    # standing in them, and filling them to the budget would be spending it to
    # make them wrong.
    osm.COVER_ROUGH: (None, 1700.0, ROUGH_MIX),
}

#: Where on its own size curve a bushland **shrub** is drawn from. `_size` runs
#: `t` over the whole 0-1 range, which is right for a park specimen and wrong for
#: a forest: a stand of gums is *mature* -- the small ones are the understorey
#: and are not what an instance with a crown represents. Biasing `t` into the
#: top two thirds costs nothing and takes canopy cover from ~8% to ~17% at the
#: same stem count, which is the cheapest thing in this round.
#:
#: **The tree layer no longer uses this**; see `BUSH_T_TOP` below for what
#: replaced it and why the shrub layer kept it.
BUSH_T_FLOOR = 0.35

#: The tree layer's draw, and the answer to *"the new tree models are very
#: homogenous"* (Riverside Drive, Chatswood West, 2026-08-24).
#:
#: ---------------------------------------------------------------------------
#: WHAT THE OLD DRAW ACTUALLY WAS, because it is worse than it reads.
#:
#: `t = BUSH_T_FLOOR + (1 - BUSH_T_FLOOR) * u` is **uniform on [0.35, 1.0]**, so
#: a bush tree came out uniformly between 14.8 m and 20.0 m. That is a 1.35:1
#: spread with no mode and no tail -- not a forest, a **plantation**: one age
#: class, planted the same year, and no amount of client-side yaw or colour can
#: make a thousand stems of one height read as a stand. Sydney sandstone dry
#: sclerophyll is the opposite. It burns, it regenerates in cohorts, it is
#: rock-shelf thin in one gully and deep-soil tall in the next, and its stem
#: diameters follow the reverse-J every unmanaged forest on earth follows: many
#: small, fewer medium, a handful of emergents over the canopy.
#:
#: So the draw is `t = BUSH_T_TOP * u ** BUSH_T_SKEW`. A power law is the whole
#: of it -- one multiply and one `**` in the hottest loop in the module -- and it
#: does three things a floor cannot:
#:
#:   * the mode moves to the bottom. Quartiles for a bush tree go from
#:     15.3 / 17.4 / 19.5 m to **13.3 / 16.0 / 19.4 m**, and the p90/p10 spread
#:     from 1.27 to 1.77. `vegetation-audit` now measures exactly that number.
#:   * the top opens past the species' own range, the way a *measured* specimen
#:     is already allowed to (see `MEASURED_T_MAX`, which is 1.6 and which this
#:     stays well inside). The tallest 3% of a stand are emergents at 23 m, and
#:     an emergent breaking a canopy's skyline is most of what says "forest"
#:     from outside it.
#:   * the floor drops to the species' own minimum, so seedlings and mature
#:     trees stand together. The header's argument for the floor -- that an
#:     instance with a crown is a canopy tree and not understorey -- survives
#:     that: 12 m is still a canopy tree. It is a *young* one.
#:
#: **What it costs**, stated because the floor was bought with canopy cover and
#: this gives some of it back. Cover is `stems x pi r^2` off the sidecar radius,
#: and `E[r^2]` goes from 36.6 m^2 to 34.0 -- so ~82% cover becomes **~76%** at
#: the same 71 stems a hectare and the same 40,000 triangles. Four points of
#: cover for an uneven-aged stand is the trade, and it is the right way round:
#: 82% cover of one repeated tree is what was reported as broken.
#:
#: The shrub layer is deliberately left on `BUSH_T_FLOOR`, and that is not
#: laziness. The reverse-J is an *age structure* argument and heath is even-aged
#: by fire; and `SPECIES_SIZE[SHRUB]` already swings +/-50% about its own
#: midpoint where a tree swings +/-25%, so the shrub layer's relative size
#: spread is 1.57 against the tree layer's old 1.27. It was never the flat one.
BUSH_T_TOP = 1.45
BUSH_T_SKEW = 1.55

#: The client's instance scale a bushland draw may not push past.
#:
#: The emergent tail is the reason this exists: `t > 1` puts an instance past
#: the top of its species' authored range, which is exactly what
#: `MEASURED_T_MAX` already allows a surveyed specimen, and past far enough the
#: geometry stops being the thing it was authored as. `vegetation-audit`'s
#: `--max-scale` is 1.60 and this is 1.55, leaving the margin `_size`'s spread
#: wobble wants underneath it.
#:
#: It binds on nothing in any bushland mix today -- every one of the five tree
#: species could carry `t = 1.5` -- and that is the point of deriving it rather
#: than tabling it. A species whose range is narrow against its own midpoint
#: reaches a given scale at a much lower `t`: the shrub hits 1.55x at t = 1.05
#: where the bush tree is still at 1.51, which is the same fact
#: `SIZE_WOBBLE`'s comment records from the other end. Adding one to a tree mix
#: cannot silently ship an instance past the audit.
BUSH_SCALE_MAX = 1.55

#: Trees and shrubs stand closer together in bush than specimens do in a park,
#: and `CLEAR_IN_PARK`'s 8 m would thin a forest by two thirds before the budget
#: ever saw it. These are minimum trunk separations, not crown separations --
#: crowns in a forest overlap, which is what a canopy is.
#:
#: The tree figure was 3.5 m and is **2.0**, and the reason is spacing rather
#: than density: `_bush_layer` confines each stem to the middle
#: `(cell - clear) / cell` of its own cell, so the separation *is* the jitter
#: budget. At a 11.8 m forest cell, 3.5 m let a stem move +/-4.15 m and the
#: lattice still read as a lattice from inside the stand; 2.0 m lets it move
#: +/-4.91 m, and two neighbours can now stand two metres apart or twenty-two.
#: Two metres of trunk separation is not a crowded forest, it is a forest.
#:
#: What this does **not** buy is clumping -- one stem per cell is still one stem
#: per cell, so the density is uniform where a real stand has thickets and rock
#: shelves. The fix for that is a lattice at half the cell area with a Bernoulli
#: keep, which is a genuine Poisson scatter at the same mean density and is
#: refused here for a measured reason: it doubles the `prepared.contains` calls,
#: which are the dominant cost of the whole source over six million cells.
CLEAR_IN_BUSH = 2.0
CLEAR_IN_SHRUB = 1.2

#: No stem within this of the polygon edge. Smaller than a park's 3 m because a
#: bushland boundary is a survey line through continuous vegetation rather than
#: a fence, and setting stems back from it draws a bare margin around every
#: reserve in the map.
BUSH_EDGE_SETBACK = 1.0

#: The per-tile draw budget for the bushland scatter, in **triangles of client
#: geometry**, which is the unit the cost is actually in.
#:
#: ---------------------------------------------------------------------------
#: THE WHOLE CBD FRAME, because half of it is the wrong number and this was
#: sized against the wrong number once already.
#:
#: The first cut of this constant was 28,000 -- `world/vegetation.ts`'s measured
#: 483,000 tree triangles over its 25 resident tiles. That figure is real and it
#: is not the frame: `world/cars.ts` measured the **same camera, same 1.8 km
#: radius, worst heading** and records the rest of it. Put together, the most
#: expensive frame the built world has is
#:
#:     parked cars      3,759 cars       398,000 triangles   (cars.ts)
#:     trees            5,914 trees      520,000             (cars.ts, same frame)
#:     buildings + streets                232,000            (vegetation.ts)
#:     traffic movers   ~210 cars          23,000            (cars.ts)
#:                                      -----------
#:                                      1,173,000 triangles, and it ships
#:
#: plus the pedestrians, the police, the street furniture, the power spans and
#: the nameplates, none of which is counted above -- so 1,173,000 is a floor.
#:
#: A bushland tile carries **none** of the first, third or fourth of those, and
#: its static mesh is ~2,800 triangles against an urban tile's 12,600 median. So
#: the budget is what makes a 25-tile bushland view cost what the 25-tile CBD
#: view already costs:
#:
#:     (1,173,000 - 25 * 2,800) / 25 = 44,100 triangles of canopy per tile
#:
#: and this is **40,000**, which lands the bushland frame at 1,070,000 -- 91% of
#: the CBD's, with the margin left where the shadow pass wants it. That pass is
#: the one place bushland is heavier than the city and the arithmetic should be
#: on the record: the sun's caster range is 440 m, which is about ten tiles, so
#: 400,000 triangles are drawn a second time into the depth map against the
#: CBD's measured 2,230 trees (~195,000) plus its buildings. Comparable, not
#: better. If it ever measures hot the lever is to stop `BUSH_TREE` casting --
#: nine stems in ten -- and whether a forest still reads with a tenth of its
#: shadows is a question for eyes and not for this file.
#:
#: Spent after the other three sources, and reduced by what they took -- a
#: suburban street on the edge of Ku-ring-gai has already paid for its street
#: trees and does not get to spend the same triangles twice.
BUSH_TRIANGLE_BUDGET = 40_000

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


def _bush_t_ceiling(species: int) -> float:
    """The highest `t` this species may be drawn at, from `BUSH_SCALE_MAX`.

    Derived rather than tabled, on this module's usual rule: the client's two
    instance scale factors are `height / nominalHeight` and
    `radius / nominalRadius`, both of them affine in `t`, so the largest `t`
    that keeps both under the cap is one solve per axis and the smaller of the
    two. A table would be a fifth per-species table to forget a row of.
    """
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    nom_h, nom_r = nominal_size(species)
    limits = []
    if h_hi > h_lo:
        limits.append((BUSH_SCALE_MAX * nom_h - h_lo) / (h_hi - h_lo))
    if s_hi > s_lo:
        limits.append((BUSH_SCALE_MAX * nom_r * 2.0 - s_lo) / (s_hi - s_lo))
    return min(limits) if limits else 1.0


def _size(
    species: int,
    h: int,
    street: bool,
    t_floor: float = 0.0,
    t_top: float = 0.0,
) -> tuple[float, float]:
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

    `t_floor` is the same argument from the other end and is what the bushland
    **shrub** layer uses. A stand is *mature*: the small stems in it are the
    understorey, and an instance with a crown does not represent one of those.
    Lifting the floor of the draw to `BUSH_T_FLOOR` costs nothing, keeps height
    and spread on the same `t`, and takes canopy cover from about 8% to 17% at
    the same stem count.

    `t_top` is the bushland **tree** layer's, and it replaced a floor with a
    reverse-J: `BUSH_T_TOP * u ** BUSH_T_SKEW`, clamped per species by
    `_bush_t_ceiling`. `BUSH_T_TOP`'s comment is the whole argument and the
    measured before-and-after. The three knobs are mutually exclusive and
    nothing asks for two.

    The spread clamp is `max(1.0, t)` rather than `1.0`, and the change is
    exact rather than cosmetic: for every `t <= 1` -- which is every draw this
    module made before the emergent tail existed -- `max(1.0, t)` **is** the
    float 1.0, so no instance in the shipped city moves by a bit. Above 1 it is
    what keeps the emergents' spread following their height instead of pinning
    at `s_hi` and pulling the two scale factors apart, which is the one
    distortion `vegetation-audit` was built to convict.
    """
    h_lo, h_hi, s_lo, s_hi = SPECIES_SIZE[species]
    t = _unit(h, 1)
    if street:
        t *= 0.7
    elif t_top > 0.0:
        t = min(t_top, _bush_t_ceiling(species)) * t**BUSH_T_SKEW
    elif t_floor > 0.0:
        t = t_floor + (1.0 - t_floor) * t
    wobble = (_unit(h, 2) - 0.5) * 0.25 * SIZE_WOBBLE.get(species, 1.0)
    height = h_lo + (h_hi - h_lo) * t
    spread = s_lo + (s_hi - s_lo) * min(max(t + wobble, 0.0), max(1.0, t))
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
    for sp in MEASURABLE_SPECIES:
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

        # The rank index. `sources.osm.GREEN_COVER` settles an overlap *within*
        # one polygon's tags; this is what settles it between polygons, and both
        # halves have to exist or Lane Cove's picnic lawn grows a forest because
        # the national park's own outline also covers it.
        #
        # Held as a rank per polygon plus the sorted set of distinct ranks, so
        # the surface pass can walk them best-first and the scatter can ask
        # "is there anything better than me standing on this point" in one
        # STRtree query and a comparison.
        self._green_rank = np.asarray([g.rank for g in greens], dtype=np.int32)
        self._ranks = sorted({int(r) for r in self._green_rank})

        # Which polygons can actually lose a point to a better-ranked neighbour.
        #
        # `_better_rank_at` is an STRtree query and a `contains` per candidate
        # stem, and over the whole world the scatter makes about six million of
        # them -- two minutes of build spent, for the overwhelming majority of
        # polygons, proving that nothing overlaps a stand of wood in the middle
        # of Ku-ring-gai. One bounds query per *polygon* answers that once: if
        # no better-ranked polygon's box even touches this one's, no point
        # inside it can be inside a better-ranked polygon, and the whole
        # polygon's scatter skips the test.
        #
        # Conservative in the safe direction -- a box overlap that is not a
        # polygon overlap only costs the test being run -- and it is exact
        # against the thing it is deciding, which is whether the test can be
        # skipped rather than what its answer would be.
        self._rank_contested = np.zeros(len(greens), dtype=bool)
        if self._green_tree is not None:
            for i, g in enumerate(greens):
                for j in self._green_tree.query(self._green_polys[i]):
                    if self._green_rank[int(j)] < g.rank:
                        self._rank_contested[i] = True
                        break

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
        self._bush_cache: dict[tuple[int, int, int], list[Tree]] = {}
        self._bush_cached_stems = 0

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

        A superset, on the same argument `streets.tile_keys` makes: a tile
        emitted and found empty costs one pass, and a tile wrongly omitted is a
        park that is not in the world and nothing in the output says so. This is
        what makes a park-only tile -- no buildings, no streets, just grass --
        get emitted at all.

        **From the polygon rather than from its bounds**, which mattered not at
        all before the bushland round and matters enormously now. The green set
        used to be parks: a few hundred metres across, and their bounding boxes
        were a tile or two wider than they were. It now holds
        `boundary=protected_area` relations whose parts span the Blue Mountains
        foothills -- one of them has a 40 km bounding box, which is 6,400 tiles,
        of which the polygon itself touches a few hundred. Taking the box would
        emit thousands of empty tiles per park, and an empty tile is not one pass
        any more: it is a file on disk, a row in the index and a request the
        client will make.

        A prepared intersection test over the boxes the bounds name is the exact
        answer and costs about 20 us a tile, so the worst polygon in the extent
        pays a tenth of a second for it.
        """
        from shapely import prepared

        s = config.TILE_SIZE
        out: set[str] = set()

        def add_bounds(e0: float, n0: float, e1: float, n1: float) -> None:
            for tx in range(math.floor(e0 / s), math.floor(e1 / s) + 1):
                for tz in range(math.floor(n0 / s), math.floor(n1 / s) + 1):
                    out.add(f"{tx}_{tz}")

        for poly in self._green_polys:
            e0, n0, e1, n1 = poly.bounds
            tx0, tx1 = math.floor(e0 / s), math.floor(e1 / s)
            tz0, tz1 = math.floor(n0 / s), math.floor(n1 / s)
            # Small polygons -- which is almost all of them -- skip the prepared
            # geometry entirely: over a 2x2 block of tiles the test costs more
            # than the tiles it could save.
            if (tx1 - tx0 + 1) * (tz1 - tz0 + 1) <= 4:
                add_bounds(e0, n0, e1, n1)
                continue
            hit = prepared.prep(poly)
            for tx in range(tx0, tx1 + 1):
                for tz in range(tz0, tz1 + 1):
                    key = f"{tx}_{tz}"
                    if key in out:
                        continue
                    if hit.intersects(box(tx * s, tz * s, (tx + 1) * s, (tz + 1) * s)):
                        out.add(key)
        for t in self._mapped:
            add_bounds(t.east, t.north, t.east, t.north)
        return out

    # --- The park surface ----------------------------------------------------

    def surface(self, tile_key: str) -> BaseGeometry:
        """One tile's mown-grass polygon: green, minus buildings, minus the road.

        Kept as the `park_grass` view of `surfaces` below, because three callers
        outside this module ask "is this point in the grass" and none of them
        wants a dict.
        """
        return self.surfaces(tile_key).get(SLOT_PARK_GRASS, Polygon())

    def surfaces(self, tile_key: str) -> dict[str, BaseGeometry]:
        """One tile's green ground, per material slot, and **disjoint**.

        The three slots cannot overlap and the reason is not tidiness: they all
        sit at `PARK_GRASS_Y`, so two of them over the same square metre is
        z-fighting between two ground materials at a centimetre of separation,
        which is the single most visible artefact a flat surface can produce.
        And they *would* overlap constantly -- Lane Cove National Park is one
        `boundary=protected_area`, one `leisure=nature_reserve` and a dozen
        `natural=wood` parts, with mown picnic lawns, a mangrove reach and heath
        ridges drawn inside all three.

        So the classes are taken **best rank first** (`sources.osm.GREEN_COVER`
        for the order and the argument) and each one is cut against the union of
        everything better than it. The mown lawn keeps its ground, the forest
        gets what the lawn did not take, and the administrative outline gets
        whatever nobody made a stronger claim on. One pass and no
        iteration-order dependence: rank decides everything and rank is a
        property of the tags.

        ---------------------------------------------------------------------
        **CLIPPED FIRST, WHICH IS NOT WHAT `streets.py` DOES**, and the
        difference is worth stating because the rule it appears to break is one
        this module quotes elsewhere.

        `streets.py` clips last because its geometry is built by *buffering*, and
        a buffer is not a local operation -- the result near a seam depends on
        the way's shape metres away, so both neighbours must build from the same
        unclipped source and cut afterwards. Every operation here is an
        intersection or a difference, and both of those **are** local:
        `(A - B) & X == (A & X) - (B & X)` exactly, for any X, with no
        tolerance in it. So clipping the source polygons to the tile before the
        subtractions gives byte-identical geometry along a seam and the two
        neighbours still butt exactly.

        It has to be that way round now. Before the bushland round the green set
        was parks, and the largest of them was smaller than a tile. It now holds
        a 550 km2 `natural=wood` part, and `buildings_near` asked about that
        polygon unclipped returns every building in the northern half of Sydney
        -- for a tile that wanted a hectare of forest floor.
        """
        if self._green_tree is None:
            return {}
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)

        hits = self._green_tree.query(tile_box)
        if len(hits) == 0:
            return {}

        # Clipped here, grouped by rank, and everything after this is tile-sized.
        # Rank decides the cover class outright -- `sources.osm` asserts that at
        # import -- so grouping by rank is grouping by class.
        by_rank: dict[int, list[BaseGeometry]] = {}
        cover_of_rank: dict[int, str] = {}
        for i in hits:
            g = self._greens[int(i)]
            part = self._green_polys[int(i)].intersection(tile_box)
            if part.is_empty:
                continue
            by_rank.setdefault(g.rank, []).append(part)
            cover_of_rank[g.rank] = g.cover
        if not by_rank:
            return {}

        # Buildings and paving come out once, of the whole green, rather than
        # once per slot: park kiosks, grandstands and the occasional apartment
        # tower on a site tagged `landuse=grass` sit inside these polygons, and
        # Art Gallery Road runs straight through the Domain. The carriageway is
        # one centimetre above this surface, which is far too little to survive
        # depth quantisation at any distance; the kerb goes with it because it is
        # the same computation and it removes the sliver along the edge.
        surf = self._streets.surfaces(tile_key)
        cut: list[BaseGeometry] = [g for g in (surf.carriageway, surf.kerb) if not g.is_empty]

        out: dict[str, BaseGeometry] = {}
        taken: BaseGeometry | None = None
        for rank in sorted(by_rank):
            layer = unary_union(by_rank[rank])
            if taken is not None and not layer.is_empty:
                layer = layer.difference(taken)
            taken = layer if taken is None else unary_union([taken, layer])
            if layer.is_empty:
                continue
            obstacles = self._streets.buildings_near(layer)
            if obstacles:
                layer = layer.difference(unary_union(obstacles))
            if cut and not layer.is_empty:
                layer = layer.difference(unary_union(cut))
            # A second clip, and it is a backstop rather than the clip. The
            # source polygons were cut to the tile before any of this and every
            # operation since has been a difference, which cannot grow a
            # geometry, so this can only ever be a no-op -- and it costs one
            # intersection against a rectangle to guarantee that rather than
            # assume it.
            layer = streets._clip(layer, tile_box)
            if layer.is_empty:
                continue
            slot = COVER_SLOT[cover_of_rank[rank]]
            prev = out.get(slot)
            out[slot] = layer if prev is None else unary_union([prev, layer])
        return out

    def emit_surface(
        self,
        tile_key: str,
        slots: dict[str, mesh.MeshBuffers],
        origin: tuple[float, float],
        terrain=None,
    ) -> None:
        """Tessellate the tile's green into its material slots, draped on `terrain`."""
        for slot, geom in self.surfaces(tile_key).items():
            if geom.is_empty:
                continue
            # Belongs to no building and reads no facade parameters, exactly like
            # the street slots -- so it leaves `_BLDIDX` off the primitive
            # entirely.
            slots[slot].building_indexed = False
            # Draped through the same call the roads go through, which is the
            # point of that being one function: the grass and the carriageway cut
            # out of it are densified by the same rule and sampled at the same
            # points, so they cannot part company along the boundary they share.
            streets._emit_flat(slots[slot], geom, PARK_GRASS_Y, origin, terrain)

    # --- Instances -----------------------------------------------------------

    def _candidates_near(
        self, region: BaseGeometry
    ) -> tuple[list[Tree], list[Tree], list[Tree], list[Tree]]:
        """Every candidate from the four sources whose position falls near
        `region`, kept apart by source and before any per-tile filtering."""
        mapped = self._mapped_in(region)
        street: list[Tree] = []
        for i in self._streets.ways_near(region):
            street.extend(self._street_trees(i))
        park: list[Tree] = []
        bush: list[Tree] = []
        if self._green_tree is not None:
            for i in self._green_tree.query(region):
                i = int(i)
                if self._greens[i].cover == osm.COVER_MOWN:
                    park.extend(self._park_trees(i))
                else:
                    bush.extend(self._bush_trees_in(i, region))
        return mapped, street, park, bush

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
        mapped, street, park, bush = self._candidates_near(region)
        return mapped + street + park + bush

    def instances(self, tile_key: str) -> list[Tree]:
        """Every tree standing inside one tile, from all three sources."""
        e0, n0, e1, n1 = streets._tile_bounds(tile_key)
        tile_box = box(e0, n0, e1, n1)
        margin = tile_box.buffer(SELECT_MARGIN)

        def inside(t: Tree) -> bool:
            # Half-open on the upper edge so a tree exactly on a tile line lands
            # in one tile and not in both.
            return e0 <= t.east < e1 and n0 <= t.north < n1

        all_mapped, all_street, all_park, all_bush = self._candidates_near(margin)
        mapped = [t for t in all_mapped if inside(t)]
        street = [t for t in all_street if inside(t)]
        park = [t for t in all_park if inside(t)]
        bush = [t for t in all_bush if inside(t)]

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
            # And the bushland scatter, on the same argument and rather more
            # often: the Pacific Highway, McCarrs Creek Road and the Royal's own
            # Lady Wakehurst Drive all run through polygons tagged as continuous
            # forest, and OSM does not cut the wood out around them.
            bush = [t for t in bush if not road.contains(Point(t.east, t.north))]

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
            bush = [t for t in bush if clear(t)]

        return self._cap(mapped, street, park, bush)

    @staticmethod
    def _cap(
        mapped: list[Tree], street: list[Tree], park: list[Tree], bush: list[Tree]
    ) -> list[Tree]:
        """Hold a tile inside its two budgets, cheapest source first.

        Order is the point. Mapped trees are surveyed and are never dropped.
        Street trees are the ones the city is read by at eye level. Park scatter
        is the one source whose density is a guess in the first place, so it is
        the one that gives -- and it gives by hashed rank rather than by list
        order, so thinning a tile removes an even spread rather than one corner
        of the park.

        **Two budgets and not one**, and they are in different units on purpose.

        `MAX_TREES_PER_TILE` is a *count*, and it is left exactly as it was over
        exactly the three sources it always covered, so no tile in the shipped
        city moves by a single instance because of this round.

        `BUSH_TRIANGLE_BUDGET` is *triangles*, over the fourth source, because
        that is the unit bushland actually costs in and a count is wrong by a
        factor of seven across the species it plants: a heath tile is a thousand
        24-triangle shrubs and a forest tile is three hundred 100-triangle gums,
        and the two cost the same frame. The count cap would price them at 4:1
        and either starve the heath or blow the forest.

        The bushland budget is reduced by what the first three already spent, in
        the same unit, so a suburban street on the edge of Ku-ring-gai does not
        get to draw its street trees and then a forest on top of them for free.
        Thinning is by hashed rank again, and it is done over the **whole**
        bushland list rather than per species, so a thinned scrub keeps its
        proportion of gums to shrubs instead of losing one layer entirely.
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

        if not bush:
            return out
        spent = sum(SPECIES_TRIANGLES[t.species] for t in out)
        left = BUSH_TRIANGLE_BUDGET - spent
        if left <= 0:
            return out
        kept: list[Tree] = []
        for t in sorted(bush, key=lambda t: t.seed):
            cost = SPECIES_TRIANGLES[t.species]
            if cost > left:
                # Not `break`: a shrub still fits where the gum that came next in
                # hash order does not, and stopping at the first refusal would
                # make the tail of the budget depend on the species order of one
                # hash rather than on the budget.
                continue
            left -= cost
            kept.append(t)
        return out + kept

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
        # Mown only. Everything else goes to the fourth source, which has its own
        # densities, its own species and its own idea of how far apart two stems
        # stand -- and the guard is here as well as at the call site because this
        # is the method whose constants say "a park is not a forest".
        if not green.plantable or green.cover != osm.COVER_MOWN:
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

    # --- Source (d): bushland scatter -----------------------------------------
    #
    # THE ONE THING THIS SOURCE DOES DIFFERENTLY FROM THE OTHER THREE, and it is
    # forced by the size of what it plants over.
    #
    # A street is a hundred metres and a park is a hectare, so both are generated
    # whole and cached whole. A bushland polygon is not: the largest single
    # `natural=wood` part in the extract is **550 km2 with a 27 x 44 km bounding
    # box**, which is 1.45 million lattice cells and, at this round's density,
    # 690,000 stems. Holding that in a cache the moment any tile in the northern
    # half of the map asks about Ku-ring-gai is hundreds of megabytes for a tile
    # that wanted four hundred trees.
    #
    # So the lattice is generated and cached **per 500 m block**, aligned to the
    # tile grid. Every stem is still a pure function of `(polygon id, layer,
    # lattice cell)` and of nothing else -- no block boundary appears in any
    # position, any species pick or any size draw -- so the output is exactly
    # what generating the polygon whole would produce, and two tiles sharing a
    # stand still agree on every stem in it. Only the *bookkeeping* is blocked.
    #
    # That is only true because the mutual-separation test is gone, and it is
    # gone because it was replaced by something better: see `_bush_layer`.

    #: The generation and cache unit, metres. The tile size, so a tile's own
    #: query is nine blocks and its neighbour's query reuses eight of them.
    _BLOCK = config.TILE_SIZE
    #: Stems held in the block cache before it is dropped whole.
    #:
    #: A bound in **instances rather than in entries**, because the entries are
    #: not the same size: a block of Ku-ring-gai forest is 312 stems and a block
    #: of coastal heath is 1,900, so a cap of N blocks bounds memory at whatever
    #: the densest class happens to be times N and would have to be set for the
    #: worst case everywhere. 300,000 stems is about 40 MB of `Tree`, which is
    #: nothing beside the build's peak, and it holds several tiles' worth of
    #: neighbourhood at any density.
    #:
    #: Dropped whole rather than evicted by age. An LRU over a cache this cheap
    #: to refill is bookkeeping for its own sake, and the build walks tiles in a
    #: spatially coherent order, so a drop costs the eight neighbours of wherever
    #: it happens and nothing else.
    _CACHE_STEMS = 300_000

    def _bush_trees_in(self, i: int, region: BaseGeometry) -> list[Tree]:
        """Every stem polygon `i` puts inside the blocks `region` touches."""
        green = self._greens[i]
        if green.cover == osm.COVER_MOWN:
            return []
        e0, n0, e1, n1 = region.bounds
        pe0, pn0, pe1, pn1 = green.polygon.bounds
        s = self._BLOCK
        bx0 = math.floor(max(e0, pe0) / s)
        bx1 = math.floor(min(e1, pe1) / s)
        bz0 = math.floor(max(n0, pn0) / s)
        bz1 = math.floor(min(n1, pn1) / s)
        out: list[Tree] = []
        for bx in range(bx0, bx1 + 1):
            for bz in range(bz0, bz1 + 1):
                out.extend(self._bush_block(i, bx, bz))
        return out

    def _bush_block(self, i: int, bx: int, bz: int) -> list[Tree]:
        key = (i, bx, bz)
        cached = self._bush_cache.get(key)
        if cached is not None:
            return cached
        if self._bush_cached_stems >= self._CACHE_STEMS:
            self._bush_cache.clear()
            self._bush_cached_stems = 0
        out = self._build_bush_block(i, bx, bz)
        self._bush_cache[key] = out
        self._bush_cached_stems += len(out)
        return out

    def _build_bush_block(self, i: int, bx: int, bz: int) -> list[Tree]:
        """Every stem one bushland polygon puts in one 500 m block.

        Two layers rather than one -- a shrub layer and a tree layer, either of
        which a class may decline -- because that is the difference between the
        classes. A heath is a shrub layer with no trees; a forest is a tree layer
        whose understorey the budget cannot afford; a scrub and a mangrove reach
        are both. Each layer is its own lattice with its own spacing, so the two
        do not have to agree about where a cell is and a gum does not land on top
        of a shrub because they share a grid.
        """
        green = self._greens[i]
        shrub_area, tree_area, tree_mix = BUSH_DENSITY.get(green.cover, (None, None, ()))
        if shrub_area is None and tree_area is None:
            return []

        s = self._BLOCK
        block = box(bx * s, bz * s, (bx + 1) * s, (bz + 1) * s)
        # A metre in from the boundary, which is a survey line through continuous
        # vegetation rather than a fence -- see `BUSH_EDGE_SETBACK`.
        #
        # **Clipped, eroded, clipped again**, and the outer clip is half a metre
        # wider than the erode. Eroding the whole polygon first is the obvious
        # order and is the one that has to be avoided: `buffer(-1)` on the 550
        # km2 `natural=wood` part is a hundred milliseconds of geometry, it would
        # be paid once per block, and that polygon covers 2,200 blocks -- four
        # minutes for one stand. Eroding the block-clipped piece instead is
        # cheap and gives the *same* answer, because a negative buffer only
        # reaches `BUSH_EDGE_SETBACK`: for any point in the block, the nearest
        # boundary within that reach is inside the widened clip too, so the clip
        # cannot invent an edge the erode then sets back from. The extra half
        # metre is the margin that makes "cannot" exact rather than marginal.
        wide = block.buffer(BUSH_EDGE_SETBACK + 0.5)
        region = green.polygon.intersection(wide)
        if region.is_empty:
            return []
        region = region.buffer(-BUSH_EDGE_SETBACK).intersection(block)
        if region.is_empty:
            return []

        poly_id = _osm_int(green.osm_id)
        contested = bool(self._rank_contested[i])
        out: list[Tree] = []
        if shrub_area is not None:
            out += self._bush_layer(
                green, region, poly_id, shrub_area, ((SHRUB, 1.0),), CLEAR_IN_SHRUB, 0, contested
            )
        if tree_area is not None and tree_mix:
            out += self._bush_layer(
                green, region, poly_id, tree_area, tree_mix, CLEAR_IN_BUSH, 1, contested
            )
        return out

    def _bush_layer(
        self,
        green: osm.OsmGreen,
        region: BaseGeometry,
        poly_id: int,
        area_per: float,
        mix: tuple[tuple[int, float], ...],
        clear: float,
        layer: int,
        contested: bool,
    ) -> list[Tree]:
        """One jittered lattice of one layer, over one polygon, in one block.

        **The jitter is bounded rather than the neighbours being tested**, and
        that is what makes the whole source blockable. `_build_park_trees` keeps
        a list of what it has placed and rejects anything within `CLEAR_IN_PARK`
        of it, which is O(n^2) in the polygon's stem count and -- worse here --
        depends on the order the cells were walked in, so it would give different
        answers either side of a block boundary.

        Confining each stem to the middle `(cell - clear) / cell` of its own cell
        gives the *same* guarantee analytically: two points in adjacent cells are
        at least `clear` apart by construction, whatever order they were made in
        and whatever else has been placed. It costs one multiply, it is exact
        rather than greedy, and at a 28 m forest cell against a 3.5 m separation
        the stem still moves +/-12 m inside its cell, which is as free as the
        full-cell jitter it replaces.
        """
        cell = math.sqrt(area_per)
        # Half-amplitude as a fraction of the cell. Clamped under a half so a
        # class whose separation exceeded its own spacing degrades to a regular
        # lattice rather than to a negative jitter.
        jf = min(max((cell - clear) / (2.0 * cell), 0.0), 0.5)
        e0, n0, e1, n1 = region.bounds

        from shapely import prepared

        inside = prepared.prep(region)
        placed: list[Tree] = []
        for gx in range(int(math.floor(e0 / cell)), int(math.floor(e1 / cell)) + 1):
            for gz in range(int(math.floor(n0 / cell)), int(math.floor(n1 / cell)) + 1):
                h = _hash(poly_id, layer, gx, gz)
                east = (gx + 0.5 + (_unit(h, 6) - 0.5) * 2.0 * jf) * cell
                north = (gz + 0.5 + (_unit(h, 7) - 0.5) * 2.0 * jf) * cell
                p = Point(east, north)
                if not inside.contains(p):
                    continue
                # The spatial half of the cover rule. A point inside a
                # better-ranked green polygon belongs to that polygon's class and
                # not to this one -- so the mown picnic lawn, the oval and the
                # mangrove reach drawn inside a national park's outline do not
                # each grow a forest on top of whatever they already grow. See
                # `sources.osm.GREEN_COVER` for the ranking and `surfaces` for
                # the same rule applied to the ground.
                if contested and self._better_rank_at(east, north, green.rank):
                    continue
                # Never crowd a surveyed tree with an invented one, exactly as
                # the park scatter does not. `natural=tree` nodes are thin on the
                # ground out here, so this almost never fires -- but where a
                # reserve *is* surveyed, doubling it would be the same defect
                # `_way_is_mapped` exists to prevent on a street.
                # A box rather than `p.buffer(clear)`, and the two are the same
                # query: `STRtree.query` matches on bounding boxes, and a
                # circle's box is this box. It is the identical candidate set for
                # a tenth of the cost -- there are six million of these over the
                # world and a buffer discretises an arc to make a rectangle out
                # of it.
                near = box(east - clear, north - clear, east + clear, north + clear)
                if self._mapped_tree is not None:
                    if len(self._mapped_tree.query(near)) > 0:
                        continue
                wide = box(
                    east - CLEAR_OF_BUILDING, north - CLEAR_OF_BUILDING,
                    east + CLEAR_OF_BUILDING, north + CLEAR_OF_BUILDING,
                )
                if any(
                    q.distance(p) < CLEAR_OF_BUILDING
                    for q in self._streets.buildings_near(wide)
                ):
                    continue
                species = _pick(mix, _unit(h, 8))
                # The two layers draw their sizes differently and the split is
                # `BUSH_T_TOP`'s comment: a tree layer is uneven-aged and gets
                # the reverse-J with its emergent tail, a shrub layer is
                # even-aged by fire and keeps the floor it always had.
                if layer == 0:
                    height, radius = _size(species, h, street=False, t_floor=BUSH_T_FLOOR)
                else:
                    height, radius = _size(species, h, street=False, t_top=BUSH_T_TOP)
                placed.append(Tree(east, north, height, radius, species, h & 0xFF, "bush"))
        return placed

    def _better_rank_at(self, east: float, north: float, rank: int) -> bool:
        """Does a green polygon with a stronger claim cover this point?"""
        if self._green_tree is None:
            return False
        p = Point(east, north)
        for j in self._green_tree.query(p):
            j = int(j)
            if self._green_rank[j] < rank and self._green_polys[j].contains(p):
                return True
        return False

    # --- Context --------------------------------------------------------------

    def _is_cbd(self, geom: BaseGeometry) -> bool:
        c = geom.centroid
        return c.x * c.x + c.y * c.y <= CBD_RADIUS * CBD_RADIUS

    def _in_plantable_green(self, east: float, north: float) -> bool:
        return self._cover_at(east, north) is not None

    def _cover_at(self, east: float, north: float) -> str | None:
        """The winning cover class over a point, or `None` if it is not green.

        Best rank wins, which is the same rule `surfaces` paints the ground by
        and the same rule the scatter refuses a stem by -- stated once as a
        query so a surveyed tree standing on a picnic lawn inside a national
        park is a park specimen and not a forest gum.
        """
        if self._green_tree is None:
            return None
        p = Point(east, north)
        best: tuple[int, str] | None = None
        for i in self._green_tree.query(p):
            i = int(i)
            g = self._greens[i]
            if not g.plantable or not self._green_polys[i].contains(p):
                continue
            if best is None or g.rank < best[0]:
                best = (g.rank, g.cover)
        return None if best is None else best[1]

    def _context_species(self, east: float, north: float, h: int) -> int:
        """What a tree of unstated species is, from where it stands.

        The order is a claim about Sydney and not just a fallback chain: a tree
        inside a park is a specimen tree, a tree in the CBD is a plane because
        the council planted plane trees there for a century, and a tree anywhere
        else in the inner suburbs is one of the three the nurseries sold.

        A tree inside *bushland* now takes that class' own mix instead, which
        matters for the few thousand surveyed nodes in the reserves: a
        `natural=tree` in Ku-ring-gai with no taxon on it is an angophora, and
        `PARK_MIX` would have made it a jacaranda three times in ten.
        """
        cover = self._cover_at(east, north)
        if cover == osm.COVER_MOWN:
            return _pick(PARK_MIX, _unit(h, 9))
        if cover is not None:
            _shrub, _tree, mix = BUSH_DENSITY.get(cover, (None, None, ()))
            # A heath has no tree mix at all, and a surveyed tree standing on one
            # is a real tree standing on a heath. The scrub mix is the nearest
            # honest answer for it: a mallee gum or a tea-tree.
            return _pick(mix or SCRUB_TREE_MIX, _unit(h, 9))
        if east * east + north * north <= CBD_RADIUS * CBD_RADIUS:
            return PLANE
        return _pick(STREET_MIX, _unit(h, 10))
