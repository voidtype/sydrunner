/**
 * Three browsers, one building: who can see whom, and on which floor.
 *
 *     bun run server/interior-share-check.ts
 *     bun run server/interior-share-check.ts --verbose
 *
 * The report this exists to answer is one sentence long — *"going into a
 * building needs to be shared and persistent"* — and the honest first job of a
 * driver against a sentence like that is to find out how much of it is already
 * true. `server/integration-check.ts`'s `checkInteriors` asserts the *server's*
 * half over the real bake: two participants handed one `Interior`, a bystander
 * excluded from the working set by `aoi.InterestIndex`, a `lastPos` that names
 * the building. What none of it asks is the question a player actually asks,
 * which is about a **browser**: after the frames have crossed a socket and been
 * decoded, does the client standing in the pub have a record of the other
 * drinker, at the right place, on the right floor — and does the one on the
 * pavement have neither?
 *
 * So this is the whole loop and not the simulation: a real `Room` over a real
 * `Simulation`, three real `NetClient`s over three loopback transports, real
 * `WELCOME`/`SPACE`/`PLACED`/`INTEREST`/`SNAPSHOT` frames, and the three
 * bodies driven only through the interfaces the browser and the websocket
 * handler actually use (`Room.doorPress`, `Room.furnish`, `receiveInput`).
 *
 * ---------------------------------------------------------------------------
 * THE FIXTURE IS AN EMPTY CITY WITH ONE BUILDING IN IT.
 *
 * `server/accounts-check.ts`'s argument, and it holds harder here: this check
 * runs in about a second because it never loads Sydney. What an interior needs
 * from a world is a prism with a footprint and a height, and everything the
 * generator does with it — the hull, the plan, the core, the levels — is pure
 * arithmetic over those numbers. A 26 m by 20 m block 25 m tall is eight
 * storeys with a lift in it, which is the shape that makes the floor question
 * askable at all: two people in one building on two different floors are in
 * the same space and eighteen metres apart vertically.
 *
 * The real bake's buildings are `checkInteriors`' subject and stay there. A
 * fixture is the right instrument for a question about *the wire*, because a
 * fixture can be made to have eight floors on purpose.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHAT IT FOUND.
 *
 * Run against `main` before anything on this branch was written, the score was
 * **25 of 28**, and the three that failed were not the three anyone expected:
 *
 *   1. **Occupancy.** Two clients through one door already see each other, at
 *      the right place. The space is not on the wire at all and does not need
 *      to be -- `server/aoi.ts` filters by it before it measures a distance, so
 *      everybody in a snapshot is in the sender's building by construction.
 *      Green on main, and still green.
 *   2. **The pavement.** A third client a metre and a half outside the door
 *      sees neither of them and is seen by neither. The property no radius
 *      could ever produce. Green on main.
 *   3. **The floor. FAILED.** One of the two goes up to level 2 and the other's
 *      browser kept drawing them -- *"still draws Shazza, 6.2 m up through the
 *      ceiling"* -- because every radius in the AOI is horizontal and the space
 *      names all eight storeys at once. Fixed by making the interest key the
 *      **room**: `net/spaces.occupancyOf`, the space with the floor folded in.
 *   4. **Leaving.** One walks out; the other's browser drops them in two ticks,
 *      which is inside a snapshot. Green on main. What was *not* green is the
 *      leaver's own view: it kept the pub's drinkers until the next `INTEREST`
 *      delta, drawing them standing on the pavement. `MSG.SPACE` now forgets
 *      them on the frame that says the room is gone, as it already forgot the
 *      couches.
 *   4b. **A punch.** Between two people in one room it lands; across the wall
 *      to somebody on the same metre outside it does not. Green on main and
 *      untouched here -- the melee candidates are filtered by `space` one layer
 *      under the working set, and deliberately not by storey. A swing reaches
 *      about two metres and a storey is 3.1, so the body's own 3D distance
 *      already refuses the punch through a ceiling, and it refuses it
 *      *correctly* on a staircase where two people a step apart read as being
 *      on different floors.
 *   5. **Furniture.** A couch placed by one is in the other's `PLACED` list.
 *      Green on main; `server/interiors.ts` is untouched by this branch and is
 *      asked anyway, because a check that claimed the room was shared without
 *      asking would be taking the one shared thing it already had on trust.
 *   6. **Persistence. FAILED.** A disconnect on level 2 and a rejoin landed on
 *      **level 7**, the top of the shaft. Two independent bugs, both invisible
 *      from inside the building: `Simulation.carryOf` saved `interior.base`
 *      rather than the storey's floor, and `join` handed `restoreInterior` the
 *      body's *current* height -- which `eyeAt` had just set to the city's
 *      ground at those coordinates, and the coordinates are inside a footprint,
 *      so it was the height of the roof. INTERIORS.md has said the save
 *      remembers the level since v29; it did not.
 *
 * Every one of those prints a counter, because a check whose subject never
 * happened passes perfectly: `0 remotes` is what "the snapshot never arrived"
 * looks like from here, and it is indistinguishable from "the filter works"
 * unless the positive case is asserted beside it. Every section here asserts
 * both.
 *
 * Exit code 1 on any failure.
 */

import { CollisionWorld } from '../client/src/player/collision.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { NetClient } from '../client/src/net/client.ts';
import {
  FURNISH_OP,
  MSG,
  TICK_HZ,
  frameType,
  type NetTransport,
} from '../client/src/net/protocol.ts';
import { MAX_HEALTH, createCombatant, type CombatInput } from '../client/src/game/combat.ts';
import { CITY_SPACE } from '../client/src/net/spaces.ts';
import { levelIndex } from '../client/src/world/interior.ts';
import { AccountStore } from './accounts.ts';
import { InteriorStore } from './interiors.ts';
import { Room, newConn, type Conn, type Socket } from './room.ts';
import type { ServerWorld } from './world.ts';
import type { Participant } from './sim.ts';

const verbose = process.argv.includes('--verbose');

/**
 * Ticks to let the loop settle before reading a browser's mind.
 *
 * A third of a second. `net/interpdelay.INTERP_DELAY_MS` draws remotes 100 ms
 * in the past and the snapshot cadence is 50 ms, so a remote that has just
 * entered a working set has neither of the two samples its interpolation needs
 * for another six ticks — and reading its position before then is reading the
 * origin, which is thirty-five metres from anything in this fixture and looks
 * exactly like a bug. Twenty ticks is four snapshots past that.
 */
const SETTLE = 20;

let failures = 0;
let checks = 0;
function check(ok: boolean, what: string): void {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
}
function say(line: string): void {
  console.log(line);
}
function note(line: string): void {
  if (verbose) console.log(`       ${line}`);
}

// --- The fixture ------------------------------------------------------------

/** The block's half-extents and height. Eight storeys, so it gets a lift. */
const HALF_X = 13;
const HALF_Z = 10;
const HEIGHT = 25;

function emptyWorld(): ServerWorld {
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    hexes: [],
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

/**
 * One block at the origin, tall enough for a lift. Its long wall faces -Z.
 *
 * Through `CollisionWorld.addTile` and a hand-rolled payload rather than
 * through `addPrisms`, and that is not fussiness: `addPrisms` marks everything
 * it is given **structural**, which is the flag `doorway.doorAt` refuses so
 * that there is no door under the Cahill. A fixture built with it is a
 * building nobody can get into, and the symptom is a whole check quietly
 * measuring three people standing in the street. See INTERIORS.md on
 * `Prism.structural` reading the opposite way to its name.
 *
 * The payload is the pipeline's own: a `u32` count, then per prism an `f32`
 * height, an `f32` base, a `u16` corner count and that many `f32` x,z pairs.
 * `buildingCount` is left off, which marks every prism a building — which is
 * exactly what this block is.
 */
function fixtureWorld(): ServerWorld {
  const world = emptyWorld();
  const corners = [
    -HALF_X, -HALF_Z,
    HALF_X, -HALF_Z,
    HALF_X, HALF_Z,
    -HALF_X, HALF_Z,
  ];
  const n = corners.length >> 1;
  const buffer = new ArrayBuffer(4 + 4 + 4 + 2 + n * 8);
  const v = new DataView(buffer);
  v.setUint32(0, 1, true);
  v.setFloat32(4, HEIGHT, true);
  v.setFloat32(8, 0, true);
  v.setUint16(12, n, true);
  for (let i = 0; i < n; i++) {
    v.setFloat32(14 + i * 8, corners[i * 2], true);
    v.setFloat32(18 + i * 8, corners[i * 2 + 1], true);
  }
  world.collision.addTile('block', buffer, 0, 0);
  return world;
}

/**
 * The door is knocked on at the middle of the wall at -Z, from a metre out.
 *
 * The same arrangement `checkInteriors` uses over the real bake: a body a metre
 * off the longest wall looking square at it. The outward normal here is -Z, so
 * the body stands at z = -HALF_Z - 1 looking toward +Z.
 */
const DOOR_X = 0;
const DOOR_Z = -HALF_Z;
const OUT_X = 0;
const OUT_Z = -1;

// --- The loopback -----------------------------------------------------------

/**
 * A socket that keeps its frames in an array. `carhit-check.ts`' class, and the
 * only thing the room ever asks of a `Socket` besides `send` is a `close` and a
 * `ping` it does not read here.
 */
class FakeSocket {
  readonly frames: ArrayBuffer[] = [];
  constructor(readonly data: Conn) {}
  send(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.frames.push(bytes.slice().buffer as ArrayBuffer);
    return bytes.byteLength;
  }
  close(): void {}
  ping(): number { return 0; }
}

/**
 * One end to end participant: a socket, a room-side `Participant`, and the real
 * browser-side `NetClient` that is being measured.
 *
 * The client's transport is a pair of arrays rather than a websocket, and the
 * lag is zero on purpose: this check is about *what the wire carries*, not
 * about when it arrives. `carhit-check.ts` is the driver that measures the
 * second thing and it injects lag for exactly that reason.
 */
interface Client {
  readonly who: string;
  readonly sock: FakeSocket;
  readonly net: NetClient;
  readonly toServer: ArrayBuffer[];
  participant: Participant | null;
  joined: boolean;
}

/**
 * The velocity every client reports: none.
 *
 * A borrowed `Vector3` off a throwaway combatant rather than an object literal,
 * because `NetClient.sendInput` wants three's type and this file must not
 * import three -- the server imports `client/src` and everything it reaches has
 * to stay three-free (CLAUDE.md). `game/combat.ts` already owns one.
 */
const STILL = createCombatant(0, 0, 0).body.velocity;

const input: CombatInput = {
  forward: 0, right: 0, jump: false, sprint: false,
  yaw: 0, pitch: 0, speedScale: 1, jumpScale: 1, punch: false, throwBall: false,
};

class Harness {
  readonly room: Room;
  readonly clients: Client[] = [];
  private clockMs = Date.now();

  constructor(world: ServerWorld, money: ConstructorParameters<typeof Room>[4] = {}) {
    this.room = new Room(0, world, 8, 0, money);
  }

  add(who: string, token: string | null = null): Client {
    const sock = new FakeSocket(newConn(0));
    const toServer: ArrayBuffer[] = [];
    const transport: NetTransport = {
      open: true, onframe: null, onopen: null, onclose: null,
      send(f: ArrayBuffer): void { toServer.push(f); },
      close(): void {},
    };
    const net = new NetClient('', {
      onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {},
      onJoin: () => {}, onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
    }, { name: who, transport, nowMs: () => this.clockMs, ...(token === null ? {} : { token }) });
    transport.onopen?.();
    const client: Client = { who, sock, net, toServer, participant: null, joined: false };
    (client as { transport?: NetTransport }).transport = transport;
    this.clients.push(client);
    return client;
  }

  /** Drop a client's socket the way `server/index.ts` does on a close. */
  drop(client: Client): void {
    this.room.leave(client.sock as unknown as Socket);
    client.participant = null;
    const at = this.clients.indexOf(client);
    if (at >= 0) this.clients.splice(at, 1);
  }

  /** One 60 Hz tick: client frames in, the room steps, server frames out. */
  step(): void {
    this.clockMs += 1000 / TICK_HZ;
    for (const c of this.clients) {
      c.net.sendInput(input, STILL);
      for (const f of c.toServer.splice(0)) {
        if (frameType(f) === MSG.HELLO && !c.joined) {
          c.joined = true;
          const account = accountFor(c);
          const p = this.room.join(c.sock.data, 0, c.who, account);
          if (p) {
            c.participant = p;
            this.room.conns.add(c.sock as unknown as Socket);
            this.room.welcome(c.sock as unknown as Socket, p);
          }
        }
        // Input frames are deliberately dropped: every body in this check is
        // placed by the server (which is the only end allowed to place one) and
        // nothing here is testing prediction. Accepting them would have the
        // controller walk each body off the spot the check just put it on.
      }
    }
    this.room.step();
    for (const c of this.clients) {
      const transport = (c as unknown as { transport: NetTransport }).transport;
      for (const f of c.sock.frames.splice(0)) transport.onframe?.(f);
      c.net.update(1 / TICK_HZ);
    }
  }

  steps(n: number): void {
    for (let i = 0; i < n; i++) this.step();
  }
}

/**
 * The account a client joins with, if the caller staged one.
 *
 * A side table rather than a field, because `Harness.add` is called before the
 * account exists in the persistence phase and the join happens a tick later.
 */
const accounts = new Map<Client, Parameters<Room['join']>[3]>();
function accountFor(c: Client): Parameters<Room['join']>[3] {
  return accounts.get(c) ?? null;
}

// --- Standing a body somewhere ----------------------------------------------

/** A metre off the door, looking square at the wall. `checkInteriors`' pose. */
function standAtDoor(p: Participant): void {
  const x = DOOR_X + OUT_X;
  const z = DOOR_Z + OUT_Z;
  p.combat.body.position.set(x, EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = Math.atan2(OUT_X, OUT_Z);
  p.history.seed(0, x, EYE_HEIGHT, z, 0);
}

/**
 * Tell the rewind index where a body the check just teleported actually is.
 *
 * `Simulation.resolveStrike` collects its melee candidates out of a spatial
 * hash built from each player's `PositionHistory`, so a body moved by an
 * assignment rather than by the controller is still filed at the last position
 * it walked to -- and a punch aimed at it finds nobody. Every mover inside
 * `sim.ts` seeds the history on the same line for this reason.
 */
function seed(h: Harness, p: Participant): void {
  const b = p.combat.body;
  p.history.seed(h.room.sim.tick, b.position.x, b.position.y, b.position.z, b.yaw);
}

/** Put a body on a level of the interior it is standing in. */
function standOnLevel(p: Participant, level: number): boolean {
  const it = p.interior;
  if (it === null || level >= it.levels.length) return false;
  const b = p.combat.body;
  b.position.y = it.levels[level].y + EYE_HEIGHT;
  b.velocity.set(0, 0, 0);
  return true;
}

/** The level a participant's feet are on, as both ends compute it. */
function levelOf(p: Participant): number {
  const it = p.interior;
  if (it === null) return 0;
  return levelIndex(it.levels, p.combat.body.position.y - EYE_HEIGHT);
}

// --- The check --------------------------------------------------------------

async function main(): Promise<void> {
  say(
    '--- interiors are shared: three browsers, one building, over a real Room\n' +
      `    a ${HALF_X * 2} x ${HALF_Z * 2} m block ${HEIGHT} m tall, no city loaded\n`,
  );

  const stateDir = process.env.SYDNEY_STATE_DIR ?? '/tmp';
  const storePath = `${stateDir}/interior-share-check.json`;
  const accountPath = `${stateDir}/interior-share-check-accounts.json`;
  await Bun.$`rm -f ${storePath} ${accountPath}`.quiet().nothrow();

  const world = fixtureWorld();
  const interiors = new InteriorStore(storePath, false);
  const store = new AccountStore(accountPath);
  await store.load();

  const h = new Harness(world, { interiors, accounts: store });
  const a = h.add('Bazza');
  const b = h.add('Shazza');
  const c = h.add('Bystander');
  h.steps(SETTLE);

  if (a.participant === null || b.participant === null || c.participant === null) {
    check(false, 'three clients joined the room');
    process.exitCode = 1;
    return;
  }
  check(true, `three clients joined the room (ids ${a.participant.id}, ${b.participant.id}, ${c.participant.id})`);

  // --- 1. Two through one door.
  say('\n  1. two people through one door');
  standAtDoor(a.participant);
  h.room.doorPress(a.sock as unknown as Socket);
  standAtDoor(b.participant);
  h.room.doorPress(b.sock as unknown as Socket);
  h.steps(SETTLE);

  const space = a.participant.space;
  check(space !== CITY_SPACE && b.participant.space === space, `both are in the building's own space (0x${space.toString(16)})`);
  check(a.participant.interior === b.participant.interior, 'and are handed one Interior, not two copies of it');
  check(a.net.space === space && b.net.space === space, 'and both browsers were told which space they are in');
  const levels = a.participant.interior?.levels.length ?? 0;
  check(levels >= 3, `the fixture is ${levels} storeys, so a floor is a question that can be asked`);

  // The measurement the report is about: what does each browser have?
  const aSeesB = a.net.remotes.get(b.participant.id) ?? null;
  const bSeesA = b.net.remotes.get(a.participant.id) ?? null;
  check(aSeesB !== null, `Bazza's browser has a record of Shazza (${a.net.remotes.size} remotes)`);
  check(bSeesA !== null, `Shazza's browser has a record of Bazza (${b.net.remotes.size} remotes)`);
  if (aSeesB !== null) {
    const drift = Math.hypot(
      aSeesB.position.x - b.participant.combat.body.position.x,
      aSeesB.position.z - b.participant.combat.body.position.z,
    );
    check(drift < 1.0, `and draws them where the server has them (${drift.toFixed(2)} m out, interpolation included)`);
  }
  note(`Bazza at (${a.participant.combat.body.position.x.toFixed(1)}, ${a.participant.combat.body.position.z.toFixed(1)})`);
  note(`Shazza at (${b.participant.combat.body.position.x.toFixed(1)}, ${b.participant.combat.body.position.z.toFixed(1)})`);

  // --- 2. The pavement.
  say('\n  2. the pavement, a metre and a half away, through the wall');
  c.participant.combat.body.position.set(DOOR_X + OUT_X * 1.5, EYE_HEIGHT, DOOR_Z + OUT_Z * 1.5);
  c.participant.combat.body.velocity.set(0, 0, 0);
  h.steps(SETTLE);
  check(c.participant.space === CITY_SPACE, 'the bystander is outdoors');
  check(
    !c.net.remotes.has(a.participant.id) && !c.net.remotes.has(b.participant.id),
    `the bystander's browser has neither of them (${c.net.remotes.size} remotes)`,
  );
  check(
    !a.net.remotes.has(c.participant.id) && !b.net.remotes.has(c.participant.id),
    'and neither of them has the bystander',
  );

  // --- 3. The floor.
  say('\n  3. the same building is not the same room');
  const rode = standOnLevel(b.participant, 2);
  check(rode, `Shazza is on level ${levelOf(b.participant)} and Bazza on level ${levelOf(a.participant)}`);
  h.steps(SETTLE);
  const stillThere = a.net.remotes.get(b.participant.id) ?? null;
  const gap = stillThere === null ? 0 : Math.abs(stillThere.position.y - a.participant.combat.body.position.y);
  check(
    stillThere === null,
    stillThere === null
      ? 'Bazza\'s browser has stopped drawing Shazza two floors up'
      : `Bazza's browser still draws Shazza, ${gap.toFixed(1)} m up through the ceiling`,
  );
  check(
    (b.net.remotes.get(a.participant.id) ?? null) === null,
    'and Shazza\'s has stopped drawing Bazza on the ground floor',
  );
  // Back down, so the rest of the check has two people in one room again.
  standOnLevel(b.participant, 0);
  h.steps(SETTLE);
  check(a.net.remotes.has(b.participant.id), 'and has them back the moment they come down the stairs');

  // --- 4. One leaves.
  say('\n  4. one walks out');
  h.room.doorPress(b.sock as unknown as Socket);
  check(b.participant.space === CITY_SPACE, 'Shazza is back on the street');
  // **The leaver's own browser, on the frame it is told.** `MSG.SPACE` is a
  // teleport, not a correction, and everybody in the working set belonged to
  // the room that has just gone. One tick is the SPACE frame arriving; there is
  // no snapshot in it. Before the client dropped its remotes there, Shazza
  // stood on the pavement watching the pub's drinkers standing on it with her.
  h.step();
  check(
    b.net.remotes.size === 0,
    `Shazza's browser forgot the room's people on the SPACE frame itself, before any snapshot (${b.net.remotes.size} left)`,
  );
  // And the stayer's, which is the server's `INTEREST` delta and takes a
  // snapshot rather than a frame.
  let sawLeaveAfter = -1;
  for (let t = 1; t <= 12; t++) {
    h.step();
    if (!a.net.remotes.has(b.participant.id)) { sawLeaveAfter = t; break; }
  }
  const snapTicks = Math.round(TICK_HZ / 20);
  check(
    sawLeaveAfter >= 0 && sawLeaveAfter <= snapTicks * 2,
    sawLeaveAfter < 0
      ? "Bazza's browser is still drawing Shazza in the pub after twelve ticks"
      : `Bazza's browser dropped them after ${sawLeaveAfter} ticks (a snapshot is ${snapTicks})`,
  );

  // --- 4b. A punch still lands between two people in one room.
  //
  // The half of "shared" that is not drawing. Nothing in this branch touched
  // melee and this is here to say so with an assertion rather than with a
  // sentence: `Simulation` already filters the rewind candidates by `space`
  // (one line, `other.space === p.space`), and it deliberately does **not**
  // filter them by storey. That is the right call and it is worth writing down
  // — a swing has a reach of about two metres and a storey is 3.1, so the
  // body's own 3D distance already refuses the punch through the ceiling, and
  // it refuses it *correctly* on a staircase, where two people a step apart are
  // on different level indices and can plainly hit each other. The boundary for
  // a hit is the room and the arm; it was never the layer.
  say('\n  4b. and a punch still lands between two people in one room');
  standAtDoor(b.participant);
  h.room.doorPress(b.sock as unknown as Socket);
  h.steps(SETTLE);
  {
    // Yaw 0 faces -Z, and the yaw goes on the **input** as well as on the body:
    // `controller.step` copies `input.yaw` in every tick, so a body yaw set
    // here and not mirrored is overwritten before the first swing.
    // `verifySim`'s own fixture says the same thing in the same words.
    const av = a.participant.combat.body;
    const bv = b.participant.combat.body;
    bv.position.set(av.position.x, av.position.y, av.position.z - 0.9);
    bv.velocity.set(0, 0, 0);
    av.yaw = 0;
    a.participant.input.yaw = 0;
    b.participant.input.yaw = 0;
    // The rewind index is built from the position history, so a body teleported
    // by a check has to say so or the swing measures where it used to be.
    seed(h, a.participant);
    seed(h, b.participant);
    const before = b.participant.combat.health;
    a.participant.input.punch = true;
    for (let t = 0; t < 60; t++) h.step();
    a.participant.input.punch = false;
    check(
      b.participant.combat.health < before,
      `Bazza swings and Shazza feels it (${before} to ${b.participant.combat.health})`,
    );
    // And the bystander outside, on the same metre, does not: the melee
    // candidates are filtered by space one layer under the working set.
    const cv = c.participant.combat.body;
    cv.position.set(av.position.x, av.position.y, av.position.z - 0.9);
    cv.velocity.set(0, 0, 0);
    seed(h, c.participant);
    // Shazza out of reach, so the only body in front of the swing is the one in
    // the city -- otherwise this would pass by hitting her again.
    bv.position.set(av.position.x + 20, av.position.y, av.position.z);
    seed(h, b.participant);
    const outsideBefore = c.participant.combat.health;
    a.participant.input.punch = true;
    for (let t = 0; t < 60; t++) h.step();
    a.participant.input.punch = false;
    check(
      c.participant.combat.health === outsideBefore,
      `and the bystander standing on the same metre in the city does not (${c.participant.combat.health} of ${outsideBefore})`,
    );
  }

  // --- 5. Furniture, which was already shared and is not this branch's code.
  say('\n  5. a couch, placed by one, seen by the other');
  // Shazza is still inside from 4b, and off the pavement she was knocked
  // towards; the couch is about the room, not about her health.
  b.participant.combat.health = MAX_HEALTH;
  h.steps(SETTLE);
  check(b.participant.space === space, 'Shazza is in the room with Bazza');
  const spot = a.participant.interior === null ? null : { x: a.participant.interior.centreX, z: a.participant.interior.centreZ };
  let placed = 0;
  if (spot !== null) {
    // Through `Room.furnish`, not `Simulation.furnish`: the room is what
    // decides who the new contents go to, and "everybody in that space" is
    // precisely the claim under test.
    for (let ring = 1; ring <= 8 && placed === 0; ring++) {
      for (let dir = 0; dir < 8 && placed === 0; dir++) {
        const q = dir / 8;
        const dx = q < 0.5 ? 1 - q * 4 : q * 4 - 3;
        const dz = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
        const len = Math.hypot(dx, dz) || 1;
        const x = spot.x + (dx / len) * ring * 0.9;
        const z = spot.z + (dz / len) * ring * 0.9;
        h.room.furnish(a.sock as unknown as Socket, { op: FURNISH_OP.PLACE, kind: 0, turn: 0, x, z });
        placed = h.room.sim.placedIn(space).length;
      }
    }
  }
  check(placed === 1, `Bazza puts a couch down (${placed} in the room)`);
  h.steps(SETTLE);
  check(
    b.net.placedSpace === space && b.net.placed.length === h.room.sim.placedIn(space).length,
    `Shazza's browser holds the same ${h.room.sim.placedIn(space).length} thing in the same room (${b.net.placed.length})`,
  );

  // --- 6. Log off inside, log in inside.
  say('\n  6. a disconnect inside and a rejoin');
  const signed = await store.signup('Bazza', 'hunter2hunter2', 'Bazza', null);
  const record = store.byHandle('bazza');
  if (!signed.ok || !record) {
    check(false, 'the fixture signed up');
  } else {
    // Re-join as the account so the disconnect has somewhere to save to.
    h.drop(a);
    const a2 = h.add('Bazza');
    accounts.set(a2, record);
    h.steps(SETTLE);
    if (a2.participant === null) {
      check(false, 'the account joined');
    } else {
      standAtDoor(a2.participant);
      h.room.doorPress(a2.sock as unknown as Socket);
      h.steps(SETTLE);
      standOnLevel(a2.participant, 2);
      h.steps(SETTLE);
      const wasAt = { ...a2.participant.combat.body.position };
      const wasLevel = levelOf(a2.participant);
      const wasId = a2.participant.id;
      check(a2.participant.space === space && wasLevel === 2, `the account walks in and goes up to level ${wasLevel}`);
      h.drop(a2);
      h.room.sim.leave(wasId);
      check(record.lastPos?.building !== undefined, 'the building is saved beside the position on the disconnect');

      const a3 = h.add('Bazza');
      accounts.set(a3, record);
      h.steps(SETTLE);
      if (a3.participant === null) {
        check(false, 'the account joined again');
      } else {
        check(a3.participant.space === space, 'and they log back in inside the same building');
        const backLevel = levelOf(a3.participant);
        check(backLevel === wasLevel, `on the floor they left (level ${backLevel} against ${wasLevel})`);
        const drift = Math.hypot(
          a3.participant.combat.body.position.x - wasAt.x,
          a3.participant.combat.body.position.z - wasAt.z,
        );
        check(drift < 1.5, `standing where they logged off (${drift.toFixed(2)} m)`);
        check(a3.net.space === space, 'and their browser was told the space on the welcome, not left guessing');
        // And the other person in the room sees them arrive.
        standOnLevel(a3.participant, 0);
        h.steps(SETTLE);
        check(
          b.net.remotes.has(a3.participant.id),
          `Shazza, who never left, sees them walk back in (${b.net.remotes.size} remotes)`,
        );
      }
    }
  }

  // The store's write is debounced by two seconds and a pending timer keeps
  // this process alive long past the last assertion; `close` flushes it.
  await store.close();
  await Bun.$`rm -f ${storePath} ${accountPath}`.quiet().nothrow();
  say(`\n  ${checks - failures}/${checks} checks passed`);
  // Exited rather than returned: `AccountStore.close` flushes the write but
  // does not cancel the timer that scheduled it, and a check that hangs for two
  // seconds after it has printed its result reads as a check that hung.
  process.exit(failures > 0 ? 1 : 0);
}

void main();
