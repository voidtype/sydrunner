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
 *     the headway, which is why `PARK_DWELL_HEADWAY_SHARE` exists and is the
 *     binding constraint on how long a car may sit.
 *
 * A parked car is stationary, and `applyCarHit` now knows it: the knockback
 * scales continuously with the car's own speed, so standing beside one at the
 * kerb is safe and being clipped by one pulling out at 2 m/s is a shove rather
 * than a flight over the bonnet.
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

// --- The sidecar contract ------------------------------------------------------

/** ASCII 'LANE' little-endian. Must match `tiles.LANES_MAGIC`. */
export const LANES_MAGIC = 0x454e414c;
export const LANES_VERSION = 1;

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
 * The way's own `halfWidth` is the kerb face -- `tiles.write_lanes` states that
 * contract -- so a bay is `halfWidth - KERB_OFFSET` left of the centreline, and
 * the lane the route polyline already sits in is however far left it happens to
 * be. The shift between the two is measured rather than re-derived: the
 * perpendicular distance from the route point to the way's centreline *is* the
 * lane offset in force at that point, which sidesteps re-implementing
 * `lanes._lane_offset`'s clamps and its one-way special case.
 */
export const PARKED_KERB_OFFSET = 1.05;

/**
 * How far along the route from its endpoint the kerb bay sits, metres.
 *
 * A route endpoint is a graph node, which is a junction, and a car parked in the
 * middle of an intersection is a worse artefact than the pop this feature
 * exists to remove. Eight metres is inside `parking.CLEAR_OF_JUNCTION`'s 10 m
 * yellow-line keep-out, which is doing double duty: it puts the bay clear of the
 * intersection *and* on the one stretch of kerb the static fleet is guaranteed
 * never to have parked in, so the two can never interpenetrate.
 */
const PARK_INSET_M = 8;

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
 * Shorter than this and a route gets no park stages at all, seconds.
 *
 * A two-second route is a stub whose ramps would be a fifth of a second each,
 * which is a car that teleports out of a bay rather than one that pulls out of
 * it. `lanes.MIN_ROUTE_M` already drops the shortest of these; this catches what
 * is left.
 */
const MIN_PARK_DURATION = 2.0;

/** How long a car sits at the kerb, seconds, before the headway cap bites. */
const PARK_DWELL_MIN = 6;
const PARK_DWELL_MAX = 18;

/**
 * The hard ceiling on a parked dwell, as a share of the route's headway.
 *
 * **This is the load-bearing number in the whole feature.** `lanes.py` proves
 * that two cars on one route never coincide from the fact that the timetable is
 * strictly increasing except in dwells shorter than the headway. A parked dwell
 * is a dwell, and slot `k` sits in the start bay over `[dep - dwell, dep)` while
 * slot `k+1` arrives at `dep + headway - dwell` -- so the bay holds one car at a
 * time exactly when `dwell < headway`. At 0.9 the margin is a tenth of a headway
 * either side, and every route in the shipped world has a headway of five to
 * fifteen seconds (`lanes.HEADWAY`, raised per route above its longest red), so
 * this and not `PARK_DWELL_MAX` is what most cars actually get.
 *
 * Raising it above 1.0 would put two cars in one bay, which is the one failure
 * mode this feature can produce that is worse than the pop it removes.
 */
const PARK_DWELL_HEADWAY_SHARE = 0.9;

/**
 * How far from a lane point a way has to be to be its kerb, metres.
 *
 * `lanes.LANE_OFFSET_MAX` is 5, so a route point is never more than five metres
 * from the centreline it belongs to; nine leaves room for the mitre a corner
 * puts in `lanes._offset_left` without reaching across to the next street.
 */
const KERB_SEARCH_RADIUS = 9;

/**
 * The lateral move a pull-out is allowed to make, metres.
 *
 * A 40 m arterial (`streets.MAX_ROAD_WIDTH`) puts its kerb 20 m from the
 * centreline while `lanes.LANE_OFFSET_MAX` pins the lane at 5, and a car sliding
 * fifteen metres sideways in two and a half seconds reads as a glitch rather
 * than as a driver indicating. Those classes are clearways that
 * `parking.PARKING_CLASSES` excludes anyway, so the cap costs nothing where the
 * static fleet actually is and buys a sane ramp everywhere else.
 */
const MAX_KERB_SHIFT = 5.0;

/** Under this much lateral travel there is no kerb worth pulling into, metres. */
const MIN_KERB_SHIFT = 0.25;

/**
 * The most of one end's measured kerb a route may lend to its other end, metres.
 *
 * A route belongs to the tile holding its *first* point and is written whole --
 * `tiles.write_lanes` says so, and it is what lets a car drive across a seam --
 * so a route's far end routinely lies in the next tile, whose ways block is in a
 * different file this decoder will never see in the same call. Measured on the
 * shipped world: 94% of route starts find their way and only 58% of ends do.
 *
 * The fix is the one piece of geometry that *is* in this file: the same route's
 * other end. A trail follows one road through a junction far more often than it
 * turns onto a different class, so the near end's kerb is the best available
 * estimate of the far end's -- and this is a *cap* on it rather than the value
 * because the two error directions are not equal. Falling short leaves the car
 * on the shoulder, between the lane and the kerb, which reads as a car pulled
 * over. Overshooting puts it on the footpath. 1.5 m covers the whole residential
 * and tertiary population (their measured median shift is 0.83 m) and refuses to
 * fling a car five metres sideways because the route happened to start on an
 * arterial.
 *
 * What is left over -- an end whose route found no kerb at either end -- keeps a
 * shift of zero and dwells in its lane. That is not a failure either: it is a
 * car stopped eight metres short of a junction, which is what a car waiting at a
 * red light is, and `lanes.py`'s edge-disjoint decomposition guarantees nothing
 * else is using that lane to drive through it.
 */
const BORROWED_KERB_SHIFT_MAX = 1.5;

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

  // --- The park stages. All of it derived at decode from this same file; see
  // `buildParkPhases`, which is the only thing that writes any of it.

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
  /** Metres left of the lane the start and end bays sit. Zero where no kerb. */
  kerbShift0: number;
  kerbShift1: number;
  /**
   * The same two shifts as **world vectors**, frozen at decode.
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
   * Frozen, the offset is the vector from the lane to the bay *at the bay*, and
   * everything between there and the lane is a straight blend of it. The car
   * still turns the corner -- that is `driveT` and the polyline -- it just stops
   * dragging its kerb offset round the corner with it.
   */
  kerbOffX0: number;
  kerbOffZ0: number;
  kerbOffX1: number;
  kerbOffZ1: number;
  /** The longest either dwell may run, seconds. Bounds `liveSlots`. */
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
}

export function createCarPose(): CarPose {
  return {
    route: 0, slot: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    body: 0, colour: 0, scale: 1, halfLength: 0, halfWidth: 0, height: 0,
    stage: CAR_STAGE_DRIVING, routeT: 0, speed: 0,
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
    if (o + 16 > buffer.byteLength) return null;
    const rid = v.getUint32(o, true);
    const klass = v.getUint8(o + 4);
    const n = v.getUint16(o + 6, true);
    const headway = v.getFloat32(o + 8, true);
    const phase = v.getFloat32(o + 12, true);
    o += 16;
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
    routes.push({
      rid, klass, headway, phase, duration: t[n - 1], count: n, x, y, z, t, minX, maxX, minZ, maxZ,
      // Filled by `buildParkPhases` below, which needs the ways block and so
      // cannot run until every way has been read. Zeroed rather than left
      // undefined so a route that somehow escapes that pass is a car with no
      // park stages -- the old behaviour -- rather than a NaN in a hit box.
      parkT0: 0, outT: 0, inT: t[n - 1], parkT1: t[n - 1],
      outSpan: 0, outA: 0, outB: 0,
      inLen: 0, inSpan: 0, inA: 0, inB: 0, inC: 0,
      kerbShift0: 0, kerbShift1: 0,
      kerbOffX0: 0, kerbOffZ0: 0, kerbOffX1: 0, kerbOffZ1: 0,
      dwellCap: 0,
    });
  }
  if (routes.length > 0) buildParkPhases(ways, routes);
  return { ways, routes };
}

// --- Parking the ends of a route -----------------------------------------------

/**
 * Every way segment in one tile, flattened, for the kerb query.
 *
 * A structure of arrays and not a list of objects, built once per sidecar and
 * thrown away at the end of the decode. The query below runs twice per route --
 * a few thousand times for the whole city, once, at load -- so this is nowhere
 * near a hot path; it is flat because the alternative allocates one object per
 * segment of every street in Sydney and hands the collector 200,000 corpses
 * during a tile load, which on the client is a frame the streamer was trying to
 * spend on GPU uploads.
 */
interface WaySegments {
  count: number;
  ax: Float64Array;
  az: Float64Array;
  bx: Float64Array;
  bz: Float64Array;
  /** The way's kerb face, metres from its centreline. */
  half: Float64Array;
}

function flattenWays(ways: LaneWay[]): WaySegments {
  let total = 0;
  for (const w of ways) total += w.count - 1;
  const seg: WaySegments = {
    count: 0,
    ax: new Float64Array(total),
    az: new Float64Array(total),
    bx: new Float64Array(total),
    bz: new Float64Array(total),
    half: new Float64Array(total),
  };
  let k = 0;
  for (const w of ways) {
    for (let i = 0; i + 1 < w.count; i++) {
      seg.ax[k] = w.x[i];
      seg.az[k] = w.z[i];
      seg.bx[k] = w.x[i + 1];
      seg.bz[k] = w.z[i + 1];
      seg.half[k] = w.halfWidth;
      k++;
    }
  }
  seg.count = k;
  return seg;
}

/**
 * How far left of this lane point the kerb bay beside it is, metres.
 *
 * Zero when there is no way close enough to have a kerb -- a route end on a
 * motorway deck, or one whose own way lives in the next tile's sidecar. That
 * fallback is deliberate and it is *not* a failure: the car then dwells at the
 * lane offset, which is a car stopped in a lane, which is what a car stopped on
 * a motorway is. `verifyTraffic` and `checkTraffic` both count them, because the
 * number going up is how a pipeline change to the ways block would show itself.
 *
 * **Tile-local by construction.** The only input is the sidecar being decoded,
 * so two processes that have read the same bytes derive the same bay -- which is
 * the same argument the rest of this module rests on, and the reason this cannot
 * be allowed to consult the resident set: the server holds every tile at boot
 * and the client holds a moving handful, so a query across tiles would put the
 * two fleets in different places.
 */
function kerbShiftAt(seg: WaySegments, x: number, z: number): number {
  let bestD2 = KERB_SEARCH_RADIUS * KERB_SEARCH_RADIUS;
  let bestHalf = 0;
  let found = false;
  for (let i = 0; i < seg.count; i++) {
    const ax = seg.ax[i];
    const az = seg.az[i];
    const bx = seg.bx[i];
    const bz = seg.bz[i];
    // Segment bounding box, inflated by the radius. Cheap enough that it is
    // worth doing before the projection on every one of them.
    if (x < (ax < bx ? ax : bx) - KERB_SEARCH_RADIUS) continue;
    if (x > (ax > bx ? ax : bx) + KERB_SEARCH_RADIUS) continue;
    if (z < (az < bz ? az : bz) - KERB_SEARCH_RADIUS) continue;
    if (z > (az > bz ? az : bz) + KERB_SEARCH_RADIUS) continue;
    const dx = bx - ax;
    const dz = bz - az;
    const l2 = dx * dx + dz * dz;
    let u = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    if (u < 0) u = 0;
    else if (u > 1) u = 1;
    const px = x - (ax + u * dx);
    const pz = z - (az + u * dz);
    const d2 = px * px + pz * pz;
    if (d2 < bestD2) {
      bestD2 = d2;
      bestHalf = seg.half[i];
      found = true;
    }
  }
  if (!found) return 0;
  // The measured perpendicular distance *is* the lane offset in force here, so
  // the shift is the difference between where the car drives and where the kerb
  // bay is. `Math.sqrt` is IEEE-754 exact and is the one root this module
  // allows itself; see the header.
  const shift = bestHalf - PARKED_KERB_OFFSET - Math.sqrt(bestD2);
  if (!(shift > MIN_KERB_SHIFT)) return 0;
  return shift > MAX_KERB_SHIFT ? MAX_KERB_SHIFT : shift;
}

/** Route-time at `metres` of arc from the start (or, negative, from the end). */
function timeAtArc(route: LaneRoute, metres: number, fromEnd: boolean): number {
  const n = route.count;
  let acc = 0;
  for (let s = 0; s + 1 < n; s++) {
    const i = fromEnd ? n - 2 - s : s;
    const dx = route.x[i + 1] - route.x[i];
    const dz = route.z[i + 1] - route.z[i];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (acc + len >= metres) {
      const u = len > 0 ? (metres - acc) / len : 0;
      const t0 = route.t[i];
      const t1 = route.t[i + 1];
      return fromEnd ? t1 - u * (t1 - t0) : t0 + u * (t1 - t0);
    }
    acc += len;
  }
  return fromEnd ? route.t[0] : route.t[n - 1];
}

/**
 * The point on a route at route-time `tt`, and the heading there, into `out`.
 *
 * `poseCar`'s own lookup, minus the identity and the stages -- the same binary
 * search, the same lerp and the same walk out of a red-light dwell to find a
 * segment with a direction in it. Decode-time only.
 */
function sampleRoute(
  route: LaneRoute,
  tt: number,
  out: { x: number; z: number; dx: number; dz: number },
): void {
  const t = route.t;
  let lo = 0;
  let hi = route.count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= tt) lo = mid;
    else hi = mid;
  }
  const span = t[lo + 1] - t[lo];
  const u = span > 0 ? (tt - t[lo]) / span : 0;
  out.x = route.x[lo] + u * (route.x[lo + 1] - route.x[lo]);
  out.z = route.z[lo] + u * (route.z[lo + 1] - route.z[lo]);
  let hx = route.x[lo + 1] - route.x[lo];
  let hz = route.z[lo + 1] - route.z[lo];
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
}

/** Scratch for `buildParkPhases`. Decode-time only; never touched at 60 Hz. */
const _samplePoint = { x: 0, z: 0, dx: 0, dz: 1 };
const _sampleEnd = { x: 0, z: 0, dx: 0, dz: 1 };

/**
 * Give every route its two kerb bays and the two ramps that reach them.
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
 * `g = outT / (outT - parkT0)` is whatever slope makes the join seamless. That
 * gives `a = g - 2`, `b = 3 - g`, and `w' = s(3a s + 2b)`, which is non-negative
 * across [0, 1] **exactly when `g <= 3`** -- so `parkT0 <= (2/3) outT`, which is
 * where `2 * PULL_OUT_SECONDS` in the clamp below comes from. Monotone `w` is
 * not an aesthetic preference: a car that went backwards for a tenth of a second
 * would break the ordering the no-coincidence proof depends on.
 *
 * The pull-in is the same cubic read backwards -- `v(0) = 0`, `v'(0) = g'`,
 * `v(1) = 1`, `v'(1) = 0` -- and comes to rest at `parkT1`, short of the route's
 * own end, which is what puts the far bay eight metres back from the junction.
 *
 * The lateral blend rides on top: `(1 - w)^2` out and `v^2` in, squared so that
 * the sideways velocity is zero at both ends of both ramps as well. Without the
 * square the car finishes its pull-out still drifting 0.3 m/s sideways and then
 * stops drifting in one frame, which is small but is exactly the kind of kink
 * the eye finds.
 */
function buildParkPhases(ways: LaneWay[], routes: LaneRoute[]): void {
  const seg = flattenWays(ways);
  for (const r of routes) {
    const duration = r.duration;
    if (duration < MIN_PARK_DURATION || seg.count === 0) {
      // No stages at all: `inT === duration` makes the whole life one cruise and
      // `dwellCap === 0` makes `liveSlots` the function it always was. A world
      // whose ways block is empty -- `pedestrians.ts` writes one, and so does a
      // tile of pure motorway -- degrades to exactly the old behaviour.
      r.inT = duration;
      r.parkT1 = duration;
      continue;
    }
    const k = duration >= RAMP_BUDGET ? 1 : duration / RAMP_BUDGET;
    const P = PULL_OUT_SECONDS * k;
    const Q = PULL_IN_SECONDS * k;

    // The near bay: `PARK_INSET_M` of arc into the route, but never so far in
    // that the warp above stops being monotone, and never more than a quarter of
    // a short route.
    let parkT0 = timeAtArc(r, PARK_INSET_M, false);
    const outCap = 2 * P;
    if (parkT0 > outCap) parkT0 = outCap;
    if (parkT0 > duration * 0.25) parkT0 = duration * 0.25;
    if (!(parkT0 > 0)) parkT0 = 0;
    const outT = parkT0 + P;
    const g = outT / P;

    // The far bay, the same distance back from the end. Bounded by `(2/3) Q` for
    // the pull-in's own monotonicity, which is the same `g <= 3`.
    let inset1 = duration - timeAtArc(r, PARK_INSET_M, true);
    const inCap = (2 / 3) * Q;
    if (inset1 > inCap) inset1 = inCap;
    if (!(inset1 > 0)) inset1 = 0;
    const inT = duration - Q;
    const parkT1 = duration - inset1;
    const inSpan = parkT1 - inT;
    const gIn = Q / inSpan;

    r.parkT0 = parkT0;
    r.outT = outT;
    r.outSpan = P;
    r.outA = g - 2;
    r.outB = 3 - g;
    r.inT = inT;
    r.parkT1 = parkT1;
    r.inLen = Q;
    r.inSpan = inSpan;
    r.inA = gIn - 2;
    r.inB = 3 - 2 * gIn;
    r.inC = gIn;

    sampleRoute(r, parkT0, _samplePoint);
    let shift0 = kerbShiftAt(seg, _samplePoint.x, _samplePoint.z);
    sampleRoute(r, parkT1, _sampleEnd);
    let shift1 = kerbShiftAt(seg, _sampleEnd.x, _sampleEnd.z);
    // One end lends to the other. See `BORROWED_KERB_SHIFT_MAX` -- this is what
    // rescues the far end of every route that crosses a tile seam, which is most
    // of them.
    if (shift1 === 0 && shift0 > 0) {
      shift1 = shift0 < BORROWED_KERB_SHIFT_MAX ? shift0 : BORROWED_KERB_SHIFT_MAX;
    } else if (shift0 === 0 && shift1 > 0) {
      shift0 = shift1 < BORROWED_KERB_SHIFT_MAX ? shift1 : BORROWED_KERB_SHIFT_MAX;
    }
    r.kerbShift0 = shift0;
    r.kerbShift1 = shift1;
    // Left of a heading (dx, dz) is (dz, -dx), the same axes `lanes._offset_left`
    // put the lane on. Frozen here rather than rebuilt per frame -- see
    // `LaneRoute.kerbOffX0` for the corner that made that necessary.
    r.kerbOffX0 = _samplePoint.dz * shift0;
    r.kerbOffZ0 = -_samplePoint.dx * shift0;
    r.kerbOffX1 = _sampleEnd.dz * shift1;
    r.kerbOffZ1 = -_sampleEnd.dx * shift1;

    // See `PARK_DWELL_HEADWAY_SHARE`. One number for both ends, because
    // `liveSlots` needs a single bound and the two dwells are drawn from it.
    const cap = r.headway * PARK_DWELL_HEADWAY_SHARE;
    r.dwellCap = cap < PARK_DWELL_MAX ? cap : PARK_DWELL_MAX;
  }
}

/**
 * How many route endpoints in a decoded tile found no kerb to park against.
 *
 * Diagnostics, and the one number worth watching if the ways block ever changes:
 * a car with no kerb dwells in its lane, which is correct on a motorway and
 * wrong everywhere else, so a jump here is a pipeline regression rather than a
 * rendering one. Returns `[kerbless, total]`.
 */
export function kerblessEndpoints(tile: TileLanes): [number, number] {
  let kerbless = 0;
  for (const r of tile.routes) {
    if (r.kerbShift0 === 0) kerbless++;
    if (r.kerbShift1 === 0) kerbless++;
  }
  return [kerbless, tile.routes.length * 2];
}

// --- The resident world --------------------------------------------------------

/** Broadphase cell, metres. See `TrafficField`. */
const CELL = 256;

/**
 * Every lane sidecar currently loaded, indexed for "what is near this player".
 *
 * Adopt/drop by tile key, exactly as `game/powerups.ts`'s `PowerupField` is --
 * the client's streamer calls both as a tile arrives and leaves, and the server
 * adopts every tile once at boot and never drops one. The flat route array and
 * the bucket grid are rebuilt only when the resident set changes, which on the
 * server is never after boot and on the client is a handful of times a minute.
 *
 * The grid exists because the alternative is measurable: the server tests every
 * combatant against every car in Sydney every tick, and at 6,200 cars and 16
 * players that is 100,000 evaluations at 60 Hz. Bucketed, a player sees the
 * routes whose plan bounds overlap their own 3x3 cells -- a few dozen.
 */
export class TrafficField {
  private readonly tiles = new Map<string, TileLanes>();
  private flat: LaneRoute[] = [];
  private grid = new Map<number, LaneRoute[]>();
  private dirty = true;

  adopt(tileKey: string, tile: TileLanes): void {
    this.tiles.set(tileKey, tile);
    this.dirty = true;
  }

  drop(tileKey: string): void {
    if (this.tiles.delete(tileKey)) this.dirty = true;
  }

  get tileCount(): number {
    return this.tiles.size;
  }

  /** Every route in a resident tile. Rebuilt on demand; do not hold across a drop. */
  routes(): readonly LaneRoute[] {
    this.rebuild();
    return this.flat;
  }

  /** Every way in a resident tile -- the geometry block. Nothing here reads it. */
  ways(): LaneWay[] {
    const out: LaneWay[] = [];
    for (const tile of this.tiles.values()) out.push(...tile.ways);
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
    this.rebuild();
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

  private rebuild(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.flat = [];
    this.grid = new Map();
    for (const tile of this.tiles.values()) {
      for (const route of tile.routes) {
        this.flat.push(route);
        const c0 = Math.floor(route.minX / CELL);
        const c1 = Math.floor(route.maxX / CELL);
        const r0 = Math.floor(route.minZ / CELL);
        const r1 = Math.floor(route.maxZ / CELL);
        for (let cx = c0; cx <= c1; cx++) {
          for (let cz = r0; cz <= r1; cz++) {
            const key = cellKey(cx, cz);
            const bucket = this.grid.get(key);
            if (bucket === undefined) this.grid.set(key, [route]);
            else bucket.push(route);
          }
        }
      }
    }
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
 * they are separate draws so a car does not wait the same time at both ends.
 * Capped by the headway share -- see `PARK_DWELL_HEADWAY_SHARE`, which is the
 * constraint that keeps one bay to one car.
 */
function parkDwell(route: LaneRoute, h: number, which: number): number {
  const cap = route.dwellCap;
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
  for (const route of field.near(x, z, radius, scratch)) {
    liveSlots(route, now, range);
    for (let slot = range.first; slot <= range.last; slot++) {
      if (!poseCar(route, slot, now, pose)) continue;
      const dx = pose.x - x;
      const dz = pose.z - z;
      if (dx * dx + dz * dz > radius * radius) continue;
      if (visit(pose) === true) return;
    }
  }
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
const HIT_QUERY_RADIUS = 6;

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
      if (!carOverlaps(p, c)) return;
      hit = true;
      return true;
    },
  );
  return hit ? pose : null;
}

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
    for (let tick = 60; tick < Number(SYNTHETIC_HEADWAY) * 60 - 60; tick += 11) {
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
    if (!(route.kerbShift0 > 0) || !(route.kerbShift1 > 0)) {
      failures.push(
        `The synthetic route found no kerb to park against (shifts ${route.kerbShift0}, ` +
          `${route.kerbShift1}); the ways block is not reaching \`buildParkPhases\`.`,
      );
    }
    const [kerbless] = kerblessEndpoints(tile);
    if (kerbless !== 0) failures.push(`${kerbless} of 2 synthetic route ends found no kerb.`);
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
    if (poseCar(route, 1, trafficSeconds(60), at) && at.stage === CAR_STAGE_PARKED_IN) {
      if (carHitStrength(at) !== 0) {
        failures.push(`A parked car reported a hit strength of ${carHitStrength(at)}; it must be 0.`);
      }
      const bystander = syntheticVictim();
      bystander.body.position.set(at.x, at.y + EYE_HEIGHT, at.z);
      if (!carOverlaps(at, bystander)) {
        failures.push('A combatant standing on a parked car was not overlapped by it; the box moved with the pose but the test did not.');
      }
      if (carHitting(field, bystander, 60, scratchHit, pose) !== null) {
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
  }

  return failures;
}

/** The red on the synthetic route, seconds. */
const SYNTHETIC_DWELL = 5;

/** The synthetic street's kerb face, metres from its centreline. 7.5 m road. */
const SYNTHETIC_HALF_WIDTH = 3.75;

/** The synthetic route's headway, seconds. Bounds its parked dwells. */
const SYNTHETIC_HEADWAY = 9;

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
function syntheticTile(offset: number): TileLanes {
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

  const bytes = new ArrayBuffer(16 + (16 + wayPts.length * 12) + 16 + pts.length * 16);
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
  v.setUint8(o + 5, 0);
  v.setUint16(o + 6, pts.length, true);
  v.setFloat32(o + 8, SYNTHETIC_HEADWAY, true);
  v.setFloat32(o + 12, 0, true); // phase
  o += 16;
  for (const [x, y, z, at] of pts) {
    v.setFloat32(o, x, true);
    v.setFloat32(o + 4, y, true);
    v.setFloat32(o + 8, z, true);
    v.setFloat32(o + 12, at, true);
    o += 16;
  }
  const tile = decodeLanes(bytes, 0, 0);
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
