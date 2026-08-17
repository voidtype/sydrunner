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

import {
  CAR_BODY_SIZE,
  createCarPose,
  drivenCarPose,
  forEachCarNear,
  type CarPose,
  type LaneRoute,
  type TrafficField,
} from '../game/traffic.ts';
import { CAR_HEALTH_MAX, DRIVE_TOP_SPEED, carIsSmoking, type CarField } from '../game/driving.ts';
import type { DrivenCarSource } from './cars.ts';
import type { CarLights } from './nightlights.ts';
import type { CarSmoke } from './carsmoke.ts';

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
    /**
     * Is a car standing here close enough to be worth drawing? Optional, and
     * absent means "everything", which is what every caller written before the
     * budget meant and is still true of `verifyDrivenCars`.
     *
     * **This exists because cars stopped despawning.** The field used to hold
     * the two or three cars a room had stolen in the last five minutes and this
     * loop could walk all of them; `game/driving.MAX_DRIVEN_CARS` is now 400,
     * spread over sixty kilometres of Sydney, and posing every one of them
     * twice a frame is eight hundred `Math.sin`/`Math.cos` pairs to place cars
     * in Penrith that nobody can see.
     *
     * The gate is on the **record's** stored position, before `drivenCarPose`
     * runs, so a car out of range costs one subtract and one compare. And it is
     * the *record's* position on purpose, not the driver's: a remote driver
     * whose car is beyond the gate is beyond it either way, and reaching for
     * their interpolated pose to decide whether to reach for their interpolated
     * pose is a question that answers itself.
     */
    private readonly near: (x: number, z: number) => boolean = () => true,
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
      // The range gate, before the pose. See the `near` constructor argument:
      // the field holds up to four hundred records spread over the whole city
      // now that cars no longer despawn, and this is what stops the draw loop
      // paying for the ones in Penrith.
      //
      // **On the record's own coordinates**, which for an *occupied* car are as
      // stale as the last `MSG.CARS` -- and that is fine at this radius: a car
      // whose record is 400 m away and whose driver has since crossed into range
      // is a car whose driver is doing 22 m/s and will be re-broadcast within
      // the second. The gate is generous for exactly this reason.
      if (!this.near(car.x, car.z)) continue;
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
  update(
    lights: CarLights,
    localCar: number,
    localSpeed: number,
    steer: number,
    dt: number,
    /**
     * The plume rig, or null. Optional so `verifyDrivenCars` and any caller
     * written before the crash damage keeps working.
     *
     * Fed from inside *this* walk rather than from a pass of its own, on
     * `TrafficMovers.lights`' argument exactly: this loop already computes the
     * exact on-screen pose of every driven car, and a second pass that had to
     * agree with it is how a plume ends up hanging over an empty parking space.
     */
    smoke: CarSmoke | null = null,
    /** Where the view is, for the plume's billboard. Ignored when `smoke` is null. */
    cameraX = 0,
    cameraY = 0,
    cameraZ = 0,
  ): void {
    lights.beginBrakes();
    if (smoke !== null) smoke.begin(dt, cameraX, cameraY, cameraZ);
    const live = new Set<number>();
    this.forEach((pose) => {
      // The identity is the source car's -- see `drivenCarPose` -- which is what
      // keys this map, and is stable for the life of the record.
      live.add(pose.identity);
      // --- The plume, before the brake test, because a wreck standing at a kerb
      // fails every clause of that test and still has to smoke. Handed *every*
      // driven car: `CarSmoke.add` grades the pose through `driving.damageGrade`
      // and returns immediately for anything that is not smoking, so the
      // threshold lives in one place rather than here as well.
      if (smoke !== null) smoke.add(pose);
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
    if (smoke !== null) smoke.end();
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

// --- The horn a car gives somebody standing in front of it ------------------------

/**
 * How long a player has to stand in a lane before the car behind them leans on
 * the horn, seconds. The brief's 1.
 *
 * A dwell rather than an edge, and that is the whole design: an ambient car
 * passes within a few metres of somebody on a footpath a dozen times a minute in
 * town, and a horn on proximity would be the city permanently beeping. What is
 * being detected is a *person standing in the road*, which is a thing that takes
 * a second to establish.
 */
export const HONK_DWELL = 1;

/** How far in front of a car counts as "in front of it", metres. */
const HONK_REACH = 9;
/** And how far to either side. A lane, near enough. See `traffic.HOLD_LANE_HALF`. */
const HONK_HALF_WIDTH = 2.4;
/** How slow a car has to be to be *stuck* rather than simply approaching, m/s. */
const HONK_MAX_SPEED = 3;
/** How long after a honk before the same street is allowed another, seconds. */
const HONK_COOLDOWN = 4;

/**
 * Whether an ambient car is currently leaning on its horn at you.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS CLIENT-SIDE AND WHY THAT IS NOT A COMPROMISE.
 *
 * A horn is a sound and nothing else. It applies no damage, moves nothing,
 * reports no crime and appears in no snapshot -- so the only thing that has to
 * be true of it is that *you* hear it when a car is stuck behind *you*, and the
 * client is the only process that knows where your ears are. Putting it on the
 * server would mean a message id, an interest test and a wire field for an event
 * whose entire consequence is one 0.4 s parp. `game/traffic.ts`'s header makes
 * the same argument about the ambient fleet in general: zero bandwidth, because
 * both ends can evaluate the same lookup.
 *
 * The rule, and each clause is a case that would otherwise fire wrongly:
 *
 *   - the car has to be **near-stationary** (`HONK_MAX_SPEED`), because a car
 *     doing 14 m/s toward you is not stuck behind you, it is about to run you
 *     over, and `traffic.applyCarHit` has that covered;
 *   - you have to be **ahead of it and in its lane**, or every car on the
 *     opposite carriageway honks at a pedestrian on the median;
 *   - you have to have been there for `HONK_DWELL`, so walking across a street
 *     in front of a car at a red is silent;
 *   - and one honk resets a cooldown, because the state persists for as long as
 *     you stand there and an un-cooled version is sixty horns a second.
 *
 * The dwell is a single scalar rather than a per-car map, deliberately: what is
 * being timed is *the player standing still in a lane*, not any particular car's
 * patience, and a map keyed on identity would have to be evicted and would honk
 * afresh every time the queue shuffled.
 */
export class HonkWatch {
  /** Seconds the player has been standing in front of a stopped car. */
  private dwell = 0;
  /** Seconds until the next horn is allowed. */
  private cooldown = 0;

  /**
   * Advance, and return true on the frame a horn should sound.
   *
   * `scratch` and `pose` are the caller's, on `forEachCarNear`'s contract: this
   * runs every frame and must allocate nothing.
   */
  update(
    field: TrafficField,
    x: number,
    z: number,
    tick: number,
    dt: number,
    onFoot: boolean,
    scratch: LaneRoute[],
    pose: CarPose,
  ): boolean {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (!onFoot) {
      // In a car or on a bike you are traffic, not an obstruction. The dwell is
      // reset rather than frozen so getting out again starts the clock afresh.
      this.dwell = 0;
      return false;
    }

    let blocking = false;
    forEachCarNear(field, x, z, HONK_REACH, tick, scratch, pose, (p) => {
      if (p.speed > HONK_MAX_SPEED) return;
      // Am I in front of this car? `(dx, dz)` is its heading and left of it is
      // `(dz, -dx)`, which is `carOverlaps`' own frame and `lanes.py`'s.
      const rx = x - p.x;
      const rz = z - p.z;
      const ahead = rx * p.dx + rz * p.dz;
      if (ahead <= 0 || ahead > HONK_REACH) return;
      const across = rx * p.dz - rz * p.dx;
      if (across > HONK_HALF_WIDTH || across < -HONK_HALF_WIDTH) return;
      // A car in one of its parked stages is furniture and does not honk at
      // anybody -- it is not going anywhere. `carHitStrength` filters the same
      // two stages for the same reason one file over.
      if (p.stage === 0 || p.stage === 4) return;
      blocking = true;
      return true;
    });

    if (!blocking) {
      this.dwell = 0;
      return false;
    }
    this.dwell += dt;
    if (this.dwell < HONK_DWELL || this.cooldown > 0) return false;
    this.cooldown = HONK_COOLDOWN;
    return true;
  }

  /** How long the player has been in the way. The dev overlay. */
  get standing(): number {
    return this.dwell;
  }
}

// --- The car's own health bar -----------------------------------------------------

/**
 * The inline `width` of the car-health bar's fill, as the HUD wants it.
 *
 * A pure function so `verifyDrivenCars` can assert it at boot, on
 * `hud.ballBlockWidth`'s hard-won argument: that function exists because a
 * width written into the DOM outranks any class rule and can only be taken back
 * by another write, and the bug it was written for shipped and was played for a
 * session. The same trap is here -- a bar painted at 1 % by a mispredicted crash
 * and never repainted because the server agreed with the *health* while the
 * width was already wrong -- so the width is computed from the state every
 * frame and there is no "set" and no "clear".
 */
export function carHealthWidth(health: number): string {
  const k = health <= 0 ? 0 : health >= CAR_HEALTH_MAX ? 1 : health / CAR_HEALTH_MAX;
  return `${Math.round(k * 100)}%`;
}

/**
 * Which band the bar is in, as a class name: `''`, `'dented'` or `'wrecked'`.
 *
 * Three names rather than a colour ramp, because the HUD in this project is
 * "four rectangles and a dot" (see `client/index.html`) and a continuously
 * interpolated bar would be the only gradient in it. The three names are the
 * three bands `game/driving.ts` already defines, so the bar changes colour on
 * exactly the health at which the car starts to smoke -- which is the moment the
 * *behaviour* changes, and is therefore the only moment worth marking.
 */
export function carHealthClass(health: number): string {
  if (health <= 0) return 'wrecked';
  if (carIsSmoking(health)) return 'dented';
  return '';
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

  // --- The car-health bar. `hud.ballBlockWidth`'s trap, one feature over: a
  //     width is written into the DOM and only another write can take it back,
  //     so the ends have to be exact or a full bar is painted at 99 % forever
  //     and a written-off one keeps a sliver.
  if (carHealthWidth(CAR_HEALTH_MAX) !== '100%') {
    failures.push(`An undamaged car's bar is "${carHealthWidth(CAR_HEALTH_MAX)}", not full.`);
  }
  if (carHealthWidth(0) !== '0%') failures.push(`A written-off car's bar is "${carHealthWidth(0)}", not empty.`);
  if (carHealthWidth(CAR_HEALTH_MAX * 2) !== '100%') failures.push('A health above the maximum overflowed the bar.');
  if (carHealthWidth(-5) !== '0%') failures.push('A negative health gave the bar a negative width.');
  if (carHealthWidth(CAR_HEALTH_MAX / 2) !== '50%') failures.push('A half-wrecked car\'s bar is not half full.');
  // The three bands, and the middle one starting exactly where the smoke does.
  if (carHealthClass(CAR_HEALTH_MAX) !== '') failures.push('An undamaged car\'s bar is not in the plain band.');
  if (carHealthClass(0) !== 'wrecked') failures.push('A write-off\'s bar is not in the wrecked band.');
  if (carHealthClass(CAR_HEALTH_MAX * 0.5) !== '') {
    failures.push('A car on half health is in the dented band; the bar changes colour when the smoke starts, not before.');
  }
  if (!carIsSmoking(30) || carHealthClass(30) !== 'dented') {
    failures.push('A smoking car\'s bar is not in the dented band. The two thresholds have drifted apart.');
  }

  // --- The horn. Nothing here needs a `TrafficField`, which is the point of
  //     testing the *dwell* rather than the geometry: the geometry is
  //     `forEachCarNear`'s and is checked in `verifyTraffic`, and what this
  //     catches is a horn that goes off the instant a car appears, or one that
  //     never stops.
  {
    const watch = new HonkWatch();
    // No field, so nothing is ever blocking: the dwell must never start.
    const empty = { near: () => [] } as unknown as TrafficField;
    const scratch: LaneRoute[] = [];
    const pose = createCarPose();
    for (let i = 0; i < 300; i++) {
      if (watch.update(empty, 0, 0, i, 1 / 60, true, scratch, pose)) {
        failures.push('A horn sounded on an empty street.');
        break;
      }
    }
    if (watch.standing !== 0) failures.push(`Standing on an empty street accrued ${watch.standing} s of dwell.`);
    if (!(HONK_DWELL > 0 && HONK_DWELL < 5)) {
      failures.push(`HONK_DWELL is ${HONK_DWELL} s, which is not "somebody is standing in the road".`);
    }
  }

  return failures;
}
