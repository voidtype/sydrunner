/**
 * The swarm. PERFORMANCE.md phase 1's first deliverable.
 *
 *     bun run server/loadtest.ts --players 250 --minutes 3
 *     bun run server/loadtest.ts --players 500 --minutes 3 --url ws://127.0.0.1:8787 --shards 4
 *     bun run server/loadtest.ts --players 50 --minutes 1 --quiet
 *
 * PERFORMANCE.md phase 4's two runs:
 *
 *     # 1,000 across 8 rooms
 *     SYDNEY_ROOMS=8 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=2 bun run server/index.ts
 *     bun run server/loadtest.ts --players 1000 --minutes 3 --shards 8
 *
 *     # the CBD pileup: 100 clients converging on one intersection, one room
 *     SYDNEY_ROOMS=1 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=0 bun run server/index.ts
 *     bun run server/loadtest.ts --players 100 --minutes 3 --shards 2 --converge
 *
 * N headless clients over **real sockets**, doing the real hello/name flow and
 * then a scripted behaviour mix at the real 60 Hz input cadence, against a
 * server that has no idea they are not people. It measures both ends: the
 * server's own tick cost and phase breakdown off `/stats`, and what each client
 * actually observed -- snapshot interval jitter, bytes, join failures -- because
 * those two disagreeing is itself a finding.
 *
 * ---------------------------------------------------------------------------
 * ## Why real sockets and not a loop calling `sim.step`
 *
 * A harness that drove the simulation directly would be a faster and much
 * cleaner thing to write, and it would measure the wrong half. What phase 1
 * exists to find out is where **a server process** falls over, and by the time
 * a tick is 8 ms the answer might be the melee, or it might be 500 `ws.send`
 * calls, or it might be the input decode path allocating an object per packet
 * (it was -- see `Conn.input`). Only a real socket puts all three in the
 * profile at their real relative sizes.
 *
 * ---------------------------------------------------------------------------
 * ## Shards, and when to use them
 *
 * By default every client runs in this process. That is fine to about 250 on an
 * M2 Pro: the harness costs roughly 0.02 ms of its own thread per client per
 * tick, so at 500 the *harness* saturates a core and starts under-sending,
 * which shows up as a server that looks suspiciously cheap. `--shards K` forks
 * K copies of this file with N/K clients each -- separate processes, separate
 * event loops, separate heaps -- and the parent aggregates. **Use `--shards 4`
 * at 500 and above.** The parent process holds no sockets at all; it polls
 * `/stats` and collects one JSON line per shard.
 *
 * ---------------------------------------------------------------------------
 * ## Rooms, and how a client is assigned one
 *
 * PERFORMANCE.md phase 3. The parent fetches `/rooms` once and hands every shard
 * the list; each client takes `roomlist[globalIndex % rooms.length]` and puts it
 * in its own `?room=` query. Two properties, both of which a per-client
 * `/rooms` fetch would have lost:
 *
 *   - **The spread is exact.** A run where one room drew 140 clients and another
 *     110 has measured two different things and reported their average. The
 *     server's own least-full rule is right for players arriving one at a time
 *     and wrong for a thousand arriving at once, because occupancy lags the
 *     ramp.
 *   - **Two shards cannot both fill room 0.** The index is global -- a shard's
 *     clients are numbered `shard * 100000 + i` -- so the modulus is taken over
 *     something unique across the whole swarm.
 *
 * A host with one room, or one with no `/rooms` route at all, leaves the list
 * empty and every client connects bare. That is exactly what the phase 1 curve
 * did, so those numbers stay comparable.
 *
 * `--converge` replaces the behaviour mix with "walk at one point and brawl on
 * arrival", which is the CBD-pileup scenario: it is the case where the AOI cap
 * binds for everybody at once, and therefore the case that sets the worst-case
 * per-client downlink the protocol has to survive.
 *
 * ---------------------------------------------------------------------------
 * ## What the server has to be started with
 *
 *     SYDNEY_ROOMS=8 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=0 bun run server/index.ts
 *
 * `SYDNEY_ROOM_CAP` is the per-room join gate and defaults to 128, the room size
 * PERFORMANCE.md measured; `SYDNEY_MAX_PLAYERS` is still accepted as an alias
 * for it, because that is the name phase 1's documented invocation uses.
 * `SYDNEY_BOTS=0` keeps the default bots out of the count so N means N -- and
 * note that bots are **per room**, so eight rooms at the default is sixteen
 * extra combatants, not two.
 *
 * **File descriptors.** Each client is one socket and Bun keeps a few of its
 * own, so N=500 wants `ulimit -n` at 2,048 or better. macOS defaults vary by
 * shell; this file checks and says so rather than dying at client 253 with an
 * error about a pipe. `ulimit -n 8192` in the shell that runs *both* the server
 * and the harness is the fix.
 */

import {
  AOI_MAX_PLAYERS,
  MSG,
  INPUT_BYTES,
  PROTOCOL_VERSION,
  TICK_HZ,
  BTN,
  createSnapshot,
  decodeBye,
  decodeInterest,
  decodeSnapshot,
  decodeWelcome,
  encodeHello,
  encodeInput,
  encodePing,
  frameType,
  type InputFrame,
} from '../client/src/net/protocol.ts';

// --- Arguments ------------------------------------------------------------------

interface Options {
  players: number;
  minutes: number;
  url: string;
  statsUrl: string;
  shards: number;
  /** Seconds to spread the joins over. A thundering herd measures the join path, not the tick. */
  ramp: number;
  /** Seconds between `/stats` polls. */
  sample: number;
  /** Seed for the behaviour mix, so two runs at the same N are the same run. */
  seed: number;
  quiet: boolean;
  /** Set on a forked shard; the parent never sets it for itself. */
  shardIndex: number;
  /**
   * The room ids to spread across, from `/rooms`. Empty means "let the server
   * choose", which is what a single-room host and a pre-phase-3 one both are.
   *
   * Resolved **once, by the parent**, and passed to the shards as a list rather
   * than each shard asking for itself. Two reasons, and the second is the one
   * that bites: a shard that fetched its own listing would see occupancy that
   * the other shards had already changed, so the spread would drift; and the
   * assignment has to be a pure function of a client's *global* index or two
   * shards would independently decide to fill room 0 first.
   */
  rooms: number[];
  /**
   * The CBD pileup: every client walks at one point and stays there.
   *
   * `--converge` alone uses the host's own spawn centre off `/health`, which is
   * where every client starts anyway -- so the scenario is "a hundred people who
   * spawned across a 100 m disc all walk into the middle of it and brawl". That
   * is the shape the AOI cap exists for and the one the phase 4 table measures
   * the worst-case downlink at.
   */
  converge: boolean;
  convergeX: number;
  convergeZ: number;
  /**
   * Walk out of the spawn park before wandering.
   *
   * The default swarm is a **crowd**, and that is not a criticism of it -- every
   * client spawns inside `game/spawn.SPAWN_DITHER_RADIUS` (100 m) of Sydney
   * Park, and a random walk over three minutes displaces about 150 m, so a room
   * of 128 stays inside 180 m of itself and every working set sits on the cap.
   * That is a real state of a real server (the first three minutes of every
   * match) and it is what the plain run measures.
   *
   * It is *not* the steady state of a room that has been up for an hour, and a
   * capacity table with only the crowded number in it would say interest
   * management bought less than it did. `--disperse` gives each client a fixed
   * outward heading for the first 45 seconds -- 45 s at a sprint is about 370 m,
   * so a room of 128 ends up spread over a **700 m disc** -- and then hands them
   * back to the ordinary behaviour mix.
   *
   * 700 m rather than the whole 4 km ring, and the number is stated because it
   * is what the measured working set is a function of: 128 people over a 700 m
   * disc is 3.1 people per hectare, so a 180 m circle holds about 32 of them and
   * the harness measures 27. A room genuinely spread over the built extent would
   * hold **one**. Both rows are in PERFORMANCE.md and the arithmetic between
   * them is what says the cost is O(local density) rather than O(room).
   */
  disperse: boolean;
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const url = get('url', 'ws://127.0.0.1:8787');
  const rooms = get('roomlist', '');
  return {
    players: Number(get('players', '50')),
    minutes: Number(get('minutes', '1')),
    url,
    statsUrl: url.replace(/^ws/, 'http').replace(/\/$/, ''),
    shards: Number(get('shards', '1')),
    ramp: Number(get('ramp', '5')),
    sample: Number(get('sample', '5')),
    seed: Number(get('seed', '1')),
    quiet: argv.includes('--quiet'),
    shardIndex: Number(get('shard', '-1')),
    rooms: rooms === '' ? [] : rooms.split(',').map(Number).filter((n) => Number.isFinite(n)),
    converge: argv.includes('--converge'),
    convergeX: Number(get('cx', 'NaN')),
    convergeZ: Number(get('cz', 'NaN')),
    disperse: argv.includes('--disperse'),
  };
}

// --- One synthetic player ---------------------------------------------------------

/**
 * The behaviour mix, and the reason it is a mix rather than 500 identical bots.
 *
 * A swarm that all wandered would never touch `resolveStrike`, never build a
 * rewound target list and never test the spatial hash's hot path -- so the
 * curve would say the tick is cheap and the curve would be lying. A swarm that
 * all brawled would be an unrealistic worst case in the other direction. These
 * four in these proportions are the instruction's, and they are close to what a
 * real room does: most people are going somewhere, a quarter are fighting, a
 * tenth are throwing a footy at somebody, and one in twenty is stationary
 * (which is also the case that exercises the idle animation byte and the
 * stale-socket reaper).
 */
type Behaviour = 'wander' | 'brawl' | 'footy' | 'idle' | 'converge';

function behaviourFor(n: number): Behaviour {
  const r = n % 20;
  if (r < 12) return 'wander';
  if (r < 17) return 'brawl';
  if (r < 19) return 'footy';
  return 'idle';
}

/**
 * The integer hash this project uses instead of `Math.random`, so a run is
 * reproducible from `--seed` and two shards never draw the same stream.
 */
function rng(state: { s: number }): number {
  state.s = (Math.imul(state.s, 1664525) + 1013904223) | 0;
  return ((state.s >>> 8) & 0xffffff) / 0x1000000;
}

class SwarmClient {
  readonly n: number;
  readonly behaviour: Behaviour;
  private ws: WebSocket | null = null;
  private readonly frame: InputFrame = { seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 };
  private readonly inputBuffer = new ArrayBuffer(INPUT_BYTES);
  private readonly snapshot = createSnapshot();
  private readonly rand: { s: number };

  id = 0;
  /** Which room the WELCOME said this client landed in. -1 until then. */
  room = -1;
  joined = false;
  failed = '';
  closed = false;

  /** Where this client last saw itself, for the brawl-seek. */
  private x = 0;
  private z = 0;
  private headingT = 0;

  /** The pileup's target, for `converge`. */
  private readonly targetX: number;
  private readonly targetZ: number;

  // --- What this client observed. The client half of the measurement.
  snapshots = 0;
  bytes = 0;
  /**
   * The size of every working set this client was sent, summed, and the worst.
   *
   * PERFORMANCE.md phase 2's headline read from the **client's** end. The server
   * reports the same number off `/stats`, and the two agreeing is worth having
   * for the reason this whole harness exists: a server that measured its own
   * working sets correctly and encoded a different set is a server whose stats
   * are a lie, and only a socket can tell.
   */
  setTotal = 0;
  setMax = 0;
  /** How many INTEREST frames arrived, and how many entrances/departures in them. */
  interestFrames = 0;
  interestBytes = 0;
  entered = 0;
  leftView = 0;
  /** Inter-arrival gaps in ms, sampled into a ring so a long run does not grow. */
  private readonly gaps = new Float64Array(4096);
  private gapCount = 0;
  private lastSnapshotAt = 0;
  inputsSent = 0;

  /** Seconds of outward sprint left before the ordinary behaviour takes over. */
  private disperseT: number;
  /** The heading this client disperses on. Fixed per client, so they fan out. */
  private readonly disperseYaw: number;

  constructor(n: number, seed: number, behaviour: Behaviour | null, targetX = 0, targetZ = 0, disperse = false) {
    this.n = n;
    this.behaviour = behaviour ?? behaviourFor(n);
    this.targetX = targetX;
    this.targetZ = targetZ;
    this.rand = { s: (seed * 2654435761 + n * 40503) | 0 };
    this.disperseT = disperse ? 45 : 0;
    // A golden-angle fan rather than a random one, so 128 clients in a room get
    // 128 evenly-spaced headings instead of a random walk's clumps. The same
    // trick `world/vegetation.ts` uses to scatter without gaps.
    this.disperseYaw = (n * 2.39996323) % (Math.PI * 2);
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        this.failed = String(e);
        done();
        return;
      }
      this.ws = ws;
      ws.binaryType = 'arraybuffer';
      ws.onopen = () => {
        // The real hello, with a real name, so the server runs `sanitiseName`
        // and `uniqueName` over five hundred of them -- which is itself a
        // linear-in-N path (`Simulation.pickName` builds a taken list) and one
        // the curve should be paying for.
        ws.send(encodeHello(255, `swarm-${this.n}`));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const buf = ev.data as ArrayBuffer;
        if (!(buf instanceof ArrayBuffer)) return;
        this.bytes += buf.byteLength;
        switch (frameType(buf)) {
          case MSG.WELCOME: {
            const w = decodeWelcome(buf);
            if (!w) return;
            if (w.version !== PROTOCOL_VERSION) {
              this.failed = `protocol ${w.version}`;
              return;
            }
            this.id = w.id;
            this.room = w.room;
            this.x = w.x;
            this.z = w.z;
            this.frame.yaw = w.yaw;
            this.joined = true;
            done();
            return;
          }
          case MSG.SNAPSHOT: {
            const s = decodeSnapshot(buf, this.snapshot);
            if (!s) return;
            const now = performance.now();
            if (this.lastSnapshotAt > 0 && this.gapCount < this.gaps.length) {
              this.gaps[this.gapCount++] = now - this.lastSnapshotAt;
            }
            this.lastSnapshotAt = now;
            this.snapshots++;
            // The working set, measured where it is actually delivered. Under v8
            // a snapshot's player list *is* this client's working set.
            this.setTotal += s.players.length;
            if (s.players.length > this.setMax) this.setMax = s.players.length;
            for (const p of s.players) {
              if (p.id === this.id) {
                this.x = p.x;
                this.z = p.z;
                break;
              }
            }
            this.think(s.players);
            return;
          }
          case MSG.INTEREST: {
            // v8's enter/leave deltas, counted because the *churn* is the thing
            // a badly-chosen hysteresis band shows up in: a flapping boundary is
            // not visible in the snapshot size at all, only in how many times a
            // client is told somebody arrived.
            const d = decodeInterest(buf);
            if (!d) return;
            this.interestFrames++;
            this.interestBytes += buf.byteLength;
            this.entered += d.enters.length;
            this.leftView += d.leaves.length;
            return;
          }
          case MSG.BYE: {
            this.failed = decodeBye(buf) ?? 'bye';
            done();
            return;
          }
          default:
            return;
        }
      };
      ws.onerror = () => {
        if (!this.failed) this.failed = 'socket error';
        done();
      };
      ws.onclose = () => {
        this.closed = true;
        if (!this.joined && !this.failed) this.failed = 'closed before welcome';
        done();
      };
      // A join that never answers is a join failure rather than a hang.
      setTimeout(() => {
        if (!this.joined && !this.failed) this.failed = 'join timeout';
        done();
      }, 20000);
    });
  }

  /**
   * Decide what this client wants, off the snapshot it just decoded.
   *
   * Only the brawl behaviour reads the snapshot, and it reads it the way a
   * person does -- nearest visible body, turn towards it, walk at it, swing
   * when it is close. That is deliberately not a *good* AI. What it has to be
   * is a thing that produces real strike resolutions at a realistic rate, and
   * five hundred of them converging on whoever is nearest is a far better
   * stress of the melee path than five hundred perfect duellists would be.
   */
  private think(players: readonly { id: number; x: number; z: number }[]): void {
    if (this.behaviour !== 'brawl') return;
    let bestD = Infinity;
    let bx = 0;
    let bz = 0;
    for (const p of players) {
      if (p.id === this.id) continue;
      const dx = p.x - this.x;
      const dz = p.z - this.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        bx = dx;
        bz = dz;
      }
    }
    if (bestD === Infinity) return;
    // Yaw 0 faces -Z, which is the whole game's convention: `atan2(-dx, -dz)`.
    this.frame.yaw = Math.atan2(-bx, -bz);
    this.frame.forward = bestD > 2.2 * 2.2 ? 1 : 0;
    this.frame.buttons = bestD < 3 * 3 ? BTN.PUNCH : BTN.SPRINT;
  }

  /** One 60 Hz input, exactly as `net/client.ts` sends one. */
  tick(dt: number): void {
    const ws = this.ws;
    if (!ws || !this.joined || ws.readyState !== 1) return;
    const f = this.frame;
    f.seq = (f.seq + 1) & 0xffff;

    // The dispersal, before the behaviour mix and overriding it. See
    // `Options.disperse`: 45 s of sprinting outward on a fixed heading spreads a
    // room over about 2 km, which is what a match that has been running for an
    // hour looks like and what the plain run deliberately does not.
    if (this.disperseT > 0) {
      this.disperseT -= dt;
      f.yaw = this.disperseYaw;
      f.forward = 1;
      f.right = 0;
      f.buttons = BTN.SPRINT;
      ws.send(encodeInput(f, this.inputBuffer));
      this.inputsSent++;
      return;
    }

    switch (this.behaviour) {
      case 'wander': {
        this.headingT -= dt;
        if (this.headingT <= 0) {
          // A new heading every 1.5-4.5 s, which keeps a client crossing cell
          // boundaries in the spatial hash rather than settling into one.
          this.headingT = 1.5 + rng(this.rand) * 3;
          f.yaw = (rng(this.rand) - 0.5) * Math.PI * 2;
        }
        f.forward = 1;
        f.right = 0;
        f.buttons = rng(this.rand) < 0.3 ? BTN.SPRINT : 0;
        if (rng(this.rand) < 0.004) f.buttons |= BTN.JUMP;
        break;
      }
      case 'brawl':
        // `think` set the yaw and the buttons off the last snapshot; between
        // snapshots this client keeps doing what it decided, which is what a
        // real client does too.
        break;
      case 'footy': {
        this.headingT -= dt;
        if (this.headingT <= 0) {
          this.headingT = 0.4 + rng(this.rand) * 0.8;
          f.yaw = (rng(this.rand) - 0.5) * Math.PI * 2;
          f.pitch = (rng(this.rand) - 0.5) * 0.6;
        }
        f.forward = rng(this.rand) < 0.5 ? 1 : 0;
        // Held, which empties the three-ball bar and then trickles -- the
        // steady state `checkBallBar` describes, and the one that keeps a
        // realistic number of balls in the air rather than a burst.
        f.buttons = BTN.THROW;
        break;
      }
      case 'idle':
        f.forward = 0;
        f.right = 0;
        f.buttons = 0;
        break;
      case 'converge': {
        // Walk at the target and keep walking. Nobody stops, which is the point:
        // a hundred people who all arrive and stand still would settle into a
        // ring the collision resolver pushed them into, where a hundred people
        // all still pressing forward stay packed against each other -- which is
        // what a real pileup is and what puts forty bodies inside 180 m of
        // everybody.
        const dx = this.targetX - this.x;
        const dz = this.targetZ - this.z;
        // Yaw 0 faces -Z, the whole game's convention: `atan2(-dx, -dz)`.
        f.yaw = Math.atan2(-dx, -dz);
        f.forward = 1;
        // Sprint while there is ground to cover, then brawl on arrival. The
        // punch is what keeps `resolveStrike` and the rewind in the profile --
        // a pileup of people who never swing measures the encoder alone.
        const far = dx * dx + dz * dz > 400;
        f.buttons = far ? BTN.SPRINT : (rng(this.rand) < 0.25 ? BTN.PUNCH : 0);
        if (!far && rng(this.rand) < 0.05) f.buttons |= BTN.THROW;
        break;
      }
    }

    ws.send(encodeInput(f, this.inputBuffer));
    this.inputsSent++;
  }

  /** The 2 Hz ping every real client sends, and the reason a socket is not reaped. */
  ping(): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return;
    ws.send(encodePing(0, performance.now(), 60));
  }

  /** p50 / p99 of this client's observed snapshot interval, ms. */
  jitter(): { p50: number; p99: number; n: number } {
    if (this.gapCount === 0) return { p50: 0, p99: 0, n: 0 };
    const a = Array.prototype.slice.call(this.gaps, 0, this.gapCount).sort((x: number, y: number) => x - y);
    return { p50: a[a.length >> 1], p99: a[Math.min(a.length - 1, Math.floor(a.length * 0.99))], n: a.length };
  }

  close(): void {
    this.ws?.close();
  }
}

// --- A shard: N clients in this process --------------------------------------------

interface ShardResult {
  requested: number;
  joined: number;
  failures: Record<string, number>;
  snapshots: number;
  bytes: number;
  inputsSent: number;
  seconds: number;
  /** Every client's observed p50 and p99 snapshot gap, in ms. */
  jitterP50: number[];
  jitterP99: number[];
  /** v8. Working sets as the clients actually received them. */
  setTotal: number;
  setSamples: number;
  setMax: number;
  interestFrames: number;
  interestBytes: number;
  entered: number;
  leftView: number;
  /** How many clients landed in each room. The gateway's spread, measured. */
  perRoom: Record<string, number>;
}

async function runShard(opt: Options): Promise<ShardResult> {
  const clients: SwarmClient[] = [];
  const base = opt.shardIndex < 0 ? 0 : opt.shardIndex * 100000;
  for (let i = 0; i < opt.players; i++) {
    clients.push(
      new SwarmClient(base + i, opt.seed, opt.converge ? 'converge' : null, opt.convergeX, opt.convergeZ, opt.disperse),
    );
  }

  /**
   * The URL one client connects on, with its room in the query.
   *
   * The assignment is `globalIndex % rooms.length` rather than a fetch of
   * `/rooms` per client, and both halves of that matter. Round-robin on a
   * *global* index means two shards cannot both decide to fill room 0 first --
   * each shard's clients are `shardIndex * 100000 + i`, so the modulus is taken
   * over a number that is unique across the whole swarm. And naming the room
   * explicitly rather than letting the server's least-full rule pick means the
   * spread is **exactly** even, which is what a capacity table wants: a run
   * where one room drew 140 clients and another 110 measures two different
   * things and reports their average.
   */
  const urlFor = (c: SwarmClient): string => {
    if (opt.rooms.length === 0) return opt.url;
    const room = opt.rooms[c.n % opt.rooms.length];
    return `${opt.url}${opt.url.includes('?') ? '&' : '?'}room=${room}`;
  };

  // --- Join, spread over the ramp. A thundering herd of five hundred hellos
  // measures the join path (which is linear in N: `pickName` builds a taken
  // list, `pickColourway` builds a taken set) rather than the tick, and the
  // tick is what the curve is about.
  const gap = (opt.ramp * 1000) / Math.max(1, opt.players);
  const joining: Array<Promise<void>> = [];
  for (const c of clients) {
    joining.push(c.connect(urlFor(c)));
    if (gap > 0) await sleep(gap);
  }
  await Promise.all(joining);

  const joined = clients.filter((c) => c.joined && !c.closed);
  const failures: Record<string, number> = {};
  for (const c of clients) {
    if (c.joined && !c.closed) continue;
    const key = c.failed || 'unknown';
    failures[key] = (failures[key] ?? 0) + 1;
  }

  // --- The run. One absolute-schedule 60 Hz loop over every client, which is
  // `server/index.ts`'s own `pump` and for its own reason: a `setInterval` at
  // 16.67 ms drifts, and a harness whose input rate quietly fell to 55 Hz would
  // report a server that is 8% cheaper than it is.
  const startedAt = performance.now();
  const endAt = startedAt + opt.minutes * 60000;
  let ticksRun = 0;
  let lastPing = startedAt;

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      const now = performance.now();
      if (now >= endAt) {
        resolve();
        return;
      }
      const due = Math.floor(((now - startedAt) / 1000) * TICK_HZ);
      let behind = due - ticksRun;
      if (behind > 8) {
        ticksRun = due - 1;
        behind = 1;
      }
      for (let i = 0; i < behind; i++) {
        for (const c of joined) c.tick(1 / TICK_HZ);
        ticksRun++;
      }
      if (now - lastPing > 500) {
        lastPing = now;
        for (const c of joined) c.ping();
      }
      const nextDue = startedAt + ((ticksRun + 1) / TICK_HZ) * 1000;
      setTimeout(pump, Math.max(0, nextDue - performance.now()));
    };
    pump();
  });

  const seconds = (performance.now() - startedAt) / 1000;
  const result: ShardResult = {
    requested: opt.players,
    joined: joined.length,
    failures,
    snapshots: 0,
    bytes: 0,
    inputsSent: 0,
    seconds,
    jitterP50: [],
    jitterP99: [],
    setTotal: 0,
    setSamples: 0,
    setMax: 0,
    interestFrames: 0,
    interestBytes: 0,
    entered: 0,
    leftView: 0,
    perRoom: {},
  };
  for (const c of joined) {
    result.snapshots += c.snapshots;
    result.bytes += c.bytes;
    result.inputsSent += c.inputsSent;
    result.setTotal += c.setTotal;
    result.setSamples += c.snapshots;
    if (c.setMax > result.setMax) result.setMax = c.setMax;
    result.interestFrames += c.interestFrames;
    result.interestBytes += c.interestBytes;
    result.entered += c.entered;
    result.leftView += c.leftView;
    const key = String(c.room);
    result.perRoom[key] = (result.perRoom[key] ?? 0) + 1;
    const j = c.jitter();
    if (j.n > 0) {
      result.jitterP50.push(j.p50);
      result.jitterP99.push(j.p99);
    }
  }
  for (const c of clients) c.close();
  return result;
}

// --- The server's own view ---------------------------------------------------------

interface RoomSample {
  id: number;
  players: number;
  tickMs: { p50: number; p90: number; p99: number; max: number };
  stalls: number;
  dedup: number;
  interest: { mean: number; max: number };
  bytesOut: number;
}

interface StatsSample {
  tickHz: number;
  tickMs: { p50: number; p90: number; p99: number; max: number };
  stalls: number;
  phaseMs: Record<string, number>;
  players: number;
  bytesPerClientPerSec: number;
  rss: number;
  heap: number;
  /** v8/phase 3. Absent on a pre-phase-3 host, which is why every read is guarded. */
  dedup?: number;
  interest?: { mean: number; max: number };
  room?: RoomSample[];
  windowMs?: number;
}

async function pollStats(url: string): Promise<StatsSample | null> {
  try {
    const res = await fetch(`${url}/stats`);
    if (!res.ok) return null;
    return (await res.json()) as StatsSample;
  } catch {
    return null;
  }
}

// --- Output -------------------------------------------------------------------------

function fmt(n: number, places = 2): string {
  return n.toFixed(places);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

function padR(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function report(opt: Options, shards: ShardResult[], samples: StatsSample[]): void {
  const joined = shards.reduce((a, s) => a + s.joined, 0);
  const requested = shards.reduce((a, s) => a + s.requested, 0);
  const snapshots = shards.reduce((a, s) => a + s.snapshots, 0);
  const bytes = shards.reduce((a, s) => a + s.bytes, 0);
  const inputs = shards.reduce((a, s) => a + s.inputsSent, 0);
  const seconds = Math.max(...shards.map((s) => s.seconds), 1);
  const failures: Record<string, number> = {};
  for (const s of shards) for (const [k, v] of Object.entries(s.failures)) failures[k] = (failures[k] ?? 0) + v;

  const allP50 = shards.flatMap((s) => s.jitterP50).sort((a, b) => a - b);
  const allP99 = shards.flatMap((s) => s.jitterP99).sort((a, b) => a - b);
  const median = (a: number[]): number => (a.length === 0 ? 0 : a[a.length >> 1]);
  const worst = (a: number[]): number => (a.length === 0 ? 0 : a[a.length - 1]);

  // The server samples, with the warm-up discarded: the first poll covers the
  // ramp, during which half the clients are not connected yet and the tick is
  // cheap for a reason that has nothing to do with the number being measured.
  const warm = samples.length > 2 ? samples.slice(1) : samples;
  const avg = (f: (s: StatsSample) => number): number =>
    warm.length === 0 ? 0 : warm.reduce((a, s) => a + f(s), 0) / warm.length;
  const peak = (f: (s: StatsSample) => number): number =>
    warm.length === 0 ? 0 : Math.max(...warm.map(f));

  const phaseKeys = ['advance', 'melee', 'balls', 'traffic', 'powerups', 'bikes', 'npc', 'history', 'index', 'encode', 'broadcast'];

  const L: string[] = [];
  L.push('');
  L.push(`SYDNEY swarm -- ${requested} clients, ${fmt(seconds / 60, 2)} min, ${opt.shards} shard(s), ${opt.url}`);
  L.push('='.repeat(78));
  L.push('');
  L.push('  server (from /stats, warm-up poll discarded)');
  L.push(`    tick rate            ${fmt(avg((s) => s.tickHz), 2)} Hz   (60 is the target; below it the loop is losing)`);
  L.push(`    tick p50 / p99       ${fmt(avg((s) => s.tickMs.p50), 3)} / ${fmt(avg((s) => s.tickMs.p99), 3)} ms`);
  L.push(`    tick p99 worst poll  ${fmt(peak((s) => s.tickMs.p99), 3)} ms      max seen ${fmt(peak((s) => s.tickMs.max), 2)} ms`);
  L.push(`    stalls (>4x budget)  ${warm.reduce((a, s) => a + s.stalls, 0)}   -- the GC proxy; Bun exposes no hook`);
  L.push(`    RSS / heap           ${fmt(peak((s) => s.rss) / 1e6, 1)} / ${fmt(peak((s) => s.heap) / 1e6, 1)} MB (peak)`);
  L.push('');
  L.push('    phase                 ms/tick     % of tick');
  const tickTotal = Math.max(1e-9, avg((s) => s.tickMs.p50));
  for (const k of phaseKeys) {
    const v = avg((s) => s.phaseMs[k] ?? 0);
    L.push(`      ${padR(k, 20)}${pad(fmt(v, 4), 8)}${pad(fmt((v / tickTotal) * 100, 1) + '%', 12)}`);
  }
  L.push('');
  L.push('  clients (what the sockets actually saw)');
  L.push(`    joined               ${joined} / ${requested}`);
  if (Object.keys(failures).length === 0) L.push('    join failures        none');
  else for (const [k, v] of Object.entries(failures)) L.push(`    join failure         ${v} x ${k}`);
  L.push(`    snapshots received   ${snapshots}  (${fmt(snapshots / Math.max(1, joined) / seconds, 2)} Hz per client; 20 is the target)`);
  L.push(`    inputs sent          ${inputs}  (${fmt(inputs / Math.max(1, joined) / seconds, 2)} Hz per client; 60 is the target)`);
  L.push(`    snapshot gap p50     ${fmt(median(allP50), 2)} ms median across clients`);
  L.push(`    snapshot gap p99     ${fmt(median(allP99), 2)} ms median, ${fmt(worst(allP99), 2)} ms on the worst client`);
  L.push(`    downlink per client  ${fmt((bytes / Math.max(1, joined) / seconds) * 8 / 1000, 1)} kbit/s (measured)`);
  L.push(`    server total out     ${fmt((bytes / seconds) * 8 / 1e6, 2)} Mbit/s`);

  // --- v8's interest management, from both ends. The two disagreeing would mean
  // the server measures one working set and encodes another.
  const setTotal = shards.reduce((a, s) => a + s.setTotal, 0);
  const setSamples = shards.reduce((a, s) => a + s.setSamples, 0);
  const setMax = Math.max(0, ...shards.map((s) => s.setMax));
  const entered = shards.reduce((a, s) => a + s.entered, 0);
  const leftView = shards.reduce((a, s) => a + s.leftView, 0);
  const interestBytes = shards.reduce((a, s) => a + s.interestBytes, 0);
  L.push('');
  L.push('  interest management (protocol v8)');
  L.push(
    `    working set          ${fmt(setSamples === 0 ? 0 : setTotal / setSamples, 2)} players mean, ` +
      `${setMax} peak (cap ${AOI_MAX_PLAYERS}), server says ${fmt(avg((s) => s.interest?.mean ?? 0), 2)}`,
  );
  L.push(
    `    enter/leave churn    ${fmt(entered / Math.max(1, joined) / seconds, 2)} in / ` +
      `${fmt(leftView / Math.max(1, joined) / seconds, 2)} out per client per second ` +
      `(${fmt((interestBytes / Math.max(1, joined) / seconds) * 8 / 1000, 2)} kbit/s of it)`,
  );
  L.push(
    `    encode dedup         ${fmt(avg((s) => s.dedup ?? 1), 2)}x  -- frames sent per frame encoded`,
  );

  // --- The per-room breakdown, which is the whole point of the route in phase 3:
  // a host whose p99 is 9 ms because one room is doing all the work is a
  // different machine from one with eight even rooms, and the aggregate cannot
  // tell them apart.
  const roomsSeen = warm.length > 0 ? warm[warm.length - 1].room : undefined;
  if (roomsSeen && roomsSeen.length > 0) {
    const perRoom: Record<string, number> = {};
    for (const s of shards) for (const [k, v] of Object.entries(s.perRoom)) perRoom[k] = (perRoom[k] ?? 0) + v;
    L.push('');
    L.push('  per room (last poll)');
    L.push('    room  players   tick p50   tick p99   set mean   set max   dedup   kbit/s/client');
    for (const r of roomsSeen) {
      const clientsHere = Math.max(1, r.players);
      const windowMs = warm[warm.length - 1].windowMs ?? 1000;
      const perClient = (r.bytesOut / clientsHere / (windowMs / 1000)) * 8 / 1000;
      L.push(
        `    ${pad(String(r.id), 4)}${pad(String(r.players), 9)}` +
          `${pad(fmt(r.tickMs.p50, 3), 11)}${pad(fmt(r.tickMs.p99, 3), 11)}` +
          `${pad(fmt(r.interest.mean, 1), 11)}${pad(String(r.interest.max), 10)}` +
          `${pad(fmt(r.dedup, 2) + 'x', 8)}${pad(fmt(perClient, 1), 16)}`,
      );
    }
    const joinedPerRoom = Object.entries(perRoom)
      .filter(([k]) => k !== '-1')
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    L.push(`    clients placed by the gateway: ${joinedPerRoom}`);
  }
  L.push('');
  console.log(L.join('\n'));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Entry ---------------------------------------------------------------------------

const opt = parseArgs(process.argv.slice(2));

if (opt.shardIndex >= 0) {
  // A forked shard. One JSON line on stdout and nothing else, so the parent can
  // parse it without a protocol.
  const result = await runShard(opt);
  console.log(`LT_RESULT ${JSON.stringify(result)}`);
  process.exit(0);
}

// --- The parent.

{
  const soft = Number(process.env.LT_ULIMIT ?? 0);
  if (soft > 0 && soft < opt.players + 64) {
    console.warn(`[loadtest] ulimit -n is ${soft} and this run wants ${opt.players + 64}. Run: ulimit -n 16384`);
  }
  const health = await fetch(`${opt.statsUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      `[loadtest] no server at ${opt.statsUrl}/health.\n` +
        `           start one with:  SYDNEY_ROOMS=8 SYDNEY_ROOM_CAP=128 SYDNEY_BOTS=0 bun run server/index.ts`,
    );
    process.exit(1);
  }
  const body = (await health.json()) as { rooms?: Array<{ id: number; cap: number }>; spawn?: { x: number; z: number } };
  console.log(`[loadtest] server up: ${JSON.stringify(body)}`);

  // --- The gateway, resolved once for the whole swarm.
  //
  // The parent asks and the shards are told, which is the only arrangement that
  // spreads evenly: see `urlFor`. A host with no `/rooms` (or one room) leaves
  // this empty and every client connects bare, which is what the phase 1 curve
  // did and is still exactly what it means.
  if (opt.rooms.length === 0) {
    const rooms = await fetch(`${opt.statsUrl}/rooms`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    if (Array.isArray(rooms) && rooms.length > 1) {
      opt.rooms = rooms.map((r: { id: number }) => r.id);
      const capacity = (body.rooms ?? []).reduce((a, r) => a + r.cap, 0);
      console.log(
        `[loadtest] ${opt.rooms.length} rooms (${capacity} seats): spreading ${opt.players} clients ` +
          `round-robin, ${Math.ceil(opt.players / opt.rooms.length)} per room`,
      );
      if (capacity > 0 && opt.players > capacity) {
        console.warn(
          `[loadtest] ${opt.players} clients against ${capacity} seats -- the overflow will be refused, ` +
            `which is a join-failure measurement rather than a capacity one.`,
        );
      }
    }
  }

  // The pileup's target, off the host rather than baked in. See `Options.converge`.
  if (opt.converge && !Number.isFinite(opt.convergeX)) {
    opt.convergeX = body.spawn?.x ?? 0;
    opt.convergeZ = body.spawn?.z ?? 0;
    console.log(`[loadtest] converging every client on (${fmt(opt.convergeX, 1)}, ${fmt(opt.convergeZ, 1)})`);
  }
}

// Discard whatever the server accumulated before this run started; `/stats`
// resets its window on read, so one throwaway poll is the reset.
await pollStats(opt.statsUrl);

const samples: StatsSample[] = [];
let polling = true;
const poller = (async (): Promise<void> => {
  while (polling) {
    await sleep(opt.sample * 1000);
    if (!polling) break;
    const s = await pollStats(opt.statsUrl);
    if (s) {
      samples.push(s);
      if (!opt.quiet) {
        console.log(
          `[loadtest] t+${pad(String(samples.length * opt.sample), 4)}s  ` +
            `${pad(String(s.players), 4)} players  ` +
            `tick ${pad(fmt(s.tickMs.p50, 2), 6)}/${pad(fmt(s.tickMs.p99, 2), 6)} ms p50/p99  ` +
            `${pad(fmt(s.tickHz, 1), 5)} Hz  ` +
            `${pad(fmt(s.rss / 1e6, 0), 5)} MB  ` +
            `${pad(fmt(s.bytesPerClientPerSec * 8 / 1000, 1), 7)} kbit/s/client  ` +
            `${s.stalls} stalls`,
        );
      }
    }
  }
})();

let shards: ShardResult[];
if (opt.shards <= 1) {
  shards = [await runShard({ ...opt, shardIndex: -1 })];
} else {
  const per = Math.floor(opt.players / opt.shards);
  const procs: Array<Promise<ShardResult>> = [];
  for (let i = 0; i < opt.shards; i++) {
    const n = i === opt.shards - 1 ? opt.players - per * (opt.shards - 1) : per;
    const args = [
      'run', new URL(import.meta.url).pathname,
      '--players', String(n),
      '--minutes', String(opt.minutes),
      '--url', opt.url,
      '--ramp', String(opt.ramp),
      '--seed', String(opt.seed),
      '--shard', String(i),
      // The room assignment, resolved once by the parent. A shard that fetched
      // its own would see occupancy the other shards had already changed.
      '--roomlist', opt.rooms.join(','),
      '--quiet',
    ];
    if (opt.converge) args.push('--converge', '--cx', String(opt.convergeX), '--cz', String(opt.convergeZ));
    if (opt.disperse) args.push('--disperse');
    const proc = Bun.spawn(['bun', ...args], { stdout: 'pipe', stderr: 'inherit' });
    procs.push(
      new Response(proc.stdout).text().then((text) => {
        const line = text.split('\n').find((l) => l.startsWith('LT_RESULT '));
        if (!line) throw new Error(`shard ${i} produced no result:\n${text.slice(0, 2000)}`);
        return JSON.parse(line.slice('LT_RESULT '.length)) as ShardResult;
      }),
    );
  }
  shards = await Promise.all(procs);
}

polling = false;
await poller;
report(opt, shards, samples);
process.exit(0);
