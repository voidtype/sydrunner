/**
 * Two synthetic clients, one real server, no browser.
 *
 * The self-checks in `net/protocol.ts`, `server/rewind.ts` and `server/sim.ts`
 * each prove one thing in isolation, and every one of them would still pass if
 * the socket layer between them were wired to the wrong port. This is the check
 * that the whole path works: encode, send, decode, tick, rewind, adjudicate,
 * encode, send, decode. It is the milestone-9 claim -- *"two browsers see each
 * other move"* -- with the browsers replaced by arithmetic.
 *
 * What it asserts, in order:
 *
 *   1. Both clients are welcomed with distinct ids and distinct colourways.
 *   2. Both receive snapshots containing **both** ids, plus the two bots.
 *   3. Both see the other's position **advance** -- which is the one that
 *      catches a server that ticks but never applies input, and a client whose
 *      input encoding is silently a no-op.
 *   4. Walking them together produces a **punch that lands**, seen as a HIT
 *      event by both.
 *   5. Thrown **footballs cross as objects in the snapshot stream** and are seen
 *      flying by both clients -- a projectile is state here, not an event.
 *   6. The measured downstream rate is reported against spec 10's budget.
 *   7. **A ball's flight is bit-identical across two module instances**, the
 *      supply bar returns one ball at a time, and three thrown balls knock a
 *      dummy out -- see `checkFooty`.
 *   8. **Wading agrees on both sides of the wire**, run against the real world
 *      files rather than the socket -- see `checkWading`.
 *
 * It starts its own server on a spare port and shuts it down, so it can be run
 * beside a live one:
 *
 *     bun run server/integration-check.ts
 */

import {
  BTN,
  MAX_NAME_CHARS,
  MSG,
  SNAPSHOT_HZ,
  createSnapshot,
  decodeEvents,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeHello,
  encodeInput,
  encodePing,
  encodeRoster,
  frameType,
  rankRoster,
  sanitiseName,
  snapshotBytes,
  uniqueName,
  type RosterEntry,
  type SnapshotPlayer,
} from '../client/src/net/protocol.ts';
import { EVENT, EVENT_FLAG } from '../client/src/net/protocol.ts';
import {
  BALL_CHARGES,
  BALL_RECHARGE,
  MAX_HEALTH,
  MAX_STAMINA,
  REACH,
  advance,
  createCombatant,
  createHitReport,
  type CombatInput,
  type CombatWorld,
} from '../client/src/game/combat.ts';
import { FootyField, applyFootyHit, type FootyEvent } from '../client/src/game/footy.ts';
import { EYE_HEIGHT, PLAYER_RADIUS } from '../client/src/player/controller.ts';
import {
  SPAWN_DITHER_RADIUS,
  SPAWN_FIT_RADIUS,
  SPAWN_MAX_DEPTH,
  SPAWN_MAX_RELIEF,
  SPAWN_PIN,
  SPAWN_PROBE_RADIUS,
  SPAWN_STEP_HEIGHT,
  SPAWN_TARGET,
  pickSpawnPoint,
  spawnCentre,
  verifySpawn,
} from '../client/src/game/spawn.ts';
// `/unstuck`. See `checkUnstuck` at the foot of this file, which is entirely
// self-contained: the destination rule against the real lane graph, then the
// command surface over a real `ChatHub` and a real `RoomHost`.
import {
  UNSTUCK_CAR_CLEAR_M,
  UNSTUCK_COOLDOWN_MS,
  UNSTUCK_LADDER,
  UNSTUCK_RADIUS_M,
  unstuckCommand,
  unstuckDestination,
  verifyUnstuck,
} from '../client/src/game/unstuck.ts';
import { WADE_MAX_DEPTH, WaterLevels, waterDepth } from '../client/src/world/wading.ts';
import { eyeAt, groundFor, loadWorld } from './world.ts';
import {
  IP_VOTES_PER_WEEK,
  SUBMITS_PER_WEEK,
  SUGGEST_RESULT,
  TALLY_CLOSE,
  TALLY_OPEN,
  VOTES_PER_WEEK,
  decodeSuggestAck,
  decodeSuggestionList,
  encodeSuggestList,
  encodeSuggestSubmit,
  encodeSuggestVote,
  isoWeekOf,
  weekKey,
  type SuggestionList,
} from '../client/src/net/suggestions.ts';
import { FloodGuard, SUGGEST_BURST, SuggestionStore } from './suggestions.ts';
// The lime e-bikes. See `checkBikes` at the foot of this file, which is entirely
// self-contained and appended after every check that was here before it.
import {
  RIDE_STRAFE,
  RIDE_TURN_RATE,
  bikeSpeedScale,
  rideTurnRate,
  shapeRideSteering,
  TUNING_X,
  TUNING_Z,
  type RideSteering,
} from '../client/src/game/bikes.ts';
import { planSpeed, respawnAt } from '../client/src/game/combat.ts';
// The three damage paths a rider can be knocked out by, and the flag bits their
// consequences arrive on. See section 8b.
import { applyCarHit, CAR_STAGE_DRIVING } from '../client/src/game/traffic.ts';
import { CORRECTION_DEADZONE, CORRECTION_SNAP, NetClient } from '../client/src/net/client.ts';
import { TICK_HZ, type NetTransport } from '../client/src/net/protocol.ts';
import { FLAG } from '../client/src/net/protocol.ts';
import type { Participant } from './sim.ts';
import {
  PROTOCOL_VERSION,
  SNAPSHOT_INTERVAL,
  bikesBytes,
  decodeBikes,
  decodeHello,
  decodeInvestigations,
  encodeBikes,
  encodeInvestigations,
  encodeSnapshot,
  investigationBytes,
  type InvestigationRecord,
  type SnapshotNpc,
} from '../client/src/net/protocol.ts';
// The police. See `checkPolice` at the foot of this file, which is entirely
// self-contained and appended after every check that was here before it.
import {
  PedestrianField,
  createPedPose,
  forEachPedestrianNear,
  strikePedestrian,
  type PedBand,
} from '../client/src/game/pedestrians.ts';
import { ENGAGE_RANGE } from '../client/src/game/factions.ts';
import { trafficTick } from '../client/src/game/traffic.ts';
// The moving fleet, for `checkPolice`'s marked-car presence test. A liveried car
// is drawn by `world/cars.ts`, which imports three and cannot be loaded here --
// the *rule* lives in `game/factions.policeLiveried` precisely so this file can
// assert it. See there.
import { createCarPose, forEachCarNear, type LaneRoute } from '../client/src/game/traffic.ts';
import { Simulation, applyButtons, type TickOutput } from './sim.ts';
// The swing clock and the stamina budget, for `checkPolice`'s staged crime: it
// swings again when a bat misses a moving walker, and it has to space the
// presses a whole swing apart or the second one is refused mid-recovery.
import { PUNCH_TOTAL } from '../client/src/player/animation.ts';
/** `PUNCH_TOTAL` in ticks: wind-up, active window and recovery, at 60 Hz. */
const PUNCH_TICKS = Math.round(PUNCH_TOTAL * 60);

// PERFORMANCE.md phase 1. See `checkSpatialHash` at the foot of this file: the
// grid, the two rewind entry points it feeds, and the pooled encoder -- each
// asserted against the linear path it replaced.
import { SpatialHash, verifySpatialHash } from '../client/src/game/spatialhash.ts';
import { HISTORY_TICKS, PositionHistory, createBounds, rewind, rewindInto, type RewoundProxy } from './rewind.ts';
import { hitTest, type CombatantState } from '../client/src/game/combat.ts';
import { createFooty, createFootyStep, stepFooty } from '../client/src/game/footy.ts';
import { createPoint, tickPowerups, type PickupEvent, type PowerupKind } from '../client/src/game/powerups.ts';
import { encodeSnapshotInto, patchSnapshotAck } from '../client/src/net/protocol.ts';
// PERFORMANCE.md phase 2 and 3. See `checkAoi` and `checkRooms` at the foot of
// this file: the working-set rule against a brute-force scan, the frame-group
// dedup against a fresh allocating encode, and rooms over real sockets.
import {
  AOI_ENTER_RADIUS,
  AOI_LEAVE_RADIUS,
  AOI_MAX_PLAYERS,
  chooseRoom,
  decodeBye,
  decodeInterest,
  type RoomInfo,
} from '../client/src/net/protocol.ts';
import { verifyAoi } from './aoi.ts';
// Global chat. See `checkChat` at the foot of this file: cross-room delivery over
// real sockets, which is the one claim in this server that contradicts
// `checkRooms`' isolation on purpose.
import {
  CHAT_BURST,
  CHAT_FLAG,
  CHAT_INTERVAL_MS,
  CHAT_REPEAT_LIMIT,
  CHAT_SAY_HEADER_BYTES,
  MAX_CHAT_BYTES,
  decodeChatLine,
  encodeChatSay,
  verifyChat,
  type ChatLine,
} from '../client/src/net/chat.ts';
import { INPUT_RESERVE, Room, RoomHost, newConn, receiveInput, type Conn, type Socket } from './room.ts';
import { ChatHub } from './chat.ts';
import { roomWorld } from './world.ts';
// The streaming lifecycle. See `checkStreamingLifecycle` at the foot of this
// file, which is entirely self-contained and appended after every check that
// was here before it: the client's failure taxonomy and the collision/geometry
// parity rule, both of them pure arithmetic over the same `CollisionWorld` and
// the same `index.json` this process already reads.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CollisionWorld } from '../client/src/player/collision.ts';
import {
  COLLISION_LOAD_RADIUS_M,
  TileFetchError,
  TileRetryLedger,
  classifyTileFailure,
  mayEvictCollision,
  verifyTileLifecycle,
} from '../client/src/world/tile-lifecycle.ts';
// The two wire formats a tile arrives in. Both are pure arithmetic with no DOM
// and no `three` in them -- which is what lets the suite run the same functions
// the browser runs at boot rather than a paraphrase of them.
import { TILE_PACK_VERSION, verifyMeshPack } from '../client/src/world/tile-decode.ts';
import { verifyRegions } from '../client/src/world/regions.ts';
// The walk-under rule. See `checkSoffits` at the foot of this file: the band
// `CollisionWorld.resolve` now tests a body against, driven over the real
// viaducts by the real controller.
import { BODY_HEIGHT_M, verifyCollision, type Prism } from '../client/src/player/collision.ts';
import { createPlayerState, step } from '../client/src/player/controller.ts';

const PORT = Number(process.env.SYDNEY_CHECK_PORT ?? 8799);
const SERVER_URL = `ws://127.0.0.1:${PORT}`;
const SECONDS = 8;

const log: string[] = [];
const failures: string[] = [];

function say(line: string): void {
  log.push(line);
  console.log(line);
}

function check(ok: boolean, line: string): void {
  say(`  ${ok ? 'PASS' : 'FAIL'}  ${line}`);
  if (!ok) failures.push(line);
}

/**
 * A test for "is this anchor on ground the *currently built* world covers".
 *
 * The anchor tables and the world are baked to the same extent but not by the
 * same command, and between the two there is a real, ordinary state: the tables
 * carry the 15,300 m middle ring and `client/public/world` is still the 5,300 m
 * inner build, or the middle build is halfway through writing its tiles. Every
 * coverage check below wants the same thing out of that state -- *judge the
 * anchors the world claims to cover, and say plainly how many were skipped* --
 * and a check that instead asserted the tables against a stage nobody built
 * would fail for a whole afternoon while telling you nothing.
 *
 * So the gate is `index.radius_m` exactly -- the pipeline's own statement of what
 * it built, and the same disc the anchors were extracted inside, which is why a
 * table baked at a stage matches that stage's world with nothing skipped and
 * every check unweakened. No margin: a tile is emitted when it *intersects* the
 * disc, so everything inside the radius is on one, while a margin outward would
 * admit exactly the anchors the pipeline decided not to build.
 */
function builtGate(world: { index: { radius_m: number; tile_size: number } }): (x: number, z: number) => boolean {
  const r2 = world.index.radius_m * world.index.radius_m;
  return (x: number, z: number) => x * x + z * z <= r2;
}

/** How that gate reads in a check message. Empty once the world catches up. */
function builtNote(world: { index: { radius_m: number; stage: string } }, skipped: number): string {
  if (skipped === 0) return '';
  return ` (${skipped} skipped: outside the built ${world.index.stage} stage's ${world.index.radius_m} m)`;
}

/** One synthetic player: a socket, a yaw, and whatever it last heard. */
class Probe {
  readonly name: string;
  /** What this probe asks to be called. The server has the last word; see `roster`. */
  readonly wantedName: string;
  private socket!: WebSocket;
  id = 0;
  colourway = -1;
  /** The last ROSTER this probe was sent, and how many arrived. */
  roster: RosterEntry[] = [];
  rosters = 0;
  seq = 0;
  yaw = 0;
  pitch = 0;
  forward = 0;
  buttons = 0;
  welcomed = false;

  readonly seen = new Map<number, SnapshotPlayer>();
  /** First and last position seen for every id, to prove movement. */
  readonly firstAt = new Map<number, [number, number]>();
  readonly lastAt = new Map<number, [number, number]>();
  /**
   * Metres walked, summed over successive snapshots.
   *
   * Net displacement was the first version of this and it is the wrong measure:
   * the two probes walk apart and then back together, so a client that moved
   * perfectly can finish within a metre of where it started and read as frozen.
   * Path length cannot be faked by a server that never applied an input.
   */
  readonly path = new Map<number, number>();
  snapshots = 0;
  bytes = 0;
  hits: Array<{ attacker: number; victim: number; ko: boolean; footy: boolean }> = [];
  joins: number[] = [];
  /** Every ball seen in a snapshot, by id: where it was first and last, and how far it flew. */
  readonly balls = new Map<number, { thrower: number; first: [number, number, number]; last: [number, number, number]; path: number; bounces: number; samples: number; maxY: number }>();

  private readonly scratch = createSnapshot();

  constructor(name: string, wantedName = name) {
    this.name = name;
    this.wantedName = wantedName;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(SERVER_URL);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => socket.send(encodeHello(255, this.wantedName));
      socket.onerror = () => reject(new Error(`${this.name}: socket error`));
      socket.onmessage = (e) => {
        const frame = e.data as ArrayBuffer;
        this.bytes += frame.byteLength;
        switch (frameType(frame)) {
          case MSG.WELCOME: {
            const w = decodeWelcome(frame);
            if (!w) return;
            this.id = w.id;
            this.colourway = w.colourway;
            this.yaw = w.yaw;
            this.welcomed = true;
            resolve();
            return;
          }
          case MSG.SNAPSHOT: {
            const s = decodeSnapshot(frame, this.scratch);
            if (!s) return;
            this.snapshots++;
            for (const b of s.balls) {
              const seen = this.balls.get(b.id);
              if (seen === undefined) {
                this.balls.set(b.id, {
                  thrower: b.thrower,
                  first: [b.x, b.y, b.z],
                  last: [b.x, b.y, b.z],
                  path: 0,
                  bounces: b.bounces,
                  samples: 1,
                  // The apex, for the gravity test. See where it is read.
                  maxY: b.y,
                });
              } else {
                seen.path += Math.hypot(b.x - seen.last[0], b.y - seen.last[1], b.z - seen.last[2]);
                seen.last = [b.x, b.y, b.z];
                seen.bounces = Math.max(seen.bounces, b.bounces);
                seen.maxY = Math.max(seen.maxY, b.y);
                seen.samples++;
              }
            }
            for (const p of s.players) {
              this.seen.set(p.id, { ...p });
              if (!this.firstAt.has(p.id)) this.firstAt.set(p.id, [p.x, p.z]);
              const prev = this.lastAt.get(p.id);
              if (prev) {
                this.path.set(p.id, (this.path.get(p.id) ?? 0) + Math.hypot(p.x - prev[0], p.z - prev[1]));
              }
              this.lastAt.set(p.id, [p.x, p.z]);
            }
            return;
          }
          case MSG.ROSTER: {
            const entries = decodeRoster(frame);
            if (!entries) return;
            this.roster = entries;
            this.rosters++;
            return;
          }
          case MSG.EVENTS: {
            const events = decodeEvents(frame);
            if (!events) return;
            for (const ev of events) {
              if (ev.kind === EVENT.HIT) {
                this.hits.push({
                  attacker: ev.attacker,
                  victim: ev.victim,
                  ko: (ev.flags & EVENT_FLAG.KO) !== 0,
                  footy: (ev.flags & EVENT_FLAG.FOOTY) !== 0,
                });
              } else if (ev.kind === EVENT.JOIN) {
                this.joins.push(ev.id);
              }
            }
            return;
          }
          default:
            return;
        }
      };
    });
  }

  private pingSeq = 0;

  /**
   * One PING, carrying a round trip this probe is claiming.
   *
   * Fabricated rather than measured, and that is the whole point of it here: the
   * number on the scoreboard is whatever the client reported (see
   * `protocol.encodePing`), so a probe that says 37 ms must appear as 37 ms and
   * a probe that says 84 must appear as 84. Two different values, because one
   * would pass against a server that wrote the same constant into every row.
   */
  ping(rttMs: number): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.pingSeq++;
    this.socket.send(encodePing(this.pingSeq, performance.now(), rttMs));
  }

  /** This probe's own row on the last roster it was sent. */
  get row(): RosterEntry | undefined {
    return this.roster.find((r) => r.id === this.id);
  }

  /** One 60 Hz input packet. */
  tick(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(
      encodeInput({
        seq: this.seq,
        buttons: this.buttons,
        forward: this.forward,
        right: 0,
        yaw: this.yaw,
        pitch: this.pitch,
      }),
    );
    // Buttons are edge-triggered by the caller: a held punch would empty the
    // stamina bar and the fourth attempt would be refused, which is the
    // behaviour spec 8.2 wants and not what this check is measuring.
    this.buttons = 0;
  }

  at(id: number): [number, number] | null {
    return this.lastAt.get(id) ?? null;
  }

  close(): void {
    this.socket.close();
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Names and the roster record, off the socket.
 *
 * Off it deliberately, on `checkWading`'s own argument: what the socket run
 * above proves is that the server sanitises and dedupes *the two names it was
 * sent*, and what cannot be sent over a socket in a reasonable time is the set
 * of names a real lobby will eventually contain. So this is the adversarial
 * half -- a name that is entirely invisible characters, one that is a bidi
 * override, one at the byte cap in emoji -- run through the same
 * `sanitiseName`, `uniqueName` and `encodeRoster` the server runs, in the
 * process the server runs them in.
 *
 * The failure it exists for is the one with no picture: a roster entry whose
 * name length disagrees with the bytes after it decodes every **subsequent**
 * entry as garbage at plausible values. That is a leaderboard of players nobody
 * has ever met, sitting under a row that is correct, and nothing throws.
 */
function checkNames(): void {
  say('names and the roster record, through the real encoder:');

  // A lobby's worth of awkward requests, resolved the way the server resolves
  // them: sanitise, then dedupe against everyone already in.
  const asked = [
    'Bazza',
    '  bazza  ',        // the same person twice, in a different case
    'BAZZA',            // and a third time
    '​​​', // a name made entirely of zero-width spaces
    '‮Shazza',     // a right-to-left override, which would reverse the feed
    'Dave\nSmith',      // a newline, which would put a second line in the panel
    '🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘🦘', // 20 emoji: over both caps
    'Macca',
  ];
  const settled: string[] = [];
  for (let i = 0; i < asked.length; i++) {
    const base = sanitiseName(asked[i]) || `Roo ${i}`;
    settled.push(uniqueName(base, settled));
  }
  say(`  ${asked.length} awkward requests -> ${settled.map((n) => JSON.stringify(n)).join(', ')}`);
  check(
    new Set(settled.map((n) => n.toLowerCase())).size === settled.length,
    `every name in a lobby of ${asked.length} collisions came out distinct`,
  );
  check(
    settled.every((n) => [...n].length >= 2 && [...n].length <= MAX_NAME_CHARS),
    `every name is between 2 and ${MAX_NAME_CHARS} characters`,
  );
  check(
    settled.every((n) => ![...n].some((c) => {
      const code = c.codePointAt(0) ?? 0;
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e);
    })),
    'no control, zero-width or bidi character survived into a name',
  );
  check(settled[0] === 'Bazza' && settled[1] === 'bazza (2)' && settled[2] === 'BAZZA (3)', 'three Bazzas became Bazza, bazza (2), BAZZA (3)');

  // The record itself: every settled name into a roster and back out, which is
  // the check that a multi-byte name does not shift the entry behind it.
  const entries: RosterEntry[] = settled.map((name, i) => ({
    id: i + 1,
    colourway: i % 7,
    bot: i % 3 === 0,
    name,
    kos: i * 3,
    downs: (settled.length - i) * 2,
    ping: i === 0 ? 0 : i * 11,
  }));
  const back = decodeRoster(encodeRoster(entries));
  check(back !== null && back.length === entries.length, `a ${entries.length}-entry roster round-tripped through the wire (${back?.length} back)`);
  check(
    back !== null && back.every((r, i) => r.id === entries[i].id && r.name === entries[i].name && r.kos === entries[i].kos && r.downs === entries[i].downs && r.ping === entries[i].ping && r.bot === entries[i].bot),
    'every field of every entry survived, including the ones behind a multi-byte name',
  );

  // And the order the panel draws them in.
  const ranked = rankRoster(entries);
  check(
    ranked.every((r, i) => i === 0 || ranked[i - 1].kos > r.kos || (ranked[i - 1].kos === r.kos && ranked[i - 1].downs <= r.downs)),
    `rankRoster ordered ${ranked.length} rows by KOs descending, then downs ascending`,
  );
  check(ranked[0].kos === Math.max(...entries.map((e) => e.kos)), `the top row is the highest KO count (${ranked[0].name}, ${ranked[0].kos})`);
}

/**
 * Wading, on both sides of the wire, against the real world files.
 *
 * Off the socket deliberately, and it is the one check here that is: **nothing
 * about wading goes over the wire**, and that is precisely the property being
 * tested. A wading player moves at 45% of their speed, so the client predicts a
 * position the server has to reproduce exactly or reconciliation fights it every
 * tick -- which reads as rubber-banding at every shoreline in the city. The two
 * stay in step because both build the same water table from the same
 * `index.json` and run the same `advance`, so what has to be checked is that the
 * two tables agree and that the rule they feed actually bites.
 *
 * Three assertions, and the third is the one that fails if the wiring is right
 * and the *rule* is not:
 *
 *   1. The table the server builds in `loadWorld` and the table `main.ts` builds
 *      from `index.json` answer identically over every wet tile.
 *   2. The same input sequence through the two produces a bit-identical
 *      trajectory. A prediction that diverges at all diverges forever.
 *   3. A combatant walked off a harbour-front into the water ends up slower and
 *      no deeper than the ceiling -- against the identical walk in a world with
 *      the water taken out, which is the only comparison that distinguishes
 *      "the rule ran" from "there was a wall there anyway".
 */
async function checkWading(): Promise<void> {
  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const wet = world.index.tiles.filter((t) => typeof t.wy === 'number');
  if (wet.length === 0) {
    say('  note: this world has no water in it -- skipping the wading checks.');
    return;
  }

  // 1. The client's table, built the way `main.ts` builds it, against the
  //    server's, built inside `loadWorld`. Same file, two constructions.
  const clientLevels = WaterLevels.fromIndex(
    JSON.parse(await Bun.file(`${root}/index.json`).text()).tiles,
    world.index.tile_size,
  );
  let disagreements = 0;
  for (const t of world.index.tiles) {
    const cx = (t.bounds[0] + t.bounds[2]) / 2;
    // The index's bounds are north-positive and world z runs south.
    const cz = -(t.bounds[1] + t.bounds[3]) / 2;
    const mine = clientLevels.surfaceAt(cx, cz);
    const theirs = world.water.surfaceAt(cx, cz);
    if (!Object.is(mine, theirs)) disagreements++;
  }
  check(
    disagreements === 0,
    `the client's water table and the server's agree over all ${world.index.tiles.length} tiles ` +
      `(${wet.length} of them wet, ${world.water.wetTiles} in the server's)`,
  );

  // 2 & 3. A walk into the water, found rather than hard-coded: a point on dry
  //    land inside a wet tile with water deeper than the ceiling 30 m away.
  const server = groundFor(world);
  let start: { x: number; z: number; yaw: number } | null = null;
  for (const t of wet) {
    const surface = t.wy!;
    for (let gx = 0; gx < 24 && !start; gx++) {
      for (let gz = 0; gz < 24 && !start; gz++) {
        const x = t.bounds[0] + ((gx + 0.5) / 24) * (t.bounds[2] - t.bounds[0]);
        const z = -(t.bounds[1] + ((gz + 0.5) / 24) * (t.bounds[3] - t.bounds[1]));
        if (waterDepth(surface, server.groundHeight(x, z, Infinity)) > 0.02) continue;
        // Dry. Now find a cardinal that walks *into* the water rather than along
        // it: deep at 15 m and deeper still at 30, so the whole run is a
        // shoreline crossing and not a stroll down a promenade.
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const at = (m: number) =>
            waterDepth(
              world.water.surfaceAt(x + dx * m, z + dz * m),
              server.groundHeight(x + dx * m, z + dz * m, -Infinity),
            );
          if (at(15) > WADE_MAX_DEPTH && at(30) > at(15)) {
            // `forward = (-sin yaw, -cos yaw)`, so facing (dx, dz) is atan2(-dx, -dz).
            start = { x, z, yaw: Math.atan2(-dx, -dz) };
            break;
          }
        }
      }
    }
    if (start) break;
  }
  if (!start) {
    say('  note: no shoreline found in the emitted tiles -- skipping the wading walk.');
    return;
  }

  const SECONDS_OF_WALK = 10;
  const run = (against: CombatWorld) => {
    const c = createCombatant(1, start!.x, start!.z);
    c.body.position.y = against.groundHeight(start!.x, start!.z, Infinity) + EYE_HEIGHT;
    const input: CombatInput = {
      forward: 1, right: 0, jump: false, sprint: false,
      yaw: start!.yaw, pitch: 0, punch: false, throwBall: false,
    };
    let wadedSpeed = 0;
    for (let i = 0; i < SECONDS_OF_WALK * 60; i++) {
      advance(c, input, 1 / 60, against);
      // The fastest this player ever went while genuinely in the water, which is
      // what the speed scale is supposed to cap. Sampled after the step, so it
      // is the velocity the position was integrated with.
      const wet = waterDepth(
        world.water.surfaceAt(c.body.position.x, c.body.position.z),
        c.body.position.y - EYE_HEIGHT,
      );
      if (wet > 0.3) {
        wadedSpeed = Math.max(wadedSpeed, Math.hypot(c.body.velocity.x, c.body.velocity.z));
      }
    }
    const depth = waterDepth(
      world.water.surfaceAt(c.body.position.x, c.body.position.z),
      c.body.position.y - EYE_HEIGHT,
    );
    return { c, depth, wadedSpeed };
  };

  const authoritative = run(server);
  // The client's own world: the same ground, and a water table built separately
  // from the file rather than shared with the server's.
  const predicted = run({
    collision: world.collision,
    groundHeight: server.groundHeight,
    waterSurface: (x, z) => clientLevels.surfaceAt(x, z),
  });
  // And the same walk with the water taken out, which is the only comparison
  // that distinguishes "the rule stopped them" from "there was a wall there".
  const unruled = run({ collision: world.collision, groundHeight: server.groundHeight });

  const drift = Math.hypot(
    authoritative.c.body.position.x - predicted.c.body.position.x,
    authoritative.c.body.position.z - predicted.c.body.position.z,
  );
  check(
    drift === 0,
    `a ${SECONDS_OF_WALK}-second walk into the harbour predicts bit-identically on both sides ` +
      `(drift ${drift} m)`,
  );
  check(
    unruled.depth > WADE_MAX_DEPTH,
    `with the rule off the same walk ends in ${unruled.depth.toFixed(2)} m of water, so the ` +
      `shoreline really was crossed`,
  );
  check(
    authoritative.depth <= WADE_MAX_DEPTH + 0.01,
    `with it on the walk stops at ${authoritative.depth.toFixed(2)} m, inside the ` +
      `${WADE_MAX_DEPTH} m ceiling`,
  );
  check(
    authoritative.wadedSpeed > 0 && authoritative.wadedSpeed < 2.1,
    `wading topped out at ${authoritative.wadedSpeed.toFixed(2)} m/s against a 4.40 m/s walk ` +
      `(the rule's 45%)`,
  );
}

/**
 * The football, off the socket: determinism, the supply bar, and a scripted
 * knockout.
 *
 * Off the wire deliberately, on `checkWading`'s own argument and for a stronger
 * version of it. **Nothing about a ball's flight goes over the wire** -- the
 * snapshot carries where it *is*, and both ends compute where it goes next from
 * the same shared `game/footy.ts`. So what has to be checked is not that the
 * bytes survive the trip (`verifyNet` covers that) but that the two ends compute
 * the same flight, and that the resource governing it behaves.
 *
 * The first check is the one this whole design rests on and it is the reason
 * this function exists rather than living in `verifyFooty`: it loads **a second
 * instance of the module** under a different specifier, so the two traces are
 * produced by two separately-evaluated copies with their own closures, their own
 * constants and their own module state. That is as close as one process can get
 * to "the browser and the server agree", and it is the exact failure mode a
 * `Math.random` in the bounce, a module-level counter, or a cached scratch
 * object shared between calls would produce -- none of which `verifyFooty`'s
 * same-instance comparison can see.
 */
async function checkFooty(): Promise<void> {
  const here = new URL('../client/src/game/footy.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/game/footy.ts');
  // A different specifier for the same file, which is what makes this a second
  // *instance* rather than the same object twice. Bun resolves the query string
  // as part of the key and evaluates the module again.
  const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/game/footy.ts');

  check(
    one.stepFooty !== two.stepFooty,
    'the two footy module instances really are separate (their exports are different objects)',
  );

  const world: CombatWorld = { collision: null, groundHeight: () => 0 };
  let worstStep = -1;
  let compared = 0;
  let bouncesSeen = 0;
  for (const id of [1, 7, 42, 200, 255]) {
    for (const pitch of [0, 0.3, -0.2]) {
      const a = one.traceFooty(id, world, [], pitch);
      const b = two.traceFooty(id, world, [], pitch);
      compared += a.path.length;
      bouncesSeen += a.bounces;
      if (a.path.length !== b.path.length || a.bounces !== b.bounces) {
        worstStep = 0;
        break;
      }
      for (let i = 0; i < a.path.length; i++) {
        // `!==` on the doubles themselves. Not a tolerance: the claim is that
        // the two instances produce the *same bits*, and a check that allowed a
        // millimetre would pass a simulation that had started to drift.
        if (a.path[i] !== b.path[i]) {
          worstStep = Math.floor(i / 3);
          break;
        }
      }
      if (worstStep >= 0) break;
    }
    if (worstStep >= 0) break;
  }
  check(
    worstStep < 0,
    `15 flights are bit-identical across two module instances (${compared / 3} steps compared, ` +
      `${bouncesSeen} bounces)` + (worstStep >= 0 ? ` -- first divergence at step ${worstStep}` : ''),
  );

  // And the bounce hash agrees across the two instances, which is the specific
  // mechanism the flights above depend on. Checked separately so a failure says
  // *which* half broke.
  {
    let differing = 0;
    for (let id = 1; id <= 255; id++) {
      for (let bounce = 0; bounce < 3; bounce++) {
        for (let channel = 0; channel < 2; channel++) {
          if (one.bounceHash(id, bounce, channel) !== two.bounceHash(id, bounce, channel)) differing++;
        }
      }
    }
    check(differing === 0, `the bounce hash agrees over all 1,530 (id, bounce, channel) triples`);
  }

  // --- The supply bar: one ball back every 4 s, and never more than three.
  //
  // Run through the real `advance` rather than by reading the constants, because
  // what is being checked is the *rule* -- a whole-bar refill would satisfy
  // every constant in the file and be a different mechanic. See
  // `game/combat.ts`'s ball constants for why this one trickles where the
  // stamina beside it does not.
  {
    const c = createCombatant(1, 0, 0);
    const rest: CombatInput = {
      forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, punch: false, throwBall: false,
    };
    const throwing: CombatInput = { ...rest, throwBall: true };
    let burst = 0;
    // Empty the bar as fast as it allows.
    for (let i = 0; i < 60 * 3; i++) if (advance(c, throwing, 1 / 60, world).ballThrown) burst++;
    check(burst === BALL_CHARGES, `a full bar throws exactly ${BALL_CHARGES} balls in a burst (threw ${burst})`);
    check(c.ballCharges === 0, `the bar is empty afterwards (${c.ballCharges} left)`);

    // Then one ball per recharge, counted at each boundary.
    const at: number[] = [];
    for (let i = 0; i < Math.round(BALL_RECHARGE * 3.5 * 60); i++) {
      const before = c.ballCharges;
      advance(c, rest, 1 / 60, world);
      if (c.ballCharges > before) at.push(Number(((i + 1) / 60).toFixed(2)));
    }
    check(
      at.length === BALL_CHARGES,
      `${BALL_RECHARGE * 3.5} s of not throwing returned ${at.length} balls, one at a time, at ` +
        `${at.join(' s, ')} s`,
    );
    check(
      at.length >= 2 && Math.abs(at[1] - at[0] - BALL_RECHARGE) < 0.1,
      `the balls came back ${at.length >= 2 ? (at[1] - at[0]).toFixed(2) : '?'} s apart, not all at once ` +
        `(the recharge is ${BALL_RECHARGE} s a ball)`,
    );
    check(c.ballCharges === BALL_CHARGES, `the bar stops at ${BALL_CHARGES} (${c.ballCharges})`);
  }

  // --- A scripted throw knocks a dummy out.
  //
  // The end-to-end claim for this weapon in one case: three balls thrown by the
  // real `advance`, flown by the real `FootyField` against the real capsule, and
  // the real `applyFootyHit` taking the real three pips. 12 m because that is
  // squarely inside the direct-fire envelope `game/footy.ts` measures -- the
  // point here is the pipeline, not the aim.
  {
    const thrower = createCombatant(1, 0, 0);
    const victim = createCombatant(2, 0, -12);
    const field = new FootyField();
    const report = createHitReport();
    const events: FootyEvent[] = [];
    const throwing: CombatInput = {
      forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, punch: false, throwBall: true,
    };
    let hits = 0;
    let ko = false;
    let seconds = 0;
    for (let i = 0; i < 60 * 20 && !ko; i++) {
      if (advance(thrower, throwing, 1 / 60, world).ballThrown) field.add(thrower);
      // The victim is pinned, so what is being measured is the ball rather than
      // how far the last one threw them. Their flinch is cleared for the same
      // reason -- three balls have to land, and a flinching target is a test of
      // the lockout instead.
      victim.body.position.set(0, EYE_HEIGHT, -12);
      victim.body.velocity.set(0, 0, 0);
      victim.hitstopT = 0;
      if (victim.phase === 'flinch') victim.phase = 'idle';
      for (const e of field.step(1 / 60, world, [victim], events)) {
        if (e.kind !== 'hit' || !e.victim) continue;
        applyFootyHit(thrower, e.victim, e.ball, report);
        hits++;
        if (report.ko) ko = true;
      }
      seconds += 1 / 60;
    }
    check(
      hits === 3 && ko,
      `three thrown footballs knocked a standing dummy out at 12 m (${hits} hits, ko ${ko}, ` +
        `${seconds.toFixed(2)} s)`,
    );
    check(victim.health === 0, `the dummy is on ${victim.health} pips`);
    check(victim.phase === 'ko', `and in phase "${victim.phase}"`);
  }
}

async function main(): Promise<void> {
  say(`SYDNEY integration check — two synthetic clients against a real server on ${PORT}`);
  say('');

  // Its own server on its own port, so this can run beside the one the browsers
  // are using. `stdio: 'pipe'` because the server's boot lines belong in this
  // transcript rather than interleaved with it.
  const proc = Bun.spawn(['bun', 'run', new URL('./index.ts', import.meta.url).pathname], {
    env: { ...process.env, SYDNEY_PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for it to answer rather than sleeping a fixed amount: loading 221 tiles
  // takes 35 ms on this machine and would take longer on a cold cache.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      up = r.ok;
    } catch {
      // not yet
    }
  }
  if (!up) {
    proc.kill();
    say('FAIL  the server never answered /health');
    process.exit(1);
  }
  const health = (await (await fetch(`http://127.0.0.1:${PORT}/health`)).json()) as Record<string, unknown>;
  say(`server up: stage "${health.stage}", ${health.bots} bots, protocol ${health.protocol}`);
  say('');

  // The two names are chosen to exercise the whole naming path in one join.
  //
  // A asks for a name with a tab in the middle and padding at both ends, which
  // only survives if the **server** sanitises -- the browser's copy of that
  // function is not in this process and this probe deliberately does not call
  // it. B then asks for exactly what A ended up with, in a different case,
  // which only survives distinguishably if the server dedupes.
  const a = new Probe('A', '  Kev\tSmith  ');
  const b = new Probe('B', 'kev smith');
  await a.connect();
  await b.connect();
  // Both rosters, before anything else happens, so the names below are the ones
  // the server assigned at join rather than anything the fight produced.
  await sleep(120);
  say(
    `A joined as id ${a.id} "${a.row?.name}" (kit ${a.colourway});  ` +
      `B joined as id ${b.id} "${b.row?.name}" (kit ${b.colourway})`,
  );
  say('');

  check(a.id !== b.id, `the two clients were given different ids (${a.id}, ${b.id})`);
  check(a.colourway !== b.colourway, `the two clients were given different colourways (${a.colourway}, ${b.colourway})`);

  // --- 1b: names, over the real socket and through the real encoder.
  check(a.rosters > 0 && b.rosters > 0, `both clients were sent a roster on joining (${a.rosters}, ${b.rosters})`);
  check(
    a.row?.name === 'Kev Smith',
    `A's name was sanitised server-side: sent "  Kev\\tSmith  ", got ${JSON.stringify(a.row?.name)}`,
  );
  // The suffix is added and the **case the player typed is kept**, which is the
  // right way round: the collision is detected case-insensitively because two
  // rows called Bazza and bazza are the same unreadable board, and the player
  // still gets the name they asked for rather than a corrected one.
  check(
    b.row?.name === 'kev smith (2)',
    `B's colliding name was deduped and kept its case: sent "kev smith", got ${JSON.stringify(b.row?.name)}`,
  );
  // The roster is the *world's*, not the viewer's: A has to be able to name B,
  // or the kill feed can only ever say "you".
  check(
    a.roster.find((r) => r.id === b.id)?.name === 'kev smith (2)',
    `A can name B from its own roster (${JSON.stringify(a.roster.find((r) => r.id === b.id)?.name)})`,
  );
  // And the bots are people. "bot 1" in a kill feed is the thing this pass
  // exists to remove, so the check is that no row anywhere reads like an id.
  const botRows = a.roster.filter((r) => r.bot);
  check(botRows.length >= 2, `the roster carries the server's bots as ordinary rows (${botRows.length})`);
  check(
    botRows.every((r) => r.name.length >= 2 && !/^(bot|player)\s*\d+$/i.test(r.name)),
    `every bot has a name rather than a number (${botRows.map((r) => r.name).join(', ')})`,
  );
  check(
    new Set(a.roster.map((r) => r.name.toLowerCase())).size === a.roster.length,
    `every name in the world is distinct (${a.roster.length} rows)`,
  );

  // --- Three phases, and the middle one exists because a thrown ball needs
  // room.
  //
  //   1 (0-1 s)     walk apart, so movement is unambiguous in both directions.
  //   2 (1-3.7 s)   stand still at range while B throws footballs at A.
  //   3 (3.7-8 s)   converge, re-aiming **every tick**, and swing the bat.
  //
  // The throwing phase is separate rather than folded into the approach, and
  // that was learnt the hard way: throwing while closing meant every ball left
  // B's hand half a metre from A's chest and died on the tick it spawned. The
  // snapshot stream then carried each one in exactly *one* frame, so the check
  // that a ball is a thing which **travels** -- which is the entire claim of a
  // projectile crossing as state rather than as an event -- passed on a ball
  // that had never moved. A weapon has to be tested at its own range.
  //
  // Aiming once and walking blind was the first version of phase 3 and it does
  // not arrive: this is a real city, the two probes are 20 m apart with terraces
  // between them by then, and a fixed heading walks one of them into a wall.
  // Re-aiming per tick is also what a player does.
  a.yaw = 0;
  b.yaw = Math.PI;
  a.forward = 1;
  b.forward = 1;
  const began = performance.now();
  const ticks = SECONDS * 60;
  /**
   * The closing phase runs until they meet, not until the clock says so.
   *
   * Joins are dithered over a 100 m disc now -- see `checkSpawn` and
   * `game/spawn.ts` -- so two clients start anywhere from a metre to 200 m
   * apart, and a fixed 4 s approach ended 36 m short on the first run that had
   * the dither in it. The cap is what keeps a server that has stopped applying
   * input from hanging this check rather than failing it: 200 m at a combined
   * sprint of 16.4 m/s is 12 s, and this allows 15.
   */
  const MAX_TICKS = ticks + 15 * 60;
  const APART_TICKS = 60;
  const THROW_UNTIL = 220;
  let closest = Infinity;
  let punchesSent = 0;
  let throwsSent = 0;
  let throwGap = 0;
  /**
   * The tick they first came within reach, and how long the fight gets after it.
   *
   * Arriving is not swinging: A attempts a punch every 40 ticks, so a run that
   * stopped the instant they touched would end between two attempts and report
   * that the bat does not work. Two seconds is three attempts.
   */
  let closedAt = -1;
  const FIGHT_TICKS = 120;
  let ran = 0;

  for (let i = 0; i < ticks || (i < MAX_TICKS && (closedAt < 0 || i < closedAt + FIGHT_TICKS)); i++) {
    ran = i + 1;
    const pa = a.at(a.id);
    const pb = a.at(b.id);
    const gap = pa && pb ? Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) : Infinity;
    if (i > THROW_UNTIL && closedAt < 0 && gap <= REACH * 0.75) closedAt = i;
    if (i > THROW_UNTIL) closest = Math.min(closest, gap);

    if (i === APART_TICKS) say(`  t=${(i / 60).toFixed(2)}s  ${gap.toFixed(1)} m apart; B starts throwing`);
    if (i === THROW_UNTIL) say(`  t=${(i / 60).toFixed(2)}s  turning them toward each other (${gap.toFixed(1)} m apart)`);

    if (i >= APART_TICKS && pa && pb) {
      // `forward = (-sin yaw, -cos yaw)`, so facing (dx, dz) is atan2(-dx, -dz).
      a.yaw = Math.atan2(-(pb[0] - pa[0]), -(pb[1] - pa[1]));
      b.yaw = Math.atan2(-(pa[0] - pb[0]), -(pa[1] - pb[1]));
    }

    if (i >= APART_TICKS && i < THROW_UNTIL) {
      // Phase 2: both stand still and B throws across the gap. A slight upward
      // pitch, because `game/footy.ts` measures the direct-fire envelope at
      // 3-14 m and this is thrown from further -- which is the arc the weapon is
      // for, and is the thing being demonstrated.
      a.forward = 0;
      b.forward = 0;
      b.pitch = 0.12;
      // The 0.55 s floor between throws is 33 ticks; 55 clears it and gets three
      // throws into the window without emptying a bar that refills every 4 s.
      if ((i - APART_TICKS) % 55 === 0) {
        b.buttons |= BTN.THROW;
        throwsSent++;
        throwGap = gap;
      }
    } else if (i >= THROW_UNTIL && pa && pb) {
      b.pitch = 0;
      // A closes; B stands its ground once A is nearly there, so they do not
      // walk through each other and end up back to back.
      a.forward = gap > 0.95 ? 1 : 0;
      b.forward = gap > 3 ? 1 : 0;
      // Sprinting while there is ground to cover, because the spawn dither can
      // put them a hundred metres apart and a walk across that is most of this
      // check's runtime. Dropped well before the swing: sprint costs no stamina
      // (see `advance`), but arriving at a fight at 8 m/s is not the case the
      // punch below is meant to test.
      if (gap > 6) {
        a.buttons |= BTN.SPRINT;
        b.buttons |= BTN.SPRINT;
      }

      // Spec 8.2's cycle is 500 ms and the bar is four swings, so one attempt
      // every 40 ticks (667 ms) is inside both and never hits the stamina lock.
      //
      // The trigger range is derived from `REACH` rather than written down,
      // because the melee weapon is now a cricket bat and that number moved with
      // it (1.2 m to 1.55 m). A literal here would have kept passing at the old
      // distance and stopped being a test of anything.
      if (gap < REACH * 0.75 && i % 40 === 0) {
        a.buttons |= BTN.PUNCH;
        punchesSent++;
      }
    }

    a.tick();
    b.tick();
    // Twice a second, which is `net/client.ts`'s own ping cadence. Two different
    // claimed round trips, so the assertion below cannot pass against a server
    // that writes one constant into every row.
    if (i % 30 === 0) {
      a.ping(37);
      b.ping(84);
    }
    // 16 ms rather than 16.67, so the harness sends a touch faster than the
    // server ticks and there is always an input waiting. A harness that sent
    // slower would leave the server repeating the last input, which is correct
    // behaviour and would make the movement assertions weaker.
    await sleep(16);
  }
  const elapsed = (performance.now() - began) / 1000;
  a.forward = 0;
  b.forward = 0;
  await sleep(300);

  say('');
  say(`ran ${ran} input ticks over ${elapsed.toFixed(2)} s`);
  say(`A received ${a.snapshots} snapshots (${(a.bytes / 1024).toFixed(1)} kB), B ${b.snapshots} (${(b.bytes / 1024).toFixed(1)} kB)`);
  say('');

  // --- 2: both see both.
  for (const [self, other] of [[a, b], [b, a]] as Array<[Probe, Probe]>) {
    check(self.seen.has(self.id), `${self.name} sees itself (id ${self.id}) in its snapshots`);
    check(self.seen.has(other.id), `${self.name} sees ${other.name} (id ${other.id}) in its snapshots`);
    check(self.seen.size >= 4, `${self.name} sees ${self.seen.size} combatants (2 players + 2 bots)`);
    check(
      self.snapshots > SECONDS * SNAPSHOT_HZ * 0.7,
      `${self.name} received ${self.snapshots} snapshots in ${elapsed.toFixed(1)} s (expected about ${Math.round(SECONDS * SNAPSHOT_HZ)})`,
    );
  }

  // --- 3: positions advance. Path length, not net displacement -- see `path`.
  for (const [self, other] of [[a, b], [b, a]] as Array<[Probe, Probe]>) {
    for (const id of [self.id, other.id]) {
      const walked = self.path.get(id) ?? 0;
      const last = self.lastAt.get(id);
      check(
        walked > 5,
        `${self.name} saw id ${id} walk ${walked.toFixed(2)} m, ending at ` +
          `${last ? `(${last[0].toFixed(1)}, ${last[1].toFixed(1)})` : '?'}`,
      );
    }
  }

  // --- 4: a bat swing landed between them, and both heard about it.
  say('');
  say(
    `closest approach ${closest.toFixed(2)} m; ${punchesSent} bat swings, and ${throwsSent} throws ` +
      `sent from about ${throwGap.toFixed(1)} m`,
  );
  check(closest < REACH, `the two probes closed to inside the ${REACH} m melee reach (${closest.toFixed(2)} m)`);
  const punches = (p: Probe) => p.hits.filter((h) => !h.footy && h.attacker === a.id && h.victim === b.id);
  check(punches(a).length > 0, `A's own bat swing on B landed (${punches(a).length} HIT events at A)`);
  check(punches(b).length > 0, `B was told about it (${punches(b).length} HIT events at B)`);

  // --- 5: the footballs B threw crossed the wire as objects, not as events.
  //
  // This is the assertion that would have been an event round-trip under the
  // beam and deliberately is not one now: a thrown ball is *state*, so what
  // proves it worked is that both clients watched the same ball travel through
  // a sequence of snapshots. A ball that appeared in exactly one snapshot would
  // mean the server was spawning and dropping it inside a tick; one that never
  // moved would mean the projectile section was being encoded but never
  // stepped -- and neither throws.
  const thrown = (p: Probe) => [...p.balls.values()].filter((x) => x.thrower === b.id);
  const ballsAtA = thrown(a);
  check(ballsAtA.length > 0, `B's throws reached A in the snapshot stream (${ballsAtA.length} distinct balls)`);
  if (ballsAtA.length > 0) {
    const flights = ballsAtA.map((x) => x.path);
    check(
      flights.every((d) => d > 1),
      `every ball A saw actually flew (${flights.map((d) => d.toFixed(1)).join(', ')} m of path)`,
    );
    check(
      ballsAtA.every((x) => x.samples >= 2),
      `every ball was seen in at least two snapshots (${ballsAtA.map((x) => x.samples).join(', ')})`,
    );
    // Both clients have to see the same balls: the section is broadcast, not
    // per-viewer, so a ball A can see and B cannot is a culling bug.
    const idsAtA = new Set(ballsAtA.map((_, i) => [...a.balls.keys()][i]));
    const idsAtB = new Set([...b.balls.keys()]);
    const shared = [...idsAtA].filter((id) => idsAtB.has(id)).length;
    check(shared > 0, `A and B saw the same balls (${shared} ids in common)`);
    // **Down from its apex**, not down from where it was thrown.
    //
    // Comparing the last sample to the first asks whether the ground at the far
    // end is lower, which is a question about Sydney rather than about gravity:
    // a ball thrown up a rising street obeys the integrator perfectly and still
    // lands above the hand that threw it, and a spawn dither that happens to put
    // the two probes on a slope then fails a physics check. Observed once in
    // nine runs as *"0 of 2"*.
    //
    // The apex is the honest instrument. Every ball that flies has one, it does
    // not care what the terrain does, and a ball that never came down from it is
    // a ball the integrator is not pulling on.
    const fell = ballsAtA.filter((x) => x.last[1] < x.maxY - 0.05);
    check(
      fell.length > 0,
      `at least one ball came back down from its apex, so gravity is on the wire ` +
        `(${fell.length} of ${ballsAtA.length}; falls of ` +
        `${ballsAtA.map((x) => (x.maxY - x.last[1]).toFixed(2)).join(', ')} m)`,
    );
    const bounced = ballsAtA.filter((x) => x.bounces > 0).length;
    const hitByFooty = a.hits.filter((h) => h.footy);
    say(`  note: ${bounced} of ${ballsAtA.length} balls were seen bouncing; ${hitByFooty.length} connected with a player`);
  }

  // --- 5b: the scoreboard, live, over the same socket the fight ran on.
  //
  // The counters are asserted deterministically in `verifySim`, where a
  // knockout can be forced; what this proves is the half that check cannot --
  // that the numbers actually **leave the process**. A server that counted
  // knockouts perfectly and never broadcast the roster is a leaderboard frozen
  // at 0/0 all game, and nothing about it throws.
  say('');
  // **Player knockouts only.** `attacker === victim` is the environment's
  // sentinel, which `Simulation.shoot` sets deliberately -- a police round, a
  // car and a magpie all raise their HIT with the victim as their own attacker,
  // and `creditKo(id, id)` then records a *down* against them and a *kill* for
  // nobody. That is the correct scoreboard: a leaderboard is a record of what
  // players did to each other.
  //
  // Counting those as KO events made the board disagree with itself -- observed
  // once as *"the board's 0 KOs and 1 downs match the 1 KO events A saw"*, which
  // is exactly the arithmetic of one probe being shot by the police mid-fight
  // rather than punched. The two probes brawl on a real Sydney street, and the
  // street is now well policed enough for that to happen.
  const environmentKos = a.hits.filter((h) => h.ko && h.attacker === h.victim).length;
  const koEvents = a.hits.filter((h) => h.ko && h.attacker !== h.victim);
  if (environmentKos > 0) {
    say(`  note: ${environmentKos} knockout(s) came from the city itself (police, traffic or wildlife), not from a player.`);
  }
  const board = rankRoster(a.roster);
  say(`scoreboard at A: ${board.map((r) => `${r.name} ${r.kos}/${r.downs} ${r.bot ? '—' : r.ping + 'ms'}`).join('   ')}`);
  check(
    a.rosters > 1,
    `the roster refreshed during the run rather than being sent once (${a.rosters} at A, ${b.rosters} at B)`,
  );
  check(
    a.row?.ping === 37 && b.row?.ping === 84,
    `each client's reported round trip reached its own row (A ${a.row?.ping} ms, B ${b.row?.ping} ms)`,
  );
  check(
    a.roster.every((r) => !r.bot || r.ping === 0),
    'a bot has no round trip on the board, because it has no socket',
  );
  // The KO columns against the KO events both clients watched. This is the
  // cross-check between the two paths -- events are how a client hears about a
  // knockout and the roster is how it is scored, and the two disagreeing means
  // one of them is being written from the wrong side of the punch.
  const scored = board.reduce((sum, r) => sum + r.kos, 0);
  const downs = board.reduce((sum, r) => sum + r.downs, 0);
  // **The two columns are not the same total, and the line above already said
  // why.** `creditKo(id, id)` -- a police round, a car, a magpie -- records a
  // down against the victim and a kill for nobody, so the board's downs are the
  // player knockouts *plus* the environmental ones while its kills are the
  // player knockouts alone. Asserting both against `koEvents.length` was an
  // assertion that the city never knocks anybody over in the eight seconds the
  // probes are brawling, which is not a property of the code and was observed
  // failing as "the board's 1 KOs and 2 downs match the 1 KO events A saw" on a
  // run where the note directly above it reported one environmental knockout.
  // The identity that is actually claimed is this one.
  check(
    scored === koEvents.length && downs === koEvents.length + environmentKos,
    `the board's ${scored} KOs and ${downs} downs match the ${koEvents.length} KO events A saw` +
      (environmentKos > 0 ? ` plus ${environmentKos} from the city` : ''),
  );
  if (koEvents.length > 0) {
    const victor = koEvents[0].attacker;
    check(
      (board.find((r) => r.id === victor)?.kos ?? 0) > 0,
      `the KO was credited to the attacker (id ${victor}), not to the victim`,
    );
    check(
      (board.find((r) => r.id === koEvents[0].victim)?.downs ?? 0) > 0,
      `the victim (id ${koEvents[0].victim}) was counted down`,
    );
  } else {
    say('  note: nobody was knocked out in this run; the counters are asserted deterministically in verifySim.');
  }
  check(
    board.every((r, i) => i === 0 || board[i - 1].kos > r.kos || (board[i - 1].kos === r.kos && board[i - 1].downs <= r.downs)),
    `the board is ordered by KOs descending, then downs ascending (${board.map((r) => `${r.kos}/${r.downs}`).join(' ')})`,
  );

  // --- 6: bandwidth, measured rather than quoted.
  const perPlayer = snapshotBytes(4);
  const rate = (perPlayer * SNAPSHOT_HZ * 8) / 1000;
  say('');
  say(
    `bandwidth: ${perPlayer} B/snapshot at 4 combatants -> ${rate.toFixed(1)} kbit/s downstream; ` +
      `measured ${((a.bytes * 8) / elapsed / 1000).toFixed(1)} kbit/s at A including events`,
  );
  say(`           at spec 2's 16-player cap: ${snapshotBytes(16)} B -> ${((snapshotBytes(16) * SNAPSHOT_HZ * 8) / 1000).toFixed(1)} kbit/s`);

  a.close();
  b.close();
  await sleep(200);
  proc.kill();

  // --- 7: the football, off the socket. See `checkFooty`.
  say('');
  await checkFooty();

  // --- 8: wading, off the socket and against the world files. See `checkWading`.
  say('');
  await checkWading();

  // --- 10: the lime e-bikes, off the socket and against the world files.
  // Appended last and self-contained; see `checkBikes` at the foot of this file.
  say('');
  await checkBikes();

  // --- 9: names and the roster record, off the socket. See `checkNames`.
  say('');
  checkNames();

  // --- 10: where a session starts -- the disc, the dither, and a join watched
  // over its own socket. See `checkSpawn`.
  say('');
  await checkSpawn();

  // --- 11: the living traffic, off the socket and against the real world
  // files. See `checkTraffic`, appended last and self-contained.
  say('');
  await checkTraffic();

  // --- 12: the people on the footpaths, out of the same sidecar the traffic
  // came from. See `checkPedestrians`, appended last and self-contained.
  say('');
  await checkPedestrians();

  // --- 13. The police, and the faction framework two more factions are being
  // built on. See `checkPolice`, appended last and self-contained.
  say('');
  await checkPolice();

  // --- 14. The street factions built on that framework -- meth heads and
  // drunks. See `checkStreetlife`, appended last and self-contained.
  say('');
  await checkStreetlife();

  // --- 15. The wildlife built on the same framework -- bush turkeys, ibises
  // and magpies. See `checkWildlife`, appended last and self-contained.
  say('');
  await checkWildlife();

  // --- 16. The footy supply bar the player is actually looking at, from an
  // empty bar to three full blocks. See `checkBallBar`, appended last and
  // self-contained.
  say('');
  await checkBallBar();

  // --- 17. PERFORMANCE.md phase 1: the spatial hash's candidate sets, the
  // pooled records and the one broadcast buffer, all asserted to have changed
  // nothing. See `checkSpatialHash`, appended last and self-contained.
  say('');
  await checkSpatialHash();

  // --- 18. PERFORMANCE.md phase 2: interest management. The working set against
  // the rule it claims to be, the band, the cap, the dedup's byte-identity, and
  // the one thing AOI must not break -- a kill feed that still names a knockout
  // on the other side of the city. See `checkAoi`.
  say('');
  await checkAoi();

  // --- 19. PERFORMANCE.md phase 3: rooms and the gateway. Isolation over real
  // sockets, the least-full join, a full room refused by name, and the one
  // mutable thing two rooms must not share. See `checkRooms`.
  say('');
  await checkRooms();

  // --- 20. The streaming lifecycle, which is a *client* defect asserted here
  // because the arithmetic is shared: the failure taxonomy that decides whether
  // a tile is ever asked for again, and the collision/geometry parity rule that
  // decides whether a return trip is a guaranteed block of solid invisible
  // city. Driven over the real extent, with the real payloads, twice -- once
  // under the rule that shipped and once under the new one. See
  // `checkStreamingLifecycle`.
  say('');
  await checkStreamingLifecycle();

  // --- 21. The walk-under rule: `CollisionWorld.resolve` reading a prism's
  // `base` as the soffit the pipeline wrote, driven by the real controller under
  // the real Western Distributor, Harbour Bridge, Broadway viaduct and Cahill,
  // against the same world in its old semantics. See `checkSoffits`.
  say('');
  await checkSoffits();

  // --- 22. Global chat, over real sockets against a **two-room** host. The one
  // channel in this server that crosses a room boundary, which makes it the one
  // channel `checkRooms`' isolation assertions would happily let rot: a fan-out
  // folded back into `Room` passes every check in this file except this one. See
  // `checkChat`, appended last and self-contained.
  say('');
  await checkChat();

  // --- 23. The suggestions box, over real sockets against a server of its own.
  // The one feature here whose state **outlives the process** -- a ledger on
  // disk and issues on GitHub -- so it is the one whose failures survive a
  // restart rather than being cleared by one. See `checkSuggestions` for the six
  // silent failures it exists to catch.
  say('');
  await checkSuggestions();

  // --- 24. `/unstuck`, against the real lane graph and over a real hub. The
  // destination rule and the command surface are two different failures and are
  // two different halves of it. See `checkUnstuck`, appended last and
  // self-contained.
  say('');
  await checkUnstuck();

  // --- 25. The input queue. One frame, one step -- the counting contract client
  // prediction rests on, and the one whose failure was the reported camera
  // jitter. See `checkInputQueue`, appended last and self-contained.
  say('');
  await checkInputQueue();

  say('');
  if (failures.length === 0) {
    say(`ALL CHECKS PASSED (${log.filter((l) => l.includes('PASS')).length})`);
  } else {
    say(`${failures.length} CHECK(S) FAILED:`);
    for (const f of failures) say(`  - ${f}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * Where a session starts, in three places that have to agree.
 *
 * The rule is `client/src/game/spawn.ts`: aim at the Sydney Park pin, fall back
 * to the closest point the built extent can hold a 120 m disc at, and draw one
 * dithered point out of that disc per join. Every way it breaks is quiet:
 *
 *   - A centre computed differently on the two ends is a client that streams the
 *     wrong tiles at boot and is then yanked across the city by the welcome. It
 *     looks like a network stutter.
 *   - A disc that overhangs the edge of the build spawns players over a hole,
 *     where there is no terrain grid, no collision and no water table -- and
 *     `groundHeight`'s last-known-height fallback means they do not even fall.
 *     They stand on the height of whoever asked last.
 *   - A rejection loop that never rejects puts people inside warehouses and
 *     under Sydney Park's ponds. Both render perfectly.
 *   - A dither that draws its radius uniformly still spawns everybody in the
 *     same twenty metres, which is the failure the dither exists to prevent and
 *     the one nobody can see from inside the game.
 *
 * So this checks the rule against the real world files, then proves the wire
 * carries it: a synthetic client, its own server on its own port, and the
 * welcome's own coordinates measured against the disc.
 */
async function checkSpawn(): Promise<void> {
  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);

  // --- The module's own self-check, and the constant it is not allowed to drift
  //     from. `spawn.ts` must not import three, so it carries its own copy of
  //     the player capsule; this is the guard that copy is real.
  const selfFailures = verifySpawn();
  check(selfFailures.length === 0, `game/spawn.ts's own self-check passes${selfFailures.length ? `: ${selfFailures.join('; ')}` : ''}`);
  check(
    SPAWN_PROBE_RADIUS === PLAYER_RADIUS,
    `the spawn probe's capsule matches the controller's (${SPAWN_PROBE_RADIUS} vs ${PLAYER_RADIUS})`,
  );

  // --- 1. One centre, computed twice: the server's, out of `loadWorld`, against
  //     the one a browser gets from the same `index.json` over HTTP. Same file,
  //     two constructions -- `checkWading`'s argument, for the same reason.
  const raw = JSON.parse(await Bun.file(`${root}/index.json`).text()) as {
    tile_size: number;
    tiles: Array<{ key: string; bounds: number[] }>;
  };
  const browser = spawnCentre(raw);
  check(
    browser.x === world.spawn.x && browser.z === world.spawn.z,
    `the client's spawn centre and the server's are the same point ` +
      `((${browser.x}, ${browser.z}) vs (${world.spawn.x}, ${world.spawn.z}))`,
  );

  const gap = Math.hypot(world.spawn.x - SPAWN_TARGET.x, world.spawn.z - SPAWN_TARGET.z);
  say(
    `  note: the disc is centred on world (${world.spawn.x}, ${world.spawn.z}) = ENU east ` +
      `${world.spawn.x.toFixed(1)}, north ${(-world.spawn.z).toFixed(1)} -- ${gap.toFixed(0)} m from the pin at ` +
      `${SPAWN_PIN.lat}, ${SPAWN_PIN.lon} (stage "${world.index.stage}", ${world.index.tiles.length} tiles).`,
  );
  if (gap > 1) {
    say(
      `  note: the pin itself is ${Math.hypot(SPAWN_TARGET.x, SPAWN_TARGET.z).toFixed(0)} m from the origin and this ` +
        `build reaches ${(Math.hypot(SPAWN_TARGET.x, SPAWN_TARGET.z) - gap).toFixed(0)} m in that bearing, so the ` +
        `spawn is as close to Sydney Park as the extent allows. Build past 5.2 km and it lands on the pin itself.`,
    );
  }

  // --- 2. The whole disc is on built ground. The tile test rather than a
  //     terrain sample, because a tile that does not exist is the case where
  //     every *other* query in this file quietly answers with stale data.
  {
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const size = world.index.tile_size;
    const missing: string[] = [];
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      const x = world.spawn.x + Math.cos(a) * SPAWN_FIT_RADIUS;
      const z = world.spawn.z + Math.sin(a) * SPAWN_FIT_RADIUS;
      const key = `${Math.floor(x / size)}_${Math.floor(-z / size)}`;
      if (!keys.has(key) && !missing.includes(key)) missing.push(key);
    }
    check(
      missing.length === 0,
      `every tile under the ${SPAWN_FIT_RADIUS} m fit disc is built${missing.length ? ` (missing ${missing.join(', ')})` : ''}`,
    );
  }

  // --- 3. Two hundred draws through the real sampler against the real world,
  //     each one asked the questions a player would ask standing on it.
  {
    const size = world.index.tile_size;
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const probe = groundFor(world);
    const base = probe.groundHeight(world.spawn.x, world.spawn.z, -Infinity);
    const N = 200;
    let outside = 0;
    let offMap = 0;
    let noGround = 0;
    let inPrism = 0;
    let inWater = 0;
    let cliffed = 0;
    let atCentre = 0;
    let sumR = 0;
    let maxR = 0;
    let deepest = 0;
    const tiles = new Set<string>();

    for (let i = 0; i < N; i++) {
      // The live sampler, with the live source of randomness -- this is the
      // function `Sim.joinSpot` calls, called the way it calls it.
      const p = pickSpawnPoint(world.spawn, probe);
      const r = Math.hypot(p.x - world.spawn.x, p.z - world.spawn.z);
      sumR += r;
      maxR = Math.max(maxR, r);
      if (r > SPAWN_DITHER_RADIUS + 1e-6) outside++;
      if (r < 1e-9) atCentre++;
      const key = `${Math.floor(p.x / size)}_${Math.floor(-p.z / size)}`;
      tiles.add(key);
      if (!keys.has(key)) offMap++;

      // Re-asked from scratch rather than trusted: the sampler's own answer is
      // what is on trial.
      const y = probe.groundHeight(p.x, p.z, -Infinity);
      if (!Number.isFinite(y)) noGround++;
      else if (Number.isFinite(base) && Math.abs(y - base) > SPAWN_MAX_RELIEF) cliffed++;
      if (world.collision.resolve(p.x, p.z, p.x, p.z, PLAYER_RADIUS, y + SPAWN_STEP_HEIGHT).hit) inPrism++;
      const depth = waterDepth(world.water.surfaceAt(p.x, p.z), y);
      deepest = Math.max(deepest, depth);
      if (depth > SPAWN_MAX_DEPTH) inWater++;
    }

    check(outside === 0, `all ${N} draws landed inside the ${SPAWN_DITHER_RADIUS} m disc (furthest ${maxR.toFixed(1)} m)`);
    check(offMap === 0, `all ${N} draws landed on a built tile (${tiles.size} distinct tiles used)`);
    check(noGround === 0, `all ${N} draws had terrain under them (${noGround} did not)`);
    check(inPrism === 0, `no draw landed inside a collision prism (${inPrism} did)`);
    check(
      inWater === 0,
      `no draw landed in water deeper than ${SPAWN_MAX_DEPTH} m (${inWater} did; deepest seen ${deepest.toFixed(2)} m)`,
    );
    check(cliffed === 0, `no draw was more than ${SPAWN_MAX_RELIEF} m off the centre's ground (${cliffed} were)`);
    check(atCentre === 0, `the sampler never had to fall back to the disc centre (${atCentre} of ${N} did)`);
    // A uniform draw over a disc has mean radius 2R/3 = 67 m. Anything under 40
    // is the `sqrt` having been dropped and everybody starting in a huddle.
    const mean = sumR / N;
    check(mean > 40, `the dither spreads: mean radius ${mean.toFixed(1)} m against 2R/3 = ${((2 * SPAWN_DITHER_RADIUS) / 3).toFixed(0)} m`);
  }

  // --- 4. And the wire. A real server, a real socket, a real HELLO, and the
  //     coordinates the welcome actually carries -- which is the only thing that
  //     proves `join` uses any of the above.
  const port = PORT + 1;
  const proc = Bun.spawn(['bun', 'run', new URL('./index.ts', import.meta.url).pathname], {
    env: { ...process.env, SYDNEY_PORT: String(port) },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) {
      await sleep(100);
      try {
        up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        // not yet
      }
    }
    if (!up) {
      check(false, 'a second server answered /health so a join could be watched');
      return;
    }

    // Four joins rather than one, because one point inside a 100 m disc is also
    // what a hard-coded coordinate produces. Four distinct ones are a dither.
    const seen: Array<{ id: number; x: number; z: number; snapX: number; snapZ: number }> = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await joinAndWatch(`ws://127.0.0.1:${port}`));
    }

    const far = seen.filter((s) => Math.hypot(s.x - world.spawn.x, s.z - world.spawn.z) > SPAWN_DITHER_RADIUS + 0.05);
    check(
      far.length === 0,
      `every welcome put its client inside the spawn disc ` +
        `(${seen.map((s) => Math.hypot(s.x - world.spawn.x, s.z - world.spawn.z).toFixed(0) + ' m').join(', ')})`,
    );
    // The snapshot is the second opinion: a welcome is written at join and a
    // snapshot is read off the live combatant a tick later, so the two agreeing
    // is what says the position was actually installed rather than just sent.
    const drifted = seen.filter((s) => Math.hypot(s.x - s.snapX, s.z - s.snapZ) > 2);
    check(
      drifted.length === 0,
      `every client's first snapshot agreed with its welcome to within 2 m (${drifted.length} did not)`,
    );
    const distinct = new Set(seen.map((s) => `${s.x.toFixed(1)}_${s.z.toFixed(1)}`)).size;
    check(distinct === seen.length, `${seen.length} joins produced ${distinct} distinct spawn points`);
    say(
      `  note: joins landed at ${seen
        .map((s) => `(${s.x.toFixed(0)}, ${s.z.toFixed(0)})`)
        .join(' ')} around (${world.spawn.x}, ${world.spawn.z}).`,
    );
  } finally {
    proc.kill();
    await sleep(100);
  }
}

/**
 * One join over a real socket: connect, say hello, keep the welcome, and wait
 * for the first snapshot that carries this client's own id.
 *
 * Deliberately not `Probe`: this needs the welcome's **position**, which nothing
 * else in this file looks at, and a check that owns its own socket cannot be
 * broken by a change to somebody else's.
 */
function joinAndWatch(url: string): Promise<{ id: number; x: number; z: number; snapX: number; snapZ: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    const scratch = createSnapshot();
    let id = -1;
    let x = 0;
    let z = 0;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('no welcome and snapshot within 5 s'));
    }, 5000);

    socket.onopen = () => socket.send(encodeHello(255, ''));
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    };
    socket.onmessage = (e) => {
      const frame = e.data as ArrayBuffer;
      if (frameType(frame) === MSG.WELCOME) {
        const w = decodeWelcome(frame);
        if (!w) return;
        id = w.id;
        x = w.x;
        z = w.z;
        return;
      }
      if (frameType(frame) !== MSG.SNAPSHOT || id < 0) return;
      const s = decodeSnapshot(frame, scratch);
      const mine = s?.players.find((p) => p.id === id);
      if (!mine) return;
      clearTimeout(timer);
      socket.close();
      resolve({ id, x, z, snapX: mine.x, snapZ: mine.z });
    };
  });
}

/**
 * The lime e-bikes, end to end, against the real world files.
 *
 * Off the socket like `checkFooty` and `checkWading`, and for the same reason:
 * everything worth asserting here is *authority*, and a real `Simulation` with
 * no network in it is where authority lives. What a socket would add is
 * scheduling noise.
 *
 * Every check below is a failure with no picture -- the game runs, nothing
 * throws, and it reads as a tuning decision somebody made:
 *
 *   - **Two riders on one bike.** Both clients predict a mount, both are
 *     granted, and two players move at 26 m/s with one mesh between them. On
 *     each screen it looks completely normal.
 *   - **A client-set multiplier.** The wire has no field for one, but the
 *     shared `CombatInput` does, so the thing to prove is that a hostile value
 *     in it is *overwritten* rather than merely absent from the protocol.
 *   - **An unlock that is not the zone.** 3x granted to somebody who never went
 *     to Redfern is a feature that silently has no gate on it.
 *   - **A dropped bike that goes home.** The position has to survive both the
 *     sweep and the encoder, or a bike batted out from under somebody snaps back
 *     to where it was parked on every other client.
 *   - **A bike inside a building**, which is a bike you can see and cannot ever
 *     reach.
 */
async function checkBikes(): Promise<void> {
  say('bikes: the lime e-bikes, off the socket and against the world files');

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const probe = groundFor(world);

  // --- 1. The set: rare, spread out, and parked somewhere reachable.
  const parked = sim.bikes.all();
  // A **share of the tiles**, not an absolute count, and that is the difference
  // between a check that means something and one that has to be edited every
  // time the pipeline runs: the inner ring went from 221 tiles to 371 during
  // this feature's own development, which moved the bike count from 67 to
  // around 110 with nothing in `game/bikes.ts` touched. What "rare" actually
  // asserts is the density -- roughly one tile in `BIKE_TILE_RARITY` -- and the
  // spacing below, both of which survive a rebuild.
  {
    const share = parked.length / world.index.tiles.length;
    check(
      share > 0.12 && share < 0.4,
      `${parked.length} bikes across ${world.index.tiles.length} tiles is one per ` +
        `${(1 / share).toFixed(1)} tiles -- rare enough to be a find, common enough to exist`,
    );
  }
  {
    let underground = 0;
    let inBuilding = 0;
    let wet = 0;
    let closest = Infinity;
    for (const bike of parked) {
      const ground = probe.groundHeight(bike.x, bike.z, -Infinity);
      if (Number.isFinite(ground) && Math.abs(bike.y - ground) > 0.5) underground++;
      if (world.collision.resolve(bike.x, bike.z, bike.x, bike.z, PLAYER_RADIUS, bike.y + 0.42).hit) inBuilding++;
      const surface = world.water.surfaceAt(bike.x, bike.z);
      if (Number.isFinite(surface) && surface > bike.y + 0.15) wet++;
      for (const other of parked) {
        if (other.id === bike.id) continue;
        closest = Math.min(closest, Math.hypot(other.x - bike.x, other.z - bike.z));
      }
    }
    check(underground === 0, `every bike is standing on the ground (${underground} were not)`);
    check(inBuilding === 0, `no bike is parked inside a building (${inBuilding} were)`);
    check(wet === 0, `no bike is parked in the harbour (${wet} were)`);
    check(closest > 60, `the nearest two bikes are ${closest.toFixed(0)} m apart, so finding one is a find`);
  }

  // --- 2. The plan is the same plan in a second process.
  //
  // The real claim behind "deterministic per build": a browser that computed a
  // different id for the same bike would send `E` about one bike and be granted
  // another. Two module instances, as `checkFooty` makes its own.
  {
    const here = new URL('../client/src/game/bikes.ts', import.meta.url).pathname;
    const one = (await import(here)) as typeof import('../client/src/game/bikes.ts');
    const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/game/bikes.ts');
    check(one.bikePlan !== two.bikePlan, 'the two bikes module instances really are separate');
    const a = one.bikePlan(world.index.tiles);
    const b = two.bikePlan(world.index.tiles);
    const same =
      a.length === b.length &&
      a.every((e, i) => e.id === b[i].id && e.tileKey === b[i].tileKey && e.x === b[i].x && e.z === b[i].z);
    check(same, `the ${a.length}-bike plan is bit-identical across two module instances`);
  }

  // --- 3. Two players, one bike, one rider.
  //
  // Both are stood on top of the same bike and both hold `E` on the same tick,
  // which is the race a real pair of players produces about once a session and
  // which no amount of playing reliably reproduces.
  const target = parked[Math.floor(parked.length / 2)];
  const first = sim.join(0, null, 'Rider');
  const second = sim.join(1, null, 'Pincher');
  const standOn = (p: ReturnType<Simulation['join']>): void => {
    p.combat.body.position.set(target.x, target.y + EYE_HEIGHT, target.z);
    p.combat.body.velocity.set(0, 0, 0);
  };
  standOn(first);
  standOn(second);
  first.input.mount = true;
  second.input.mount = true;
  sim.step(out);
  const riders = [first, second].filter((p) => p.combat.ridingBike === target.id);
  check(riders.length === 1, `two players claiming bike ${target.id} on one tick resolved to ${riders.length} rider(s)`);
  check(
    sim.bikes.get(target.id)?.rider === riders[0]?.combat.id,
    `the bike itself records rider ${sim.bikes.get(target.id)?.rider}, matching the combatant that got it`,
  );
  const loser = [first, second].find((p) => p.combat.ridingBike === 0);
  check(loser !== undefined && loser.combat.ridingBike === 0, 'the player who lost the race is on foot, not on a phantom bike');

  const rider = riders[0];
  if (!rider) {
    say('  note: no rider was granted a bike, so the rest of this section cannot run.');
    return;
  }

  // --- 4. Held `E` does not toggle.
  //
  // The button is level on the wire and edged by the reader -- see
  // `protocol.BTN.MOUNT` -- and getting that wrong is a rider who mounts and
  // dismounts sixty times a second, which reads as the bike flickering.
  {
    const before = rider.combat.ridingBike;
    for (let i = 0; i < 30; i++) sim.step(out);
    check(
      rider.combat.ridingBike === before,
      `holding E for 30 ticks left the rider on bike ${rider.combat.ridingBike} rather than toggling`,
    );
  }

  // --- 5. The speed is the server's, and a client-supplied one is ignored.
  //
  // The multiplier is written by `combat.advance` from the combatant's own
  // state, so a value planted on the input is overwritten before the integrator
  // sees it. Measured as a real distance over real ticks rather than by reading
  // the field back, because what matters is where the player *ends up*.
  {
    const untuned = bikeSpeedScale(false);
    /**
     * The **peak** speed over the run, not the final one.
     *
     * That distinction is the whole of what makes this measurable in a real
     * city: the controller accelerates at 48 m/s^2, so a bike is at its plateau
     * in about 0.6 s -- and 0.6 s later it is doing 26 m/s into the side of a
     * terrace, where `collision.resolve` correctly kills the velocity. Reading
     * the velocity at the end of the run therefore measures a wall. The peak is
     * reached long before anything can be reached, whichever direction the
     * rider happens to be pointed.
     */
    // Pinned into plain numbers *before* the first run, and that is not
    // defensiveness: `target` is the live `Bike` record, and `BikeField.follow`
    // carries a ridden bike to its rider on every tick. So by the end of the
    // first run the "starting point" has moved 30 m and is against whatever the
    // rider stopped on -- and the second run would begin jammed into a wall and
    // measure zero. Which is exactly what it did.
    const startX = target.x;
    const startY = target.y;
    const startZ = target.z;
    const run = (hack: number | undefined): number => {
      rider.combat.body.position.set(startX, startY + EYE_HEIGHT, startZ);
      rider.combat.body.velocity.set(0, 0, 0);
      rider.combat.body.yaw = 0;
      rider.input.yaw = 0;
      rider.input.forward = 1;
      rider.input.mount = true;
      rider.input.speedScale = hack;
      let peak = 0;
      for (let i = 0; i < 60; i++) {
        sim.step(out);
        peak = Math.max(peak, Math.hypot(rider.combat.body.velocity.x, rider.combat.body.velocity.z));
      }
      rider.input.forward = 0;
      rider.input.speedScale = undefined;
      return peak;
    };
    const honest = run(undefined);
    const hacked = run(99);
    check(
      Math.abs(honest - hacked) < 0.5,
      `a client claiming speedScale 99 moved at ${hacked.toFixed(1)} m/s against an honest client's ` +
        `${honest.toFixed(1)} -- the multiplier is derived from server state, not from the input`,
    );
    check(
      honest > 12,
      `a rider peaked at ${honest.toFixed(1)} m/s, well above the 8.2 m/s sprint -- ` +
        `the ${untuned.toFixed(1)}x is reaching the integrator`,
    );
  }

  // --- 6. Redfern, and only Redfern.
  check(!rider.combat.bikeTuned, 'a player who has never been to Redfern is not tuned');
  {
    const groundY = probe.groundHeight(TUNING_X, TUNING_Z, -Infinity);
    check(
      Number.isFinite(groundY),
      `the tuning stall's site at (${TUNING_X}, ${TUNING_Z}) is on ground the world actually has (y ${groundY.toFixed(2)})`,
    );
    check(
      !world.collision.resolve(TUNING_X, TUNING_Z, TUNING_X, TUNING_Z, PLAYER_RADIUS, groundY + 0.42).hit,
      'the tuning stall stands on walkable ground rather than inside a Redfern terrace',
    );
    // Walked into the zone, which is the only way this flag may be set.
    rider.combat.body.position.set(TUNING_X, groundY + EYE_HEIGHT, TUNING_Z);
    rider.input.forward = 0;
    sim.step(out);
    check(rider.combat.bikeTuned, 'standing in the stall set the unlock flag');
    check(!loser?.combat.bikeTuned, 'the other player, still across the city, is not tuned');
    check(
      bikeSpeedScale(true) > bikeSpeedScale(false),
      `a tuned bike is ${bikeSpeedScale(true).toFixed(1)}x against an untuned ${bikeSpeedScale(false).toFixed(1)}x`,
    );
    // And it survives a knockout, unlike spec 8.3's coffees.
    respawnAt(rider.combat, TUNING_X, groundY, TUNING_Z, 0);
    check(rider.combat.bikeTuned, 'the unlock survives a respawn -- it is a place you went, not a thing you were carrying');
    check(rider.combat.ridingBike === 0, 'respawning puts the player back on foot');
  }

  // --- 7. Batted off, and the bike drops where the body was.
  {
    // Back on a bike, somewhere with room.
    const spare = parked.find((b) => b.rider === 0);
    if (!spare) {
      say('  note: no free bike left to test the knock-off with.');
    } else {
      const groundY = probe.groundHeight(spare.x, spare.z, -Infinity);
      rider.combat.body.position.set(spare.x, groundY + EYE_HEIGHT, spare.z);
      rider.input.mount = false;
      sim.step(out);
      rider.input.mount = true;
      sim.step(out);
      check(rider.combat.ridingBike === spare.id, `the rider mounted bike ${spare.id}`);

      // Batted, by the other player standing next to them.
      loser!.combat.body.position.set(spare.x, groundY + EYE_HEIGHT, spare.z + 1);
      loser!.combat.body.yaw = 0;
      loser!.input.yaw = 0;
      loser!.input.mount = false;
      loser!.input.punch = true;
      loser!.history.seed(sim.tick, spare.x, groundY + EYE_HEIGHT, spare.z + 1, 0);
      rider.history.seed(sim.tick, spare.x, groundY + EYE_HEIGHT, spare.z, 0);
      const wasAt: [number, number] = [rider.combat.body.position.x, rider.combat.body.position.z];
      let knocked = false;
      for (let i = 0; i < 20 && !knocked; i++) {
        sim.step(out);
        loser!.input.punch = false;
        if (rider.combat.ridingBike === 0) knocked = true;
      }
      check(knocked, 'a rider who was batted is off the bike');
      const dropped = sim.bikes.get(spare.id);
      check(dropped?.rider === 0, `the bike is free again (rider ${dropped?.rider})`);
      check(
        dropped !== undefined && Math.hypot(dropped.x - wasAt[0], dropped.z - wasAt[1]) < 3,
        `the bike was left within 3 m of where the rider was hit, not back where it was parked`,
      );

      // --- 8. And that position round-trips the wire.
      const encoded = decodeBikes(encodeBikes(sim.bikeRecords()));
      check(encoded !== null && encoded.length === parked.length, `all ${parked.length} bikes survive an encode/decode`);
      const back = encoded?.find((b) => b.id === spare.id);
      check(
        back !== undefined &&
          Math.abs(back.x - dropped!.x) < 0.01 &&
          Math.abs(back.y - dropped!.y) < 0.01 &&
          Math.abs(back.z - dropped!.z) < 0.01 &&
          back.rider === 0,
        `the dropped bike's position round-trips to the centimetre`,
      );
      say(
        `           BIKES at join: ${bikesBytes(parked.length)} B for ${parked.length} bikes, ` +
          `sent once; a claim is ${bikesBytes(1)} B`,
      );
    }
  }


  // --- 8b. Knocked out on a bike: the bike is dropped, the rider is on foot,
  // the wire says so, and everybody sees it.
  //
  // The reported bug -- *"I died on bike and saw E to get off bike forever"* --
  // in its server-side half. The client half is a HUD derivation
  // (`bikes.ridePrompt`, asserted by `verifyBikes` at boot); this is the half
  // that has to be true for that derivation to have anything to derive from.
  //
  // **Three causes and a fourth with no cause at all.** A bat, a football and a
  // Camry each clear `ridingBike` in their own damage path, and every one of
  // those is a line somebody had to remember to write. The fourth case is the
  // one that catches the next weapon: a combatant put into the knockout phase
  // by nothing at all, which `combat.advance` now sweeps. All four are asserted
  // through the real `Simulation`, so what is being checked is the tick order --
  // damage, `advance`, `BikeField.follow`, snapshot -- and not four functions in
  // isolation.
  {
    const koCases: Array<{ name: string; hit: (victim: Participant, other: Participant) => void }> = [
      {
        name: 'batted',
        hit: (victim, other) => {
          // Through the server's own strike resolution: the other player stands
          // beside the rider, faces them, and swings. `resolveStrike` rewinds,
          // hit-tests and calls `applyHit`, which is the real path.
          other.combat.body.position.set(
            victim.combat.body.position.x,
            victim.combat.body.position.y,
            victim.combat.body.position.z + 1,
          );
          other.combat.body.yaw = 0;
          other.input.yaw = 0;
          other.input.mount = false;
          other.input.punch = true;
          // A clean swinger. The previous section left this player mid-recovery
          // with a spent stamina bar, and `advance` refuses a punch from either
          // -- which is correct behaviour and would make this section measure
          // the lockout rather than the knockout.
          other.combat.phase = 'idle';
          other.combat.phaseT = 0;
          other.combat.hitstopT = 0;
          other.combat.stamina = MAX_STAMINA;
          other.combat.staminaT = 0;
          other.combat.health = MAX_HEALTH;
          other.history.seed(
            sim.tick,
            other.combat.body.position.x,
            other.combat.body.position.y,
            other.combat.body.position.z,
            0,
          );
          victim.history.seed(
            sim.tick,
            victim.combat.body.position.x,
            victim.combat.body.position.y,
            victim.combat.body.position.z,
            0,
          );
        },
      },
      {
        name: 'pegged with a footy',
        hit: (victim, other) => {
          // `applyFootyHit`, exactly as `Simulation.step` calls it when a ball
          // resolves onto a body.
          const ball = {
            id: 1,
            thrower: other.combat.id,
            x: victim.combat.body.position.x,
            y: victim.combat.body.position.y,
            z: victim.combat.body.position.z + 1,
            vx: 0,
            vy: 0,
            vz: -22,
            age: 0.2,
            bounces: 0,
            alive: true,
          };
          applyFootyHit(other.combat, victim.combat, ball, createHitReport());
        },
      },
      {
        name: 'run down by a car',
        hit: (victim) => {
          // `applyCarHit`, exactly as `Simulation.step` calls it when
          // `carHitting` answers. The traffic query itself is a function of the
          // wall clock and is asserted in `checkTraffic`; what is being checked
          // here is what a run-down does to a ride.
          applyCarHit(victim.combat, {
            route: 0, slot: 0,
            x: victim.combat.body.position.x, y: victim.combat.body.position.y, z: victim.combat.body.position.z,
            dx: 1, dz: 0,
            body: 0, colour: 0, scale: 1,
            halfLength: 2.2, halfWidth: 0.9, height: 1.5,
            // At a road speed, because the knockback now scales with it: a car
            // in one of its parked stages is stationary and shoves nobody, and
            // this case is a *run-down*. See `traffic.carHitStrength`.
            stage: CAR_STAGE_DRIVING, routeT: 0, speed: 12,
          });
        },
      },
      {
        name: 'knocked out by nothing at all',
        hit: (victim) => {
          // No damage path, no clear, no `applyHit`. This is the case the four
          // parallel clears cannot cover and the sweep in `combat.advance` is
          // for: a future weapon, a fall, a `reconcile` adopting the server's
          // phase. If this one fails, the fix is a level rather than an event
          // and it has been reverted to an event.
          victim.combat.health = 0;
          victim.combat.phase = 'ko';
          victim.combat.koT = 0;
          victim.combat.respawnT = 3;
        },
      },
    ];

    for (const kase of koCases) {
      const spare = sim.bikes.all().find((b) => b.rider === 0);
      if (!spare) {
        say(`  note: no free bike left to test "${kase.name}" with.`);
        continue;
      }
      const groundY = probe.groundHeight(spare.x, spare.z, -Infinity);
      // Mount it, on the rising edge the server edges for itself.
      rider.combat.body.position.set(spare.x, groundY + EYE_HEIGHT, spare.z);
      rider.combat.body.velocity.set(0, 0, 0);
      rider.combat.body.yaw = 0;
      rider.input.yaw = 0;
      rider.input.forward = 0;
      rider.input.right = 0;
      rider.input.punch = false;
      rider.input.mount = false;
      sim.step(out);
      rider.input.mount = true;
      sim.step(out);
      rider.input.mount = false;
      if (rider.combat.ridingBike !== spare.id) {
        check(false, `[${kase.name}] the rider could not get on bike ${spare.id} to be knocked off it`);
        continue;
      }

      // One pip left, so the next hit is fatal however small it is. The point of
      // this section is the knockout, not the arithmetic that gets there.
      rider.combat.health = 0.5;
      rider.combat.hitstopT = 0;
      const diedAt: [number, number] = [rider.combat.body.position.x, rider.combat.body.position.z];
      kase.hit(rider, loser!);

      let knockedOut = false;
      // 60 rather than 20: a bat is a windup, an active window and a recovery,
      // and the swing has to *start* inside the first few of those.
      for (let i = 0; i < 60 && !knockedOut; i++) {
        sim.step(out);
        loser!.input.punch = false;
        if (rider.combat.phase === 'ko') knockedOut = true;
      }
      check(knockedOut, `[${kase.name}] the rider is knocked out`);
      check(
        rider.combat.ridingBike === 0,
        `[${kase.name}] and on foot: ridingBike is ${rider.combat.ridingBike}, not the bike they died on`,
      );

      const body = sim.bikes.get(spare.id);
      check(body?.rider === 0, `[${kase.name}] the bike has no rider (it says ${body?.rider})`);
      check(
        body !== undefined && Math.hypot(body.x - diedAt[0], body.z - diedAt[1]) < 4,
        `[${kase.name}] the bike was left at the death spot, ` +
          `${body ? Math.hypot(body.x - diedAt[0], body.z - diedAt[1]).toFixed(1) : '?'} m from where the rider fell`,
      );

      // The wire, which is the only thing a second browser ever sees.
      {
        const snap = sim.snapshot([]);
        const mine = snap.find((s) => s.id === rider.id);
        check(
          mine !== undefined && (mine.flags & FLAG.RIDING) === 0,
          `[${kase.name}] FLAG.RIDING is clear in the very next snapshot, so every client stops drawing ` +
            `the seated pose`,
        );
        check(
          mine !== undefined && (mine.flags & FLAG.TUNED) !== 0,
          `[${kase.name}] FLAG.TUNED survived: the Redfern unlock is a place you went, not a thing you carried`,
        );
        // And the drop itself went out as a BIKES delta on the tick it happened,
        // which is how the *other* client learns the bike is on the footpath
        // again rather than under a player who is lying on it.
        const encoded = decodeBikes(encodeBikes(sim.bikeRecords()));
        const seenByOther = encoded?.find((b) => b.id === spare.id);
        check(
          seenByOther !== undefined &&
            seenByOther.rider === 0 &&
            Math.abs(seenByOther.x - body!.x) < 0.01 &&
            Math.abs(seenByOther.z - body!.z) < 0.01,
          `[${kase.name}] a second client decodes the drop at the same spot, with no rider`,
        );
      }

      // And a knocked-out player cannot take it back by leaning on E.
      rider.input.mount = true;
      sim.step(out);
      check(
        rider.combat.ridingBike === 0,
        `[${kase.name}] holding E while knocked out did not put the rider back on a bike`,
      );
      rider.input.mount = false;

      // Respawn: on foot, and the bike stays where it was left rather than
      // teleporting across Redfern with its former rider.
      const droppedAt: [number, number] = [body!.x, body!.z];
      for (let i = 0; i < Math.ceil(3 / (1 / 60)) + 30 && rider.combat.phase === 'ko'; i++) sim.step(out);
      check(rider.combat.phase !== 'ko', `[${kase.name}] the rider got back up`);
      check(rider.combat.ridingBike === 0, `[${kase.name}] and came back on foot`);
      const after = sim.bikes.get(spare.id);
      check(
        after !== undefined && Math.hypot(after.x - droppedAt[0], after.z - droppedAt[1]) < 0.01,
        `[${kase.name}] the bike did not follow them to the respawn point`,
      );
      // Which means somebody else can ride away on it, which is the whole point
      // of dropping it where the body fell.
      check(sim.bikes.claim(spare.id, loser!.combat.id), `[${kase.name}] and anybody else can now claim it`);
      sim.bikes.release(spare.id, after!.x, after!.y, after!.z, after!.yaw);
      loser!.combat.ridingBike = 0;
    }
  }

  // --- 8c. Steering: A and D turn the bars, and move nobody sideways.
  //
  // The user's report was *"I can strafe while riding but should instead be able
  // to turn"*. The remap is client-side by design -- `yaw` and `right` are both
  // already client-authoritative inputs, so shaping them in the browser's input
  // builder means `controller.step` is not forked and prediction stays exact by
  // construction. What that design *needs* asserting is that the shaped input,
  // fed to the real server, produces a turn and no strafe at all.
  //
  // So this calls `bikes.shapeRideSteering` exactly as `main.ts` does, hands the
  // result to `Simulation.step`, and measures where the body ends up. The
  // on-foot run is the control: the same keypress, the same duration, the same
  // world, and a completely different trajectory.
  {
    const spare = sim.bikes.all().find((b) => b.rider === 0);
    if (!spare) {
      say('  note: no free bike left to test the steering with.');
    } else {
      const groundY = probe.groundHeight(spare.x, spare.z, -Infinity);
      const steering: RideSteering = { right: 0, yawDelta: 0 };
      const TICKS = 60;

      /**
       * Hold `D` for a second, with or without a bike under you, and report what
       * the body did. `throttle` is `W`.
       */
      const holdD = (onBike: boolean, throttle: number) => {
        rider.combat.ridingBike = 0;
        sim.bikes.release(spare.id, spare.x, spare.y, spare.z, spare.yaw);
        rider.combat.body.position.set(spare.x, groundY + EYE_HEIGHT, spare.z);
        rider.combat.body.velocity.set(0, 0, 0);
        rider.combat.body.yaw = 0;
        rider.combat.health = MAX_HEALTH;
        rider.combat.phase = 'idle';
        rider.input.yaw = 0;
        rider.input.pitch = 0;
        rider.input.punch = false;
        rider.input.mount = false;
        if (onBike) {
          sim.bikes.claim(spare.id, rider.combat.id);
          rider.combat.ridingBike = spare.id;
        }
        const from = { x: rider.combat.body.position.x, z: rider.combat.body.position.z, yaw: 0 };
        let lateralSum = 0;
        let lateralTicks = 0;
        let peak = 0;
        for (let i = 0; i < TICKS; i++) {
          // The browser's input builder, verbatim: `D` is +1, the speed is the
          // body's, the delta is the frame.
          shapeRideSteering(rider.combat, 1, planSpeed(rider.combat), 1 / 60, steering);
          rider.input.right = steering.right;
          rider.input.yaw += steering.yawDelta;
          rider.input.forward = throttle;
          rider.input.sprint = true;
          sim.step(out);
          const speed = Math.hypot(rider.combat.body.velocity.x, rider.combat.body.velocity.z);
          peak = Math.max(peak, speed);
          if (speed > 1) {
            // **How much of the velocity is sideways, signed**, which is the
            // measurement that tells a strafe from a turn and the reason this is
            // not an angle.
            //
            // The naive metric is "how far is the velocity from the facing", and
            // it does not work: a bike at 26 m/s turning at 1.15 rad/s needs
            // 30 m/s^2 of lateral acceleration to keep the velocity on the nose
            // and the controller only has 48, so the velocity genuinely trails
            // the facing by 30-odd degrees in a hard turn. That is a *turn*, not
            // a crab, and an unsigned angle cannot tell it from the 45 degrees a
            // strafe produces.
            //
            // The sign can. `D` on foot pushes the velocity to the **right** of
            // the facing and holds it there forever. `D` on a bike rotates the
            // facing out from under a velocity that is chasing it, so the
            // velocity trails to the **left**. Right is positive here, so a
            // strafe is about +0.7 and a turn is zero or negative, whatever the
            // speed and whatever the turn rate.
            const rx = Math.cos(rider.combat.body.yaw);
            const rz = -Math.sin(rider.combat.body.yaw);
            lateralSum += (rider.combat.body.velocity.x * rx + rider.combat.body.velocity.z * rz) / speed;
            lateralTicks++;
          }
        }
        return {
          yawTurned: from.yaw - rider.combat.body.yaw,
          // Straight-line displacement, which is only meaningful for the
          // standstill runs -- a second at 26 m/s in this city usually ends
          // against a terrace, which is what `peak` is for. Section 5 above
          // makes the identical argument about measuring a bike's speed.
          moved: Math.hypot(rider.combat.body.position.x - from.x, rider.combat.body.position.z - from.z),
          lateral: lateralTicks > 0 ? lateralSum / lateralTicks : 0,
          peak,
        };
      };

      // --- No throttle. The cleanest statement of the difference: on foot `D`
      // is movement and no turn; on a bike it is a turn and no movement.
      const footStill = holdD(false, 0);
      const bikeStill = holdD(true, 0);
      check(
        footStill.yawTurned === 0 && footStill.moved > 2,
        `on foot, a second of D moved the player ${footStill.moved.toFixed(1)} m sideways and turned them ` +
          `${footStill.yawTurned.toFixed(2)} rad -- that is a strafe`,
      );
      check(
        bikeStill.moved < 0.05,
        `on a bike, the same second of D moved the rider ${bikeStill.moved.toFixed(3)} m. ` +
          `A bicycle does not sidestep, and RIDE_STRAFE is ${RIDE_STRAFE}`,
      );
      check(
        Math.abs(bikeStill.yawTurned - RIDE_TURN_RATE) < 0.08,
        `and turned them ${bikeStill.yawTurned.toFixed(2)} rad against the ${RIDE_TURN_RATE} rad/s the bars ` +
          `are geared for at a standstill`,
      );

      // --- Under throttle. The bike curves -- it has to, or the steering is a
      // pirouette -- but it never crabs: the velocity stays on the nose.
      const footRun = holdD(false, 1);
      const bikeRun = holdD(true, 1);
      check(
        footRun.lateral > 0.5,
        `on foot, W and D together put ${(footRun.lateral * 100).toFixed(0)}% of the velocity out to the right ` +
          `of the facing and left it there -- that is the diagonal a strafe produces`,
      );
      check(
        bikeRun.lateral <= 0.05,
        `on a bike the sideways component averaged ${(bikeRun.lateral * 100).toFixed(0)}%: the velocity trails ` +
          `the facing round the corner instead of being pushed out beside it. Nothing strafes`,
      );
      check(
        bikeRun.yawTurned > 0.5,
        `the rider came out of the run ${bikeRun.yawTurned.toFixed(2)} rad round, so D really is the bars`,
      );
      check(
        bikeRun.yawTurned < bikeStill.yawTurned,
        `and turned less under power (${bikeRun.yawTurned.toFixed(2)} rad) than at a standstill ` +
          `(${bikeStill.yawTurned.toFixed(2)} rad), so 39 m/s does not twitch -- ` +
          `rideTurnRate(0)=${rideTurnRate(0).toFixed(2)}, rideTurnRate(26)=${rideTurnRate(26).toFixed(2)}`,
      );
      check(
        bikeRun.peak > 12,
        `it peaked at ${bikeRun.peak.toFixed(1)} m/s while doing it -- the throttle is still a throttle, and ` +
          `steering costs no speed`,
      );

      // --- And the server cannot be talked into a strafe by a client that
      // simply refuses to do the remap. `shapeRideInput` runs on this process
      // too, so `RIDE_STRAFE` is a rule and not a courtesy.
      {
        rider.combat.ridingBike = 0;
        sim.bikes.release(spare.id, spare.x, spare.y, spare.z, spare.yaw);
        rider.combat.body.position.set(spare.x, groundY + EYE_HEIGHT, spare.z);
        rider.combat.body.velocity.set(0, 0, 0);
        rider.combat.body.yaw = 0;
        rider.input.yaw = 0;
        sim.bikes.claim(spare.id, rider.combat.id);
        rider.combat.ridingBike = spare.id;
        const from = { x: rider.combat.body.position.x, z: rider.combat.body.position.z };
        for (let i = 0; i < TICKS; i++) {
          // A hand-rolled client: full lateral input, no yaw, no remap.
          rider.input.right = 1;
          rider.input.forward = 0;
          rider.input.sprint = true;
          sim.step(out);
        }
        const moved = Math.hypot(
          rider.combat.body.position.x - from.x,
          rider.combat.body.position.z - from.z,
        );
        check(
          moved < 0.05,
          `a client sending right=1 while riding moved ${moved.toFixed(3)} m sideways. The remap is in the ` +
            `browser and the clamp is here, so a client that skips the first still cannot strafe`,
        );
        rider.input.right = 0;
        rider.combat.ridingBike = 0;
        sim.bikes.release(spare.id, spare.x, spare.y, spare.z, spare.yaw);
      }
    }
  }

  // --- 9. Protocol 9, and the refusal behaviour a version bump exists for.
  // v9 is a shared bump: global chat and the suggestions box both added message
  // types in the same pass without changing an existing layout. See
  // `protocol.PROTOCOL_VERSION`.
  check(PROTOCOL_VERSION === 9, `the protocol is at version ${PROTOCOL_VERSION}`);
  {
    // A protocol-5 hello -- which is what a browser tab left open across this
    // deploy sends -- must still decode far enough to be refused *by version*,
    // rather than failing to parse and being dropped into a silent socket.
    const stale = new ArrayBuffer(5);
    const v = new DataView(stale);
    v.setUint8(0, MSG.HELLO);
    v.setUint16(1, 5, true);
    v.setUint8(3, 255);
    v.setUint8(4, 0);
    const old = decodeHello(stale);
    check(
      old !== null && old.version === 5,
      'a protocol-5 HELLO still decodes to version 5, so a stale tab gets a BYE it can print rather than silence',
    );
    // And a **protocol-7** one, which is the version this deploy replaces and
    // therefore the one every open tab in the world is speaking right now. v8
    // widened four id fields, so a v7 client that was tolerated rather than
    // refused would read every player's position out of the wrong offset -- a
    // city of people at plausible wrong coordinates, with nothing thrown on
    // either end. This is the case `PROTOCOL_VERSION`'s own comment is about.
    const v7 = new ArrayBuffer(5);
    const v7v = new DataView(v7);
    v7v.setUint8(0, MSG.HELLO);
    v7v.setUint16(1, 7, true);
    v7v.setUint8(3, 255);
    v7v.setUint8(4, 0);
    const prev = decodeHello(v7);
    // `prev.version` is compared against a number the compiler knows is 8, so
    // the inequality is written against the constant rather than against
    // `PROTOCOL_VERSION` -- which TypeScript narrows to a literal and then
    // rejects as an impossible comparison. The claim is the same one: the
    // version this deploy replaces is not the version it speaks.
    const previousVersion = 7;
    check(
      prev !== null && prev.version === previousVersion && PROTOCOL_VERSION > previousVersion,
      'a protocol-7 HELLO decodes to version 7 and is therefore refusable -- the tab open across this deploy',
    );
  }
}

/**
 * The traffic, off the socket -- because **nothing about a car is ever on it**.
 *
 * `checkFooty`'s argument, one step further. A ball at least has its position in
 * the snapshot; a car has nothing at all. Every client and the server compute
 * where all six thousand of them are from the same baked timetables and the same
 * wall clock, so the only thing that can make two processes disagree is the
 * arithmetic itself -- and if it does, the symptom is a player being knocked
 * flying by a car that, on their screen, is thirty metres up the road.
 *
 * So the first check loads **a second instance of the module** under a different
 * specifier, exactly as `checkFooty` does and for the same reason: two
 * separately-evaluated copies with their own closures and their own constants,
 * which is as close as one process gets to "a browser and a server agree". A
 * `Math.random`, a module-level counter, a cached scratch object shared between
 * calls, or a `Math.hypot` that rounds differently would all pass a
 * same-instance comparison and fail here.
 *
 * The rest is what a car is *for*: a scripted player standing in a lane is run
 * down, takes a pip, is thrown along the car's heading, and cannot be run down
 * again while they are still in the air.
 */
async function checkTraffic(): Promise<void> {
  const here = new URL('../client/src/game/traffic.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/game/traffic.ts');
  const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/game/traffic.ts');

  check(
    one.poseCar !== two.poseCar,
    'the two traffic module instances really are separate (their exports are different objects)',
  );

  // The module's own synthetic checks, through both instances. Cheap, and it is
  // what makes a failure here say *which* half broke before the world is opened.
  for (const [label, mod] of [['instance 1', one], ['instance 2', two]] as const) {
    const f = mod.verifyTraffic();
    check(f.length === 0, `verifyTraffic passes on ${label}` + (f.length ? ` -- ${f[0]}` : ''));
  }

  const root = new URL('../client/public/world', import.meta.url).pathname;
  let world;
  try {
    world = await loadWorld(root);
  } catch (err) {
    say(`  note: could not open the world at ${root} (${String(err)}) -- skipping the traffic checks.`);
    return;
  }
  const routes = world.traffic.routes();
  if (routes.length === 0) {
    say('  note: this world has no lane graph in it -- skipping the traffic checks.');
    return;
  }
  say(
    `  world: ${world.traffic.tileCount} tiles carry lanes, ${routes.length.toLocaleString()} routes, ` +
      `${(world.bytes.lanes / 1024).toFixed(0)} kB`,
  );

  // --- Determinism, over ten thousand ticks and a hundred routes.
  //
  // `!==` on the doubles, not a tolerance. The claim is that the two instances
  // produce the same *bits*, and a check that allowed a millimetre would pass a
  // simulation that had begun to drift.
  {
    const a = one.createCarPose();
    const b = two.createCarPose();
    const sample = routes.filter((_, i) => i % Math.max(1, Math.floor(routes.length / 100)) === 0);
    let compared = 0;
    let live = 0;
    let parked = 0;
    let ramping = 0;
    let firstBad = -1;
    // Wider than the two slots a driving car needs, because a slot's life now
    // starts before its departure and ends after its arrival -- see the park
    // stages in `game/traffic.ts`. Slots -2 and 3 are the ones sitting in a kerb
    // bay at either end of the window, and they are the whole point of this
    // pass: the stages are derived at *decode* time from the ways block, so a
    // decoder that rounded a kerb offset differently, or ordered its way scan
    // differently, would put one process's parked fleet somewhere the other's is
    // not -- and it would do it in the one state a player is least likely to
    // report, because a parked car looks like scenery.
    outer: for (let tick = 0; tick < 10000; tick += 7) {
      const now = one.trafficSeconds(tick);
      const alsoNow = two.trafficSeconds(tick);
      if (now !== alsoNow) {
        firstBad = tick;
        break;
      }
      for (const route of sample) {
        for (let slot = -2; slot <= 3; slot++) {
          const liveA = one.poseCar(route, slot, now, a);
          const liveB = two.poseCar(route, slot, now, b);
          compared++;
          if (liveA !== liveB) {
            firstBad = tick;
            break outer;
          }
          if (!liveA) continue;
          live++;
          if (a.stage === one.CAR_STAGE_PARKED_IN || a.stage === one.CAR_STAGE_PARKED_OUT) parked++;
          else if (a.stage !== one.CAR_STAGE_DRIVING) ramping++;
          if (
            a.x !== b.x || a.y !== b.y || a.z !== b.z ||
            a.dx !== b.dx || a.dz !== b.dz ||
            a.body !== b.body || a.colour !== b.colour || a.scale !== b.scale ||
            a.stage !== b.stage || a.speed !== b.speed
          ) {
            firstBad = tick;
            break outer;
          }
        }
      }
    }
    check(
      firstBad < 0,
      `${sample.length} routes are bit-identical across two module instances over 10,000 ticks ` +
        `(${compared.toLocaleString()} lookups, ${live.toLocaleString()} live cars, of which ` +
        `${parked.toLocaleString()} parked at a kerb and ${ramping.toLocaleString()} on a ramp)` +
        (firstBad >= 0 ? ` -- first divergence at tick ${firstBad}` : ''),
    );
    check(
      parked > 0 && ramping > 0,
      'the sample actually exercised the park stages rather than only the driving one',
    );
  }

  // --- The timetable is still monotone, and the ramps did not shift it.
  //
  // This is the lane audit's own property carried into the reparametrisation:
  // `lanes.py` proves two cars on one route never meet from the fact that route
  // time only ever increases, so a warp that dipped -- a car in reverse for two
  // frames -- would quietly delete that proof and put two bodies in one place
  // somewhere in the city at some hour of the day.
  //
  // Measured as *displacement*, at 60 Hz, across a whole car's life including
  // both dwells: a car that never moves more in one tick than its own class
  // could travel has no teleports in it, and one whose net motion never reverses
  // has a monotone timetable. Both are the same sweep because both are the same
  // claim -- that the five stages join up.
  {
    const p = one.createCarPose();
    const sample = routes.filter((_, i) => i % Math.max(1, Math.floor(routes.length / 60)) === 0);
    let worstStep = 0;
    let worstRoute = -1;
    let reversals = 0;
    let swept = 0;
    let lives = 0;
    for (const route of sample) {
      // One whole life of slot 0, dwells included, walked at the simulation rate.
      const from = Math.floor((route.phase - 40) * 60);
      const to = Math.ceil((route.phase + route.duration + 40) * 60);
      let px = NaN;
      let pz = NaN;
      let lastT = -Infinity;
      let ticks = 0;
      for (let tick = from; tick <= to; tick++) {
        if (!one.poseCar(route, 0, one.trafficSeconds(tick), p)) {
          px = NaN;
          lastT = -Infinity;
          continue;
        }
        ticks++;
        swept++;
        if (!Number.isNaN(px)) {
          const dx = p.x - px;
          const dz = p.z - pz;
          const step = Math.sqrt(dx * dx + dz * dz);
          if (step > worstStep) {
            worstStep = step;
            worstRoute = route.rid;
          }
        }
        // The property itself, off the pose rather than inferred from the
        // polyline -- a route that turns a corner changes direction without ever
        // going backwards in time, and only the second of those is a bug.
        if (p.routeT < lastT) reversals++;
        lastT = p.routeT;
        px = p.x;
        pz = p.z;
      }
      if (ticks > 0) lives++;
    }
    // The fastest class in the extent is the motorway at 100 km/h, which is
    // 0.46 m in a tick. Half a metre is that plus the lateral a kerb ramp adds.
    check(
      worstStep < 0.5,
      `no car moves more than ${worstStep.toFixed(3)} m in one tick anywhere in ${lives} sampled lives ` +
        `(${swept.toLocaleString()} ticks) -- the five stages join up with no teleport` +
        (worstStep >= 0.5 ? ` (worst on route ${worstRoute})` : ''),
    );
    check(
      reversals === 0,
      `and none of them ever reverses (${reversals} backward steps) -- the ramp warp is monotone, ` +
        "so `lanes.py`'s two-cars-never-meet argument survives it",
    );
  }

  // --- The hash, which is the specific mechanism the identities above rest on.
  {
    let differing = 0;
    for (let rid = 1; rid <= 400; rid++) {
      for (let slot = 0; slot < 4; slot++) {
        if (one.carHash(rid, slot) !== two.carHash(rid, slot)) differing++;
      }
    }
    check(differing === 0, 'the car hash agrees over all 1,600 (route, slot) pairs');
  }

  // --- Every car in the city is on a road at a plausible height, and the
  // schedule is dense enough to be traffic rather than a novelty.
  {
    const pose = one.createCarPose();
    let cars = 0;
    let parked = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    const tick = one.trafficTick(Date.now());
    const now = one.trafficSeconds(tick);
    for (const route of routes) {
      // Widened by `dwellCap` at both ends, because a slot exists before it
      // departs and after it arrives now -- it is sitting in a kerb bay. This
      // arithmetic is `traffic.liveSlots`', restated here rather than exported
      // for the reason the rest of this file restates things: what is under test
      // is the module, and a check that called the module's own range helper
      // could not tell a broken range from a broken check.
      for (let slot = Math.floor((now - route.phase - route.duration - route.dwellCap) / route.headway) + 1;
           slot <= Math.floor((now - route.phase + route.dwellCap) / route.headway); slot++) {
        if (!one.poseCar(route, slot, now, pose)) continue;
        cars++;
        if (pose.stage === one.CAR_STAGE_PARKED_IN || pose.stage === one.CAR_STAGE_PARKED_OUT) parked++;
        if (pose.y < lowest) lowest = pose.y;
        if (pose.y > highest) highest = pose.y;
      }
    }
    check(
      cars > 1000,
      `${cars.toLocaleString()} cars exist across the whole extent right now, ` +
        `${parked.toLocaleString()} of them parked at a kerb between runs`,
    );
    // How many route ends had no way close enough to derive a kerb bay from --
    // a motorway deck, or an end whose own way is in the next tile's sidecar.
    // Reported rather than checked, because the right number is a property of
    // the shipped world rather than of this code: those cars dwell at the lane
    // offset instead, which is a car stopped in a lane, which is what a car
    // stopped on a motorway is. It is here so that a pipeline change to the ways
    // block shows up as this number moving.
    {
      let kerbless = 0;
      for (const route of routes) {
        if (route.kerbShift0 === 0) kerbless++;
        if (route.kerbShift1 === 0) kerbless++;
      }
      const ends = routes.length * 2;
      say(
        `  kerbs: ${(ends - kerbless).toLocaleString()} of ${ends.toLocaleString()} route ends park ` +
          `against a derived kerb bay; ${kerbless.toLocaleString()} ` +
          `(${((kerbless / ends) * 100).toFixed(1)}%) dwell at the lane offset instead`,
      );
      check(
        kerbless < ends * 0.25,
        `at least three route ends in four found a kerb (${(((ends - kerbless) / ends) * 100).toFixed(1)}%)`,
      );
    }
    // The datum puts sea level at y = -71.075. A lane whose height lookup missed
    // is on the harbour bed at -74, or over it on a deck that solved to nothing;
    // both are the failure this catches, and both render as a car driving
    // through the water off Dawes Point.
    //
    // **The band is read off the built world rather than written down**, which
    // it has to be now that there is more than one stage: the top of it was a
    // literal 40 -- roughly 111 m AHD, chosen when Bellevue Hill's 97 m was the
    // highest ground in the build -- and the middle ring reaches Frenchs Forest
    // and the Killara ridge, whose streets are legitimately half as high again.
    // A literal would have to be re-guessed at every stage and would be wrong in
    // the safe direction each time. Sampling the terrain gives the real ceiling
    // for whatever was built, and the margin above it is the deck allowance: the
    // Harbour Bridge roadway is ~50 m over the water it crosses and is a car
    // that is correctly nowhere near the ground under it.
    let groundHi = -Infinity;
    let groundLo = Infinity;
    for (let x = -world.index.radius_m; x <= world.index.radius_m; x += 250) {
      for (let z = -world.index.radius_m; z <= world.index.radius_m; z += 250) {
        if (x * x + z * z > world.index.radius_m * world.index.radius_m) continue;
        const h = world.terrain.height(x, z);
        if (!Number.isFinite(h)) continue;
        if (h > groundHi) groundHi = h;
        if (h < groundLo) groundLo = h;
      }
    }
    const DECK_ALLOWANCE = 60;
    check(
      lowest >= groundLo && highest < groundHi + DECK_ALLOWANCE,
      `every one of them is between y ${lowest.toFixed(1)} and ${highest.toFixed(1)}, inside the built ` +
        `${world.index.stage} stage's own ground range of ${groundLo.toFixed(1)} to ${groundHi.toFixed(1)} ` +
        `plus a ${DECK_ALLOWANCE} m deck allowance`,
    );
    // --- And the failure the band used to stand in for, measured directly.
    //
    // The old lower bound was the literal -73, one metre above the inner ring's
    // bathymetry: a car below it had to be a lane whose height lookup fell into
    // the harbour. The middle ring's rivers go deeper than that, so the literal
    // stopped discriminating -- it now rejects the built terrain's own floor --
    // and the honest replacement is to count the thing itself. A car under the
    // waterline is a car in the river, whatever the extent's deepest point
    // happens to be.
    {
      let sunk = 0;
      let total = 0;
      let worstX = 0;
      let worstZ = 0;
      let worstY = 0;
      const sea = world.index.terrain.sea_level_y;
      for (const route of routes) {
        for (let slot = Math.floor((now - route.phase - route.duration - route.dwellCap) / route.headway) + 1;
             slot <= Math.floor((now - route.phase + route.dwellCap) / route.headway); slot++) {
          if (!one.poseCar(route, slot, now, pose)) continue;
          total++;
          if (pose.y >= sea) continue;
          sunk++;
          if (pose.y < worstY || sunk === 1) {
            worstY = pose.y;
            worstX = pose.x;
            worstZ = pose.z;
          }
        }
      }
      say(
        `  waterline: ${sunk} of ${total.toLocaleString()} cars sit below y ${sea} (sea level)` +
          (sunk ? `; deepest at (${worstX.toFixed(0)}, ${worstZ.toFixed(0)}), y ${worstY.toFixed(1)}` : ''),
      );
      check(
        sunk <= total * 0.0005,
        `at most one car in two thousand is under the waterline (${sunk} of ${total.toLocaleString()}) -- ` +
          'a lane end whose height lookup landed on the riverbed rather than on the bridge over it',
      );
    }
  }

  // --- A scripted player standing in a lane is run down.
  //
  // Not a synthetic route: a real one, out of the shipped world, at a real tick.
  // The player is placed exactly where the car will be, which is what somebody
  // standing in the road *is*.
  {
    const pose = one.createCarPose();
    const scratch: (typeof routes)[number][] = [];
    const tick = one.trafficTick(Date.now());
    const now = one.trafficSeconds(tick);
    let placed = false;
    let ko = false;
    let health = 0;
    let speed = 0;
    let rehit = true;
    let heading = 0;
    for (const route of routes) {
      if (placed) break;
      const slot = Math.floor((now - route.phase) / route.headway);
      if (!one.poseCar(route, slot, now, pose)) continue;
      // A *driving* car, explicitly. The same slot arithmetic now also lands on
      // cars sitting in a kerb bay and on cars easing out of one, and both of
      // those hit softer by design -- see the matrix below, which is where they
      // are checked. What this block is about is the full-speed run-down, and it
      // has to stay the assertion it was.
      if (pose.stage !== one.CAR_STAGE_DRIVING || one.carHitStrength(pose) !== 1) continue;
      const victim = createCombatant(9, 0, 0);
      victim.body.position.set(pose.x, pose.y + EYE_HEIGHT, pose.z);
      const car = one.carHitting(world.traffic, victim, tick, scratch, one.createCarPose());
      if (car === null) continue;
      // The car that found them need not be the car they were placed on.
      if (one.carHitStrength(car) !== 1) continue;
      placed = true;
      heading = Math.sqrt(car.dx * car.dx + car.dz * car.dz);
      ko = one.applyCarHit(victim, car);
      health = victim.health;
      speed = Math.sqrt(
        victim.body.velocity.x * victim.body.velocity.x +
          victim.body.velocity.z * victim.body.velocity.z,
      );
      // The re-hit guard. A body still in the air from the last car must not be
      // launched again by the next one sixty times a second.
      rehit = one.carHitting(world.traffic, victim, tick, scratch, one.createCarPose()) !== null;
    }
    check(placed, 'a player standing in a real lane at a real tick was found by a car');
    if (placed) {
      check(
        health === 3 - one.CAR_DAMAGE && !ko,
        `being run down took exactly ${one.CAR_DAMAGE} pip (3 -> ${health})`,
      );
      check(
        Math.abs(speed - one.CAR_KNOCKBACK_HORIZONTAL) < 1e-9,
        `it threw them at exactly ${one.CAR_KNOCKBACK_HORIZONTAL} m/s along the car's heading ` +
          `(measured ${speed.toFixed(6)}, heading is a unit vector to ${Math.abs(1 - heading).toExponential(1)})`,
      );
      check(!rehit, 'a victim still in the car flinch cannot be run down again on the same tick');
    }
  }

  // --- The knockdown matrix: parked, pulling out, at speed.
  //
  // The feature that removed the pop put a stationary two-tonne object at the
  // kerb of every route end in Sydney, which is where players walk. Before it,
  // "is there a car overlapping this capsule" and "does a car knock this capsule
  // over" were the same question and the answer was always the full 10.5 m/s.
  // Now they are three questions, and all three are here against the shipped
  // world rather than a synthetic route:
  //
  //   parked     nothing at all. Standing against a parked car is standing
  //              against a bollard, and this is also the fix for a bug that
  //              predates the parking -- a car held at a red used to flatten you.
  //   pulling out  a shove that scales with how fast it is actually going.
  //   at speed   exactly what it always was, which is the assertion above.
  {
    const scratch: (typeof routes)[number][] = [];
    const probe = one.createCarPose();
    const tick = one.trafficTick(Date.now());
    const now = one.trafficSeconds(tick);
    let parkedTried = 0;
    let parkedHit = 0;
    let parkedArmed = 0;
    let parkedOverlapped = 0;
    let rampTried = 0;
    let rampOutside = 0;
    let worstRampSpeed = 0;
    let gentlestRampSpeed = Infinity;
    for (const route of routes) {
      const lo = Math.floor((now - route.phase - route.duration - route.dwellCap) / route.headway) + 1;
      const hi = Math.floor((now - route.phase + route.dwellCap) / route.headway);
      for (let slot = lo; slot <= hi; slot++) {
        if (!one.poseCar(route, slot, now, probe)) continue;
        const parked = probe.stage === one.CAR_STAGE_PARKED_IN || probe.stage === one.CAR_STAGE_PARKED_OUT;
        if (parked && parkedTried < 200) {
          parkedTried++;
          const bystander = createCombatant(9, 0, 0);
          bystander.body.position.set(probe.x, probe.y + EYE_HEIGHT, probe.z);
          // It still occupies the ground it is on -- that has to keep being true,
          // or a future spawn rule would put a player inside a parked car.
          if (one.carOverlaps(probe, bystander)) parkedOverlapped++;
          // The claim is about *this* car. A kerb bay is a metre off the lane,
          // so somebody standing in one is close enough to be clipped by traffic
          // going past -- and should be. What must never happen is the parked
          // car itself doing it, so the hit is compared by identity rather than
          // by presence.
          const hit = one.carHitting(world.traffic, bystander, tick, scratch, one.createCarPose());
          if (hit !== null && hit.route === probe.route && hit.slot === probe.slot) parkedHit++;
          if (one.carHitStrength(probe) !== 0) parkedArmed++;
        }
        if (probe.stage === one.CAR_STAGE_PULL_OUT || probe.stage === one.CAR_STAGE_PULL_IN) {
          const k = one.carHitStrength(probe);
          if (k > 0 && k < 1 && rampTried < 200) {
            rampTried++;
            const victim = createCombatant(9, 0, 0);
            victim.body.position.set(probe.x, probe.y + EYE_HEIGHT, probe.z);
            one.applyCarHit(victim, probe);
            const thrown = Math.sqrt(
              victim.body.velocity.x * victim.body.velocity.x +
                victim.body.velocity.z * victim.body.velocity.z,
            );
            if (thrown > worstRampSpeed) worstRampSpeed = thrown;
            if (thrown < gentlestRampSpeed) gentlestRampSpeed = thrown;
            // Strictly gentler than a run-down and strictly more than nothing.
            if (!(thrown > 0) || thrown >= one.CAR_KNOCKBACK_HORIZONTAL) rampOutside++;
          }
        }
      }
      if (parkedTried >= 200 && rampTried >= 200) break;
    }
    check(
      parkedTried > 0 && parkedOverlapped === parkedTried,
      `all ${parkedTried} parked cars sampled still overlap a body standing on them -- a parked car is ` +
        'furniture, not a hole in the world',
    );
    check(
      parkedHit === 0 && parkedArmed === 0,
      `and not one of them knocked that body over (${parkedHit} did), because not one of them reports ` +
        `any hit strength at all (${parkedArmed} did) -- a stationary car is furniture`,
    );
    check(
      rampTried > 0 && rampOutside === 0,
      `${rampTried} cars caught mid-ramp all threw a victim strictly between nothing and a run-down: ` +
        `${gentlestRampSpeed.toFixed(2)} to ${worstRampSpeed.toFixed(2)} m/s against the full ` +
        `${one.CAR_KNOCKBACK_HORIZONTAL} -- the scale is continuous, so a car easing out of a bay tips ` +
        'you over and a car most of the way up to speed still throws you',
    );
  }

  // --- What it costs to draw, now that the fleet includes the parked half.
  //
  // Reported and bounded rather than asserted to a figure: the client's budget is
  // about a millisecond for `TrafficMovers.update`, and what this can measure
  // headlessly is the *work* that budget is spent on -- how many cars land inside
  // the 420 m draw radius and how long posing them takes. The park stages add
  // roughly one car per route end to that count, which is the price of the pop
  // going away and is the number to watch if it ever stops being worth paying.
  {
    const probe = one.createCarPose();
    const scratchR: (typeof routes)[number][] = [];
    // Two places, because the spawn is Sydney Park and the number that decides
    // the budget is the CBD's. The busy one is found rather than named: the
    // route start with the most routes inside a draw radius of it, which is the
    // densest lane graph in the extent by construction and needs no coordinate
    // in this file to go stale.
    // `cars.TRAFFIC_DRAW_RADIUS`, restated. That module imports three and can
    // never be loaded in this process; `verifyTraffic`'s body-table argument is
    // the same shape and the same reason.
    const DRAW_RADIUS = 420;
    const spawn = world.spawn;
    let busyX = spawn.x;
    let busyZ = spawn.z;
    let busyRoutes = -1;
    for (let i = 0; i < routes.length; i += 5) {
      const n = world.traffic.near(routes[i].x[0], routes[i].z[0], DRAW_RADIUS, scratchR).length;
      if (n > busyRoutes) {
        busyRoutes = n;
        busyX = routes[i].x[0];
        busyZ = routes[i].z[0];
      }
    }
    let worstPeak = 0;
    for (const [label, px, pz] of [['spawn', spawn.x, spawn.z], ['busiest', busyX, busyZ]] as const) {
      let peak = 0;
      let peakParked = 0;
      let peakDriving = 0;
      let total = 0;
      let samples = 0;
      const started = performance.now();
      for (let t = 0; t < 60; t++) {
        const tick = one.trafficTick(Date.now()) + t * 37;
        let n = 0;
        let parked = 0;
        let driving = 0;
        one.forEachCarNear(world.traffic, px, pz, DRAW_RADIUS, tick, scratchR, probe, (p) => {
          n++;
          if (p.stage === one.CAR_STAGE_PARKED_IN || p.stage === one.CAR_STAGE_PARKED_OUT) parked++;
          else if (p.stage === one.CAR_STAGE_DRIVING) driving++;
        });
        total += n;
        samples++;
        if (n > peak) {
          peak = n;
          peakParked = parked;
          peakDriving = driving;
        }
      }
      const perPlace = (performance.now() - started) / samples;
      if (peak > worstPeak) worstPeak = peak;
      // `peakDriving` is what this radius held *before* the park stages existed:
      // the driving stage is the whole of the old life. So the pair is the
      // before and after of this change, measured rather than estimated.
      say(
        `  draw @${label}: ${peak} cars peak inside ${DRAW_RADIUS} m ` +
          `(${peakDriving} driving -- what it was before the park stages -- ${peakParked} parked, ` +
          `${peak - peakDriving - peakParked} on a ramp), ${(total / samples).toFixed(0)} mean, ` +
          `${perPlace.toFixed(2)} ms to walk them`,
      );
    }
    // `cars.MOVER_CAPACITY` is per body type and the mix puts at most a third of
    // these in the busiest one, so the ceiling that matters is roughly three
    // times it. This is the check that would fire if a future headway or dwell
    // change quietly overflowed the instanced sets and started dropping cars.
    check(
      worstPeak < 3 * 256,
      `which is inside the instanced sets' combined capacity (worst peak ${worstPeak})`,
    );
  }

  // --- And the whole thing reproduces bit for bit in the other instance, which
  // is the claim the client's prediction actually rests on: the server applies
  // the shove and the browser applies its own, and they must be the same shove.
  {
    const scratch1: (typeof routes)[number][] = [];
    const scratch2: (typeof routes)[number][] = [];
    const tick = one.trafficTick(Date.now());
    const now = one.trafficSeconds(tick);
    let compared = 0;
    let bad = 0;
    for (const route of routes) {
      const slot = Math.floor((now - route.phase) / route.headway);
      const at = one.createCarPose();
      if (!one.poseCar(route, slot, now, at)) continue;
      const va = createCombatant(9, 0, 0);
      const vb = createCombatant(9, 0, 0);
      va.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      vb.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      const ca = one.carHitting(world.traffic, va, tick, scratch1, one.createCarPose());
      const cb = two.carHitting(world.traffic, vb, tick, scratch2, two.createCarPose());
      if ((ca === null) !== (cb === null)) { bad++; continue; }
      if (ca === null || cb === null) continue;
      one.applyCarHit(va, ca);
      two.applyCarHit(vb, cb);
      compared++;
      if (
        va.body.velocity.x !== vb.body.velocity.x ||
        va.body.velocity.y !== vb.body.velocity.y ||
        va.body.velocity.z !== vb.body.velocity.z ||
        va.health !== vb.health ||
        va.phaseT !== vb.phaseT
      ) bad++;
      if (compared >= 200) break;
    }
    check(
      bad === 0 && compared > 0,
      `${compared} car knockbacks reproduce bit-identically across two module instances`,
    );
  }
}

/**
 * The people on the footpaths, off the real world files.
 *
 * `checkTraffic`'s shape and `checkTraffic`'s argument, because the two features
 * are the same design over the same sidecar -- and one of the claims here is
 * *stronger* than the traffic's. A car that this client and that server disagree
 * about costs a mispredicted shove that `net/client.ts` absorbs. A **pedestrian**
 * they disagree about is somebody you are about to be charged with assaulting who
 * was never standing there: the pass that follows this one turns a ped-hit into a
 * crime on a server-authoritative channel, and the only thing that will make that
 * possible with no pedestrian state on the wire is that both ends can evaluate
 * `posePedestrian(key, tick)` and get the same bits. So that is what this asserts,
 * over ten thousand ticks and two genuinely separate module instances.
 *
 * The rest is what the crowd is *for*: that the density is lively rather than
 * either empty or a mob, that nobody is walking on the road, that a struck
 * pedestrian's downtime and their resumption are a pure function of the two
 * numbers the wire would carry, and that evaluating a couple of hundred walkers
 * costs a fraction of a millisecond -- the proxy for the client's 2 ms budget.
 */
/**
 * The shared clock, in ticks. `traffic.trafficTick`, restated rather than
 * imported so this check pulls in exactly one module under test -- see the
 * two-instance argument in `checkPedestrians`, where importing the real one
 * would mean a third copy of the traffic module in the process.
 */
function pedTick(): number {
  return Math.floor((Date.now() - 1767225600000) * (60 / 1000));
}

async function checkPedestrians(): Promise<void> {
  const here = new URL('../client/src/game/pedestrians.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/game/pedestrians.ts');
  const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/game/pedestrians.ts');

  check(
    one.posePedestrian !== two.posePedestrian,
    'the two pedestrian module instances really are separate (their exports are different objects)',
  );

  // The module's own synthetic checks, through both instances -- the offset
  // sign, the churn, the knockdown and the density arithmetic. Cheap, and it is
  // what makes a failure here say *which* half broke before the world is opened.
  for (const [label, mod] of [['instance 1', one], ['instance 2', two]] as const) {
    const f = mod.verifyPedestrians();
    check(f.length === 0, `verifyPedestrians passes on ${label}` + (f.length ? ` -- ${f[0]}` : ''));
  }

  const root = new URL('../client/public/world', import.meta.url).pathname;
  let world;
  try {
    world = await loadWorld(root);
  } catch (err) {
    say(`  note: could not open the world at ${root} (${String(err)}) -- skipping the pedestrian checks.`);
    return;
  }
  // The ways block, out of the field the traffic already decoded -- one fetch,
  // one decode, two consumers, exactly as `streamer.loadTile` does it on the
  // client. Adopted as a single tile because the server holds the whole world
  // resident and the bands carry their own world coordinates.
  const ways = world.traffic.ways();
  if (ways.length === 0) {
    say('  note: this world has no lane graph in it -- skipping the pedestrian checks.');
    return;
  }
  const fieldA = new one.PedestrianField();
  const fieldB = new two.PedestrianField();
  fieldA.adopt('world', { ways, routes: [] });
  fieldB.adopt('world', { ways, routes: [] });
  const bandsA = fieldA.bands();
  const bandsB = fieldB.bands();
  say(
    `  world: ${ways.length.toLocaleString()} way spans -> ${bandsA.length.toLocaleString()} footpath ` +
      `bands, ${fieldA.slotCount.toLocaleString()} scheduled walkers`,
  );
  check(bandsA.length > 1000, `the built extent carries ${bandsA.length.toLocaleString()} footpath bands`);
  check(
    bandsA.length === bandsB.length,
    `both module instances derived the same ${bandsA.length.toLocaleString()} bands from the same bytes`,
  );

  // --- NOBODY IS WALKING ON THE ROAD.
  //
  // The check with no picture, run against the real city rather than against the
  // synthetic way `verifyPedestrians` uses: every band's offset from its own
  // centreline must clear the kerb. Measured back off the *band*, because the
  // way it came from is the only thing that knows where the centreline was.
  {
    let checked = 0;
    let inside = 0;
    let worst = Infinity;
    for (const way of ways) {
      if (!(way.footpathWidth > 0)) continue;
      const kerb = way.halfWidth + one.KERB_WIDTH;
      const band = bandsA.find((b) => b.osmId === way.osmId && b.x[0] !== way.x[0]);
      if (band === undefined) continue;
      // Perpendicular distance from the way's first point to the band's, which
      // for the first vertex is exactly the offset that was applied.
      const dx = band.x[0] - way.x[0];
      const dz = band.z[0] - way.z[0];
      const off = Math.sqrt(dx * dx + dz * dz);
      checked++;
      if (off <= kerb) inside++;
      if (off - kerb < worst) worst = off - kerb;
      if (checked >= 4000) break;
    }
    check(
      inside === 0 && checked > 0,
      `${checked.toLocaleString()} real footpath bands are all outside their own kerb line ` +
        `(closest clears it by ${worst.toFixed(3)} m)`,
    );
  }

  // --- DETERMINISM, over ten thousand ticks and a hundred bands.
  //
  // `!==` on the doubles, not a tolerance. The claim is that two processes
  // produce the same *bits*; a check that allowed a millimetre would pass a
  // schedule that had begun to drift, and a millimetre is the difference
  // between a swing landing and missing.
  {
    const a = one.createPedPose();
    const b = two.createPedPose();
    const step = Math.max(1, Math.floor(bandsA.length / 100));
    let compared = 0;
    let live = 0;
    let firstBad = -1;
    outer: for (let tick = 0; tick < 10000; tick += 7) {
      const now = tick / 60;
      for (let i = 0; i < bandsA.length; i += step) {
        for (let slot = 0; slot < bandsA[i].slots; slot++) {
          const liveA = one.posePedestrian(bandsA[i], slot, now, undefined, a);
          const liveB = two.posePedestrian(bandsB[i], slot, now, undefined, b);
          compared++;
          if (liveA !== liveB) {
            firstBad = tick;
            break outer;
          }
          if (!liveA) continue;
          live++;
          if (
            a.x !== b.x || a.y !== b.y || a.z !== b.z ||
            a.dx !== b.dx || a.dz !== b.dz ||
            a.key !== b.key || a.kit !== b.kit || a.speed !== b.speed || a.along !== b.along
          ) {
            firstBad = tick;
            break outer;
          }
        }
      }
    }
    check(
      firstBad < 0,
      `${Math.ceil(bandsA.length / step)} bands are bit-identical across two module instances over ` +
        `10,000 ticks (${compared.toLocaleString()} lookups, ${live.toLocaleString()} people walking)` +
        (firstBad >= 0 ? ` -- first divergence at tick ${firstBad}` : ''),
    );
  }

  // --- DENSITY. The brief's own number -- lively, not crowded -- measured where
  // the game is actually played rather than on a synthetic block.
  {
    const scratch: Array<(typeof bandsA)[number]> = [];
    const pose = one.createPedPose();
    const tick = pedTick();
    const probes: Array<[string, number, number]> = [
      ['the CBD', 0, 0],
      ['Surry Hills', 600, 1400],
      ['Newtown', -1400, 2200],
      ['Redfern', 200, 2200],
    ];
    let lively = 0;
    const readout: string[] = [];
    for (const [name, x, z] of probes) {
      let total = 0;
      let peak = 0;
      const samples = 24;
      for (let i = 0; i < samples; i++) {
        const n = one.countPedestriansNear(fieldA, x, z, 120, tick + i * 977, scratch, pose);
        total += n;
        if (n > peak) peak = n;
      }
      const mean = total / samples;
      readout.push(`${name} ${mean.toFixed(1)}`);
      if (mean >= 8 && mean <= 30) lively++;
    }
    check(
      lively === probes.length,
      `every probe holds a lively-not-crowded footpath inside 120 m -- mean people: ${readout.join(', ')}`,
    );
  }

  // --- BEING CLOBBERED, on a real walker on a real footpath.
  //
  // The two claims the police pass rests on. The **downtime** is a pure function
  // of the walker's key and the tick, so a server that is told only those two
  // numbers can reconstruct the whole event; and **getting up is continuous**,
  // so the schedule offset is doing its job and a knocked-over pedestrian does
  // not teleport when they stand. Both are asserted across the two instances,
  // because the point is that two processes agree, not that one is repeatable.
  {
    const band = bandsA.find((b) => b.slots > 0);
    const bandTwo = bandsB[bandsA.indexOf(band!)];
    const before = one.createPedPose();
    const during = one.createPedPose();
    const after = one.createPedPose();
    const mirror = two.createPedPose();
    let tick = -1;
    for (let t = 0; t < 20000; t += 11) {
      if (one.posePedestrian(band!, 0, t / 60, undefined, before)) {
        tick = t;
        break;
      }
    }
    if (tick < 0) {
      check(false, 'no walker was ever present on a real footpath band; the knockdown check could not run');
    } else {
      const key = one.pedKey(band!.osmId, band!.side, 0);
      const secondsA = one.downSeconds(key, tick);
      const secondsB = two.downSeconds(key, tick);
      check(
        secondsA === secondsB,
        `a knockdown's downtime is bit-identical across two instances (${secondsA.toFixed(9)} s), ` +
          'so a server told only (key, tick) reconstructs the whole event',
      );
      check(
        secondsA >= one.DOWN_MIN && secondsA <= one.DOWN_MIN + one.DOWN_SPAN,
        `it is inside the ${one.DOWN_MIN}-${one.DOWN_MIN + one.DOWN_SPAN} s band`,
      );

      const now = tick / 60;
      const recA = fieldA.knockDown(key, tick, now);
      const recB = fieldB.knockDown(key, tick, now);
      check(recA !== null && recB !== null, 'a standing pedestrian on a real footpath can be knocked over');
      check(
        fieldA.knockDown(key, tick + 30, now + 0.5) === null,
        'somebody already lying on the footpath cannot be knocked over again -- the re-hit guard',
      );

      one.posePedestrian(band!, 0, now + secondsA * 0.5, recA!, during);
      check(
        during.down && during.x === before.x && during.z === before.z,
        'a pedestrian halfway through their downtime is reported down and has not moved a millimetre',
      );

      one.posePedestrian(band!, 0, recA!.upAt, recA!, after);
      two.posePedestrian(bandTwo, 0, recB!.upAt, recB!, mirror);
      const moved = Math.abs(after.x - before.x) + Math.abs(after.z - before.z);
      check(
        !after.down && moved < 1e-9,
        `they stand up exactly where they fell (${moved.toExponential(1)} m of drift) and walk on -- ` +
          'the schedule offset, which is the whole of how a stateless walker resumes',
      );
      check(
        after.x === mirror.x && after.z === mirror.z && after.dx === mirror.dx,
        'and both module instances put them in the same place, facing the same way',
      );
      fieldA.clearDowns();
      fieldB.clearDowns();
    }
  }

  // --- BUDGET. The proxy for the client's 2 ms, measured rather than asserted.
  //
  // Two hundred walkers is a little over three times what the densest ground in
  // the city puts inside the far draw radius, and the client's frame does this
  // once. Bun's JavaScriptCore is not the browser's V8 and this is a proxy
  // rather than a measurement of the real thing -- what it catches is the class
  // of regression that makes a lookup an order of magnitude slower, which is the
  // only kind that could threaten the budget.
  {
    const scratch: Array<(typeof bandsA)[number]> = [];
    const pose = one.createPedPose();
    // Warm, then measure. The first pass through a cold `PedestrianField.near`
    // builds the bucket grid for thirteen thousand bands, which is a one-off.
    for (let i = 0; i < 50; i++) one.countPedestriansNear(fieldA, 0, 0, 200, i, scratch, pose);
    let evaluated = 0;
    const runs = 400;
    const at = performance.now();
    for (let i = 0; i < runs; i++) {
      evaluated += one.countPedestriansNear(fieldA, 0, 0, 260, i * 37, scratch, pose);
    }
    const perQuery = (performance.now() - at) / runs;
    const perQueryFor200 = evaluated > 0 ? (perQuery * 200) / (evaluated / runs) : perQuery;
    check(
      perQueryFor200 < 1,
      `evaluating 200 walkers' positions costs ${perQueryFor200.toFixed(3)} ms in Bun ` +
        `(measured ${(evaluated / runs).toFixed(0)} people per 260 m query at ${perQuery.toFixed(3)} ms)`,
    );
  }

  // --- THE SEAM the police pass will subscribe to. It exists, it fires, and it
  // carries the two numbers that make the event reconstructible from nothing.
  {
    const seen: Array<{ key: number; tick: number; seconds: number; cause: string }> = [];
    const off = one.onPedestrianStruck((hit) => {
      seen.push({ key: hit.key, tick: hit.tick, seconds: hit.seconds, cause: hit.cause });
    });
    const scratch: Array<(typeof bandsA)[number]> = [];
    const pose = one.createPedPose();
    // Stand a combatant on top of a real walker and swing.
    const tick = pedTick();
    let placed = false;
    one.forEachPedestrianNear(fieldA, 0, 0, 400, tick, scratch, pose, (p) => {
      const attacker = createCombatant(7, 0, 0);
      // A metre behind them, looking at their back -- the same geometry
      // `sydney.pedestrianReport().standHere` hands a tester.
      attacker.body.position.set(p.x - p.dx, p.y + EYE_HEIGHT, p.z - p.dz);
      attacker.body.yaw = Math.atan2(-p.dx, -p.dz);
      attacker.body.pitch = 0;
      const hit = one.strikePedestrian(fieldA, attacker, tick, scratch, one.createPedPose());
      if (hit === null) return;
      placed = true;
      return true;
    });
    off();

    // And the football, which reaches the crowd by a different route: swept
    // against the same capsule with the same `combat.segmentDistance` the ball's
    // own step uses against a player, so a throw that would have hit somebody
    // hits a pedestrian standing in the same place. Aimed by construction --
    // a ball put one tick upstream of a real walker, flying at them.
    fieldA.clearDowns();
    let ballHit = false;
    const seenBall: string[] = [];
    const offBall = one.onPedestrianStruck((h) => seenBall.push(h.cause));
    one.forEachPedestrianNear(fieldA, 0, 0, 400, tick, scratch, pose, (p) => {
      // `footy.LAUNCH_SPEED` is 28 m/s; one tick of that is 0.47 m. Put the ball
      // at chest height half a tick past them, travelling along their back.
      const dt = 1 / 60;
      const chest = p.y + 1.0;
      const ball = {
        x: p.x + p.dx * 0.2, y: chest, z: p.z + p.dz * 0.2,
        vx: p.dx * 28, vy: 0, vz: p.dz * 28,
        thrower: 7,
      };
      if (one.strikePedestrianWithBall(fieldA, ball, 0.105, dt, tick, scratch, one.createPedPose()) === null) return;
      ballHit = true;
      return true;
    });
    offBall();

    check(placed && seen.length === 1, `a bat swing at a real pedestrian landed and fired the seam once (${seen.length} events)`);
    check(
      ballHit && seenBall.length === 1 && seenBall[0] === 'footy',
      `a football swept through a real pedestrian knocked them over and fired the seam with cause 'footy' ` +
        `(${seenBall.length} events)`,
    );
    if (seen.length === 1) {
      check(
        seen[0].seconds === one.downSeconds(seen[0].key, seen[0].tick) && seen[0].cause === 'bat',
        'the event carries a (key, tick) from which the downtime -- and every other term -- is recoverable',
      );
      // And the unsubscribe works, which is the half a leak hides in.
      const beforeCount = seen.length;
      one.clearPedestrianListeners();
      check(seen.length === beforeCount, 'unsubscribing stopped the listener');
    }
    fieldA.clearDowns();
  }
}

await main();

/**
 * The police, and the faction framework they are the first user of.
 *
 * Everything below is a **server-authoritative** claim, and that is the whole
 * reason this check exists separately from `verifyPolice`: that function proves
 * the arithmetic is right in isolation, and every one of its assertions would
 * still hold if the server never ran the witness test at all. What this proves
 * is the path -- a swing lands, the server re-runs the geometry against its own
 * bands, an officer with a clear view opens an investigation, four more are
 * promoted, one shoots, and the player loses exactly half a pip.
 *
 * The failures it exists for, none of which throws and none of which has a frame
 * that says so:
 *
 *   - **A witness test that is not deterministic across processes.** A browser
 *     that believed it was seen and a server that did not is a banner that
 *     flickers on and off; the other way round is being shot at by police who,
 *     on your own screen, are facing away. The two-instance run below is the
 *     same claim `checkFooty` and `checkTraffic` make about their own schedules.
 *   - **A crime that only exists because a client said so.** The client is never
 *     asked here: the probe sends a button, and the ped strike, the witness and
 *     the investigation are all re-derived from a body the server is simulating.
 *   - **A countdown that never ends, or one that cannot be extended.** Both read
 *     as "the police feel wrong" and neither is visible from one frame.
 *   - **Damage that a client can dodge or fake.** A client that stops sending
 *     inputs must still be shot; a client that sends anything at all must not be
 *     able to hurt itself or anybody else through this path.
 *   - **An NPC section that does not round-trip**, which draws officers at
 *     plausible coordinates in impossible states.
 *   - **A stale client accepted onto a v7 server**, which is a silently
 *     misparsed snapshot rather than a refusal it can print.
 */
async function checkPolice(): Promise<void> {
  say('police: the faction framework, server-authoritative, against the world files');

  const here = new URL('../client/src/game/factions.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/game/factions.ts');
  const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/game/factions.ts');
  check(one.policeWitness !== two.policeWitness, 'the two faction module instances really are separate');

  for (const [label, mod] of [['instance 1', one], ['instance 2', two]] as const) {
    const f = mod.verifyPolice(undefined, SNAPSHOT_INTERVAL);
    check(f.length === 0, `verifyPolice passes on ${label}` + (f.length ? ` -- ${f[0]}` : ''));
  }

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);

  // --- 1. The station table lands on the built city.
  //
  // Not just inside the radius, which `verifyPolice` already asserts without a
  // world file, but on a **tile that exists and carries footpath bands**: a
  // station whose catchment holds no band schedules nobody at all, and the
  // symptom is a command that silently contributes no officers.
  {
    const size = world.index.tile_size;
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const built = builtGate(world);
    let offMap = 0;
    let bandless = 0;
    let judged = 0;
    let skipped = 0;
    const scratch: Parameters<typeof one.forEachPoliceNear>[5] = [];
    for (const station of one.POLICE_STATIONS) {
      if (!built(station.x, station.z)) {
        skipped++;
        continue;
      }
      judged++;
      const key = `${Math.floor(station.x / size)}_${Math.floor(-station.z / size)}`;
      if (!keys.has(key)) offMap++;
      if (world.peds.near(station.x, station.z, one.catchment(station), scratch).length === 0) bandless++;
    }
    check(offMap === 0, `all ${judged} police stations are on a built tile (${offMap} were not)${builtNote(world, skipped)}`);
    check(bandless === 0, `every station's catchment holds footpath bands to walk (${bandless} held none)`);
    say(
      `  world: ${one.POLICE_STATIONS.length} stations, ` +
        `${one.POLICE_STATIONS.reduce((n, s) => n + one.beatPairs(s), 0)} pairs on the beat, ` +
        `catchments ${one.CATCHMENT_MIN}-${one.CATCHMENT_MAX} m`,
    );
  }

  // --- 2. The beats are the same beats in a second process.
  //
  // The real claim behind "zero-wire ambient placement": a browser that placed
  // an officer somewhere else would draw a pair strolling down a street the
  // server has empty, and would predict the wrong answer to every witness
  // question. Nothing corrects this, because nothing about an ambient officer is
  // ever sent.
  {
    const fieldA = new one.FactionField();
    const fieldB = new two.FactionField();
    void fieldA;
    void fieldB;
    const bandsA: Parameters<typeof one.forEachPoliceNear>[5] = [];
    const bandsB: Parameters<typeof two.forEachPoliceNear>[5] = [];
    const pedA = createPedPose();
    const pedB = createPedPose();
    const beatA = one.createBeatPose();
    const beatB = two.createBeatPose();

    let compared = 0;
    let mismatched = 0;
    let posed = 0;
    for (const station of one.POLICE_STATIONS) {
      for (let t = 0; t < 12; t++) {
        // Spread over half an hour of schedule, so the comparison covers
        // traversals, dwells and direction flips rather than one instant.
        const tick = 1_000_000 + t * 9000;
        const a: string[] = [];
        const b: string[] = [];
        one.forEachPoliceNear(world.peds, station.x, station.z, 400, tick, bandsA, pedA, beatA, (p) => {
          a.push(`${p.key}:${p.x.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}`);
        });
        two.forEachPoliceNear(world.peds, station.x, station.z, 400, tick, bandsB, pedB, beatB, (p) => {
          b.push(`${p.key}:${p.x.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}`);
        });
        posed += a.length;
        compared++;
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) mismatched++;
      }
    }
    check(
      posed > 100,
      `the beats actually place people: ${posed} officer-poses across ${compared} station-ticks`,
    );
    check(
      mismatched === 0,
      `every one of those ${compared} station-ticks is bit-identical across two module instances ` +
        `(${mismatched} differed)`,
    );
  }

  // --- 3. Officers walk on the footpath, in pairs, and are not pedestrians.
  {
    const bands: Parameters<typeof one.forEachPoliceNear>[5] = [];
    const ped = createPedPose();
    const beat = one.createBeatPose();
    let pairs = 0;
    let loners = 0;
    let worstGap = 0;
    const byLeader = new Map<number, number>();
    const station = one.POLICE_STATIONS[0];
    // Officers are tested against the query radius **individually**, which is
    // correct -- `policeWitness` wants everybody inside 40 m of the crime, not
    // everybody whose partner is -- and it means a pair straddling the rim
    // arrives as one officer. That is not a broken pair, it is a pair the query
    // cut in half, and with `forEachPatrolNear`'s lattice there are now enough
    // people out at 900 m for it to happen every run.
    //
    // So the tally decides on the **leader** and the partner inherits it. A
    // radius margin was the first attempt and does not close it: wherever the
    // cut is placed, some pair straddles that instead. The pair is the unit
    // being counted, so the pair has to be admitted or rejected as one -- and
    // the poses arrive leader-then-partner for a key, which is the iteration
    // order `forEachPoliceNear` documents.
    let admit = false;
    one.forEachPoliceNear(world.peds, station.x, station.z, 900, 1_000_000, bands, ped, beat, (p) => {
      if (p.partner === 0) admit = Math.hypot(p.x - station.x, p.z - station.z) <= 900 - one.PAIR_OFFSET;
      if (!admit) return;
      // The pair share a leader key; `BeatPose.key` is `pedKey * 2 + partner`.
      const leader = Math.floor(p.key / 2);
      byLeader.set(leader, (byLeader.get(leader) ?? 0) + 1);
    });
    for (const n of byLeader.values()) {
      if (n === 2) pairs++;
      else loners++;
    }
    check(pairs > 0 && loners === 0, `every officer on this beat is in a pair (${pairs} pairs, ${loners} on their own)`);

    // And the pair really is together, rather than two people on one street.
    {
      const seen = new Map<number, { x: number; z: number }>();
      one.forEachPoliceNear(world.peds, station.x, station.z, 900, 1_000_000, bands, ped, beat, (p) => {
        const leader = Math.floor(p.key / 2);
        const first = seen.get(leader);
        if (first === undefined) seen.set(leader, { x: p.x, z: p.z });
        else worstGap = Math.max(worstGap, Math.hypot(p.x - first.x, p.z - first.z));
      });
      check(worstGap > 0.1 && worstGap < 2, `the two officers of a pair are ${worstGap.toFixed(2)} m apart`);
    }

    // The reserved slots cannot collide with a walker's identity, which is the
    // whole basis of ambient placement costing nothing.
    check(
      one.POLICE_SLOT_BASE >= 40 && one.POLICE_SLOT_BASE + one.POLICE_SLOT_SPAN <= 64,
      `police walk slots ${one.POLICE_SLOT_BASE}..${one.POLICE_SLOT_BASE + one.POLICE_SLOT_SPAN - 1}, ` +
        'clear of the 0..39 a pedestrian can occupy and inside the 6 bits pedKey packs',
    );
  }

  // --- 4. The line of sight, against the real city.
  //
  // A synthetic wall is what `verifyPolice` tests. This is the same ray over
  // real prisms, and the property being asserted is the one a synthetic test
  // cannot reach: that it is **symmetric** and that it actually *blocks*
  // something in a city made mostly of buildings. A ray that returned false
  // everywhere would pass every synthetic test that only checks the true case.
  {
    let blocked = 0;
    let clear = 0;
    let asymmetric = 0;
    const probe = groundFor(world);
    for (let i = 0; i < 400; i++) {
      // A deterministic spread over the CBD rather than a random one, so a
      // failure is reproducible.
      const a = (i / 400) * Math.PI * 2;
      const x = Math.cos(a) * (200 + (i % 37) * 20);
      const z = Math.sin(a) * (200 + (i % 41) * 20);
      const y = probe.groundHeight(x, z, -Infinity) + 1.6;
      const tx = x + Math.cos(a * 3) * 35;
      const tz = z + Math.sin(a * 3) * 35;
      const ty = probe.groundHeight(tx, tz, -Infinity) + 1.1;
      const there = world.collision.blocked(x, y, z, tx, ty, tz);
      const back = world.collision.blocked(tx, ty, tz, x, y, z);
      if (there !== back) asymmetric++;
      if (there) blocked++;
      else clear++;
    }
    check(asymmetric === 0, `the line of sight is symmetric over 400 real sight lines (${asymmetric} were not)`);
    check(
      blocked > 20 && clear > 20,
      `${blocked} of 400 real 35 m sight lines are blocked by a building and ${clear} are clear -- ` +
        'the ray discriminates rather than answering one way everywhere',
    );
  }

  // --- 5..N. The whole path, through a real `Simulation`, with no socket and no
  //     client claim anywhere in it.
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const probeWorld = groundFor(world);

  /**
   * Find a crime waiting to happen: a bystander, a spot to swing at them from,
   * and an officer on a beat with a clear view of it.
   *
   * Searched rather than constructed, and searched **in one pass rather than
   * two**, which is the whole reason this is a function. The beats and the crowd
   * are both pure functions of the wall-clock tick, so an officer found at one
   * instant and a pedestrian found at the next are two facts about two different
   * moments -- and the first version of this check did exactly that and passed
   * or failed depending on what time of day it was run at. Everything below is
   * evaluated at one tick and the witness test is re-run at that same tick, so
   * what it returns is a scene that is true rather than one that was.
   *
   * It walks every station rather than stopping at the first, because a station
   * whose officers are in the dwell between traversals has nobody on the
   * footpath at that instant, which is correct behaviour and would otherwise be
   * an intermittent failure.
   */
  const findScene = (
    tick: number,
  ): { standX: number; standZ: number; yaw: number; ox: number; oz: number; key: number } | null => {
    const beatBands: Parameters<typeof one.forEachPoliceNear>[5] = [];
    const beatPed = createPedPose();
    const beat = one.createBeatPose();
    const crowdBands: PedBand[] = [];
    const crowdPose = createPedPose();
    // A **second** crowd, off the same ways block, purely to rehearse the swing
    // on. `strikePedestrian` knocks its victim over, so dry-running it against
    // the field the server is about to use would put the bystander on the ground
    // before the real swing and the real one would find nobody. `checkPedestrians`
    // builds its fields the same way, from `TrafficField.ways()`.
    const rehearsal = new PedestrianField();
    rehearsal.adopt('world', { ways: world.traffic.ways(), routes: [] });
    const rehearsalBands: PedBand[] = [];
    const rehearsalPose = createPedPose();
    const witnessCtx = {
      peds: world.peds,
      collision: world.collision,
      field: null,
      bands: [] as PedBand[],
      ped: createPedPose(),
      beat: one.createBeatPose(),
    };
    const witness = one.createWitness();
    // Scratch for the prosecutability test below. Its own, rather than the beat
    // scan's: that one is mid-iteration when this runs, and handing a callback
    // the array its caller is walking is how a scan quietly loses half its
    // officers.
    const pursuitBands: PedBand[] = [];
    const pursuitPed = createPedPose();
    const pursuitBeat = one.createBeatPose();
    let found: { standX: number; standZ: number; yaw: number; ox: number; oz: number; key: number } | null = null;

    for (const station of one.POLICE_STATIONS) {
      if (found) break;
      one.forEachPoliceNear(world.peds, station.x, station.z, 900, tick, beatBands, beatPed, beat, (officer) => {
        if (found) return true;
        const ox = officer.x;
        const oz = officer.z;
        forEachPedestrianNear(world.peds, ox, oz, one.WITNESS_RANGE - 8, tick, crowdBands, crowdPose, (p) => {
          if (found) return true;
          if (p.down) return;
          const standX = p.x - p.dx;
          const standZ = p.z - p.dz;
          const ground = probeWorld.groundHeight(standX, standZ, -Infinity);
          if (!Number.isFinite(ground)) return;

          // **Rehearse the swing.** The geometry of a bat against a capsule is
          // `combat.ts`'s and depends on the ground under the attacker as well as
          // on the footpath under the victim -- a kerb between them is 13 cm of
          // difference and the two are not always the same surface. Asserting on
          // a scene that merely looks right is what made the first version of
          // this check pass or fail depending on the time of day it ran at.
          const rehearsalActor = createCombatant(99, standX, standZ);
          rehearsalActor.body.position.set(standX, ground + EYE_HEIGHT, standZ);
          rehearsalActor.body.yaw = Math.atan2(-p.dx, -p.dz);
          rehearsalActor.body.pitch = 0;
          if (
            strikePedestrian(rehearsal, rehearsalActor, tick, rehearsalBands, rehearsalPose) === null
          ) {
            return;
          }
          // And the witness, through the real query at the real tick.
          if (!one.policeWitness(p.x, p.z, tick, witnessCtx, witness).seen) return;

          // --- And **a pursuit that can prosecute**, which is the half this
          //     used to leave to luck and is the whole of the flake below it.
          //
          // A witness is all sections 5 needs: somebody saw it, the
          // investigation opens. Sections 6 and 7 need something the witness
          // test does not imply -- officers who can *reach and see* the suspect
          // once they are promoted. `POLICE.think` walks straight at its target
          // and slides off buildings, and `factions.walkToward` says in as many
          // words that there is no pathfinding and deliberately never will be:
          // *"what a wall-sliding pursuer does when it loses you is stand at the
          // wall, which is exactly what the countdown is for."*
          //
          // So a scene whose promoted officers all start on the far side of a
          // block is a scene where the correct behaviour is that nobody ever
          // fires -- and section 7, which waits 25 s for a shot, reads that as
          // the shot model being broken. Measured over 45 pinned wall-clock
          // phases, that is exactly what the two failures were: `before` at 79
          // and 96 m with **all four** officers' sight lines blocked, pursuing
          // correctly and stalled against a terrace.
          //
          // The set tested here is the set `FactionField.recruit` will actually
          // promote -- the first `PURSUIT_TARGET` officers inside
          // `PROMOTE_RADIUS`, in `forEachPoliceNear`'s own iteration order --
          // and the requirement is that at least two of them can see the crime
          // spot **and are close enough to reach it inside section 7's clock**.
          //
          // Two rather than one because a single clear officer is one unlucky
          // corner away from being none, and rather than four because demanding
          // a scene with no obstruction at all would reject most of the real
          // CBD, which is a city made of buildings.
          //
          // The distance half is the second cut and it is arithmetic rather than
          // taste: section 7 waits 25 s for a round. An officer closes at
          // `CHASE_SPEED` and then spends `AIM_TICKS` with the weapon up, so
          // from the far edge of `PROMOTE_RADIUS` that is 120 m of running --
          // nineteen seconds before the first shot, against a budget of
          // twenty-five, with a crowd and a kerb in the way. Scenes like that
          // are not wrong, they are simply too tight to measure a shot model
          // through, and they are where the residual failures sat. Half the
          // promote radius leaves the pursuit about five seconds of running and
          // twenty seconds of margin.
          const reach = one.PROMOTE_RADIUS / 2;
          let considered = 0;
          let withSight = 0;
          one.forEachPoliceNear(
            world.peds, standX, standZ, one.PROMOTE_RADIUS, tick,
            pursuitBands, pursuitPed, pursuitBeat,
            (o) => {
              if (considered >= one.PURSUIT_TARGET) return true;
              considered++;
              const dx = o.x - standX;
              const dz = o.z - standZ;
              if (dx * dx + dz * dz > reach * reach) return;
              if (!world.collision.blocked(o.x, o.y + EYE_HEIGHT, o.z, standX, ground + one.CRIME_HEIGHT, standZ)) {
                withSight++;
              }
            },
          );
          if (withSight < 2) return;

          found = { standX, standZ, yaw: rehearsalActor.body.yaw, ox, oz, key: p.key };
          return true;
        });
        return found !== null;
      });
    }
    return found;
  };

  const suspect = sim.join(0, null, 'Bazza');
  const place = (x: number, z: number, yaw: number): void => {
    suspect.combat.body.position.set(x, probeWorld.groundHeight(x, z, -Infinity) + EYE_HEIGHT, z);
    suspect.combat.body.velocity.set(0, 0, 0);
    suspect.combat.body.yaw = yaw;
    suspect.combat.body.pitch = 0;
    // **And on the input**, which is the one that actually decides.
    //
    // `combat.advance` takes the look direction off the input packet every tick
    // -- that is the whole shape of `protocol.INPUT_BYTES`, which carries a yaw
    // and no position -- so a body yaw assigned here is overwritten before the
    // swing is adjudicated, and the bat comes round facing due north. Writing
    // both is what a client actually does; writing only the body is a test
    // aiming at something the server never saw it aim at.
    suspect.input.yaw = yaw;
    suspect.input.pitch = 0;
  };
  check(sim.investigations().length === 0, 'a player who has done nothing is not under investigation');

  // --- 5. A bat swing that downs a bystander in front of police is a crime,
  //     decided here, with the client contributing one button.
  //
  // The probe never says anything about the pedestrian, the officer or the hit.
  // It sends `BTN.PUNCH` -- one bit -- and `Simulation.resolveStrike` re-runs the
  // identical `strikePedestrian` the browser runs against its own bands at its
  // own tick, then asks its own `policeWitness`. That is the claim.
  const firstScene = findScene(trafficTick(Date.now()));
  if (!firstScene) {
    check(false, 'a bystander in view of an officer on a beat could be found somewhere in the city');
    return;
  }
  // Non-null from here, and reassignable: the swing retry below re-finds it.
  let scene = firstScene;
  {
    place(scene.standX, scene.standZ, scene.yaw);
    say(
      `  scene: swinging at (${scene.standX.toFixed(0)}, ${scene.standZ.toFixed(0)}) with an officer ` +
        `${Math.hypot(scene.ox - scene.standX, scene.oz - scene.standZ).toFixed(0)} m away and a clear view`,
    );

    /**
     * Stay behind the bystander, wherever they have got to.
     *
     * A swing is 150 ms of wind-up before its active window opens, and a
     * `Simulation.step` over 371 tiles is not free -- so twenty ticks of this
     * loop can be **a second of wall time**, and the pedestrian schedule is
     * denominated in wall time. A walker at 1.3 m/s covers 1.3 m in that second,
     * which is past the 1.55 m reach from a metre behind them. That is not a bug
     * in anything: it is a check standing still while the city keeps moving, and
     * it is what made the first three versions of this pass or fail depending on
     * how loaded the machine was.
     *
     * So the probe follows them, which is also what a player does.
     */
    const follow = (): boolean => {
      const tick = trafficTick(Date.now());
      const bands: PedBand[] = [];
      const pose = createPedPose();
      let moved = false;
      forEachPedestrianNear(world.peds, suspect.combat.body.position.x, suspect.combat.body.position.z, 12, tick, bands, pose, (p) => {
        if (p.key !== scene.key) return;
        place(p.x - p.dx, p.z - p.dz, Math.atan2(-p.dx, -p.dz));
        moved = true;
        return true;
      });
      return moved;
    };

    /**
     * Swing, and swing again if the bat missed. **Three attempts, not one.**
     *
     * The old shape staked the entire cluster on a single swing connecting: one
     * `BTN.PUNCH`, twenty-four ticks, and if the bystander stepped off the kerb
     * or turned a corner inside the wind-up there was no crime, no
     * investigation, no pursuit and no shot -- so sections 5, 6 and 7 all failed
     * together and read as the police being broken. It is a real miss: the
     * bystander is a `posePedestrian` schedule denominated in wall time and the
     * probe is chasing it through a `Simulation.step` that is not free.
     *
     * A player who missed would swing again, so this does. Nothing about the
     * claim changes -- the assertion is still that batting a bystander in front
     * of police is a crime, decided on the server off one bit of client input.
     * What changes is that the check no longer needs the first bat of the run to
     * land, which was never part of the claim.
     *
     * The scene is re-found between attempts because by then it is a second
     * older, and `findScene` returns a scene that is true rather than one that
     * was -- which is the whole reason it exists.
     */
    /**
     * Is somebody watching **this spot, right now**, with room to spare?
     *
     * The race this closes, and it is the root of the whole cluster. `findScene`
     * verifies a witness at the tick it stages, and the bat is adjudicated some
     * ticks later -- eight of wind-up at the very least, and more while the
     * probe chases a walker through a `Simulation.step` that costs real
     * milliseconds. Officers are `posePedestrian` slots denominated in **wall
     * time**, so in that gap they keep walking: around a corner, behind a
     * delivery van, or simply past the 40 m their sight is good for. The crime
     * then lands with nobody watching, `resolveStrike` opens no investigation,
     * and every assertion after it fails trivially -- which is exactly the shape
     * the gate reported: *"opened an investigation for "suspicious behaviour"
     * (0 entries)"*, then no countdown, no promotion, no officers, no shot.
     *
     * It is neither a wrong instrument nor a hole in the sim: an officer who
     * walked away really did not see it. It is a stage-then-drift race, so the
     * answer is to stop staging and then hoping -- swing on a tick when the
     * witness query says yes, through the same `policeWitness` the server will
     * ask, at the same wall tick.
     *
     * The margin is what makes it hold rather than merely usually hold. A
     * witness at 39.5 m satisfies the query and is one step from not; requiring
     * the nearest watcher to be inside four fifths of `WITNESS_RANGE` leaves 8 m
     * of walking -- about five seconds at a beat's pace -- for a swing that
     * needs a fraction of one.
     *
     * `field: null` because this is a question about the **beat**: at this point
     * nobody has been promoted, and an ambient officer is what the crime has to
     * be seen by. It is the same context `findScene` builds for the same reason.
     */
    const swingWitnessCtx = {
      peds: world.peds,
      collision: world.collision,
      field: null,
      bands: [] as PedBand[],
      ped: createPedPose(),
      beat: one.createBeatPose(),
    };
    const swingWitness = one.createWitness();
    const liveBands: PedBand[] = [];
    const livePed = createPedPose();
    const liveBeat = one.createBeatPose();

    /**
     * Is the whole scene true **right now** -- a watcher with margin, and a
     * pursuit that can prosecute?
     *
     * Both halves are re-asked here rather than trusted from `findScene`, and
     * the second half is why: officers walk. `findScene` vets the four officers
     * `recruit` would promote *at staging time*, and the swing lands a second or
     * two of wall clock later, by which point the set has moved and can have
     * moved behind a building. Measured under an emulated slow box, that is
     * exactly the residue -- a crime that landed, was witnessed, and was
     * answered by two officers 77 m away with both sight lines blocked, which
     * section 7 then read as the shot model failing.
     *
     * So the two questions the later sections depend on are asked on the tick
     * the bat comes up, which is the only tick at which their answers matter.
     */
    const sceneIsLive = (): boolean => {
      const p = suspect.combat.body.position;
      const tick = trafficTick(Date.now());
      const w = one.policeWitness(p.x, p.z, tick, swingWitnessCtx, swingWitness);
      if (!w.seen || w.range > one.WITNESS_RANGE * 0.8) return false;
      // `body.position` is the **eye**, so the chest the sight line aims at is
      // that much lower plus `CRIME_HEIGHT` -- the same two heights the sim's
      // own witness ray uses.
      const chest = p.y - EYE_HEIGHT + one.CRIME_HEIGHT;
      const reach = one.PROMOTE_RADIUS / 2;
      let considered = 0;
      let withSight = 0;
      one.forEachPoliceNear(world.peds, p.x, p.z, one.PROMOTE_RADIUS, tick, liveBands, livePed, liveBeat, (o) => {
        if (considered >= one.PURSUIT_TARGET) return true;
        considered++;
        const dx = o.x - p.x;
        const dz = o.z - p.z;
        if (dx * dx + dz * dz > reach * reach) return;
        if (!world.collision.blocked(o.x, o.y + one.WITNESS_EYE, o.z, p.x, chest, p.z)) withSight++;
      });
      return withSight >= 2;
    };

    let tracked = 0;
    let swings = 0;
    let waited = 0;
    let wanted = sim.investigations();
    while (swings < 3 && wanted.length === 0) {
      if (swings > 0) {
        const again = findScene(trafficTick(Date.now()));
        if (again) scene = again;
        place(scene.standX, scene.standZ, scene.yaw);
        // Long enough for the stamina bar to come back and the swing clock to
        // clear, so the second attempt is a swing rather than a refused one.
        for (let i = 0; i < 30; i++) sim.step(out);
      }
      // --- Wait for the moment before lifting the bat. See `sceneIsLive`.
      //
      // Following the bystander throughout, so the probe is still behind them
      // when it comes. Two seconds of beat schedule; if the city has not
      // obliged by then the swing goes ahead anyway and the retry covers it,
      // because a check that could hang waiting for Sydney to cooperate would be
      // worse than one that occasionally misses.
      for (let i = 0; i < 120 && !sceneIsLive(); i++) {
        if (follow()) tracked++;
        sim.step(out);
        waited++;
      }
      // --- And then swing, and keep swinging.
      //
      // A bat is 1.55 m of reach against a walker who is still walking, and it
      // misses sometimes -- observed under load as three staged crimes in a row
      // where the bystander was never knocked down at all while an officer stood
      // watching the whole time. That is not the police failing and it is not
      // the witness race; it is a melee miss, and a player who missed would
      // simply swing again.
      //
      // Four swings, which is `MAX_STAMINA`, spaced a whole `PUNCH_TOTAL` apart
      // so each is a swing rather than a press refused mid-recovery. The loop
      // stops the moment an investigation exists, so a scene that works costs
      // one swing.
      for (let s = 0; s < MAX_STAMINA && sim.investigations().length === 0; s++) {
        swings++;
        suspect.input.punch = true;
        // The button is released after the first tick, because a held punch
        // would empty the stamina bar -- which is spec 8.2's behaviour and not
        // what this is measuring.
        for (let i = 0; i < PUNCH_TICKS; i++) {
          if (follow()) tracked++;
          sim.step(out);
          suspect.input.punch = false;
        }
      }
      wanted = sim.investigations();
    }
    check(
      tracked > 0,
      `the bystander stayed findable for ${tracked} of ${swings * PUNCH_TICKS + waited} ticks while the ` +
        `swing came round (${swings} swing(s)` +
        (waited > 0 ? `, ${waited} tick(s) waiting for an officer to be watching` : '') + ')',
    );
    check(
      wanted.length === 1 && wanted[0].playerId === suspect.id && wanted[0].reason === one.REASON.ASSAULT,
      'batting a bystander in front of police opened an investigation for ' +
        `"${one.reasonText(wanted[0]?.reason ?? 0)}" (${wanted.length} entries)`,
    );
    check(
      (wanted[0]?.ticks ?? 0) > one.COUNTDOWN_TICKS - 120,
      `the countdown started at about ${((wanted[0]?.ticks ?? 0) / 60).toFixed(0)} s (the rule is 45)`,
    );
  }

  /**
   * Step, holding the scenario open. **Sections 6 and 7 are measured through
   * this rather than through `sim.step` directly, and it is the fix to a flake
   * that fired because the police work.**
   *
   * `Simulation.shoot` ends an investigation the moment its subject goes down:
   * *"Being shot by the police is the countdown's other terminal state, and a
   * banner that survived a respawn would have the player wanted for something
   * they were already punished for."* That is correct, and it is a state
   * section 6 cannot survive -- with the investigation gone, every pursuing
   * officer takes `POLICE.think`'s stand-down branch on its next tick, walks
   * back toward where it was promoted, and despawns on arrival. A promoted
   * officer that has not moved far is already inside the 2 m despawn radius,
   * so the whole squad can be gone inside twenty ticks.
   *
   * The symptom is precisely the two failures on the gate: `after` is empty, so
   * section 6 reports *"the nearest officer went from 21.8 m to Infinity"*, and
   * section 7 then waits its full 25 s for a shot at somebody who is not wanted
   * and not there. Observed on a pinned-clock sweep as `inv=GONE` with **2,623
   * ticks still on the countdown** -- which no expiry could produce.
   *
   * Neither section is about the suspect's health. Section 6 is about officers
   * converging and section 7 is about the size and authority of a round, so the
   * probe is held on its feet and wanted for exactly as long as it takes to
   * measure those. Section 7 lets go the instant it starts counting damage --
   * see there.
   */
  const holdScenario = (): void => {
    if (suspect.combat.health < MAX_HEALTH) suspect.combat.health = MAX_HEALTH;
    if (!sim.factions.investigationOf(suspect.id)) {
      sim.factions.accuse(suspect.id, one.REASON.ASSAULT, trafficTick(Date.now()));
    }
  };

  // --- 6. Officers are promoted onto the suspect, and they come from the beat.
  {
    for (let i = 0; i < 60; i++) {
      holdScenario();
      sim.step(out);
    }
    // **Filtered to the police**, which this did not have to do when it was
    // written and does now.
    //
    // `FactionField.actors` is shared by every faction -- that is the whole
    // point of the framework -- so a snapshot taken on a CBD footpath holds
    // whatever else the other factions have woken: a meth head on the corner, a
    // magpie on its nest over the street. Neither is a fault and neither is
    // this check's subject, so it asks its question about the officers and
    // reports the rest. The claim that used to be "every promoted actor is
    // police" is now "the promoted police are police, and there are some",
    // which is the thing section 6 was ever actually about.
    const all = sim.npcSnapshot();
    const actors = all.filter((a) => a.kind === one.NPC_KIND.POLICE);
    const others = all.length - actors.length;
    check(
      actors.length > 0 && all.length <= one.MAX_ACTORS,
      `${actors.length} officers were promoted onto the suspect (the cap is ${one.MAX_ACTORS} across every faction` +
        (others ? `, and ${others} other actor(s) were awake beside them` : '') + ')',
    );
    check(
      actors.every((a) => a.kind === one.NPC_KIND.POLICE) && actors.length > 0,
      'every officer dispatched carries the police kind byte',
    );
    // And they are actually converging, rather than standing where they were
    // promoted. Measured over a second of ticks against the distance to the
    // suspect, which is the only thing that distinguishes a pursuit from a
    // spawn.
    const before = actors.map((a) => Math.hypot(a.x - suspect.combat.body.position.x, a.z - suspect.combat.body.position.z));
    for (let i = 0; i < 60; i++) {
      holdScenario();
      sim.step(out);
    }
    const after = sim
      .npcSnapshot()
      .filter((a) => a.kind === one.NPC_KIND.POLICE)
      .map((a) => Math.hypot(a.x - suspect.combat.body.position.x, a.z - suspect.combat.body.position.z));
    // Closed, **or** stopped inside the engage range, which is the same
    // behaviour seen at two distances: an officer runs at you until 35 m and
    // then stands and aims. A check that demanded monotonic closing would fail
    // on a correct pursuit that had already arrived.
    const near = Math.min(...after);
    const closed = before.length > 0 && after.length > 0 && (near <= Math.min(...before) + 0.01 || near <= ENGAGE_RANGE + 0.5);
    check(
      closed,
      `the nearest officer went from ${Math.min(...before).toFixed(1)} m to ${near.toFixed(1)} m ` +
        `(they close to the ${ENGAGE_RANGE} m engage range and then stand)`,
    );
  }

  // --- 7. The shot: exactly half a pip, and a client cannot dodge it.
  //
  // The probe sends **nothing at all** from here on -- no input is applied and
  // no message is sent -- which is the check that matters: a client that pulls
  // its socket must still be shot at. Health is read off the server's own
  // combatant.
  {
    // The field's own monotonic counter, not a sum over the live actors.
    //
    // Summing `shotsFired` across `factions.actors` looked equivalent and is
    // not: actors are promoted and resolved between ticks, so an officer who
    // despawned takes their tally out of the sum and the per-tick delta goes
    // *negative*. `FactionField.shots` only ever increases, which is what a
    // counter of rounds fired has to do.
    const rounds = (): number => sim.factions.shots;
    let ticks = 0;
    let firedThatTick = 0;
    let lost = 0;
    // **The first tick on which a round was fired *and* health fell**, rather
    // than the first tick on which health fell at all.
    //
    // This used to be the same thing and is not any more: the suspect is
    // standing on a footpath in the middle of a city that now also contains
    // meth heads and magpies, and a quarter-pip peck landing before the first
    // shot would have this measuring somebody else's damage against the police
    // shot model -- which reads as the shot being the wrong size. Ticks where
    // nothing left a barrel are skipped; the assertion below is about a round.
    //
    // **Started from a scenario that is known to still exist**, and then left
    // alone. Section 6 may have run the probe's health down to the point where
    // `Simulation.shoot` would knock them out and close the investigation with
    // them -- see `holdScenario`, which is why it did not -- so this begins by
    // restating the two facts it depends on and nothing else: on their feet,
    // and wanted. From the first `sim.step` below, nothing touches the probe
    // again. That is the claim: a client that sends no input, and whose health
    // this check is no longer propping up, is still shot by the server.
    holdScenario();
    let health = suspect.combat.health;
    // **The countdown, not a round number.** How long a pursuit is allowed to
    // take before it has failed is a question this feature already answers:
    // `COUNTDOWN_TICKS` is how long the police are interested, and inside that
    // window they are entitled to spend as long as the city makes them.
    //
    // Twenty-five seconds was the old bound and it was an arbitrary one. The
    // sim promises that an officer with a clear line inside `ENGAGE_RANGE`
    // fires after `AIM_TICKS`; it explicitly does **not** promise a bounded
    // time to acquire that line, because `factions.walkToward` has no
    // pathfinding and says so -- a pursuer that has to come round a block takes
    // as long as the block is. Measured under an emulated slow box, honest
    // pursuits were landing their first round at 21.9 s, which passed by three
    // seconds and would not have on a slower one. Deriving the budget from the
    // countdown makes it move with the feature instead of against it.
    while (lost === 0 && ticks < one.COUNTDOWN_TICKS) {
      const before = rounds();
      sim.step(out);
      firedThatTick = rounds() - before;
      const fell = health - suspect.combat.health;
      health = suspect.combat.health;
      if (fell > 0 && firedThatTick > 0) lost = fell;
      ticks++;
    }
    check(
      lost > 0,
      `a player who sent no input at all was shot within ${(ticks / 60).toFixed(1)} s of the crime`,
    );
    // **Per round**, not per tick, and the distinction is the whole reason this
    // is measured the way it is: four officers converge, and two of them can
    // fire on the same tick and both connect. What has to be exactly half a pip
    // is a *hit*, so the assertion is that the health lost on this tick is a
    // whole number of half-pips and no more than the number of rounds that left
    // a barrel on it.
    check(
      lost % one.SHOT_DAMAGE === 0 && lost > 0 && lost <= firedThatTick * one.SHOT_DAMAGE,
      `${lost} of a pip was lost to ${firedThatTick} round(s) on one tick -- ` +
        `exactly ${one.SHOT_DAMAGE} a hit, and never more hits than shots`,
    );
    check(
      one.SHOT_DAMAGE === 0.5 && MAX_HEALTH / one.SHOT_DAMAGE === 6,
      `it takes ${MAX_HEALTH / one.SHOT_DAMAGE} hits to drop a full-health player`,
    );
    // And the arithmetic is exact rather than accumulating float residue over a
    // long firefight, which is what would leave a player alive on 1e-16 pips.
    const before = suspect.combat.health;
    for (let i = 0; i < 60 * 20 && suspect.combat.health > 0; i++) sim.step(out);
    // The **quarter**-pip grid, where this once said half.
    //
    // Same claim -- the arithmetic is exact rather than accumulating float
    // residue over a long firefight, which is what would leave a player alive
    // on 1e-16 pips -- measured against the finest damage unit in the game
    // rather than against the police's own. A bush turkey's peck and a magpie's
    // pass are a quarter of a pip each, and a suspect being shot at on a street
    // can be pecked on the same street. Half a pip is still on the quarter grid,
    // so nothing about the shot model escapes this.
    const GRID = 0.25;
    check(
      suspect.combat.health === 0 || Math.abs(suspect.combat.health / GRID - Math.round(suspect.combat.health / GRID)) < 1e-9,
      `health stays on the quarter-pip grid under sustained fire (${before} -> ${suspect.combat.health})`,
    );
  }

  // --- 8. A hacked client cannot fake a crime, and cannot fake being shot.
  //
  // `INPUT` carries a button, two axes and a look direction and nothing else --
  // see `protocol.INPUT_BYTES` -- so the adversarial case is a client that sends
  // the most it can and swings at nothing. There is no message that reaches
  // `Simulation.accuse` or `Simulation.shoot`.
  {
    const clean = sim.join(2, null, 'Ghost');
    // Somewhere with no police and no bystanders: the middle of the harbour.
    clean.combat.body.position.set(-1200, 5, -2400);
    for (let i = 0; i < 40; i++) {
      clean.input.punch = true;
      clean.input.throwBall = true;
      clean.input.mount = true;
      applyButtons(clean.input, 0xff);
      sim.step(out);
    }
    const wanted = sim.investigations().some((w) => w.playerId === clean.id);
    check(!wanted, 'a client holding every button in an empty part of the harbour is not under investigation');
    check(
      clean.combat.health === 3,
      `and is on full health -- there is no path from a packet to a shot (${clean.combat.health} pips)`,
    );
    clean.gone = true;
    sim.step(out);
  }

  // --- 9. A fresh crime extends the countdown and re-labels it.
  {
    // Put the suspect back on their feet somewhere in view, tune their bike, and
    // ride past. `bikeTuned` is set here directly because walking to Redfern is
    // a different check's job -- what this is testing is the ride-by rule.
    respawnAt(suspect.combat, scene.standX, world.terrain.height(scene.standX, scene.standZ) + EYE_HEIGHT, scene.standZ, 0);
    sim.factions.clearInvestigation(suspect.id);
    sim.step(out);

    const opened = sim.factions.accuse(suspect.id, one.REASON.ASSAULT, sim.tick);
    const first = opened.investigation.ticks;
    const again = sim.factions.accuse(suspect.id, one.REASON.ASSAULT_POLICE, sim.tick);
    check(
      again.investigation.ticks === Math.min(one.MAX_COUNTDOWN_TICKS, first + one.EXTEND_TICKS),
      `a second crime extended the countdown by ${one.EXTEND_TICKS / 60} s ` +
        `(${(first / 60).toFixed(0)} s -> ${(again.investigation.ticks / 60).toFixed(0)} s)`,
    );
    check(
      again.investigation.reason === one.REASON.ASSAULT_POLICE,
      `and re-labelled it "${one.reasonText(again.investigation.reason)}" -- the banner answers "why now"`,
    );
    // And it is capped, or a player who keeps offending is wanted forever.
    for (let i = 0; i < 40; i++) sim.factions.accuse(suspect.id, one.REASON.ASSAULT, sim.tick);
    check(
      (sim.factions.investigationOf(suspect.id)?.ticks ?? 0) <= one.MAX_COUNTDOWN_TICKS,
      `forty stacked crimes are capped at ${one.MAX_COUNTDOWN_TICKS / 60} s rather than being unbounded`,
    );
  }

  // --- 10. The tuned ride-by, which is the second crime and the one the wire
  //     already carried both halves of.
  {
    sim.factions.clearInvestigation(suspect.id);
    for (let i = 0; i < 5; i++) sim.step(out);
    // On a bike, tuned, standing where the officer can see them. Both bits are
    // the server's own -- `INPUT` cannot set either.
    suspect.combat.bikeTuned = true;
    suspect.combat.ridingBike = 1;
    place(scene.standX, scene.standZ, scene.yaw);
    let opened = false;
    for (let i = 0; i < 8 && !opened; i++) {
      sim.step(out);
      opened = sim.investigations().some((w) => w.playerId === suspect.id && w.reason === one.REASON.BIKE);
    }
    check(opened, 'riding a tuned e-bike past police opened an investigation for "riding a modified e-bike"');

    // And it does **not** re-open every tick, which would pin the countdown to
    // its cap and mean the countdown never ends.
    const held = sim.factions.investigationOf(suspect.id)?.ticks ?? 0;
    for (let i = 0; i < 120; i++) sim.step(out);
    const later = sim.factions.investigationOf(suspect.id)?.ticks ?? 0;
    check(
      later < held,
      `the countdown ran down while the offence continued (${(held / 60).toFixed(1)} s -> ` +
        `${(later / 60).toFixed(1)} s) -- the ride-by is an edge, not a level`,
    );
    suspect.combat.ridingBike = 0;
    suspect.combat.bikeTuned = false;
  }

  // --- 11. The countdown reaches zero and the police stand down.
  //
  // The user's instruction in as many words -- *"until the countdown gets to
  // 0"* -- and the one behaviour here that cannot be observed in under a minute
  // of play. The countdown is wound down to a second rather than waiting out
  // forty-five, which is the same shortcut `checkFooty` takes with a recharge.
  {
    const inv = sim.factions.investigationOf(suspect.id);
    if (inv) inv.ticks = 30;
    let ticks = 0;
    while (sim.investigations().length > 0 && ticks < 60 * 5) {
      sim.step(out);
      ticks++;
    }
    check(sim.investigations().length === 0, `the investigation ended when its countdown reached 0 (${ticks} ticks)`);

    // And the officers resolve rather than standing in the street forever.
    //
    // **Counted over the police, not over the field**, which is section 6's own
    // correction applied to the section that was missed by it. `FactionField`
    // is shared, and the probe is standing on a footpath in a city that also
    // contains meth heads, drunks and magpies: `stepStreetlife` promotes a
    // loiterer within `METH_SIGHT` of a player and a drunk within
    // `DRUNK_NOTICE`, and both of them have every right to still be standing
    // there a minute after the police went home. Asking `npcSnapshot().length`
    // and calling the answer "officers" made a correct city fail a police
    // check -- observed once in eight runs as *"1 still promoted"* -- and it is
    // the same wrong-instrument shape this whole cluster was flaky for.
    let leftPolice = 0;
    let leftOther = 0;
    for (let i = 0; i < 60 * 20; i++) {
      sim.step(out);
      const all = sim.npcSnapshot();
      leftPolice = all.filter((a) => a.kind === one.NPC_KIND.POLICE).length;
      leftOther = all.length - leftPolice;
      if (leftPolice === 0) break;
    }
    check(
      leftPolice === 0,
      `every pursuing officer stood down and despawned (${leftPolice} still promoted` +
        (leftOther ? `, beside ${leftOther} other faction actor(s) who are not this check's subject` : '') + ')',
    );
    check(
      sim.factions.actors.every((a) => a.kind !== one.NPC_KIND.POLICE),
      'and no officer is left in the field, so the wire cost of a finished pursuit is zero',
    );
  }

  // --- 12. The NPC section, at the cap, through the real encoder.
  //
  // The section is the one part of the snapshot that is *not* bounded by the
  // sixteen-player roster, so it is the one that quietly becomes the largest
  // thing on the wire. Both the round trip and the budget are asserted.
  {
    const npcs: SnapshotNpc[] = [];
    for (let i = 0; i < one.MAX_ACTORS; i++) {
      npcs.push({
        id: 1 + i * 2711,
        kind: one.NPC_KIND.POLICE,
        x: -3999.99 + i * 300.5,
        y: -70.125 + i,
        z: 3999.99 - i * 271.25,
        yaw: (i / one.MAX_ACTORS) * Math.PI * 2,
        state: i % 7,
      });
    }
    const frame = encodeSnapshot(1234, 5, [], [], npcs);
    check(
      frame.byteLength === snapshotBytes(0, 0, one.MAX_ACTORS),
      `a ${one.MAX_ACTORS}-actor snapshot is ${frame.byteLength} B, matching the layout`,
    );
    check(
      frame.byteLength <= 500,
      `the faction section at the cap is ${frame.byteLength - 10} B, inside the 500 B budget`,
    );
    const back = decodeSnapshot(frame, createSnapshot());
    let wrong = 0;
    for (let i = 0; i < npcs.length; i++) {
      const a = npcs[i];
      const b = back?.npcs[i];
      if (!b) {
        wrong++;
        continue;
      }
      if (b.id !== a.id || b.kind !== a.kind || b.state !== a.state) wrong++;
      if (Math.abs(b.x - a.x) > 0.01 || Math.abs(b.y - a.y) > 0.01 || Math.abs(b.z - a.z) > 0.01) wrong++;
    }
    check(wrong === 0, `all ${npcs.length} actors round-tripped through the real encoder (${wrong} did not)`);
    // The `u16` id is the field a byte-wide one would have wrapped, which puts a
    // fresh officer onto a despawned one's interpolation history.
    const wide = decodeSnapshot(
      encodeSnapshot(1, 0, [], [], [{ id: 65535, kind: 1, x: 0, y: 0, z: 0, yaw: 0, state: 0 }]),
      createSnapshot(),
    );
    check(wide?.npcs[0]?.id === 65535, 'an actor id at the top of the u16 survives the wire');
  }

  // --- 13. The investigation channel, at the player cap.
  {
    const records: InvestigationRecord[] = [];
    for (let i = 1; i <= 16; i++) records.push({ playerId: i, reason: (i % 5) + 1, ticks: 100 * i });
    const frame = encodeInvestigations(records);
    check(
      frame.byteLength === investigationBytes(16),
      `a full-lobby investigation message is ${frame.byteLength} B (${((frame.byteLength * 8) / 2 / 1000).toFixed(2)} kbit/s at the 2 s refresh)`,
    );
    const back = decodeInvestigations(frame);
    const same = back?.length === 16 && back.every((r, i) => r.playerId === records[i].playerId && r.reason === records[i].reason && r.ticks === records[i].ticks);
    check(same === true, 'every entry round-tripped through the real encoder');
    check(
      decodeInvestigations(encodeInvestigations([]))?.length === 0,
      'an empty message decodes to an empty list -- which is how a banner comes down',
    );
  }

  // --- 14. Every reason a faction can report has a banner string, including the
  //     one nothing in this build reports.
  {
    let missing = 0;
    for (const [name, code] of Object.entries(one.REASON)) {
      if (code === one.REASON.NONE) continue;
      if (!one.REASON_TEXT[code]) {
        missing++;
        say(`  note: REASON.${name} has no string.`);
      }
    }
    check(missing === 0, 'every reason code has a banner string, including the reserved wildlife one');
    check(
      one.REASON_TEXT[one.REASON.WILDLIFE] === 'harming protected wildlife',
      `the wildlife faction's reason is reserved and complete before that faction exists ` +
        `("${one.REASON_TEXT[one.REASON.WILDLIFE]}")`,
    );
  }

  // --- 15. The framework's own contract: a consumer can register a kind, mark it
  //     police-hostile and report a crime, without touching this feature's files.
  //
  // This is the check the two agents behind this one actually depend on. It
  // registers a synthetic faction exactly as their prompts will tell them to,
  // and asserts that all three seams work from outside.
  {
    const DRUNK = two.registerNpcKind({
      kind: two.NPC_KIND.DRUNK,
      name: 'drunk',
      radius: 0.32,
      height: 1.7,
      maxHealth: 1,
      walkSpeed: 0.9,
      chaseSpeed: 3.2,
      downSeconds: 6,
      aggroClips: [],
      aggroCooldownSeconds: 9,
      feedKo: '%s got decked by a drunk',
      scoresKo: false,
      think: () => {},
    });
    check(two.npcKind(DRUNK)?.name === 'drunk', 'a consumer can register a kind byte and get it back');
    two.policeHostileTo(DRUNK);
    check(two.isPoliceHostile(DRUNK), 'and can mark it police-hostile without editing game/factions.ts');
    check(!two.isPoliceHostile(two.NPC_KIND.POLICE), 'the police are not hostile to themselves');

    // A duplicate registration on a claimed byte throws rather than silently
    // winning, which is a seagull with a gun.
    let threw = false;
    try {
      two.registerNpcKind({ ...two.npcKind(DRUNK)!, name: 'impostor' });
    } catch {
      threw = true;
    }
    check(threw, 'registering a second faction on a claimed byte is refused rather than overwriting');

    // `reportCrime` from a consumer, drained by the field's own step.
    const field = new two.FactionField();
    two.clearPendingCrimes();
    two.reportCrime(9, two.REASON.WILDLIFE);
    field.step({
      tick: 1, dt: 1 / 60, collision: null,
      groundHeight: () => 0, peds: null, combatants: [], field,
      investigationOf: (id) => field.investigationOf(id),
      damagePlayer: () => {},
      emit: () => {},
    });
    const it = field.investigationOf(9);
    check(
      it?.reason === two.REASON.WILDLIFE && it.ticks > 0,
      `reportCrime(playerId, REASON.WILDLIFE) opened an investigation for ` +
        `"${two.reasonText(it?.reason ?? 0)}" -- the whole of a consumer's dependency on the police`,
    );
    // And a crime reported against nobody is a no-op, which is how the
    // environment says "this had no author" -- the car sentinel's meaning.
    // **Nobody is -1, not 0.** Zero is the offline local player's id, and a
    // guard that treated it as absent would make every crime a consumer
    // reported in `?offline` vanish silently -- which is how this was wrong
    // for an afternoon. See `reportCrime`.
    two.reportCrime(-1, two.REASON.ASSAULT);
    field.step({
      tick: 2, dt: 1 / 60, collision: null,
      groundHeight: () => 0, peds: null, combatants: [], field,
      investigationOf: (id) => field.investigationOf(id),
      damagePlayer: () => {},
      emit: () => {},
    });
    check(field.liveInvestigations().length === 1, 'a crime reported against nobody (-1) is a no-op');
  }

  // --- 16. `strikeNpc` is the one door, with the re-hit guard on it.
  {
    const field = new one.FactionField();
    const cop = field.promote(one.NPC_KIND.POLICE, 0, 0, 0, 0, 1, -1);
    if (!cop) {
      check(false, 'an officer could be promoted for the damage check');
    } else {
      const a = one.strikeNpc(field, cop, 1, 'Bazza', 1, 100);
      check(a.landed && !a.down, `a bat took one pip off an officer (${cop.health} left of ${one.POLICE_MAX_HEALTH})`);
      const again = one.strikeNpc(field, cop, 1, 'Bazza', 1, 100);
      check(!again.landed, 'a second strike on the same tick is refused -- the re-hit guard');
      one.strikeNpc(field, cop, 1, 'Bazza', 1, 101);
      const last = one.strikeNpc(field, cop, 1, 'Bazza', 1, 102);
      check(last.down, 'the third landed strike put them on the ground');
      check(
        last.feed === 'Bazza got done by the cops'.replace('got done by the cops', 'got done by the cops') &&
          last.feed.includes('Bazza'),
        `and produced the feed line "${last.feed}"`,
      );
      check(
        one.strikeNpc(field, cop, 1, 'Bazza', 1, 103).landed === false,
        'somebody already on the ground cannot be hit again',
      );
      check(
        cop.health === one.POLICE_MAX_HEALTH,
        'a downed officer gets their pips back for when they stand up -- hardy, not immortal',
      );
    }
  }

  // --- 17. The cap, and that eviction prefers the disposable.
  {
    const field = new one.FactionField();
    for (let i = 0; i < one.MAX_ACTORS + 8; i++) {
      field.promote(one.NPC_KIND.POLICE, i, 0, 0, 0, 1, -1);
    }
    check(
      field.actors.length <= one.MAX_ACTORS,
      `promoting ${one.MAX_ACTORS + 8} actors left ${field.actors.length}, inside the ${one.MAX_ACTORS} cap`,
    );
    const ids = new Set(field.actors.map((a) => a.id));
    check(ids.size === field.actors.length, 'every live actor has a distinct id');
  }

  // --- 18. A protocol-6 client is refused cleanly rather than misparsed.
  //
  // The case a version bump exists for, and it is a real one: a browser tab left
  // open across this deploy sends a v6 hello. What must not happen is that it
  // parses far enough to be welcomed onto a wire whose snapshot header is a byte
  // longer, which is a client drawing the ball section as player flags.
  {
    const stale = new ArrayBuffer(5);
    const v = new DataView(stale);
    v.setUint8(0, MSG.HELLO);
    v.setUint16(1, 6, true);
    v.setUint8(3, 255);
    v.setUint8(4, 0);
    const decoded = decodeHello(stale);
    check(
      decoded?.version === 6,
      `a protocol-6 hello still decodes to version ${decoded?.version} so it can be refused by version`,
    );
    check(decoded?.version !== PROTOCOL_VERSION, 'and is not mistaken for a current one');
    // And the header really did grow, which is why v6 had to be refused at all.
    check(
      snapshotBytes(1, 0, 0) !== 9 + 21,
      `the v7 snapshot header carries an actor count, so a v6 decoder reads ${9 + 21} B where there are ` +
        `${snapshotBytes(1)} -- every field after the player count would be shifted`,
    );
  }

  // --- 19. **The police exist where a player actually is.**
  //
  // The check this feature shipped without, and the reason it shipped broken.
  // Everything above asserts that the police *work*: that a crime is witnessed,
  // that a pursuit closes, that a shot is half a pip. Not one of them asserts
  // that there is an officer anywhere near the place sixteen players out of
  // sixteen begin the game, and the answer -- measured, before any of this
  // section existed -- was **zero officers within 600 m of the spawn**, zero for
  // the first six hundred metres of a walk up King Street, and zero marked cars
  // on any road in the inner south. The report was "I never saw any police".
  //
  // So this is the presence check, and it is written from the spawn outward
  // rather than from a station outward, because a station is where the feature
  // was already known to work.
  {
    const spawn = world.spawn;
    const bands: Parameters<typeof one.forEachPoliceNear>[5] = [];
    const ped = createPedPose();
    const beat = one.createBeatPose();

    // The radius is `PATROL_CELL` rather than a number, and that is the whole
    // point of it: the lattice puts `PATROL_BASE_PAIRS` on every stretch of
    // footpath in every cell, so within one cell's width of anywhere a player
    // can stand there has to be at least that many. Retuning the cell or the
    // floor moves this assertion with it instead of breaking it.
    const radius = one.PATROL_CELL;
    const want = one.PATROL_BASE_PAIRS * 2;
    let worst = Infinity;
    let worstTick = 0;
    // Two minutes of schedule. A beat is a `posePedestrian` slot and spends part
    // of its cycle in the dwell between traversals, so a single tick proves
    // nothing -- what is being asserted is that the *floor* holds, not that it
    // held once.
    for (let t = 0; t < 240; t++) {
      const tick = 1_000_000 + t * 30;
      let n = 0;
      one.forEachPoliceNear(world.peds, spawn.x, spawn.z, radius, tick, bands, ped, beat, () => {
        n++;
      });
      if (n < worst) {
        worst = n;
        worstTick = t * 30;
      }
    }
    check(
      worst >= want,
      `the spawn disc centre has at least ${want} ambient officers within ${radius} m at every one of ` +
        `240 ticks (worst was ${worst}, at +${worstTick}) -- before the lattice it was 0 at 600 m`,
    );

    // And they are patrols rather than a station's beat, which is the claim the
    // lattice actually makes: the nearest command is Newtown, 1.5 km away with a
    // 416 m catchment, so every one of these is somebody the beats could not
    // have provided.
    {
      let patrols = 0;
      let beats = 0;
      one.forEachPoliceNear(world.peds, spawn.x, spawn.z, radius, 1_000_000, bands, ped, beat, (p) => {
        if (p.station < 0) patrols++;
        else beats++;
      });
      const nearest = one.nearestStation(spawn.x, spawn.z);
      const away = nearest ? Math.hypot(nearest.x - spawn.x, nearest.z - spawn.z) : Infinity;
      check(
        patrols > 0 && beats === 0,
        `all ${patrols} of them are lattice patrols and none is a station beat -- the nearest command is ` +
          `${nearest?.name} at ${away.toFixed(0)} m with a ${nearest ? one.catchment(nearest).toFixed(0) : '?'} m catchment`,
      );
    }

    // --- Every officer is somebody. A key claimed twice is two pairs standing
    // inside each other sharing one rig, which at a glance is one pair and in
    // the witness query is a double count. `patrolBands`' band ownership and
    // `forEachPatrolNear`'s slot stepping both exist to make this impossible,
    // and both of them were added *because* this measured 8 duplicates of 58.
    {
      let dupes = 0;
      let total = 0;
      for (const at of [spawn, one.POLICE_STATIONS[0], one.POLICE_STATIONS[one.POLICE_STATIONS.length - 1]]) {
        const seen = new Set<number>();
        one.forEachPoliceNear(world.peds, at.x, at.z, 900, 1_000_000, bands, ped, beat, (p) => {
          total++;
          if (seen.has(p.key)) dupes++;
          seen.add(p.key);
        });
      }
      check(dupes === 0, `no officer identity is claimed twice across ${total} poses at three places (${dupes} were)`);
    }

    // --- The lattice is the same lattice in a second process, which is the
    // whole basis of it costing zero bytes. `forEachPoliceNear`'s station half
    // is already asserted this way above; this is its other half, and it has an
    // extra hazard -- the band pool is keyed on a cell index and filtered by
    // *midpoint ownership*, so a rounding difference at a cell boundary would
    // hand one process a street the other one does not have.
    {
      const bandsB: Parameters<typeof two.forEachPatrolNear>[5] = [];
      const pedB = createPedPose();
      const beatB = two.createBeatPose();
      let compared = 0;
      let mismatched = 0;
      let posed = 0;
      for (const at of [spawn, one.POLICE_STATIONS[0], one.POLICE_STATIONS[6]]) {
        for (let t = 0; t < 8; t++) {
          const tick = 1_000_000 + t * 9000;
          const a: string[] = [];
          const b: string[] = [];
          one.forEachPatrolNear(world.peds, at.x, at.z, 500, tick, bands, ped, beat, (p) => {
            a.push(`${p.key}:${p.x.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}`);
          });
          two.forEachPatrolNear(world.peds, at.x, at.z, 500, tick, bandsB, pedB, beatB, (p) => {
            b.push(`${p.key}:${p.x.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}`);
          });
          posed += a.length;
          compared++;
          if (a.length !== b.length || a.some((v, i) => v !== b[i])) mismatched++;
        }
      }
      check(posed > 50, `the lattice places people: ${posed} patrol poses across ${compared} place-ticks`);
      check(mismatched === 0, `every one of those ${compared} place-ticks is bit-identical across two module instances`);
    }

    // --- A marked car passes the spawn. The brief's own number: within 300 m,
    // over a three-minute window.
    //
    // A *window* rather than an instant, because that is the thing a player
    // experiences -- traffic is a baked timetable and the question is how often
    // one drives past, not how many are parked in view. Sampled twice a second
    // so nothing crosses the circle between samples: the fastest car covers
    // about eight metres in that.
    {
      const routes: LaneRoute[] = [];
      const pose = createCarPose();
      const passing = new Set<string>();
      const all = new Set<string>();
      for (let t = 0; t < 360; t++) {
        forEachCarNear(world.traffic, spawn.x, spawn.z, 300, 1_000_000 + t * 30, routes, pose, (p) => {
          const id = `${p.route}:${p.slot}`;
          all.add(id);
          if (one.policeLiveried(p.route, p.slot, p.x, p.z)) passing.add(id);
        });
      }
      check(
        passing.size >= 1,
        `${passing.size} police-liveried car(s) passed within 300 m of the spawn over 3 minutes ` +
          `(of ${all.size} cars) -- before the citywide floor it was 0 of ${all.size}`,
      );
    }

    // --- And the city is still a city: the Cross is not Mosman.
    //
    // The failure this whole section could easily have caused. A floor that
    // covered the map by making everywhere equally policed would have answered
    // the complaint by deleting the thing that makes walking across Sydney mean
    // anything, so the gradient is asserted at the two ends the user named --
    // measured density, not the weight table, because the table was never the
    // thing in doubt.
    {
      const density = (x: number, z: number): number => {
        let n = 0;
        for (let t = 0; t < 40; t++) {
          one.forEachPoliceNear(world.peds, x, z, 180, 1_000_000 + t * 600, bands, ped, beat, () => {
            n++;
          });
        }
        return n / 40;
      };
      const kx = one.POLICE_STATIONS.find((s) => s.name === 'Kings Cross')!;
      const mos = one.POLICE_STATIONS.find((s) => s.name === 'Mosman')!;
      const atKx = density(kx.x, kx.z);
      const atMos = density(mos.x, mos.z);
      check(
        atKx > atMos * 1.5,
        `Kings Cross holds ${atKx.toFixed(1)} officers within 180 m and Mosman ${atMos.toFixed(1)} -- ` +
          'the lattice raised the floor without flattening the curve',
      );
      // The spawn is measured at `PATROL_CELL` rather than at the 180 m draw
      // radius the two stations use, and the difference is the ground rather
      // than the tuning: the disc centre is in the **middle of Sydney Park**,
      // where the nearest footpath is a couple of hundred metres away in every
      // direction. Asking how many officers are within 180 m of a point on
      // grass is asking whether there is a beat on the grass, and the answer
      // should be no. What has to be true is that walking off the park in any
      // direction meets one, which is what a cell's width measures.
      const atSpawn = (() => {
        let n = 0;
        for (let t = 0; t < 40; t++) {
          one.forEachPoliceNear(world.peds, spawn.x, spawn.z, one.PATROL_CELL, 1_000_000 + t * 600, bands, ped, beat, () => {
            n++;
          });
        }
        return n / 40;
      })();
      check(
        atSpawn > 0 && atSpawn < atKx,
        `and the spawn, inside no catchment at all, holds ${atSpawn.toFixed(1)} officers within ` +
          `${one.PATROL_CELL} m -- present, and still lighter than the Cross (it held 0 within 600 m)`,
      );
    }

    // --- The starvation rescue. Every station puts somebody on a footpath.
    //
    // `bandless === 0` above asserts that a catchment *contains* bands; this
    // asserts the thing that actually matters, which is that officers are
    // **posed** from it. The two come apart exactly where `CATCHMENT_RESCUE_MAX`
    // exists for: a station whose own streets are footway-mapped, or one near
    // the edge of a resident set, has a catchment that holds nothing and would
    // silently contribute nobody.
    {
      let silent = 0;
      let judged = 0;
      let skipped = 0;
      const built = builtGate(world);
      const names: string[] = [];
      for (const station of one.POLICE_STATIONS) {
        if (!built(station.x, station.z)) {
          skipped++;
          continue;
        }
        judged++;
        let n = 0;
        for (let t = 0; t < 8 && n === 0; t++) {
          one.forEachPoliceNear(world.peds, station.x, station.z, 900, 1_000_000 + t * 9000, bands, ped, beat, (p) => {
            if (p.station >= 0 && one.POLICE_STATIONS[p.station] === station) n++;
          });
        }
        if (n === 0) {
          silent++;
          names.push(station.name);
        }
      }
      check(
        silent === 0,
        `all ${judged} stations put officers on a real footpath` +
          (silent ? ` -- ${names.join(', ')} posed nobody` : '') +
          builtNote(world, skipped),
      );
    }
  }
}

/**
 * The two street factions -- meth heads and drunks -- against the real world
 * files and the real server.
 *
 * Self-contained and appended after every check that was here before it, on
 * `checkPolice`'s own arrangement and for the same reason: this is a consumer of
 * that framework rather than a change to it, so nothing above needs to know it
 * exists.
 *
 * What is actually being claimed, and why each one needs a *world* rather than
 * arithmetic (`verifyStreetlife` already covers the arithmetic, and is run here
 * first so a failure lands on the smaller test):
 *
 *   1. **The anchors are on the built city.** Fifty-eight suburb centroids and
 *      four hundred and twenty-two pub coordinates were baked out of the OSM
 *      extract; a coordinate on a tile that does not exist, or on one with no
 *      footpath bands, contributes nobody at all and the symptom is "the meth
 *      heads feel thin in the east", which reads as tuning.
 *   2. **Ambient placement is the same in two processes.** The whole basis of an
 *      ambient tier costing zero bytes -- a browser that placed a loiterer
 *      somewhere else would draw somebody the server has standing elsewhere, and
 *      nothing corrects it because nothing about an ambient actor is ever sent.
 *      Tested against two pedestrian fields built from the same ways in
 *      **opposite order**, which is the real hazard: `PedestrianField.near`
 *      returns bands in whatever order its grid buckets hold them, which on a
 *      browser is streaming order and on the server is `Promise.all` completion
 *      order.
 *   3. **Sight aggro, at the specified radius and not through a wall.**
 *   4. **Proximity aggro, at the specified radius, and the de-aggro after it.**
 *   5. **The crime rule, server-side.** Batting a *passive* drunk in front of an
 *      officer opens an investigation; batting one who is already swinging at
 *      you does not, and neither does batting a meth head. This is the one
 *      behaviour in the feature a player can be wronged by, and the one a client
 *      must not be able to claim anything about.
 *   6. **`policeHostileTo` actually engages.** A cop walks over, the drunk goes
 *      down, the cop resumes.
 *   7. **Eviction under a full field.** The 24-actor cap is shared with the
 *      police and with whatever lands next.
 */
async function checkStreetlife(): Promise<void> {
  say('street: meth heads and drunks, server-authoritative, against the real world files');

  const facHere = new URL('../client/src/game/factions.ts', import.meta.url).pathname;
  const stHere = new URL('../client/src/game/streetlife.ts', import.meta.url).pathname;
  const fac = (await import(facHere)) as typeof import('../client/src/game/factions.ts');
  const st = (await import(stHere)) as typeof import('../client/src/game/streetlife.ts');

  // --- 0. The arithmetic half, so a failure lands on the smaller test first.
  {
    const f = st.verifyStreetlife();
    check(f.length === 0, 'verifyStreetlife passes' + (f.length ? ` -- ${f[0]}` : ''));
  }

  // --- 1. Both kinds are registered on the bytes `factions.ts` reserved, and a
  //     second claim on one of them is refused rather than silently taking it.
  //
  // The failure this guards against has no frame that says so: two factions on
  // one byte is a client looking up the wrong capsule, the wrong feed line and
  // the wrong render hooks for every actor of that kind on the wire.
  {
    check(st.METHHEAD === fac.NPC_KIND.METHHEAD, `the meth head holds the reserved byte ${fac.NPC_KIND.METHHEAD}`);
    check(st.DRUNK === fac.NPC_KIND.DRUNK, `the drunk holds the reserved byte ${fac.NPC_KIND.DRUNK}`);
    check(fac.npcKind(fac.NPC_KIND.METHHEAD)?.name === 'meth head', 'and the framework can look the meth head up by byte');
    check(fac.npcKind(fac.NPC_KIND.DRUNK)?.name === 'drunk', 'and the drunk');
    let refused = false;
    try {
      fac.registerNpcKind({
        kind: fac.NPC_KIND.DRUNK,
        name: 'impostor',
        radius: 0.3, height: 1.7, maxHealth: 1, walkSpeed: 1, chaseSpeed: 1, downSeconds: 1,
        aggroClips: [], aggroCooldownSeconds: 1, feedKo: '%s', scoresKo: false,
        think() {},
      });
    } catch {
      refused = true;
    }
    check(refused, 'a second registration on an already-claimed byte throws rather than overwriting it');
    check(fac.isPoliceHostile(fac.NPC_KIND.DRUNK), 'importing the faction pointed the police at drunks -- policeHostileTo, at module load');
    check(!fac.isPoliceHostile(fac.NPC_KIND.METHHEAD), 'and not at meth heads, who are the player`s problem rather than the law`s');
  }

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const probeWorld = groundFor(world);

  // --- 2. Both anchor tables land on the built city.
  {
    const size = world.index.tile_size;
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const built = builtGate(world);
    const scratch: PedBand[] = [];
    let subOff = 0;
    let subBandless = 0;
    let subSkipped = 0;
    let populated = 0;
    for (const s of st.SUBURBS) {
      if (st.methLoiterers(s) === 0) continue;
      if (!built(s.x, s.z)) {
        subSkipped++;
        continue;
      }
      populated++;
      if (!keys.has(`${Math.floor(s.x / size)}_${Math.floor(-s.z / size)}`)) subOff++;
      if (world.peds.near(s.x, s.z, st.methSpread(s), scratch).length === 0) subBandless++;
    }
    check(subOff === 0, `all ${populated} suburbs that carry meth heads are on a built tile (${subOff} were not)${builtNote(world, subSkipped)}`);
    check(subBandless === 0, `every one of them has footpaths to loiter on (${subBandless} had none)`);

    let venueOff = 0;
    let venueBandless = 0;
    let withDrunks = 0;
    let drunkTotal = 0;
    let venueSkipped = 0;
    for (let v = 0; v < st.VENUE_COUNT; v++) {
      const n = st.venueDrunks(v);
      if (n === 0) continue;
      const x = st.VENUE_XZ[v * 2];
      const z = st.VENUE_XZ[v * 2 + 1];
      if (!built(x, z)) {
        venueSkipped++;
        continue;
      }
      withDrunks++;
      drunkTotal += n;
      if (!keys.has(`${Math.floor(x / size)}_${Math.floor(-z / size)}`)) venueOff++;
      if (world.peds.near(x, z, 45, scratch).length === 0) venueBandless++;
    }
    check(venueOff === 0, `all ${withDrunks} pubs that carry a drunk are on a built tile (${venueOff} were not)${builtNote(world, venueSkipped)}`);
    // A handful of venues genuinely have no band inside 45 m -- a bar inside a
    // shopping centre, a pub on a road the pipeline gives no footpath. They
    // contribute nobody, which is correct; what would be wrong is most of them.
    check(
      venueBandless < withDrunks * 0.15,
      `${venueBandless} of ${withDrunks} pubs have no footpath within 45 m (under 15% is expected: ` +
        'a bar inside a shopping centre has no frontage)',
    );
    say(
      `  world: ${st.SUBURBS.length} suburbs (${populated} carrying meth heads), ` +
        `${st.VENUE_COUNT} pubs and bars, ${withDrunks} of them carrying ${drunkTotal} drunks`,
    );
  }

  // --- 3. The weights are the user's, read off the city rather than the table.
  //
  // Asserted against *placement* rather than against the numbers, because the
  // numbers are already `verifyStreetlife`'s and this is the thing that can be
  // true in the table and false in the world.
  {
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();
    const countNear = (x: number, z: number, r: number, tick: number): number => {
      let n = 0;
      st.forEachMethheadNear(world.peds, x, z, r, tick, bands, pose, () => {
        n++;
      });
      return n;
    };
    const tick = 1_000_000;
    const redfern = st.SUBURBS.find((s) => s.name === 'Redfern')!;
    const mosman = st.SUBURBS.find((s) => s.name === 'Mosman')!;
    const inRedfern = countNear(redfern.x, redfern.z, 400, tick);
    const inMosman = countNear(mosman.x, mosman.z, 400, tick);
    check(inRedfern > 0, `Redfern has ${inRedfern} meth heads loitering inside 400 m`);
    check(inMosman === 0, `Mosman has ${inMosman} -- the harbour side is light, which is the brief`);
    check(inRedfern > inMosman, 'and the weighting runs the way the user described it');
  }

  // --- 4. Ambient placement is bit-identical in a second process.
  //
  // The two fields hold the **same bands in the opposite order**, which is the
  // hazard rather than a synthetic one: `near` returns bands in whatever order
  // its grid buckets happen to hold them, and that order is streaming order on a
  // browser and `Promise.all` completion order on the server. A placement that
  // sorted its candidates incompletely would pass a same-order comparison and
  // fail here.
  {
    const ways = world.traffic.ways();
    const chunk = Math.max(1, Math.ceil(ways.length / 4));
    const parts: (typeof ways)[] = [];
    for (let i = 0; i < ways.length; i += chunk) parts.push(ways.slice(i, i + chunk));
    const fieldA = new PedestrianField();
    const fieldB = new PedestrianField();
    for (let i = 0; i < parts.length; i++) fieldA.adopt(`p${i}`, { ways: parts[i], routes: [] });
    for (let i = parts.length - 1; i >= 0; i--) fieldB.adopt(`p${i}`, { ways: parts[i], routes: [] });

    const bandsA: PedBand[] = [];
    const bandsB: PedBand[] = [];
    const poseA = st.createStreetPose();
    const poseB = st.createStreetPose();
    const render = (p: typeof poseA): string =>
      `${p.key}:${p.x.toFixed(6)}:${p.y.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}:${p.look}`;

    let compared = 0;
    let mismatched = 0;
    let posed = 0;
    for (const suburb of st.SUBURBS) {
      if (st.methLoiterers(suburb) === 0) continue;
      for (let t = 0; t < 6; t++) {
        // Spread over a quarter of an hour of pacing, so the comparison covers
        // both directions of the stroke and both ends of it rather than one
        // instant.
        const tick = 1_000_000 + t * 9000;
        const a: string[] = [];
        const b: string[] = [];
        st.forEachMethheadNear(fieldA, suburb.x, suburb.z, 500, tick, bandsA, poseA, (p) => {
          a.push(render(p));
        });
        st.forEachMethheadNear(fieldB, suburb.x, suburb.z, 500, tick, bandsB, poseB, (p) => {
          b.push(render(p));
        });
        posed += a.length;
        compared++;
        if (a.length !== b.length || a.some((v, i) => v !== b[i])) mismatched++;
      }
    }
    check(posed > 100, `the suburbs actually place people: ${posed} loiterer-poses across ${compared} suburb-ticks`);
    check(
      mismatched === 0,
      `every one of those ${compared} suburb-ticks is bit-identical across two independently-built ` +
        `pedestrian fields with the tiles adopted in opposite order (${mismatched} differed)`,
    );

    let drunkCompared = 0;
    let drunkMismatched = 0;
    let drunkPosed = 0;
    for (let v = 0; v < st.VENUE_COUNT; v += 7) {
      if (st.venueDrunks(v) === 0) continue;
      const x = st.VENUE_XZ[v * 2];
      const z = st.VENUE_XZ[v * 2 + 1];
      for (let t = 0; t < 3; t++) {
        const tick = 1_000_000 + t * 7000;
        const a: string[] = [];
        const b: string[] = [];
        st.forEachDrunkNear(fieldA, x, z, 80, tick, bandsA, poseA, (p) => {
          a.push(render(p));
        });
        st.forEachDrunkNear(fieldB, x, z, 80, tick, bandsB, poseB, (p) => {
          b.push(render(p));
        });
        drunkPosed += a.length;
        drunkCompared++;
        if (a.length !== b.length || a.some((s, i) => s !== b[i])) drunkMismatched++;
      }
    }
    check(drunkPosed > 50, `the pubs actually place people: ${drunkPosed} drunk-poses across ${drunkCompared} pub-ticks`);
    check(drunkMismatched === 0, `and every one of those is bit-identical too (${drunkMismatched} differed)`);

    // And the swig, which is the one part of the idle that is a function of a
    // clock rather than of a position. A drunk who tipped their bottle at a
    // different instant on two screens would be the whole determinism claim
    // failing somewhere nobody was looking.
    let swigDiffered = 0;
    let swigUp = 0;
    for (let s = 0; s < 400; s++) {
      const now = s * 0.31;
      const a = st.swigPhase(12345, now);
      const b = st.swigPhase(12345, now);
      if (a !== b) swigDiffered++;
      if (a >= 0) swigUp++;
    }
    check(swigDiffered === 0, 'the swig cycle is a pure function of its seed and the clock');
    check(swigUp > 0 && swigUp < 400, `the bottle is up for ${((swigUp / 400) * 100).toFixed(0)}% of the cycle`);
  }

  // --- The synthetic authority, for the aggro tests.
  //
  // A real `FactionField` and the real `stepStreetlife`, over the real bands, with
  // a combatant this check moves by hand. `Simulation` is used below for the
  // crime rule -- where the whole point is that the *server* decides -- but for
  // "does a loiterer 24 m away notice you and one 30 m away not", a synthetic
  // context is the only way to stand somebody at exactly 24 m.
  type Ctx = Parameters<typeof st.stepStreetlife>[0];
  const damage: Array<{ id: number; pips: number }> = [];
  const makeCtx = (
    field: InstanceType<typeof fac.FactionField>,
    collision: Ctx['collision'],
    combatants: Ctx['combatants'],
    tick: number,
  ): Ctx => ({
    tick,
    dt: 1 / 60,
    collision,
    groundHeight: (x: number, z: number, feetY: number) => probeWorld.groundHeight(x, z, feetY),
    peds: world.peds,
    combatants,
    field,
    investigationOf: () => undefined,
    damagePlayer: (id: number, pips: number) => {
      damage.push({ id, pips });
    },
    emit: () => {},
  });
  // Stub collision, cast in: `blocked` is the only thing the sight test calls and
  // `resolve` the only thing a chase calls, and a stub is what lets "through a
  // wall" and "not through a wall" be the same scene twice rather than two scenes
  // that differ in more than the wall. The real ray over real prisms is
  // `verifyPolice`'s and `checkPolice`'s, and both are already green.
  const opaque = {
    blocked: () => true,
    resolve: (_fx: number, _fz: number, tx: number, tz: number) => ({ x: tx, z: tz, hit: false }),
  } as unknown as Ctx['collision'];
  const clear = {
    blocked: () => false,
    resolve: (_fx: number, _fz: number, tx: number, tz: number) => ({ x: tx, z: tz, hit: false }),
  } as unknown as Ctx['collision'];

  /** The first ambient meth head anywhere near a heavy suburb, at `tick`. */
  const findLoiterer = (tick: number): { x: number; y: number; z: number } | null => {
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();
    let found: { x: number; y: number; z: number } | null = null;
    for (const s of st.SUBURBS) {
      if (found) break;
      if (st.methLoiterers(s) === 0) continue;
      st.forEachMethheadNear(world.peds, s.x, s.z, 500, tick, bands, pose, (p) => {
        found = { x: p.x, y: p.y, z: p.z };
        return true;
      });
    }
    return found;
  };

  // --- 5. Sight aggro: inside the radius with a line, and never through a wall.
  {
    const tick = 2_000_000;
    const spot = findLoiterer(tick);
    if (!spot) {
      check(false, 'an ambient meth head could be found somewhere in a heavy suburb');
    } else {
      const at = (metres: number, collision: Ctx['collision']) => {
        const field = new fac.FactionField();
        const c = createCombatant(7, spot.x + metres, spot.z);
        c.body.position.set(spot.x + metres, spot.y + EYE_HEIGHT, spot.z);
        st.stepStreetlife(makeCtx(field, collision, [c], tick));
        return field.actors.filter((a) => a.kind === fac.NPC_KIND.METHHEAD);
      };

      const close = at(st.METH_SIGHT - 3, clear);
      check(
        close.length > 0,
        `a meth head ${st.METH_SIGHT - 3} m away with a clear line came at the player ` +
          `(${close.length} promoted)`,
      );
      check(
        close.every((a) => a.target === 7),
        'and is chasing the player who was seen, rather than nobody',
      );
      check(
        close.every((a) => a.state === fac.NPC_STATE.CHASE),
        'and enters the chase state on the tick they are promoted',
      );

      const far = at(st.METH_SIGHT + 12, clear);
      check(far.length === 0, `one ${(st.METH_SIGHT + 12).toFixed(0)} m away did not (${far.length} promoted)`);

      const walled = at(st.METH_SIGHT - 3, opaque);
      check(
        walled.length === 0,
        `and neither did one at ${st.METH_SIGHT - 3} m with a building in the way (${walled.length} promoted) -- ` +
          'crossing the road is a real answer to a laneway',
      );

      // The cap this faction holds itself to, which is what stops it spending the
      // shared wire budget the police also need.
      const field = new fac.FactionField();
      const many = [];
      for (let i = 0; i < 6; i++) {
        const c = createCombatant(20 + i, spot.x + 4 * i, spot.z + 4 * i);
        c.body.position.set(spot.x + 4 * i, spot.y + EYE_HEIGHT, spot.z + 4 * i);
        many.push(c);
      }
      for (let i = 0; i < 40; i++) st.stepStreetlife(makeCtx(field, clear, many, tick + i));
      const street = field.actors.filter((a) => st.isStreetKind(a.kind));
      check(
        street.length <= st.MAX_STREET_ACTORS,
        `six players in one suburb promoted ${street.length} street actors, inside this faction's own ` +
          `${st.MAX_STREET_ACTORS} of the shared ${fac.MAX_ACTORS}`,
      );
      // And the anchor guard: the same loiterer is never promoted twice, which
      // without it is a fresh meth head every tick until the cap refuses.
      const homes = new Set(street.map((a) => `${a.homeX.toFixed(3)}:${a.homeZ.toFixed(3)}`));
      check(homes.size === street.length, `every promoted actor came from a different anchor (${homes.size} of ${street.length})`);
    }
  }

  /** The first ambient drunk anywhere, at `tick`. */
  const findDrunk = (tick: number): { x: number; y: number; z: number } | null => {
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();
    let found: { x: number; y: number; z: number } | null = null;
    for (let v = 0; v < st.VENUE_COUNT && !found; v++) {
      if (st.venueDrunks(v) === 0) continue;
      st.forEachDrunkNear(world.peds, st.VENUE_XZ[v * 2], st.VENUE_XZ[v * 2 + 1], 60, tick, bands, pose, (p) => {
        found = { x: p.x, y: p.y, z: p.z };
        return true;
      });
    }
    return found;
  };

  // --- 6. Proximity aggro: promoted passive, aggro'd close, and forgotten after.
  {
    const tick = 2_000_000;
    const spot = findDrunk(tick);
    if (!spot) {
      check(false, 'an ambient drunk could be found outside some pub in the city');
    } else {
      // Just outside the notice radius: still scenery.
      {
        const field = new fac.FactionField();
        const c = createCombatant(9, spot.x + st.DRUNK_NOTICE + 6, spot.z);
        c.body.position.set(spot.x + st.DRUNK_NOTICE + 6, spot.y + EYE_HEIGHT, spot.z);
        st.stepStreetlife(makeCtx(field, clear, [c], tick));
        const drunks = field.actors.filter((a) => a.kind === fac.NPC_KIND.DRUNK);
        check(drunks.length === 0, `a drunk ${(st.DRUNK_NOTICE + 6).toFixed(0)} m away stays ambient and costs no wire`);
      }

      // Inside the notice radius and outside the personal space: a real actor,
      // hittable, and entirely peaceable. This is the state the crime rule reads,
      // and the reason the two radii are different numbers at all.
      const field = new fac.FactionField();
      const passiveAt = (spot.x + st.DRUNK_NOTICE) - 1.5;
      const c = createCombatant(9, passiveAt, spot.z);
      c.body.position.set(passiveAt, spot.y + EYE_HEIGHT, spot.z);
      for (let i = 0; i < 10; i++) {
        const ctx = makeCtx(field, clear, [c], tick + i);
        field.step(ctx);
        st.stepStreetlife(ctx);
      }
      const passive = field.actors.filter((a) => a.kind === fac.NPC_KIND.DRUNK);
      check(passive.length > 0, `a drunk ${(st.DRUNK_NOTICE - 1.5).toFixed(1)} m away is promoted (${passive.length})`);
      check(
        passive.every((a) => a.target < 0),
        'and is passive -- no target, which is what makes hitting them a crime and what makes them hittable at all',
      );
      check(
        passive.every((a) => st.strikeCrime(a) === fac.REASON.ASSAULT),
        'so the crime rule reports batting one as assaulting a bystander',
      );

      // Now walk into their personal space -- and note that they do **not** turn
      // on you instantly. The window between noticing and acting is what makes
      // the bystander half of the crime rule reachable at all; see
      // `DRUNK_REACTION_TICKS`.
      const drunk = passive[0];
      c.body.position.set(drunk.x + st.DRUNK_SNAP - 1.5, drunk.y + EYE_HEIGHT, drunk.z);
      for (let i = 0; i < 10; i++) {
        const ctx = makeCtx(field, clear, [c], tick + 20 + i);
        field.step(ctx);
        st.stepStreetlife(ctx);
      }
      check(
        drunk.target < 0,
        `ten ticks inside ${st.DRUNK_SNAP} m and they have noticed but not acted -- the window a player ` +
          'can swing at a bystander in',
      );
      check(
        st.strikeCrime(drunk) === fac.REASON.ASSAULT,
        'and hitting them in that window is still assaulting a bystander',
      );
      for (let i = 0; i < st.DRUNK_REACTION_TICKS + 20; i++) {
        const ctx = makeCtx(field, clear, [c], tick + 30 + i);
        field.step(ctx);
        st.stepStreetlife(ctx);
      }
      check(
        drunk.target === 9,
        `standing there for ${(st.DRUNK_REACTION_TICKS / 60).toFixed(2)} s made them turn on the player ` +
          `(target ${drunk.target})`,
      );
      check(
        st.strikeCrime(drunk) === fac.REASON.NONE,
        'and hitting them back is now self-defence rather than a crime',
      );

      // And the swing itself, which is what "aggressive" has to mean.
      damage.length = 0;
      c.body.position.set(drunk.x + 1.0, drunk.y + EYE_HEIGHT, drunk.z);
      for (let i = 0; i < 200; i++) {
        const ctx = makeCtx(field, clear, [c], tick + 40 + i);
        field.step(ctx);
        st.stepStreetlife(ctx);
      }
      check(damage.length > 0, `a drunk in reach swung: ${damage.length} hits over 200 ticks`);
      check(
        damage.every((d) => d.pips === st.MELEE_DAMAGE),
        `every swing is ${st.MELEE_DAMAGE} of a pip, which is the specified half`,
      );
      // The cadence, measured rather than read: 200 ticks at one every 90 is two.
      check(
        damage.length <= Math.ceil(200 / st.DRUNK_SWING_TICKS) + 1,
        `and no faster than the ${(st.DRUNK_SWING_TICKS / 60).toFixed(1)} s cadence (${damage.length} in 200 ticks)`,
      );

      // Walk away, and be forgotten -- but not instantly, which is the part that
      // stops a drunk being a yo-yo.
      c.body.position.set(drunk.x + st.DRUNK_FORGET + 8, drunk.y + EYE_HEIGHT, drunk.z);
      let stillOn = 0;
      for (let i = 0; i < st.DRUNK_FORGET_TICKS - 30; i++) {
        const ctx = makeCtx(field, clear, [c], tick + 300 + i);
        field.step(ctx);
        if (drunk.target === 9) stillOn++;
      }
      check(stillOn > 0, `past ${st.DRUNK_FORGET} m they keep coming for a while (${stillOn} ticks) rather than dropping you on a line`);
      for (let i = 0; i < 240; i++) {
        const ctx = makeCtx(field, clear, [c], tick + 700 + i);
        field.step(ctx);
      }
      check(
        drunk.target < 0,
        `and gave up after about ${(st.DRUNK_FORGET_TICKS / 60).toFixed(0)} s out of range (target ${drunk.target})`,
      );
    }
  }

  // --- 7. Damage goes through the framework's one door, with its re-hit guard.
  {
    const field = new fac.FactionField();
    const a = field.promote(fac.NPC_KIND.METHHEAD, 0, 0, 0, 0, 1, 5);
    check(a !== null, 'a meth head can be promoted through the shared field');
    if (a) {
      const first = fac.strikeNpc(field, a, 1, 'Bazza', 5, 100);
      check(first.landed && a.health === st.METH_MAX_HEALTH - 1, `a bat took one pip off (${a.health} left of ${st.METH_MAX_HEALTH})`);
      const again = fac.strikeNpc(field, a, 1, 'Bazza', 5, 100);
      check(!again.landed, 'a second strike on the same tick is refused -- the re-hit guard');
      const second = fac.strikeNpc(field, a, 1, 'Bazza', 5, 101);
      check(second.down, `the second landed strike put them down -- two hits, which is the brief`);
      check(
        second.feed === 'Bazza got rolled by a meth head',
        `and produced the feed line "${second.feed}"`,
      );
      check(a.downTicks >= st.METH_DOWN_SECONDS * 60 - 1, `for about ${st.METH_DOWN_SECONDS} s (${a.downTicks} ticks)`);
      check(!fac.strikeNpc(field, a, 1, 'Bazza', 5, 102).landed, 'and somebody already on the ground cannot be hit again');
      check(fac.npcKind(fac.NPC_KIND.METHHEAD)?.scoresKo === false, 'knocking one out credits nobody`s leaderboard row');
    }
  }

  // --- 8. Eviction under a full field, which is the shared cap doing its job.
  {
    // A field full of actors already engaged with a live player. Nothing this
    // faction asks for may displace them: a meth head that evicted a pursuer
    // would be this file spending a budget it does not own.
    //
    // The **live** part is load-bearing and is the framework's rule rather than
    // a detail of the test: `FactionField.actorPriority` scores an actor whose
    // target is not in the combatant list as low as one with no target at all --
    // the id is a stale reference and there is nothing to converge on. So the
    // field is stepped once with the combatant present, which is what fills the
    // list `promote` scores against.
    const victim = createCombatant(31, 0, 0);
    victim.body.position.set(0, EYE_HEIGHT, 0);
    const field = new fac.FactionField();
    for (let i = 0; i < fac.MAX_ACTORS; i++) {
      field.promote(fac.NPC_KIND.DRUNK, i * 0.4 + 1, 0, 0, 0, 1, 31);
    }
    check(field.actors.length === fac.MAX_ACTORS, `the field is full: ${field.actors.length} of ${fac.MAX_ACTORS}`);
    field.step(makeCtx(field, clear, [victim], 4_000_000));
    const engaged = field.actors.filter((a) => a.target === 31).length;
    check(engaged === fac.MAX_ACTORS, `all ${engaged} of them are engaged with a live player`);
    const refused = field.promote(fac.NPC_KIND.METHHEAD, 0, 0, 0, 0, 1, 31);
    check(refused === null, 'a meth head promoted into a field of actors already on somebody is refused, not admitted');
    check(field.actors.length === fac.MAX_ACTORS, 'and the cap is still exactly the cap');
    check(
      field.actors.every((x) => x.kind === fac.NPC_KIND.DRUNK),
      'with nobody evicted for it',
    );

    // And the other way: a field of officers walking home *is* displaced, because
    // an actor on its way out scores below a fresh one with a target.
    const going = new fac.FactionField();
    for (let i = 0; i < fac.MAX_ACTORS; i++) {
      const o = going.promote(fac.NPC_KIND.POLICE, i * 3, 0, 0, 0, 1, -1);
      if (o) o.state = fac.NPC_STATE.RETURN;
    }
    const admitted = going.promote(fac.NPC_KIND.METHHEAD, 0, 0, 0, 0, 1, 1);
    check(admitted !== null, 'but one promoted into a field of officers already walking home is admitted');
    check(going.actors.length === fac.MAX_ACTORS, `and the field is still ${going.actors.length}, inside the cap`);
  }

  // --- 9. `policeHostileTo` engages: a cop walks over, the drunk goes down, and
  //     the cop resumes.
  //
  // The one behaviour in this feature that belongs to neither faction: the drunks
  // say one true thing about themselves through `policeHostileTo` and the police
  // decide what to do about it. Run over a real field with a real officer rather
  // than asserted off the registration, because a hook nothing consults is
  // exactly what a registration test would pass with.
  {
    const field = new fac.FactionField();
    const victim = createCombatant(11, 0, 0);
    victim.body.position.set(0, EYE_HEIGHT, 0);
    const drunk = field.promote(fac.NPC_KIND.DRUNK, 1, 0, 0, 1, 0, 11);
    const officer = field.promote(fac.NPC_KIND.POLICE, 18, 0, 0, -1, 0, -1);
    check(drunk !== null && officer !== null, 'a drunk having a go at somebody, and an officer 18 m up the street');
    if (drunk && officer) {
      drunk.state = fac.NPC_STATE.CHASE;
      const startGap = Math.hypot(officer.x - drunk.x, officer.z - drunk.z);
      let closed = startGap;
      let downAt = -1;
      for (let i = 0; i < 900; i++) {
        const ctx = makeCtx(field, clear, [victim], 3_000_000 + i);
        field.step(ctx);
        if (officer.health > -1) closed = Math.min(closed, Math.hypot(officer.x - drunk.x, officer.z - drunk.z));
        if (downAt < 0 && drunk.state === fac.NPC_STATE.DOWN) downAt = i;
      }
      check(closed < startGap - 5, `the officer closed from ${startGap.toFixed(1)} m to ${closed.toFixed(1)} m`);
      check(downAt >= 0, `and put the drunk on the footpath after ${(downAt / 60).toFixed(1)} s`);
      // And resumed: with nobody left to move on, the officer walks back to their
      // beat and despawns rather than standing over the body forever.
      check(
        officer.health <= -1 || officer.state === fac.NPC_STATE.RETURN,
        'then went back to their beat rather than standing over them',
      );
      // The arrest is not a shooting. `NPC_STATE.FIRE` is what a client draws a
      // muzzle flash and a tracer off, and an officer who entered it here would
      // put a tracer through a bloke being moved on.
      let fired = 0;
      for (let i = 0; i < 240; i++) {
        const ctx = makeCtx(field, clear, [victim], 3_100_000 + i);
        field.step(ctx);
        if (officer.state === fac.NPC_STATE.FIRE) fired++;
      }
      check(fired === 0, 'and never entered the fire state doing it -- a baton, not a service pistol');
    }
  }

  // --- 10. The crime rule, on the **server**, through a real swing.
  //
  // The whole point of this one is where it runs. A client cannot claim a drunk
  // was aggro'd, because there is no message that says so and the server has the
  // actor in front of it -- so what is asserted here is that the server, handed
  // an ordinary punch, reaches a different verdict for two actors that differ
  // only in whether they had turned on the player yet.
  {
    const sim = new Simulation(world);
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    const p = sim.join(0, null, 'Shazza');

    /**
     * A quiet stretch of footpath: one with **no ambient meth head or drunk
     * near enough to be promoted**.
     *
     * Not fussiness. `stepStreetlife` runs inside every `Simulation.step`, so a
     * scene staged next to a pub gets a real ambient drunk promoted beside the
     * one this check placed by hand -- and `npcHitTest` takes the *nearest*
     * actor to the swing, so the bat lands on a bystander this check never put
     * there and the actor under test is untouched. The first version of this
     * staged at the spawn point and passed or failed on where the spawn dither
     * happened to land, which is the worst kind of intermittent.
     *
     * The margins are the aggro radii plus room for a paced loiterer to wander
     * over the ninety ticks the three trials take.
     */
    const quiet = (): { x: number; z: number; y: number } => {
      const bands: PedBand[] = [];
      const pose = st.createStreetPose();
      const tick = trafficTick(Date.now());
      const busy = (x: number, z: number): boolean => {
        let n = 0;
        st.forEachMethheadNear(world.peds, x, z, st.METH_SIGHT + 8, tick, bands, pose, () => {
          n++;
          return true;
        });
        st.forEachDrunkNear(world.peds, x, z, st.DRUNK_NOTICE + 8, tick, bands, pose, () => {
          n++;
          return true;
        });
        return n > 0;
      };
      const sx = p.combat.body.position.x;
      const sz = p.combat.body.position.z;
      for (let r = 0; r <= 600; r += 40) {
        for (let a = 0; a < 12; a++) {
          // A twelve-point ring, walked outward. No trig on a shared path is the
          // rule for the *simulation*; this is a check choosing where to stand.
          const x = sx + Math.cos((a / 12) * Math.PI * 2) * r;
          const z = sz + Math.sin((a / 12) * Math.PI * 2) * r;
          const g = probeWorld.groundHeight(x, z, -Infinity);
          if (!Number.isFinite(g)) continue;
          if (busy(x, z)) continue;
          return { x, z, y: g };
        }
      }
      return { x: sx, z: sz, y: probeWorld.groundHeight(sx, sz, -Infinity) };
    };
    const spot = quiet();
    const px = spot.x;
    const pz = spot.z;
    const ground = spot.y;
    check(
      Number.isFinite(ground),
      `the crime scene is staged on a quiet stretch at (${px.toFixed(0)}, ${pz.toFixed(0)}) with no ` +
        'ambient street person close enough to be promoted into the swing',
    );

    /**
     * Stand a faction actor a metre in front of the player, put an officer
     * beside them, swing, and report what the server decided.
     *
     * The officer is promoted rather than hunted for on a beat: `policeWitness`
     * searches promoted actors first and this check is about the *verdict*, not
     * about whether a beat happened to be walking past. `checkPolice` already
     * proves a beat officer witnesses a crime.
     */
    const swingAt = (kind: number, target: number): { wanted: boolean; struck: boolean } => {
      sim.factions.clear();
      sim.factions.clearInvestigation(p.id);
      p.combat.body.position.set(px, ground + EYE_HEIGHT, pz);
      p.combat.body.velocity.set(0, 0, 0);
      p.combat.body.yaw = 0;
      p.combat.body.pitch = 0;
      p.combat.health = MAX_HEALTH;
      p.combat.phase = 'idle';
      p.combat.phaseT = 0;
      p.combat.koT = 0;
      p.combat.respawnT = 0;
      // **The yaw has to be set on the input, not on the body.**
      //
      // `combat.advance` writes `body.yaw` from `input.yaw` every tick, so a
      // check that set the body's yaw and then stepped was aiming the swing
      // wherever the spawn happened to have left the input pointing -- and the
      // actor placed a metre in front of the *intended* facing was simply off to
      // one side of the cast. It cost a trace to find, because every symptom
      // pointed at the capsule geometry: the only actor ever hit was the one
      // that walked toward the player, which looks exactly like a reach problem.
      //
      // `checkPolice` does not hit this because its bystander test re-places the
      // suspect every tick from inside the follow loop, which incidentally
      // re-asserts the yaw.
      p.input.yaw = 0;
      p.input.pitch = 0;
      p.input.forward = 0;
      p.input.right = 0;
      const feet = ground;
      // Yaw 0 faces -Z, so a metre in front is a metre toward -Z.
      const actor = sim.factions.promote(kind, px, feet, pz - 1.0, 0, 1, target);
      // Beside the player and behind the swing, so the cast cannot reach them and
      // the witness query can see the victim.
      const cop = sim.factions.promote(fac.NPC_KIND.POLICE, px + 4, feet, pz + 1, -1, 0, -1);
      // **With their beat well up the street.** An officer promoted onto their
      // own doorstep is an officer who is already home, and `POLICE.think`
      // despawns one that has arrived -- so the witness would vanish on the first
      // tick and the swing would land eight ticks later with nobody watching.
      // That is correct behaviour and it took a debug trace to see, which is why
      // it is written down rather than fixed silently.
      if (cop) {
        cop.homeX = px + 4;
        cop.homeZ = pz + 40;
      }
      const before = actor ? actor.health : 0;
      // The **lowest** health seen rather than the final one. A passive drunk
      // batted in front of an officer is a drunk the officer then moves on, and
      // `strikeNpc` hands an actor its pips back when it puts them down -- so by
      // the end of the window the health is back where it started and a
      // before/after compare reads as "the swing missed".
      let lowest = before;
      p.input.punch = true;
      for (let i = 0; i < 30; i++) {
        // Pinned every tick, `checkPolice`'s own follow loop restated: a
        // combatant teleported onto a coordinate is not standing on it until
        // gravity and the kerb have had a few ticks, and a scene that drifts
        // while the swing winds up is a scene the swing misses.
        p.combat.body.position.set(px, ground + EYE_HEIGHT, pz);
        p.combat.body.velocity.set(0, 0, 0);
        sim.step(out);
        p.input.punch = false;
        if (actor) lowest = Math.min(lowest, actor.health);
      }
      return {
        wanted: sim.investigations().some((w) => w.playerId === p.id),
        struck: actor !== null && lowest < before,
      };
    };

    // The passive case is a **race the player wins**, and that is the whole
    // point of `DRUNK_REACTION_TICKS`: the drunk notices somebody a metre away
    // immediately and acts on it three-quarters of a second later, where a bat's
    // wind-up is eight ticks. Walk up and swing and you have hit a bystander.
    const passive = swingAt(fac.NPC_KIND.DRUNK, -1);
    check(passive.struck, 'the server`s own swing reached a passive drunk standing in front of the player');
    check(
      passive.wanted,
      'and batting one in front of an officer opened an investigation -- they are a bystander until they swing',
    );
    const reason = sim.investigations().find((w) => w.playerId === p.id)?.reason ?? 0;
    check(
      reason === fac.REASON.ASSAULT,
      `for "${fac.reasonText(reason)}", which is the bystander reason rather than a new byte`,
    );

    const aggro = swingAt(fac.NPC_KIND.DRUNK, p.id);
    check(aggro.struck, 'the same swing reaches a drunk who is already swinging at the player');
    check(!aggro.wanted, 'and that one is self-defence -- no investigation, with the same officer watching');

    const meth = swingAt(fac.NPC_KIND.METHHEAD, p.id);
    check(meth.struck, 'and it reaches a meth head');
    check(!meth.wanted, 'who is never a crime to fight, because they came at you');

    // The framework's default is unchanged for anybody else, which is what stops
    // this rule leaking into the faction that lands next.
    const officer = sim.factions.promote(fac.NPC_KIND.POLICE, 0, 0, 0, 0, 1, -1);
    check(
      officer !== null && st.strikeCrime(officer) === fac.REASON.ASSAULT,
      'a kind this faction does not own still gets the framework`s ordinary bystander answer',
    );
  }

  // --- 11. What it costs, measured rather than asserted.
  //
  // Reported rather than checked, on `checkTraffic`'s argument: a budget is a
  // number somebody reads after a change, and a threshold here would either be
  // so loose it never fired or so tight it fired on a loaded machine.
  {
    const field = new fac.FactionField();
    const spot = findLoiterer(2_000_000) ?? { x: 0, y: 0, z: 0 };
    const c = createCombatant(3, spot.x, spot.z);
    c.body.position.set(spot.x, spot.y + EYE_HEIGHT, spot.z);
    // Warm: the first call fills the band pool for every anchor in range, which
    // is the cache this feature depends on and is not what a per-tick cost is.
    for (let i = 0; i < 60; i++) st.stepStreetlife(makeCtx(field, clear, [c], 2_000_000 + i));
    const at = performance.now();
    const ticks = 600;
    for (let i = 0; i < ticks; i++) st.stepStreetlife(makeCtx(field, clear, [c], 2_100_000 + i));
    const perTick = (performance.now() - at) / ticks;

    const bands: PedBand[] = [];
    const pose = st.createStreetPose();
    const at2 = performance.now();
    let poses = 0;
    for (let i = 0; i < 200; i++) {
      st.forEachMethheadNear(world.peds, spot.x, spot.z, 150, 2_100_000 + i * 60, bands, pose, () => {
        poses++;
      });
      st.forEachDrunkNear(world.peds, spot.x, spot.z, 150, 2_100_000 + i * 60, bands, pose, () => {
        poses++;
      });
    }
    const perFrame = (performance.now() - at2) / 200;
    say(
      `  cost: ${perTick.toFixed(3)} ms a tick for the promotion scan, ` +
        `${perFrame.toFixed(3)} ms a frame to place ${(poses / 200).toFixed(1)} ambient people in a 150 m radius`,
    );
    check(perTick < 2, `the per-tick scan is ${perTick.toFixed(3)} ms, inside a 16.7 ms budget shared with everything else`);
    check(perFrame < 4, `and the per-frame ambient placement is ${perFrame.toFixed(3)} ms`);
  }

  // --- 12. **There is somebody where a player actually starts.**
  //
  // The check this faction shipped without. Everything above asserts that a meth
  // head *behaves* -- that they see 25 m and not through a wall, that they chase
  // and give up, that batting one is not a crime -- and none of it asserts that
  // there is one anywhere near the place every player begins.
  //
  // Measured before any of this existed: **zero meth heads within 600 m of the
  // spawn disc**, and zero for the first six hundred metres of a walk up Sydney
  // Park Road. The cause was not tuning, it was a missing row: St Peters has no
  // `place` feature in the OSM extract at all, so the suburb a player stands in
  // had no anchor. See the `SUBURBS` header.
  {
    const spawn = world.spawn;
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();

    // Five hundred metres, and a loiterer is a fixed patch rather than a
    // schedule -- they pace 1.25 m and never dwell -- so this is asserted at a
    // spread of ticks to prove it is a property of the placement and not of one
    // instant.
    let worst = Infinity;
    let nearest = Infinity;
    let who = '';
    for (let t = 0; t < 60; t++) {
      let n = 0;
      st.forEachMethheadNear(world.peds, spawn.x, spawn.z, 500, 1_000_000 + t * 120, bands, pose, (p) => {
        n++;
        const d = Math.hypot(p.x - spawn.x, p.z - spawn.z);
        if (d < nearest) {
          nearest = d;
          who = `${st.SUBURBS[p.anchor].name}#${p.index}`;
        }
      });
      if (n < worst) worst = n;
    }
    check(
      worst >= 1,
      `the spawn disc centre has at least 1 meth head within 500 m at every one of 60 ticks ` +
        `(worst was ${worst}, nearest ${nearest.toFixed(0)} m -- ${who}); it had 0 within 600 m`,
    );

    // --- And the harbour is still empty, which is the other half of the brief
    // and the half a floor could easily have broken. Asserted against the world
    // rather than against `methLoiterers`, because `verifyStreetlife` already
    // covers the table and what could still go wrong is a *placement* that
    // reached a suburb the table says is empty.
    {
      let mosman = 0;
      for (let t = 0; t < 20; t++) {
        st.forEachMethheadNear(world.peds, 3165.2, -4055.6, 400, 1_000_000 + t * 600, bands, pose, () => {
          mosman++;
        });
      }
      check(mosman === 0, `Mosman holds no meth heads within 400 m across 20 ticks (${mosman} were placed)`);
    }

    // --- The population is still the same population. A fix for "I never saw
    // any" that answered by tripling the city would have cost every frame in
    // Redfern to buy one person in St Peters, so the total is bounded against
    // the number this table carried before the inner-south rows were added.
    //
    // Bounded against the **frozen inner-ring prefix** rather than against a
    // literal, now that the table carries a middle ring as well: the number that
    // must not drift is what the inner city carries, and the middle ring is
    // allowed to add exactly as much as its own suburbs justify. Both halves are
    // read off the sim's own constants, so a re-bake cannot quietly retune this
    // check into agreeing with itself.
    {
      let inner = 0;
      for (let i = 0; i < st.SUBURB_INNER_COUNT; i++) inner += st.methLoiterers(st.SUBURBS[i]);
      let total = 0;
      for (const s of st.SUBURBS) total += st.methLoiterers(s);
      const outer = total - inner;
      const innerPer = inner / st.SUBURB_INNER_COUNT;
      const outerPer = outer / Math.max(1, st.SUBURBS.length - st.SUBURB_INNER_COUNT);
      check(
        inner > 100 && inner < 160,
        `the frozen inner ring carries ${inner} meth heads across ${st.SUBURB_INNER_COUNT} suburbs -- it ` +
          'carried 114 across 57 before the inner south was filled in, and the middle-ring bake did not touch it',
      );
      check(
        outerPer < innerPer,
        `the middle ring carries ${outer} across ${st.SUBURBS.length - st.SUBURB_INNER_COUNT} suburbs, ` +
          `${outerPer.toFixed(2)} a suburb against the inner city's ${innerPer.toFixed(2)} -- ` +
          'a coverage fix rather than a population one, in the direction Sydney actually thins out',
      );
    }

    // --- Every loiterer a suburb claims is actually placed.
    //
    // `poseMethhead` returns false when it cannot find a footpath, and a `false`
    // there does not mean "not visible from here", it means **this person does
    // not exist**. With the per-loiterer patch that is a live hazard -- a patch
    // can land on a rail corridor or in the middle of a park -- which is why the
    // patch falls back to the suburb's own pool. This is that fallback asserted:
    // a suburb whose rows say three and whose city holds two is thinning
    // silently, and the symptom is the complaint this whole check exists for.
    {
      let claimed = 0;
      let placed = 0;
      let skipped = 0;
      const built = builtGate(world);
      const missing: string[] = [];
      for (let s = 0; s < st.SUBURBS.length; s++) {
        const suburb = st.SUBURBS[s];
        const want = st.methLoiterers(suburb);
        if (!built(suburb.x, suburb.z)) {
          skipped += want;
          continue;
        }
        claimed += want;
        let got = 0;
        for (let i = 0; i < want; i++) {
          if (st.poseMethhead(world.peds, s, i, 12345, bands, pose)) got++;
        }
        placed += got;
        if (got < want) missing.push(`${suburb.name} ${got}/${want}`);
      }
      check(
        placed === claimed,
        `all ${claimed} loiterers the table claims are placed on a real footpath` +
          (missing.length ? ` -- ${missing.slice(0, 4).join(', ')}` : '') +
          builtNote(world, skipped),
      );
    }
  }

  // --- 12. **The drunks exist where a player actually walks.**
  //
  // The meth heads' section 11 written again for the other faction, and for the
  // same reason: the report was *"I see no drunks at all in my travel"*, from a
  // player who spawned at Sydney Park and walked the King Street corridor --
  // which is lined with pubs -- while the tables said 502 drunks stood at 264 of
  // the city's 422 licenced premises.
  //
  // Both halves of the cause were placement, and neither was visible in the
  // code:
  //
  //   1. `poseDrunk` picked a band near the venue and then took a **uniform**
  //      point along the whole of it. A band is an entire OSM way's kerb, and
  //      `anchorBands` selects on its bounding box, so a pub that clipped the
  //      end of a long way got the whole way to stand on. Measured before the
  //      fix: the median drunk stood **58 m** from their own pub, the 90th
  //      percentile 123 m, the furthest **291 m**. The drunks were never
  //      missing; they were smeared off the pub strips into the back streets at
  //      one per hundred metres of nothing.
  //   2. `forEachDrunkNear`'s broadphase gate was a literal `60 + radius`
  //      against the **venue**, while the placement had no bound at all -- so
  //      230 of 489 placed drunks stood outside their own venue's gate and the
  //      query never returned them. Not drawn, not promoted, not there.
  //      Measured over 2,700 footpath points: 116 of 1,490 sightings at the
  //      150 m draw radius and 34 of 219 at 60 m were dropped outright.
  //
  // What was *not* the cause, measured rather than assumed, because it was the
  // loud suspect: the police. `policeHostileTo(DRUNK)` plus the new patrol
  // lattice looked like a citywide cleansing -- every pub rousted by a passing
  // pair before the player arrived. It cannot happen and does not: a drunk is
  // only ever an actor while a player is inside `DRUNK_NOTICE`, and
  // `respondToBrawls` only fetches an officer for a drunk who already has a
  // target. Ten minutes of sim with no player in the world produced **zero**
  // drunk-actor-ticks, so the ambient tier is untouchable and the cop-rousts-a-
  // drunk vignette stays exactly as characterful as it was.
  {
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();

    // --- The bound `forEachDrunkNear` now gates on is a real bound.
    //
    // The assertion that keeps the fix honest: `DRUNK_REACH` is derived from
    // `VENUE_BAND_RADIUS + DRUNK_SPREAD` in the sim rather than measured off the
    // city, so what has to be checked here is that the city agrees. If a
    // placement ever exceeds it the gate starts dropping people again, silently,
    // exactly as it did before.
    //
    // **Tallied per ring**, and that split is the honest version of a bar that
    // was calibrated on one. Every rate below was measured against the 422
    // inner-ring venues, on inner-city footpaths: short blocks, a band per side,
    // a pub every fifty metres. The middle ring's pubs stand on suburban
    // arterials whose bands are four hundred metres long and one to a side, so
    // the same placement rule lands a smaller share of them within 25 m of their
    // own door -- not because anything regressed, but because Victoria Road is
    // not King Street. Holding the whole city to the inner ring's number would
    // either fail forever or, worse, be "fixed" by loosening the bar on the
    // ground where it was actually doing work.
    //
    // So: the inner ring keeps the number it was tuned to, exactly, and is the
    // regression test. The middle ring gets its own floor and its own line in
    // the log, so a real collapse out there is still visible.
    const ring = (from: number, to: number) => {
      let claimed = 0;
      let placed = 0;
      let orphans = 0;
      let carrying = 0;
      let atPub = 0;
      let worstReach = 0;
      let skipped = 0;
      const builtHere = builtGate(world);
      for (let v = from; v < to; v++) {
        const want = st.venueDrunks(v);
        if (want === 0) continue;
        if (!builtHere(st.VENUE_XZ[v * 2], st.VENUE_XZ[v * 2 + 1])) {
          skipped += want;
          continue;
        }
        carrying++;
        claimed += want;
        let got = 0;
        for (let i = 0; i < want; i++) {
          if (!st.poseDrunk(world.peds, v, i, 12345, bands, pose)) continue;
          got++;
          const d = Math.hypot(pose.x - st.VENUE_XZ[v * 2], pose.z - st.VENUE_XZ[v * 2 + 1]);
          if (d > worstReach) worstReach = d;
          if (d <= 25) atPub++;
        }
        placed += got;
        if (got === 0) orphans++;
      }
      return { claimed, placed, orphans, carrying, atPub, worstReach, skipped };
    };
    const inner = ring(0, st.VENUE_INNER_COUNT);
    const middle = ring(st.VENUE_INNER_COUNT, st.VENUE_COUNT);
    const worstReach = Math.max(inner.worstReach, middle.worstReach);
    const placed = inner.placed + middle.placed;

    check(
      worstReach <= st.DRUNK_REACH,
      `no drunk in the city stands further than DRUNK_REACH = ${st.DRUNK_REACH} m from their own pub ` +
        `(worst is ${worstReach.toFixed(1)} m over ${placed} of them); before the frontage fix the worst was 291 m`,
    );
    check(
      inner.orphans <= 15,
      `${inner.orphans} of ${inner.carrying} inner-ring pubs that carry a drunk place nobody -- the frontage ` +
        'filter drops a band whose closest point is past 45 m, and a bar inside a shopping centre has no ' +
        'frontage at all' +
        builtNote(world, inner.skipped),
    );
    check(
      middle.orphans <= middle.carrying * 0.2,
      `and ${middle.orphans} of ${middle.carrying} middle-ring pubs (` +
        `${((middle.orphans / Math.max(1, middle.carrying)) * 100).toFixed(0)}%, under a fifth), where a ` +
        'suburban pub with a car park and no footpath frontage is a commoner shape' +
        builtNote(world, middle.skipped),
    );
    // Nine tenths, not all of them, and the shortfall is bought rather than
    // lost: a frontage has to have room to stand the venue's whole party
    // `DRUNK_MIN_GAP` apart, and a pub whose only footpath is a stub does not.
    // Standing them closer than that is what let the renderer's claim pick the
    // wrong one, so the venues this drops are the exact venues that used to
    // teleport.
    check(
      inner.placed >= inner.claimed * 0.9 && middle.placed >= middle.claimed * 0.9,
      `${inner.placed} of the ${inner.claimed} inner-ring drunks and ${middle.placed} of the ` +
        `${middle.claimed} middle-ring ones stand on a real footpath ` +
        `(${((inner.placed / Math.max(1, inner.claimed)) * 100).toFixed(0)}% and ` +
        `${((middle.placed / Math.max(1, middle.claimed)) * 100).toFixed(0)}%; the rest are at pubs with no ` +
        `frontage long enough to space a party ${st.DRUNK_MIN_GAP} m apart)`,
    );

    // --- And they stand **outside the pub**, which is the whole read.
    check(
      inner.atPub >= inner.placed * 0.75,
      `${inner.atPub} of ${inner.placed} inner-ring drunks ` +
        `(${((inner.atPub / Math.max(1, inner.placed)) * 100).toFixed(0)}%) stand within 25 m of their own ` +
        'pub; with the uniform-along-the-band placement the median alone was 58 m',
    );
    check(
      middle.atPub >= middle.placed * 0.4,
      `and ${middle.atPub} of ${middle.placed} middle-ring drunks ` +
        `(${((middle.atPub / Math.max(1, middle.placed)) * 100).toFixed(0)}%), on suburban arterials whose ` +
        'bands are hundreds of metres long -- lower on purpose, and still a majority within DRUNK_REACH',
    );

    // --- The query returns everybody who is really in range.
    //
    // The regression test for the half of the bug that was a *render* bug, and
    // it is written as an equality against a brute force rather than as a floor,
    // because the failure it guards is silent by construction: a gate that is
    // fractionally too tight drops somebody who is standing in front of you and
    // there is no frame anywhere that says so.
    {
      const truth: Array<{ x: number; z: number }> = [];
      for (let v = 0; v < st.VENUE_COUNT; v++) {
        const n = st.venueDrunks(v);
        for (let i = 0; i < n; i++) {
          if (st.poseDrunk(world.peds, v, i, 12345, bands, pose)) truth.push({ x: pose.x, z: pose.z });
        }
      }
      const R = 150;
      let sampled = 0;
      let expected = 0;
      let returned = 0;
      let short = 0;
      for (const at of [world.spawn, ...st.SUBURBS.slice(0, 24)]) {
        sampled++;
        let want = 0;
        for (const p of truth) {
          const dx = p.x - at.x;
          const dz = p.z - at.z;
          if (dx * dx + dz * dz <= R * R) want++;
        }
        let got = 0;
        st.forEachDrunkNear(world.peds, at.x, at.z, R, 12345 * 60, bands, pose, () => {
          got++;
        });
        expected += want;
        returned += got;
        if (got < want) short++;
      }
      check(
        short === 0 && returned >= expected,
        `forEachDrunkNear returned all ${expected} drunks genuinely inside ${R} m at every one of ${sampled} ` +
          `places (${returned} returned, ${short} came up short); the 60 m gate used to drop 8% of them`,
      );
    }

    // --- The route. Spawn to King Street, off the suburb table rather than off
    // a pair of coordinates, so a retune of the city moves the check with it.
    //
    // This is the police round's presence assertion for the other faction, and
    // it is deliberately a *route* rather than the spawn disc: the spawn is
    // Sydney Park, there is no pub within 700 m of it, and there should not be
    // one. What the player is owed is that the walk into Newtown puts drunks in
    // front of them, and 300 m is the honest radius for that -- inside the
    // 150 m draw radius they are drawn, and past it they are the reason to keep
    // walking.
    {
      const legs = [
        world.spawn,
        st.SUBURBS.find((s) => s.name === 'Newtown South')!,
        st.SUBURBS.find((s) => s.name === 'Newtown')!,
      ];
      const route: Array<{ x: number; z: number }> = [];
      for (let i = 0; i < legs.length - 1; i++) {
        const a = legs[i];
        const b = legs[i + 1];
        const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 100);
        for (let k = 0; k < n; k++) {
          route.push({ x: a.x + (b.x - a.x) * (k / n), z: a.z + (b.z - a.z) * (k / n) });
        }
      }
      route.push({ x: legs[legs.length - 1].x, z: legs[legs.length - 1].z });

      const WANT_NEAR = 3;
      const WANT_POINTS = 12;
      let worst = Infinity;
      let worstTick = 0;
      for (let t = 0; t < 60; t++) {
        const tick = 1_000_000 + t * 30;
        let covered = 0;
        for (const p of route) {
          let n = 0;
          st.forEachDrunkNear(world.peds, p.x, p.z, 300, tick, bands, pose, () => {
            n++;
          });
          if (n >= WANT_NEAR) covered++;
        }
        if (covered < worst) {
          worst = covered;
          worstTick = t * 30;
        }
      }
      check(
        worst >= WANT_POINTS,
        `at least ${WANT_POINTS} of the ${route.length} points on the spawn -> King Street walk have ` +
          `${WANT_NEAR}+ drunks within 300 m at every one of 60 ticks (worst was ${worst}, at +${worstTick})`,
      );
    }

    // --- And the corridor's pubs are actually occupied, which is the claim the
    // player's complaint was really about: King Street is lined with them.
    {
      const newtown = st.SUBURBS.find((s) => s.name === 'Newtown')!;
      const nsouth = st.SUBURBS.find((s) => s.name === 'Newtown South')!;
      let pubs = 0;
      let occupied = 0;
      for (let v = 0; v < st.VENUE_COUNT; v++) {
        const x = st.VENUE_XZ[v * 2];
        const z = st.VENUE_XZ[v * 2 + 1];
        const d = Math.min(Math.hypot(x - newtown.x, z - newtown.z), Math.hypot(x - nsouth.x, z - nsouth.z));
        if (d > 700) continue;
        pubs++;
        const n = st.venueDrunks(v);
        for (let i = 0; i < n; i++) {
          if (st.poseDrunk(world.peds, v, i, 12345, bands, pose)) {
            occupied++;
            break;
          }
        }
      }
      check(
        occupied >= 20,
        `${occupied} of the ${pubs} pubs in the King Street corridor have somebody standing out the front`,
      );
    }

    // --- The weighting the user asked for is untouched by all of it. Kings
    // Cross is the loudest suburb in the table and Mosman is the quietest, and a
    // placement fix that flattened that would have fixed the wrong thing.
    {
      const kx = st.SUBURBS.find((s) => s.name === 'Kings Cross')!;
      const mosman = st.SUBURBS.find((s) => s.name === 'Mosman')!;
      let cross = 0;
      let quiet = 0;
      st.forEachDrunkNear(world.peds, kx.x, kx.z, 400, 1_000_000, bands, pose, () => {
        cross++;
      });
      st.forEachDrunkNear(world.peds, mosman.x, mosman.z, 400, 1_000_000, bands, pose, () => {
        quiet++;
      });
      check(
        cross > 10 && quiet === 0,
        `Kings Cross carries ${cross} drunks within 400 m and Mosman ${quiet} -- the booze weighting survived ` +
          'the placement fix',
      );
    }
  }

  // --- 13. **The ambient -> actor handoff is continuous.**
  //
  // The report was *"the drunks seem to teleport when I get close to them"*,
  // and "close" is the promotion band, so this is the seam between the two
  // tiers. It is worth writing down what was *not* wrong, because the obvious
  // suspect was wrong: the promotion seeds the actor at the ambient's own posed
  // position and the displacement is **0.000 m over 228 promotions**, exactly,
  // on real world data. Nothing moves at the promotion tick.
  //
  // What moved was which ambient the *renderer* hid. `StreetCrowd.gather` paired
  // an actor to an ambient by re-running "the nearest one of this kind inside
  // `CLAIM_RADIUS`" **every frame**, and that is only an identity while a
  // venue's drunks are nowhere near each other. Before the frontage fix they
  // were scattered a median 58 m from their own pub, so the nearest candidate
  // was always right. Standing them back on the frontage put two and three
  // ambients inside one 30 m disc, and the search started picking the wrong one
  // and changing its mind between frames -- so a drunk winked out of one spot
  // and a different one appeared a few metres away. Measured over a walk-up to
  // all 153 multi-drunk pubs in the built city: **14,111 mis-claims, 5,884
  // frames with an actor drawn beside its own still-standing ambient, and 123
  // claim flips**. With the claim made once and then held by key: **0, 0, 0.**
  //
  // The assertions below are the sim's half of that. The renderer's half cannot
  // run here -- it needs a WebGL context -- so what is asserted is the property
  // the renderer's pairing *depends on*: that promotion is continuous, and that
  // no two ambients of one venue are ever close enough for a first claim to be
  // ambiguous.
  {
    const bands: PedBand[] = [];
    const pose = st.createStreetPose();
    const probe = st.createStreetPose();

    // --- Promotion continuity, over every multi-drunk pub in the city.
    //
    // `stepStreetlife` promotes at `p.x, p.y, p.z` -- the ambient's posed
    // position, sway and all -- so this is an equality rather than a tolerance,
    // and it is written as one deliberately: a tolerance here would pass a
    // rewrite that seeded from the anchor point instead, which is the exact
    // regression that would put the teleport back.
    {
      let promotions = 0;
      let worst = 0;
      let offBase = 0;
      for (let v = 0; v < st.VENUE_COUNT; v++) {
        const n = st.venueDrunks(v);
        if (n < 2) continue;
        for (let i = 0; i < n; i++) {
          if (!st.poseDrunk(world.peds, v, i, 12345, bands, pose)) continue;
          promotions++;
          // What the authority hands `FactionField.promote`, against what the
          // renderer draws for the same ambient on the same tick.
          const seedX = pose.x;
          const seedZ = pose.z;
          const homeX = pose.baseX;
          const homeZ = pose.baseZ;
          if (!st.poseDrunk(world.peds, v, i, 12345, bands, probe)) continue;
          const d = Math.hypot(probe.x - seedX, probe.z - seedZ);
          if (d > worst) worst = d;
          // And the home the actor carries is the *base* point, which is what
          // `occupied` dedupes on and what `goHome` walks back to.
          if (Math.hypot(homeX - probe.baseX, homeZ - probe.baseZ) > 1e-9) offBase++;
        }
      }
      check(
        worst === 0 && offBase === 0,
        `the promotion seed is the ambient's own posed position for all ${promotions} drunks at multi-drunk ` +
          `pubs (worst displacement ${worst.toFixed(4)} m, ${offBase} with a home off their base point)`,
      );
    }

    // --- Pairing correctness at multi-drunk venues.
    //
    // The renderer claims within `CLAIM_SNAP` = 1.5 m and then holds the claim
    // by key. That first claim is unambiguous only while a venue's *other*
    // drunks are further away than the snap, so this is the assertion the
    // renderer's constant is sized against -- and it is the one that would have
    // caught the bug, because it fails on the placement that caused it.
    const CLAIM_SNAP = st.DRUNK_MIN_GAP / 2;
    {
      let pairs = 0;
      let tooClose = 0;
      let closest = Infinity;
      let where = -1;
      for (let v = 0; v < st.VENUE_COUNT; v++) {
        const n = st.venueDrunks(v);
        if (n < 2) continue;
        const pts: Array<{ x: number; z: number }> = [];
        for (let i = 0; i < n; i++) {
          if (st.poseDrunk(world.peds, v, i, 12345, bands, pose)) pts.push({ x: pose.x, z: pose.z });
        }
        for (let a = 0; a < pts.length; a++) {
          for (let b = a + 1; b < pts.length; b++) {
            pairs++;
            const d = Math.hypot(pts[a].x - pts[b].x, pts[a].z - pts[b].z);
            if (d < closest) {
              closest = d;
              where = v;
            }
            if (d < CLAIM_SNAP) tooClose++;
          }
        }
      }
      check(
        tooClose === 0,
        `no two drunks of one pub stand inside the renderer's ${CLAIM_SNAP} m claim snap, so an actor can only ` +
          `ever claim itself (${tooClose} of ${pairs} pairs were; the closest is ${closest.toFixed(2)} m, at pub ${where})`,
      );
    }

    // --- The two key spaces are disjoint, and an actor's key is never mistaken
    //     for "this rig is free".
    //
    // This is the other half of the bug, and it was the bigger half. `Slot.key`
    // in `world/streetlife.ts` carried both the identity and the emptiness --
    // "-1 means free" -- while `StreetCrowd.gather` writes a promoted actor's
    // key as `-a.id`. Actor ids run 1..65535, so **every** promoted street
    // person had a negative key and `key < 0` read "free rig" for all of them:
    // `assign` handed their rig away and `drive` hid it. Measured over a
    // walk-up to a three-drunk pub: **0 of 1,300 promoted-actor frames were
    // drawn.** A drunk was invisible for exactly as long as they were promoted,
    // which is from `DRUNK_NOTICE` inward -- they winked out at seven metres,
    // and the mis-paired ambient left standing somewhere else is what made it
    // read as a teleport rather than a disappearance.
    //
    // The fix is a `held` flag, so the sentinel is gone. What is asserted here
    // is the property that made the old test unsafe, because that is what a
    // future rewrite would have to preserve: the ambient keys are positive, the
    // actor keys are negative, and `-1` -- the old sentinel -- is a perfectly
    // ordinary actor key.
    {
      let lowest = Infinity;
      for (const kind of [fac.NPC_KIND.METHHEAD, fac.NPC_KIND.DRUNK]) {
        for (const anchor of [0, 1, 57, st.VENUE_COUNT - 1]) {
          for (let i = 0; i < 3; i++) {
            const k = st.streetKey(kind, anchor, i);
            if (k < lowest) lowest = k;
          }
        }
      }
      check(
        lowest > 0,
        `every ambient street key is positive (lowest seen ${lowest}), so an ambient can never be confused ` +
          "with a promoted actor's -id",
      );
      // And the collision itself, stated rather than implied: id 1 is the first
      // id `FactionField` hands out.
      const firstActorKey = -1;
      check(
        firstActorKey < 0 && lowest > 0,
        `the very first actor promoted holds key ${firstActorKey}, which is the value the rig pool used to ` +
          'mean "nobody" -- the pool tracks emptiness in its own flag now, not in the sign of the key',
      );
    }

    // --- Demotion continuity: the ambient comes back where the actor stood.
    //
    // The reverse handoff. A resolving drunk walks back to `homeX/homeZ` -- the
    // ambient's *base* point -- and despawns there, and the ambient reappears at
    // base plus its sway. So the step is the sway and nothing else, and the
    // tolerance is derived from `SWAY_AMPLITUDE` rather than picked: a figure
    // that is already swaying that far under its own idle cannot be seen to jump
    // by less than it is swaying anyway.
    {
      const tol = st.SWAY_AMPLITUDE * 2;
      let checked = 0;
      let worst = 0;
      for (let v = 0; v < st.VENUE_COUNT; v++) {
        const n = st.venueDrunks(v);
        if (n === 0) continue;
        for (let i = 0; i < n; i++) {
          // Across a spread of ticks, because the sway is a cycle and one tick
          // would sample one phase of it.
          for (let t = 0; t < 6; t++) {
            if (!st.poseDrunk(world.peds, v, i, 12345 + t * 37, bands, pose)) continue;
            checked++;
            const d = Math.hypot(pose.x - pose.baseX, pose.z - pose.baseZ);
            if (d > worst) worst = d;
          }
        }
      }
      check(
        worst <= tol,
        `an ambient drunk never stands more than ${tol.toFixed(2)} m from the base point their actor walks back ` +
          `to and despawns on, so the reverse handoff is inside the idle's own sway (worst ${worst.toFixed(3)} m ` +
          `over ${checked} poses)`,
      );
    }
  }
}

/**
 * The wildlife: three species, server-authoritative, against the world files.
 *
 * Appended last and self-contained, on `checkPolice`'s own terms -- it imports
 * `game/wildlife.ts` twice as two separate module instances and drives a real
 * `Simulation` over the real city, and it asserts nothing that a comment could
 * have asserted instead.
 *
 * What is actually at risk here, and therefore what this checks:
 *
 *   - **The anchors are the whole feature.** Nothing about an ambient bird is
 *     ever sent: the server and the browser each evaluate the same hash over
 *     the same baked parks and the same footpath bands and are simply expected
 *     to agree. If they do not, the turkey you can see is not the turkey the
 *     server will promote, the one you bat is not the one you were aiming at,
 *     and no frame anywhere says so. So the anchors are compared bit for bit
 *     across two module instances, at several places and several ticks, and
 *     then re-asked from a different query centre -- because a scheme keyed off
 *     the query rather than off the world is perfectly repeatable and
 *     completely wrong.
 *   - **The damage is the server's.** A probe that sends no input at all still
 *     gets pecked, and loses exactly a quarter of a pip a peck.
 *   - **The crime is unconditional.** This is the one crime in the game with no
 *     witness test, and the check proves it the only way that means anything:
 *     by hitting a bird with no officer anywhere near it and watching the
 *     investigation open with the right string.
 *   - **The ibis never attacks.** The user asked for one bird that does not,
 *     and "does not" has to be a property of the code rather than of the
 *     tuning.
 *   - **The cap holds.** A full field of police pursuers must not be evicted by
 *     a flock, and a flock must not be able to starve a pursuit.
 */
async function checkWildlife(): Promise<void> {
  say('wildlife: bush turkeys, ibises and magpies, server-authoritative, against the world files');

  const here = new URL('../client/src/game/wildlife.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/game/wildlife.ts');
  const factionsHere = new URL('../client/src/game/factions.ts', import.meta.url).pathname;
  const F = (await import(factionsHere)) as typeof import('../client/src/game/factions.ts');

  // **One module instance, unlike `checkPolice`, and the reason is worth
  // stating** because the missing second instance looks like an omission.
  //
  // `checkPolice` imports `game/factions.ts` twice under two specifiers and
  // compares them. That works because that module registers *itself*. This one
  // registers three kinds into the framework's registry at load, and an ES
  // module's own query string does not propagate to its imports -- so
  // `wildlife.ts?instance=2` gets a second copy of the wildlife module and the
  // *same* `factions.ts` underneath it, whose `registerNpcKind` then throws on
  // the duplicate byte. Correctly: that throw is the framework refusing to let
  // two factions share a kind, and it is asserted in `checkPolice` as a feature.
  //
  // So determinism is proved here the other way round -- not by a second copy
  // of the code, but by asking the *same* code the same question from different
  // query centres, at different radii, with different scratch buffers, in
  // interleaved order. That covers every failure a second instance would have
  // caught except a module-level cache, and section 3 below is built to catch
  // that one too: interleaving A/B/A means state carried between calls shows up
  // as a mismatch.
  {
    const f = one.verifyWildlife();
    check(f.length === 0, 'verifyWildlife passes' + (f.length ? ` -- ${f[0]}` : ''));
  }
  {
    check(one.TURKEY === F.NPC_KIND.TURKEY, `the bush turkey holds the reserved byte ${F.NPC_KIND.TURKEY}`);
    check(one.IBIS === F.NPC_KIND.IBIS, `the ibis holds byte ${F.NPC_KIND.IBIS}`);
    check(one.MAGPIE === F.NPC_KIND.MAGPIE, `the magpie holds byte ${F.NPC_KIND.MAGPIE}`);
    check(
      F.npcKind(F.NPC_KIND.TURKEY)?.name === 'bush turkey' &&
        F.npcKind(F.NPC_KIND.IBIS)?.name === 'ibis' &&
        F.npcKind(F.NPC_KIND.MAGPIE)?.name === 'magpie',
      'and the framework can look all three up by byte',
    );
    check(
      one.isProtected(F.NPC_KIND.TURKEY) && one.isProtected(F.NPC_KIND.IBIS) && one.isProtected(F.NPC_KIND.MAGPIE),
      'all three are protected natives -- which is what makes hitting one a crime with no witness',
    );
    check(
      !one.isProtected(F.NPC_KIND.POLICE) && !one.isProtected(F.NPC_KIND.DRUNK),
      'and nothing else is, so the unconditional crime rule cannot leak onto another faction',
    );
  }

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const probeWorld = groundFor(world);
  const ground = (x: number, z: number): number => probeWorld.groundHeight(x, z, -Infinity);

  // --- 1. The baked parks land on the built city.
  //
  // Not merely inside the radius, which `verifyWildlife` already asserts with
  // no world file at all, but on **a tile that exists and has terrain under
  // it**: a park whose pole of inaccessibility is off the built extent puts its
  // turkeys where `groundHeight` has nothing to answer with, and they stand at
  // the height of whoever asked last. Which is invisible from every angle
  // except the one you are standing at.
  {
    const size = world.index.tile_size;
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const built = builtGate(world);
    let offMap = 0;
    let noTerrain = 0;
    let judged = 0;
    let skipped = 0;
    for (const park of one.PARKS) {
      if (!built(park.x, park.z)) {
        skipped++;
        continue;
      }
      judged++;
      const key = `${Math.floor(park.x / size)}_${Math.floor(-park.z / size)}`;
      if (!keys.has(key)) offMap++;
      if (!Number.isFinite(world.terrain.height(park.x, park.z))) noTerrain++;
    }
    check(offMap === 0, `all ${judged} baked parks are on a built tile (${offMap} were not)${builtNote(world, skipped)}`);
    check(noTerrain === 0, `every park has a terrain grid to stand birds on (${noTerrain} had none)`);
    const area = one.PARKS.reduce((n, p) => n + Math.PI * p.r * p.r, 0);
    say(
      `  world: ${one.PARKS.length} parks, ${(area / 1e6).toFixed(2)} km2 of inscribed green, ` +
        `widest ${one.PARKS[0].name} at ${one.PARKS[0].r.toFixed(0)} m`,
    );
  }

  // --- 2. Every anchor is inside the park it came from.
  //
  // The guarantee the whole `Park` record exists to provide -- a point inside
  // the inscribed circle is inside the polygon by construction, so a turkey is
  // never standing in the middle of Enmore Road. Asserted rather than assumed
  // because the *jitter* inside a grid cell is what could push one out, and a
  // turkey on the road looks exactly like a turkey.
  {
    const scratch = one.createWildScratch();
    const pose = one.createWildPose();
    let checked = 0;
    let outside = 0;
    for (const park of one.PARKS) {
      one.forEachWildlifeNear(null, park.x, park.z, park.r + 40, 1_000_000, ground, scratch, pose, (p) => {
        checked++;
        const dx = p.ax - park.x;
        const dz = p.az - park.z;
        // Parks overlap -- Sydney Harbour National Park contains Ashton Park --
        // so a bird found by this query may belong to a different disc. It has
        // to be inside *some* park, which is the claim that matters.
        if (dx * dx + dz * dz > park.r * park.r) {
          let held = false;
          for (const other of one.PARKS) {
            const ox = p.ax - other.x;
            const oz = p.az - other.z;
            if (ox * ox + oz * oz <= other.r * other.r) {
              held = true;
              break;
            }
          }
          if (!held) outside++;
        }
      });
    }
    check(checked > 400, `the park grid actually places birds: ${checked} anchors over ${one.PARKS.length} parks`);
    check(outside === 0, `every one of them is inside a park disc, and so inside a real polygon (${outside} were not)`);
  }

  // --- 3. The anchors are the same anchors asked twice, in either order, with
  //     nothing shared between the two askings.
  //
  // The real claim behind zero-wire ambient placement, and it is tested over
  // both halves of the scheme: the park grid, and the band-derived nests and
  // bins, which depend on the resident footpath set and are therefore the half
  // that could differ. Positions to six decimals, because "nearly the same
  // place" is not what a promotion needs -- the server promotes at the pose it
  // computes and the client draws the pose it computes, and a centimetre of
  // disagreement is a bird that jumps when it wakes up.
  //
  // Two independent scratch buffers, interleaved A then B: a module that kept a
  // cache keyed on anything but the world would answer the second call
  // differently from the first, and a query that leaked state through its
  // scratch would answer differently again.
  {
    const sa = one.createWildScratch();
    const sb = one.createWildScratch();
    const pa = one.createWildPose();
    const pb = one.createWildPose();
    const spots: Array<[string, number, number]> = [
      ['Sydney Park (the spawn)', -2236.4, 4543.3],
      ['the CBD', -200, 400],
      ['Newtown', -2784.7, 3133.7],
      ['Centennial Park', 2452.5, 3279.5],
      ['Surry Hills', 416.6, 1204.6],
      ['the Domain', 527.1, -94.7],
    ];
    let compared = 0;
    let mismatched = 0;
    let posed = 0;
    let withBands = 0;
    for (const [, x, z] of spots) {
      for (let t = 0; t < 8; t++) {
        const tick = 1_000_000 + t * 9000;
        const a: string[] = [];
        const b: string[] = [];
        one.forEachWildlifeNear(world.peds, x, z, 150, tick, ground, sa, pa, (p) => {
          a.push(`${p.kind}:${p.key}:${p.x.toFixed(6)}:${p.y.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}:${p.act}`);
          if (p.kind !== F.NPC_KIND.TURKEY) withBands++;
        });
        // The same question, from a query centre 45 m away and at a wider
        // radius, with its own scratch. Everything the first query found is
        // still in range of the second, so the two lists have to agree on every
        // bird they share -- position, heading and act included, because the
        // pose is as much a pure function of the tick as the anchor is.
        one.forEachWildlifeNear(world.peds, x + 45, z - 30, 210, tick, ground, sb, pb, (p) => {
          b.push(`${p.kind}:${p.key}:${p.x.toFixed(6)}:${p.y.toFixed(6)}:${p.z.toFixed(6)}:${p.dx.toFixed(6)}:${p.act}`);
        });
        posed += a.length;
        compared++;
        const wide = new Set(b);
        if (a.some((v) => !wide.has(v))) mismatched++;
      }
    }
    check(posed > 100, `the anchors actually place birds: ${posed} bird-poses across ${compared} place-ticks`);
    check(withBands > 0, 'the band-derived half places birds too -- the nests and the bins, not just the parks');
    check(
      mismatched === 0,
      `every one of those ${compared} place-ticks agrees bird-for-bird with the same query asked from ` +
        '45 m away with its own buffers -- which is the whole of what makes an ambient bird free',
    );
  }

  // --- 4. And the anchors do not move when the question does.
  //
  // The failure this catches is a scheme keyed off the *query centre* rather
  // than off the world, which passes every repeatability test ever written and
  // still places the bird somewhere else on a client whose camera is elsewhere.
  {
    const scratch = one.createWildScratch();
    const pose = one.createWildPose();
    const gather = (qx: number, qz: number, r: number): Map<string, string> => {
      const out = new Map<string, string>();
      one.forEachWildlifeNear(world.peds, qx, qz, r, 1_000_000, ground, scratch, pose, (p) => {
        out.set(`${p.kind}:${p.key}`, `${p.ax.toFixed(6)},${p.az.toFixed(6)}`);
      });
      return out;
    };
    const near = gather(-2236.4, 4543.3, 150);
    const far = gather(-2236.4 + 70, 4543.3 - 40, 280);
    let moved = 0;
    let seen = 0;
    for (const [key, at] of near) {
      const other = far.get(key);
      if (other === undefined) continue;
      seen++;
      if (other !== at) moved++;
    }
    check(seen > 5, `${seen} of the same birds were found from a query centre 80 m away`);
    check(moved === 0, `none of them moved when the query did (${moved} did) -- the anchors are keyed off the world`);
  }

  // --- 5..N. The whole path, through a real `Simulation`, with no socket and
  //     no client claim anywhere in it.
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const probe = sim.join(0, null, 'Bazza');
  const place = (x: number, z: number, yaw = 0): void => {
    probe.combat.body.position.set(x, ground(x, z) + EYE_HEIGHT, z);
    probe.combat.body.velocity.set(0, 0, 0);
    probe.combat.body.yaw = yaw;
    probe.combat.body.pitch = 0;
    probe.input.yaw = yaw;
    probe.input.pitch = 0;
  };
  /** The promoted birds of one kind, off the server's own snapshot. */
  const birds = (kind: number): SnapshotNpc[] => sim.npcSnapshot().filter((a) => a.kind === kind);

  /**
   * Find an ambient bird of a kind near a point, at the tick the sim will use.
   *
   * Searched rather than constructed, `checkPolice.findScene`'s argument: the
   * anchors are a hash over the real city and the honest way to test them is to
   * ask the real city where one is.
   *
   * **The nearest anchor, not the first one visited**, and that is the fix for
   * a genuinely intermittent check. A bird is only *visited* when its walking
   * pose is inside the query radius, and its pose depends on the wall clock --
   * so a bird near the edge of a 400 m query is in or out depending on what
   * time it is, and "the first one found" was therefore a different bird on
   * different runs. One of them turned out to be a kerbside ibis with a wall at
   * its back, whose flee `collision.resolve` correctly stops after a metre. The
   * behaviour was right and the scene was a lottery. An anchor does not move,
   * so choosing by anchor distance chooses the same bird every time.
   *
   * `peds` is optional so a caller can ask for **parks only**: park birds stand
   * on open lawn, which is what a check about *fleeing* wants.
   */
  const findBird = (
    kind: number,
    qx: number,
    qz: number,
    radius: number,
    peds: typeof world.peds | null = world.peds,
  ): { x: number; z: number; y: number } | null => {
    const scratch = one.createWildScratch();
    const pose = one.createWildPose();
    let found: { x: number; z: number; y: number } | null = null;
    let best = Infinity;
    one.forEachWildlifeNear(peds, qx, qz, radius, trafficTick(Date.now()), ground, scratch, pose, (p) => {
      if (p.kind !== kind) return;
      const d = (p.ax - qx) * (p.ax - qx) + (p.az - qz) * (p.az - qz);
      if (d >= best) return;
      best = d;
      found = { x: p.ax, z: p.az, y: p.y };
    });
    return found;
  };

  /**
   * Somewhere to stand near a point, on ground the world will actually let you
   * stand on.
   *
   * **This exists because a hard-coded offset is a fixture with a use-by date,
   * and this one expired.** An earlier cut of the magpie scene stood the probe
   * at `nest + (6, 6)` and asserted on the distance the swoop passed at. When
   * the city was rebuilt at the 5.3 km extent -- 27,000 more houses -- that
   * exact spot landed inside a new terrace, so `combat.advance` pushed the
   * probe **2.76 m** out of the wall on every tick. The magpie then dived
   * perfectly at where the player really was and connected; the check compared
   * against the coordinates it had *written* and reported a 2.75 m miss. The
   * simulation was right and the fixture was measuring a building.
   *
   * So the stand point is derived from the world rather than assumed: sixteen
   * bearings at a few radii, and the first one `CollisionWorld.resolve` leaves
   * alone -- which is precisely the "rehearse the scene before asserting on it"
   * discipline `checkPolice.findScene` already applies to its swing. The probe
   * then stays where it is put, in this build and in any later one.
   */
  const standNear = (x: number, z: number, want: number): { x: number; z: number } | null => {
    for (const r of [want, want * 1.35, want * 0.7, want * 1.7]) {
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const cx = x + Math.cos(a) * r;
        const cz = z + Math.sin(a) * r;
        const g = ground(cx, cz);
        if (!Number.isFinite(g)) continue;
        const moved = world.collision.resolve(cx, cz, cx, cz, PLAYER_RADIUS, g + 0.42);
        if (Math.hypot(moved.x - cx, moved.z - cz) > 0.01) continue;
        return { x: cx, z: cz };
      }
    }
    return null;
  };

  /** How far the world moved the probe from where the check put it. Zero on free ground. */
  const drift = (x: number, z: number): number =>
    Math.hypot(probe.combat.body.position.x - x, probe.combat.body.position.z - z);

  // --- 5. A turkey in Sydney Park comes at you, and it does it at eight metres.
  //
  // The spawn park, deliberately: every player in this game lands here and the
  // turkeys are the first thing that happens to them, so a check that proved
  // the feature worked in Centennial Park would be proving it somewhere nobody
  // starts.
  const turkeyAt = findBird(F.NPC_KIND.TURKEY, -2236.4, 4543.3, 260);
  if (!turkeyAt) {
    check(false, 'a bush turkey could be found in Sydney Park, which is the spawn park');
  } else {
    // Twelve metres away: inside the wake radius, outside the aggro radius. The
    // bird has to become real and then *not* attack, which is the half of this
    // that a bird which attacked everything would also pass.
    const away = 12;
    place(turkeyAt.x + away, turkeyAt.z, 0);
    for (let i = 0; i < 30; i++) sim.step(out);
    const woken = birds(F.NPC_KIND.TURKEY);
    check(woken.length > 0, `standing ${away} m from a turkey in Sydney Park promoted it (${woken.length} awake)`);
    check(
      woken.every((a) => a.state !== F.NPC_STATE.CHASE),
      'and at 12 m it is not chasing anybody -- the wake radius is not the aggro radius',
    );

    // Now inside eight metres. The state byte is the assertion, because it is
    // what the client draws off and what the whole encounter is made of.
    place(turkeyAt.x + 6, turkeyAt.z, 0);
    let chasing = false;
    for (let i = 0; i < 60 && !chasing; i++) {
      sim.step(out);
      chasing = birds(F.NPC_KIND.TURKEY).some((a) => a.state === F.NPC_STATE.CHASE || a.state === F.NPC_STATE.FIRE);
    }
    check(chasing, 'inside 8 m it turned and came at the player -- the brief\'s territorial radius');

    // --- 6. The peck: a quarter of a pip, and a client cannot dodge it by
    //     saying nothing at all.
    //
    // From here the probe sends **no input**. Health is read off the server's
    // own combatant, which is the only copy that matters.
    const start = probe.combat.health;
    let ticks = 0;
    while (probe.combat.health === start && ticks < 60 * 20) {
      sim.step(out);
      ticks++;
    }
    const lost = start - probe.combat.health;
    check(lost > 0, `a player who sent no input at all was pecked within ${(ticks / 60).toFixed(1)} s`);
    check(
      Math.abs(lost - 0.25) < 1e-9,
      `one peck took exactly ${lost} of a pip (the brief's quarter), server-derived`,
    );
    // And on a cadence rather than every tick, which is the difference between
    // a bird and a wood chipper.
    const afterFirst = probe.combat.health;
    let gap = 0;
    while (probe.combat.health === afterFirst && gap < 60 * 5) {
      sim.step(out);
      gap++;
    }
    check(gap >= 50, `the next peck was ${gap} ticks later -- the 1 s cadence, not once a tick`);

    // --- 7. Hitting one is a crime, **with nobody watching**.
    //
    // The single most important assertion in this file. Sydney Park is 2.2 km
    // from the nearest police station and this asserts that directly: the
    // witness query is run at the same tick and finds nobody, and the
    // investigation opens anyway. Every other crime in this game would not.
    {
      sim.factions.clearInvestigation(probe.id);
      const witnessCtx = {
        peds: world.peds,
        collision: world.collision,
        field: sim.factions,
        bands: [] as PedBand[],
        ped: createPedPose(),
        beat: F.createBeatPose(),
      };
      const seen = F.policeWitness(
        probe.combat.body.position.x,
        probe.combat.body.position.z,
        trafficTick(Date.now()),
        witnessCtx,
        F.createWitness(),
      ).seen;
      check(!seen, 'no officer, on a beat or promoted, can see the middle of Sydney Park');

      // Face the bird and swing. One button, exactly as a client sends it.
      //
      // **Aim down.** A turkey's capsule centre is 39 cm off the ground and the
      // player's eye is at `EYE_HEIGHT`, so from the metre and a half a bird
      // gets pecked from, the bat is pointing about 40 degrees below the
      // horizon -- and `combat.viewDirection` reads a *positive* pitch as up
      // (`ay + sin(pitch) * REACH`). The first version of this check aimed at
      // +0.35 rad, swung ninety times over a turkey's head and concluded the
      // crime path was broken.
      //
      // And press the button once every eight ticks rather than every tick:
      // spec 8.2 is four swings and then a two-second lock, so a held punch
      // spends the bar in the first four and everything after it is refused.
      const live = birds(F.NPC_KIND.TURKEY);
      let opened: InvestigationRecord | undefined;
      let aimed = 0;
      const capsuleY = (F.npcKind(F.NPC_KIND.TURKEY)?.height ?? 0.78) / 2;
      for (let i = 0; i < 240 && !opened; i++) {
        const target = sim.npcSnapshot().find((a) => a.kind === F.NPC_KIND.TURKEY);
        if (target) {
          const dx = target.x - probe.combat.body.position.x;
          const dz = target.z - probe.combat.body.position.z;
          const plan = Math.sqrt(dx * dx + dz * dz);
          const drop = probe.combat.body.position.y - (target.y + capsuleY);
          const pitch = -Math.atan2(drop, Math.max(plan, 0.05));
          probe.combat.body.yaw = Math.atan2(-dx, -dz);
          probe.combat.body.pitch = pitch;
          probe.input.yaw = probe.combat.body.yaw;
          probe.input.pitch = pitch;
          if (plan < REACH) aimed++;
        }
        probe.input.punch = i % 8 === 0;
        sim.step(out);
        probe.input.punch = false;
        opened = sim.investigations().find((r) => r.playerId === probe.id);
      }
      check(aimed > 0 && live.length > 0, `there was a turkey inside the ${REACH} m reach to swing at`);
      check(
        opened !== undefined && opened.reason === F.REASON.WILDLIFE,
        'batting a bush turkey with nobody watching opened an investigation for ' +
          `"${F.reasonText(opened?.reason ?? 0)}" -- unconditional, because it is a protected native`,
      );
      check(
        (opened?.ticks ?? 0) > F.COUNTDOWN_TICKS - 180,
        `the countdown started at about ${((opened?.ticks ?? 0) / 60).toFixed(0)} s (the rule is 45)`,
      );
      // And the police actually come, which is the user's "u have to run".
      let officers = 0;
      for (let i = 0; i < 60 * 6 && officers === 0; i++) {
        sim.step(out);
        officers = sim.npcSnapshot().filter((a) => a.kind === F.NPC_KIND.POLICE).length;
      }
      check(officers > 0, `${officers} officer(s) were dispatched to a turkey in Sydney Park`);
      sim.factions.clearInvestigation(probe.id);
    }
  }

  // --- 8. The ibis never attacks, and the guarantee is structural.
  //
  // Two assertions of the same fact from opposite ends: the registered `think`
  // contains no call to `damagePlayer` at all -- which is what `verifyWildlife`
  // reads out of the framework's own registry -- and an ibis parked on top of a
  // player for ten seconds takes nothing off them. The first is the guarantee;
  // the second is the proof that the first is about the function that actually
  // runs.
  {
    const def = F.npcKind(F.NPC_KIND.IBIS);
    check(def !== undefined, 'the ibis kind is registered on the server');
    check(
      def !== undefined && !String(def.think).includes('damagePlayer'),
      'the ibis `think` contains no call to damagePlayer -- the user asked for one bird that does not attack',
    );

    // Parks only, so the bird is standing on a lawn rather than against a wall
    // -- see `findBird`, which explains why that used to matter and no longer
    // has to be left to chance.
    const ibisAt = findBird(F.NPC_KIND.IBIS, -2236.4, 4543.3, 400, null)
      ?? findBird(F.NPC_KIND.IBIS, -200, 400, 900, null);
    const ibisStand = ibisAt ? standNear(ibisAt.x, ibisAt.z, 2.2) : null;
    if (!ibisAt || !ibisStand) {
      check(false, 'an ibis could be found on a park lawn somewhere in the city');
    } else {
      place(ibisStand.x, ibisStand.z, 0);
      const before = probe.combat.health;
      let awake = 0;
      let fleeing = 0;
      let furthest = 0;
      let approached = false;
      let holdX = ibisStand.x;
      let holdZ = ibisStand.z;
      for (let i = 0; i < 60 * 12; i++) {
        sim.step(out);
        const live = birds(F.NPC_KIND.IBIS);
        awake = Math.max(awake, live.length);
        // **Walk up to the bird until it goes, then stand still and watch.**
        //
        // The flee radius is 3 m from the *bird*, and a promoted ibis settles
        // anywhere within 1.5 m of its anchor -- so a probe parked at a fixed
        // offset from the anchor is somewhere between 0.5 m and 3.5 m away
        // depending on where its stroll happened to stop, which is a coin flip
        // on the trigger and made this check intermittent across world
        // rebuilds. Approaching the bird's *live* position establishes the
        // precondition the claim is actually about -- "a player comes within
        // three metres" -- rather than assuming a spot in the world implies it.
        //
        // The moment it starts leaving, the probe stops: everything measured
        // after that is the ibis putting distance between us, which is the half
        // that would be meaningless if the check kept following it.
        if (!approached && live.length > 0) {
          const a = live[0];
          const near = standNear(a.x, a.z, 2);
          if (near) {
            holdX = near.x;
            holdZ = near.z;
          }
        }
        place(holdX, holdZ, 0);
        for (const a of live) {
          if (a.state === F.NPC_STATE.RETURN) {
            fleeing++;
            approached = true;
          }
          const d = Math.hypot(a.x - probe.combat.body.position.x, a.z - probe.combat.body.position.z);
          if (d > furthest) furthest = d;
        }
      }
      check(awake > 0, `an ibis a couple of metres away woke up (${awake} promoted)`);
      check(
        fleeing > 0 && furthest > 4,
        `and waddled off rather than standing there -- ${(fleeing / 60).toFixed(1)} s of fleeing, ` +
          `${furthest.toFixed(1)} m at its furthest ("flee on approach", unhurried)`,
      );
      check(
        probe.combat.health === before,
        `ten seconds beside an ibis cost the player nothing (${before} pips before, ${probe.combat.health} after)`,
      );
      check(
        birds(F.NPC_KIND.IBIS).every((a) => a.state !== F.NPC_STATE.CHASE && a.state !== F.NPC_STATE.FIRE),
        'and it never entered a chase or a strike state at all',
      );
    }
  }

  // --- 9. The magpie swoops, it connects, and it does the same thing twice.
  //
  // The arc is a pair of quadratics joined at the strike point -- see
  // `swoopPoint` -- and the reason it is built that way rather than as the one
  // cubic it started as is exactly what is asserted here: a curve that merely
  // *aims* at your head misses it by three metres and looks perfect doing so.
  //
  // **This block is the half that has to keep hurting.** Sections 9b to 9d
  // below are the mercy the swoop was retuned to have -- a sprint through the
  // radius, a break-off, a cooldown -- and every one of them would also pass on
  // a magpie that had simply been turned off. This one is what stops that being
  // the fix: a player who stands under the nest and does nothing still gets hit,
  // still gets hit exactly twice, and is still warned before each of them.
  //
  // Every number below is read out of `one.MAGPIE_TUNING` rather than restated,
  // so a tuning change moves the check with it and only a *wrong* tuning breaks
  // it.
  const MT = one.MAGPIE_TUNING;
  {
    const nestAt = findBird(F.NPC_KIND.MAGPIE, -2784.7, 3133.7, 300)
      ?? findBird(F.NPC_KIND.MAGPIE, -2236.4, 4543.3, 400)
      ?? findBird(F.NPC_KIND.MAGPIE, -200, 400, 400);
    const stand = nestAt ? standNear(nestAt.x, nestAt.z, 8) : null;
    if (!nestAt || !stand) {
      check(false, 'a magpie nest with standable ground under it could be found somewhere in the city');
    } else {
      // Under the tree, in the open. The nest is on a footpath band, so this is
      // a player walking down a suburban street in September -- and `standNear`
      // is what guarantees it is the footpath rather than the front room of the
      // terrace behind it. See its header.
      place(stand.x, stand.z, 0);
      sim.factions.clearInvestigation(probe.id);
      // **Healed first, and the damage counted as drops rather than as a
      // difference.** The probe arrives here on three quarters of a pip after
      // the turkey, and three swoops would knock it out -- at which point
      // `combat` respawns it at full health and the net change over the window
      // is *positive*. The first version of this measured `before - after` and
      // reported "-1.5 of a pip was lost", which is a correct measurement of
      // the wrong thing. Summing the falls is immune to a respawn in the middle
      // and is also what "a whole number of quarter-pip swoops" actually means.
      //
      // **And topped up every tick**, which is the second thing this window has
      // to control for. A street corner can hold more than one nest -- the rate
      // is one band in four and a half, and the wake radius reaches 30 m -- so
      // several magpies can be on the same player, and eight of them at three
      // passes each is six pips against a bar of three. The player is then
      // knocked out, `nearestTarget` stops returning them (a bird does not
      // attack an unconscious body), every magpie's campaign resets, and after
      // the respawn they all start again: six passes from one bird, which is
      // correct behaviour and reads exactly like a broken swoop counter.
      probe.combat.health = MAX_HEALTH;
      let dived = false;
      let lowest = Infinity;
      let lastHealth = probe.combat.health;
      let taken = 0;
      let odd = 0;
      // Passes are counted **per actor id**: there can be more than one nest
      // within earshot of a street corner, and one shared edge flag would count
      // two birds' dives as one bird's five.
      const diving = new Set<number>();
      const passesBy = new Map<number, number>();
      // And the state each bird was in on the previous tick, so the *order* of
      // the two cues can be asserted rather than merely their existence. The
      // alarm is `NPC_STATE.AIM`; a dive that was not preceded by one is a
      // magpie that arrives without warning, which is the reported bug.
      const prevState = new Map<number, number>();
      let telegraphed = 0;
      let ambushed = 0;
      let worstDrift = 0;
      for (let i = 0; i < 60 * 14; i++) {
        sim.step(out);
        // **Measured before the probe is put back**, which is the other half of
        // the lesson in `standNear`. The distance that matters is the one
        // between the bird and where the player *actually was* when the
        // authority ran the arc -- not the coordinates this check wrote a tick
        // earlier. If the two ever diverge again the drift assertion below says
        // so in one line, rather than presenting as a swoop that misses.
        worstDrift = Math.max(worstDrift, drift(stand.x, stand.z));
        for (const a of birds(F.NPC_KIND.MAGPIE)) {
          const d = Math.hypot(a.x - probe.combat.body.position.x, a.z - probe.combat.body.position.z);
          if (d < lowest) lowest = d;
        }
        // The probe stands still: the counterplay to a swoop is leaving, and
        // this is the check that not leaving costs you.
        place(stand.x, stand.z, 0);
        if (probe.combat.health < lastHealth) {
          const drop = lastHealth - probe.combat.health;
          taken += drop;
          // A drop of half a pip is two magpies connecting on the same tick,
          // which is legal and is still two quarter-pip swoops.
          if (Math.abs((drop / 0.25) - Math.round(drop / 0.25)) > 1e-9) odd++;
        }
        probe.combat.health = MAX_HEALTH;
        lastHealth = probe.combat.health;
        for (const a of birds(F.NPC_KIND.MAGPIE)) {
          const isDiving = a.state === F.NPC_STATE.CHASE || a.state === F.NPC_STATE.FIRE;
          if (isDiving && !diving.has(a.id)) {
            diving.add(a.id);
            passesBy.set(a.id, (passesBy.get(a.id) ?? 0) + 1);
            if (prevState.get(a.id) === F.NPC_STATE.AIM) telegraphed++;
            else ambushed++;
          } else if (!isDiving) {
            diving.delete(a.id);
          }
          if (isDiving) dived = true;
          prevState.set(a.id, a.state);
        }
      }
      const passes = [...passesBy.values()];
      const most = passes.length ? Math.max(...passes) : 0;
      check(
        worstDrift < 0.05,
        `the probe stood where it was put, all 840 ticks of it (worst drift ${worstDrift.toFixed(2)} m) -- ` +
          'a scene inside a building would move it and the swoop would read as a miss',
      );
      check(dived, 'a magpie left its branch at a player standing under the nest');
      check(lowest < 2, `the arc brought it within ${lowest.toFixed(2)} m of the player in plan`);
      check(taken > 0, 'and it connected -- the arc passes through head height rather than aiming at it');
      check(
        odd === 0 && taken > 0,
        `${taken} of a pip came off in ${(taken / 0.25).toFixed(0)} hits, every one of them exactly a quarter`,
      );
      check(
        most > 0 && most <= MT.maxSwoops,
        `the busiest magpie swooped ${most} time(s) before perching -- the tuned ${MT.maxSwoops}, then a stare`,
      );
      // The telegraph, from the wire's own bytes. Every dive in this window was
      // announced, and the announcement is a state a client can decode: that is
      // what makes the alarm audible online as well as in `?offline`.
      check(
        ambushed === 0 && telegraphed > 0,
        `all ${telegraphed} dives came out of the alarm state and none out of nowhere -- ` +
          `${(MT.telegraphTicks / 60).toFixed(2)} s of warning, on a byte the wire already carries`,
      );
    }

    // And the arc itself, run twice over two independent fields from the same
    // starting state.
    //
    // Position to nine decimals over the whole dive: this is the one part of
    // the feature where the authority and every client are drawing the same
    // curve from the same handful of numbers, and a difference would be a
    // magpie in two places. Two `FactionField`s rather than two modules -- see
    // the note at the top of this function -- driven through the framework's
    // own `step`, so what is being compared is the real `think` and not a
    // re-derivation of it.
    {
      const trace = (): string[] => {
        const field = new F.FactionField();
        const victim = createCombatant(0, 0, 0);
        victim.body.position.set(14, EYE_HEIGHT, 0);
        const ctx = {
          tick: 5_000_000,
          dt: 1 / 60,
          collision: null,
          groundHeight: () => 0,
          peds: null,
          combatants: [victim],
          field,
          investigationOf: () => undefined,
          damagePlayer: () => {},
          emit: () => {},
        } as unknown as Parameters<typeof F.FactionField.prototype.step>[0];
        const bird = field.promote(F.NPC_KIND.MAGPIE, 0, 7.5, 0, 0, 1, -1);
        if (bird === null) return [];
        bird.homeX = 0;
        bird.homeZ = 0;
        const path: string[] = [];
        for (let i = 0; i < 200; i++) {
          ctx.tick = 5_000_000 + i;
          field.step(ctx);
          const a = field.actors[0];
          if (!a) break;
          path.push(`${a.state}:${a.x.toFixed(9)}:${a.y.toFixed(9)}:${a.z.toFixed(9)}`);
        }
        return path;
      };
      const a = trace();
      const b = trace();
      check(a.length > 100, `the swoop trace ran for ${a.length} ticks through the framework's own step`);
      check(
        a.length === b.length && a.every((v, i) => v === b[i]),
        'two independent fields flew the identical arc, to nine decimals, for every tick of it',
      );
      // And it actually came down through head height, which is the property
      // the two-quadratic construction exists to guarantee.
      let lowest = Infinity;
      for (const row of a) {
        const y = Number(row.split(':')[2]);
        if (y < lowest) lowest = y;
      }
      check(
        lowest < EYE_HEIGHT + 0.5,
        `the arc came down to ${lowest.toFixed(2)} m, through a player's ${EYE_HEIGHT} m head height`,
      );
    }
  }

  // --- 9b..9d. The mercy: what a player who *does* something gets out of it.
  //
  // The reported bug was two sentences -- *"the magpies are too hard to avoid
  // and de aggro based on distance too slow"* -- and both halves are things
  // section 9 above cannot see, because a probe that stands still experiences
  // neither. So these three run the same simulation with the probe **moving**,
  // which is the only way to test a swoop that is aimed at a prediction:
  //
  //   9b  a sprint straight through the radius takes at most one hit
  //   9c  turning and running ends the engagement inside a second and a half
  //   9d  leaving and coming straight back buys one pass, not another campaign
  //
  // All three assert against `MAGPIE_TUNING`, and all three are run on nests in
  // *other suburbs* from section 9's -- a magpie resolves once the player is
  // past `WAKE_MAGPIE * 1.35`, so moving kilometres away is what guarantees each
  // block starts against a bird with no history.
  {
    /** Every magpie nest near a point, nearest anchor first. */
    const findNests = (qx: number, qz: number, radius: number): Array<{ x: number; z: number }> => {
      const scratch = one.createWildScratch();
      const pose = one.createWildPose();
      const found: Array<{ x: number; z: number; d: number }> = [];
      one.forEachWildlifeNear(world.peds, qx, qz, radius, trafficTick(Date.now()), ground, scratch, pose, (p) => {
        if (p.kind !== F.NPC_KIND.MAGPIE) return;
        found.push({ x: p.ax, z: p.az, d: (p.ax - qx) ** 2 + (p.az - qz) ** 2 });
      });
      found.sort((l, r) => l.d - r.d);
      return found.map((f) => ({ x: f.x, z: f.z }));
    };

    /**
     * Whether a player can actually run this line without the city stopping them.
     *
     * `standNear`'s lesson applied to a *path* rather than to a point: a check
     * that scripts a sprint down a footpath and never verifies the footpath is
     * clear is a check that measures a wall. Walked in half-metre steps through
     * the same `CollisionWorld.resolve` the controller uses, at a bird's-eye
     * 42 cm step height, because the probe has to cover the whole corridor for
     * the claim ("a sprint through the radius") to mean anything.
     */
    //
    // **And flat enough that a sprint stays a sprint.** The gradient test is the
    // middle ring's doing: at 5,300 m every candidate corridor was inner-city
    // and level, and the run held 7.90-8.07 m/s of an 8.2 m/s sprint. The
    // 15,300 m world reaches the Chatswood and Killara ridges, where the first
    // clear forty metres the search finds can be a 1-in-8 street -- and the
    // probe then measures 7.04 m/s, which fails a floor that is asserting
    // something about the *magpie's* arithmetic rather than about the hill. The
    // corridor is meant to be a controlled straight line; a grade cap is part of
    // controlling it, and it belongs here rather than in a looser floor, because
    // loosening the floor is exactly how this check would stop meaning anything.
    const MAX_GRADE = 0.06;
    const clearRun = (sx: number, sz: number, ux: number, uz: number, len: number): boolean => {
      let x = sx;
      let z = sz;
      let last = ground(sx, sz);
      if (!Number.isFinite(last)) return false;
      for (let i = 0; i < len * 2; i++) {
        const nx = x + ux * 0.5;
        const nz = z + uz * 0.5;
        const g = ground(nx, nz);
        if (!Number.isFinite(g)) return false;
        // Per half-metre step, so this is a local slope rather than an average
        // that a dip and a rise could cancel out of.
        if (Math.abs(g - last) > MAX_GRADE * 0.5) return false;
        last = g;
        const m = world.collision.resolve(x, z, nx, nz, PLAYER_RADIUS, g + 0.42);
        if (Math.hypot(m.x - nx, m.z - nz) > 0.01) return false;
        x = m.x;
        z = m.z;
      }
      return true;
    };

    /** Sixteen bearings, no trig in the caller. Unit vectors on the compass rose. */
    const bearings: Array<[number, number]> = [];
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      bearings.push([Math.cos(a), Math.sin(a)]);
    }

    /** Sum of the drops in the probe's health, topping it back up every tick. */
    const topUp = (): number => {
      const drop = MAX_HEALTH - probe.combat.health;
      probe.combat.health = MAX_HEALTH;
      return drop > 0 ? drop : 0;
    };

    const candidates = [
      ...findNests(416.6, 1204.6, 350),
      ...findNests(2452.5, 3279.5, 350),
      ...findNests(-1751.2, 3411.8, 350),
      ...findNests(527.1, -94.7, 350),
    ];

    /**
     * Claim a nest for one of these blocks, and never hand out one near it again.
     *
     * **This is not tidiness, it is the fixture.** A magpie remembers: after an
     * engagement it holds `MAGPIE_TUNING.cooldownTicks` of boredom and a spent
     * campaign, and it only forgets by resolving, which needs the player past
     * 40 m. The first cut of these blocks let 9c and 9d pick the same nest and
     * 9d then measured a bird 9c had already exhausted -- it reported "the first
     * visit was a full campaign: 0 passes", which is a correct measurement of
     * the wrong bird. Two hundred metres is comfortably outside the wake radius
     * either way, so each block gets an animal with no history.
     */
    const taken: Array<{ x: number; z: number }> = [];
    const takeNest = (ok: (c: { x: number; z: number }) => boolean): { x: number; z: number } | null => {
      for (const c of candidates) {
        if (taken.some((t) => Math.hypot(t.x - c.x, t.z - c.z) < 200)) continue;
        if (!ok(c)) continue;
        taken.push(c);
        return c;
      }
      return null;
    };

    // --- 9b. A sprint straight through the radius.
    //
    // The run starts `SWOOP_RANGE` outside the nest and finishes the same
    // distance the other side, so the probe crosses the whole engagement radius
    // and passes directly under the tree -- the worst line there is. It is
    // driven by **real input through the real controller**, not teleported:
    // the magpie aims at `position + velocity`, and a probe moved by hand with
    // `place` has a velocity of zero and would be read as standing still. That
    // is the difference between testing the dodge and testing nothing.
    {
      let ran: { nest: { x: number; z: number }; ux: number; uz: number } | null = null;
      const reach = MT.swoopRange;
      const nest = takeNest((c) => bearings.some(([ux, uz]) => {
        const sx = c.x - ux * reach;
        const sz = c.z - uz * reach;
        return Number.isFinite(ground(sx, sz)) && clearRun(sx, sz, ux, uz, reach * 2);
      }));
      if (nest) {
        for (const [ux, uz] of bearings) {
          const sx = nest.x - ux * reach;
          const sz = nest.z - uz * reach;
          if (!Number.isFinite(ground(sx, sz))) continue;
          if (!clearRun(sx, sz, ux, uz, reach * 2)) continue;
          ran = { nest, ux, uz };
          break;
        }
      }
      if (!ran) {
        check(false, `a ${MT.swoopRange * 2} m clear run through a magpie nest could be found somewhere in the city`);
      } else {
        const { nest, ux, uz } = ran;
        const sx = nest.x - ux * reach;
        const sz = nest.z - uz * reach;
        const yaw = Math.atan2(-ux, -uz);
        place(sx, sz, yaw);
        sim.factions.clearInvestigation(probe.id);
        probe.combat.health = MAX_HEALTH;
        // --- What is counted, and the flake that decided it.
        //
        // **`NPC_STATE.FIRE` rather than the health bar.** This check used to
        // sum every pip the probe lost during the run and call the total the
        // magpie's doing. It failed about one run in three at the deploy gate
        // with *"cost 1 of a pip"* and *"cost 2 of a pip"* -- and a swoop is
        // `SWOOP_DAMAGE`, a quarter. One pip is `traffic.CAR_DAMAGE`. The
        // corridor is forty metres of a real Sydney street and the cars on it
        // are a pure function of `Date.now()` by design, so whether the probe
        // gets run over on its way past the tree depends on the wall clock the
        // suite happened to start at. The bird was never involved.
        //
        // Swept over 150 wall-clock phases spanning two minutes, with the
        // corridor and the nest held fixed: **zero** swoop connections, at
        // every phase, and 31 car-sized hits scattered across them. The same
        // corridor with the probe *standing still* connects. So the failure was
        // in the instrument and not in the bird, and the fix is to measure the
        // bird.
        //
        // `FIRE` is the exact answer to "did this pass connect": `MAGPIE.think`
        // enters it on the tick the sphere test succeeds and holds it for the
        // rest of the dive, which is why `main.ts` can play `birdStrike` off its
        // rising edge. It is on the wire, it is per-actor, and no car, fall or
        // footy can forge one.
        //
        // **The phase is deliberately not pinned.** It could be -- but it would
        // buy nothing here and cost something. The magpie half of this scenario
        // is already phase-independent (that is what the 150-phase sweep says),
        // so pinning would only hide a future regression that happened to bite
        // at an unpinned phase, and the machinery to do it means either patching
        // `Date.now` under a `Simulation` that other checks in this function
        // share, or giving `trafficTick` an injectable clock -- a change to a
        // shared determinism path, which PERFORMANCE.md's closing note already
        // argues is the wrong trade for a test. The car damage is still
        // *reported* below, because a reader looking at a probe that lost two
        // pips deserves to be told it was the traffic.
        let magpieHits = 0;
        let swoopSizedDrops = 0;
        let trafficDamage = 0;
        let dives = 0;
        let awake = 0;
        const diving = new Set<number>();
        const connected = new Set<number>();
        let travelled = 0;
        let path = 0;
        let ticks = 0;
        let prevX = probe.combat.body.position.x;
        let prevZ = probe.combat.body.position.z;
        for (let i = 0; i < 60 * 10; i++) {
          probe.input.forward = 1;
          probe.input.sprint = true;
          probe.input.yaw = yaw;
          probe.combat.body.yaw = yaw;
          sim.step(out);
          ticks++;
          const drop = topUp();
          if (drop > 1e-9) {
            if (Math.abs(drop - MT.swoopDamage) < 1e-6) swoopSizedDrops++;
            else trafficDamage += drop;
          }
          const px = probe.combat.body.position.x;
          const pz = probe.combat.body.position.z;
          path += Math.hypot(px - prevX, pz - prevZ);
          prevX = px;
          prevZ = pz;
          travelled = Math.hypot(px - sx, pz - sz);
          const live = birds(F.NPC_KIND.MAGPIE);
          awake = Math.max(awake, live.length);
          for (const a of live) {
            const isDiving = a.state === F.NPC_STATE.CHASE || a.state === F.NPC_STATE.FIRE;
            if (isDiving && !diving.has(a.id)) {
              diving.add(a.id);
              dives++;
            } else if (!isDiving) {
              diving.delete(a.id);
            }
            // The connection, on the rising edge of the state that means it.
            if (a.state === F.NPC_STATE.FIRE) {
              if (!connected.has(a.id)) {
                connected.add(a.id);
                magpieHits++;
              }
            } else {
              connected.delete(a.id);
            }
          }
          if (travelled >= reach * 2) break;
        }
        probe.input.forward = 0;
        probe.input.sprint = false;
        const meanSpeed = ticks > 0 ? path / (ticks / 60) : 0;
        // The corridor, asserted rather than assumed. A probe that stopped after
        // four metres never went through the radius, and every number after this
        // would be a measurement of a wall.
        check(
          travelled > reach * 1.6,
          `the probe sprinted ${travelled.toFixed(0)} m of a ${(reach * 2).toFixed(0)} m corridor straight ` +
            'through the nest -- driven by the controller, so the magpie saw a real velocity',
        );
        // **And that it sprinted, not merely that it arrived.** The whole dodge
        // is arithmetic on speed: the commit leads by `commitLeadTicks` and the
        // strike lands `flightTicks` later, which only puts a sprinter clear if
        // the sprinter is actually doing 8.2 m/s. A corridor that grew a kerb
        // hop, a wade or a parked car would slow the probe and quietly turn this
        // into a test of a jog -- which the magpie *can* read. Measured range
        // over the sweep was 7.90 to 8.07 m/s, so 7.5 is a floor with headroom
        // rather than a number chosen to pass.
        check(
          meanSpeed >= 7.5,
          `and held ${meanSpeed.toFixed(2)} m/s of the 8.2 m/s sprint the whole way (floor 7.5) -- ` +
            'below that the commit-lead arithmetic stops guaranteeing a miss and this would be ' +
            'measuring the terrain',
        );
        check(awake > 0, `the nest was live for the run (${awake} magpie(s) promoted)`);
        // The bird has to have *tried*. Without this a magpie that never left
        // the branch -- switched off, mis-tuned, never promoted -- would sail
        // through the assertion below, which is the one way "it missed" and "it
        // was not there" look identical from the outside.
        check(
          dives > 0,
          `the magpie committed ${dives} pass(es) at the sprinter rather than staying put -- ` +
            'a bird that never dived would pass a miss test for the wrong reason',
        );
        check(
          magpieHits === 0 && swoopSizedDrops === magpieHits,
          `and connected ${magpieHits} time(s) of them. The commit leads by ${MT.commitLeadTicks} ticks and ` +
            `lands ${MT.flightTicks}, so a sprint is ` +
            `${(8.2 * (MT.flightTicks / 60) - MT.commitLeadMax).toFixed(1)} m clear of where the bird went` +
            (trafficDamage > 0
              ? `. (${trafficDamage} pip(s) of traffic hit the probe on the way through -- that is the street, ` +
                'not the bird, and it is why this counts FIRE edges rather than health.)'
              : ''),
        );
      }
    }

    // --- 9c. Turn and run: the engagement is over inside a second and a half.
    //
    // The direct answer to *"de aggro based on distance too slow"*. The probe
    // stands under the nest until the alarm starts -- which is the moment a
    // player would actually react -- and then sprints out. What is timed is the
    // gap between that and the bird being perched with its campaign spent.
    {
      const nest = takeNest((c) => standNear(c.x, c.z, 7) !== null);
      const stand = nest ? standNear(nest.x, nest.z, 7) : null;
      let escape: [number, number] | null = null;
      if (nest && stand) {
        for (const [ux, uz] of bearings) {
          if (clearRun(stand.x, stand.z, ux, uz, MT.disengageRange + 6)) {
            escape = [ux, uz];
            break;
          }
        }
      }
      if (!nest || !stand || !escape) {
        check(false, 'a magpie nest with somewhere to stand under it and somewhere to run to could be found');
      } else {
        const [ux, uz] = escape;
        const yaw = Math.atan2(-ux, -uz);
        place(stand.x, stand.z, yaw);
        probe.combat.health = MAX_HEALTH;
        let alarmedAt = -1;
        let doneAt = -1;
        for (let i = 0; i < 60 * 20 && doneAt < 0; i++) {
          const live = birds(F.NPC_KIND.MAGPIE);
          if (alarmedAt < 0 && live.some((a) => a.state === F.NPC_STATE.AIM)) alarmedAt = i;
          if (alarmedAt < 0) {
            // Standing still, waiting to be noticed. `place` holds the probe and
            // zeroes its velocity, which is exactly a player who has stopped.
            place(stand.x, stand.z, yaw);
          } else {
            probe.input.forward = 1;
            probe.input.sprint = true;
            probe.input.yaw = yaw;
            probe.combat.body.yaw = yaw;
          }
          sim.step(out);
          probe.combat.health = MAX_HEALTH;
          if (alarmedAt >= 0) {
            const after = birds(F.NPC_KIND.MAGPIE);
            // Done: nothing is diving, nothing is winding up, and the campaign
            // is spent -- which is the state `breakOffSwoop` leaves it in.
            const busy = after.some((a) => a.state !== F.NPC_STATE.IDLE);
            if (!busy && after.length > 0) doneAt = i;
            if (after.length === 0) doneAt = i;
          }
        }
        probe.input.forward = 0;
        probe.input.sprint = false;
        check(alarmedAt >= 0, 'standing under a nest got the probe an alarm to react to');
        check(
          doneAt >= 0 && doneAt - alarmedAt <= 90,
          `turning and running ended the engagement in ${((doneAt - alarmedAt) / 60).toFixed(2)} s ` +
            `(the rule is 1.5). Outward travel over ${MT.breakOffSpeed} m/s breaks a magpie off inside the ` +
            'pass it is already in, rather than at the aggro radius twelve metres later',
        );
      }
    }

    // --- 9d. Leaving and coming straight back is worth one pass, not two.
    //
    // The cooldown exists because the counterplay must not also be a way of
    // ordering more swoops: stepping outside `SWOOP_RANGE` and back used to
    // reset the campaign outright, so the correct play and the exploit were the
    // same play. The probe is teleported here rather than run, deliberately --
    // what is being tested is the *bookkeeping* across a disengage, and a
    // stationary arrival is the case that gets hit, so this is the harshest
    // version of the question.
    {
      const nest = takeNest((c) => standNear(c.x, c.z, 7) !== null && standNear(c.x, c.z, 25) !== null);
      const near = nest ? standNear(nest.x, nest.z, 7) : null;
      const far = nest ? standNear(nest.x, nest.z, 25) : null;
      const farD = nest && far ? Math.hypot(far.x - nest.x, far.z - nest.z) : 0;
      if (!nest || !near || !far || farD <= MT.swoopRange || farD >= 38) {
        check(false, 'a magpie nest with standable ground at 7 m and outside 20 m could be found');
      } else {
        /** Dives per actor id over `ticks`, with the probe parked at a spot. */
        const watch = (x: number, z: number, ticks: number): Map<number, number> => {
          const seen = new Map<number, number>();
          const diving = new Set<number>();
          for (let i = 0; i < ticks; i++) {
            place(x, z, 0);
            sim.step(out);
            probe.combat.health = MAX_HEALTH;
            for (const a of birds(F.NPC_KIND.MAGPIE)) {
              const isDiving = a.state === F.NPC_STATE.CHASE || a.state === F.NPC_STATE.FIRE;
              if (isDiving && !diving.has(a.id)) {
                diving.add(a.id);
                seen.set(a.id, (seen.get(a.id) ?? 0) + 1);
              } else if (!isDiving) {
                diving.delete(a.id);
              }
            }
          }
          return seen;
        };
        probe.combat.health = MAX_HEALTH;
        const first = watch(near.x, near.z, 60 * 12);
        const busiestFirst = first.size ? Math.max(...first.values()) : 0;
        // Out past the aggro radius -- but nowhere near far enough to resolve
        // the actor, which would hand the returning player a brand new bird and
        // make the cooldown untestable. Three seconds is enough for the perched
        // branch to arm it.
        watch(far.x, far.z, 60 * 3);
        const held = birds(F.NPC_KIND.MAGPIE).length;
        const again = watch(near.x, near.z, 60 * 12);
        const busiestAgain = again.size ? Math.max(...again.values()) : 0;
        check(
          busiestFirst === MT.maxSwoops,
          `the first visit was a full campaign: ${busiestFirst} passes, which is the tuned ${MT.maxSwoops}`,
        );
        check(
          held > 0 && farD < 40,
          `standing ${farD.toFixed(0)} m off ended the engagement without resolving the bird (${held} still awake) ` +
            '-- so what is measured next is the same magpie remembering, not a fresh one',
        );
        check(
          busiestAgain <= 1,
          `walking back inside the ${(MT.cooldownTicks / 60).toFixed(0)} s cooldown bought ${busiestAgain} ` +
            'pass, not another campaign -- leaving is the counterplay, not a way of ordering more swoops',
        );
      }
    }
  }

  // --- 10. The cap, from both sides.
  //
  // A field full of police pursuers must survive a park full of birds, and the
  // birds must survive being refused. `FactionField.promote` evicts the
  // lowest-priority actor and a bird with no target scores below every officer
  // on a pursuit, so the correct behaviour is that **nothing at all happens**:
  // no bird is promoted, no officer is evicted, and the park goes on being a
  // hash.
  {
    const field = new F.FactionField();
    const suspect = createCombatant(0, -2236.4, 4543.3);
    suspect.body.position.set(-2236.4, ground(-2236.4, 4543.3) + EYE_HEIGHT, 4543.3);
    // **A real pursuit, not twenty-four idle bodies.** `actorPriority` scores an
    // actor with no target at 2 and a fresh promotion at 3, so a field full of
    // *idle* officers is a field a bird is entitled to evict from -- correctly,
    // because nobody is chasing anybody. The claim worth checking is the other
    // one: that a bird cannot take a slot off an officer who is actually on
    // somebody. So the officers are given a target that exists in
    // `ctx.combatants`, and a live investigation to keep them on it.
    const investigation = { playerId: suspect.id, reason: F.REASON.ASSAULT, ticks: 3000, since: 0 };
    const ctx = {
      tick: trafficTick(Date.now()),
      dt: 1 / 60,
      collision: world.collision,
      groundHeight: (x: number, z: number, feet: number) => probeWorld.groundHeight(x, z, feet),
      peds: world.peds,
      combatants: [suspect],
      field,
      investigationOf: (id: number) => (id === suspect.id ? investigation : undefined),
      damagePlayer: () => {},
      emit: () => {},
    } as unknown as Parameters<typeof one.stepWildlife>[0];
    for (let i = 0; i < F.MAX_ACTORS; i++) {
      field.promote(F.NPC_KIND.POLICE, -2200 + i * 2, ground(-2200 + i * 2, 4543) , 4543, 0, 1, suspect.id);
    }
    check(field.actors.length === F.MAX_ACTORS, `the field is full of pursuers: ${field.actors.length} of ${F.MAX_ACTORS}`);
    const scratch = one.createWildScratch();
    const pose = one.createWildPose();
    // One `step` first, so the field has seen the combatant list -- `targetOf`
    // reads it, and an officer whose target cannot be resolved scores as an idle
    // one no matter what its `target` field says.
    field.step(ctx);
    for (let i = 0; i < 20; i++) one.stepWildlife(ctx, scratch, pose);
    check(
      field.actors.length === F.MAX_ACTORS,
      `twenty ticks of wildlife promotion against a full field left it at ${field.actors.length} -- nothing evicted`,
    );
    check(
      field.actors.every((a) => a.kind === F.NPC_KIND.POLICE),
      'and not one bird displaced an officer on a pursuit',
    );

    // The other direction: an empty field, and the birds stop at their own
    // budget rather than at the framework's.
    const open = new F.FactionField();
    const openCtx = { ...ctx, field: open } as typeof ctx;
    for (let i = 0; i < 300; i++) one.stepWildlife(openCtx, scratch, pose);
    check(
      open.actors.length > 0 && open.actors.length <= one.WILDLIFE_BUDGET,
      `an empty field woke ${open.actors.length} birds and stopped at the ${one.WILDLIFE_BUDGET} wildlife budget`,
    );
    check(
      open.actors.every((a) => one.isProtected(a.kind)),
      'every one of them is one of the three protected natives',
    );
    // Homed on the anchor rather than on the spawn point, which is what stops a
    // turkey being promoted twice while it is out chasing somebody.
    let doubled = 0;
    for (let i = 0; i < open.actors.length; i++) {
      for (let j = i + 1; j < open.actors.length; j++) {
        const a = open.actors[i];
        const b = open.actors[j];
        if (a.kind !== b.kind) continue;
        if (Math.hypot(a.homeX - b.homeX, a.homeZ - b.homeZ) < 0.25) doubled++;
      }
    }
    check(doubled === 0, `no anchor woke twice (${doubled} duplicates) -- the promotion is idempotent per bird`);
  }
}

/**
 * The footy supply, from an empty bar back to three, **off the real wire**.
 *
 * This exists because of a reported bug that every check in this file already
 * passed through: *"for some reason my 3rd afl ball never loads"*. Every number
 * in the game was right. `verifyCombat` proved the trickle, the block in
 * `checkFooty` proved one ball back per 4 s and a cap of three, and the snapshot
 * round-trips `ballCharges` exactly -- while the third block of the bar the
 * player is actually looking at stayed dark for the rest of the session.
 *
 * It turned out to be the HUD's paint and nothing on this side, which is why the
 * *width* half of the regression is `hud.verifyHud` and runs in the browser at
 * boot: `server/tsconfig.json` has no DOM on purpose, and importing `hud.ts`
 * here to assert it would trade a real architectural invariant for one check.
 *
 * What belongs here is the half this file can actually own -- that the count a
 * client is *told* comes back one ball at a time and reaches three. It was true
 * before the fix and it is true after it, and that is the point: with both
 * checks in place, the next report of this shape is answered by which one fails.
 */
async function checkBallBar(): Promise<void> {
  say('footy supply: the bar the player looks at, from empty to three, off the wire');

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const me = sim.join(0, null, 'Baller');
  const into: SnapshotPlayer[] = [];
  const wire = createSnapshot();

  /** What the wire says this player is holding, this tick. */
  const onTheWire = (): number => {
    const frame = encodeSnapshot(sim.tick, 0, sim.snapshot(into), [], []);
    const back = decodeSnapshot(frame, wire);
    return back?.players.find((p) => p.id === me.id)?.ballCharges ?? -1;
  };

  // --- 1. Empty it, through the real 0.55 s floor. The clock starts at the tick
  // the third ball leaves the hand, which is where `advance` zeroes `ballT`.
  let ticks = 0;
  while (me.combat.ballCharges > 0 && ticks < 600) {
    applyButtons(me.input, BTN.THROW);
    sim.step(out);
    ticks++;
  }
  check(me.combat.ballCharges === 0, `a full bar empties in ${(ticks / 60).toFixed(2)} s of holding the throw`);
  check(onTheWire() === 0, `and the wire says 0 (${onTheWire()})`);

  // --- 2. The refill, sampled 200 ms past each boundary so a check does not
  // straddle the tick it is about. Only the wire is read: the point of the
  // sample is what a client is *told*, not what the server privately knows.
  const seen = new Map<number, number>();
  const marks = [4.2, 8.2, 12.2];
  let t = 0;
  let next = 0;
  let harassed = 0;
  for (let i = 0; i < 60 * 13; i++) {
    applyButtons(me.input, 0);
    // --- Kept on their feet, because the subject is the **bar** and not the
    // probe's life expectancy.
    //
    // `sim.join` puts this player on the real join disc in Sydney Park and then
    // asks them to stand still for thirteen seconds in a city that contains
    // bush turkeys, traffic and a police force. Measured over thirty pinned
    // clock phases, one of them ends with `health = 0` and the phase set
    // `[idle, ko]` -- and a knocked-out player's recharge stops, so the third
    // ball never arrives and the check reports *"12.2 s after the bar emptied
    // the wire carries 2 ball(s)"*. Nothing about the supply was wrong; the
    // tester was pecked to death.
    //
    // Topping the bar's owner up is the narrowest possible way to say "this
    // check is about the trickle". It cannot mask a supply regression, because
    // health and `ballCharges` are different fields on different clocks, and the
    // interference is reported below rather than swallowed.
    if (me.combat.health < MAX_HEALTH) {
      me.combat.health = MAX_HEALTH;
      harassed++;
    }
    sim.step(out);
    t += 1 / 60;
    if (next < marks.length && t >= marks[next]) {
      seen.set(marks[next], onTheWire());
      next++;
    }
  }
  for (let i = 0; i < marks.length; i++) {
    const want = i + 1;
    const got = seen.get(marks[i]);
    check(
      got === want,
      `${marks[i]} s after the bar emptied the wire carries ${got} ball(s), and the ` +
        `${BALL_RECHARGE} s trickle says ${want}`,
    );
  }
  if (harassed > 0) {
    say(`  note: the city had a go at the probe on ${harassed} tick(s) -- traffic or wildlife on the join disc -- and it was held on its feet so the trickle could be read.`);
  }
  check(me.combat.ballCharges === BALL_CHARGES, `the bar is back to ${BALL_CHARGES}/${BALL_CHARGES}`);

  // --- 3. And it stays there. The cap is the other half of the trickle, and a
  // regen that ran on past it would be a bar that emptied four balls once.
  for (let i = 0; i < 60 * 8; i++) {
    applyButtons(me.input, 0);
    sim.step(out);
  }
  check(
    onTheWire() === BALL_CHARGES,
    `eight more seconds of not throwing leaves it at ${onTheWire()} -- the cap holds on the wire too`,
  );
}

/**
 * PERFORMANCE.md phase 1, and the whole of its claim to have changed nothing.
 *
 * Three optimisations went into the 60 Hz tick -- a spatial hash feeding the
 * candidate sets, pooled records where fresh ones were being allocated, and one
 * broadcast buffer where there used to be one per client -- and every one of
 * them is the kind of change that is *almost* invisible when it is wrong. A
 * candidate set that is a superset except at negative x is a punch that lands
 * on one side of the CBD and passes through people on the other. A pooled
 * snapshot record that is not fully rewritten carries a dead player's health
 * into a live player's row for one frame. A shared broadcast buffer that is
 * mutated after the send gives four hundred clients somebody else's ack.
 *
 * So this asserts **identity, not similarity**: the same victim, the same
 * pickup, the same bytes. Where a thing can be computed two ways it is computed
 * two ways over randomised configurations and the two answers are compared.
 *
 * The randomisation is the project's own integer hash rather than
 * `Math.random`, so a failure here is reproducible from the seed printed beside
 * it.
 */
async function checkSpatialHash(): Promise<void> {
  say('spatial hash + zero-alloc encode: identical answers, identical bytes');

  // --- 0. The module's own boot check, in this process.
  {
    const f = verifySpatialHash();
    check(f.length === 0, `verifySpatialHash passes${f.length ? ` -- ${f[0]}` : ''}`);
  }

  let seed = 987654321;
  const rand = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
    return ((seed >>> 8) & 0xffffff) / 0x1000000;
  };

  // --- 1. The melee. `hitTest` over a rewound *candidate set* has to name the
  // same victim as `hitTest` over a rewound *everybody*, at every latency and
  // every geometry, or spec 8.2's punch has quietly changed.
  //
  // The scenario is the one that can actually break it: everybody moving, so
  // the rewind window is a real box rather than a point, and a mix of view
  // times so some targets are looked up 250 ms back and some not at all. The
  // crowd is deliberately dense -- 1.2 m spacing against a 1.55 m reach -- so
  // that the answer is usually *some* victim rather than usually null, which is
  // what makes an agreeing pair of nulls worth nothing.
  {
    let trials = 0;
    let landed = 0;
    let disagreements = 0;
    let missingCandidate = 0;

    for (let trial = 0; trial < 200; trial++) {
      const n = 4 + Math.floor(rand() * 24);
      const combatants: CombatantState[] = [];
      const histories = new Map<number, PositionHistory>();
      // Half the trials are centred west and south of the origin, which is
      // where a cell index that truncates instead of flooring goes wrong.
      const ox = (rand() - 0.5) * 6000;
      const oz = (rand() - 0.5) * 6000;

      for (let i = 0; i < n; i++) {
        const c = createCombatant(i + 1, ox + (rand() - 0.5) * 12, oz + (rand() - 0.5) * 12);
        c.body.position.y = EYE_HEIGHT;
        c.body.yaw = (rand() - 0.5) * Math.PI * 2;
        c.body.pitch = (rand() - 0.5) * 0.8;
        if (rand() < 0.15) c.health = 0;
        combatants.push(c);

        // A real 250 ms of movement behind each of them, at up to a sprint, so
        // the bounding box has genuine extent and a lookup lands between two
        // samples rather than on one.
        const h = new PositionHistory();
        const vx = (rand() - 0.5) * 16;
        const vz = (rand() - 0.5) * 16;
        for (let t = 0; t < HISTORY_TICKS; t++) {
          h.record(
            1000 + t,
            c.body.position.x - vx * (HISTORY_TICKS - 1 - t) / 60,
            EYE_HEIGHT,
            c.body.position.z - vz * (HISTORY_TICKS - 1 - t) / 60,
            c.body.yaw,
          );
        }
        histories.set(c.id, h);
      }

      // The grid, exactly as `Simulation.buildRewindIndex` builds it.
      const index = new SpatialHash<CombatantState>();
      const bounds = createBounds();
      for (const c of combatants) {
        histories.get(c.id)!.bounds(bounds);
        index.insertBox(
          c, c.body.position.x, c.body.position.z,
          Math.min(bounds.minX, c.body.position.x), Math.min(bounds.minZ, c.body.position.z),
          Math.max(bounds.maxX, c.body.position.x), Math.max(bounds.maxZ, c.body.position.z),
        );
      }

      for (const attacker of combatants) {
        if (attacker.health <= 0) continue;
        const viewTick = 1000 + HISTORY_TICKS - 1 - rand() * (HISTORY_TICKS - 1);
        trials++;

        // The reference: rewind the whole world, exactly as this file did
        // before the grid existed.
        const wholeWorld: CombatantState[] = [];
        const reference = hitTest(
          attacker,
          rewind(attacker, combatants, histories, viewTick, wholeWorld),
        );

        // And the grid's answer.
        const candidates: CombatantState[] = [];
        index.collectWithin(attacker.body.position.x, attacker.body.position.z, REACH, candidates);
        const pool: CombatantState[] = [];
        const proxies: RewoundProxy[] = [];
        const hashed = hitTest(
          attacker,
          rewindInto(attacker, candidates, histories, viewTick, pool, proxies),
        );

        if ((reference?.id ?? 0) !== (hashed?.id ?? 0)) disagreements++;
        if (reference !== null) {
          landed++;
          // The stronger statement, and the one that says *why* when it fails:
          // whoever the full scan found must have been in the candidate set at
          // all. A disagreement with a present candidate is a bug in the
          // rewind; a disagreement with an absent one is a bug in the grid.
          if (!candidates.some((c) => c.id === reference.id)) missingCandidate++;
        }
      }
    }

    check(trials > 2000, `${trials} randomised swings adjudicated both ways`);
    check(landed > 200, `${landed} of them landed on somebody -- a check where nothing connects proves nothing`);
    check(
      missingCandidate === 0,
      `every victim the full scan found was in the grid's candidate set (${missingCandidate} were not)`,
    );
    check(
      disagreements === 0,
      `the grid and the full scan named the same victim every time (${disagreements} disagreements)`,
    );
  }

  // --- 2. The pickups. The same 884-point-times-everybody sweep, hashed and
  // not, over the same points -- and the *point state* is compared as well as
  // the events, because a pickup that fired against the wrong body still leaves
  // the cafe empty and would look right in the event list.
  {
    let disagreements = 0;
    let pickups = 0;
    for (let trial = 0; trial < 120; trial++) {
      const ox = (rand() - 0.5) * 4000;
      const oz = (rand() - 0.5) * 4000;
      const n = 2 + Math.floor(rand() * 30);
      const combatants: CombatantState[] = [];
      for (let i = 0; i < n; i++) {
        const c = createCombatant(i + 1, ox + (rand() - 0.5) * 40, oz + (rand() - 0.5) * 40);
        c.body.position.y = EYE_HEIGHT + (rand() < 0.2 ? 3 : 0);
        if (rand() < 0.1) c.phase = 'ko';
        combatants.push(c);
      }
      // Two identical sets of points, one for each way of running the sweep.
      const a: ReturnType<typeof createPoint>[] = [];
      const b: ReturnType<typeof createPoint>[] = [];
      const m = 20 + Math.floor(rand() * 60);
      for (let i = 0; i < m; i++) {
        const px = ox + (rand() - 0.5) * 44;
        const pz = oz + (rand() - 0.5) * 44;
        const kind: PowerupKind = rand() < 0.5 ? 0 : 1;
        a.push(createPoint(`t:${i}`, kind, px, 0, pz));
        b.push(createPoint(`t:${i}`, kind, px, 0, pz));
      }

      const index = new SpatialHash<CombatantState>();
      for (const c of combatants) index.insert(c, c.body.position.x, c.body.position.z);

      // Two fresh combatant sets, because `tickPowerups` *applies* the powerup
      // and a shared body would carry the first run's effect into the second.
      const copy = combatants.map((c) => {
        const d = createCombatant(c.id, c.body.position.x, c.body.position.z);
        d.body.position.y = c.body.position.y;
        d.phase = c.phase;
        return d;
      });
      const index2 = new SpatialHash<CombatantState>();
      for (const c of copy) index2.insert(c, c.body.position.x, c.body.position.z);

      const evA: PickupEvent[] = [];
      const evB: PickupEvent[] = [];
      tickPowerups(a, combatants, 1 / 60, evA);
      tickPowerups(b, copy, 1 / 60, evB, index2);

      if (evA.length !== evB.length) disagreements++;
      else {
        for (let i = 0; i < evA.length; i++) {
          if (evA[i].point.id !== evB[i].point.id || evA[i].combatant.id !== evB[i].combatant.id) disagreements++;
        }
      }
      for (let i = 0; i < a.length; i++) if (a[i].active !== b[i].active) disagreements++;
      pickups += evA.length;
    }
    check(pickups > 40, `${pickups} pickups fired across the randomised fields`);
    check(disagreements === 0, `hashed and linear pickup sweeps agreed on every event and every point (${disagreements} did not)`);
  }

  // --- 3. The football. A ball's tick-long sweep is the one query whose radius
  // is derived rather than constant, so it is the one that can be too small.
  {
    let disagreements = 0;
    let hits = 0;
    for (let trial = 0; trial < 400; trial++) {
      const ox = (rand() - 0.5) * 4000;
      const oz = (rand() - 0.5) * 4000;
      const n = 3 + Math.floor(rand() * 20);
      const targets: CombatantState[] = [];
      for (let i = 0; i < n; i++) {
        const c = createCombatant(i + 2, ox + (rand() - 0.5) * 16, oz + (rand() - 0.5) * 16);
        c.body.position.y = EYE_HEIGHT;
        targets.push(c);
      }
      const index = new SpatialHash<CombatantState>();
      for (const c of targets) index.insert(c, c.body.position.x, c.body.position.z);

      // The direction first, then the ball is placed **just short of a body
      // along it**, and that placement is the whole point of the case.
      //
      // A ball moves `speed / 60` metres in one step -- 7 cm at a lob and 50 cm
      // at a hard throw -- so a ball aimed at somebody eight metres away simply
      // does not reach them this tick, and four hundred trials of that measure
      // nothing but two implementations agreeing about an empty sweep. Seeded
      // inside the step's own reach, with a lateral offset spanning the
      // 0.46 m the ball and the capsule are wide between them, this straddles
      // the hit/miss boundary: about a third connect, and the rest are near
      // misses, which is exactly where a sweep radius that is slightly too
      // small would show up.
      const speed = 4 + rand() * 26;
      const travel = speed / 60;
      let dirX = rand() - 0.5;
      let dirY = (rand() - 0.5) * 0.2;
      let dirZ = rand() - 0.5;
      let len = Math.max(1e-6, Math.hypot(dirX, dirY, dirZ));
      dirX /= len;
      dirY /= len;
      dirZ /= len;
      let ballSeedX = ox + (rand() - 0.5) * 16;
      let ballSeedY = EYE_HEIGHT + (rand() - 0.5) * 1.4;
      let ballSeedZ = oz + (rand() - 0.5) * 16;
      if (rand() < 0.8) {
        const mark = targets[Math.floor(rand() * targets.length)];
        // Perpendicular to the flight on the ground plane, for the offset.
        const perpX = -dirZ;
        const perpZ = dirX;
        const off = (rand() - 0.5) * 1.4;
        const back = travel * (0.1 + rand() * 0.95);
        ballSeedX = mark.body.position.x - dirX * back + perpX * off;
        ballSeedY = mark.body.position.y - EYE_HEIGHT + 0.2 + rand() * 1.3;
        ballSeedZ = mark.body.position.z - dirZ * back + perpZ * off;
      }
      const make = (): ReturnType<typeof createFooty> => {
        const ball = createFooty();
        ball.id = 1;
        ball.thrower = 1;
        ball.x = ballSeedX;
        ball.y = ballSeedY;
        ball.z = ballSeedZ;
        ball.alive = true;
        return ball;
      };
      const ballA = make();
      const ballB = { ...ballA };
      for (const ball of [ballA, ballB]) {
        ball.vx = dirX * speed;
        ball.vy = dirY * speed;
        ball.vz = dirZ * speed;
      }

      const stepA = createFootyStep();
      const stepB = createFootyStep();
      stepFooty(ballA, 1 / 60, null, targets, stepA);
      stepFooty(ballB, 1 / 60, null, targets, stepB, index);

      if ((stepA.victim?.id ?? 0) !== (stepB.victim?.id ?? 0)) disagreements++;
      if (ballA.x !== ballB.x || ballA.y !== ballB.y || ballA.z !== ballB.z || ballA.alive !== ballB.alive) {
        disagreements++;
      }
      if (stepA.victim) hits++;
    }
    check(hits > 60, `${hits} of 400 randomised ball steps found a body`);
    check(disagreements === 0, `hashed and linear ball sweeps agreed on the victim and the resting place (${disagreements} did not)`);
  }

  // --- 4. The encode. The pooled path and the allocating path must produce the
  // same bytes, and the per-client ack patch must be the *only* thing that
  // differs between two clients' frames.
  {
    const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
    const world = await loadWorld(root);
    const sim = new Simulation(world);
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    const players: Participant[] = [];
    for (let i = 0; i < 12; i++) players.push(sim.join(i % 7, null, `enc-${i}`));

    // Something happening, rather than twelve statues: balls in the air and
    // bodies in every phase is what makes the flags byte and the projectile
    // section non-trivial.
    let mismatched = 0;
    let compared = 0;
    let sawBalls = false;
    const into: SnapshotPlayer[] = [];
    const pooled = new ArrayBuffer(snapshotBytes(64, 32, 32));
    const view = new DataView(pooled);

    for (let t = 0; t < 400; t++) {
      for (const p of players) {
        p.input.forward = 1;
        p.input.yaw = (p.id * 0.7) % 6.28;
        applyButtons(p.input, t % 30 === 0 ? BTN.THROW : t % 17 === 0 ? BTN.PUNCH : BTN.SPRINT);
      }
      sim.step(out);
      if (sim.tick % SNAPSHOT_INTERVAL !== 0) continue;

      const snap = sim.snapshot(into);
      const balls = sim.ballSnapshot();
      const npcs = sim.npcSnapshot();
      if (balls.length > 0) sawBalls = true;

      for (const ack of [0, 1, 65535, 4242]) {
        const allocating = new Uint8Array(encodeSnapshot(sim.tick, ack, snap, balls, npcs));
        const n = encodeSnapshotInto(view, sim.tick, ack, snap, balls, npcs);
        const pooledBytes = new Uint8Array(pooled, 0, n);
        compared++;
        if (n !== allocating.byteLength) mismatched++;
        else for (let i = 0; i < n; i++) if (allocating[i] !== pooledBytes[i]) { mismatched++; break; }
      }

      // And the patch: encode once with ack 0, patch to another ack, and the
      // result must equal a fresh encode at that ack. This is the exact
      // sequence `server/index.ts` runs per client per snapshot.
      const n = encodeSnapshotInto(view, sim.tick, 0, snap, balls, npcs);
      patchSnapshotAck(view, 31337);
      const direct = new Uint8Array(encodeSnapshot(sim.tick, 31337, snap, balls, npcs));
      const patched = new Uint8Array(pooled, 0, n);
      compared++;
      for (let i = 0; i < n; i++) if (direct[i] !== patched[i]) { mismatched++; break; }
    }

    check(compared > 600, `${compared} snapshot frames encoded both ways over a 400-tick fight`);
    check(sawBalls, 'with footballs in the projectile section for some of them');
    check(mismatched === 0, `every pooled frame is byte-identical to the allocating one (${mismatched} were not)`);

    // --- 5. And the pooling itself: the records `snapshot()` reuses must be
    // *fully* rewritten, or a departed player's row survives into a live one.
    //
    // The way this fails is precise: the array is truncated with `.length = n`
    // and grown by pushing, so a field that stopped being assigned would keep
    // whatever the player who used to occupy that slot left there. Comparing a
    // pooled read against a freshly-built one after a departure is the case.
    {
      const before = sim.snapshot(into).map((s) => ({ ...s }));
      sim.leave(players[3].id);
      sim.leave(players[7].id);
      sim.step(out);
      sim.step(out);
      const after = sim.snapshot(into);
      const ids = new Set(after.map((s) => s.id));
      check(!ids.has(players[3].id) && !ids.has(players[7].id), 'two departures leave the pooled snapshot array');
      check(after.length === before.length - 2, `and it shrank from ${before.length} to ${after.length}`);
      let stale = 0;
      for (const s of after) {
        const live = sim.participants.get(s.id);
        if (!live) { stale++; continue; }
        if (s.health !== live.combat.health || Math.abs(s.x - live.combat.body.position.x) > 1e-12) stale++;
      }
      check(stale === 0, `every surviving row was rewritten from its own live combatant (${stale} were stale)`);
    }

    // --- 6. The roster is pooled on the same terms and has the same failure.
    {
      const rows = sim.roster();
      let wrong = 0;
      for (const r of rows) {
        const p = sim.participants.get(r.id);
        if (!p || p.name !== r.name || p.kos !== r.kos || p.downs !== r.downs) wrong++;
      }
      check(rows.length === sim.participants.size && wrong === 0, `the pooled roster carries ${rows.length} correct rows`);
    }
  }

  // --- 7. The module-level scratch arrays, which are the one thing the pooling
  // could have broken that no assertion above would notice.
  //
  // `game/powerups.pickupScratch` and `game/footy.sweepScratch` are shared by
  // every caller in the process, on `game/streetlife.ts`'s precedent -- and
  // this file deliberately builds **two `Simulation`s in one process**, which
  // is exactly the arrangement a leaked buffer would corrupt. The failure has
  // no picture: two servers in one process would adjudicate differently from
  // one, and only under load.
  //
  // Tested directly rather than through a whole simulation, because a
  // simulation's ambient systems are a function of the **wall clock** --
  // `trafficTick(Date.now())` -- so two sims stepped microseconds apart are not
  // required to agree about where a car is, and a check that demanded they did
  // would be a check that failed on a slow machine. What is required is that
  // interleaving two callers of these two functions gives each of them the
  // answer it would have got alone, and that is a closed question.
  {
    const mkWorld = (n: number, ox: number): { pts: ReturnType<typeof createPoint>[]; cs: CombatantState[]; hash: SpatialHash<CombatantState> } => {
      const cs: CombatantState[] = [];
      for (let i = 0; i < n; i++) {
        const c = createCombatant(i + 1, ox + (rand() - 0.5) * 30, (rand() - 0.5) * 30);
        c.body.position.y = EYE_HEIGHT;
        cs.push(c);
      }
      const pts: ReturnType<typeof createPoint>[] = [];
      for (let i = 0; i < 40; i++) {
        pts.push(createPoint(`s:${i}`, (rand() < 0.5 ? 0 : 1) as PowerupKind, ox + (rand() - 0.5) * 30, 0, (rand() - 0.5) * 30));
      }
      const hash = new SpatialHash<CombatantState>();
      for (const c of cs) hash.insert(c, c.body.position.x, c.body.position.z);
      return { pts, cs, hash };
    };

    // Two independent little worlds, run alone, then run interleaved. The
    // second `mkWorld` call uses the same seeded stream in the same order, so
    // the "alone" and "interleaved" runs see identical inputs.
    const seedAt = seed;
    const soloA: string[] = [];
    const soloB: string[] = [];
    const digest = (ev: PickupEvent[], pts: ReturnType<typeof createPoint>[]): string =>
      ev.map((e) => `${e.point.id}/${e.combatant.id}`).join(',') + '|' + pts.map((p) => (p.active ? '1' : '0')).join('');

    {
      seed = seedAt;
      const A = mkWorld(9, -400);
      const B = mkWorld(13, 900);
      for (let t = 0; t < 30; t++) soloA.push(digest(tickPowerups(A.pts, A.cs, 1 / 60, [], A.hash), A.pts));
      for (let t = 0; t < 30; t++) soloB.push(digest(tickPowerups(B.pts, B.cs, 1 / 60, [], B.hash), B.pts));
    }

    const interA: string[] = [];
    const interB: string[] = [];
    {
      seed = seedAt;
      const A = mkWorld(9, -400);
      const B = mkWorld(13, 900);
      for (let t = 0; t < 30; t++) {
        interA.push(digest(tickPowerups(A.pts, A.cs, 1 / 60, [], A.hash), A.pts));
        interB.push(digest(tickPowerups(B.pts, B.cs, 1 / 60, [], B.hash), B.pts));
      }
    }
    check(
      soloA.join(';') === interA.join(';') && soloB.join(';') === interB.join(';'),
      'interleaving two pickup sweeps gives each the answer it got alone -- the shared scratch carries nothing',
    );

    // And the same question about the football's sweep, which shares its own.
    {
      const mkBall = (x: number): ReturnType<typeof createFooty> => {
        const b = createFooty();
        b.id = 1;
        b.thrower = 999;
        b.x = x;
        b.y = EYE_HEIGHT;
        b.z = 0;
        b.vx = 6;
        b.vz = 3;
        b.alive = true;
        return b;
      };
      seed = seedAt;
      const A = mkWorld(9, -400);
      const B = mkWorld(13, 900);
      const stepOut = createFootyStep();
      const trace = (ball: ReturnType<typeof createFooty>, w: typeof A, n: number): string => {
        let out = '';
        for (let t = 0; t < n; t++) {
          stepFooty(ball, 1 / 60, null, w.cs, stepOut, w.hash);
          out += `${ball.x.toFixed(9)},${ball.z.toFixed(9)},${stepOut.victim?.id ?? 0};`;
        }
        return out;
      };
      const aAlone = trace(mkBall(-405), A, 40);
      const bAlone = trace(mkBall(895), B, 40);
      const ballA = mkBall(-405);
      const ballB = mkBall(895);
      let aInter = '';
      let bInter = '';
      for (let t = 0; t < 40; t++) {
        stepFooty(ballA, 1 / 60, null, A.cs, stepOut, A.hash);
        aInter += `${ballA.x.toFixed(9)},${ballA.z.toFixed(9)},${stepOut.victim?.id ?? 0};`;
        stepFooty(ballB, 1 / 60, null, B.cs, stepOut, B.hash);
        bInter += `${ballB.x.toFixed(9)},${ballB.z.toFixed(9)},${stepOut.victim?.id ?? 0};`;
      }
      check(
        aAlone === aInter && bAlone === bInter,
        'and interleaving two ball sweeps does the same -- 80 alternating steps, identical flights',
      );
    }
  }

  // --- 8. Two `Simulation`s stepped alternately inside one tick, byte for
  // byte, which is the end-to-end version of section 7.
  //
  // Kept as well as the focused test above because it covers the composition
  // rather than the parts -- every pooled array in `Simulation`, the two hash
  // rebuilds, the rewind proxy pool -- and it is the check that would catch a
  // *future* shared buffer nobody thought to test. Its own worlds, because
  // `PowerupPoint.active` is mutable state on the world object and two sims
  // sharing one would be taking each other's coffees.
  {
    const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
    const a = new Simulation(await loadWorld(root));
    const b = new Simulation(await loadWorld(root));
    const outA: TickOutput = { tick: 0, events: [], snapshot: null };
    const outB: TickOutput = { tick: 0, events: [], snapshot: null };
    const pa: Participant[] = [];
    const pb: Participant[] = [];
    for (let i = 0; i < 16; i++) {
      pa.push(a.join(i % 7, null, `det-${i}`));
      pb.push(b.join(i % 7, null, `det-${i}`));
    }
    // `joinSpot` draws a random point per join and nothing replays it, so B is
    // placed onto A before either of them moves.
    for (let i = 0; i < 16; i++) {
      const from = pa[i].combat.body.position;
      pb[i].combat.body.position.set(from.x, from.y, from.z);
      pb[i].combat.body.yaw = pa[i].combat.body.yaw;
      pb[i].history.seed(b.tick, from.x, from.y, from.z, pa[i].combat.body.yaw);
      pa[i].history.seed(a.tick, from.x, from.y, from.z, pa[i].combat.body.yaw);
    }
    const intoA: SnapshotPlayer[] = [];
    const intoB: SnapshotPlayer[] = [];
    let frames = 0;
    let diverged = 0;
    for (let t = 0; t < 240; t++) {
      for (let i = 0; i < 16; i++) {
        for (const ps of [pa, pb]) {
          ps[i].input.forward = 1;
          ps[i].input.yaw = ((i * 0.61 + t * 0.013) % 6.28) - 3.14;
          applyButtons(ps[i].input, t % 23 === 0 ? BTN.PUNCH : t % 31 === 0 ? BTN.THROW : BTN.SPRINT);
        }
      }
      // Alternating inside the tick. A shared module buffer would be written by
      // A and read by B here; running them one after the other would hide it.
      a.step(outA);
      b.step(outB);
      if (a.tick % SNAPSHOT_INTERVAL !== 0) continue;
      // The **player section only**. The faction and projectile sections ride
      // on `trafficTick(Date.now())`, which is the wall clock by design -- see
      // `game/traffic.ts` -- so two sims stepped microseconds apart are not
      // required to agree about where an officer on a beat is standing, and a
      // check that demanded it would fail on a busy machine rather than on a
      // bug. What the players do is a pure function of their inputs and the
      // world, and that is what this asserts.
      const fa = new Uint8Array(encodeSnapshot(a.tick, 0, a.snapshot(intoA)));
      const fb = new Uint8Array(encodeSnapshot(b.tick, 0, b.snapshot(intoB)));
      frames++;
      if (fa.byteLength !== fb.byteLength) { diverged++; continue; }
      for (let i = 0; i < fa.byteLength; i++) if (fa[i] !== fb[i]) { diverged++; break; }
    }
    check(frames > 60, `${frames} snapshots compared across two interleaved simulations`);
    check(diverged === 0, `every one of them byte-identical (${diverged} diverged)`);
  }
}

// --- PERFORMANCE.md phase 2: interest management ---------------------------------

/**
 * A `Socket` that keeps every frame instead of sending it.
 *
 * The whole reason `checkAoi` below can be exact rather than statistical. A
 * socket-driven check can only ever say "A saw B"; this says "A was sent
 * precisely these ids, in this order, in these bytes" -- which is what a
 * selection rule and a byte-identity claim need. `Room` speaks to two methods
 * and reads one field, so a fake is nine lines and runs the **real** send path:
 * the real AOI selection, the real frame grouping, the real pooled encoder and
 * the real ack patch.
 *
 * The frames are **copied** out of the room's pooled buffers rather than
 * referenced, which is not fastidiousness -- it is the property under test. The
 * room hands every client in a group a view onto one buffer and patches two
 * bytes between sends, exactly as phase 1's broadcast did, and a fake that kept
 * the view would see the *last* client's ack on every frame and the byte
 * comparison below would pass for the wrong reason.
 */
class FakeSocket {
  readonly frames: ArrayBuffer[] = [];
  closed = '';
  constructor(readonly data: Conn) {}
  send(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.frames.push(bytes.slice().buffer as ArrayBuffer);
    return bytes.byteLength;
  }
  close(_code?: number, reason?: string): void {
    this.closed = reason ?? 'closed';
  }
  /** The frames of one type received since `mark`, newest run first. */
  since(mark: number, type: number): ArrayBuffer[] {
    return this.frames.slice(mark).filter((f) => frameType(f) === type);
  }
}

/**
 * Interest management, asserted against the rule rather than against itself.
 *
 * PERFORMANCE.md phase 2. Five claims, and every one of them fails silently:
 *
 *   1. **The working set is the rule.** A player who should be in it and is not
 *      is somebody invisible while punching you -- and there is no frame in
 *      which that reads as a networking bug rather than as broken hit detection.
 *      Checked against a brute-force scan of the same snapshot records the room
 *      encoded from, so the two cannot drift into agreeing about the wrong
 *      thing.
 *   2. **The band is a band.** Entering and leaving at one radius is an
 *      enter/leave pair every snapshot for anybody standing on the line, which
 *      builds and disposes a remote actor twenty times a second and spends more
 *      bandwidth than AOI saves.
 *   3. **Every body is announced before it is drawn.** A snapshot carrying an id
 *      no `INTEREST` frame introduced is a player rendered in kit 0 -- the
 *      "everybody in the same singlet" failure `net/client.ts`'s identity table
 *      exists to prevent, now happening at every corner.
 *   4. **The dedup is byte-identical.** This is phase 1's assertion carried
 *      forward: the pooled group buffer a client is actually sent must equal a
 *      fresh allocating encode of that client's own filtered records at that
 *      client's own ack. If it does not, two clients standing together are being
 *      sent each other's world, and the picture is players at plausible wrong
 *      positions.
 *   5. **A knockout across town still prints.** The kill feed is the only
 *      surface a room-wide game has, and an events channel that had been
 *      filtered along with everything else would have removed it without
 *      anybody noticing until a player asked why the feed had gone quiet.
 */
async function checkAoi(): Promise<void> {
  say('interest management (protocol v8): working sets, the band, the cap, the dedup');

  {
    const f = verifyAoi();
    check(f.length === 0, `verifyAoi passes${f.length ? ` -- ${f[0]}` : ''}`);
  }

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);

  /** The rule, written out as a scan over the records the room actually sent. */
  const brute = (
    players: readonly SnapshotPlayer[],
    x: number,
    z: number,
    held: (id: number) => boolean,
  ): number[] => {
    const eligible: Array<{ id: number; d2: number }> = [];
    for (const p of players) {
      const dx = p.x - x;
      const dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      const inner = AOI_ENTER_RADIUS * AOI_ENTER_RADIUS;
      const outer = AOI_LEAVE_RADIUS * AOI_LEAVE_RADIUS;
      if (d2 <= inner || (d2 <= outer && held(p.id))) eligible.push({ id: p.id, d2 });
    }
    eligible.sort((a, b) => a.d2 - b.d2 || a.id - b.id);
    return eligible.slice(0, AOI_MAX_PLAYERS).map((e) => e.id).sort((a, b) => a - b);
  };

  // --- 1. A room of 90, half of them piled onto one intersection and half
  // scattered over three kilometres, stepped for real.
  //
  // The mix is the point. A scattered room is where a working set is small and
  // the dedup has nothing to work with; a pileup is where the cap binds and the
  // dedup does everything. A check with only one of them would report a number
  // that is true of neither.
  {
    const room = new Room(0, world, 200, 0);
    const sockets: FakeSocket[] = [];
    const N = 90;
    for (let i = 0; i < N; i++) {
      const conn = newConn(0);
      const ws = new FakeSocket(conn);
      const p = room.join(conn, i % 7, `aoi-${i}`);
      if (!p) break;
      room.conns.add(ws as unknown as Socket);
      sockets.push(ws);
      // Half onto one intersection inside a 25 m circle -- the CBD pileup -- and
      // half spread over 3 km, which is the whole inner ring.
      const centre = world.spawn;
      if (i < N / 2) {
        const a = (i / (N / 2)) * Math.PI * 2;
        p.combat.body.position.x = centre.x + Math.cos(a) * (5 + (i % 5) * 4);
        p.combat.body.position.z = centre.z + Math.sin(a) * (5 + (i % 5) * 4);
      } else {
        const k = i - N / 2;
        p.combat.body.position.x = centre.x + ((k % 7) - 3) * 420;
        p.combat.body.position.z = centre.z + (Math.floor(k / 7) - 3) * 420;
      }
      p.history.seed(room.sim.tick, p.combat.body.position.x, p.combat.body.position.y, p.combat.body.position.z, 0);
    }

    // Three ticks: one to land on a snapshot boundary, and two more so a set has
    // a *previous* state for the band to be evaluated against.
    let mismatched = 0;
    let unannounced = 0;
    let byteMismatch = 0;
    let compared = 0;
    let cappedClients = 0;
    let sumSet = 0;
    let samples = 0;
    const known = new Map<FakeSocket, Set<number>>();
    for (const ws of sockets) known.set(ws, new Set());
    const scratch = createSnapshot();
    const announced = new Map<FakeSocket, Set<number>>();
    for (const ws of sockets) announced.set(ws, new Set());

    for (let t = 0; t < 12; t++) {
      const marks = new Map<FakeSocket, number>();
      for (const ws of sockets) marks.set(ws, ws.frames.length);
      room.step();
      if (room.sim.tick % SNAPSHOT_INTERVAL !== 0) continue;

      // What the room simulated, read back through the same pooled arrays it
      // encoded from. Nothing here re-derives a position.
      const records = room.sim.snapshot([]);
      const byId = new Map(records.map((r) => [r.id, r]));

      for (const ws of sockets) {
        const conn = ws.data;
        const p = conn.participant;
        if (!p) continue;
        const from = marks.get(ws) ?? 0;

        // The interest delta, applied to this check's own idea of what the
        // client knows -- built from the wire rather than from the server's
        // state, which is the only way this can catch the two disagreeing.
        const seen = announced.get(ws)!;
        for (const frame of ws.since(from, MSG.INTEREST)) {
          const d = decodeInterest(frame)!;
          for (const e of d.enters) seen.add(e.id);
          for (const id of d.leaves) seen.delete(id);
        }

        const frames = ws.since(from, MSG.SNAPSHOT);
        if (frames.length !== 1) {
          mismatched++;
          continue;
        }
        const got = decodeSnapshot(frames[0], scratch)!;
        const ids = got.players.map((s) => s.id);
        sumSet += ids.length;
        samples++;
        if (ids.length === AOI_MAX_PLAYERS) cappedClients++;

        // --- Claim 1: the ids are the rule's ids.
        const held = known.get(ws)!;
        const want = brute(records, p.combat.body.position.x, p.combat.body.position.z, (id) => held.has(id));
        if (ids.length !== want.length || ids.some((id, i) => id !== want[i])) mismatched++;
        known.set(ws, new Set(want));

        // --- Claim 3: nothing is drawn that was never announced. `seen` is
        // built from the INTEREST frames alone, so an id in the snapshot that
        // is not in it is a body with no identity behind it.
        for (const id of ids) if (id !== p.id && !seen.has(id)) unannounced++;
        // ...and yourself is always in your own set, or prediction has nothing
        // to reconcile against.
        if (!ids.includes(p.id)) mismatched++;

        // --- Claim 4: the pooled group bytes equal a fresh allocating encode of
        // exactly these records at exactly this client's ack. This is phase 1's
        // byte-identity assertion, carried forward to per-set encoding.
        const sub: SnapshotPlayer[] = [];
        for (const id of want) {
          const rec = byId.get(id);
          if (rec) sub.push(rec);
        }
        // The ball and actor sections rebuilt the same way -- from the room's
        // own live records, selected by the ids the client was actually sent.
        // Passing empty arrays here would have made this check pass for the
        // wrong reason in the one scenario that has no balls in it, and fail
        // spuriously in every other.
        const liveBalls = room.sim.ballSnapshot();
        const liveNpcs = room.sim.npcSnapshot();
        const subBalls = got.balls.map((b) => liveBalls.find((l) => l.id === b.id)).filter((b): b is NonNullable<typeof b> => b !== undefined);
        const subNpcs = got.npcs.map((n) => liveNpcs.find((l) => l.id === n.id)).filter((n): n is NonNullable<typeof n> => n !== undefined);
        const direct = new Uint8Array(encodeSnapshot(room.sim.tick, p.ackSeq, sub, subBalls, subNpcs));
        const sent = new Uint8Array(frames[0]);
        compared++;
        if (direct.byteLength !== sent.byteLength) byteMismatch++;
        else for (let i = 0; i < direct.byteLength; i++) if (direct[i] !== sent[i]) { byteMismatch++; break; }
      }
    }

    check(samples > 200, `${samples} client-snapshots inspected across a ${sockets.length}-player room`);
    check(mismatched === 0, `every working set was exactly the brute-force rule's (${mismatched} were not)`);
    check(cappedClients > 0, `the ${AOI_MAX_PLAYERS} cap actually bound for ${cappedClients} of them -- a pileup, not a paddock`);
    check(unannounced === 0, `no snapshot carried a body that no INTEREST frame had introduced (${unannounced} did)`);
    check(compared > 200, `${compared} pooled frames compared against a fresh allocating encode`);
    check(byteMismatch === 0, `every deduplicated frame is byte-identical to its own client's encode (${byteMismatch} were not)`);

    const stats = room.stats(1);
    check(
      stats.dedup > 1,
      `the mixed room deduplicated at all: ${stats.dedup.toFixed(2)} frames sent per frame encoded ` +
        `(mean working set ${(sumSet / Math.max(1, samples)).toFixed(1)})`,
    );
    say(
      `  note: ${sockets.length} clients, mean working set ${(sumSet / Math.max(1, samples)).toFixed(1)}, ` +
        `peak ${stats.interest.max}, dedup ${stats.dedup.toFixed(2)}x, ` +
        `${snapshotBytes(Math.round(sumSet / Math.max(1, samples)))} B/snapshot typical.`,
    );
  }

  // --- 1b. The dedup's *mechanism*, in the case it exists for.
  //
  // The mixed room above measures the realistic ratio and it is modest (1.25),
  // for a reason worth pinning down with its own check rather than leaving as a
  // number: **the cap is what limits the dedup**. Forty-five people on a ring do
  // not agree about who their forty nearest are, so each is sent a slightly
  // different set and each set is encoded once.
  //
  // Under the cap, they agree exactly. Twenty-four players inside 30 m with
  // nobody within 400 m have the *identical* twenty-four-member working set, so
  // one encode serves all of them -- which is phase 1's broadcast again, scoped
  // to a neighbourhood. If this check ever drops toward 1 while the one above
  // holds, the frame key has started distinguishing frames that are the same.
  {
    const room = new Room(0, world, 64, 0);
    const socks: FakeSocket[] = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const conn = newConn(0);
      const ws = new FakeSocket(conn);
      const p = room.join(conn, i % 7, `tight-${i}`)!;
      room.conns.add(ws as unknown as Socket);
      socks.push(ws);
      const a = (i / N) * Math.PI * 2;
      p.combat.body.position.x = world.spawn.x + Math.cos(a) * 12;
      p.combat.body.position.z = world.spawn.z + Math.sin(a) * 12;
    }
    for (let t = 0; t < 6; t++) room.step();
    const stats = room.stats(1);
    check(
      stats.interest.max === N && Math.abs(stats.interest.mean - N) < 0.01,
      `a tight cluster of ${N} gives every client the same ${stats.interest.max}-member set`,
    );
    check(
      stats.dedup > N - 0.01,
      `and one encode serves all of them: ${stats.dedup.toFixed(2)} frames sent per frame encoded`,
    );
  }

  // --- 2. The band, at the boundary it exists for.
  //
  // One player walks out from 100 m to 240 m and back in one metre a tick, and
  // the whole claim is a count: **one** entrance and **one** departure. Under a
  // single radius this is a transition every time they cross 180 m, and the
  // picture is a remote actor built and disposed twenty times a second on
  // everybody's screen.
  {
    const room = new Room(0, world, 8, 0);
    const socks: FakeSocket[] = [];
    const parts: Participant[] = [];
    for (let i = 0; i < 2; i++) {
      const conn = newConn(0);
      const ws = new FakeSocket(conn);
      const p = room.join(conn, i, `band-${i}`)!;
      room.conns.add(ws as unknown as Socket);
      socks.push(ws);
      parts.push(p);
    }
    const [watcher, walker] = parts;
    watcher.combat.body.position.x = world.spawn.x;
    watcher.combat.body.position.z = world.spawn.z;
    let enters = 0;
    let leaves = 0;
    let heldAt200 = false;
    let heldAt230 = true;
    const walk = (d: number): void => {
      walker.combat.body.position.x = world.spawn.x;
      walker.combat.body.position.z = world.spawn.z + d;
      // Pinned every tick, because `advance` would otherwise walk them: what is
      // under test is the boundary, not the controller.
      watcher.combat.body.position.x = world.spawn.x;
      watcher.combat.body.position.z = world.spawn.z;
      const from = socks[0].frames.length;
      room.step();
      for (const f of socks[0].since(from, MSG.INTEREST)) {
        const d2 = decodeInterest(f)!;
        for (const e of d2.enters) if (e.id === walker.id) enters++;
        for (const id of d2.leaves) if (id === walker.id) leaves++;
      }
    };
    for (let d = 240; d >= 100; d--) walk(d);
    for (let d = 100; d <= 200; d++) walk(d);
    heldAt200 = socks[0].data.interest.has(walker.id);
    for (let d = 200; d <= 240; d++) walk(d);
    heldAt230 = socks[0].data.interest.has(walker.id);

    check(heldAt200, `a member at 200 m is still held -- the band is ${AOI_ENTER_RADIUS}/${AOI_LEAVE_RADIUS} m, not one radius`);
    check(!heldAt230, 'and is dropped past 220 m');
    check(
      enters === 1 && leaves === 1,
      `a there-and-back walk across the boundary cost ${enters} entrance(s) and ${leaves} departure(s); ` +
        `it must be one of each, or the boundary flaps`,
    );
  }

  // --- 3. A knockout across town still prints in the kill feed.
  //
  // Two players fight at the spawn and a third stands 2 km away. The third must
  // never have had either of them in its working set -- and must still be told
  // about the knockout, because the feed is the only room-wide surface a player
  // standing in a quiet street has. An events channel filtered along with
  // everything else would have removed that with nothing to show for it: a HIT
  // is 7 bytes against a snapshot's 900.
  {
    const room = new Room(0, world, 8, 0);
    const socks: FakeSocket[] = [];
    const parts: Participant[] = [];
    for (let i = 0; i < 3; i++) {
      const conn = newConn(0);
      const ws = new FakeSocket(conn);
      const p = room.join(conn, i, `feed-${i}`)!;
      room.conns.add(ws as unknown as Socket);
      socks.push(ws);
      parts.push(p);
    }
    const [attacker, victim, distant] = parts;
    // The geometry `verifySim` uses for a punch that lands, plus a victim on one
    // pip so the punch is a knockout rather than a hit.
    attacker.combat.body.position.set(world.spawn.x, EYE_HEIGHT, world.spawn.z + 1);
    victim.combat.body.position.set(world.spawn.x, EYE_HEIGHT, world.spawn.z);
    attacker.combat.body.yaw = 0;
    attacker.input.yaw = 0;
    victim.input.yaw = 0;
    victim.combat.health = 1;
    distant.combat.body.position.set(world.spawn.x + 2000, EYE_HEIGHT, world.spawn.z + 2000);
    attacker.history.seed(room.sim.tick, attacker.combat.body.position.x, EYE_HEIGHT, attacker.combat.body.position.z, 0);
    victim.history.seed(room.sim.tick, victim.combat.body.position.x, EYE_HEIGHT, victim.combat.body.position.z, 0);

    attacker.input.punch = true;
    let sawKo = false;
    let distantSetHadFighters = false;
    const scratch = createSnapshot();
    for (let t = 0; t < 60; t++) {
      const from = socks[2].frames.length;
      // The distant client is pinned, because a knocked-about world would
      // otherwise be free to walk it back into range and prove nothing.
      distant.combat.body.position.x = world.spawn.x + 2000;
      distant.combat.body.position.z = world.spawn.z + 2000;
      room.step();
      attacker.input.punch = false;
      for (const f of socks[2].since(from, MSG.EVENTS)) {
        for (const e of decodeEvents(f) ?? []) {
          if (e.kind === EVENT.HIT && (e.flags & EVENT_FLAG.KO) !== 0) sawKo = true;
        }
      }
      for (const f of socks[2].since(from, MSG.SNAPSHOT)) {
        const s = decodeSnapshot(f, scratch)!;
        if (s.players.some((pl) => pl.id === attacker.id || pl.id === victim.id)) distantSetHadFighters = true;
      }
    }
    check(!distantSetHadFighters, 'a client 2.8 km away never had the fighters in its working set');
    check(
      sawKo,
      'and was still told about the knockout, so a cross-town KO prints in the kill feed -- the events ' +
        'channel is room-global on purpose',
    );
    check(victim.combat.phase === 'ko', `the victim really was knocked out (phase "${victim.combat.phase}")`);
  }

  // --- 4. Balls and officers are filtered by their own position, not by whose
  // they are. A ball is most interesting to the player it is about to reach,
  // who by definition is nowhere near whoever threw it.
  {
    const room = new Room(0, world, 8, 0);
    const socks: FakeSocket[] = [];
    const parts: Participant[] = [];
    for (let i = 0; i < 2; i++) {
      const conn = newConn(0);
      const ws = new FakeSocket(conn);
      const p = room.join(conn, i, `ball-${i}`)!;
      room.conns.add(ws as unknown as Socket);
      socks.push(ws);
      parts.push(p);
    }
    const [thrower, far] = parts;
    thrower.combat.body.position.set(world.spawn.x, EYE_HEIGHT, world.spawn.z);
    far.combat.body.position.set(world.spawn.x + 1500, EYE_HEIGHT, world.spawn.z);
    thrower.input.throwBall = true;
    thrower.input.pitch = 0.2;
    let throwerSaw = 0;
    let farSaw = 0;
    const scratch = createSnapshot();
    for (let t = 0; t < 40; t++) {
      far.combat.body.position.x = world.spawn.x + 1500;
      far.combat.body.position.z = world.spawn.z;
      const m0 = socks[0].frames.length;
      const m1 = socks[1].frames.length;
      room.step();
      thrower.input.throwBall = false;
      for (const f of socks[0].since(m0, MSG.SNAPSHOT)) throwerSaw += decodeSnapshot(f, scratch)!.balls.length;
      for (const f of socks[1].since(m1, MSG.SNAPSHOT)) farSaw += decodeSnapshot(f, scratch)!.balls.length;
    }
    check(throwerSaw > 0, `the thrower saw its own ball in the stream (${throwerSaw} ball-records)`);
    check(farSaw === 0, `a client 1.5 km away was sent none of it (${farSaw} ball-records)`);
  }
}

// --- PERFORMANCE.md phase 3: rooms and the gateway --------------------------------

/**
 * Rooms, over the real socket and the real gateway.
 *
 * Four claims, and the first is the one the architecture rests on:
 *
 *   1. **Rooms are isolated.** A swing in room 0 cannot land in room 1, a
 *      knockout in one never reaches the other's kill feed, and each room's
 *      leaderboard is its own. This is asserted over sockets rather than in
 *      process because "one `Simulation` per room" is only half of it -- the
 *      other half is that the transport never sends a room's frame to somebody
 *      else's socket, which is a thing only a socket can see.
 *   2. **The gateway spreads.** Two bare connections must land in *different*
 *      rooms, because the rule is least-full: a rule that returned the first
 *      open room would put everybody in room 0 and leave seven idling.
 *   3. **A named room is honoured**, which is what an invite link is.
 *   4. **A full room refuses cleanly, by name.** The failure this replaces is a
 *      socket that closes with nothing a browser will surface -- see
 *      `protocol.encodeBye`, whose whole purpose is a refusal a player can read.
 *
 * And one in-process claim that no socket could make: that two rooms sharing a
 * loaded city do not share the one mutable thing in it.
 */
async function checkRooms(): Promise<void> {
  say('rooms and the gateway (PERFORMANCE.md phase 3)');

  // --- 0. The world split, in process. `roomWorld` shares 3.7 MB of prisms by
  // reference and must not share a single coffee.
  {
    const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
    const shared = await loadWorld(root);
    const a = roomWorld(shared);
    const b = roomWorld(shared);
    check(a.collision === b.collision && a.terrain === b.terrain && a.traffic === b.traffic,
      'two rooms share the collision, terrain and lane graphs by reference -- the city is loaded once');
    check(a.powerups !== b.powerups && a.points !== b.points,
      'and hold their own powerup fields, which is the one mutable thing in a loaded world');
    check(a.points.length === b.points.length && a.points.length > 100,
      `both fields carry the same ${a.points.length} points`);
    // The real test: take a coffee in one room and check it is still on the
    // pavement in the other. A shared field makes this fail and the symptom in a
    // game is a powerup that vanishes for reasons in another city.
    const takenA = a.points.find((p) => p.active);
    if (takenA) {
      takenA.active = false;
      takenA.respawnT = 45;
      const same = b.points.find((p) => p.id === takenA.id);
      check(same !== undefined && same.active,
        `a pickup taken in room A left room B's copy of the same point standing`);
      takenA.active = true;
      takenA.respawnT = 0;
    } else {
      check(false, 'no active powerup to test room isolation with');
    }
  }

  // --- The rest is over sockets, against a host running three small rooms.
  const port = PORT + 2;
  const proc = Bun.spawn(['bun', 'run', new URL('./index.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      SYDNEY_PORT: String(port),
      SYDNEY_ROOMS: '3',
      SYDNEY_ROOM_CAP: '3',
      SYDNEY_BOTS: '0',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(100);
      try {
        up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        // not yet
      }
    }
    if (!up) {
      check(false, 'a three-room host answered /health');
      return;
    }

    // --- 1. `GET /rooms`, the whole of the gateway protocol.
    const listing = (await (await fetch(`http://127.0.0.1:${port}/rooms`)).json()) as RoomInfo[];
    check(Array.isArray(listing) && listing.length === 3, `/rooms lists ${listing.length} rooms`);
    check(
      listing.every((r) => typeof r.id === 'number' && r.cap === 3 && r.open === true && r.players === 0),
      `every room reports an id, a cap and an occupancy (${JSON.stringify(listing[0])})`,
    );
    check(
      chooseRoom(listing, null) === listing[0].id,
      `the client's own rule picks room ${chooseRoom(listing, null)} from an empty host`,
    );

    // --- 2. Two bare connections land in different rooms. This is the least-full
    // rule doing its job; a "first open room" rule passes every other check here
    // and fails this one.
    const bare1 = new RoomProbe('bare1');
    await bare1.connect(`ws://127.0.0.1:${port}`);
    const bare2 = new RoomProbe('bare2');
    await bare2.connect(`ws://127.0.0.1:${port}`);
    check(
      bare1.room !== bare2.room,
      `two bare joins spread across rooms (${bare1.room} and ${bare2.room}); the gateway picks least-full`,
    );
    check(bare1.room >= 0 && bare2.room >= 0, 'and the WELCOME told each of them which room it landed in');
    bare1.close();
    bare2.close();
    await sleep(200);

    // --- 3. A named room is honoured -- an invite link -- and two friends who
    // name the same one meet.
    const friendA = new RoomProbe('friendA');
    const friendB = new RoomProbe('friendB');
    await friendA.connect(`ws://127.0.0.1:${port}?room=2`);
    await friendB.connect(`ws://127.0.0.1:${port}?room=2`);
    check(friendA.room === 2 && friendB.room === 2, `both friends landed in the room they named (${friendA.room}, ${friendB.room})`);

    // A third client, in a different room, for the isolation tests below.
    const outsider = new RoomProbe('outsider');
    await outsider.connect(`ws://127.0.0.1:${port}?room=0`);
    check(outsider.room === 0, `an outsider joined room ${outsider.room}`);

    // --- 4. A full room refuses by name. Room 2 has two of its three.
    const filler = new RoomProbe('filler');
    await filler.connect(`ws://127.0.0.1:${port}?room=2`);
    const refused = new RoomProbe('refused');
    await refused.connect(`ws://127.0.0.1:${port}?room=2`);
    check(
      refused.bye.includes('full') && refused.bye.includes('2'),
      `a full room refused by name with a message the client can print: ${JSON.stringify(refused.bye)}`,
    );
    check(refused.id === 0, 'and never welcomed them');
    const nowhere = new RoomProbe('nowhere');
    await nowhere.connect(`ws://127.0.0.1:${port}?room=99`);
    check(
      nowhere.bye.includes('99'),
      `a stale link to a room that does not exist is refused by name: ${JSON.stringify(nowhere.bye)}`,
    );

    // --- 5. Isolation over the socket. Four seconds of the two friends walking
    // together while the outsider stands still, then what each of them was told.
    //
    // The **bodies** are the non-vacuous half here rather than a knockout. A
    // socket brawl has to cross whatever the spawn dither put between the two
    // probes -- up to 200 m -- so requiring a landed punch inside a fixed budget
    // would be requiring a random walk to finish on time, which is a check that
    // fails on a slow machine rather than on a bug. What "a swing cannot cross a
    // room" means is asserted deterministically in section 7 below, in process,
    // where two bodies can be put on the same square metre of Sydney in
    // different rooms.
    friendA.forward = 1;
    friendB.forward = 1;
    for (let i = 0; i < 240; i++) {
      const pa = friendA.selfAt();
      const pb = friendA.at(friendB.id);
      if (pa && pb) {
        const gap = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
        friendA.yaw = Math.atan2(-(pb[0] - pa[0]), -(pb[1] - pa[1]));
        friendB.yaw = friendA.yaw + Math.PI;
        friendA.forward = gap > 1.0 ? 1 : 0;
        friendA.buttons |= BTN.SPRINT;
        friendB.forward = gap > 3 ? 1 : 0;
        if (gap < 2.0 && i % 40 === 0) friendA.buttons |= BTN.PUNCH;
      }
      friendA.tick();
      friendB.tick();
      outsider.tick();
      await sleep(1000 / 60);
    }

    // --- Hits **from another player**, which is the only kind that could have
    // crossed a room.
    //
    // `attacker === victim` is the environment's sentinel and it is deliberate:
    // `Simulation.shoot` raises its HIT with the victim as their own attacker so
    // that a police round, a car and a magpie all read as "nobody did this",
    // and `traffic`'s car hit says the same thing the same way. Counting those
    // as evidence of a room leak is the same wrong-instrument mistake the magpie
    // check already made once -- the outsider is standing in a real Sydney
    // street *in its own room*, and the wildlife there is entitled to peck it.
    //
    // Observed once in eight runs before this: "3 hit events from another room"
    // and a health bar reading 2.25, which is three quarter-pip pecks. A quarter
    // pip is `wildlife.SWOOP_DAMAGE`; no player melee in this game does 0.25.
    const crossRoom = outsider.hits.filter((h) => h.attacker !== h.victim);
    const ownRoomEnvironment = outsider.hits.length - crossRoom.length;
    check(
      crossRoom.length === 0,
      `the outsider saw ${crossRoom.length} player hit events from another room` +
        (ownRoomEnvironment
          ? ` (and ${ownRoomEnvironment} environment hit(s) in its own room -- wildlife or traffic, which is not room 2)`
          : ''),
    );
    const outsiderNames = new Set(outsider.roster.map((r) => r.name));
    const friendNames = new Set(friendA.roster.map((r) => r.name));
    check(
      ![...friendNames].some((n) => outsiderNames.has(n)),
      `the two rooms' leaderboards are disjoint (room 2: ${[...friendNames].join(', ')} | room 0: ${[...outsiderNames].join(', ')})`,
    );
    check(
      outsider.roster.length === 1 && friendA.roster.length === 3,
      `each roster is its own room's (${outsider.roster.length} and ${friendA.roster.length} rows)`,
    );
    check(
      friendA.seenIds.has(friendB.id) && friendB.seenIds.has(friendA.id),
      `the two friends really were in one room together -- each was sent the other's body -- so the ` +
        `outsider's silence means something`,
    );
    check(
      outsider.seenIds.size === 1 && outsider.seenIds.has(outsider.id),
      `and the outsider was sent exactly one body, its own (${outsider.seenIds.size} ids seen across ` +
        `four seconds of another room fighting)`,
    );
    // The other half of "a swing in A cannot hit B": the outsider is untouched
    // **by room 2**.
    //
    // Asserted on the attribution of what hit them rather than on the number on
    // their health bar, for the reason above: the bar is a sum over everything
    // in their own street, and demanding it read exactly 3 is demanding that no
    // turkey in Sydney Park took an interest -- which is a claim about the
    // wildlife, not about rooms. What has to be true is that nothing *from room
    // 2* arrived, and that is `crossRoom`.
    check(
      crossRoom.length === 0 && (outsider.selfHealth ?? 0) > 0,
      `nothing in room 2 reached the outsider; they are on ${outsider.selfHealth} pips` +
        (ownRoomEnvironment ? ' after their own room\'s wildlife had a go at them' : ' and untouched'),
    );

    // --- 6. `/health` and `/stats` carry the per-room breakdown, which is what
    // makes a busy host diagnosable: one room of 128 and seven idle is a
    // completely different machine from eight even ones, and an aggregate
    // cannot tell them apart.
    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { rooms: RoomInfo[]; players: number };
    check(health.rooms.length === 3 && health.players === 4, `/health reports ${health.players} players across ${health.rooms.length} rooms`);
    const occupied = health.rooms.filter((r) => r.players > 0);
    check(occupied.length === 2, `and says which rooms they are in (${occupied.map((r) => `${r.id}:${r.players}`).join(' ')})`);
    const stats = (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as {
      room: Array<{ id: number; players: number; dedup: number; interest: { mean: number } }>;
      dedup: number;
      interest: { mean: number };
    };
    check(Array.isArray(stats.room) && stats.room.length === 3, `/stats breaks down by room (${stats.room?.length} entries)`);
    check(
      stats.room.some((r) => r.interest.mean > 0),
      `and reports each room's mean working set (${stats.room.map((r) => r.interest.mean.toFixed(1)).join(', ')})`,
    );

    friendA.close();
    friendB.close();
    filler.close();
    outsider.close();
    await sleep(200);
  } finally {
    proc.kill();
    await sleep(100);
  }

  // --- 7. **A swing in room A cannot hit room B**, put beyond doubt.
  //
  // Two rooms, and three bodies standing on **the same square metre of Sydney**:
  // an attacker and a victim in room A, and a bystander in room B at the
  // victim's exact coordinates. Room A's punch is the geometry `verifySim` uses
  // for one that lands, so it certainly lands -- on the victim. If a room were
  // anything less than a separate world, the bystander is standing in the same
  // place and would be hit by the same swing.
  //
  // In process rather than over a socket because the claim is about *the
  // simulation*, and because putting two bodies on one coordinate is the whole
  // experiment -- something no socket-driven probe can arrange. The socket
  // section above proves the complementary half: that the transport never sends
  // one room's frame to another room's client.
  {
    const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
    const shared = await loadWorld(root);
    const A = new Room(0, shared, 8, 0);
    const B = new Room(1, shared, 8, 0);
    const wsA = new FakeSocket(newConn(0));
    const wsV = new FakeSocket(newConn(0));
    const wsB = new FakeSocket(newConn(1));
    const attacker = A.join(wsA.data, 0, 'swing-attacker')!;
    const victim = A.join(wsV.data, 1, 'swing-victim')!;
    const bystander = B.join(wsB.data, 0, 'swing-bystander')!;
    A.conns.add(wsA as unknown as Socket);
    A.conns.add(wsV as unknown as Socket);
    B.conns.add(wsB as unknown as Socket);

    const x = shared.spawn.x;
    const z = shared.spawn.z;
    attacker.combat.body.position.set(x, EYE_HEIGHT, z + 1);
    victim.combat.body.position.set(x, EYE_HEIGHT, z);
    // The same coordinates as the victim, in the other room.
    bystander.combat.body.position.set(x, EYE_HEIGHT, z);
    attacker.combat.body.yaw = 0;
    attacker.input.yaw = 0;
    victim.input.yaw = 0;
    bystander.input.yaw = 0;
    attacker.history.seed(A.sim.tick, x, EYE_HEIGHT, z + 1, 0);
    victim.history.seed(A.sim.tick, x, EYE_HEIGHT, z, 0);
    bystander.history.seed(B.sim.tick, x, EYE_HEIGHT, z, 0);

    attacker.input.punch = true;
    let eventsInB = 0;
    for (let t = 0; t < 40; t++) {
      const markB = wsB.frames.length;
      // The bystander is pinned so a knockback in the *other* room cannot be
      // confused with them simply having walked off.
      bystander.combat.body.position.set(x, EYE_HEIGHT, z);
      A.step();
      B.step();
      attacker.input.punch = false;
      for (const f of wsB.since(markB, MSG.EVENTS)) eventsInB += (decodeEvents(f) ?? []).length;
    }

    check(
      Math.abs(victim.combat.health - (MAX_HEALTH - 1)) < 1e-9,
      `the swing landed in its own room: the victim is on ${victim.combat.health} pips`,
    );
    check(
      Math.abs(bystander.combat.health - MAX_HEALTH) < 1e-9,
      `and a body standing on the identical coordinates in room 1 is untouched ` +
        `(${bystander.combat.health} pips)`,
    );
    check(
      Math.hypot(bystander.combat.body.position.x - x, bystander.combat.body.position.z - z) < 1e-6,
      'the bystander was not thrown by the other room\'s knockback either',
    );
    check(eventsInB === 0, `room 1's client received ${eventsInB} events from room 0's fight`);
    check(
      A.sim.participants.size === 2 && B.sim.participants.size === 1,
      `and the two rooms hold their own participants (${A.sim.participants.size} and ${B.sim.participants.size})`,
    );
  }
}

/**
 * A synthetic client that keeps what a room told it. `Probe`'s little sibling.
 *
 * Its own class rather than a flag on `Probe`, because what it watches is
 * different: a room's identity, a `BYE` it was refused with, and which bodies it
 * was ever sent -- none of which the milestone-9 probe has any use for.
 */
class RoomProbe {
  private socket!: WebSocket;
  id = 0;
  room = -1;
  bye = '';
  seq = 0;
  yaw = 0;
  forward = 0;
  buttons = 0;
  roster: RosterEntry[] = [];
  hits: Array<{ attacker: number; victim: number; ko: boolean }> = [];
  readonly seenIds = new Set<number>();
  selfHealth: number | null = null;
  private readonly positions = new Map<number, [number, number]>();
  private readonly scratch = createSnapshot();

  constructor(readonly name: string) {}

  connect(url: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => socket.send(encodeHello(255, this.name));
      socket.onerror = () => done();
      socket.onclose = () => done();
      socket.onmessage = (e) => {
        const frame = e.data as ArrayBuffer;
        switch (frameType(frame)) {
          case MSG.WELCOME: {
            const w = decodeWelcome(frame);
            if (!w) return;
            this.id = w.id;
            this.room = w.room;
            done();
            return;
          }
          case MSG.BYE: {
            this.bye = decodeBye(frame) ?? 'bye';
            done();
            return;
          }
          case MSG.ROSTER: {
            this.roster = decodeRoster(frame) ?? this.roster;
            return;
          }
          case MSG.SNAPSHOT: {
            const s = decodeSnapshot(frame, this.scratch);
            if (!s) return;
            for (const p of s.players) {
              this.seenIds.add(p.id);
              this.positions.set(p.id, [p.x, p.z]);
              if (p.id === this.id) this.selfHealth = p.health;
            }
            return;
          }
          case MSG.EVENTS: {
            for (const ev of decodeEvents(frame) ?? []) {
              if (ev.kind === EVENT.HIT) {
                this.hits.push({ attacker: ev.attacker, victim: ev.victim, ko: (ev.flags & EVENT_FLAG.KO) !== 0 });
              }
            }
            return;
          }
          default:
            return;
        }
      };
      setTimeout(done, 5000);
    });
  }

  at(id: number): [number, number] | null {
    return this.positions.get(id) ?? null;
  }

  selfAt(): [number, number] | null {
    return this.positions.get(this.id) ?? null;
  }

  tick(): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.seq = (this.seq + 1) & 0xffff;
    this.socket.send(
      encodeInput({ seq: this.seq, buttons: this.buttons, forward: this.forward, right: 0, yaw: this.yaw, pitch: 0 }),
    );
    this.buttons = 0;
  }

  close(): void {
    this.socket?.close();
  }
}

/**
 * The streaming lifecycle: what happens to a tile that fails, and what happens
 * to a tile the player walks away from and comes back to.
 *
 * Off the socket deliberately, on `checkWading`'s argument -- there is no wire
 * in this and the server has no lifecycle problem at all: `loadWorld` reads all
 * 372 collision payloads at boot and holds them for the process. This is a
 * *client* defect, and it is here because the two rules it turns on are pure
 * arithmetic over the same `CollisionWorld` and the same `index.json` both ends
 * share, so the one place they can be held still without a browser is this one.
 *
 * Two defects, and both of them manufacture the same symptom -- collision the
 * player is stopped by with nothing drawn there:
 *
 *   1. `TileStreamer.update` gated on a `failed` set that nothing ever emptied.
 *      One aborted fetch and that tile's geometry was never requested again for
 *      the session, while `main.ts` kept fetching its 9 kB collision payload on
 *      a different radius, successfully, because a small request and a 1.6 MB
 *      one do not fail together.
 *   2. `CollisionWorld` never evicted anything and the streamer evicts geometry
 *      past 1,800 m. So collision accumulated for the session and geometry did
 *      not, and every return trip was *guaranteed* to find tiles with prisms and
 *      no buildings. The tour below measures how many, on the real build, with
 *      the old rule and the new one.
 *
 * The third case is the one that makes the fix safe rather than merely
 * effective: over the whole tour, at every step, every tile inside the ring
 * `ensureGround` fetches on must have its prisms resident. A fix that cleared
 * the amber by dropping collision near the player would pass the first two
 * cases and drop players through the world.
 */
async function checkStreamingLifecycle(): Promise<void> {
  say('streaming lifecycle: the retry taxonomy, and collision/geometry parity over a tour');

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const index = JSON.parse(
    await readFile(join(root, 'index.json'), 'utf8'),
  ) as { tile_size: number; tiles: Array<{ key: string; b: number; bounds: [number, number, number, number] }> };

  // --- 1. The arithmetic, exactly as the client runs it at boot.
  {
    const failures = verifyTileLifecycle();
    check(
      failures.length === 0,
      `the tile lifecycle rules check out (${failures.length ? failures[0] : 'taxonomy, backoff, safety radius'})`,
    );
  }

  // --- 1b. The two formats a tile now arrives in, both of which are half
  // written in Python and half in TypeScript and neither of which fails loudly.
  //
  // `verifyMeshPack` builds a packed GLB from known values, parses it back and
  // asserts that `_BLDIDX` and the indices are *equal* rather than close --
  // `_BLDIDX` is a row in the facade parameter atlas and a value one off draws a
  // terrace house with a tower's window grammar. `verifyRegions` does the same
  // for the bundle container, plus the floor-division that decides which bundle
  // owns a tile, which agrees with truncation on the positive half of the grid
  // and disagrees on the negative one -- and Town Hall is at the origin, so half
  // the city is on the wrong side of that.
  {
    const failures = verifyMeshPack();
    check(
      failures.length === 0,
      failures.length
        ? `mesh packing round trip: ${failures[0]}`
        : 'quantised geometry survives the round trip, and _BLDIDX and the indices come back exact',
    );
  }
  {
    const failures = verifyRegions();
    check(
      failures.length === 0,
      failures.length
        ? `region bundles: ${failures[0]}`
        : 'a region bundle round-trips, refuses a truncated or future one, and owns the right tiles either side of the origin',
    );
  }
  {
    const geometry = (index as { geometry?: { pack?: number } }).geometry;
    check(
      geometry?.pack === undefined || geometry.pack === TILE_PACK_VERSION,
      `this world's geometry is packed to a version this client reads (${geometry?.pack ?? 'unpacked'} vs ${TILE_PACK_VERSION})`,
    );
  }

  // --- 2. A transient failure retries and then succeeds; a 404 does not.
  //
  // The distinction is the whole of defect 1 and it is invisible from either
  // side: a tile quietly never asked for again looks exactly like a slow
  // network, and a 404 asked for forever looks exactly like a healthy client.
  {
    const ledger = new TileRetryLedger();
    const t0 = 1_700_000_000_000;
    const flaky = index.tiles[0].key;

    check(
      classifyTileFailure(new TileFetchError(`tiles/${flaky}.glb`, 503)) === 'transient' &&
        classifyTileFailure(new TileFetchError(`tiles/${flaky}.glb`, 404)) === 'permanent',
      'a 503 is a fact about the moment and a 404 is a fact about the build',
    );

    ledger.noteTransient(flaky, t0, '503');
    check(!ledger.ready(flaky, t0 + 1_000), `${flaky} is not re-fetched one second after a 503`);
    check(ledger.ready(flaky, t0 + 5_000), `${flaky} is re-fetched five seconds after a 503`);
    // ...and the retry lands, which is what the streamer's commit step does.
    ledger.clear(flaky);
    check(
      ledger.retryingCount === 0 && ledger.ready(flaky, t0 + 5_001),
      'a tile that loaded on the retry is forgotten entirely, attempt count and all',
    );
    // The reset is not cosmetic: without it the next hiccup, hours later, would
    // wait 45 s rather than 5 s and the tile would be an invisible wall for
    // nine times as long as it should be.
    ledger.noteTransient(flaky, t0 + 3_600_000, '503');
    check(
      ledger.ready(flaky, t0 + 3_600_000 + 5_000),
      'a later hiccup waits 5 s again rather than inheriting the old attempt count',
    );

    const absent = index.tiles[1].key;
    const first = ledger.notePermanent(absent, '404');
    const second = ledger.notePermanent(absent, '404');
    check(first && !second, `${absent} is logged once as absent from the build, not once a frame`);
    check(
      !ledger.ready(absent, t0 + 86_400_000) && ledger.permanentCount === 1,
      'a 404 tile stays suppressed for the session and is counted where somebody can see it',
    );
  }

  // --- 3. The teleport tour: A -> B -> A across the real extent, with the real
  //        payloads, under both rules.
  //
  // What is being compared is an *ordering*, so the network is abstracted to
  // the one thing about it that decides the ordering: how many tiles can be in
  // flight at once. A tick retires up to `SLOTS` geometry payloads, nearest
  // first, which is `TileStreamer.update`'s own ranking; collision is a 9 kB
  // file against a 1.6 MB one, so it lands a tick after it is asked for, ahead
  // of any geometry requested at the same moment. Nothing here predicts a
  // wall-clock. It predicts which of two rules leaves the player standing in
  // solid air, and for how many ticks.
  //
  // A teleport rather than a walk, and that is the case that matters: walking
  // back into a suburb requests its geometry at 1,800 m and its collision at
  // 420 m, so the geometry has a kilometre of warning. A teleport asks for both
  // at once -- and under the rule that shipped, the collision was never asked
  // for at all, because it had been sitting in the grid since the last visit.
  const RENDER_RADIUS_M = 1800;
  const SLOTS = 4;
  const HAZARD_EXTRA_SLOTS = 2;
  /** `InvisibleWalls.SCAN_RADIUS_M`: the collision ring plus a tile. */
  const SCAN_RADIUS_M = COLLISION_LOAD_RADIUS_M + 500;
  const near = (b: readonly [number, number, number, number], x: number, z: number): number => {
    const dx = Math.max(b[0] - x, 0, x - b[2]);
    const dz = Math.max(b[1] - z, 0, z - b[3]);
    return Math.hypot(dx, dz);
  };

  // A real route: the busiest tile in the build out to the furthest one and
  // back. Busiest because the wall count is what the defect is measured in, and
  // furthest because the return has to cross the render radius to evict
  // anything at all.
  const busiest = index.tiles.reduce((a, t) => (t.b > a.b ? t : a), index.tiles[0]);
  const home = {
    x: (busiest.bounds[0] + busiest.bounds[2]) / 2,
    z: (busiest.bounds[1] + busiest.bounds[3]) / 2,
  };
  const away = index.tiles.reduce(
    (best, t) => {
      const c = { x: (t.bounds[0] + t.bounds[2]) / 2, z: (t.bounds[1] + t.bounds[3]) / 2 };
      const d = Math.hypot(c.x - home.x, c.z - home.z);
      return d > best.d ? { ...c, d } : best;
    },
    { x: home.x, z: home.z, d: 0 },
  );
  check(
    away.d > 2 * RENDER_RADIUS_M,
    `the tour teleports ${(away.d / 1000).toFixed(1)} km out and back, which is past the ${RENDER_RADIUS_M} m ` +
      'render radius and therefore past every geometry eviction there is',
  );

  const payloads = new Map<string, ArrayBuffer>();
  for (const entry of index.tiles) {
    const bytes = await readFile(join(root, 'collision', `${entry.key}.bin`)).catch(() => null);
    if (bytes) {
      payloads.set(
        entry.key,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    }
  }
  check(payloads.size > 0, `${payloads.size} collision payloads read off the disk for the tour`);

  interface TourResult {
    /** Walls standing in solid air on the tick the player arrives home. */
    wallsOnArrival: number;
    /** And how many tiles that is. */
    tilesOnArrival: number;
    /** Ticks from the arrival until the hazard overlay is clear again. */
    ticksToClear: number;
    /** Steps at which a tile inside the collision ring had no prisms. */
    safetyBreaches: number;
    /** Tiles whose prisms were dropped over the whole tour. */
    evicted: number;
  }

  /**
   * @param parity the fix: collision evicted with geometry outside the keep
   *   radius, and a tile whose prisms are resident fetched and built ahead of
   *   the queue because it is a wall right now rather than a hole.
   */
  const runTour = (parity: boolean): TourResult => {
    const collision = new CollisionWorld();
    /** Tiles whose collision request lands at the end of this tick. */
    let collisionInFlight: string[] = [];
    const built = new Set<string>();
    const queue: string[] = [];
    let evicted = 0;
    let safetyBreaches = 0;

    const hazard = (key: string): boolean => parity && collision.hasTile(key) && !built.has(key);

    /** Walls the overlay would draw right now. `InvisibleWalls.scan`, verbatim. */
    const amber = (x: number, z: number): { tiles: number; walls: number } => {
      let tiles = 0;
      let walls = 0;
      for (const entry of index.tiles) {
        if (entry.b <= 0) continue;
        if (near(entry.bounds, x, z) > SCAN_RADIUS_M) continue;
        if (!collision.hasTile(entry.key)) continue;
        if (built.has(entry.key)) continue;
        tiles++;
        walls += entry.b;
      }
      return { tiles, walls };
    };

    const tick = (x: number, z: number): void => {
      // 1. Collision requested last tick lands. 9 kB against 1.6 MB.
      for (const key of collisionInFlight) {
        const entry = index.tiles.find((t) => t.key === key)!;
        const payload = payloads.get(key);
        if (payload && !collision.hasTile(key)) {
          collision.addTile(key, payload.slice(0), entry.bounds[0], entry.bounds[1] + index.tile_size, entry.b);
        }
      }
      collisionInFlight = [];

      // 2. Geometry eviction, and -- the fix -- the prisms with it.
      for (const entry of index.tiles) {
        const d = near(entry.bounds, x, z);
        if (d <= RENDER_RADIUS_M) continue;
        const at = queue.indexOf(entry.key);
        if (at >= 0) queue.splice(at, 1);
        if (!built.delete(entry.key) && at < 0) continue;
        if (parity && mayEvictCollision(d) && collision.hasTile(entry.key)) {
          collision.removeTile(entry.key);
          evicted++;
        }
      }

      // 3. `main.ts`'s `ensureGround`: collision for the 420 m ring.
      for (const entry of index.tiles) {
        if (near(entry.bounds, x, z) > COLLISION_LOAD_RADIUS_M) continue;
        if (!collision.hasTile(entry.key) && payloads.has(entry.key)) collisionInFlight.push(entry.key);
      }

      // 4. `TileStreamer.update`: queue everything in the render radius,
      //    nearest first -- and a tile that is a wall right now at the head of
      //    it rather than behind whatever arrived earlier.
      const wanted = index.tiles
        .map((entry) => ({ entry, d: near(entry.bounds, x, z) }))
        .filter((w) => w.d <= RENDER_RADIUS_M && !built.has(w.entry.key) && !queue.includes(w.entry.key))
        .sort((a, b) => a.d - b.d);
      for (const { entry } of wanted) {
        if (hazard(entry.key)) queue.unshift(entry.key);
        else queue.push(entry.key);
      }

      // 5. The tick's fetches retire. The hazard set gets slots nobody else
      //    can have -- bounded, because it is only ever the 420 m ring.
      let ordinary = SLOTS;
      let extra = parity ? HAZARD_EXTRA_SLOTS : 0;
      while (queue.length > 0) {
        const key = queue[0];
        if (hazard(key) && extra > 0) extra--;
        else if (ordinary > 0) ordinary--;
        else break;
        queue.shift();
        built.add(key);
      }

      // 6. The safety invariant. Every tile inside the ring the player's own
      //    collision is fetched on has its prisms, or it is in flight this
      //    tick -- which is the state a first visit is in and is not a
      //    regression, so it is only counted once the request has had a tick.
      for (const entry of index.tiles) {
        if (near(entry.bounds, x, z) > COLLISION_LOAD_RADIUS_M) continue;
        if (!payloads.has(entry.key)) continue;
        if (!collision.hasTile(entry.key) && !collisionInFlight.includes(entry.key)) safetyBreaches++;
      }
    };

    // Settle at home, teleport away, settle, teleport back. Sixty ticks is
    // long enough for either rule to retire a 1,800 m radius at four a tick.
    const SETTLE = 60;
    for (let i = 0; i < SETTLE; i++) tick(home.x, home.z);
    for (let i = 0; i < SETTLE; i++) tick(away.x, away.z);

    // The arrival. Measured *after* the tick, which is the first frame the
    // player can see anything: collision that was already resident is already
    // stopping them, and geometry that was evicted is four tiles into a queue.
    tick(home.x, home.z);
    const arrival = amber(home.x, home.z);
    let ticksToClear = 0;
    while (ticksToClear < SETTLE && amber(home.x, home.z).tiles > 0) {
      tick(home.x, home.z);
      ticksToClear++;
    }

    return {
      wallsOnArrival: arrival.walls,
      tilesOnArrival: arrival.tiles,
      ticksToClear,
      safetyBreaches,
      evicted,
    };
  };

  const before = runTour(false);
  const after = runTour(true);

  check(
    before.evicted === 0 && after.evicted > 0,
    `the old rule evicted 0 tiles' prisms over the tour and the new one evicted ${after.evicted}`,
  );
  check(
    before.safetyBreaches === 0 && after.safetyBreaches === 0,
    `neither rule ever left a tile inside the ${COLLISION_LOAD_RADIUS_M} m collision ring without its prisms ` +
      `(${before.safetyBreaches} / ${after.safetyBreaches} breaches over the whole tour)`,
  );
  check(
    before.wallsOnArrival > 0,
    `the rule that shipped puts ${before.wallsOnArrival} walls across ${before.tilesOnArrival} tiles ` +
      'into solid air on the tick the player arrives home -- the defect, reproduced',
  );
  check(
    after.wallsOnArrival < before.wallsOnArrival,
    `the parity rule arrives with ${after.wallsOnArrival} walls across ${after.tilesOnArrival} tiles ` +
      `instead of ${before.wallsOnArrival} across ${before.tilesOnArrival}`,
  );
  check(
    after.ticksToClear <= before.ticksToClear,
    `and clears in ${after.ticksToClear} ticks against ${before.ticksToClear}`,
  );


  // --- 4. And the eviction really is an eviction: the prisms are gone from the
  // grid, not merely unlisted. A `hasTile` that answered false over a grid that
  // still held the polygons would pass every test above and stop the player
  // exactly as before.
  {
    const entry = index.tiles.find((t) => t.b > 0 && payloads.has(t.key));
    check(entry !== undefined, 'the grid-emptying case has a real tile with buildings in it to use');
    if (entry) {
      const world = new CollisionWorld();
      const payload = payloads.get(entry.key)!;
      const added = world.addTile(entry.key, payload.slice(0), entry.bounds[0], entry.bounds[1] + index.tile_size, entry.b);
      const cx = (entry.bounds[0] + entry.bounds[2]) / 2;
      const cz = (entry.bounds[1] + entry.bounds[3]) / 2;
      const held = world.prismsWithin(cx, cz, 400).length;
      const removed = world.removeTile(entry.key);
      check(
        removed === added && world.buildingCount === 0 && !world.hasTile(entry.key),
        `${entry.key}: all ${added} prisms went out with the tile`,
      );
      check(
        held > 0 && world.prismsWithin(cx, cz, 400).length === 0,
        `and the grid is empty where ${held} prisms stood, so nothing is left to stop the player`,
      );
      // Re-adding is a fresh decode rather than a resurrection, which is what a
      // revisit actually does.
      const again = world.addTile(entry.key, payload.slice(0), entry.bounds[0], entry.bounds[1] + index.tile_size, entry.b);
      check(
        again === added && world.prismsWithin(cx, cz, 400).length === held,
        'a tile that comes back is the same tile, decoded again from its own payload',
      );
      check(world.removeTile('never_loaded') === 0, 'removing a tile that was never added does nothing');
    }
  }
}

/**
 * The walk-under rule, over the four viaducts the player actually meets.
 *
 * Appended last and self-contained. What it asserts is one sentence --
 * `CollisionWorld.resolve` reads a prism's `base` as a soffit where the pipeline
 * wrote one -- and the reason it needs a world file to assert it is that the
 * sentence is only interesting where the soffits are real: the Western
 * Distributor over Pyrmont, the Bradfield approach under the Harbour Bridge, the
 * Cahill over Alfred Street, and the Broadway viaduct a player reported as an
 * invisible wall heading into the city.
 *
 * Every course here was found by measurement rather than by guess -- the longest
 * straight line whose every 2 m sample is over dry land, under a structural
 * prism with at least `cli.WALKABLE_UNDER_M` of clearance, and clear of any
 * prism a body overlaps -- and each is walked by `player/controller.ts` itself
 * at the fixed step, not by a bespoke integrator. The comparison is against the
 * *old* rule rather than against a number: the same collision payloads, added
 * without their building count, mark every prism a building, and a building is
 * `feetY >= top - 0.05` and nothing else, which is the test this file shipped
 * with. So "before" is not a memory, it is a second world in the same process.
 */
async function checkSoffits(): Promise<void> {
  say('soffits: walking under the city, against the world files');

  // --- 1. The rule itself, on two module instances.
  //
  // Two, because `collision.ts` is run by the client, by the server and by
  // rewind, and a rule that lived in module state would pass on the instance
  // that happened to be warm. Same argument as `checkPolice`.
  const here = new URL('../client/src/player/collision.ts', import.meta.url).pathname;
  const one = (await import(here)) as typeof import('../client/src/player/collision.ts');
  const two = (await import(`${here}?instance=2`)) as typeof import('../client/src/player/collision.ts');
  check(one.CollisionWorld !== two.CollisionWorld, 'the two collision module instances really are separate');
  for (const [label, mod] of [['instance 1', one], ['instance 2', two]] as const) {
    const f = mod.verifyCollision();
    check(f.length === 0, `verifyCollision passes on ${label}` + (f.length ? ` -- ${f[0]}` : ''));
  }
  check(verifyCollision().length === 0, 'and on the instance this file imported directly');

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);

  /**
   * The same collision payloads in a fresh world, with or without the building
   * count that marks a tile's structures. Without it every prism is a building
   * and the answers are the ones this file gave before the walk-under rule.
   */
  const collisionFrom = async (
    Ctor: typeof CollisionWorld,
    counts: boolean,
  ): Promise<CollisionWorld> => {
    const w = new Ctor();
    for (const entry of world.index.tiles) {
      let payload: ArrayBuffer;
      try {
        const buf = await readFile(join(root, 'collision', `${entry.key}.bin`));
        payload = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      } catch {
        continue;
      }
      w.addTile(
        entry.key,
        payload,
        entry.bounds[0],
        entry.bounds[1] + world.index.tile_size,
        counts ? entry.b : undefined,
      );
    }
    return w;
  };

  const before = await collisionFrom(one.CollisionWorld, false);
  const after = world.collision;

  /**
   * Walk a body from A to B with the real controller and the server's own
   * ground, and report how far along the line it ever got.
   *
   * `groundHeightAt` is `world.groundFor`'s, rebuilt here only because that one
   * closes over a `lastGround` per combatant and this wants a fresh one per
   * walk. The trajectory is recorded whole, because the byte-identity check
   * below compares paths rather than endpoints -- two runs can arrive at the
   * same doorway by different routes.
   */
  const walkUnder = (
    collision: CollisionWorld,
    ax: number,
    az: number,
    bx: number,
    bz: number,
  ): { travelled: number; want: number; x: number; z: number; feet: number; path: number[] } => {
    const want = Math.hypot(bx - ax, bz - az);
    const ux = (bx - ax) / want;
    const uz = (bz - az) / want;
    // `controller.step`'s basis: forward is (-sin yaw, -cos yaw).
    const yaw = Math.atan2(-ux, -uz);
    let lastGround = 0;
    const groundAt = (x: number, z: number, feetY: number): number => {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      return Math.max(lastGround, collision.roofHeight(x, z, feetY));
    };
    const state = createPlayerState(ax, az);
    state.position.y = groundAt(ax, az, -Infinity) + EYE_HEIGHT;
    const input = { forward: 1, right: 0, jump: false, sprint: false, yaw, pitch: 0 };
    const path: number[] = [];
    let travelled = 0;
    for (let tick = 0; tick < 60 * 60; tick++) {
      step(state, input, 1 / 60, collision, groundAt);
      path.push(state.position.x, state.position.y, state.position.z);
      const along = (state.position.x - ax) * ux + (state.position.z - az) * uz;
      if (along > travelled) travelled = along;
      if (travelled >= want) break;
    }
    return {
      travelled,
      want,
      x: state.position.x,
      z: state.position.z,
      feet: state.position.y - EYE_HEIGHT,
      path,
    };
  };

  /** [name, from x, from z, to x, to z]. Measured; see the header. */
  const COURSES: ReadonlyArray<readonly [string, number, number, number, number]> = [
    ['the Western Distributor at Pyrmont', -1560, 275, -1440, 385],
    ['the Harbour Bridge south approach', -38, -1642, 16, -1600],
    ['the Broadway viaduct at Haymarket', -790, 607, -670, 551],
    ['the Cahill at Circular Quay', 0, -841, 26, -837],
  ];

  say('');
  for (const [name, ax, az, bx, bz] of COURSES) {
    const was = walkUnder(before, ax, az, bx, bz);
    const now = walkUnder(after, ax, az, bx, bz);
    check(
      now.travelled >= now.want - 0.5,
      `a player walks the full ${now.want.toFixed(0)} m under ${name} ` +
        `(${now.travelled.toFixed(1)} m, ending at ${now.x.toFixed(1)}, ${now.z.toFixed(1)}, ` +
        `feet ${now.feet.toFixed(1)})`,
    );
    // The other half of the same assertion: this course was genuinely impassable
    // before, so the check above cannot pass by accident on an open street.
    check(
      was.travelled < now.want * 0.5,
      `  and could not before -- the old rule stopped them after ${was.travelled.toFixed(1)} m ` +
        `at (${was.x.toFixed(1)}, ${was.z.toFixed(1)})`,
    );
  }

  // --- 2. What still stops you. A deck is not a hole in the world: its piers
  //        stand in the street, and the touchdown ramps `decks.py` runs from the
  //        ground up are solid embankments by construction.
  say('');
  {
    let solid = 0;
    let air = 0;
    for (const prism of after.prismsWithin(-1500, 325, 200)) {
      if (!prism.structural) continue;
      const x = (prism.minX + prism.maxX) * 0.5;
      const z = (prism.minZ + prism.maxZ) * 0.5;
      const g = world.terrain.height(x, z);
      if (!Number.isFinite(g)) continue;
      if (after.resolve(x, z, x, z, PLAYER_RADIUS, g + 0.42, g + BODY_HEIGHT_M).hit) solid++;
      else air++;
    }
    check(
      solid > 0 && air > 0,
      `of the structural prisms over Pyrmont, ${solid} are still solid at street level ` +
        `(piers, parapets, touchdown ramps) and ${air} are now air`,
    );
  }

  // --- 3. Standing on the deck, which is the failure a walk-under rule invites:
  //        a soffit that stops being a floor for the people on top of it.
  {
    // A deck with *walkable street under it*, which is a stricter thing than a
    // high base: the Pyrmont stack puts parapets on decks on embankments, so the
    // first prism whose base is 4 m up can easily be a parapet standing over a
    // touchdown ramp that is solid to the ground. The extra clause is the same
    // null-move probe the courses use -- if a body can stand at street level
    // there, the volume over it is genuinely a soffit and not a lid.
    let deck: Prism | null = null;
    for (const prism of after.prismsWithin(-1500, 325, 150)) {
      const x = (prism.minX + prism.maxX) * 0.5;
      const z = (prism.minZ + prism.maxZ) * 0.5;
      const g = world.terrain.height(x, z);
      if (!prism.structural || !Number.isFinite(g) || prism.base - g <= 4) continue;
      if (after.resolve(x, z, x, z, PLAYER_RADIUS, g + 0.42, g + BODY_HEIGHT_M).hit) continue;
      deck = prism;
      break;
    }
    if (deck === null) {
      check(false, 'no elevated deck prism over Pyrmont to stand on -- the world files changed');
    } else {
      const x = (deck.minX + deck.maxX) * 0.5;
      const z = (deck.minZ + deck.maxZ) * 0.5;
      check(
        after.roofHeight(x, z, deck.top) === deck.top,
        `a player on the deck at (${x.toFixed(0)}, ${z.toFixed(0)}) stands on it ` +
          `(roofHeight ${after.roofHeight(x, z, deck.top).toFixed(2)} at its top ${deck.top.toFixed(2)})`,
      );
      // Against the *soffit* rather than against `-Infinity`: what must never
      // happen is a body at street level being handed the deck, or anything
      // else above the soffit, as its floor. Being handed something below the
      // soffit is not that -- a kerb, a plinth, the top of a solid touchdown
      // ramp beside it -- and `resolve` holds every one of those solid, which
      // is the pairing `roofHeight`'s own header describes.
      const underfoot = after.roofHeight(x, z, world.terrain.height(x, z));
      check(
        underfoot < deck.base,
        `and a player on the street under it is not teleported up onto it ` +
          `(ground under them ${underfoot === -Infinity ? 'the terrain' : underfoot.toFixed(2)}, ` +
          `soffit ${deck.base.toFixed(2)})`,
      );
      check(
        !after.resolve(x, z, x + 0.5, z, PLAYER_RADIUS, deck.top + 0.42, deck.top + BODY_HEIGHT_M).hit,
        'and can walk along it -- the deck top is not solid to whoever is on it',
      );
    }
  }

  // --- 4. Jumping under a soffit does not throw you sideways.
  //
  // A body already under a deck whose head enters the girder is left where it
  // is; pushing it out in plan would send it to the nearest edge of the
  // footprint, which under a 12 m viaduct is a six-metre teleport mid-jump. Run
  // over a jump's whole arc, apex included.
  {
    const [ax, az] = [-1500, 325];
    const g = world.terrain.height(ax, az);
    let worst = 0;
    for (let rise = 0; rise <= 1.2; rise += 0.05) {
      const feet = g + rise;
      const r = after.resolve(ax, az, ax, az + 0.07, PLAYER_RADIUS, feet + 0.42, feet + BODY_HEIGHT_M);
      worst = Math.max(worst, Math.hypot(r.x - ax, r.z - (az + 0.07)));
    }
    check(
      worst < 0.05,
      `a jump under the Western Distributor displaces the body by ${worst.toFixed(3)} m at most`,
    );
  }

  // --- 5. The widening property, over the real city rather than a synthetic one.
  //
  // `verifyCollision` runs this over randomised configurations; this runs it
  // over the actual prisms, which is the population that matters -- 61,068
  // buildings whose pads are not soffits among 6,814 structures whose bases are.
  // Nothing that was reachable may stop being reachable.
  {
    let seed = 0x51d;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    let newlyBlocked = 0;
    let newlyFree = 0;
    let moves = 0;
    for (const [, cx, cz] of COURSES) {
      for (let i = 0; i < 4000; i++) {
        const x = cx + (rnd() - 0.5) * 400;
        const z = cz + (rnd() - 0.5) * 400;
        const g = world.terrain.height(x, z);
        if (!Number.isFinite(g)) continue;
        const tx = x + (rnd() - 0.5) * 3;
        const tz = z + (rnd() - 0.5) * 3;
        const feet = g + rnd() * 6;
        const a = before.resolve(x, z, tx, tz, PLAYER_RADIUS, feet + 0.42, feet + BODY_HEIGHT_M);
        const b = after.resolve(x, z, tx, tz, PLAYER_RADIUS, feet + 0.42, feet + BODY_HEIGHT_M);
        moves++;
        const reachedBefore = Math.hypot(a.x - tx, a.z - tz) < 1e-9;
        const reachedAfter = Math.hypot(b.x - tx, b.z - tz) < 1e-9;
        if (reachedBefore && !reachedAfter) newlyBlocked++;
        if (!reachedBefore && reachedAfter) newlyFree++;
      }
    }
    check(
      newlyBlocked === 0 && newlyFree > 0,
      `over ${moves.toLocaleString()} moves through the real city the rule is a strict widening: ` +
        `${newlyBlocked} newly blocked, ${newlyFree} newly passable`,
    );
  }

  // --- 6. Both authorities, byte for byte.
  //
  // The client predicts with this file, the server simulates with it and rewind
  // replays with it, so the trajectories have to be identical rather than close:
  // a metre of drift under a bridge is a player rubber-banded into a pier. Two
  // module instances, two worlds decoded from the same bytes, one course.
  {
    const second = await collisionFrom(two.CollisionWorld as unknown as typeof CollisionWorld, true);
    const [, ax, az, bx, bz] = COURSES[0];
    const a = walkUnder(after, ax, az, bx, bz);
    const b = walkUnder(second, ax, az, bx, bz);
    let drift = -1;
    if (a.path.length === b.path.length) {
      drift = 0;
      for (let i = 0; i < a.path.length; i++) {
        if (!Object.is(a.path[i], b.path[i])) drift = i + 1;
        if (drift > 0) break;
      }
    }
    check(
      a.path.length === b.path.length && drift === 0,
      `two module instances walked the ${(a.path.length / 3).toFixed(0)}-tick Pyrmont course to ` +
        `the same bits (${a.path.length === b.path.length ? `first divergence: none` : 'different lengths'})`,
    );
  }
}

// --- Global chat -----------------------------------------------------------------

/**
 * In-game chat, over real sockets, against a host running **two rooms**.
 *
 * The headline claim is the second one and it is the reason this check exists at
 * all: **a line typed in room 0 reaches a client in room 1.** Every other
 * channel in this server is a room's -- `checkRooms` asserts that a swing, a
 * knockout and a roster all stop at the boundary, over sockets, because "one
 * simulation per room" is only half of isolation. Chat is the single deliberate
 * exception, and an exception that is only claimed in a comment is an exception
 * that quietly stops being true the first time somebody folds the fan-out back
 * into `Room`.
 *
 * The rest, in order:
 *
 *   1. The pure arithmetic, via `verifyChat` -- the sanitiser's idempotence, the
 *      byte cap on multi-byte input, the two frame layouts and the rate window.
 *      Run here as well as at boot so a failure is one line of this report
 *      rather than a server that refused to start with a message nobody read.
 *   2. **Cross-room delivery.** The headline.
 *   3. **Attribution is the server's, never the client's.** Two players ask for
 *      the same name; the second is deduped by `Simulation.pickName`, and what
 *      appears in front of their message is what the *roster* calls them. There
 *      is no field in `CHAT_SAY` in which to claim otherwise, and the frame's own
 *      width is asserted to prove it.
 *   4. **The abuse floor**: the burst, the sustained rate, the repeat guard, and
 *      the private notice each of the last two produces.
 *   5. **Hostile payloads**: a length prefix that overruns its frame, a message
 *      far over the cap, control characters and a bidi override, an empty
 *      message, and a runt frame -- none of which may crash the server, and all
 *      of which must leave it answering afterwards.
 *   6. **Bots are silent**, which is structural rather than enforced: a bot is a
 *      `Participant` with no socket, so there is nothing for a `CHAT_SAY` to
 *      arrive on. Asserted by running rooms with bots in them and hearing
 *      nothing from any of them.
 */
async function checkChat(): Promise<void> {
  say('global chat, across rooms');

  // --- 1. The arithmetic, which the server also refuses to boot without.
  {
    const chatFailures = verifyChat();
    check(
      chatFailures.length === 0,
      `verifyChat: sanitisation, byte caps, both layouts and the rate window ` +
        `(${chatFailures.join('; ') || 'clean'})`,
    );
  }

  // --- The rest is over sockets, against a host running two rooms with a bot in
  // each. Two rooms is the whole point; the bots are section 6.
  const port = PORT + 3;
  const proc = Bun.spawn(['bun', 'run', new URL('./index.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      SYDNEY_PORT: String(port),
      SYDNEY_ROOMS: '2',
      SYDNEY_ROOM_CAP: '4',
      SYDNEY_BOTS: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(100);
      try {
        up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        // not yet
      }
    }
    if (!up) {
      check(false, 'a two-room host answered /health');
      return;
    }

    // --- 2. THE HEADLINE. One client in room 0, one in room 1, and a sentence
    // that has to cross.
    // Names deliberately **not** in `bots.BOT_NAMES`. Every room gets a Bazza
    // and a Shazza by design (see `Room`'s constructor), so a probe called Bazza
    // is deduped to "Bazza (2)" the moment it joins -- which is correct
    // behaviour and would silently invalidate section 3 below, whose whole point
    // is to control *when* the dedupe happens.
    const inRoom0 = new ChatProbe('Cobber');
    const inRoom1 = new ChatProbe('Drongo');
    await inRoom0.connect(`ws://127.0.0.1:${port}?room=0`);
    await inRoom1.connect(`ws://127.0.0.1:${port}?room=1`);
    check(
      inRoom0.room === 0 && inRoom1.room === 1,
      `two clients landed in different rooms (${inRoom0.room} and ${inRoom1.room})`,
    );
    // Neither appears in the other's roster at all: different simulations,
    // different scoreboards. This is the isolation chat is about to cross.
    check(
      !inRoom1.roster.some((r) => r.name === inRoom0.assignedName && inRoom0.assignedName !== ''),
      "and room 1's roster does not contain room 0's player -- the rooms are isolated",
    );

    inRoom0.lines.length = 0;
    inRoom1.lines.length = 0;
    inRoom0.say('oi is anyone over there');
    await sleep(500);

    const crossed = inRoom1.lines.find((l) => l.text === 'oi is anyone over there');
    check(
      crossed !== undefined,
      `a line typed in room 0 reached a client in room 1 (${inRoom1.lines.length} line(s) received)`,
    );
    check(
      inRoom0.lines.some((l) => l.text === 'oi is anyone over there'),
      'and came back to the sender off the wire rather than being echoed locally',
    );
    check(
      crossed !== undefined && crossed.room === 0,
      `the line carries the room it was said in (${crossed?.room}), so the receiver can mark it as from elsewhere`,
    );
    check(
      crossed !== undefined && crossed.sender === inRoom0.id && crossed.flags === 0,
      `attributed to sender ${crossed?.sender} (room 0's id ${inRoom0.id}), with no private or system flag`,
    );
    check(
      crossed !== undefined && crossed.name === inRoom0.assignedName && crossed.name !== '',
      `and carries the speaker's name (${JSON.stringify(crossed?.name)}) rather than an id room 1 has ` +
        `never heard of`,
    );

    // --- 3. The name is the server's, not the client's. A second player asks to
    // be "Cobber" **in the room the first one is in**, so `Simulation.pickName`
    // has to dedupe them; what then precedes their message is the deduped name,
    // read by everybody including a client in the other room.
    const twin = new ChatProbe('Cobber');
    await twin.connect(`ws://127.0.0.1:${port}?room=0`);
    check(
      twin.assignedName !== '' && twin.assignedName !== inRoom0.assignedName,
      `a second "Cobber" in the same room was renamed by the server to ${JSON.stringify(twin.assignedName)} ` +
        `(the first is still ${JSON.stringify(inRoom0.assignedName)})`,
    );
    inRoom1.lines.length = 0;
    twin.say('it is me the real cobber');
    await sleep(500);
    const twinLine = inRoom1.lines.find((l) => l.text === 'it is me the real cobber');
    check(
      twinLine !== undefined && twinLine.name === twin.assignedName,
      `the line is attributed ${JSON.stringify(twinLine?.name)}, which is the roster's name and not the one ` +
        `the client asked for`,
    );
    check(
      twinLine !== undefined && twinLine.name !== inRoom0.assignedName,
      "so the impostor's words do not appear under the original's name, even one room away",
    );
    // And structurally: there is nowhere in a CHAT_SAY to put a name at all.
    // Two bytes of header and the text, and nothing else on the wire.
    check(
      encodeChatSay('abc').byteLength === CHAT_SAY_HEADER_BYTES + 3,
      `a CHAT_SAY is ${CHAT_SAY_HEADER_BYTES} bytes and the text -- there is no sender field to forge`,
    );
    twin.close();

    // --- 4. The abuse floor. A fresh socket for each half, because the budget is
    // per socket and a test that inherited the last one's would be testing the
    // order these sections happen to be written in.
    {
      const flooder = new ChatProbe('Flooder');
      await flooder.connect(`ws://127.0.0.1:${port}?room=0`);
      inRoom1.lines.length = 0;
      flooder.lines.length = 0;
      // Six distinct messages in one breath. The bucket holds CHAT_BURST.
      for (let i = 0; i < 6; i++) flooder.say(`flood ${i}`);
      await sleep(600);
      const got = inRoom1.lines.filter((l) => l.text.startsWith('flood ')).length;
      check(
        got === CHAT_BURST,
        `six messages sent at once put ${got} through; the burst is ${CHAT_BURST} and the rest were dropped`,
      );
      const notices = flooder.lines.filter((l) => (l.flags & CHAT_FLAG.PRIVATE) !== 0);
      check(
        notices.length === 1 && (notices[0].flags & CHAT_FLAG.SYSTEM) !== 0,
        `the sender was told privately why, once rather than once per refusal ` +
          `(${notices.length}: ${JSON.stringify(notices[0]?.text ?? '')})`,
      );
      check(
        !inRoom1.lines.some((l) => (l.flags & CHAT_FLAG.PRIVATE) !== 0),
        'and nobody else was sent the throttle notice',
      );
      // The sustained rate: one interval of real time buys exactly one more.
      inRoom1.lines.length = 0;
      await sleep(CHAT_INTERVAL_MS + 250);
      flooder.say('after the wait a');
      flooder.say('after the wait b');
      await sleep(600);
      const after = inRoom1.lines.filter((l) => l.text.startsWith('after the wait')).length;
      check(
        after === 1,
        `after one ${CHAT_INTERVAL_MS} ms interval exactly ${after} of two further messages got through`,
      );
      flooder.close();
    }

    {
      const parrot = new ChatProbe('Parrot');
      await parrot.connect(`ws://127.0.0.1:${port}?room=1`);
      inRoom0.lines.length = 0;
      parrot.lines.length = 0;
      // The same word three times running. The repeat guard fires on the third,
      // before the rate limiter has a chance to -- CHAT_BURST is 3, so all three
      // would otherwise have been affordable. The third is spelled differently
      // on purpose: case and trailing space must not make it a new message.
      parrot.say('oi');
      parrot.say('oi');
      parrot.say('OI   ');
      await sleep(600);
      const heard = inRoom0.lines.filter((l) => l.text.toLowerCase() === 'oi').length;
      check(
        heard === CHAT_REPEAT_LIMIT - 1,
        `the same word three times in a row put ${heard} through; the third was dropped as a repeat, ` +
          `and neither case nor a trailing space made it a different message`,
      );
      const notice = parrot.lines.find((l) => (l.flags & CHAT_FLAG.SYSTEM) !== 0);
      check(notice !== undefined, `and the sender was told (${JSON.stringify(notice?.text ?? '')})`);
      // A refusal must not have cost a token: saying something else works
      // immediately, which is what stops a stutter costing a normal player the
      // next four seconds of conversation.
      inRoom0.lines.length = 0;
      parrot.say('something else entirely');
      await sleep(600);
      check(
        inRoom0.lines.some((l) => l.text === 'something else entirely'),
        'and a different message straight after a repeat refusal still went out -- a refusal costs no budget',
      );
      parrot.close();
    }

    // --- 5. Hostile and malformed payloads. Nothing here may throw inside the
    // server's message handler: a throw there takes the socket with it, and the
    // symptom is one player silently disconnected by another player's paste.
    {
      const hostile = new ChatProbe('Hostile');
      await hostile.connect(`ws://127.0.0.1:${port}?room=0`);
      inRoom1.lines.length = 0;

      // A length prefix claiming far more than arrived. The decoder must clamp
      // to the frame rather than build a view past its end, which throws.
      const lying = new ArrayBuffer(CHAT_SAY_HEADER_BYTES + 5);
      const lv = new DataView(lying);
      lv.setUint8(0, MSG.CHAT_SAY);
      lv.setUint8(1, 255);
      new Uint8Array(lying, CHAT_SAY_HEADER_BYTES).set(new TextEncoder().encode('short'));
      hostile.raw(lying);

      // A runt: the type byte and nothing else.
      const runt = new ArrayBuffer(1);
      new DataView(runt).setUint8(0, MSG.CHAT_SAY);
      hostile.raw(runt);

      // An empty message and one of pure whitespace, both of which must be
      // dropped silently -- and must not cost the sender any of their budget,
      // which the message after them proves.
      hostile.raw(encodeChatSay(''));
      hostile.raw(encodeChatSay('     '));
      await sleep(600);

      check(
        inRoom1.lines.some((l) => l.text === 'short'),
        'a CHAT_SAY whose length prefix overran its frame was clamped to what arrived -- not dropped, not fatal',
      );
      check(
        !inRoom1.lines.some((l) => l.text === ''),
        'an empty message and one of pure whitespace were both dropped without a line',
      );

      // Far over the cap, and multi-byte so the *byte* limit is what bites
      // rather than the character one.
      inRoom1.lines.length = 0;
      await sleep(CHAT_INTERVAL_MS + 250);
      hostile.raw(encodeChatSay('水'.repeat(400)));
      await sleep(600);
      const clipped = inRoom1.lines.find((l) => l.text.startsWith('水'));
      const clippedBytes = clipped ? new TextEncoder().encode(clipped.text).length : -1;
      check(
        clipped !== undefined && clippedBytes > 0 && clippedBytes <= MAX_CHAT_BYTES,
        `a 400-character CJK message was clipped to ${clippedBytes} bytes, inside the ${MAX_CHAT_BYTES} cap`,
      );
      check(
        clipped !== undefined && !clipped.text.includes('�'),
        'and was clipped on a code-point boundary -- no half characters survived',
      );

      // Control characters and a bidirectional override, which is the one that
      // could otherwise turn a whole scrollback backwards.
      inRoom1.lines.length = 0;
      await sleep(CHAT_INTERVAL_MS + 250);
      hostile.raw(encodeChatSay('run‮away\nnow'));
      await sleep(600);
      const cleaned = inRoom1.lines.find((l) => l.text.includes('run'));
      check(
        cleaned !== undefined && cleaned.text === 'runaway now',
        `a message carrying a bidi override, a newline and a bell arrived as ${JSON.stringify(cleaned?.text)}`,
      );

      // And the server is still there, which is the assertion everything above
      // is really making.
      const alive = await fetch(`http://127.0.0.1:${port}/health`);
      check(alive.ok, 'the server is still answering after every malformed frame above');
      hostile.close();
    }

    // --- 6. Bots are silent. Both rooms have had a bot in them for the whole of
    // this check and neither has said anything, which is structural rather than
    // enforced: a bot has no socket for a CHAT_SAY to arrive on.
    {
      const botIds = new Set(inRoom1.roster.filter((r) => r.bot).map((r) => r.id));
      check(botIds.size > 0, `room 1 holds ${botIds.size} bot(s) to be silent`);
      check(
        !inRoom1.lines.some((l) => botIds.has(l.sender)) && !inRoom0.lines.some((l) => botIds.has(l.sender)),
        'and not one line of chat in this whole check came from a bot',
      );
    }

    inRoom0.close();
    inRoom1.close();
    await sleep(150);
  } finally {
    proc.kill();
    await proc.exited;
  }
}

/**
 * A synthetic client that keeps what it was told, for chat. `RoomProbe`'s
 * sibling, and its own class for that class's own stated reason: what it watches
 * is different. It needs the name the server actually assigned it -- which is
 * not always the one it asked for, and is the whole of section 3 -- and it needs
 * to be able to put an arbitrary buffer on the wire, which no other probe here
 * has any use for.
 */
class ChatProbe {
  private socket!: WebSocket;
  id = 0;
  room = -1;
  roster: RosterEntry[] = [];
  readonly lines: ChatLine[] = [];

  constructor(readonly wanted: string) {}

  /** What the roster says this probe is called, which is the server's last word. */
  get assignedName(): string {
    return this.roster.find((r) => r.id === this.id)?.name ?? '';
  }

  connect(url: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        // A beat of slack after the WELCOME, for two reasons: the ROSTER that
        // follows it has to land (`assignedName` is read off that and nothing
        // else), and the chat gate is created on this socket's first message, so
        // a probe that started talking in the same millisecond it connected
        // would be testing the handshake rather than the rate limiter.
        setTimeout(resolve, 200);
      };
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      socket.onopen = () => socket.send(encodeHello(255, this.wanted));
      socket.onerror = () => done();
      socket.onclose = () => done();
      socket.onmessage = (e) => {
        const frame = e.data as ArrayBuffer;
        switch (frameType(frame)) {
          case MSG.WELCOME: {
            const w = decodeWelcome(frame);
            if (!w) return;
            this.id = w.id;
            this.room = w.room;
            done();
            return;
          }
          case MSG.ROSTER: {
            this.roster = decodeRoster(frame) ?? this.roster;
            return;
          }
          case MSG.CHAT_LINE: {
            const line = decodeChatLine(frame);
            if (line) this.lines.push(line);
            return;
          }
          default:
            return;
        }
      };
      setTimeout(done, 5000);
    });
  }

  say(text: string): void {
    this.raw(encodeChatSay(text));
  }

  /** Whatever bytes you like. Section 5 is entirely this. */
  raw(frame: ArrayBuffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(frame);
  }

  close(): void {
    this.socket?.close();
  }
}

/**
 * The suggestions box: the ledger's arithmetic, then the whole thing over a real
 * socket.
 *
 * Every failure this catches is silent in this file's usual sense -- the panel
 * opens, the votes are accepted, the issue appears -- and the count is simply
 * wrong. Specifically, and each of these is a section below:
 *
 *   - **A week boundary computed with epoch arithmetic** is an hour out for half
 *     the year, so twice a year somebody's four votes refill early. Nobody
 *     reports this, because nobody is counting their votes against a clock.
 *   - **A quota counted from what the client sent** rather than from the ledger
 *     is no quota. The panel is the thing being defended against, and it is the
 *     thing that reported the number.
 *   - **One vote per suggestion per week enforced across all weeks** silently
 *     deletes the feature the user actually asked for: *"votes can stack up over
 *     time if someone consistently votes on something"*. It reads as working --
 *     you voted, it counted -- until somebody notices they can never vote for
 *     their favourite again.
 *   - **A tally block a player can close early** lets a suggestion overwrite a
 *     score on the next flush. That is the one injection this feature has, and
 *     it lands in a public repo.
 *   - **A pending-sync queue that loses its votes when it drains** throws away
 *     exactly the week that mattered: the one before the token existed.
 *   - **An order that is not total** reshuffles the panel between refreshes.
 *
 * The first half runs against a real `SuggestionStore` with a temporary ledger
 * and an injected `fetch`, which is what lets the GitHub path be exercised --
 * queued, drained, backfilled, tallied -- with no network and no token. The
 * second half is a real server on its own port and a real socket, because the
 * quota is only worth anything if it survives the wire.
 */
async function checkSuggestions(): Promise<void> {
  say('SUGGESTIONS — the weekly vote, the ledger, and the GitHub mirror');

  const dir = `${Bun.env.TMPDIR ?? '/tmp'}/sydney-suggest-${process.pid}`;
  await Bun.$`mkdir -p ${dir}`.quiet();

  /** A store with no network at all: every GitHub call fails as if offline. */
  const offlineStore = (name: string): SuggestionStore =>
    new SuggestionStore({
      path: `${dir}/${name}.json`,
      repo: 'voidtype/sydrunner',
      token: '',
      timers: false,
      fetch: (async () => {
        throw new Error('no network in this check');
      }) as unknown as typeof fetch,
    });

  const ID_A = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
  const ID_B = '9f8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
  const ID_C = '11112222-3333-4444-5555-666677778888';

  // --- 1. The week, in Sydney, across both daylight-saving changeovers.
  //
  // Asserted here as well as in `verifySuggestions` because this is the one that
  // decides when four votes come back, and a check that only ran in the browser
  // would be a check that never ran on the machine keeping the ledger.
  {
    // Monday 00:00 Sydney in August is AEST (UTC+10) -- 14:00 UTC Sunday.
    const sundayNight = Date.parse('2026-08-02T13:59:00Z');
    const mondayMorning = Date.parse('2026-08-02T14:01:00Z');
    check(
      weekKey(sundayNight) === '2026-W31' && weekKey(mondayMorning) === '2026-W32',
      `the AEST week turns over at Monday 00:00 Sydney (${weekKey(sundayNight)} -> ${weekKey(mondayMorning)})`,
    );
    // In January it is AEDT (UTC+11) -- 13:00 UTC Sunday. A fixed +10 offset
    // gets this one wrong by an hour and looks perfect in August.
    const janBefore = Date.parse('2026-01-11T12:59:00Z');
    const janAfter = Date.parse('2026-01-11T13:01:00Z');
    check(
      weekKey(janBefore) !== weekKey(janAfter),
      `the AEDT week turns over an hour earlier in UTC, as it must (${weekKey(janBefore)} -> ${weekKey(janAfter)})`,
    );
    // The changeover Sundays themselves are not Mondays, so neither may split a
    // week -- which is precisely what epoch arithmetic does to them.
    const aprA = weekKey(Date.parse('2026-04-04T20:00:00Z'));
    const aprB = weekKey(Date.parse('2026-04-05T02:00:00Z'));
    const octA = weekKey(Date.parse('2026-10-03T14:00:00Z'));
    const octB = weekKey(Date.parse('2026-10-03T18:00:00Z'));
    check(
      aprA === aprB && octA === octB,
      `neither daylight-saving Sunday splits a week (April ${aprA}, October ${octA})`,
    );
    // And the ISO year, which is wrong on exactly one day a year in the naive
    // implementation: 1 January 2027 is a Friday and belongs to 2026's week 53.
    check(
      isoWeekOf(2027, 1, 1) === '2026-W53',
      `1 January 2027 is ${isoWeekOf(2027, 1, 1)}, the last week of the previous ISO year`,
    );
  }

  // --- 2. The quotas, against a real ledger.
  {
    const store = offlineStore('quota');
    const week1 = Date.parse('2026-08-05T04:00:00Z'); // Wednesday, 2026-W32
    const week2 = Date.parse('2026-08-12T04:00:00Z'); // the following Wednesday
    check(weekKey(week1) === '2026-W32' && weekKey(week2) === '2026-W33', 'the two test instants are in adjacent weeks');

    // Five suggestions from one client; the third and beyond are refused.
    const filed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const out = await store.submit(ID_A, '10.0.0.1', 'Bazza', `suggestion number ${i}`, 'because', week1);
      if (out.result === SUGGEST_RESULT.QUEUED || out.result === SUGGEST_RESULT.OK) filed.push(i);
    }
    check(
      filed.length === SUBMITS_PER_WEEK,
      `one client filed ${filed.length} of 5 attempted suggestions in a week (the cap is ${SUBMITS_PER_WEEK})`,
    );
    // And the cap is per week, not for ever.
    const nextWeek = await store.submit(ID_A, '10.0.0.1', 'Bazza', 'a thought I had on Monday', '', week2);
    check(
      nextWeek.result === SUGGEST_RESULT.QUEUED,
      `the same client may file again the following week (${nextWeek.message})`,
    );

    // Somebody else supplies things to vote on, from a different address so the
    // per-IP submit cap is not what is being measured.
    const targets: number[] = [];
    for (let i = 0; i < 2; i++) {
      await store.submit(ID_B, '10.0.0.2', 'Shazza', `another idea ${i}`, '', week1);
    }
    for (const s of store.records.suggestions) targets.push(s.localId);
    check(targets.length >= 5, `${targets.length} suggestions exist to vote on`);

    // --- The vote quota: four a week, and the fifth is refused.
    let counted = 0;
    let refused = 0;
    for (let i = 0; i < 6; i++) {
      const out = store.vote(ID_C, '10.0.0.3', targets[i % targets.length], 1, week1);
      if (out.result === SUGGEST_RESULT.OK) counted++;
      else refused++;
    }
    check(
      counted === VOTES_PER_WEEK,
      `a client cast ${counted} votes and was refused ${refused} in one week (the quota is ${VOTES_PER_WEEK})`,
    );

    // --- One vote per suggestion per week, and **the same one again next
    // week**. This pair is the mechanic the user asked for, and the second half
    // is the half that is easy to break while looking correct.
    const store2 = offlineStore('stack');
    await store2.submit(ID_B, '10.0.0.2', 'Shazza', 'let us climb the pylons', '', week1);
    const only = store2.records.suggestions[0].localId;
    const first = store2.vote(ID_A, '10.0.0.1', only, 1, week1);
    const second = store2.vote(ID_A, '10.0.0.1', only, 1, week1);
    check(first.result === SUGGEST_RESULT.OK, 'the first vote on a suggestion counts');
    check(
      second.result === SUGGEST_RESULT.QUOTA && /this week/.test(second.message),
      `voting twice on one suggestion in one week is refused, and says why: "${second.message}"`,
    );
    // It must not have spent a second vote from the budget.
    check(
      store2.list(ID_A, week1).votesLeft === VOTES_PER_WEEK - 1,
      `a refused repeat vote does not spend the quota (${store2.list(ID_A, week1).votesLeft} left)`,
    );
    const nextMonday = store2.vote(ID_A, '10.0.0.1', only, 1, week2);
    check(
      nextMonday.result === SUGGEST_RESULT.OK,
      'the same client may vote for the same suggestion again the following week — this is the stacking mechanic',
    );
    // And the score is **all-time**, so the two weeks add up rather than the
    // second replacing the first. This is the other half of "votes stack up".
    const stacked = store2.list(ID_A, week2).items.find((s) => s.localId === only);
    check(
      stacked?.score === 2 && stacked.ups === 2,
      `two votes a week apart give an all-time score of ${stacked?.score} from ${stacked?.ups} ups`,
    );
    // The quota resets: a fresh four in the new week.
    check(
      store2.list(ID_A, week2).votesLeft === VOTES_PER_WEEK - 1,
      `the weekly budget refilled and one is spent (${store2.list(ID_A, week2).votesLeft} left)`,
    );

    // --- The per-address cap, which is the sock-puppet speed bump. Twelve
    // clean client ids from one address get through the per-client quota
    // trivially and are stopped by this.
    const store3 = offlineStore('ip');
    await store3.submit(ID_B, '10.0.0.9', 'Shazza', 'a thing worth voting on', '', week1);
    const target = store3.records.suggestions[0].localId;
    let through = 0;
    for (let i = 0; i < 20; i++) {
      // A fresh, perfectly well-formed identity each time -- which is exactly
      // what clearing site data gives you, and the reason this cap exists.
      const puppet = crypto.randomUUID();
      if (store3.vote(puppet, '10.0.0.7', target, 1, week1).result === SUGGEST_RESULT.OK) through++;
    }
    check(
      through === IP_VOTES_PER_WEEK,
      `20 fresh client ids from one address landed ${through} votes (the per-address cap is ${IP_VOTES_PER_WEEK})`,
    );
    // And a different address is unaffected, or a share house is unplayable.
    check(
      store3.vote(crypto.randomUUID(), '10.0.0.8', target, 1, week1).result === SUGGEST_RESULT.OK,
      'a different address is not caught by another address had its fill',
    );
  }

  // --- 3. Sanitisation, and the one injection this feature actually has.
  {
    const store = offlineStore('clean');
    const at = Date.parse('2026-08-05T04:00:00Z');
    const hostile =
      `nice game ${TALLY_CLOSE}\n\n### Score 9999\n\n${TALLY_OPEN} and the rest`;
    await store.submit(ID_A, '10.0.0.1', 'Bazza', 'a reasonable sounding title', hostile, at);
    const stored = store.records.suggestions[0];
    check(
      !stored.body.includes(TALLY_CLOSE) && !stored.body.includes('<!--') && !stored.body.includes('-->'),
      'a body carrying the tally markers is neutralised before it is stored',
    );
    // The rendered issue body has exactly one block, and the player's text is
    // outside it -- which is the property that actually matters, because it is
    // what the next flush parses.
    const rendered = store.renderIssueBody(stored.localId);
    const opens = rendered.split(TALLY_OPEN).length - 1;
    const closes = rendered.split(TALLY_CLOSE).length - 1;
    check(
      opens === 1 && closes === 1,
      `the rendered issue body has exactly one tally block (${opens} open, ${closes} close)`,
    );
    check(
      rendered.indexOf('nice game') < rendered.indexOf(TALLY_OPEN),
      "the player's text stays outside the machine-managed block",
    );
    check(
      /machine|written by the game server|overwritten/i.test(rendered),
      'the block says in its own text that hand edits are overwritten',
    );
    // A title of nothing is refused rather than becoming a blank row.
    const empty = await store.submit(ID_B, '10.0.0.2', 'Shazza', '​​​  ', 'body', at);
    check(empty.result === SUGGEST_RESULT.BAD, `a title of invisibles is refused (${empty.message})`);
    // And a client id that is not one is refused before anything is written.
    const before = store.records.suggestions.length;
    const bogus = store.vote('not-a-uuid', '10.0.0.1', stored.localId, 1, at);
    check(
      bogus.result === SUGGEST_RESULT.BAD && store.records.suggestions.length === before,
      'a malformed client id is refused and writes nothing',
    );
  }

  // --- 4. The order, which is what "the top issue shows up first" means.
  {
    const store = offlineStore('order');
    const at = Date.parse('2026-08-05T04:00:00Z');
    for (const t of ['first idea here', 'second idea here', 'third idea here']) {
      await store.submit(crypto.randomUUID(), `10.1.0.${t.length}`, 'someone', t, '', at);
    }
    const ids = store.records.suggestions.map((s) => s.localId);
    // Give the middle one a clear lead and the last one a net negative.
    for (let i = 0; i < 3; i++) store.vote(crypto.randomUUID(), `10.2.0.${i}`, ids[1], 1, at);
    store.vote(crypto.randomUUID(), '10.2.1.0', ids[0], 1, at);
    store.vote(crypto.randomUUID(), '10.2.2.0', ids[2], -1, at);
    const ranked = store.list(ID_A, at).items;
    check(
      ranked[0].localId === ids[1] && ranked[0].score === 3,
      `the highest score is first (#${ranked[0].localId} on ${ranked[0].score})`,
    );
    check(
      ranked[ranked.length - 1].localId === ids[2] && ranked[ranked.length - 1].score === -1,
      'a net-negative suggestion sorts last rather than being hidden',
    );
    check(
      ranked.map((r) => r.score).every((s, i, a) => i === 0 || a[i - 1] >= s),
      `the whole list is score-descending (${ranked.map((r) => r.score).join(', ')})`,
    );
    // The order is total: an all-square list must not reshuffle between calls,
    // which reads as a rendering bug to anybody watching the panel.
    const flat = offlineStore('flat');
    for (const t of ['alpha idea here', 'bravo idea here', 'charlie idea here']) {
      await flat.submit(crypto.randomUUID(), '10.3.0.1', 'someone', t, '', at);
    }
    const once = flat.list(ID_A, at).items.map((s) => s.localId).join(',');
    const twice = flat.list(ID_B, at).items.map((s) => s.localId).join(',');
    check(once === twice, `an all-zero list draws in the same order twice (${once})`);
  }

  // --- 5. The pending-sync queue: it works with no token, and it drains
  // **without losing the votes it collected in the meantime**.
  //
  // This is the section that stands in for the deploy history: the feature
  // shipped before the credential existed, so the queue is not a fallback that
  // was never exercised, it is the path the first week ran on.
  {
    const at = Date.parse('2026-08-05T04:00:00Z');
    const path = `${dir}/drain.json`;
    const noToken = new SuggestionStore({
      path,
      repo: 'voidtype/sydrunner',
      token: '',
      timers: false,
      fetch: (async () => {
        throw new Error('should not be called without a token');
      }) as unknown as typeof fetch,
    });
    const queued = await noToken.submit(ID_A, '10.4.0.1', 'Bazza', 'ladders on the harbour bridge', 'let us climb', at);
    check(
      queued.result === SUGGEST_RESULT.QUEUED && queued.issue === 0,
      `with no token a suggestion is accepted and queued rather than refused ("${queued.message}")`,
    );
    const localId = noToken.records.suggestions[0].localId;
    // Votes accumulate against it normally. They are ours and never needed
    // GitHub, which is the whole storage argument in one assertion.
    for (let i = 0; i < 3; i++) noToken.vote(crypto.randomUUID(), `10.4.1.${i}`, localId, 1, at);
    const queuedView = noToken.list(ID_A, at).items[0];
    check(
      queuedView.pending && queuedView.score === 3 && queuedView.issue === 0,
      `a queued suggestion is votable and on ${queuedView.score} with no issue number yet`,
    );
    check(
      noToken.list(ID_A, at).linked === false,
      'the panel is told the server is not linked to GitHub, so "queued" means something to the player',
    );
    check(noToken.records.votes.length === 3, 'the votes are in the ledger, not on GitHub');
    // Nothing was synced, because there was nothing to sync with.
    check((await noToken.sync()).posted === 0, 'sync with no token posts nothing rather than throwing');
    await noToken.save();

    // Now a token appears. Same ledger file, new store -- which is what a
    // restart with the credential in place actually is.
    let posted: { title?: string; body?: string; labels?: string[] } | null = null;
    let patches = 0;
    const withToken = new SuggestionStore({
      path,
      repo: 'voidtype/sydrunner',
      token: 'not-a-real-token',
      timers: false,
      fetch: (async (_url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (method === 'POST') {
          posted = JSON.parse(String(init?.body));
          return new Response(JSON.stringify({ number: 41 }), { status: 201 });
        }
        if (method === 'PATCH') {
          patches++;
          return new Response('{}', { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }) as unknown as typeof fetch,
    });
    await withToken.load();
    check(
      withToken.records.suggestions.length === 1 && withToken.records.votes.length === 3,
      'the ledger survived the restart with its suggestion and its three votes',
    );
    const drained = await withToken.sync();
    check(drained.posted === 1, `the queue drained: ${drained.posted} issue posted on the first sync`);
    const after = withToken.list(ID_A, at).items[0];
    check(
      after.issue === 41 && !after.pending,
      `the issue number was backfilled onto the existing suggestion (#${after.issue})`,
    );
    check(
      after.score === 3,
      `and it kept every vote it collected while queued (score ${after.score})`,
    );
    const body = String((posted as { body?: string } | null)?.body ?? '');
    check(
      body.includes(TALLY_OPEN) && /Score 3/.test(body),
      'the issue was created with the accumulated tally already in it, not with a zero',
    );
    check(
      ((posted as { labels?: string[] } | null)?.labels ?? []).includes('suggestion'),
      'the issue is labelled `suggestion`, which is what the panel and the curator both filter on',
    );
    // A vote after the drain is a PATCH on the next flush and **not** an API
    // call of its own -- the anti-thrash rule the whole 60 s debounce exists for.
    const patchesBefore = patches;
    withToken.vote(crypto.randomUUID(), '10.4.9.9', localId, 1, at);
    check(patches === patchesBefore, 'a vote costs zero GitHub calls at the moment it is cast');
    await withToken.sync();
    check(patches === patchesBefore + 1, 'and exactly one PATCH on the next flush');
    // A flush with nothing new is free, which is what makes a quiet week cost
    // nothing at all against the rate limit.
    const quiet = await withToken.sync();
    check(quiet.patched === 0 && quiet.posted === 0, 'a flush with no change makes no GitHub calls');
  }

  // --- 6. GitHub being down, and GitHub being ahead of us.
  {
    const at = Date.parse('2026-08-05T04:00:00Z');
    const store = new SuggestionStore({
      path: `${dir}/refresh.json`,
      repo: 'voidtype/sydrunner',
      token: '',
      timers: false,
      fetch: (async () => {
        throw new Error('api.github.com is unreachable');
      }) as unknown as typeof fetch,
    });
    await store.submit(ID_A, '10.5.0.1', 'Bazza', 'a suggestion that predates the outage', '', at);
    const before = store.list(ID_A, at).items.length;
    await store.refresh();
    check(
      store.list(ID_A, at).items.length === before,
      'GitHub being unreachable serves the last good list from the ledger rather than emptying the panel',
    );

    // And the other direction: an issue written on GitHub directly, and one the
    // curator closed after building it. This is how a week *ends*.
    const merging = new SuggestionStore({
      path: `${dir}/merge.json`,
      repo: 'voidtype/sydrunner',
      token: 'not-a-real-token',
      timers: false,
      fetch: (async (_url: string, init?: RequestInit) => {
        if ((init?.method ?? 'GET') !== 'GET') return new Response(JSON.stringify({ number: 99 }), { status: 201 });
        return new Response(
          JSON.stringify([
            { number: 7, title: 'written straight onto github', body: 'by the curator', state: 'open', user: { login: 'voidtype' } },
            { number: 8, title: 'a pull request wearing the label', body: '', state: 'open', pull_request: {} },
          ]),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const adopted = await merging.refresh();
    check(adopted.adopted === 1, `an issue filed on GitHub directly is adopted into the panel (${adopted.adopted})`);
    check(
      merging.list(ID_A, at).items.some((s) => s.issue === 7),
      'and it is votable in game like any other',
    );
    check(
      !merging.list(ID_A, at).items.some((s) => s.issue === 8),
      'a pull request wearing the `suggestion` label is not adopted as a suggestion',
    );
  }

  // --- 7. The flood guard, which is a different failure from the weekly quota:
  // a client that sends ten thousand legal requests a second.
  {
    const guard = new FloodGuard(0);
    let allowed = 0;
    for (let i = 0; i < 200; i++) if (guard.allow(0)) allowed++;
    check(
      allowed === SUGGEST_BURST,
      `200 instantaneous requests were cut to ${allowed} (the burst is ${SUGGEST_BURST})`,
    );
    // The burst has to clear what a brisk *player* does -- open the panel, file
    // one, spend four votes, watch it reorder -- or the limiter is a bug that
    // only bites the people using the feature. The socket section above is that
    // sequence, and it is about a dozen requests.
    check(
      SUGGEST_BURST >= 20,
      `and the burst leaves room for a whole session's worth of clicking (${SUGGEST_BURST})`,
    );
    // And it refills, so a client that behaves is not punished for its burst.
    check(guard.allow(10_000), 'the bucket refills over time rather than latching shut');
  }

  // --- 8. The whole thing over a real socket, against a real server.
  //
  // Everything above is the ledger's arithmetic; this is the part that proves
  // the wire carries it. Two clients with different identities, a real
  // `MSG.SUGGEST` frame, and the ranked list coming back down `MSG.SUGGEST_LIST`.
  const port = PORT + 4;
  const ledger = `${dir}/socket.json`;
  const proc = Bun.spawn(['bun', 'run', new URL('./index.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      SYDNEY_PORT: String(port),
      SYDNEY_BOTS: '0',
      SYDNEY_SUGGESTIONS: ledger,
      // Explicitly cleared, so this section can never post to a real repo even
      // if the environment running the check happens to have a token in it.
      SYDNEY_GITHUB_TOKEN: '',
      // And pointed at a repo that does not exist, which is what makes this
      // section **hermetic**.
      //
      // Clearing the token is not enough on its own and that is worth stating,
      // because the first cut of this check assumed it was: reading the issue
      // list needs no credential at all (the real repo is public, see
      // `SuggestionStore.refresh`), so a check pointed at `voidtype/sydrunner`
      // adopts whatever is actually on GitHub the moment its five-minute
      // refresh lands -- and then asserts "no suggestions yet" against a board
      // with real ones on it. It failed exactly that way once. A 404 repo makes
      // the refresh a no-op, which also quietly asserts that a wrong
      // `SYDNEY_GITHUB_REPO` degrades to an empty panel rather than a crash.
      SYDNEY_GITHUB_REPO: 'voidtype/sydney-integration-check-no-such-repo',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  try {
    let up = false;
    for (let i = 0; i < 120 && !up; i++) {
      await sleep(100);
      try {
        up = (await fetch(`http://127.0.0.1:${port}/health`)).ok;
      } catch {
        // not yet
      }
    }
    if (!up) {
      check(false, 'the suggestions server never answered /health');
      return;
    }

    const client = await suggestProbe(`ws://127.0.0.1:${port}`, ID_A, 'Bazza');
    const other = await suggestProbe(`ws://127.0.0.1:${port}`, ID_B, 'Shazza');

    const opened = await client.list();
    check(opened !== null, 'a client asking for the list over the socket is sent one');
    check(
      opened!.votesLeft === VOTES_PER_WEEK && opened!.items.length === 0,
      `an untouched box offers ${opened?.votesLeft} votes and no suggestions yet`,
    );
    check(opened!.week === weekKey(), `and names the current Sydney week (${opened?.week})`);
    check(
      opened!.linked === false,
      'and reports honestly that this server has no GitHub link, so everything will queue',
    );

    const ack = await client.submit('bring back the monorail', 'it would be good for getting to Darling Harbour');
    check(
      ack !== null && (ack.result === SUGGEST_RESULT.QUEUED || ack.result === SUGGEST_RESULT.OK),
      `submitting over the socket is acknowledged: "${ack?.message}"`,
    );

    // The other client sees it, which is the whole point of the box being the
    // server's rather than the browser's.
    const seen = await other.list();
    check(
      seen !== null && seen.items.length === 1 && seen.items[0].title === 'bring back the monorail',
      `a second client sees the first one's suggestion (${seen?.items.length} row)`,
    );
    check(
      seen!.items[0].author === 'Bazza',
      `attributed to the submitter's in-game name as the server assigned it (${seen?.items[0].author})`,
    );
    check(
      seen!.items[0].myVote === 0 && seen!.votesLeft === VOTES_PER_WEEK,
      'and the second client has its own untouched quota — the list is per viewer',
    );

    // A second suggestion, so there is something to reorder.
    await other.submit('more ferries on the parramatta run', '');
    const two = await client.list();
    check(two!.items.length === 2, `two suggestions on the board (${two?.items.length})`);

    // Vote the second one up and watch it overtake.
    const before = (await client.list())!.items[0].title;
    const ferry = two!.items.find((s) => s.title.startsWith('more ferries'))!;
    const voteAck = await client.vote(ferry.localId, 1);
    check(voteAck?.result === SUGGEST_RESULT.OK, `a vote over the socket is counted: "${voteAck?.message}"`);
    const reordered = await client.list();
    check(
      reordered!.items[0].localId === ferry.localId && reordered!.items[0].score === 1,
      `the voted-up suggestion moved to the top (was "${before}", now "${reordered?.items[0].title}")`,
    );
    check(
      reordered!.votesLeft === VOTES_PER_WEEK - 1,
      `and the voter's remaining quota came down to ${reordered?.votesLeft}`,
    );
    check(
      reordered!.items[0].myVote === 1,
      'and the row is marked as one this client has already voted on this week',
    );

    // The repeat, over the wire, with the message the player actually sees.
    const repeat = await client.vote(ferry.localId, 1);
    check(
      repeat?.result === SUGGEST_RESULT.QUOTA && /Monday/.test(repeat.message),
      `voting twice on one suggestion is refused over the wire and explains the weekly reset: "${repeat?.message}"`,
    );

    // Exhaust the quota. Three more suggestions to spend on, then the fifth vote.
    for (let i = 0; i < 3; i++) {
      const p = await suggestProbe(`ws://127.0.0.1:${port}`, crypto.randomUUID(), `Filler ${i}`);
      await p.submit(`a filler suggestion number ${i}`, '');
      p.close();
    }
    const board = (await client.list())!.items;
    let spent = 1;
    for (const row of board) {
      if (row.myVote !== 0) continue;
      const out = await client.vote(row.localId, 1);
      if (out?.result === SUGGEST_RESULT.OK) spent++;
      else {
        check(
          out?.result === SUGGEST_RESULT.QUOTA && /votes left|a week/.test(out.message),
          `the ${spent + 1}th vote of the week is refused with the quota message: "${out?.message}"`,
        );
        break;
      }
    }
    check(spent === VOTES_PER_WEEK, `the client landed exactly ${spent} votes this week over the socket`);
    const spentList = await client.list();
    check(spentList!.votesLeft === 0, `and its panel now shows ${spentList?.votesLeft} votes left`);

    // The ledger is on disk, which is what "persist forever" rests on.
    await sleep(500);
    const onDisk = (await Bun.file(ledger).json()) as { suggestions: unknown[]; votes: unknown[] };
    check(
      Array.isArray(onDisk.suggestions) && onDisk.suggestions.length >= 5,
      `the ledger is on disk with ${onDisk.suggestions.length} suggestion(s) and ${onDisk.votes.length} vote(s)`,
    );

    // A malformed frame is ignored rather than taken personally: the socket
    // stays up and the next legitimate request is answered.
    //
    // The pause first, and it is not padding: this probe has just spent a
    // fortnight's worth of a human's clicking in about a second, so its flood
    // budget is genuinely low -- and a `null` here from the rate limiter rather
    // than from a dropped socket would make this check assert the opposite of
    // what it says. One second refills two, which is all the next request needs.
    await sleep(1200);
    client.raw(new Uint8Array([MSG.SUGGEST, 99, 3, 1, 2, 3]).buffer);
    await sleep(100);
    const stillThere = await client.list();
    check(stillThere !== null, 'a malformed suggest frame is ignored and the socket keeps working');

    client.close();
    other.close();
  } finally {
    proc.kill();
    await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  }
}

/**
 * A synthetic client for the suggestions box: a socket, an identity, and a
 * promise per request.
 *
 * Separate from `Probe` rather than folded into it, because it wants a different
 * shape: `Probe` accumulates state from a stream of snapshots, and this is
 * strictly request/response -- ask, await the one frame that answers. Folding
 * them together would have put a suggestions inbox on the class that models a
 * player.
 */
async function suggestProbe(
  url: string,
  id: string,
  name: string,
): Promise<{
  list(): Promise<SuggestionList | null>;
  submit(title: string, body: string): Promise<{ result: number; issue: number; message: string } | null>;
  vote(localId: number, dir: number): Promise<{ result: number; issue: number; message: string } | null>;
  raw(frame: ArrayBuffer): void;
  close(): void;
}> {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  let waitingList: ((l: SuggestionList | null) => void) | null = null;
  let waitingAck: ((a: { result: number; issue: number; message: string } | null) => void) | null = null;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no welcome within 5 s')), 5000);
    socket.onopen = () => socket.send(encodeHello(255, name));
    socket.onerror = () => {
      clearTimeout(timer);
      reject(new Error('socket error'));
    };
    socket.onmessage = (e) => {
      const frame = e.data as ArrayBuffer;
      const type = frameType(frame);
      if (type === MSG.WELCOME) {
        clearTimeout(timer);
        resolve();
        return;
      }
      if (type === MSG.SUGGEST_LIST) {
        const l = decodeSuggestionList(frame, MSG.SUGGEST_LIST);
        // A list can arrive unasked -- it is broadcast to every open panel when
        // a score moves -- so an arrival with nobody waiting is dropped rather
        // than resolving somebody else's request with it.
        if (waitingList) {
          const w = waitingList;
          waitingList = null;
          w(l);
        }
        return;
      }
      if (type === MSG.SUGGEST_ACK) {
        const a = decodeSuggestAck(frame, MSG.SUGGEST_ACK);
        if (waitingAck) {
          const w = waitingAck;
          waitingAck = null;
          w(a);
        }
        return;
      }
    };
  });

  const awaitList = (): Promise<SuggestionList | null> =>
    new Promise((resolve) => {
      waitingList = resolve;
      setTimeout(() => {
        if (waitingList === resolve) {
          waitingList = null;
          resolve(null);
        }
      }, 3000);
    });
  const awaitAck = (): Promise<{ result: number; issue: number; message: string } | null> =>
    new Promise((resolve) => {
      waitingAck = resolve;
      setTimeout(() => {
        if (waitingAck === resolve) {
          waitingAck = null;
          resolve(null);
        }
      }, 3000);
    });

  return {
    list() {
      const p = awaitList();
      socket.send(encodeSuggestList(MSG.SUGGEST, id));
      return p;
    },
    submit(title, body) {
      const p = awaitAck();
      socket.send(encodeSuggestSubmit(MSG.SUGGEST, id, title, body));
      return p;
    },
    vote(localId, dir) {
      const p = awaitAck();
      socket.send(encodeSuggestVote(MSG.SUGGEST, id, localId, dir));
      return p;
    },
    raw(frame) {
      socket.send(frame);
    },
    close() {
      socket.close();
    },
  };
}

// --- /unstuck --------------------------------------------------------------------

/**
 * The escape hatch, against the real lane graph and over a real `ChatHub`.
 *
 * The user's words were *"make it so i can kill my toon to move me if i am stuck
 * somewhere. just move to a random road within 200m"*. Every way that breaks is
 * silent in this file's usual sense -- the command answers, the player moves,
 * and something else is wrong:
 *
 *   1. **A destination that is not on a road** is the feature not existing. It
 *      still teleports you, it still says it worked, and the only symptom is
 *      that people stop using it because "it puts you in weird places".
 *   2. **A destination that is not validated** is the bug this command exists to
 *      escape, delivered by the command: out of one building footprint and into
 *      the next one along, or into the harbour. Restated here as a scan rather
 *      than by calling `isSpawnable` again, so the check and the rule cannot
 *      drift into agreeing about the wrong thing -- `checkAoi`'s `brute` makes
 *      the same argument.
 *   3. **A command that reaches the chat broadcast** publishes "/unstuck" to
 *      every socket on the host. That is not a crash and not a wrong position;
 *      it is the player looking like they typed a command at everyone.
 *   4. **A repeat guard that eats it.** `/unstuck` is by construction typed
 *      identically every time, so a command intercepted *after* `chatAdmit`
 *      would be refused as a repeat on the third use -- which is exactly the use
 *      somebody genuinely wedged in geometry is making. This is the single
 *      strongest reason the interception sits where it does, and it is the one
 *      that would never be found by hand.
 *   5. **A cooldown that does not hold** turns a rescue into a 200 m movement
 *      ability, which is the only way this feature could affect a fight.
 *   6. **A score that moved.** The whole point of the no-death reading is that
 *      the leaderboard is not polluted by terrain bugs; a `downs` that crept up
 *      would be invisible to everybody except the person it happened to.
 *
 * The awful start points in section 2 are not invented coordinates -- they are
 * *found*, by scanning the real world for ground that fails the spawn rule, so
 * they are inside real footprints and under real decks and in real water. A
 * check with hand-picked coordinates would go stale the next time the extent is
 * rebuilt; this one finds whatever the current build has.
 */
async function checkUnstuck(): Promise<void> {
  say('/unstuck — the escape hatch, its destination and its command surface');

  // --- 1. The arithmetic, which both processes refuse to boot without.
  {
    const f = verifyUnstuck();
    check(
      f.length === 0,
      `verifyUnstuck: the command surface, the validation, the ladder and the replies ` +
        `(${f.join('; ') || 'clean'})`,
    );
  }

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const probe = groundFor(world);

  /**
   * The validity rule, written out rather than imported. See the header.
   *
   * `y` is a feet height. The four questions are the four `isSpawnable` asks,
   * in the same order and against the same constants, and the point of writing
   * them again is that a change to one has to be made to both.
   */
  const standable = (x: number, z: number, y: number): string => {
    if (!Number.isFinite(y)) return 'the ground under it is not finite';
    const depth = waterDepth(world.water.surfaceAt(x, z), y);
    if (depth > SPAWN_MAX_DEPTH) return `it is under ${depth.toFixed(2)} m of water`;
    if (world.collision.resolve(x, z, x, z, SPAWN_PROBE_RADIUS, y + SPAWN_STEP_HEIGHT).hit) {
      return 'it is inside a collision prism';
    }
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const cx = x + ox * 1.2;
      const cz = z + oz * 1.2;
      if (world.collision.resolve(cx, cz, cx, cz, SPAWN_PROBE_RADIUS, y + SPAWN_STEP_HEIGHT).hit) {
        return 'it has less than 1.2 m of clearance beside it';
      }
    }
    return '';
  };

  /**
   * How far this point is from the nearest lane, recomputed from the spatial
   * index rather than taken from the answer.
   *
   * The perpendicular distance to every segment of every route within 30 m, so
   * an off-by-one in the polyline walk or a mis-signed origin offset shows up
   * as a destination floating beside the street rather than on it.
   */
  const routeScratch: LaneRoute[] = [];
  const gapToRoad = (x: number, z: number): number => {
    let best = Infinity;
    for (const r of world.traffic.near(x, z, 30, routeScratch)) {
      for (let i = 0; i + 1 < r.count; i++) {
        const ax = r.x[i];
        const az = r.z[i];
        const bx = r.x[i + 1];
        const bz = r.z[i + 1];
        const dx = bx - ax;
        const dz = bz - az;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
        best = Math.min(best, Math.hypot(x - (ax + dx * t), z - (az + dz * t)));
      }
    }
    return best;
  };

  // --- 2. The start points: a grid over the whole extent, plus the three awful
  // cases the user named. The awful ones are found rather than written down, so
  // they stay awful when the world is rebuilt.
  const starts: Array<{ x: number; z: number; what: string }> = [];
  {
    const size = world.index.tile_size;
    // The built extent, from the tiles themselves rather than from `radius_m`:
    // what matters is where there is ground, not what the pipeline aimed at.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const t of world.index.tiles) {
      minX = Math.min(minX, t.bounds[0]);
      maxX = Math.max(maxX, t.bounds[2]);
      // North-positive bounds into renderer z, which runs south. The same three
      // lines every other file here carries; see `spawn.spawnCentre`.
      minZ = Math.min(minZ, -t.bounds[3]);
      maxZ = Math.max(maxZ, -t.bounds[1]);
    }
    const keys = new Set(world.index.tiles.map((t) => t.key));
    const built = (x: number, z: number): boolean =>
      keys.has(`${Math.floor(x / size)}_${Math.floor(-z / size)}`);

    // A lattice across the whole built extent, so this is the 15.3 km world and
    // not the inner ring with a wider radius written on it.
    for (let x = minX; x <= maxX; x += 1200) {
      for (let z = minZ; z <= maxZ; z += 1200) {
        if (built(x, z)) starts.push({ x, z, what: 'grid' });
      }
    }

    // And the awful three, scanned for on a fine lattice over the inner city,
    // where the buildings, the viaducts and the water all are.
    let inPrism: { x: number; z: number } | null = null;
    let underDeck: { x: number; z: number } | null = null;
    let inWater: { x: number; z: number } | null = null;
    for (let x = -3000; x <= 2000 && !(inPrism && underDeck && inWater); x += 5) {
      for (let z = -3000; z <= 2000; z += 5) {
        if (!built(x, z)) continue;
        const ground = probe.groundHeight(x, z, -Infinity);
        if (!Number.isFinite(ground)) continue;
        const solid = world.collision.resolve(x, z, x, z, SPAWN_PROBE_RADIUS, ground + SPAWN_STEP_HEIGHT).hit;
        if (!inPrism && solid) inPrism = { x, z };
        // Something solid overhead with walkable ground underneath: a viaduct
        // soffit, the Cahill, a bridge approach. `!solid` is what distinguishes
        // it from a low warehouse -- inside a footprint you are in the prism,
        // under a deck you are not -- and the 3.5 m floor is `BODY_HEIGHT_M`'s
        // walk-under band, so this is a place a player can actually be.
        if (!underDeck && !solid) {
          const overhead = world.collision.roofHeight(x, z, ground + 25);
          if (Number.isFinite(overhead) && overhead > ground + 3.5) underDeck = { x, z };
        }
        if (!inWater && waterDepth(world.water.surfaceAt(x, z), ground) > 1.0) inWater = { x, z };
        if (inPrism && underDeck && inWater) break;
      }
    }
    if (inPrism) starts.push({ ...inPrism, what: 'inside a building footprint' });
    if (underDeck) starts.push({ ...underDeck, what: 'under a viaduct deck' });
    if (inWater) starts.push({ ...inWater, what: 'standing in the harbour' });
    check(
      inPrism !== null && underDeck !== null && inWater !== null,
      `found the three deliberately awful starts in the built world ` +
        `(footprint ${inPrism ? 'yes' : 'NO'}, viaduct ${underDeck ? 'yes' : 'NO'}, water ${inWater ? 'yes' : 'NO'})`,
    );
  }

  // --- 3. Many trials at every one of them. The claims, all at once, because a
  // per-trial `check` would be four thousand lines of report.
  {
    // A tiny LCG, so a failure here is reproducible rather than "sometimes".
    let seed = 20260807;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const TRIALS = 6;
    let trials = 0;
    let none = 0;
    let overRadius = 0;
    let offRoad = 0;
    let unstandable = 0;
    let firstRung = 0;
    let groundFallback = 0;
    let worstGap = 0;
    let worstDistance = 0;
    const complaints: string[] = [];
    const distinct = new Map<string, Set<string>>();

    for (const start of starts) {
      const spread = new Set<string>();
      for (let i = 0; i < TRIALS; i++) {
        trials++;
        const spot = unstuckDestination(
          start.x,
          start.z,
          (radius) => world.traffic.near(start.x, start.z, radius, routeScratch),
          probe,
          rand,
        );
        if (!spot) {
          none++;
          if (complaints.length < 4) complaints.push(`(${start.x}, ${start.z}) [${start.what}] produced nothing`);
          continue;
        }
        spread.add(`${Math.round(spot.x)},${Math.round(spot.z)}`);
        worstDistance = Math.max(worstDistance, spot.distance);

        if (spot.kind === 'road') {
          if (spot.radius === UNSTUCK_RADIUS_M) firstRung++;
          // Inside the rung it says it used, which for the first rung is the
          // 200 m the user asked for.
          if (spot.distance > spot.radius + 1e-6) {
            overRadius++;
            if (complaints.length < 4) {
              complaints.push(
                `(${start.x}, ${start.z}) [${start.what}] moved ${spot.distance.toFixed(1)} m on the ${spot.radius} m rung`,
              );
            }
          }
          const gap = gapToRoad(spot.x, spot.z);
          worstGap = Math.max(worstGap, gap);
          if (gap > 0.05) {
            offRoad++;
            if (complaints.length < 4) {
              complaints.push(`(${start.x}, ${start.z}) [${start.what}] landed ${gap.toFixed(2)} m off any lane`);
            }
          }
        } else {
          groundFallback++;
        }

        const verdict = standable(spot.x, spot.z, spot.y);
        if (verdict !== '') {
          unstandable++;
          if (complaints.length < 4) {
            complaints.push(`(${start.x}, ${start.z}) [${start.what}] landed somewhere ${verdict}`);
          }
        }
      }
      distinct.set(start.what + `@${start.x},${start.z}`, spread);
    }

    check(
      none === 0,
      `${trials} unstuck draws from ${starts.length} start points across the built extent all found somewhere to go ` +
        `(${none} failures)`,
    );
    check(
      overRadius === 0,
      `every destination was inside the radius its own answer reported ` +
        `(worst move ${worstDistance.toFixed(0)} m; ${overRadius} over)`,
    );
    check(
      offRoad === 0,
      `every road destination is on a lane, recomputed from the spatial index ` +
        `(worst gap ${worstGap === 0 ? '0.00' : worstGap.toFixed(3)} m; ${offRoad} off)`,
    );
    check(
      unstandable === 0,
      `every destination passes the spawn rule restated here -- finite ground, out of the prisms, ` +
        `1.2 m of clearance, above the wading floor (${unstandable} failures)`,
    );
    // The lattice deliberately includes the far edge of a 15.3 km extent --
    // bushland, national park, open water -- where there genuinely is no street
    // inside 200 m, so this is a floor rather than a target. What it catches is
    // a ladder that had started widening for no reason.
    check(
      firstRung >= trials * 0.8,
      `${firstRung} of ${trials} draws were answered by the ${UNSTUCK_RADIUS_M} m radius that was asked for; ` +
        `${trials - firstRung - groundFallback} needed a wider rung and ${groundFallback} fell back to open ground`,
    );

    // And in the city itself, the radius that was asked for must answer **every**
    // time. This is the claim the user actually made, tested where a player
    // actually gets stuck: six points across the inner city, sixty draws each.
    {
      const urban: ReadonlyArray<readonly [number, number]> = [
        [0, 0],
        [-500, 500],
        [500, -500],
        [-1000, 1000],
        [300, 800],
        [-2000, 2000],
      ];
      let missed = 0;
      for (const [x, z] of urban) {
        for (let i = 0; i < 60; i++) {
          const spot = unstuckDestination(
            x,
            z,
            (radius) => world.traffic.near(x, z, radius, routeScratch),
            probe,
            rand,
          );
          if (!spot || spot.kind !== 'road' || spot.radius !== UNSTUCK_RADIUS_M) missed++;
        }
      }
      check(
        missed === 0,
        `${urban.length * 60} draws from ${urban.length} inner-city points were all answered by a road inside ` +
          `${UNSTUCK_RADIUS_M} m (${missed} were not)`,
      );
    }

    // The join disc is the interesting counter-example and is worth naming: it
    // is the middle of Sydney Park, which has no drivable lane inside 200 m at
    // all. It is exactly the case the ladder exists for, and asserting that it
    // still lands on a road is what stops a future change quietly turning
    // "widen the search" into "give up".
    {
      let onRoad = 0;
      let widest = 0;
      for (let i = 0; i < 40; i++) {
        const spot = unstuckDestination(
          world.spawn.x,
          world.spawn.z,
          (radius) => world.traffic.near(world.spawn.x, world.spawn.z, radius, routeScratch),
          probe,
          rand,
        );
        if (spot && spot.kind === 'road') {
          onRoad++;
          widest = Math.max(widest, spot.radius);
        }
      }
      check(
        onRoad === 40,
        `the join disc is parkland with no lane inside ${UNSTUCK_RADIUS_M} m, and the ladder still put all ` +
          `${onRoad} of 40 draws on a road -- widening to ${widest} m and saying so in the reply`,
      );
    }
    if (complaints.length > 0) for (const c of complaints) say(`    ${c}`);

    // The pick is random rather than the same corner every time. Measured at the
    // starts that had a choice at all; a scan would give one point each.
    let varied = 0;
    let sampled = 0;
    for (const spread of distinct.values()) {
      if (spread.size === 0) continue;
      sampled++;
      if (spread.size > 1) varied++;
    }
    check(
      varied >= sampled * 0.8,
      `${varied} of ${sampled} start points sent ${TRIALS} consecutive draws to more than one place -- ` +
        `the destination is random rather than the first street in the tile`,
    );

    // The traffic preference. A route polyline is a driving lane, so "a random
    // road" is by construction a place cars go -- and the first live online
    // trial of this command put the player in front of one and took two pips off
    // them before they had finished reading the reply. The rule is
    // `UNSTUCK_CAR_CLEAR_M` and it is a preference rather than a veto, so both
    // halves are asserted: it works, and it never costs an answer.
    {
      const carRoutes: LaneRoute[] = [];
      const carPose = createCarPose();
      const tick = trafficTick(Date.now());
      const clearOfTraffic = (x: number, z: number, y: number): boolean => {
        let clear = true;
        forEachCarNear(world.traffic, x, z, UNSTUCK_CAR_CLEAR_M, tick, carRoutes, carPose, (car) => {
          if (car.y > y + 4 || car.y + car.height < y - 4) return;
          clear = false;
          return true;
        });
        return clear;
      };

      // The inner city, where the fleet actually is: an unstuck out on the
      // fringe is never near a car and would report a hundred per cent for the
      // wrong reason.
      const urban = starts.filter((s) => Math.hypot(s.x, s.z) < 4000);
      let withCars = 0;
      let lost = 0;
      let served = 0;
      for (const start of urban) {
        for (let i = 0; i < 4; i++) {
          const roads = (radius: number): readonly LaneRoute[] =>
            world.traffic.near(start.x, start.z, radius, routeScratch);
          const plain = unstuckDestination(start.x, start.z, roads, probe, rand);
          const avoided = unstuckDestination(start.x, start.z, roads, probe, rand, clearOfTraffic);
          if (plain && !avoided) lost++;
          if (!avoided) continue;
          served++;
          if (avoided.kind === 'road' && !clearOfTraffic(avoided.x, avoided.z, avoided.y)) withCars++;
        }
      }
      check(
        lost === 0,
        `the traffic preference never turned a findable destination into none ` +
          `(${served} served across ${urban.length} inner-city starts, ${lost} lost)`,
      );
      check(
        withCars <= served * 0.05,
        `${served - withCars} of ${served} destinations had no car inside ${UNSTUCK_CAR_CLEAR_M} m of them at ` +
          `the tick they were chosen -- the rest are streets where every lane had traffic on it, which is a ` +
          `road anyway`,
      );
    }

    // The awful three, called out by name, because "all 4,000 passed" hides
    // whether the interesting ones were among them.
    for (const start of starts.filter((s) => s.what !== 'grid')) {
      const spot = unstuckDestination(
        start.x,
        start.z,
        (radius) => world.traffic.near(start.x, start.z, radius, routeScratch),
        probe,
        rand,
      );
      check(
        spot !== null && standable(spot.x, spot.z, spot.y) === '',
        `a player ${start.what} at (${start.x}, ${start.z}) was moved ` +
          `${spot ? `${spot.distance.toFixed(0)} m to ${spot.kind === 'road' ? 'a road' : 'open ground'}` : 'nowhere'}`,
      );
    }
  }

  // --- 4. The command surface, over a real hub against a real two-room host.
  //
  // Not over a socket, and that is the same decision `checkFooty` and
  // `checkBikes` make: everything worth asserting here is *authority* and
  // *interception*, both of which live in this process. What a socket would add
  // is the wire, and `checkChat` already drives `CHAT_SAY` over one.
  {
    const host = new RoomHost(roomWorld(world), 2, 4, 0, 0);
    const hub = new ChatHub();
    const room = host.get(0)!;
    const other = host.get(1)!;

    const seat = (r: Room, name: string): { ws: FakeSocket; p: Participant } => {
      const conn = newConn(r.id);
      const ws = new FakeSocket(conn);
      const p = r.join(conn, 3, name)!;
      r.conns.add(ws as unknown as Socket);
      return { ws, p };
    };
    const stuck = seat(room, 'Wedged');
    const bystander = seat(room, 'Watcher');
    const elsewhere = seat(other, 'Faraway');

    const lines = (ws: FakeSocket, mark: number): ChatLine[] =>
      ws.since(mark, MSG.CHAT_LINE).map((f) => decodeChatLine(f)!).filter(Boolean);

    /** Type a line as this player, at this instant on the injected clock. */
    const type = (text: string, at: number): { moved: number; mine: ChatLine[]; theirs: ChatLine[] } => {
      const before = { x: stuck.p.combat.body.position.x, z: stuck.p.combat.body.position.z };
      const markMine = stuck.ws.frames.length;
      const markTheirs = bystander.ws.frames.length;
      const markFar = elsewhere.ws.frames.length;
      hub.say(host, stuck.ws as unknown as Socket, encodeChatSay(text), at);
      return {
        moved: Math.hypot(stuck.p.combat.body.position.x - before.x, stuck.p.combat.body.position.z - before.z),
        mine: lines(stuck.ws, markMine),
        theirs: [...lines(bystander.ws, markTheirs), ...lines(elsewhere.ws, markFar)],
      };
    };

    // Put them somewhere real, and remember the score.
    stuck.p.combat.body.position.set(world.spawn.x, probe.groundHeight(world.spawn.x, world.spawn.z, -Infinity) + EYE_HEIGHT, world.spawn.z);
    const kosBefore = stuck.p.kos;
    const downsBefore = stuck.p.downs;
    const healthBefore = (stuck.p.combat.health = 2);

    let clock = 1_000_000;

    // --- 4a. The command moves them, answers them privately, and reaches
    // nobody else. The third clause is the one this feature lives on.
    {
      const r = type('/unstuck', clock);
      check(r.moved > 1, `/unstuck moved the player ${r.moved.toFixed(0)} m`);
      check(
        r.theirs.length === 0,
        `and reached nobody else's chat log -- not the room, not the other room ` +
          `(${r.theirs.length} line(s) leaked${r.theirs.length ? `: ${JSON.stringify(r.theirs[0].text)}` : ''})`,
      );
      check(
        r.mine.length === 1 && (r.mine[0].flags & CHAT_FLAG.PRIVATE) !== 0 && (r.mine[0].flags & CHAT_FLAG.SYSTEM) !== 0,
        `the sender got exactly one private system line back (${JSON.stringify(r.mine[0]?.text ?? '')})`,
      );
      check(
        r.mine[0]?.text.includes('no death') === true,
        'and it says that no death was recorded, so the rule is discoverable rather than a comment',
      );
      check(
        stuck.p.kos === kosBefore && stuck.p.downs === downsBefore,
        `no knockout was credited and no down was counted (${stuck.p.kos} KOs, ${stuck.p.downs} downs, unchanged)`,
      );
      check(
        stuck.p.combat.health === healthBefore,
        `and it is not a heal either -- health is still ${stuck.p.combat.health} of ${MAX_HEALTH}, ` +
          'which is what stops a ten-second cooldown deciding a fight',
      );
      check(
        stuck.p.combat.body.velocity.lengthSq() === 0 && stuck.p.combat.body.onGround,
        'the player arrives stationary and on the ground rather than carrying whatever fall they were in',
      );
    }

    // --- 4b. The cooldown, told with the time remaining.
    {
      const r = type('/unstuck', clock + 2000);
      check(r.moved === 0, `a second /unstuck two seconds later did not move them (${r.moved.toFixed(2)} m)`);
      check(
        r.mine.length === 1 && r.mine[0].text.includes('s to go'),
        `and said how long was left (${JSON.stringify(r.mine[0]?.text ?? '')})`,
      );
      check(r.theirs.length === 0, 'and still reached nobody else');
    }

    // --- 4c. THE REPEAT GUARD. Three identical commands in a row, each a full
    // cooldown apart. `chatAdmit` refuses a third identical *sentence*; a
    // command intercepted before it must not be refused at all.
    {
      let served = 0;
      for (let i = 0; i < 4; i++) {
        clock += UNSTUCK_COOLDOWN_MS + 500;
        if (type('/unstuck', clock).moved > 1) served++;
      }
      check(
        served === 4,
        `four identical /unstuck commands in a row were all served (${served} of 4) -- the repeat guard ` +
          `refuses a third identical sentence, and a command is not a sentence`,
      );
    }

    // --- 4d. The aliases, and the thing that is not one.
    {
      for (const alias of ['/kill', '/stuck', '/UNSTUCK', '  /Kill  ']) {
        clock += UNSTUCK_COOLDOWN_MS + 500;
        const r = type(alias, clock);
        check(
          r.moved > 1 && r.theirs.length === 0,
          `${JSON.stringify(alias)} moved the player ${r.moved.toFixed(0)} m and was not broadcast`,
        );
      }
      clock += UNSTUCK_COOLDOWN_MS + 500;
      const sentence = type('/kill bazza', clock);
      check(
        sentence.moved === 0 && sentence.theirs.length === 2,
        `"/kill bazza" is a sentence: nobody was teleported and it reached ${sentence.theirs.length} other ` +
          `client(s), including the one in the other room`,
      );
      check(
        !unstuckCommand('/killer') && !unstuckCommand('unstuck'),
        'and the match is exact rather than a prefix, so a sentence starting with a command is still a sentence',
      );
    }

    // --- 4e. Knocked out is refused. The respawn is already about to move them,
    // and a player who can teleport out of a knockout can teleport out of a
    // fight.
    {
      clock += UNSTUCK_COOLDOWN_MS + 500;
      stuck.p.combat.phase = 'ko';
      const r = type('/unstuck', clock);
      check(r.moved === 0, `a knocked-out player was not moved (${r.moved.toFixed(2)} m)`);
      check(
        r.mine.length === 1 && r.mine[0].text.includes('knocked out'),
        `and was told why (${JSON.stringify(r.mine[0]?.text ?? '')})`,
      );
      check(r.theirs.length === 0, 'and it was still not broadcast');
      stuck.p.combat.phase = 'idle';
    }

    // --- 4f. The counters, which is how a deployment would see this at all.
    check(
      hub.unstuckServed >= 9 && hub.unstuckRefused >= 2,
      `the hub counted ${hub.unstuckServed} served and ${hub.unstuckRefused} refused`,
    );

    // --- 4g. And ordinary chat still works, which is the regression this whole
    // interception could quietly cause.
    {
      const markTheirs = bystander.ws.frames.length;
      hub.say(host, stuck.ws as unknown as Socket, encodeChatSay('oi mate'), clock + 60_000);
      const heard = lines(bystander.ws, markTheirs);
      check(
        heard.length === 1 && heard[0].text === 'oi mate' && heard[0].flags === 0,
        `an ordinary sentence still reaches the room unchanged (${JSON.stringify(heard[0]?.text ?? '')})`,
      );
    }
  }

  // --- 5. The ladder's own shape, asserted rather than assumed: it starts at
  // what was asked for and only ever widens. A ladder that started wide would
  // move somebody 900 m when a street was 40 m away.
  check(
    UNSTUCK_LADDER[0] === UNSTUCK_RADIUS_M &&
      UNSTUCK_LADDER.every((r, i) => i === 0 || r > UNSTUCK_LADDER[i - 1]),
    `the search ladder is ${UNSTUCK_LADDER.join(' → ')} m -- it starts at the ${UNSTUCK_RADIUS_M} m that was ` +
      `asked for and only widens`,
  );
}

// --- 25. The input queue -------------------------------------------------------

/**
 * *One frame, one step* -- the contract that makes client prediction exact, and
 * the one this server spent its life quietly breaking.
 *
 * ---------------------------------------------------------------------------
 * ## What was wrong
 *
 * A client runs a fixed 60 Hz simulation step off a `requestAnimationFrame`
 * accumulator, predicts its own body with `controller.step`, and sends one input
 * frame per step. The server runs its own 60 Hz tick and, until this check
 * existed, kept **one** input slot per socket with last-write-wins. Two frames
 * that shared a tick -- which is what a browser at 30 fps produces on *every*
 * frame, what one at 120 produces whenever the accumulator's phase drifts, and
 * what one at exactly 60 produces every few seconds anyway -- meant the older
 * frame was destroyed. The tick after it, having nothing, re-applied the frame
 * before.
 *
 * Neither half is visible in the server's own numbers: the tick is on time, the
 * snapshot goes out, `/stats` is green. What the *client* sees is a snapshot
 * that acknowledges an input the server never stepped, so the reconciler drops
 * it from the replay history and lands on a position one whole simulation step
 * of movement behind the one it predicted. At the sprint that is 13.7 cm, on the
 * camera, at up to twenty times a second.
 *
 * Measured against the real reconciler over a real socket before the fix:
 *
 * | client frame rate | frames destroyed | ticks re-applied | median divergence |
 * |---|---|---|---|
 * | 30 fps  | 9.75/s | 9.83/s | **0.137 m** |
 * | 45 fps  | 4.08/s | 4.08/s | 0.002 m |
 * | 50 fps  | 3.83/s | 3.83/s | 0.002 m |
 * | 60 fps  | 0.50/s | 0.50/s | 0.001 m |
 * | 120 fps | 5.17/s | 5.25/s | **0.136 m** |
 *
 * and after it, 0.00-0.08/s destroyed at every one of those rates.
 *
 * ---------------------------------------------------------------------------
 * ## What this check asserts, and why in this shape
 *
 * The claim is a **counting** claim -- the server takes exactly the steps the
 * client took, no more and no fewer -- so it is asserted by counting rather than
 * by measuring a distance and hoping the number means something. Sections 1-3
 * drive a real `Room` with a real world and a delivery schedule chosen to be a
 * browser's, and read the acknowledgement sequence back: a gap in it is a
 * destroyed frame, a stall in it is a phantom step.
 *
 * Section 4 then closes the loop the only way that proves the *consequence*: it
 * runs the genuine `net/client.ts` reconciler, with its genuine input history
 * and its genuine replay, against a genuine `Room`, for 30 simulated seconds of
 * sprinting, and asserts the divergence never leaves the reconciler's own
 * deadzone and that it never snaps. Every part of that is the shipping code; the
 * only thing this file supplies is the wire between them.
 *
 * The bound is **derived, not tuned**. `CORRECTION_DEADZONE` is the reconciler's
 * own statement of what is not worth correcting, and one step of sprint movement
 * is measured here by asking `controller.step` for it. Section 0 asserts the
 * second is far larger than the first, which is the whole reason the counting
 * claim matters: a single lost frame *cannot* hide inside the deadzone.
 */
async function checkInputQueue(): Promise<void> {
  say('the input queue: one frame, one step (the 60 Hz camera jitter)');

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const FIXED_DT = 1 / TICK_HZ;

  // --- 0. What one lost frame costs, out of the controller rather than out of a
  // table. A body on flat ground, sprinting, for exactly one step.
  const ruler = createPlayerState(0, 0);
  ruler.position.y = EYE_HEIGHT;
  step(
    ruler,
    { forward: 1, right: 0, jump: false, sprint: true, yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1 },
    FIXED_DT,
    null,
    () => 0,
  );
  // Two steps in, so the ramp-up is past and this is the steady stride.
  const before = ruler.position.z;
  for (let i = 0; i < 30; i++) {
    step(
      ruler,
      { forward: 1, right: 0, jump: false, sprint: true, yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1 },
      FIXED_DT,
      null,
      () => 0,
    );
  }
  const oneStep = Math.abs(ruler.position.z - before) / 30;
  check(
    oneStep > CORRECTION_DEADZONE * 4,
    `one lost input frame is ${oneStep.toFixed(4)} m of sprint movement, which is ` +
      `${(oneStep / CORRECTION_DEADZONE).toFixed(1)}x the reconciler's ${CORRECTION_DEADZONE} m deadzone -- ` +
      `so a frame the server drops cannot hide, it can only appear on the camera`,
  );

  /**
   * Drive one socket through a room on a browser's delivery schedule.
   *
   * `schedule[t]` is how many input frames land in the tick at index `t`. The
   * patterns below are what the three common displays actually produce: a 30 Hz
   * display runs two accumulator steps in one frame and posts both inside a
   * millisecond, a 120 Hz display runs one every other frame, and a 60 Hz
   * display runs one per frame with a phase that walks across the tick boundary
   * every few seconds.
   */
  const drive = (name: string, ticks: number, framesAt: (t: number) => number): {
    sent: number; applied: number[]; overflow: number; starved: number;
  } => {
    const room = new Room(0, world, 8, 0);
    const ws = new FakeSocket(newConn(0));
    const p = room.join(ws.data, 0, `queue-${name}`)!;
    room.conns.add(ws as unknown as Socket);
    const frame = { seq: 0, buttons: BTN.SPRINT, forward: 1, right: 0, yaw: 0, pitch: 0 };
    const applied: number[] = [];
    let sent = 0;
    let lastAck = -1;
    for (let t = 0; t < ticks; t++) {
      const n = framesAt(t);
      for (let i = 0; i < n; i++) {
        frame.seq = (frame.seq + 1) & 0xffff;
        sent++;
        receiveInput(ws.data, encodeInput(frame));
      }
      room.step();
      if (p.ackSeq !== lastAck) {
        applied.push(p.ackSeq);
        lastAck = p.ackSeq;
      }
    }
    return { sent, applied, overflow: ws.data.inputOverflow, starved: ws.data.inputStarved };
  };

  // --- 1. 30 fps: two frames per browser frame, both inside one tick. The worst
  // case for last-write-wins, and the one that destroyed half of everything.
  {
    const ticks = 600;
    const r = drive('30fps', ticks, (t) => (t % 2 === 0 ? 2 : 0));
    const gaps = r.applied.filter((seq, i) => i > 0 && seq !== r.applied[i - 1] + 1).length;
    check(
      gaps === 0,
      `30 fps -- two frames delivered in one tick, ${ticks / 2} times: the server applied all ` +
        `${r.applied.length} of them in order, with ${gaps} gap(s) in the acknowledgement sequence`,
    );
    check(
      r.overflow === 0 && r.starved <= INPUT_RESERVE,
      `and threw none away (${r.overflow} overflow) and re-applied a stale frame ${r.starved} time(s), ` +
        `which is the ${INPUT_RESERVE}-frame reserve being banked at join and nothing else`,
    );
  }

  // --- 2. 120 fps: one frame every other tick's worth of wall clock, which is
  // the same rate with the opposite phase problem.
  {
    const ticks = 600;
    const r = drive('120fps', ticks, (t) => (t % 3 === 2 ? 2 : t % 3 === 0 ? 1 : 0));
    const gaps = r.applied.filter((seq, i) => i > 0 && seq !== r.applied[i - 1] + 1).length;
    check(
      gaps === 0 && r.overflow === 0,
      `120 fps -- a 1,0,2 arrival pattern: all ${r.applied.length} frames applied in order, ` +
        `${gaps} gap(s), ${r.overflow} thrown away`,
    );
  }

  // --- 3. 60 fps with the phase walking across the tick boundary: one frame per
  // tick, except every 97th tick gets two and the next gets none. This is what a
  // display that is nominally at the tick rate does over a minute, and it is why
  // even a perfect client saw this bug.
  {
    const ticks = 900;
    const r = drive('60fps-drift', ticks, (t) => (t % 97 === 0 ? 2 : t % 97 === 1 ? 0 : 1));
    const gaps = r.applied.filter((seq, i) => i > 0 && seq !== r.applied[i - 1] + 1).length;
    check(
      gaps === 0 && r.starved <= INPUT_RESERVE,
      `60 fps with a drifting phase -- ${ticks} ticks, ${Math.floor(ticks / 97)} boundary crossings: ` +
        `${gaps} gap(s) and ${r.starved} phantom step(s). The reserve absorbs the crossing outright`,
    );
  }

  // --- 4. The consequence, through the real reconciler.
  //
  // A headless client that sprints for thirty seconds, running `net/client.ts`'s
  // own prediction, its own input history and its own replay against a real
  // `Room` -- with the frames delivered on the 30 fps schedule, which before the
  // fix was a 13.7 cm correction on the *median* snapshot.
  //
  // The wire is a loopback rather than a socket so the run is deterministic:
  // every tick happens in a fixed order with no clock, no scheduler and no
  // network, which is what makes a failure here a real regression rather than a
  // flaky afternoon. What travels over it is the genuine protocol in both
  // directions.
  {
    const room = new Room(0, world, 8, 0);
    const combatWorld = groundFor(world);
    const toServer: ArrayBuffer[] = [];
    let ws: FakeSocket | null = null;
    let joined: Participant | null = null;

    const transport: NetTransport = {
      open: true,
      onframe: null,
      onopen: null,
      onclose: null,
      send(f: ArrayBuffer): void {
        toServer.push(f);
      },
      close(): void {},
    };
    const net = new NetClient('', {
      onHit: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
      onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
    }, { name: 'reconcile-probe', transport });

    /** The three client messages this room's own socket reader handles. */
    const pump = (): void => {
      for (const f of toServer.splice(0)) {
        if (frameType(f) === MSG.HELLO && !joined) {
          ws = new FakeSocket(newConn(0));
          joined = room.join(ws.data, 0, 'reconcile-probe');
          if (joined) {
            room.conns.add(ws as unknown as Socket);
            room.welcome(ws as unknown as Socket, joined);
          }
        } else if (frameType(f) === MSG.INPUT && ws) {
          receiveInput(ws.data, f);
        }
      }
    };
    /** And everything the room said back. */
    const drain = (): void => {
      if (!ws) return;
      for (const f of ws.frames.splice(0)) transport.onframe?.(f);
    };

    transport.onopen?.();
    pump();
    drain();
    check(net.status === 'online' && joined !== null, `the headless client joined the room (id ${net.id})`);

    // Both bodies pinned to the same known coordinate, and the route kept to a
    // circle two metres across.
    //
    // Not for tidiness: `Simulation.joinSpot` dithers every join over a 100 m
    // disc, so an unpinned probe runs a different 250 m of Sydney every time
    // this file is run -- and out there are kerbs, ponds, fences and a crowd,
    // every one of which moves a body for a reason the *client* cannot predict
    // and none of which is what this section is asking about. A run that
    // wandered into a pedestrian would fail this check and mean nothing by it.
    // The disc centre is the one coordinate both ends derive from `index.json`
    // and the rest of this file already treats as standable ground.
    const w = net.welcome!;
    const spawnY = eyeAt(combatWorld, world.spawn.x, world.spawn.z);
    joined!.combat.body.position.set(world.spawn.x, spawnY, world.spawn.z);
    joined!.combat.body.velocity.set(0, 0, 0);
    joined!.history.seed(room.sim.tick, world.spawn.x, spawnY, world.spawn.z, 0);
    const playerCombat = createCombatant(0, world.spawn.x, world.spawn.z);
    playerCombat.body.position.set(world.spawn.x, spawnY, world.spawn.z);
    playerCombat.body.yaw = w.yaw;
    const correction = playerCombat.body.velocity.clone();
    const input = {
      forward: 1, right: 0, jump: false, sprint: true,
      yaw: w.yaw, pitch: 0, speedScale: 1, jumpScale: 1,
      punch: false, throwBall: false, mount: false,
    };
    // 4 rad/s against 8.2 m/s is a two-metre circle, which keeps the probe on
    // the square of ground that was pinned above for the whole thirty seconds.
    const TURN = 4;

    // Thirty seconds of sprinting, with the mouse turning throughout -- a
    // straight line with a frozen yaw is the one path on which a dropped frame
    // and a repeated frame produce the same trajectory, and would be the one
    // schedule that hid this bug.
    const TICKS = TICK_HZ * 30;
    // A second of running before anything is judged. The first quarter-second
    // from a standing start is the one window where `reconcile` is knowingly
    // approximate -- velocity is not on the wire, so the replay seeds the
    // authoritative position with the *current* local velocity, which during an
    // acceleration ramp is faster than the body actually had there. It settles
    // to 0.4 mm once the stride is steady, and it is a different question from
    // the one this check is asking. Measured: 5-15 cm for about twelve ticks.
    const SETTLE = TICK_HZ;
    let worst = 0;
    let corrected = 0;
    let path = 0;
    let px = world.spawn.x;
    let pz = world.spawn.z;
    for (let t = 0; t < TICKS; t++) {
      net.reconcile(playerCombat, combatWorld, correction);
      if (t >= SETTLE && net.lastCorrection > worst) worst = net.lastCorrection;
      input.yaw += TURN * FIXED_DT;
      advance(playerCombat, input, FIXED_DT, combatWorld);
      net.sendInput(input);
      // The 30 fps schedule: the browser posts this tick's frame and the last
      // one together, every other tick.
      if (t % 2 === 1) pump();
      room.step();
      drain();
      net.update(FIXED_DT);
      if (t === SETTLE) corrected = net.corrections;
      path += Math.hypot(playerCombat.body.position.x - px, playerCombat.body.position.z - pz);
      px = playerCombat.body.position.x;
      pz = playerCombat.body.position.z;
    }
    corrected = net.corrections - corrected;

    check(
      path > 200 && ws!.data.inputOverflow === 0,
      `the probe ran ${path.toFixed(0)} m of ground over ${TICKS} ticks, turning the whole way, and ` +
        `the room threw away ${ws!.data.inputOverflow} of its ${TICKS} input frames`,
    );
    check(
      ws!.data.inputStarved <= INPUT_RESERVE,
      `and re-applied a stale frame ${ws!.data.inputStarved} time(s) in thirty seconds -- the reserve ` +
        `being banked at join, and nothing after it`,
    );
    check(
      worst <= CORRECTION_DEADZONE,
      `once the stride was steady the predicted body never left the reconciler's own ` +
        `${CORRECTION_DEADZONE} m deadzone -- worst divergence ${worst.toFixed(4)} m over 29 s, against ` +
        `the ${oneStep.toFixed(4)} m a single lost frame costs`,
    );
    check(
      net.snaps === 0,
      `and the reconciler snapped ${net.snaps} time(s). Zero, and it has to be zero: ` +
        `${CORRECTION_SNAP} m is a knockback, and nobody punched this probe`,
    );
    check(
      corrected === 0,
      `and the reconciler applied ${corrected} eased correction(s) in those 29 s -- the deadzone was ` +
        `never reached, so the camera was never told about anything`,
    );
    say(
      `  the same run before the fix: 0.137 m on the median snapshot, ~20 corrections a second, ` +
        `every one of them a visible step of the camera`,
    );
  }
}
