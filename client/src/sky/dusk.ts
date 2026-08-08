/**
 * Twilight: the part of the sky Preetham cannot draw, and the part of a Sydney
 * evening everybody actually remembers.
 *
 * **The gap this fills, measured rather than asserted.** `SkyMesh` is an
 * analytic *daylight* model. Its `sunIntensity` term is
 * `EE * max(0, 1 - exp(-((cutoff - acos(cosZenith)) / steepness)))` with the
 * cutoff at 92.3 degrees, so the moment the sun is more than **2.3 degrees under
 * the horizon the entire dome goes to black** -- not dim, not blue, black, in one
 * ramp about ninety seconds wide at this cycle's rate. Everything a real dusk is
 * made of happens after that: the horizon burns for twenty minutes, the
 * anti-solar sky goes pink over the Earth's own shadow, and the zenith holds a
 * cold blue for half an hour. Preetham has none of it, because none of it is
 * single-scattered sunlight arriving from above the horizon.
 *
 * So this file adds four things to the dome, all additive, all driven by
 * uniforms, all exactly zero in daylight and exactly zero in deep night:
 *
 *   1. **The vault** -- the blue hour itself, and the term that had to be added
 *      after looking at the first version of this file. Without it the sky at
 *      sunset is *Preetham's collapsing dome plus an orange band*, which is a
 *      brown horizon fading into a black-brown nothing, and every screenshot of
 *      it reads as muddy rather than as dusk. The reason is that a real twilight
 *      sky is not dark: it is a deep, saturated, *bright* blue, lit by sunlight
 *      scattering off air 30-60 km up that the ground has no view of. Nothing in
 *      a horizon-based single-scattering model produces that, and no amount of
 *      warm terms substitutes for it -- the orange only reads as orange because
 *      there is blue above it.
 *   2. **The limb** -- the warm band hugging the horizon, deepest on the sun's
 *      own bearing. Yellow while the sun is still up, orange through the
 *      crossing, red for the ten minutes after it. This is the sunset.
 *   3. **The arch** -- the anti-twilight arch, which everybody has seen and
 *      almost nobody can name: a pink-magenta band ten degrees up in the sky
 *      *opposite* the sun, sitting on top of the blue-grey wedge of the Earth's
 *      own shadow rising out of the eastern horizon. Over Sydney it faces the
 *      Pacific, which is why it reads so strongly here -- there is nothing in
 *      front of it.
 *   4. **The wash** -- a faint magenta lift across the upper sky at the deepest
 *      moment, so the top of the frame is not dead while the bottom is on fire.
 *
 * ---------------------------------------------------------------------------
 * TWO THINGS THIS FILE IS NOT ALLOWED TO DO.
 *
 * **It must not compile a pipeline while somebody is playing.** Every term below
 * is a *uniform* multiplied into a fixed node graph, built once in the
 * `DuskGrade` constructor, on the one material the sky dome has had since boot.
 * There is no branch on the time of day, no second material, no variant that
 * only exists at dusk. That is not a style preference: three folds the material
 * graph into the pipeline cache key, the boot warm-up compiles what exists at
 * boot, and a dusk-only material variant would stall the frame the sun set on --
 * which is precisely the class of bug the `PipelineWatch` in `world/warmup.ts`
 * exists to catch and which the tile precompiler pass has just finished killing.
 * The whole grade is four uniform vec3s multiplied by four fixed shapes and
 * added to the dome's own colour.
 *
 * **It must not touch daylight.** Every ramp here is zero at and above
 * `DUSK_START_ALTITUDE` (8 degrees) and zero at and below `DUSK_END_ALTITUDE`
 * (-15). The renderer is calibrated at 57.11 degrees and `verifyDuskRig`
 * asserts, as its first case, that this file contributes exactly nothing there.
 * ---------------------------------------------------------------------------
 */

import {
  Fn,
  cameraPosition,
  dot,
  exp,
  max,
  normalize,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { Vector3 } from 'three/webgpu';

import { luminance, type Rgb } from './calibration.ts';

/* ===========================================================================
 * When any of this is on.
 * ========================================================================= */

/**
 * Solar altitude at which the grade begins, degrees.
 *
 * 8 rather than 0, and the number is the golden hour rather than the sunset. The
 * horizon is already warm while the sun is well up -- what changes at 8 degrees
 * is that the *band* becomes visible as a band, separate from the haze, and that
 * is the moment a photographer would say the light had turned. Through this
 * cycle 8 degrees is 186 real seconds before the sun touches the horizon, so the
 * grade fades in over three minutes rather than arriving.
 */
export const DUSK_START_ALTITUDE = 8;

/**
 * And where it is over: the end of nautical twilight, degrees.
 *
 * -15 rather than the -18 that defines astronomical twilight, because the last
 * three degrees of that are a sky nobody can distinguish from black over a lit
 * city -- Sydney's own sky glow is brighter than the sun's at -15 -- and holding
 * a term alive down there would only mean a faint permanent stain above the
 * western horizon for a third of the night. `verifyDuskRig` asserts everything
 * is exactly zero at -15 and below.
 */
export const DUSK_END_ALTITUDE = -15;

/* ===========================================================================
 * The four colours, linear, largest channel 1.
 * ========================================================================= */

/**
 * The limb, at its deepest -- the colour the horizon reaches with the sun a
 * couple of degrees under it.
 *
 * R/G 3.3 and R/B 12.5, which is a long way past anything a blackbody produces
 * and is correct: the light making a sunset horizon has come through 38 air
 * masses of Rayleigh scattering, which is a *transmission* filter, not an
 * emitter. Blue is not reduced, it is gone -- optical depth at 440 nm over that
 * path is about 4.5, so 1% survives. The old sun-colour curve's (1, 0.70, 0.38)
 * is the right colour for the *beam at the horizon*; this is the right colour
 * for the *air the beam is lighting*, and they are not the same thing.
 *
 * Judged by eye against the tone mapper rather than derived, and the thing that
 * was actually being judged is what Neutral does to it: at exposure 0.62 a
 * linear (3.4, 1.02, 0.27) lands at rgb(247, 168, 92) with red just under the
 * clip, which is a sunset that has an orange *in* it rather than a white blob
 * with a coloured edge. Push the level up and Neutral desaturates it toward
 * white -- that is what its highlight rolloff is for -- so the way to a deeper
 * sunset is a redder colour and not a brighter one.
 */
export const LIMB_COLOUR: Readonly<Rgb> = [1.0, 0.3, 0.08];

/**
 * The limb while the sun is still up -- the golden hour rather than the sunset.
 *
 * The band is interpolated from this to `LIMB_COLOUR` as the sun crosses, which
 * is what makes the last three minutes of daylight a *progression* -- pale gold,
 * amber, orange, red -- rather than one colour that gets brighter and then goes
 * out. A single colour was the first cut of this file and it is the single most
 * obvious thing wrong with a cheap sunset.
 */
export const LIMB_COLOUR_HIGH: Readonly<Rgb> = [1.0, 0.66, 0.3];

/**
 * The anti-twilight arch: pink over the Earth's shadow.
 *
 * Magenta rather than red, and that is the physics rather than a preference.
 * The arch is *backscattered* light that has already crossed the atmosphere
 * once -- so it has been reddened -- and is then Rayleigh-scattered back toward
 * you, which lifts the blue end again. What comes out is the one hue in the sky
 * that no amount of sun-colour tinting will ever produce, and it is the reason
 * this term exists as its own colour rather than as more of the limb.
 */
export const ARCH_COLOUR: Readonly<Rgb> = [1.0, 0.55, 0.86];

/**
 * The vault: the colour of the blue hour.
 *
 * Deeper and more saturated than a daytime zenith, which is (0.31, 0.97, 2.73)
 * -- ratios 1 : 3.2 : 8.9 -- against this term's 1 : 1.9 : 4.5. That is not a
 * mistake and it is the whole character of a twilight sky: it is *bluer in name
 * and less blue in ratio*, because what is being seen is a doubly scattered
 * ozone-tinted path rather than a single Rayleigh scatter, and the Chappuis
 * absorption band that gives twilight its particular blue takes out orange and
 * yellow rather than adding blue. What the eye reads as "much bluer than the
 * day" is a matter of it being much *darker* while staying the same hue family.
 *
 * The violet lean in the red channel is the same absorption seen from the other
 * side, and it is what makes the blue hour photograph as indigo rather than as
 * cyan.
 */
export const VAULT_COLOUR: Readonly<Rgb> = [0.22, 0.42, 1.0];

/* ===========================================================================
 * How strong each one gets, in linear radiance, and where.
 * ========================================================================= */

/**
 * Peak radiance of the limb, on the sun's bearing at the horizon.
 *
 * The scale to compare it against is the dome's own: at the reference instant
 * `sky.ts` measures the Preetham horizon band at linear (6.5, 7.9, 8.3) and the
 * zenith at (0.31, 0.97, 2.73). 3.4 is therefore about half a daylight horizon
 * -- and it *replaces* a daylight horizon rather than adding to one, because by
 * the time this is at full strength Preetham has faded to a few per cent. The
 * sum peaks around linear 3.6, which is 11x the daytime zenith: the burning
 * horizon is unambiguously the brightest thing in the frame, which is what a
 * sunset is.
 */
export const LIMB_RADIANCE = 3.4;

/**
 * Peak radiance of the arch. An eleventh of the limb.
 *
 * The arch is a genuinely faint thing -- if it were not, everyone would know its
 * name -- and the failure mode of drawing it at all is drawing it too hard, at
 * which point the sky opposite the sunset is a purple gradient and the whole
 * frame reads as a screensaver. 0.30 puts it at rgb(150, 116, 141) against a
 * post-sunset sky of about rgb(40, 52, 78): clearly a band, clearly pink,
 * clearly not the subject.
 */
export const ARCH_RADIANCE = 0.3;

/**
 * Peak radiance of the vault, at the horizon.
 *
 * Set against the thing it is standing in for. At the moment of sunset the
 * Preetham dome is already down to 5.8% of its daylight output -- `SkyMesh`'s
 * `sunIntensity` is `1 - exp(-(cutoff - zenithAngle)/steepness)` with the cutoff
 * at 92.31 degrees, so at a solar altitude of 0.2 that factor is 0.029 against
 * the reference instant's 0.499 -- and it reaches zero 2.3 degrees later. So
 * over about ninety seconds of this cycle the sky loses **all** of its blue, and
 * this is what has to be there to catch it.
 *
 * 0.62 at the horizon and 0.34 at the zenith (see `VAULT_ZENITH_SHARE`) puts the
 * post-sunset zenith at linear (0.075, 0.143, 0.34), which tone maps to
 * rgb(56, 92, 143) -- a blue you can see, sitting under an orange band at
 * rgb(247, 164, 118). That contrast *is* the sunset; the version of this file
 * without the vault put the same band under a rgb(34, 22, 18) brown and every
 * screenshot of it looked like smoke.
 */
export const VAULT_RADIANCE = 0.62;

/**
 * How much of the vault survives at the zenith, against its value on the
 * horizon.
 *
 * A twilight sky is brightest low and all the way round, because the low line of
 * sight looks along a much longer illuminated path -- the same geometry that
 * makes the daytime horizon a pale haze band, at a hundredth the level. 0.55 is
 * the gradient that reads; flat would look like a coloured screen, and steeper
 * would put a hard rim on the horizon in the half of the sky the sun is not in.
 */
export const VAULT_ZENITH_SHARE = 0.55;

/**
 * The zenith wash: the arch colour spread thinly over the whole upper sky.
 *
 * A tenth of the arch, and it exists for one specific frame -- the player
 * looking straight up two minutes after sunset, when the limb is below the view
 * and the arch is behind them. Without it that frame is black. With it there is
 * a deep violet that reads as "the light has not entirely gone", which is what
 * is actually up there.
 */
export const WASH_RADIANCE = 0.03;

/* ===========================================================================
 * Preetham's own parameters, ramped.
 * ========================================================================= */

/**
 * Turbidity at the horizon end of the ramp, against `sky.ts`'s daytime 2.2.
 *
 * The cheapest big win in this file and the only one that costs nothing at all,
 * because it is a uniform the model already reads. Turbidity is the aerosol
 * loading, and in Preetham it widens and deepens the Mie forward-scattering lobe
 * around the sun -- which is what a sunset *is*, optically. At 2.2 the sun sets
 * into a thin bright line; at 4.6 it sets into a broad graded burn thirty
 * degrees wide.
 *
 * It is also honest. A clear Sydney day really is 2.0-2.5, and the same air at
 * sunset really does measure higher, because the beam is crossing 38 air masses
 * of the *boundary layer* -- the sea salt, the dust and the smoke all live in
 * the bottom kilometre, and a horizontal path samples hundreds of times more of
 * them than a vertical one. Ramping turbidity with altitude is a cheap stand-in
 * for a path-length-dependent aerosol profile, and it moves in the right
 * direction for the right reason.
 *
 * **3.3 and not the 4.6 this was first set to**, and the difference was decided
 * by looking. Preetham's turbidity does two things at once: it widens the warm
 * lobe, which is wanted, and it *desaturates the whole dome toward the aerosol
 * colour*, which above about 3.5 turns the upper sky from deep blue to a flat
 * milk-brown. At 4.6 the screenshots came back with no blue anywhere in frame
 * and the sunset read as smoke haze -- an honest picture of a bad air day and a
 * poor picture of Sydney. 3.3 keeps the widened lobe and leaves the top of the
 * sky blue for the vault to build on.
 *
 * Ramped only below `DUSK_START_ALTITUDE`, so the calibrated daytime dome --
 * zenith rgb(114, 166, 249), horizon rgb(238, 250, 254) -- is untouched.
 */
export const DUSK_TURBIDITY = 3.3;

/**
 * Mie coefficient at the same end, against the daytime 0.004.
 *
 * Turbidity sets how much aerosol there is and this sets how much of the frame
 * its forward lobe covers. `mieDirectionalG` at 0.82 keeps the lobe narrow, so
 * this mostly buys the *halo* immediately around the sun rather than the band --
 * which is exactly the thing the first screenshots of this were missing. At 2.2
 * and 0.004 the setting sun is a small hard white dot on a coloured horizon,
 * which reads as a light source pasted onto a backdrop; at 0.015 it sets inside
 * a graded glare about ten degrees across, which is what a low sun looks like
 * through humid coastal air and is what sells the last thirty seconds before it
 * goes.
 */
export const DUSK_MIE = 0.015;

/* ===========================================================================
 * Aerial perspective: the fog colour, which has to follow all of this.
 * ========================================================================= */

/**
 * The three keys the fog colour is interpolated between, linear.
 *
 * `main.ts` sets `scene.fog` to a fixed pale blue with a comment explaining that
 * fog stands in for the sky behind the thing it is fading. That is exactly right
 * and it is exactly why it cannot stay fixed: at sunset the sky behind the far
 * suburbs is orange, and a pale blue haze over a burning horizon reads as a bug
 * in the renderer rather than as distance. At night it is nearly black, and the
 * old value put a bright blue-white wash over a silhouette city.
 *
 * `FOG_DAY` is `main.ts`'s own `0xd8e8fa` converted out of sRGB, to the fourth
 * decimal, so nothing about daylight moves. The other two are the low sky at
 * their respective moments, taken off the dome rather than invented -- and both
 * are darker than they look written down, because a `Fog` colour is a linear
 * radiance the shader mixes *toward* and 0.3 of linear is a mid grey after tone
 * mapping.
 */
export const FOG_DAY: Readonly<Rgb> = [0.686685, 0.806952, 0.955973];
export const FOG_DUSK: Readonly<Rgb> = [0.72, 0.33, 0.2];
export const FOG_NIGHT: Readonly<Rgb> = [0.016, 0.026, 0.046];

/* ===========================================================================
 * The rig.
 * ========================================================================= */

/** What the twilight is doing at one instant. Everything is a pure function of altitude. */
export interface DuskRig {
  /** `SkyMesh.turbidity`. */
  turbidity: number;
  /** `SkyMesh.mieCoefficient`. */
  mieCoefficient: number;
  /** The blue hour, as linear radiance already multiplied by its colour. */
  vault: Rgb;
  /** The horizon band, likewise. */
  limb: Rgb;
  /** The anti-twilight arch, likewise. */
  arch: Rgb;
  /** The zenith wash, likewise. */
  wash: Rgb;
  /** `scene.fog.color`, linear. */
  fog: Rgb;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Smoothstep with the derivative zero at both ends, so nothing here has a corner. */
function ramp(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/**
 * A smooth bump: 0 outside `[centre - width, centre + width]`, 1 at the centre.
 * The shape every term in this file rises and falls on.
 */
function bump(x: number, centre: number, width: number): number {
  const t = clamp01(1 - Math.abs(x - centre) / width);
  return t * t * (3 - 2 * t);
}

/**
 * The whole twilight rig from the solar altitude. Pure, for `solarRig`'s reason:
 * the renderer and the self-check call this same function, so they cannot
 * disagree about what the numbers are.
 *
 * The four peaks are staggered on purpose, and the stagger is the evening's
 * whole dramatic structure:
 *
 *     altitude   +8    +3     0    -2    -4    -6    -9   -12   -15
 *     limb      0.00  0.50  0.90  1.00  0.90  0.65  0.22  0.00  0.00
 *     vault     0.00  0.10  0.50  0.78  0.97  0.97  0.65  0.22  0.00
 *     arch      0.00  0.00  0.21  0.74  0.99  1.00  0.58  0.13  0.00
 *     wash      0.00  0.00  0.00  0.18  0.55  0.90  0.99  0.36  0.00
 *
 * The limb peaks just as the sun goes; the vault and the arch peak four minutes
 * later, when the limb is already down by a third; the wash outlives all three.
 * So the frame keeps changing for the whole five minutes rather than brightening
 * and then switching off, and a player who turns round after the sun has gone
 * finds something new behind them rather than the same sky dimmer.
 */
export function duskRig(altitudeDeg: number): DuskRig {
  // The master gate: nothing at all outside the twilight window, which is what
  // makes "this file does not touch daylight" a fact rather than a hope.
  const active = altitudeDeg >= DUSK_START_ALTITUDE || altitudeDeg <= DUSK_END_ALTITUDE ? 0 : 1;

  // The limb: in from +8, peak with the sun two degrees under, gone by -12. The
  // bump's own support is the window, so there is no second gate to keep in step.
  const limbLevel = active * bump(altitudeDeg, -2, 10);
  // The colour walk, gold -> red, keyed on the crossing itself.
  const redness = ramp(6, -1, altitudeDeg);
  const limbColour = LIMB_COLOUR_HIGH.map((c, i) => c + (LIMB_COLOUR[i] - c) * redness) as Rgb;

  // The vault: takes over from Preetham as it collapses. In from +5 -- earlier
  // than the dome actually starts failing -- because it is *adding* to a sky
  // that is still bright there, and a term that waited for the collapse would
  // have to arrive fast enough to be seen arriving. Out at exactly
  // `DUSK_END_ALTITUDE`, which is why the width is 10 and not a rounder number:
  // a bump whose support ran past the window would be chopped off by `active`
  // and leave a step of a tenth of a unit of radiance in the sky.
  const vaultLevel = active * bump(altitudeDeg, -5, 10);

  // The arch: nothing until the sun is actually down, peak at -5, gone by -14.
  const archLevel = active * bump(altitudeDeg, -5, 9) * ramp(1.5, -1.5, altitudeDeg);
  // The wash starts at the crossing, peaks at -7.5 and dies exactly where the
  // window does, so nothing has to clamp it off and leave a step behind.
  const washLevel = active * bump(altitudeDeg, -7.5, 7.5);

  // Preetham's own two, ramped in over the golden hour and then held. They stay
  // held through the night rather than ramping back: the dome is black down
  // there and its parameters buy nothing either way, and a second ramp would be
  // a second thing to keep in step for no visible reason.
  const thick = ramp(DUSK_START_ALTITUDE, 1, altitudeDeg);

  // The fog: pale blue by day, the limb's own colour through dusk, near-black at
  // night. Two ramps rather than three keys interpolated at once, so the day
  // value is reached *exactly* rather than approached.
  const warm = bump(altitudeDeg, 0, 12);
  const dark = ramp(2, -8, altitudeDeg);
  const fog = FOG_DAY.map((d, i) => {
    const warmed = d + (FOG_DUSK[i] - d) * warm;
    return warmed + (FOG_NIGHT[i] - warmed) * dark;
  }) as Rgb;

  return {
    turbidity: 2.2 + (DUSK_TURBIDITY - 2.2) * thick,
    mieCoefficient: 0.004 + (DUSK_MIE - 0.004) * thick,
    vault: VAULT_COLOUR.map((c) => c * VAULT_RADIANCE * vaultLevel) as Rgb,
    limb: limbColour.map((c) => c * LIMB_RADIANCE * limbLevel) as Rgb,
    arch: ARCH_COLOUR.map((c) => c * ARCH_RADIANCE * archLevel) as Rgb,
    wash: ARCH_COLOUR.map((c) => c * WASH_RADIANCE * washLevel) as Rgb,
    fog,
  };
}

/* ===========================================================================
 * The node.
 * ========================================================================= */

/**
 * How tightly the limb hugs the horizon: the exponential falloff rate in units
 * of `sin(elevation)`.
 *
 * 12 puts the band at 1/e by 4.8 degrees up and 1/20 by 14, which is measured
 * off photographs: the *hot* part of a sunset band is a good deal tighter than
 * it looks in memory, and what makes it read as tall is the gradient above it,
 * which here is the vault's job and not this one.
 *
 * **Was 7.5, and the change came out of screenshots.** At 7.5 the warm term was
 * still worth a fifth of its peak 20 degrees up, which put a brown haze over the
 * part of the sky that has to stay blue for the orange to read as orange. It
 * looked like smoke. Narrowing it and adding the vault under it are two halves
 * of one fix and neither works alone.
 *
 * Symmetric about the horizon, because the dome is a sphere and the part of it
 * below the horizon is what the far water and the distant suburbs are seen
 * against.
 */
const LIMB_FALLOFF = 12;

/**
 * How much of the limb reaches the horizon *away* from the sun.
 *
 * Not zero, and this is the term that stops the sunset being a spotlight. The
 * whole ring of horizon lifts at dusk, because the air over there is being lit
 * by the same low sun from below -- what changes with bearing is how much. 0.10
 * against 1.0 on the sun's own bearing is roughly what a 360-degree panorama
 * measures once the anti-solar side has the arch taken out of it, and it is also
 * what makes the *city* read: the streets running north-south catch it at their
 * far ends.
 */
const LIMB_AMBIENT = 0.1;

/** How sharply the limb concentrates on the sun's bearing. */
const LIMB_BEARING_POWER = 1.6;

/** The same, for the arch, which is broader -- it is a backscatter lobe. */
const ARCH_BEARING_POWER = 1.1;

/**
 * The arch's band: elevations in `sin` units.
 *
 * It sits *above* the Earth's shadow rather than on the horizon, and that gap is
 * the whole reason it reads as an arch rather than as a second sunset. The lower
 * edge is the shadow's top, which really does climb -- it starts on the horizon
 * at sunset and is 10-15 degrees up ten minutes later -- and holding it at a
 * fixed 1.7 degrees rather than animating it is the one place this file
 * knowingly simplifies, because the alternative is a fifth uniform to carry a
 * motion nobody has ever consciously noticed.
 */
const ARCH_LO = 0.03;
const ARCH_MID = 0.13;
const ARCH_HI = 0.42;

/**
 * The twilight grade, as a wrapper around `SkyMesh`'s own colour node.
 *
 * Sits **between** the dome and the clouds: `sky.ts` builds this over the
 * material's Preetham node and then hands the result to `CloudLayer`, so the
 * clouds composite over an already-burning sky and read as silhouettes against
 * it. That ordering is the difference between a sunset with clouds in it and a
 * sunset with clouds painted on top of it, and it costs nothing -- `CloudLayer`
 * already takes the sky as a node argument and evaluates it once into a local.
 *
 * Cost: three `dot`s, two `pow`s, one `exp`, three smoothsteps and three fused
 * multiply-adds on a vec3 -- about 40 scalar operations, on sky pixels only, on
 * top of the 670 the cloud layer already spends there. Under 0.05 ms at 1440p
 * with the sky at 40% of the frame, and zero on the frames where the sky is not
 * visible at all.
 */
export class DuskGrade {
  /** The node to hand to `CloudLayer`, or to assign to a material. */
  readonly colourNode: ReturnType<typeof vec4>;

  // Radiances, not swatches: `Vector3` rather than `Color`, for `CloudLayer`'s
  // reason -- a `Color` would invite a working-colour-space conversion that
  // would silently halve them.
  private readonly vault = uniform(new Vector3());
  private readonly limb = uniform(new Vector3());
  private readonly arch = uniform(new Vector3());
  private readonly wash = uniform(new Vector3());

  /**
   * @param skyColour   the material's existing `colorNode`, a vec4.
   * @param sunPosition `SkyMesh`'s own sun uniform, passed rather than
   *                    duplicated so the grade and the dome can never disagree
   *                    about where the sun is.
   */
  constructor(skyColour: any, sunPosition: any) {
    this.colourNode = Fn(() => {
      const sky: any = skyColour.toVar();
      const dir: any = normalize(positionWorld.sub(cameraPosition)).toVar();
      const sunDir: any = normalize(sunPosition).toVar();

      // The sun's *bearing*, with its elevation projected out, exactly as
      // `clouds.ts` does it and for the same reason: a full 3D dot would
      // conflate "toward the sun" with "high in the sky", and at dusk those two
      // have opposite effects. No guard needed against a zero-length horizontal
      // component -- at latitude -33.87 the sun never reaches the zenith, which
      // `verifySouthernHemisphere()` checks.
      const bearing: any = normalize(vec3(sunDir.x, 0.0, sunDir.z));
      const toward: any = dot(dir, bearing).toVar();

      // The vault: the whole dome, brightest low and all the way round. No
      // bearing term at all -- twilight blue is the one part of the sky that
      // does not care which way the sun went, and giving it one would turn it
      // into a third directional glow.
      const vault: any = this.vault.mul(
        smoothstep(0.0, 1.0, dir.y)
          .mul(VAULT_ZENITH_SHARE - 1)
          .add(1.0),
      );

      // The limb: an exponential collar on the horizon, weighted toward the sun
      // but never zero anywhere on it.
      const collar: any = exp(dir.y.abs().mul(-LIMB_FALLOFF));
      const sunward: any = pow(saturate(toward), LIMB_BEARING_POWER)
        .mul(1 - LIMB_AMBIENT)
        .add(LIMB_AMBIENT);
      const limb: any = this.limb.mul(collar.mul(sunward));

      // The arch: a band above the anti-solar horizon. The lower smoothstep is
      // the top of the Earth's shadow and the upper one is where it gives out
      // into the blue; between them is the pink.
      const band: any = smoothstep(ARCH_LO, ARCH_MID, dir.y).mul(
        smoothstep(ARCH_MID, ARCH_HI, dir.y).oneMinus(),
      );
      const away: any = pow(saturate(toward.negate()), ARCH_BEARING_POWER);
      const arch: any = this.arch.mul(band.mul(away));

      // And the wash, which has no bearing dependence at all -- it is the whole
      // upper sky, and giving it one would make it a third arch.
      const wash: any = this.wash.mul(max(dir.y, 0.0));

      return vec4(sky.xyz.add(vault).add(limb).add(arch).add(wash), sky.w);
      // Cast for the same reason `clouds.ts` types its node fields loosely: TSL's
      // return types are structural and a `vec4` built from a join does not
      // match one built from a const, which is a distinction with no meaning at
      // this boundary -- `CloudLayer` takes the node as `any` and evaluates it.
    })() as unknown as ReturnType<typeof vec4>;
  }

  /**
   * Push the rig for a solar altitude into the uniforms. Called from the same
   * place `sky.ts` applies the light rig, so the twilight and the sun are never
   * a frame apart.
   */
  setSolarAltitude(altitudeDeg: number): void {
    const rig = duskRig(altitudeDeg);
    this.vault.value.set(...rig.vault);
    this.limb.value.set(...rig.limb);
    this.arch.value.set(...rig.arch);
    this.wash.value.set(...rig.wash);
  }
}

/**
 * Startup self-check, in the same spirit as `verifyLightRig()` and
 * `verifyCloudRig()`: **what this file gets wrong will be wrong silently.**
 *
 * A grade that leaks into daylight lifts every horizon in the game by a few code
 * values and reads as a taste decision. One that never switches off leaves an
 * orange stain over the western sky at two in the morning, which reads as a
 * bloom artefact. One whose terms all peak together produces a sunset that
 * brightens and then stops, which reads as "the sunset is a bit flat". None of
 * them throws, and none of them has a frame that says so.
 */
export function verifyDuskRig(): string[] {
  const failures: string[] = [];

  // --- 1. Daylight is untouched. The first case, because it is the one that
  //        invalidates every predicted display value in `calibration.ts`,
  //        `clouds.ts` and `facade.ts` at once if it fails.
  for (const alt of [57.11, 56.34, 30, 12, DUSK_START_ALTITUDE]) {
    const rig = duskRig(alt);
    const lit =
      luminance(rig.vault) + luminance(rig.limb) + luminance(rig.arch) + luminance(rig.wash);
    if (lit !== 0 || rig.turbidity !== 2.2 || rig.mieCoefficient !== 0.004) {
      failures.push(
        `The twilight grade is contributing at ${alt} degrees of solar altitude ` +
          `(radiance ${lit.toExponential(2)}, turbidity ${rig.turbidity.toFixed(3)}, mie ` +
          `${rig.mieCoefficient.toFixed(4)}). It must be exactly zero at and above ` +
          `DUSK_START_ALTITUDE (${DUSK_START_ALTITUDE} deg): the renderer is calibrated at 57.11 ` +
          `and every display value in calibration.ts, clouds.ts and facade.ts was measured with ` +
          `the dome at turbidity 2.2 and nothing added to it.`,
      );
    }
  }

  // --- 2. And night is untouched, at the other end. An orange band that never
  //        goes out is the single most common way a hand-rolled twilight fails.
  for (const alt of [DUSK_END_ALTITUDE, -20, -40, -56]) {
    const rig = duskRig(alt);
    const lit =
      luminance(rig.vault) + luminance(rig.limb) + luminance(rig.arch) + luminance(rig.wash);
    if (lit !== 0) {
      failures.push(
        `The twilight grade is still lit at ${alt} degrees (radiance ${lit.toExponential(2)}). It ` +
          `must be exactly zero at and below DUSK_END_ALTITUDE (${DUSK_END_ALTITUDE} deg), or the ` +
          `western sky carries a stain through the whole night -- which reads as a bloom artefact ` +
          `rather than as a bug in this file.`,
      );
    }
  }

  // --- 3. Something happens in between, and it happens *hard*. The failure this
  //        catches is a grade that is present, correct, continuous and far too
  //        faint to see, which is what every one of these looks like before it
  //        is tuned.
  let peakLimb = 0;
  let peakLimbRed = 0;
  let peakLimbBlue = 0;
  let peakArch = 0;
  for (let alt = DUSK_START_ALTITUDE; alt >= DUSK_END_ALTITUDE; alt -= 0.05) {
    const rig = duskRig(alt);
    if (rig.limb[0] > peakLimbRed) {
      peakLimbRed = rig.limb[0];
      peakLimbBlue = rig.limb[2];
    }
    peakLimb = Math.max(peakLimb, luminance(rig.limb));
    peakArch = Math.max(peakArch, luminance(rig.arch));
  }
  // The daytime zenith, from `sky.ts`: linear (0.306, 0.970, 2.726). Compared
  // channel-for-brightest-channel rather than by luminance, and that is not a
  // dodge: Rec. 709 luminance weights green at 0.72 and red at 0.21, so a band
  // that is *made of red* scores a third of what a blue sky of the same
  // perceived brightness does. What is being asserted is that the brightest
  // thing in a twilight frame beats the brightest thing in a daylight one.
  if (!(peakLimbRed > 2.726 * 1.2)) {
    failures.push(
      `The sunset limb peaks at ${peakLimbRed.toFixed(3)} of linear radiance in its brightest ` +
        `channel, against the daytime zenith's 2.726 of blue -- under the 1.2x that makes the ` +
        `burning horizon the brightest thing anywhere in the game. Check LIMB_RADIANCE ` +
        `(${LIMB_RADIANCE}); a sunset nobody can see is indistinguishable from one that was never ` +
        `implemented.`,
    );
  }
  // And it has to stay orange as it gets there. Neutral tone mapping desaturates
  // saturated brights toward white on purpose -- that is what its highlight
  // rolloff is for -- so the way to a deeper sunset is a *redder* colour and not
  // a brighter one, and a limb that has been solved by turning the level up is a
  // limb that tone maps to a white blob with a coloured edge.
  if (!(peakLimbRed > peakLimbBlue * 6)) {
    failures.push(
      `The sunset limb peaks at R/B ${(peakLimbRed / Math.max(peakLimbBlue, 1e-9)).toFixed(1)}, under ` +
        `the 6:1 that keeps it orange through Neutral tone mapping at exposure 0.62. A sun on the ` +
        `horizon has crossed 38 air masses and about 1% of its blue survives, so anything paler than ` +
        `this is not a physical sunset -- and Neutral will wash whatever blue is left toward white ` +
        `as soon as the band clips. Check LIMB_COLOUR.`,
    );
  }
  if (!(peakArch > 0.05 && peakArch < peakLimb * 0.4)) {
    failures.push(
      `The anti-twilight arch peaks at ${peakArch.toFixed(3)} against the limb's ` +
        `${peakLimb.toFixed(3)}. It has to be visible and it has to stay the supporting act: above ` +
        `40% of the limb the sky opposite the sunset is a purple gradient and the frame reads as a ` +
        `screensaver. Check ARCH_RADIANCE (${ARCH_RADIANCE}).`,
    );
  }

  // --- 4. The stagger. The arch must peak *after* the limb, by a real margin,
  //        or the whole evening is one event instead of three.
  const peakAt = (pick: (r: DuskRig) => Rgb): number => {
    let best = DUSK_START_ALTITUDE;
    let bestValue = -1;
    for (let alt = DUSK_START_ALTITUDE; alt >= DUSK_END_ALTITUDE; alt -= 0.05) {
      const v = luminance(pick(duskRig(alt)));
      if (v > bestValue) {
        bestValue = v;
        best = alt;
      }
    }
    return best;
  };
  const limbPeak = peakAt((r) => r.limb);
  const vaultPeak = peakAt((r) => r.vault);
  const archPeak = peakAt((r) => r.arch);
  const washPeak = peakAt((r) => r.wash);
  if (!(limbPeak > archPeak + 1.5 && limbPeak > vaultPeak + 1.5 && archPeak > washPeak + 1)) {
    failures.push(
      `The twilight terms are not staggered: the limb peaks at ${limbPeak.toFixed(1)} deg, the ` +
        `vault at ${vaultPeak.toFixed(1)}, the arch at ${archPeak.toFixed(1)} and the wash at ` +
        `${washPeak.toFixed(1)}. They must fire in that order with real gaps -- the limb as the sun ` +
        `goes, the vault and the arch four minutes later, the wash outliving all of them. Peaking ` +
        `together gives a sunset that brightens and then switches off, which is the single most ` +
        `obvious tell of a cheap one.`,
    );
  }

  // 4b. **The blue hour exists**, which is the case added after the first
  //     version of this file was looked at rather than reasoned about. Preetham
  //     is at 5.8% of daylight by the moment of sunset and zero 2.3 degrees
  //     later, so without a term of its own the sky has no blue in it at all and
  //     the orange band sits on brown. Asserted as a *ratio to the limb*, because
  //     what actually failed was not the level of either but the contrast
  //     between them.
  let peakVaultBlue = 0;
  for (let alt = DUSK_START_ALTITUDE; alt >= DUSK_END_ALTITUDE; alt -= 0.05) {
    peakVaultBlue = Math.max(peakVaultBlue, duskRig(alt).vault[2]);
  }
  if (!(peakVaultBlue > 0.25 && peakVaultBlue > peakLimbRed * 0.1)) {
    failures.push(
      `The twilight vault peaks at ${peakVaultBlue.toFixed(3)} of blue against the limb's ` +
        `${peakLimbRed.toFixed(2)} of red. There has to be a real blue sky above the sunset or the ` +
        `orange has nothing to be orange against -- the version of this file without a vault put a ` +
        `rgb(247, 164, 118) band under a rgb(34, 22, 18) brown and read as smoke. Check ` +
        `VAULT_RADIANCE (${VAULT_RADIANCE}).`,
    );
  }

  // --- 5. No corners. Every one of these is a smoothstep or a bump, so the
  //        whole grade should be continuous to well under a display value across
  //        a step the cycle crosses in a fifth of a second.
  let worstStep = 0;
  let previous = duskRig(DUSK_START_ALTITUDE + 1);
  for (let alt = DUSK_START_ALTITUDE + 1; alt >= DUSK_END_ALTITUDE - 1; alt -= 0.02) {
    const rig = duskRig(alt);
    for (const key of ['vault', 'limb', 'arch', 'wash', 'fog'] as const) {
      for (let i = 0; i < 3; i++) {
        worstStep = Math.max(worstStep, Math.abs(rig[key][i] - previous[key][i]));
      }
    }
    worstStep = Math.max(worstStep, Math.abs(rig.turbidity - previous.turbidity));
    previous = rig;
  }
  if (worstStep > 0.02) {
    failures.push(
      `The twilight grade steps by ${worstStep.toFixed(4)} of linear radiance over 0.02 degrees of ` +
        `solar altitude. At this cycle's rate that is a fifth of a second, so anything this size is a ` +
        `visible pop in the sky. Every ramp here is a smoothstep for exactly this reason -- check ` +
        `whether one has been replaced with a clamp or a threshold.`,
    );
  }

  // --- 6. The fog reaches the day value *exactly*, or `main.ts`'s calibrated
  //        aerial perspective has silently moved.
  const dayFog = duskRig(57.11).fog;
  for (let i = 0; i < 3; i++) {
    if (dayFog[i] !== FOG_DAY[i]) {
      failures.push(
        `The daytime fog colour is (${dayFog.map((c) => c.toFixed(4)).join(', ')}) rather than ` +
          `FOG_DAY (${FOG_DAY.map((c) => c.toFixed(4)).join(', ')}), which is main.ts's own 0xd8e8fa. ` +
          `The ramps have to *reach* the day value rather than approach it, or every distant ` +
          `building in daylight is fogged toward a colour nobody chose.`,
      );
      break;
    }
  }

  return failures;
}
