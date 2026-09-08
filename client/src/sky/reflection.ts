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
 * ## WHAT ELSE IS IN THIS FILE
 *
 * The environment above was built for cars and it turned out to be the term
 * another surface was missing too, so this file now has two arms hanging off one
 * dome. They share `skyEnvFor` and nothing else, and each has its own switch in
 * `calibration.ts` and its own check at the bottom:
 *
 *   - **the coat** -- `CAR_SKY_REFLECT`, `verifyReflection`. The paragraphs
 *     above.
 *   - **the glazing arm** -- `GLAZING_SKY_REFLECT`, `verifyGlazing`.
 *     `GRAPHICS.md` item 2. The same coat at glass's own two constants, over
 *     `curtain_wall`, the window rectangles inside every other wall slot, and
 *     the landmark glazing band. Its own section below opens with what the audit
 *     got wrong about it, which is worth reading before touching `world/facade.ts`.
 *
 * One dome under both is the point rather than an accident: a car and a tower's
 * glass now agree about what the sky is doing, at every hour, because there is
 * one function that says so.
 *
 * ---------------------------------------------------------------------------
 * Pure and three-free, like `calibration.ts` and for the same reason: the server
 * runs both checks and may not import three, and the two offline sheets
 * (`scripts/render-car-sheet.mjs --pbr`, `scripts/render-landmark-sheet.mjs
 * --pbr`) evaluate the same arithmetic on the CPU. `world/skyreflect.ts` holds
 * the twelve lines of TSL that say this again in a shader, and the copies are
 * kept honest by `SHEET_REFERENCE`, `SHEET_ENV` and `SHEET_GLAZING` below.
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
 * THE GLAZING ARM. `GRAPHICS.md` item 2.
 *
 * ## WHAT THE AUDIT SAID, AND WHERE IT WAS WRONG
 *
 * `GRAPHICS.md` reads, in the item this section delivers:
 *
 *   > *"`curtain_wall` carries `roughness 0.10, metalness 0.28` and the facade
 *   > shader gives every window a glazing-keyed reflectivity -- against an
 *   > environment that does not exist. A metallic workflow with no environment
 *   > is a black object, so every window in the CBD is a hole."*
 *
 * The first sentence is true and the second is only true after dark, and the
 * distinction is the whole design of what follows. That audit was written off
 * the *material table*; `world/facade.ts` has for a long time carried a
 * hand-authored answer of its own -- `GLASS_SKY`, a two-anchor dome with a
 * fitted falloff, a sun-half gradient, an aureole and a full Schlick, added
 * through `emissiveNode` so that reflected radiance does not scale with the
 * irradiance landing on the wall. By day a Sydney window is not a hole. It is
 * one of the best-argued surfaces in the build.
 *
 * What is actually wrong with it is three things, and they are all one thing:
 *
 *   1. **It is frozen at 3 pm.** `GLASS_SKY` is a pair of literals off the
 *      Preetham dome at the reference instant. At golden hour the CBD reflects
 *      a blue afternoon while the sky behind it is orange, which is precisely
 *      the fault `sky/dusk.ts` fixed for `scene.fog` and gave the reason for:
 *      *"a pale blue haze over a burning horizon reads as a bug in the renderer
 *      rather than as distance."*
 *   2. **It is switched off at night** -- `globals.nightFactor.oneMinus()` --
 *      and `facade.ts`'s own night table says what that costs: *unlit glass
 *      rgb(0, 0, 0)*. That is the hole the audit named, and it is a hole for
 *      half of every day.
 *   3. **The material's own specular is still fed by nothing.** `curtain_wall`
 *      at metalness 0.28 hands 28% of its diffuse to an indirect specular term
 *      that `EnvironmentNode` would supply and this build has never had. The
 *      emissive is masked to the *glass*, so the mullion and spandrel grid --
 *      which is most of the area of a tower at any distance where the panes
 *      have gone sub-pixel -- gets none of it back.
 *
 * All three are the same missing term, and it is the term `skyEnvFor` above
 * already computes off the rig: a sky that is exact at every hour, warm at
 * dusk, and at a night floor rather than at zero.
 *
 * ## SO IT IS THE SAME COAT, WITH TWO CONSTANTS CHANGED
 *
 *     out = lit * (1 - F * strength)  +  env(reflect(V, N)) * F * strength
 *
 * Identical to the car's, and convex for the same reason and with the same
 * consequence: **no pixel this runs over can be brighter than the brighter of
 * the surface and the sky**, at any angle, for any input. That is what lets it
 * default to on across a facade table whose every row is a measured
 * reflectance with a published display value beside it.
 *
 * `strength` is per pixel rather than per material, and it is what keeps brick
 * brick. See `GLAZING_COAT` for the slot table and `world/facade.ts` for the
 * mask inside a slot.
 *
 * ## THE TWO COATS IN SERIES, WHICH IS THE ONE THING TO BE HONEST ABOUT
 *
 * On a window pane the facade's own `glazing` term has already taken its
 * Fresnel share `f` of the outgoing radiance and replaced it with the sharp
 * dome. This coat then takes `F` of *what is left*, so the total reflective
 * share is `f + F - f*F` where the physically correct answer is `f`. Head-on
 * that is an over-reflection of `F0*(1 - f)` -- about four points -- of an
 * environment that is *dimmer* than the one the emissive used, because this one
 * is a twenty-degree cone average and that one is the raw ten-degree haze peak.
 * At grazing `f` runs to 1 and the over-reflection vanishes, which is the end
 * where a mistake would have shown.
 *
 * Four points of a dimmer sky, bounded by convexity, bought against a term that
 * is exact all day and does not switch off at night. That is the trade, stated
 * rather than hidden, and it is why `GLAZING_ON_GLASS` exists as a name even
 * though it is 1.
 *
 * Doing it the other way -- feeding the live environment *into* `GLASS_SKY` --
 * was the first design and it is wrong: that table is a mirror-lobe sample of
 * the raw dome, eight times the zenith, and this one is a roughness-0.35 cone
 * average at two and a half. Substituting one for the other would darken every
 * window in the city by a factor of three and move sixteen published display
 * values that were measured against the sky drawn behind them. The two lobes
 * are both real and they belong to different roughnesses; the composite carries
 * both.
 * ------------------------------------------------------------------------- */

/**
 * Reflectance of glass head-on.
 *
 * 0.04, which is float glass, full stop: `((1.52 - 1) / (1.52 + 1))^2` is
 * 0.0426 and every renderer in the world rounds it to 0.04. Unlike `COAT_F0`
 * this is **not** shaded down for a lifted palette underneath, because there is
 * no lifted palette underneath -- `MATERIAL_LOOK.curtain_wall` is a measured
 * blue-green at rho 0.11 and `facade.ts` says in as many words that *"a curtain
 * wall's brightness is its reflection, which is the specular lobe, not this"*.
 * This is that lobe.
 */
export const GLAZING_F0 = 0.04;

/**
 * And the cap at grazing, which is the one taste decision in this section.
 *
 * The car's cap is 0.5 and the argument for it is geometric -- a 110-triangle
 * body reports far more grazing area than the curve it stands for. **That
 * argument does not apply here.** A wall is a flat quad with a true normal, and
 * real glass at grazing incidence genuinely is a mirror; Schlick running to 1.0
 * would be correct optics.
 *
 * It is capped anyway, at 0.85, and the reason is the one `facade.ts` already
 * gives for its own dome: *"what is deliberately not modelled: occlusion. The
 * glass sees an unobstructed dome, so inside a narrow canyon it reflects haze
 * band where a real window would reflect the building across the street."* At
 * `F = 1` the silhouette of every tower in the CBD becomes a perfect mirror of
 * a sky with no city in it, which is a brighter and flatter error than the one
 * being fixed -- and spec 7.3's **never shiny** is aimed at exactly that frame.
 * 0.85 leaves a fifteen per cent floor of the building's own surface in the
 * grazing pixels, which is about the share a real skyline occupies of the low
 * sky it stands in.
 *
 * This is the knob. If the CBD reads as a disco ball, it is this number, and
 * `GLAZING_SKY_REFLECT` in `calibration.ts` is the switch behind it.
 */
export const GLAZING_MAX = 0.85;

/** Schlick's exponent, again. */
export const GLAZING_POWER = 5;

/**
 * How much coat a window pane gets, against the mullion beside it.
 *
 * One, and it is a name rather than a literal so that the argument above --
 * two coats in series over-reflect head-on by `F0*(1 - f)` -- has somewhere to
 * be turned into a number if a frame says it should be. Reaching for it means
 * deciding that four points of a dim sky on a pane that is already mirroring a
 * bright one is visible, which is a thing only eyes can say.
 */
export const GLAZING_ON_GLASS = 1;

/**
 * Fresnel of the glazing coat at a given `N.V`. Schlick, clamped, between
 * `GLAZING_F0` and `GLAZING_MAX`.
 */
export function glazingFresnel(nDotV: number): number {
  const c = 1 - (nDotV < 0 ? 0 : nDotV > 1 ? 1 : nDotV);
  return GLAZING_F0 + (GLAZING_MAX - GLAZING_F0) * Math.pow(c, GLAZING_POWER);
}

/**
 * The composite, with a per-pixel strength.
 *
 * `strength` is the glass mask: 1 on a pane, 0 on the brick around it, and
 * whatever the shader's `smoothstep` gives on the edge between. **At strength 0
 * this returns `lit` bit-for-bit** -- `lit * (1 - 0) + env * 0` is `lit * 1 + 0`
 * -- and `verifyGlazing` asserts that by identity rather than by tolerance,
 * because it is the property that lets a coated material be handed to every
 * wall slot in the city without a single masonry value moving.
 */
export function glazingCoatOver(
  lit: Readonly<Rgb>,
  env: Readonly<Rgb>,
  nDotV: number,
  strength: number,
): Rgb {
  const f = glazingFresnel(nDotV) * (strength < 0 ? 0 : strength > 1 ? 1 : strength);
  return [
    lit[0] * (1 - f) + env[0] * f,
    lit[1] * (1 - f) + env[1] * f,
    lit[2] * (1 - f) + env[2] * f,
  ];
}

/**
 * Which slots the coat runs on at all, and how hard, as a fraction of `F`.
 *
 * **Three kinds of row, and the middle one is the answer to "is a window in a
 * brick wall a slot".** It is not. There are twenty-two material slots in this
 * city and exactly one of them is glazing; a window in a terrace is a *rectangle
 * inside* `brick_red`, computed per pixel by the facade shader's window
 * grammar, and there is no slot that names it and never will be one.
 *
 *   1.0   `curtain_wall` -- the slot that *is* glass. The coat runs over the
 *         whole surface, mullions and spandrels included, because those are the
 *         panels whose metalness 0.28 has never had anything to reflect and
 *         because past about four hundred metres they are all a tower is.
 *   1.0   `landmark_glass` -- not a facade slot at all; it is
 *         `world/landmarks.ts`' own material, at roughness 0.14 and metalness
 *         0.28, and it is the Sydney Tower turret's observation band and the
 *         glazed mouths under the Opera House shells. Same physics, same
 *         defect, same fix, and it is in this table rather than in that file so
 *         that "what is glass in this world" is one list.
 *   1.0   the eight wall slots that carry windows -- `brick_red`,
 *         `brick_cream`, `brick_brown`, `sandstone`, `concrete_precast`,
 *         `corrugated_steel`, `render_painted`, `fibro`. The strength here is a
 *         *ceiling*: the shader multiplies it by the glass mask, which is zero
 *         on every pixel of wall, so a brick facade is bit-identical outside its
 *         window rectangles. See `world/facade.ts`.
 *   0     everything else. Roofs have no windows and `finishRoof` returns before
 *         the window grammar is built. The awning fascia and the three fence
 *         styles are served by their own modules. The seven ground surfaces are
 *         not facade materials at all.
 *
 * Keyed by plain strings rather than by `MaterialName`, because this file is
 * three-free so that the server can run the check and `world/facade.ts` is not.
 * The type system still closes the loop from the other side: `facade.ts` assigns
 * this to a `Record<MaterialName, number>`, so a new slot with no row here is a
 * **compile error**, which is the same guarantee `MATERIAL_LOOK` gives and for
 * the same reason.
 */
export const GLAZING_COAT = {
  brick_red: 1,
  brick_cream: 1,
  brick_brown: 1,
  sandstone: 1,
  concrete_precast: 1,
  curtain_wall: 1,
  corrugated_steel: 1,
  render_painted: 1,
  fibro: 1,
  roof_terracotta: 0,
  roof_steel: 0,
  road_asphalt: 0,
  footpath_concrete: 0,
  kerb_sandstone: 0,
  park_grass: 0,
  contact_ao: 0,
  awning_fascia: 0,
  fence_masonry: 0,
  fence_iron: 0,
  fence_timber: 0,
  bush_floor: 0,
  wetland_mud: 0,
  landmark_glass: 1,
} as const;

/**
 * The slots whose *whole surface* is glass, as against the ones where the coat
 * is gated by a per-pixel window mask.
 *
 * The distinction cannot be read off `GLAZING_COAT` -- both kinds carry 1, and
 * they have to, because the number there is a ceiling on `F` and not a coverage
 * fraction. So it is written out, and `verifyGlazing` checks that every name
 * here has a nonzero row above it.
 */
export const GLAZING_WHOLE_SURFACE: readonly string[] = ['curtain_wall', 'landmark_glass'];

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

/**
 * The environment at the reference instant, written out.
 *
 * The sheet has no sun and no clock -- it draws one car against one fixed light
 * so that a wrong nose or a missing panel is the only thing that can differ
 * between two runs. So it takes the 3 pm dome as a constant, and these are the
 * three triples it hard-codes. `verifyReflection` checks them against
 * `skyEnvAt(57.11)`, so the sheet cannot drift from the game by more than the
 * distance between this table and the code above it.
 */
export const SHEET_ENV: {
  readonly zenith: Rgb;
  readonly horizon: Rgb;
  readonly ground: Rgb;
} = {
  zenith: [0.680544, 0.99246, 1.4178],
  horizon: [2.236382, 2.520226, 2.907285],
  ground: [0.28356, 0.233937, 0.163047],
};

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

/**
 * The same fence, for the glazing arm and the *landmark* sheet.
 *
 * `scripts/render-landmark-sheet.mjs --pbr` draws the Sydney Tower's turret and
 * the Opera House's glazed mouths with this coat on them, and it is a second
 * `.mjs` with a third copy of the arithmetic in it. It shares `SHEET_ENV` above
 * -- the environment is one environment and the whole point of it is that it is
 * shared -- and needs only its own three Fresnel probes, because that is the
 * only thing the glazing arm changes.
 *
 * The sheet prints these and refuses to draw if they disagree, exactly as the
 * car sheet does. `verifyGlazing` is the other half.
 */
export const SHEET_GLAZING: ReadonlyArray<{ nDotV: number; fresnel: number }> = [
  { nDotV: 1.0, fresnel: 0.04 },
  { nDotV: 0.5, fresnel: 0.065312 },
  { nDotV: 0.1, fresnel: 0.518297 },
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
  for (const key of ['zenith', 'horizon', 'ground'] as const) {
    const want = SHEET_ENV[key];
    const got = env[key];
    for (let i = 0; i < 3; i++) {
      if (Math.abs(got[i] - want[i]) > 1e-5) {
        failures.push(
          `SHEET_ENV.${key} is (${want.map((c) => c.toFixed(6)).join(', ')}) and the rig gives ` +
            `(${got.map((c) => c.toFixed(6)).join(', ')}). The offline car sheet hard-codes the first of those, ` +
            'so the sheet is now drawing cars under a different sky from the game. Update both.',
        );
        break;
      }
    }
  }
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

/* ---------------------------------------------------------------------------
 * THE GLAZING CHECK.
 *
 * Separate from `verifyReflection` rather than folded into it, and the reason is
 * the switch: `GLAZING_SKY_REFLECT` and `CAR_SKY_REFLECT` are two decisions
 * (`calibration.ts` says why), so a frame that goes wrong should produce a
 * failure that names which of them to reach for. Both boot lists carry both.
 * ------------------------------------------------------------------------- */

/**
 * What `world/facade.ts` publishes for the two surfaces this coat lands on
 * hardest, restated here because this file is three-free and that one is not.
 *
 * `shadedWall` and `sunlitWall` are the pair of irradiances quoted above
 * `glazing` in that file -- a shaded wall and a sunlit one at 3 pm on 15
 * February, in the same linear units as everything else here. `curtainWall` is
 * `MATERIAL_LOOK.curtain_wall`, to the digit. If either moves there and not here
 * this check goes on asserting a facade the game does not draw, which is why
 * both are named in `facade.ts`'s own comment as the other half of this.
 */
const FACADE_ANCHOR = {
  shadedWall: [3.44, 3.19, 3.05] as Rgb,
  sunlitWall: [9.85, 10.16, 10.59] as Rgb,
  curtainWall: [0.07, 0.115, 0.12] as Rgb,
  curtainMetalness: 0.28,
};

export function verifyGlazing(): string[] {
  const failures: string[] = [];
  const env = skyEnvAt(REFERENCE_ALTITUDE);

  /* --- 1. The slot table covers the world, and covers the right half of it.
   *
   * Every material slot in the city has a row -- `world/facade.ts` closes this
   * from the type side by assigning the table to a `Record<MaterialName, ...>`,
   * so a missing slot is a compile error there, and this end asserts the count
   * so that a slot *deleted* from the pipeline does not leave a row behind
   * pointing at nothing. */
  {
    const rows = Object.entries(GLAZING_COAT);
    // 22 material slots plus `landmark_glass`, which is not one.
    if (rows.length !== 23) {
      failures.push(
        `GLAZING_COAT has ${rows.length} rows. It is meant to be the 22 slots in ` +
          '`world/facade.MATERIALS` plus `landmark_glass`, so that "what is glass in this world" is ' +
          'one list. A row too few is a compile error in facade.ts; a row too many is this.',
      );
    }
    for (const [slot, k] of rows) {
      if (!(k >= 0 && k <= 1)) {
        failures.push(`GLAZING_COAT.${slot} is ${k}; it is a ceiling on a Fresnel and lives in [0, 1].`);
      }
    }
    for (const slot of GLAZING_WHOLE_SURFACE) {
      const k = (GLAZING_COAT as Record<string, number>)[slot];
      if (!(k > 0)) {
        failures.push(
          `GLAZING_WHOLE_SURFACE names ${slot} as a slot that is glass all over, and GLAZING_COAT gives ` +
            `it ${k}. One of the two lists has been edited alone.`,
        );
      }
    }
    // And the roofs and the ground, explicitly, because these are the rows a
    // careless "coat everything" edit would flip and nothing else would notice.
    for (const slot of [
      'roof_terracotta', 'roof_steel', 'road_asphalt', 'footpath_concrete', 'kerb_sandstone',
      'park_grass', 'contact_ao', 'awning_fascia', 'fence_masonry', 'fence_iron', 'fence_timber',
      'bush_floor', 'wetland_mud',
    ]) {
      if ((GLAZING_COAT as Record<string, number>)[slot] !== 0) {
        failures.push(
          `GLAZING_COAT.${slot} is nonzero. A roof has no windows, the ground is not a facade material at ` +
            'all, and the awning and the three fences are drawn by their own modules -- a coat on any of ' +
            'them is a sky reflection on a surface nobody asked one for.',
        );
      }
    }
  }

  /* --- 2. At strength zero the coat is the identity, by identity.
   *
   * The property the whole slot table rests on. Every wall slot in the city gets
   * a coated material, and what keeps a brick wall bit-for-bit what it was is
   * that the mask is zero on it -- so this is asserted as exact equality across
   * a sweep of angles and directions rather than to a tolerance, because a
   * tolerance here would be admitting the possibility. */
  {
    const probes: Rgb[] = [
      [0, 0, 0], [0.235, 0.083, 0.058], [0.51, 0.39, 0.225], [0.7, 0.68, 0.62], [4, 4, 4],
    ];
    let bad = 0;
    for (const lit of probes) {
      for (let n = 0; n <= 1.0001; n += 0.05) {
        for (const y of [-1, -0.2, 0, 0.4, 1]) {
          const out = glazingCoatOver(lit, envRadiance(env, y), Math.min(n, 1), 0);
          for (let i = 0; i < 3; i++) if (out[i] !== lit[i]) bad++;
        }
      }
    }
    if (bad > 0) {
      failures.push(
        `The glazing coat moved an uncoated surface on ${bad} of the probes. At strength 0 it is ` +
          '`lit * (1 - 0) + env * 0`, which is `lit` exactly, and every brick, sandstone, render and fibro ' +
          'pixel in the city is relying on that -- they all wear a coated material with a zero mask.',
      );
    }
  }

  /* --- 3. The Fresnel is a Fresnel. Same shape as the car's, two constants up. */
  {
    if (Math.abs(glazingFresnel(1) - GLAZING_F0) > 1e-12) {
      failures.push(`Head-on glass reflectance is ${glazingFresnel(1)}, not GLAZING_F0.`);
    }
    if (Math.abs(glazingFresnel(0) - GLAZING_MAX) > 1e-12) {
      failures.push(`Grazing glass reflectance is ${glazingFresnel(0)}, not GLAZING_MAX.`);
    }
    if (!(GLAZING_F0 >= COAT_F0)) {
      failures.push(
        `GLAZING_F0 (${GLAZING_F0}) is under COAT_F0 (${COAT_F0}). Glass is more reflective head-on than ` +
          "a clearcoat over paint -- the car's figure is deliberately shaded down for a lifted palette and " +
          'this one is not, so this ordering is the thing that says the two arms are still two arms.',
      );
    }
    if (!(GLAZING_MAX > 0.5 && GLAZING_MAX <= 0.92)) {
      failures.push(
        `GLAZING_MAX is ${GLAZING_MAX}. Under about a half and a tower stops being a mirror at its ` +
          'silhouette, which is the read this is for; past about 0.92 every grazing pixel in the CBD is a ' +
          "perfect mirror of a sky with no city in it, and spec 7.3's \"never shiny\" is aimed at that frame.",
      );
    }
    let last = -Infinity;
    for (let n = 0; n <= 1.0001; n += 0.01) {
      const f = glazingFresnel(Math.min(n, 1));
      if (f > last + 1e-12 && n > 0) {
        failures.push(`Glass reflectance rose as the pane turned to face the camera, at N.V = ${n.toFixed(2)}.`);
        break;
      }
      last = f;
    }
    if (glazingFresnel(-3) !== GLAZING_MAX) failures.push('A back-facing glass normal was not clamped to grazing.');
    if (glazingFresnel(9) !== GLAZING_F0) failures.push('An over-unity glass dot was not clamped to head-on.');
    if (GLAZING_ON_GLASS < 0 || GLAZING_ON_GLASS > 1) {
      failures.push(`GLAZING_ON_GLASS is ${GLAZING_ON_GLASS}; it is a fraction of a Fresnel.`);
    }
  }

  /* --- 4. And it is still a convex combination, at every strength.
   *
   * The car's check walks strength 1 only, because a car has no mask. This one
   * has to walk the mask as well: the edge of a window rectangle is a
   * `smoothstep`, so every value in between is a strength some pixel in the city
   * is actually running at. */
  {
    const probes: Rgb[] = [
      [0, 0, 0], [0.05, 0.083, 0.086], [0.4, 0.41, 0.43], [1.38, 1.4, 1.42], [8, 8, 8],
    ];
    for (const lit of probes) {
      for (const s of [0, 0.17, 0.5, 0.83, 1]) {
        for (let n = 0; n <= 1.0001; n += 0.1) {
          for (const y of [-1, -0.2, 0, 0.4, 1]) {
            const e = envRadiance(env, y);
            const out = glazingCoatOver(lit, e, Math.min(n, 1), s);
            for (let i = 0; i < 3; i++) {
              const hi = Math.max(lit[i], e[i]) + 1e-9;
              const lo = Math.min(lit[i], e[i]) - 1e-9;
              if (out[i] > hi || out[i] < lo) {
                failures.push(
                  `The glazing coat put ${out[i].toFixed(4)} outside [${lo.toFixed(4)}, ${hi.toFixed(4)}] ` +
                    `at N.V ${n.toFixed(2)}, y ${y}, strength ${s}. It is meant to be a mix, not an add.`,
                );
                return failures;
              }
            }
          }
        }
      }
    }
  }

  /* --- 5. The anchors.
   *
   * The white car roof again, on the *glazing* constants, because it is the one
   * surface in the game measured to sit level with the sky it reflects and
   * therefore the one place a coat that was secretly an add would show. Two code
   * values, the same tolerance the car coat holds, at a higher F0.
   *
   * Then the surface this is actually for: a curtain wall on the shaded side of
   * a street, which is the frame `facade.ts` calls the tell of real glazing. It
   * has to *gain*, and it has to stay under the sky it is reflecting. */
  {
    const rig = solarRig(REFERENCE_ALTITUDE);
    const beam = rig.sunIntensity * Math.sin((REFERENCE_ALTITUDE * Math.PI) / 180);
    const roofLit: Rgb = [
      (0.805 * (beam * rig.sunColour[0] + rig.hemisphereIntensity * rig.skyColour[0])) / Math.PI,
      (0.805 * (beam * rig.sunColour[1] + rig.hemisphereIntensity * rig.skyColour[1])) / Math.PI,
      (0.805 * (beam * rig.sunColour[2] + rig.hemisphereIntensity * rig.skyColour[2])) / Math.PI,
    ];
    const plain = toDisplay(roofLit);
    const coated = toDisplay(glazingCoatOver(roofLit, envRadiance(env, 1), 1, 1));
    const moved = Math.max(...plain.map((v, i) => Math.abs(v - coated[i])));
    if (moved > 2) {
      failures.push(
        `A neutral surface calibrated to the sky's own level moved ${moved} code values under the glazing ` +
          `coat, from rgb(${plain.join(',')}) to rgb(${coated.join(',')}). GLAZING_F0 is ${GLAZING_F0} and ` +
          'the composite is a mix, so this is meant to be within the two code values the car coat holds.',
      );
    }

    // A shaded curtain wall, through three's own metallic split: the diffuse
    // that survives `metalness` is `colour * (1 - metalness)`, and the specular
    // it was traded for has had nothing to integrate against since the build
    // began. This is the pixel the item exists for.
    const albedo = FACADE_ANCHOR.curtainWall.map((c) => c * (1 - FACADE_ANCHOR.curtainMetalness));
    const wallLit: Rgb = [
      (albedo[0] * FACADE_ANCHOR.shadedWall[0]) / Math.PI,
      (albedo[1] * FACADE_ANCHOR.shadedWall[1]) / Math.PI,
      (albedo[2] * FACADE_ANCHOR.shadedWall[2]) / Math.PI,
    ];
    // Looking slightly up at a vertical wall from the street: the mirror
    // direction leaves near the horizon, which is where most of a city's glass
    // reflections come from.
    const wallEnv = envRadiance(env, 0.2);
    const wallPlain = toDisplay(wallLit);
    const wallCoated = toDisplay(glazingCoatOver(wallLit, wallEnv, 0.55, 1));
    const gained = luminance(wallCoated as unknown as Rgb) - luminance(wallPlain as unknown as Rgb);
    if (!(gained > 4)) {
      failures.push(
        `A shaded curtain wall went from rgb(${wallPlain.join(',')}) to rgb(${wallCoated.join(',')}) -- it ` +
          'gained nothing worth the instructions. This is the surface the item exists for: metalness 0.28 ' +
          'with no environment is 28% of the diffuse traded for a specular fed by nothing, and if the coat ' +
          'is not visible here it is not doing the job.',
      );
    }
    if (luminance(wallCoated as unknown as Rgb) > luminance(toDisplay(wallEnv) as unknown as Rgb)) {
      failures.push(
        `A shaded curtain wall at rgb(${wallCoated.join(',')}) is brighter than the sky it is reflecting at ` +
          `rgb(${toDisplay(wallEnv).join(',')}). A mix cannot do that; something has become an add.`,
      );
    }

    /* And the night, which is the hole the audit named.
     *
     * `world/facade.ts` gates its own `glazing` term with
     * `nightFactor.oneMinus()` and its night table says what is left: *unlit
     * glass rgb(0, 0, 0)*. This coat is driven by `solarRig` instead, so after
     * dark it delivers the rig's night floor rather than nothing. Small -- it
     * has to be, or the skyline stops being a silhouette -- but not zero, and
     * "not zero" is the entire claim. */
    const nightEnv = skyEnvAt(-30);
    const nightGlass = glazingCoatOver([0, 0, 0], envRadiance(nightEnv, 0.2), 0.55, 1);
    if (!(luminance(nightGlass) > 0)) {
      failures.push(
        'After dark an unlit pane still reflects exactly nothing. The environment is driven off the rig, ' +
          'which holds a night floor, so this is the one thing that should be impossible here.',
      );
    }
    if (luminance(nightGlass) > luminance(envRadiance(nightEnv, 0.2)) * 0.5) {
      failures.push(
        `An unlit pane at night is ${luminance(nightGlass).toFixed(4)} against a night sky at ` +
          `${luminance(envRadiance(nightEnv, 0.2)).toFixed(4)}. Past half of it the night skyline stops ` +
          "being a silhouette, which is spec 6.4's whole night.",
      );
    }
  }

  /* --- 6. The landmark sheet's copy of the Fresnel. See `SHEET_GLAZING`. */
  for (const row of SHEET_GLAZING) {
    const f = glazingFresnel(row.nDotV);
    if (Math.abs(f - row.fresnel) > 1e-5) {
      failures.push(
        `SHEET_GLAZING says the glazing coat is ${row.fresnel} at N.V ${row.nDotV} and it is ${f.toFixed(6)}. ` +
          '`scripts/render-landmark-sheet.mjs --pbr` asserts these same three numbers at startup and refuses ' +
          'to draw the turret if they have drifted; update both.',
      );
    }
  }

  /* --- 7. And the sheet's table is untouched by all of the above.
   *
   * `SHEET_ENV` is hard-coded a second time in `scripts/render-car-sheet.mjs`.
   * Nothing in this arm may move it -- the glazing coat changes two Fresnel
   * constants and adds a mask, and the *environment* is shared. Asserted here as
   * well as in `verifyReflection` because this is the check that runs when
   * somebody has been editing the glazing arm, and a shared constant moved by
   * accident is exactly what a second assertion is for. */
  for (const key of ['zenith', 'horizon', 'ground'] as const) {
    for (let i = 0; i < 3; i++) {
      if (Math.abs(env[key][i] - SHEET_ENV[key][i]) > 1e-5) {
        failures.push(
          `The glazing arm has moved SHEET_ENV.${key}: the rig now gives ` +
            `(${env[key].map((c) => c.toFixed(6)).join(', ')}) against the published ` +
            `(${SHEET_ENV[key].map((c) => c.toFixed(6)).join(', ')}). The offline car sheet hard-codes the ` +
            'published one and refuses to draw if they disagree. Nothing in the glazing arm is meant to ' +
            'touch the environment at all.',
        );
        break;
      }
    }
  }

  return failures;
}
