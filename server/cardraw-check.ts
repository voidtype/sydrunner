/**
 * Is the car you are driving still on screen three kilometres later?
 *
 * The owner, driving, 2026-08-24: *"car sometimes disappears then later
 * reappears while driving"*. He kept driving -- the ride was fine and the model
 * was gone -- and "later" turned out to mean "the next time something put the
 * record back on the wire".
 *
 * ---------------------------------------------------------------------------
 * WHY A DRIVER AND NOT A UNIT CHECK.
 *
 * Every part of this was individually correct. `CarField.follow` carries an
 * occupied car's pose on the server, tick by tick. `room.sendCars` broadcasts
 * *what changed*, and a car being driven in a straight line changes nothing
 * anybody has to be told -- that is the feature, and it is why driving costs no
 * bandwidth (`world/drivencars.ts` header). `DrivenCarView` derives an occupied
 * car's on-screen pose from its driver rather than from its record, for exactly
 * that reason. And the range gate that stops the draw loop posing four hundred
 * records spread over sixty kilometres asked about **the record**.
 *
 * Four true statements, and the bug is the seam between the third and the
 * fourth: the client's mirror of a car you are driving never moves, so the car
 * you are *in* leaves its own 460 m draw radius twenty-one seconds after you
 * take it, and comes back on the tick you hit something hard enough to put the
 * record back on the wire. No single unit could see it. What sees it is the
 * whole chain -- a real `Simulation`, the real `encodeCars`/`decodeCars`, a real
 * client-side `CarField` mirror fed only by what the wire carried, and the real
 * `DrivenCarView` over the top -- driven several kilometres in a straight line
 * and asked, every tick, whether the car is drawable.
 *
 *   bun run server/cardraw-check.ts
 *
 * Three sections, and the second and third are what stop the fix being "delete
 * the gate": a car whose driver this client cannot resolve is still gated on its
 * record, and four hundred parked records in Penrith still cost one subtract and
 * one compare each.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import type { ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { CarField, DRIVE_TOP_SPEED, MAX_DRIVEN_CARS } from '../client/src/game/driving.ts';
import { DRIVEN_DRAW_RADIUS, DrivenCarView, type DriverPose } from '../client/src/world/drivencars.ts';
import { decodeCars, encodeCars } from '../client/src/net/protocol.ts';

/** How far down the empty road section 1 drives. Metres. */
const DRIVE_M = 3000;

/**
 * How close the drawn car has to be to the driver in it. Metres.
 *
 * Generous on purpose: what is being asserted is *which* position the pose came
 * from, and the two candidates are a metre apart at worst and three kilometres
 * apart at best. Anything inside this is "the pose followed the driver".
 */
const AT_DRIVER_M = 1;

/** A flat, empty, wall-less world. `cardamage-check.emptyWorld` with the wall out. */
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

/** Put a body on the road at the origin, facing -Z, with its history seeded. */
function place(sim: Simulation, p: Participant, z: number): void {
  p.combat.body.position.set(0, EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = 0;
  p.input.yaw = 0;
  p.combat.carSpeed = 0;
  p.history.seed(sim.tick, 0, EYE_HEIGHT, z, 0);
}

/**
 * === 1. The owner's drive. Three kilometres of straight road, and the car has
 *        to be on screen for all of it.
 *
 * The client half is deliberately built out of the same three pieces the browser
 * builds it out of and nothing else: a `CarField` that has only ever been
 * written by `decodeCars`, a `DrivenCarView` over it, and a `near` predicate
 * that is `DRIVEN_DRAW_RADIUS` around the local body. If the browser can see the
 * car, this can; if this can, so can the browser.
 */
function runDrive(): string[] {
  const failures: string[] = [];
  const sim = new Simulation(emptyWorld());
  const p = sim.join(0, null);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };

  place(sim, p, 0);
  // By hand, on `cardamage-check`'s argument: this world has no lane sidecar for
  // `tryTakeCar` to find a car in, and what is being exercised is the *drawing*,
  // not the theft. `CarField.take` is the call `tryTakeCar` makes.
  const taken = sim.cars.take(
    { identity: 0xd12ea1, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    p.combat.id,
  )!;
  p.combat.drivingCar = taken.id;

  // --- The client. Nothing in here may read `sim.cars`; the wire is the only
  //     way anything gets in, which is the whole point.
  const mirror = new CarField();
  let carFrames = 0;
  /**
   * One `MSG.CARS` frame, or none. `full` is the joiner's roster
   * (`room.ts`'s `encodeCars(carRecords(), true)`); everything else is
   * `sendCars`' delta, which is *what changed this tick* and is the reason the
   * record under a moving car never moves.
   */
  const pump = (full = false): void => {
    const records = full ? sim.carRecords() : sim.carDelta();
    if (records.length === 0) return;
    const message = decodeCars(encodeCars(records, full));
    if (!message) return;
    carFrames++;
    if (message.full) mirror.clear();
    for (const r of message.cars) {
      if (r.removed) {
        mirror.remove(r.id);
        continue;
      }
      mirror.adopt({
        id: r.id, carId: r.carId, body: r.body, colour: r.colour,
        x: r.x, y: r.y, z: r.z, yaw: r.yaw, speed: r.speed,
        driverId: r.driver, health: r.health, fuse: r.fuse,
      });
    }
  };
  // The eye. `main.ts` poses the local car off the *predicted* body; here that
  // is the participant's own, which is the same number one tick earlier.
  const eye = { x: 0, z: 0 };
  const view = new DrivenCarView(
    () => mirror,
    (driverId: number, o: DriverPose): boolean => {
      if (driverId === -1 || driverId === p.combat.id) {
        o.x = p.combat.body.position.x;
        o.y = p.combat.body.position.y - EYE_HEIGHT;
        o.z = p.combat.body.position.z;
        o.yaw = p.combat.body.yaw;
        return true;
      }
      return false;
    },
    // What the browser knows: the record id the server says this client is in.
    () => mirror.carOf(p.combat.id),
    (x, z) => {
      const dx = x - eye.x;
      const dz = z - eye.z;
      return dx * dx + dz * dz < DRIVEN_DRAW_RADIUS * DRIVEN_DRAW_RADIUS;
    },
  );

  // The joiner's roster, which is how a client learns about a car it did not
  // take itself -- and here how it learns about one taken by hand. After this
  // line the mirror is only ever written by `sendCars`' delta.
  pump(true);
  sim.step(out);
  pump();
  if (mirror.carOf(p.combat.id) === 0) {
    failures.push('The client mirror never learned which car the driver is in; the rest of this section is meaningless.');
    return failures;
  }

  console.log('--- three kilometres in a straight line, drawn through the real mirror');
  p.input.forward = 1;
  let missingFrom = -1;
  let missingTo = -1;
  let gaps = 0;
  let wasDrawn = true;
  let offDriver = -1;
  let ticks = 0;
  const cap = 20000;
  while (Math.abs(p.combat.body.position.z) < DRIVE_M && ticks < cap) {
    sim.step(out);
    pump();
    ticks++;
    eye.x = p.combat.body.position.x;
    eye.z = p.combat.body.position.z;
    let drawn = false;
    let px = 0;
    let pz = 0;
    view.source.forEach((pose) => {
      if (pose.identity !== taken.carId) return;
      drawn = true;
      px = pose.x;
      pz = pose.z;
    });
    const travelled = Math.abs(p.combat.body.position.z);
    if (!drawn) {
      if (wasDrawn) gaps++;
      if (missingFrom < 0) missingFrom = travelled;
      missingTo = travelled;
    } else {
      const dx = px - p.combat.body.position.x;
      const dz = pz - p.combat.body.position.z;
      if (offDriver < 0 && dx * dx + dz * dz > AT_DRIVER_M * AT_DRIVER_M) offDriver = travelled;
    }
    wasDrawn = drawn;
  }
  p.input.forward = 0;

  const record = mirror.get(taken.id)!;
  const drift = Math.abs(record.z - p.combat.body.position.z);
  console.log(
    `  drove ${Math.abs(p.combat.body.position.z).toFixed(0)} m in ${ticks} ticks at up to ` +
      `${DRIVE_TOP_SPEED} m/s; ${carFrames} CARS frame(s) arrived; the mirror's record is still at ` +
      `z = ${record.z.toFixed(1)}, ${drift.toFixed(0)} m behind the car`,
  );
  console.log(
    missingFrom < 0
      ? '  the car was drawn on every tick of the drive'
      : `  the car was MISSING over ${missingFrom.toFixed(0)}..${missingTo.toFixed(0)} m (${gaps} gap(s))`,
  );

  if (ticks >= cap) failures.push(`The car never covered ${DRIVE_M} m in ${cap} ticks. Something stopped it.`);
  if (missingFrom >= 0) {
    failures.push(
      `The car the player is in stopped being drawn after ${missingFrom.toFixed(0)} m and was missing until ` +
        `${missingTo.toFixed(0)} m. The player is still driving it. This is the owner's report: the range gate is ` +
        `being asked about the record's parked position rather than about where the car is drawn.`,
    );
  }
  if (offDriver >= 0) {
    failures.push(
      `At ${offDriver.toFixed(0)} m the car was drawn more than ${AT_DRIVER_M} m from its driver -- it is being ` +
        'posed from the record rather than from the body.',
    );
  }
  // **The teeth.** If the wire ever started carrying the moving car, the two
  // assertions above would pass for a reason that has nothing to do with the
  // fix -- and the feature's zero-bandwidth claim would be gone with it. So the
  // staleness the fix is built on is asserted, not assumed.
  if (drift < DRIVE_M * 0.5) {
    failures.push(
      `The mirror's record followed the car to within ${drift.toFixed(0)} m of the driver, so this section is no ` +
        'longer measuring anything: an occupied car is meant to cost no bandwidth (`room.sendCars` broadcasts only ' +
        'what changed) and the draw path is meant to derive its pose from the driver. One of those two changed.',
    );
  }
  return failures;
}

/**
 * === 2. Somebody else's car, and the two answers that are both right.
 *
 * A remote driver this client can see is a car that has to be drawn *at them*
 * however far their record has been left behind -- the passenger's half of
 * section 1, and the case `DrivenCarView`'s header calls "a remote driver's car
 * comes from their interpolated position".
 *
 * A remote driver this client **cannot** see is the case the gate exists for,
 * and the answer there is still the record: it is the only position anybody has,
 * and a car 2 km away must not be posed just because somebody is sitting in it.
 */
function runRemote(): string[] {
  const failures: string[] = [];
  const mirror = new CarField();
  // Two records taken at the same kerb, one driver each.
  const near = mirror.take({ identity: 0xbee1, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 11)!;
  const far = mirror.take({ identity: 0xbee2, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 12)!;
  // Where the two drivers actually are. 11 is beside me; 12 is across the city.
  const bodies = new Map<number, { x: number; z: number }>([
    [11, { x: 0, z: -DRIVE_M }],
    [12, { x: 0, z: -20000 }],
  ]);
  const eye = { x: 0, z: -DRIVE_M };
  /** How many times the walk reached for a driver. Section 3 reads it too. */
  let lookups = 0;
  const view = new DrivenCarView(
    () => mirror,
    (driverId: number, o: DriverPose): boolean => {
      lookups++;
      const body = bodies.get(driverId);
      // The interest set, which is what `net.remotes` is: a driver 20 km away is
      // not in it, and this end has nothing to say about where they are.
      if (!body) return false;
      const dx = body.x - eye.x;
      const dz = body.z - eye.z;
      if (dx * dx + dz * dz > 260 * 260) return false;
      o.x = body.x;
      o.y = 0;
      o.z = body.z;
      o.yaw = 0;
      return true;
    },
    () => 0,
    (x, z) => {
      const dx = x - eye.x;
      const dz = z - eye.z;
      return dx * dx + dz * dz < DRIVEN_DRAW_RADIUS * DRIVEN_DRAW_RADIUS;
    },
  );

  const posed = new Map<number, { x: number; z: number }>();
  view.source.forEach((pose) => posed.set(pose.identity, { x: pose.x, z: pose.z }));
  console.log(`--- a remote driver beside you and one across town: ${posed.size} car(s) posed`);

  const beside = posed.get(near.carId);
  if (!beside) {
    failures.push(
      'A remote driver standing beside you, 3 km from the kerb their car was taken at, was not drawn. Their car ' +
        'is being gated on its record.',
    );
  } else if (Math.abs(beside.z - -DRIVE_M) > AT_DRIVER_M) {
    failures.push(`A visible remote's car was drawn at z = ${beside.z.toFixed(0)} rather than at its driver.`);
  }
  if (posed.has(far.carId)) {
    failures.push(
      'A car whose driver is 20 km away and outside the interest set was posed anyway. The gate has been deleted ' +
        'rather than re-centred: the fallback for a driver this client cannot resolve is still the record.',
    );
  }
  if (lookups > 2) failures.push(`Two occupied records cost ${lookups} driver lookups; it is one each.`);
  return failures;
}

/**
 * === 3. The budget the gate was written for, which the fix must not spend.
 *
 * `MAX_DRIVEN_CARS` records scattered over sixty kilometres of Sydney, one of
 * them under the player. Only the ones actually in range may be posed, and a
 * *parked* record must not cost a driver lookup -- that is the whole reason the
 * resolve is on the occupied branch rather than in front of the loop.
 */
function runBudget(): string[] {
  const failures: string[] = [];
  const mirror = new CarField();
  const eye = { x: 0, z: 0 };
  let inRange = 0;
  for (let i = 0; i < MAX_DRIVEN_CARS; i++) {
    // A ring road out to 30 km, thirty of them inside the radius.
    const z = -i * 75;
    mirror.adopt({
      id: i + 1, carId: 0xf00000 + i, body: 0, colour: 0,
      x: 0, y: 0, z, yaw: 0, speed: 0, driverId: 0,
    });
    if (z * z < DRIVEN_DRAW_RADIUS * DRIVEN_DRAW_RADIUS) inRange++;
  }
  let lookups = 0;
  const view = new DrivenCarView(
    () => mirror,
    (_id: number, _o: DriverPose): boolean => {
      lookups++;
      return false;
    },
    () => 0,
    (x, z) => {
      const dx = x - eye.x;
      const dz = z - eye.z;
      return dx * dx + dz * dz < DRIVEN_DRAW_RADIUS * DRIVEN_DRAW_RADIUS;
    },
  );
  let posed = 0;
  view.source.forEach(() => posed++);
  console.log(`--- ${MAX_DRIVEN_CARS} parked records over 30 km: ${posed} posed, ${lookups} driver lookup(s)`);
  if (posed !== inRange) {
    failures.push(`${posed} of ${MAX_DRIVEN_CARS} parked records were posed; ${inRange} are inside the radius.`);
  }
  if (lookups !== 0) {
    failures.push(
      `${lookups} driver lookups for ${MAX_DRIVEN_CARS} cars nobody is in. A parked record is meant to cost one ` +
        'subtract and one compare.',
    );
  }
  return failures;
}

function main(): number {
  const failures = [...runDrive(), ...runRemote(), ...runBudget()];
  if (failures.length === 0) {
    console.log('\ncardraw-check: OK');
    return 0;
  }
  console.log(`\ncardraw-check: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exit(main());
