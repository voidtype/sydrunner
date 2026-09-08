/**
 * The grade, as twelve lines of shader and one call to three's tone-mapping
 * registry.
 *
 * `sky/grade.ts` is the file with the argument in it -- what the tints are, why
 * they are normalised, what the invariant buys and what the checks assert. This
 * file is the plumbing, and it is separate for the reason every plumbing file in
 * this codebase is separate: **the server runs `verifyGrade` and may not import
 * three**. Split the pure half out and the check runs in both boot lists; leave
 * them together and it runs in neither, because `server/index.ts` would not
 * load.
 *
 * ---------------------------------------------------------------------------
 * ## THE HOOK, AND WHY IT IS THIS ONE
 *
 * Three's WebGPU renderer does not hard-code its tone curves. `ToneMappingNode`
 * looks the function up at build time:
 *
 *     const toneMappingFn = builder.renderer.library.getToneMappingFunction( toneMapping );
 *     outputNode = vec4( toneMappingFn( colorNode.rgb, this.exposureNode ), colorNode.a );
 *
 * and `NodeLibrary.addToneMapping( fn, constant )` is how the six built-ins get
 * in there in the first place -- `StandardNodeLibrary`'s constructor is six
 * calls to it. `CustomToneMapping` (5) is the one constant three defines and
 * does **not** register, which is to say it is the slot reserved for exactly
 * this. So the graded curve is a first-class tone mapping rather than a hack
 * around one, it goes through the same cache key, and every material in the
 * scene picks it up with no material-side change at all.
 *
 * The alternative was a `PostProcessing` chain, and it is worth writing down
 * what that would have cost, because it is the obvious build and it is wrong
 * here:
 *
 *   - a full-screen pass at the render scale, every frame, on a client that
 *     already spends 6-9 ms rendering on the machines that struggle;
 *   - a render target the size of the canvas, plus its depth, in a build with no
 *     stated VRAM headroom;
 *   - and the antialiasing problem. The canvas is created with
 *     `antialias: true`, so the swap chain is multisampled and resolved by the
 *     browser. Routing through a target means resolving it manually, or losing
 *     MSAA, or paying for both.
 *
 * Against six ALU inside a function that was already being called once per
 * pixel. There was no version of this worth a pass.
 *
 * ---------------------------------------------------------------------------
 * ## AND WHY THE PARAMETERS ARE UNIFORMS
 *
 * The grade changes all day. If the tints were constants folded into the shader,
 * every sunset would recompile every pipeline in the scene -- which is precisely
 * the failure `world/warmup.ts` exists to prevent and `world/nightlights.ts`
 * caps its light count to avoid. Three uniforms, written once a frame from
 * `sky.solar.altitude`, cost one buffer write and recompile nothing, ever.
 *
 * `updateGrade` is called from `main.ts`'s `FSEC.sky` block, one line under the
 * two `FacadeGlobals` writes, for the same reason those are there: it is a
 * function of the sun and the sun is read there.
 */

import { Vector3, type WebGPURenderer } from 'three/webgpu';
import { CustomToneMapping } from 'three';
import { Fn, dot, mix, smoothstep, uniform, vec3 } from 'three/tsl';
import { neutralToneMapping } from 'three/tsl';

import { GRADE_ENABLED } from './calibration.ts';
import { SPLIT_HIGH, SPLIT_LOW, gradeAt } from './grade.ts';

/**
 * The three uniforms the grade is.
 *
 * Module-level rather than handed around, and this is the one place in the
 * graphics pass where that is the *right* shape rather than a convenience:
 * there is one frame, one output stage and one tone mapping function in the
 * whole renderer, so a second instance of these would be a second grade with
 * nowhere to be applied. Compare `createFacadeGlobals`, which is per-streamer
 * because facades are per-tile.
 *
 * Initialised to the identity -- white tints, unit saturation -- so that a
 * client which somehow renders a frame before `updateGrade` runs gets the
 * ungraded image rather than a black one.
 */
const G = {
  shadow: uniform(new Vector3(1, 1, 1)),
  highlight: uniform(new Vector3(1, 1, 1)),
  saturation: uniform(1),
};

/** Rec. 709, and it must stay identical to `calibration.luminance`. */
const LUMA = /*#__PURE__*/ vec3(0.2126, 0.7152, 0.0722);

/**
 * Khronos PBR Neutral, then the grade.
 *
 * The same six lines as `grade.applyGrade`, and the comment there explains why
 * they exist twice. Read them together or not at all.
 *
 * `[any, any]` on the parameters and one cast on the call, matching
 * `world/facade.ts`'s convention throughout: TSL's published types describe a
 * node's *element type* as a string generic, and three's own
 * `ToneMappingFunctions.d.ts` declares `neutralToneMapping` as returning a bare
 * `Node` with no element type at all. There is nothing to narrow it to.
 */
const gradedNeutralToneMapping = /*#__PURE__*/ Fn(([color, exposure]: [any, any]) => {
  const mapped = vec3(neutralToneMapping(color, exposure) as any).toVar();
  const w = smoothstep(SPLIT_LOW, SPLIT_HIGH, dot(mapped, LUMA));
  const tinted = mapped.mul(mix(G.shadow, G.highlight, w)).toVar();
  return mix(vec3(dot(tinted, LUMA)), tinted, G.saturation);
});

/**
 * What `renderer.library` looks like from here.
 *
 * `NodeLibrary` is marked `@private` in three's own JSDoc and its `.d.ts` is
 * consequently an empty class, so the method that the entire WebGPU tone mapping
 * system is built on has no public type. Cast rather than `any`, and narrowed to
 * the one method, so that a three upgrade which renames it is a `null` check
 * here rather than a silent no-op.
 */
type ToneMappingRegistry = {
  addToneMapping?: (fn: unknown, toneMapping: number) => void;
};

/**
 * Register the graded curve and select it. Returns whether it took.
 *
 * Call it **before** `renderer.init()` -- `library` is built in the
 * `WebGPURenderer` constructor, so it is available immediately, and doing it
 * early means the warm-up in `world/warmup.ts` compiles the pipelines the game
 * will actually use rather than compiling them twice.
 *
 * Never throws. A renderer whose library has moved gets the ungraded Neutral
 * curve `main.ts` already set, which is the image that shipped before this pass;
 * the caller logs it. Losing a look is not a reason to lose a boot.
 */
export function installGrade(renderer: WebGPURenderer): boolean {
  if (!GRADE_ENABLED) return false;
  const library = (renderer as unknown as { library?: ToneMappingRegistry }).library;
  if (!library || typeof library.addToneMapping !== 'function') return false;
  library.addToneMapping(gradedNeutralToneMapping, CustomToneMapping);
  renderer.toneMapping = CustomToneMapping;
  return true;
}

/**
 * Copy the grade for a solar altitude into the uniforms. One frame's worth.
 *
 * Costs three buffer writes and one `gradeAt`, which is two `Math.pow`s and some
 * arithmetic. Called unconditionally rather than gated on the switch: if the
 * grade was never installed these uniforms are read by nothing, and a branch
 * here would be a second place for the switch to be wrong.
 */
export function updateGrade(altitudeDeg: number): void {
  const g = gradeAt(altitudeDeg);
  G.shadow.value.set(g.shadow[0], g.shadow[1], g.shadow[2]);
  G.highlight.value.set(g.highlight[0], g.highlight[1], g.highlight[2]);
  G.saturation.value = g.saturation;
}
