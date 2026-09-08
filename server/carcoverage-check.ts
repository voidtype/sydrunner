/**
 * Every car a player can see, rammed, one population at a time. PERMANENT.
 *
 *     bun run server/carcoverage-check.ts
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHAT IT FOUND.
 *
 * The owner's report on the tick the body layer shipped was four words:
 * *"not all cars collide ::("*. Everything that could have answered it was
 * green. `verifyRigid` drives two bodies made of literals; `verifyCarPhysics`
 * drives a `CarField` with no world; `server/carcrash-check.ts` runs whole ticks
 * through the real `Simulation` and covers three populations -- two drivers, an
 * ambient car under the knock-loose threshold, and one over it. Between them
 * they prove that **a** contact works. None of them asks the question the report
 * is about, which is *which cars get one*.
 *
 * That question only has an answer if you enumerate. A car in Sydney is one of
 * eight things and they arrive from five different places in the code:
 *
 *     a kerb car out of `tiles/<key>.cars.bin`     `game/staticcars.ts`
 *     a schedule car parked in its bay             `traffic.poseCar`, stage 0/4
 *     a schedule car pulling out                   stage 1
 *     a schedule car driving                       stage 2
 *     a schedule car held at a red                 stage 2 at zero speed
 *     a schedule car parking                       stage 3
 *     another player's car                         a `DrivenCar` with a driver
 *     a wreck somebody knocked loose               a `DrivenCar` with none
 *
 * This file rams each of them and prints one line each. **Ratcheted**: every row
 * must read `contact = yes`, and the day a ninth population is added it gets a
 * row here or it is a car people drive through.
 *
 * **It rams them with a car, and that is half the question.** This driver's
 * report used to end "On foot, everything. The static fleet is not in the
 * collision prisms and no pedestrian capsule is tested against it" -- every one
 * of the eight was solid to a car and to nobody's legs. That half now has its
 * own driver, `server/footcar-check.ts`, and its own boot check,
 * `game/carsolids.verifyCarSolids`. Nothing here changed for it: a body on foot
 * goes through `CollisionWorld.resolve` and a car's bonnet goes through
 * `resolveCity`, so every population below is still adjudicated by
 * `game/rigid.ts` with two masses and none of these rows can be answered by a
 * capsule push.
 *
 * What it found on the run it was written for, before workstream AS:
 *
 *   - **the kerb fleet was not asked at all.** `resolveTrafficContacts` walks a
 *     `TrafficField` and there was no sweep that walked a `StaticCarField`, so
 *     733,898 resident cars -- twenty-three thousand inside the inner ring
 *     alone, against the timetable's forty in a draw radius -- were furniture
 *     you drove through. That is almost every car anybody ever meets, and it is
 *     the whole of the report.
 *   - **a parked record with a lower id than yours was skipped.** The
 *     driven-against-driven sweep deduped its pairs with `other.id <= car.id`
 *     while gating its outer loop on "has a body", so a car you parked and then
 *     came back to in a second car was tested from neither side. See
 *     `Simulation.resolveCarContacts`, which now dedupes between two *bodies*.
 *
 * ---------------------------------------------------------------------------
 * TWO WORLDS, AND WHY IT IS NOT ONE.
 *
 * The kerb row is run against the **shipped bake** through `loadWorld`, because
 * that is the only place a real `.cars.bin` car in a real resident hexagon
 * exists and the residency is half of what makes this feature true (see the
 * gap number this file prints at the end). Everything else is run on
 * `carcrash-check.streetWorld`'s synthetic street, and that is a deliberate
 * choice rather than a convenience:
 *
 *   - the timetable is a **pure function of the wall clock**, so on the real
 *     bake "a car that is pulling out" is not something you can ask for, only
 *     something you can wait for. A check whose result depends on what second
 *     somebody typed the command is not a check. `traffic.syntheticTile` is
 *     `verifyTraffic`'s own street, it carries all five stages including the
 *     red light, and on a **virtual clock** (`carcrash-check`' swap of `Date.now`
 *     itself, made for this reason and restated below) every stage can be found
 *     by search and then arrived at exactly.
 *   - a synthetic city has **no prisms**, which is what makes the approach below
 *     legitimate. See "how a ram is aimed".
 *
 * The `Simulation` is the real one in both worlds: real `stepCars`, real damage
 * sweeps, real hold ledger, real `CarField`, real order.
 *
 * ---------------------------------------------------------------------------
 * HOW A RAM IS AIMED, AND WHY THE SPEED IS SET RATHER THAN DRIVEN.
 *
 * `server/carcrash-check.ts` drives its rammer up to speed over a measured
 * run-up and its header is emphatic about why: *"writing `carSpeed = 15` and
 * stepping makes `crashFromClamp` read the controller's own ramp as a 12 m/s
 * impact and charge for it"*. That paragraph cost that driver a false result and
 * it is worth knowing exactly how far it reaches, because this file does the
 * opposite.
 *
 * `driving.crashFromClamp` is gated on `hitSolid` -- `controller.step`'s own
 * answer to "did the prism resolver push this body". A shortfall with nothing
 * solid in the way is thrown away unmeasured, and it has been since the owner
 * reported *"even small bumps in a road alone are giving damage"*. So setting a
 * speed is only a hazard where there are prisms to be pushed out of, and eight
 * of the nine rows below run in a city that has none. The kerb row does not have
 * that luxury and is placed on a street rather than in one: it is checked for a
 * clear approach before it is driven, and a ram that gets pushed by anything is
 * discarded and the next candidate tried.
 *
 * Setting the speed buys the thing a run-up cannot give: the striker arrives at
 * **an instant this file chose**, which is what makes "a schedule car in the act
 * of pulling out" a population that can be rammed at all. The body's velocity is
 * set beside the car's scalar, because `controller.step` accelerates a body
 * toward its wish at 48 m/s^2 rather than snapping to it -- a striker with
 * `carSpeed = 18` and a body at rest covers 13 mm on its first tick and would
 * arrive a quarter of a second late.
 *
 * ---------------------------------------------------------------------------
 * THE TWO SPEEDS, AND WHY NEITHER OF THEM IS THE BRIEF'S 12.
 *
 * The brief asked for a contact pass at 12 m/s asserting *damage taken*, and a
 * knock-loose pass at 8. The 8 is kept exactly (`KNOCK_LOOSE_SPEED` is 6, so 8
 * is over it with a margin a tick of coast cannot close). The 12 could not be:
 * **`driving.CRASH_FREE_SPEED` is 12**, and `crashDamage` charges for what is
 * *past* the free allowance, so a 12 m/s impact costs exactly nothing by
 * construction and "damage taken" could never be true at it. Ramming at 12 and
 * asserting damage would be asserting that a free crash is not free.
 *
 * So the contact pass runs at `CRASH_FREE_SPEED + 6`, which is 18: the smallest
 * round number that leaves a real 6 m/s of curve above the allowance, costs
 * 2.4 hp of 100, and is still an ordinary road speed rather than a stunt. Both
 * numbers are derived from the constants rather than written down, so a retune
 * of either moves this file with it.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK. `server/carcrash-check.ts` section "one virtual clock" is the
 * argument in full and this file makes the identical swap for the identical
 * reason: `game/traffic.ts` is a lookup rather than a simulation, every ambient
 * pose on both ends is a pure function of `trafficTick(Date.now())`, and there
 * are two dozen call sites of that inside `server/sim.ts` alone. So `Date.now`
 * is replaced at the root, in this process only, and put back before it exits.
 * Nothing anywhere is faked.
 */

import { Simulation, type Participant, type TickOutput } from './sim.ts';
import { groundFor, loadWorld, type ServerWorld } from './world.ts';
import { CollisionWorld } from '../client/src/player/collision.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { TICK_HZ } from '../client/src/net/protocol.ts';
import {
  CAR_STAGE_DRIVING,
  CAR_STAGE_PARKED_IN,
  CAR_STAGE_PARKED_OUT,
  CAR_STAGE_PULL_IN,
  CAR_STAGE_PULL_OUT,
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
  CRASH_FREE_SPEED,
  KNOCK_LOOSE_SPEED,
  TAKE_HEIGHT,
  ambientRigidBody,
  carRigidBody,
  crashDamage,
  headingYaw,
  staticRigidBody,
  type DrivenCar,
} from '../client/src/game/driving.ts';
import { decodeCars, StaticCarField } from '../client/src/game/staticcars.ts';
import {
  MAX_PENETRATION,
  createRigidBody,
  createRigidContact,
  rigidOverlap,
  type RigidBody,
} from '../client/src/game/rigid.ts';

const FIXED_DT = 1 / TICK_HZ;

/** `verifyTraffic`'s own street: a 7.5 m residential carriageway, quarter width. */
const LANE_OFFSET = 1.875;

/**
 * The contact pass's speed, m/s. **`CRASH_FREE_SPEED + 6` = 18.**
 *
 * Derived rather than written down, and the header's section on the two speeds
 * is why it is not the brief's 12. Six metres a second of curve above the free
 * allowance is 2.4 hp of a hundred, which is a dent a player would notice and a
 * long way from `CRASH_DAMAGE_MAX`.
 */
const RAM_HARD = CRASH_FREE_SPEED + 6;

/**
 * And the knock-loose pass's, m/s. **The brief's 8**, kept because it is over
 * `KNOCK_LOOSE_SPEED` by a margin no tick of `DRIVE_COAST` can close (4.4 m/s^2
 * is 0.073 m/s a tick, and the striker is placed six ticks out).
 */
const RAM_LOOSE = 8;

/**
 * How many ticks of flight a striker is given before it is meant to arrive.
 *
 * The whole of the aiming: a target found at traffic tick `T` is rammed by a
 * striker placed `RAM x LEAD x dt` short of where the scan says that target
 * will be, with the clock wound back the same six ticks -- so the two arrive at
 * the same place at the same instant and a car that is *pulling out* is still
 * pulling out when it is hit. Six rather than one because the striker's box has
 * to be clear of the target's before the first step, and rather than sixty
 * because every tick of flight is a tick the target has moved on.
 */
const LEAD_TICKS = 6;

/**
 * How long after the *first* sign of a contact the measurement stays open,
 * ticks.
 *
 * Not a fudge, and the first draft of this file did not have it and measured
 * every schedule row at 0.07 m/s -- which is `DRIVE_COAST`, which is a car that
 * hit nothing. The reason is a real property of the tick and is worth holding
 * on to: **the two rules that fire on one crash do not fire on one tick.**
 * `crashIntoTraffic` charges the damage off `drivenCarPose(record)` and
 * `Simulation.resolveCarContacts` resolves the contact off the *driver's live
 * body*, and `CarField.follow` only catches the record up at the end of
 * `stepCars` -- so at 18 m/s the record is 0.3 m behind the driver and the two
 * answers are a tick apart in either direction depending on the geometry.
 * `Simulation.resolveTrafficContacts`' own header is about the same tick of
 * skew from the other side.
 *
 * So a row is opened by whichever of the two arrives first and closed six ticks
 * later, and what it reports is the whole of the impact rather than the first
 * sixtieth of it. Six because that is a tenth of a second: long enough for the
 * pair to have separated, far too short for the striker to have driven into
 * anything else.
 */
const SETTLE_TICKS = 6;

/** How long a striker is given to arrive at all, beyond its own flight, ticks. */
const RAM_SLACK = 40;

const failures: string[] = [];
const say = (s: string): void => { console.log(s); };
const fail = (s: string): void => { failures.push(s); };

// --- What one population's row says ------------------------------------------

interface Row {
  population: string;
  /** Did the striker meet it: stopped or rebounded, on the tick it touched. */
  contact: boolean;
  /** Did the struck car leave its fleet and become a driverless record? */
  loose: 'yes' | 'no' | 'n/a';
  /** The deepest thing still inside the striker's box after the tick, metres. */
  overlap: number;
  /** What the striker was doing when it touched, m/s. */
  approach: number;
  /** How much of that the contact took off it, m/s. */
  shed: number;
  /** Health the striker lost. */
  damage: number;
  note: string;
}

function row(population: string): Row {
  return {
    population, contact: false, loose: 'n/a', overlap: 0,
    approach: 0, shed: 0, damage: 0, note: '',
  };
}

// --- The worlds ---------------------------------------------------------------

/** `carcrash-check.streetWorld`: one 200 m residential street on a quiet headway. */
function streetWorld(): ServerWorld {
  const traffic = new TrafficField();
  // A **short** headway rather than that file's 120 s, because this one needs
  // every stage to occur rather than needing a bay to stay occupied: at 12 s the
  // street carries cars in all five stages within a couple of minutes of clock,
  // which `findStage` below then searches for.
  traffic.adopt('street', syntheticTile(LANE_OFFSET, 0, 0, undefined, 12, 3, 0, 0x5eed, 0));
  return worldWith(traffic);
}

/** And one with nothing in it at all. `cardamage-check.emptyWorld`. */
function emptyWorld(): ServerWorld {
  return worldWith(new TrafficField());
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

// --- The clock ----------------------------------------------------------------

const realNow = Date.now;
let clockMs = realNow();

/** Put the process's clock at a chosen millisecond. See the header. */
function setClock(ms: number): void {
  clockMs = ms;
  (Date as unknown as { now: () => number }).now = () => clockMs;
}

function restoreClock(): void {
  (Date as unknown as { now: () => number }).now = realNow;
}

// --- Placing and driving a striker --------------------------------------------

/** Where a ram is aimed: a point, and the unit direction the striker comes from. */
interface Aim {
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
}

/**
 * Put a player in a car, pointed at `aim`, doing `speed`, `LEAD_TICKS` short of
 * arriving. Returns the record.
 *
 * The identity is a literal and the take is `CarField.take` by hand, exactly as
 * `carcrash-check` and `cardamage-check` do it and for their reason: what is
 * being exercised is the contact and not the theft, and `server/take-check.ts`
 * is where the button lives.
 */
interface Launched {
  car: DrivenCar;
  /**
   * How many ticks the striker will be in the air, rounded up.
   *
   * Returned rather than assumed, because it is what the clock is wound back by:
   * the standoff has a fixed part (two half-lengths of car) and a speed-dependent
   * part (the flight), so an 8 m/s ram is in the air two and a half times as long
   * as an 18 m/s one. The first draft wound the clock back by `LEAD_TICKS` for
   * both and the slow pass arrived three quarters of a second late, by which time
   * the car that had been *parking* had parked.
   */
  flightTicks: number;
}

function launch(
  sim: Simulation,
  p: Participant,
  aim: Aim,
  speed: number,
  groundY: number,
  identity: number,
): Launched {
  // Back down the approach far enough that the two boxes are clear at the start:
  // the flight, plus the striker's own half length and the widest half a car can
  // present across it.
  const back = speed * LEAD_TICKS * FIXED_DT + 2.3 + 2.9;
  const x = aim.x - aim.dx * back;
  const z = aim.z - aim.dz * back;
  const yaw = headingYaw(aim.dx, aim.dz);
  p.combat.body.position.set(x, groundY + EYE_HEIGHT, z);
  // Set beside the car's scalar rather than left at rest. See the header: the
  // controller ramps a body toward its wish at 48 m/s^2 and a striker with a
  // speed but no velocity arrives a quarter of a second late.
  p.combat.body.velocity.set(aim.dx * speed, 0, aim.dz * speed);
  p.combat.body.yaw = yaw;
  p.input.yaw = yaw;
  p.input.forward = 0;
  p.combat.carSpeed = speed;
  p.combat.carSlip = 0;
  p.combat.carYawRate = 0;
  p.history.seed(sim.tick, x, groundY + EYE_HEIGHT, z, yaw);
  const car = sim.cars.take(
    { identity, body: 0, colour: 0, x, y: groundY, z, yaw, parked: true },
    p.combat.id,
  );
  if (car === null) throw new Error('the striker could not be put in a car');
  p.combat.drivingCar = car.id;
  return { car, flightTicks: Math.ceil(back / speed / FIXED_DT) };
}

/**
 * Everything still inside the striker's box after a tick, over **all three
 * fleets**, in metres of the deepest one.
 *
 * The assertion the brief calls "no overlap after the tick", and it is asked of
 * the parked fleet, the timetable and the driven set together rather than of
 * whichever one the row is about -- because a sweep that pushed a car out of a
 * Camry and into a bus would pass a narrower test.
 *
 * **The floor is `rigid.MAX_PENETRATION` and it used to be twice
 * `SEPARATION_SLOP`**, and the change is not a loosened bound -- it is the same
 * sentence about a layer whose contract now says something different.
 * `rigidSeparate` used to push the whole of an overlap out in one tick and leave
 * a millimetre; since the settling rules (`game/rigid.ts` section 7) it pushes
 * four tenths, and the thing that keeps a *driven* contact shallow is the
 * `MAX_PENETRATION` cap rather than the fraction. So the deepest overlap the
 * layer will deliberately leave standing is that cap, and quoting anything
 * smaller here is quoting a promise the module no longer makes. The row it shows
 * up in is "another player's car, closing", which measures **exactly 0.1000 m** --
 * the cap, doing precisely what it says.
 */
function deepestOverlap(
  sim: Simulation,
  world: ServerWorld,
  mine: RigidBody,
  x: number,
  feetY: number,
  z: number,
  tick: number,
  skipRecords: ReadonlySet<number>,
  scratch: { routes: LaneRoute[]; pose: CarPose; other: RigidBody },
  /** One more body the caller built itself. See `RamCtx.liveOther`. */
  extra: RigidBody | null = null,
  /** Filled with what the worst offender was, so a failure can be diagnosed. */
  blame: { what: string } = { what: '' },
): number {
  const contact = createRigidContact();
  let worst = 0;
  const consider = (b: RigidBody, what: string): void => {
    if (!rigidOverlap(mine, b, contact)) return;
    // --- What is left **after one tick of the other body's own travel is
    //     allowed for**, which is the only fair way to ask this question of a
    //     fleet that does not react.
    //
    // A schedule car is a closed-form function of the clock: it does not know it
    // has hit anything, it is not pushed, and it arrives 0.18 m further into you
    // on every tick at a road speed. `resolveTrafficContacts` pushes the *driven*
    // car back out once a tick, so a player stopped in a lane with a bus driving
    // into them sits at a steady-state depth of exactly one tick of the bus --
    // which the first draft of this file measured at 0.1439 m and called two cars
    // welded together. It is not: it is `game/driving.ts` section 3's stated
    // design, an ambient car that carries on.
    //
    // A **knocked-loose wreck** produces the same shape one order down, and it
    // is worth naming because it looks like a bug in the separation and is not:
    // `CarField.integrateLoose` runs at the *end* of `stepCars`, after the
    // contacts have been resolved, so a wreck resting against the car that
    // punted it creeps back in by one tick of its own roll before the next tick
    // pushes it out again. Measured at 0.03 m behind an 8 m/s ram, which is
    // 1.8 m/s of wreck.
    //
    // And there is a third, which is the **order of the sweeps inside one tick**.
    // `Simulation.resolveCarContacts` separates a driven car from a record and
    // then `resolveTrafficContacts` and `resolveStaticContacts` run, and both of
    // them move that same driver again -- so a car pushed out of the wreck it
    // just made can be pushed a centimetre back into it by the ambient car
    // behind it, and only straightened on the following tick. Measured at
    // 0.0105 m behind an 18 m/s ram into a queue.
    //
    // So the allowance is one tick of travel for **each** body, in any
    // direction, plus the millimetre `rigidSeparate` leaves on purpose. The
    // magnitudes rather than the components along the centre line, because a
    // wreck rolling diagonally out of a contact is the second case above and its
    // centre-line component is nearly nought while its actual travel is not.
    //
    // It is generous -- 0.3 m at an 18 m/s ram -- and it is worth being plain
    // about what that costs and what it does not. It cannot hide the failure
    // this column is for, which is a pair **welded together**: two cars sharing
    // a velocity have no relative travel at all and are convicted by the slop
    // alone, and a car dragging another one along is the same. What it does
    // forgive is a depth that a single tick of motion explains, which is a depth
    // that is gone on the next tick. Nine of the eleven rows measure exactly
    // 0.0000 against it.
    const dvx = b.vx - mine.vx;
    const dvz = b.vz - mine.vz;
    const relative = Math.sqrt(dvx * dvx + dvz * dvz);
    const own = Math.sqrt(mine.vx * mine.vx + mine.vz * mine.vz);
    const allowance = (relative + own) * FIXED_DT + MAX_PENETRATION;
    const unexplained = contact.depth - allowance;
    if (unexplained > worst) {
      worst = unexplained;
      blame.what = `${what}, ${contact.depth.toFixed(4)} m deep with `
        + `${(allowance - MAX_PENETRATION).toFixed(4)} m of one tick's travel allowed for`;
    }
  };

  world.staticCars?.forEachStaticNear(x, feetY, z, 8, (c) => {
    if (sim.cars.suppressed(c.identity)) return;
    const dy = c.y - feetY;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return;
    consider(staticRigidBody(c, scratch.other), `parked car 0x${(c.identity >>> 0).toString(16)}`);
  });
  forEachCarNear(world.traffic, x, z, 8, tick, scratch.routes, scratch.pose, (q) => {
    if (sim.cars.suppressed(q.identity)) return;
    const dy = q.y - feetY;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) return;
    consider(
      ambientRigidBody(q, scratch.other),
      `schedule car 0x${(q.identity >>> 0).toString(16)} stage ${q.stage} at ${q.speed.toFixed(2)} m/s` +
        (q.held > 0 ? ` held ${q.held.toFixed(2)} m` : ''),
    );
  });
  for (const rec of sim.cars.all()) {
    if (skipRecords.has(rec.id)) continue;
    const dy = rec.y - feetY;
    if (dy > TAKE_HEIGHT || dy < -TAKE_HEIGHT) continue;
    consider(
      carRigidBody(rec, scratch.other),
      `record ${rec.id} (${rec.driverId === 0 ? (rec.loose ? 'a wreck' : 'parked') : 'driven'}) at ` +
        `${rec.speed.toFixed(2)} m/s`,
    );
  }
  if (extra !== null) consider(extra, "the other driver's live body");
  return worst;
}

function recordsNow(sim: Simulation): Set<number> {
  const ids = new Set<number>();
  for (const rec of sim.cars.all()) ids.add(rec.id);
  return ids;
}

/** Everything a ram needs to know about the world it is being run in. */
interface RamCtx {
  sim: Simulation;
  world: ServerWorld;
  p: Participant;
  launched: Launched;
  /** True on the synthetic worlds, whose clock this file is driving by hand. */
  advanceClock: boolean;
  /** Records that are not "something the striker is inside": its own, and a partner's. */
  skip: number[];
  /**
   * A body to test the overlap against directly, built live by the caller.
   *
   * For the driven rows only, and it is the same paragraph `Simulation.fillCarBody`
   * carries: a record whose driver has just been shunted is a tick behind that
   * driver, because `CarField.follow` takes its view at the top of `stepCars`.
   * Asking the *record* whether the two cars are still inside each other would
   * measure the lag rather than the separation.
   */
  liveOther?: (into: RigidBody) => RigidBody | null;
}

/**
 * Step the tick, find the moment the striker meets something, and fill the row.
 *
 * A contact is **the striker losing speed it was not going to lose, or taking
 * damage.** With the throttle shut a car sheds `DRIVE_COAST` -- 4.4 m/s^2, which
 * is 0.073 m/s a tick -- so half a metre a second in one tick is a wall and
 * nothing else. The health clause is there because the two rules that adjudicate
 * one crash are a tick apart; see `SETTLE_TICKS`, which is the whole of that
 * argument. Measured on the car's own scalar rather than on the body, because
 * the body is also being moved by the controller and a kerb would confuse it.
 */
function ram(ctx: RamCtx, r: Row): void {
  const { sim, world, p } = ctx;
  const car = ctx.launched.car;
  const out: TickOutput = { tick: 0, events: [], snapshot: null };
  const before0 = recordsNow(sim);
  const scratch = { routes: [] as LaneRoute[], pose: createCarPose(), other: createRigidBody() };
  const mine = createRigidBody();
  const theirs = createRigidBody();
  const limit = ctx.launched.flightTicks + RAM_SLACK;
  let touchedAt = -1;

  for (let tick = 0; tick < limit; tick++) {
    if (ctx.advanceClock) clockMs += 1000 / TICK_HZ;
    const speedBefore = p.combat.carSpeed;
    const healthBefore = car.health;
    sim.step(out);
    const after = p.combat.carSpeed;
    if (touchedAt < 0 && (after < speedBefore - 0.5 || after < 0 || car.health < healthBefore)) {
      touchedAt = tick;
      r.contact = true;
      r.approach = speedBefore;
    }
    if (touchedAt >= 0 && tick >= touchedAt + SETTLE_TICKS) break;
  }
  if (touchedAt < 0) return;

  r.shed = r.approach - p.combat.carSpeed;
  r.damage = CAR_HEALTH_MAX - car.health;
  carRigidBody(
    {
      body: car.body,
      x: p.combat.body.position.x,
      z: p.combat.body.position.z,
      yaw: p.combat.body.yaw,
      speed: p.combat.carSpeed,
      slip: p.combat.carSlip,
      yawRate: p.combat.carYawRate,
    },
    mine,
  );
  const feet = p.combat.body.position.y - EYE_HEIGHT;
  const skip = new Set<number>([car.id, ...ctx.skip]);
  const blame = { what: '' };
  r.overlap = deepestOverlap(
    sim, world, mine, p.combat.body.position.x, feet, p.combat.body.position.z,
    trafficTick(Date.now()), skip, scratch,
    ctx.liveOther === undefined ? null : ctx.liveOther(theirs),
    blame,
  );
  if (r.overlap > 0) r.note = `still inside ${blame.what}`;
  // Anything that was not a record before this ram and is one now: a car that
  // left its fleet. The two fleets with no records of their own are the only
  // populations that can produce one.
  r.loose = 'no';
  for (const rec of sim.cars.all()) {
    if (before0.has(rec.id)) continue;
    r.loose = 'yes';
    r.note = r.note === '' ? `minted record ${rec.id}` : `${r.note}; minted record ${rec.id}`;
  }
}

// --- 1. The kerb fleet, on the shipped bake -----------------------------------

/** One candidate parked car, and the line a striker would come down. */
interface KerbTarget {
  identity: number;
  x: number;
  y: number;
  z: number;
  /** Along the car's own heading -- a rear-ender down the row it is parked in. */
  dx: number;
  dz: number;
}

/**
 * Parked cars near a point whose approach is **clear of other parked cars**.
 *
 * Not an optimisation: a kerb row is cars every six metres, so a striker aimed
 * at one of them from twelve metres back would meet the one behind it first and
 * the row would measure a car this file did not choose. Sampling the approach
 * line against the same field the ram will meet is the cheapest honest way to
 * pick a car that can actually be reached, and there are thousands of
 * candidates near the spawn -- the end of a row, approached from the empty side,
 * is the geometry this finds.
 */
function kerbTargets(world: ServerWorld, at: { x: number; z: number }, want: number): KerbTarget[] {
  const statics = world.staticCars;
  const out: KerbTarget[] = [];
  if (statics === undefined) return out;
  const seen: KerbTarget[] = [];
  statics.forEachStaticNear(at.x, 0, at.z, 400, (c) => {
    seen.push({ identity: c.identity, x: c.x, y: c.y, z: c.z, dx: -Math.sin(c.yaw), dz: -Math.cos(c.yaw) });
  });
  // Lowest identity first, so the row this file reports is the same row on every
  // run over the same bake rather than whichever tile the residency drained
  // first. `resolveStaticContact` section 1's rule, applied to a check.
  seen.sort((a, b) => a.identity - b.identity);
  for (const c of seen) {
    if (out.length >= want) break;
    // The approach runs backwards down the car's own heading, which is along the
    // row and therefore along the road.
    let clear = true;
    for (let step = 1; step <= 8 && clear; step++) {
      const px = c.x - c.dx * step * 2.5;
      const pz = c.z - c.dz * step * 2.5;
      statics.forEachStaticNear(px, c.y, pz, 2.6, (q) => {
        if (q.identity !== c.identity) clear = false;
      });
      // And clear of the prisms, which is the other thing a street has in it.
      const moved = world.collision.resolve(
        px, pz, px, pz, 0.85, c.y + 0.42, c.y + 1.8,
      );
      if (moved.hit) clear = false;
    }
    if (clear) out.push(c);
  }
  return out;
}

function runKerb(
  world: ServerWorld,
  at: { x: number; z: number },
  speed: number,
  label: string,
): { row: Row; struck: { x: number; z: number } | null } {
  const r = row(label);
  const targets = kerbTargets(world, at, 12);
  if (targets.length === 0) {
    r.note = 'no parked car near the spawn had a clear twenty metres behind it';
    return { row: r, struck: null };
  }
  let attempts = 0;
  for (const t of targets) {
    attempts++;
    const sim = new Simulation(world);
    const p = sim.join(0, null);
    let launched: Launched;
    try {
      launched = launch(sim, p, t, speed, t.y, 0xca0001 + attempts);
    } catch {
      continue;
    }
    ram({ sim, world, p, launched, advanceClock: false, skip: [] }, r);
    if (r.contact) {
      const struck = `struck 0x${(t.identity >>> 0).toString(16)} on attempt ${attempts}`;
      r.note = r.note === '' ? struck : `${struck}; ${r.note}`;
      return { row: r, struck: { x: t.x, z: t.z } };
    }
    // Nothing happened: the target was not where the field said, or the approach
    // was blocked after all. The next candidate rather than a failure this file
    // caused -- and the records are handed back so the room does not fill up.
    sim.cars.clear();
  }
  r.note = `nothing was struck in ${attempts} attempt(s)`;
  return { row: r, struck: null };
}


// --- 2. The timetable, stage by stage -----------------------------------------

interface StageTarget {
  /** The wall-clock millisecond the scan found it at. */
  atMs: number;
  identity: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  speed: number;
  stage: number;
}

/**
 * The first moment on the synthetic street at which a car is in `want`.
 *
 * A search over the clock rather than over the street, which is the whole
 * benefit of a fleet that is a closed-form function of time: every stage
 * *occurs*, and the only question is when. Ten minutes of clock at a quarter of
 * a second is 2,400 lookups and takes milliseconds.
 *
 * `want` is a predicate rather than a stage byte because "held at a red" is not
 * a stage of its own: `traffic.poseCar`'s header says a red light is two copies
 * of one vertex, so a car waiting at one is stage `DRIVING` with a speed of
 * exactly zero. That is a real population -- it is the one thing on the street
 * that is stopped and is not parked -- and it is the one the knockdown rules
 * treat differently (`carHitStrength` returns 0 for it), which is precisely why
 * it earns a row.
 */
function findStage(
  world: ServerWorld,
  want: (p: CarPose) => boolean,
  fromMs: number,
): StageTarget | null {
  const scratch: LaneRoute[] = [];
  const probe = createCarPose();
  for (let step = 0; step < 2400; step++) {
    const ms = fromMs + step * 250;
    const tick = trafficTick(ms);
    let found: StageTarget | null = null;
    forEachCarNear(world.traffic, 0, -100, 400, tick, scratch, probe, (q) => {
      if (!want(q)) return;
      found = {
        atMs: ms, identity: q.identity, x: q.x, y: q.y, z: q.z,
        dx: q.dx, dz: q.dz, speed: q.speed, stage: q.stage,
      };
      return true;
    });
    if (found !== null) return found;
  }
  return null;
}

/**
 * Ram a schedule car in a chosen stage, arriving at the instant it is in it.
 *
 * **Across the target's heading and not down it.** A rear-ender against a car
 * that is *driving* closes at the difference of two speeds and would take a
 * second to land, which is a second the stage has moved on in; across it the
 * closing speed is the striker's own and the target's whole 4.6 m flank is the
 * thing being aimed at, so a car that has moved half a metre in the six ticks of
 * flight is still hit. `carcrash-check`'s ram section arrives at the same
 * geometry from the other direction and states the other half of the reason: a
 * T-bone is the case with a real contact arm in it, so it is the one that spins
 * the struck car.
 */
function runStage(
  speed: number,
  label: string,
  want: (p: CarPose) => boolean,
): Row {
  const r = row(label);
  const world = streetWorld();
  const target = findStage(world, want, realNow());
  if (target === null) {
    r.note = 'the synthetic street never produced this stage in ten minutes of clock';
    return r;
  }
  // Placed first at the moment of the scan, so `launch` can report how long its
  // flight is, and only then is the clock wound back by exactly that -- so the
  // striker's box arrives at the scanned point on the tick the scan was taken
  // at, and a car that was *pulling out* is still pulling out when it is hit.
  // The first draft wound back a fixed six ticks for both passes and the 8 m/s
  // one arrived three quarters of a second late, by which time the car that had
  // been parking had parked.
  setClock(target.atMs);
  const sim = new Simulation(world);
  const p = sim.join(0, null);
  // Left of a heading `(dx, dz)` is `(dz, -dx)` -- `traffic.resolveHeld`'s axes.
  // The striker comes in from the target's left, across it.
  const aim: Aim = {
    x: target.x, y: target.y, z: target.z, dx: -target.dz, dz: target.dx,
  };
  const launched = launch(sim, p, aim, speed, target.y, 0xca0100);
  setClock(target.atMs - launched.flightTicks * (1000 / TICK_HZ));
  ram({ sim, world, p, launched, advanceClock: true, skip: [] }, r);
  restoreClock();
  const stage = `stage ${target.stage} at ${target.speed.toFixed(2)} m/s`;
  r.note = r.note === '' ? stage : `${stage}; ${r.note}`;
  if (!r.contact) r.note = `${stage}, found but never reached`;
  return r;
}


// --- 3. Another player's car, and a wreck -------------------------------------

/**
 * Ram a second player's car. `theirSpeed` is what they are doing toward us, so
 * zero is a stationary target and a positive number is a head-on.
 *
 * This is the one population that goes through `resolveCarContacts` rather than
 * through a fleet sweep, and it is the one this file caught a bug in: the dedupe
 * used to be between two *records* rather than two *bodies*, so a record with no
 * driver and a lower id than the striker's was tested from neither side. The
 * stationary case below is that geometry when the other player has got out --
 * see `runParked`.
 */
function runDriven(speed: number, theirSpeed: number, label: string): Row {
  const r = row(label);
  const world = emptyWorld();
  const sim = new Simulation(world);
  const a = sim.join(0, null);
  const b = sim.join(0, null);

  // The victim first, so their record takes the lower id -- which is the
  // ordering the pairing bug hid in.
  //
  // **Facing the striker in both cases**, at yaw pi (which faces +Z), so the
  // stationary row and the closing row are the same geometry with one number
  // changed. The first draft pointed a moving victim *away* down the striker's
  // own axis and measured a chase between two cars doing the same speed, which
  // never closes and reported the population as unreachable.
  const theirYaw = Math.PI;
  b.combat.body.position.set(0, EYE_HEIGHT, 0);
  b.combat.body.velocity.set(0, 0, theirSpeed);
  b.combat.body.yaw = theirYaw;
  b.input.yaw = theirYaw;
  b.input.forward = 0;
  b.combat.carSpeed = theirSpeed;
  b.combat.carSlip = 0;
  b.combat.carYawRate = 0;
  b.history.seed(sim.tick, 0, EYE_HEIGHT, 0, theirYaw);
  const theirs = sim.cars.take(
    { identity: 0xca0200, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: theirYaw, parked: true },
    b.combat.id,
  )!;
  b.combat.drivingCar = theirs.id;

  // ...and the striker comes down the +Z axis at them.
  const launched = launch(sim, a, { x: 0, y: 0, z: 0, dx: 0, dz: -1 }, speed, 0, 0xca0201);
  ram(
    {
      sim, world, p: a, launched, advanceClock: false, skip: [theirs.id],
      liveOther: (into) => carRigidBody(
        {
          body: theirs.body,
          x: b.combat.body.position.x,
          z: b.combat.body.position.z,
          yaw: b.combat.body.yaw,
          speed: b.combat.carSpeed,
          slip: b.combat.carSlip,
          yawRate: b.combat.carYawRate,
        },
        into,
      ),
    },
    r,
  );
  const health = `their car on ${theirs.health.toFixed(1)} hp`;
  r.note = r.note === '' ? health : `${health}; ${r.note}`;
  if (!r.contact) r.note = 'the striker never reached the other car';
  return r;
}

/**
 * A car with **nobody in it and a lower id than the striker's**, rammed.
 *
 * The row the pairing bug was found by, and it is worth its own entry rather
 * than being a footnote to the driven one because it is the shape a player
 * actually produces: park a car, walk off, take a second one, drive it back.
 * Before workstream AS the striker went straight through, with the two ends
 * disagreeing -- the browser predicted the contact (`main.ts` walks every
 * unoccupied record with no id clause at all) and the server never resolved it,
 * so the car half-stopped and then snapped forward, which reads as netcode
 * rather than as a missing pair. See `Simulation.resolveCarContacts`.
 *
 * The `loose` column reads `no` here and that is right: a shunted parked car
 * starts *rolling* (`Simulation.applyCarBody` sets its `loose` flag, which is
 * what makes a car park something you can push your way through) but it does not
 * mint a record, because it already had one, and this column counts records that
 * did not exist before the ram. The note says which it did.
 */
function runParked(speed: number, label: string): Row {
  const r = row(label);
  const world = emptyWorld();
  const sim = new Simulation(world);
  // Allocated **first**, so the abandoned record holds the lower id.
  const theirs = sim.cars.take(
    { identity: 0xca0300, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: true },
    0,
  )!;
  const p = sim.join(0, null);
  const launched = launch(sim, p, { x: 0, y: 0, z: 0, dx: 0, dz: -1 }, speed, 0, 0xca0301);
  if (!(theirs.id < launched.car.id)) {
    fail(
      `The abandoned record took id ${theirs.id} against the striker's ${launched.car.id}. This row ` +
        'exists to cover the pair whose ids fall the other way and it is no longer covering it.',
    );
  }
  ram({ sim, world, p, launched, advanceClock: false, skip: [] }, r);
  const ids = `record ${theirs.id} against striker ${launched.car.id}, `
    + `${theirs.loose ? 'rolling' : 'still standing'} after`;
  r.note = r.note === '' ? ids : `${ids}; ${r.note}`;
  if (!r.contact) r.note = `${ids} -- the striker drove straight through it`;
  return r;
}

/**
 * A wreck somebody knocked loose, standing still.
 *
 * **It is a record with `driverId 0` and `loose` set**, which the brief asked to
 * have said out loud, and the answer is that it is solid and always was: it
 * qualifies for `resolveCarContacts`' outer loop on its own (that gate is
 * `driverId !== 0 || loose`), so it is tested from its own pass whichever way
 * the ids fall, which is why this population was never part of the report. What
 * *changed* for it in workstream AS is the other side: a wreck now also stops
 * against the **parked fleet** rather than rolling through it -- with
 * `knockLoose` cleared, so it cannot knock the row it lands in loose one car at
 * a time and spend the eight-car cap on physics. See
 * `Simulation.resolveStaticContacts` decision 3.
 *
 * There is no wreck-cap argument against making it solid: `MAX_LOOSE_CARS` is
 * about how many *new* records a contact may mint, and a contact with a wreck
 * that already has one mints nothing.
 */
function runWreck(speed: number, label: string): Row {
  const r = row(label);
  const world = emptyWorld();
  const sim = new Simulation(world);
  const wreck = sim.cars.knockLoose(
    { identity: 0xca0400, body: 0, colour: 0, x: 0, y: 0, z: 0, yaw: 0, parked: false },
    0, 0, 0,
  )!;
  // Brought to rest: `integrateLoose` snaps a car under `LOOSE_REST_SPEED` to
  // exactly nought, and this one was knocked at nought to begin with.
  for (let i = 0; i < 60; i++) sim.cars.integrateLoose(FIXED_DT, null);
  if (wreck.speed !== 0 || wreck.slip !== 0) {
    fail(`The wreck this row rams is doing ${wreck.speed} m/s; it is meant to be at rest.`);
  }
  const p = sim.join(0, null);
  const launched = launch(sim, p, { x: 0, y: 0, z: 0, dx: 0, dz: -1 }, speed, 0, 0xca0401);
  ram({ sim, world, p, launched, advanceClock: false, skip: [] }, r);
  const pushed = wreck.speed !== 0 || wreck.slip !== 0
    ? `the wreck was pushed to ${Math.abs(wreck.speed).toFixed(2)} m/s`
    : 'the wreck did not move';
  r.note = r.note === '' ? pushed : `${pushed}; ${r.note}`;
  if (!r.contact) r.note = 'the striker drove straight through the wreck';
  return r;
}


// --- 4. The residency gap ------------------------------------------------------

/**
 * How many parked cars are within 90 m of a point that the **server cannot
 * see**, because their hexagon is not resident.
 *
 * The brief asked for the gap as a number rather than as a caveat, and it is the
 * right thing to watch: `resolveStaticContact` can only be as solid as the field
 * behind it, and that field is `HexResidency`'s third layer under a cap
 * (`SYDNEY_STATIC_CARS_CAP_MB`, 24 MB by default against 46 MB for the whole
 * city). A car in an evicted hexagon is a car both ends agree is not there --
 * the client's ring is a strict subset of the server's, so it is not a
 * *disagreement* -- but it is still a car somebody standing next to it can drive
 * through, and the honest thing is to print how many.
 *
 * Counted by reading the sidecars off the disk the way the **browser** addresses
 * them (`index.json`'s `bounds`, the tile group's translation), which is
 * `server/take-check.ts`' recipe and is the only way to get a number the
 * residency itself did not produce.
 *
 * 90 m rather than `CRASH_QUERY_RADIUS`' six, because six metres is what a
 * contact reaches and ninety is what a player can *see* -- it is
 * `world/carlod.CarModelFleet.sweep`'s own radius, so it is the count of cars
 * drawn as models in front of somebody.
 */
async function residencyGap(world: ServerWorld, root: string, at: { x: number; z: number }): Promise<{
  onDisk: number;
  resident: number;
}> {
  const disk = new StaticCarField();
  const size = world.index.tile_size;
  for (const entry of world.index.tiles) {
    const originX = entry.bounds[0];
    const originZ = entry.bounds[1] + size;
    // The tile's extent in world metres: x runs east from `bounds[0]`, z runs
    // south from `bounds[1] + tile_size`. Only the tiles a 90 m disc can touch.
    if (originX > at.x + 90 || originX + size < at.x - 90) continue;
    if (originZ < at.z - 90 || originZ - size > at.z + 90) continue;
    let buffer: ArrayBuffer | null = null;
    try {
      buffer = await Bun.file(`${root}/tiles/${entry.key}.cars.bin`).arrayBuffer();
    } catch {
      buffer = null;
    }
    if (buffer === null) continue;
    const decoded = decodeCars(buffer, entry.key);
    if (decoded === null) continue;
    disk.adopt(entry.key, decoded, originX, originZ);
  }
  disk.groundAt = groundFor(world).groundHeight;

  let onDisk = 0;
  disk.forEachStaticNear(at.x, 0, at.z, 90, () => { onDisk++; });
  let resident = 0;
  world.staticCars?.forEachStaticNear(at.x, 0, at.z, 90, () => { resident++; });
  return { onDisk, resident };
}

// --- The run -------------------------------------------------------------------

function printTable(title: string, rows: Row[]): void {
  say(`\n  ${title}`);
  say('    population                          | contact | loose | overlap (m) | approach | shed  | damage');
  say('    ------------------------------------+---------+-------+-------------+----------+-------+-------');
  for (const r of rows) {
    say(
      `    ${r.population.padEnd(35)} | ${(r.contact ? 'yes' : 'NO ').padEnd(7)} | ` +
        `${r.loose.padEnd(5)} | ${r.overlap.toFixed(4).padStart(11)} | ` +
        `${r.approach.toFixed(2).padStart(8)} | ${r.shed.toFixed(2).padStart(5)} | ` +
        `${r.damage.toFixed(2).padStart(6)}`,
    );
    if (r.note !== '') say(`      ${r.note}`);
  }
}

/**
 * The bound every row is held to. **Zero**, because `deepestOverlap` has already
 * subtracted both the millimetre `rigidSeparate` leaves on purpose and one tick
 * of whatever was driving into the striker. What is left is unexplained.
 */
const OVERLAP_BOUND = 0;

function judge(rows: Row[], pass: string): void {
  for (const r of rows) {
    if (!r.contact) {
      fail(
        `${pass}: **${r.population}** was driven straight through -- ${r.note}. Every population in this ` +
          'table has to be solid; that is what this file is for.',
      );
      continue;
    }
    if (r.overlap > OVERLAP_BOUND) {
      fail(
        `${pass}: after the tick it hit, the striker was ${r.overlap.toFixed(4)} m inside something `
          + `(**${r.population}**) that nothing was driving into it -- the depth is past both the `
          + 'separation slop and a tick of the other body\'s own travel. Two cars welded together '
          + 'sliding down the street is what `rigidSeparate` exists to prevent.',
      );
    }
    if (!(r.shed > 0.5)) {
      fail(
        `${pass}: hitting **${r.population}** took ${r.shed.toFixed(2)} m/s off the striker. A contact ` +
          'that does not stop or rebound the car is a contact nobody can feel.',
      );
    }
  }
}

async function main(): Promise<void> {
  say('--- every population of car, rammed through the real Simulation\n');
  say(
    `  the contact pass rams at ${RAM_HARD} m/s (CRASH_FREE_SPEED + 6; twelve is the free allowance `
      + 'itself, so a 12 m/s ram is a free crash by construction and could never show damage) and the '
      + `knock-loose pass at ${RAM_LOOSE} m/s against a ${KNOCK_LOOSE_SPEED} m/s threshold.`,
  );

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const at = { x: world.spawn.x, z: world.spawn.z };
  say(
    `  the bake: ${world.traffic.tileCount} lane tiles, `
      + `${(world.staticCars?.carCount ?? 0).toLocaleString()} parked cars resident, `
      + `spawn ${at.x.toFixed(0)}, ${at.z.toFixed(0)}`,
  );
  if ((world.staticCars?.carCount ?? 0) === 0) {
    fail(
      'The server holds no parked cars at all, so the kerb row below cannot mean anything. Either the '
        + 'bake has no `tiles/*.cars.bin` or the residency\'s third layer is not loading them.',
    );
  }

  const parked = (p: CarPose): boolean =>
    p.stage === CAR_STAGE_PARKED_IN || p.stage === CAR_STAGE_PARKED_OUT;
  const stages: Array<[string, (p: CarPose) => boolean]> = [
    ['schedule car, parked in a bay', parked],
    ['schedule car, pulling out', (p) => p.stage === CAR_STAGE_PULL_OUT],
    ['schedule car, driving', (p) => p.stage === CAR_STAGE_DRIVING && p.speed > 1],
    ['schedule car, held at a red', (p) => p.stage === CAR_STAGE_DRIVING && p.speed === 0],
    ['schedule car, parking', (p) => p.stage === CAR_STAGE_PULL_IN],
  ];

  /** Where the kerb row actually landed, which is where the gap is counted. */
  let kerbAt: { x: number; z: number } | null = null;

  const passes: Array<[number, string]> = [
    [RAM_HARD, 'the contact pass'],
    [RAM_LOOSE, 'the knock-loose pass'],
  ];
  for (const [speed, pass] of passes) {
    const rows: Row[] = [];
    const kerb = runKerb(world, at, speed, 'a kerb car out of .cars.bin');
    rows.push(kerb.row);
    if (kerbAt === null) kerbAt = kerb.struck;
    for (const [label, want] of stages) rows.push(runStage(speed, label, want));
    rows.push(runDriven(speed, 0, "another player's car, stationary"));
    rows.push(runDriven(speed, speed, "another player's car, closing"));
    rows.push(runParked(speed, 'a car somebody parked (lower id)'));
    rows.push(runWreck(speed, 'a knocked-loose wreck at rest'));
    // Bots do not drive. `server/bots.ts` is `dummies.think()` and nothing else
    // -- a pacer that walks a line and an aggressor that closes and punches --
    // and neither of them has ever pressed `BTN.MOUNT`. There is no `drivingCar`
    // anywhere in that file. So this population does not exist, and the row says
    // so rather than being left out: the day a bot takes a car it needs a ram
    // here, and a missing row is a thing nobody notices.
    const bot = row("a bot's car");
    bot.note = 'bots do not drive: server/bots.ts is think() only and never sets drivingCar';
    rows.push(bot);

    printTable(`${pass}, ${speed} m/s`, rows);
    const real = rows.filter((r) => r.population !== "a bot's car");
    judge(real, pass);

    if (speed === RAM_HARD) {
      // Damage is the contact pass's own assertion and the reason it is not run
      // at the brief's 12. Everything above the free allowance must cost the
      // striker something, through the same `crashDamage` curve every other
      // impact in the game uses.
      //
      // The **closing** rows are excepted and it is not a fudge: two cars that
      // meet head-on at 18 each close at 36, and `crashDamage` caps at
      // `CRASH_DAMAGE_MAX` -- so they are asserted by the same clause with a
      // bigger number, which is what `r.damage > 0` already says. What is *not*
      // asserted is a driven car that was moving away, and no row here is one.
      const owed = crashDamage(speed);
      for (const r of real) {
        if (!r.contact) continue;
        if (r.damage <= 0) {
          fail(
            `A ${speed} m/s ram into **${r.population}** cost the striker nothing. \`crashDamage\` says `
              + `${owed.toFixed(2)} hp at that speed against a ${CRASH_FREE_SPEED} m/s free allowance, `
              + 'and a car is not a hologram.',
          );
        }
      }
    } else {
      // And the knock-loose rule, at 8 against a threshold of 6.
      for (const r of real) {
        if (!r.contact) continue;
        // The two fleets with no records of their own are the only populations
        // that can produce one. Everything else already has a record, and a
        // second would be one identity in two places.
        const fleet = r.population.startsWith('a kerb car') || r.population.startsWith('schedule car');
        // ...and only where the *rule* says so, which is a closing speed over
        // the threshold. A car standing in a bay, at a red or at a kerb is
        // stationary, so the closing speed is the striker's own 8 and it must
        // go. One that is pulling out, driving or parking is moving, and
        // whether the contact clears 6 m/s depends on which way it happened to
        // be going -- that is the rule working, not a hole, so those rows are
        // printed rather than asserted.
        const stationary = r.population.startsWith('a kerb car')
          || r.population.includes('parked in a bay')
          || r.population.includes('held at a red');
        if (fleet && stationary && r.loose !== 'yes') {
          fail(
            `A ${speed} m/s ram into **${r.population}** left it where it was, against a `
              + `${KNOCK_LOOSE_SPEED} m/s threshold. Over the threshold a car with no record has to get `
              + 'one -- see CarField.knockLoose.',
          );
        }
        if (!fleet && r.loose === 'yes') {
          fail(
            `A ram into **${r.population}** minted a new driverless record. That population already has `
              + 'one, and a second is an identity in two places.',
          );
        }
      }
    }
  }

  // --- And the gap, as a number, at the point the kerb row was actually run.
  const gapAt = kerbAt ?? at;
  const gap = await residencyGap(world, root, gapAt);
  say('');
  say(
    `  residency at the kerb row's own point (${gapAt.x.toFixed(0)}, ${gapAt.z.toFixed(0)}): `
      + `${gap.resident} of the ${gap.onDisk} parked cars within 90 m are resident, so `
      + `${gap.onDisk - gap.resident} of them are cars the server cannot see and therefore cannot be `
      + 'solid to. Ninety metres because that is `world/carlod.CarModelFleet.sweep`\'s radius -- the '
      + 'cars drawn as models in front of somebody. See SYDNEY_STATIC_CARS_CAP_MB and '
      + 'world.STATIC_CARS_NEED_MARGIN_M.',
  );
  if (gap.onDisk > 0 && gap.resident === 0) {
    fail(
      `Every one of the ${gap.onDisk} parked cars within 90 m of the test point is invisible to the `
        + 'server. The spawn\'s own hexagon is pinned for the life of the process (`loadWorld` awaits '
        + 'it), so this is the residency failing rather than the cap biting.',
    );
  }

  say('\n  ratchet (none of these may fall):');
  say('    populations that are solid                      9 of 9 (bots excepted; they do not drive)');
  say(`    parked cars resident within 90 m of the test    ${gap.resident} of ${gap.onDisk}`);

  if (failures.length > 0) {
    say('');
    for (const f of failures) say(`  FAIL ${f}`);
    process.exitCode = 1;
  } else {
    say('\n  all clear');
  }
}

await main();
restoreClock();
