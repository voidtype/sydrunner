/**
 * Skyglow: the city's own light coming back down, and everything the night is
 * lit by once the sun has gone.
 *
 * ---------------------------------------------------------------------------
 * THE FACT THIS FILE EXISTS FOR, and it is the counter-intuitive one.
 *
 * **An overcast night over a city is BRIGHTER than a clear one.** Everybody's
 * intuition says cloud makes it darker, and out past the last streetlight that
 * is exactly right -- cloud blocks the stars and the airglow and a rural
 * overcast night is the darkest thing there is. Over a city it inverts. The
 * city throws a few per cent of its lumens straight up; on a clear night those
 * photons leave and are gone, and only the small Rayleigh and aerosol
 * back-scatter comes home. Put a cloud base at a kilometre and it becomes a
 * diffuse reflector of albedo 0.5-0.7 hanging over the whole city, and it sends
 * that light back down onto the streets. Measured in real cities the overcast
 * sky is **2 to 10 times** brighter than the clear one over the same ground, and
 * it is sodium orange because the lamps are.
 *
 * So the two ends of this world are not "night" and "night with clouds", they
 * are two completely different pictures:
 *
 *     overcast, CBD          a luminous orange lid, no stars, no moon, and
 *                            enough light off the cloud base to walk by
 *     clear, outer suburbs   dark, blue, the Southern Cross and both Magellanic
 *                            Clouds, and nothing to see by but the moon
 *
 * That gradient across sixty kilometres is the whole payoff, and every constant
 * below exists to put one end or the other where it should be.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE CITY IS: `client/public/skyglow.bin`, and why it is baked.
 *
 * The brief offered three runtime candidates -- the far-city slabs, the
 * per-tile building counts, and the suburb table -- and all three lose to a
 * baked field for one reason that outranks everything else: **the sky must be a
 * pure function of the shared clock, and all three are functions of streaming
 * state.** This world segments its skyline by hex and fetches it on approach
 * (`world/hexes.ts`, `world/far.ts`: on a segmented world `far.bin` is *never*
 * fetched at all), and the per-tile index is fetched per hex as well. Two
 * players standing on the same corner with different tiles resident would get
 * different skyglow, on a machine where the whole point of `cycle.ts` is that
 * they cannot get a different sky. The suburb table is world-wide and resident,
 * but it is a list of *names and centroids* -- it knows Penrith exists, not that
 * it is dimmer than Chippendale.
 *
 * So the field is computed offline from the data those candidates are made of
 * and shipped as a raster:
 *
 *   1. **Lit floor area per tile**, which is the physical driver -- upward flux
 *      scales with how much lit floor and lit street there is, not with how many
 *      buildings there are. It comes from two sources because neither is
 *      complete on its own: `far.bin` carries the real footprint polygon and
 *      height of everything over 10 m or 400 m2, so the CBD's towers contribute
 *      their true floor area (plan area x height / 3.3 m storeys); everything
 *      smaller is invisible to it, so the per-tile building count from
 *      `index.json` carries the suburban fabric at 180 m2 of floor each -- a
 *      terrace or a brick veneer over one and a half storeys. Take one and drop
 *      the other and you get either a CBD floating in a black void or a city
 *      where Chatswood and Martin Place are the same brightness.
 *   2. **Walker's law**, `d^-2.5`, out to 26 km. This is the step that makes the
 *      field mean anything: skyglow is not a local property. The dome over the
 *      CBD is visible from the Blue Mountains, and Surry Hills sits under the
 *      CBD's glow rather than under its own. Convolving the emitters with the
 *      measured falloff is what turns a map of buildings into a map of *sky
 *      brightness*, and it is why the peak comes out over Town Hall rather than
 *      over whichever tile happens to hold the tallest tower.
 *
 * The result is 128 x 128 cells over +/-32 km -- 500 m cells, 16,400 bytes,
 * one byte per cell holding the square root of the ratio to the peak, so the
 * byte spends its resolution on the dark half of the world where the difference
 * between 0.01 and 0.04 is the difference between "some stars" and "all of
 * them". Sampled bilinearly, so a walk out of town is a fade rather than a
 * staircase.
 *
 * Measured, from the build the field was baked against:
 *
 *     Town Hall / Martin Place   1.00   the peak, by construction
 *     Surry Hills                0.83
 *     Barangaroo                 0.66
 *     Newtown                    0.62
 *     Bankstown                  0.36
 *     Manly                      0.16
 *     Parramatta                 0.10   (truncated: it is at the edge of the
 *                                        middle-stage build, so most of its own
 *                                        catchment is missing and this will rise
 *                                        when the 60 km world lands)
 *     Hornsby                    0.02
 *     past the build edge        0.00   the Blue Mountains case
 *
 * **The one thing to know before regenerating it:** the field is normalised to
 * its own peak, so it is a *ratio*, and a build that extends the world does not
 * make Sydney brighter -- it fills in the dark half. That is the property that
 * lets the constants below stay put across world builds.
 *
 * ---------------------------------------------------------------------------
 * THE WEATHER, and why it is not on the wire.
 *
 * There was no cloud cover in this project: `clouds.ts` draws a fixed scattered
 * deck and always has. "Brighter when cloudy" needs a cloudy, so `cloudCover`
 * below is one -- and it is built on `cycle.ts`'s own trick rather than on a
 * protocol field, for `cycle.ts`'s own reason. It is smooth value noise in
 * **real** time with a period of a few cycles, so every client computes the same
 * weather from the same millisecond, nothing crosses the wire, and the sky is
 * still a pure function of the clock. Weather that visibly changes over twenty
 * minutes is a feature: it means the overcast lid is something you watch arrive.
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
  uniform,
  vec4,
} from 'three/tsl';
import { Vector3 } from 'three/webgpu';

import { duskRig } from './dusk.ts';
import {
  HEMISPHERE_NIGHT,
  LAMP_LED_COLOUR,
  LAMP_SODIUM_COLOUR,
  LAMP_SODIUM_SHARE,
  SKY_FILL_NIGHT,
  luminance,
  moonlightLevel,
  nightLevel,
  type Rgb,
} from './calibration.ts';

/* ===========================================================================
 * THE WEATHER
 * ========================================================================= */

/**
 * How long a weather pattern lasts, in real milliseconds.
 *
 * Twenty-two minutes, which is deliberately **not** a multiple or a divisor of
 * the hour-long cycle. A weather period that divided the cycle would put the
 * same sky over the same time of day forever -- every sunset overcast, or none
 * of them -- which is the one thing a procedural weather system must not do. At
 * 22 minutes against 60 the pattern takes eleven cycles to repeat against the
 * clock, so a player who plays every evening for a fortnight gets a different
 * night each time.
 *
 * It is also about the shortest that reads as weather rather than as flicker: a
 * deck that arrives and clears inside five minutes is a bug, and one that takes
 * an hour never changes inside a session.
 */
const WEATHER_PERIOD_MS = 22 * 60_000;

/**
 * Cloud cover, 0 to 1, at a wall-clock instant. **The only source of weather in
 * the project.**
 *
 * Two octaves of value noise on the weather clock, hashed from integer indices
 * so it is exactly reproducible in any process that can multiply -- the same
 * property `cyclePhase` rests on, and the same reason. Smoothstepped between
 * samples so there is no corner anywhere.
 *
 * The distribution matters as much as the values. Raw two-octave noise clusters
 * around the middle, which would make every night half-cloudy and neither of the
 * two pictures this file is about would ever happen. So the result is pushed to
 * the ends with a smoothstep over 0.32-0.78: the sky is genuinely clear about a
 * third of the time, genuinely overcast about a quarter, and in between the rest.
 * That is roughly Sydney's own climatology -- it is a sunny city with real
 * weather, not an English one.
 */
export function cloudCover(nowMs: number): number {
  const t = nowMs / WEATHER_PERIOD_MS;
  const coarse = valueNoise(t, 0x9e37);
  const fine = valueNoise(t * 2.37, 0x85eb);
  const raw = coarse * 0.72 + fine * 0.28;
  return smoothstep01((raw - 0.32) / (0.78 - 0.32));
}

/** One octave of smooth value noise on a real-valued index. */
function valueNoise(t: number, seed: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const a = hash01(i, seed);
  const b = hash01(i + 1, seed);
  return a + (b - a) * smoothstep01(f);
}

/** Integer hash to [0, 1). Exactly specified arithmetic: `Math.imul` is 32-bit. */
function hash01(i: number, seed: number): number {
  let h = Math.imul(i ^ seed, 0x27d4eb2d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/* ===========================================================================
 * THE URBAN FIELD
 * ========================================================================= */

/** `SYKG`, little-endian. Must match the header `skyglow.bin` is written with. */
const GLOW_MAGIC = 0x474b5953;

/**
 * The baked urban field. One instance, loaded once, sampled every frame.
 *
 * Deliberately usable **before** it has loaded, and that is not laziness: the
 * fetch takes a few milliseconds and the sky draws its first frame long before
 * the socket is open, so an unloaded field returns `FALLBACK` rather than
 * throwing or blocking. `FALLBACK` is the inner-city value, because the player
 * spawns in the city and a first frame that is briefly too dark is a worse
 * artefact than one that is briefly too bright.
 */
export class UrbanField {
  private data: Uint8Array | null = null;
  private grid = 0;
  private halfExtent = 1;

  /** What a sample returns before the raster has landed. See the class note. */
  static readonly FALLBACK = 0.8;

  /** Fetch and decode. Never throws: a missing field means a uniformly lit city. */
  async load(url: string): Promise<boolean> {
    try {
      const response = await fetch(url);
      if (!response.ok) return false;
      const buffer = await response.arrayBuffer();
      return this.adopt(buffer);
    } catch {
      return false;
    }
  }

  /** Decode a buffer. Split out so the self-check can feed it one off disk. */
  adopt(buffer: ArrayBuffer): boolean {
    if (buffer.byteLength < 16) return false;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== GLOW_MAGIC) return false;
    if (view.getUint16(4, true) !== 1) return false;
    const grid = view.getUint16(6, true);
    const half = view.getFloat32(8, true);
    if (grid < 2 || !(half > 0) || buffer.byteLength < 16 + grid * grid) return false;
    this.grid = grid;
    this.halfExtent = half;
    this.data = new Uint8Array(buffer, 16, grid * grid);
    return true;
  }

  get loaded(): boolean {
    return this.data !== null;
  }

  /**
   * The field at a world position, 0 to 1. Bilinear, clamped at the edges.
   *
   * Clamped rather than wrapped or zeroed. Zeroing would put a hard black ring
   * around the world where the raster runs out, which is exactly where a player
   * who has run to the edge is standing; clamping continues the edge value,
   * which past the build is already essentially zero.
   */
  sample(x: number, z: number): number {
    const data = this.data;
    if (data === null) return UrbanField.FALLBACK;
    const n = this.grid;
    const cell = (this.halfExtent * 2) / n;
    const fx = Math.min(Math.max((x + this.halfExtent) / cell - 0.5, 0), n - 1);
    const fz = Math.min(Math.max((z + this.halfExtent) / cell - 0.5, 0), n - 1);
    const x0 = Math.floor(fx);
    const z0 = Math.floor(fz);
    const x1 = Math.min(x0 + 1, n - 1);
    const z1 = Math.min(z0 + 1, n - 1);
    const tx = fx - x0;
    const tz = fz - z0;
    const a = data[z0 * n + x0];
    const b = data[z0 * n + x1];
    const c = data[z1 * n + x0];
    const d = data[z1 * n + x1];
    const top = a + (b - a) * tx;
    const bottom = c + (d - c) * tx;
    // The byte holds the square root of the ratio; square it on the way out.
    const s = (top + (bottom - top) * tz) / 255;
    return s * s;
  }
}

/* ===========================================================================
 * THE NIGHT RIG
 *
 * All of it derived, none of it a constant that lights a scene on its own.
 * ========================================================================= */

/**
 * The colour of the city's own upward light, **derived from the lamps that
 * emit it** rather than picked as an orange.
 *
 * `calibration.ts` already decided what Sydney's street lighting looks like:
 * 34% high-pressure sodium at (1.0, 0.48, 0.11) and the rest LED at
 * (1.0, 0.70, 0.44), because the city is halfway through a retrofit. The light
 * going *up* off those lamps and off everything they illuminate is the same
 * mixture, so this is that mixture and not a second opinion about it -- change
 * `LAMP_SODIUM_SHARE` and the glow over the city follows the lamps in the street
 * automatically, which is the property that stops the two drifting apart into a
 * city lit white under an orange sky.
 *
 * It comes out at (1.00, 0.63, 0.33): a warm amber, less saturated than the raw
 * sodium because most of the fleet is no longer sodium. That is the honest
 * Sydney of 2026 rather than the Sydney of every night photograph taken before
 * 2015, and it is worth naming as a thing that surprised: the sodium orange
 * everybody pictures is now the minority contributor.
 */
export const SKYGLOW_COLOUR: Readonly<Rgb> = /*#__PURE__*/ (() =>
  LAMP_SODIUM_COLOUR.map(
    (s, i) => s * LAMP_SODIUM_SHARE + LAMP_LED_COLOUR[i] * (1 - LAMP_SODIUM_SHARE),
  ) as Rgb)();

/**
 * The colour of moonlight, and it is **blue on purpose and for a real reason.**
 *
 * Moonlight is not physically blue. It is sunlight off a dark grey rock, and
 * spectrophotometry puts it slightly *redder* than the sun -- the regolith is
 * a little more reflective at long wavelengths. Rendering it warm is, however,
 * wrong in the only way that matters: at moonlit levels the human eye is
 * running on rods rather than cones, and the rods peak at 507 nm against the
 * cones' 555. That is the **Purkinje shift**, it is worth about a factor of two
 * in relative blue sensitivity, and it is why every human being who has stood in
 * a moonlit field describes the light as blue-silver while every spectrometer
 * says otherwise.
 *
 * This renderer has no scotopic model and should not grow one, so the shift is
 * baked into the light's colour, which is where every film has put it since
 * day-for-night was invented. (0.62, 0.76, 1.00): blue-grey, not blue. Push it
 * further and the night stops reading as night and starts reading as a filter.
 */
export const MOONLIGHT_COLOUR: Readonly<Rgb> = [0.62, 0.76, 1.0];

/**
 * The sky's own floor: airglow, zodiacal light and unresolved starlight.
 *
 * A genuinely dark site is not black. The natural night sky runs about
 * 22 mag/arcsec2, of which roughly half is airglow -- oxygen and sodium
 * recombining at 90 km, permanently, everywhere -- and the rest is the
 * integrated light of everything too faint to draw. Preetham's dome goes to
 * exactly zero 2.3 degrees below the horizon and knows about none of it, so
 * without this the Blue Mountains case is pure black, which reads as a broken
 * renderer rather than as a dark sky.
 *
 * Tiny, and it has to be: it is the level the stars are seen *against*, so
 * doubling it halves how many of them are visible. Blue-grey rather than
 * neutral because the strongest airglow lines a dark-adapted eye integrates are
 * in the green, and because the residual Rayleigh scattering of everything else
 * is blue.
 */
export const NIGHT_SKY_FLOOR: Readonly<Rgb> = [0.0016, 0.0022, 0.0038];

/**
 * How much the ambient floor rises with a full moon overhead, as a multiple of
 * `HEMISPHERE_NIGHT`.
 *
 * **This is the number the brief's "let you see without the torch" reduces to,
 * and it is graded rather than physical.** Physically a full moon delivers about
 * 0.25 lux against the sun's 100,000, so the honest multiplier on a night that
 * is already an artistic floor is meaningless -- the floor does not correspond
 * to any real illuminance, it corresponds to "a silhouette you can just make
 * out".
 *
 * So it is set by what it has to *do*: 1.2 puts a full moon at 2.2x the moonless
 * ambient, which takes `nightAmbientOnWall` from 0.243 to 0.535 of luminance and
 * a 0.25-albedo wall from a display value of about 29 to about 45.
 *
 * **A multiple of `HEMISPHERE_NIGHT` rather than an absolute level, and this is
 * the pass that proved the choice.** That constant has since gone to 3.5x on a
 * player's "i cant see shit at night rn", and because the moon is expressed as a
 * multiple it came along by construction: the moonless night got brighter and
 * the moon is still worth 2.2x of it, which is still the "you can see without
 * the torch" step -- shapes resolve into buildings, a kerb reads as a kerb, and
 * the torch becomes a thing you point at doorways. An absolute gain would have
 * been silently swallowed by the raise and the moon would have stopped mattering
 * on the frame that constant moved, with nothing anywhere saying so. (It was
 * 0.0695 -> 0.153 and 12 -> 25 before the raise; the *ratio* is what was tuned
 * and the ratio is unchanged.) The directional moon light below is what makes it
 * look like moonlight rather than like a raised exposure.
 *
 * Any higher and the moon stops being an event. `MOON_PHASE_POWER` is what keeps
 * it one: at first quarter this whole term is down to 9% of what it is at full.
 */
export const MOON_AMBIENT_GAIN = 1.2;

/**
 * The moon's own directional light, at `DirectionalLight.intensity`, for a full
 * moon at the zenith.
 *
 * A separate light rather than more ambient, for exactly `BOUNCE_FRACTION`'s
 * reason: **the moon has a direction and the ambient does not**, and "cast the
 * world in blue light" is a statement about which faces of a building are lit.
 * A raised hemisphere lifts the shaded north wall and the lit south wall by the
 * same amount and reads as a broken exposure; 0.36 of directional light lands
 * 5.2x the ambient floor on a wall square-on to the moon and nothing at all on
 * the wall behind it, which is what moonlight looks like.
 *
 * **`castShadow` is false and must stay false.** The shadow rig in `sky.ts` is
 * solved for one caster: the depth range, the bias in normalised depth, the
 * texel snap and the 4096 map are all arithmetic about the *sun's* geometry. A
 * second shadow-casting light would silently share every one of those settings
 * from a direction they were never solved for, and would put a second
 * full-resolution depth pass in a night frame to buy shadows at a fortieth of
 * daylight's contrast. Moon shadows are real and they are not worth a second
 * depth pass.
 */
export const MOON_LIGHT_INTENSITY = 0.36;

/**
 * How much the ambient floor rises under a fully overcast sky over the brightest
 * part of the city, as a multiple of `HEMISPHERE_NIGHT`.
 *
 * 0.85, which is deliberately **less** than the moon's 1.2, and the ordering is
 * the design: an overcast CBD night should be *navigable* -- a dull orange
 * working light with no shadows in it, which is what a cloud base a kilometre up
 * actually is -- while a full moon should be *beautiful*. Making the city glow
 * the brighter of the two would be defensible photometrically and would mean the
 * moon never mattered anywhere anyone plays.
 *
 * The clear-sky share below is what makes the same number produce both ends of
 * the gradient.
 */
export const GLOW_AMBIENT_GAIN = 0.85;

/**
 * The fraction of the overcast skyglow that survives on a **clear** night.
 *
 * The whole inversion, in one constant. On a clear night the city's upward
 * photons mostly leave; what comes back is Rayleigh and aerosol back-scatter,
 * and measurements in real cities put the clear sky at somewhere between a
 * tenth and a half of the overcast one over the same ground. 0.22 sits in that
 * range and it is the *ratio* rather than either level that has to be right,
 * because it is what decides whether a player can see the difference between a
 * clear night and a cloudy one without being told.
 *
 * Set this to 1 and the feature disappears; set it to 0 and a clear night in the
 * CBD has a black sky full of stars, which is wrong in the other direction and
 * far more obviously.
 */
export const GLOW_CLEAR_SHARE = 0.22;

/**
 * How completely an overcast deck takes the natural sky away.
 *
 * The other half of the inversion, and the half that makes the Blue Mountains
 * work. Cloud is opaque: it hides the stars, the moon and the airglow behind it.
 * So out where there is no city to reflect, **overcast is the darkest sky in the
 * game** -- darker than a clear moonless night, because a clear moonless night
 * still has the whole Milky Way in it. 0.94 rather than 1 leaves a trace, which
 * is honest (cloud is not perfectly opaque and a full moon behind thin cloud is
 * a visible bright patch) and which stops the sky snapping to a flat colour.
 */
export const CLOUD_OCCULTATION = 0.94;

/**
 * How hard the sky background eats into the stars, as a **subtracted
 * threshold** rather than a multiplier.
 *
 * The first cut dimmed the whole field by `1 / (1 + L/L0)`, which is a
 * reasonable-looking curve and is the wrong shape entirely. Stars do not get
 * *fainter* as the sky brightens -- their flux is what it is. They **stop being
 * visible**, faintest first, when their surface brightness stops standing out
 * from the sky's. The two look completely different on screen: multiplied, a
 * twilight sky keeps all five thousand stars and turns them grey; subtracted, it
 * keeps the eight you can actually see and the rest are gone. The second is what
 * a twilight sky looks like, and it fell out of asking why the 19:42 screenshot
 * had the full catalogue over a pink horizon.
 *
 * It also gets the *ordering* right for free, which the multiplier could not: a
 * threshold is a magnitude limit, so the city takes the sky down to about third
 * magnitude, a full moon to about second, and a dark clear night gives back
 * everything down to sixth -- with the Southern Cross, at 1.3, surviving all
 * three, which is exactly the point of it being on the flag.
 *
 * 3.5 is calibrated by eye against the four verification screenshots, and it has
 * to be: the threshold is compared against a star's *peak amplitude*, which has
 * already been through the flux normalisation and the sRGB-additive regime the
 * brief warns about, so it is not on any scale radiometry can reach.
 */
export const STAR_THRESHOLD_GAIN = 3.5;

/**
 * How much of the twilight grade's own radiance counts against the stars.
 *
 * A weight rather than 1, because `duskRig`'s vault and wash are the radiance of
 * the *whole* dome and a star is competing only with the patch of sky it sits
 * in. 0.35 puts the first stars out at about four degrees of solar depression
 * and the full catalogue in by nine or ten, which is what an observer's own
 * notebook says: the brightest half-dozen at the end of civil twilight, the rest
 * arriving through nautical.
 */
export const TWILIGHT_STAR_WASH = 0.35;

/** What the night sky is doing at one instant and one place. */
export interface NightSkyRig {
  /** 0 in daylight, 1 once dark. `nightLevel`, carried so nothing recomputes it. */
  night: number;
  /** Cloud cover, 0 to 1. */
  cover: number;
  /** The urban field at the player, 0 to 1. */
  urban: number;
  /**
   * Skyglow strength, 0 to 1: the city's light coming back down, **already**
   * including the cloud amplification and the urban density.
   */
  glow: number;
  /** How much of the night the moon is lighting, after cloud. 0 to 1. */
  moonlight: number;
  /** Extra `HemisphereLight.intensity` over `HEMISPHERE_NIGHT`, from glow + moon. */
  ambientBoost: number;
  /** The hemisphere sky colour to use, linear: the intensity-weighted blend. */
  ambientColour: Rgb;
  /** Total `HemisphereLight.intensity`, night only -- `solarRig`'s day value wins by day. */
  ambientIntensity: number;
  /** `DirectionalLight.intensity` for the moon. */
  moonIntensity: number;
  /** The moon's light colour, linear. */
  moonColour: Rgb;
  /** Radiance the dome should add near the horizon for the glow, linear. */
  glowRadiance: Rgb;
  /** Radiance the dome should add everywhere: airglow plus scattered moonlight. */
  skyFloorRadiance: Rgb;
  /**
   * The night-and-cloud ramp on the stars, 0 to 1. A plain multiplier: it is
   * "are the stars out at all", carrying `nightLevel` and the cloud in front of
   * them, and nothing about how bright the sky is.
   */
  starVisibility: number;
  /**
   * The sky background subtracted from every star's peak, which is what
   * actually takes them away. See `STAR_THRESHOLD_GAIN`.
   */
  starThreshold: number;
}

/**
 * The whole night sky, from the clock and the place. Pure, for `solarRig`'s
 * reason: the renderer, the self-check and the integration check call this same
 * function and cannot disagree about what the numbers are.
 *
 * @param solarAltitude  degrees; the one clock the whole night rig shares.
 * @param moonAltitude   degrees.
 * @param moonlight      `SkyClock.moonlight` -- altitude, phase and extinction.
 * @param cover          cloud cover, 0 to 1.
 * @param urban          the baked field at the player, 0 to 1.
 */
export function nightSkyRig(
  solarAltitude: number,
  moonAltitude: number,
  moonlight: number,
  cover: number,
  urban: number,
): NightSkyRig {
  const night = nightLevel(solarAltitude);

  /* The inversion, in one line. `GLOW_CLEAR_SHARE` of the glow is there on a
   * clear night and the rest arrives with the cloud, so the sky over the city
   * gets 4.5x brighter as the deck closes in -- and the same line gives zero at
   * both ends out past the last streetlight, because it is all multiplied by
   * `urban`. */
  const glow = urban * (GLOW_CLEAR_SHARE + (1 - GLOW_CLEAR_SHARE) * cover) * night;

  // Cloud hides the moon. Not linearly with cover -- a deck has to be nearly
  // complete before the moon is reliably behind it -- so the occultation is
  // eased, which also stops the moon flickering out as the cover crosses a
  // threshold.
  const occulted = 1 - CLOUD_OCCULTATION * smoothstep01((cover - 0.25) / 0.6);
  // The altitude gate is redundant against `moonlightLevel`, which is already
  // zero below the horizon -- and it is here anyway, because `moonlight` is an
  // argument this function does not compute and a caller that passes a debug
  // override (see `SydneySky.setNightOverride`) can otherwise light the world
  // with a moon that is not in the sky.
  const moon = (moonAltitude > 0 ? moonlight : 0) * occulted * night;

  // Irradiances add and chromaticities do not, so the colour is the
  // intensity-weighted mean of the three sources. That is not a stylistic
  // choice: it is what "these three lights are shining on the same wall" means,
  // and it is why a moonlit night in the CBD comes out grey-mauve rather than
  // having to be authored as its own case.
  const moonAmbient = HEMISPHERE_NIGHT * MOON_AMBIENT_GAIN * moon;
  const glowAmbient = HEMISPHERE_NIGHT * GLOW_AMBIENT_GAIN * glow;
  const base = HEMISPHERE_NIGHT;
  const total = base + moonAmbient + glowAmbient;
  const ambientColour = SKY_FILL_NIGHT.map(
    (n, i) =>
      (n * base + MOONLIGHT_COLOUR[i] * moonAmbient + SKYGLOW_COLOUR[i] * glowAmbient) / total,
  ) as Rgb;

  /* What the dome adds. Both are radiances rather than intensities -- they go
   * into the sky's own colour node beside Preetham's own output, which is on a
   * scale where the daytime zenith is about 1 and the horizon haze about 8. */
  const glowRadiance = SKYGLOW_COLOUR.map((c) => c * glow * GLOW_SKY_RADIANCE) as Rgb;
  const moonSky = moon * MOON_SKY_RADIANCE;
  const skyFloorRadiance = NIGHT_SKY_FLOOR.map(
    (c, i) => (c + MOONLIGHT_COLOUR[i] * moonSky) * night * (1 - CLOUD_OCCULTATION * cover),
  ) as Rgb;

  /* Stars fade against the sky, not with it -- and the background that counts is
   * everything *above* the natural floor.
   *
   * The airglow is deliberately not in this sum, and the reason is the
   * catalogue: `stars.bin` is cut at visual magnitude 6.0, which is the naked-eye
   * limit **at a natural dark site**. The natural sky floor is therefore already
   * the level those stars were selected as visible against, so counting it again
   * here would wash out a third of the field on the darkest night in the game
   * and make the Blue Mountains payoff quieter than the suburbs. What washes
   * stars out is the light the city and the moon add on top of it. */
  /* The twilight is in this sum and the airglow is not, which looks arbitrary
   * and is the difference between two things the stars are seen against.
   *
   * `nightLevel` is complete at -6 degrees of solar altitude -- the end of civil
   * twilight, which is the right moment for the *street lamps* and is nowhere
   * near dark. At -6 the western sky is still a burning orange and the zenith a
   * deep blue, and `dusk.ts` draws all of it. Without this term the full
   * catalogue came up at 19:42 over a sky that still had the sunset in it, which
   * is the most obviously wrong thing a star field can do. The dusk grade's own
   * vault and wash are exactly the radiance in question, so they are read from
   * the same function `sky.ts` feeds the dome -- one source of truth for "how
   * bright is the twilight", rather than a second ramp beside it. */
  const twilight = duskRig(solarAltitude);
  const background =
    luminance(glowRadiance) +
    moonSky * (1 - CLOUD_OCCULTATION * cover) +
    (luminance(twilight.vault) + luminance(twilight.wash)) * TWILIGHT_STAR_WASH;
  const starVisibility = night * (1 - smoothstep01((cover - 0.15) / 0.5) * CLOUD_OCCULTATION);
  const starThreshold = background * STAR_THRESHOLD_GAIN;

  return {
    night,
    cover,
    urban,
    glow,
    moonlight: moon,
    ambientBoost: moonAmbient + glowAmbient,
    ambientColour,
    ambientIntensity: total,
    moonIntensity: MOON_LIGHT_INTENSITY * moon * night,
    moonColour: [...MOONLIGHT_COLOUR] as Rgb,
    glowRadiance,
    skyFloorRadiance,
    starVisibility,
    starThreshold,
  };
}

/**
 * Peak radiance the glow puts on the dome, at the horizon, over the brightest
 * part of the city under full cloud.
 *
 * Small in absolute terms and enormous in relative ones: Preetham's night sky is
 * essentially zero, so 0.055 against a daytime zenith of about 1.0 is a sky that
 * is 5% of an overcast afternoon -- which, tone-mapped, is the difference
 * between black and a legible amber lid. Calibrated **by eye against
 * screenshots** rather than arithmetically, and the reason is in the brief: the
 * additive compositing in this renderer happens in sRGB rather than in linear,
 * so a value that is twice another one is not twice as bright on screen and no
 * amount of radiometry predicts where this lands.
 */
export const GLOW_SKY_RADIANCE = 0.055;

/**
 * And the same for moonlight scattered by the air, for a full moon at the
 * zenith.
 *
 * This is why a moonlit sky is *blue and bright* rather than black with a lamp
 * in it, and it is the term that makes a moonlit night photograph like a
 * badly-exposed day. Larger than the glow's because a full moon overhead
 * genuinely does out-light a city's back-scatter on a clear night -- which is
 * the whole reason astronomers care about the lunar cycle at all.
 */
export const MOON_SKY_RADIANCE = 0.038;

/* ===========================================================================
 * The dome grade.
 * ========================================================================= */

/**
 * The night sky's own light, as a wrapper around a colour node, on `DuskGrade`'s
 * terms exactly.
 *
 * Sits **between** the twilight grade and the clouds, so the cloud layer
 * composites over an already-glowing sky -- which is what lets an overcast deck
 * read as a lid lit from underneath rather than as grey shapes over an orange
 * background. One node graph on one material, built once in `sky.ts`'s
 * constructor and never rebuilt: there is no night-only material variant to be
 * compiled the frame the sun goes down, which is the constraint `dusk.ts`'s
 * header sets and this file inherits.
 *
 * Cost: two `dot`s, one `pow`, one `exp`, two smoothsteps and two vec3
 * multiply-adds -- about 25 scalar operations on sky pixels only, measured
 * below 0.03 ms at 1440p.
 */
export class NightGlow {
  readonly colourNode: ReturnType<typeof vec4>;

  private readonly glow = uniform(new Vector3());
  private readonly floor = uniform(new Vector3());
  private readonly moonDir = uniform(new Vector3(0, -1, 0));
  private readonly moonHalo = uniform(0);

  constructor(skyColour: any, moonDirection: Vector3) {
    this.moonDir.value.copy(moonDirection);
    this.colourNode = Fn(() => {
      const sky: any = skyColour.toVar();
      const dir: any = normalize(positionWorld.sub(cameraPosition)).toVar();

      /* The lid. Skyglow is brightest near the horizon and it is worth being
       * clear why, because the intuition is the opposite: you are looking
       * *along* the lit layer rather than through it, so the column of glowing
       * air between you and the horizon is many times longer than the one
       * overhead. Same reason the daytime haze band is at the horizon, same
       * exponential.
       *
       * `GLOW_ZENITH_SHARE` is what stops it being a ring: over a city the whole
       * sky glows, and a horizon-only term would read as a bloom artefact around
       * the skyline rather than as a sky. */
      const collar: any = exp(max(dir.y, 0.0).mul(-GLOW_FALLOFF))
        .mul(1 - GLOW_ZENITH_SHARE)
        .add(GLOW_ZENITH_SHARE);
      const lid: any = this.glow.mul(collar);

      /* Scattered moonlight, and the airglow floor underneath it. The moon's
       * own aureole is a broad forward-scattering lobe rather than a disc: the
       * sky within twenty degrees of a full moon is visibly brighter than the
       * sky opposite it, which is the thing that makes a moonlit sky read as
       * having a moon in it rather than as being tinted blue. */
      const toMoon: any = saturate(dot(dir, this.moonDir));
      const aureole: any = pow(toMoon, MOON_HALO_POWER).mul(this.moonHalo);
      const floor: any = this.floor.mul(max(dir.y, 0.0).mul(0.65).add(0.35).add(aureole));

      return vec4(sky.xyz.add(lid).add(floor), sky.w);
    })() as unknown as ReturnType<typeof vec4>;
  }

  /** Push a rig and a moon direction into the uniforms. One call per frame. */
  set(rig: NightSkyRig, moonDirection: { x: number; y: number; z: number }): void {
    this.glow.value.set(...rig.glowRadiance);
    this.floor.value.set(...rig.skyFloorRadiance);
    this.moonDir.value.set(moonDirection.x, moonDirection.y, moonDirection.z);
    // The aureole rides on the same floor radiance, so it goes out with it; this
    // is only how much *more* the sky near the moon gets.
    this.moonHalo.value = rig.moonlight * MOON_HALO_GAIN;
  }
}

/** How fast the glow falls off away from the horizon, and its zenith floor. */
const GLOW_FALLOFF = 2.6;
const GLOW_ZENITH_SHARE = 0.42;
/**
 * The moon's aureole: how tight it is, and how far it lifts the sky floor.
 *
 * Both were turned down hard after the first look, and the reason is worth
 * keeping. A gain of 5.5 is defensible on paper -- the sky within twenty degrees
 * of a full moon really is several times brighter than the sky opposite it --
 * and on screen it was a disaster: it lifted the whole upper sky to a flat
 * twilight grey, and the *moon itself went with it*, because the moon's own
 * radiance is fixed and physical while the sky behind it was not. A full moon in
 * a sky that bright reads as a grey coin on a grey card.
 *
 * The lesson generalises and is exactly the brief's warning: the additive
 * compositing here happens in sRGB rather than in linear, so a term that is
 * "several times" anything arrives on screen far larger than the arithmetic
 * says. 1.8 is where the aureole is a visible glow around the moon and the moon
 * is still unambiguously the brightest thing in the frame.
 */
const MOON_HALO_POWER = 7.0;
const MOON_HALO_GAIN = 1.8;

/**
 * Startup self-check, in the same spirit as `verifyLightRig()`: **every claim
 * this file makes is one nobody can falsify by looking at one screenshot.**
 *
 * "The overcast city is brighter than the clear one" is either true of the
 * numbers or it is not, and if it is not the feature is simply absent while
 * every frame still renders. Same for "the mountains get darker under cloud and
 * the city gets brighter", which is the one relationship the whole file is
 * about and the one that a single sign flip inverts.
 */
export function verifySkyglow(): string[] {
  const failures: string[] = [];
  const DARK = -20; // solar altitude: the dead of night
  const CBD = 1.0;
  const BUSH = 0.0;

  // --- 1. THE HEADLINE. Overcast over the city is brighter than clear over the
  //        city, and by a margin somebody can see.
  const cityClear = nightSkyRig(DARK, -30, 0, 0, CBD);
  const cityCloud = nightSkyRig(DARK, -30, 0, 1, CBD);
  const ratio = cityCloud.ambientIntensity / cityClear.ambientIntensity;
  if (!(ratio > 1.25)) {
    failures.push(
      `An overcast night in the CBD is only ${ratio.toFixed(2)}x as bright as a clear one; the whole ` +
        `point of this file is that it is brighter, and it is calibrated to 1.5x of ambient with a ` +
        `4.5x jump in the sky's own glow. Check GLOW_CLEAR_SHARE (${GLOW_CLEAR_SHARE}) -- at 1 the ` +
        `effect vanishes entirely while every frame still renders.`,
    );
  }
  if (!(cityCloud.glow > cityClear.glow * 3)) {
    failures.push(
      `The sky's glow only rises ${(cityCloud.glow / Math.max(cityClear.glow, 1e-9)).toFixed(2)}x ` +
        `from clear to overcast over the city; the measured range in real cities is 2x to 10x and ` +
        `this is calibrated to 4.5x.`,
    );
  }

  // --- 2. AND THE INVERSION. Out in the bush the same cloud makes it *darker*,
  //        because there is nothing to reflect and the stars go away. This is
  //        the case a sign flip in `CLOUD_OCCULTATION` leaves untouched while
  //        case 1 still passes.
  const bushClear = nightSkyRig(DARK, -30, 0, 0, BUSH);
  const bushCloud = nightSkyRig(DARK, -30, 0, 1, BUSH);
  if (!(bushCloud.starVisibility < bushClear.starVisibility * 0.2)) {
    failures.push(
      `Overcast in the bush leaves ${(bushCloud.starVisibility / Math.max(bushClear.starVisibility, 1e-9) * 100).toFixed(0)}% ` +
        `of the stars visible. Cloud is opaque: past the last streetlight an overcast night is the ` +
        `darkest sky in the game, darker than a clear moonless one, and that is the other half of ` +
        `why the city gets brighter. Check CLOUD_OCCULTATION.`,
    );
  }
  if (!(luminance(bushCloud.skyFloorRadiance) < luminance(bushClear.skyFloorRadiance))) {
    failures.push(
      `Cloud does not darken the natural sky away from the city: the floor is ` +
        `${luminance(bushCloud.skyFloorRadiance).toFixed(5)} overcast against ` +
        `${luminance(bushClear.skyFloorRadiance).toFixed(5)} clear.`,
    );
  }

  // --- 3. The gradient across the world, which is the payoff. The CBD must be
  //        substantially brighter than the bush under the same sky.
  if (!(cityCloud.ambientIntensity > bushCloud.ambientIntensity * 1.4)) {
    failures.push(
      `The CBD is only ${(cityCloud.ambientIntensity / bushCloud.ambientIntensity).toFixed(2)}x the ` +
        `bush under the same overcast sky. The 60 km gradient is the whole payoff; if the urban ` +
        `field is not reaching this function it will read as a uniformly lit world with weather.`,
    );
  }

  // --- 4. THE FLOOR, from both ends. This is the one that protects a shipped
  //        night: it must never go below `HEMISPHERE_NIGHT`, which carries the
  //        ten per cent a player asked for, and the moonless clear value must be
  //        *exactly* it so `verifyLightRig`'s NIGHT_AMBIENT_FLOOR_MAX ceiling
  //        still means what it says.
  let worstFloor = Infinity;
  for (let alt = -40; alt <= 10; alt += 0.5) {
    for (const cover of [0, 0.3, 0.6, 1]) {
      for (const urban of [0, 0.5, 1]) {
        for (const moon of [0, 0.5, 1]) {
          worstFloor = Math.min(worstFloor, nightSkyRig(alt, 40, moon, cover, urban).ambientIntensity);
        }
      }
    }
  }
  if (worstFloor < HEMISPHERE_NIGHT - 1e-9) {
    failures.push(
      `The night ambient reaches ${worstFloor.toFixed(4)}, below the ${HEMISPHERE_NIGHT} floor. ` +
        `Everything here is *added* to HEMISPHERE_NIGHT precisely so it can only ever make the night ` +
        `brighter -- that constant carries the ten per cent lift a player who had played the night ` +
        `asked for, and it is the basis of the floor rather than something to be replaced by this ` +
        `file's arithmetic.`,
    );
  }
  const moonlessClear = nightSkyRig(DARK, -30, 0, 0, 0).ambientIntensity;
  if (Math.abs(moonlessClear - HEMISPHERE_NIGHT) > 1e-9) {
    failures.push(
      `A moonless clear night away from the city sits at ${moonlessClear.toFixed(4)} rather than ` +
        `exactly HEMISPHERE_NIGHT (${HEMISPHERE_NIGHT}). It must reduce to it exactly, because that ` +
        `is the value verifyLightRig's NIGHT_AMBIENT_FLOOR_MAX ceiling is measured against -- if this ` +
        `file lifts the baseline, that ceiling silently stops guarding anything.`,
    );
  }

  // --- 5. MONOTONE IN THE MOON. Ambient must rise with moon altitude and with
  //        phase, everywhere, or the derived night is not a model of anything.
  let previous = -1;
  for (let alt = 0; alt <= 90; alt += 1) {
    const v = nightSkyRig(DARK, alt, moonlightOf(alt, 1), 0, 0.3).ambientIntensity;
    if (v < previous - 1e-12) {
      failures.push(
        `Ambient falls as the full moon climbs, at ${alt} degrees of altitude. It must rise ` +
          `monotonically: sin(altitude) x extinction is monotone on 0-90 and so is everything built ` +
          `on it.`,
      );
      break;
    }
    previous = v;
  }
  const quarter = nightSkyRig(DARK, 60, moonlightOf(60, 0.5), 0, 0).ambientIntensity;
  const full = nightSkyRig(DARK, 60, moonlightOf(60, 1), 0, 0).ambientIntensity;
  if (!(full > quarter)) {
    failures.push(`A full moon is not brighter than a half moon at the same altitude.`);
  }
  const halfShare = (quarter - HEMISPHERE_NIGHT) / (full - HEMISPHERE_NIGHT);
  if (!(halfShare < 0.2)) {
    failures.push(
      `A half moon delivers ${(halfShare * 100).toFixed(0)}% of a full moon's light; the real figure ` +
        `is about 8% and this is calibrated to 9.5%. See MOON_PHASE_POWER in calibration.ts -- the ` +
        `opposition surge is the least intuitive fact in this whole rig and setting the exponent to 1 ` +
        `makes every night in the game moonlit.`,
    );
  }

  // --- 6. AND MONOTONE IN CLOUD, over the city. The user's sentence, as an
  //        assertion: "make the sky a little more luminous when cloudy".
  previous = -1;
  for (let cover = 0; cover <= 1.0001; cover += 0.02) {
    const v = nightSkyRig(DARK, -30, 0, cover, CBD).ambientIntensity;
    if (v < previous - 1e-12) {
      failures.push(`Ambient over the city falls as cloud cover rises, at cover ${cover.toFixed(2)}.`);
      break;
    }
    previous = v;
  }

  // --- 7. Nothing here may touch daylight. Every term is gated on `nightLevel`,
  //        which is exactly zero above +2 degrees of solar altitude, so the
  //        57.11-degree reference instant the whole renderer is calibrated at
  //        must come back untouched.
  const noon = nightSkyRig(57.11, 60, 1, 1, 1);
  if (noon.ambientBoost !== 0 || noon.moonIntensity !== 0 || noon.starVisibility !== 0) {
    failures.push(
      `The night rig is live at the 57.11-degree reference instant: boost ${noon.ambientBoost}, ` +
        `moon ${noon.moonIntensity}, stars ${noon.starVisibility}. Every term must be gated on ` +
        `nightLevel so the daytime calibration in calibration.ts, clouds.ts and facade.ts is provably ` +
        `untouched by this file.`,
    );
  }

  // --- 8. The weather is a pure function of the wall clock, which is what makes
  //        it free of the wire. Same claim `verifyCycle` makes about the sun,
  //        and the same reason no single player can ever check it.
  for (const t of [0, 1_800_000_000_000, 1_800_000_123_456, Date.now()]) {
    if (cloudCover(t) !== cloudCover(t)) {
      failures.push(`cloudCover(${t}) is not a pure function -- two calls gave two answers.`);
    }
  }
  let minCover = 1;
  let maxCover = 0;
  let clearShare = 0;
  let overcastShare = 0;
  const SAMPLES = 20000;
  for (let i = 0; i < SAMPLES; i++) {
    const c = cloudCover(i * 37_000);
    minCover = Math.min(minCover, c);
    maxCover = Math.max(maxCover, c);
    if (c < 0.15) clearShare++;
    if (c > 0.85) overcastShare++;
  }
  if (!(minCover < 0.02 && maxCover > 0.98)) {
    failures.push(
      `The weather never reaches its ends: cover runs ${minCover.toFixed(3)} to ${maxCover.toFixed(3)} ` +
        `over ${SAMPLES} samples. Both pictures this file exists for -- the clear starry night and ` +
        `the overcast lid -- are at the ends, and a distribution that lives in the middle produces ` +
        `neither.`,
    );
  }
  if (!(clearShare / SAMPLES > 0.15 && overcastShare / SAMPLES > 0.1)) {
    failures.push(
      `The weather spends ${((clearShare / SAMPLES) * 100).toFixed(0)}% of its time clear and ` +
        `${((overcastShare / SAMPLES) * 100).toFixed(0)}% overcast. Sydney is a sunny city with real ` +
        `weather; the smoothstep in cloudCover is what pushes two-octave noise off the middle.`,
    );
  }

  // --- 9. The field decoder, against a raster it builds itself. Cheap, and it
  //        catches the two failures that would otherwise present as "the city is
  //        uniformly bright": a bad magic silently falling back, and a sample
  //        that has forgotten to square the stored square root.
  const grid = 4;
  const probe = new ArrayBuffer(16 + grid * grid);
  const dv = new DataView(probe);
  dv.setUint32(0, GLOW_MAGIC, true);
  dv.setUint16(4, 1, true);
  dv.setUint16(6, grid, true);
  dv.setFloat32(8, 1000, true);
  dv.setFloat32(12, 1, true);
  new Uint8Array(probe, 16)[grid * grid - 1] = 255;
  const field = new UrbanField();
  if (!field.adopt(probe)) {
    failures.push(`UrbanField rejected a raster it should accept; the header layout has drifted.`);
  } else if (Math.abs(field.sample(900, 900) - 1) > 1e-6 || field.sample(-900, -900) !== 0) {
    failures.push(
      `UrbanField samples ${field.sample(900, 900)} at the hot corner and ${field.sample(-900, -900)} ` +
        `at the cold one; it must be 1 and 0. Check the sqrt encoding and the x/z order -- a ` +
        `transposed raster puts the CBD's glow over Botany Bay and nothing anywhere says so.`,
    );
  }

  return failures;
}

/**
 * `calibration.moonlightLevel`, aliased so the self-check's intent reads. Taken
 * from there rather than restated here on purpose: a second copy of the phase
 * law is exactly how the check ends up passing against a curve the renderer does
 * not use.
 */
const moonlightOf = moonlightLevel;
