# Scaling SYDNEY to 1,000–10,000 concurrent players

Written 2026-08-05, when the game comfortably served 16 players from a single
60 Hz Bun process broadcasting full snapshots. This document is the plan of
record; every number marked *measured* must come from the load harness, not
from this page.

## Where the ceilings are today

1. ~~**Bandwidth is O(players²).**~~ **Done, phase 2.** Every client received
   every player at 20 Hz. At 21 B/player, 1,000 players cost each client 420 KB/s
   down and the server 3.4 Gbit/s up. Dead on arrival — this was the first wall.
   *Measured at 750: 369 KB/s per client and 2.2 Gbit/s up, which extrapolates
   to 490 KB/s and 3.9 Gbit/s at 1,000. The arithmetic on this line was right.*
   Protocol v8's interest management replaced the O(N) term with a constant:
   **a client is sent at most 40 players regardless of the room**, measured at
   199 kbit/s down and 199 Mbit/s up for 1,000 concurrent.
2. **One thread simulates everyone.** 60 Hz × N players × (controller step +
   melee sweeps + projectiles + NPC think). Single-threaded Bun tops out
   somewhere in the low hundreds of players per core — **measured: 450–500, and
   the low hundreds was wrong in an instructive direction.** See the capacity
   curve below. The simulation itself costs 2.9 µs per player per tick and
   would run past 2,500; what stops the process at 500 is the *broadcast*, and
   that is the same wall as (1).
3. ~~**Melee/witness/AOI queries are O(N) scans.**~~ **Done, phase 1.**
   `game/spatialhash.ts` — 8 m cells, rebuilt twice a tick, feeding the melee
   candidate set, the football sweep and the pickup sweep. Equivalence-checked
   against the linear scans it replaced rather than approximated; see
   `checkSpatialHash`.
4. ~~**The roster/leaderboard/killfeed assume one small room.**~~ **Done, phases
   2 and 3.** All three are now per room and room-*global* within it, which is
   the deliberate exception to interest management: a name and a score are
   social rather than spatial, so a leaderboard that only listed the people
   within 180 m would reorder itself as you walked. The kill feed is what that
   buys — a knockout on the other side of the city still prints, with a name on
   it, because the roster it is named from was never filtered. Asserted in
   `checkAoi`.

## The architecture

**Rooms of ~128, many rooms, one Sydney each.** A "room" is a full copy of the
inner world (players only ever meet people in their room). This is the honest
architecture for a brawler: no cross-shard handoff research project, no
single-point mega-process, linear horizontal scaling, and a full room still
feels like a riot because interest management means you only ever *see* the
nearby subset anyway.

- **Interest management (AOI), protocol v8.** ***Done, phase 2.*** Per-client
  snapshots carry only players within 180 m (hysteresis band 180/220 m to stop
  flapping), capped at the 40 nearest. Entities enter/leave the client's working
  set with an explicit `INTEREST` message; ids are per room, monotonic, and never
  reused while live. Client-side nothing above the net layer notices except that
  `remotes` is now a changing subset. Per-client downlink is O(local density) —
  and the two numbers on this line were both optimistic: **measured 133–199
  kbit/s typical and 372 kbit/s in a CBD pileup**, against the 30 and 120
  guessed here. See phase 4 below for why (the estimate assumed a working set of
  eight; a 128-player room in one park gives forty) and for what it changes
  about the hardware table.
- **Room host process.** ***Done, phase 3.*** One Bun process hosts R rooms on
  one thread. Measured at eight rooms × 125 players: **0.43–0.58 ms p50 per
  room**, 81% of one core for the host, so the "≤ 40% of one core per full room"
  target was met with room to spare — a full room is about 3% of a core of
  simulation and the rest is the send path. Rooms share the loaded world data
  read-only; the audit found exactly one mutable thing in it (the powerup
  points), which is per room. **The floor is per room too** — about 0.35 ms a
  tick whether or not anybody is in there — so run one room until there are
  enough players to fill more than one.
- **Gateway.** ***Done, phase 3.*** The join flow asks `/rooms` (tiny JSON: room
  occupancy) and connects to the least-full open room; `?room=<id>` lets friends
  join together and a full room refuses by name. Multiple host processes bind
  distinct ports behind Caddy (`/ws/<n>`) — `caddy/rooms.Caddyfile` and
  DEPLOY.md; multiple boxes are just more hostnames in the gateway list. No
  shared state between rooms except the world files.
- **Hot paths.** Spatial hash (cell ≈ 8 m) over players per room, rebuilt per
  tick, serving melee sweeps, footy hits, police witness checks and AOI
  candidate sets. Snapshot encode into pooled buffers (zero per-tick
  allocation). Rewind ring sized per room, not per process. NPC/faction actor
  budget stays per-room (24) — it already scales by design.

## Running the harness

```sh
ulimit -n 16384                                    # one fd per client, plus Bun's own

# phase 1's shape: one room, no interest management to speak of
SYDNEY_MAX_PLAYERS=800 SYDNEY_BOTS=0 bun run server/index.ts
bun run server/loadtest.ts --players 500 --minutes 3 --url ws://127.0.0.1:8787 --shards 4

# phase 4's: eight rooms, a thousand clients spread across them
SYDNEY_ROOMS=8 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=2 bun run server/index.ts
bun run server/loadtest.ts --players 1000 --minutes 3 --shards 8

# ...and the same, after the swarm has walked out of the spawn park
bun run server/loadtest.ts --players 1000 --minutes 3 --shards 8 --disperse

# the CBD pileup: one room, everybody converging on one intersection
SYDNEY_ROOMS=1 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=0 bun run server/index.ts
bun run server/loadtest.ts --players 100 --minutes 3 --shards 2 --converge

# the whole city at once: every client /tp's to a different suburb and keeps
# moving, against caps small enough to force eviction
SYDNEY_ROOMS=1 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=0 \
  SYDNEY_COLLISION_CAP_MB=30 SYDNEY_LANES_CAP_MB=40 bun run server/index.ts
bun run server/loadtest.ts --players 100 --minutes 3 --shards 2 --scatter
```

`--scatter` is the only mode that moves the server's **collision** residency
(`server/world.ts`): a hexagon is 12 km across, so `--disperse`'s 700 m disc plus
a 500 m margin is one hexagon and the resident set never changes. The **lane**
residency is different, and `--disperse` moves it: its margin is 2,000 m (see
`LANES_NEED_MARGIN_M`), so a 700 m disc anywhere near a hexagon boundary wants
two or three of them, and the 40 MB cap binds and cycles. Run both modes when
either cap is what is under test.

Every run also reports the **lowest `y` any client saw**, which is the one place
a player falling through the world is visible, and the **live car count**, which
is the one place a lane cap silently destroying the city is visible — a car costs
no protocol, so a hundred clients can run a clean three minutes against a Sydney
with nothing driving in it and every other number will look right. Neither costs
the server anything, so no tick-time column shows them.

`SYDNEY_ROOM_CAP` is the per-room join gate and defaults to 128;
`SYDNEY_MAX_PLAYERS` is still accepted as an alias, because that is the name the
phase 1 line above uses and a rename would have invalidated a documented
command. `SYDNEY_ROOMS` defaults to **1**, so a bare `bun run server/index.ts`
is still "start it, open two tabs, fight". Bots are **per room**.

Use `--shards K` at 250 and above — the harness costs about 0.02 ms of its own
thread per client per tick, so a single-process swarm of 500 saturates a core
and under-sends, which reads as a server that is suspiciously cheap. Each shard
is a separate process with its own event loop and heap. The parent resolves
`/rooms` once and hands every shard the list, so clients are spread exactly
round-robin rather than by the server's own least-full rule — an even spread is
what a capacity table wants, and least-full lags a 20-second ramp.

`curl localhost:8787/stats` gives the same numbers as JSON, now with a per-room
breakdown, and **resets its window on read** — so poll it on a schedule or not
at all.

## Measured: the phase 1 capacity curve

Apple M2 Pro (10 cores, 16 GB), Bun 1.3.14, one server process against the real
inner-ring world (372 tiles, 67,882 collision prisms, 1,103 powerup points).
`server/loadtest.ts`, N genuine WebSocket clients over loopback at the real
60 Hz input cadence, behaviour mix 60% wander / 25% brawl-seek / 10% footy spam
/ 5% idle, **three minutes per point**, server-side numbers off `/stats` with
the ramp poll discarded.

| N | tick p50 | tick p99 | sim only¹ | broadcast¹ | RSS | stalls² | down/client | server egress |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 16 | 0.20 ms | 1.34 ms | 0.20 ms | 0.02 ms | 132 MB | 0 | 72 kbit/s | 1.2 Mbit/s |
| 50 | 0.34 ms | 1.51 ms | 0.31 ms | 0.06 ms | 132 MB | 0 | 199 kbit/s | 9.9 Mbit/s |
| 100 | 0.48 ms | 1.92 ms | 0.44 ms | 0.11 ms | 135 MB | 0 | 389 kbit/s | 39 Mbit/s |
| 250 | 1.01 ms | 6.02 ms | 0.97 ms | 0.33 ms | 139 MB | 1 | 945 kbit/s | 236 Mbit/s |
| **500** | **1.72 ms** | **7.77 ms** | 1.56 ms | 0.72 ms | 150 MB | 0 | 1.92 Mbit/s | 958 Mbit/s |
| 750 | 2.55 ms | 13.66 ms | 2.22 ms | 1.32 ms | 158 MB | 1 | 2.95 Mbit/s | 2.21 Gbit/s |
| *500, busy box*³ | *2.31 ms* | *9.80 ms* | *1.99 ms* | *0.92 ms* | *237 MB* | *0* | *1.91 Mbit/s* | *954 Mbit/s* |

¹ Amortised per tick over every tick. The broadcast only runs on one tick in
three (20 Hz snapshots against a 60 Hz sim), so **on a snapshot tick it costs
three times the column** — 2.2 ms at 500, 4.0 ms at 750. That is the whole of
the p99: the tail is not a slow simulation, it is the snapshot tick.
² A tick over four budgets (>66 ms). Bun exposes no GC hook, so this is the
observable proxy. Two in eighteen minutes of load across the whole curve.
³ The same run repeated with two other build workloads on the machine. Kept in
the table rather than discarded — see below.

Every run joined every client with **zero join failures**, held 60.00 Hz, and
delivered 20.5 snapshots and 60.0 inputs per client per second. Client-observed
snapshot interval stayed at a 50.0 ms p50 throughout; its p99 drifted from
52.4 ms at 16 players to 58.4 ms at 750, which is the send loop lengthening and
not the loop losing time.

### The number phase 2 sizes against

> **450–500 players per core at p99 tick < 8 ms**, on this hardware, with
> today's full broadcast. Size on 450.

500 is the boundary rather than a comfortable point, and the honest reason to
say so is that it moved: a repeat of the 500-player run on a busier machine
(two other build/typecheck workloads on the same box) gave p50 2.31 ms and
**p99 9.80 ms** instead of 1.72 / 7.77. Every phase rose about 30% together,
including `index` and `history`, which touch nothing but flat arrays — so that
is core contention and not a code path. A single-tenant box should see the
first row; a shared one should be sized against the second. Nothing below
depends on which: the shape of the curve, the linearity of the simulation and
the O(N²) broadcast are the same in both.

That number is **bandwidth-bound, not CPU-bound**, and the split matters
because phase 2 changes exactly one of the two:

- **Simulation** (everything but encode and broadcast) is linear and cheap:
  0.15 ms of fixed floor plus **2.9 µs per player per tick**. Extrapolated, it
  reaches 8 ms at about 2,700 players (2,000 on the busy box). A 128-player
  room costs **0.52 ms/tick, which is 3.1% of one core** — against this
  document's ≤ 40% budget, a 13×
  margin, so a host process is not going to be limited by the sim.
- **Broadcast** is O(N²) bytes and it is 42% of the tick at 500 and 52% at 750.
  At 750 players the process pushed **2.2 Gbit/s** over loopback. This is the
  wall ceiling (1) describes, now measured, and it is exactly what AOI removes.

Per-player cost inclusive of encode, at room-sized counts, is **~0.03% of a
core** (5.2–5.6 µs/player/tick) — the pre-phase-1 estimate on this page was
0.3–0.5%, so there is a 10–16× margin over what the room arithmetic below
assumed. The rewind ring is 540 B per player (15 ticks × 5 flat arrays,
allocated at full length at join): **69 kB at 128 players**, 405 kB at 750.
Nothing to pre-size — it already is.

Two honest caveats on the runs above 255:

- **The wire aliases above 255 players.** `encodeSnapshot` writes the player id
  and the player count as `u8`. The simulation is 32-bit throughout and every
  body is stepped and every byte written, so the CPU and bandwidth numbers are
  real; what is not real at N > 255 is any client trying to *interpret* the
  result. Protocol v8 has to widen both fields — this is the measurement that
  says so.
- **Loopback is not a network.** 958 Mbit/s at 500 players moved without a NIC,
  a queue discipline or a millisecond of RTT. Phase 4 is where that gets tested.

### What phase 1 changed to get here

Wired the spatial hash into the four proximity queries, and killed the
allocation. Measured in isolation at N=500 (`bun` micro-benchmark, real world
data):

| | before | after | |
|---|---:|---:|---|
| Pickup sweep (1,103 points × N) | 2.64 ms/tick | 0.077 ms/tick | **34×** |
| Snapshot encode, 500 clients | 11.66 ms/tick | 0.023 ms/tick | **504×** |
| Melee: rewind + hit test | 0.116 ms/tick | 0.043 ms/tick | 2.7× |

The encode row is the one that decides the curve: **11.66 ms of a 16.67 ms
budget**, so the pre-phase-1 server could not have reached 500 players at all.
It was one `ArrayBuffer` and one `DataView` per client per snapshot — 105 MB/s
of garbage at 500 — to say the same 10.5 kB five hundred times with a two-byte
ack different. It is now one pooled buffer and a patched ack, asserted
byte-identical to the allocating encoder.

The other four allocation sites removed: the `{ ...frame }` clone on every
inbound `INPUT` (30,000 objects/s at 500), the fresh `SnapshotPlayer` per
player per snapshot (10,000/s), the four objects per rewound target per swing
(`Object.create` + a body spread + a position record + a property descriptor,
now one pooled proxy with prototype getters), and the fresh `RosterEntry` per
participant — which fires on every knockout, so at 500 players it was a
500-object allocation at 60 Hz. RSS across the whole curve moved 132 → 158 MB.

## Measured: the ambient tick, and the tenfold regression that hid in it
*(workstream AA, 2026-08-20)*

Phase 1's table above says **0.20 ms p50 at sixteen players**. Two years of
merges later the production box was reporting `3.30 ms/host-tick median` with
**one** player on it, and the same work measured 1.30 ms on an M-series laptop.
Nothing had regressed in a single merge. A dozen workstreams had each added an
ambient system that cost a tenth of a millisecond, every one defensible, and no
number anywhere added them up: `/stats` still reported ten phases, but those ten
buckets had quietly become containers — `powerups` held the pickups, the cash
bundles, the fares and the tents; `npc` held seven separate systems.

### What it actually was

`server/profile.ts` replaced the ten `performance.now` pairs with **thirty
sections on a cursor** — one clock read per boundary, the sections tiling the
tick rather than sampling it, always on, and a top-six breakdown printed on the
existing ten-second stats line. Its own cost, measured and reported on that
line, is **1.0 µs/tick** — 0.006% of the budget. The first honest breakdown of
the 1.30 ms tick was:

    tick 1.30 ms = powerups 0.43, characters 0.43, bikes 0.17, streetlife 0.09,
                   advance 0.05, wildlife 0.02, rest 0.11

Four fixes, none of which changes behaviour:

1. **The pickup sweep asked the wrong question.** `tickPowerups` walked all
   3,128 powerups in Sydney and asked the combatant hash whether anybody was
   standing in each one — 3,128 hash queries a tick, *at full cost with nobody
   connected*. It now walks the players and asks a static hash of the points
   which cafe each is standing in (`PowerupField.residentIndex`,
   `ServerWorld.pointIndex`). The respawn clocks still tick over every point,
   because a cafe in Penrith comes back whether or not anybody is watching, but
   that is a property read and a branch. **0.43 → 0.005 ms.** `verifyPowerups`
   proves the two paths byte-identical — same events, same order, same points
   left taken — over 40 randomised clustered configurations.
2. **`BikeField.follow` walked 5,511 bikes to find the nought that were
   ridden**, and allocated a `Map` a tick doing it. It now walks a set of the
   ridden ids, maintained by the only three lines in the project that assign
   `Bike.rider`. The cost was never the branch, it was 5,511 pointer chases over
   a quarter-megabyte that anything else in the tick evicted. **0.17 → 0.001 ms.**
   `verifyBikes` runs a thousand randomised claim/release/follow operations and
   compares the set against a full scan after every one.
3. **The character promotion scan posed people a kilometre away and then threw
   them out.** `forEachCharacterNear` must sweep cells out to `CHARACTER_REACH`
   (1.3 km) because a cell whose centre landed on a reservoir rescues its
   footpaths from up to 600 m away — but `poseCharacter` can now refuse off its
   band pool's actual bounding box plus `POSE_SLOP`, before the nearest-point
   search that is nearly all of the cost. **0.43 → 0.16 ms.** `verifyCharacters`
   runs the gated and ungated sweeps over a real `PedestrianField` at nine query
   points, three radii and a day of ticks, and compares the keys in order.
4. **Every combatant asked the same cells the same question.** `countIn(kind,
   cell, day)` is a pure function of three things and none of them is the
   caller, so the eight-player sweep evaluated the identical census lookup and
   bias curve eight times a tick for each of ~250 cell-and-kind pairs. It is now
   memoised for the length of one tick in a 2,048-slot direct-mapped table with
   a generation stamp — a slot read rather than a `Map.get`, because a `Map`
   would have cost half the saving back. **0.16 → 0.07 ms at eight players.**


### After

| | 0 players | 1 player | 8 players |
|---|---:|---:|---:|
| `server/tick-profile.ts`, before | 0.157 ms | 0.485 ms | 0.793 ms |
| `server/tick-profile.ts`, after | 0.012–0.015 ms | 0.035–0.038 ms | 0.152–0.168 ms |

Live host, `bun run server/loadtest.ts`: **1.30 ms → 0.46 ms** median per host
tick at one player (plus the room's two bots), and 1.17 ms → 0.78 ms at eight.
On a box measured at ~2.5x this laptop that is about **1.2 ms** at one player,
against the 3.30 ms it was.

    tick 0.46 ms = characters 0.13, streetlife 0.07, advance 0.04, traffic 0.02,
                   wildlife 0.02, powerups 0.02, rest 0.04

### What is deliberately still expensive

`stepCharacters` (0.13 ms) and `stepStreetlife` (0.07 ms) are the top two and
both are the same shape: a per-combatant sweep of about 250 cell-and-kind pairs
to find the ambient people within 9 m. After fixes 3 and 4 that enumeration *is*
the floor — the poses are gone, the counts are shared across combatants, and
what is left is walking the 8×8 block of cells the 1.3 km rescue radius forces
`CHARACTER_REACH` to assume.

`stepStreetlife` keeps the whole of its share because it never got fixes 3 and
4: its scans go through `forEachMethheadNear` and the drunk sweep rather than
`forEachCharacterNear`, and giving those the same two treatments is a
straightforward second pass that was out of scope here. That is the cheapest
0.07 ms left on the table.

The only way past the enumeration itself is to run the promotion scan at 10 Hz
instead of 60, which changes *when* an ambient NPC becomes solid and hittable by
up to 100 ms. Declined: the tick is inside budget and that is a behaviour change
nobody asked for. If a later pass wants the 0.2 ms, the honest place for the
gate is the promotion loop inside each `step*` and not the whole function —
`stepStreetlife`'s brawl response and ally expiry have to keep running every
tick.

### The check that stops it happening again

`bun run server/tick-profile.ts` boots the shipped world, steps a real
`Simulation` 3,000 times with 0, 1 and 8 participants, prints the full section
table, and **exits 1** if the ambient tick passes 0.020 ms or the one-player
tick passes 0.050 ms — the worst of six runs plus about a third. It
takes about a minute. A budget raised quietly is how 0.20 ms became 3.30, so the
file says in as many words: if it fails, fix the tick or record a fresh
measurement here, but do not just move the number.

## Target hardware (with the egress arithmetic)

**Rewritten against phase 4's measurements.** The original version of this table
is preserved in the strikethrough row below because the gap between what it
assumed and what was measured is the single most expensive mistake on this page
to have carried into a hardware purchase.

Per-player, measured: **133–199 kbit/s down** (local density decides; see phase
4's bracket), 4.8 kbit/s up, and **~0.08% of a core** at 60 Hz inclusive of
encode and send — 81% of one core for 1,000 players across eight rooms.

| Tier | Players | Shape | Egress sustained | Per hour |
|---|---|---|---|---|
| Today | ≤ ~100 (one room) | current 1 vCPU / 1 GB VPS. **The 20 GB/mo cap is still the real limit** | 13–20 Mbit/s at 100 | 6–9 GB |
| 1,000 | 8 rooms × 128, one host process | one dedicated 8-core / 32 GB in Sydney (OVH Local Zone, Vultr Sydney bare metal, or Binary Lane's largest), **unmetered — not "≥ 10 TB/mo"** | **133–199 Mbit/s** | 60–90 GB |
| 6,000–10,000 | 50–80 rooms, 6–10 host processes over 2–3 boxes | gateway list in the client, world stays on jsDelivr | **0.8–2.0 Gbit/s** | 360–900 GB |
| ~~1,000 (as estimated pre-phase-4)~~ | ~~8 rooms × 128~~ | ~~one 8-core, ≥ 10 TB/mo~~ | ~~30 Mbit/s~~ | ~~13 GB~~ |

Three things moved and all of them in the same direction:

- **Per-client downlink is 4.4–6.6× the estimate** (133–199 against 30), because
  the estimate assumed eight players in view and a room of 128 in one park gives
  forty. The *ceiling* is what AOI actually bought — it is now a constant rather
  than a function of the room — but the typical case is much closer to that
  ceiling than this page expected.
- **10,000 players is a 1–2 Gbit/s problem, not a 350 Mbit/s one.** "Unmetered
  1 Gbit" is no longer sufficient at the top tier; it is 2 Gbit or a second box.
- **CPU is no longer the interesting axis at all.** 1,000 players is 81% of one
  core of a ten-core machine. A box's limit is its NIC and its transit bill.

The 20 GB/month VPS cannot host any of the scaled tiers: 1,000 concurrent
players burn **60–90 GB/hour** of game traffic — five to seven times the earlier
figure on this line, and three days' worth of the whole monthly cap in an hour.
Game egress — unlike the world, which jsDelivr now serves — cannot be CDN'd.

The cheapest lever if that bill matters is not more hardware: it is the **ball
section** (60% of the pileup stream, unbounded by interest because balls pile up
where people do) and the **snapshot rate** (20 Hz is spec 10's floor of the
20–30 range already, but 15 Hz with the same 100 ms interpolation buffer would
be a 25% cut for a change nobody would see at these speeds). Both are phase 5.

## Client-side riders (same round)

- **Streaming must never block the render thread.** All world decode
  (GLB parse, collision/lanes/water/names sidecars) moves to a worker;
  main thread only constructs GPU resources from transferred buffers under a
  per-frame budget. Symptom being fixed: CPU-bound hitches on modest Windows
  laptops during tile loads.
- **Traffic pops.** Schedule cars must not appear/vanish in view: routes gain
  park-in/park-out phases at their endpoints so every spawn is a kerb
  pull-out and every despawn is a kerb pull-in — transitions happen in the
  visually-invisible "parked like the other 41,000 parked cars" state.
- Nameplate/roster surfaces get AOI-aware caps (plates already cap at 15;
  leaderboard pages beyond one screen). *Partly answered by phase 2 rather than
  by the client: the plate field is fed from `net.remotes`, which is now the
  working set, so it can never be handed more than 40 candidates. The
  leaderboard still needs paging — it is room-global and a room is 128.*
- **The remote actor pool is the client-side hole phase 4 found.** `main.ts`
  builds a fresh `CharacterActor` on every entrance and disposes it on every
  departure, which was free when the only entrance was a join and is not now: a
  CBD pileup asks a client to build and tear down **fifteen rigs a second**. See
  phase 4's caveats.

## Phases

1. ~~**Measure + harden the core**~~ — **done.** `server/loadtest.ts` (headless
   Bun clients over real sockets, sharded), `game/spatialhash.ts`, pooled
   snapshot encode, `/stats` with a per-phase breakdown, and the capacity curve
   above. Exit criterion met: **450–500 players per core at p99 < 8 ms**, of
   which the simulation alone is ~2,700 and the broadcast is the binding half.
   20 new
   invariants in `server/integration-check.ts` assert the optimisations changed
   nothing: the grid agrees with the linear scan on every one of 2,722
   randomised swings, the pooled encoder is byte-identical to the allocating
   one, and two interleaved simulations produce identical snapshot streams.
2. ~~**AOI protocol v8**~~ — **done.** Per-client filtered snapshots, explicit
   enter/leave, the 180/220 m band, the 40-nearest cap, and the id and count
   fields widened past `u8`. `server/aoi.ts` is the selection rule and the
   frame-set clustering; `net/protocol.ts` is the wire. See below.
3. ~~**Rooms + gateway**~~ — **done.** `server/room.ts` is a room and a host of
   R of them, `/rooms` is the gateway, the client picks least-full or honours
   `?room=`, and a full room refuses by name. `caddy/rooms.Caddyfile` and
   DEPLOY.md carry the multi-process fan-out.
4. ~~**Load-prove**~~ — **done.** 1,000 synthetic players across 8 rooms on one
   M2 Pro, plus a 100-client CBD pileup. Numbers below.

---

# Phases 2–4: interest management, rooms, and the 1,000-player proof

Written 2026-08-05, the same day as everything above it. Phase 1 left the
process bandwidth-bound at 450–500 players in one room; this is what happened
when the broadcast stopped being O(N²) and the room stopped being the process.

## What phase 2 changed: protocol v8

**The wire is per client now, and every id field is a `u16`.**

| field | v7 | v8 | why |
|---|---|---|---|
| snapshot player `id` | `u8` | `u16` | the measurement at the top of this page: 500 players put two people on id 244 |
| snapshot player count | `u8` | `u16` | same frame, same aliasing |
| snapshot ball count | `u8` | `u16` | a pileup really does put >255 balls in one place |
| ball `id`, ball `thrower` | `u8` | `u16` | `thrower` is a player id — aliasing it makes your own ball invisible to you |
| bike `rider` | `u8` | `u16` | the client derives "which bike am I on" by scanning for its own id |
| roster `id`, roster count | `u8` | `u16` | a room is 128, not 16 |
| investigation `playerId`, count | `u8` | `u16` | ditto |
| event `attacker`/`victim`/`combatant`/`id` | `u8` | `u16` | ditto |
| event count | `u8` | `u16` | a wrapped count truncates a batch silently |
| WELCOME `id` | `u8` | `u16` | + a new `u16 room`, so the client can build an invite link |
| snapshot actor `id` | `u16` | `u16` | already right; v8 made the player match it |

Record sizes: **player 21 → 22 B**, **ball 18 → 20 B**, actor 18 B unchanged,
snapshot header 10 → 12 B, roster entry 10 → 11 B, investigation entry 4 → 5 B,
bike record 17 → 18 B, HIT event 5 → 7 B.

**The id lifecycle**, which the widening exists to make safe, is stated in
`protocol.AOI_ID_LIFECYCLE` and enforced in `Simulation.allocateId`: per room,
from 1, monotonic, **wrapping at 65535 and skipping anything live**; 0 is never
allocated because three fields use it as "nobody". Before v8 `nextId` was an
unbounded JavaScript number written as a `u8`, so a long session with churn
eventually handed out an id that aliased onto somebody still standing there.
The hazard it closes is an AOI hazard rather than a roster one: a client keys
100 ms of interpolation history by id, and an id recycled onto a different body
inside that window draws one person sliding into another.

### The new message: `INTEREST` (0x8A)

```
u8   type
u8   enter count          bounded by the 40-player cap
u8   leave count
per entrant: u16 id, u8 colourway, u8 flags   (BOT | RIDING)
per leaver:  u16 id
```

4 bytes to introduce somebody, 2 to say they have gone. Sent **immediately
before** the snapshot whose bodies it explains, and not sent at all on a tick
where nothing changed — a client standing alone in a quiet street receives none.

It is a message of its own rather than a section of the snapshot for one
reason, and it is the reason the dedup below works: the snapshot body is a
function of the *set*, and enter/leave is a function of the set **and of that
client's previous set**. Folding the deltas in would have made every frame
per-client again, which is exactly what phase 1 spent its budget removing.

### The selection rule

> A client's working set is the **40 nearest eligible** players, where eligible
> means within **180 m**, or within **220 m** and already a member.

One sentence rather than two, because "keep old members, then add new ones until
full" is wrong in a way that is visible: with a full set of forty retainees at
200 m, somebody walking up and punching you cannot get in, and the nearest
player in the game is invisible. Hysteresis decides *eligibility*; distance
decides *priority*. Ties go to the lower id, which makes the set a total order —
and the set is the dedup key, so a merely-usually-the-same selection would split
groups at random.

`checkAoi` asserts this against a brute-force scan of the same snapshot records
the room encoded from, over a 90-player room stepped for real: **360 client
snapshots, 0 disagreements, the cap binding for 184 of them.**

The query is **one 220 m sweep at cell 64 m**, not the two the phase 1 note
predicted. `nearestK(180, 40)` cannot express "and these three at 200 m who were
already members", and unioning two answers puts the cap back on the outside
where it has to be re-applied anyway. Cell 64 rather than the melee's 8: a 220 m
query at cell 8 walks 3,025 cells, at cell 64 it walks 64.

### The dedup, and the honest size of it

Clients are clustered by **frame set** — the ids of the players, balls and
actors they are being sent — and one buffer is encoded per distinct set with the
ack patched per client, exactly as phase 1 did per room. `checkAoi` asserts the
byte-identity that makes that legal: every pooled frame equals a fresh
allocating encode of that client's own filtered records at that client's own
ack.

**The measured ratio is modest and the intuition about it is wrong.** "A pileup
dedups perfectly" is what it looks like and it is backwards:

| scenario | dedup |
|---|---:|
| 24 players inside 30 m, nobody within 400 m | **24.0x** |
| 90 players, half piled and half scattered | 1.25x |
| 1,000 across 8 rooms, crowded | 1.19x |
| 100 converging on one intersection | 1.17x |

A cluster **under** the cap dedups perfectly, because everybody in it has the
identical set. A cluster **over** the cap dedups barely at all, because
forty-five people on a ring do not agree about who their forty nearest are. That
is stated plainly rather than rounded up, because the wrong version would have
been repeated — and what makes it acceptable is that in exactly that case the
*cap* is doing the bigger job. The dedup is a second-order saving on encode CPU,
and encode CPU was never the wall.

## What phase 3 changed: rooms

A room is one `Simulation` with its own participants, rewind rings, factions,
bikes, roster, kill feed, investigations and bots. A host process runs R of
them on **one Bun thread**.

**Why one thread.** A full 128-player room is 0.52 ms of simulation (phase 1's
2.9 µs/player plus a 0.15 ms floor), so eight are 4.2 ms against a 16.67 ms
budget — there is no threading problem to solve at this scale, because what
stopped phase 1 at 500 players was the broadcast and phase 2 removed the term
that made it quadratic. Bun Workers were considered and rejected for a specific
reason rather than a general one: **a worker cannot be handed a live
`WebSocket`**, so a worker-per-room design needs either one listener per worker
(a process seam wearing a thread's clothes, with none of a process's isolation)
or a message hop per frame, which puts a structured clone on the path of every
snapshot the pooled encoder exists to avoid copying. The scale-out seam is
therefore **processes** — `SYDNEY_ROOM_BASE` and a Caddy `/ws/<n>` fan-out —
which buys real cores, a memory boundary and a crash boundary, and needs no code.

**The city is loaded once per process** and shared read-only. The audit that
made that safe found exactly one mutable thing in a loaded world:
`PowerupPoint.active` and `respawnT`, mutated by `tickPowerups` sixty times a
second — so `world.roomWorld()` shares the collision prisms, terrain, water,
lane graphs and footpaths by reference and gives every room its own
`PowerupField` built from the same cached sidecar arrays. The integration check
already knew this and said so about its own two simulations; phase 3 turned the
observation into the seam it implied. `checkRooms` asserts it by taking a coffee
in room A and finding it still on the pavement in room B.

**The gateway** is three lines of protocol:

```
GET /rooms            -> [{ id, players, cap, open }, ...]
ws://host/ws?room=3   -> that room, or a BYE naming it if it is full
ws://host/ws          -> the least-full open room
```

The last line is what keeps every existing bookmark working, and it is why the
room a client ends up in is reported back in the `WELCOME` rather than assumed
from the URL. `chooseRoom` lives in `net/protocol.ts` so the server's own checks
can assert the client's rule; it picks **emptiest**, not fullest, because a room
holds 128 and you only ever see 40 of them — packing one to its cap buys nobody
a better game and costs everybody in it the pileup bandwidth.

Every step degrades to the pre-phase-3 behaviour: a host with no `/rooms`, a
proxy that only forwards `/ws`, a fetch that times out, all end with the client
connecting bare and the server choosing.

## Measured: the phase 4 load proof

Apple M2 Pro (10 cores, 16 GB), Bun 1.3.14, one host process against the real
inner-ring world (372 tiles, 67,882 collision prisms, 1,103 powerup points).
`server/loadtest.ts`, N genuine WebSocket clients over loopback at the real
60 Hz input cadence, **three minutes per run**, 20 s ramp, 8 shards, server-side
numbers off `/stats` with the ramp poll discarded and client-side numbers
measured on the sockets themselves.

| run | rooms × players | host tick p50 | host tick p99 | CPU¹ | RSS | working set | down/client | egress | dedup | joins failed |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **1,000, crowded** | 8 × 125 | **10.24 ms** | **13.33 ms** | 81% | 202/252 MB | 39.9 (cap) | 199 kbit/s | 199 Mbit/s | 1.19x | **0** |
| **1,000, dispersed**² | 8 × 125 | 8.67 ms | 11.52 ms | 69% | 193/238 MB | 27.2 | 133 kbit/s | 133 Mbit/s | 1.19x | **0** |
| **CBD pileup**³ | 1 × 100 | 1.79 ms | 8.38 ms | 31% | 164/202 MB | 40.0 (cap) | 372 kbit/s | 37 Mbit/s | 1.17x | **0** |

¹ Percent of **one** core, `ps` sampled every 5 s over the steady window; mean
and peak RSS from the same samples.
² `--disperse`: 45 s of sprinting outward on a golden-angle fan before the
ordinary behaviour mix, which spreads a room over about a 700 m disc.
³ `--converge`: every client walks at one intersection and brawls on arrival.

Every run held **60.00 Hz**, delivered 21.1 snapshots and 60.0 inputs per client
per second, and had **zero join failures**. Client-observed snapshot interval
stayed at a 50.00 ms p50 with a 52.7–54.6 ms p99. Zero stalls (a tick over four
budgets) across nine minutes of load.

Per-room, at 1,000 crowded: tick p50 **0.43–0.58 ms**, p99 **3.07–3.96 ms**, all
eight rooms within 25% of each other, and the gateway placed exactly 128/128/128/
128/128/120/120/120.

### Against phase 1, which is the whole point

| | phase 1, one room | phase 4, eight rooms |
|---|---:|---:|
| players | 500 | **1,000** |
| per-client downlink | 1.92 Mbit/s | **133–199 kbit/s** |
| server egress | 958 Mbit/s | **133–199 Mbit/s** |
| tick p99 | 7.77 ms | **13.33 ms** |
| what bounds a client's downlink | the room | **the 40-player cap** |

Twice the players at a fifth of the egress, and — the part that matters more
than the ratio — **the per-client cost stopped being a function of how many
people are in the game.** A 128-player room and a 10,000-player deployment cost
a client the same ceiling, because nobody can stand next to more than forty
people.

### Two things the run found that were not in the plan

**All eight rooms broadcast on the same tick.** Every room ticked on the host's
one pump and every room used `tick % SNAPSHOT_INTERVAL`, so two ticks did
nothing and the third carried the entire host's egress. Measured as a host p99
of **24.4 ms against a p50 of 3.8** — not a slow simulation, one tick in three
doing all of the sending. Offsetting each room by `id % 3` (`Room.snapshotPhase`)
spread it: **p99 24.4 → 13.3 ms**, p50 3.8 → 10.2 ms. The p50 rising is the
point, not a regression — the work is now the same on every tick, so p50 is the
honest cost and p99 is inside budget. It is free: no client's snapshot rate
changes and nothing can tell which of the three ticks its room landed on. Using
the room *id* rather than its index means two host processes on one box do not
line up either.

**The ten-second console line was stealing the `/stats` window.** Both readers
reset the counters they read, so a log line landing between two polls took that
window's bytes with it, and the harness reported a per-client downlink
alternating between 47 and 186 kbit/s on successive polls. The measurement
instrument and the log line now have separate counters (`Room.logBytes`), for
the same reason `/stats` and `/health` are different routes. This bug predates
phase 3 — it was present in phase 1 and invisible there because the phase 1
table's bandwidth column came off the *clients*, not off `/stats`.

### The honest caveats

- **1,000 players is not a full box of players; it is a full box of *this
  harness*.** The swarm and the server share ten cores. The host used ~81% of
  one, so the headroom is real, but a run that put the harness on another
  machine would measure a different (better) server.
- **Loopback is still not a network.** 199 Mbit/s moved without a NIC, a queue
  discipline or a millisecond of RTT. What that hides is the send-buffer
  behaviour of 1,000 real sockets with real RTTs, which is the next thing to
  measure and cannot be measured here.
- **The pre-AOI estimate of "~30 kbit/s per player" on this page was
  optimistic**, and the reason is worth keeping: it assumed a working set of
  about eight. What sets a client's downlink is **local density**, and the three
  runs bracket it —

  | 128 players spread over | in view | measured |
  |---|---:|---:|
  | a 100 m spawn park (the first minutes of every match) | 40 (cap) | 199 kbit/s |
  | a 700 m disc | 27 | 133 kbit/s |
  | the whole 4 km inner ring (arithmetic, not measured) | ~1 | ~10 kbit/s |

  Real play is somewhere in the middle and closer to the top, because players
  cluster around interesting places on purpose. **Size the egress budget on 130–
  200 kbit/s per player, not 30.** At 1,000 concurrent that is 130–200 Mbit/s
  and 60–90 GB/hour, which changes the hardware table above from "unmetered or
  ≥ 10 TB/mo" to "unmetered, and mean it".
- **The CBD pileup's 372 kbit/s is mostly footballs, not people.** Forty players
  at 22 B is 143 kbit/s; the rest is the ball section, which interest management
  does **not** bound in a pileup because all the balls are in the same place as
  all the people. A hundred clients spamming throw sustained roughly 67 balls in
  the air — 1.3 kB a snapshot, about 60% of the stream. The protocol's own
  invariant (a ball must never cost more than a person) still holds at 20 B
  against 22, but the *count* is unbounded where the roster is capped, which is
  exactly what `verifyNet` has always said about that section. A ball cap, or
  interest by ball *velocity* rather than position, is the cheap fix if this
  ever matters.
- **The pileup thrashes the cap.** With 100 people inside 180 m and a cap of 40,
  the "nearest forty" changes constantly: **15.7 entrances and 15.5 departures
  per client per second**, against 2.0/1.8 in an ordinary crowded room and
  0.7/0.6 dispersed. On the wire that is nothing (1 kbit/s of `INTEREST`
  frames). On a *browser* it is not: `main.ts` builds a fresh `CharacterActor`
  on every entrance and disposes it on every departure, so a pileup would ask a
  client to build and tear down fifteen rigs a second. The band fixes the
  *radius* boundary and does nothing for the *cap* boundary, and the fix is the
  same trick applied twice — rank an existing member as if it were ~0.85× its
  real distance, so a member is only displaced by somebody meaningfully nearer.
  It is deliberately not in this pass: the selection rule is currently proven
  equal to a brute-force scan, and a ranking bias is a change to the rule.
  **This is the top phase 5 candidate**, with pooling the client's remote actors
  beside it.

## Measured: collision held per hexagon

The world's prisms are no longer all resident — `server/world.ts` holds them per
hexagon, near a player, under `SYDNEY_COLLISION_CAP_MB`. Four runs, back to back
on the same tree, 100 clients, 3 minutes each, one room, no bots. Paired rather
than absolute: `npc` is the noisiest phase in the suite and the tree moves, so
what is worth reading is capped against uncapped *within* a pair.

| run | tick p50 | tick p99 | heap peak | resident | loads / evictions | lowest y |
|---|---:|---:|---:|---|---:|---:|
| dispersed, uncapped | 2.193 ms | 7.437 ms | 462 MB | 16/16 hexes, 209 MB | 16 / 0 | −63.1 m |
| **dispersed, 30 MB cap** | **2.054 ms** | **7.297 ms** | **254 MB** | 2/16 hexes, 44 MB | 18 / 16 | −63.0 m |
| scattered, uncapped | 2.114 ms | 7.488 ms | 432 MB | 16/16 hexes, 209 MB | 16 / 0 | −70.8 m |
| **scattered, 30 MB cap** | 2.142 ms | **6.817 ms** | 416 MB | 12/16 hexes, 195 MB | 28 / 16 | −71.1 m |

Zero stalls, zero join failures and 60.00 Hz in all four. **Nobody fell**: the
floor of the built world is about −80 m ENU and the worst altitude any of 400
clients reached was −71.1 m, with a worst snapshot-to-snapshot drop of 1.18 m.

Three things in the table are the whole result:

- **The cap costs nothing.** Capped is *faster* on p50 and p99 in the dispersed
  pair and on p99 in the scattered one. It is not mysterious: with two hexagons
  resident instead of sixteen, `advance`, `traffic` and `bikes` each have fewer
  prisms to test, and the residency's own work is 0.003 ms p50 (measured
  directly) against a 2 ms decode budget it only spends while a hexagon is
  arriving.
- **The saving is a function of where the players are, not of the cap.**
  Dispersed — one room over a 700 m disc, which is what a real room is — holds
  2 hexagons and saves 208 MB of heap. Scattered over the whole 19.3 km world,
  **12 of 16 hexagons are genuinely needed** and the cap cannot be honoured: it
  is broken deliberately, 19 warnings in three minutes, because evicting a
  hexagon somebody is standing in is the one thing this must never do. That is
  the honest shape of the mechanism and it matters at 60 km: a normal room will
  hold 1–3 hexagons (~30–90 MB against 1.4–1.6 GB whole), and a hundred players
  each in a different suburb will hold most of the map.
- **Eviction had to be budgeted too, and that was found by the check rather
  than by the harness.** `CollisionWorld.removeTile` walks every prism and
  splices it out of its broadphase cells, so dropping the fattest hexagon —
  374 tiles, 100,480 prisms — took **21.6 ms** in one call. It is now paid off
  over ticks under the same 2 ms budget the decode uses; the worst single
  residency update measured over a three-hexagon walk is 4.4 ms.

### The fixed floor is now multiplied by R

The one cost rooms add that a single big room does not have. A room's per-tick
work is not all proportional to its occupancy — the faction scan, the powerup
sweep and the bike sweep have a floor that runs whether or not anybody is in
there. At 1,000 players across 8 rooms:

| phase | ms/tick (host, all 8 rooms) | % |
|---|---:|---:|
| npc | 1.35 | 13.2% |
| broadcast | 1.56 | 15.2% |
| encode | 0.98 | 9.5% |
| advance | 0.75 | 7.4% |
| powerups | 0.48 | 4.7% |
| bikes | 0.33 | 3.3% |
| index | 0.25 | 2.5% |
| traffic | 0.24 | 2.3% |
| history, melee, balls | 0.11 | 1.0% |

`npc` is the largest single phase and is the one most nearly independent of
occupancy — it is the ambient promotion scan over police, streetlife and
wildlife, run once per room per tick. Measured empty-room floor is about
**0.35 ms**, so eight empty rooms cost 2.8 ms a tick to serve nobody. The
operational rule that falls out of it, and it is in DEPLOY.md: **run one room
until there are enough players to fill more than one.** The 1 GB production box
should stay at `SYDNEY_ROOMS=1`.

## Measured: the lane graph held per hexagon

The other third of the boot. `TrafficField` and `PedestrianField` — the cars and
the footpaths, shared verbatim by the browser and the server — were measured at
**131.9 MB of live heap** for 13.9 MB of files on the 19.3 km world, and
EXPANSION.md's 7–8x puts that near a gigabyte at 60 km. They are now held per
hexagon on the same `HexResidency` slots as the prisms, under
`SYDNEY_LANES_CAP_MB`.

### First, the thing that made it impossible

Both classes set a dirty flag on `adopt`/`drop` and rebuilt their flat array and
their **whole broadphase grid over every resident tile** on the next query. One
tile arriving or leaving, both fields, on this machine:

| resident lane tiles | before | after | who pays it |
|---:|---:|---:|---|
| 60 | 0.299 ms | **0.012 ms** | a browser at `loadRadius` 1,800 m |
| 90 | 0.421 ms | **0.012 ms** | a browser in the CBD |
| 200 | 0.893 ms | **0.007 ms** | — |
| 754 | 3.402 ms | **0.019 ms** | a lazily-loaded server, mid-city |
| 3,017 | 13.946 ms | **0.018 ms** | a whole-world server |

and the case that actually mattered, a hexagon leaving — 374 tiles dropped one
at a time with a query between each, which is what a browser does when it walks
out of a hexagon and what an eviction cycle does on the server:

| | before | after |
|---|---:|---:|
| 374-tile hexagon out | **4,978 ms** | **7.9 ms** |

**The client was already paying this and nobody had measured it.** A browser
streams tiles continuously; every arrival cost 0.3–0.4 ms of a 16.7 ms frame at
its own residency, with a 1.14 ms worst case, and a hexagon eviction was five
seconds of it. The server could not stream lanes at all: 13.9 ms is 84% of a tick
paid on the first query after every single tile.

Both indexes are now maintained **per tile**, and in an order that is a pure
function of the routes and bands themselves rather than of arrival order.

### The canonical order is not a nicety

`forEachCarNear` documents that **the first car found wins the hit test**, and
the buckets used to be filled in `Map` iteration order — which is tile adoption
order, which is `Promise.all` completion order on the server and streaming order
in a browser. Two processes holding the identical routes could pick different
cars to knock the same player over with, and both shoves would look right.

`checkTraffic` now builds three fields over three load paths — whole, hexagon by
hexagon in a scrambled order, and dropped-then-reloaded — and compares
`forEachCarNear` visit for visit: **10,000 sweeps, 81,814 car poses, identical
order and identical bits**, plus 200 footpath sweeps and 3,750 posed walkers.
The negative control is one line: make `compareRoutes` return 0 and 6,023 of the
10,000 sweeps disagree, every one of them with the same number of cars in a
different order. Do it to `compareBands` instead and the footpath half fails
alone.

### The margin is four times collision's, and the number is measured

`.lanes.bin` is filed under the tile a route *starts* in. Swept over all 23,734
routes in the built city, the widest one runs **1,164.7 m past its own tile's
bounds**. At collision's 500 m margin a car whose sidecar sat in an unloaded
hexagon could have been driving 665 m inside the loaded region — through a
player the server was not testing it against. `LANES_NEED_MARGIN_M` is 2,000 m,
which also clears the police (900 m of rescued catchment + 120 m of promotion +
900 m of catchment = 1,920 m) and is 50.8 s of warning at the fastest speed in
the game. Inside it, a lazily-loaded server answers **every** lane query exactly
as a whole-world server does; `checkServerSegments` asserts both bounds against
the constants they come from.

### The runs

Four, back to back on the same tree, 100 clients, 3 minutes each, one room.
Paired capped-against-uncapped within a mode, for the reason the collision table
gives.

| run | tick p50 | tick p99 | RSS peak | heap peak | lanes resident | loads / ev | live cars | lowest y |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| dispersed, uncapped | 1.003 ms | 2.876 ms | 643.5 MB | 427.0 MB | 16/16, 130 MB | 16 / 0 | 89,470 | −63.1 m |
| **dispersed, 40 MB cap** | **0.957 ms** | **2.538 ms** | **579.8 MB** | **332.1 MB** | 3/16, 53 MB | 6 / 3 | 35,616 | −63.3 m |
| scattered, uncapped | 1.228 ms | 2.449 ms | 641.9 MB | 424.2 MB | 16/16, 130 MB | 16 / 0 | 89,463 | −70.2 m |
| **scattered, 40 MB cap** | 1.233 ms | 2.747 ms | 630.7 MB | 410.2 MB | 15/16, 130 MB | 18 / 3 | 88,922 | −70.9 m |

60.00 Hz in all four, zero join failures in all four, zero stalls in three (the
dispersed uncapped run had one, a 98 ms GC pause). Nobody fell. The traffic never
stopped: the worst poll of the capped dispersed run still had 35,616 cars live on
9,454 resident routes.

Three things in that table:

- **The cap costs nothing and saves a lot where it binds.** Dispersed and capped
  is *faster* on both p50 and p99 and 63.7 MB lighter on RSS, 94.9 MB on heap —
  fewer routes in the grid is less work in `traffic` as well as less memory.
- **`--scatter` cannot honour it, deliberately, and that is the same finding the
  collision pass reported.** A hundred players across 392 suburbs need 15 of 16
  hexagons of lanes at a 2 km margin, so the cap is broken with a warning rather
  than a needed hexagon dropped. 130 MB held against a 40 MB cap is the honest
  shape of the mechanism, not a failure of it.
- **Adding the lane layer did not add a millisecond to the residency's tick.**
  Both layers drain against one `APPLY_BUDGET_MS`, collision first, with a
  0.5 ms floor for the lanes so the priority cannot become starvation. The worst
  single `update` call `checkServerSegments` measures walking three hexagons with
  both caps too small to hold one is 5.8–7.1 ms against 4.4 ms before — one tile
  of overshoot in each of two layers, still comfortably inside a tick.

### Projected at 60 km

The lane graph scales with road length rather than with area, so EXPANSION.md's
7–8x tile estimate is the right multiplier: **0.92–1.06 GB of estimated resident
bytes for the whole 60 km lane graph**, against 1.4–1.6 GB for collision. Neither
is ever held: at the shipped default of `SYDNEY_LANES_CAP_MB=300` the boot walk
warms up to the cap and stops, and the needed set decides the rest. A room that
has not scattered wants 1–3 hexagons of lanes, which on the fattest ground in the
build is 22 MB apiece — **22–66 MB, not a gigabyte**. DEPLOY.md's 1 GB box should
set 100–150.


## What the checks say

`bun run server/integration-check.ts` — **483 checks** at the time this section
was written, all green, up from the 435 that phase 1's suite reports on a run
where the two-probe fight does not happen to produce a knockout (the KO branch
adds two, which is why that number is sometimes 437). It is **835** as of the
lane-residency pass. The new ones, and what each is protecting:

- **`checkAoi`** — the working set against a brute-force statement of the rule
  over a 90-player room stepped for real (360 snapshots, 0 disagreements, the
  cap binding for 184); that no snapshot ever carries a body no `INTEREST` frame
  introduced; that every deduplicated frame is byte-identical to its own
  client's fresh encode (360 compared); that a there-and-back walk across the
  boundary costs exactly **one** entrance and **one** departure; that a tight
  24-player cluster gives all 24 the same set and one encode; that a knockout
  2.8 km away still reaches the kill feed while its fighters were never in view;
  and that a ball 1.5 km away is not sent.
- **`checkRooms`** — `/rooms`, the least-full spread (two bare joins land in
  *different* rooms), a named room honoured, a full room refused **by name**, a
  stale link to a room that does not exist refused by name, disjoint
  leaderboards, an outsider sent exactly one body across four seconds of another
  room fighting, `/health` and `/stats` per-room breakdowns, a coffee taken in
  room A still standing in room B, and — the one that puts the architecture
  beyond doubt — **an attacker and a bystander on the identical square metre of
  Sydney in different rooms**, where the punch lands on the victim and the
  bystander is untouched, unthrown, and told nothing.
- **`verifyAoi`** at boot, beside `verifySpatialHash`: the selection against a
  brute-force scan over randomised crowds, the band, the cap keeping the
  *nearest* rather than the *earliest*, the delta merge, and the frame-group
  interning.

Sixteen-player behaviour is unchanged: the milestone-9 two-probe run, the bots,
the footy, the bikes, the police, the streetlife and the wildlife checks all
pass untouched, and a solo room's working set always contains its own player
plus whatever is nearby — which for two browsers on one desk is each other.

**One honest note about the suite's stability**, found while running it a dozen
times over this pass rather than introduced by it: three or four of the existing
police and wildlife checks are **wall-clock sensitive** and fail on roughly one
run in five. The world's traffic and its pedestrian beats are pure functions of
`Date.now()` by design (see `game/traffic.ts` — that is what makes six thousand
cars cost zero protocol), so whether a car is on a particular street while a
probe sprints a corridor, or whether an officer is on the right beat at the
moment a crime is committed, depends on the wall clock the run happens to start
at. The observed failures — *"the nearest officer went from 15.0 m to Infinity"*,
*"a player who sent no input at all was shot within 25.0 s"*, *"sprinting through
cost 1 of a pip"* (one pip is a car, not a magpie's 0.25) — are all that shape,
all in checks that run **before** any phase 2 or 3 code, and all present in the
same form on the unmodified suite. Twelve runs over this pass: nine clean at
483, three with one to three of those checks failing. Worth fixing by seeding
the wall clock those checks run against; not fixed here, because doing it
properly means giving `trafficTick` an injectable clock and that is a change to
a shared determinism path rather than to a test.
