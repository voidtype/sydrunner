/**
 * The light rig itself, and the self-check that stops it silently regressing.
 *
 * Spec section 7.1 asks for one thing that no amount of shader work substitutes
 * for: **harsh, high contrast, deep shadows, blown highlights, hard blue sky.
 * Not soft, not grey, not European.** That is a statement about *ratios and
 * absolute levels*, so this file holds the numbers and the arithmetic that
 * justifies them, and `sky.ts` holds only the plumbing that applies them.
 *
 * Everything here is pure and framework-free on purpose: it can be run in Node
 * against the same `solar.ts` the renderer uses, which is how the values below
 * were measured rather than guessed. The previous set was tuned blind and was
 * wrong in three separate ways at once (see the table further down).
 *
 * ---------------------------------------------------------------------------
 * How a number here becomes a pixel, so the arithmetic can be checked:
 *
 *   irradiance E  =  sunIntensity    * max(0, N.Lsun)    * sunColour    (direct)
 *                 +  mix(groundColour, skyColour, 0.5*N.y + 0.5) * hemisphereIntensity
 *                 +  bounceIntensity * max(0, N.Lbounce) * bounceColour (bounce)
 *
 * three's `DirectionalLightNode` contributes `dot(N,L) * colour * intensity` and
 * `HemisphereLightNode` adds `mix(ground, sky, w) * intensity` straight into
 * `irradiance` with no pi anywhere; `BRDF_Lambert` then divides by pi. So a
 * matte surface of linear albedo `a` leaves the shader at `a/pi * E`, and the
 * output pass multiplies by `toneMappingExposure` and applies the tone curve.
 * Every predicted value in the comments below was produced by that chain.
 *
 * The third term is new, and the section on `BOUNCE_FRACTION` below explains
 * both why the first two were not enough and how its size was measured.
 * ---------------------------------------------------------------------------
 */

import { directionFrom, solarPosition, sydneyTime } from './solar.ts';

/** Sydney. Repeated from `main.ts` so this file can be run standalone. */
const LATITUDE = -33.87;
const LONGITUDE = 151.21;

/**
 * Direct-beam intensity with the sun at the zenith and no atmosphere in the way.
 *
 * The old value was 3.45 at the zenith, and it was not weak in isolation -- it
 * was weak *relative to the sky dome*. `SkyMesh` is a Preetham model with its
 * own absolute scale, and at 3 pm in February it puts about 0.96 of linear
 * radiance at the zenith and about 7.8 at the horizon haze band. Against that,
 * a sunlit concrete footpath under the old rig left the shader at 0.43 -- less
 * than half the brightness of the sky directly overhead. A photograph of a
 * Sydney street has sunlit concrete at roughly 2.4x the zenith luminance, not
 * 0.45x, and a scene where the sky is the brightest thing in frame is the
 * definition of "overcast". 17.0 puts the ground back on the right side of it.
 */
export const SUN_ZENITH_INTENSITY = 17.0;

/**
 * Broadband atmospheric extinction optical depth for a clean coastal sky.
 *
 * The old intensity curve was `0.35 + 3.1 * (alt/90)^0.42`: a shape chosen to
 * look plausible, with a 0.35 floor that kept the sun burning after it had set.
 * This replaces it with the physical thing -- Beer-Lambert against Kasten-Young
 * air mass -- which costs the same and gets the ends right for free. The sun
 * fades and reddens together as it drops, and reaches zero at the horizon
 * instead of a tenth of noon.
 *
 * 0.32 is mid-range for a clear day with marine aerosol; it holds 94% of the
 * beam at 3 pm, 23% at 10 degrees altitude, and 5% at 5 degrees.
 */
export const SUN_EXTINCTION = 0.32;

/**
 * Hemisphere fill, full daylight.
 *
 * Deliberately still weak: this is the number that decides how deep shade is,
 * and a strong ambient is exactly what makes a render read as overcast Europe.
 * It is set by the ratio below, not by taste -- 3.4 against a sky colour of
 * luminance 0.68 gives 2.31 of diffuse irradiance on a horizontal surface
 * against 13.4 of direct, which is the measured Sydney clear-sky split.
 *
 * Note this is *sky* fill only. Real shade in a real street also gets bounce off
 * sunlit concrete and render, which is a large warm term. That term now exists
 * as its own light -- see `BOUNCE_FRACTION` -- and this number is still not the
 * place to spend on shade. Raising it lifts *every* surface at every orientation
 * including the sunlit ground, so it flattens the whole image rather than opening
 * up the shade, and it is bluer than shade actually is. The warning that used to
 * stand here stands unchanged; the difference is that there is now somewhere else
 * to put the light.
 */
export const HEMISPHERE_DAY = 3.4;

/**
 * Hemisphere fill after dark. Chosen to land night at the same luminance the
 * previous rig produced, so this pass changes daylight only: the old
 * (0.08 intensity, 0.30/0.42/0.62 colour) under ACES at 0.86 exposure and the
 * new (0.30, 0.185/0.259/0.382) under Neutral at 0.62 differ by under a code
 * value on a mid-grey surface. Night is spec 6.4's problem, not this file's.
 */
export const HEMISPHERE_NIGHT = 0.3;

/**
 * Hemisphere sky colour, linear, day and night endpoints.
 *
 * Blue, and more so than the old (0.62, 0.77, 0.91), which was nearly neutral.
 * A cosine-weighted average of the Preetham dome at 3 pm is bluer still --
 * about (0.30, 0.60, 1.00) -- and the reason this sits between the sky and
 * neutral used to be that it was also standing in for what little bounce
 * existed. The bounce light below now carries that job properly, so the argument
 * for the compromise is gone and the honest move would be to go bluer.
 *
 * It is left where it is, and deliberately: this colour's luminance is pinned
 * from both ends by the two checks at the bottom of this file -- it sets the
 * shaded half of the horizontal sun:shade ratio and a sixth of the sunlit half
 * -- and going bluer at constant luminance takes green out and blue in, which
 * lands entirely on the shaded road. Shaded asphalt is already the bluest thing
 * in the frame and pushing it further is the opposite of this pass's brief.
 * The warmth in shade belongs in a term with the right *geometry*, which is what
 * the bounce is, not in the one that lights everything from straight up.
 */
export const SKY_FILL_DAY: Readonly<Rgb> = [0.48, 0.7, 1.0];
export const SKY_FILL_NIGHT: Readonly<Rgb> = [0.185, 0.259, 0.382];

/**
 * Hemisphere ground colour, linear. Warm, because what bounces up off a Sydney
 * street is sandstone kerb, buff footpath and blue-metal road.
 *
 * It is no longer the only warmth in shade -- the bounce light below is now the
 * large term -- and it was measured as a lever for this pass and rejected as
 * one. The hemisphere weights it by `1 - (0.5*N.y + 0.5)`, so it reaches a
 * vertical wall at half strength and an up-facing surface not at all, which is
 * the right *shape* for bounce but the wrong *size*: at HEMISPHERE_DAY 3.4 it
 * takes a raise of 0.59 to put one unit of irradiance on a wall, and that same
 * raise lands on the *sunlit* wall too and moves red brick 12 code values. Sweeping
 * it from 0.20 to 0.32 buys two display values of shaded brick and costs two of
 * sunlit brick. It is kept as the soffit-and-underside term it is good at.
 */
export const GROUND_FILL: Readonly<Rgb> = [0.2, 0.165, 0.115];

/* ---------------------------------------------------------------------------
 * The bounce: light off the sunlit pavement and the sunlit facade opposite.
 *
 * Everything above models shade as skylight and nothing else, and skylight from
 * a HemisphereLight reaches a vertical wall as `mix(ground, sky, 0.5)` -- half
 * blue sky, half a token warm floor. At 3 pm that is (1.156, 1.470, 1.895) of
 * irradiance on the shaded side of a street, which is both too little and the
 * wrong colour: red brick came out at rgb(48, 14, 7) and asphalt at
 * rgb(15, 38, 59). Charcoal silhouettes with a blue cast, and a wall you cannot
 * count the windows on.
 *
 * How much is actually missing was measured rather than guessed, by integrating
 * the hemisphere of a real street canyon: two parallel walls of height H, a
 * street of width W, the sun at 57.1 degrees, radiosity iterated to convergence
 * so the walls and the ground light each other rather than each being a single
 * bounce. Sky radiance in that integration is taken from this rig's own
 * hemisphere (uniform, `skyColour * HEMISPHERE_DAY / pi`) so the answer is on
 * the same scale as the numbers above and can be subtracted from them.
 *
 * For a 16 m street with 8 m walls, irradiance on the shaded wall converges to:
 *
 *     h = 1.0 m   (2.112, 2.112, 2.217)   lum 2.12   R/B 0.95
 *     h = 2.5 m   (2.407, 2.414, 2.529)   lum 2.42   R/B 0.95
 *     h = 6.0 m   (2.739, 2.811, 3.012)   lum 2.81   R/B 0.91
 *
 * against this rig's (1.156, 1.470, 1.895), lum 1.43, R/B 0.61. Two things fall
 * out of that, and they are the whole design:
 *
 *   - the level is short by about 1.7x, and
 *   - the *hue* is wrong. Real shade in a street is close to neutral, warm-side;
 *     this rig's is 1.6 parts blue to one part red.
 *
 * It also reproduces the thing a photograph shows and the rig cannot: the shade
 * is warmest low down (R/B 0.95 at a metre, where the wall sees mostly sunlit
 * road) and cools going up (0.91 at six metres, where it sees more sky).
 *
 * Two other measurements ruled out the obvious alternatives:
 *
 *   - A dome with the real horizon-bright gradient rather than a uniform one
 *     was tried, on the theory that a wall in a canyon sees mostly the bright
 *     haze band and the uniform assumption understates it. Normalised to the
 *     same up-facing irradiance it is worth a factor of 1.02 to 1.21 depending
 *     on how open the street is, and it moves R/B from 0.52 to 0.58. Real, and
 *     nowhere near enough to explain the gap. Recorded so nobody re-derives it.
 *   - The same integration says the shaded *ground* is already over-lit here,
 *     not under-lit: it converges to lum 1.79-2.18 against the 2.30 this rig
 *     gives an up-facing surface, and puts the physical ground sun:shade at
 *     8.3:1 against the rig's 6.9:1. So the road is not where the missing light
 *     goes, which is exactly why the term below is aimed the way it is.
 * ------------------------------------------------------------------------- */

/**
 * Where the bounce comes from: degrees above the horizon, on the bearing
 * *opposite* the sun.
 *
 * Opposite the sun is what makes this affordable. A surface turned to the sun
 * has `N.Lbounce < 0` and takes nothing from this light at all, so the sunlit
 * half of the frame -- which is calibrated, and correct -- does not move by a
 * single code value. A surface turned away takes it in full. In between it
 * ramps with the cosine, so the shaded side of a street gets a *gradient* across
 * its orientations rather than a flat fill, which is the thing a constant
 * ambient can never do.
 *
 * That geometry is also honest rather than a trick: the bounce a shaded wall
 * receives comes from the sunlit road and the sunlit facade across the street,
 * and those are on the sun's side of it. Its one lie is that a sunlit wall in a
 * real street receives bounce too. That is a few per cent of a surface which is
 * 90% direct beam, and it is the price of pinning the sunlit calibration.
 *
 * 16 degrees is a compromise between two different jobs and the number is the
 * only place they can both be served. The luminance-weighted elevation of the
 * bounce arriving at a *wall* runs from -22 to +13 degrees across the street
 * sections integrated above -- near or below the horizon in the low-rise inner
 * suburbs, above it only in a CBD canyon -- because a wall sees mostly ground.
 * The bounce arriving at a *ground* point comes off the sunlit facade opposite,
 * which stands above it at 0-30 degrees. One directional light must pick one
 * elevation for both, and it trades along `tan`: every degree of altitude moves
 * energy off the walls and onto the road, where the sunlit road is what runs out
 * of budget first. 16 splits them, and lands both display targets at once.
 */
export const BOUNCE_ALTITUDE = 16;

/**
 * Bounce colour, linear, scaled so the largest channel is 1 like the sky fill.
 *
 * Derived, not chosen: it is the *residual* -- the converged canyon irradiance
 * on a shaded wall at mid height, (2.407, 2.414, 2.529), minus what the
 * hemisphere already delivers there, (1.156, 1.470, 1.895). That leaves
 * (1.251, 0.944, 0.634), which normalises to this.
 *
 * It is warmer than the street it comes off -- an area-weighted Sydney street is
 * about (0.312, 0.272, 0.231) of reflectance, R/B 1.35, and this is R/B 1.97 --
 * and the difference is not fudge. The hemisphere's contribution to a wall is
 * already too blue, so the term that corrects it has to be warm enough to fix
 * the total rather than merely warm in isolation. Sum the two and the shaded
 * wall lands at R/B 1.13 against the canyon's 0.95: warm-side of neutral, which
 * is where a measured street sits.
 *
 * Sanity check on the other end, which is what stops this reading as sunset:
 * shaded painted render comes out rgb(164, 156, 145) -- a warm grey, seven code
 * values of red over blue. Nothing neutral in the city turns orange.
 */
export const BOUNCE_COLOUR: Readonly<Rgb> = [1.0, 0.754, 0.507];

/**
 * Bounce strength, as a fraction of the direct beam landing on the pavement.
 *
 * Written this way rather than as a bare intensity because that is what it
 * physically is -- sunlight that hit the road and came back -- and because it
 * makes the day/night behaviour correct for free. `bounceIntensity` below is
 * `BOUNCE_FRACTION * sunIntensity * sin(altitude)`: it follows the sun's
 * Beer-Lambert falloff, it follows the cosine of the sun's height (a low sun
 * puts less on the ground to bounce), and it reaches exactly zero when the sun
 * does. Nothing has to switch it off at dusk and the night rig is untouched --
 * see the `bounceVanishesAtNight` case in the self-check.
 *
 * 0.177 puts 2.378 of intensity behind the light at 3 pm, which is 2.29 of
 * irradiance on a wall square-on to it and 0.66 on the road. Against the
 * measured residual, the wall term is a deliberate 1.4x over: the canyon
 * integration models one street and nothing else, where this light is standing
 * in for *every* indirect path in a renderer that has no ambient occlusion, no
 * global illumination, and no inter-reflection inside a window reveal. Graded
 * up, and named as graded rather than dressed up as physics.
 *
 * What it is not allowed to become is flat. The wall sun:shade illuminance ratio
 * goes from 7.06:1 to 3.13:1 against the canyon's measured 3.7:1, so the shade
 * opens up while staying on the deep side of a real street -- and the horizontal
 * ratio, which spec 7.1's "deep shadows" is really about, only moves 6.86:1 to
 * 5.78:1 because almost none of this lands on the road. Both are bounded by
 * `verifyLightRig` below.
 */
export const BOUNCE_FRACTION = 0.177;

/**
 * Tone-mapping exposure.
 *
 * Lower than the old 0.86 and yet the image is twice as bright, because three
 * divides by 0.6 inside `ACESFilmicToneMapping` and does not inside
 * `neutralToneMapping`: the old effective exposure was 1.43. Combined with the
 * 5.5x lift in irradiance above, a sunlit footpath moves from a pre-curve 0.62
 * to 1.38, which is what pushes it from mid-grey to near-clipping.
 *
 * It is pinned from both ends and there is no freedom left in it: the sky dome's
 * radiance is fixed by Preetham, so this alone decides how the ground sits
 * against the sky, and the light intensities above then decide the ratio.
 */
export const EXPOSURE = 0.62;

/**
 * Acceptable sun:shade window on the *horizontal*. Outside this, `verifyLightRig`
 * complains. Unchanged by the bounce pass, and that is the point: the bounce is
 * aimed near the horizon, so it lands on walls and barely on the road, and this
 * ratio only moves from 6.86:1 to 5.78:1.
 */
export const RATIO_MIN = 5;
export const RATIO_MAX = 10;

/**
 * The same thing for a *vertical* surface -- the two sides of a street -- which
 * is what this pass actually changed and therefore what has to be bounded.
 *
 * A wall reads harsher than the horizontal in any rig, because a vertical
 * surface sees only half the sky while still taking the full beam. Before the
 * bounce this rig put it at 7.06:1, which is where "shaded walls are black
 * silhouettes" came from. The converged canyon integration measures the real
 * thing at 3.7:1 and the rig now sits at 3.13:1.
 *
 * The floor matters more than the ceiling here. Spec 7.1 asks for deep shadows,
 * and the failure mode of a bounce term is that someone in a year decides shade
 * is still too dark and doubles it, at which point the shaded side of the street
 * is within a stop of the sunlit side and the whole image goes flat -- which is
 * the "overcast Europe" reading the spec rules out, arrived at from the opposite
 * direction to the one `HEMISPHERE_DAY` warns about.
 */
export const WALL_RATIO_MIN = 2.6;
export const WALL_RATIO_MAX = 4.6;

/**
 * Minimum red:blue in the irradiance falling on a shaded wall.
 *
 * This is the check that has teeth, because it is the one a deleted or
 * miscoloured bounce light cannot pass. Skylight alone puts the shaded side of a
 * street at 0.61 -- 1.6 parts blue to one red, which is the blue-grey-dead look.
 * The canyon measures the real value at 0.95, the rig now delivers 1.13, and
 * anything at or under 0.95 means the warm term has gone missing or gone cold.
 */
export const SHADE_WARMTH_MIN = 0.95;

export type Rgb = [number, number, number];

/** What the rig is doing at one instant. Everything below is derived from this. */
export interface LightRig {
  /** Degrees above the horizon. */
  altitude: number;
  /** `DirectionalLight.intensity`. */
  sunIntensity: number;
  /** `DirectionalLight.color`, linear. */
  sunColour: Rgb;
  /** `HemisphereLight.intensity`. */
  hemisphereIntensity: number;
  /** `HemisphereLight.color` (the sky half), linear. */
  skyColour: Rgb;
  /** `HemisphereLight.groundColor`, linear. */
  groundColour: Rgb;
  /** Bounce `DirectionalLight.intensity`. Zero once the sun is down. */
  bounceIntensity: number;
  /** Bounce `DirectionalLight.color`, linear. */
  bounceColour: Rgb;
}

/** Rec. 709 luminance. Illuminance ratios are photometric, so weight properly. */
export function luminance(c: Readonly<Rgb>): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Kasten-Young relative optical air mass: how much atmosphere the beam crosses
 * compared with straight down. 1.0 at the zenith, ~2 at 30 degrees, ~38 at the
 * horizon. The empirical tail is what keeps it finite at grazing altitudes,
 * where the naive `1/sin(alt)` diverges.
 */
export function opticalAirMass(altitudeDeg: number): number {
  const a = Math.max(altitudeDeg, 0);
  return 1 / (Math.sin((a * Math.PI) / 180) + 0.15 * Math.pow(a + 3.885, -1.253));
}

/**
 * The whole rig for a given solar altitude. Pure, so the self-check and the
 * renderer cannot drift apart -- they call this same function.
 */
export function solarRig(altitudeDeg: number): LightRig {
  const sunIntensity =
    altitudeDeg <= 0
      ? 0
      : SUN_ZENITH_INTENSITY * Math.exp(-SUN_EXTINCTION * (opticalAirMass(altitudeDeg) - 1));

  // The warm shift near the horizon, unchanged: full white above 32 degrees,
  // then a steep run into orange over the last few. This is the curve that makes
  // late afternoon in February look like late afternoon in February, and its
  // character is deliberately preserved from the previous rig.
  const warmth = Math.pow(1 - Math.min(Math.max(altitudeDeg, 0) / 32, 1), 1.6);
  const sunColour: Rgb = [1.0, 1.0 - 0.3 * warmth, 1.0 - 0.62 * warmth];

  // Civil-twilight ramp for the fill, so the sky half fades to a dim blue-grey
  // rather than switching off with the sun.
  const day = Math.min(Math.max((altitudeDeg + 6) / 12, 0), 1);
  const hemisphereIntensity = HEMISPHERE_NIGHT + (HEMISPHERE_DAY - HEMISPHERE_NIGHT) * day;
  const skyColour = SKY_FILL_NIGHT.map(
    (n, i) => n + (SKY_FILL_DAY[i] - n) * day,
  ) as Rgb;

  // Bounce off the pavement: the beam that landed on the horizontal, times the
  // fraction that comes back. `sunIntensity` is already zero below the horizon,
  // and `sin(altitude)` takes it to zero a second time, so nothing has to switch
  // this off for the night rig -- it switches itself off with the sun that feeds
  // it, which is the whole reason it is expressed as a fraction of the beam.
  const bounceIntensity =
    BOUNCE_FRACTION * sunIntensity * Math.max(0, Math.sin((altitudeDeg * Math.PI) / 180));

  return {
    altitude: altitudeDeg,
    sunIntensity,
    sunColour,
    hemisphereIntensity,
    skyColour,
    groundColour: [...GROUND_FILL] as Rgb,
    bounceIntensity,
    bounceColour: [...BOUNCE_COLOUR] as Rgb,
  };
}

/**
 * Unit vector pointing *at* the bounce, in renderer world axes, given where the
 * sun is. Same convention as `solar.direction`, so `sky.ts` can place the light
 * exactly the way it places the sun.
 *
 * The whole design rests on this being the sun's bearing plus 180: it is what
 * makes `N.Lbounce` negative on every surface the sun can see, and therefore
 * what keeps the calibrated sunlit values fixed. `verifyLightRig` asserts it
 * rather than trusting the arithmetic here to stay right.
 */
export function bounceDirection(solarAzimuthDeg: number): { x: number; y: number; z: number } {
  return directionFrom(BOUNCE_ALTITUDE, solarAzimuthDeg + 180);
}

/**
 * Irradiance on a vertical wall on the shaded side of a street: the half-sky the
 * hemisphere gives it, plus the bounce arriving square-on.
 *
 * This is the geometry the whole pass is about, and it is worth being explicit
 * that "square-on to the bounce" is the best case -- a wall turned 45 degrees
 * off it takes `cos(45)` of the bounce term, which is what produces the gradient
 * across a street corner instead of one flat value for everything in shadow.
 */
export function shadedWallIrradiance(rig: LightRig): Rgb {
  const bounce = rig.bounceIntensity * Math.cos((BOUNCE_ALTITUDE * Math.PI) / 180);
  return rig.groundColour.map((g, i) => {
    const hemisphere = (g + (rig.skyColour[i] - g) * 0.5) * rig.hemisphereIntensity;
    return hemisphere + bounce * rig.bounceColour[i];
  }) as Rgb;
}

/** The same wall with the sun on it. The bounce contributes nothing here -- by
 * construction it comes from behind, so `max(0, N.L)` clamps it away. That is
 * the invariant that lets this pass touch shade without touching the sunlit
 * calibration, and it is checked directly below. */
export function sunlitWallIrradiance(rig: LightRig): Rgb {
  const direct = rig.sunIntensity * Math.cos((rig.altitude * Math.PI) / 180);
  return rig.groundColour.map((g, i) => {
    const hemisphere = (g + (rig.skyColour[i] - g) * 0.5) * rig.hemisphereIntensity;
    return hemisphere + direct * rig.sunColour[i];
  }) as Rgb;
}

/** Sun:shade illuminance ratio across the two sides of a street. */
export function wallSunShadeRatio(rig: LightRig): number {
  const shade = luminance(shadedWallIrradiance(rig));
  if (shade <= 0) return Infinity;
  return luminance(sunlitWallIrradiance(rig)) / shade;
}

/**
 * Illuminance ratio between a sunlit and a shaded surface, on the horizontal.
 *
 * Horizontal is the standard definition -- global horizontal illuminance over
 * diffuse horizontal illuminance -- and it is the only one with an unambiguous
 * real-world number to check against: a clear Sydney summer day runs roughly
 * 95,000 lux global against 13,000 lux diffuse, so 6-8:1. It is also the
 * geometry of the road and the footpath, which is most of the frame.
 *
 * A wall is a different number and now has its own function: `wallSunShadeRatio`.
 * The two used to move together, and with the bounce in they no longer do --
 * which is the point of the pass. This one is the road and the footpath and it
 * stays harsh; that one is the two sides of a street and it opens up.
 */
export function sunShadeRatio(rig: LightRig): number {
  const sinAlt = Math.sin((rig.altitude * Math.PI) / 180);
  if (sinAlt <= 0) return 1;

  // Normal straight up, so the hemisphere weight is 1 and the fill is pure sky.
  // The bounce arrives at `BOUNCE_ALTITUDE` above the horizon, so a horizontal
  // surface takes only `sin` of it -- 0.28 of what the wall opposite gets. That
  // small share is deliberate and is why this ratio barely moved: a shaded road
  // is lit from the sky and should stay that way, and the canyon integration
  // says it is if anything already over-lit here.
  const bounceOnHorizontal =
    rig.bounceIntensity *
    Math.max(0, Math.sin((BOUNCE_ALTITUDE * Math.PI) / 180)) *
    luminance(rig.bounceColour);
  const diffuse = luminance(rig.skyColour) * rig.hemisphereIntensity + bounceOnHorizontal;
  const direct = luminance(rig.sunColour) * rig.sunIntensity * sinAlt;
  if (diffuse <= 0) return Infinity;
  return (direct + diffuse) / diffuse;
}

/**
 * The reference instant: 3 pm on 15 February, the spec's own definition of
 * "looks like Sydney" and milestone 5's definition of done. Hoisted out of the
 * self-check so the check can be handed a rig other than the current one.
 */
export const REFERENCE_SOLAR = /*#__PURE__*/ solarPosition(
  sydneyTime(2026, 2, 15, 15, 0),
  LATITUDE,
  LONGITUDE,
);

/**
 * Startup self-check, in the same spirit as `verifySouthernHemisphere()`: the
 * things this project gets wrong are the ones that fail silently.
 *
 * A sun:shade ratio that drifts out of band does not throw, does not glitch, and
 * does not show up in a frame-time graph. It just makes the city read as
 * somewhere other than Sydney, which is the one thing spec 7.1 says must not
 * happen. Returns a list of complaints, empty when correct.
 *
 * `rig` defaults to what the renderer will actually use and is a parameter only
 * so the check can be pointed at a hypothetical one. That is not a convenience:
 * a self-check nobody has ever seen fail is indistinguishable from a self-check
 * that cannot fail, and the bounce bounds below were confirmed by feeding this
 * the pre-bounce rig (`{...solarRig(alt), bounceIntensity: 0}`) and watching it
 * report the wall ratio at 7.06:1 and the shade at R/B 0.61. Keep it that way:
 * if you widen a bound, re-run that case and check it still complains.
 */
export function verifyLightRig(rig = solarRig(REFERENCE_SOLAR.altitude)): string[] {
  const failures: string[] = [];
  const solar = REFERENCE_SOLAR;
  const ratio = sunShadeRatio(rig);

  if (!(ratio >= RATIO_MIN && ratio <= RATIO_MAX)) {
    failures.push(
      `Sun:shade illuminance ratio is ${ratio.toFixed(2)}:1 at 3 pm on 15 February ` +
        `(solar altitude ${solar.altitude.toFixed(1)} deg), outside the ${RATIO_MIN}-${RATIO_MAX}:1 ` +
        `window a clear Sydney summer sky produces. Below it the image reads overcast; ` +
        `above it, shade goes to unlit black. Sun ${rig.sunIntensity.toFixed(2)}, ` +
        `hemisphere ${rig.hemisphereIntensity.toFixed(2)} at sky luminance ` +
        `${luminance(rig.skyColour).toFixed(3)}.`,
    );
  }

  // The absolute level matters as much as the ratio, and it is the half that was
  // wrong before: the old rig sat at 2.86 and every sunlit surface in the frame,
  // from asphalt to white render, tone mapped into a 9-code-value band around
  // 172. This guards the scale as well as the contrast. The window is generous
  // -- it is there to catch an order of magnitude, not to police taste.
  const horizontal =
    luminance(rig.sunColour) * rig.sunIntensity * Math.sin((rig.altitude * Math.PI) / 180) +
    luminance(rig.skyColour) * rig.hemisphereIntensity +
    rig.bounceIntensity *
      Math.max(0, Math.sin((BOUNCE_ALTITUDE * Math.PI) / 180)) *
      luminance(rig.bounceColour);
  if (horizontal < 9 || horizontal > 26) {
    failures.push(
      `Horizontal illuminance is ${horizontal.toFixed(2)} at 3 pm on 15 February; ` +
        `the calibrated value is 16.3, set so a sunlit concrete footpath lands just ` +
        `under clipping and about 2.4x the zenith sky, as it does in a photograph. ` +
        `Well outside that and the exposure in main.ts no longer matches the rig.`,
    );
  }

  // --- The bounce, in three parts, because it can fail in three ways ---------
  //
  // All three exist because deleting this light is *cheap and silent*. It casts
  // no shadow, costs one N.L, and nothing breaks without it -- the scene renders,
  // the sun is still right, the sky is still right, and the only symptom is that
  // the shaded side of every street goes back to being a charcoal silhouette,
  // which reads as a taste decision rather than as a missing light. The horizontal
  // ratio above cannot catch it: without the bounce that ratio is 6.86:1, which
  // is comfortably inside its window. These are the checks that see it.

  // 1. Level. The wall ratio is the number the whole pass moved.
  const wallRatio = wallSunShadeRatio(rig);
  if (!(wallRatio >= WALL_RATIO_MIN && wallRatio <= WALL_RATIO_MAX)) {
    failures.push(
      `Wall sun:shade illuminance ratio is ${wallRatio.toFixed(2)}:1 at 3 pm on 15 February, ` +
        `outside the ${WALL_RATIO_MIN}-${WALL_RATIO_MAX}:1 window (a converged street-canyon ` +
        `integration measures the real thing at 3.7:1). Above it the shaded side of a street ` +
        `goes to a black silhouette -- that is the 7.06:1 this rig had before the bounce light ` +
        `existed. Below it the two sides of the street are within a stop of each other and the ` +
        `image reads overcast, which spec 7.1 rules out. Bounce intensity ` +
        `${rig.bounceIntensity.toFixed(2)} at ${BOUNCE_ALTITUDE} deg; shaded wall ` +
        `${luminance(shadedWallIrradiance(rig)).toFixed(2)} against sunlit ` +
        `${luminance(sunlitWallIrradiance(rig)).toFixed(2)}.`,
    );
  }

  // 2. Colour. A bounce that is present but cold fixes the level and leaves the
  //    look exactly as wrong, so the hue is bounded separately.
  const shadedWall = shadedWallIrradiance(rig);
  const warmth = shadedWall[2] > 0 ? shadedWall[0] / shadedWall[2] : Infinity;
  if (!(warmth > SHADE_WARMTH_MIN)) {
    failures.push(
      `Shaded walls are receiving R/B ${warmth.toFixed(2)}, at or under the ` +
        `${SHADE_WARMTH_MIN} floor. Shade in a Sydney street is warm-side of neutral because ` +
        `most of what reaches it bounced off sunlit road and sunlit render; skylight alone is ` +
        `0.61, which is the blue-grey-dead look this rig had before the bounce light. Check ` +
        `BOUNCE_COLOUR (${rig.bounceColour.map((c) => c.toFixed(2)).join(', ')}) and that the ` +
        `bounce light still exists.`,
    );
  }

  // 3. Geometry. The sunlit half of the frame is calibrated and this pass had no
  //    budget to touch it. The only reason it did not is that the bounce comes
  //    from behind the sun, so `max(0, N.L)` clamps it off every sunlit surface.
  //    Point it anywhere on the sun's side of the sky and every predicted value
  //    in facade.ts and street.ts is wrong at once -- silently, because a
  //    slightly brighter sunlit wall looks like nothing at all.
  const bounce = bounceDirection(solar.azimuth);
  const alignment =
    bounce.x * solar.direction.x + bounce.y * solar.direction.y + bounce.z * solar.direction.z;
  if (alignment >= 0) {
    failures.push(
      `The bounce light is on the sun's side of the sky (alignment ${alignment.toFixed(2)}, ` +
        `must be negative). It has to sit opposite the sun's azimuth so that every surface the ` +
        `sun can see clamps it away -- that is the only reason the sunlit calibration survived ` +
        `this term. Sun azimuth ${solar.azimuth.toFixed(1)} deg, bounce ` +
        `${((solar.azimuth + 180) % 360).toFixed(1)} deg at ${BOUNCE_ALTITUDE} deg altitude.`,
    );
  }
  if (BOUNCE_ALTITUDE <= 0 || BOUNCE_ALTITUDE >= 35) {
    failures.push(
      `BOUNCE_ALTITUDE is ${BOUNCE_ALTITUDE} deg. It has to stay low: it is light off the road ` +
        `and off the facade opposite, whose measured elevations run -22 to +30 deg. At or below ` +
        `zero nothing reaches a shaded road at all; far above it the term starts landing on the ` +
        `sunlit road, which is the one horizontal surface with no headroom left.`,
    );
  }

  // 4. Night. The bounce is sunlight that came back off the pavement, so it must
  //    vanish with the sun rather than lingering as a warm floor over a night
  //    scene -- spec 6.4's night is carried by the lit windows and the silhouette
  //    and nothing else, and the night fill above is luminance-matched to the old
  //    rig on the assumption that nothing else is on.
  const night = solarRig(-8);
  if (night.bounceIntensity !== 0) {
    failures.push(
      `Bounce intensity is ${night.bounceIntensity.toFixed(4)} with the sun 8 degrees below the ` +
        `horizon; it must be exactly zero. It is meant to be a fraction of the beam landing on ` +
        `the pavement, so it should switch itself off with the sun that feeds it rather than ` +
        `needing a separate night path.`,
    );
  }

  return failures;
}
