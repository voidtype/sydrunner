# Bushland: giving the national parks their trees

Written 2026-08-10 against the shipped 60 km world. **Plan only — nothing here
is implemented.** The user's report: *"national park etc need more default tree
coverage… is there tree coordinate list somewhere or something?"*

## The short answer to the question asked

**Yes and no, and the "no" is the interesting half.**

*Yes:* the extract carries **98,072 `natural=tree` nodes** — individually
surveyed positions, and `vegetation.py` already uses every one of them as
source (a), never moved and never thinned. That is a real coordinate list and
it is already fully exploited.

*No:* those 98,072 are almost entirely **street and park specimens in mapped
suburbs**. Nobody hand-surveys Ku-ring-gai Chase. There is no per-tree list for
bushland anywhere, for the same reason there is no per-brick list for the CBD —
the unit of truth out there is the **stand**, not the tree.

And the stands *are* mapped, richly:

| polygon | count in the 60 km extract |
|---|---:|
| `natural=wood` | **7,772** |
| `leisure=park` | 7,178 |
| `leisure=garden` | 3,981 |
| `natural=scrub` | **3,395** |
| `natural=grassland` | 868 |
| `landuse=meadow` | 619 |
| `leisure=nature_reserve` | 371 |
| `natural=heath` | 347 |
| `landuse=forest` | 169 |
| `boundary=protected_area` | 128 |
| `leisure=golf_course` | 116 |

## Why the parks are bare, in one sentence

`vegetation.py` has exactly three sources — mapped trees, procedural street
trees, and **park interiors scattered at low density** — and that third one is
deliberately tuned for *Hyde Park*: its header says "a Sydney park is mostly
open grass with big specimen trees standing in it, not a forest, so the density
is low". That is exactly right for Hyde Park and exactly wrong for Ku-ring-gai
Chase, and **`natural=wood`, `natural=scrub`, `landuse=forest`, `heath` and
`nature_reserve` are not read at all** — 12,054 bushland polygons the pipeline
has never looked at.

So the fix is not a new data source. It is a fourth source over polygons that
are already in the extract, with a density model that knows the difference
between a lawn and a forest.

## The plan

### 1. A vegetation *class*, not a density number

Each polygon type maps to a class carrying density, height range, canopy
radius, understorey and colour:

| class | from | stems/ha | height | notes |
|---|---|---:|---|---|
| open forest | `natural=wood`, `landuse=forest`, `protected_area` | 180–350 | 12–30 m | the Hawkesbury sandstone default: eucalypt, broken canopy, sky visible |
| woodland | wood ∩ steep, ridge tops | 80–160 | 8–18 m | sparser, wind-shaped |
| scrub / heath | `natural=scrub`, `natural=heath` | 400–900 | 0.6–3 m | *not trees* — a distinct low instance, and most of the coastal parks |
| riparian | wood within 40 m of water | 300–500 | 15–35 m | taller, denser, darker |
| grassland | `grassland`, `meadow` | 0–15 | — | ground colour, scattered lone trees |
| parkland | `leisure=park` | **unchanged** | | today's rule, which is correct |
| golf | `golf_course` | 25–60 | 10–20 m | fairway-avoiding clumps |

Scrub and heath matter more than they sound: 3,742 polygons, and they are what
Royal and the coastal heath actually look like. Planting 20 m eucalypts there
would be as wrong as planting nothing.

### 2. Placement: jittered grid, seeded per polygon, never per tile

Reuse the invariant `vegetation.py` already documents — *generate from the
source object, assign to whichever tile contains the point* — so a stand
straddling a tile line is emitted once and identically from both sides. Poisson
disc is unnecessary; a jittered lattice at the class spacing, hashed off
`(polygon id, lattice index)`, is deterministic, cheap and looks natural once
size and species vary.

Density modulated by two things already on hand:
- **Slope** from the terrain grid — ridges thin out, gullies thicken.
- **Distance to water** — the riparian class above.

Subtract mapped trees inside the polygon exactly as the park rule already does,
so a surveyed stand is never doubled.

### 3. The number, and why it is the whole problem

A rough integral over the bushland polygons in the disc is **60–90 km² of
forest**. At 250 stems/ha that is **1.5–2.2 million new trees**, on top of
today's 1,757,469 — call it **a doubling**.

That is the engineering problem, not the tagging. Three things make it
affordable, and the plan lives or dies on them:

- **They are never all near you.** The existing veg system is per-tile and
  streamed; bushland tiles are otherwise cheap (no buildings, few roads, no
  parked cars), so the budget freed by an empty tile is exactly the budget the
  trees need.
- **Impostors past ~120 m.** A camera-facing cross of two quads with a baked
  canopy texture, one instanced draw per species per tile. The near tier keeps
  today's geometry. This is the same near/far split `carlod.ts` uses and the
  same argument.
- **Byte cost is small.** A tree is a position, a species byte and a scale
  byte — 8 bytes packed. Two million trees is ~16 MB across 18,113 tiles,
  under 1 KB per tile average and mostly concentrated in the 3,000-odd
  bushland tiles. Against a 12 GB world that is noise.

### 4. Ground colour first — it may be most of the win

Look at the screenshot that prompted this: the bare hill reads wrong as much
because it is **flat tan dirt** as because it has no trees. `park_grass` is
already a material slot; adding `bushland`, `scrub` and `grassland` slots and
painting the polygons is a *fraction* of the work of two million trees and
fixes the horizon on its own. **Do this first and measure before planting** —
it is entirely possible the trees can then be sparser than the table above,
which would make the whole thing cheaper.

### 5. Optional: real canopy data, if OSM proves too coarse

Not needed for a first pass, and named only so the option is on record.
Global canopy height rasters (ETH 10 m, Meta/WRI 1 m) would let density and
height come from measurement rather than from a per-class constant, and would
capture cleared land inside park boundaries that OSM tags as forest. Cost is a
new raster dependency in the pipeline and a per-tile sample; the benefit is
mostly in the outer ring where OSM's polygons are coarsest. **Revisit only if
the class model looks obviously wrong in play.**

## Order of work

1. **Ground materials** for bushland/scrub/grassland. Cheap, immediate, and
   possibly enough on its own.
2. **The class table and the fourth source**, wood and scrub first — those two
   are 11,167 of the 12,054 polygons.
3. **Impostor tier** for the far field, then raise density to taste.
4. Riparian, slope modulation, golf.

Steps 1–2 are a pipeline change and therefore a world rebuild: **5h42m and a
12 GB republish**. That cost is why this should be batched with the other known
pipeline debt rather than run alone —

- the **building over the railway** at Erskineville and 344 other cells
  (`elevated.py`'s over-road rule has never heard of a railway),
- the four road-spanning prisms `clearance-audit` still fails on (Westfield
  Hurstville, The Rocks),
- **`water-audit`'s threshold**, which does not scale with extent and now
  false-positives at 49% ocean.

One rebuild, four fixes.
