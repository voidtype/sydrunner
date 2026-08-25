/**
 * Which way the hit came from, said with the red that is already there.
 *
 * `game/feedback.ts` sells a hit taken as camera shake and a red pulse, which is
 * spec 8.2's clause and is right about *what it feels like*. It says nothing
 * about **where it came from**, and in a melee game where the thing that kills
 * you is somebody who walked up behind you, that is the one fact worth knowing:
 * a player who is hit and does not know which way to turn is a player who spins
 * on the spot and gets hit again.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT A NEW PIECE OF HUD.
 *
 * `DESIGN.md` rule 6 is "the city reacts; the UI does not shout", and the
 * temptation here -- every shooter's answer -- is a red wedge that flies in at
 * the screen edge. That is a new element, it appears only to tell you about
 * yourself, and it is exactly the toast the rule refuses.
 *
 * So the information goes into the pulse that is already on the screen. A
 * radial gradient has an origin, `#vignette` centres it, and moving that origin
 * *away* from the attacker makes the red heaviest on the edge they are standing
 * behind -- because the gradient's dark end is its outside. Nothing is added,
 * nothing new fades in, and a player who has never read a patch note reads it
 * anyway, because "the red is on my left" and "he is on my left" are the same
 * sentence.
 *
 * ---------------------------------------------------------------------------
 * THE BEARING IS TAKEN ONCE, AT THE HIT, AND NOT TRACKED.
 *
 * The obvious refinement is to recompute it every frame so the red follows the
 * attacker while you turn. It is deliberately not done: the pulse is 0.45 s and
 * a bearing that slides during it reads as the *room* rotating rather than as
 * a direction, which is worse than the static answer and costs a per-frame
 * dependency on the camera in a module that otherwise has none. Turn to face
 * them and the next hit tells you again.
 *
 * A hit with no known source -- a car, a fall, a cop off-screen -- passes
 * `null` and the gradient stays centred, which is what it has always done. The
 * feature can never make an unattributed hit *worse* than it was.
 */

/**
 * How far the gradient's origin slides, as a percentage of the viewport.
 *
 * Sized against the gradient it is moving rather than picked: `#vignette` is
 * transparent to 32% and fully dark at 100%, so the red only exists in the
 * outer two thirds. Sliding the origin 26% moves the near edge of that band
 * about a third of the way across the screen -- unmistakable at a glance, and
 * still short of the point where the far edge goes clear and the effect reads as
 * a wipe instead of a pulse.
 */
export const ORIGIN_BIAS_PCT = 26;

/** The gradient origin, in the percentages a `radial-gradient` takes. */
export interface VignetteOrigin {
  readonly x: number;
  readonly y: number;
}

/**
 * Where to put the pulse's origin for a hit at this screen bearing.
 *
 * `bearing` is `waypoint.screenBearing`'s -- radians clockwise from straight up,
 * zero dead ahead, `+pi/2` to the right -- so the *attacker* is at
 * `(sin b, -cos b)` in screen axes and the origin goes the other way.
 *
 * Only the horizontal component is used. Vertical bias would be a claim about
 * where somebody is standing in a plan-distance world that does not have one,
 * and a pulse that drifts up and down as people walk past reads as a bug.
 */
export function vignetteOrigin(bearing: number | null): VignetteOrigin {
  if (bearing === null || !Number.isFinite(bearing)) return { x: 50, y: 50 };
  return { x: 50 - Math.sin(bearing) * ORIGIN_BIAS_PCT, y: 50 };
}

/** The same thing as the string CSS wants: `"24% 50%"`. */
export function vignetteOriginCss(bearing: number | null): string {
  const o = vignetteOrigin(bearing);
  return `${o.x.toFixed(1)}% ${o.y.toFixed(1)}%`;
}

/**
 * The invariants, and the one that matters is the sign.
 *
 * A direction indicator that points the wrong way is worse than none at all --
 * it turns the player *into* the swing rather than away from it -- and it is one
 * character to get wrong and impossible to see in a screenshot. So the check is
 * the four cardinals, by name, in the terms a player would use.
 */
export function verifyHurtDir(): string[] {
  const failures: string[] = [];
  const half = Math.PI / 2;

  const ahead = vignetteOrigin(0);
  if (Math.abs(ahead.x - 50) > 1e-6) {
    failures.push('a hit from dead ahead moved the pulse sideways');
  }
  const behind = vignetteOrigin(Math.PI);
  if (Math.abs(behind.x - 50) > 1e-6) {
    failures.push('a hit from directly behind moved the pulse sideways; it cannot know which way');
  }

  // Hit from the right: the red must be heaviest on the right, so the origin --
  // the *clear* end of the gradient -- goes left.
  const right = vignetteOrigin(half);
  if (!(right.x < 50 - ORIGIN_BIAS_PCT / 2)) {
    failures.push(
      `a hit from the right put the pulse origin at ${right.x}%, which lights the wrong edge` +
        ' and turns the player away from the attacker',
    );
  }
  const left = vignetteOrigin(-half);
  if (!(left.x > 50 + ORIGIN_BIAS_PCT / 2)) {
    failures.push(
      `a hit from the left put the pulse origin at ${left.x}%, which lights the wrong edge`,
    );
  }
  if (Math.abs(right.x - 50 + (left.x - 50)) > 1e-6) {
    failures.push('left and right are not mirror images; the bias is lopsided');
  }

  // Everything stays on the screen, or the gradient's clear centre leaves the
  // viewport and the whole frame goes red.
  for (let i = 0; i < 64; i++) {
    const b = -Math.PI + (i / 63) * 2 * Math.PI;
    const o = vignetteOrigin(b);
    if (o.x < 0 || o.x > 100 || o.y !== 50) {
      failures.push(`a bearing of ${b.toFixed(2)} put the origin off the viewport at ${o.x}%`);
      break;
    }
  }

  // An unattributed hit is the old behaviour exactly.
  for (const nothing of [null, Number.NaN, Number.POSITIVE_INFINITY]) {
    const o = vignetteOrigin(nothing as number | null);
    if (o.x !== 50 || o.y !== 50) {
      failures.push(`a hit with no source (${String(nothing)}) biased the pulse anyway`);
      break;
    }
  }
  if (vignetteOriginCss(null) !== '50.0% 50.0%') {
    failures.push(`vignetteOriginCss(null) is ${vignetteOriginCss(null)}, not centred`);
  }
  return failures;
}
