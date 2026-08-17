/**
 * The authoritative simulation: spec 10's 60 Hz tick, and nothing else.
 *
 * This file has no socket in it. It takes inputs that were put on a queue, runs
 * `main.ts`'s `simulate()` over every combatant in id order, and produces
 * snapshots and events for `index.ts` to send. That separation is not tidiness
 * -- it is what makes the whole thing testable without a network, which is how
 * `verifySim` below runs a two-player fight in a millisecond.
 *
 * ---------------------------------------------------------------------------
 * It is `main.ts`'s loop, and the resemblance is the point.
 *
 * Read `simulate()` there and this side by side. Both collect every input first,
 * both advance every combatant in ascending id, both resolve a strike against
 * the state as it stands, both tick spec 8.3's powerups after everyone has
 * moved for the reason that file states -- a player punched away from a cafe on
 * the tick they walked into it *was* there. The client is running the same
 * simulation over the same shared modules, which is the entire premise of
 * prediction: if the two loops did different things in a different order,
 * reconciliation would be correcting a disagreement rather than a latency.
 *
 * There are exactly three differences, and each is a thing a server has that a
 * client does not:
 *
 *   1. **Strikes are evaluated against a rewound target list.** Spec 8.2's lag
 *      compensation. `server/rewind.ts` owns it; here it is one call and one
 *      `resolveLive`.
 *   2. **Pickups are decided once, here, for everybody.** Spec 8.3 ends on
 *      "Server-authoritative pickup". The client's field becomes a mirror.
 *   3. **Nothing is drawn, so there is no frame delta anywhere.** Every clock in
 *      this file is the fixed step.
 *
 * ---------------------------------------------------------------------------
 * Why a disconnected player's combatant is removed rather than left standing.
 *
 * The alternative -- keep the body, let it be punched, remove it after a
 * timeout -- is what a game with a reconnect flow does, and this has none. A
 * body nobody is driving is a free knockout and a permanent obstacle, and spec
 * 12 rules out persistence, so there is nothing for a returning player to
 * return *to*: they would be a new id with a new colourway either way. So a
 * close removes the combatant on the next tick and emits a LEAVE.
 */

import {
  MAX_HEALTH,
  advance,
  applyHit,
  applyWorldDamage,
  createCombatant,
  createHitReport,
  hitTest,
  pickRespawn,
  respawnAt,
  type CombatInput,
  type CombatWorld,
  type CombatantState,
  type HitReport,
} from '../client/src/game/combat.ts';
import { FootyField, applyFootyHit, type FootyEvent } from '../client/src/game/footy.ts';
// The bat against the ball. Pure, three-free, and the same file the browser runs
// offline -- which is what makes "the bat reached it" mean the same thing in the
// two processes that ever decide it. See `client/src/game/swat.ts`.
import { createBallAt, swatBalls } from '../client/src/game/swat.ts';
// WORKSTREAM N (carry): `restoreSpawnPoint` is `pickSpawnPoint`'s test without
// its draw -- the validator an account's remembered spot has to pass before
// anybody is put back on it. See `join`.
import { pickSpawnPoint, restoreSpawnPoint, spawnGround } from '../client/src/game/spawn.ts';
// `/unstuck`, and the whole of its rule. Shared with the client, which runs the
// identical function offline -- see `client/src/game/unstuck.ts`, whose header
// says why this is a chat command rather than a message id.
import { UNSTUCK_CAR_CLEAR_M, unstuckDestination, type UnstuckSpot } from '../client/src/game/unstuck.ts';
import { tickPowerups, type PickupEvent } from '../client/src/game/powerups.ts';
import {
  applyCarHit,
  carHitStrength,
  carHitting,
  carOverlaps,
  canBeRunDown,
  createCarPose,
  drivenCarPose,
  forEachCarNear,
  nearestBay,
  trafficTick,
  createBayPose,
  CAR_BODY_SIZE,
  type BayPose,
  type CarPose,
  type LaneRoute,
} from '../client/src/game/traffic.ts';
// Taking a car. Pure and three-free on the bikes' own terms -- the server runs
// this file, the browser runs this file, and neither runs the other's copy of
// it. See `game/driving.ts`, whose header is the design.
import {
  CarField,
  CAR_HEALTH_MAX,
  MAX_DRIVEN_CARS,
  PARK_SNAP_RADIUS,
  PEDESTRIAN_DAMAGE,
  RUN_DOWN_SPEED,
  TAKE_HEIGHT,
  TAKE_RADIUS,
  WITNESS_RADIUS,
  bystanderSeen,
  carCrashClosing,
  crashDamage,
  createDrivingScratch,
  resolveTake,
  snapToBay,
  type DrivenCar,
  type DriverView,
} from '../client/src/game/driving.ts';
// The lime e-bikes. Pure, three-free, and the same file the browser runs -- which
// is what makes a claim mean the same thing on both ends. See `game/bikes.ts`.
import {
  BikeField,
  inTuningZone,
  type Bike,
  type RiderView,
} from '../client/src/game/bikes.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { COLOURWAYS } from '../client/src/player/character.ts';
import {
  ANIM,
  BTN,
  EVENT,
  EVENT_FLAG,
  FLAG,
  TICK_HZ,
  sanitiseName,
  suggestName,
  uniqueName,
  type BikeRecord,
  type CarRecord,
  type InvestigationRecord,
  type NetEvent,
  type RosterEntry,
  type SnapshotBall,
  type SnapshotAboard,
  type SnapshotNpc,
  type SnapshotPlayer,
} from '../client/src/net/protocol.ts';
// The factions. Pure, three-free on every path this file touches, and the same
// file the browser runs -- which is what makes a witnessed crime mean the same
// thing on both ends. See `client/src/game/factions.ts`, whose header is the
// contract two more factions are being built against.
import {
  FactionField,
  MAX_ACTORS,
  NPC_KIND,
  REASON,
  reportCrime,
  createBeatPose,
  createWitness,
  npcHitTest,
  npcKind,
  policeWitness,
  strikeNpc,
  type FactionCtx,
  type FactionEvent,
  type NpcActor,
} from '../client/src/game/factions.ts';
// The street factions, on the same terms: `game/streetlife.ts` imports no three
// and registers the two kind bytes `NPC_KIND` reserved. Two entry points are
// used here and nothing else -- one tick of the ambient promotion scan, and the
// rule about whether hitting one of them is a crime.
import { stepStreetlife, strikeCrime } from '../client/src/game/streetlife.ts';
// The heat ladder, on the same terms once more: `game/heat.ts` imports no three
// and registers the two kind bytes `NPC_KIND` reserved for the highway patrol
// and the RBT. Four entry points -- the field, one tick of it, the handle the
// crime funnel reaches it through, and the world record it needs beyond the
// faction context. See that file's header for the design.
import {
  HeatField,
  installHeat,
  stepHeat,
  type HeatWorld,
  type HeatRecord,
} from '../client/src/game/heat.ts';
// --- Workstream E: the five characters and the ambient events.
//
// Same terms again: both modules import no three and both register only bytes
// `NPC_KIND` reserved for them. Four entry points and nothing else -- the
// ambient promotion scan, the "somebody hit a tradie" notification, the Karen's
// witness door, and one tick of the event scheduler with its sweep.
import { characterStruck, karenReport, stepCharacters } from '../client/src/game/characters.ts';
import { stepEvents, sweepEvents } from '../client/src/game/events.ts';
import { setWallet, type WalletLookup } from '../client/src/game/wallet-contract.ts';
// And the wildlife, on the same terms again: `game/wildlife.ts` imports no three
// and registers the three kind bytes `NPC_KIND` reserved for it. Three entry
// points -- the ambient promotion scan, the predicate for "is this one of the
// protected natives", and the crime door itself.
import {
  createWildPose,
  createWildScratch,
  isProtected,
  reportWildlifeCrime,
  stepWildlife,
} from '../client/src/game/wildlife.ts';
import {
  createPedPose,
  forEachPedestrianNear,
  runDownPedestrian,
  strikePedestrian,
  strikePedestrianWithBall,
  type PedBand,
  type PedPose,
} from '../client/src/game/pedestrians.ts';
import { REACH, CAST_RADIUS } from '../client/src/game/combat.ts';
import { BALL_RADIUS } from '../client/src/game/footy.ts';
import { Bot, type BotKind } from './bots.ts';
import { PositionHistory, createBounds, rewindInto, resolveLiveById, type RewoundProxy } from './rewind.ts';
// PERFORMANCE.md phase 1's spatial hash. Pure, three-free, shared with the
// browser on every other module's terms -- and the structure phase 2's interest
// management is going to query, which is why its `forEachWithin` / `nearestK`
// are a stated API rather than whatever the melee happened to need. See its
// header.
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { eyeAt, groundFor, layOutBikes, type ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';

import { railSeconds, SPAN_TUNNEL } from '../client/src/game/rail.ts';
import {
  aboardFrame,
  aboardPose,
  alightPlatform,
  alightTrackside,
  bailoutDamage,
  clearAboard,
  consistOf,
  createBoardOffer,
  createCarFrame,
  createCarriageStand,
  dirOf,
  interiorOfCar,
  isAboard,
  nextCall,
  RIDER_CARRIAGE_SPAN_M,
  localToWorld,
  spanFlagsAt,
  stopPlatform,
  worldToLocal,
  type CarFrame,
  type Vec3Out,
  boardHere,
  rideEnter,
  rideExit,
  RIDE_ON,
  RIDE_TRIP_GONE,
} from '../client/src/game/riding.ts';

// --- Money. See `client/src/game/cash.ts`, `server/wallets.ts`, `server/fares.ts`.
//
// One block, and everything behind it is a module of its own: the rules are
// shared with the browser (a fare has to pay the same on the HUD as in the
// ledger), the persistence is a file this class never touches directly, and the
// fare's state machine is `server/fares.ts` for the reason its header gives.
// What is left in this file is the four places money meets the simulation --
// a knockout, a pickup, a claim and a tick.
import {
  CENTRELINK_PAYMENT,
  CLAIM_RADIUS_M,
  MAX_BUNDLES,
  BUNDLE_SECONDS,
  claimWaitMs,
  dropOnDeath,
  formatMoney,
  nearestOffices,
  officeAt,
  passengerLine,
  tickBundles,
  type CashBundle,
  type CentrelinkOffice,
  type WalletRecord,
} from '../client/src/game/cash.ts';
// --- Workstream I: what a knocked-over NPC is worth, and how fast. One import,
// one field on the participant, and one call from `hitNpc`. The table, the rate
// bank and the note's design are all in the three-free module so
// `verifyCashDrops` can assert them on both ends. See `game/cashnote.ts`.
import { bankAllow, createNpcCashBank, npcDropAmount, type NpcCashBank } from '../client/src/game/cashnote.ts';
import { type DrivingLookup } from '../client/src/game/driving-contract.ts';
import { createFare, stepFare, type FareContext, type FareJob } from './fares.ts';
import { moveBalance, type WalletStore } from './wallets.ts';
import type { WalletFrame } from '../client/src/net/cash.ts';
// --- Accounts and the level ladder. See `client/src/net/accounts.ts` for the
// rules, `server/accounts.ts` for the store, and workstream G's brief for the
// three gates. One block, on the money block's terms one comment up: what is
// left in *this* file is the three places an account meets the simulation --
// which wallet a joiner opens, what a knockout does to the ladder, and the
// sentence a guest is shown when they cross $100.
import { levelFor } from '../client/src/net/accounts.ts';
import type { AccountRecord, AccountStore, LiveSpot } from './accounts.ts';

export const FIXED_DT = 1 / TICK_HZ;

/**
 * How far apart the join spots are, metres, and how many before the ring widens.
 *
 * Sixteen players landing on one tile centre would spawn inside each other,
 * which resolves as everybody being ejected in a random direction on the first
 * tick. A 9 m ring of eight is far enough apart to be a fight rather than a
 * scrum and near enough that everybody can see everybody.
 */
/**
 * One driven car as the wire wants it. Here rather than inline at the two call
 * sites so the field list cannot drift between the joiner's set and a delta.
 */
function carRecord(c: DrivenCar): CarRecord {
  return {
    id: c.id,
    carId: c.carId,
    driver: c.driverId,
    body: c.body,
    colour: c.colour,
    x: c.x,
    y: c.y,
    z: c.z,
    yaw: c.yaw,
    speed: c.speed,
    health: c.health,
  };
}

/** The "nothing changed" answer from `carDelta`, so a quiet tick allocates nothing. */
const EMPTY_CARS: readonly CarRecord[] = [];

const JOIN_RING = 9;
const JOIN_PER_RING = 8;

/** One connected player or one bot. */
export interface Participant {
  readonly id: number;
  readonly colourway: number;
  readonly bot: Bot | null;
  /**
   * What the kill feed calls this player, sanitised **here** and unique in this
   * session.
   *
   * Assigned rather than granted, on exactly the argument the colourway above it
   * is: what a client sends is a request. The server runs `sanitiseName` over it
   * again -- the client already did, and a client is not a thing whose output is
   * trusted -- and `uniqueName` makes the second Bazza "Bazza (2)", because two
   * identical rows on a scoreboard is a scoreboard that has stopped working.
   */
  name: string;
  /**
   * Knockouts credited to this player, and times this player was knocked out.
   *
   * Per session and not persisted -- spec 12 rules out storage, so an id is a
   * connection and a disconnect is the end of a record. Both are `u16` on the
   * wire and neither can realistically reach it: a knockout is a few a minute.
   */
  kos: number;
  downs: number;
  /**
   * Round trip in ms, as this client last reported it. 0 for a bot.
   *
   * Display only, and `protocol.encodePing` says at length why it is the one
   * client-supplied number here and what it is deliberately not wired to: the
   * rewind uses `Conn.rtt`, which lives on the connection and is measured by the
   * server at the WebSocket framing layer rather than taken from any packet the
   * client composed. See `room.HEARTBEAT_MS`.
   */
  ping: number;
  combat: CombatantState;
  /** This participant's own world, carrying its own last-known ground. See `groundFor`. */
  world: CombatWorld;
  history: PositionHistory;
  /** The last input applied, held so a dropped packet repeats rather than stops. */
  input: CombatInput;
  /** The seq of that input, echoed in this client's snapshots for reconciliation. */
  ackSeq: number;
  /**
   * How far back this client's view is, in ticks, for spec 8.2's rewind.
   *
   * The round trip plus the client's own interpolation delay, which is what the
   * attacker was actually looking at: a remote is drawn 100 ms in the past by
   * design (spec 10) *on top of* a snapshot that is already a downlink trip old,
   * and the swing itself took an uplink trip to arrive. `Room.step` derives it
   * term by term and says why it is a whole trip rather than the textbook half.
   */
  viewTicks: number;
  /**
   * Whether `E` was already down last tick, for the mount toggle's rising edge.
   *
   * On the participant rather than on the combatant because it is a fact about
   * *this connection's* keyboard rather than about the body: it is not
   * simulation state, nothing replays it, and it must not be in a snapshot. See
   * `protocol.BTN.MOUNT` for why the edge is detected here rather than sent.
   */
  mountHeld: boolean;
  /** Set when the socket closes; the combatant leaves on the next tick. */
  gone: boolean;

  // --- Money. See `client/src/game/cash.ts`.
  /**
   * This player's wallet, or **null for a bot**.
   *
   * Null rather than an empty record, so that every money path in this file
   * begins with the same three-character test and a bot cannot accidentally
   * acquire a balance by being handed one somewhere. `server/wallets.ts`'s
   * header says why a bot must not have one: it would put a row in the file for
   * every room on the host at every restart, and a bot that *dropped* money on
   * death would make farming the two bots in your room the best-paying job in
   * Sydney.
   *
   * The record is **shared with the store**, not copied: it is the object in
   * `WalletStore`'s map, so mutating `balance` here is what gets written to
   * disk on the next debounce. Two players with the same name in two rooms
   * therefore share one object, which is the honest consequence of keying on a
   * name and is stated in the store's header.
   */
  wallet: WalletRecord | null;
  /** Bumped whenever anything in the wallet frame changes. `Room` compares it. */
  walletVersion: number;
  /**
   * Why the balance last moved -- "+$34 fare" -- pending delivery.
   *
   * Cleared by `walletFrame` the moment it is read, so it is sent once and
   * never repeats: this is a moment, and the pill it lands in is
   * `hud.notice`'s. See `net/cash.WalletFrame.note`.
   */
  walletNote: string;
  /** The rideshare shift and whatever fare is running on it. See `server/fares.ts`. */
  fare: FareJob;

  // --- Accounts. See `client/src/net/accounts.ts`.
  /**
   * The account this participant is logged in as, or **null for a guest**.
   *
   * Null rather than an empty record, on `wallet`'s argument exactly: every
   * account path in this file begins with the same three-character test, and a
   * guest cannot accidentally acquire a ladder by being handed one somewhere.
   *
   * The record is **shared with the store**, not copied -- it is the object in
   * `AccountStore`'s map -- so incrementing `kills` here is what gets written to
   * disk on the next debounce. That is the same bargain `wallet` strikes and it
   * has the same consequence: one person logged in twice is two participants
   * mutating one record, which is correct (their kills add up) rather than a
   * race, because this process is single-threaded and neither of them is
   * reading the value across an `await`.
   *
   * A bot never has one. There is nothing to log a bot into.
   */
  account: AccountRecord | null;
  /**
   * `account?.id ?? null`, kept as a field because it is the **contract** other
   * workstreams were told to expect and because it is what the wallet is keyed
   * by. Duplicating one string off the record beside it is cheaper than making
   * every reader reach through a nullable object for the only field of it they
   * are entitled to.
   */
  accountId: string | null;
  /**
   * What the roster carries and the plate draws. 1 for a guest, always.
   *
   * Mirrored onto the participant rather than read off `account` at roster time
   * for one reason and it is a real one: `roster()` runs several times a second
   * over every participant in the room and is on PERFORMANCE.md's
   * allocation-free path, and a `p.account?.level ?? 1` there is a nullable
   * dereference per player per refresh to read a number that changes a few times
   * an evening. This is written on join and on the two events that can move it.
   */
  level: number;
  /**
   * This player's NPC income over the last minute, so a spawn cannot be farmed.
   *
   * Three numbers on the participant rather than a `Map` on the simulation,
   * because the alternative is a map that has to be cleaned on leave and a
   * lookup on the knockout path -- and because the lifetime being asked for is
   * exactly a participant's. See `game/cashnote.NpcCashBank`, which owns the
   * arithmetic and states why it is a two-bucket sliding counter.
   */
  npcCash: NpcCashBank;
  /**
   * Did this participant spawn where they logged off, rather than in the disc?
   *
   * Written once, in `join`, and read once, by `Room.welcome`, which puts it on
   * the wire as protocol v15's `WELCOME` flag. It is on the participant rather
   * than returned from `join` because `welcome` is a separate call on a separate
   * object and threading a second return value through `Room.join` would be a
   * parameter every caller has to carry to hand one bit to one line.
   *
   * False for every guest and every bot, always. See `Simulation.join`.
   */
  restored: boolean;
  /**
   * Has this guest already been asked to sign up, this session, for each reason?
   *
   * A bitfield of `PROMPTED.*` rather than two booleans, so adding a third gate
   * later is a constant rather than a field -- and so that "once per session" is
   * visibly one rule rather than two that drifted. Never set for an account: the
   * prompts are the whole of what a guest is shown and an account has already
   * answered them.
   */
  prompted: number;
}

/**
 * The sign-up prompts a guest can be shown, once each per session.
 *
 * *"more than 100 dollars (would u like to save progress)?"* and *"sign up to
 * level up"*. Both are **once**, and the once is what makes them a nudge rather
 * than nagging: a player who has decided not to sign up crosses $100 again every
 * few minutes and reaches a level threshold every ten kills, and a prompt on
 * each would be the game arguing with a decision they already made.
 */
export const PROMPTED = {
  /** Crossed `SAVE_PROMPT_BALANCE`. */
  MONEY: 1,
  /** Earned enough kills that an account would have levelled. */
  LEVEL: 2,
} as const;

/**
 * The balance at which a guest is asked whether they want to keep it.
 *
 * $100, from the brief. Worth stating why the number is a *threshold crossing*
 * rather than a state: a player who is asked the moment they go over and says
 * no should not be asked again when they drop to $90 and climb back, which is
 * what testing `balance >= 100` every tick would do. The `PROMPTED.MONEY` bit is
 * what makes it a crossing.
 *
 * **Nothing is taken from them.** The brief is explicit and it is worth having
 * in the code beside the constant, because the obvious next feature -- a cap on
 * what a guest can hold -- is exactly the wall this whole design refuses to be.
 */
export const SAVE_PROMPT_BALANCE = 100;

export interface TickOutput {
  tick: number;
  events: NetEvent[];
  /** Filled on snapshot ticks only. */
  snapshot: SnapshotPlayer[] | null;
}

export class Simulation {
  readonly world: ServerWorld;
  readonly participants = new Map<number, Participant>();
  /** The tick order and the hit-test target list. Rebuilt only when someone joins or leaves. */
  private combatants: CombatantState[] = [];
  private ordered: Participant[] = [];
  private dirty = true;
  /**
   * The combatant list, by id. Rebuilt with it.
   *
   * PERFORMANCE.md phase 1: `rewind.resolveLive` walked the whole roster on
   * every landed punch to turn a rewound proxy back into the body it stands
   * for, which is one of the four places the tick was linear in the player
   * count for no reason. Every id here is a participant id, because
   * `createCombatant(id, ...)` is handed the participant's own.
   */
  private readonly byId = new Map<number, CombatantState>();

  /**
   * Where everybody **could be rewound to**, and where everybody **is**.
   *
   * Two builds a tick rather than one, and the split is not an optimisation --
   * the two answer different questions and a single index would be wrong for
   * one of them:
   *
   *   - `rewindIndex` is built at the top of the tick from each player's
   *     `PositionHistory.bounds`, so it is a superset of every position spec
   *     8.2's lag compensation can resolve a target to. The melee queries it,
   *     because a punch is evaluated against the past.
   *   - `liveIndex` is built **after every combatant has advanced** from the
   *     positions they finished the tick at. The balls and the pickups query
   *     it, because both of those are deliberately not rewound -- see
   *     `game/footy.stepFooty` and the ordering note in `step`.
   *
   * Cell 8 m, PERFORMANCE.md's number. Phase 2's AOI will query `liveIndex`
   * (or a coarser sibling; see `game/spatialhash.ts`) and needs nothing added
   * here.
   */
  private readonly rewindIndex = new SpatialHash<CombatantState>();
  private readonly liveIndex = new SpatialHash<CombatantState>();
  private readonly boundsScratch = createBounds();
  /** Candidates for one swing, and the pooled proxies they are rewound into. */
  private readonly strikeCandidates: CombatantState[] = [];
  private readonly strikeProxies: RewoundProxy[] = [];

  /**
   * Where the tick went, in milliseconds, accumulated since the last read.
   *
   * PERFORMANCE.md phase 1's deliverable is a capacity curve with a phase
   * breakdown, and a breakdown that is not measured in the process being
   * measured is a guess. Nine `performance.now` pairs a tick is about 2 us
   * against a 16,667 us budget, so this is on permanently rather than behind a
   * flag: a profile you have to remember to enable is a profile that is not
   * running the day something regresses.
   *
   * Read and reset by `server/index.ts`'s `/stats`.
   */
  readonly phaseMs = {
    index: 0,
    advance: 0,
    melee: 0,
    balls: 0,
    traffic: 0,
    powerups: 0,
    bikes: 0,
    cars: 0,
    npc: 0,
    history: 0,
  };

  tick = 0;
  private nextId = 1;
  private joinIndex = 0;

  /**
   * Bumped whenever anything on the scoreboard **except a ping** changes.
   *
   * The transport watches this rather than being told, which is what keeps a
   * roster broadcast out of this file: `index.ts` compares the number against
   * the one it last sent and encodes if they differ. Pings deliberately do not
   * bump it -- they move continuously and would turn an on-change message into a
   * per-tick one, which is the whole thing `protocol.encodeRoster` argues
   * against. They ride the slow refresh instead.
   */
  rosterVersion = 0;

  private readonly histories = new Map<number, PositionHistory>();
  private readonly rewindPool: CombatantState[] = [];

  /**
   * Every football in the air, for the whole world.
   *
   * One field rather than one per participant, because a ball outlives its
   * thrower's tick and can outlive their *session*: a player who disconnects
   * mid-throw leaves a ball that still has to fly, bounce and possibly knock
   * somebody over. It is the same `FootyField` the browser runs, from the same
   * file, which is the property `verifyFooty` and the integration check between
   * them exist to keep true.
   */
  private readonly balls = new FootyField();
  private readonly ballEvents: FootyEvent[] = [];
  /**
   * The world every ball is flown against.
   *
   * Deliberately **its own** `groundFor` closure rather than a participant's.
   * `groundFor` carries a `lastGround` that remembers the last tile it had
   * terrain for -- see `server/world.ts` -- so sharing a thrower's would make a
   * ball's ground query depend on where that player happened to be standing,
   * and two balls in the air would perturb each other through it. One closure
   * for the projectiles keeps the arithmetic a function of the ball alone.
   */
  private readonly ballWorld: CombatWorld;
  /**
   * The world the factions walk against, with its own `lastGround`.
   *
   * Its own closure rather than a participant's or the balls', on exactly
   * `ballWorld`'s argument: `groundFor` remembers the last tile it had terrain
   * for, so sharing one would make an officer's ground query depend on where a
   * player happened to be standing, and two pursuits would perturb each other
   * through it.
   */
  private readonly factionWorld: CombatWorld;
  /**
   * `applyFootyHit` takes its report rather than allocating one, because
   * `game/footy.ts` imports nothing from three and cannot construct a
   * `Vector3`. One for the process, made through `combat.createHitReport` --
   * which is also why that helper exists, since **no file under `server/` may
   * import three**; see `hitReport` below for what a second copy of `Vector3`
   * in this process would do.
   */
  private readonly ballReport: HitReport = createHitReport();
  /**
   * Scratch for the swat's ball rewind, allocated once for the life of the
   * process.
   *
   * `swatBalls` writes each candidate ball's rewound position into it and
   * consumes the answer before the next one, on `carPose`'s terms exactly: the
   * query is synchronous, nothing holds it across a line, and the alternative is
   * a record per ball per active tick of every swing in the room. See
   * `game/swat.ts`.
   */
  private readonly swatScratch = createBallAt();

  /**
   * Scratch for the traffic query, allocated once for the life of the process.
   *
   * `carHitting` is called once per combatant per tick -- 960 times a second at
   * spec 2's cap -- and both of these would otherwise be a fresh array and a
   * fresh record every one of them. Safe to share because the query is
   * synchronous and its results are consumed before the next call: nothing here
   * holds a pose or a route list across a line.
   */
  private readonly carRoutes: LaneRoute[] = [];
  private readonly carPose: CarPose = createCarPose();
  private readonly snapshotBalls: SnapshotBall[] = [];
  /**
   * The last hit, for the event that follows it.
   *
   * `applyHit` allocates a fresh `HitReport` when it is not handed one, and it
   * is not handed one here -- which is the one place in this process that
   * allocates per event rather than per process, and it is deliberate. The
   * report's `point` is a `three` `Vector3`, and **no file under `server/`
   * imports three**: the shared modules resolve it out of `client/node_modules`,
   * so a second import path here would give this process a second `Vector3`
   * class and every `instanceof` in the shared code two answers. A knocked-out
   * player is a handful of objects a second; a duplicated class is a bug that
   * only appears under a specific bundler.
   */
  private hitReport: HitReport | null = null;
  private readonly pickups: PickupEvent[] = [];
  private readonly events: NetEvent[] = [];

  /**
   * Every lime e-bike in the city, and the authority on who is on one.
   *
   * Placed once at boot rather than streamed, on `server/world.ts`'s own
   * argument about the collision prisms: this process holds the whole extent
   * already, and 74 bikes is 74 records.
   *
   * `game/bikes.bikePlan` fixes the set and the ids from the tile index, so a
   * browser computes the same ids from the same file -- but the *placement* is
   * done here and sent, because it consults prisms a streaming client may not
   * have. See `protocol.encodeBikes` for that argument in full.
   */
  readonly bikes = new BikeField();
  /**
   * Every car anybody in this room has taken, and the authority on who is in one.
   *
   * **Not laid out at boot**, which is the whole way this differs from the bikes
   * above: there is no plan and no fixed set, because a car record exists only
   * for as long as somebody has stolen a car and not yet abandoned it. The field
   * starts empty in every process and stays that way in a room nobody has
   * stolen anything in, which is what makes the feature cost nothing until it is
   * used.
   *
   * Public and named `cars` because the workstream contract says so: other
   * passes reach `Simulation.cars` for the `DrivingLookup` on it.
   */
  readonly cars = new CarField();
  /** Records that changed this tick, for `room.sendCars`. Reused; see `bikeChanges`. */
  private readonly carChanges: DrivenCar[] = [];
  /**
   * Ids the budget recycled this tick, likewise.
   *
   * This used to be "ids that expired". Nothing expires now -- see
   * `game/driving.ts` section 6 -- so the only thing that ever lands here is a
   * record `CarField.recycleFarthest` freed to make room for a four hundred and
   * first theft, which is once per room per four hundred cars.
   */
  private readonly carRemovals: number[] = [];
  private readonly carSweep: DrivenCar[] = [];
  private readonly driverViews: DriverView[] = [];
  /**
   * Scratch for `resolveTake` and for the driven fleet's own hit tests, on
   * `carRoutes`/`carPose`'s argument: this runs per driven car per tick and per
   * `E` press, and a fresh array and a fresh pose for each of them is the
   * allocation this class spends its whole budget avoiding.
   */
  private readonly takeScratch = createDrivingScratch();
  private readonly drivenPose: CarPose = createCarPose();
  /**
   * Where every participant is, as a flat `[x, z, ...]`, for
   * `CarField.recycleFarthest`.
   *
   * Rebuilt only when the budget is actually reached -- which is once per room
   * per four hundred thefts -- rather than every tick, and reused rather than
   * allocated so the rare case is not also an allocating case.
   */
  private readonly recycleScratch: number[] = [];
  /** Scratch for the bay snap when a driver gets out. See `parkOnLeave`. */
  private readonly bayScratch: LaneRoute[] = [];
  private readonly bayProbe: BayPose = createBayPose();
  /**
   * The roster the ambient traffic yields to, handed to the traffic field once a
   * tick. See `traffic.HoldLedger`.
   *
   * Reused and rebuilt in place: the whole point of the ledger is that it costs
   * nothing in a room where nobody has taken a car, and an array of four hundred
   * object literals a tick would be the one part of it that did.
   */
  private readonly blockers: Array<{ x: number; y: number; z: number; halfLength: number }> = [];
  /**
   * The factions, and every investigation running against a player.
   *
   * One field for the process, on the bikes' own argument: a police officer
   * pursuing somebody outlives the tick that promoted them and can outlive the
   * *session* of the player who reported the crime. The same class the browser
   * runs offline, from the same file, which is the property `checkPolice` exists
   * to keep true.
   */
  readonly factions = new FactionField();
  /**
   * The graded response: how wanted every player is, and everything the ladder
   * has put on the road. See `client/src/game/heat.ts`.
   *
   * Beside `factions` rather than inside it, on the bikes' own argument: the
   * investigation is a fact about the police and the ladder is a fact about the
   * *player*, it outlives any one pursuit, and the two have different lifetimes
   * on the wire -- `MSG.INVESTIGATION` is a countdown a client extrapolates and
   * `MSG.HEAT` is a level it must not.
   */
  readonly heat = new HeatField();
  /**
   * The two things the ladder needs that `FactionCtx` does not carry, built once
   * and never rebuilt: `stepFactions`' own discipline about the context, applied
   * to a record with two members.
   */
  private readonly heatWorld: HeatWorld;
  private readonly heatRecordPool: HeatRecord[] = [];
  /**
   * Scratch for the wildlife's ambient query, so a 60 Hz tick allocates nothing.
   *
   * Per simulation rather than per module, on `carRoutes`/`carPose`'s argument
   * and one more of its own: the integration check builds two `Simulation`s in
   * one process to prove they agree, and a module-level buffer shared between
   * them would be the one piece of state that could carry an answer from one
   * into the other.
   */
  private readonly wildScratch = createWildScratch();
  private readonly wildPose = createWildPose();
  /**
   * Bumped whenever an investigation opens, closes, changes reason, or a client
   * needs the current set.
   *
   * Watched by the transport rather than pushed, which is exactly how
   * `rosterVersion` above works and for the same reason: it keeps a broadcast
   * out of this file. The countdown itself deliberately does **not** bump it --
   * it moves every tick and would turn an on-change message into a per-tick one,
   * which is the whole thing `protocol.encodeInvestigations` argues against. It
   * rides a slow refresh instead, and the client runs the clock down between
   * them.
   */
  investigationVersion = 0;
  private readonly investigationRecords: InvestigationRecord[] = [];

  /**
   * The crowd, on the server, for one purpose: **witnesses and re-adjudication**.
   *
   * Nothing here draws a pedestrian and nothing here poses one per tick. What
   * this field is for is that a client claiming to have batted a bystander is a
   * client making a claim, and the answer to a claim in this project is always
   * the same -- re-run it. `resolveStrike` below runs the identical
   * `strikePedestrian` the browser ran, against the server's own bands at the
   * server's own tick, and the crime is opened off *that* result. A client that
   * deleted its own call would still be under investigation; a client that
   * fabricated one would not.
   */
  private readonly pedBands: PedBand[] = [];
  private readonly pedPose: PedPose = createPedPose();
  private readonly witnessBands: PedBand[] = [];
  private readonly witnessPed: PedPose = createPedPose();
  private readonly witnessBeat = createBeatPose();
  private readonly witness = createWitness();
  private readonly npcRecords: SnapshotNpc[] = [];
  /** Faction events this tick -- shots, barks, knockdowns -- for the transport. */
  private readonly factionEvents: FactionEvent[] = [];
  /**
   * Whether each player was riding a tuned bike in front of police last tick.
   *
   * The ride-by is a *state* rather than an event -- a player on a modified bike
   * is committing the offence continuously -- so without an edge it would open
   * an investigation sixty times a second and the countdown would never move off
   * its cap. This is the edge: the crime fires when a tuned rider comes into a
   * witness's view, and again only after they have left it. Keyed on the
   * participant rather than the combatant for `mountHeld`'s reason -- it is a
   * fact about this connection's recent history, nothing replays it, and it must
   * not be in a snapshot.
   */
  private readonly seenRiding = new Map<number, boolean>();

  /** Bikes whose rider or position changed this tick, for the transport to send. */
  private readonly bikeChanges: Bike[] = [];
  /** Reused by `follow`, so a tick with nobody riding allocates nothing. */
  private readonly bikeSweep: Bike[] = [];
  private readonly riderViews: RiderView[] = [];

  // --- The trains. See `game/riding.ts`, and `resolveMount` for the one place
  //     a client's claim to be standing beside an open door is adjudicated.
  /**
   * The rail clock for this tick, seconds. One read of the wall clock, shared.
   *
   * One read rather than one per participant, and it is the same discipline
   * `stepFactions` applies to `trafficTick(Date.now())`: two participants
   * resolved against two different instants would be two participants boarding
   * two different positions of the same train.
   */
  private railT = 0;
  /**
   * Where the rail clock comes from. `Date.now` in production, always.
   *
   * A seam rather than a call, for `checkInputQueue`'s reason stated about a
   * different clock: *a measurement of a network taken over a real one is a
   * measurement of the afternoon*. A ride from St Peters to Central is four
   * minutes of railway and twelve hundred ticks, and twelve hundred ticks run in
   * about a second -- so a check that read the wall clock would step the whole
   * journey while the train moved eleven metres, and would prove nothing about
   * riding at all. `checkRiding` drives this at the tick rate; nothing else ever
   * assigns to it.
   */
  railNowMs: () => number = Date.now;
  /** The carriage a body is being stepped inside, aimed per participant. */
  private readonly carriage = createCarriageStand();
  /** Set for the length of one `advance` when the body above is in a carriage. */
  private carriageFrame: CarFrame | null = null;
  private readonly frame = createCarFrame();
  private readonly boardOffer = createBoardOffer();
  private readonly landing: Vec3Out = { x: 0, y: 0, z: 0 };
  /** Pooled aboard records, on `snapshot`'s terms. Keyed for `Room.fill`. */
  private readonly aboardPool: SnapshotAboard[] = [];
  readonly aboardById = new Map<number, SnapshotAboard>();

  /** See `stepFactions`, which mutates the two members that change and nothing else. */
  private factionCtx!: FactionCtx;

  // --- Money ---------------------------------------------------------------
  //
  // Four members and one facade. Everything else about the wallet lives in
  // `server/wallets.ts` (the file on disk), `server/fares.ts` (the job) and
  // `client/src/game/cash.ts` (the rules), for the reason the import block at
  // the top of this file gives.

  /**
   * Where balances are kept, or null in a world with no persistence.
   *
   * Null is the ordinary case for **every check in this repo**:
   * `verifySim`, `server/integration-check.ts` and `server/loadtest.ts` all
   * build a `Simulation` with one argument, and a store defaulted into
   * existence there would be twenty checks writing a wallets file into the
   * repository. So the store is injected by `server/index.ts` and by nothing
   * else, and a null store means every participant's `wallet` is null and every
   * money path in this file is skipped by the same test a bot is.
   */
  private readonly wallets: WalletStore | null;

  /**
   * Where accounts are kept, or null in a world with no persistence.
   *
   * Null is the ordinary case for every check in this repo, verbatim for
   * `wallets`' reason one field up: `verifySim`, `server/integration-check.ts`
   * and `server/loadtest.ts` all build a `Simulation` with one argument, and a
   * store defaulted into existence there would be twenty checks writing an
   * accounts file into the repository. Injected by `server/index.ts` and by
   * nothing else; a null store means every participant is a guest and every
   * ladder path in this file is skipped by the same test a bot is.
   */
  private readonly accounts: AccountStore | null;

  /**
   * Who is driving what. See `client/src/game/driving-contract.ts`.
   *
   * `NO_DRIVING` by default, which reports every player on foot -- so a build
   * with no cars in it (which is every build until the driving workstream
   * lands) runs the fare loop's "not in a car" branch forever and costs one
   * boolean test per online player per tick.
   */
  readonly driving: DrivingLookup;

  /** Every cash bundle lying on the ground in this room. Capped, swept, room-wide. */
  private readonly bundles: CashBundle[] = [];
  private nextBundleId = 1;
  private readonly bundlePickups: Array<{ bundle: CashBundle; combatant: CombatantState }> = [];
  /** Bumped when the list changes, so `Room` knows to re-send every wallet. */
  bundleVersion = 0;

  /** Reused by the fare loop; see `server/fares.ts` on why nothing here allocates. */
  private readonly fareBands: PedBand[] = [];
  private readonly fareCtx: FareContext = {
    playerId: 0, tick: 0, dt: FIXED_DT, nowMs: 0,
    x: 0, z: 0, speed: 0, inCar: false, ko: false,
    peds: null as unknown as PedestrianField, bands: this.fareBands,
  };

  /**
   * The money door, and the **only** one anything outside this class may use.
   *
   * `sim.wallet.credit(id, 34, 'fare')` rather than a method on `Simulation`,
   * because the brief for this feature named exactly this surface and because
   * grouping it says what it is: three verbs about one resource, none of which
   * any other part of the simulation should be reaching around.
   *
   * The `why` is not decoration. It becomes the sentence in the next `WALLET`
   * frame -- see `net/cash.WalletFrame.note` for why the *server* composes it
   * rather than the client deriving one from the delta -- and a credit with no
   * reason is money that appears on a HUD with nothing to explain it.
   */
  /**
   * `this.wallet` on the characters module's terms: `debit` reports what was
   * taken as a **positive** number where the door below reports the movement
   * as a negative one. See `game/wallet-contract.WalletLookup`.
   */
  private readonly walletLookup: WalletLookup = {
    debit: (playerId, amount, why) => -this.wallet.debit(playerId, amount, why),
    credit: (playerId, amount, why) => {
      this.wallet.credit(playerId, amount, why);
    },
    balanceOf: (playerId) => this.wallet.balanceOf(playerId),
  };

  readonly wallet = {
    /** Pay a player. Returns what actually landed, after the cap. */
    credit: (playerId: number, amount: number, why: string): number =>
      this.moveWallet(playerId, Math.abs(Math.trunc(amount)), why),
    /**
     * Take money off a player. Returns what actually moved, **negative**, which
     * is how a caller learns a debit was short: a player on $3 asked for $10
     * gets -3 back, not -10, and the caller decides whether that is a purchase
     * or a refusal. Nothing in this pass debits; the door exists because the
     * sinks are the next thing anybody builds.
     */
    debit: (playerId: number, amount: number, why: string): number =>
      this.moveWallet(playerId, -Math.abs(Math.trunc(amount)), why),
    /** What this player has, or 0 for a bot and for an id that has left. */
    balanceOf: (playerId: number): number =>
      this.participants.get(playerId)?.wallet?.balance ?? 0,
  };

  constructor(
    world: ServerWorld,
    options: { wallets?: WalletStore; driving?: DrivingLookup; accounts?: AccountStore } = {},
  ) {
    this.world = world;
    this.wallets = options.wallets ?? null;
    // Beside `wallets` in the options bag, which is the contract workstream G
    // published: the two stores are the host's, shared across every room on it,
    // and are the only two things in this constructor that outlive the process.
    this.accounts = options.accounts ?? null;
    // The real thing by default, now that the driving workstream has landed:
    // the fare loop asks `this.cars` who is driving what, and `NO_DRIVING`
    // survives only as the answer a caller gets when it explicitly asks for
    // nothing (`SYDNEY_FAKE_DRIVING=1` passes the sprint hatch instead).
    this.driving = options.driving ?? this.cars;
    this.fareCtx.peds = world.peds;
    this.ballWorld = groundFor(world);
    this.factionWorld = groundFor(world);
    this.factionCtx = {
      tick: 0,
      dt: FIXED_DT,
      collision: world.collision,
      groundHeight: (x, z, feet) => this.factionWorld.groundHeight(x, z, feet),
      peds: world.peds,
      combatants: this.combatants,
      field: this.factions,
      investigationOf: (id) => this.factions.investigationOf(id),
      damagePlayer: (id, pips, actor) => this.shoot(id, pips, actor),
      emit: (e) => this.factions.events.push(e),
    };
    this.witnessCtx = {
      peds: world.peds,
      collision: world.collision,
      field: this.factions,
      bands: this.witnessBands,
      ped: this.witnessPed,
      beat: this.witnessBeat,
    };
    // The heat ladder's own two members. `lanes` is the same `TrafficField`
    // every car in the city is drawn from -- a patrol car has to drive the
    // roads that exist, not a second set -- and `rideStop` is this file's
    // answer to "what is this player's train doing", which it already resolves
    // every tick for the aboard section and would be a second copy of if
    // `game/heat.ts` imported the rail bake to work it out again.
    this.heatWorld = {
      lanes: world.traffic,
      rideStop: (id) => this.rideStop(id),
      // And who is a bot, which only Polair's marksman asks: a helicopter firing
      // rounds at a bot is a pip nobody sees taken off somebody nobody is
      // playing. Bots still climb the ladder and still get cars, roadblocks and
      // converging officers, because those are all visible to the people who are
      // playing. See `game/heat.HeatWorld.isBot`.
      isBot: (id) => (this.participants.get(id)?.bot ?? null) !== null,
    };
    // The handle `factions.accuse`'s crime funnel reaches this field through.
    // One authority per process; see `heat.installHeat`.
    installHeat(this.heat);

    // The bikes, laid out from the same tile index every client reads and
    // snapped to the same ground the players walk on.
    //
    // **The layout arrives on the world rather than being computed here**, and
    // that changed when collision stopped being whole. `loadWorld` walks the
    // hexagons once at boot and places each hexagon's bikes while its prisms are
    // resident; a room built later would test the same plan against whatever
    // happened to be loaded at the time and park bike 412 somewhere room 1 did
    // not. See `world.layOutBikes`.
    //
    // The fallback is for the worlds the checks build by hand -- `verifySim`'s
    // empty city among them -- which have no `bikeSpots` and no hexagons either,
    // so laying out here against a fully-resident (or entirely empty) world is
    // exactly what it always was.
    for (const placed of world.bikeSpots ?? layOutBikes(world)) {
      this.bikes.adopt(placed.id, placed.spot);
    }
  }

  /** Every bike, as the wire wants them. The full set, for a joiner. */
  bikeRecords(): BikeRecord[] {
    return this.bikes.all().map((b) => ({
      id: b.id,
      rider: b.rider,
      x: b.x,
      y: b.y,
      z: b.z,
      yaw: b.yaw,
    }));
  }

  /**
   * What changed this tick. **Owned by this object and reused** -- serialise
   * before the next `step`, which is the contract `TickOutput` already has.
   */
  bikeDelta(): readonly Bike[] {
    return this.bikeChanges;
  }

  /** Every driven car, as the wire wants them. The full set, for a joiner. */
  carRecords(): CarRecord[] {
    return this.cars.all().map(carRecord);
  }

  /**
   * What changed about the cars this tick: takes, releases, and expiries.
   *
   * Two lists folded into one message, because a removal is a record with a
   * flag on this wire -- see `protocol.encodeCars`. Owned and reused, on
   * `bikeDelta`'s contract.
   */
  carDelta(): readonly CarRecord[] {
    if (this.carChanges.length === 0 && this.carRemovals.length === 0) return EMPTY_CARS;
    const out: CarRecord[] = this.carChanges.map(carRecord);
    for (const id of this.carRemovals) {
      // Everything but the id is meaningless on a removal, and is zeroed rather
      // than left at whatever the record held so a decoder that ignored the flag
      // would produce something obviously wrong rather than something plausible.
      out.push({ id, carId: 0, driver: 0, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, removed: true });
    }
    return out;
  }

  // --- Membership -------------------------------------------------------------

  /**
   * Add a player or a bot.
   *
   * Colourway is assigned rather than granted, and it is the first free one
   * rather than the requested one when they collide -- see `protocol.encodeHello`.
   * Telling combatants apart at fifteen metres is `player/character.ts`'s whole
   * argument for having seven kits, and two players in the same singlet throws
   * it away for no benefit to either of them.
   *
   * The **name is assigned on the same terms and for the same reason one step
   * up**: the kit tells two players apart at fifteen metres and the name tells
   * them apart in a kill feed, so a duplicate here defeats the readout the way a
   * duplicate kit defeats the silhouette. `requestedName` is what the client
   * asked for and nothing more -- it is sanitised again here, because the
   * sanitiser that ran in the browser ran inside something the player controls,
   * and deduped against everybody already in the world.
   */
  /**
   * `account` is the record `server/index.ts` resolved from the `HELLO`'s token,
   * or null for a guest. It arrives here rather than being looked up because
   * this class holds no opinion about tokens: the socket layer authenticates and
   * the simulation is handed the answer, which is the same shape the colourway
   * and the name arrive in and the reason this signature has grown rather than
   * this file having learnt about HTTP.
   *
   * **A logged-in participant's name is the handle, not the request.** The
   * caller passes `account.handle` as `requestedName`; `pickName` still dedupes
   * it against the room, because two tabs logged into one account is a real
   * thing a person does and two identical rows on a scoreboard is a scoreboard
   * that has stopped working.
   */
  join(
    preferredColourway: number,
    bot: BotKind | null,
    requestedName = '',
    account: AccountRecord | null = null,
  ): Participant {
    const id = this.allocateId();
    const world = groundFor(this.world);
    /*
     * --- Where this body starts. Workstream N.
     *
     * *"logging off should save my location till next log in."* An account with
     * a spot from this week starts on it; everybody else -- every guest, every
     * bot, every account that has not logged off since Monday -- gets the disc,
     * which is the behaviour that shipped and is still the common path.
     *
     * Three things can refuse the spot and they are deliberately three different
     * files: the **calendar** is `AccountStore.spotFor` (this week or nothing),
     * the **ground** is `game/spawn.restoreSpawnPoint` (a building can have been
     * built over it, a tile can have left the build, the terrain can have
     * moved), and the **world** is whatever `groundFor` answers today. A refusal
     * falls through to the disc with a sentence saying so, because a returning
     * player who silently lands in Sydney Park would read it as the feature not
     * working rather than as their spot being gone.
     *
     * A refused spot is also **forgotten**, not left to be re-tried on every
     * join for the rest of the week: it will not start passing, and a stored
     * position nothing will ever restore is a row on disk saying something
     * untrue. See `AccountStore.clearSpot`.
     *
     * The probe world here is `world` -- this participant's own -- rather than a
     * fresh one, which is the opposite of `joinSpot`'s rule and is correct for
     * the opposite reason: `joinSpot` samples many candidates and must not let a
     * rejected one's ground follow the joiner in, whereas this asks about
     * exactly one point and it is the point the body is about to stand on.
     */
    let remembered: { x: number; z: number; yaw: number } | null = null;
    let lostSpot = false;
    if (account !== null && bot === null && this.accounts !== null) {
      const saved = this.accounts.spotFor(account);
      if (saved !== null) {
        const here = restoreSpawnPoint(saved, world);
        if (here !== null) remembered = { x: here.x, z: here.z, yaw: saved.yaw };
        else {
          lostSpot = true;
          this.accounts.clearSpot(account);
        }
      }
    }
    const restored = remembered !== null;
    const spot = remembered ?? this.joinSpot();
    const combat = createCombatant(id, spot.x, spot.z);
    combat.body.position.y = eyeAt(world, spot.x, spot.z);
    combat.body.yaw = spot.yaw;

    const history = new PositionHistory();
    history.seed(this.tick, combat.body.position.x, combat.body.position.y, combat.body.position.z, spot.yaw);
    this.histories.set(id, history);

    // Named once, here, because the wallet below is keyed on the name that was
    // actually assigned rather than the one that was asked for -- and
    // `pickName` dedupes against the room, so calling it twice would be two
    // chances to disagree about which Bazza this is.
    const name = this.pickName(requestedName, id);

    const p: Participant = {
      id,
      colourway: this.pickColourway(preferredColourway),
      bot: null,
      name,
      kos: 0,
      downs: 0,
      ping: 0,
      combat,
      world,
      history,
      input: {
        forward: 0, right: 0, jump: false, sprint: false,
        yaw: spot.yaw, pitch: 0, punch: false, throwBall: false, mount: false,
      },
      ackSeq: 0,
      // Zero, and for a bot it stays zero for life.
      //
      // `Room.step` recomputes this each tick for every socket in the room from
      // that socket's measured `Conn.rtt`; a bot has no socket to iterate, so it
      // is never revisited. That is the right number rather than a gap left by
      // the loop: lag compensation exists to rewind the world to what an
      // attacker *saw*, and a bot's eyes are `this.participants` at the instant
      // it swings. There is no trip to compensate for and no interpolation
      // delay to undo, so a bot punches the present. `?offline` is the same
      // argument from the other end -- the client is the authority there, the
      // server's rewind is not in the path at all, and `Conn` does not exist.
      viewTicks: 0,
      mountHeld: false,
      gone: false,
      // **The wallet is opened here and only here**, by name, and only for a
      // person. `WalletStore.for` creates on first sight, so a new name's first
      // `WALLET` frame carries `STARTING_BALANCE` rather than a zero that is
      // corrected a moment later. A bot, or a host with no store, gets null and
      // is skipped by every money path in this file. See `server/wallets.ts`.
      // **The wallet is keyed by the account when there is one**, which is the
      // one thing accounts change about money and the reason they change it:
      // `server/wallets.ts`' header says a name is a claim and not proof, so a
      // balance kept under a name can be spent by whoever types it next. An
      // account id cannot be typed. A guest is unchanged and keeps the name key,
      // which is what makes signing up optional rather than a wall -- and
      // `WalletStore.migrateToAccount` is how the guest's balance follows them
      // over on the day they do sign up.
      wallet:
        bot !== null || this.wallets === null
          ? null
          : account !== null
            ? this.wallets.forAccount(account.id)
            : this.wallets.for(name),
      walletVersion: 1,
      walletNote: '',
      fare: createFare(),
      account: bot === null ? account : null,
      accountId: bot === null && account !== null ? account.id : null,
      // The ladder, off the record if there is one. A guest and a bot are both
      // level 1 and stay there for the session; see `RosterEntry.level`.
      level: bot === null && account !== null ? account.level : 1,
      // Made for bots too, and it costs three numbers: a bot swinging at
      // pedestrians would otherwise be the one participant with no cap, and
      // `dropNpcCash` refuses a bot on the wallet test rather than on this one.
      npcCash: createNpcCashBank(),
      // Whether the spawn above is the spot they logged off at. See the block
      // that computed it, and `Room.welcome`, which is the only reader.
      restored,
      prompted: 0,
    };
    // The bot holds the combatant rather than the other way round, so `think()`
    // writes the same `input` object the tick loop reads -- one record, as
    // `dummies.ts` arranged it.
    const participant = bot
      ? { ...p, bot: new Bot(bot, combat, spot.yaw) }
      : p;
    if (participant.bot) participant.input = participant.bot.input;

    this.participants.set(id, participant);
    this.dirty = true;
    this.rosterVersion++;
    this.events.push({
      kind: EVENT.JOIN,
      id,
      colourway: participant.colourway,
      bot: bot ? 1 : 0,
    });
    // After the participant exists, because `note` looks it up by id -- and it
    // is a note rather than a `WELCOME` field because it is an *explanation*
    // rather than a fact about the position: the spawn in the welcome is a
    // perfectly ordinary spawn and the only thing wrong with it is that it is
    // not where they left. Forty characters, in the pill, once.
    if (lostSpot) this.note(id, 'your spot was gone; back at the park');
    return participant;
  }

  /**
   * A participant, flattened into what the account store can hold. Workstream N.
   *
   * The bridge between a body and a row on disk, and it exists here rather than
   * in `server/accounts.ts` because it is the half that needs a world: the
   * position saved is the **ground beneath the body**, not the body's eye and
   * not the seat it is sitting in.
   *
   * **Riding state is not saved, deliberately.** A player who logs off on the
   * T1 to Hornsby has a position that is a fact about a *train* -- by the time
   * they come back that service has terminated, and the brief rules it out in
   * as many words. A player in a stolen Corolla is the same case with a shorter
   * timescale, and there is a second reason there: the car is `server/cars.ts`'
   * and restoring somebody into a vehicle that no longer exists would be a join
   * that has to invent one. So both are dropped to the ground under them, which
   * is where they would have been dropped anyway had they pressed `E`, and the
   * spot is validated on the way back in like any other -- a body in a rail
   * tunnel projects to a point under a building, `restoreSpawnPoint` refuses it,
   * and they start at the park with the sentence that says why.
   *
   * `spawnGround` rather than `groundHeight(x, z, feetY)`: the roofs are taken
   * out, on that function's own argument. Logging off on a warehouse roof and
   * coming back inside the warehouse is worse than coming back on the street.
   */
  carryOf(p: Participant): LiveSpot {
    const x = p.combat.body.position.x;
    const z = p.combat.body.position.z;
    return { name: p.name, kills: p.kos, x, y: spawnGround(p.world, x, z), z, yaw: p.combat.body.yaw };
  }

  /**
   * A socket closed. **This is where a logged-in player's spot is saved.**
   *
   * Here rather than in `Room.leave` or in `server/index.ts`'s close handler
   * because this is the one function every departure goes through, and a spot
   * that is only saved on *some* of the ways out is worse than one that is never
   * saved: a player whose position persists after a tab close and not after a
   * network drop has a feature that works about half the time and no way to tell
   * which half they are in.
   *
   * A guest saves nothing -- there is nowhere to put it -- and a bot has no
   * account by construction. The write is debounced by the store; see
   * `AccountStore.rememberSpot`.
   */
  leave(id: number): void {
    const p = this.participants.get(id);
    if (!p) return;
    if (p.account !== null && this.accounts !== null) {
      this.accounts.rememberSpot(p.account, this.carryOf(p));
    }
    p.gone = true;
  }

  /**
   * The next player id, per `protocol.AOI_ID_LIFECYCLE`.
   *
   * Ascending from 1, **wrapping at 65535 and skipping anybody currently live**,
   * which is protocol v8's requirement and was a latent bug before it: `nextId`
   * was an unbounded JavaScript number written to the wire as a `u8`, so a long
   * session with churn eventually handed out an id that aliased onto somebody
   * already standing there. v8's `u16` moves that from "a busy evening" to
   * "two days of continuous joins", and the skip makes it unreachable rather
   * than merely unlikely.
   *
   * **0 is never allocated.** Three fields on the wire use it as a sentinel --
   * `SnapshotBall.thrower` for a thrower who has left, `BikeRecord.rider` for a
   * bike on its kickstand, `NpcActor.id` for no actor -- so a player 0 would be
   * a player whose thrown balls belonged to nobody and whose bike nobody was on.
   *
   * The skip loop is bounded by the room cap rather than by 65535: it can only
   * run as many times as there are live participants, because that is how many
   * ids are taken. At a 128-player room the worst case is 128 map lookups, once,
   * on the two-days-later tick where the counter wraps into an occupied range.
   */
  private allocateId(): number {
    for (let attempt = 0; attempt <= 65535; attempt++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!this.participants.has(id)) return id;
    }
    // Unreachable: 65,535 ids against a room cap in the hundreds. Throwing
    // rather than returning a duplicate, because a duplicate id is two players
    // sharing a body and there is no frame in which that reads as a join
    // failure.
    throw new Error('no free player id: the room holds 65,535 participants');
  }

  /**
   * What to call a joiner: what they asked for, or something Sydney-flavoured.
   *
   * The fallback is deliberately not `player 7`. A name is the thing that makes
   * a kill feed readable, and a feed of "player 7 batted player 4" is the state
   * this pass exists to get out of -- so a client that sends nothing (an old
   * build, a blank prompt, a name that was entirely zero-width spaces) still
   * gets something a person can say out loud. `suggestName` is the same
   * generator the browser's prompt offers, seeded by the id so a reconnection on
   * the same id is the same name.
   */
  private pickName(requested: string, id: number): string {
    const asked = sanitiseName(requested);
    const base = asked || sanitiseName(suggestName(id));
    const taken: string[] = [];
    for (const p of this.participants.values()) taken.push(p.name);
    return uniqueName(base, taken);
  }

  /**
   * The scoreboard, as `protocol.encodeRoster` wants it.
   *
   * Built fresh rather than kept, because it is produced at most a few times a
   * second (see `rosterVersion`) and a cached copy of five mutable fields is
   * five fields that can go stale in a way nothing renders.
   *
   * In whatever order the map iterates, which is join order. The *board's* order
   * is `protocol.rankRoster`'s and is applied where it is drawn -- sorting here
   * as well would be a second opinion about the same question.
   */
  roster(): RosterEntry[] {
    // Pooled and written in place, which is a change of *contract* rather than
    // only of allocation: the returned array is now owned by this object and
    // reused, exactly as `snapshot`, `investigations` and `bikeDelta` already
    // were. Serialise before the next call.
    //
    // PERFORMANCE.md phase 1. The comment this replaces argued for building
    // fresh "because it is produced at most a few times a second", and that was
    // true at sixteen players -- `rosterVersion` bumps on every knockout, and at
    // five hundred players there are several knockouts a *tick*, so this became
    // a five-hundred-object allocation at 60 Hz. The staleness the old comment
    // worried about is answered by the reuse being total: every field is
    // rewritten on every call.
    const out = this.rosterRecords;
    let n = 0;
    for (const p of this.participants.values()) {
      let s = out[n];
      if (s === undefined) {
        s = { id: 0, colourway: 0, bot: false, name: '', kos: 0, downs: 0, ping: 0, level: 1, kills: 0 };
        out.push(s);
      }
      s.id = p.id;
      s.level = p.level;
      // The ladder's own kill count, which the HUD's XP bar fills from.
      //
      // **The account's persisted weekly count if there is one, and the session
      // KOs if there is not.** Both branches are the truth about the player they
      // describe: an account's ladder position is `AccountRecord.kills` and
      // survives a reconnect, and a guest has nowhere durable to keep one, so
      // what their bar shows is what they have done since they joined. The
      // guest's bar is clamped full at ten and labelled "sign up to level up" --
      // see `game/levelhud.levelLine` -- so it is never claiming progress that
      // is not happening.
      //
      // Read off `p.account` rather than mirrored onto the participant the way
      // `level` is, and the asymmetry is deliberate: `level` was mirrored
      // because it changes a few times an evening and this runs several times a
      // second, but `kills` changes on *every knockout* -- so a mirror would be
      // a second field to keep in step with the record beside it, updated on the
      // same path, to save one nullable dereference per player per refresh. The
      // dereference is the cheaper of the two.
      s.kills = p.account !== null ? p.account.kills : p.kos;
      s.colourway = p.colourway;
      s.bot = p.bot !== null;
      s.name = p.name;
      s.kos = p.kos;
      s.downs = p.downs;
      // A bot has no socket and therefore no round trip. Zero is drawn as a
      // dash rather than as "0 ms", which would be a lie about the best
      // connection in the game.
      s.ping = p.bot ? 0 : p.ping;
      n++;
    }
    out.length = n;
    return out;
  }

  private readonly rosterRecords: RosterEntry[] = [];

  /**
   * Credit a knockout, and count the fall.
   *
   * One place rather than two, because there are two ways to be knocked out --
   * the bat and a thrown ball -- and they are adjudicated in different parts of
   * the tick. A second copy of this arithmetic beside the football would be the
   * copy that stopped counting when one of the two weapons changed.
   *
   * **The down is counted even when the KO is not credited.** A ball can knock
   * over the person who threw it: `game/footy.ts` arms a ball against its own
   * thrower once it has bounced, which is a real way to die and reads as a
   * genuinely funny one. Crediting that as a knockout would let a player farm
   * their own scoreboard off a wall; not counting the down would lose it from
   * the only column that says what happened.
   */
  private creditKo(attackerId: number, victimId: number): void {
    const victim = this.participants.get(victimId);
    if (victim) victim.downs++;
    // **The heat ladder's terminal state, and this is the one funnel every
    // knockout in the game passes through** -- a punch, a football, a car, a
    // police round, jumping off a train, and the RBT. Being caught wipes it,
    // whoever caught you, which is the brief's rule and is the only version
    // that is playable: a 5-star player who respawns still at 5 stars respawns
    // into a helicopter. The countdown is cleared beside it in `hurt` for the
    // paths that reach that one; this covers the rest.
    this.heat.reset(victimId);
    if (attackerId !== victimId) {
      const attacker = this.participants.get(attackerId);
      if (attacker) {
        attacker.kos++;
        // --- The ladder. *"10 kills levels u up"*, and the one place kills are
        // counted for it.
        //
        // Here rather than in a listener on the roster, because this is the
        // funnel every knockout in the game already passes through (the comment
        // above this method enumerates them: a punch, a football, a car, a
        // police round, a train, the RBT) and a second counter anywhere else
        // would be the one that stopped counting when a weapon changed.
        //
        // **A bot's KO of a player counts and a player's KO of a bot counts**,
        // which is what the brief means by "as `kos` counts today": the two
        // numbers must agree or the leaderboard and the plate over the same body
        // would disagree about the same fight. What does *not* count is
        // `attackerId === victimId`, and that falls out of the branch this is
        // already inside -- a player knocked over by their own thrown football
        // has not levelled up.
        this.creditLadder(attacker);
      }
    }
    this.rosterVersion++;
    // And the money falls out, here, in the one place that already knows both
    // ends of a knockout. See `dropCash`.
    if (victim) this.dropCash(victim);
    // A knockout during a fare is what "-50% if you knocked anyone down" means
    // when the anyone is a player rather than a pedestrian. Marked on the
    // *attacker*, and only when it was somebody else -- a driver run over by a
    // Camry (`attackerId === victimId`) has not driven roughly, they have been
    // driven into.
    if (attackerId !== victimId) this.markRough(attackerId);
  }

  // --- Accounts and the ladder -----------------------------------------------

  /**
   * Say one sentence to one player, in the pill, on the next frame.
   *
   * **The `WALLET` frame's note field, used for something that is not money**,
   * and that deserves a paragraph rather than a shrug.
   *
   * There is exactly one per-player text channel from this process to a client:
   * `WalletFrame.note`, delivered by `walletFrame` and drawn by `hud.notice` (see
   * `net/cash.WalletFrame.note` for why the *server* composes the sentence
   * rather than the client deriving one). Everything else on this wire is either
   * broadcast (`CHAT`, `EVENTS`) or a reply to something the client asked for
   * (`SUGGEST_ACK`, `SUN`). The three things accounts have to say -- "you levelled
   * up", "sign up to keep this", "new week, everybody is level 1" -- are all the
   * same shape as "+$34 fare": a moment, addressed to one person, that belongs in
   * the pill and nowhere else.
   *
   * The alternative was `MSG.NOTE`, a new id (0x93 was reserved for this
   * workstream) carrying a string. It was rejected because it would have been a
   * second message doing what an existing one does, a second decoder, a second
   * cadence to get right in `Room.step`, and a second thing for the client to
   * route into the same `hud.notice` call -- to say a sentence a few times an
   * evening. `walletVersion++` with no balance movement is what makes it work:
   * `Room` re-sends the wallet because the version moved, the balance in it is
   * simply the balance, and the note rides along. That is not a hack around the
   * cadence, it *is* the cadence -- the version has always meant "something in
   * this player's wallet frame changed", and the note is in the wallet frame.
   *
   * **Queued rather than dropped when the pill is already taken**, and that is
   * the one non-obvious thing here. The first cut let the first writer win, on
   * the Centrelink refusal path's precedent -- and the accounts check caught
   * what that costs: the tick a guest scores their tenth knockout is also the
   * tick they walk over the cash their victim dropped, so `+$6 found` claimed
   * the pill and *"sign up to level up"* was silently thrown away. It is a
   * once-per-session prompt. Thrown away once is thrown away for good.
   *
   * So the money sentence still wins **this** frame -- it is the thing that
   * just happened, and it is what `+$6 found` is for -- and the account
   * sentence lands on the next one, which is 16 ms later. One pending sentence
   * per player, overwritten rather than stacked: two queued notes would be a
   * queue, and a queue of pill messages is a player reading last minute's news.
   */
  note(playerId: number, text: string): void {
    const p = this.participants.get(playerId);
    if (!p) return;
    if (p.walletNote !== '') {
      this.pendingNotes.set(playerId, text.slice(0, 40));
      return;
    }
    p.walletNote = text.slice(0, 40);
    p.walletVersion++;
  }

  /**
   * One knockout, against the ladder. Called from `creditKo` and nowhere else.
   *
   * The **guest branch is the interesting one**, and it is the brief's rule
   * stated as code: *"kills accrue for everyone, but level only advances for
   * accounts -- a guest reaching a level threshold gets 'sign up to level up'
   * once and stays level 1."* So a guest's `kos` goes up (it is on the
   * scoreboard, it is what the room is playing for) and their `level` does not
   * move, because there is nowhere durable to keep it: a level that lived only
   * in this process would be a level that vanished on the next deploy, which is
   * a worse experience than never having had one.
   *
   * Cheap by construction, which matters because this is on the knockout path in
   * a room that can hold 128: a null test, an increment, and a comparison. The
   * store's own write is debounced (`ACCOUNT_SAVE_DEBOUNCE_MS`).
   */
  private creditLadder(attacker: Participant): void {
    const account = attacker.account;
    if (account === null) {
      // A guest at the first threshold. `attacker.kos` has already been
      // incremented by the caller, so this fires on the tenth kill exactly.
      if ((attacker.prompted & PROMPTED.LEVEL) === 0 && levelFor(attacker.kos) > 1) {
        attacker.prompted |= PROMPTED.LEVEL;
        this.note(attacker.id, 'sign up to level up (esc)');
      }
      return;
    }
    if (this.accounts === null) return;
    const out = this.accounts.creditKill(account);
    if (out.reset) {
      // The week turned over between this player's last kill and this one. Said
      // out loud, because the alternative is a player watching their level drop
      // from 6 to 1 in the middle of a fight with no explanation on screen.
      attacker.level = account.level;
      this.rosterVersion++;
      this.note(attacker.id, 'new week. everyone is level 1 again.');
      return;
    }
    if (out.levelled) {
      attacker.level = out.level;
      // The roster carries the level, so a level-up has to invalidate it or the
      // number over this player's head stays wrong until the next two-second
      // refresh -- which is exactly long enough for the pill to say "level 3"
      // over a plate that still says 2.
      this.rosterVersion++;
      this.note(attacker.id, `level ${out.level}`);
    }
  }

  /**
   * Roll every logged-in participant into the current week. Called on the minute.
   *
   * The lazy reset in `net/accounts.resetIfNewWeek` covers everybody who joins,
   * logs in or gets a knockout after Monday 00:00. This covers the one case it
   * cannot: **a player who is standing still when the week turns over**. Without
   * it their plate would say level 6 in a city where everybody else is at 1,
   * until they happened to knock somebody down.
   *
   * On the minute rather than on the tick, from `Room.step`, because the thing
   * being detected is a boundary that happens once a week and the worst error a
   * minute's granularity can produce is a minute. It is O(players) and it is one
   * string compare each; see `AccountStore.rollWeek`.
   */
  rollWeeks(nowMs = Date.now()): void {
    if (this.accounts === null) return;
    for (const p of this.participants.values()) {
      if (p.account === null) continue;
      if (!this.accounts.rollWeek(p.account, nowMs)) continue;
      p.level = p.account.level;
      this.rosterVersion++;
      this.note(p.id, 'new week. everyone is level 1 again.');
    }
  }

  // --- Money ---------------------------------------------------------------

  /**
   * Ten per cent of a knocked-out player's wallet, on the pavement at their
   * feet. See `cash.dropOnDeath` for the percentage and why there is a floor.
   *
   * **At their feet rather than where they end up.** `combat.applyHit` has
   * already applied the knockback by the time this runs, so the body is
   * mid-flight; the bundle is placed at the position the body is at *now*,
   * which is where the punch landed rather than where the ragdoll comes to
   * rest. That is the readable answer -- the money is where the fight was --
   * and it is also the only one that is stable, because where a body slides to
   * depends on what it hits.
   *
   * A no-op for a bot, for a player with under $5, and when the room is already
   * carrying `MAX_BUNDLES`. The last of those loses the money rather than
   * queueing it: a cap that queued would be a cap that does nothing under
   * exactly the conditions it exists for.
   */
  private dropCash(victim: Participant): void {
    const wallet = victim.wallet;
    if (wallet === null) return;
    const amount = dropOnDeath(wallet.balance);
    if (amount <= 0) return;
    if (this.bundles.length >= MAX_BUNDLES) return;
    if (moveBalance(wallet, -amount) === 0) return;
    this.wallets?.markDirty();
    const c = victim.combat;
    this.bundles.push({
      id: this.nextBundleId,
      x: c.body.position.x,
      // The ground under the body, not the eye -- `tickBundles` gates on feet
      // against this number, exactly as `tickPowerups` does against a sidecar's
      // baked ground height.
      y: c.body.position.y - EYE_HEIGHT,
      z: c.body.position.z,
      amount,
      from: victim.id,
      ttl: BUNDLE_SECONDS,
    });
    // Wraps rather than growing without bound: the id is a `u16` on the wire
    // and a bundle lives thirty seconds, so a room would have to drop two
    // thousand a second for a wrap to alias a live one.
    this.nextBundleId = this.nextBundleId >= 65535 ? 1 : this.nextBundleId + 1;
    this.bundleVersion++;
    victim.walletVersion++;
    victim.walletNote = `-${formatMoney(amount)} dropped`;
  }

  /**
   * A bundle of fifties out of a knocked-over NPC, at their feet.
   *
   * *"killing npc should drop cash"*. `dropCash` above is the player-versus-
   * player version and the two are deliberately **not** merged, because they are
   * different transactions wearing the same object: a death drop *moves* money
   * from one wallet to the pavement and this one **mints** it. That single
   * difference is the whole reason this function has a rate cap and that one
   * does not -- a player farming other players is redistributing a fixed pool,
   * and a player farming ibis at a spawn is printing.
   *
   * Four refusals, in the order they are cheapest:
   *
   *   - **A bot.** Bots have no wallet and no economy; a bot wandering into a
   *     pedestrian would otherwise carpet the CBD in money nobody dropped.
   *   - **A kind that is worth nothing.** Wildlife and the three vehicle kinds.
   *     See `cashnote.npcDropAmount` for why the birds pay zero.
   *   - **The bank.** `bankAllow` takes what it can and returns it, so the last
   *     $30 of a minute still buys a bundle. Zero means the minute is spent.
   *   - **`MAX_BUNDLES`.** The room's cap, and it loses the money rather than
   *     queueing it, on `dropCash`'s stated argument: a cap that queued would do
   *     nothing under exactly the conditions it exists for.
   *
   * **The bank is charged before the cap is tested**, and that ordering is
   * deliberate: a room already carrying 48 bundles is a room in the middle of a
   * riot, and letting the 49th knockout also be free would mean the cap became a
   * way to reset the minute. The money is lost either way; what must not happen
   * is that losing it is *cheaper* than earning it.
   *
   * `from` is 0 -- nobody. The field names whoever dropped it so a feed line can
   * say "Bazza's cash", and there is no player to name here: the money came out
   * of a constable. Zero is the sentinel `CashBundle.from` already documents.
   */
  private dropNpcCash(actor: NpcActor, p: Participant): void {
    if (p.bot) return;
    const worth = npcDropAmount(actor.kind);
    if (worth <= 0) return;
    const amount = bankAllow(p.npcCash, worth, Date.now());
    if (amount <= 0) return;
    if (this.bundles.length >= MAX_BUNDLES) return;
    this.bundles.push({
      id: this.nextBundleId,
      x: actor.x,
      // `NpcActor.y` is already **feet** -- see the record -- so unlike
      // `dropCash`, which is handed an eye, there is nothing to subtract here.
      // That asymmetry is the one thing in this function worth reading twice:
      // `tickBundles` gates the pickup on the collector's feet against this
      // number, and an eye height's worth of error is a bundle floating at head
      // height that nobody can pick up.
      y: actor.y,
      z: actor.z,
      amount,
      from: 0,
      ttl: BUNDLE_SECONDS,
    });
    this.nextBundleId = this.nextBundleId >= 65535 ? 1 : this.nextBundleId + 1;
    this.bundleVersion++;
  }

  /**
   * Move one player's balance and leave a sentence explaining it.
   *
   * The single implementation behind `wallet.credit` and `wallet.debit`. A bot,
   * a departed id and a host with no store all fall out of the same null test,
   * and all three return 0 -- which is the honest answer to "how much moved".
   */
  private moveWallet(playerId: number, delta: number, why: string): number {
    const p = this.participants.get(playerId);
    if (!p || p.wallet === null) return 0;
    const moved = moveBalance(p.wallet, delta);
    if (moved === 0) return 0;
    this.wallets?.markDirty();
    p.walletVersion++;
    p.walletNote = `${moved > 0 ? '+' : '-'}${formatMoney(Math.abs(moved))} ${why}`.slice(0, 40);
    // --- "Would you like to save progress?" See `SAVE_PROMPT_BALANCE`.
    //
    // **Here rather than on a tick**, because this is the only place in the
    // process where a balance goes up, so a threshold crossing is detectable
    // exactly once and costs one comparison against a number that just changed.
    // A per-tick `balance >= 100` sweep would be O(players) at 60 Hz to notice
    // an event that happens once per player per session.
    //
    // The note is composed **after** the money one above rather than instead of
    // it, and the money one wins: the pill has room for one sentence, and
    // "+$34 fare" is the thing the player just did. The prompt is queued onto
    // the *next* movement, which is a few seconds away in any session where the
    // balance is climbing -- and if it never comes, the player was not earning
    // and the prompt would have been noise.
    if (
      moved > 0 &&
      p.account === null &&
      (p.prompted & PROMPTED.MONEY) === 0 &&
      p.wallet.balance >= SAVE_PROMPT_BALANCE &&
      p.wallet.balance - moved < SAVE_PROMPT_BALANCE
    ) {
      p.prompted |= PROMPTED.MONEY;
      this.note(p.id, 'would you like to save progress? sign up (esc)');
    }
    return moved;
  }

  /**
   * One sentence per player waiting for the pill to be free. See `note`.
   *
   * A `Map` rather than a queue: the newest sentence replaces the pending one,
   * because a pill is a *moment* and a backlog of moments is a player being
   * told what happened a minute ago. Bounded by the room -- one entry per
   * participant at worst, and every entry is cleared on the next tick.
   */
  private readonly pendingNotes = new Map<number, string>();

  /**
   * Deliver anything `note` had to queue. Called once a tick by `Room.step`.
   *
   * Separate from the tick body rather than folded into it because it is
   * `Room`'s cadence question rather than the simulation's: a queued sentence
   * has to be written *after* this tick's wallet frames have been read, or it
   * would go out on the same frame as the sentence it is queued behind and one
   * of the two would be lost -- which is the failure `note` exists to prevent.
   */
  drainNotes(): void {
    if (this.pendingNotes.size === 0) return;
    for (const [id, text] of this.pendingNotes) {
      const p = this.participants.get(id);
      // Still busy: a tick where something else claimed the pill again. Left in
      // the map for the next one rather than dropped, which is the whole point.
      if (!p || p.walletNote !== '') continue;
      p.walletNote = text;
      p.walletVersion++;
      this.pendingNotes.delete(id);
    }
  }

  /**
   * This driver has knocked something down; halve the fare they are on.
   *
   * Level rather than edge and deliberately sticky: the flag is cleared when a
   * passenger *boards* (see `server/fares.ts`) and at no other time, so one
   * pedestrian at the start of a trip costs the whole trip. That is the rule as
   * written -- "-50% if you knocked anyone down during the trip" -- and it is
   * the only version a player can reason about, because a flag that decayed
   * would make the penalty depend on when in the trip it happened.
   *
   * Cheap by construction: a map lookup and a boolean store, called from the
   * three places something goes down.
   */
  private markRough(playerId: number): void {
    const p = this.participants.get(playerId);
    if (p && p.fare.state === 'toDropoff') p.fare.rough = true;
  }

  private pickColourway(preferred: number): number {
    const taken = new Set<number>();
    for (const p of this.participants.values()) taken.add(p.colourway);
    if (preferred < COLOURWAYS.length && !taken.has(preferred)) return preferred;
    for (let i = 0; i < COLOURWAYS.length; i++) if (!taken.has(i)) return i;
    // More players than kits. Spec 8.1 says "6-8 colourways" and spec 2 caps the
    // game at 16, so this is reachable and there is no better answer than
    // wrapping -- two people in the same singlet is worse than a crash by
    // exactly nothing.
    return this.participants.size % COLOURWAYS.length;
  }

  /**
   * A spot in the spawn disc, facing its middle.
   *
   * The disc is Sydney Park -- `world.spawn` is its centre and `game/spawn.ts`
   * is the rule that found it -- and the point inside it is drawn fresh for
   * every join, rejection-sampled against the ground, the prisms and the ponds.
   * Random rather than seeded: two players joining a second apart should not
   * arrive in the same square metre, and nothing here is replayed.
   *
   * A probe world per call, because `groundFor` carries a last-known ground and
   * sharing one between a sampler and a player would let a rejected candidate on
   * a roof follow the joiner into the game.
   */
  private joinSpot(): { x: number; z: number; yaw: number } {
    const centre = this.world.spawn;
    const drawn = pickSpawnPoint(centre, groundFor(this.world));
    let x = drawn.x;
    let z = drawn.z;
    // The sampler falls back to the centre when nothing passes, and the centre is
    // the one point every joiner would share -- sixteen players landing on it
    // spawn inside each other, which resolves as everybody being ejected in a
    // random direction on the first tick. So a draw that gave up takes the old
    // widening ring instead, which is what that ring was always for.
    if (x === centre.x && z === centre.z) {
      const i = this.joinIndex++;
      const ring = Math.floor(i / JOIN_PER_RING) + 1;
      const angle = ((i % JOIN_PER_RING) / JOIN_PER_RING) * Math.PI * 2;
      const r = JOIN_RING * ring;
      x = centre.x + Math.cos(angle) * r;
      z = centre.z + Math.sin(angle) * r;
    }
    // Face the middle. `forward = (-sin yaw, -cos yaw)`, so looking at the
    // centre from (x, z) is `atan2(-(cx - x), -(cz - z))`.
    const yaw = Math.atan2(-(centre.x - x), -(centre.z - z));
    return { x, z, yaw };
  }

  private rebuild(): void {
    this.ordered = [...this.participants.values()].sort((a, b) => a.id - b.id);
    this.combatants = this.ordered.map((p) => p.combat);
    this.byId.clear();
    for (const c of this.combatants) this.byId.set(c.id, c);
    this.dirty = false;
  }

  /**
   * Refile everybody under the box their rewind window covers.
   *
   * Called once, at the top of the tick, before anything has moved -- which is
   * the only moment at which it is *correct* rather than merely current: every
   * position `PositionHistory.sampleAt` can return is a sample written at the
   * end of some earlier tick, and the box over the ring contains all of them
   * and every lerp between them. See `game/spatialhash.ts` on why that makes
   * the candidate set a proof rather than a margin.
   */
  private buildRewindIndex(): void {
    const b = this.boundsScratch;
    this.rewindIndex.clear();
    for (const p of this.ordered) {
      const c = p.combat;
      const x = c.body.position.x;
      const z = c.body.position.z;
      p.history.bounds(b);
      // **A PASSENGER'S REWOUND POSITION IS NOT INSIDE THEIR OWN HISTORY.**
      //
      // The box over the ring is a proof for everybody who walks: every position
      // `sampleAt` can return was written at the end of some earlier tick and is
      // inside it. `reframeRider` breaks that on purpose -- it takes the
      // historical sample, strips the train's motion out of it and puts it back
      // through the carriage's frame *now*, which is the whole reason a swing on
      // a moving train can land at all. The answer is therefore up to
      // `speed * viewTicks` **in front of** everything the ring recorded: eleven
      // metres on T1's 44 m/s express.
      //
      // So the broadphase dropped riders it must not, and it did it as a
      // function of where in the box the query happened to land -- a swing on a
      // train that missed about one time in seventy, always at line speed, and
      // never reproducibly. Widening the box for a body that is aboard restores
      // the superset the candidate set is supposed to be: the reframed answer is
      // `frame(now) . local(then)`, and `local(then)` is inside the carriage, so
      // the answer is inside the carriage **now** -- which is inside this box by
      // `RIDER_CARRIAGE_SPAN_M`, no matter how fast the train is going.
      //
      // It costs a rider a few more cells in an index that is rebuilt from
      // scratch every tick, and nothing at all to anybody on foot.
      const span = isAboard(c.aboard) ? RIDER_CARRIAGE_SPAN_M : 0;
      if (b.valid) {
        // Unioned with the live position rather than taken bare. A seeded ring
        // already contains it, and every participant's is seeded -- `join`
        // does it and every respawn does it again -- so this is belt and
        // braces over the one branch in `rewindInto` that falls back to the
        // live body when a history is missing.
        this.rewindIndex.insertBox(
          c, x, z,
          Math.min(b.minX, x - span), Math.min(b.minZ, z - span),
          Math.max(b.maxX, x + span), Math.max(b.maxZ, z + span),
        );
      } else if (span > 0) {
        this.rewindIndex.insertBox(c, x, z, x - span, z - span, x + span, z + span);
      } else {
        this.rewindIndex.insert(c, x, z);
      }
    }
  }

  /** Refile everybody where they actually are. Called after the advance loop. */
  private buildLiveIndex(): void {
    this.liveIndex.clear();
    for (const c of this.combatants) {
      this.liveIndex.insert(c, c.body.position.x, c.body.position.z);
    }
  }

  // --- The tick ---------------------------------------------------------------

  /**
   * One fixed step. Returns what happened, for the transport to send.
   *
   * The returned arrays are **owned by this object and reused**; a caller must
   * serialise before the next call. That is the same contract `tickPowerups`
   * and `minimap.mark` already have in this codebase, and it is what keeps a
   * 60 Hz loop from allocating two arrays a tick forever.
   */
  step(out: TickOutput): TickOutput {
    this.tick++;
    this.events.length = 0;
    this.bikeChanges.length = 0;
    this.carChanges.length = 0;
    this.carRemovals.length = 0;

    // --- Departures, before anything reads the list.
    let departed = false;
    for (const p of [...this.participants.values()]) {
      if (!p.gone) continue;
      this.participants.delete(p.id);
      this.histories.delete(p.id);
      // Their investigation goes with them, on exactly the argument their
      // scoreboard row does: the police are the *current* world and not a
      // history of the session. Every officer chasing them notices on their next
      // `think` -- the suspect is no longer in `ctx.combatants` -- and walks
      // home, which is the same path the countdown running out takes.
      if (this.factions.investigationOf(p.id)) {
        this.factions.clearInvestigation(p.id);
        this.investigationVersion++;
      }
      this.seenRiding.delete(p.id);
      this.events.push({ kind: EVENT.LEAVE, id: p.id, colourway: p.colourway, bot: p.bot ? 1 : 0 });
      // Their row goes with them. The scoreboard is the *current* world, not a
      // history of the session -- spec 12 has no persistence and a board that
      // kept the departed would be inventing one.
      this.rosterVersion++;
      departed = true;
    }
    if (departed || this.dirty) this.rebuild();

    // --- The melee's candidate grid, before anybody has moved. See
    // `buildRewindIndex` for why the moment matters.
    let t = performance.now();
    this.buildRewindIndex();
    this.phaseMs.index += performance.now() - t;

    // --- Every input first, from the state as it stands at the top of the tick.
    //
    // `main.ts` says why in as many words: a bot that thought *during* the loop
    // would be reacting to a player who had already moved this step -- half a
    // tick of clairvoyance no remote player will ever have, and the kind of
    // asymmetry that only shows up as "the AI feels unfair".
    for (const p of this.ordered) {
      if (p.bot) p.bot.think(this.combatants, FIXED_DT);
    }

    // --- The rail clock, once, before anything asks where a train is. See
    //     `railT`.
    this.railT = railSeconds(this.railNowMs());

    // --- The bikes, before anybody moves.
    //
    // Before, and in ascending id, for exactly the reason the strike resolution
    // below is: two players pressing `E` beside the same bike on the same tick
    // have to resolve in an order both ends agree on, and `BikeField.claim`
    // returning false to the second of them is the whole of that rule. Doing it
    // *before* `advance` means the tick a player mounts on is the tick they get
    // the speed, rather than the one after.
    for (const p of this.ordered) {
      this.resolveMount(p);
    }

    // --- Advance, in ascending id. See `main.ts`: the order is the tick order
    // and it is fixed rather than incidental, because two combatants who strike
    // on the same tick have to resolve in an order both ends agree on.
    t = performance.now();
    for (const p of this.ordered) {
      // The one seam trains put in this loop. `enterCarriage` either hands back
      // the city -- which is every tick of every player who is not on a train --
      // or moves this body into its carriage's coordinates and hands back the
      // carriage. See `game/riding.ts`'s header for why the whole feature is one
      // change of basis around one unchanged `advance`.
      const events = advance(p.combat, p.input, FIXED_DT, this.enterCarriage(p));
      this.exitCarriage(p);

      if (events.strike) this.resolveStrike(p);
      // A throw is not adjudicated at all -- it puts an object in the world and
      // the object decides for itself over the next second. That is the whole
      // structural difference between this weapon and the beam it replaced,
      // which resolved a hit test on this line.
      if (events.ballThrown) this.balls.add(p.combat);

      if (events.respawnDue) {
        // And off the train, here rather than one tick later. `enterLocal` would
        // catch the teleport `respawnAt` is about to do and end the ride on the
        // next tick anyway -- that is the level this feature is swept at -- but
        // one tick later is one snapshot in which a body standing in Redfern is
        // also listed as being in carriage 4 of a train through Strathfield.
        clearAboard(p.combat.aboard);
        const spot = pickRespawn(p.combat.body.position.x, p.combat.body.position.z, p.world);
        if (spot) {
          respawnAt(p.combat, spot.x, spot.y, spot.z, p.combat.body.yaw);
        } else {
          // Nothing qualified -- a courtyard, or the harbour. `main.ts` makes the
          // same call: getting up where you fell is worse than spec 8.2's clause
          // and infinitely better than lying on the pavement forever, which is
          // what a silent failure here would be.
          const x = p.combat.body.position.x;
          const z = p.combat.body.position.z;
          respawnAt(p.combat, x, p.world.groundHeight(x, z, -Infinity), z, p.combat.body.yaw);
        }
        if (p.bot) p.bot.reset(p.combat.body.position.x, p.combat.body.position.z);
        // Seed rather than let the ring fill: for the next 250 ms an unseeded
        // history would rewind a respawned player back to where they died, and
        // a punch thrown at that spot would land on someone forty metres away.
        p.history.seed(
          this.tick,
          p.combat.body.position.x,
          p.combat.body.position.y,
          p.combat.body.position.z,
          p.combat.body.yaw,
        );
      }
    }

    this.phaseMs.advance += performance.now() - t;

    // --- Where everybody finished. Everything below this line is deliberately
    // **not** rewound -- the balls, the pickups, the traffic and the factions
    // all read the positions the tick just produced -- so they share one index
    // built here rather than the melee's historical one.
    t = performance.now();
    this.buildLiveIndex();
    this.phaseMs.index += performance.now() - t;

    // --- Every football in the air, after every combatant has moved.
    //
    // The order matters for the pickups' own reason: a ball tested against last
    // tick's positions would hit people where they were rather than where they
    // are, which at a sprint is 14 cm and just after a knockback is two metres.
    //
    // **The live list, not a rewound one**, and that is a real decision rather
    // than an omission -- `game/footy.ts`'s `stepFooty` argues it out. A rewind
    // answers "what was the attacker looking at when they clicked", which is the
    // right question for an instant weapon and the wrong one for a ball: the
    // ball is an object in the world that every client is drawing from the same
    // snapshot stream, and rewinding it would mean a ball that visibly passed
    // somebody 100 ms ago knocking them over now. So `server/rewind.ts` is not
    // consulted here at all, and the 250 ms ring stays a melee mechanism.
    // --- ...but first, every bat that is mid-swing, against every ball in the
    // air. The community suggestion; see `game/swat.ts`.
    //
    // **Before the step, and that ordering is the decision.** A swat deflects
    // the ball's velocity, and running it here means the deflected velocity is
    // what the very next line integrates -- the ball turns round on the tick the
    // blade reached it. Run *after* the step it would turn round one tick late,
    // 16 ms and 0.7 m further into the swinger's own face, which is exactly the
    // frame a player is looking at when they decide whether a swat worked.
    //
    // The cost is O(swingers x balls) and both terms are small: a swing is in
    // its `active` window for six of the 30 ticks it lasts and most players are
    // not swinging on most ticks, so the ordinary tick pays one `phase` compare
    // per player. It is not put behind the spatial index for that reason -- the
    // grid lookup would cost more than the loop it saves at the sizes this
    // actually runs at, and `swingCatches` rejects on a plan distance before it
    // does any real work.
    for (const p of this.ordered) {
      // **Bots do not swat**, and that is a deliberate line rather than an
      // oversight. `server/bots.ts` swings when somebody is in reach; it has no
      // model of a ball in the air at all, so every swat it landed would be one
      // it swung for a different reason and happened to catch -- a coin flip
      // wearing a skill mechanic, and specifically the coin flip the community
      // suggestion this implements is *about*. A bot that returned serve by
      // accident would read as a bot that reads the ball better than a person
      // can. Giving it a real one means teaching it to lead a projectile, which
      // is a bot pass rather than a weapon pass.
      if (p.bot) continue;
      if (p.combat.phase !== 'active') continue;
      const ball = swatBalls(
        p.combat,
        this.balls.balls,
        FIXED_DT,
        // The swinger's own view lag, which is the same number the melee's
        // rewind uses and is derived once per tick by `Room.step`. It is the
        // *ball* that gets rewound here rather than the bodies -- see
        // `game/swat.ts`, decision 2, where the two are read together.
        p.viewTicks * FIXED_DT,
        this.swatScratch,
      );
      if (ball === null) continue;
      // The event carries the ball's post-swat state as well as the two ids,
      // because the player who *threw* it is still flying a local predicted copy
      // that now disagrees with this process about which way it is going --
      // `Footy.thrower` is deliberately unchanged by a swat, so nothing in the
      // snapshot stream can tell them. See `protocol.SwatEvent`.
      this.events.push({
        kind: EVENT.SWAT,
        swinger: p.id,
        ball: ball.id,
        x: ball.x,
        y: ball.y,
        z: ball.z,
        vx: ball.vx,
        vy: ball.vy,
        vz: ball.vz,
      });
    }

    t = performance.now();
    for (const e of this.balls.step(FIXED_DT, this.ballWorld, this.combatants, this.ballEvents, this.liveIndex)) {
      if (e.kind !== 'hit' || !e.victim) continue;
      // The **owner**, not the thrower: a ball that was batted back belongs to
      // whoever returned it, and the knockout goes on their row. For every ball
      // nobody swatted the two are the same participant. See `footy.Footy.owner`.
      const owner = this.participants.get(e.ball.owner);
      // A ball whose owner has since disconnected still counts. It is in the
      // air and it is nobody's property any more; refusing the hit would make
      // leaving a way to un-throw.
      if (!owner) continue;
      applyFootyHit(owner.combat, e.victim, e.ball, this.ballReport);
      if (this.ballReport.ko) this.creditKo(owner.id, e.victim.id);
      this.events.push({
        kind: EVENT.HIT,
        attacker: owner.id,
        victim: e.victim.id,
        flags:
          EVENT_FLAG.FOOTY |
          (this.ballReport.ko ? EVENT_FLAG.KO : 0) |
          // "%s returned serve on %s" rather than "%s pegged %s". The bit is set
          // whenever the ball changed hands in the air, which includes the case
          // the suggestion was really about -- a return that knocks over the
          // person who threw it -- and reads correctly for the others.
          (e.ball.owner !== e.ball.thrower ? EVENT_FLAG.RETURNED : 0),
        health: e.victim.health,
      });
    }

    // --- ...and every ball still in the air, against everybody who is not a
    // player. `main.ts` runs the identical sweep for the picture and this runs it
    // for the consequence, which is `strikeBystanders`' argument one weapon over.
    //
    // The ball does **not** die on either kind of body, which is the same
    // decision the client already documents: a ball that vanished here and not
    // there would be a ball that re-appeared out of the next snapshot. What is
    // authoritative is the knockdown and the crime, and both are decided here.
    {
      const tick = trafficTick(Date.now());
      for (const ball of this.balls.balls) {
        // The owner again, and here it is a question about **blame**: knocking a
        // pedestrian over with a football you batted out of the air is your
        // assault and not the assault of whoever threw it at you.
        const owner = this.participants.get(ball.owner);
        if (!owner) continue;
        const struck = strikePedestrianWithBall(
          this.world.peds, ball, BALL_RADIUS, FIXED_DT, tick, this.pedBands, this.pedPose,
        );
        if (struck !== null) {
          this.reportIfWitnessed(owner, struck.x, struck.z, REASON.ASSAULT);
          // A football out of a car window is still knocking somebody down.
          this.markRough(owner.id);
        }
        // And the officers, swept over the same one-tick segment. `npcHitTest`
        // reconstructs the previous position from the velocity exactly as
        // `strikePedestrianWithBall` does -- which is what `footy.stepFooty`
        // itself works with and is exact for the straight line a ball flies in
        // one tick.
        const actor = npcHitTest(
          this.factions,
          ball.x - ball.vx * FIXED_DT, ball.y - ball.vy * FIXED_DT, ball.z - ball.vz * FIXED_DT,
          ball.x, ball.y, ball.z,
          BALL_RADIUS,
        );
        if (actor !== null) this.hitNpc(actor, 1, owner);
      }
    }
    this.phaseMs.balls += performance.now() - t;

    // --- The traffic, after every combatant has moved and before the pickups.
    //
    // Ordered here for the balls' own reason: a car tested against last tick's
    // positions would run people down where they *were*, which at a sprint is
    // 14 cm and just after a knockback is two metres.
    //
    // **Nothing is stepped and nothing is stored.** A car's position is a pure
    // function of wall-clock time -- see `game/traffic.ts` -- so this is a query,
    // not a simulation, and the browser runs the identical query at the identical
    // tick to predict the same shove on the frame it happens. That is the whole
    // of why a fleet of six thousand cars costs zero bytes of protocol.
    //
    // Bots are in `this.ordered` like anyone else and are run down like anyone
    // else, which is both correct and funny.
    t = performance.now();
    {
      const tick = trafficTick(Date.now());
      for (const p of this.ordered) {
        // Nobody on a train is run over by a Camry.
        //
        // A rider's world position is real and is exactly where the query wants
        // it -- which is the point of deriving it -- so a train crossing a level
        // crossing at 130 km/h would otherwise put every passenger on the
        // pavement, one by one, at the crossing. TRAINS.md has the rule the
        // other way round (a train through a crossing applies the car-hit rule
        // *scaled up*, and that is the train's to apply, not the Camry's), and
        // it is not a rule about the people inside the train.
        //
        // Here rather than inside `carHitting`, because that function answers a
        // question about geometry and this is a question about what a body is
        // standing in. The client makes the identical check in the identical
        // place -- `main.ts` -- which is what keeps the prediction exact.
        if (isAboard(p.combat.aboard)) continue;
        // Suppressed cars are skipped, which is the other half of "the car you
        // stole stops driving to Ashfield" -- without it the ghost of your own
        // car runs *you* over from inside the seat you are sitting in on the
        // first tick you stop. `main.ts` passes the identical predicate at the
        // identical point.
        const car = carHitting(
          this.world.traffic, p.combat, tick, this.carRoutes, this.carPose,
          (identity) => this.cars.suppressed(identity),
        );
        if (car === null) continue;
        const ko = applyCarHit(p.combat, car);
        // Credited to the victim as their own attacker, which `creditKo` reads
        // as "count the down, credit nobody": there is no driver. The same
        // identity is what the client's feed keys the "got run down" line off,
        // and it costs no protocol change because a player cannot hit themselves
        // by any other route.
        if (ko) this.creditKo(p.id, p.id);
        this.events.push({
          kind: EVENT.HIT,
          attacker: p.id,
          victim: p.id,
          flags: ko ? EVENT_FLAG.KO : 0,
          health: p.combat.health,
        });
      }
    }

    this.phaseMs.traffic += performance.now() - t;

    // --- Spec 8.3, after every combatant has moved, and authoritative. The
    // client no longer decides this at all while connected; it mirrors the
    // event. See `main.ts` for why the order within the tick matters.
    //
    // The live index goes in because this pass was the largest single cost in
    // the tick before PERFORMANCE.md phase 1 -- 884 points times every player,
    // every tick. See `tickPowerups`.
    t = performance.now();
    for (const e of tickPowerups(this.world.points, this.combatants, FIXED_DT, this.pickups, this.liveIndex)) {
      const at = this.world.tileOf.get(tileKeyOf(e.point.id));
      this.events.push({
        kind: EVENT.PICKUP,
        combatant: e.combatant.id,
        powerup: e.point.kind,
        tileX: at?.tileX ?? 0,
        tileZ: at?.tileZ ?? 0,
        index: indexOf(e.point.id),
      });
    }

    // --- The money on the pavement, immediately after the powerups and for
    // exactly their reasons: after every combatant has moved, against the live
    // index rather than the rewound one, and resolved in combatant order so
    // two players reaching one pile settle the same way on every machine.
    //
    // `tickBundles` compacts the list in place, so this loop is over what was
    // *collected* and the survivors are already the whole list.
    for (const e of tickBundles(this.bundles, this.combatants, FIXED_DT, this.bundlePickups, this.liveIndex)) {
      this.bundleVersion++;
      // No `EVENT` for a collection, deliberately. The `WALLET` frame the
      // collector gets carries both halves -- the new balance and the sentence
      // saying where it came from -- and everybody else's `WALLET` re-sends the
      // bundle list without it, which is how the pile disappears from their
      // screen. An event as well would be the same fact on the wire twice, and
      // `EVENT.PICKUP` above is only an event because a powerup's *world state*
      // (the icon, the respawn clock) is client-side and this is not.
      this.moveWallet(e.combatant.id, e.bundle.amount, 'found');
    }
    if (this.bundles.length !== this.bundlesLastCount) {
      // Expiry also changes the list, and `tickBundles` reports collections
      // rather than deaths -- so the version is bumped off the length as well.
      this.bundlesLastCount = this.bundles.length;
      this.bundleVersion++;
    }

    // --- SydRide, last of the money passes, because a fare that pays reads the
    // balance every pass above may have moved.
    //
    // O(players) and one boolean test for anybody not on shift. The context
    // record is reused; see `server/fares.ts` on why nothing here allocates.
    this.stepFares();

    // --- The bikes again, after everybody has moved and every hit has landed.
    //
    // Two jobs, and both are sweeps rather than events on purpose.
    //
    // `follow` carries each ridden bike to its rider and **parks any whose rider
    // has stopped riding it** -- which is one rule covering being batted off
    // (`combat.applyHit` cleared the field), being pegged off
    // (`footy.applyFootyHit` did), being knocked out, respawning, and
    // disconnecting. None of those needed to know the bikes exist.
    //
    // And Redfern: the unlock is evaluated here, on the server, against the
    // position the server just simulated -- never on a client's word. It is the
    // only line in this process that sets `bikeTuned`, which is what makes 3x
    // something you walk to rather than something you ask for.
    this.phaseMs.powerups += performance.now() - t;

    t = performance.now();
    this.riderViews.length = 0;
    for (const p of this.ordered) {
      const c = p.combat;
      this.riderViews.push({
        id: c.id,
        ridingBike: c.ridingBike,
        x: c.body.position.x,
        feetY: c.body.position.y - EYE_HEIGHT,
        z: c.body.position.z,
        yaw: c.body.yaw,
      });
      if (c.bikeTuned) continue;
      const feet = c.body.position.y - EYE_HEIGHT;
      const ground = p.world.groundHeight(c.body.position.x, c.body.position.z, feet);
      if (inTuningZone(c.body.position.x, feet, c.body.position.z, ground)) {
        c.bikeTuned = true;
        // No event and no message: `FLAG.TUNED` is in the very next snapshot,
        // which is at most 50 ms away, and the client turns that into the HUD
        // notice. A reliable event for a thing already carried by an idempotent
        // state bit would be a second way to say the same thing.
      }
    }
    for (const bike of this.bikes.follow(this.riderViews, this.bikeSweep)) {
      this.bikeChanges.push(bike);
    }

    // --- The second crime: riding a modified e-bike past the police.
    //
    // `FLAG.TUNED` on a `FLAG.RIDING` player is the whole of the offence, and
    // both bits are already on the wire and already the server's -- the tuning
    // is set nowhere but the Redfern sweep twenty lines up and the mount is
    // resolved at the top of this tick. So this reads two booleans this process
    // already owns and asks one question about where they are standing.
    //
    // **On the edge**, not the level. A tuned rider in front of a squad car is
    // committing the offence on every one of the sixty ticks they are in view,
    // and re-accusing on each of them would pin the countdown to its cap for as
    // long as they kept riding -- which is a countdown that never runs out, and
    // the instruction was that it does. So the crime fires when they come into
    // view and again only after they have left it. See `seenRiding`.
    this.stepRideBy();
    this.phaseMs.bikes += performance.now() - t;

    // --- And the cars, on the bikes' own terms one phase up.
    t = performance.now();
    this.stepCars();
    this.phaseMs.cars += performance.now() - t;

    // --- The factions, after everything that could have started an
    // investigation and before the history is recorded.
    //
    // Last because it is the only step that reads the *finished* positions of
    // everybody: an officer that thought at the top of the tick would be
    // chasing where the suspect was rather than where they are, which at
    // 6.4 m/s is 11 cm a tick and is the same argument the balls and the traffic
    // already make about their own placement in this loop.
    t = performance.now();
    this.stepFactions();
    this.phaseMs.npc += performance.now() - t;

    // --- History, at the *end* of the tick, which is where the position a
    // snapshot reports is taken from. Recording at the top would file each
    // sample under the tick before the one it belongs to, and every rewind in
    // the game would be one tick -- 8.3 ms, 7 cm at a sprint -- stale.
    t = performance.now();
    for (const p of this.ordered) {
      p.history.record(
        this.tick,
        p.combat.body.position.x,
        p.combat.body.position.y,
        p.combat.body.position.z,
        p.combat.body.yaw,
      );
    }
    this.phaseMs.history += performance.now() - t;

    out.tick = this.tick;
    out.events = this.events;
    out.snapshot = null;
    return out;
  }

  /**
   * A tuned rider, in front of the police. See the call site for why it is an
   * edge rather than a level.
   */
  /** How long `this.bundles` was last tick, so expiry bumps the version too. */
  private bundlesLastCount = 0;

  /**
   * Every online driver's fare, one fixed step each.
   *
   * The loop is over `this.ordered` rather than over a list of online drivers,
   * on `stepRideBy`'s own terms: a second collection to maintain is a second
   * thing that can disagree with the participant map, and the test that skips
   * everybody else is one boolean read off a record that is already in cache.
   *
   * **Where the fare thinks the driver is** is the car's pose when there is a
   * car and the body's when there is not, which matters at the two stop
   * radii: a driver's body may be a metre from the car's origin, and five
   * metres is not a radius that can spend one on a coordinate choice.
   */
  private stepFares(): void {
    const nowMs = Date.now();
    for (const p of this.ordered) {
      const job = p.fare;
      if (!job.online && job.state === 'none' && job.cooldownT <= 0) continue;
      if (p.bot) continue;

      const carId = this.driving.carOf(p.id);
      const pose = carId !== 0 ? this.driving.carPose(carId) : null;
      const c = p.combat;
      const ctx = this.fareCtx;
      ctx.playerId = p.id;
      ctx.tick = this.tick;
      ctx.nowMs = nowMs;
      ctx.x = pose ? pose.x : c.body.position.x;
      ctx.z = pose ? pose.z : c.body.position.z;
      // The body's own plan speed when there is no pose to read one off.
      // `velocity` is the integrator's, so this is the speed the tick just
      // produced rather than an average over anything.
      ctx.speed = pose
        ? pose.speed
        : Math.sqrt(c.body.velocity.x * c.body.velocity.x + c.body.velocity.z * c.body.velocity.z);
      ctx.inCar = carId !== 0;
      ctx.ko = c.phase === 'ko' || c.health <= 0;

      const out = stepFare(job, ctx);
      if (out.paid > 0) {
        this.wallet.credit(p.id, out.paid, 'fare');
        // The passenger's parting line, seeded off the fare so it is stable if
        // the frame is ever re-sent. Appended to the notice rather than
        // replacing it, because "+$27 fare" is the fact and the line is the
        // flavour, and a player who missed the number would have nothing.
        job.line = passengerLine(p.id ^ Math.trunc(job.tripM));
      } else if (out.notice === 'passenger in') {
        job.line = passengerLine(p.id ^ job.offeredMs);
      }
      if (out.notice !== '' && p.walletNote === '') p.walletNote = out.notice;
    }
  }

  // --- The phone -------------------------------------------------------------

  /**
   * `PHONE_OP.CLAIM`: pay this player $100 if they are standing at that office
   * and have not claimed there for seven in-game days.
   *
   * **Every clause is checked here and none is trusted from the client.** The
   * office id names a row in a table both ends compile in, but the *position*
   * is the server's own simulated body and the *timer* is the server's own
   * record -- so a client that sent a claim for an office in Penrith while
   * standing in Redfern is refused by geometry, and one that sent the same
   * claim sixty times a second is refused by the clock. There is nothing to
   * rate-limit beyond that: a refused claim costs a map lookup.
   *
   * Returns a sentence for the player, always, because a claim that silently
   * does nothing is a button the player decides is broken. Lower case, on
   * `factions.REASON_TEXT`'s voice.
   */
  claim(playerId: number, officeId: string): string {
    const p = this.participants.get(playerId);
    if (!p || p.wallet === null) return 'no wallet on this host';
    const c = p.combat;
    if (c.phase === 'ko' || c.health <= 0) return 'not while you are on the ground';
    const office = officeAt(c.body.position.x, c.body.position.z);
    if (office === null) return 'you are not at a centrelink';
    // The id is compared rather than ignored. Standing at Redfern and claiming
    // for Parramatta is refused rather than quietly redirected, because the
    // phone shows a list and the player picked a row -- and a claim that paid
    // the wrong office's timer would be a bug nobody could see.
    if (officeId !== '' && officeId !== office.id) return `you are at ${office.name.toLowerCase()}`;
    const wait = claimWaitMs(p.wallet.centrelink[office.id] ?? 0, Date.now());
    if (wait > 0) return 'nothing due here yet';
    this.wallets?.recordClaim(p.wallet, office.id, Date.now());
    this.wallet.credit(playerId, CENTRELINK_PAYMENT, 'centrelink');
    return '';
  }

  /** `PHONE_OP.ONLINE` / `OFFLINE`. Idempotent; see `net/cash.PHONE_OP`. */
  setOnline(playerId: number, online: boolean): void {
    const p = this.participants.get(playerId);
    if (!p || p.wallet === null) return;
    if (p.fare.online === online) return;
    p.fare.online = online;
    p.fare.version++;
  }

  /**
   * What this player's `WALLET` frame says right now, and the note it carries
   * is **consumed**: reading clears it, so a sentence is sent once.
   *
   * The countdown is for the nearest office within a claim radius plus a little
   * -- see `net/cash.WalletFrame.centrelinkNextMs` for why one number rather
   * than the whole table. `-1` means there is nothing near enough to be talking
   * about, which is where a player is 99% of the time.
   */
  walletFrame(playerId: number, into: WalletFrame): WalletFrame | null {
    const p = this.participants.get(playerId);
    if (!p || p.wallet === null) return null;
    into.balance = p.wallet.balance;
    into.note = p.walletNote;
    p.walletNote = '';
    into.bundles = this.bundles;
    into.centrelinkNextMs = -1;
    const near = nearestOffices(p.combat.body.position.x, p.combat.body.position.z, 1, this.officeScratch);
    // A little wider than the claim radius, so the phone's countdown appears as
    // you walk up to the door rather than snapping on at the moment the prompt
    // does. Thirty metres is about a shopfront's width either side.
    if (near.length > 0 && near[0].distance <= CLAIM_RADIUS_M * 5) {
      into.centrelinkNextMs = claimWaitMs(p.wallet.centrelink[near[0].office.id] ?? 0, Date.now());
    }
    return into;
  }

  private readonly officeScratch: Array<{ office: CentrelinkOffice; distance: number }> = [];

  /** This player's fare, or null for a bot and for an id that has left. */
  fareOf(playerId: number): FareJob | null {
    return this.participants.get(playerId)?.fare ?? null;
  }

  /** Every bundle on the ground. Owned by this object; serialise before the next step. */
  cashBundles(): readonly CashBundle[] {
    return this.bundles;
  }

  private stepRideBy(): void {
    const tick = trafficTick(Date.now());
    for (const p of this.ordered) {
      if (p.bot) continue;
      const c = p.combat;
      const offending = c.ridingBike !== 0 && c.bikeTuned && c.phase !== 'ko';
      if (!offending) {
        this.seenRiding.set(p.id, false);
        continue;
      }
      const w = policeWitness(
        c.body.position.x,
        c.body.position.z,
        tick,
        this.witnessCtx,
        this.witness,
      );
      const was = this.seenRiding.get(p.id) === true;
      this.seenRiding.set(p.id, w.seen);
      if (w.seen && !was) this.accuse(p, REASON.BIKE);
    }
  }

  /**
   * One tick of every faction, and the damage they do.
   *
   * The context is rebuilt per tick because two of its members genuinely change
   * -- the combatant list and the tick -- and the rest are stable references. It
   * is one object literal a tick against `MAX_ACTORS` `think` calls inside it,
   * which is not a cost worth a cached record and a staleness bug.
   */
  private stepFactions(): void {
    // The context, **built once in the constructor** and mutated here.
    //
    // PERFORMANCE.md phase 1, and it reverses the call the comment that used to
    // sit here made. That comment was right about the cost -- one object
    // literal a tick is nothing against `MAX_ACTORS` `think`s inside it -- and
    // wrong about the shape: the literal carried four *closures*, so it was
    // five allocations a tick and, worse, a fresh callable identity that no
    // engine can inline through. Two of its members genuinely change and both
    // are assigned below; the other nine are stable references that were being
    // re-copied sixty times a second.
    const ctx = this.factionCtx;
    ctx.tick = trafficTick(Date.now());
    ctx.combatants = this.combatants;
    const before = this.factions.investigationCount;
    this.factions.step(ctx);
    // The street factions' ambient promotion scan, **after** the step and before
    // the events are drained. `FactionField.step` clears its own event list at
    // the top of every call, so an aggro bark queued before it would be wiped
    // before anybody saw it -- which presents as meth heads who occasionally
    // charge in silence. See `stepStreetlife`, which states the same ordering
    // from the other side.
    stepStreetlife(ctx);
    // And the wildlife's, in the same place and for the same reason. It wakes
    // the birds a player has walked up to and refuses at its own budget --
    // `WILDLIFE_BUDGET`, a third of the field -- so a park full of turkeys can
    // never be the reason an officer could not be dispatched to somebody.
    stepWildlife(ctx, this.wildScratch, this.wildPose);
    // And the heat ladder, **after** the factions rather than before: the
    // crimes reported during the last tick are drained by `FactionField.step`,
    // which is what calls `accuse`, which is what feeds the ladder. Running it
    // first would put every crime a tick late and would make a 3-star
    // escalation arrive after the officers it is supposed to bring. See
    // `game/heat.stepHeat`, which states the same ordering from its own side.
    stepHeat(ctx, this.heat, this.heatWorld);
    // --- And workstream E's two, in the same place and for the same reason.
    //
    // `stepCharacters` promotes the eshay, Karen, tradie, influencer or agent a
    // player has walked up to, inside its own eight-actor budget.
    // `stepEvents` promotes the standoff's three and the burnout's constable
    // inside a budget of three. Neither can be the reason an officer could not
    // be dispatched; see `characters.MAX_CHARACTER_ACTORS`.
    //
    // `sweepEvents` runs **before** `stepEvents` deliberately, and it is the one
    // ordering in this block that is not simply "after the step". It despawns
    // actors whose event has finished, which is what frees the budget the
    // promotion below then spends -- the other way round, an event that ended on
    // the same tick a new one opened would hold its slot for one more tick every
    // tick, and the symptom would be the second event never getting anybody.
    sweepEvents(ctx);
    // The eshays roll a player for $20 through the characters module's
    // process-wide `wallet()` handle. Pointed at **this** simulation on every
    // tick rather than once at boot, because a host runs several rooms and each
    // room is its own `Simulation` with its own participant ids -- a wallet
    // handle set once would debit room 0's player 7 for room 3's mugging.
    setWallet(this.walletLookup);
    stepCharacters(ctx);
    stepEvents(ctx);
    // An investigation that ran out changes what the wire has to say, and
    // nothing inside the field can bump a version it does not know about.
    if (this.factions.investigationCount !== before) this.investigationVersion++;
    this.factionEvents.length = 0;
    for (const e of this.factions.events) this.factionEvents.push(e);
  }

  /**
   * A round, landing on a player.
   *
   * Half a pip, off the same `health` field every other weapon in the game
   * lowers, and the knockout goes through the same `HIT` event -- with the
   * victim as their own attacker, which is the sentinel a car already uses and
   * means "the world did this". `factions.NpcKindDef.scoresKo` is false for the
   * police, so nobody's leaderboard row moves; the *down* is still counted,
   * because being dropped by the police is a thing that happened to you and the
   * downs column is the record of that.
   *
   * The **damage is applied here and nowhere else**, which is the whole of the
   * anti-cheat story for this feature. A client cannot dodge it by dropping
   * inputs -- an officer's `think` runs on this process at 60 Hz whatever the
   * socket is doing -- and cannot fake it, because there is no message a client
   * could send that reaches this line. The client's own copy of the shot is a
   * tracer and a crack; `net.reconcile` overwrites `health` from the very next
   * snapshot either way.
   */
  private shoot(playerId: number, pips: number, actor: NpcActor): void {
    void actor;
    this.hurt(playerId, pips);
  }

  /**
   * Take pips off a player with nobody to blame but the world.
   *
   * Split out of `shoot` when jumping out of a moving train needed the same
   * thing: the phase, the clock, the respawn and the `HIT` event with the victim
   * as their own attacker are all the shared machine's, and a second copy of
   * them would be a second place the knockout could be spelled differently.
   * `factions.NpcKindDef.scoresKo` reasoning applies unchanged -- nobody's
   * leaderboard row moves, and the *down* is still counted, because being
   * thrown off a train at 130 km/h is a thing that happened to you.
   */
  private hurt(playerId: number, pips: number): void {
    const p = this.participants.get(playerId);
    if (!p) return;
    const c = p.combat;
    if (c.phase === 'ko' || c.health <= 0) return;
    // The knockout, spelled once, in the function both authorities run --
    // `combat.applyWorldDamage`. See its header for why it is not `applyHit`
    // with the victim as their own attacker.
    const ko = applyWorldDamage(c, pips);
    if (ko) {
      this.creditKo(playerId, playerId);
      // The investigation ends with the player. Being shot by the police is the
      // countdown's other terminal state, and a banner that survived a respawn
      // would have the player wanted for something they were already punished
      // for.
      //
      // The **ladder** is wiped by `creditKo` above rather than here, because
      // that is the funnel every knockout passes through and this one is only
      // the world's. See there.
      this.factions.clearInvestigation(playerId);
      this.investigationVersion++;
      this.seenRiding.set(playerId, false);
    }
    this.events.push({
      kind: EVENT.HIT,
      attacker: playerId,
      victim: playerId,
      flags: ko ? EVENT_FLAG.KO : 0,
      health: c.health,
    });
  }

  /**
   * `E`, on its rising edge: get on the nearest free bike, or off the one you
   * are on.
   *
   * **The range test is against the server's own position**, not against a
   * claim, which is the only reason this is here rather than trusted from the
   * client: `INPUT` carries a button and nothing else, so a client asking to
   * mount is asking about whatever bike happens to be next to the body the
   * server is simulating. `checkBikes` asserts that a client pressing `E` in the
   * middle of the harbour gets nothing.
   *
   * A knocked-out player cannot mount. Everything else can -- including
   * mid-flinch, which is deliberate: the flinch already takes your movement away
   * for 300 ms, and taking the bike as well would mean a rider who was clipped
   * once could not get back on until the fight ended.
   */
  private resolveMount(p: Participant): void {
    const pressed = p.input.mount === true;
    const rising = pressed && !p.mountHeld;
    p.mountHeld = pressed;
    if (!rising) return;
    const c = p.combat;
    if (c.phase === 'ko') return;

    // --- The train, ahead of the bike, and one key for both.
    //
    // `E` has one meaning -- "get on or off the thing beside you" -- and adding
    // a second key for trains would have been a second key for a mutually
    // exclusive state. So this is a priority chain rather than two features:
    // off a train, then off a bike, then onto a train, then onto a bike. The
    // ordering falls out of one rule, *leaving beats arriving*, and it settles
    // the only ambiguous case there is: a rider standing at an open door does
    // not re-board the carriage they are already in.
    //
    // A player on a bike who walks up to an open door presses `E` twice, and
    // that is the right number: the first press parks the bike on the platform
    // where they are standing, which is where a bike belongs, and the second
    // takes them aboard. Carrying it on would mean a lime bike arriving at
    // Central inside carriage four with nothing to park it on.
    if (isAboard(c.aboard)) {
      this.alight(p);
      return;
    }

    if (c.ridingBike !== 0) {
      // Off. The bike is parked where the body is -- by `follow` at the end of
      // this tick, which has the position after the step rather than before it.
      c.ridingBike = 0;
      return;
    }

    if (c.drivingCar !== 0) {
      // Out. Same shape as the bike one line up and for the same reason: the
      // car is left standing where the body is by `CarField.follow` at the end
      // of this tick, which has the position *after* the step. Clearing the
      // field is the whole of it -- the sweep does the rest, and a player who
      // is knocked out instead of pressing E gets identical behaviour from
      // identical code.
      //
      // The record survives with `driverId = 0`, which is the brief's rule and
      // is what makes a getaway car a thing anybody can take: the next person
      // to press E beside it is refused by `resolveTake` (its ambient copy is
      // suppressed, so it is not in the lookup) and served by `nearestEmptyCar`
      // below instead.
      c.drivingCar = 0;
      c.carSpeed = 0;
      return;
    }

    if (this.tryBoard(p)) return;
    const feet = c.body.position.y - EYE_HEIGHT;
    const bike = this.bikes.nearestFree(c.body.position.x, feet, c.body.position.z);
    if (bike) {
      // The one place a claim is decided, and it can still fail: an earlier
      // participant in this same loop may have taken it a microsecond ago.
      if (!this.bikes.claim(bike.id, c.id)) return;
      c.ridingBike = bike.id;
      this.bikeChanges.push(bike);
      return;
    }

    this.tryTakeCar(p);
  }

  /**
   * Get into the car beside you, if the *server* agrees there is one.
   *
   * The anti-cheat story is `tryBoard`'s verbatim and is worth restating,
   * because it is the whole reason the parked kerb fleet is not stealable (see
   * `game/driving.ts` section 1): `INPUT` is ten bytes of buttons and a look
   * direction, so there is no field in which a client could *name* a car. A
   * take is a question asked with a button, and it is answered here against
   *
   *   1. **this server's own position for that body**, never one the client sent;
   *   2. **this server's own evaluation of `poseCar`** at this tick's traffic
   *      tick, which is a closed-form function of the millisecond and is
   *      asserted identical to the browser's by `checkTraffic`;
   *   3. `CarField`, which refuses an identity somebody already has.
   *
   * An empty car standing in the street is checked **first**, because it is a
   * thing the world contains that the lookup no longer describes -- its ambient
   * copy is suppressed precisely so it stops existing on the timetable, so
   * `resolveTake` will never find it. Getting back into the car you just parked
   * is the commonest thing a driver does and it has to work.
   */
  private tryTakeCar(p: Participant): void {
    const c = p.combat;
    const feet = c.body.position.y - EYE_HEIGHT;

    // --- Somebody's abandoned getaway car, or your own.
    const standing = this.nearestEmptyCar(c.body.position.x, feet, c.body.position.z);
    if (standing !== null) {
      standing.driverId = c.id;
      standing.emptyMs = 0;
      c.drivingCar = standing.id;
      c.carSpeed = 0;
      this.carChanges.push(standing);
      // **No crime.** Getting into a car that is already standing open in the
      // street with nobody in it is not the theft -- the theft happened when
      // somebody took it off the timetable, and it was reported then. Charging
      // for it again would mean a driver who stopped at a red, got out to punch
      // somebody and got back in collected two counts of car theft.
      return;
    }

    // --- Or one off the timetable, which is the theft.
    const scratch = this.takeScratch;
    if (
      !resolveTake(
        this.world.traffic,
        c.body.position.x,
        feet,
        c.body.position.z,
        trafficTick(Date.now()),
        scratch.routes,
        scratch.pose,
        (identity) => this.cars.suppressed(identity),
        scratch.take,
      )
    ) {
      return;
    }
    // --- Make room, if the room is out of records.
    //
    // `game/driving.ts` section 6: cars do not despawn, so the only thing that
    // ever frees a record is this, and it only runs on the theft that would push
    // the room past `MAX_DRIVEN_CARS`. The rule -- never occupied, never within
    // `RECYCLE_KEEP_RADIUS` of anybody, then farthest, then oldest -- is
    // `CarField.recycleFarthest`'s and is checked there.
    //
    // A failed recycle is a failed take, and that is the correct failure: `E`
    // does nothing, which is what pressing `E` at a car somebody else has
    // already taken does, rather than a car being deleted out of somebody's view
    // so that a four hundred and first one could exist.
    if (this.cars.size >= MAX_DRIVEN_CARS) {
      this.recycleScratch.length = 0;
      for (const other of this.ordered) {
        this.recycleScratch.push(other.combat.body.position.x, other.combat.body.position.z);
      }
      const recycled = this.cars.recycleFarthest(this.recycleScratch);
      if (recycled === 0) return;
      this.carRemovals.push(recycled);
    }

    const car = this.cars.take(scratch.take, c.id);
    // Null means an earlier participant in this same loop took it a microsecond
    // ago -- `CarField.take` is the one place that claim is decided, exactly as
    // `BikeField.claim` is for a bike.
    if (car === null) return;
    c.drivingCar = car.id;
    c.carSpeed = 0;
    this.carChanges.push(car);

    // --- And the crime, if anybody was there to see it.
    //
    // Reported and not graded: what a car thief is worth is the heat ladder's
    // decision and lives in another module. See `factions.REASON.CAR_THEFT`.
    //
    // Bots never steal cars (`Bot` never sets `BTN.MOUNT`), so there is no
    // clause here about them -- but a bot standing on the footpath *is* a
    // witness under `policeWitness`' promoted-actor tier, which is correct.
    if (this.sawTheft(car.x, car.y, car.z)) reportCrime(c.id, REASON.CAR_THEFT);
  }

  /**
   * The nearest car standing empty within reach, or null.
   *
   * Linear in driven cars, which are counted in ones -- see the budget note in
   * this class's header. Ties break on the record id rather than on the float
   * distance, on `BikeField.nearestFree`'s rule and for its reason: the client
   * predicts this same choice and an integer comparison is a rule both ends can
   * state.
   */
  private nearestEmptyCar(x: number, feetY: number, z: number): DrivenCar | null {
    let best: DrivenCar | null = null;
    let bestD2 = TAKE_RADIUS * TAKE_RADIUS;
    for (const car of this.cars.all()) {
      if (car.driverId !== 0) continue;
      const dy = car.y - feetY;
      if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
      const dx = car.x - x;
      const dz = car.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD2) continue;
      if (best !== null && d2 >= bestD2) continue;
      best = car;
      bestD2 = d2;
    }
    return best;
  }

  /**
   * Did anybody see that theft?
   *
   * Both tiers, and the order is `policeWitness`' own: an officer is a witness
   * and so is anybody on the footpath. `driving.bystanderSeen` does the geometry
   * and this supplies the crowd and the line of sight, which keeps
   * `game/driving.ts` out of the pedestrian module's import graph -- the same
   * seam `factions.policeWitness` makes with its `ctx`.
   */
  private sawTheft(x: number, y: number, z: number): boolean {
    if (policeWitness(x, z, trafficTick(Date.now()), this.witnessCtx, this.witness).seen) return true;
    const peds = this.world.peds;
    if (peds === null) return false;
    const tick = trafficTick(Date.now());
    return bystanderSeen(
      x,
      y,
      z,
      (visit) => {
        forEachPedestrianNear(peds, x, z, WITNESS_RADIUS, tick, this.witnessBands, this.witnessPed, (ped) => {
          visit(ped.x, ped.y, ped.z, ped.down);
        });
      },
      this.world.collision === null
        ? null
        : (ax, ay, az, bx, by, bz) => this.world.collision!.blocked(ax, ay, az, bx, by, bz),
    );
  }

  /**
   * The driven cars, after everybody has moved and every hit has landed.
   *
   * Three sweeps, and all three are sweeps rather than events on `BikeField`'s
   * argument -- one rule covering being knocked out, being run over, respawning,
   * pressing E and disconnecting, none of which needed to know cars exist.
   *
   *   1. **`follow`** carries each occupied car to its driver and leaves any
   *      whose driver has stopped driving standing in the road.
   *   2. **The knockdown**, which is `game/traffic.ts`' own, reused rather than
   *      reimplemented: a driven car fills a `CarPose` (`drivenCarPose`) and is
   *      then put through `carOverlaps`, `carHitStrength` and `applyCarHit`
   *      exactly as an ambient one is. That is the only way "a car knocks you
   *      down" can mean one thing in this game.
   *   3. **The crashes**, which is new: a wall or a kerb arrives on the
   *      combatant as `carCrashDv` (`combat.advance` filled it), car against car
   *      is decided here because it is the one collision that needs two records,
   *      and both go through `CarField.damage` so the cooldown has one owner.
   *   4. **The clocks**, every tick. What used to be a 1 Hz expiry sweep is now
   *      `CarField.age`, which removes nothing -- see `game/driving.ts` section
   *      6, where the five-minute abandonment became a budget.
   *
   * O(driven cars), and driven cars are now counted in hundreds rather than in
   * ones -- the budget is `MAX_DRIVEN_CARS`. Every sweep here was already
   * O(records) with a handful of adds each, and the two that are not (the
   * knockdown and the car-against-car test) are gated on a car being *occupied
   * and moving*, which is bounded by the sixteen-player cap however many wrecks
   * are standing around the city.
   */
  private stepCars(): void {
    // The blocker roster is published even when it is empty, because "empty"
    // is the signal that puts `HoldLedger.live` back to false and lets every
    // ambient car in Sydney skip the hold in one comparison. Doing it before the
    // early-out below is what makes the last car being recycled actually release
    // the traffic that was queued behind it.
    this.publishBlockers();
    if (this.cars.size === 0) return;

    this.driverViews.length = 0;
    for (const p of this.ordered) {
      const c = p.combat;
      // **The health mirror, pushed in before anything reads it.** See
      // `combat.CombatantState.carHealth`: `combat.advance` needs to know how
      // wrecked the car is and cannot reach a `CarField`, so the owner of the
      // field puts the number where the integrator can see it. One tick stale by
      // construction, which is 17 ms of the wrong top speed on the tick a car is
      // written off.
      c.carHealth = c.drivingCar === 0
        ? CAR_HEALTH_MAX
        : this.cars.get(c.drivingCar)?.health ?? CAR_HEALTH_MAX;
      this.driverViews.push({
        id: c.id,
        drivingCar: c.drivingCar,
        carSpeed: c.carSpeed,
        x: c.body.position.x,
        feetY: c.body.position.y - EYE_HEIGHT,
        z: c.body.position.z,
        yaw: c.body.yaw,
      });
    }

    // --- What everybody drove into. Drained before `follow`, because a crash
    // that killed the driver has already cleared `drivingCar` and the sweep is
    // about to leave the car in the road -- and the wall still happened.
    for (const p of this.ordered) {
      const c = p.combat;
      const dv = c.carCrashDv;
      c.carCrashDv = 0;
      if (dv <= 0 || c.drivingCar === 0) continue;
      const cost = crashDamage(dv);
      if (cost <= 0) continue;
      const car = this.cars.damage(c.drivingCar, cost);
      if (car !== null) this.carChanges.push(car);
    }

    // --- And into each other. The only collision in this game that needs two
    // records, which is why it is here and not in `combat.advance` with the
    // other half of the detection.
    //
    // Gated on the outer car being **occupied and moving**, so the loop is
    // O(drivers x records) and not O(records^2): a room at the four-hundred-car
    // budget with sixteen players driving is 6,400 plan-distance tests a tick,
    // and a room where every car is parked is zero. `carCrashClosing` is four
    // multiplies before its own early-out.
    for (const car of this.cars.all()) {
      if (car.driverId === 0) continue;
      const speed = car.speed < 0 ? -car.speed : car.speed;
      if (speed <= 0.5) continue;
      const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
      const half = size.length * 0.5;
      for (const other of this.cars.all()) {
        if (other === car) continue;
        // The vertical gate, `carOverlaps`' own: a car on the Cahill Expressway
        // is not in the car on Alfred Street eight metres below it.
        const dy = other.y - car.y;
        if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
        const otherSize = CAR_BODY_SIZE[other.body] ?? CAR_BODY_SIZE[0];
        const closing = carCrashClosing(
          { x: car.x, z: car.z, yaw: car.yaw, speed: car.speed, halfLength: half },
          { x: other.x, z: other.z, yaw: other.yaw, speed: other.speed, halfLength: otherSize.length * 0.5 },
        );
        if (closing <= 0) continue;
        // **Both of them**, which is the brief's word and is also the only
        // answer that does not need a rule about who was at fault. The cooldown
        // on each record is what stops the two of them trading damage every
        // tick they stay tangled.
        const cost = crashDamage(closing);
        const a = this.cars.damage(car.id, cost);
        if (a !== null) this.carChanges.push(a);
        const b = this.cars.damage(other.id, cost);
        if (b !== null) this.carChanges.push(b);
      }
    }

    for (const car of this.cars.follow(this.driverViews, this.carSweep)) {
      // A car whose driver has just got out (or been thrown out) is snapped into
      // a kerb bay if it stopped beside one. See `parkOnLeave`.
      this.parkOnLeave(car);
      this.carChanges.push(car);
    }

    // --- What the driven fleet ran over.
    const tick = trafficTick(Date.now());
    for (const car of this.cars.all()) {
      if (car.driverId === 0) continue;
      const speed = car.speed < 0 ? -car.speed : car.speed;
      if (speed < RUN_DOWN_SPEED) continue;
      const pose = drivenCarPose(car, this.drivenPose);
      // `carHitStrength` scales the launch by how fast the thing that hit you
      // was going, and it is already 1 at everything past
      // `CAR_HIT_FULL_SPEED` (8 m/s) -- so the brief's 4 m/s floor lands in the
      // ramp's middle and a car that has just pulled away tips you over where
      // one at a road speed sends you across the street. That continuity is the
      // property `carHitStrength`'s header says is a requirement.
      if (carHitStrength(pose) <= 0) continue;

      let offended = false;

      // --- Players and bots.
      for (const victim of this.ordered) {
        if (victim.id === car.driverId) continue;
        // Nobody on a train is run over by a stolen Camry, on exactly the
        // clause the ambient fleet has thirty lines up and for its reason.
        if (isAboard(victim.combat.aboard)) continue;
        if (!canBeRunDown(victim.combat)) continue;
        if (!carOverlaps(pose, victim.combat)) continue;
        const ko = applyCarHit(victim.combat, pose);
        // Credited to the **driver** rather than to the victim, which is the one
        // place this differs from the ambient fleet: there really is somebody
        // behind the wheel, and a knockout with a name on it is the difference
        // between "you got run down" and "a car got you".
        if (ko) this.creditKo(car.driverId, victim.id);
        this.events.push({
          kind: EVENT.HIT,
          attacker: car.driverId,
          victim: victim.id,
          flags: ko ? EVENT_FLAG.KO : 0,
          health: victim.combat.health,
        });
        offended = true;
      }

      // --- And the crowd.
      if (this.world.peds !== null) {
        const hit = runDownPedestrian(
          this.world.peds, pose, car.driverId, tick, this.pedBands, this.pedPose,
        );
        if (hit !== null) {
          offended = true;
          // Two hp, and cosmetic on purpose -- see `driving.PEDESTRIAN_DAMAGE`.
          // Through the same `damage` call the walls use, so the same cooldown
          // applies and a car driven through a crowd collects one dent per half
          // second rather than one per body.
          const scuffed = this.cars.damage(car.id, PEDESTRIAN_DAMAGE);
          if (scuffed !== null) this.carChanges.push(scuffed);
        }
      }

      // Unconditional, unlike the theft: `REASON.CAR_THEFT` needs a witness
      // because a crime nobody saw is not reported, and a body in the road is
      // its own witness. See `factions.REASON.DANGEROUS_DRIVING`.
      if (offended) reportCrime(car.driverId, REASON.DANGEROUS_DRIVING);
    }

    // --- The clocks, every tick. **Nothing expires.** See `CarField.age` and
    // `game/driving.ts` section 6: what this used to be was a 1 Hz sweep looking
    // for cars to delete, and what it is now is the empty-clock that breaks the
    // recycling tie and the crash cooldown that stops a scrape being fatal.
    // Every tick rather than every second because the cooldown is half a second
    // and a 1 Hz decrement cannot express it.
    this.cars.age(1000 / TICK_HZ);
  }

  /**
   * Hand the driven records to the traffic field, so the ambient fleet yields to
   * them. See `traffic.HoldLedger`.
   *
   * Every record and not only the moving ones, which is the whole feature: the
   * thing traffic has to queue behind is the Camry somebody **left** in the
   * lane, and a car with a driver in it is a car that will move on its own. The
   * occupied ones are in the roster too because a player who has stopped at a
   * green light is just as much an obstruction as one who got out.
   *
   * Rebuilt in place into `this.blockers`, which is grown once and reused: this
   * runs every tick over up to `MAX_DRIVEN_CARS` records and the array is the
   * only thing that could allocate.
   */
  private publishBlockers(): void {
    const cars = this.cars.all();
    let n = 0;
    for (const car of cars) {
      const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
      const slot = this.blockers[n];
      if (slot === undefined) {
        this.blockers.push({ x: car.x, y: car.y, z: car.z, halfLength: size.length * 0.5 });
      } else {
        slot.x = car.x;
        slot.y = car.y;
        slot.z = car.z;
        slot.halfLength = size.length * 0.5;
      }
      n++;
    }
    this.blockers.length = n;
    this.world.traffic.held.setBlockers(this.blockers);
  }

  /**
   * A car whose driver has just got out, snapped into the kerb bay beside it if
   * there is one within reach.
   *
   * The brief's second clause: "a car you leave in a parking bay is a parked
   * car, not a car in the middle of the lane". Without it, getting out beside a
   * bay leaves the car wherever the *body* was standing when the sweep ran --
   * which is a metre and a half out from the gutter at whatever angle the driver
   * happened to be looking, and reads as abandoned rather than as parked.
   *
   * The bays are `pipeline/sydney/bays.py`'s, read out of the sidecar by
   * `traffic.nearestBay`, so this cannot invent a parking spot: it is the same
   * ledger the ambient fleet parks in, which is what stops a player's car being
   * snapped on top of one of the 23,020 static ones.
   *
   * `PARK_SNAP_RADIUS` is the brief's 3 m, and it is a *snap* rather than a pull
   * -- a car left in the middle of the road stays exactly where it was left,
   * because the whole point of the other half of this feature is that the
   * traffic yields to it.
   */
  private parkOnLeave(car: DrivenCar): void {
    if (car.driverId !== 0) return;
    const found = nearestBay(this.world.traffic, car.x, car.z, PARK_SNAP_RADIUS, this.bayScratch, this.bayProbe);
    // Two calls and no arithmetic here: the *geometry* of finding a bay is
    // `traffic.nearestBay`'s and is asserted in `verifyTraffic`, and the *rule*
    // about what to do with one is `driving.snapToBay`'s and is asserted in
    // `verifyDriving`. `main.ts`' offline sweep runs the identical pair, which
    // is what makes `?offline` the same feature rather than a second one.
    snapToBay(car, found ? this.bayProbe : null);
  }

  // --- Trains ---------------------------------------------------------------------

  /**
   * Where a rewound passenger *appeared to be*: 250 ms old in the carriage, and
   * not one millisecond old along the railway.
   *
   * The rewind's whole job is to put a target where the swinger's screen had it,
   * and for a rider the swinger's screen had them somewhere the plain history
   * does not. `net/client.placeRiders` composes a remote rider from their
   * carriage-local offset and the train's pose **at present time** -- a train is
   * a closed-form function of the clock, so there is nothing about it to
   * interpolate and interpolating it anyway would put two people in one carriage
   * a fifth of a carriage apart. What *is* interpolated is the walking, in the
   * carriage's frame, where 250 ms is a stride.
   *
   * So the correction is: take the historical world position, push it back into
   * the carriage's frame **at the instant it was recorded**, and pull it out
   * again through the carriage's frame **now**.
   *
   *     seen = frame(now) . frame(now - back)^-1 . recorded
   *
   * Nothing is stored to make that possible, and that is the architectural claim
   * TRAINS.md makes about riding paying for itself: `poseTrain` is closed form,
   * so a frame at any past instant is one evaluation away, and the inverse is
   * the transpose because the basis is orthonormal. Without it every swing
   * aboard a train at 44 m/s would be adjudicated eleven metres behind the
   * carriage the fight is in, and would miss.
   *
   * A rider who was not on this train 250 ms ago -- they boarded inside the
   * window -- is reframed with a frame that did not have them in it, and the
   * answer is wrong by however far they walked. That is bounded by a stride and
   * is the same error every non-rider already carries.
   */
  private readonly reframeRider = (
    live: CombatantState,
    back: number,
    at: { x: number; y: number; z: number; yaw: number },
  ): void => {
    const a = live.aboard;
    if (!isAboard(a)) return;
    const bake = this.world.rail ?? null;
    if (bake === null) return;
    if (!aboardFrame(bake, a, this.railT - back, this.pastFrame)) return;
    if (!aboardFrame(bake, a, this.railT, this.nowFrame)) return;
    worldToLocal(this.pastFrame, at.x, at.y, at.z, this.reframeTmp);
    localToWorld(this.nowFrame, this.reframeTmp.x, this.reframeTmp.y, this.reframeTmp.z, this.reframeTmp);
    at.x = this.reframeTmp.x;
    at.y = this.reframeTmp.y;
    at.z = this.reframeTmp.z;
  };

  private readonly pastFrame = createCarFrame();
  private readonly nowFrame = createCarFrame();
  private readonly reframeTmp: Vec3Out = { x: 0, y: 0, z: 0 };

  /**
   * Get on the train beside you, if the *server* agrees there is one.
   *
   * This is the whole of the anti-cheat story for boarding and it is the bikes'
   * verbatim, one level harder. `INPUT` is ten bytes of buttons and a look
   * direction: there is no field in which a client could name a trip, a
   * carriage or an offset, so a boarding claim is not a claim at all -- it is a
   * question asked with a button, answered here against
   *
   *   1. **this server's own position for that body**, not one the client sent;
   *   2. **this server's own evaluation of `poseTrain`** at this tick's
   *      `railT`, which is a closed-form function of the millisecond and is
   *      asserted bit-identical to the browser's by `checkRail`;
   *   3. `doorsOpen`, which `poseTrain` sets only while the curve is stationary
   *      at a *calling* station -- a fifteen-second window, at a platform,
   *      per trip.
   *
   * `findBoarding`'s reach is 2.2 m off the bodyside and 2.4 m of rise, which is
   * "standing in the doorway or one pace back from it". A client pressing `E`
   * in the middle of the harbour gets nothing, a client pressing it beside a
   * train that is not stopped gets nothing, and a client pressing it under the
   * viaduct a train is crossing gets nothing -- the rise test is what closes
   * that last one, and it is the only one of the three that is not obvious.
   *
   * The one thing the client *does* decide is when to ask, which is the same
   * prediction the bike makes: `main.ts` runs the identical function against the
   * identical bake and puts the player aboard on the frame the key goes down, so
   * the ride starts on the next frame rather than on the next round trip. If it
   * was wrong, the very next snapshot has them on the platform.
   */
  private tryBoard(p: Participant): boolean {
    const bake = this.world.rail ?? null;
    if (bake === null) return false;
    // `riding.boardHere` is the sequence, and it is the client's: the same
    // `findBoarding`, the same yaw subtraction into the carriage's frame, the
    // same `projectAboard` closing it. What makes this the authority is the two
    // arguments -- **this** server's body and **this** server's `railT` -- and
    // not a second copy of the arithmetic.
    return boardHere(
      bake, p.combat.aboard, p.combat.body, this.railT, this.frame, this.boardOffer, EYE_HEIGHT,
    );
  }

  /**
   * Get off, by whichever of the three doors this is.
   *
   * TRAINS.md's rule, in the order it is written there: at a dwell you step onto
   * the platform; at speed you may jump, and it hurts; in a tunnel there is
   * nothing to jump onto, so you are relocated to the next station and told you
   * were dragged out by staff.
   *
   * The tunnel case is not a mercy, it is the only defensible answer. The
   * pipeline builds a tube around the track and no floor beside it -- nobody
   * walks the tunnels, and TRAINS.md says so in as many words -- so "put them
   * where they jumped" is putting them inside rock, where there is no terrain
   * grid, no collision and no water table, and `groundHeight`'s last-known
   * fallback means they would not even fall. They would stand in the dark on the
   * height of whoever asked last. `checkRiding` asserts a tunnel bail-out lands
   * on a platform and never in the hill.
   */
  private alight(p: Participant): void {
    const bake = this.world.rail ?? null;
    const c = p.combat;
    const a = c.aboard;
    if (bake === null) {
      clearAboard(a);
      return;
    }
    const dir = dirOf(bake, a.line, a.dir);
    const pose = aboardPose(bake, a, this.railT);
    if (dir === null || pose === null || !aboardFrame(bake, a, this.railT, this.frame)) {
      // The trip has run out from under them -- a terminus, or a bake that no
      // longer holds this line. `strandRider` is the same path the tick loop
      // takes when `aboardFrame` fails, so there is one answer to it.
      this.strandRider(p);
      return;
    }
    const it = interiorOfCar(consistOf(dir, a.trip), a.car);
    if (it === null) {
      this.strandRider(p);
      return;
    }
    const speed = pose.speed;
    const s = pose.s;
    const tunnel = (spanFlagsAt(bake, dir, s) & SPAN_TUNNEL) !== 0;

    if (pose.doorsOpen) {
      // The ordinary way off: onto the platform, at platform height, on the side
      // they were standing. Composed through the carriage's own frame so the two
      // ends land on the same square metre -- see `riding.alightPlatform`.
      alightPlatform(this.frame, it, a.x, a.z, this.world.platforms ?? null, this.landing);
      this.placeRider(p, this.landing);
      clearAboard(a);
      return;
    }

    if (tunnel) {
      const stop = nextCall(dir, s);
      if (stop >= 0 && stopPlatform(bake, dir, stop, a.z, this.landing)) {
        this.placeRider(p, this.landing);
        clearAboard(a);
        // The killfeed line is the client's -- see `main.ts` -- but the *event*
        // is here, as a self-inflicted zero-damage hit, so a spectator's feed
        // says something happened rather than a body silently teleporting.
        this.events.push({
          kind: EVENT.HIT,
          attacker: p.id,
          victim: p.id,
          flags: 0,
          health: c.health,
        });
        return;
      }
      this.strandRider(p);
      return;
    }

    // Out the side at speed. Two metres clear of the bodyside at rail level,
    // which is the ballast, and then the arithmetic decides how much of them
    // arrives.
    alightTrackside(this.frame, it, a.x, a.z, this.landing);
    this.placeRider(p, this.landing);
    clearAboard(a);
    // The fall, thrown along the train's own heading rather than dropped: a body
    // leaving a train at 36 m/s does not stop being at 36 m/s, and the one place
    // in this feature where the train's velocity *is* the player's is the moment
    // they stop being a passenger. Damped hard, because the ragdoll's own
    // friction is written for a body that was punched rather than for one that
    // left a train, and 36 m/s of tumble crosses two suburbs.
    const damp = 0.22;
    c.body.velocity.set(pose.dx * speed * damp, 1.5, pose.dz * speed * damp);
    c.body.onGround = false;
    const pips = bailoutDamage(speed);
    if (pips > 0.05) this.hurt(p.id, pips);
  }

  /**
   * Put any body at a world point, authoritatively. `/platform`'s arrival.
   *
   * `placeRider` below is this with the ride's bookkeeping around it; this is the
   * bare move, and it is public because a chat command is not a member of this
   * class and has no business reaching into a participant's body to seed a
   * rewind ring it has never heard of. The ride is ended first, on
   * `enterLocal`'s own rule -- a body that has been teleported is a body that is
   * no longer on the train it was on.
   */
  placeAt(p: Participant, x: number, y: number, z: number, yaw: number): void {
    clearAboard(p.combat.aboard);
    p.combat.body.position.set(x, y, z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.onGround = true;
    p.combat.body.yaw = yaw;
    p.history.seed(this.tick, x, y, z, yaw);
  }

  /**
   * Put a rider on the ground at a world point, ending the ride's bookkeeping.
   *
   * The velocity is cleared here and re-set by the one caller that wants one.
   * Nothing else about the body is touched -- health, stamina, the coffees and
   * the bat's clock all survive getting off a train, which is `unstuck`'s rule
   * and for its reason: a free heal on a fifteen-second dwell is the one way
   * this could decide a fight.
   */
  private placeRider(p: Participant, at: Vec3Out): void {
    const c = p.combat;
    c.body.position.set(at.x, at.y, at.z);
    c.body.velocity.set(0, 0, 0);
    c.body.onGround = true;
    // Seed the rewind ring, on `respawnAt`'s argument: for the next 250 ms an
    // unseeded history would rewind this player back inside a train that has
    // since left the station, and a punch thrown at that spot would land on
    // somebody standing 400 m up the line.
    p.history.seed(this.tick, at.x, at.y, at.z, c.body.yaw);
  }

  /**
   * The ride ended and there is no carriage left to get out of.
   *
   * Reached two ways, and both of them are "the trip stopped existing": the
   * train reached its terminus while somebody was still on it, or the bake
   * changed under a live ride. The last known world position is where the body
   * already is, so the honest thing is to leave it there and let the ground
   * claim it -- but the last known world position of a passenger is *inside a
   * train*, and a train at a terminus is over the buffers. So this puts them on
   * the platform of the last station the trip called at, which is where a
   * passenger who fell asleep actually ends up.
   */
  private strandRider(p: Participant): void {
    const bake = this.world.rail ?? null;
    const a = p.combat.aboard;
    const dir = bake === null ? null : dirOf(bake, a.line, a.dir);
    if (bake !== null && dir !== null) {
      const stop = nextCall(dir, dir.lengthM);
      if (stop >= 0 && stopPlatform(bake, dir, stop, a.z, this.landing)) {
        this.placeRider(p, this.landing);
      }
    }
    clearAboard(a);
  }

  /**
   * Move this body into its carriage for one step, and say which world to use.
   *
   * Returns `p.world` -- the city -- for everybody who is not on a train, which
   * is the overwhelming majority of every tick and costs one boolean. For a
   * rider it aims the shared `CarriageStand` at their carriage's interior and
   * returns that instead, so `advance` steps them against a floor, four walls
   * and a staircase rather than against Sydney.
   *
   * The three ways a ride ends here are all "something else already decided":
   * the world has no bake, the trip is no longer running, or `enterLocal` found
   * that the body had been moved in world coordinates since the last tick --
   * a respawn, an unstuck, a teleport, a hard reconciliation snap. See
   * `riding.enterLocal`, which is where that last one is argued out.
   */
  private enterCarriage(p: Participant): CombatWorld {
    this.carriageFrame = null;
    const c = p.combat;
    const a = c.aboard;
    if (!isAboard(a)) return p.world;

    // `riding.rideEnter` is the sequence and this is the policy. The trip
    // running out is the one case this end answers differently from the browser:
    // a client leaves the body where it is for a round trip and waits to be
    // told, and the server *is* the telling, so `strandRider` puts them on the
    // last platform the trip called at rather than over the buffers.
    switch (rideEnter(this.world.rail ?? null, a, c.body, this.railT, this.frame, this.carriage)) {
      case RIDE_ON:
        this.carriageFrame = this.frame;
        return this.carriage as unknown as CombatWorld;
      case RIDE_TRIP_GONE:
        this.strandRider(p);
        return p.world;
      default:
        // No bake, or something moved the body. Either way there is nowhere to
        // put them that is better than where they already are.
        clearAboard(a);
        return p.world;
    }
  }

  /**
   * Compose the stepped body back into the world. The other half of `enterCarriage`.
   *
   * `riding.rideExit` rather than `exitLocal`, and the difference is the gangway:
   * a rider who has walked past a coupling plane changes carriage here, inside
   * the fixed step, before the composition -- so the frame their world position
   * is derived from is the carriage they are in at the end of the tick and the
   * `aboard` section of the next snapshot names it. The client runs the identical
   * call on the identical inputs and predicts the same crossing; see
   * `net/client.reconcileAboard` for the hundred milliseconds in between.
   *
   * **The yaw delta it hands back is dropped here, and only here.** On a reversal
   * the carriage frame turns through half a turn and a rider's local heading has
   * to turn with it; the browser owns that number because the browser owns the
   * mouse accumulator it has to be added to (`main.ts`, `wasAboard`). This end
   * has no accumulator -- the next `INPUT` arrives already turned -- and
   * `crossGangway` has already put the turn on `aboard.yaw`, which is what this
   * tick's snapshot is written from.
   */
  private exitCarriage(p: Participant): void {
    const f = this.carriageFrame;
    if (f === null) return;
    this.carriageFrame = null;
    rideExit(this.world.rail ?? null, p.combat.aboard, p.combat.body, this.railT, f);
  }

  /**
   * Every rider in this room, as wire records, indexed by player id.
   *
   * Indexed rather than listed because `Room.fill` selects by the *player*
   * interest set -- a rider is in your snapshot's aboard section exactly when
   * they are in its player section -- so the lookup is by id and the section is
   * built per client from this map. Pooled on `snapshot`'s terms.
   */
  aboardSnapshot(): Map<number, SnapshotAboard> {
    this.aboardById.clear();
    let n = 0;
    for (const p of this.ordered) {
      const a = p.combat.aboard;
      if (!isAboard(a)) continue;
      let rec = this.aboardPool[n];
      if (rec === undefined) {
        rec = { id: 0, line: 0, dir: 0, tripLow: 0, car: 0, x: 0, y: 0, z: 0 };
        this.aboardPool.push(rec);
      }
      rec.id = p.id;
      rec.line = a.line;
      rec.dir = a.dir;
      // The low byte, resolved back against the live departures by the receiver.
      // `& 0xff` on a negative trip index is still the right byte: trips before
      // the epoch are negative and the mask is two's complement, so the
      // receiver's `trip & 0xff` matches whatever this wrote.
      rec.tripLow = a.trip & 0xff;
      rec.car = a.car;
      rec.x = a.x;
      rec.y = a.y;
      rec.z = a.z;
      // No yaw: a rider's world yaw is already in their ordinary player record
      // and that is the only one anybody draws with. See `protocol.ABOARD_BYTES`.
      this.aboardById.set(p.id, rec);
      n++;
    }
    return this.aboardById;
  }

  /** Spec 8.2's punch, against the attacker's own view of the world. */
  private resolveStrike(p: Participant): void {
    const began = performance.now();
    // PERFORMANCE.md phase 1. This used to rewind **every combatant in the
    // world** and hand the lot to `hitTest`, which then measured them all and
    // threw away everyone further than the bat's 1.55 m -- so a swing in a
    // five-hundred-player world built five hundred proxies to find at most one
    // target. The grid answers the same question directly.
    //
    // `rewindIndex` files each player under the box their rewind window covers,
    // so a candidate set taken at `REACH` contains everybody the old full scan
    // could have found: a rewound position is always inside that box, and
    // `hitTest`'s own plan-distance gate is the same `REACH`. The remaining
    // work -- the sweep, the nearest-wins rule, the order ties resolve in -- is
    // untouched. See `game/spatialhash.ts`.
    const candidates = this.rewindIndex.collectWithin(
      p.combat.body.position.x,
      p.combat.body.position.z,
      REACH,
      this.strikeCandidates,
    );
    this.rewindPool.length = 0;
    const targets = rewindInto(
      p.combat,
      candidates,
      this.histories,
      this.tick - p.viewTicks,
      this.rewindPool,
      this.strikeProxies,
      // And the one correction a passenger needs. See `RewindReframe`, and
      // `reframeRider` below for the arithmetic. It is a no-op for everybody who
      // is not on a train, which is everybody, almost always.
      this.reframeRider,
      this.tick,
    );
    const victim = resolveLiveById(hitTest(p.combat, targets), this.byId);
    if (victim) {
      this.hitReport = applyHit(p.combat, victim);
      if (this.hitReport.ko) this.creditKo(p.id, victim.id);
      this.events.push({
        kind: EVENT.HIT,
        attacker: p.id,
        victim: victim.id,
        flags: this.hitReport.ko ? EVENT_FLAG.KO : 0,
        health: victim.health,
      });
    }

    // --- ...and the same swing against everybody who is not a player.
    //
    // Both of the tests below run **whether or not the swing hit a player**,
    // which is not a bug: a bat is one cast and it is entitled to find whichever
    // of the three kinds of body is nearest. What it may not do is find two, and
    // it cannot -- a player, a pedestrian and an officer are three separate
    // nearest-wins tests over three disjoint sets of bodies, and each takes at
    // most one.
    //
    // **Neither is rewound**, and that is the whole reason they are here rather
    // than folded into `rewind` above. Lag compensation answers "what was the
    // attacker looking at when they clicked", which is the right question about
    // a *remote player* whose position this client saw 100 ms late. A pedestrian
    // is a pure function of the tick and both ends evaluate the same one; a
    // police officer on a beat is the same function. There is nothing to be late
    // about, so rewinding them would move a body away from where the attacker
    // actually saw it.
    this.strikeBystanders(p);
    this.strikeOfficers(p);
    // The whole swing, players and bystanders and officers, in one number.
    // Accumulated per strike rather than per tick because a swing is rare --
    // `advance` above already carries the cost of everybody who did not swing.
    this.phaseMs.melee += performance.now() - began;
  }

  /**
   * The swing, against the crowd, **on the server**.
   *
   * This is the line that turns a cosmetic knockdown into a crime, and the whole
   * of why it is here rather than taken from the client: `main.ts` calls the
   * identical `strikePedestrian` for the picture, and this process calls it
   * again for the *consequence*. The two agree because a pedestrian is a
   * deterministic function of `(band, slot, tick)` -- which is exactly the
   * property `game/pedestrians.ts` was built with and `verifyPedestrians`
   * asserts -- so no claim crosses the wire and none is trusted.
   *
   * A client that deleted its own call is still under investigation. A client
   * that fabricated one is not, because there is nothing to fabricate: the only
   * thing it sends is a button, and the button is spent on a swing whose
   * geometry this process re-derives from a body it is simulating itself.
   */
  private strikeBystanders(p: Participant): void {
    const hit = strikePedestrian(this.world.peds, p.combat, trafficTick(Date.now()), this.pedBands, this.pedPose);
    if (hit === null) return;
    this.reportIfWitnessed(p, hit.x, hit.z, REASON.ASSAULT);
    // "-50% if you knocked anyone down during the trip". One of the three
    // places anything goes down; see `markRough`.
    this.markRough(p.id);
  }

  /**
   * The swing, against the police themselves.
   *
   * A separate cast rather than a bigger target list, for `strikePedestrian`'s
   * reason and one more: an officer's capsule is `factions.NpcKindDef`'s and not
   * the player's, so a faction that registers something the size of a possum
   * gets hit where a possum is rather than where a person would be. The reach,
   * the cast radius and the nearest-wins rule are the swing's own, out of
   * `combat.ts`, so an officer standing beside a player is hit under exactly the
   * conditions the player would have been.
   *
   * Batting an officer is `REASON.ASSAULT_POLICE` **whether or not anybody else
   * saw it**, which is the one place in this feature the witness test is
   * deliberately skipped: the officer you just hit is the witness.
   */
  private strikeOfficers(p: Participant): void {
    const c = p.combat;
    // `combat.viewDirection`'s vector without the `Vector3`, which is
    // `strikePedestrian`'s own construction -- this runs once per swing, on the
    // machine adjudicating it, so the two `Math.sin` calls are off every shared
    // path.
    const cp = Math.cos(c.body.pitch);
    const ax = c.body.position.x;
    const ay = c.body.position.y;
    const az = c.body.position.z;
    const bx = ax - Math.sin(c.body.yaw) * cp * REACH;
    const by = ay + Math.sin(c.body.pitch) * REACH;
    const bz = az - Math.cos(c.body.yaw) * cp * REACH;
    const actor = npcHitTest(this.factions, ax, ay, az, bx, by, bz, CAST_RADIUS);
    if (actor === null) return;
    this.hitNpc(actor, 1, p);
  }

  /**
   * One NPC, hit by one player, through the framework's single door.
   *
   * `strikeNpc` owns the re-hit guard, the down clock and the feed template;
   * this owns what a *server* has to do about it -- the crime, and the event
   * that tells everybody a hit landed. The `HIT` event carries the attacker as
   * both attacker and victim, which is the sentinel `server/sim.ts` already uses
   * for a car: it means "something in the world did this, and no player's
   * scoreboard moves". A faction can be knocked down without inventing a
   * protocol message for it.
   */
  private hitNpc(actor: NpcActor, pips: number, p: Participant): void {
    // **Read the crime before the strike, not after.** `strikeNpc` may put the
    // actor on the ground, and whether hitting one of them was a crime is a
    // question about the person who was standing there a moment ago -- a drunk
    // who was minding their own business until the swing landed is a bystander,
    // and asking afterwards would find them unconscious and answer no.
    const reason = strikeCrime(actor);
    const strike = strikeNpc(this.factions, actor, pips, p.name, p.id, this.tick);
    if (!strike.landed) return;
    // --- Workstream E: a tradie who has just been hit decks you back.
    //
    // **After** the strike, which is the opposite of `strikeCrime`'s rule and
    // for the mirrored reason: that one asks about the person who was standing
    // there a moment ago, and this tells the person who is standing there now
    // what to do about it. A no-op for every other kind, including the other
    // four of ours, so there is no `switch` here.
    characterStruck(actor, p.id);
    const def = npcKind(actor.kind);
    // Assaulting police is its own reason and needs no witness -- see
    // `strikeOfficers`. Every other kind asks its own faction, which is what
    // lets the street factions say "a meth head is never a crime and a drunk is
    // one only while they are calm" without this file knowing why. A kind that
    // registers no opinion gets the ordinary bystander rule.
    if (actor.kind === NPC_KIND.POLICE) {
      // **The swing and the result are two different charges**, which is what
      // the heat ladder needs to grade them apart: hitting a constable is a
      // 2-star response and putting one on the ground is a 3-star one, and a
      // single reason code cannot carry that. `strike.down` is read here rather
      // than inferred from the actor's state for the reason the crime is read
      // *before* the strike a few lines up -- the state is already the answer
      // to a different question by the time this line runs.
      this.accuse(p, strike.down ? REASON.MURDER_POLICE : REASON.ASSAULT_POLICE);
    } else if (isProtected(actor.kind)) {
      // **A protected native, and the crime is unconditional.** No witness test
      // and no line of sight: a bush turkey, an ibis and a magpie are protected
      // under the NPW Act, so hurting one is an offence whether or not a
      // constable was standing there -- and the user's instruction was "u get
      // police attack u if u hurt one (u have to run)", which a witness test
      // would quietly turn into "sometimes, if you are unlucky". A rule that
      // fires intermittently is a rule a player never learns. See
      // `game/wildlife.ts` section 3.
      //
      // Routed through `reportWildlifeCrime` rather than this file's `accuse`,
      // which is the framework's stated contract for a faction that wants the
      // police -- one call, drained by `FactionField.step` at the top of the
      // next step, which for a swing adjudicated earlier in this same tick is
      // the `stepFactions` a few lines further down. So it lands this tick.
      //
      // The version bump is the one thing that call cannot do for itself.
      // `stepFactions` bumps when the *count* of live investigations changes,
      // which covers a fresh one; a wildlife strike by somebody already under
      // investigation for something else re-labels rather than opens, and the
      // banner would go on reading "assaulting a bystander" while the police
      // arrived about a turkey. Two lines, and the bot rule is `accuse`'s.
      if (!p.bot) {
        const open = this.factions.investigationOf(p.id);
        reportWildlifeCrime(actor.kind, p.id);
        if (open && open.reason !== REASON.WILDLIFE) this.investigationVersion++;
      }
    } else if (reason !== REASON.NONE) {
      this.reportIfWitnessed(p, actor.x, actor.z, reason);
    }
    // --- Workstream I: the money falls out of the body.
    //
    // **On `strike.down` and nowhere else**, which is the "max one drop per NPC
    // per KO" clause enforced by construction rather than by a guard: `strikeNpc`
    // owns the re-hit guard, so an actor already on the ground reports
    // `down: false` for every subsequent swing and this line never runs twice
    // for one body. That is the same property `creditKo` relies on for the
    // scoreboard, and it is why there is no `alreadyPaid` flag on `NpcActor` --
    // a flag would be a second answer to a question the framework already
    // answers.
    //
    // Placed here rather than beside the `EVENT.HIT` push below because it has
    // to happen for *every* downed NPC, and that block is only for the kinds
    // that do not score a knockout.
    if (strike.down) this.dropNpcCash(actor, p);
    if (strike.down && def && !def.scoresKo) {
      // No leaderboard movement, deliberately: a scoreboard is a record of what
      // players did to each other, and a downed officer is not a player. The
      // event still goes out so every client plays the impact.
      this.events.push({
        kind: EVENT.HIT,
        attacker: p.id,
        victim: p.id,
        flags: 0,
        health: p.combat.health,
      });
    }
  }

  /**
   * Open or extend an investigation, and put it on the wire.
   *
   * One place, because there are five ways to become wanted and every one of
   * them has to bump the same version the transport is watching.
   */
  private accuse(p: Participant, reason: number): void {
    // Bots never commit crimes. They are server-driven bodies with no player
    // behind them, so a bot under investigation would be four officers spending
    // the wire budget on a pursuit nobody can see the point of -- and the bots
    // wander into pedestrians constantly.
    if (p.bot) return;
    const before = this.factions.investigationOf(p.id);
    const result = this.factions.accuse(p.id, reason, this.tick);
    if (result.opened || !before || before.reason !== reason) this.investigationVersion++;
  }

  /** The crime, if anybody saw it. The whole of the witness rule's use here. */
  private reportIfWitnessed(p: Participant, x: number, z: number, reason: number): void {
    if (p.bot) return;
    const tick = trafficTick(Date.now());
    const w = policeWitness(x, z, tick, this.witnessCtx, this.witness);
    if (w.seen) {
      this.accuse(p, reason);
      return;
    }
    // --- Workstream E: and if no officer saw it, a Karen might have.
    //
    // This is her entire function -- see `game/characters.ts` section 1. She
    // upgrades an *unwitnessed* crime to a witnessed one, which is why the call
    // is here rather than beside `policeWitness`: asking her first would mean
    // walking twenty-five metres of ambient placement on every swing in the city
    // to answer a question a constable standing right there had already
    // answered.
    //
    // `karenReport` calls `reportCrime` itself rather than returning a verdict
    // for this method to act on, which is the framework's stated contract
    // (`factions.ts` section 3): one call, drained by `FactionField.step` at the
    // top of the next step. The version bump is the thing that call cannot do
    // for itself -- `stepFactions` bumps when the *count* of live investigations
    // changes, which covers a fresh one, and a re-label on somebody already
    // wanted would otherwise leave the banner reading the previous crime. Two
    // lines, exactly as the wildlife path above does it.
    const open = this.factions.investigationOf(p.id);
    if (karenReport(p.id, reason, x, z, tick, this.witnessCtx)) {
      if (open && open.reason !== reason) this.investigationVersion++;
    }
  }

  /**
   * The argument bundle `policeWitness` takes, built once in the constructor.
   *
   * A field rather than an object literal at the call site, on the same
   * `carRoutes`/`carPose` argument this class already makes about the traffic
   * query: a witness test runs on every swing, every ball that reaches the crowd
   * and every tuned rider, and a fresh record on each of those would be the one
   * thing in this feature that allocates per event rather than per process.
   */
  private witnessCtx!: Parameters<typeof policeWitness>[3];

  // --- Serialisation ----------------------------------------------------------

  /**
   * The whole world's players, as snapshot records.
   *
   * Everybody, every time, with no relevance culling. In a melee game at spec
   * 2's sixteen-player cap the whole roster is inside a couple of hundred metres
   * of any fight worth having, and a culled snapshot's failure mode -- a player
   * who was culled last snapshot and appears three metres away this one -- is
   * exactly the pop the 100 ms interpolation buffer exists to prevent.
   */
  snapshot(into: SnapshotPlayer[]): SnapshotPlayer[] {
    // **Grown to a high-water mark and written in place**, rather than refilled
    // with fresh records.
    //
    // PERFORMANCE.md phase 1, and it is `protocol.decodeSnapshot`'s own trick
    // pointed the other way -- that function has always reused its output array
    // for exactly this reason and said so. A snapshot goes out twenty times a
    // second forever, so a fresh record per player per snapshot is 320 objects a
    // second at sixteen players and **ten thousand a second at five hundred**,
    // which was the third-largest allocation site in the process.
    //
    // Safe on the same terms `TickOutput` already states: the array is owned by
    // this object and the caller must serialise before the next `step`. It
    // already had to.
    const n = this.ordered.length;
    for (let i = into.length; i < n; i++) {
      into.push({ id: 0, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, anim: 0, health: 0, stamina: 0, phase: 0, flags: 0, ballCharges: 0 });
    }
    into.length = n;
    for (let i = 0; i < n; i++) {
      const p = this.ordered[i];
      const c = p.combat;
      const s = into[i];
      s.id = p.id;
      s.x = c.body.position.x;
      s.y = c.body.position.y;
      s.z = c.body.position.z;
      s.yaw = c.body.yaw;
      s.pitch = c.body.pitch;
      s.anim = animOf(c);
      s.health = c.health;
      s.stamina = c.stamina;
      s.phase = phaseIndex(c.phase);
      s.flags =
          (c.trainingT > 0 ? FLAG.TRAINING : 0) |
          (c.flatWhiteT > 0 ? FLAG.FLAT_WHITE : 0) |
          (c.body.onGround ? FLAG.ON_GROUND : 0) |
          // Read straight off the combatant's own throw clock rather than from a
          // separate countdown on the participant, which is what the raygun's
          // "drawn" flag needed. `combat.advance` maintains it on both ends, so a
          // countdown here would only ever be this one copied -- and would be the
          // copy that drifted.
          //
          // **`throwT` and not `ballT`, which is what this line said until the
          // report *"remove the recharge animation for the football"*.** `ballT` is
          // the supply's clock and the refill *consumes* it, so it returns to zero
          // every `BALL_RECHARGE` while a bar is filling -- and this flag went up
          // with it. The symptom on the wire was every other player's football
          // blinking out of their hand and back twice per ball they threw, at
          // 1.6 s intervals, on every client watching them. See
          // `CombatantState.throwT`, which exists for this line and three in the
          // browser.
          (c.throwT < THROW_FLAG_SECONDS ? FLAG.THROWING : 0) |
          // The two v6 bits. `RIDING` drives everybody's seated pose and the
          // bike drawn under it; `TUNED` is mostly for its owner and is the only
          // way a client ever learns it has been unlocked -- see
          // `net/client.reconcile`, which takes it and never sets it.
          // A driver is `RIDING` too, and that is the contract rather than a
          // shortcut: "being in a car is `FLAG.RIDING` plus a `CARS` roster
          // entry naming the driver" is exactly the bike convention, so every
          // nameplate, seated pose and camera rule already keying on this bit
          // keeps working for a car with nothing edited. `ENTER_FLAG.DRIVING`
          // and the `CARS` roster are what tell the two apart.
          (c.ridingBike !== 0 || c.drivingCar !== 0 ? FLAG.RIDING : 0) |
          (c.bikeTuned ? FLAG.TUNED : 0);
      s.ballCharges = c.ballCharges;
    }
    return into;
  }

  /**
   * Every football in the air, as snapshot records.
   *
   * Everybody's, every time, with no relevance culling -- on exactly the
   * argument `snapshot` above makes about players, and one more that is specific
   * to a projectile: a ball is most interesting to the player it is *about to
   * reach*, who by definition is not near the thrower. Culling by distance from
   * the viewer would hide precisely the ball that mattered until it was too
   * close to react to.
   */
  ballSnapshot(): SnapshotBall[] {
    // Written in place into a pooled array, on `snapshot` above's terms.
    const out = this.snapshotBalls;
    const n = this.balls.balls.length;
    for (let i = out.length; i < n; i++) {
      out.push({ id: 0, thrower: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, bounces: 0 });
    }
    out.length = n;
    for (let i = 0; i < n; i++) {
      const b = this.balls.balls[i];
      const s = out[i];
      s.id = b.id;
      s.thrower = b.thrower;
      s.x = b.x;
      s.y = b.y;
      s.z = b.z;
      s.vx = b.vx;
      s.vy = b.vy;
      s.vz = b.vz;
      s.bounces = b.bounces;
    }
    return out;
  }

  /**
   * Every promoted faction actor, as snapshot records.
   *
   * Everybody's, every time, with no relevance culling -- the argument the
   * players and the balls are carried under, plus the one that is specific to a
   * pursuer: the officer a player most needs to see is the one who has not
   * arrived yet, and culling by distance from the viewer would hide precisely
   * the one rounding the corner. `factions.MAX_ACTORS` is what bounds the
   * section instead, which is why that number is a wire budget.
   *
   * **The one `Math.atan2` in this feature is here.** An actor carries a unit
   * heading rather than an angle -- see `game/factions.ts`'s determinism rule --
   * and this is the point at which it becomes the yaw a renderer wants. Nothing
   * downstream of it feeds a decision, so it is off every shared path even
   * though it runs twenty times a second per actor.
   */
  npcSnapshot(): SnapshotNpc[] {
    // Written in place into a pooled array, on `snapshot` above's terms.
    const out = this.npcRecords;
    const n = Math.min(this.factions.actors.length, MAX_ACTORS);
    for (let i = out.length; i < n; i++) out.push({ id: 0, kind: 0, x: 0, y: 0, z: 0, yaw: 0, state: 0 });
    out.length = n;
    for (let i = 0; i < n; i++) {
      const a = this.factions.actors[i];
      const s = out[i];
      s.id = a.id;
      s.kind = a.kind;
      s.x = a.x;
      s.y = a.y;
      s.z = a.z;
      // Yaw 0 faces -Z, which is `CharacterActor`'s convention and the
      // camera's: the yaw that sends the figure's forward to (dx, dz) is
      // `atan2(-dx, -dz)`.
      s.yaw = Math.atan2(-a.dx, -a.dz);
      s.state = a.state;
    }
    return out;
  }

  /**
   * Who is wanted, as the wire wants them. Reused; serialise before the next step.
   *
   * `forEachInvestigation` rather than `liveInvestigations` because that one
   * spreads a `Map` into a fresh array, and this is called on the transport's
   * two-second refresh **and on every tick that changes the set** -- see
   * `server/index.ts`. Records are pooled on `snapshot` above's terms.
   */
  investigations(): InvestigationRecord[] {
    const out = this.investigationRecords;
    let n = 0;
    this.factions.forEachInvestigation((inv) => {
      let s = out[n];
      if (s === undefined) {
        s = { playerId: 0, reason: 0, ticks: 0 };
        out.push(s);
      }
      s.playerId = inv.playerId;
      s.reason = inv.reason;
      s.ticks = Math.max(0, Math.round(inv.ticks));
      n++;
    });
    out.length = n;
    return out;
  }

  /**
   * How wanted everybody is, as the wire wants them. Reused; serialise before
   * the next step.
   *
   * Pooled on `investigations()`' terms and for its reason: this is read on the
   * transport's refresh and on every tick the star count changes, and a fresh
   * array of fresh objects each time would be a few hundred short-lived
   * allocations a minute to say the same three numbers.
   */
  heatRecords(): HeatRecord[] {
    return this.heat.records(this.heatRecordPool);
  }

  /**
   * What one player's train is doing: -2 on foot, -1 aboard and moving, or the
   * index of the stop it is standing at. `heat.HeatWorld.rideStop`.
   *
   * Resolved from the ride the player is already on rather than from anything
   * new: `aboardPose` is the same call `resolveAboard` makes a few lines away,
   * against the same `railT` this tick already read once, so there is no second
   * clock and no second opinion about which train anybody is on. A ride whose
   * trip has finished reports "on foot", which is what it is about to be --
   * `resolveAboard` puts them on the platform on this same tick.
   */
  private rideStop(playerId: number): number {
    const p = this.participants.get(playerId);
    if (!p) return -2;
    const a = p.combat.aboard;
    if (!isAboard(a)) return -2;
    const bake = this.world.rail;
    if (!bake) return -2;
    const pose = aboardPose(bake, a, this.railT);
    if (pose === null) return -2;
    return pose.atStop;
  }

  /** Faction events this tick -- shots, barks, knockdowns. Drained by the transport. */
  factionDelta(): readonly FactionEvent[] {
    return this.factionEvents;
  }

  /** Spec 8.3's currently-taken points, for a joining client to mirror. */
  powerupsDown(): Array<{ tileX: number; tileZ: number; index: number; respawnT: number }> {
    const out: Array<{ tileX: number; tileZ: number; index: number; respawnT: number }> = [];
    for (const point of this.world.points) {
      if (point.active) continue;
      const at = this.world.tileOf.get(tileKeyOf(point.id));
      out.push({
        tileX: at?.tileX ?? 0,
        tileZ: at?.tileZ ?? 0,
        index: indexOf(point.id),
        respawnT: point.respawnT,
      });
    }
    return out;
  }

  /**
   * `/unstuck`: put this player on a random road, and charge them nothing for it.
   *
   * The rule -- where they go and whether they may go there -- is
   * `client/src/game/unstuck.ts`, which the client runs verbatim offline. This
   * method is only the three things that need the simulation: the roads out of
   * the room's own `TrafficField`, the ground query, and the two pieces of
   * bookkeeping a teleport must not skip.
   *
   * **Not `respawnAt`, deliberately.** That function is the *knockout's*
   * recovery: it restores health and stamina, empties spec 8.3's coffees and
   * takes the bike away. None of that is what being stuck in a wall deserves --
   * a player who used this at three pips would be handed six, which is a free
   * heal on a ten-second cooldown and the one way this command could decide a
   * fight. So the body moves and nothing else about the combatant changes. No
   * KO is credited to anybody and `downs` is untouched; see the module header.
   *
   * The two pieces of bookkeeping:
   *
   *   - **The velocity is zeroed and `onGround` set**, because a player who was
   *     mid-fall arrives on a street carrying the fall, and the first thing the
   *     next tick would do is drive them into the road surface.
   *   - **The position history is seeded**, exactly as the respawn sweep in
   *     `step` does and for its reason: for the next 250 ms an unseeded ring
   *     would rewind this player back to where they were stuck, and a punch
   *     thrown at that spot would land on somebody now 200 m away.
   *
   * Returns where they went, or null if the world around them had nothing --
   * which the caller reports rather than silently doing nothing.
   */
  unstuck(
    p: Participant,
    rand: () => number = Math.random,
    /**
     * Where to search from, when it is not where the player is standing.
     *
     * `/tp <suburb>` is this same move with a different origin: a suburb label
     * node is an arbitrary point that may well be inside a building, so the
     * arrival has to be chosen by the same road search, out of the same traffic,
     * and handed to the client through the same teleport handshake. One code
     * path, two commands. See `game/teleport.ts`.
     */
    to?: { x: number; z: number },
  ): UnstuckSpot | null {
    // Read out rather than aliased: `body.position` is written below, and a
    // search that read its origin off the object it is about to move would be a
    // search whose second rung started from its own first answer.
    const fromX = to ? to.x : p.combat.body.position.x;
    const fromZ = to ? to.z : p.combat.body.position.z;
    // A probe world rather than `p.world`, because `groundFor`'s closure carries
    // a `lastGround` that this search would otherwise fill with heights from a
    // kilometre away -- see `server/world.ts`. One closure per command.
    const probe = groundFor(this.world);
    const spot = unstuckDestination(
      fromX,
      fromZ,
      (radius) => this.world.traffic.near(fromX, fromZ, radius, this.unstuckRoutes),
      probe,
      rand,
      // Not in front of a car. The fleet is a pure function of the wall clock on
      // both ends -- see `game/traffic.ts` -- so this is the same set of cars the
      // player is about to see, evaluated once at the tick the command arrived.
      // A preference rather than a veto; `UNSTUCK_CAR_CLEAR_M` says why.
      this.unstuckClearOfTraffic(trafficTick(Date.now())),
    );
    if (!spot) return null;

    p.combat.body.position.set(spot.x, spot.y + EYE_HEIGHT, spot.z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.onGround = true;
    // Off the bike, on `respawnAt`'s argument: the bike stays where it was, and
    // riding one 200 m away would teleport it across Redfern. `BikeField.follow`
    // parks it under the rider on the next tick it is not being ridden.
    p.combat.ridingBike = 0;
    p.history.seed(
      this.tick,
      p.combat.body.position.x,
      p.combat.body.position.y,
      p.combat.body.position.z,
      p.combat.body.yaw,
    );
    return spot;
  }

  /**
   * "Is there a car about to be here?", as `unstuckDestination` wants it.
   *
   * A closure per command rather than a method, so the traffic tick is captured
   * once: a predicate that re-read the clock per candidate would evaluate the
   * fleet at a slightly different instant for every point it looked at, which is
   * not wrong so much as unrepeatable.
   *
   * The vertical test is `carOverlaps`' and is here for its reason: a car on the
   * Cahill is directly above Alfred Street and eight metres up, and without the
   * height comparison the whole viaduct would make the road underneath it
   * permanently unavailable.
   */
  private unstuckClearOfTraffic(tick: number): (x: number, z: number, y: number) => boolean {
    return (x, z, y) => {
      let clear = true;
      forEachCarNear(
        this.world.traffic,
        x,
        z,
        UNSTUCK_CAR_CLEAR_M,
        tick,
        this.unstuckCarRoutes,
        this.unstuckCarPose,
        (car) => {
          if (car.y > y + 4 || car.y + car.height < y - 4) return;
          clear = false;
          // Stop at the first one: the answer cannot get any more false.
          return true;
        },
      );
      return clear;
    };
  }

  /** Scratch for `unstuck`'s broadphase, so the command allocates one array ever. */
  private readonly unstuckRoutes: LaneRoute[] = [];
  /**
   * And a **second** array for the traffic test, which runs inside the first
   * one's result. One shared scratch would have the car query rewriting the road
   * list the search is walking, which is the kind of aliasing that produces a
   * destination in the middle of nowhere once in a hundred calls.
   */
  private readonly unstuckCarRoutes: LaneRoute[] = [];
  private readonly unstuckCarPose = createCarPose();
}

/**
 * How long after a throw `FLAG.THROWING` stays set, seconds.
 *
 * The client's `player/animation.THROW_DURATION` is 0.34 and this is 0.34 --
 * restated rather than imported, because that one is a *clip length* and this is
 * a *wire flag's* window, and the two are free to stop being equal: if the clip
 * were ever retimed, what a client should do with the leftover milliseconds is
 * that client's business. Both ends already have the number they need without
 * this file reaching into the animation layer for it.
 */
const THROW_FLAG_SECONDS = 0.34;

/** `PowerupPoint.id` is `"<tileKey>:<index>"`. See `game/powerups.PowerupField`. */
function tileKeyOf(id: string): string {
  return id.slice(0, id.lastIndexOf(':'));
}

function indexOf(id: string): number {
  return Number(id.slice(id.lastIndexOf(':') + 1)) | 0;
}

/**
 * The animation byte. See `protocol.ANIM` for why this is resolved here.
 *
 * The order of the tests is the precedence, and it is the client's own:
 * `CharacterActor` plays a reaction over a locomotion, so a knockout beats a
 * flinch beats a punch beats whatever the legs are doing. Under all of that the
 * four locomotions are chosen by the same two thresholds `derivedLocomotion`
 * uses -- 6.0 m/s to run and 0.35 to walk -- restated here rather than exported
 * because they are the *client's* presentation and this is one server's opinion
 * about which byte to send.
 */
function animOf(c: CombatantState): number {
  if (c.phase === 'ko') return ANIM.KO;
  if (c.phase === 'flinch') return ANIM.FLINCH;
  if (c.phase === 'windup') return ANIM.WINDUP;
  if (c.phase === 'active') return ANIM.ACTIVE;
  if (c.phase === 'recovery') return ANIM.RECOVERY;
  if (!c.body.onGround) return ANIM.JUMP;
  const speed = Math.hypot(c.body.velocity.x, c.body.velocity.z);
  if (speed > 6.0) return ANIM.RUN;
  if (speed > 0.35) return ANIM.WALK;
  return ANIM.IDLE;
}

const PHASES = ['idle', 'windup', 'active', 'recovery', 'flinch', 'ko'];
function phaseIndex(phase: string): number {
  const i = PHASES.indexOf(phase);
  return i < 0 ? 0 : i;
}

export function phaseName(index: number): string {
  return PHASES[index] ?? 'idle';
}

/** Decode `protocol.BTN` into the shared `CombatInput`. */
export function applyButtons(input: CombatInput, buttons: number): void {
  input.punch = (buttons & BTN.PUNCH) !== 0;
  input.throwBall = (buttons & BTN.THROW) !== 0;
  input.jump = (buttons & BTN.JUMP) !== 0;
  input.sprint = (buttons & BTN.SPRINT) !== 0;
  // Level, like its neighbours. `Simulation.resolveMount` takes the edge; see
  // `protocol.BTN.MOUNT` for why that split is where it is.
  input.mount = (buttons & BTN.MOUNT) !== 0;
}

// --- The self-check -----------------------------------------------------------

/**
 * A two-player fight, with no socket, in a world with no buildings.
 *
 * What this catches that `verifyCombat` cannot: `verifyCombat` proves the punch
 * works when it is called correctly, and every failure below is the server
 * calling it *incorrectly* while everything it calls remains right.
 *
 *   - **Applying damage to a rewound proxy.** The punch connects, the event
 *     fires, the sound plays, the camera shakes, and the victim's health is
 *     untouched because it was written into an object discarded at the end of
 *     the tick. There is no frame in which that looks wrong.
 *   - **Recording history at the top of the tick** rather than the end, which
 *     makes every rewind in the game one tick stale.
 *   - **Rebuilding the combatant list at the wrong moment**, so a player who
 *     joined this tick is advanced but is not a target, and is briefly
 *     invulnerable.
 *   - **An animation byte that never leaves IDLE**, which is a city of people
 *     sliding around in a T-pose.
 */
export function verifySim(): string[] {
  const failures: string[] = [];

  // An empty city rather than a stubbed one, and that is the point: a real
  // `CollisionWorld` with no prisms in it and a real `TerrainField` with no
  // grids, so every query below runs through the same `groundFor` the live
  // server uses. `TerrainField.height` returns its `NO_GROUND` sentinel for a
  // tile it does not hold, which is exactly the case `groundFor`'s
  // last-known-height fallback exists for -- so this check also covers the
  // branch that carries a player over the harbour.
  const world: ServerWorld = {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    // A dry city, on the same terms as the empty one around it: `WaterLevels`
    // with no tiles in it answers `NO_WATER` everywhere, which is the branch a
    // player standing on a street takes, and it is the branch this whole check
    // wants -- what it is testing is the punch, not the harbour.
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    // No lane graph, so no car ever exists and the traffic pass in `tick` is a
    // walk over an empty bucket grid. Exactly the same call `WaterLevels` above
    // it makes: what this check is testing is the punch, not the streets.
    traffic: new TrafficField(),
    // And no footpaths, so no walker and no officer on a beat exists. The
    // faction step still runs over it every tick, which is what this covers:
    // the whole police loop has to be a no-op in a city with nothing in it,
    // rather than the thing that throws on the first tick of a fresh server.
    peds: new PedestrianField(),
    points: [],
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    // No sidecars to re-adopt, because nothing here builds a second room. See
    // `world.roomWorld`, which is the only reader of this field.
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    // No suburbs: this fixture is about the ground query, and `/tp` resolving a
    // name is `game/teleport.ts`'s own check.
    places: [],
  };

  const sim = new Simulation(world);
  const a = sim.join(0, null);
  const b = sim.join(1, null);

  // Stand them 1 m apart, A facing B. Yaw 0 faces -Z.
  //
  // The yaw goes on the **input** as well as on the body, and forgetting that is
  // the first thing anyone writing a test against this loop gets wrong:
  // `controller.step` copies `input.yaw` into the body on every tick, so a body
  // yaw set here and not mirrored into the input is overwritten before the first
  // punch and the attacker faces wherever `joinSpot` put them.
  a.combat.body.position.set(0, EYE_HEIGHT, 1);
  b.combat.body.position.set(0, EYE_HEIGHT, 0);
  a.combat.body.yaw = 0;
  a.input.yaw = 0;
  b.input.yaw = 0;
  a.history.seed(sim.tick, 0, EYE_HEIGHT, 1, 0);
  b.history.seed(sim.tick, 0, EYE_HEIGHT, 0, 0);

  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const snap: SnapshotPlayer[] = [];

  // --- A punch lands, and the damage reaches the *live* combatant.
  a.input.punch = true;
  let hits = 0;
  let health = MAX_HEALTH;
  for (let i = 0; i < 40; i++) {
    sim.step(out);
    for (const e of out.events) {
      if (e.kind === EVENT.HIT) {
        hits++;
        health = e.health;
      }
    }
    a.input.punch = false;
  }
  if (hits !== 1) {
    failures.push(`A punch at 1 m produced ${hits} HIT events; it must produce exactly one.`);
  }
  if (Math.abs(b.combat.health - (MAX_HEALTH - 1)) > 1e-9) {
    failures.push(
      `A landed punch left the victim on ${b.combat.health} pips, not ${MAX_HEALTH - 1}. ` +
        `The damage was applied to a rewound proxy rather than to the live combatant.`,
    );
  }
  if (Math.abs(health - b.combat.health) > 1 / 64) {
    failures.push(`The HIT event reported ${health} pips against a live ${b.combat.health}.`);
  }

  // --- The victim was thrown. Spec 8.2's whole point, and it proves `applyHit`
  // wrote into a body the tick loop then integrated.
  if (Math.hypot(b.combat.body.position.x, b.combat.body.position.z) < 2) {
    failures.push('A punched victim had not moved 2 m after 40 ticks. The impulse went into a discarded object.');
  }

  // --- The animation byte moves. A snapshot where everyone is IDLE forever is a
  // city of people sliding in a T-pose.
  {
    const seen = new Set<number>();
    b.input.forward = 1;
    b.input.sprint = true;
    for (let i = 0; i < 120; i++) {
      sim.step(out);
      for (const s of sim.snapshot(snap)) seen.add(s.anim);
    }
    if (!seen.has(ANIM.RUN)) {
      failures.push(`A sprinting combatant never reported ANIM.RUN; the bytes seen were [${[...seen].join(', ')}].`);
    }
    b.input.forward = 0;
    b.input.sprint = false;
  }

  // --- Rewind: a punch thrown by a client 100 ms behind must land where the
  // victim *appeared to be*, which is where they were a round trip ago.
  //
  // The scenario is the real one rather than a contrived teleport: the victim
  // sprints away during the attacker's own 150 ms wind-up, so by the tick the
  // strike resolves they are 1.7 m off -- past spec 8.2's 1.2 m reach -- and
  // nine ticks earlier they were at 1.1 m and squarely inside it. The same
  // punch has to miss with no rewind and land with one, which is the only pair
  // of outcomes that distinguishes "the rewind ran" from "the reach is
  // generous".
  for (const [viewTicks, shouldHit] of [[0, false], [9, true]] as Array<[number, boolean]>) {
    const sim2 = new Simulation(world);
    const p = sim2.join(0, null);
    const q = sim2.join(1, null);
    p.combat.body.position.set(0, EYE_HEIGHT, 1.1);
    q.combat.body.position.set(0, EYE_HEIGHT, 0);
    p.combat.body.yaw = 0;
    p.input.yaw = 0;
    // Yaw 0 is -Z, and the attacker is at +Z, so the victim runs away.
    q.combat.body.yaw = 0;
    q.input.yaw = 0;
    p.history.seed(sim2.tick, 0, EYE_HEIGHT, 1.1, 0);
    q.history.seed(sim2.tick, 0, EYE_HEIGHT, 0, 0);

    q.input.forward = 1;
    q.input.sprint = true;
    p.viewTicks = viewTicks;
    p.input.punch = true;

    let landed = false;
    let separation = 0;
    for (let i = 0; i < 12; i++) {
      sim2.step(out);
      p.input.punch = false;
      // The strike fires on the tick the 150 ms wind-up ends, which is the
      // ninth. Measured just before it, so a landed punch's own knockback is
      // not in the number being reported.
      if (i === 7) separation = Math.abs(q.combat.body.position.z - p.combat.body.position.z);
      for (const e of out.events) if (e.kind === EVENT.HIT) landed = true;
    }

    if (separation < 1.3) {
      failures.push(
        `The rewind case only separated the combatants by ${separation.toFixed(2)} m during the ` +
          `wind-up; it has to exceed spec 8.2's 1.2 m reach or neither outcome means anything.`,
      );
    }
    if (shouldHit && !landed) {
      failures.push(
        `A punch rewound ${viewTicks} ticks did not land on a victim who was in reach ` +
          `${viewTicks} ticks ago. Spec 8.2's lag compensation is not reaching hitTest.`,
      );
    }
    if (!shouldHit && landed) {
      failures.push(
        `A punch with no rewind landed on a victim ${separation.toFixed(2)} m away. ` +
          `The reach gate is not working, and the rewind case above proves nothing.`,
      );
    }
  }

  // --- A RETURNED SERVE, END TO END, THROUGH THE REAL TICK LOOP.
  //
  // `game/swat.ts`'s own `verifySwat` proves the geometry and the deflection
  // against a hand-built swinger; this proves the four things only this loop can
  // be wrong about, and every one of them renders a perfectly good frame:
  //
  //   - the swat pass runs at all, and runs **before** `balls.step`, so the ball
  //     turns round on the tick the blade reached it rather than one tick and
  //     0.7 m later;
  //   - the `EVENT.SWAT` that carries the correction to the thrower's own
  //     predicted copy is actually emitted, with the right swinger on it. Miss
  //     it and the thrower watches a ghost ball fly on down the street;
  //   - the returned ball can hit **the person who threw it**, which is the
  //     mechanic, and is one word (`ball.owner`) in `footy.stepFooty`'s target
  //     loop away from being silently impossible;
  //   - the knockout is credited to the *swinger* and flagged `RETURNED`, so the
  //     feed says "returned serve on" rather than crediting the thrower with
  //     knocking themselves over.
  //
  // Six metres apart, which is the geometry that makes the timing work rather
  // than an arbitrary distance: a ball crosses it in about 0.14 s and the swing
  // takes 0.15 s to get the blade out, so a throw one tick after the swing
  // starts arrives inside the 100 ms `PUNCH_ACTIVE` window with room either
  // side. Any closer and the ball beats the wind-up; much further and it has
  // dropped under the bat.
  {
    const sim4 = new Simulation(world);
    const swinger = sim4.join(0, null, 'Batter');
    const thrower = sim4.join(1, null, 'Bowler');
    // The swinger at +Z looking down -Z, the thrower at the origin looking back.
    // The yaw goes on the **input** as well as the body for the reason the punch
    // case above states: `controller.step` copies it in on every tick.
    swinger.combat.body.position.set(0, EYE_HEIGHT, 6);
    thrower.combat.body.position.set(0, EYE_HEIGHT, 0);
    swinger.combat.body.yaw = 0;
    swinger.input.yaw = 0;
    thrower.combat.body.yaw = Math.PI;
    thrower.input.yaw = Math.PI;
    swinger.history.seed(sim4.tick, 0, EYE_HEIGHT, 6, 0);
    thrower.history.seed(sim4.tick, 0, EYE_HEIGHT, 0, Math.PI);
    // One pip left, so the return that lands is a knockout and the credit and
    // the flag can both be read off one event.
    thrower.combat.health = 1;

    let swats = 0;
    let swatBy = -1;
    let returnedKo = 0;
    let koAttacker = -1;
    let hits = 0;
    for (let i = 0; i < 90; i++) {
      swinger.input.punch = i === 0;
      thrower.input.throwBall = i === 1;
      // Both stand still: the point of the check is the ball, and a thrower who
      // wandered out of the return's line would make it a test of the walk.
      thrower.combat.body.position.set(0, EYE_HEIGHT, 0);
      thrower.combat.body.velocity.set(0, 0, 0);
      sim4.step(out);
      for (const e of out.events) {
        if (e.kind === EVENT.SWAT) {
          swats++;
          swatBy = e.swinger;
        } else if (e.kind === EVENT.HIT && (e.flags & EVENT_FLAG.FOOTY) !== 0) {
          hits++;
          if ((e.flags & EVENT_FLAG.RETURNED) !== 0 && (e.flags & EVENT_FLAG.KO) !== 0) {
            returnedKo++;
            koAttacker = e.attacker;
          }
        }
      }
      thrower.input.throwBall = false;
    }

    if (swats !== 1) {
      failures.push(
        `A ball thrown into a swing produced ${swats} SWAT events, not 1. Either the swat pass is ` +
          `not running in the tick, or it is running outside the ACTIVE window.`,
      );
    }
    if (swats > 0 && swatBy !== swinger.id) {
      failures.push(`A SWAT event named ${swatBy} as the swinger rather than ${swinger.id}.`);
    }
    if (hits !== 1) {
      failures.push(
        `The returned ball produced ${hits} footy HIT events, not 1. A ball batted back must be ` +
          `able to hit the person who threw it -- that is the whole mechanic, and footy.stepFooty ` +
          `skipping its *thrower* rather than its *owner* is what silently prevents it.`,
      );
    }
    if (returnedKo !== 1) {
      failures.push(
        `A returned serve that knocked its thrower out produced ${returnedKo} events flagged ` +
          `RETURNED|KO. Without the flag the feed says "pegged" and the most interesting thing ` +
          `that can happen in a fight is indistinguishable from an ordinary throw.`,
      );
    }
    if (returnedKo > 0 && koAttacker !== swinger.id) {
      failures.push(
        `A returned serve credited ${koAttacker} rather than the swinger ${swinger.id}. The ` +
          `knockout belongs to whoever sent the ball back, not to whoever threw it.`,
      );
    }
    if (swinger.kos !== 1 || thrower.downs !== 1) {
      failures.push(
        `After a returned serve the swinger has ${swinger.kos} KOs and the thrower ${thrower.downs} ` +
          `downs; both should be 1.`,
      );
    }
  }

  // --- The scoreboard: a knockout credits the attacker and counts the victim,
  // and the two names it is a list of are not the same name.
  //
  // What this catches has no picture, which is this project's bar for a check.
  // A KO credited to the *victim* -- the two ids are one line apart in
  // `creditKo` -- draws a scoreboard where getting knocked out is how you win,
  // and every individual knockout looks completely normal while it happens. A
  // dedupe that is not case-insensitive draws two rows called Bazza, which
  // reads as a rendering bug. Neither throws.
  {
    const sim3 = new Simulation(world);
    const attacker = sim3.join(0, null, 'Bazza');
    // Sanitised (the tab and the padding go) and then deduped against the name
    // above it, case-insensitively -- so this is "bazza (2)" or the scoreboard
    // has two rows nobody can tell apart.
    const victim = sim3.join(1, null, '  bazza\t ');
    if (attacker.name !== 'Bazza') failures.push(`A joiner asking for "Bazza" was named ${JSON.stringify(attacker.name)}.`);
    if (victim.name !== 'bazza (2)') {
      failures.push(
        `A second "bazza" was named ${JSON.stringify(victim.name)}, not "bazza (2)". Two identical rows ` +
          `is a scoreboard that has stopped working, and it is the case somebody joining twice creates.`,
      );
    }

    attacker.combat.body.yaw = 0;
    attacker.input.yaw = 0;
    victim.input.yaw = 0;
    const before = sim3.rosterVersion;
    let ticks = 0;
    while (victim.downs === 0 && ticks < 900) {
      // Held in reach on every tick, because the knockback works: spec 8.2
      // throws a victim 6-8 m and the second punch of a knockout would otherwise
      // be thrown at an empty street. The history is re-seeded with them, or the
      // rewind finds them where they were flung.
      attacker.combat.body.position.set(0, EYE_HEIGHT, 1);
      victim.combat.body.position.set(0, EYE_HEIGHT, 0);
      victim.combat.body.velocity.set(0, 0, 0);
      attacker.history.seed(sim3.tick, 0, EYE_HEIGHT, 1, 0);
      victim.history.seed(sim3.tick, 0, EYE_HEIGHT, 0, 0);
      // Edge-triggered on a 40-tick cadence: spec 8.2's cycle is 500 ms and the
      // bar is four swings, so this never hits the stamina lock. A *held* punch
      // empties the bar and the fourth attempt is refused, which is the game
      // working and would make this loop run out.
      attacker.input.punch = ticks % 40 === 0;
      sim3.step(out);
      ticks++;
    }

    if (victim.downs !== 1) {
      failures.push(`After ${ticks} ticks of being batted, the victim's down count is ${victim.downs}, not 1.`);
    }
    if (attacker.kos !== 1) {
      failures.push(`A knockout credited the attacker ${attacker.kos} KOs, not 1. The counters are on the wrong participant.`);
    }
    if (attacker.downs !== 0 || victim.kos !== 0) {
      failures.push(
        `The attacker finished with ${attacker.downs} downs and the victim with ${victim.kos} KOs; ` +
          `both must be zero, or the two ids in creditKo are the wrong way round.`,
      );
    }
    if (sim3.rosterVersion <= before) {
      failures.push('A knockout did not bump rosterVersion, so no client would ever be told the score changed.');
    }
    const row = sim3.roster().find((r) => r.id === attacker.id);
    if (!row || row.kos !== 1 || row.name !== 'Bazza') {
      failures.push(`The roster record for the attacker is ${JSON.stringify(row)}; it should carry Bazza on 1 KO.`);
    }
  }

  // --- Leaving removes the combatant, and the survivors keep ticking.
  {
    sim.leave(b.id);
    sim.step(out);
    if (sim.participants.has(b.id)) failures.push('A departed participant was still in the simulation.');
    const left = out.events.filter((e) => e.kind === EVENT.LEAVE);
    if (left.length !== 1) failures.push(`Leaving produced ${left.length} LEAVE events.`);
    sim.step(out);
    if (sim.snapshot(snap).length !== 1) {
      failures.push(`A snapshot after one of two left carried ${snap.length} players, not 1.`);
    }
  }

  return failures;
}
