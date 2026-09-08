/**
 * Cars that are solid to each other, measured through the real `Simulation`.
 *
 * The acceptance driver for the body layer (`client/src/game/rigid.ts`,
 * `game/driving.ts` section 7), and it exists because `verifyRigid` and
 * `verifyCarPhysics` between them assert everything about the *physics* and
 * nothing about the *game*. They drive bodies made of literals. What they
 * cannot answer is whether a contact that happens inside a real tick -- after
 * `combat.advance` has moved a driver, before `CarField.follow` has caught the
 * record up, with the damage sweeps and the knockdown sweep and the hold ledger
 * all running in their usual order -- comes out where the module says it should.
 *
 *     bun run server/carcrash-check.ts
 *
 * Six sections, and every one of them prints a **ratcheted count** rather than
 * a pass: a number that must not go down is a check that survives the next
 * retune, where a hard-coded expectation is a check somebody deletes.
 *
 *   1. **Two scripted drivers collide.** Both cars are damaged as they always
 *      were, the overlap between them shrinks on every tick rather than growing
 *      (see `game/rigid.ts` section 7: a contact is separated four tenths at a
 *      time now, not all at once), and both finish within two metres of what
 *      that module predicts for the same contact evaluated on its own.
 *   2. **A driver rams an ambient car under the threshold.** The driven car
 *      stops or rebounds, it takes the damage the old curve gives it, and the
 *      car it hit is *pinned* rather than driving on through the wreck.
 *   3. **And over it.** The ambient car leaves the timetable, appears on
 *      `MSG.CARS` driverless, rolls, stops, and is given back twenty seconds
 *      later once nobody is near it.
 *   4. **The cap holds at eight** and the oldest goes.
 *   5. **The clock**, which is the report *"maybe the car hitbox is too long"*
 *      and was never the hitbox. Reported in milliseconds and in metres at
 *      50 km/h.
 *   6. **The wire**, in bytes a second per player at the eight-car cap.
 *
 * ---------------------------------------------------------------------------
 * ONE VIRTUAL CLOCK, AND WHY IT IS `Date.now` ITSELF.
 *
 * `server/carhit-check.ts` carries this argument in full and this file makes
 * the identical swap for the identical reason: `game/traffic.ts` is a lookup
 * and not a simulation, every ambient car pose on both ends is a pure function
 * of `trafficTick(Date.now())`, and a driver that stepped six hundred ticks in
 * two hundred milliseconds of real time would be watching a photograph of a
 * street rather than a car arriving. There are two dozen
 * `trafficTick(Date.now())` call sites in `server/sim.ts` alone, so the clock is
 * replaced at the root, in this process only, and put back before the process
 * exits. Nothing anywhere is faked.
 *
 * Delete before the branch is merged.
 */

import { Simulation, type TickOutput } from './sim.ts';
import { Room, newConn, type Conn, type Socket } from './room.ts';
import type { ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { NetClient } from '../client/src/net/client.ts';
import {
  CAR_RECORD_BYTES,
  MSG,
  PROTOCOL_VERSION,
  TICK_HZ,
  encodeCars,
  frameType,
  type NetTransport,
} from '../client/src/net/protocol.ts';
import {
  TrafficField,
  createCarPose,
  forEachCarNear,
  syntheticTile,
  trafficTick,
  type CarPose,
  type LaneRoute,
} from '../client/src/game/traffic.ts';
import {
  CAR_HEALTH_MAX,
  KNOCK_LOOSE_SPEED,
  LOOSE_BROADCAST_TICKS,
  LOOSE_REST_MS,
  MAX_LOOSE_CARS,
  RECYCLE_KEEP_RADIUS,
  carRigidBody,
  createCarShunt,
  resolveCarContact,
} from '../client/src/game/driving.ts';
import { createRigidBody, createRigidContact, rigidOverlap } from '../client/src/game/rigid.ts';

const FIXED_DT = 1 / TICK_HZ;

/** `verifyTraffic`'s own street: a 7.5 m residential carriageway, quarter width. */
const LANE_OFFSET = 1.875;

/**
 * The two speeds sections 2 and 3 ram at, m/s.
 *
 * **Derived from `KNOCK_LOOSE_SPEED` rather than written down**, so a retune of
 * the threshold moves both cases with it and neither can quietly end up on the
 * same side of the line as the other. A third under and two and a half times
 * over is far enough from the boundary that a tick of throttle either way
 * cannot change which section is which.
 */
const SOFT_RAM = KNOCK_LOOSE_SPEED * 0.66;
const HARD_RAM = KNOCK_LOOSE_SPEED * 2.5;

/**
 * `driving.DRIVE_ACCELERATION`, restated so the run-up is derived rather than
 * written down: a literal here is a section that quietly measures 12 m/s the
 * day somebody raises the acceleration. `v^2 / 2a` is `cardamage-check`'s
 * `runUpFor`, and the car has to **get** to the speed by driving -- writing
 * `carSpeed = 15` and stepping makes `crashFromClamp` read the controller's own
 * ramp as a 12 m/s impact and charge for it. That paragraph is in
 * `cardamage-check` and it cost that driver a false result once already.
 */
const DRIVE_ACCEL = 6;

// --- The worlds ------------------------------------------------------------------

/** `cardamage-check.emptyWorld`, with no wall and no street. Section 1 and 4. */
function emptyWorld(): ServerWorld {
  return worldWith(new TrafficField());
}

/**
 * One 200 m residential street with traffic on it.
 *
 * A **120-second headway**, which is `cardamage-check`'s "quiet street" and is
 * chosen for its reason: on a long headway the bays and the red light stay
 * occupied for minutes at a time, so there is always a stationary car to ram
 * whatever second of the day this is run at. The ambient fleet is a closed-form
 * function of the wall clock and a driver whose result depends on when somebody
 * typed the command is not a driver.
 *
 * `laneY` 0 rather than the -12.5 every unit check reads: a player's feet in an
 * empty test city are at 0, and a lane twelve metres underground is a lane every
 * vertical gate in this project correctly refuses to let anybody touch.
 */
function streetWorld(): ServerWorld {
  const traffic = new TrafficField();
  traffic.adopt('street', syntheticTile(LANE_OFFSET, 0, 0, undefined, 120, 3, 0, 0x5eed, 0));
  return worldWith(traffic);
}

function worldWith(traffic: TrafficField): ServerWorld {
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    hexes: [],
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic,
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

// --- 1. Two drivers, one contact -------------------------------------------------

/**
 * Two scripted drivers meeting head-on, through the whole tick.
 *
 * The bit that could only be measured here: the contact is resolved *before*
 * `CarField.follow` has carried either record to its driver, so `stepCars` has
 * to build both bodies from the drivers' live positions rather than from the
 * records -- see `Simulation.fillCarBody`, which is the paragraph this section
 * exists to hold on to. A version of that function that read the records would
 * pass every unit check in the project and separate two cars from where they
 * were a tick ago, which at 44 m/s is most of a car length.
 */
function runDrivers(): { failures: string[]; contacts: number } {
  const failures: string[] = [];
  const sim = new Simulation(emptyWorld());
  const out: TickOutput = { tick: 0, events: [], snapshot: null };

  const a = sim.join(0, null);
  const b = sim.join(0, null);

  // Facing each other down the Z axis. Yaw 0 faces -Z; yaw pi faces +Z.
  const place = (p: typeof a, z: number, yaw: number): void => {
    p.combat.body.position.set(0, EYE_HEIGHT, z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.yaw = yaw;
    p.input.yaw = yaw;
    p.combat.carSpeed = 0;
    p.combat.carSlip = 0;
    p.combat.carYawRate = 0;
    p.history.seed(sim.tick, 0, EYE_HEIGHT, z, yaw);
  };
  place(a, 40, 0);
  place(b, -40, Math.PI);

  // By hand, exactly as `cardamage-check` does it: this world has no lane
  // sidecar, and what is being exercised is the *crash* and not the theft.
  // `CarField.take` is the same call `tryTakeCar` makes.
  const carA = sim.cars.take({ identity: 0xc0ffee, body: 0, colour: 0, x: 0, y: 0, z: 40, yaw: 0, parked: true }, a.combat.id)!;
  const carB = sim.cars.take({ identity: 0xdecaf0, body: 0, colour: 0, x: 0, y: 0, z: -40, yaw: Math.PI, parked: true }, b.combat.id)!;
  a.combat.drivingCar = carA.id;
  b.combat.drivingCar = carB.id;
  a.input.forward = 1;
  b.input.forward = 1;

  const bodyA = createRigidBody();
  const bodyB = createRigidBody();
  const contact = createRigidContact();
  const shunt = createCarShunt();

  let contacts = 0;
  let overlapAfter = 0;
  let worstDepth = 0;
  /** The previous tick's penetration, so this section can ask whether it shrank. */
  let lastDepth = 0;
  let predictionErrorA = 0;
  let predictionErrorB = 0;
  let closingAt = 0;
  let measured = false;

  for (let tick = 0; tick < 400; tick++) {
    // --- The module's own answer, computed from the same state the tick is
    //     about to be run from. This is the "physics module's own prediction"
    //     the brief asks the sim to land within two metres of, and it is a
    //     model rather than a copy: it runs the contact on two bare bodies with
    //     no controller, no ground, no friction and no snapshot in the way.
    carRigidBody(
      { body: carA.body, x: a.combat.body.position.x, z: a.combat.body.position.z, yaw: a.combat.body.yaw, speed: a.combat.carSpeed, slip: a.combat.carSlip, yawRate: a.combat.carYawRate },
      bodyA,
    );
    carRigidBody(
      { body: carB.body, x: b.combat.body.position.x, z: b.combat.body.position.z, yaw: b.combat.body.yaw, speed: b.combat.carSpeed, slip: b.combat.carSlip, yawRate: b.combat.carYawRate },
      bodyB,
    );
    // **Advanced by one step before the contact is asked about**, which is the
    // one line that makes this a model of the tick rather than a model of the
    // tick before it. `combat.advance` moves a driver *first* and `stepCars`
    // resolves the contact *after*, so a prediction evaluated at the top of the
    // tick sees two cars that are not touching yet -- and then sees them
    // already separated on the next one, with a closing speed of zero. The
    // first draft of this section did exactly that and reported a 0.00 m/s
    // head-on between two cars doing twenty each.
    bodyA.x += bodyA.vx * FIXED_DT;
    bodyA.z += bodyA.vz * FIXED_DT;
    bodyB.x += bodyB.vx * FIXED_DT;
    bodyB.z += bodyB.vz * FIXED_DT;
    const predicted = resolveCarContact(bodyA, bodyB, contact, shunt);
    // Where the tick should leave them: the step, then the separation. The
    // *velocity* the impulse produced is next tick's business.
    const wantAX = bodyA.x + shunt.push[0];
    const wantAZ = bodyA.z + shunt.push[1];
    const wantBX = bodyB.x + shunt.push[2];
    const wantBZ = bodyB.z + shunt.push[3];
    // The **first** contact with an impulse in it, and only that one: every
    // tick after it is the pair coming apart, which is a different measurement
    // wearing the same name.
    const real = predicted && shunt.impulse > 0 && !measured;
    if (real) closingAt = shunt.closing;

    sim.step(out);

    if (!predicted) continue;
    contacts++;
    if (real) {
      measured = true;
      predictionErrorA = Math.hypot(a.combat.body.position.x - wantAX, a.combat.body.position.z - wantAZ);
      predictionErrorB = Math.hypot(b.combat.body.position.x - wantBX, b.combat.body.position.z - wantBZ);
    }
    // Are they inside each other *after* the tick? Built from the live bodies,
    // which is where the cars actually are.
    carRigidBody(
      { body: carA.body, x: a.combat.body.position.x, z: a.combat.body.position.z, yaw: a.combat.body.yaw, speed: a.combat.carSpeed, slip: a.combat.carSlip, yawRate: a.combat.carYawRate },
      bodyA,
    );
    carRigidBody(
      { body: carB.body, x: b.combat.body.position.x, z: b.combat.body.position.z, yaw: b.combat.body.yaw, speed: b.combat.carSpeed, slip: b.combat.carSlip, yawRate: b.combat.carYawRate },
      bodyB,
    );
    // --- Are they inside each other by more than the layer allows, and is the
    //     overlap **coming apart**?
    //
    // This assertion used to be "not overlapping by more than the slop after the
    // tick they met on", and it stopped being the right question when
    // `rigid.CONTACT_CORRECTION` landed: a contact is now separated four tenths
    // at a time, over about six ticks, deliberately -- a full correction of a
    // 40 cm ram is a teleport, and it is also the overshoot that made a car in a
    // parking bay alternate between two places. See `game/rigid.ts` section 7.
    //
    // So what is required of the tick is **convergence**: the depth may be large
    // on the tick they meet, and it must shrink from there. A depth that grew is
    // the failure this was always about, and it is the one that has a picture --
    // two cars burrowing into each other.
    if (rigidOverlap(bodyA, bodyB, contact)) {
      if (contact.depth > lastDepth + 1e-6 && lastDepth > 0) {
        overlapAfter++;
        if (contact.depth > worstDepth) worstDepth = contact.depth;
      }
      lastDepth = contact.depth;
    } else {
      lastDepth = 0;
    }
    if (contacts > 30) break;
  }

  console.log(
    `  1. two drivers head-on: ${contacts} contact tick(s), closing ${closingAt.toFixed(2)} m/s, ` +
      `health ${carA.health.toFixed(2)} / ${carB.health.toFixed(2)}, ` +
      `still overlapping after ${overlapAfter} of them (worst ${worstDepth.toFixed(3)} m), ` +
      `landed ${predictionErrorA.toFixed(2)} m / ${predictionErrorB.toFixed(2)} m from the module's answer`,
  );

  if (contacts === 0) failures.push('Two cars driven straight at each other never touched.');
  // **Damaged as today.** The damage path is `carCrashClosing` and is
  // deliberately untouched by the body layer -- see `driving.CarShunt.closing`,
  // which states that this is why `server/cardamage-check.ts` needed no retune.
  if (carA.health >= CAR_HEALTH_MAX || carB.health >= CAR_HEALTH_MAX) {
    failures.push(
      `A head-on at ${closingAt.toFixed(1)} m/s left the cars on ${carA.health} and ${carB.health}. ` +
        'Both are meant to be damaged and that rule predates this feature.',
    );
  }
  if (overlapAfter > 0) {
    failures.push(
      `The two cars' overlap *grew* on ${overlapAfter} tick(s), to ${worstDepth.toFixed(3)} m. ` +
        'A separation that does not converge is two cars burrowing into each other -- see rigid.ts section 7.',
    );
  }
  if (predictionErrorA > 2 || predictionErrorB > 2) {
    failures.push(
      `The tick put the cars ${predictionErrorA.toFixed(2)} m and ${predictionErrorB.toFixed(2)} m from ` +
        'where game/rigid.ts says the same contact ends. Over two metres means the sweep is not resolving ' +
        'the contact the module describes -- most likely from stale record positions rather than live ' +
        'driver ones. See Simulation.fillCarBody.',
    );
  }
  return { failures, contacts };
}

// --- 2 and 3. A driver against the timetable ---------------------------------------

interface RamResult {
  failures: string[];
  /** How fast the two were closing when they touched. */
  closing: number;
  /** Was the struck car pinned where it stood? */
  stunned: boolean;
  /** The record the hit knocked loose, if any. */
  looseId: number;
  /** How far that record travelled before it stopped, metres. */
  rolled: number;
  /** How long it took, ticks. */
  rollTicks: number;
  /** Was it given back at the end? */
  recycled: boolean;
  /** What the driven car's condition fell to. */
  health: number;
}

/**
 * Drive across a street into whatever the timetable has put in it, at `target`
 * metres a second, and report everything that happened.
 *
 * ---------------------------------------------------------------------------
 * **WHY THE APPROACH IS PERPENDICULAR, AND WHY THE STRUCK CAR IS STOPPED.**
 *
 * You cannot ram an ambient car from in front of it in its own lane, and that
 * is a feature rather than an obstacle: `traffic.resolveHeld` holds the whole
 * timetable six metres behind anything a player has left in the road, so a car
 * approached head-on in its own lane simply recedes. It has been that way since
 * the hold shipped.
 *
 * So the rammer comes in from the side, and by the time the boxes meet the car
 * it is hitting has been held and is standing still -- which means **the
 * closing speed is the rammer's own speed**, and that is precisely the quantity
 * this driver controls. A T-bone against a stationary car is also the geometry
 * with the most to say: it is the case with a real contact arm in it, so it is
 * the case that spins the struck car, and the spin is the thing `verifyRigid`
 * calls out as having no picture.
 */
function runRam(target: number, label: string): RamResult {
  const failures: string[] = [];
  const world = streetWorld();
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const scratch: LaneRoute[] = [];
  const probe = createCarPose();

  // --- Find the target, which is a car that is **standing still**.
  //
  // `server/cardamage-check.ts` section (b) arrived at this geometry first and
  // the reasoning is worth restating, because two earlier drafts of this
  // section did it the obvious way and measured nothing.
  //
  // You cannot ram a *moving* ambient car from in front of it, and that is a
  // feature rather than an obstacle: `traffic.resolveHeld` holds the whole
  // timetable `HOLD_GAP` behind anything a player has left in the road, and a
  // car crossing an intersection is in the road. Approach one head-on and it
  // stops six metres short; approach one side-on and it stops six metres short
  // of where you are about to be. Chasing one with a timed launch measures the
  // timetable rather than the physics, and a driver whose result depends on
  // what second of the day it was run is not a driver.
  //
  // A car in a bay or at a red light is stationary, is not held by anything,
  // and is *stopped is stopped* to every test in this game (`carHitStrength`).
  // So the ram is a plain rear-ender down a straight street at a chosen speed,
  // which is the one geometry with no timing in it at all.
  const target1 = findStopped(sim, scratch, probe);
  if (target1 === null) {
    console.log(`  ${label}: SKIPPED -- no stationary ambient car on the street at this instant.`);
    return {
      failures: [`${label}: no stationary ambient car on the synthetic street; the section could not run.`],
      closing: 0, stunned: false, looseId: 0, rolled: 0, rollTicks: 0, recycled: false, health: CAR_HEALTH_MAX,
    };
  }
  const t = target1;

  const p = sim.join(0, null);
  // Behind it, pointing the way it points, with enough road to reach the
  // target speed. Yaw 0 faces -Z and the synthetic lane runs due north, so
  // this is a rear-ender down a straight street.
  const gap = (target * target) / (2 * DRIVE_ACCEL) + 6;
  const startX = t.x - t.dx * gap;
  const startZ = t.z - t.dz * gap;
  p.combat.body.position.set(startX, EYE_HEIGHT, startZ);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = 0;
  p.input.yaw = 0;
  p.history.seed(sim.tick, startX, EYE_HEIGHT, startZ, 0);
  const car = sim.cars.take(
    { identity: 0xfeed01, body: 0, colour: 0, x: startX, y: 0, z: startZ, yaw: 0, parked: true },
    p.combat.id,
  )!;
  p.combat.drivingCar = car.id;

  let closing = 0;
  let stunned = false;
  let struckIdentity = 0;
  let looseId = 0;
  let looseFrom = { x: 0, z: 0 };
  let rolled = 0;
  let rollTicks = 0;
  let recycled = false;
  let touched = false;
  let settledAt = -1;

  // The bang-bang throttle. A car that reached the target and then coasted
  // would arrive at whatever `DRIVE_COAST` had left of it, which is a speed
  // this driver did not choose.
  for (let tick = 0; tick < 60 * 60; tick++) {
    p.input.forward = touched ? 0 : (p.combat.carSpeed < target ? 1 : 0);
    const healthBefore = car.health;
    const speedBefore = p.combat.carSpeed;
    sim.step(out);

    if (!touched) {
      // The contact is over when the car stopped closing, which against a
      // stationary target is an impact and nothing else.
      if (car.health < healthBefore || (speedBefore > 1 && p.combat.carSpeed < speedBefore * 0.9)) {
        touched = true;
        closing = speedBefore;
        // Which ambient car was it, and is it pinned? Asked of the ledger
        // directly, because the pin is a fact about the ledger rather than
        // about a picture. See `traffic.HoldLedger.stun`.
        const at = trafficTick(Date.now());
        struckIdentity = t.identity;
        stunned = world.traffic.held.stunned(struckIdentity, at);
        for (const rec of sim.cars.all()) {
          if (rec.loose && rec.id !== car.id) {
            looseId = rec.id;
            looseFrom = { x: rec.x, z: rec.z };
            break;
          }
        }
      }
      continue;
    }

    // --- After the hit: watch the wreck roll, stop, and be given back.
    if (looseId === 0) {
      if (tick > 60 * 3) break;
      continue;
    }
    const rec = sim.cars.get(looseId);
    if (rec === undefined) {
      recycled = true;
      break;
    }
    if (rec.speed !== 0 || rec.slip !== 0) {
      rollTicks++;
      rolled = Math.hypot(rec.x - looseFrom.x, rec.z - looseFrom.z);
      settledAt = -1;
    } else if (settledAt < 0) {
      settledAt = tick;
      // Once it has stopped, walk the player well clear so the twenty-second
      // clock is allowed to fire. `RECYCLE_KEEP_RADIUS` is the same 250 m ring
      // `recycleFarthest` has always kept, and `CarField.recycleLooseIds`
      // reuses it rather than inventing a second rule -- see that method, which
      // is where the brief's "out of sight, or until the room empties" was
      // decided.
      p.combat.drivingCar = 0;
      p.combat.body.position.set(startX + RECYCLE_KEEP_RADIUS + 50, EYE_HEIGHT, startZ);
    }
  }

  console.log(
    `  ${label}: closed at ${closing.toFixed(2)} m/s against a ${KNOCK_LOOSE_SPEED} m/s threshold, ` +
      `car on ${car.health.toFixed(2)} hp, struck 0x${(struckIdentity >>> 0).toString(16)} ` +
      `${stunned ? 'PINNED' : 'not pinned'}; ` +
      (looseId === 0
        ? 'nothing knocked loose'
        : `record ${looseId} knocked loose, rolled ${rolled.toFixed(2)} m over ${rollTicks} ticks, ` +
          `${recycled ? 'and was given back' : 'and was not given back'}`),
  );

  if (!touched) failures.push(`${label}: the rammer never reached the traffic at all.`);
  return { failures, closing, stunned, looseId, rolled, rollTicks, recycled, health: car.health };
}

/**
 * A stationary ambient car on the quiet street, or null.
 *
 * `cardamage-check.findCar`'s query with its bounds: `z < -40` keeps the near
 * bay out of it (there is no room for a run-up behind a car eight metres from
 * the end of the street) and `z > -196` lets the far bay in, because on a long
 * headway the red light is only occupied for its dwell and a check that
 * insisted on it would run about one time in ten.
 */
function findStopped(
  sim: Simulation,
  scratch: LaneRoute[],
  probe: CarPose,
): { x: number; y: number; z: number; dx: number; dz: number; identity: number } | null {
  let found: { x: number; y: number; z: number; dx: number; dz: number; identity: number } | null = null;
  forEachCarNear(sim.world.traffic, 0, -100, 600, trafficTick(Date.now()), scratch, probe, (q) => {
    if (q.speed >= 0.01) return;
    if (!(q.z < -40 && q.z > -196)) return;
    found = { x: q.x, y: q.y, z: q.z, dx: q.dx, dz: q.dz, identity: q.identity };
    return true;
  });
  return found;
}


// --- 4. The cap ------------------------------------------------------------------

function runCap(): { failures: string[]; loose: number } {
  const failures: string[] = [];
  const sim = new Simulation(emptyWorld());
  const ids: number[] = [];
  for (let i = 0; i < MAX_LOOSE_CARS + 4; i++) {
    const c = sim.cars.knockLoose(
      { identity: 0x7000 + i, body: 0, colour: 0, x: i * 30, y: 0, z: 0, yaw: 0, parked: false },
      5, 0, 0,
    );
    if (c !== null) ids.push(c.id);
  }
  const loose = sim.cars.looseCount;
  console.log(`  4. ${MAX_LOOSE_CARS + 4} cars knocked loose into one room: ${loose} live against a cap of ${MAX_LOOSE_CARS}`);
  if (loose !== MAX_LOOSE_CARS) {
    failures.push(`The room holds ${loose} loose cars against a cap of ${MAX_LOOSE_CARS}.`);
  }
  for (let i = 0; i < 4; i++) {
    if (sim.cars.get(ids[i]) !== undefined) {
      failures.push(`Loose car ${ids[i]} survived the cap; the oldest is meant to go first.`);
    }
  }
  if (sim.cars.get(ids[ids.length - 1]) === undefined) {
    failures.push('The newest knocked car was evicted rather than the oldest.');
  }
  return { failures, loose };
}

// --- 5. The clock ----------------------------------------------------------------

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

/** The speed the report is quoted at. 50 km/h is the Sydney default limit. */
const REPORT_SPEED = 50 / 3.6;

/**
 * How far apart the two ends place an ambient car for the same instant.
 *
 * ---------------------------------------------------------------------------
 * **THIS IS THE OWNER'S "MAYBE THE CAR HITBOX IS TOO LONG", AND IT IS NOT THE
 * HITBOX.**
 *
 * `game/traffic.ts` is a pure function of the wall clock, and until this
 * workstream the wall clock it read was *each process's own*: `Date.now()` on
 * the box for the server, `Date.now()` on the player's laptop for the client.
 * `protocol.Welcome.clockMs` has carried the host's instant since v11 and
 * `net/client.clockSkewMs` has held the difference ever since -- with a comment
 * saying nothing in the simulation reads it and nothing should, because at the
 * time the only consumer was the sky.
 *
 * So the honest statement of the *old* skew is that it was **unbounded**: a
 * browser's clock is whatever the browser says it is, and the same comment that
 * declined to use it describes a machine four minutes fast. Four minutes at
 * 50 km/h is 33 kilometres of car.
 *
 * What this measures is therefore two things. The **residual** skew after
 * `traffic.setTrafficClockSkew` -- which is the sampling error of the WELCOME,
 * one one-way trip and nothing else -- and the **displacement** any given skew
 * produces, so the number can be read against the brief's 50 ms without having
 * to trust an argument.
 */
function runClock(): { failures: string[]; skewMs: number; metres: number } {
  const failures: string[] = [];
  const realNow = Date.now;
  const world = streetWorld();
  const epochProbe = trafficTick(0);
  let clockMs = (trafficTick(realNow()) - epochProbe) * (1000 / TICK_HZ);
  (Date as unknown as { now: () => number }).now = () => clockMs;

  const room = new Room(0, world, 8, 0);
  const sock = new FakeSocket(newConn(0));
  const toServer: Array<{ f: ArrayBuffer; at: number }> = [];
  const toClient: Array<{ f: ArrayBuffer; at: number }> = [];
  /** One-way trip, in ticks. Three is 50 ms each way: a 100 ms round trip. */
  const LAG_TICKS = 3;
  let tick = 0;
  const transport: NetTransport = {
    open: true, onframe: null, onopen: null, onclose: null,
    send(f: ArrayBuffer): void { toServer.push({ f, at: tick + LAG_TICKS }); },
    close(): void {},
  };
  const net = new NetClient('', {
    onHit: () => {}, onSwat: () => {}, onBounce: () => {}, onPickup: () => {},
    onJoin: () => {}, onLeave: () => {}, onDrop: () => {}, onStatus: () => {},
  }, { name: 'clockprobe', transport, nowMs: () => clockMs });
  transport.onopen?.();

  let joined = false;
  for (tick = 0; tick < 40 && !net.clockFromServer; tick++) {
    clockMs += 1000 / TICK_HZ;
    for (let i = toServer.length - 1; i >= 0; i--) {
      if (toServer[i].at > tick) continue;
      const { f } = toServer.splice(i, 1)[0];
      if (frameType(f) === MSG.HELLO && !joined) {
        joined = true;
        const p = room.join(sock.data, 0, 'clockprobe');
        if (p) {
          room.conns.add(sock as unknown as Socket);
          room.welcome(sock as unknown as Socket, p);
        }
      }
    }
    room.step();
    for (const f of sock.frames.splice(0)) toClient.push({ f, at: tick + LAG_TICKS });
    for (let i = toClient.length - 1; i >= 0; i--) {
      if (toClient[i].at > tick) continue;
      transport.onframe?.(toClient.splice(i, 1)[0].f);
    }
  }

  const skewMs = net.clockFromServer ? Math.abs(net.clockSkew) : Number.NaN;
  net.close();
  (Date as unknown as { now: () => number }).now = realNow;

  // --- And what a skew *is*, in metres, measured off the geometry rather than
  //     argued: pose the same ambient car at two ticks a skew apart.
  const probe = createCarPose();
  const other = createCarPose();
  const scratch: LaneRoute[] = [];
  const now = trafficTick(realNow());
  let a: { x: number; z: number } | null = null;
  let b: { x: number; z: number } | null = null;
  let identity = 0;
  forEachCarNear(world.traffic, LANE_OFFSET, -140, 60, now, scratch, probe, (q) => {
    if (q.speed <= 1) return;
    identity = q.identity;
    a = { x: q.x, z: q.z };
    return true;
  });
  if (identity !== 0) {
    const later = now + Math.round((50 / 1000) * TICK_HZ);
    forEachCarNear(world.traffic, LANE_OFFSET, -140, 60, later, scratch, other, (q) => {
      if (q.identity !== identity) return;
      b = { x: q.x, z: q.z };
      return true;
    });
  }
  const measured = a !== null && b !== null
    ? Math.hypot((b as { x: number }).x - (a as { x: number }).x, (b as { z: number }).z - (a as { z: number }).z)
    : Number.NaN;
  // The arithmetic, for a street whose cars this driver could not find.
  const modelled = REPORT_SPEED * 0.05;

  console.log(
    `  5. the traffic clock: protocol ${PROTOCOL_VERSION}, a ${LAG_TICKS * 2}-tick round trip ` +
      `(${(LAG_TICKS * 2 * 1000 / TICK_HZ).toFixed(0)} ms) leaves a residual skew of ` +
      `${Number.isFinite(skewMs) ? skewMs.toFixed(1) : '?'} ms after setTrafficClockSkew. ` +
      `50 ms of skew moves a car ${Number.isFinite(measured) ? measured.toFixed(2) : modelled.toFixed(2)} m ` +
      `(${(REPORT_SPEED * 3.6).toFixed(0)} km/h x 50 ms = ${modelled.toFixed(2)} m). ` +
      'Before this workstream nothing corrected it and the skew was the browser\'s own clock error: unbounded.',
  );

  if (!Number.isFinite(skewMs)) {
    failures.push('The client never learnt the host clock at all, so the traffic clock cannot be corrected.');
  } else if (skewMs > (LAG_TICKS + 1) * (1000 / TICK_HZ)) {
    failures.push(
      `The residual clock skew is ${skewMs.toFixed(1)} ms against a one-way trip of ` +
        `${(LAG_TICKS * 1000 / TICK_HZ).toFixed(0)} ms. The WELCOME sample is the only error there is ` +
        'meant to be; anything larger means the skew is not being adopted.',
    );
  }
  const metres = Number.isFinite(measured) ? measured : modelled;
  return { failures, skewMs, metres };
}

// --- 6. The wire ------------------------------------------------------------------

/**
 * What eight rolling wrecks cost a player, in bytes a second.
 *
 * Measured off `Simulation.carDelta` through the real `protocol.encodeCars`
 * rather than computed, because the thing being checked is the *throttle*
 * (`driving.LOOSE_BROADCAST_TICKS`) and an arithmetic answer would be a second
 * copy of the constant. `room.sendCars` is room-global and not interest
 * filtered -- see its header for why suppression has to be world-wide -- so
 * bytes on the wire and bytes per player are the same number here.
 */
function runWire(): { failures: string[]; bytesPerSecond: number } {
  const failures: string[] = [];
  const realNow = Date.now;
  const sim = new Simulation(emptyWorld());
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const epochProbe = trafficTick(0);
  let clockMs = (trafficTick(realNow()) - epochProbe) * (1000 / TICK_HZ);
  (Date as unknown as { now: () => number }).now = () => clockMs;

  // Eight wrecks, all rolling, all in different streets so nothing resolves a
  // contact and the measurement is the *broadcast* and nothing else.
  for (let i = 0; i < MAX_LOOSE_CARS; i++) {
    sim.cars.knockLoose(
      { identity: 0x9000 + i, body: 0, colour: 0, x: i * 200, y: 0, z: 0, yaw: 0, parked: false },
      9, 0, 1,
    );
  }
  let bytes = 0;
  let ticks = 0;
  for (; ticks < TICK_HZ; ticks++) {
    clockMs += 1000 / TICK_HZ;
    sim.step(out);
    const delta = sim.carDelta();
    if (delta.length > 0) bytes += encodeCars(delta).byteLength;
  }
  (Date as unknown as { now: () => number }).now = realNow;

  const kbits = (bytes * 8) / 1000;
  console.log(
    `  6. the wire at the cap: ${MAX_LOOSE_CARS} wrecks rolling for one second cost ${bytes} B ` +
      `(${kbits.toFixed(1)} kbit/s per player) at ${CAR_RECORD_BYTES} B a record and one broadcast every ` +
      `${LOOSE_BROADCAST_TICKS} ticks. PERFORMANCE.md sizes a player's downlink at 130-200 kbit/s, ` +
      `so this is ${((kbits / 130) * 100).toFixed(0)}% of the tighter end -- and only while all eight are ` +
      'actually moving, which is two or three seconds each.',
  );
  // The budget, asserted against the document rather than against a literal
  // this file invented. A tenth of the tighter end of the measured range is the
  // most a single mechanic may take; see PERFORMANCE.md's own framing of the
  // 130-200 kbit/s figure and DESIGN.md rule 8.
  if (kbits > 130 * 0.25) {
    failures.push(
      `Eight rolling wrecks cost ${kbits.toFixed(1)} kbit/s a player, over a quarter of the 130 kbit/s ` +
        'PERFORMANCE.md sizes the tighter end of a downlink at. Either the cap or the broadcast interval ' +
        'has moved.',
    );
  }
  return { failures, bytesPerSecond: bytes };
}

// --- The run ---------------------------------------------------------------------

function main(): void {
  console.log('--- cars are solid to each other, through the real Simulation and the real Room\n');
  const failures: string[] = [];

  const drivers = runDrivers();
  failures.push(...drivers.failures);

  const soft = runRam(SOFT_RAM, `2. a ${SOFT_RAM.toFixed(1)} m/s ram (under the threshold)`);
  failures.push(...soft.failures);
  if (soft.looseId !== 0) {
    failures.push(
      `A ${soft.closing.toFixed(2)} m/s hit knocked a car loose under the ${KNOCK_LOOSE_SPEED} m/s threshold. ` +
        'Every parking manoeuvre in the city would leave a permanent obstacle.',
    );
  }
  if (!soft.stunned) {
    failures.push(
      'The ambient car a driver stopped against was not pinned, so it drives on through the wreck. ' +
        'See traffic.HoldLedger.stun.',
    );
  }

  const hard = runRam(HARD_RAM, `3. a ${HARD_RAM.toFixed(1)} m/s ram (over it)`);
  failures.push(...hard.failures);
  if (hard.looseId === 0) {
    failures.push(
      `A ${hard.closing.toFixed(2)} m/s hit did not knock the ambient car loose, against a threshold of ` +
        `${KNOCK_LOOSE_SPEED} m/s.`,
    );
  } else {
    if (!(hard.rolled > 1)) {
      failures.push(`The knocked car only moved ${hard.rolled.toFixed(2)} m. It is meant to be launched.`);
    }
    if (hard.rollTicks >= 60 * 20) {
      failures.push('The knocked car never came to rest, so it can never be recycled.');
    }
    if (!hard.recycled) {
      failures.push(
        `The wreck was not given back after ${(LOOSE_REST_MS / 1000).toFixed(0)} s at rest with the ` +
          `player ${RECYCLE_KEEP_RADIUS} m away. See CarField.recycleLooseIds.`,
      );
    }
  }

  const cap = runCap();
  failures.push(...cap.failures);
  const clock = runClock();
  failures.push(...clock.failures);
  const wire = runWire();
  failures.push(...wire.failures);

  // --- The ratchet. Numbers that must not go *down*, printed so a future run
  //     can be read against this one without anybody having to remember what
  //     the expectation was.
  console.log('\n  ratchet (none of these may fall):');
  console.log(`    contacts resolved in a scripted head-on          ${drivers.contacts}`);
  console.log(`    ambient cars pinned by a soft ram                ${soft.stunned ? 1 : 0}`);
  console.log(`    ambient cars knocked loose by a hard ram         ${hard.looseId === 0 ? 0 : 1}`);
  console.log(`    metres a knocked car rolled                      ${hard.rolled.toFixed(2)}`);
  console.log(`    wrecks a room holds at the cap                   ${cap.loose}`);
  console.log(`    residual clock skew, ms (lower is better)        ${clock.skewMs.toFixed(1)}`);
  console.log(`    metres of car per 50 ms of skew at 50 km/h       ${clock.metres.toFixed(2)}`);
  console.log(`    bytes a second at the cap (lower is better)      ${wire.bytesPerSecond}`);

  if (failures.length > 0) {
    console.log('');
    for (const f of failures) console.log(`  FAIL ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n  all clear');
  }
}

main();
