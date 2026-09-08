/**
 * The clearcoat, as a material you can construct instead of the one you were
 * constructing.
 *
 * `sky/reflection.ts` is the file with the argument in it -- why a car has no
 * ambient specular in this renderer, why the environment is a three-point
 * gradient rather than a PMREM, why the composite is a convex combination and
 * what that buys over a calibrated palette. This file is the shader, and it is
 * separate for the same reason `sky/gradenode.ts` is: **the server runs
 * `verifyReflection` and may not import three.**
 *
 * ---------------------------------------------------------------------------
 * ## THE HOOK
 *
 * `NodeMaterial.setupOutput( builder, outputNode )` is three's documented
 * extension point for exactly this -- its own JSDoc example is a subclass that
 * takes the lit `vec4` and mixes something into it. It runs after the lighting
 * and before the fog, which is the correct place for a coat: a reflection is
 * light leaving the surface, so it belongs on the near side of the atmosphere
 * between the surface and the eye.
 *
 * The two hooks that look plausible and are not:
 *
 *   - **`material.envNode`.** This is the real IBL path and it is the right
 *     answer if you have a texture. `EnvironmentNode` calls the node inside a
 *     context that supplies `getUV` and `roughness` and expects something
 *     texture-shaped back; feeding it an analytic gradient means implementing
 *     that contract, and the contract is `@private`. It also brings the full
 *     split-sum machinery -- a DFG lookup, an irradiance term on the diffuse --
 *     which would move every calibrated albedo on the car at once.
 *   - **`material.outputNode`.** Replaces the lit result entirely rather than
 *     wrapping it; there is no node for "what the lighting produced".
 *
 * ## WHAT IT COSTS
 *
 * Per pixel of car: a normalize, a dot, a reflect, a `pow`, two `smoothstep`s
 * and three `mix`es -- call it twenty ALU on a fragment that is already doing a
 * full standard BRDF with a shadow gather in it. No texture fetch, no extra
 * varying, no extra bind group.
 *
 * Per frame: three uniform writes, shared by every car in the world.
 *
 * Per pipeline: **none.** This is the part that mattered when choosing the
 * design. `RenderObject.getCacheKey` folds in the material, so a subclass is one
 * pipeline per material as before -- the box fleet's single `car_paint` and the
 * one material per car model that `carlod.ts` already builds. Nothing new is
 * compiled, nothing is compiled twice, and `PipelineWatch` should stay at zero
 * frames. A per-instance or per-tile variant would have been a pipeline per
 * tile, which is the failure `streamer.ts` names as its killer.
 *
 * ---------------------------------------------------------------------------
 * ## THE ONE HONEST WART
 *
 * A car is one mesh and one material -- the glass, the tyres and the sill band
 * are *vertex colours*, because `instanceColor` multiplies the object and a
 * second material slot would double the draw calls (`cars.ts` sets this out at
 * length). So the coat goes on all of it: the tyres get a rim of sky they should
 * not have, and the glass gets the same coat as the paint when it should have
 * about twice as much.
 *
 * Both errors are small and they point in opposite directions from correct, and
 * neither is worth a second draw call for the fleet. The glass one is the one
 * that is actually *wrong*: a windscreen is the most reflective thing on a car
 * and it gets a paint's worth. Fixing it needs the `_PAINT` mask that the prep
 * already writes to be read here as a coat strength, which is a change to the
 * geometry path rather than to this file, and it is written up in `GRAPHICS.md`.
 *
 * ---------------------------------------------------------------------------
 * ## AND THEN THE BUILDINGS. `GRAPHICS.md` item 2.
 *
 * The same twelve lines, over glass. `sky/reflection.ts`' glazing section holds
 * the argument -- what the facade already had, which of the audit's three
 * complaints were true, and why two coats in series over-reflect head-on by four
 * points of a dim sky and nothing at grazing. What this file adds is one word in
 * the class below: `coatStrength` was a number and is now **a number or a node**.
 *
 * That single generalisation is what lets one class serve a car, a curtain wall,
 * a window rectangle inside a brick terrace and the Sydney Tower's observation
 * band, and it is what keeps the pipeline count at zero: a facade slot already
 * has exactly one material, the coat is folded into its graph, and
 * `RenderObject.getCacheKey` sees the same one material it saw yesterday. A
 * *second* material for glazed pixels would have been a second pipeline per slot
 * per tile, which is `streamer.ts`' named killer.
 *
 * The mask itself is built in `world/facade.ts`, not here, and it has to be:
 * `glassArea` is `inWindow * (1 - frameMask)` minus whatever an aircon box is
 * covering, and every one of those is a hundred lines of window grammar that
 * only that file knows. This file takes the node and asks no questions.
 *
 * ---------------------------------------------------------------------------
 * ## AND THE FAR CITY. `GRAPHICS.md` item 4.
 *
 * At the bottom of this file, and it is here rather than in `world/far.ts` for
 * one reason: it wants `E.horizon`, and there is one sky. A second copy of the
 * environment written from the same `solarRig` on the same frame would be the
 * same numbers in a second buffer, until the day somebody edited one of them.
 *
 * Same hook, third material class, one new scalar uniform. See the block above
 * `AerialBasicNodeMaterial`.
 */

import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  Vector3,
  type Node,
  type NodeBuilder,
} from 'three/webgpu';
import {
  Fn,
  cameraPosition,
  exp,
  float,
  max,
  mix,
  normalWorld,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';

import { CAR_SKY_REFLECT, FAR_AERIAL, GLAZING_SKY_REFLECT } from '../sky/calibration.ts';
import {
  AERIAL_FAR,
  AERIAL_MAX,
  AERIAL_NEAR,
  AERIAL_SCALE_HEIGHT,
  COAT_F0,
  COAT_MAX,
  COAT_POWER,
  GLAZING_F0,
  GLAZING_MAX,
  GLAZING_POWER,
  HORIZON_HIGH,
  HORIZON_LOW,
  aerialDayFraction,
  skyEnvAt,
} from '../sky/reflection.ts';

/**
 * The environment, as three uniforms.
 *
 * Module-level for the same reason the grade's are: there is one sky. A
 * per-material copy would be one sky per material, which is a way of saying
 * "several skies".
 *
 * Initialised to the reference instant rather than to black, so that a material
 * compiled and drawn before the first `updateSkyReflect` reflects an afternoon
 * rather than a void. Nothing in the boot order makes that possible today; it is
 * one line of insurance against the day something does.
 */
const E = /*#__PURE__*/ (() => {
  const env = skyEnvAt(57.11);
  return {
    zenith: uniform(new Vector3(...env.zenith)),
    horizon: uniform(new Vector3(...env.horizon)),
    ground: uniform(new Vector3(...env.ground)),
  };
})();

/**
 * Copy the environment for a solar altitude into the uniforms.
 *
 * Called from `main.ts`'s `FSEC.sky` block beside `updateGrade`. Costs one
 * `solarRig` -- which that block is already calling for the lights, and which is
 * cheap enough (`sky.ts` measures its whole `applySolar` at 5.4 microseconds)
 * that a second call is not worth the plumbing to avoid.
 *
 * **This is the whole of the "refresh cadence" the design asks about**: every
 * frame, exactly, for three buffer writes. See `sky/reflection.ts` on why there
 * is no texture to refresh.
 */
export function updateSkyReflect(altitudeDeg: number): void {
  const env = skyEnvAt(altitudeDeg);
  E.zenith.value.set(env.zenith[0], env.zenith[1], env.zenith[2]);
  E.horizon.value.set(env.horizon[0], env.horizon[1], env.horizon[2]);
  E.ground.value.set(env.ground[0], env.ground[1], env.ground[2]);
}

/**
 * The environment along a direction. Branchless, and identical by construction
 * to `reflection.envRadiance`.
 *
 * Two clamped smoothsteps composed rather than a branch at the horizon: below
 * the horizon the second is pinned at 0 and above it the first is pinned at 1,
 * so the same three lines produce the ground ramp, the horizon band and the
 * zenith ramp with no `select` and no discontinuity. Only `y` is read -- see
 * `reflection.ts` on why the dome has no azimuth in it, which is that the sun's
 * lobe already arrives from the `DirectionalLight` and a second copy would
 * double every highlight in the game.
 */
const envAlong = /*#__PURE__*/ Fn(([dirY]: [any]) => {
  const low = mix(E.ground, E.horizon, smoothstep(HORIZON_LOW, 0, dirY));
  return mix(low, E.zenith, smoothstep(0, HORIZON_HIGH, dirY));
});

/**
 * A `MeshStandardNodeMaterial` with a clearcoat that reflects the sky.
 *
 * Everything else about it is a standard material: `roughness`, `metalness`,
 * `vertexColors`, `colorNode` and the rest behave exactly as they did, so a
 * caller swaps the constructor and changes nothing else. That is deliberate --
 * `cars.ts` and `carlod.ts` both build their materials through a lot of
 * carefully-argued lines and neither should have to know this exists beyond the
 * word `new`.
 */
export class ClearcoatNodeMaterial extends MeshStandardNodeMaterial {
  /**
   * How much of the coat this surface gets, 0 to 1 -- **a number or a node**.
   *
   * A number is folded into the shader as a constant, because for a car it is a
   * property of the *material* and never changes: a value per material is a
   * constant per pipeline, and there is no frame on which a tyre becomes a
   * windscreen.
   *
   * A node is the same thing said per pixel, and it is how a facade gets glazed:
   * `world/facade.ts` hands over its window mask, so the coat runs at full
   * strength inside a window rectangle and at **exactly zero** on the brick
   * around it. Zero matters more than one does here -- `sky/reflection.ts`'
   * `verifyGlazing` asserts by identity rather than by tolerance that a
   * zero-strength coat returns its input bit-for-bit, because every masonry,
   * render and fibro value published in `MATERIAL_LOOK` is relying on it.
   */
  coatStrength: number | Node = 1;

  /**
   * The Fresnel this coat runs, as `[F0, grazing cap, exponent]`.
   *
   * Defaults to the car's -- `COAT_F0` under a real clearcoat's 0.04 because the
   * paint beneath is lifted, `COAT_MAX` at a half because a faceted low-poly
   * body over-reports grazing area. Glass wants neither of those apologies and
   * `createGlazingMaterial` sets both to the glazing pair instead.
   *
   * Per material rather than per pixel, and it has to be: this is what decides
   * whether the surface is paint or glass, and no pixel is both.
   */
  coatF0 = COAT_F0;
  coatMax = COAT_MAX;
  coatPower = COAT_POWER;

  setupOutput(builder: NodeBuilder, outputNode: Node): Node {
    if (typeof this.coatStrength === 'number' && this.coatStrength <= 0) {
      return super.setupOutput(builder, outputNode);
    }

    // `outputNode` is declared as a bare `Node` in three's typings even though
    // the contract says it is a `vec4`, so the swizzles below have nothing to
    // narrow against. Same cast, same reason, as `sky/gradenode.ts`.
    const lit = outputNode as any;

    // The eye ray, world space, pointing *at* the surface. `positionWorld` and
    // `cameraPosition` rather than the view-space `positionViewDirection`,
    // because the environment is indexed by world y and converting a view vector
    // back would be a matrix multiply to undo a matrix multiply.
    const view = positionWorld.sub(cameraPosition).normalize().toVar();
    const normal = normalWorld.toVar();
    // Saturated rather than absolute, matching `reflection.coatFresnel`'s clamp:
    // a faceted two-sided car does report a back-facing dot, and the two copies
    // of this arithmetic have to agree about what happens then.
    const nDotV = normal.dot(view.negate()).saturate();
    const reflected = view.sub(normal.mul(view.dot(normal).mul(2)));
    // `saturate` on the strength rather than trust: a mask is a `smoothstep`
    // product in the caller's graph, and the CPU copy in `reflection.ts` clamps
    // it, so the two have to agree about what happens outside [0, 1].
    const strength =
      typeof this.coatStrength === 'number'
        ? float(this.coatStrength)
        : (this.coatStrength as any).saturate();
    const fresnel = float(this.coatF0)
      .add(float(this.coatMax - this.coatF0).mul(nDotV.oneMinus().pow(this.coatPower)))
      .mul(strength);
    const coated = mix(lit.rgb, vec3(envAlong(reflected.y) as any), fresnel as any);
    return super.setupOutput(builder, vec4(coated, lit.a));
  }
}

/**
 * The material a car should be built with: coated if the switch is on, plain if
 * it is not.
 *
 * A factory rather than a conditional at each call site, so that
 * `CAR_SKY_REFLECT` is read in exactly one place and turning it off produces
 * literally the material that shipped before this pass -- same class, same
 * pipeline, no dead `coatStrength` sitting at zero inside a subclass.
 */
export function createCarMaterial(): MeshStandardNodeMaterial {
  return CAR_SKY_REFLECT ? new ClearcoatNodeMaterial() : new MeshStandardNodeMaterial();
}

/**
 * The material a glazed surface should be built with. `GRAPHICS.md` item 2.
 *
 * Same factory rule as the car's and the same reason -- `GLAZING_SKY_REFLECT` is
 * read in exactly one place, and off returns literally the class that shipped,
 * so no dead `coatStrength` sits inside a subclass pretending to be nothing.
 *
 * The caller owns the mask and hands it over afterwards:
 *
 *     const m = createGlazingMaterial();
 *     ...
 *     if (m instanceof ClearcoatNodeMaterial) m.coatStrength = glassMask;
 *
 * rather than taking it as an argument, because the two callers get their mask
 * at opposite ends of their own construction. `world/facade.ts` cannot know
 * where a window is until it has built five hundred lines of window grammar, and
 * `world/landmarks.ts` knows the answer before it starts (the whole slot is
 * glass) and leaves the default 1 alone. An argument would have forced the first
 * of those to restructure around this file, which is backwards.
 *
 * **The default when the switch is off is a plain `MeshStandardNodeMaterial`,
 * which has no `coatStrength` at all** -- hence the `instanceof` at the call
 * site rather than an unconditional assignment. That is deliberate: a property
 * quietly landing on a base material is how a switch stops meaning anything.
 */
export function createGlazingMaterial(): MeshStandardNodeMaterial {
  if (!GLAZING_SKY_REFLECT) return new MeshStandardNodeMaterial();
  const material = new ClearcoatNodeMaterial();
  material.coatF0 = GLAZING_F0;
  material.coatMax = GLAZING_MAX;
  material.coatPower = GLAZING_POWER;
  return material;
}

/* ---------------------------------------------------------------------------
 * THE HAZE. `GRAPHICS.md` item 4.
 *
 * The far city, mixed toward the same horizon band the coats above reflect. The
 * argument is in `sky/reflection.ts`' aerial section and the short version is a
 * type: `scene.fog.color` is a `THREE.Color`, a `Color` is three channels in
 * [0, 1], and the low sky at 3 pm is 2.49 of luminance. So the fog fades the far
 * suburbs toward a value two and a half times *darker* than the sky behind them
 * and distance has been subtracting light instead of adding it.
 *
 * `main.ts` wrote that limitation down when it set the fog up -- *"a `Fog`
 * colour is capped at 1.0 linear so it cannot reach the horizon band's
 * brightness; this gets as close as the cap allows"* -- and this is the term
 * that is not capped.
 *
 * **Nothing new is uploaded for it.** `E.horizon` is already on the GPU for the
 * coats; the only addition is one scalar, and it is a scalar rather than a
 * second colour because the *shape* of the day is `far.ts`' own `SLAB_LIGHT`
 * curve and there must not be two of those.
 * ------------------------------------------------------------------------- */

/**
 * The daylight fraction, 0 at the far city's night floor and 1 at noon.
 *
 * See `reflection.aerialDayFraction` for why this is inverted out of
 * `SLAB_LIGHT` rather than being `SLAB_LIGHT` itself: the number this term needs
 * has to be **zero** at night, not 0.14, or a silhouette skyline carries a
 * fourteen per cent wash of a lighting floor. `verifyAerial` asserts the
 * resulting slab value by identity.
 */
const AERIAL = /*#__PURE__*/ uniform(0);

/**
 * Written once a frame from `world/far.setSlabDaylight`, which is already being
 * called from the sky's own phase. One buffer write, shared by all 192 slab
 * meshes because they share one material.
 */
export function setAerialDaylight(slabLight: number, nightFloor: number): void {
  AERIAL.value = aerialDayFraction(slabLight, nightFloor);
}

/**
 * A `MeshBasicNodeMaterial` that fades toward the sky with distance.
 *
 * `setupOutput` again, and for a third reason on top of the two the coat gives:
 * the far city's colour arrives as `colorNode` **times a per-vertex tint**
 * (`vertexColors`, one `FAR_TINT` row per material slot), so the haze cannot go
 * in `colorNode` -- it would be multiplied by the tint afterwards and every
 * slab would be hazed toward its own colour. It has to land after the multiply
 * and before the fog, which is exactly what this hook is.
 *
 * The cost, counted honestly rather than estimated: a subtract and a length for
 * the distance, a `smoothstep`, a `max` and an `exp` for the height, two
 * multiplies for the scalars and a three-channel `mix`. Call it eighteen ALU,
 * not the six `GRAPHICS.md` guessed -- the guess did not price the height term,
 * which is the half of aerial perspective that makes a tower top stand out of
 * the haze instead of the whole skyline fading as one card. Still nothing
 * against 187,981 unlit triangles that do no lighting at all.
 *
 * Zero new pipelines: one material for the whole far city before this, one
 * after.
 */
export class AerialBasicNodeMaterial extends MeshBasicNodeMaterial {
  setupOutput(builder: NodeBuilder, outputNode: Node): Node {
    const lit = outputNode as any;
    // World-space distance rather than view z. A range fog uses view z and it
    // is wrong at the edges of a 90-degree field: a slab at the corner of the
    // screen is further away than one straight ahead at the same z, and at four
    // kilometres that is hundreds of metres of air the fog is not counting.
    const distance = positionWorld.sub(cameraPosition).length();
    // `positionWorld.y` is an AHD elevation, because these prisms are built in
    // world space -- so this reads the *terrain* as well as the building, which
    // is correct and is the one thing about it worth saying twice: a suburb on a
    // ridge at 100 m genuinely has less air in front of it than one at sea
    // level, and both are in this number already.
    const height = max(positionWorld.y, float(0));
    const weight = smoothstep(float(AERIAL_NEAR), float(AERIAL_FAR), distance)
      .mul(exp(height.mul(float(-1 / AERIAL_SCALE_HEIGHT))))
      .mul(AERIAL)
      .mul(float(AERIAL_MAX));
    return super.setupOutput(builder, vec4(mix(lit.rgb, E.horizon, weight as any), lit.a));
  }
}

/**
 * The material the far city should be built with: hazed if the switch is on,
 * plain if it is not. Same factory rule, same reason, as the two above.
 */
export function createFarCityMaterial(): MeshBasicNodeMaterial {
  return FAR_AERIAL ? new AerialBasicNodeMaterial() : new MeshBasicNodeMaterial();
}
