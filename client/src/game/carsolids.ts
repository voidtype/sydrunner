/**
 * The cars, as boxes a body on foot has to walk around.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT WAS WRONG, AND WHOSE SENTENCE IT WAS.
 *
 * `server/carcoverage-check.ts` rams every population of car in the game and
 * prints a row each, and its report ends with the one line this file exists to
 * delete: *"On foot, everything. The static fleet is not in the collision
 * prisms and no pedestrian capsule is tested against it."* It was true of far
 * more than the static fleet. A player, a bot, a police officer, a pedestrian, a
 * dog and a knocked-out body all walked straight through:
 *
 *     the 1.4 M cars parked at the kerb        `game/staticcars.ts`
 *     the schedule fleet, in a bay or moving   `traffic.forEachCarNear`
 *     a car somebody parked and got out of     `driving.CarField`
 *     a wreck knocked loose out of the kerb    the same, with `loose`
 *
 * Cars were solid to other **cars** -- `game/rigid.ts` with masses and impulses,
 * `sim.resolveCarContacts`, `resolveStaticContacts`, all of it ratcheted by that
 * check -- and solid to nobody's legs. The owner's standing brief is *"5x less
 * janky"* and this was the largest remaining hole in it: every street in Sydney
 * is lined with furniture you can stand inside.
 *
 * ---------------------------------------------------------------------------
 * 2. WHERE THE BOXES GO, AND WHY NOT INTO THE PRISM GRID.
 *
 * `player/collision.CarSolidSource` is the seam and its header carries the whole
 * argument; the short version is that a prism is baked and a car is not, a car
 * can stop being there (`CarField.suppressed`), and half the callers of
 * `resolve` are moving cars rather than legs and must not see the fleet at all.
 * So this file is a **source, asked per query**: `CollisionWorld.resolve` asks
 * it once for every body it moves, at about three and a half metres, and pushes
 * the capsule out of whatever comes back.
 *
 * That makes the wiring exactly two lines in each of the two processes that
 * have a fleet -- `server/sim.ts` and `client/src/main.ts` -- and *nothing* in
 * the dozen checks and probes that build a bare `CollisionWorld`. A world with
 * no `setCarSolids` call is byte for byte the world that shipped.
 *
 * ---------------------------------------------------------------------------
 * 3. THE BOX IS THE BOX THE CRASH LAYER ALREADY USES.
 *
 * Three fleets, three fills, and they are not invented here -- each one is the
 * box that population already has:
 *
 *   - a **kerb car** and a **record**: `CAR_BODY_SIZE` halved, with no margin
 *     and no render scale. That is `driving.carRigidBody`'s and
 *     `driving.staticRigidBody`'s choice and that header argues it at length:
 *     a parked car is furniture a player walks up to and can see the edges of,
 *     and a car that changed size at the instant it was knocked loose would pop.
 *   - a **schedule car**: `CarPose.halfLength` / `halfWidth`, which carry
 *     `traffic.HIT_MARGIN` and the pose's own 0.96-1.04 scale, because that is
 *     what the pose has and it is the box `traffic.carOverlaps` already knocks
 *     that same body down with.
 *
 * The 10 cm the two conventions differ by is under the width of the paint. What
 * matters is the rule they share: **one box per car, and a player and a car do
 * not disagree about where a car is.**
 *
 * The kerb fleet's render scale is not available and is not missed. `.cars.bin`
 * carries a `seed` that `world/cars.buildTileCars` turns into a +/-4 % uniform
 * scale, and `StaticCarField` drops the seed on the way in (its section 2 says
 * so, and 18 bytes a car over 1.4 M cars is why). Four per cent of the widest
 * body is 3.8 cm; `CAR_BODY_SIZE` is the same number in both processes and a
 * standoff neither end can compute differently is worth more than 3.8 cm of
 * fidelity to a jitter nobody can see.
 *
 * ---------------------------------------------------------------------------
 * 4. DETERMINISM, AND THE TICK.
 *
 * Three-free by rule, like `game/traffic.ts` and `game/staticcars.ts` and for
 * their reason: the Bun server imports it. Everything on the shared path is
 * `+ - * /`, comparisons and the `Math.sqrt` `poseCar` already allows. The two
 * `Math.sin`/`cos` per candidate are `driving.staticRigidBody`'s own -- a
 * sidecar stores a rotation and a record stores a yaw, and there is no route
 * from either to `(dx, dz)` that is not a sine -- and that header's paragraph
 * applies word for word: a last-bit disagreement moves a corner by 1e-16 m and
 * could only change an answer in an exact tie, which `resolveCars` breaks on an
 * integer.
 *
 * **The tick is set by the owner once per step, not read from the clock here.**
 * A schedule car's pose is a pure function of `(route, slot, tick)`, so two
 * processes stepping the same tick see the same box; a field that called
 * `trafficTick(Date.now())` itself would give the reconciler's replay a
 * *different* box on every one of the three to five frames it re-runs, which is
 * a body that slides along a car that was not there. `server/sim.step` writes
 * `tick` at the top of the tick and `main.ts` writes it beside the prediction,
 * which is where every other traffic query in this game already gets it.
 *
 * The residual is stated rather than hidden, because it is the one this feature
 * cannot remove: the client predicts at *its* wall clock and the server confirms
 * at *its own*, so a schedule car doing 14 m/s is up to a round trip's worth of
 * metres apart on the two ends. That is the identical residual
 * `traffic.carHitting`'s prediction in `main.ts` already carries, it is absorbed
 * by `net/client.CORRECTION_DEADZONE` the same way, and it is zero for the
 * populations that actually line a street -- a kerb car has no clock at all and
 * a schedule car in its bay is at rest for its whole dwell.
 */

import {
  CAR_BODY_SIZE,
  createCarPose,
  forEachCarNear,
  syntheticTile,
  TrafficField,
  trafficSeconds,
  type CarPose,
  type LaneRoute,
} from './traffic.ts';
import {
  createStaticCarPose,
  decodeCars,
  StaticCarField,
  STATIC_CAR_STRIDE,
  type StaticCarSource,
} from './staticcars.ts';
import {
  CAR_SOLID_REACH,
  CollisionWorld,
  type CarSolid,
  type CarSolidSource,
} from '../player/collision.ts';
import { createPlayerState, PLAYER_RADIUS, step, STEP_HEIGHT, type InputSnapshot } from '../player/controller.ts';
import { TAKE_RADIUS } from './driving.ts';

/**
 * The one thing this file needs from a `driving.CarField`, structurally.
 *
 * An interface rather than the class for the reason `player/collision.ts` takes
 * a `CarSolidSource` rather than this one: a check hands over an array literal,
 * and neither end has to construct a `CarField` to prove a wreck is solid.
 * `CarField.all()` satisfies it and every field on it beyond these six is
 * ignored.
 */
export interface DrivenCarSolids {
  all(): ReadonlyArray<{
    /** Which ambient or kerb car this used to be. `DrivenCar.carId`. */
    carId: number;
    body: number;
    x: number;
    y: number;
    z: number;
    yaw: number;
  }>;
}

/**
 * Every car near a body, from all three fleets, as boxes.
 *
 * One per process. The owner sets the three sources and the tick; nothing here
 * holds a world, a clock or a renderer.
 */
export class CarSolidField implements CarSolidSource {
  /**
   * The parked fleet, or null. `StaticCarField` on both ends -- the server's
   * over its residency's third `HexLayer`, the browser's fed by the streamer.
   */
  statics: StaticCarSource | null = null;
  /** The timetable, or null. The same field every car in the city is drawn from. */
  traffic: TrafficField | null = null;
  /** The records: cars with drivers, cars somebody parked, and wrecks. */
  driven: DrivenCarSolids | null = null;
  /**
   * `driving.CarField.suppressed`, or a predicate that is never true.
   *
   * Applied to the **two ambient fleets and not to the records**, which is the
   * whole of how a stolen car is in one place rather than two: the identity is
   * suppressed, so the kerb car and the timetable car both stop being solid, and
   * the `DrivenCar` that replaced them is solid instead. A record filtered by
   * the same predicate would be every taken car in the room turning to fog.
   */
  suppressed: (identity: number) => boolean = () => false;
  /**
   * The traffic tick this field answers at. Written once per step by the owner.
   * See section 4.
   */
  tick = 0;

  /** Scratch. Allocated once; see `traffic.CarPose`'s own contract. */
  private readonly routes: LaneRoute[] = [];
  private readonly pose: CarPose = createCarPose();
  private readonly out: CarSolid = {
    identity: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1, halfLength: 0, halfWidth: 0, height: 0,
  };

  /** How many cars the last query handed over. The dev overlay and the checks. */
  lastCount = 0;

  /**
   * `CarSolidSource`. Allocation-free, and one pass per fleet.
   *
   * The order is cheapest-and-densest first: the kerb fleet is four comparisons
   * a tile and then a distance test a car, the timetable is a lane-graph query,
   * and the records are a linear walk of at most `MAX_DRIVEN_CARS`. Nothing here
   * depends on the order -- `CollisionWorld.resolveCars` sorts by penetration
   * and breaks ties on the identity precisely because it must not.
   */
  forEachCarSolidNear(
    x: number,
    feetY: number,
    z: number,
    radius: number,
    visit: (car: CarSolid) => void,
  ): void {
    const out = this.out;
    let n = 0;

    const statics = this.statics;
    if (statics !== null) {
      statics.forEachStaticNear(x, feetY, z, radius, (car) => {
        if (this.suppressed(car.identity)) return;
        const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
        out.identity = car.identity;
        out.x = car.x;
        out.y = car.y;
        out.z = car.z;
        // A look yaw: forward is `(-sin, -cos)`, which is `controller.step`'s
        // own basis and `driving.headingYaw`'s convention.
        out.dx = -Math.sin(car.yaw);
        out.dz = -Math.cos(car.yaw);
        out.halfLength = size.length * 0.5;
        out.halfWidth = size.width * 0.5;
        out.height = size.height;
        n++;
        visit(out);
      });
    }

    const traffic = this.traffic;
    if (traffic !== null) {
      forEachCarNear(traffic, x, z, radius, this.tick, this.routes, this.pose, (p) => {
        // **No stage is skipped, and that is the decision.** A car in its bay is
        // parked furniture and is solid; a car pulling out is solid; a car doing
        // 14 m/s is solid and will also knock you over (`traffic.carHitting`,
        // which is a different question asked of the same box). The one thing
        // that stops being solid is a car somebody has taken, and that is the
        // identity's business rather than the stage's.
        if (this.suppressed(p.identity)) return;
        out.identity = p.identity;
        out.x = p.x;
        out.y = p.y;
        out.z = p.z;
        out.dx = p.dx;
        out.dz = p.dz;
        // The pose's own halves, margin and scale included. See section 3.
        out.halfLength = p.halfLength;
        out.halfWidth = p.halfWidth;
        out.height = p.height;
        n++;
        visit(out);
      });
    }

    const driven = this.driven;
    if (driven !== null) {
      const r2 = radius * radius;
      for (const car of driven.all()) {
        const dx = car.x - x;
        const dz = car.z - z;
        if (dx * dx + dz * dz > r2) continue;
        const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
        out.identity = car.carId;
        out.x = car.x;
        out.y = car.y;
        out.z = car.z;
        out.dx = -Math.sin(car.yaw);
        out.dz = -Math.cos(car.yaw);
        out.halfLength = size.length * 0.5;
        out.halfWidth = size.width * 0.5;
        out.height = size.height;
        n++;
        visit(out);
      }
    }

    this.lastCount = n;
  }
}

// --- The self-check -----------------------------------------------------------

/** A `CarSolidSource` over an array. The checks', and nothing ships this. */
export function carSolidsOf(cars: ReadonlyArray<CarSolid>): CarSolidSource {
  return {
    forEachCarSolidNear(x, _feetY, z, radius, visit) {
      const r2 = radius * radius;
      for (const car of cars) {
        const dx = car.x - x;
        const dz = car.z - z;
        if (dx * dx + dz * dz > r2) continue;
        visit(car);
      }
    },
  };
}

/** A sedan parked with its nose along +X at (x, z), on the ground at y. */
export function sedanAt(identity: number, x: number, z: number, y = 0): CarSolid {
  const size = CAR_BODY_SIZE[0];
  return {
    identity,
    x,
    y,
    z,
    dx: 1,
    dz: 0,
    halfLength: size.length * 0.5,
    halfWidth: size.width * 0.5,
    height: size.height,
  };
}

/** Build a `.cars.bin` in memory. `verifyStaticCars`' own helper, one car wide. */
function oneCarSidecar(x: number, z: number, heading: number, body: number): ArrayBuffer {
  const buffer = new ArrayBuffer(4 + STATIC_CAR_STRIDE);
  const v = new DataView(buffer);
  v.setUint32(0, 1, true);
  v.setFloat32(4, x, true);
  v.setFloat32(8, z, true);
  v.setFloat32(12, heading, true);
  v.setUint8(16, body);
  v.setUint8(17, 0);
  v.setUint16(18, 0, true);
  return buffer;
}

/** Walk a capsule from `from` toward `to` in 60 Hz steps and report where it got. */
function walkInto(
  world: CollisionWorld,
  from: [number, number],
  yaw: number,
  ticks: number,
): { x: number; z: number } {
  const s = createPlayerState(from[0], from[1]);
  const input: InputSnapshot = { forward: 1, right: 0, jump: false, sprint: false, yaw, pitch: 0 };
  for (let i = 0; i < ticks; i++) step(s, input, 1 / 60, world, () => 0);
  return { x: s.position.x, z: s.position.z };
}

/**
 * What this catches that a typecheck cannot.
 *
 *   - **A fleet nothing asks about.** The whole feature is one wiring call per
 *     process; a `CarSolidField` with a source left null is a street that looks
 *     solid and is not, which is exactly the bug this file was written for and
 *     renders perfectly.
 *   - **A suppressed car that is still a wall.** A player who steals a car and
 *     drives off leaves a ghost box in the bay if the predicate is not applied,
 *     and the symptom -- an invisible car in an empty parking space -- is the
 *     single most confusing thing this feature could produce.
 *   - **A schedule car whose box does not follow it.** The bay is solid at the
 *     tick the car is in it and clear at a tick after it has pulled out; a field
 *     that cached, or that read its own clock, fails one of the two.
 *   - **A push that depends on which process asked.** Two fields built from the
 *     same bytes in different orders must move a body to the same bit over two
 *     hundred ticks, or prediction and authority disagree by a centimetre a tick
 *     and the reconciler rubber-bands.
 *   - **A body that cannot be freed.** A capsule that starts inside a car must
 *     be able to walk out; a guard that refused the move would freeze a driver
 *     in their own seat and a pedestrian a car parked on.
 *   - **A reach that a sixth body type outgrew.** `CAR_SOLID_REACH` is the
 *     broadphase and a box bigger than it is a car with a corner nothing tests.
 *   - **A standoff that puts `E` out of reach.** A car you can stand beside and
 *     not take is a bug report; see the take clause below for the one approach
 *     this feature does change and why that is the right answer.
 */
export function verifyCarSolids(): string[] {
  const failures: string[] = [];
  const say = (s: string): void => void failures.push(s);

  // --- The broadphase covers every box any fleet can hand over.
  for (let b = 0; b < CAR_BODY_SIZE.length; b++) {
    const size = CAR_BODY_SIZE[b];
    // `poseCar`'s ceiling scale and `traffic.HIT_MARGIN`, which is the largest
    // the schedule fill can be.
    const hl = size.length * 0.5 * 1.04 + 0.1;
    const hw = size.width * 0.5 * 1.04 + 0.1;
    const diag = Math.sqrt(hl * hl + hw * hw);
    if (diag > CAR_SOLID_REACH) {
      say(
        `Body ${b} has a half-diagonal of ${diag.toFixed(3)} m against a CAR_SOLID_REACH of ` +
          `${CAR_SOLID_REACH}. A car that far out is not in the broadphase and has a corner nothing tests.`,
      );
    }
  }

  // --- The take still reaches the driver's door. See the paragraph in
  //     `main.ts`/`sim.ts`'s wiring: the widest body decides it, because a
  //     player gets in from the side.
  let widest = 0;
  for (const size of CAR_BODY_SIZE) widest = Math.max(widest, size.width * 0.5 * 1.04 + 0.1);
  const doorStandoff = widest + PLAYER_RADIUS;
  if (doorStandoff >= TAKE_RADIUS) {
    say(
      `A player is now held ${doorStandoff.toFixed(2)} m from the centre of the widest car and \`E\` ` +
        `reaches ${TAKE_RADIUS} m. The door is out of reach: raise TAKE_RADIUS (and bikes.MOUNT_RADIUS ` +
        'with it -- E has one reach) or shrink the box.',
    );
  }

  // --- A capsule against a parked sedan, from four sides.
  //
  // The geometry cases proper are `verifyMovementBasis`', which is where the
  // controller's own step lives. What is checked here is the *field*: the same
  // walk with the kerb fleet wired in and wired out.
  {
    const cars = new StaticCarField();
    const decoded = decodeCars(oneCarSidecar(0, 0, 0, 0), 'kerb');
    if (decoded === null) {
      say('The one-car sidecar this check builds did not decode. `decodeCars` or the stride has moved.');
    } else {
      cars.adopt('kerb', decoded, 0, 0);
      // The field's default `groundAt` answers "wherever the asker is", which is
      // the only honest answer a process with no terrain can give (see
      // `StaticCarField.groundAt`) and would put every car's wheels at the
      // probe's own feet -- a box that follows you up. A flat street is what a
      // check about walls wants.
      cars.groundAt = () => 0;
      const field = new CarSolidField();
      field.statics = cars;
      const world = new CollisionWorld();

      // Without the fleet: straight through, as it shipped.
      const through = walkInto(world, [0, 6], 0, 150);
      if (through.z > 1.5) {
        say(
          `With no fleet wired the walk stopped at z=${through.z.toFixed(2)} rather than passing the ` +
            'origin. Something other than the cars is in the way and this check means nothing.',
        );
      }

      world.setCarSolids(field);
      // The sidecar's heading 0 means a nose along +X (`staticLookYaw` takes it
      // to -PI/2, and `(-sin, -cos)` of that is `(1, 0)`), so the car is 4.6 m
      // along X and 1.8 m across Z.
      const size = CAR_BODY_SIZE[0];
      const sideStandoff = size.width * 0.5 + PLAYER_RADIUS;
      const endStandoff = size.length * 0.5 + PLAYER_RADIUS;
      const sides: Array<[string, [number, number], number, number, 'x' | 'z']> = [
        ['from the north', [0, 6], 0, sideStandoff, 'z'],
        ['from the south', [0, -6], Math.PI, -sideStandoff, 'z'],
        ['from the east', [9, 0], Math.PI / 2, endStandoff, 'x'],
        ['from the west', [-9, 0], -Math.PI / 2, -endStandoff, 'x'],
      ];
      for (const [label, from, yaw, want, axis] of sides) {
        const got = walkInto(world, from, yaw, 150);
        const at = axis === 'x' ? got.x : got.z;
        const other = axis === 'x' ? got.z : got.x;
        if (Math.abs(at - want) > 0.02) {
          say(
            `Walking ${label} into a parked sedan stopped at ${axis}=${at.toFixed(3)}; the box face plus ` +
              `the capsule radius is ${want.toFixed(3)}. Penetration ${Math.abs(Math.abs(want) - Math.abs(at)).toFixed(3)} m.`,
          );
        }
        if (Math.abs(other) > 0.05) {
          say(`Walking ${label} into a parked sedan slid ${other.toFixed(3)} m sideways; it should not.`);
        }
      }

      // Past the corner: a body walking down the street 20 cm outside the boot
      // is deflected round the bumper and carries on, rather than being caught on
      // it. This is the case a push normal computed from the box *centre* rather
      // than from the nearest face gets wrong, and it is the one a player meets
      // every time they walk along a kerb row.
      {
        const s = createPlayerState(size.length * 0.5 + 0.2, 6);
        const input: InputSnapshot = {
          forward: 1, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0,
        };
        for (let i = 0; i < 200; i++) step(s, input, 1 / 60, world, () => 0);
        if (s.position.z > -3) {
          say(
            `A body walking past the boot of a parked sedan got to z=${s.position.z.toFixed(2)} in 200 ` +
              'ticks. It should have been nudged round the corner and carried on down the street.',
          );
        }
      }

      // A car is not a step: a body cannot end up standing on the roof, and the
      // approach is refused at every height inside the body's own band.
      {
        const onRoof = world.resolve(0, 6, 0, 0, PLAYER_RADIUS, size.height + 0.42, size.height + 2.2);
        if (onRoof.hit) {
          say('A body whose feet are level with the roof was still stopped by the car. That is a wall in the air.');
        }
        const atKerb = world.resolve(0, 6, 0, 0, PLAYER_RADIUS, STEP_HEIGHT, STEP_HEIGHT + 1.8);
        if (!atKerb.hit) {
          say(
            `A body probing with lifted feet (${STEP_HEIGHT} m, the kerb the controller climbs) walked ` +
              'into a sedan. A bonnet is not a kerb.',
          );
        }
      }

      // --- Suppressed: the car somebody drove away in is not still parked here.
      field.suppressed = () => true;
      const gone = walkInto(world, [0, 6], 0, 150);
      if (gone.z > 1.5) {
        say(
          `A suppressed kerb car was still solid: the walk stopped at z=${gone.z.toFixed(2)}. That is an ` +
            'invisible car standing in an empty bay.',
        );
      }
      field.suppressed = () => false;

      // --- A body that starts inside a car can walk out. See `resolveCars`.
      {
        const s = createPlayerState(0, 0);
        const input: InputSnapshot = {
          forward: 1, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0,
        };
        for (let i = 0; i < 90; i++) step(s, input, 1 / 60, world, () => 0);
        if (Math.abs(s.position.z) < 1.5) {
          say(
            `A body that started inside a car got to z=${s.position.z.toFixed(2)} in 90 ticks of walking ` +
              'out. It is pinned, which is a freeze rather than a wall.',
          );
        }
      }
    }
  }

  // --- A schedule car is solid in its bay at that tick, and gone once it has
  //     pulled out. The synthetic street `verifyTraffic` uses.
  {
    const traffic = new TrafficField();
    traffic.adopt('street', syntheticTile(3.5, 0, 0, undefined, 12, 3, 0, 0x5eed, 0));
    const field = new CarSolidField();
    field.traffic = traffic;
    const world = new CollisionWorld();
    world.setCarSolids(field);

    const routes: LaneRoute[] = [];
    const pose = createCarPose();
    /** Find a tick at which some car near the origin is standing still. */
    let bayTick = -1;
    let bayX = 0;
    let bayZ = 0;
    for (let t = 0; t < 60 * 240 && bayTick < 0; t += 10) {
      forEachCarNear(traffic, 0, 0, 90, t, routes, pose, (p) => {
        if (p.speed !== 0) return;
        bayTick = t;
        bayX = p.x;
        bayZ = p.z;
        return true;
      });
    }
    if (bayTick < 0) {
      say('No schedule car on the synthetic street was ever at rest. The fixture, not the feature.');
    } else {
      field.tick = bayTick;
      const inBay = world.resolve(bayX, bayZ + 6, bayX, bayZ, PLAYER_RADIUS, 0.42, 2.22);
      if (!inBay.hit) {
        say(
          `A schedule car standing at (${bayX.toFixed(1)}, ${bayZ.toFixed(1)}) at tick ${bayTick} was not ` +
            'solid. A car in a bay is a car.',
        );
      }
      // And a tick at which nothing is within a car's length of that spot: the
      // same probe must be free. Searched rather than assumed, because the
      // headway decides when the bay is next occupied.
      let clearTick = -1;
      for (let t = bayTick + 60; t < bayTick + 60 * 600 && clearTick < 0; t += 30) {
        let occupied = false;
        forEachCarNear(traffic, bayX, bayZ, 4, t, routes, pose, () => {
          occupied = true;
          return true;
        });
        if (!occupied) clearTick = t;
      }
      if (clearTick < 0) {
        say('The synthetic bay was never empty within ten minutes of clock. The fixture, not the feature.');
      } else {
        field.tick = clearTick;
        const empty = world.resolve(bayX, bayZ + 6, bayX, bayZ, PLAYER_RADIUS, 0.42, 2.22);
        if (empty.hit) {
          say(
            `The bay at (${bayX.toFixed(1)}, ${bayZ.toFixed(1)}) was still solid at tick ${clearTick}, ` +
              'after the car had gone. The box does not follow the timetable.',
          );
        }
      }
      if (trafficSeconds(bayTick) < 0) say('trafficSeconds went backwards; the fixture is not usable.');
    }
  }

  // --- Determinism: two fields, built in two orders, over 200 ticks.
  {
    const build = (order: readonly number[]): CollisionWorld => {
      const cars = new StaticCarField();
      cars.groundAt = () => 0;
      // Four cars, adopted one tile each so that the `Map`'s iteration order
      // really is the adoption order -- two processes stream tiles in different
      // orders and this is that difference, made on purpose.
      //
      // **The 2.45 is chosen and not arbitrary**: it leaves a gap between the
      // sedan at the origin and the ute beside it that is 5 cm *narrower* than
      // the capsule, so a body walking into it is pushed by two boxes on the
      // same tick. That is the only arrangement that can tell a deepest-first
      // push from a first-found one; a gap the body fits through diverges under
      // neither, which is how a fixture goes green while proving nothing. With
      // the tie-break removed the two walks below part company on tick 91.
      const spots: Array<[number, number]> = [[0, 0], [0, 6], [0, -6], [2.6, 2.45]];
      for (const i of order) {
        const decoded = decodeCars(oneCarSidecar(spots[i][0], spots[i][1], 0, i % CAR_BODY_SIZE.length), `t${i}`);
        if (decoded !== null) cars.adopt(`t${i}`, decoded, 0, 0);
      }
      const field = new CarSolidField();
      field.statics = cars;
      const world = new CollisionWorld();
      world.setCarSolids(field);
      return world;
    };
    const a = build([0, 1, 2, 3]);
    const b = build([3, 1, 0, 2]);
    const sa = createPlayerState(-6, 1.5);
    const sb = createPlayerState(-6, 1.5);
    const input: InputSnapshot = {
      forward: 1, right: 0, jump: false, sprint: true, yaw: -Math.PI / 2, pitch: 0,
    };
    for (let i = 0; i < 200; i++) {
      step(sa, input, 1 / 60, a, () => 0);
      step(sb, input, 1 / 60, b, () => 0);
      if (sa.position.x !== sb.position.x || sa.position.z !== sb.position.z) {
        say(
          `Two fields fed the same four cars in different adoption orders diverged on tick ${i}: ` +
            `(${sa.position.x}, ${sa.position.z}) against (${sb.position.x}, ${sb.position.z}). ` +
            'The push is order-dependent and prediction cannot match authority.',
        );
        break;
      }
    }
  }

  // --- A record and a wreck are solid, on the same terms.
  {
    const field = new CarSolidField();
    field.driven = {
      all: () => [{ carId: 77, body: 3, x: 0, y: 0, z: 0, yaw: Math.PI / 2 }],
    };
    // A ute nose-along-X (yaw PI/2 gives `(-sin, -cos)` = (-1, 0)).
    field.suppressed = () => true; // records are never filtered; see the field.
    const world = new CollisionWorld();
    world.setCarSolids(field);
    const got = walkInto(world, [0, 6], 0, 150);
    const want = CAR_BODY_SIZE[3].width * 0.5 + PLAYER_RADIUS;
    if (Math.abs(got.z - want) > 0.02) {
      say(
        `A parked record stopped a body at z=${got.z.toFixed(3)} rather than ${want.toFixed(3)}. Either a ` +
          'record is not solid, or `suppressed` is being applied to the records as well as the fleets.',
      );
    }
  }

  // --- A pose whose reused record is not copied out. `forEachCarSolidNear`
  //     hands the *same* object to every visit, on `CarPose`'s contract, and a
  //     resolver that kept the reference would resolve every car as the last
  //     one. Checked by asking for two cars and reading both.
  {
    const seen: Array<{ x: number; z: number }> = [];
    carSolidsOf([sedanAt(1, 0, 0), sedanAt(2, 0, 8)]).forEachCarSolidNear(
      0, 0, 4, 30, (car) => void seen.push({ x: car.x, z: car.z }),
    );
    if (seen.length !== 2 || seen[0].z === seen[1].z) {
      say('The array-backed source handed over the same car twice; the checks above are not testing two cars.');
    }
  }

  const probe = createStaticCarPose();
  if (probe.identity !== 0) say('createStaticCarPose no longer zeroes its record; the fills above may read stale fields.');

  return failures;
}
