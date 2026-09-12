"""Structures that do not start at the ground: bridges, and the blobs that ate them.

THE BUG THIS MODULE EXISTS FOR. Every footprint in the build was extruded from
the terrain pad to its roof, because that is what a building is and nothing in
the pipeline had ever been told otherwise. `min_height` and `building:min_level`
-- OSM's two ways of saying "the underside of this thing is in the air" --
appeared zero times in the whole project, and neither did any test for whether a
footprint was lying across a road.

The visible result was a wall. A pedestrian overbridge at Spit Junction came out
as 6 m of solid warehouse across both carriageways of Military Road; the
footbridge over Longueville Road at Lane Cove came out as a 3 m brick box across
a primary road. Neither is a rendering artefact the player can shrug at -- they
are the road being closed, in a game whose whole verb is running down roads.

---------------------------------------------------------------------------
**Where the offending polygons actually come from, which was the surprise.**

Not from OSM's bridge tagging. The extract has 14 `building=bridge` polygons, 1
building with `bridge=yes` and 44 `man_made=bridge` areas, and *none of them* is
at either place the user reported. The polygons walling those two roads are
**Microsoft ML footprints**, which carry no tags at all:

  * `m696b26492b53328c` -- 268 m^2, Lane Cove. Its plan is the deck of OSM way
    22917347 (`highway=footway`, `bridge=yes`, `layer=1`), and 23 m of
    Longueville Road's centreline runs through it. Microsoft's segmentation saw
    a flat roof-shaped surface over the road and called it a building.
  * `m98a07f15dfdfbcbf` -- 3,838 m^2, Mosman. The Bridgepoint/Mosman Junction
    retail block *plus* the pedestrian span over Military Road, swallowed into
    one blob, lying 3 m from OSM ways 171360583 and 1507639952 (both
    `highway=footway`, `bridge=yes`, `layer=1`). 22 m of Military Road's two
    carriageway centrelines run through it.

So a tag-driven fix alone would have shipped and changed nothing at either
place. The rule has to be geometric as well, and the geometry has to be
corroborated, because "a road centreline runs through this polygon" is true of
1,650 of the 470,457 footprints in the ledger and the overwhelming majority of
those are a car-park ramp or a service driveway drawn through a real building --
Westfield Burwood, Macquarie Centre, the airport terminals. Carving a slot
through those would be a far worse bug than the one being fixed.

---------------------------------------------------------------------------
**The rule, stated once.**

A footprint is *over-road* when a **public** ground carriageway's centreline
runs through its interior for `SPAN_MIN_M` or more. Public is deliberately
`osm.STREET_CLASSES` minus `service`: a service way is the driveway, the loading
dock and the car-park aisle, and a building standing over one is the normal
case rather than the broken one.

A footprint is *bridge-corroborated* when OSM says a bridge is there:

  1. the polygon itself claims it -- `building=bridge`, `bridge=yes|viaduct|
     aqueduct|boardwalk`, or `man_made=bridge`; or
  2. the polygon carries `layer >= 1`; or
  3. the polygon lies within `BRIDGE_WAY_REACH_M` of an OSM **way** tagged
     `bridge` at `layer >= 1` -- which is the clause that catches the untagged
     Microsoft blobs, and it is evidence rather than inference: OSM has mapped a
     bridge, and this polygon is sitting on it.

Then, in order:

  * **Stated base.** `min_height`, or `building:min_level` times the storey
    height. Applied unconditionally -- no road test, no corroboration -- because
    it is not a guess, it is the mapper telling us. 7 buildings in the extract
    state `min_height` and 11 state `building:min_level`.
  * **Declared bridge** with no stated base: raised to a derived soffit.
  * **Over-road and corroborated**, no stated base, not declared: the polygon is
    either the crossing itself or a building with a crossing attached, and the
    two are told apart by cutting the road corridor out and looking at what is
    left. Under `BRIDGE_PLAN_SHARE` of the plan surviving, the polygon *is* the
    bridge and is raised whole; over it, the polygon is a building with an arm
    over the road, and the arm is cut off while the building stays on the
    ground. Westfield Chatswood over Anderson Street and Westfield Hurstville
    over Park Road are the second case and are exactly right to keep.
  * **Everything else** is grounded and untouched. In particular a building
    tagged `layer=1` that spans no road stays on the ground: `layer` is a
    drawing-order hint that suburban mappers put on carports and pergolas by the
    thousand, and on its own it means nothing about elevation. 2,748 buildings
    in the extract carry it.

**And what happens when it cannot be raised**, which is the case the two
reported spots actually are. A structure whose own roof is below the soffit its
underside would have to be has no honest prism in it, and the repair ladder at
the end of `_decide` takes three steps in order of how much it destroys:

  1. **cut** the road corridor out and keep the largest piece on the ground;
  2. **drop** it, but only where OSM has mapped a bridge here *and* the polygon
     is the crossing rather than a building with one attached;
  3. **leave it alone**, grounded and named in the report.

Both reported spots land on a different rung and both are right. The Mosman
blob keeps 89% of its plan once Military Road is taken out of it, so it is cut
and the retail block stays; the Lane Cove blob keeps 39% and its entire stated
height is 2.98 m, which cannot be a footbridge over a primary road, so it is
dropped. **A missing footbridge is invisible; a wall across Longueville Road is
the bug.** Dropping there is also what the rest of the pipeline already does
with footbridges -- `decks._is_deck` excludes `is_foot` ways on purpose, so the
pipeline has *already* decided a 2 m footbridge is not worth drawing, and this
agrees with it rather than inventing a second policy.

Step 2's second condition is what stops the ladder eating real buildings. On
this rule's first run over the extract it was about to delete a 42 m^2 building
named `Gatehouse` at Hunters Hill and a `building=corridor` at Killara, both
tagged `layer=1` by a mapper, both straddling a driveway, and neither with a
bridge mapped within a hundred metres. **A deletion needs OSM to have mapped a
bridge; `layer` alone may move a structure but never remove one.**

---------------------------------------------------------------------------
**What a raised prism must then not be given.** A base above the ground makes
several of the per-building dressing passes nonsense at once -- a contact shadow
where the wall meets a footpath it does not touch, a footpath awning 5 m up, a
front door onto thin air, a front fence around a bridge. Those exclusions are
applied at the one place that already loops over buildings with their bases in
hand, `tiles.build_tile`, and are listed there.

**What this module does not touch: road decks.** `decks.py` owns every way
tagged `bridge`, solves its profile against the conformed ground and emits it
with a girder, parapets and piers. Nothing here changes that, and the overlap is
deliberate in one direction only: where an ML blob has duplicated a deck
`decks.py` already builds, dropping the blob removes a duplicate rather than a
structure.

---------------------------------------------------------------------------
**THE OTHER HALF OF THE SAME SENTENCE: A BUILDING UNDER A DECK IS NO TALLER THAN
THE DECK'S SOFFIT.**

`server/clash-check.ts`' note on `BUDGET_DECK_IN_BUILDING` had been saying this
for two rounds and nobody had read it as a brief:

  > *`elevated.ROAD_CLEARANCE_M` lifts a **building** over a road; nothing lifts
  > a road over a building, and `decks._crossing_demand` reads carriageways
  > only.*

That is one rule missing and it is this one. The pipeline has, all along, had
exactly one relationship between a road and a structure over it -- the 5.4 m a
footprint is raised to clear a carriageway -- and no relationship at all in the
other direction. So 540 pairs of deck-inside-building stood in the shipped world
before the round that broke Milsons Point ever ran: 362 m2 of the Cahill's
Upper Pitt Street ramp inside one footprint, Fitzroy Street, James Craig Road,
Jeffreys Street. Every one of them is the same picture -- a roof drawn through a
viaduct's girder, or a viaduct's girder drawn through a roof, which is the same
picture seen from underneath.

**Why the building comes down rather than the deck going up.** The deck is
solved: its height is its two touchdowns, the roads it must clear and a 7%
ceiling, and every one of those is a measurement of something real. A roof
height is not. 71% of this world's footprints have their height *inferred* --
`attributes.resolve_height`'s last two rungs, an ML estimate or a guess from
area and context -- and an inferred roof that reaches into a solved viaduct is
the least-evidenced number in the pair. It is also the only one that can be
changed without moving anything else: `decks.py`'s profile is a graph solve
whose every node is coupled to its neighbours, and a roof is a single float.

The rule:

  **Where a building's footprint lies under a deck's solid, its extrusion is
  capped at that solid's underside less `DECK_HEADROOM_M`, and never below its
  own base plus one storey.**

`cap_under_decks` is the rule. Four things about it are decisions:

**`DECK_HEADROOM_M` is `decks.WALK_UNDER_M`, 2.6 m,** and it is borrowed rather
than invented because it is the same question asked from the other side.
`decks.py` sets 2.6 m as the clearance at which a deck's collision prism lifts
off the ground and the player walks *under* it rather than onto it, and
`CollisionWorld.roofHeight` stands a player on any prism top they are above --
so a roof under a viaduct is a floor the player can be standing on, and a
headroom under 2.6 m is a place they cannot stand up. Anything smaller would be
a number chosen to make a count go down; this one is the number the rest of the
build already means by "there is room under this".

**The floor is a refusal, not a squashing.** Where the soffit less the headroom
would put the roof under its own base plus one storey, the cap is *not applied*.
Squashing it to a single storey would obey the letter of "never below its own
base plus one storey" and be a worse world: those are the places where a deck
prism is in `decks.prisms`' embankment form -- a touchdown ramp whose base is
`ground - 0.5` because there is no room to walk under it -- and a ramp lying on
the ground through a building is not a headroom problem. Flattening a terrace
row along every touchdown in Sydney to make a clash counter fall would be the
wrong trade twice over. It is also arithmetically useless, and that is the
argument that settles it: squashing the Milsons Point case to one storey leaves
its roof at -30.5 m over a deck whose solid tops out at -35.4, so the band still
overlaps and the pair still counts. A cap that cannot clear the band is a
building shortened for nothing.

**Where the deck is through the footprint rather than over it, the last question
is `_decide`'s own, and so is the answer.** The refusal above leaves the pair
standing, and at Milsons Point the pair is 98 of them against **one** OSM
polygon: `o1069460235`, `building=yes`, `levels=2`, 3,467 m2, whose plan is a
182 m x 20 m strip running (240, 2562) - (220, 2632) - (200, 2688) - (186, 2736).
That is not a building beside the Bradfield Highway approach. It **is** the
Bradfield Highway approach, mapped as a building, and `decks.py` has solved a
deck straight down the middle of it. So the polygon is put to the question this
module already asks of an ML blob that swallowed a footbridge -- *cut the road
out and see what is left* -- with the solved deck ribbon standing in for the
buffered centreline, and if under `VIADUCT_PLAN_SHARE` of its plan survives, it
is dropped.

Three things keep that deletion inside the fence `_decide` already built.
**A drop still needs OSM to have mapped a bridge**: a deck solid exists here only
because `decks._is_deck` read `bridge` on the way, so the corroboration is the
same evidence, arrived at through a solve rather than a buffer. **It is only ever
asked after the cap has been refused**, so a footprint the deck genuinely passes
over is capped and never considered for deletion. **The proof is stricter than
`_decide`'s**, a fifth of the plan against a half, because `_decide` can cut and
this rung cannot -- `VIADUCT_PLAN_SHARE` argues that at length. And **every drop
is named in the report**, on `ElevatedReport.dropped`'s terms.

**What the two rules are worth, measured**, on a scoped emit of the four
Milsons Point tiles overlaid on the round-two world,
`clash-check --near 185,-2719 --radius 450`:

| | world | with both rules |
|---|---|---|
| `DECK_IN_BUILDING` | **145** pairs, 6,401 m2 | **10** pairs, 199 m2 |
| every other one of the twelve rows | | unchanged |
| the four tiles' `.terr.bin` | | byte-identical |

Over the whole 60 km the pass's own census is **75,956 deck solids over 90
footprints**: 13 capped (p50 5.00 m off a roof, max 10.30 m), 8 dropped, 49
refused because the deck is on the ground through a real building, and 20
already clear. The ten pairs left in the window are all refusals, 2 to 51 m2
each, and every one of them is `_decide`'s cut ladder's work rather than this
rule's.

The one cost, stated rather than hoped away: this runs after
`streets.StreetNetwork.load` has already subtracted the footprint from the paved
footpath band, so a dropped viaduct-polygon leaves its own plan unpaved
underneath the deck that replaces it. Under a viaduct that reads as the
un-paved strip a viaduct corridor is; moving the drop earlier would mean solving
the decks before the streets, which is a reordering with its own argument to
make and not this rule's to make for it.

**The overlap threshold is half the check's.** `clash-check.MIN_OVERLAP_M2` is
2.0 m2 and this fires at 1.0, because the check measures the *quantised*
collision rings and this measures the source rings, and a rule that fired at
exactly the threshold it is trying to clear would leave pairs standing on
5 mm of rounding.

**It runs after the tile bucketing and mutates a height and nothing else**,
which is what makes it safe there: a height is not a plan quantity, so nothing
already derived -- the tile a building belongs to, the footpath its footprint
was subtracted from, the bays and poles that dodged it -- can move, and
everything that reads a height afterwards, the tile mesh, the collision prism
and `far.bin`, reads the capped one. What it cannot do from there is change a
*plan*, and that is the whole of the next section.

---------------------------------------------------------------------------
**THE 49 REFUSALS, AND THE RUNG THEY WERE OWED: A BUILDING A DECK LIES
*THROUGH* IS CUT.**

The census above ends with a defect named out loud -- *49 refused because the
deck is on the ground through a real building* -- and `cap_under_decks`' own
report says whose work it is: `_decide`'s cut ladder. Every one of them is a
roof drawn through a touchdown ramp: the Cahill's Upper Pitt Street approach at
362 m2 inside one footprint, Fitzroy Street at 93 m2, James Craig Road eight
times over. Every one of them is a building with a road *through* it, which is
the sentence this module's first three rungs are made of -- and every one was
refused because the only two verbs available after the tile bucketing are
"lower a roof" and "delete", and a road through a building asks for neither.

**What was stopping it was one filter, and the filter is right.** `resolve`'s
`centre_lines` index drops `r.bridge`, and that is correct for the bug it was
written for: this index is the carriageways a footprint may not stand on the
ground *across*, the word doing the work is **ground**, and a bridge way is a
road in the air. A rule that read a bridge centreline here would find every
building a flyover passes over "spanning a road" -- and every one of those is
`near_bridge`-corroborated by construction, because the flyover's own way lies
on it -- so branch 3 would put a real terrace to the crossing question and
*lift it into the air on a 5.4 m soffit*. That is not a hypothetical:
`_verify_resolve`'s `under` case is exactly it, and with its viaduct way moved
into `centre_lines` as though it were at grade the building comes back raised
to a 5.4 m base with 4.6 m of roof left on it. This module's own bug, committed
with the storeys the other way up. The filter stays, and there is a test on it
now.

**But the bridge way was the wrong thing to have asked in the first place.**
`bridge=yes` says a structure carries this road. It says nothing about whether,
at the metre where that road crosses this roof, there is any air under it --
and there is 5.4 m of it over a flyover and none at all over a touchdown ramp,
an approach embankment or a span over a culvert, which are the crossings that
make this defect. The one thing in the build that knows the difference is the
deck solve, which has already decided station by station whether the prism it
writes is a soffit over the player's head or an embankment under their feet
(`decks.prisms`, against `decks.WALK_UNDER_M`). So the fourth rung asks the
solved deck and never the way, which is what "considering bridge ways" has to
mean here if it is not to mean the paragraph above.

The rule:

  **Where a solved deck's solid stands in the same band as a footprint's, and
  no cap of the roof under it would leave a storey, the deck's ribbon is cut
  out of the plan and the largest piece stays on the ground.**

`_decks_through` is the question and `_cut_under_deck` is the answer. Four
things about them are decisions:

**The test is `clash-check`'s pair and `cap_under_decks`' refusal, together,**
and the first half is not decoration. A deck solid that shares a footprint's
whole plan and stands *below* its pad -- a road in a cutting under the block on
the hill above it -- is refused by the cap for the same arithmetic as a ramp
through a terrace, and is not a clash at all: `clash-check.bandsOverlap` never
convicts it and nothing is wrong with the world there. A notch cut in a real
building to answer a defect that does not exist would be a visible change made
for an invisible one. So the band is asked first, in the check's own terms over
the same two prisms the check reads, and what is left after it is the cap's own
refusal, asked one pass early against the same constants. The pairs a cap would
fix stay the cap's -- lowering a roof is the gentler repair -- and the pairs it
cannot are this rung's.

**It cuts, and it never drops.** Under `VIADUCT_PLAN_SHARE` of the plan
surviving, the polygon *is* the viaduct rather than a building one clips -- the
3,467 m2 `building=yes` strip at Milsons Point that is the Bradfield Highway
approach -- and this rung leaves it exactly where it stood, uncut, for
`cap_under_decks` to delete on the terms `VIADUCT_PLAN_SHARE`'s note argues at
length. Two rules that could both delete the same polygon on the same evidence
would be one rule written twice, and the deletion belongs to the one whose
header argues for it.

**The share that decides that is measured against every deck standing on the
footprint, not only the ones being cut out of it.** `_decks_through` hands over
two plans for that reason: the prisms that are through this footprint, which is
what comes out of the ring, and *all* of them, which is what the viaduct
question is asked of -- because it is the plan `cap_under_decks._remnant_share`
will ask the same question of a pass later, and the two rules must not disagree
about which polygons are viaducts. Ask it of the first and the Milsons Point
strip keeps most of its plan, is cut by a sliver instead of left alone, and is
then *refused* by a cap that would have dropped it: the Bradfield Highway
approach back in the world as a 3,400 m2 building, through a change that was
meant not to touch it.

**Only the prisms that are through it come out.** A ribbon that flies over one
end of a terrace row and lands through the other has its landing cut and its
flight capped, rather than the row torn along its length.

**And it costs an ordering**, which is the only thing outside this file that
moved: `cli.cmd_build` now solves the decks -- and builds the hero landmarks
they are handed beside -- *before* the elevated pass instead of after it. A cut
moves a centroid and `Building.tile` is derived from one, so a cut has to happen
before the tile bucketing; the solve is the only thing that knows whether there
is air under a bridge. Those two facts have exactly one order between them.
`decks.DeckNetwork.load` and `landmarks.build_all` read the terrain, the
anchors and the ways and no building at all, so the move costs nothing else --
and it buys back the one cost the cap's own drop has always had to pay: the cut
happens *before* `streets.StreetNetwork.load` subtracts the footprint from the
paved footpath band, so the ground a cut opens under a ramp is paved rather
than left as the bare strip a dropped viaduct-polygon leaves behind.

**What the rung is worth, measured.** Two 60 km classifies of the same sources,
one on the code before this rung and one after, differing in nothing else, and
the same 28 tiles emitted from each:

| the pass's own census, whole build | before | after |
|---|---:|---:|
| `ElevatedReport.cut` | 28 | **80** |
| `ElevatedReport.dropped` / `quirks` | 5 / 10 | 5 / 10, the same ids |
| footprints with a deck solid on them | 90 | **53** |
| `CapReport.capped` | 21 | 22 |
| `CapReport.dropped` | 2 | 2, the same ids |
| **`CapReport.refused`** | **48** | **9** |

The 52 new cuts are the rung; not one of them is a deletion, and the pass drops
and leaves grounded exactly the polygons it did before. Eight of the nine
refusals left report a soffit *below* the footprint's own pad -- a road in a
cutting under the block above it, which is the case the band clause exists to
leave alone.

| `clash-check --radius 600`, the two worst windows | before | after |
|---|---:|---:|
| `DECK_IN_BUILDING` at (100, -2850), Milsons Point | 79 pairs, 1,150 m2 | **2 pairs, 7 m2** |
| `DECK_IN_BUILDING` at (-2470, 0), James Craig Road | 79 pairs, 1,802 m2 | **0 pairs, 0 m2** |
| every other one of the twelve rows, both windows | | unchanged |
| the 28 tiles' `.terr.bin` | | byte-identical, and identical to the shipped world's |
| `undrawn-solids-check --near` on both windows | | every gated number unchanged at 0 |
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import shapely
from shapely.geometry import LineString, Polygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

from . import decks, merge
from .sources import msbuildings, osm

# --- What counts as a road being spanned ---------------------------------------

# The carriageway classes a building may not stand on the ground across.
#
# `osm.STREET_CLASSES` minus `service`, and the subtraction is the single most
# load-bearing line in this module. Measured over the ledger's 470,457
# footprints: 1,650 have *some* ground carriageway centreline running through
# them, and only 218 have a public one. The other 1,432 are car-park ramps,
# loading docks and arcade driveways mapped through buildings that are entirely
# real, and a rule that touched them would carve slots through Westfield
# Burwood, Macquarie Centre, the ICC and both Sydney Airport terminals.
PUBLIC_CLASSES = osm.STREET_CLASSES - {"service"}

# How much of a public centreline must lie inside a footprint before it counts
# as spanning it, metres.
#
# A footprint whose corner clips a centreline by half a metre is a mapping
# offset, not a structure over a road. 3 m is under the narrowest thing that
# could be a real crossing and over anything float noise or a 1 cm-rounded ring
# can produce.
SPAN_MIN_M = 3.0

# How near an OSM way tagged `bridge` a footprint must lie to be corroborated by
# it, metres.
#
# A bridge way is a centreline and the structure carrying it is a few metres
# wide, so the test is "is this polygon on that bridge" rather than "does it
# touch it". 3 m is half a generous footbridge; wider started sweeping in the
# buildings either side of an overpass, which are ordinary buildings that happen
# to stand next to one.
BRIDGE_WAY_REACH_M = 3.0

# --- What a derived base is -----------------------------------------------------

# The soffit a bridge with no stated base is given over the ground, metres.
#
# AS 5100.1 sets 5.4 m as the minimum vertical clearance over a road for a new
# structure in NSW, and every overbridge in this extent was built to some
# version of it. It is deliberately well clear of `decks.WALK_UNDER_M` (2.6),
# which is the *collision* threshold at which this pipeline decides a prism is
# something the player walks under rather than onto: matching that number
# exactly would put every derived bridge on the knife edge of the rule the
# audit measures against, and a bridge is not a knife-edge case.
ROAD_CLEARANCE_M = 5.4

# The least a raised prism may be, roof to soffit, metres.
#
# `decks.py`'s own answer to "what is a bridge made of": a girder and the
# parapet standing on it. A structure whose stated roof leaves less than this
# above its derived soffit has not been measured, it has been guessed at by an
# ML height estimator that was looking at a road, and there is no prism in it
# worth floating.
MIN_RAISED_HEIGHT_M = decks.GIRDER_DEPTH_M + decks.PARAPET_HEIGHT_M

# The share of its own plan a footprint must keep, once the roads it spans are
# cut out of it, to still be a building rather than a bridge.
#
# Half. The two cases are not close together in this data and do not need a
# tuned threshold: the Lane Cove footbridge keeps 28% of its plan and the
# Mosman retail blob keeps 89%, Westfield Chatswood keeps 96%. Anything near
# the line is a small ML blob either way and both answers are defensible.
BRIDGE_PLAN_SHARE = 0.5

# A remnant smaller than this is not a building. `msbuildings`' own floor, so
# that a cut cannot leave behind something the ingest would have refused.
MIN_REMNANT_M2 = msbuildings.MIN_AREA_M2

# Storey height for `building:min_level`, metres.
#
# Deliberately the *same* number `attributes._floor_height_for` uses for the
# generic case rather than a second constant: `building:min_level=2` and
# `building:levels=2` are the same count of the same storeys, and a module that
# converted them at different rates would put a building's floor and its roof on
# two different scales.
LEVEL_HEIGHT_M = 3.2


# --- What a building may not stand up into --------------------------------------

# The air left between a deck's underside and the roof under it, metres.
#
# `decks.WALK_UNDER_M`, borrowed rather than invented -- see the header. It is
# the clearance at which `decks.prisms` lifts a deck's collision base off the
# ground so the player walks under it, and `CollisionWorld.roofHeight` stands a
# player on any prism top they are above, so a roof under a viaduct is a floor
# somebody can be standing on. Below 2.6 m they cannot stand up on it.
DECK_HEADROOM_M = decks.WALK_UNDER_M

# How much of a footprint has to lie under a deck solid before the cap fires,
# square metres.
#
# Half `clash-check.MIN_OVERLAP_M2`. That check reads the quantised collision
# rings and this reads the source rings, so a rule that fired at exactly the
# threshold it exists to clear would leave pairs standing on 5 mm of rounding.
DECK_OVERLAP_M2 = 1.0

# The prism kinds that are a road over something. `landmarks.Prism.kind` is the
# vocabulary; a pylon, a podium, a shell and a ferris wheel are not decks, and
# the buildings that stood under those were removed by `landmarks.suppress`
# long before this runs.
DECK_KINDS = frozenset({"deck", "parapet"})

# What share of its own plan a footprint must keep, once the deck solids
# standing in it are cut out, to still be a building rather than the viaduct.
#
# **A fifth, where `_decide`'s own answer to the same question is a half**, and
# the difference is not a taste: `_decide` can *cut*, and this rung cannot. That
# pass runs before `cli.cmd_build` buckets by tile, so it is free to take the
# arm off a footprint and leave the building -- `_recut` moves the centroid and
# `Building.tile` is derived from it. This one runs after the deck solve, which
# is after the bucketing, so the only two answers available are "leave it" and
# "delete it". A deletion offered where a cut is the right answer has to be held
# to a stricter proof.
#
# Measured over the 60 km extent at `BRIDGE_PLAN_SHARE`: 16 polygons, and the
# tail of that list is the argument. `o1479652865` is a 393 m2 interwar
# apartment keeping 47% and `o1113541346` a 477 m2 federation keeping 45% --
# real buildings a viaduct clips, whose 185 and 215 m2 remnants are buildings in
# their own right. At a fifth, 7 remain and every one of them is a polygon the
# deck ribbon covers four fifths of, including the 3,467 m2 `building=yes`
# strip at Milsons Point that *is* the Bradfield Highway approach.
VIADUCT_PLAN_SHARE = 0.2

# Plan cell for the building index the cap runs against, metres. Sized over the
# largest deck prism -- a station's worth of ribbon at `decks.STATION_M` by a
# wide carriageway -- so a prism's lookup is a handful of cells.
CAP_CELL_M = 64.0


# --- The report -----------------------------------------------------------------


@dataclass
class ElevatedReport:
    """What the pass did, in enough detail to argue with.

    Every list holds `(id, note)` rather than a count, because each of these
    outcomes is rare enough to name and each one is a building that has visibly
    changed. A build whose `dropped` list grows by fifty is a build that has
    deleted fifty structures and should be looked at.
    """

    stated: list[tuple[str, str]] = field(default_factory=list)
    declared: list[tuple[str, str]] = field(default_factory=list)
    raised: list[tuple[str, str]] = field(default_factory=list)
    cut: list[tuple[str, str]] = field(default_factory=list)
    dropped: list[tuple[str, str]] = field(default_factory=list)
    # Structures that could be neither lifted nor cut and that the pass refused
    # to delete, so they are on the ground exactly as they were. See the repair
    # ladder at the end of `_decide`.
    quirks: list[tuple[str, str]] = field(default_factory=list)
    # `examined` is every footprint; `candidates` the ones that survived the
    # cheap reject and had a polygon built; `spanning` and `corroborated` are
    # counted **within the candidates** and are deliberately not a census of the
    # world -- 1,650 footprints in the extract have some carriageway through
    # them and this pass never looks at most of them, by design.
    candidates: int = 0
    spanning: int = 0
    corroborated: int = 0
    examined: int = 0

    @property
    def changed(self) -> int:
        return len(self.stated) + len(self.declared) + len(self.raised) + len(self.cut)


# --- The pass -------------------------------------------------------------------


def resolve(
    buildings: list[merge.Building],
    roads: list[osm.OsmRoad],
    terrain,
    deck_network=None,
    extra_prisms=(),
) -> tuple[list[merge.Building], ElevatedReport]:
    """Give every elevated structure a base, and take the walls off the roads.

    Returns the surviving buildings and a report. Mutates the survivors in place
    -- `base_height`, and for a cut also `ring`, `holes`, `area` and `centroid`
    -- so the caller's other references to the same objects stay correct. The
    centroid matters and is the reason the caller must bucket by tile *after*
    this runs: `Building.tile` is derived from it, and cutting an arm off a
    footprint can move it across a tile line.

    `deck_network` and `extra_prisms` are the solved decks and the hero landmark
    prisms, and they are the whole input to the fourth rung -- see `_decide`'s
    branch 4 and the header. Both are optional, and with neither this pass is
    exactly the three rungs it was, which is what every caller with no deck
    solve to hand relies on.

    Runs on every build, including a `--retile`, because it is derived rather
    than stored: the tags it reads ride in the `buildings` table's geometry blob
    and the decision is cheap to remake. What it must not do is run before the
    terrain exists, since a derived soffit is measured from the ground.
    """
    report = ElevatedReport()

    # The two spatial indexes this pass asks its questions of. Built once: the
    # per-building work below is a handful of tree queries and the trees are the
    # only expensive thing here.
    #
    # **`r.bridge` stays out of this list and always will.** This is the index of
    # carriageways a footprint may not stand on the ground *across*, and the word
    # doing the work is *ground*: a bridge way is a road in the air, a building
    # under one is not walling it, and a building a flyover passes over is
    # corroborated by that flyover's own way -- so a bridge centreline read here
    # would send real terraces down branch 3 and lift them onto a 5.4 m soffit.
    # `_verify_resolve`'s `under` case is that measurement. The bridge ways get
    # their say on the fourth rung instead, through the deck the solve made of
    # them, which is the only form of them that knows whether there is air under
    # it. See `_decks_through`.
    centre_lines: list[LineString] = []
    centre_half: list[float] = []
    for r in roads:
        if r.is_foot or r.tunnel or r.layer != 0 or r.bridge:
            continue
        if r.highway not in PUBLIC_CLASSES or len(r.line) < 2:
            continue
        centre_lines.append(LineString(r.line))
        centre_half.append(r.width * 0.5)
    centre_tree = STRtree(centre_lines) if centre_lines else None

    # Bridge *ways*, at layer 1 or above. The layer test is what keeps a culvert
    # crossing -- `bridge=yes` over a pipe, at grade, which is the median bridge
    # way in this extract -- from corroborating anything: nothing is in the air
    # over a culvert.
    bridge_plans = [
        LineString(r.line).buffer(BRIDGE_WAY_REACH_M)
        for r in roads
        if r.bridge and r.layer >= 1 and len(r.line) >= 2
    ]
    bridge_tree = STRtree(bridge_plans) if bridge_plans else None

    # THE CHEAP REJECT, and it is what makes this pass affordable over 470,457
    # footprints. Everything below `_decide` needs a shapely polygon and a pair
    # of tree queries per building, which at half a million buildings is minutes
    # of work to answer "no" about 99.4% of them.
    #
    # So the near-a-bridge-way test is done first, in bulk, and approximately:
    # one nearest-neighbour query from every centroid at once, kept when the
    # distance is inside the footprint's own half-diagonal. That is a strict
    # over-approximation -- a polygon that intersects a bridge plan always has a
    # centroid within its half-diagonal of it -- so the exact test that follows
    # can only ever remove candidates, never add them.
    near = _near_bridge_bulk(buildings, bridge_tree, bridge_plans)

    # And the fourth question, which is not asked of a way at all: which
    # footprints have a *solved* deck lying through them rather than over them.
    # Empty when the caller handed over no deck solve, which is what keeps this
    # pass the three rungs it was for every such caller.
    through = _decks_through(buildings, deck_network, extra_prisms, terrain)

    keep: list[merge.Building] = []
    for i, b in enumerate(buildings):
        report.examined += 1
        deck_cut = through.get(i)
        if (
            _stated_base(b) is None
            and not _declared_bridge(b)
            and b.layer < 1
            and not near[i]
            and deck_cut is None
        ):
            keep.append(b)
            continue
        verdict = _decide(
            b, centre_tree, centre_lines, centre_half, bridge_tree, bridge_plans,
            terrain, deck_cut, report,
        )
        if verdict is not None:
            keep.append(b)
    return keep, report


def _near_bridge_bulk(buildings, tree, plans) -> np.ndarray:
    """Which footprints are plausibly on a bridge way, by centroid and reach."""
    n = len(buildings)
    if tree is None or n == 0:
        return np.zeros(n, dtype=bool)
    cent = np.array([b.centroid for b in buildings], dtype=np.float64)
    reach = np.empty(n, dtype=np.float64)
    for i, b in enumerate(buildings):
        r = np.asarray(b.ring, dtype=np.float64)
        if len(r) < 3:
            reach[i] = 0.0
            continue
        span = r.max(axis=0) - r.min(axis=0)
        reach[i] = 0.5 * float(np.hypot(span[0], span[1]))
    idx, dist = tree.query_nearest(
        shapely.points(cent), all_matches=False, return_distance=True
    )
    out = np.zeros(n, dtype=bool)
    # `query_nearest` returns one column per input geometry it found a match
    # for; with `all_matches=False` that is a 1-D array of tree indices aligned
    # to the inputs it answered about, so the input index comes back in `idx`
    # only when the tree is non-empty for it. Guarded rather than assumed,
    # because the shape of this return has changed across shapely versions.
    if idx.ndim == 2:
        rows, _ = idx
        out[rows] = dist <= reach[rows]
    else:
        out[: len(idx)] = dist <= reach[: len(idx)]
    return out


def _decide(
    b: merge.Building,
    centre_tree,
    centre_lines,
    centre_half,
    bridge_tree,
    bridge_plans,
    terrain,
    deck_cut,
    report: ElevatedReport,
) -> merge.Building | None:
    """One footprint's outcome. None means drop it.

    `deck_cut` is `_decks_through`'s answer for this footprint, or None: the
    plan of the solved decks lying *through* it, and the plan of every deck
    standing on it at all. The fourth rung's whole input.
    """
    stated = _stated_base(b)
    declared = _declared_bridge(b)

    poly = _plan(b)
    if poly is None:
        return b

    near_bridge = _near_bridge_way(poly, bridge_tree, bridge_plans)
    corroborated = declared or b.layer >= 1 or near_bridge

    # WHAT MAY BE DELETED, as opposed to what may be moved. A drop needs OSM to
    # have actually mapped a bridge here -- the polygon claiming to be one, or a
    # bridge *way* lying on it. `layer >= 1` on its own never qualifies, and
    # that distinction is not theoretical: on the first run of this pass it was
    # about to delete a 42 m^2 building named `Gatehouse` at Hunters Hill and a
    # `building=corridor` at Killara, both tagged `layer=1` by a mapper, both
    # straddling a driveway, and neither with a bridge mapped within a hundred
    # metres. A gatehouse standing over its own drive is a real building doing
    # the thing gatehouses do. It keeps its `layer` and stays on the ground.
    mapped_bridge = bool(declared) or near_bridge

    spans, corridor = _spanned_roads(poly, centre_tree, centre_lines, centre_half)
    report.candidates += 1
    over_road = spans >= SPAN_MIN_M
    if over_road:
        report.spanning += 1
        if corroborated:
            report.corroborated += 1

    # ---- 1. The mapper told us where it starts. -------------------------------
    #
    # Unconditional, and the only branch that needs no geometry at all: a raised
    # walkway between two towers spans no road and is still in the air.
    if stated is not None and stated > 0.0:
        base = stated
        if over_road:
            # A stated base under the clearance floor, over a road, is a mapper
            # rounding down rather than a structure that low: nothing gets built
            # over a public carriageway with less headroom than the code
            # requires. Lifted rather than trusted, because the failure mode of
            # trusting it is the wall this module exists to remove.
            base = max(base, ROAD_CLEARANCE_M)
        source = "min_height" if b.min_height is not None else "building:min_level"
        if _lift(b, base, report.stated, f"base {base:.1f} m from {source}"):
            return b
        why = f"a {b.height:.1f} m roof cannot clear a {base:.1f} m soffit stated by {source}"

    # ---- 2. The polygon says it is a bridge and did not say how high. --------
    #
    # Derived whether or not it spans a road: a bridge over water or a rail
    # corridor is still a bridge, and there are 15 of these in the extent.
    elif declared:
        base = _derived_base(b, poly, terrain)
        if base is not None and _lift(b, base, report.declared, f"soffit {base:.1f} m; {declared}"):
            return b
        why = (
            f"{declared}, but a {b.height:.1f} m roof cannot clear"
            f" {'the derived soffit' if base is None else f'a {base:.1f} m soffit'}"
        )

    # ---- 3. Untagged, and over a public road with a crossing mapped on it. ---
    elif over_road and corroborated:
        remnant = _largest_remnant(poly, corridor)
        share = (remnant.area / poly.area) if poly.area > 0 else 0.0
        why = f"{spans:.0f} m of public carriageway inside, {share * 100:.0f}% of plan survives the cut"
        if share < BRIDGE_PLAN_SHARE:
            # The polygon *is* the crossing rather than a building with one
            # attached. Raise it whole if there is a prism to raise.
            base = _derived_base(b, poly, terrain)
            if base is not None and _lift(b, base, report.raised, f"soffit {base:.1f} m; {why}"):
                return b
            # And if there is not, and OSM has mapped a bridge here, it goes.
            #
            # This is the one place a drop is preferred to a cut, and the
            # difference between the two cases is what the polygon *is*. Cutting
            # a footbridge blob leaves two stubs of ML segmentation standing on
            # the footpaths at either landing -- 105 m^2 of 3 m brick box beside
            # Longueville Road, which is a second artefact rather than half a
            # repair. There is no building under this polygon to preserve; it is
            # a deck the segmenter mistook for a roof, and the pipeline does not
            # draw footbridges in the first place (`decks._is_deck` excludes
            # `is_foot` ways deliberately). A missing footbridge is invisible.
            if mapped_bridge:
                report.dropped.append((b.id, f"{why}; nothing under it but the span"))
                return None

    # ---- 4. A solved deck lies *through* it rather than over it. -------------
    #
    # The bridge ways' rung, and it is reached only by a footprint none of the
    # three above claimed: no stated base, nothing declared, and no public
    # *ground* carriageway inside it. What is inside it is a deck the solve put
    # on the ground -- a touchdown ramp, an approach embankment -- and a building
    # with one of those through it is the same picture as a building with a road
    # through it, so it gets the same answer. See `_decks_through` for why the
    # question is asked of the solved deck and never of the bridge way.
    elif deck_cut is not None:
        return _cut_under_deck(b, poly, deck_cut, report)

    else:
        return b

    # ---- The repair, for everything that fell through the three branches. ----
    #
    # Reached only by a structure that should not be sitting on the ground and
    # cannot be lifted off it. In descending order of preference:
    #
    #   * **Cut.** Take the road corridor out of the plan and keep the largest
    #     piece, on the ground. This is the answer for a building with an arm
    #     over the road -- Westfield Chatswood over Anderson Street, the Mosman
    #     retail block over Military Road -- and also for the `layer=1`
    #     canopies and covered ways that turned out to be too low to lift: the
    #     road opens and the building stays, which beats both alternatives.
    #   * **Drop**, only if a bridge is actually mapped here. See `mapped_bridge`
    #     above for why `layer` alone is not enough to delete on.
    #   * **Leave it.** Grounded, unchanged, and named in the report. The pass
    #     refuses to guess rather than damaging something real.
    remnant = _largest_remnant(poly, corridor)
    if corridor is not None and remnant.area >= MIN_REMNANT_M2 and remnant.area < poly.area:
        _recut(b, remnant)
        report.cut.append((b.id, why))
        return b
    if mapped_bridge and over_road:
        report.dropped.append((b.id, why))
        return None
    report.quirks.append((b.id, why))
    return b


def _cut_under_deck(b, poly, deck_cut, report: ElevatedReport) -> merge.Building:
    """Take a grounded deck's ribbon out of a footprint. Never deletes.

    `_decide`'s repair ladder with its top and bottom rungs taken off, and both
    removals are the point.

    **It cannot raise.** A deck lying on the ground through a building is not a
    building that wants lifting: lifting it would put a roof over a ramp the
    player drives on, which is this module's own bug with the storeys the other
    way up.

    **It cannot drop, and that is the rung `cap_under_decks` keeps.** Under
    `VIADUCT_PLAN_SHARE` of the plan surviving, the polygon *is* the viaduct
    rather than a building a viaduct clips -- the 3,467 m2 `building=yes` strip
    at Milsons Point that is the Bradfield Highway approach -- and this leaves it
    exactly where it stood, uncut, for `cap_under_decks` to put to that question
    and delete on its own terms. Two rules that could both delete the same
    polygon on the same evidence would be one rule written twice.

    **And the share that decides it is read against every deck standing on the
    footprint, not against the ones being cut out of it.** That is the one line
    in here that is a bug avoided rather than a decision taken: the plan this
    asks the viaduct question of has to be the plan `cap_under_decks` will ask
    it of next, or the two rules disagree about which polygons are viaducts and
    the Milsons Point strip comes back into the world as a building, trimmed by
    a sliver and then refused by a cap that would have dropped it.

    So this rung's whole vocabulary is *cut*: over the share there is a building
    here and the ribbon comes out of it, under it there is not and nothing is
    touched.
    """
    through, whole = deck_cut
    keep = _remnant_share(poly, [whole])
    if keep is not None and keep < VIADUCT_PLAN_SHARE:
        # The polygon is the viaduct. `cap_under_decks` owns what happens next,
        # and it has to see the plan this pass was handed.
        return b
    remnant = _largest_remnant(poly, through)
    share = (remnant.area / poly.area) if poly.area > 0 else 0.0
    why = (
        f"a solved deck lies on the ground through it,"
        f" {share * 100:.0f}% of plan survives the cut"
    )
    if remnant.area < MIN_REMNANT_M2 or remnant.area >= poly.area:
        report.quirks.append((b.id, f"{why}, which is neither a building nor the viaduct"))
        return b
    _recut(b, remnant)
    report.cut.append((b.id, why))
    return b


# --- The cap: a building under a deck ---------------------------------------------


@dataclass
class CapReport:
    """What `cap_under_decks` took off, and what it refused to take off.

    Named rather than counted, on `ElevatedReport`'s terms and for its reason: a
    capped building is a building the player can see has changed shape, and a
    build whose `capped` list doubles is a build to look at rather than a number
    to nod at.
    """

    capped: list[tuple[str, float, float]] = field(default_factory=list)  # id, from, to
    refused: list[tuple[str, str]] = field(default_factory=list)
    # Footprints that *are* the viaduct, removed. `ElevatedReport.dropped`'s
    # terms exactly: a deletion, named, and never a count.
    dropped: list[tuple[str, str]] = field(default_factory=list)
    prisms: int = 0
    candidates: int = 0
    under_deck: int = 0

    @property
    def removed_m(self) -> list[float]:
        return [a - b for _, a, b in self.capped]


def cap_under_decks(
    buildings: list[merge.Building],
    deck_network,
    terrain,
    extra_prisms=(),
) -> CapReport:
    """Cap every footprint that stands up into a deck. See the header.

    `extra_prisms` is `landmarks.prisms_by_tile`'s flattened output -- the hero
    Harbour Bridge's own deck and parapets, which `decks.py` deliberately does
    not build and which are as much a road over a roof as any viaduct. Filtered
    to `DECK_KINDS`, so a pylon, a podium or a ferris wheel cannot cap anything;
    the buildings that stood inside *those* were removed by `landmarks.suppress`
    before this module ever saw them.

    Mutates `height` in place and returns the report. Nothing else is touched --
    not the ring, not the centroid, not `base_height` -- so every plan quantity
    already derived from these objects stays exactly what it was, which is what
    makes it safe to run after `cli.cmd_build` has bucketed them by tile.
    """
    from . import tiles  # local: `tiles` imports `decks`, and this is one caller

    report = CapReport()

    prisms = _deck_prisms(deck_network, extra_prisms)
    report.prisms = len(prisms)
    if not prisms or not buildings:
        return report

    over, plans, report.candidates = _decks_over(buildings, prisms)
    report.under_deck = len(over)
    # Ascending index rather than the pairing's own insertion order, so that the
    # report a build prints is a function of the building list and not of which
    # prism happened to be visited first.
    for i in sorted(over):
        b = buildings[i]
        pad, _ = tiles._pad_and_skirt(terrain, b)
        base = pad + b.base_height
        soffit = min(s for s, _h, _plan in over[i])
        cap = soffit - DECK_HEADROOM_M
        top = base + b.height
        if top <= cap:
            continue
        storey = _storey_height(b)
        if cap - base >= storey:
            report.capped.append((b.id, float(b.height), float(cap - base)))
            b.height = float(cap - base)
            continue
        # The floor binds: the deck is not over this footprint, it is *through*
        # it, and there is no cap that is also a building. `elevated._decide`'s
        # own last question then applies, with a solved deck standing in for the
        # bridge way it usually asks about -- see the header.
        #
        # **Reaching here at all is now the exception rather than the rule**, and
        # the reason is one pass upstream: `resolve`'s fourth rung asks
        # `_decks_through` the same question before the bucketing and cuts the
        # ribbon out of everything it can. What arrives here is what that rung
        # left -- the polygons that *are* the viaduct, which are this rule's to
        # drop, and the handful with no remnant worth keeping.
        keep = _remnant_share(plans.get(i), [plan for _s, _h, plan in over[i]])
        if keep is not None and keep < VIADUCT_PLAN_SHARE:
            why = (
                f"{100 * keep:.0f}% of its plan survives the deck corridor, so the"
                f" polygon is the viaduct: a {b.height:.1f} m"
                f" {b.archetype or 'building'} of {b.area:,.0f} m2 with a soffit at"
                f" {soffit:.2f} m over a base at {base:.2f} m"
            )
            report.dropped.append((b.id, why))
            continue
        report.refused.append(
            (b.id, f"soffit {soffit:.2f} m over a base at {base:.2f} m leaves"
                   f" {cap - base:.2f} m, under one storey of {storey:.2f} m; "
                   + ("no plan" if keep is None else f"{100 * keep:.0f}% of the plan survives"))
        )
    if report.dropped:
        gone = {bid for bid, _ in report.dropped}
        buildings[:] = [b for b in buildings if b.id not in gone]
    return report


def _deck_prisms(deck_network, extra_prisms=()) -> list:
    """Every solid in this build that is a road over something.

    One function, so that `resolve`'s fourth rung and `cap_under_decks` cannot be
    looking at two different worlds: a footprint the cut considered and the cap
    did not, or the other way round, would be two rules disagreeing about which
    decks exist, which is the one disagreement neither of them could survive.
    """
    out = (
        []
        if deck_network is None
        else [
            p
            for key in deck_network.tile_keys()
            for p in deck_network.prisms(key)
            if p.kind in DECK_KINDS
        ]
    )
    out += [p for p in extra_prisms if p.kind in DECK_KINDS]
    return out


def _decks_over(buildings: list[merge.Building], prisms: list):
    """Which deck solids stand on which footprints, in plan.

    Returns `(over, plans, candidates)`: `over` maps a building's index to the
    `(base, height, plan)` of every deck solid sharing at least
    `DECK_OVERLAP_M2` of plan with it, `plans` the shapely polygon built for
    each such footprint along the way, and `candidates` the number of pairs that
    survived the box test.

    A plan grid over the footprints rather than an STRtree, and the reason is
    memory: an STRtree wants a shapely geometry per building and there are
    1.29 M of them, where a grid wants two floats and an integer. The prisms are
    72,000, so the loop runs the cheap way round -- query per prism, not per
    building. Only the pairs that survive the box test are ever built as
    polygons.

    **Both passes pay for this separately, and that is deliberate.** `resolve`
    cuts rings, so the pairing it computed is stale the moment it has finished
    and `cap_under_decks` has to ask again, against the plans that survived.
    Sharing the answer would be sharing a measurement of geometry that no longer
    exists; sharing the *question* is what `_deck_prisms` is for.
    """
    over: dict[int, list[tuple[float, float, Polygon]]] = {}
    plans: dict[int, Polygon] = {}
    candidates = 0
    if not prisms or not buildings:
        return over, plans, candidates

    grid: dict[tuple[int, int], list[int]] = {}
    boxes = np.empty((len(buildings), 4))
    for i, b in enumerate(buildings):
        r = b.ring
        x0, x1 = float(r[:, 0].min()), float(r[:, 0].max())
        z0, z1 = float(r[:, 1].min()), float(r[:, 1].max())
        boxes[i] = (x0, z0, x1, z1)
        for cx in range(int(np.floor(x0 / CAP_CELL_M)), int(np.floor(x1 / CAP_CELL_M)) + 1):
            for cz in range(int(np.floor(z0 / CAP_CELL_M)), int(np.floor(z1 / CAP_CELL_M)) + 1):
                grid.setdefault((cx, cz), []).append(i)

    for p in prisms:
        r = p.ring
        px0, px1 = float(r[:, 0].min()), float(r[:, 0].max())
        pz0, pz1 = float(r[:, 1].min()), float(r[:, 1].max())
        seen: set[int] = set()
        for cx in range(int(np.floor(px0 / CAP_CELL_M)), int(np.floor(px1 / CAP_CELL_M)) + 1):
            for cz in range(int(np.floor(pz0 / CAP_CELL_M)), int(np.floor(pz1 / CAP_CELL_M)) + 1):
                seen.update(grid.get((cx, cz), ()))
        if not seen:
            continue
        plan = None
        for i in seen:
            bx0, bz0, bx1, bz1 = boxes[i]
            if bx1 < px0 or bx0 > px1 or bz1 < pz0 or bz0 > pz1:
                continue
            candidates += 1
            if plan is None:
                plan = Polygon(r)
                if not plan.is_valid:
                    plan = plan.buffer(0)
            poly = plans.get(i)
            if poly is None:
                poly = _plan(buildings[i])
                if poly is None:
                    continue
                plans[i] = poly
            try:
                shared = poly.intersection(plan).area
            except shapely.errors.GEOSException:
                continue
            if shared < DECK_OVERLAP_M2:
                continue
            over.setdefault(i, []).append((float(p.base), float(p.height), plan))
    return over, plans, candidates


def _decks_through(
    buildings, deck_network, extra_prisms, terrain
) -> dict[int, tuple[Polygon, Polygon]]:
    """Which footprints have a deck through them, and the two plans that decide it.

    Each answer is `(the prisms that are through it, every prism standing on
    it)`. The first is what `_cut_under_deck` takes out of the plan; the second
    is what it asks the viaduct question of, because that is the plan
    `cap_under_decks._remnant_share` will ask the same question of a pass later
    and the two must not disagree. See `_cut_under_deck`.

    **This is the one thing about a bridge that a bridge way cannot tell us.**
    `resolve`'s three older rungs read the ways, and a way tagged `bridge` says
    only that a structure carries it -- not whether, at the metre where that
    road crosses this roof, there is any air under it. There is none under a
    touchdown ramp, an approach embankment or a span over a culvert, and those
    are the crossings that make this defect; there is 5.4 m of it over every
    flyover, and a rule that read the way would treat the two identically and
    carve a slot through the terraces under the second. The solve knows the
    difference and nothing before it does, which is why `cli.cmd_build` now runs
    `decks.DeckNetwork.load` *before* this pass and hands the answer in.

    **A prism is through a footprint when two things are true of it**, and both
    are borrowed rather than invented:

      1. **its solid and the building's occupy the same band** --
         `clash-check.bandsOverlap` exactly, over the same two prisms the check
         reads, `[base, base + height]` either side. Nothing else is a clash. A
         deck in a cutting under the block on the hill above it shares that
         block's whole plan and shares nothing else, and a notch cut in a real
         building to answer a defect that is not there would be a visible change
         made for an invisible one. `cap_under_decks`' refusal test on its own
         does not have this clause and over-counts because of it.
      2. **and capping the roof under it would leave less than one storey** --
         `cap_under_decks`' own refusal, asked one pass early, the same
         arithmetic against the same constants. Where a cap *would* fit the cap
         gets it: lowering a roof is the gentler repair and it stays the cap's.

    The prisms that clear the roof are deliberately left out of the plan handed
    back: a ribbon that flies over one end of a terrace row and lands through the
    other should have its landing cut out and its flight capped, not the whole
    row torn along its length.
    """
    if deck_network is None and not extra_prisms:
        return {}
    from . import tiles  # local: `tiles` imports `decks`, and this is one caller

    over, _plans, _candidates = _decks_over(
        buildings, _deck_prisms(deck_network, extra_prisms)
    )
    out: dict[int, tuple[Polygon, Polygon]] = {}
    for i, stack in over.items():
        b = buildings[i]
        pad, _ = tiles._pad_and_skirt(terrain, b)
        base = pad + b.base_height
        top = base + b.height
        storey = _storey_height(b)
        blocking = [
            plan
            for soffit, height, plan in stack
            # The bands overlap, `clash-check.bandsOverlap`'s own inequality ...
            if soffit < top
            and soffit + height > base
            # ... and no cap of this roof would leave a storey under that soffit.
            and soffit - DECK_HEADROOM_M - base < storey
        ]
        if blocking:
            out[i] = (
                unary_union(blocking),
                unary_union([plan for _s, _h, plan in stack]),
            )
    return out


def _remnant_share(poly: Polygon | None, corridor) -> float | None:
    """What share of a footprint survives the deck corridor cut out of it.

    `_largest_remnant`'s question asked of a *solved* deck rather than of a road
    centreline buffered to its own width, which is the better evidence of the
    two: a deck ribbon is `DeckRun.half_width` either side of the line the
    profile was actually solved along, and it is the same polygon
    `clash-check` convicts the footprint against.
    """
    if poly is None or not corridor or poly.area <= 0.0:
        return None
    try:
        cut = poly.difference(unary_union(list(corridor)))
    except shapely.errors.GEOSException:
        return None
    return float(cut.area / poly.area)


def _storey_height(b: merge.Building) -> float:
    """One storey of this building, metres.

    `attributes`' own per-archetype floor-to-floor rather than a constant of this
    module's, for `LEVEL_HEIGHT_M`'s reason a few lines up: a storey is a storey
    and two files that disagree about how tall one is put a building's floors and
    its roof on different scales. A building with no archetype -- which nothing
    that has been through `attributes.apply` has -- falls back to that generic.
    """
    from . import attributes

    arch = attributes.ARCHETYPES.get(b.archetype)
    return arch.floor_height if arch is not None else LEVEL_HEIGHT_M


def _lift(b, base: float, bucket: list, why: str) -> bool:
    """Raise a prism to `base`. False when there is no prism left above it.

    The refusal is the interesting half. A structure whose roof is below the
    soffit it would need is not a structure that has been measured -- it is an
    ML height estimator that was looking at a road, or a `building:min_level=1`
    on a `building:levels=1` station canopy, which is a mapping convention
    ("one level tall, starting one level up") that OSM's schema reads as "zero
    levels tall". Floating a prism of negative thickness is not an option and
    neither is pretending; the caller decides what to do instead.
    """
    if b.height - base < MIN_RAISED_HEIGHT_M:
        return False
    b.base_height = base
    b.height -= base
    bucket.append((b.id, why))
    return True


def _derived_base(b, poly, terrain) -> float | None:
    """A soffit for a bridge that did not state one, metres over this pad.

    The ground is sampled at the footprint's **highest** point rather than at its
    centroid, because the clearance that matters is over the road, the road is
    usually in the low part of a crossing's plan and the abutments are the high
    part -- but a soffit is one number for the whole prism, so taking the
    maximum is what guarantees the underside clears everywhere rather than on
    average.

    `base_height` is measured from this building's own pad, because that is what
    `tiles.build_tile` adds it to. The clearance is measured from the highest
    ground under the plan, so the two are reconciled here and nowhere else.
    """
    if terrain is None:
        return None
    ground = _ground_max(poly, terrain)
    pad = _ground_at(b, terrain)
    if ground is None or pad is None:
        return None
    return (ground - pad) + ROAD_CLEARANCE_M


# --- The questions --------------------------------------------------------------


def _stated_base(b: merge.Building) -> float | None:
    """Metres above the ground the structure starts, if OSM said so.

    `min_height` wins over `building:min_level` where both are present, because
    it is the measurement and the other is a count converted by an assumption.
    """
    if b.min_height is not None:
        return float(b.min_height)
    if b.min_level:
        return float(b.min_level) * LEVEL_HEIGHT_M
    return None


def _declared_bridge(b: merge.Building) -> str | None:
    """The polygon's own claim to be a bridge, as a phrase for the report."""
    if b.building_type == "bridge":
        return "building=bridge"
    if b.bridge:
        return "bridge=* on the area"
    if b.man_made == "bridge":
        return "man_made=bridge"
    return None


def _plan(b: merge.Building) -> Polygon | None:
    try:
        poly = Polygon(b.ring, b.holes)
    except Exception:  # noqa: BLE001 -- a ring too short to be a polygon at all
        return None
    if not poly.is_valid:
        poly = poly.buffer(0)
    if poly.is_empty or poly.geom_type != "Polygon" or poly.area <= 0.0:
        return None
    return poly


def _near_bridge_way(poly: Polygon, tree, plans) -> bool:
    if tree is None:
        return False
    return any(poly.intersects(plans[i]) for i in tree.query(poly))


def _spanned_roads(poly: Polygon, tree, lines, halves):
    """(metres of public centreline inside the plan, the corridor it implies).

    The *centreline* rather than a ribbon, and that is the whole test: a
    building beside a road always overlaps a buffered centreline and never
    contains one. The corridor handed back -- the same ways, buffered to their
    carriageway width -- is only ever used to cut, never to detect.
    """
    if tree is None:
        return 0.0, None
    total = 0.0
    corridors = []
    for i in tree.query(poly):
        line = lines[i]
        inside = poly.intersection(line)
        length = float(getattr(inside, "length", 0.0))
        if length < SPAN_MIN_M:
            continue
        total += length
        corridors.append(line.buffer(halves[i]))
    return total, (unary_union(corridors) if corridors else None)


def _largest_remnant(poly: Polygon, corridor):
    """What is left of a plan once the roads through it are taken out."""
    if corridor is None:
        return poly
    rest = poly.difference(corridor)
    if rest.is_empty:
        return Polygon()
    parts = list(rest.geoms) if hasattr(rest, "geoms") else [rest]
    parts = [p for p in parts if p.geom_type == "Polygon" and not p.is_empty]
    if not parts:
        return Polygon()
    return max(parts, key=lambda p: p.area)


def _recut(b: merge.Building, remnant: Polygon) -> None:
    """Replace a footprint with what survived the cut, invariants intact.

    Area and centroid are recomputed rather than left alone, and the centroid is
    the one that would bite: `Building.tile` is derived from it, so a building
    whose arm has been cut off can belong to a different tile than it did a line
    ago. The winding goes back through `merge.orient_footprint` for the same
    reason every other producer of a ring does -- shapely's `difference` makes no
    promise about which way round it hands the pieces back.
    """
    ring, holes = merge.orient_footprint(
        np.asarray(remnant.exterior.coords, dtype=np.float64),
        [np.asarray(h.coords, dtype=np.float64) for h in remnant.interiors],
    )
    b.ring = ring
    b.holes = holes
    b.area = float(remnant.area)
    b.centroid = (float(remnant.centroid.x), float(remnant.centroid.y))


def _ground_max(poly: Polygon, terrain) -> float | None:
    pts = np.asarray(poly.exterior.coords, dtype=np.float64)
    if len(pts) == 0:
        return None
    h = np.asarray(terrain.sample(pts[:, 0], pts[:, 1]), dtype=np.float64)
    return float(np.nanmax(h)) if h.size and np.isfinite(h).any() else None


def _ground_at(b: merge.Building, terrain) -> float | None:
    """This building's pad, to `tiles._pad_and_skirt`'s first line.

    Deliberately the centroid sample and not a call into `tiles`, which would
    import the emitter into the classifier for one number. The difference is the
    deep-skirt clamp that function applies afterwards, and it can only ever move
    a pad *down* -- so a soffit derived here can only ever come out further above
    the real pad than intended, never below it, and erring high is the safe side
    of a clearance.
    """
    h = float(terrain.sample(*b.centroid))
    return h if np.isfinite(h) else None


class _Flat:
    """Ground at y = 0, and a `densify` that adds nothing to a ring."""

    @staticmethod
    def sample(e, north=None):
        if north is None:
            return 0.0
        return 0.0 if np.ndim(e) == 0 else np.zeros(np.shape(e))

    @staticmethod
    def densify(pts):
        return np.asarray(pts, dtype=np.float64)


class _Net:
    """A `DeckNetwork` with one tile and a fixed list of prisms."""

    def __init__(self, prisms):
        self._p = prisms

    def tile_keys(self):
        return {"0_0"}

    def prisms(self, _key):
        return self._p


def _rect(cx, cz, hx, hz):
    return np.array(
        [[cx - hx, cz - hz], [cx + hx, cz - hz], [cx + hx, cz + hz], [cx - hx, cz + hz]],
        dtype=np.float64,
    )


def _test_building(bid, cx, cz, hx, hz, height, **kw):
    b = merge.Building(id=bid, source=kw.pop("source", "osm"), ring=_rect(cx, cz, hx, hz))
    b.area = float(4 * hx * hz)
    b.centroid = (cx, cz)
    b.height = height
    b.archetype = "terrace"
    for k, v in kw.items():
        setattr(b, k, v)
    return b


def _test_way(pts, highway="primary", **kw):
    return osm.OsmRoad(
        osm_id=kw.pop("osm_id", "w"),
        line=np.asarray(pts, dtype=np.float64),
        highway=highway,
        name=None,
        lanes=None,
        oneway=False,
        width=kw.pop("width", 20.0),
        is_foot=kw.pop("is_foot", False),
        layer=kw.pop("layer", 0),
        tunnel=kw.pop("tunnel", False),
        bridge=kw.pop("bridge", False),
    )


def _verify_resolve() -> list[str]:
    """The wall, the retail block, the flyover, the ramp and the cutting.

    **The first two are the bug this module exists for and there was no test for
    them**, which is exactly the hole the fourth rung could have fallen into: a
    rule that teaches `resolve` to read bridges is one edit away from teaching it
    to lift the buildings *under* them, and the only thing that catches that is a
    case saying a footbridge blob across a road must still go and a terrace under
    a flyover must still stay, on the ground, uncut and its own height. Both are
    here, and so are the two the new rung owns.

    Six buildings, one flat ground, four ways and three deck solids. Costs
    microseconds and touches no data.
    """
    failures: list[str] = []

    # 1. THE WALL. A 40 x 24 m ML blob lying across a 20 m primary road with a
    #    footbridge mapped along it -- Longueville Road at Lane Cove. A quarter
    #    of its plan survives the road, so the polygon *is* the crossing, and a
    #    3 m roof cannot be lifted to a 5.4 m soffit: it goes.
    wall = _test_building("wall", 0.0, 0.0, 20.0, 12.0, 3.0, source="ms")
    # 2. THE RETAIL BLOCK. The same road clipping the edge of a 60 m square with
    #    the same footbridge on it -- Military Road at Mosman. Most of the plan
    #    survives, so it is a building with an arm over a road: the arm comes off
    #    and the block stays on the ground.
    block = _test_building("block", 300.0, 25.0, 30.0, 30.0, 12.0, source="ms")
    # 3. THE FLYOVER, and it is the control the fourth rung is dangerous without:
    #    a real 10 m building with a viaduct 12 m *over* it. A bridge way runs
    #    straight through its plan and it must come back whole, on the ground and
    #    uncut. Lowering its roof is `cap_under_decks`' business; cutting its plan
    #    or lifting it is nobody's.
    under = _test_building("under", 600.0, 0.0, 15.0, 15.0, 10.0)
    # 4. THE RAMP. The same picture with the deck on the ground through it.
    ramp = _test_building("ramp", 900.0, 0.0, 20.0, 10.0, 10.0)
    # 5. THE CUTTING, and the second control: the same plan overlap with the
    #    deck's whole solid *below* the building's, which is a road in a cutting
    #    under the block on the hill above it and is not a clash at all.
    #    `cap_under_decks`' refusal arithmetic cannot tell it from the ramp;
    #    `clash-check.bandsOverlap` can, and so does `_decks_through`.
    hill = _test_building("hill", 1200.0, 0.0, 20.0, 10.0, 10.0)
    # 6. AND THE CONTROL ON ALL OF IT: 300 m from every road and every deck.
    away = _test_building("away", 1500.0, 0.0, 10.0, 10.0, 10.0)

    every = [wall, block, under, ramp, hill, away]
    roads = [
        # The carriageway, straight through the wall blob and clipping the block.
        _test_way([(-60.0, 0.0), (360.0, 0.0)], "primary", width=20.0),
        # Mapped on it, which is what corroborates both of those as crossings.
        _test_way([(-60.0, 0.0), (360.0, 0.0)], "footway", is_foot=True, layer=1, bridge=True),
        # And a viaduct over `under`, which must corroborate nothing at all here.
        _test_way([(560.0, 0.0), (640.0, 0.0)], "motorway", layer=1, bridge=True),
        # A tunnel under `away`, which is not a road anything stands across.
        _test_way([(1450.0, 0.0), (1550.0, 0.0)], "primary", layer=-1, tunnel=True),
    ]
    from .landmarks import Prism

    net = _Net([
        # Over `under`: a soffit 12 m up, clear of a 10 m roof and a storey.
        Prism(_rect(600.0, 0.0, 6.0, 20.0), 12.0, 2.0, "deck"),
        # Through `ramp`: `decks.prisms`' embankment form, base under the ground.
        Prism(_rect(900.0, 0.0, 5.0, 15.0), -0.5, 4.0, "deck"),
        # And under `hill`: the same plan, a solid that tops out 16 m below it.
        Prism(_rect(1200.0, 0.0, 5.0, 15.0), -20.0, 4.0, "deck"),
    ])

    kept, report = resolve(every, roads, _Flat, net)
    by_id = {b.id: b for b in kept}

    if "wall" in by_id or [b for b, _ in report.dropped] != ["wall"]:
        failures.append(
            f"the blob walling a road with a footbridge on it survived:"
            f" dropped {[b for b, _ in report.dropped]}, kept {sorted(by_id)}"
        )
    if "block" not in by_id or not (0.5 < by_id["block"].area / 3600.0 < 0.95):
        failures.append(
            f"the retail block over the same road came back at"
            f" {by_id['block'].area if 'block' in by_id else 0:,.0f} m2 of 3,600,"
            " where the road's arm and nothing else was due off it"
        )
    if (
        "under" not in by_id
        or by_id["under"].area != 900.0
        or by_id["under"].height != 10.0
        or by_id["under"].base_height != 0.0
    ):
        # Measured rather than asserted on faith: with that same viaduct way put
        # into `centre_lines` as though it were a ground carriageway, this
        # building comes back raised to a 5.4 m soffit with 4.6 m of roof left on
        # it -- a terrace floated into the air because a motorway passes over it.
        failures.append(
            f"a building under a viaduct 12 m over it was cut, shortened or lifted"
            f" by the road rules: {by_id['under'].area if 'under' in by_id else 0:,.0f} m2"
            f" of 900, {by_id['under'].height if 'under' in by_id else 0:.1f} m of 10.0,"
            f" base {by_id['under'].base_height if 'under' in by_id else -1:.1f} m"
        )
    if "ramp" not in by_id or not (250.0 < by_id["ramp"].area < 350.0):
        failures.append(
            f"the deck lying on the ground through a building did not cut it:"
            f" {by_id['ramp'].area if 'ramp' in by_id else 0:,.0f} m2 of 800,"
            f" 300 was due; cut {[b for b, _ in report.cut]}"
        )
    if "hill" not in by_id or by_id["hill"].area != 800.0:
        failures.append(
            f"a building with a deck's whole solid 16 m below it was cut as though"
            f" the deck were through it:"
            f" {by_id['hill'].area if 'hill' in by_id else 0:,.0f} m2 of 800"
        )
    if "away" not in by_id or by_id["away"].area != 400.0 or by_id["away"].base_height != 0.0:
        failures.append("the control 300 m from every road and every deck was touched")

    # And the same pass with no deck solve at all is the three rungs it was.
    plain = [
        _test_building("wall", 0.0, 0.0, 20.0, 12.0, 3.0, source="ms"),
        _test_building("ramp", 900.0, 0.0, 20.0, 10.0, 10.0),
    ]
    kept, _ = resolve(plain, roads, _Flat)
    if [b.id for b in kept] != ["ramp"] or kept[0].area != 800.0:
        failures.append(
            f"without a deck network the pass is not the three rungs it was:"
            f" kept {[(b.id, b.area) for b in kept]}"
        )
    return failures


def verify_elevated() -> list[str]:
    """`_verify_resolve`'s six, then the cap's six, on made-up ground.

    The two halves are one gate because the two rules are one seam and a change
    to either moves the other: the cut runs first and hands the cap the plans it
    left, so a cut that took too much and a cap that refused too often are the
    same regression seen from two sides.

    The cap's half, stated as it always was:

    Six, and two of them are negative controls, because the failure mode of a
    rule that lowers roofs is not that it misses one -- a missed one is a pair
    the check still counts and names -- it is that it quietly shortens buildings
    nowhere near a viaduct. And one of them is a control on the *deletion*, which
    is the only thing here that cannot be undone by looking at it again: a real
    building with a deck lying on the ground through a corner of it must come
    back grounded, its full height, and named as refused.

    Costs microseconds and touches no data. Wired into `cli.cmd_build`'s gate
    beside `decks.verify_decks`, which is the pipeline's boot list.
    """
    failures: list[str] = _verify_resolve()

    from .landmarks import Prism

    _building = _test_building
    under = _building("under", 0.0, 0.0, 5.0, 5.0, 20.0)
    beside = _building("beside", 400.0, 0.0, 5.0, 5.0, 20.0)
    clip = _building("clip", 0.0, 100.0, 5.0, 5.0, 20.0)
    through = _building("through", 0.0, 200.0, 20.0, 20.0, 20.0)
    viaduct = _building("viaduct", 0.0, 300.0, 30.0, 5.0, 20.0)
    every = [under, beside, clip, through, viaduct]
    net = _Net([
        # Over `under`: a soffit 12 m up.
        Prism(_rect(0.0, 0.0, 6.0, 6.0), 12.0, 2.0, "deck"),
        # A sliver over `clip`'s northern edge: 0.4 m2, under `DECK_OVERLAP_M2`.
        Prism(_rect(0.0, 105.4, 0.5, 0.4), 12.0, 2.0, "deck"),
        # On the ground through a corner of `through`, whose plan is mostly its own.
        Prism(_rect(0.0, 200.0, 6.0, 20.0), 1.0, 2.0, "deck"),
        # And straight down the middle of `viaduct`, which is the deck's own plan.
        Prism(_rect(0.0, 300.0, 30.0, 6.0), 1.0, 2.0, "deck"),
    ])
    r = cap_under_decks(every, net, _Flat)

    want = 12.0 - DECK_HEADROOM_M
    if abs(under.height - want) > 1e-9:
        failures.append(
            f"the deck cap left a roof at {under.height:.3f} m under a 12.0 m"
            f" soffit; {want:.3f} m was the answer"
        )
    if beside.height != 20.0:
        failures.append(
            f"the deck cap shortened a building 400 m from any deck to {beside.height:.3f} m"
        )
    if clip.height != 20.0:
        failures.append(
            f"the deck cap fired on 0.4 m2 of overlap, under its own"
            f" {DECK_OVERLAP_M2:.1f} m2 floor"
        )
    if through.height != 20.0 or [b for b, _ in r.refused] != ["through"]:
        failures.append(
            f"a real building with a deck on the ground through a corner of it came"
            f" back at {through.height:.3f} m and as {[b for b, _ in r.refused]},"
            " where it should be untouched and refused"
        )
    if [b for b, _ in r.dropped] != ["viaduct"] or any(b.id == "viaduct" for b in every):
        failures.append(
            f"the polygon whose whole plan is the deck was not dropped:"
            f" dropped {[b for b, _ in r.dropped]}, survivors {[b.id for b in every]}"
        )
    if len(r.capped) != 1:
        failures.append(f"the deck cap reported {len(r.capped)} caps where one was due")

    # And the two constants, against the things they are borrowed from.
    if DECK_HEADROOM_M < decks.WALK_UNDER_M:
        failures.append(
            f"DECK_HEADROOM_M {DECK_HEADROOM_M} is under decks.WALK_UNDER_M"
            f" {decks.WALK_UNDER_M}, so a capped roof is a floor with no headroom"
        )
    if DECK_OVERLAP_M2 > 2.0:
        failures.append(
            f"DECK_OVERLAP_M2 {DECK_OVERLAP_M2} is over clash-check's own"
            " MIN_OVERLAP_M2 of 2.0, so a pair it convicts can slip under this rule"
        )
    return failures
