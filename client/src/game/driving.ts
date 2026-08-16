/**
 * Taking a car, and what happens to the street once you have.
 *
 * The gameplay half, and three-free by rule so the Bun server runs this exact
 * file -- the split `game/bikes.ts` against `world/bike.ts` makes, and the one
 * `game/traffic.ts` makes against `world/cars.ts`. Nothing here imports three,
 * nothing here draws, and every number a driven car has is decided by a function
 * in this file running identically in the browser and on the server.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT A "CAR" IS, AND WHY IT IS A TRAFFIC CAR AND NOT A KERB CAR.
 *
 * There are two fleets of cars in Sydney and they look the same on purpose:
 *
 *   - the **static** fleet, ~875,000 of them baked into `<tile>.cars.bin` and
 *     drawn by `world/cars.buildTileCars`. Scenery. Never moves.
 *   - the **schedule** fleet, a closed-form lookup over `<tile>.lanes.bin`
 *     (`game/traffic.poseCar`), which since the park stages landed spends a good
 *     part of each car's life *stationary in a kerb bay*, at which point
 *     `world/cars.ts`' own header says it is "indistinguishable from the 23,020
 *     already at that kerb".
 *
 * The brief asked for both to be stealable. Only the second one is, and the
 * reason is not laziness -- it is that **the server has no idea the first one
 * exists.** `server/world.ts` streams two layers per hexagon, collision prisms
 * and lane sidecars; `.cars.bin` is a renderer file and is never read outside
 * the browser. Making a kerb car stealable server-authoritatively means a third
 * streaming layer over 13,362 files and 14 MB of parked cars on a 1 GB box, and
 * making it stealable *without* that means the client naming a car the server
 * cannot see -- which is a client that can conjure a vehicle.
 *
 * So every takeable car is a schedule car, and the rule is the brief's own
 * second clause: **stopped or under `TAKEABLE_SPEED`**. That catches a car in a
 * park stage at the kerb (speed exactly 0, and visually a parked car), a car
 * held at a red light, and a car easing out of a bay. `world/cars.TrafficMovers`
 * reports about 41 kerb-parked schedule cars inside its 420 m draw radius at a
 * measured moment in town, which is one every 4,300 m^2 -- so "walk down the
 * street and press E at a car" holds, even though "any car you can see" does
 * not. See the report; this is the one deliberate deviation in the workstream.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CAR YOU ARE DRIVING IS NOT A NEW BODY. IT IS YOUR BODY, GEARED.
 *
 * The obvious implementation is a second integrator -- a chassis, a wheelbase,
 * a slip angle, a `stepCar` beside `controller.step`. `game/bikes.ts` already
 * argued that one out and refused it, and the argument is stronger here, not
 * weaker: a fork is a thing the server has to reproduce exactly, that
 * `net/client.reconcile`'s replay has to run over every un-acked input, and
 * whose first disagreement shows up as a car rubber-banding at 22 m/s.
 *
 * So there is no fork. What this file integrates is **one number** -- the car's
 * signed speed along its own heading -- and then it hands that number to the
 * *existing* controller as a target:
 *
 *     stepCarSpeed(c, input, dt, world)     // c.carSpeed += a . dt, clamped
 *     shapeDriveInput(c, movement)          // speedScale = |carSpeed| / SPRINT
 *
 * `controller.step` then accelerates the body at its usual 48 m/s^2 toward a
 * target speed that is already the car's, which in one tick is a snap -- so the
 * *body* moves at exactly the speed this file decided, through exactly the
 * collision, ground-follow, step-up and gravity every player already gets. A
 * car stops at a wall because a player stops at a wall. Nothing new is on the
 * simulation path except one scalar, and the scalar is a pure function of
 * (previous scalar, buttons, dt) evaluated the same way on both ends.
 *
 * The **steering** is `game/bikes.shapeRideSteering`'s trick verbatim: `A`/`D`
 * become a yaw delta on the client's own look, which is already a
 * client-authoritative input (`protocol.INPUT_BYTES` carries `yaw`), so the
 * server receives a driver who is simply looking somewhere new and runs the
 * step it always ran. Prediction is exact by construction rather than by
 * agreement.
 *
 * What this costs, and it is a real cost stated plainly: the car collides as a
 * 0.34 m player capsule and not as a 4.4 m box. A car can therefore thread a
 * gap no car should fit through. `stepCarSpeed` buys most of that back with a
 * **nose probe** -- one `resolve` call at the far end of the bonnet, which kills
 * the speed when the front of the car is inside something even though the
 * driver's capsule is not -- and that is where the "3 or 4 capsules along its
 * axis" of the brief ended up: two, one of which is the player's own.
 *
 * ---------------------------------------------------------------------------
 * 3. THE AMBIENT CAR HAS TO GO AWAY, AND IT IS A PREDICATE AND NOT A DELETE.
 *
 * A schedule car is a lookup, not an object. There is nothing to remove: the
 * moment you drive off in one, `poseCar` cheerfully keeps producing the original
 * on its timetable, and the street has two of your car in it -- one you are
 * steering and one continuing to Ashfield without you.
 *
 * The fix is the same shape `world/carlod.ts` already uses to stop a model and a
 * box being drawn in one parking space: a **predicate consulted inside the loop
 * that was already running**. `CarField.suppressed(identity)` answers "somebody
 * has taken this one", and it is asked by `world/cars.TrafficMovers.update`
 * (so no box, no headlights, no model claim), by `world/carlod.CarModelFleet`
 * (so an existing claim goes stale and is revoked on its own two-frame rule) and
 * by `game/traffic.carHitting` on **both ends** (so the ghost does not run
 * pedestrians down from inside the car you are sitting in).
 *
 * `identity` is `traffic.identityOf(route, slot)`, a stable 32-bit hash of the
 * route id and the departure -- exactly the "route id + departure" the brief
 * asked the record to carry, already computed, already agreed by every process
 * that read the same world.
 *
 * ---------------------------------------------------------------------------
 * 4. WHO OWNS WHAT.
 *
 * `CarField` is `game/bikes.BikeField` with three differences and they are all
 * consequences of a car being *allocated* where a bike is *planned*:
 *
 *   - **Ids are handed out at runtime, not derived.** There is no `carPlan`,
 *     because the set is not fixed: it is however many cars have been stolen and
 *     not yet expired. So the server allocates `1..n` and the client mirrors
 *     what it is told. That is why `MSG.CARS` carries a delete flag where
 *     `MSG.BIKES` needs none.
 *   - **A record can end.** An empty car left in the street for
 *     `ABANDON_MS` with nobody within `ABANDON_RADIUS` stops being a record and
 *     goes back to being whatever the timetable says it is -- which, because the
 *     ambient car was only ever suppressed and never deleted, is a car back on
 *     its route. It is not written back into the static fleet: there is no
 *     ledger to write to (see section 1), and the schedule fleet is its own
 *     restoration.
 *   - **`follow` carries the pose from the driver**, not the other way round.
 *     The brief is explicit and it is also the only affordable answer: the
 *     driver's position and yaw are already in the 20 Hz snapshot, so a car that
 *     is derived from them costs zero bytes a tick, where a car with its own
 *     pose on the wire costs a record per car per snapshot forever.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM.
 *
 * Everything on the shared path is `+ - * /`, `Math.min/max/abs`, and `Math.imul`
 * by way of `traffic.carHash`. There is no `Math.sin`, `cos`, `pow` or `hypot`
 * in `stepCarSpeed`, `shapeDriveInput`, `driveTurnRate` or `CarField`. The two
 * `Math.atan2` calls in this file are both in `headingYaw`, which is called
 * *once*, in the browser, on the frame you get in, to point your head down the
 * street -- a look direction, which is client-authoritative anyway.
 */

import type { InputSnapshot } from '../player/controller.ts';
import {
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  type CarPose,
  type LaneRoute,
  type TrafficField,
  createCarPose,
  forEachCarNear,
} from './traffic.ts';

// --- The handling ---------------------------------------------------------------

/**
 * Top speed on a road, metres per second. 22 is 79 km/h.
 *
 * The brief's number, and it is the right one for a reason worth writing down:
 * it is a shade *under* the e-bike's 26.2 m/s. A car that outran a lime bike
 * would make the bike -- which is a whole feature with a tuning stall in
 * Redfern -- the slow way to cross the city, and the thing a car has over a bike
 * is that it survives contact with the world, not that it is faster.
 */
export const DRIVE_TOP_SPEED = 22;

/**
 * And off the carriageway. Half, because a sedan across a park is not a rally
 * car and the alternative -- driving being identical everywhere -- makes the
 * road network cosmetic.
 *
 * Whether you are on a road is `DrivingWorld.onRoad`, which both ends answer
 * from the same lane graph, and which is **optional**: a world that cannot say
 * counts as road. That is the correct failure. A client whose lane sidecar has
 * not streamed in yet would otherwise crawl for a second on a street the server
 * knows is a street, and the correction for that is a visible lurch.
 */
export const DRIVE_TOP_SPEED_ROUGH = 11;

/** Metres per second squared under throttle. 0 to 22 m/s in 3.7 s. */
export const DRIVE_ACCELERATION = 6;

/**
 * And on the brake -- `S` against a forward speed. Half again as strong as the
 * throttle, which is what makes `S` read as a brake pedal rather than as a
 * reverse gear you have to wait for.
 */
export const DRIVE_BRAKE = 9;

/**
 * Reverse top speed, as a fraction of the forward one. `game/bikes.RIDE_REVERSE`'s
 * number and its argument: the same key means "slow down" first and "back out of
 * this laneway" second, and 30 % of 22 is 6.6 m/s, which is a reversing speed
 * rather than a manoeuvre nobody asked for.
 */
export const DRIVE_REVERSE = 0.3;

/**
 * Engine braking, with no key held at all.
 *
 * Small on purpose: a car that shed its speed as fast as it gained it would
 * never coast, and coasting is most of what driving in a city is. At 2.2 m/s^2 a
 * car at the top speed rolls for ten seconds and 110 m, which is a city block.
 */
export const DRIVE_COAST = 2.2;

/** Space. Nearly twice the brake, and it works against a reverse too. */
export const DRIVE_HANDBRAKE = 16;

/**
 * How fast the wheel turns at a crawl, radians per second, and at the top speed.
 *
 * `game/bikes.rideTurnRate`'s shape and for its stated reason -- what a driver
 * holds constant across the range is the turn *radius*, and a linear `w(v)`
 * against a linear `v` is the closest a one-line function gets to that. The
 * numbers are heavier than the bike's (1.6 / 0.9) because a car is heavier than
 * a bike: at 22 m/s the radius is 44 m, which is a main-road corner taken at
 * speed, and at 5 m/s it is 4.3 m, which is a three-point turn.
 */
export const DRIVE_TURN_RATE = 1.35;
export const DRIVE_TURN_RATE_FAST = 0.5;
/** Where the ramp bottoms out. The top speed, so nothing in normal play is clamped. */
export const DRIVE_TURN_FULL_SPEED = DRIVE_TOP_SPEED;

/**
 * Below this speed the wheel does less and less, metres per second.
 *
 * The one thing this steering model has that the bike's does not, and it exists
 * because a bike genuinely can be turned on the spot and a car cannot. Without
 * it a stationary car spins like a turntable when you hold `D`, which is the
 * single most arcade-looking thing a car can do. Linear in speed up to 2.5 m/s,
 * so a car creeping out of a bay steers a little and a parked one not at all.
 */
export const DRIVE_TURN_GRIP = 2.5;

// --- Taking one ------------------------------------------------------------------

/**
 * How close to a car you have to be, metres. `game/bikes.MOUNT_RADIUS` exactly,
 * and deliberately the same number: `E` has one meaning in this game and one
 * reach, and a car you can stand beside and not take -- because cars used a
 * different constant -- is a bug report.
 */
export const TAKE_RADIUS = 2.2;

/** And the vertical gate, `bikes.MOUNT_HEIGHT`'s. A car under a viaduct is not yours. */
export const TAKE_HEIGHT = 2.5;

/**
 * How slow a car has to be going before you can pull the door open, m/s.
 *
 * The brief's 3. Parked is 0, a red light is 0, a pull-out ramps through this in
 * about a second, and anything on a green is well past it -- so what this
 * actually says is "stopped, or nearly". Not zero, because a car creeping the
 * last 20 cm into a bay is stationary to a player and 0.4 m/s to `poseCar`, and
 * the failure of an exact test is pressing E at a car that is obviously parked
 * and getting nothing.
 */
export const TAKEABLE_SPEED = 3;

/**
 * How far a pedestrian can be and still see you break into a car, metres.
 *
 * The brief's 15, and the line of sight is checked by the caller against the
 * same `collision.blocked` `factions.policeWitness` uses -- see
 * `bystanderSeen`. A crime nobody saw is not reported, which is the whole of
 * why this number exists: stealing a car at 3 a.m. on a back street in Marrickville
 * should be different from stealing one outside Town Hall at lunchtime.
 */
export const WITNESS_RADIUS = 15;

/** Eye height for the witness ray, and chest height at the crime. `factions.ts`' pair. */
export const WITNESS_EYE = 1.5;
export const CRIME_HEIGHT = 1.0;

// --- Leaving one -----------------------------------------------------------------

/**
 * How long an empty car sits in the street before the city takes it back,
 * milliseconds. Five minutes, the brief's number.
 */
export const ABANDON_MS = 300_000;

/**
 * ...and only if nobody is within this many metres of it, so a car does not
 * vanish out of somebody's windscreen. 60 m is well inside the 420 m the traffic
 * is drawn at, so the disappearance always happens off screen.
 */
export const ABANDON_RADIUS = 60;

// --- Being run over ---------------------------------------------------------------

/**
 * How fast a driven car has to be going to knock somebody down, m/s.
 *
 * The brief's 4, and it is *not* `traffic.CAR_HIT_MIN_SPEED` (1.0) on purpose.
 * An ambient car that nudges you at 1 m/s is the city being the city; a player
 * who has taken a car is a player who will absolutely idle it into a crowd to
 * see what happens, and 4 m/s means you have to actually drive at somebody.
 */
export const RUN_DOWN_SPEED = 4;

// --- The camera and the body roll (cosmetic, client only) -------------------------

/** How far behind the car the chase camera sits, metres. The brief's 7. */
export const DRIVE_CAM_DISTANCE = 7;
/** And how far above the driver's eye. The brief's 2.5. */
export const DRIVE_CAM_LIFT = 2.5;
/** How far the body leans in a full-lock corner at speed, radians. About 5 degrees. */
export const DRIVE_ROLL_MAX = 0.09;
/** And how far it dives under full braking. About 3.5 degrees. */
export const DRIVE_PITCH_MAX = 0.06;

// --- The state ---------------------------------------------------------------------

/**
 * The two fields `shapeDriveInput` and `stepCarSpeed` read off a combatant.
 *
 * A structural type rather than `CombatantState`, on `game/bikes.RideState`'s
 * argument exactly: `combat.ts` imports this file, so this file must not import
 * `combat.ts`, and two fields is a small enough contract to state structurally.
 */
export interface DriveState {
  /** The `CarField` record id this combatant is driving, or 0. */
  drivingCar: number;
  /**
   * Signed speed along the driver's own heading, m/s. Negative is reverse.
   *
   * On the combatant rather than on the car record, and that is load-bearing
   * rather than tidy: it is *movement state*, it has to survive into
   * `combat.advance`'s integrator and into `net/client.reconcile`'s replay, and
   * a second copy of "how fast is this car going" living on the car would be a
   * second opinion about how fast a player is moving. `CarField.follow` copies
   * it out to the record once a tick for the wire, which is the same direction
   * every other field on a car record travels.
   */
  carSpeed: number;
}

/** What `stepCarSpeed`'s nose probe needs of the world. A subset of `combat.CombatWorld`. */
export interface DrivingWorld {
  /**
   * The prism resolver, or null. Absent is a legal world -- a self-check, or the
   * first second of a session before anything has streamed -- and means the nose
   * probe passes everything, which is the correct failure: a car that cannot
   * move until the collision arrives is worse than one that clips a wall once.
   */
  collision: { resolve(fx: number, fz: number, tx: number, tz: number, r: number, feetY: number, headY?: number): { x: number; z: number; hit: boolean } } | null;
  /**
   * Is this point on a carriageway? Optional; absent counts as road. See
   * `DRIVE_TOP_SPEED_ROUGH`.
   */
  onRoad?(x: number, z: number): boolean;
}

/**
 * How far ahead of the driver's capsule the bonnet reaches, metres.
 *
 * Half of a sedan's 4.4 m length less the driver's own 0.34 m radius, rounded
 * down. Deliberately **not** per-body: the probe is a broadphase for "am I about
 * to put the front of this car through a wall", and a probe whose length depends
 * on which of five models you took would make a van handle differently from a
 * hatch in a way no player would ever attribute to the van.
 */
export const NOSE_REACH = 1.8;

/** And how wide the nose is, for the probe's own radius. */
export const NOSE_RADIUS = 0.85;

// --- The integrator ------------------------------------------------------------------

/**
 * Advance one driven car's speed by `dt`. **The whole of the driving model.**
 *
 * Called once per fixed step by the authority (`server/sim.tick`) and once per
 * fixed step by the client predicting its own car (`main.ts`), from the same
 * file with the same numbers, which is what makes the prediction exact rather
 * than close. A no-op for anybody on foot.
 *
 * `yaw` is the driver's look yaw -- the car points where the driver points, on
 * `BikeField.follow`'s convention ("its yaw is the rider's") -- and is used only
 * by the nose probe, which needs to know where the bonnet is.
 *
 * Returns true if the nose hit something this tick, so a caller can play a bump.
 */
export function stepCarSpeed(
  c: DriveState,
  input: { forward: number; jump: boolean },
  dt: number,
  x: number,
  feetY: number,
  z: number,
  yaw: number,
  world: DrivingWorld | null,
): boolean {
  if (c.drivingCar === 0) {
    // Not driving. Zeroed rather than left, so a player who is knocked out of a
    // car and gets into another one does not inherit the speed they had when
    // they were thrown through the windscreen.
    c.carSpeed = 0;
    return false;
  }

  const throttle = clamp(input.forward, -1, 1);
  const rough = world?.onRoad === undefined ? false : !world.onRoad(x, z);
  const top = rough ? DRIVE_TOP_SPEED_ROUGH : DRIVE_TOP_SPEED;
  const floor = -top * DRIVE_REVERSE;
  let v = c.carSpeed;

  if (input.jump) {
    // Handbrake. Toward zero from either side and never through it, which is the
    // one thing an unclamped `v -= HANDBRAKE * dt` gets wrong: at 60 Hz that
    // overshoots by up to 0.27 m/s and leaves a stopped car creeping backwards.
    v = approach(v, 0, DRIVE_HANDBRAKE * dt);
  } else if (throttle > 0) {
    // Throttle. If we are rolling backwards this is the brake first and the
    // accelerator second, and the stronger constant is the right one for it --
    // the pedal you press to stop reversing is the brake.
    const rate = v < 0 ? DRIVE_BRAKE : DRIVE_ACCELERATION;
    v = approach(v, top * throttle, rate * dt);
  } else if (throttle < 0) {
    const rate = v > 0 ? DRIVE_BRAKE : DRIVE_ACCELERATION;
    v = approach(v, floor * -throttle, rate * dt);
  } else {
    v = approach(v, 0, DRIVE_COAST * dt);
  }

  // Re-clamped after the fact as well as inside `approach`, because `top` can
  // *fall* between ticks -- driving off a road at 22 m/s -- and a target the
  // speed is already past would otherwise be approached from the wrong side and
  // never reached.
  v = clamp(v, floor, top);

  // --- The nose probe. See the header, section 2.
  //
  // One `resolve` from the driver's own capsule to a point `NOSE_REACH` ahead of
  // it, at the nose's own radius. `hit` means the far end of the bonnet is
  // inside something the driver's 0.34 m capsule would have squeezed past, and
  // the answer is to stop the car rather than to push it back -- `controller.step`
  // is already the thing that decides where the *body* ends up, and a second
  // opinion about position here would fight it every tick.
  //
  // Only forwards. Reversing into a wall is caught by the body's own capsule at
  // the speeds reverse allows, and a rear probe would double the cost of the one
  // query per car per tick this feature is allowed.
  let bumped = false;
  if (v > 0 && world?.collision) {
    // `yaw` 0 faces -Z, exactly as `controller.step` derives it.
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const hit = world.collision.resolve(
      x, z,
      x + fx * NOSE_REACH, z + fz * NOSE_REACH,
      NOSE_RADIUS, feetY,
    );
    if (hit.hit) {
      bumped = true;
      // Not to zero: a hard stop at a kerb reads as the car being deleted. Two
      // thirds off per tick sheds 22 m/s in about 90 ms, which is a crunch.
      v *= 0.34;
      if (v < 0.2) v = 0;
    }
  }

  c.carSpeed = v;
  return bumped;
}

/**
 * Fold the car into the movement snapshot the combatant is about to be stepped
 * with, so `controller.step` moves the body at the speed this file decided.
 *
 * **Stateless**, and that is not incidental: it is called from
 * `combat.advance` on both ends *and* from `net/client.reconcile`'s replay, once
 * per un-acked input, and a function that integrated here would integrate three
 * to five times per snapshot on the client and once on the server. The
 * integration is `stepCarSpeed`'s and runs exactly once a tick.
 *
 * What the replay therefore uses is the *current* speed for every pending tick
 * rather than the speed as it was at each. Over the three to five ticks a replay
 * covers, at 6 m/s^2, that is at most 0.5 m/s of speed error and under a
 * centimetre of position -- an order of magnitude inside `CORRECTION_DEADZONE`.
 * Recording a speed per pending input would remove it and cost a field on every
 * queued frame; it is not worth it and this paragraph is the record of that
 * decision.
 *
 * Runs **after** `shapeRideInput`, and the two are mutually exclusive by
 * construction: `resolveTake` refuses a car to anybody on a bike.
 */
export function shapeDriveInput(c: DriveState, movement: InputSnapshot): void {
  if (c.drivingCar === 0) return;
  // A car has one speed and it is not a function of whether shift is held, on
  // `shapeRideInput`'s own argument: forcing the sprint is what makes the scale
  // multiply `SPRINT_SPEED` rather than `WALK_SPEED`.
  movement.sprint = true;
  // No sidestep. A car does not crab, and `A`/`D` have been spent on the wheel
  // by `shapeDriveSteering` -- but this is the line that makes it a *rule*
  // rather than a client-side courtesy, because a hand-rolled client that kept
  // sending `right: 1` would strafe without it. `bikes.RIDE_STRAFE`'s reason.
  movement.right = 0;
  // The sign is the whole trick. `controller.step`'s target speed is
  // `SPRINT x speedScale x min(|forward|, 1)` along the *look* direction, so a
  // reversing car is `forward = -1` with the magnitude of the speed in the
  // scale, and a forward one is `forward = 1`.
  const v = c.carSpeed;
  movement.forward = v < 0 ? -1 : 1;
  // `PROBE_SPRINT` in `bikes.ts` is this same 8.2 and is a constant there for
  // the identical reason: this file may not import the controller, because the
  // controller imports three. `verifyDriving` asserts the two have not drifted.
  movement.speedScale = ((v < 0 ? -v : v) / SPRINT_SPEED) * (movement.speedScale ?? 1);
  // And no jumping a car. `jump` is the handbrake now -- see `stepCarSpeed` --
  // and a sedan that hops when you brake is not the feature.
  movement.jump = false;
}

/** `controller.SPRINT_SPEED`, which this file may not import. Asserted in `verifyDriving`. */
export const SPRINT_SPEED = 8.2;

/**
 * How fast the wheel turns at this speed, radians per second.
 *
 * `bikes.rideTurnRate` with a grip term on the front. Always non-negative; the
 * caller applies the sign.
 */
export function driveTurnRate(speed: number): number {
  const s = speed < 0 ? -speed : speed;
  const t = Math.min(1, s / DRIVE_TURN_FULL_SPEED);
  const base = DRIVE_TURN_RATE + (DRIVE_TURN_RATE_FAST - DRIVE_TURN_RATE) * t;
  // The grip ramp. See `DRIVE_TURN_GRIP`: a parked car does not pirouette.
  return base * Math.min(1, s / DRIVE_TURN_GRIP);
}

/** What `shapeDriveSteering` writes. `bikes.RideSteering`'s shape. */
export interface DriveSteering {
  /** What `InputSnapshot.right` must become. Zero in a car. */
  right: number;
  /** Radians to add to `InputSnapshot.yaw` this frame. Zero on foot. */
  yawDelta: number;
}

/**
 * Turn `A`/`D` from a strafe into a steer for a driver, and leave everyone else
 * alone. `bikes.shapeRideSteering`'s function, and see its header -- the whole
 * argument for why this is an input remap and not a second integrator is there.
 *
 * The one difference is the last clause: **reversing inverts the wheel**, which
 * is what a car does and what makes backing out of a driveway work. `speed` is
 * signed for exactly that.
 *
 * `dt` is the *frame* delta rather than the fixed step, on `main.ts`'s argument
 * about the arrow keys: the look is assembled once per frame and sampled by
 * however many fixed steps that frame contained.
 */
export function shapeDriveSteering(
  c: DriveState,
  right: number,
  speed: number,
  dt: number,
  out: DriveSteering,
): DriveSteering {
  if (c.drivingCar === 0) {
    out.right = right;
    out.yawDelta = 0;
    return out;
  }
  out.right = 0;
  // Negative because yaw increasing turns left -- `controller.step` derives
  // forward as `(-sin yaw, -cos yaw)`, so `D`, which is +1, takes yaw down.
  // Times the sign of the speed, so reverse steers the other way.
  const dir = speed < 0 ? -1 : 1;
  out.yawDelta = -right * driveTurnRate(speed) * dir * dt;
  return out;
}

/**
 * The look yaw that points a body down a car's heading.
 *
 * Two `Math.atan2` inputs and therefore **presentation only**: this is called
 * once, in the browser, on the frame you get into a car, so that taking a car
 * parked at the kerb points you along the street rather than at the shopfront
 * you were facing. The result becomes the client's own look direction, which is
 * a client-authoritative input on this wire (`protocol.INPUT_BYTES` carries
 * `yaw`), so nothing about it has to agree with anything.
 *
 * `(dx, dz)` is `CarPose`'s unit heading; forward at yaw is `(-sin, -cos)`.
 */
export function headingYaw(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

// --- What is takeable ----------------------------------------------------------------

/** One schedule car somebody could get into, as `resolveTake` hands it over. */
export interface TakeableCar {
  /** `traffic.identityOf(route, slot)`. The car's name in every process. */
  identity: number;
  body: number;
  colour: number;
  x: number;
  y: number;
  z: number;
  /** The car's own heading, as a look yaw. See `headingYaw`. */
  yaw: number;
  /** True when it was stationary in a kerb bay, which is what "parked" means here. */
  parked: boolean;
}

export function createTakeable(): TakeableCar {
  return { identity: 0, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: false };
}

/**
 * The nearest car at this point that somebody could get into, or false.
 *
 * Runs on the server to grant a steal and in the browser to predict one and to
 * draw the prompt, off the same `TrafficField` lookup at the same whole tick,
 * which is what makes the prompt honest: if the HUD says "E -- take the car" the
 * server will agree, because both asked `poseCar` the same question.
 *
 * **Ties break on identity rather than on the float distance**, which is
 * `BikeField.nearestFree`'s rule and is here for its reason: two cars at the
 * same range have to resolve the same way on the client predicting the take and
 * on the server granting it, and an integer comparison is a rule both can state
 * where a float comparison is one two builds can disagree about.
 *
 * `taken` is the suppression predicate -- a car somebody is already driving is
 * not takeable, and without this clause two players would both "take" the same
 * identity and the second would get a record pointing at a suppressed ghost.
 */
export function resolveTake(
  field: TrafficField,
  x: number,
  feetY: number,
  z: number,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
  taken: (identity: number) => boolean,
  out: TakeableCar,
): boolean {
  let bestD2 = TAKE_RADIUS * TAKE_RADIUS;
  let bestIdentity = 0;
  let found = false;
  forEachCarNear(field, x, z, TAKE_RADIUS, tick, scratch, pose, (p) => {
    if (p.speed > TAKEABLE_SPEED) return;
    if (taken(p.identity)) return;
    // The vertical gate. `bikes.MOUNT_HEIGHT`'s argument: a plan-only test lets
    // somebody on the Cahill Expressway take a car on Alfred Street eight metres
    // below them.
    const dy = p.y - feetY;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return;
    const dx = p.x - x;
    const dz = p.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 > bestD2) return;
    // Strictly nearer, or the same distance and a lower identity. See the header.
    if (found && (d2 > bestD2 || (d2 === bestD2 && p.identity >= bestIdentity))) return;
    found = true;
    bestD2 = d2;
    bestIdentity = p.identity;
    out.identity = p.identity;
    out.body = p.body;
    out.colour = p.colour;
    out.x = p.x;
    out.y = p.y;
    out.z = p.z;
    out.yaw = headingYaw(p.dx, p.dz);
    out.parked = p.stage === CAR_STAGE_PARKED_IN || p.stage === CAR_STAGE_PARKED_OUT;
  });
  return found;
}

// --- The field ------------------------------------------------------------------------

/** One driven car, as both ends hold it. */
export interface DrivenCar {
  /** The allocation id, 1..n, and what `MSG.CARS` keys on. Never 0. */
  readonly id: number;
  /** `traffic.identityOf(route, slot)`: which ambient car this used to be. */
  readonly carId: number;
  /** `CAR_BODY_SIZE` index, 0..4, and the paint index. The "model". */
  readonly body: number;
  readonly colour: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Signed, m/s. Copied out of the driver's `carSpeed` by `follow`. */
  speed: number;
  /** The combatant driving it, or 0 for one left in the street. */
  driverId: number;
  /** Milliseconds it has been standing empty. Reset the moment anybody takes it. */
  emptyMs: number;
}

/**
 * The contract the rest of the game holds this file by. **Do not rename** --
 * other workstreams call these two.
 */
export interface DrivingLookup {
  /** The car record id this player is driving, or 0. */
  carOf(playerId: number): number;
  /** Where a car record is, or null if there is no such record. */
  carPose(carId: number): { x: number; y: number; z: number; yaw: number; speed: number } | null;
}

/**
 * Every car anybody has taken, and the only thing allowed to change who is in
 * one.
 *
 * `game/bikes.BikeField` with the three differences section 4 of the header
 * lists. The server owns an instance and is authoritative; a connected client
 * owns one and treats it as a mirror `MSG.CARS` corrects; offline the client's
 * copy *is* the authority, which is what makes `?offline` a real test of the
 * feature rather than a second implementation of it.
 */
export class CarField implements DrivingLookup {
  private readonly byId = new Map<number, DrivenCar>();
  /** By source identity, so `suppressed` is a hash lookup and not a scan. */
  private readonly bySource = new Map<number, DrivenCar>();
  private flat: DrivenCar[] = [];
  private dirty = true;
  /**
   * The next id to hand out.
   *
   * Monotonic and **never reused**, on `protocol.AOI_ID_LIFECYCLE`'s argument:
   * an id that came back would let a `CARS` delete in flight remove the car that
   * inherited it, and the symptom -- somebody else's car vanishing when you
   * abandon yours -- is indistinguishable from a bug in the expiry. A `u16` at
   * one allocation per theft wraps after 65,535 stolen cars, which is a session
   * length nobody will reach; `alloc` skips over any id still live if it ever does.
   */
  private nextId = 1;

  /**
   * Put a car under a driver, allocating a record. Null if that ambient car is
   * already somebody's.
   *
   * The one place a claim is decided, `BikeField.claim`'s rule: everything else
   * -- the button edge, the range test, the HUD prompt -- is upstream of this
   * line, and "can two players take the same car" has exactly one answer.
   */
  take(source: TakeableCar, driverId: number): DrivenCar | null {
    if (this.bySource.has(source.identity)) return null;
    const id = this.alloc();
    const car: DrivenCar = {
      id,
      carId: source.identity,
      body: source.body,
      colour: source.colour,
      x: source.x,
      y: source.y,
      z: source.z,
      yaw: source.yaw,
      speed: 0,
      driverId,
      emptyMs: 0,
    };
    this.byId.set(id, car);
    this.bySource.set(car.carId, car);
    this.dirty = true;
    return car;
  }

  /**
   * Adopt a record the server described. The client mirror's only way in.
   *
   * Upsert by id, because `MSG.CARS` is an upsert -- see `protocol.encodeCars`.
   * The immutable half (`carId`, `body`, `colour`) is only ever written on the
   * insert, which is what makes it safe for a delta to carry it unchanged.
   */
  adopt(record: {
    id: number;
    carId: number;
    body: number;
    colour: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
    speed: number;
    driverId: number;
  }): DrivenCar {
    const existing = this.byId.get(record.id);
    if (existing) {
      existing.x = record.x;
      existing.y = record.y;
      existing.z = record.z;
      existing.yaw = record.yaw;
      existing.speed = record.speed;
      existing.driverId = record.driverId;
      if (record.driverId !== 0) existing.emptyMs = 0;
      return existing;
    }
    const car: DrivenCar = { ...record, emptyMs: 0 };
    this.byId.set(record.id, car);
    this.bySource.set(car.carId, car);
    this.dirty = true;
    // Keep the mirror's allocator ahead of the authority's, so an offline
    // session that later goes online cannot mint a colliding id.
    if (record.id >= this.nextId) this.nextId = record.id + 1;
    return car;
  }

  /**
   * The driver got out. Leaves the record standing where it is, with nobody in
   * it and no speed.
   *
   * Called by the **prediction**, and it exists because `follow` cannot cover
   * this one case: the sweep detects "the car's driver is no longer driving it"
   * by comparing ids, and offline the local player's id is 0, which is also the
   * empty sentinel -- so a deliberate exit is indistinguishable from a record
   * that was already empty. `follow`'s own header carries the same paragraph
   * from the other side. On the server this is `resolveMount`'s branch and the
   * sweep does the rest, so nothing there calls it.
   */
  leave(id: number): void {
    const car = this.byId.get(id);
    if (!car) return;
    car.driverId = 0;
    car.speed = 0;
    car.emptyMs = 0;
  }

  /** Drop a record entirely: it expired, or the server said so. */
  remove(id: number): boolean {
    const car = this.byId.get(id);
    if (!car) return false;
    this.byId.delete(id);
    // Guarded, because two records must never share a source and this is the
    // line that would silently un-suppress a live car if one ever did.
    if (this.bySource.get(car.carId) === car) this.bySource.delete(car.carId);
    this.dirty = true;
    return true;
  }

  get(id: number): DrivenCar | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Every record, in id order. Owned by this object and reused -- do not retain it. */
  all(): readonly DrivenCar[] {
    if (this.dirty) {
      this.flat = [...this.byId.values()].sort((a, b) => a.id - b.id);
      this.dirty = false;
    }
    return this.flat;
  }

  /**
   * **Is this ambient car somebody's?** Section 3 of the header: the whole of
   * how the schedule car you drove away in stops also driving to Ashfield.
   *
   * A `Map.has` rather than a scan, because this is asked once per car in view
   * per frame by `world/cars.TrafficMovers.update` -- up to 210 times a frame in
   * town -- and once per car near a combatant per tick by `traffic.carHitting`.
   */
  suppressed(identity: number): boolean {
    return this.bySource.has(identity);
  }

  /** `DrivingLookup`. Linear in driven cars, which are few by construction. */
  carOf(playerId: number): number {
    if (playerId === 0) return 0;
    for (const car of this.byId.values()) if (car.driverId === playerId) return car.id;
    return 0;
  }

  /** `DrivingLookup`. */
  carPose(carId: number): { x: number; y: number; z: number; yaw: number; speed: number } | null {
    const car = this.byId.get(carId);
    if (!car) return null;
    return { x: car.x, y: car.y, z: car.z, yaw: car.yaw, speed: car.speed };
  }

  /**
   * Reconcile every record against who is actually driving, after the
   * combatants have moved. Returns the records that changed, for the caller to
   * broadcast.
   *
   * **This is the whole of "you get thrown out"**, and doing it as a sweep
   * rather than as an event is what makes it total, exactly as
   * `BikeField.follow` argues: `combat.applyHit` clears `drivingCar` from three
   * files away, a player who disconnects simply stops being in the list, a
   * knockout has the same field cleared by the same line. All three are "the
   * car's driver is no longer driving it", all three leave the car in the road
   * where the body is, and none of them needed a message of their own.
   *
   * The occupied case is the brief's "the car pose is derived from the driver's
   * record": position and yaw are the driver's, so nothing about a moving car is
   * ever on the wire beyond what the snapshot already carried.
   */
  follow(drivers: Iterable<DriverView>, changed: DrivenCar[] = []): DrivenCar[] {
    changed.length = 0;
    const seen = new Map<number, DriverView>();
    for (const d of drivers) if (d.drivingCar !== 0) seen.set(d.drivingCar, d);

    for (const car of this.all()) {
      const driver = seen.get(car.id);
      // **Keyed on the car, not on `driverId !== 0`**, and that is not a
      // micro-optimisation -- it is the one place this class cannot borrow
      // `BikeField.follow` verbatim. Offline, `main.ts` gives the local player
      // the combatant id **0**, which is also this field's "nobody is in it"
      // sentinel and the wire's (`protocol.encodeCars`). Skipping on
      // `driverId === 0` therefore skipped the offline player's own car, which
      // stayed at the kerb it was taken from while its driver drove away --
      // invisible online, where ids start at 1, and the whole feature broken in
      // `?offline`. `factions.reportCrime`'s header documents the same trap
      // from the other side.
      //
      // So: a record somebody claims *by id* is carried, whatever that id is,
      // and a record nobody claims and nobody was in is simply left alone.
      if (driver === undefined && car.driverId === 0) continue;
      if (driver && driver.id === car.driverId) {
        car.x = driver.x;
        car.y = driver.feetY;
        car.z = driver.z;
        car.yaw = driver.yaw;
        car.speed = driver.carSpeed;
        car.emptyMs = 0;
        continue;
      }
      // Left, thrown out, knocked out or disconnected. The position is whatever
      // the last `follow` wrote, which is where the driver was, which is where
      // the car should be standing.
      car.driverId = 0;
      car.speed = 0;
      car.emptyMs = 0;
      changed.push(car);
    }
    return changed;
  }

  /**
   * Age the empty cars and hand back the ones the city has taken.
   *
   * `nearest` answers "how far is the closest person from this point" so the
   * caller decides what counts as a person -- on the server that is every
   * participant, and there is deliberately no NPC clause: a car vanishing
   * because a pedestrian walked past it is a car vanishing at random.
   *
   * Returns the ids removed. Removing the record is the whole of the
   * restoration -- see section 4: the ambient car was suppressed and never
   * deleted, so the moment the record goes, `poseCar` is drawing it again.
   */
  expire(dtMs: number, nearest: (car: DrivenCar) => number, removed: number[] = []): number[] {
    removed.length = 0;
    for (const car of this.all()) {
      if (car.driverId !== 0) continue;
      car.emptyMs += dtMs;
      if (car.emptyMs < ABANDON_MS) continue;
      if (nearest(car) < ABANDON_RADIUS) {
        // Somebody is standing next to it. Held at the threshold rather than
        // reset, so it goes the instant they walk away rather than starting the
        // five minutes again -- a car that can be kept alive forever by loitering
        // is a leak with a player attached to it.
        car.emptyMs = ABANDON_MS;
        continue;
      }
      removed.push(car.id);
    }
    for (const id of removed) this.remove(id);
    return removed;
  }

  /** Empty the field. A respawn of the whole room, and the self-checks. */
  clear(): void {
    this.byId.clear();
    this.bySource.clear();
    this.dirty = true;
  }

  private alloc(): number {
    // Skips live ids, so a wrapped `u16` cannot collide. See `nextId`.
    for (let n = 0; n < 65536; n++) {
      const id = this.nextId;
      this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
      if (!this.byId.has(id)) return id;
    }
    return 0;
  }
}

/** What `CarField.follow` needs from a combatant. `bikes.RiderView`'s shape. */
export interface DriverView {
  readonly id: number;
  readonly drivingCar: number;
  readonly carSpeed: number;
  readonly x: number;
  readonly feetY: number;
  readonly z: number;
  readonly yaw: number;
}

// --- The witness --------------------------------------------------------------------

/**
 * Did **anybody** see that?
 *
 * `factions.policeWitness` answers the same question for police only, and the
 * brief asked for a bystander variant. It lives here rather than in
 * `factions.ts` because the caller is this feature: car theft is the first crime
 * in the game a civilian is allowed to report, and every existing one is either
 * unconditional or witnessed by an officer.
 *
 * The geometry is `policeWitness`' verbatim -- a range gate and then
 * `collision.blocked` from the witness's eye to chest height at the crime -- and
 * a world with no collision counts as clear, which is that function's stated
 * failure mode and the right one: a crowd that cannot see anything until the
 * prisms arrive is a crowd that does not exist for the first second of a session.
 *
 * `forEach` is `pedestrians.forEachPedestrianNear` bound by the caller, which is
 * what keeps this file out of the pedestrian module's import graph and lets
 * `verifyDriving` drive it with three people in an array.
 */
export function bystanderSeen(
  x: number,
  y: number,
  z: number,
  forEach: (visit: (px: number, py: number, pz: number, down: boolean) => void) => void,
  blocked: ((ax: number, ay: number, az: number, bx: number, by: number, bz: number) => boolean) | null,
): boolean {
  let seen = false;
  forEach((px, py, pz, down) => {
    if (seen) return;
    // Somebody face down on the footpath is not a witness. The same clause
    // `strikePedestrian` uses to refuse a second hit, for the same reason: a
    // body is not a person for the purposes of anything.
    if (down) return;
    const dx = px - x;
    const dz = pz - z;
    if (dx * dx + dz * dz > WITNESS_RADIUS * WITNESS_RADIUS) return;
    if (blocked !== null && blocked(px, py + WITNESS_EYE, pz, x, y + CRIME_HEIGHT, z)) return;
    seen = true;
  });
  return seen;
}

// --- Small shared arithmetic ----------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Move `v` toward `target` by at most `step`, never past it.
 *
 * The "never past it" is the whole of why this is a function. Every one of the
 * five branches in `stepCarSpeed` is a rate times `dt`, and at 60 Hz with a
 * 16 m/s^2 handbrake that is 0.27 m/s a tick -- enough to walk a stopped car
 * backwards forever if the clamp is missing on any one of them.
 */
function approach(v: number, target: number, step: number): number {
  if (v < target) return Math.min(target, v + step);
  if (v > target) return Math.max(target, v - step);
  return v;
}

// --- The self-check ------------------------------------------------------------------

/**
 * What this catches that a typecheck cannot.
 *
 * Every failure below renders. None of them throws.
 *
 *   - **A car that never stops.** A missing clamp in `approach` is a handbrake
 *     that reverses you, and it looks like a physics quirk rather than a bug.
 *   - **A car that pirouettes.** Without the grip ramp, holding `D` at a
 *     standstill spins the body on the spot -- the single most obviously wrong
 *     thing a car can do, and invisible to every test that only drives forwards.
 *   - **Two players in one car.** `take` returning a record for an identity
 *     somebody already has is two people steering one 4.4 m box.
 *   - **A ghost on the timetable.** `suppressed` failing to answer for a taken
 *     car is the ambient copy driving to Ashfield beside you, running people
 *     down on the way.
 *   - **A speed scale that means something else.** `SPRINT_SPEED` here has to be
 *     the controller's, and if it drifts every car in the city quietly changes
 *     top speed with nothing in this file edited.
 */
export function verifyDriving(): string[] {
  const failures: string[] = [];

  // --- The integrator reaches the stated top speed and does not pass it.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0 };
    const dt = 1 / 60;
    for (let i = 0; i < 600; i++) stepCarSpeed(c, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
    if (Math.abs(c.carSpeed - DRIVE_TOP_SPEED) > 1e-6) {
      failures.push(`Ten seconds of throttle reached ${c.carSpeed.toFixed(3)} m/s, not ${DRIVE_TOP_SPEED}.`);
    }
    // And it got there in about the time the constant promises: v/a = 3.67 s.
    const ramp: DriveState = { drivingCar: 1, carSpeed: 0 };
    let ticks = 0;
    while (ramp.carSpeed < DRIVE_TOP_SPEED - 1e-9 && ticks < 3600) {
      stepCarSpeed(ramp, { forward: 1, jump: false }, dt, 0, 0, 0, 0, null);
      ticks++;
    }
    const seconds = ticks / 60;
    const want = DRIVE_TOP_SPEED / DRIVE_ACCELERATION;
    if (Math.abs(seconds - want) > 0.1) {
      failures.push(
        `0 to ${DRIVE_TOP_SPEED} m/s took ${seconds.toFixed(2)} s against the ${want.toFixed(2)} s ` +
          `${DRIVE_ACCELERATION} m/s^2 promises.`,
      );
    }
  }

  // --- The brake is stronger than the throttle, and the handbrake than both.
  {
    const dt = 1 / 60;
    const shed = (input: { forward: number; jump: boolean }): number => {
      const c: DriveState = { drivingCar: 1, carSpeed: DRIVE_TOP_SPEED };
      stepCarSpeed(c, input, dt, 0, 0, 0, 0, null);
      return DRIVE_TOP_SPEED - c.carSpeed;
    };
    const coast = shed({ forward: 0, jump: false });
    const brake = shed({ forward: -1, jump: false });
    const hand = shed({ forward: 0, jump: true });
    if (!(hand > brake && brake > coast && coast > 0)) {
      failures.push(
        `A tick sheds ${coast.toFixed(3)} coasting, ${brake.toFixed(3)} braking and ${hand.toFixed(3)} ` +
          `on the handbrake; they must be ordered.`,
      );
    }
    if (Math.abs(brake - DRIVE_BRAKE * dt) > 1e-9) {
      failures.push(`The brake shed ${brake.toFixed(4)} m/s in a tick, not ${(DRIVE_BRAKE * dt).toFixed(4)}.`);
    }
  }

  // --- The handbrake stops the car and does not walk it backwards.
  //
  // The clamp in `approach`, and it is the failure this whole function exists
  // for: at 60 Hz a 16 m/s^2 handbrake overshoots zero by up to 0.27 m/s, and an
  // unclamped subtract leaves a "stopped" car creeping down the street forever.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0.1 };
    for (let i = 0; i < 120; i++) stepCarSpeed(c, { forward: 0, jump: true }, 1 / 60, 0, 0, 0, 0, null);
    if (c.carSpeed !== 0) failures.push(`Two seconds of handbrake left the car at ${c.carSpeed} m/s, not stopped.`);
    const back: DriveState = { drivingCar: 1, carSpeed: -0.1 };
    for (let i = 0; i < 120; i++) stepCarSpeed(back, { forward: 0, jump: true }, 1 / 60, 0, 0, 0, 0, null);
    if (back.carSpeed !== 0) failures.push(`The handbrake left a reversing car at ${back.carSpeed} m/s.`);
    // And coasting settles at exactly zero too.
    const roll: DriveState = { drivingCar: 1, carSpeed: 0.01 };
    for (let i = 0; i < 120; i++) stepCarSpeed(roll, { forward: 0, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    if (roll.carSpeed !== 0) failures.push(`A coasting car settled at ${roll.carSpeed} m/s rather than stopping.`);
  }

  // --- Reverse is capped at its fraction and is not a second forward gear.
  {
    const c: DriveState = { drivingCar: 1, carSpeed: 0 };
    for (let i = 0; i < 600; i++) stepCarSpeed(c, { forward: -1, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    const want = -DRIVE_TOP_SPEED * DRIVE_REVERSE;
    if (Math.abs(c.carSpeed - want) > 1e-6) {
      failures.push(`Reverse topped out at ${c.carSpeed.toFixed(2)} m/s, not ${want.toFixed(2)}.`);
    }
  }

  // --- Off-road is slower, and a world that cannot say counts as road.
  {
    const rough: DrivingWorld = { collision: null, onRoad: () => false };
    const c: DriveState = { drivingCar: 1, carSpeed: 0 };
    for (let i = 0; i < 600; i++) stepCarSpeed(c, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, rough);
    if (Math.abs(c.carSpeed - DRIVE_TOP_SPEED_ROUGH) > 1e-6) {
      failures.push(`Off the road the car reached ${c.carSpeed.toFixed(2)} m/s, not ${DRIVE_TOP_SPEED_ROUGH}.`);
    }
    // Driving off a road at speed has to be *clamped down to* the new top rather
    // than approached from the wrong side -- see the re-clamp in `stepCarSpeed`.
    const fast: DriveState = { drivingCar: 1, carSpeed: DRIVE_TOP_SPEED };
    stepCarSpeed(fast, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, rough);
    if (fast.carSpeed > DRIVE_TOP_SPEED_ROUGH + 1e-9) {
      failures.push(`A car that left the road at ${DRIVE_TOP_SPEED} m/s was still doing ${fast.carSpeed.toFixed(2)}.`);
    }
    const silent: DrivingWorld = { collision: null };
    const road: DriveState = { drivingCar: 1, carSpeed: 0 };
    for (let i = 0; i < 600; i++) stepCarSpeed(road, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, silent);
    if (Math.abs(road.carSpeed - DRIVE_TOP_SPEED) > 1e-6) {
      failures.push('A world that does not know where the roads are made every car an off-road car.');
    }
  }

  // --- A player on foot is not touched by any of it.
  {
    const c: DriveState = { drivingCar: 0, carSpeed: 9 };
    stepCarSpeed(c, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, null);
    if (c.carSpeed !== 0) failures.push(`Somebody on foot kept a car speed of ${c.carSpeed}.`);
    const movement: InputSnapshot = { forward: 1, right: 1, jump: true, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(c, movement);
    if (!movement.jump || movement.right !== 1 || movement.speedScale !== undefined || movement.sprint) {
      failures.push('shapeDriveInput changed the input of somebody who is not in a car.');
    }
  }

  // --- The shaped input asks the controller for exactly the car's own speed.
  {
    const c: DriveState = { drivingCar: 4, carSpeed: 15 };
    const movement: InputSnapshot = { forward: 0, right: 1, jump: true, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(c, movement);
    if (!movement.sprint) failures.push('A driver was not put into a sprint, so the scale applies to the walk speed.');
    if (movement.right !== 0) failures.push(`A driver's strafe was ${movement.right}; a car does not crab.`);
    if (movement.jump) failures.push('A driver could jump. Space is the handbrake.');
    if (movement.forward !== 1) failures.push(`A forward driver's throttle was ${movement.forward}, not 1.`);
    // `SPRINT x speedScale x |forward|` has to come out at the car's speed.
    const target = SPRINT_SPEED * (movement.speedScale ?? 0) * Math.min(Math.abs(movement.forward), 1);
    if (Math.abs(target - 15) > 1e-9) {
      failures.push(`The controller would target ${target.toFixed(3)} m/s for a car doing 15.`);
    }
    // And in reverse, where the sign lives on `forward` and the magnitude in the
    // scale -- the one place this remap is easy to get half right.
    const back: DriveState = { drivingCar: 4, carSpeed: -5 };
    const rev: InputSnapshot = { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 };
    shapeDriveInput(back, rev);
    if (rev.forward !== -1) failures.push(`A reversing driver's throttle was ${rev.forward}, not -1.`);
    const revTarget = SPRINT_SPEED * (rev.speedScale ?? 0) * Math.min(Math.abs(rev.forward), 1);
    if (Math.abs(revTarget - 5) > 1e-9) {
      failures.push(`The controller would target ${revTarget.toFixed(3)} m/s for a car reversing at 5.`);
    }
    // It composes rather than replaces, exactly as `shapeRideInput` does, so a
    // Flat White taken on foot and still running does not silently vanish.
    const buffed: DriveState = { drivingCar: 4, carSpeed: 11 };
    const withCoffee: InputSnapshot = { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0, speedScale: 2 };
    shapeDriveInput(buffed, withCoffee);
    if (Math.abs((withCoffee.speedScale ?? 0) - (11 / SPRINT_SPEED) * 2) > 1e-9) {
      failures.push('shapeDriveInput replaced the existing speed scale instead of composing with it.');
    }
  }

  // --- `SPRINT_SPEED` is still the controller's. See the constant.
  //
  // Measured the only way this file can measure it: `game/bikes.ts` keeps the
  // same literal for the same reason, so the two have to agree, and if either
  // moves without the controller the check fails here first.
  if (SPRINT_SPEED !== 8.2) {
    failures.push(`SPRINT_SPEED is ${SPRINT_SPEED}; controller.SPRINT_SPEED is 8.2 and every car's top speed rides on it.`);
  }

  // --- The wheel: nothing at rest, mirrored, falling with speed, inverted in reverse.
  {
    const out: DriveSteering = { right: 0, yawDelta: 0 };
    const onFoot: DriveState = { drivingCar: 0, carSpeed: 0 };
    shapeDriveSteering(onFoot, 1, 8.2, 1 / 60, out);
    if (out.right !== 1 || out.yawDelta !== 0) {
      failures.push(`A walker's A/D became right=${out.right}, yaw ${out.yawDelta}; on foot it is a strafe.`);
    }

    const parked: DriveState = { drivingCar: 2, carSpeed: 0 };
    shapeDriveSteering(parked, 1, 0, 1 / 60, out);
    if (out.yawDelta !== 0) {
      failures.push(`A stationary car turned ${out.yawDelta} rad holding D. A car is not a turntable.`);
    }

    const rolling: DriveState = { drivingCar: 2, carSpeed: 10 };
    shapeDriveSteering(rolling, 1, 10, 1 / 60, out);
    if (out.right !== 0) failures.push(`A driver holding D still had right=${out.right}; the strafe must be gone.`);
    if (!(out.yawDelta < 0)) {
      failures.push(`Holding D in a car changed yaw by ${out.yawDelta}; yaw increasing turns left, so D takes it down.`);
    }
    const left: DriveSteering = { right: 0, yawDelta: 0 };
    shapeDriveSteering(rolling, -1, 10, 1 / 60, left);
    if (Math.abs(left.yawDelta + out.yawDelta) > 1e-12) {
      failures.push(`A and D are not mirror images: ${left.yawDelta} against ${out.yawDelta}.`);
    }
    // Reverse inverts, which is what backing out of a driveway needs.
    const backing: DriveState = { drivingCar: 2, carSpeed: -4 };
    const rev: DriveSteering = { right: 0, yawDelta: 0 };
    shapeDriveSteering(backing, 1, -4, 1 / 60, rev);
    if (!(rev.yawDelta > 0)) {
      failures.push(`Holding D while reversing turned ${rev.yawDelta} rad; a reversing car steers the other way.`);
    }

    // Falls with speed over the range the grip ramp is finished for.
    const slow = driveTurnRate(5);
    const mid = driveTurnRate(12);
    const fast = driveTurnRate(DRIVE_TOP_SPEED);
    if (!(slow > mid && mid > fast)) {
      failures.push(`The turn rate is not falling with speed: ${slow.toFixed(2)}, ${mid.toFixed(2)}, ${fast.toFixed(2)}.`);
    }
    if (driveTurnRate(0) !== 0) failures.push(`driveTurnRate(0) is ${driveTurnRate(0)}, not zero.`);
    // And the radius stays in one order of magnitude across the range, which is
    // the property the ramp exists to hold. `bikes.verifyBikes`' own assertion.
    const radiusTop = DRIVE_TOP_SPEED / fast;
    if (radiusTop > 70) {
      failures.push(`A car at ${DRIVE_TOP_SPEED} m/s turns in ${radiusTop.toFixed(0)} m; that is not a corner.`);
    }
    if (12 / mid < 3) failures.push('A car at 12 m/s turns inside three metres, which is a spin.');
  }

  // --- The nose probe stops the car at a wall and leaves it alone in the open.
  {
    const open: DrivingWorld = { collision: { resolve: (fx, fz) => ({ x: fx, z: fz, hit: false }) } };
    const wall: DrivingWorld = { collision: { resolve: (fx, fz) => ({ x: fx, z: fz, hit: true }) } };
    const clear: DriveState = { drivingCar: 1, carSpeed: 20 };
    if (stepCarSpeed(clear, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, open)) {
      failures.push('The nose probe reported a bump in an empty world.');
    }
    if (clear.carSpeed < 20) failures.push('An unobstructed car was slowed by its own nose probe.');

    const stopped: DriveState = { drivingCar: 1, carSpeed: 20 };
    if (!stepCarSpeed(stopped, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, wall)) {
      failures.push('The nose probe did not report driving into a wall.');
    }
    if (!(stopped.carSpeed < 20)) failures.push(`A car drove into a wall at ${stopped.carSpeed} m/s and did not slow.`);
    for (let i = 0; i < 60; i++) stepCarSpeed(stopped, { forward: 1, jump: false }, 1 / 60, 0, 0, 0, 0, wall);
    if (stopped.carSpeed !== 0) {
      failures.push(`A second of full throttle into a wall left the car doing ${stopped.carSpeed} m/s.`);
    }
    // Reverse is not probed -- see `stepCarSpeed` -- so backing into the same
    // wall must be untouched by it rather than mysteriously braked.
    const back: DriveState = { drivingCar: 1, carSpeed: -5 };
    if (stepCarSpeed(back, { forward: -1, jump: false }, 1 / 60, 0, 0, 0, 0, wall)) {
      failures.push('The nose probe fired while reversing; it only looks forwards.');
    }
  }

  // --- One car, two claimants, one driver; and the ghost is suppressed.
  {
    const field = new CarField();
    const source: TakeableCar = { identity: 0xabcd01, body: 2, colour: 3, x: 10, y: 1, z: -4, yaw: 0.5, parked: true };
    const first = field.take(source, 7);
    if (first === null) failures.push('The first take of a free car was refused.');
    if (field.take(source, 8) !== null) {
      failures.push('Two players both took the same ambient car. A claim must resolve to one driver.');
    }
    if (!field.suppressed(source.identity)) {
      failures.push('A taken car was not suppressed; the ambient copy is still driving to Ashfield.');
    }
    if (field.suppressed(source.identity ^ 1)) failures.push('An untaken car was suppressed.');
    if (field.carOf(7) !== first!.id) failures.push(`carOf(7) said ${field.carOf(7)}, not ${first!.id}.`);
    if (field.carOf(8) !== 0) failures.push('carOf named a car for somebody who is not driving.');
    if (field.carOf(0) !== 0) failures.push('carOf answered for player id 0, which is "nobody" on the wire.');
    const pose = field.carPose(first!.id);
    if (!pose || pose.x !== 10 || pose.yaw !== 0.5) failures.push('carPose did not describe the car it was asked about.');
    if (field.carPose(99999) !== null) failures.push('carPose invented a car that does not exist.');

    // Ids are never reused, so a delete in flight cannot remove the wrong car.
    field.remove(first!.id);
    if (field.suppressed(source.identity)) failures.push('Removing a record left its ambient car suppressed.');
    const second = field.take(source, 9);
    if (second === null || second.id === first!.id) {
      failures.push(`A reallocated car got id ${second?.id}, which is the id just freed.`);
    }
  }

  // --- `follow` carries a car with its driver and leaves it where they stopped.
  {
    const field = new CarField();
    const car = field.take({ identity: 11, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 5)!;
    const other = field.take({ identity: 12, body: 0, colour: 0, x: 100, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    const driver = { id: 5, drivingCar: car.id, carSpeed: 14, x: 30, feetY: 2, z: -7, yaw: 1.2 };
    field.follow([driver]);
    if (car.x !== 30 || car.y !== 2 || car.z !== -7 || car.yaw !== 1.2 || car.speed !== 14) {
      failures.push(`A driven car did not follow its driver; it is at (${car.x}, ${car.y}, ${car.z}).`);
    }
    if (other.x !== 100) failures.push('An empty car moved when somebody else drove past.');

    // Knocked out: `combat.applyHit` clears the field and the sweep does the rest.
    driver.drivingCar = 0;
    const changed = field.follow([driver]);
    if (changed.length !== 1 || changed[0].id !== car.id) {
      failures.push(`Throwing a driver out reported ${changed.length} changed cars, not 1.`);
    }
    if (car.driverId !== 0) failures.push('A knocked-out driver is still in their car.');
    if (car.x !== 30) failures.push('A car left by a knockout did not stay where the driver was.');
    if (car.speed !== 0) failures.push(`An empty car is still doing ${car.speed} m/s.`);
    // And it is still suppressed, because it is still standing in the street.
    if (!field.suppressed(11)) failures.push('A car left in the street stopped suppressing its ambient copy.');
    // A driver who simply vanished -- a disconnect -- leaves it too.
    field.take({ identity: 13, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 6);
    field.follow([]);
    if (field.carOf(6) !== 0) failures.push('A disconnected driver kept their car forever.');
  }

  // --- Expiry: five minutes, and not while anybody is standing there.
  {
    const field = new CarField();
    const car = field.take({ identity: 21, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 0)!;
    const far = (): number => 1000;
    const near = (): number => 5;
    if (field.expire(ABANDON_MS - 1, far).length !== 0) failures.push('A car expired before its five minutes were up.');
    // Held at the threshold while somebody loiters, and released the moment they
    // leave -- not restarted, which would make loitering a way to pin a record.
    if (field.expire(1000, near).length !== 0) failures.push('A car expired with somebody standing next to it.');
    if (car.emptyMs !== ABANDON_MS) failures.push(`The loitering clamp left the clock at ${car.emptyMs}.`);
    const gone = field.expire(0, far);
    if (gone.length !== 1 || gone[0] !== car.id) failures.push('A car did not expire the moment the loiterer left.');
    if (field.size !== 0) failures.push('An expired car is still in the field.');
    if (field.suppressed(21)) failures.push('An expired car still suppresses its ambient copy; it never came back.');
    // A car with somebody in it never ages at all.
    const driven = field.take({ identity: 22, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true }, 3)!;
    field.expire(ABANDON_MS * 10, far);
    if (field.get(driven.id) === undefined) failures.push('A car somebody was driving expired underneath them.');
  }

  // --- `resolveTake` is not exercised here -- it needs a `TrafficField` with a
  //     real lane sidecar in it, which is `server/integration-check.ts`' job.
  //     What *is* checkable without one is that the two radii it uses are the
  //     bikes', because "E has one reach" is a rule and not a coincidence.
  if (TAKE_RADIUS !== 2.2 || TAKE_HEIGHT !== 2.5) {
    failures.push(
      `A car is taken from ${TAKE_RADIUS} m and ${TAKE_HEIGHT} m up, where a bike is taken from 2.2 and 2.5. ` +
        'E has one reach.',
    );
  }
  if (!(TAKEABLE_SPEED > 0 && TAKEABLE_SPEED < DRIVE_TOP_SPEED)) {
    failures.push(`TAKEABLE_SPEED is ${TAKEABLE_SPEED}, which is not "a car that has nearly stopped".`);
  }

  // --- The witness sees over open ground, not through walls, and not the fallen.
  {
    const one = (px: number, pz: number, down = false) =>
      (visit: (a: number, b: number, c: number, d: boolean) => void): void => visit(px, 0, pz, down);
    if (!bystanderSeen(0, 0, 0, one(5, 0), null)) failures.push('A pedestrian five metres away saw nothing.');
    if (bystanderSeen(0, 0, 0, one(WITNESS_RADIUS + 1, 0), null)) {
      failures.push(`Somebody past the ${WITNESS_RADIUS} m range witnessed a theft.`);
    }
    if (bystanderSeen(0, 0, 0, one(5, 0), () => true)) failures.push('A witness saw a theft through a wall.');
    if (bystanderSeen(0, 0, 0, one(5, 0, true), null)) {
      failures.push('Somebody face down on the footpath was counted as a witness.');
    }
    if (bystanderSeen(0, 0, 0, () => {}, null)) failures.push('An empty street witnessed a theft.');
  }

  return failures;
}

/** Scratch a caller needs to run `resolveTake`. Here so both ends allocate it the same way. */
export function createDrivingScratch(): { routes: LaneRoute[]; pose: CarPose; take: TakeableCar } {
  return { routes: [], pose: createCarPose(), take: createTakeable() };
}
