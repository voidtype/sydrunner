/**
 * The bat swats the footy: the one interaction the two weapons did not have.
 *
 * The community's suggestion, in the words it arrived in: *a thrown footy always
 * lands; swatting one out of the air with a well-timed swing would make the
 * ranged weapon a duel rather than a coin flip.* That is a design complaint
 * rather than a feature request and it is worth restating as one, because the
 * shape of everything below follows from it.
 *
 * `game/footy.ts` bought the ranged weapon its balance with **travel time**: a
 * ball takes 0.36 s to cross 15 m, and a target who changes direction inside
 * that is missed. What the thrower spends is the risk that you move. What the
 * *target* spends is nothing at all -- there is no answer to a thrown ball
 * except to not be where it is going, and once it is in the air and aimed
 * correctly the exchange is settled. A swing that can send the ball back is the
 * missing half of that: it costs a swing, it costs the 150 ms of `PUNCH_WIND_UP`
 * you spend committed to it, and it can only be spent in the 100 ms window the
 * blade is actually out. Read the other way round, it is the first thing in this
 * game that makes the *timing* of a swing matter rather than its aim.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS AND IS NOT, WHICH IS THE WHOLE OF ITS PLACE IN THE TICK
 *
 * It is one function of arithmetic over two records this project already had:
 * a `CombatantState` mid-swing and a `Footy` in flight. It owns **no state**,
 * allocates nothing per call, and is called from exactly two places -- the
 * server's tick in `server/sim.ts` and the offline client's tick in `main.ts` --
 * which is the same pair `game/footy.ts`'s own step is called from and for the
 * same reason. A third copy of "did the bat reach the ball" would be a third
 * chance to disagree about it.
 *
 * It is deliberately **not** in `footy.ts` and **not** in `combat.ts`, and the
 * reason is which file would have to learn about which. `combat.hitTest` knows
 * nothing about balls and should not: it is spec 8.2's sphere-cast against
 * bodies and every future weapon that swings will want it unchanged. `footy.ts`
 * imports nothing from three and steps a ball against a world that has no
 * concept of a swing phase. The interaction belongs to neither and reaches into
 * both, so it is its own module -- exactly the split `game/riding.ts` makes
 * between the controller and the trains.
 *
 * ---------------------------------------------------------------------------
 * THE FOUR DECISIONS
 *
 * **1. The window is the ACTIVE phase, all of it, with no leniency.**
 *
 * `combat.advance` emits `events.strike` on the single tick the swing enters
 * `active`, and that is the right shape for a hit test against a body -- a
 * player either was or was not in reach at the instant the blade came through,
 * and one test settles it. A ball is different: it is a moving object crossing
 * a moving arc, and *when* the two meet inside the window is exactly the skill
 * the suggestion is asking for. So this runs on **every tick the swinger is in
 * `active`** -- six of them at 60 Hz, `PUNCH_ACTIVE` being 0.1 s -- and the ball
 * is swatted on whichever one it is actually reachable on.
 *
 * No extra leniency past that, which was the other option and is the wrong one.
 * A window widened to include the last frames of the wind-up would make the
 * timing forgiving, and a mechanic whose whole value is that it is *timed* is
 * worth nothing forgiving. `verifySwat` asserts both edges: a ball reachable on
 * an active tick is swatted, and the identical ball on a wind-up tick is not.
 *
 * **2. The ball is rewound to the swinger's view time; the swinger is not.**
 *
 * This looks like it contradicts `footy.stepFooty`, which pointedly does *not*
 * rewind its targets, so the two have to be read together. `stepFooty` asks
 * "the server's ball is here now -- who is it touching?", and rewinding the
 * bodies would mean a ball that visibly passed somebody 100 ms ago knocking them
 * over now. This asks the opposite question: "a player pressed the button
 * looking at a screen that is `viewTicks` old -- what was in front of their bat
 * *on that screen*?" That is `combat.hitTest`'s question exactly, and spec 8.2's
 * answer to it is the 250 ms rewind. The subject that is late is the **ball**
 * here and the **body** there, so the thing that gets rewound swaps over.
 *
 * The ball is rewound **from its own velocity** rather than from a history ring,
 * and that is a deliberate trade rather than a shortcut. `server/rewind.ts`
 * keeps 15 ticks of position per player because a player's path is a decision
 * and cannot be extrapolated backwards; a ball's is a parabola whose two terms
 * are both on the record. So `rewindBall` integrates the same gravity backwards
 * analytically -- see there -- and costs no memory at all, against the ~100
 * balls a busy room can have in the air and a server with 1 GB of RAM.
 *
 * **3. The deflection is a reflection off the bat's face, then steered to aim.**
 *
 * The bat's face is modelled as a plane whose normal is the swinger's view
 * direction, so a ball coming head-on goes back the way it came and one crossing
 * the arc is barely turned by the reflection alone. That second case is most of
 * them, and it is why the aim term exists: the velocity is then **rotated**
 * toward where the swinger is looking, which turns the swat into a counter-throw
 * rather than a deflection into a wall.
 *
 * The aim term rotates rather than adds, and that is the one piece of arithmetic
 * here worth defending. Adding `aim * speed` to a reflection *raises* the speed
 * -- a 42 m/s ball taken head-on would come back at 54 -- and `protocol`'s ball
 * velocity is an i8 of half-metres a second, so anything past 63.5 m/s clips and
 * the renderer curves the interpolation the wrong way. Worse, a weapon that
 * makes the projectile faster every time it changes hands has a rally that ends
 * in a wire overflow. Steering leaves the speed exactly `SWAT_SPEED_SCALE` of
 * what it was, so a rally decays: 42, 36, 30, 26, and by the fourth exchange the
 * ball is under `footy.ARM_SPEED_SQ`'s arming speed and is litter.
 *
 * **4. The owner changes; the thrower does not.**
 *
 * `Footy` grew an `owner` beside its `thrower` for this, and the split is the
 * only part of this feature that reaches into another module's record. The two
 * fields answer two questions that used to be one:
 *
 *   - `thrower` is **who is drawing it**, and it is what goes on the wire. A
 *     client draws its own throws from its own prediction and everybody else's
 *     from the snapshot stream (`net/client.ownBall`), so a field that changed
 *     hands mid-flight would make a ball vanish for the swinger, who has no
 *     local copy of it, and appear twice for the thrower, who does.
 *   - `owner` is **whose ball it is**: who cannot be hit by it, and who is
 *     credited when it knocks somebody down. That is what a swat takes.
 *
 * So a returned ball can hit the person who threw it -- which is the mechanic --
 * and cannot hit the person who returned it, and the knockout goes on the
 * swinger's scoreboard with the feed line "%s returned serve on %s".
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM, AND WHY THIS MODULE IS ALLOWED ITS SINES
 *
 * `footy.ts`'s header bans `Math.sin`, `cos`, `pow` and `hypot` from anything
 * evaluated on both ends, because ECMAScript leaves their last place to the
 * implementation and V8 and JavaScriptCore differ there. The step of a ball is
 * held to that absolutely.
 *
 * This is not in that step. A swat is adjudicated **once, by one process**: the
 * server online, the client offline, never both. The deflected velocity then
 * travels to every client as ordinary snapshot state, quantised to the i8 the
 * wire has always used, and no client ever recomputes it. So the two sines and
 * one cosine of the swinger's look are on exactly the footing `spawnFooty`'s
 * are -- evaluated once, at the moment of an event, by whoever is deciding --
 * and nothing downstream of them is expected to be bit-identical anywhere else.
 * `Math.sqrt` is still used for the normalisations, because it is specified to
 * IEEE-754 exactness and there is no reason to reach for `hypot` when the
 * cheaper call is also the exact one.
 *
 * The one thing that *is* held to the shared standard is the geometry:
 * `combat.segmentDistance` is the same solve `hitTest` and `stepFooty` both use,
 * called here with a degenerate second segment, so "did the bat reach it" is one
 * function in the codebase and not three.
 */

import {
  CAST_RADIUS,
  REACH,
  segmentDistance,
  type CombatantState,
} from './combat.ts';
import { BALL_RADIUS, type Footy } from './footy.ts';
import { GRAVITY } from '../player/controller.ts';

// --- The numbers ----------------------------------------------------------------

/**
 * How much of its speed a swatted ball keeps.
 *
 * 0.85, and it is a *decay* rather than a boost on purpose -- see decision 3 in
 * the header. A bat swung at a ball in life adds energy and this one takes some
 * away, which is unphysical and is the only rule under which a rally between two
 * players terminates: at 0.85 a ball that started at `footy.LAUNCH_SPEED`'s
 * 42 m/s is under the 6 m/s `footy.ARM_SPEED_SQ` arms at after eleven
 * exchanges, and under the speed anybody would bother swinging at long before
 * that. It is also what keeps the return inside `protocol.BALL_BYTES`' +/-63.5
 * m/s with the whole of a rooftop fall's gravity still to add.
 *
 * The number itself is the brief's. Measured against the alternatives it is the
 * right end of a narrow range: much under 0.7 and a returned ball drops at the
 * swinger's feet, which makes the swat a way of destroying a ball rather than of
 * sending one back; at 1.0 the exchange never decays and two players can keep
 * one ball in the air until the 50 s `footy.LIFETIME` kills it.
 */
export const SWAT_SPEED_SCALE = 0.85;

/**
 * How far the return is steered toward where the swinger is looking, 0..1.
 *
 * A **rotation** of the reflected velocity toward the aim, not an addition to it,
 * so the speed above is exactly the speed and this only decides the direction.
 * 0.6 blends the reflection and the aim six to four in the aim's favour and then
 * renormalises, which in practice means:
 *
 *     ball head-on, looking back at the thrower     returns within 5 degrees
 *     ball crossing at 60 degrees                   returns within 25 degrees
 *     ball crossing at 90 degrees                   returns within 40 degrees
 *
 * so a well-timed swing at somebody who is looking at you is a genuine
 * counter-throw and a panicked one across the body is a ball that goes
 * *somewhere*, which is the right asymmetry: the aim is the skill and the timing
 * is the gate.
 *
 * At 1.0 the reflection would be discarded entirely and every swat would return
 * the ball dead along the crosshair regardless of where it came from, which is a
 * homing weapon rather than a bat. At 0 it is a pure mirror and a ball crossing
 * your front is untouched in direction, which reads as the swing having missed.
 */
export const SWAT_AIM_SHARE = 0.6;

/**
 * The sweep radius for a ball, metres.
 *
 * `combat.CAST_RADIUS` plus the ball's own, because the swing's cast is a sphere
 * of that radius swept along the reach and the ball is a sphere too -- two
 * spheres touch when their centres are within the sum. The brief names this
 * exactly and it is also the only answer consistent with the player test, which
 * adds `CAPSULE_RADIUS` to the same cast for the same reason.
 *
 * Neither term is this module's to change: `CAST_RADIUS` is compiled into the
 * server's swing and `BALL_RADIUS` into its ball, and a swat that used its own
 * number would be a bat that reaches further for a football than for a person.
 */
export const SWAT_RADIUS = CAST_RADIUS + BALL_RADIUS;

// --- Rewinding a ball -------------------------------------------------------------

/** Where a ball was, and how fast, at some point in the recent past. */
export interface BallAt {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

/** A scratch `BallAt`, for a caller with no reason to own one. */
export function createBallAt(): BallAt {
  return { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 };
}

/**
 * Where this ball was `back` seconds ago. Writes into `out` and returns it.
 *
 * Integrating the flight backwards rather than remembering it, which is the
 * trade the header argues: a player's path over 250 ms is a sequence of
 * decisions and `server/rewind.ts` has to store it, and a ball's is a parabola
 * with both of its terms on the record.
 *
 * The algebra, since a sign error here is a swat that connects with thin air.
 * `stepFooty` integrates **semi-implicitly** -- gravity onto the velocity first,
 * then the position off the new velocity -- so over `n` steps of `dt`, writing
 * `T = n dt`:
 *
 *     v(T) = v0 + g T           p(T) = p0 + v0 T + (1/2) g T (T + dt)
 *
 * and substituting `v0 = v - g T` into the second and solving for `p0`:
 *
 *     p0 = p - v T + (1/2) g T (T - dt)
 *
 * The `- dt` is the half-tick the semi-implicit form differs from the textbook
 * closed form by, and it is carried rather than dropped because it is not small:
 * over the 250 ms cap at 22.5 m/s^2 it is **4.7 cm**, which is half the ball's
 * radius, and the whole reason to rewind at all is that centimetres matter. That
 * is also why `dt` is a parameter of a function that otherwise would not need
 * one -- the integrator's step is part of the inverse, and a rewind written
 * against the closed form is a rewind that is quietly wrong in the direction of
 * the sky.
 *
 * `GRAVITY` is negative (`controller.GRAVITY` is -22.5), so the vertical term
 * *lowers* the rewound position, which is right: a falling ball was higher a
 * moment ago and the `- v T` term has already over-corrected for it.
 *
 * **What is ignored is the drag and the bounces**, and both are worth naming.
 * `footy.DRAG` sheds 9% of speed a second, so over the 250 ms cap this is out by
 * at most 2% of one tick's travel -- under a centimetre, which is a tenth of the
 * ball's own radius. A **bounce** inside the window is not modelled at all and
 * cannot be: the ball's path had a corner in it, and a parabola run backwards
 * through a corner ends up somewhere the ball never was. That is a real error
 * and it is bounded by how far a ball moves between bounces; what makes it
 * acceptable is that the alternative -- a 15-tick ring per ball on a 1 GB box
 * that may be carrying a hundred of them -- buys accuracy on the one case where
 * a player cannot have been aiming at the ball anyway, because on their screen
 * it was mid-bounce.
 *
 * The velocity is rewound too, because the caller sweeps a *segment* of the
 * ball's flight and needs the direction it was travelling then rather than now.
 */
export function rewindBall(ball: Footy, back: number, dt: number, out: BallAt): BallAt {
  out.vx = ball.vx;
  out.vy = ball.vy - GRAVITY * back;
  out.vz = ball.vz;
  out.x = ball.x - ball.vx * back;
  out.y = ball.y - ball.vy * back + 0.5 * GRAVITY * back * (back - dt);
  out.z = ball.z - ball.vz * back;
  return out;
}

// --- The test ---------------------------------------------------------------------

/**
 * Is a ball at `at`, over one step of `dt`, inside this swinger's swing volume?
 *
 * Returns the swinger-to-ball plan distance when it is and `-1` when it is not,
 * so a caller can resolve nearest-wins on the number without a second pass.
 *
 * The geometry is `combat.hitTest`'s, term for term, with the capsule swapped for
 * a ball:
 *
 *   - the **cast** is a `REACH`-long segment from the swinger's eye along their
 *     view direction, which is the swing;
 *   - the **subject** is the ball's own one-tick flight segment, swept rather
 *     than point-tested for `stepFooty`'s reason -- at 42 m/s a ball moves 0.7 m
 *     in a tick, which is wider than the whole 0.585 m sweep radius, so a point
 *     test would let a fast ball pass clean through the blade about half the
 *     time and there would be no frame that said so;
 *   - the two are close enough when `segmentDistance` puts them inside
 *     `SWAT_RADIUS`;
 *   - and the **plan-distance gate at `REACH`** is applied on top, which is the
 *     clause `hitTest`'s header spends most of its length on: a 0.585 m sphere
 *     swept 1.55 m first touches something 2.14 m away, and a bat that reached
 *     that far would be a magnet. The sweep decides aim and the plan distance
 *     decides reach, exactly as it does against a player.
 *
 * The view direction is built inline rather than through `combat.viewDirection`
 * for `sim.strikeOfficers`' reason: that function wants a `Vector3` to write
 * into, this module has no three import, and the arithmetic is three lines.
 */
export function swingCatches(swinger: CombatantState, at: BallAt, dt: number): number {
  const eye = swinger.body.position;
  const dx = at.x - eye.x;
  const dz = at.z - eye.z;
  const plan = Math.sqrt(dx * dx + dz * dz);
  if (plan > REACH) return -1;

  const cp = Math.cos(swinger.body.pitch);
  const fx = -Math.sin(swinger.body.yaw) * cp;
  const fy = Math.sin(swinger.body.pitch);
  const fz = -Math.cos(swinger.body.yaw) * cp;

  const d = segmentDistance(
    eye.x, eye.y, eye.z,
    eye.x + fx * REACH, eye.y + fy * REACH, eye.z + fz * REACH,
    at.x, at.y, at.z,
    at.x + at.vx * dt, at.y + at.vy * dt, at.z + at.vz * dt,
  );
  return d > SWAT_RADIUS ? -1 : plan;
}

// --- The deflection ---------------------------------------------------------------

/**
 * Send the ball back. Mutates `ball`'s velocity and its owner; returns nothing.
 *
 * Three steps, in the order the header's decision 3 sets out.
 *
 * **Reflect** about the plane whose normal is the swinger's view: for a unit
 * normal `n`, `v' = v - 2 (v . n) n`. That is the plane reflection and not the
 * axis one, and getting it the other way round is the failure that produces a
 * bat which passes balls straight through: reflecting a head-on ball *about the
 * aim axis* returns the velocity unchanged, and the swat would look like a very
 * expensive way of doing nothing.
 *
 * **Steer** the result toward the aim by `SWAT_AIM_SHARE`, as a blend of two
 * directions rather than of two velocities, then renormalise. This is what makes
 * a ball crossing the arc come back rather than carry on past.
 *
 * **Scale** to `SWAT_SPEED_SCALE` of the speed it arrived with. Set, not
 * multiplied into whatever the blend produced, so the outgoing speed is exactly
 * a known fraction of the incoming one and cannot depend on the angle -- which
 * is the same argument `combat.applyHit` makes about setting the knockback
 * rather than adding it, and for the same reason: it is the only version a
 * player can learn.
 *
 * The degenerate cases are both real. A ball with no speed at all cannot be
 * reflected into anything, and a ball travelling exactly along the aim reflects
 * to a vector that cancels against the aim term; both fall back to "straight
 * out along the crosshair at the incoming speed", which is the answer a player
 * would expect from a bat and is never a `NaN` ball. A `NaN` ball quantises to
 * the edge of the world and never dies, which is why the guards are here rather
 * than argued away.
 */
export function applySwat(swinger: CombatantState, ball: Footy): void {
  const cp = Math.cos(swinger.body.pitch);
  const nx = -Math.sin(swinger.body.yaw) * cp;
  const ny = Math.sin(swinger.body.pitch);
  const nz = -Math.cos(swinger.body.yaw) * cp;

  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz);
  const out = speed * SWAT_SPEED_SCALE;

  // Reflect about the face plane.
  const dot = ball.vx * nx + ball.vy * ny + ball.vz * nz;
  let rx = ball.vx - 2 * dot * nx;
  let ry = ball.vy - 2 * dot * ny;
  let rz = ball.vz - 2 * dot * nz;
  const rlen = Math.sqrt(rx * rx + ry * ry + rz * rz);
  if (rlen > 1e-6) {
    rx /= rlen;
    ry /= rlen;
    rz /= rlen;
  } else {
    rx = nx;
    ry = ny;
    rz = nz;
  }

  // Steer toward the aim, as directions.
  const k = SWAT_AIM_SHARE;
  let bx = rx * (1 - k) + nx * k;
  let by = ry * (1 - k) + ny * k;
  let bz = rz * (1 - k) + nz * k;
  const blen = Math.sqrt(bx * bx + by * by + bz * bz);
  if (blen > 1e-6) {
    bx /= blen;
    by /= blen;
    bz /= blen;
  } else {
    bx = nx;
    by = ny;
    bz = nz;
  }

  ball.vx = bx * out;
  ball.vy = by * out;
  ball.vz = bz * out;
  // And it is the swinger's ball now: they cannot be hit by it, the person who
  // threw it can be, and a knockout goes on their scoreboard. See the header's
  // decision 4 for why `thrower` is deliberately left alone.
  ball.owner = swinger.id;
}

// --- One swinger, one tick ---------------------------------------------------------

/**
 * The whole of a swat, for one combatant on one tick. Returns the ball it sent
 * back, or null.
 *
 * The caller's contract is three lines and both call sites are the same three:
 * check the phase, call this, and turn a non-null answer into a noise and an
 * event. Everything about *whether* -- the phase, the ownership, the liveness --
 * is decided here rather than at the call sites, because two call sites that
 * each decided it would be two chances to decide it differently.
 *
 * `back` is how far the swinger's view is behind the simulation, in seconds:
 * `viewTicks * FIXED_DT` on the server, and **zero** offline, where the client is
 * the authority and its own screen is the simulation. Nothing here caps it; the
 * server's `viewTicks` is already capped at spec 10's 250 ms by the ring that
 * produces it, and a cap in two places is a cap that can disagree with itself.
 *
 * Nearest-wins by plan distance, on `hitTest`'s rule and for its reason: two
 * balls crossing the arc at 0.9 m and 1.3 m should resolve to the closer one,
 * and the swept-segment distance would pick whichever happened to pass nearer
 * the middle of the cast. One ball per swing per tick -- a bat is one object and
 * cannot be in two places, and the ball it took is now its owner's, so the
 * remaining five ticks of the window cannot take it again.
 */
export function swatBalls(
  swinger: CombatantState,
  balls: readonly Footy[],
  dt: number,
  back: number,
  scratch: BallAt,
): Footy | null {
  if (swinger.phase !== 'active') return null;
  let best: Footy | null = null;
  let bestPlan = Infinity;
  for (const ball of balls) {
    if (!ball.alive) continue;
    // Your own ball is not swattable, which is the rule that makes the owner
    // flip mean anything: without it a player could bat their own throw down the
    // street in front of them, and a rally would be a solo activity.
    if (ball.owner === swinger.id) continue;
    const plan = swingCatches(swinger, rewindBall(ball, back, dt, scratch), dt);
    if (plan < 0 || plan >= bestPlan) continue;
    best = ball;
    bestPlan = plan;
  }
  if (best === null) return null;
  applySwat(swinger, best);
  return best;
}

// --- The self-check ----------------------------------------------------------------

const STEP_DT = 1 / 60;

/**
 * The five claims about this mechanic that fail silently.
 *
 * `verifyFooty`'s rule, one weapon over: a check exists where the failure
 * renders, does not throw, and reads as a taste decision. All five do, and the
 * first two are the ones the brief names.
 *
 *   - **The window is wrong.** A swat that fires on the wind-up tick makes the
 *     mechanic untimed -- you press the button when the ball is near and it goes
 *     back, which is not a duel, it is a reflex test with a 250 ms grace period.
 *     A swat that fires on *no* tick is a feature that silently does not exist,
 *     because a ball that is not deflected simply carries on and looks exactly
 *     like a miss.
 *   - **The owner does not flip.** The quietest failure of the lot: everything
 *     looks right, the ball comes back, and it passes through the person who
 *     threw it because `stepFooty` still has them down as immune. Nothing on
 *     screen says why.
 *   - **The return does not go where you are looking.** A reflection with no aim
 *     term sends a crossing ball onward almost unchanged, which reads as the
 *     swing having missed. There is no frame that distinguishes "deflected by 3
 *     degrees" from "not deflected".
 *   - **The rally does not decay**, or worse, accelerates. An aim term added
 *     rather than steered raises the speed every exchange, and the symptom is not
 *     a fast ball -- it is `protocol.BALL_BYTES`' i8 clipping at 63.5 m/s and the
 *     renderer curving the interpolation the wrong way.
 *   - **The reach disagrees with the bat.** A swat that reaches past the swing's
 *     own `REACH` is the magnet `hitTest`'s header exists to prevent, arriving
 *     through the back door.
 *
 *     bun -e "import {verifySwat} from './client/src/game/swat.ts';
 *             console.log(verifySwat())"
 */
export function verifySwat(): string[] {
  const failures: string[] = [];
  const scratch = createBallAt();

  // --- 1. THE WINDOW. A ball scripted straight at a swinger is deflected on an
  // ACTIVE tick and untouched on a WIND-UP tick, with nothing else different
  // between the two runs.
  //
  // The two runs share a builder so the only difference between them is the
  // phase, which is what makes this a test of the window rather than of two
  // scenarios that happen to disagree.
  {
    const run = (phase: 'windup' | 'active'): { swatted: boolean; owner: number; vz: number } => {
      const swinger = makeSwinger(7, 0, 0, phase);
      // Dead ahead at 1.2 m -- inside `REACH` -- coming straight back at the
      // swinger at a level throw's speed.
      const ball = makeBall(1, 99, 0, swinger.body.position.y, -1.2, 0, 0, 30);
      const hit = swatBalls(swinger, [ball], STEP_DT, 0, scratch);
      return { swatted: hit !== null, owner: ball.owner, vz: ball.vz };
    };
    const active = run('active');
    const windup = run('windup');
    if (!active.swatted) {
      failures.push(
        'A ball arriving dead ahead at 1.2 m was not swatted on an ACTIVE tick. The whole ' +
          'mechanic is missing and a player would read it as the ball passing through the bat.',
      );
    }
    if (windup.swatted) {
      failures.push(
        'A ball was swatted during the WIND-UP. The timing window is the ACTIVE phase only -- ' +
          `${(0.1 * 1000).toFixed(0)} ms of a 500 ms swing -- and widening it is the difference ` +
          'between a duel and a reflex test.',
      );
    }
    // ...and the owner flipped on the one that landed, and only on that one.
    if (active.swatted && active.owner !== 7) {
      failures.push(
        `A swatted ball is still owned by ${active.owner} rather than by the swinger. A returned ` +
          'ball that cannot hit the person who threw it is the mechanic not working, and it ' +
          'looks identical to the ball simply missing them.',
      );
    }
    if (windup.owner !== 99) {
      failures.push('A ball that was not swatted changed hands anyway.');
    }
    // The ball was coming at +z (toward the swinger at the origin from -z, so
    // travelling in +z); a swat from a swinger looking down -z sends it back.
    if (active.swatted && active.vz >= 0) {
      failures.push(
        `A swatted head-on ball left with vz ${active.vz.toFixed(1)}; it arrived at +30 and the ` +
          'swinger was looking down -z, so it has not been sent back at all.',
      );
    }
  }

  // --- 2. IT GOES WHERE YOU ARE LOOKING. Swept over the angle the ball arrives
  // at, because the head-on case is the easy one and the crossing case is the
  // one the aim term exists for.
  {
    const worst: string[] = [];
    for (const degrees of [0, 30, 60, 90, 135]) {
      const a = (degrees * Math.PI) / 180;
      const swinger = makeSwinger(7, 0, 0, 'active');
      // A ball 1.0 m ahead of the swinger, travelling at `degrees` off head-on.
      const ball = makeBall(
        1, 99,
        0, swinger.body.position.y, -1.0,
        Math.sin(a) * 30, 0, Math.cos(a) * 30,
      );
      if (swatBalls(swinger, [ball], STEP_DT, 0, scratch) === null) {
        worst.push(`${degrees} deg (not swatted)`);
        continue;
      }
      // The swinger looks down -z, so a perfect return is (0, 0, -1).
      const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz);
      const off = Math.acos(Math.max(-1, Math.min(1, -ball.vz / speed))) * (180 / Math.PI);
      if (off > 55) worst.push(`${degrees} deg -> ${off.toFixed(0)} deg off aim`);
    }
    if (worst.length > 0) {
      failures.push(
        `A swat sent the ball a long way from where the swinger was looking: ${worst.join(', ')}. ` +
          'The suggestion this implements is a *counter-throw*; a deflection that does not go ' +
          'back down the crosshair reads as the swing having missed.',
      );
    }
  }

  // --- 3. THE RALLY DECAYS, AND NEVER CLIPS THE WIRE.
  //
  // Ten exchanges between two players facing each other, which is far more than
  // anybody will play and is the case that would overflow `BALL_BYTES` if the aim
  // term were added rather than steered.
  {
    const ball = makeBall(1, 99, 0, 1.48, -1.0, 0, 0, 42);
    let fastest = 0;
    let speed = 42;
    for (let i = 0; i < 10; i++) {
      const swinger = makeSwinger(i % 2 === 0 ? 7 : 8, 0, 0, 'active');
      // Alternating: each swinger faces the ball, so the return is a real one.
      swinger.body.yaw = i % 2 === 0 ? 0 : Math.PI;
      applySwat(swinger, ball);
      speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz);
      for (const v of [ball.vx, ball.vy, ball.vz]) fastest = Math.max(fastest, v < 0 ? -v : v);
    }
    if (speed > 42 * 0.5) {
      failures.push(
        `Ten exchanges left the ball at ${speed.toFixed(1)} m/s from 42. At ` +
          `${SWAT_SPEED_SCALE} a rally has to decay, or two players can keep one ball alive ` +
          `until footy.LIFETIME kills it.`,
      );
    }
    if (fastest > 60) {
      failures.push(
        `A rally reached ${fastest.toFixed(1)} m/s on one axis. protocol.BALL_BYTES carries ` +
          `velocity as an i8 of half-metres a second, so anything over 63.5 clips -- which is ` +
          `what an aim term added to the reflection rather than steered into it produces.`,
      );
    }
    // And the very first return is exactly the fraction it claims to be.
    const one = makeBall(1, 99, 0, 1.48, -1.0, 0, 0, 42);
    applySwat(makeSwinger(7, 0, 0, 'active'), one);
    const after = Math.sqrt(one.vx * one.vx + one.vy * one.vy + one.vz * one.vz);
    if (Math.abs(after - 42 * SWAT_SPEED_SCALE) > 1e-6) {
      failures.push(
        `A 42 m/s ball came back at ${after.toFixed(2)} m/s; ${SWAT_SPEED_SCALE} of it is ` +
          `${(42 * SWAT_SPEED_SCALE).toFixed(2)}. The outgoing speed must not depend on the angle.`,
      );
    }
  }

  // --- 4. THE REACH IS THE BAT'S. Swept out from the swinger a centimetre at a
  // time: everything inside the reach connects and nothing past it does.
  //
  // The failure this catches is `hitTest`'s own, arriving through a door that
  // check cannot see: a sweep with no plan gate first touches a ball 2.14 m away,
  // which is a bat that swats a football out of the air from across a footpath.
  {
    let furthest = -1;
    let nearestMiss = Infinity;
    for (let range = 0.4; range < 3.0; range += 0.01) {
      const swinger = makeSwinger(7, 0, 0, 'active');
      const ball = makeBall(1, 99, 0, swinger.body.position.y, -range, 0, 0, 0.0001);
      if (swatBalls(swinger, [ball], STEP_DT, 0, scratch) !== null) furthest = range;
      else if (range > 0.4) nearestMiss = Math.min(nearestMiss, range);
    }
    if (furthest > REACH + 0.01) {
      failures.push(
        `A stationary ball ${furthest.toFixed(2)} m dead ahead was swatted, past the bat's ` +
          `${REACH.toFixed(2)} m reach. That is the magnet combat.hitTest's plan-distance gate ` +
          `exists to prevent, reached through the ball test instead.`,
      );
    }
    if (furthest < REACH - 0.15) {
      failures.push(
        `A ball is only swattable out to ${furthest.toFixed(2)} m against a bat that reaches ` +
          `${REACH.toFixed(2)}. A swing that visibly sweeps through a football and does not ` +
          `touch it reads as lag.`,
      );
    }
  }

  // --- 5. THE REWIND. A ball run forward `n` ticks and then rewound by the same
  // interval lands back where it started, which is the property the whole
  // lag-compensation claim rests on.
  //
  // Compared against a *forward* integration of the same arithmetic rather than
  // against a stored path, because that is exactly the class of error this can
  // have: a sign flipped on the gravity term is a rewind that puts the ball a
  // metre and a half *below* where the swinger saw it, and the only symptom is
  // that swats near the top of a lob mysteriously miss.
  {
    const back = 0.25;
    const ball = makeBall(1, 99, 3, 12, -20, 4, 6, -14);
    // Forward, semi-implicit, exactly as `stepFooty` integrates -- gravity onto
    // the velocity first, then the position.
    const steps = Math.round(back / STEP_DT);
    const start = { x: ball.x, y: ball.y, z: ball.z };
    for (let i = 0; i < steps; i++) {
      ball.vy += GRAVITY * STEP_DT;
      ball.x += ball.vx * STEP_DT;
      ball.y += ball.vy * STEP_DT;
      ball.z += ball.vz * STEP_DT;
    }
    rewindBall(ball, steps * STEP_DT, STEP_DT, scratch);
    const off = Math.sqrt(
      (scratch.x - start.x) ** 2 + (scratch.y - start.y) ** 2 + (scratch.z - start.z) ** 2,
    );
    // A millimetre. The inverse is exact against `stepFooty`'s integrator --
    // see `rewindBall`'s algebra, including the half-tick term that is 4.7 cm at
    // this interval and is the whole reason `dt` is a parameter -- so anything
    // this catches is a real error rather than an accumulated one. The tolerance
    // is float noise over 15 steps and nothing else.
    if (off > 0.001) {
      failures.push(
        `A ball flown ${back} s and rewound by ${back} s came back ${(off * 100).toFixed(1)} cm ` +
          `from where it started. rewindBall's gravity term is wrong, and the symptom is swats ` +
          `that miss balls the swinger could see the bat going through.`,
      );
    }
  }

  return failures;
}

/**
 * A combatant mid-swing, for the checks above.
 *
 * Hand-built on `footy.makeTarget`'s argument exactly: this module is compiled
 * into the browser and into the Bun server and its check has to run in both,
 * and `combat.createCombatant` reaches through `player/controller.ts` into three
 * for a `Vector3`. What a swinger needs here is a position, a look and a phase.
 *
 * The eye is at `EYE_HEIGHT` above the feet, which matters: the cast starts at
 * the eye and a ball scripted at ground level would be tested against a bat
 * swung a metre and a half over it.
 */
function makeSwinger(id: number, x: number, z: number, phase: 'windup' | 'active'): CombatantState {
  return {
    id,
    body: {
      position: { x, y: 1.48, z },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: true,
      yaw: 0,
      pitch: 0,
    },
    health: 3,
    phase,
    phaseT: 0.02,
  } as unknown as CombatantState;
}

/** A ball in flight, for the checks above. `footy.createFooty` with the fields filled. */
function makeBall(
  id: number, owner: number,
  x: number, y: number, z: number,
  vx: number, vy: number, vz: number,
): Footy {
  return { id, thrower: owner, owner, x, y, z, vx, vy, vz, age: 0.2, bounces: 0, alive: true };
}
