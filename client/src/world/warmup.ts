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
 * WHAT A STAND-IN CANNOT DO, WHICH IS EVERY INSTANCED DRAW IN THE GAME.
 *
 * This pass works because a pipeline is keyed on things a stand-in can copy: the
 * material, the attribute layout, the shadow role. An `InstancedMesh` is the one
 * case where that is false, and it was warmed here for the life of this module
 * without ever compiling anything the game used.
 *
 * `RenderObject.getMaterialCacheKey` appends `object.uuid` for anything
 * instanced -- unconditionally, with a TODO pointing at three.js#29066 -- because
 * the instance matrix is baked into the node graph as a uniform buffer over that
 * mesh's own array. So every instanced mesh gets its own `NodeBuilderState`, its
 * own generated WGSL and its own render pipeline; the shaders are not even
 * textually equal, since the matrix arrives as a struct named
 * `NodeBuffer_<node id>` off a global counter. A stand-in has a different uuid,
 * therefore a different pipeline, therefore warms nothing.
 *
 * Two things cover instanced draws instead, and neither is a stand-in:
 *
 *   - **`TileStreamer.setPrecompiler`** compiles each tile's real meshes with
 *     `compileAsync` when the tile is built, and holds the tile out of the
 *     picture until that lands. A tile has about thirteen instanced sets and the
 *     streamer flips `group.visible` from a frustum test, so before this the
 *     compiles landed on the frame the player's own turn brought the tile into
 *     view -- one 360-degree turn with 56 tiles resident compiled 589 pipelines
 *     and put a 1,492 ms frame in the middle of it.
 *   - **the scene pass in `main.ts`**, which runs `compileAsync` over the real
 *     scene once every renderer has been constructed. That is what reaches the
 *     world-wide instanced sets -- the traffic, the crowd, the flock, the bikes,
 *     the gulls, the headlights -- which are single objects and so can only be
 *     warmed as themselves.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO. It does not warm the *node graph* build, only the GPU
 * pipeline. A merged tile mesh arriving with a facade material on it still pays
 * a few hundred microseconds of TSL generation, on an already-generated string
 * that hashes to a `ProgrammableStage` this pass created -- so it never reaches
 * `createShaderModule` and never reaches the driver. It is not what a hitch is
 * made of.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
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
  /**
   * Draws the dedupe removed: a (material, attribute layout, shadow role) that
   * some earlier part had already submitted. See `partSignature`.
   */
  duplicates: number;
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
 * The stand-in meshes for a parts list, in a group, deduped -- and nothing else.
 *
 * ---------------------------------------------------------------------------
 * Split out of `warmUpPipelines` for the one caller that cannot use it:
 * everything built *after* the boot pass has run. `main.ts`'s hands viewmodel,
 * the phone and the cash piles are all constructed thousands of lines below it,
 * and a second `warmUpPipelines` for them would mean a second `compileAsync`
 * over the whole scene -- which is the single most expensive step in the boot,
 * because three awaits `yieldToMain()` between every render object in it.
 *
 * So those callers put this group into the scene, let the **scene pass** walk it
 * along with everything else, and call `release()` afterwards. One pass, the
 * same dedupe, and the same rule about what may be disposed.
 *
 * `release()` takes the group out of wherever it was added and frees only the
 * geometries this module made (`WarmupPart.owned`). It is safe to call twice and
 * must be called once, or the stand-ins stay in the render list forever.
 */
export function warmupStandins(parts: readonly WarmupPart[]): {
  holder: Group;
  owned: BufferGeometry[];
  draws: number;
  duplicates: number;
  release(): void;
} {
  const holder = new Group();
  holder.name = 'pipeline-warmup';

  const owned: BufferGeometry[] = [];
  let draws = 0;
  let duplicates = 0;
  /**
   * Signatures already submitted. See `warmupSignature` -- 42% of this list is
   * nine independent callers asking for the same pipeline.
   *
   * A `Set` rather than sorting the parts, because the *order* of the list is
   * the order the pass compiles in and several groups deliberately put the
   * thing a player sees first at the front of their own block. Dropping a
   * later duplicate preserves that; sorting would destroy it.
   */
  const submitted = new Set<string>();

  for (const part of parts) {
    if (part.owned) owned.push(part.geometry);
    for (const receive of part.receives ?? BOTH_WAYS) {
      const signature = warmupSignature(part, receive);
      if (submitted.has(signature)) {
        duplicates++;
        continue;
      }
      submitted.add(signature);
      const mesh = new Mesh(part.geometry, part.material);
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

  return {
    holder,
    owned,
    draws,
    duplicates,
    release(): void {
      holder.removeFromParent();
      // Only the geometries this module made. Every other geometry and every
      // material here is the shared instance the game draws with, and disposing
      // one would blank the thing it belongs to -- or, worse, throw away the
      // pipeline the pass just paid for.
      for (const geometry of owned) geometry.dispose();
      owned.length = 0;
    },
  };
}

/**
 * WORKSTREAM AB: what makes two warm-up draws the *same pipeline*.
 *
 * ---------------------------------------------------------------------------
 * The boot log said `the shader warm-up did not finish in 11000 ms`, and the
 * first thing to ask about a pass that is too slow is how much of it is being
 * done twice. The answer was 42%.
 *
 * A pipeline for an ordinary `Mesh` is keyed by three things this pass controls
 * (`RenderObject.getCacheKey` and `getMaterialCacheKey`): the **material**, the
 * geometry's **attribute layout** -- names, item sizes and the normalised flag,
 * and nothing about the contents -- and **`receiveShadow`**. Nine callers build
 * the parts list independently and none of them can see the others, so the list
 * arrives full of collisions that are obvious only in aggregate:
 *
 *   - `characterWarmupParts` submits eight props -- cap, bumbag, shades, cup,
 *     hardhat, vest, phone, clipboard -- on **one** material with **one**
 *     attribute layout. Sixteen draws for two pipelines.
 *   - `eventWarmupParts` submits five, `streetlifeWarmupParts` four, on the same
 *     pattern. Ten draws for two, eight for two.
 *   - `highwayPatrolWarmupParts` submits the body, the light-bar housing and the
 *     RBT props on one material, and two lamp lenses on another.
 *
 * Counted over every group `perf-harness.ts` can build headlessly: **99 draws
 * for 57 distinct pipelines.** Each duplicate still costs a render-object
 * lookup, a binding update and -- the expensive part -- one `await
 * yieldToMain()` inside `Renderer.compileAsync`'s sequential loop, which is a
 * whole animation frame on any browser without `scheduler.yield`.
 *
 * Dropping them cannot change what gets compiled, because two draws with the
 * same signature compile the same pipeline by definition: the material is the
 * *same object*, so every property in the material cache key is equal, and the
 * layout string is exactly what `getGeometryCacheKey` reads. What it changes is
 * how many times the pass asks for it.
 *
 * `castShadow` is in the signature even though it is not in the colour
 * pipeline's key, because it decides whether the nested depth render sees this
 * mesh at all -- and the depth pipelines are half of what this pass exists for.
 * Two parts that differ only in `casts` are kept as two.
 */
export function warmupSignature(part: WarmupPart, receive: boolean): string {
  return `${part.material.uuid}|${geometryLayout(part.geometry)}|${part.casts ?? true}|${receive}`;
}

/**
 * The attribute layout half of the key, on its own.
 *
 * Split out of `warmupSignature` for the coverage audit, which prints it: a
 * mismatch report that says two signatures differ without saying *how* is a
 * report whose reader has to go and derive the layout by hand, and the layout is
 * the half that is nearly always wrong (the overhead wire was warmed with a
 * normal and a uv it does not carry). One function so the string the audit shows
 * a human is by construction the string the key was built from.
 *
 * Sorted, because `getGeometryCacheKey` sorts and two geometries built with
 * their attributes in a different order are one pipeline. `Object.keys` order is
 * insertion order, and the facade path in particular inserts `_bldidx` and
 * `_BLDIDX` in whichever order the loader happened to.
 */
export function geometryLayout(geometry: BufferGeometry): string {
  const attributes = geometry.attributes;
  let layout = '';
  for (const name of Object.keys(attributes).sort()) {
    const attribute = attributes[name];
    layout += `${name},${attribute.itemSize},${attribute.normalized ? 'n' : ''};`;
  }
  return layout;
}

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

  const { holder, draws: standInDraws, duplicates, release } = warmupStandins(parts);
  let draws = standInDraws;

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
    // The extras come back out before `release` takes the holder away, because
    // they are the caller's objects and the caller is still using them.
    for (let i = 0; i < extras.length; i++) {
      holder.remove(extras[i]);
      extras[i].frustumCulled = extraCulling[i];
    }
    release();
  }

  return {
    draws,
    duplicates,
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
export function pipelineCount(renderer: WebGPURenderer): number {
  const caches = (renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })
    ._pipelines?.caches;
  return caches instanceof Map ? caches.size : -1;
}

/**
 * A running count of pipelines compiled **synchronously, inside a rendered
 * frame** -- which is the one number this whole subject reduces to.
 *
 * Every other measure here is a proxy. A material that was never warmed only
 * matters if it costs a frame; a tile that streams in only matters if its
 * compile lands on the main thread. `Pipelines.getForRender` takes the blocking
 * `device.createRenderPipeline` branch exactly when it is reached from `render`
 * rather than from `compileAsync`, so the pipeline cache growing **across a
 * render call** is precisely and only that failure -- no wrapper around three's
 * internals, no attribution guesswork, one subtraction a frame.
 *
 * That is what makes it the right future-proofing check. The recurring shape of
 * this bug is a renderer added without a warm-up entry, and the shape it will
 * take next is one nobody here has thought of; a count that only asks "did a
 * frame pay for a compile" catches all of them, including the one that made this
 * pass necessary -- instanced meshes, which no boot-time stand-in can warm at
 * all (see this file's header).
 */
export class PipelineWatch {
  /** Frames that paid for at least one compile. Should be 0 after boot. */
  frames = 0;
  /** Pipelines compiled inside those frames. */
  pipelines = 0;
  /** The worst such frame, milliseconds. What the player actually felt. */
  worstMs = 0;
  /** Frames watched, so the count above can be read as a rate. */
  watched = 0;
  private before = -1;

  /** Call immediately before `renderer.render`. */
  begin(renderer: WebGPURenderer): void {
    this.before = pipelineCount(renderer);
  }

  /**
   * Call immediately after, with what the frame cost.
   *
   * `frameMs` is the caller's own measurement rather than one taken here,
   * because the render call is not the whole frame and the number worth
   * reporting is the one the player felt.
   */
  end(renderer: WebGPURenderer, frameMs: number): void {
    this.watched++;
    if (this.before < 0) return;
    const grew = pipelineCount(renderer) - this.before;
    if (grew <= 0) return;
    this.frames++;
    this.pipelines += grew;
    if (frameMs > this.worstMs) this.worstMs = frameMs;
  }
}

/**
 * What the audit below found: everything in the scene that will compile a
 * pipeline in the middle of play.
 */
export interface WarmupAudit {
  /**
   * Materials in the scene that the boot warm-up did not compile a stand-in
   * for. **Diagnostic, not a failure**: the instanced populations are all in
   * here by design, because a stand-in cannot warm them and they are covered by
   * `TileStreamer.setPrecompiler` and the scene pass instead. It is the list to
   * read when `syncFrames` is non-zero and you want a place to start.
   */
  coldMaterials: string[];
  /** How many pipelines the renderer has compiled since the warm-up finished. */
  pipelinesSinceWarmup: number;
  /** Frames that paid for a synchronous compile. See `PipelineWatch`. */
  syncFrames: number;
  syncPipelines: number;
  syncWorstMs: number;
  /**
   * Hidden meshes in the scene whose exact pipeline no stand-in warmed.
   *
   * WORKSTREAM AE. `coldMaterials` compares by **material** and so cannot see
   * the defect that produced this workstream: an entry that names the right
   * material and the wrong attribute layout, which warms a pipeline nothing
   * draws and leaves the real one to compile on first sight. This list compares
   * the whole key.
   *
   * Restricted to `visible === false` objects, and that is what keeps it honest
   * rather than noisy. Everything else in the scene was compiled by the scene
   * pass at the bottom of `main.ts` and needs no stand-in; an invisible object
   * was skipped by `_projectObject` in that walk exactly as it is in `render`,
   * so a stand-in is the only cover it can ever have. That is precisely the
   * boarding marker's case, and the swat puff's, and the football's.
   */
  uncovered: string[];
  /** Everything above that is a defect, as one list. Empty means covered. */
  failures: string[];
}

/**
 * Walk the live scene and name everything in it the warm-up did not cover.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, and it is not the same reason the warm-up exists.
 *
 * The recurring shape of this bug is not a wrong warm-up entry. It is a
 * **missing** one: somebody adds a renderer -- the police kit, the meth heads,
 * the wildlife, the nameplates, the night lamps, the far city -- and nobody adds
 * the entry, and the defect is invisible until a player turns around fast enough
 * to bring several of them into view on one frame. It cannot be caught by
 * reading either file, because the fault is precisely that the two files do not
 * mention each other. The only thing that can catch it is asking the *scene*,
 * after it is populated, what it is about to draw.
 *
 * So it is run a few seconds into play, once the streamer has filled the ring
 * and every ambient system has posed at least once, and the thing it actually
 * asserts is `PipelineWatch`: **zero frames may have paid for a compile.** That
 * is the symptom itself rather than a proxy for it, so it catches a renderer
 * shipped without warm-up coverage however the coverage was supposed to arrive
 * -- a boot stand-in, the scene pass, or `TileStreamer.setPrecompiler`.
 *
 * `coldMaterials` rides along as the place to start looking. It is deliberately
 * **not** a failure: every instanced population in the world is in that list by
 * construction, because no stand-in can warm one (see this file's header).
 *
 * Reported rather than thrown. A warm-up problem is a stutter, and a check that
 * could stop a boot over one would be worse than the thing it guards; the
 * console line plus `sydney.warmupAudit()` is enough to make the real thing
 * impossible to miss.
 */
export function auditWarmup(
  renderer: WebGPURenderer,
  scene: Scene,
  parts: readonly WarmupPart[],
  extras: readonly Object3D[],
  pipelinesAfterWarmup: number,
  watch: PipelineWatch,
): WarmupAudit {
  const warmed = new Set<Material>();
  for (const part of parts) warmed.add(part.material);
  for (const extra of extras) {
    extra.traverse((o) => {
      const material = (o as Mesh).material;
      if (!material) return;
      if (Array.isArray(material)) for (const m of material) warmed.add(m);
      else warmed.add(material);
    });
  }

  // Keyed by material rather than by object, because the far city is 192 meshes
  // over one material and the tiles are thousands over a dozen -- a list with an
  // entry per object is a list nobody reads. One example object each is what
  // makes the name actionable.
  const cold = new Map<Material, string>();

  scene.traverse((object) => {
    const material = (object as Mesh).material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const m of list) {
      if (warmed.has(m) || cold.has(m)) continue;
      cold.set(m, `${m.name || m.type} (e.g. ${object.name || object.type})`);
    }
  });
  const coldMaterials = [...cold.values()];

  // --- And the same question asked of the whole key rather than the material.
  //
  // `warmupSignature` is what the boot pass dedupes on, so a real mesh whose
  // signature is not in that set is a mesh the pass did not compile -- however
  // right the material was. Built here rather than kept from the pass because
  // the audit is also reachable from `sydney.warmupAudit()` at any moment.
  const signatures = new Set<string>();
  for (const part of parts) {
    for (const receive of part.receives ?? BOTH_WAYS) signatures.add(warmupSignature(part, receive));
  }
  for (const extra of extras) {
    extra.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.material || !mesh.geometry || Array.isArray(mesh.material)) return;
      signatures.add(
        warmupSignature({ geometry: mesh.geometry, material: mesh.material, casts: mesh.castShadow }, mesh.receiveShadow),
      );
    });
  }
  const uncovered: string[] = [];
  const seen = new Set<string>();
  scene.traverse((object) => {
    // Hidden only. See `WarmupAudit.uncovered`: everything visible was reached
    // by the scene pass, and an `InstancedMesh` can never be reached by a
    // stand-in at all -- three keys one on `object.uuid`.
    if (object.visible) return;
    const mesh = object as Mesh;
    if (!mesh.material || !mesh.geometry || Array.isArray(mesh.material)) return;
    if ((mesh as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return;
    const signature = warmupSignature(
      { geometry: mesh.geometry, material: mesh.material, casts: mesh.castShadow },
      mesh.receiveShadow,
    );
    if (signatures.has(signature) || seen.has(signature)) return;
    seen.add(signature);
    uncovered.push(
      `${mesh.material.name || mesh.material.type} {${geometryLayout(mesh.geometry)}} ` +
        `casts=${mesh.castShadow} receives=${mesh.receiveShadow} (e.g. ${object.name || object.type}) ` +
        `-- hidden, so only a boot stand-in can warm it`,
    );
  });

  const now = pipelineCount(renderer);
  const pipelinesSinceWarmup = now < 0 || pipelinesAfterWarmup < 0 ? -1 : now - pipelinesAfterWarmup;

  const failures: string[] = [];
  if (uncovered.length > 0) {
    failures.push(
      `${uncovered.length} hidden meshes have no warm-up entry with their exact key, so each ` +
        `compiles inside the frame it is first shown:\n      ${uncovered.join('\n      ')}`,
    );
  }
  if (watch.frames > 0) {
    failures.push(
      `${watch.pipelines} pipelines were compiled inside ${watch.frames} rendered frames ` +
        `(worst frame ${watch.worstMs.toFixed(0)} ms). Every one of those is a stall the ` +
        `player felt: warm it at boot if it is a shared material, or through ` +
        `TileStreamer.setPrecompiler if it is instanced.`,
    );
  }

  return {
    coldMaterials,
    pipelinesSinceWarmup,
    syncFrames: watch.frames,
    syncPipelines: watch.pipelines,
    syncWorstMs: watch.worstMs,
    uncovered,
    failures,
  };
}

/**
 * The self-check: the keying rules the whole subject rests on, asserted.
 *
 * ---------------------------------------------------------------------------
 * WORKSTREAM AE. Everything above and everything in
 * `client/src/perf-harness.ts --coverage` is built on one claim: that
 * `warmupSignature` tells apart exactly the things three's `RenderObject`
 * cache key tells apart, and nothing else. If that claim slips -- if the layout
 * stops reading `normalized`, or starts reading insertion order, or
 * `receiveShadow` falls out -- then the *audit goes green* while the world
 * hitches, which is worse than no audit at all. So the claim is a check.
 *
 * Every case below is a real bug this project has shipped or nearly shipped:
 *
 *   - **uv or no uv.** The overhead wire and then nine of the ten rail chunk
 *     materials were warmed with a uv the geometry does not carry. If these two
 *     signatures were equal the audit could not have found either.
 *   - **`normalized`.** The contact skirt's COLOR_0 is normalised bytes and the
 *     client's own builders emit float3; `warmupGeometry` has a separate flag
 *     for each and they must not collide.
 *   - **insertion order.** The facade path adds `_bldidx` and `_BLDIDX` in
 *     whichever order `GLTFLoader` happened to, and three sorts. A signature
 *     that did not sort would report the same geometry as two pipelines and
 *     send somebody looking for a mismatch that is not there.
 *   - **`receiveShadow` and `castShadow` both split.** Half the pipelines in
 *     this world are one of these two flags, and `applyShadowRole` flips the
 *     first one mid-walk.
 *   - **the `receives` default is both ways**, which is what makes that flip
 *     free -- and a part that quietly warmed one variant would put the compile
 *     back in the walk.
 *   - **`warmupStandins` dedupes and cleans up.** 43% of the parts list is the
 *     same pipeline asked for twice, and each duplicate costs a whole frame
 *     inside `compileAsync`'s sequential loop. And a `release()` that missed
 *     would leave stand-ins in the render list forever.
 *
 * Client-side only, and it has to be: this file imports three, and the server
 * imports nothing that does. Cheap enough for the boot list -- it builds six
 * one-triangle geometries and one throwaway material.
 */
export function verifyWarmup(): string[] {
  const failures: string[] = [];
  const material = new MeshBasicNodeMaterial();
  material.name = 'warmup-selfcheck';
  const other = new MeshBasicNodeMaterial();

  const sig = (geometry: BufferGeometry, casts: boolean, receive: boolean, m: Material = material): string =>
    warmupSignature({ geometry, material: m, casts }, receive);

  const plain = warmupGeometry({ normal: true });
  const withUv = warmupGeometry({ normal: true, uv: true });
  if (sig(plain, true, true) === sig(withUv, true, true)) {
    failures.push('a geometry with a uv and one without share a signature, so the rail/wire class of bug is invisible');
  }
  if (geometryLayout(plain) === geometryLayout(withUv)) {
    failures.push('geometryLayout does not distinguish a uv, so the audit prints two identical layouts for a mismatch');
  }

  const floatColour = warmupGeometry({ color3: true });
  const byteColour = warmupGeometry({ colorU8x4: true });
  if (sig(floatColour, true, true) === sig(byteColour, true, true)) {
    failures.push('a float3 colour and a normalised u8x4 colour share a signature; the contact skirt would be warmed wrong');
  }

  // Two geometries with the same attributes added in opposite orders. Three
  // sorts, so these are one pipeline and must be one signature.
  const forwards = new BufferGeometry();
  const backwards = new BufferGeometry();
  const position = new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3);
  const uv = new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2);
  forwards.setAttribute('position', position);
  forwards.setAttribute('uv', uv);
  backwards.setAttribute('uv', uv);
  backwards.setAttribute('position', position);
  if (sig(forwards, true, true) !== sig(backwards, true, true)) {
    failures.push('attribute insertion order changes the signature, but getGeometryCacheKey sorts -- the audit would report phantom mismatches');
  }

  if (sig(plain, true, true) === sig(plain, true, false)) {
    failures.push('receiveShadow is not in the signature, so every material would be warmed in one variant instead of two');
  }
  if (sig(plain, true, true) === sig(plain, false, true)) {
    failures.push('castShadow is not in the signature, so a caster with no depth pipeline would read as covered');
  }
  if (sig(plain, true, true) === sig(plain, true, true, other)) {
    failures.push('two different materials share a signature');
  }

  // The dedupe, the `receives` default, and the cleanup, on one list.
  const owned = warmupGeometry({ normal: true });
  const stand = warmupStandins([
    { geometry: owned, material, owned: true },
    // The same pipeline again, from a "different contributor". 43% of the real
    // list is this.
    { geometry: owned, material, owned: false },
    { geometry: owned, material, owned: false, casts: false },
  ]);
  if (stand.draws !== 4) {
    failures.push(`warmupStandins made ${stand.draws} draws for two distinct (material, layout, casts) pairs both ways; expected 4`);
  }
  if (stand.duplicates !== 2) {
    failures.push(`warmupStandins dropped ${stand.duplicates} duplicate draws; expected 2`);
  }
  const receives = stand.holder.children.map((c) => (c as Mesh).receiveShadow);
  if (!receives.includes(true) || !receives.includes(false)) {
    failures.push('the default receives is not both ways, so a tile crossing the shadow volume would compile mid-walk');
  }
  // Parented for real before the release, because a holder that was never added
  // is detached by definition and asserting on it proves nothing. This is the
  // arrangement the scene pass uses: `scene.add(holder)` and `release()` after.
  const stage = new Group();
  stage.add(stand.holder);
  stand.release();
  if (stand.holder.parent !== null) {
    failures.push('warmupStandins.release left the holder parented, so its stand-ins stay in the render list for the session');
  }

  material.dispose();
  other.dispose();
  plain.dispose();
  withUv.dispose();
  floatColour.dispose();
  byteColour.dispose();
  forwards.dispose();
  backwards.dispose();
  return failures;
}
