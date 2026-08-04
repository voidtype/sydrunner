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
import { WADE_MAX_DEPTH, WaterLevels, waterDepth } from '../client/src/world/wading.ts';
import { groundFor, loadWorld } from './world.ts';
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
import { applyCarHit } from '../client/src/game/traffic.ts';
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
  readonly balls = new Map<number, { thrower: number; first: [number, number, number]; last: [number, number, number]; path: number; bounces: number; samples: number }>();

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
                });
              } else {
                seen.path += Math.hypot(b.x - seen.last[0], b.y - seen.last[1], b.z - seen.last[2]);
                seen.last = [b.x, b.y, b.z];
                seen.bounces = Math.max(seen.bounces, b.bounces);
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
    const fell = ballsAtA.filter((x) => x.last[1] < x.first[1]);
    check(
      fell.length > 0,
      `at least one ball ended lower than it started, so gravity is on the wire ` +
        `(${fell.length} of ${ballsAtA.length})`,
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
  const koEvents = a.hits.filter((h) => h.ko);
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
  check(
    scored === koEvents.length && downs === koEvents.length,
    `the board's ${scored} KOs and ${downs} downs match the ${koEvents.length} KO events A saw`,
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

  // --- 9. Protocol 7, and the refusal behaviour a version bump exists for.
  check(PROTOCOL_VERSION === 7, `the protocol is at version ${PROTOCOL_VERSION}`);
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
    let firstBad = -1;
    outer: for (let tick = 0; tick < 10000; tick += 7) {
      const now = one.trafficSeconds(tick);
      const alsoNow = two.trafficSeconds(tick);
      if (now !== alsoNow) {
        firstBad = tick;
        break;
      }
      for (const route of sample) {
        for (let slot = -1; slot <= 2; slot++) {
          const liveA = one.poseCar(route, slot, now, a);
          const liveB = two.poseCar(route, slot, now, b);
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
            a.body !== b.body || a.colour !== b.colour || a.scale !== b.scale
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
        `(${compared.toLocaleString()} lookups, ${live.toLocaleString()} live cars)` +
        (firstBad >= 0 ? ` -- first divergence at tick ${firstBad}` : ''),
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
    let lowest = Infinity;
    let highest = -Infinity;
    const tick = one.trafficTick(Date.now());
    const now = one.trafficSeconds(tick);
    for (const route of routes) {
      for (let slot = Math.floor((now - route.phase - route.duration) / route.headway) + 1;
           slot <= Math.floor((now - route.phase) / route.headway); slot++) {
        if (!one.poseCar(route, slot, now, pose)) continue;
        cars++;
        if (pose.y < lowest) lowest = pose.y;
        if (pose.y > highest) highest = pose.y;
      }
    }
    check(cars > 1000, `${cars.toLocaleString()} cars are on the road across the whole extent right now`);
    // The datum puts sea level at y = -71.075, so this band is roughly -2 m to
    // +111 m AHD. Loose on purpose at the top -- Bellevue Hill's streets reach
    // 97 m and are inside this extent -- and tight where it matters: a lane
    // whose height lookup missed is on the harbour bed at -74, or over it on a
    // deck that solved to nothing. Both are the failure this catches, and both
    // render as a car driving through the water off Dawes Point.
    check(
      lowest > -73 && highest < 40,
      `every one of them is between y ${lowest.toFixed(1)} and ${highest.toFixed(1)}, ` +
        'which is inside the extent\'s ground range',
    );
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
      const victim = createCombatant(9, 0, 0);
      victim.body.position.set(pose.x, pose.y + EYE_HEIGHT, pose.z);
      const car = one.carHitting(world.traffic, victim, tick, scratch, one.createCarPose());
      if (car === null) continue;
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
    let offMap = 0;
    let bandless = 0;
    const scratch: Parameters<typeof one.forEachPoliceNear>[5] = [];
    for (const station of one.POLICE_STATIONS) {
      const key = `${Math.floor(station.x / size)}_${Math.floor(-station.z / size)}`;
      if (!keys.has(key)) offMap++;
      if (world.peds.near(station.x, station.z, one.catchment(station), scratch).length === 0) bandless++;
    }
    check(offMap === 0, `all ${one.POLICE_STATIONS.length} police stations are on a built tile (${offMap} were not)`);
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
  const scene = findScene(trafficTick(Date.now()));
  if (!scene) {
    check(false, 'a bystander in view of an officer on a beat could be found somewhere in the city');
    return;
  }
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

    suspect.input.punch = true;
    // The button is released after the first tick, because a held punch would
    // empty the stamina bar -- which is spec 8.2's behaviour and not what this
    // is measuring.
    let tracked = 0;
    for (let i = 0; i < 24; i++) {
      if (follow()) tracked++;
      sim.step(out);
      suspect.input.punch = false;
    }
    check(tracked > 0, `the bystander stayed findable for ${tracked} of 24 ticks while the swing came round`);
    const wanted = sim.investigations();
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

  // --- 6. Officers are promoted onto the suspect, and they come from the beat.
  {
    for (let i = 0; i < 60; i++) sim.step(out);
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
    for (let i = 0; i < 60; i++) sim.step(out);
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
    let health = suspect.combat.health;
    while (lost === 0 && ticks < 60 * 25) {
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
    let left = 0;
    for (let i = 0; i < 60 * 20; i++) {
      sim.step(out);
      left = sim.npcSnapshot().length;
      if (left === 0) break;
    }
    check(left === 0, `every pursuing officer stood down and despawned (${left} still promoted)`);
    check(
      sim.factions.actors.length === 0,
      'and the field is empty, so the wire cost of a finished pursuit is zero',
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
      const names: string[] = [];
      for (const station of one.POLICE_STATIONS) {
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
        `all ${one.POLICE_STATIONS.length} stations put officers on a real footpath` +
          (silent ? ` -- ${names.join(', ')} posed nobody` : ''),
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
    const scratch: PedBand[] = [];
    let subOff = 0;
    let subBandless = 0;
    for (const s of st.SUBURBS) {
      if (st.methLoiterers(s) === 0) continue;
      if (!keys.has(`${Math.floor(s.x / size)}_${Math.floor(-s.z / size)}`)) subOff++;
      if (world.peds.near(s.x, s.z, st.methSpread(s), scratch).length === 0) subBandless++;
    }
    const populated = st.SUBURBS.filter((s) => st.methLoiterers(s) > 0).length;
    check(subOff === 0, `all ${populated} suburbs that carry meth heads are on a built tile (${subOff} were not)`);
    check(subBandless === 0, `every one of them has footpaths to loiter on (${subBandless} had none)`);

    let venueOff = 0;
    let venueBandless = 0;
    let withDrunks = 0;
    let drunkTotal = 0;
    for (let v = 0; v < st.VENUE_COUNT; v++) {
      const n = st.venueDrunks(v);
      if (n === 0) continue;
      withDrunks++;
      drunkTotal += n;
      const x = st.VENUE_XZ[v * 2];
      const z = st.VENUE_XZ[v * 2 + 1];
      if (!keys.has(`${Math.floor(x / size)}_${Math.floor(-z / size)}`)) venueOff++;
      if (world.peds.near(x, z, 45, scratch).length === 0) venueBandless++;
    }
    check(venueOff === 0, `all ${withDrunks} pubs that carry a drunk are on a built tile (${venueOff} were not)`);
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
    {
      let total = 0;
      for (const s of st.SUBURBS) total += st.methLoiterers(s);
      check(
        total > 100 && total < 160,
        `the city carries ${total} meth heads across ${st.SUBURBS.length} suburbs -- it carried 114 across ` +
          '57 before the inner south was filled in, and this is a coverage fix rather than a population one',
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
      const missing: string[] = [];
      for (let s = 0; s < st.SUBURBS.length; s++) {
        const suburb = st.SUBURBS[s];
        const want = st.methLoiterers(suburb);
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
          (missing.length ? ` -- ${missing.slice(0, 4).join(', ')}` : ''),
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
    let offMap = 0;
    let noTerrain = 0;
    for (const park of one.PARKS) {
      const key = `${Math.floor(park.x / size)}_${Math.floor(-park.z / size)}`;
      if (!keys.has(key)) offMap++;
      if (!Number.isFinite(world.terrain.height(park.x, park.z))) noTerrain++;
    }
    check(offMap === 0, `all ${one.PARKS.length} baked parks are on a built tile (${offMap} were not)`);
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
          } else if (!isDiving) {
            diving.delete(a.id);
          }
          if (isDiving) dived = true;
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
        most > 0 && most <= 3,
        `the busiest magpie swooped ${most} time(s) before perching -- the brief's two to three, then a stare`,
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
  for (let i = 0; i < 60 * 13; i++) {
    applyButtons(me.input, 0);
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
