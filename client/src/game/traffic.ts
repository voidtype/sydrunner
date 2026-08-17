/**
 * Living traffic: cars that drive the streets, and what one does to you.
 *
 * The user asked to "make the cars drive around and knock u over". `cars.ts` had
 * 23,020 of them parked at the kerb; this is the half that moves, and the half
 * that hurts.
 *
 * ---------------------------------------------------------------------------
 * A CAR IS A LOOKUP, NOT A SIMULATION. THIS IS THE WHOLE DESIGN.
 *
 * Nothing here is stepped. There is no velocity, no integration and no state
 * that survives a frame. A car's position is a pure function:
 *
 *     position(tick) = the point on route R at time (tick/60 - departure)
 *
 * and every term of it was baked by `pipeline/sydney/lanes.py` into the
 * `.lanes.bin` the client already streams and the server already reads at boot.
 * Two consequences, and both of them are the feature:
 *
 *   1. **Zero bandwidth.** Sixteen players watch the same six thousand cars and
 *      `net/protocol.ts` gained not one byte. A simulated fleet would either be
 *      on the wire -- more traffic than the whole player protocol -- or private
 *      to each client, in which case no two players see the same street.
 *   2. **The knockdown is predictable and authoritative at the same time.** The
 *      server evaluates the hit at tick T and applies the damage; the client
 *      evaluates the *identical function* at the same T and applies the same
 *      shove on the frame it happens, so the shove is not waiting on a round
 *      trip. There is no handoff because there is nothing to hand off.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BAKED QUANTITY IS **TIME** AND NOT DISTANCE.
 *
 * The obvious sidecar is a polyline with arc lengths and a speed profile, which
 * makes `position(t)` an integral. Instead each route vertex carries the
 * cumulative *seconds* to reach it, with the class speed limit, the corner
 * slowdowns and the wait at every red light already folded in. So the lookup is
 * a binary search and a lerp:
 *
 *     find i with t[i] <= age < t[i+1];  u = (age - t[i]) / (t[i+1] - t[i])
 *
 * That is subtract, divide, multiply, add -- and **nothing else**, which is a
 * determinism argument before it is a performance one. `game/footy.ts`'s header
 * states the rule this obeys: `Math.sin`, `Math.cos`, `Math.pow` and `Math.hypot`
 * are implementation-defined in ECMAScript and the browser's V8 and Bun's
 * JavaScriptCore differ in the last place. `Math.sqrt` is specified to IEEE-754
 * exactness and is the only root here, used once per pose to normalise a
 * heading. `server/integration-check.ts`'s `checkTraffic` asserts the whole of
 * this bit for bit over ten thousand ticks.
 *
 * A red light is not a state machine either. It is two copies of the same vertex
 * with four seconds between their timestamps, so the lerp between them is a
 * stationary car, for free.
 *
 * ---------------------------------------------------------------------------
 * NOTHING APPEARS OR DISAPPEARS WHILE IT IS MOVING.
 *
 * The first version of this file drew a car between its departure tick and its
 * arrival tick and nothing outside that window, which meant a car *materialised
 * mid-lane at 50 km/h* at every route start and blinked out at every route end.
 * The user's report was exactly right, and so was their fix: "maybe you can park
 * them on the side and unpark them".
 *
 * So a schedule entry now has five stages rather than one, and all five are the
 * same pure function of the tick:
 *
 *     PARKED_IN -> PULL_OUT -> DRIVING -> PULL_IN -> PARKED_OUT
 *
 * It sits at the kerb beside its route's start for a hashed dwell, pulls out
 * over ~2.6 s, drives the timetable exactly as before, pulls in at the far end
 * and sits there for another dwell before the slot goes dormant. The wink in and
 * the wink out now both happen while the car is **stationary at a kerb bay, at
 * the same offset and the same heading as the 23,020 static parked cars**
 * `world/cars.ts` already draws -- which is the whole trick. A parked car
 * appearing among parked cars is not an event.
 *
 * Two properties make this cost nothing:
 *
 *   - **The timetable is not rebuilt.** The ramps are a *reparametrisation of
 *     route-time*, not extra route-time: `driveT(age)` is a cubic that pins
 *     `driveT(outT) = outT` with unit slope, so a car is in exactly the place
 *     the old timetable put it from the moment its ramp ends. Every downstream
 *     `t`, every red-light dwell and the pipeline's headway argument survive
 *     untouched. See `buildParkPhases`.
 *   - **The no-coincidence invariant survives.** `lanes.py` guarantees two cars
 *     on one route never meet because the timetable is strictly increasing
 *     except in dwells shorter than the headway. `driveT` is monotone
 *     non-decreasing and identical for every slot on a route, so the same
 *     argument holds verbatim -- provided a parked dwell is itself shorter than
 *     the *window the bay is held for*, which is why `PARK_BAY_GAP` exists and
 *     is the binding constraint on how long a car may sit.
 *
 * A parked car is stationary, and `applyCarHit` now knows it: the knockback
 * scales continuously with the car's own speed, so standing beside one at the
 * kerb is safe and being clipped by one pulling out at 2 m/s is a shove rather
 * than a flight over the bonnet.
 *
 * ---------------------------------------------------------------------------
 * AND THE BAY IS OWNED, NOT GUESSED. THIS IS WHAT LANES v2 IS.
 *
 * "when a car pulls in it must be to an empty spot, and when it leaves it must
 * clear up that spot. they should never overlap." Three things had to change
 * before that sentence was true, and only one of them was in this file.
 *
 *   1. **Which bay.** v1 derived it here, from the ways block of the tile being
 *      decoded, which cannot see the 23,020 static parked cars in `.cars.bin`
 *      (the server never opens that file) and cannot see any other route's
 *      claim (the claimant may be three tiles away). So it collided with both.
 *      `pipeline/sydney/bays.py` now arbitrates every bay in the extent in one
 *      pass and bakes the answer into the sidecar. This file reads it.
 *   2. **For how long.** v1 capped a dwell at `0.9 * headway` and argued a bay
 *      therefore held one car -- which is true of two *parked* cars and says
 *      nothing about the one still pulling out of the bay the next has arrived
 *      in. That was the largest single class of overlap in the shipped city.
 *      See `PARK_BAY_GAP`.
 *   3. **What "the same car" means.** `CarPose.identity` is a stable 32-bit
 *      name for a car that never changes across its five stages, so the thing
 *      that pulls out of one bay is the thing that pulls into the other.
 *
 * `checkTraffic` sweeps two simulation hours at 1 Hz over the inner ring and
 * asserts that no car sitting in a bay is ever inside another car sitting in a
 * bay, or inside any of the static fleet.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK IS UNIX TIME, AND THAT IS A DECISION.
 *
 * The natural clock is the server's simulation tick -- it is what every other
 * deterministic thing in this project is a function of. It is not used here for
 * two reasons. It is private to `net/client.ts` on the browser side and exposing
 * it means a protocol field, which is exactly what this feature exists to avoid;
 * and it restarts at zero when the server process does, which would teleport
 * every car in Sydney on a deploy.
 *
 * `Date.now()` has neither problem and both ends already have it. What it costs
 * is clock skew: two NTP-disciplined machines differ by tens of milliseconds,
 * which at 14 m/s is tens of centimetres of car. The failure is graceful in the
 * direction that matters -- the server decides whether a car hit you and the
 * client only predicts it, so a skewed clock costs a misprediction that
 * `net/client.ts`'s existing correction absorbs exactly as it absorbs any other.
 *
 * ---------------------------------------------------------------------------
 * CARS DO NOT COLLIDE WITH ANYTHING. THEY PLOUGH THROUGH.
 *
 * Not with each other, not with the player, not with a building. That is the
 * point rather than a shortcut: the thing the user asked for is *being knocked
 * over*, and a car that braked for you would never do it. Conceptually these are
 * trams on rails.
 *
 * Two cars never occupy the same place anyway, and it is the *pipeline* that
 * guarantees it rather than anything here: routes are an edge-disjoint
 * decomposition of the lane graph, so no two share a lane, and within one route
 * the departure headway is strictly greater than the longest red on it, which is
 * the condition for two cars on one timetable never to meet. See `lanes.py`.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing from three.** `game/footy.ts` set that precedent
 * and states it in the same words: the Bun server compiles this module, and a
 * `Vector3` reaching it would drag the whole renderer into a process that draws
 * nothing. It imports numbers and functions from `game/combat.ts` exactly as
 * `footy.ts` does, and like `footy.ts` it mutates a victim through `.set()`
 * rather than allocating anything.
 */

import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  FLINCH_LOCKOUT,
  HITSTOP,
  KO_SECONDS,
  createCombatant,
  feetY,
  isTargetable,
  type CombatantState,
} from './combat.ts';
import { EYE_HEIGHT } from '../player/controller.ts';
import { UNIFORM_CROWD, trafficMultiplier, verifyDensity } from './density.ts';

// --- The sidecar contract ------------------------------------------------------

/** ASCII 'LANE' little-endian. Must match `tiles.LANES_MAGIC`. */
export const LANES_MAGIC = 0x454e414c;
/**
 * v2: every route carries the two kerb bays its cars park in.
 *
 * v1 *derived* them here, at decode time, from the ways block in the same tile
 * -- and that is the bug this version exists to end. A derivation cannot see
 * what it is not given, and what a per-tile decoder is not given is (a) the
 * 23,020 static cars in `.cars.bin`, which the server never opens at all, and
 * (b) every other route's claim on the same three metres of gutter. So schedule
 * cars parked on top of parked cars and on top of each other. Measured on the
 * shipped v1 world, 360 one-second samples of the inner 1.5 km: 654 pairs of a
 * schedule car interpenetrating a static one and 1,163 pairs of two routes in
 * one bay.
 *
 * `pipeline/sydney/bays.py` now arbitrates every bay in the extent in one
 * global pass and bakes the winner into the sidecar. Both ends *read* it, which
 * is also why the bump is not optional: a v1 file has no park block, so a v2
 * decoder pointed at one would fall straight back to deriving.
 */
export const LANES_VERSION = 2;

/**
 * The class byte in `.lanes.bin`, in the pipeline's own order.
 *
 * **Append only.** An index in a file already on disk must keep meaning what it
 * meant, which is `mesh.MATERIALS`' rule and is here for the same reason: the
 * world is cached for a year and a reordered table renames every street in it.
 * Must match `lanes.LANE_CLASSES`.
 */
export const LANE_CLASSES = [
  'motorway', 'motorway_link',
  'trunk', 'trunk_link',
  'primary', 'primary_link',
  'secondary', 'secondary_link',
  'tertiary', 'tertiary_link',
  'residential', 'unclassified', 'living_street', 'service',
  'other',
] as const;

/** Ticks per second the baked timetable is denominated in. */
export const TRAFFIC_HZ = 60;

/**
 * 2026-01-01T00:00:00Z. Tick zero.
 *
 * Near the build rather than 1970 so the tick stays inside 2^31 for over a year,
 * which keeps every integer hash derived from it in exact `Math.imul` range.
 * Both numbers also travel in `index.json`'s `lanes` block; they are repeated
 * here because the *decoder* needs them before it has read anything, and
 * `verifyTraffic` is handed the index's copy to check the two agree.
 */
export const TRAFFIC_EPOCH_MS = 1767225600000;

/**
 * The shared clock, in ticks. See the header for why this is wall time.
 *
 * `Math.floor` of a double multiply: both are exactly specified, so two
 * processes handed the same millisecond produce the same integer.
 */
export function trafficTick(nowMs: number): number {
  return Math.floor((nowMs - TRAFFIC_EPOCH_MS) * (TRAFFIC_HZ / 1000));
}

/** Ticks to seconds. One divide, so the two ends cannot round differently. */
export function trafficSeconds(tick: number): number {
  return tick / TRAFFIC_HZ;
}

// --- What a car is -------------------------------------------------------------

/**
 * Body dimensions, metres, indexed by `cars.BODY_SPEC`'s own body ids.
 *
 * These are the numbers the *hit box* is built from, and `cars.ts` draws the
 * same five bodies at the same sizes. It is not shared by import because that
 * import runs the wrong way -- `cars.ts` pulls in three -- so `verifyTraffic`
 * takes the render table as an argument and asserts the two agree. A car that
 * knocks you over from a metre away, or drives through you, is exactly the kind
 * of failure that renders perfectly.
 */
export const CAR_BODY_SIZE: ReadonlyArray<{ length: number; width: number; height: number }> = [
  { length: 4.6, width: 1.8, height: 1.45 },  // sedan
  { length: 4.2, width: 1.75, height: 1.5 },  // hatch
  { length: 4.7, width: 1.9, height: 1.7 },   // SUV
  { length: 5.2, width: 1.85, height: 1.8 },  // ute
  { length: 5.4, width: 1.9, height: 2.0 },   // van
];

/**
 * How the fleet is mixed, as a cumulative table over `CAR_BODY_SIZE`.
 *
 * SUVs and utes are over-represented against a global car park and under it
 * against an Australian one -- 35% of new sales here are an SUV and the ute is
 * the country's best-selling vehicle -- and the van is deliberately rare because
 * it is the one body that reads as a *delivery* rather than as traffic.
 */
const BODY_MIX = [0.3, 0.55, 0.8, 0.94, 1.0];

/** Paint index count. Must match `cars.PAINT`'s length. */
export const CAR_PAINT_COUNT = 8;

/**
 * Paint mix, cumulative. The same distribution `parking.py` uses for the kerb --
 * white 30, silver 15, grey 10, black 15, blue 10, red 8, green 5, beige 7 --
 * because a street where the parked cars and the moving ones came from different
 * palettes reads as two different games.
 */
const PAINT_MIX = [0.3, 0.45, 0.55, 0.7, 0.8, 0.88, 0.93, 1.0];

// --- The knockdown -------------------------------------------------------------

/**
 * What a car does to you, m/s.
 *
 * Just under `combat.KNOCKBACK_HORIZONTAL` (11.0) on purpose, and higher in the
 * vertical than a punch's 5.5. The bat is still the weapon: a car should throw
 * you *further off your feet* than a punch and not further down the street, or
 * standing in traffic becomes a better way to cross Pitt Street than running.
 * The extra lift is what makes it read as being hit by a car rather than as
 * being shoved by one -- you go over the bonnet.
 */
export const CAR_KNOCKBACK_HORIZONTAL = 10.5;
export const CAR_KNOCKBACK_VERTICAL = 7.0;

/** One pip, the bat's damage exactly. A car is not a better weapon than a friend. */
export const CAR_DAMAGE = 1;

/**
 * How long being run down takes control away, seconds.
 *
 * Longer than `combat.FLINCH_LOCKOUT`'s 0.3, because 0.3 s is a punch and this
 * is a Hilux. It is spent **through the existing flinch phase** rather than
 * through a new field: `applyCarHit` starts the phase at a negative `phaseT`, so
 * `combat.advance`'s own `phaseT >= FLINCH_LOCKOUT` test ends it this many
 * seconds later and every consumer of `phase` -- the movement lock, the
 * animation, the snapshot byte -- keeps working with no change at all. Inventing
 * a second lockout channel would have meant a protocol field for a thing the
 * protocol already carries.
 */
export const CAR_STAGGER = 0.85;

/** Half the plan slack a hit box gets over the body's own footprint, metres. */
const HIT_MARGIN = 0.1;

/**
 * Below this, a car cannot run you down at all, m/s.
 *
 * The rule this encodes is the one the parked stages made necessary: a car that
 * is not moving is street furniture, and walking up to a parked car has to be as
 * safe as walking up to a bollard. It also fixes a bug that predates the parking
 * -- a car held at a red light used to knock you flat with the full 10.5 m/s,
 * because the old hit test had no idea whether the thing it found was moving.
 *
 * 1 m/s rather than zero because a hit box that switches on at exactly 0 m/s
 * would arm on the first millimetre of a pull-out, and a car doing 4 km/h is
 * still a car you can walk out of the way of.
 */
export const CAR_HIT_MIN_SPEED = 1.0;

/**
 * At and above this, the full knockback, m/s.
 *
 * Set below the slowest class speed cap on purpose: a car actually *driving*
 * hits with the number `CAR_KNOCKBACK_HORIZONTAL` names, and the ramp between
 * the two speeds only ever covers the two or three seconds a car spends pulling
 * out of or into a kerb bay. If this were set at the 14 m/s an arterial runs at,
 * every knockdown in a 50 km/h suburb would be a soft one and the feature would
 * have quietly been retuned.
 */
export const CAR_HIT_FULL_SPEED = 8.0;

// --- Decoded shapes ------------------------------------------------------------

/**
 * One drivable way, in world metres. **Nothing in this file reads it.**
 *
 * It is decoded and held because it is the reusable half of the sidecar: the
 * street network as geometry, with the two widths that let a consumer derive
 * anything that runs beside it -- a footpath is
 * `centreline +/- (halfWidth + kerb + footpathWidth/2)`. See
 * `tiles.write_lanes`, which is where that contract is written down.
 */
export interface LaneWay {
  osmId: number;
  klass: number;
  oneway: boolean;
  /** Centreline to kerb, metres. */
  halfWidth: number;
  /** The paved band beyond the kerb, metres. Zero on a motorway. */
  footpathWidth: number;
  count: number;
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
}

// --- The kerb ------------------------------------------------------------------

/**
 * How far in from the kerb face a parked car's centreline sits, metres.
 *
 * **`parking.KERB_OFFSET`, and it must stay that number.** Half a car's width
 * plus 0.15 m of gutter. This is the single constant that makes a schedule car
 * in its parked stage land in the same line as the static fleet beside it, and a
 * schedule car sitting 30 cm proud of the row it is parked in would undo the
 * whole point of parking it. `verifyTraffic` asserts the derived pose against a
 * way of known width.
 *
 * Since v2 **nothing in this file uses it**. The bay a schedule car parks in is
 * chosen by `pipeline/sydney/bays.py` off `parking.py`'s own canonical grid and
 * arrives in the sidecar as a vector, so the two fleets line up because they
 * came out of one arbitration rather than because two constants agree. It is
 * kept, exported and asserted because it is the *contract* the pipeline is held
 * to: `verifyTraffic` still checks a synthetic route's parked pose against
 * `halfWidth - PARKED_KERB_OFFSET`, which is the number `parking.py` would have
 * used, and a pipeline that started emitting bays somewhere else would fail
 * that check rather than quietly shipping a row of cars 30 cm out of line.
 */
export const PARKED_KERB_OFFSET = 1.05;

/** The pull-out and the pull-in, seconds. A standing start and a stop. */
const PULL_OUT_SECONDS = 2.6;
const PULL_IN_SECONDS = 2.6;

/**
 * The route-time a car's ramps and its inset need, seconds.
 *
 * `3 * out + in`: the pull-out may begin up to `2 * PULL_OUT_SECONDS` into the
 * route (that is the monotonicity bound on the warp -- see `buildParkPhases`),
 * takes another one, and the pull-in takes its own. A route shorter than this
 * scales both ramps down rather than overlapping them.
 */
const RAMP_BUDGET = 3 * PULL_OUT_SECONDS + PULL_IN_SECONDS;

/**
 * Guaranteed empty seconds between two occupants of one bay.
 *
 * The user's rule, in full: "when a car pulls in it must be to an empty spot,
 * and when it leaves it must clear up that spot." The second half of that was
 * never enforced. v1 capped a dwell at `0.9 * headway` and argued that a bay
 * therefore held one car at a time -- which is true of two *parked* cars and
 * says nothing at all about the car still pulling out of the bay the next one
 * has already arrived in. Measured on the shipped v1 world over 360 samples of
 * the inner 1.5 km: 2,127 pairs of a parked car overlapping the car ahead of it
 * on the same route mid-pull-out, and 2,343 of a parked car overlapping the one
 * behind it mid-pull-in. Both were the largest single class of overlap in the
 * city and neither was a bay conflict at all -- they were the same bay, used
 * twice, too soon.
 *
 * So the cap is now the *occupancy window* rather than a share: a bay is held
 * from the moment a car's ramp starts touching it until the moment it is done,
 * which is `outT` after departure at the near end and `inLen` before arrival at
 * the far end. See `buildParkPhases`.
 */
const PARK_BAY_GAP = 1.5;

/**
 * Shorter than this and a route gets no park stages at all, seconds.
 *
 * A two-second route is a stub whose ramps would be a fifth of a second each,
 * which is a car that teleports out of a bay rather than one that pulls out of
 * it. `lanes.MIN_ROUTE_M` already drops the shortest of these; this catches what
 * is left.
 */
const MIN_PARK_DURATION = 2.0;

/**
 * The share of a route's own duration either park stage may consume.
 *
 * **`bays.MAX_PARK_SHARE`, and it is the entire interface between the two
 * halves of this feature.** The pipeline refuses any bay outside it; this file
 * then knows, without being told anything else, that it can always choose ramp
 * spans that are monotone *and* leave a driving stage between them -- see
 * `buildParkPhases` for the derivation. Duplicating `PULL_OUT_SECONDS` into
 * Python instead would have put a constant on both sides of a file format,
 * which is the drift v2 exists to remove.
 */
const MAX_PARK_SHARE = 0.25;

/** How long a car sits at the kerb, seconds, before the headway cap bites. */
const PARK_DWELL_MIN = 6;
const PARK_DWELL_MAX = 18;

/**
 * The bay the arbitration could not fill, and what the car does instead.
 *
 * `bays.py` walks sixty metres of kerb from each route end looking for ground
 * nothing else owns, and then -- as a last resort -- offers the lane itself,
 * which is why so few ends come back empty: 29 of 1,004 over the inner 1.6 km.
 * An end that still has nothing gets no park stage at all, and its cars wink in
 * and out mid-lane at road speed, which is exactly the artefact the park stages
 * were added to remove. That is deliberate and it is the right trade: the
 * alternative is a car that materialises *on top of another car*, and a pop is
 * a thing you might catch where two bodies in one place is a thing you
 * photograph. `kerblessEndpoints` counts them and `checkTraffic` bounds them.
 */

/** The five stages of a schedule car's life. `CarPose.stage`. */
export const CAR_STAGE_PARKED_IN = 0;
export const CAR_STAGE_PULL_OUT = 1;
export const CAR_STAGE_DRIVING = 2;
export const CAR_STAGE_PULL_IN = 3;
export const CAR_STAGE_PARKED_OUT = 4;

/** One car route: a lane-offset polyline and the timetable along it. */
export interface LaneRoute {
  /** Stable across builds. The hash seed for every car that ever drives it. */
  rid: number;
  klass: number;
  /** Seconds between departures. */
  headway: number;
  /** Seconds, this route's own offset into the headway. */
  phase: number;
  /** Seconds for one traversal -- `t[count - 1]`. */
  duration: number;
  count: number;
  /** World metres. `y` is absolute and is already on the running surface. */
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Cumulative seconds from the route's start. Strictly increasing. */
  t: Float32Array;
  /** Plan bounds, for the broadphase. Derived at decode. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;

  // --- The park stages. The two *bays* come out of the sidecar's park block --
  // `bays.py` arbitrated them against the static fleet and against every other
  // route -- and everything else here is the ramp arithmetic that reaches them.
  // `buildParkPhases` is the only thing that writes any of it.

  /** Route-time the car waits at, parked, before it departs. Seconds. */
  parkT0: number;
  /** Route-time the pull-out ramp finishes and the timetable resumes. */
  outT: number;
  /** Route-time the pull-in ramp begins. */
  inT: number;
  /** Route-time the car comes to rest in the far bay. `<= duration`. */
  parkT1: number;
  /** `outT - parkT0`, and the two cubic coefficients of the pull-out warp. */
  outSpan: number;
  outA: number;
  outB: number;
  /** `duration - inT`, `parkT1 - inT`, and the pull-in warp's three. */
  inLen: number;
  inSpan: number;
  inA: number;
  inB: number;
  inC: number;
  /**
   * How far each bay sits from the lane, metres. Diagnostics only.
   *
   * Derived from the two vectors below rather than carried separately, and
   * **zero is a legal value for a real bay** -- `bays.py` takes the lane spot
   * itself when no kerb is free. `bay0`/`bay1` are what say whether an end has
   * a bay; this only says how far off the lane it is.
   */
  kerbShift0: number;
  kerbShift1: number;
  /**
   * The two bays as **world vectors from the lane point**, straight out of the
   * sidecar's park block.
   *
   * Not recomputed per frame from the car's instantaneous heading, and that is a
   * correctness fix rather than an optimisation. A route polyline turns corners,
   * so its heading is a step function at every vertex; multiplying a two-metre
   * kerb offset by a direction that flips at a vertex teleports the car sideways
   * by up to twice the offset in one tick, and a ramp that happens to span a
   * corner does exactly that. Measured on the shipped world before this was
   * frozen: a 1.51 m jump in one tick on a secondary road that turns 80 degrees
   * a metre and a half into its pull-out.
   *
   * Fixed, the offset is the vector from the lane to the bay *at the bay*, and
   * everything between there and the lane is a straight blend of it. The car
   * still turns the corner -- that is `driveT` and the polyline -- it just stops
   * dragging its kerb offset round the corner with it. Since v2 it is not even
   * derived here: the pipeline measured it against the bay it claimed, which is
   * the only way both processes can be sure they mean the same three metres of
   * gutter.
   */
  kerbOffX0: number;
  kerbOffZ0: number;
  kerbOffX1: number;
  kerbOffZ1: number;
  /**
   * Does this end own a bay at all? Straight off the sidecar's flags byte.
   *
   * Not `kerbShift > 0`, which is what v1 used and which is now wrong in the
   * one case that matters: `bays.py`'s last-resort fallback claims the *lane*
   * itself when no kerb is free, and a lane bay has a shift of exactly zero
   * while being a perfectly real exclusive claim. Reading the flag instead of
   * inferring it from the geometry is the difference between a car that dwells
   * where it drives -- which is what a car at a red light is -- and a car that
   * winks into existence at 50 km/h.
   */
  bay0: boolean;
  bay1: boolean;
  /**
   * The longest each dwell may run, seconds. Per end, because the two ends hold
   * their bays for different lengths of time -- see `PARK_BAY_GAP`.
   */
  dwellCap0: number;
  dwellCap1: number;
  /** The larger of the two. Bounds `liveSlots`, which needs one number. */
  dwellCap: number;
}

export interface TileLanes {
  ways: LaneWay[];
  routes: LaneRoute[];
}

/** Where one car is, and what it looks like. Reused; never allocated per frame. */
export interface CarPose {
  route: number;
  /** Which departure this is. Grows forever; used only as a hash input. */
  slot: number;
  x: number;
  y: number;
  z: number;
  /** Unit heading in the world plan. */
  dx: number;
  dz: number;
  body: number;
  colour: number;
  scale: number;
  /** Half the hit box, already scaled. */
  halfLength: number;
  halfWidth: number;
  height: number;
  /**
   * Which of the five stages this car is in. `CAR_STAGE_*`.
   *
   * Read by nothing that draws -- a parked schedule car is drawn exactly like a
   * driving one, which is the point -- and by the checks, the dev handle and
   * anything that wants to know whether the thing it found is traffic or
   * furniture.
   */
  stage: number;
  /**
   * The route-time this car is displaying, seconds.
   *
   * Equal to its age through the whole driving stage and warped either side of
   * it -- see `buildParkPhases`. Exposed because it is the quantity the lane
   * audit's monotonicity property is about: `lanes.py` proves two cars on one
   * route never meet from the fact that this only ever increases, and a check
   * that could only see world positions would have to infer it from a polyline
   * that legitimately turns corners.
   */
  routeT: number;
  /**
   * How fast the car is going along its route, m/s, at this instant.
   *
   * Zero in both parked stages and through a red light, and it ramps
   * continuously from zero through a pull-out. This is what `carHitStrength`
   * reads, and it costs nothing to produce: `poseCar` already takes the one
   * `Math.sqrt` this module allows to normalise the heading, and the segment
   * length that root came from is the numerator here.
   */
  speed: number;
  /**
   * Who this car *is*, as a stable well-distributed 32-bit number.
   *
   * A pure function of `(route.rid, slot)` and of nothing else -- the same hash
   * the body, the paint and both dwells are already drawn from, handed over
   * rather than re-derived so that a consumer cannot accidentally key off a
   * different stream. Three properties, and all three are the point:
   *
   *   - **It never changes across a car's life.** The five stages read this
   *     hash and none of them re-rolls it, so the thing that pulls out of a bay
   *     is the same thing that pulls into the far one. `checkTraffic` walks a
   *     whole life at 60 Hz and asserts it.
   *   - **It is the same number in every process.** `carHash` is `Math.imul`,
   *     xor and shift, which are exact 32-bit integer operations everywhere, so
   *     the browser and the Bun server name the same car the same thing with no
   *     byte on the wire.
   *   - **It survives a rebuild.** `rid` is hashed from the route's geometry by
   *     `lanes._schedule` and is stable across builds that do not move the road.
   *
   * What it is *for* is the pass after this one: a model table keyed by
   * identity, so a given car is the same 3D model every time anyone sees it.
   * Nothing here knows or cares what that table holds. `world/cars.ts` exports
   * the matching function for the static fleet.
   */
  identity: number;
  /**
   * How wrecked this car is, 0 (nobody has touched it) to 1 (written off).
   *
   * **Always zero for a schedule car and never anything else**, and that is the
   * whole reason it lives on this record rather than on `driving.DrivenCar`
   * where the number actually is. Everything that draws a car in this client --
   * the box fleet in `world/cars.ts`, the model fleet in `world/carlod.ts`, the
   * headlights in `world/nightlights.ts` -- takes a `CarPose` and asks it no
   * questions about where it came from, which is `drivenCarPose`'s whole
   * argument. A dent that had to travel by any other route would be a second
   * draw path for driven cars only, which is exactly the "the car you steer does
   * not look like traffic" that `world/drivencars.ts` exists to avoid.
   *
   * A *fraction* rather than the record's 0..100 because every consumer is a
   * renderer multiplying something by it. `driving.damageFraction` is the one
   * place the conversion happens.
   */
  damage: number;
  /**
   * How far behind its timetable this car is being held, metres. See `resolveHeld`.
   *
   * Zero for every car in the city that is not stuck behind something a player
   * left in the lane. Written by `forEachCarNear` *after* `poseCar` has placed
   * the car, and the position on this record has already had it applied -- this
   * field is what the hold is, exposed so a check can assert two `TrafficField`s
   * agree about it and so the dev overlay can count the cars that are queued.
   */
  held: number;
}

export function createCarPose(): CarPose {
  return {
    route: 0, slot: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    body: 0, colour: 0, scale: 1, halfLength: 0, halfWidth: 0, height: 0,
    stage: CAR_STAGE_DRIVING, routeT: 0, speed: 0, identity: 0, damage: 0, held: 0,
  };
}

// --- Decoding ------------------------------------------------------------------

/**
 * Decode a `.lanes.bin` into world coordinates.
 *
 * `originX`/`originZ` are the tile group's world translation --
 * `(bounds[0], bounds[1] + tile_size)`, the same pair `server/world.ts` and
 * `streamer.ts` already compute for the collision prisms. Applied **here**, once
 * at load, rather than at every evaluation: a car crosses tiles constantly and
 * there is no tile group to inherit a translation from, because the moving
 * fleet is one instanced set for the whole visible world rather than one per
 * tile.
 *
 * Returns `null` for anything that is not a lane sidecar, so a tile with no
 * drivable street is indistinguishable from a tile whose file is missing -- the
 * contract every other decoder in this project has.
 */
export function decodeLanes(
  buffer: ArrayBuffer,
  originX: number,
  originZ: number,
  /**
   * How busy this part of Sydney is, per route. Defaulted, and every caller
   * outside a self-check takes the default -- see `density.UNIFORM_CROWD` for
   * why the seam exists at all.
   */
  crowd: (x: number, z: number, klass: number) => number = trafficMultiplier,
): TileLanes | null {
  if (buffer.byteLength < 16) return null;
  const v = new DataView(buffer);
  if (v.getUint32(0, true) !== LANES_MAGIC) return null;
  if (v.getUint32(4, true) !== LANES_VERSION) return null;
  const wayCount = v.getUint32(8, true);
  const routeCount = v.getUint32(12, true);

  const ways: LaneWay[] = [];
  const routes: LaneRoute[] = [];
  let o = 16;
  for (let w = 0; w < wayCount; w++) {
    if (o + 16 > buffer.byteLength) return null;
    const osmId = v.getUint32(o, true);
    const klass = v.getUint8(o + 4);
    const flags = v.getUint8(o + 5);
    const n = v.getUint16(o + 6, true);
    const halfWidth = v.getFloat32(o + 8, true);
    const footpathWidth = v.getFloat32(o + 12, true);
    o += 16;
    if (n < 2 || o + n * 12 > buffer.byteLength) return null;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = v.getFloat32(o, true) + originX;
      y[i] = v.getFloat32(o + 4, true);
      z[i] = v.getFloat32(o + 8, true) + originZ;
      o += 12;
    }
    ways.push({ osmId, klass, oneway: (flags & 1) !== 0, halfWidth, footpathWidth, count: n, x, y, z });
  }

  for (let r = 0; r < routeCount; r++) {
    if (o + 40 > buffer.byteLength) return null;
    const rid = v.getUint32(o, true);
    const klass = v.getUint8(o + 4);
    const bayFlags = v.getUint8(o + 5);
    const n = v.getUint16(o + 6, true);
    const headway = v.getFloat32(o + 8, true);
    const phase = v.getFloat32(o + 12, true);
    // The park block, v2. Twenty-four bytes of *claim*: two route-times and two
    // lane-to-bay vectors that `pipeline/sydney/bays.py` arbitrated against the
    // static fleet and against every other route in the extent. Read, not
    // derived -- see `LANES_VERSION`.
    const bayT0 = v.getFloat32(o + 16, true);
    const bayOffX0 = v.getFloat32(o + 20, true);
    const bayOffZ0 = v.getFloat32(o + 24, true);
    const bayT1 = v.getFloat32(o + 28, true);
    const bayOffX1 = v.getFloat32(o + 32, true);
    const bayOffZ1 = v.getFloat32(o + 36, true);
    o += 40;
    if (n < 2 || o + n * 16 > buffer.byteLength) return null;
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    const t = new Float32Array(n);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const px = v.getFloat32(o, true) + originX;
      const pz = v.getFloat32(o + 8, true) + originZ;
      x[i] = px;
      y[i] = v.getFloat32(o + 4, true);
      z[i] = pz;
      t[i] = v.getFloat32(o + 12, true);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
      o += 16;
    }
    // A route with a broken timetable would divide by zero in `poseCar`, and a
    // headway of zero would make the live-car count infinite. Both are dropped
    // rather than clamped: a car in the wrong place is a bug you can see, and a
    // hang is not.
    if (!(headway > 0) || !(t[n - 1] > 0)) continue;
    const scaled = scaleHeadway(headway, klass, x, z, t, n, minX, maxX, minZ, maxZ, crowd);
    const route: LaneRoute = {
      rid, klass, headway: scaled, phase, duration: t[n - 1], count: n, x, y, z, t, minX, maxX, minZ, maxZ,
      // Filled by `buildParkPhases` below. Zeroed rather than left undefined so
      // a route that somehow escaped that pass is a car with no park stages --
      // a cruise from end to end -- rather than a NaN in a hit box.
      parkT0: 0, outT: 0, inT: t[n - 1], parkT1: t[n - 1],
      outSpan: 0, outA: 0, outB: 0,
      inLen: 0, inSpan: 0, inA: 0, inB: 0, inC: 0,
      kerbShift0: 0, kerbShift1: 0,
      kerbOffX0: bayOffX0, kerbOffZ0: bayOffZ0, kerbOffX1: bayOffX1, kerbOffZ1: bayOffZ1,
      bay0: (bayFlags & 1) !== 0, bay1: (bayFlags & 2) !== 0,
      dwellCap0: 0, dwellCap1: 0, dwellCap: 0,
    };
    route.parkT0 = bayT0;
    route.parkT1 = bayT1;
    routes.push(route);
  }
  for (const route of routes) buildParkPhases(route);
  return { ways, routes };
}

/**
 * Stretch or squeeze a baked timetable to match how busy this part of Sydney is.
 *
 * The whole of the "weight cars by density" brief lands in this one function,
 * and it lands here rather than in the bake for the reason `game/density.ts`'s
 * header gives: this decoder is a pure function of the same bytes on the client
 * and on the Bun server, so a change made here is consistent across the wire for
 * free and needed nothing rebuilt. A `.lanes.bin` from the shipped world now
 * produces a busy Parramatta Road and a nearly empty Old Northern Road out of
 * the identical file.
 *
 * **The headway is the dial, and it is the only safe one.** A route's cars are
 * one timetable offset by `headway`, so lengthening the headway removes cars and
 * shortening it adds them without touching a single coordinate. Dropping whole
 * routes instead would empty streets rather than quieten them, and thinning
 * slots would fight `liveSlots`, which derives the live set from the headway
 * arithmetic in the first place.
 *
 * ---------------------------------------------------------------------------
 * THE FLOOR, AND WHY IT IS MEASURED HERE RATHER THAN TRUSTED
 *
 * `lanes._headway` guarantees a headway strictly greater than the longest dwell
 * on the route, and the header's collision-free claim is exactly that: two cars
 * on one timetable can only meet where the timetable is constant, and no dwell
 * is long enough to hold both. Lengthening a headway cannot break that.
 * *Shortening* one can, and `trafficMultiplier` goes to 1.2 in the inner city,
 * which is a headway multiplied by 0.833.
 *
 * So the longest dwell is **measured off the route's own timetable** rather than
 * inferred from the pipeline's 1.5 s margin: a dwell is a run of consecutive
 * samples at the same point, and its length is the gap in `t` across that run.
 * That is the exact quantity the proof needs, it costs one pass over an array
 * the decoder has just finished writing, and it means a rebake that retunes
 * `lanes.HEADWAY` cannot silently invalidate the squeeze.
 *
 * The parking dwells need no such care: `buildParkPhases` derives `dwellCap0`
 * and `dwellCap1` *from* `r.headway`, and it runs after this, so the bay
 * invariant `dwellCap + ramp + PARK_BAY_GAP <= headway` is re-established
 * against the new number rather than inherited from the old one.
 * `verifyTraffic` asserts it either way.
 */
function scaleHeadway(
  headway: number,
  klass: number,
  x: Float32Array,
  z: Float32Array,
  t: Float32Array,
  n: number,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  crowd: (x: number, z: number, klass: number) => number,
): number {
  const mul = crowd((minX + maxX) * 0.5, (minZ + maxZ) * 0.5, klass);
  if (!(mul > 0)) return headway;
  const want = headway / mul;
  if (want >= headway) return want;

  // Squeezing. Find the longest stretch of route-time the car spends stationary
  // and refuse to go under it.
  let longest = 0;
  let runStart = 0;
  for (let i = 1; i < n; i++) {
    const dx = x[i] - x[runStart];
    const dz = z[i] - z[runStart];
    if (dx * dx + dz * dz > STATIONARY_EPS_SQ) {
      runStart = i;
      continue;
    }
    const held = t[i] - t[runStart];
    if (held > longest) longest = held;
  }
  const floor = longest + HEADWAY_SQUEEZE_MARGIN;
  if (want < floor) return headway < floor ? headway : floor;
  return want;
}

/**
 * How far apart two timetable samples must be to count as the car having moved.
 *
 * `lanes._dedupe` already collapses exactly-repeated points, so a dwell arrives
 * here as two samples at coordinates that agree to the f32 they were written as.
 * A centimetre squared is comfortably above that quantisation and comfortably
 * below any real motion -- the slowest a moving car goes is `lanes.MIN_SPEED`,
 * which covers a centimetre in well under a tick.
 */
const STATIONARY_EPS_SQ = 1e-4;

/**
 * Kept between the longest dwell and the shortest headway a squeeze may reach.
 *
 * `lanes._headway` uses 1.5 s for the same job and this is not a copy of it:
 * that margin is a bake-time choice about how much air to leave, this is the
 * runtime's refusal to spend the last of it. Half a second at 60 Hz is thirty
 * ticks of clearance between the tail of one car's dwell and the nose of the
 * next, which is more than the rewind window can move either of them.
 */
const HEADWAY_SQUEEZE_MARGIN = 0.5;

// --- Parking the ends of a route -----------------------------------------------

/**
 * Turn a route's two baked bays into the two ramps that reach them.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE BAY COMES FROM, AND WHY IT IS NOT FROM HERE ANY MORE.
 *
 * v1 derived a bay in this function: find the nearest way in *this tile's* ways
 * block, take `halfWidth - PARKED_KERB_OFFSET` left of its centreline, land the
 * car there. It was the same pure function of the same bytes on both ends, so
 * the client and the server agreed -- and it was still wrong, because agreeing
 * is not the same as being right. Two things this function could not see:
 *
 *   1. **The static fleet.** 23,020 parked cars live in `.cars.bin`, which the
 *      server never opens and which this module has no business opening. So a
 *      schedule car pulled into a bay that already held one.
 *   2. **Every other route.** Two routes whose ends meet at one corner each
 *      derived the same bay, independently, and both were satisfied.
 *
 * Neither is fixable from inside a per-tile decoder, because neither is
 * per-tile. So the arbitration moved to `pipeline/sydney/bays.py`, which walks
 * `parking.py`'s own canonical bay grid outward from each route end until it
 * finds ground that nothing else in the extent owns, claims it, and writes the
 * claim into the sidecar. What is left here is arithmetic on numbers that
 * arrived in the file -- which is also why the server gets this for free.
 *
 * ---------------------------------------------------------------------------
 * THE RAMP IS A REPARAMETRISATION, NOT AN EXTRA PHASE OF THE TIMETABLE.
 *
 * The obvious construction bolts a couple of seconds of pull-out onto the front
 * of every route, which shifts every vertex time after it, which changes when
 * the car reaches every red light on the route, which breaks the headway proof
 * and means rebuilding the whole timetable in the decoder. None of that happens
 * here. `driveT(age)` maps the car's *age* onto the route-time it displays, and
 * it is pinned so that
 *
 *     driveT(outT) = outT   with   driveT'(outT) = 1
 *
 * -- the ramp gives the seconds back before it ends. From `outT` onward the car
 * is in precisely the place, at precisely the speed, the shipped `.lanes.bin`
 * put it, so every downstream `t` is untouched and `lanes.py`'s argument about
 * two cars on one route needs no restating.
 *
 * On [0, outT] the warp is the cubic `w(s) = a s^3 + b s^2` with `w(0) = 0`,
 * `w'(0) = 0` (a standing start), `w(1) = 1` and `w'(1) = g` where
 * `g = outT / outSpan` is whatever slope makes the join seamless. That gives
 * `a = g - 2`, `b = 3 - g`, and `w' = s(3a s + 2b)`, which is non-negative
 * across [0, 1] **exactly when `g <= 3`**. Monotone `w` is not an aesthetic
 * preference: a car that went backwards for a tenth of a second would break the
 * ordering the no-coincidence proof depends on.
 *
 * ---------------------------------------------------------------------------
 * THE RAMP SPANS ARE CHOSEN, NOT FIXED, AND THAT IS WHAT LETS A BAY MOVE.
 *
 * v1 pinned the pull-out's *span* at `PULL_OUT_SECONDS` and then had to clamp
 * `parkT0` to `2 * PULL_OUT_SECONDS` to keep `g <= 3`, which put a hard ceiling
 * of about five seconds of route-time on how far into the route a bay could
 * sit. The far end was worse: its ceiling was `(2/3) * PULL_IN_SECONDS`, about
 * 1.7 seconds, which is nineteen metres at a residential speed and about three
 * bays. An arbitration that can only look three bays down the street is not an
 * arbitration.
 *
 * So the span is `max(P, parkT0 / 2)` instead -- exactly `P` for every bay
 * inside the old ceiling, so nothing that used to work behaves differently, and
 * growing beyond it for a bay the walk had to reach for. `g <= 3` is
 * `parkT0 <= 2 * outSpan`, which that expression satisfies by construction for
 * any `parkT0 >= 0`. A car whose bay is forty metres in simply takes longer to
 * get up to speed, which is what a car pulling out forty metres further up the
 * street looks like.
 *
 * The pull-in is the same cubic read backwards -- `v(0) = 0`, `v'(0) = gIn`,
 * `v(1) = 1`, `v'(1) = 0` -- over an age span `inLen` and a route-time span
 * `inSpan`, with `gIn = inLen / inSpan <= 3`. Given how far back from the route
 * end the bay is (`inset`), `inSpan = max(Q - inset, inset / 2)` and
 * `inLen = inset + inSpan`, which is `Q` exactly while `inset <= (2/3) Q` and
 * stretches after that.
 *
 * **The only thing this needs from the pipeline is `bays.MAX_PARK_SHARE`**:
 * both `parkT0` and `duration - parkT1` are at most a quarter of the route's
 * duration. That is what makes `outT < inT` -- the car has to actually drive
 * between its two bays -- and it is one bound rather than a shared copy of
 * `PULL_OUT_SECONDS`, so the two sides of the file format cannot drift.
 *
 * The lateral blend rides on top: `(1 - w)^2` out and `v^2` in, squared so that
 * the sideways velocity is zero at both ends of both ramps as well. Without the
 * square the car finishes its pull-out still drifting 0.3 m/s sideways and then
 * stops drifting in one frame, which is small but is exactly the kind of kink
 * the eye finds.
 */
function buildParkPhases(r: LaneRoute): void {
  const duration = r.duration;
  // A route too short to ramp, or one the arbitration gave nothing at either
  // end: `inT === duration` makes the whole life one cruise and a zero
  // `dwellCap` makes `liveSlots` the function it always was.
  if (duration < MIN_PARK_DURATION || (!r.bay0 && !r.bay1)) {
    r.parkT0 = 0;
    r.outT = 0;
    r.inT = duration;
    r.parkT1 = duration;
    r.bay0 = false;
    r.bay1 = false;
    r.kerbOffX0 = 0;
    r.kerbOffZ0 = 0;
    r.kerbOffX1 = 0;
    r.kerbOffZ1 = 0;
    return;
  }
  const k = duration >= RAMP_BUDGET ? 1 : duration / RAMP_BUDGET;
  const P = PULL_OUT_SECONDS * k;
  const Q = PULL_IN_SECONDS * k;

  // --- The near end.
  //
  // An end with no bay gets **no ramp at all**: `outT = 0` skips the pull-out
  // branch of `poseCar` entirely and the car is driving from its first tick,
  // which is v1's behaviour for a route that found no kerb. Giving it a ramp
  // anyway would make it appear *stationary in a lane* for the half-second the
  // ramp takes to reach 1 m/s, and a stationary car is a thing this feature now
  // promises never overlaps anything.
  //
  // The clamp is defensive rather than load-bearing: `bays.py` already refuses
  // any bay outside `[0, MAX_PARK_SHARE * duration]`, and a file that broke
  // that would break `outT < inT` below rather than the monotonicity above. It
  // is here because a NaN or a negative in a binary search is a car in the
  // wrong place, and this is the cheapest place in the whole feature to stop
  // one.
  let parkT0 = 0;
  let outSpan = 0;
  let outT = 0;
  if (r.bay0) {
    parkT0 = r.parkT0;
    if (!(parkT0 > 0)) parkT0 = 0;
    if (parkT0 > duration * MAX_PARK_SHARE) parkT0 = duration * MAX_PARK_SHARE;
    outSpan = P > parkT0 * 0.5 ? P : parkT0 * 0.5;
    outT = parkT0 + outSpan;
    const g = outT / outSpan;
    r.outA = g - 2;
    r.outB = 3 - g;
  }

  // --- The far end. The same, read backwards.
  let inset = 0;
  let inSpan = 0;
  let inLen = 0;
  if (r.bay1) {
    inset = duration - r.parkT1;
    if (!(inset > 0)) inset = 0;
    if (inset > duration * MAX_PARK_SHARE) inset = duration * MAX_PARK_SHARE;
    const rest = Q - inset;
    inSpan = rest > inset * 0.5 ? rest : inset * 0.5;
    inLen = inset + inSpan;
    const gIn = inLen / inSpan;
    r.inA = gIn - 2;
    r.inB = 3 - 2 * gIn;
    r.inC = gIn;
  }

  r.parkT0 = parkT0;
  r.outT = outT;
  r.outSpan = outSpan;
  r.inT = duration - inLen;
  r.parkT1 = duration - inset;
  r.inLen = inLen;
  r.inSpan = inSpan;

  // The magnitudes, for the diagnostics and for `verifyTraffic`. `Math.sqrt` is
  // IEEE-754 exact and is the one root this module allows itself; see the
  // header. Zero is a legal answer for a bay the arbitration placed in the lane
  // itself, which is why `bay0`/`bay1` and not these are what say whether an
  // end has a bay.
  r.kerbShift0 = r.bay0
    ? Math.sqrt(r.kerbOffX0 * r.kerbOffX0 + r.kerbOffZ0 * r.kerbOffZ0)
    : 0;
  r.kerbShift1 = r.bay1
    ? Math.sqrt(r.kerbOffX1 * r.kerbOffX1 + r.kerbOffZ1 * r.kerbOffZ1)
    : 0;
  if (!r.bay0) {
    r.kerbOffX0 = 0;
    r.kerbOffZ0 = 0;
  }
  if (!r.bay1) {
    r.kerbOffX1 = 0;
    r.kerbOffZ1 = 0;
  }

  // --- How long a car may sit, per end. See `PARK_BAY_GAP`.
  //
  // A bay is held from the moment its occupant's ramp starts touching it until
  // the moment that ramp is done -- `[dep - dwellIn, dep + outT]` at the near
  // end, `[arr - inLen, arr + dwellOut]` at the far one. The next slot arrives
  // one headway later, so the two windows are disjoint exactly when the dwell
  // is under `headway - (the ramp's own length) - a gap`. That is the whole
  // invariant, and it is per end because the two ramps are different lengths.
  //
  // Negative is legal and means what it says: on a route whose headway is
  // shorter than its own pull-out -- a motorway at five seconds -- there is no
  // room for a dwell at all, and the car appears at rest in its bay and leaves
  // immediately. That is still not a pop: it is stationary at a kerb when it
  // appears, which is the whole property the park stages exist to buy.
  const cap0 = r.headway - outT - PARK_BAY_GAP;
  const cap1 = r.headway - inLen - PARK_BAY_GAP;
  r.dwellCap0 = r.bay0 ? clampDwell(cap0) : 0;
  r.dwellCap1 = r.bay1 ? clampDwell(cap1) : 0;
  r.dwellCap = r.dwellCap0 > r.dwellCap1 ? r.dwellCap0 : r.dwellCap1;
}

function clampDwell(cap: number): number {
  if (!(cap > 0)) return 0;
  return cap < PARK_DWELL_MAX ? cap : PARK_DWELL_MAX;
}

/**
 * How many route endpoints in a decoded tile own no bay at all.
 *
 * The one number worth watching about `bays.py`: an end with no bay has no park
 * stage, so its cars wink in and out mid-lane at road speed -- the artefact the
 * park stages exist to remove. It is not zero and cannot be (a route end on a
 * motorway deck has no kerb within sixty metres and no lane spot free either),
 * but it going *up* means the arbitration is starving, which would be a
 * pipeline regression rather than a rendering one. Returns `[bayless, total]`.
 */
export function kerblessEndpoints(tile: TileLanes): [number, number] {
  let kerbless = 0;
  for (const r of tile.routes) {
    if (!r.bay0) kerbless++;
    if (!r.bay1) kerbless++;
  }
  return [kerbless, tile.routes.length * 2];
}

// --- The resident world --------------------------------------------------------

/** Broadphase cell, metres. See `TrafficField`. */
const CELL = 256;

/**
 * Insert into an array that is held in `compare` order.
 *
 * Exported, and imported by `game/pedestrians.ts` rather than copied, because
 * the pair below is the whole of what makes a lazily-loaded world answer the
 * same query as a whole one -- see `TrafficField`'s header on canonical order --
 * and two copies of a binary search that agree today is exactly the shape
 * `world/hexes.ts`' header refuses.
 *
 * `splice` rather than a linked list: a broadphase bucket holds a few dozen
 * entries, so the memmove is shorter than one cache line's worth of pointer
 * chasing and the array stays contiguous for the scan in `near`, which is the
 * 60 Hz path.
 */
export function insertSorted<T>(into: T[], item: T, compare: (a: T, b: T) => number): void {
  let lo = 0;
  let hi = into.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(into[mid], item) < 0) lo = mid + 1;
    else hi = mid;
  }
  into.splice(lo, 0, item);
}

/**
 * Take one specific object back out of such an array. True if it was there.
 *
 * **Identity inside the equal run, not the first comparator match.** The
 * comparators below are total on everything the decoder can emit, but "total"
 * is a claim about data rather than about types: two routes that agree on their
 * id, their bounds, their duration and their shape would compare equal, and
 * removing the wrong one of those would leave the grid holding a route whose
 * tile has been dropped. The run is length one in every real case, so this costs
 * one comparison.
 */
export function removeSorted<T>(from: T[], item: T, compare: (a: T, b: T) => number): boolean {
  let lo = 0;
  let hi = from.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(from[mid], item) < 0) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < from.length && compare(from[i], item) === 0; i++) {
    if (from[i] === item) {
      from.splice(i, 1);
      return true;
    }
  }
  return false;
}

/**
 * The canonical order of two routes. A pure function of what a route *is*.
 *
 * `rid` first, which is `lanes.py`'s hash of the route's own geometry and is
 * therefore the same number in every process and across every build that did
 * not move the street. The rest is a tie-break tail, and it is there because
 * `rid` is a 32-bit hash over 23,734 routes -- the birthday bound says a
 * collision is likelier than not somewhere in a 60 km build, and a collision
 * with no tail is an ordering that depends on which tile arrived first.
 *
 * `!==` before `<`, so the comparison never reads a NaN as "greater than
 * everything in both directions". The decoder cannot emit one -- `decodeLanes`
 * drops degenerate routes -- but an asymmetric comparator corrupts a binary
 * search silently rather than loudly.
 */
export function compareRoutes(a: LaneRoute, b: LaneRoute): number {
  if (a === b) return 0;
  if (a.rid !== b.rid) return a.rid < b.rid ? -1 : 1;
  if (a.minX !== b.minX) return a.minX < b.minX ? -1 : 1;
  if (a.minZ !== b.minZ) return a.minZ < b.minZ ? -1 : 1;
  if (a.maxX !== b.maxX) return a.maxX < b.maxX ? -1 : 1;
  if (a.maxZ !== b.maxZ) return a.maxZ < b.maxZ ? -1 : 1;
  if (a.count !== b.count) return a.count < b.count ? -1 : 1;
  if (a.duration !== b.duration) return a.duration < b.duration ? -1 : 1;
  if (a.headway !== b.headway) return a.headway < b.headway ? -1 : 1;
  if (a.phase !== b.phase) return a.phase < b.phase ? -1 : 1;
  if (a.klass !== b.klass) return a.klass < b.klass ? -1 : 1;
  return 0;
}

/**
 * Every lane sidecar currently loaded, indexed for "what is near this player".
 *
 * Adopt/drop by tile key, exactly as `game/powerups.ts`'s `PowerupField` is --
 * the client's streamer calls both as a tile arrives and leaves, and the server
 * now does the same, per hexagon, under `SYDNEY_LANES_CAP_MB`. See
 * `server/world.HexResidency`.
 *
 * The grid exists because the alternative is measurable: the server tests every
 * combatant against every car in Sydney every tick, and at 6,200 cars and 16
 * players that is 100,000 evaluations at 60 Hz. Bucketed, a player sees the
 * routes whose plan bounds overlap their own 3x3 cells -- a few dozen.
 *
 * ---------------------------------------------------------------------------
 * THE INDEX IS MAINTAINED PER TILE, AND ITS ORDER IS CANONICAL. Both halves of
 * that sentence are load-bearing and neither used to be true.
 *
 * **Per tile**, because this class used to set a dirty flag on adopt/drop and
 * rebuild `flat` and the whole bucket grid over *every* resident tile on the
 * next query. Measured on the shipped 19.3 km world, per single tile arriving
 * or leaving:
 *
 *   | resident tiles | traffic rebuild | pedestrian rebuild | total |
 *   |---------------:|----------------:|-------------------:|------:|
 *   | 3,017          |         3.30 ms |           11.12 ms | **14.42 ms** |
 *   |   754          |         0.82 ms |            2.75 ms |  3.57 ms |
 *
 * On the server that landed inside the tick on every hexagon crossing -- 14.4 ms
 * is 86% of a 60 Hz budget -- and it was the reason `server/world.ts` held the
 * lane graph whole while it held collision per hexagon. On the *client* it was
 * worse and had been there all along, because a browser streams tiles
 * continuously: every tile arrival paid the rebuild at whatever residency the
 * ring happened to be at, and a hexagon eviction paid it 374 times.
 *
 * **Canonical**, because the order `near` returns routes in *is a decision the
 * simulation makes*. `forEachCarNear` documents that the first car found wins
 * the hit test, and the buckets used to be filled in `Map` iteration order --
 * which is tile adoption order, which is `Promise.all` completion order on the
 * server and streaming order in a browser. Two processes with the identical
 * resident set could therefore pick different cars to knock the same player
 * over with. That was survivable while the server loaded every tile in one
 * `Promise.all` and nothing else ever changed; it is not survivable when a
 * hexagon can arrive, be evicted and arrive again in a different order. So the
 * buckets are held in `compareRoutes` order, which is a pure function of the
 * routes themselves, and the answer to any query is now a function of the
 * resident *set* rather than of the path taken to it.
 *
 * `flat` is the one thing still rebuilt whole, and it is deliberate: nothing on
 * a 60 Hz path reads it (`near` no longer touches it), its readers are the dev
 * handles and the checks, and sorting 23,734 routes on demand is cheaper in
 * code than a second incremental structure nobody queries.
 */
export class TrafficField {
  /**
   * Which cars a player has left standing in the road, and how far behind the
   * traffic behind them is. See `HoldLedger`.
   *
   * **On the field rather than passed to every query**, and that is the whole
   * reason the hold reaches every consumer: `forEachCarNear` is the one iterator
   * the box fleet, the model fleet, the knockdown test and the server all go
   * through, and it can only apply a rule it can reach. A parameter would have
   * meant editing four call sites and hoping a fifth never appeared.
   *
   * A fresh field's ledger is not live and costs one boolean per pose, which is
   * what makes a room where nobody has stolen a car pay nothing at all.
   */
  readonly held = new HoldLedger();

  private readonly tiles = new Map<string, TileLanes>();
  private flat: LaneRoute[] = [];
  private readonly grid = new Map<number, LaneRoute[]>();
  private flatDirty = true;

  adopt(tileKey: string, tile: TileLanes): void {
    // Re-adopting a key replaces it, which is what the old `Map.set` plus a
    // full rebuild did. Unindexed first, or the previous tile's routes stay in
    // the grid with nothing left holding a reference to take them out.
    const previous = this.tiles.get(tileKey);
    if (previous !== undefined) this.unindex(previous.routes);
    this.tiles.set(tileKey, tile);
    this.index(tile.routes);
    this.flatDirty = true;
  }

  drop(tileKey: string): void {
    const previous = this.tiles.get(tileKey);
    if (previous === undefined) return;
    this.tiles.delete(tileKey);
    this.unindex(previous.routes);
    this.flatDirty = true;
  }

  /** Is this tile's lane sidecar already held? The residency's accounting asks. */
  hasTile(tileKey: string): boolean {
    return this.tiles.has(tileKey);
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Every route in a resident tile, in canonical order. Do not hold across a drop. */
  routes(): readonly LaneRoute[] {
    if (this.flatDirty) {
      this.flatDirty = false;
      this.flat = [];
      for (const tile of this.tiles.values()) for (const route of tile.routes) this.flat.push(route);
      this.flat.sort(compareRoutes);
    }
    return this.flat;
  }

  /**
   * Every way in a resident tile -- the geometry block. Nothing here reads it.
   *
   * Tiles in sorted key order rather than in adoption order, for the same reason
   * the buckets are sorted: `checkPedestrians` builds a whole-city band set out
   * of this and compares it against another process's, and the client's
   * `world/nightlights.ts` lays lamps along it. Neither should depend on which
   * tile the network answered first.
   */
  ways(): LaneWay[] {
    const out: LaneWay[] = [];
    for (const key of [...this.tiles.keys()].sort()) {
      for (const way of this.tiles.get(key)!.ways) out.push(way);
    }
    return out;
  }

  /** How many cars are live across the resident set at this tick. Diagnostics only. */
  liveCars(tick: number): number {
    const now = trafficSeconds(tick);
    let n = 0;
    for (const r of this.routes()) n += liveSlots(r, now, SLOT_RANGE);
    return n;
  }

  /**
   * Routes whose plan bounds reach within `radius` of a point.
   *
   * Appends into `out` and returns it, so a caller in a 60 Hz loop allocates
   * nothing. The bounds test is deliberately loose -- a route's box is up to
   * 800 m on a side and a diagonal one claims ground it never touches -- because
   * the cost of a false positive is one `poseCar` and the cost of a false
   * negative is a car that goes through you without knocking you over.
   */
  near(x: number, z: number, radius: number, out: LaneRoute[]): LaneRoute[] {
    out.length = 0;
    const c0 = Math.floor((x - radius) / CELL);
    const c1 = Math.floor((x + radius) / CELL);
    const r0 = Math.floor((z - radius) / CELL);
    const r1 = Math.floor((z + radius) / CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const bucket = this.grid.get(cellKey(cx, cz));
        if (bucket === undefined) continue;
        for (const route of bucket) {
          if (
            route.maxX < x - radius || route.minX > x + radius ||
            route.maxZ < z - radius || route.minZ > z + radius
          ) continue;
          // A route spans several cells, so the same one arrives from more than
          // one bucket. Deduped by scanning `out`, which is a handful of entries
          // -- a Set here would allocate every frame for a list this short.
          if (out.indexOf(route) < 0) out.push(route);
        }
      }
    }
    return out;
  }

  /** One tile's routes into the grid, each in its bucket's canonical place. */
  private index(routes: readonly LaneRoute[]): void {
    for (const route of routes) {
      const c0 = Math.floor(route.minX / CELL);
      const c1 = Math.floor(route.maxX / CELL);
      const r0 = Math.floor(route.minZ / CELL);
      const r1 = Math.floor(route.maxZ / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const key = cellKey(cx, cz);
          const bucket = this.grid.get(key);
          if (bucket === undefined) this.grid.set(key, [route]);
          else insertSorted(bucket, route, compareRoutes);
        }
      }
    }
  }

  /**
   * And back out again. The cells are recomputed rather than remembered.
   *
   * A route's plan bounds are frozen at decode, so the cell span this walks is
   * bit-identical to the one `index` walked -- the same three `Math.floor`s over
   * the same four numbers. Remembering them instead would be four more integers
   * per route (95 kB on this world, 760 kB at 60 km) to avoid twelve
   * instructions.
   *
   * Empty buckets are deleted rather than left behind. `near` skips a missing
   * bucket and an empty one identically, so this is only about a `Map` that
   * would otherwise grow one entry per cell the world has ever had a car in and
   * never shrink -- which for a browser walking across Sydney is the whole city.
   */
  private unindex(routes: readonly LaneRoute[]): void {
    for (const route of routes) {
      const c0 = Math.floor(route.minX / CELL);
      const c1 = Math.floor(route.maxX / CELL);
      const r0 = Math.floor(route.minZ / CELL);
      const r1 = Math.floor(route.maxZ / CELL);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const key = cellKey(cx, cz);
          const bucket = this.grid.get(key);
          if (bucket === undefined) continue;
          removeSorted(bucket, route, compareRoutes);
          if (bucket.length === 0) this.grid.delete(key);
        }
      }
    }
  }

  /** How many broadphase cells are occupied. Diagnostics, and the leak check. */
  get cellCount(): number {
    return this.grid.size;
  }
}

/** Two signed cell indices in one integer key. +/-16,384 cells is +/-4,194 km. */
function cellKey(cx: number, cz: number): number {
  return ((cx + 0x4000) << 15) | ((cz + 0x4000) & 0x7fff);
}

// --- Evaluating a car ----------------------------------------------------------

/**
 * The integer hash every per-car choice comes out of.
 *
 * `Math.imul`, xor and unsigned shift, which are exact 32-bit integer operations
 * on every engine -- `game/footy.ts`'s `bounceHash` makes the same argument and
 * this is deliberately the same shape. A float PRNG would need state, and state
 * is the thing this whole module does not have.
 */
export function carHash(a: number, b: number): number {
  let h = 0x811c9dc5;
  h ^= Math.imul(a | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= Math.imul(b | 0, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

function unit(h: number): number {
  return h / 4294967296;
}

/**
 * Which car slot `slot` of this route is, without posing it.
 *
 * The same number `poseCar` writes into `CarPose.identity`, exported so that
 * anything holding a route and a slot -- a model table, a check, a dev handle
 * -- can name a car without evaluating where it is. One line, and it exists so
 * that there is exactly one definition of a schedule car's identity rather than
 * two that agree today.
 */
export function identityOf(route: LaneRoute, slot: number): number {
  return carHash(route.rid, slot);
}

/**
 * Who a parked car is, as a stable well-distributed 32-bit number.
 *
 * The static half of `CarPose.identity`, with the same three jobs: never
 * changes for a given car, is the same number in every process, and survives a
 * rebuild. The two spaces are deliberately *not* disjoint -- a schedule car and
 * a parked car that happen to hash alike simply get the same model, which is a
 * coincidence and not a bug.
 *
 * **The tile key and the index, and nothing else.** Not the `seed` byte pair
 * that already travels in `.cars.bin`, which looks like the obvious choice:
 * `seed` is `hash & 0xFFFF` from `parking._place`, so over the 414,939 cars in
 * the extent it collides six times over on average and a model table keyed off
 * it would put the same car all over Sydney. Not the position either, which is
 * a float and moves whenever a road is retagged. The tile key is the world's
 * own address for a patch of ground and the index is the car's order within it,
 * which `parking.instances` fixes by sorting on easting before anything greedy
 * runs -- so this is stable across a rebuild that does not change the street.
 *
 * The key is folded a character at a time rather than parsed into two integers,
 * because the tile key's shape (`-3_11`) is `tiles.py`'s business and a parser
 * here would be a second place that has to know it.
 *
 * **It lives in this file rather than in `world/cars.ts`**, which re-exports it
 * and is where a reader will look. That module imports three, so the Bun server
 * and `integration-check.ts` can never load it -- and an identity nothing
 * headless can evaluate is an identity no check can assert is stable.
 */
export function staticCarIdentity(tileKey: string, index: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < tileKey.length; i++) {
    h ^= Math.imul(tileKey.charCodeAt(i) | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  // A different mixing constant from `carHash`'s, so the two identity streams
  // are independent rather than two views of one sequence.
  h ^= Math.imul(index | 0, 0x9e3779b1) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  return (h ^ (h >>> 13)) >>> 0;
}

/** Scratch for `liveSlots`, so the range query allocates nothing. */
interface SlotRange { first: number; last: number }
const SLOT_RANGE: SlotRange = { first: 0, last: -1 };

/**
 * Which departures of a route exist right now, parked ones included.
 *
 * Slot `k` departs at `phase + k * headway`, but its *life* starts up to
 * `dwellCap` earlier -- sitting in the near bay -- and ends `dwellCap` after it
 * arrives. Both bounds are floors of a division, which is exact arithmetic, so
 * the client and the server agree on the *set* of cars as well as on where each
 * one is.
 *
 * The range is a superset: `dwellCap` is the ceiling on a dwell and each car
 * draws its own shorter one out of the hash, so `poseCar` still has the last
 * word about whether a slot is live. That split is deliberate -- a per-slot
 * bound would mean hashing every candidate twice, once to find the range and
 * again to place it.
 */
function liveSlots(route: LaneRoute, now: number, range: SlotRange): number {
  const since = now - route.phase;
  const last = Math.floor((since + route.dwellCap) / route.headway);
  const first = Math.floor((since - route.duration - route.dwellCap) / route.headway) + 1;
  range.first = first;
  range.last = last;
  return last >= first ? last - first + 1 : 0;
}

/**
 * How long this car sits in one of its two bays, seconds.
 *
 * `which` is 0 for the bay it departs from and 1 for the bay it arrives in, and
 * they are separate draws so a car does not wait the same time at both ends --
 * and they are capped separately too, by `dwellCap0` and `dwellCap1`, because
 * the two bays are held for different lengths of time. See `PARK_BAY_GAP`,
 * which is the constraint that keeps one bay to one car.
 */
function parkDwell(route: LaneRoute, h: number, which: number): number {
  const cap = which === 0 ? route.dwellCap0 : route.dwellCap1;
  if (!(cap > 0)) return 0;
  const d = PARK_DWELL_MIN + (PARK_DWELL_MAX - PARK_DWELL_MIN) * unit(carHash(h, 0x50a1 + which));
  return d < cap ? d : cap;
}

/**
 * Where car `slot` of `route` is at `now` seconds, and what it looks like.
 *
 * Returns false when that slot is not on the road, which is how the caller
 * iterates: ask for the live range, then pose each one.
 *
 * The binary search is over `t`, which the pipeline guarantees is strictly
 * increasing -- see `lanes._dedupe` for the f32 argument behind that guarantee,
 * because a repeated timestamp here is a divide by zero.
 */
export function poseCar(route: LaneRoute, slot: number, now: number, out: CarPose): boolean {
  const age = now - route.phase - slot * route.headway;
  // Identity first, because the dwells are drawn out of it and the live test
  // needs them. A pure function of (route, slot), so every process that
  // evaluates this car agrees about what it is without a byte on the wire.
  const h = carHash(route.rid, slot);
  const dwellIn = parkDwell(route, h, 0);
  const dwellOut = parkDwell(route, h, 1);
  if (age < -dwellIn || age >= route.duration + dwellOut) return false;

  // --- The five stages, as three numbers.
  //
  // `driveT` is the route-time to display, `lateral` is how much of the kerb
  // shift is still applied (1 parked, 0 in the lane) and `rate` is
  // `d(driveT)/d(age)`, which is what turns the timetable's own speed into this
  // car's speed. See `buildParkPhases` for where the cubics come from.
  let driveT: number;
  let lateral: number;
  let rate: number;
  let offX: number;
  let offZ: number;
  let stage: number;
  if (age < 0) {
    stage = CAR_STAGE_PARKED_IN;
    driveT = route.parkT0;
    lateral = 1;
    rate = 0;
    offX = route.kerbOffX0;
    offZ = route.kerbOffZ0;
  } else if (age < route.outT) {
    stage = CAR_STAGE_PULL_OUT;
    const s = age / route.outT;
    const w = (route.outA * s + route.outB) * s * s;
    driveT = route.parkT0 + route.outSpan * w;
    const rest = 1 - w;
    lateral = rest * rest;
    rate = (route.outSpan / route.outT) * s * (3 * route.outA * s + 2 * route.outB);
    offX = route.kerbOffX0;
    offZ = route.kerbOffZ0;
  } else if (age < route.inT) {
    stage = CAR_STAGE_DRIVING;
    driveT = age;
    lateral = 0;
    rate = 1;
    offX = 0;
    offZ = 0;
  } else if (age < route.duration) {
    stage = CAR_STAGE_PULL_IN;
    const s = (age - route.inT) / route.inLen;
    const v = ((route.inA * s + route.inB) * s + route.inC) * s;
    driveT = route.inT + route.inSpan * v;
    lateral = v * v;
    rate = (route.inSpan / route.inLen) * (3 * route.inA * s * s + 2 * route.inB * s + route.inC);
    offX = route.kerbOffX1;
    offZ = route.kerbOffZ1;
  } else {
    stage = CAR_STAGE_PARKED_OUT;
    driveT = route.parkT1;
    lateral = 1;
    rate = 0;
    offX = route.kerbOffX1;
    offZ = route.kerbOffZ1;
  }

  const t = route.t;
  let lo = 0;
  let hi = route.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= driveT) lo = mid;
    else hi = mid;
  }
  const span = t[lo + 1] - t[lo];
  const u = span > 0 ? (driveT - t[lo]) / span : 0;

  const x0 = route.x[lo];
  const z0 = route.z[lo];
  const x1 = route.x[lo + 1];
  const z1 = route.z[lo + 1];
  out.route = route.rid;
  out.slot = slot;
  // A schedule car is never dented and is never held **by this function**: the
  // hold is applied one layer out, by `forEachCarNear`, because it needs the
  // driven roster and this function is a pure lookup over the sidecar. Cleared
  // here rather than left, because the pose object is reused and the last car it
  // described may well have been a wreck queued behind somebody's Camry.
  out.damage = 0;
  out.held = 0;
  // Who this is. `h` and not a fresh hash of it: every other per-car choice
  // below is drawn from this same number, so a consumer keying a 3D model off
  // the identity is keying off the same draw the body type came from -- and a
  // car whose identity changed between two stages of its own life would be a
  // car that changed model mid-street. See `CarPose.identity`.
  out.identity = h;
  out.x = x0 + u * (x1 - x0);
  out.y = route.y[lo] + u * (route.y[lo + 1] - route.y[lo]);
  out.z = z0 + u * (z1 - z0);
  out.stage = stage;
  out.routeT = driveT;

  // The heading. A red light is two copies of one vertex, so the segment the car
  // is sitting on has no direction at all -- walk out to the nearest one that
  // does, forward first and then back, which is the direction the car is about
  // to travel in and the one it arrived on. Never `Math.hypot`, which is
  // implementation-defined; `Math.sqrt` is exact.
  let hx = x1 - x0;
  let hz = z1 - z0;
  const seg2 = hx * hx + hz * hz;
  let d2 = seg2;
  let inv = 0;
  for (let step = lo + 1; d2 < 1e-12 && step < route.count - 1; step++) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  for (let step = lo - 1; d2 < 1e-12 && step >= 0; step--) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  if (d2 < 1e-12) {
    out.dx = 0;
    out.dz = 1;
  } else {
    inv = 1 / Math.sqrt(d2);
    out.dx = hx * inv;
    out.dz = hz * inv;
  }

  // How fast, and **no second root for it**. The walk above only ever runs when
  // this segment has no length at all -- a red-light dwell -- and in every other
  // case `d2` is still this segment's own squared length and `inv` is exactly
  // its reciprocal root, so `seg2 * inv` is the segment length for free. Where
  // the walk did run the car is standing at a light and the answer is zero,
  // which is also what `rate` says in both parked stages.
  out.speed = seg2 >= 1e-12 && span > 0 ? (seg2 * inv / span) * rate : 0;

  // Out to the kerb, along the vector `buildParkPhases` froze at the bay --
  // **not** along this instant's heading, which turns corners and would jerk the
  // car sideways at every vertex a ramp happens to cross. Skipped entirely while
  // driving, which is every car in the city bar the handful on a ramp.
  if (lateral > 0) {
    out.x += offX * lateral;
    out.z += offZ * lateral;
  }

  const pick = unit(h);
  let body = BODY_MIX.length - 1;
  for (let i = 0; i < BODY_MIX.length; i++) {
    if (pick < BODY_MIX[i]) { body = i; break; }
  }
  const paint = unit(carHash(h, 0x9e37));
  let colour = PAINT_MIX.length - 1;
  for (let i = 0; i < PAINT_MIX.length; i++) {
    if (paint < PAINT_MIX[i]) { colour = i; break; }
  }
  const scale = 0.96 + 0.08 * unit(carHash(h, 0x2545));
  const size = CAR_BODY_SIZE[body];
  out.body = body;
  out.colour = colour;
  out.scale = scale;
  out.halfLength = size.length * 0.5 * scale + HIT_MARGIN;
  out.halfWidth = size.width * 0.5 * scale + HIT_MARGIN;
  out.height = size.height * scale;
  return true;
}

/**
 * Every live car within `radius` of a point, at `tick`.
 *
 * The one iteration order in this module, and it is fixed rather than incidental
 * -- `near` returns routes in bucket order and slots ascend within a route -- so
 * two processes walking the same resident set visit the same cars in the same
 * order. That matters for the hit test, where the *first* car found wins.
 */
export function forEachCarNear(
  field: TrafficField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
  visit: (pose: CarPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const range: SlotRange = { first: 0, last: -1 };
  const held = field.held;
  for (const route of field.near(x, z, radius, scratch)) {
    liveSlots(route, now, range);
    for (let slot = range.first; slot <= range.last; slot++) {
      if (!poseCar(route, slot, now, pose)) continue;
      // **The queue behind a car somebody left in the lane, applied here and
      // nowhere else.** See `resolveHeld`: putting it inside the one iterator
      // every consumer already goes through is the whole of how the box fleet,
      // the model fleet, the knockdown test and the server get *one* answer
      // rather than four that have to agree. The radius test below runs on the
      // held position, which is the position the car is actually at.
      if (held.live) resolveHeld(pose, held, tick);
      const dx = pose.x - x;
      const dz = pose.z - z;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (visit(pose) === true) return;
    }
  }
}

// --- Yielding to a car somebody left in the lane --------------------------------

/**
 * How far behind a blocker a held car stands, centre to centre, metres.
 *
 * The brief's 6, and it is centre-to-centre rather than bumper-to-bumper because
 * that is the number this file can state without knowing which of five bodies
 * either car is. Two sedans at 4.6 m leave 1.4 m of gap, which is a car stopped
 * behind another car; a van behind a van leaves 0.6 m, which is a car stopped
 * behind another car in Surry Hills.
 */
export const HOLD_GAP = 6;

/**
 * How far to either side of its own route a car looks for a blocker, metres.
 *
 * A lane is 3.5 m and a car is 1.9 m at its widest, so 2.6 m of half-width is
 * "in my lane, or far enough into it to matter" and excludes the oncoming lane
 * -- which is the case this number exists for. Sydney's lanes are 3.5 m centres
 * apart, so a car parked in the opposing lane sits at 3.5 m of lateral offset
 * and is correctly ignored: traffic does not queue behind a car on the other
 * side of the road.
 */
const HOLD_LANE_HALF = 2.6;

/**
 * How far *past* a blocker a car may be and still count as inside it, metres.
 *
 * The brief's "(or inside)". Half of the longest body plus a little: a car whose
 * centre is within this of the blocker's centre is interpenetrating it, and the
 * answer to interpenetration is to put the car behind, not to let it carry on
 * through.
 */
const HOLD_INSIDE = 3;

/**
 * The most a car will fall behind its timetable before the hold gives up,
 * metres.
 *
 * **A ceiling and not a tuning knob**, and it is the one place this feature
 * lies. A held car's timetable keeps running while the car stands still, so the
 * lag grows at the class speed for as long as the blocker is there -- a car left
 * in Broadway overnight would otherwise hold the 8 a.m. traffic 400 km behind
 * schedule, and every car on the route would be stacked in one three-metre box
 * because this rule only knows about *driven* blockers and not about the queue
 * it is building.
 *
 * Past this the hold is abandoned and the car resumes its timetable -- which
 * means it drives through the wreck, exactly as every car in this city did
 * before this rule existed. That is a much smaller lie than five cars in one
 * parking space, and it is bounded: at a residential 12.5 m/s a blocker holds
 * the car behind it for 2.4 s and then the street goes back to being a street.
 */
const HOLD_MAX_LAG = 30;

/**
 * The fastest a car closes the gap on its own timetable, m/s, on top of the
 * schedule speed it is already doing.
 *
 * Bounded twice, and the second bound is the brief's: `min(this, 0.5 x the
 * car's current schedule speed)`, so a recovering car's ground speed is at most
 * 1.5x what its class allows and a car stopped at a red does not catch up at
 * all -- it is stopped. The absolute cap is what stops a motorway car making up
 * 30 m in a second and a half, which reads as a teleport with extra steps.
 */
const HOLD_CATCH_UP = 4;

/**
 * How many identities the ledger remembers, and how stale an entry may be.
 *
 * Bounded because the alternative is a map keyed on every car that has ever
 * queued behind anything in a session -- `world/drivencars.ts`' `lastSpeed` map
 * makes the same argument in the same words. 5 s is twenty times the interval
 * between two evaluations of the same car at the worst frame rate this client
 * tolerates, so nothing live is ever evicted.
 */
const HOLD_LEDGER_MAX = 256;
const HOLD_EVICT_TICKS = 300;

/** One car's place in the queue. See `HoldLedger`. */
interface HoldEntry {
  /** Metres behind the timetable, as measured at `atTick`. */
  lag: number;
  /** The tick `lag` was measured at. The catch-up is a closed form from here. */
  atTick: number;
  /** The last tick this identity was looked at, for eviction. */
  seen: number;
}

/** What `resolveHeld` needs to know about a car somebody is driving or has left. */
export interface HoldBlocker {
  x: number;
  y: number;
  z: number;
  /** Half the body's length, metres. The caller has `CAR_BODY_SIZE`; this file will not guess. */
  halfLength: number;
}

/**
 * Grid cell for the blocker index, metres. See `HoldLedger.forEachBlocker`.
 *
 * 32 m rather than the route grid's 256, because the query radius is a car
 * length plus the gap and not a route's plan bounds: a 32 m cell means the
 * two-by-two block a query touches is almost always empty, which is the whole
 * cost of this feature for the 99.9 % of Sydney nobody has left a car in.
 */
const HOLD_CELL = 32;

/**
 * How far from a pose a blocker can be and still hold it, metres.
 *
 * The gap, plus the longest body, plus slack. **Much tighter than the brief's
 * 120 m spatial gate**, and deliberately: 120 m is a budget ("no car further
 * than this is ever tested") and this is the geometry ("no car further than this
 * can possibly matter"). A gate that is stricter than the budget satisfies the
 * budget.
 */
const HOLD_QUERY = 14;

/**
 * Which cars are standing in the road, and how far behind them everybody is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STATE IN A FILE WHOSE WHOLE ARGUMENT IS THAT IT HAS NONE.
 *
 * The header of this file says a car is a lookup and that nothing here is
 * stepped, and that is still true of `poseCar`: the timetable is untouched. What
 * this class holds is the *difference* between the timetable and where the car
 * has been forced to stand, and there is no closed form for it -- how far behind
 * a car is depends on how long the thing in front of it has been there, which is
 * a fact about a player's Camry and not about the sidecar.
 *
 * So the state is admitted rather than smuggled, and it is made to obey the
 * determinism rule the rest of the file obeys, by three properties:
 *
 *   1. **Its inputs are on the wire.** The blockers are `MSG.CARS` records,
 *      which both ends hold identically (`driving.CarField`), and the tick is
 *      the shared traffic clock. Two processes handed the same roster at the
 *      same tick compute the same hold.
 *   2. **The recovery is a closed form.** An entry stores the lag and the tick
 *      it was measured at, and the catch-up is `lag - rate x elapsed` evaluated
 *      fresh -- not an integration, which would depend on how often it was
 *      sampled. The client draws at 144 Hz and the server steps at 60 and they
 *      agree to the tick.
 *   3. **It is bounded and self-healing.** `HOLD_MAX_LAG` caps how wrong it can
 *      get and `HOLD_EVICT_TICKS` throws away anything nobody has asked about,
 *      so a divergence -- a client that dropped frames through the moment a
 *      blocker appeared -- is a fraction of a metre and is gone within seconds.
 *
 * `live` is the whole of the cost for a room where nobody has taken a car: one
 * boolean compared once per pose. `world/cars.TrafficMovers.suppress` is null
 * for the same reason and states it in the same words.
 */
export class HoldLedger {
  /** False when nobody has left a car anywhere. One comparison per pose. */
  live = false;

  private readonly grid = new Map<number, HoldBlocker[]>();
  private readonly entries = new Map<number, HoldEntry>();

  /**
   * Replace the roster of things traffic yields to.
   *
   * Called once a tick on the server and once a frame on the client, from the
   * same `CarField.all()`. A rebuild rather than a diff because the set is at
   * most `driving.MAX_DRIVEN_CARS` and a diff over 400 entries costs more than
   * clearing a map that is usually empty.
   */
  setBlockers(cars: Iterable<HoldBlocker>): void {
    this.grid.clear();
    let any = false;
    for (const car of cars) {
      any = true;
      const key = holdCell(car.x, car.z);
      const bucket = this.grid.get(key);
      if (bucket === undefined) this.grid.set(key, [car]);
      else bucket.push(car);
    }
    if (!any) {
      // Nobody has a car out. The ledger is cleared as well as the grid, because
      // an entry left behind would go on holding a car behind a blocker that no
      // longer exists until it aged out five seconds later.
      this.entries.clear();
    }
    this.live = any;
  }

  /** Every blocker whose cell could reach `(x, z)`. Allocation-free. */
  forEachBlocker(x: number, z: number, visit: (b: HoldBlocker) => void): void {
    const c0 = Math.floor((x - HOLD_QUERY) / HOLD_CELL);
    const c1 = Math.floor((x + HOLD_QUERY) / HOLD_CELL);
    const r0 = Math.floor((z - HOLD_QUERY) / HOLD_CELL);
    const r1 = Math.floor((z + HOLD_QUERY) / HOLD_CELL);
    for (let cx = c0; cx <= c1; cx++) {
      for (let cz = r0; cz <= r1; cz++) {
        const bucket = this.grid.get(cellKey(cx, cz));
        if (bucket === undefined) continue;
        for (const b of bucket) visit(b);
      }
    }
  }

  /** This identity's lag, or 0. Read by `resolveHeld` and by the checks. */
  lagOf(identity: number, tick: number, speed: number): number {
    const entry = this.entries.get(identity);
    if (entry === undefined) return 0;
    // The closed form. See the class header, property 2: the rate is read fresh
    // off the car's *current* schedule speed, which is itself a pure function of
    // the tick, so two processes at the same tick get the same number without
    // either having integrated anything.
    const rate = Math.min(HOLD_CATCH_UP, 0.5 * (speed > 0 ? speed : 0));
    const lag = entry.lag - rate * ((tick - entry.atTick) / TRAFFIC_HZ);
    return lag > 0 ? lag : 0;
  }

  /** Write a measured lag back. `resolveHeld`'s only mutation. */
  record(identity: number, lag: number, tick: number): void {
    let entry = this.entries.get(identity);
    if (entry === undefined) {
      entry = { lag, atTick: tick, seen: tick };
      this.entries.set(identity, entry);
      if (this.entries.size > HOLD_LEDGER_MAX) this.evict(tick);
      return;
    }
    entry.lag = lag;
    entry.atTick = tick;
    entry.seen = tick;
  }

  /** This identity has caught up, or was never behind. */
  forget(identity: number): void {
    this.entries.delete(identity);
  }

  /** Note that this identity is still being looked at, so eviction leaves it alone. */
  touch(identity: number, tick: number): void {
    const entry = this.entries.get(identity);
    if (entry !== undefined) entry.seen = tick;
  }

  /** How many cars are queued. The dev overlay, and `verifyTraffic`. */
  get size(): number {
    return this.entries.size;
  }

  /** Empty it. A respawn of the room, and the self-checks. */
  clear(): void {
    this.grid.clear();
    this.entries.clear();
    this.live = false;
  }

  private evict(tick: number): void {
    for (const [identity, entry] of this.entries) {
      // `Math.abs`, because a client whose clock went backwards across a
      // resynchronisation would otherwise have every entry look fresh forever.
      if (Math.abs(tick - entry.seen) > HOLD_EVICT_TICKS) this.entries.delete(identity);
    }
  }
}

/** Two signed cell indices for the blocker grid. `cellKey`'s packing at a different size. */
function holdCell(x: number, z: number): number {
  return cellKey(Math.floor(x / HOLD_CELL), Math.floor(z / HOLD_CELL));
}

/**
 * Hold this car behind whatever a player has left in its lane, and move it back
 * up to its timetable once the lane is clear. Returns the lag applied, metres.
 *
 * **Mutates the pose in place**, which is the contract every other function that
 * touches a `CarPose` in this file has, and is what lets `forEachCarNear` apply
 * it to every consumer at once.
 *
 * The shift is along the car's own **heading** rather than back along its route
 * polyline, and that is an approximation with a stated error. Doing it properly
 * would mean inverting the timetable -- finding the route-time whose arc length
 * is `lag` metres earlier -- which is a second binary search per car per frame
 * for a car that is, by definition, stopped. Over the ten metres this rule ever
 * moves anything, a straight shift leaves the car off the arc by
 * `lag^2 / (2 x radius)`: 12 cm on a 400 m main-road bend and 60 cm on the
 * tightest corner in the CBD, on a car standing still in a queue. The visible
 * failure of the exact version -- a queue that curves round a corner correctly
 * while costing twice as much -- is not one anybody has ever asked for.
 *
 * A held car's `speed` is set to zero, which is not cosmetic: `carHitStrength`
 * reads it, and a car that has been stopped by the traffic in front of it must
 * not knock over the pedestrian who walks in front of it. A car *catching up*
 * keeps its schedule speed, because it really is moving.
 */
export function resolveHeld(pose: CarPose, ledger: HoldLedger, tick: number): number {
  // Where the car is *now*, which is its timetable position less whatever it was
  // already behind. The blocker test runs from here rather than from the
  // schedule position, because the thing that can be blocked is the car, and the
  // car is where the last hold left it.
  let lag = ledger.lagOf(pose.identity, tick, pose.speed);
  if (lag > 0) {
    pose.x -= pose.dx * lag;
    pose.z -= pose.dz * lag;
  }

  // The nearest thing in this car's own lane, ahead of it or inside it. The
  // *nearest* rather than the first, because two cars abandoned nose to tail is
  // a thing a player will absolutely do and queueing behind the far one would
  // park this car inside the near one.
  let closest = Infinity;
  ledger.forEachBlocker(pose.x, pose.z, (b) => {
    const rx = b.x - pose.x;
    const rz = b.z - pose.z;
    const ahead = rx * pose.dx + rz * pose.dz;
    if (ahead > HOLD_GAP || ahead < -HOLD_INSIDE) return;
    // Left of a heading (dx, dz) is (dz, -dx), the same axes `carOverlaps` and
    // `lanes.py` use. This is what keeps a car from queueing behind something
    // abandoned in the *oncoming* lane 3.5 m away.
    const across = rx * pose.dz - rz * pose.dx;
    if (across > HOLD_LANE_HALF || across < -HOLD_LANE_HALF) return;
    // The vertical gate, `carOverlaps`' own and for its reason: a car abandoned
    // on the Cahill Expressway does not stop the traffic on Alfred Street eight
    // metres below it.
    const dy = b.y - pose.y;
    if (dy > TAKE_HEIGHT_GATE || dy < -TAKE_HEIGHT_GATE) return;
    if (ahead < closest) closest = ahead;
  });

  if (closest !== Infinity) {
    const extra = HOLD_GAP - closest;
    const wanted = lag + extra;
    if (wanted >= HOLD_MAX_LAG) {
      // The ceiling. See `HOLD_MAX_LAG`: the hold is abandoned rather than
      // clamped, so the car resumes its timetable and drives through, which is
      // what every car in this city did before this rule existed.
      ledger.forget(pose.identity);
      pose.x += pose.dx * lag;
      pose.z += pose.dz * lag;
      pose.held = 0;
      return 0;
    }
    pose.x -= pose.dx * extra;
    pose.z -= pose.dz * extra;
    lag = wanted;
    ledger.record(pose.identity, lag, tick);
    // Stopped, and therefore harmless. See the header.
    pose.speed = 0;
    pose.held = lag;
    return lag;
  }

  if (lag <= 0) {
    // Nothing in the way and nothing owed. The common case for every car in
    // Sydney, and it costs one map lookup and four `Math.floor`s.
    ledger.forget(pose.identity);
    pose.held = 0;
    return 0;
  }
  ledger.touch(pose.identity, tick);
  pose.held = lag;
  return lag;
}

/**
 * `TAKE_HEIGHT` from `game/driving.ts`, which this file may not import.
 *
 * Two and a half metres of vertical tolerance is "the same piece of road" for
 * every purpose this project has -- taking a car, being run over by one, and now
 * queueing behind one -- and the number is repeated rather than shared because
 * `driving.ts` imports this file and not the other way round. `verifyDriving`
 * asserts the two agree.
 */
const TAKE_HEIGHT_GATE = 2.5;

// --- The kerb bays, as a query ----------------------------------------------------

/** Where a kerb bay is and which way a car parked in it points. `nearestBay` fills one. */
export interface BayPose {
  x: number;
  y: number;
  z: number;
  /** Unit heading, the same convention `CarPose` uses. */
  dx: number;
  dz: number;
}

export function createBayPose(): BayPose {
  return { x: 0, y: 0, z: 0, dx: 0, dz: 1 };
}

/**
 * The nearest kerb bay to a point, or false.
 *
 * The bays are the ones `pipeline/sydney/bays.py` arbitrated and baked into the
 * sidecar -- see `LANES_VERSION` -- so this is a *lookup of an existing ledger*
 * rather than a new opinion about where a car may park. That matters: the whole
 * v2 contract is that one bay holds one car, and a function that invented a
 * parking spot near a kerb would put a player's abandoned Camry on top of one of
 * the 23,020 static cars.
 *
 * What it is for is the moment a driver gets out: a car left within reach of a
 * bay is snapped into it, so it reads as *parked* rather than as abandoned at a
 * slight angle a metre out from the gutter. See `driving.ts` and the brief's
 * second clause.
 *
 * Ties break on `(rid, which)` rather than on the float distance, which is
 * `resolveTake`'s rule and is here for its reason: the server snaps the car and
 * the client is told about it, but `?offline` runs this in the browser and the
 * two builds must not disagree about which of two equidistant bays won.
 */
export function nearestBay(
  field: TrafficField,
  x: number,
  z: number,
  radius: number,
  scratch: LaneRoute[],
  out: BayPose,
): boolean {
  let bestD2 = radius * radius;
  let bestKey = 0;
  let found = false;
  const probe = _bayProbe;
  for (const route of field.near(x, z, radius, scratch)) {
    for (let which = 0; which < 2; which++) {
      if (which === 0 ? !route.bay0 : !route.bay1) continue;
      bayPose(route, which, probe);
      const dx = probe.x - x;
      const dz = probe.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD2) continue;
      const key = route.rid * 2 + which;
      if (found && (d2 > bestD2 || (d2 === bestD2 && key >= bestKey))) continue;
      found = true;
      bestD2 = d2;
      bestKey = key;
      out.x = probe.x;
      out.y = probe.y;
      out.z = probe.z;
      out.dx = probe.dx;
      out.dz = probe.dz;
    }
  }
  return found;
}

/** Scratch for `nearestBay`, so a query in a tick loop allocates nothing. */
const _bayProbe: BayPose = createBayPose();

/**
 * Where one end of a route's bay is, in world metres.
 *
 * The lane point at the route-time the car rests at, plus the kerb offset vector
 * the pipeline measured *at the bay* -- which is exactly what `poseCar` composes
 * in its two parked stages, and is deliberately the same arithmetic rather than
 * a second opinion about it. A bay this function disagreed with `poseCar` about
 * would be a player's car snapped to a spot the ambient fleet then parks on top
 * of.
 */
export function bayPose(route: LaneRoute, which: number, out: BayPose): BayPose {
  const t = which === 0 ? route.parkT0 : route.parkT1;
  let lo = 0;
  let hi = route.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route.t[mid] <= t) lo = mid;
    else hi = mid;
  }
  const span = route.t[lo + 1] - route.t[lo];
  const u = span > 0 ? (t - route.t[lo]) / span : 0;
  const x0 = route.x[lo];
  const z0 = route.z[lo];
  const x1 = route.x[lo + 1];
  const z1 = route.z[lo + 1];
  out.x = x0 + u * (x1 - x0) + (which === 0 ? route.kerbOffX0 : route.kerbOffX1);
  out.y = route.y[lo] + u * (route.y[lo + 1] - route.y[lo]);
  out.z = z0 + u * (z1 - z0) + (which === 0 ? route.kerbOffZ0 : route.kerbOffZ1);
  // The heading, on `poseCar`'s own walk: a parked bay very often sits on a
  // zero-length segment (the dwell is two copies of one vertex), so the
  // direction has to be taken from the nearest segment that has one.
  let hx = x1 - x0;
  let hz = z1 - z0;
  let d2 = hx * hx + hz * hz;
  for (let step = lo + 1; d2 < 1e-12 && step < route.count - 1; step++) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  for (let step = lo - 1; d2 < 1e-12 && step >= 0; step--) {
    hx = route.x[step + 1] - route.x[step];
    hz = route.z[step + 1] - route.z[step];
    d2 = hx * hx + hz * hz;
  }
  if (d2 < 1e-12) {
    out.dx = 0;
    out.dz = 1;
  } else {
    const inv = 1 / Math.sqrt(d2);
    out.dx = hx * inv;
    out.dz = hz * inv;
  }
  return out;
}

// --- Being run over ------------------------------------------------------------

/**
 * How far from a player a car has to be to be worth testing, metres.
 *
 * The longest car is 5.4 m and the widest hit box half-diagonal is under 3 m, so
 * anything past this cannot reach the capsule. Kept as one number rather than
 * derived per body because it is the *broadphase* radius and a broadphase that
 * changes size per candidate is not a broadphase.
 */
export const HIT_QUERY_RADIUS = 6;

/**
 * Is this car on top of this combatant?
 *
 * The car is an oriented box and the player is their collision capsule, tested
 * as a box in plan -- generous by a few centimetres at the corners, which is the
 * direction this error has to fall. A car that visibly passes through somebody
 * without touching them is the version of this mistake players notice, and it is
 * the same call `combat.REACH` makes about the bat.
 *
 * The vertical test is what stops a car on the Cahill Expressway knocking over
 * somebody standing on Alfred Street underneath it -- the two are eight metres
 * apart and directly above one another, and without this the whole viaduct is a
 * moving hazard on the street below.
 */
export function carOverlaps(pose: CarPose, c: CombatantState): boolean {
  const feet = feetY(c);
  if (feet > pose.y + pose.height) return false;
  if (feet + CAPSULE_HEIGHT < pose.y) return false;
  const rx = c.body.position.x - pose.x;
  const rz = c.body.position.z - pose.z;
  const along = rx * pose.dx + rz * pose.dz;
  if (along > pose.halfLength + CAPSULE_RADIUS || along < -pose.halfLength - CAPSULE_RADIUS) {
    return false;
  }
  // The left component, in the same axes `lanes.py` offsets a lane along:
  // left of a heading (dx, dz) is (dz, -dx).
  const across = rx * pose.dz - rz * pose.dx;
  return across <= pose.halfWidth + CAPSULE_RADIUS && across >= -pose.halfWidth - CAPSULE_RADIUS;
}

/**
 * Can this combatant be run down right now?
 *
 * A knocked-out body cannot -- `isTargetable` says so and a ragdoll being
 * re-launched every tick it lies in the road is a bug, not a joke. Neither can
 * somebody already in a flinch, and that clause is doing real work: it is the
 * *re-hit guard*, and it needs no new state because a victim thrown by a car is
 * in the flinch this module put them in for the next 0.85 s, by which time the
 * car is thirty metres up the street.
 */
export function canBeRunDown(c: CombatantState): boolean {
  return isTargetable(c) && c.phase !== 'flinch';
}

/**
 * How hard this car hits, as a fraction of the full knockback. Zero to one.
 *
 * The other half of `canBeRunDown`: that one asks whether the *victim* can be
 * run down and this asks whether the *car* can run anyone down. Both had to
 * exist the moment a schedule car could be stationary, because the old test
 * asked neither -- it found a car overlapping a capsule and threw the capsule
 * ten metres, which for a car parked at the kerb (or held at a red) is a player
 * launched off their feet by a handbrake.
 *
 * Continuous by construction, and that is the requirement rather than a nicety:
 * a step at the threshold would make the last centimetre of a pull-out the
 * difference between nothing and a flight, and a car creeping out of a bay would
 * be a coin toss. Linear from `CAR_HIT_MIN_SPEED` to `CAR_HIT_FULL_SPEED`, so a
 * car pulling out at 2 m/s returns 0.14 -- a nudge -- and anything doing a real
 * road speed returns exactly 1, which is why every existing number in this file
 * still means what it meant.
 */
export function carHitStrength(pose: CarPose): number {
  const s = pose.speed;
  if (!(s > CAR_HIT_MIN_SPEED)) return 0;
  if (s >= CAR_HIT_FULL_SPEED) return 1;
  return (s - CAR_HIT_MIN_SPEED) / (CAR_HIT_FULL_SPEED - CAR_HIT_MIN_SPEED);
}

/**
 * The car hitting this combatant at `tick`, or null.
 *
 * Pure: it decides nothing and applies nothing. The caller -- `server/sim.ts`
 * authoritatively, `main.ts` predictively -- is what turns it into damage, and
 * both evaluate this same function at the same tick, which is the whole of why
 * they agree.
 */
export function carHitting(
  field: TrafficField,
  c: CombatantState,
  tick: number,
  scratch: LaneRoute[],
  pose: CarPose,
  /**
   * Cars somebody has stolen, which are no longer on their timetable.
   *
   * Optional, and absent means "nobody has taken anything" -- which is what
   * every caller written before `game/driving.ts` existed meant, and is still
   * true of the two self-checks below. See `driving.CarField.suppressed`: a car
   * a player is steering is *also* still a lookup, and without this clause the
   * ghost of it carries on down the timetable running people over from inside
   * the car you are sitting in.
   */
  suppressed?: (identity: number) => boolean,
): CarPose | null {
  if (!canBeRunDown(c)) return null;
  let hit = false;
  forEachCarNear(
    field,
    c.body.position.x,
    c.body.position.z,
    HIT_QUERY_RADIUS,
    tick,
    scratch,
    pose,
    (p) => {
      // The parked stages, and the red lights, filtered here rather than in
      // `carOverlaps` -- a stationary car still *occupies* the ground it is on,
      // and anything that wants to ask "is there a car here" (a future spawn
      // rule, a camera collision) needs the overlap to keep telling the truth.
      // What changes is only whether it knocks you over.
      if (carHitStrength(p) <= 0) return;
      if (suppressed !== undefined && suppressed(p.identity)) return;
      if (!carOverlaps(p, c)) return;
      hit = true;
      return true;
    },
  );
  return hit ? pose : null;
}

/**
 * Fill a `CarPose` from a car a **player** is driving.
 *
 * The whole of how a stolen car reuses the run-over machinery rather than
 * getting its own. `carOverlaps`, `carHitStrength`, `applyCarHit` and
 * `pedestrians.runDownPedestrian` all take a `CarPose` and none of them asks
 * where it came from -- so a driven car that fills one is hit-tested by the
 * identical geometry the ambient fleet is, which is the only way "a car knocks
 * you down" can mean one thing in this game.
 *
 * `route` and `slot` are left at zero and `identity` carries the *source*
 * identity, which is the same number the suppression key is: it means nothing
 * to the hit test and everything to a caller that wants to know which ambient
 * car this used to be.
 *
 * The heading is derived from the driver's yaw with the two transcendentals
 * that implies, which is affordable here and nowhere else in this file: this
 * runs once per *driven* car per tick, and driven cars are counted in ones,
 * where `poseCar` runs on two hundred ambient cars a frame and is written to
 * take exactly one square root.
 *
 * `scale` is 1 rather than the 4 % jitter a parked car gets. A driven car's hit
 * box has to be the box the player learns, and a hatch that was 3 % smaller than
 * the identical hatch beside it is a difference nobody could ever attribute.
 */
export function drivenCarPose(
  car: {
    carId: number; body: number; colour: number;
    x: number; y: number; z: number; yaw: number; speed: number;
    /**
     * 0..`CAR_HEALTH_FULL_POSE`. Optional, and absent means undamaged -- which is
     * what every caller written before the crash damage meant, and is still true
     * of the two self-checks at the bottom of this file.
     */
    health?: number;
  },
  out: CarPose,
): CarPose {
  const size = CAR_BODY_SIZE[car.body] ?? CAR_BODY_SIZE[0];
  out.route = 0;
  out.slot = 0;
  out.x = car.x;
  out.y = car.y;
  out.z = car.z;
  // Yaw 0 faces -Z, exactly as `controller.step` derives it, and the pose's
  // heading is a unit vector in the same plan the lanes are offset in.
  out.dx = -Math.sin(car.yaw);
  out.dz = -Math.cos(car.yaw);
  out.body = car.body;
  out.colour = car.colour;
  out.scale = 1;
  out.halfLength = size.length * 0.5;
  out.halfWidth = size.width * 0.5;
  out.height = size.height;
  out.stage = CAR_STAGE_DRIVING;
  out.routeT = 0;
  // **Unsigned**, because everything downstream of a pose treats `speed` as a
  // magnitude -- `carHitStrength` compares it against two positive constants --
  // and a car reversing at 5 m/s hits just as hard as one going forwards.
  out.speed = car.speed < 0 ? -car.speed : car.speed;
  out.identity = car.carId;
  // The dents. See `CarPose.damage` for why this number travels on a pose the
  // ambient fleet also fills, and `driving.CAR_HEALTH_MAX` for the scale.
  const health = car.health ?? CAR_HEALTH_FULL_POSE;
  out.damage = health >= CAR_HEALTH_FULL_POSE ? 0 : health <= 0 ? 1 : 1 - health / CAR_HEALTH_FULL_POSE;
  // A driven car is never *held*: it is the thing other cars are held behind.
  out.held = 0;
  return out;
}

/**
 * `driving.CAR_HEALTH_MAX`, which this file may not import -- `driving.ts`
 * imports *this* one. `verifyDriving` asserts the two agree, which is the same
 * arrangement `driving.SPRINT_SPEED` has with the controller.
 */
export const CAR_HEALTH_FULL_POSE = 100;

/**
 * One pip, one flight over the bonnet, and 0.85 s of not being in charge.
 *
 * The impulse is **set, not added**, which is `combat.applyHit`'s rule and is
 * here for the same reason: a sprinting victim clipped from behind would
 * otherwise arrive carrying their own 8 m/s and be thrown twenty metres. Setting
 * it makes every car throw you the same distance, which is what makes the
 * distance a thing a player learns.
 *
 * The direction is the car's heading, flattened, with no component toward the
 * player at all -- you go where the car was going. That is both what happens and
 * the comic read.
 *
 * Returns true if the hit was a knockout.
 */
export function applyCarHit(victim: CombatantState, pose: CarPose): boolean {
  victim.health = Math.max(0, victim.health - CAR_DAMAGE);
  // `combat.applyHit`'s femto-pip clamp, and it matters here for the same
  // reason: sums like 3 - 1.4 - 1 miss zero by a few times 1e-16.
  if (victim.health < 1e-9) victim.health = 0;
  // Scaled by how fast the thing that hit you was actually going. `poseCar` puts
  // every driving car at or above `CAR_HIT_FULL_SPEED`, so this is 1 for every
  // knockdown that existed before the park stages did and the two constants
  // above still describe what being run over feels like. It is only the two or
  // three seconds of a pull-out that land in between -- and a car easing out of
  // a bay should tip you over, not send you across the road.
  const k = carHitStrength(pose);
  victim.body.velocity.set(
    pose.dx * CAR_KNOCKBACK_HORIZONTAL * k,
    CAR_KNOCKBACK_VERTICAL * k,
    pose.dz * CAR_KNOCKBACK_HORIZONTAL * k,
  );
  // The line `combat.applyHit`'s header calls load-bearing: without it the first
  // tick after the hit charges the victim ground friction for a metre of flight
  // they spend in the air.
  victim.body.onGround = false;
  // And off the lime e-bike, exactly as `combat.applyHit` and
  // `footy.applyFootyHit` do it. This is the third of three parallel damage
  // paths in this codebase and the one where it is least avoidable: a cyclist
  // hit by a car is the canonical way to come off a bike. Clearing the field is
  // the whole of it -- `game/bikes.BikeField.follow` sweeps after every tick and
  // parks any bike whose rider has stopped riding, so nothing here needs to know
  // that class exists.
  victim.ridingBike = 0;
  // And out of the car, on the identical argument. Being T-boned by a bus while
  // driving is the second canonical way to lose a vehicle, and
  // `driving.CarField.follow` leaves yours in the road where the body landed.
  victim.drivingCar = 0;
  victim.carSpeed = 0;

  const ko = victim.health <= 0;
  if (ko) {
    victim.phase = 'ko';
    victim.koT = 0;
    victim.respawnT = KO_SECONDS;
  } else {
    victim.phase = 'flinch';
    // The extended lockout, spent through the existing phase. See `CAR_STAGGER`.
    victim.phaseT = FLINCH_LOCKOUT - CAR_STAGGER;
  }
  // On the victim only. There is no attacker to freeze.
  victim.hitstopT = HITSTOP;
  return ko;
}

// --- Self-check ----------------------------------------------------------------

/**
 * Everything about this module that fails by rendering a plausible city.
 *
 * There is no picture for any of it. A schedule that is not deterministic puts
 * one player's cars somewhere else and tells them they were hit by nothing. A
 * left-hand rule with the sign flipped is a Sydney driving on the right, which
 * is invisible to every automated check that only asks whether cars are on
 * roads. A hit box that disagrees with the drawn body knocks you over from a
 * metre away. A clock that disagrees with the index's is a fleet an hour out of
 * step with the server's. None of them throws.
 *
 * `renderSizes` is `cars.ts`'s body table, passed in rather than imported
 * because the import would drag three into the Bun server -- see
 * `CAR_BODY_SIZE`. `contract` is `index.json`'s `lanes` block. Both are
 * optional so the server can run this before it has opened a file.
 */
export function verifyTraffic(
  renderSizes?: ReadonlyArray<{ length: number; width: number; height: number }>,
  contract?: { hz?: number; epoch_ms?: number; version?: number } | null,
): string[] {
  const failures: string[] = [];

  // --- The crowd field this decoder now reads, checked here rather than from a
  // call site of its own. `decodeLanes` cannot produce a correct timetable
  // against a broken field, so a build that runs `verifyTraffic` and not
  // `verifyDensity` would be checking the arithmetic on top of an unchecked
  // input. `LANE_CLASSES.length` is handed over because `density.ts` must not
  // import this file -- the dependency runs the other way.
  for (const f of verifyDensity(LANE_CLASSES.length)) failures.push(f);

  // --- The drawn car and the car that hits you are the same car.
  if (renderSizes) {
    if (renderSizes.length !== CAR_BODY_SIZE.length) {
      failures.push(
        `The renderer has ${renderSizes.length} body types and the hit box table has ${CAR_BODY_SIZE.length}.`,
      );
    }
    for (let i = 0; i < Math.min(renderSizes.length, CAR_BODY_SIZE.length); i++) {
      const a = renderSizes[i];
      const b = CAR_BODY_SIZE[i];
      if (a.length !== b.length || a.width !== b.width || a.height !== b.height) {
        failures.push(
          `Body ${i} is drawn ${a.length}x${a.width}x${a.height} and hits at ` +
            `${b.length}x${b.width}x${b.height}. A car must knock you over exactly where it looks.`,
        );
      }
    }
  }

  // --- The clock in the file is the clock in the code.
  if (contract) {
    if (contract.hz !== undefined && contract.hz !== TRAFFIC_HZ) {
      failures.push(`The world was baked at ${contract.hz} Hz and this build reads it at ${TRAFFIC_HZ}.`);
    }
    if (contract.epoch_ms !== undefined && contract.epoch_ms !== TRAFFIC_EPOCH_MS) {
      failures.push(
        `The world's traffic epoch is ${contract.epoch_ms} and this build's is ${TRAFFIC_EPOCH_MS}; ` +
          'every car in the city would be in the wrong place.',
      );
    }
    if (contract.version !== undefined && contract.version !== LANES_VERSION) {
      failures.push(`The lane sidecars are v${contract.version} and this build reads v${LANES_VERSION}.`);
    }
  }

  // --- A synthetic tile, through the real encoder and the real decoder.
  //
  // North-running, two-way, 200 m, at a known height, with the lane offset the
  // pipeline would give it. This is what makes the checks below assertions about
  // the shipped format rather than about an object literal.
  const NORTH_LANE_OFFSET = 1.875; // 7.5 m residential carriageway, quarter width
  const tile = syntheticTile(NORTH_LANE_OFFSET);
  const route = tile.routes[0];
  const field = new TrafficField();
  field.adopt('synthetic', tile);

  // --- LEFT-HAND TRAFFIC. The one that is invisible without an assertion.
  //
  // The way runs due north, which in renderer axes is -Z. Left of north is west,
  // which is -X. So a car on this way must sit at negative x -- and the lane the
  // pipeline built is at exactly minus the offset.
  const pose = createCarPose();
  const scratch: LaneRoute[] = [];
  let sampled = 0;
  let onTheLeft = 0;
  for (let tick = 0; tick < 600; tick += 7) {
    if (!poseCar(route, 0, trafficSeconds(tick), pose)) continue;
    sampled++;
    if (pose.dz > -0.99) {
      failures.push(`A car on a due-north way is heading (${pose.dx}, ${pose.dz}); it must be (0, -1).`);
      break;
    }
    // Left of the heading is (dz, -dx). The offset from the centreline (x = 0)
    // projected onto it must be positive.
    if (pose.x * pose.dz - 0 * pose.dx > 0) onTheLeft++;
  }
  if (sampled === 0) failures.push('No car was live on the synthetic route at any sampled tick.');
  else if (onTheLeft !== sampled) {
    failures.push(
      `${sampled - onTheLeft} of ${sampled} sampled positions were on the RIGHT of the direction of ` +
        'travel. This is Australia; the lane offset sign is inverted.',
    );
  }

  // --- THE CENSUS, through the real default rather than through `UNIFORM_CROWD`.
  //
  // One sidecar, decoded four times: as a residential street at Redfern and at
  // Dural, and as a motorway at both. The whole "weight cars by density" brief
  // is these four numbers, and the two failures worth catching are opposite:
  //
  //   - the scaling is inert (a blank field, a dropped multiply, a `crowd`
  //     argument that never reaches `scaleHeadway`), in which case all four
  //     headways are 14 and Dural drives like Redfern, which is the bug that
  //     was reported;
  //   - the scaling is total (the class floor lost, or applied as a factor
  //     instead of a floor), in which case the fringe motorways empty out and
  //     the M2 at Dural runs one car a minute.
  //
  // Nothing else in this file would notice either. `verifyDensity`'s own
  // sections cover the field; this covers the wiring between it and the decoder.
  {
    const REDFERN_X = -440.5;
    const REDFERN_Z = 2703.8;
    const DURAL_X = -15230.7;
    const DURAL_Z = -20051.7;
    const local = (x: number, z: number) => syntheticTile(NORTH_LANE_OFFSET, x, z, trafficMultiplier).routes[0].headway;
    // The same bytes read as a motorway, by overriding the class the crowd
    // function is asked about. The route's own class byte stays residential --
    // what is being tested is `trafficMultiplier`'s floor reaching the decoder,
    // not the pipeline's classification.
    const asMotorway = (x: number, z: number) =>
      syntheticTile(NORTH_LANE_OFFSET, x, z, (px, pz) => trafficMultiplier(px, pz, 0)).routes[0].headway;

    const inner = local(REDFERN_X, REDFERN_Z);
    const fringe = local(DURAL_X, DURAL_Z);
    if (!(fringe > inner * 4)) {
      failures.push(
        `A residential street runs a ${inner.toFixed(1)} s headway at Redfern and ${fringe.toFixed(1)} s ` +
          'at Dural. The census multiplier is not reaching the decoder -- the two should differ by ' +
          'the better part of an order of magnitude, and traffic is still uniform across the city.',
      );
    }
    if (!(inner < SYNTHETIC_HEADWAY)) {
      failures.push(
        `A residential street at Redfern runs a ${inner.toFixed(1)} s headway against the baked ` +
          `${SYNTHETIC_HEADWAY} s. The inner city is meant to be busier than the bake, not quieter.`,
      );
    }
    const fringeMotorway = asMotorway(DURAL_X, DURAL_Z);
    if (!(fringeMotorway < fringe * 0.2)) {
      failures.push(
        `A motorway at Dural runs a ${fringeMotorway.toFixed(1)} s headway against the residential ` +
          `street's ${fringe.toFixed(1)} s. A motorway through an empty suburb is still a motorway; ` +
          '`CLASS_FLOOR` is not being applied.',
      );
    }
    // And the squeeze never eats the red light. This synthetic route holds its
    // car still for `SYNTHETIC_DWELL`, and a headway under that is two cars in
    // one place -- the one thing `scaleHeadway`'s floor exists to prevent.
    for (const h of [inner, fringe, fringeMotorway, asMotorway(REDFERN_X, REDFERN_Z)]) {
      if (!(h > SYNTHETIC_DWELL)) {
        failures.push(
          `A squeezed headway came out at ${h.toFixed(2)} s against a ${SYNTHETIC_DWELL} s dwell on ` +
            'the same route. Two cars would occupy the same three metres of road.',
        );
      }
    }
  }

  // --- Determinism. The same tick, twice, through two decodes of the same bytes.
  {
    const other = syntheticTile(NORTH_LANE_OFFSET).routes[0];
    const a = createCarPose();
    const b = createCarPose();
    for (let tick = 0; tick < 4000; tick += 13) {
      const now = trafficSeconds(tick);
      for (let slot = 0; slot < 3; slot++) {
        const liveA = poseCar(route, slot, now, a);
        const liveB = poseCar(other, slot, now, b);
        if (liveA !== liveB) {
          failures.push(`Two copies of one route disagreed about whether car ${slot} exists at tick ${tick}.`);
          tick = 1e9;
          break;
        }
        if (!liveA) continue;
        if (a.stage !== b.stage || a.speed !== b.speed) {
          failures.push(
            `Two copies of one route put car ${slot} in different stages at tick ${tick}: ` +
              `${a.stage} at ${a.speed} m/s vs ${b.stage} at ${b.speed} m/s.`,
          );
          tick = 1e9;
          break;
        }
        if (a.x !== b.x || a.y !== b.y || a.z !== b.z || a.body !== b.body || a.colour !== b.colour) {
          failures.push(
            `Two copies of one route put car ${slot} in different places at tick ${tick}: ` +
              `(${a.x}, ${a.y}, ${a.z}) vs (${b.x}, ${b.y}, ${b.z}).`,
          );
          tick = 1e9;
          break;
        }
      }
    }
  }

  // --- The car stops at the red light. The dwell is two copies of one vertex,
  // and a lookup that interpolated *through* it would never be stationary.
  {
    const held = createCarPose();
    let stationary = 0;
    let lastX = NaN;
    let lastZ = NaN;
    for (let tick = 0; tick < 900; tick++) {
      if (!poseCar(route, 0, trafficSeconds(tick), held)) continue;
      if (held.x === lastX && held.z === lastZ) stationary++;
      lastX = held.x;
      lastZ = held.z;
    }
    if (stationary < 30) {
      failures.push(
        `The synthetic route has a ${SYNTHETIC_DWELL} s red light in it and the car was stationary for ` +
          `${stationary} of 900 ticks. A dwell must hold the car still, not slow it down.`,
      );
    }
  }

  // --- The knockdown, on a scripted victim standing in the lane.
  {
    const victim = syntheticVictim();
    // Put them exactly where the car will be at tick 300.
    const at = createCarPose();
    if (!poseCar(route, 0, trafficSeconds(300), at)) {
      failures.push('The synthetic car was not live at tick 300; the knockdown check could not run.');
    } else {
      victim.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      if (!carOverlaps(at, victim)) {
        failures.push('A combatant standing exactly on a car was not overlapped by it.');
      }
      const found = carHitting(field, victim, 300, scratch, pose);
      if (found === null) {
        failures.push('A combatant standing in the lane was not found by `carHitting`.');
      } else {
        const before = victim.health;
        applyCarHit(victim, found);
        if (victim.health !== before - CAR_DAMAGE) {
          failures.push(`A car took ${before - victim.health} pips; it must take ${CAR_DAMAGE}.`);
        }
        if (victim.phase !== 'flinch') {
          failures.push(`A survivable car hit left the victim in '${victim.phase}'; it must be 'flinch'.`);
        }
        if (victim.phaseT >= 0) {
          failures.push(
            'The car stagger did not extend the flinch. `phaseT` must start negative so ' +
              "`combat.advance`'s own lockout test ends it late.",
          );
        }
        const speed = Math.sqrt(
          victim.body.velocity.x * victim.body.velocity.x +
            victim.body.velocity.z * victim.body.velocity.z,
        );
        if (Math.abs(speed - CAR_KNOCKBACK_HORIZONTAL) > 1e-6) {
          failures.push(`A car launched the victim at ${speed.toFixed(2)} m/s; it must be ${CAR_KNOCKBACK_HORIZONTAL}.`);
        }
        if (victim.body.velocity.y <= 0) failures.push('A car did not launch the victim upward.');
        if (victim.body.onGround) failures.push('A launched victim was left on the ground and will be charged friction for their flight.');
        if (canBeRunDown(victim)) {
          failures.push('A victim in a car flinch can be run down again this instant; the re-hit guard is not working.');
        }
      }
    }
  }

  // --- Somebody under a viaduct is not hit by the traffic on it.
  {
    const under = syntheticVictim();
    const at = createCarPose();
    if (poseCar(route, 0, trafficSeconds(300), at)) {
      under.body.position.set(at.x, at.y - 8 + EYE_HEIGHT, at.z);
      if (carOverlaps(at, under)) {
        failures.push('A car eight metres overhead knocked over somebody on the street below.');
      }
    }
  }

  // --- THE PARK STAGES. Everything below is what stops a car winking into
  // existence in the middle of a lane; none of it has a picture either.

  // --- The bay is the kerb bay, at the offset the static fleet uses.
  //
  // The synthetic way is 7.5 m kerb to kerb, so its kerb face is 3.75 m out and
  // `parking.py` would put a car's centreline 3.75 - 1.05 = 2.70 m left of the
  // centreline. A schedule car parked beside it has to land on the same line, or
  // it is a car parked half a metre into the traffic lane in a row of cars that
  // are not.
  {
    const parked = createCarPose();
    const want = -(SYNTHETIC_HALF_WIDTH - PARKED_KERB_OFFSET);
    let sampled = 0;
    let worst = 0;
    let moving = 0;
    let wrongStage = 0;
    // Slot 1 departs at `headway`, so any tick before that has it in its bay.
    for (let tick = 60; tick < Number(SYNTHETIC_HEADWAY) * 60 - 6; tick += 11) {
      if (!poseCar(route, 1, trafficSeconds(tick), parked)) continue;
      sampled++;
      if (parked.stage !== CAR_STAGE_PARKED_IN) { wrongStage++; continue; }
      const off = Math.abs(parked.x - want);
      if (off > worst) worst = off;
      if (parked.speed !== 0) moving++;
    }
    if (sampled === 0) {
      failures.push('No car was ever parked in the near bay of the synthetic route.');
    } else if (wrongStage > 0) {
      failures.push(`${wrongStage} of ${sampled} pre-departure samples were not in the parked stage.`);
    } else {
      if (worst > 0.02) {
        failures.push(
          `A parked schedule car sits ${worst.toFixed(3)} m off the kerb line the static fleet uses ` +
            `(wanted x = ${want}). It would be the one car in the row that is not in the row.`,
        );
      }
      if (moving > 0) {
        failures.push(`${moving} of ${sampled} parked samples reported a non-zero speed.`);
      }
    }
    if (!route.bay0 || !route.bay1) {
      failures.push(
        `The synthetic route decoded no bay (flags ${route.bay0}, ${route.bay1}); the park block ` +
          'is not reaching `buildParkPhases`.',
      );
    }
    if (!(route.kerbShift0 > 0) || !(route.kerbShift1 > 0)) {
      failures.push(
        `The synthetic route parked with no lateral shift (${route.kerbShift0}, ` +
          `${route.kerbShift1}); the bay offsets in the park block are being dropped.`,
      );
    }
    const [kerbless] = kerblessEndpoints(tile);
    if (kerbless !== 0) failures.push(`${kerbless} of 2 synthetic route ends found no kerb.`);
  }

  // --- THE v2 CONTRACT, as arithmetic on the decoded route.
  //
  // Everything `buildParkPhases` promises, checked rather than argued. All four
  // fail by rendering a city: a non-monotone warp is two ticks of reverse in a
  // pull-out, an inverted driving stage is a car that arrives before it leaves,
  // and a dwell longer than the bay is free is two cars in one bay -- which is
  // the whole reason this version exists.
  {
    // Monotone ramps. `g <= 3` both ways; see `buildParkPhases` for where the
    // number comes from.
    const g = route.outT / route.outSpan;
    const gIn = route.inLen / route.inSpan;
    if (!(g <= 3 + 1e-9)) {
      failures.push(`The pull-out warp has g = ${g}; over 3 it runs the car backwards.`);
    }
    if (!(gIn <= 3 + 1e-9)) {
      failures.push(`The pull-in warp has g = ${gIn}; over 3 it runs the car backwards.`);
    }
    // A driving stage exists between the two ramps. This is what
    // `bays.MAX_PARK_SHARE` buys and it is the only thing this file needs the
    // pipeline to guarantee.
    if (!(route.outT < route.inT)) {
      failures.push(
        `The pull-out ends at ${route.outT} and the pull-in begins at ${route.inT}; the car would ` +
          'arrive before it had finished leaving.',
      );
    }
    if (!(route.parkT0 <= route.duration * MAX_PARK_SHARE + 1e-6)) {
      failures.push(`The near bay sits at route-time ${route.parkT0} of ${route.duration}; the file broke MAX_PARK_SHARE.`);
    }
    if (!(route.duration - route.parkT1 <= route.duration * MAX_PARK_SHARE + 1e-6)) {
      failures.push(`The far bay sits ${route.duration - route.parkT1} s back from the end; the file broke MAX_PARK_SHARE.`);
    }
    // The bay is empty before the next car needs it. See `PARK_BAY_GAP`.
    if (route.dwellCap0 + route.outT + PARK_BAY_GAP > route.headway + 1e-9) {
      failures.push(
        `The near bay is held for ${route.dwellCap0 + route.outT} s of a ${route.headway} s headway; ` +
          'the next car arrives before the last has cleared it.',
      );
    }
    if (route.dwellCap1 + route.inLen + PARK_BAY_GAP > route.headway + 1e-9) {
      failures.push(
        `The far bay is held for ${route.dwellCap1 + route.inLen} s of a ${route.headway} s headway; ` +
          'the next car arrives before the last has cleared it.',
      );
    }
  }

  // --- Identity is stable across a whole life.
  //
  // A car that changed identity between its pull-out and its pull-in would get
  // a different 3D model halfway down the street, and nothing else in this file
  // would notice: the body, the paint and the scale are all drawn from the same
  // hash, so they would change with it and the car would still look like *a*
  // car. Walked at 60 Hz across every stage, which is also what makes this a
  // check on the stages rather than on the hash.
  {
    const step = createCarPose();
    let id = 0;
    let changes = 0;
    let stagesSeen = 0;
    let ticks = 0;
    const from = Math.floor((SYNTHETIC_HEADWAY - route.dwellCap - 1) * 60);
    const to = Math.ceil((SYNTHETIC_HEADWAY + route.duration + route.dwellCap + 1) * 60);
    for (let tick = from; tick <= to; tick++) {
      if (!poseCar(route, 1, trafficSeconds(tick), step)) continue;
      ticks++;
      stagesSeen |= 1 << step.stage;
      if (id === 0) id = step.identity;
      else if (step.identity !== id) changes++;
    }
    if (ticks === 0 || id === 0) {
      failures.push('No live tick was found for the identity sweep.');
    } else {
      if (changes > 0) {
        failures.push(`A car changed identity ${changes} times in one life; it must never change.`);
      }
      if (stagesSeen !== 0b11111) {
        failures.push(
          `The identity sweep only reached stages ${stagesSeen.toString(2)} of 11111; it did not walk ` +
            'a whole life.',
        );
      }
      if (identityOf(route, 1) !== id) {
        failures.push('`poseCar` and the identity hash disagree about which car this is.');
      }
      if (identityOf(route, 1) === identityOf(route, 2)) {
        failures.push('Two slots of one route share an identity.');
      }
    }
  }

  // --- No teleports, anywhere in the five stages.
  //
  // The whole feature is one claim -- that a car never appears or moves in a way
  // the eye reads as a jump -- and this is that claim as arithmetic: walk one
  // car's entire life at 60 Hz and assert that no single tick moves it further
  // than a tick at the class speed cap could. A ramp that failed to meet its
  // dwell, a warp evaluated on the wrong side of a stage boundary, or a lateral
  // blend that did not reach 1 would all show up here as a step, and every one
  // of them renders as a car that flicks sideways.
  {
    const step = createCarPose();
    let lastX = NaN;
    let lastZ = NaN;
    let biggest = 0;
    let atTick = -1;
    let backwards = 0;
    let lastZonly = Infinity;
    let ticks = 0;
    // Slot 1's whole life, dwells included, with a tick of margin either side.
    const from = Math.floor((SYNTHETIC_HEADWAY - route.dwellCap - 1) * 60);
    const to = Math.ceil((SYNTHETIC_HEADWAY + route.duration + route.dwellCap + 1) * 60);
    for (let tick = from; tick <= to; tick++) {
      if (!poseCar(route, 1, trafficSeconds(tick), step)) {
        lastX = NaN;
        continue;
      }
      ticks++;
      if (!Number.isNaN(lastX)) {
        const dx = step.x - lastX;
        const dz = step.z - lastZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > biggest) {
          biggest = d2;
          atTick = tick;
        }
      }
      // The route runs due north, which is -Z, so route-time monotonicity is
      // exactly "z never increases". This is the lane audit's own property and
      // it is the thing the warp had to preserve: a non-monotone
      // reparametrisation would put a car briefly in reverse, and reverse is
      // what breaks `lanes.py`'s proof that two cars on one route never meet.
      if (step.z > lastZonly + 1e-6) backwards++;
      lastZonly = step.z;
      lastX = step.x;
      lastZ = step.z;
    }
    const worst = Math.sqrt(biggest);
    // 11.1 m/s is the synthetic route's own speed; a tick of it is 0.185 m, and
    // the lateral ramp adds at most a fraction of that.
    if (worst > 0.25) {
      failures.push(
        `A car moved ${worst.toFixed(3)} m in one tick at tick ${atTick}. Nothing on this route ` +
          'travels that fast; a stage boundary is discontinuous and the car teleports.',
      );
    }
    if (backwards > 0) {
      failures.push(
        `${backwards} ticks moved the car backwards along its route. The ramp warp is not monotone, ` +
          "which breaks `lanes.py`'s argument that two cars on one timetable never meet.",
      );
    }
    const wantTicks = Math.round((route.duration + 2 * route.dwellCap) * 60);
    if (ticks < wantTicks * 0.5) {
      failures.push(`A car lived ${ticks} ticks; its route and two dwells are about ${wantTicks}.`);
    }
  }

  // --- The knockdown matrix: parked, pulling out, at speed.
  {
    const at = createCarPose();
    const scratchHit: LaneRoute[] = [];

    // Parked. Standing against a stationary car must be as safe as standing
    // against a bollard -- this is the case the user's report is really about,
    // because the fix parks cars where players walk.
    if (poseCar(route, 1, trafficSeconds(SYNTHETIC_PARKED_TICK), at) && at.stage === CAR_STAGE_PARKED_IN) {
      if (carHitStrength(at) !== 0) {
        failures.push(`A parked car reported a hit strength of ${carHitStrength(at)}; it must be 0.`);
      }
      const bystander = syntheticVictim();
      bystander.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      if (!carOverlaps(at, bystander)) {
        failures.push('A combatant standing on a parked car was not overlapped by it; the box moved with the pose but the test did not.');
      }
      if (carHitting(field, bystander, SYNTHETIC_PARKED_TICK, scratchHit, pose) !== null) {
        failures.push('A parked car knocked over somebody standing beside it.');
      }
    } else {
      failures.push('Could not find the synthetic car in its parked stage for the knockdown matrix.');
    }

    // Pulling out. Somewhere in the ramp the car is between the two speed
    // thresholds, and there the shove must be strictly gentler than a run-down
    // and strictly more than nothing.
    let ramped = false;
    for (let tick = Math.floor(SYNTHETIC_HEADWAY * 60); tick < Math.ceil((SYNTHETIC_HEADWAY + route.outT) * 60); tick++) {
      if (!poseCar(route, 1, trafficSeconds(tick), at)) continue;
      if (at.stage !== CAR_STAGE_PULL_OUT) continue;
      const k = carHitStrength(at);
      if (!(k > 0 && k < 1)) continue;
      ramped = true;
      const victim = syntheticVictim();
      victim.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      applyCarHit(victim, at);
      const speed = Math.sqrt(
        victim.body.velocity.x * victim.body.velocity.x +
          victim.body.velocity.z * victim.body.velocity.z,
      );
      if (!(speed > 0) || speed >= CAR_KNOCKBACK_HORIZONTAL) {
        failures.push(
          `A car pulling out at ${at.speed.toFixed(2)} m/s threw the victim at ${speed.toFixed(2)} m/s; ` +
            `it must be between 0 and ${CAR_KNOCKBACK_HORIZONTAL}.`,
        );
      }
      break;
    }
    if (!ramped) {
      failures.push('No tick of the pull-out ramp landed between the two hit-speed thresholds; the knockback ramp is unreachable.');
    }
  }

  // --- The broadphase finds what the flat list has.
  {
    const all = field.routes();
    if (all.length !== 1) failures.push(`The field holds ${all.length} routes after adopting one tile with one route.`);
    const found = field.near(route.x[0], route.z[0], 20, scratch);
    if (found.length !== 1) failures.push(`The broadphase found ${found.length} routes at a point on the only route in the field.`);
    field.drop('synthetic');
    if (field.routes().length !== 0) failures.push('Dropping a tile left its routes in the field.');
    if (field.cellCount !== 0) failures.push(`Dropping the only tile left ${field.cellCount} broadphase cell(s) behind.`);
  }

  // --- The index is per tile, and its order does not depend on arrival order.
  //
  // The module's own statement of what `checkServerSegments` and
  // `checkLaneLoadPath` prove against the real city, so a browser running
  // `verifyTraffic` offline says it too. Four tiles, adopted forwards and
  // backwards into two fields: `near` must return the same routes in the same
  // sequence, because `forEachCarNear` gives the hit to the first one.
  {
    const tiles: TileLanes[] = [];
    for (let i = 0; i < 4; i++) {
      const one = syntheticTile(NORTH_LANE_OFFSET);
      // Shift each copy along x so they occupy different broadphase cells but
      // still overlap a single query, which is what makes the order visible.
      for (const r of one.routes) {
        for (let k = 0; k < r.count; k++) r.x[k] += i * 60;
        r.minX += i * 60;
        r.maxX += i * 60;
        r.rid = (r.rid ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0;
      }
      tiles.push(one);
    }
    const forwards = new TrafficField();
    const backwards = new TrafficField();
    for (let i = 0; i < tiles.length; i++) forwards.adopt(`t${i}`, tiles[i]);
    for (let i = tiles.length - 1; i >= 0; i--) backwards.adopt(`t${i}`, tiles[i]);
    // And a third that was built, taken apart and built again, which is what an
    // eviction cycle does.
    const cycled = new TrafficField();
    for (let i = 0; i < tiles.length; i++) cycled.adopt(`t${i}`, tiles[i]);
    for (let i = 0; i < tiles.length; i += 2) cycled.drop(`t${i}`);
    for (let i = 0; i < tiles.length; i += 2) cycled.adopt(`t${i}`, tiles[i]);

    const a: LaneRoute[] = [];
    const b: LaneRoute[] = [];
    const c: LaneRoute[] = [];
    forwards.near(120, tiles[0].routes[0].z[0], 400, a);
    backwards.near(120, tiles[0].routes[0].z[0], 400, b);
    cycled.near(120, tiles[0].routes[0].z[0], 400, c);
    if (a.length < 2) {
      failures.push(`The order check only found ${a.length} route(s); it needs at least two to have an order.`);
    }
    if (a.length !== b.length || a.length !== c.length) {
      failures.push(`Three load orders gave ${a.length}, ${b.length} and ${c.length} routes for one query.`);
    } else {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i] || a[i] !== c[i]) {
          failures.push(
            `The broadphase returned route ${i} of ${a.length} differently depending on the order the ` +
              'tiles were adopted; `forEachCarNear` gives the hit to the first one, so two processes ' +
              'would knock the same player over with different cars.',
          );
          break;
        }
      }
    }
  }

  // --- THE HOLD. Traffic yielding to a car somebody left in the lane.
  //
  // What this catches that a typecheck cannot, and all four are things that
  // render perfectly:
  //
  //   - **A queue that never forms.** The whole feature silently absent, which
  //     looks exactly like the version of this game that shipped last week --
  //     cars driving through the wreck you left in Broadway.
  //   - **A queue that never clears.** A car held forever behind a blocker that
  //     was recycled an hour ago, standing in the middle of a lane.
  //   - **A queue in the oncoming lane.** The lateral gate failing means every
  //     car on the other side of the road stops too, which reads as the city
  //     freezing rather than as traffic yielding.
  //   - **Two ends that disagree.** The one failure that is not visual at all:
  //     the server hit-tests a car six metres from where the client drew it, and
  //     a player is run over by nothing.
  {
    const one = syntheticTile(NORTH_LANE_OFFSET);
    const held = new TrafficField();
    held.adopt('hold', one);
    const r = held.routes()[0];
    const probe = createCarPose();
    // A car mid-route and **moving**, and the second half is not pedantry: the
    // synthetic route has a five-second red in the middle of it, and a car
    // sitting at that light is already stationary -- holding it proves nothing
    // and it can never catch up, because a car stopped at a light is not behind
    // schedule, it is at a light. The tick is searched for rather than assumed
    // for the reason `SYNTHETIC_PARKED_TICK`'s own comment gives about the v2
    // dwell rule: a constant here would rot the moment a headway changed.
    const driving = createCarPose();
    let live = false;
    let holdTick = SYNTHETIC_PARKED_TICK;
    for (let t = 0; t < 600 && !live; t += 5) {
      const at = SYNTHETIC_PARKED_TICK + t;
      forEachCarNear(held, r.x[0], r.z[0], 400, at, scratch, probe, (p) => {
        if (p.stage !== CAR_STAGE_DRIVING || p.speed < 4) return;
        Object.assign(driving, p);
        live = true;
        holdTick = at;
        return true;
      });
    }
    if (!live) {
      failures.push('The hold check found no driving car on the synthetic route to queue.');
    } else {
      const clean = { x: driving.x, z: driving.z };
      // A blocker `HOLD_GAP / 2` ahead, in this car's own lane.
      held.held.setBlockers([
        { x: driving.x + driving.dx * (HOLD_GAP / 2), y: driving.y, z: driving.z + driving.dz * (HOLD_GAP / 2), halfLength: 2.3 },
      ]);
      const after = createCarPose();
      let seen = false;
      forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
        if (p.identity !== driving.identity) return;
        Object.assign(after, p);
        seen = true;
        return true;
      });
      if (!seen) {
        failures.push('The car being held stopped being found by the broadphase once it was held.');
      } else {
        if (!(after.held > 0)) {
          failures.push('A car with somebody\'s Camry three metres in front of it was not held at all.');
        }
        // It stands exactly `HOLD_GAP` behind the blocker, along its own route.
        const bx = clean.x + driving.dx * (HOLD_GAP / 2);
        const bz = clean.z + driving.dz * (HOLD_GAP / 2);
        const gap = Math.sqrt((bx - after.x) * (bx - after.x) + (bz - after.z) * (bz - after.z));
        if (Math.abs(gap - HOLD_GAP) > 0.05) {
          failures.push(`A held car stood ${gap.toFixed(2)} m behind the blocker, not ${HOLD_GAP}.`);
        }
        // And it is *stopped*, which is what stops it running down the player
        // who walked in front of it while it queued.
        if (after.speed !== 0) failures.push(`A held car is still doing ${after.speed.toFixed(2)} m/s.`);
        if (carHitStrength(after) !== 0) failures.push('A car stopped in a queue could still knock somebody over.');
      }

      // **The oncoming lane.** The same blocker, moved sideways by a lane width.
      // Left of a heading (dx, dz) is (dz, -dx).
      held.held.clear();
      held.held.setBlockers([
        {
          x: clean.x + driving.dx * (HOLD_GAP / 2) + driving.dz * 3.5,
          y: driving.y,
          z: clean.z + driving.dz * (HOLD_GAP / 2) - driving.dx * 3.5,
          halfLength: 2.3,
        },
      ]);
      let across = createCarPose();
      forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
        if (p.identity !== driving.identity) return;
        across = { ...p };
        return true;
      });
      if (across.held !== 0) {
        failures.push(`A car queued behind something abandoned 3.5 m away in the oncoming lane (lag ${across.held.toFixed(2)} m).`);
      }

      // **A blocker behind it** is not a blocker.
      held.held.clear();
      held.held.setBlockers([
        { x: clean.x - driving.dx * 8, y: driving.y, z: clean.z - driving.dz * 8, halfLength: 2.3 },
      ]);
      let behind = createCarPose();
      forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
        if (p.identity !== driving.identity) return;
        behind = { ...p };
        return true;
      });
      if (behind.held !== 0) failures.push('A car was held by something eight metres behind it.');

      // **The catch-up.** Hold it, take the blocker away, and it must close the
      // gap over the following seconds rather than teleporting back onto its
      // timetable -- and it must actually get there.
      held.held.clear();
      held.held.setBlockers([
        { x: clean.x + driving.dx * (HOLD_GAP / 2), y: driving.y, z: clean.z + driving.dz * (HOLD_GAP / 2), halfLength: 2.3 },
      ]);
      let lag0 = 0;
      forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
        if (p.identity !== driving.identity) return;
        lag0 = p.held;
        return true;
      });
      held.held.setBlockers([]);
      // `setBlockers([])` clears the ledger outright, which is the release path
      // a recycled record takes; re-arm the entry by holding it again and then
      // stepping the tick forward with the blocker moved out of range instead.
      held.held.setBlockers([
        { x: clean.x + driving.dx * (HOLD_GAP / 2), y: driving.y, z: clean.z + driving.dz * (HOLD_GAP / 2), halfLength: 2.3 },
      ]);
      forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
        if (p.identity !== driving.identity) return;
        lag0 = p.held;
        return true;
      });
      held.held.setBlockers([{ x: clean.x + 10_000, y: driving.y, z: clean.z, halfLength: 2.3 }]);
      const lagAt = (dTicks: number): number => {
        let out = -1;
        forEachCarNear(held, r.x[0], r.z[0], 400, holdTick + dTicks, scratch, probe, (p) => {
          if (p.identity !== driving.identity) return;
          out = p.held;
          return true;
        });
        return out;
      };
      if (!(lag0 > 0)) {
        failures.push('The catch-up check could not get the car held in the first place.');
      } else {
        const quarter = lagAt(15);
        if (!(quarter >= 0 && quarter < lag0)) {
          failures.push(`A quarter-second after the blocker left, the lag was ${quarter} against ${lag0.toFixed(2)}; it must fall.`);
        }
        if (quarter === 0) {
          failures.push('The lag went to zero in a quarter of a second. That is a teleport, which is the thing the catch-up exists to avoid.');
        }
        // ...and it does get home. `HOLD_CATCH_UP` is at most 4 m/s, so three
        // metres of lag is gone inside a second; three seconds is generous and
        // still well inside the car's remaining run.
        const home = lagAt(180);
        if (home > 0) failures.push(`Three seconds after the blocker left, the car was still ${home.toFixed(2)} m behind.`);
      }

      // **It never gets closer than the gap, over a whole approach.** The
      // single-sample check above says the clamp is right at one instant; this
      // says it holds while the timetable keeps running underneath it, which is
      // the case that actually matters -- a held car whose lag stopped growing
      // would creep forward into the blocker at the class speed.
      {
        const bx = clean.x + driving.dx * (HOLD_GAP / 2);
        const bz = clean.z + driving.dz * (HOLD_GAP / 2);
        held.held.clear();
        held.held.setBlockers([{ x: bx, y: driving.y, z: bz, halfLength: 2.3 }]);
        let closest = Infinity;
        let sampled = 0;
        for (let t = 0; t < 180; t += 2) {
          forEachCarNear(held, r.x[0], r.z[0], 400, holdTick + t, scratch, probe, (p) => {
            if (p.identity !== driving.identity) return;
            sampled++;
            const d = Math.sqrt((p.x - bx) * (p.x - bx) + (p.z - bz) * (p.z - bz));
            if (d < closest) closest = d;
            return true;
          });
        }
        if (sampled === 0) {
          failures.push('The held car was never found over the three-second approach sweep.');
        } else if (closest < HOLD_GAP - 0.05) {
          failures.push(
            `Over three seconds of being held, a car got to ${closest.toFixed(2)} m of the blocker against a ` +
              `gap of ${HOLD_GAP}. It is creeping into the car in front of it.`,
          );
        }
      }

      // **The catch-up never exceeds 1.5x the class speed.** The brief's number,
      // and the property is measured rather than asserted from the constants:
      // the lag is closed at `min(HOLD_CATCH_UP, 0.5 x schedule speed)`, so the
      // ground speed is the schedule speed plus that, and the ratio can only
      // exceed 1.5 if the clamp is wrong.
      {
        held.held.clear();
        held.held.setBlockers([{ x: clean.x + driving.dx * (HOLD_GAP / 2), y: driving.y, z: clean.z + driving.dz * (HOLD_GAP / 2), halfLength: 2.3 }]);
        // Arm it: the visit has to run *for our car*, so the predicate matches
        // the identity rather than stopping at whichever car the broadphase
        // happens to reach first.
        let armed = 0;
        forEachCarNear(held, r.x[0], r.z[0], 400, holdTick, scratch, probe, (p) => {
          if (p.identity !== driving.identity) return;
          armed = p.held;
          return true;
        });
        if (!(armed > 0)) failures.push('The catch-up ceiling check could not get the car held.');
        held.held.setBlockers([{ x: clean.x + 10_000, y: driving.y, z: clean.z, halfLength: 2.3 }]);
        let worst = 0;
        let prevX = 0;
        let prevZ = 0;
        let prevSpeed = 0;
        let have = false;
        const step = 3;
        for (let t = 0; t <= 120; t += step) {
          forEachCarNear(held, r.x[0], r.z[0], 400, holdTick + t, scratch, probe, (p) => {
            if (p.identity !== driving.identity) return;
            if (have && p.speed > 0.5) {
              const moved = Math.sqrt((p.x - prevX) * (p.x - prevX) + (p.z - prevZ) * (p.z - prevZ));
              const ground = moved / (step / TRAFFIC_HZ);
              // Against the *schedule* speed at the start of the interval, which
              // is what "class speed" means for a car at this point on its route.
              const ratio = prevSpeed > 0.5 ? ground / prevSpeed : 0;
              if (ratio > worst) worst = ratio;
            }
            prevX = p.x;
            prevZ = p.z;
            prevSpeed = p.speed;
            have = true;
            return true;
          });
        }
        if (worst > 1.55) {
          failures.push(
            `A car catching up with its timetable reached ${worst.toFixed(2)}x its class speed. The brief's ` +
              `ceiling is 1.5x, and past it the recovery reads as a teleport with extra steps.`,
          );
        }
        if (worst < 1.01) {
          failures.push(
            `A car released from a hold never exceeded ${worst.toFixed(2)}x its class speed, so it is not ` +
              `catching up at all -- it is permanently behind schedule.`,
          );
        }
      }

      // **Two fields, same inputs, same pose.** The acceptance the brief names,
      // and the only failure here that is invisible on screen.
      const left = new TrafficField();
      const right = new TrafficField();
      left.adopt('hold', syntheticTile(NORTH_LANE_OFFSET));
      right.adopt('hold', syntheticTile(NORTH_LANE_OFFSET));
      const blockers = [
        { x: clean.x + driving.dx * (HOLD_GAP / 2), y: driving.y, z: clean.z + driving.dz * (HOLD_GAP / 2), halfLength: 2.3 },
      ];
      left.held.setBlockers(blockers);
      right.held.setBlockers(blockers);
      const sample = (f: TrafficField, tick: number): string => {
        let out = 'none';
        const s: LaneRoute[] = [];
        const pose = createCarPose();
        forEachCarNear(f, r.x[0], r.z[0], 400, tick, s, pose, (p) => {
          if (p.identity !== driving.identity) return;
          out = `${p.x.toFixed(6)},${p.z.toFixed(6)},${p.held.toFixed(6)},${p.speed.toFixed(6)}`;
          return true;
        });
        return out;
      };
      // Walked forward through the hold and out the other side, both fields in
      // step -- which is what the two ends do, sixty times a second.
      let diverged = 0;
      for (let t = 0; t < 240; t += 3) {
        if (t === 120) {
          left.held.setBlockers([{ x: clean.x + 10_000, y: driving.y, z: clean.z, halfLength: 2.3 }]);
          right.held.setBlockers([{ x: clean.x + 10_000, y: driving.y, z: clean.z, halfLength: 2.3 }]);
        }
        const a = sample(left, holdTick + t);
        const b = sample(right, holdTick + t);
        if (a !== b) diverged++;
      }
      if (diverged !== 0) {
        failures.push(
          `Two TrafficFields handed the same blockers at the same ticks disagreed about a held car on ` +
            `${diverged} of 80 samples. The server would hit-test it somewhere the client did not draw it.`,
        );
      }
    }

    // A field with no blockers costs one boolean and holds nothing at all.
    const idle = new TrafficField();
    idle.adopt('hold', syntheticTile(NORTH_LANE_OFFSET));
    if (idle.held.live) failures.push('A field nobody has stolen a car in reports a live hold ledger.');
    idle.held.setBlockers([]);
    if (idle.held.live) failures.push('An empty blocker roster left the hold ledger live.');
  }

  // --- THE BAYS, as a query. `nearestBay` against the same synthetic route the
  //     park stages are checked on above.
  //
  // The failure this catches is a car snapped to a spot that is not a bay: the
  // whole v2 contract is that `bays.py` arbitrated one bay to one car, and a
  // query that returned a point the ambient fleet does not park in would put a
  // player's abandoned Camry on top of one of the 23,020 static cars.
  {
    const bays = new TrafficField();
    bays.adopt('bay', syntheticTile(NORTH_LANE_OFFSET));
    const r = bays.routes()[0];
    const want = createBayPose();
    bayPose(r, 0, want);
    const got = createBayPose();
    if (!nearestBay(bays, want.x, want.z, 3, scratch, got)) {
      failures.push('nearestBay found nothing standing exactly on a bay.');
    } else if (Math.abs(got.x - want.x) > 1e-6 || Math.abs(got.z - want.z) > 1e-6) {
      failures.push(`nearestBay returned (${got.x}, ${got.z}) for a query standing on (${want.x}, ${want.z}).`);
    }
    // The heading is a unit vector, or the snap points a parked car at nothing.
    const len = Math.sqrt(got.dx * got.dx + got.dz * got.dz);
    if (Math.abs(len - 1) > 1e-6) failures.push(`A bay's heading has length ${len.toFixed(4)}, not 1.`);
    // A kilometre away finds nothing, rather than the nearest bay in the city.
    if (nearestBay(bays, want.x + 1000, want.z, 3, scratch, got)) {
      failures.push('nearestBay answered for a point a kilometre from any bay.');
    }
    // **The three-metre rule, both ways.** This is what decides whether a car
    // somebody got out of reads as *parked* or as abandoned in the lane, and the
    // two answers have to be crisp: a car stopped two metres from a bay is
    // parked in it, and one stopped ten metres away stays exactly where it was
    // left so the traffic queues behind it. `driving.PARK_SNAP_RADIUS` is the 3.
    if (!nearestBay(bays, want.x + 2, want.z, 3, scratch, got)) {
      failures.push('A car left two metres from a bay found no bay to be snapped into.');
    }
    if (nearestBay(bays, want.x + 10, want.z, 3, scratch, got)) {
      failures.push(
        'A car left ten metres from a bay was offered one. Outside the snap radius a car stays in the ' +
          'lane, which is the half of this feature the traffic queues behind.',
      );
    }
    // Ties resolve the same way twice, which is what stops the server snapping a
    // car into one bay while an offline client picks the other.
    const a = createBayPose();
    const b = createBayPose();
    nearestBay(bays, want.x + 1, want.z + 1, 5, scratch, a);
    nearestBay(bays, want.x + 1, want.z + 1, 5, scratch, b);
    if (a.x !== b.x || a.z !== b.z) failures.push('nearestBay chose differently on two identical queries.');
    // And the bay is where `poseCar` actually parks the car -- the one property
    // that makes this a lookup of an existing ledger rather than a new opinion.
    const parked = createCarPose();
    let matched = false;
    forEachCarNear(bays, r.x[0], r.z[0], 400, SYNTHETIC_PARKED_TICK, scratch, parked, (p) => {
      if (p.stage !== CAR_STAGE_PARKED_IN) return;
      const dx = p.x - want.x;
      const dz = p.z - want.z;
      if (dx * dx + dz * dz < 0.01) matched = true;
      return true;
    });
    if (!matched) {
      failures.push(
        'The bay `nearestBay` reports is not where `poseCar` parks the car in its own PARKED_IN stage. ' +
          'A car snapped there would be parked on top of the schedule fleet.',
      );
    }
  }

  return failures;
}

/** The red on the synthetic route, seconds. */
const SYNTHETIC_DWELL = 5;

/** The synthetic street's kerb face, metres from its centreline. 7.5 m road. */
const SYNTHETIC_HALF_WIDTH = 3.75;

/** The synthetic route's headway, seconds. Bounds its parked dwells. */
const SYNTHETIC_HEADWAY = 14;

/**
 * A tick at which slot 1 of the synthetic route is certainly in its near bay.
 *
 * One second before it departs. Not a literal, and the reason is the v2 dwell
 * rule: a dwell is now capped at `headway - outT - PARK_BAY_GAP` rather than at
 * `0.9 * headway`, so on a nine-second headway the near bay was held from 4.8 s
 * rather than from 0.9 s and every check that sampled tick 60 found the car not
 * yet in existence. Anchoring to the departure instead of to the epoch is what
 * makes those checks survive a change to either constant.
 */
const SYNTHETIC_PARKED_TICK = Math.round((SYNTHETIC_HEADWAY - 1) * 60);

/**
 * A 200 m two-way street running due north, encoded and decoded through the real
 * format so the checks above test the shipped bytes rather than an object.
 *
 * **The ways block is not decoration here.** It carries the one number the park
 * stages are derived from -- the kerb face -- so a sidecar with no ways would
 * exercise the fallback rather than the feature. One way, the centreline of the
 * same street the route's lane is offset from, at the residential width
 * `parking.py` builds its bays against.
 */
function syntheticTile(
  offset: number,
  originX = 0,
  originZ = 0,
  crowd: (x: number, z: number, klass: number) => number = UNIFORM_CROWD,
): TileLanes {
  // Five vertices, the middle one doubled for a red light. World axes: north is
  // -Z, so the lane runs from z = 0 to z = -200, and the left of that is -X.
  const pts: Array<[number, number, number, number]> = [];
  const speed = 11.1;
  const legs = [0, 50, 100, 100, 150, 200];
  let t = 0;
  for (let i = 0; i < legs.length; i++) {
    if (i > 0) {
      const gap = legs[i] - legs[i - 1];
      t += gap === 0 ? SYNTHETIC_DWELL : gap / speed;
    }
    pts.push([-offset, -12.5, -legs[i], t]);
  }
  // The way: the same street's centreline, at x = 0, over the same 200 m.
  const wayPts: Array<[number, number, number]> = [[0, -12.5, 0], [0, -12.5, -200]];

  const bytes = new ArrayBuffer(16 + (16 + wayPts.length * 12) + 40 + pts.length * 16);
  const v = new DataView(bytes);
  v.setUint32(0, LANES_MAGIC, true);
  v.setUint32(4, LANES_VERSION, true);
  v.setUint32(8, 1, true);
  v.setUint32(12, 1, true);
  let o = 16;
  v.setUint32(o, 0x51de, true); // osm id
  v.setUint8(o + 4, 10); // residential
  v.setUint8(o + 5, 0); // two-way
  v.setUint16(o + 6, wayPts.length, true);
  v.setFloat32(o + 8, SYNTHETIC_HALF_WIDTH, true);
  v.setFloat32(o + 12, 3.0, true); // footpath band
  o += 16;
  for (const [x, y, z] of wayPts) {
    v.setFloat32(o, x, true);
    v.setFloat32(o + 4, y, true);
    v.setFloat32(o + 8, z, true);
    o += 12;
  }
  v.setUint32(o, 0x5eed, true);
  v.setUint8(o + 4, 10); // residential
  v.setUint8(o + 5, 3); // both bays assigned
  v.setUint16(o + 6, pts.length, true);
  v.setFloat32(o + 8, SYNTHETIC_HEADWAY, true);
  v.setFloat32(o + 12, 0, true); // phase
  o += 16;
  // The park block, standing in for `bays.py`.
  //
  // The route's lane is `offset` west of a 7.5 m street's centreline and
  // `parking.py` would put a bay at `SYNTHETIC_HALF_WIDTH - PARKED_KERB_OFFSET`
  // -- so the delta the pipeline would emit is exactly the difference, due west,
  // which in renderer axes is -X. Writing the arithmetic out rather than a
  // literal is the point: this is the one place in the codebase that states, as
  // executable code, what `bays.py` is supposed to produce, and the parked-pose
  // assertion above then reads it back through the real decoder.
  const bayShift = SYNTHETIC_HALF_WIDTH - PARKED_KERB_OFFSET - offset;
  // `PARK_INSET_M`'s eight metres of arc, as route-time on an 11.1 m/s street,
  // at both ends. The far bay is measured back from the route's own end.
  const inset = 8 / 11.1;
  const total = pts[pts.length - 1][3];
  v.setFloat32(o, inset, true);
  v.setFloat32(o + 4, -bayShift, true);
  v.setFloat32(o + 8, 0, true);
  v.setFloat32(o + 12, total - inset, true);
  v.setFloat32(o + 16, -bayShift, true);
  v.setFloat32(o + 20, 0, true);
  o += 24;
  for (const [x, y, z, at] of pts) {
    v.setFloat32(o, x, true);
    v.setFloat32(o + 4, y, true);
    v.setFloat32(o + 8, z, true);
    v.setFloat32(o + 12, at, true);
    o += 16;
  }
  // `UNIFORM_CROWD`, so every assertion above goes on testing the format rather
  // than the census -- see that constant. The census scaling has its own
  // section, which decodes these same bytes at two real places.
  const tile = decodeLanes(bytes, originX, originZ, crowd);
  if (tile === null || tile.routes.length !== 1 || tile.ways.length !== 1) {
    // Impossible unless the encoder above and the decoder have diverged, which
    // is exactly the thing this construction exists to catch. A throw here is
    // caught by the caller's own harness rather than being a silent zero.
    throw new Error('verifyTraffic could not round-trip its own synthetic lane sidecar');
  }
  return tile;
}

/**
 * A victim to run over, from `combat.createCombatant` rather than from a literal.
 *
 * Written as an object literal first, which was wrong for a reason worth
 * recording: `CombatantState` grows -- it gained the powerup clocks, then the
 * ball supply -- and a literal here compiles until the day it does not, which is
 * a build break in a self-check rather than in the thing that changed. Asking
 * the module that owns the record to make one costs nothing and cannot rot.
 */
function syntheticVictim(): CombatantState {
  return createCombatant(1, 0, 0);
}
