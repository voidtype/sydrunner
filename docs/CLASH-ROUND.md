# The clash round — where the world intersects itself, counted

The report this answers, in full:

> *"The world overlaps with itself a lot, like the different 3d models intersect
> everywhere all the time"*

That is one sentence and it is not one defect. `server/clash-check.ts` turns it
into twelve, each a pair of populations with its own predicate, its own
`BUDGET_*` ratchet and its own control. **Measurement only: nothing in
`pipeline/` was touched and nothing was deployed.**

Whole build, `index.built` 1788586540, 22,928 tiles in **622 s** — no `.glb` is
opened, which is what puts the 60 km inside ten minutes. Populations read:
17,433,402 stems, 808,701 furniture, 1,398,902 parked cars, 1,297,775 buildings,
72,021 structures, 7,623,838 water vertices.

    bun run server/clash-check.ts
    bun run server/clash-check.ts --near -300,-1100 --radius 800     # one place
    bun run server/clash-check.ts --kerb-inset 1.5                   # fence-audit terms

## The table

| pair | populations | count | unit | total |
|---|---|---:|---|---:|
| `WATER_OVER_TERRAIN` | water sheet bed × shipped terrain | ~~63,089~~ **0** | vertices | 0 m |
| `FURNITURE_ON_ROAD` | pole/bin/post/signal × carriageway | **14,562** | items | 3,650 m² |
| `BUILDING_IN_BUILDING` | footprint × footprint | **4,850** | pairs | 687,629 m² |
| `TREE_IN_BUILDING` | tree stem × footprint | 718 | stems | 6,178 m |
| `DECK_IN_BUILDING` | deck/structure × footprint | 513 | pairs | 10,733 m² |
| `BUILDING_UNDER_WATER` | footprint × water surface | 400 | buildings | 310 m |
| `RAIL_GAUGE` | anything baked × the volume a train sweeps | 222 | items | 241 m |
| `STATION_IN_BUILDING` | station room/access × footprint | 65 | pairs | 28,665 m² |
| `DECK_UNDER_TERRAIN` | deck/structure × the terrain over it | 35 | prisms | 132 m |
| `FURNITURE_IN_BUILDING` | pole/bin/post/signal × footprint | 29 | items | 72 m |
| `CAR_IN_CAR` | parked car × parked car | 2 | pairs | 5 m² |
| `CAR_IN_BUILDING` | parked car × footprint | 1 | cars | 7 m² |

The two struck rows are the sampler correction below, not a retile: the world
this table was taken from has not changed. Every budget is set to its own row and
is a fence, not a target. Sub-counts: `WATER_OVER_TERRAIN` split 38,076 floating
/ 25,013 proud under the old bilinear read and is now empty; `FURNITURE_ON_ROAD`
into 5,171 poles, 4,340 bins, 2,654 posts, 2,397 signals; `RAIL_GAUGE` into 183
decks, 12 cars, 10 poles, 9 buildings, 5 bins, 2 posts, 1 signal.

## The three worst, and the pass that would remove each

**1. `WATER_OVER_TERRAIN` — 63,089 vertices — was this audit, and it is now 0.**

The row read: a sheet carries an absolute `surface` and a per-vertex `depth`, so
`surface − depth` is the ground `water._wet_pieces` cut the triangle against, and
that number and `.terr.bin` agreed to a mean of 39 mm and then disagreed by up to
23 m. The verdict above was that the sheet is clipped against one terrain and
shipped beside another, and **that verdict was wrong**. It was the same terrain
throughout. `clash-check.sampleGround` read `.terr.bin` **bilinearly**; the
pipeline cuts the sheet against `terrain.Terrain.sample` and the client draws the
ground through `world/terrain.ts sampleTileGrid`, and both of those are **two
triangles per cell, split north-west to south-east**. The gap between the two
readings is the cell's twist, `(nw + se − ne − sw) / 4` — millimetres on a
footpath, metres on a harbour cell with one corner cut down to the bed and the
next standing on a cliff, and it carries both signs, which is exactly the shape
the row had.

Measured over every water vertex in the same shipped build, with nothing in
`pipeline/` touched and nothing re-emitted: bilinear names 63,089 (38,076
floating + 25,013 proud, worst 23.35 m) and the triangle split names **0**, worst
0.00 m. `water.py`'s guarantee — *"no ground pokes through a drawn sheet"* — was
being kept the whole time and `_wet_pieces` was enforcing it against the lattice
that shipped.

Two things corroborate it rather than one. The scan's own terrain control, which
compares its read against `TilePower.groundY` over 2,000 poles, went from **11 mm
to 0 mm** when the sampler changed — `power.py` sets `ground_y` from
`Terrain.sample`, so an exact zero is the pipeline agreeing with itself. And
`DECK_UNDER_TERRAIN`, the other pair that reads the ground, moved 34 → 35: one
more prism of the *same* buried deck at (501, −1204), which is a threshold
crossing on a corrected surface and not a new defect. Its budget carries that
sentence.

The pipeline pass this row asked for would have moved 63,089 water vertices off
the ground the client actually draws. It was not written, and it should not be.

**2. `FURNITURE_ON_ROAD` — 14,562 poles, bins, posts and signal heads standing
in a live carriageway.** Neither `furniture._blocked_at` nor `power._blocked_at`
has a carriageway keep-out at all: both test junction, pole, tree and building
and stop. Each item is placed outside *its own* way's kerb by construction
(`half + KERB_WIDTH + setback`), and `lanes.py` and `streets._half_width` compute
the identical half-width, so a same-way offender cannot exist — every one of
these is inside a **different** way's carriageway, at a junction, a slip lane or
a street OSM has mapped twice. The table proves it without further work:
`furniture.BIN_CLASSES` is `{residential, unclassified, living_street, tertiary}`
and bins are reported standing in `primary` and `service` carriageways, which
their own placer will not put them on. **The pass is a `landmarks.suppress`-shaped
filter** — a keep-out swept from the whole emitted lane graph, applied to the
placed items after placement rather than inside each per-way placer, exactly as
`suppress` filters the merged building list rather than teaching every producer
about landmarks.

**3. `BUILDING_IN_BUILDING` — 4,850 pairs, 687,629 m² of shared footprint.** The
top of the table is *exact duplicates*: `61,572 m² shared of 61,572 m²`,
`11,456 of 11,456`, `9,807 of 9,807`. `merge.merge()` deduplicates Microsoft
against OSM with a unioned 35 % overlap test and takes the OSM list whole —
`out = [_from_osm(b) for b in osm_buildings]`, unconditionally — so nothing in
the build ever compares OSM against OSM, and `sources/osm.py` drops a
`building:part` only on the exact pair `building=yes` + `building:part=yes`.
**The pass is `merge.py`**: the union-overlap test it already has, turned on its
own OSM input.

## What the table also says, which is not a defect list

Three rows are near zero and they are the argument for the other nine.
`CAR_IN_BUILDING` is **1** of 1,398,902 and `CAR_IN_CAR` is **2**, because
`parking._place` tests buildings at the bay's *circumradius* and
`_clear_of_each_other` does exact rectangle-against-rectangle; the two survivors
are tile-seam cases its per-tile easting window cannot see. `FURNITURE_IN_BUILDING`
is **29** of 808,701, because both placers do have a building keep-out. The
pipeline is not uniformly careless — it is careless in named places, and this is
which.

Two more worth a line each. `DECK_UNDER_TERRAIN`'s 35 are **one deck**: all
within six metres of (501, −1204), because `decks.prisms` emits one prism per
segment. `BUILDING_UNDER_WATER`'s 400 are 399 of the *same* 0.80 m — a roof at
0.8 m below the AHD datum against sea level exactly, which is one systematic
footprint rather than four hundred flooded houses — plus one real outlier 12.68 m
under a pond at (−24710, 27141).

## What could not be measured

- **Anything only a `.glb` knows.** Landmark kit inside `landmarks.glb` takes
  part only through its collision prisms, so an Opera House shell intersecting
  something is invisible here.
- **The railway's own kit against itself.** That is `server/rail-gauge-check.ts`
  and it is not duplicated. `RAIL_GAUGE` here asks the opposite question: the
  *city* inside the gauge.
- ~~**Terrain sampled bilinearly against a client that draws two triangles per
  cell.** The residue peaks at the cell centre; both terrain-facing pairs carry
  thresholds well over it.~~ **That assumption was wrong and it was the whole of
  row 1** — the residue is not bounded by those thresholds anywhere the ground
  is steep, which is precisely where the water is. `sampleGround` now reads the
  same split, and the validation against `TilePower.groundY` is exact: 0 mm mean
  over 2,000 poles, against 11 mm bilinear, and the mirrored row order still
  6.94 m out. **`undrawn-solids-check.sampleGround` is still bilinear.** Nothing
  it measures lives on a shoreline, so this says only that it has not been asked.
- **Whether a `TREE_IN_BUILDING` stem is a surveyed node.** The `.veg.bin` has no
  origin byte. That every one of the 718 must be surveyed is an inference from
  the placers, not a reading.
- **Union carriageway overlap.** `onCarriageway` takes the largest single span,
  not the union of the buffered polyline.

## The controls

Each predicate is a pure function and `runControls` drops a synthetic offender
through the real one — and, where the distinction is the point, a legal
neighbour too: a party wall against a real overlap, a post on the kerb against a
post in the road, two cars nose-to-tail against two in one bay, a square in the
notch of an L against a square inside a square, an object 4 m from a running line
against one on it, a real span from the real rail index against a point 56 m off
it. The build's own terrain read is re-validated every run. A zero row in this
table means the scan looked; it is not an absence of evidence.
