# Sydney Trains for SYDNEY — plan of record

Written 2026-08-09, **plan only — nothing here is implemented**. The 60 km
world build is in flight; this plan assumes it (trains want Penrith, and the
60 km extract is what all numbers below were measured against). Every number
marked *measured* was read from the actual OSM clip or the shipped codebase;
everything else is extrapolation and says so.

The user's instruction, verbatim: *"real sydney train routes … actually go
under and over ground where that actually happens, so you may need to find
individual layouts for every single station in sydney, and thats ok. trains
should look like REAL trains in sydney and also be something you can board to
traverse sydney. use deterministic time tables to avoid collision between
train routes. run fake routes frequently with an offset e.g. every min a train
can come to station for 15 sec … trains should go at like 120kmph real speed
with u inside them, in order to be the fastest transport."*

## 0. The one honest correction first: 120 km/h is not the fastest transport

A 3×-unlocked e-bike moves at **39.4 m/s = 142 km/h** (*measured*, it is the
number the streaming lead times are sized against). 120 km/h is 33.3 m/s — a
train at the user's number is *slower* than the fastest bike, which defeats
the stated goal. The plan therefore sets:

| | top speed | notes |
|---|---|---|
| e-bike, 3× unlock | 39.4 m/s (142 km/h) | today's ceiling, *measured* |
| **train, stopping pattern** | **36 m/s (130 km/h)** | between adjacent stations |
| **train, express segments** | **44.4 m/s (160 km/h)** | ≥ 2.5 km between stops |

160 on express is what makes the train genuinely the fastest way across
Sydney, and it is not a fantasy number — intercity V sets do 130 and the
corridor west of Strathfield is straight for kilometres. Dwells still cost
15 s each, so the bike stays competitive door-to-door on short hops, which is
the right game balance: trains win the long haul, bikes win the last mile.
Acceleration 1.0 m/s², braking 1.1 m/s² (both close to real EMU performance),
so a station stop costs ~80 s of cycle time at 44 m/s — the timetable maths
below uses these.

## 1. What the data already holds (measured, 60 km extract)

- **6,201 rail ways** (`railway=rail|subway|light_rail`), of which **477
  tunnel-tagged, 740 bridge-tagged, 92 cuttings, 29 embankments, 1,298 with
  layer≠0**. The under/over question is answered *by the data, per way* — no
  hand-modelling of vertical profiles.
- **223 station nodes**, **650 platform polygons**. Station names are real.
- Spot-proof of the "individual layouts per station" requirement: **Town
  Hall = 15/15 ways tunnelled; Circular Quay = elevated (4 bridge ways);
  Kingsgrove = at grade**. All three came out of the extract correctly.
- Route relations exist in the extract (1,927 `type=route` relations
  including bus/cycle noise). **Risk, flagged now:** GDAL's multilinestrings
  layer may not preserve `route=train` relation tags cleanly through the
  clip. Fallback if so: assemble each line from the way graph plus a
  hand-curated stopping-pattern table (nine lines × a list of station names —
  an afternoon of typing, and the timetable needs a stopping-pattern table
  anyway). The plan does not depend on relations surviving.

## 2. The service

Lines within the 60 km disc, from the real network:

| line | run (as modelled) | pattern |
|---|---|---|
| T1 | Emu Plains ↔ City ↔ Berowra | express west of Strathfield, north of Chatswood |
| T2 | Leppington ↔ City Circle | all stops |
| T3 | Liverpool ↔ City Circle via Bankstown | all stops |
| T4 | Waterfall ↔ Bondi Junction | express Hurstville–Sydenham |
| T5 | Richmond ↔ Leppington via Glenfield | all stops |
| T6 | Lidcombe ↔ Bankstown | shuttle |
| T7 | Olympic Park shuttle | shuttle |
| T8 | Macarthur ↔ City Circle via Airport | express Revesby–Wolli Creek |
| T9 | Hornsby ↔ City via Gordon | all stops |
| M1 | Tallawong ↔ Sydenham | metro, all stops, single-deck |

Blue Mountains/Central Coast intercity run to the disc edge and terminate at
the boundary station (Emu Plains, Berowra, Waterfall) rather than despawning
mid-track. Freight is out of scope (stretch: rare deterministic freighters on
the Southern Sydney Freight Line as scenery).

**Timetable, the "fake frequent" contract:** each line runs a fixed period of
**120 s per direction** (a train through any given station roughly every
minute across both directions, matching the user's "every min a train can
come"), **15 s dwell**, doors open the whole dwell. The service is a pure
function of `Date.now()` exactly as traffic is: `RAIL_EPOCH_MS`, integer
hashes, no trig in shared paths, one timetable shared bit-identically by
every client and the server. A train is `(line, direction, tripIndex)`; its
position at time t is a closed-form lookup into a baked distance-time curve —
`poseTrain(trip, t)`, pure, exactly like `poseCar`.

## 3. No collisions: solved at bake time, proven, not policed

Trains on the same track cannot be allowed to meet, and the lines share track
heavily (T2/T3/T8 into the City Circle; T1/T9 north of Strathfield). Because
the timetable is fixed-period and deterministic, this is not a runtime
problem — it is a **constraint-solving problem at build time**:

1. Cut the shared network into **block sections** (~400 m, junction-aligned).
2. Simulate every line's distance-time curve over the LCM of all periods
   (all periods are 120 s → the whole system repeats every 120 s, so the
   solve space is tiny).
3. Solve for each line's **phase offset** (0–119 s) such that no two trains
   occupy the same block within a safety margin (≥ 20 s separation on shared
   track, ≥ 8 s through junctions). Nine lines × 120 phases is brute-forceable
   in milliseconds; if no assignment exists on some trunk, lengthen that
   line's period to 180 s and re-solve (degrades "every minute" to "every 90 s"
   on the worst trunk — reported, not hidden).
4. Bake the solved phases into the rail sidecar. A pipeline audit
   (`rail-audit`) re-simulates the full cycle and **fails the build** on any
   violation; the integration check does the same from the client decoder as
   a second, independent reader — the bays/hex precedent: never trust one
   implementation of an invariant.

### 3a. What the block model missed, and what it cost — added 2026-09-07

Reported as *"the trains going through each other"*, with every check above
green. The invariant this section describes is about **a point on a rail key**;
what a player sees is **eight carriage bodies drawn in world space**, and four
things came between them. Three are now in the solve and one is measured and
named:

1. **A train is 163 m long and occupancy was a point.** `occupancy` mapped the
   arc-length range of the *pose*, the consist's centre, so eighty metres of
   train hung off each end of every claim the timetable made. Twenty seconds
   between two centres is six hundred metres at line speed and nothing at all
   at a platform. Fixed: the window now runs from the nose entering a block to
   the tail leaving it (`rail.consist_half`).
2. **The forty-five second stand at the origin was invisible.** `poseTrain`
   gives every trip `ORIGIN_STAND_S` at its first stop with the doors open —
   added so a terminus was boardable — and the solver's occupancy started at
   `t = 0`. A T8 stood on Central's platform while the T8 four departures ahead
   came back round the City Circle through the same rail. Fixed: occupancy of
   the first blocks starts at `-ORIGIN_STAND_S`.
3. **A flat crossing is not a shared block.** Two routes crossing at a node
   without sharing a block section have no rail key in common, so the solver
   had nothing to constrain. Fixed: `rail.foul_sites` walks the *drawn*
   polylines, finds every place two car bodies would foul, and hands the
   solver synthetic occupancy sites it reads exactly like rails. Nine such
   crossings exist in the 60 km disc.
4. **The `slot` is a claim about geometry the geometry does not keep.** Where
   OSM draws a double-track corridor as one centreline, `compute_lateral`
   pushes each direction 2 m off it — except within 110 m of a calling stop,
   where `world/rail-solids` builds the platform 1.62 m off the centreline *on
   both sides* and a train pushed sideways would be drawn inside the platform.
   **Not fixed, and both alternatives were measured and refused:** merging the
   two slots into one occupancy makes the solve fail outright with nine lines
   on six-minute headways, and carrying the offset through the platform trades
   this fault for the one the owner already reported about platforms. Moving
   the alignment is RAIL-CORRIDOR.md's **P5**.

**The price, stated.** Telling the solver how long a train is, and that it
stands at its origin, costs frequency, and the ladder reports it rather than
hiding it: T4, T7 and T8 fall from 120 s to 180 s, T5 and T9 from 180 s to
360 s. That is the honest cost of the claim actually being true; TRAINS.md
section 3's rule was always "degraded, reported, not hidden".

**Acceptance** is `server/train-conflict-check.ts` — the whole timetable swept
over one cycle at 10 Hz, every carriage body against every other — plus
`rail-audit` sections 5b and 5b'. Two trains claiming one rail: **8 pairs
before, 0 after**. Bodies inside each other on one alignment with one rail key:
**4 before, 0 after**. At a flat crossing: **4 before, 0 after**. The shared
alignment case above: **76 before, 60 after**, budgeted and ratcheting.

Same-line following is safe by construction (uniform period, uniform curve —
successive trips are time-translates that never converge).

## 4. Geometry: the network gets built where it really is

New pipeline stage `rail` (after roads, before parking), emitting per-tile
`rail.bin` sidecars plus station assets:

- **Track**: ballast ribbon + two rail extrusions along every `railway=rail`
  way, at grade-constrained heights (reuse the road-grade machinery — rail
  gradients are gentler than roads', ≤ 3.3%, and the audit asserts it).
- **Where `bridge=yes`**: viaduct deck + piers, exactly the `decks.py`
  pattern (prism base honoured, walk-under clearance — the collision system
  already supports all of this since the walk-under-bridges round).
- **Where `tunnel=yes`**: no world carving. The track drops below terrain and
  gets a **tunnel tube** — a low-poly lining rendered *only around the
  track*, plus a **portal** mesh at each tunnel/surface transition (the
  extract's tunnel-way endpoints are the portals; ~90 portals expected in the
  disc). The city above is untouched. From inside a moving train the tube +
  portal lighting transition is the whole experience; nobody walks the
  tunnels (out of scope, stated plainly — jumping out of a train in a tunnel
  relocates you to the nearest station, framed as "dragged out by staff").
- **Stations, surface (~195 of 223)**: platforms extruded from the 650 real
  platform polygons, canopy + station-name signage (real names, the street-
  sign system's pattern), fenced rail corridor near platforms.
- **Stations, underground (~28)**: the City Circle four, ESR four, Airport
  line four, Epping–Chatswood three, Metro city stations, plus odd cases the
  audit will surface. Phase A ships a **standard station box**: platform,
  side walls, stair/escalator shaft to a street-level entrance placed at the
  real OSM entrance node (`railway=subway_entrance` where mapped, station
  node otherwise). Individual architectural fidelity per station is explicitly
  Phase B polish; the *vertical truth* (which stations are underground, how
  deep, where the entrances are) is Phase A and comes from data.
- **Level crossings** (rare in the disc but real, e.g. out west): crossing
  deck + boom props; a train through a crossing applies the car-hit rule
  scaled up — `TRAIN_KNOCKBACK` ≈ 3× car, and the deterministic timetable
  means the server agrees about every hit.

**Vertical-profile audit**: for every station, derive
surface/elevated/underground from its ways and print the full table; the
famous ~30 (City Circle, ESR, Metro, Circular Quay, Olympic Park…) are
hand-asserted in the audit so a regression names the station.

## 5. The trains themselves

Procedural, not sourced — the car-model round proved licence-clear public
models are generic; there is no licence-clear Waratah, and the silhouette is
the recognisable thing anyway:

- **Suburban sets (T lines)**: 8-car double-deck, the Waratah silhouette —
  high shoulder, shallow V nose, roof curve, door pairs per deck level.
  Livery *evocative, not exact*: warm grey body, orange door band, no
  roundel, no fleet numbers (trade dress lives in exact liveries; the game
  satirises but does not counterfeit).
- **Metro sets (M1)**: 6-car single-deck, teal band, full-width gangways.
- **Interiors exist because you ride inside**: the double-deck section with
  its half-flight stairs, transverse seat blocks, poles, luggage racks —
  simple boxes and extrusions, one interior shell instanced per car type.
  Interior only renders for the train the player is aboard (plus doors-open
  glimpses at platforms).
- Rendering: one InstancedMesh per car type for exteriors (a full line at
  120 s headway across 60 km is ~45 trains × 8 cars ≈ 360 instances/line
  worst case; AOI means a client *sees* at most a handful). Every mesh in
  the boot warm-up with `instanceColor` present at first compile — the two
  renderer lessons this repo has already paid for twice.

## 6. Riding: boarding, netcode, camera

- **Board**: stand on the platform during the 15 s dwell, doors are open, E
  to board (the bike prompt pattern). Inside: free walk within the car,
  stairs between decks, seats sittable (cosmetic).
- **Netcode**: a rider is `(tripId, carIndex, localX, localY, localZ)` —
  protocol v10 adds one aboard-state. The train's world pose is a pure
  function of time, so the server never streams train positions; both ends
  compute them. Rider world position = trip pose ∘ local offset; AOI, melee,
  lag compensation all operate on world position and **rewind is exact**
  because the parent motion is closed-form. Cricket-bat fights in a moving
  carriage work with zero new netcode: the arena is just moving.
- **Disembark**: E at any dwell; jumping out at speed is allowed, ragdolls
  you with fall damage scaled by speed, then the unstuck rule applies if you
  land somewhere hopeless. In a tunnel: relocated to the next station.
- **Camera/HUD**: normal first/third person throughout; HUD line "T1 →
  Penrith · next: Blacktown" while aboard; the Majora clock keeps running.
- **Streaming at 44 m/s**: the streaming stack is proven at 39.4 m/s with
  56 s of hex lead; 44 m/s cuts that to 50 s — fine, but trains do better
  than fine: the route is known, so a rider gets **deterministic prefetch** —
  the streamer is handed "you will be at X in 60 s" and fetches along the
  line instead of radially. Express segments through tunnels are the *cheap*
  case (nothing to see but tube).

## 7. Server cost (extrapolated, to be measured at phase gates)

- Rail graph + timetable: well under 10 MB resident for the whole disc (it
  is centrelines + curves, not buildings); loads whole, no hex-laziness
  needed — but it rides the same `HexResidency` slots if measurement says
  otherwise.
- Train simulation: ~10 lines × 2 directions × ~45 trips ≈ **≤ 900 closed-
  form pose evaluations per tick worst case**, and only for trains near any
  player after the AOI cut — the traffic system already does far more.
- Riders: one parent reference per aboard player; cheaper than walking
  (no collision resolve while aboard).

## 8. Data cost (extrapolated)

`rail.bin` sidecars ≈ 15–30 MB across the disc; station boxes + platforms ≈
40–80 MB of geometry; train meshes ≈ 3–5 MB once. Total **under 120 MB on a
~20 GB world** — noise. All of it hex-sliced and R2-published like everything
else, `?v=` versioned, immutable.

## 9. Phases, each with its own gate

1. **Rail network in the world** — track, viaducts, portals, tunnel tubes,
   surface platforms, signage; `rail-audit` (continuity, gradients, vertical
   profile table, the hand-asserted 30). *Gate: audit green, world diff
   reviewed at Circular Quay, Town Hall portal approaches, Meadowbank bridge.*
2. **Deterministic service, visible trains** — timetable bake, phase solver,
   moving exteriors, station dwells with doors; two-module determinism check
   + full-cycle separation sweep + negative control (force a phase collision,
   watch it fail). *Gate: suite green, trains watchable across the CBD.*
3. **Boarding and riding** — protocol v10, interiors, deterministic
   prefetch, jump-out, HUD; harness: 100 bots commuting, melee-on-train
   determinism check. *Gate: ride Penrith → Town Hall in one sitting, combat
   aboard, no streaming stall at 44 m/s.*
4. **Underground access + polish** — station boxes and entrances for all
   ~28 below-grade stations, portal lighting, platform announcements (audio
   hooks for user-supplied content, the DJ-folder pattern), line-coloured
   routes + station dots on both maps, `/tp <station>` aliases.

Phases 1–2 are pipeline-heavy (a world republish each), 3 is client/server,
4 is content. Each is one agent wave on the established pattern.

## 10. Decisions taken here so the build doesn't stall on them

- Express 160 km/h so trains are actually fastest; 130 elsewhere. The user
  said "like 120" *and* "fastest" — fastest wins, and the plan says why.
- Livery evocative-not-exact; no logos, no fleet numbers.
- Tunnels are tubes for riding through, not walkable spaces.
- No timetable realism beyond determinism — the real Sydney Trains timetable
  is neither frequent nor deterministic, and the user asked for better.
- Light rail and ferries: out of scope for this plan; the same architecture
  carries both later (a ferry is a slow train with no tunnel problem).
