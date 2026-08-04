/**
 * Pipeline warm-up: compile every shader the session will ever need, once,
 * before the game is handed to the player.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FIXES, and why it presented as "buggy for the first couple of
 * minutes and then fine".
 *
 * WebGPU compiles a render pipeline the first time a given (shader, geometry
 * layout, blend/depth state, render-target format) combination is *drawn*.
 * Three's WebGPU backend does that lazily, inside `renderer.render`, on the
 * frame the object first enters the render list -- `Pipelines.getForRender`
 * calls `backend.createRenderPipeline(renderObject, null)`, and the `null` is
 * the whole story: with no promise array to push to, `WebGPUPipelineUtils` takes
 * the **synchronous** `device.createRenderPipeline` branch and the draw that
 * follows blocks until the compile lands.
 *
 * This world has about thirty-three distinct materials and each is drawn in
 * more than one configuration, so a first walk through the city trips a fresh
 * compile every few seconds for minutes: the first terrace, the first roof, the
 * first awning, the first fence, the first tree, the first parked car, the first
 * ibis, the first wheelie bin, the first street-name blade, the first cafe icon,
 * the first shot fired. Each is tens to hundreds of milliseconds on the main
 * thread. Then the cache is full and the game is smooth forever -- which is
 * exactly the report.
 *
 * ---------------------------------------------------------------------------
 * WHY `compileAsync` IS THE RIGHT TOOL AND NOT MERELY A TIDIER LOOP.
 *
 * `Renderer.compileAsync(scene, camera, targetScene)` walks the scene exactly as
 * `render` does -- same render list, same lights node, same clipping context,
 * same render-target formats, and since r181 the same frame-buffer-target
 * decision, all so the cache keys it produces are the ones `render` will later
 * look up -- but it substitutes `_createObjectPipeline` for the draw call and
 * passes a **promise array** down to the backend. That flips
 * `WebGPUPipelineUtils` onto `device.createRenderPipelineAsync`, which is the
 * genuinely off-thread path: the driver compiles on its own threads and the
 * promise resolves when the pipeline is ready. Three then awaits those promises
 * one render object at a time, yielding to the main thread between each
 * (`await yieldToMain()`), so the loading screen keeps painting.
 *
 * ---------------------------------------------------------------------------
 * THE SHADOW VARIANTS, which are half the pipelines and are *not* obvious.
 *
 * Two things in three's WebGPU path make a shadow-lit material more than one
 * pipeline, and both had to be read out of the source rather than assumed:
 *
 *  1. `RenderObject.getCacheKey` folds `object.receiveShadow` into the key, and
 *     `AnalyticLightNode` gates the whole shadow lookup on
 *     `builder.object.receiveShadow`. So every material is **two** colour
 *     pipelines -- receiving and not -- and this project switches a tile from
 *     one to the other as the player walks toward it (`applyShadowRole`), which
 *     is precisely a compile in the middle of a walk. Both are warmed here.
 *
 *  2. The depth pass is not reached by walking the scene with the view camera at
 *     all. `ShadowNode.updateBefore` runs a real, nested
 *     `renderer.render(scene, shadow.camera)` with `scene.overrideMaterial` set
 *     to one shared `NodeMaterial` per light (`getShadowMaterial`), and its
 *     render-object function draws only objects with `castShadow === true`. So
 *     the depth pipelines are keyed on that one material against each distinct
 *     *geometry layout* -- static, instanced and skinned are three different
 *     vertex paths and therefore three different pipelines.
 *
 *     The consequence for this file is the one design constraint it has: the
 *     warm-up meshes must be **in the scene the shadow pass renders**, because
 *     that nested render walks `frame.scene`. Hence `holder` is added to the
 *     real scene for the duration rather than compiled as a detached object with
 *     `compileAsync(object, camera, scene)`, which would have compiled the
 *     colour variants and silently skipped every depth one.
 *
 * Everything is `frustumCulled = false`, which `_projectObject` honours in both
 * walks, so nothing here depends on where the camera happens to be pointing at
 * boot or on where the sun has put its shadow volume.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO. It does not warm the *node graph* build, only the GPU
 * pipeline. Three re-derives a `NodeBuilderState` per `InstancedMesh` -- the
 * cache key carries `object.uuid` for those -- so a tile arriving with trees in
 * it still pays a few hundred microseconds of TSL generation. That is JS work on
 * an already-generated string that hashes to a `ProgrammableStage` this pass
 * created, so it never reaches `createShaderModule` and never reaches the
 * driver. It is not what a hitch is made of.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  type Camera,
  type Material,
  type Object3D,
  type Scene,
  type WebGPURenderer,
} from 'three/webgpu';

/**
 * One thing that will be drawn at some point in this session, reduced to the
 * four properties that decide which pipelines it needs.
 *
 * The geometry and material are the **shared instances** the game itself will
 * use, not copies: a copy would have a different cache key and would warm a
 * pipeline nothing ever draws. This module never disposes either.
 */
export interface WarmupPart {
  /**
   * A geometry with the same attribute *layout* as the real thing -- names and
   * item sizes, which is all `RenderObject.getGeometryCacheKey` reads. Where the
   * real geometry is shared world-wide (trees, cars, bins, birds, icons) it is
   * simply passed straight through.
   */
  geometry: BufferGeometry;
  material: Material;
  /**
   * Whether this geometry was made for the warm-up and should be released with
   * it. False -- the default -- means it is the shared instance the game draws
   * with, and disposing it here would delete the trees out of the world.
   */
  owned?: boolean;
  /** Instanced draws take a different vertex path, and so a different pipeline. */
  instanced?: boolean;
  /**
   * Whether the real instanced mesh carries per-instance colour. It changes the
   * shader -- `NodeMaterial.setupDiffuseColor` multiplies by `instanceColor`
   * only when the attribute exists -- so warming the wrong one warms a pipeline
   * nothing draws and leaves the real hitch in place. Defaults to true for
   * instanced parts, which is every one in this build except the street-name
   * blades; `furniture.ts` says why they have none.
   */
  instanceColor?: boolean;
  /** Whether the real thing ever appears in the sun's depth pass. */
  casts?: boolean;
  /**
   * Which receive-shadow variants the real thing is ever drawn with. Both by
   * default, because that is the streamer's own lifecycle: a tile loads not
   * receiving and is switched on when it comes inside the shadow volume.
   */
  receives?: readonly boolean[];
}

/** What the pass cost and what it produced. Logged once; read by nothing. */
export interface WarmupReport {
  /** Warm-up draws submitted -- parts multiplied by their shadow variants. */
  draws: number;
  /** Shader modules the renderer holds. The count that says a compile happened. */
  programsBefore: number;
  programsAfter: number;
  /** Render pipelines cached, if this build of three exposes the cache. */
  pipelinesBefore: number;
  pipelinesAfter: number;
  /** Wall time for the whole pass, milliseconds. */
  ms: number;
}

const BOTH_WAYS: readonly boolean[] = [false, true];

/**
 * A one-triangle stand-in with a given attribute layout.
 *
 * A triangle rather than a quad, and 1 m rather than 1 mm, for the same reason:
 * this is rasterised exactly once, by the nested shadow render inside
 * `compileAsync`, and a degenerate triangle is a shape a driver is entitled to
 * discard early. Something with area is one less thing to wonder about.
 */
export function warmupGeometry(attributes: {
  normal?: boolean;
  uv?: boolean;
  /** Vertex colour, as the float3 the client's own builders emit. */
  color3?: boolean;
  /** Vertex colour, as the normalised unsigned bytes the contact skirt carries. */
  colorU8x4?: boolean;
  /** The facade parameter index, under both names -- see `buildingIndexed`. */
  buildingIndexed?: boolean;
  /** Metres of water over the bed, which is the only attribute a sheet carries
   * besides position and normal. See `world/water.ts`. */
  waterDepth?: boolean;
}): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  if (attributes.normal) {
    geometry.setAttribute(
      'normal',
      new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3),
    );
  }
  if (attributes.uv) {
    geometry.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
  }
  if (attributes.color3) {
    geometry.setAttribute(
      'color',
      new BufferAttribute(new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]), 3),
    );
  }
  if (attributes.colorU8x4) {
    // Normalised unsigned bytes, exactly as `tiles.py` writes COLOR_0 on the
    // contact skirt. `normalized` is in the geometry cache key, so a float
    // stand-in here would warm a pipeline the skirt never uses.
    geometry.setAttribute(
      'color',
      new BufferAttribute(new Uint8Array([255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255]), 4, true),
    );
  }
  if (attributes.buildingIndexed) {
    // **Both names, and that is not belt-and-braces.** GLTFLoader lowercases
    // custom attributes, so the pipeline's `_BLDIDX` arrives as `_bldidx`, and
    // `normaliseBuildingIndexAttribute` aliases it back *without removing the
    // original* -- so a real facade primitive reaches the renderer carrying two
    // entries for one buffer. `getGeometryCacheKey` walks `Object.keys`, so a
    // stand-in with only one of them keys differently and warms the wrong
    // pipeline. Same attribute object under both names, which is also exactly
    // what the loader path produces.
    const bldidx = new BufferAttribute(new Float32Array([0, 0, 0]), 1);
    geometry.setAttribute('_bldidx', bldidx);
    geometry.setAttribute('_BLDIDX', bldidx);
  }
  if (attributes.waterDepth) {
    geometry.setAttribute('waterDepth', new BufferAttribute(new Float32Array([0, 1, 2]), 1));
  }
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  return geometry;
}

/**
 * Compile every pipeline the given parts will ever need.
 *
 * `extras` are objects that cannot be reduced to a (geometry, material) pair and
 * are handed over whole -- the character, whose skeleton is in its cache key and
 * cannot be faked. Their shadow flags are the caller's to set, because on a
 * ready-made object those flags are a fact rather than a choice; everything else
 * about them is handled here, and they are never disposed, because the caller
 * still owns them.
 *
 * Never throws. A warm-up that fails is a game that hitches on its first walk,
 * which is what the player already had; a warm-up that *stops the boot* is a
 * game nobody can play at all.
 */
export async function warmUpPipelines(
  renderer: WebGPURenderer,
  scene: Scene,
  camera: Camera,
  parts: readonly WarmupPart[],
  extras: readonly Object3D[] = [],
): Promise<WarmupReport> {
  const started = performance.now();
  const programsBefore = renderer.info.memory.programs;
  const pipelinesBefore = pipelineCount(renderer);

  const holder = new Group();
  holder.name = 'pipeline-warmup';

  const identity = new Matrix4();
  // A multiplier of one, so the warm-up draws what the real thing draws.
  const white = new Color(1, 1, 1);
  const owned: BufferGeometry[] = [];
  let draws = 0;

  for (const part of parts) {
    if (part.owned) owned.push(part.geometry);
    for (const receive of part.receives ?? BOTH_WAYS) {
      let mesh: Mesh;
      if (part.instanced) {
        const instanced = new InstancedMesh(part.geometry, part.material, 1);
        instanced.setMatrixAt(0, identity);
        // See `WarmupPart.instanceColor`: the attribute's presence is in the
        // shader, so it has to match what the tile builders produce.
        if (part.instanceColor !== false) instanced.setColorAt(0, white);
        mesh = instanced;
      } else {
        mesh = new Mesh(part.geometry, part.material);
      }
      // Never culled, in either walk. `_projectObject` short-circuits the
      // frustum test on this flag, and it is tested by both the colour walk
      // (with the view camera) and the nested shadow render (with the sun's
      // orthographic camera), so one flag covers the case where the sun is
      // behind the player and the case where the camera has not been pointed
      // anywhere yet.
      mesh.frustumCulled = false;
      mesh.castShadow = part.casts ?? true;
      mesh.receiveShadow = receive;
      holder.add(mesh);
      draws++;
    }
  }

  // Culling off for the duration and put back afterwards. It is only ever
  // handed throwaways today, but "the warm-up permanently turned culling off on
  // an object I still use" is the kind of side effect that is invisible until it
  // is a frame budget.
  const extraCulling = extras.map((extra) => extra.frustumCulled);
  for (const extra of extras) {
    extra.frustumCulled = false;
    holder.add(extra);
    draws++;
  }

  scene.add(holder);
  try {
    // The whole scene, not `holder` alone. `compileAsync(holder, camera, scene)`
    // would compile the colour pipelines and silently skip every depth one --
    // the nested shadow render walks `frame.scene`, which is the scene the
    // render objects were keyed against, and `holder` would not be in it. See
    // this file's header.
    await renderer.compileAsync(scene, camera);
  } catch (err) {
    console.warn('[warmup] pipeline warm-up did not finish; first-walk hitches remain.', err);
  } finally {
    scene.remove(holder);
    for (let i = 0; i < extras.length; i++) {
      holder.remove(extras[i]);
      extras[i].frustumCulled = extraCulling[i];
    }
    // Only the geometries this module made. Every other geometry and every
    // material here is the shared instance the game is about to draw with, and
    // disposing one would blank the thing it belongs to -- or, worse, throw away
    // the pipeline this pass just paid for.
    for (const geometry of owned) geometry.dispose();
  }

  return {
    draws,
    programsBefore,
    programsAfter: renderer.info.memory.programs,
    pipelinesBefore,
    pipelinesAfter: pipelineCount(renderer),
    ms: performance.now() - started,
  };
}

/**
 * How many render pipelines the renderer is holding, or -1 if this build does
 * not expose the cache.
 *
 * `renderer.info` counts shader modules (`memory.programs`) but not pipelines,
 * and the two differ by exactly the thing this pass is about: two objects with
 * the same generated WGSL and different depth state share a `ProgrammableStage`
 * and need two pipelines. Reached through a cast rather than a public API
 * because there is not one, and guarded because a private field is not a
 * contract -- a wrong number here must never be able to fail a boot.
 */
function pipelineCount(renderer: WebGPURenderer): number {
  const caches = (renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })
    ._pipelines?.caches;
  return caches instanceof Map ? caches.size : -1;
}
