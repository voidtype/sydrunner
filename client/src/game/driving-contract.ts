/**
 * The four questions the rideshare job asks about cars, and nothing else.
 *
 * A **contract module**: it declares an interface and one inert implementation
 * of it, and it deliberately contains no cars. The real `game/driving.ts` --
 * with `Simulation.cars`, the vehicle physics and the seat -- is being built in
 * a parallel workstream and does not exist in this branch at all. Writing
 * SydRide against `import { CarField } from './driving.ts'` would have meant a
 * branch that does not compile until somebody else's does, which is the one
 * thing six parallel branches cannot afford.
 *
 * So this file is the seam, and it is deliberately the smallest seam that can
 * carry the feature:
 *
 *   - `carOf(playerId)` -- which car this player is driving, or 0.
 *   - `carPose(carId)` -- where that car is and how fast, or null.
 *
 * That is all a fare needs. It never asks what the car looks like, whether it
 * has a passenger seat, who else is in it or how it steers. **The passenger is
 * invisible this round** for exactly that reason: a seat is a fact about a
 * vehicle model, and this module is written so that the day a real `CarField`
 * arrives the lead wires one call and nothing in `game/cash.ts` or
 * `server/sim.ts` changes.
 *
 * ---------------------------------------------------------------------------
 * WHY `NO_DRIVING` IS A CONSTANT RATHER THAN A NULL
 *
 * `Simulation` takes a `DrivingLookup` and defaults to this one, so every call
 * site is an unconditional method call rather than a `?.` -- which matters in a
 * 60 Hz tick, and matters more for readability: the fare state machine has
 * eleven branches and adding "or there are no cars in this build" to each of
 * them would have doubled it. With this constant, a world with no cars is a
 * world where every player's `carOf` is 0, which the state machine already
 * handles because it is the same answer as "on foot".
 *
 * The same trick as `game/pedestrians.ts`'s zero-slot band: the empty case is
 * the ordinary case with a zero in it, never a separate path.
 */

/** Where a car is this instant. Metres and m/s, in the world frame. */
export interface CarPoseOut {
  x: number;
  y: number;
  z: number;
  /** Yaw in the controller's convention -- 0 faces -Z. */
  yaw: number;
  /** Plan speed, m/s. What "stopped at the kerb" is measured against. */
  speed: number;
}

/**
 * What the fare loop is allowed to know about cars.
 *
 * Exactly the shape the driving workstream published, and not a byte more:
 * widening it here would be this branch making a decision about somebody else's
 * module.
 */
export interface DrivingLookup {
  /** The car this player is **driving**, or 0. A passenger is not a driver. */
  carOf(playerId: number): number;
  /** That car's pose, or null if the id is not a live car. */
  carPose(carId: number): CarPoseOut | null;
}

/**
 * The lookup for a world with no cars in it. Every player is on foot, forever.
 *
 * Frozen, because it is a shared singleton handed to every `Simulation` in the
 * process and a test that mutated it would change the answer for every room.
 */
export const NO_DRIVING: DrivingLookup = Object.freeze({
  carOf: (): number => 0,
  carPose: (): CarPoseOut | null => null,
});

/**
 * **The debug hatch: anybody moving faster than a person is "driving".**
 *
 * `SYDNEY_FAKE_DRIVING=1` on the server, or `?fakedriving=1` on the client,
 * installs this in place of `NO_DRIVING`, and it is what made the fare loop
 * testable in a branch with no cars: a tuned e-bike does 3x and a sprint on a
 * Flat White does 13 m/s, so either is enough to be offered a fare, drive to a
 * kerb, stop, and be paid.
 *
 * It is deliberately **kept** rather than removed when the real cars land. A
 * hatch that lets one person on foot exercise the whole state machine without a
 * second player and a vehicle is worth more as a permanent debug hook than the
 * six lines it costs, and it is off unless somebody sets an environment
 * variable.
 *
 * **6 m/s is under a sprint on purpose**, which is the one thing about this
 * number that looks like a mistake and is not. A walk is 4.1 m/s and a sprint
 * is 8.2, so with the hatch on, *holding shift is enough to be a taxi* -- which
 * is exactly what makes it a test hatch rather than a second gameplay mode. A
 * threshold above a sprint would need a tuned e-bike from Redfern before the
 * fare loop could be exercised at all, and the whole point is to be able to
 * check it on foot in ten seconds. Nothing about it is subtle enough to leave
 * on by accident: it needs `SYDNEY_FAKE_DRIVING=1`, and the server says so in
 * its boot line.
 *
 * The "car id" it reports is the player's own id, which is safe because the
 * only thing the state machine does with a car id is compare it to 0 and to the
 * previous tick's -- and a real `CarField` will never issue an id that collides
 * with anything here, because this lookup is never installed beside one.
 */
export const FAKE_DRIVING_SPEED = 6;

/** Where the hatch reads its bodies from. One position and one speed per player. */
export interface FakeDrivingSource {
  /** Called for one player id; returns their pose, or null if they are gone. */
  poseOf(playerId: number): CarPoseOut | null;
}

export function fakeDriving(source: FakeDrivingSource): DrivingLookup {
  return {
    carOf(playerId: number): number {
      const pose = source.poseOf(playerId);
      return pose !== null && pose.speed > FAKE_DRIVING_SPEED ? playerId : 0;
    },
    carPose(carId: number): CarPoseOut | null {
      return source.poseOf(carId);
    },
  };
}

/**
 * The contract, asserted -- which sounds like asserting nothing and is not.
 *
 * `NO_DRIVING` is the default every `Simulation` in the process runs with, and
 * the failure it can have is specific: something mutates the frozen object (a
 * test installing a stub by assignment rather than by construction) and every
 * room in the host silently starts believing a player is in a car. That is a
 * fare loop running against a body that is walking, which pays out and looks
 * like a gameplay decision.
 */
export function verifyDrivingContract(): string[] {
  const failures: string[] = [];

  if (NO_DRIVING.carOf(1) !== 0) failures.push('NO_DRIVING put player 1 in a car.');
  if (NO_DRIVING.carPose(1) !== null) failures.push('NO_DRIVING produced a pose for a car that does not exist.');
  if (!Object.isFrozen(NO_DRIVING)) {
    failures.push('NO_DRIVING is not frozen; one test could put every room in the host into a car.');
  }

  // The hatch: under the threshold is on foot, over it is driving, and the
  // pose comes straight back out.
  {
    let speed = 0;
    const source: FakeDrivingSource = {
      poseOf: (id) => (id === 7 ? { x: 1, y: 2, z: 3, yaw: 0, speed } : null),
    };
    const hatch = fakeDriving(source);
    speed = FAKE_DRIVING_SPEED - 0.1;
    if (hatch.carOf(7) !== 0) failures.push(`The fake-driving hatch called ${speed} m/s driving.`);
    speed = FAKE_DRIVING_SPEED + 0.1;
    if (hatch.carOf(7) !== 7) failures.push(`The fake-driving hatch called ${speed} m/s walking.`);
    if (hatch.carOf(8) !== 0) failures.push('The fake-driving hatch put an unknown player in a car.');
    const pose = hatch.carPose(7);
    if (pose === null || pose.x !== 1 || pose.z !== 3) failures.push('The fake-driving hatch lost the pose.');
    // Reachable on foot, which is the hatch's entire purpose -- a threshold
    // above a sprint (8.2 m/s) would need a tuned e-bike before the fare loop
    // could be exercised at all. Asserted as a number rather than left to the
    // comment, because "raise it a bit so walking does not trigger it" is
    // exactly the well-meaning edit that would quietly disable the hatch.
    if (!(FAKE_DRIVING_SPEED > 4.1 && FAKE_DRIVING_SPEED < 8.2)) {
      failures.push(
        `The fake-driving threshold is ${FAKE_DRIVING_SPEED} m/s. It has to sit between a walk ` +
          '(4.1) and a sprint (8.2), or the hatch is either always on or unreachable on foot.',
      );
    }
  }

  return failures;
}
