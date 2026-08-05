/**
 * The swarm. PERFORMANCE.md phase 1's first deliverable.
 *
 *     bun run server/loadtest.ts --players 250 --minutes 3
 *     bun run server/loadtest.ts --players 500 --minutes 3 --url ws://127.0.0.1:8787 --shards 4
 *     bun run server/loadtest.ts --players 50 --minutes 1 --quiet
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
 * ## What the server has to be started with
 *
 *     SYDNEY_MAX_PLAYERS=600 SYDNEY_BOTS=0 bun run server/index.ts
 *
 * `SYDNEY_MAX_PLAYERS` is the join gate and defaults to spec 2's sixteen; see
 * `server/index.ts`, which also states what the `u8` id field does above 255
 * and why the CPU curve is still honest there. `SYDNEY_BOTS=0` keeps the two
 * default bots out of the count so N means N.
 *
 * **File descriptors.** Each client is one socket and Bun keeps a few of its
 * own, so N=500 wants `ulimit -n` at 2,048 or better. macOS defaults vary by
 * shell; this file checks and says so rather than dying at client 253 with an
 * error about a pipe. `ulimit -n 8192` in the shell that runs *both* the server
 * and the harness is the fix.
 */

import {
  MSG,
  PROTOCOL_VERSION,
  TICK_HZ,
  BTN,
  createSnapshot,
  decodeBye,
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
}

function parseArgs(argv: string[]): Options {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
  };
  const url = get('url', 'ws://127.0.0.1:8787');
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
type Behaviour = 'wander' | 'brawl' | 'footy' | 'idle';

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
  private readonly inputBuffer = new ArrayBuffer(10);
  private readonly snapshot = createSnapshot();
  private readonly rand: { s: number };

  id = 0;
  joined = false;
  failed = '';
  closed = false;

  /** Where this client last saw itself, for the brawl-seek. */
  private x = 0;
  private z = 0;
  private headingT = 0;

  // --- What this client observed. The client half of the measurement.
  snapshots = 0;
  bytes = 0;
  /** Inter-arrival gaps in ms, sampled into a ring so a long run does not grow. */
  private readonly gaps = new Float64Array(4096);
  private gapCount = 0;
  private lastSnapshotAt = 0;
  inputsSent = 0;

  constructor(n: number, seed: number) {
    this.n = n;
    this.behaviour = behaviourFor(n);
    this.rand = { s: (seed * 2654435761 + n * 40503) | 0 };
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
}

async function runShard(opt: Options): Promise<ShardResult> {
  const clients: SwarmClient[] = [];
  const base = opt.shardIndex < 0 ? 0 : opt.shardIndex * 100000;
  for (let i = 0; i < opt.players; i++) clients.push(new SwarmClient(base + i, opt.seed));

  // --- Join, spread over the ramp. A thundering herd of five hundred hellos
  // measures the join path (which is linear in N: `pickName` builds a taken
  // list, `pickColourway` builds a taken set) rather than the tick, and the
  // tick is what the curve is about.
  const gap = (opt.ramp * 1000) / Math.max(1, opt.players);
  const joining: Array<Promise<void>> = [];
  for (const c of clients) {
    joining.push(c.connect(opt.url));
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
  };
  for (const c of joined) {
    result.snapshots += c.snapshots;
    result.bytes += c.bytes;
    result.inputsSent += c.inputsSent;
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

interface StatsSample {
  tickHz: number;
  tickMs: { p50: number; p90: number; p99: number; max: number };
  stalls: number;
  phaseMs: Record<string, number>;
  players: number;
  bytesPerClientPerSec: number;
  rss: number;
  heap: number;
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
    console.warn(`[loadtest] ulimit -n is ${soft} and this run wants ${opt.players + 64}. Run: ulimit -n 8192`);
  }
  const health = await fetch(`${opt.statsUrl}/health`).catch(() => null);
  if (!health || !health.ok) {
    console.error(
      `[loadtest] no server at ${opt.statsUrl}/health.\n` +
        `           start one with:  SYDNEY_MAX_PLAYERS=${opt.players + 8} SYDNEY_BOTS=0 bun run server/index.ts`,
    );
    process.exit(1);
  }
  console.log(`[loadtest] server up: ${await health.text()}`);
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
      '--quiet',
    ];
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
