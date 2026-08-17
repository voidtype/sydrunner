/**
 * Where your own two hands are, frame by frame, when you are holding nothing.
 *
 * *"i cant see my hands while punching"*, and the report is exactly right: slot
 * 4 is `phone.SLOT.FISTS`, and with fists equipped this game drew **no
 * first-person viewmodel at all**. The bat has one (`player/bat.ts`), the
 * football has one (`world/footyball.ts`), the phone has one
 * (`world/phone.ts`); the fist -- which is the weapon spec 8.2 shipped with and
 * which is still one number-row press away -- had nothing. A punch was a
 * hitstop, a sound and a health bar moving on somebody else.
 *
 * This module is the **arithmetic** half of the fix and `player/hands.ts` is the
 * geometry. The split is the one `game/bikes.ts` and `world/bike.ts` established
 * and the reason here is the usual one: a pose is a pure function of a phase and
 * a clock, so it can be checked in a process with no GPU in it, and everything
 * that can be checked that way should be. `verifyHandsPose` runs on the server
 * beside `verifyAnimation`; `verifyHands` runs in the browser and covers the
 * things that need a vertex buffer.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL: TWO HANDS, ONE DRIVE, THE BAT'S OWN CURVE
 *
 * `player/bat.ts` solved this problem once already and solved it well, and the
 * instruction was to mirror it rather than to invent a second timing model. So:
 *
 *   - **One scalar drives everything.** `punchDrive(phase, phaseT)` is -1 fully
 *     coiled, 0 at rest, +1 at the end of the follow-through, and it is
 *     `bat.swingDrive`'s curve with `bat.swingDrive`'s easings. Three
 *     independently authored poses meeting at two phase boundaries is a hand
 *     that jumps a fist's width in one frame, which at 150 ms into a 500 ms
 *     cycle reads as a dropped frame rather than as a bug. A single continuous
 *     parameter cannot do that and `verifyHandsPose` asserts it.
 *   - **Three keys per hand**, blended linearly in the drive, because every
 *     easing already lives in the drive. Two hands and three keys is six poses,
 *     which is the whole animation.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TWO HANDS DO DIFFERENT THINGS
 *
 * The brief's instruction is *"the primary hand jabs, the off hand guards"*, and
 * that is not decoration -- it is what makes a first-person punch legible at all.
 *
 * A jab travels almost straight down the view axis, so the *only* thing that
 * changes on screen is the hand's apparent size: it starts small at the bottom
 * of the frame and ends large in the middle, over about 100 ms. That is a very
 * weak read, and it is the reason so many games give the punch a hook. What
 * fixes it here without turning a jab into a haymaker is the **other** hand:
 * the off hand rises into a guard on the wind-up and stays there, so the frame
 * has one thing moving toward the camera and one thing holding still beside it,
 * and the eye gets the parallax it needs to see the first one travel.
 *
 * The off hand's guard also solves the resting frame. One hand at the bottom
 * right of the screen is a floating fist; two hands, asymmetrically placed,
 * read as a person.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 *
 * **No inverse kinematics and no elbow.** A forearm is drawn (see
 * `player/hands.ts`) but it is rigidly attached to the mitt and runs back toward
 * the bottom corner of the frame; there is no shoulder in the model and no joint
 * to solve. A viewmodel arm is on screen for 100 ms at a time and the two
 * failure modes of a solved elbow -- a pop at the singularity and a forearm
 * through the camera -- are both worse than the thing being solved.
 *
 * **No separate `flinch` or `ko` pose.** The hands drop out of frame entirely on
 * a knockout, which is `BatViewmodel`'s own rule for its own reason: a
 * viewmodel left in frame over a camera lying on the pavement is the loudest
 * possible way of saying the viewmodel does not know what the game is doing.
 * `flinch` rests, because a flinch is 120 ms and the camera shake already sells
 * it.
 */

import { PUNCH_ACTIVE, PUNCH_RECOVERY, PUNCH_WIND_UP } from '../player/animation.ts';

/**
 * The phases these poses read. `combat.CombatPhase`'s set, restated rather than
 * imported for `bat.SwingPhase`'s stated reason: this module can then be driven
 * by a check with no combatant in hand.
 */
export type HandPhase = 'idle' | 'windup' | 'active' | 'recovery' | 'flinch' | 'ko';

/**
 * Where the punch is, as one number. -1 coiled, 0 at rest, +1 followed through.
 *
 * **`bat.swingDrive`'s curve, restated rather than imported**, and the
 * duplication is deliberate on `bat.MEASURED_REACH_TARGET`'s standing argument
 * one file over. Importing it would couple the fist viewmodel to the bat
 * module -- which drags `three` into this file through `bat.ts`'s import list
 * and destroys the whole reason this module exists. Written out, the two are
 * allowed to be retimed independently, and `verifyHandsPose` pins the shape
 * rather than the identity: continuous at both boundaries, monotone through
 * each window, zero at rest.
 *
 * The one substantive difference from the bat's is the **overshoot**. The bat
 * multiplies its strike by 1.85 so the blade sweeps well past the rest pose on
 * a follow-through; a fist does not follow through, it *snaps back*, so this
 * reaches +1 and stops. A jab that carried 85% past its own extension would put
 * the mitt through the far wall of the frame, and the recovery is what returns
 * it -- see below.
 */
export function punchDrive(phase: HandPhase, phaseT: number): number {
  if (phase === 'windup') {
    // `t^0.6`: most of the coil in the first half of the window, so the fist is
    // *waiting* at the back of the chamber rather than travelling backwards for
    // the whole 150 ms. `animation.punchPose`'s easing exactly.
    return -Math.pow(clamp01(phaseT / PUNCH_WIND_UP), 0.6);
  }
  if (phase === 'active') {
    // `t^0.45`: the fist is 70% of the way out in the first 30 of its 100 ms,
    // which is what a jab is. A linear strike reads as a push.
    return -1 + 2 * Math.pow(clamp01(phaseT / PUNCH_ACTIVE), 0.45);
  }
  if (phase === 'recovery') {
    // A damped oscillator that crosses rest once and settles just behind it.
    // Faster and tighter than the bat's (5.6/6.2 against 4.2/5.0) because a
    // hand has a tenth of a bat's moment: the wobble is a knuckle settling, not
    // a length of willow carrying past its stopping point.
    //
    // **Amplitude 1 and not the bat's 0.85**, which is the one place the two
    // curves genuinely could not be copied: the bat's strike overshoots to
    // +0.85 and its recovery therefore starts there, where a jab reaches +1 and
    // the recovery has to start at +1 or the hand teleports back a fist's width
    // on the frame the active window ends. `verifyHandsPose` drives exactly that
    // boundary and it is how this was found.
    const t = clamp01(phaseT / PUNCH_RECOVERY);
    return Math.exp(-5.6 * t) * Math.cos(6.2 * t);
  }
  return 0;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * One hand's pose: where the mitt is in camera space, and how it is turned.
 *
 * Camera space is three's: **-Z forward, +X right, +Y up**, metres from the eye.
 * `rot` is an Euler XYZ applied about the mitt, on `bat.ViewKey`'s convention --
 * three composes XYZ as `Rx * Ry * Rz`, so Z is applied first and X last.
 */
export interface HandPose {
  readonly at: readonly [number, number, number];
  readonly rot: readonly [number, number, number];
}

/** Both hands this frame. */
export interface HandsPose {
  /** The hand that throws the punch. The right one, for everybody. */
  readonly primary: HandPose;
  /** The hand that guards. The left. */
  readonly off: HandPose;
}

/*
 * The six keys.
 *
 * Every number below is in metres from the eye and was set against three
 * constraints rather than by taste, all of which `verifyHandsPose` asserts:
 *
 *   1. **Nothing may sit on the reticle at rest.** `bat.RETICLE_CLEARANCE` is
 *      0.10 rad and the same floor applies here. The resting hands are low and
 *      wide for exactly this reason.
 *   2. **Nothing may leave the frame's near field.** `bat.MAX_VIEW_REACH` is
 *      0.90 m, set as a wall-clipping budget; a hand is smaller than a bat and
 *      gets 0.75.
 *   3. **The strike has to be visibly bigger than the rest.** The whole report
 *      is that a punch was invisible, so the primary mitt has to travel far
 *      enough down the view axis that its screen size changes -- see
 *      `verifyHandsPose`'s "the jab is visible" case, which measures the ratio.
 */

/**
 * Primary at rest: low right, knuckles forward, most of the forearm off frame.
 *
 * 0.28 m from the eye and 24 cm below the axis, which at this project's
 * 72-degree vertical field puts the mitt about 38 degrees down -- just inside
 * the bottom of the frame, so what a player sees at rest is knuckles rising
 * into the corner and not an arm. That is the same read `bat.REST_KEY` is set
 * for and it is the read a viewmodel wants when there is no body modelled to go
 * with it.
 */
const PRIMARY_REST: HandPose = { at: [0.19, -0.24, -0.28], rot: [0.28, -0.22, 0.1] };
/**
 * Primary coiled: back and in, toward the chin, turned palm-in.
 *
 * The chamber. It comes *back* along +Z rather than dropping, because a jab is
 * loaded at the shoulder and not at the hip -- and because retracting toward
 * the camera is the one direction that guarantees the strike's travel is
 * visible as a size change. 0.15 m from the eye is as close as anything in this
 * viewmodel comes, and is inside the near plane's business but well inside the
 * budget.
 */
const PRIMARY_COIL: HandPose = { at: [0.21, -0.19, -0.15], rot: [0.1, -0.5, 0.16] };
/**
 * Primary struck: out and in toward the centre line, knuckles square on.
 *
 * -0.58 m is more than twice the rest pose's forward reach, so the mitt roughly doubles
 * on screen over the 100 ms of the active window -- which is the whole of what
 * makes the punch readable. It comes in to x = 0.055 rather than to 0, because a
 * fist that ends exactly on the crosshair covers the thing the player is aiming
 * with at the moment they most want to see it.
 */
const PRIMARY_STRIKE: HandPose = { at: [0.055, -0.1, -0.58], rot: [-0.06, -0.02, 0.02] };

/**
 * Off hand at rest: low left, lower and further out than the primary.
 *
 * Asymmetric on purpose. Two mitts at mirrored heights read as a pair of
 * objects bolted to the camera; one high and one low reads as a person standing
 * side-on, which is how anybody holds their hands when they are about to hit
 * somebody.
 */
const OFF_REST: HandPose = { at: [-0.21, -0.27, -0.28], rot: [0.34, 0.26, -0.12] };
/**
 * Off hand guarding: up and in, by the cheek.
 *
 * It rises on the **wind-up** and holds through the strike -- which is why the
 * coil and the strike keys below are nearly the same pose. That stillness is
 * the point: it is the fixed reference the moving hand is measured against. A
 * guard that also travelled would leave the frame with two things moving and
 * nothing to compare them to, which is where the original invisible-punch
 * problem came from.
 */
const OFF_GUARD: HandPose = { at: [-0.15, -0.14, -0.24], rot: [0.16, 0.44, -0.2] };
const OFF_STRIKE: HandPose = { at: [-0.155, -0.155, -0.245], rot: [0.2, 0.42, -0.18] };

/**
 * Both hands at a point in the swing.
 *
 * Linear in the drive, because the drive is where every easing already lives --
 * `bat.blendKeys`' argument verbatim. Two `HandPose` records are allocated per
 * call, which is 120 small objects a second at 60 Hz; that is deliberate and is
 * the one place this module spends anything. The alternative is an out-parameter
 * threaded through a pure function, and this is presentation code called once a
 * frame, not the traffic scheduler called four hundred times a tick.
 */
export function handsPose(drive: number): HandsPose {
  const w = Math.min(1, Math.abs(drive));
  const primaryTo = drive < 0 ? PRIMARY_COIL : PRIMARY_STRIKE;
  // The off hand goes to its guard in **both** directions, which is what makes
  // it rise on the wind-up and stay up through the strike. Blending it toward
  // rest on the positive half would drop the guard exactly as the punch landed.
  const offTo = drive < 0 ? OFF_GUARD : OFF_STRIKE;
  return {
    primary: blend(PRIMARY_REST, primaryTo, w),
    off: blend(OFF_REST, offTo, w),
  };
}

function blend(from: HandPose, to: HandPose, w: number): HandPose {
  const at: [number, number, number] = [0, 0, 0];
  const rot: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    at[i] = from.at[i] + (to.at[i] - from.at[i]) * w;
    rot[i] = from.rot[i] + (to.rot[i] - from.rot[i]) * w;
  }
  return { at, rot };
}

/**
 * How far a mitt may ever be from the eye, metres. `bat.MAX_VIEW_REACH`'s job.
 *
 * 0.80 rather than the bat's 0.90, and the smaller number is affordable for the
 * obvious reason -- a fist has no blade on the end of it. What it buys is the
 * same thing: these are ordinary lit objects in the ordinary depth buffer, with
 * no second pass and no cleared depth, and the only thing keeping them out of
 * walls is that they are small and close. A player standing square against a
 * terrace has their eye 0.34 m from it, so *any* viewmodel intersects a wall
 * they are touching; the budget stops it happening a metre out.
 */
export const HANDS_MAX_REACH = 0.8;

/** The half-angle around the view axis the **rest** pose must clear. `bat.RETICLE_CLEARANCE`. */
export const HANDS_RETICLE_CLEARANCE = 0.1;

// --- The self-check ---------------------------------------------------------------

/**
 * The drive curve and the six keys, asserted without a renderer.
 *
 * Every failure renders rather than throws:
 *
 *   - **A discontinuous drive.** A hand that jumps a fist's width in one frame
 *     at a phase boundary. Reads as a dropped frame.
 *   - **A non-monotone window.** A wind-up that un-coils halfway, or a strike
 *     that pauses. Reads as network stutter.
 *   - **A punch that does not visibly travel.** The whole report. A key set
 *     where the strike is 10 cm further out than the rest looks *fine* in a
 *     still and is invisible in motion, which is exactly how this got shipped
 *     with no hands at all.
 *   - **A hand on the reticle at rest.** A complaint rather than a bug.
 *   - **A hand past the near budget.** Clipping through the wall you are
 *     standing against.
 *
 * Three-free, and run on both ends:
 *
 *     bun -e "import {verifyHandsPose} from './client/src/game/hands-pose.ts'; console.log(verifyHandsPose())"
 */
export function verifyHandsPose(): string[] {
  const failures: string[] = [];

  // --- Continuity across both phase boundaries.
  {
    const boundaries: Array<[string, number, HandPhase, HandPhase]> = [
      ['wind-up to active', PUNCH_WIND_UP, 'windup', 'active'],
      ['active to recovery', PUNCH_ACTIVE, 'active', 'recovery'],
    ];
    for (const [label, endT, from, to] of boundaries) {
      const before = punchDrive(from, endT);
      const after = punchDrive(to, 0);
      if (Math.abs(before - after) > 1e-6) {
        failures.push(
          `The punch jumps ${(after - before).toFixed(3)} at the ${label} boundary. A discontinuity ` +
            `there is a hand that moves a fist's width in one frame and reads as a dropped frame.`,
        );
      }
    }
  }

  // --- Monotone through each window, and at rest when nothing is happening.
  {
    let worstUncoil = 0;
    let worstBackward = 0;
    let coil = punchDrive('windup', 0);
    let strike = punchDrive('active', 0);
    for (let i = 1; i <= 64; i++) {
      const c = punchDrive('windup', (i / 64) * PUNCH_WIND_UP);
      if (c > coil) worstUncoil = Math.max(worstUncoil, c - coil);
      coil = c;
      const s = punchDrive('active', (i / 64) * PUNCH_ACTIVE);
      if (s < strike) worstBackward = Math.max(worstBackward, strike - s);
      strike = s;
    }
    if (worstUncoil > 1e-9) failures.push(`The wind-up un-coils by ${worstUncoil.toFixed(4)} partway through. It must only pull back.`);
    if (worstBackward > 1e-9) failures.push(`The jab moves backwards by ${worstBackward.toFixed(4)} partway through. It must only go out.`);
    for (const phase of ['idle', 'flinch', 'ko'] as HandPhase[]) {
      if (Math.abs(punchDrive(phase, 0.2)) > 1e-9) failures.push(`The hands are not at rest in the "${phase}" phase.`);
    }
    // The two ends of the swing are the two ends of the range, or the keys below
    // are being blended to a fraction of themselves and every pose is wrong by
    // the same amount -- which looks like a tuning problem rather than a bug.
    if (Math.abs(punchDrive('windup', PUNCH_WIND_UP) + 1) > 1e-6) {
      failures.push(`Fully wound up the drive is ${punchDrive('windup', PUNCH_WIND_UP).toFixed(3)}, not -1.`);
    }
    if (Math.abs(punchDrive('active', PUNCH_ACTIVE) - 1) > 1e-6) {
      failures.push(`At full extension the drive is ${punchDrive('active', PUNCH_ACTIVE).toFixed(3)}, not +1.`);
    }
    // And the recovery ends within a hair of rest, so the hand does not settle
    // into a pose that is not the one it starts the next punch from.
    const settled = punchDrive('recovery', PUNCH_RECOVERY);
    if (Math.abs(settled) > 0.06) {
      failures.push(`The recovery settles at ${settled.toFixed(3)} rather than back at rest.`);
    }
  }

  // --- The jab visibly travels. The whole report, as a number.
  {
    const rest = handsPose(0).primary;
    const out = handsPose(1).primary;
    const restZ = -rest.at[2];
    const outZ = -out.at[2];
    if (!(outZ > restZ * 1.8)) {
      failures.push(
        `The jab takes the primary mitt from ${restZ.toFixed(2)} m to ${outZ.toFixed(2)} m from the eye ` +
          `-- ${(outZ / restZ).toFixed(2)}x. A jab travels almost straight down the view axis, so its ` +
          `apparent size is the only thing that changes; under about 1.8x the punch is invisible, which ` +
          `is the report this viewmodel exists for.`,
      );
    }
    // And it comes in toward the centre line without covering it.
    if (!(Math.abs(out.at[0]) < Math.abs(rest.at[0]))) {
      failures.push('The jab does not come in toward the centre of the frame; it is a punch thrown sideways.');
    }
    if (Math.abs(out.at[0]) < 0.03) {
      failures.push(`The struck mitt is ${Math.abs(out.at[0]).toFixed(3)} m off the view axis; it is on the crosshair.`);
    }
  }

  // --- The off hand guards: it rises on the wind-up and holds through the
  //     strike. Both halves, because a guard that dropped at the moment of
  //     impact removes the only fixed thing in the frame.
  {
    const rest = handsPose(0).off;
    const guard = handsPose(-1).off;
    const struck = handsPose(1).off;
    if (!(guard.at[1] > rest.at[1] + 0.05)) {
      failures.push(`The off hand rises ${((guard.at[1] - rest.at[1]) * 100).toFixed(1)} cm into its guard; that is not a guard.`);
    }
    const drift = Math.hypot(struck.at[0] - guard.at[0], struck.at[1] - guard.at[1], struck.at[2] - guard.at[2]);
    if (drift > 0.06) {
      failures.push(
        `The off hand moves ${(drift * 100).toFixed(1)} cm between the coil and the strike. It is the ` +
          `still thing the moving hand is read against; see this file's header.`,
      );
    }
    // Opposite sides of the frame, always. Two hands on one side is a person
    // with a shoulder injury.
    for (const d of [-1, -0.5, 0, 0.5, 1]) {
      const p = handsPose(d);
      if (!(p.primary.at[0] > 0 && p.off.at[0] < 0)) {
        failures.push(`At drive ${d} the hands are at x=${p.primary.at[0].toFixed(2)} and ${p.off.at[0].toFixed(2)}; they must straddle the centre.`);
        break;
      }
    }
  }

  // --- The budget and the reticle, on the mitt positions alone. The geometry's
  //     own extent is `player/hands.verifyHands`' job; this is the placement.
  {
    for (let i = -20; i <= 20; i++) {
      const p = handsPose(i / 20);
      for (const [which, hand] of [['primary', p.primary], ['off', p.off]] as Array<[string, HandPose]>) {
        const reach = Math.hypot(hand.at[0], hand.at[1], hand.at[2]);
        // 0.15 m of slack for the mitt's own radius and the forearm behind it,
        // which `verifyHands` measures properly with a vertex buffer in hand.
        if (reach > HANDS_MAX_REACH - 0.15) {
          failures.push(
            `At drive ${(i / 20).toFixed(2)} the ${which} mitt's centre is ${reach.toFixed(2)} m from the ` +
              `eye, leaving under 15 cm of the ${HANDS_MAX_REACH} m budget for the hand itself.`,
          );
          break;
        }
      }
    }
    const rest = handsPose(0);
    for (const [which, hand] of [['primary', rest.primary], ['off', rest.off]] as Array<[string, HandPose]>) {
      const forward = -hand.at[2];
      const angle = Math.atan2(Math.hypot(hand.at[0], hand.at[1]), forward);
      if (angle < HANDS_RETICLE_CLEARANCE) {
        failures.push(
          `At rest the ${which} mitt is ${(angle * (180 / Math.PI)).toFixed(1)} degrees off the view ` +
            `axis; it must clear ${(HANDS_RETICLE_CLEARANCE * (180 / Math.PI)).toFixed(1)}. It is on the reticle.`,
        );
      }
    }
  }

  // --- And the pose is continuous in the drive, which is the property that
  //     makes the single scalar worth having: no step anywhere across the range,
  //     including at zero where the blend swaps which key it is heading for.
  {
    let worst = 0;
    let previous = handsPose(-1);
    for (let i = -199; i <= 200; i++) {
      const p = handsPose(i / 200);
      for (const [a, b] of [[previous.primary, p.primary], [previous.off, p.off]] as Array<[HandPose, HandPose]>) {
        worst = Math.max(worst, Math.hypot(b.at[0] - a.at[0], b.at[1] - a.at[1], b.at[2] - a.at[2]));
      }
      previous = p;
    }
    // A two-hundredth of the drive should never move a hand more than a
    // centimetre; the largest key-to-key travel is under half a metre.
    if (worst > 0.01) {
      failures.push(`The pose steps ${(worst * 100).toFixed(2)} cm for a 0.5% change in the drive. There is a discontinuity in the blend.`);
    }
  }

  return failures;
}
