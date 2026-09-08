/**
 * The grade: the last thing that happens to a pixel, and the first thing a
 * player calls "the look".
 *
 * `sky/calibration.ts` decides how much light there is and what colour it is,
 * and it is very good at that -- every number in it is measured, every ratio is
 * bounded, and `verifyLightRig` convicts anything that drifts. What it does not
 * do, and deliberately never did, is *grade*. The chain it documents ends at
 * `neutralToneMapping(irradiance * albedo / pi, 0.62)` and then straight out to
 * the display, which is a **transfer function, not a look**. Khronos PBR
 * Neutral was chosen because it does the least: it holds hue, it has no toe, it
 * asymptotes rather than clips. Those are exactly the properties you want from
 * the thing you grade *on top of*, and for a long time nothing was on top of it.
 *
 * The one sentence that produced this file is the owner's: *"the game should get
 * toward GTA 7 graphic"*. Whatever else that means, the part of it that is free
 * is this one. Every open-world game shipped in the last fifteen years puts a
 * split-tone on the frame -- cool in the shadows, warm in the highlights -- and
 * it is the single cheapest thing on the list of everything that separates a
 * correct render from a photographed one. It costs six ALU in the output
 * function that was already running.
 *
 * ---------------------------------------------------------------------------
 * ## THE INVARIANT, WHICH IS THE WHOLE REASON THIS IS SAFE TO SHIP UNWATCHED
 *
 * `calibration.ts` and `cars.ts` and `street.ts` are full of published display
 * values -- *"sunlit footpath rgb(241,245,248)"*, *"a white car roof in sun
 * lands at rgb(240,244,249)"*, *"shaded asphalt rgb(24,40,59)"*. Those numbers
 * are the anchors the whole palette was built against, and a grade that moved
 * them would invalidate a year of measurement in one commit.
 *
 * So the grade is built to **preserve Rec. 709 luminance exactly, for any
 * neutral input, at every solar altitude, for every parameter value**. Not
 * approximately: exactly, as an algebraic identity, and `verifyGrade` asserts it
 * to 1e-12 across a sweep of the whole day.
 *
 * It falls out of two rules:
 *
 *   1. **Every tint is normalised to luminance 1.** A per-channel gain `t` with
 *      `luminance(t) = 1` applied to a neutral `(y,y,y)` gives `(y*t.r, y*t.g,
 *      y*t.b)`, whose luminance is `y * luminance(t)` = `y`. And because
 *      luminance is linear, `mix(t1, t2, w)` of two luminance-1 tints is itself
 *      luminance 1 -- so blending shadow tint into highlight tint by pixel
 *      brightness cannot leak level either.
 *   2. **Saturation is a mix toward the pixel's own luma.** `mix(vec3(y), c, s)`
 *      has luminance `(1-s)*y + s*y = y` for any `s` and any `c`.
 *
 * The consequence is worth stating plainly, because it is what lets this default
 * to on: **the grade cannot make anything brighter or darker.** It moves hue and
 * it moves chroma. A footpath keeps its level; the shaded side of a street keeps
 * its level; `NIGHT_AMBIENT_FLOOR_MIN` keeps its level, which is the one thing
 * in the night rig that a careless post-process traditionally eats. Every ratio
 * `verifyLightRig` bounds is upstream of this file anyway -- those are computed
 * from irradiance, before a tone curve exists -- so the grade cannot reach them
 * at all.
 *
 * What it *can* do is push a shaded wall a few code values toward blue and a
 * sunlit one a few toward amber, which is what a photograph of a Sydney street
 * at three in the afternoon actually looks like and what the render did not.
 *
 * ---------------------------------------------------------------------------
 * ## WHERE IT RUNS
 *
 * Inside the tone mapping function, after the curve and before the sRGB encode.
 * Three's WebGPU renderer looks its tone mapping function up in
 * `renderer.library` by the `toneMapping` constant, so a graded curve is
 * registered against `CustomToneMapping` and `renderer.toneMapping` is set to
 * it. That is the whole integration: **no post-processing pass, no render
 * target, no resolve, no second copy of the frame, and MSAA is untouched.** A
 * `PostProcessing` chain would have cost a full-screen pass at the render scale
 * plus the memory for the target, and would have had to be taught about the
 * antialiasing the canvas is already doing. Six ALU in a function that already
 * ran costs none of that.
 *
 * The grade's own parameters are uniforms, so the day/dusk/night curve moves
 * without recompiling anything: one `Fn`, one pipeline, whatever the sun does.
 *
 * ---------------------------------------------------------------------------
 * ## AND WHY THE TONE CURVE IS PORTED INTO THIS FILE
 *
 * `neutralToneMap` below is a line-for-line port of three's own
 * `neutralToneMapping`, in plain numbers. It is not used at runtime -- the GPU
 * runs three's version -- and it exists so that **the chain documented at the
 * top of `calibration.ts` can be evaluated in Node**. Until now every published
 * rgb triple in this codebase was produced by an evaluator that lived outside
 * the repository, which is the reason none of them can be re-checked when
 * something moves. `verifyGrade` and `verifyReflection` now both assert against
 * display values rather than against linear ones, and that is only possible
 * because the curve is here.
 *
 * If three ever changes `neutralToneMapping`, this port is wrong and the checks
 * quietly start asserting the wrong thing. `verifyGrade` pins the curve itself
 * against three published fixed points to catch exactly that.
 */

import {
  EXPOSURE,
  luminance,
  nightAmbientOnWall,
  nightLevel,
  warmthAt,
  type Rgb,
} from './calibration.ts';

/* ---------------------------------------------------------------------------
 * THE TONE CURVE, PORTED. See the header.
 * ------------------------------------------------------------------------- */

/**
 * Khronos PBR Neutral, exactly as `three/src/nodes/display/ToneMappingFunctions.js`
 * writes it. Linear in, linear-in-display-range out; the sRGB encode is separate.
 */
export function neutralToneMap(c: Readonly<Rgb>, exposure = EXPOSURE): Rgb {
  const startCompression = 0.8 - 0.04;
  const desaturation = 0.15;
  let r = c[0] * exposure, g = c[1] * exposure, b = c[2] * exposure;

  const x = Math.min(r, Math.min(g, b));
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= offset; g -= offset; b -= offset;

  const peak = Math.max(r, Math.max(g, b));
  if (peak < startCompression) return [r, g, b];

  const d = 1 - startCompression;
  const newPeak = 1 - (d * d) / (peak + (d - startCompression));
  const k = newPeak / peak;
  r *= k; g *= k; b *= k;
  const t = 1 - 1 / (desaturation * (peak - newPeak) + 1);
  return [r + (newPeak - r) * t, g + (newPeak - g) * t, b + (newPeak - b) * t];
}

/** Linear [0,1] to an sRGB code value 0-255, which is what the comments quote. */
export function toCode(v: number): number {
  const x = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/** The whole chain in one call: linear radiance to the rgb triple a comment quotes. */
export function toDisplay(c: Readonly<Rgb>, grade: Grade | null = null): [number, number, number] {
  const mapped = neutralToneMap(c);
  const out = grade ? applyGrade(mapped, grade) : mapped;
  return [toCode(out[0]), toCode(out[1]), toCode(out[2])];
}

/* ---------------------------------------------------------------------------
 * THE TINTS.
 *
 * Both are written the way a colourist writes them -- a colour you can read --
 * and then normalised to luminance 1 by `unitLuminance`, which is what makes the
 * invariant in the header hold. Change the numbers freely; the normalisation is
 * not optional and is not a taste decision.
 * ------------------------------------------------------------------------- */

/** Divide a tint by its own luminance, so applying it cannot change a level. */
export function unitLuminance(c: Readonly<Rgb>): Rgb {
  const y = luminance(c);
  return [c[0] / y, c[1] / y, c[2] / y];
}

/**
 * What the dark end of the frame is tinted toward.
 *
 * Cool, and only just: shade in a real street is lit by the sky, which is
 * genuinely blue, and `calibration.ts`'s bounce light was added precisely
 * because skylight alone made it *too* blue. So this is not the place to put a
 * teal that fights that measurement -- it is the place to put back the small
 * amount of sky the bounce correctly took out of the irradiance and that the
 * *image* still wants. A shade of 0.86:0.97:1.18 is about 300 K of shift, which
 * is roughly the difference between open shade and full sun in daylight film.
 */
export const SHADOW_TINT: Rgb = /*#__PURE__*/ unitLuminance([0.84, 0.98, 1.22]);

/**
 * And the bright end.
 *
 * Warm, weighted into red rather than into yellow. Sydney sun at three in the
 * afternoon on a clear February day is around 5200 K at the ground -- warmer
 * than the 6500 K the display assumes -- and every render that ignores that
 * reads faintly blue no matter how the lights are set. 1.12:1.00:0.82 is about
 * the right size of that error.
 */
export const HIGHLIGHT_TINT: Rgb = /*#__PURE__*/ unitLuminance([1.16, 0.98, 0.8]);

/**
 * Where the frame stops being shadow and starts being highlight, in luma after
 * the tone curve.
 *
 * The window is wide on purpose. A narrow one is a *posterising* grade: the
 * crossover becomes a visible contour running through every gradient in the
 * frame, and a 60 km city is nothing but large smooth gradients -- roads, walls,
 * the sky. 0.16 to 0.78 puts the transition across most of the range, so no
 * pixel has a neighbour graded very differently from it. Smoothstepped, so there
 * is no corner at either end -- the same rule every ramp in `calibration.ts`
 * follows.
 */
export const SPLIT_LOW = 0.16;
export const SPLIT_HIGH = 0.78;

/**
 * How hard the split-tone is applied in full daylight.
 *
 * Measured rather than chosen, because the useful range is narrow and both ends
 * of it are failures. Through `SHADOW_TINT` and `HIGHLIGHT_TINT` above, 0.11
 * puts the day tints at
 *
 *     shadow    (0.9855, 1.0014, 1.0287)
 *     highlight (1.0169, 0.9972, 0.9775)
 *
 * -- a separation between the dark end of the frame and the bright end of
 * **three code values in red and five in blue at mid-grey**. Run through the
 * whole chain, a sunlit footpath goes from rgb(226,229,231) to rgb(228,229,228):
 * it stops being very slightly blue and becomes very slightly warm, which is the
 * entire ambition.
 *
 * Half this was tried first and was not worth shipping -- one or two code values
 * is under the threshold at which anybody can see it, and an invisible grade is
 * a shader instruction with a story attached. Double it and the frame reads as
 * a filter rather than as a photograph; at 0.3 the shaded side of a street is
 * openly cyan.
 *
 * The failure mode of going higher is specific and worth naming, because it is
 * the one that would waste the invariant: the tint is a *gain*, so a highlight
 * already near 1.0 has its red pushed over and clipped while its blue is pulled
 * down, and a clipped channel is the one operation in this file that does not
 * preserve luminance. Here the worst case is a red channel at 1.017 on a pixel
 * that was already at 1.0 and therefore already clipped, so nothing is lost that
 * the display had not lost anyway. `verifyGrade` bounds it at 1.04, which is
 * where the dusk strength below lands.
 */
export const SPLIT_DAY = 0.11;

/**
 * And at the golden hour, where the sun is doing this to the scene anyway.
 *
 * Double the day figure, reached on `warmthAt` -- the same curve
 * `calibration.ts` uses to redden the beam, so the grade and the light warm
 * together rather than crossing each other. `warmthAt` is 0 above 42 degrees of
 * altitude and 1 at the horizon, so this term is **exactly zero at the reference
 * instant** the whole palette was measured at and cannot have moved any of it;
 * `verifyGrade` asserts that directly rather than trusting it.
 */
export const SPLIT_DUSK = 0.22;

/**
 * The shadow tint at full night, where it is doing a different job.
 *
 * After dark there is no sunlit half of the frame to separate the shade from, so
 * the split-tone stops being a separation and becomes a cast. It is raised
 * rather than dropped because that cast is the correct one: the night rig's
 * ambient is `SKY_FILL_NIGHT`, the streets are lit by sodium and LED, and the
 * gap between the two is the thing that makes a night street read as night
 * rather than as underexposed day.
 */
export const SPLIT_NIGHT = 0.18;

/**
 * Saturation at full night.
 *
 * Below 1 because human colour vision genuinely loses saturation as the cones
 * hand over to the rods, and every night scene rendered at full chroma reads as
 * a day scene with the exposure pulled down -- the single most common way a
 * game's night looks wrong. 0.86 is a light touch: enough that a red car at
 * midnight is a dark red car rather than a bright red one, not so much that the
 * street lamps lose their sodium.
 *
 * It is 1.0 at every altitude above `NIGHT_ON_ALTITUDE`, so like `SPLIT_DUSK` it
 * is exactly inert at the reference instant.
 */
export const SATURATION_NIGHT = 0.86;

/* ---------------------------------------------------------------------------
 * THE CURVE.
 * ------------------------------------------------------------------------- */

/** What the grade is doing at one instant. Three numbers and two colours. */
export interface Grade {
  /** Per-channel gain at the dark end. Luminance exactly 1. */
  shadow: Rgb;
  /** Per-channel gain at the bright end. Luminance exactly 1. */
  highlight: Rgb;
  /** Post-curve saturation. 1 leaves chroma alone. */
  saturation: number;
}

/** `smoothstep(0,1,x)`, clamped. The same shape `calibration.ts` uses. */
function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** `mix(a, b, t)` on a colour. */
function mix3(a: Readonly<Rgb>, b: Readonly<Rgb>, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

const WHITE: Rgb = [1, 1, 1];

/**
 * The grade for a given solar altitude. Pure, and the only place the day/dusk/
 * night look is decided -- `world/gradenode.ts` does nothing but copy these three
 * values into uniforms every frame.
 *
 * Every term is driven by a curve that already exists in `calibration.ts`
 * (`warmthAt`, `nightLevel`) rather than by a fresh threshold of its own. That
 * is the same argument `nightRig` makes: one clock after sunset, so the whole
 * look crosses together instead of six things each finding their own hour.
 */
export function gradeAt(altitudeDeg: number): Grade {
  const night = nightLevel(altitudeDeg);
  const day = 1 - night;
  const warm = warmthAt(altitudeDeg);

  // The highlight end belongs to the sun, so it fades out with the sun and
  // warms as the sun reddens.
  const highStrength = (SPLIT_DAY + (SPLIT_DUSK - SPLIT_DAY) * warm) * day;
  // The shadow end belongs to the sky, which does not go away.
  const lowStrength = SPLIT_DAY + (SPLIT_NIGHT - SPLIT_DAY) * night;

  return {
    shadow: mix3(WHITE, SHADOW_TINT, lowStrength),
    highlight: mix3(WHITE, HIGHLIGHT_TINT, highStrength),
    saturation: 1 - (1 - SATURATION_NIGHT) * night,
  };
}

/**
 * Apply a grade to one tone-mapped pixel.
 *
 * **This function and the TSL in `world/gradenode.ts` are the same six lines
 * written twice**, and they have to stay that way: this one is what the checks
 * and the offline sheets evaluate, and that one is what the GPU runs. There is
 * no way to share them -- the server may not import three, and a `Fn` cannot be
 * called with plain numbers -- so the rule is that a change here is a change
 * there, and `verifyGrade` pins enough of the shape that a one-sided edit
 * usually shows up as a failed assertion rather than as a different-looking
 * game.
 */
export function applyGrade(c: Readonly<Rgb>, g: Grade): Rgb {
  const y = luminance(c);
  const w = smoothstep01((y - SPLIT_LOW) / (SPLIT_HIGH - SPLIT_LOW));
  const t = mix3(g.shadow, g.highlight, w);
  const tinted: Rgb = [c[0] * t[0], c[1] * t[1], c[2] * t[2]];
  const ty = luminance(tinted);
  return [
    ty + (tinted[0] - ty) * g.saturation,
    ty + (tinted[1] - ty) * g.saturation,
    ty + (tinted[2] - ty) * g.saturation,
  ];
}

/* ---------------------------------------------------------------------------
 * THE CHECK.
 * ------------------------------------------------------------------------- */

/** Altitudes the sweep walks: a whole day, ends included. */
const SWEEP: readonly number[] = [
  80, 70, 60, 57.11, 50, 40, 30, 20, 12, 8, 6, 4, 2, 1, 0.5, 0, -1, -2, -4, -6, -10, -20, -40, -70,
];

export function verifyGrade(): string[] {
  const failures: string[] = [];

  /* --- The ported tone curve, against three's own arithmetic.
   *
   * Three fixed points, each computable by hand from the source: black stays
   * black; a value under the 0.08 knee takes the quadratic offset; a value over
   * `StartCompression` takes the rolloff. If three ever rewrites the curve these
   * stop matching and every display value asserted below becomes a fiction. */
  const black = neutralToneMap([0, 0, 0], 1);
  if (Math.abs(black[0]) > 1e-12) failures.push(`The tone curve does not map black to black: ${black[0]}.`);
  {
    // x = 0.05: offset = 0.05 - 6.25*0.0025 = 0.034375, peak = 0.015625 < 0.76.
    const got = neutralToneMap([0.05, 0.05, 0.05], 1)[0];
    if (Math.abs(got - 0.015625) > 1e-12) {
      failures.push(`The tone curve's toe is not three's: 0.05 gave ${got}, not 0.015625.`);
    }
  }
  {
    // A blown white must asymptote under 1 rather than clip at it: that is the
    // property `main.ts` chose Neutral for.
    const got = neutralToneMap([8, 8, 8], 1)[0];
    if (!(got > 0.9 && got < 1)) failures.push(`The tone curve put a linear 8.0 at ${got}; Neutral asymptotes below 1.`);
  }
  // And the encode, at the two ends and at the standard mid.
  if (toCode(0) !== 0) failures.push('sRGB encode of 0 is not 0.');
  if (toCode(1) !== 255) failures.push('sRGB encode of 1 is not 255.');
  if (Math.abs(toCode(0.2140411) - 128) > 1) failures.push(`sRGB encode of mid-grey gave ${toCode(0.2140411)}, not 128.`);

  /* --- The invariant. This is the check the header is about. */
  for (const alt of SWEEP) {
    const g = gradeAt(alt);
    for (const [name, tint] of [['shadow', g.shadow], ['highlight', g.highlight]] as const) {
      const y = luminance(tint);
      if (Math.abs(y - 1) > 1e-12) {
        failures.push(
          `At ${alt} deg the ${name} tint has luminance ${y.toFixed(15)}, not 1. ` +
            'A tint off unity is a grade that changes exposure, and every published rgb triple in the palette is then wrong.',
        );
      }
    }
    // The identity itself, on eight neutral levels spanning the range.
    for (const v of [0, 0.02, 0.08, 0.2, 0.35, 0.5, 0.75, 1]) {
      const out = applyGrade([v, v, v], g);
      const before = luminance([v, v, v]);
      const after = luminance(out);
      if (Math.abs(after - before) > 1e-12) {
        failures.push(
          `At ${alt} deg a neutral ${v} came out at luminance ${after.toFixed(15)} rather than ${before}. ` +
            'The grade is meant to move hue and chroma only.',
        );
      }
    }
    if (!(g.saturation > 0 && g.saturation <= 1)) {
      failures.push(`At ${alt} deg the saturation is ${g.saturation}, outside (0, 1].`);
    }
  }

  /* --- Inert at the reference instant, which is where the palette was measured.
   *
   * Not the same claim as the invariant above: this says the *day* grade is the
   * plain day grade, with no dusk warmth and no night desaturation mixed in, so
   * `REFERENCE_SOLAR` still means what `calibration.ts` says it means. */
  {
    const g = gradeAt(57.11);
    if (Math.abs(g.saturation - 1) > 1e-12) failures.push(`The reference instant is desaturated by ${1 - g.saturation}.`);
    const plainHigh = mix3(WHITE, HIGHLIGHT_TINT, SPLIT_DAY);
    for (let i = 0; i < 3; i++) {
      if (Math.abs(g.highlight[i] - plainHigh[i]) > 1e-12) {
        failures.push('The reference instant has dusk warmth in it; `warmthAt` is meant to be zero at 57 degrees.');
        break;
      }
    }
  }

  /* --- The night floor survives.
   *
   * `NIGHT_AMBIENT_FLOOR_MIN` is the one number in the night rig that a
   * post-process traditionally eats, and it is quoted as an irradiance on a
   * wall. Run the real thing through the real chain and check the level is
   * untouched -- to a code value, which is as fine as a display can express. */
  {
    const g = gradeAt(-20);
    const wall = nightAmbientOnWall(-20);
    const albedo = 0.25 / Math.PI; // a mid render, Lambert.
    const lit: Rgb = [wall[0] * albedo, wall[1] * albedo, wall[2] * albedo];
    const plain = toDisplay(lit);
    const graded = toDisplay(lit, g);
    const plainY = luminance(neutralToneMap(lit));
    const gradedY = luminance(applyGrade(neutralToneMap(lit), g));
    /*
     * **The one place the identity is approximate, and the bound on how
     * approximate.** The exact identity in the header is stated for a *neutral*
     * input, and a wall lit only by the night sky is the least neutral surface
     * in the game -- `SKY_FILL_NIGHT` is (0.185, 0.259, 0.382), nearly two to
     * one blue over red. A luminance-1 gain applied to a coloured pixel moves
     * its luminance by the correlation between the gain's deviation and the
     * pixel's own chroma, which here is +0.24%: about a fortieth of a code value
     * at this level, and in the *bright* direction. 1% is a bound with room in
     * it that still convicts a tint that stopped being normalised.
     */
    if (Math.abs(gradedY - plainY) > plainY * 0.01) {
      failures.push(
        `The night floor's luminance moved from ${plainY.toFixed(9)} to ${gradedY.toFixed(9)} under the grade ` +
          `(${(((gradedY - plainY) / plainY) * 100).toFixed(2)}%). The grade is meant to be able to move a ` +
          'coloured pixel by a fraction of a per cent and nothing more; past a per cent a tint has stopped being normalised.',
      );
    }
    // The size of the floor itself is `verifyLightRig`'s bound (`NIGHT_AMBIENT_FLOOR_MIN`
    // and `_MAX`) and is not re-asserted here; what is asserted here is that the
    // grade did not eat it.
    if (Math.max(...graded) === 0 && Math.max(...plain) > 0) {
      failures.push('The grade took the night floor to black.');
    }
  }

  /* --- Monotone, so scrubbing the clock is a fade and not a flicker.
   *
   * Walked at a fifth of a degree from noon to well after dark. The two strength
   * terms are the ones with corners available to them; saturation is checked
   * separately because it moves the other way. */
  {
    let lastSat = Infinity;
    let lastWarmth = -Infinity;
    for (let alt = 90; alt >= -30; alt -= 0.2) {
      const g = gradeAt(alt);
      if (g.saturation > lastSat + 1e-12) {
        failures.push(`Saturation rose as the sun set, at ${alt.toFixed(1)} deg.`);
        break;
      }
      lastSat = g.saturation;
    }
    // Highlight warmth rises from noon to the horizon and then must fall away
    // with the sun rather than stay lit. Red-over-blue is the readable measure.
    let peakAlt = 90;
    let peak = -Infinity;
    for (let alt = 90; alt >= -30; alt -= 0.2) {
      const w = gradeAt(alt).highlight[0] / gradeAt(alt).highlight[2];
      if (w > peak) { peak = w; peakAlt = alt; }
    }
    if (!(peakAlt > -6 && peakAlt < 12)) {
      failures.push(`The highlight warmth peaks at ${peakAlt.toFixed(1)} deg; the golden hour is between the horizon and about 10 degrees.`);
    }
    for (let alt = 90; alt >= peakAlt; alt -= 0.2) {
      const w = gradeAt(alt).highlight[0] / gradeAt(alt).highlight[2];
      if (w < lastWarmth - 1e-12) {
        failures.push(`Highlight warmth fell as the sun dropped, at ${alt.toFixed(1)} deg.`);
        break;
      }
      lastWarmth = w;
    }
    const deepNight = gradeAt(-20).highlight;
    if (Math.abs(deepNight[0] - 1) > 1e-12 || Math.abs(deepNight[2] - 1) > 1e-12) {
      failures.push('The highlight tint is still warm after dark, where there is no sunlight to be warm.');
    }
  }

  /* --- And the clamps: nothing in the sweep leaves the legal range. */
  for (const alt of SWEEP) {
    const g = gradeAt(alt);
    for (const tint of [g.shadow, g.highlight]) {
      for (const ch of tint) {
        if (!(ch > 0.5 && ch < 1.6)) {
          failures.push(`At ${alt} deg a tint channel is ${ch.toFixed(4)}; a gain that far from 1 is a colour cast, not a grade.`);
        }
      }
    }
    // A pixel already at white must not be pushed measurably past it.
    const white = applyGrade([1, 1, 1], g);
    if (Math.max(...white) > 1.04) {
      failures.push(`At ${alt} deg white came out at ${Math.max(...white).toFixed(4)}; the highlight tint is clipping the top of the frame.`);
    }
  }

  return failures;
}
