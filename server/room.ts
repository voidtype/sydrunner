/**
 * One room: a `Simulation`, the sockets watching it, and everything the wire
 * owes them.
 *
 * PERFORMANCE.md phase 3. A room is *the* unit of this architecture -- players
 * only ever meet people in their own room -- and the reason it is the honest
 * shape for this game rather than a compromise is in that document: no
 * cross-shard handoff research project, no single-point mega-process, linear
 * horizontal scaling, and a full room still feels like a riot because interest
 * management (phase 2, `server/aoi.ts`) means you only ever *see* the nearby
 * subset anyway.
 *
 * This file is what came out of `server/index.ts` when the process stopped being
 * one game. Everything here used to be module-level state in that file -- the
 * roster cadence, the investigation cadence, the snapshot pool, the tick cost
 * ring -- and every one of those is now per room because two rooms sharing any
 * of them would be two rooms with one scoreboard.
 *
 * ---------------------------------------------------------------------------
 * ## Threading: R rooms on one Bun thread, and why that is not a shortcut
 *
 * A room's simulation costs **2.9 us per player per tick** plus a 0.15 ms floor
 * (phase 1, measured), so a full 128-player room is 0.52 ms and eight of them
 * are 4.2 ms against a 16.67 ms budget. There is no threading problem to solve
 * at this scale: what stopped the phase 1 process at 500 players was the
 * *broadcast*, and phase 2 removed the term that made the broadcast quadratic.
 *
 * Bun Workers were considered and rejected, and the reason is specific rather
 * than general. A worker cannot be handed a live `WebSocket` -- Bun's server
 * owns its sockets on the thread that accepted them -- so a worker-per-room
 * design needs either one listener per worker (which is a *process* seam wearing
 * a thread's clothes, with none of a process's isolation) or a message hop per
 * frame between the accepting thread and the simulating one, which puts a
 * structured clone on the path of every snapshot the pooled encoder exists to
 * avoid copying.
 *
 * The scale-out seam is therefore **processes**, not threads: N host processes
 * on ports 8787+n behind Caddy's `/ws/<n>`, which buys real cores, real memory
 * isolation and a crash boundary per host, and needs no code in this file at
 * all. See DEPLOY.md and `caddy/rooms.Caddyfile`. Single-thread R-rooms is
 * simplest, is measurably sufficient (phase 4's table), and the thing it is
 * "deferring" is a thing the deployment topology already answers.
 *
 * ---------------------------------------------------------------------------
 * ## What is filtered by interest and what is not
 *
 * | channel | scope | why |
 * |---|---|---|
 * | `SNAPSHOT` players | working set | phase 2; this is the whole point |
 * | `SNAPSHOT` balls / actors | within `AOI_LEAVE_RADIUS` | by their own position, see `InterestIndex` |
 * | `INTEREST` | per client | it *is* the per-client delta |
 * | `INVESTIGATION` | visible suspects + always your own | a banner over somebody you cannot see is nothing |
 * | `ROSTER` | room-global | names and scores are social, not spatial |
 * | `EVENTS` | room-global | see below |
 * | `BIKES` | room-global | 74 records, once, then deltas measured in bytes |
 *
 * **The events are room-global and that is a decision rather than an
 * oversight.** A `HIT` is 7 bytes and fires on a transition; a busy room lands
 * perhaps ten a second, which is 560 bit/s per client -- under 2% of what a
 * client's snapshots cost. What that buys is that a **knockout across town still
 * prints in the kill feed**, which is the thing a filtered event channel would
 * have quietly broken: the feed is the only place a room-wide game is visible to
 * a player standing in a quiet street, and `net/client.nameOf` can already name
 * anybody from the room-global roster. Filtering them would have saved nothing
 * measurable and cost the one feature rooms exist to make interesting.
 *
 * The cosmetic half takes care of itself: `main.ts`'s `onHit` looks the victim
 * up in `remotes` to decide whether to play a sound, finds nothing for somebody
 * out of interest, and prints the line without the noise. That was already the
 * behaviour for a victim who had not been drawn yet; AOI just made it common.
 */

import {
  AOI_MAX_PLAYERS,
  ENTER_FLAG,
  INTEREST_HEADER_BYTES,
  INTEREST_ENTER_BYTES,
  INTEREST_LEAVE_BYTES,
  INTERP_DELAY_MS,
  MAX_REWIND_MS,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  SNAPSHOT_INTERVAL,
  TICK_HZ,
  encodeBikes,
  encodeEvents,
  encodeInterestInto,
  decodeInput,
  encodeInvestigationsInto,
  encodePowerups,
  encodeRoster,
  encodeSnapshotInto,
  encodeWelcome,
  investigationBytes,
  patchSnapshotAck,
  snapshotBytes,
  type InputFrame,
  type InterestEnter,
  type InvestigationRecord,
  type SnapshotBall,
  type SnapshotAboard,
  type SnapshotNpc,
  type SnapshotPlayer,
} from '../client/src/net/protocol.ts';
import { botName } from './bots.ts';
import { FrameGroups, InterestIndex, InterestSet } from './aoi.ts';
import { Simulation, applyButtons, type Participant, type TickOutput } from './sim.ts';
import { roomWorld, type ServerWorld } from './world.ts';

/** What a socket in this room carries. Moved here whole from `server/index.ts`. */
export interface Conn {
  /** Which room this socket belongs to, fixed at upgrade. -1 until resolved. */
  room: number;
  participant: Participant | null;
  /**
   * The frames this socket has sent that this room has not stepped yet, oldest
   * first. A preallocated ring; `inbox[inboxTail]` is the next one to apply.
   *
   * **One frame is one simulation step, and a tick takes exactly one frame.**
   * That is the whole of the invariant client prediction rests on: the client
   * ran `controller.step` once per input it sent, so this room's trajectory
   * equals the client's only if it runs it once per input too.
   *
   * This replaced a single slot with last-write-wins, whose note said a queue
   * would hand "a speed hack to whoever has the worst connection". That
   * conflates two different things. What stops a speed hack is the **rate**:
   * one frame, one step, one step per tick, which this ring obeys exactly and
   * the slot obeyed too. What last-write-wins bought on top of that was the
   * silent destruction of every frame that shared a tick with a newer one --
   * while acknowledging both, so the client dropped both from its replay
   * history and reconciled onto a position one whole step of movement behind
   * the one it had predicted. See `INPUT_QUEUE` for how often that fired and
   * `checkInputQueue` for the assertion that it no longer does.
   */
  readonly inbox: InputFrame[];
  /** Where the next arrival is written, where the next tick reads, and how many are held. */
  inboxHead: number;
  inboxTail: number;
  inboxCount: number;
  /**
   * Frames still to be banked into the jitter reserve. See `INPUT_RESERVE`.
   *
   * Counted down at join, while the player is standing at the spawn with an
   * all-zero input, which is what makes the reserve free: the ticks spent
   * building it move nobody.
   */
  inboxBanking: number;
  /** Frames thrown away because the ring was full. Should be zero; see `INPUT_QUEUE`. */
  inputOverflow: number;
  /**
   * Ticks that arrived with an empty inbox and had to re-apply the previous
   * frame -- one more step than the client ran, and therefore one correction on
   * the client's camera. The number this whole arrangement exists to hold down,
   * and `checkInputQueue` is what says how far down.
   */
  inputStarved: number;
  /**
   * **Measured** round trip, ms: the median of the last `RTT_WINDOW` protocol
   * pongs, clamped to `[0, MAX_RTT_MS]`. See `HEARTBEAT_MS` for how the samples
   * are taken and why they are taken where they are.
   *
   * This is the number spec 8.2's rewind is driven by, and it is deliberately
   * **not** `Participant.ping` -- see the `MSG.PING` case in `server/index.ts`.
   */
  rtt: number;
  /**
   * The last `RTT_WINDOW` samples, and where the next one goes. Preallocated,
   * because a per-connection ring of five doubles that never allocates is the
   * same shape as everything else on this record.
   */
  readonly rttSamples: Float64Array;
  rttCursor: number;
  /** How many pongs have ever landed. Zero means `rtt` is still the seed. */
  rttMeasured: number;
  /**
   * Pings sent and not yet answered: the nonce, and the `performance.now()` it
   * went out at. Indexed by `nonce % OUTSTANDING_PINGS`, so an old ping expires
   * by being overwritten rather than by a sweep, and the table cannot grow.
   *
   * A negative `sentAt` means the slot is spent. That is what makes a nonce
   * single-use: a client cannot bank a nonce and re-answer it later to
   * manufacture a low sample, because the second answer finds nothing.
   */
  readonly pingNonce: Uint32Array;
  readonly pingSentAt: Float64Array;
  /** Next nonce. Starts at 1; 0 is never issued, so a zeroed slot is never live. */
  pingSeq: number;
  lastSeen: number;
  /**
   * What this client can currently see. PERFORMANCE.md phase 2.
   *
   * On the connection rather than on the `Participant` deliberately: it is a
   * fact about a *socket's* view, nothing in the simulation may read it, and a
   * bot has no working set because a bot has nobody to send one to.
   */
  readonly interest: InterestSet;
}

export type Socket = {
  data: Conn;
  send(data: ArrayBuffer | Uint8Array): number;
  close(code?: number, reason?: string): void;
  /**
   * A WebSocket **protocol** ping -- RFC 6455 frame opcode 0x9, not a `MSG.PING`.
   * Bun's `ServerWebSocket` has it; see `heartbeat`.
   *
   * Optional because not every socket in this file is a socket: the check
   * harness drives a room through a loopback, and a room must not require a
   * network to be steppable.
   */
  ping?(data?: string | ArrayBuffer | Uint8Array): number;
};

/**
 * How the server measures a round trip, and why it is measured at all.
 *
 * ---------------------------------------------------------------------------
 * The hole this fills.
 *
 * `Conn.rtt` decides how far spec 8.2's rewind reaches back for this socket.
 * Until this was written **nothing assigned it**: it was seeded to 60 at
 * `newConn` and stayed there for the life of the connection, so `Room.step`'s
 * `rtt * 0.5 + INTERP_DELAY_MS` was the constant 130 ms for every player in
 * every room regardless of where they were sitting. `protocol.encodePing`
 * correctly refused to let the client's self-reported number steer the rewind
 * -- that judgement was right and stands -- but the server-side measurement it
 * promised in its place ("the server keeps its own `Conn.rtt` for that") was
 * never actually taken.
 *
 * What that costs, in the units that matter: at a real 20 ms trip the server
 * over-rewinds by 20 ms, and at 150 ms it under-rewinds by 45 ms. Two players
 * closing at a sprint apiece is 16.4 m/s of relative motion, so those are 33 cm
 * and 74 cm of target displacement -- against a 1.55 m reach-plus-cast. A swing
 * that connected on the attacker's screen missed on the server, and the further
 * you were from the host the worse it got.
 *
 * ---------------------------------------------------------------------------
 * Measured at the framing layer, not in `MSG.PING`.
 *
 * The exchange is a WebSocket **protocol** ping: the server sends opcode 0x9
 * with a four-byte nonce, and RFC 6455 s5.5.3 obliges the peer to send back
 * opcode 0xA carrying that same payload "as soon as is practical". The server
 * stamps the send, matches the nonce on return, and subtracts. Both ends of the
 * measurement are therefore held by the server, which is the entire difference
 * from the `MSG.PING` column: that number is a client's arithmetic, reported.
 *
 * The reason to prefer it over an application-level echo is that **a browser
 * answers it below the page**. The pong is emitted by the network stack; there
 * is no ping/pong surface on the `WebSocket` API at all, so page JavaScript
 * cannot see the ping, cannot delay the pong, and cannot be blocked from
 * answering by a stalled main thread. Verified rather than assumed, on Bun
 * 1.3.14 and a real browser with a page whose only script opens the socket and
 * then does nothing: five pings, five pongs, payload intact byte for byte.
 *
 * ---------------------------------------------------------------------------
 * What a hostile client can still do, and why it is not worth doing.
 *
 * A *browser* cannot influence this. A **custom client** -- something speaking
 * the WebSocket protocol directly -- can, in exactly one direction: it can sit
 * on a pong and answer late. It cannot answer early, because it cannot answer a
 * nonce it has not received yet, and it cannot re-use an old one, because a
 * nonce is spent on first use. So the estimate has a hard floor at the true
 * path and the only lie available is **upward**. That is the safe direction to
 * be attackable in, and it is worth being explicit about why:
 *
 *   - The ceiling is `MAX_REWIND_MS`. `Room.step` clamps `rtt * 0.5 +
 *     INTERP_DELAY_MS + queue` to 250 ms, so an honest 20 ms player already
 *     gets 110 ms of rewind and the most a liar can buy is the 140 ms up to the
 *     cap. Every millisecond of that is already granted, for free and honestly,
 *     to anyone playing from far enough away -- so the worst case this opens is
 *     a case the game has to be correct for anyway.
 *   - It buys **no reach**. Rewind does not extend the 1.2 m cast; it chooses
 *     which historical instant the cast is measured at. Claiming 300 ms makes
 *     the server adjudicate against where victims were 250 ms ago while the
 *     cheat's own renderer -- which interpolates at `INTERP_DELAY_MS`, 100 ms --
 *     is still drawing them 100 ms ago. Aiming at what is on screen now misses.
 *     To profit they would have to build a client that also renders 250 ms in
 *     the past, at which point they have reproduced, at some effort, the
 *     experience of having a bad connection.
 *   - It is one-sided in the victim's favour on the other axis. A large rewind
 *     is what produces the "hit from behind cover" complaint, and 250 ms is the
 *     bound the spec already accepted for that.
 *
 * The honest summary is therefore: not immune, bounded, and self-defeating.
 * Against the alternative -- letting `ping.rttMs` steer the rewind, where a
 * client sets the number to whatever it likes instantly and at no cost to its
 * own aim -- this is the difference between a lever and a number.
 *
 * One more thing the nonce table buys: a client that never answers, or answers
 * garbage, cannot grow anything. The table is a fixed four slots and an
 * unmatched pong is dropped. It keeps the seed, which is what it had before.
 *
 * ---------------------------------------------------------------------------
 * A median of five, not a low-pass.
 *
 * Both are cheap; the choice is about the *shape* of the noise. Round trips are
 * one-sidedly skewed -- the floor is the physical path and every excursion is
 * upward (a wifi retransmit, a queue, a router's coffee break). An exponential
 * average is dragged up by each of those and then takes a dozen samples to walk
 * back down, and every millisecond of that overhang is rewind the player did
 * not earn. A median of five discards up to two outliers in the window
 * *outright*: one bad sample cannot move it at all, and it is back on the true
 * value the sample after the excursion ends.
 *
 * At `HEARTBEAT_MS` the window is 2.5 s of history, and three samples -- 1.5 s
 * -- is enough to carry the median onto a new route.
 */
export const HEARTBEAT_MS = 500;

/** Samples in the window. Odd, so the median is a sample rather than a mean of two. */
export const RTT_WINDOW = 5;

/**
 * Pings that may be outstanding at once. Four is two seconds' worth, which is
 * far more than any trip this rewind would honour: a nonce still unanswered
 * when its slot comes round again described a trip past `MAX_REWIND_MS` anyway.
 */
const OUTSTANDING_PINGS = 4;

/**
 * What `rtt` is worth before the first pong lands.
 *
 * A seed and not a policy: the first ping goes out when the socket opens, so it
 * is replaced one round trip into the connection -- comfortably before the
 * `INPUT_RESERVE` has finished banking, let alone before anybody has swung a
 * bat. Nothing here has time to be felt.
 *
 * 60 ms is the value this field has held since it was written, kept because
 * there is no better guess to make about a connection nothing is yet known
 * about and it is a plausible metro round trip. Note that it no longer
 * reproduces the old server's behaviour: paired with the corrected view-time
 * expression it is 160 ms of rewind rather than the 130 ms the constant used to
 * produce. That is the point -- 130 was the wrong number, and the seed's job is
 * to be wrong for one trip rather than forever.
 */
export const DEFAULT_RTT_MS = 60;

/**
 * The ceiling on a stored round trip.
 *
 * Equal to `MAX_REWIND_MS` because `Room.step` spends the round trip **whole**
 * -- see the derivation there -- so a trip past 250 ms cannot buy a millisecond
 * of rewind that spec 10's cap would not immediately take back. Clamping here
 * as well as there costs nothing and keeps anything absurd (a suspended laptop,
 * a client sitting on a pong) out of the ring in the first place. Both bounds
 * are asserted in `checkServerRtt`.
 */
export const MAX_RTT_MS = MAX_REWIND_MS;

/** Four bytes of nonce, reused every ping. `ws.ping` copies into the frame. */
const pingScratch = new Uint8Array(4);
const pingScratchView = new DataView(pingScratch.buffer);
/** The window, copied out to be sorted. `RTT_WINDOW` elements, sorted in place. */
const medianScratch = new Float64Array(RTT_WINDOW);

/**
 * Send one protocol ping and remember when it went out.
 *
 * Called on open and then on a timer; see `server/index.ts`. A socket with no
 * `ping` -- the check harness's loopback, anything that is not a real
 * `ServerWebSocket` -- is a no-op, and keeps the seed.
 */
export function heartbeat(ws: Socket, now: number = performance.now()): void {
  if (!ws.ping) return;
  const conn = ws.data;
  // Nonces start at 1 and wrap inside u32, so a zeroed slot is never a match.
  const nonce = conn.pingSeq === 0xffffffff ? 1 : conn.pingSeq + 1;
  conn.pingSeq = nonce;
  const slot = nonce % OUTSTANDING_PINGS;
  conn.pingNonce[slot] = nonce;
  conn.pingSentAt[slot] = now;
  pingScratchView.setUint32(0, nonce, true);
  ws.ping(pingScratch);
}

/**
 * A protocol pong came back. Returns the raw sample in ms, or -1 if this pong
 * answered nothing this server asked.
 *
 * Unmatched pongs are not an error and are not rare: RFC 6455 lets a peer send
 * unsolicited pongs, and Bun's own keep-alive pings produce pongs of their own
 * that arrive here too. Every one of them fails the nonce match and is dropped,
 * which is also the property that stops a client replaying one.
 */
export function receivePong(
  conn: Conn,
  data: ArrayBuffer | Uint8Array,
  now: number = performance.now(),
): number {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength !== 4) return -1;
  const nonce = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  if (nonce === 0) return -1;
  const slot = nonce % OUTSTANDING_PINGS;
  if (conn.pingNonce[slot] !== nonce) return -1;
  const sentAt = conn.pingSentAt[slot];
  if (sentAt < 0) return -1; // already spent: a replayed nonce buys nothing
  conn.pingSentAt[slot] = -1;
  const sample = now - sentAt;
  recordRtt(conn, sample);
  return sample;
}

/**
 * Fold one round-trip sample into the estimate.
 *
 * Clamped **on the way in**, so `Conn.rtt` is inside `[0, MAX_RTT_MS]` by
 * construction rather than by a check at the point of use -- a clamp at the
 * reader is a clamp somebody adds a second reader past.
 *
 * The first sample fills the whole window rather than one slot. Without that a
 * joiner's estimate is the median of one real reading and four zeros, which is
 * zero: they would spend their first two seconds with no rewind at all, which
 * is precisely the "wild rewind on the first swing" this is here to avoid.
 */
export function recordRtt(conn: Conn, sample: number): void {
  const s = sample < 0 ? 0 : sample > MAX_RTT_MS ? MAX_RTT_MS : sample;
  if (conn.rttMeasured === 0) conn.rttSamples.fill(s);
  else conn.rttSamples[conn.rttCursor] = s;
  conn.rttCursor = (conn.rttCursor + 1) % RTT_WINDOW;
  conn.rttMeasured++;
  medianScratch.set(conn.rttSamples);
  // Insertion sort over five elements: no allocation, and shorter than the
  // comparator a `.sort()` would need.
  for (let i = 1; i < RTT_WINDOW; i++) {
    const v = medianScratch[i];
    let j = i - 1;
    while (j >= 0 && medianScratch[j] > v) {
      medianScratch[j + 1] = medianScratch[j];
      j--;
    }
    medianScratch[j + 1] = v;
  }
  conn.rtt = medianScratch[RTT_WINDOW >> 1];
}

/**
 * How many input frames a socket may have waiting, and why it is not one.
 *
 * A client runs a fixed 60 Hz step off a `requestAnimationFrame` accumulator, so
 * the *rate* it produces inputs at is exactly this room's tick rate -- but the
 * *phase* is a browser's and the delivery is a network's. A display at 30 fps
 * runs two steps in one frame and sends two frames a millisecond apart; a
 * display at 144 runs one step every second or third frame; a display at exactly
 * 60 still drifts across the tick boundary every few seconds. Every one of those
 * lands two frames inside one tick, and one slot kept the newer and destroyed
 * the older -- while acknowledging **both**, so the client dropped both from its
 * replay history and reconciled onto a position that was one whole step of
 * movement behind the one it had predicted. At 8.2 m/s that is 13.7 cm, on the
 * camera, twenty times a second on a client that is not running at exactly 60.
 *
 * Eight frames is 133 ms, which is far more headroom than any of that needs.
 * `inputOverflow` counts the times it was not enough and is expected to stay at
 * zero: overflowing means a client producing steps faster than this room runs
 * them, which no honest client does.
 */
const INPUT_QUEUE = 8;

/**
 * How many frames are held back as jitter reserve.
 *
 * With no reserve the ring is drained the tick it is filled, so an arrival that
 * lands a millisecond *after* the tick that wanted it starves that tick -- and a
 * starved tick re-applies the previous frame, which is a step the client never
 * took. One frame of reserve absorbs one tick interval of arrival jitter
 * outright, which measurement says is the whole of the distribution: the
 * excursions are one frame, never two.
 *
 * It costs one tick -- 16.7 ms -- between a key going down and this room acting
 * on it, and that price is paid by nobody the player can feel. Their own
 * movement is predicted locally and is not delayed at all; what is delayed is
 * when *other* people see it, and they already see it 100 ms in the past. The
 * one place it would have mattered is the punch, and `step` compensates the
 * rewind by exactly the number of frames still held, so a swing is adjudicated
 * against the same instant it would have been without the reserve.
 *
 * It is banked at join, over ticks where the player is standing still with an
 * all-zero input, which is what makes it free rather than a stutter.
 */
export const INPUT_RESERVE = 1;

export function newConn(room: number): Conn {
  const inbox: InputFrame[] = [];
  for (let i = 0; i < INPUT_QUEUE; i++) {
    inbox.push({ seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 });
  }
  return {
    room,
    participant: null,
    inbox,
    inboxHead: 0,
    inboxTail: 0,
    inboxCount: 0,
    inboxBanking: INPUT_RESERVE,
    inputOverflow: 0,
    inputStarved: 0,
    rtt: DEFAULT_RTT_MS,
    rttSamples: new Float64Array(RTT_WINDOW),
    rttCursor: 0,
    rttMeasured: 0,
    pingNonce: new Uint32Array(OUTSTANDING_PINGS),
    // -1 is "spent". A fresh table is entirely spent, so a pong that arrives
    // before this server has asked anything matches nothing.
    pingSentAt: new Float64Array(OUTSTANDING_PINGS).fill(-1),
    pingSeq: 0,
    lastSeen: Date.now(),
    interest: new InterestSet(),
  };
}

/**
 * File one arriving input frame. Called from the socket reader; see
 * `server/index.ts`.
 *
 * Decoded straight into the ring's own record, so a frame costs no allocation
 * and no copy -- the same property the single slot had, kept.
 *
 * A full ring drops the **oldest**, which is the only place in this file an
 * input the client stepped is ever thrown away. It is a safety valve rather than
 * a mechanism: reaching it means a client has produced 8 more steps than this
 * room has run, which a wall-clock-locked accumulator cannot do by drifting.
 */
export function receiveInput(conn: Conn, frame: ArrayBuffer): void {
  if (!decodeInput(frame, conn.inbox[conn.inboxHead])) return;
  conn.inboxHead = (conn.inboxHead + 1) % INPUT_QUEUE;
  if (conn.inboxCount === INPUT_QUEUE) {
    conn.inboxTail = (conn.inboxTail + 1) % INPUT_QUEUE;
    conn.inputOverflow++;
  } else {
    conn.inboxCount++;
  }
}

/** The oldest frame still waiting, or null. Advances the ring. */
function takeInput(conn: Conn): InputFrame | null {
  if (conn.inboxCount === 0) return null;
  const frame = conn.inbox[conn.inboxTail];
  conn.inboxTail = (conn.inboxTail + 1) % INPUT_QUEUE;
  conn.inboxCount--;
  return frame;
}

/**
 * The scoreboard's cadence: on change, plus a slow refresh for the ping column.
 *
 * Two seconds, and the number is chosen against what the message costs rather
 * than against how fresh a ping needs to be -- see `protocol.encodeRoster`,
 * which now has the 128-player arithmetic on it. A ping column two seconds stale
 * is a ping column.
 */
const ROSTER_REFRESH_TICKS = TICK_HZ * 2;
/** The police channel's, and it is the roster's exactly. See `server/index.ts`'s history. */
const INVESTIGATION_REFRESH_TICKS = TICK_HZ * 2;

/** A tick this far over budget waited on something. Bun exposes no GC hook. */
const STALL_MS = (1000 / TICK_HZ) * 4;

export interface RoomStats {
  id: number;
  players: number;
  bots: number;
  cap: number;
  open: boolean;
  tick: number;
  tickMs: { p50: number; p90: number; p99: number; max: number };
  stalls: number;
  phaseMs: Record<string, number>;
  bytesOut: number;
  snapshots: number;
  /** Frames sent divided by frames encoded. See `FrameGroups.ratio`. */
  dedup: number;
  /** Mean and worst working-set size across this room's clients. */
  interest: { mean: number; max: number };
}

export class Room {
  readonly id: number;
  readonly cap: number;
  readonly sim: Simulation;
  readonly conns = new Set<Socket>();

  private readonly out: TickOutput = { tick: 0, events: [], snapshot: null };
  private readonly snapshotScratch: SnapshotPlayer[] = [];

  // --- Interest management, phase 2.
  private readonly interest = new InterestIndex();
  private readonly groups = new FrameGroups();
  /** Per-client scratch: the ids and record indices this client is being sent. */
  private readonly setIds: number[] = [];
  private readonly setBalls: number[] = [];
  private readonly setNpcs: number[] = [];
  /** The filtered record arrays handed to the encoder. Pooled, rewritten per group. */
  private readonly subPlayers: SnapshotPlayer[] = [];
  private readonly subBalls: SnapshotBall[] = [];
  private readonly subNpcs: SnapshotNpc[] = [];
  /**
   * v10's riders, for the group currently being encoded.
   *
   * Not a member of the group key, and it does not need to be: the aboard
   * section is a strict function of the *player* set -- a rider appears in it
   * exactly when their ordinary record appears above -- so two clients with the
   * same working set have the same riders by construction and the interning in
   * `Groups` is still sound. See `protocol.ABOARD_BYTES`.
   */
  private readonly subAboard: SnapshotAboard[] = [];
  /** The enter records for one client's INTEREST frame. Pooled. */
  private readonly enterRecords: InterestEnter[] = [];
  /** One INTEREST buffer for the room: it is per client and cannot be deduped. */
  private interestPool = new ArrayBuffer(
    INTEREST_HEADER_BYTES + AOI_MAX_PLAYERS * (INTEREST_ENTER_BYTES + INTEREST_LEAVE_BYTES),
  );
  private interestView = new DataView(this.interestPool);
  private interestBytes = new Uint8Array(this.interestPool);

  // --- The investigation channel, which v8 made per client.
  private readonly investigationScratch: InvestigationRecord[] = [];
  private investigationPool = new ArrayBuffer(investigationBytes(64));
  private investigationView = new DataView(this.investigationPool);
  private investigationBytesOut = new Uint8Array(this.investigationPool);
  /** This tick's encoded investigation frames, keyed by their content hash. */
  private readonly investigationCache = new Map<number, Uint8Array>();

  // --- Cadences.
  private rosterSent = -1;
  private rosterTick = 0;
  private investigationSent = -1;
  private investigationTick = 0;

  // --- Measurement. Per room, because a host with one busy room and seven quiet
  // ones has to be able to say so.
  private readonly tickCost = new Float64Array(TICK_HZ * 20);
  private costCursor = 0;
  private ticksMeasured = 0;
  stalls = 0;
  worstTick = 0;
  bytesSent = 0;
  snapshotsSent = 0;
  /**
   * The same two totals again, for the ten-second console line.
   *
   * A **second pair of counters** rather than the console reusing the `/stats`
   * ones, and this was a measured bug rather than tidiness: both readers reset
   * what they read, so a console line landing between two `/stats` polls stole
   * that window's bytes and the harness reported a downlink that alternated
   * between 47 and 186 kbit/s on successive polls. A measurement instrument and
   * a log line must not share a counter, for the same reason `/stats` and
   * `/health` are different routes.
   */
  logBytes = 0;
  logSnapshots = 0;
  rostersSent = 0;
  encodeMs = 0;
  broadcastMs = 0;
  aoiMs = 0;
  /** Frames sent and frames encoded, since the last `/stats` read. */
  framesSent = 0;
  framesEncoded = 0;
  interestTotal = 0;
  interestSamples = 0;
  interestMax = 0;

  /**
   * Which of the three ticks in a snapshot interval this room broadcasts on.
   *
   * PERFORMANCE.md phase 4, and it was measured rather than foreseen. Every room
   * ticks on the host's one pump and every room used `tick % SNAPSHOT_INTERVAL`,
   * so **all eight rooms broadcast on the same tick** -- two ticks of nothing
   * followed by one tick carrying the entire host's egress. At 1,000 players
   * that read as a host p99 of 24.4 ms against a p50 of 3.8: not a slow
   * simulation, one tick in three doing all of the sending.
   *
   * Offsetting by `id % SNAPSHOT_INTERVAL` spreads the eight rooms over the
   * three ticks, which is free -- nobody's snapshot rate changes, nobody's
   * interval changes, and a client cannot tell which of the three its room
   * landed on. The measured effect is at the foot of PERFORMANCE.md.
   *
   * It is the room's **id** rather than its index so that the spread survives a
   * multi-process deployment: host 2's rooms are 8..15, and `8 % 3` is not
   * `0 % 3`, so two hosts on one box do not line up either.
   */
  private readonly snapshotPhase: number;

  constructor(id: number, shared: ServerWorld, cap: number, bots: number) {
    this.id = id;
    this.cap = cap;
    this.snapshotPhase = id % SNAPSHOT_INTERVAL;
    // Its own powerups, everybody else's city. See `world.roomWorld`.
    this.sim = new Simulation(roomWorld(shared));
    for (let i = 0; i < bots; i++) {
      // Named from `bots.BOT_NAMES` by index within the room, so every room has
      // a Bazza and a Shazza. That is deliberate rather than an oversight: a
      // player in room 5 has never heard of room 2's bots, and giving them
      // room-unique names would put "Bazza 5" in a kill feed for no reader's
      // benefit.
      this.sim.join(255, i % 2 === 0 ? 'aggressor' : 'pacer', botName(i));
    }
  }

  /** How many of the participants are people. Counted rather than spread. */
  humans(): number {
    let n = 0;
    for (const p of this.sim.participants.values()) if (!p.bot) n++;
    return n;
  }

  get open(): boolean {
    return this.humans() < this.cap;
  }

  /**
   * Admit a socket that has said hello, or return null if this room is full.
   *
   * The refusal is the caller's to phrase -- see `server/index.ts`, which turns
   * it into a `BYE` the client prints -- because "full" is a gateway answer and
   * this class does not know whether another room would have taken them.
   */
  join(conn: Conn, colourway: number, name: string): Participant | null {
    if (!this.open) return null;
    const p = this.sim.join(colourway, null, name);
    conn.participant = p;
    conn.interest.clear();
    return p;
  }

  /** Everything a joiner needs before its first snapshot. */
  welcome(ws: Socket, p: Participant): void {
    ws.send(
      encodeWelcome({
        version: PROTOCOL_VERSION,
        id: p.id,
        colourway: p.colourway,
        snapshotHz: SNAPSHOT_HZ,
        room: this.id,
        tick: this.sim.tick,
        x: p.combat.body.position.x,
        y: p.combat.body.position.y,
        z: p.combat.body.position.z,
        yaw: p.combat.body.yaw,
        /* **The clock the sky runs on, and this host is the only thing entitled
         * to answer it.** v11; see `protocol.PROTOCOL_VERSION`.
         *
         * Read here, on the line that sends it, rather than sampled once per
         * tick or held on the room -- so the number a joiner is handed is this
         * instant and the only error in it is how long the packet takes to
         * arrive. That is milliseconds against a one-hour cycle.
         *
         * `Date.now()` and not `sim.tick`: the tick counts 60 Hz steps since
         * this room started, so two rooms on one host have different ticks and a
         * restarted room has a tick of zero under a sun that did not move. The
         * time of day is a property of the *host*, and every room on it shows
         * the same sky. */
        clockMs: Date.now(),
      }),
    );
    // Spec 8.3's currently-taken points, so a joiner's icons match everybody
    // else's *in this room* from the first frame. Per room, which is the whole
    // reason `roomWorld` exists.
    ws.send(encodePowerups(this.sim.powerupsDown()));
    // Every lime e-bike in this room, once, with whoever is currently on one.
    ws.send(encodeBikes(this.sim.bikeRecords()));
    // The scoreboard, which is room-global and is what makes an out-of-interest
    // knockout nameable in the kill feed. Sent before anything that could refer
    // to an id, which is the rule `server/index.ts` has always had here.
    ws.send(encodeRoster(this.sim.roster()));
    // And **no** join events for everybody already here, which is where v7 built
    // the client's remotes. Under AOI a remote is created by an `INTEREST`
    // entrance and by nothing else, so a joiner is told about the handful of
    // people it can actually see on the next snapshot tick -- 50 ms later and
    // four bytes each, against v7's "here is the whole room" at a hundred and
    // twenty-eight.
    //
    // The investigation channel is likewise left to the next tick: the filter is
    // "suspects you can see, plus always your own", and a client with no working
    // set yet can see nobody. Its own is impossible on the join tick.
  }

  /** A socket closed. */
  leave(ws: Socket): void {
    this.conns.delete(ws);
    const p = ws.data.participant;
    if (p) this.sim.leave(p.id);
  }

  // --- The tick ---------------------------------------------------------------

  /**
   * One fixed step of this room, including everything it sends.
   *
   * Called R times per tick by the host's pump. The order inside is
   * `server/index.ts`'s from phase 1, unchanged, because every line of it was an
   * argument about what a client must know before what: the roster before the
   * events that name ids, the bikes before the snapshot whose `RIDING` flag they
   * explain, the interest before the snapshot whose bodies they identify.
   */
  step(): void {
    const began = performance.now();

    // Take **one** input frame from each socket, before `sim.step` so the tick
    // sees it. The ack is recorded here rather than inside the simulation
    // because "which packet did I last hear from you" is a property of the
    // connection and not of the combatant.
    //
    // One frame per tick is the contract client prediction is built on. The
    // client ran `controller.step` once for each frame it sent, so this room's
    // trajectory equals the client's if and only if it runs it once for each
    // frame too -- no more (which would be a speed hack) and no fewer (which
    // reads to the player as their own body being dragged backwards). Everything
    // in this loop is in service of that count staying equal; see `Conn.inbox`.
    for (const ws of this.conns) {
      const conn = ws.data;
      const p = conn.participant;
      if (!p) continue;

      // Bank the reserve. See `INPUT_RESERVE`: these are the only ticks that
      // deliberately leave a frame unapplied, and they happen at join, where
      // the frame being held describes somebody standing still.
      if (conn.inboxBanking > 0) {
        if (conn.inboxCount > 0) conn.inboxBanking--;
        continue;
      }

      // A starved tick is **not** repaid by skipping a later frame, and that was
      // measured rather than reasoned. Skipping one puts the two step counts
      // back in agreement, which is the tidy answer -- but the client has
      // already been reconciled onto the phantom by the snapshot in between, so
      // the skip is not a cancellation, it is a second correction in the other
      // direction. Worse, the skip spends the reserve, which starves the next
      // tick, which owes another skip: at 30 fps that loop ran the starvation
      // rate from 0.07/s to 7.25/s. The reserve alone is the fix; a debt ledger
      // on top of it is a feedback path.
      const frame = takeInput(conn);
      if (frame === null) {
        // Nothing to run. The world does not stop for one player, so the
        // previous frame is stepped again -- `p.input` is deliberately left
        // alone. That is one more step than the client took, and it is the one
        // remaining way this room can hand the reconciler a real correction.
        conn.inputStarved++;
      } else {
        p.input.forward = frame.forward;
        p.input.right = frame.right;
        p.input.yaw = frame.yaw;
        p.input.pitch = frame.pitch;
        applyButtons(p.input, frame.buttons);
        p.ackSeq = frame.seq;
      }

      // Spec 8.2's lag compensation, in ticks, clamped to spec 10's 250 ms.
      //
      // `conn.rtt` is the server's **own** measurement -- the median of the last
      // five protocol pongs, see `HEARTBEAT_MS`. It is not `p.ping`, and the two
      // must stay separate: `p.ping` is the client's arithmetic, reported, and
      // exists for the scoreboard column. A client that could set this term
      // would be choosing its own rewind budget, so it does not get to. That
      // refusal predates this line and was always right; what it was missing was
      // a measurement to refuse *in favour of*, and until there was one this
      // expression evaluated to the constant 130 ms for every player alive.
      //
      // **Plus the frames still held**, which is the reserve paying for itself.
      // The frame just applied was produced by the client `inboxCount` steps
      // before the newest one it has sent, so it describes a moment that much
      // further in the past -- and a punch on it must be rewound that much
      // further or the buffer would be a hit-registration regression. The term
      // is inside the clamp, so the 250 ms ceiling still holds.
      //
      // ---------------------------------------------------------------------
      // The **whole** round trip, not half of it, and this is the second half
      // of the same bug.
      //
      // Walk the instant a strike is resolved on, backwards, and count what is
      // between it and what the attacker was looking at when they swung:
      //
      //   1. The frame being resolved reached this room one **uplink** trip ago
      //      (plus `inboxCount`, which is the term above).
      //   2. When the client produced it, the newest snapshot it held was one
      //      **downlink** trip old.
      //   3. And it was not drawing that snapshot. `net/client.ts` renders
      //      remotes at `serverTick - INTERP_DELAY_MS`, and its `serverTick`
      //      converges on the tick of the newest snapshot **received** rather
      //      than on an estimate of this room's present -- see `onSnapshot`,
      //      where the nudge's fixed point is the arriving tick. So a further
      //      100 ms.
      //
      // Uplink plus downlink is a round trip. The textbook formula is half a
      // trip plus the interpolation delay, and it is correct for a client whose
      // clock is run *ahead* of the server by the uplink so that its render time
      // is already `server-now - interp`. This client does not do that, and the
      // rewind has to compensate the client that exists rather than the one the
      // formula was written for. `checkServerRtt` brute-forces the ideal depth
      // out of the position history and gets `rtt + interp + queue` to the tick.
      //
      // It was invisible for as long as `conn.rtt` was the constant 60: half of
      // 60 is 30, and 30 ms of over-rewind is almost exactly the shortfall a
      // 33 ms round trip produces, so the two errors cancelled for anyone
      // sitting close to the host and only the far players felt it. Correcting
      // one without the other makes the near players worse -- measured, 98% to
      // 90% -- which is why these two lines changed together.
      //
      // What this does **not** fix: above about 150 ms of round trip the ideal
      // depth passes spec 10's 250 ms cap and the clamp starts eating it, so a
      // genuinely distant player is still under-compensated. The fix for that is
      // on the client's clock rather than here, and it is not attempted; see the
      // report in `checkServerRtt`.
      const viewMs = Math.min(
        MAX_REWIND_MS,
        conn.rtt + INTERP_DELAY_MS + (conn.inboxCount * 1000) / TICK_HZ,
      );
      p.viewTicks = (viewMs / 1000) * TICK_HZ;
    }

    this.sim.step(this.out);

    this.sendRoster();
    this.sendInvestigations();
    this.sendBikes();
    this.sendEvents();
    // Offset per room, so the host's egress is spread across the three ticks in
    // a snapshot interval rather than landing on one. See `snapshotPhase`.
    if ((this.sim.tick + this.snapshotPhase) % SNAPSHOT_INTERVAL === 0) this.sendSnapshots();

    const cost = performance.now() - began;
    this.tickCost[this.costCursor] = cost;
    this.costCursor = (this.costCursor + 1) % this.tickCost.length;
    this.ticksMeasured++;
    if (cost > STALL_MS) this.stalls++;
    if (cost > this.worstTick) this.worstTick = cost;
  }

  /** Room-global, on change plus a slow refresh for the ping column. */
  private sendRoster(): void {
    const sim = this.sim;
    if (sim.rosterVersion === this.rosterSent && sim.tick - this.rosterTick < ROSTER_REFRESH_TICKS) return;
    this.rosterSent = sim.rosterVersion;
    this.rosterTick = sim.tick;
    const frame = encodeRoster(sim.roster());
    for (const ws of this.conns) {
      if (!ws.data.participant) continue;
      ws.send(frame);
      this.bytesSent += frame.byteLength;
      this.logBytes += frame.byteLength;
      this.rostersSent++;
    }
  }

  /**
   * The police channel: **per client**, filtered to suspects you can see plus
   * always your own.
   *
   * v8's change to this message, and it is the one filter in the room that is
   * not about bandwidth. A banner over a player 3 km away is not a marker, it is
   * a fact about somebody who is not on screen -- and at 128 players a room-wide
   * investigation list would put a marker on everybody being chased anywhere in
   * Sydney, which is a HUD that never clears. Your own always rides, because it
   * is the banner across your own screen and it must arrive whether or not you
   * can see yourself in a mirror.
   *
   * **The refresh fires even when nobody is wanted**, which looks like waste and
   * is the one thing that makes the client's own prediction safe: a client opens
   * its banner the instant it commits a crime it can see a witness for, and a
   * wrong prediction is only cleared by a message that contradicts it. See
   * `net/client.predictInvestigation`. So a quiet room sends a three-byte frame
   * every two seconds per client -- 12 bit/s -- and that is not a price.
   *
   * The frames are deduplicated by content: in the ordinary case (nobody wanted)
   * every client gets the identical empty frame and it is encoded once.
   */
  private sendInvestigations(): void {
    const sim = this.sim;
    const changed = sim.investigationVersion !== this.investigationSent;
    const refresh = sim.tick - this.investigationTick >= INVESTIGATION_REFRESH_TICKS;
    if (!changed && !refresh) return;
    this.investigationSent = sim.investigationVersion;
    this.investigationTick = sim.tick;

    const all = sim.investigations();
    this.investigationCache.clear();
    const need = investigationBytes(Math.max(all.length, 1));
    if (this.investigationPool.byteLength < need) {
      this.investigationPool = new ArrayBuffer(need);
      this.investigationView = new DataView(this.investigationPool);
      this.investigationBytesOut = new Uint8Array(this.investigationPool);
    }

    for (const ws of this.conns) {
      const conn = ws.data;
      const p = conn.participant;
      if (!p) continue;
      const mine = this.investigationScratch;
      mine.length = 0;
      // A content hash over the ids and countdowns, so the common case -- the
      // empty list, shared by everybody -- is one encode and N sends.
      let key = 0x811c9dc5 | 0;
      for (const r of all) {
        if (r.playerId !== p.id && !conn.interest.has(r.playerId)) continue;
        mine.push(r);
        key = Math.imul(key ^ r.playerId, 0x01000193);
        key = Math.imul(key ^ (r.reason * 65536 + r.ticks), 0x01000193);
      }
      let frame = this.investigationCache.get(key >>> 0);
      if (frame === undefined) {
        const n = encodeInvestigationsInto(this.investigationView, mine);
        // Copied out of the pool rather than aliased, because the cache outlives
        // the next client's encode. One small copy per *distinct* frame, which
        // in the ordinary case is one per two seconds for the whole room.
        frame = this.investigationBytesOut.slice(0, n);
        this.investigationCache.set(key >>> 0, frame);
      }
      ws.send(frame);
      this.bytesSent += frame.byteLength;
      this.logBytes += frame.byteLength;
    }
  }

  /**
   * The bikes, on the tick a claim or a drop happens, and only what changed.
   *
   * Room-global and deliberately not interest-filtered. The set is fixed at 74
   * for the life of the build and a delta is one 18-byte record; filtering would
   * mean a client that walked across town found bikes it had never been told
   * about, which is `protocol.encodeBikes`' own argument about why the full set
   * is sent at join. 74 records is 1.3 kB paid once against a working set's
   * 892 B paid twenty times a second.
   */
  private sendBikes(): void {
    const changed = this.sim.bikeDelta();
    if (changed.length === 0) return;
    const frame = encodeBikes(
      changed.map((b) => ({ id: b.id, rider: b.rider, x: b.x, y: b.y, z: b.z, yaw: b.yaw })),
    );
    for (const ws of this.conns) {
      if (!ws.data.participant) continue;
      ws.send(frame);
      this.bytesSent += frame.byteLength;
      this.logBytes += frame.byteLength;
    }
  }

  /** Events on the tick they happen, room-global. See this file's header table. */
  private sendEvents(): void {
    if (this.out.events.length === 0) return;
    const frame = encodeEvents(this.out.events);
    for (const ws of this.conns) {
      if (!ws.data.participant) continue;
      ws.send(frame);
      this.bytesSent += frame.byteLength;
      this.logBytes += frame.byteLength;
    }
  }

  /**
   * Spec 10's 20 Hz, per working set.
   *
   * The shape is phase 1's -- encode once, patch the ack, send a view -- with
   * "once" now meaning *once per distinct frame set* instead of once per room.
   * See `server/aoi.ts` for the clustering and for why the ack stays the only
   * per-client field.
   *
   * The aliasing hazard phase 1 closed is closed here on exactly the same
   * property of the transport: `ws.send` copies into the socket's write buffer
   * synchronously, so by the time the ack is patched for the next client in the
   * group the previous one's bytes are already gone. Nothing here holds a
   * reference to a group buffer across a line.
   */
  private sendSnapshots(): void {
    const sim = this.sim;
    let t = performance.now();
    const players = sim.snapshot(this.snapshotScratch);
    const balls = sim.ballSnapshot();
    const npcs = sim.npcSnapshot();
    const aboard = sim.aboardSnapshot();
    this.interest.begin(players, balls, npcs);
    this.groups.begin();
    this.aoiMs += performance.now() - t;

    for (const ws of this.conns) {
      const conn = ws.data;
      const p = conn.participant;
      if (!p) continue;

      t = performance.now();
      const x = p.combat.body.position.x;
      const z = p.combat.body.position.z;
      this.interest.select(x, z, conn.interest, this.setIds);
      this.interest.selectBalls(x, z, this.setBalls);
      this.interest.selectNpcs(x, z, this.setNpcs);
      const group = this.groups.intern(this.setIds, this.setBalls, this.setNpcs);
      this.aoiMs += performance.now() - t;

      // --- The delta, before the bodies it identifies.
      conn.interest.update(this.setIds);
      this.interestTotal += this.setIds.length;
      this.interestSamples++;
      if (this.setIds.length > this.interestMax) this.interestMax = this.setIds.length;
      if (conn.interest.entered.length > 0 || conn.interest.left.length > 0) {
        // Pooled records, written in place, on `Simulation.snapshot`'s terms:
        // this fires per client per snapshot in a room where anybody is walking,
        // so a fresh object per entrant is an allocation at the snapshot rate
        // times the churn -- which is exactly the shape phase 1 spent its budget
        // removing.
        const enters = this.enterRecords;
        let e = 0;
        for (const id of conn.interest.entered) {
          let rec = enters[e];
          if (rec === undefined) {
            rec = { id: 0, colourway: 0, flags: 0 };
            enters.push(rec);
          }
          const other = sim.participants.get(id);
          rec.id = id;
          rec.colourway = other?.colourway ?? 0;
          rec.flags = other
            ? (other.bot ? ENTER_FLAG.BOT : 0) | (other.combat.ridingBike !== 0 ? ENTER_FLAG.RIDING : 0)
            : 0;
          e++;
        }
        enters.length = e;
        const n = encodeInterestInto(this.interestView, enters, conn.interest.left);
        const frame = this.interestBytes.subarray(0, n);
        ws.send(frame);
        this.bytesSent += n;
        this.logBytes += n;
      }

      // --- The bodies. Encoded once per distinct set; see the header.
      t = performance.now();
      if (group.length === 0) {
        this.fill(players, balls, npcs, aboard, group.players, group.balls, group.npcs);
        group.reserve(snapshotBytes(
          this.subPlayers.length, this.subBalls.length, this.subNpcs.length, this.subAboard.length,
        ));
        group.length = encodeSnapshotInto(
          group.view, sim.tick, 0, this.subPlayers, this.subBalls, this.subNpcs, this.subAboard,
        );
        this.framesEncoded++;
      }
      this.encodeMs += performance.now() - t;

      t = performance.now();
      patchSnapshotAck(group.view, p.ackSeq);
      ws.send(group.bytes.subarray(0, group.length));
      this.broadcastMs += performance.now() - t;
      this.bytesSent += group.length;
      this.logBytes += group.length;
      this.snapshotsSent++;
      this.logSnapshots++;
      this.framesSent++;
    }
  }

  /**
   * Gather one group's records into the pooled sub-arrays the encoder reads.
   *
   * The players are looked up by id through the index's own map rather than
   * merged, because a working set is at most 40 against a room of 128 and a
   * merge would walk the room. The balls and actors are already *indices* into
   * this tick's record arrays -- a canonical labelling within the tick, which is
   * all a group that lives for one tick needs.
   */
  private fill(
    players: readonly SnapshotPlayer[],
    balls: readonly SnapshotBall[],
    npcs: readonly SnapshotNpc[],
    aboard: ReadonlyMap<number, SnapshotAboard>,
    ids: readonly number[],
    ballIdx: readonly number[],
    npcIdx: readonly number[],
  ): void {
    this.subPlayers.length = 0;
    this.subAboard.length = 0;
    for (const id of ids) {
      const slot = this.interest.slotOf(id);
      if (slot >= 0) this.subPlayers.push(players[slot]);
      // The rider record for the same id, if there is one. `aboard` is usually
      // empty and this is a map lookup per player in view, which at the 40-player
      // cap is forty misses -- against the alternative, a second interest pass.
      if (aboard.size > 0) {
        const rider = aboard.get(id);
        if (rider !== undefined) this.subAboard.push(rider);
      }
    }
    this.subBalls.length = 0;
    for (const i of ballIdx) this.subBalls.push(balls[i]);
    this.subNpcs.length = 0;
    for (const i of npcIdx) this.subNpcs.push(npcs[i]);
  }

  // --- Measurement ------------------------------------------------------------

  /** Percentiles off the 20 s ring, which is not cleared. See `/stats`. */
  private percentiles(): { p50: number; p90: number; p99: number; max: number } {
    const n = Math.min(this.ticksMeasured, this.tickCost.length);
    const sorted = Float64Array.prototype.slice.call(this.tickCost, 0, n).sort();
    const at = (q: number): number => (n === 0 ? 0 : sorted[Math.min(n - 1, Math.floor(n * q))]);
    return { p50: at(0.5), p90: at(0.9), p99: at(0.99), max: this.worstTick };
  }

  stats(ticksInWindow: number): RoomStats {
    const humans = this.humans();
    const phases: Record<string, number> = {};
    for (const [k, v] of Object.entries(this.sim.phaseMs)) phases[k] = v / ticksInWindow;
    phases.aoi = this.aoiMs / ticksInWindow;
    phases.encode = this.encodeMs / ticksInWindow;
    phases.broadcast = this.broadcastMs / ticksInWindow;
    return {
      id: this.id,
      players: humans,
      bots: this.sim.participants.size - humans,
      cap: this.cap,
      open: this.open,
      tick: this.sim.tick,
      tickMs: this.percentiles(),
      stalls: this.stalls,
      phaseMs: phases,
      bytesOut: this.bytesSent,
      snapshots: this.snapshotsSent,
      dedup: this.framesEncoded === 0 ? 1 : this.framesSent / this.framesEncoded,
      interest: {
        mean: this.interestSamples === 0 ? 0 : this.interestTotal / this.interestSamples,
        max: this.interestMax,
      },
    };
  }

  /** Called by `/stats` after a read, so each poll covers a disjoint window. */
  resetWindow(): void {
    for (const k of Object.keys(this.sim.phaseMs)) (this.sim.phaseMs as Record<string, number>)[k] = 0;
    this.aoiMs = 0;
    this.encodeMs = 0;
    this.broadcastMs = 0;
    this.bytesSent = 0;
    this.snapshotsSent = 0;
    this.rostersSent = 0;
    this.stalls = 0;
    this.worstTick = 0;
    this.framesSent = 0;
    this.framesEncoded = 0;
    this.interestTotal = 0;
    this.interestSamples = 0;
    this.interestMax = 0;
  }
}

/**
 * R rooms in one process, sharing one loaded city.
 *
 * The gateway's data model: `/rooms` is this object's `listing()`, and a join
 * with no room named picks `leastFull()`. Both are deliberately trivial --
 * there is no matchmaking here beyond "the emptiest room that will have you",
 * because a brawler's matchmaking *is* "put people together".
 */
export class RoomHost {
  readonly rooms: Room[] = [];
  readonly world: ServerWorld;

  constructor(world: ServerWorld, count: number, cap: number, bots: number, firstRoom = 0) {
    this.world = world;
    for (let i = 0; i < count; i++) this.rooms.push(new Room(firstRoom + i, world, cap, bots));
  }

  get(id: number): Room | undefined {
    return this.rooms.find((r) => r.id === id);
  }

  /**
   * The emptiest room that is still open, or null if the host is full.
   *
   * **Emptiest rather than fullest**, which is the opposite of what a
   * matchmaker that wanted full games would do, and is right here for a reason
   * specific to this architecture: a room is 128 and interest management means
   * a player only ever sees forty of them, so packing a room to its cap buys
   * nobody a better game and costs everybody in it the CBD-pileup bandwidth.
   * Spreading also keeps every room's tick under budget, which is what makes
   * the host's p99 the *host's* rather than one unlucky room's.
   */
  leastFull(): Room | null {
    let best: Room | null = null;
    let bestN = Infinity;
    for (const room of this.rooms) {
      if (!room.open) continue;
      const n = room.humans();
      if (n < bestN) {
        bestN = n;
        best = room;
      }
    }
    return best;
  }

  /** `GET /rooms`, as JSON. The whole of the gateway protocol. */
  listing(): Array<{ id: number; players: number; cap: number; open: boolean }> {
    return this.rooms.map((r) => ({ id: r.id, players: r.humans(), cap: r.cap, open: r.open }));
  }

  step(): void {
    // The world's residency first, and host-wide rather than per room, because
    // the rooms share one `CollisionWorld` and one pair of lane fields by
    // reference: what has to be resident is the union of what everybody on this
    // host needs, and a room stepping against a hexagon another room's players
    // had just evicted is the failure this ordering rules out. See
    // `world.HexResidency` and `roomWorld`.
    //
    // It is also what makes the lane fields safe to mutate at all. `TrafficField`
    // and `PedestrianField` are queried from inside a room's tick; a residency
    // that adopted or dropped a tile *between* two of a room's own queries would
    // give that room two different cities inside one tick. This is the only
    // place either field changes, and it is between rooms rather than inside
    // one.
    //
    // Before the rooms rather than after, so a hexagon started this tick has the
    // whole of the tick's slack to read in. Nothing here blocks: `update` starts
    // reads and forgets them, and spends at most `APPLY_BUDGET_MS` decoding what
    // earlier ticks read.
    const segments = this.world.segments;
    if (segments !== undefined) segments.update(this.occupants());
    for (const room of this.rooms) room.step();
  }

  /**
   * Where everybody on this host is, as flat `x, z` pairs.
   *
   * Bots included, and that is not a nicety: a bot is a participant that walks
   * the city and is resolved against the prisms exactly as a player is, so a
   * hexagon with only bots in it is a hexagon whose collision has to be there.
   *
   * Into a reused array, because this runs at 60 Hz and a fresh 200-element
   * array a tick is the kind of allocation PERFORMANCE.md phase 1 spent a round
   * removing.
   */
  occupants(out: number[] = this.occupantScratch): number[] {
    out.length = 0;
    for (const room of this.rooms) {
      for (const p of room.sim.participants.values()) {
        const at = p.combat.body.position;
        out.push(at.x, at.z);
      }
    }
    return out;
  }

  private readonly occupantScratch: number[] = [];

  players(): number {
    let n = 0;
    for (const room of this.rooms) n += room.humans();
    return n;
  }
}
