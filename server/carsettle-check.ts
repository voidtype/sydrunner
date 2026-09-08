/**
 * Cars that **stop**, and cars that stay on the ground. PERMANENT.
 *
 *     bun run server/carsettle-check.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS.
 *
 * The owner's report on the live build was one line and two defects:
 *
 *     "sone cars are no floating, there needs some damp[ening] for collision
 *      otherwise can vibrate between 2 spot"
 *
 * Every check this project had was green when it was written, and each of them
 * could only have been green: `verifyRigid` resolves a contact **once** and asks
 * what came out; `verifyCarPhysics` drives a `CarField` with no world and no
 * ground; `server/carcrash-check.ts` asks whether a crash lands where the module
 * says; `server/carcoverage-check.ts` asks *which* cars get a contact at all.
 * None of them asks the two questions a player actually asks after the contact
 * is over -- **did it stop, and is the car on the road** -- and neither of those
 * can be answered on one tick or on flat ground.
 *
 * So this file asks them over the real `Simulation`, over hundreds of ticks, on
 * geometry that is not flat.
 *
 *   1. **A driver holding the throttle against a kerb car.** The contact
 *      persists; the position has to converge. Measured as the per-tick
 *      displacement along the contact normal and, more importantly, how often
 *      that displacement changes **sign** -- the failure is a limit cycle of
 *      about a millimetre, so an amplitude bound alone cannot see it. See
 *      `game/rigid.ts` section 7.
 *   2. **A driver in a bay between two kerb cars**, which is the case with two
 *      spots in it: a full positional correction off the car in front lands you
 *      in the car behind, whose full correction lands you back.
 *   3. **Two drivers pressing into each other**, so that no body in the contact
 *      is kinematic and both separations and both impulses are live.
 *   4. **A wreck rolling into a kerb car.** It has to come to rest, because a
 *      wreck that never rests is a wreck `CarField.recycleLooseIds` can never
 *      give back and a bay that never comes back.
 *   5. **A wreck rolling onto a raised surface.** The grounding half, and the
 *      one that needs a world with a step in it: a car that is moved in plan by
 *      anything other than a driver has nothing to re-ground it, because a
 *      driven car's height is its driver's capsule and a driverless one has no
 *      capsule at all. Asserted on the server **and on a client mirror**
 *      integrating the same records through the same `game/driving.ts`, because
 *      the two ends run that integrator between the 10 Hz corrections and a
 *      mirror that floated would float on the screen it is drawn on.
 *   6. **A parked record shunted onto that surface**, which is the same rule
 *      through `Simulation.applyCarBody` rather than through `integrateLoose`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PLATFORM IS 0.40 m AND NOT 0.50.
 *
 * Sections 5 and 6 need a surface a car can be moved *onto*, and the height is
 * pinned between two constants rather than chosen. `driving.NOSE_STEP` is 0.42
 * -- the allowance every car-shaped query in this game lifts its feet by, so
 * that a kerb is climbed rather than driven into -- and `CollisionWorld.solidFor`
 * treats a prism whose top is under the lifted feet as steppable. A platform at
 * 0.40 m is therefore something a wreck **rolls onto** rather than something it
 * stops against, which is the case this file is about; at 0.50 m it would be a
 * wall and both sections would measure nothing while passing.
 *
 * It is also, deliberately, a real number: 0.40 m is a high kerb, a driveway
 * crossover lip, a plaza edge or the shoulder of a road deck, which is the list
 * of things the owner's floating cars were standing over.
 *
 * ---------------------------------------------------------------------------
 * THE BOUNDS, AND WHERE THEY COME FROM.
 *
 * `GROUNDED` is 5 cm, which is the brief's number and is the right shape: it is
 * under a kerb (0.15 m) and over the disagreement between two terrain grids
 * (`game/staticcars.ts` section 3 measures that at a centimetre).
 *
 * `SETTLED_STEP` is 1 cm a tick, and `SETTLED_FLIPS` is two sign changes after
 * the first second. The second is the one that does the work and the first is
 * the sanity bound beside it; the limit cycle this file was written for
 * oscillates over 1.4 mm and would pass any amplitude bound anybody would think
 * to write.
 */

import { Simulation, type TickOutput } from './sim.ts';
import { groundFor, type ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { TICK_HZ } from '../client/src/net/protocol.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { CarField } from '../client/src/game/driving.ts';
import { StaticCarField, decodeCars, STATIC_CAR_STRIDE } from '../client/src/game/staticcars.ts';

const FIXED_DT = 1 / TICK_HZ;

/** How far off the ground under it a car may be, metres. The owner's number. */
const GROUNDED = 0.05;
/** And what a settled contact may move a tick, metres. */
const SETTLED_STEP = 0.01;
/** ...and how many times its direction may reverse after the first second. */
const SETTLED_FLIPS = 2;
/**
 * ...and what it may still be *doing*, m/s. See `Settling.speed`.
 *
 * A centimetre a second, which is a fifth of what the shipped code left a car
 * pinned against a kerb doing and is under `driving.LOOSE_REST_SPEED`.
 */
const SETTLED_SPEED = 0.01;
/** Below this a displacement is float noise rather than a direction, metres. */
const SETTLE_NOISE = 1e-5;
/** How long a settling case is watched, ticks, and how much of it is the settling. */
const WATCH_TICKS = 300;
const SETTLE_TICKS = 60;
/** See the header: pinned under `driving.NOSE_STEP` so a car rolls onto it. */
const PLATFORM_Y = 0.4;

const failures: string[] = [];
function fail(message: string): void {
  failures.push(message);
}

// --- The worlds --------------------------------------------------------------------

/** `carcrash-check.emptyWorld`, field for field. No street, no prisms. */
function emptyWorld(): ServerWorld {
  return worldWith(new CollisionWorld());
}

/**
 * The same world with a 60 m square platform 0.40 m up, centred on the origin.
 *
 * A `structural` prism through `addPrisms`, which is what a deck, a viaduct and
 * a landmark podium all are -- so `groundFor`'s `roofHeight` answers 0.40 for
 * anything standing on it and the terrain's 0 for anything beside it. See the
 * header for why 0.40 and not 0.50.
 */
function platformWorld(): ServerWorld {
  const collision = new CollisionWorld();
  collision.addPrisms('platform', [
    {
      points: new Float32Array([10, -30, 70, -30, 70, 30, 10, 30]),
      height: PLATFORM_Y,
      base: 0,
    },
  ]);
  return worldWith(collision);
}

/**
 * A world with **kerb cars** in it, at the places the caller names.
 *
 * The population every settling case below leans on, and it has to be this one
 * rather than a `DrivenCar` record: a record with nobody in it is *pushable* --
 * `Simulation.applyCarBody` writes a velocity onto it and sets `loose`, which is
 * `game/driving.ts` section 7's "a car park is something you can push your way
 * through" and is correct -- so a bay built out of records is not a bay, it is
 * two cars that move over. A car out of `.cars.bin` under `KNOCK_LOOSE_SPEED` is
 * a wall (`driving.resolveStaticContact` section 2), which is what a bay is made
 * of and is also what the owner is actually parking against: the kerb fleet is
 * twenty-three thousand cars inside a draw radius against the timetable's forty.
 *
 * The sidecar is written to the pipeline's own 16-byte layout and read back
 * through the shipped `decodeCars`, so nothing here is a second decoder.
 */
function kerbWorld(
  cars: ReadonlyArray<{ x: number; z: number }>,
  collision = new CollisionWorld(),
): ServerWorld {
  const world = worldWith(collision);
  const buffer = new ArrayBuffer(4 + cars.length * STATIC_CAR_STRIDE);
  const v = new DataView(buffer);
  v.setUint32(0, cars.length, true);
  for (let i = 0; i < cars.length; i++) {
    const o = 4 + i * STATIC_CAR_STRIDE;
    v.setFloat32(o, cars[i].x, true);
    v.setFloat32(o + 4, cars[i].z, true);
    // Heading 0 is `staticLookYaw`'s quarter turn: the car points down -X. Every
    // case below is on the Z axis, so the kerb cars are placed nose-north with
    // `heading = -PI/2` and the subtraction takes care of the rest.
    v.setFloat32(o + 8, -Math.PI / 2, true);
    v.setUint8(o + 12, 0);
    v.setUint8(o + 13, 0);
    v.setUint16(o + 14, 0, true);
  }
  const data = decodeCars(buffer, 'kerb');
  if (data === null) throw new Error('the fixture sidecar did not decode');
  const field = new StaticCarField();
  field.adopt('kerb', data, 0, 0);
  const ground = groundFor(world);
  field.groundAt = (x, z, near) => ground.groundHeight(x, z, near);
  world.staticCars = field;
  return world;
}

function worldWith(collision: CollisionWorld): ServerWorld {
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
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

// --- Convergence ---------------------------------------------------------------------

/** What a settling case measures. See the header for the two bounds. */
interface Settling {
  /** The worst per-tick displacement after the first second, metres. */
  late: number;
  /** And how many times its sign reversed in that stretch. */
  flips: number;
  /** Where it ended up, so a case that never touched anything can say so. */
  travelled: number;
  /**
   * And what the car's **speed** was when the watch ended, m/s.
   *
   * ---------------------------------------------------------------------------
   * THE MEASUREMENT THAT ACTUALLY CONVICTED THE SERVER PATH, AND IT IS NOT THE
   * POSITION.
   *
   * The first run of this file against the shipped constants reported a perfect
   * `0.000 cm a tick, 0 sign flips` for a driver holding W into a kerb car -- and
   * it was telling the truth. `driving.resolveStaticContact`'s closing-speed gate
   * means a car that has stopped is not in contact at all, so the position
   * genuinely stops moving: the tick's forward travel and the tick's push-back
   * cancelled to the last bit.
   *
   * What did **not** stop was the speed. It settled at a permanent **-0.05 m/s**
   * -- the car pinned against the kerb car with the throttle held down, reading
   * five centimetres a second **in reverse**, forever. That is the same limit
   * cycle the position shows in the bare layer (`rigid.verifyRigid` case 9a
   * measures 119 sign reversals of it) seen through a gate that hides its
   * displacement, and it is a real thing a player sees: the reversing lights, the
   * wheels, the speedometer and every rule that reads `carSpeed < 0`.
   *
   * So the bound is on both, and this is the half that fails first.
   */
  speed: number;
}

/** One settling record, accumulated a tick at a time. */
class Settle {
  late = 0;
  flips = 0;
  private sign = 0;
  private last = 0;
  private started = false;
  private from = 0;

  /**
   * `after` is the tick the watch begins on, and it is a parameter because "the
   * first second" has to mean *the first second of the contact*. A wreck that
   * rolls six metres before it touches anything is still legitimately rolling at
   * tick 60, and a bound applied to it would be a bound on the decay rather than
   * on the contact.
   */
  constructor(private readonly after = SETTLE_TICKS) {}

  /** The tracked coordinate at the top of the tick. */
  begin(value: number): void {
    if (!this.started) {
      this.from = value;
      this.started = true;
    }
    this.last = value;
  }

  /** ...and at the bottom of it. `i` is the tick index. */
  end(value: number, i: number): void {
    const step = value - this.last;
    if (i < this.after) return;
    const mag = step < 0 ? -step : step;
    if (mag > this.late) this.late = mag;
    if (mag < SETTLE_NOISE) return;
    const s = step > 0 ? 1 : -1;
    if (this.sign !== 0 && s !== this.sign) this.flips++;
    this.sign = s;
  }

  done(value: number, speed: number): Settling {
    const d = value - this.from;
    return { late: this.late, flips: this.flips, travelled: d < 0 ? -d : d, speed };
  }
}

/** The sentence every settling section says about its own numbers. */
function judge(name: string, r: Settling): void {
  if (r.late >= SETTLED_STEP) {
    fail(
      `${name}: a second after the contact began the car still moves ${(r.late * 100).toFixed(2)} cm a tick ` +
        `against a bound of ${SETTLED_STEP * 100} cm. A contact that has settled does not move.`,
    );
  }
  if (r.flips > SETTLED_FLIPS) {
    fail(
      `${name}: the displacement along the contact normal reversed ${r.flips} times after it should have ` +
        `settled, against a bound of ${SETTLED_FLIPS}. That is the owner's "vibrate between 2 spot" -- see ` +
        'game/rigid.ts section 7.',
    );
  }
  const speed = r.speed < 0 ? -r.speed : r.speed;
  if (speed >= SETTLED_SPEED) {
    fail(
      `${name}: the car is at rest against something and its speed is ${r.speed.toFixed(4)} m/s. A contact ` +
        'that has settled leaves nothing behind -- see Settling.speed, which is the measurement that ' +
        'convicted the server path when the position looked perfect.',
    );
  }
}

/**
 * Put a driver in a car at a place, facing a yaw, and hold the throttle.
 *
 * `carcrash-check.place` plus the take, which is the same pair of calls
 * `tryTakeCar` makes: this world has no lane sidecar and what is being exercised
 * is the contact rather than the theft.
 */
function driverAt(
  sim: Simulation,
  z: number,
  yaw: number,
  identity: number,
): ReturnType<Simulation['join']> {
  const p = sim.join(0, null);
  p.combat.body.position.set(0, EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.combat.body.yaw = yaw;
  p.input.yaw = yaw;
  p.combat.carSpeed = 0;
  p.combat.carSlip = 0;
  p.combat.carYawRate = 0;
  p.history.seed(sim.tick, 0, EYE_HEIGHT, z, yaw);
  const car = sim.cars.take({ identity, body: 0, colour: 0, x: 0, y: 0, z, yaw, parked: true }, p.combat.id)!;
  p.combat.drivingCar = car.id;
  p.input.forward = 1;
  return p;
}

// --- 1, 2 and 3. A contact that persists --------------------------------------------

/**
 * A driver holding W into a parked car, and into a bay, and into another driver.
 *
 * Yaw 0 faces -Z, so a driver at z 0 with the throttle down drives toward
 * negative Z. Everything below is placed on that axis and the tracked coordinate
 * is the driver's own body `z` -- which is where a car *is* (`game/driving.ts`
 * section 2: "the car you are driving is not a new body, it is your body").
 */
function runPressed(): void {
  // (1) A driver with a 2.4 m run-up into a kerb car, holding the throttle after
  //     it arrives.
  //
  //     The run-up is the point. A car placed *already touching* meets the
  //     contact at 0.1 m/s and never exercises the rebound at all; 2.4 m at
  //     `driving.DRIVE_ACCELERATION` is 5.35 m/s, which is a real arrival and is
  //     deliberately under `KNOCK_LOOSE_SPEED` (6) so the kerb car stays a wall
  //     rather than being lifted out of its bay into a record that rolls away.
  //     The contact lands on tick 53, so the watch begins on 120 -- a full second
  //     after it, which is what "after 60 ticks" means when the first 60 are the
  //     approach. See `Settle`.
  {
    const sim = new Simulation(kerbWorld([{ x: 0, z: -7.0 }]));
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    const p = driverAt(sim, 0, 0, 0xc57002);
    const s = new Settle(120);
    for (let i = 0; i < WATCH_TICKS; i++) {
      s.begin(p.combat.body.position.z);
      sim.step(out);
      s.end(p.combat.body.position.z, i);
    }
    const r = s.done(p.combat.body.position.z, p.combat.carSpeed);
    report('a driver held against a kerb car', r);
    judge('a driver held against a kerb car', r);
    if (!(r.travelled > 0.05)) {
      fail(
        `The pressed case only moved the driver ${(r.travelled * 100).toFixed(1)} cm in total, so a car that ` +
          'never got to the contact would pass it. Something is stopping the throttle before the car.',
      );
    }
  }

  // (2) And in a bay: one car in front and one behind, with 30 cm of slack
  //     either side, which is enough for a rebound to *reach* the other one.
  {
    const sim = new Simulation(kerbWorld([{ x: 0, z: -4.9 }, { x: 0, z: 4.9 }]));
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    const p = driverAt(sim, 0, 0, 0xc57013);
    const s = new Settle();
    for (let i = 0; i < WATCH_TICKS; i++) {
      s.begin(p.combat.body.position.z);
      sim.step(out);
      s.end(p.combat.body.position.z, i);
    }
    const r = s.done(p.combat.body.position.z, p.combat.carSpeed);
    report('a driver in a bay between two cars', r);
    judge('a driver in a bay between two cars', r);
  }

  // (3) And two drivers pressing into each other, so nothing in the contact is
  //     kinematic: both masses, both separations and both impulses are live,
  //     and each one's throttle is the other's disturbance.
  {
    const sim = new Simulation(emptyWorld());
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    const a = driverAt(sim, 0, 0, 0xc57021);          // faces -Z
    const b = driverAt(sim, -4.5, Math.PI, 0xc57022); // faces +Z
    const s = new Settle();
    for (let i = 0; i < WATCH_TICKS; i++) {
      s.begin(a.combat.body.position.z);
      sim.step(out);
      s.end(a.combat.body.position.z, i);
    }
    const r = s.done(a.combat.body.position.z, a.combat.carSpeed);
    report('two drivers pressing into each other', r);
    judge('two drivers pressing into each other', r);
    const gap = Math.abs(a.combat.body.position.z - b.combat.body.position.z);
    console.log(`      the pair came to rest ${gap.toFixed(3)} m apart`);
  }

  // (4) And a wreck rolling into a kerb car, which is the same rule with the
  //     rolling decay running rather than a throttle. A wreck that never settles
  //     is a wreck `CarField.recycleLooseIds` can never give back.
  //
  //     Watched from tick 150 rather than 60: at `rigid.ROLLING_DECAY` a 6 m/s
  //     punt is still legitimately rolling two seconds later, and a bound
  //     applied before it arrives is a bound on the decay. See `Settle`.
  {
    const sim = new Simulation(kerbWorld([{ x: 0, z: -12 }]));
    const out: TickOutput = { tick: 0, events: [], snapshot: null };
    // Somebody has to be in the room, or `stepCars` returns on its first line.
    driverAt(sim, 60, Math.PI, 0xc57030);
    const wreck = sim.cars.knockLoose(
      { identity: 0xc57032, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: false },
      6, 0, 0,
    )!;
    const s = new Settle(150);
    for (let i = 0; i < WATCH_TICKS; i++) {
      s.begin(wreck.z);
      sim.step(out);
      s.end(wreck.z, i);
    }
    const r = s.done(wreck.z, wreck.speed);
    report('a wreck settling against a kerb car', r);
    judge('a wreck settling against a kerb car', r);
    if (wreck.speed !== 0 || wreck.slip !== 0 || wreck.yawRate !== 0) {
      fail(
        `A wreck that rolled into a parked car is still doing ${wreck.speed} / ${wreck.slip} m/s and ` +
          `${wreck.yawRate} rad/s five seconds later. Its twenty-second clock never starts, so its bay ` +
          'never comes back -- see CarField.recycleLooseIds.',
      );
    }
    if (!(wreck.z < -4)) {
      fail(`The wreck stopped at z ${wreck.z.toFixed(2)} without ever reaching the kerb car at -12.`);
    }
  }
}

function report(name: string, r: Settling): void {
  console.log(
    `  ${name.padEnd(38)} worst ${(r.late * 100).toFixed(3).padStart(7)} cm a tick, ` +
      `${String(r.flips).padStart(3)} sign flip(s), at rest doing ${r.speed.toFixed(4).padStart(8)} m/s, ` +
      `travelled ${r.travelled.toFixed(2)} m`,
  );
}

// --- 5 and 6. A car nobody is in stays on the ground ---------------------------------

/**
 * A wreck rolled onto a raised surface, on the server and on a client mirror.
 *
 * **The mirror is the point of the second half.** `CarField.integrateLoose` runs
 * on both ends between the server's 10 Hz corrections -- that is the whole
 * reason the wire carries a slip and a spin (`driving.LOOSE_BROADCAST_TICKS`:
 * twenty kilobits a second against a hundred and twenty) -- so the browser is
 * what actually draws a wreck for five ticks out of six. A fix that grounded the
 * authority and not the mirror would leave the car floating on every screen it
 * appears on and be green here.
 */
function runGrounded(): void {
  const world = platformWorld();
  const sim = new Simulation(world);
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const ground = groundFor(world);
  const groundAt = (x: number, z: number, near: number): number => ground.groundHeight(x, z, near);

  // Somebody has to be in the room, or `stepCars` returns on its first line.
  driverAt(sim, -60, Math.PI, 0xc57041);

  // Punted east at 12 m/s from x 0, which is 24 m of roll -- across the
  // platform's edge at x 10 and well onto it.
  const wreck = sim.cars.knockLoose(
    { identity: 0xc57042, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: -Math.PI / 2, parked: false },
    12, 0, 0,
  )!;

  // The mirror: a second `CarField` with the same ground function, running the
  // same integrator on a record seeded from the same source. `main.ts` holds
  // exactly this object.
  const mirror = new CarField();
  mirror.groundAt = groundAt;
  const mirrored = mirror.knockLoose(
    { identity: 0xc57042, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: -Math.PI / 2, parked: false },
    12, 0, 0,
  )!;
  const mirrorResolve = (
    fx: number, fz: number, tx: number, tz: number, r: number, feetY: number, headY?: number,
  ): { x: number; z: number; hit: boolean } => world.collision.resolve(fx, fz, tx, tz, r, feetY, headY);

  let worstServer = 0;
  let worstMirror = 0;
  let worstApart = 0;
  let onPlatform = 0;
  for (let i = 0; i < 600; i++) {
    sim.step(out);
    mirror.integrateLoose(FIXED_DT, mirrorResolve);
    const want = groundAt(wreck.x, wreck.z, wreck.y);
    const dS = Math.abs(wreck.y - want);
    if (dS > worstServer) worstServer = dS;
    const dM = Math.abs(mirrored.y - groundAt(mirrored.x, mirrored.z, mirrored.y));
    if (dM > worstMirror) worstMirror = dM;
    const apart = Math.abs(mirrored.y - wreck.y);
    if (apart > worstApart) worstApart = apart;
    if (wreck.y > PLATFORM_Y - 0.05) onPlatform++;
  }
  console.log(
    `  a wreck rolled ${wreck.x.toFixed(2)} m onto a ${PLATFORM_Y} m platform: worst |y - ground| ` +
      `${worstServer.toFixed(3)} m on the server, ${worstMirror.toFixed(3)} m on a client mirror, ` +
      `the two ${worstApart.toFixed(3)} m apart at worst, ${onPlatform} of 600 ticks up on it`,
  );
  if (!(wreck.x > 12)) {
    fail(
      `The grounding case only rolled the wreck to x ${wreck.x.toFixed(2)}, which is short of the platform ` +
        `edge at 10 m. A car that never left flat ground makes every assertion below pass for nothing.`,
    );
  }
  if (onPlatform === 0) {
    fail('The wreck never got up onto the platform, so nothing here measured a change of height at all.');
  }
  if (worstServer > GROUNDED) {
    fail(
      `A wreck rolling onto a ${PLATFORM_Y} m surface spent up to ${worstServer.toFixed(3)} m off the ground ` +
        'under it on the server. CarField.integrateLoose has to re-sample the ground every tick it moves a ' +
        'record -- see CarField.groundAt.',
    );
  }
  if (worstMirror > GROUNDED) {
    fail(
      `...and up to ${worstMirror.toFixed(3)} m off it on a client mirror running the same integrator. The ` +
        'browser draws a loose car for five ticks out of six; a fix that only grounded the authority is a ' +
        'car that floats on every screen.',
    );
  }
  if (worstApart > GROUNDED) {
    fail(
      `...and the two ends disagreed about the height of the same wreck by ${worstApart.toFixed(3)} m. Both ` +
        'run driving.ts against their own ground function and the two are meant to agree to a centimetre.',
    );
  }

  // --- 6. And a record shunted onto it by a driver, which is the same rule
  //     through `Simulation.applyCarBody` rather than through `integrateLoose`.
  //
  // The car is parked just short of the platform edge and a driver rams it east
  // over the lip: the contact writes a velocity onto the record and walks its
  // position through the prisms, and nothing in that path is `integrateLoose`.
  {
    const w2 = platformWorld();
    const sim2 = new Simulation(w2);
    const out2: TickOutput = { tick: 0, events: [], snapshot: null };
    const g2 = groundFor(w2);
    const target = sim2.cars.take(
      { identity: 0xc57051, body: 0, colour: 0, x: 14, y: PLATFORM_Y, z: 0, yaw: -Math.PI / 2, parked: true },
      0,
    )!;
    // A driver west of it on the flat, driving east.
    const p = sim2.join(0, null);
    p.combat.body.position.set(4, EYE_HEIGHT, 0);
    p.combat.body.velocity.set(0, 0, 0);
    p.combat.body.yaw = -Math.PI / 2;
    p.input.yaw = -Math.PI / 2;
    p.history.seed(sim2.tick, 4, EYE_HEIGHT, 0, -Math.PI / 2);
    const mine = sim2.cars.take(
      { identity: 0xc57052, body: 0, colour: 0, x: 4, y: 0, z: 0, yaw: -Math.PI / 2, parked: true },
      p.combat.id,
    )!;
    p.combat.drivingCar = mine.id;
    p.input.forward = 1;
    let worst = 0;
    let moved = 0;
    const fromX = target.x;
    for (let i = 0; i < 600; i++) {
      sim2.step(out2);
      const d = Math.abs(target.y - g2.groundHeight(target.x, target.z, target.y));
      if (d > worst) worst = d;
      moved = Math.abs(target.x - fromX);
    }
    console.log(
      `  a parked record shunted ${moved.toFixed(2)} m along the platform: worst |y - ground| ` +
        `${worst.toFixed(3)} m`,
    );
    if (!(moved > 0.2)) {
      fail(
        `The shunt case moved the parked record ${moved.toFixed(3)} m, which is not a shunt. Nothing about ` +
          'its height was exercised.',
      );
    }
    if (worst > GROUNDED) {
      fail(
        `A parked record shunted along a ${PLATFORM_Y} m platform spent up to ${worst.toFixed(3)} m off the ` +
          'ground under it. Simulation.applyCarBody walks a record through the prisms and has to re-ground ' +
          'it -- see CarField.reground.',
      );
    }
  }
}

// --- The run --------------------------------------------------------------------------

console.log('--- cars settle, and cars stay on the ground, through the real Simulation\n');
runPressed();
console.log('');
runGrounded();

console.log('\n  bounds:');
console.log(`    a settled contact moves under                   ${SETTLED_STEP * 100} cm a tick`);
console.log(`    ...and reverses direction no more than          ${SETTLED_FLIPS} times`);
console.log(`    ...and is left doing under                       ${SETTLED_SPEED} m/s`);
console.log(`    a car nobody is in is within                     ${GROUNDED * 100} cm of the ground under it`);

if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log('\n  all clear');
