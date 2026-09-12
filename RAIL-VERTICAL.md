# Where the railway sits: one rule instead of six

Written 2026-08-10, after fixing the same bug four times in different clothes.
**Strategy, to be adopted by the rail rounds in flight.**

## The pattern behind every failure so far

| what the player saw | what the data said |
|---|---|
| Sydenham buried | `surface`, depth **+8.28 m** below the grid |
| Chatswood buried | **`elevated`**, depth **+6.90 m** below the grid |
| Roseville unreachable | `surface`, depth **−2.50 m** — on an embankment |
| Lindfield reads as rails on dirt | depth **0.06 m**; really a cutting, tagged by nobody |
| Central Chalmers St 15 m under the footpath | light-rail stop snapped to the Metro bore below it |
| Cherrybrook buried | `surface`, genuinely underground |

Six reports, one mechanism: **we collapse a noisy, contradictory measurement
into a discrete label, and then let the label decide what to build.** When the
label is wrong the geometry is wrong, and — this is the part that hurt — it is
wrong *silently*, because nothing ever compares the label against the ground it
is a claim about. `elevated` with the track seven metres under the terrain is
not a near miss. It is two systems that have never been introduced.

## The rule

### 1. Measure the relationship, do not classify it

The only quantity geometry needs is a signed number, sampled **per point along
the corridor** rather than per station:

```
clearance(s) = trackY(s) − groundY(s)
```

Everything falls out of it, with no labels in the decision at all:

| clearance | what exists there | access implied |
|---|---|---|
| `> +2.0 m` | viaduct or embankment: structure below the track | steps **up** from the nearest footpath |
| `−1.0 … +2.0 m` | at grade: ballast on the ground | a **gap in the boundary fence** |
| `< −1.0 m` | cutting: carve the terrain, trench walls | steps **down**, cut into the trench wall |
| `tunnel` tag | bore: no surface expression, portals at transitions | a station box and a shaft |

**Per point, not per station**, because a 200 m platform routinely changes
category along its own length — Chatswood is exactly that, and so is every
station on the approach to a viaduct.

### 2. The label becomes an output

`vertical` stays, because the map, `/tp` and the station board all want a word.
But it is **derived from the measured profile** and can therefore never
contradict it. An assertion, not a comment:

> a station's `vertical` must agree with the sign of the median clearance over
> its platform length, or the build fails and names the station.

Chatswood at `elevated` / +6.90 m would never have shipped.

### 3. When sources disagree, precedence is stated, not improvised

The conflicts are real and will keep happening, so write the tie-break down:

1. **`tunnel=yes` wins outright.** A DEM cannot see a bore. Nothing carves, no
   surface expression, portals where the flag changes.
2. **`bridge=yes` decides the *structure*** — a deck with piers — but it does
   **not** get to claim the ground is lower than the DEM says. If a bridge span
   measures below the terrain, that is a **conflict to report**, not to obey.
   This is precisely the Chatswood failure: the classifier believed a bridge
   tag from the viaduct north of the station and stopped looking at the ground.
3. **Otherwise the DEM wins**, because the DEM *is* the ground we render and
   the player's feet stand on it. If the heightfield says the track is under
   the surface, then on screen it is under the surface, whatever OSM believes.

The one-line version: **OSM is the authority on what the structure is; the DEM
is the authority on where the ground is.** They answer different questions, and
neither may answer the other's.

#### 3a. Amendment, 2026-09-05: a portal is a transition, not a step

Rule 1 says a bore is under the ground. It never said *how far in*, and the
answer the code gave was "at the first vertex", which is a mapper's decision
about where to break a way and not a fact about a railway. Chatswood is the bill
for it, measured:

| | before | after |
|---|---|---|
| `clearance` (median over the platform) | **−10.54 m** | **−3.58 m** |
| `clearanceLo` / `clearanceHi` | −13.27 / −5.52 | −5.88 / +1.98 |
| `siteY` | 32.27 | 39.75 |
| `trackY` | 32.25 | 39.75 |

Nothing at Chatswood was ever capped — `tunnelShare` is 0.00 over the 85 m
around it and `bridgeShare` is 1.00, four platform ways all `bridge=yes`,
`layer=1`. What sank it is 291 m away. The Metro and the North Shore pair enter
tunnel together 229 m north of the platform; `bore_nodes` leaves the portal at
daylight, and then the **next vertex in, 62 m further**, has every edge
tunnelled and was asked for the whole 7.5 m of earth cover. The DEM there reads
30.53 m — twelve metres below the station — so the bound came out at 23.03 m,
and `apply_cover`'s cone, which is grade-legal and therefore reaches `d / 0.033`
metres in every direction, carried it back up the ramp and stood the deck at
32.26.

7.5 m of cover 62 m past a headwall is a 12% descent. It is not a strict
requirement, it is an impossible one, and a solver handed an impossible demand
does not refuse it — it pays for it somewhere else. So the tie-break gains a
clause, which is a statement about feasibility and not a relaxation:

> **A bore is only ever as deep as a train can have dug on the way in from
> daylight.** At its portal it owes no cover, because a headwall stands on the
> surface; `MAX_GRADIENT` metres of cover for every metre it has run after
> that; and the full `TUNNEL_COVER_M` once it has had the distance to earn it.
> The bound on a bore node is therefore
> `min(surface, max(surface − TUNNEL_COVER_M, portal_ceiling))`, where
> `portal_ceiling` is the upper envelope of the surface over the tunnel
> subgraph sourced at the portals — `rail.portal_ceiling`, the same Dijkstra
> as `_cone` and the same triangle-inequality argument.

Three things this deliberately keeps:

- **The player's absolute rule is strengthened, not weakened.** *"A rail tunnel
  should never result in the train assets being above the surface"* is the
  `min(surface, …)` term, and it now binds at every capped node **including the
  ones inside a portal transition**, which the old bound could not do, because a
  bound 7.5 m stricter than feasible is a bound the solve pays off elsewhere and
  the check then reports as satisfied. `rail-audit` 3b measures the two halves
  separately and keeps a negative control on each.
- **Nothing deep moves.** `TUNNEL_COVER_M / MAX_GRADIENT` is 227 m, so a bore
  node further than that from daylight has exactly the bound it had before.
- **One expression, two readers.** `rail.bore_cover_cap` is called by the
  constraint and by the audit, so a check that has drifted from the solver is
  not a thing that can happen here.

**What this does not buy, with the arithmetic, because the owner asked for
more.** The brief wanted Chatswood on a deck at +5 to +8 m. It is not reachable
and the reason is the ground, not the solver. Measured on the same extract by
weakening the rules one at a time: with the cover requirement set to **zero**
Chatswood comes out at **−3.58 m**, identical to what ships — so the cover rule
now costs the station nothing at all, and the remainder is the absolute rule
plus the terrain. With **every tunnel tag in Sydney deleted** it reaches
**−0.24 m**, which is the ceiling the DEM and the 3.3% ruling gradient impose
between a station node the DEM puts at 42.99 m and ground 291 m north it puts at
30.53 m. A railway cannot stand 5 m over a knoll 300 m wide whose own flanks
fall at 4.3%. Chatswood stays `surface` with its conflict recorded, which is
rule 2 working, and the last three metres are a terrain question — the DEM is a
*surface* model and the 43 m plateau over the platform is the interchange
development on top of it — not a height-solve one.

#### 3b. Amendment, 2026-09-10: the terrain question, answered

§3a ended by naming the remaining error as a terrain question and handing it on.
This is the answer, in `pipeline/sydney/bareearth.py`, gated by
`pipeline/sydney/bare-earth-check.py`. **The rule:** inside a bridge-tagged
station's platform extent, unioned with the footprints that intersect it, the
lattice reads the DSM with the *built mass of those footprints deconvolved out
of it*, before `roadgrade.solve` reads a profile.

**Three candidate answers; the data on disk chose between them, and two of them
are measurably dead.**

| answer | verdict, measured |
|---|---|
| a bare-earth DEM beside the surface one | **not on disk.** `data/cache` holds one elevation source, `terrarium/13/*.png`. ELVIS is still a follow-up in `terrain.py`'s header |
| a stated pad from OSM `ele` / `level` | **nothing to state.** Zero `ele` tags within 260 m of any of the three bridge-tagged stations in the extract. 453 `level` tags, all ordinal — and Chatswood's platforms are tagged `level=0` with the concourse at `−1`, which as metres is the error, not the fix |
| DSM minus the footprints | **available, but not by masking** |

The sketched form — mask every footprint's DSM cells, fill inward from the
unmasked ring — was implemented and measured at Chatswood: the smoothed surface
over the platforms goes **113.67 → 113.97 m, the wrong way by 0.31 m**. The
reason is in the raw pixels. Over the 800 m square around the platforms the raw
terrarium median *inside* a footprint of 1500 m² or more is **100.00 m** and
outside every footprint it is **104.00 m** — roofs are not higher than the open
ground there. Terrarium at zoom 13 is 15.87 m a pixel and Chatswood's buildings
are 20–60 m across, so no roof owns a pixel and masking a blend and filling from
blends recovers the blend. The identical measurement in the CBD, where the
buildings are 150–250 m across, gives roof 45 m against open 28 m, **+17 m**. The
estimator is not broken; it is out of resolution at a suburban centre, and a rule
proven on the CBD would have been a rule proven on the one place it works.

**What does work is subtracting rather than masking**, which is `terrain.py`'s
own standing follow-up finally built: the smoothed surface is the smoothed bare
ground plus the smoothed built mass, `G*(bare + coverage·height)`, and `G` is
linear, so `coverage·height` is rasterised from the OSM footprints, convolved
with the same 60 m Gaussian, and taken off. No mask, no hole, no dependence on a
roof owning a pixel.

| probe | DSM | built mass | bare |
|---|---|---|---|
| Chatswood station | 113.67 | 12.73 | 100.94 |
| Town Hall (the origin) | 71.07 | 16.17 | 54.90 |
| Centennial Park (control) | 27.01 | 1.21 | 25.81 |

The middle row is the calibration and the reason the coefficient is **1.0 and
not fitted**: `terrain.py` records the CBD as reading ~40 m high against a true
~28 m AHD, and this recovers 16 m of it. It under-corrects by about two and a
half in the one place the truth is written down, which is the side of the error a
subtraction from the ground must be on.

**The bound, which is the part that makes it safe.** Unbounded, the
deconvolution is right about Circular Quay and unusable: it wants **15.6 m** off
the Quay, because the CBD's towers really are in the Gaussian's tail there — and
the Quay in this world stands 35 m over its own harbour with every wharf,
viaduct and hero landmark built to that. So the drop at any post is floored at
`natural − roof_cap`, where `roof_cap` is the coverage-weighted height of the
**non-railway** buildings standing over the station's own platform decks:

| station | deck | what stands on it | cap |
|---|---|---|---|
| Chatswood | 3,092 m² | 47% under 26 m of `building=retail` (the Interchange) | **12.12 m** |
| Circular Quay | 1,692 m² | `building=train_station` awnings only | **0.45 m** |
| Milsons Point | 1,650 m² | one `building=yes` the size of the deck | **6.00 m** |

*A station is allowed to be as wrong as the roof over it, and no more.* A second
floor stops a single mis-tagged `height` cratering anything: the corrected ground
may never fall below the lowest natural ground in the 200 m ring outside the zone.

**Where it runs, and the one cost that has to be stated rather than hoped away.**
It runs **first**, before `roadgrade.solve`, because rule 1 of `pads.py` defers
to the solved street and at Chatswood the streets stand on the same plateau the
station does — the authority has to be corrected before it is consulted. That
makes this the one conform pass whose write the road solve can carry outside its
own zone: a moved post moves a road node, the graph low-pass spreads it 45 m, the
Lipschitz clamps are transitive, and `roadgrade.conform` reaches 64 m past a
corridor. Measured on the 5.3 km ring (Circular Quay and Milsons Point; Chatswood
is 8,356 m out and needs the 20 km run):

|  | 5.3 km: posts, p50 / p95 / max | 20 km: posts, p50 / p95 / max |
|---|---|---|
| moved at all | 1,693 of 148,225 (1.14%), 0.000 / 0.769 / 2.975 m | 3,805 of 1,723,969 (0.22%), 0.000 / 1.122 / 8.112 m |
| the direct write, inside the stated zones | 125, p50 0.743, max 2.975 m | 205, p50 1.957, max 8.112 m |
| the road solve's shadow, outside them | 1,568, 0.000 / 0.411 / 2.280 m | 3,600, 0.000 / 0.411 / 5.219 m |

The shadow by size is the honest picture. At 20 km: **1,098 posts over a
millimetre**, 748 over a centimetre (furthest 475 m), 521 over 5 cm, 269 over
25 cm (furthest 287 m) and **75 over a metre, none further than 65 m from a
zone**. The far tail — one post 18 km out — is the tie clamp relaxing by a
millimetre, which `roadgrade.py`'s `TIE_RADIUS_M` block already says is what a
transitive Lipschitz constraint does. On the street surface itself, 4,690 of
1,002,862 segments changed height (0.47%), p95 2.22 m, and **none further than
641 m from a zone**. So the gate is stated in two halves and both are printed:
the direct write is asserted to be inside the zones plus one cell, and the
shadow is measured and reported rather than asserted away.

**What it bought, per zone**, ground at each station node:

| station | ground off | ground on | move | zone posts, p50 / max |
|---|---|---|---|---|
| Chatswood | 40.85 | 33.49 | **−7.36 m** | 76, 5.64 / 8.11 |
| Circular Quay | −33.68 | −33.83 | −0.16 m | 73, 0.13 / 0.45 |
| Milsons Point | −32.95 | −35.13 | −2.18 m | 65, 1.51 / 2.98 |

**And what the rail bake makes of it**, both bakes run at 20 km with the solved
lattice handed to `rail.build_all`:

| | pass off | pass on |
|---|---|---|
| `clearance` (median over the platform) | **−0.53 m** | **+2.26 m** |
| `clearanceLo` / `clearanceHi` | −5.49 / +4.68 | −1.34 / **+6.05** |
| `groundY` | 40.86 | 33.50 |
| `trackY` | 42.05 | 40.24 |
| `siteY` | 40.36 | 35.68 |
| `vertical` / `structure` | surface / bridge | surface / bridge |
| `conflict` | recorded | **empty** |

Elsewhere: Circular Quay −6.85 → −6.74, Milsons Point +0.99 → +3.08, and over
the whole scoped bake **one station of 156 moved more than a metre of `siteY`,
and it is Chatswood**. `rail-audit` takes structure/ground conflicts from 4 to 2
and leaves the 47 stations more than a metre under the terrain exactly where
they were. `landmark-audit` moves two heroes and by the road shadow only — the
bridge's north ramp clearance 8.281 → 8.329, and Luna Park's whole block by a
uniform 0.399 m — with the Opera House and Sydney Tower identical to the
millimetre.

**Why it is +2.26 and not +5, with the arithmetic.** The ground under the
platform came down by 3.6 to 7.6 m along its 202 m, about 7 m at the centre, and
the clearance gained 2.79 m. The deck followed the ground down for the rest, and
the reason is one line of `rail.raw_heights`: a bridge node's raw height is
`terrain.sample(...) + BRIDGE_RISE`, and `BRIDGE_RISE` is 7.0 m. A viaduct in
this bake is **an offset from the ground beneath it, not a structure standing on
its own piers** — so every metre the terrain gives up, the deck gives up too, and
what survives is only what the 3.3% grade projection restores by pulling the
deck back toward approaches that did not move. Measured: 7.34 m of ground bought
2.79 m of clearance, 38 cents in the dollar. To reach +5 m at that exchange rate
would need about 14.5 m of ground — past the 12.12 m of roof there is over the
deck to justify taking off, and past what is on the site to take. The *node*
clearance is already +6.74, essentially `BRIDGE_RISE`, and `clearanceHi` is
+6.05: the top quarter of the platform is over the target and the median is held
down by the ends, where there is no Interchange overhead and so nothing for this
rule to remove. **The last three metres are no longer a terrain question. They
are `raw_heights`'s.**

**A fence that will need restating.** `server/chatswood-check.ts` asserts
`siteY > 38.0`. With the ground under the station 7 m lower the trains correctly
stand at 35.68 and that assertion flips to FAIL — it is a fence on an absolute
height written when the bake read the raw DEM, and it wants to be a fence on
clearance. Run against the two scoped bakes the file is otherwise identical: both
fail its section 2 for the same 115 reasons (a 156-station 20 km bake against a
267-station 60 km baseline), and the *only* differences the pass makes to its
output are Chatswood's own row, Milsons Point moving 0.19 m further, and that one
fence.

**And the finding that outranks all of it.** `rail.build_all(terrain=True)` — the
shipped `rail-bake` — loads the DEM **unconformed**: no roads, no water, no pads,
no bare earth. So the shipped bake has never seen rule 1 either, and the
`groundY 42.83` in §3a's Chatswood record is the raw terrarium surface to the
centimetre (the raw drape at the station node measures 42.82). Both bakes in
`bare-earth-check.py` are run the supported other way, with the solved lattice
handed in. **Until `build_all`'s default changes, this pass moves the ground the
player stands on and does not move the number the bake reports** — and that
mismatch is not neutral: `rail-geo` chooses trench, grade or viaduct off the
bake's profile, so a bake that still measures −3.58 m over ground that has
dropped would carve a trench into a hole. The one-line change belongs to whoever
owns `rail.py`; this round did not make it, and it is the next thing to do.
*(Made the same day — §3c.)*

#### 3c. Amendment, 2026-09-10: the bake reads the ground the player stands on

§3b's last paragraph is this one's brief, and the fix is one line in
`rail.build_all`: `Terrain.load(radius_m, conform_roads=False,
conform_water=False, conform_pads=False)` becomes `terraincache.load(radius_m)`,
which is the identical call `cli.py:561` makes to cut every `.terr.bin`.

**The argument, because "read the conformed lattice" is not self-evidently
right.** Rule 3.3 above does not say the DEM wins because it is raw. It says the
DEM wins *"because the DEM **is** the ground we render and the player's feet
stand on it"*. That clause is the whole authority, and the unconformed drape has
none of it: nothing in the world is built on it and nobody stands on it. It was a
fourth opinion about the ground, and the bake was the only reader.

**What the fourth opinion cost, which is not a style point.** Two decisions in
`world/rail-geo` are taken per span, and they were reading different grounds:

| decision | where the number comes from | which ground |
|---|---|---|
| **bore** — `rail-cut.drawnAsTunnel` | `game/rail.deepen`: the bake's own `vertexClearance < −DEEP_M` | the bake's |
| **trench** — `rail-cut.inTrench` | `rail-geo` PHASE_SEGMENT: `depth = rawGround(x, z) − trackY` | the streamed lattice |

So the railway decided where to bore against one surface and where to dig against
another. Measured over the 16,481 polyline vertices of a 20 km bake, the two
disagreed by a median of **0.50 m**, a p95 of **4.19 m** and a maximum of
**22.85 m**, with **11,024 of them past 0.30 m** — and 52 vertices were the exact
failure §3b predicted: the bake reading at-or-above grade while the rendered
ground wanted a trench more than a metre deep. After the change every one of the
16,510 vertices agrees **to the bit**, because there is one array and one sampler,
and the holes are **52 → 0**.

**Measured on two 20 km bakes, identical but for the `Terrain` handed in** —
`before` is the line as it stood, `after` is `terraincache.load`:

| | before | after |
|---|---|---|
| station records moved > 0.25 m | — | **104 of 156** |
| Chatswood `groundY` / `trackY` / `siteY` | 30.72 / 36.22 / 35.68 | 33.50 / 40.24 / 35.68 |
| Chatswood `clearance`, `vertical` | +5.73, elevated | **+2.26, surface** |
| Circular Quay `groundY`, `clearance` | −53.35, +13.28 | **−33.84, −6.74** |
| Milsons Point `groundY`, `clearance` | −33.82, +4.58 | −35.13, **+3.08** |
| bore vertices (`SPAN_TUNNEL` ∪ deep) | 3,490 | 3,492 |
| trench vertices | 5,676 | **5,351** |
| holes | **52** | **0** |
| structure/ground conflicts | 4 | **2** |

Chatswood's `after` row is §3b's number to the centimetre, which is the check
that this is the same ground that document measured. Its `before` row is not the
shipped 60 km bake's (−3.58 m) and the difference is worth its own sentence:
`Terrain.load` grew a fourth flag, `bare_earth`, defaulting on, and the rail
bake's call named only three — so for five days the bake read a hybrid nobody
chose, the raw drape with the built mass deconvolved out of three station zones.
Taking every default `cli.py` takes is the only spelling of *"the same ground as
the tiles"* that a new pass cannot silently break.

**Nothing gained a bore.** Six stations lost the word `elevated` (Artarmon,
Chatswood, Circular Quay, Macdonaldtown, Milsons Point, West Ryde) and none in
either direction became `underground`. Four crossed the −1 m band into a cutting
— Circular Quay, Waverton, North Strathfield, Wiley Park — and every one of them
was **already** under the rendered ground before the change, measured off its own
old track: +7.86 m, +1.87 m, +1.48 m and +0.29 m of depth that `rail-geo` was
going to find whatever the bake said. The change reported those holes; it did not
dig them.

**Circular Quay is the one to look at, and it is rule 2 working.** Its record goes
from `+13.28 m, elevated, no conflict` to `−6.74 m, surface, conflict recorded` —
21.14 m of disagreement removed in one line. The Cahill viaduct's deck really is
under the conformed lattice's surface there, because the CBD DEM reads high by a
building and `bareearth.roof_cap` **deliberately** declines to correct the Quay
(§3b: unbounded, the deconvolution wants 15.6 m off it and is unusable). So the
station is now a station whose OSM structure and whose ground disagree, which is
exactly the case rule 2 exists to *record rather than obey*. It is a real, open
defect with a name on it instead of a number that looked fine because two errors
of opposite sign cancelled.

**`rail-audit` goes from two hand-asserted failures to one, and the one that is
left must not be edited away.** Run over both 20 km bakes — same `build_all`,
same `audit`, two `Terrain` objects:

| | before | after |
|---|---|---|
| section 3's named station profiles | **2 FAIL**: Milsons Point and Chatswood both came out `elevated`, expected `surface` | **1 FAIL**: Circular Quay came out `surface`, expected `elevated` |

The two it fixes are the two whose expectations already carry the reason in this
document's own words — *"the DEM is the ground that renders"*. The one it leaves
is Circular Quay, and the temptation is to change that expectation to `surface`
the way Chatswood's and Milsons Point's were changed. **Do not.** Those two were
re-expected because the measurement was right; this one fails because the
measurement is right *and the world is wrong*. The Quay's ground in this build
stands 35 m over its own harbour on a terrarium reading that `terrain.py` records
as ~12 m high in the CBD, and `bareearth.roof_cap` caps the Quay's correction at
**0.45 m** on purpose (§3b) because the unbounded 15.6 m would take every wharf,
viaduct and hero landmark with it. So a real viaduct measures 6.74 m under a
ground that is itself wrong, `rail-audit` says so by name in section 4a, and the
red is the check doing the job §5 asks of it. Editing the expectation would put
the silence back. The fix is the terrain at the Quay, or `raw_heights` — not the
audit.

**What this does not change, stated so nobody looks for it.** A viaduct is still
`terrain.sample(...) + BRIDGE_RISE` — an offset from the ground beneath it, not a
structure standing on its own piers — so every metre a conform pass takes off the
ground, the deck gives up too, and only what the 3.3% grade cone pulls back from
approaches that did not move survives. That is why Chatswood reads +2.26 and not
+5, and why Circular Quay's deck follows its ground up. §3b's last line stands:
**the last three metres are `raw_heights`'s.** The fix is a bridge deck solved
from its abutments, and it is the next thing after this one.

**And the cost.** A conformed 20 km solve is ~6 minutes and a 60 km one the
better part of three hours, against 5.7 seconds for the raw drape — which was the
only argument the old line had. It is paid through `terraincache`, keyed on the
DEM, the extract and the source of every module that shapes the lattice, so a
`rail-bake` beside a world build is a cache hit in seconds. `rail.py` is in that
key, so a rail-only edit still costs one fresh solve; `terraincache`'s header
already took that trade and this makes it slightly worse and still right.

#### 3d. Amendment, 2026-09-10: the ground at Circular Quay, measured and half fixed

§3c ended by naming Circular Quay's recorded conflict as real and forbidding
anyone to edit the expectation away: *"The fix is the terrain at the Quay, or
`raw_heights` — not the audit."* This is the terrain half. It is
`pipeline/sydney/shoreline.py`, gated by `pipeline/sydney/shoreline-check.py`,
and it is honest about being a **partial** fix: it removes 5.63 m of a 29.56 m
error and the reason the other 23.9 m stays is a finding of its own, in the last
block of this section.

**The ground at the Quay, what it should be, and every term of the difference.**
Measured on the 5.3 km ring along a transect down the middle of Sydney Cove at
east 140, at north 820 — the promenade, 32 m behind the waterline, **~2.5 m AHD
in life**:

| term | ground (m AHD) | what it added |
|---|---|---|
| the raw 15.87 m terrarium pixel | **12.50** | **+10.0** |
| the 60 m Gaussian | 17.81 | +5.3 |
| `bareearth`, capped at `roof_cap` = 0.45 m | 17.37 | −0.45 |
| `roadgrade.solve` + `conform` | 28.50 | **+11.1** |
| `water.conform` | 28.50 | **0.00** |
| `pads.station_pads` rule 1 (Circular Quay) | **32.06** | +3.6 |

So, to the four candidates the brief put:

- **(a) the tile itself is wrong, by about ten metres, and it is the largest
  DSM term.** At 15.87 m a pixel there is no promenade in this raster: the raw
  pixels over the Quay's own block read 9–15 m and the ones over the Opera
  House side read 23–26. The Cahill's deck, the ferry terminal roofs, the wharf
  sheds and the AMP building *are* the ground here. No kernel removes that.
- **(b) the Gaussian adds five metres, not fifteen.** 12.50 raw against 17.81
  smoothed is what the CBD's towers are worth at the Quay through a 60 m
  kernel — the smaller half of the DSM's error, not the larger. `terrain.py`'s
  note is right that the contaminated patch is 1.5 km wide; what it did not say
  is that the patch *reaches the water*.
- **(c) the water conform does not pull the promenade down, and cannot.** Its
  `hold` is `np.maximum(out, hold)` with `hold` at sea level, so on a post
  already 28 m up it is a no-op. Measured: **0.00 m** on this transect, including
  at north 840 which is 12.8 m from the waterline and well inside
  `water.FEATHER_OUT_M`. That is not a bug — a one-sided hold is the right shape
  for *"no dry ground under the sea"*. It is the wrong shape for the opposite
  failure, and nothing in the pipeline was looking at the opposite failure.
- **(d) `roof_cap` is right to refuse.** §3b caps the Quay's deconvolution at
  0.45 m because every polygon over those decks is `building=train_station`
  awning, and the unbounded 15.6 m would take the wharves, the viaduct and the
  heroes with it. Correct *for a station rule*. It is the wrong bound for a
  shore, because what is wrong at the Quay is not the roof over the platforms.

**And a fifth term the question did not list, which is the largest of all:**
`roadgrade.solve` adds **eleven metres**. The streets are solved under a grade
clamp from ground that reads 40–55 m across the CBD, so the profile cannot fall
to the harbour in the three hundred metres it has, `roadgrade.conform` pulls the
lattice onto it, and rule 1 then reads those streets and adds 3.6 m more. **The
CBD's contamination is delivered to the foreshore by the road solve.**

**The rule.** In `shoreline.py`, run **second** — after `bareearth` and still
before `roadgrade.solve`, for the ordering reason §3b already argued and this
term makes twice as sharp:

> **A shore may not stand higher over the water than a shore stands, and it may
> not be pulled down by more than there is building on it.** Within
> `SHORE_REACH_M` of mapped **tidal** water the lattice is pulled toward
> `SURFACE_AHD + PROMENADE_AHD` by a weight that is one at the waterline and
> zero at the reach; the result is floored at the smoothed DSM with the built
> mass deconvolved out of it. Never upward. Never past that floor.
>
>     d   = metres to the nearest mapped tidal waterline, zero inside it
>     u   = clip(d / SHORE_REACH_M, 0, 1);  w = 1 - (3u^2 - 2u^3)
>     new = min(natural, max(natural + w*((sea + PROMENADE_AHD) - natural),
>                            natural - built_drop))

`SHORE_REACH_M` is 250 m and `PROMENADE_AHD` is 3.0 m AHD — the Quay promenade
in life, and clear of both numbers `water.py` owns (`SHORE_CLEARANCE_M` 0.4,
`TIDAL_MARGIN_M` 2.0).

**Both halves are load-bearing and each one's failure is the other's bound.**
The pull alone flattens real rock: Mrs Macquaries Point reads 4.58 m AHD *at the
waterline* and a pull to 3.0 takes 1.6 m of sandstone off it. The floor alone is
§3b's estimator unbounded — right and unusable. Together the discriminator is
not a classification and not a footprint mask but a per-post, continuous
measurement of **how much building the DSM is looking at**, which is rule 1 of
this document read for the ground instead of for the railway. (A footprint mask
was the shape the brief offered and it is refused for `bareearth.py`'s reason —
half a building corrected is a step through a wall — and because it gets the
Quay promenade itself backwards: no footprint stands on it and it is thirty
metres wrong, because the mass belongs to the block behind.)

There is **no reach feather** and none is needed: at `d = SHORE_REACH_M` the
weight is zero, the pull term is `natural`, and the `max` against
`natural − built_drop` returns `natural`. The pass stops writing by
construction. `pads.py`'s one cell would have been a 27% ramp here.

**The gate, on the 5.3 km ring.** Four lattices, not two: a pass-only pair with
every later pass off — whose diff *is* the write, and is asserted — and the
shipped pair, whose diff is measured.

| | |
|---|---|
| the pass's own write | **21,633 of 148,225 posts** (14.59%), p50 0.304 / p95 4.309 / max 18.730 m |
| bounded by the built mass / by the pull | 19,084 / 2,785 |
| **every one inside the band + one cell** (250 + 31.25 m) | **PASS**, and **not one post was raised** |
| the shipped diff, all of it | 32,711 posts, p50 0.061 / p95 3.151 / max 12.012 m |
| — inside the band + one cell | 18,143, p50 0.474 / p95 3.863 / max 12.012 |
| — the road solve's shadow, outside it | 14,568, p50 0.000 / p95 0.966 / max 6.979; 718 over a metre, none of *those* past 684 m |
| extra grade in the band | 8,557 cells steeper, p50 0.12% / p95 1.86% / max 14.94%, in a band already at p95 19.98% |

**The Quay transect, before and after** (m AHD; the shipped chain both sides):

| N | d(water) | off | on | in life |
|---|---|---|---|---|
| 900 | wet | −1.46 | −1.46 | the bed `water.conform` cut |
| 860 | 5 m | 14.80 | **12.16** | ~2.5, the promenade |
| 820 | 32 m | 32.06 | **26.42** | ~2.5, behind the seawall |
| 780 | 72 m | 33.96 | **28.27** | ~4, Alfred Street |
| 700 | 152 m | 41.32 | **35.61** | ~6 |
| 680 | 172 m | 43.14 | **37.44** | ~6, under the Cahill deck (the deck ~20) |

Every station is closer and none is close. Away from the CBD the rule lands in
full — the pass's own write, before the roads: Kirribilli −2.40, Dawes Point
−2.26, Balmain East −0.23, **Mrs Macquaries Point 0.00 at the waterline and 0.00
ten metres in, Centennial Park 0.00.** The floor declines unbuilt ground
outright, which is the whole safety argument and it is asserted every run.

**The heroes.** `landmark-audit`'s blocks, built on both lattices:

| hero | what moved | why |
|---|---|---|
| **Opera House** | **identical to the millimetre** | its podium is `sea + OPERA_PODIUM_TOP_AHD` — a stated 16.0 m AHD platform, and nothing in its audit reads the ground. What does move is outside the audit: the podium prism's buried base, `min(sample over the plan)` 0.87 → 0.15 m AHD, and the ceremonial stair riser 0.642 → 0.675 m over 22 treads. Neither is visible. |
| **Harbour Bridge** | `ramp_south_m` 265 → 275; `ramp_north_clearance_m` **8.329 → 9.935**; `deck_s_min` −839.5 → −849.5 | the deck is stated at 49.0 m AHD and does not move. The **abutments** stand on ground that did: arch pin S 10.00 → 6.27, arch pin N 5.88 → 3.74, ramp foot S 34.29 → 33.40, ramp foot N 35.60 → 33.99 m AHD. So the southern ramp runs 10 m further before it meets grade in The Rocks, and the northern granite abutment closing the gap is 1.61 m taller — exactly the ground it stands on. The arch pins are unaffected in *height*: `build_bridge` founds them at `min(ground, sea + BRIDGE_BEARING_AHD − 6)` and their tops are stated. |
| **Luna Park** | `base_y` −56.738 → −60.482 (**14.34 → 10.59 m AHD**) | a `ground_founded` landmark on reclaimed foreshore, entirely inside the band. Its forecourt is ~3 m AHD in life, so this is 3.74 m of the error going the right way. |
| **Sydney Tower** | `base_y` −0.541 | **the road solve's shadow only.** Its pad is Westfield's block, ~600 m from mapped water and outside the band; no post under it was written by this pass. |

**What Circular Quay's clearance becomes, from the transect.** The station node
is E 86.6 N 818.4 and its ground goes **37.24 → 30.56 m AHD, −6.68 m**. §3c
records the shipped 20 km bake there at `groundY` −33.84 (37.23 AHD),
`clearance` −6.74, conflict recorded — the same ground to the centimetre, which
is the check that this is the same surface. `rail.raw_heights` gives a bridge
node `terrain.sample(...) + BRIDGE_RISE` and `BRIDGE_RISE` is 7.0 m, so the deck
follows the ground down and only what the 3.3% grade projection restores from
approaches that did not move survives; Chatswood measured that exchange rate at
**0.38**. So 6.68 m of ground is worth between **+2.54 and +6.68 m** of
clearance, and Circular Quay goes from −6.74 to somewhere in **−4.20 .. −0.06 m**.
**Neither end clears the deck.** The conflict §3c forbade editing away stays
recorded and stays right: the ground is still wrong, by less. `rail-audit` at
20 km was not run for this round and `shoreline-check.py --radius 20000` is
where the measured number is.

**And the finding that outranks the pass.** The pass writes **11.48 m** at the
promenade and the build keeps **5.63**. Median kept/written on dry land the pass
wrote more than a metre to: **0.41**. It is not a rounding loss. The mechanism is
`roadgrade._lipschitz`, whose own docstring is the argument against it —
*"cutting a spike down (low) and filling the valleys either side of it up (high)
are both legal answers and the truth is between them"* — so it returns the
average of a downward projection and an upward one. That is the right operator
for an error of unknown sign, and **this error has a sign**:
`roadgrade.OPENING_M`'s note says so two hundred lines earlier
(*"contamination is always upward"*), and so does `bareearth.BUILT_COEFF`'s, and
so does `shoreline.py`'s own `np.minimum(natural, ...)`. When the shore comes
down eleven metres and the CBD three hundred metres away stays at fifty, the
`CROSS_GRADE` tie chain is violated, the low projection pulls the CBD down, the
high projection pulls the shore back up, and the average splits an error that is
entirely the CBD's evenly between the two. Measured: the solved street nearest
east 140 north 820 goes 31.31 → 25.63 m AHD — a 5.68 m fall for an 11.5 m
correction — and it ends up standing 20 m above its own ground.

So the shore rule is **necessary and not sufficient**, and the two things that
finish it are already named in other files' headers:

- **the city-wide deconvolution**, `terrain.py`'s standing follow-up and
  `bareearth.py`'s. `shoreline.SHORE_REACH_M`'s own table is what it is worth,
  swept on the 5.3 km ring with every pass on: at a 600 m reach the Quay
  promenade comes to 17.23 m AHD and Sydney Tower moves 2.7 m; at 900 m the Quay
  reaches 14.30 and **Town Hall drops 11.3 m**, which is roughly the error
  `terrain.py` records there — that row is not a shore rule, it is the CBD pass
  arriving under a shore rule's name, and it deserves its own round and its own
  gate on the CBD's landmarks. 600 m is the row to take next, once that gate
  exists at 20 km.
- **a Lipschitz projection that knows its error has a sign** — one-sided where
  the observation is a surface model over a city, symmetric elsewhere. That is a
  change to every street in Sydney, it belongs to whoever owns `roadgrade.py`,
  and `road-grade-audit` is its gate. *(Built the same day — §3e. The Quay
  promenade goes 26.42 → 15.18 m AHD and kept/written 0.41 → 1.13.)*

**Two of §3b's numbers move, and neither is a regression.** `bare-earth-check.py`
now runs both of its columns on ground this pass has already touched, so Circular
Quay's zone reads `ground off -40.38 / on -40.51` where §3b recorded
`-33.68 / -33.83`. The *move* it measures is the same −0.13 m, which is the
number that check exists to assert; the absolute is 6.7 m lower because that is
this pass. `bare-earth-check.py` and `terrain-rules-check.py` were both re-run at
5.3 km against this branch and both still PASS, gate and all. `rail-audit` and
`landmark-audit` at 20 km were not run this round.

**One thing fixed in passing, because §3c's lesson had a third instance
waiting.** `cli.cmd_road_grade_audit`'s `--surface raw` called
`Terrain.load(radius, conform_roads=…, conform_water=…, conform_pads=…)` and
named three of what are now five flags, so its "before" column was the raw drape
*with the bare-earth pass still in it* — the identical trap §3c found in
`rail.build_all`. Every flag is now named there.

#### 3e. Amendment, 2026-09-10: the projection learns that the error has a sign

§3d ended by naming two things that would finish the Quay and handing one of
them on: *"a Lipschitz projection that knows its error has a sign — one-sided
where the observation is a surface model over a city, symmetric elsewhere. That
is a change to every street in Sydney, it belongs to whoever owns
`roadgrade.py`, and `road-grade-audit` is its gate."* This is that, in
`pipeline/sydney/roadgrade.py`'s `--- The sign of the error ---` block, gated by
`pipeline/sydney/roadgrade-sign-check.py`.

**The defect, in one paragraph, because §3d already measured it.** `_lipschitz`
returned the average of a downward projection and an upward one, and its own
docstring said why: *"cutting a spike down and filling the valleys either side of
it up are both legal answers and the truth is between them."* True of an error of
unknown sign. This error has a sign — `roadgrade.OPENING_M`'s note says
*contamination is always upward*, `bareearth.BUILT_COEFF`'s says it, and
`shoreline.py`'s own `np.minimum(natural, ...)` says it. So when the shore came
down eleven metres and the CBD three hundred metres away stayed at fifty, the
average split an error that was **entirely the CBD's** evenly between them:
kept/written **0.41**.

**The fix is not a global switch to the downward projection**, and that is the
whole design. `low` alone is `roadgrade.TIE_RADIUS_M`'s table read at a cap of
zero — it shaves every real crest, because a Sydney ridge tied to a street in the
valley is a violation too and cutting the ridge is one of the two legal answers.
The average is *right* on a sandstone headland. So the operator is one-sided
**per post**:

>     lambda = 0.5 + 0.5 * confidence            confidence in [0, 1]
>     h      = relax_down( lambda * low + (1 - lambda) * high )

**The final downward relax is what does the work and it is the trick.** A mixture
taken node by node is not feasible — a node that took `low` beside one that took
`high` can be further apart than the budget allows — so it is projected once
more, downward, onto the constraint set. That projection can only lower, so a
post whose height is already known **pulls its neighbours down along the grade
limit instead of being pulled up to meet them**, which is the sentence the whole
change exists to make true. It also means the confidence only has to be right at
the post that knows something: the contaminated neighbour needs no opinion of its
own, feasibility brings it down.

Two properties fall out, and the check asserts both:

- `low <= new <= old`, node by node. The answer is sandwiched between the global
  switch the evidence declined to take and the average it replaces, so **nothing
  in Sydney is ever raised by this change** and the worst case is an operator
  whose behaviour `TIE_RADIUS_M`'s table already measured.
- with no confidence anywhere the result is the old average **bit for bit**, by
  an early return rather than by an argument about floating point. That is what
  `Terrain.load(one_sided=False)` is, and it is a named flag in `terraincache`'s
  key for §3c's reason: a knob that is not an argument gets turned with a
  monkeypatch behind a cache that cannot see it.

**What counts as evidence.** Not a label and not an extent — the measurements the
passes above already made, per post, continuous, which is rule 1 of this document
read for the ground:

| signal | what it is | where it comes from |
|---|---|---|
| **metres already taken off** | a post the shore rule pulled down 11 m is a post whose height came from a *rule*, not from a surface model | `Terrain.load` snapshots the lattice before `bareearth` and diffs it after `shoreline`, so it is every early pass's write at once and a sixth pass joins it for free |
| **the deconvolution's `built_drop`** | *how much building the DSM is looking at here*, metres | `shoreline.conform` reports the raster it already computed for its own floor; nobody computes it twice |
| **water adjacency** | **not a term.** North Head, the Gap and Dover Heights are eighty-metre cliffs at a mapped tidal waterline — `shoreline.py`'s built-mass floor exists because of them. The shore weight enters as a *shape* on the built term, which is also what keeps this operator from putting a step at 250 m that `shoreline.py` went to trouble not to | — |

`SIGN_CORRECTED_M` is 1.5 m and `SIGN_BUILT_M` is 12.0 m, and **the sweep's first
finding is that neither is a tuning knob**: the Quay column does not move across a
factor of eight and neither does Town Hall. What decides the answer is that a post
has *some* confidence, not how fast it saturates. The table is in the module.

**The gate, on the 5.3 km ring.** Eight lattices — the shore pass off and on,
crossed with symmetric and one-sided, plus a pair with the water and the pads off,
which is the pair the no-rise assertion is made on. It is made there and not on
the shipped pair deliberately: `water.conform`'s hold is an `np.maximum` and a
pond's own surface is `BODY_QUANTILE` of the terrain inside it, so neither of
those two passes is monotone and asserting on the shipped lattice would be
asserting that they are.

| | |
|---|---|
| the road pass alone | **18,889 of 148,225 posts came down, 0 went up**, largest rise 0.000000 m |
| the shipped lattice | 17,847 down, **16 up, max 0.237 m** — every one a pond level or a stated pad reacting to lower ground, all with the road pass's own move at exactly 0.000000 |
| the solved profile | 137,780 nodes both ways; grade p95 7.97% → 8.63%, max **15.000% → 15.000%**, `MAX_GRADE` over-count **0 → 0** |
| evidence reached | 29,241 nodes, 14,877 at confidence 0.5 or better; 17,004 nodes lowered, p95 0.601, max 6.069 m |
| the whole lattice diff | p50 0.129 / p95 8.608 / max 19.977 m |
| **past 1 km from mapped tidal water** | **61 posts moved at all, the deepest by 0.054 m** |
| 200 random graphs | every edge inside its budget, `low <= new <= sym` everywhere, zero confidence bit-identical |

**The Quay transect** (m AHD, the shipped chain both sides; §3d's "on" column is
this table's "symmetric"):

| N | d(water) | symmetric | one-sided | in life |
|---|---|---|---|---|
| 900 | wet | −1.46 | −1.46 | the bed `water.conform` cut |
| 860 | 5 m | 12.16 | **7.09** | ~2.5, the promenade |
| 820 | 32 m | 26.42 | **15.18** | ~2.5, behind the seawall |
| 780 | 72 m | 28.27 | **16.65** | ~4, Alfred Street |
| 700 | 152 m | 35.61 | **23.96** | ~6 |
| 680 | 172 m | 37.44 | **25.74** | ~6, under the Cahill deck |

Every station is closer and none is close; the residue is the DSM's own ten
metres and the CBD pass that has not been written. **Median kept / written, on
the same population `shoreline-check.py` section 3 measures: 0.41 → 1.13.** Past
1.00 that ratio has stopped meaning "how much survives" and started meaning "what
a corrected shore is worth", because the correction now propagates inland along
the grade limit instead of stopping at the band — which is the intended
behaviour, stated here so nobody reads 1.13 as a bug.

**The escarpment, which is what a per-post operator buys over a global switch.**
`TIE_RADIUS_M`'s table watches Kings Cross over Woolloomooloo and records that at
a 6% cap *"the escarpment is gone — the top has come down 8 m and the valley has
come UP 5"*. Here the two heights do move — a tie chain is transitive and the
Woolloomooloo foreshore two hundred metres north was corrected — but the landform
does not:

| | symmetric | one-sided |
|---|---|---|
| Kings Cross, the top of the ridge | 46.91 | 45.16 |
| Woolloomooloo, the valley floor | 6.77 | 5.10 |
| **the relief between them** | **40.14 m** | **40.07 m** (−0.07) |

And five inland controls — Surry Hills at 948 m from water, Centennial Park at
971 (`bareearth.py`'s own negative control), Randwick, Alexandria, Sydney Park at
3.2 km — come out at **+0.0000 every one**. Town Hall, which is 666 m from water
and the one place in the extent where the truth is written down, moves **−1.14 m**
against the ~11 m error `terrain.py` records there: this is not the city-wide
deconvolution arriving under another name, which is the thing
`shoreline.SHORE_REACH_M`'s note asks anyone changing this to check.

**The heroes.**

| hero | what moved | why |
|---|---|---|
| **Opera House** | **identical to the millimetre**, and so is its podium's founding ground (min over the plan 0.15 m AHD) and its stair riser (0.675 m over 22 treads) | the podium is a stated 16.0 m AHD platform and the ground under its plan was already at the water |
| **Harbour Bridge** | `ramp_south_m` 275 → 290; `ramp_north_m` 85 → 80; `ramp_north_clearance_m` **9.935 → 10.698**; `deck_s_min` −849.5 → −864.5 | the deck is stated at 49.0 m AHD and does not move. The abutments stand on ground that did: ramp foot S 33.79 → 32.22, ramp foot N 33.99 → 33.06, arch pins 6.27 → 6.26 and 3.74 → 3.50 m AHD. The southern ramp runs 15 m further before it meets grade in The Rocks |
| **Luna Park** | `base_y` −60.482 → −61.450 (10.59 → **9.62 m AHD**) | reclaimed foreshore inside the band; ~3 m AHD in life, so another metre the right way |
| **Sydney Tower** | `base_y` −2.459 → −4.284 (**−1.83 m**) | the CBD coming down through the tie chain, not a post this operator wrote — its pad is Westfield's block, 585 m from mapped water. ~30 m AHD in life against a build that reads 40, so the direction is right and the magnitude is small, but **it is a hero moving and `landmark-audit` at 20 km has not been run for it** |

**Grade.** `MAX_GRADE` is a guarantee about the *solved profile* and it is read
back off the output: 15.000% both ways, zero edges over. On the lattice, in the
shore band p95 19.17% → 18.96% and max 121.45% → 118.47%; city-wide p95 12.67% →
12.68% and max the same 121.45 → 118.47. 9,304 cells got steeper, p95 2.92%.
`road-grade-audit`'s centreline half, run through that command's own functions
against the scoped solve, gets **better** on every line:

| | symmetric | one-sided |
|---|---|---|
| carriageways over 15% of grade | 18 of 126,285 | **13** |
| over 15% of bank | 36 | **24** |
| worst grade / bank | 29.72% / 30.31% | **23.96% / 25.01%** |
| the verdict share (limit 0.100%) | 0.026% | **0.017%** |
| tidal-shore stations over 15% (excluded from the verdict) | 274 grade, 688 bank | **254, 678** |
| solve vs ground, p50 / p95 / worst | 0.14 / 0.62 / 11.94 m | 0.15 / 0.64 / **10.30** |

The emitted-facet half of that command reads `road_asphalt` out of shipped GLBs
and a scoped solve emits none; it is `road-grade-audit --surface tiles` after a
retile and it was not run.

**What Circular Quay's station ground becomes.** The node is E 86.6 N 818.4 and
its ground goes **30.56 → 20.36 m AHD, −10.20 m** from what ships today — and
37.24 → 20.36, **−16.88 m**, from where §3d's round found it. §3c records the
shipped 20 km bake there at `groundY` 37.23 AHD with `clearance` −6.74 and the
conflict recorded. `rail.raw_heights` gives a bridge node
`terrain.sample(...) + BRIDGE_RISE` at 7.0 m, so the deck follows the ground down
and only what the 3.3% grade projection restores from approaches that did not
move survives; Chatswood measured that exchange rate at 0.38. So 16.88 m of
ground is worth between **+6.41 and +16.88 m** of clearance, and Circular Quay
goes from −6.74 to somewhere in **−0.33 .. +10.14 m**. **The bottom of that band
is at the deck and the top of it clears by ten metres** — which is the first time
since §3a that either end has. It is still a band and not a number: the measured
one is `roadgrade-sign-check.py --radius 20000`, and this round did not run it.
The conflict §3c forbade editing away therefore stays recorded until a 20 km bake
says otherwise.

**What this does not fix, and what it costs.**

- **The middle of the CBD.** Town Hall is −1.14 m against ~11 m of error. This
  operator has no correction of its own to make: it decides how much of somebody
  else's survives, and in the middle of the CBD nobody has made one yet. The
  city-wide deconvolution is still `terrain.py`'s standing follow-up and
  `shoreline.SHORE_REACH_M`'s 600 m row is still the one to take next.
- **Two heroes move on evidence gathered at 5.3 km.** Luna Park and Sydney Tower
  both come down and both come down toward the truth, and `landmark-audit` and
  `rail-audit` at 20 km were not run this round. Neither was a retile.
- **Every terrain cache entry is invalidated.** `roadgrade.py` is in
  `terraincache._CODE_FILES`, so the next build re-solves the lattice — the price
  that file's header already states for an edit here.
- **`bare-earth-check.py`, `terrain-rules-check.py` and `shoreline-check.py` were
  all re-run at 5.3 km against this branch and all three still PASS**, gate and
  all, the way §3d re-ran the first two.

#### 3f. Amendment, 2026-09-12: the projection learns how much the error is worth

§3e taught the projection that the DSM's error has a sign. **It did not teach it a
size, and the 60 km world it shipped is the bill.** `relax_down` is a fixpoint of
`h_i <- min(h_i, h_j + limit)` and nothing in it remembers where a violation came
from: a post the shore rule pulled down eleven metres is believed, every post tied
to it is pulled to the grade limit, every post tied to *those* likewise, out to
`MAX_SWEEPS` — four kilometres of road — and no term anywhere asks how much
evidence is being spent. §3e's own sentence, *a post whose height is already known
pulls its neighbours down along the grade limit*, was missing its second half: **by
how much.**

Round three against round two: 11,095 terrain tiles differ, nothing is raised,
and the deepest drops are not the harbour.

| place | tile | round two | round three | deepest post |
|---|---|---|---|---|
| **Coledale / Scarborough**, the Illawarra escarpment | `-48_-95` | 58.85 | **42.77** | **−27.13 m** |
| Manly | `15_31` | 66.74 | **50.90** | −18.97 |
| Kirribilli | `-1_6` | 69.45 | **62.02** | −14.25 |
| Brooklyn, on the Hawkesbury | `10_71` | 69.46 | **62.98** | −10.47 |
| Cronulla | `-10_-42` | 17.40 | 15.85 | −3.46 |
| Penrith, on the Nepean | `-98_27` | 23.28 | 22.60 | −2.26 |
| *the Quay, which is the intended result* | — | 29.91 | **18.14** | −17.61 |

The Illawarra is the proof that this is a defect and not a strong opinion.
Coledale is a village on an escarpment above the sea with **no towers in it**, so
`bareearth.py`'s own estimator says the DSM there is reading real ground — and the
projection took sixteen metres off the median post of its tile anyway, on the
strength of a correction made at a waterline a hundred metres below. What
separates that from the CBD's twenty metres is not distance from water. It is
whether anybody measured anything that would pay for the drop.

**Two of the report's six do not reproduce, and it is recorded rather than
dropped.** Penrith's deepest post moved 2.26 m between these rounds and Cronulla's
3.46 m, against the 8.7 and 6.8 the regression report quoted; the solved lattice
and the shipped `.terr.bin` agree on the smaller numbers, so those two were
measured against something else. They stay named in the check.

**The fix is the term that was missing, and it is a size.**

>     budget_i = BOUND_TOL_M + max( built_i , max_j ( metres_j − BOUND_DECAY·d_ij ) )
>     floor_i  = sym_i − budget_i
>     out      = relax_down( max( mixture , relax_up( min(floor, h) ) ) )

In words, which is the brief read back: *a trusted post may pull a neighbour down
by no more than the evidence it carries — its own correction, decaying along the
run, or the neighbour's own built mass — and never past that below the answer the
symmetric projection would have given.*

**The floor is relative to `sym`, and that is the one design decision here.** An
absolute floor — *never below this post's bare-earth estimate* — is the tempting
form and it is wrong, because a road is allowed to cut into a hill: the grade
clamp takes a crest down by whatever 15% costs it and that is a cutting, not an
error. `sym` is what this module said before it learned about signs, so a floor at
`sym − budget` binds on exactly the thing the budget is about — how far the
one-sidedness took a node past where the even-handed operator would have left it
— and is inert everywhere else. On a steep street inland with no evidence within
reach the budget is `BOUND_TOL_M`, the answer is already `sym`, and the floor
never touches it. `min(floor, h)` is not a detail either: **a floor may stop a
node falling and may never lift one.**

**Every invariant §3e published survives, word for word.**

- `low <= out <= sym`, node by node. `floor <= sym − BOUND_TOL_M` and `sym` is
  feasible, so `relax_up(min(floor, h)) <= relax_up(sym) = sym`; the mixture is
  already `<= sym`; and a downward relax of something `<= sym` is `<= sym`. So
  **nothing in Sydney is ever raised by this change** still holds, and
  `roadgrade-sign-check.py`'s gate is untouched. The bound spends the
  one-sidedness back toward the average and can never spend past it.
- Every edge still obeys its budget: `relax_up(min(floor, h))` is feasible by
  construction, so the last downward relax is a projection of a feasible-bounded
  field.
- With no evidence anywhere it is the symmetric answer **bit for bit**, by the
  same early return. `Terrain.load(one_sided=False)` is unchanged.

**What counts as evidence is what §3e already measured, kept in metres.**
`GroundEvidence` normalised both signals into a confidence in [0, 1] and threw the
size away; it now keeps them. `m` is metres an earlier pass took off this post, or
the built mass standing on it, shore-weighted exactly as the confidence is — what
a chain spends as it travels. `b` is the deconvolution's built mass **unweighted**
— this post's own answer to how far below the DSM the ground could be, owing
nothing to any chain. Nothing new is computed for either; they are the arguments
`Terrain.load` and `shoreline.conform` were already handing this object.

**The two constants are knobs, and saying so is the point.** §3e's sweep found its
constants were not — the Quay did not move across a factor of eight — because that
operator's work is done by a relax that either binds or does not. This one is
different and the sweep says so in its first two rows. Every row is a full 5.3 km
solve, one-sided, shore on; `off` is `BOUND_TOL_M` at a billion, which is this
operator switched off, and it reproduces §3e's published column exactly.

| decay | tol | N820 | Quay stn | Kirribilli | Town Hall | ridge | 'Loo | bound |
|---|---|---|---|---|---|---|---|---|
| 0.05 | off | 15.18 | 20.36 | 65.18 | 68.48 | 45.16 | 5.10 | 0 |
| **0.05** | **2.0** | **15.36** | **20.63** | **74.29** | 69.62 | 46.72 | 5.13 | 401 |
| 0.05 | 1.0 | 15.95 | 21.02 | 74.66 | 69.62 | 46.87 | 5.18 | 1,087 |
| 0.05 | 4.0 | 15.18 | 20.36 | 72.29 | 69.61 | 46.33 | 5.10 | 20 |
| 0.02 | 2.0 | 15.18 | 20.36 | 69.21 | 69.12 | 45.81 | 5.10 | 0 |
| 0.10 | 2.0 | **22.64** | **26.10** | 74.29 | 69.62 | 46.72 | 5.14 | 690 |

*(the symmetric answer is 26.42 / 30.56 / 74.47 / 69.62 / 46.91 / 6.77.)*

`BOUND_DECAY` is **0.05 m of budget per metre of run**, and the rows either side
are the two ways to be wrong. At **0.10** the budget dies in half the distance and
the Quay goes back to 22.64 — the bound has started eating the correction it
exists to protect, because the CBD ground that depends on the shore's evidence is
further from it than the evidence now travels. At **0.02** the budget reaches
575 m, further than anything in this pipeline has measured anything, and
Kirribilli only comes back to 69.21 of the 74.47 it should. The answer is fixed by
a distance that is already a constant here: an 11.5 m correction — the shore
pass's write at the Quay — carries **230 m at 0.05**, which is
`shoreline.SHORE_REACH_M`. **Evidence reaches exactly as far past the band as the
band is wide.** It is also `roadgrade.OPENING_M`'s note on how wide DSM
contamination actually is, *"150–250 m across"*, read as a distance instead of as
a filter length.

`BOUND_TOL_M` is **2.0 m**: what a node may lose with no evidence at all, which is
this module's own noise floor — `solve`'s `drop_p95` on the 60 km world is 1.95 m
and `conform`'s `moved_p95` is the same order. The rows either side cost what a
tolerance costs: 4.0 leaves the Quay untouched to the centimetre and gives up two
metres of Kirribilli; 1.0 takes the last half-metre of Kirribilli and costs the
Quay 0.77 m. The middle row's cost at the Quay is **0.18 m on an eleven-metre
correction**.

**The Kings Cross escarpment gets safer, not more dangerous.** Its relief is
40.14 m symmetric, 40.06 unbounded and **41.59 bounded** — Woolloomooloo is inside
the shore band and keeps its evidence, while the ridge above it stops paying for a
correction nobody measured up there. A bound whose job is to stop the projection
flattening landform should move that number in that direction.

**The gate is a lattice diff at the world's own radius, and it could not have been
anything else.** §3e was proved on the 5.3 km ring because the Quay is in it and
the Quay is where the truth is written down. Coledale is fifty-three kilometres
south of Town Hall, Brooklyn forty north, Penrith forty-five west; the ring that
proved the sign contains none of them. Every number in §3e is true and the world
it shipped was still wrong. `roadgrade.TIE_RADIUS_M`'s block says why in as many
words — a tie chain is transitive and reaches the whole city — so an operator that
fires through one has no extent and no scoped ring can contain its consequences.

What is assertable instead is a **budget per place**, and the place is a 3 km
cell, six tiles on a side:

> no cell further than 3 km from Circular Quay may drop more than **8 m** against
> round two.

The exemption is stated rather than buried: the CBD's twenty metres and the Quay's
ten **are** the intended result, they are what §3d and §3e were for, and an
assertion that convicted them would be an assertion against the last two rounds.
Everything outside that band is ground nobody has claimed a correction for.
`pipeline/sydney/roadgrade-bound-check.py` is the file, and **it convicts round
three on eleven cells before it clears this one** — which is the shape a gate
should have and the thing §3e's gate could not do.

**The 60 km solve.** One, 28.0 minutes, peak RSS 4.38 GB, written into the shared
`data/cache/terrain-solve` under the key the committed sources produce:

> `342878b6b6449c58621c3e195271d01b2538679052de6093ed905d1d2b0fb9b3`

The solved profile is unchanged where it should be — 196,714 ways, 2,966,785
nodes, grade p50 1.39% / p95 6.59% / **max 15.000%, 0 edges over `MAX_GRADE`**,
`drop_p95` 1.94 m. The floor bound **6,607 nodes** directly, by up to 31.25 m,
and the one-sidedness still lowered **57,183** nodes against round three's 57,242
— the bound spends a little of the operator back, not the operator.

**The places, m AHD, median over the tile.**

| place | tile | round two | round three | **now** | round 3 vs 2 | now vs 2 |
|---|---|---|---|---|---|---|
| Coledale | `-48_-95` | 58.85 | 42.77 | **57.18** | −16.08 | **−1.67** |
| Coledale | `-48_-94` | 91.76 | 84.53 | **91.61** | −7.23 | **−0.15** |
| Coledale | `-49_-95` | 139.31 | 138.00 | **139.31** | −1.31 | **−0.00** |
| Manly | `15_31` | 66.74 | 50.90 | **63.94** | −15.84 | **−2.80** |
| Manly | `15_32` | 27.37 | 21.16 | **25.10** | −6.21 | **−2.27** |
| Kirribilli | `-1_6` | 69.45 | 62.02 | **68.08** | −7.43 | **−1.37** |
| Brooklyn | `10_71` | 69.46 | 62.98 | **68.60** | −6.48 | **−0.86** |
| Cronulla | `-10_-42` | 17.40 | 15.85 | 15.85 | −1.55 | −1.55 |
| Penrith | `-98_27` | 23.28 | 22.60 | 22.60 | −0.68 | −0.68 |
| **the Quay** | — | 29.91 | **18.14** | **18.14** | −11.77 | **−11.77** |

The Quay is unchanged to the centimetre and Coledale is back inside two metres of
where round two had it. Cronulla and Penrith do not move because nothing moved
them: the bound only gives back what the one-sidedness took, and at those two it
took nothing.

**The cells, 3 km on a side, deepest drop against round two.**

| cell | km from the Quay | round three | **now** | posts past 5 m |
|---|---|---|---|---|
| E −22.5 N −46.5 (Coledale) | 52.5 | −27.13 | **−6.23** | 366 → **94** |
| E −25.5 N −46.5 | 53.8 | −25.39 | **−3.26** | 92 → **0** |
| E +7.5 N +16.5 (Manly) | 17.3 | −19.03 | **−8.42** | 495 → **163** |
| E −1.5 N +4.5 (Kirribilli) | 4.0 | −14.25 | **−5.60** | 234 → **8** |
| E +4.5 N +34.5 (Brooklyn) | 34.0 | −10.47 | **−6.56** | 202 → **19** |
| E +7.5 N +25.5 | 25.8 | −9.04 | **−4.62** | 198 → **0** |
| E +4.5 N +37.5 | 36.9 | −8.53 | **−1.00** | 6 → **0** |
| *E −1.5 N +1.5 (the CBD)* | *1.8* | *−21.65* | *−16.84* | *1,050 → 730* |

**Cells outside the harbour band past 8 m: eleven, then three.** The whole
lattice's deepest drop against round two goes **−27.13 → −17.04 m**, and the
deepest is now inside the CBD where it belongs.

**The three that are left are not this operator's**, and the check says so with
the measurement rather than with an excuse. They are E −19.5 N +4.5 and N +7.5 on
the Parramatta River at 8.68 and 8.40 m — **bit-identical to round three, moved
0.000 m by this round** — and Manly's cell at 8.42, down from 19.03. Sixteen posts
are responsible between them and every one is **11 to 152 m from tidal water**,
inside `shoreline.SHORE_REACH_M`'s own 250 m band. That is the shore pass's
write, floored at its own `natural − built_drop` and gated by its own passing
check; this file gates a projection whose defect was having no extent at all. So
the assertion is made per post on ground the shore rule did not write, the strict
count is printed beside it, and **nothing this projection reached is over the
budget**.

**The Quay's gain, which this round was not allowed to give back** (m AHD, round
three → now): N860 7.41 → 7.46, N820 15.24 → **15.43**, N780 16.49 → 16.88, N700
23.69 → 24.28, N680 24.88 → 25.47; Circular Quay's station ground **20.36 →
20.63**. The largest is 0.59 m, against a `QUAY_BUDGET_M` of 2.0 and a correction
of eleven and a half metres.

**The four 5.3 km gates were re-run against this branch and all four PASS** —
`roadgrade-sign-check.py` (which is §3e's own gate, arithmetic and all),
`shoreline-check.py`, `bare-earth-check.py`, `terrain-rules-check.py`. The sign
check's own headline numbers under the bound: median kept / written **1.10**
(symmetric 0.41), every transect station closer to what is there, not one post
raised by the road pass, `MAX_GRADE` still a guarantee, and
`road-grade-audit`'s centreline half still better than symmetric — 13 carriageways
over 15% of grade against 18, and 25 over 15% of bank against 36.


**What this does not fix, and what it costs.**

- **It does not correct anything.** Like §3e's operator it decides how much of
  somebody else's correction survives, and it now decides that more strictly.
  Outside `shoreline.SHORE_REACH_M` nobody has rasterised a built mass, so the
  budget out there is `BOUND_TOL_M` and nothing else — which makes every inland
  town centre in the extent a place where this pipeline now *knows* it cannot
  correct the ground, rather than one where it corrected it by accident through a
  tie chain from the harbour. That is the right failure, and it makes
  `terrain.py`'s standing city-wide deconvolution more urgent, not less.
- **Town Hall gives back its 1.14 m.** §3e recorded that move against ~11 m of
  known error and was explicit that it was not the deconvolution arriving under
  another name; it was a tie chain from the shore reaching 666 m inland with
  nothing to pay for the last stretch, and it reads 69.62 again — the symmetric
  answer. Nothing was lost that anybody had measured.
- **Sydney Tower stops moving, which §3e asked for.** That section flagged
  `base_y` −1.83 m on a pad 585 m from mapped water as *"a hero moving and
  `landmark-audit` at 20 km has not been run for it"*. It is **−0.26 m** now. Luna
  Park keeps its −0.97 (reclaimed foreshore, inside the band, evidence of its
  own), the Opera House is still identical to the millimetre, and the Harbour
  Bridge's `ramp_north_clearance_m` is still 9.935 → 10.698.
- **Every terrain cache entry is invalidated**, `roadgrade.py` being in
  `terraincache._CODE_FILES` — the price that file's header states for an edit
  here. The 60 km solve for this round is in the shared cache under the key named
  above, so the retile that follows hits it instead of paying for it again.
- **No retile, no bake, no 20 km anything.** `landmark-audit` and `rail-audit` at
  20 km were not run, and `roadgrade-sign-check.py --radius 20000` — which is what
  would turn Circular Quay's clearance band into a number — was not either.

### 4. Access is generated, never looked up

Every failure of reachability came from treating access as *content* — build it
where OSM maps a footbridge. Access is not content. It is a **function of the
clearance profile**, generated for every station by construction:

```
access(station) = steps(sign(clearance)) + footbridge(platforms ≥ 2 across track)
```

A station cannot lack access, because the same number that made it need access
generates it. Where OSM maps a real entrance or overbridge, use its position;
where it does not, put one at the nearest footpath. Registered for collision,
so it is walkable and not scenery.

### 5. The invariants, because every one of these failed silently

Each maps to a report above. None of them existed.

- **Reachability.** From the street outside every station, a walk exists to a
  doorway the boarding prompt accepts. Pathfound, not eyeballed.
- **Label agreement.** `vertical` matches the measured median clearance (§2).
- **Nothing buried.** No drawn non-tunnel track sits more than ~1 m below the
  *visible* surface without a trench around it. *(shipped, 5,577 → 1)*
- **Nothing walled.** No grounded prism inside the loading gauge. *(still
  failing at 345 cells — `elevated.py` has never heard of a railway)*
- **Every platform has a service.** A station you cannot catch a train from is
  a bug, with deliberate exceptions named. *(Roseville: 7 North Shore stations
  had platforms and no calls)*
- **Sanity.** Track never above its own catenary, never below its own tunnel
  floor, gradients inside the ruling grade.

### 6. What this deliberately does not fix, and why

**Lindfield.** The terrain grid is one post per 31.25 m and a cutting is 15–20 m
wide, so a cutting narrower than a post is *invisible to the data*. No rule can
recover it: the DEM says flat and OSM tags nothing. The mitigation is not
geometric but visual — a corridor with boundary fencing, a ballast shoulder and
a defined cess reads as a railway even when it is flat, which is exactly the
work already in flight. Accept the resolution limit, say so, and move on.

If it ever matters enough, the inference is available: a corridor whose
*adjacent road* heights sit consistently above the track is in a cutting the DEM
smoothed over. That is a real signal and a later round.

## How this is being applied

- The bake gains `clearance(s)` per corridor point and derives `vertical` from
  it (§1, §2), with the precedence rule replacing the current tag-first
  classifier (§3).
- `rail-geo` chooses trench / grade / viaduct off the profile rather than the
  label, which it half does already since the carve shipped.
- Access is generated for every station from the same profile (§4).
- The six invariants in §5 go into the suite, each with a negative control, so
  the next one of these fails loudly in CI instead of quietly in Chatswood.
