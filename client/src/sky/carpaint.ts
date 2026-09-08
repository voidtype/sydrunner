/**
 * The eight car paints, and the arithmetic that says what they are.
 *
 * ---------------------------------------------------------------------------
 * ## THE FOLLOW-UP THIS FILE EXISTS TO CLOSE
 *
 * `GRAPHICS.md`, written the night the clearcoat shipped:
 *
 *   > *"`cars.ts`'s eight paint albedos are still lifted above measured
 *   > reflectance to fake a reflection that now exists. The coat is a convex
 *   > mix, so nothing is double-counted at the sky's own level and no anchor
 *   > moved -- but the dark end of the palette is now a compensation for a term
 *   > that is no longer missing. Re-deriving all eight against a renderer that
 *   > finally has the environment is a real piece of work and is now possible
 *   > offline for the first time."*
 *
 * It is possible, it is done, and **the premise turns out to be half wrong**,
 * which is worth saying before the numbers because it changes what the numbers
 * mean.
 *
 * ## WHAT THE COAT IS ACTUALLY WORTH, MEASURED
 *
 * The lift is large. `world/cars.ts` puts black at 0.11 against the ~0.05 a real
 * black paint reflects -- a factor of 2.2. If the coat were the term the lift
 * was faking, the coat would have to be worth about half of a black car's
 * outgoing radiance.
 *
 * It is worth **three per cent**. `coatFresnel(1)` is `COAT_F0`, 0.03, and the
 * cosine-weighted mean of it over a whole convex body is 0.052. So the coat is a
 * *rim*: half the sky at the silhouette, three per cent across the panel you are
 * looking at. It cannot be what a 2.2x lift was standing in for, and unwinding
 * the lift on the strength of it would have taken every dark car back to the
 * hole `cars.ts` describes -- *"black came out at rgb(11,8,12) and every dark
 * car in shade was a hole"*.
 *
 * So the residual lift stays, and it is now attributable to what it actually is.
 * `sky/reflection.ts` names it plainly: the analytic dome has **no city in it**.
 * A real car on a real street reflects the sunlit wall opposite, the footpath,
 * the awning, the roof of the car in front. That is most of a car's ambient
 * specular in a canyon and none of it is in a three-point vertical gradient. It
 * needs a probe or a screen-space trace, both of which are on `GRAPHICS.md`'s
 * list under their own costs, and until one of them exists the lift is the
 * stand-in for *that* rather than for the sky.
 *
 * ## WHAT IS ACTUALLY RE-DERIVED, THEN
 *
 * Exactly the three per cent. The coat shipped over a palette that was tuned
 * without it, so since that night every car in the game has been rendering
 * slightly off its own published table -- and not uniformly: the coat adds
 * *blue-white sky*, so it lifts the blue channel of a dark car more than the
 * red and it washes a saturated colour toward neutral. `cars.ts`' own warning
 * about the red row -- *"the temptation to lift the other two channels for
 * realism is what turns a red car pink under this tone curve"* -- describes what
 * the coat had quietly done to it: red rendered at rgb(225, 68, 68) where the
 * palette intends rgb(227, 58, 52).
 *
 * So: **solve for the albedo that, under the coat, renders what the shipped
 * albedo rendered without it.**
 *
 *     a' * E/pi * (1 - F)  +  env * F   ==   a * E/pi
 *
 *     a'  =  ( a  -  pi * env * F / E )  /  ( 1 - F )
 *
 * A closed form, per channel, with no iteration and no fitting.
 *
 * **And it is done in linear radiance, which is what makes it exact.** The
 * inversion never touches the tone curve, the exposure or the grade -- it
 * restores the *radiance* the palette was tuned to produce, so whatever display
 * chain runs afterwards gives back whatever it used to give back, to the last
 * code value, for any chain. Every rgb triple published in `world/cars.ts` is
 * therefore **more true after this change than before it**, without a single one
 * of them being edited. That is the strongest form this result could have taken
 * and it is why the reference view below is allowed to be a single facet.
 *
 * ## THE REFERENCE VIEW
 *
 * A roof in sun, square to the eye, reflecting the zenith: `N.V = 1`, mirror
 * direction straight up. Three reasons, all of them already in the repository:
 *
 *   - **It is the anchor of the palette.** `cars.ts`: *"a roof in sun at
 *     rgb(240,244,249) is the sunlit footpath to within a code value, which is
 *     where a white car belongs"*. Every other paint is spaced against that one.
 *   - **It is the case `verifyReflection` already walks**, so the derivation and
 *     the check that guards it use one geometry rather than two.
 *   - **Its irradiance has no free parameters.** `beam * sunColour +
 *     hemisphereIntensity * skyColour` off `solarRig` at the reference instant,
 *     which is how `verifyReflection` writes it and how `calibration.ts`
 *     defines it. A flank would have needed an incidence angle nobody has
 *     measured.
 *
 * At that view `F` is `COAT_F0` exactly, so the correction is
 * `pi * zenith * 0.03 / E` per channel -- 0.0042 in red, 0.0059 in green,
 * 0.0079 in blue. Small, bluest in blue, and that asymmetry is the whole of what
 * this change does.
 *
 * ---------------------------------------------------------------------------
 * Three-free, like `calibration.ts` and `reflection.ts`: `verifyCarPaint` runs
 * on the server, and `world/cars.ts` -- which is full of three -- imports the
 * table from here rather than declaring it. The palette also exists a second
 * time in `scripts/render-car-sheet.mjs --palette`, and `SHEET_PAINT` below is
 * the fence between them.
 */

import { luminance, solarRig, type Rgb } from './calibration.ts';
import { toDisplay } from './grade.ts';
import {
  COAT_F0,
  PALETTE_ANCHOR_BLACK,
  PALETTE_ANCHOR_WHITE,
  clearcoatOver,
  envRadiance,
  skyEnvAt,
} from './reflection.ts';

/** 3 pm on 15 February, the instant every colour in this project is measured at. */
const REFERENCE_ALTITUDE = 57.11;

/** The eight, in `parking.WHITE` .. `parking.BEIGE` order. */
export const PAINT_NAMES = [
  'white', 'silver', 'grey', 'black', 'blue', 'red', 'green', 'beige',
] as const;

/**
 * What each paint is *meant to render as*, expressed as the albedo that rendered
 * it before the coat existed.
 *
 * This is the palette exactly as `world/cars.ts` shipped it, and it is kept
 * rather than replaced because it is the input to the derivation, not a
 * historical note: the whole result is "reproduce what this produced". Every
 * display value published beside a row in `cars.ts` was measured off this table,
 * so this table is what those values *mean*.
 *
 * The mix behind the eight is the pipeline's and is written up in `cars.ts`:
 * white 30%, silver 15%, grey 10%, black 15%, blue 10%, red 8%, beige 7%,
 * green 5%. Seventy per cent of an Australian kerb is achromatic.
 */
export const PAINT_INTENT: ReadonlyArray<Readonly<Rgb>> = [
  [0.805, 0.81, 0.808],
  [0.4, 0.41, 0.428],
  [0.153, 0.158, 0.172],
  [0.11, 0.112, 0.124],
  [0.036, 0.082, 0.24],
  [0.268, 0.026, 0.022],
  [0.04, 0.092, 0.058],
  [0.32, 0.288, 0.23],
];

/** The reference view's irradiance. See the header: no free parameters. */
export function referenceIrradiance(): Rgb {
  const rig = solarRig(REFERENCE_ALTITUDE);
  const beam = rig.sunIntensity * Math.sin((REFERENCE_ALTITUDE * Math.PI) / 180);
  return [
    beam * rig.sunColour[0] + rig.hemisphereIntensity * rig.skyColour[0],
    beam * rig.sunColour[1] + rig.hemisphereIntensity * rig.skyColour[1],
    beam * rig.sunColour[2] + rig.hemisphereIntensity * rig.skyColour[2],
  ];
}

/**
 * The albedo that renders `intent` **through the coat**.
 *
 * Closed form, per channel, in linear radiance. Can in principle return a
 * negative -- a paint darker than the coat's own contribution has no albedo that
 * reaches it -- and `verifyCarPaint` refuses one rather than clamping, because a
 * clamp there would be a paint quietly failing to be the colour it says it is.
 */
export function deriveAlbedo(intent: Readonly<Rgb>): Rgb {
  const E = referenceIrradiance();
  const zenith = envRadiance(skyEnvAt(REFERENCE_ALTITUDE), 1);
  const out: Rgb = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    out[i] = (intent[i] - (Math.PI * zenith[i] * COAT_F0) / E[i]) / (1 - COAT_F0);
  }
  return out;
}

/**
 * The palette the game paints with. `world/cars.ts` imports this and nothing
 * else about colour.
 *
 * Written out rather than computed at module load, on this project's usual
 * terms: a reader of a palette should see numbers, a diff of a palette should
 * show numbers, and `verifyCarPaint` asserts these are `deriveAlbedo` of the
 * intent above to 1e-5. Six decimals because the fifth is worth about a
 * hundredth of a code value and the sixth is free.
 *
 * The change from `PAINT_INTENT`, row by row, and what it is doing:
 *
 *   white   +2.6%  Goes *up*, and it is the one row that does. White is
 *                  brighter than the zenith it reflects, so the coat was taking
 *                  light off it -- `reflection.ts`: *"a surface brighter than
 *                  the sky loses"*. Unwinding that puts the anchor back level
 *                  with the sunlit footpath, which is the whole reason the
 *                  anchor exists.
 *   silver  +2.0%  Same direction, half the size, for the same reason.
 *   grey     0.0%  Sits within a tenth of a per cent of the zenith's own level
 *                  in every channel. Nothing to unwind; the row is unchanged to
 *                  three figures, which is a good sign rather than an omission.
 *   black   -0.9%  Down, and **down twice as far in blue as in red**: the coat
 *                  adds sky, sky is blue, and a black car had been going faintly
 *                  navy since the night the coat shipped.
 *   blue    -9.0%  The largest move in the table, and it is in red: a blue paint
 *                  has almost no red in it, so 0.0042 of sky is nine per cent of
 *                  the row. The car goes back to being blue rather than
 *                  blue-grey.
 *   red     -20% G Nineteen per cent of green and thirty-four of blue. This is
 *           -34% B `cars.ts`' own warning arriving from an unexpected direction
 *                  -- *"the temptation to lift the other two channels for
 *                  realism is what turns a red car pink under this tone curve"*
 *                  -- because that is exactly what the coat had been doing to
 *                  it. Red rendered rgb(225, 68, 68) where the palette intends
 *                  rgb(227, 58, 52); it now renders the second of those.
 *   green   -7.8%  Same effect, same size, on the two channels a bottle green
 *                  does not have.
 *   beige   +1.7%  Back over the zenith's level, so it lifts like the neutrals.
 *
 * The pattern is one thing said eight ways: **the coat was desaturating the
 * palette**, hardest on the rows with the least of a channel, and the
 * re-derivation is the saturation coming back. That is a bigger visible result
 * than the "unwind the lift" this follow-up was written to do, and it is a real
 * one -- a red car reading as red is worth more than four code values on a black
 * one.
 */
export const CAR_PAINT_ALBEDO: ReadonlyArray<Readonly<Rgb>> = [
  [0.825550, 0.829009, 0.824876],
  [0.408024, 0.416638, 0.433124],
  [0.153385, 0.156844, 0.169206],
  [0.109055, 0.109422, 0.119722],
  [0.032766, 0.078494, 0.239309],
  [0.271942, 0.020762, 0.014567],
  [0.036890, 0.088803, 0.051681],
  [0.325550, 0.290865, 0.229000],
];

/**
 * The palette, restated for `scripts/render-car-sheet.mjs --palette`.
 *
 * Same fence as `SHEET_ENV` and `SHEET_GLAZING` in `sky/reflection.ts` and the
 * same reason: the sheet is `.mjs` under a bare `node` and cannot import
 * TypeScript, so the eight rows exist twice and this is the thing that notices
 * when only one copy is edited. The sheet hard-codes these and refuses to draw
 * if they disagree with what it has; `verifyCarPaint` asserts they equal
 * `CAR_PAINT_ALBEDO` on both boot lists.
 *
 * It is a straight copy rather than a summary because a palette has no invariant
 * to check -- eight rgb triples are eight rgb triples, and the only thing that
 * can go wrong is that one of them is a different number in the picture from in
 * the game.
 */
export const SHEET_PAINT: ReadonlyArray<Readonly<Rgb>> = CAR_PAINT_ALBEDO;

export function verifyCarPaint(): string[] {
  const failures: string[] = [];

  /* --- 1. The published table is the derivation.
   *
   * The one assertion this file is for. Six decimals of a closed form, so 1e-5
   * is three rounding errors of slack and nothing else. */
  if (CAR_PAINT_ALBEDO.length !== PAINT_INTENT.length || CAR_PAINT_ALBEDO.length !== 8) {
    failures.push(
      `The paint palette has ${CAR_PAINT_ALBEDO.length} rows against ${PAINT_INTENT.length} intents; ` +
        'the pipeline writes a colour index in `parking.WHITE` .. `parking.BEIGE` and there are eight of those.',
    );
    return failures;
  }
  for (let i = 0; i < 8; i++) {
    const want = deriveAlbedo(PAINT_INTENT[i]);
    for (let c = 0; c < 3; c++) {
      if (Math.abs(want[c] - CAR_PAINT_ALBEDO[i][c]) > 1e-5) {
        failures.push(
          `${PAINT_NAMES[i]} is published as ${CAR_PAINT_ALBEDO[i][c]} in channel ${c} and the derivation ` +
            `gives ${want[c].toFixed(6)}. The table is meant to be deriveAlbedo() of PAINT_INTENT, written ` +
            'out so a diff shows numbers; if the coat constants moved, re-run the derivation rather than ' +
            'editing one end of it.',
        );
        break;
      }
    }
    if (CAR_PAINT_ALBEDO[i].some((v) => !(v > 0) || !Number.isFinite(v))) {
      failures.push(
        `${PAINT_NAMES[i]} has a non-positive albedo: (${CAR_PAINT_ALBEDO[i].join(', ')}). A paint darker ` +
          'than the coat\'s own contribution has no albedo that reaches it, and clamping one would be a paint ' +
          'quietly failing to be the colour it says it is. COAT_F0 is what to look at.',
      );
    }
  }

  /* --- 2. And the derivation does what it claims: the coated render of the new
   * albedo is the uncoated render of the old one, to the last code value, for
   * every paint.
   *
   * This is the whole result and it is asserted through the real chain rather
   * than in linear -- the linear identity is exact by construction and would be
   * asserting the algebra rather than the outcome. Through Neutral and sRGB is
   * where somebody would notice. */
  {
    const E = referenceIrradiance();
    const zenith = envRadiance(skyEnvAt(REFERENCE_ALTITUDE), 1);
    for (let i = 0; i < 8; i++) {
      const intended = toDisplay([
        (PAINT_INTENT[i][0] * E[0]) / Math.PI,
        (PAINT_INTENT[i][1] * E[1]) / Math.PI,
        (PAINT_INTENT[i][2] * E[2]) / Math.PI,
      ]);
      const rendered = toDisplay(
        clearcoatOver(
          [
            (CAR_PAINT_ALBEDO[i][0] * E[0]) / Math.PI,
            (CAR_PAINT_ALBEDO[i][1] * E[1]) / Math.PI,
            (CAR_PAINT_ALBEDO[i][2] * E[2]) / Math.PI,
          ],
          zenith,
          1,
        ),
      );
      const off = Math.max(...intended.map((v, c) => Math.abs(v - rendered[c])));
      if (off > 1) {
        failures.push(
          `${PAINT_NAMES[i]} was meant to render rgb(${intended.join(',')}) and under the coat it renders ` +
            `rgb(${rendered.join(',')}) -- ${off} code values out. The whole point of the derivation is that ` +
            'those two are the same number, so every rgb triple published in `world/cars.ts` stays true.',
        );
      }
    }
  }

  /* --- 3. The palette is still a palette.
   *
   * `cars.ts` spends its variety budget on *value* rather than on hue and says
   * why: four neutrals spread across the whole tonal range is what stops a
   * street of parked cars looking like a car park in a racing game. So the
   * achromatic four have to stay in order and stay spread.
   *
   * Only the four. A saturated red is genuinely darker in luminance than black
   * paint -- 0.074 against 0.110 -- and that is not a fault, it is what a red
   * car is. Asserting an order over all eight would be asserting the wrong
   * thing, and it is the mistake available here. */
  {
    const neutrals = [0, 1, 2, 3];
    for (let k = 1; k < neutrals.length; k++) {
      const hi = luminance(CAR_PAINT_ALBEDO[neutrals[k - 1]] as Rgb);
      const lo = luminance(CAR_PAINT_ALBEDO[neutrals[k]] as Rgb);
      if (!(hi > lo)) {
        failures.push(
          `${PAINT_NAMES[neutrals[k - 1]]} (${hi.toFixed(4)}) is not brighter than ` +
            `${PAINT_NAMES[neutrals[k]]} (${lo.toFixed(4)}). The four neutrals are white, silver, grey, ` +
            'black in that order and the spread between them is what carries the fleet.',
        );
      }
    }
    const white = luminance(CAR_PAINT_ALBEDO[0] as Rgb);
    const black = luminance(CAR_PAINT_ALBEDO[3] as Rgb);
    if (!(white > black * 6)) {
      failures.push(
        `White is ${(white / black).toFixed(2)}x black. The palette is built on a value spread and under ` +
          'about six to one there is no tonal range left in the achromatic seventy per cent of the kerb.',
      );
    }
    /* And the direction of the whole change, asserted rather than described.
     *
     * What the derivation subtracts from a row before rescaling is
     * `pi * zenith * F / E`, and the zenith is *sky* -- so the amount taken out
     * of blue is nearly twice the amount taken out of red, for every paint,
     * identically. Two consequences, and both are checkable:
     *
     *   - the correction is bluest, always;
     *   - so a **saturated** paint gains chroma (the channels it has least of
     *     lose the largest fraction of themselves), while a **neutral** barely
     *     moves, because there the rescale by `1/(1 - F)` is the larger of the
     *     two effects and it is achromatic.
     *
     * That is the mechanism behind every line of the table above, and getting
     * the sign of it backwards is the one mistake available here. */
    const drop = PAINT_INTENT.map((a, i) =>
      a.map((v, c) => v - CAR_PAINT_ALBEDO[i][c] * (1 - COAT_F0)),
    );
    for (let i = 0; i < 8; i++) {
      if (!(drop[i][2] > drop[i][1] && drop[i][1] > drop[i][0])) {
        failures.push(
          `${PAINT_NAMES[i]}'s correction is (${drop[i].map((v) => v.toFixed(6)).join(', ')}). What the coat ` +
            'put on a car is the zenith, and the zenith is blue -- so what comes back off has to be largest ' +
            'in blue and smallest in red, for every paint, by the same three numbers.',
        );
        break;
      }
    }
    const chroma = (c: Readonly<Rgb>) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    for (const i of [4, 5, 6, 7]) {
      if (chroma(CAR_PAINT_ALBEDO[i]) < chroma(PAINT_INTENT[i]) - 1e-9) {
        failures.push(
          `${PAINT_NAMES[i]} came out of the derivation at ${(chroma(CAR_PAINT_ALBEDO[i]) * 100).toFixed(1)}% ` +
            `chroma against ${(chroma(PAINT_INTENT[i]) * 100).toFixed(1)}% going in. Taking a blue-white sky ` +
            'back out of a saturated paint saturates it; a row that lost chroma means the sign is wrong.',
        );
      }
    }
    for (const i of [0, 1, 2, 3]) {
      if (Math.abs(chroma(CAR_PAINT_ALBEDO[i]) - chroma(PAINT_INTENT[i])) > 0.03) {
        failures.push(
          `${PAINT_NAMES[i]}'s chroma moved from ${(chroma(PAINT_INTENT[i]) * 100).toFixed(1)}% to ` +
            `${(chroma(CAR_PAINT_ALBEDO[i]) * 100).toFixed(1)}%. It is one of the four neutrals and the ` +
            'correction is three per cent of an achromatic-ish level there; a move this size means the ' +
            'reference view or the environment has changed under it.',
        );
      }
    }
  }

  /* --- 4. The two rows `verifyReflection` hangs its anchors on.
   *
   * That check evaluates a white roof in sun and a black car in shade through
   * the real chain, and it has to do it on the paint the game actually uses.
   * `sky/reflection.ts` cannot import this file -- this one imports it -- so the
   * two numbers live there and this is the assertion that they are these two
   * rows. */
  for (const [name, anchor, row] of [
    ['white', PALETTE_ANCHOR_WHITE, CAR_PAINT_ALBEDO[0]],
    ['black', PALETTE_ANCHOR_BLACK, CAR_PAINT_ALBEDO[3]],
  ] as const) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(anchor[c] - row[c]) > 1e-9) {
        failures.push(
          `\`sky/reflection.ts\` anchors its ${name} case on (${anchor.join(', ')}) and the palette's ` +
            `${name} is (${row.join(', ')}). \`verifyReflection\` is checking a car this game does not paint.`,
        );
        break;
      }
    }
  }

  return failures;
}
