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
   * The latest input, decoded straight into a record owned by this socket.
   *
   * PERFORMANCE.md phase 1. See the original note in `server/index.ts`'s history:
   * this is the *latest* input rather than a queue, because replaying three
   * bunched packets on one tick hands a speed hack to whoever has the worst
   * connection.
   */
  readonly input: InputFrame;
  hasInput: boolean;
  /** Smoothed round trip, ms. Seeded pessimistically so an early punch is not over-rewound. */
  rtt: number;
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
};

export function newConn(room: number): Conn {
  return {
    room,
    participant: null,
    input: { seq: 0, buttons: 0, forward: 0, right: 0, yaw: 0, pitch: 0 },
    hasInput: false,
    rtt: 60,
    lastSeen: Date.now(),
    interest: new InterestSet(),
  };
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

    // Apply the newest input from each socket, before `sim.step` so the tick
    // sees it. The ack is recorded here rather than inside the simulation
    // because "which packet did I last hear from you" is a property of the
    // connection and not of the combatant.
    for (const ws of this.conns) {
      const conn = ws.data;
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
      // Spec 8.2's lag compensation, in ticks, clamped to spec 10's 250 ms.
      const viewMs = Math.min(MAX_REWIND_MS, conn.rtt * 0.5 + INTERP_DELAY_MS);
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
        this.fill(players, balls, npcs, group.players, group.balls, group.npcs);
        group.reserve(snapshotBytes(this.subPlayers.length, this.subBalls.length, this.subNpcs.length));
        group.length = encodeSnapshotInto(
          group.view, sim.tick, 0, this.subPlayers, this.subBalls, this.subNpcs,
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
    ids: readonly number[],
    ballIdx: readonly number[],
    npcIdx: readonly number[],
  ): void {
    this.subPlayers.length = 0;
    for (const id of ids) {
      const slot = this.interest.slotOf(id);
      if (slot >= 0) this.subPlayers.push(players[slot]);
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
    for (const room of this.rooms) room.step();
  }

  players(): number {
    let n = 0;
    for (const room of this.rooms) n += room.humans();
    return n;
  }
}
