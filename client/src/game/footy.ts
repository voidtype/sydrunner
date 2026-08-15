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
 * **42, up from 28 -- the player asked for "1.5x faster in throws and thus
 * farther", and this is that number.** The rest of this comment is the argument
 * that used to be here, kept because it is what the change had to be measured
 * against, followed by what the measurement said.
 *
 * 28 m/s was a hard drop punt and it was chosen for the *flight time* rather
 * than for realism: it put 12 m at 0.43 s, which was long enough that a
 * sprinting target who changes direction is missed and short enough that a
 * stationary one is a fair shot. The old note said faster than about 32 and the
 * arc flattens into the beam this replaced.
 *
 * That prediction was wrong, and it is worth saying why rather than quietly
 * deleting it: it was reasoning about *speed* when the thing that makes a
 * trajectory readable is the **drop over the flight**, and drop goes as the
 * square of the time. `controller.GRAVITY` is 22.5 m/s^2, so a level throw
 * still falls 1.5 m in the 0.36 s it now takes to cross 15 m -- the ball is
 * three quarters of a metre lower at 15 m than a straight line would put it,
 * which is most of a person. Measured on the flat world:
 *
 *     28 m/s   first bounce at 13.9 m   direct-fire envelope 3-14 m
 *     42 m/s   first bounce at 27.6 m   direct-fire envelope 3-24 m
 *
 * So it is twice the range for 1.5x the speed, which is what a parabola does,
 * and the envelope is still contiguous from three metres -- `LAUNCH_RISE` is a
 * bias on the view direction rather than a fixed elevation, so it did not need
 * retuning and the dead zone it exists to prevent did not open.
 *
 * The ceiling that does exist is the wire: `protocol.BALL_BYTES` carries the
 * velocity as an i8 of half-metres a second, so +/-63.5 m/s. 42 leaves room for
 * the drop at the bottom of a fall off a tower and for `MAX_BOUNCES`' longer
 * tail; the encoder clamps regardless, and `verifyFooty` checks a steep throw
 * never gets near it.
 */
export const LAUNCH_SPEED = 42;

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
 * design rests on rather than an accident of the number.
 *
 * ---------------------------------------------------------------------------
 * 0.08, BECAUSE `LAUNCH_SPEED` WENT TO 42 AND THIS HAD TO FOLLOW IT
 *
 * This is a bias in the *direction*, so it is a fixed angle in space and takes
 * no account of how fast the ball leaves along it. The drop that it exists to
 * cancel is not fixed at all: over a given distance the drop goes as the square
 * of the flight time, so a 1.5x speed increase cuts it by 2.25. At 42 m/s with
 * the old 0.10 the loft therefore *overwhelmed* the drop and opened exactly the
 * dead zone this constant exists to prevent -- measured, a throw sailed over the
 * head of anybody between 4 and 10 m and connected again at 12.
 *
 * The same sweep the original number came from, redone at 42 m/s, five ball ids,
 * one throw per metre, looking level:
 *
 *     rise 0.10   connects  2-3 m,  then nothing until 12-24    DEAD ZONE
 *     rise 0.08   connects  2-22 m                              contiguous
 *     rise 0.06   connects  2-20 m
 *     rise 0.05   connects  2-19 m
 *     rise 0.04   connects  2-18 m
 *     rise 0.02   connects  2-16 m
 *
 * 0.08 is the largest loft with no dead zone, which is the identical rule that
 * chose 0.10 at 28 m/s, and it is also the one that reaches furthest. The
 * envelope went from 3-14 m to 2-22 m and the first bounce from 13.9 m to
 * 22.1 m: 1.5x the speed bought 1.6x the range, which is the "and thus farther"
 * half of the request and is what a parabola does.
 */
export const LAUNCH_RISE = 0.08;

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

/**
 * Below this vertical speed at a ground contact the ball is not bouncing, it is
 * settling. Metres a second.
 *
 * Set from what the bounce would look like rather than picked: a 1.2 m/s impact
 * rebounds at `RESTITUTION` into 0.66 m/s, which under `GRAVITY`'s 22.5 m/s^2 is
 * a one-centimetre hop lasting three ticks. There is no frame in which a
 * one-centimetre hop is distinguishable from the ball lying on the road, and
 * treating it as a bounce is what used to burn the budget and fire a thud a
 * dozen times in a fifth of a second.
 */
const SETTLE_SPEED = 1.2;

/**
 * How fast a rolling ball sheds speed, m/s^2.
 *
 * Constant rather than proportional -- see the roll branch in `stepFooty` for
 * why -- and **this is the number that was solved for rather than chosen**,
 * because the coefficient for a tumbling oval on asphalt is not a figure anybody
 * has and the request was not about friction anyway. The request was "10x
 * longer". Measured over 48 ball ids on the flat world:
 *
 *     before this change   1.10 s, 24 m of total travel
 *     0.60 m/s^2          12.54 s, 96 m
 *     0.75 m/s^2          11.10 s, 90 m      <- 10.1x
 *     0.90 m/s^2          10.01 s, 85 m
 *
 * 0.75 is the value at which a ball's life is ten times what it was, which is
 * what was asked for, and it corresponds to a roll of about seven seconds and
 * forty metres from the ~6 m/s of plan speed a ball has left when it settles.
 *
 * **Forty metres is the worst case by construction** and is worth being honest
 * about rather than burying: the flat world is the one place in Sydney with no
 * kerb, no parked car, no gutter and no terrace wall. `CollisionWorld.resolve`
 * reflects the roll off all of those, and every reflection costs
 * `restitutionFor` -- 0.41 to 0.69 of the speed -- so two walls take a rolling
 * ball's remaining travel down by three quarters. On a real street the ball
 * stops in the gutter, which is where footies stop. `verifyFooty` asserts the
 * flat figure *and* that a ball loose in a boxed room still dies.
 */
const ROLL_DECEL = 0.75;

/** Under this plan speed a rolling ball is at rest and is removed. m/s. */
const REST_SPEED = 0.4;

/**
 * How fast the ball must be going to hit anybody, m/s, squared.
 *
 * 6 m/s. Under it the ball is still drawn, still rolls, still bounces off walls
 * and is still the same object -- it simply does not knock people over. The
 * number is the speed at which being hit by a leather ball stops being an event:
 * `BALL_KNOCKBACK_SCALE` throws a victim 5.8 m along the flight, and a ball
 * moving slower than a walking pace cannot credibly do that to anybody.
 *
 * It did not exist before because it could not matter: a ball died 1.1 s after
 * release, at speed, and the slow tail is entirely new -- see the settle branch
 * in `stepFooty`. Six is also comfortably under everything the weapon is *for*:
 * a level throw is still doing 34 m/s at 20 m and 12 m/s after four bounces, so
 * the whole direct-fire envelope and the skip band behind it are unaffected, and
 * `verifyFooty`'s 2-22 m sweep is what says so.
 */
const ARM_SPEED_SQ = 6 * 6;

/**
 * `tan` of half the wander a rolling ball adds each tick.
 *
 * 0.0218 is `tan(1.25 degrees)`, so up to 2.5 degrees a tick either way, drawn
 * out of `bounceHash` on channel 2 with the tick index as the second input --
 * exact integer arithmetic on both ends, like every other draw in this file, so
 * a ball rolling for nine seconds on the client is rolling down the same gutter
 * on the server.
 *
 * **This is the answer to "does the sphere approximation matter now".** It does,
 * and this is where. `BALL_RADIUS` is a sphere and `RESTITUTION_SPREAD` was
 * always the stand-in for the oval -- one bounce sits up and the next shoots
 * through. That was enough when a ball existed for a second and a half. A ball
 * that now rolls for the better part of ten seconds spends most of its life in
 * the one regime where a sphere is unmistakable: a sphere rolls in a straight
 * line and a Sherrin does not, it wobbles off its long axis and hooks. A real
 * ellipsoid would need an orientation on the wire and an orientation-dependent
 * hit test, which the header rules out for a good reason -- a ball that hit
 * differently depending on a cosmetic value would be the one unfair thing in the
 * game. A per-tick heading wander is the same trick `RESTITUTION_SPREAD` plays,
 * at the same price of nothing, and it puts the unpredictability in the place a
 * player now actually looks at it.
 *
 * A random walk of 2.5 degrees a tick comes to about 11 degrees of accumulated
 * heading over a second, which reads as a ball that will not run straight and
 * not as a ball being steered.
 */
const ROLL_WOBBLE_TAN_HALF = 0.0218;

/**
 * After this many bounces the ball is dead.
 *
 * **Thirty, up from three.** The player asked for a ball that "persists and
 * bounces around for 10x longer", and `LIFETIME` alone could not deliver that:
 * three was the binding constraint, not five seconds. A drop punt on asphalt
 * used up its whole budget in about a second and a half and was deleted in
 * mid-air, still knee-high and still travelling -- which is why the old note
 * called three "a bounce, a skip and a settle" and why the wire comment in
 * `protocol.BALL_BYTES` says a ball lives about 1.5 s in practice.
 *
 * **The budget was never what a longer ball needed, though, and raising it alone
 * bought half a second.** `RESTITUTION` is 0.55, so the rebound speed is more
 * than halved every time and physics allows about six real bounces from any
 * impact whatsoever; past those the rebound is under `GRAVITY * dt` and the old
 * code spent the whole remaining budget consuming a "bounce" per tick while the
 * ball sat still. What actually made the ball last is the settle-and-roll branch
 * in `stepFooty`, and with that in place a level throw on flat ground uses three
 * or four bounces and rolls out the rest.
 *
 * So thirty is a *ceiling nothing reaches* rather than a length anybody sits
 * through, and it is doing the job three was: a ball that never dies is a hit
 * test running forever over a city. What can still reach it is a ball loose
 * among walls, where every reflection off a terrace counts -- which is exactly
 * the case that needs a stop. `LIFETIME` stands behind it, and `verifyFooty`
 * asserts both that a flat throw does *not* reach the ceiling and that a ball
 * thrown at four pitches is gone under one guard or the other.
 */
export const MAX_BOUNCES = 30;

/**
 * Seconds a ball may be in the air.
 *
 * **Fifty, up from five**: the player's "10x longer" applied to the clock, with
 * `MAX_BOUNCES` raised alongside it because the clock was never the binding
 * constraint -- see there.
 *
 * It is a backstop rather than a lifetime. Nothing thrown on the flat gets near
 * it: a level throw dies at 4.4 s and even a ball punted straight up off a
 * rooftop is settling inside fifteen. What fifty buys is that a ball rolling
 * down a hill, or trapped bouncing in a stairwell where every contact is nearly
 * elastic, is eventually removed rather than being an object the server carries
 * for the life of the room.
 *
 * **What it costs on the wire, checked rather than assumed.** Sixteen players on
 * a 1.6 s recharge sustain ten throws a second, and a ball that averages eleven
 * means of the order of a hundred in the air across the room at once, against
 * the two the old numbers sustained. At `protocol.BALL_BYTES`' 20 B that would
 * be 2 kB a snapshot if every player got every ball. They do not:
 * `aoi.InterestIndex.selectBalls` filters balls **by the ball's own position**
 * against `AOI_LEAVE_RADIUS`, so what a player is sent is the handful within
 * interest of where they are standing, and a hundred balls spread over a 60 km
 * disc is still a handful each. The cost lands on a brawl where sixteen people
 * are throwing at each other in one street, which is the one situation where a
 * player wants to see every ball.
 */
export const LIFETIME = 50.0;

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
  rotatePlan(ball, (bounceHash(ball.id, ball.bounces, channel) * 2 - 1) * DEFLECT_TAN_HALF);
}

/** The rotation itself, given `tan(theta/2)`. See `deflect` for the algebra. */
function rotatePlan(ball: Footy, t: number): void {
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
  //
  // **And only while it is still travelling.** A ball now spends most of its
  // life rolling -- see the settle branch below -- and a football trundling into
  // your ankles at half a metre a second taking a pip off you and launching you
  // 5.8 m along its heading is the single most absurd thing the longer lifetime
  // could produce. `ARM_SPEED` is the line: over it the ball is a thrown object
  // and hits, under it it is litter and a player walks through it. It is a
  // check on the *ball*, so both ends draw the line in the same place from the
  // same numbers, and it takes the sweep off the hot path for the eight seconds
  // of tail that used not to exist.
  if (ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz > ARM_SPEED_SQ) {
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
    // Head and feet both at the ball's own centre, which is what makes it a
    // point rather than a body: a ball is not 1.8 m tall, and the default head
    // would stop one thrown *under* the Western Distributor against a soffit
    // ten metres over it. The band the ball has to miss is its centre height,
    // the same number the roof test above it has always used.
    const r = world.collision.resolve(fromX, fromZ, toX, toZ, BALL_RADIUS, toY, toY);
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
    const vspeed = ball.vy < 0 ? -ball.vy : ball.vy;
    if (vspeed < SETTLE_SPEED) {
      // --- IT IS DOWN. IT ROLLS.
      //
      // This branch is the whole of "persist and bounce around for 10x longer",
      // and it is here because the four numbers the request named could not
      // deliver it on their own. Raising `LIFETIME` did nothing at all -- the
      // clock was never what killed a ball -- and raising `MAX_BOUNCES` bought
      // half a second, because `RESTITUTION` is 0.55 and physics allows about
      // six real bounces from any impact whatsoever. Past those six the rebound
      // is under `GRAVITY * dt` and the ball cannot clear the ground inside one
      // tick, so the old code spent the rest of its budget consuming a "bounce"
      // every tick while sitting still and then deleted itself. That chatter is
      // the reason `protocol.BALL_BYTES` says a ball lives about 1.5 s.
      //
      // A footy that has stopped bouncing has not stopped: it rolls, and on an
      // oval it rolls further than it flew. So a contact under `SETTLE_SPEED`
      // is not a bounce, does not spend the budget, and does not fire the thud.
      // The ball lies on the surface, sheds speed to rolling resistance, and is
      // removed when it is genuinely at rest.
      ball.vy = 0;
      const plan = Math.sqrt(ball.vx * ball.vx + ball.vz * ball.vz);
      if (plan <= REST_SPEED) {
        ball.x = toX;
        ball.y = toY;
        ball.z = toZ;
        ball.alive = false;
        out.expired = true;
        return out;
      }
      // Constant deceleration rather than a fraction of speed, because rolling
      // resistance *is* roughly constant -- unlike `DRAG`, which is a fraction
      // for the opposite reason. The practical difference is the tail: an
      // exponential never quite arrives and would leave the ball creeping for
      // the whole 50 s, where this one reaches `REST_SPEED` on a schedule.
      const shed = ROLL_DECEL * dt;
      const k = plan > shed ? (plan - shed) / plan : 0;
      ball.vx *= k;
      ball.vz *= k;
      // And the wobble, which is the oval. See `ROLL_WOBBLE_TAN_HALF`.
      rotatePlan(ball, (bounceHash(ball.id, Math.round(ball.age / dt), 2) * 2 - 1) * ROLL_WOBBLE_TAN_HALF);
    } else {
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
      // `Math.abs` rather than negation: a ball that arrived at the ground with
      // an upward velocity -- which happens when a wall bounce this same tick
      // has already flipped it -- must not be sent downward by this one.
      ball.vy = Math.abs(ball.vy) * e;
      ball.vx *= BOUNCE_FRICTION;
      ball.vz *= BOUNCE_FRICTION;
      deflect(ball, 0);
    }
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
   * Wraps at 65,536 and skips 0, because 0 is reserved for "no ball".
   *
   * **It used to wrap at 256 and that is now a live bug rather than a stale
   * comment**, which is why it moved with the rest of the change. The old note
   * read: a ball lives 5 s and sixteen players cannot throw 256 in that time,
   * the bar being three and one back every four seconds, so the ceiling is
   * about 60. Both halves of that arithmetic just moved. Sixteen players on a
   * 1.6 s recharge sustain ten throws a second and a ball now lives eleven, so
   * about 110 are in the air at once and the counter comes all the way round in
   * twenty-five seconds -- less than half a ball's life. Two live balls would
   * share an id.
   *
   * What that produces is not subtle once you know to look for it and is
   * impossible to find otherwise: `bounceHash` is keyed on the id, so the two
   * would bounce identically, and `protocol` v8 widened this field to a u16
   * precisely because a recycled id "puts a fresh ball on the interpolation
   * history of one that just died, which draws a football teleporting across the
   * street". The wire has had the room since v8; only this counter had not
   * caught up.
   *
   * At 65,535 the same arithmetic gives six thousand seconds between reuses.
   */
  private nextId = 1;

  /** Put a ball in the air. Returns it, live, already in `balls`. */
  add(thrower: CombatantState): Footy {
    const ball = this.pool.pop() ?? createFooty();
    spawnFooty(thrower, this.nextId, ball);
    this.nextId = this.nextId >= 65535 ? 1 : this.nextId + 1;
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
    // The first ground contact, and how far away it is. A level throw at 42 m/s
    // lofted 4.6 degrees from 1.48 m carries 22.1 m before it first touches
    // down; anything approaching 100 m is a ball that is not falling and is the
    // beam again.
    //
    // The band moved with `LAUNCH_SPEED` and it had to: the previous one was
    // 9-26 m against a measured 13.9, and a throw 1.5x faster travels 1.6x as
    // far for the identical reason the drop is a parabola. What has *not*
    // moved is what the band is for -- under the floor the weapon cannot reach
    // past the bat, over the ceiling it has stopped arcing -- and both edges
    // are still the same multiple of the measured value they were.
    let firstGround = -1;
    for (let i = 3; i < trace.length; i += 3) {
      if (trace[i + 1] <= BALL_RADIUS + 1e-6 && trace[i - 2] > BALL_RADIUS + 1e-6) {
        firstGround = Math.sqrt(trace[i] * trace[i] + trace[i + 2] * trace[i + 2]);
        break;
      }
    }
    if (firstGround < 0) {
      failures.push('A level throw never reached the ground inside its lifetime. The ball is not falling.');
    } else if (firstGround < 15 || firstGround > 40) {
      failures.push(
        `A level throw first landed ${firstGround.toFixed(1)} m away; measured, it is 22.1. Under ` +
          `15 m the weapon cannot reach past the bat and over 40 it has stopped being an arc.`,
      );
    }
  }

  // --- IT LANDS, ROLLS, AND STOPS. The three-line summary of everything the
  // "10x longer" request changed, and every one of the three fails silently.
  //
  //   - A ball that still chatters -- a `SETTLE_SPEED` of zero, or the settle
  //     branch never reached -- spends `MAX_BOUNCES` on a fifth of a second of
  //     buzzing and dies where it landed. That is what the request was about
  //     and there is no frame that says so, because the ball looks fine right
  //     up until it vanishes.
  //   - A ball that rolls and never stops is a hit test running for the life of
  //     the room, over a city, on both ends. `LIFETIME` catches it eventually
  //     and eventually is fifty seconds.
  //   - A ball that rolls *forever downhill on the flat* -- `ROLL_DECEL` lost,
  //     or applied as a fraction rather than a deceleration -- reads as ice.
  {
    const t = traceFooty(5);
    const life = t.path.length / 3 / 60;
    const travel = Math.sqrt(
      t.path[t.path.length - 3] * t.path[t.path.length - 3] +
        t.path[t.path.length - 1] * t.path[t.path.length - 1],
    );
    if (t.ending !== 'expired') {
      failures.push(`A level throw over empty ground ended as '${t.ending}'; it should roll to a stop.`);
    }
    if (life < 6) {
      failures.push(
        `A level throw was over in ${life.toFixed(1)} s. Measured it runs 11.1 s, which is the ten ` +
          `times the 1.10 s it used to run that was asked for -- under 6 s the ball is being killed ` +
          `by its bounce budget again rather than by friction, so the settle branch is not firing.`,
      );
    }
    if (life > 20) {
      failures.push(
        `A level throw was still alive after ${life.toFixed(1)} s on flat ground. It is not losing ` +
          `speed to ${ROLL_DECEL} m/s^2 of rolling resistance and will only die on the clock.`,
      );
    }
    if (travel > 130) {
      failures.push(
        `A level throw finished ${travel.toFixed(0)} m from the thrower; measured it is 90 m on a ` +
          `world with no kerb in it. Past 130 the roll is not decelerating.`,
      );
    }
    // Most of that life is spent rolling rather than bouncing, which is the
    // shape of the change: `MAX_BOUNCES` is now a ceiling nothing reaches.
    if (t.bounces >= MAX_BOUNCES) {
      failures.push(
        `A level throw on flat ground used its whole ${MAX_BOUNCES}-bounce budget. Contacts below ` +
          `${SETTLE_SPEED} m/s are meant to settle rather than bounce; the chatter is back.`,
      );
    }
  }

  // --- IT DOES NOT KNOCK PEOPLE OVER WHILE TRUNDLING. `ARM_SPEED_SQ`.
  //
  // The failure is quiet and ridiculous: a footy rolling into somebody's ankles
  // at walking pace takes a pip off them and launches them 5.8 m. It could not
  // happen before because a ball was never slow and alive at the same time.
  {
    const ball = createFooty();
    spawnFooty(makeTarget(0, 0, 0), 13, ball);
    const s = createFootyStep();
    // Run it until it is rolling, then stand somebody in front of it.
    let rolling = -1;
    for (let i = 0; i < Math.round(LIFETIME / STEP_DT) && ball.alive; i++) {
      stepFooty(ball, STEP_DT, FLAT, [], s);
      const sp = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz);
      if (sp < Math.sqrt(ARM_SPEED_SQ) * 0.5) {
        rolling = i;
        break;
      }
    }
    if (rolling < 0) {
      failures.push('A ball never slowed below half the arming speed; the roll is not shedding speed.');
    } else {
      // Directly in its path, one tick ahead.
      const ahead = makeTarget(1, ball.x + ball.vx * STEP_DT, ball.z + ball.vz * STEP_DT);
      ahead.body.position.y = BALL_RADIUS + EYE_HEIGHT;
      for (let i = 0; i < 30 && ball.alive; i++) {
        stepFooty(ball, STEP_DT, FLAT, [ahead], s);
        if (s.victim !== null) {
          failures.push(
            'A football rolling at under 3 m/s knocked a standing player over. `ARM_SPEED_SQ` is ' +
              'not gating the body sweep, and the longer lifetime has turned litter into a weapon.',
          );
          break;
        }
      }
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
      for (const range of [3, 4, 6, 8, 10, 12, 14, 17, 20, 22]) {
        if (traceFooty(id, FLAT, [makeTarget(1, 0, -range)]).victim !== 1) {
          misses.push(`${range} m (ball ${id})`);
        }
      }
    }
    if (misses.length > 0) {
      failures.push(
        `A throw aimed level at a standing target missed at ${misses.join(', ')}. The direct-fire ` +
          `envelope has to be contiguous from 3 m to 22 m; a gap in front of the thrower is a ` +
          `dead zone at exactly the range this game is played at. See LAUNCH_RISE, whose table ` +
          `is the sweep this assertion is the surviving edge of.`,
      );
    }
  }

  // --- THE WIRE. `protocol.BALL_BYTES` carries the velocity as an i8 of
  // half-metres a second, so anything past 63.5 m/s clips and the renderer
  // curves the interpolation the wrong way and points the tumble sideways.
  //
  // It was never close at 28 m/s and the note there says so. At 42, with a
  // bounce budget that now lets a ball fall off a roof and keep going, it is
  // worth being a check rather than a claim -- the failure is a ball that reads
  // as skidding rather than flying and there is no other symptom.
  {
    let fastest = 0;
    for (const pitch of [0, -1.2, -0.6, 0.9]) {
      const ball = createFooty();
      const thrower = makeTarget(0, 0, 0);
      // Thrown off a 40 m rooftop, straight down, which is the worst case the
      // city offers: the launch speed plus a full building of gravity.
      thrower.body.position.y = 40;
      thrower.body.pitch = pitch;
      spawnFooty(thrower, 17, ball);
      const s = createFootyStep();
      for (let i = 0; i < Math.round(LIFETIME / STEP_DT) && ball.alive; i++) {
        stepFooty(ball, STEP_DT, FLAT, [], s);
        for (const v of [ball.vx, ball.vy, ball.vz]) {
          const a = v < 0 ? -v : v;
          if (a > fastest) fastest = a;
        }
      }
    }
    if (fastest > 60) {
      failures.push(
        `A ball reached ${fastest.toFixed(1)} m/s on one axis. The snapshot carries velocity as an ` +
          `i8 of half-metres a second, so anything over 63.5 clips -- see protocol.BALL_BYTES.`,
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
    // Long enough for the roll to finish: the budget is the clock, not a
    // literal, because a ball now outlives any round number anybody would pick.
    const forever = Math.round(LIFETIME / STEP_DT) + 4;
    for (let i = 0; i < forever && field.balls.length > 0; i++) field.step(STEP_DT, FLAT, [], events);
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
