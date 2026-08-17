/**
 * Stealing a car, through the button a player actually presses. PERMANENT.
 *
 *     bun run server/take-check.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY NOTHING ELSE COVERED IT.
 *
 * The owner reported, on the protocol-15 build: *"i also seem to no longer be
 * able to steal cars"*. Everything that could have answered that was already
 * green, and none of it was asking the question:
 *
 *   - `verifyDriving` checks the constants and `CarField`'s claim rule and says
 *     outright that it cannot run `resolveTake` -- that needs a `TrafficField`
 *     with a baked sidecar in it, which a boot-time unit check has no business
 *     loading.
 *   - `cardamage-check.ts` runs whole server ticks, but it puts the driver in
 *     the car **by hand** (`sim.cars.take` with a literal identity) because its
 *     empty test city has no lanes at all. What it exercises is the crash.
 *   - `integration-check.ts` never mentions `drivingCar`.
 *
 * So the path a player uses -- press `E`, the level bit rides out on `INPUT`,
 * the server takes the *edge* in `Simulation.resolveMount`, walks the priority
 * chain, asks `resolveTake` against the real timetable at the real wall-clock
 * tick, and allocates a record -- had no test at any level. This is that test.
 *
 * Five things it drives that nothing else does:
 *
 *   1. **The real world.** `loadWorld` over the shipped bake, so the cars are
 *      the city's own timetable at this second rather than a fixture. A pipeline
 *      round that moved the bays fails here.
 *   2. **The button, not the API.** `applyButtons(p.input, BTN.MOUNT)` is the
 *      exact call `room.step` makes on an arriving `INPUT` frame, and the press
 *      is a level bit held for one tick and cleared -- so the edge is what
 *      grants the take and the whole chain above it (off a train, off a bike,
 *      onto a train, onto a bike, into a car) is in the path.
 *   3. **Both ends of the prompt.** The browser predicts the take and draws
 *      "E -- take the car" from the same `resolveTake` with its own arguments
 *      (`traffic`, feet, tick, `cars.suppressed`). A prompt the server would
 *      refuse is this bug's other shape: the HUD promises a car and the key does
 *      nothing. Every press below asks the client's question at the same tick
 *      and asserts it names the same identity.
 *   4. **The two shapes of parked car the residency change created.** A car in a
 *      pipeline kerb bay (`bays.py`) and a car at the **left edge of its own
 *      lane** at an end the pipeline could not fill (`traffic.synthesiseLaneBay`,
 *      `route.laneBay0/1`). Both are `speed 0` and both must be takeable; the
 *      second did not exist when the take last worked, and is the case the owner
 *      most plausibly walked up to.
 *   4b. **The parked fleet, which is 23,020 of the cars a player can reach
 *      against the timetable's forty.** Sections 6 and 7 are workstream S: they
 *      press `E` beside a car out of `<tile>.cars.bin`, which until this round the
 *      server did not know existed. See `game/staticcars.ts` section 1 and
 *      `game/driving.ts` section 1, which this workstream retired. Section 6 also
 *      builds a **second, independently decoded** `StaticCarField` off the same
 *      bytes with its own ground function, and asks it the client's question at
 *      the server's tick -- which is the only way to test the property the two
 *      ends actually rest on: not "the same code agrees with itself" but "two
 *      decodes of one file name one car".
 *   5. **The wire.** Section 5 is a real `Room`, a real `NetClient` and a real
 *      `MSG.CARS` in between, because the browser *predicts* the take and then
 *      ignores the server's opinion of which car it is in until the input
 *      carrying the press is acknowledged (`net/client.ts`, `carPredictedAt`).
 *      Two things can go wrong there that sections 2-4 cannot see: the
 *      prediction can mint a record id the server does not use, and the
 *      adoption can fire against a `serverCar` of 0 and put the driver back on
 *      the footpath one round trip after every press. Both feel exactly like
 *      "I can no longer steal cars". The loopback harness is
 *      `integration-check.checkRidingOnline`'s -- `FakeSocket`, `newConn`,
 *      `receiveInput`, `room.welcome` -- which is how a wire is tested here
 *      without an operating system.
 *
 * ---------------------------------------------------------------------------
 * IT IS A DRIVER, NOT A `verify*`.
 *
 * It loads a 60 km world and reads the wall clock, so it cannot go in the boot
 * lists beside `verifyDriving`. It goes in DEPLOY.md's gate list beside
 * `cardamage-check.ts` and `accounts-check.ts`, runs in a few seconds against a
 * warm page cache, and exits non-zero on any failure.
 *
 * ---------------------------------------------------------------------------
 * WHAT A REFUSAL MEANS, AND WHY THE BOUND IS NOT ZERO.
 *
 * The timetable runs on the wall clock and this driver spends real ticks -- a
 * `sim.step` over the shipped world costs milliseconds and section 2 holds the
 * throttle for a second -- so the census is a photograph of a city that has
 * since moved. The first version of this file trusted it and measured 142
 * refusals in 264 presses, every one of them a car that had driven off. `repose`
 * is the answer: the census says only *where to look*, and every press asks the
 * timetable again at the instant it stands the body up. What is left after that
 * is one tick of skew between the prompt and the press, which is 16.7 ms, and
 * the two bounds in section 4 are sized for it:
 *
 *   - **refusals**, a twentieth of the sweep. Above that the take is refusing.
 *   - **promised refusals**, two: a press refused at a car the client's own
 *     `resolveTake` had just offered. That is the reported bug's exact shape and
 *     it gets the tighter bound for that reason.
 *
 * Two things that are *not* refusals and are counted apart: a car that has left
 * (`movedOn`), and a free lime bike inside `bikes.MOUNT_RADIUS` of the standing
 * point, which `resolveMount` correctly answers before the car (`bikeAnswersFirst`).
 *
 * Environment: `SYDNEY_WORLD` to point at another bake, `TAKE_SWEEP` to cap how
 * many cars section 4 walks.
 */

import { Simulation, applyButtons, type Participant, type TickOutput } from './sim.ts';
import { Room, newConn, receiveInput, type Conn, type Socket } from './room.ts';
import { groundFor, loadWorld, type ServerWorld } from './world.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { NetClient } from '../client/src/net/client.ts';
import { advance, createCombatant, type CombatInput } from '../client/src/game/combat.ts';
import { BTN, MSG, TICK_HZ, frameType, type NetTransport } from '../client/src/net/protocol.ts';
import {
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  bayOccupant,
  createCarPose,
  forEachCarNear,
  identityOf,
  trafficSeconds,
  trafficTick,
  verifyBayBounds,
  type CarPose,
  type LaneRoute,
} from '../client/src/game/traffic.ts';
import {
  TAKEABLE_SPEED,
  TAKE_HEIGHT,
  TAKE_RADIUS,
  createDrivingScratch,
  headingYaw,
  resolveTake,
} from '../client/src/game/driving.ts';
// WORKSTREAM S. `decodeCars` is aliased because `net/protocol.ts` exports a
// `decodeCars` of its own for `MSG.CARS`, and section 6 needs both: one reads a
// sidecar off the disk, the other reads a record off the wire.
import {
  StaticCarField,
  createStaticCarPose,
  decodeCars as decodeCarSidecar,
  type StaticCarPose,
} from '../client/src/game/staticcars.ts';
import { decodeCars as decodeCarsWire, encodeCars } from '../client/src/net/protocol.ts';

const failures: string[] = [];
const say = (s: string): void => { console.log(s); };
const fail = (s: string): void => { failures.push(s); };

/** One candidate: a car the timetable has standing still somewhere reachable. */
interface Candidate {
  identity: number;
  x: number;
  y: number;
  z: number;
  /** Its own heading as a look yaw, `driving.headingYaw`. */
  yaw: number;
  speed: number;
  stage: number;
  /** True when its bay was invented by `synthesiseLaneBay` rather than baked by `bays.py`. */
  laneEdge: boolean;
  /** The ground under the point a player would stand on to reach it. */
  groundY: number;
  /**
   * WORKSTREAM S: true for a car out of `<tile>.cars.bin` rather than off the
   * timetable.
   *
   * The difference matters to `repose` and to nothing else: a static car cannot
   * drive off between the census and the press, because it is furniture. That is
   * the whole reason sections 6 and 7 need no refusal budget of their own.
   */
  isStatic?: boolean;
}

const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const world = await loadWorld(root);
const ground = groundFor(world);
const combatWorld = groundFor(world);

say(`--- take-check: ${world.traffic.tileCount} lane tiles, spawn ${world.spawn.x.toFixed(0)}, ${world.spawn.z.toFixed(0)}`);

// ---------------------------------------------------------------------------
// WORKSTREAM S. The browser's copy of the parked fleet, decoded here from the
// same files, so that "both ends name the same car" is a claim this driver can
// actually falsify.
//
// The temptation is to hand `world.staticCars` to both sides of every comparison
// below. That tests nothing: it is one object agreeing with itself. What the
// feature rests on is that **two independent decodes of one `.cars.bin` produce
// the same identities at the same world coordinates** -- the server's through
// `HexResidency`'s third layer out of a hexagon manifest, the browser's through
// `streamer.buildTile` out of `index.json`. So this reads the sidecars the way
// the *browser* addresses them (`index.json`'s `bounds`, the tile group's
// translation) and gives the field its own ground closure, which is the second
// half of `game/staticcars.ts` section 3's honesty about the height.
//
// Bounded to the tiles near the census centres rather than the whole city, for
// the reason the server's own residency is bounded: 13,362 sidecars is 46 MB and
// a driver that loaded all of them would be measuring the wrong thing.
// ---------------------------------------------------------------------------

const clientStatics = new StaticCarField();
{
  const centreList: Array<[number, number]> = [
    [world.spawn.x, world.spawn.z], [0, 0], [-4000, 2000], [2000, 1000],
  ];
  const RANGE = 1200;
  let read = 0;
  let missing = 0;
  for (const entry of world.index.tiles) {
    const originX = entry.bounds[0];
    const originZ = entry.bounds[1] + world.index.tile_size;
    // The tile's own extent in world metres, on the streamer's frame: x runs east
    // from `bounds[0]` and z runs *south* from `bounds[1] + tile_size`.
    const midX = originX + world.index.tile_size / 2;
    const midZ = originZ - world.index.tile_size / 2;
    let near = false;
    for (const [cx, cz] of centreList) {
      if (Math.abs(midX - cx) < RANGE && Math.abs(midZ - cz) < RANGE) near = true;
    }
    if (!near) continue;
    let buffer: ArrayBuffer | null = null;
    try {
      const file = Bun.file(`${root}/tiles/${entry.key}.cars.bin`);
      buffer = await file.arrayBuffer();
    } catch {
      buffer = null;
    }
    if (buffer === null) {
      missing++;
      continue;
    }
    const decoded = decodeCarSidecar(buffer, entry.key);
    if (decoded === null) continue;
    clientStatics.adopt(entry.key, decoded, originX, originZ);
    read++;
  }
  // Its own ground, and deliberately a *different* `CombatWorld` instance from
  // the server's: `groundFor` carries a `lastGround` per caller (see its header),
  // so sharing one would hide exactly the class of disagreement this is for.
  clientStatics.groundAt = groundFor(world).groundHeight;
  say(
    `  the client's own parked fleet: ${read} sidecar(s) read, ${missing} absent, ` +
      `${clientStatics.carCount.toLocaleString()} cars ` +
      `(${(clientStatics.bytes / 1e6).toFixed(1)} MB estimated)`,
  );
  const server = world.staticCars;
  if (server === undefined) {
    fail('`loadWorld` returned a world with no `staticCars` field at all; the third layer is not wired up.');
  } else {
    say(
      `  the server's residency: ${server.tileCount} tile(s), ` +
        `${server.carCount.toLocaleString()} cars (${(server.bytes / 1e6).toFixed(1)} MB estimated, ` +
        `cap SYDNEY_STATIC_CARS_CAP_MB)`,
    );
    if (server.carCount === 0) {
      fail(
        'The server holds no parked cars at all. Either the bake has no `tiles/*.cars.bin` or the ' +
          'residency\'s third layer is not loading them -- and every one of the 23,020 cars at the ' +
          'kerbs in town is unstealable, which is the reported bug exactly.',
      );
    }
  }
  if (clientStatics.carCount === 0) {
    fail('No `.cars.bin` could be read near any centre, so sections 6 and 7 have nothing to press at.');
  }
}

/**
 * Where a player stands to reach a car, and which side of it they are on.
 *
 * 1.5 m off the centre, **across** the heading. Across rather than along because
 * along is the bumper: a 5.6 m van's centre is 2.8 m from its own nose, so
 * standing 1.5 m in front of one is 4.3 m from the point `resolveTake` measures
 * and the reach test would refuse for a reason that has nothing to do with the
 * take. Across the heading the distance is the distance, and 1.5 m is inside
 * `TAKE_RADIUS` with 0.7 m to spare -- the same offset `sydney.cars.stand()`
 * uses in the browser.
 *
 * `side` is +1 for the kerb flank of a car parked on the left of the road and -1
 * for the traffic flank. Both are tested: nothing in `resolveTake` is
 * directional, and a take that only worked from one side would be a bug nobody
 * would ever describe correctly.
 */
function standBeside(c: Candidate, side: number): { x: number; z: number } {
  // Left of a heading (dx, dz) is (dz, -dx) -- `traffic.resolveHeld`'s axes and
  // `lanes.py`'s. The heading is recovered from the look yaw the pose gave.
  const dx = -Math.sin(c.yaw);
  const dz = -Math.cos(c.yaw);
  return { x: c.x + dz * 1.5 * side, z: c.z - dx * 1.5 * side };
}

/**
 * Is the ground under the standing point the same piece of road as the car?
 *
 * A car on the Cahill Expressway and a player on Alfred Street eight metres
 * below it are correctly not each other's business -- that is `TAKE_HEIGHT`, and
 * `resolveTake` refusing there is the feature working. So a candidate whose
 * terrain disagrees with its lane by more than the gate is **skipped** rather
 * than failed: this driver is about the take, and a bridge deck is a question
 * for the pipeline.
 */
function reachable(c: Candidate): boolean {
  return Math.abs(c.y - c.groundY) <= TAKE_HEIGHT;
}

/**
 * Where that car is **now**, or null if it has driven off.
 *
 * The one methodological thing this driver has to get right, and the first
 * version of it got wrong: the census is a photograph and the timetable is a
 * clock. A `sim.step` over the real world costs milliseconds, a section that
 * holds the throttle for a second costs sixty of them, and by the time a sweep
 * reaches its hundredth candidate several seconds of Sydney have gone by -- so a
 * car filed as parked is halfway up the street and every press is refused for a
 * reason that has nothing to do with the take. Measured: 142 of 264 presses,
 * with the client agreeing on every one of them.
 *
 * So the census only says *where to look*, and this re-asks the timetable at the
 * instant of the press through the same iterator the take uses. A car that has
 * left is `null` and is counted as having moved on, which is the honest answer:
 * the world moved, nothing refused anything. 30 m of search radius is a little
 * over the `HOLD_MAX_LAG` a held car can be shifted by plus the distance a car
 * pulling out of a bay covers in the second this might be behind.
 */
function repose(c: Candidate): Candidate | null {
  // WORKSTREAM S: a parked car is not on a clock. The whole methodological
  // problem this function exists for -- the census is a photograph, the timetable
  // is a clock -- does not apply to it, so the photograph is still true.
  if (c.isStatic) return c;
  let found: Candidate | null = null;
  forEachCarNear(
    world.traffic, c.x, c.z, 30, trafficTick(Date.now()), censusRoutes, censusPose,
    (p: CarPose) => {
      if (p.identity !== c.identity) return;
      if (p.speed > TAKEABLE_SPEED) return true;
      found = {
        identity: p.identity,
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: headingYaw(p.dx, p.dz),
        speed: p.speed,
        stage: p.stage,
        laneEdge: c.laneEdge,
        groundY: 0,
      };
      const at = standBeside(found, 1);
      found.groundY = ground.groundHeight(at.x, at.z, found.y);
      return true;
    },
  );
  return found;
}

// ---------------------------------------------------------------------------
// 1. The census: what is standing still near a player, and in what sort of bay.
//
// Four centres rather than one, because the spawn disc is in a park and "can you
// steal a car" is asked in the city too. `forEachCarNear` is the same iterator
// the server's own take runs through, so a car this finds is a car the take is
// entitled to see -- including the residency's hold rule (`bayTaken`), which is
// applied inside it and could hide one.
// ---------------------------------------------------------------------------

const censusTick = trafficTick(Date.now());
const censusNow = trafficSeconds(censusTick);
const censusPose = createCarPose();
const censusRoutes: LaneRoute[] = [];

/**
 * Which parked cars are standing in a bay `synthesiseLaneBay` invented.
 *
 * Asked of the residency's own accounting -- `bayOccupant` names the slot in a
 * bay at an instant -- because that is the only way to tell the two shapes apart
 * from outside `traffic.ts`: a `CarPose` says `PARKED_IN`/`PARKED_OUT` for both,
 * since as far as everything downstream is concerned a car standing in the mouth
 * of a side street and a car in a kerb bay are the same thing. Which is exactly
 * the property section 3 asserts.
 */
const laneEdgeIdentities = new Set<number>();

const centres: Array<[number, number, string]> = [
  [world.spawn.x, world.spawn.z, 'the spawn disc'],
  [0, 0, 'Town Hall'],
  [-4000, 2000, 'the inner west'],
  [2000, 1000, 'the east'],
];

const candidates: Candidate[] = [];
const filed = new Set<number>();
for (const [cx, cz, name] of centres) {
  const before = candidates.length;
  // The synthetic bays first, so the classification is in place before any pose
  // is filed. `near` is the same bucket query `forEachCarNear` walks.
  for (const route of world.traffic.near(cx, cz, 400, censusRoutes)) {
    for (const which of [0, 1]) {
      if (!(which === 0 ? route.laneBay0 : route.laneBay1)) continue;
      const slot = bayOccupant(route, which, censusNow);
      if (slot === null) continue;
      laneEdgeIdentities.add(identityOf(route, slot));
    }
  }
  forEachCarNear(world.traffic, cx, cz, 400, censusTick, censusRoutes, censusPose, (p: CarPose) => {
    if (p.speed > TAKEABLE_SPEED) return;
    if (filed.has(p.identity)) return;
    filed.add(p.identity);
    const c: Candidate = {
      identity: p.identity,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: headingYaw(p.dx, p.dz),
      speed: p.speed,
      stage: p.stage,
      laneEdge: laneEdgeIdentities.has(p.identity),
      groundY: 0,
    };
    const at = standBeside(c, 1);
    c.groundY = ground.groundHeight(at.x, at.z, c.y);
    candidates.push(c);
  });
  say(`  ${name}: ${candidates.length - before} car(s) standing still within 400 m`);
}

const parked = candidates.filter((c) => c.stage === CAR_STAGE_PARKED_IN || c.stage === CAR_STAGE_PARKED_OUT);
const laneEdge = parked.filter((c) => c.laneEdge);
const kerbBay = parked.filter((c) => !c.laneEdge);
say(
  `  ${candidates.length} takeable candidate(s): ${kerbBay.length} in a pipeline kerb bay, ` +
    `${laneEdge.length} at a kerbless lane edge, ${candidates.length - parked.length} stopped mid-route`,
);
if (candidates.length === 0) {
  fail('Not one car in Sydney is standing still near any of the four centres. Nothing can be stolen.');
}
if (parked.length === 0) {
  fail('No car is parked in a bay near any centre; the residency has stopped producing them.');
}

// ---------------------------------------------------------------------------
// 1b. Can anything *see* them? The bounds, and a query from every side.
//
// This is the section that found the reported bug, and it is kept because it is
// the only one that is a measurement over the whole bake rather than a press at
// one car. Two claims, and the second is the one a player feels:
//
//   1. **Every bay in the shipped world is inside its own route's plan bounds.**
//      `traffic.verifyBayBounds`, which is the invariant `TrafficField.near`
//      relies on; `verifyTraffic` asserts it at boot over four synthetic tiles
//      and this asserts it over the 23,734 routes a player walks past.
//   2. **Standing anywhere around a stopped car, `resolveTake` finds that car.**
//      Eight approach angles at 1.9 m, at the census tick, with nothing stolen
//      -- so no clock moves and no suppression applies, and a miss is a lookup
//      refusing a car the body is against. Before `coverBays` this was 2.3 % of
//      presses over the whole sample and 3.0 % of the presses at a car parked in
//      a bay; the prompt is drawn from the same call, so those were cars that
//      offered nothing and did nothing.
// ---------------------------------------------------------------------------

say('--- 1b. what a query can see');
for (const f of verifyBayBounds(world.traffic.routes(), 'the shipped bake')) fail(f);
{
  const scratch = createDrivingScratch();
  let tries = 0;
  let missed = 0;
  const examples: string[] = [];
  for (const c of candidates) {
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const px = c.x + Math.cos(a) * 1.9;
      const pz = c.z + Math.sin(a) * 1.9;
      tries++;
      // The car's own y as the feet, not the terrain: this section is about the
      // lookup and not about the ground, which `reachable` covers.
      const got = resolveTake(
        world.traffic, px, c.y, pz, censusTick,
        scratch.routes, scratch.pose, () => false, scratch.take,
      );
      if (got && scratch.take.identity === c.identity) continue;
      missed++;
      if (examples.length < 6) {
        examples.push(
          `identity ${c.identity} stage ${c.stage} from bearing ${Math.round((a * 180) / Math.PI)} deg: ` +
            `${got ? `found ${scratch.take.identity} instead` : 'found nothing'}`,
        );
      }
    }
  }
  say(`  ${missed}/${tries} queries 1.9 m from a stopped car failed to name it`);
  for (const e of examples) say(`    miss: ${e}`);
  /**
   * The bound, and why it is not zero.
   *
   * `resolveTake` returns the *nearest* car and breaks ties on identity, so a
   * query point that happens to be nearer a second stopped car -- two cars nose
   * to tail in a bay row, which is most of Surry Hills -- correctly names the
   * other one. That is the feature working and it is what the residue is. A
   * percent of the sample is generous for it; the culling bug was 2.3 %.
   */
  if (missed > Math.max(2, tries * 0.01)) {
    fail(
      `${missed} of ${tries} queries beside a stopped car did not name it. A few are a nearer car in the ` +
        `next bay; this many is \`TrafficField.near\` culling routes whose cars are parked outside their ` +
        `polyline box. See \`traffic.coverBays\`.`,
    );
  }
}

// ---------------------------------------------------------------------------
// 2 and 3. The button path, on one car of each shape.
// ---------------------------------------------------------------------------

const sim = new Simulation(world);
const player = sim.join(0, null, 'thief');
const out: TickOutput = { tick: 0, events: [], snapshot: null };
const clientScratch = createDrivingScratch();

/**
 * Put the body beside a car, authoritatively, exactly as `/tp` does.
 *
 * `sim.placeAt` ends any ride, which is `enterLocal`'s rule. The bike is cleared
 * here on top of that, and it is not defensive tidying: `E` is a priority chain
 * and a bike beats a car, so a press that mounted one instead would leave this
 * participant riding for the rest of the sweep and every press after it would
 * be a *dismount* rather than a take. That is the shape of harness bug that
 * makes a hundred green presses meaningless.
 */
function place(p: Participant, at: { x: number; z: number }, feetY: number, yaw: number): void {
  sim.placeAt(p, at.x, feetY + EYE_HEIGHT, at.z, yaw);
  p.combat.ridingBike = 0;
  p.combat.carSpeed = 0;
  p.input.forward = 0;
  p.input.right = 0;
  p.input.yaw = yaw;
}

/**
 * Is there something else on `E` at this point that the server answers first?
 *
 * `Simulation.resolveMount` is a priority chain -- off a train, off a bike, onto
 * a train, onto a bike, into a car -- and the car is last. So a standing point
 * with a free lime bike inside `bikes.MOUNT_RADIUS` is a point where pressing
 * `E` correctly gets you a bike, and counting that as the take refusing would be
 * this check asserting that the chain is a bug. There are 5,511 bikes in the
 * build, so over a two-hundred-press sweep it happens.
 *
 * Worth stating because it is also the *first* thing this driver saw that looked
 * like the reported failure: two presses in one run where the client's
 * `resolveTake` offered a car and the server gave nothing. Both were a bike.
 * `resolveTake` is only the last link, so a client-side prompt drawn from it
 * alone will always be able to promise a car that `E` answers differently -- and
 * `main.ts.pressMount` runs the identical chain in the identical order, so what
 * the player gets is a bike and not nothing.
 */
function bikeAnswersFirst(at: { x: number; z: number }, feetY: number): boolean {
  return sim.bikes.nearestFree(at.x, feetY, at.z) !== null;
}

/**
 * One press of `E`, as the wire delivers it: the level bit set for one tick and
 * cleared for the next.
 *
 * `applyButtons` is the call `room.step` makes on an arriving `INPUT` frame and
 * `Simulation.resolveMount` takes the edge itself -- see `protocol.BTN.MOUNT` --
 * so this is the whole of a keypress and there is no other way in.
 */
function pressE(p: Participant): void {
  applyButtons(p.input, BTN.MOUNT);
  sim.step(out);
  applyButtons(p.input, 0);
  sim.step(out);
}

/**
 * What the browser's prompt and its prediction would say at this instant.
 *
 * **`clientStatics` is a second, independently decoded copy of the parked fleet**
 * and that is the point of it -- see `buildClientStatics`. Passing
 * `world.staticCars` here would be the server checking its own arithmetic; a
 * separate field over the same bytes with its own ground closure is what the
 * browser actually has.
 */
function clientWouldTake(x: number, feetY: number, z: number): number {
  const found = resolveTake(
    world.traffic,
    x,
    feetY,
    z,
    trafficTick(Date.now()),
    clientScratch.routes,
    clientScratch.pose,
    (identity) => sim.cars.suppressed(identity),
    clientScratch.take,
    clientStatics,
  );
  return found ? clientScratch.take.identity : 0;
}

/**
 * Take a car, drive it, get out, get back in. The whole of what a player does.
 *
 * `label` names the shape of bay under test, so a failure says which of the two
 * broke rather than that "the take" broke.
 */
function driveTheWholeThing(filedAs: Candidate, label: string): void {
  const c = repose(filedAs);
  if (c === null) {
    say(`  ${label}: identity ${filedAs.identity} drove off between the census and the press; nothing tested.`);
    fail(
      `${label}: the only car of this shape near a centre had left by the time the press came. ` +
        `Re-run; if it repeats, the census and the clock have come apart.`,
    );
    return;
  }
  const at = standBeside(c, 1);
  place(player, at, c.groundY, c.yaw);
  const feet = player.combat.body.position.y - EYE_HEIGHT;

  // --- The prompt, from the browser's side, before the press. A disagreement
  //     here is the "the HUD offered me a car and E did nothing" shape.
  const predicted = clientWouldTake(at.x, feet, at.z);
  if (predicted !== c.identity) {
    fail(
      `${label}: the client's \`resolveTake\` named ${predicted} where the census found ${c.identity}, ` +
        `standing ${Math.hypot(c.x - at.x, c.z - at.z).toFixed(2)} m away with dy ` +
        `${(c.y - feet).toFixed(2)}. The HUD and the authority are asking different questions.`,
    );
  }

  // --- And the press.
  pressE(player);
  const carId = player.combat.drivingCar;
  if (carId === 0) {
    fail(
      `${label}: pressing E beside identity ${c.identity} (stage ${c.stage}, speed ` +
        `${c.speed.toFixed(2)}, dy ${(c.y - feet).toFixed(2)}) did not put the player in a car.`,
    );
    return;
  }
  const record = sim.carRecords().find((r) => r.id === carId);
  if (!record) {
    fail(`${label}: \`drivingCar\` is ${carId} and there is no such record on the wire.`);
    return;
  }
  if (record.driver !== player.id) {
    fail(`${label}: the record says driver ${record.driver}, the player is ${player.id}.`);
  }
  if (record.carId !== c.identity) {
    fail(`${label}: took identity ${record.carId} while standing beside ${c.identity}.`);
  }
  if (!sim.cars.suppressed(c.identity)) {
    fail(`${label}: the stolen car's ambient copy is still on the timetable; there are now two of it.`);
  }

  // --- A second of throttle. At `DRIVE_ACCELERATION` that is tens of metres of
  //     street, and it is the only thing that separates "a record exists" from
  //     "the car is mine".
  const fromX = record.x;
  const fromZ = record.z;
  player.input.forward = 1;
  for (let i = 0; i < TICK_HZ; i++) sim.step(out);
  player.input.forward = 0;
  const after = sim.cars.get(carId);
  const moved = after === undefined ? 0 : Math.hypot(after.x - fromX, after.z - fromZ);
  if (moved < 2) {
    fail(
      `${label}: a second of full throttle moved the car ${moved.toFixed(2)} m. ` +
        `Taken but not drivable is the same bug wearing a hat.`,
    );
  }

  // --- Out, and the record stays. Then back in, which is the *other* branch of
  //     `tryTakeCar` -- `nearestEmptyCar` and not `resolveTake`, because the
  //     ambient copy is suppressed and the lookup no longer describes it. It is
  //     also the commonest thing a driver does.
  pressE(player);
  if (player.combat.drivingCar !== 0) {
    fail(`${label}: pressing E in the car did not get the player out.`);
  }
  if (sim.cars.get(carId) === undefined) {
    fail(`${label}: the car vanished when its driver got out.`);
  }
  pressE(player);
  if (player.combat.drivingCar !== carId) {
    fail(
      `${label}: pressing E beside the car just parked did not get back in ` +
        `(\`drivingCar\` is ${player.combat.drivingCar}, the record is ${carId}).`,
    );
  }
  say(
    `  ${label}: identity ${c.identity} stage ${c.stage} -> record ${carId}, ` +
      `drove ${moved.toFixed(1)} m in a second, out and back in`,
  );

  // Leave the room as it was found: nobody driving, the record gone, the ambient
  // copy back on the timetable. The sections below scan for candidates and a
  // suppressed identity is one they must not be handed.
  pressE(player);
  sim.cars.remove(carId);
}

say('--- 2. a car parked in a kerb bay the pipeline chose');
const kerbSubject = kerbBay.find(reachable);
if (kerbSubject === undefined) {
  fail('No car parked in a pipeline kerb bay was standing on ground a player could reach.');
} else {
  driveTheWholeThing(kerbSubject, 'kerb bay');
}

say('--- 3. a car parked at the left edge of its own lane (`synthesiseLaneBay`)');
const edgeSubject = laneEdge.find(reachable);
if (edgeSubject === undefined) {
  // Not a failure on its own: how many kerbless ends there are near a point is
  // the pipeline's business and `checkTraffic` bounds it. Said out loud so a run
  // that skipped the case cannot be mistaken for one that passed it.
  say('  none within 400 m of any centre at this tick; case not exercised this run.');
} else {
  driveTheWholeThing(edgeSubject, 'lane edge');
}

// ---------------------------------------------------------------------------
// 4. The sweep: every candidate, from both flanks, through the button.
//
// One car of each shape is a check; a hundred is a measurement, and it is the
// measurement that answers "can you no longer steal cars" rather than "is this
// one car broken". Refusals are printed with the numbers that would name the
// gate -- range, dy, stage, speed -- because the interesting failure is never
// the count, it is *which* test said no.
// ---------------------------------------------------------------------------

say('--- 4. the sweep');
const sweepCap = Number(process.env.TAKE_SWEEP ?? '9999');
let took = 0;
let skipped = 0;
let movedOn = 0;
let bikeFirst = 0;
let promised = 0;
const refused: string[] = [];
for (const filedAs of candidates.slice(0, sweepCap)) {
  // Per flank rather than per candidate, because the four ticks the first press
  // spends are four ticks of Sydney: a car that is in its bay for the kerb flank
  // may have pulled out before the road one. See `repose`.
  for (const side of [1, -1]) {
    const c = repose(filedAs);
    if (c === null) {
      movedOn++;
      continue;
    }
    if (!reachable(c)) {
      skipped++;
      continue;
    }
    const at = standBeside(c, side);
    place(player, at, c.groundY, c.yaw);
    const feet = player.combat.body.position.y - EYE_HEIGHT;
    // A bike at this point is answered before the car and correctly so. See
    // `bikeAnswersFirst`: not a refusal, and not this section's business.
    if (bikeAnswersFirst(at, feet)) {
      bikeFirst++;
      continue;
    }
    const predicted = clientWouldTake(at.x, feet, at.z);
    pressE(player);
    const carId = player.combat.drivingCar;
    if (carId === 0) {
      // Counted twice when the client would have promised this car, because that
      // is the reported symptom in as many words: the pill says "E -- take the
      // car" and the key does nothing. See `promised` below.
      if (predicted !== 0) promised++;
      refused.push(
        `identity ${c.identity} ${side > 0 ? 'kerb' : 'road'} flank, stage ${c.stage}, ` +
          `speed ${c.speed.toFixed(2)}, range ${Math.hypot(c.x - at.x, c.z - at.z).toFixed(2)} m, ` +
          `dy ${(c.y - feet).toFixed(2)}, client ${predicted === 0 ? 'also refused' : `offered ${predicted}`}` +
          `${c.laneEdge ? ' [lane edge]' : ''}`,
      );
      continue;
    }
    took++;
    if (predicted === 0) {
      fail(
        `identity ${c.identity}: the server granted the take and the client's \`resolveTake\` refused it. ` +
          `The browser would not have drawn the prompt, and would snap the driver back out.`,
      );
    }
    pressE(player);
    sim.cars.remove(carId);
  }
}
say(
  `  ${took} take(s) granted, ${refused.length} refused, ${movedOn} had moved on, ` +
    `${skipped} skipped for terrain, ${bikeFirst} answered by a bike first`,
);
for (const r of refused.slice(0, 12)) say(`    refused: ${r}`);
/**
 * The ceiling on refusals, and why it is not zero.
 *
 * `repose` removes the whole of the staleness this used to measure, so a refusal
 * now means the car was standing where the pose said and the press did nothing.
 * The residue that is still honest is the pose being one tick old -- `repose`
 * reads the clock, the press reads it again two `sim.step`s later, and a car
 * easing out of a bay at 2 m/s can cross the last 0.7 m of `TAKE_RADIUS` in
 * between. So the bound is a twentieth, which on a hundred-car sweep is five.
 * A tenth of the sweep refusing is the reported bug.
 */
if (refused.length > Math.max(4, took * 0.05)) {
  fail(
    `${refused.length} of ${took + refused.length} presses at a re-posed car were refused. ` +
      `A couple is the pose being one tick older than the press; this many is the take refusing.`,
  );
}
/**
 * And the tighter bound on the half of those that were **promised**.
 *
 * A refusal where the client's own `resolveTake` came back with the identity is
 * the reported failure exactly: the HUD offers the car and `E` does nothing.
 * Measured at 0 to 2 per two-hundred-press sweep, and every one examined was a
 * tick's worth of the timetable between the two calls -- `clientWouldTake` reads
 * `Date.now()` and `tryTakeCar` reads it again inside the step, and a `TRAFFIC_HZ`
 * tick is 16.7 ms. Two is the bound; a run of them means the two ends are asking
 * genuinely different questions, which is what `coverBays` was.
 */
say(`  ${promised} of those refusals were cars the client would have promised`);
if (promised > Math.max(2, took * 0.02)) {
  fail(
    `${promised} presses were refused at a car the client's own \`resolveTake\` offered. That is the ` +
      `reported bug's shape -- the HUD promises a car and \`E\` does nothing -- and it is more than a ` +
      `tick of the timetable between the prompt and the press.`,
  );
}

// ---------------------------------------------------------------------------
// 5. Online: the predicted take, the wire, and the correction that follows it.
// ---------------------------------------------------------------------------

/**
 * `integration-check.FakeSocket`: a `Socket` that keeps every frame instead of
 * sending it, so the real send path runs -- the real AOI selection, the real
 * frame grouping, the real pooled encoder -- with nothing underneath it. The
 * frames are **copied** out of the room's pooled buffers rather than referenced,
 * for the reason stated there: the room patches two bytes between sends.
 */
class HeldSocket {
  readonly frames: ArrayBuffer[] = [];
  closed = '';
  constructor(readonly data: Conn) {}
  send(data: ArrayBuffer | Uint8Array): number {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.frames.push(bytes.slice().buffer as ArrayBuffer);
    return bytes.byteLength;
  }
  close(_code?: number, reason?: string): void { this.closed = reason ?? 'closed'; }
  readonly pings: Uint8Array[] = [];
  ping(data?: string | ArrayBuffer | Uint8Array): number {
    if (data === undefined || typeof data === 'string') return 0;
    const b = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.pings.push(b.slice());
    return b.byteLength;
  }
}

function runOnline(
  shared: ServerWorld,
  subject: Candidate,
  /**
   * WORKSTREAM S: the client's own parked fleet, for the prediction below.
   *
   * Null keeps section 5 exactly as it was -- a schedule car, no statics -- and
   * section 7 passes `clientStatics` so that the *predicted* take is a parked car
   * and the record the server allocates has to be the same one.
   */
  statics: StaticCarField | null = null,
): void {
  const room = new Room(0, shared, 8, 0);
  const FIXED_DT = 1 / TICK_HZ;

  let socket: HeldSocket | null = null;
  let participant: Participant | null = null;
  const toServer: ArrayBuffer[] = [];
  const transport: NetTransport = {
    open: true, onframe: null, onopen: null, onclose: null,
    send(f: ArrayBuffer): void { toServer.push(f); },
    close(): void {},
  };
  const net = new NetClient('', {
    onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {}, onJoin: () => {},
    onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
  }, { name: 'thief', transport });
  transport.onopen?.();

  const pump = (): void => {
    for (const f of toServer.splice(0)) {
      if (frameType(f) === MSG.HELLO && participant === null) {
        socket = new HeldSocket(newConn(0));
        participant = room.join(socket.data, 0, 'thief');
        if (participant !== null) {
          room.conns.add(socket as unknown as Socket);
          room.welcome(socket as unknown as Socket, participant);
        }
      } else if (frameType(f) === MSG.INPUT && socket !== null) {
        receiveInput(socket.data, f);
      }
    }
  };
  const drain = (): void => {
    if (socket === null) return;
    for (const f of socket.frames.splice(0)) transport.onframe?.(f);
  };

  /**
   * The client's own body, **with combatant id 0**, which is what `main.ts`
   * does: `createCombatant(0, ...)` and nothing ever renames it, online or off.
   * That matters here and nowhere else -- 0 is also `CarField`'s "nobody is in
   * it" sentinel, so the record the prediction mints is briefly an *abandoned*
   * one, and whether that survives the adoption is precisely what this section
   * is for. `CarField.follow`'s header carries the same trap from the other
   * side.
   */
  const local = createCombatant(0, shared.spawn.x, shared.spawn.z);
  const correction = local.body.velocity.clone();
  const input: CombatInput = {
    forward: 0, right: 0, jump: false, sprint: false,
    yaw: subject.yaw, pitch: 0, punch: false, throwBall: false, mount: false,
  };

  /** `main.ts`'s fixed step, minus the presentation: reconcile, step, send. */
  const clientTick = (): void => {
    net.reconcile(local, combatWorld, correction);
    advance(local, input, FIXED_DT, combatWorld);
    net.sendInput(input, local.body.velocity);
  };
  const roomTick = (): void => {
    pump();
    room.step();
    drain();
  };

  // The handshake, then a moment of standing still: `INPUT_RESERVE` deliberately
  // holds the first frame back, and the first snapshot has to arrive before the
  // client's body means anything.
  clientTick();
  roomTick();
  if (participant === null) {
    fail('Online: the loopback client could not join the room.');
    return;
  }
  const p: Participant = participant;

  // --- Placed by the SERVER, which is the only end allowed to place anybody. A
  //     harness that moved its own body would be testing a teleport the server
  //     refuses -- `checkRidingOnline`'s rule, and `sydney.cars.stand()` says
  //     the same thing to the console.
  const at = standBeside(subject, 1);
  room.sim.placeAt(p, at.x, subject.groundY + EYE_HEIGHT, at.z, subject.yaw);
  for (let i = 0; i < 20; i++) {
    clientTick();
    roomTick();
  }
  const drift = Math.hypot(
    local.body.position.x - p.combat.body.position.x,
    local.body.position.z - p.combat.body.position.z,
  );
  if (drift > 1) {
    fail(`Online: reconciliation left the client ${drift.toFixed(2)} m from the server before the press.`);
    return;
  }

  // --- The press, exactly as `main.ts.predictTakeCar` runs it: an empty record
  //     within reach first, then one off the timetable, against `net.cars` --
  //     which is the mirror `carWorld()` hands the browser online.
  const cars = net.cars;
  const feet = local.body.position.y - EYE_HEIGHT;
  const scratch = createDrivingScratch();
  let predictedId = 0;
  for (const car of cars.all()) {
    if (car.driverId !== 0) continue;
    const dy = car.y - feet;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
    const dx = car.x - local.body.position.x;
    const dz = car.z - local.body.position.z;
    if (dx * dx + dz * dz <= TAKE_RADIUS * TAKE_RADIUS) {
      predictedId = car.id;
      break;
    }
  }
  if (predictedId === 0) {
    const offered = resolveTake(
      shared.traffic,
      local.body.position.x,
      feet,
      local.body.position.z,
      trafficTick(Date.now()),
      scratch.routes,
      scratch.pose,
      (identity) => cars.suppressed(identity),
      scratch.take,
      statics,
    );
    if (!offered) {
      fail('Online: the client would not have offered the take at all, so there was nothing to predict.');
      return;
    }
    const minted = cars.take(scratch.take, local.id);
    if (minted === null) {
      fail('Online: the client mirror refused its own predicted take.');
      return;
    }
    predictedId = minted.id;
  }
  local.drivingCar = predictedId;
  local.carSpeed = 0;
  net.predictedCarChange();

  // The bit rides on the very next `INPUT`, which is what `predictedCarChange`'s
  // `seq + 1` means. One tick down, one tick up: the server takes the edge.
  input.mount = true;
  clientTick();
  roomTick();
  input.mount = false;

  // --- A second of ticks. The `CARS` frame arrives inside the first few and the
  //     adoption gate opens as soon as the press is acknowledged. If the two
  //     ends disagree about the record, this is where the driver is put back on
  //     the footpath.
  let serverCarId = 0;
  for (let i = 0; i < TICK_HZ; i++) {
    clientTick();
    roomTick();
    if (serverCarId === 0) serverCarId = p.combat.drivingCar;
  }

  const mirrored = net.cars.carOf(net.id);
  say(
    `  client id ${net.id}: predicted record ${predictedId}, server granted ${serverCarId}, ` +
      `mirror ${mirrored}, client thinks it is driving ${local.drivingCar} after ${TICK_HZ} ticks`,
  );
  if (serverCarId === 0) {
    fail('Online: the server never put the client in a car, though the client offered the prompt.');
    return;
  }
  if (predictedId !== serverCarId) {
    fail(
      `Online: the client predicted record ${predictedId} and the server allocated ${serverCarId}. ` +
        `The prediction is a phantom nothing will correct -- \`CarField.adopt\` keeps the mirror's ` +
        `allocator ahead of the authority's precisely to stop this.`,
    );
  }
  if (local.drivingCar !== serverCarId) {
    fail(
      `Online: a second after the press the client thinks it is driving ${local.drivingCar} and the ` +
        `server says ${serverCarId}. This is the snap-back: \`carPredictedAt\` opened and \`serverCar\` ` +
        `disagreed, which on a real client is the player standing on the footpath again.`,
    );
  }
  if (mirrored !== serverCarId) {
    fail(
      `Online: the mirror says this player is in ${mirrored} where the server says ${serverCarId}. ` +
        `\`MSG.CARS\` and \`CarField.carOf\` disagree about who is driving what.`,
    );
  }

  // And it drives, through the wire, with the server integrating the same
  // `stepCarSpeed` off the same buttons.
  const fromX = p.combat.body.position.x;
  const fromZ = p.combat.body.position.z;
  input.forward = 1;
  for (let i = 0; i < TICK_HZ; i++) {
    clientTick();
    roomTick();
  }
  input.forward = 0;
  const moved = Math.hypot(p.combat.body.position.x - fromX, p.combat.body.position.z - fromZ);
  const clientMoved = Math.hypot(local.body.position.x - fromX, local.body.position.z - fromZ);
  say(`  a second of throttle over the wire: server moved ${moved.toFixed(1)} m, client ${clientMoved.toFixed(1)} m`);
  if (moved < 2) {
    fail(`Online: a second of throttle in a stolen car moved the server's body ${moved.toFixed(2)} m.`);
  }
  if (Math.abs(moved - clientMoved) > 3) {
    fail(
      `Online: the client drove ${clientMoved.toFixed(1)} m where the server drove ${moved.toFixed(1)} m. ` +
        `The prediction and the authority are not integrating the same car.`,
    );
  }
  net.close();
}

say('--- 5. online: the predicted take against the wire');
const onlineSubject = candidates.find(reachable);
if (onlineSubject === undefined) {
  fail('Nothing takeable to drive the online section with.');
} else {
  runOnline(world, onlineSubject);
}


// ---------------------------------------------------------------------------
// 6. WORKSTREAM S: a car out of `.cars.bin`, which is the car a player actually
//    walks up to.
//
// The whole reported bug in one section. Everything above this line was already
// green when the owner said *"i also seem to no longer be able to steal cars"*,
// because everything above this line presses `E` at a **schedule** car -- one of
// about forty within reach against 23,020 identical parked ones that answered
// nothing. Six claims, in the order they fail:
//
//   1. The two ends name the same car. Asked of a separately decoded field with
//      its own ground closure; see `clientStatics`.
//   2. `E` grants it, and the record carries the static identity.
//   3. It drives. "Taken but not drivable is the same bug wearing a hat."
//   4. The identity survives `MSG.CARS` intact. `staticCarIdentity` uses the full
//      32-bit range where `traffic.carHash` in practice does too, and the record
//      field is a `u32` -- this is the assertion behind "the wire needed no
//      change", and a `u16` there would truncate 65,535 of every 65,536 cars into
//      one identity and suppress the wrong car on every client in the room.
//   5. Out and back in, which is `nearestEmptyCar` rather than `resolveTake`.
//   6. **It comes back.** Removing the record is the whole of putting a static car
//      back at its kerb -- there is no state, only the suppression -- and this is
//      the assertion that `recycleFarthest` returns the city to itself.
//
// No refusal budget and no `repose` staleness: a parked car is furniture and
// cannot have driven off between the census and the press. That is why this
// section asserts equality where section 4 has to bound a rate.
// ---------------------------------------------------------------------------

say('--- 6. a car out of `.cars.bin` (workstream S)');

/** Every parked car near a point, as candidates, nearest first. */
function staticCandidates(cx: number, cz: number, radius: number, cap: number): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<number>();
  clientStatics.forEachStaticNear(cx, 0, cz, radius, (car: StaticCarPose) => {
    if (out.length >= cap || seen.has(car.identity)) return;
    seen.add(car.identity);
    const c: Candidate = {
      identity: car.identity,
      x: car.x,
      y: car.y,
      z: car.z,
      yaw: car.yaw,
      speed: 0,
      // A parked car is in a bay by definition, so it is filed as the stage
      // everything downstream treats a kerbed car as. `CarPose.stage` is not a
      // thing a static car has; this is the label, and `isStatic` is the fact.
      stage: CAR_STAGE_PARKED_IN,
      laneEdge: false,
      groundY: 0,
      isStatic: true,
    };
    const at = standBeside(c, 1);
    c.groundY = ground.groundHeight(at.x, at.z, c.y);
    out.push(c);
  });
  out.sort((a, b) => a.identity - b.identity);
  return out;
}

const staticPool: Candidate[] = [];
for (const [cx, cz, name] of centres) {
  const before = staticPool.length;
  const found = staticCandidates(cx, cz, 300, 400);
  for (const c of found) {
    if (!reachable(c)) continue;
    // A car the *server* cannot see is not this section's subject: the server's
    // residency is capped, so a hexagon out past the cap holds no cars and `E`
    // would correctly do nothing. Section 1's census has the same shape of
    // filter for lanes; this is the parked fleet's.
    let serverSees = false;
    const at = standBeside(c, 1);
    world.staticCars?.forEachStaticNear(at.x, c.groundY, at.z, TAKE_RADIUS, (s) => {
      if (s.identity === c.identity) serverSees = true;
    });
    if (!serverSees) continue;
    staticPool.push(c);
  }
  say(`  ${name}: ${staticPool.length - before} parked car(s) both ends can see and a player can reach`);
}

if (staticPool.length === 0) {
  fail(
    'Not one parked car near any of the four centres is visible to both ends on reachable ground. ' +
      'Either `tiles/*.cars.bin` is absent, or the server residency has not loaded a hexagon anybody ' +
      'is standing in, and no parked car in Sydney is stealable.',
  );
} else {
  const subject = staticPool[0];

  // --- (1) The two ends, at the same instant, off two decodes of one file.
  const at = standBeside(subject, 1);
  place(player, at, subject.groundY, subject.yaw);
  const feet = player.combat.body.position.y - EYE_HEIGHT;
  const predicted = clientWouldTake(at.x, feet, at.z);
  if (predicted !== subject.identity) {
    fail(
      `static: the client's own decode named ${predicted} where it is standing beside ${subject.identity}, ` +
        `${Math.hypot(subject.x - at.x, subject.z - at.z).toFixed(2)} m away with dy ` +
        `${(subject.y - feet).toFixed(2)}. Two decodes of one \`.cars.bin\` disagree, or a schedule car ` +
        'is nearer -- either way the HUD and the authority are asking different questions.',
    );
  }

  // --- (2) The press, and the record.
  pressE(player);
  const carId = player.combat.drivingCar;
  if (carId === 0) {
    fail(
      `static: pressing E beside parked car ${subject.identity} did not put the player in a car ` +
        `(range ${Math.hypot(subject.x - at.x, subject.z - at.z).toFixed(2)} m, dy ` +
        `${(subject.y - feet).toFixed(2)}). This is the reported bug.`,
    );
  } else {
    const record = sim.carRecords().find((r) => r.id === carId);
    if (!record) {
      fail(`static: \`drivingCar\` is ${carId} and there is no such record on the wire.`);
    } else {
      if (record.carId !== subject.identity) {
        fail(`static: took identity ${record.carId} while standing beside ${subject.identity}.`);
      }
      // --- (4) The identity through `MSG.CARS`, which is the "no protocol bump"
      //     claim as an assertion rather than as a comment.
      const wire = decodeCarsWire(encodeCars([record]));
      if (wire === null || wire.cars.length !== 1) {
        fail('static: a `CARS` frame carrying a parked car did not decode at all.');
      } else if (wire.cars[0].carId !== subject.identity) {
        fail(
          `static: identity ${subject.identity} came back off the wire as ${wire.cars[0].carId}. ` +
            '`CarRecord.carId` must carry the full `staticCarIdentity` u32 range or suppression names ' +
            'the wrong car on every client in the room.',
        );
      }
      if (!sim.cars.suppressed(subject.identity)) {
        fail(
          'static: the stolen car is not suppressed, so its box is still parked at the kerb and the ' +
            'traffic still steers round it. There are two of it.',
        );
      }
      // --- (3) And it drives.
      const fromX = record.x;
      const fromZ = record.z;
      player.input.forward = 1;
      for (let i = 0; i < TICK_HZ; i++) sim.step(out);
      player.input.forward = 0;
      const after = sim.cars.get(carId);
      const moved = after === undefined ? 0 : Math.hypot(after.x - fromX, after.z - fromZ);
      if (moved < 3) {
        fail(`static: a second of full throttle moved the parked car ${moved.toFixed(2)} m.`);
      }
      // --- (5) Out, and back in through the other branch of `tryTakeCar`.
      pressE(player);
      if (player.combat.drivingCar !== 0) fail('static: pressing E in the car did not get the player out.');
      if (sim.cars.get(carId) === undefined) fail('static: the car vanished when its driver got out.');
      pressE(player);
      if (player.combat.drivingCar !== carId) {
        fail(
          `static: pressing E beside the car just parked did not get back in ` +
            `(\`drivingCar\` is ${player.combat.drivingCar}, the record is ${carId}).`,
        );
      }
      say(`  identity ${subject.identity} -> record ${carId}, drove ${moved.toFixed(1)} m in a second, out and back in`);

      // --- (6) And it comes home. `recycleFarthest`'s own effect, forced.
      pressE(player);
      sim.cars.remove(carId);
      if (sim.cars.suppressed(subject.identity)) {
        fail('static: the identity is still suppressed after its record was recycled; the car never comes back.');
      }
      place(player, at, subject.groundY, subject.yaw);
      const backFeet = player.combat.body.position.y - EYE_HEIGHT;
      const again = clientWouldTake(at.x, backFeet, at.z);
      if (again !== subject.identity) {
        fail(
          `static: after the record was recycled the same standing point offers ${again} rather than ` +
            `${subject.identity}. A recycled parked car is supposed to be simply *there* again, in its ` +
            'bay, at the identity it always had -- there is no state to restore.',
        );
      }
      const probe = createStaticCarPose();
      if (!clientStatics.findStatic(subject.identity, backFeet, probe)) {
        fail('static: the recycled car is no longer in the field at all.');
      } else if (Math.abs(probe.x - subject.x) > 1e-3 || Math.abs(probe.z - subject.z) > 1e-3) {
        fail(
          `static: the recycled car is at (${probe.x.toFixed(2)}, ${probe.z.toFixed(2)}) where it was ` +
            `parked at (${subject.x.toFixed(2)}, ${subject.z.toFixed(2)}).`,
        );
      }
      say('  recycled: suppression cleared, the car is offered again from the same standing point');
    }
  }

  // --- The sweep, both flanks, and this one *can* assert zero refusals.
  //
  // Section 4's budget exists because the timetable moves between the prompt and
  // the press. Nothing here moves. So a refusal is a refusal, and the bound is
  // the two things that are honestly not this feature's business: a lime bike
  // answered first (`bikeAnswersFirst`), or a *schedule* car parked nearer than
  // the static one, which is the take working and picking the right car.
  const sweepStatics = staticPool.slice(0, Number(process.env.TAKE_STATIC_SWEEP ?? '60'));
  let sTook = 0;
  let sBike = 0;
  let sOther = 0;
  const sRefused: string[] = [];
  for (const c of sweepStatics) {
    for (const side of [1, -1]) {
      const stand = standBeside(c, side);
      place(player, stand, c.groundY, c.yaw);
      const f = player.combat.body.position.y - EYE_HEIGHT;
      if (bikeAnswersFirst(stand, f)) {
        sBike++;
        continue;
      }
      const want = clientWouldTake(stand.x, f, stand.z);
      pressE(player);
      const got = player.combat.drivingCar;
      if (got === 0) {
        sRefused.push(
          `identity ${c.identity} ${side > 0 ? 'kerb' : 'road'} flank, range ` +
            `${Math.hypot(c.x - stand.x, c.z - stand.z).toFixed(2)} m, dy ${(c.y - f).toFixed(2)}, ` +
            `client ${want === 0 ? 'also refused' : `offered ${want}`}`,
        );
        continue;
      }
      const rec = sim.carRecords().find((r) => r.id === got);
      if (rec && rec.carId !== c.identity) sOther++;
      else sTook++;
      pressE(player);
      sim.cars.remove(got);
    }
  }
  say(
    `  sweep: ${sTook} parked car(s) taken, ${sOther} presses answered by a nearer schedule car, ` +
      `${sBike} answered by a bike first, ${sRefused.length} refused`,
  );
  for (const r of sRefused.slice(0, 12)) say(`    refused: ${r}`);
  if (sRefused.length > 0) {
    fail(
      `${sRefused.length} of ${sTook + sOther + sRefused.length} presses beside a parked car were ` +
        'refused. Nothing about a parked car moves between the prompt and the press, so unlike ' +
        'section 4 this bound is zero: every one of these is the take refusing a car that is ' +
        'standing right there.',
    );
  }
  if (sTook === 0) {
    fail('The parked-car sweep granted nothing at all, so nothing above it was measured.');
  }
}

// ---------------------------------------------------------------------------
// 7. WORKSTREAM S online: a parked car, predicted, through the wire.
//
// Section 5's harness with a static subject, and it is not redundant with it.
// What section 5 covers is the *record* -- that the client's predicted id is the
// one the server allocates, and that the adoption does not snap the driver back
// onto the footpath. Both of those turn on the **identity** matching, and a
// parked car's identity comes from a different function, a different file and a
// different residency on each end. If the server's decode and the browser's
// disagreed by so much as a tile origin, section 6 would still pass (it compares
// two fields directly) and this would put the driver back on the kerb one round
// trip after every theft.
// ---------------------------------------------------------------------------

say('--- 7. online: a predicted parked-car take against the wire');
if (staticPool.length === 0) {
  say('  no parked car available; case not exercised this run.');
} else {
  // **The same car section 6 drove**, deliberately, and this is the one place in
  // this file where the subject is picked rather than swept.
  //
  // The reason is isolation. A parked car is wherever `parking.py` put it, and a
  // fair number of them are in spots a *player* cannot drive out of forward from
  // the flank they are standing on -- nose against a wall, on a driveway, up a
  // kerb -- which is a fact about that parking space and not about the wire. The
  // first attempt at this section took `staticPool[staticPool.length - 1]` and
  // failed with "a second of throttle moved the server's body 0.00 m" while every
  // other assertion in the section passed: the take was granted, the record ids
  // matched, the mirror agreed, and the car simply had nowhere to go.
  //
  // Section 6 has already proved this particular car drives 3 m offline, so a
  // failure here can only be the loopback -- which is the whole point of the
  // section. The parked fleet's *coverage* is section 6's sweep, which is eighty
  // cars from both flanks and asserts zero refusals.
  runOnline(world, staticPool[0], clientStatics);
}


if (failures.length === 0) {
  say('\ntake-check: OK');
  process.exit(0);
}
say(`\ntake-check: ${failures.length} failure(s)`);
for (const f of failures) say(`  - ${f}`);
process.exit(1);
