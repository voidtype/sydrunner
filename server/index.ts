/**
 * The authoritative server. Spec milestone 9: *"Two browsers see each other move."*
 *
 * Bun, because spec 9's default recommendation was *"Bun + Caddy on the Mac
 * mini, static tiles, no persistence"* and the user took it. The half of that
 * choice that actually shows up in the code is the first clause of its
 * justification -- *"fastest to write, **shares types with the client**"* -- and
 * it is not types it shares, it is the simulation itself. Every gameplay
 * decision this process makes is made by a file in `client/src/`:
 *
 *     game/combat.ts      the punch, the phases, the knockback, the respawn
 *     game/footy.ts       the ball's flight, its bounces and what it lands on
 *     game/powerups.ts    spec 8.3's pickups and modifiers
 *     player/controller.ts   movement, imported and stepped at a fixed 60 Hz
 *     player/collision.ts    the same prism payload the browser downloads
 *     world/terrain.ts       the same .terr.bin the browser downloads
 *     net/protocol.ts        every byte on the wire, encoded by one encoder
 *
 * Those files were written to be lifted -- `game/combat.ts`'s header spends
 * three rules on it and `game/powerups.ts` restates them -- and this pass lifted
 * them without changing a line of their behaviour. The check that it really is
 * one simulation rather than two is that `verifyCombat`, `verifyPowerups` and
 * `verifyFooty` are run **here at boot**, in this process, off the same source
 * the browser runs them from.
 *
 * ---------------------------------------------------------------------------
 * WebSocket, not WebTransport. See `net/protocol.ts`'s header for the full
 * argument; the short version is that spec 10's transport requires HTTP/3 and a
 * real TLS certificate, which is the deployment step this pass is explicitly
 * not doing, and blocking two browsers on one desk behind a certificate
 * authority is the wrong order to do the work in. The seam is `NetTransport`.
 *
 * ---------------------------------------------------------------------------
 * This process serves the game and **not the world**. Spec 9's third question
 * was answered "static tiles", so 326 MB of GLB keeps coming from vite (in
 * development) or any static host (later), and this listens on one port and
 * speaks one binary protocol. It reads the collision and terrain sidecars off
 * the disk at boot because it needs to simulate against them; it has no route
 * that would hand one to a browser.
 *
 *     bun run server/index.ts            # from the repo root
 *     npm run server                     # the same thing
 *     SYDNEY_PORT=9000 npm run server    # a different port
 *     SYDNEY_BOTS=0 npm run server       # no bots
 */

import { verifyCombat } from '../client/src/game/combat.ts';
import { verifyFooty } from '../client/src/game/footy.ts';
import { verifyPowerups } from '../client/src/game/powerups.ts';
import { verifySpatialHash } from '../client/src/game/spatialhash.ts';
import { verifyMovementBasis } from '../client/src/player/controller.ts';
import {
  INTERP_DELAY_MS,
  MAX_PLAYERS,
  MAX_REWIND_MS,
  MSG,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  SNAPSHOT_INTERVAL,
  TICK_HZ,
  decodeHello,
  decodeInput,
  decodePing,
  encodeBikes,
  encodeBye,
  encodeEvents,
  encodePong,
  encodePowerups,
  encodeInvestigations,
  encodeRoster,
  encodeSnapshotInto,
  encodeWelcome,
  frameType,
  patchSnapshotAck,
  rankRoster,
  rosterBytes,
  snapshotBytes,
  type InputFrame,
  type SnapshotPlayer,
} from '../client/src/net/protocol.ts';
import { verifyNames, verifyNet } from '../client/src/net/protocol.ts';
import { botName } from './bots.ts';
import { verifyRewind } from './rewind.ts';
import { Simulation, applyButtons, verifySim, type Participant, type TickOutput } from './sim.ts';
import { loadWorld } from './world.ts';

const PORT = Number(process.env.SYDNEY_PORT ?? 8787);
const WORLD_ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const BOT_COUNT = Number(process.env.SYDNEY_BOTS ?? 2);

/**
 * The join gate, and **the one thing `server/loadtest.ts` turns up**.
 *
 * `protocol.MAX_PLAYERS` is spec 2's sixteen and stays sixteen: it is a
 * *protocol* constant, the client reads it, and PERFORMANCE.md phase 1 changes
 * no protocol. What this is, is the number of humans this process will admit,
 * which is a deployment question and is exactly what a capacity curve varies.
 *
 * **Above 255 the wire aliases.** `encodeSnapshot` writes the player id and the
 * player count as `u8`, so a 500-player run puts two players on id 244 and tells
 * every client the roster is 244 long. The *simulation* is honest at any count
 * -- the ids inside this process are 32-bit, every body is stepped, every byte
 * is written -- so the CPU and bandwidth numbers a load run produces are real,
 * and that is what the curve measures. What is not real above 255 is any client
 * that tries to *interpret* the result. Phase 2's protocol v8 has to widen both
 * fields; this is the measurement that says by how much.
 */
const MAX_HUMANS = Number(process.env.SYDNEY_MAX_PLAYERS ?? MAX_PLAYERS);

// --- Self-checks, before anything expensive -----------------------------------

/*
 * `main.ts` runs six of these before it constructs a renderer and refuses to
 * boot on any failure. This runs eight before it opens a socket, for the same
 * reason and with one addition: the four shared ones are being run **in a second
 * runtime**, and the whole premise of this architecture is that they behave
 * identically there. A shared module that silently depended on a browser global
 * would fail here rather than three hours into a match.
 */
{
  const checks: Array<[string, string[]]> = [
    ['verifyMovementBasis', verifyMovementBasis()],
    ['verifyCombat', verifyCombat()],
    ['verifyPowerups', verifyPowerups()],
    ['verifyFooty', verifyFooty()],
    ['verifyNet', verifyNet()],
    // The names, in the process that has the last word on them. This one is run
    // on both ends deliberately: the browser sanitises so the prompt shows the
    // player what they will be called, and this sanitises again because the
    // first run happened inside something the player controls -- and the whole
    // arrangement only works if the two runs agree, which is what an idempotent
    // sanitiser compiled from one file means.
    ['verifyNames', verifyNames()],
    ['verifyRewind', verifyRewind()],
    // PERFORMANCE.md phase 1's grid, which every hit test in the game now
    // takes its candidates from. A grid that is not a superset is a punch that
    // passes through somebody, and there is no frame in which that looks like
    // an index bug rather than a hit test one.
    ['verifySpatialHash', verifySpatialHash()],
    ['verifySim', verifySim()],
  ];
  const failed = checks.filter(([, f]) => f.length > 0);
  if (failed.length > 0) {
    console.error('Self-checks failed; refusing to start.\n');
    for (const [name, f] of failed) for (const line of f) console.error(`  ${name}: ${line}`);
    process.exit(1);
  }
  console.log(`[sydney] self-checks pass: ${checks.map(([n]) => n).join(', ')}`);
}

// --- The world ----------------------------------------------------------------

const t0 = performance.now();
const world = await loadWorld(WORLD_ROOT);
console.log(
  `[sydney] world "${world.index.stage}": ${world.index.tiles.length} tiles, ` +
    `${world.collision.buildingCount.toLocaleString()} prisms (${(world.bytes.collision / 1e6).toFixed(1)} MB), ` +
    `${world.terrain.loadedTiles} terrain grids (${(world.bytes.terrain / 1e3).toFixed(0)} kB), ` +
    `${world.points.length} powerups — ${(performance.now() - t0).toFixed(0)} ms`,
);

const sim = new Simulation(world);

// Spec 9's stub, promoted. Two bots so a single human online still has something
// to hit -- see `server/bots.ts` for why these two personalities and not the
// third. They are ordinary combatants: nothing downstream of `join` knows.
for (let i = 0; i < BOT_COUNT; i++) {
  // Named from `bots.BOT_NAMES` by index, so the first two are always Bazza and
  // Shazza. A bot is an ordinary combatant on the scoreboard and gets an
  // ordinary row -- which is the point of giving them names at all: a human
  // beaten by a bot should be able to see who beat them.
  const bot = sim.join(255, i % 2 === 0 ? 'aggressor' : 'pacer', botName(i));
  console.log(`[sydney] bot ${bot.id} "${bot.name}" (${bot.bot!.kind}, kit ${bot.colourway})`);
}

// --- Connections --------------------------------------------------------------

/**
 * What each socket carries.
 *
 * `pendingInput` is the *latest* input received since the last tick rather than
 * a queue, and that is a real decision. A client sends at 60 Hz and the server
 * ticks at 60 Hz, so in the steady state exactly one arrives per tick -- but TCP
 * bunches, so two or three land together after a hiccup. Replaying all of them
 * on one tick would give that client two or three ticks of movement in one,
 * which is a speed hack handed out for free to whoever has the worst connection.
 * Taking the newest and discarding the rest costs that client a few ticks of
 * their own input and costs everybody else nothing, which is the right way round.
 *
 * The dropped inputs are *not* lost from the client's point of view: they were
 * predicted locally and the ack tells it which one the server actually applied,
 * so reconciliation replays from there. See `net/client.ts`.
 */
interface Conn {
  participant: Participant | null;
  /**
   * The latest input, **decoded straight into a record owned by this socket**.
   *
   * PERFORMANCE.md phase 1. This used to be `InputFrame | null` holding a
   * `{ ...scratch }` spread of the shared decode buffer, which is one object per
   * input message per client -- 60 Hz x N, or **thirty thousand objects a
   * second at five hundred players**, the second-largest allocation site in the
   * process. The copy is still a copy (the decode scratch is shared across
   * sockets and aliasing it would give every player the last input anybody
   * sent), it is just a copy into a field instead of into a new object.
   */
  readonly input: InputFrame;
  /** Whether `input` holds something the next tick has not consumed. */
  hasInput: boolean;
  /** Smoothed round trip, ms. Seeded pessimistically so an early punch is not over-rewound. */
  rtt: number;
  lastSeen: number;
}

function newConn(): Conn {
  return {
    participant: null,
    input: { seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 },
    hasInput: false,
    rtt: 60,
    lastSeen: Date.now(),
  };
}

const conns = new Set<{ data: Conn; send(data: ArrayBuffer): void; close(): void }>();
type Socket = { data: Conn; send(data: ArrayBuffer | Uint8Array): number; close(code?: number, reason?: string): void };

/**
 * How many of the participants are people. Counted rather than spread.
 *
 * The three places that used to ask this each built `[...sim.participants
 * .values()].filter(...)` -- a fresh array of every participant, on the join
 * path, on `/health`, and on the ten-second log. At five hundred players and a
 * churning load test that is the kind of quiet allocation that only shows up as
 * a GC pause with nothing obvious in the profile.
 */
function humanCount(): number {
  let n = 0;
  for (const p of sim.participants.values()) if (!p.bot) n++;
  return n;
}

const server = Bun.serve<Conn>({
  port: PORT,
  hostname: '0.0.0.0',

  fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const humans = humanCount();
      return new Response(
        JSON.stringify({
          ok: true,
          tick: sim.tick,
          players: humans,
          bots: sim.participants.size - humans,
          stage: world.index.stage,
          protocol: PROTOCOL_VERSION,
        }),
        // The one route that is not the game, and the one that needs a CORS
        // header: a browser fetching it from the vite origin is a cross-origin
        // request, where the WebSocket upgrade below is not subject to the
        // same-origin policy at all.
        { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } },
      );
    }
    /*
     * `/stats` -- what `server/loadtest.ts` reads, and the only thing in this
     * process that knows where a tick went.
     *
     * A second route rather than more fields on `/health`, because the two
     * answer different questions to different callers: `/health` is a liveness
     * probe a deployment hits and has to stay cheap and stable, and this is a
     * measurement instrument that resets its own counters when it is read. A
     * probe with side effects would be a probe that made the numbers wrong for
     * whoever asked next.
     *
     * **Reading it resets the window**, so successive polls report disjoint
     * intervals and a harness can integrate them. The tick-cost percentiles are
     * the exception: they come off a 20 s ring that is not cleared, because a
     * p99 that only ever saw one poll's worth of ticks is not a p99.
     */
    if (url.pathname === '/stats') {
      const now = performance.now();
      const window = Math.max(1e-6, now - statsReadAt);
      const sorted = Float64Array.prototype.slice.call(tickCost, 0, Math.min(ticksMeasured, tickCost.length)).sort();
      const at = (q: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]);
      // Per-tick milliseconds, which is what a budget is stated in. The
      // simulation accumulates totals since the last read; dividing by the
      // ticks in that window is the only conversion that survives a poll
      // interval that is not exactly one second.
      const ticksInWindow = Math.max(1, ticksRun - statsTicksAt);
      const phases: Record<string, number> = {};
      for (const [k, v] of Object.entries(sim.phaseMs)) phases[k] = v / ticksInWindow;
      phases.encode = encodeMs / ticksInWindow;
      phases.broadcast = broadcastMs / ticksInWindow;
      const body = JSON.stringify({
        tick: sim.tick,
        players: humanCount(),
        participants: sim.participants.size,
        /** Ticks per second actually achieved. Below 60 means the loop is losing. */
        tickHz: (ticksInWindow / window) * 1000,
        tickMs: { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: worstTick },
        /** Ticks over four budgets. Bun exposes no GC hook; this is the observable proxy. */
        stalls,
        phaseMs: phases,
        bytesOut: bytesSent,
        snapshots: snapshotsSent,
        /** Bytes per client per second, the number AOI has to bring down. */
        bytesPerClientPerSec: humanCount() > 0 ? (bytesSent / humanCount() / window) * 1000 : 0,
        rss: process.memoryUsage.rss(),
        heap: process.memoryUsage().heapUsed,
        windowMs: window,
        ticksInWindow,
      });
      statsReadAt = now;
      statsTicksAt = ticksRun;
      for (const k of Object.keys(sim.phaseMs)) (sim.phaseMs as Record<string, number>)[k] = 0;
      encodeMs = 0;
      broadcastMs = 0;
      bytesSent = 0;
      snapshotsSent = 0;
      stalls = 0;
      worstTick = 0;
      return new Response(body, {
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      });
    }
    const ok = srv.upgrade(req, { data: newConn() });
    if (ok) return undefined;
    return new Response('SYDNEY game server. Connect a WebSocket; tiles are served elsewhere.\n', {
      status: 426,
    });
  },

  websocket: {
    // Binary frames only, and `perMessageDeflate` off. Compressing a 50-byte
    // snapshot of already-quantised integers costs a compressor pass per client
    // per snapshot to save nothing: the payload is dense by construction, which
    // is the entire point of `net/protocol.ts`.
    perMessageDeflate: false,
    maxPayloadLength: 1024,

    open(ws: Socket) {
      conns.add(ws as never);
    },

    message(ws: Socket, raw: string | Buffer) {
      if (typeof raw === 'string') return; // no text protocol exists
      const frame = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
      const conn = ws.data;
      conn.lastSeen = Date.now();

      switch (frameType(frame)) {
        case MSG.HELLO: {
          const hello = decodeHello(frame);
          if (!hello) return;
          if (hello.version !== PROTOCOL_VERSION) {
            // Refused rather than tolerated. See `PROTOCOL_VERSION`: the two
            // ends do not ship together, so a tab left open across a restart is
            // the normal case and a misparsed snapshot is the normal symptom.
            ws.send(encodeBye(`protocol ${hello.version}; this server speaks ${PROTOCOL_VERSION}. Reload the page.`));
            ws.close(1002, 'protocol');
            return;
          }
          if (humanCount() >= MAX_HUMANS) {
            ws.send(encodeBye(`full (${MAX_HUMANS} players)`));
            ws.close(1013, 'full');
            return;
          }
          if (conn.participant) return; // a second hello on one socket is ignored

          // The name is a request, exactly as the colourway is. `sim.join`
          // sanitises it again and dedupes it against the world -- see
          // `Simulation.pickName` -- so what comes back on `p.name` is what this
          // player is actually called, which is not always what they asked for.
          const p = sim.join(hello.colourway, null, hello.name);
          conn.participant = p;
          ws.send(
            encodeWelcome({
              version: PROTOCOL_VERSION,
              id: p.id,
              colourway: p.colourway,
              snapshotHz: SNAPSHOT_HZ,
              tick: sim.tick,
              x: p.combat.body.position.x,
              y: p.combat.body.position.y,
              z: p.combat.body.position.z,
              yaw: p.combat.body.yaw,
            }),
          );
          // Spec 8.3's currently-taken points, so a joiner's icons match
          // everybody else's from the first frame rather than showing a full
          // city that empties as the first pickups happen.
          ws.send(encodePowerups(sim.powerupsDown()));
          // Every lime e-bike, once, with whoever is currently on one.
          //
          // The whole set rather than a nearby subset, on `Simulation.snapshot`'s
          // own argument about relevance culling: it is 1.3 kB paid once, and a
          // client that only knew about bikes near its spawn would show an empty
          // city to anybody who walked anywhere. From here it is deltas -- see
          // `runTick`.
          ws.send(encodeBikes(sim.bikeRecords()));
          // And who the police are currently after, so a joiner arriving into a
          // pursuit already in progress can render the marker over the suspect
          // rather than seeing four officers shooting at somebody for no visible
          // reason. Almost always a two-byte frame.
          ws.send(encodeInvestigations(sim.investigations()));
          // The scoreboard, **before** the join events below it, and the order
          // is the one rule about this message: a client turns a JOIN into a
          // line in its kill feed, and a name it has not been told yet is a line
          // that says "player 4 joined" for somebody it will be calling Shazza a
          // frame later. Same rule in `runTick`, for the same reason.
          ws.send(encodeRoster(sim.roster()));
          // And who is already here, so the client can build its remote actors
          // before the first snapshot rather than one snapshot late.
          ws.send(
            encodeEvents(
              [...sim.participants.values()].map((other) => ({
                kind: 4 as const,
                id: other.id,
                colourway: other.colourway,
                bot: other.bot ? 1 : 0,
              })),
            ),
          );
          // `rosterSent` is deliberately **not** updated here. The join bumped
          // `sim.rosterVersion`, and everybody who was already in the world
          // still has to be told there is a new row; the broadcast on the next
          // tick does that, and re-sending it to this socket costs 400 bytes
          // once.
          console.log(
            `[sydney] player ${p.id} "${p.name}" joined (kit ${p.colourway}); ${sim.participants.size} in the world`,
          );
          return;
        }

        case MSG.INPUT: {
          if (!conn.participant) return;
          // Decoded straight into this socket's own record. `decodeInput` takes
          // its output, so there is no shared scratch to alias and no spread to
          // allocate -- see `Conn.input`.
          if (!decodeInput(frame, conn.input)) return;
          conn.hasInput = true;
          return;
        }

        case MSG.PING: {
          const ping = decodePing(frame);
          if (!ping) return;
          // The reported round trip, for the scoreboard's ping column and for
          // nothing else. `conn.rtt` -- which decides how far a punch is rewound
          // -- is deliberately not written here: see `protocol.encodePing` for
          // why a client that could set its own rewind budget would.
          if (conn.participant) conn.participant.ping = ping.rttMs;
          ws.send(encodePong(ping.seq, ping.clientTime, performance.now()));
          return;
        }

        default:
          return;
      }
    },

    close(ws: Socket) {
      conns.delete(ws as never);
      const p = ws.data.participant;
      if (p) {
        sim.leave(p.id);
        console.log(`[sydney] player ${p.id} "${p.name}" left (${p.kos} KOs, ${p.downs} downs)`);
      }
    },
  },
});

// --- The loop -----------------------------------------------------------------

/**
 * Spec 10's 60 Hz, drift-corrected.
 *
 * `setInterval(fn, 16.67)` is the obvious implementation and it is wrong in a
 * way that takes an hour to see: the interval is a *minimum*, so every tick that
 * runs long pushes the next one out and the error accumulates. Over ten minutes
 * a naive interval loses several seconds, and because the client is predicting
 * against its own accurate 60 Hz, the drift presents as reconciliation
 * corrections that grow steadily worse the longer a session runs.
 *
 * So the loop keeps an absolute schedule -- tick *n* is due at `start + n / 60`
 * -- and catches up when it falls behind, with a cap for the same reason
 * `main.ts` clamps its frame delta: a process suspended by a laptop lid must not
 * run four thousand ticks on resume.
 */
const MAX_CATCHUP_TICKS = 8;
const startedAt = performance.now();
let ticksRun = 0;

const out: TickOutput = { tick: 0, events: [], snapshot: null };
const snapshotScratch: SnapshotPlayer[] = [];

/**
 * Rolling cost of a tick, for the console line below and for `/stats`.
 *
 * Twenty seconds of ticks rather than two, because PERFORMANCE.md phase 1's
 * exit criterion is a **p99** and a 120-sample window has 1.2 samples above the
 * 99th percentile. 1,200 is 9.6 kB of Float64 and gives the tail 12 samples to
 * be made of.
 */
const tickCost = new Float64Array(TICK_HZ * 20);
let costCursor = 0;
let ticksMeasured = 0;
let snapshotsSent = 0;
let bytesSent = 0;
let encodeMs = 0;
let broadcastMs = 0;
let worstTick = 0;
/** A tick this far over budget waited on something; see `runTick`. */
const STALL_MS = (1000 / TICK_HZ) * 4;
let stalls = 0;

/**
 * The one snapshot buffer, and the two views onto it. See the send loop.
 *
 * Sized for the sixteen-player world at boot and grown on demand, because a
 * server that starts at five hundred players' worth of buffer to serve two is
 * carrying 10 kB nobody asked for and a server that reallocates every tick is
 * the thing this exists to stop.
 */
let snapshotPool = new ArrayBuffer(snapshotBytes(MAX_PLAYERS, 8, 24));
let snapshotView = new DataView(snapshotPool);
let snapshotBytesOut = new Uint8Array(snapshotPool);

/**
 * The scoreboard's cadence: on change, plus a slow refresh for the ping column.
 *
 * `rosterSent` is the `sim.rosterVersion` this loop last put on the wire, so a
 * join, a departure or a knockout is broadcast on the tick it happens and
 * nothing else is. `ROSTER_REFRESH_TICKS` covers the one field that changes
 * continuously and that nothing bumps the version for -- see
 * `Simulation.rosterVersion`.
 *
 * Two seconds, and the number is chosen against what the message costs rather
 * than against how fresh a ping needs to be. `protocol.encodeRoster` has the
 * arithmetic: 402 B at sixteen players is 1.6 kbit/s at this cadence, about 3%
 * of what the snapshots cost at the same count. A ping column two seconds stale
 * is a ping column; one at 20 Hz would be a second snapshot stream carrying
 * names that have not changed since anybody joined.
 */
const ROSTER_REFRESH_TICKS = TICK_HZ * 2;
let rosterSent = -1;
let rosterTick = 0;
let rostersSent = 0;

/**
 * The police channel's cadence, and it is the roster's exactly.
 *
 * On change -- an investigation opening, ending, or changing its reason -- plus
 * a slow refresh for the one field that moves continuously and that nothing
 * bumps the version for, which here is the countdown. That is the same
 * arrangement the scoreboard has and it is the same argument
 * (`Simulation.investigationVersion` states it): a client runs the countdown
 * down itself between messages, so what the refresh is actually correcting is
 * accumulated clock drift, and two seconds of that at 60 Hz is nothing anybody
 * can read off a banner rounded to whole seconds.
 *
 * The message is four bytes an entry. At the sixteen-player cap with everybody
 * somehow wanted at once it is 66 B every two seconds, or 0.26 kbit/s -- a sixth
 * of what the roster costs at the same count, and in the ordinary case (nobody
 * wanted) it is a two-byte frame that is not sent at all, because the version
 * has not moved and the refresh below skips an empty set.
 */
const INVESTIGATION_REFRESH_TICKS = TICK_HZ * 2;
let investigationSent = -1;
let investigationTick = 0;

function runTick(): void {
  const began = performance.now();

  // Apply the newest input from each socket. Before `sim.step`, so the tick sees
  // it -- and the ack is recorded here rather than inside the simulation,
  // because "which packet did I last hear from you" is a property of the
  // connection and not of the combatant.
  for (const ws of conns) {
    const conn = (ws as unknown as Socket).data;
    const p = conn.participant;
    if (!p || !conn.hasInput) continue;
    const frame = conn.input;
    conn.hasInput = false;
    p.input.forward = frame.forward;
    p.input.right = frame.right;
    p.input.yaw = frame.yaw;
    p.input.pitch = frame.pitch;
    applyButtons(p.input, frame.buttons);
    p.ackSeq = frame.seq;
    // Spec 8.2's lag compensation, in ticks. Half a round trip is how long the
    // input took to arrive; the interpolation delay is how far in the past this
    // client was *drawing* everybody else when they pressed the button. Both
    // have to be undone to evaluate the punch against what the attacker saw --
    // and the sum is clamped to spec 10's 250 ms cap, so a client claiming a
    // four-second trip gets 250 ms and not a licence.
    const viewMs = Math.min(MAX_REWIND_MS, conn.rtt * 0.5 + INTERP_DELAY_MS);
    p.viewTicks = (viewMs / 1000) * TICK_HZ;
  }

  sim.step(out);

  // The scoreboard, **before** the events below it and after the step that may
  // have changed it. The order is the whole of the contract with the client: a
  // JOIN event becomes a line in a kill feed, and a client that has not been
  // told the new player's name yet writes that line with an id in it. Sending
  // the roster first means every event in the batch below can be named.
  if (sim.rosterVersion !== rosterSent || sim.tick - rosterTick >= ROSTER_REFRESH_TICKS) {
    rosterSent = sim.rosterVersion;
    rosterTick = sim.tick;
    const entries = sim.roster();
    const frame = encodeRoster(entries);
    for (const ws of conns) {
      const s = ws as unknown as Socket;
      if (!s.data.participant) continue;
      s.send(frame);
      bytesSent += frame.byteLength;
      rostersSent++;
    }
  }

  // The police channel, beside the roster and above the events for the same
  // ordering reason: a client turns a shot's `HIT` event into a flinch and a
  // sound, and it should already know *why* it is being shot at when that
  // arrives rather than a frame later.
  //
  // **The refresh fires even when nobody is wanted**, which looks like waste and
  // is the one thing that makes the client's prediction safe.
  //
  // A client opens its own banner the instant it commits a crime it can see a
  // witness for -- see `net/client.predictInvestigation`, which exists so the
  // banner appears when the bat connects rather than a third of a second later.
  // When that prediction is *right*, the server's own message arrives within a
  // snapshot and agrees. When it is **wrong** -- the officer the client thought
  // could see it had walked behind a van on the server's copy of the world --
  // there is by definition no version change here to contradict it, and an
  // earlier cut of this skipped the empty message on the grounds that it carried
  // nothing. The result was a player under investigation for forty-five seconds
  // on their own screen with nothing chasing them.
  //
  // So a quiet server sends a two-byte frame every two seconds, per client:
  // 8 bit/s, against the 22 kbit/s the snapshots already cost. That is the price
  // of "a wrong prediction clears itself", and it is not a price.
  {
    const changed = sim.investigationVersion !== investigationSent;
    const refresh = sim.tick - investigationTick >= INVESTIGATION_REFRESH_TICKS;
    if (changed || refresh) {
      investigationSent = sim.investigationVersion;
      investigationTick = sim.tick;
      // Read inside the branch rather than above it. On a quiet server this
      // fires once every two seconds instead of sixty times a second, and
      // `sim.investigations()` walks a map either way.
      const frame = encodeInvestigations(sim.investigations());
      for (const ws of conns) {
        const s = ws as unknown as Socket;
        if (!s.data.participant) continue;
        s.send(frame);
        bytesSent += frame.byteLength;
      }
    }
  }

  // The bikes, on the tick a claim or a drop happens, and only the records that
  // changed. Beside the events and above them for the same ordering reason the
  // roster is above both: a client turns `FLAG.RIDING` in the next snapshot into
  // a seated pose and a bike mesh, and it needs to have been told which bike
  // before that arrives. On a normal tick this array is empty and nothing is
  // sent at all.
  {
    const changed = sim.bikeDelta();
    if (changed.length > 0) {
      const frame = encodeBikes(
        changed.map((b) => ({ id: b.id, rider: b.rider, x: b.x, y: b.y, z: b.z, yaw: b.yaw })),
      );
      for (const ws of conns) {
        const s = ws as unknown as Socket;
        if (!s.data.participant) continue;
        s.send(frame);
        bytesSent += frame.byteLength;
      }
    }
  }

  // Events on the tick they happen, at up to 60 Hz. See `net/protocol.ts`: a
  // snapshot is idempotent state and an event is a transition, so delaying an
  // event to the snapshot rate would put a punch's sound up to 50 ms after the
  // punch for no saving worth having -- events are rare.
  if (out.events.length > 0) {
    const frame = encodeEvents(out.events);
    for (const ws of conns) {
      const s = ws as unknown as Socket;
      if (!s.data.participant) continue;
      s.send(frame);
      bytesSent += frame.byteLength;
    }
  }

  // Snapshots at spec 10's 20 Hz. One encode for the roster, but a *separate*
  // frame per client, because the `ackSeq` in the header is that client's own
  // and is the whole basis of its reconciliation. The 21 bytes per player are
  // identical across clients; only the two-byte ack differs, which would be a
  // real saving to exploit and is not worth the shared-buffer aliasing bug it
  // would invite at this player count.
  if (sim.tick % SNAPSHOT_INTERVAL === 0) {
    const players = sim.snapshot(snapshotScratch);
    // The projectile section, built once for the roster exactly as the players
    // are: a ball is the same object to everybody looking at it.
    const balls = sim.ballSnapshot();
    // And the faction section, likewise once for the roster: an officer is the
    // same object to everybody looking at them. See `protocol.NPC_BYTES` for
    // what is in the record and, more usefully, what is deliberately not.
    const npcs = sim.npcSnapshot();

    // **One encode, one buffer, one ack patched per client.**
    //
    // PERFORMANCE.md phase 1, and it is the change that comment above used to
    // argue against: *"only the two-byte ack differs, which would be a real
    // saving to exploit and is not worth the shared-buffer aliasing bug it
    // would invite at this player count"*. At this player count, correct. At the
    // counts the capacity curve runs at it was the largest allocation site in
    // the process by an order of magnitude -- 10.5 kB x 500 clients x 20 Hz is
    // 105 MB a second of garbage to say the same thing five hundred times.
    //
    // The aliasing bug it invites is real and is closed by one property of the
    // transport: `ws.send` **copies** into the socket's write buffer
    // synchronously, so by the time the ack is patched for the next client the
    // previous one's bytes are already gone. Nothing here holds a reference to
    // the buffer across a line.
    const bytes = snapshotBytes(players.length, balls.length, npcs.length);
    if (snapshotPool.byteLength < bytes) {
      // Grown to the high-water mark and never shrunk, which for a process
      // whose player count only goes up during a session is one allocation.
      snapshotPool = new ArrayBuffer(bytes);
      snapshotView = new DataView(snapshotPool);
      snapshotBytesOut = new Uint8Array(snapshotPool);
    }
    let t = performance.now();
    encodeSnapshotInto(snapshotView, sim.tick, 0, players, balls, npcs);
    encodeMs += performance.now() - t;

    t = performance.now();
    const wire = snapshotBytesOut.subarray(0, bytes);
    for (const ws of conns) {
      const s = ws as unknown as Socket;
      const p = s.data.participant;
      if (!p) continue;
      patchSnapshotAck(snapshotView, p.ackSeq);
      s.send(wire);
      bytesSent += bytes;
      snapshotsSent++;
    }
    broadcastMs += performance.now() - t;
  }

  const cost = performance.now() - began;
  tickCost[costCursor] = cost;
  costCursor = (costCursor + 1) % tickCost.length;
  ticksMeasured++;
  // The stall detector, and it is the closest thing to a GC probe this runtime
  // gives. Bun exposes no allocation counters and no GC hook, so what is
  // measured instead is the observable symptom: a tick that took more than four
  // times the 16.67 ms budget did not do four times the work, it waited. See
  // `/stats`.
  if (cost > STALL_MS) stalls++;
  if (cost > worstTick) worstTick = cost;
}

function pump(): void {
  const due = Math.floor(((performance.now() - startedAt) / 1000) * TICK_HZ);
  let behind = due - ticksRun;
  if (behind > MAX_CATCHUP_TICKS) {
    // Resumed from a suspend, or a very long GC. Skipping is the honest answer:
    // running the missed ticks would teleport everyone and running none would
    // freeze the world. `main.ts` makes the same call about its frame delta.
    ticksRun = due - 1;
    behind = 1;
  }
  for (let i = 0; i < behind; i++) {
    runTick();
    ticksRun++;
  }
  // The next tick's due time, less the time already spent. `setTimeout(0)` when
  // behind, which yields to the socket reads rather than spinning.
  const nextDue = startedAt + ((ticksRun + 1) / TICK_HZ) * 1000;
  setTimeout(pump, Math.max(0, nextDue - performance.now()));
}

pump();

// --- Housekeeping -------------------------------------------------------------

/**
 * A stale socket is one that has sent nothing for half a minute.
 *
 * A client sends input at 60 Hz and pings twice a second, so a second of silence
 * is already a broken connection and thirty is enormously generous. The
 * generosity is aimed at exactly one case, and it is the case this whole pass
 * exists for: **two browser windows on one machine**, only one of which is
 * focused. A browser stops issuing animation frames to a window it considers
 * hidden, which stops that client's input entirely -- so the only thing holding
 * its socket open is `net/client.ts`'s ping, which is on a timer for this reason
 * and which a browser throttles to about 1 Hz rather than stopping. Thirty
 * seconds covers a throttled tab with two orders of magnitude to spare and still
 * reaps a genuinely dead socket well before anyone wonders why a statue is
 * standing in the street.
 */
const STALE_MS = 30000;
setInterval(() => {
  const now = Date.now();
  for (const ws of conns) {
    const s = ws as unknown as Socket;
    if (now - s.data.lastSeen > STALE_MS) s.close(1001, 'silent');
  }
}, 5000);

/** When `/stats` last reported, so each poll covers a disjoint window. */
let statsReadAt = performance.now();
let statsTicksAt = 0;

/** One line every ten seconds, and only when somebody is connected. */
setInterval(() => {
  const humans = humanCount();
  if (humans === 0) return;
  const sorted = Array.from(tickCost).filter((v) => v > 0).sort((a, b) => a - b);
  const median = sorted.length ? sorted[sorted.length >> 1] : 0;
  const rate = (bytesSent * 8) / 10 / 1000;
  console.log(
    `[sydney] tick ${sim.tick}  ${humans} player(s) + ${sim.participants.size - humans} bot(s)  ` +
      `${median.toFixed(2)} ms/tick median  ${snapshotsSent} snapshots  ${rate.toFixed(1)} kbit/s out ` +
      `(${snapshotBytes(sim.participants.size)} B/snapshot, ${rostersSent} rosters at ` +
      `${rosterBytes(sim.roster())} B)`,
  );
  // The board itself, so a session leaves a record in the log it has nowhere
  // else to leave one -- there is no persistence and the scoreboard dies with
  // the process, which is spec 12's call and not this line's to change.
  const board = rankRoster(sim.roster());
  if (board.some((r) => r.kos > 0 || r.downs > 0)) {
    console.log(
      `[sydney]   ${board.map((r) => `${r.name} ${r.kos}/${r.downs}`).join('   ')}`,
    );
  }
  snapshotsSent = 0;
  bytesSent = 0;
  rostersSent = 0;
}, 10000);

console.log(
  `[sydney] listening on ws://localhost:${server.port}  ` +
    `(${TICK_HZ} Hz tick, ${SNAPSHOT_HZ} Hz snapshots, ${MAX_REWIND_MS} ms rewind, protocol ${PROTOCOL_VERSION})`,
);
console.log(`[sydney] health: http://localhost:${server.port}/health`);
