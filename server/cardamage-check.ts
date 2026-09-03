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
// WORKSTREAM AA: the empty index every `ServerWorld` fixture now needs.
import { SpatialHash } from '../client/src/game/spatialhash.ts';
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
// WORKSTREAM W: the talent fixture. `fakeTeamLookup` is exported by `teamfx.ts`
// precisely so the drivers can install one without building a real roster.
import { fakeTeamLookup, fxPoliceHitScale, pinTeamLookup } from '../client/src/game/teamfx.ts';
// --- WORKSTREAM AP: the police damage roll. `runPolice` asserts the owner's
// "1:10 dice roll" in the owner's units and asserts that the sequence repeats;
// `factions.verifyPolice` owns the distribution and the range shape.
import {
  FIRE_INTERVAL_TICKS,
  POLICE_TUNED_RANGE,
  SHOT_DAMAGE,
  hitChance,
  policeShotLands,
} from '../client/src/game/factions.ts';
import { FX, TEAM, type TeamLookup } from '../client/src/game/teams.ts';
import { MAX_HEALTH } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import {
  CAR_HEALTH_MAX,
  CRASH_COOLDOWN_MS,
  CAR_SMOKING_HEALTH,
  CAR_SMOKING_SCALE,
  CRASH_DAMAGE_MAX,
  // WORKSTREAM AP: the free allowance, which sections 1b and 1c are the two
  // sides of. See `driving.CRASH_FREE_SPEED`.
  CRASH_FREE_SPEED,
  DRIVE_ACCELERATION,
  DRIVE_TOP_SPEED,
  NOSE_SHED,
  crashDamage,
  type DrivenCar,
} from '../client/src/game/driving.ts';
// --- WORKSTREAM Y: the fire. Every number the sections below assert about
// burning, exploding and chaining comes from here rather than from a literal, so
// a retune moves the check with the feature. See `game/carfire.ts`.
import {
  BLAST_M,
  CHAIN_DAMAGE,
  CHAIN_M,
  FUSE_S,
  SCORCH_S,
  fuseRemainingS,
  isBurning,
} from '../client/src/game/carfire.ts';

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
 * How many runs at the wall section 2 will sit through before giving up. **40.**
 *
 * It was 8, and the eight was fine when the worst single crash was 45 hp of 100.
 * WORKSTREAM AP took the flat-out wall to 6.8 hp and the smoking penalty
 * stretches the tail (a car under 40 hp is capped at 26.4 m/s, which is 2.2 hp a
 * run), so writing a car off by driving it into a wall now takes about
 * twenty-seven runs. Forty is comfortably past that and is still a bound rather
 * than a `while (true)`: a car that survives forty is a car this check should
 * fail on rather than hang on.
 */
const WALL_RUNS_MAX = 40;

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
    hexes: [],
    collision,
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    // WORKSTREAM AA: an index over nothing, which is what `ServerWorld` now
    // requires and what a fixture with no powerups in it should hand back. See
    // `game/powerups.PowerupField.residentIndex`.
    pointIndex: new SpatialHash<number>(),
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
  // --- WORKSTREAM AP: **the owner's number, measured through the whole tick.**
  //
  // *"a full-speed 44 m/s square wall hit should cost ~5-8 of 100 hp, not a
  // write-off in two."* It is 6.816: `NOSE_SHED` puts 44 m/s of road speed at
  // 29.04 m/s of delta-v and `(29.04 - 12) x 0.4` is what the curve does with
  // it. Asserted against the *model* rather than against a literal, so the next
  // retune moves the check with the feature -- and against the stated band as
  // well, because the model agreeing with itself is not the property the owner
  // asked for.
  //
  // This assertion used to demand the `CRASH_DAMAGE_MAX` **cap**, exactly, and
  // that is the line the retune changed most: at 45 a top-speed wall saturated
  // the cap, and at 7 it lands just under it. The cap's job is car-on-car now.
  // See `driving.CRASH_DAMAGE_MAX`.
  const cost = first.healthBefore - car.health;
  const model = crashDamage(DRIVE_TOP_SPEED * NOSE_SHED);
  if (Math.abs(cost - model) > 0.01) {
    failures.push(
      `A ${DRIVE_TOP_SPEED} m/s wall cost ${cost.toFixed(3)} hp against the ${model.toFixed(3)} the curve models ` +
        `for a ${NOSE_SHED.toFixed(2)} shed. More than that means the ${CRASH_COOLDOWN_MS} ms cooldown is not ` +
        `swallowing the grind after the impact; less means the probe never reached the wall.`,
    );
  }
  if (!(cost >= 5 && cost <= 8)) {
    failures.push(
      `The worst thing a driver can do to a car on their own cost ${cost.toFixed(2)} hp of ${CAR_HEALTH_MAX}, ` +
        `outside the 5-8 the brief asked for. That is ${Math.ceil(CAR_HEALTH_MAX / cost)} flat-out runs at a ` +
        `brick wall to write a car off.`,
    );
  }
  if (!(cost < CRASH_DAMAGE_MAX)) {
    failures.push(
      `A flat-out wall saturated the ${CRASH_DAMAGE_MAX} hp cap. Since the retune the cap is reachable only by ` +
        `two cars closing on each other; a wall is meant to land under it. See driving.CRASH_DAMAGE_MAX.`,
    );
  }
  // **Barely dented**, which is the retune arriving here. The first heavy wall
  // used to leave a car on 55; it leaves it on 93 now, above the dent line as
  // well as the smoke one, and the whole ladder of consequences has moved out to
  // where a careless driver never reaches it.
  if (car.health <= CAR_SMOKING_HEALTH) {
    failures.push(
      `The worst possible single crash left the car on ${car.health}, at or under the ${CAR_SMOKING_HEALTH} ` +
        `smoke threshold. Since the retune the first heavy wall is barely a dent.`,
    );
  }

  // === 1b. **A 15 m/s wall is free**, which is WORKSTREAM AP's headline and is
  //         the exact inverse of what this section used to assert.
  //
  // It used to measure 16 hp here and call that the fix for "the cars are too
  // weak". The owner's follow-up was *"its way too easy to take vehicle damage,
  // make the threshold much higher"*, and the threshold went to 12 m/s of
  // delta-v -- which, through `NOSE_SHED`, is 18.2 m/s of road speed. Fifteen is
  // under it. Driving into a brick wall at 54 km/h now costs a car **nothing at
  // all**, and that is the sentence this section exists to hold on to.
  //
  // The termination condition had to change with it: the old loop ran until the
  // health moved, and the health does not move any more. So it runs a fixed
  // window and asserts the two halves separately -- **the car really did hit the
  // wall** (it reached 15 m/s and it is stopped dead against the prism at the
  // end) and **it cost nothing**. Without the first half this section would pass
  // just as happily on a car that drove off in the other direction.
  {
    const sim15 = new Simulation(emptyWorld());
    const p15 = sim15.join(0, null);
    const out15: TickOutput = { tick: 0, events: [], snapshot: null };
    // Enough road to reach 15 m/s and no more. The wall's near face is at
    // `-RUN_UP + 2` and the probe reaches `NOSE_REACH` past the driver, so the
    // impact happens 3.8 m short of the prism's centre line.
    const z0 = -RUN_UP + 3.8 + (15 * 15) / (2 * DRIVE_ACCELERATION);
    p15.combat.body.position.set(0, EYE_HEIGHT, z0);
    p15.combat.body.yaw = 0;
    p15.input.yaw = 0;
    p15.history.seed(sim15.tick, 0, EYE_HEIGHT, z0, 0);
    const car15 = sim15.cars.take(
      { identity: 0xf1feed, body: 0, colour: 0, x: 0, y: 0, z: z0, yaw: 0, parked: true },
      p15.combat.id,
    )!;
    p15.combat.drivingCar = car15.id;
    p15.input.forward = 1;
    let top15 = 0;
    for (let i = 0; i < 900; i++) {
      sim15.step(out15);
      if (p15.combat.carSpeed > top15) top15 = p15.combat.carSpeed;
    }
    p15.input.forward = 0;
    const cost15 = CAR_HEALTH_MAX - car15.health;
    console.log(
      `  run 1b: reached ${top15.toFixed(2)} m/s, held against the wall at z = ` +
        `${p15.combat.body.position.z.toFixed(1)} doing ${p15.combat.carSpeed.toFixed(2)} m/s, ` +
        `cost ${cost15.toFixed(2)} hp (the free allowance is ${CRASH_FREE_SPEED} m/s of delta-v, which is ` +
        `${(CRASH_FREE_SPEED / NOSE_SHED).toFixed(1)} m/s of road speed)`,
    );
    if (Math.abs(top15 - 15) > 1.5) {
      failures.push(`The 15 m/s section reached ${top15.toFixed(2)} m/s; the run-up is wrong, not the damage.`);
    }
    // It hit the wall: stopped dead, up against it, with the throttle still down.
    if (!(p15.combat.carSpeed < 0.5)) {
      failures.push(
        `The 15 m/s section finished at ${p15.combat.carSpeed.toFixed(2)} m/s with the throttle held. It never ` +
          `reached the wall, so "it cost nothing" proves nothing.`,
      );
    }
    if (!(p15.combat.body.position.z < -RUN_UP + 8)) {
      failures.push(`The 15 m/s section stopped at z = ${p15.combat.body.position.z.toFixed(1)}, short of the wall at ${(-RUN_UP + 2).toFixed(1)}.`);
    }
    // And it cost nothing at all.
    if (cost15 !== 0) {
      failures.push(
        `Driving into a wall at 15 m/s cost ${cost15.toFixed(2)} hp. It is meant to be free: ` +
          `${(15 * NOSE_SHED).toFixed(1)} m/s of delta-v is under the ${CRASH_FREE_SPEED} m/s allowance. ` +
          `"Its way too easy to take vehicle damage" is not fixed.`,
      );
    }
    if (Math.abs(crashDamage(15) - 1.2) > 1e-9) {
      failures.push(`The retuned curve puts a square 15 m/s *impact* at ${crashDamage(15)} hp, not 1.2.`);
    }
  }

  // === 1c. **And a wall that is not free**, so the section above is a tuning
  //         and not a car that has stopped taking damage at all.
  //
  // Thirty metres a second -- 108 km/h, which is not a speed anybody reaches by
  // accident on a suburban street -- is 19.8 m/s of delta-v and costs 3.1 hp.
  // That is the shape of the whole retune in one pair of sections: the crash you
  // have every few minutes is free and the one you have to work for is a
  // thirtieth of a car.
  {
    const sim30 = new Simulation(emptyWorld());
    const p30 = sim30.join(0, null);
    const out30: TickOutput = { tick: 0, events: [], snapshot: null };
    const z0 = -RUN_UP + 3.8 + (30 * 30) / (2 * DRIVE_ACCELERATION);
    p30.combat.body.position.set(0, EYE_HEIGHT, z0);
    p30.combat.body.yaw = 0;
    p30.input.yaw = 0;
    p30.history.seed(sim30.tick, 0, EYE_HEIGHT, z0, 0);
    const car30 = sim30.cars.take(
      { identity: 0xf30fed, body: 0, colour: 0, x: 0, y: 0, z: z0, yaw: 0, parked: true },
      p30.combat.id,
    )!;
    p30.combat.drivingCar = car30.id;
    p30.input.forward = 1;
    let atImpact = 0;
    for (let i = 0; i < 900; i++) {
      atImpact = p30.combat.carSpeed;
      sim30.step(out30);
      if (car30.health < CAR_HEALTH_MAX) break;
    }
    p30.input.forward = 0;
    const cost30 = CAR_HEALTH_MAX - car30.health;
    const want = crashDamage(atImpact * NOSE_SHED);
    console.log(
      `  run 1c: hit the wall at ${atImpact.toFixed(2)} m/s, cost ${cost30.toFixed(2)} hp (model ${want.toFixed(2)})`,
    );
    if (Math.abs(atImpact - 30) > 1.5) {
      failures.push(`The 30 m/s section hit the wall at ${atImpact.toFixed(2)} m/s; the run-up is wrong, not the damage.`);
    }
    if (!(cost30 > 0)) {
      failures.push('A 30 m/s wall cost nothing. The retune has gone past a tuning and removed the mechanic.');
    }
    if (Math.abs(cost30 - want) > 0.1) {
      failures.push(
        `A ${atImpact.toFixed(1)} m/s wall cost ${cost30.toFixed(2)} hp against the ${want.toFixed(2)} the curve ` +
          `predicts for a ${NOSE_SHED.toFixed(2)} shed. Either the probe or the curve has moved.`,
      );
    }
    // And it is a long way short of what the old curve charged for the same
    // drive: `(19.8 - 5) x 3.2` was 47, clamped to the old 45 cap. This is the
    // complaint, measured.
    if (!(cost30 < 5)) {
      failures.push(`Driving into a wall at 30 m/s still costs ${cost30.toFixed(1)} hp. Cars do not last 20-50x longer.`);
    }
  }

  // === 2. Back up and do it again, until it is finished. A damaged car is
  //        slower off the line *and* slower at the top, so every run after the
  //        first is a smaller crash -- which is the shape the feature wants: the
  //        first heavy wall is a warning and the car gets progressively harder
  //        to finish off rather than more fragile.
  let runs = 1;
  /** Has the smoking-handling assertion had its run yet? See below. */
  let measuredSmoking = false;
  while (car.health > 0 && runs < WALL_RUNS_MAX) {
    place(0);
    const again = chargeTheWall(1800);
    runs++;
    console.log(
      `  run ${runs}: top ${again.top.toFixed(2)} m/s, health ${again.healthBefore.toFixed(1)} -> ` +
        `${car.health.toFixed(1)}  (cost ${(again.healthBefore - car.health).toFixed(1)})`,
    );
    // The degraded handling, measured on **the first run that starts under the
    // smoke threshold** rather than on run 2.
    //
    // It used to be run 2 unconditionally, and the retune broke that: the worst
    // single crash is 45 now rather than 60, so a healthy car comes out of its
    // first wall on 55 -- above the line -- and reaches the full top speed again
    // on its second. Keying on the health the run *began* with is what makes
    // this the check it was written to be (does the mirror reach the integrator)
    // rather than a check on where the constants happen to land.
    if (again.healthBefore <= CAR_SMOKING_HEALTH && !measuredSmoking) {
      measuredSmoking = true;
      if (Math.abs(again.top - DRIVE_TOP_SPEED * CAR_SMOKING_SCALE) > 0.5) {
        failures.push(
          `A smoking car reached ${again.top.toFixed(2)} m/s against the ` +
            `${(DRIVE_TOP_SPEED * CAR_SMOKING_SCALE).toFixed(1)} CAR_SMOKING_SCALE promises. The degraded ` +
            `handling is not reaching the integrator through the health mirror.`,
        );
      }
    }
  }
  if (!measuredSmoking) {
    failures.push('No run at the wall ever started under the smoke threshold, so the degraded handling was never measured.');
  }
  console.log(
    `  written off after ${runs} runs at the wall, final health ${car.health}, ` +
      `burning ${isBurning(car.burningMs)} (${fuseRemainingS(car.burningMs).toFixed(2)} s of fuse left)`,
  );
  if (car.health !== 0) {
    failures.push(`${WALL_RUNS_MAX} runs at a wall left the car on ${car.health.toFixed(1)}, not written off.`);
  }
  // --- WORKSTREAM AP: **the band, in both directions.**
  //
  // The lower bound is the owner's *"cars should last 20-50 times longer"* and
  // the upper one is the other half of the same sentence, which nobody writes
  // down: a car that cannot be destroyed is not a tougher car, it is a car with
  // no damage model. Twelve to thirty-five deliberate full-throttle runs at a
  // brick wall, and the number the retune actually produces is about
  // twenty-seven -- fifteen of them if the car stayed healthy, and the rest
  // stretched out by `CAR_SMOKING_SCALE` capping a broken car at 26.4 m/s, which
  // is itself only 2.2 hp a run. A careless driver never gets there. A reckless
  // one gets there in an afternoon, which is the ask.
  if (runs < 12) {
    failures.push(
      `A car was written off in ${runs} runs at a wall. The retune's floor is twelve; anything under it means ` +
        `the curve, the cap or the free allowance has drifted back toward the old numbers.`,
    );
  }
  if (runs >= WALL_RUNS_MAX) {
    failures.push(
      `A car survived ${runs} full-throttle runs at a brick wall. A reckless driver has to be able to finish ` +
        `one -- "20-50 times longer" is not "indestructible".`,
    );
  }
  // **And it caught fire.** The owner's second sentence, measured through the
  // whole tick: the wall filled `carCrashDv`, `stepCars` drained it,
  // `crashDamage` sized it, `CarField.damage` applied it and `ignitesOnCrash`
  // read the result. Every write-off burns -- see `game/carfire.ts`.
  if (!isBurning(car.burningMs)) {
    failures.push('A car driven into a wall until it was written off did not catch fire. Every write-off burns.');
  }

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

  // === 4. And the record that goes on the wire carries both bytes.
  const wire = sim.carRecords().find((r) => r.id === car.id);
  console.log(`  wire record: ${JSON.stringify(wire)}`);
  if (!wire) failures.push('The written-off car is not in `carRecords()`.');
  else {
    if (wire.health !== 0) failures.push(`The wire record says health ${wire.health}, not 0.`);
    // WORKSTREAM Y: and the fuse, which is how every other client in the room
    // learns there is about to be a hole in the street. Zero here is a car that
    // burns on the authority and stands quietly on everybody's screen until it
    // silently disappears.
    if (!(wire.fuse !== undefined && wire.fuse > 0)) {
      failures.push(`The wire record's fuse is ${wire.fuse}; the car is on fire and every client has to be told.`);
    }
  }

  // === 5. **It explodes.** Let the fuse run out through the real tick, and the
  //        record is gone -- but the identity is not handed back.
  //
  // The distinction in that last clause is the whole of `CarField.scorch`:
  // `recycleFarthest` drops a record precisely so the ambient car comes back,
  // and an exploded car must not. Without it, the Camry you just blew up is
  // standing in its parking space again on the next frame, undamaged.
  {
    const identity = car.carId;
    const wasFuse = fuseRemainingS(car.burningMs);
    for (let i = 0; i < Math.ceil(FUSE_S * 60) + 30 && sim.cars.get(car.id) !== undefined; i++) sim.step(out);
    console.log(
      `  after the ${wasFuse.toFixed(1)} s fuse: record ${sim.cars.get(car.id) ? 'STILL THERE' : 'gone'}, ` +
        `identity still suppressed ${sim.cars.suppressed(identity)}`,
    );
    if (sim.cars.get(car.id) !== undefined) failures.push(`A burning car was still there ${FUSE_S} s after it caught. The fuse never ran out.`);
    if (!sim.cars.suppressed(identity)) {
      failures.push('An exploded car handed its identity back. The burnt car is standing at the kerb again.');
    }
    // ...and it is still suppressed a good deal later, because the scorch is
    // permanent and not a second clock somebody has to remember to wind.
    for (let i = 0; i < SCORCH_S * 60; i++) sim.step(out);
    if (!sim.cars.suppressed(identity)) {
      failures.push(`An exploded car's identity came back ${SCORCH_S} s later. The scorch ledger is not permanent.`);
    }
  }

  // === 6. Nothing expires. A minute of ticks with the player four kilometres
  //        away -- which under the old five-minute clock would have started the
  //        countdown, and under the budget does nothing at all.
  //
  // A **fresh, undamaged** car, which it did not used to need: the wreck this
  // section used to reuse is a crater now, and a minute of ticks is ten fuses.
  place(4000);
  const parked = sim.cars.take(
    { identity: 0xdecaf, body: 0, colour: 0, x: 0, y: 0, z: 4000, yaw: 0, parked: true },
    0,
  )!;
  const before = sim.cars.size;
  for (let i = 0; i < 60 * 60; i++) sim.step(out);
  console.log(`  after a minute of ticks with the player 4 km away: ${sim.cars.size} record(s), was ${before}`);
  if (sim.cars.size !== before || sim.cars.get(parked.id) === undefined) {
    failures.push('A car standing empty 4 km from anybody was removed after a minute. Cars do not despawn.');
  }
  if (isBurning(parked.burningMs)) failures.push('A car nobody has touched caught fire on its own.');

  return failures;
}

/**
 * --- WORKSTREAM Y: **the bang.** A car written off, six seconds of burning, and
 * what is left standing around it.
 *
 * The one thing `verifyCarFire` cannot answer. That check owns the rules -- the
 * ignition test, the countdown, the falloff at 0/3.5/7/8 m -- and every one of
 * them is a pure function of numbers handed to it. What it cannot see is whether
 * the *whole server tick* joins them up: `CarField.age` advancing the fuse,
 * `stepCarFires` noticing it has expired, `explodeCar` removing the record,
 * scorching the identity, reaching every combatant in the radius through
 * `applyBlastHit`, and reaching every car in `CHAIN_M` through the same
 * `CarField.damage` a wall goes through. Every one of those is a place the chain
 * could silently stop, and every failure is a car that quietly disappears.
 *
 * The write-off is applied with `CarField.damage` rather than by driving into a
 * wall, and that is deliberate rather than lazy: the wall path is already
 * measured three sections up (it is what proves the fire is *reached*), and what
 * this section needs is a fire that starts at a **known instant and a known
 * place**, with bystanders already standing where they are meant to be. Driving
 * a car into a wall first and then teleporting people around it afterwards would
 * spend most of the fuse doing the arranging.
 *
 * No wall in this world, on `runCrashes`' argument: a prism down the same street
 * would put `crashFromClamp`'s answer into the middle of a measurement of the
 * blast's.
 */
function runFire(): string[] {
  const failures: string[] = [];
  console.log('\n--- WORKSTREAM Y: a wreck catches fire, burns for six seconds and explodes');

  const sim = new Simulation(emptyWorld(false));
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const driver = sim.join(0, null);
  const bystander = sim.join(0, null);
  const distant = sim.join(0, null);

  /** Put a body at (x, z) at rest, facing north. `runCrashes`' `put`. */
  const put = (p: Participant, x: number, z: number): void => {
    p.combat.body.position.set(x, EYE_HEIGHT, z);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.yaw = 0;
    p.input.yaw = 0;
    p.input.forward = 0;
    p.input.right = 0;
    p.combat.carSpeed = 0;
    p.history.seed(sim.tick, x, EYE_HEIGHT, z, 0);
  };

  // The car that is about to go off, with its driver sitting in it, at the
  // origin. **The driver stays in**, because "an explosion is the one thing that
  // does eject you" is a clause of this feature that nothing else in the game
  // does any more -- see `game/carfire.ts` section 4 -- and the only way to
  // measure it is to have somebody there.
  put(driver, 0, 0);
  const doomed = sim.cars.take(
    { identity: 0xb0bbed, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    driver.combat.id,
  )!;
  driver.combat.drivingCar = doomed.id;
  const identity = doomed.carId;

  // A bystander four metres away: inside `BLAST_M`, so they lose pips and go
  // over, and far enough out that the falloff is doing something.
  put(bystander, 4, 0);
  // ...and a control at twenty, who must be untouched. Without this the section
  // cannot tell "the blast worked" from "everybody in the room was knocked down".
  put(distant, 20, 0);

  // A second **car** eight metres away: outside the seven-metre blast on people
  // and inside the nine-metre chain, which is the gap those two constants exist
  // to produce. Nobody in it, so this measures the chain and not a second driver.
  const neighbour = sim.cars.take(
    { identity: 0xc4a12, body: 0, colour: 0, x: 8, y: 0, z: 0, yaw: 0, parked: true },
    0,
  )!;

  // Write it off through the one funnel every impact uses. It catches fire on
  // this line -- `ignitesOnCrash`'s first clause -- and the fuse starts.
  sim.cars.damage(doomed.id, CAR_HEALTH_MAX);
  if (!isBurning(doomed.burningMs)) {
    failures.push('Writing a car off through CarField.damage did not set it alight; the rest of this section is meaningless.');
    return failures;
  }
  const driverHealthBefore = driver.combat.health;
  const neighbourBefore = neighbour.health;

  // --- Halfway through the fuse: still burning, still there, and the driver is
  //     being cooked. `carfire.BURN_PIPS_PER_S`.
  for (let i = 0; i < Math.round(FUSE_S * 60 * 0.5); i++) sim.step(out);
  const midFuse = fuseRemainingS(doomed.burningMs);
  const driverMid = driver.combat.health;
  console.log(
    `  half way: ${midFuse.toFixed(2)} s of fuse left, record still there ${sim.cars.get(doomed.id) !== undefined}, ` +
      `driver ${driverHealthBefore.toFixed(2)} -> ${driverMid.toFixed(2)} pips`,
  );
  if (sim.cars.get(doomed.id) === undefined) failures.push('The car went off half way through its fuse.');
  if (!(midFuse > 0 && midFuse < FUSE_S)) failures.push(`Half way through a ${FUSE_S} s fuse there were ${midFuse} s left.`);
  if (!(driverMid < driverHealthBefore)) {
    failures.push('Sitting in a burning car cost the driver nothing. The burn is the warning you can read on your own bar.');
  }

  // --- And out the other side.
  for (let i = 0; i < Math.round(FUSE_S * 60 * 0.5) + 30; i++) sim.step(out);
  console.log(
    `  after the ${FUSE_S} s fuse:\n` +
      `      record ${sim.cars.get(doomed.id) ? 'STILL THERE' : 'gone'}, identity suppressed ${sim.cars.suppressed(identity)}\n` +
      `      driver (0 m):     ${driver.combat.health.toFixed(2)} pips, phase '${driver.combat.phase}', ` +
      `drivingCar ${driver.combat.drivingCar}\n` +
      `      bystander (4 m):  ${bystander.combat.health.toFixed(2)} pips, phase '${bystander.combat.phase}'\n` +
      `      control (20 m):   ${distant.combat.health.toFixed(2)} pips, phase '${distant.combat.phase}'\n` +
      `      car at 8 m:       ${neighbourBefore} -> ${neighbour.health.toFixed(1)} hp, burning ${isBurning(neighbour.burningMs)}`,
  );

  if (sim.cars.get(doomed.id) !== undefined) failures.push(`The car was still there ${FUSE_S} s after it caught fire.`);
  if (!sim.cars.suppressed(identity)) {
    failures.push('An exploded car handed its identity back to the timetable. A burnt car reappears at the kerb.');
  }
  // The driver: hurt, on the floor, and **out of the car**.
  if (!(driver.combat.health < driverMid)) failures.push('The blast did not hurt the driver sitting in the car it destroyed.');
  if (driver.combat.drivingCar !== 0) {
    failures.push('The driver was still driving a car that no longer exists. An explosion is the one thing that ejects you.');
  }
  // The bystander: hurt, and by *less* than the driver, which is the falloff.
  if (!(bystander.combat.health < MAX_HEALTH)) {
    failures.push(`A bystander ${4} m from an explosion lost nothing; the blast reaches ${BLAST_M} m.`);
  }
  if (bystander.combat.phase === 'idle') failures.push('A bystander inside the blast was not knocked down.');
  if (!(bystander.combat.health > driver.combat.health)) {
    failures.push(
      `The bystander at 4 m (${bystander.combat.health.toFixed(2)}) came off no better than the driver at 0 m ` +
        `(${driver.combat.health.toFixed(2)}). The damage falls off with distance.`,
    );
  }
  // The control: untouched. This is what stops the section passing on a blast
  // that reached the whole room.
  if (distant.combat.health !== MAX_HEALTH || distant.combat.phase !== 'idle') {
    failures.push(
      `Somebody ${20} m away lost health (${distant.combat.health}) or went down ('${distant.combat.phase}'). ` +
        `The blast is ${BLAST_M} m.`,
    );
  }
  // And the chain: 40 hp on the car at eight metres, which is inside `CHAIN_M`
  // and outside `BLAST_M`.
  const chained = neighbourBefore - neighbour.health;
  if (Math.abs(chained - CHAIN_DAMAGE) > 0.01) {
    failures.push(
      `A car ${8} m from the explosion took ${chained.toFixed(1)} hp against carfire.CHAIN_DAMAGE's ` +
        `${CHAIN_DAMAGE}. The chain reaches ${CHAIN_M} m.`,
    );
  }
  if (isBurning(neighbour.burningMs)) {
    failures.push(
      `A healthy car took ${CHAIN_DAMAGE} hp from a blast and caught fire. Ignition is for a car that was ` +
        'already broken, or one the hit finished off -- see carfire.ignitesOnCrash.',
    );
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

/**
 * --- WORKSTREAM W: the same wall, with `Ute Life` taken.
 *
 * The one thing `verifyTeamFx` cannot answer: `fxCrashDamageScale` is a number,
 * and this is whether that number *arrives* -- through `combat.advance` filling
 * `carCrashDv` from the nose probe, `sim.stepCars` draining it,
 * `driving.crashDamage` sizing it and `CarField.damage` reading the talent off
 * `car.driverId` at the moment of impact. Every one of those is a place the
 * driver's identity could be lost, and losing it renders a perfectly good frame
 * with a health bar that simply moves the wrong amount.
 *
 * **Two runs, same wall, same speed, one lookup apart.** Comparing a talented
 * run against a stock one rather than against a literal is what makes this
 * robust to the tuning constants moving: if `CRASH_DAMAGE_PER_SPEED` changes
 * tomorrow both numbers change together and the ratio is still 0.7.
 *
 * The lookup carries **only** `CRASH_DAMAGE_TAKEN`, deliberately. Real `Ute
 * Life` also carries `CAR_HEALTH`, and `fxCarDamageScale` folds the two into one
 * multiplier -- so a fixture with the whole node would measure 0.7 / 1.25 = 0.56
 * and would not tell you which half was wrong. The second run adds the health
 * clause back and asserts the product.
 */
function runUteLife(): string[] {
  const failures: string[] = [];
  console.log('\n--- WORKSTREAM W: the same wall with Ute Life, through Simulation.step');

  /** One car, one wall, one lookup. Returns the health the crash cost. */
  const crashOnce = (lookup: TeamLookup | null): number => {
    pinTeamLookup(lookup);
    const sim = new Simulation(emptyWorld());
    const p = sim.join(0, null);
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    p.combat.body.position.set(0, EYE_HEIGHT, 0);
    p.combat.body.yaw = 0;
    p.input.yaw = 0;
    p.history.seed(sim.tick, 0, EYE_HEIGHT, 0, 0);
    const car = sim.cars.take(
      { identity: 0xc0ffee, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
      p.combat.id,
    )!;
    p.combat.drivingCar = car.id;
    const before = car.health;
    p.input.forward = 1;
    // Under the cap, which the top-speed wall now is on its own: 6.816 against a
    // `CRASH_DAMAGE_MAX` of 7. That was not true when this comment was written
    // -- the cap was 45 and a top-speed wall saturated it, which would have made
    // both runs report exactly 45 and this check vacuous -- and it is worth
    // keeping the warning even though the retune happens to have removed the
    // hazard. If the cap ever comes back down to where a wall clips it, the two
    // runs below stop being a measurement of the talent. `run()`'s section 1
    // asserts the wall stays under the cap, which is what actually holds it.
    for (let i = 0; i < 1800; i++) {
      sim.step(out);
      if (car.health < before) break;
    }
    p.input.forward = 0;
    pinTeamLookup(null);
    return before - car.health;
  };

  // A crash short enough to stay under the cap, so the multiplier is visible.
  // The wall is at `RUN_UP` and the car accelerates from rest; breaking on the
  // first tick the health moves is the impact and nothing after it.
  const stock = crashOnce(null);
  const armoured = crashOnce(fakeTeamLookup({ [FX.CRASH_DAMAGE_TAKEN]: 0.3 }, TEAM.DEFAULT));
  console.log(`  stock: ${stock.toFixed(2)} hp   ute life: ${armoured.toFixed(2)} hp`);
  if (!(stock > 0)) {
    failures.push('The stock car took no damage at all; the run is not reaching the wall.');
  } else if (Math.abs(armoured / stock - 0.7) > 0.02) {
    failures.push(
      `Ute Life's -30% crash damage came out as x${(armoured / stock).toFixed(3)}, not x0.7. ` +
        `The driver's talent is not reaching CarField.damage.`,
    );
  }

  // And the whole node, health clause included: 0.7 / 1.25 = 0.56.
  const whole = crashOnce(
    fakeTeamLookup({ [FX.CRASH_DAMAGE_TAKEN]: 0.3, [FX.CAR_HEALTH]: 0.25 }, TEAM.DEFAULT),
  );
  console.log(`  whole node: ${whole.toFixed(2)} hp  (expected x0.56 of stock)`);
  if (stock > 0 && Math.abs(whole / stock - 0.56) > 0.02) {
    failures.push(
      `The whole Ute Life node came out as x${(whole / stock).toFixed(3)} of stock, not x0.56. ` +
        `See teamfx.fxCarDamageScale: +25% health is a divisor on the damage.`,
    );
  }

  // And the crash cooldown, which is the other half of the node and is a
  // property of the record rather than of the arithmetic.
  pinTeamLookup(fakeTeamLookup({ [FX.CRASH_COOLDOWN_S]: 0.3 }, TEAM.DEFAULT));
  const sim = new Simulation(emptyWorld(false));
  const p = sim.join(0, null);
  const car = sim.cars.take(
    { identity: 0xbeef, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    p.combat.id,
  )!;
  sim.cars.damage(car.id, 5);
  if (Math.abs(car.damageCooldownMs - 300) > 1) {
    failures.push(`Ute Life left a ${car.damageCooldownMs} ms crash cooldown, not 300.`);
  }
  pinTeamLookup(null);
  const stockSim = new Simulation(emptyWorld(false));
  const sp = stockSim.join(0, null);
  const sc = stockSim.cars.take(
    { identity: 0xbeef, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    sp.combat.id,
  )!;
  stockSim.cars.damage(sc.id, 5);
  if (Math.abs(sc.damageCooldownMs - CRASH_COOLDOWN_MS) > 1) {
    failures.push(`A stock car's crash cooldown is ${sc.damageCooldownMs} ms, not ${CRASH_COOLDOWN_MS}.`);
  }

  return failures;
}

/**
 * --- WORKSTREAM AP: **two kilometres of bad road, and nothing to show for it.**
 *
 * The owner's sentence, as a driver: *"even small bumps in a road alone are
 * giving damage"*. It is the one section here that would have failed before this
 * workstream and it would have failed enormously -- twenty-four kerbs at a full
 * crash apiece, capped only by the half-second cooldown.
 *
 * **What the bug actually was**, because it decides the shape of this fixture.
 * `CollisionWorld.solidFor` reads `feetY >= prism.top - 0.05`, and the step
 * allowance is the *caller's* to add: `controller.step` asks at
 * `feet + STEP_HEIGHT`, so the driver's own capsule walks over anything under
 * 0.42 m. `driving.stepCarSpeed`'s nose probe asked at a bare `feetY`. So every
 * kerb in Sydney was thin air to the body and a brick wall to the bonnet 1.8 m
 * in front of it -- the car did not stop, it simply shed two thirds of its speed
 * and took a crash, invisibly, for a bump. See `driving.NOSE_STEP`.
 *
 * So the road here is made of the geometry that triggered it: **twenty-four
 * prisms 0.1 to 0.4 m tall laid across two kilometres of straight road**, which
 * is a kerb, a driveway lip, a bridge joint and a road-edge band. They are real
 * `CollisionWorld` prisms and the car really drives over them -- `roofHeight`
 * lifts it onto each one and gravity drops it off the far side, which is the
 * vertical jolt half of the report as well as the prism half.
 *
 * And **a real wall at the end**, which is what stops this being a section that
 * passes because nothing in it works. The same drive that costs zero over the
 * bumps has to cost exactly one flat-out crash when it reaches something that is
 * genuinely in the way.
 */
function runRough(): string[] {
  const failures: string[] = [];
  console.log('\n--- WORKSTREAM AP: 2 km of kerbs and bumps at full throttle, and a wall at the end');

  /** How far apart the bumps are, metres, and how many there are. */
  const BUMP_SPACING = 80;
  const BUMPS = 24;
  /** The wall's near face, metres north. Past the last bump with room to spare. */
  const WALL_Z = -(BUMPS + 1) * BUMP_SPACING;
  /** The four heights, cycled. Every one of them is under `controller.STEP_HEIGHT`. */
  const BUMP_HEIGHTS = [0.1, 0.2, 0.3, 0.4];

  const world = emptyWorld(false);
  const prisms: Array<{ points: Float32Array; height: number; base: number }> = [];
  for (let i = 1; i <= BUMPS; i++) {
    const z = -i * BUMP_SPACING;
    // 60 m of carriageway wide and 0.6 m deep, which is a kerb across the road
    // rather than a step the car could steer round.
    prisms.push({
      points: new Float32Array([-30, z - 0.3, 30, z - 0.3, 30, z + 0.3, -30, z + 0.3]),
      height: BUMP_HEIGHTS[i % BUMP_HEIGHTS.length],
      base: 0,
    });
  }
  world.collision.addPrisms('bumps', prisms);
  // The control. Three metres tall, so no step allowance in the game reaches
  // over it and the nose probe has to see it.
  world.collision.addPrisms('endwall', [{
    points: new Float32Array([-30, WALL_Z - 2, 30, WALL_Z - 2, 30, WALL_Z + 2, -30, WALL_Z + 2]),
    height: 3,
    base: 0,
  }]);

  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const p = sim.join(0, null);
  p.combat.body.position.set(0, EYE_HEIGHT, 0);
  p.combat.body.yaw = 0;
  p.input.yaw = 0;
  p.input.right = 0;
  p.history.seed(sim.tick, 0, EYE_HEIGHT, 0, 0);
  const car = sim.cars.take(
    { identity: 0xb00b1e, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    p.combat.id,
  )!;
  p.combat.drivingCar = car.id;
  p.input.forward = 1;

  // --- The drive. Stopped one bump short of the wall, so the two halves of this
  //     section never overlap.
  const STOP_Z = WALL_Z + BUMP_SPACING * 0.5;
  let lastY = p.combat.body.position.y;
  /** The biggest single-tick change in height. The vertical jolt, measured. */
  let jolt = 0;
  let top = 0;
  let ticks = 0;
  for (; ticks < 6000 && p.combat.body.position.z > STOP_Z; ticks++) {
    sim.step(out);
    const dy = Math.abs(p.combat.body.position.y - lastY);
    if (dy > jolt) jolt = dy;
    lastY = p.combat.body.position.y;
    if (p.combat.carSpeed > top) top = p.combat.carSpeed;
  }
  const travelled = -p.combat.body.position.z;
  const crossed = Math.floor(travelled / BUMP_SPACING);
  console.log(
    `  drove ${travelled.toFixed(0)} m over ${crossed} kerbs in ${ticks} ticks, topping ${top.toFixed(1)} m/s, ` +
      `biggest vertical jolt ${jolt.toFixed(2)} m: health ${CAR_HEALTH_MAX} -> ${car.health.toFixed(2)}, ` +
      `burning ${isBurning(car.burningMs)}`,
  );

  // The drive has to have *happened*, which is three separate ways this fixture
  // could pass while proving nothing: a car that never moved, a car that never
  // reached the bumps, and a car that drove along the road beside them.
  if (!(travelled > 1900)) {
    failures.push(`The rough drive covered ${travelled.toFixed(0)} m of the intended 2 km; it measured almost nothing.`);
  }
  if (crossed < 12) failures.push(`The rough drive crossed ${crossed} kerbs. The section needs a dozen at least.`);
  if (!(jolt > 0.05)) {
    failures.push(
      `The biggest vertical movement in two kilometres was ${jolt.toFixed(3)} m. The car never went over a ` +
        `kerb at all, so "it took no damage" is a statement about an empty road.`,
    );
  }
  if (!(top > 30)) failures.push(`The rough drive topped out at ${top.toFixed(1)} m/s; the bumps are stopping the car.`);

  // **And it cost nothing.** The report, as one comparison.
  if (car.health !== CAR_HEALTH_MAX) {
    failures.push(
      `Two kilometres of rough road and ${crossed} kerbs cost ${(CAR_HEALTH_MAX - car.health).toFixed(2)} hp. ` +
        `A bump the body steps over is free -- see driving.NOSE_STEP, which is the argument the nose probe ` +
        `used to be missing.`,
    );
  }
  if (isBurning(car.burningMs)) failures.push('Driving over kerbs set the car on fire.');

  // --- The control: the same car, the same throttle, into something that really
  //     is in the way. One crash exactly, at the flat-out price.
  const beforeWall = car.health;
  for (let i = 0; i < 900 && car.health >= beforeWall; i++) sim.step(out);
  for (let i = 0; i < 120; i++) sim.step(out);
  p.input.forward = 0;
  const wallCost = beforeWall - car.health;
  const model = crashDamage(DRIVE_TOP_SPEED * NOSE_SHED);
  console.log(
    `  ...then the 3 m wall at z = ${WALL_Z}: ${beforeWall.toFixed(1)} -> ${car.health.toFixed(2)} hp ` +
      `(cost ${wallCost.toFixed(2)}, model ${model.toFixed(2)})`,
  );
  if (!(wallCost > 0)) {
    failures.push(
      'The wall at the end of the rough road cost nothing either. The nose probe has stopped seeing solids ' +
        'altogether, which is not the fix -- see driving.NOSE_STEP.',
    );
  } else if (Math.abs(wallCost - model) > 0.2) {
    failures.push(
      `The wall at the end cost ${wallCost.toFixed(2)} hp against the ${model.toFixed(2)} a flat-out square ` +
        `hit models. More than one crash means the kerbs behind it are being billed after all.`,
    );
  }

  return failures;
}

/**
 * --- WORKSTREAM AP: **the police dice roll.**
 *
 * *"a 1:10 dice roll for cops shooting you to do any dmg."* A hundred rounds,
 * counted, and then the same hundred rounds counted again -- which is the half
 * of this that a distribution check cannot see. A `Math.random` in this path
 * produces a perfectly plausible one-in-ten and desynchronises the browser's
 * prediction of a pursuit from the server's authority for as long as it lasts,
 * with nothing on either screen that says so.
 *
 * `factions.verifyPolice` owns the distribution over twenty thousand samples and
 * the composition with `Blue Line`. What is here is the owner's sentence in the
 * owner's units, plus the determinism, plus the one thing neither of those
 * covers: that a hundred rounds at the tuned range is a *survivable* amount of
 * fire. Ten landings at `SHOT_DAMAGE` is five pips against a three-pip player,
 * where 55 landings was twenty-seven.
 */
function runPolice(): string[] {
  const failures: string[] = [];
  console.log('\n--- WORKSTREAM AP: a hundred police rounds at the tuned range');

  /** One officer emptying a hundred rounds at one suspect, tick by tick. */
  const volley = (officer: number, target: number, range: number, missScale = 1): boolean[] => {
    const out: boolean[] = [];
    for (let shot = 1; shot <= 100; shot++) {
      // `FIRE_INTERVAL_TICKS` between rounds, exactly as the officer's `think`
      // spaces them, so this is the sequence a real pursuit produces and not a
      // hundred rolls off consecutive integers.
      out.push(policeShotLands(officer, target, shot * FIRE_INTERVAL_TICKS, shot, range, missScale));
    }
    return out;
  };

  const first = volley(11, 4, POLICE_TUNED_RANGE);
  const landed = first.filter(Boolean).length;
  console.log(
    `  100 rounds at ${POLICE_TUNED_RANGE} m: ${landed} landed (${(landed * SHOT_DAMAGE).toFixed(1)} pips of ` +
      `damage against a ${MAX_HEALTH}-pip player; before the roll it was ` +
      `${(100 * hitChance(POLICE_TUNED_RANGE) * SHOT_DAMAGE).toFixed(1)})`,
  );
  if (landed < 5 || landed > 15) {
    failures.push(
      `${landed} of 100 police rounds landed at ${POLICE_TUNED_RANGE} m. The owner asked for one in ten and the ` +
        `band this check allows is 5 to 15. See factions.POLICE_LAND_SCALE.`,
    );
  }

  // **The same seed twice.** Byte for byte, or the pursuit is not predictable.
  const again = volley(11, 4, POLICE_TUNED_RANGE);
  let drift = -1;
  for (let i = 0; i < first.length; i++) {
    if (first[i] !== again[i]) { drift = i; break; }
  }
  console.log(`  the same hundred rounds again: ${drift < 0 ? 'identical' : `DIFFERED at round ${drift + 1}`}`);
  if (drift >= 0) {
    failures.push(
      `Round ${drift + 1} of the same volley came out differently the second time. The roll must be a hash of ` +
        `(officer, target, tick, shot) and never a clock -- see factions.policeShotLands.`,
    );
  }

  // And a different suspect standing in the same place at the same instant gets
  // a different volley, which is the term the old roll was missing.
  const other = volley(11, 5, POLICE_TUNED_RANGE);
  let same = true;
  for (let i = 0; i < first.length; i++) if (first[i] !== other[i]) { same = false; break; }
  if (same) failures.push('Two different suspects drew the identical hundred rounds; the target id is not in the hash.');

  // `Blue Line` halves it, through the real talent lookup rather than through a
  // bare argument -- `fxPoliceHitScale` is the thing `factions.ts` actually
  // calls, and until this workstream the ground police never called it at all.
  pinTeamLookup(fakeTeamLookup({ [FX.POLICE_MISS]: 0.5 }, TEAM.DEFAULT));
  const scale = fxPoliceHitScale(4);
  pinTeamLookup(null);
  const shielded = volley(11, 4, POLICE_TUNED_RANGE, scale).filter(Boolean).length;
  console.log(`  ...with Blue Line (x${scale} hit scale): ${shielded} of 100 landed`);
  if (Math.abs(scale - 0.5) > 1e-9) failures.push(`Blue Line gave a hit scale of ${scale}, not 0.5.`);
  if (!(shielded < landed)) {
    failures.push(`Blue Line let ${shielded} rounds through against ${landed} without it. The talent must multiply the 10 % base.`);
  }

  return failures;
}

function main(): number {
  const failures = [...run(), ...runRough(), ...runPolice(), ...runCrashes(), ...runUteLife(), ...runFire()];
  if (failures.length === 0) {
    console.log('\ncardamage-check: OK');
    return 0;
  }
  console.log(`\ncardamage-check: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exit(main());
