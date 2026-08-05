/**
 * The AFL football: a thrown object with a real arc, and what it does when it
 * lands on somebody.
 *
 * ---------------------------------------------------------------------------
 * This replaced a hitscan raygun, and the replacement is the whole design.
 *
 * The ranged weapon in this game was a beam that arrived the instant it was
 * fired. It is now a ball that takes most of a second to cross a street, falls
 * 22.5 m/s^2 while it does, and bounces off the pavement like the oval thing it
 * is. Spec 2 says *"it's a punching game for friends"* and spec 12 puts guns out
 * of scope by name; a footy is the version of "ranged" that both of those can
 * live with, and it is the one the user asked for -- *"fighting is via cricket
 * bats (melee) and afl balls for ranged"*.
 *
 * The numbers below are all shaped by one constraint, and it is the same one the
 * beam was written against before it: **the melee still decides fights.**
 *
 *   - **One pip**, the bat's damage exactly, so it cannot out-damage the bat.
 *   - **55% of the bat's knockback**, so it pushes but does not throw. Spec
 *     8.2's 6-8 m is the spatial constant a player learns, and a ranged weapon
 *     that also threw people that far would make the bat redundant at every
 *     distance.
 *   - **Three balls and one back every four seconds** (`combat.BALL_CHARGES`),
 *     on their own bar, so throwing does not cost you the swing you need when
 *     somebody closes.
 *   - **Travel time and an arc.** This is the real balance and it is the one the
 *     beam did not have. A ball takes 0.43 s to reach 12 m and drops 2.1 m doing
 *     it; a target who changes direction inside that is missed, and anything
 *     past about 17 m has to be *lofted* rather than aimed at. A beam asked for
 *     none of that, which is why it needed three numbers of shaping and this
 *     needed one mechanic. See `LAUNCH_RISE`, where the envelope is measured.
 *
 * ---------------------------------------------------------------------------
 * **This file imports nothing from three, not even `Vector3`.**
 *
 * `game/combat.ts` allows itself that one import and states the precedent; this
 * goes one better and is a `world/wading.ts`-class module -- plain numbers on a
 * plain record, arithmetic, and two type-only imports. That is not purity for
 * its own sake. A ball's position is stepped 60 times a second per ball on the
 * server, quantised into every snapshot, and asserted **bit-identical** across
 * two module instances by `server/integration-check.ts`; the fewer objects with
 * methods stand between the arithmetic and the wire, the fewer places that claim
 * can quietly stop being true. `applyFootyHit` therefore takes its `HitReport`
 * rather than allocating one, because allocating one would mean constructing a
 * `Vector3`.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM, which is the property everything here is arranged around.
 *
 * The server owns every ball. The client simulates its *own* throws locally so
 * the ball leaves the hand on the frame the button goes down (see `net/client.ts`
 * for the handoff, or rather for the deliberate absence of one), and the two
 * simulations have to agree or a player would watch their own ball land in a
 * different place from the one the server scored. Three rules make that hold:
 *
 *   1. **No transcendental functions in the step.** `Math.sin`, `Math.cos`,
 *      `Math.pow` and -- the one that catches people -- `Math.hypot` are all
 *      *implementation-defined* in ECMAScript: an engine may return any value
 *      within an implementation's own precision, and the browser's V8 and the
 *      server's JavaScriptCore do differ in the last place. `Math.sqrt` is
 *      specified to IEEE-754 exactness and is used instead, everywhere.
 *   2. **The bounce randomness is an integer hash, not a PRNG.** See
 *      `bounceHash`: `Math.imul`, `^` and `>>>` are exact integer operations on
 *      every engine, so the deflection a ball takes on its second bounce is a
 *      pure function of `(id, bounce)` and is the same number in both processes
 *      with no state to synchronise and nothing on the wire.
 *   3. **The rotation the deflection applies has no `sin` in it.** The half-angle
 *      rational parametrisation of the unit circle -- `cos = (1-t^2)/(1+t^2)`,
 *      `sin = 2t/(1+t^2)` -- is four multiplies and a divide, is exact, and
 *      covers every angle this needs. See `deflect`.
 *
 * The one place a transcendental survives is `spawnFooty`, which needs the
 * thrower's view direction and therefore a sine and a cosine of their yaw. That
 * is evaluated **once per throw** on each end from the same quantised yaw, so
 * the worst it can do is put two balls a few nanometres apart at t = 0; every
 * step after it is exact. It is not in the step and it is not in the hash.
 *
 * ---------------------------------------------------------------------------
 * Why the oval bounce is a hash and not a physical model.
 *
 * A real prolate spheroid bounces unpredictably because its contact normal
 * depends on its orientation, and its orientation depends on its angular
 * velocity, which depends on the last bounce. Modelling that means carrying an
 * inertia tensor and a quaternion through the wire and getting both ends to
 * agree on them to the bit -- for a behaviour whose entire gameplay value is
 * *"you cannot predict where it goes"*.
 *
 * So the behaviour is produced directly: each bounce deflects the ball by up to
 * 31 degrees in plan and varies its restitution between 0.41 and 0.69, both read
 * out of a hash of the ball's id and which bounce this is. It is unpredictable
 * to a player, identical on both ends, costs nothing per tick, and adds no
 * bytes to the snapshot. The renderer's tumble is derived from the velocity and
 * is purely cosmetic -- see `world/footyball.ts` -- so the picture and the
 * simulation cannot drift apart, because the picture is a function of the
 * simulation.
 *
 * ---------------------------------------------------------------------------
 * The order of the three tests in a step, which is a gameplay decision.
 *
 * A step resolves **players, then water, then the ground and the buildings**,
 * and the first of those is the one worth stating. A ball travelling at a player
 * standing against a wall meets the player and the wall in the same 8 ms tick,
 * and testing the world first would have the ball stop on the terrace behind
 * them. Bodies are what a thrown ball is *for*, so a body anywhere along the
 * step's segment wins outright.
 *
 * Water is second because a ball in the harbour is gone -- see `stepFooty` --
 * and a splash must not be preceded by a bounce off the seabed.
 */

import { EYE_HEIGHT, GRAVITY } from '../player/controller.ts';
import {
  CAPSULE_HEIGHT,
  CAPSULE_RADIUS,
  KNOCKBACK_HORIZONTAL,
  KNOCKBACK_VERTICAL,
  KO_SECONDS,
  feetY,
  isTargetable,
  segmentDistance,
  type CombatWorld,
  type CombatantState,
  type HitReport,
} from './combat.ts';
import { damageScale } from './powerups.ts';
import { NO_WATER } from '../world/wading.ts';
import type { SpatialHash } from './spatialhash.ts';

/**
 * Candidates for one ball's sweep. See `stepFooty`.
 *
 * Module-level and shared, on `game/powerups.ts`'s `pickupScratch` terms and
 * for the same reason: refilled and fully consumed inside one synchronous
 * block, never retained past it.
 */
const sweepScratch: CombatantState[] = [];

// --- The ball ------------------------------------------------------------------

/**
 * How fast it leaves the hand, m/s.
 *
 * 28 m/s is a hard drop punt and it is chosen for the *flight time* rather than
 * for realism: it puts 12 m at 0.43 s, which is long enough that a sprinting
 * target who changes direction is missed and short enough that a stationary one
 * is a fair shot.
 *
 * Faster than about 32 and the arc flattens into the beam this replaced -- the
 * whole balance argument in the header is that this weapon has a *trajectory*.
 * Slower than about 24 and the drop under `controller.GRAVITY`'s 22.5 m/s^2
 * takes the direct-fire envelope inside 10 m, at which point the bat already
 * covers everything the ball could.
 */
export const LAUNCH_SPEED = 28;

/**
 * How much the throw is lofted above where the player is looking.
 *
 * Added to the view direction's vertical component before the whole thing is
 * renormalised, so it is a *bias* rather than a fixed angle: a player looking
 * level throws 5.7 degrees up, and a player already aiming at the sky is not
 * bent further.
 *
 * It exists because gravity here is 22.5 m/s^2 rather than 9.8 --
 * `controller.GRAVITY` is exaggerated to make the jump feel snappy, and every
 * thrown object in the game inherits it. Over the 0.54 s a ball takes to cross
 * 15 m that is 3.2 m of drop, so a throw released dead flat from 0.2 m under the
 * eye is at ankle height by the time it gets anywhere.
 *
 * **The value was measured rather than chosen**, and the measurement is the one
 * that matters for this weapon: at what ranges does a throw aimed *straight at
 * somebody* actually connect? Swept against a standing capsule, one throw per
 * metre, looking level:
 *
 *     rise 0.06   connects  3-15 m      then a gap
 *     rise 0.10   connects  3-14 m      contiguous, and 15-17 on the bounce
 *     rise 0.14   connects  7-19 m      nothing inside 7 m
 *     rise 0.18   connects 11-20 m      nothing inside 11 m
 *     rise 0.22   connects 13-22 m      nothing inside 13 m
 *
 * Everything above about 0.12 opens a **dead zone in front of the thrower**: the
 * ball sails over the head of anybody closer than the gap, which is exactly the
 * range a brawl in a terrace street happens at, and it reads as the weapon being
 * broken rather than as an arc. 0.10 is the largest loft with no dead zone at
 * all.
 *
 * Between 15 and 17 m the ball is at ankle height and whether it connects
 * depends on which way that ball's first bounce kicked -- see `bounceHash`. That
 * is not a flaw in the number, it is the weapon: at the edge of its flat range a
 * footy skips, and whether it skips into you is genuinely not knowable. The
 * check in `verifyFooty` therefore asserts the contiguous 3-14 m and leaves the
 * skip band alone.
 *
 * Past that the player has to **aim up**, and that is the skill gate the whole
 * design rests on rather than an accident of the number: pitching 10 degrees
 * above the horizon moves the envelope to 17-24 m and carries the first bounce
 * to 21 m, with the bounces taking it past 30.
 */
export const LAUNCH_RISE = 0.10;

/**
 * The collision sphere, metres.
 *
 * A real AFL ball is 0.28 m on the long axis and 0.174 m across the girth, so it
 * is neither a sphere nor worth modelling as anything else: an ellipsoid hit
 * test needs an orientation, the orientation is cosmetic here (see the header),
 * and a ball that hit differently depending on a cosmetic value would be the one
 * unfair thing in the game. 0.105 m is the mean of the two semi-axes.
 */
export const BALL_RADIUS = 0.105;

/**
 * Air drag, as a fraction of speed shed per second.
 *
 * Linear rather than quadratic, and both the form and the value are chosen for
 * what they do to the *arc* rather than from a drag coefficient. A real footy at
 * 26 m/s sheds about 12% of its speed a second; 9% here reads the same and keeps
 * the arithmetic to one multiply. What it actually buys is that a long throw
 * falls slightly short of the parabola a player extrapolates, which is what
 * makes distance a thing that has to be learnt rather than computed.
 */
const DRAG = 0.09;

/**
 * How much of the impact speed survives a bounce, before the hash varies it.
 *
 * 0.55 is a leather ball on asphalt and it is the number the whole bounce reads
 * from: much over 0.7 and a ball crossing a street arrives at the far footpath
 * still waist-high, which makes the weapon work by accident at ranges nobody
 * aimed at; much under 0.4 and the first bounce is the last thing that happens
 * and the ball may as well have been deleted on contact.
 */
const RESTITUTION = 0.55;

/**
 * How far the restitution is allowed to wander per bounce, either way.
 *
 * 0.14 puts it in [0.41, 0.69]. This is half of what makes an oval ball an oval
 * ball -- one bounce sits up and the next shoots through -- and it is free,
 * because it is read out of the same hash the deflection is.
 */
const RESTITUTION_SPREAD = 0.14;

/**
 * Horizontal speed retained through a bounce off a level surface.
 *
 * Lower than the restitution on purpose: a ball that keeps all of its forward
 * speed through three bounces skitters 40 m down the road and is still live at
 * the far end, which is both wrong and a hit test running over half the suburb.
 */
const BOUNCE_FRICTION = 0.72;

/**
 * `tan` of half the largest plan deflection a bounce may add.
 *
 * 0.282 is `tan(0.275)`, so the deflection runs to +/- 0.55 rad -- 31 degrees.
 * Stated as the tangent of the half-angle rather than as the angle because that
 * is the number `deflect` actually uses, and converting an angle here would put
 * a `Math.tan` on the module's evaluation path for a value that is a constant.
 * See the header for why there is no trigonometry in the rotation itself.
 *
 * 31 degrees is a lot, and it is meant to be: the second bounce of a footy is
 * genuinely anybody's guess, and a deflection small enough to be predictable
 * would be a deflection not worth having.
 */
const DEFLECT_TAN_HALF = 0.282;

/** After this many bounces the ball is dead. Three is a bounce, a skip and a settle. */
export const MAX_BOUNCES = 3;

/** Seconds a ball may be in the air. A 5 s ball has travelled 100 m or stopped. */
export const LIFETIME = 5.0;

/** One pip, before spec 8.3's multipliers. The bat's damage exactly. See the header. */
export const BALL_DAMAGE = 1.0;

/**
 * The ball's knockback, as a fraction of the bat's.
 *
 * A scale on `combat`'s numbers rather than two literals of its own, so the
 * relationship -- "a footy pushes a bit over half as hard as a bat" -- survives
 * anyone retuning the bat. A stated pair here would be two numbers that silently
 * stopped being a fraction of anything.
 *
 * 0.55 rather than the beam's 0.5, and the difference is the arc: a hitscan that
 * cannot be dodged should push less than a thrown object that can be.
 */
export const BALL_KNOCKBACK_SCALE = 0.55;

/**
 * How long a pegged victim's clock stops, seconds.
 *
 * `combat.HITSTOP`'s value, restated rather than imported, because the two are
 * the same number for different reasons and should be free to stop being: the
 * bat's freezes *both* parties because a blade landing is a thing that happens
 * to your arms, and this freezes the victim alone. The thrower let go half a
 * second ago and is not touching anything.
 */
const VICTIM_HITSTOP = 0.09;

/**
 * Where the ball leaves the hand, relative to the thrower's **eye**, in their
 * own frame: right, down, forward. Metres.
 *
 * The ball is released from the right hand at about head height, and the eye is
 * between the two. Applied to the spawn *position* only -- the launch
 * **direction** is the view direction from the eye, which is what the player
 * aims with, and the two would otherwise disagree about whether a throw down a
 * narrow gap clears the corner. The same split the beam weapon made between its
 * muzzle and the eye it was aimed from, for the same reason.
 *
 * It is deliberately small. A release point far from the eye means a ball that
 * leaves the frame sideways on the throw, and at this game's 72-degree field a
 * 0.3 m offset is already a fifth of the way to the edge.
 */
export const RELEASE_RIGHT = 0.26;
export const RELEASE_DOWN = 0.2;
export const RELEASE_FORWARD = 0.3;

/**
 * One ball in the air.
 *
 * Plain numbers rather than vectors, for the reason the header gives, and a
 * `alive` flag rather than removal from an array so the records can be pooled --
 * `FootyField` reuses them and a busy fight allocates nothing.
 */
export interface Footy {
  /** Server-assigned, wrapping at 256 so it fits the snapshot's byte. Never 0. */
  id: number;
  /** The combatant who threw it. Never a valid target for it. */
  thrower: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Seconds since release. Drives the lifetime and the renderer's tumble. */
  age: number;
  /** How many bounces have happened. Dead at `MAX_BOUNCES`. */
  bounces: number;
  alive: boolean;
}

/** What one ball did in one step. Presentation reads this; nothing here does. */
export interface FootyStep {
  /** It bounced off the ground, a roof or a wall this step. The caller plays the thud. */
  bounced: boolean;
  /** It went into the water and is gone. */
  splashed: boolean;
  /** Its lifetime or its bounce budget ran out. */
  expired: boolean;
  /** It hit somebody. The caller applies the consequence -- see `applyFootyHit`. */
  victim: CombatantState | null;
}

export function createFooty(): Footy {
  return { id: 0, thrower: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, bounces: 0, alive: false };
}

function clearStep(out: FootyStep): FootyStep {
  out.bounced = false;
  out.splashed = false;
  out.expired = false;
  out.victim = null;
  return out;
}

export function createFootyStep(): FootyStep {
  return { bounced: false, splashed: false, expired: false, victim: null };
}

// --- The throw -----------------------------------------------------------------

/**
 * Put a ball in the air from a combatant's hand. Pure; mutates only `out`.
 *
 * The direction is the thrower's view with `LAUNCH_RISE` added to its vertical
 * component and the whole thing renormalised, which is what makes the loft a
 * bias rather than a fixed elevation. The renormalisation uses `Math.sqrt` --
 * see the header on why it is not `Math.hypot`.
 */
export function spawnFooty(thrower: CombatantState, id: number, out: Footy): Footy {
  const body = thrower.body;
  const cp = Math.cos(body.pitch);
  const sinY = Math.sin(body.yaw);
  const cosY = Math.cos(body.yaw);

  // The view direction, as `combat.viewDirection` builds it. Written out rather
  // than called because that function wants a `Vector3` to write into and this
  // module does not have one -- see the header.
  let dx = -sinY * cp;
  let dy = Math.sin(body.pitch) + LAUNCH_RISE;
  let dz = -cosY * cp;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  // A view direction is a unit vector plus a positive loft, so this cannot be
  // zero; the guard is here because the alternative to a guard is a NaN ball,
  // which quantises to the edge of the world and never dies.
  const inv = len > 1e-9 ? 1 / len : 0;
  dx *= inv;
  dy *= inv;
  dz *= inv;

  out.id = id;
  out.thrower = thrower.id;
  // The release point, off the **yaw** basis rather than the pitched view, so
  // the ball does not swing away from the body when the thrower looks up.
  out.x = body.position.x + cosY * RELEASE_RIGHT - sinY * RELEASE_FORWARD;
  out.y = body.position.y - RELEASE_DOWN;
  out.z = body.position.z - sinY * RELEASE_RIGHT - cosY * RELEASE_FORWARD;
  out.vx = dx * LAUNCH_SPEED;
  out.vy = dy * LAUNCH_SPEED;
  out.vz = dz * LAUNCH_SPEED;
  out.age = 0;
  out.bounces = 0;
  out.alive = true;
  return out;
}

// --- The bounce hash -----------------------------------------------------------

/**
 * A number in [0, 1) from a ball's id and which bounce this is.
 *
 * Every operation is exact-integer on every JavaScript engine -- `Math.imul` is
 * specified as a 32-bit multiply, and `^`, `>>>` and `+` on int32 have no
 * implementation freedom at all. That is the whole point of it: the client and
 * the server compute the same deflection with nothing exchanged and no seed to
 * get out of step, which is what lets the snapshot carry no randomness.
 *
 * The mixing is a Murmur-style finaliser over the two inputs. It has to be a
 * real hash rather than something like `(id * 7 + bounce) % 13 / 13`: adjacent
 * ball ids are handed out consecutively, so a weak mix would make two balls
 * thrown one after another bounce the same way, and "the second one went exactly
 * where the first one did" is precisely the property this exists to prevent.
 *
 * `channel` picks which quantity is being asked for, so one call site can draw
 * an angle and a restitution for the same bounce without them being correlated.
 */
export function bounceHash(id: number, bounce: number, channel: number): number {
  let h = Math.imul(id | 0, 0x9e3779b1) ^ Math.imul(bounce | 0, 0x85ebca6b) ^ Math.imul(channel | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2f);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Rotate a plan velocity by an angle drawn from the hash, with no trigonometry.
 *
 * The half-angle rational parametrisation: for `t = tan(theta/2)`,
 * `cos theta = (1 - t^2) / (1 + t^2)` and `sin theta = 2t / (1 + t^2)`, exactly.
 * So drawing `t` uniformly out of the hash and substituting gives a genuine
 * rotation with four multiplies, a divide and no call whose precision an engine
 * is free to choose. See the file header for why that matters more than it
 * looks like it should.
 *
 * The distribution of the resulting angle is very slightly bunched toward zero
 * relative to a uniform angle -- `atan` is sublinear -- and that is if anything
 * the better shape: most bounces deflect a little and a few deflect a lot.
 *
 * Writes into `ball.vx`/`ball.vz`.
 */
function deflect(ball: Footy, channel: number): void {
  const t = (bounceHash(ball.id, ball.bounces, channel) * 2 - 1) * DEFLECT_TAN_HALF;
  const d = 1 + t * t;
  const c = (1 - t * t) / d;
  const s = (2 * t) / d;
  const vx = ball.vx;
  const vz = ball.vz;
  ball.vx = vx * c - vz * s;
  ball.vz = vx * s + vz * c;
}

/** The restitution this bounce gets, varied around `RESTITUTION` by the hash. */
function restitutionFor(ball: Footy): number {
  return RESTITUTION + (bounceHash(ball.id, ball.bounces, 1) * 2 - 1) * RESTITUTION_SPREAD;
}

// --- The step ------------------------------------------------------------------

/**
 * Advance one ball by one fixed step.
 *
 * `dt` must be the fixed timestep, for `controller.step`'s reason and one more:
 * a variable step would put the drag multiply and the gravity integral on a
 * different footing on the two ends, and the whole claim of this module is that
 * they are on the same one.
 *
 * `targets` is the authoritative set on `combat.hitTest`'s terms exactly --
 * except that it is **not rewound**, and that is a decision rather than an
 * oversight. A rewound target list exists to answer "what was the attacker
 * looking at when they clicked", which is the right question for an instant
 * weapon and the wrong one for a ball: the ball is in the world, the server
 * knows where both it and every player is at the tick it tests them, and both
 * ends are drawing that same ball from the same snapshot stream. Rewinding it
 * would mean a ball that visibly passed a player 100 ms ago knocking them over
 * now. See `server/sim.ts`, which passes the live list for exactly this reason.
 */
export function stepFooty(
  ball: Footy,
  dt: number,
  world: CombatWorld | null,
  targets: readonly CombatantState[],
  out: FootyStep,
  index: SpatialHash<CombatantState> | null = null,
): FootyStep {
  clearStep(out);
  if (!ball.alive) return out;

  ball.age += dt;
  if (ball.age >= LIFETIME) {
    ball.alive = false;
    out.expired = true;
    return out;
  }

  // --- Integrate. Gravity is the controller's own, so a ball and a knocked-out
  // body fall at the same rate -- which is what makes the arc a thing a player
  // can read off the game they are already playing.
  ball.vy += GRAVITY * dt;
  const damp = 1 - DRAG * dt;
  ball.vx *= damp;
  ball.vy *= damp;
  ball.vz *= damp;

  const fromX = ball.x;
  const fromY = ball.y;
  const fromZ = ball.z;
  let toX = fromX + ball.vx * dt;
  let toY = fromY + ball.vy * dt;
  let toZ = fromZ + ball.vz * dt;

  // --- Bodies first. See the header: a player standing against a wall must
  // catch the ball their own back is stopping.
  //
  // The whole step is swept rather than the end point tested, because at 26 m/s
  // a ball moves 0.43 m in a tick and a 0.34 m capsule fits between two
  // consecutive positions -- a point test would let a ball pass clean through a
  // player about a third of the time, which is the exact bug that reads as
  // "hit detection is broken" and has no frame that says so.
  {
    const reach = BALL_RADIUS + CAPSULE_RADIUS;
    let best: CombatantState | null = null;
    let bestAlong = Infinity;
    // Everybody, or -- when the caller has built one -- only the bodies whose
    // cell touches this tick's flight segment.
    //
    // PERFORMANCE.md phase 1. A capsule is vertical, so `segmentDistance` can
    // only come in under `reach` for a body whose *plan* position is within
    // `reach` of the flight's plan projection: a disc centred on the segment's
    // midpoint with radius `half the segment + reach` contains every one of
    // them and the exact test below still decides. A superset in ascending
    // combatant order, which is the order `targets` is in, so the strict `<`
    // on `bestAlong` breaks its ties exactly as it did -- see
    // `game/spatialhash.ts` on why that matters.
    let sweep = targets;
    if (index !== null) {
      const mx = (fromX + toX) * 0.5;
      const mz = (fromZ + toZ) * 0.5;
      const hx = toX - mx;
      const hz = toZ - mz;
      sweep = index.collectWithin(mx, mz, Math.sqrt(hx * hx + hz * hz) + reach, sweepScratch);
    }
    for (const t of sweep) {
      if (t.id === ball.thrower) continue;
      if (!isTargetable(t)) continue;
      const foot = feetY(t);
      const d = segmentDistance(
        fromX, fromY, fromZ,
        toX, toY, toZ,
        t.body.position.x, foot + CAPSULE_RADIUS, t.body.position.z,
        t.body.position.x, foot + CAPSULE_HEIGHT - CAPSULE_RADIUS, t.body.position.z,
      );
      if (d > reach) continue;
      // Nearest along the flight wins, so a ball through a crowd hits the front
      // one. Measured from the step's start rather than by capsule distance:
      // two players either side of the line resolve to the one the ball reaches
      // first, which is the only answer that does not depend on aim.
      const along =
        (t.body.position.x - fromX) * ball.vx +
        (t.body.position.z - fromZ) * ball.vz;
      if (along >= bestAlong) continue;
      best = t;
      bestAlong = along;
    }
    if (best !== null) {
      // The ball stops *at the body* rather than at the end of the step, so the
      // impact is drawn where it happened. It dies either way.
      ball.x = best.body.position.x;
      ball.y = feetY(best) + CAPSULE_HEIGHT * 0.62;
      ball.z = best.body.position.z;
      ball.alive = false;
      out.victim = best;
      return out;
    }
  }

  // --- Water. A footy in the harbour is gone.
  //
  // The alternative -- float it -- was considered and is worse than it sounds:
  // a floating ball needs a buoyancy integrator, a drift, and a rule for what
  // happens when somebody wades to it, none of which is a mechanic anybody asked
  // for, and all of which is state on the wire. `world/wading.ts` already
  // supplies the surface to both ends over no bytes at all, so this is one
  // comparison and a splash.
  if (world?.waterSurface) {
    const surface = world.waterSurface(toX, toZ);
    if (Number.isFinite(surface) && toY - BALL_RADIUS <= surface) {
      ball.x = toX;
      ball.y = surface;
      ball.z = toZ;
      ball.alive = false;
      out.splashed = true;
      return out;
    }
  }

  // --- Walls. `CollisionWorld.resolve` is asked to push a circle of the ball's
  // radius out of the city, and the direction it pushes **is** the surface
  // normal -- which is what makes a reflection possible without the prism
  // payload carrying normals or this file knowing what a polygon is.
  //
  // Queried at the ball's own centre height, so a ball sailing over a roof is
  // not stopped by the building under it and one at chest height is.
  if (world?.collision) {
    const r = world.collision.resolve(fromX, fromZ, toX, toZ, BALL_RADIUS, toY);
    if (r.hit) {
      let nx = r.x - toX;
      let nz = r.z - toZ;
      let n = Math.sqrt(nx * nx + nz * nz);
      if (n < 1e-6) {
        // `resolve` refused the move outright -- a corner it could not free the
        // circle from -- and returned the start. The direction of travel
        // reversed is the only normal available and is the right one for a
        // head-on hit, which is the case that produces this.
        nx = fromX - toX;
        nz = fromZ - toZ;
        n = Math.sqrt(nx * nx + nz * nz);
      }
      if (n > 1e-6) {
        nx /= n;
        nz /= n;
        const e = restitutionFor(ball);
        // Reflect the horizontal velocity about the wall normal, then damp it.
        const along = ball.vx * nx + ball.vz * nz;
        ball.vx = (ball.vx - 2 * along * nx) * e;
        ball.vz = (ball.vz - 2 * along * nz) * e;
        // The vertical is only damped: a ball that hit a wall on the way up is
        // still going up, which is what makes a throw into a terrace drop at
        // the wall's foot rather than shoot along it.
        ball.vy *= e;
        deflect(ball, 0);
      }
      ball.bounces++;
      out.bounced = true;
      toX = r.x;
      toZ = r.z;
      if (ball.bounces >= MAX_BOUNCES) {
        ball.x = toX;
        ball.y = toY;
        ball.z = toZ;
        ball.alive = false;
        out.expired = true;
        return out;
      }
    }
  }

  // --- The ground, which includes roofs: `groundHeight` is the same composed
  // query a player's feet are resolved against, so a ball bounces on the
  // warehouse a player can stand on and not through it.
  const surfaceY = world ? world.groundHeight(toX, toZ, toY - BALL_RADIUS) : 0;
  if (Number.isFinite(surfaceY) && toY - BALL_RADIUS <= surfaceY) {
    toY = surfaceY + BALL_RADIUS;
    ball.bounces++;
    out.bounced = true;
    if (ball.bounces >= MAX_BOUNCES) {
      ball.x = toX;
      ball.y = toY;
      ball.z = toZ;
      ball.alive = false;
      out.expired = true;
      return out;
    }
    const e = restitutionFor(ball);
    // `-Math.abs` rather than negation: a ball that arrived at the ground with
    // an upward velocity -- which happens when a wall bounce this same tick has
    // already flipped it -- must not be sent downward by this one.
    ball.vy = Math.abs(ball.vy) * e;
    ball.vx *= BOUNCE_FRICTION;
    ball.vz *= BOUNCE_FRICTION;
    deflect(ball, 0);
  }

  ball.x = toX;
  ball.y = toY;
  ball.z = toZ;
  return out;
}

// --- The consequence -----------------------------------------------------------

/**
 * One pip and a shove along the flight.
 *
 * Deliberately **not** `combat.applyHit`, and the difference is one line of
 * behaviour: a bat throws the victim along the attacker's *flattened* view,
 * because a blade is swung horizontally and spec 8.2's 6-8 m is measured on the
 * ground. A ball has a real trajectory, and one dropping out of the sky onto
 * somebody should push them down into the pavement rather than level along it.
 * So the impulse follows the **ball's own velocity** in three dimensions, with
 * the vertical term capped at the bat's own launch so a ball thrown straight
 * down cannot spike a body into the ground.
 *
 * `out` is required rather than optional. Everything else in this codebase that
 * returns a `HitReport` allocates one when it is not handed one; doing that here
 * would mean constructing a `Vector3`, and this module imports nothing from
 * three -- see the file header. Both call sites have a report to hand anyway.
 */
export function applyFootyHit(
  thrower: CombatantState,
  victim: CombatantState,
  ball: Footy,
  out: HitReport,
): HitReport {
  let ix = ball.vx;
  let iy = ball.vy;
  let iz = ball.vz;
  const plan = Math.sqrt(ix * ix + iz * iz);
  const speed = Math.sqrt(ix * ix + iy * iy + iz * iz);
  // A ball falling dead vertically would push the victim nowhere on the plan,
  // so it falls back to the thrower's heading. `combat.applyHit` makes the same
  // fallback for the same degenerate case.
  if (plan < 1e-4) {
    ix = -Math.sin(thrower.body.yaw);
    iz = -Math.cos(thrower.body.yaw);
  } else {
    ix /= plan;
    iz /= plan;
  }
  // The vertical component as a *fraction of the flight*, so a lobbed ball
  // arriving steeply pushes down and a flat one does not. Normalised by the
  // full speed rather than by the plan, or a near-vertical drop would divide by
  // something near zero and launch the victim at the speed of sound.
  const rise = speed > 1e-4 ? iy / speed : 0;

  // Spec 8.3's multipliers apply, on the beam weapon's own argument: 8.3 says
  // "+40% **punch** damage" and a thrown ball is not a punch, so the literal
  // reading exempts it -- which would make a Flat White strictly better than no
  // powerup at all and give a Training player a reason to switch weapons to
  // dodge their own penalty. One rule for all damage has no such seam.
  victim.health = Math.max(0, victim.health - BALL_DAMAGE * damageScale(thrower));
  // `applyHit`'s femto-pip clamp. It matters here for the same reason: sums
  // like 3 - 1.4 - 1.4 - 0.2 miss zero by a few times 1e-16.
  if (victim.health < 1e-9) victim.health = 0;

  const h = KNOCKBACK_HORIZONTAL * BALL_KNOCKBACK_SCALE;
  victim.body.velocity.set(
    ix * h,
    Math.min(KNOCKBACK_VERTICAL, rise * h + KNOCKBACK_VERTICAL * BALL_KNOCKBACK_SCALE),
    iz * h,
  );
  // The line `combat.applyHit`'s header calls load-bearing: without it the
  // first tick after the hit charges the victim ground friction for a metre of
  // flight they spend in the air.
  victim.body.onGround = false;
  // And off the bike, exactly as `combat.applyHit` does it and for the same
  // reason. Restated rather than shared because this function is deliberately a
  // parallel adjudication of a different weapon -- see the damage note above --
  // and a rider who could be knocked off by a bat but not by a football would be
  // a rule nobody could guess. `game/bikes.BikeField.follow` parks the bike.
  victim.ridingBike = 0;

  const ko = victim.health <= 0;
  if (ko) {
    victim.phase = 'ko';
    victim.koT = 0;
    victim.respawnT = KO_SECONDS;
  } else {
    victim.phase = 'flinch';
    victim.phaseT = 0;
  }

  // Hitstop on the victim only. See `VICTIM_HITSTOP`: the thrower let go half a
  // second ago and freezing their frame now would read as a network stall.
  victim.hitstopT = VICTIM_HITSTOP;

  out.attacker = thrower.id;
  out.victim = victim.id;
  out.ko = ko;
  out.health = victim.health;
  out.point.set(ball.x, ball.y, ball.z);
  return out;
}

// --- The field -----------------------------------------------------------------

/** What one ball did this tick, for a caller that has to make a noise about it. */
export interface FootyEvent {
  ball: Footy;
  kind: 'bounce' | 'splash' | 'expire' | 'hit';
  victim: CombatantState | null;
}

/**
 * Every ball in the air, and the id counter behind them.
 *
 * One of these runs on the server for the whole world, and one runs in the
 * browser holding only the local player's own predicted throws -- or, offline,
 * holding everything, because offline the client *is* the authority. It is the
 * same class either way, which is the property that makes the offline path a
 * real test of the online one rather than a parallel implementation.
 *
 * Records are **pooled**. A dead ball's record is reused by the next throw, so a
 * sixteen-player fight allocates nothing per throw, and `balls` is compacted in
 * place each step rather than filtered into a new array.
 */
export class FootyField {
  /** The live balls. Owned by this object and reused -- copy before holding one. */
  readonly balls: Footy[] = [];
  private readonly pool: Footy[] = [];
  private readonly step_ = createFootyStep();
  /**
   * Wraps at 256 and skips 0, because the id is a byte on the wire and 0 is
   * reserved for "no ball". Wrapping is safe at any realistic rate: a ball lives
   * 5 s and sixteen players cannot throw 256 of them in that time -- the bar is
   * three balls and one back every four seconds, so the ceiling is about 60.
   */
  private nextId = 1;

  /** Put a ball in the air. Returns it, live, already in `balls`. */
  add(thrower: CombatantState): Footy {
    const ball = this.pool.pop() ?? createFooty();
    spawnFooty(thrower, this.nextId, ball);
    this.nextId = this.nextId >= 255 ? 1 : this.nextId + 1;
    this.balls.push(ball);
    return ball;
  }

  /**
   * Advance every ball by one fixed step and report what happened.
   *
   * `out` is cleared and refilled, and is the caller's array so nothing here
   * allocates per tick. The dead are recycled at the end of the pass rather
   * than during it, because splicing an array being iterated is the one way to
   * make a ball skip a tick and nobody would ever see it happen.
   */
  step(
    dt: number,
    world: CombatWorld | null,
    targets: readonly CombatantState[],
    out: FootyEvent[],
    index: SpatialHash<CombatantState> | null = null,
  ): FootyEvent[] {
    out.length = 0;
    const s = this.step_;
    for (const ball of this.balls) {
      stepFooty(ball, dt, world, targets, s, index);
      if (s.victim) out.push({ ball, kind: 'hit', victim: s.victim });
      else if (s.splashed) out.push({ ball, kind: 'splash', victim: null });
      else if (s.expired) out.push({ ball, kind: 'expire', victim: null });
      else if (s.bounced) out.push({ ball, kind: 'bounce', victim: null });
    }
    let live = 0;
    for (const ball of this.balls) {
      if (ball.alive) this.balls[live++] = ball;
      else this.pool.push(ball);
    }
    this.balls.length = live;
    return out;
  }

  /** Drop everything. A respawn, a disconnect, or a check starting over. */
  clear(): void {
    for (const ball of this.balls) {
      ball.alive = false;
      this.pool.push(ball);
    }
    this.balls.length = 0;
  }
}

// --- The self-check ------------------------------------------------------------

const STEP_DT = 1 / 60;

/** A flat, dry, empty world. What most of the cases below fly through. */
const FLAT: CombatWorld = { collision: null, groundHeight: () => 0, waterSurface: () => NO_WATER };

/** What a whole flight did. See `traceFooty`. */
export interface FootyTrace {
  /** Every position the ball visited, flattened x, y, z. The determinism claim. */
  path: number[];
  /** The id of whoever it hit, or -1. */
  victim: number;
  /** How many times it bounced before it died. */
  bounces: number;
  /** How it ended, for a caller that wants to say so. */
  ending: 'hit' | 'splash' | 'expired';
}

/**
 * Fly one ball from the origin to its death and report the whole flight.
 *
 * The **whole trajectory** rather than the landing point, because the claim this
 * exists to test is that two module instances agree at *every* step. A check on
 * the endpoint alone would pass a simulation that diverged and reconverged,
 * which is exactly what an engine-dependent `Math.pow` in the drag term would
 * produce -- see the file header on why there is no `pow` and no `hypot` in the
 * step.
 *
 * Exported because `server/integration-check.ts` runs it against a *second*
 * instance of this module, loaded under a different specifier, which is the
 * closest a single process can get to "the browser and the server agree".
 *
 * It reports the victim rather than applying damage, because `stepFooty` does:
 * the consequence is a separate call by design -- `game/combat.ts`'s rule 2,
 * that presentation and consequence are return values and never side effects.
 */
export function traceFooty(
  id: number,
  world: CombatWorld | null = FLAT,
  targets: readonly CombatantState[] = [],
  pitch = 0,
): FootyTrace {
  const thrower = {
    id: 99,
    body: { position: { x: 0, y: EYE_HEIGHT, z: 0 }, yaw: 0, pitch },
  } as unknown as CombatantState;
  const ball = createFooty();
  spawnFooty(thrower, id, ball);
  const path: number[] = [];
  const s = createFootyStep();
  let victim = -1;
  let ending: FootyTrace['ending'] = 'expired';
  for (let i = 0; i < Math.round(LIFETIME / STEP_DT) + 2 && ball.alive; i++) {
    stepFooty(ball, STEP_DT, world, targets, s);
    path.push(ball.x, ball.y, ball.z);
    if (s.victim) {
      victim = s.victim.id;
      ending = 'hit';
    } else if (s.splashed) {
      ending = 'splash';
    }
  }
  return { path, victim, bounces: ball.bounces, ending };
}

/**
 * The five claims about this weapon that fail silently.
 *
 * The repo's rule, stated in `verifyCombat`: a check exists where the failure
 * renders, does not throw, and reads as a taste decision. All five do.
 *
 *   - **The trajectory is not deterministic.** The worst one, and the one with
 *     no picture at all: a client and a server whose balls diverge produce a
 *     player who watches their own throw sail past somebody and is told they hit
 *     them, or the reverse. It reads as lag and it is not lag.
 *   - **The bounce hash is not stable.** If the deflection depends on anything
 *     but `(id, bounce)` -- a module-level counter, a `Math.random`, the order
 *     balls are stepped in -- the two ends disagree from the first bounce, and
 *     the symptom is identical to the one above.
 *   - **A ball passes through a player.** At 26 m/s a ball crosses a capsule
 *     inside one tick, so a point test misses a third of the hits it should
 *     make. Nothing says so; the weapon just feels unreliable.
 *   - **It does not arc.** A ball with the gravity term dropped is the beam this
 *     replaced, wearing a different mesh, and every balance argument in the
 *     header stops being true with nothing on screen to say it.
 *   - **It out-damages or out-throws the bat.** The one constraint the whole
 *     file is shaped by, and the one that would never be noticed as a bug.
 *
 *     bun -e "import {verifyFooty} from './client/src/game/footy.ts';
 *             console.log(verifyFooty())"
 */
export function verifyFooty(): string[] {
  const failures: string[] = [];

  // --- Determinism, over a full flight including bounces, from two independent
  // runs. Bit-identical, not close: `===` on every coordinate.
  {
    const a = traceFooty(7);
    const b = traceFooty(7);
    if (a.path.length !== b.path.length) {
      failures.push(`Two identical throws lived ${a.path.length / 3} and ${b.path.length / 3} steps.`);
    } else {
      let differing = 0;
      for (let i = 0; i < a.path.length; i++) if (a.path[i] !== b.path[i]) differing++;
      if (differing > 0) {
        failures.push(
          `Two identical throws differed at ${differing} of ${a.path.length} coordinates. The ball ` +
            `simulation is not a pure function of its inputs, so the client and the server ` +
            `cannot agree about where it went.`,
        );
      }
    }
    if (a.bounces !== b.bounces) {
      failures.push(`Two identical throws bounced ${a.bounces} and ${b.bounces} times.`);
    }
    if (a.path.length < 30) {
      failures.push(`A thrown ball lived ${a.path.length / 3} steps; it should fly for a while.`);
    }
  }

  // --- Two different ids bounce differently, which is the whole of the oval
  // read. Same throw, same world, different ball.
  {
    const a = traceFooty(7).path;
    const b = traceFooty(8).path;
    let apart = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 3) {
      apart = Math.max(apart, Math.abs(a[i] - b[i]) + Math.abs(a[i + 2] - b[i + 2]));
    }
    if (apart < 0.5) {
      failures.push(
        `Two balls thrown identically with different ids ended up within ${apart.toFixed(2)} m of ` +
          `each other for their whole flight. The bounce deflection is not varying, so the ball ` +
          `is predictable and is not an oval.`,
      );
    }
  }

  // --- The hash itself: stable, in range, and actually mixing.
  {
    for (const [id, bounce, channel] of [[1, 0, 0], [1, 1, 0], [255, 2, 1], [37, 0, 1]] as Array<[number, number, number]>) {
      const h = bounceHash(id, bounce, channel);
      if (!(h >= 0 && h < 1)) failures.push(`bounceHash(${id}, ${bounce}, ${channel}) returned ${h}, outside [0, 1).`);
      if (bounceHash(id, bounce, channel) !== h) {
        failures.push(`bounceHash(${id}, ${bounce}, ${channel}) is not a function -- two calls disagreed.`);
      }
    }
    // Consecutive ids must not correlate: they are handed out in order, so a
    // weak mix would make every ball in a burst bounce the same way.
    let sameSide = 0;
    for (let id = 1; id < 60; id++) {
      if (bounceHash(id, 0, 0) < 0.5 === bounceHash(id + 1, 0, 0) < 0.5) sameSide++;
    }
    if (sameSide > 48) {
      failures.push(
        `${sameSide} of 59 consecutive ball ids deflect the same way on their first bounce. ` +
          `The hash is not mixing and a burst of throws will all bounce together.`,
      );
    }
    // And the fixed points that would make the whole thing a constant.
    const spread = new Set<number>();
    for (let i = 0; i < 32; i++) spread.add(Math.floor(bounceHash(i + 1, i & 3, 0) * 8));
    if (spread.size < 5) {
      failures.push(`32 draws from bounceHash covered ${spread.size} of 8 octiles; it is barely varying.`);
    }
  }

  // --- It arcs. A level throw has to fall, and fall at the controller's own
  // gravity rather than at some rate of its own.
  {
    const trace = traceFooty(3).path;
    let peak = -Infinity;
    let peakAt = 0;
    for (let i = 0; i < trace.length; i += 3) {
      if (trace[i + 1] > peak) {
        peak = trace[i + 1];
        peakAt = i / 3;
      }
    }
    if (peakAt === 0) {
      failures.push('A level throw never rose at all. LAUNCH_RISE is not reaching the launch velocity.');
    }
    // The first ground contact, and how far away it is. A level throw at 26 m/s
    // lofted 9 degrees from 1.48 m should carry something like 20-40 m before
    // it first touches down; anything approaching 100 m is a ball that is not
    // falling and is the beam again.
    let firstGround = -1;
    for (let i = 3; i < trace.length; i += 3) {
      if (trace[i + 1] <= BALL_RADIUS + 1e-6 && trace[i - 2] > BALL_RADIUS + 1e-6) {
        firstGround = Math.sqrt(trace[i] * trace[i] + trace[i + 2] * trace[i + 2]);
        break;
      }
    }
    if (firstGround < 0) {
      failures.push('A level throw never reached the ground inside its lifetime. The ball is not falling.');
    } else if (firstGround < 9 || firstGround > 26) {
      failures.push(
        `A level throw first landed ${firstGround.toFixed(1)} m away; measured, it is 13.9. Under ` +
          `9 m the weapon cannot reach past the bat and over 26 it has stopped being an arc.`,
      );
    }
  }

  // --- The direct-fire envelope has no dead zone in front of the thrower.
  //
  // The failure this catches is the one that decided `LAUNCH_RISE`, and it is
  // the most expensive kind of silent: a loft a couple of hundredths too high
  // sends every throw clean over the head of anybody inside 11 m, which is the
  // range a brawl in a terrace street actually happens at. The ball still flies,
  // still bounces, still knocks people over at 20 m, and simply never connects
  // up close -- and it reads as "the hit detection is broken" rather than as a
  // number.
  //
  // Swept over several ball ids, because past about 15 m whether a throw
  // connects depends on which way that ball's first bounce kicked, and a check
  // on one id would be asserting one bounce. The band tested is the one that is
  // meant to be *certain*; the skip band above it is meant not to be.
  {
    const misses: string[] = [];
    for (const id of [1, 7, 42, 200, 255]) {
      for (const range of [3, 4, 6, 8, 10, 12, 14]) {
        if (traceFooty(id, FLAT, [makeTarget(1, 0, -range)]).victim !== 1) {
          misses.push(`${range} m (ball ${id})`);
        }
      }
    }
    if (misses.length > 0) {
      failures.push(
        `A throw aimed level at a standing target missed at ${misses.join(', ')}. The direct-fire ` +
          `envelope has to be contiguous from 3 m to 14 m; a gap in front of the thrower is a ` +
          `dead zone at exactly the range this game is played at. See LAUNCH_RISE.`,
      );
    }
  }

  // --- A ball hits a body, and does so at a range where a bat cannot reach.
  //
  // The whole point of the weapon, and the sweep is what makes it work: at
  // 26 m/s the ball moves 0.43 m a tick, which is wider than the capsule.
  {
    if (traceFooty(11, FLAT, [makeTarget(1, 0, -12)]).victim !== 1) {
      failures.push(
        'A ball thrown at a target 12 m dead ahead did not hit it. The swept test in stepFooty ' +
          'is not finding a capsule the ball passes through inside one tick.',
      );
    }
    // ...and misses one well off the line.
    if (traceFooty(11, FLAT, [makeTarget(2, 6, -12)]).victim !== -1) {
      failures.push('A ball hit a target 6 m off the line of the throw.');
    }
    // A thrower is never their own victim, whatever the geometry. `traceFooty`
    // throws as id 99, so a target sharing that id must be skipped.
    if (traceFooty(11, FLAT, [makeTarget(99, 0, -6)]).victim !== -1) {
      failures.push('A thrower was hit by their own ball.');
    }
  }

  // --- Damage is one pip, and the knockback is a fraction of the bat's rather
  // than a match for it. The constraint the whole file exists under.
  {
    const thrower = makeTarget(0, 0, 0);
    const victim = makeTarget(1, 0, -20);
    const ball = createFooty();
    spawnFooty(thrower, 5, ball);
    const before = victim.health;
    const report: HitReport = {
      attacker: 0, victim: 0, ko: false, health: 0,
      point: { set: () => {} } as unknown as HitReport['point'],
    };
    applyFootyHit(thrower, victim, ball, report);
    if (Math.abs(before - victim.health - BALL_DAMAGE) > 1e-9) {
      failures.push(`A ball took ${(before - victim.health).toFixed(2)} pips, not ${BALL_DAMAGE}.`);
    }
    const plan = Math.sqrt(
      victim.body.velocity.x * victim.body.velocity.x + victim.body.velocity.z * victim.body.velocity.z,
    );
    const want = KNOCKBACK_HORIZONTAL * BALL_KNOCKBACK_SCALE;
    if (Math.abs(plan - want) > 1e-6) {
      failures.push(
        `A ball threw its victim at ${plan.toFixed(2)} m/s on the plan; ${BALL_KNOCKBACK_SCALE} of ` +
          `the bat's ${KNOCKBACK_HORIZONTAL} is ${want.toFixed(2)}.`,
      );
    }
    if (plan >= KNOCKBACK_HORIZONTAL) {
      failures.push('A ball throws its victim as far as a bat does. The melee no longer decides fights.');
    }
    if (victim.phase !== 'flinch') failures.push(`A pegged victim is in phase "${victim.phase}", not "flinch".`);
    if (thrower.hitstopT !== 0) {
      failures.push('A ball froze the thrower. Hitstop belongs to contact; see applyFootyHit.');
    }
  }

  // --- It dies, every time, one way or another. A ball that never expires is a
  // hit test running forever over a city.
  {
    for (const pitch of [0, 1.2, -1.2, 0.5]) {
      const ball = createFooty();
      const thrower = makeTarget(0, 0, 0);
      thrower.body.pitch = pitch;
      spawnFooty(thrower, 21, ball);
      const s = createFootyStep();
      let steps = 0;
      const limit = Math.round(LIFETIME / STEP_DT) + 4;
      while (ball.alive && steps < limit) {
        stepFooty(ball, STEP_DT, FLAT, [], s);
        steps++;
      }
      if (ball.alive) {
        failures.push(`A ball thrown at pitch ${pitch} was still alive after ${LIFETIME} s.`);
      }
      if (ball.bounces > MAX_BOUNCES) {
        failures.push(`A ball bounced ${ball.bounces} times; the budget is ${MAX_BOUNCES}.`);
      }
    }
  }

  // --- Water swallows it. The rule is one comparison and it is the one thing
  // between a thrown ball and an object bobbing in the harbour forever.
  {
    const wet: CombatWorld = { collision: null, groundHeight: () => -8, waterSurface: () => 0 };
    const ball = createFooty();
    spawnFooty(makeTarget(0, 0, 0), 31, ball);
    const s = createFootyStep();
    let splashed = false;
    for (let i = 0; i < 400 && ball.alive; i++) {
      stepFooty(ball, STEP_DT, wet, [], s);
      if (s.splashed) splashed = true;
    }
    if (!splashed) failures.push('A ball thrown into the harbour never splashed; it must not survive water.');
  }

  // --- The field: pooling, compaction and id assignment.
  {
    const field = new FootyField();
    const thrower = makeTarget(0, 0, 0);
    const events: FootyEvent[] = [];
    const ids = new Set<number>();
    for (let i = 0; i < 5; i++) ids.add(field.add(thrower).id);
    if (ids.size !== 5) failures.push(`Five throws produced ${ids.size} distinct ball ids.`);
    if (field.balls.length !== 5) failures.push(`FootyField holds ${field.balls.length} balls after five throws.`);
    for (let i = 0; i < 400 && field.balls.length > 0; i++) field.step(STEP_DT, FLAT, [], events);
    if (field.balls.length !== 0) {
      failures.push(`FootyField still holds ${field.balls.length} balls after every one of them died.`);
    }
    // And it recycles rather than growing: the sixth throw must reuse a record.
    const reused = field.add(thrower);
    if (!reused.alive || reused.age !== 0 || reused.bounces !== 0) {
      failures.push('A pooled ball record was handed out without being reset.');
    }
  }

  return failures;
}

/**
 * A combatant for the checks above, without importing `createCombatant`.
 *
 * Deliberately hand-built rather than borrowed from `game/combat.ts`: this
 * module is loaded by the server and by the browser and its check has to run in
 * both, and `createCombatant` reaches through `player/controller.ts` into three
 * for a `Vector3`. What a target needs here is a position, a yaw, a pitch, a
 * health and a phase, and all five are plain.
 */
function makeTarget(id: number, x: number, z: number): CombatantState {
  return {
    id,
    body: {
      position: { x, y: EYE_HEIGHT, z, set(px: number, py: number, pz: number) { this.x = px; this.y = py; this.z = pz; } },
      velocity: { x: 0, y: 0, z: 0, set(px: number, py: number, pz: number) { this.x = px; this.y = py; this.z = pz; } },
      onGround: true,
      yaw: 0,
      pitch: 0,
    },
    health: 3,
    stamina: 4,
    staminaT: 2,
    phase: 'idle',
    phaseT: 0,
    koT: 0,
    respawnT: 0,
    hitstopT: 0,
    trainingT: 0,
    flatWhiteT: 0,
    ballCharges: 3,
    ballT: 4,
  } as unknown as CombatantState;
}
