# Scaling SYDNEY to 1,000–10,000 concurrent players

Written 2026-08-05, when the game comfortably served 16 players from a single
60 Hz Bun process broadcasting full snapshots. This document is the plan of
record; every number marked *measured* must come from the load harness, not
from this page.

## Where the ceilings are today

1. **Bandwidth is O(players²).** Every client receives every player at 20 Hz.
   At 21 B/player, 1,000 players costs each client 420 KB/s down and the
   server 3.4 Gbit/s up. Dead on arrival — this is the first wall. *Measured at
   750: 369 KB/s per client and 2.2 Gbit/s up, which extrapolates to 490 KB/s
   and 3.9 Gbit/s at 1,000. The arithmetic on this line was right.*
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
4. **The roster/leaderboard/killfeed assume one small room.**

## The architecture

**Rooms of ~128, many rooms, one Sydney each.** A "room" is a full copy of the
inner world (players only ever meet people in their room). This is the honest
architecture for a brawler: no cross-shard handoff research project, no
single-point mega-process, linear horizontal scaling, and a full room still
feels like a riot because interest management means you only ever *see* the
nearby subset anyway.

- **Interest management (AOI), protocol v8.** Per-client snapshots carry only
  players within ~180 m (hysteresis band 180/220 m to stop flapping), capped
  at the ~40 nearest. Entities enter/leave the client's working set with
  explicit add/remove; ids stay stable within a room session. Client-side
  nothing above the net layer should notice except that `remotes` is now a
  changing subset. Per-client downlink becomes O(local density), ~30 kbit/s
  typical, ~120 kbit/s worst-case CBD pileup.
- **Room host process.** One Bun process hosts R rooms (R sized from the
  measured per-room tick cost; target ≤ 40% of one core per full room so p99
  tick < 8 ms). Rooms share the loaded world data (read-only) — collision,
  lanes, water tables load once per process, not per room.
- **Gateway.** The join flow asks `/rooms` (tiny JSON: room occupancy) and
  connects to the least-full open room; a room id in the URL/hello lets
  friends join together. Multiple host processes bind distinct ports behind
  Caddy (`/ws/<n>`); multiple boxes are just more hostnames in the gateway
  list. No shared state between rooms except the world files.
- **Hot paths.** Spatial hash (cell ≈ 8 m) over players per room, rebuilt per
  tick, serving melee sweeps, footy hits, police witness checks and AOI
  candidate sets. Snapshot encode into pooled buffers (zero per-tick
  allocation). Rewind ring sized per room, not per process. NPC/faction actor
  budget stays per-room (24) — it already scales by design.

## Running the harness

```sh
ulimit -n 16384                                    # one fd per client, plus Bun's own
SYDNEY_MAX_PLAYERS=800 SYDNEY_BOTS=0 bun run server/index.ts
bun run server/loadtest.ts --players 500 --minutes 3 --url ws://127.0.0.1:8787 --shards 4
```

`SYDNEY_MAX_PLAYERS` is the join gate and defaults to `protocol.MAX_PLAYERS`
(16); the protocol constant is untouched. Use `--shards K` at 250 and above —
the harness costs about 0.02 ms of its own thread per client per tick, so a
single-process swarm of 500 saturates a core and under-sends, which reads as a
server that is suspiciously cheap. Each shard is a separate process with its
own event loop and heap. `curl localhost:8787/stats` gives the same numbers as
JSON and **resets its window on read**, so poll it on a schedule or not at all.

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

## Target hardware (with the egress arithmetic)

Per-player costs after AOI (*verify against harness*): ~30 kbit/s down +
6 kbit/s up sustained, and — measured pre-AOI, so this is now an upper bound
rather than an estimate — **≤ 0.03% of a modern core** at 60 Hz sim inclusive
of encode.

| Tier | Players | Shape | Egress sustained |
|---|---|---|---|
| Today | ≤ ~100 (a few rooms) | current 1 vCPU / 1 GB VPS, **20 GB/mo cap is the real limit** (~30 kbit/s × players × hours) | ~3 Mbit/s at 100 |
| 1,000 | ~8 rooms × 128 | one dedicated 8-core / 32 GB in Sydney (OVH Local Zone, Vultr Sydney bare metal, or Binary Lane's largest), **unmetered or ≥ 10 TB/mo** | ~30 Mbit/s |
| 6,000–10,000 | 50–80 rooms | 3–5 such boxes (or one 32–48-core EPYC), gateway list in the client, world stays on jsDelivr | 180–350 Mbit/s — this is why "unmetered 1 Gbit" is a hard requirement, not a nicety |

The 20 GB/month VPS cannot host any of the scaled tiers: 1,000 concurrent
players burn ~13 GB/hour of game traffic alone. Game egress — unlike the
world, which jsDelivr now serves — cannot be CDN'd.

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
  leaderboard pages beyond one screen).

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
2. **AOI protocol v8** — per-client filtered snapshots, enter/leave semantics,
   client working-set handling, CBD pileup cap. **Widen the player id and the
   player count past `u8` while the protocol is open** — see the caveat above.
   The candidate structure is already there and already paid for:
   `SpatialHash.forEachWithin(x, z, 220, cb)` for the hysteresis sweep and
   `nearestK(x, z, 180, 40, out)` for the cap, against `Simulation.liveIndex`.
   Note that AOI makes the broadcast per-client again, which is what the pooled
   encoder gave up — budget for one buffer per *distinct working set*, not one
   per client, and keep the byte-identity assertion.
3. **Rooms + gateway** — multi-room host, `/rooms`, least-full join, room
   codes, Caddy port fan-out; leaderboard per room.
4. **Load-prove** — 1,000 synthetic players against one host box; publish the
   numbers here; buy hardware accordingly.
