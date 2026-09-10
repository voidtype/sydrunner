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
