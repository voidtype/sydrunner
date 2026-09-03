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
 *
 * ---------------------------------------------------------------------------
 * 5. THE METRO IS A WALK-THROUGH TRAIN, AND A CROSSING IS A CHANGE OF BASIS.
 *
 *   > *"u should be able to move between carriages on metro when the train is
 *   > moving"*
 *
 * An Alstom Metropolis has **open gangways**: six cars, one tube, and you can
 * see from the front cab window to the back one. A Tangara does not -- its ends
 * are bulkheads and nobody walks between carriages of one at line speed -- so
 * the two consists differ here, and the difference lives in the interior table
 * (`CarriageInterior.gangway`) rather than in a branch anybody has to remember.
 *
 * **The crossing is `crossGangway`, and it contains no world coordinates, no
 * bake, no clock and no train speed.** That is not an economy, it is the claim
 * section 1 makes coming due. A rider's authority is `(car, x, y, z, yaw)` in
 * one carriage's frame; the *same physical point* in the neighbour's frame is
 * that tuple with the car index stepped, the offset shifted by the consist's own
 * pitch, and -- across the one coupling in a Metro where the two cars face
 * opposite ways -- three signs and a half turn flipped. A train doing 130 km/h
 * enters into none of it, because a carriage frame is a stationary room whatever
 * the room is doing. `verifyGangway` states that as a test rather than as this
 * paragraph: the identical walk is driven at 0 m/s and at 30 m/s and the two
 * local trajectories are compared with `Object.is`.
 *
 * **Where the boundary is, and why it is not the modelled bulkhead.** The
 * carriages' own interiors do not meet: on the shipped Metropolis a mid-to-mid
 * coupling leaves 0.4 m between the two measured bulkheads and a lead-to-mid one
 * *overlaps* by 0.1 m, because the lead car's saloon probed 0.3 m longer than
 * half the pitch. Either number as a crossing plane is a step in the floor or a
 * hole in it. So the plane is the **coupling midpoint** -- `pitch / 2` from each
 * carriage's centre, which is one point in the world described identically by
 * both frames -- and at a gangway end the interior's own bulkhead is moved out
 * to it. A rider leaving car k at `x = +pitch/2` arrives in car k-1 at
 * `x = -pitch/2`, exactly, and walking back returns them to the double they
 * started at.
 *
 * The floor needs nothing: a Metropolis has `deck === null`, so `carriageFloor`
 * answers `vestibuleY` for every x, including the half-metre of gangway either
 * side of the plane. The bellows a rider walks through is drawn by
 * `world/trains.ts` and collides with nobody, which is the same division of
 * labour the door leaves already have.
 */

import { type RailStation, CONCOURSE_OVER_RAIL_M,
  createTrainPose,
  poseTrain,
  sampleAlong,
  trainIdentity,
  type RailBake,
  type RailDirection,
  type TrainPose,
} from './rail.ts';
// **The one import this file makes outside `rail.ts`, and it is a number.**
// `world/rail-cut.ts` imports nothing but the same span flags this file's
// neighbour does -- no three, no renderer -- so it is safe here on exactly the
// terms section 2 sets out. It is imported rather than restated because the
// deck's outer edge and the rim of the terrain carve have to be *the same
// number*: see `PLATFORM_OUTER_M`, where their difference was the bug.
import { STATION_HALF_WIDTH } from '../world/rail-cut.ts';
import { pointInPolygon, type Prism } from '../player/collision.ts';
// WORKSTREAM AG: how much of the corridor this platform's track may have. See
// `PlatformSite.outer` -- both ends of the wire read this one answer.
import { atlasFor } from '../world/track-atlas.ts';
import {
  frameAt,
  platformSlots,
  projectSpine,
  spineOn,
  type PlatformSpine,
} from '../world/platform-spine.ts';

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

/**
 * How much lower the **camera** sits than the eye while aboard a train, metres.
 *
 *   > *"make the camera slightly lower when on the train"*
 *
 * 0.12 m, and the important half of this constant is everything it deliberately
 * is not. It is **not** a change to `RIDER_EYE_HEIGHT`, which stays 1.68 and is
 * pinned by `verifyGangway` below. That number is a *simulation* quantity in four
 * places at once -- it is where the stored local position of a rider is measured
 * from (`enterLocal`/`projectAboard`), it is the height the gangway header is
 * cleared by (`gangwayAdmits`), it is what puts a boarding player's eye over the
 * vestibule floor and over `PLATFORM_TOP_M`, and it is restated from
 * `controller.EYE_HEIGHT` and asserted equal to it. Lowering it by 12 cm to lower
 * the view would move a rider's body 12 cm down inside the carriage on both ends,
 * change what the wire carries, and shave the gangway's clearance -- for a
 * camera note.
 *
 * So this is a **view** term, applied by the one caller that composes a camera
 * from a rider's eye (`main.ts`, at `riderViewEye`), and it composes with the
 * knockout drop and the third-person boom the same way every other camera-only
 * term in that loop does: after the simulation is finished and correct, and never
 * written back into `PlayerState`. `game/feedback.ts`'s header states that rule
 * and the shake obeys it; this is the same seam.
 *
 * Why 12 cm rather than 5 or 30. A seated adult's eye is about 30 cm below their
 * standing one, and this is explicitly *not* seating anybody: the rider still
 * walks the carriage at full speed and their body is still a standing capsule, so
 * a 30 cm view drop would read as a bug the first time a player walked past a
 * window whose sill they now saw from underneath. What 12 cm buys is the thing the
 * note is about -- the horizon of a moving room sits a little lower, the way it
 * does when you are braced against a seat back rather than standing to attention
 * -- while staying inside the range a player reads as *posture* rather than as a
 * height change. It is also small enough that aim is unaffected in any way that
 * matters: the hit test is composed from the body's eye and its yaw and pitch, not
 * from the camera, and at 20 m the parallax between the two is 0.34 degrees.
 */
export const RIDER_VIEW_DROP_M = 0.12;

/**
 * The camera height for an eye, given whether its owner is aboard a train.
 *
 * A function rather than a bare subtraction at the call site, for one reason: the
 * *condition* is the part that goes wrong. A drop applied unconditionally is a
 * player who walks around Newtown 12 cm shorter than the server thinks they are,
 * and a drop applied to the stored position rather than to the camera is the
 * simulation change the constant above exists to avoid. Both are silent. With the
 * rule in one pure line, `verifyGangway` can assert it is the identity on foot and
 * exactly `RIDER_VIEW_DROP_M` aboard, which is the whole contract.
 */
export function riderViewEye(eyeY: number, aboardTrain: boolean): number {
  return aboardTrain ? eyeY - RIDER_VIEW_DROP_M : eyeY;
}

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

/**
 * How wide and how tall the hole between two carriages is, metres.
 *
 * A Metropolis gangway is a rectangular aperture in an otherwise solid end: the
 * bellows is 2.4 m across on the outside and what a passenger walks through is
 * about 1.3 m of it, with a header at 2.0 m over the floor and the frame of the
 * ring either side. Half the aperture, so the opening is `+/- half`, on
 * `DoorBay.half`'s own convention -- these two are the same kind of number in
 * the same frame and are deliberately spelled the same way.
 *
 * **The height gates entry and nothing else.** A body already in the tube is not
 * ejected for jumping: `carriageResolve` has no ceiling anywhere in it (see
 * `CarriageInterior.ceilingY`, which is presentation only), so a header that
 * pushed back would be the one piece of vertical collision in the carriage and
 * would push a jumping rider *sideways*, which is worse than letting them clip
 * the ring. What it does buy is that a rider cannot enter the gangway from the
 * top of a jump and land inside the bellows.
 */
export const GANGWAY_HALF_WIDTH_M = 0.65;
export const GANGWAY_HEIGHT_M = 2.0;

/**
 * The open ends of a walk-through carriage, and where the crossing plane is.
 *
 * Which ends rather than "has gangways", because a Metropolis lead car has one
 * of each: the saloon end couples to the next car and the cab end is the front
 * of the train. That is a property of the *template* and not of where it sits in
 * the consist -- both lead cars in `METRO` face their cab outward, which is what
 * their `flip` is for -- so it belongs in this table beside the door bays.
 *
 * `plane` is half the consist's own pitch. See section 5 for why the crossing
 * cannot be at `xMin`/`xMax`: those are measured off the mesh and the two
 * carriages' measurements do not meet.
 */
export interface Gangway {
  /** The -X end of this carriage is open. */
  min: boolean;
  /** The +X end is. */
  max: boolean;
  /** |x| of the crossing plane, metres from the carriage centre. */
  plane: number;
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
  /** Open ends, or null on a carriage whose ends are bulkheads. See section 5. */
  gangway: Gangway | null;
}

/**
 * Half a Metro's pitch: where one carriage stops being the room you are in.
 *
 * Written once and shared by the three Metropolis templates, because it is one
 * plane seen from two sides -- a value typed three times is three values that
 * can be typed differently, and the symptom of a 5 cm disagreement is a rider
 * who crosses into the next carriage and is immediately pushed back out of it.
 */
const METRO_GANGWAY_PLANE = /*#__PURE__*/ METRO_PITCH / 2;

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
    // A Tangara's ends are bulkheads with a slam door in them and its saloons are
    // two decks 2.1 m apart -- there is no level a gangway could be at, and the
    // real train does not have one. See section 5.
    gangway: null,
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
    gangway: null,
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
    // **One end only, and which one falls out of the measurement.** The probe put
    // this car's bulkheads at -11.3 and +9.0 -- 2.3 m of asymmetry, which is the
    // cab. `METRO` gives both lead cars the flip that turns their +X outward, so
    // the cab is the nose of the train at one end and the back of it at the other,
    // and the open end is -X in both. `verifyGangway` asserts that against the
    // table rather than leaving it to this paragraph.
    gangway: { min: true, max: false, plane: METRO_GANGWAY_PLANE },
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
    gangway: { min: true, max: true, plane: METRO_GANGWAY_PLANE },
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
    // Open at both ends despite the name: in `METRO` the two trailers are coupled
    // back to back in the middle of the set, which is the one place in either
    // consist where a rider crosses between two carriages facing opposite ways.
    // See `crossGangway` for the three signs that costs.
    gangway: { min: true, max: true, plane: METRO_GANGWAY_PLANE },
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
    // **The reachable span, which on a walk-through carriage is wider than the
    // measured one.** A gangway moves the end wall out to the coupling plane, so
    // a Metropolis mid car is walkable from -11 to +11 rather than from -10.8 to
    // +10.8 -- and a bound that is not a bound is a punch that misses somebody
    // standing in a bellows.
    const g = it.gangway;
    const lo = g !== null && g.min ? Math.min(it.xMin, -g.plane) : it.xMin;
    const hi = g !== null && g.max ? Math.max(it.xMax, g.plane) : it.xMax;
    const span = Math.hypot(hi - lo, it.halfWidth * 2);
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
 * Is the gangway at one end of this carriage open to a body here?
 *
 * `end` is `+1` for the +X end and `-1` for the -X one. Three questions, in the
 * order that makes the cheap one first: does this carriage have a gangway at all
 * (a Tangara never does), is that end of it open (a Metropolis lead car's cab
 * end is not), and is the body inside the aperture.
 *
 * The width test carries the body's own radius, so a rider walks *through* the
 * ring rather than into it; the height test does not, because there is no
 * ceiling collision anywhere in this file and a header that pushed back would be
 * the only one. See `GANGWAY_HEIGHT_M`.
 *
 * Exported because `verifyGangway` drives it directly at the four corners of the
 * aperture, which is the only way to test a hole: a hole that is too big and a
 * hole that is not there both look like a wall from one sample.
 */
export function gangwayAdmits(
  it: CarriageInterior, end: number, lz: number, probeY: number, radius: number,
): boolean {
  const g = it.gangway;
  if (g === null) return false;
  if (!(end < 0 ? g.min : g.max)) return false;
  const half = GANGWAY_HALF_WIDTH_M - radius;
  if (half <= 0 || lz < -half || lz > half) return false;
  // **`probeY` is not the body's feet and getting that wrong shuts the gangway
  // for everybody.** `controller.step` hands a mover `feetY + STEP_HEIGHT` -- the
  // kerb probe, so that a step a body can climb is not a wall it walks into --
  // and `carriageResolve`'s deck split already reads its argument that way. Taken
  // literally here, a rider standing flat on the floor measures 42 cm taller than
  // they are, the header refuses them, and the whole feature is a bulkhead. It
  // cost an acceptance run to find, because the walk ran the full length of the
  // carriage and stopped dead at the plane, which looks exactly like a crossing
  // that did not fire.
  //
  // The floor is the vestibule's: single-deckers only, which `verifyGangway`
  // asserts, so `carriageFloor` would answer the same for any x.
  const feet = probeY - PLATFORM_STEP_M;
  const floor = it.vestibuleY;
  if (feet < floor - PLATFORM_STEP_M) return false;
  return feet + RIDER_EYE_HEIGHT <= floor + GANGWAY_HEIGHT_M;
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
 *
 * **A gangway end is not**, and it is the one hole in this box. See section 5:
 * on a Metropolis the bulkhead at an open end is moved out to the coupling plane
 * and the body may pass it, inside a 1.3 m aperture. Past the old bulkhead line
 * the body is in the bellows and the *aperture* is its side wall rather than the
 * bodyside, which is what stops a rider walking into the gangway and then
 * sidestepping out of the train through the concertina.
 *
 * Which of the two the side clamp uses is decided from `fromX` -- where the body
 * already is -- and not from `toX`. Deciding it from the destination is the
 * version that reads correctly and plays wrong: a rider standing in the bellows
 * who pushes sideways would fail the aperture test, lose the wider x limit with
 * it, and be dragged half a metre back down the train by a sideways key.
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

  let xLo = it.xMin + radius;
  let xHi = it.xMax - radius;
  const zShell = it.halfWidth - radius;
  const zGang = GANGWAY_HALF_WIDTH_M - radius;

  // Across first, because the gangway's admission is a question about z and the
  // shell's own clamp is not a question about x. Two independent clamps in
  // either order give the same answer; this order lets the second read the first.
  if (z < -zShell) { z = -zShell; hit = true; }
  else if (z > zShell) { z = zShell; hit = true; }

  const g = it.gangway;
  if (g !== null) {
    // Already in the tube at one end: the plane is the limit and the aperture is
    // the wall, whatever the body is trying to do.
    // **A radius past the plane, and the margin is not slack.** Every other wall
    // in this carriage is offset inward by the body's radius so the body's skin
    // stops on it. The plane is not a wall -- it is the line at which a rider
    // changes rooms, and `crossGangway` fires on the same tick -- so the clamp
    // past it is the backstop for a tick in which the crossing cannot happen
    // (a consist with a carriage missing). One radius is where the body is
    // entirely in the next carriage, and a rider is never seen at it.
    //
    // It also has to be **strictly** past the plane, or a body clamped exactly on
    // it is a body the crossing cannot take and the resolver will not release:
    // the two rules would hold it on the boundary forever.
    const reach = g.plane + radius;
    const inMax = g.max && fromX > xHi;
    const inMin = g.min && fromX < xLo;
    if (inMax || inMin) {
      if (inMax) xHi = reach;
      else xLo = -reach;
      if (z < -zGang) { z = -zGang; hit = true; }
      else if (z > zGang) { z = zGang; hit = true; }
    } else {
      // In the saloon, walking at an end. The aperture decides.
      if (x > xHi && gangwayAdmits(it, 1, z, feetY, radius)) xHi = reach;
      else if (x < xLo && gangwayAdmits(it, -1, z, feetY, radius)) xLo = -reach;
    }
  }

  if (x < xLo) { x = xLo; hit = true; }
  else if (x > xHi) { x = xHi; hit = true; }

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

/**
 * Is this local point inside the carriage shell at all? Used by the camera clamp.
 *
 * The gangway widens it at an open end, on `RIDER_CARRIAGE_SPAN_M`'s argument:
 * a rider standing in a bellows is inside the train, and a camera clamp that
 * said otherwise would let the boom out through the concertina at exactly the
 * moment there is a second carriage behind it to see through.
 */
export function insideCarriage(it: CarriageInterior, lx: number, ly: number, lz: number): boolean {
  const g = it.gangway;
  const lo = g !== null && g.min ? Math.min(it.xMin, -g.plane) : it.xMin;
  const hi = g !== null && g.max ? Math.max(it.xMax, g.plane) : it.xMax;
  return (
    lx >= lo && lx <= hi &&
    lz >= -it.halfWidth && lz <= it.halfWidth &&
    ly >= -0.5 && ly <= it.ceilingY + (it.deck === null ? 0 : 1.0)
  );
}

// --- The platforms, as arithmetic rather than as geometry ---------------------------------

/** `world/rail-geo.PLATFORM_HALF_LENGTH` and `PLATFORM_WIDTH`, restated with the other two. */
export const PLATFORM_HALF_LENGTH_M = 80;
export const PLATFORM_WIDTH_M = 5.5;

/**
 * How far the deck a body stands on reaches from the track centre, metres.
 *
 * ---------------------------------------------------------------------------
 * **THE RING TRENCH, WHICH IS WHY YOU COULD NEVER GET ONTO A PLATFORM.**
 *
 *   > *"i also cant seem to stand on top of ANY platforms"* -- *"its been broke
 *   > since the beginning of platforms"*
 *
 * Standing on a platform was never the broken half. Measured with a body driven
 * through `player/controller.step` with real collision, dropped onto the deck at
 * ten stations of four different vertical classes: every one of them settled
 * exactly on the deck and walked forty metres along it without leaving it. What
 * failed was **arriving**, and the reason is a two-metre slot that ran the whole
 * length of every platform in the city.
 *
 * `rail-cut.STATION_HALF_WIDTH` opens the terrain carve out to 9.4 m either side
 * of the track at a platform site, because the stairs and the fence line need
 * that band. The deck stopped at `PLATFORM_INNER_M + PLATFORM_WIDTH_M` = 7.12 m.
 * Nothing floored the 2.28 m between them, so the ground there was the *rail
 * head* -- 1.05 m under the deck in the flat case and up to sixteen metres under
 * it in a cutting. Measured across the shipped bake: **304 of 358 platform sites
 * had an un-steppable drop off their outer face, 221,658 m2 of it.**
 *
 * A player walking up to a platform therefore fell into the slot, and could not
 * get out of it: the deck face is a 1.05 m wall against a `controller.STEP_HEIGHT`
 * of 0.42 m, and the trench wall is behind them. Walking in from eight metres
 * out reached the deck at **two of ten** stations tried, and at seven of the ten
 * it did not help to jump. The four generated stair flights were islands in the
 * slot rather than a way across it.
 *
 * So the deck reaches **exactly the rim of the carve** -- not 7.12 m with a
 * trench behind it, and not 9.4 m with a margin the carve does not open, which
 * would put the far edge of the platform inside the retaining wall. One number
 * for both, imported rather than restated, because two numbers here is precisely
 * the slot: the width of the hole is their difference, and a difference that
 * cannot be written down cannot be nonzero. It is also what a cutting station
 * really is -- the platform runs back to the retaining wall, and the stair comes
 * down onto it rather than into a pit beside it.
 *
 * `PLATFORM_WIDTH_M` stays 5.5 and is still the platform's *own* width: the
 * coping, the tactile strip, the canopy and `samePlatform`'s merge are all about
 * the passenger platform and none of them changes. This is the surface, which is
 * a different question and now has its own name.
 */
export const PLATFORM_OUTER_M = STATION_HALF_WIDTH;

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
  /**
   * How far the deck reaches on each side, metres: `[-1 side, +1 side]`.
   *
   * ---------------------------------------------------------------------------
   * **This is the other half of `rail-solids.StationPlan.slot`, and the two are
   * the same call.** The deck used to run to `PLATFORM_OUTER_M` on both sides
   * unconditionally, here and in the geometry, and on the inside of a two-track
   * corridor that put it straight through the neighbouring train -- 59.6 km of
   * running line, measured, across 162 of 361 sites.
   *
   * It has to be carried *here* and not only in the geometry, and that is the
   * lesson `world/rail-geo.platformSides` records: the browser draws platforms
   * and this field is what both ends *stand* on, so a side the geometry stops
   * drawing while the field still answers for it is a metre of invisible floor
   * -- a worse bug than the one being fixed, and the reason the first attempt at
   * this was reverted within the hour. `world/track-atlas.ts` is what made the
   * decision available to a process with no renderer, and `platformSlots` is the
   * one function both ends call.
   *
   * Zero means no platform on that side.
   */
  outer: [number, number];
  /**
   * The running line under this platform, over the platform's own length.
   *
   * ---------------------------------------------------------------------------
   * **The field follows the curve because the deck does, and they must be the
   * same curve.** `world/rail-geo.writePlatforms` sweeps the drawn slab along
   * `StationPlan.spine`; if this still tested a straight rectangle, then at
   * Wollstonecraft -- whose track leaves its own anchor tangent by 17.6 m over
   * the platform -- the surface a body stands on and the surface a body sees
   * would be seventeen metres apart. Both are built by `spineOn` from the same
   * bake at the same arc length, so they are one curve rather than two that
   * agree.
   *
   * It is also what makes the mitre wedge harmless: the drawn slab's prisms are
   * butted panel to panel and fall short at the outside of a bend, and this --
   * which is what `groundHeightAt` and `world.groundFor` actually stand a body
   * on -- is exact there.
   */
  spine: PlatformSpine;
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
    const r = PLATFORM_HALF_LENGTH_M + PLATFORM_OUTER_M;
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
      const top = PlatformField.topOn(site, x, z);
      if (top > best) best = top;
    }
    return best;
  }

  /**
   * Is this point on *this* site's deck, and how high is it -- one site, one
   * answer.
   *
   * ---------------------------------------------------------------------------
   * **Lifted out of `surfaceAt` so that `placeOn` can be judged by the function
   * that judges everybody else.** The three methods below used to spell the
   * rectangle test out three times, and two of the three spelt it in the
   * *spine's* frame while `placeOn` spelt it in the anchor's chord -- which is
   * how a disembark ended up being slid onto a point the field then answered
   * `-Infinity` for. See `placeOn`'s own header for the measurement.
   */
  private static topOn(site: PlatformSite, x: number, z: number): number {
    // Projected onto the running line, not onto a chord through it. See
    // `PlatformSite.spine`.
    const p = projectSpine(site.spine, x, z);
    if (p.along < -PLATFORM_HALF_LENGTH_M || p.along > PLATFORM_HALF_LENGTH_M) return -Infinity;
    const across = Math.abs(p.across);
    // `site.outer`, per side, rather than one constant for both. See it.
    if (across < PLATFORM_INNER_M || across > site.outer[p.across < 0 ? 0 : 1]) return -Infinity;
    // `p.y` -- the railhead *here* -- not `site.y`, the railhead at the anchor.
    // The drawn deck follows the grade and this is what stands a body on it.
    return p.y + PLATFORM_TOP_M;
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
   * ---------------------------------------------------------------------------
   * **AND THE FRAME IT CLAMPS IN IS THE SPINE'S, WHICH IS THIS ROUND'S FIX.**
   *
   * The corridor rework swept the deck along the running line and taught
   * `surfaceAt` and `heightAt` to project onto that curve -- and left this
   * method clamping into a **straight rectangle** hung off the anchor's own
   * tangent. So the two disagreed about where the deck was by the platform's
   * bow, and the disagreement was silent in the worst possible direction: this
   * one *chose* the point and the other one *judged* it. Measured over every
   * calling stop of every direction, both door bays, both sides: **22 of the
   * 2,014 disembarks were slid onto a point `surfaceAt` then answered
   * `-Infinity` for** -- Croydon, Burwood, Strathfield, Pendle Hill,
   * Macdonaldtown and Parramatta among them, every one of them a station whose
   * platform bows -- which is the fall-through this method was written to end,
   * wearing the new geometry's clothes. Clamping on the spine recovers all 22.
   *
   * Two consequences in the code below. The clamp runs in the spine's frame
   * (`projectSpine` in, `frameAt` back out), and the candidate is then **put to
   * `topOn`**, the same predicate `surfaceAt` folds over every site: a site
   * whose clamp lands somewhere the field would not answer for is skipped
   * rather than returned. A mitre joint can still refuse a point the panel
   * arithmetic liked, and the honest answer there is the next site, not a
   * height nobody else agrees with.
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
    const end = PLATFORM_HALF_LENGTH_M - INSET;
    let bestMove = reach;
    let bestX = 0;
    let bestZ = 0;
    let bestTop = -Infinity;
    for (const site of list) {
      const p = projectSpine(site.spine, x, z);
      let along = p.along;
      let i = p.across < 0 ? 0 : 1;
      // **A rider is put down on a side that exists.** Where the slot refused
      // this side, the platform is on the other one, and clamping to the side
      // the carriage door happens to face would set a body down in the six-foot
      // between two running lines with the field answering `-Infinity` for it --
      // which is precisely the silent fall-through this method was written to
      // end, reintroduced by the narrowing. See `PlatformSite.outer`.
      if (site.outer[i] <= 0) i = 1 - i;
      if (site.outer[i] <= 0) continue;
      const side = i === 0 ? -1 : 1;
      const hi = Math.min(PLATFORM_INNER_M + PLATFORM_WIDTH_M, site.outer[i]) - INSET;
      if (hi <= lo) continue;
      let mag = p.across < 0 ? -p.across : p.across;
      if (along < -end) along = -end;
      else if (along > end) along = end;
      if (mag < lo) mag = lo;
      else if (mag > hi) mag = hi;
      // Back out through the **panel at that arc length**, which is the frame
      // `topOn` will project the answer back onto. See `platform-spine.frameAt`.
      const f = frameAt(site.spine, along);
      const px = f.x + -f.uz * side * mag;
      const pz = f.z + f.ux * side * mag;
      const move = Math.hypot(px - x, pz - z);
      if (move >= bestMove) continue;
      // The candidate is judged by `surfaceAt`'s own predicate rather than
      // asserted. See the header: a point this method likes and the field does
      // not is the whole defect.
      const top = PlatformField.topOn(site, px, pz);
      if (top === -Infinity) continue;
      bestMove = move;
      bestX = px;
      bestZ = pz;
      bestTop = top;
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
      // Along and across the *curve*, and the sign of `across` is kept now,
      // because the two sides of a pair no longer reach the same distance -- one
      // may be a corridor edge with the full deck and the other four metres from
      // a running line. See `PlatformSite.spine` and `.outer`. `topOn` is that
      // test, shared with `surfaceAt` and `placeOn`; the band is this method's
      // own and is applied to its answer.
      const top = PlatformField.topOn(site, x, z);
      if (top === -Infinity) continue;
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
  // Shared with `rail-solids.buildNetwork` by identity rather than by argument.
  // See `track-atlas.atlasFor` for why that is a correctness property and not a
  // saving: the drawn deck and the standable deck have to be one decision.
  const atlas = atlasFor(bake);
  for (let li = 0; li < bake.lines.length; li++) {
    const line = bake.lines[li];
    for (let di = 0; di < line.dirs.length; di++) {
      const dir = line.dirs[di];
      for (const stop of dir.stops) {
        if (!stop.calls) continue;
        sampleAlong(bake, dir, stop.s, at);
        field.add({
          name: stop.name, x: at.x, z: at.z, y: at.y, ux: at.dx, uz: at.dz,
          outer: platformSlots(
            bake, atlas, { line: li, dir: di, s: stop.s },
            PLATFORM_HALF_LENGTH_M, PLATFORM_INNER_M, PLATFORM_OUTER_M, stop.name,
          ),
          // The identical call `rail-solids.planStation` makes, on the identical
          // direction at the identical arc length. See `PlatformSite.spine`.
          spine: spineOn(bake, dir, stop.s, PLATFORM_HALF_LENGTH_M),
        });
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
  /**
   * Rise per metre along `ux,uz`, measured from the box's own centre. Zero for
   * a room, non-zero for the access incline.
   *
   * **A box had one floor height, and that is why underground stations had no
   * way in.** A descent is a floor that changes with where you stand on it, and
   * expressing one as a stack of flat boxes takes forty of them per station to
   * get a stair with treads a body does not catch on. One number does it
   * instead: `floorAt` adds `slope * along` to both the floor and the lid, so a
   * ramp is a room that leans and every rule about bands, headroom and
   * replacing the terrain carries over untouched.
   */
  slope?: number;
  /**
   * How far the lean may lift the floor over `floorY`, metres. An incline's
   * box overlaps the street by `ACCESS_OVERLAP_M` so the two floors meet, and
   * without a cap that overlap kept climbing: 1.25 m above the pavement at the
   * mouth, a step no body makes. Capped, the overlap is a flat pad at the
   * mouth's own height.
   */
  riseMax?: number;
}

/** How far to the side of the track the surface entrance stands. */
export const ACCESS_FAR_M = 40;
/** Where the incline bottoms out: just outside the room's wall at 13 m. */
export const ACCESS_NEAR_M = 17;
/** Half-width of the passage, and of the entrance above it. */
export const ACCESS_HALF_W = 3.2;
/** Standing height inside the incline and the tunnel. */
export const ACCESS_HEIGHT_M = 4.2;
/** How far along the platform the access meets the room, from its centre. */
export const ACCESS_ALONG_M = 68;

export class StationBoxField {
  /** Every station entrance on the street, for the prompt that points at one. */
  readonly mouths: Array<{ name: string; x: number; z: number; y: number }> = [];
  /** The plans behind those mouths, for the terrain carve. See `accessCutAt`. */
  readonly plans: AccessPlan[] = [];

  /**
   * The plans by station name -- **the one copy the drawing must read**.
   *
   * `world/rail-geo.writeUndergroundStation` used to call `stationAccessPlan`
   * again for itself, off its own `accessWorld`, and its header claimed that
   * "the field and `rail-geo` read the same plan, so the floor a body stands on
   * and the shaft it sees are one set of numbers". They were two computations
   * of the same thing against two different worlds, which is not the same thing
   * at all: a chunk built before the client had prisms drew the shaft at the
   * bake's mouth while the field stood bodies on the moved one, and a player who
   * walked in got a floor with no walls round it and the underside of the city
   * to look at. The owner: *"i do underground into clipville if i go thru where
   * a hole should be"*.
   *
   * `mouths` and `plans` are pushed together and stay index-aligned; this is
   * the same pair keyed for the drawing.
   */
  planFor(name: string): AccessPlan | null {
    for (let i = 0; i < this.mouths.length; i++) {
      if (this.mouths[i].name === name) return this.plans[i] ?? null;
    }
    return null;
  }
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
  /** Is this exact box already in the field? For the checks that copy one. */
  has(box: StationBox): boolean {
    for (const list of this.cells.values()) if (list.includes(box)) return true;
    return false;
  }

  /**
   * `groundY`, when the caller has it, is the terrain at the point, and it is
   * what keeps a body on the street from being handed the room under it: a
   * box answers only when its floor is at the ground (the flat pad at a
   * mouth) or the body is already under the ground (on the incline, in the
   * tunnel, in the room). Without it, a room whose lid sat within a head's
   * height of the pavement caught every body that walked over it -- the
   * *"I fall into the ground if I run over it"* of Hills Showground.
   */
  floorAt(x: number, z: number, feetY: number, groundY = Number.NaN): number {
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
      // The lean, if it has one. Floor and lid move together, so the band is
      // the same thickness everywhere on a ramp and a body walking down one is
      // never briefly outside it.
      let rise = box.slope === undefined ? 0 : box.slope * along;
      if (box.riseMax !== undefined && rise > box.riseMax) rise = box.riseMax;
      const floorY = box.floorY + rise;
      if (feetY < floorY - PLATFORM_STEP_M) continue;
      if (feetY > box.ceilY + rise - BOX_HEADROOM_M) continue;
      // ...unless the body is already on this floor: a body walking down the
      // incline is within a step of it at every sample, and the rule is about
      // the body that is not, standing on the pavement.
      if (
        Number.isFinite(groundY) &&
        floorY < groundY - UNDER_GROUND_M &&
        feetY > groundY - UNDER_GROUND_M &&
        feetY > floorY + PLATFORM_STEP_M
      ) continue;
      if (floorY > best) best = floorY;
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
/** The steepest incline a body walks without it reading as a slide: one in two. */
/**
 * 0.75 -- thirty-seven degrees, an escalator's pitch rather than a ramp's. It
 * was 1:2, and a 1:2 incline from a CBD pavement to a railhead thirty metres
 * down is sixty metres long, which is a strip no city block leaves free: every
 * candidate mouth within ninety metres of Wynyard's had a tower over some of
 * it. At 1:1.33 the head is under a building's base six metres in, and the
 * strip that has to be clear is the pad and those six metres.
 */
export const ACCESS_MAX_SLOPE = 0.75;
/** The flat tunnel from the incline's foot into the room, and how far past the wall it runs. */
export const ACCESS_TUNNEL_M = 8;
export const ACCESS_OVERLAP_M = 2.5;
/** A head over the incline floor; a building whose base is lower than this over any sample is in the way. */
export const ACCESS_HEAD_M = 1.9;

/**
 * The way into an underground station, as one set of numbers both ends and the
 * drawing read.
 *
 * **The mouth is the real entrance.** The bake carries the OSM entrance node
 * (`entranceX/Z/Y`, `entranceSource: 'osm'`) for every bore station, and the
 * first design ignored it: it stood a shaft 68 m along and 40 m across the
 * site, at the site's own ground height, which put the mouth in somebody's
 * yard and, where the street there was a few metres higher, under it. The
 * owner: *"cant reliably find entry"*, *"the entrance to stations is
 * impassible and also not really drawn properly"*. So the mouth is where the
 * entrance is, at the height the entrance is, which is a point the pipeline
 * measured against the DEM; the incline runs from it along the room's own
 * axis, no steeper than `ACCESS_MAX_SLOPE`, and a flat tunnel turns from its
 * foot into the room. The generated fallback stays for a bake with no
 * entrance node.
 */
export interface AccessPlan {
  /** The street end: where a player walks in, and the totem stands. */
  mouthX: number;
  mouthZ: number;
  mouthY: number;
  /** The incline's unit axis, from the mouth toward its foot, and its length. */
  dirX: number;
  dirZ: number;
  inclineM: number;
  /** The foot of the incline, at the room's floor height. */
  footX: number;
  footZ: number;
  floorY: number;
  /** The tunnel from the foot to the room, unit axis and length (into the wall by the overlap). */
  tunDirX: number;
  tunDirZ: number;
  tunnelM: number;
}

/**
 * What the world lends the plan: whether a point is inside a building, and
 * the ground there. Both ends have both -- the server at boot, the client once
 * the station's tile has landed -- and both are asked the same questions in
 * the same order, so the two plans are the same plan.
 */
export interface AccessWorld {
  /** The base of the lowest building standing on this point, or `NaN` for open ground. */
  baseAt?: (x: number, z: number) => number;
  groundAt?: (x: number, z: number) => number;
}

/**
 * The world's answers from the one collision field and the one ground both
 * ends hold. `server/world.ts` builds it at boot over the whole city; `main.ts`
 * rebuilds it as tiles land, so a station's plan on the client settles to the
 * server's once its tile is resident, and until then differs only in a mouth
 * the player is too far from to reach.
 */
export function accessWorldFrom(
  collision: { prismsWithin(x: number, z: number, r: number, out: Prism[]): void } | null,
  groundAt: (x: number, z: number) => number,
): AccessWorld {
  const scratch: Prism[] = [];
  return {
    baseAt: (x, z) => {
      if (collision === null) return Number.NaN;
      // A metre, not a search radius: `prismsWithin` measures to a prism's
      // bounding box, so the tower standing on the point is at distance zero
      // whatever its size, and the CBD's other hundred within thirty metres
      // were a polygon test each for nothing.
      scratch.length = 0;
      collision.prismsWithin(x, z, 1, scratch);
      let base = Number.NaN;
      for (const q of scratch) {
        if (q.structural || !pointInPolygon(q.points, x, z)) continue;
        if (!(base <= q.base)) base = q.base;
      }
      return base;
    },
    groundAt,
  };
}

export { CONCOURSE_OVER_RAIL_M };

/**
 * The room's lid: the bake's, unless the street over the site is lower, in
 * which case a margin under the street. Wynyard's bake put the ceiling five
 * metres *above* the DEM at the site, so the lid stood out of York Street as
 * a slab and the box's band reached up through the pavement -- the fall-in
 * the owner reported. Never lower than a standing height over the concourse.
 */
export function roomCeilY(st: RailStation, world: AccessWorld = {}): number {
  let ceil = st.boxCeilY;
  const g = world.groundAt ? world.groundAt(st.siteX, st.siteZ) : Number.NaN;
  if (Number.isFinite(g) && g - ROOM_LID_UNDER_STREET_M < ceil) {
    ceil = Math.max(g - ROOM_LID_UNDER_STREET_M, concourseY(st) + BOX_MIN_HEIGHT_M);
  }
  return ceil;
}
export const ROOM_LID_UNDER_STREET_M = 1.2;
/** How far under the terrain a floor, or a body, has to be before a station box may answer. See `floorAt`. */
export const UNDER_GROUND_M = 0.6;

/**
 * The concourse floor: platform level over the railhead the trains stand at.
 * `siteY` is the mean of the calling anchors -- the route's own height at the
 * stop, which is where `poseTrain` puts a door sill -- and `trackY` is the
 * pipeline's older number at the node, which is a metre off at Town Hall and
 * three at Wynyard. The bake's floor where neither was measured.
 */
export function concourseY(st: RailStation): number {
  if (st.concourseY !== undefined && Number.isFinite(st.concourseY)) return st.concourseY;
  if (Number.isFinite(st.siteY)) return st.siteY + CONCOURSE_OVER_RAIL_M;
  return Number.isFinite(st.trackY) ? st.trackY + CONCOURSE_OVER_RAIL_M : st.boxFloorY;
}

export function stationAccessPlan(st: RailStation, world: AccessWorld = {}): AccessPlan | null {
  if (st.vertical !== 'underground' || !st.belowGrade) return null;
  if (!st.servedDirs || st.servedDirs.length === 0) return null;
  if (!Number.isFinite(st.boxFloorY) || !Number.isFinite(st.boxCeilY)) return null;
  if (!(st.boxCeilY - st.boxFloorY >= BOX_MIN_HEIGHT_M)) return null;
  const ux = st.siteDx;
  const uz = st.siteDz;
  const px = -uz;
  const pz = ux;
  // The floor you walk on is the platform, not the ballast: a concourse at
  // the railhead's level is a 1.45 m climb onto every platform, which a body
  // cannot make. The trains sit `CONCOURSE_OVER_RAIL_M` below it, doors level.
  const floorY = concourseY(st);
  // The mouth: the OSM entrance if the bake has one within reach, else the
  // generated one. `entranceY` is the DEM at that point.
  const osm =
    st.entranceSource === 'osm' &&
    Number.isFinite(st.entranceX) && Number.isFinite(st.entranceZ) && Number.isFinite(st.entranceY) &&
    Math.hypot(st.entranceX - st.siteX, st.entranceZ - st.siteZ) < 260;
  let mouthX = osm ? st.entranceX : st.siteX + ux * ACCESS_ALONG_M + px * ACCESS_FAR_M;
  let mouthZ = osm ? st.entranceZ : st.siteZ + uz * ACCESS_ALONG_M + pz * ACCESS_FAR_M;
  // Out of the building it may stand in. Half the CBD's entrances are inside
  // a tower's footprint, and a mouth inside a wall is a mouth nobody reaches.
  // What has to be clear is the mouth, the pavement you step off, and the
  // first few metres of the incline before it is under the building's floor
  // -- `clear` walks those. Rings of eight compass points, nearest first,
  // deterministic.
  const inclineDir = (mx: number, mz: number): [number, number] => {
    const a = (mx - st.siteX) * ux + (mz - st.siteZ) * uz;
    const sgn = a > 0 ? -1 : 1;
    return [ux * sgn, uz * sgn];
  };
  // `clear`: no building stands on the pad, the mouth, or any part of the
  // incline a head would reach -- a body whose head is under a building's
  // base passes beneath it (`collision.resolve` and `roofHeight` both honour
  // the soffit); any higher, it is inside the walls. Checked against the
  // building's own base rather than the terrain, because a base is the low
  // corner of a footprint on a slope and can sit metres under the street.
  // `intrusion`: metres by which a building's base cuts into the head over
  // the incline, worst sample; 0 is clear. Sampled every metre, so a narrow
  // wing is not stepped over.
  const intrusion = (mx: number, mz: number): number => {
    if (!world.baseAt) return 0;
    const [dx, dz] = inclineDir(mx, mz);
    const g0 = world.groundAt ? world.groundAt(mx, mz) : Number.NaN;
    const top = Number.isFinite(g0) ? g0 : osm ? st.entranceY : st.boxCeilY;
    const len = Math.max((top - floorY) / ACCESS_MAX_SLOPE, 12);
    let worst = 0;
    for (let d = -ACCESS_OVERLAP_M; d <= len; d += 1) {
      // The pad is *behind* the mouth (negative `d`) at the mouth's height.
      const sx = mx + dx * d;
      const sz = mz + dz * d;
      const fl = top - Math.max(d, 0) * ACCESS_MAX_SLOPE;
      const base = world.baseAt(sx, sz);
      if (Number.isFinite(base) && fl + ACCESS_HEAD_M - base > worst) worst = fl + ACCESS_HEAD_M - base;
    }
    return worst;
  };
  let best = intrusion(mouthX, mouthZ);
  if (best > 0) {
    // Rings of eight compass points, nearest first; the first clear candidate
    // wins, and if none is clear within the reach, the least intruded upon.
    const R = 0.7071;
    const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1], [R, R], [-R, R], [R, -R], [-R, -R]];
    let bx = mouthX;
    let bz = mouthZ;
    search: for (let r = 4; r <= 90; r += 4) {
      for (const [dx, dz] of dirs) {
        const cx = mouthX + dx * r;
        const cz = mouthZ + dz * r;
        const here = intrusion(cx, cz);
        if (here < best) {
          best = here;
          bx = cx;
          bz = cz;
          if (here === 0) break search;
        }
      }
    }
    mouthX = bx;
    mouthZ = bz;
  }
  let mouthY = osm ? st.entranceY : st.boxCeilY;
  if (world.groundAt) {
    const g = world.groundAt(mouthX, mouthZ);
    if (Number.isFinite(g)) mouthY = g;
  }
  const drop = mouthY - floorY;
  if (!(drop > BOX_MIN_HEIGHT_M)) return null;
  // Where the mouth is in the room's frame, and which way along the room the
  // incline should run: toward the room's centre along its axis, so a mouth
  // off one end descends back toward the platforms.
  const rx = mouthX - st.siteX;
  const rz = mouthZ - st.siteZ;
  const across = rx * px + rz * pz;
  const [dirX, dirZ] = inclineDir(mouthX, mouthZ);
  const inclineM = Math.max(drop / ACCESS_MAX_SLOPE, 12);
  const footX = mouthX + dirX * inclineM;
  const footZ = mouthZ + dirZ * inclineM;
  // The tunnel: from the foot, across toward the room's centreline, into the
  // wall by the overlap. A foot already inside the room's plan still gets a
  // short one so the two floors overlap rather than meet.
  const side = across >= 0 ? 1 : -1;
  const tunDirX = -px * side;
  const tunDirZ = -pz * side;
  const wall = st.boxHalfWidth;
  const outside = Math.abs(across) - wall;
  const tunnelM = Math.max(ACCESS_TUNNEL_M, outside + ACCESS_OVERLAP_M);
  return { mouthX, mouthZ, mouthY, dirX, dirZ, inclineM, footX, footZ, floorY, tunDirX, tunDirZ, tunnelM };
}

export function buildStationBoxes(bake: RailBake, world: AccessWorld = {}): StationBoxField {
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
      // The concourse is at platform level; see `stationAccessPlan`.
      floorY: concourseY(st),
      ceilY: roomCeilY(st, world),
    });
    // **The way in.** See `stationAccessPlan`: the mouth at the real entrance,
    // an incline along the room's axis, a flat tunnel into it. The field and
    // `rail-geo.writeUndergroundStation` read the same plan, so the floor a
    // body stands on and the shaft it sees are one set of numbers.
    const plan = stationAccessPlan(st, world);
    if (plan !== null) {
      const drop = plan.mouthY - plan.floorY;
      const half = plan.inclineM / 2;
      // The incline's own axis points *outward* (foot to mouth), so a positive
      // `along` is uphill, which is the convention `floorAt`'s lean uses.
      field.add({
        name: `${st.name} access`,
        x: (plan.mouthX + plan.footX) / 2,
        z: (plan.mouthZ + plan.footZ) / 2,
        ux: -plan.dirX, uz: -plan.dirZ,
        halfLength: half + ACCESS_OVERLAP_M / 2,
        halfWidth: ACCESS_HALF_W,
        floorY: (plan.mouthY + plan.floorY) / 2,
        ceilY: (plan.mouthY + plan.floorY) / 2 + ACCESS_HEIGHT_M,
        slope: drop / plan.inclineM,
        riseMax: drop / 2,
      });
      const tMid = plan.tunnelM / 2;
      field.add({
        name: `${st.name} tunnel`,
        x: plan.footX + plan.tunDirX * tMid,
        z: plan.footZ + plan.tunDirZ * tMid,
        ux: plan.tunDirX, uz: plan.tunDirZ,
        halfLength: tMid + ACCESS_HALF_W,
        halfWidth: ACCESS_HALF_W,
        floorY: plan.floorY,
        ceilY: plan.floorY + ACCESS_HEIGHT_M,
      });
      field.mouths.push({ name: st.name, x: plan.mouthX, z: plan.mouthZ, y: plan.mouthY });
      field.plans.push(plan);
    }
  }
  return field;
}

// --- The hole in the street the way in goes down through -------------------------------
//
// The owner, at Wynyard: *"entrance to station is like passing thru floor and
// if i go down its like clipped out"*. The incline was drawn and stood on, but
// the terrain sheet ran straight across it -- a body walked *through* the
// footpath into the passage, and from under it the sheet, single-sided, was
// simply gone. So the ground is carved where the way in is, on the identical
// rule both ends already use for a cutting (`world/rail-cut.cutAt`): finite
// here means the terrain is not there and this is the ground instead.
//
// Three zones, one rectangle. Inside the passage's own plan, from the mouth to
// where its lid is safely under the street (`accessCutLength`), the ground is
// the incline floor. Around it, `ACCESS_APRON_M` each way, the ground is a flat
// concrete apron at the mouth's height, so the carve's four-metre lattice can
// take a sub-quad beside the passage and leave a slab rather than a void; the
// apron's own skirt hides the rest. Beyond that, nothing.

/** How far the apron reaches past the passage walls, and past its ends, metres. */
export const ACCESS_APRON_M = 2.6;
/** How far under the street the passage lid has to be before the ground may stand over it. */
export const ACCESS_LID_COVER_M = 0.35;

/**
 * How far down the incline the carve runs, metres from the mouth: the first
 * point where the lid is `ACCESS_LID_COVER_M` under the ground, or the whole
 * incline where the ground never gets over it. Sampled every half metre off
 * the same `groundAt` both ends' plans were made with.
 */
/** A point, for the winding helper below. */
export type Vec3 = readonly [number, number, number];

/**
 * Order a quad's four corners so its face **points away from `inside`**.
 *
 * Every enclosure this project draws -- a station room, the incline down to it,
 * the tunnel between them -- is drawn with a `BackSide` material, which is the
 * right choice: it is a box you stand *in*, and rendering only its back faces
 * means the shell never occludes the street above it. The catch is that
 * `BackSide` makes the winding load-bearing. A face is seen from inside only
 * when its own normal points outward, and `Solid.quad` takes its normal from
 * the order the corners arrive in.
 *
 * `rail-geo` wound each pair of opposite surfaces identically -- floor and
 * ceiling in one loop over `[0, H]`, both side walls in one loop over
 * `[-1, 1]` -- which reads as symmetry and is the opposite of it: the two
 * faces of a pair need *opposite* windings to both point outward. So one of
 * every pair was inside-out and invisible from within, and a player walking
 * down Wynyard's shaft looked through the missing floor at the underside of
 * the terrain and out through the missing wall at the skyline. The owner:
 * *"i do underground into clipville if i go thru where a hole should be"*.
 *
 * Rather than fix the four call sites by hand and leave the next one to get it
 * wrong, the winding is no longer something a caller states. It is derived
 * from where the inside is, which is the thing the caller actually knows.
 *
 * Three-free and pure, so `verifyStationAccess` can drive a whole box through
 * it on both ends.
 */
export function windOutward(inside: Vec3, a: Vec3, b: Vec3, c: Vec3, d: Vec3): [Vec3, Vec3, Vec3, Vec3] {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  // From the face's centre toward the inside; a normal that agrees with it is
  // pointing the wrong way. The diagonal's midpoint is the centre of any
  // planar quad this is used on.
  const cx = (a[0] + c[0]) / 2, cy = (a[1] + c[1]) / 2, cz = (a[2] + c[2]) / 2;
  const dot = nx * (inside[0] - cx) + ny * (inside[1] - cy) + nz * (inside[2] - cz);
  return dot > 0 ? [a, d, c, b] : [a, b, c, d];
}

export function accessCutLength(plan: AccessPlan, groundAt: ((x: number, z: number) => number) | undefined): number {
  const slope = (plan.mouthY - plan.floorY) / Math.max(plan.inclineM, 1e-6);
  if (groundAt === undefined) return Math.min(plan.inclineM, (ACCESS_HEIGHT_M + ACCESS_LID_COVER_M) / Math.max(slope, 1e-6));
  for (let d = 0; d <= plan.inclineM; d += 0.5) {
    const lid = plan.mouthY - slope * d + ACCESS_HEIGHT_M;
    const g = groundAt(plan.mouthX + plan.dirX * d, plan.mouthZ + plan.dirZ * d);
    if (Number.isFinite(g) && g - lid >= ACCESS_LID_COVER_M) return d;
  }
  return plan.inclineM;
}

/**
 * The ground the carve leaves at a point, or `NaN` where this plan leaves the
 * terrain alone. `cutLength` is `accessCutLength` for the plan, computed once
 * by whoever holds the plans.
 */
export function accessCutAt(plan: AccessPlan, cutLength: number, x: number, z: number): number {
  const dx = x - plan.mouthX;
  const dz = z - plan.mouthZ;
  const d = dx * plan.dirX + dz * plan.dirZ;
  const w = -dx * plan.dirZ + dz * plan.dirX;
  if (d < -ACCESS_APRON_M || d > cutLength + ACCESS_APRON_M) return Number.NaN;
  if (w < -ACCESS_HALF_W - ACCESS_APRON_M || w > ACCESS_HALF_W + ACCESS_APRON_M) return Number.NaN;
  if (d >= 0 && d <= cutLength && w >= -ACCESS_HALF_W && w <= ACCESS_HALF_W) {
    return plan.mouthY - ((plan.mouthY - plan.floorY) / Math.max(plan.inclineM, 1e-6)) * d;
  }
  return plan.mouthY;
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

// --- Walking between carriages ------------------------------------------------------------

/**
 * Which way round carriage `k` is coupled, as `+1` or `-1`. Zero off the end.
 *
 * The sign every piece of arithmetic in this section is written in terms of: a
 * carriage's local +X is the direction of increasing arc length when it is not
 * flipped and the opposite when it is, which is exactly what `carFrameAt` does
 * with the same flag. Naming it makes the crossing one line instead of four
 * branches, and four branches is where a sign goes missing.
 */
export function carSign(consist: Consist, car: number): number {
  const c = consist.cars[car];
  if (c === undefined) return 0;
  return c.flip ? -1 : 1;
}

/**
 * A carriage-local point, moved into another carriage of the same consist.
 *
 * ---------------------------------------------------------------------------
 * The one piece of algebra in this section, written out once so that
 * `crossGangway` and `net/client.reconcileAboard` cannot derive it differently.
 *
 * A point at local x in carriage k is at arc length `centre(k) + sign(k) * x`,
 * and `consistOffset` puts `centre(k) - centre(j)` at `(j - k) * pitch`. Solving
 * for the same arc length in j's frame:
 *
 *     x_j = turn * x_k + sign(j) * (j - k) * pitch     where turn = sign(j) * sign(k)
 *
 * `turn` is `+1` between two carriages coupled the same way round and `-1`
 * across a reversal -- which a `METRO` set has exactly one of, in the middle,
 * where the two trailer cars are back to back. Across a reversal the frame is
 * the old one turned through half a turn about its own up axis, so **z and the
 * x/z components of any free vector flip with it**. Only y survives untouched,
 * because the turn is about up.
 *
 * Returns false when either index is off the end of the consist, in which case
 * nothing is written -- a caller that ignored that would be reframing into a
 * carriage that is not there and would get a plausible number for it.
 */
export function reframeAcross(
  consist: Consist, fromCar: number, toCar: number, p: Vec3Out,
): boolean {
  const sk = carSign(consist, fromCar);
  const sj = carSign(consist, toCar);
  if (sk === 0 || sj === 0) return false;
  const turn = sj * sk;
  p.x = turn * p.x + sj * (toCar - fromCar) * consist.pitch;
  p.z = turn * p.z;
  return true;
}

/**
 * Half a turn, wrapped into (-pi, pi]. The yaw a reversed coupling costs.
 *
 * Written as an add and two compares rather than with a modulo, because a
 * negative operand's `%` is the one piece of arithmetic in this file people
 * disagree about -- and because the input is a yaw that is already wrapped, so
 * one subtraction is always enough.
 */
function halfTurnYaw(yaw: number): number {
  let y = yaw + Math.PI;
  if (y > Math.PI) y -= 2 * Math.PI;
  else if (y <= -Math.PI) y += 2 * Math.PI;
  return y;
}

/**
 * Walk a rider through a gangway if they have passed a coupling plane.
 *
 * ---------------------------------------------------------------------------
 * **THE WHOLE OF "MOVE BETWEEN CARRIAGES ON THE METRO WHILE THE TRAIN IS
 * MOVING", AND THE TRAIN'S SPEED IS NOT AN ARGUMENT.**
 *
 * There is no bake here, no clock, no pose and no metres a second. A carriage
 * frame is a stationary room -- that is section 1's whole claim -- so crossing
 * between two of them at 130 km/h is the same arithmetic as crossing between
 * them in a siding, and `verifyGangway` drives the identical walk at 0 m/s and
 * at 30 m/s and compares the two local trajectories with `Object.is`.
 *
 * Called inside the fixed step on **both** ends, from `rideExit`, after the
 * controller has moved the body and before the composition that turns the local
 * offset back into a world position. That ordering is the point: the frame the
 * body is composed against is the frame it ends the tick in, so the witness
 * `enterLocal` reads on the next tick is a witness the *new* carriage wrote.
 * Composing against the old carriage instead would be right to within the
 * railway's curvature over one carriage and wrong by exactly the amount that
 * makes a self-check pass and a curve look wrong.
 *
 * Returns the yaw delta it applied, which is `0` almost always and `+/-pi`
 * across the reversed coupling. **The caller owns what to do with it**, and on
 * the client that is not optional: `main.ts` keeps the rider's carriage-local
 * heading in `input.yaw` -- the mouse accumulator -- and writes it into the body
 * every tick, so a half turn applied here and not there is a rider who crosses
 * the middle of a Metro and is instantly facing the way they came. On the server
 * there is no accumulator to correct; the client's next input arrives already
 * turned, and this keeps the one snapshot in between honest.
 *
 * The loop is bounded by the consist rather than run once, and that is a guard
 * rather than a case: a walk is 0.07 m a tick and a plane is 11 m from the last
 * one, so nothing reachable crosses twice. What it protects against is a body
 * that arrived somewhere impossible -- a bad reframe, a replay seeded from a
 * stale snapshot -- being left two carriages out of its own index forever.
 */
export function crossGangway(a: AboardSlot, consist: Consist): number {
  let turned = 0;
  for (let guard = 0; guard < consist.cars.length; guard++) {
    const it = interiorOfCar(consist, a.car);
    if (it === null) return turned;
    const g = it.gangway;
    if (g === null) return turned;
    // Which end has been passed, if either. **Strictly past, and the strictness
    // is load-bearing**: a rider who crosses at `plane + d` arrives at
    // `-plane + d` in the neighbour, which is strictly inside *its* plane, so the
    // crossing cannot fire again on the same body in the same loop. With `>=` the
    // arrival at exactly `-plane` would qualify and a rider standing on a
    // coupling would ping-pong between the two carriages until the guard ran out
    // -- an even number of times, so it would land back where it started and
    // present as a gangway that simply does not work.
    const end = g.max && a.x > g.plane ? 1 : g.min && a.x < -g.plane ? -1 : 0;
    if (end === 0) return turned;

    const sk = carSign(consist, a.car);
    if (sk === 0) return turned;
    // The +X end of a carriage points at the carriage *ahead* of it when the
    // carriage is not flipped -- `consistOffset` gives car 0 the greatest arc
    // length -- and at the one behind when it is.
    const next = a.car + (end > 0 ? -sk : sk);
    const sj = carSign(consist, next);
    if (sj === 0) return turned;

    const turn = sj * sk;
    a.x = turn * a.x + sj * (next - a.car) * consist.pitch;
    a.z = turn * a.z;
    a.vx = turn * a.vx;
    a.vz = turn * a.vz;
    if (turn < 0) {
      // The delta that was actually applied rather than a nominal `Math.PI`.
      // `halfTurnYaw` wraps, so the step is `+pi` or `-pi` depending on which
      // side of the circle the rider was looking at -- and the caller adds this
      // to an accumulator that is never wrapped, so handing back the wrong one
      // would leave `input.yaw` a full turn away from `a.yaw` and the two
      // drifting apart every time somebody walks the length of the train.
      const before = a.yaw;
      a.yaw = halfTurnYaw(a.yaw);
      turned += a.yaw - before;
    }
    a.car = next;
  }
  return turned;
}

export function clearAboard(a: AboardSlot): void {
  a.line = NOT_ABOARD;
  a.vx = 0;
  a.vy = 0;
  a.vz = 0;
}

/** Copy one slot's ride into another. `net/client.ts` adopts the server's this way. */

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
  readAboard(a, body);
  projectAboard(a, body, f);
}

/**
 * The first half of `exitLocal`: take the stepped body's local pose into the slot.
 *
 * Split out so that `rideExit` can put the gangway crossing *between* the read
 * and the composition, which is the only place it can go -- the crossing changes
 * which carriage's frame the composition must use, and the composition is what
 * writes the witness. Nothing else calls this; `exitLocal` is still the two
 * halves together and is still what a caller with no bake wants.
 */
function readAboard(a: AboardSlot, body: RiderBody): void {
  const p = body.position;
  const v = body.velocity;
  a.x = p.x;
  a.y = p.y;
  a.z = p.z;
  a.vx = v.x;
  a.vy = v.y;
  a.vz = v.z;
  a.yaw = body.yaw;
}

/**
 * `exitLocal`, with the gangway in it. What both fixed steps actually call.
 *
 * Three statements in order, and the order is the whole function:
 *
 *   1. **Read** the stepped body's local pose into the slot. It is still in the
 *      carriage it started the tick in.
 *   2. **Cross**, if the controller walked it past a coupling plane. `a.car`
 *      changes and `a.x` shifts by the pitch; see `crossGangway`, which is pure
 *      and has never heard of the clock.
 *   3. **Compose** against the frame of the carriage it is in *now*, which is
 *      re-derived when step 2 fired. Composing against the old frame instead is
 *      wrong by the railway's curvature over one carriage -- centimetres, on a
 *      curve, every time anybody walks through a bellows, and invisible in every
 *      still.
 *
 * Returns the yaw delta the crossing applied, `0` unless the rider went through
 * the one reversed coupling in a Metro. See `crossGangway` for who owes what to
 * that number: on the client it has to be added to `input.yaw`, on the server it
 * can be dropped.
 *
 * A null bake, an unknown direction, or a frame that will not re-derive all fall
 * back to composing against the frame the caller already had -- which is the
 * pre-gangway behaviour exactly, and is one tick of a carriage-length lie rather
 * than a rider left with no world position at all.
 */
export function rideExit(
  bake: RailBake | null, a: AboardSlot, body: RiderBody, t: number, frame: CarFrame,
): number {
  readAboard(a, body);
  let turned = 0;
  if (bake !== null) {
    const dir = dirOf(bake, a.line, a.dir);
    if (dir !== null) {
      const was = a.car;
      turned = crossGangway(a, consistOf(dir, a.trip));
      // Only when the index really moved. `aboardFrame` is two binary searches
      // and two square roots and this runs for every rider on every tick, where
      // a crossing happens twice a minute at most.
      if (a.car !== was) aboardFrame(bake, a, t, frame);
    }
  }
  projectAboard(a, body, frame);
  return turned;
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

/**
 * And what `Opal Hop` reaches with, for a door that is not stopping, metres.
 *
 * *"E on a moving train door within 4 m boards it — you no longer need it
 * stopped."* A metre more than `BOARD_REACH_M`, and only for a train whose
 * doors are shut: a holder standing at a platform boards on the same three
 * metres as everybody else, because the node buys the *moving* door and nothing
 * else. See `BoardRules`.
 */
export const BOARD_MOVING_REACH_M = 4;

/**
 * What a particular player is allowed to board, as against where they are.
 *
 * One optional record rather than a flag argument, and it is threaded through
 * `boardHere` rather than read inside `findBoarding`, for the reason
 * `sim.tryBoard`'s header gives about everything else in this file: the client
 * predicts the board and the server adjudicates it, and the two have to be
 * asking the same question of the same geometry. A talent read *inside* the
 * search would be read from two different lookups on two different machines
 * with no seam to notice the disagreement at; a parameter is a thing both
 * callers can be seen passing.
 */
export interface BoardRules {
  /** `Opal Hop`: a door that is not stopping is still a door. */
  moving: boolean;
}

/** What everybody without the node gets, and the default every caller falls back to. */
export const BOARD_RULES_DEFAULT: BoardRules = { moving: false };

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
  rules: BoardRules = BOARD_RULES_DEFAULT,
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
      for (let j = -1; j <= live; j++) {
        const trip = Math.floor((t - dir.offset) / line.period) - j;
        if (!poseTrain(bake, dir, trip, t, _pose)) continue;
        // Doors open is the whole gate. `poseTrain` sets it only while the curve
        // is stationary at a calling station, which is a fifteen-second window.
        // **Unless the player bought the other half of it.** `Opal Hop` is the
        // one node that reaches past this line, and it is the only reason a
        // train that is not stopping is a train you can get on.
        if (!_pose.doorsOpen && !rules.moving) continue;
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
          // Inside the shell already, or too far off the side to reach. The
          // extra metre is `Opal Hop`'s and applies only to the moving door it
          // paid for -- at a platform every player has the same reach.
          if (outside > (_pose.doorsOpen ? BOARD_REACH_M : BOARD_MOVING_REACH_M)) continue;
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
  rules: BoardRules = BOARD_RULES_DEFAULT,
): boolean {
  const feetY = body.position.y - eyeHeight;
  if (!findBoarding(bake, body.position.x, feetY, body.position.z, t, offer, rules)) return false;
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
      for (let j = -1; j <= live; j++) {
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
  // platform's, an end carriage is hanging past the ramp, or -- since the slots
  // landed -- the rider is simply standing at the door on the side the corridor
  // had no room for. **Slide onto the platform rather than being put down beside
  // it** -- see `placeOn`, which is where the whole argument for that lives.
  // `ALIGHT_SNAP_M` bounds it to the width of the station, so a stop that
  // genuinely has no platform in the field still falls back to the carriage's
  // own rail level and does not get dragged across the yard to the next one.
  const snapped = platforms.placeOn(out.x, out.z, ALIGHT_SNAP_M, out);
  if (snapped > -Infinity) out.y = snapped + RIDER_EYE_HEIGHT;
}

/**
 * How far a disembark may be slid to land on a platform. See `alightPlatform`.
 *
 * ---------------------------------------------------------------------------
 * **IT WAS TWELVE, AND TWELVE WAS RIGHT FOR A RAILWAY WHERE EVERY TRACK HAD A
 * 9.4 m DECK ON BOTH SIDES.** The argument then was that a platform is 5.5 m
 * wide with its face 1.62 m off the track centre, so everything a disembark has
 * to correct -- a few centimetres of curve, a carriage end hanging past the
 * 160 m -- is inside ten metres, and anything wider is a different bug that
 * should look like one.
 *
 * The corridor rework made the deck a *slot occupant*: it is on the side the
 * budget left room on, and at an interchange it is on a road the stopping
 * anchor is not. `stopPlatform` hit this within an hour of the slots landing --
 * a rider carried past the buffers at Emu Plains put down on the naked side --
 * and was given `STRAND_SNAP_M`. **A disembark at an ordinary dwell has exactly
 * the same hole and did not get the same fix**, which is what this number is.
 *
 * Measured over every calling stop of every direction, both door bays, both
 * sides -- 2,014 landings, of which 880 need a slide at all:
 *
 *     slide needed      what it is
 *     0 m       1,084   the door is already over the deck
 *     0-12 m      631   a curve, or a carriage end past the ramp
 *     12-16 m     187   **the wrong side of the train**: the slot refused this
 *                       side and the deck is across the corridor, which is one
 *                       car body plus two deck widths
 *     16-46 m      60   the anchored road carries no deck and the station's is
 *                       on another road -- Central 38 m, Hornsby 46 m, Newtown
 *                       45 m, all of them platforms of that same station
 *     149 m         2   Museum, which has no deck of its own at all: this is
 *                       the *next* platform and is exactly what the bound is
 *                       for. Refused, and it falls back to rail level.
 *     no deck      50   Cabramatta, Museum and Summer Hill, where the corridor
 *                       built no slab at any of their anchors. No reach helps.
 *
 * So 48 m: the worst legitimate slide plus a margin, and still less than a
 * third of the shortest thing that would be somebody else's platform. The
 * sentence the number keeps is unchanged -- *this station, not a drag across
 * the yard* -- it is the station that got wider.
 */
export const ALIGHT_SNAP_M = 48;

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
  bake: RailBake, dir: RailDirection, stopIndex: number, side: number,
  platforms: PlatformField | null, out: Vec3Out,
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
  /*
   * And then the FIELD decides, exactly as `alightPlatform` does, because the
   * blind arithmetic above stopped being safe the day platforms stopped being
   * two 9.4 m decks that covered every mistake. `side` here is which side of
   * the carriage the body happened to be standing -- nothing checked that a
   * platform exists on that side, and for years nothing had to: the overlapped
   * decks caught everybody. The swept, budget-clipped platforms do not, and
   * the e2e acceptance found the hole within an hour of them landing -- a
   * rider carried past the buffers at Emu Plains was put down on the naked
   * side and fell. `placeOn` slides the landing to the nearest real deck,
   * crossing the corridor if the deck is on the other side; `ALIGHT_SNAP_M`
   * bounds it exactly as it bounds a disembark. No field -- a check world with
   * no platforms -- keeps the blind answer, which is the old behaviour.
   */
  if (platforms === null) return true;
  const top = platforms.surfaceAt(out.x, out.z);
  if (top > -Infinity) {
    out.y = top + RIDER_EYE_HEIGHT;
    return true;
  }
  const snapped = platforms.placeOn(out.x, out.z, STRAND_SNAP_M, out);
  if (snapped > -Infinity) out.y = snapped + RIDER_EYE_HEIGHT;
  return true;
}

/**
 * How far a STRANDED rider may be slid to land on the last platform.
 *
 * Deliberately not `ALIGHT_SNAP_M`. A disembark happens beside a deck and
 * twelve metres corrects a curve's worth of error; a terminus strand happens
 * where the *polyline* ends, and the bake trims a direction's polyline short
 * of the station it names -- measured at Emu Plains, the end of the Berowra
 * run stops 85.6 m from the site's centre, which put the strand point about
 * fourteen metres past the deck's end and `placeOn` under the old reach
 * refused it. The e2e acceptance caught the rider falling beside the buffers
 * the day the platforms stopped being wide enough to hide it.
 *
 * A hundred metres: over half a consist plus the trim, and still an order of
 * magnitude short of the next station, so the bound keeps meaning what
 * `placeOn`'s header wants it to mean -- this station, not a drag across the
 * yard. `strandRider`'s own contract is "put them on the last platform the
 * trip called at", and a slide to mid-deck is that contract kept, not a
 * teleport.
 */
export const STRAND_SNAP_M = 100;

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
  // The walk-through half, which is its own function because the **server** runs
  // it: `verifyRiding` needs the controller's two constants and there is nobody
  // in `server/index.ts` holding them, so folding the gangway into it would have
  // left the one new piece of shared arithmetic in the build checked on exactly
  // one of the two ends that evaluate it. See `verifyGangway`.
  for (const failure of verifyGangway()) bad.push(failure);
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

  // --- The disembark's clamp, on a curve, against the field that judges it.
  //
  // ---------------------------------------------------------------------------
  // **THE ONE PROPERTY `placeOn` HAS TO HAVE, AND THE ONE IT LOST.** It is the
  // only method here that *chooses* a point rather than answering about one, so
  // the point it hands back must be a point `surfaceAt` answers for. When the
  // corridor rework swept the deck along the running line it taught `surfaceAt`
  // the curve and left `placeOn` clamping into the anchor's straight rectangle,
  // and the two then disagreed by the platform's bow -- 36 of the bake's 2,014
  // disembarks slid onto a point the field called `-Infinity`, which is a body
  // stood on the paddock over a cutting with nothing saying so.
  //
  // Pure, and therefore here rather than only in the integration check: the
  // curve is a synthetic 200 m parabola with 16 m of bow over its 160 m, which
  // is Wollstonecraft's order of magnitude. No `Math.sin`/`cos`/`hypot` -- both
  // ends evaluate this, and `CLAUDE.md`'s determinism rule is not suspended for
  // a self-check.
  {
    const HALF = PLATFORM_HALF_LENGTH_M;
    const R = 200;
    const NODES = 17;
    const verts: number[] = [];
    const cum: number[] = [];
    let s = 0;
    for (let i = 0; i < NODES; i++) {
      const t = -HALF + (i * (2 * HALF)) / (NODES - 1);
      const x = t;
      const z = (t * t) / (2 * R);
      if (i > 0) {
        const dx = x - verts[(i - 1) * 3];
        const dz = z - verts[(i - 1) * 3 + 2];
        s += Math.sqrt(dx * dx + dz * dz);
      }
      verts.push(x, 0, z);
      cum.push(s);
    }
    const fakeBake = {
      vertices: new Float32Array(verts),
      cum: new Float32Array(cum),
    } as unknown as RailBake;
    const fakeDir = { vertexOff: 0, vertexCount: NODES } as unknown as RailDirection;
    // The anchor is the middle of the run, which on this curve is its vertex.
    const anchorS = cum[(NODES - 1) / 2];
    const spine = spineOn(fakeBake, fakeDir, anchorS, HALF);
    if (spine.bow < 8) bad.push(`the placeOn control curve bows only ${spine.bow.toFixed(1)} m and proves nothing`);
    const site: PlatformSite = {
      name: 'CONTROL', x: 0, z: 0, y: 0, ux: 1, uz: 0,
      outer: [PLATFORM_OUTER_M, PLATFORM_OUTER_M], spine,
    };
    const field = new PlatformField();
    field.add(site);
    // Riders standing at a door 12 m off the running line -- out past the
    // deck's outer face -- every ten metres of the platform's length, both
    // sides. Every one of them must be put somewhere `surfaceAt` answers for,
    // and the chord clamp this replaced must fail at least one of them, or the
    // curve is too gentle to be evidence.
    const put = { x: 0, y: 0, z: 0 };
    let refused = 0;
    let strayed = '';
    let chordOff = 0;
    for (let t = -HALF; t <= HALF; t += 10) {
      const f = frameAt(spine, t);
      for (const side of [-1, 1]) {
        const qx = f.x + -f.uz * side * 12;
        const qz = f.z + f.ux * side * 12;
        if (field.placeOn(qx, qz, ALIGHT_SNAP_M, put) === -Infinity) { refused++; continue; }
        if (field.surfaceAt(put.x, put.z) === -Infinity && strayed === '') {
          strayed = `(${put.x.toFixed(2)}, ${put.z.toFixed(2)}) from t=${t}, side ${side}`;
        }
        // THE NEGATIVE CONTROL, inline: the identical clamp in the anchor's own
        // chord, which is the arithmetic that shipped with the sweep.
        const along = Math.min(Math.max(qx * site.ux + qz * site.uz, -HALF + 0.1), HALF - 0.1);
        const across = qx * -site.uz + qz * site.ux;
        const mag = Math.min(
          Math.max(across < 0 ? -across : across, PLATFORM_INNER_M + 0.1),
          PLATFORM_INNER_M + PLATFORM_WIDTH_M - 0.1,
        );
        const o = across < 0 ? -mag : mag;
        if (field.surfaceAt(site.x + site.ux * along + -site.uz * o, site.z + site.uz * along + site.ux * o) === -Infinity) {
          chordOff++;
        }
      }
    }
    if (refused > 0) bad.push(`placeOn refused ${refused} of 34 bodies standing 12 m off a 160 m deck`);
    if (strayed !== '') {
      bad.push(
        `placeOn put a body at ${strayed} and surfaceAt answers nothing there -- the clamp and the ` +
          'field are in different frames again',
      );
    }
    if (chordOff === 0) {
      bad.push('the chord clamp lands on the deck every time, so the curved control proves nothing');
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
    // **Three, not one.** A served bore gets the station box, the access ramp
    // and the tunnel between them -- see `buildStationBoxes`, which grew the
    // second and third when the way in was built. This line said `1` for as
    // long as that had been true, and then went on saying it: the check failed
    // on every boot for every player, at `warn`, and nobody read it. Asserted
    // by name now, so a fourth box or a missing tunnel is a real failure.
    const boxNames = bore.boxes.map((b) => b.name).sort();
    const wantNames = ['A BORE', 'A BORE access', 'A BORE tunnel'];
    if (boxNames.join('|') !== wantNames.join('|')) {
      bad.push(`an underground station got station boxes [${boxNames.join(', ')}], expected [${wantNames.join(', ')}]`);
    } else if (bore.floorAt(0, 0, FLOOR) !== FLOOR) {
      bad.push(`the box built for an underground station does not answer its own floor`);
    }
  }
  return bad;
}

// --- The walk-through check ----------------------------------------------------------------

/**
 * A curving, climbing railway with nothing on it, for the two checks that need
 * a frame rather than a number.
 *
 * A stub rather than the shipped bake, on `world/trains.verifyTrainLights`' own
 * argument: the real bake is a 30 MB download and a self-check that runs at boot
 * on both ends has no business waiting for one. What `carFrameAt` reads of a bake
 * is exactly two arrays and four fields of a direction, so the stub is honest
 * about what it stands in for -- and it is deliberately **not straight and not
 * level**, because a straight level test track is the one shape on which a wrong
 * frame and a right frame agree.
 */
function gangwayStubBake(): { bake: RailBake; dir: RailDirection } {
  const N = 300;
  const SPAN = 10;
  const cum = new Float64Array(N);
  const vertices = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    const s = i * SPAN;
    cum[i] = s;
    // A parabolic drift across and a 2% climb, written as multiplies so the stub
    // has no trigonometry in it either -- see section 4. Over the 130 m a consist
    // occupies this bends about as hard as the approach to Redfern.
    const u = s / 1000;
    vertices[i * 3] = s;
    vertices[i * 3 + 1] = s * 0.02;
    vertices[i * 3 + 2] = u * u * 60;
  }
  return {
    bake: { cum, vertices } as unknown as RailBake,
    dir: { vertexOff: 0, vertexCount: N } as unknown as RailDirection,
  };
}

/** A Metro consist, without a bake to ask for one. See `consistOf`. */
function metroConsist(): Consist {
  return { cars: METRO, pitch: METRO_PITCH, pride: false, metro: true };
}

/**
 * One tick of a scripted walk along a consist: resolve, then cross.
 *
 * **The same two calls in the same order the fixed step makes**, which is the
 * only way this proves anything: `combat.advance` moves the body through
 * `CarriageStand.mover` (which is `carriageResolve`) and `rideExit` crosses it
 * afterwards. A driver that crossed first, or that skipped the resolver, would
 * be testing a walk nobody can perform -- which is precisely how the riding
 * feature shipped broken the first time, with an acceptance harness that wrote
 * its own copy of the seam.
 *
 * `step` is the local x displacement this tick, signed, and it comes back
 * flipped when the crossing went through a reversed coupling: a rider walking
 * one way in the world walks the other way in a carriage that is coupled the
 * other way round, and the caller keeps the world direction.
 */
function walkTick(
  a: AboardSlot, consist: Consist, step: number, feetY: number, out: CarriageMove,
): number {
  const it = interiorOfCar(consist, a.car);
  if (it === null) return step;
  // `feetY + PLATFORM_STEP_M`, because that is what `controller.step` hands a
  // mover -- the kerb probe rather than the feet. A driver that passed the feet
  // would be a driver testing a resolver nobody calls. See `gangwayAdmits`.
  carriageResolve(it, a.x, a.z, a.x + step, a.z, RIDER_RADIUS, feetY + PLATFORM_STEP_M, out);
  a.x = out.x;
  a.z = out.z;
  return crossGangway(a, consist) !== 0 ? -step : step;
}

/** Arc length of a rider along their own train, for the monotonicity sweep. */
function riderArc(consist: Consist, a: AboardSlot, head: number): number {
  const centre = consistOffset(head, a.car, consist.cars.length, consist.pitch);
  return centre + carSign(consist, a.car) * a.x;
}

/**
 * The gangways: the table, the arithmetic, and a rider walking the whole train.
 *
 * ---------------------------------------------------------------------------
 * Its own export rather than a paragraph inside `verifyRiding`, because **both
 * runtimes run this one**. `verifyRiding` takes the controller's eye height and
 * body radius as arguments so the two restated constants can be compared against
 * the originals, and there is nobody in `server/index.ts` holding either -- so a
 * gangway check that lived only in there would be checked in the browser and not
 * in the process that is authoritative for where every rider in the city is
 * standing. `verifyRiding` calls this as well, so the browser gets it too and
 * there is one implementation.
 *
 * Every failure here is silent in this repo's sense. A gangway that is shut is a
 * feature that looks unbuilt. A gangway that is open at the wrong end is a rider
 * walking out of the front of the train. A sign wrong in `crossGangway` is a
 * rider who steps into the next carriage and is 22 m from where the other end
 * thinks they are -- which renders as a passenger standing in the four-foot, at
 * 130 km/h, on somebody else's screen only.
 */
/**
 * The way into an underground station, walked end to end.
 *
 * **The failure this exists for is a gap you fall down**, and it is invisible
 * from any single query: every box can answer correctly on its own while the
 * seam between two of them answers `-Infinity`, and a body crossing that seam
 * is handed back to a terrain surface twenty metres overhead. So this does not
 * test boxes. It walks from the street to the platform in centimetre steps and
 * asserts the floor never stops answering and never jumps more than a step.
 */
export function verifyStationAccess(): string[] {
  const failures: string[] = [];
  // --- The carve. A plan running along +z from a mouth at the origin, 10 m
  // deep over 13.3 m, flat ground at 0: the lid (4.2 m over the floor) is
  // under the street past d = (4.2 + cover) / 0.75.
  {
    const plan: AccessPlan = {
      mouthX: 0, mouthZ: 0, mouthY: 0, dirX: 0, dirZ: 1, inclineM: 13.3,
      footX: 0, footZ: 13.3, floorY: -10, tunDirX: 1, tunDirZ: 0, tunnelM: 20,
    };
    const len = accessCutLength(plan, () => 0);
    const expect = (ACCESS_HEIGHT_M + ACCESS_LID_COVER_M) / (10 / 13.3);
    if (Math.abs(len - expect) > 0.6) failures.push(`the carve runs ${len.toFixed(1)} m down the incline; the lid is under the street at ${expect.toFixed(1)} m`);
    if (accessCutLength(plan, () => -100) !== plan.inclineM) failures.push('ground that never covers the lid should carve the whole incline');
    if (accessCutLength(plan, () => 100) !== 0) failures.push('ground already over the lid at the mouth carves nothing past it');
    const atMouth = accessCutAt(plan, len, 0, 0.1);
    if (!(Math.abs(atMouth) < 0.1)) failures.push(`the ground at the mouth is the mouth's height, not ${atMouth}`);
    const mid = accessCutAt(plan, len, 0, 4);
    if (!(Math.abs(mid - (-4 * 10 / 13.3)) < 0.05)) failures.push(`4 m down the incline the ground is the floor, not ${mid}`);
    const apron = accessCutAt(plan, len, ACCESS_HALF_W + 1, 2);
    if (apron !== 0) failures.push(`beside the passage the ground is the apron at the mouth's height, not ${apron}`);
    if (Number.isFinite(accessCutAt(plan, len, ACCESS_HALF_W + ACCESS_APRON_M + 0.5, 2))) failures.push('past the apron the terrain is left alone');
    if (Number.isFinite(accessCutAt(plan, len, 0, len + ACCESS_APRON_M + 0.5))) failures.push('past the carve\'s end the terrain is left alone');
    if (Number.isFinite(accessCutAt(plan, len, 0, -ACCESS_APRON_M - 0.5))) failures.push('in front of the apron the terrain is left alone');
  }
  const field = new StationBoxField();
  const street = 40;
  const floor = 20;
  const half = (ACCESS_FAR_M - ACCESS_NEAR_M) / 2;
  const mid = (ACCESS_FAR_M + ACCESS_NEAR_M) / 2;
  // A station lying along +x, so the access runs along +z and the arithmetic
  // below is readable.
  field.add({
    name: 'room', x: 0, z: 0, ux: 1, uz: 0,
    halfLength: 88, halfWidth: 13, floorY: floor, ceilY: street,
  });
  field.add({
    name: 'access', x: 0, z: mid, ux: 0, uz: 1,
    halfLength: half, halfWidth: ACCESS_HALF_W,
    floorY: (street + floor) / 2, ceilY: (street + floor) / 2 + ACCESS_HEIGHT_M,
    slope: (street - floor) / (2 * half),
  });
  const tMid = (ACCESS_NEAR_M + 11) / 2;
  field.add({
    name: 'tunnel', x: 0, z: tMid, ux: 0, uz: 1,
    halfLength: (ACCESS_NEAR_M - 11) / 2, halfWidth: ACCESS_HALF_W,
    floorY: floor, ceilY: floor + ACCESS_HEIGHT_M,
  });

  // The incline leans the right way: the street end is up, the concourse end
  // is down. Backwards here is a staircase into the sky.
  const atTop = field.floorAt(0, ACCESS_FAR_M - 0.5, street);
  const atBottom = field.floorAt(0, ACCESS_NEAR_M + 0.5, floor);
  if (!(atTop > atBottom)) {
    failures.push(`the incline runs the wrong way: ${atTop.toFixed(1)} m at the street, ${atBottom.toFixed(1)} m at the concourse.`);
  }
  if (Math.abs(atTop - street) > 1.5) {
    failures.push(`the top of the incline is ${atTop.toFixed(1)} m against a street at ${street} m; you would step into a hole.`);
  }

  // The walk. Feet follow the floor, which is what a body does.
  let feet = street;
  let last = street;
  for (let across = ACCESS_FAR_M - 0.2; across > 2; across -= 0.05) {
    const y = field.floorAt(0, across, feet);
    if (y === -Infinity) {
      failures.push(`the floor stopped answering ${across.toFixed(1)} m out; a body there is handed back to the terrain overhead`);
      break;
    }
    if (Math.abs(y - last) > PLATFORM_STEP_M) {
      failures.push(`the floor jumped ${(y - last).toFixed(2)} m at ${across.toFixed(1)} m out, which is a step a body catches on`);
      break;
    }
    last = y;
    feet = y;
  }
  if (Math.abs(feet - floor) > 0.5) {
    failures.push(`the walk ended at ${feet.toFixed(1)} m rather than the concourse at ${floor} m.`);
  }

  // The plan, on three stations shaped like the real ones: an entrance off
  // the end of the room, one beside it, and a deep one close by. Each is
  // walked from the mouth to the platform floor in the controller's own
  // steps, and the incline is never steeper than one in two.
  const like = (over: Partial<RailStation>): RailStation => ({
    name: 'X', x: 0, z: 0, trackY: -CONCOURSE_OVER_RAIL_M, groundY: 20, vertical: 'underground', depth: 20, clearance: 0, clearanceLo: 0, clearanceHi: 0,
    structure: 'tunnel', conflict: false, approachShare: 1, approachWays: 1, promoted: false, orphaned: false, kind: 'station',
    platforms: [], tunnelShare: 1, bridgeShare: 0, siteX: 0, siteZ: 0, siteDx: 1, siteDz: 0, siteY: 0, siteGroundY: 20, siteSpread: 0,
    siteFaces: 0, servedDirs: [0, 1], lines: [], faces: 0, refs: [], islands: 1, sides: 0, platformLength: 160,
    entranceX: 0, entranceZ: 0, entranceY: 20, entranceSource: 'osm', shaftDepth: 20, belowGrade: true,
    boxFloorY: 0, boxCeilY: 20, boxHalfLength: 100, boxHalfWidth: 16,
    ...over,
  } as unknown as RailStation);
  const cases: Array<[string, RailStation]> = [
    ['off the end', like({ entranceX: 130, entranceZ: 30, entranceY: 22 })],
    ['beside it', like({ entranceX: 10, entranceZ: 40, entranceY: 19 })],
    ['deep and close', like({ entranceX: 20, entranceZ: 25, entranceY: 40, boxCeilY: 39, groundY: 40, siteGroundY: 40 })],
  ];
  for (const [what, st] of cases) {
    const plan = stationAccessPlan(st);
    if (plan === null) {
      failures.push(`${what}: no plan.`);
      continue;
    }
    if (Math.abs(plan.mouthX - st.entranceX) > 1e-9 || Math.abs(plan.mouthY - st.entranceY) > 1e-9) failures.push(`${what}: the mouth is not at the entrance.`);
    if ((plan.mouthY - plan.floorY) / plan.inclineM > ACCESS_MAX_SLOPE + 1e-9) failures.push(`${what}: the incline is steeper than one in two.`);
    const f = new StationBoxField();
    for (const b of (() => { const fb = buildStationBoxes({ stations: [st] } as unknown as RailBake); return (fb as unknown as { cells: Map<string, StationBox[]> }).cells; })().values()) for (const box of b) if (!f.has(box)) f.add(box);
    // Walk: mouth to foot along the incline, then along the tunnel into the room.
    let feet = plan.mouthY;
    let ok = true;
    const stepTo = (nx: number, nz: number): void => {
      const y = f.floorAt(nx, nz, feet);
      if (y === -Infinity) { failures.push(`${what}: the floor stopped answering at (${nx.toFixed(1)}, ${nz.toFixed(1)}), ${feet.toFixed(1)} m.`); ok = false; return; }
      if (Math.abs(y - feet) > PLATFORM_STEP_M) { failures.push(`${what}: the floor jumped ${(y - feet).toFixed(2)} m at (${nx.toFixed(1)}, ${nz.toFixed(1)}).`); ok = false; return; }
      feet = y;
    };
    for (let d = 0.3; d < plan.inclineM - 0.3 && ok; d += 0.1) stepTo(plan.mouthX + plan.dirX * d, plan.mouthZ + plan.dirZ * d);
    for (let d = 0; d < plan.tunnelM - 0.3 && ok; d += 0.1) stepTo(plan.footX + plan.tunDirX * d, plan.footZ + plan.tunDirZ * d);
    if (ok && Math.abs(feet - plan.floorY) > 0.5) failures.push(`${what}: the walk ended at ${feet.toFixed(1)} m, not the floor at ${plan.floorY}.`);
    // A mouth in a building is moved out of it, and lands on the ground it is given.
    const nudged = stationAccessPlan(st, { baseAt: (x, z) => (Math.hypot(x - st.entranceX, z - st.entranceZ) < 6 ? 31 : Number.NaN), groundAt: () => 31 });
    if (nudged === null || Math.hypot(nudged.mouthX - st.entranceX, nudged.mouthZ - st.entranceZ) < 6) failures.push(`${what}: a mouth inside a building was not moved out of it.`);
    if (nudged !== null && nudged.mouthY !== 31) failures.push(`${what}: the mouth did not take the ground it was given.`);
    // And a body on the street over the room is not in the room.
    if (f.floorAt(st.siteX, st.siteZ, st.groundY) > -Infinity) failures.push(`${what}: a body on the street over the station is handed the concourse floor; it would fall in.`);
  }

  // A slope of zero is the room it always was.
  const flat = new StationBoxField();
  flat.add({ name: 'flat', x: 0, z: 0, ux: 1, uz: 0, halfLength: 20, halfWidth: 5, floorY: 7, ceilY: 14 });
  if (flat.floorAt(10, 0, 7) !== 7 || flat.floorAt(-10, 0, 7) !== 7) {
    failures.push('an unsloped box no longer answers one height across its length.');
  }
  // --- Every face of a shell points outward, so a `BackSide` lining is whole
  //     from inside. See `windOutward`: this is the bug that put the owner
  //     under the world at Wynyard, driven over a box rather than a shaft
  //     because a box has all six directions in it.
  {
    const lo = [-2, -3, -4] as const;
    const hi = [5, 6, 7] as const;
    const inside: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
    const corner = (i: number, j: number, k: number): Vec3 => [i ? hi[0] : lo[0], j ? hi[1] : lo[1], k ? hi[2] : lo[2]];
    // The six faces, each given in a deliberately arbitrary order.
    const faces: Array<[string, Vec3, Vec3, Vec3, Vec3]> = [
      ['floor', corner(0, 0, 0), corner(1, 0, 0), corner(1, 0, 1), corner(0, 0, 1)],
      ['ceiling', corner(0, 1, 0), corner(1, 1, 0), corner(1, 1, 1), corner(0, 1, 1)],
      ['west', corner(0, 0, 0), corner(0, 1, 0), corner(0, 1, 1), corner(0, 0, 1)],
      ['east', corner(1, 0, 0), corner(1, 1, 0), corner(1, 1, 1), corner(1, 0, 1)],
      ['north', corner(0, 0, 0), corner(1, 0, 0), corner(1, 1, 0), corner(0, 1, 0)],
      ['south', corner(0, 0, 1), corner(1, 0, 1), corner(1, 1, 1), corner(0, 1, 1)],
    ];
    for (const [name, a, b, c, d] of faces) {
      const [p, q, r, t] = windOutward(inside, a, b, c, d);
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = t[0] - p[0], vy = t[1] - p[1], vz = t[2] - p[2];
      const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      const cx = (p[0] + r[0]) / 2, cy = (p[1] + r[1]) / 2, cz = (p[2] + r[2]) / 2;
      const dot = n[0] * (inside[0] - cx) + n[1] * (inside[1] - cy) + n[2] * (inside[2] - cz);
      if (dot >= 0) failures.push(`the ${name} of a shell faces inward; a BackSide lining would have a hole there.`);
      // And it is a re-ordering, not a new quad: the same four corners come back.
      const same = [p, q, r, t].every((v) => [a, b, c, d].some((w) => w[0] === v[0] && w[1] === v[1] && w[2] === v[2]));
      if (!same) failures.push(`the ${name} came back with corners that were not the ones given.`);
    }
  }

  // --- The field's plans are addressable by name, which is what lets the
  //     drawing read the same numbers the collision stands bodies on rather
  //     than working out its own. See `rail-geo.setAccessPlans`.
  {
    const st = like({ entranceX: 40, entranceZ: 20, entranceY: 20, name: 'Testville' });
    const field = buildStationBoxes({ stations: [st] } as unknown as RailBake);
    if (field.mouths.length !== field.plans.length) {
      failures.push(`${field.mouths.length} mouths against ${field.plans.length} plans; the two are meant to be pushed together.`);
    }
    for (let i = 0; i < field.mouths.length; i++) {
      const got = field.planFor(field.mouths[i].name);
      if (got !== field.plans[i]) failures.push(`planFor("${field.mouths[i].name}") did not return that mouth's own plan.`);
      if (got !== null && (Math.abs(got.mouthX - field.mouths[i].x) > 1e-9 || Math.abs(got.mouthZ - field.mouths[i].z) > 1e-9)) {
        failures.push('a mouth and the plan behind it are in different places.');
      }
    }
    if (field.planFor('a station that does not exist') !== null) failures.push('planFor invented a plan for an unknown station.');
  }

  // --- **The mouth walks out of the building it lands in** -- and it can only
  //     do that if it is asked when the buildings are actually there.
  //
  // Half the CBD's OSM entrance nodes are inside a tower's footprint, which is
  // true of the real city: Wynyard's entrances are inside Wynyard Place. The
  // search above exists for exactly that and works. What went wrong on the
  // shipped world is that `loadWorld` built the field before the prisms were
  // carved, so `baseAt` answered "nothing there" for every candidate, the
  // intrusion read zero, and the search never ran -- seven of twenty-eight
  // mouths ended up under a roof, Wynyard's under thirty-six metres of tower
  // with no way in at all. Both halves are asserted here: a world that can see
  // the building moves the mouth out of it, and a world that cannot leaves it
  // exactly where the bake put it, which is the shape of the bug.
  {
    const st = like({ entranceX: 0, entranceZ: 0, entranceY: 20 });
    const HALF = 20;
    const inTower = (x: number, z: number): boolean =>
      x >= -HALF && x <= HALF && z >= -HALF && z <= HALF;
    // A tower over the entrance whose base is two metres under the street, so
    // a body at the pad is inside its walls rather than under its soffit.
    const seeing: AccessWorld = {
      baseAt: (x, z) => (inTower(x, z) ? 18 : Number.NaN),
      groundAt: () => 20,
    };
    const blind: AccessWorld = { groundAt: () => 20 };

    const moved = stationAccessPlan(st, seeing);
    if (moved === null) failures.push('a station with a tower over its entrance produced no plan at all.');
    else {
      if (inTower(moved.mouthX, moved.mouthZ)) {
        failures.push(`the mouth stayed inside the tower at (${moved.mouthX.toFixed(1)}, ${moved.mouthZ.toFixed(1)}).`);
      }
      const out = Math.hypot(moved.mouthX - st.entranceX, moved.mouthZ - st.entranceZ);
      if (out > 90) failures.push(`the mouth moved ${out.toFixed(0)} m, past the search's own reach.`);
      // And the first metres of the incline are clear too, not just the pad --
      // a mouth on the kerb with the ramp still under the tower is no better.
      for (let d = 0; d <= 6; d += 1) {
        if (inTower(moved.mouthX + moved.dirX * d, moved.mouthZ + moved.dirZ * d)) {
          failures.push(`${d} m down the incline is still inside the tower.`);
          break;
        }
      }
    }

    const stuck = stationAccessPlan(st, blind);
    if (stuck === null) failures.push('the same station produced no plan against a world with no buildings in it.');
    else if (Math.abs(stuck.mouthX - st.entranceX) > 1e-9 || Math.abs(stuck.mouthZ - st.entranceZ) > 1e-9) {
      failures.push('a world that cannot see buildings moved the mouth anyway; the search is reading something else.');
    }
  }

  return failures;
}

export function verifyGangway(): string[] {
  const bad: string[] = [];
  const consist = metroConsist();
  const n = consist.cars.length;

  // --- 1. The table. Which ends are open is a claim about the consist, and the
  //        consist is in another table twenty lines up; this is the only place
  //        the two are ever compared.
  for (const it of INTERIORS) {
    const g = it.gangway;
    if (g === null) continue;
    if (it.deck !== null) {
      bad.push(
        `${it.key} has a gangway and two decks. A gangway is a hole at one height and a ` +
          `double-decker's ends are at three; gangwayAdmits answers off vestibuleY alone and ` +
          `would put the aperture in the ceiling of the lower saloon.`,
      );
    }
    if (g.plane * 2 !== METRO_PITCH) {
      bad.push(
        `${it.key}'s crossing plane is ${g.plane} m, which is not half the ${METRO_PITCH} m Metro ` +
          `pitch. The plane is one point in the world seen from two carriages -- half a metre of ` +
          `disagreement is a rider who crosses and is pushed straight back.`,
      );
    }
    if (GANGWAY_HALF_WIDTH_M - RIDER_RADIUS < 0.2) {
      bad.push(
        `the gangway aperture is ${(GANGWAY_HALF_WIDTH_M * 2).toFixed(2)} m wide against a ` +
          `${(RIDER_RADIUS * 2).toFixed(2)} m body, which leaves ` +
          `${((GANGWAY_HALF_WIDTH_M - RIDER_RADIUS) * 2).toFixed(2)} m of aim. A gangway a player ` +
          `has to line up on is a gangway they report as shut.`,
      );
    }
    if (GANGWAY_HEIGHT_M <= RIDER_EYE_HEIGHT) {
      bad.push(
        `the gangway header is ${GANGWAY_HEIGHT_M} m over a floor a ${RIDER_EYE_HEIGHT} m eye ` +
          `stands on. Nobody can walk through it standing up.`,
      );
    }
  }
  for (const car of SUBURBAN) {
    const it = interiorFor(car.key);
    if (it !== null && it.gangway !== null) {
      bad.push(
        `${car.key} runs in a SUBURBAN consist and has a gangway. A Tangara's ends are bulkheads ` +
          `and its saloons are two decks 2.1 m apart; opening one is a passenger walking into the ` +
          `space between two carriages at 110 km/h.`,
      );
    }
  }
  // And the ends themselves, against the consist's own adjacency: an end with a
  // neighbour behind it must be open and an end with the outside behind it must
  // not. Getting this backwards at the two lead cars is a rider stepping out of
  // the nose of the train, which is a fall the game has no animation for.
  for (let k = 0; k < n; k++) {
    const it = interiorOfCar(consist, k);
    if (it === null) { bad.push(`METRO carriage ${k} (${consist.cars[k].key}) has no interior`); continue; }
    const g = it.gangway;
    if (g === null) { bad.push(`METRO carriage ${k} (${consist.cars[k].key}) has no gangway at all`); continue; }
    const s = carSign(consist, k);
    // The +X end faces the carriage ahead when the car is not flipped.
    const aheadOfMaxEnd = k - s;
    const aheadOfMinEnd = k + s;
    const wantMax = aheadOfMaxEnd >= 0 && aheadOfMaxEnd < n;
    const wantMin = aheadOfMinEnd >= 0 && aheadOfMinEnd < n;
    if (g.max !== wantMax || g.min !== wantMin) {
      bad.push(
        `METRO carriage ${k} (${consist.cars[k].key}, flip ${consist.cars[k].flip}) is open ` +
          `${g.min ? '-X' : ''}${g.min && g.max ? ' and ' : ''}${g.max ? '+X' : ''} and its ` +
          `neighbours are at ${wantMin ? aheadOfMinEnd : 'nothing'} off -X and ` +
          `${wantMax ? aheadOfMaxEnd : 'nothing'} off +X. An open end with no carriage behind it ` +
          `is a hole in the front of the train.`,
      );
    }
  }

  // --- 2. The aperture, at its four corners. A hole that is too big and a hole
  //        that is not there both look like a wall from one sample, so this
  //        drives `carriageResolve` at the centre, off to one side, mid-jump and
  //        on a Tangara -- and the last three must all be refused.
  {
    const mid = interiorFor(`${METROPOLIS}:mid`)!;
    const cab = interiorFor(`${TANGARA}:cab`)!;
    const move: CarriageMove = { x: 0, z: 0, hit: false };
    const floor = mid.vestibuleY;
    const plane = mid.gangway!.plane;
    // Feet, and the driver adds the step probe exactly as `controller.step` does.
    const cases: ReadonlyArray<readonly [string, CarriageInterior, number, number, boolean]> = [
      ['down the middle of a Metro gangway', mid, 0, floor, true],
      ['off to one side of it', mid, 0.55, floor, false],
      ['at the very edge of the aperture', mid, GANGWAY_HALF_WIDTH_M - RIDER_RADIUS - 0.01, floor, true],
      ['a hand past the edge of it', mid, GANGWAY_HALF_WIDTH_M - RIDER_RADIUS + 0.05, floor, false],
      ['at the top of a jump', mid, 0, floor + 1.0, false],
      ['through a Tangara bulkhead', cab, 0, cab.vestibuleY, false],
    ];
    for (const [what, it, z, feetY, want] of cases) {
      const from = it.xMax - 1;
      carriageResolve(it, from, z, from + 3, z, RIDER_RADIUS, feetY + PLATFORM_STEP_M, move);
      const through = move.x > it.xMax - RIDER_RADIUS + 1e-9;
      if (through !== want) {
        bad.push(
          `a body walking ${what} was ${through ? '' : 'not '}let past the carriage end and ` +
            `should ${want ? '' : 'not '}have been; it stopped at x ${move.x.toFixed(3)} against a ` +
            `bulkhead at ${(it.xMax - RIDER_RADIUS).toFixed(3)} and a plane at ${plane}.`,
        );
      }
    }
    // And the tube's own side wall: a body already through the ring cannot then
    // sidestep out of the train between the two carriages.
    carriageResolve(
      mid, plane - 0.1, 0, plane - 0.1, 1.2, RIDER_RADIUS, floor + PLATFORM_STEP_M, move,
    );
    if (Math.abs(move.z) > GANGWAY_HALF_WIDTH_M - RIDER_RADIUS + 1e-9) {
      bad.push(
        `a body standing in the bellows sidestepped to z ${move.z.toFixed(3)}, which is outside the ` +
          `${GANGWAY_HALF_WIDTH_M} m aperture. Between two carriages there is a concertina and then ` +
          `there is the ballast.`,
      );
    }
    // ...and that it is not *pushed back down the train* for trying, which is
    // the version of this rule that reads correctly and plays wrong. See
    // `carriageResolve`.
    if (move.x < plane - 0.1 - 1e-9) {
      bad.push(
        `a body in the bellows that pushed sideways was dragged from x ${(plane - 0.1).toFixed(2)} ` +
          `back to ${move.x.toFixed(2)}. A sideways key must not move anybody along the train.`,
      );
    }
  }

  // --- 3. THE ALGEBRA, BOTH WAYS AND AGAINST ITSELF.
  //
  // Two claims, and they are different claims. `reframeAcross` must be its own
  // inverse -- there and back is a multiply by the same +/-1 and an add and a
  // subtract of the same pitch, so the doubles must come back identical and this
  // asserts `Object.is` rather than a tolerance. And `crossGangway` must agree
  // with it: the walk-through path and the reconciler's path are the same change
  // of basis, and the whole reason `reframeAcross` is a separate export is that a
  // second copy of this arithmetic in `net/client.ts` is a second copy that can
  // be signed differently -- which presents as a rider who is fine until they
  // are corrected, and then is in the wrong carriage.
  for (let k = 0; k < n; k++) {
    for (const end of [-1, 1] as const) {
      const it = interiorOfCar(consist, k);
      const g = it?.gangway ?? null;
      if (g === null || !(end < 0 ? g.min : g.max)) continue;
      const s = carSign(consist, k);
      const j = k + (end > 0 ? -s : s);
      const seed = { x: end * (g.plane + 0.12), y: 1.23 + RIDER_EYE_HEIGHT, z: 0.21 };

      // (a) There and back, on the pure function.
      const p: Vec3Out = { x: seed.x, y: seed.y, z: seed.z };
      if (!reframeAcross(consist, k, j, p) || !reframeAcross(consist, j, k, p)) {
        bad.push(`reframeAcross refused the coupling between METRO carriages ${k} and ${j}`);
        continue;
      }
      for (const [name, got, want] of [
        ['x', p.x, seed.x], ['y', p.y, seed.y], ['z', p.z, seed.z],
      ] as ReadonlyArray<readonly [string, number, number]>) {
        if (!Object.is(got, want)) {
          bad.push(
            `reframing between METRO carriages ${k} and ${j} and back changed ${name} from ${want} ` +
              `to ${got}. Both directions are the same multiply by the same +/-1 and the same ` +
              `${consist.pitch} m; a difference is a sign written twice.`,
          );
        }
      }

      // (b) And the walk-through path lands on exactly what (a) says it should.
      const want: Vec3Out = { x: seed.x, y: seed.y, z: seed.z };
      reframeAcross(consist, k, j, want);
      const a = createAboardSlot();
      a.line = 0;
      a.car = k;
      a.x = seed.x;
      a.y = seed.y;
      a.z = seed.z;
      a.yaw = 1.1;
      a.vx = 3.3;
      a.vy = -0.4;
      a.vz = 0.7;
      const turned = crossGangway(a, consist);
      if (a.car !== j) {
        bad.push(
          `a rider a hand past carriage ${k}'s open ${end < 0 ? '-X' : '+X'} plane ended on ` +
            `carriage ${a.car} rather than ${j}. That end couples to ${j}: see the flip table.`,
        );
        continue;
      }
      if (!Object.is(a.x, want.x) || !Object.is(a.z, want.z) || !Object.is(a.y, want.y)) {
        bad.push(
          `crossGangway put a rider at (${a.x}, ${a.y}, ${a.z}) in carriage ${j} where ` +
            `reframeAcross says (${want.x}, ${want.y}, ${want.z}). The two must be the same ` +
            `arithmetic or the reconciler and the walk disagree about which carriage anybody is in.`,
        );
      }
      // The velocity is a free vector and turns with the frame; the yaw is the
      // half turn, and only across the one reversed coupling.
      const turn = carSign(consist, j) * s;
      if (!Object.is(a.vx, turn * 3.3) || !Object.is(a.vz, turn * 0.7) || !Object.is(a.vy, -0.4)) {
        bad.push(
          `crossing carriage ${k}'s ${end < 0 ? '-X' : '+X'} gangway left the velocity at ` +
            `(${a.vx}, ${a.vy}, ${a.vz}) where the frame turned by ${turn}. A rider punched down ` +
            `the aisle keeps going down the aisle through a gangway.`,
        );
      }
      if (turn > 0 && (turned !== 0 || a.yaw !== 1.1)) {
        bad.push(
          `crossing between two carriages coupled the same way round turned the rider ${turned} rad`,
        );
      }
      if (turn < 0 && Math.abs(Math.abs(turned) - Math.PI) > 1e-12) {
        bad.push(
          `crossing the reversed coupling between carriages ${k} and ${j} turned the rider ` +
            `${turned} rad rather than half a turn. \`main.ts\` adds this to the mouse ` +
            `accumulator, so a wrong answer here is a rider who walks through the middle of a ` +
            `Metro and comes out facing backwards.`,
        );
      }
    }
  }

  // --- 4. A rider walks the whole train, at a stand and at 30 m/s.
  //
  // The acceptance in one loop, and every clause of the request is in it: the
  // carriage index steps by exactly one and never leaves the consist, the arc
  // length along the train never goes backwards, the floor under the body never
  // steps, the walk reaches the far cab -- and **the two speeds produce the same
  // trajectory to the bit**, which is the whole architectural claim.
  {
    const { bake, dir } = gangwayStubBake();
    const HEAD = 800;
    const SPEED = 30;
    const DT = 1 / 60;
    const STEP = 4.4 * DT;
    const feetY = 1.23;
    const frame = createCarFrame();
    const world: Vec3Out = { x: 0, y: 0, z: 0 };
    const back: Vec3Out = { x: 0, y: 0, z: 0 };
    const move: CarriageMove = { x: 0, z: 0, hit: false };
    /** One run. `speed` is what the train is doing; the walk is identical. */
    const run = (speed: number): Array<readonly [number, number, number, number]> => {
      const a = createAboardSlot();
      a.line = 0;
      a.car = n - 1;
      a.x = 8.5;
      a.y = feetY + RIDER_EYE_HEIGHT;
      a.z = 0;
      let step = -STEP;
      let lastArc = -Infinity;
      let lastCar = a.car;
      const trail: Array<readonly [number, number, number, number]> = [];
      for (let i = 0; i < 3000; i++) {
        const head = HEAD + speed * i * DT;
        step = walkTick(a, consist, step, feetY, move);
        trail.push([a.car, a.x, a.z, a.yaw]);
        if (a.car < 0 || a.car >= n) {
          bad.push(`the walk left the consist: carriage ${a.car} of ${n} at ${speed} m/s`);
          break;
        }
        if (Math.abs(a.car - lastCar) > 1) {
          bad.push(
            `the walk went from carriage ${lastCar} to ${a.car} in one tick at ${speed} m/s. A ` +
              `rider crosses one coupling at a time or they have been teleported.`,
          );
          break;
        }
        lastCar = a.car;
        // Against a **fixed** head, so this is where the rider is along their own
        // train rather than where the train is along the railway. The second
        // would climb at 30 m/s and would say nothing about the walk.
        const arc = riderArc(consist, a, HEAD);
        if (arc < lastArc - 1e-9) {
          bad.push(
            `the walk went backwards along the train at ${speed} m/s: ${arc.toFixed(3)} m after ` +
              `${lastArc.toFixed(3)} m, on carriage ${a.car}. The carriage index and the position ` +
              `along the train have to move together or a crossing is a jump.`,
          );
          break;
        }
        lastArc = arc;
        const it = interiorOfCar(consist, a.car);
        if (it === null || carriageFloor(it, a.x, a.z, feetY) !== feetY) {
          bad.push(`the floor under the walk is not ${feetY} m on carriage ${a.car}`);
          break;
        }
        // And the composition, under motion: pull the world position back through
        // the very frame that made it. Exact, because the basis is orthonormal.
        const centre = consistOffset(head, a.car, n, consist.pitch);
        carFrameAt(bake, dir, centre, consist.cars[a.car].flip, frame);
        localToWorld(frame, a.x, a.y, a.z, world);
        worldToLocal(frame, world.x, world.y, world.z, back);
        if (Math.abs(back.x - a.x) > 1e-9 || Math.abs(back.z - a.z) > 1e-9) {
          bad.push(
            `a rider at ${speed} m/s composed to world and back came out ` +
              `${(back.x - a.x).toFixed(6)} m along and ${(back.z - a.z).toFixed(6)} m across from ` +
              `where they were. The carriage frame is orthonormal and its inverse is its ` +
              `transpose; anything here is a frame that is not.`,
          );
          break;
        }
      }
      return trail;
    };
    const still = run(0);
    const fast = run(SPEED);
    const walked = still.length > 0 ? still[still.length - 1][0] : -1;
    if (walked !== 0) {
      bad.push(
        `a rider who walked ${still.length} ticks from the back of a Metro ended on carriage ` +
          `${walked} rather than 0. The whole point of an open gangway is that the train is one ` +
          `room; a walk that stops in the middle of it is a coupling that did not open.`,
      );
    }
    if (still.length !== fast.length) {
      bad.push(
        `the same walk took ${still.length} ticks at a stand and ${fast.length} at ${SPEED} m/s`,
      );
    } else {
      let differed = -1;
      for (let i = 0; i < still.length && differed < 0; i++) {
        for (let f = 0; f < 4; f++) if (!Object.is(still[i][f], fast[i][f])) differed = i;
      }
      if (differed >= 0) {
        bad.push(
          `the walk at ${SPEED} m/s parted company with the walk at a stand on tick ${differed}: ` +
            `carriage ${fast[differed][0]} at x ${fast[differed][1]} against carriage ` +
            `${still[differed][0]} at x ${still[differed][1]}. A carriage frame is a stationary ` +
            `room -- if the train's own speed can reach this arithmetic then riding is back to ` +
            `being a velocity two ends have to agree about, which is the bug the whole file is ` +
            `shaped to avoid.`,
        );
      }
    }
  }

  // --- 5. THE CAMERA DROP, AND EVERY PLACE IT MUST NOT HAVE REACHED.
  //
  //   > *"make the camera slightly lower when on the train"*
  //
  // A view term added to a file whose other numbers are all simulation, which is
  // the whole risk in it: the cheapest way to lower a rider's view is to lower
  // `RIDER_EYE_HEIGHT`, and that renders perfectly while moving every rider's
  // *body* down 12 cm on both ends, changing what the wire carries and eating an
  // eighth of the gangway's headroom. So the constant is pinned, the drop is
  // bounded, the rule is asserted to be conditional, and the clearance test is
  // driven at the boundary to prove the 12 cm did not arrive there.
  {
    // (a) The eye itself has not moved. A literal rather than a derivation,
    // because the entire point is that this number is the one `verifyRiding`
    // compares against `controller.EYE_HEIGHT` -- a drift here is a drift in the
    // simulation, and the pin is what makes "the view moved and nothing else did"
    // a checkable sentence.
    if (RIDER_EYE_HEIGHT !== 1.68) {
      bad.push(
        `RIDER_EYE_HEIGHT is ${RIDER_EYE_HEIGHT} m and must be 1.68. The train's lower view is ` +
          `RIDER_VIEW_DROP_M, applied to the camera only; changing the eye instead moves every ` +
          `rider's body, the wire's local position and the gangway clearance with it.`,
      );
    }
    // (b) The drop is a posture note and not a change of stature. Under 8 cm
    // nobody can tell it is there, which makes it a term that costs a line and
    // buys nothing; over 20 cm the player is looking at window sills from
    // underneath while walking at full speed, which reads as a bug.
    if (!(RIDER_VIEW_DROP_M >= 0.08 && RIDER_VIEW_DROP_M <= 0.2)) {
      bad.push(
        `RIDER_VIEW_DROP_M is ${RIDER_VIEW_DROP_M} m. Outside 0.08..0.20 it is either invisible or ` +
          `it reads as the player having shrunk rather than as a braced view.`,
      );
    }
    // (c) The rule is conditional, exact, and only ever downward.
    const eye = 1.23 + RIDER_EYE_HEIGHT;
    if (riderViewEye(eye, false) !== eye) {
      bad.push(
        `riderViewEye moved a walker's camera to ${riderViewEye(eye, false)} m from ${eye}. On foot ` +
          `it has to be the identity, or every player in Sydney is 12 cm shorter than the server ` +
          `has them.`,
      );
    }
    if (Math.abs(eye - riderViewEye(eye, true) - RIDER_VIEW_DROP_M) > 1e-12) {
      bad.push(
        `riderViewEye dropped a rider's camera by ${(eye - riderViewEye(eye, true)).toFixed(4)} m ` +
          `rather than by RIDER_VIEW_DROP_M ${RIDER_VIEW_DROP_M}.`,
      );
    }
    // (d) And the view still clears the floor by a person's worth of height. The
    // failure this catches is a drop that grew until the camera was inside the
    // vestibule floor, which draws as the carriage disappearing.
    const mid = interiorFor(`${METROPOLIS}:mid`);
    if (mid !== null) {
      const view = riderViewEye(mid.vestibuleY + RIDER_EYE_HEIGHT, true) - mid.vestibuleY;
      if (view < 1.2) {
        bad.push(
          `a rider's camera sits ${view.toFixed(2)} m over the vestibule floor. Under about 1.2 m ` +
            `the view is at a child's height in a room built for the 1.68 m eye beside it.`,
        );
      }
    }
    // (e) **The gangway header is still cleared by the eye and not by the
    // camera**, and the clearance is *measured* rather than compared against the
    // constant it is meant to be. That distinction is the whole test. Probing two
    // heights either side of `floor + GANGWAY_HEIGHT_M - RIDER_EYE_HEIGHT` proves
    // nothing, because a `gangwayAdmits` that had quietly picked up the 12 cm
    // would move the boundary and both probes with it and pass. So the boundary is
    // *found* -- swept in millimetres until the aperture shuts -- and the height
    // it implies is compared with the eye. A leaked drop shows up here as a
    // gangway that admits somebody 12 cm too tall, which draws as a passenger
    // walking through a bulkhead's worth of steel with their head inside it.
    if (mid !== null && mid.gangway !== null) {
      const floor = mid.vestibuleY;
      let tallest = -Infinity;
      for (let mm = 0; mm <= 3000; mm++) {
        const probe = floor + PLATFORM_STEP_M + mm / 1000;
        if (!gangwayAdmits(mid, 1, 0, probe, RIDER_RADIUS)) break;
        tallest = mm / 1000;
      }
      if (tallest === -Infinity) {
        bad.push(
          `a rider standing flat on the vestibule floor was refused the gangway outright. The ` +
            `header is ${GANGWAY_HEIGHT_M} m over a ${RIDER_EYE_HEIGHT} m eye; nobody can cross.`,
        );
      } else {
        // What the aperture behaved as though a rider measures: the tallest head
        // it let through, over the floor.
        const implied = GANGWAY_HEIGHT_M - tallest;
        if (Math.abs(implied - RIDER_EYE_HEIGHT) > 0.002) {
          bad.push(
            `the gangway admitted a rider whose head is ${implied.toFixed(3)} m over the floor, ` +
              `against the ${RIDER_EYE_HEIGHT} m eye it is written for -- a difference of ` +
              `${((implied - RIDER_EYE_HEIGHT) * 100).toFixed(1)} cm, and RIDER_VIEW_DROP_M is ` +
              `${(RIDER_VIEW_DROP_M * 100).toFixed(0)}. The camera's drop is a view term and must ` +
              `never reach the clearance test: the view is lower, the head is not.`,
          );
        }
      }
    }
  }

  return bad;
}
