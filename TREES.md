# Bushland: giving the national parks their trees

Planned 2026-08-10, **built 2026-08-23**. The user's report: *"national park etc
need more default tree coverage… is there tree coordinate list somewhere or
something?"*

The plan below is what shipped, with three things it got wrong corrected in
place and marked. The code's own headers are the authority --
`pipeline/sydney/vegetation.py` for the scatter and the budget,
`pipeline/sydney/sources/osm.py`'s green block for the classes and the overlap
rule, `client/src/world/cover.ts` for the horizon.

## The short answer to the question asked

**Yes and no, and the "no" is the interesting half.**

*Yes:* the extract carries **98,072 `natural=tree` nodes** — individually
surveyed positions, and `vegetation.py` already used every one of them as
source (a), never moved and never thinned. That is a real coordinate list and
it was already fully exploited.

*No:* those 98,072 are almost entirely **street and park specimens in mapped
suburbs**. Nobody hand-surveys Ku-ring-gai Chase. There is no per-tree list for
bushland anywhere, for the same reason there is no per-brick list for the CBD —
the unit of truth out there is the **stand**, not the tree.

And the stands *are* mapped. Counted over the 60 km extract, clipped to the
emitted world box, de-overlapped:

| | polygons | km² in the box |
|---|---:|---:|
| `natural=wood` | 7,393 | 2,233 |
| `landcover=trees` | 199 | 1,643 |
| `boundary=protected_area` | 127 | 1,587 |
| `leisure=nature_reserve` | 361 | 1,037 |
| `natural=grassland` | 811 | 53 |
| `landuse=meadow` | 566 | 52 |
| `natural=wetland` | 1,027 | 43 |
| `leisure=golf_course` | 113 | 40 |
| `landuse=forest` | 161 | 37 |
| `natural=scrub` | 2,752 | 28 |
| `natural=heath` | 270 | 6 |
| **everything the read looked at before** | — | **272** |
| **everything, de-overlapped** | — | **3,188** |

**2,917 km² of ground the pipeline had never looked at**, against 272 km² it
had. Lane Cove National Park carries three of those tags and was in none of the
sets.

## What shipped

### 1. A cover class, and a rank that settles an overlap

`sources.osm.GREEN_COVER` maps 27 tag values onto **six cover classes** and a
**rank**. The rank is the part the plan did not have and the part the data
demanded: Lane Cove NP is `boundary=protected_area` *and*
`leisure=nature_reserve` *and* `natural=wood`, with mown picnic lawns, a
mangrove reach and heath ridges drawn inside all three. An administrative
boundary is a claim about who owns the ground; a mower is a claim about the
ground. So the order runs most-specific first — pitch, mown, wetland, heath,
scrub, rough, tagged forest, administrative forest — and it is applied twice:
per polygon at the read, and **between** polygons by `vegetation.surfaces`
(which subtracts every better-ranked class out of each worse one) and by the
scatter (which refuses a stem standing inside a better-ranked polygon).

Measured over one 25 ha tile of each class alone, through the real
`instances()`, after the per-tile cap:

| class | from | ground | stems/ha as built | tri/tile |
|---|---|---|---:|---:|
| mown | park, garden, pitch, playground, grass, recreation_ground, village_green, cemetery, grassland, common, landcover=grass | `park_grass` | 16.0 (unchanged) | 46,246 |
| rough | golf_course, meadow, orchard, plant_nursery | `bush_floor` | 5.8 | 14,992 |
| forest | wood, forest, landcover=trees, nature_reserve, protected_area, conservation | `bush_floor` | **69.6** | 39,992 |
| scrub | scrub, shrubbery | `bush_floor` | 62 shrubs + 4.0 trees | 39,386 |
| heath | heath | `bush_floor` | 64 shrubs, **no trees** | 38,400 |
| wetland | wetland | `wetland_mud` | 59 shrubs + 3.8 mangrove | 37,302 |

(`mown` is the one row that is not new. Its 46,246 triangles are the existing
`MAX_TREES_PER_TILE` of 400 park specimens, which this round did not touch and
which is why the bushland budget is charged *after* it and reduced by it.)

*The plan's seven classes became six.* "Woodland" (wood ∩ steep) and "riparian"
(wood within 40 m of water) were dropped: both are modulations of forest by a
field the pipeline already has, both are worth having, and neither is worth a
class of its own until the density they modulate is the real one rather than an
eighth of it.

### 2. Two ground materials, not three

`bush_floor` and `wetland_mud`. Four classes share the first, because underfoot
a forest, a scrub, a heath and a golf rough *are* the same sandstone grit, bark
litter and dry sedge — the difference between them is vertical, and vertical is
the instances' job. `wetland_mud` could not share it: estuarine mud is the one
green polygon in Sydney that is not a vegetation colour, and dry leaf litter
painted on the Homebush mangrove flats is worse than the bare dirt it replaces.

The three green slots are **cut disjoint** per tile, so no square metre is
painted twice and there is no z-fight between two ground materials a centimetre
apart.

### 3. The density, and the arithmetic that says it cannot be the real one

*This is where the plan was most wrong, and it was wrong in the interesting
direction.* It proposed 180–350 stems/ha for open forest and 400–900 for
scrub/heath, and estimated "1.5–2.2 million new trees — call it a doubling".
Both figures are ecologically sound and neither is drawable.

Sydney coastal dry sclerophyll carries 300–600 stems/ha over 10 cm DBH, of
which the **canopy layer** — the thing an instance with a crown represents — is
100–200/ha (Benson & Howell, *Taken for Granted*; NSW BioNet Sydney Basin
benchmarks). **2,917 km² at 150/ha is 43.8 million trees.**

### The budget: the first cut of this round got it wrong twice

**Wrong once on the frame.** The ceiling was set from `world/vegetation.ts`'s
measured 483 k tree triangles over 25 tiles, plus 232 k of buildings — 715 k,
and 28,000 a tile. That is not the frame. `world/cars.ts` measured the *same
camera, same 1.8 km radius, worst heading* and holds the rest of it:

| the CBD spawn frame | triangles |
|---|---:|
| parked cars (3,759) | 398,000 |
| trees (5,914) | 520,000 |
| buildings + streets | 232,000 |
| traffic movers (~210) | 23,000 |
| **and it ships** | **1,173,000** |

— and that is a *floor*, because the crowd, the police, the street furniture,
the power spans and the nameplates are in that frame and in neither file. A
bushland tile carries none of the cars, none of the crowd, none of the
furniture, and 2,800 triangles of static mesh against an urban tile's 12,600
median. Parity on the *whole* frame is therefore
(1,173,000 − 25 × 2,800) / 25 = **44,100 a tile**, and
`BUSH_TRIANGLE_BUDGET` takes **40,000** — 91% of the CBD frame, the margin left
for the shadow pass, which is the one place bushland comes out heavier
(400 k triangles inside the 440 m caster range against the CBD's ~195 k of
trees plus its buildings).

**Wrong twice on the lever.** Even at 40,000, four real silhouettes averaging 96
triangles buy 416 stems a tile — 17/ha. The first cut shipped 11.6/ha, which is
*sparser than the mown park next door at 24*, and a bushland round whose forests
are thinner than Hyde Park is the original defect with more code around it. The
arithmetic that matters is one line:

    100 canopy stems/ha × 25 ha = 2,500 stems
    40,000 triangles ÷ 2,500    = 16 triangles a stem

No mesh in the six is within a factor of four of that, and no budget makes one
so. **`BUSH_TREE` is 14** — a three-sided trunk cone and one octahedral crown,
12 vertices, a tenth of a eucalypt — and **nine stems in ten** in every bushland
stand is drawn with it, the tenth carrying whichever full silhouette the mix
picked, spread evenly by the same hash as everything else. That is a
**stochastic level of detail wearing a species slot**, and it is named as one:
the same stem draws cheap at four metres and at four hundred, because the
pipeline does not know where the camera will be and the client has no distance
tier. It buys **69.6 canopy stems a hectare at ~80% canopy cover**, against 11.6
and 13%.

**The impostor is what unlocks the rest, and it is the named next round.** Four
triangles a stem puts 10,000 in the same budget — and, more to the point, makes
the detail a function of *distance* rather than of a hash, which is what it
should always have been. The seam is where `world/vegetation.ts` has always said
it is; it is refused here because it is a client rendering round and this was a
data round.

One more thing the budget bought for nothing: bushland trees draw from the
**top** of their species' size range rather than the middle (`BUSH_T_FLOOR`),
because a stand of forest is mature and the small stems in it are understorey.
That is what takes 69.6 stems a hectare to 80% cover rather than to 45%.

### 4. Two new silhouettes: `SHRUB` and `BUSH_TREE`

The plan called scrub and heath "a distinct low instance" and it was right.
`SHRUB` is species 6: three octahedral lobes, no trunk, **24 triangles**
against the eucalypt's 100 and the fig's 162. It exists because heath and scrub
cannot be told without it — a 15 m eucalypt on a coastal heath is a lie about
the landscape, a eucalypt scaled to 1.5 m is the exact distortion
`vegetation-audit` exists to convict, and bare ground is the defect being
fixed. It is the only reason heath is affordable at 64 stems a hectare.

`BUSH_TREE` is species 7, **14 triangles**, and the budget section below is its
whole argument. The pair of them is why this round's currency is triangles: at
24 and 14 against 64–162, every one of them buys a stem.

### 5. Ground colour, and the half of the defect the plan found

The plan's step 4 — *"the bare hill reads wrong as much because it is flat tan
dirt… do this first and measure"* — was right, and it was right about more than
it knew. Past the streaming radius there are no instances and no surface slots
at all: the horizon is `far-terrain.bin`, a 243 × 243 post heightfield wearing
`ground.ts`'s dry-buff-soil material, which has never had any idea what grows on
it. Fixing only the near field would have put a line across the landscape at
1.8 km with green on one side and brown on the other.

So `far-cover.bin`: **one byte per far-terrain post** — three bits of cover
class, five bits of how much of that 500 m cell it covers — **59 kB for the
whole 60 km world**, and one `mix` in the far ground's colour node. Seven
tints, every one measured against `ground.ts`'s own soil and darker than it,
because a cover colour lighter than the dirt makes the hills *pale* rather than
green. `verifyCanopy` asserts exactly that, in both boot lists.

**Impostor clumps in the far layer are refused**, and the reason is that at two
kilometres an individual crown subtends under an arcminute: what the eye reads
on a forested ridge is the tone and the way it follows the terrain, which is
precisely what a per-post colour gives. Silhouette at the ridge line is real and
second-order, and it belongs with the near-field impostor above.

*Note for whoever reads the old plan:* `far.ts`'s `FAR_TINT` was named in the
brief as the cause of the brown. It is not — that table is indexed by a
*building's* wall material and `far.bin` holds only buildings, so its
`park_grass` row has never been read by anything. It still needs a row per slot
or the file throws at import, and the two new slots have one each.

### 6. The audit

`sydney canopy-audit` — stems a hectare **by cover class** over the emitted
tiles, against a per-class ceiling, with the worst tile's draw cost beside it.
It reads the shipped `.veg.bin` sidecars and rebuilds the class map from OSM
independently of the emitter, so the two agreeing is a fact rather than a
tautology. It ends on a control that plants a forest at a known density in a
real polygon and must measure it back within 12% — which is what convicts a
frame error, the failure that would otherwise make every class read zero and
every ceiling pass.

## What the plan got right and this did not change

- **Placement**: jittered lattice, seeded per polygon, never per tile;
  generate from the source object and assign to whichever tile contains the
  point. Two refinements the size of the polygons forced: the lattice is
  generated and cached **per 500 m block** (the largest single `natural=wood`
  part is 550 km² with a 27 × 44 km bounding box, and 690,000 stems held in a
  cache is not a thing a tile can ask for), and the mutual-separation test is
  replaced by a **bounded jitter** — confining each stem to the middle
  `(cell − clear) / cell` of its own cell gives the same minimum spacing
  analytically, in O(1), with no dependence on the order cells were walked in.
  Without that second change the source could not have been blocked at all.
- **Subtract mapped trees**, so a surveyed stand is never doubled.
- **The upgrade path**: Meta/WRI 1 m canopy height, the NSW State Vegetation
  Type Map, and the Greater Sydney Region Tree Canopy 2022 mesh-block
  percentages as the **calibration target** for the round that raises the
  density. All three are named in `vegetation.py`'s header with what each one
  would replace.

## What it is going to cost to ship

The sample was twelve tiles chosen by measurement
(`data/scratch/bushland-round/TILES.txt`). The full round is a **retile**, and
the number that decides its size is not the trees:

**Green now touches 20,198 tiles, of which 5,184 are not emitted today** —
overwhelmingly forest, in the outer ring where a national park is the only thing
in a square kilometre. Add the 12,114 already-emitted tiles that gain bushland
and **17,298 of the world's tiles are written, which is 95% of it**. This is a
full retile in everything but name and should be planned as one.

| | today | after | note |
|---|---:|---:|---|
| tiles | 18,113 | 23,297 | **+29%** |
| tiles written | — | 17,298 | 5,184 new + 12,114 re-emitted |
| region bundles | 5,302 | 6,109 | 807 new, 5,172 change content |
| hexagons | 86 | 87 | **one new: `h-01+07`**; 83 of 87 need repacking |
| `index.json` | 4.89 MB | ~6.3 MB | server- and audit-side only; a segmented client boots from `root.json` at 31 kB |
| `hexes/` | 18.8 MB | ~24 MB | the tile lists live here now |
| `far.bin` slabs | 110,460 | **110,460** | unchanged, and structurally so: `far.bin` holds only buildings ≥10 m or ≥400 m², and not one new tile has a building on it |
| `far-cover.bin` | — | 59,049 B | new whole-world pivot |

**What is structural and what is not.** The far layer does not move at all — no
new slabs, no new groups, no new per-hex `.far.bin` — because bushland tiles
carry no buildings. The one new hexagon is a manifest and a directory entry. The
client's streaming budget at the world's edge *does* change and that is the
whole point of the budget section above: where Ku-ring-gai used to stream
nothing at all, it now streams ~40 k triangles of canopy a tile, which is why
that number is pinned to the measured CBD frame rather than chosen.

**The box gets off lightly.** A building-free bushland tile is 23.7 kB on the
CDN today and the server reads 1.5 kB of it (`.terr.bin`, `.lanes.bin`,
`collision/`, and no `.cars.bin` because there is no parking); the new tiles add
`.veg.bin`, which the server never reads at all. So 5,184 new tiles is about
**7.5 MB** of rsync to `oxford-tractor` and ~130 MB of R2, against the world's
existing 16 GB.

Everything else follows DEPLOY.md §B: snapshot, the four audits plus
`canopy-audit`, the terrain byte-diff, `restore-region-mtimes.py` (which will
save almost nothing this round — 5,172 of 5,302 bundles change), the hex repack,
the R2 upload and the server rsync. `far-cover.bin` is a whole-world artefact
and cannot be sampled: it is its own command (`sydney far-cover`, about a
minute) and it needs one block added to `index.json` under `far.terrain` before
the client will read it.
