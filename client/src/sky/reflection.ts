/**
 * The sky, reflected: the one term this renderer never had, and the reason
 * every car in the game is painted a lie.
 *
 * ---------------------------------------------------------------------------
 * ## THE ADMISSION THIS FILE EXISTS TO RETIRE
 *
 * `world/cars.ts`, in the paragraph that sets the paint palette:
 *
 *   > *"Every albedo is above the true reflectance of the paint it names. A
 *   > car's clearcoat reflects the sky across the whole body, and **this
 *   > renderer has no environment map and no ambient specular** -- the only
 *   > specular it has is the sun's own lobe, which reaches a handful of facets
 *   > at roughness 0.35 and nothing else. Left at their measured reflectances,
 *   > black came out at rgb(11,8,12) and every dark car in shade was a hole.
 *   > The lift is the missing sky reflection, put where the renderer can
 *   > actually deliver it."*
 *
 * And `world/nightlights.ts`, on why a car body is not modelled as metal:
 * *"a metallic workflow with no environment map is a black object."*
 *
 * Both are correct descriptions of three's WebGPU standard material with
 * `scene.environment === null`. `EnvironmentNode` is the only thing that feeds
 * the indirect specular term, it is fed only by `scene.environment` or
 * `material.envNode`, and this build sets neither. So the specular BRDF that
 * `roughness = 0.35, metalness = 0.4` describes is integrated against exactly
 * one light -- the sun -- and against nothing else in the sky. A car facing away
 * from the sun has, physically, no highlight at all.
 *
 * That single missing term is most of the distance between "a correct render of
 * a low-poly car" and "a car". It is what draws the bright line along a roof
 * edge, the pale wash up a windscreen, the sky in the flank of a black sedan
 * that stops it being a silhouette. Nothing else on the graphics list buys as
 * much for as little.
 *
 * ---------------------------------------------------------------------------
 * ## WHY THERE IS NO TEXTURE HERE, WHICH IS THE DESIGN
 *
 * The obvious build is a PMREM: render the sky dome to a cube map, prefilter it
 * into roughness mips, hand it to `scene.environment`, refresh it on some
 * cadence as the sun moves. That is what a desktop engine does and it is the
 * wrong answer here, three times over.
 *
 *   - **It costs memory and bandwidth this build has none spare of.** A 256
 *     cube with a full mip chain is about 1.5 MB of VRAM and a PMREM pass is
 *     six faces of convolution. Small, until you ask *when* -- and the answer is
 *     "whenever the sun has moved enough", which through `sky/cycle.ts` is
 *     continuously, all day.
 *   - **A cadence is a visible step.** Refresh the PMREM every N seconds and
 *     every car in the frame changes colour together, N seconds after the sky
 *     did. Refresh it every frame and it is not a cadence, it is a per-frame
 *     convolution pass.
 *   - **And at roughness 0.35 there is nothing in it to see.** This is the part
 *     that decides it. The GGX lobe at alpha = 0.1225 has a half-angle of
 *     roughly 20 degrees and the prefiltered mip a car body samples is blurred
 *     to about that. A 20-degree cone average of a clear Preetham sky **is a
 *     three-point vertical gradient**: dark ground below, a bright pale band at
 *     the horizon, blue above. Sydney has no clouds in the shipped dome and no
 *     buildings in the environment. The expensive thing and the cheap thing
 *     compute the same answer.
 *
 * So the environment is that gradient, evaluated analytically from the light rig
 * the sky is already publishing. **It costs no texture, no memory, no pass and
 * no cadence** -- it is three uniforms, so it is exact every frame, all day, for
 * free. The cadence question the brief asked to have justified turns out to have
 * the best possible answer: there isn't one.
 *
 * What is given up is real: no reflection of the building you are parked beside,
 * no reflection of the road, no cloud in a windscreen. Those need a probe or a
 * screen-space trace, and both are on the list in `GRAPHICS.md` under their own
 * costs. What is bought is the term that was missing entirely.
 *
 * ---------------------------------------------------------------------------
 * ## THE COMPOSITE, AND WHY IT CANNOT BRIGHTEN A CALIBRATED SURFACE
 *
 * The reflection is applied as a **clearcoat**, which is both what a car
 * actually has and the formulation with the property this needs:
 *
 *     out = lit * (1 - F)  +  env(reflect(V, N)) * F
 *
 * A convex combination. The coat takes a Fresnel fraction `F` of what leaves the
 * surface and replaces it with what the coat reflects, rather than adding on
 * top. So:
 *
 *   - A surface whose lit value already **equals** the sky it reflects does not
 *     move at all, at any `F`. That is the white car roof -- calibrated at
 *     rgb(240,244,249) against a sunlit footpath, and reflecting a sky of about
 *     the same luminance. `verifyReflection` asserts it moves by under two code
 *     values.
 *   - A surface **darker** than the sky gains, and a surface brighter than the
 *     sky loses. Which is the correct direction in both cases and is exactly the
 *     phenomenon `cars.ts` was compensating for by hand.
 *   - Nothing can ever exceed `max(lit, env)`. There is no configuration of this
 *     term that blows out a frame.
 *
 * `COAT_F0` is deliberately **under** the 0.04 a real polyurethane clearcoat
 * carries, because the paint underneath is already lifted for the reflection
 * this now supplies and the lift has not been unwound (that is eight albedos of
 * re-derivation and it is written up in `GRAPHICS.md` as the follow-up it is).
 * Under-shooting head-on is the conservative half of that trade; the grazing
 * half is where the look lives and is untouched.
 *
 * `COAT_MAX` caps the grazing end at half rather than letting Schlick run to 1,
 * and the reason is geometric rather than optical. These cars are faceted --
 * `flatShading = true`, 102 to 110 triangles a body -- so a facet's normal is
 * the *average* of a curve, and a low-poly flank reports far more grazing area
 * than the shape it stands for actually has. At `F = 1` the silhouette of every
 * car becomes a mirror of the sky and the fleet reads as chrome. Half is a rim
 * of sky, which is what a clearcoat looks like.
 *
 * ---------------------------------------------------------------------------
 * Pure and three-free, like `calibration.ts` and for the same reason: the server
 * runs `verifyReflection` and may not import three, and the offline car sheet
 * (`scripts/render-car-sheet.mjs --pbr`) evaluates the same arithmetic on the
 * CPU. `world/skyreflect.ts` holds the twelve lines of TSL that say this again
 * in a shader, and the two are kept honest by `SHEET_REFERENCE` below.
 */

import {
  luminance,
  solarRig,
  type LightRig,
  type Rgb,
} from './calibration.ts';
import { toDisplay } from './grade.ts';

/* ---------------------------------------------------------------------------
 * THE DOME.
 * ------------------------------------------------------------------------- */

/**
 * What turns the hemisphere light's *irradiance* into the dome's *radiance*.
 *
 * The two are different quantities and the factor between them is not a
 * constant of nature but a property of this particular rig, so it is measured
 * rather than derived. `sky/sky.ts` publishes the shipped Preetham dome
 * evaluated at the reference instant: **zenith linear (0.31, 0.97, 2.73)**,
 * luminance 0.9568. The rig at the same instant carries `HEMISPHERE_DAY` 3.4
 * against `SKY_FILL_DAY` (0.48, 0.70, 1.00), luminance 2.2945. The ratio is
 * 0.417, and `verifyReflection` asserts that a mirror pointed at the zenith at
 * 3 pm on 15 February returns the dome's own number to within one per cent.
 *
 * Driving it off the *rig* rather than off Preetham directly is what makes it
 * work at every other hour: `solarRig` already blends `SKY_FILL_DAY` to
 * `SKY_FILL_DUSK` on `warmthAt` and down to `SKY_FILL_NIGHT` after dark, so the
 * reflection turns orange at sunset and goes to the night floor by itself, with
 * one clock, exactly as every other term in the rig does. Sampling Preetham for
 * real would mean evaluating the dome on the CPU once a frame and would still
 * disagree with the hemisphere light that is actually lighting the car.
 */
export const ZENITH_TRIM = 0.417;

/**
 * How much brighter the horizon band is than the zenith, after the lobe has
 * blurred it.
 *
 * The raw dome is far more extreme than this: `sky.ts` measures the horizon haze
 * at (6.5, 7.9, 8.3) against a zenith of (0.31, 0.97, 2.73), which is a factor
 * of eight in luminance. That number is the *peak* of a band about ten degrees
 * thick, and nothing in this file ever sees a peak -- a roughness-0.35 lobe is
 * twenty degrees across, so it averages the band with the sky above and the
 * ground below it and lands near a factor of two and a half. 2.6, and it is the
 * one constant here with real uncertainty in it. Too high and every car wears a
 * white belt at eye level; too low and the horizon stops being where a
 * reflection comes from, which is where most reflections come from.
 */
export const HORIZON_GAIN = 2.6;

/**
 * And how much of the sky's blue the horizon band keeps: none of it, nearly.
 *
 * Haze is scattered by aerosol rather than by air, so it is close to white --
 * (6.5, 7.9, 8.3) is barely tinted at all against a zenith at nearly nine to one
 * blue over red. Mixing the sky colour toward its own luminance by 0.65 gets
 * most of that without a second colour to keep in step with the rig.
 */
export const HORIZON_DESAT = 0.65;

/**
 * Where the ground half of the environment ends and the sky half begins, in the
 * y of the reflected direction.
 *
 * Not a step at zero. A reflected ray at exactly the horizon sees the haze band,
 * a ray a little under it sees the far city and the road, and the crossover in a
 * real cone-averaged environment is soft over about twenty degrees -- which is
 * the lobe width, again. -0.12 to 0.30 is that, smoothstepped.
 */
export const HORIZON_LOW = -0.12;
export const HORIZON_HIGH = 0.3;

/**
 * The ground half's radiance, as a fraction of what the rig's ground fill would
 * give on its own.
 *
 * `GROUND_FILL` (0.2, 0.165, 0.115) times the hemisphere intensity times
 * `ZENITH_TRIM` is 0.24 of luminance, against a zenith of 0.96 -- a quarter, and
 * about right: sunlit asphalt at albedo 0.09 under 16.3 of horizontal
 * irradiance leaves the surface at 0.47, and a car's downward reflection is
 * mostly *shaded* road, kerb and its own shadow. Left at 1.0 rather than given a
 * knob nobody would know how to set.
 */
export const GROUND_GAIN = 1.0;

/** The environment, as the three levels a vertical gradient needs. */
export interface SkyEnv {
  /** Straight up. */
  zenith: Rgb;
  /** The band at eye level, pale and bright. */
  horizon: Rgb;
  /** Straight down. */
  ground: Rgb;
}

function desaturate(c: Readonly<Rgb>, amount: number): Rgb {
  const y = luminance(c);
  return [c[0] + (y - c[0]) * amount, c[1] + (y - c[1]) * amount, c[2] + (y - c[2]) * amount];
}

/** The environment for a rig. Pure; `skyEnvAt` is the altitude-driven wrapper. */
export function skyEnvFor(rig: LightRig): SkyEnv {
  const k = rig.hemisphereIntensity * ZENITH_TRIM;
  const zenith: Rgb = [rig.skyColour[0] * k, rig.skyColour[1] * k, rig.skyColour[2] * k];
  const pale = desaturate(zenith, HORIZON_DESAT);
  const horizon: Rgb = [pale[0] * HORIZON_GAIN, pale[1] * HORIZON_GAIN, pale[2] * HORIZON_GAIN];
  const g = k * GROUND_GAIN;
  const ground: Rgb = [rig.groundColour[0] * g, rig.groundColour[1] * g, rig.groundColour[2] * g];
  return { zenith, horizon, ground };
}

/** The environment at a solar altitude. One call, one rig, no state. */
export function skyEnvAt(altitudeDeg: number): SkyEnv {
  return skyEnvFor(solarRig(altitudeDeg));
}

/** `smoothstep(0,1,x)`, clamped. */
function smoothstep01(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/**
 * Look the environment up along a direction.
 *
 * Only the `y` of the direction matters: the dome has no azimuthal structure in
 * it, because the sun's own lobe is delivered by the `DirectionalLight` and
 * putting a second copy of it in here would double every highlight in the game.
 * That omission is deliberate and is the one thing about this environment that a
 * PMREM of the real dome would do differently -- and doing it differently would
 * be a bug.
 *
 * Two ramps rather than one, so the horizon band is a band and not a ceiling:
 * ground to horizon under `HORIZON_LOW`..0, horizon to zenith from 0 up.
 */
export function envRadiance(env: SkyEnv, dirY: number): Rgb {
  if (dirY <= 0) {
    const t = smoothstep01((dirY - HORIZON_LOW) / (0 - HORIZON_LOW));
    return [
      env.ground[0] + (env.horizon[0] - env.ground[0]) * t,
      env.ground[1] + (env.horizon[1] - env.ground[1]) * t,
      env.ground[2] + (env.horizon[2] - env.ground[2]) * t,
    ];
  }
  const t = smoothstep01(dirY / HORIZON_HIGH);
  return [
    env.horizon[0] + (env.zenith[0] - env.horizon[0]) * t,
    env.horizon[1] + (env.zenith[1] - env.horizon[1]) * t,
    env.horizon[2] + (env.zenith[2] - env.horizon[2]) * t,
  ];
}

/* ---------------------------------------------------------------------------
 * THE COAT.
 * ------------------------------------------------------------------------- */

/** Reflectance head-on. See the header for why it is under a real coat's 0.04. */
export const COAT_F0 = 0.03;

/** And the cap at grazing. See the header: faceted geometry over-reports grazing. */
export const COAT_MAX = 0.5;

/** Schlick's exponent. Five, because it is Schlick's exponent. */
export const COAT_POWER = 5;

/**
 * Fresnel reflectance of the coat at a given `N.V`.
 *
 * Schlick between `COAT_F0` and `COAT_MAX` rather than between `COAT_F0` and 1.
 * `nDotV` is clamped rather than trusted: an interpolated normal on a faceted
 * two-sided car mesh can and does report a back-facing dot.
 */
export function coatFresnel(nDotV: number): number {
  const c = 1 - (nDotV < 0 ? 0 : nDotV > 1 ? 1 : nDotV);
  return COAT_F0 + (COAT_MAX - COAT_F0) * Math.pow(c, COAT_POWER);
}

/**
 * The composite. See the header: a convex combination, so it cannot exceed
 * `max(lit, env)` in any channel.
 */
export function clearcoatOver(lit: Readonly<Rgb>, env: Readonly<Rgb>, nDotV: number): Rgb {
  const f = coatFresnel(nDotV);
  return [
    lit[0] * (1 - f) + env[0] * f,
    lit[1] * (1 - f) + env[1] * f,
    lit[2] * (1 - f) + env[2] * f,
  ];
}

/* ---------------------------------------------------------------------------
 * THE SEAM WITH THE OFFLINE SHEET.
 *
 * `scripts/render-car-sheet.mjs` is a Node script with its own scanline
 * rasteriser and no way to import this file -- it is `.mjs`, this is TypeScript,
 * and the sheet has to keep running under a bare `node` in a handoff. So the
 * twelve lines above exist twice, and this table is the thing that notices when
 * only one copy is edited: the sheet prints these three numbers under `--pbr`
 * and refuses to draw if they disagree with what it computes.
 *
 * If you change a constant in this file, run the sheet. It will tell you.
 * ------------------------------------------------------------------------- */

/** `[nDotV, dirY]` probes and the reflectance and radiance luminance they must give at the reference instant. */
export const SHEET_REFERENCE: ReadonlyArray<{
  nDotV: number;
  dirY: number;
  fresnel: number;
  radiance: number;
}> = [
  { nDotV: 1.0, dirY: 1.0, fresnel: 0.03, radiance: 0.956856 },
  { nDotV: 0.5, dirY: 0.0, fresnel: 0.044688, radiance: 2.487826 },
  { nDotV: 0.1, dirY: -1.0, fresnel: 0.30753, radiance: 0.239369 },
];

/* ---------------------------------------------------------------------------
 * THE CHECK.
 * ------------------------------------------------------------------------- */

/** The reference instant, repeated from `calibration.ts` rather than imported as a cycle. */
const REFERENCE_ALTITUDE = 57.11;

export function verifyReflection(): string[] {
  const failures: string[] = [];
  const env = skyEnvAt(REFERENCE_ALTITUDE);

  /* --- 1. The dome is the dome.
   *
   * `sky/sky.ts` publishes the shipped Preetham parameters evaluated at the
   * reference instant and reads the zenith off at linear (0.31, 0.97, 2.73).
   * A mirror pointed straight up has to return that, or this environment is
   * lighting cars with a sky nobody can see. One per cent, because `ZENITH_TRIM`
   * is quoted to three figures and that is all it is worth. */
  {
    const up = envRadiance(env, 1);
    const want = luminance([0.31, 0.97, 2.73]);
    const got = luminance(up);
    if (Math.abs(got - want) > want * 0.01) {
      failures.push(
        `A mirror at the zenith reflects luminance ${got.toFixed(4)} where the shipped Preetham dome ` +
          `puts ${want.toFixed(4)} at 3 pm on 15 February. ZENITH_TRIM (${ZENITH_TRIM}) is what ties the ` +
          'hemisphere light\'s irradiance to the dome\'s radiance, and past a per cent the environment is ' +
          'a different sky from the one drawn behind it.',
      );
    }
    // And it is blue, which the raw rig colour guarantees but the desaturation
    // above could quietly take away if it were ever applied to the zenith.
    if (!(up[2] > up[0] * 2)) {
      failures.push(`The zenith reflection is (${up.map((c) => c.toFixed(3)).join(', ')}); the sky overhead is blue.`);
    }
  }

  /* --- 2. The gradient has the shape a sky has. */
  {
    if (!(luminance(env.horizon) > luminance(env.zenith))) {
      failures.push('The horizon band is not brighter than the zenith. Every clear sky is.');
    }
    if (!(luminance(env.ground) < luminance(env.zenith))) {
      failures.push('The ground half of the environment is brighter than the sky. Cars would be lit from below.');
    }
    if (!(luminance(env.horizon) < luminance(env.zenith) * 4)) {
      failures.push(
        `The horizon is ${(luminance(env.horizon) / luminance(env.zenith)).toFixed(2)}x the zenith. ` +
          'The raw dome is 8x at the peak of a ten-degree band; a roughness-0.35 lobe averages that down to ' +
          'about 2.5, and anything near the raw figure puts a white belt across every car in the game.',
      );
    }
    /*
     * Monotone on each side of the horizon, so a car turning has no seam in it.
     *
     * Two sweeps rather than one, because the shape is a *ridge*: brightest at
     * the horizon and falling away both up into the blue and down into the
     * ground. That is the sky, and a single monotone sweep would be asserting
     * the wrong thing -- it is the one mistake available here, and it was made
     * once before this comment was written.
     */
    let rising = -Infinity;
    for (let y = -1; y <= 0.0001; y += 0.01) {
      const v = luminance(envRadiance(env, Math.min(y, 0)));
      if (v < rising - 1e-9) {
        failures.push(`The environment dims on the way up to the horizon, at y = ${y.toFixed(2)}.`);
        break;
      }
      rising = v;
    }
    let falling = Infinity;
    for (let y = 0; y <= 1.0001; y += 0.01) {
      const v = luminance(envRadiance(env, Math.min(y, 1)));
      if (v > falling + 1e-9) {
        failures.push(`The environment brightens on the way from the horizon to the zenith, at y = ${y.toFixed(2)}.`);
        break;
      }
      falling = v;
    }
    for (const y of [-1, -0.5, 0, 0.5, 1]) {
      const v = envRadiance(env, y);
      if (v.some((c) => !(c >= 0) || !Number.isFinite(c))) {
        failures.push(`The environment at y = ${y} is (${v.join(', ')}).`);
      }
    }
  }

  /* --- 3. The coat is a Fresnel and behaves like one. */
  {
    if (Math.abs(coatFresnel(1) - COAT_F0) > 1e-12) failures.push(`Head-on reflectance is ${coatFresnel(1)}, not COAT_F0.`);
    if (Math.abs(coatFresnel(0) - COAT_MAX) > 1e-12) failures.push(`Grazing reflectance is ${coatFresnel(0)}, not COAT_MAX.`);
    if (!(COAT_F0 > 0 && COAT_F0 <= 0.04)) {
      failures.push(`COAT_F0 is ${COAT_F0}; a clearcoat is 0.04 and this is deliberately at or under it while the paint palette stays lifted.`);
    }
    if (!(COAT_MAX > COAT_F0 && COAT_MAX <= 0.6)) {
      failures.push(`COAT_MAX is ${COAT_MAX}; past about 0.6 a faceted low-poly fleet reads as chrome.`);
    }
    let last = -Infinity;
    for (let n = 0; n <= 1.0001; n += 0.01) {
      const f = coatFresnel(Math.min(n, 1));
      if (f > last + 1e-12 && n > 0) {
        failures.push(`Reflectance rose as the surface turned to face the camera, at N.V = ${n.toFixed(2)}.`);
        break;
      }
      last = f;
    }
    // Clamped, not trusted: a two-sided faceted car reports both.
    if (coatFresnel(-3) !== COAT_MAX) failures.push('A back-facing normal was not clamped to the grazing end.');
    if (coatFresnel(9) !== COAT_F0) failures.push('An over-unity dot was not clamped to the head-on end.');
  }

  /* --- 4. The composite is a convex combination.
   *
   * The property the whole design rests on: nothing can be brighter than the
   * brighter of the two things being mixed, at any angle, for any input. Walked
   * rather than argued, because this is the assertion that lets the term default
   * to on over a calibrated palette. */
  {
    const probes: Rgb[] = [
      [0, 0, 0], [0.03, 0.027, 0.031], [0.4, 0.41, 0.43], [1.38, 1.4, 1.42], [8, 8, 8],
    ];
    for (const lit of probes) {
      for (let n = 0; n <= 1.0001; n += 0.05) {
        for (const y of [-1, -0.2, 0, 0.4, 1]) {
          const e = envRadiance(env, y);
          const out = clearcoatOver(lit, e, Math.min(n, 1));
          for (let i = 0; i < 3; i++) {
            const hi = Math.max(lit[i], e[i]) + 1e-9;
            const lo = Math.min(lit[i], e[i]) - 1e-9;
            if (out[i] > hi || out[i] < lo) {
              failures.push(
                `The clearcoat put ${out[i].toFixed(4)} outside [${lo.toFixed(4)}, ${hi.toFixed(4)}] ` +
                  `at N.V ${n.toFixed(2)}, y ${y}. It is meant to be a mix, not an add.`,
              );
              return failures;
            }
          }
        }
      }
    }
  }

  /* --- 5. And the anchors the car palette was built on survive it.
   *
   * `cars.ts` names two, and they are the two the whole palette is hung from:
   * a white roof in sun that must sit level with the sunlit footpath, and a
   * black car in shade that must stay the darkest thing on the street. Both are
   * evaluated through the real chain -- Lambert, Neutral, sRGB -- using the
   * ported curve in `grade.ts`, which is the first time either has been checkable
   * inside the repository at all. */
  {
    const rig = solarRig(REFERENCE_ALTITUDE);
    const E = rig.sunIntensity * Math.sin((REFERENCE_ALTITUDE * Math.PI) / 180);
    // A roof: horizontal, so the beam lands square-ish and the reflection is the
    // zenith. Albedo 0.805 (`PAINT[0]`, white), metalness 0.4 already priced in.
    const roofLit: Rgb = [
      (0.805 * (E * rig.sunColour[0] + rig.hemisphereIntensity * rig.skyColour[0])) / Math.PI,
      (0.805 * (E * rig.sunColour[1] + rig.hemisphereIntensity * rig.skyColour[1])) / Math.PI,
      (0.805 * (E * rig.sunColour[2] + rig.hemisphereIntensity * rig.skyColour[2])) / Math.PI,
    ];
    const roofPlain = toDisplay(roofLit);
    const roofCoat = toDisplay(clearcoatOver(roofLit, envRadiance(env, 1), 1));
    const moved = Math.max(...roofPlain.map((v, i) => Math.abs(v - roofCoat[i])));
    if (moved > 2) {
      failures.push(
        `A white car roof in sun moved ${moved} code values under the coat, from ` +
          `rgb(${roofPlain.join(',')}) to rgb(${roofCoat.join(',')}). The composite is a mix, so a surface ` +
          'already sitting at the sky\'s own level is meant to be almost exactly where it was -- that is what ' +
          'makes this safe to run over a hand-calibrated palette. Check COAT_F0 and ZENITH_TRIM.',
      );
    }
    // And the other end: a black car in shade must gain -- that is the entire
    // point, and a term that leaves it alone has not been applied -- but must
    // stay well under the white roof.
    const shadeE: Rgb = [
      rig.hemisphereIntensity * rig.skyColour[0],
      rig.hemisphereIntensity * rig.skyColour[1],
      rig.hemisphereIntensity * rig.skyColour[2],
    ];
    const blackLit: Rgb = [
      (0.11 * shadeE[0]) / Math.PI, (0.112 * shadeE[1]) / Math.PI, (0.124 * shadeE[2]) / Math.PI,
    ];
    const blackPlain = toDisplay(blackLit);
    const blackCoat = toDisplay(clearcoatOver(blackLit, envRadiance(env, 0.2), 0.6));
    const gained = luminance(blackCoat as unknown as Rgb) - luminance(blackPlain as unknown as Rgb);
    if (!(gained > 1)) {
      failures.push(
        `A black car in shade went from rgb(${blackPlain.join(',')}) to rgb(${blackCoat.join(',')}) -- it gained ` +
          'nothing. The reflection is the term that stops a dark car being a hole, and if it is not visible there ' +
          'it is not doing the job the paint palette was lifted to fake.',
      );
    }
    if (luminance(blackCoat as unknown as Rgb) > luminance(roofCoat as unknown as Rgb) * 0.6) {
      failures.push(
        `A black car in shade at rgb(${blackCoat.join(',')}) is within striking distance of a white roof in sun at ` +
          `rgb(${roofCoat.join(',')}). The coat has stopped being a rim and started being a repaint.`,
      );
    }
  }

  /* --- 6. The sheet's copy of the arithmetic. See `SHEET_REFERENCE`. */
  for (const row of SHEET_REFERENCE) {
    const f = coatFresnel(row.nDotV);
    const r = luminance(envRadiance(env, row.dirY));
    if (Math.abs(f - row.fresnel) > 1e-5) {
      failures.push(
        `SHEET_REFERENCE says the coat is ${row.fresnel} at N.V ${row.nDotV} and it is ${f.toFixed(6)}. ` +
          'The offline car sheet asserts these same numbers; update both or the sheet stops drawing.',
      );
    }
    if (Math.abs(r - row.radiance) > 1e-4) {
      failures.push(
        `SHEET_REFERENCE says the environment is ${row.radiance} of luminance at y ${row.dirY} and it is ` +
          `${r.toFixed(6)}. Same rule: the sheet asserts this too.`,
      );
    }
  }

  return failures;
}
