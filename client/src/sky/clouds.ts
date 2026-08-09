/**
 * Scattered fair-weather cumulus, high cirrus, and the haze that swallows them.
 *
 * The dome was correct and sterile: right colours, zero structure, and the one
 * thing that gives a sky its scale -- something *in* it at a known distance --
 * missing entirely. This is that something. A hot February afternoon over
 * Sydney has hard blue overhead, a scattered band of small bright-white cumulus
 * bunched low in the distance, sometimes a few cirrus streaks high up, and the
 * horizon's pale haze band that Preetham already gives us for free.
 *
 * **Visual only.** Nothing here reaches the sun, the shadow rig or anything in
 * `calibration.ts`. There are no cloud shadows on the ground and there should
 * not be: at 20-30% scattered coverage with bases at 1,800 m, the shadow of any
 * given cumulus is a kilometre-wide patch that a player at street level inside a
 * built-up city would never resolve as cloud-shaped. What it *would* do is
 * silently break the calibrated sun:shade ratio the whole of `calibration.ts`
 * exists to pin. So the clouds read radiance *from* the rig and write nothing
 * back.
 *
 * ---------------------------------------------------------------------------
 * Why this is not `SkyMesh`'s built-in cloud layer
 *
 * `sky.ts` has carried `cloudCoverage = 0` and a note that the built-in layer
 * resolved to about 0.015 of linear radiance against a sky of 0.3 to 8.3. That
 * measurement is confirmed and its cause is now known. `SkyMesh.js` builds a
 * reflectance-like triple in roughly 0-1.5 and then scales it by
 * `vSunE * 0.00002`; `vSunE` is 499 at the reference instant, so the scale is
 * 0.00998 and the layer tops out near 0.015-0.05. The *sky* beside it takes
 * `(Lin + L0)`, which is order 10-100, and scales it by 0.04. The cloud layer
 * was authored against an exposure regime where the whole sky sits under 1.0 and
 * dropped next to a Preetham dome that does not -- 20x to 180x too dark at the
 * zenith, which is exactly the dark grey blotches the old note describes.
 *
 * A radiance multiplier keyed to the sky's brightness would fix the *level*, and
 * it would still be the wrong layer, for four reasons a uniform cannot reach --
 * they are local `const`s inside an `Fn` closure in `node_modules`, and the only
 * exposed uniforms are scale, speed, coverage, density and elevation:
 *
 *   - Coverage does not control coverage. The field is
 *     `fbm(uv*1000) + 0.5*fbm(uv*2000)` remapped to `*0.5 + 0.5`, whose mean is
 *     0.86 in a range of 0.5-1.23; the threshold is `smoothstep(1 - coverage,
 *     1 - coverage + 0.3, field)`. At the default 0.4 that is
 *     `smoothstep(0.6, 0.9, x)` against a field that mostly sits above 0.9. No
 *     setting of `cloudCoverage` produces a 20-30% scattered deck.
 *   - `daylight = max(0, sunDir.y * 2)` is fed to a `mix` unclamped, so at the
 *     reference sun it is 1.68 and the intended 0.3-1.0 brightness range
 *     overshoots to 1.48. Cloud brightness then swings with sun height on a
 *     curve unrelated to the calibrated rig.
 *   - The horizon handling is a hard opacity fade to nothing, not a blend into
 *     the haze. This project needs the opposite: clouds that dissolve *into* the
 *     pale band that `scene.fog` is colour-matched to.
 *   - There is no shading. `cloudMask` is a flat alpha over a colour with no
 *     dependence on which face of the cloud you are looking at, so there are no
 *     flat grey bases, no sunward flanks, no modelling. Its one directional term
 *     brightens clouds *toward* the sun, which is backwards -- see `BACKLIT_DEPTH`.
 *
 * It is also twice the budget: two five-octave `fbm`s is ten noise evaluations
 * and forty hashes, inside a `Loop`, which is the construct the README records
 * as having blown up pipeline compilation in `facade.ts`.
 *
 * So `cloudCoverage` stays at 0 permanently and this composites into the same
 * material's colour node instead. Same material, so the `fog = false` fix in
 * `sky.ts` still covers it and there is no second dome to give a render order,
 * a depth state and a fog flag to -- getting any one of those wrong is how the
 * fogged-dome bug comes back.
 *
 * ---------------------------------------------------------------------------
 * Predicted display values, 3 pm on 15 February, by the method at the top of
 * `calibration.ts` -- linear radiance, exposure 0.62, Neutral tone mapping,
 * sRGB encode. The same evaluation reproduces `sky.ts`'s published zenith
 * rgb(114, 166, 249) and horizon rgb(238, 250, 254) exactly, which is what says
 * the arithmetic below is on the right scale.
 *
 *   sunward face, square-on to the beam   linear 5.05, 5.27, 5.56   rgb(245, 248, 253)
 *   sunward flank, ~60 deg off the beam   linear 2.76, 2.97, 3.27   rgb(235, 242, 251)
 *   shaded base                           linear 0.81, 0.99, 1.24   rgb(181, 200, 222)
 *   zenith sky behind them                linear 0.31, 0.97, 2.73   rgb(114, 166, 249)
 *
 * Composited over the sky at the alpha the mask actually produces:
 *
 *   cumulus 12 deg up, away from the sun    rgb(229, 238, 251)  over sky rgb(160, 203, 252)
 *   cumulus 25 deg up, away from the sun    rgb(226, 235, 250)  over sky rgb(126, 177, 250)
 *   cumulus 25 deg up, across the sun       rgb(216, 229, 248)  over sky rgb(146, 187, 252)
 *   cumulus 25 deg up, toward the sun       rgb(200, 219, 246)  over sky rgb(175, 205, 253)
 *   forward-scatter halo, 8 deg off the sun rgb(230, 239, 252)  over sky rgb(212, 229, 254)
 *   cloud base at the zenith                rgb(187, 207, 235)  over sky rgb(123, 172, 250)
 *   cirrus over the zenith                  rgb(142, 180, 249)  over sky rgb(113, 166, 249)
 *
 * The three things to read out of that table. The lit flanks land 226-235 in red
 * against a sky of 126-185, so they are unambiguously the brightest thing in the
 * frame short of the sun, and they get there by lifting *red and green* while
 * blue is already clipped -- which is what "white" means at this exposure. The
 * bases land at rgb(181, 200, 222), a grey-blue that sits above the zenith blue
 * in red and below it in blue. And the toward-sun clouds are 26 code values
 * darker than the away-from-sun ones, which is the directional modelling that
 * stops a cloud field reading as wallpaper.
 *
 * Cirrus lifts the zenith by 29 code values of red at its densest wisp. That is
 * a pale streak, not a cloud, which is the whole point of it -- see
 * `CIRRUS_OPACITY`.
 *
 * ---------------------------------------------------------------------------
 * Cost, counted rather than guessed.
 *
 * Building this node through three's own `WGSLNodeBuilder` emits 150 statements
 * and no control flow at all -- no branch, no loop, no discard. Six value-noise
 * evaluations (four cumulus octaves, two cirrus), 24 hashes, and about 670
 * scalar ALU operations per pixel on top of Preetham's own. At 1440p with the
 * sky covering 40% of the frame that is roughly 1 GFLOP a frame, a few tenths
 * of a millisecond on an integrated GPU -- and at street level in a built city
 * the sky is a good deal less than 40% of the frame.
 *
 * The one surprise the emitted WGSL turned up, recorded because it looks like
 * this file's cost and is not: `SkyMesh`'s own cloud block is still *compiled*
 * with `cloudCoverage` at zero. It is guarded by
 * `If(direction.y > 0 && cloudCoverage > 0)`, which is a runtime branch on a
 * uniform rather than anything the shader compiler can fold away, so the two
 * five-iteration `Loop`s and their forty sin-hashes sit in the binary
 * permanently. No frame time -- the branch is never taken -- but it is shader
 * size, and shader size is what the README records as having blocked the main
 * thread during pipeline compilation in `facade.ts`. Removing it means not
 * using `SkyMesh` at all, which would mean reimplementing Preetham; not worth
 * it, but worth knowing where those loops came from if this shader is ever
 * profiled.
 */

import {
  Fn,
  abs,
  cameraPosition,
  dot,
  float,
  floor,
  fract,
  max,
  mix,
  normalize,
  positionWorld,
  pow,
  saturate,
  smoothstep,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { Vector3 } from 'three/webgpu';

import { luminance, solarRig, warmthAt, type Rgb } from './calibration.ts';

/* ===========================================================================
 * How bright a cloud is, from the rig that already decides how bright
 * everything else is.
 *
 * A cloud is a diffuse reflector of near-unit albedo, so it goes through the
 * same chain as any other surface in `calibration.ts`: `albedo / pi * E`. The
 * only difference is that a cloud presents three quite different faces to the
 * camera at once, and which one you are looking at is a function of where in
 * the sky it is. So the CPU computes all three and the shader mixes between
 * them -- every day/night, sunset and colour decision lives here in TypeScript
 * where it can be evaluated offline, and the shader is three mixes.
 * ========================================================================= */

/**
 * Bulk albedo of a water-droplet cumulus. Single-scatter albedo is essentially
 * 1 -- cloud droplets absorb almost nothing in the visible -- and what takes the
 * bulk figure down is light escaping out of the sides and bottom rather than
 * back toward you. 0.9 is the standard figure for an optically thick cumulus.
 */
const CLOUD_ALBEDO = 0.9;

/**
 * Cosine of the angle between the beam and the cloud face you actually see.
 *
 * This is the number that decides whether the sky reads or blows out, and it is
 * geometry rather than taste. A face *square-on* to the beam takes the whole of
 * it and lands at linear 5.24, which through Neutral at 0.62 is rgb(245,248,253)
 * -- clipped. If that were the everyday value of a lit cloud, every cloud in
 * frame would be one flat white shape with no form in it, which is as synthetic
 * as the empty gradient this replaces.
 *
 * A cumulus is a lumpy blob. Almost none of its visible surface is square-on to
 * the sun; the flank you are looking at typically sits 50-70 degrees off the
 * beam. 0.5 is cos(60), and it puts the everyday lit flank at linear 2.95 and
 * rgb(235, 242, 251) -- bright white, still under the clip, and with the tonal
 * room between it and the base at rgb(181, 200, 222) for the cloud to have a
 * shape. The square-on value is not discarded: it is `sunward` below, and the
 * forward-scatter term reaches it. That the halo's ceiling is the physical
 * square-on radiance rather than a tuned number is the reason the boost has no
 * free parameter in it.
 */
const FLANK_COSINE = 0.5;

/**
 * Fraction of the beam that makes it through the cloud to light its underside.
 *
 * A fair-weather cumulus is 400-800 m thick, so this is small but not zero --
 * the base of a small cumulus is grey, not black, and a good part of why is
 * light that entered the top and diffused down. Together with `BASE_SKY_VIEW`
 * it puts the base:flank radiance ratio at 0.33, inside the 0.25-0.45 that
 * measured cumulus run, and lands the base at rgb(181, 200, 222).
 */
const BASE_TRANSMISSION = 0.09;

/**
 * How much of the skylight a "base" pixel is really collecting.
 *
 * Above 1/2 and it looks like a fudge, so: a cumulus base is not a flat plate,
 * and what you read as the base is the underside plus the near flanks curving
 * up out of it. Those flanks see most of the sky. 0.85 is that mixture, and it
 * is the term that keeps the base a *blue-grey* rather than the warm dark the
 * hemisphere's ground colour alone would give a downward-facing surface.
 */
const BASE_SKY_VIEW = 0.85;

/**
 * Cloud opacity floor after dark, as a fraction of the daytime value.
 *
 * Spec 6.4's night is carried by the silhouette and the lit windows. The clouds
 * go with it: their radiance already collapses to the hemisphere fill alone
 * (linear 0.02, rgb(2, 14, 27)) because the beam term goes to zero with the sun,
 * and pulling the opacity down as well stops the mask drawing hard-edged shapes
 * across a sky that has nothing else in it. Measured at `KeyN`: clouds composite
 * to rgb(0, 3, 8) against a sky of rgb(0, 0, 0) to rgb(3, 1, 0). Invisible in
 * any honest sense, and faintly *lighter* than the dome rather than darker,
 * because Preetham's night sky is essentially zero and nothing can be darker
 * than that.
 */
const NIGHT_OPACITY = 0.3;

/** Zenith radiance of the dome at the reference instant, from `sky.ts`. */
const ZENITH_RADIANCE: Rgb = [0.306, 0.970, 2.726];

/** The three faces of a cloud, in linear radiance, plus the global opacity. */
export interface CloudRig {
  /** A face square-on to the beam. The ceiling of the forward-scatter halo. */
  sunward: Rgb;
  /** The sunward flank at ~60 degrees off the beam: the everyday lit value. */
  flank: Rgb;
  /** The shaded underside. */
  base: Rgb;
  /** Global opacity multiplier, 1 by day and `NIGHT_OPACITY` after dark. */
  opacity: number;
}

/**
 * The whole cloud rig from the solar altitude, in the same spirit as
 * `solarRig()`: one pure function, so the renderer and the self-check cannot
 * disagree about what the numbers are.
 */
/**
 * How much further above the horizon the sun is **as seen from a cloud base**,
 * degrees.
 *
 * `acos(R / (R + h))` for R = 6,371 km and h = `CUMULUS_ALTITUDE`: the dip of the
 * true horizon from 1,800 m up. Small, obvious once stated, and the whole of
 * why a sunset has clouds on fire in it.
 *
 * **The ground goes into shadow first.** A cumulus base at 1,800 m keeps its
 * direct beam for another 1.36 degrees of solar altitude after the street below
 * it has lost the sun -- which through this cycle is **another 32 real seconds**,
 * and, far more importantly, means that at the *moment* of sunset the ground is
 * receiving nothing while the deck overhead is still taking a full grazing beam.
 * That is the picture everybody has of a Sydney sunset: a dark street, a burning
 * horizon, and the underside of the cloud lit orange from below.
 *
 * Before this the clouds used the ground's own solar altitude, so they went out
 * with the street and the last two minutes of every day had a spectacular sky
 * with flat grey cloud sitting in front of it. One term, exactly derived, and
 * the whole reason it is worth having is that the *order* the two go out in is
 * the thing the eye reads.
 *
 * It applies to the beam only. The skylight a cloud collects is the same sky the
 * ground sees to within a rounding error, so `fill` below is still built from
 * the ground's rig -- and the night gate on the warm tint is still the ground's,
 * which is what stops this term leaving lit clouds over a dark city.
 *
 * A function rather than a constant only because `CUMULUS_ALTITUDE` is declared
 * further down this file, with the rest of the cumulus geometry it belongs
 * beside; evaluating at call time is a `Math.acos` a frame and keeps the deck's
 * height stated in exactly one place.
 */
export function cloudHorizonDip(): number {
  const R = 6_371_000;
  return (Math.acos(R / (R + CUMULUS_ALTITUDE)) * 180) / Math.PI;
}

export function cloudRig(altitudeDeg: number, cover = 0): CloudRig {
  const rig = solarRig(altitudeDeg);
  // The beam a *cloud* receives, from a sun that is still up for it. See
  // `cloudHorizonDip`.
  const beamRig = solarRig(altitudeDeg + cloudHorizonDip());
  const k = CLOUD_ALBEDO / Math.PI;

  /**
   * The low sky a cloud can see, and the term that makes sunsets work.
   *
   * The obvious way to warm a cloud base at dusk is to tint it by `sunColour`,
   * and it is wrong in both directions: it leaves the *tops* cold, because by
   * the time the sun is at 3 degrees the Beer-Lambert falloff has taken the beam
   * to 0.9% of noon and the flank is lit by skylight alone -- so the base ends
   * up warmer than the top, which is a sunset upside down. What actually
   * happens is that at low sun the whole western sky a cloud sees *is* the
   * reddened air the beam came through. So the warmth goes on the skylight
   * term, where it lifts all three faces together and keeps their order.
   *
   * `under` is `calibration.ts`'s own warmth curve -- **imported now rather than
   * copied**, because the day/night pass moved its knee from 32 degrees to 42 and
   * a second copy of that expression is how the clouds end up turning gold eight
   * minutes after the light does. `day` is the civil-twilight ramp. Multiplying
   * by `day` is what stops the tint surviving into the night: below the horizon
   * `under` is 1 and `sunColour` is still the sunset orange it froze at, so
   * without the gate the night sky would carry orange clouds under it.
   */
  const under = warmthAt(altitudeDeg);
  const day = clamp01((altitudeDeg + 6) / 12);
  const fill = rig.skyColour.map(
    (s, i) => (s + (rig.sunColour[i] - s) * under * day) * rig.hemisphereIntensity,
  ) as Rgb;

  const beam = beamRig.sunColour.map((c) => c * beamRig.sunIntensity) as Rgb;

  return {
    sunward: beam.map((b, i) => k * (b + fill[i])) as Rgb,
    flank: beam.map((b, i) => k * (b * FLANK_COSINE + fill[i])) as Rgb,
    base: beam.map((b, i) => k * (b * BASE_TRANSMISSION + fill[i] * BASE_SKY_VIEW)) as Rgb,
    /* The night opacity pull-down, and why cover overrides it.
     *
     * `NIGHT_OPACITY` exists so that a *scattered* deck stops drawing hard-edged
     * shapes across a night sky that has nothing else in it -- which was right
     * when the deck was always scattered and is exactly wrong for an overcast
     * night, where the lid is the brightest thing in the sky and the whole
     * subject of the picture. So cover takes it back: at full cover the deck is
     * as opaque at night as it is at noon. `max` rather than a blend, because
     * the two reasons are independent -- a cloudy afternoon should not be less
     * opaque than a cloudy midnight. */
    opacity: NIGHT_OPACITY + (1 - NIGHT_OPACITY) * Math.max(day, clamp01(cover)),
  };
}

/**
 * Startup self-check, in the same spirit as `verifyLightRig()`: what this file
 * gets wrong will be wrong silently.
 *
 * A cloud layer that has drifted dark does not throw and does not glitch -- it
 * just stops being cloud and starts being the grey blotches that got
 * `SkyMesh`'s own layer switched off. These three bound the properties the look
 * actually rests on, and nothing else, because the rest is taste.
 */
export function verifyCloudRig(): string[] {
  const failures: string[] = [];
  // 15 February, 3 pm. Repeated as a literal rather than imported from
  // `REFERENCE_SOLAR` so this file stays evaluable on its own.
  const rig = cloudRig(57.11);
  const zenith = luminance(ZENITH_RADIANCE);

  // 1. The non-negotiable. A cloud is the brightest thing in a daytime sky
  //    short of the sun, and the failure this catches -- clouds dimmer than the
  //    sky they sit in front of -- is precisely what was wrong with the layer
  //    this replaces.
  const flank = luminance(rig.flank);
  if (!(flank > zenith * 2)) {
    failures.push(
      `Sunlit cumulus flanks are at ${flank.toFixed(2)} of linear radiance against a zenith sky ` +
        `of ${zenith.toFixed(2)} -- they must be at least twice it, and are calibrated to 3.1x. ` +
        `A cloud darker than the sky behind it reads as a grey blotch, which is the exact ` +
        `failure that got SkyMesh's own cloud layer switched off. Check CLOUD_ALBEDO and ` +
        `FLANK_COSINE, and that the rig in calibration.ts still has a sun in it.`,
    );
  }

  // 2. The base is the other half of the look, and it fails in both directions:
  //    too dark and the cloud is a hole in the sky, too light and it has no
  //    form and reads as a decal.
  const ratio = luminance(rig.base) / flank;
  if (!(ratio >= 0.25 && ratio <= 0.45)) {
    failures.push(
      `Cumulus base:flank radiance is ${ratio.toFixed(2)}, outside the 0.25-0.45 that measured ` +
        `cumulus run. It is calibrated to 0.33, which puts the base at rgb(181, 200, 222) -- a ` +
        `grey-blue that reads as an underside. Below the window the cloud is a hole in the sky; ` +
        `above it there is no modelling left and the deck reads as wallpaper. Check ` +
        `BASE_TRANSMISSION and BASE_SKY_VIEW.`,
    );
  }

  // 3. Night. The clouds are lit by the rig, so they must go out with it rather
  //    than leaving a glowing deck over a city whose whole night look is
  //    silhouette and window light.
  const night = luminance(cloudRig(-8).flank);
  if (!(night < 0.05)) {
    failures.push(
      `Clouds are still at ${night.toFixed(3)} of linear radiance with the sun 8 degrees below ` +
        `the horizon; it must be under 0.05. Their light is meant to come entirely from ` +
        `solarRig(), so it should switch itself off with the sun rather than needing a night path.`,
    );
  }

  return failures;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/* ===========================================================================
 * Where a cloud is: the projection, and the noise on it.
 * ========================================================================= */

/**
 * Height of the cumulus deck, metres.
 *
 * The lifting condensation level on a hot, dryish Sydney afternoon -- which is
 * what sets a cumulus base, and why every cumulus in a given sky has its base
 * at the same height. 1,800 m is right for a 30-degree day at 40% humidity.
 * It is not a free parameter: it is the *only* thing that sets the scale
 * relationship between how far away a cloud is and how high in the frame it
 * sits, and getting it wrong is what makes a sky read as a painted backdrop.
 */
const CUMULUS_ALTITUDE = 1800;

/**
 * Wavelength of the fundamental noise octave on the cloud plane, metres.
 *
 * A fair-weather cumulus is 0.5-1.5 km across with a similar gap to the next
 * one, so the field's fundamental should be a little over twice a cloud. At
 * 2,200 m against a deck height of 1,800 m, a cloud 20 degrees up is 5.3 km out
 * and subtends about 5 degrees; one 5 degrees up is 21 km out and subtends
 * 0.4 degrees. That compression -- the whole reason the noise is mapped on a
 * *plane* and not on the sphere -- is what makes the deck read as receding
 * rather than as a texture stuck to the inside of a dome.
 */
const CUMULUS_FEATURE = 2200;

/**
 * The coverage window: `smoothstep(lo, hi, field)` is the cloud's opacity.
 *
 * Measured rather than asserted. Over 160k samples the field below has mean
 * 0.473 and standard deviation 0.132, and this window puts solid cloud
 * (mask > 0.5) on **21.5%** of the plane with some cloud at all on 37.1% --
 * the scattered fair-weather deck the reference asks for, at the low end of
 * 20-30% because perspective then piles most of it into the lower sky where it
 * reads denser than the plane figure suggests.
 *
 * The window is 0.155 wide against a 0.132 standard deviation, which is what
 * makes the edges soft. A hard threshold on fbm gives the coastline-shaped
 * cutouts that say "noise" from across the room; this ramps every edge over
 * roughly a fifth of a cloud.
 */
const COVER_LO = 0.505;
const COVER_HI = 0.66;

/**
 * How far down the window slides at full cloud cover.
 *
 * **The deck was a constant until `skyglow.ts` needed a cloudy night.** The
 * window above is a *fair-weather* deck and always was -- 21.5% of the plane,
 * measured -- and "the sky is more luminous when cloudy" needs a sky that can
 * actually be cloudy. Sliding the window is the cheapest possible way to get
 * one: it is two subtractions on a uniform inside an existing smoothstep, so
 * there is no second field, no second material, no new pipeline and no cost at
 * all on a clear night.
 *
 * 0.52 is set against the field's own statistics rather than by eye. The field
 * has mean 0.473 and standard deviation 0.132, so this puts the window at
 * -0.015 to 0.14 -- three and a half standard deviations below the mean, where
 * essentially every sample is above it and the mask saturates. What is left is
 * the thinning at the very edges of the noise, which is what stops a full
 * overcast reading as a flat grey plate: a real stratocumulus lid has structure
 * in it, just not holes.
 */
const COVER_SHIFT_MAX = 0.52;

/**
 * How much of the city's upward glow a cloud base collects, as a multiplier on
 * `NightSkyRig.glowRadiance`.
 *
 * **This is where the orange lid actually comes from.** The dome grade in
 * `skyglow.ts` puts the general wash in the air; this puts it on the *cloud*,
 * which is the thing that has a shape and is therefore the thing a player reads
 * as "the sky is lit up tonight". Physically it is the same statement from the
 * other side: a cloud base a kilometre over the CBD is a diffuse reflector
 * looking straight down at a hundred thousand streetlights, and it is by a wide
 * margin the brightest thing in an overcast urban night sky.
 *
 * 6.0 is large because the glow radiance it multiplies is a *sky* radiance --
 * the light per steradian arriving at the eye through a kilometre of air -- and
 * the cloud base is the surface that light came off, which is much brighter than
 * the air in front of it. Calibrated by eye against screenshots, on the brief's
 * warning about additive blending in sRGB.
 */
const BASE_GLOW_GAIN = 6.0;

/**
 * Peak opacity of solid cloud. Not 1: a cumulus is optically thick but it is
 * not a wall, and leaving 6% of the sky showing through the densest part keeps
 * the deck tied to the sky's own colour as the sun moves, instead of becoming a
 * flat cutout that ignores it.
 */
const CLOUD_OPACITY = 0.94;

/**
 * The haze band, and the reason clouds stop before the horizon does.
 *
 * Two things want the same fade. The honest one is aerial perspective: a cloud
 * 30 km out is behind 30 km of the same marine haze that gives Preetham its
 * pale horizon band, and it should dissolve into it rather than stopping. The
 * practical one is that the `1/y` projection runs away -- at 2 degrees a 1.5 km
 * cloud subtends 0.06 degrees, which is a sub-pixel feature that can only
 * alias. Both are served by fading the cloud's *alpha*, since blending a cloud
 * toward the sky radiance behind it and reducing its opacity are the same
 * operation.
 *
 * Full strength above 5.7 degrees, gone by 1.7. Checked against where the dome
 * meets the ground: at 1.7 degrees the sky is rgb(218, 245, 253) and untouched,
 * and the fogged ground below the horizon line is rgb(167, 181, 196) from
 * `scene.fog`'s 0xd8e8fa. The clouds never reach that seam, so they cannot
 * widen the step that is already there.
 */
const HAZE_LO = 0.03;
const HAZE_HI = 0.10;

/**
 * Where you stop seeing a cloud's flanks and start seeing its base.
 *
 * The single most important cue in the whole file, and it is pure geometry: a
 * cumulus overhead shows you nothing but its flat underside, and one near the
 * horizon shows you its sunward side and its top. Every "painted on" cloud
 * shader gets this wrong by shading the deck uniformly.
 *
 * Full flank below 14 degrees, full base above 58. Between them the cloud turns
 * over, which is what puts a soft tonal gradient from rgb(181, 200, 222) at the
 * zenith to rgb(235, 242, 251) low down across a frame that includes both.
 */
const BASE_LO = 0.25;
const BASE_HI = 0.85;

/**
 * How much darker the clouds *toward* the sun are than the ones away from it.
 *
 * Backwards from the intuitive version, and worth being explicit because
 * `SkyMesh`'s own layer has it the intuitive way round. Looking toward the sun
 * you see clouds' shadowed sides -- they are backlit, and read grey. Looking
 * *away* from the sun you see their fully lit faces with no self-shadowing at
 * all, which is why the brightest clouds in any afternoon sky are the ones in
 * the anti-solar half. 0.75 takes the toward-sun clouds down to a quarter of
 * the lit value, which composites to rgb(200, 219, 246) against the anti-sun
 * rgb(226, 235, 250): 26 code values, plainly readable as direction.
 *
 * What comes back the other way is the forward-scatter halo below, which is the
 * physically correct reason a backlit cloud is not simply dark.
 */
const BACKLIT_DEPTH = 0.75;

/**
 * The forward-scatter halo: how tightly it hugs the sun, in `pow(cos, n)`.
 *
 * Water droplets scatter forward hard -- it is the same Mie peak that
 * `MIE_DIRECTIONAL_G` gives the sky itself -- so a cloud between you and the sun
 * transmits far more light than it reflects, and the closer to the sun's
 * bearing it sits the brighter it gets. 24 makes the lobe about 20 degrees wide:
 * 0.69 at 10 degrees off, 0.23 at 20, 0.01 at 33.
 *
 * The width matters more than it looks. At 6 this term was still at 0.48
 * thirty-three degrees away, which at the reference sun is the zenith -- so it
 * was lifting the cloud *bases* to rgb(236, 242, 251) and erasing the single
 * strongest shape cue in the frame. A halo has to be a halo.
 */
const FORWARD_POWER = 24;

/**
 * Per-lobe shading, from the noise's own high-frequency octaves.
 *
 * A cumulus is a cluster of bulges, and the bulges facing up are lit while the
 * hollows between them are not. The two billow octaves already describe exactly
 * that structure, so reusing them to modulate the lit fraction costs nothing
 * and is the difference between a cloud with lumps on it and a flat white
 * shape. Range 0.60-1.15 about a mean near 0.88, which puts roughly 12 code
 * values of variation across a single cloud.
 */
const SHAPE_MIN = 0.6;
const SHAPE_RANGE = 0.55;

/**
 * Drift, in metres per second on the cloud plane.
 *
 * A Sydney February afternoon runs the north-easterly sea breeze, so the deck
 * moves toward the south-west: negative east, positive south in this project's
 * axes. 1.5 m/s crosses one 2,200 m feature in 24 minutes, which is under the
 * threshold of noticing in any single glance and stops the sky being a
 * photograph over a long one. This is the only animation in the file and the
 * only thing it reads is elapsed time -- it is not tied to the solar clock, so
 * `[`, `]` and `KeyN` do not teleport the clouds.
 */
const CUMULUS_DRIFT_EAST = -1.1;
const CUMULUS_DRIFT_SOUTH = 1.1;

/**
 * The projection's floor on `direction.y`.
 *
 * `xz / y` is singular at the horizon and changes sign below it, and the sky
 * dome is drawn below the horizon wherever the finite ground plane does not
 * cover it. The alpha is already zero everywhere under `HAZE_LO`, so this
 * changes no pixel -- it exists because `0 * NaN` is `NaN`, and a NaN that only
 * appears on some hardware in the bottom few degrees of the frame is exactly
 * the kind of bug that ships.
 */
const MIN_ELEVATION = 0.02;

/**
 * Angular radius of the clear hole kept around the solar disc, as a cosine:
 * `INNER` is 0.8 degrees, `OUTER` 2.5.
 *
 * The sun disc in `SkyMesh` is a radiance of about 340,000 against a cloud's 5,
 * so a cloud crossing it at 94% opacity would delete the sun from the sky --
 * while the `DirectionalLight` that this file is forbidden to touch keeps
 * burning at full strength on the city below. That is not a cloud effect, it is
 * the rig visibly disagreeing with itself, and at 20% coverage it would happen
 * often enough to see. Fading the cloud out over the last two degrees guarantees
 * it cannot, and costs a hole a fifth of a degree wider than the halo already
 * blows out anyway.
 */
const SUN_HOLE_INNER = 0.999903;
const SUN_HOLE_OUTER = 0.999048;

/* --- Cirrus ---------------------------------------------------------------
 *
 * Included rather than skipped, and the reason is the perspective above. The
 * plane projection puts essentially the whole cumulus deck below 40 degrees --
 * that is the point of it -- which leaves the top half of the frame exactly as
 * empty as it was before this file existed. A player looking up gets the sterile
 * gradient back. Two stretched octaves at a tenth of the cumulus opacity is what
 * puts something there, and it is a fifth of the cumulus cost.
 */

/** Cirrus deck height, metres. Ice cloud sits at 6-12 km; 8,000 is mid-range. */
const CIRRUS_ALTITUDE = 8000;

/**
 * Cirrus feature size along and across the streaks, metres.
 *
 * The 12:1 stretch is the whole look -- cirrus is sheared into filaments by the
 * vertical wind gradient at that altitude, and a filament is the one cloud shape
 * that cannot be mistaken for anything else. Stretched along east-west, which is
 * the upper-level westerly Sydney sits under.
 */
const CIRRUS_LENGTH = 30000;
const CIRRUS_WIDTH = 2500;

/** Coverage window for the cirrus field. Wider than the cumulus one, because a
 *  cirrus edge is a gradient rather than an edge. */
const CIRRUS_LO = 0.5;
const CIRRUS_HI = 0.74;

/**
 * Peak cirrus opacity.
 *
 * 0.14 lifts the zenith from rgb(114, 166, 249) to rgb(142, 180, 249) at the
 * densest wisp and less than half that over most of a streak. Enough to break
 * the gradient, nowhere near enough to be mistaken for cloud -- which is right,
 * because a February Sydney sky with real cirrus in it is not the clear hot day
 * this scene is set on.
 */
const CIRRUS_OPACITY = 0.14;

/** Where cirrus fades into the haze. Higher than the cumulus band: at 8 km the
 *  projection has already put anything below 10 degrees over 45 km away. */
const CIRRUS_HAZE_LO = 0.10;
const CIRRUS_HAZE_HI = 0.28;

/** Cirrus is thin ice with no underside to speak of, so it is almost all flank. */
const CIRRUS_LIT = 0.85;

/** Cirrus drift, m/s. Faster than the cumulus, as the real upper-level wind is,
 *  but graded far down from its actual 30 m/s -- at 8 km even 6 m/s is a visible
 *  few degrees a minute, and this is a backdrop, not a weather simulation. */
const CIRRUS_DRIFT_EAST = 6;

/* ===========================================================================
 * The noise.
 * ========================================================================= */

/**
 * Hoskins' integer-free hash, the same one `ground.ts` and `vegetation.ts` use
 * and for the same reason it gives there: it folds the coordinate into the unit
 * interval before doing anything else, so its conditioning depends on the step
 * between lattice cells rather than on their absolute size, and it leans on no
 * transcendental at all.
 *
 * That matters more here than anywhere else in the project, because the `1/y`
 * projection makes the lattice coordinate enormous exactly where the clouds are
 * densest. At the bottom of the band it reaches 27 units, and the fourth octave
 * multiplies that to about 220; the sin-hash `facade.ts` and `street.ts` use
 * would then be taking `sin` of `dot(p, vec2(127.1, 311.7))`, close to 1e5.
 * That is well past where float32 `sin` has meaningful precision left, and it is
 * a range WGSL's spec does not constrain at all. The artifact it produces is a
 * slow tonal drift across the lower sky rather than anything you could point
 * at -- which is the kind that survives review and looks subtly wrong forever.
 */
const hash21 = /*#__PURE__*/ Fn(([p]: [any]) => {
  // Annotated `any` for the reason `street.ts` gives: TSL's arithmetic overloads
  // collapse a vector node to a scalar node type through a chain of `mul`, and
  // the component accessors go with it.
  const q: any = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const r: any = q.add(dot(q, q.yzx.add(33.33)));
  return fract(r.x.add(r.y).mul(r.z));
});

/** Smooth value noise on a unit lattice. Smoothstepped interpolant, because a
 *  plain bilinear blend shows the lattice as a diamond grid. */
const valueNoise = /*#__PURE__*/ Fn(([p]: [any]) => {
  const i: any = floor(p);
  const f: any = fract(p);
  const w: any = f.mul(f).mul(float(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
});

/**
 * One octave, rotated into its own lattice frame before sampling.
 *
 * A plain TypeScript helper rather than a TSL `Fn`, so it inlines and adds no
 * function node to the graph -- and so the rotation collapses into two
 * compile-time constants. The rotation is what stops the octaves stacking their
 * axis-aligned lattices on top of each other, which is the artifact that makes
 * fbm look like fbm. The lacunarities are 2.03, 4.07 and 8.13 rather than 2, 4
 * and 8 for the same reason.
 */
function octave(p: any, scale: number, angle: number): any {
  const c = Math.cos(angle) * scale;
  const s = Math.sin(angle) * scale;
  return valueNoise(vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c))));
}

/** `abs(2n - 1)`: same mean and range as the noise, but folded, so the field
 *  gains rounded lobes instead of smooth swells. Cumulus are lobes. */
function billow(n: any): any {
  return abs(n.mul(2.0).sub(1.0));
}

/* ===========================================================================
 * The layer.
 * ========================================================================= */

/**
 * The cloud layer, as a replacement colour node for `SkyMesh`'s material.
 *
 * Holds four uniforms and rewrites none of the sky: `skyColour` is the material's
 * existing Preetham node, evaluated once into a local and composited over.
 * Sky pixels are the only ones that pay, and only the ones the dome covers --
 * the city is drawn over the top of it as it always was.
 */
export class CloudLayer {
  /** The node to assign back to `SkyMesh`'s `material.colorNode`. */
  readonly colourNode: ReturnType<typeof vec4>;

  // Radiances rather than swatches, so `Vector3` rather than `Color`: these are
  // linear multipliers on their way into a shader, and a `Color` would invite
  // the working-colour-space conversion that would silently halve them.
  private readonly sunward = uniform(new Vector3());
  private readonly flank = uniform(new Vector3());
  private readonly base = uniform(new Vector3());
  private readonly opacity = uniform(0);
  /** How far the coverage window has slid down. See `COVER_SHIFT_MAX`. */
  private readonly coverShift = uniform(0);
  /** The city's light on the underside of the deck. See `BASE_GLOW_GAIN`. */
  private readonly baseGlow = uniform(new Vector3());

  /**
   * @param skyColour   the material's existing `colorNode`, a vec4.
   * @param sunPosition `SkyMesh`'s own sun uniform, passed rather than
   *                    duplicated so the clouds and the dome can never disagree
   *                    about where the sun is.
   */
  constructor(skyColour: any, sunPosition: any) {
    this.colourNode = Fn(() => {
      // One evaluation of Preetham, into a local. Without the `toVar` every
      // reference below re-inlines the whole dome computation.
      const sky: any = skyColour.toVar();

      const dir: any = normalize(positionWorld.sub(cameraPosition)).toVar();
      const upness: any = dir.y.toVar();
      // The plane the clouds live on. `xz / y` is the ray-plane intersection
      // with a horizontal plane -- distance grows as `1/y`, which is the
      // foreshortening, and it is the whole trick.
      const ground: any = vec2(dir.x, dir.z).div(max(upness, MIN_ELEVATION)).toVar();

      const sunDir: any = normalize(sunPosition).toVar();
      const cosSun: any = dot(dir, sunDir).toVar();
      // The sun's *bearing*, with its elevation projected out. Using the full
      // 3D dot here would conflate "toward the sun" with "high in the sky",
      // and the two have opposite effects on how a cloud reads. This needs no
      // guard against a zero-length horizontal component: at latitude -33.87
      // the sun never reaches the zenith, which `solar.ts` states and
      // `verifySouthernHemisphere()` checks.
      const sunBearing: any = normalize(vec3(sunDir.x, 0.0, sunDir.z));
      const backlit: any = dot(dir, sunBearing).mul(0.5).add(0.5).toVar();

      // --- cumulus -------------------------------------------------------
      // Negated, and it is not a sign slip. Offsetting the *sample* coordinate
      // by `+d` makes the pattern appear at `-d`: the feature that was at `x0`
      // is now found where `x + d == x0`. Writing the wind velocity into the
      // constants and negating here keeps the constants physical -- they are the
      // direction the air is going -- and puts the inversion in one place with
      // its reason attached, instead of leaving two constants that silently mean
      // the opposite of their names.
      const drift = vec2(
        float(-CUMULUS_DRIFT_EAST / CUMULUS_FEATURE).mul(time),
        float(-CUMULUS_DRIFT_SOUTH / CUMULUS_FEATURE).mul(time),
      );
      const p: any = ground.mul(CUMULUS_ALTITUDE / CUMULUS_FEATURE).add(drift).toVar();

      // Four octaves, unrolled. Not a `Loop`: the two billow octaves are folded
      // and the first two are not, so there is nothing to loop over -- and the
      // README records a `Loop` with a nested `If` compiling into a pipeline
      // build that blocked the main thread outright, which is not a mistake
      // worth repeating for four iterations.
      const o1: any = octave(p, 1.0, 0.0);
      const o2: any = octave(p, 2.03, 0.9);
      const b3: any = billow(octave(p, 4.07, 2.1)).toVar();
      const b4: any = billow(octave(p, 8.13, 3.6)).toVar();
      const field: any = o1
        .mul(0.5333)
        .add(o2.mul(0.2667))
        .add(b3.mul(0.1333))
        .add(b4.mul(0.0667));

      // Which face of the cloud is turned toward the camera, and how much of it
      // the sun can see. See BASE_LO and BACKLIT_DEPTH.
      const faceUp: any = smoothstep(BASE_LO, BASE_HI, upness).oneMinus();
      const lobes: any = b3.mul(0.667).add(b4.mul(0.333));
      const lit: any = saturate(
        faceUp
          .mul(backlit.mul(BACKLIT_DEPTH).oneMinus())
          .mul(lobes.mul(SHAPE_RANGE).add(SHAPE_MIN)),
      );
      // Forward scatter only where the cloud is between you and the sun, which
      // is what `backlit` already measures.
      const forward: any = pow(saturate(cosSun), FORWARD_POWER).mul(backlit).toVar();
      /* The city on the underside. `faceUp` is already "how much of the base you
       * are looking at" -- 1 for the deck straight overhead, 0 for a flank up
       * near the top of the frame -- which is exactly the weighting the glow
       * wants, because only the base can see the streetlights. It goes into the
       * base *before* the sunward mix, so a cloud lit by the city at dusk is
       * still overridden by a cloud lit by the sun. */
      const litBase: any = this.base.add(this.baseGlow.mul(faceUp));
      const cumulusColour: any = mix(mix(litBase, this.flank, lit), this.sunward, forward);

      const cumulusAlpha: any = smoothstep(
        float(COVER_LO).sub(this.coverShift),
        float(COVER_HI).sub(this.coverShift),
        field,
      )
        .mul(smoothstep(HAZE_LO, HAZE_HI, upness))
        .mul(smoothstep(SUN_HOLE_OUTER, SUN_HOLE_INNER, cosSun).oneMinus())
        .mul(this.opacity)
        .mul(CLOUD_OPACITY);

      // --- cirrus --------------------------------------------------------
      const cirrusP: any = vec2(
        ground.x
          .mul(CIRRUS_ALTITUDE / CIRRUS_LENGTH)
          .add(float(-CIRRUS_DRIFT_EAST / CIRRUS_LENGTH).mul(time)),
        ground.y.mul(CIRRUS_ALTITUDE / CIRRUS_WIDTH),
      ).toVar();
      // Two octaves, and the second one's rotation has to be small where the
      // cumulus octaves' can be anything. These angles are applied *after* the
      // 12:1 stretch, so a large one turns the second octave across the
      // filaments and cross-hatches them: 1.3 rad in stretched space is
      // `atan(tan(74 deg) / 12)` = 16 degrees in world terms, plainly visible
      // against streaks that are the whole reason cirrus reads as cirrus. 0.4
      // rad decorrelates the two lattices -- any angle away from 0, 45 and 90
      // does -- while tilting the world-space features by 2 degrees.
      const cirrusField: any = octave(cirrusP, 1.0, 0.0)
        .mul(0.65)
        .add(octave(cirrusP, 2.11, 0.4).mul(0.35));
      const cirrusColour: any = mix(
        mix(this.base, this.flank, CIRRUS_LIT),
        this.sunward,
        forward,
      );
      const cirrusAlpha: any = smoothstep(CIRRUS_LO, CIRRUS_HI, cirrusField)
        .mul(smoothstep(CIRRUS_HAZE_LO, CIRRUS_HAZE_HI, upness))
        .mul(this.opacity)
        .mul(CIRRUS_OPACITY);

      // Cirrus first: it is four times higher, so the cumulus deck is in front
      // of it and must composite last.
      const withCirrus: any = mix(sky.xyz, cirrusColour, cirrusAlpha);
      return vec4(mix(withCirrus, cumulusColour, cumulusAlpha), sky.w);
    })();
  }

  /**
   * Push the rig for a solar altitude into the uniforms. Called from the same
   * place `sky.ts` applies the light rig, so the clouds and the sun are never a
   * frame apart.
   */
  setSolarAltitude(altitudeDeg: number, cover = 0): void {
    const rig = cloudRig(altitudeDeg, cover);
    this.sunward.value.set(...rig.sunward);
    this.flank.value.set(...rig.flank);
    this.base.value.set(...rig.base);
    this.opacity.value = rig.opacity;
    this.coverShift.value = COVER_SHIFT_MAX * cover;
  }

  /**
   * The city's glow on the base of the deck. Separate from `setSolarAltitude`
   * because it depends on *where the player is standing* and the rest of the
   * rig does not -- the light rig is a function of the sun's altitude alone and
   * is the same over the whole 60 km world, while this is the whole point of the
   * urban field.
   */
  setGlow(glowRadiance: Readonly<Rgb>): void {
    this.baseGlow.value.set(
      glowRadiance[0] * BASE_GLOW_GAIN,
      glowRadiance[1] * BASE_GLOW_GAIN,
      glowRadiance[2] * BASE_GLOW_GAIN,
    );
  }
}
