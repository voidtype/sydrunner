/**
 * The breath every viewmodel in this game shares, as one function.
 *
 * Two objects hang off the camera -- the cricket bat in `player/bat.ts` and the
 * football in `world/footyball.ts` -- and both of them need the same small thing:
 * when the player is standing still, the thing in their hand must not be
 * *perfectly* still. A viewmodel frozen to the pixel reads as a decal painted on
 * the frame rather than as an object being held, and the fix every game uses is a
 * slow drift of a few millimetres on two periods that do not divide each other,
 * so the motion never repeats visibly and never looks like a loop.
 *
 * ---------------------------------------------------------------------------
 * Why it is a file rather than four lines copied twice.
 *
 * Because it *was* four lines copied twice, and they had already drifted. The bat
 * breathed on 0.71 and 0.94 Hz at 6 mm and 8 mm; the ball breathed on 0.67 and
 * 0.91 Hz at 7 mm and 9 mm. Nobody chose that difference -- the second one was
 * written from memory of the first -- and the consequence is visible in exactly
 * the situation the drift is least excusable: **both objects are on screen at the
 * same time**, one in each corner, and two nearly-equal periods beat against each
 * other. The hands appear to breathe in and out of phase over about thirty
 * seconds, which is the one artefact a "subtle" idle motion can produce that is
 * worse than no motion at all.
 *
 * So the numbers live here once, the two viewmodels call this, and
 * `verifyViewmodelIdle` plus each file's own check assert that what they apply is
 * what this returns. The owner's instruction that started this round --
 * *"make it idle breathe like the bat"* about the football -- is therefore a
 * property of the code rather than a pair of matching literals somebody has to
 * keep matching.
 *
 * The bat's numbers won, because the bat is the object the player looks at for
 * most of the session and because they were the first ones written down.
 *
 * ---------------------------------------------------------------------------
 * The shape, and the three properties the callers rely on.
 *
 *   1. **It is zero at a run.** The `1 - gait` factor is not a taste: at speed
 *      the bob and the sway are metres-per-second-scale motion and a 6 mm drift
 *      underneath them is noise on top of signal. It also means a caller can add
 *      this unconditionally without a branch.
 *   2. **It is bounded by `IDLE_MAX_M`.** Both viewmodels are checked against a
 *      reach budget -- 0.90 m from the eye, the claim that lets them be drawn in
 *      the ordinary depth buffer rather than in a second pass -- and a term added
 *      to a pose has to be small enough that it cannot be what breaks it.
 *   3. **It is a pure function of `(clock, gait)`.** No state, no `dt`, no
 *      history, which is what makes the checks in `bat.ts` and `footyball.ts`
 *      able to step a viewmodel with `dt = 0` and compare an exact pose. It is
 *      also the rule `game/footy.ts` and `game/traffic.ts` state about ambient
 *      motion generally: a thing nobody sends is a function of the clock.
 *
 * Deliberately **three-free** -- the offset is written into a caller-owned pair of
 * numbers rather than a `Vector3` -- so `verifyViewmodelIdle` runs in the Bun
 * server's boot list as well as the browser's. There is nothing about a hand's
 * breathing the server needs to know; what it is doing there is the repo's rule
 * about shared arithmetic (`game/riding.ts` section 2, `verifyGangway`'s header):
 * a number two files agree about is checked in both runtimes, and this one costs
 * microseconds to check.
 */

/**
 * The two periods, in Hz, and why they are these.
 *
 * 0.71 and 0.94 are close to a breath and a slow shift of weight, and -- more
 * importantly -- their ratio is 1.324, which is irrational enough at this
 * precision that the figure-eight the pair traces does not close inside a minute.
 * Two frequencies that *do* divide each other (0.7 and 1.4, say) trace a fixed
 * Lissajous figure the eye learns in a few seconds, at which point the motion
 * reads as a machine rather than as a hand.
 *
 * The phase offset on Y exists for the same reason: with both terms starting at
 * zero the first second of every session is a straight diagonal drift, which is
 * the one part of the loop that looks authored.
 */
export const IDLE_X_RATE = 0.71;
export const IDLE_Y_RATE = 0.94;
export const IDLE_Y_PHASE = 1.3;
/** Amplitudes in metres. Six and eight millimetres at half a metre from the eye. */
export const IDLE_X_AMP = 0.006;
export const IDLE_Y_AMP = 0.008;
/**
 * The most this can ever move a viewmodel, metres, in either axis.
 *
 * Stated as its own constant rather than derived, so it is a *budget* a caller
 * can quote: `verifyBat` and `verifyFootyBall` both assert their whole viewmodel
 * stays inside 0.90 m of the eye, and this is the part of that number the idle is
 * allowed to spend. See `verifyViewmodelIdle`, which asserts the amplitudes are
 * inside it rather than assuming they are.
 */
export const IDLE_MAX_M = 0.012;

/** Where the offset is written. A caller owns one of these forever; see the header. */
export interface IdleSway {
  x: number;
  y: number;
}

/**
 * The idle offset for this frame, in metres, in the viewmodel's own camera space.
 *
 * `clock` is wall-clock seconds since the viewmodel was created -- frozen during
 * hitstop by both callers, which is why it is passed in rather than kept here.
 * `gait` is 0 standing still and 1 at a sprint, and is the caller's own
 * `min(1, speed / 8.2)`.
 *
 * Written into `out` rather than returned as a fresh object because this runs
 * twice a frame for the life of the session and `server/sim.ts`'s allocation rule
 * is the house style even where the pressure is only a browser's.
 */
export function viewmodelIdle(clock: number, gait: number, out: IdleSway): IdleSway {
  // Clamped rather than trusted: `speed / 8.2` is the caller's, and a negative
  // gait from a bad speed would *amplify* the drift instead of damping it.
  const rest = 1 - (gait < 0 ? 0 : gait > 1 ? 1 : gait);
  out.x = Math.sin(clock * IDLE_X_RATE) * IDLE_X_AMP * rest;
  out.y = Math.sin(clock * IDLE_Y_RATE + IDLE_Y_PHASE) * IDLE_Y_AMP * rest;
  return out;
}

/**
 * The breath itself, asserted. Every failure below renders.
 *
 *   - **A drift that does not stop at a run.** The bob is 26 mm and this is 6;
 *     added on top of a sprint it is noise, and it is the kind of noise that
 *     reads as a frame-rate problem rather than as an animation.
 *   - **A drift that is not small.** Both viewmodels' reach budgets are the
 *     reason they can be drawn in the ordinary depth buffer, and a term that grew
 *     to a hand's width would be spending somebody else's margin.
 *   - **Two periods that divide each other**, which is a closed Lissajous figure
 *     the eye learns and then reads as a machine. Asserted as a ratio rather than
 *     admired in a comment.
 *   - **A function of anything but `(clock, gait)`.** Both files' checks step
 *     their viewmodel with `dt = 0` and compare exact poses, which only works
 *     while this is pure; a cached last-value here would make those checks lie.
 *
 *     bun -e "import {verifyViewmodelIdle} from './client/src/player/viewmodel-idle.ts';
 *             console.log(verifyViewmodelIdle())"
 */
export function verifyViewmodelIdle(): string[] {
  const failures: string[] = [];
  const out: IdleSway = { x: 0, y: 0 };

  // --- Zero at a run, and at anything past it, so a caller may add it blind.
  for (const gait of [1, 1.4, 9]) {
    for (let i = 0; i < 8; i++) {
      viewmodelIdle(i * 0.37, gait, out);
      if (Math.abs(out.x) > 1e-12 || Math.abs(out.y) > 1e-12) {
        failures.push(
          `At gait ${gait} the idle drift is still (${out.x.toFixed(4)}, ${out.y.toFixed(4)}) m. It has ` +
            'to be zero at a run, or it is noise on top of a 26 mm bob.',
        );
        break;
      }
    }
  }
  // ...and a bad gait damps rather than amplifies.
  viewmodelIdle(1.0, -3, out);
  const amplified = Math.max(Math.abs(out.x) / IDLE_X_AMP, Math.abs(out.y) / IDLE_Y_AMP);
  if (amplified > 1 + 1e-9) {
    failures.push(
      `A negative gait multiplied the drift by ${amplified.toFixed(1)}. The rest factor has to be ` +
        'clamped, or one bad speed reading throws the viewmodel across the frame.',
    );
  }

  // --- Small, and inside the budget it claims. Swept rather than reasoned about,
  // because the bound of a sum of two sines is only obvious one term at a time.
  {
    let worstX = 0;
    let worstY = 0;
    for (let i = 0; i <= 4000; i++) {
      viewmodelIdle(i * 0.01, 0, out);
      worstX = Math.max(worstX, Math.abs(out.x));
      worstY = Math.max(worstY, Math.abs(out.y));
    }
    if (worstX > IDLE_MAX_M || worstY > IDLE_MAX_M) {
      failures.push(
        `Over 40 s the idle reaches (${(worstX * 1000).toFixed(1)}, ${(worstY * 1000).toFixed(1)}) mm ` +
          `against the ${(IDLE_MAX_M * 1000).toFixed(0)} mm this file budgets. Both viewmodels' ` +
          'reach checks are written against that budget.',
      );
    }
    // And it does actually move, or the two files below are asserting that a
    // pair of zeroes match.
    if (worstX < 0.002 || worstY < 0.002) {
      failures.push(
        `The idle only reaches (${(worstX * 1000).toFixed(1)}, ${(worstY * 1000).toFixed(1)}) mm. Under ` +
          'about 2 mm the viewmodel is frozen and reads as a decal painted on the frame.',
      );
    }
  }

  // --- The two periods do not divide each other. See `IDLE_X_RATE`.
  {
    const ratio = IDLE_Y_RATE / IDLE_X_RATE;
    const nearest = Math.round(ratio * 2) / 2;
    if (Math.abs(ratio - nearest) < 0.05) {
      failures.push(
        `The idle's two rates are ${IDLE_X_RATE} and ${IDLE_Y_RATE} Hz, a ratio of ${ratio.toFixed(3)} ` +
          `-- within 0.05 of ${nearest}. Rates that divide each other trace a figure that closes, and ` +
          'a closed figure is a loop the eye learns in seconds.',
      );
    }
    // Which is the same thing said the other way: the pair must not return to
    // where it started inside a minute of standing still.
    viewmodelIdle(0, 0, out);
    const x0 = out.x;
    const y0 = out.y;
    let repeats = 0;
    for (let i = 1; i <= 6000; i++) {
      viewmodelIdle(i * 0.01, 0, out);
      if (Math.abs(out.x - x0) < 1e-5 && Math.abs(out.y - y0) < 1e-5) repeats++;
    }
    if (repeats > 0) {
      failures.push(
        `The idle returns to its starting offset ${repeats} time(s) in the first minute. It is meant ` +
          'not to close, so the motion never reads as a loop.',
      );
    }
  }

  // --- Pure. The same clock twice is the same answer, and no call changes what
  // the next one returns -- which is what lets `verifyBat` and `verifyFootyBall`
  // step a viewmodel with dt = 0 and compare exact poses.
  {
    const a: IdleSway = { x: 0, y: 0 };
    const b: IdleSway = { x: 0, y: 0 };
    viewmodelIdle(3.25, 0.2, a);
    for (let i = 0; i < 5; i++) viewmodelIdle(i * 1.7, 0.9, b);
    viewmodelIdle(3.25, 0.2, b);
    if (a.x !== b.x || a.y !== b.y) {
      failures.push('viewmodelIdle is not a pure function of (clock, gait); it remembers a call.');
    }
  }

  return failures;
}
