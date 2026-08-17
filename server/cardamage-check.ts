/**
 * A car driven into a real wall, through the real `Simulation`. TEMPORARY.
 *
 * `server/integration-check.ts` takes 45 minutes against the built world, so
 * this is the one check extracted into a driver of its own, on the workstream
 * preamble's rule. It exists to answer the one question the unit checks in
 * `verifyDriving` cannot: does the crash damage actually arrive when the *whole
 * server tick* runs -- `combat.advance` filling `carCrashDv` from the nose probe
 * and `crashFromClamp`, `sim.stepCars` draining it, `CarField.damage` applying
 * it under the cooldown, the handling degrading off the mirrored health, and
 * `carRecord` putting the byte on the wire -- rather than only when each of
 * those is called by hand.
 *
 *   bun run server/cardamage-check.ts
 *
 * Delete before the branch is merged.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import type { ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import {
  CAR_HIT_FULL_SPEED,
  TrafficField,
  createCarPose,
  forEachCarNear,
  // WORKSTREAM T: the same 200 m street `verifyTraffic` runs on, through the
  // real encoder and decoder. See its header for why it is exported at all.
  syntheticTile,
  trafficTick,
  type CarPose,
  type LaneRoute,
} from '../client/src/game/traffic.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { MAX_HEALTH } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import {
  CAR_HEALTH_MAX,
  CAR_SMOKING_HEALTH,
  CAR_SMOKING_SCALE,
  CRASH_DAMAGE_MAX,
  DRIVE_ACCELERATION,
  DRIVE_TOP_SPEED,
  type DrivenCar,
} from '../client/src/game/driving.ts';

/**
 * How far down the road the wall is, metres.
 *
 * **Derived from the top speed rather than the 60 m this used to hard-code**,
 * and the derivation is what stops it rotting the way the literal did: the
 * whole point of run 1 is a *healthy car at its top speed* hitting a wall, and
 * `v^2 / 2a` is how much road that needs. At 22 m/s it was 40 m, so 60 was
 * enough by half; at 44 it is 161, and 60 m of run-up would have put the car
 * into the wall at 27 m/s while the check went on claiming it measured a
 * top-speed crash.
 *
 * Plus 40 m of margin, so the car is genuinely *at* the top rather than
 * arriving there in the same tick it hits.
 */
const RUN_UP = DRIVE_TOP_SPEED * DRIVE_TOP_SPEED / (2 * DRIVE_ACCELERATION) + 40;

/** How far east workstream T's quiet street sits. Far enough not to interact. */
const QUIET_STREET_X = 200;

/**
 * How long the two sections that need the **wall clock** may run, and at what
 * rate. WORKSTREAM T.
 *
 * `traffic.poseCar` is a closed-form function of `Date.now()`, not of the sim's
 * tick counter, so a section whose subject is *an ambient car arriving* has to
 * let real time pass or it watches a photograph. 300 ticks at 8 ms is 2.4 s of
 * street, which at the synthetic route's 11.1 m/s is 26 m -- one metre more than
 * the gap those sections set up, so the car arrives with nothing to spare and
 * the section does not sit there for ten seconds proving it.
 */
const REAL_TIME_TICKS = 300;
const REAL_TIME_STEP_MS = 8;

/**
 * `verifySim`'s empty city, with one wall across the road at the end of the
 * run-up.
 *
 * `wall` is false for workstream T's sections, and it is not a convenience: they
 * crash cars into *cars*, and a prism sitting 200 m down the same street would
 * put `crashFromClamp`'s answer into the middle of a measurement of
 * `carCrashClosing`'s. Two crash sources in one world is a check that cannot say
 * which one it proved.
 */
function emptyWorld(wall = true): ServerWorld {
  const collision = new CollisionWorld();
  if (wall) {
    collision.addPrisms('wall', [{
      points: new Float32Array([-20, -RUN_UP - 2, 20, -RUN_UP - 2, 20, -RUN_UP + 2, -20, -RUN_UP + 2]),
      height: 8,
      base: 0,
    }]);
  }
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    collision,
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

/** The wall. Returns its failures rather than an exit code; `main` collects. */
function run(): string[] {
  const failures: string[] = [];
  const sim = new Simulation(emptyWorld());
  const p = sim.join(0, null);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };

  const place = (z: number): void => {
    p.combat.body.position.set(0, EYE_HEIGHT, z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.yaw = 0;
    p.input.yaw = 0;
    p.combat.carSpeed = 0;
    p.history.seed(sim.tick, 0, EYE_HEIGHT, z, 0);
  };

  // Put the driver in a car by hand. `tryTakeCar` needs a lane sidecar and this
  // world has none -- what is being exercised is the *crash*, not the theft, and
  // `CarField.take` is the same call `tryTakeCar` makes.
  place(0);
  const car = sim.cars.take(
    { identity: 0xc0ffee, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    p.combat.id,
  )!;
  p.combat.drivingCar = car.id;

  /** Full throttle until the car stops, or `limit` ticks. Reports the run. */
  const chargeTheWall = (limit: number): { top: number; healthBefore: number; ticks: number } => {
    const healthBefore = car.health;
    let top = 0;
    let ticks = 0;
    p.input.forward = 1;
    p.input.right = 0;
    for (; ticks < limit; ticks++) {
      sim.step(out);
      if (p.combat.carSpeed > top) top = p.combat.carSpeed;
      if (top > 1 && p.combat.carSpeed < 0.05) break;
    }
    p.input.forward = 0;
    return { top, healthBefore, ticks };
  };

  console.log('--- a car driven at full throttle into a wall, through Simulation.step');

  // === 1. Healthy car, a full run-up. See `RUN_UP`.
  const first = chargeTheWall(1800);
  console.log(
    `  run 1: top ${first.top.toFixed(2)} m/s, health ${first.healthBefore} -> ${car.health}, ` +
      `stopped at z = ${p.combat.body.position.z.toFixed(1)} after ${first.ticks} ticks`,
  );
  if (Math.abs(first.top - DRIVE_TOP_SPEED) > 0.5) {
    failures.push(`A healthy car reached ${first.top.toFixed(2)} m/s over ${RUN_UP.toFixed(0)} m; the top speed is ${DRIVE_TOP_SPEED}.`);
  }
  if (car.health >= CAR_HEALTH_MAX) {
    failures.push('Driving into a wall at the top speed did the car no damage at all.');
  }
  // The cap, exactly: one crash can never take more than `CRASH_DAMAGE_MAX`,
  // which is what makes the first heavy crash a warning rather than the end --
  // and it is also the whole of the cooldown working, because the car spends
  // four more ticks grinding into the same wall before it stops.
  const cost = first.healthBefore - car.health;
  if (Math.abs(cost - CRASH_DAMAGE_MAX) > 0.01) {
    failures.push(
      `A ${DRIVE_TOP_SPEED} m/s wall cost ${cost.toFixed(1)} hp against the ${CRASH_DAMAGE_MAX} cap. ` +
        `More than the cap means the 500 ms cooldown is not swallowing the grind after the impact.`,
    );
  }
  if (car.health > CAR_SMOKING_HEALTH) {
    failures.push(`The worst possible single crash left the car on ${car.health}, above the smoke threshold.`);
  }

  // === 2. Back up and do it again, until it is finished. A damaged car is
  //        slower off the line *and* slower at the top, so every run after the
  //        first is a smaller crash -- which is the shape the feature wants: the
  //        first heavy wall is a warning and the car gets progressively harder
  //        to finish off rather than more fragile.
  let runs = 1;
  while (car.health > 0 && runs < 8) {
    place(0);
    const again = chargeTheWall(1800);
    runs++;
    console.log(
      `  run ${runs}: top ${again.top.toFixed(2)} m/s, health ${again.healthBefore.toFixed(1)} -> ` +
        `${car.health.toFixed(1)}  (cost ${(again.healthBefore - car.health).toFixed(1)})`,
    );
    if (runs === 2) {
      // The degraded handling, measured on the first run after the smoke starts.
      // This is the number that proves the health mirror reaches the integrator
      // through the whole server tick rather than only in a unit check.
      if (Math.abs(again.top - DRIVE_TOP_SPEED * CAR_SMOKING_SCALE) > 0.5) {
        failures.push(
          `A smoking car reached ${again.top.toFixed(2)} m/s against the ` +
            `${(DRIVE_TOP_SPEED * CAR_SMOKING_SCALE).toFixed(1)} CAR_SMOKING_SCALE promises. The degraded ` +
            `handling is not reaching the integrator through the health mirror.`,
        );
      }
    }
  }
  console.log(`  written off after ${runs} runs at the wall, final health ${car.health}`);
  if (car.health !== 0) failures.push(`Eight runs at a wall left the car on ${car.health}, not written off.`);
  if (runs < 2) failures.push('One crash wrote the car off. The first heavy wall is meant to be a warning.');

  // === 3. The wreck. The engine is dead and the record stays.
  place(20);
  p.input.forward = 1;
  for (let i = 0; i < 180; i++) sim.step(out);
  p.input.forward = 0;
  const crept = p.combat.body.position.z - 20;
  console.log(`  wreck: three seconds of full throttle moved it ${crept.toFixed(3)} m`);
  if (Math.abs(crept) > 1) {
    failures.push(`A written-off car moved ${crept.toFixed(2)} m under full throttle. The engine is meant to be dead.`);
  }

  // ...and you can still get out. `E` is edge-triggered by the reader (see
  // `protocol.BTN.MOUNT`), so it goes down for one tick and up for the next.
  p.input.mount = true;
  sim.step(out);
  p.input.mount = false;
  sim.step(out);
  console.log(
    `  after E: drivingCar ${p.combat.drivingCar}, record ${sim.cars.get(car.id) ? 'still there' : 'GONE'}, ` +
      `health ${car.health}, suppressing ambient ${sim.cars.suppressed(0xc0ffee)}`,
  );
  if (p.combat.drivingCar !== 0) failures.push('The driver could not get out of the written-off car.');
  if (sim.cars.get(car.id) === undefined) failures.push('The written-off car vanished when its driver got out.');
  if (car.health !== 0) failures.push('Getting out of the wreck repaired it.');
  if (!sim.cars.suppressed(0xc0ffee)) {
    failures.push('The wreck stopped suppressing its ambient copy, so the timetable now runs a car through it.');
  }

  // === 4. And the record that goes on the wire carries the byte.
  const wire = sim.carRecords().find((r) => r.id === car.id);
  console.log(`  wire record: ${JSON.stringify(wire)}`);
  if (!wire) failures.push('The written-off car is not in `carRecords()`.');
  else if (wire.health !== 0) failures.push(`The wire record says health ${wire.health}, not 0.`);

  // === 5. Nothing expires. A minute of ticks with the player four kilometres
  //        away -- which under the old five-minute clock would have started the
  //        countdown, and under the budget does nothing at all.
  place(4000);
  const before = sim.cars.size;
  for (let i = 0; i < 60 * 60; i++) sim.step(out);
  console.log(`  after a minute of ticks with the player 4 km away: ${sim.cars.size} record(s), was ${before}`);
  if (sim.cars.size !== before) {
    failures.push('A car standing empty 4 km from anybody was removed after a minute. Cars do not despawn.');
  }

  return failures;
}

/**
 * WORKSTREAM T: **a crash damages both cars and leaves both drivers in them.**
 *
 * The owner's report was one sentence -- *"I still get knocked out of cars when
 * crashing into another car, the actual action should be damage to both cars"*
 * -- and it needed a driver of its own for the reason the wall above did:
 * `verifyDriving` can prove `carCrashClosing` and `ambientCrashClosing` return
 * the right numbers, and it cannot prove that the whole server tick then does
 * the right thing with them. The bug was never in the arithmetic. It was in the
 * *knockdown* running first, finding a driver's capsule inside the other car's
 * box, and ejecting them -- which no unit check of a pure function can see.
 *
 * Three sections, and they are the three ways two cars can meet:
 *
 *   (a) two **driven** cars, one stationary, one arriving at 15 m/s;
 *   (b) a driven car into a **stationary ambient** one (a car in a bay, or one
 *       held at a red -- the same thing to every test in the game, which is
 *       `carHitStrength`'s whole point);
 *   (c) a **moving ambient** car arriving at a driven one standing in its lane.
 *
 * (b) and (c) need a real timetable, so this world adopts
 * `traffic.syntheticTile` -- the same 200 m two-way street `verifyTraffic` runs
 * on, through the real encoder and the real decoder, so what is hit here is a
 * car the shipped bytes describe rather than a mock.
 *
 * **A fresh `Simulation` per section**, which is not tidiness either. A driven
 * record never expires (`game/driving.ts` section 6) and every record is
 * published to `traffic.HoldLedger` as a blocker, so a car left standing at the
 * end of section (a) is a thing the ambient fleet queues behind for the whole of
 * (b) and (c) -- the first draft of this driver found "no moving ambient car on
 * the street" in section (c) for exactly that reason, because `resolveHeld` had
 * stopped all of them dead behind section (b)'s leftovers.
 */
function runCrashes(): string[] {
  const failures: string[] = [];

  /**
   * One empty city with **two** synthetic streets in it, and nothing left over.
   *
   * Both are `traffic.syntheticTile` at the offset `verifyTraffic` uses -- a
   * 7.5 m residential carriageway, so the lane sits a quarter width west of the
   * centreline -- and they differ only in headway, which is the pair that tile's
   * own header describes as *"a quiet street... and a busy one"*.
   *
   * **Two rather than one, because the ambient fleet runs on the wall clock.**
   * `poseCar` is a closed-form function of `trafficTick(Date.now())`, so what is
   * on a street when this driver runs depends on what second of the day somebody
   * typed the command in. The first draft used one 14 s street and found, on one
   * run in three, that all three of its live cars were stationary at once -- the
   * far bay, the red light and the near bay -- and section (c) had nothing
   * moving to be hit by. A 6 s headway keeps two or three cars at road speed at
   * every instant, and a 120 s one keeps its bays and its red light occupied for
   * minutes, so both sections have their car whenever this is run. Measured over
   * eight samples half a second apart: 2-5 moving and 2-6 stationary, always.
   *
   * The quiet street is 200 m east so the two never interact.
   */
  const freshSim = (): Simulation => {
    const world = emptyWorld(false);
    // `rid` has to differ or the two routes are one car twice over --
    // `identityOf` is a hash of exactly `(rid, slot)`. See `syntheticTile`.
    // Both at **y = 0**, which is where `server/world.groundFor` puts the ground
    // in a city with no terrain tiles in it. The fixture's own -12.5 is twelve
    // and a half metres below anybody's feet, and every vertical gate in the
    // game correctly refuses to let a body twelve metres up touch a car twelve
    // metres down -- which the first run of this section discovered by finding
    // that a pedestrian standing in a lane of traffic was never run over. See
    // `syntheticTile`' `laneY`.
    world.traffic.adopt('busy', syntheticTile(1.875, 0, 0, undefined, 6, 3, 0, 0x5eed, 0));
    world.traffic.adopt('quiet', syntheticTile(1.875, QUIET_STREET_X, 0, undefined, 120, 3, 0, 0x1234, 0));
    return new Simulation(world);
  };
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const scratch: LaneRoute[] = [];
  const probe = createCarPose();

  /** Put a body somewhere, facing `yaw`, at rest. `run`'s `place`, for two. */
  const put = (sim: Simulation, p: Participant, x: number, z: number, yaw: number): void => {
    p.combat.body.position.set(x, EYE_HEIGHT, z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.yaw = yaw;
    p.input.yaw = yaw;
    p.input.forward = 0;
    p.input.right = 0;
    p.combat.carSpeed = 0;
    p.history.seed(sim.tick, x, EYE_HEIGHT, z, yaw);
  };

  /**
   * Hand somebody a car where they are standing. `CarField.take` is the call
   * `tryTakeCar` makes; the theft is `server/take-check.ts`' subject, not this
   * driver's, and this world has no lane sidecar under the players anyway.
   */
  let identity = 0xc7a5401;
  const giveCar = (sim: Simulation, p: Participant): DrivenCar => {
    const car = sim.cars.take({
      identity: identity++,
      body: 0,
      colour: 0,
      x: p.combat.body.position.x,
      y: p.combat.body.position.y - EYE_HEIGHT,
      z: p.combat.body.position.z,
      yaw: p.combat.body.yaw,
      parked: true,
    }, p.combat.id)!;
    p.combat.drivingCar = car.id;
    return car;
  };

  /**
   * How much road it takes to reach `speed` from rest, metres. `v^2 / 2a`, which
   * is `RUN_UP`'s own derivation at a speed short of the top.
   *
   * **The car has to get there by driving.** Writing `carSpeed = 15` and
   * stepping does not simulate a car doing 15 m/s: `controller.step` ramps the
   * *body* toward the car's speed at its own acceleration, so the first tick
   * covers a centimetre where the scalar promised a quarter metre, and
   * `crashFromClamp` reads that shortfall as a 12 m/s impact and charges 53 hp
   * for it. The first draft of this driver did exactly that and recorded a crash
   * against a car eight metres away. Nothing is wrong with `crashFromClamp` --
   * it is measuring precisely what it says it measures -- but a check that wants
   * to weigh a car-on-car crash has to leave that path with nothing to report.
   */
  const runUpFor = (speed: number): number => speed * speed / (2 * DRIVE_ACCELERATION);

  /**
   * How long to keep stepping **after** the crash lands, ticks.
   *
   * Not padding. The crash and the ejection were never the same tick:
   * `carCrashClosing` fires the moment two 2.3 m boxes overlap, at 4.6 m centre
   * to centre, and `traffic.carOverlaps` needs the victim's *capsule* inside the
   * moving car's box, which is 2.7 m -- eight more ticks at 15 m/s. The first
   * draft of section (a) stopped watching on the tick the health moved and
   * therefore reported that nobody was thrown out of anything, on code that
   * throws people out of cars. Three quarters of a second is well past the
   * knockdown window and past `CRASH_COOLDOWN_MS`, so what it also proves is
   * that a car resting against another car is not being billed every tick.
   */
  const SETTLE = 45;

  console.log('\n--- WORKSTREAM T: a car-on-car crash damages both cars and throws nobody out');

  // === (a) Two driven cars. The mover arrives at about 15 m/s under its own
  //         throttle; the other is stopped with its driver sitting in it, nose
  //         to nose. Off the synthetic lane (x = 40) so this section is about
  //         the two of them and nothing else.
  {
    const sim = freshSim();
    const a = sim.join(0, null);
    const b = sim.join(0, null);
    const gap = runUpFor(15) + 4.6;
    put(sim, a, 40, 0, 0);
    put(sim, b, 40, -gap, Math.PI);
    const carA = giveCar(sim, a);
    const carB = giveCar(sim, b);
    a.input.forward = 1;
    let ticks = 0;
    let atImpact = 0;
    for (; ticks < 600; ticks++) {
      atImpact = a.combat.carSpeed;
      sim.step(out);
      if (carA.health < CAR_HEALTH_MAX || carB.health < CAR_HEALTH_MAX) break;
    }
    // ...and keep going, because the ejection happens later than the crash. See
    // `SETTLE`.
    for (let i = 0; i < SETTLE; i++) sim.step(out);
    a.input.forward = 0;
    console.log(
      `  (a) driven into driven, ${gap.toFixed(1)} m of run-up, ${atImpact.toFixed(2)} m/s at impact, ` +
        `${SETTLE} ticks of settling after it:\n` +
        `      mover:      car ${carA.health.toFixed(1)} hp, drivingCar ${a.combat.drivingCar}, ` +
        `health ${a.combat.health.toFixed(1)}, phase '${a.combat.phase}'\n` +
        `      stationary: car ${carB.health.toFixed(1)} hp, drivingCar ${b.combat.drivingCar}, ` +
        `health ${b.combat.health.toFixed(1)}, phase '${b.combat.phase}'`,
    );
    // **Both cars.** The brief's word, and the only answer that needs no rule
    // about who was at fault.
    if (carA.health >= CAR_HEALTH_MAX) failures.push('(a) The car that did the crashing took no damage.');
    if (carB.health >= CAR_HEALTH_MAX) failures.push('(a) The car that was hit took no damage.');
    if (Math.abs(carA.health - carB.health) > 1e-9) {
      failures.push(
        `(a) One crash cost ${(CAR_HEALTH_MAX - carA.health).toFixed(1)} and ` +
          `${(CAR_HEALTH_MAX - carB.health).toFixed(1)}; both cars pay the same.`,
      );
    }
    // **And neither driver.** This is the report.
    if (a.combat.drivingCar !== carA.id) failures.push('(a) The driver who crashed was thrown out of their own car.');
    if (b.combat.drivingCar !== carB.id) failures.push('(a) The driver who was hit was thrown out of their car.');
    if (a.combat.health !== MAX_HEALTH || b.combat.health !== MAX_HEALTH) {
      failures.push(
        `(a) A crash cost the drivers health (${a.combat.health}, ${b.combat.health} of ${MAX_HEALTH}). ` +
          'A written-off car is the consequence, not a pip.',
      );
    }
    if (a.combat.phase !== 'idle' || b.combat.phase !== 'idle') {
      failures.push(`(a) A crash put a driver into '${a.combat.phase}'/'${b.combat.phase}'; neither was run over.`);
    }
  }

  /**
   * A car on one of the two streets right now, matching a predicate. Null if the
   * timetable has nothing suitable at this instant.
   *
   * The street is queried rather than assumed because the ambient fleet is a
   * function of the **wall clock** (`trafficTick(Date.now())`) and this driver
   * runs whenever somebody types the command. Hard-coding "the car is at z = -60
   * at tick 300" is how a check becomes a check that only passes on Tuesdays.
   */
  const findCar = (
    sim: Simulation,
    want: (p: CarPose) => boolean,
  ): { x: number; y: number; z: number; dx: number; dz: number; speed: number } | null => {
    let found: { x: number; y: number; z: number; dx: number; dz: number; speed: number } | null = null;
    // One query centred between the two streets, wide enough to cover both.
    forEachCarNear(sim.world.traffic, QUIET_STREET_X / 2, -100, 600, trafficTick(Date.now()), scratch, probe, (p) => {
      if (!want(p)) return;
      found = { x: p.x, y: p.y, z: p.z, dx: p.dx, dz: p.dz, speed: p.speed };
      return true;
    });
    return found;
  };

  // === (b) A driven car into a **stationary** ambient one.
  //
  //     What happened before this workstream was *nothing at all*, and that is
  //     worth stating because it is the half of the bug nobody reported: a
  //     stationary car returns 0 from `carHitStrength`, so it could not knock
  //     anybody down, and a schedule car is a closed-form lookup rather than a
  //     collision prism, so `combat.crashFromClamp` never saw it either. You
  //     drove through a parked bus for free.
  {
    const sim = freshSim();
    const a = sim.join(0, null);
    // The quiet street's red light: a schedule car held at a dwell, stopped
    // dead, with a hundred metres of clear road behind it for the run-up. The
    // brief's *"stopped at a light"*, and the same thing to every test in the
    // game as a car in a bay -- see `carHitStrength`, for which stopped is
    // stopped.
    // -40 keeps the near bay out of it (there is no room for a run-up behind a
    // car eight metres from the end of the street); -196 lets the far bay in,
    // because on a 120 s headway the red light is only occupied for its dwell
    // and a check that insisted on it would run about one time in ten.
    const target = findCar(sim, (p) => p.speed < 0.01 && p.x > QUIET_STREET_X / 2 && p.z < -40 && p.z > -196);
    if (target === null) {
      console.log('  (b) SKIPPED: no stationary ambient car on the street at this instant.');
      failures.push('(b) No stationary ambient car on the synthetic street; the check could not run.');
    } else {
      const t = target;
      // Behind it, pointing the way it points, with enough road to reach 15 m/s.
      // Yaw 0 faces -Z and the synthetic lane runs due north, so this is a plain
      // rear-ender down a straight street.
      const gap = runUpFor(15) + 4.6;
      put(sim, a, t.x - t.dx * gap, t.z - t.dz * gap, 0);
      const car = giveCar(sim, a);
      a.input.forward = 1;
      const before = car.health;
      let ticks = 0;
      let atImpact = 0;
      for (; ticks < 600; ticks++) {
        atImpact = a.combat.carSpeed;
        sim.step(out);
        if (car.health < before) break;
      }
      for (let i = 0; i < SETTLE; i++) sim.step(out);
      a.input.forward = 0;
      console.log(
        `  (b) driven into a stationary ambient car at (${t.x.toFixed(1)}, ${t.z.toFixed(1)}), ` +
          `${atImpact.toFixed(2)} m/s at impact, ${SETTLE} ticks of settling after it:\n` +
          `      car ${before} -> ${car.health.toFixed(1)} hp, drivingCar ${a.combat.drivingCar}, ` +
          `health ${a.combat.health.toFixed(1)}, phase '${a.combat.phase}'`,
      );
      if (car.health >= before) {
        failures.push('(b) Driving into a stationary ambient car cost the driven car nothing. A car is not a hologram.');
      }
      if (a.combat.drivingCar !== car.id) failures.push('(b) The ambient fleet threw the driver out of their car.');
      if (a.combat.health !== MAX_HEALTH) failures.push(`(b) The driver lost health (${a.combat.health}) to hitting a parked car.`);
      if (a.combat.phase !== 'idle') failures.push(`(b) Hitting a parked car put the driver into '${a.combat.phase}'.`);
    }
  }

  // === (c) A **moving** ambient car arriving at a driven one standing in the
  //         lane with its driver in it. The owner's case, from the other side.
  {
    const sim = freshSim();
    const b = sim.join(0, null);
    const target = findCar(sim, (p) => p.speed >= CAR_HIT_FULL_SPEED && p.x < QUIET_STREET_X / 2 && p.z > -150);
    if (target === null) {
      console.log('  (c) SKIPPED: no moving ambient car on the street at this instant.');
      failures.push('(c) No moving ambient car on the synthetic street; the check could not run.');
    } else {
      const t = target;
      // Twenty-five metres down the road, dead in its lane, engine off.
      put(sim, b, t.x + t.dx * 25, t.z + t.dz * 25, 0);
      const car = giveCar(sim, b);
      const before = car.health;
      const health = b.combat.health;
      let ticks = 0;
      let closest = Infinity;
      for (; ticks < REAL_TIME_TICKS; ticks++) {
        // **Real time, on purpose.** The ambient fleet is a closed-form function
        // of `Date.now()` and not of the sim's tick counter, so a loop that
        // steps six hundred times in four milliseconds watches a frozen city:
        // the first draft of this section measured a nearest approach of 19.6 m
        // and concluded the traffic never arrives, when what had actually
        // happened was that 0.4 m of road went past. Sleeping the wall clock is
        // the only way to make a headless driver watch the timetable move, and
        // it is why this section costs a couple of seconds where every other one
        // costs microseconds.
        Bun.sleepSync(REAL_TIME_STEP_MS);
        sim.step(out);
        forEachCarNear(
          sim.world.traffic, car.x, car.z, 40, trafficTick(Date.now()), scratch, probe, (p) => {
            const dx = p.x - car.x;
            const dz = p.z - car.z;
            const d = Math.sqrt(dx * dx + dz * dz);
            if (d < closest) closest = d;
          },
        );
        if (car.health < before || b.combat.drivingCar === 0) break;
      }
      // The same settle, still on the wall clock, so the ambient car that landed
      // the crash has time to arrive on top of the driver afterwards. See
      // `SETTLE`.
      for (let i = 0; i < SETTLE; i++) {
        Bun.sleepSync(REAL_TIME_STEP_MS);
        sim.step(out);
      }
      console.log(
        `  (c) an ambient car at ${t.speed.toFixed(1)} m/s arriving at a driven car standing in its lane, ` +
          `after ${ticks + 1} ticks:\n` +
          `      nearest ambient approach ${closest.toFixed(2)} m, car ${before} -> ${car.health.toFixed(1)} hp, ` +
          `drivingCar ${b.combat.drivingCar}, health ${b.combat.health.toFixed(1)}, phase '${b.combat.phase}'`,
      );
      // The section has to have *happened*: an ambient car that never came
      // within forty metres proves nothing about what one does when it arrives,
      // and that is exactly the shape of the false pass this driver has already
      // produced twice (a frozen timetable, and a street twelve metres
      // underground).
      if (!(closest < 40)) {
        failures.push('(c) No ambient car came within 40 m in the whole section; it measured nothing.');
      }
      // The **rule**, whatever the timetable did: the driver is still driving
      // and is still whole. Whether the ambient car reaches them at all is
      // `traffic.resolveHeld`'s business -- it holds the fleet `HOLD_GAP` behind
      // anything in the blocker roster -- and is printed above rather than
      // asserted, because that hold is a property of the traffic feature and not
      // of this one. See the report, which says what was measured.
      if (b.combat.drivingCar !== car.id) {
        failures.push('(c) An ambient car knocked a driver out of a car that was standing still. This is the report.');
      }
      if (b.combat.health !== health) failures.push(`(c) The driver of a stationary car lost health (${b.combat.health}) to the traffic.`);
      if (b.combat.phase !== 'idle') failures.push(`(c) The traffic put a stationary car's driver into '${b.combat.phase}'.`);
    }
  }

  // === And the rule stated once more, on foot: **a pedestrian is unchanged.**
  //     The gate is `drivingCar`, so somebody standing in the same lane with no
  //     car around them is a body in the road again. This is the check that
  //     stops workstream T quietly making the whole city immune to being run
  //     over, which is the failure nobody would notice until the funniest thing
  //     in the build had gone missing.
  {
    const sim = freshSim();
    const c = sim.join(0, null);
    const target = findCar(sim, (p) => p.speed >= CAR_HIT_FULL_SPEED && p.x < QUIET_STREET_X / 2 && p.z > -150);
    if (target === null) {
      console.log('  control: SKIPPED: no moving ambient car on the street at this instant.');
      failures.push('No moving ambient car for the pedestrian control; the check could not run.');
    } else {
      const t = target;
      put(sim, c, t.x + t.dx * 25, t.z + t.dz * 25, 0);
      c.combat.body.position.set(t.x + t.dx * 25, t.y + EYE_HEIGHT, t.z + t.dz * 25);
      let ticks = 0;
      for (; ticks < REAL_TIME_TICKS; ticks++) {
        Bun.sleepSync(REAL_TIME_STEP_MS);
        sim.step(out);
        if (c.combat.phase !== 'idle') break;
      }
      console.log(
        `  control: the same spot in the same lane, **on foot**, after ${ticks + 1} ticks: ` +
          `phase '${c.combat.phase}', health ${c.combat.health.toFixed(1)}`,
      );
      if (c.combat.phase === 'idle') {
        failures.push('A pedestrian standing in a lane of moving traffic was not run down. The knockdown is gone, not gated.');
      }
    }
  }

  return failures;
}

function main(): number {
  const failures = [...run(), ...runCrashes()];
  if (failures.length === 0) {
    console.log('\ncardamage-check: OK');
    return 0;
  }
  console.log(`\ncardamage-check: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exit(main());
