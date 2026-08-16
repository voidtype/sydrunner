/**
 * Drawing the cars people have taken, and the four seams that takes.
 *
 * The renderer half of `game/driving.ts`, on exactly the split `world/bike.ts`
 * makes against `game/bikes.ts`: that file is the rules and this one is the
 * picture, and this one is the only one of the two that may import three.
 *
 * ---------------------------------------------------------------------------
 * IT DRAWS ALMOST NOTHING ITSELF, AND THAT IS THE DESIGN.
 *
 * A driven car needs a body, a paint, a shadow, a headlight after dark and a
 * real 3D model when you are close enough to see one. Every single one of those
 * already exists in this client for the ambient fleet -- `world/cars.ts`,
 * `world/carlod.ts`, `world/nightlights.ts` -- and building a second set of them
 * for the two or three cars a room has stolen would be building the *only* cars
 * in Sydney that could look different from the traffic.
 *
 * So this class owns no mesh. What it owns is the four small pieces of glue that
 * let the existing systems draw a car whose pose comes from a `CarField` record
 * instead of from `traffic.poseCar`:
 *
 *   1. `source` -- `TrafficMovers.driven`, which puts driven cars through the
 *      same box fill, the same paint, the same shadow and the same model claim
 *      as the fleet parked behind them.
 *   2. `claims` -- `CarModelFleet.drivenClaims`, so a driven car is eligible for
 *      a real model. It is the *nearest* car in the world by construction, so it
 *      is the one place a box would be most obvious.
 *   3. `suppress` -- the predicate both of those consult to stop drawing the
 *      ambient copy of a car somebody has taken. See `game/driving.ts` section 3
 *      for why suppression is a predicate and not a delete.
 *   4. `brakes` -- the one genuinely new thing, and it is a call into
 *      `CarLights.addBrake` rather than a mesh of its own.
 *
 * ---------------------------------------------------------------------------
 * WHERE A DRIVEN CAR ACTUALLY IS, WHICH IS NOT WHERE ITS RECORD SAYS.
 *
 * `MSG.CARS` carries a pose, and while somebody is driving that pose is only as
 * fresh as the last time the record changed -- which for a car taken two minutes
 * ago is two minutes stale. That is deliberate and is the whole reason the
 * feature costs no bandwidth: **an occupied car is derived from its driver**,
 * who is already in the snapshot at 20 Hz.
 *
 * Deriving it is this file's job and it has three cases, which are `world/bike.ts`'s
 * three exactly:
 *
 *   - **The local player's car** comes from the predicted eye position, so it
 *     moves on the frame the input does rather than on the next snapshot.
 *   - **A remote driver's car** comes from their *interpolated* position, so the
 *     car and the body sitting in it are on the same 100 ms clock. Drawing the
 *     car at present time would slide the driver along a bonnet a third of a
 *     metre behind them.
 *   - **An empty car** comes from the record, because there is nothing else --
 *     and the record is exact, because a car standing in the street last changed
 *     on the tick its driver got out.
 *
 * `driverPose` is how the caller answers the first two; returning false is how
 * it says "this driver is outside my interest set", and the record is the
 * fallback. That is not a failure case: a car whose driver you cannot see is a
 * car you are about to lose sight of anyway, and one stale frame at the edge of
 * a 180 m radius is not a thing that exists.
 */

import { CAR_BODY_SIZE, createCarPose, drivenCarPose, type CarPose } from '../game/traffic.ts';
import { DRIVE_TOP_SPEED, type CarField } from '../game/driving.ts';
import type { DrivenCarSource } from './cars.ts';
import type { CarLights } from './nightlights.ts';

/** Where a driver's body is this frame, filled by the caller. */
export interface DriverPose {
  x: number;
  /** **Feet**, not eye: a car sits on the road the driver is standing on. */
  y: number;
  z: number;
  yaw: number;
}

/**
 * How hard the brake has to be on before the lamps come up, as a fraction of
 * the top speed shed per second.
 *
 * Not "the player is holding S", which is what a first cut does and is wrong in
 * the one case that matters: a driver holding S at a standstill is not braking,
 * they are reversing, and a reversing car with its brake lights on is a car with
 * a fault. So the test is on the *deceleration* -- the speed actually falling,
 * measured frame to frame -- which catches the handbrake and a wall for free and
 * catches neither of the two cases that are not braking.
 *
 * 0.08 of the top speed a second is 1.8 m/s^2, well under the 2.2 of
 * `DRIVE_COAST`, so lifting off does not light them.
 */
const BRAKE_THRESHOLD = 0.12;

/**
 * How much the camera rolls into a corner at full lock, radians. About 2.6
 * degrees.
 *
 * **The camera and not the body**, and this is the one place this workstream
 * did not do what the brief asked. The brief wanted the car's body to roll and
 * pitch, and the box fleet cannot express it: `TrafficMovers` composes every
 * car's matrix from a `CarPose`'s two-component heading through a half-angle
 * quaternion with no third axis in it -- deliberately, because that is the
 * arithmetic that keeps two hundred cars a frame down to one square root each.
 * Adding a roll would mean either a third component on a record the ambient
 * fleet fills two hundred times a frame, or a second draw path for driven cars
 * only, which is exactly the "the car you steer does not look like traffic"
 * this file exists to avoid.
 *
 * Rolling the *camera* instead delivers the same read for two lines and no cost,
 * and in third person -- which driving forces -- it is arguably the better of
 * the two: what a player feels in a corner is their own view tipping, and a body
 * rolling five degrees under a camera that does not is a suspension animation.
 */
export const DRIVE_CAM_ROLL = 0.045;

/** And how far the view dips under a full stop. About 1.7 degrees. */
export const DRIVE_CAM_DIP = 0.03;

/** How fast the roll and the dip follow their targets, seconds. `rideLean`'s 0.14. */
const CAM_EASE = 0.14;

/**
 * Everything the client does about a car somebody is driving.
 *
 * One per session, constructed before the first frame and handed the *getter*
 * for the field rather than the field, because which `CarField` is live changes
 * with the connection: online it is `net.cars`, offline it is a local one, and
 * `main.ts` flips between them exactly as `bikeWorld()` already does for the
 * bikes.
 */
export class DrivenCarView {
  /** Feed for `world/cars.TrafficMovers.driven`. */
  readonly source: DrivenCarSource;
  /** Feed for `world/carlod.CarModelFleet.drivenClaims`. */
  readonly claims: (visit: (pose: CarPose) => void) => void;
  /** Predicate for both of those. `game/driving.CarField.suppressed`. */
  readonly suppress: (identity: number) => boolean;

  /** Cars posed last frame. On the dev overlay. */
  drawn = 0;
  /** The eased camera roll and dip, radians. Read by `main.ts`'s camera block. */
  camRoll = 0;
  camDip = 0;

  private readonly pose: CarPose = createCarPose();
  private readonly brakePose: CarPose = createCarPose();
  private readonly driverScratch: DriverPose = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Last frame's speed per driver, for the deceleration test. See `BRAKE_THRESHOLD`. */
  private readonly lastSpeed = new Map<number, number>();

  constructor(
    private readonly field: () => CarField,
    /**
     * Where a driver's body is *right now on screen*, or false when this client
     * cannot see them. See the header.
     */
    private readonly driverPose: (driverId: number, out: DriverPose) => boolean,
    /**
     * The record id of the car **this client** is driving, or 0.
     *
     * Asked before `driverPose` and by record id rather than by driver id, which
     * is deliberate and covers two cases at once. Online it is the frame: the
     * local car is posed from the predicted body rather than waiting for the
     * record's driver to be resolved. Offline it is correctness -- `main.ts`
     * gives the offline local player the combatant id 0, which is also the
     * field's "nobody is in it" sentinel, so a driver-id lookup cannot tell your
     * own car from an abandoned one. See `CarField.follow`, which carries the
     * same paragraph.
     */
    private readonly localCar: () => number,
  ) {
    this.source = { forEach: (visit) => this.forEach(visit) };
    this.claims = (visit) => this.forEach(visit);
    this.suppress = (identity) => this.field().suppressed(identity);
  }

  /**
   * Every driven car, as a `CarPose`, at where it is on screen this frame.
   *
   * Called twice a frame -- once by the draw loop and once by the model sweep at
   * 5 Hz -- and allocates nothing: the pose is this object's and is handed to
   * the visitor by reference, which is the same contract `forEachCarNear` has
   * and for the same reason.
   */
  private forEach(visit: (pose: CarPose) => void): void {
    let n = 0;
    for (const car of this.field().all()) {
      const out = this.pose;
      drivenCarPose(car, out);
      const mine = car.id === this.localCar();
      if ((mine || car.driverId !== 0) && this.driverPose(mine ? -1 : car.driverId, this.driverScratch)) {
        const d = this.driverScratch;
        out.x = d.x;
        out.y = d.y;
        out.z = d.z;
        // Re-derive the heading from the live yaw. `drivenCarPose` already did
        // it from the record's, which for an occupied car is stale by however
        // long ago the record last changed.
        out.dx = -Math.sin(d.yaw);
        out.dz = -Math.cos(d.yaw);
      }
      n++;
      visit(out);
    }
    this.drawn = n;
  }

  /**
   * Brake lamps, and the camera's own lean, once a frame.
   *
   * `localCar` is the record id of the car this client is driving, or 0, and
   * `localSpeed` is its **predicted** speed -- `CombatantState.carSpeed`, which
   * is the number the local integrator produced this frame rather than the one
   * the last `MSG.CARS` happened to carry. `steer` is the yaw delta the wheel
   * produced, as a fraction of full lock.
   *
   * Every driven car gets its brake test; only the local one gets the camera,
   * because the camera is the local player's.
   */
  update(lights: CarLights, localCar: number, localSpeed: number, steer: number, dt: number): void {
    lights.beginBrakes();
    const live = new Set<number>();
    this.forEach((pose) => {
      // The identity is the source car's -- see `drivenCarPose` -- which is what
      // keys this map, and is stable for the life of the record.
      live.add(pose.identity);
      const was = this.lastSpeed.get(pose.identity);
      // `pose.speed` is a magnitude, which is exactly what the deceleration test
      // wants: shedding speed reads the same whichever way the car is pointing.
      const now = pose.speed;
      this.lastSpeed.set(pose.identity, now);
      if (was === undefined || dt <= 1e-6) return;
      const shed = (was - now) / dt;
      if (shed < BRAKE_THRESHOLD * DRIVE_TOP_SPEED) return;
      // A stopped car is not braking, it is stopped -- otherwise every car
      // anybody parks sits at the kerb with its brake lights on forever.
      if (now < 0.5 && was < 0.5) return;
      lights.addBrake(this.brakeFrom(pose));
    });
    lights.endBrakes();
    // A record that has gone -- expired, or its ambient car handed back -- takes
    // its history with it, or this map is a slow leak keyed on every car anybody
    // in the session ever stole.
    if (this.lastSpeed.size > live.size) {
      for (const key of [...this.lastSpeed.keys()]) if (!live.has(key)) this.lastSpeed.delete(key);
    }

    // --- The camera's lean. See `DRIVE_CAM_ROLL`.
    const driving = localCar !== 0;
    // Roll scales with speed as well as with lock, because a car turning its
    // wheel at a crawl is a three-point turn and does not lean at all.
    const grip = Math.min(1, Math.abs(localSpeed) / DRIVE_TOP_SPEED);
    const rollTarget = driving ? Math.max(-1, Math.min(1, steer)) * grip * DRIVE_CAM_ROLL : 0;
    const dipTarget = driving && lights !== null ? this.dipTarget(localSpeed, dt) : 0;
    const ease = Math.min(1, 1 - Math.exp(-dt / CAM_EASE));
    this.camRoll += (rollTarget - this.camRoll) * ease;
    this.camDip += (dipTarget - this.camDip) * ease;
  }

  /** Last frame's local speed, for the dip. Kept apart from the per-car map. */
  private lastLocal = 0;

  private dipTarget(speed: number, dt: number): number {
    const was = this.lastLocal;
    this.lastLocal = speed;
    if (dt <= 1e-6) return 0;
    const shed = (Math.abs(was) - Math.abs(speed)) / dt;
    if (shed <= 0) return 0;
    // Full dip at a full-strength stop, which is the handbrake's 16 m/s^2.
    return Math.min(1, shed / 16) * DRIVE_CAM_DIP;
  }

  /** A copy of a pose, because `addBrake` is called from inside `forEach`'s visit. */
  private brakeFrom(pose: CarPose): CarPose {
    const out = this.brakePose;
    out.x = pose.x;
    out.y = pose.y;
    out.z = pose.z;
    out.dx = pose.dx;
    out.dz = pose.dz;
    out.body = pose.body;
    out.scale = pose.scale;
    out.stage = pose.stage;
    return out;
  }
}

/**
 * The HUD line beside a car you could get into, or ''.
 *
 * A **pure function of the state, evaluated every frame**, which is
 * `game/bikes.ridePrompt`'s hard-won rule and the reason that function exists:
 * the reported bug it was written for was a nudge that got *set* on an event and
 * had exactly one line in the client that took it down again, so every other way
 * to leave the state stranded it forever. There is no "set" here and no "clear";
 * there is only what is true now.
 *
 * `near` is whether `resolveTake` (or an empty record within reach) found
 * anything this frame. `driving` is whether you are already in one.
 */
export function takePrompt(near: boolean, driving: boolean, phase: string): string {
  if (phase === 'ko') return '';
  if (driving) return 'E — get out';
  if (!near) return '';
  return 'E — take the car';
}

/** The speed readout, km/h, as the vitals area wants it. */
export function speedText(metresPerSecond: number): string {
  const kmh = Math.round(Math.abs(metresPerSecond) * 3.6);
  return `${kmh} km/h`;
}

/**
 * What this catches that a typecheck cannot.
 *
 *   - **A prompt that sticks.** The bikes' reported bug, one feature over: a
 *     player knocked out beside a car being told to press E forever.
 *   - **A speed readout in the wrong unit.** 22 m/s reading as "22" is a car
 *     that looks like it is crawling, and nobody reports a units bug -- they
 *     report that driving feels slow.
 *   - **Brake lights on a parked car.** The whole street lit up red is the most
 *     visible possible failure of the deceleration test, and it happens the
 *     moment somebody writes `if (input.forward < 0)`.
 */
export function verifyDrivenCars(): string[] {
  const failures: string[] = [];

  if (takePrompt(true, false, 'idle') === '') failures.push('Standing beside a takeable car said nothing.');
  if (takePrompt(false, false, 'idle') !== '') failures.push('A prompt appeared with no car anywhere near.');
  if (takePrompt(true, true, 'idle') !== 'E — get out') failures.push('A driver was told to take the car they are in.');
  if (takePrompt(true, false, 'ko') !== '') {
    failures.push('A body on the pavement was told to press E. This is the bikes\' reported bug, one feature over.');
  }
  if (takePrompt(true, true, 'ko') !== '') failures.push('A knocked-out driver kept the "get out" prompt.');

  if (speedText(22) !== '79 km/h') failures.push(`22 m/s reads as "${speedText(22)}"; it is 79 km/h.`);
  if (speedText(0) !== '0 km/h') failures.push(`A stopped car reads as "${speedText(0)}".`);
  // Reverse is a speed, not a negative one: nobody's dashboard counts down.
  if (speedText(-6.6) !== '24 km/h') failures.push(`Reversing at 6.6 m/s reads as "${speedText(-6.6)}".`);

  if (!(DRIVE_CAM_ROLL > 0 && DRIVE_CAM_ROLL < 0.2)) {
    failures.push(`DRIVE_CAM_ROLL is ${DRIVE_CAM_ROLL} rad; anything past about 0.2 is a barrel roll.`);
  }
  if (!(DRIVE_CAM_DIP > 0 && DRIVE_CAM_DIP < DRIVE_CAM_ROLL)) {
    failures.push(`The brake dip (${DRIVE_CAM_DIP}) is not smaller than the corner roll (${DRIVE_CAM_ROLL}).`);
  }
  // The lamps have to fit on the bodies they are hung off.
  if (CAR_BODY_SIZE.length === 0) failures.push('There are no car body sizes to hang a brake lamp on.');

  return failures;
}
