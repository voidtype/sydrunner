/**
 * What the world looks like with mushrooms in you.
 *
 * ---------------------------------------------------------------------------
 * ## The curve is separate from the shader, and that is the testable half
 *
 * A post-process pass is a thing only eyes can judge -- `CLAUDE.md` says so and
 * this file does not pretend otherwise. What *can* be checked is the arithmetic
 * underneath it: that one mushroom is a shimmer and six is a hurricane, that the
 * clear window in the middle shrinks rather than jumps, that nothing is on at
 * zero, and that every parameter is bounded. `tripLook` is that arithmetic and
 * `verifyTripView` is the check; the shader below reads the numbers and does as
 * it is told.
 *
 * ## The owner's staircase
 *
 *   - **1-4** wavier and more colourful each time, with a motion blur.
 *   - **5** only the middle ~5% of the screen is still the world; the rest is a
 *     kaleidoscope, and everything is still moving.
 *   - **6** less of the middle, plus a vibration, plus things flying past --
 *     travelling rather than tripping.
 *   - **7** is not a look. Seven is the room, and the room is a scene.
 *
 * ## Cheap, and specifically cheap in the way that matters
 *
 * One fullscreen pass, no extra render targets, no history buffer. The motion
 * blur is **radial** -- four taps along the vector from the centre -- rather
 * than temporal, because temporal blur needs last frame kept and this client is
 * already fighting for frame time. Four taps is four texture reads on a pass
 * that is one triangle; the kaleidoscope is a polar fold, which is two
 * trigonometric calls and no reads at all. Nothing here scales with the scene.
 */

/** Every number the pass needs, all bounded, all zero at rest. */
export interface TripLook {
  /** Sine distortion of the sample position, in UV. */
  wave: number;
  /** How fast the waves crawl. */
  waveSpeed: number;
  /** Saturation and hue push. 0 is the world's own colour. */
  colour: number;
  /** Radial blur reach, in UV. Zero is a single tap. */
  blur: number;
  /** How much of the screen stays the world, as a radius in UV. 0.75 is "all". */
  clearRadius: number;
  /** Kaleidoscope wedges. 0 is no fold. */
  wedges: number;
  /** Screen shake, in UV. */
  vibration: number;
  /** Streaks pulled from the centre: the travelling look. */
  travel: number;
}

export const CALM: TripLook = {
  wave: 0,
  waveSpeed: 0,
  colour: 0,
  blur: 0,
  clearRadius: 0.75,
  wedges: 0,
  vibration: 0,
  travel: 0,
};

/**
 * The look for a live stack of `n`.
 *
 * Interpolated between named rungs rather than computed from a formula, because
 * the owner described the *steps* and a curve that happened to pass through them
 * would not be the thing he asked for. Six is deliberately far past five: "even
 * less of the screen normal", and the difference has to be obvious in one
 * mushroom rather than felt over three.
 */
const RUNGS: readonly TripLook[] = [
  CALM,
  { wave: 0.004, waveSpeed: 0.5, colour: 0.12, blur: 0.0, clearRadius: 0.75, wedges: 0, vibration: 0, travel: 0 },
  { wave: 0.009, waveSpeed: 0.8, colour: 0.3, blur: 0.004, clearRadius: 0.75, wedges: 0, vibration: 0, travel: 0 },
  { wave: 0.016, waveSpeed: 1.1, colour: 0.5, blur: 0.008, clearRadius: 0.75, wedges: 0, vibration: 0, travel: 0 },
  { wave: 0.026, waveSpeed: 1.5, colour: 0.72, blur: 0.014, clearRadius: 0.75, wedges: 0, vibration: 0, travel: 0 },
  // 5: the world shrinks to a coin in the middle and the rest folds.
  { wave: 0.034, waveSpeed: 1.9, colour: 0.85, blur: 0.018, clearRadius: 0.13, wedges: 6, vibration: 0, travel: 0 },
  // 6: less of it, it shakes, and things go past.
  { wave: 0.046, waveSpeed: 2.6, colour: 1.0, blur: 0.026, clearRadius: 0.07, wedges: 10, vibration: 0.004, travel: 0.7 },
  // 7 is the room. The look is held at six so the transition is a scene change
  // rather than a seventh visual state nobody asked for.
  { wave: 0.046, waveSpeed: 2.6, colour: 1.0, blur: 0.026, clearRadius: 0.07, wedges: 10, vibration: 0.004, travel: 0.7 },
];

/** The look for `n` live buffs, clamped. */
export function tripLook(n: number): TripLook {
  const i = Math.max(0, Math.min(RUNGS.length - 1, Math.floor(n)));
  return RUNGS[i];
}

/**
 * Ease one look toward another.
 *
 * A buff landing or expiring must not switch the screen in a frame: `bite` is
 * instant and the *look* is not, or eating a fifth mushroom is a jump-cut into a
 * kaleidoscope. Half a second to travel a whole rung, which is fast enough to
 * feel caused by the mushroom and slow enough not to be a cut.
 */
export const EASE_PER_S = 2;

export function easeLook(from: TripLook, to: TripLook, dt: number): TripLook {
  const t = Math.max(0, Math.min(1, dt * EASE_PER_S));
  const mix = (a: number, b: number): number => a + (b - a) * t;
  return {
    wave: mix(from.wave, to.wave),
    waveSpeed: mix(from.waveSpeed, to.waveSpeed),
    colour: mix(from.colour, to.colour),
    blur: mix(from.blur, to.blur),
    clearRadius: mix(from.clearRadius, to.clearRadius),
    wedges: mix(from.wedges, to.wedges),
    vibration: mix(from.vibration, to.vibration),
    travel: mix(from.travel, to.travel),
  };
}

/** Is this look worth running the pass for at all? */
export function looksClear(l: TripLook): boolean {
  return (
    l.wave < 1e-4 &&
    l.colour < 1e-4 &&
    l.blur < 1e-4 &&
    l.wedges < 1e-3 &&
    l.vibration < 1e-5 &&
    l.travel < 1e-4 &&
    l.clearRadius > 0.7
  );
}

export function verifyTripView(): string[] {
  const failures: string[] = [];

  // --- Nothing is on at rest, and the pass can tell.
  if (!looksClear(tripLook(0))) failures.push('A sober player is having some kind of experience.');
  if (looksClear(tripLook(1))) failures.push('One mushroom does nothing the pass would bother running for.');

  // --- 1 through 4: wavier, more colourful, blurrier, every time.
  for (let n = 2; n <= 4; n++) {
    const a = tripLook(n - 1);
    const b = tripLook(n);
    if (b.wave <= a.wave) failures.push(`Stack ${n} is not wavier than ${n - 1}.`);
    if (b.colour <= a.colour) failures.push(`Stack ${n} is not more colourful than ${n - 1}.`);
    if (b.blur < a.blur) failures.push(`Stack ${n} lost the blur ${n - 1} had.`);
    if (b.clearRadius !== a.clearRadius) failures.push(`Stack ${n} narrowed the screen; that starts at five.`);
    if (b.wedges !== 0) failures.push(`Stack ${n} folded the screen; the kaleidoscope starts at five.`);
  }

  // --- 5 is the reversal: the world becomes a coin in the middle.
  {
    const four = tripLook(4);
    const five = tripLook(5);
    if (five.clearRadius >= four.clearRadius) failures.push('Five did not shrink the clear middle.');
    // "like 5% of it" -- as an area of the screen, which is what a person sees.
    const share = Math.PI * five.clearRadius * five.clearRadius;
    if (share > 0.1) failures.push(`Five leaves ${(share * 100).toFixed(1)}% of the screen clear; the owner asked for about 5%.`);
    if (five.wedges < 3) failures.push('Five has no kaleidoscope to speak of.');
    if (five.wave <= four.wave) failures.push('Five stopped moving; it is still meant to be wavy.');
  }

  // --- 6 is less middle, plus vibration, plus travelling.
  {
    const five = tripLook(5);
    const six = tripLook(6);
    if (six.clearRadius >= five.clearRadius) failures.push('Six did not take more of the screen than five.');
    if (six.vibration <= 0) failures.push('Six does not vibrate.');
    if (five.vibration !== 0) failures.push('Five vibrates; the vibration is six.');
    if (six.travel <= 0) failures.push('Nothing flies past at six.');
    if (five.travel !== 0) failures.push('Five travels; travelling is six.');
    if (six.wedges <= five.wedges) failures.push('Six is not more folded than five.');
  }

  // --- Seven is the room, so the look stops climbing.
  {
    const six = tripLook(6);
    const seven = tripLook(7);
    if (seven.clearRadius !== six.clearRadius || seven.wedges !== six.wedges) {
      failures.push('Seven has a look of its own; seven is a scene change, not a seventh filter.');
    }
    if (tripLook(99).wave !== six.wave) failures.push('The look is not clamped.');
  }

  // --- Everything is bounded. A pass that samples a metre off the screen is a
  //     pass that draws the edge stretched across the whole frame.
  for (let n = 0; n <= 7; n++) {
    const l = tripLook(n);
    if (l.wave > 0.08) failures.push(`Stack ${n} distorts by ${l.wave} UV; anything past 0.08 samples off-screen.`);
    if (l.blur > 0.05) failures.push(`Stack ${n} blurs by ${l.blur} UV, which is a smear rather than a blur.`);
    if (l.clearRadius < 0 || l.clearRadius > 1) failures.push(`Stack ${n} has a clear radius of ${l.clearRadius}.`);
    if (l.colour < 0 || l.colour > 1) failures.push(`Stack ${n} pushes colour by ${l.colour}, outside 0..1.`);
    if (l.vibration > 0.02) failures.push(`Stack ${n} shakes by ${l.vibration} UV, which is unplayable rather than strong.`);
  }

  // --- The ease arrives, and never overshoots.
  {
    let look = CALM;
    const target = tripLook(6);
    for (let i = 0; i < 600; i++) look = easeLook(look, target, 1 / 60);
    if (Math.abs(look.wave - target.wave) > 1e-6) failures.push('The look never reaches its target.');
    let back = tripLook(6);
    for (let i = 0; i < 600; i++) back = easeLook(back, CALM, 1 / 60);
    if (!looksClear(back)) failures.push('Coming down never gets all the way back to the world.');
    // One frame moves a fraction, not the whole way: the jump-cut this exists
    // to prevent.
    const oneFrame = easeLook(CALM, target, 1 / 60);
    if (oneFrame.wave > target.wave * 0.2) failures.push('A single frame moved most of the way; that is a cut.');
    // A huge dt (a tab that was backgrounded) clamps rather than overshooting.
    const huge = easeLook(CALM, target, 10);
    if (huge.wave > target.wave + 1e-9) failures.push('A long frame overshot the target.');
  }

  return failures;
}
