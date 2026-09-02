# Vessels: the railway as solids, not as holes

Written 2026-08-12, after the player asked for a redesign from the ground up.
**Architecture. Supersedes the patch-the-carve approach for stations and corridors.**

## Why the current design cannot be finished

Every rail defect reported over the last week is the same defect:

| report | the two things that disagreed |
|---|---|
| fall into a slot behind every platform | carve rim 9.4 m, deck edge 7.12 m |
| King Street has a hole in it | `streets.py` draws plaza paving, `lanes.py` does not export it |
| slab through the train at Redfern | deck runs to a constant, not to the next track |
| fence marches across the road | fence follows the track, not the walkable edge |
| fall through between the fences | carve removed ground nothing replaced |
| stairs are islands | stairs stand in the slot the deck did not cover |

The world is built by **subtraction and patch**. The terrain is a heightfield;
the corridor carve deletes quads; then trench walls, platform decks, road decks,
verges, fences and stairs each try to put something back, each governed by its
own constant, each ignorant of the others. A gap between any two of them is a
hole the player falls through.

No object owns the sentence *"this is the boundary of the walkable world here"*,
so nothing can assert that the boundary is closed. Sampling checks — walk a body
here, probe a point there — can only ever find the holes they happen to land on.
Three rounds passed their checks and shipped holes.

## The rule

**Build the railway as closed solids inserted into the terrain, not as holes cut
out of it.**

For every station and every corridor segment, construct a **vessel**: a closed,
manifold polyhedron whose outer surface *is* the walkable and visible world, and
whose interior is the void the train moves through. The terrain does not get
carved into fragments that need patching. It gets a boolean footprint — *this
footprint belongs to the vessel* — and the vessel supplies every surface inside
it: floor, walls, rim, deck, soffit.

A trench is a vessel whose interior is open to the sky and whose floor is
concrete. An embankment is a vessel whose top is walkable ground. A viaduct is a
vessel standing on piers. A bore is a vessel with a lid. **They are one object
in four dispositions, not four subsystems.**

### The seam, which is where this design lives or dies

**Every boundary has exactly one owner.** The vessel emits its rim as an
explicit ordered vertex ring in world coordinates, and the terrain is
triangulated *to those exact vertices*. The terrain does not independently
approximate the same curve and meet the vessel at a tolerance.

Two independent approximations meeting at a tolerance is the very bug this
redesign exists to kill, reappearing one level down at the vertex. If anyone
finds themselves writing an epsilon to decide whether a terrain vertex and a
vessel vertex are the same vertex, the design has gone wrong and it needs
saying out loud, not papering over.

**Built, and it holds.** `world/vessel.ts` emits the rim as `Uint32Array`
*indices into its own `position` array* — not a copy of the coordinates, so
there is nothing for a terrain triangulator to re-approximate. There is no
epsilon anywhere in the module: vertex identity is by index, and `checkManifold`
compares positions for **exact bit equality** and reports any two distinct
indices holding one position as a fault, because that is an unwelded seam and an
unwelded seam is a hole. What is still to build in Phase 2 is the other end of
the wire: `terrain.buildTerrainMesh` already drops sub-quads on a barycentric
lattice, and what is new is **conforming the boundary quads to a supplied
polygon** instead of stopping at the lattice.

One consequence worth noticing, because it deletes a hack: `writeTrench` laps its
coping 0.5 m *outward* past the rim onto ground the carve left standing, purely
so a floating-point disagreement about where the rim is shows half a metre of
stone rather than a hairline of void. A vessel needs no lap. Its coping runs
**inward** from the rim, because the rim is not an estimate of a boundary — it
is the boundary, and the terrain has the same vertices.

### Which dispositions own a seam, and which own none

Not every vessel touches the ground, and one that emits a ring it does not own is
making a claim on terrain it has no business withholding.

| disposition | rim ring | where it is |
|---|---|---|
| trench | yes | the two outer top corners, at ground level |
| embankment | yes | the two **toes**, where the batter meets the ground |
| viaduct | **none** | it meets the ground only at its piers; terrain runs under it unbroken |
| bore | **none** | no surface expression at all; only the portals are seams, and a portal is its own vessel |

### What this buys, point by point

- **You cannot fall through it.** A closed manifold has no holes. Not "no holes
  we sampled" — none, provably.
- **You cannot jump into it.** The player's point 6. The vessel's rim is its own
  boundary; above the rim is ground, below is interior, and there is no third
  state to fall into. Where a cutting is genuinely open, the rim carries the
  parapet, because the rim is the thing that knows where the edge is.
- **The fence goes in the right place, for free.** The player's point 4: on an
  overpass the fence belongs on the bridge edge, not the buried rail edge. The
  fence rides the vessel's rim, and the rim is by definition the edge of
  walkable ground. The fence stops knowing about tracks at all.
- **Continuity above and below is one rule.** Their line points 1 and 2 are the
  same object seen from two sides: above the surface the vessel's top is solid
  walkable ground; below it, the vessel's floor is the concrete you run on. The
  floor is not a patch that might be missing — it is a face of the solid.
- **It is checkable exhaustively.** Manifoldness is arithmetic: every edge shared
  by exactly two faces, a consistent winding, a closed Euler characteristic. That
  is a *proof* over the whole world, not a sample of it. It replaces a dozen
  ad-hoc probes with one invariant that cannot pass while a hole exists.

That last point is the reason to do this. Every check written so far can be true
while the world is broken. This one cannot.

## Stations, in the player's order

Processed **radiating out from Central**, so the stations most walked through are
correct first, and each is gated before the next begins.

1. **Platform layout and elevation, per station, specifically.** Sources in
   precedence order: the TfNSW **station CAD drawings** (277 vector PDFs, CC-BY,
   platform numbering, canopy, stairs, underpass, entry — see below), OSM
   `railway=platform` polygons (655, already measured as rotated rectangles),
   and the bake's own vertical profile for elevation. Where they disagree, the
   CAD wins on layout and the DEM wins on height — the standing rule from
   `RAIL-VERTICAL.md` §3.
2. **Layouts true to reality**: real platform faces against real tracks, with
   the running clearance for a train to pass in each direction it needs to. A
   deck ends where the next track's clearance envelope begins — measured, never
   a constant. This is what the Redfern slab violated.
3. **The station building plot**, located exactly, and the step-2 plan aligned
   to it rather than the reverse. The plot is ground truth; the platforms hang
   off it.
4. **Existing buildings on the plot are removed.** Pipeline change: a building
   footprint intersecting a station plot is deleted at bake time, not hidden at
   runtime. Requires a world rebuild.
5. **A generated station building**, aligned to the platform plan, with space to
   walk, a traversable interior and stairs that connect. *Generated from the
   layout by rule — not hand-modelled per station.* The CAD gives the room the
   building occupies and where its openings are; the generator fills it.
6. **No passing into impassible terrain**, which the vessel gives by
   construction: the building and the platform hall are vessels too, plugging
   their own footprints, manifold at every join.

## Along the line

1. **Above the surface** — embankment or viaduct vessel, walkable top, continuous
   ground either side.
2. **Below the surface** — trench or bore vessel, concrete floor, walls to the
   rim, lid only where it is genuinely covered.
3. **The under/over heuristics stay as they are.** The ALCAM register decides
   level crossings, the tunnel register corroborates bores, the cone solve keeps
   the gradient legal. That layer is working and is not in scope.
4. **The fence follows the rim, not the rail.** Overpasses fence the deck edge.
5. **Manifold everywhere**, same as stations.

## What the CAD corpus actually contains

Measured 2026-08-12, after downloading and parsing all of it. 273 station PDFs
from seven CKAN datasets, CC-BY, all vector, **273 parsed with zero failures**.

- **162 stations carry readable text labels. 111 have their text converted to
  outlines** — the letters are drawn as geometry, which is why the outlined set
  runs a median 11,869 paths against 713 for the labelled. Chatswood, St
  Leonards, Glenfield, Olympic Park, Auburn, Ashfield, Bankstown, Belmore and
  Wollongong are all outlined.
- **No drawing carries a scale bar, north arrow, grid or ratio.** Orientation
  and scale must both be solved by fitting; there is no shortcut for any station.
- Page extents run 144–1176 pt wide. Each drawing was fitted to its own A3 page,
  so **scale is per-station**, not a corpus constant.
- The label vocabulary is rich where it survives: `UP`/`DOWN` road direction,
  `PLATFORM n`, `CANOPY`, `ENTRY`, `STAIRS`, `RAMP UP`, `FOOTBRIDGE`, `LIFT n`,
  `TVM`, `BOOKING`, `WAITING`, `WC`, `KERB`, `CAR PARK`, and street names.

**The outlined stations are not lost.** Their geometry is complete; only the
labels are missing. OSM already supplies platform identity through `ref` tags on
its 655 platform polygons. So **CAD gives shape, OSM gives identity** — a clean
division that avoids OCR entirely and keeps the two sources doing what each is
actually good at.

Georeferencing therefore fits a similarity transform per station — rotation,
uniform scale, translation, and mirror as an explicit hypothesis rather than
something allowed to hide inside a rotation — against two independent anchors:
the OSM platform rectangles, and the station building footprint that already
exists in the world data. Their disagreement is the error estimate. A station
whose residual is poor is **rejected**, falling back to today's behaviour: a
rejected station is survivable, a confidently wrong one puts a staircase in
someone's lounge room.

## Sequencing, and what it costs

- **Phase 0 — the CAD corpus.** Fetch and extract all 277 PDFs; fit each to the
  OSM platform rectangles with a similarity transform; gate on fit residual.
  Cheap, no rebuild, and it is the input everything else needs. This was already
  scoped and deferred; it is now the critical path. **Done** — 273 sheets
  extracted, 62 georeferenced and accepted. See *The CAD corpus, measured*
  below for what the drawings turned out to be.
- **Phase 1 — the vessel primitive. Built 2026-08-12; see below.** One data
  structure, a manifold check, and the trench case, proven at one station.
  Nothing ships until the invariant holds.
- **Phase 2 — corridor vessels** replacing carve-and-patch along the line.
- **Phase 3 — one vessel per formation. Built 2026-08-13; see below.** The
  station vessels this slot used to hold move to Phase 3b: nothing can be built
  at a station until the corridor through it is one object.
- **Phase 4 — plots and generated buildings.** The only part needing a world
  rebuild, so it batches with the other pending pipeline work (bushland ground,
  `elevated.py` and railways, the road-spanning prisms).

**Honest costs.** Phase 4 is a full world rebuild, hours of pipeline. Phases 1–3
are client and bake only. ~~The vessel geometry is more triangles than the
current patches~~ — **measured in Phase 1 and this was wrong**: a corridor
vessel is 2.0–2.5 triangles per metre against 2.3/m for `writeTrench`'s walls
alone, and it replaces the verge, the formation floor and the deck soffit as
well. Swept per run it is 13% *cheaper* than per segment. A whole 512 m chunk at
Redfern builds and is fully manifold-checked in 10 ms against a 150 ms budget.
And the 2016 CAD drawings are stale in places, the Metro conversion especially;
a good fit residual proves alignment, not that the layout still exists.

## Phase 1, built: what was proven and what it changed about the plan

Written 2026-08-12. `client/src/world/vessel.ts`, its boot self-check in
`main.ts`, and `checkVessels` in `server/integration-check.ts`. **Behind
`vesselsEnabled()`, default off, with no call site consulting it.** `RailCut`,
`PlatformField`, `RoadDeck`, `writeTrench` and `writeVerge` are untouched and
still build the world.

### The invariant holds on real data

`checkManifold` is arithmetic over every edge of every triangle: each directed
edge exactly once, each with its opposite present (which is *closure* and
*consistent winding* in one condition), no degenerate face, no two distinct
indices at one position, positive signed volume. No sampling and no threshold.
The Euler characteristic is *reported*, not asserted, because a trench is a
sphere and a bore is a torus and a check that demanded χ = 2 would reject every
tunnel in Sydney.

Swept from the real bake, with rail heights from the bake, half-widths from
`RailCut.halfWidthAt` and rims from the DEM — the same three sources
`writeTrench` uses, in the same places:

| run | vessels | result |
|---|---|---|
| Erskineville, 300 m radius | 45 segments | **45/45 closed**, 2,828 triangles |
| Redfern, one 512 m chunk | 156 segments | **156/156 closed**, 10,976 triangles |
| every trenched segment in the extract | 8,360 over 340 km | **8,360/8,360 closed, 0 refused** (13 more skipped, no terrain loaded) |

The first two rows are asserted in CI (`SYDNEY_CHECK_ONLY=vessels`). The third
was measured once, tonight, by sweeping the whole network from a scratch script
— it takes 0.5 s, so it is cheap to promote into the suite when Phase 2 has
something the whole network needs to be true of.

Negative controls, run at boot and in CI against a *real* vessel: punch a
triangle out → exactly 3 boundary edges; flip one face → exactly 3 doubled
directed edges; unweld one vertex → exactly 1 duplicate position; collapse one
face → exactly 1 degenerate face. Each caught as *itself*, so no control can
pass by tripping a different fault.

### The numbers

- **2.0–2.5 triangles per metre** of corridor, against 2.3/m for `writeTrench`'s
  two walls alone over the identical run — **1.07×**. And the vessel supplies the
  floor, the buried skin and the closure, which the walls do not, and it makes
  `writeVerge`, `writeFormation` and the road-deck soffit redundant in the same
  footprint. *The premise that vessels cost materially more triangles than the
  patches is wrong; on this evidence Phase 2 is triangle-neutral or better.*
- **Sweep 55–100 µs per vessel; manifold check 1.1–1.5 µs per triangle.** A whole
  512 m chunk at Redfern — 156 vessels, 11k triangles — builds **and is fully
  checked** in **10 ms idle, 19 ms with the rest of the suite running**, against
  the 150 ms that chunk's rebuild already costs.
  The whole city, 340 km, sweeps and checks in **0.5 s**. The invariant is cheap
  enough to run on every vessel in every build, which is what makes it an
  invariant rather than an errand.

### The one thing that changes the Phase 2 plan

**A closed vessel per segment does not give a closed corridor.** Each is
individually manifold, provably; two abutting at a shared endpoint are not,
because the corridor turns there and the outside of the bend is left with a
wedge between two rim rings that never meet. Measured over all 7,443 shared
endpoints between two trenched segments: median turn 1.6°, p90 4.7°, p99 8.0° —
at a 9.4 m station half-width that is a rim gap of **26 cm, 76 cm and 1.31 m**,
and **1,908 joins gap by more than half a metre**. `writeTrench` survives this
only by overlapping consecutive segments 0.5 m at each end, a fudge available to
a surface and not to a solid.

So the mitigation is not "per-segment vessels with explicit joins". It is to
**stop cutting the corridor up**: sweep one vessel per *run* of trenched
segments, with a rib at every network vertex, and the bend is mitred because the
two panels share that rib's vertices by index. There is then no interior join to
gap, because there is no interior join. Measured across the extract, chaining
8,373 trenched segments into **930 runs** (median 243 m, longest 5.0 km):

- **908 of 930 sweep sound and closed**, 679k triangles over 332.9 km — **2.04
  triangles per metre, 13% fewer than per-segment**, because 7,443 *pairs* of
  interior end caps go away.
- **6 folds**, refused rather than emitted: Central ×3, Redfern, Macdonaldtown,
  Lidcombe. Every one is in a station throat where the deduplicated network
  chains a run straight through a crossover and reverses it.
- **4 rim rings self-intersect in plan**: Redfern, Central Chalmers Street,
  Epping, Strathfield. Every one is a junction or a balloon loop where the
  footprint genuinely overlaps itself.
- 12 runs skipped for unloaded terrain.

That residual is 1.1%, and **it is all at junctions** — which is exactly where
this approach was predicted to strain, and the prescribed answer is right:
*union the footprints at a junction rather than overlapping two sweeps.* Phase 2
needs a junction vessel that takes the union of the converging runs' plan
footprints and sweeps nothing through it. The fold detector already refuses the
cases that need one, by name and by location, so the work is bounded and
enumerable rather than discovered by a player falling into it.

### Where Phase 2 will strain

Four things, found by building the primitive rather than by planning it. None
of them invalidates the design; all four are unbuilt.

1. **The terrain conformer is the unbuilt half of the seam rule, and it is where
   the epsilon will try to come back.** The vessel emits a ring; nothing consumes
   it yet. `buildTerrainMesh` works per tile, in tile-local coordinates, on a
   fixed lattice — so conforming to a world-space ring means clipping the ring at
   tile boundaries and constrained-triangulating between the lattice and the
   clipped ring. **Those clip points are a second seam of exactly the same kind**:
   the vertex where a ring crosses a tile edge must be one vertex shared by two
   tiles, by exact value, or the whole argument has been moved one metre sideways
   rather than won. Compute it once, per edge crossing, in a table both tiles
   read — do not let each tile clip its own copy.
2. **A profile cannot change topology mid-sweep, and a platform is a change of
   topology.** The sweep pairs rib to rib index by index, so every rib of one
   vessel must have the same number of points. A platform deck is a step in the
   `U` that exists for 160 m and not before or after. Collapsing those points
   onto their neighbours outside the platform produces two vertices at one
   position — which `checkManifold` correctly calls an unwelded seam. So Phase 3
   needs a **transition rib**: a stitch between two *different* polygons at one
   station, emitted into the same mesh so the two share vertices by index. That
   is the annular cap generalised, perhaps forty lines, and it should be built
   before the first station rather than worked around.
3. **A road over the corridor is a local change of disposition**, trench to bore
   and back, which is the same topology problem as (2) — the lid appears and
   disappears mid-run. The level crossing is the opposite case and easier: the
   vessel simply must not exist there, which `RailCut`'s existing road rule
   already decides.
4. **Nothing consumes a vessel for collision.** `CollisionWorld` indexes prisms;
   a shell is not a prism set. Either the vessel gains a prism decomposition —
   which is a *third* description of the same boundary and therefore exactly the
   thing this design exists to stop — or the collision world learns to take a
   manifold directly. The second is the honest one, and it is not costed.

### Two smaller findings

- **A disposition that contradicts the measured clearance is refused, not
  clamped.** An embankment whose crest is below the ground builds an inverted
  trapezoid, and `loopFault` rejects it. That is `RAIL-VERTICAL.md` §2 turned
  into geometry: Chatswood tagged `elevated` at 6.90 m *below* the grid would
  fail to build rather than draw wrong.
- **Ear clipping never fires on a bore.** The annular cap is a strip pairing the
  outer and inner loops index to index, which is why the module contains no
  hole-bridging code and therefore no duplicated bridge vertices for the weld
  check to trip over. The price is that a holed profile needs equal loop counts,
  which is free because both loops are generated.

## What this does not change

The timetable, the phase solver, riding, announcements, the clearance envelope,
the height solve and the two registers all stay. This is about how the geometry
is assembled, not about where the railway goes.

## Collision: the sweep is the authority, not the mesh

Phase 1 ended on the right open question. `CollisionWorld` indexes prisms, and
nothing consumes a vessel. The two obvious answers are both wrong:

- **Decompose the vessel into prisms.** That is a third description of one
  boundary, kept in step by diligence — precisely the failure this redesign
  exists to end.
- **Give collision a triangle mesh and a BVH.** Honest, but it makes every
  ground query a ray cast against geometry, where today it is arithmetic, and
  the ground query runs per player per tick on the server.

Take neither. **The authority is the sweep — the centreline and its profile —
and both the mesh and the collision answer are derived from it.**

A point query becomes: project to the centreline to get arc length `s`,
interpolate the profile at `s`, take the lateral offset, and test that 2D
polygon. Exact, O(1) behind a spatial index on the centreline, and no third
description of anything. The mesh is how the sweep is drawn; the evaluation is
how the sweep is asked. Neither is primary and they cannot disagree, because
there is nothing for them to disagree about.

This is not a new pattern here — it is what `PlatformField` already does, and
for the same stated reason: the drawn prisms exist only in a browser and only
near the player, so the arithmetic version is the one the server can answer
from. That worked. Generalise it rather than inventing something.

The rule this leaves, which is the rule the whole document is about: **a
boundary may have many renderings and exactly one definition.**


## The CAD corpus, measured

Phase 0a fetched 273 station sheets (`data/scratch/stationcad/<slug>.json`,
`scripts/stationcad.py`). Phase 0b fits each to the world
(`scripts/stationfit/`, output `data/scratch/stationcad/fit.json`). What the
corpus actually is, as measured rather than assumed:

**The extractor writes two different vertical conventions.** Text `y` comes from
the glyph matrix and is PDF space, y up from the MediaBox bottom. Path points
come from pdfplumber's object `pts`, which are display space, y *down* from the
page top. `_extract_paths`' docstring says they line up; they do not. Anything
reading the JSON must flip the paths by the MediaBox height first
(`scripts/stationfit/cadgeom.mjs` does). The `bbox` field mixes both spaces and
means nothing.

**The platform lettering is the georeference.** Each sheet letters every
platform repeatedly along its length -- six to nine times for a 170 m
platform -- and the *extent* of that lettering tracks the slab. Fitted scale
against known platform length comes out at a median ratio of 1.000, with a
5-95 range of 0.96-1.03 over 117 platforms. That is the whole method: the
lettering gives the platform's line and its two ends, OSM gives its identity
and its true length, and Umeyama gives the transform.

**Handedness is a property of the corpus, not of the station.** A plan is drawn
looking down; it is never a mirror image. Fitting all four combinations of
end-pairing and handedness, 17 of the 20 stations whose platforms decide the
question unaided came out orientation-reversing (page y up, world z south), and
the three that did not were within 1.6x of their rival, i.e. undecided. The fit
now imposes it. This matters more than it sounds: **a platform rectangle has no
distinguishable ends**, so "reversed end-for-end plus a reflection" fits almost
every station about as well as the truth. Fixing handedness removes it.

**The sheets are not north-up, and the north point is decoration.** Every sheet
is rotated so the corridor runs across the page, so the fitted page-up bearing
is scattered over the whole circle. The standard north-point block (a 6.8 pt
circle with an inscribed needle) is on the sheets, but it could only be detected
reliably on 3 of 273, and where it was, it is drawn to about +/-15 deg -- at
Allawah the platforms fix the rotation to 0.8 m RMS with the runner-up 24x
worse, and the needle still reads 16 deg off. It is reported in `fit.json`
and never gated on.

**Scale is per-station, but coverage is a drafting habit.** Metres per page
point runs 0.26 to 0.72, median 0.402, and does *not* cluster at standard ratios
-- each drawing was fitted to its own page. What does cluster is the length of
railway the sheet spans: 479 m median, 428-552 m at the 10th and 90th
percentiles, across A3 landscape, A3 portrait and A4 sheets alike. A candidate
fit implying a sheet covering 200 m or 1.6 km has mismatched something, and that
is now a gate.

**Many sheets carry more than one view** -- a concourse plan above the platform
plan, sometimes four views on one page. One similarity transform cannot cover
them; only the view the platforms were fitted in maps to the world. Every
accepted record therefore carries `validRegionPt`, the page rectangle the
transform is good over. Outside it the inverse map is meaningless.

**111 sheets have their text converted to outlines**, so the lettering is
geometry. No OCR is needed -- a word is a cluster of small glyph paths, and
"PLATFORM n" is recognisable by glyph count and aspect -- but identity is not
recoverable that way, so those sheets are matched to OSM by arrangement alone.
That is much weaker, and it produces false accepts that look fine on the
numbers: Lidcombe matched two of its three platforms at 3.1 m RMS on a reading
one band out, and the drawn platforms and the fitted rectangles visibly diverge.
Arrangement-matched sheets are therefore held to accounting for *every*
platform. Four of 83 survive.

**OSM's platform polygons are not one-per-platform.** At Allawah each island is
mapped twice, once per platform number, as two ~9 m polygons whose centres are
5 m apart and which overlap by metres. Fitting to face centres would be fitting
to a mapping artefact, so `osm.mjs` merges overlapping parallel faces into slabs
and fits to the slab. The individual faces are only used where a station has a
single slab, because there they are the only thing that tells its two sides
apart.

**96 sheets are outside the world.** Newcastle, Wollongong, the Blue Mountains
past Springwood, the Southern Highlands and the Hunter are all in the CAD
dataset and none of them are in a 60 km bake. They are recorded as rejected with
that reason rather than silently dropped.

### What the fit delivers

62 of 273 accepted: 20 high, 18 good, 15 fair, 9 exactly-determined. Residual
over the 53 with a residual to read: 2.8 m median, 6.2 m at the 90th percentile,
7.9 m worst, and no single correspondence worse than 10.8 m. The gates are 8 m
RMS and 16 m worst -- a platform is ~10 m wide, so a fit approaching half a
platform width cannot be trusted to put a structure on the right side of the
track.

The nine "determined" stations have one platform, which is two correspondences:
the transform is determined exactly and there is *no residual to read*. They are
accepted only because the station building footprint, which is not part of the
fit, lands within 45 m. Treat them as the weakest class.

The station building is the second, independent anchor throughout: the median of
the sheet's building lettering (`BOOKING`, `WAITING`, `TVM`, `WC`...) mapped
through the fit, against the OSM `building=train_station` footprint. It agrees
to 19.7 m median, 61 m at the 90th percentile -- coarse, because both ends of it
are crude, but it is what breaks the 180-degree ambiguity at 9 stations and what
corroborates the 9 determined ones. Where it is much worse than that, read it as
the error bar the two sources disagree about, which is the point of having two.

`scripts/stationfit/check.py <slug> <out.png>` draws the fitted OSM rectangles
back onto the sheet. The residual is a number; that is the picture, and no fit
should be believed without looking at one.

## Phase 2a, built: the seam closed at both ends, and three corrections

Written 2026-08-12, after building the terrain conformer and the collision
evaluation. `client/src/world/seam.ts`, `world/vessel-field.ts`,
`world/corridor.ts`, the rim-cut path in `world/vessel.ts`, the seam path in
`world/terrain.ts`, and `checkVesselSeam` in `server/integration-check.ts`.
**Still behind `vesselsEnabled()`, still default off** — `?vessels=1` in a
browser, `SYDNEY_VESSELS=1` on the server — and with the flag down the world is
the one that shipped. `RailCut`, `PlatformField`, `RoadDeck`, `writeTrench` and
`writeVerge` are untouched.

### The second seam does not need a table, because it does not need to exist

Phase 1's first strain was right about the danger and wrong about the fix. The
prescription was: the rim crosses the terrain lattice, two tiles would each clip
their own copy of the crossing, so **compute each crossing once into a table both
tiles read**.

That table has exactly one honest reader, and it is not the terrain. A crossing
computed by the terrain and *used* by the terrain still puts a vertex on the
interior of an edge the vessel draws as one quad — a **T-junction**. Not a hole,
but two descriptions of one edge, which is this project's oldest bug at a smaller
scale, and the scale below that is where it stops being findable.

So the crossing is given to the **vessel**, which splits its own rim edge there.
`seam.latticeCuts` walks the vessel's two seam polylines by index into its own
`position`; the run is swept a second time with those points as `RimCut`s; and
*that* vessel is the artifact both consumers read. A tile asking about a crossing
is asking about a vertex of the mesh beside it, by index, like every other rim
vertex. There is no table, no comparison and no epsilon on the path.

Measured at Erskineville: 8 runs, 1,149 m, **757 lattice crossings absorbed into
the rim**, and all 8 still closed 2-manifolds afterwards — the split is a change
to the solid and `checkManifold` re-proves it rather than trusting it. All 757
are in the ring at bit-identical coordinates. The second sweep costs 55–100 µs on
a run that takes milliseconds to check.

The premise the whole arrangement rests on is asserted rather than assumed: the
sub-quad lattice is `500 / 16 / 8` = **3.90625 m**, which is `125/32` and exact in
binary, and all four bounds of all 18,113 tiles are exact multiples of it. So
"where the rim crosses line *m*" is one number in every tile that can see it.

### The cell walk needs no point-in-polygon either

Tracing the ground a cell keeps sounds like it needs to decide which side of the
rim a point is on, which is a test at its worst exactly where it is asked. It
does not. With the perimeter direction written `p = rot90(n_out)` and the ring
direction `r = a·n_out + b·p`, `cross(r, p) = a` — so the arc after a crossing is
inside the footprint exactly when the ring is *leaving* the cell. The whole
classification is "is this the start of a chain or the end of one": combinatorial,
exact, and self-checking, because entries and exits must alternate around the
perimeter or the cell is refused by name rather than drawn.

The invariant asserted is an **area**, because area cannot be satisfied by a
plausible wrong answer: the ground the cells keep plus the ground the rims
enclose must equal the ground there was. Through the real `buildTerrainMesh` on
the real Erskineville tile: 245,545.5 m² drawn + 4,454.5 m² enclosed = 250,000 m²,
a residual of **-0.0001 m² over a 250,000 m² tile**. And its negative control: not
one of the 1,903 drawn triangles has its centroid in a cell the railway owns,
where the same builder with no seam puts 6 of them straight over the corridor.

The rim also lands **on** the DEM. Because `spineForRun` samples the ground at
exactly the coordinates the sweep will place the vertex, the worst disagreement
between a rim vertex's own height and `TerrainField.height` at its own x, z is
**0.000000 m** over 302 vertices. Stepping across the rim at 473 places, ten
centimetres either side, the worst height difference between the terrain outside
and the coping inside is **14.1 mm** — which is the DEM's own slope over 20 cm,
not a crack. `writeTrench`'s outward coping lap has nothing left to hide.

### Correction 1: the sweep's authority includes its triangulation rule

The collision resolution says to "project to the centreline to get arc length s,
interpolate the profile at s, take the lateral offset, and test that 2D polygon".
**That is a bilinear surface and the sweep does not draw one.** A swept quad on a
turning centreline is *skew* — its four corners are two segments at different
heights on two rib lines that neither meet nor are parallel — so bilinear and
planar agree at the corners and nowhere between.

Measured against the drawn floor: at Erskineville a mean of 1.93 mm and a worst of
**132 mm**; at Redfern a worst of **729 mm**, with a fifth of all samples over a
millimetre. That is not a rounding difference, it is a different surface.

So the definition is the ribs **and how the faces between them are cut**, and both
the mesh and the evaluation read that one definition. `world/vessel-field.ts`
indexes `Vessel.index` off the centreline through `Vessel.sideFace` and evaluates
the plane of the face it finds. **This is not the triangle BVH the document
refused**: a BVH is a second structure built by walking geometry that knows
nothing about what the geometry means, descended by ray casting. This is a lookup
from a plan cell to *a rib segment of the sweep* — the centreline index the
document prescribes — and then a walk of the eight faces that rib segment
emitted. O(1), no allocation, ~4 µs per point including the oracle's own
overhead. Re-deriving the profile arithmetic would have been a second
implementation of the sweep's own zip, which is the duplication under a new name.

The result: the ground query and the drawn surface agree at **all 8,141 sampled
points**, compared with `Object.is`. Both ends run it — `main.ts`'s
`groundHeightAt` and `server/world.groundFor` carry the identical clause in the
identical position over a field built by the identical module — and two
separately-evaluated copies of `world/corridor.ts` build 8 vessels whose every
vertex is bit-identical.

### Correction 2: the union is not a junction case

Phase 1 predicted the footprint union would be needed **at junctions**, enumerated
22 runs that need one, and called the residual 1.1%. That measurement was about
the *closure of individual runs*. Nothing had ever consumed a footprint, so
nothing had measured how the footprints relate to each other.

They overlap almost everywhere. Each track in the bake is its own polyline, so
each becomes its own run, and two running lines four metres apart with a 5.4 m
half-width — 9.4 m at a platform — occupy the same ground along their whole
length. Measured:

| | Erskineville | Redfern |
|---|---|---|
| lattice cells the railway claims, claimed by more than one run | **61.5%** | — |
| points in the footprint covered by more than one vessel | **70%** | **78%** |
| ...of those, disagreeing about the surface by over 1 m | 392 | 1,517 |
| ...by over 3 m | 226 | 895 |
| worst disagreement | **8.28 m** | **9.36 m** |

The terrain side handles this correctly and exactly: `SeamField` pools the chains
of every footprint crossing a cell into one arrangement and keeps the arcs at
depth zero, with the depth computed **per footprint and then summed** — a running
counter over pooled chains cannot work, because two rims can between them cover a
cell that neither covers alone. `CELL_INSIDE` beats `CELL_CROSSED`, and getting
that ordering the other way round (which the first draft did) draws one run's kept
ground straight across the next run's trench.

The *geometry* side does not. Where two runs' floors are at different depths the
shallower one's solid contains the deeper one's void, and its coping is drawn as a
strip of stone over an open cutting. The mesh and the evaluation still agree
exactly — they always do — and here they are both wrong together.

**So Phase 3 needs one vessel per formation, not one per track**, and that is a
larger change than the junction union that was scoped. The junction union is a
special case of it.

### Correction 3: the two ends do not seed the flare from the same list

`server/world.ts` says of `RailCut.setStations` that `riding.buildPlatforms`
resolves *"the same anchors from the same bake, which is what makes the two
answers the same number rather than two numbers that agree today"*. They are not
the same list. `main.ts` uses `rail-geo.buildNetwork().stations`, which adds a
fallback for stations *nothing calls at* — a rail within 60 m of a platform the
modelled network never reaches.

Measured on this bake: **358 sites on the server, 361 on the client**, and sampled
every 6 m along every platform in the city, **87 of 29,479 points get a different
half-width, by up to the full 4.00 m of the flare.** Today that is nearly
harmless, because it is a carve on one end and a ground query on the other and
nothing stands in the difference. It stops being harmless the moment the rim is
the edge of the walkable world, which is what this phase makes it.
`world/corridor.ts` therefore builds its own `RailCut` seeded from
`buildPlatforms` on both ends.

### What is refused, and what it costs

- **A cell where two rims properly cross inside one 3.9 m square.** The
  arrangement has a vertex the cell walk has no node for; it is named and the
  cell is **dropped**, so the area residual above is the exact bound on what it
  costs. At Erskineville that is 12 cells of 359 crossed (3.3%), 1 in the tile
  measured. Same class as the junction footprints, at cell scale.
- **A rim segment lying exactly *along* a lattice line.** Zero over the real
  corridor and refused by name where it is not, because a segment collinear with
  a cell edge belongs to neither cell either side of it.
- **A road changing the disposition mid-run**, trench to bore and back, which is
  Phase 1's third strain and is unchanged. With a seam the terrain still asks
  `RailCut.deckedAt`, so a street over a cutting keeps its ground and its soffit;
  what is not built is the lid on the vessel.

### The numbers

- **3.39 triangles per metre** at Erskineville against Phase 1's 2.04 for the same
  runs — the difference is the 757 rim vertices the lattice added and the
  pentagons they make of the two coping quads. Still under `writeTrench`'s walls
  *plus* the verge, the formation floor and the deck soffit it replaces.
- **19–24 ms** to sweep, cut, re-sweep, index and seam 1,149 m of corridor at
  Erskineville; **5.0 s** for the whole 340 km network on the server at boot
  (923 runs, 1,082,212 triangles, 7 refused, 10 without terrain), which is why the
  server builds it all at once and the client rebuilds a 900 m disc as tiles land.
- **~4 µs per ground query** including the measurement harness's own overhead,
  against a per-player-per-tick budget. Arithmetic behind a plan index.


## Phase 0c: the track centrelines, and where they stop being enough

Phase 0b's own recommendation, taken up on 2026-08-13: fit the drawing's
**track centrelines** against the baked rail polylines instead of its platform
lettering, because track geometry is on every sheet whether or not the
lettering survived outlining, and a railway curves asymmetrically. Code in
`scripts/stationfit/trackfit.py`, `trackgeom.py`, `railbin.py`; overlays from
`checktrack.py`; output `data/scratch/stationcad/trackfit.json`, which does not
replace `fit.json` and is written beside it.

**Two premises of the last round were wrong, and both are corrected here.**

**Central, Town Hall, Wynyard, North Sydney and Sydenham are not in the corpus
at all.** They were not lost to a difficult fit; the Transport for NSW open-data
"Station CAD Drawings" collection does not contain them. Re-querying CKAN
returns the same seven alphabetic datasets and the same 273 PDF resources the
manifest already has, and Toongabbie is followed by Towradgi with no Town Hall
between them. The four Airport Line stations (Mascot, Green Square, Domestic,
International) *are* published, in a separate `train-station-plans` dataset that
Phase 0a excluded as a different kind of document; they were not fetched and are
the only per-station sheets known to be missing from the cache.

**A sheet draws 205 m of railway, not 479 m.** The 479 m figure above is the
page width times the fitted scale, and most of the page is margin, title block
and a second view. Measured directly — the along-corridor span of the sleeper
hatching over the 62 sheets Phase 0b accepted — the railway actually drawn is
205 m at the median, 174 m at the 10th percentile and 252 m at the 90th. The
`COVERAGE_M` gate is still a fair gate on the page, but nothing should read it
as the length of line a sheet covers.

**The extractor now writes one coordinate space.** `scripts/stationcad.py`
flipped nothing and emitted pdfplumber's y-down path points beside y-up text,
which made its own `bbox` meaningless and forced every reader to know. The flip
now happens once, in `_extract_paths`, and `cadgeom.mjs`, `render.py` and
`check.py` just read. All 273 sheets were re-extracted and `fit.mjs` re-run:
272 of 273 records are byte-identical and the odd one out is Mortdale, still
rejected, differing only where a rounding tie picked a different near-duplicate
candidate. Same answer, one definition.

### The method

A CAD sheet draws every running line as a sleeper ladder and draws that ladder
on nothing else, so the **midpoints of the short cross-corridor strokes are a
sample of the drawn track centrelines** — a far cleaner detector than any
long-chain heuristic, because a fence, a coping and a kerb are all long lines
parallel to the corridor and none of them is hatched. Two refinements were
needed and both are measured, not assumed:

- On outlined sheets the glyphs of "PLATFORM 4" are short strokes too, and the
  lettering runs along the platform, so raw ticks lay a false ladder down the
  middle of every platform. Ticks are therefore kept only as part of a **run**
  — chained at 1.1 pt of shared centreline — of at least 45 pt. A word is
  25 pt.
- `dominantAxis` is the corridor on most sheets and the **sleepers** on sheets
  that draw them long: at Petersham 733 sleepers outweigh two rails and four
  platform edges and it comes out 84 degrees off, after which everything
  measures along for across and finds nothing. The axis is now chosen by trying
  both and keeping whichever produces a ladder.

The fit is then a similarity solved as Phase 0b's is, with the same imposed
handedness, by a rotation sweep about two hypotheses 180 degrees apart, a scale
sweep, and a corridor-aligned translation grid scored against a Gaussian reward
image of the baked tracks. The objective is the geometric mean of a forward
term (drawn ticks landing on baked track) and a reverse term (baked track being
drawn), because forward alone is maximised by shoving every tick onto one rail
and reverse alone by shrinking the sheet until it need only explain a few
metres — which is exactly what the first version did at Allawah, settling on
0.274 m/pt against a true 0.389.

The tracks cannot answer everything, so **the platforms finish the job**: with
rotation and cross-corridor position already fixed, the OSM slab says where to
look and the drawn coping found there gives the along-corridor position from
its ends. That removes the combinatorial guessing that made Phase 0b weak on
outlined sheets — there is no question of which platform is which.

### What it delivers, and the ceiling

**Two sheets accepted: Strathfield and Arncliffe**, at 0.92 m and 1.92 m RMS
against the baked centrelines, both with every OSM slab matched end to end to
better than 5 m, both rendered and looked at. Strathfield is one of the inner
stations this round existed to reach, and its eight tracks land on the bake's
eight, grouped [1][2][2][2][1] across the corridor on both sides.

That is a small number and the reason is worth stating plainly, because it is a
property of the evidence and not of the search:

> **Track centrelines do not determine scale.** A suburban corridor is two
> nearly parallel curves. Stretch the drawing 8 per cent about its centroid and
> every drawn track is still on a baked track. Measured over the 147 sheets
> that produced a transform, an 8 per cent stretch costs the objective 1.4 per
> cent at the median and 7 per cent at the 90th percentile, even with the
> reward tightened to 1.5 m; it costs 10 per cent or more at only 8 sheets.
> Those are the sheets whose corridor has enough tracks, or enough curvature,
> to say. An 8 per cent scale error is 13 m at the end of a 170 m platform, so
> a fit whose scale nothing fixes is not a fit, and `SCALE_MIN_DROP` rejects
> it. Eleven sheets are rejected for that reason alone.

This is the honest limit of the idea, and it is the mirror image of Phase 0b:
the lettering fixes scale from a known platform length and is weak on
orientation; the tracks fix orientation and cross-corridor position to about a
metre and are blind to scale. Neither is a replacement for the other.

### The two methods against each other

Of the 62 sheets Phase 0b accepted, 31 also produced a Phase 0c transform that
explains the corridor (RMS ≤ 4 m, ≥ 85% covered). Putting the same drawing's
ticks through both transforms and measuring the gap in metres:

- **12 of 31 agree within 10 m**, median disagreement 12.7 m over the whole set.
- Scale ratio 0c/0b has a median of 0.936 and a 10–90 range of 0.84–1.29. The
  two methods do not agree about scale, which follows from the paragraph above;
  where they were checked by eye against the drawn coping ends, Phase 0b looked
  right at Villawood and Phase 0c looked right at Arncliffe, so this is not
  settled and neither should be trusted to better than about 10 per cent unless
  its scale is independently determined.
- **8 of 31 read the sheet end for end differently**: Asquith, Clarendon,
  Hurlstone Park, Kingswood, Leightonfield, Pendle Hill, Point Clare, Yennora.
  At those the two placements are 180 degrees apart and around 90–120 m out,
  which is a wrong-side-of-the-track error. One of the two methods is wrong at
  each of them and this round cannot say which, so **those eight Phase 0b
  accepts should be treated as unresolved** until something independent
  separates them.

### What remains unfittable, and why

Of 273 sheets: 96 are outside the 60 km world; 23 are stations the bake carries
no service polyline through at all (`lines: []` — the Cronulla branch, the Blue
Mountains past Emu Plains, the South Coast, the Southern Highlands), so there is
no track to match; 3 carry no measured platform polygon; 3 do not hatch their
tracks densely enough to recover a ladder. Of the rest, 65 are rejected on track
residual — the fit found a wrong placement, and at the biggest sheets (Redfern,
Chatswood, Auburn, Bondi Junction, both Blacktown sheets) that is where the work
would go next. Chatswood carries six views on one page and its 2016 drawing
predates the Metro conversion, so it may not be fittable at all. 33 are rejected
for undetermined scale, 22 because the drawn coping and the OSM slab disagree
about where the platform is along the line.

`scripts/stationfit/checktrack.py <slug> <out.png>` draws the baked
centrelines, the recovered ticks and the OSM slabs back onto the sheet. Sixteen
accepts came out of the run before the scale gate was added; all sixteen were
rendered and looked at, and one of them — Dulwich Hill, 4.36 m RMS — was
visibly wrong, which is what set the residual gate at 4 m. The rule from last
round held again: an unrendered accept is not an accept.

## What the CAD can and cannot be (settled 2026-08-13)

Phase 0c established the constraint that decides how Phase 3 must work:

**Central, Town Hall, Wynyard, North Sydney and Sydenham have no published CAD
sheet.** Not withheld, not badly drawn — absent. The seven alphabetic datasets
hold 273 station sheets and none of these is among them. No fitting method
reaches a drawing that does not exist.

So the plan's step 1 — *determine each station's platform layout and elevation
specifically* — **must be satisfiable without CAD**, because it must be
satisfiable at Central. The foundation is OSM plus the bake:

- 655 `railway=platform` polygons, 453 attached to a station, measured as
  minimum-area rotated rectangles with length, width, heading and `ref`
  numbering, island-versus-side decided off the track;
- the bake's own vertical profile for elevation, which is authoritative anyway
  under `RAIL-VERTICAL.md` §3;
- the station building footprint, which already exists in the world data.

**CAD is enrichment, not foundation.** Where a sheet fits, it adds what OSM does
not carry: canopy extents, stair and ramp positions and orientation, underpass
versus footbridge, entry points, and the internal rooms. Where it does not fit,
the station is still built — with less interior detail and no loss of
correctness.

### The two fitting methods are complementary, and neither is sufficient alone

- **Lettering** (Phase 0b) pins **scale** — fitted scale against known platform
  length runs median ratio 1.000, p5–p95 0.96–1.03 over 117 platforms — but is
  weak on orientation, because a platform rectangle has no distinguishable ends.
- **Track centrelines** (Phase 0c) pin **orientation and cross-corridor
  position** to about a metre, and are nearly **blind to scale**: an 8% stretch
  costs the objective only 1.4% at the median, because a suburban corridor is
  two nearly parallel curves and a stretched drawing still lands on baked track.

A joint fit is the obvious next step if coverage is ever worth more spending. It
was not taken now: the 111 outlined sheets have no lettering to contribute
scale, so the gain is confined to suburban stations, and the stations that
matter most have no sheet at all.

### Two accepted facts corrected

- A sheet draws **205 m of railway** (median; 174–252 m at p10/p90), measured
  from the sleeper hatching. The earlier 479 m was page width times scale, most
  of which is margin, title block and a second view.
- The extractor's mixed y-axis is **fixed at source**, so the JSON is entirely
  PDF page space, y up, and `bbox` means something. Re-extracting all 273 left
  272 records byte-identical, which is itself the check that the fix was inert.

### Eight Phase 0b accepts are unresolved

Where both methods fired, 12 of 31 agree within 10 m. But **eight read the sheet
end for end differently** — Asquith, Clarendon, Hurlstone Park, Kingswood,
Leightonfield, Pendle Hill, Point Clare, Yennora — 90–120 m apart, which is a
wrong-side-of-the-track error. Treat those eight as unresolved rather than
accepted. Two methods disagreeing is the cross-check doing its job; it is also
the reminder that a residual is evidence about a fit, not proof of one.

## Phase 3, built: one vessel per formation, and the premise that was wrong

Written 2026-08-13. `client/src/world/corridor.ts` (the grouping), the
transition rib and the asymmetric profile in `world/vessel.ts`, `ribSeam` in
`world/seam.ts` and `world/vessel-field.ts`, and sections 10e–10g of
`checkVesselSeam`. **Still behind `vesselsEnabled()`, still default off** —
`?vessels=1`, `SYDNEY_VESSELS=1`. Suite 1019 → **1028**, all passing.
`RailCut`, `PlatformField`, `RoadDeck`, `writeTrench` and `writeVerge` are
untouched.

### The headline

Phase 2a's third finding was that each track in the bake is its own polyline, so
each became its own vessel, and parallel tracks overlap along their whole
length. A four-track railway is **one formation** — one cutting, one floor, two
outer walls — and no amount of per-vessel correctness fixes it because every
vessel is individually right.

Measured against the shape it replaces, built from the same strips through the
same module so the comparison is the change and not two programs:

| | Erskineville | Redfern |
|---|---|---|
| vessels | 4 per track → **3 per formation** | 12 → **3** |
| lattice cells claimed by more than one | 61.5% → **2.4%** | 53.6% → **0.0%** |
| cells whose **ground** more than one swallows whole | 146 → **0** | 75 → **0** |
| footprint points covered by more than one vessel | 66% → **3.2%** | 62% → **0.0%** |
| worst surface disagreement between them | 8.54 m → 8.50 m | 3.29 m → **0.00 m** |

The 61.5% is *reproduced* by the check rather than quoted from Phase 2a, which
is what makes the row a measurement. **The middle row is the one that matters**:
a cell a vessel swallows whole is a cell where a coping can be drawn over an
open cutting, and there are none left anywhere — 0 at both stations, and across
the whole extract 454 of 226,671, every one of them at a place named below.

Over the whole extract: 8,093 trenched strips → 851 track runs → **420
formations**, 145.7 km of cutting, and 1,907 of 226,671 claimed cells (0.84%)
claimed by more than one formation.

### The premise that was wrong: a formation does not need a transition rib

The phase was scoped on this:

> A formation gains and loses tracks at throats and junctions... The profile
> must be able to change along the sweep. Build the transition rib here. It is
> the mechanism that makes a formation possible at all.

The profile must change along the sweep, and it does. But **the change is
dimensional, not topological.** A formation that gains a fourth track gets a rim
four metres further out; the cross-section is the same eight-point `U` it was,
and the sweep has been moving a rim like that since Phase 1 — that is what the
platform flare is. Nothing in the grouping needs two polygons stitched together.

What a formation needed instead was that the profile stop being **symmetric**.
Phase 2a's `SpinePoint` carried one `half`, because a vessel was one track and
the corridor was symmetric about the thing that defined it. A formation's
centreline is one of its tracks — the longest — so its rim runs 5.4 m out on one
side and twenty-five on the other, and there is no half-width that says that.
`SpinePoint.span` is now `[left, right]` and `trenchProfile` takes both. That is
the change that made a formation possible, and it is four lines of arithmetic,
not forty.

**The transition rib is built anyway, and it works.** `Rib` may now carry a
different number of outer-loop points from its neighbour, and the strip between
them is a zip: the two polygons' arcs merged on their own normalised profile arc
length, anchored at the seam points. The windings are *derived* from the uniform
quad strip rather than guessed — with equal counts the zip reproduces
`sideQuad`'s two triangles exactly — and rim cuts landing on a transition's own
seam edge go in by splitting the two faces that share it, since a cross edge of
a zip cannot be merged into the walk the way an along edge can.

Proven on real ribs, not only synthetic ones: the longest formation at
Erskineville (441 m, 56 ribs) re-swept with a platform deck over its middle
third goes 8 points → 10 → 8 at two transitions and comes out **V 486, E 1452,
F 968, one component, χ 2, genus 0, volume 9846.1 m³, closed**. Its rim is 112
vertices — two per rib, exactly as if nothing had happened — because the zip is
anchored on the seam, so the edge of the walkable world does not know the
cross-section changed under it.

And the counterfeit is asserted to fail. Two vessels butted at one rib look
identical from outside and are two surfaces at coincident coordinates;
`checkManifold` reports the duplicated positions, so *"they share vertices by
index"* is a distinction the check can draw rather than a sentence in a comment.

Phase 3b needs it for the platform deck. What it still cannot do is change the
number of **loops**: a trench becoming a bore is a disk becoming an annulus, and
a formation dividing at a junction is one polygon becoming two. A zip between
two closed polylines does neither. The second is a pair of pants and is
constructible — cut the single loop at two pinch points and zip each arc to one
of the two loops, closing the crotch with two triangles — and it is perhaps
eighty lines with a real design question in it (where the crotch goes). It was
not needed here and is not written.

### The rule that makes the footprints disjoint

**A track joins the formation beside it exactly where its corridor overlaps the
formation's.** Not "where it is near" and not "where it is parallel" — those are
heuristics with a residue nobody could bound. Overlap is what the double claim
*is*, so making it the membership test makes the claim disjoint by
construction: two formations that both claimed a piece of ground would have had
to be one formation.

It is transitive, which is what makes a six-road corridor one object rather than
three pairs. A track that overlaps for part of its length is **split**, not
rejected: the covered part joins, the rest goes back in the pool. That
terminates, because every split strictly shortens something.

Four things had to be right about it, and each was found by measuring rather
than by reasoning:

- **The cone belongs inside the fixpoint.** The span is dilated so a member
  starting mid-formation opens the rim out over tens of metres instead of in one
  rib. Applied *after* membership was settled, it reaches ground that was never
  offered to the overlap test — which put two Redfern formations' rims a quarter
  of a metre inside each other along their whole length, 7% of the claimed
  cells, for a reason nobody could have found by reading the membership rule.
- **The split needs daylight, not a zero.** Taken literally, the rule puts the
  boundary between two formations exactly where two rims stop touching, which is
  the least stable place in the construction: a formation is sampled every 8 m,
  so a point is filed against a rib up to 4 m away along the run, and the cone
  then widens both spans. `FORMATION_MARGIN_M` is 5 m, and absorbing slightly
  more than overlaps is always safe because the rim spans whatever it absorbs.
  At Redfern it is the difference between 1.2% and **none**.
- **A formation is one level, and the number is derived.** Without a vertical
  test, "absorb whatever overlaps in plan" pulled tracks **6.14 m** apart into
  one cutting at the Erskineville throat — that is the Illawarra flying over the
  Main South, and one floor under both puts the upper track's ballast six metres
  in the air. `FORMATION_RISE_M` is `envelope.RAIL_ABOVE_M`, 5.9 m: two tracks
  closer than a train's own clearance **cannot** be one over the other, so they
  are side by side however uneven the cone solve left them. Deriving it mattered
  — at the 1.5 m a cess and a cant suggest, Redfern's own roads come apart (the
  bake puts one of them 3 m above its neighbours) and two formations overlap
  where there is one flat station: 11.1% of the cells, against 0%.
- **A cap set to what looks reasonable generates the defect it is guarding
  against.** `FORMATION_MAX_SPAN_M` bounds the transitivity. At 60 m — Redfern
  is the widest railway in Sydney, so 60 m looked generous — it refused 15.3 km
  of track into formations of their own, which then overlapped the ones that had
  refused them. Measured, the widest formation the rule produces is **89.8 m**
  (Central's throat, which really is that wide) with a p99 of 58.7 m, so the cap
  is set at 100 m where it never fires: 0 m refused on this bake. A guard, not a
  knob.

The spine is also **re-centred** on the formation after grouping. That moves no
rim vertex — the rim is the same ground either way — but a profile offset thirty
metres from a curving centreline reverses on a radius three times larger than
one offset fifteen, and a reversed sweep is a `FOLD` and a refusal.

### A run no longer stops dead at a junction

Phase 2a chained a run only through a node where **exactly two** trenched strips
met. That is safe, and it is where the 22 refused runs came from — and, less
visibly, where a good deal of the residual came from: at Erskineville the
corridor is *one* cutting and the network breaks it at every throat, so eight
runs came out where there is one railway, and where two of them met end to end
their footprints overlapped around the shared node. Grouping cannot fix that,
because the formation rule is about tracks running *beside* each other and these
run into each other.

So a run now continues through a node onto whichever unused strip is most nearly
straight ahead, gated at `CHAIN_STRAIGHT_COS` (0.85, about 32°). That is what a
railway does — the main line runs through, the branch diverges — and the gate is
what keeps it from being the bug Phase 1 found, where the deduplicated network
chained a run through a crossover and reversed it. A reversal is a turn of 180°
and is refused by the same test that lets a two-degree bend through.

### The 22 refused runs, accounted for

Phase 1 refused 6 folds (Central ×3, Redfern, Macdonaldtown, Lidcombe), found 4
rim rings self-intersecting in plan (Redfern, Central Chalmers Street, Epping,
Strathfield) and skipped 12 for unloaded terrain, over 930 runs.

Now, over 420 formations: **2 folds, 0 self-intersections, 6 skipped.**

- **The 4 self-intersections are gone, and for a stated reason**: they were
  balloon loops and reversals the old chaining produced by walking into whatever
  strip happened to be there. A run that only continues straight ahead does not
  chain them in the first place.
- **The 2 folds are refused for the same reason as before**, named and located:
  a 497 m two-track formation at −14159, −453 and a 243 m one at −1090, −3316.
  A fold is a corridor turning tighter than it is wide, and refusing it is
  correct; what changed is that there are two and not six.

### What is left, and it is a different defect

76 places in the extract where two formations overlap in plan. A formation is
one level by construction, so two of them overlapping is **one railway crossing
another** — a flyover or a dive that the bake tags as neither a bridge nor a
bore. Erskineville has two (11 cells near −2093, 3390, the two formations 3.6 m
apart in height); Redfern has none; the worst is 267 cells near −14171, −213 at
4.7 m.

That is not the defect this phase is about and grouping cannot fix it: it needs
the **disposition** to change, which is Phase 1's third strain, and the loop
count change the transition rib deliberately does not do. It is `RAIL-VERTICAL.md`
§3 and §6 in one place — OSM is the authority on what the structure is, and here
OSM does not say.

### The walks, at Erskineville

The Phase 2a measurements, re-made over formations. Every one is better, and the
first is better by an order of magnitude because the walk is now down the middle
of one cutting instead of down one track of four:

- **The trench floor**, 873 steps of half a metre along a 441 m formation: worst
  step **−3.1 cm**, no fall, nothing unanswered. Phase 2a: −37.9 cm over 242 m.
  (One step of the path is outside the footprint — the mouth of the cutting,
  where stepping down into it is a lip and not a crack — and is excluded by
  asking the field, not by a tolerance.)
- **The coping**, 7 strips, 2,728 steps of 35 cm: 0 steps down further than a
  kerb, worst **−1.5 cm**.
- **Across the rim** at 424 places, ten centimetres either side: worst height
  difference between the conformed terrain outside and the coping inside
  **15.5 mm** — the DEM's own slope over 20 cm.
- **Across the corridor and off both ends**, 2,326 probes: **0** without an
  answer.
- 128 rim vertices, all sitting on the DEM to **0.000000 m**; 321 lattice
  crossings absorbed into the rim, all bit-identical in the ring; tile −5_−8
  closes to **+0.000134 m² over 250,000 m²** with **0 cells refused** (Phase 2a
  refused 1); the ground query and the drawn mesh agree at all 3,328 sampled
  points by `Object.is`.

### The cost, and one number that reads the wrong way until you divide it

| | Phase 2a, per track | Phase 3, per formation |
|---|---|---|
| objects | 923 runs | **420 formations** |
| centreline | 340 km | **145.7 km** |
| triangles | 1,082,212 | **486,508** |
| per metre | 3.18 (3.39 at Erskineville) | 3.34 |
| build, whole network | 5.0 s | **1.72 s** |
| manifold check, all of them | — | 0.76 s, **420/420 closed** |

**A formation is not cheaper per metre**, and it should not be: it is the same
eight-point cross-section with the same lattice cuts in its rim, so 3.34/m
against 3.39/m at Erskineville is the same number. What collapses is the
*metres* — 340 km of track centreline is 145.7 km of cutting, because four
overlapping trenches were four times as much railway as there is. Total
triangles are **45%** of Phase 2a's and the build is **a third of the time**,
and both come from the same place: there is less of it, because there was never
that much of it.

The manifold invariant is now asserted over **every formation in the extract**
in the suite, not measured once from a scratch script. Phase 1 said of the
whole-network sweep that it was *"cheap to promote into the suite when Phase 2
has something the whole network needs to be true of"*. Phase 3 does: the double
claim is a property of how the extract is partitioned, and a station can be
clean while the junction two kilometres away claims the same ground twice.

### And the divergence that was shipping, fixed in the old path too

Phase 2a found that `RailCut.setStations` was seeded from different lists on the
two ends — 358 sites on the server against 361 on the client, because
`buildNetwork` adds a fallback for stations nothing calls at — giving 87 of
29,479 sampled points a different half-width by up to the full 4.00 m of the
flare, while `server/world.ts`'s comment asserted the two were the same anchors.
`corridor.ts` fixed it for the vessel path only, because the flag being off had
to change nothing.

**The old path is fixed now.** `main.ts` seeds from `riding.buildPlatforms`,
which is the call the server has always made, so both ends resolve the anchors
from one function instead of two. The three uncalled stations stop flaring on
the client, which is what the server's ground query has always said, so this
removes a disagreement rather than creating one. `buildPlatforms` was already
being called sixty lines further down and is now called once. The comment in
`server/world.ts` that claimed the two were the same list now says what it was
and how it was measured. And the three checks that modelled the old path
(`checkRailCutting`, `checkRoadDeck`, `checkVessels`) seed the same way, because
a check that set it up the old way would be asserting a configuration the build
no longer has.

### Where Phase 3b will strain

1. **The platform deck is a transition rib and is now buildable.** The mechanism
   is proven on real corridor geometry; what is not written is the rule that
   says where the deck goes, which is what the CAD corpus is for.
2. **The road lid is still not buildable**, and it is the loop-count change the
   zip cannot do. A trench becoming a bore is a disk becoming an annulus. This
   is unchanged from Phase 1's third strain and is now the *only* thing in the
   four dispositions that a sweep cannot express.
3. **A formation dividing at a junction** is the other loop-count change — one
   polygon becoming two — and it is what the 76 crossings would need if the
   diverging branch were at the same level rather than over it. The construction
   is sketched above; the design question is where the crotch goes.
4. **Nothing draws a formation yet.** The vessel path answers the ground query
   and withholds the terrain; the mesh is built and checked and thrown away. The
   ballast, the rails, the fence and the platform are still `rail-geo`'s, drawn
   per track, and a track's ballast sitting on a formation floor at the lowest
   member's level is the next visible thing to be wrong. The floor is flat and
   the tracks are not, by up to `FORMATION_RISE_M`.

## Phase 3a, built: the formation drawn, and two premises corrected

Written 2026-08-13. `world/vessel.ts` (`Vessel.faceEdge`, `TRENCH_EDGE`,
`TRENCH_POINT`), `world/rail-geo.ts` (`RailWorld.setVessels`,
`writeVesselShell`, `writeVesselFence`, `writeVesselWalls`, and the four old
writers standing down), `main.ts` (`sydney.rail.vessels()` and the re-centre
rule), and section 10h of `checkVesselSeam`. **Still behind `vesselsEnabled()`,
still default off** — `?vessels=1`, `SYDNEY_VESSELS=1`. Suite 1028 → **1034**,
all passing with the flag down *and* with `SYDNEY_VESSELS=1`. `RailCut`,
`PlatformField` and `RoadDeck` are untouched: platforms are 3b.

### The headline

Phase 3 ended with *"nothing draws a formation yet. The mesh is built and checked
and thrown away."* It is drawn now, and **it is the same triangles** — the
renderer sorts the vessel's own faces into materials and adds no geometry of its
own. Nothing here re-measures a half-width, re-reads the DEM or decides where an
edge is, which is exactly what `writeTrench` and `writeVerge` each do
independently and is why the two of them disagree about the rim by half a metre
and paper over it with an outward lap.

| | flag off | flag on |
|---|---|---|
| the trench wall | `writeTrench`, per track, rim re-measured from `halfWidthAt` | a face of the solid, at the rim the terrain was triangulated to |
| the coping | 0.5 m lapped **outward** over standing ground | 0.5 m **inward** from the rim, meeting the ground flush |
| the floor | `writeFormation`, per track, at *that track's* level | one floor per formation, `cess`, under the lowest rail it carries |
| the ballast | 0.55 m under every track, whatever is beneath it | bedded down to the drawn floor: `max(0.55, railhead − floor)` |
| the fence | `FENCE_OFFSET` from a **track centreline** | the rim ring, which *is* the edge of the walkable world |
| the barrier | a box per rib pair from a re-measured rim | a box per rib pair from the vessel's own `FOOT`/`RIM` vertices |

### What the pictures show, and they are the acceptance

Eight cameras, identical world coordinates and identical sky phase, flag off
against flag on, in `client/.shots/P3A-*-{ON,OFF}.png`. Taken through
`sydney.look` so the two runs are the same camera and not two similar ones.

- **`e1_street`** (Erskineville, from the footpath). Off: **three overlapping
  fence lines** fanning across the ground in front of the corridor — one per
  track, exactly the player's point 4 — with a grey slab lapping between them.
  On: one fence, on the rim.
- **`e2_trench`** (down in the cutting, looking up at the wall). Off: an
  untextured grey slab with **no coping and no fence on top**, a catenary mast
  standing in the middle of the formation, and bare terrain between the ballast
  and the wall. On: a battered retaining wall, a coping, the boundary fence along
  the top of it, and a `cess` floor under the whole formation.
- **`e3_up`** (on the floor, looking along the cutting). Off: two pale slabs and
  no corridor between them. On: the wall with its fence, the ballast, a train,
  and the overhead line.
- **`r2_over`** (Redfern, over the formation). Off: **four parallel fences
  running down the middle of the station**, across platforms and tracks. On:
  none — a formation has no interior for a fence to be in.
- `e4_air`, `e5_station`, `r1_street`, `r4_air` are context and are unremarkable
  either way, which is itself worth having.
- `e2b_train_in_cutting` has no pair and is not evidence of a difference: it is
  a T4 set running through the cutting past the wall, kept because it is the
  frame that says what the whole phase was for.

**Where it is not better, said plainly.** The wall is one flat colour over its
whole height and reads as a slab close up — it has a coping and a fence now,
which is most of the recognition, but no string course, no buttress and no
change of tone with depth. And the shots are 960×540 through a first-person
camera with a cricket bat in the lower right; they are evidence, not photography.

**What was not looked at.** A screenshot pair on an **at-grade stretch away from
a station** was asked for and is not in the set: the corridor near the loaded
tiles is in cutting almost everywhere it is trenched at all, and a teleport to a
genuinely at-grade stretch (Lindfield) needed more streaming than the harness
could drive. The claim that at-grade is unchanged is therefore *structural* — every
suppression is gated on `vesselled()`, which is `false` wherever no footprint
covers the point, and the whole flag-off suite passes — but it is not a picture,
and it should be one before anyone flips the flag.

### Correction 1: "exactly zero" is not true at 30 km from the origin

Phase 2a's `Vessel.sideFace` says an end cap *"lies in the rib's own cross-plane,
which contains the Y axis, so its normal has **zero** Y exactly and it can never
be a surface anything stands on"*, and `world/vessel-field.ts` rests its whole
up/wall/down classification on the same sentence. Geometrically it is true. **In
doubles it is not**, and the reason is a fact about where Sydney is rather than
about the sweep: `n.y` is `uz*vx − ux*vz` over *world* coordinates, and out past
Penrith those two products are ~1e9 with ~1e-7 between representable neighbours,
so their difference only sometimes cancels to zero.

Measured over the whole extract: **98,051 of 172,766 vertical faces (56.8%) have
a non-zero plan normal and 49,280 of them are positive** — which `faceHeight`'s
`ny > 0` reads as *a surface you can stand on*. It is unreachable rather than
lucky, and the bound is the same arithmetic: a face that near-vertical has at
most **1.4e-10 m²** of plan area, so a point query would have to land inside a
tenth of a square nanometre to be answered by one, and the answer would be a
height on the wall between the floor and the rim. Nobody can reach it. But it was
a sentence doing argumentative work it could not do, in a file whose whole
premise is that there are no epsilons on the path — so both headers now say what
is true, and the numbers are asserted in the suite rather than left in a comment.

### Correction 2: the tile count is not enough to re-sweep on

`refreshVessels` rebuilt the corridor only when the resident tile count changed,
on the argument that a new grid is the only thing that can turn a refused run
into a built one. True, and incomplete: the sweep is centred on the **player**,
so a player crossing a suburb whose tiles are all resident — every teleport, and
every long walk in a session that has been running a while — walks off the end of
the swept region into a corridor that was never built, and the ground query falls
through to the DEM over an open cutting. Found by teleporting between
Erskineville and Redfern to take these screenshots and getting a corridor that
stayed at Erskineville. `VESSEL_RECENTRE_M` is 300 m against the 900 m radius, so
the swept region always reaches at least 600 m past the player — comfortably
outside `COLLISION_KEEP_RADIUS_M`, which is as far as the ground query can be
asked.

### The face provenance, and why it is emitted rather than recovered

A drawer has to know which face is the floor and which is the coping. It must not
work that out from the geometry — *"the flattish ones are floor"* is a second
description of the cross-section and this design exists to abolish those — so
`Vessel.faceEdge` carries the profile edge each triangle was swept from, written
where the triangle is written. `sideQuad` is *called* with the edge it is
drawing; the answer is free.

It is then checked from the outside, over all 486,508 triangles: the normal is
recomputed from the positions and compared against what the label claims, and the
four bands come out **disjoint**, which is what makes the provenance recoverable
rather than decorative. Measured: the flattest walking surface is n.y **0.379**
(a floor triangle on a tight bend, where a skew quad's two halves tilt
differently), the steepest wall **0.1644** against the `VESSEL_BATTER` of 0.1667
it is built to, the most upward-facing underside **0.086**, and every vertical
face inside 2.6e-8 of zero.

### What is drawn, and what is dropped

**282,278 of the 486,508 triangles are drawn — 58%, 1.94 per metre of cutting.**
The other 42% is the buried half of the shell: the underside and the two outer
skins, which exist so the surface closes and which the terrain is triangulated
*over*. That they are unreachable is asserted rather than argued, in the form
that matters: over 1,308 points across the footprints of every twentieth
formation, **the highest upward-facing face is a drawn one at every single
point**, with the negative control (drop the floor as well) failing at 1,284 of
the same 1,308.

The solid is unchanged. `Vessel.triangles` is still 486,508 and the manifold
invariant is still proved over all of it — those are two different numbers about
one object and reporting either as the other is how a budget starts lying.

### The numbers, against Phase 2b's

| | Phase 2b | Phase 3a |
|---|---|---|
| formations | 420 | **420** |
| closed 2-manifolds, after decoration | 420/420 | **420/420** |
| triangles in the solid | 486,508 | **486,508** |
| triangles drawn | 0 | **282,278** |
| whole-network sweep | 1.72 s | **1.08 s** |
| manifold check, all of them | 0.76 s | 0.40 s |

The sweep and the check are the *same code* — `corridor.ts` is untouched — so
read 1.08 s against 1.72 s as machine load and not as a change. What is new is
the last row of the middle: the same 486,508 triangles now have a rendering, and
58% of them reach a screen.

Per chunk, with the flag on and measured in a browser at Erskineville: **24.9 ms**
to build a 512 m chunk carrying the shell, the rim fence and the barrier prisms,
against the 150 ms that chunk's rebuild already costs.

### The cost nobody has paid yet: the ring is dropped on every re-sweep

`setVessels` throws away every built rail chunk when the corridor changes, because
a chunk decides once and for all what it draws. It is guarded by a signature
(formation count and triangle count) so an identical re-sweep costs nothing, but
a genuine change — a new tile near the railway, or 300 m of walking — drops the
whole ring and rebuilds it at two chunks a frame. At 24.9 ms a chunk over ~18
chunks that is about **450 ms of rebuild spread over nine frames**, with the
railway visibly absent while it happens. Acceptable behind a flag and not
acceptable in a shipped world; the fix is a per-chunk signature over the
formations that overlap it, which is real work and is not done.

### What is now redundant under the flag, and what was left standing

Inside a formation's footprint, with `?vessels=1`, these no longer emit
**anything** — not geometry and not collision:

- `writeTrench` — the wall, the coping, the cess strip and the wall prisms;
- `writeFormation` — the whole slab;
- `writeVerge` — the verge batter and the boundary fence.

They are left in place, because outside the footprint and with the flag down they
still build the world, and the condition is one predicate asked at the track
centreline: `VesselField.surfaceAt(x, z) > -Infinity`. That is exact rather than
a radius — inside the rim ring the field answers with the surface of a solid and
outside it answers `-Infinity` — so it is the membership rule read back out.

What deliberately did **not** stand down: the rails, the sleepers, the ballast and
everything at a station. The ballast is rebased rather than replaced, which is
`STATIONS.md`'s own *"next visible thing to be wrong"*: a formation's floor is
under the **lowest** rail it carries, so a track four metres above it had four
metres of daylight under half a metre of blue metal. `writeBallast` now takes its
depth from `VesselField.surfaceAt` — the same answer the ground query gives and
the same surface the shell draws — so the toe lands on the floor by construction.

### Two things that had to be built rather than moved

- **A barrier.** The ground query evaluates the sweep's faces and answers *how
  high*; it does not answer *you may not pass*, and `CollisionWorld` knows about
  prisms. Suppressing `writeTrench` therefore had to put something back or a
  player could walk down the batter into 145 km of cutting. `writeVesselWalls`
  emits one box per rib pair per side — **35,193 over 18,252 rib pairs, none
  refused** — and its four corners are the vessel's own `FOOT` and `RIM`
  vertices read **by index**, so it cannot be a second opinion about where the
  wall is. `STATIONS.md`'s refusal of a prism decomposition is about the
  *surface*, and the surface is still evaluated from the sweep.
- **A rule for the fence's two end edges.** The rim ring runs down one seam and
  back the other, so it closes across the mouth of the cutting, and a panel there
  would be a fence across the railway. They are identified out of `ribSeam` — an
  edge whose two ends are the two seam vertices of one rib — rather than by
  looking for a long edge, because *long* is a threshold and this is a fact. The
  suite then asserts the whole property the player complained about: over all 420
  formations, **840 rim edges have their two ends on opposite sides of the
  corridor and all 840 of them are those two caps.**

### Masts: decided against the formation, seated on the floor

`refillMasts` offsets a stanchion `MAST_OFFSET` from **its own track**, which is
where a mast goes beside a single line and is not where the ground is in a
cutting: beside a track four metres above the formation floor, its base plate
stood four metres in the air. It is now seated on the drawn surface —
`vesselFloorAt` at the mast's own position, and **only ever lowered**, because
raising one would stand it on the coping over its own track while the wire it
carries has not moved.

What was *not* done, and the reason is worth stating because it looks like the
obvious move: the mast is **not** moved laterally to the formation edge. Real
practice puts cantilevers outside the outer tracks and gantries across the rest,
but the instanced cantilever geometry reaches exactly `MAST_OFFSET` to its own
wire, so a mast at the rim of a thirty-metre formation would be a bracket
reaching at nothing. Moving them properly means the mast set becoming a function
of the formation rather than of the bake's stanchion list, which is a bigger
change than this phase.

### Where Phase 3b will strain

1. **The platform is still `rail-geo`'s**, drawn per station over a floor that
   now belongs to the vessel. The transition rib is built and proven; what is
   missing is the rule that says where the deck goes.
2. **The wall is one tone from foot to coping.** It reads as a retaining wall
   because of the coping and the fence, not because of the wall.
3. **The chunk ring is dropped whole on every re-sweep** (above). A per-chunk
   signature is the fix.
4. **The road lid is unchanged** — still the loop-count change the zip cannot do,
   still the only one of the four dispositions a sweep cannot express.

## One definition of the ground, built 2026-08-13

`client/src/world/rail-solids.ts` (new), `world/rail-geo.ts` (split),
`player/collision.ts` (`pointInPolygon` exported), `main.ts`, `server/world.ts`
and `server/station-suite.ts`. **Not behind a flag** — this one is the shipping
path, and `vesselsEnabled()` is untouched either way.

### The defect, and it was the last unread half of this document's own rule

The document ends: *"a boundary may have many renderings and exactly one
definition"*, and names the shape of the answer:

> This is not a new pattern here — it is what `PlatformField` already does, and
> for the same stated reason: the drawn prisms exist only in a browser and only
> near the player, so the arithmetic version is the one the server can answer
> from. That worked. Generalise it rather than inventing something.

Nothing had been generalised. `PlatformField` was the only rail structure with
an arithmetic form; the trench wall, its coping, the viaduct deck, the piers, the
footbridge, the station building, the access flights and the head of a subway
shaft existed **only** as `CollisionWorld` prisms written by
`rail-geo.buildChunk`, which runs in a browser inside `BUILD_RADIUS`. Every one
of them is ground a player stands on, and the server had none of them.

Measured over the station suite's full lattice — 670,437 samples across all 267
station envelopes, the client's `groundHeightAt` against the server's
`groundFor`, compared with `Object.is`:

| | samples that disagree | worst |
|---|---:|---:|
| before | **54,293** of 670,437 | 14.0 m, Ourimbah |
| after | **0** of 670,437 | — |

Where the two disagree the server wins, so the player is corrected into or out of
geometry they can see. That is *falling through*, *being dragged back*, *standing
on nothing* and *teleporting to the surface*, in one mechanism.

**What was actually causing it**, measured by suppressing each writer's input and
re-running the same lattice rather than by reading the code:

| suppressed | splits remaining | that writer's share |
|---|---:|---:|
| nothing | 54,293 | — |
| the stations | 11,008 | **43,285 (80%)** |
| the trench | 46,268 | 8,025 (15%) |
| the viaducts | 56,410 | negative — see below |

The station kit is four fifths of it, which is not what the brief for this round
assumed and is worth stating: the platform deck alone is most of that, because
`rail-geo` registers the deck as a prism *as well as* `PlatformField` answering
for it, and the prism answers at feet heights the field refuses. Suppressing the
viaducts *raises* the count, because `SPAN_BRIDGE` is also read by `inCutting`,
so a bake with no bridges trenches things that are not trenched — the row is
evidence that viaducts are a rounding error here, not that they help.

### The design: the definition moves out of the renderer

`rail-geo.ts` imports `three/webgpu` at module scope, so a server that imported
it would pay for a renderer to ask where the ground is. The arithmetic half is
therefore now a module of its own, and `rail-geo` is one of its two consumers:

- **moved unchanged** — the dimensions of a railway, `buildNetwork` and the
  network index, `planStation`, `trackClear`, and the `TrackFrame` helpers;
- **new** — `stationSolids`, `trenchProfile`/`trenchPrisms` and `viaductSolids`,
  which are the *box* arithmetic lifted out of the writers, and
  `RailSolidField`, which evaluates them.

The primitive is a `FrameSolid`: a box between `t0..t1` along a frame, `o0..o1`
across it and `y0..y1` in world y. That is what `frameBar` has always drawn and
what `framePlan` has always turned into a prism ring, so making it the record
rather than an argument list is the whole trick. `buildChunk` now enumerates a
station's boxes once, registers them with `CollisionWorld`, and hands the same
list to the writers to draw. `writeTrench` measures its ribs by calling
`trenchProfile` — the same call `RailSolidField` makes — and emits its collision
through `trenchPrisms`.

**`frameSolid` is gone and its absence is the point.** Drawing a box and
registering it in one call is the shape that guaranteed the divergence: the
registration only ever happened where a browser had just drawn something.

Two smaller things fall out of the same rule:

- `player/collision.pointInPolygon` is **exported** rather than restated. The
  field's answer and the prism's answer are compared with `Object.is`, so a
  second even-odd implementation, however faithful, is a place for a boundary tie
  to land one way here and the other way there.
- The field evaluates the **prisms**, not the boxes: `framePrism` derives the
  same eight floats `CollisionWorld` is given, and `RailSolidField.roofHeight` is
  `collision.roofHeight`'s three clauses in its order. There is nothing for the
  two to disagree about because there is nothing they each decide.

### Lazy, and refusing to cache a guess

Two rules, for two different reasons, and both are measured.

**Nothing is built until it is asked for**, which is the memory rule.
`STATIONS.md`'s own constraint is that an arithmetic form is cheap and a prism
set is not: 22,390 segments at ten prisms each is six figures of `Float32Array`
if it is all built at boot. Built where somebody stands, the whole 267-station
sweep holds 5,344 segments and 17,996 corridor prisms; a query pass covering
1.2 × 0.8 km around *every* station — far more ground than a session walks —
holds 16,289 segments and 60,753. Station solids are materialised on first touch
and are 34,784 prisms for the whole city.

**An answer measured against missing terrain is never cached**, which is the
correctness rule and is `RailWorld.retryProvisional`'s rule in one line.
`StationPlan.measured` and `TrenchProfile.complete` already say which answers are
guesses; the field simply declines to keep those. On the server every tile is
resident so it never fires; in a browser it fires constantly, and caching it
would freeze a guessed wall in place for the session.

### The cost, measured

| | before | after |
|---|---:|---:|
| server boot | 4.3–5.4 s | 4.3–5.4 s, of which **0.37 s** is `buildNetwork` (0.22) and the field's two grids (0.15) |
| server steady heap, 39 station visits | 996–1,018 MB | 1,015–1,028 MB |
| ground query | ~0 | **0.85 µs** per call, whole-city warm |
| retained at the ceiling | — | 95,537 prisms ≈ 3.1 MB of `Float32Array` payload plus per-record overhead; ~20–25 MB all in, of which ~7 MB is paid at boot |
| the station suite (670,437 lattice samples, ~9 M body-step ground calls) | 54.3 s | **63.3 s** |

Heap is quoted as a band because `heapUsed` on this process does not resolve
anything under about ten megabytes against a gigabyte of world — three runs each
way, gated on and off, give 996/1,004/1,018 MB against 1,015/1,027/1,028 MB. The
accounted figure is the honest one and it is the row above it.

The first version of `roofHeight` cost **3.5 µs** because it ran the polygon test
on every box in the cell, and the suite went from 54 s to 138 s on it. It now
carries the four plan bounds `CollisionWorld.Prism` carries, for the reason
`CollisionWorld` carries them, and that is the 4× — the one number here that was
tuned rather than derived, and it changes no answer, because a point outside a
box's bounds is outside its polygon.

### The gates, and the one that is not green

Typecheck and build clean. The station suite goes 10 failures to 9: the
divergence assertion turns green and everything else is unchanged.

The default suite is **1,043 PASS**, against a baseline of 1,042 PASS / 0 FAIL
measured in a worktree at `1a8f53e` carrying the other round's in-flight files
and none of this one's, which is the comparison that isolates this change. The
extra check is this round's negative control.

**One check now fails about one run in three, and it is the change working.**
`checkRiding`'s Epping instant rides a body from Eastwood, alights it, and
asserts its feet are within 5 cm of `PlatformField.surfaceAt`. The ride is
**nondeterministic at the metre in the baseline too** — four baseline runs
carried the body 1448, 1450, 1456 and 1450 m — so where it puts the body down is
a sample of Epping's platform, not a fixed point. It always passed because the
server had nothing on that platform to be lifted by. It now sometimes fails,
because **8,166 of 101,751 points over Epping's platform rectangles (8.0%) are
covered by a corridor solid standing over the deck**, by up to 5.13 m, and the
browser has always had every one of them:

> `writeTrench` builds a wall from `foot` to `rim + TRENCH_COPING` measured from
> **its own track's** centreline, and at a platform `rim` is `STATION_HALF_WIDTH`
> — the same 9.4 m the deck reaches. `foot` is `rim − height/6`, so a five-metre
> wall's batter covers the back 0.83 m of the deck beside it, and every *other*
> track's wall in the same formation crosses the whole thing.

That is `STATIONS.md`'s own Phase 2a Correction 2 — *"each track in the bake is
its own polyline, so each becomes its own run, and two running lines four metres
apart with a 5.4 m half-width occupy the same ground along their whole length"* —
in the flag-down path, where the vessel work has not reached. Nine runs of the
check gave three failures; the other four instants pass every time.

**It was not fixed here, and the reason is stated rather than assumed.** The
narrow fix is to stop the wall's *prism* inboard of the deck — and that alone
opens a walk-through, because the wall's drawn face would still be there with
nothing behind it. Making the drawn wall stop there too is a change to shipped
geometry that wants a screenshot pair and a rim walk, not a line at the end of a
round about the ground query. It is the first item on the list below.

Two things did have to change in `server/integration-check.ts`, both in
`checkVesselSeam`, and both because the walk down a formation's floor now meets
the station the formation runs through:

- `world.railSolids?.invalidateCorridor()` beside the check's own
  `world.vessels = built.field`, which is the same call `main.ts` makes on every
  re-sweep: with the flag on, `writeTrench` stands down inside a formation, so a
  wall cached before the field was reseated is a wall nothing draws.
- The floor walk skips the points under a station deck, counted and reported
  beside the mouth exclusion it already had, and restarts the body **on the
  vessel's own surface** across each gap rather than carrying its feet over one.
  With both, the worst step is back to **−3.1 cm**, which is the number this
  document has recorded for that walk since Phase 3.

### The premise that was wrong: this is not what decides `holes`

The round was briefed on the expectation that the divergence was the dominant
cause of the `holes` column. **It is not, and it cannot be**, and the suite says
so in its own comment:

> The client/server split is reported and does **not** decide the cell.

`holes` is decided by four sub-checks — `drawnUnsupported`, `droppedThrough`,
`invisibleSheet` and `fellIn` — and every one of them is evaluated **entirely on
the client's side of the wire**: the analytic pass reads `clientGround`, the
bodies are driven through `controller.step` against the client's collision world.
No fix to the server's ground query can move any of them. Measured rather than
argued: `holes` is **220 failures before and 220 after**, with every other column
and every control unchanged, and the only two lines that moved in the whole
scorecard are the divergence assertion going green and its new control going red
on demand. The scorecard was diffed line for line to check that, not summarised.

Two controls were run before the fix was written, because "the check cannot see
it" and "the check is right and the fix is small" look identical from the
outside:

- **The suite's railway is not starved.** `RailWorld.update` builds two chunks a
  call and the suite calls it once a station, leaving 1,231 chunks pending across
  267 stations — so the obvious suspicion is that the bodies fall through walls
  that were never built. Pumped to empty, `holes` goes 219 → 219 and `fellIn` 192
  → 193. The two chunks built are the two under the station; the rest is scenery.
- **The client's answers do not change either.** With the field folded into
  `clientGround` as well — so a body stands on a station structure anywhere,
  built chunk or not — no verdict moves.

### The `holes` queue, from evidence

What each sub-check is actually finding, over the same 267 stations. This is the
next round's work list and none of it is server divergence.

**`fellIn` — 192 stations, 516 probes, the dominant term.** A body on the ground
twelve metres out is walked at the centreline and must not end up in the
corridor. Classified by where it started and where it stopped:

| | probes |
|---|---:|
| started on terrain, ended in the carve | **182** |
| started on a **rail solid** (a station-building roof, mostly), ended on terrain | 113 |
| started on something else, ended on terrain | 88 |
| started on a rail solid, ended in the carve | 60 |
| the rest | 73 |

The 173 that start on a rail solid are the check spawning a body on the roof of
the station building and calling the walk off it a fall into the railway: the
probe is at 12 m out and `writeStationHouse` puts an 11 × 6.5 m box spanning
10.6–17.1 m out. **That is the check not asking its own question** — its comment
says *"a body on the ground twelve metres out"* — and it is a change to
`station-suite.ts`, deliberately not made in this round, because moving the
instrument in the same round as the fix makes the fix unreadable. The 182 that
start on terrain and end in the carve are the real defect and are where the next
round should go.

**`droppedThrough` — 96 stations, 383 bodies.** A body started at the surface the
ground query itself answered, which then does not hold it. By the clause that
answered:

| | bodies |
|---|---:|
| the terrain answered, the body left it | 149 |
| `RailCut.cutAt` answered, the body left it | 133 |
| a roof answered | 74 |
| `StationBoxField` answered | 21 |
| `PlatformField` answered | 6 |

**`drawnUnsupported` — 72 stations, 6,602 samples.** Terrain is drawn and the
ground query answers more than half a metre below it. Overwhelmingly
`StationBoxField.floorAt` (4,810) — a concourse floor answering under ground the
DEM still draws — then a roof (1,066) and `PlatformField` (726). This is the
`StationBoxField` band, not the railway's solids.

**`invisibleSheet` — 73 stations, 404 samples.** All 404 are a **rail solid**
whose roof sits at terrain height over a carved corridor: the coping of a trench
wall, standing where the DEM sheet used to be. That is the wall doing its job at
the rim and the check reading the rim as a lid; it wants a rule that excuses the
coping band, or a coping that is not flush.

**And above all of them, the one the gate section names.** A per-track trench
wall's prism stands over the platform deck beside it and over every other track
in its formation — 8.0% of the points over Epping's platforms, by up to 5.13 m.
It is the mechanism behind the `stand` column's *"lifted onto a solid standing
over it"*, it is what makes `checkRiding`'s Epping instant flaky, and it is the
flag-down half of the defect Phase 2a Correction 2 measured and Phase 3 fixed for
vessels. Both ends now agree about it, which is this round; neither should.

### What can still differ, and it is bounded

A browser whose terrain has not arrived answers this field from the terrain it
has, and the server answers from the terrain it has. That window governs
`rail-geo`'s own provisional chunks and has always been there; it is bounded by
`PROVISIONAL_ATTEMPTS` and by the streamer, and the field's refusal to cache an
unmeasured answer is what stops it outliving the streaming. What is gone is the
*permanent* disagreement: two processes with the same terrain now compute the
same solids, which was true of nothing above `PlatformField` before this file.

The one input that can change under a running field is `vesselled` — with
`?vessels=1` the corridor is re-swept as the player moves and `writeTrench`
stands down inside a formation — so `invalidateCorridor` is called wherever
`vesselField` is reseated, on both ends.


## The formation's edge, flag down: whose wall it is

Built 2026-08-13, immediately after the ground-parity round above, and it closes
that round's own first open item. `client/src/world/rail-solids.ts`'s
`trenchProfile`, `client/src/world/rail-cut.ts`'s `eachSiteNear`, three lines of
`world/rail-geo.writeTrench`, and `checkFormationEdge` in
`server/integration-check.ts`.

The defect is the one the section above ends on and Phase 2b states in general:
*"a four-track railway is one cutting carrying four tracks, not four trenches
that overlap; modelling it as four is why a coping is drawn across an open
trench, and no amount of per-vessel correctness fixes it because each vessel is
individually right."* The bake carries one polyline per track, `writeTrench`
built a battered retaining wall on **both** sides of every one, and a four-road
formation therefore stood eight walls — six of them inside the cutting they were
supposed to retain, across the other roads and across the platform decks between
them. Measured over every platform rectangle in the city, on the shipping path:

| | before | after |
|---|---:|---:|
| points over a platform deck covered by a corridor solid standing over it | **557,885** of 7,354,752 | **77,879** |
| ...of those, on deck that is **inside its own carve** | — | **3,094** |
| stations affected | 109 of 190 | 101 of 190 |
| worst lift | 13.18 m | 13.18 m |
| at Epping, whose platform `checkRiding` samples | 5,452 of 61,632 | **805**, worst 1.87 m |

### The test is not "which tracks are one formation"

Two groupings were available and both were rejected, and the reason is the same
one this document keeps recording: a second, subtly different notion of
membership is the bug, not the fix.

- **`markCorridorEdges`' `seg.open[k]`**, the flag the boundary fence is placed
  by, is a fixed `CORRIDOR_NEIGHBOUR` of 8.2 m. A platform flares the corridor to
  9.4 m, so two roads *fourteen* metres apart at a station — one formation by any
  reading — are "open" to each other and each builds a wall across the other's
  platform. Measured: gating on `open[k]` alone left **138,414** points covered,
  and the buckets at 12–20 m of lateral separation were 54,000 of them. It is
  also wrong the other way: a cutting beside an embankment six metres off is
  called closed, and a cutting with no wall is a hole.
- **`world/corridor.buildFormations`**, the vessel path's grouping, has the right
  rule — a track joins the formation where *its corridor overlaps the
  formation's* — but it is a whole-network sweep over `corridorStrips`, a
  different segment set, needing a ground-sampled spine. `RailSolidField` is lazy
  per segment by design and `buildChunk` builds a 512 m ring; hanging either on a
  global formation build undoes both.

What both are proxies for is available exactly, at the point the question is
asked: **`RailCut`**. `buildFormations`' own rule *is* `RailCut.cutAt` evaluated
at a point, and `rim` on the line above is already `cut.halfWidthAt`. So each rib
asks the carve whether the ground **outside its own coping** is still standing.
Standing, and the rib is at the formation's edge whatever else is in the
formation: build the wall. Taken away, and the rib is looking across the corridor
it stands in, over a floor `writeFormation` already draws: build nothing. No
grouping is derived, nothing can drift, and the answer is at rib resolution
rather than per segment, which is what a formation that gains and loses roads at
a throat needs.

Two clamps go with it, both on the foot:

- **Never inboard of a platform deck.** The batter is what puts a wall's foot
  inboard of its top, and at a platform the rim *is* the deck's outer face —
  `PLATFORM_OUTER_M` and `STATION_HALF_WIDTH` are one constant — so a five-metre
  wall took the back 0.83 m of the deck it was built behind. That is on the
  *outermost* road, where the rule above cannot help. Clamped by `deckEdgeAlong`
  over `RailCut.eachSiteNear`, the wall is vertical for the length of the
  platform and battered again the moment the deck ends.
- **Never outboard of the corridor's own edge at that rib.** `rim` is the widest
  of three samples so that a panel never sits inside its own hole; the difference
  between that and `halfWidthAt` at the rib is a shoulder of ground the carve
  never took. A vertical wall no longer covers that shoulder with its batter, so
  a body climbs it and walks over the coping — three of 110 did before the clamp.

### No walk-through was traded for the lift, and it is measured rather than argued

`checkFormationEdge` builds the wall **twice** off the identical ribs — once as
shipped, once with `stood` forced true and the batter unclamped, which is the
per-track wall this round replaced — puts both prism sets into the collision
world in turn, and drives the same 1,040 bodies out of the cutting through
`player/controller.step`. **25 get out now; 30 got out before.** The panel rule
was decided the same way: keeping a panel when *either* rib stands puts another
11,196 points of corridor solid over the platforms and lets 26 out, requiring
both lets 25 out, so it requires both. Arithmetically, 11,422 of the 11,609
dropped panels have carved corridor a metre outside their coping at both ribs;
the other 187 are a sliver of standing ground between two cuttings.

### The residue, split rather than totalled

Of the 77,879 points still covered, **74,785 are deck drawn over ground the carve
never took away.** A platform is a straight 160 m rectangle and a railway curves,
so at the ends of a curved platform the deck swings outside its own corridor and
is buried in the hillside — and a retaining wall on that hillside is standing on
real earth. Half the total (38,638 at the first measurement) is a **viaduct
deck**, not a trench wall: `DECK_HALF_WIDTH` is 3.9 m and a viaduct road at a
higher level beside a platform puts its deck box over it. Both are different
defects with different fixes — the deck, and the viaduct — and they are counted
apart here so neither can hide behind the other.

### What it costs, measured

Both new questions are per rib per side, and the carve query is the expensive
one. Timed over the busiest chunk in the network -- Redfern's 512 m square, 189
trenched segments, 1,772 ribs -- `trenchProfile` goes from about **1.0 ms to
4.84 ms**, of which `stood` is 3.19 and `deckEdgeAlong` is 0.64. A typical chunk
is nowhere near that: Epping's own square has 29 trenched segments and pays
0.72 ms for the lot. At `BUILDS_PER_FRAME` of 2 the worst case is two Redfern-class
chunks in one frame, which is the case to watch if a hitch is ever reported near
Redfern or Central.

There is no cheap trim available and that was checked rather than assumed: 0% of
Redfern's ribs are at grade, so skipping the query where no wall could stand buys
nothing, and only 31% are inside a station flare, so skipping `deckEdgeAlong`
outside one saves 0.4 ms. What would actually pay is a coarser "is any other
road's corridor near this point" index, which is a structure and therefore a
round.

### The gates

Typecheck and build clean. Default suite: eleven runs, of which **ten consecutive
are green** at 1,048 PASS / 0 FAIL, and `checkRiding`'s Epping instant reports
**0 mm** off the platform in all eleven — the ride is still nondeterministic at
the metre (1,447 to 1,456 m carried) and the landing is no longer.

**The eleventh run was red on two checks and neither is this.** `four identical
/unstuck commands in a row were all served (3 of 4)` — `game/unstuck.ts` picks *"a
random road within 200 m"* with `Math.random`, so one relocation in a few hundred
lands under the one-metre bar. And section 3's ride-*now*, which its own comment
calls a lottery, put a body down at Westmead where `PlatformField.surfaceAt`
answers `-Infinity`; sections 3b and 3c, which assert that every calling stop has
a platform and every *composed* disembark lands on one, passed in that same run.
Written down rather than re-rolled: **the default suite is not deterministic**, and
a ten-run gate is worth having precisely because of that.

`SYDNEY_CHECK_ONLY=stations` goes 9 failures to 9, with `stand` **159 → 162** and
`holes` **220 → 218**, client/server ground divergence still **0 of 670,437**, and
its negative control still red on demand at 49,810. `rail.py` was not touched, so
no re-bake.

**`holes` moved, and only just.** The previous round named this defect as sitting
above all four hole mechanisms; on the measurement it is worth two stations, not
two hundred. That is reported as it came out.


## The way into a bore, walked

Reported: *"cant reliably find entry, i just fall into the ground if i run
over it, no space to navigate underground"* and *"the entrance to stations is
impassible and also not really drawn properly"*. `server/underground-check.ts`
is the acceptance: it walks every served bore from two metres outside the
mouth to the far wall of the room on the server's own ground query, and it
walked **1 of 28** before the following and **28 of 28** after.

- **The mouth** is the OSM entrance, moved clear of any building over the pad,
  the mouth, or the head of the incline (`riding.stationAccessPlan`, rings of
  eight compass points, the least-intruded candidate if none is clear). Its
  height is the terrain, not the bake's entrance DEM.
- **The incline** is 1:1.33 -- an escalator's pitch -- because a 1:2 ramp to a
  railhead thirty metres down is a sixty-metre strip no CBD block leaves free.
  Its box overlaps the street as a *flat* pad (`StationBox.riseMax`).
- **The floor** is one level wall to wall, midway between the highest and
  lowest calling railhead plus the platform height (`RailStation.concourseY`,
  derived at decode on both ends). Platform strips are flush with it; a train
  on a lower level sits in the slab, a higher one floats, both within
  `BOARD_RISE_M`. It was the ballast with 1.45 m kerbs.
- **The lid** is under the street (`riding.roomCeilY`): the bake put Wynyard's
  five metres above York Street.
- **The street stays**: `rail.SPAN_DEEP` marks every vertex the pipeline
  measured more than 8 m under the DEM, and the carve and the drawing both
  treat it as a bore; `RailCut` also never carves over a served bore's box.
- **A body on the street is not in the room**: `StationBoxField.floorAt` takes
  the terrain and declines unless the floor is at the ground or the body is
  already under it.
- **The field follows the buildings**: `world.boxesOf` rebuilds when a
  collision tile lands; `main.ts` rebuilds on the same tick as the vessels and
  drops the rail chunks over a mouth that moved.
