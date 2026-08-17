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

import { Simulation, type TickOutput } from './sim.ts';
import type { ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import {
  CAR_HEALTH_MAX,
  CAR_SMOKING_HEALTH,
  CAR_SMOKING_SCALE,
  CRASH_DAMAGE_MAX,
  DRIVE_ACCELERATION,
  DRIVE_TOP_SPEED,
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

/** `verifySim`'s empty city, with one wall across the road at the end of the run-up. */
function emptyWorld(): ServerWorld {
  const collision = new CollisionWorld();
  collision.addPrisms('wall', [{
    points: new Float32Array([-20, -RUN_UP - 2, 20, -RUN_UP - 2, 20, -RUN_UP + 2, -20, -RUN_UP + 2]),
    height: 8,
    base: 0,
  }]);
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

function run(): number {
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

  if (failures.length === 0) {
    console.log('\ncardamage-check: OK');
    return 0;
  }
  console.log(`\ncardamage-check: ${failures.length} failure(s)`);
  for (const f of failures) console.log(`  - ${f}`);
  return 1;
}

process.exit(run());
