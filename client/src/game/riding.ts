/**
 * Riding a train: the carriage as a moving frame, and the passenger inside it.
 *
 * `game/rail.ts` says where every train in Sydney is at any instant. This file
 * says where a *person* is when they are standing in one, and it says it in the
 * only coordinates that make the question tractable.
 *
 * ---------------------------------------------------------------------------
 * 1. A RIDER'S POSITION IS CARRIAGE-LOCAL. THE WORLD POSITION IS DERIVED.
 *
 * This is the whole design and everything else in the file is a consequence of
 * it. A rider is `(line, direction, trip, carriage, x, y, z, yaw)` where the
 * last four are metres and radians **in the carriage's own frame** -- origin at
 * the carriage centre, +X the nose, +Y up from rail level, +Z across. The wire
 * carries exactly that (`protocol.ABOARD_BYTES`), the server stores exactly
 * that, and the world position is composed on both ends by
 *
 *     world = carFrame(poseTrain(trip, t)) . local
 *
 * The alternative -- store the world position and add the train's velocity to
 * the player's -- is the road this repo has already been down twice with the
 * acceleration ramp and the input queue (`integration-check.checkAccelerationRamp`,
 * `checkInputQueue`). Both were the same bug wearing different clothes: a
 * prediction and a replay that disagreed about a *velocity*. Riding at 44 m/s
 * would reintroduce it at forty times the scale, because the disagreement would
 * be a train-length per second rather than a footstep.
 *
 * In local coordinates none of that can happen:
 *
 *   - **Prediction and reconciliation are a slow walk on a flat floor.** The
 *     replay in `net/client.reconcile` runs the identical `controller.step`
 *     against the identical carriage, at 4.4 m/s, over a floor that is not
 *     moving. There is nothing left for the two ends to disagree about.
 *   - **The train's motion is identical on both sides by construction.** It is
 *     `poseTrain`, which is a closed-form function of the millisecond and is
 *     asserted bit-identical across two module instances by `checkRail`. It
 *     cannot drift, so it cannot be reconciled, so it is not in the loop.
 *   - **Lag compensation stays exact and needs no new machinery.** Rewinding a
 *     rider to `t - rtt` is evaluating `poseTrain` at that instant and composing
 *     the local offset the history already holds. A cricket-bat fight in a
 *     moving carriage is a fight in a stationary room that happens to be
 *     somewhere else by the time it lands.
 *
 * And the price is one basis multiply per rider per tick, which is nine
 * multiplies and six adds. See section 4.
 *
 * ---------------------------------------------------------------------------
 * 2. **THIS FILE IMPORTS ONLY `game/rail.ts`.** Not three, not `combat.ts`, not
 * the controller. `rail.ts` states the rule for itself and it applies here for
 * the same reason plus one more: the Bun server has to run this to *validate a
 * boarding claim*, and a `Vector3` reaching here would drag the renderer into a
 * process that draws nothing.
 *
 * The two constants the controller also owns -- eye height and body radius --
 * are therefore restated rather than imported, on `rail.RAIL_EPOCH_MS`'s terms:
 * duplicated by value, and `verifyRiding` asserts the copies agree with the
 * originals so the duplication is safe rather than merely convenient.
 *
 * ---------------------------------------------------------------------------
 * 3. THE INTERIOR IS HAND-AUTHORED FROM THE MODEL'S OWN DIMENSIONS.
 *
 * The two shipped GLBs have complete interiors -- `scripts/prep-train-models.mjs`
 * merged them rather than stripping them, which is why a Tangara is 190k
 * triangles -- so the geometry a rider walks around in already exists and is
 * already drawn. What did not exist is a *collision* representation of it, and
 * deriving one from the mesh was rejected before it was tried: 47,000 triangles
 * a carriage, none of them named, merged into six blobs by material, is not a
 * source anybody can debug when a player falls through a floor.
 *
 * So the table in `INTERIORS` is thirty numbers, and every one of them was
 * **measured off the shipped file** by ray-probing the merged geometry at a grid
 * of points. What the probes said about `tangara.glb`'s driving car, at the
 * centre of the aisle, in model metres above rail level:
 *
 *     x -8.5 .. -5.4   floor 1.15, ceiling 3.58     end + door vestibule
 *     x -5.3 .. -4.4   the staircases (see below)
 *     x -4.3 ..  2.9   floor 0.39, ceiling 2.42     lower saloon
 *                      floor 2.51, ceiling 4.40     upper saloon
 *     x  3.1 ..  4.0   the staircases again
 *     x  4.1 ..  8.4   floor 1.16, ceiling 3.58     door vestibule + cab end
 *
 * The vestibule floor at 1.16 m is the same number the door leaves' own bottom
 * edge sits at, and `world/rail-geo.PLATFORM_HEIGHT` is 1.05 -- so stepping
 * aboard is an 11 cm step up, which is what stepping onto a Tangara is. Two
 * independently-derived numbers landing 11 cm apart is the check that says the
 * carriage frame and the platform frame are the same frame.
 *
 * **The staircases are the one piece of real structure here**, because they are
 * the one piece a player can fall through. The probes found them side by side
 * across the width rather than one after the other along the length: at
 * x = -4.4 the -Z half of the car reads 0.58 (descending to the lower saloon)
 * and the +Z half reads 0.39/0.92/2.00/2.24 (ascending to the upper one). So
 * they are modelled as two ramps split at z = 0, with a divider between them and
 * with each one walled off from the deck it does not serve -- which is what the
 * real enclosure is, and which is also the only arrangement that has no
 * discontinuity in the floor anywhere a player can walk. Every other arrangement
 * tried on paper had one, and a floor that jumps 1.3 m under a walking player is
 * either a lift or a fall depending on the sign.
 *
 * Everything else is a box: four walls, a floor, and holes where the doors are.
 * Riding is meant to be walkable, not pixel-accurate. There are no seats to
 * bump into and no poles to catch on, and that is a decision -- a rider who
 * cannot cross their own carriage because a seat block is 4 cm out is a worse
 * bug than a rider who walks through a seat.
 *
 * ---------------------------------------------------------------------------
 * 4. WHAT IT COSTS, AND WHERE THE TRIGONOMETRY IS ALLOWED TO BE.
 *
 * Per rider per tick: two `sampleAlong` calls (the same two the renderer already
 * makes to put the carriage on the rails -- see `world/trains.carMatrix`, which
 * now calls straight into `carFrameAt` so there is exactly one implementation),
 * one basis construction with a single `Math.sqrt`, and one nine-multiply
 * compose each way. `Math.sqrt` is the only root ECMAScript specifies exactly,
 * which is why it is the only one `rail.ts` allows itself and the only one here.
 *
 * **`frameYaw` is the exception and it is deliberately quarantined.** Composing
 * a rider's local heading into a world heading needs an `atan2`, which is
 * implementation-defined in the last place. It is safe *here* and nowhere else,
 * because a world yaw is never integrated: it is written into the snapshot,
 * quantised to one part in 65,536 of a turn, and used to point a mesh and a bat.
 * The position composition -- the thing two machines must agree on to the bit --
 * contains no trigonometry at all. `checkRiding` asserts that separation by
 * comparing ten thousand derived world positions against a reference with
 * `Object.is`.
 */

import {
  createTrainPose,
  poseTrain,
  sampleAlong,
  trainIdentity,
  type RailBake,
  type RailDirection,
  type TrainPose,
} from './rail.ts';

// --- The two constants that belong to the controller ---------------------------------

/**
 * `controller.EYE_HEIGHT`, restated. See section 2 for why it is not imported.
 *
 * A rider's stored local position is their **eye**, exactly as
 * `CombatantState.body.position` is, so that the enter/exit conversion around
 * `combat.advance` is a change of basis and nothing else. Getting this wrong
 * would put every rider's feet 1.68 m into the carriage floor, which renders
 * perfectly.
 */
export const RIDER_EYE_HEIGHT = 1.68;

/** `controller.PLAYER_RADIUS`, restated. See section 2. */
export const RIDER_RADIUS = 0.34;

/**
 * `world/rail-geo.PLATFORM_HEIGHT` and `PLATFORM_INNER`, restated.
 *
 * Restated rather than imported because `rail-geo.ts` is a renderer -- it
 * imports three -- and the server has to be able to put a disembarking player on
 * a platform without one. These two numbers are the whole of the platform as far
 * as anybody standing on it is concerned: how high its surface is over the rail,
 * and how far its face is from the track centre.
 *
 * They matter to *both* ends because a disembark is a teleport, and a teleport
 * the two ends compute differently is a player who arrives on the platform on
 * one screen and in the four-foot on the other.
 */
export const PLATFORM_TOP_M = 1.05;
export const PLATFORM_INNER_M = 1.62;

// --- The consist ---------------------------------------------------------------------

/**
 * One carriage of a service, and which way round it is coupled.
 *
 * This lived in `world/trains.ts` until riding needed it, and moving it here
 * rather than copying it is the whole point: the carriage a rider is standing in
 * has to be the carriage the renderer draws, on both ends, or the doors are in
 * the wrong place. `world/trains.ts` imports these now.
 */
export interface ConsistCar {
  key: string;
  /** True for a carriage coupled the other way round: a 180 degree turn about Y. */
  flip: boolean;
}

export const TANGARA = 'tangara';
export const METROPOLIS = 'metropolis';

/**
 * Eight cars: two four-car Tangara sets, each driving-intermediate-intermediate-
 * driving with the rear cab reversed, which is how they actually run.
 */
export const SUBURBAN: readonly ConsistCar[] = [
  { key: `${TANGARA}:cab`, flip: false },
  { key: `${TANGARA}:mid`, flip: false },
  { key: `${TANGARA}:mid`, flip: true },
  { key: `${TANGARA}:cab`, flip: true },
  { key: `${TANGARA}:cab`, flip: false },
  { key: `${TANGARA}:mid`, flip: false },
  { key: `${TANGARA}:mid`, flip: true },
  { key: `${TANGARA}:cab`, flip: true },
];

/** Six for the Metro: lead-intermediate-trailer and the same three back again. */
export const METRO: readonly ConsistCar[] = [
  { key: `${METROPOLIS}:lead`, flip: false },
  { key: `${METROPOLIS}:mid`, flip: false },
  { key: `${METROPOLIS}:trail`, flip: false },
  { key: `${METROPOLIS}:trail`, flip: true },
  { key: `${METROPOLIS}:mid`, flip: true },
  { key: `${METROPOLIS}:lead`, flip: true },
];

/**
 * Carriage pitch, metres. The manifest's own numbers for the two models.
 *
 * Constants here rather than read out of `manifest.json` the way the renderer
 * does, for the reason the whole file exists: the server has no manifest and no
 * loader, and a consist whose spacing differed between the two ends would put a
 * rider in carriage 4 on one screen and between 4 and 5 on the other.
 * `verifyRiding` checks them against the manifest when one is available.
 */
export const SUBURBAN_PITCH = 20.4;
export const METRO_PITCH = 22;

/** One trip in sixteen wears the Pride livery. Must match `world/trains.PRIDE_SHARE`. */
export const PRIDE_SHARE = 16;

export interface Consist {
  cars: readonly ConsistCar[];
  pitch: number;
  pride: boolean;
  metro: boolean;
}

/** What this service is made of. A pure function of the train's own identity. */
export function consistOf(dir: RailDirection, trip: number): Consist {
  const metro = dir.line.metro;
  return {
    cars: metro ? METRO : SUBURBAN,
    pitch: metro ? METRO_PITCH : SUBURBAN_PITCH,
    pride: !metro && trainIdentity(dir, trip) % PRIDE_SHARE === 0,
    metro,
  };
}

/**
 * Arc length of carriage `k`'s centre, for a consist of `n` at `pitch` metres,
 * whose reference point is at `s`.
 *
 * Moved here from `world/trains.ts` unchanged, and its argument moves with it:
 * **the reference point is the middle of the train, not its nose.** `poseTrain`
 * answers for one point and the bake's stopping arc lengths are that point;
 * hanging the consist behind it puts a 163 m train on a 160 m platform with its
 * rear four carriages out over the points. `k = 0` is still the leading carriage.
 */
export function consistOffset(s: number, k: number, n: number, pitch: number): number {
  return s + (n / 2 - k - 0.5) * pitch;
}

/** Bogie centres, from the carriage centre. A Tangara's are 14.2 m apart. */
export const BOGIE_HALF = 7.1;

// --- The carriage frame ----------------------------------------------------------------

/**
 * An orthonormal frame: where a carriage is and which way it is pointing.
 *
 * Nine unit-vector components and an origin rather than a `Matrix4`, because
 * this is the record the *server* composes with and the server has no three.
 * The three axes are the columns of the rotation, so `localToWorld` is a matrix
 * multiply written out and `worldToLocal` is its transpose -- which is its
 * inverse, exactly, because the basis is orthonormal by construction.
 */
export interface CarFrame {
  /** Carriage centre, world metres, at rail level (local y = 0). */
  ox: number; oy: number; oz: number;
  /** +X: the nose. */
  fx: number; fy: number; fz: number;
  /** +Y: up, perpendicular to the nose. */
  ux: number; uy: number; uz: number;
  /** +Z: across, `f x u`. */
  rx: number; ry: number; rz: number;
}

export function createCarFrame(): CarFrame {
  return {
    ox: 0, oy: 0, oz: 0,
    fx: 1, fy: 0, fz: 0,
    ux: 0, uy: 1, uz: 0,
    rx: 0, ry: 0, rz: 1,
  };
}

/** Scratch for the two bogie samples. Module-level, so this allocates nothing. */
const _bogieA: TrainPose = /*#__PURE__*/ createTrainPose();
const _bogieB: TrainPose = /*#__PURE__*/ createTrainPose();

/**
 * The frame of one carriage, centred at arc length `centre` along `dir`.
 *
 * **Statement for statement what `world/trains.carMatrix` used to do**, which is
 * why that function now calls this one instead of keeping its own copy. A
 * carriage is 20 m of rigid steel on a railway that curves and climbs, so it is
 * sampled at both bogie centres and its basis is built from the two points --
 * which is what makes a train on the Meadowbank bridge climb, and what makes the
 * floor a rider walks on climb with it.
 *
 * No trigonometry. One `Math.sqrt` for the forward normalisation and one for the
 * up, both specified exactly by IEEE-754, so two engines handed the same bake
 * and the same arc length return the same bits.
 */
export function carFrameAt(
  bake: RailBake, dir: RailDirection, centre: number, flip: boolean, out: CarFrame,
): void {
  sampleAlong(bake, dir, Math.max(centre - BOGIE_HALF, 0), _bogieA);
  sampleAlong(bake, dir, centre + BOGIE_HALF, _bogieB);

  const ax = _bogieA.x;
  const ay = _bogieA.y;
  const az = _bogieA.z;
  const bx = _bogieB.x;
  const by = _bogieB.y;
  const bz = _bogieB.z;

  let fx = bx - ax;
  let fy = by - ay;
  let fz = bz - az;
  let len2 = fx * fx + fy * fy + fz * fz;
  if (len2 < 1e-6) {
    // Both bogies landed on the same vertex -- a degenerate polyline, or a
    // carriage clamped against the start of the line. Fall back to the sampled
    // heading, which is already unit and already in the plane.
    fx = _bogieB.dx;
    fy = 0;
    fz = _bogieB.dz;
    len2 = fx * fx + fy * fy + fz * fz;
    if (len2 < 1e-6) { fx = 1; fy = 0; fz = 0; len2 = 1; }
  }
  const finv = 1 / Math.sqrt(len2);
  fx *= finv;
  fy *= finv;
  fz *= finv;
  if (flip) { fx = -fx; fy = -fy; fz = -fz; }

  // Up: world up with the forward component projected out, then normalised.
  // On a 3.3% grade this leans the whole carriage the same 1.9 degrees the
  // bodyshell leans, which is the point -- a rider standing still on a climbing
  // train stands square to the floor and not to the horizon.
  let ux = -fx * fy;
  let uy = 1 - fy * fy;
  let uz = -fz * fy;
  let ulen2 = ux * ux + uy * uy + uz * uz;
  if (ulen2 < 1e-6) { ux = 0; uy = 1; uz = 0; ulen2 = 1; }
  const uinv = 1 / Math.sqrt(ulen2);
  ux *= uinv;
  uy *= uinv;
  uz *= uinv;

  out.ox = (ax + bx) / 2;
  out.oy = (ay + by) / 2;
  out.oz = (az + bz) / 2;
  out.fx = fx; out.fy = fy; out.fz = fz;
  out.ux = ux; out.uy = uy; out.uz = uz;
  out.rx = fy * uz - fz * uy;
  out.ry = fz * ux - fx * uz;
  out.rz = fx * uy - fy * ux;
}

/** A point, for the composition functions. Three fields, no class. */
export interface Vec3Out {
  x: number;
  y: number;
  z: number;
}

/** `world = origin + f*lx + u*ly + r*lz`. Nine multiplies, no trigonometry. */
export function localToWorld(f: CarFrame, lx: number, ly: number, lz: number, out: Vec3Out): void {
  out.x = f.ox + f.fx * lx + f.ux * ly + f.rx * lz;
  out.y = f.oy + f.fy * lx + f.uy * ly + f.ry * lz;
  out.z = f.oz + f.fz * lx + f.uz * ly + f.rz * lz;
}

/** The transpose, which is the inverse. See `CarFrame`. */
export function worldToLocal(f: CarFrame, wx: number, wy: number, wz: number, out: Vec3Out): void {
  const dx = wx - f.ox;
  const dy = wy - f.oy;
  const dz = wz - f.oz;
  out.x = dx * f.fx + dy * f.fy + dz * f.fz;
  out.y = dx * f.ux + dy * f.uy + dz * f.uz;
  out.z = dx * f.rx + dy * f.ry + dz * f.rz;
}

/**
 * The world yaw of a carriage's own +X axis, radians.
 *
 * A rider's world yaw is `localYaw + frameYaw(frame)`, which falls out of the
 * engine's convention that forward is `(-sin yaw, 0, -cos yaw)`: a local yaw of
 * zero looks down -Z, which is `-r` in world, and `r = (-fz, *, fx)` for any
 * level frame.
 *
 * **The one `Math.atan2` in the riding path, and it is quarantined here on
 * purpose.** See section 4: a world yaw is never integrated by anybody, it is
 * quantised to 1/65536 of a turn on the wire, and the server is authoritative
 * for it. The position composition above has no trigonometry in it at all.
 */
export function frameYaw(f: CarFrame): number {
  return Math.atan2(-f.fz, f.fx);
}

// --- The interior ------------------------------------------------------------------------

/** A door aperture in the side wall, both sides, in carriage-local metres. */
export interface DoorBay {
  /** Centre along the carriage. */
  x: number;
  /** Half the aperture, so the opening is `x +/- half`. */
  half: number;
}

/**
 * The double-deck saloon of a Tangara, or absent on a single-decker.
 *
 * `x0`/`x1` bound the saloon itself; the staircases occupy `stair` metres
 * outside each end of it and ramp between the vestibule floor and whichever deck
 * that half of the car serves. See section 3 for the measurement and for why the
 * split is across Z rather than along X.
 */
export interface SaloonDeck {
  x0: number;
  x1: number;
  lowerY: number;
  upperY: number;
  /** Length of each staircase along the carriage. */
  stair: number;
  /**
   * Feet height at which a body counts as being on the upper deck.
   *
   * Halfway between the two floors and not a tuned number: it is only ever asked
   * about a body that is standing on one of them or falling between them, and
   * the two are 2.1 m apart.
   */
  split: number;
}

export interface CarriageInterior {
  key: string;
  /** Interior bulkheads along the carriage. Asymmetric on a driving car -- the cab. */
  xMin: number;
  xMax: number;
  /** Interior side walls, `+/- halfWidth`. */
  halfWidth: number;
  /** The vestibule and end floor, above rail level. The door sill. */
  vestibuleY: number;
  /** Under the ceiling over the vestibule. Presentation only -- see `cameraCeiling`. */
  ceilingY: number;
  deck: SaloonDeck | null;
  doors: readonly DoorBay[];
}

/**
 * Every carriage the game can put a person inside, measured off the shipped GLBs.
 *
 * All numbers are **carriage-local**: X from the carriage centre with the nose
 * at +X, Y above rail level, Z across. That is the frame
 * `world/trains.splitModel` bakes the templates into (`-centreX`, `-railY`,
 * z-centred), so a number here and a triangle there are in the same space by
 * construction rather than by a conversion somebody has to keep right.
 *
 * The Tangara pair came out of the probe grid quoted in section 3. The
 * Metropolis is simpler in every way -- one floor at 1.23 m the length of the
 * car, ceiling at 3.40, three door bays a side -- and its door positions came
 * out of the file's own node names (`DoorLeftA`, `DoorRightB.002`, ...), which
 * that model has and the Tangara does not.
 */
const INTERIORS: readonly CarriageInterior[] = [
  {
    key: `${TANGARA}:cab`,
    // The nose end stops at the cab bulkhead: the probe found floor at 1.20 out
    // to x = 8.4 and the driver's desk beyond it. Nobody drives.
    xMin: -9.9,
    xMax: 8.3,
    halfWidth: 1.42,
    vestibuleY: 1.16,
    ceilingY: 3.58,
    deck: { x0: -4.4, x1: 3.1, lowerY: 0.39, upperY: 2.51, stair: 0.9, split: 1.45 },
    doors: [{ x: -6.19, half: 1.1 }, { x: 4.79, half: 1.1 }],
  },
  {
    key: `${TANGARA}:mid`,
    xMin: -9.4,
    xMax: 9.4,
    halfWidth: 1.4,
    vestibuleY: 1.15,
    ceilingY: 3.58,
    deck: { x0: -3.4, x1: 3.4, lowerY: 0.39, upperY: 2.51, stair: 1.2, split: 1.45 },
    doors: [{ x: -5.56, half: 1.1 }, { x: 5.56, half: 1.1 }],
  },
  {
    key: `${METROPOLIS}:lead`,
    xMin: -11.3,
    xMax: 9.0,
    halfWidth: 1.3,
    vestibuleY: 1.23,
    ceilingY: 3.4,
    deck: null,
    doors: [{ x: -6.71, half: 0.95 }, { x: -0.61, half: 0.95 }, { x: 5.49, half: 0.95 }],
  },
  {
    key: `${METROPOLIS}:mid`,
    xMin: -10.8,
    xMax: 10.8,
    halfWidth: 1.3,
    vestibuleY: 1.23,
    ceilingY: 3.4,
    deck: null,
    doors: [{ x: -6.11, half: 0.95 }, { x: -0.01, half: 0.95 }, { x: 6.09, half: 0.95 }],
  },
  {
    key: `${METROPOLIS}:trail`,
    xMin: -10.8,
    xMax: 10.8,
    halfWidth: 1.3,
    vestibuleY: 1.23,
    ceilingY: 3.4,
    deck: null,
    doors: [{ x: -6.09, half: 0.95 }, { x: 0.01, half: 0.95 }, { x: 6.11, half: 0.95 }],
  },
];

/**
 * How far a rewound passenger can be from where their history says they were.
 *
 * The diagonal of the longest carriage in `INTERIORS`, which is the bound
 * `server/sim.buildRewindIndex` needs and the reason it can be a *constant*
 * rather than a function of the train's speed. A reframed rider is
 * `frame(now) . local(then)` and `local(then)` is inside the carriage, so the
 * answer is inside that carriage now -- and so is the rider's live position, so
 * the two are at most one carriage apart however fast the railway is moving
 * underneath them. See `sim.reframeRider` for what the reframe is and
 * `buildRewindIndex` for the broadphase it broke.
 *
 * Derived from the table rather than typed in, so a longer carriage cannot make
 * it wrong by being added.
 */
export const RIDER_CARRIAGE_SPAN_M = /*#__PURE__*/ (() => {
  let worst = 0;
  for (const it of INTERIORS) {
    const span = Math.hypot(it.xMax - it.xMin, it.halfWidth * 2);
    if (span > worst) worst = span;
  }
  return Math.ceil(worst);
})();

const INTERIOR_BY_KEY = /*#__PURE__*/ (() => {
  const m = new Map<string, CarriageInterior>();
  for (const it of INTERIORS) m.set(it.key, it);
  return m;
})();

/** Every interior in the table, for the checks and the report. */
export function allInteriors(): readonly CarriageInterior[] {
  return INTERIORS;
}

/**
 * The interior for a template key, with the Pride suffix stripped.
 *
 * A Pride Tangara is the same steel in a different paint -- `splitModel` gives
 * it its own template because the *materials* differ -- so the one thing that
 * must not happen is a second interior record drifting from the first.
 */
export function interiorFor(key: string): CarriageInterior | null {
  const bare = key.endsWith('_pride') ? key.slice(0, -'_pride'.length) : key;
  return INTERIOR_BY_KEY.get(bare) ?? null;
}

/** The interior of carriage `k` of a consist, or null if the key is unknown. */
export function interiorOfCar(consist: Consist, k: number): CarriageInterior | null {
  const car = consist.cars[k];
  return car === undefined ? null : interiorFor(car.key);
}

/**
 * Floor height under a point in the carriage, in local metres above rail level.
 *
 * `feetY` distinguishes the two decks at the same `(x, z)`, which is the same
 * question and the same answer shape as `CombatWorld.groundHeight`'s -- standing
 * on a warehouse and standing beside it. See section 3 for the staircases.
 */
export function carriageFloor(
  it: CarriageInterior, lx: number, lz: number, feetY: number,
): number {
  const deck = it.deck;
  if (deck === null) return it.vestibuleY;

  if (lx >= deck.x0 && lx <= deck.x1) {
    // The saloon. Two floors, and the body's own height picks one.
    return feetY >= deck.split ? deck.upperY : deck.lowerY;
  }

  // The staircases: one ramp each side of the aisle, down on -Z and up on +Z,
  // running the `stair` metres between the saloon and the vestibule. `u` is 0 at
  // the vestibule end and 1 at the saloon end, so both ramps meet the vestibule
  // floor exactly and meet their own deck exactly.
  const target = lz < 0 ? deck.lowerY : deck.upperY;
  if (lx < deck.x0) {
    const u = (lx - (deck.x0 - deck.stair)) / deck.stair;
    if (u > 0) return it.vestibuleY + (target - it.vestibuleY) * (u < 1 ? u : 1);
    return it.vestibuleY;
  }
  const u = ((deck.x1 + deck.stair) - lx) / deck.stair;
  if (u > 0) return it.vestibuleY + (target - it.vestibuleY) * (u < 1 ? u : 1);
  return it.vestibuleY;
}

/** What `carriageResolve` writes. Same shape `CollisionWorld.resolve` returns. */
export interface CarriageMove {
  x: number;
  z: number;
  hit: boolean;
}

/**
 * Slide a body along the carriage's walls. The plan half of the interior.
 *
 * Four bulkheads, two side walls, and -- inside a stair zone -- the divider
 * between the two staircases and the enclosure that keeps each one out of the
 * deck it does not serve. Every one of them is an axis-aligned plane in the
 * carriage's own frame, so this is six clamps and two crossing tests rather than
 * a polygon sweep: about 30 ns, against `CollisionWorld.resolve`'s grid query.
 *
 * **The doorways are walls too, open or shut**, and that is a rule rather than
 * an omission. Getting off is `E` -- see `alightPlatform` and the tunnel rule --
 * because a disembark has to put a body somewhere specific and agreed by both
 * ends, and "wherever they happened to walk out of the hole" is neither.
 */
export function carriageResolve(
  it: CarriageInterior,
  fromX: number, fromZ: number,
  toX: number, toZ: number,
  radius: number,
  feetY: number,
  out: CarriageMove,
): CarriageMove {
  let x = toX;
  let z = toZ;
  let hit = false;

  const xLo = it.xMin + radius;
  const xHi = it.xMax - radius;
  const zLim = it.halfWidth - radius;
  if (x < xLo) { x = xLo; hit = true; }
  else if (x > xHi) { x = xHi; hit = true; }
  if (z < -zLim) { z = -zLim; hit = true; }
  else if (z > zLim) { z = zLim; hit = true; }

  const deck = it.deck;
  if (deck !== null) {
    // The divider down the middle of a stair zone. Without it a body can
    // sidestep from the up-flight to the down-flight across a 2.1 m gap.
    const inStair = (v: number): boolean =>
      (v < deck.x0 && v >= deck.x0 - deck.stair) || (v > deck.x1 && v <= deck.x1 + deck.stair);
    if ((fromZ < 0) !== (z < 0) && (inStair(fromX) || inStair(x))) {
      z = fromZ < 0 ? -radius : radius;
      hit = true;
    }
    // And the staircase enclosures, which is the rule that makes the floor
    // continuous everywhere a body can reach: a person on the lower deck cannot
    // walk into the up-flight (it is over their head), and a person on the upper
    // deck cannot walk into the down-flight (it is under their feet). Both are
    // the wall the real staircase has.
    const upper = feetY >= deck.split;
    const barred = (side: number): boolean => (side >= 0) !== upper;
    if (barred(z)) {
      if (fromX >= deck.x0 && x < deck.x0) { x = deck.x0 + radius; hit = true; }
      else if (fromX <= deck.x1 && x > deck.x1) { x = deck.x1 - radius; hit = true; }
      else if (fromX < deck.x0 && x >= deck.x0) { x = deck.x0 - radius; hit = true; }
      else if (fromX > deck.x1 && x <= deck.x1) { x = deck.x1 + radius; hit = true; }
    }
  }

  out.x = x;
  out.z = z;
  out.hit = hit;
  return out;
}

/**
 * A `CombatWorld` whose city is one carriage. Allocated once, aimed per body.
 *
 * Structurally a `CombatWorld` without importing one -- `game/combat.ts` imports
 * *this* file for `AboardSlot`, so the arrow cannot point back. `collision` is
 * `null` on purpose and `mover` stands in for it: a rider must not be stopped by
 * the warehouse the train is passing through, and must not be able to walk out
 * through the bodyside at 130 km/h. See `combat.moverOf`.
 *
 * One of these is enough per simulation, because it is only ever read inside a
 * single synchronous `advance` -- `aim` it at the interior, step, and it is free
 * again. The closures are made once here rather than per tick, which is the
 * whole reason it is an object and not a function that returns a literal.
 */
export interface CarriageStand {
  collision: null;
  mover: { resolve(fromX: number, fromZ: number, toX: number, toZ: number, radius: number, feetY: number, headY?: number): CarriageMove };
  groundHeight(x: number, z: number, feetY: number): number;
  /** What it is currently aimed at. Null means nothing is aboard. */
  interior: CarriageInterior | null;
}

export function createCarriageStand(): CarriageStand {
  const move: CarriageMove = { x: 0, z: 0, hit: false };
  const stand: CarriageStand = {
    collision: null,
    interior: null,
    mover: {
      resolve(fromX, fromZ, toX, toZ, radius, feetY) {
        const it = stand.interior;
        if (it === null) {
          move.x = toX;
          move.z = toZ;
          move.hit = false;
          return move;
        }
        return carriageResolve(it, fromX, fromZ, toX, toZ, radius, feetY, move);
      },
    },
    groundHeight(x, z, feetY) {
      const it = stand.interior;
      // No interior means no floor, and falling out of the bottom of a carriage
      // is a better failure than standing on an invisible one: the enter/exit
      // rule ends the ride the moment anything moves the body in world space,
      // so a body here is already on its way out.
      return it === null ? -1000 : carriageFloor(it, x, z, feetY);
    },
  };
  return stand;
}

/** Which door bay `lx` is inside, or -1. `slack` widens the aperture. */
export function doorBayAt(it: CarriageInterior, lx: number, slack = 0): number {
  for (let i = 0; i < it.doors.length; i++) {
    const d = it.doors[i];
    if (lx >= d.x - d.half - slack && lx <= d.x + d.half + slack) return i;
  }
  return -1;
}

/** Is this local point inside the carriage shell at all? Used by the camera clamp. */
export function insideCarriage(it: CarriageInterior, lx: number, ly: number, lz: number): boolean {
  return (
    lx >= it.xMin && lx <= it.xMax &&
    lz >= -it.halfWidth && lz <= it.halfWidth &&
    ly >= -0.5 && ly <= it.ceilingY + (it.deck === null ? 0 : 1.0)
  );
}

// --- The platforms, as arithmetic rather than as geometry ---------------------------------

/** `world/rail-geo.PLATFORM_HALF_LENGTH` and `PLATFORM_WIDTH`, restated with the other two. */
export const PLATFORM_HALF_LENGTH_M = 80;
export const PLATFORM_WIDTH_M = 5.5;

/**
 * One platform site: where a train stops, and which way the platform runs.
 *
 * Derived from `dir.stops[k].s` -- the arc length at which that service stands --
 * so the platform is *by construction* where its own trains stop, which is the
 * invariant `world/rail-geo.verifyRailGeometry` has to assert about the geometry
 * it builds by a different route.
 */
export interface PlatformSite {
  name: string;
  x: number;
  z: number;
  /** Rail level. The surface is `y + PLATFORM_TOP_M`. */
  y: number;
  /** Unit plan heading of the track here. The platform runs along it. */
  ux: number;
  uz: number;
}

/**
 * Are these two calling stops served by **one** platform pair?
 *
 * ---------------------------------------------------------------------------
 * THIS WAS A CIRCLE, AND A PLATFORM IS NOT ROUND.
 *
 * The rule used to be "the same name within `PLATFORM_HALF_LENGTH_M`", measured
 * as a plain radius, and the reason it was wrong is the shape of the thing it
 * was deciding about. A platform is 160 m long and 5.5 m wide: two anchors 30 m
 * apart **along** the track are one platform, and two anchors 30 m apart
 * **across** the formation are two platforms with three other tracks between
 * them. A radius cannot tell those apart, so it merged them, and the second
 * service then had no platform anywhere in the field.
 *
 * Measured on this bake: `surfaceAt` answered `-Infinity` for a rider stepping
 * off an M1 at Epping (its own anchor 26 m across from the T9 anchor that
 * swallowed it), a T8 at St James (22 m from T2's), an M1 at Chatswood (8 m
 * from T1's) and a T5 at Canley Vale (6 m from T2's, and *inside* its inner
 * face rather than outside its outer one). `alightPlatform` then silently left
 * the body at the carriage's own rail level and `groundFor` fell through to the
 * terrain -- the paddock over the cutting -- which is what
 * "the platform field puts a surface at -Infinity" was reporting.
 *
 * So the test is the platform's own frame: `along` inside its length, and
 * `across` inside its outer face. That reads as one sentence -- *this stop
 * stands at a platform we have already built* -- and it keeps the merge the
 * radius was there for. The up and down roads of a double-track station are
 * 4-5 m apart and still merge into the one island `writePlatforms` draws
 * between them; Meadowbank's two anchors 471 m up the corridor still do not.
 *
 * `world/rail-geo.ts` builds its drawn prisms from the identical predicate, so
 * the rectangles a body stands on and the rectangles a body sees are the same
 * set by construction rather than by two rules somebody has to keep in step.
 */
export function samePlatform(
  other: { x: number; z: number; ux: number; uz: number },
  site: { x: number; z: number },
): boolean {
  const dx = site.x - other.x;
  const dz = site.z - other.z;
  const along = dx * other.ux + dz * other.uz;
  const across = dx * -other.uz + dz * other.ux;
  return (
    along > -PLATFORM_HALF_LENGTH_M && along < PLATFORM_HALF_LENGTH_M &&
    across > -(PLATFORM_INNER_M + PLATFORM_WIDTH_M) &&
    across < PLATFORM_INNER_M + PLATFORM_WIDTH_M
  );
}

/**
 * Every platform in Sydney, as a grid of rectangles, and what height each is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, WHICH IS A BUG THE RIDING ROUND INHERITED RATHER THAN MADE.
 *
 * `world/rail-geo.RailWorld` builds platforms as prisms and hands them to the
 * browser's `CollisionWorld`, so on a client a platform is a thing you stand on:
 * `main.ts`'s `groundHeightAt` folds in `collision.roofHeight` and gets 1.05 m
 * over the rail. **The server has never had them.** It loads tiles from the
 * pipeline and the pipeline does not emit platform prisms -- they are built at
 * runtime, from the bake, by a module that imports three and therefore cannot
 * run in the server process at all.
 *
 * So the two ends have always disagreed about the height of every platform in
 * the city by about a metre, and the symptom is a player standing on one being
 * dragged down through it at the correction rate. Nobody noticed because until
 * trains were rideable there was no reason to stand on a platform.
 *
 * Riding gives it two reasons a round: you wait on one to board, and you are put
 * on one when you get off. So the platform stops being geometry and becomes
 * **arithmetic that both ends run** -- five constants and a rectangle test,
 * three-free, off the same bake the browser draws from. The client folds it in
 * beside its prisms and gets the same answer twice; the server folds it in and
 * gets it for the first time.
 *
 * ---------------------------------------------------------------------------
 * A site is a *calling stop*, not a station node. `dir.stops[k].s` is the arc
 * length the service stands at, so `sampleAlong` gives the position, the rail
 * height and the heading in one call with nothing to search and nothing to
 * match up. Sites of the same name that stand at the same platform are one site
 * -- `samePlatform` above is that test and `rail-geo.ts` merges its drawn
 * prisms with the same one, since a station whose services stop at two ends of a
 * long platform is one platform and not two, and a station whose services stop
 * on tracks thirty metres apart is not.
 */
export class PlatformField {
  private readonly cells = new Map<number, PlatformSite[]>();
  readonly sites: PlatformSite[] = [];
  /** Grid pitch. One platform is 160 m long, so a query touches at most four cells. */
  private static readonly CELL = 128;

  private static key(cx: number, cz: number): number {
    // A single integer key rather than a string, because this is asked once per
    // player per tick on the server and once per frame on the client.
    return (cx & 0xffff) * 65536 + (cz & 0xffff);
  }

  add(site: PlatformSite): void {
    for (const other of this.sites) {
      if (other.name !== site.name) continue;
      if (samePlatform(other, site)) return;
    }
    this.sites.push(site);
    // Filed into every cell the platform's own 160 x 14 m footprint can touch,
    // which is a box rather than a point: a site indexed only by its centre
    // would be missed by a query 70 m along the platform from it.
    const r = PLATFORM_HALF_LENGTH_M + PLATFORM_INNER_M + PLATFORM_WIDTH_M;
    const x0 = Math.floor((site.x - r) / PlatformField.CELL);
    const x1 = Math.floor((site.x + r) / PlatformField.CELL);
    const z0 = Math.floor((site.z - r) / PlatformField.CELL);
    const z1 = Math.floor((site.z + r) / PlatformField.CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = PlatformField.key(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(site);
        else this.cells.set(k, [site]);
      }
    }
  }

  /**
   * The highest platform surface over a point, ignoring who is asking.
   *
   * `heightAt` below is the question "am I standing on a platform", and it is a
   * band for the reasons it gives. This is the different question "is there a
   * platform here, and how high is it" -- asked by the one caller that is
   * *choosing* where to put a body rather than asking what is under one, which
   * is `alightPlatform`. Passing `Infinity` to the banded version to mean "any
   * height" is the trap: `Infinity` is above the band, so it answers no.
   */
  surfaceAt(x: number, z: number): number {
    const list = this.cells.get(
      PlatformField.key(Math.floor(x / PlatformField.CELL), Math.floor(z / PlatformField.CELL)),
    );
    if (list === undefined) return -Infinity;
    let best = -Infinity;
    for (const site of list) {
      const dx = x - site.x;
      const dz = z - site.z;
      const along = dx * site.ux + dz * site.uz;
      if (along < -PLATFORM_HALF_LENGTH_M || along > PLATFORM_HALF_LENGTH_M) continue;
      const across = Math.abs(dx * -site.uz + dz * site.ux);
      if (across < PLATFORM_INNER_M || across > PLATFORM_INNER_M + PLATFORM_WIDTH_M) continue;
      const top = site.y + PLATFORM_TOP_M;
      if (top > best) best = top;
    }
    return best;
  }

  /**
   * Slide a point onto the nearest platform within `reach`, and answer its top.
   *
   * ---------------------------------------------------------------------------
   * WHY A DISEMBARK MAY NOT SIMPLY *ASK* WHETHER IT LANDED ON A PLATFORM.
   *
   * `alightPlatform` composes where a rider steps out in the **carriage's**
   * frame -- 2.97 m off its own centreline, level with a door bay -- and then
   * asks `surfaceAt` how high the platform there is. Those are two different
   * frames, and on a curve they are not the same frame: a carriage can be 76 m
   * from the stop's own anchor, and 76 m of a curving railway rotates the
   * carriage's "sideways" out of the platform's by more than the 1.35 m of
   * margin the composition has. Measured on this bake, a rider stepping off a T1
   * at Central lands 1.59 m from the platform's axis against a 1.62 m inner
   * face: **three centimetres inside it**, which the rectangle test answers with
   * `-Infinity` exactly as it answers a rider in the harbour.
   *
   * The old code then did nothing at all -- it kept the height it had composed
   * from the carriage -- so three centimetres of curve was the difference
   * between standing on Central's platform and standing on whatever the terrain
   * grid says is over the top of it. That is a *silent* fall-through, and it is
   * the shape of failure this whole class exists to remove.
   *
   * So the disembark asks the harder question: not "is there a platform under
   * this point" but "where is the platform, and put me on it". Clamping into the
   * rectangle in its own frame is total -- every point within `reach` of a site
   * has an answer -- and both ends run the identical arithmetic over the
   * identical field, so it stays a teleport the two ends agree about.
   *
   * Writes the clamped position into `out` and returns the surface, or leaves
   * `out` alone and returns `-Infinity` when there is no platform within reach.
   */
  placeOn(x: number, z: number, reach: number, out: Vec3Out): number {
    const list = this.cells.get(
      PlatformField.key(Math.floor(x / PlatformField.CELL), Math.floor(z / PlatformField.CELL)),
    );
    if (list === undefined) return -Infinity;
    // A hand's breadth inside the faces, so the point the caller is handed is
    // one `surfaceAt` would answer for rather than one sitting exactly on the
    // boundary the comparison uses.
    const INSET = 0.1;
    const lo = PLATFORM_INNER_M + INSET;
    const hi = PLATFORM_INNER_M + PLATFORM_WIDTH_M - INSET;
    const end = PLATFORM_HALF_LENGTH_M - INSET;
    let bestMove = reach;
    let bestX = 0;
    let bestZ = 0;
    let bestTop = -Infinity;
    for (const site of list) {
      const dx = x - site.x;
      const dz = z - site.z;
      let along = dx * site.ux + dz * site.uz;
      let across = dx * -site.uz + dz * site.ux;
      const side = across < 0 ? -1 : 1;
      let mag = across < 0 ? -across : across;
      if (along < -end) along = -end;
      else if (along > end) along = end;
      if (mag < lo) mag = lo;
      else if (mag > hi) mag = hi;
      across = side * mag;
      // Back out into world, and how far the body had to move to get there.
      const px = site.x + site.ux * along + -site.uz * across;
      const pz = site.z + site.uz * along + site.ux * across;
      const move = Math.hypot(px - x, pz - z);
      if (move >= bestMove) continue;
      bestMove = move;
      bestX = px;
      bestZ = pz;
      bestTop = site.y + PLATFORM_TOP_M;
    }
    if (bestTop === -Infinity) return -Infinity;
    out.x = bestX;
    out.z = bestZ;
    return bestTop;
  }

  /**
   * The platform surface over a point, or `-Infinity` where there is none.
   *
   * **`feetY` is a band, not a floor**, and that is the one non-obvious thing
   * here. `CollisionWorld.roofHeight` needs only a floor -- "is this top under
   * you" -- because a roof is always *above* the terrain and the caller takes a
   * max. A platform is not: 84 of the 288 platform sites in this bake sit below
   * the terrain grid, because 28 of the stations are underground and a dozen
   * more are in cuttings the heightfield does not model. So:
   *
   *   - below `top - PLATFORM_STEP_M` the platform is over your head -- you are
   *     under the Circular Quay viaduct -- and there is nothing here;
   *   - above `top + PLATFORM_REACH_M` you are not on this platform, you are on
   *     the street 18 m above Town Hall, and there is nothing here either;
   *   - between the two you are standing on it, or jumping on it, and its
   *     surface is the ground.
   *
   * `PLATFORM_REACH_M` is a jump: `controller.JUMP_VELOCITY` at
   * `controller.GRAVITY` apexes at 1.12 m, so 1.6 m is that plus margin and is
   * comfortably under the depth of the shallowest thing in the bake that is
   * genuinely a level below.
   *
   * The caller then treats an answer here as **replacing** the terrain rather
   * than competing with it -- see `world.groundFor` and `main.ts`'s
   * `groundHeightAt`, which say why. A max would put a passenger who has just
   * stepped off at St Leonards eleven metres over the platform they stepped
   * onto, standing on the paddock the cutting is cut into.
   */
  heightAt(x: number, z: number, feetY: number): number {
    const list = this.cells.get(
      PlatformField.key(Math.floor(x / PlatformField.CELL), Math.floor(z / PlatformField.CELL)),
    );
    if (list === undefined) return -Infinity;
    let best = -Infinity;
    for (const site of list) {
      const dx = x - site.x;
      const dz = z - site.z;
      const along = dx * site.ux + dz * site.uz;
      if (along < -PLATFORM_HALF_LENGTH_M || along > PLATFORM_HALF_LENGTH_M) continue;
      // The plan normal. Both platforms of a pair, so the sign is dropped.
      const across = Math.abs(dx * -site.uz + dz * site.ux);
      if (across < PLATFORM_INNER_M || across > PLATFORM_INNER_M + PLATFORM_WIDTH_M) continue;
      const top = site.y + PLATFORM_TOP_M;
      if (feetY < top - PLATFORM_STEP_M || feetY > top + PLATFORM_REACH_M) continue;
      if (top > best) best = top;
    }
    return best;
  }
}

/** `controller.STEP_HEIGHT`, restated. How far under a platform still counts as on it. */
export const PLATFORM_STEP_M = 0.42;
/**
 * And how far over one. A standing jump apexes at 1.12 m; this is that plus margin.
 *
 * The number that separates "on the platform" from "on the street above the
 * station", which is the whole reason `PlatformField.heightAt` is a band. See it.
 */
export const PLATFORM_REACH_M = 1.6;

/**
 * Build the platform field from the bake. Once, at boot, on both ends.
 *
 * Every calling stop of every direction, which over-counts before the merge --
 * the same station is a stop on both directions of every line through it -- and
 * lands on the real number afterwards. 214 calls one way over ten lines
 * collapses to a few hundred sites, and the whole structure is a few tens of
 * kilobytes.
 */
export function buildPlatforms(bake: RailBake): PlatformField {
  const field = new PlatformField();
  const at = createTrainPose();
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      for (const stop of dir.stops) {
        if (!stop.calls) continue;
        sampleAlong(bake, dir, stop.s, at);
        field.add({ name: stop.name, x: at.x, z: at.z, y: at.y, ux: at.dx, uz: at.dz });
      }
    }
  }
  return field;
}

// --- Inside the station, which until now was nowhere ---------------------------------

/**
 * How much headroom under the terrain still counts as being inside the box.
 *
 * A body at Town Hall stands 20 m under George Street and a body *on* George
 * Street stands on George Street, and the two must never be confused. So the
 * box answers only below its own lid less this: at the lid you are in the
 * street, a metre and a half under it you are in the station.
 */
export const BOX_HEADROOM_M = 1.5;

/**
 * The least a box may be from floor to lid before it is not a room.
 *
 * `BOX_HEADROOM_M` already takes 1.5 m off the top and `PLATFORM_STEP_M` gives
 * 0.42 m under the floor, so a box shallower than this answers over a band
 * narrower than a stride -- which is not a station, it is a tripwire. Four
 * metres is a platform, a person and the wires over them.
 */
export const BOX_MIN_HEIGHT_M = 4;

/**
 * The volume a body may legitimately be inside, per station.
 *
 * ---------------------------------------------------------------------------
 * THE BUG THIS EXISTS FOR, IN THE PLAYER'S OWN WORDS.
 *
 * *"moving anywhere on foot underground tps me to surface"*.
 *
 * It is not a teleport and nothing rescues anybody: it is the **ground query**,
 * and it was right about everything it knew. `main.ts`'s `groundHeightAt` and
 * `server/world.groundFor` ask three things in order -- am I on a platform
 * (`PlatformField`), am I in a carved cutting (`RailCut.cutAt`), otherwise the
 * terrain. Inside an underground station box the first answers only within a
 * step of the platform edge, and the second **declines by design**: `cutAt`
 * refuses on a `SPAN_TUNNEL` strip, because a bore has no surface expression
 * and carving a hole down to it would open the city to the sky. So one pace off
 * the platform, the answer fell through to the DEM -- twenty metres up -- and
 * the controller put the body's feet on it, every frame, on both ends of the
 * wire at once. Walking off a platform at Town Hall was walking up a lift
 * shaft.
 *
 * Neither of the two existing fields can answer it. A platform is 5.5 m wide
 * and a station box is thirty; a cutting is open to the sky and a box is not.
 * This is the third question -- **am I inside the station** -- and it is the one
 * that makes the other two mean what they say.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS AN ORIENTED BOX AND NOT A RADIUS.
 *
 * `PlatformField` learned this the expensive way (see `samePlatform`): a
 * station is 160-360 m long and thirty wide, so a radius that reaches the far
 * end of the platform also reaches the street two blocks over, and a radius
 * that does not reach the street does not reach the platform either. The bake
 * emits the site, the heading along the track and the two half-extents; this
 * tests `along` and `across` in the station's own frame, which is the same
 * shape and the same arithmetic the platform test uses.
 *
 * Built from `bake.stations` rather than from geometry, on `PlatformField`'s
 * own argument: the server has no renderer and must reach the identical answer,
 * or a client that walks across a concourse is a client the server drags back
 * up through the roof.
 */
export interface StationBox {
  name: string;
  x: number;
  z: number;
  ux: number;
  uz: number;
  halfLength: number;
  halfWidth: number;
  /** The platform surface: the floor a body inside stands on. */
  floorY: number;
  /** The terrain over the box: its lid. */
  ceilY: number;
}

export class StationBoxField {
  private readonly cells = new Map<number, StationBox[]>();
  readonly boxes: StationBox[] = [];
  /** Grid pitch. A box is at most ~400 m long, so a query touches a few cells. */
  private static readonly CELL = 128;

  private static key(cx: number, cz: number): number {
    return (cx & 0xffff) * 65536 + (cz & 0xffff);
  }

  add(box: StationBox): void {
    this.boxes.push(box);
    const r = box.halfLength + box.halfWidth;
    const x0 = Math.floor((box.x - r) / StationBoxField.CELL);
    const x1 = Math.floor((box.x + r) / StationBoxField.CELL);
    const z0 = Math.floor((box.z - r) / StationBoxField.CELL);
    const z1 = Math.floor((box.z + r) / StationBoxField.CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = StationBoxField.key(cx, cz);
        const list = this.cells.get(k);
        if (list) list.push(box);
        else this.cells.set(k, [box]);
      }
    }
  }

  /**
   * The floor under a body that is inside a station box, or `-Infinity`.
   *
   * **`feetY` is a band, exactly as `PlatformField.heightAt`'s is**, and for the
   * identical reason stated one level up: an answer here means "you are in the
   * station", never "there is a station somewhere under you". Above
   * `ceilY - BOX_HEADROOM_M` you are in the street over Town Hall and this must
   * say nothing at all, or every pedestrian in the CBD falls through the
   * pavement. Below the floor by more than a step you are under the station,
   * which is not a place, and the terrain can have you back.
   *
   * The caller treats an answer as **replacing** the terrain rather than
   * competing with it -- the same rule `PlatformField`'s answer gets, and the
   * same reason: the terrain grid here is the city twenty metres overhead.
   */
  floorAt(x: number, z: number, feetY: number): number {
    const list = this.cells.get(
      StationBoxField.key(
        Math.floor(x / StationBoxField.CELL), Math.floor(z / StationBoxField.CELL),
      ),
    );
    if (list === undefined) return -Infinity;
    let best = -Infinity;
    for (const box of list) {
      const dx = x - box.x;
      const dz = z - box.z;
      const along = dx * box.ux + dz * box.uz;
      if (along < -box.halfLength || along > box.halfLength) continue;
      const across = dx * -box.uz + dz * box.ux;
      if (across < -box.halfWidth || across > box.halfWidth) continue;
      if (feetY < box.floorY - PLATFORM_STEP_M) continue;
      if (feetY > box.ceilY - BOX_HEADROOM_M) continue;
      if (box.floorY > best) best = box.floorY;
    }
    return best;
  }

  /**
   * Is this body legitimately inside a station, rather than stuck in the world?
   *
   * The question `/unstuck` has to ask before it rescues anybody. Same
   * rectangle and the same band as `floorAt`, expressed as a predicate so a
   * caller that does not want a height does not have to compare one against
   * `-Infinity` and get the sense of the test backwards.
   */
  contains(x: number, z: number, feetY: number): boolean {
    return this.floorAt(x, z, feetY) > -Infinity;
  }
}

/**
 * Build the station boxes from the bake. Once, at boot, on both ends.
 *
 * ---------------------------------------------------------------------------
 * **A BORE GETS A BOX. A CUTTING DOES NOT**, and the difference is the whole of
 * the selection rule.
 *
 * RAIL-VERTICAL.md's table draws it: a `tunnel` station is *"a station box and a
 * shaft"* and a cutting is *"carve the terrain, trench walls"*. The carve is
 * already built and `RailCut.cutAt` already answers inside it, down to the rail
 * head -- which is the right answer there, because a cutting is open to the sky
 * and the ballast between the rails is a place a body can stand on.
 *
 * A box laid over a cutting would take that answer away. It replaces the ground
 * across its whole footprint, so a body in the four-foot at Sydenham would be
 * stood 1.05 m up in the air on a floor that only exists where the platform is.
 * Sydenham, Chatswood and Kingsgrove are all `belowGrade` and all wrong for a
 * box; the two conditions are kept together in the test so the distinction is
 * visible rather than implied.
 *
 * A station at grade and one on a viaduct get nothing here either: the terrain
 * and `PlatformField` respectively already answer, and a lid over open sky
 * would have `floorAt` answering for bodies standing in the car park.
 */
export function buildStationBoxes(bake: RailBake): StationBoxField {
  const field = new StationBoxField();
  for (const st of bake.stations) {
    if (st.vertical !== 'underground' || !st.belowGrade) continue;
    // **And a service calls there**, which is what makes the site a site. A
    // station with no calling train has no routed anchor, so the bake falls
    // back to the OSM node and the "box" is a guess around a dot -- and the
    // stations that fall into it are the CBD light-rail stops that sit over the
    // Metro bore, Chinatown and Capitol Square among them, which are pavement
    // rather than concourse. `PlatformField` is built from calling stops for
    // the same reason and this keeps the two describing the same set.
    if (!st.servedDirs || st.servedDirs.length === 0) continue;
    if (!Number.isFinite(st.boxFloorY) || !Number.isFinite(st.boxCeilY)) continue;
    // A box has to be tall enough to stand up in, or it is a slab that only
    // catches bodies in a one-metre band and reads as a hole in the ground.
    if (!(st.boxCeilY - st.boxFloorY >= BOX_MIN_HEIGHT_M)) continue;
    field.add({
      name: st.name,
      x: st.siteX,
      z: st.siteZ,
      ux: st.siteDx,
      uz: st.siteDz,
      halfLength: st.boxHalfLength,
      halfWidth: st.boxHalfWidth,
      floorY: st.boxFloorY,
      ceilY: st.boxCeilY,
    });
  }
  return field;
}

// --- Who is aboard what --------------------------------------------------------------

/**
 * A rider, as the wire and both simulations carry them.
 *
 * `line` is an index into `RailBake.lines` and `dir` is 0 or 1, which together
 * with `trip` names one train for the whole of its run. `trip` is the unbounded
 * departure index `rail.tripIndexAt` hands out -- it is an identity, never an
 * array index -- and the wire carries only its low byte, resolved back against
 * the live set on arrival. See `protocol.ABOARD_BYTES`.
 *
 * `x`, `y`, `z` are the rider's **eye** in carriage-local metres and `yaw` is
 * their heading in the carriage's own frame. Nothing here is a world quantity.
 */
export interface AboardRef {
  line: number;
  dir: number;
  trip: number;
  car: number;
}

/** `-1` in the line field is the whole of "on foot". */
export const NOT_ABOARD = -1;

/** The direction record a reference names, or null if the bake does not have it. */
export function dirOf(bake: RailBake, line: number, dir: number): RailDirection | null {
  const l = bake.lines[line];
  if (l === undefined) return null;
  return l.dirs[dir] ?? null;
}

/** Which index in `bake.lines` a direction's line sits at, or -1. */
export function lineIndexOf(bake: RailBake, dir: RailDirection): number {
  for (let i = 0; i < bake.lines.length; i++) if (bake.lines[i] === dir.line) return i;
  return -1;
}

/** Scratch pose for the frame resolvers. Module-level; nothing here allocates. */
const _pose: TrainPose = /*#__PURE__*/ createTrainPose();

/**
 * The frame of the carriage a rider is in, at rail-clock second `t`.
 *
 * False when that trip is not running -- which is the one way a ride ends
 * without anybody pressing anything, and both ends have to handle it: a train
 * that has reached its terminus stops existing, and the passenger has to be put
 * on the platform rather than left composing against a pose that returns false.
 * See `sim.resolveAboard`.
 */
export function aboardFrame(
  bake: RailBake, ref: AboardRef, t: number, out: CarFrame,
): boolean {
  const dir = dirOf(bake, ref.line, ref.dir);
  if (dir === null) return false;
  if (!poseTrain(bake, dir, ref.trip, t, _pose)) return false;
  const consist = consistOf(dir, ref.trip);
  if (ref.car < 0 || ref.car >= consist.cars.length) return false;
  const centre = consistOffset(_pose.s, ref.car, consist.cars.length, consist.pitch);
  if (centre < 0) return false;
  carFrameAt(bake, dir, centre, consist.cars[ref.car].flip, out);
  return true;
}

/** The train pose a rider is riding, or null. Reads the same scratch `aboardFrame` does. */
export function aboardPose(bake: RailBake, ref: AboardRef, t: number): TrainPose | null {
  const dir = dirOf(bake, ref.line, ref.dir);
  if (dir === null) return null;
  if (!poseTrain(bake, dir, ref.trip, t, _pose)) return null;
  return _pose;
}

/**
 * A combatant's ride, held on the combatant and mutated in place.
 *
 * One record per player, allocated once by `combat.createCombatant` and never
 * replaced -- `null` would be tidier to read and would allocate on every
 * boarding, which is a garbage-collector pause during the one moment the feature
 * is on screen. `line < 0` is the whole of "on foot", exactly as
 * `CombatantState.ridingBike === 0` is.
 *
 * The last six fields are the bookkeeping that makes the enter/exit conversion
 * safe against the rest of the game. See `enterLocal`.
 */
export interface AboardSlot extends AboardRef {
  /** `NOT_ABOARD` when on foot. */
  line: number;
  dir: number;
  trip: number;
  car: number;
  /** The rider's **eye**, carriage-local metres. The authority; world is derived. */
  x: number;
  y: number;
  z: number;
  /** Heading in the carriage's own frame. World yaw is `yaw + frameYaw(frame)`. */
  yaw: number;
  /**
   * Carriage-local velocity, metres a second.
   *
   * **Never contains the train's own motion**, and that is the rule the whole
   * design rests on -- see section 1. A rider standing still in a carriage doing
   * 130 km/h has a velocity of zero here, which is also what makes them play the
   * idle animation rather than sprint on the spot.
   */
  vx: number;
  vy: number;
  vz: number;
  /** What `exitLocal` last wrote into the body. See `enterLocal` for what it is for. */
  wx: number;
  wy: number;
  wz: number;
  wvx: number;
  wvy: number;
  wvz: number;
}

export function createAboardSlot(): AboardSlot {
  return {
    line: NOT_ABOARD, dir: 0, trip: 0, car: 0,
    x: 0, y: 0, z: 0, yaw: 0,
    vx: 0, vy: 0, vz: 0,
    wx: 0, wy: 0, wz: 0, wvx: 0, wvy: 0, wvz: 0,
  };
}

export function isAboard(a: AboardSlot): boolean {
  return a.line >= 0;
}

export function clearAboard(a: AboardSlot): void {
  a.line = NOT_ABOARD;
  a.vx = 0;
  a.vy = 0;
  a.vz = 0;
}

/** Copy one slot's ride into another. `net/client.ts` adopts the server's this way. */
export function copyAboard(from: AboardSlot, to: AboardSlot): void {
  to.line = from.line;
  to.dir = from.dir;
  to.trip = from.trip;
  to.car = from.car;
  to.x = from.x;
  to.y = from.y;
  to.z = from.z;
  to.yaw = from.yaw;
  to.vx = from.vx;
  to.vy = from.vy;
  to.vz = from.vz;
}

/** Just the rotation, for a velocity or any other free vector. */
export function localToWorldDir(
  f: CarFrame, lx: number, ly: number, lz: number, out: Vec3Out,
): void {
  out.x = f.fx * lx + f.ux * ly + f.rx * lz;
  out.y = f.fy * lx + f.uy * ly + f.ry * lz;
  out.z = f.fz * lx + f.uz * ly + f.rz * lz;
}

export function worldToLocalDir(
  f: CarFrame, wx: number, wy: number, wz: number, out: Vec3Out,
): void {
  out.x = wx * f.fx + wy * f.fy + wz * f.fz;
  out.y = wx * f.ux + wy * f.uy + wz * f.uz;
  out.z = wx * f.rx + wy * f.ry + wz * f.rz;
}

/** The minimum a body needs to be moved through local space and back. `PlayerState` fits. */
export interface RiderBody {
  position: Vec3Out;
  velocity: Vec3Out;
  yaw: number;
}

const _tmp: Vec3Out = { x: 0, y: 0, z: 0 };

/**
 * Put the body into carriage-local space for the step. False means the ride ended.
 *
 * **This is the seam that lets the rest of the game go on knowing nothing about
 * trains**, and the last six fields of `AboardSlot` are why it works. Between
 * one tick's `exitLocal` and the next tick's `enterLocal`, the body holds a
 * *world* position and a *world* velocity, and anything in the game is free to
 * write to them -- a bat's knockback, a football, a Camry, `/unstuck`, a respawn,
 * a server correction. This function reads what is there and decides what it
 * meant:
 *
 *   - **The position was changed.** Somebody teleported this body -- respawn,
 *     unstuck, teleport, a hard snap in the reconciler. That ends the ride, and
 *     ending it here means every one of those paths gets a rider off the train
 *     without ever having heard of one. It is the same argument
 *     `combat.advance` makes for sweeping `ridingBike = 0` in the knockout
 *     branch rather than clearing it at each of the four places a knockout comes
 *     from: one level, swept every tick, beats N sites somebody has to remember.
 *   - **Only the velocity was changed.** An impulse landed. It is a world vector,
 *     so it is rotated whole into the carriage's frame and the ride continues --
 *     which is what makes being punched on a train knock you down the aisle
 *     rather than through the wall.
 *   - **Neither.** The stored local velocity is restored bit for bit, because
 *     the comparison is on doubles that were written from each other and are
 *     therefore identical. Nothing is re-derived and nothing drifts.
 */
export function enterLocal(a: AboardSlot, body: RiderBody, f: CarFrame): boolean {
  const p = body.position;
  if (p.x !== a.wx || p.y !== a.wy || p.z !== a.wz) return false;

  const v = body.velocity;
  if (v.x !== a.wvx || v.y !== a.wvy || v.z !== a.wvz) {
    worldToLocalDir(f, v.x, v.y, v.z, _tmp);
    a.vx = _tmp.x;
    a.vy = _tmp.y;
    a.vz = _tmp.z;
  }

  p.x = a.x;
  p.y = a.y;
  p.z = a.z;
  v.x = a.vx;
  v.y = a.vy;
  v.z = a.vz;
  body.yaw = a.yaw;
  return true;
}

/**
 * Take the stepped body back out into world space, and record what was written.
 *
 * The world position handed back is the composition and nothing else; the world
 * velocity is the local velocity rotated, **with the train's own velocity
 * deliberately left out of it**. That is section 1's rule made concrete, and the
 * consequence is worth stating: a rider's `planSpeed` is their walking speed, so
 * they idle when they stand still and walk when they walk, on a floor doing
 * 130 km/h. Adding the train's 36 m/s would have every passenger in Sydney
 * sprinting on the spot, and would put a 36 m/s seed into the reconciler's
 * acceleration ramp -- the exact shape of the bug `checkAccelerationRamp` exists
 * to catch.
 */
export function exitLocal(a: AboardSlot, body: RiderBody, f: CarFrame): void {
  const p = body.position;
  const v = body.velocity;
  a.x = p.x;
  a.y = p.y;
  a.z = p.z;
  a.vx = v.x;
  a.vy = v.y;
  a.vz = v.z;
  a.yaw = body.yaw;

  localToWorld(f, a.x, a.y, a.z, _tmp);
  p.x = _tmp.x;
  p.y = _tmp.y;
  p.z = _tmp.z;
  localToWorldDir(f, a.vx, a.vy, a.vz, _tmp);
  v.x = _tmp.x;
  v.y = _tmp.y;
  v.z = _tmp.z;
  body.yaw = a.yaw + frameYaw(f);

  a.wx = p.x;
  a.wy = p.y;
  a.wz = p.z;
  a.wvx = v.x;
  a.wvy = v.y;
  a.wvz = v.z;
}

/**
 * Write the derived world position into a body without disturbing the ride.
 *
 * For the two callers that need a rider's world position outside the tick loop:
 * the client adopting a remote's snapshot, and anything that has to place a
 * body it is not stepping. `exitLocal` is the version that also *reads* the body.
 */
export function projectAboard(a: AboardSlot, body: RiderBody, f: CarFrame): void {
  localToWorld(f, a.x, a.y, a.z, _tmp);
  body.position.x = _tmp.x;
  body.position.y = _tmp.y;
  body.position.z = _tmp.z;
  localToWorldDir(f, a.vx, a.vy, a.vz, _tmp);
  body.velocity.x = _tmp.x;
  body.velocity.y = _tmp.y;
  body.velocity.z = _tmp.z;
  body.yaw = a.yaw + frameYaw(f);
  a.wx = body.position.x;
  a.wy = body.position.y;
  a.wz = body.position.z;
  a.wvx = body.velocity.x;
  a.wvy = body.velocity.y;
  a.wvz = body.velocity.z;
}

// --- Boarding ----------------------------------------------------------------------------

/**
 * How far outside a door a body may stand and still be offered the ride.
 *
 * Measured from the carriage's own **side wall**, not from the track centre, so
 * it means the same thing on a 3.16 m Tangara and a 3.05 m Metropolis.
 * `PLATFORM_INNER_M` puts the platform face 1.62 m off the track centre and the
 * bodyside is at about 1.45, so 3 m is "anywhere in the first three paces of the
 * platform" -- which is where somebody waiting for a train stands, and is a
 * little over half the 5.5 m the platform is wide.
 *
 * 2.2 was tried first, from the geometry alone: doorway plus one step. It is
 * *correct* and it plays badly -- the tool that drops you on a platform drops
 * you in the middle of it, which is where a person stands, and from there the
 * doors are 3 m away and the prompt never appears. A reach a player has to hunt
 * for is a feature they report as broken.
 *
 * The server tests the identical number against its own position, which is the
 * whole of why a client cannot board from the harbour, and `BOARD_RISE_M` is
 * what stops anybody boarding from under a viaduct.
 */
export const BOARD_REACH_M = 3;

/** And how far above or below the carriage floor, so nobody boards from a bridge. */
export const BOARD_RISE_M = 2.4;

/** One boardable doorway, in the frame of the carriage it belongs to. */
export interface BoardOffer {
  line: number;
  dir: number;
  trip: number;
  car: number;
  /** The door bay index within that carriage. */
  bay: number;
  /** Where the body would stand once aboard: the **eye**, carriage-local. */
  x: number;
  y: number;
  z: number;
  /** Plan distance from the body to the doorway centre, metres. Smallest wins. */
  distance: number;
  /** The station this train is standing at, for the prompt. */
  station: string;
  /**
   * And the same doorway in **world** coordinates, at the bodyside on the side
   * the asker is standing.
   *
   * Here rather than recomposed by the caller because the caller would need the
   * carriage's frame to do it, and getting the frame means naming the trip,
   * which is the one thing a UI layer has no business doing. Reported as "its
   * not obvious where i board": a prompt that says `E` and does not say *where*
   * is a prompt for somebody who already knew.
   */
  wx: number;
  wy: number;
  wz: number;
}

export function createBoardOffer(): BoardOffer {
  return {
    line: -1, dir: 0, trip: 0, car: 0, bay: 0, x: 0, y: 0, z: 0,
    distance: Infinity, station: '', wx: 0, wy: 0, wz: 0,
  };
}

const _frame: CarFrame = /*#__PURE__*/ createCarFrame();
const _local: Vec3Out = { x: 0, y: 0, z: 0 };
const _doorAt: Vec3Out = { x: 0, y: 0, z: 0 };

/**
 * The nearest open doorway a body at `(wx, feetY, wz)` could step into, or none.
 *
 * **Both ends run this, and the server runs it against its own position.** A
 * client pressing `E` is asking a question, not making a claim: `INPUT` carries
 * one bit and a look direction and no numbers at all, exactly as it does for the
 * bikes, so the only thing a modified client can do here is press the button
 * somewhere the server disagrees about -- and get nothing.
 *
 * The scan is bounded the way `trainsNear` is: per direction, a bounding-box
 * reject before any pose is evaluated. In practice a player standing on a
 * platform is inside the box of a handful of directions and the rest cost one
 * comparison each. Only trains with their doors open are considered, so the
 * whole thing is dead code except during a fifteen-second dwell within 200 m.
 */
export function findBoarding(
  bake: RailBake,
  wx: number, feetY: number, wz: number,
  t: number,
  out: BoardOffer,
): boolean {
  out.line = -1;
  out.distance = Infinity;
  // A consist is at most 164 m long and its reference point is its middle, so a
  // train whose centre is further than this cannot have a door within reach.
  const REACH = 100;
  let found = false;

  for (let li = 0; li < bake.lines.length; li++) {
    const line = bake.lines[li];
    for (const dir of line.dirs) {
      if (
        wx + REACH < dir.minX || wx - REACH > dir.maxX ||
        wz + REACH < dir.minZ || wz - REACH > dir.maxZ
      ) continue;
      const live = Math.floor(dir.duration / line.period) + 2;
      for (let j = 0; j <= live; j++) {
        const trip = Math.floor((t - dir.offset) / line.period) - j;
        if (!poseTrain(bake, dir, trip, t, _pose)) continue;
        // Doors open is the whole gate. `poseTrain` sets it only while the curve
        // is stationary at a calling station, which is a fifteen-second window.
        if (!_pose.doorsOpen) continue;
        const dcx = _pose.x - wx;
        const dcz = _pose.z - wz;
        if (dcx * dcx + dcz * dcz > REACH * REACH) continue;

        const consist = consistOf(dir, trip);
        const n = consist.cars.length;
        for (let k = 0; k < n; k++) {
          const it = interiorFor(consist.cars[k].key);
          if (it === null) continue;
          const centre = consistOffset(_pose.s, k, n, consist.pitch);
          if (centre < 0) continue;
          carFrameAt(bake, dir, centre, consist.cars[k].flip, _frame);
          // Cheap reject before the transform: a carriage 30 m away has no door
          // within 2.2 m of anybody.
          const ddx = _frame.ox - wx;
          const ddz = _frame.oz - wz;
          if (ddx * ddx + ddz * ddz > 400) continue;

          worldToLocal(_frame, wx, feetY, wz, _local);
          const lz = _local.z;
          const side = lz < 0 ? -1 : 1;
          const outside = Math.abs(lz) - it.halfWidth;
          // Inside the shell already, or too far off the side to reach.
          if (outside > BOARD_REACH_M) continue;
          if (Math.abs(_local.y - it.vestibuleY) > BOARD_RISE_M) continue;
          const bay = doorBayAt(it, _local.x, 0.35);
          if (bay < 0) continue;

          const dx = _local.x - it.doors[bay].x;
          const distance = Math.hypot(dx, outside > 0 ? outside : 0);
          if (distance >= out.distance) continue;

          found = true;
          out.line = li;
          out.dir = dir.index;
          out.trip = trip;
          out.car = k;
          out.bay = bay;
          // Where they end up: in the doorway, one body-radius clear of the side
          // wall, on the vestibule floor, eyes up. Clamped to the bay so a body
          // reaching from the very end of the aperture does not arrive inside
          // the door pocket.
          const dh = it.doors[bay].half - RIDER_RADIUS;
          out.x = it.doors[bay].x + Math.max(-dh, Math.min(dh, dx));
          out.y = it.vestibuleY + RIDER_EYE_HEIGHT;
          out.z = side * (it.halfWidth - RIDER_RADIUS - 0.05);
          out.distance = distance;
          out.station =
            _pose.atStop >= 0 && _pose.atStop < dir.stops.length ? dir.stops[_pose.atStop].name : '';
          // The doorway itself, in world, on the platform side of the bodyside:
          // where the marker goes and where the body is being invited to walk.
          localToWorld(_frame, it.doors[bay].x, it.vestibuleY, side * (it.halfWidth + 0.35), _local);
          out.wx = _local.x;
          out.wy = _local.y;
          out.wz = _local.z;
          worldToLocal(_frame, wx, feetY, wz, _local);
        }
      }
    }
  }
  return found;
}

// --- The seam, shared ------------------------------------------------------------------
//
// `main.ts`, `server/sim.ts` and `integration-check.checkRidingOnline` all put a
// body on a train and all step it inside one, and until this section existed
// each of them wrote the sequence out by hand. That is how the feature shipped
// broken: the acceptance test wrote its *own* copy of the seam, so it was
// testing a boarding that no player could perform. The two functions below are
// the sequence, and everything else is HUD, audio and authority.

/**
 * Board the nearest open doorway, witness and all. False if there is none.
 *
 * The whole of `sim.tryBoard` minus the authority, and the whole of `main.ts`'s
 * `predictBoard` minus the notice and the chime. `frame` is written as a side
 * effect and is the carriage's frame at `t`, which the caller usually wants.
 *
 * **`projectAboard` is not optional and is the last line for a reason.** It
 * writes the derived world position *and* `AboardSlot.wx/wy/wz`, which is the
 * witness `enterLocal` reads to decide whether this body is still the one the
 * carriage put where it is. A boarding that skipped it would be undone by the
 * very next `rideEnter`. See `net/client.adoptRide`, which owed the same debt
 * and did not pay it.
 */
export function boardHere(
  bake: RailBake,
  a: AboardSlot,
  body: RiderBody & { onGround: boolean },
  t: number,
  frame: CarFrame,
  offer: BoardOffer,
  eyeHeight: number,
): boolean {
  const feetY = body.position.y - eyeHeight;
  if (!findBoarding(bake, body.position.x, feetY, body.position.z, t, offer)) return false;
  a.line = offer.line;
  a.dir = offer.dir;
  a.trip = offer.trip;
  a.car = offer.car;
  a.x = offer.x;
  a.y = offer.y;
  a.z = offer.z;
  // Standing still, in the carriage's frame, which is a body doing 130 km/h in
  // the world's. See `AboardSlot.vx`.
  a.vx = 0;
  a.vy = 0;
  a.vz = 0;
  if (!aboardFrame(bake, a, t, frame)) {
    clearAboard(a);
    return false;
  }
  // The heading they already had, in the carriage's frame, so boarding a train
  // pointing north while facing east leaves them facing east.
  a.yaw = body.yaw - frameYaw(frame);
  projectAboard(a, body, frame);
  body.onGround = true;
  return true;
}

/** `rideEnter` succeeded: the body is in the carriage and `stand` is aimed at it. */
export const RIDE_ON = 0;
/** There is no timetable. Nothing can be aboard anything. */
export const RIDE_NO_BAKE = 1;
/**
 * The trip is no longer running, or its carriage is not one this build models.
 *
 * The train reached its terminus under a passenger, or the bake changed. The
 * two ends answer this differently -- which is the whole reason the status is
 * returned rather than acted on here -- because the client waits one round trip
 * to be told where it ended up and the server *is* the telling.
 */
export const RIDE_TRIP_GONE = 2;
/**
 * The body was moved in world space since the last composition.
 *
 * `enterLocal`'s rule, and the level the whole feature is swept at: a respawn,
 * an unstuck, a teleport, a knockback snap and a bat all end a ride here
 * without any of them having heard of a train. See `enterLocal`.
 */
export const RIDE_MOVED = 3;

/**
 * Move a body into its carriage for one step. `RIDE_ON` means it is in there.
 *
 * **Nothing is cleared here, and no body is relocated.** This function reports;
 * the caller decides. That split is not fastidiousness -- it is the one place
 * the two simulations legitimately differ, and folding the policy in was how
 * they came to differ in ways nobody meant. On `RIDE_TRIP_GONE` the server puts
 * the passenger on the last platform the trip called at and the client leaves
 * the body where it is for a round trip; on `RIDE_MOVED` both simply stop being
 * aboard, because whatever moved the body has already put it somewhere.
 *
 * `stand` is aimed at the interior on success and the caller passes it straight
 * to `combat.advance` as the world. `exitLocal` is the other half and must be
 * called if and only if this returned `RIDE_ON`.
 */
export function rideEnter(
  bake: RailBake | null,
  a: AboardSlot,
  body: RiderBody,
  t: number,
  frame: CarFrame,
  stand: CarriageStand,
): number {
  stand.interior = null;
  if (bake === null) return RIDE_NO_BAKE;
  if (!aboardFrame(bake, a, t, frame)) return RIDE_TRIP_GONE;
  if (!enterLocal(a, body, frame)) return RIDE_MOVED;
  const dir = dirOf(bake, a.line, a.dir);
  const it = dir === null ? null : interiorOfCar(consistOf(dir, a.trip), a.car);
  if (it === null) {
    // The body is in local coordinates and there is nothing to be local to. Put
    // it back before letting go of it, which is what `exitLocal` is for.
    exitLocal(a, body, frame);
    return RIDE_TRIP_GONE;
  }
  stand.interior = it;
  return RIDE_ON;
}

/**
 * The nearest open doorway *whether or not it is in reach*, and by how much it is not.
 *
 * A diagnostic, and the only reason it is in this file rather than in the
 * console tool that calls it is that it has to ask the same three questions
 * `findBoarding` asks, in the same order, against the same numbers. "E does
 * nothing" has three causes -- no train is standing here, the doors are shut,
 * you are not beside a door -- and from outside they are indistinguishable.
 *
 * `main.ts`'s `sydney.rail.ride()` prints it. Nothing in the game reads it.
 */
export interface DwellReport {
  line: string;
  station: string;
  car: number;
  /** Plan distance to the doorway centre, metres. */
  metres: number;
  /** How far along the bay, and how far outside the bodyside, and the rise. */
  alongBay: number;
  outside: number;
  rise: number;
  /** The doorway in world, on the side the asker is standing. See `BoardOffer.wx`. */
  wx: number;
  wy: number;
  wz: number;
}

export function nearestDwell(
  bake: RailBake, wx: number, feetY: number, wz: number, t: number,
): DwellReport | null {
  let best: DwellReport | null = null;
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      if (wx + 300 < dir.minX || wx - 300 > dir.maxX || wz + 300 < dir.minZ || wz - 300 > dir.maxZ) {
        continue;
      }
      const live = Math.floor(dir.duration / line.period) + 2;
      for (let j = 0; j <= live; j++) {
        const trip = Math.floor((t - dir.offset) / line.period) - j;
        if (!poseTrain(bake, dir, trip, t, _pose)) continue;
        if (!_pose.doorsOpen) continue;
        const consist = consistOf(dir, trip);
        for (let k = 0; k < consist.cars.length; k++) {
          const it = interiorFor(consist.cars[k].key);
          if (it === null) continue;
          const centre = consistOffset(_pose.s, k, consist.cars.length, consist.pitch);
          if (centre < 0) continue;
          carFrameAt(bake, dir, centre, consist.cars[k].flip, _frame);
          worldToLocal(_frame, wx, feetY, wz, _local);
          for (const bay of it.doors) {
            const dx = _local.x - bay.x;
            const outside = Math.abs(_local.z) - it.halfWidth;
            const metres = Math.hypot(dx, outside);
            if (best !== null && metres >= best.metres) continue;
            best = {
              line: line.id,
              station: _pose.atStop >= 0 ? dir.stops[_pose.atStop].name : '?',
              car: k,
              metres,
              alongBay: dx,
              outside,
              // The third test, and the only one that is not obvious from the
              // other two: a body under the viaduct a train is crossing is
              // beside its doors in plan and nowhere near them in fact.
              rise: _local.y - it.vestibuleY,
              wx: 0, wy: 0, wz: 0,
            };
            localToWorld(
              _frame, bay.x, it.vestibuleY, (_local.z < 0 ? -1 : 1) * (it.halfWidth + 0.35), _doorAt,
            );
            best.wx = _doorAt.x;
            best.wy = _doorAt.y;
            best.wz = _doorAt.z;
          }
        }
      }
    }
  }
  return best;
}

// --- Solving for a dwell, which is what makes riding testable ------------------------------

/**
 * One service standing at one platform: when, which train, and which door.
 *
 * **Solved, never polled**, and that is the whole reason this type exists. Every
 * service is periodic and every dwell is a phase of the distance-time curve with
 * `v0 = 0`, so "when will a train next have its doors open at Erskineville" is
 * one `Math.ceil` per calling service rather than a loop over the clock. A
 * harness that waited for a train to turn up would take four minutes to find out
 * that boarding is broken; this takes a microsecond to find out *when*.
 */
export interface Dwell {
  /** Index into `RailBake.lines`, and the direction and departure. */
  line: number;
  dir: number;
  trip: number;
  /** Which carriage of that consist, and which of its door bays. */
  car: number;
  bay: number;
  /** Rail-clock seconds: when the doors open and when they shut. */
  opensAt: number;
  closesAt: number;
  lineId: string;
  towards: string;
  station: string;
}

/**
 * When this service's doors are actually open at its `call`-th calling stop --
 * as ages into the trip -- or null where it does not stand there at all.
 *
 * ---------------------------------------------------------------------------
 * **`dir.arrivals[k]` IS NOT THE START OF A DWELL, AND AT TWO OF THEM IT IS THE
 * OPPOSITE OF ONE.** That assumption is the whole of a bug that put players on
 * platforms beside trains that had already left.
 *
 * `arrivals[k]` is when the curve *reaches* stop `k`. At every intermediate
 * stop the curve then holds still for `physics.dwell` -- a phase with `v0 = 0`
 * and `a = 0`, which is the only representation of a stop there is -- and
 * `poseTrain` opens the doors for exactly that phase. But:
 *
 *   - **at the origin `arrivals[0] = 0`, and phase 0 is `(v0 = 0, a = +1)`**:
 *     the train departs at age zero and there is no stand in front of it. A
 *     solver that added `dwell` to it claimed a fifteen-second dwell that the
 *     railway never has, and by fifteen seconds in the train is 110 m up the
 *     track doing 53 km/h.
 *   - at the terminus `arrivals[n-1] = duration`, and the trip ends there.
 *
 * So the window is read off the curve rather than assumed from the arrival: the
 * phase containing the arrival must be a *stationary* one, and a later phase
 * must exist for the train to leave in. Then `nextDwell` can only ever offer a
 * dwell `poseTrain` agrees is one, which is the property the whole boarding
 * path rests on -- `findBoarding` gates on `pose.doorsOpen` and nothing else.
 *
 * The same lookup `poseTrain` and `dwellElapsed` do, over the same table.
 */
export function stopDwell(
  bake: RailBake, dir: RailDirection, call: number,
): { opens: number; closes: number } | null {
  if (call < 0 || call >= dir.arrivals.length) return null;
  const age = dir.arrivals[call];
  const phases = bake.phases;
  const off = dir.phaseOff;
  let lo = 0;
  let hi = dir.phaseCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (phases[(off + mid) * 4] <= age) lo = mid;
    else hi = mid - 1;
  }
  const base = (off + lo) * 4;
  // Moving through it, or accelerating away from it. Not a stop.
  if (phases[base + 2] !== 0 || phases[base + 3] !== 0) return null;
  // Standing at the buffers with nothing after it: the trip is over, and
  // `poseTrain` refuses `age > duration` anyway.
  if (lo + 1 >= dir.phaseCount) return null;
  const opens = phases[base];
  const closes = phases[(off + lo + 1) * 4];
  return closes > opens ? { opens, closes } : null;
}

/**
 * The next time a train has its doors open at `station`, or null.
 *
 * `lineId` filters to one service where a station has several -- Central has
 * eight -- and is otherwise "whichever is soonest".
 *
 * The arithmetic is `nextArrivals`': a service calls at a station at
 * `offset + arrivals[k] + n * period`, so the smallest `n` whose window has not
 * already closed is a division and a ceiling. The *carriage* is then whichever
 * one of the consist has a door bay nearest the station's own anchor, so that a
 * player placed at it is standing where a platform actually is rather than
 * eighty metres up the track past the end of it.
 */
/** What `nextDwell` will accept. All optional; the defaults are "a train you can catch". */
export interface DwellWanted {
  /** Only this line, where a station has several. Central has eight. */
  lineId?: string;
  /**
   * How many more stations it must call at after this one. Default 1.
   *
   * **A train that is about to stop existing is not a train you can catch.** A
   * service arriving at its own terminus dwells fifteen seconds like any other
   * and then the trip ends -- `poseTrain` returns false and `sim.strandRider`
   * puts whoever is aboard onto the platform, which is correct and is not a
   * journey. Pass 0 to include the arrival.
   */
  minAhead?: number;
  /**
   * It must call at this station *after* the one being waited at.
   *
   * The difference between "the next train" and "the next train that is any use
   * to me", and the reason it is here rather than left to the caller: a station
   * is served in two directions and one of them is going the wrong way. Without
   * it, `ride('St Peters', 'Central')` catches whichever T4 comes first and half
   * the time that is the one to Waterfall, which reaches Central four minutes
   * *before* you got on.
   */
  then?: string;
}

export function nextDwell(
  bake: RailBake, station: string, t: number, want: DwellWanted = {},
): Dwell | null {
  const lineId = want.lineId;
  const minAhead = want.minAhead ?? 1;
  let best: Dwell | null = null;
  for (let li = 0; li < bake.lines.length; li++) {
    const line = bake.lines[li];
    if (lineId !== undefined && line.id !== lineId) continue;
    for (const dir of line.dirs) {
      let call = -1;
      let calls = 0;
      for (let k = 0; k < dir.stops.length; k++) {
        if (!dir.stops[k].calls) continue;
        if (dir.stops[k].name === station && call < 0) call = calls;
        calls++;
      }
      if (call < 0 || call >= dir.arrivals.length) continue;
      if (calls - call - 1 < minAhead) continue;
      // And the destination, if one was asked for, strictly after this stop.
      if (want.then !== undefined) {
        let after = -1;
        for (let k = 0, c = 0; k < dir.stops.length; k++) {
          if (!dir.stops[k].calls) continue;
          if (c > call && dir.stops[k].name === want.then) { after = c; break; }
          c++;
        }
        if (after < 0) continue;
      }
      // **Off the curve, not off `arrivals[call] + physics.dwell`.** See
      // `stopDwell`: the origin of every direction has an arrival with no stand
      // behind it, and offering one puts a boarder beside a departed train.
      const window = stopDwell(bake, dir, call);
      if (window === null) continue;
      const dwell = window.closes - window.opens;
      const base = dir.offset + window.opens;
      // The first window whose *end* is still ahead of us, so a train already
      // standing at the platform is the answer rather than the one after it.
      const n = Math.ceil((t - base - dwell) / line.period);
      const opensAt = base + n * line.period;
      if (best !== null && opensAt >= best.opensAt) continue;
      best = {
        line: li,
        dir: dir.index,
        trip: n,
        car: 0,
        bay: 0,
        opensAt,
        closesAt: opensAt + dwell,
        lineId: line.id,
        towards: dir.stops.length > 0 ? dir.stops[dir.stops.length - 1].name : dir.label,
        station,
      };
    }
  }
  if (best === null) return null;

  // Which carriage to stand at: the one whose first door bay lands nearest the
  // station's own anchor point, which is where `world/rail-geo.ts` centres the
  // platform it draws.
  const dir = dirOf(bake, best.line, best.dir);
  if (dir === null) return null;
  const at = Math.max(best.opensAt + 1, t);
  if (!poseTrain(bake, dir, best.trip, at, _pose)) return best;
  const consist = consistOf(dir, best.trip);
  let bestGap = Infinity;
  for (let k = 0; k < consist.cars.length; k++) {
    const it = interiorFor(consist.cars[k].key);
    if (it === null) continue;
    const centre = consistOffset(_pose.s, k, consist.cars.length, consist.pitch);
    if (centre < 0) continue;
    for (let b = 0; b < it.doors.length; b++) {
      // The door's own arc length: the carriage centre plus the bay, with the
      // sign of a flipped carriage taken into account.
      const doorS = centre + (consist.cars[k].flip ? -it.doors[b].x : it.doors[b].x);
      const gap = Math.abs(doorS - _pose.s);
      if (gap >= bestGap) continue;
      bestGap = gap;
      best.car = k;
      best.bay = b;
    }
  }
  return best;
}

/** Where a boarder stands, and which way they face. World metres and radians. */
export interface Stand {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * The spot on the platform a boarder stands in, for a solved dwell.
 *
 * Composed through the carriage's own frame, so it is the same square metre on
 * both ends and at any instant of the dwell: one pace off the bodyside, level
 * with the middle of the door bay, at platform height, facing the doorway. The
 * `y` is the **eye**, as every position in this file is.
 *
 * `side` picks which of the two platforms; either is a platform in this model,
 * and `+1` is the one on the carriage's own `+Z`.
 */
export function dwellStand(
  bake: RailBake, dwell: Dwell, at: number, out: Stand, side = 1,
): boolean {
  const dir = dirOf(bake, dwell.line, dwell.dir);
  if (dir === null) return false;
  if (!poseTrain(bake, dir, dwell.trip, at, _pose)) return false;
  const consist = consistOf(dir, dwell.trip);
  const it = interiorOfCar(consist, dwell.car);
  if (it === null) return false;
  const centre = consistOffset(_pose.s, dwell.car, consist.cars.length, consist.pitch);
  if (centre < 0) return false;
  carFrameAt(bake, dir, centre, consist.cars[dwell.car].flip, _frame);
  const bay = it.doors[dwell.bay] ?? it.doors[0];
  const across = side * (PLATFORM_INNER_M + 0.8);
  localToWorld(_frame, bay.x, PLATFORM_TOP_M + RIDER_EYE_HEIGHT, across, _local);
  out.x = _local.x;
  out.y = _local.y;
  out.z = _local.z;
  // Facing the doorway: the world direction from the stand toward the carriage
  // is `-side * r`, and the engine's forward is `(-sin yaw, -cos yaw)`.
  out.yaw = Math.atan2(side * _frame.rx, side * _frame.rz);
  return true;
}

/**
 * When this trip's doors open at a station further along its own run, or null.
 *
 * The other half of a journey: `nextDwell` answers "when can I get on" and this
 * answers "when do I get off". A trip's arrival at every calling station is in
 * the bake -- `dir.arrivals` -- so the answer is one lookup and no search.
 */
export function dwellAt(
  bake: RailBake, ref: AboardRef, station: string,
): { opensAt: number; closesAt: number } | null {
  const dir = dirOf(bake, ref.line, ref.dir);
  if (dir === null) return null;
  let call = -1;
  for (let k = 0, c = 0; k < dir.stops.length; k++) {
    if (!dir.stops[k].calls) continue;
    if (dir.stops[k].name === station) { call = c; break; }
    c++;
  }
  // `stopDwell` and not `arrivals[call] + physics.dwell`, for the reason it
  // gives: an arrival is not a dwell, and at the two ends of a run it is the
  // opposite of one. Getting off where the train does not stop is the same
  // defect as getting on there.
  const window = stopDwell(bake, dir, call);
  if (window === null) return null;
  const opensAt = dir.offset + ref.trip * dir.line.period + window.opens;
  return { opensAt, closesAt: opensAt + (window.closes - window.opens) };
}

/** Every station this trip still calls at, in order, from arc length `s`. */
export function callsAhead(bake: RailBake, ref: AboardRef, s: number): string[] {
  const dir = dirOf(bake, ref.line, ref.dir);
  if (dir === null) return [];
  const out: string[] = [];
  for (const stop of dir.stops) {
    if (!stop.calls) continue;
    if (stop.s > s + 30) out.push(stop.name);
  }
  return out;
}

// --- Getting off ---------------------------------------------------------------------------

/**
 * Where a rider ends up when they get off at a platform: the **eye**, in world.
 *
 * Composed through the carriage's own frame rather than through a ground query,
 * and that is the decision that makes a disembark agree on both ends. The
 * platform is client-side geometry -- `world/rail-geo.RailWorld` builds it into
 * the browser's `CollisionWorld` and the server has never heard of it -- so a
 * server that dropped a body onto its own terrain would put them a metre under
 * the platform the client is drawing, and then spend the next second dragging
 * the client down through it.
 *
 * Both ends instead compute the same point in the carriage's frame:
 * `PLATFORM_TOP_M` over rail level, `PLATFORM_INNER_M` plus a pace out from the
 * track centre, on the side the rider was standing. Those two numbers are
 * `rail-geo`'s own and the platform is built from them, so the point is on the
 * platform by construction on the end that has one and in exactly the same place
 * on the end that does not.
 */
export function alightPlatform(
  f: CarFrame,
  it: CarriageInterior,
  lx: number,
  lz: number,
  platforms: PlatformField | null,
  out: Vec3Out,
): void {
  const side = lz < 0 ? -1 : 1;
  const bay = doorBayAt(it, lx, 1.5);
  const alongX = bay >= 0 ? it.doors[bay].x : Math.max(it.xMin + 1, Math.min(it.xMax - 1, lx));
  localToWorld(
    f,
    alongX,
    PLATFORM_TOP_M + RIDER_EYE_HEIGHT,
    side * (PLATFORM_INNER_M + 1.35),
    out,
  );
  // **The plan position comes from the carriage and the height comes from the
  // platform**, and mixing the two is the whole of this function.
  //
  // Composing the height from the carriage as well is the obvious version and it
  // is wrong by up to a metre and a half. A platform is *flat* -- `rail-geo.ts`
  // builds it at one height for its whole 160 m, because that is what a platform
  // is -- and the railway under it is not: at Penrith the rail falls 1.5 m over
  // the length of an eight-car train. So a passenger stepping out of carriage
  // one, 45 m from where the platform's height was decided, would be placed a
  // metre and a half above or below the surface they are supposed to be standing
  // on, and would then either fall onto it or sink through it.
  //
  // Both ends run this and both ends hold the same field, so both land on the
  // same square metre. With no field -- a build with no bake -- it falls back to
  // the carriage's own rail level, which is the old answer and is right to
  // within the gradient.
  if (platforms === null) return;
  // `surfaceAt` and not `heightAt`: this is choosing where to stand, not asking
  // what is underfoot, and the banded version would answer "nothing here" for a
  // body that has not been placed yet. See both of their headers.
  const top = platforms.surfaceAt(out.x, out.z);
  if (top > -Infinity) {
    out.y = top + RIDER_EYE_HEIGHT;
    return;
  }
  // Off the rectangle: a curve has rotated the carriage's "sideways" out of the
  // platform's, or an end carriage is hanging past the ramp. **Slide onto the
  // platform rather than being put down beside it** -- see `placeOn`, which is
  // where the whole argument for that lives. `ALIGHT_SNAP_M` bounds it to the
  // width of the station, so a stop that genuinely has no platform in the field
  // still falls back to the carriage's own rail level and does not get dragged
  // across the yard to the next one.
  const snapped = platforms.placeOn(out.x, out.z, ALIGHT_SNAP_M, out);
  if (snapped > -Infinity) out.y = snapped + RIDER_EYE_HEIGHT;
}

/**
 * How far a disembark may be slid to land on a platform. See `alightPlatform`.
 *
 * A platform is 5.5 m wide and its face is 1.62 m off the track centre, so
 * everything this is meant to correct -- a few centimetres of curve, a carriage
 * end hanging past the 160 m -- is inside ten metres. Wider than the station is
 * a different bug and should look like one.
 */
export const ALIGHT_SNAP_M = 12;

/**
 * Where a rider ends up when they jump out between stations: beside the track.
 *
 * Two metres off the side of the carriage at rail level, which is the ballast.
 * The caller adds the fall damage and the ragdoll -- see `sim.resolveAboard` --
 * and the unstuck rule catches whatever happens next, because "beside the track"
 * at 44 m/s in the outer west is a defensible place to *arrive* and not always a
 * defensible place to *be*.
 */
export function alightTrackside(
  f: CarFrame, it: CarriageInterior, lx: number, lz: number, out: Vec3Out,
): void {
  const side = lz < 0 ? -1 : 1;
  localToWorld(f, lx, RIDER_EYE_HEIGHT, side * (it.halfWidth + 1.9), out);
}

/**
 * Fall damage for jumping out of a moving train, in pips.
 *
 * Zero at a stand and the whole bar a little over the express line speed, scaled
 * on the square of the speed because that is what the energy does. At the 36 m/s
 * a stopping service runs at it is 2.3 pips -- survivable, memorable, and enough
 * that nobody does it twice by accident. At 44.4 m/s on the express it is 3.5.
 *
 * `MAX_HEALTH` is 4 and is `combat.ts`'s, restated by value on this file's
 * import rule. The caller clamps.
 */
export function bailoutDamage(speed: number): number {
  const v = speed < 0 ? 0 : speed;
  return (v * v) / 560;
}

/**
 * The station a tunnel bail-out puts you at: the next one this trip calls at.
 *
 * TRAINS.md's rule, verbatim -- *"jumping out of a train in a tunnel relocates
 * you to the nearest station, framed as dragged out by staff"* -- with "nearest"
 * read as "next", which is the only version that is not a fifty-fifty guess
 * about which way somebody was walking. There is nothing to walk to in a tunnel:
 * `world/rail-geo.ts` builds a tube around the track and no floor beside it,
 * because nobody walks the tunnels and the plan says so in as many words.
 *
 * Returns the index into `dir.stops`, or -1 at the very end of a run.
 */
export function nextCall(dir: RailDirection, s: number): number {
  for (let k = 0; k < dir.stops.length; k++) {
    const stop = dir.stops[k];
    if (!stop.calls) continue;
    if (stop.s >= s - 1) return k;
  }
  for (let k = dir.stops.length - 1; k >= 0; k--) if (dir.stops[k].calls) return k;
  return -1;
}

/**
 * The `SPAN_*` flags of the track a train at arc length `s` is running on.
 *
 * The same binary search `sampleAlong` does, over the same non-decreasing
 * cumulative array, reading `bake.vertexFlags` instead of `bake.vertices`. It is
 * duplicated here rather than added to `rail.ts` on purpose: that file's
 * arithmetic is the shared contract eighteen assertions rest on, and a new
 * export in it is a new thing to re-prove for the sake of nine lines that answer
 * a *gameplay* question -- can this passenger jump out here.
 *
 * The flags of a vertex are the flags of the run starting there, so this is the
 * *entering* vertex rather than an interpolation: a portal is a step change and
 * a train straddling one is in the tunnel it is entering.
 */
export function spanFlagsAt(bake: RailBake, dir: RailDirection, s: number): number {
  const c = bake.cum;
  let lo = dir.vertexOff;
  let hi = dir.vertexOff + dir.vertexCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  return bake.vertexFlags[lo] ?? 0;
}

/**
 * The platform surface at a stop, in world metres, on the side given by `lz`.
 *
 * Used by the tunnel rule, which has no carriage to compose against by the time
 * it lands -- the train has gone. It samples the track polyline at the stop's
 * own arc length and steps sideways from the heading there, which is the same
 * geometry `rail-geo` builds the platform from (`station.ux/uz` is that heading).
 */
export function stopPlatform(
  bake: RailBake, dir: RailDirection, stopIndex: number, side: number, out: Vec3Out,
): boolean {
  const stop = dir.stops[stopIndex];
  if (stop === undefined) return false;
  sampleAlong(bake, dir, stop.s, _bogieA);
  // The plan normal to the heading, which is the direction the platform faces.
  const nx = -_bogieA.dz;
  const nz = _bogieA.dx;
  const d = (side < 0 ? -1 : 1) * (PLATFORM_INNER_M + 1.35);
  out.x = _bogieA.x + nx * d;
  out.y = _bogieA.y + PLATFORM_TOP_M + RIDER_EYE_HEIGHT;
  out.z = _bogieA.z + nz * d;
  return true;
}

/**
 * What the HUD says while you are on a train: line, destination, next stop.
 *
 * TRAINS.md's "T1 -> Penrith . next: Blacktown", derived rather than stored --
 * every field is a lookup into the bake against the trip's own arc length, so
 * there is no state to go stale and a passenger who boarded before a rebuild
 * still reads the right thing. Empty strings when the trip is not running,
 * which is the state a terminus produces for the tick before the rider is put
 * down.
 *
 * "Next" is the next call **strictly ahead**, with the platform the train is
 * standing at excluded: standing at Erskineville reading "next: Erskineville" is
 * the one thing this line must not say. 30 m is a third of a platform and is
 * comfortably inside the 40 m window `poseTrain` calls a station stop.
 */
export interface RideBanner {
  line: string;
  towards: string;
  next: string;
  /** True while this train's doors are open. What the "E to get off" pill reads. */
  doorsOpen: boolean;
  /** Metres a second, for the debug overlay. */
  speed: number;
}

export function rideBanner(
  bake: RailBake, ref: AboardRef, t: number, out: RideBanner,
): boolean {
  const dir = dirOf(bake, ref.line, ref.dir);
  if (dir === null) return false;
  const pose = aboardPose(bake, ref, t);
  if (pose === null) return false;
  out.line = dir.line.id;
  out.towards = dir.stops.length > 0 ? dir.stops[dir.stops.length - 1].name : dir.label;
  const next = nextCall(dir, pose.s + 30);
  out.next = next >= 0 ? dir.stops[next].name : out.towards;
  out.doorsOpen = pose.doorsOpen;
  out.speed = pose.speed;
  return true;
}

export function createRideBanner(): RideBanner {
  return { line: '', towards: '', next: '', doorsOpen: false, speed: 0 };
}

/**
 * Where this trip will be at a future instant, or null if it has finished by then.
 *
 * The whole of the deterministic prefetch, and it is three lines because the
 * timetable is closed form: "where will this train be in sixty seconds" is the
 * same `poseTrain` call as "where is it now" with a different argument. There is
 * no integration, no heading extrapolation and no assumption that the line is
 * straight -- the answer follows the arc through Redfern and round Sydenham
 * because the arc is what the pose is a lookup into.
 *
 * Returns the shared scratch pose, so the caller must read it before the next
 * call. `main.ts` reads two fields off it and passes them straight to the
 * streamer.
 */
export function poseAheadOnLine(
  bake: RailBake, dir: RailDirection, trip: number, t: number,
): TrainPose | null {
  if (!poseTrain(bake, dir, trip, t, _pose)) return null;
  return _pose;
}

// --- The self-check ---------------------------------------------------------------------

/**
 * Everything about this module that must be true before anything trusts it.
 *
 * Run by `checkRiding` in the integration suite and by the browser at boot, on
 * `verifyRail`'s own terms: a self-check nothing runs is a self-check that rots,
 * and the browser is not in CI.
 *
 * `eyeHeight` and `radius` are passed in rather than imported so that the two
 * restated constants at the top of this file are checked against the
 * controller's real ones by a caller that has both -- which is the only place
 * that can, given this file may not import the controller.
 */
export function verifyRiding(eyeHeight: number, radius: number): string[] {
  const bad: string[] = [];
  if (eyeHeight !== RIDER_EYE_HEIGHT) {
    bad.push(`the controller's eye is ${eyeHeight} m and this module's copy is ${RIDER_EYE_HEIGHT}`);
  }
  if (radius !== RIDER_RADIUS) {
    bad.push(`the controller's radius is ${radius} m and this module's copy is ${RIDER_RADIUS}`);
  }

  for (const it of INTERIORS) {
    if (it.xMax - it.xMin < 4) bad.push(`${it.key} is ${(it.xMax - it.xMin).toFixed(1)} m long inside`);
    if (it.halfWidth - RIDER_RADIUS < 0.5) bad.push(`${it.key} is too narrow to stand in`);
    if (it.doors.length === 0) bad.push(`${it.key} has no doors`);
    for (const d of it.doors) {
      if (d.half <= RIDER_RADIUS) bad.push(`${it.key} has a ${(d.half * 2).toFixed(2)} m doorway`);
      if (d.x - d.half < it.xMin || d.x + d.half > it.xMax) {
        bad.push(`${it.key} has a door bay at ${d.x} outside its own shell`);
      }
    }
    const deck = it.deck;
    if (deck !== null) {
      if (!(deck.lowerY < deck.split && deck.split < deck.upperY)) {
        bad.push(`${it.key}'s deck split ${deck.split} is not between ${deck.lowerY} and ${deck.upperY}`);
      }
      if (deck.x0 - deck.stair < it.xMin || deck.x1 + deck.stair > it.xMax) {
        bad.push(`${it.key}'s staircases run past its own bulkheads`);
      }
      // **The floor must be continuous along every line a body can actually
      // walk**, and the two halves of that sentence are both load-bearing.
      //
      // The floor function on its own is *not* continuous, deliberately: at the
      // mouth of a staircase it reads 2.51 m on the upper-deck side and 0.39 m
      // two centimetres further along, because the up-flight and the down-flight
      // are the same two metres of carriage at two different heights. What makes
      // that safe is the enclosure -- `carriageResolve` refuses the step -- so a
      // sweep that ignored the walls would be checking a property the design
      // never had, and a sweep that only checked the walls would miss a real
      // hole.
      //
      // So this walks a body: 5 cm at a time, through the resolver, and it only
      // compares floors between two points the resolver actually let it move
      // between. That is the same pair of functions `controller.step` calls in
      // the same order, which is what makes this a test of walking rather than
      // of arithmetic.
      const move: CarriageMove = { x: 0, z: 0, hit: false };
      for (const lz of [-0.8, 0.8]) {
        for (const start of [deck.lowerY, deck.upperY, it.vestibuleY]) {
          let x = it.xMin + 0.5;
          let feet = carriageFloor(it, x, lz, start);
          for (let i = 0; i < 500; i++) {
            const want = x + 0.05;
            if (want > it.xMax - 0.5) break;
            carriageResolve(it, x, lz, want, lz, RIDER_RADIUS, feet, move);
            // Blocked by the staircase enclosure or a bulkhead. Nothing to
            // compare: a body cannot get from here to there, which is the
            // answer, not a failure.
            if (Math.abs(move.x - want) > 1e-6) break;
            const next = carriageFloor(it, move.x, move.z, feet);
            // A step of more than a body's own stride at 5 cm of travel is a
            // discontinuity; the ramps themselves are at most 1.5 m of rise over
            // 0.9 m, which is 0.083 m per sample.
            if (Math.abs(next - feet) > 0.2) {
              bad.push(
                `${it.key} has a ${(next - feet).toFixed(2)} m step in a floor a body can walk ` +
                  `along, at x=${move.x.toFixed(2)}, z=${lz}, from feet=${feet.toFixed(2)}`,
              );
              break;
            }
            x = move.x;
            feet = next;
          }
        }
      }
    }
  }

  if (bailoutDamage(0) !== 0) bad.push('a bail-out at a stand hurts');
  if (bailoutDamage(36) < 1.5 || bailoutDamage(36) > 3.5) {
    bad.push(`a 36 m/s bail-out costs ${bailoutDamage(36).toFixed(1)} pips, which is not a lesson`);
  }

  // --- The station box, on Town Hall's own numbers.
  //
  // Four claims, and each of them is a way the reported bug comes back:
  //
  //   * a body **on the platform floor** gets the floor -- without this the
  //     concourse falls through to the DEM and the player is stood on George
  //     Street, which is *"moving anywhere on foot underground tps me to
  //     surface"* verbatim;
  //   * a body **in the street over the top of it** gets nothing, or every
  //     pedestrian in the CBD drops twenty metres through the pavement;
  //   * a body **beside the station** gets nothing, because a box is a
  //     rectangle in the station's own frame and not a radius --
  //     `samePlatform`'s lesson, and the reason this is not a circle;
  //   * a body **under the floor** gets nothing, because below a station is not
  //     inside one.
  {
    const field = new StationBoxField();
    const FLOOR = -36.6;
    const CEIL = -17.3;
    field.add({
      name: 'CONTROL', x: 0, z: 0, ux: 1, uz: 0,
      halfLength: 100, halfWidth: 16, floorY: FLOOR, ceilY: CEIL,
    });
    const cases: [string, number, number, number, number][] = [
      ['standing on the platform', 0, 0, FLOOR, FLOOR],
      ['at the far end of the box', 95, 0, FLOOR, FLOOR],
      ['across the concourse', 0, 14, FLOOR, FLOOR],
      ['in the street over the top', 0, 0, CEIL, -Infinity],
      ['past the end of the box', 140, 0, FLOOR, -Infinity],
      ['beside the box, off to the side', 0, 30, FLOOR, -Infinity],
      ['under the floor', 0, 0, FLOOR - 4, -Infinity],
    ];
    for (const [what, x, z, feet, want] of cases) {
      const got = field.floorAt(x, z, feet);
      if (got !== want) {
        bad.push(
          `a body ${what} of a station box got a floor of ${got} m, expected ${want} m`,
        );
      }
    }
    // And the selection rule, both halves of it. A surface station has no box
    // at all -- a lid over open sky, with `floorAt` answering for bodies in the
    // car park -- and neither does a station in a *cutting*, which is
    // `belowGrade` and is Sydenham: the carve has already opened it and
    // `RailCut.cutAt` answers the rail head there, which is a place a body can
    // stand and a box would take away.
    const bad0 = buildStationBoxes({
      stations: [
        { name: 'AT GRADE', vertical: 'surface', belowGrade: false, servedDirs: [0, 1], boxFloorY: -1, boxCeilY: 5 },
        { name: 'IN A CUTTING', vertical: 'surface', belowGrade: true, servedDirs: [0, 1], boxFloorY: -8, boxCeilY: -1 },
        // ...and a bore nobody's train calls at: a box round a dot.
        { name: 'NO SERVICE', vertical: 'underground', belowGrade: true, servedDirs: [], boxFloorY: -20, boxCeilY: -1 },
      ],
    } as unknown as RailBake);
    if (bad0.boxes.length !== 0) {
      bad.push(
        `a surface station, a cutting and an unserved bore were given ${bad0.boxes.length} station ` +
        `box(es) between them; only a served bore gets one`,
      );
    }
    const bore = buildStationBoxes({
      stations: [{
        name: 'A BORE', vertical: 'underground', belowGrade: true, servedDirs: [0, 1],
        siteX: 0, siteZ: 0, siteDx: 1, siteDz: 0,
        boxHalfLength: 100, boxHalfWidth: 16, boxFloorY: FLOOR, boxCeilY: CEIL,
      }],
    } as unknown as RailBake);
    if (bore.boxes.length !== 1) {
      bad.push(`an underground station got ${bore.boxes.length} station boxes, expected 1`);
    } else if (bore.floorAt(0, 0, FLOOR) !== FLOOR) {
      bad.push(`the box built for an underground station does not answer its own floor`);
    }
  }
  return bad;
}
