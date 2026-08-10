/**
 * The client half of spec 10: prediction, reconciliation and interpolation.
 *
 * Three jobs, and they are three different answers to the same question --
 * *"where is everybody, given that I found out 30 ms ago?"*
 *
 *   - **The local player is predicted.** The browser keeps running
 *     `combat.advance` and `controller.step` exactly as it does offline, on the
 *     same fixed step, so pressing W moves you on the next frame rather than on
 *     the next round trip. Every input is tagged with a sequence number and kept
 *     until the server says it has applied it.
 *   - **The local player is reconciled.** When a snapshot arrives it carries the
 *     last input seq the server acted on. The client rewinds its own body to the
 *     authoritative position for that seq and **replays every input since**,
 *     which is possible only because `controller.step` is a pure function of
 *     state plus input -- the property that file's header has been asserting
 *     since the day it was written, for exactly this day.
 *   - **Remotes are interpolated.** They are drawn 100 ms in the past (spec 10),
 *     between the two snapshots that bracket that moment. Never extrapolated:
 *     see `remoteAt`.
 *
 * ---------------------------------------------------------------------------
 * Offline is not a fallback, it is the same code with this object absent.
 *
 * `main.ts` holds a `NetClient | null`. Null, or connecting, or dropped, and the
 * game is what it was before this pass existed: local dummies, local combat,
 * local powerups, no change to a single line of the loop. That is not
 * defensiveness -- it is that spec 9's local stub is still the only way to work
 * on the punch without a server running, and a build where offline had quietly
 * rotted would be a build where nobody could.
 *
 * ---------------------------------------------------------------------------
 * What is corrected, what is predicted, and what is simply told.
 *
 * The snapshot carries 21 bytes per player and deliberately does not carry
 * velocity, phase timers or powerup clocks -- see `protocol.ts` for the
 * bandwidth arithmetic. So the reconciliation is not "copy the server's state",
 * it is a three-way split, and each part is in the category it is in for a
 * reason:
 *
 *   **Predicted and reconciled** -- position, velocity, yaw, pitch, ground
 *   contact, and the punch phase machine. These are functions of my own input,
 *   so my prediction is right except for things I could not know about.
 *
 *   **Told, and adopted outright** -- health, stamina, balls left, and which
 *   powerups are running. All four are consequences of what *other* people did,
 *   none is smoothable (there is no half a pip), and a client that predicted
 *   them would be guessing.
 *
 *   **Told, and adopted only on a transition** -- flinch and knockout. The
 *   client cannot predict being punched, and it also must not restart the 300 ms
 *   lockout every snapshot for the whole time it is running: `phaseT` is not on
 *   the wire, so adopting the phase repeatedly would extend a flinch to as long
 *   as the server kept reporting it. Adopting it once, on the edge, is right to
 *   within one snapshot interval.
 *
 * ---------------------------------------------------------------------------
 * The one case a position correction cannot smooth, and what is done instead.
 *
 * Ordinary corrections are centimetres and are eased out over 80 ms so the
 * camera never jumps. A **knockback** is not ordinary: the server throws a
 * victim at 11 m/s and the client, which did not see the punch coming, predicted
 * a stationary body. The error is metres within two snapshots.
 *
 * Easing that out would drag the camera through a six-metre arc at a 20 Hz
 * stutter. Snapping it fixes the position and not the *motion*, so the next
 * frame the local prediction is standing still again at the new spot and the
 * snap repeats. What actually works is to take the velocity from the server's
 * own two most recent positions -- `(p1 - p0) / snapshotDt`, which is the flight
 * velocity by definition -- and hand it to the local integrator, which then
 * flies the rest of the arc itself through the same gravity and friction the
 * server is using. One divide, and it is the difference between a knockback that
 * reads as a punch and one that reads as a bad connection.
 */

import { Vector3 } from 'three/webgpu';

import {
  advance,
  createCombatant,
  respawnAt,
  type CombatInput,
  type CombatWorld,
  type CombatantState,
} from '../game/combat.ts';
import { applyPowerup, type PowerupKind } from '../game/powerups.ts';
import { BikeField, shapeRideInput } from '../game/bikes.ts';
import { EYE_HEIGHT, step, type InputSnapshot, type PlayerState } from '../player/controller.ts';
import {
  ANIM,
  BTN,
  ENTER_FLAG,
  EVENT,
  EVENT_FLAG,
  FLAG,
  INTERP_DELAY_MS,
  MSG,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  TICK_HZ,
  WebSocketTransport,
  createSnapshot,
  decodeBikes,
  decodeBye,
  decodeEvents,
  decodeInterest,
  decodeInvestigations,
  decodePowerups,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeHello,
  encodeInput,
  encodeEvents,
  encodeInterest,
  encodeInvestigations,
  encodePing,
  encodeRoster,
  encodeSnapshot,
  decodePong,
  frameType,
  rankRoster,
  type InvestigationRecord,
  type NetTransport,
  type RosterEntry,
  chooseRoom,
  type RoomInfo as RoomInfoShape,
  type Snapshot,
  type SnapshotBall,
  type SnapshotNpc,
  type SnapshotPlayer,
} from './protocol.ts';
import { decodeChatLine, encodeChatSay, sanitiseChat, type ChatLine } from './chat.ts';
import {
  decodeSuggestAck,
  decodeSuggestionList,
  encodeSuggestList,
  encodeSuggestSubmit,
  encodeSuggestVote,
  type SuggestionList,
} from './suggestions.ts';
import { NPC_STATE, type NpcActor } from '../game/factions.ts';

const FIXED_DT = 1 / TICK_HZ;

/** How many unacknowledged inputs are kept. 2 s of them, which is 30x a LAN trip. */
const INPUT_HISTORY = 128;

/** Snapshots held for interpolation. 1.5 s at 20 Hz -- far more than the 100 ms buffer needs. */
const SNAPSHOT_HISTORY = 30;

/**
 * A correction under this is not worth doing anything about, metres.
 *
 * Exported because it is the honest bound for "did the two ends agree": this is
 * the reconciler's own statement of what is not worth telling the camera, so a
 * check that asserts a predicted body never left it is asserting agreement in
 * the units the file itself uses. `server/integration-check.ts`'s
 * `checkInputQueue` is that check, and it exists because they once did not.
 */
export const CORRECTION_DEADZONE = 0.02;

/** Over this, snap and take the server's velocity. See the header. */
export const CORRECTION_SNAP = 2.0;

/** Time constant of the eased correction, seconds. Spec 10's "smoothing on correction". */
const CORRECTION_TAU = 0.08;

/**
 * How many reconciled snapshots after `/unstuck` a teleport is still expected.
 *
 * A hundred, which at the 20 Hz snapshot rate is five seconds *of play* -- about
 * fifty times the round trip this game runs over, and generous enough for a host
 * that took a couple of frames to get to the road search. Counted in snapshots
 * rather than milliseconds so a throttled or hidden tab does not spend the
 * window without ever looking at one; see `teleportArmed`.
 *
 * Being generous costs nothing, because `TELEPORT_MIN_M` is what actually
 * decides.
 */
const TELEPORT_ARM_SNAPSHOTS = 100;

/**
 * How far the server's own position must jump for it to be a teleport, metres.
 *
 * Twenty metres between consecutive snapshots is 400 m/s at 20 Hz. The hardest
 * thing in this game is a car knockback at `CAR_KNOCKBACK_HORIZONTAL` (10.5 m/s)
 * and the fastest is a tuned bike at 26 m/s, so the gap between "legitimate
 * motion" and this threshold is more than an order of magnitude -- which is what
 * makes it safe to leave the arming window open for five seconds.
 */
const TELEPORT_MIN_M = 20;

/**
 * Twice a second, on a **timer** rather than on the animation frame.
 *
 * This is the one thing in this file that must not be driven by `update()`, and
 * the reason is the deliverable: two browser windows on one machine, one of
 * which is not the focused one. A browser stops issuing animation frames to a
 * hidden tab entirely and throttles a backgrounded one to about 1 Hz -- so a
 * ping on the render loop stops when the window does, the server sees a silent
 * socket, and its stale sweep closes a connection whose player is standing right
 * there. A timer is throttled to 1 Hz in the same situation and never stops,
 * which is enough to hold the socket open and enough to keep the clock estimate
 * roughly current until the window comes back.
 */
const PING_INTERVAL_MS = 500;

export type NetStatus = 'offline' | 'connecting' | 'online' | 'refused';

/** One remote player, as the client draws them. */
export interface RemotePlayer {
  readonly id: number;
  colourway: number;
  bot: boolean;
  /** Interpolated, in world metres. This is the **eye**, as `PlayerState.position` is. */
  readonly position: Vector3;
  yaw: number;
  pitch: number;
  anim: number;
  health: number;
  /** Derived from the interpolated position delta. Drives the stride. */
  speed: number;
  onGround: boolean;
  /** Inside the throw animation's window. Fires the overlay on its **rising edge**. */
  throwing: boolean;
  /** Balls left in their bar. Decides whether one is drawn in their off hand. */
  ballCharges: number;
  /**
   * On a lime e-bike. Drives their seated pose and the bike drawn under them.
   *
   * A flag rather than a bike id, because the drawing side does not need one:
   * a ridden bike is at its rider, and its rider is this record. The *id*
   * matters only to the field of parked bikes, which gets it from `MSG.BIKES`.
   */
  riding: boolean;
  /** True while no snapshot has arrived for them yet. */
  fresh: boolean;
}

/**
 * One football in the air, as the client draws it.
 *
 * Interpolated on exactly the same clock the bodies are -- 100 ms in the past --
 * and that is the whole reason it is in this file rather than being simulated
 * locally from a throw event. A ball drawn at *present* time would leave a
 * thrower's hand three and a half metres in front of them, because the thrower
 * is drawn where they were 100 ms ago and the ball would be where it is now. The
 * two have to be on one clock or the release does not read as a release.
 *
 * The local player's own throws are the deliberate exception and they are not
 * here: `main.ts` simulates those in this process from the same shared
 * `game/footy.ts` the server runs, so its own ball leaves its own hand on the
 * frame the button goes down. There is no handoff between the two and no id
 * matching, because the authoritative copy of your own ball is simply never
 * drawn -- see `ownBall` below. The two simulations start from the same state
 * and run the same arithmetic, so they agree to within the quantisation of the
 * yaw they were aimed with, which over a 30 m throw is about three millimetres.
 */
export interface RemoteBall {
  id: number;
  thrower: number;
  readonly position: Vector3;
  readonly velocity: Vector3;
  bounces: number;
  /** Seconds since this client first saw it. Drives the cosmetic tumble. */
  age: number;
  /**
   * The frame this ball was last present in a snapshot, for the sweep below.
   *
   * A stamp on the record rather than a `Set` rebuilt every frame, which is
   * `collision.Prism.seen`'s own trick one object down: an integer compare on a
   * field already in cache, against an allocation per frame forever.
   */
  seen: number;
}

/** What `main.ts` needs to react to. Presentation, exactly as the offline path's is. */
export interface NetHandlers {
  onHit(attacker: number, victim: number, ko: boolean, footy: boolean, health: number): void;
  /** A ball bounced. `bounces` is which one, so the caller can vary the thud. */
  onBounce(x: number, y: number, z: number, bounces: number): void;
  onPickup(combatant: number, kind: PowerupKind, tileKey: string, index: number): void;
  onJoin(id: number, colourway: number, bot: boolean): void;
  /**
   * Somebody **left the game**. A kill feed line, and a rig to release.
   *
   * Distinct from `onDrop` below, and protocol v8 is what made the distinction
   * necessary. Before interest management the only way to stop being drawn was
   * to disconnect, so one callback did both jobs. Now a remote stops being drawn
   * every time somebody walks two hundred metres away, and a feed that said
   * "Bazza left" each time would be a feed of nothing but departures.
   */
  onLeave(id: number): void;
  /**
   * Somebody **went out of view**. Release the rig; say nothing.
   *
   * PERFORMANCE.md phase 2. The caller must dispose exactly what `onLeave`
   * disposes -- the actor, its props, its bike, its nameplate -- because the
   * memory question is identical and only the *narration* differs. A client
   * walking across the CBD will fire this hundreds of times a session, so a
   * handler that leaked would leak at walking pace.
   */
  onDrop(id: number): void;
  onStatus(status: NetStatus, detail: string): void;
  /**
   * Somebody said something, anywhere on the host. See `net/chat.ts`.
   *
   * **Optional**, unlike every other member here, and that is deliberate rather
   * than lazy: the six above are all things a renderer must react to or leak --
   * a rig, a feed line, a status. A chat line is *text*, and a caller that has
   * no chat log (a headless probe, a check) should not have to supply an empty
   * function to prove it. The dispatch below is `?.`-guarded accordingly.
   *
   * The line arrives with the sender's name already on it rather than an id to
   * look up, because chat crosses rooms and this client's roster is its own
   * room's -- see `chat.encodeChatLine`.
   */
  onChat?(line: ChatLine): void;
  /**
   * The ranked suggestion list arrived, with this client's own standing in it.
   *
   * Optional like `onChat` and for the same reason: a headless probe and the
   * integration check have no panel, and a handler set that forced them to
   * supply an empty function for every feature would grow a line per feature
   * forever.
   */
  onSuggestions?(list: SuggestionList): void;
  /** Yes / no / not this week, with the server's own sentence. */
  onSuggestAck?(result: number, issue: number, message: string): void;
}

interface PendingInput {
  seq: number;
  /** A copy: `main.ts` owns and mutates its own input record every frame. */
  input: CombatInput;
  /**
   * The body's velocity **after** this input was integrated, m/s.
   *
   * Three numbers rather than a `Vector3` because this record is pushed sixty
   * times a second and read a handful of times a second; the copy of the input
   * beside it is already the allocation this queue pays for, and a second object
   * per frame to hold three floats would be a second one for no gain.
   *
   * *After* is the whole of the contract -- see `sendInput`, which states it, and
   * `reconcile`, which depends on it. Storing the *pre*-step velocity here would
   * seed every replay one step early and reintroduce this bug with the sign
   * flipped.
   */
  vx: number;
  vy: number;
  vz: number;
}

interface TimedSnapshot {
  tick: number;
  players: SnapshotPlayer[];
  balls: SnapshotBall[];
  npcs: SnapshotNpc[];
  /** `performance.now()` when it arrived. The jitter buffer's clock. */
  at: number;
}

export class NetClient {
  private readonly transport: NetTransport;
  private readonly handlers: NetHandlers;

  status: NetStatus = 'connecting';
  statusDetail = '';

  /** Assigned by the server's WELCOME. 0 until then. */
  id = 0;
  colourway = 0;
  /**
   * Which room this client landed in, from the WELCOME. -1 until then.
   *
   * Read rather than assumed from the URL, because a client that names no room
   * is put in the least-full open one by the gateway -- see `server/index.ts` --
   * so this is the only place the answer is known. What it is for is the invite
   * link: `?room=<this>` is how a friend joins the same game.
   */
  room = -1;

  /** Smoothed round trip, ms, and the count behind it. */
  rtt = 0;
  private pingSeq = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** The remotes, keyed by id, in the order the client heard about them. */
  readonly remotes = new Map<number, RemotePlayer>();

  /**
   * The scoreboard, as the server last sent it. Replaced wholesale.
   *
   * Unsorted, in the server's own id order, because the order the *board* is
   * drawn in is `rankRoster`'s and re-sorting on arrival would throw away the
   * only thing this array is otherwise good for -- being compared against the
   * last one to see whether anything moved.
   */
  roster: readonly RosterEntry[] = [];

  /**
   * Every name this client has ever been told, id to name.
   *
   * Separate from `roster` and **only ever added to**, which is not redundancy:
   * `roster` is replaced by each refresh, and the one moment the kill feed needs
   * a name is the moment somebody stops being on it. A player who is knocked out
   * and disconnects in the same second is gone from the next roster and still
   * has to be nameable in the line that says they left. Pruned only when it gets
   * silly -- see `rememberNames`.
   */
  private readonly names = new Map<number, string>();

  /** What to call a combatant in the kill feed. Falls back to the id nobody wants to read. */
  nameOf(id: number): string {
    return this.names.get(id) ?? `player ${id}`;
  }

  /** The local player's own name, as the server actually assigned it. */
  get myName(): string {
    return this.names.get(this.id) ?? '';
  }

  /** The board, in the order it is drawn. See `protocol.rankRoster`. */
  leaderboard(): RosterEntry[] {
    return rankRoster(this.roster);
  }

  /**
   * Every football in the air that this client draws, keyed by the server's id.
   *
   * Rebuilt from the interpolation pair each frame rather than accumulated, so a
   * ball that dies -- by hitting somebody, by bouncing out its budget, by going
   * into the harbour -- simply stops being in the snapshot and stops being
   * drawn. There is no death message and none is needed, which is the whole
   * argument for a projectile being *state* rather than an event: see
   * `protocol.EVENT`, where the beam's event is a retired hole.
   */
  readonly balls = new Map<number, RemoteBall>();

  /**
   * Every promoted faction actor the server is reporting, keyed by its id.
   *
   * A mirror and nothing else. `game/factions.ts`'s `think` never runs on a
   * connected client -- the server owns every decision an officer makes -- so
   * this side holds the same record type with the authority half of its fields
   * left at their defaults. `main.ts` draws out of this map online and out of
   * its own `FactionField.actors` offline, and the renderer cannot tell which.
   */
  readonly actors = new Map<number, NpcActor>();

  /**
   * Who the police are after, keyed by player id, as the server last said.
   *
   * The countdown in here is **run down locally between messages** and taken
   * from the server whenever one arrives, which is the powerup respawns' own
   * arrangement and is what lets this message ride the slow refresh instead of
   * the snapshot rate. See `protocol.encodeInvestigations`.
   */
  private readonly investigations = new Map<number, InvestigationRecord>();

  /** This client's own investigation, or null. What `main.ts` draws the banner from. */
  get investigation(): { reason: number; seconds: number } | null {
    const mine = this.investigations.get(this.id);
    if (!mine || mine.ticks <= 0) return null;
    return { reason: mine.reason, seconds: mine.ticks / TICK_HZ };
  }

  /** Anybody's, for the optional marker over a suspect. */
  investigationOf(playerId: number): { reason: number; seconds: number } | null {
    const it = this.investigations.get(playerId);
    if (!it || it.ticks <= 0) return null;
    return { reason: it.reason, seconds: it.ticks / TICK_HZ };
  }

  /**
   * Open a banner *before* the server has confirmed it. See the header on what
   * is predicted and what is told.
   *
   * `main.ts` calls this on the frame it commits a crime it can see a witness
   * for. The record it writes is indistinguishable from a real one and is
   * overwritten by the next `MSG.INVESTIGATION` either way -- which is the whole
   * safety of it: a wrong prediction is a banner that clears itself within
   * 50 ms, and a right one is a banner that appeared when the bat connected
   * rather than a third of a second later.
   *
   * It deliberately does **not** extend an investigation that is already
   * running: stacking is the server's arithmetic (`FactionField.accuse` caps
   * it), and a client that added its own 15 s would draw a countdown that
   * visibly jumped backwards when the truth arrived.
   */
  predictInvestigation(reason: number, ticks: number): void {
    if (!this.id) return;
    const existing = this.investigations.get(this.id);
    if (existing) {
      existing.reason = reason;
      return;
    }
    this.investigations.set(this.id, { playerId: this.id, reason, ticks });
  }

  /** Run every countdown down by one tick's worth of frame. Called from `update`. */
  private tickInvestigations(dt: number): void {
    if (this.investigations.size === 0) return;
    const spent = dt * TICK_HZ;
    for (const [id, it] of this.investigations) {
      it.ticks -= spent;
      if (it.ticks <= 0) this.investigations.delete(id);
    }
  }

  /**
   * The local player's id as it appears on a ball's `thrower` field.
   *
   * Balls this client threw are **not drawn from the snapshot**, because
   * `main.ts` is already drawing its own predicted copy of them at present time
   * and the authoritative one is 100 ms behind it. Drawing both is two balls;
   * drawing only the authoritative one puts a third of a second of lag between
   * the click and the ball leaving your hand. See `RemoteBall`.
   */
  private ownBall(thrower: number): boolean {
    return thrower === this.id;
  }

  private readonly pending: PendingInput[] = [];
  private seq = 0;

  private readonly snapshots: TimedSnapshot[] = [];
  private readonly scratchSnapshot: Snapshot = createSnapshot();
  /**
   * The server tick the client believes is current, advanced locally between
   * snapshots and nudged toward the truth as they arrive.
   *
   * Not a raw copy of the last snapshot's tick: that number steps by three
   * twenty times a second, so interpolating against it directly would make
   * remotes advance in 50 ms hops. This runs continuously at 60 ticks a second
   * and is corrected by a fraction of the error each frame, which is a phase-
   * locked loop in four lines and is what keeps the interpolation smooth across
   * a jittery arrival time.
   */
  private serverTick = 0;
  private tickSynced = false;

  /** The eased position correction still owed to the camera, metres. */
  private readonly correction = new Vector3();

  /**
   * The velocity the body had at the moment the server's latest position is a
   * picture of, m/s -- the seed the replay in `reconcile` starts from.
   *
   * ---------------------------------------------------------------------------
   * ## Why this is not simply `local.body.velocity`
   *
   * The replay rewinds to the acknowledged position, which is `pending.length`
   * inputs in the past, and then runs forward. It used the *current* velocity to
   * start from, because velocity is not on the wire and that was the only number
   * to hand. At a steady speed the two are the same number and it cost nothing:
   * the residual was 0.4 mm, which is the wire's own millimetre quantisation.
   *
   * On an **acceleration ramp** they are not the same number. Starting to run,
   * stopping, and every jump moves the body's speed by up to `ACCELERATION`
   * (48 m/s^2) per step, so the current velocity is metres per second faster
   * than the velocity the body actually had at the acknowledged moment, and the
   * replay accelerates from the wrong starting speed for its whole length. The
   * error is `dv * n * dt` and grows with the round trip because `n` does:
   * measured at 6 cm on a loopback and **a full metre at 200 ms**, every time
   * the player starts moving or leaves the ground. That is the camera jitter on
   * acceleration, and it is the last of the three causes.
   *
   * So the client reconstructs its own past instead of guessing at it. Nothing
   * new is believed from anybody and nothing new is on the wire -- `sendInput`
   * already keeps a copy of every unacknowledged input, and this is one more
   * field on the record it already keeps. The seed is the velocity stored
   * against the most recently acknowledged input, which by that method's
   * ordering contract is the velocity *after* the server's own acknowledged
   * step.
   */
  private readonly ackedVelocity = new Vector3();
  /**
   * False until an acknowledgement has supplied one, and after any path that
   * throws the recorded history away. `local.body.velocity` is the fallback,
   * which is what every replay used before this field existed.
   */
  private ackedVelocityKnown = false;

  /** The two most recent authoritative positions for the local player. See the header. */
  private readonly lastServerPos = new Vector3();
  private lastServerTick = -1;

  /** Reconciliation scratch: a body to replay into, allocated once. */
  private readonly replayBody: PlayerState = {
    position: new Vector3(),
    velocity: new Vector3(),
    onGround: true,
    yaw: 0,
    pitch: 0,
  };
  private readonly replayInput: InputSnapshot = {
    forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1,
  };

  /** Diagnostics for the HUD's connection line. */
  corrections = 0;
  snaps = 0;
  lastCorrection = 0;
  private lastPhase = 'idle';

  /**
   * What this client asked to be called.
   *
   * Kept only to send in the hello. What the player *is* called is `myName`,
   * which comes back in the roster and can differ -- the server sanitises again
   * and dedupes, so the second Bazza of the session finds out here.
   */
  private readonly wantedName: string;

  /**
   * This browser's vote identity, or the empty string if it has none.
   *
   * Handed in rather than minted here. It lives in `localStorage` beside
   * `sydney.name` (see `suggestions.clientId`) and the net layer only carries
   * it, which is what keeps one identity per browser rather than one per
   * `NetClient` -- a distinction that matters because this object is
   * reconstructed on a reconnect and a vote identity must not be.
   *
   * It is **a claim and not proof**, and `net/suggestions.ts`'s header is honest
   * about how far that goes. Nothing else in this client reads it.
   */
  private readonly clientId: string;

  constructor(
    url: string,
    handlers: NetHandlers,
    options: { name?: string; transport?: NetTransport; clientId?: string } = {},
  ) {
    this.handlers = handlers;
    this.wantedName = options.name ?? '';
    this.clientId = options.clientId ?? '';
    // Injectable so the integration harness and any future WebTransport class
    // can be dropped in without this file knowing. See `protocol.NetTransport`.
    this.transport = options.transport ?? new WebSocketTransport(url);
    this.transport.onopen = () => {
      // 255 asks the server to choose a kit. See `protocol.encodeHello`: two
      // players in the same singlet defeats the whole reason there are seven.
      // The name is a request on exactly the same terms.
      this.transport.send(encodeHello(255, this.wantedName));
    };
    this.transport.onframe = (frame) => this.receive(frame);
    this.transport.onclose = (reason) => {
      if (this.status !== 'refused') this.setStatus('offline', reason);
      this.stopPinging();
    };
    this.pingTimer = setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  private ping(): void {
    if (this.status !== 'online') return;
    this.pingSeq = (this.pingSeq + 1) >>> 0;
    // The round trip goes up with the ping that will measure the next one. The
    // server cannot measure this itself -- it holds no outstanding-ping table
    // and this timer is independent of the reply -- and it is wanted for one
    // column of a scoreboard. See `protocol.encodePing` for what that costs and
    // for the one thing it is deliberately not wired to.
    this.transport.send(encodePing(this.pingSeq, performance.now(), this.rtt));
  }

  private stopPinging(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  close(): void {
    this.stopPinging();
    this.transport.close();
  }

  /**
   * Called once, the first time the connection resolves either way.
   *
   * `main.ts` awaits it to decide whether to spawn spec 9's local dummies, and
   * it fires exactly once because that decision is made exactly once: a
   * connection that drops five minutes later leaves the player in an empty city,
   * which is right -- the alternative is three dummies materialising around them
   * mid-fight.
   */
  onSettled: (() => void) | null = null;

  private setStatus(status: NetStatus, detail: string): void {
    if (this.status === status && this.statusDetail === detail) return;
    this.status = status;
    this.statusDetail = detail;
    this.handlers.onStatus(status, detail);
    if (status !== 'connecting' && this.onSettled) {
      const settled = this.onSettled;
      this.onSettled = null;
      settled();
    }
  }

  // --- Sending ----------------------------------------------------------------

  /**
   * Called once per fixed step, from `main.ts`'s own simulation loop.
   *
   * The input is copied rather than referenced because `main.ts` mutates one
   * record every frame -- and the whole reconciliation depends on being able to
   * replay the inputs *as they were*, not as the newest one happens to be.
   *
   * ---------------------------------------------------------------------------
   * ## The ordering contract, stated once and depended on twice
   *
   * **This is called at the end of the tick, after `combat.advance` has already
   * integrated `input` into the body.** So `velocity` is the velocity the body
   * has *after* the step that `this.seq` names -- the post-state of that input,
   * not its pre-state.
   *
   * `main.ts` says the same thing from its side at the foot of its fixed step
   * ("the local player's inputs go out last, after the tick they belong to has
   * been predicted"), and `predictedBikeChange` above already leans on it to
   * work out that a press rides on `seq + 1`. It was an undocumented convention
   * shared by three call sites until the velocity below started depending on it,
   * and an undocumented convention is exactly what a refactor moves one line.
   *
   * The consequence, which is why `velocity` is a parameter at all: the server
   * acknowledges a seq, and the position it sends with that acknowledgement is
   * the position *after* it applied that seq. `reconcile` replays from there,
   * and the velocity it must start from is the velocity after that same seq --
   * which is precisely what is recorded here. See `reconcile`'s seed.
   *
   * Handed in rather than read off a stored reference to the combatant, because
   * this object deliberately does not own one: everything else it knows about
   * the local player arrives as an argument to `reconcile`, and a field pointing
   * back into `main.ts`'s state would be a second, quieter path by which the two
   * could disagree.
   */
  sendInput(input: CombatInput, velocity: Vector3): void {
    if (this.status !== 'online') return;
    this.seq = (this.seq + 1) & 0xffff;
    this.transport.send(
      encodeInput({
        seq: this.seq,
        buttons:
          (input.punch ? BTN.PUNCH : 0) |
          (input.throwBall ? BTN.THROW : 0) |
          (input.jump ? BTN.JUMP : 0) |
          (input.sprint ? BTN.SPRINT : 0) |
          (input.mount === true ? BTN.MOUNT : 0),
        forward: input.forward,
        right: input.right,
        yaw: input.yaw,
        pitch: input.pitch,
      }),
    );
    this.pending.push({
      seq: this.seq,
      input: { ...input },
      vx: velocity.x,
      vy: velocity.y,
      vz: velocity.z,
    });
    // A bounded ring rather than an unbounded queue: a server that stopped
    // acknowledging -- because it died, or because the socket is half-open --
    // would otherwise grow this forever at 60 records a second.
    if (this.pending.length > INPUT_HISTORY) this.pending.shift();
  }

  /**
   * Say something to everybody on the server. Returns what was actually sent, or
   * the empty string if nothing was.
   *
   * Sanitised **here** as well as on the server, on `sendInput`'s neighbouring
   * principle and `protocol.sanitiseName`'s explicit one: the client runs the
   * shared function so what the player sees accepted is what the server accepts,
   * and the server runs it again because the first run happened inside something
   * the player controls. An empty result is dropped rather than sent, which
   * spends none of the sender's rate budget on a stray Enter.
   *
   * Refused while offline for the obvious reason and one less obvious: `status`
   * is `'offline'` on the `?offline` path *and* on a connection that dropped, and
   * a message typed into a dead socket that silently vanished would be worse than
   * one that was never accepted. `client/src/chat.ts` says so in the box.
   */
  sendChat(text: string): string {
    if (this.status !== 'online') return '';
    const clean = sanitiseChat(text);
    if (clean.length === 0) return '';
    this.transport.send(encodeChatSay(clean));
    return clean;
  }

  /**
   * The suggestions box's three requests. See `net/suggestions.ts`.
   *
   * Three thin methods rather than one with a discriminated argument, because
   * the caller is a panel with three buttons and a union type at this seam would
   * only be unpacked again on the next line. They share one message id and one
   * flood budget on the wire; that is the protocol's business and not the
   * panel's.
   *
   * All three carry the client id, which this object holds because it was handed
   * one at construction and **never mints one** -- an identity minted in the net
   * layer would be a second one beside `localStorage`'s, and a player would have
   * a different vote identity per reconnect. See `suggestions.clientId`.
   *
   * Refused while offline on `sendChat`'s argument: `status` is `'offline'` on
   * the `?offline` path and on a dropped socket alike, and a vote that silently
   * vanished into a dead connection is worse than one visibly refused. The panel
   * says so rather than failing quietly.
   */
  requestSuggestions(): boolean {
    if (this.status !== 'online' || this.clientId === '') return false;
    this.transport.send(encodeSuggestList(MSG.SUGGEST, this.clientId));
    return true;
  }

  submitSuggestion(title: string, body: string): boolean {
    if (this.status !== 'online' || this.clientId === '') return false;
    this.transport.send(encodeSuggestSubmit(MSG.SUGGEST, this.clientId, title, body));
    return true;
  }

  voteSuggestion(localId: number, dir: number): boolean {
    if (this.status !== 'online' || this.clientId === '') return false;
    this.transport.send(encodeSuggestVote(MSG.SUGGEST, this.clientId, localId, dir));
    return true;
  }

  /** Called every frame. Advances the interpolation clock and places the remotes. */
  update(dt: number): void {
    if (this.tickSynced) this.serverTick += dt * TICK_HZ;
    this.tickInvestigations(dt);
    this.interpolate(dt);
  }

  /** Bumped once per interpolated frame. See `RemoteBall.seen`. */
  private frame = 0;

  // --- Receiving --------------------------------------------------------------

  private receive(frame: ArrayBuffer): void {
    switch (frameType(frame)) {
      case MSG.WELCOME: {
        const w = decodeWelcome(frame);
        if (!w) return;
        if (w.version !== PROTOCOL_VERSION) {
          this.setStatus('refused', `server speaks protocol ${w.version}, this build speaks ${PROTOCOL_VERSION}`);
          this.transport.close();
          return;
        }
        this.id = w.id;
        this.colourway = w.colourway;
        this.room = w.room;
        this.serverTick = w.tick;
        this.tickSynced = true;
        this.welcome = w;
        this.setStatus('online', `id ${w.id} in room ${w.room}`);
        return;
      }
      /*
       * v8's working-set delta. PERFORMANCE.md phase 2.
       *
       * This is where remotes are **created and destroyed** now, and the
       * ordering the server guarantees is what makes that safe: the INTEREST
       * frame is sent immediately before the snapshot whose bodies it explains,
       * so every id in a snapshot has had an identity delivered first. The
       * snapshot path below still builds a record for an id it has never heard
       * of, on the same argument it always did -- a missing entrance must leave
       * somebody *visible and wrongly dressed* rather than invisible -- but
       * under v8 that branch should never fire, and `checkAoi` asserts it does
       * not.
       */
      case MSG.INTEREST: {
        const delta = decodeInterest(frame);
        if (!delta) return;
        for (const e of delta.enters) {
          if (e.id === this.id) continue;
          const r = this.ensureRemote(e.id, e.colourway, (e.flags & ENTER_FLAG.BOT) !== 0);
          // Taken from the entrance rather than waited for, so the first pose is
          // the right pose: a player who walks into view on a bike is drawn
          // seated on the frame they appear rather than running along the
          // footpath for one snapshot. The snapshot 0-50 ms later carries the
          // same bit and takes over.
          r.riding = (e.flags & ENTER_FLAG.RIDING) !== 0;
        }
        for (const id of delta.leaves) this.dropRemote(id);
        return;
      }
      case MSG.SNAPSHOT: {
        const s = decodeSnapshot(frame, this.scratchSnapshot);
        if (s) this.onSnapshot(s);
        return;
      }
      case MSG.EVENTS: {
        const events = decodeEvents(frame);
        if (events) this.onEvents(events);
        return;
      }
      case MSG.PONG: {
        const pong = decodePong(frame);
        if (!pong) return;
        const sample = performance.now() - pong.clientTime;
        // An exponential average with a heavy weight on the history, because
        // what the server does with this number is decide how far to rewind --
        // and a single 300 ms outlier from a garbage collection should not
        // grant a quarter-second of lag compensation on the next punch.
        this.rtt = this.rtt === 0 ? sample : this.rtt * 0.8 + sample * 0.2;
        return;
      }
      case MSG.ROSTER: {
        const entries = decodeRoster(frame);
        if (!entries) return;
        this.roster = entries;
        this.rememberNames(entries);
        // The colourway and the bot flag are on this record as well as on the
        // JOIN event, and they are filed **both** ways: onto a remote that
        // already exists, and into `identity` for one that does not yet. Both
        // halves are needed because the roster and the remote can arrive in
        // either order -- the server sends the roster ahead of the join events
        // at connect, so at that moment there is nothing to patch, and a remote
        // first seen in a *snapshot* is created after a roster that already
        // described them. Without the table, either order leaves somebody in
        // kit 0 who is not a bot.
        for (const e of entries) {
          if (e.id === this.id) continue;
          this.identity.set(e.id, { colourway: e.colourway, bot: e.bot });
          const r = this.remotes.get(e.id);
          if (r) {
            r.colourway = e.colourway;
            r.bot = e.bot;
          }
        }
        return;
      }
      /*
       * A line of chat, from anywhere on the host -- this room or another one.
       *
       * Passed straight out rather than filed on this object, which is the one
       * decision in this case. Every other message here updates state the client
       * reads back (the roster, the remotes, the bikes), because those are facts
       * about the world that a late frame must be able to ask about. A chat line
       * is an *event with a lifetime*: it is drawn, it fades, it scrolls off.
       * Holding a copy here would be a second scrollback with its own expiry
       * rules beside the one in `client/src/chat.ts` that already has them.
       */
      case MSG.CHAT_LINE: {
        const line = decodeChatLine(frame);
        if (line) this.handlers.onChat?.(line);
        return;
      }
      /*
       * The suggestion list and its acknowledgements. See `net/suggestions.ts`.
       *
       * Passed straight out and **not filed here**, on `CHAT_LINE`'s argument
       * with one addition of its own. Every message this object keeps a copy of
       * is a fact about the world that a late frame may need to ask about; a
       * suggestion list is a fact about a *panel that is currently open*, and it
       * carries this client's own remaining votes -- so a stale copy held here
       * would be the one thing a reopened panel must not draw. The panel asks
       * again on every open, which costs one frame a session.
       */
      case MSG.SUGGEST_LIST: {
        const list = decodeSuggestionList(frame, MSG.SUGGEST_LIST);
        if (list) this.handlers.onSuggestions?.(list);
        return;
      }
      case MSG.SUGGEST_ACK: {
        const ack = decodeSuggestAck(frame, MSG.SUGGEST_ACK);
        if (ack) this.handlers.onSuggestAck?.(ack.result, ack.issue, ack.message);
        return;
      }
      case MSG.POWERUPS: {
        const down = decodePowerups(frame);
        if (!down) return;
        this.powerupsDown = down.map((d) => ({
          tileKey: `${d.tileX}_${d.tileZ}`,
          index: d.index,
          respawnT: d.respawnT,
        }));
        return;
      }
      case MSG.BIKES: {
        const records = decodeBikes(frame);
        if (!records) return;
        // Upsert. The message is the full set at join and one record when
        // somebody mounts, and both arrive here -- see `protocol.encodeBikes`.
        for (const r of records) {
          this.bikes.adopt(r.id, { x: r.x, y: r.y, z: r.z, yaw: r.yaw });
          const bike = this.bikes.get(r.id);
          if (bike) bike.rider = r.rider;
        }
        // Which bike the server thinks *this* client is on. Derived rather than
        // sent separately: the rider id is already on every record, and a second
        // field saying "and yours is number 12" would be the field that
        // disagreed with the list beside it.
        let mine = 0;
        for (const bike of this.bikes.all()) {
          if (bike.rider === this.id && this.id !== 0) {
            mine = bike.id;
            break;
          }
        }
        this.serverBike = mine;
        this.serverBikeKnown = true;
        return;
      }
      case MSG.INVESTIGATION: {
        const records = decodeInvestigations(frame);
        if (!records) return;
        // Replacement, not upsert. An empty message means nobody is wanted and
        // is how every banner in the world comes down -- see
        // `protocol.encodeInvestigations` for why this record goes the opposite
        // way to `MSG.BIKES`.
        this.investigations.clear();
        for (const r of records) this.investigations.set(r.playerId, { ...r });
        return;
      }
      case MSG.BYE: {
        this.setStatus('refused', decodeBye(frame) ?? 'refused');
        this.transport.close();
        return;
      }
      default:
        return;
    }
  }

  /**
   * Every bike in the world, as the server last described it.
   *
   * A mirror rather than an authority: `main.ts` predicts its own mount so the
   * speed changes on the frame `E` goes down, and this is what corrects it. The
   * same class the server runs, from the same file, which is what keeps a claim
   * meaning the same thing on both ends.
   */
  readonly bikes = new BikeField();
  /** The bike the server says this client is on, or 0. See the BIKES case. */
  private serverBike = 0;
  /** False until the first BIKES message, so a joiner does not dismount itself. */
  private serverBikeKnown = false;
  /**
   * The input seq a local mount or dismount was predicted on, or -1.
   *
   * This is the whole of why a predicted mount does not flicker. Snapshots in
   * flight when `E` was pressed were generated before the server saw it, so they
   * all say "not riding"; adopting them would clear the prediction, and the
   * snapshot after would set it again -- a 50 ms stutter between 8 m/s and
   * 26 m/s, which at that speed is a visible lurch. So the server's opinion is
   * ignored until it has acknowledged the input that carried the press, which is
   * exactly the test the pending-input queue is already keyed on.
   */
  private bikePredictedAt = -1;

  /**
   * Tell the net layer that `main.ts` just predicted a mount or dismount.
   *
   * Called with the seq that is about to be sent, which is `this.seq + 1` -- the
   * press rides on the *next* input frame, because `main.ts` predicts during the
   * step and sends at the end of it.
   */
  predictedBikeChange(): void {
    this.bikePredictedAt = (this.seq + 1) & 0xffff;
  }

  /**
   * File every name in a roster, and keep the table from growing forever.
   *
   * A session is capped at sixteen players but not at sixteen *ids*: the server
   * hands out a fresh one to every connection, so a lobby people come and go
   * from all evening walks the counter up. 128 is eight full rosters of history,
   * which is far more than the four-line kill feed can ever refer back to, and
   * the prune drops the oldest insertions -- which `Map` iterates first.
   */
  private rememberNames(entries: readonly RosterEntry[]): void {
    for (const e of entries) if (e.name) this.names.set(e.id, e.name);
    if (this.names.size > 128) {
      const live = new Set(entries.map((e) => e.id));
      for (const id of [...this.names.keys()]) {
        if (this.names.size <= 128) break;
        if (!live.has(id)) this.names.delete(id);
      }
    }
  }

  /** Filled by WELCOME. `main.ts` reads it once to place its predicted body. */
  welcome: { id: number; x: number; y: number; z: number; yaw: number } | null = null;

  /** Filled by the POWERUPS message at join. `main.ts` drains it into its field. */
  powerupsDown: Array<{ tileKey: string; index: number; respawnT: number }> | null = null;

  private onEvents(events: ReturnType<typeof decodeEvents>): void {
    if (!events) return;
    for (const e of events) {
      if (e.kind === EVENT.HIT) {
        this.handlers.onHit(
          e.attacker,
          e.victim,
          (e.flags & EVENT_FLAG.KO) !== 0,
          (e.flags & EVENT_FLAG.FOOTY) !== 0,
          e.health,
        );
      } else if (e.kind === EVENT.PICKUP) {
        this.handlers.onPickup(e.combatant, e.powerup as PowerupKind, `${e.tileX}_${e.tileZ}`, e.index);
      } else if (e.kind === EVENT.JOIN) {
        // **A feed line and an identity, not a body.** Through v7 this built the
        // remote, because a join meant "somebody you can now see"; under v8 a
        // join is a room-wide fact about somebody who is probably three
        // kilometres away, and building a rig for them would put a hundred and
        // twenty-seven invisible actors in the scene. The body arrives when
        // `MSG.INTEREST` says they are near enough to draw.
        //
        // The identity is still filed, on the roster's own argument: the two can
        // arrive in either order, and a table that knew who somebody was before
        // they walked round the corner is what stops them being drawn in kit 0
        // for a snapshot.
        if (e.id !== this.id) this.identity.set(e.id, { colourway: e.colourway, bot: e.bot !== 0 });
        this.handlers.onJoin(e.id, e.colourway, e.bot !== 0);
      } else {
        // Left the game. Room-global, so this fires whether or not they were in
        // view -- which is right: the kill feed is the only place a room-wide
        // game is visible to somebody standing in a quiet street.
        this.remotes.delete(e.id);
        this.handlers.onLeave(e.id);
      }
    }
  }

  /**
   * Who everybody is, from the last roster, whether or not they have a body yet.
   *
   * The roster and the first snapshot arrive in either order, so this is what
   * lets a remote be *created* with the right kit rather than corrected into it
   * up to two seconds later -- which for a player who joins mid-fight is two
   * seconds in somebody else's singlet.
   */
  private readonly identity = new Map<number, { colourway: number; bot: boolean }>();

  private ensureRemote(id: number, colourway: number, bot: boolean): RemotePlayer {
    let r = this.remotes.get(id);
    if (!r) {
      // The roster's answer beats the caller's, because the caller may not have
      // one: the snapshot path passes kit 0 and "not a bot" for everybody, since
      // a snapshot carries a position and nothing about who somebody is.
      const known = this.identity.get(id);
      r = {
        id,
        colourway: known?.colourway ?? colourway,
        bot: known?.bot ?? bot,
        position: new Vector3(),
        yaw: 0,
        pitch: 0,
        anim: ANIM.IDLE,
        health: 3,
        speed: 0,
        onGround: true,
        throwing: false,
        ballCharges: 3,
        riding: false,
        fresh: true,
      };
      this.remotes.set(id, r);
    } else {
      r.colourway = colourway;
      r.bot = bot;
    }
    return r;
  }

  /**
   * Stop drawing somebody who went out of view, and release what they held.
   *
   * PERFORMANCE.md phase 2's other half. `onDrop` rather than `onLeave` -- see
   * `NetHandlers` -- because the two say the same thing to the renderer and
   * different things to the kill feed.
   *
   * The **interpolation history is deliberately not pruned** here, and that is
   * the one subtle line in this method. `this.snapshots` still holds up to 1.5 s
   * of frames with this id in them, and `interpolate` reads them by id off the
   * `remotes` map -- which no longer has an entry, so nothing is drawn. When the
   * same player walks back into view a fresh record is built and starts `fresh`,
   * which hides it until its first authoritative position. That is the same path
   * a joiner takes and it is what stops a returning neighbour being drawn for
   * one frame at wherever they were when they left.
   */
  private dropRemote(id: number): void {
    if (!this.remotes.delete(id)) return;
    this.handlers.onDrop(id);
  }

  private onSnapshot(s: Snapshot): void {
    // Out of order is possible on any transport and is cheap to reject: a
    // snapshot older than one already held would rewind the interpolation.
    const newest = this.snapshots.length ? this.snapshots[this.snapshots.length - 1] : null;
    if (newest && s.tick <= newest.tick) return;

    // The clock. See `serverTick`: nudged rather than assigned, so remotes
    // advance continuously instead of in 50 ms hops.
    if (!this.tickSynced) {
      this.serverTick = s.tick;
      this.tickSynced = true;
    } else {
      const error = s.tick - this.serverTick;
      // A big error is a stall or a reconnect, not jitter. Snap, because easing
      // a two-second error at 10% a snapshot takes half a minute.
      if (Math.abs(error) > TICK_HZ) this.serverTick = s.tick;
      else this.serverTick += error * 0.1;
    }

    // Copied out of the decoder's reused array, because the next snapshot will
    // overwrite it and this one has to survive in the buffer for interpolation.
    this.snapshots.push({
      tick: s.tick,
      players: s.players.map((p) => ({ ...p })),
      balls: s.balls.map((b) => ({ ...b })),
      npcs: s.npcs.map((n) => ({ ...n })),
      at: performance.now(),
    });
    if (this.snapshots.length > SNAPSHOT_HISTORY) this.snapshots.shift();

    // Ensure a record exists for everybody in the snapshot, so a player whose
    // JOIN event was lost still appears rather than being invisible forever.
    //
    // **Only when it is missing.** A snapshot carries a position and nothing
    // about who somebody *is*, so the two identity arguments here are invented
    // -- and calling `ensureRemote` unconditionally wrote those inventions over
    // the real ones twenty times a second: every remote in the game was kit 0
    // and nobody was a bot, however many JOIN events and rosters had said
    // otherwise. It has no picture beyond a street where everyone is wearing the
    // same singlet, which is the exact thing `player/character.ts` argues the
    // seven kits exist to prevent, and it reads as an art decision.
    for (const p of s.players) {
      if (p.id !== this.id && !this.remotes.has(p.id)) this.ensureRemote(p.id, 0, false);
    }
    // And drop anybody this snapshot has stopped carrying.
    //
    // **Under v8 this is a backstop rather than the mechanism.** A snapshot is
    // now exactly the working set, so "not in the snapshot" and "left my
    // interest" are the same statement -- and `MSG.INTEREST`, which arrives
    // immediately before, has already said so and already released the rig. What
    // this covers is the case where the two ever disagree, and it fails safe in
    // the right direction: a body the server is no longer describing stops being
    // drawn rather than standing in the street forever.
    //
    // `dropRemote` rather than the old `handlers.onLeave`, which is the whole of
    // phase 2's client-side change: somebody walking behind a building is not a
    // line in the kill feed.
    for (const id of [...this.remotes.keys()]) {
      if (!s.players.some((p) => p.id === id)) this.dropRemote(id);
    }

    this.pendingAck = s.ackSeq;
    this.pendingSelf = s.players.find((p) => p.id === this.id) ?? null;
    this.pendingSelfTick = s.tick;
  }

  private pendingAck = -1;
  private pendingSelf: SnapshotPlayer | null = null;
  private pendingSelfTick = -1;

  // --- Reconciliation ---------------------------------------------------------

  /**
   * Bring the locally-predicted combatant back onto the server's answer.
   *
   * Called by `main.ts` once per fixed step, **before** it advances the local
   * player, so a correction is folded in and then predicted forward on the same
   * tick rather than arriving a frame late.
   *
   * Returns the eased camera offset -- the part of the correction not yet
   * applied visually -- which the caller adds to the camera and to nothing else.
   * That separation is the same one `game/feedback.ts` makes about shake: the
   * simulation is corrected instantly and correctly, and the *view* of it lags
   * for 80 ms so the correction is not a jump cut.
   */
  reconcile(local: CombatantState, world: CombatWorld, out: Vector3): Vector3 {
    // Ease the outstanding correction toward zero regardless of whether a
    // snapshot arrived, so the tail of a previous one keeps running.
    const k = Math.min(1, 1 - Math.exp(-FIXED_DT / CORRECTION_TAU));
    this.correction.multiplyScalar(1 - k);
    if (this.correction.lengthSq() < 1e-8) this.correction.set(0, 0, 0);

    const self = this.pendingSelf;
    if (self === null) return out.copy(this.correction);
    this.pendingSelf = null;

    // --- Things the client is simply told. See the header's three-way split.
    local.health = self.health;
    local.stamina = self.stamina;
    local.ballCharges = self.ballCharges;

    // Spec 8.3's clocks: adopted on the *edge* only, so the client's own
    // countdown -- which is what the HUD chip reads and what `speedScale` feeds
    // to the integrator -- keeps running smoothly between snapshots.
    const training = (self.flags & FLAG.TRAINING) !== 0;
    const flatWhite = (self.flags & FLAG.FLAT_WHITE) !== 0;
    if (!training && local.trainingT > 0) local.trainingT = 0;
    if (!flatWhite && local.flatWhiteT > 0) local.flatWhiteT = 0;
    if (training && local.trainingT <= 0) applyPowerup(local, 0 as PowerupKind);
    if (flatWhite && local.flatWhiteT <= 0) applyPowerup(local, 1 as PowerupKind);

    // --- The bike, and the Redfern unlock.
    //
    // `TUNED` is taken outright and in one direction only: the server owns the
    // zone -- see `server/sim.ts`, which is the only thing that ever sets it --
    // so this is the sole path by which a client can learn it has been unlocked,
    // and a client that set it locally would be a client that granted itself 3x.
    // The flag never clears within a session, which is why there is no `else`.
    if ((self.flags & FLAG.TUNED) !== 0) local.bikeTuned = true;
    // Riding is adopted only once the server has acknowledged the input that
    // carried the press. See `bikePredictedAt` for why: everything in flight
    // when `E` went down predates it and would undo the prediction for a frame.
    const bikeAcked = this.pendingAck >= 0 && seqLE(this.bikePredictedAt, this.pendingAck);
    if (this.serverBikeKnown && (this.bikePredictedAt < 0 || bikeAcked)) {
      this.bikePredictedAt = -1;
      local.ridingBike = this.serverBike;
    }

    // --- Things the client cannot predict, adopted on the transition only.
    const serverPhase = PHASE_NAMES[self.phase] ?? 'idle';
    if (serverPhase !== this.lastPhase) {
      this.lastPhase = serverPhase;
      if (serverPhase === 'ko' && local.phase !== 'ko') {
        local.phase = 'ko';
        local.koT = 0;
        local.respawnT = 3;
        // And off the bike, here, rather than waiting for the `BIKES` message
        // that says so.
        //
        // The server has already parked it -- `combat.advance` clears the field
        // on the knockout tick and `BikeField.follow` drops the bike where the
        // body is -- so this is not the client deciding anything. It is the
        // client refusing to spend a round trip in a state the server has
        // already left, and the round trip is where the reported bug lived: a
        // player knocked out mid-ride kept `ridingBike` set until a `BIKES`
        // record arrived, which meant the chase camera, the RIDING chip and the
        // "E to get off" nudge all outlived the ride.
        //
        // Worse, that wait is not bounded by one snapshot. The adoption twenty
        // lines up is gated on `bikePredictedAt`, so a player knocked out in the
        // same breath as pressing `E` -- the exact moment a bat lands -- ignores
        // the server's opinion of their bike until the input carrying that press
        // is acknowledged. Clearing the gate as well is what makes this
        // unconditional: there is no prediction left to protect, because the
        // thing being predicted has been taken away.
        this.bikePredictedAt = -1;
        this.serverBike = 0;
        local.ridingBike = 0;
      } else if (serverPhase === 'flinch' && local.phase !== 'flinch') {
        local.phase = 'flinch';
        local.phaseT = 0;
      } else if (serverPhase === 'idle' && local.phase === 'ko') {
        // Coming back from a knockout. A respawn is a teleport the client cannot
        // predict, so it takes the server's position outright rather than easing
        // to it -- the snap below would do the same thing, and doing it here
        // makes the clocks right as well.
        //
        // **`local.phase === 'ko'` and not `|| 'flinch'`**, and that difference
        // is a real bug rather than a tidy-up. `respawnAt` restores full health
        // and clears spec 8.3's modifiers, which is exactly right after a
        // knockout and exactly wrong at the end of a 300 ms flinch: the health
        // would flicker to three pips until the next snapshot corrected it, and
        // -- the one that would never have been noticed -- the powerup flags
        // below would see a cleared `trainingT` against a set flag and re-apply
        // it, resetting a 45 s clock to 45 s every single time the player was
        // punched. A flinch needs no special case at all; the local `advance`
        // ends it on its own after `FLINCH_LOCKOUT`.
        respawnAt(local, self.x, self.y - EYE_HEIGHT, self.z, local.body.yaw);
        this.pending.length = 0;
        // Nothing recorded survives a respawn: the queue those velocities were
        // stamped on has just been emptied, so the next replay falls back to the
        // current velocity until an acknowledgement refills it. See
        // `ackedVelocity`.
        this.ackedVelocityKnown = false;
        this.correction.set(0, 0, 0);
        this.lastServerTick = -1;
        return out.copy(this.correction);
      }
    }

    // --- `/unstuck`, which is the other teleport this client cannot predict.
    //     One call, because the whole of the decision is `adoptTeleport`'s and
    //     the correction path below must not see it. See that method.
    if (this.adoptTeleport(local, self)) return out.copy(this.correction);

    // --- The position. Drop every input the server has acknowledged.
    const ack = this.pendingAck;
    if (ack >= 0) {
      // Sequence numbers wrap at 65536, so "acknowledged" is a comparison in
      // signed 16-bit space rather than a plain `<=`. Getting this wrong drops
      // the whole history once every eighteen minutes and replays two thousand
      // inputs in one tick.
      //
      // The last one dropped is the one the server's position is a picture of,
      // so its recorded velocity is the seed the replay below starts from. Taken
      // here rather than by searching for `ack` in the queue, because the two
      // are the same entry and this loop has already found it -- and because an
      // exact match is not guaranteed: a seq can leave the queue through
      // `INPUT_HISTORY` instead, and the newest thing acknowledged is still the
      // right answer.
      while (this.pending.length > 0 && seqLE(this.pending[0].seq, ack)) {
        const done = this.pending.shift()!;
        this.ackedVelocity.set(done.vx, done.vy, done.vz);
        this.ackedVelocityKnown = true;
      }
    }

    // Replay: start from the authoritative position and run every input the
    // server has not yet seen, through the same pure `step` the server ran.
    const body = this.replayBody;
    body.position.set(self.x, self.y, self.z);
    // The velocity is not on the wire (see the header), so it is reconstructed
    // rather than guessed: the client's own recorded velocity for the input the
    // server just acknowledged, which is the velocity the body had at exactly
    // the moment this position is a picture of. See `ackedVelocity` for what
    // using the *current* one cost on every acceleration ramp.
    //
    // The current velocity remains the fallback for the two cases where there is
    // no recorded history to read: before the first acknowledgement, and after
    // a teleport or a respawn has thrown the queue away.
    if (this.ackedVelocityKnown) body.velocity.copy(this.ackedVelocity);
    else body.velocity.copy(local.body.velocity);
    body.onGround = (self.flags & FLAG.ON_GROUND) !== 0;
    body.yaw = self.yaw;
    body.pitch = self.pitch;

    for (const p of this.pending) {
      const input = this.replayInput;
      input.forward = p.input.forward;
      input.right = p.input.right;
      input.jump = p.input.jump;
      input.sprint = p.input.sprint;
      input.yaw = p.input.yaw;
      input.pitch = p.input.pitch;
      // The powerup scales come from the combatant's own state rather than from
      // the stored input, which is exactly what `combat.advance` does on both
      // ends -- a replay that used the input's scales would drift the moment a
      // Flat White expired mid-replay.
      input.speedScale = speedScaleOf(local);
      input.jumpScale = jumpScaleOf(local);
      // And the bike, through the **same function** `combat.advance` calls, for
      // the reason `game/bikes.ts`'s header states: two copies of this
      // arithmetic are two copies that drift, and a replay that forgot the bike
      // would rewind the player 26 m/s of trajectory on every snapshot. That is
      // not a subtle drift -- it is a rubber band, and it would read as the
      // server rejecting the ride rather than as a missing line here.
      //
      // It also overwrites `input.sprint`, so the ordering matters: `sprint` is
      // copied from the stored input above and forced true here, exactly as
      // `advance` does it.
      shapeRideInput(local, input);
      step(body, input, FIXED_DT, world.collision, (x, z, feet) => world.groundHeight(x, z, feet));
    }

    const error = body.position.distanceTo(local.body.position);
    this.lastCorrection = error;

    if (error > CORRECTION_DEADZONE) {
      if (error > CORRECTION_SNAP) {
        // The knockback case. See the header: the position is taken outright and
        // the *velocity* is derived from the server's own two most recent
        // positions, so the local integrator flies the rest of the arc itself
        // rather than being dragged through it one snapshot at a time.
        this.snaps++;
        if (this.lastServerTick >= 0 && this.pendingSelfTick > this.lastServerTick) {
          const seconds = (this.pendingSelfTick - this.lastServerTick) / TICK_HZ;
          if (seconds > 1e-4) {
            local.body.velocity.set(
              (self.x - this.lastServerPos.x) / seconds,
              (self.y - this.lastServerPos.y) / seconds,
              (self.z - this.lastServerPos.z) / seconds,
            );
            local.body.onGround = false;
          }
        }
        local.body.position.copy(body.position);
        this.correction.set(0, 0, 0);
        // And restamp the recorded history, which this branch has just declared
        // wrong.
        //
        // A snap is the client being told its prediction of the last few frames
        // never happened -- it predicted a stationary body and the server threw
        // it at 11 m/s -- so the velocities recorded against those frames are
        // predictions of a world that did not occur. Left alone they would be
        // fed back as the seed on each of the next two or three snapshots, which
        // is a replay flying the arc from a standing start and another snap
        // behind it: a knockback that rubber-bands for 150 ms instead of
        // reading as a punch.
        //
        // The velocity taken from the server's own two positions is the only
        // thing actually known about that window, so every unacknowledged frame
        // is stamped with it -- which is exactly what the reconciler did for
        // every frame before the seed existed.
        for (const p of this.pending) {
          p.vx = local.body.velocity.x;
          p.vy = local.body.velocity.y;
          p.vz = local.body.velocity.z;
        }
        this.ackedVelocity.copy(local.body.velocity);
        this.ackedVelocityKnown = true;
      } else {
        // The ordinary case. The simulation takes the correction now; the camera
        // is told about it over the next 80 ms.
        this.corrections++;
        this.correction.add(local.body.position).sub(body.position);
        // Bounded, so a run of corrections in one direction cannot accumulate a
        // visual offset larger than the snap threshold -- which would put the
        // camera further from the body than a snap would have.
        if (this.correction.length() > CORRECTION_SNAP) this.correction.setLength(CORRECTION_SNAP);
        local.body.position.copy(body.position);
        local.body.velocity.copy(body.velocity);
        local.body.onGround = body.onGround;
      }
    }

    this.lastServerPos.set(self.x, self.y, self.z);
    this.lastServerTick = this.pendingSelfTick;
    return out.copy(this.correction);
  }

  // --- The unstuck teleport -----------------------------------------------------

  /**
   * How many more **reconciled snapshots** an authoritative teleport may arrive
   * in. Zero for "not armed".
   *
   * A window rather than a latch, because the thing being waited for may never
   * arrive: the server refuses `/unstuck` while knocked out and inside the
   * cooldown, and a latch set on a refused command would sit there indefinitely
   * waiting to swallow the next genuine knockback.
   *
   * **Counted in snapshots rather than in milliseconds**, and that is a fix
   * rather than a preference. A browser pauses `requestAnimationFrame` outright
   * in a hidden tab -- measured at zero frames in seven seconds in the pane this
   * project is developed against -- so a wall-clock deadline is consumed by
   * real time in which this client did not run at all, and expires before the
   * snapshot it was armed for is ever looked at. A budget spent by `reconcile`
   * is spent only when the game is actually playing, which is the thing the
   * window is really trying to bound.
   */
  private teleportArmed = 0;

  /**
   * A teleport was just asked for. Called by `main.ts` when the player sends
   * `/unstuck`; see `client/src/game/unstuck.ts`.
   *
   * This does **not** move anybody and does not predict anything -- the client
   * has no idea where the server is about to put it, and inventing a guess would
   * be a rubber-band on purpose. All it does is say "the next enormous jump in
   * the server's own position is legitimate", which is the one fact the
   * reconciler cannot work out for itself.
   */
  armTeleport(): void {
    this.teleportArmed = TELEPORT_ARM_SNAPSHOTS;
  }

  /**
   * Take the server's position outright, if this snapshot is the teleport.
   *
   * **This is `respawnAt`'s branch, minus the respawn.** A 200 m jump is a
   * hundred times `CORRECTION_SNAP`, so the correction path below would classify
   * it as a knockback and derive a velocity from two server positions a tick
   * apart -- twelve thousand metres per second, with `onGround` cleared, which
   * would fire the player out of the city for the two snapshots it takes to
   * settle. That is the rubber-band this exists to prevent, and the fix is the
   * one the knockout recovery already uses: clear the prediction, clear the
   * eased camera offset, and reset `lastServerTick` so the *next* snapshot is
   * not differenced against a position on the other side of Sydney.
   *
   * Two conditions, and both are needed:
   *
   *   - **Armed.** Only the player's own `/unstuck` arms it, so nothing the
   *     server does on its own can be adopted this way.
   *   - **A jump no legitimate motion can produce.** `TELEPORT_MIN_M` is 20 m
   *     between consecutive snapshots -- 400 m/s at the snapshot rate, where the
   *     hardest knockback in the game is 10.5 m/s and a tuned bike is 26. The
   *     distance test is what stops the arming window swallowing an ordinary
   *     correction that happens to land inside it: a command that was refused
   *     produces no jump, so the window simply runs out.
   *
   * The budget is spent **here**, one per reconciled snapshot, rather than
   * against a clock -- see `teleportArmed`.
   *
   * The health and the powerup clocks above have already been adopted from this
   * same snapshot, so nothing is skipped by returning early -- the position is
   * the only thing left, and it is being taken whole.
   */
  private adoptTeleport(local: CombatantState, self: SnapshotPlayer): boolean {
    if (this.teleportArmed <= 0) return false;
    this.teleportArmed--;
    // Before the first snapshot has been differenced there is nothing to
    // difference against, so there is no jump to recognise yet.
    if (this.lastServerTick < 0) return false;
    const jumped = Math.hypot(
      self.x - this.lastServerPos.x,
      self.y - this.lastServerPos.y,
      self.z - this.lastServerPos.z,
    );
    if (jumped < TELEPORT_MIN_M) return false;

    this.teleportArmed = 0;
    this.teleports++;
    local.body.position.set(self.x, self.y, self.z);
    local.body.velocity.set(0, 0, 0);
    // `server/sim.unstuck` sets the same flag on the same tick: the destination
    // is a road surface and the player is standing on it, not falling onto it.
    local.body.onGround = true;
    this.pending.length = 0;
    // As on the respawn path: the recorded velocities belong to a queue that no
    // longer exists, and to a place two hundred metres away. See `ackedVelocity`.
    this.ackedVelocityKnown = false;
    this.correction.set(0, 0, 0);
    this.lastServerPos.set(self.x, self.y, self.z);
    this.lastServerTick = -1;
    return true;
  }

  /** How many teleports have been adopted this session. Read by the dev handle. */
  teleports = 0;

  // --- Interpolation ----------------------------------------------------------

  /**
   * Place every remote at `serverTick - 100 ms`, between the two snapshots that
   * bracket it. Spec 10's interpolation buffer.
   *
   * Never extrapolates. A remote whose newest snapshot is older than the render
   * time -- which is a stall, not jitter -- holds its last position rather than
   * continuing in a straight line: a player who ran into a wall during the stall
   * would otherwise be drawn walking through it, and the correction when the
   * snapshots resume is a teleport backwards, which is the worst-looking of the
   * three options.
   */
  private interpolate(frameDt: number): void {
    if (this.snapshots.length === 0) return;
    this.frame++;
    const renderTick = this.serverTick - (INTERP_DELAY_MS / 1000) * TICK_HZ;

    // The pair bracketing `renderTick`. Walked from the newest because that is
    // where the answer almost always is -- one comparison in the steady state.
    let older: TimedSnapshot | null = null;
    let newer: TimedSnapshot | null = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].tick <= renderTick) {
        older = this.snapshots[i];
        newer = this.snapshots[i + 1] ?? null;
        break;
      }
    }
    if (!older) {
      // Render time is before everything held -- the first 100 ms of a session.
      older = this.snapshots[0];
      newer = this.snapshots[1] ?? null;
    }

    const span = newer ? newer.tick - older.tick : 0;
    const t = span > 0 ? Math.max(0, Math.min(1, (renderTick - older.tick) / span)) : 0;
    // Seconds between the two, for the velocity the stride is keyed to.
    const dt = span > 0 ? span / TICK_HZ : 1 / SNAPSHOT_HZ;

    for (const r of this.remotes.values()) {
      const a = older.players.find((p) => p.id === r.id);
      if (!a) continue;
      const b = newer ? newer.players.find((p) => p.id === r.id) ?? a : a;

      const px = r.position.x;
      const pz = r.position.z;
      r.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
      // Yaw the short way round, for `rewind.sampleAt`'s reason: lerping 6.2 to
      // 0.1 naively sweeps the long way and spins a remote through a full turn
      // every time they cross north.
      let d = b.yaw - a.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      r.yaw = a.yaw + d * t;
      r.pitch = a.pitch + (b.pitch - a.pitch) * t;

      // The animation byte is taken from the *newer* end rather than blended,
      // because it is an enum: halfway between WALK and KO is not a pose.
      r.anim = b.anim;
      r.health = b.health;
      r.onGround = (b.flags & FLAG.ON_GROUND) !== 0;
      r.throwing = (b.flags & FLAG.THROWING) !== 0;
      r.ballCharges = b.ballCharges;
      // Taken from the newer end rather than blended, on the animation byte's
      // own argument one line up: halfway between riding and not riding is not a
      // pose.
      r.riding = (b.flags & FLAG.RIDING) !== 0;

      if (r.fresh) {
        r.fresh = false;
        r.speed = 0;
      } else {
        // Speed from the *snapshot pair* rather than from this frame's movement:
        // the render clock and the frame clock are different rates, so a
        // per-frame difference would report a walk as a sprint on a slow frame
        // and as a stand on a fast one. `(b - a) / dt` is the real ground speed
        // between two authoritative positions.
        const measured = Math.hypot(b.x - a.x, b.z - a.z) / dt;
        // Lightly smoothed, because the 1 cm quantisation is 0.2 m/s of noise at
        // 20 Hz and the walk/run crossfade sits at 4.6-7.4 m/s.
        r.speed = r.speed * 0.6 + measured * 0.4;
        void px;
        void pz;
      }
    }

    this.interpolateBalls(older, newer, t, frameDt);
    this.interpolateActors(older, newer, t);
  }

  /**
   * Place every faction actor on the same 100 ms clock the bodies are on.
   *
   * The **same** clock, and that is the only decision in here. An officer drawn
   * at present time while the player they are shooting at is drawn 100 ms in the
   * past would be aiming at empty pavement, and the tracer -- which is drawn
   * between the two -- would visibly miss on the frame the server says it hit.
   * Everything in the world that can be seen next to a remote player has to be
   * on the remote player's clock; that is why the balls are here too.
   *
   * The records are `factions.NpcActor` rather than a shape of this file's own,
   * so `main.ts` reads one array whether it is online or off. The fields a
   * snapshot does not carry -- health, target, the down clock -- are left at
   * their defaults and are never read on a client: they are authority state and
   * this side has no authority.
   */
  private interpolateActors(older: TimedSnapshot, newer: TimedSnapshot | null, t: number): void {
    const source = newer ?? older;
    for (const n of source.npcs) {
      let actor = this.actors.get(n.id);
      if (actor === undefined) {
        actor = {
          id: n.id, kind: n.kind,
          x: n.x, y: n.y, z: n.z,
          dx: 0, dz: 1,
          state: n.state,
          health: 0, downTicks: 0, stateTicks: 0, target: -1,
          homeX: n.x, homeZ: n.z,
          fireCooldown: 0, shotsFired: 0, barkedAt: 0, struckAt: 0, seen: 0,
        };
        this.actors.set(n.id, actor);
      }
      const a = older.npcs.find((o) => o.id === n.id);
      if (a !== undefined && newer !== null) {
        actor.x = a.x + (n.x - a.x) * t;
        actor.y = a.y + (n.y - a.y) * t;
        actor.z = a.z + (n.z - a.z) * t;
        // Yaw the short way round, exactly as a remote player's is: lerping 6.2
        // to 0.1 naively sweeps the long way and spins an officer through a full
        // turn every time they face north.
        let d = n.yaw - a.yaw;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        const yaw = a.yaw + d * t;
        // Back to the unit heading the record carries. This is the one
        // `Math.sin`/`Math.cos` pair in the faction path and it is on the
        // presentation side of the line -- nothing downstream of it feeds a
        // decision. See `game/factions.ts`'s rule 5.
        actor.dx = -Math.sin(yaw);
        actor.dz = -Math.cos(yaw);
      } else {
        actor.x = n.x;
        actor.y = n.y;
        actor.z = n.z;
        actor.dx = -Math.sin(n.yaw);
        actor.dz = -Math.cos(n.yaw);
      }
      // The state byte from the *newer* end rather than blended, on the
      // animation byte's own argument: halfway between aiming and firing is not
      // a pose, and `NPC_STATE.FIRE` is exactly one tick wide -- blending it
      // would be the one state that never appeared at all.
      actor.state = n.state;
      actor.kind = n.kind;
      actor.seen = this.frame;
    }
    // Everybody the newest snapshot stopped carrying has resolved: walked home,
    // or been evicted by the cap. No despawn message exists and none is needed,
    // which is the projectile section's argument applied to a person.
    for (const [id, actor] of this.actors) {
      if (actor.seen !== this.frame) this.actors.delete(id);
    }
  }

  /**
   * Place every football between the same two snapshots the bodies came from.
   *
   * Rebuilt against the newer snapshot's list each frame rather than being an
   * accumulating set, because that is what makes a ball's *death* free: it stops
   * appearing and it stops being drawn, with no message and no timeout. The map
   * survives across frames only so `age` -- which drives the cosmetic tumble --
   * has somewhere to accumulate, and so a bounce can be noticed by comparing a
   * counter against the one this client last saw.
   */
  private interpolateBalls(
    older: TimedSnapshot,
    newer: TimedSnapshot | null,
    t: number,
    frameDt: number,
  ): void {
    const source = newer ?? older;
    for (const b of source.balls) {
      // Your own balls are drawn by `main.ts` from its own prediction, at
      // present time rather than 100 ms behind it. See `ownBall`.
      if (this.ownBall(b.thrower)) continue;
      let ball = this.balls.get(b.id);
      if (ball === undefined) {
        ball = {
          id: b.id,
          thrower: b.thrower,
          position: new Vector3(b.x, b.y, b.z),
          velocity: new Vector3(b.vx, b.vy, b.vz),
          bounces: b.bounces,
          age: 0,
          seen: 0,
        };
        this.balls.set(b.id, ball);
      }
      const a = older.balls.find((o) => o.id === b.id);
      if (a !== undefined && newer !== null) {
        ball.position.set(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
        ball.velocity.set(a.vx + (b.vx - a.vx) * t, a.vy + (b.vy - a.vy) * t, a.vz + (b.vz - a.vz) * t);
      } else {
        // First sight of this ball, or a stall. Its own position, and no
        // extrapolation for `remoteAt`'s reason -- a ball continued in a
        // straight line through a stall is a ball drawn through a terrace, and
        // the correction when the snapshots resume is a jump backwards.
        ball.position.set(b.x, b.y, b.z);
        ball.velocity.set(b.vx, b.vy, b.vz);
      }
      // The bounce cue. Read off the counter rather than off a sign change in
      // the vertical velocity, because at 20 Hz a bounce that starts and ends
      // inside one snapshot interval -- which is most of them -- leaves no trace
      // in the velocity at all. See `protocol.BALL_BYTES`.
      if (b.bounces > ball.bounces) {
        ball.bounces = b.bounces;
        this.handlers.onBounce(ball.position.x, ball.position.y, ball.position.z, b.bounces);
      }
      // The tumble's clock, on the **frame** delta rather than the snapshot
      // rate: the spin is presentation and has to be smooth at whatever rate the
      // display runs, which is `main.ts`'s own rule about the actors.
      ball.age += frameDt;
      ball.seen = this.frame;
    }
    // And drop everything the newest snapshot no longer carries: it hit
    // somebody, bounced out its budget, or went into the harbour. No death
    // message exists and none is needed -- see `RemoteBall`.
    for (const [id, ball] of this.balls) {
      if (ball.seen !== this.frame) this.balls.delete(id);
    }
  }

  /** For the HUD: how many are connected, and what the buffer looks like. */
  get report(): { players: number; ping: number; buffer: number; corrections: number; snaps: number } {
    return {
      players: this.remotes.size + (this.status === 'online' ? 1 : 0),
      ping: this.rtt,
      buffer: this.snapshots.length,
      corrections: this.corrections,
      snaps: this.snaps,
    };
  }
}

const PHASE_NAMES = ['idle', 'windup', 'active', 'recovery', 'flinch', 'ko'];

// --- The gateway ---------------------------------------------------------------

/**
 * `chooseRoom` and `RoomInfo` live in `protocol.ts` -- the file both ends import
 * -- and are re-exported here because this is where a caller looks for them.
 *
 * They are there rather than here for the reason that file exists at all: the
 * *server's* integration check has to assert the client's own choosing rule, and
 * this module imports `three` and cannot be loaded outside a browser. The same
 * argument `protocol.rankRoster` already makes about the leaderboard's order.
 */
export { chooseRoom, type RoomInfo } from './protocol.ts';

/**
 * Ask a host what rooms it has. Returns an empty list for anything that is not a
 * v8 host, which is what makes the join flow degrade rather than fail.
 *
 * PERFORMANCE.md phase 3. Three properties, all of them about failing softly:
 *
 *   - **A host with no `/rooms` route is not an error.** A pre-phase-3 server,
 *     or a proxy that only forwards `/ws`, answers 404 or nothing; the caller
 *     then connects with no room and the server's own gateway puts it in the
 *     least-full open one. The boot must not stall on a route that is an
 *     optimisation.
 *   - **It is time-boxed.** A gateway fetch that hangs would hold up the join,
 *     and the join is already the one place `main.ts` blocks on the network. Two
 *     seconds, against a route that answers in a millisecond.
 *   - **It never throws.** A CORS failure, a captive portal, a DNS answer that
 *     is a parked domain -- all of them land here as an empty list.
 *
 * It stays in *this* file rather than beside `chooseRoom` because it is the one
 * half that is not pure: it opens a socket, and `protocol.ts` deliberately holds
 * nothing that does.
 */
export async function fetchRooms(httpBase: string, timeoutMs = 2000): Promise<RoomInfoShape[]> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${httpBase.replace(/\/$/, '')}/rooms`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body.filter(
      (r): r is RoomInfoShape =>
        typeof r === 'object' && r !== null &&
        typeof (r as RoomInfoShape).id === 'number' && typeof (r as RoomInfoShape).players === 'number',
    );
  } catch {
    return [];
  }
}

/**
 * `a <= b` in wrapping 16-bit sequence space.
 *
 * The classic serial-number comparison: subtract, sign-extend to 16 bits, test.
 * A plain `a <= b` is right for 65535 packets out of 65536 and catastrophically
 * wrong for the one where the counter wraps -- at which point every pending
 * input looks unacknowledged and the client replays two thousand of them on one
 * tick. That is 18 minutes into a session, which is exactly long enough for
 * nobody to connect it to anything.
 */
function seqLE(a: number, b: number): boolean {
  return ((a - b) << 16) >> 16 <= 0;
}

/*
 * The two powerup scales, restated here rather than imported from
 * `game/powerups.ts`.
 *
 * Not to avoid the import -- this file already imports `applyPowerup` from it --
 * but because the replay needs them as *plain* functions of the combatant, and
 * reaching for `speedScale(c)` reads as though the replay might be applying a
 * different rule than `combat.advance` does. It is the same rule; these two
 * lines are it.
 */
import { speedScale as speedScaleOf, jumpScale as jumpScaleOf } from '../game/powerups.ts';

// --- The self-check -----------------------------------------------------------

/**
 * Prediction and reconciliation, with no server and no socket.
 *
 * The failures this catches are the ones with no picture. A reconciliation that
 * does not converge shows as a player who "feels floaty"; one that snaps on
 * every snapshot shows as a stutter that looks like frame drops; a sequence
 * comparison that ignores the wrap works perfectly for eighteen minutes.
 *
 * The harness below is a fake transport that runs the *real* server-side
 * arithmetic in miniature -- a body advanced by `controller.step` over the same
 * inputs -- so what is being tested is that the client's replay lands on the
 * same answer, which is the entire claim.
 */
export function verifyNetClient(): string[] {
  const failures: string[] = [];

  // --- The sequence comparison, across the wrap.
  {
    const cases: Array<[number, number, boolean]> = [
      [1, 2, true],
      [2, 1, false],
      [5, 5, true],
      [65535, 0, true], // wrapped: 65535 came before 0
      [0, 65535, false],
      [65530, 4, true],
      [4, 65530, false],
    ];
    for (const [a, b, want] of cases) {
      if (seqLE(a, b) !== want) {
        failures.push(`seqLE(${a}, ${b}) is ${seqLE(a, b)}, not ${want}. The input history wraps at 65536.`);
      }
    }
  }

  // --- A replay lands where a straight simulation does.
  //
  // Two bodies over the same twenty inputs: one stepped continuously, one
  // stepped to tick 8, "acknowledged" there, and replayed forward. They must
  // agree to floating-point noise, because `step` is pure -- which is the
  // property the whole design rests on and the one that would fail silently if
  // anything in the controller ever started reading a clock.
  {
    const world: CombatWorld = { collision: null, groundHeight: () => 0 };
    const inputs: InputSnapshot[] = [];
    for (let i = 0; i < 20; i++) {
      inputs.push({
        forward: i < 12 ? 1 : 0,
        right: i > 6 ? 0.5 : 0,
        jump: i === 3,
        sprint: i > 9,
        yaw: i * 0.05,
        pitch: 0,
        speedScale: 1,
        jumpScale: 1,
      });
    }

    const straight = createCombatant(0).body;
    for (const input of inputs) step(straight, input, FIXED_DT, null, () => 0);

    const replayed = createCombatant(0).body;
    for (let i = 0; i < 8; i++) step(replayed, inputs[i], FIXED_DT, null, () => 0);
    // "The server acknowledged input 8": rewind to exactly this state and
    // replay the rest, which is what `reconcile` does when the server agrees.
    for (let i = 8; i < inputs.length; i++) step(replayed, inputs[i], FIXED_DT, null, () => 0);

    const drift = straight.position.distanceTo(replayed.position);
    if (drift > 1e-9) {
      failures.push(
        `Replaying 12 inputs from an acknowledged state drifted ${drift.toExponential(2)} m from a ` +
          `straight simulation. controller.step is not a pure function of state plus input.`,
      );
    }
    void world;
  }

  // --- Reconciliation converges: a client that is 50 cm wrong is put right and
  // stays right, and the camera offset decays rather than persisting.
  {
    const handlers = silentHandlers();
    const net = new NetClient('', handlers, { transport: nullTransport() });
    net.status = 'online';
    net.id = 1;

    const world: CombatWorld = { collision: null, groundHeight: () => 0 };
    const local = createCombatant(1);
    const input: CombatInput = {
      forward: 1, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, punch: false, throwBall: false,
    };
    for (let i = 0; i < 30; i++) {
      advance(local, input, FIXED_DT, world);
      // `advance` first and `sendInput` second, which is `main.ts`'s order and
      // the contract `sendInput`'s header states: the velocity recorded against
      // a seq is the one the body has *after* that input.
      net.sendInput(input, local.body.velocity);
    }

    // The server says the player is 0.5 m from where the client thinks, having
    // acknowledged every input.
    const truth = {
      id: 1,
      x: local.body.position.x + 0.5,
      y: local.body.position.y,
      z: local.body.position.z,
      yaw: 0, pitch: 0, anim: ANIM.WALK, health: 3, stamina: 4, phase: 0,
      flags: FLAG.ON_GROUND, ballCharges: 3,
    };
    (net as unknown as { pendingSelf: SnapshotPlayer; pendingAck: number; pendingSelfTick: number }).pendingSelf = truth;
    (net as unknown as { pendingAck: number }).pendingAck = (net as unknown as { seq: number }).seq;
    (net as unknown as { pendingSelfTick: number }).pendingSelfTick = 100;

    const offset = new Vector3();
    net.reconcile(local, world, offset);
    if (Math.abs(local.body.position.x - truth.x) > 1e-6) {
      failures.push(
        `A 0.5 m correction left the body at x ${local.body.position.x.toFixed(3)} against the ` +
          `server's ${truth.x.toFixed(3)}. The simulation must take the correction immediately.`,
      );
    }
    if (offset.length() < 0.4) {
      failures.push(`A 0.5 m correction produced a ${offset.length().toFixed(3)} m camera offset; it should be about 0.5.`);
    }
    // And it decays. Five 80 ms time constants is 400 ms, or 24 ticks.
    for (let i = 0; i < 40; i++) net.reconcile(local, world, offset);
    if (offset.length() > 0.01) {
      failures.push(`The eased correction was still ${offset.length().toFixed(3)} m after 40 ticks; tau is ${CORRECTION_TAU} s.`);
    }
  }

  // --- A knockback-sized error snaps and takes the server's velocity, rather
  // than being dragged across six metres at 20 Hz.
  {
    const net = new NetClient('', silentHandlers(), { transport: nullTransport() });
    net.status = 'online';
    net.id = 1;
    const world: CombatWorld = { collision: null, groundHeight: () => 0 };
    const local = createCombatant(1);

    const self = (x: number, z: number): SnapshotPlayer => ({
      id: 1, x, y: EYE_HEIGHT, z, yaw: 0, pitch: 0, anim: ANIM.JUMP, health: 2, stamina: 4,
      phase: 4, flags: 0, ballCharges: 3,
    });
    const inject = (p: SnapshotPlayer, tick: number): void => {
      const n = net as unknown as { pendingSelf: SnapshotPlayer; pendingAck: number; pendingSelfTick: number };
      n.pendingSelf = p;
      n.pendingAck = -1;
      n.pendingSelfTick = tick;
    };
    const offset = new Vector3();

    inject(self(0, 0), 100);
    net.reconcile(local, world, offset);
    // Three snapshots later the server has thrown them 3 m -- 11 m/s for 0.15 s.
    inject(self(3.3, 0), 109);
    net.reconcile(local, world, offset);

    if (Math.abs(local.body.position.x - 3.3) > 1e-6) {
      failures.push(`A 3.3 m correction did not snap; the body is at x ${local.body.position.x.toFixed(2)}.`);
    }
    if (local.body.velocity.x < 8) {
      failures.push(
        `A snap left the body at ${local.body.velocity.x.toFixed(2)} m/s. It must take the velocity ` +
          `implied by the server's own two positions, or the knockback is a 20 Hz stutter.`,
      );
    }
    if (offset.length() > 1e-6) {
      failures.push('A snap left a camera offset behind. A snap is a cut, by definition.');
    }
  }

  // --- The server says you are down, and the ride ends with you.
  //
  // *"I died on bike and saw E to get off bike forever."* The client half of
  // that report lived here. `reconcile` adopts the server's opinion of which
  // bike you are on only once it has acknowledged the input that carried your
  // `E` press -- which is right, and is what stops a predicted mount flickering
  // for a round trip -- but it meant a player knocked out **in the same breath
  // as pressing E** ignored the server's "you are on nothing" until that
  // acknowledgement arrived. Everything derived from `ridingBike` came with it:
  // the chase camera, the RIDING chip, the "E to get off" nudge.
  //
  // The knockout is the one transition where there is no prediction left to
  // protect, so it clears the gate as well as the bike. Both halves are checked
  // below, because clearing only the field would leave the very next snapshot
  // free to put the player back on the bike they died on.
  {
    const net = new NetClient('', silentHandlers(), { transport: nullTransport() });
    net.status = 'online';
    net.id = 1;
    const world: CombatWorld = { collision: null, groundHeight: () => 0 };
    const local = createCombatant(1);
    const n = net as unknown as {
      pendingSelf: SnapshotPlayer | null;
      pendingAck: number;
      pendingSelfTick: number;
      bikePredictedAt: number;
      serverBike: number;
      serverBikeKnown: boolean;
    };
    const self = (phase: number, flags: number): SnapshotPlayer => ({
      id: 1, x: 0, y: EYE_HEIGHT, z: 0, yaw: 0, pitch: 0, anim: ANIM.RUN, health: 0, stamina: 4,
      phase, flags, ballCharges: 3,
    });
    const inject = (p: SnapshotPlayer, ack: number): void => {
      n.pendingSelf = p;
      n.pendingAck = ack;
      n.pendingSelfTick = 100;
    };
    const offset = new Vector3();

    // Riding, and the mount was predicted on an input the server has not seen.
    local.ridingBike = 12;
    n.serverBike = 12;
    n.serverBikeKnown = true;
    net.predictedBikeChange();
    const gate = n.bikePredictedAt;
    // A snapshot that pre-dates the press: it must not disturb the prediction.
    inject(self(0, FLAG.ON_GROUND | FLAG.RIDING), (gate - 3) & 0xffff);
    net.reconcile(local, world, offset);
    if (local.ridingBike !== 12) {
      failures.push('An un-acknowledged snapshot took the predicted bike away; a mount would flicker for a round trip.');
    }

    // ...and now the server knocks them out, still un-acknowledged.
    inject(self(5, 0), (gate - 2) & 0xffff);
    net.reconcile(local, world, offset);
    if (local.phase !== 'ko') failures.push(`The server's knockout was not adopted; the phase is "${local.phase}".`);
    if (local.ridingBike !== 0) {
      failures.push(
        `A player knocked out by the server is still on bike ${local.ridingBike}. Everything the ride ` +
          `owns -- the chase camera, the RIDING chip, the "E to get off" nudge -- outlives the ride with it.`,
      );
    }
    // And it stays cleared: the very next snapshot must not restore a bike from
    // a `serverBike` that predates the knockout.
    inject(self(5, 0), (gate - 1) & 0xffff);
    net.reconcile(local, world, offset);
    if (local.ridingBike !== 0) {
      failures.push(`The next snapshot put the knocked-out player back on bike ${local.ridingBike}.`);
    }
  }

  // --- A roster arriving as a real frame, through the real decoder.
  //
  // The failure this catches has no picture either, and it is the one that made
  // `names` a second table: a client that dropped a name the moment the roster
  // stopped carrying it would print "player 7 left" for somebody it had been
  // calling Shazza all game, which reads as a feed that occasionally forgets
  // people rather than as a lifetime bug.
  {
    const transport = nullTransport();
    const net = new NetClient('', silentHandlers(), { transport });
    net.id = 1;
    const roster: RosterEntry[] = [
      { id: 1, colourway: 0, bot: false, name: 'Bazza', kos: 3, downs: 1, ping: 21 },
      { id: 2, colourway: 1, bot: true, name: 'Shazza', kos: 4, downs: 0, ping: 0 },
    ];
    transport.onframe?.(encodeRoster(roster));
    if (net.nameOf(2) !== 'Shazza') failures.push(`A roster's name did not reach nameOf: got ${net.nameOf(2)}.`);
    if (net.myName !== 'Bazza') failures.push(`The local player's own name did not arrive: got ${JSON.stringify(net.myName)}.`);
    if (net.leaderboard()[0]?.id !== 2) failures.push('The leaderboard was not ranked by KOs.');
    // The refresh that no longer carries id 2 -- because they left -- must not
    // take the name with it.
    transport.onframe?.(encodeRoster([roster[0]]));
    if (net.nameOf(2) !== 'Shazza') {
      failures.push('A roster refresh that dropped a player also dropped their name; the kill feed cannot name a leaver.');
    }
    if (net.roster.length !== 1) failures.push('The board itself was not replaced by the refresh.');
    // An id nobody has ever mentioned still has to render as something.
    if (net.nameOf(99) !== 'player 99') failures.push(`An unknown id rendered as ${net.nameOf(99)}.`);

    // --- And a snapshot must not overwrite who somebody is.
    //
    // A snapshot carries a position and says nothing about identity, so the
    // colourway and bot flag it is decoded with are invented. Applying them
    // repainted every remote in the game kit 0 and un-botted everybody, twenty
    // times a second, however many JOIN events and rosters had said otherwise --
    // and the only symptom is a street where everyone is wearing the same
    // singlet, which reads as an art decision rather than as a bug.
    transport.onframe?.(encodeRoster(roster));
    transport.onframe?.(
      encodeSnapshot(1, 0, [
        { id: 2, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, anim: 0, health: 3, stamina: 4, phase: 0, flags: 0, ballCharges: 3 },
      ]),
    );
    const remote = net.remotes.get(2);
    if (!remote || remote.colourway !== 1 || !remote.bot) {
      failures.push(
        `A snapshot overwrote a remote's identity: kit ${remote?.colourway} and bot ${remote?.bot} ` +
          `against the roster's kit 1 and bot true.`,
      );
    }
  }

  // --- v7: the faction actors and the investigation channel, as real frames.
  //
  // Both fail silently and both fail in the same shape -- a state that is
  // *plausible* rather than absent. An actor set that accumulates instead of
  // being rebuilt leaves an officer standing in the street after the pursuit
  // ended, aiming at nothing, forever; there is no despawn message that could
  // have told the client otherwise, deliberately (see `interpolateActors`). And
  // an investigation map that is upserted rather than replaced leaves the banner
  // up on a player nobody is chasing, which is the single most misleading thing
  // this interface can say.
  {
    const transport = nullTransport();
    const net = new NetClient('', silentHandlers(), { transport });
    net.id = 1;

    const npc = (id: number, x: number, state: number): SnapshotNpc => ({
      id, kind: 1, x, y: 0, z: 0, yaw: 0, state,
    });
    // Two snapshots so the interpolation has a pair to bracket, and `update`
    // between them so the render clock advances past the buffer.
    transport.onframe?.(encodeSnapshot(100, 0, [], [], [npc(1, 0, NPC_STATE.CHASE), npc(2, 10, NPC_STATE.AIM)]));
    transport.onframe?.(encodeSnapshot(103, 0, [], [], [npc(1, 3, NPC_STATE.CHASE), npc(2, 10, NPC_STATE.FIRE)]));
    for (let i = 0; i < 30; i++) net.update(1 / 60);
    if (net.actors.size !== 2) {
      failures.push(`Two faction actors on the wire produced ${net.actors.size} on the client.`);
    }
    const chaser = net.actors.get(1);
    if (!chaser || chaser.x < 0 || chaser.x > 3.001) {
      failures.push(`An interpolated actor is at x ${chaser?.x}, outside the 0..3 the two snapshots bracket.`);
    }
    if (net.actors.get(2)?.state !== NPC_STATE.FIRE) {
      failures.push(
        `The one-tick FIRE state was blended away rather than taken from the newer snapshot ` +
          `(got ${net.actors.get(2)?.state}). It is exactly one tick wide and would never be drawn.`,
      );
    }
    // One resolves. It must stop being drawn with no message saying so.
    transport.onframe?.(encodeSnapshot(106, 0, [], [], [npc(2, 10, NPC_STATE.RETURN)]));
    transport.onframe?.(encodeSnapshot(109, 0, [], [], [npc(2, 10, NPC_STATE.RETURN)]));
    for (let i = 0; i < 30; i++) net.update(1 / 60);
    if (net.actors.has(1)) {
      failures.push('An actor the server stopped reporting is still being drawn. There is no despawn message; the sweep is the whole mechanism.');
    }

    // --- The investigation channel.
    if (net.investigation !== null) failures.push('A client with no investigation message reported one.');
    transport.onframe?.(encodeInvestigations([{ playerId: 1, reason: 2, ticks: 600 }]));
    const mine = net.investigation;
    if (!mine || mine.reason !== 2 || Math.abs(mine.seconds - 10) > 0.01) {
      failures.push(`The local investigation decoded as ${JSON.stringify(mine)}; it should be reason 2 with 10 s left.`);
    }
    // It runs down locally between messages, which is what makes the banner's
    // seconds move at the frame rate rather than in 50 ms steps.
    for (let i = 0; i < 60; i++) net.update(1 / 60);
    const after = net.investigation;
    if (!after || Math.abs(after.seconds - 9) > 0.05) {
      failures.push(`After a second of frames the countdown reads ${after?.seconds.toFixed(2)}, not about 9.`);
    }
    // And an empty message takes the banner down.
    transport.onframe?.(encodeInvestigations([]));
    if (net.investigation !== null) {
      failures.push('An empty INVESTIGATION message left the banner up. It is a replacement, not an upsert.');
    }
    // The prediction path opens one without the server, and does not stack.
    net.predictInvestigation(1, 2700);
    const predicted = net.investigation;
    net.predictInvestigation(4, 2700);
    const second = net.investigation;
    if (!predicted || !second || second.seconds > predicted.seconds + 0.001) {
      failures.push('A second predicted crime extended the client-side countdown; stacking is the server\'s arithmetic.');
    }
    if (second?.reason !== 4) failures.push('A second predicted crime did not re-label the banner.');
  }

  // --- v8: the working-set lifecycle, and the one thing it must not do to the
  // kill feed.
  //
  // Three failures, all of them silent and all of them things a player would
  // report as something else:
  //
  //   - An entrance that does not build a remote is a **player who is invisible
  //     while punching you**. Nothing throws; the snapshot backstop eventually
  //     draws them in kit 0, so the report is "sometimes people are the wrong
  //     colour" and the cause is four bytes that never arrived.
  //   - A departure that does not release the rig is a statue in the street and
  //     a nameplate held out of the pool, at walking pace, forever.
  //   - A departure that goes through `onLeave` writes "Bazza left" into the
  //     kill feed every time somebody walks behind a building, which turns the
  //     one room-wide surface a player has into noise.
  {
    const transport = nullTransport();
    const left: number[] = [];
    const dropped: number[] = [];
    const joined: number[] = [];
    const handlers = silentHandlers();
    handlers.onLeave = (id) => left.push(id);
    handlers.onDrop = (id) => dropped.push(id);
    handlers.onJoin = (id) => joined.push(id);
    const net = new NetClient('', handlers, { transport });
    net.id = 1;

    // The roster first, exactly as a room sends it: room-global, everybody in
    // it, whether or not they can be seen.
    transport.onframe?.(
      encodeRoster([
        { id: 1, colourway: 0, bot: false, name: 'Bazza', kos: 0, downs: 0, ping: 20 },
        { id: 2, colourway: 4, bot: false, name: 'Shazza', kos: 0, downs: 0, ping: 30 },
        { id: 3, colourway: 5, bot: true, name: 'Davo', kos: 0, downs: 0, ping: 0 },
      ]),
    );
    // A JOIN for somebody across town. A feed line, and **no body**.
    transport.onframe?.(encodeEvents([{ kind: EVENT.JOIN, id: 3, colourway: 5, bot: 1 }]));
    if (joined.length !== 1) failures.push('A room-wide JOIN did not reach the kill feed.');
    if (net.remotes.has(3)) {
      failures.push(
        'A JOIN built a remote for somebody out of interest. At a full room that is 127 invisible ' +
          'actors in the scene, every one of them holding a rig.',
      );
    }

    // Now they walk into view.
    transport.onframe?.(
      encodeInterest([{ id: 3, colourway: 5, flags: ENTER_FLAG.BOT | ENTER_FLAG.RIDING }], []),
    );
    const r = net.remotes.get(3);
    if (!r) failures.push('An INTEREST entrance did not build a remote; the player is invisible.');
    if (r && (r.colourway !== 5 || !r.bot)) {
      failures.push(`An entrant arrived as kit ${r.colourway} bot ${r.bot}, not kit 5 bot true.`);
    }
    if (r && !r.riding) {
      failures.push('An entrant on a bike was not drawn riding; the first pose is a runner with no bike under them.');
    }

    // ...and out again. The rig is released and the feed says nothing.
    transport.onframe?.(encodeInterest([], [3]));
    if (net.remotes.has(3)) failures.push('An INTEREST departure left the remote in place; that is a statue in the street.');
    if (dropped.join(',') !== '3') failures.push(`Going out of view fired onDrop ${dropped.length} times, not once.`);
    if (left.length !== 0) {
      failures.push(
        'Walking out of view wrote a "left" line into the kill feed. Under AOI that fires every time ' +
          'anybody walks behind a building.',
      );
    }

    // A real departure still says so, and still releases.
    transport.onframe?.(encodeInterest([{ id: 2, colourway: 4, flags: 0 }], []));
    transport.onframe?.(encodeEvents([{ kind: EVENT.LEAVE, id: 2, colourway: 4, bot: 0 }]));
    if (net.remotes.has(2)) failures.push('A LEAVE event did not remove the remote.');
    if (left.join(',') !== '2') failures.push(`A real departure fired onLeave ${left.length} times, not once.`);

    // And an entrance for yourself is ignored -- the server never sends one, and
    // a client that built a remote for itself would draw its own body in front
    // of its own camera.
    transport.onframe?.(encodeInterest([{ id: 1, colourway: 0, flags: 0 }], []));
    if (net.remotes.has(1)) failures.push('An INTEREST entrance for the local player built a remote of itself.');
  }

  // --- v8: the gateway's room choice.
  //
  // Pure arithmetic over four numbers, and it is checked here rather than left
  // to the server because the *client* is what picks: a rule that preferred the
  // fullest room would pile everybody into one and produce the CBD-pileup
  // bandwidth for a room that had seven empty neighbours.
  {
    const rooms: RoomInfoShape[] = [
      { id: 0, players: 40, cap: 128, open: true },
      { id: 1, players: 128, cap: 128, open: false },
      { id: 2, players: 12, cap: 128, open: true },
      { id: 3, players: 12, cap: 128, open: true },
    ];
    if (chooseRoom(rooms, null) !== 2) {
      failures.push(`The gateway chose room ${chooseRoom(rooms, null)}; the emptiest open one is 2.`);
    }
    if (chooseRoom(rooms, 0) !== 0) failures.push('The gateway ignored an explicitly requested room; a friend\'s link does nothing.');
    // A full room that was **asked for by name** is still returned, so the
    // server can refuse it with a reason the player can read. Silently rehoming
    // somebody who followed a link is worse than telling them.
    if (chooseRoom(rooms, 1) !== 1) failures.push('The gateway silently rehomed a request for a full room instead of letting it be refused by name.');
    if (chooseRoom(rooms, 99) !== 2) failures.push('A request for a room that does not exist was not replaced by the emptiest.');
    // No listing at all -- a pre-phase-3 host, or a proxy that only forwards the
    // socket. The answer is "let the server decide", which is what a bare
    // connection has always meant.
    if (chooseRoom([], null) !== null) failures.push('An empty room listing did not fall back to the server\'s own choice.');
    if (chooseRoom([], 4) !== 4) failures.push('An explicit room against an unreachable listing was dropped; the link should still be tried.');
    // Ties break on the id, so two clients starting together land together
    // rather than being split by whichever list they happened to read.
    if (chooseRoom([{ id: 7, players: 3, cap: 128, open: true }, { id: 2, players: 3, cap: 128, open: true }], null) !== 2) {
      failures.push('Two equally-empty rooms did not break the tie on the id; friends joining at once would be split.');
    }
    if (chooseRoom([{ id: 0, players: 128, cap: 128, open: false }], null) !== null) {
      failures.push('A full host did not fall back to the server\'s own refusal path.');
    }
  }

  return failures;
}

function silentHandlers(): NetHandlers {
  return {
    onHit: () => {},
    onBounce: () => {},
    onPickup: () => {},
    onJoin: () => {},
    onLeave: () => {},
    onDrop: () => {},
    onStatus: () => {},
  };
}

/** A transport that goes nowhere, so the checks above need no socket. */
function nullTransport(): NetTransport {
  return {
    open: true,
    send: () => {},
    close: () => {},
    onframe: null,
    onopen: null,
    onclose: null,
  };
}
