/*
 * asyncpipes.ts -- the frame is allowed to say "not now".
 *
 * Every fix before this one tried to warm more: the tile's own pass, then the
 * shadow pass, then a catch-up sweep. All of them are the same bet -- that a
 * warm-up can be made exhaustive -- and the owner is right that the bet is
 * unwinnable. A 60 km city streams trains, landmarks, car models, mushrooms and
 * pedestrians that no boot pass can enumerate, and the moment one of them is
 * seen for the first time the frame stops dead to compile it.
 *
 * The frame should not be able to stop for that at all. It should hand the work
 * off and carry on. That is not a wish; WebGPU already provides it:
 *
 *     device.createRenderPipeline( ... )       // blocks the caller
 *     device.createRenderPipelineAsync( ... )  // returns a promise; the
 *                                              // driver compiles off-thread
 *
 * three uses the second form already -- but only from `compileAsync`. The
 * decision is one null check: `_renderObjectDirect` calls
 * `this._pipelines.getForRender( renderObject, this._compilationPromises )`,
 * and `_compilationPromises` is null on a frame, which routes straight to the
 * blocking call. Give it an array instead and the same code takes the async
 * path, caches the pipeline object immediately, and fills it in when the driver
 * is done.
 *
 * The other half is missing entirely. `WebGPUBackend.draw()` guards a pipeline
 * that *failed*:
 *
 *     if ( pipelineData.error === true ) return;
 *
 * but not one that is merely *not ready yet* -- it would call
 * `setPipeline(undefined)` and take the frame down. So this adds that guard:
 * an object whose pipeline is still compiling is simply not drawn this frame.
 *
 * The result is the thing the owner asked for: the compile is off the frame and
 * the draw is pausable. The cost is that a newly seen object appears a frame or
 * two late instead of arriving on time inside a 600 ms stall.
 *
 * **What this does not move.** `getForRender` also builds the WGSL from the
 * node graph, and that is JavaScript on this thread. The driver compile is
 * usually the larger half and is what moves here; if the stalls shrink but do
 * not vanish, the remainder is the node build, and three has an async path for
 * that too (`Nodes.getForRenderAsync`) which the frame loop cannot reach today.
 * Worth measuring before building it.
 */

/**
 * How many distinct values of one cache-key half to keep before giving up.
 *
 * The question this probe answers is "one, or many" -- nobody needs the 963rd
 * value of a key that has already proved it moves. A cap keeps a five-minute
 * ride from turning a diagnostic into the leak it is diagnosing.
 */
const HALF_CAP = 512;

/**
 * How much of a frame may be spent starting pipeline compiles, milliseconds.
 *
 * **Why a clock and not a count.** A five-minute ride recorded single frames
 * that started 82, 104 and 58 compiles, costing 533, 404 and 638 ms -- 6.5, 3.9
 * and 11 ms each. A count budget would have been three times too generous on
 * one of those frames and three times too mean on another; a clock is right on
 * all three without being told what a compile costs on this machine.
 *
 * Six milliseconds against a 24 ms median frame is a quarter of it, which is
 * visible as a slower fade-in and is not visible as a stall. That is the trade
 * this file already made once -- its header says a newly seen object may appear
 * a frame or two late -- and this is the same trade, held to a budget instead
 * of taken all at once.
 */
const COMPILE_BUDGET_MS = 24;

/*
 * There was a `FRESH_MS` here -- a threshold above which a call counted as
 * having built something -- and it is gone rather than tidied away, because
 * removing it *is* the fix. Two versions of this budget charged only calls
 * slower than it, and a real ride answered them: `budget on, 617285 draws`
 * beside `0 deferred`, on a frame that spent 584 ms in `render`. The gate was
 * on the path, called six hundred thousand times, and never charged, because
 * the cost of a first sighting does not arrive as one slow call. Three guesses
 * about where it does arrive were all wrong, so the budget stopped guessing and
 * counts every call.
 */

/**
 * A three `RenderObject`, seen through the two methods that decide its fate.
 *
 * `getCacheKey()` is `getMaterialCacheKey() + getDynamicCacheKey()`, and which
 * of the two moves is the whole question -- they fail for completely different
 * reasons and the fixes have nothing in common. Optional because the checks
 * stub this interface, and because a three release that renames them should
 * cost a blank column rather than a crash.
 */
interface CacheKeyed {
  getMaterialCacheKey?: () => number;
  getDynamicCacheKey?: () => number;
}

/** The pieces of the renderer this needs, named so a check can stub them. */
export interface PipelineHost {
  /**
   * Null until `renderer.init()` has run -- three builds it in `_initialize`,
   * not in the constructor. Installing before that threw
   * `Cannot read properties of null (reading 'getForRender')` and took the
   * whole boot with it, so `install` reports rather than assumes.
   */
  _pipelines: { getForRender: (renderObject: unknown, promises?: unknown) => unknown } | null;
  backend: {
    draw: (renderObject: unknown, info: unknown) => void;
    get: (object: unknown) => { pipeline?: unknown; error?: boolean };
  } | null;
  /**
   * The per-draw entry point, and the only level at which a build can be
   * declined safely.
   *
   * Everything inside it assumes the node state will be there: `_geometries`
   * and `_bindings` both reach through `getNodeBuilderState()`, which falls
   * back to a blocking build, so returning null from anywhere *within* the
   * sequence takes the frame down on a property read. Skipping the call whole
   * leaves nothing half-done -- three's own `_pipelines.isReady` gate already
   * establishes that an object may simply not be drawn this frame.
   *
   * Wrappable because `render()` re-reads `this._renderObjectDirect` into
   * `_handleObjectFunction` on every pass, so an own property on the instance
   * shadows the prototype from the next frame on.
   */
  _renderObjectDirect?: (...args: unknown[]) => void;
  /*
   * **`_objects` is deliberately not on this interface.** It was, and the gate
   * consulted it to tell a built draw from a fresh one -- which shipped the
   * renderer a corruption bug: `RenderObjects.get()` disposes a render object
   * whose cache key has drifted, taking its binding buffers with it, and doing
   * that to an object with a `createRenderPipelineAsync` still in flight
   * produces `[Buffer "bindingBuffer..."] used in submit while destroyed`.
   * The gate keeps its own note now (`drawnIn`) and asks three nothing. Leaving
   * the field off the type is what stops the next person reaching for it.
   */
}

export class AsyncPipelines {
  private installed = false;
  /** Draws skipped because the pipeline was still compiling. */
  private skippedDraws = 0;
  /** Compiles started off the frame. */
  private started = 0;
  /**
   * **What is compiling, by material, and why it is worth the eight lines.**
   *
   * A long ride across the city reached 3,476 pipelines and 2,320 of them
   * inside stalled frames. That is not a warm-up curve flattening out, it is
   * something creating pipelines without bound -- and four rounds of reasoning
   * about *which* thing produced four different confident answers, two of them
   * wrong. This is the one place in the client that knows a pipeline is being
   * created and is still holding the object it is for, so it is the only place
   * that can answer the question with a name instead of an argument.
   *
   * Kept to a tally rather than a log because the owner cannot paste a large
   * console without it falling over: the whole diagnosis has to fit in one
   * short line beside the frame time.
   */
  private readonly tally = new Map<string, number>();
  /**
   * Distinct pipeline *objects* seen, counted rather than held.
   *
   * **A pin was tried here and was wrong.** three does reference-count
   * pipelines and free them when the last user goes, and that looked like the
   * whole story: 2,314 compiles across 94 material keys, climbing with distance
   * travelled. So each new pipeline was given a permanent extra reference.
   *
   * The next run settled it, and against the fix: `compiles 2810 over 85 keys,
   * 2845 resident`. Resident climbed one-for-one with compiles. If pipelines
   * were being freed and rebuilt, pinning would have made resident *plateau*
   * near the key count; instead every compile produced a pipeline object that
   * had never existed before. They are not being released and re-created --
   * they are cache **misses**, and the pin was retaining every one of them,
   * which is a leak rather than a fix.
   *
   * The key three actually looks up is
   * `stageVertex.id + stageFragment.id + backendKey`, and the stage ids come
   * from the generated WGSL, cached on `renderObject.initialCacheKey` --
   * `getMaterialCacheKey() + getDynamicCacheKey()`. Something in that pair is
   * moving per object or per frame, and `_renderObjectDirect` will dispose and
   * rebuild a render object outright when it drifts. That is the next thing to
   * measure, not to reason about: this counter stays so the shape of the miss
   * is visible, and nothing is held.
   */
  private readonly seen = new Set<unknown>();
  /**
   * **The measurement this file has been asking for since its header was
   * written**, and it is a measurement rather than a fifth hypothesis on
   * purpose: four rounds of reasoning about which thing creates these pipelines
   * produced four confident answers and two of them were wrong.
   *
   * three's key is `getMaterialCacheKey() + getDynamicCacheKey()`. Sampled at
   * the miss, per material, as *how many distinct values each half has taken*.
   * One and many is the answer; which one is many says where to look:
   *
   *   - **mat many, dyn one** -- a material property, a texture sampler or the
   *     geometry's attribute set differs per object. Look at what builds them.
   *   - **mat one, dyn many** -- `_nodes.getCacheKey(scene, lightsNode)`, the
   *     camera, `receiveShadow`, or `renderer.contextNode`. Note that the
   *     shadow pass *skips* the nodes term (`RenderObject.js`: `if
   *     (material.isShadowPassMaterial !== true)`), so a session where
   *     `ShadowMaterial` goes flat while `foliage` and `car_paint` keep
   *     climbing already points here -- this says it out loud instead.
   *   - **both one** -- the key is stable and the misses are upstream, in
   *     `Pipelines`' own stage lookup rather than in the render object.
   */
  private readonly halves = new Map<string, { mat: Set<number>; dyn: Set<number> }>();
  /**
   * Set once if reading a half ever throws, and never cleared.
   *
   * A probe that can take the frame down is worse than no probe. three renames
   * things between releases and this reaches for two of its methods by name; if
   * that ever stops working the column goes blank and the game keeps running.
   */
  private probeDead = false;
  /** Milliseconds spent inside the draw path this frame, all calls counted. */
  private spentMs = 0;
  /**
   * Unbuilt render objects admitted *after* the budget ran out, this frame.
   *
   * Exactly one is allowed, so a machine slow enough to exhaust its budget on
   * ordinary draws still fills its world in rather than never.
   *
   * **The counter this replaces asked whether the `Object3D` was new, and that
   * held the gate permanently shut.** A live session reported `peak 2376 ms`
   * beside `0 deferred`: the accumulator watched a frame spend two and a half
   * seconds in the draw path and declined nothing, because the guard wanted a
   * brand-new object and there were none. The expensive builds are the *shadow*
   * passes of objects already drawn -- same object, different render object,
   * different pipeline -- so "have I seen this object" was the wrong question.
   * Whether *this render object* is built is the right one, and the lookup
   * below already answers it.
   */
  private newWhileOver = 0;
  /** The worst frame's accumulated draw time, for the console line. */
  private peakMs = 0;
  /** False until a frame opens a budget; boot runs unbudgeted. */
  private framed = false;
  /**
   * Milliseconds left in this frame's compile budget.
   *
   * **Open until the first frame asks for it, and that is not a detail.** Boot
   * renders outside the animation loop -- the ground-first pass, the shadow
   * warm, the precompiles -- and those reach `_renderObjectDirect` with a null
   * promise array, exactly like a frame does. Starting at zero would defer
   * every one of them, and a deferred draw is a draw that does not happen: the
   * world would come up empty and stay that way until `frame()` was first
   * called, which is after the boot it was meant to warm.
   */
  private budgetMs = Infinity;
  /** Draws declined because the frame's compile budget was spent. */
  private deferredDraws = 0;
  /**
   * What the budget is actually doing, and it exists because the alternative
   * failed twice.
   *
   * Two rides in a row reported `0 deferred` and there was no way to tell from
   * the console whether the gate was uninstalled, off the draw path, or blind
   * for want of `_objects` -- three different bugs with one symptom, and the
   * owner paid for a play session each time to not find out. A gate that
   * silently does nothing is worse than no gate: it takes the pressure off
   * looking. This is one short word on the frame line.
   */
  private gateCalls = 0;
  private gateHooked = false;
  /**
   * Which passes each object has completed a draw in, keyed by `passId`.
   *
   * **This exists because asking three the same question corrupts the
   * renderer.** `RenderObjects.get()` looks like a lookup and is not: when a
   * render object's cache key has drifted it calls `renderObject.dispose()` and
   * builds a fresh one, and `dispose` frees the binding buffers. The gate called
   * it once per declined draw, every frame it was over budget, which disposed
   * objects whose `createRenderPipelineAsync` was still in flight -- and the
   * pending creation then submitted against a destroyed buffer:
   *
   *     Async render pipeline creation failed (renderPipeline_foliage_102):
   *     [Buffer "bindingBuffer10952..."] used in submit while destroyed.
   *
   * So the gate keeps its own note instead, and never asks. Keyed on the object
   * *and the pass* because the shadow pass of an already-drawn mesh is a
   * different render object with a different pipeline behind the same
   * `Object3D`; keying on the object alone would call it built and never decline
   * the builds that actually cost the most.
   */
  private readonly drawnIn = new WeakMap<object, Set<string>>();

  get skipped(): number {
    return this.skippedDraws;
  }

  /** Draws deferred because the frame ran out of compile budget. */
  get deferrals(): number {
    return this.deferredDraws;
  }

  /**
   * The gate's own state, for the frame line. `off` means it never wrapped the
   * draw path; `idle` means it wrapped it and was never called, which is the
   * same thing seen from the other side; `blind` means it is on the path but
   * cannot tell a cached draw from a build, so it declines nothing.
   */
  budgetState(): string {
    if (!this.gateHooked) return 'budget off (no hook)';
    if (this.gateCalls === 0) return 'budget idle (never called)';
    const peak = Math.max(this.peakMs, this.spentMs).toFixed(0);
    return `budget on, ${this.gateCalls} draws, peak ${peak} ms`;
  }

  /**
   * Open a frame's compile budget. Called once at the top of the frame.
   *
   * Not called at all during boot, and it must not be: `compileAsync` passes
   * its own promise array and is routed straight through below, so the warm-up
   * still compiles everything it asks for as fast as it can. The budget governs
   * only the compiles nobody asked for -- the ones a tile entering the frustum
   * springs on the frame that happened to be drawing when it did.
   */
  frame(budgetMs = COMPILE_BUDGET_MS): void {
    if (this.spentMs > this.peakMs) this.peakMs = this.spentMs;
    this.spentMs = 0;
    this.newWhileOver = 0;
    this.budgetMs = budgetMs;
    this.framed = true;
  }

  get compiles(): number {
    return this.started;
  }

  /**
   * How many distinct pipeline objects have been created this session.
   *
   * Read it against `distinct`: if this tracks the compile count while the key
   * count sits still, every compile is a fresh object for a key that already
   * existed, and the fault is upstream in the cache key rather than in
   * anything this file can hold on to.
   */
  get objects(): number {
    return this.seen.size;
  }

  /**
   * Record one compile against the material that caused it.
   *
   * The name is the material's own where it has one, and its type where it does
   * not -- `NodeMaterial` and `MeshStandardNodeMaterial` are both common and
   * both useless on their own, so the geometry's attribute set is appended:
   * one material drawn with two different vertex layouts is two pipelines, and
   * that distinction is invisible from the name alone.
   */
  private note(renderObject: unknown): void {
    const ro = renderObject as {
      material?: { name?: string; type?: string };
      geometry?: { attributes?: Record<string, unknown> };
      object?: { isInstancedMesh?: boolean };
    };
    const m = ro.material;
    const base = (m?.name !== undefined && m.name !== '' ? m.name : m?.type) ?? 'unnamed';
    const attrs = ro.geometry?.attributes;
    const layout = attrs === undefined ? '' : `{${Object.keys(attrs).sort().join(',')}}`;
    const inst = ro.object?.isInstancedMesh === true ? '[inst]' : '';
    const key = `${base}${layout}${inst}`;
    this.tally.set(key, (this.tally.get(key) ?? 0) + 1);
    this.sampleHalves(key, renderObject as CacheKeyed);
  }

  /**
   * Record which values the two halves of the cache key took on this miss.
   *
   * Called on a compile only -- a handful a second at worst -- so the property
   * walk inside `getMaterialCacheKey` is affordable here in a way it would not
   * be per draw. three's own scratch arrays are cleaned up at the end of each
   * of these calls, so reading them again from outside its render loop is safe.
   */
  private sampleHalves(key: string, ro: CacheKeyed): void {
    if (this.probeDead) return;
    const mat = ro.getMaterialCacheKey;
    const dyn = ro.getDynamicCacheKey;
    if (typeof mat !== 'function' || typeof dyn !== 'function') return;
    let half = this.halves.get(key);
    if (half === undefined) {
      half = { mat: new Set<number>(), dyn: new Set<number>() };
      this.halves.set(key, half);
    }
    try {
      if (half.mat.size < HALF_CAP) half.mat.add(mat.call(ro));
      if (half.dyn.size < HALF_CAP) half.dyn.add(dyn.call(ro));
    } catch {
      this.probeDead = true;
    }
  }

  /**
   * The worst offender's key split, as one short phrase.
   *
   * One phrase because the owner pastes this line into chat and a console that
   * is itself the problem has already been made once in this file's history.
   * The worst offender rather than all of them for the same reason: whatever is
   * compiling 963 pipelines under one key is the thing to fix, and the other
   * seventy-four keys will almost certainly turn out to have the same cause.
   */
  drift(): string {
    let worstKey = '';
    let worstN = 0;
    for (const [k, n] of this.tally) {
      if (n > worstN) {
        worstN = n;
        worstKey = k;
      }
    }
    const half = this.halves.get(worstKey);
    if (half === undefined) return 'drift: unmeasured';
    const name = worstKey.replace(/\{[^}]*\}/, '');
    const n = (set: Set<number>): string => (set.size >= HALF_CAP ? `${HALF_CAP}+` : `${set.size}`);
    return `drift: ${name} mat ${n(half.mat)} / dyn ${n(half.dyn)} over ${worstN}`;
  }

  /** The `n` worst offenders, most first, as one short line. */
  top(n = 3): string {
    return [...this.tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} x${v}`)
      .join(', ');
  }

  /** How many distinct keys have ever compiled. A bounded client plateaus. */
  get distinct(): number {
    return this.tally.size;
  }

  /**
   * Wrap the two methods that decide whether a compile blocks the frame.
   *
   * Idempotent: wrapping twice would nest the sinks and double-count, and a
   * second install is exactly the sort of thing a later refactor does by
   * accident.
   */
  install(host: PipelineHost): boolean {
    if (this.installed) return true;
    const pipelines = host._pipelines;
    const backendEarly = host.backend;
    if (pipelines === null || pipelines === undefined || backendEarly === null || backendEarly === undefined) {
      // Too early: three fills these in during `init()`. Say so and let the
      // caller move the call, rather than throwing inside boot.
      return false;
    }
    this.installed = true;
    const innerGet = pipelines.getForRender.bind(pipelines);
    pipelines.getForRender = (renderObject: unknown, promises?: unknown): unknown => {
      // `compileAsync` passes its own array and collects the promises to await.
      // Leave that path exactly as it is: it is already off the frame, and the
      // boot pass depends on being able to wait for it.
      if (promises !== null && promises !== undefined) return innerGet(renderObject, promises);
      // A frame. Hand it an array so three takes `createRenderPipelineAsync`.
      // Nothing here awaits it -- the point is not to. The pipeline object is
      // cached synchronously either way, so the next frame finds it and the
      // draw guard below decides whether it is ready to use.
      const sink: unknown[] = [];
      const pipeline = innerGet(renderObject, sink);
      if (sink.length > 0) {
        this.started += sink.length;
        this.note(renderObject);
        /*
         * **Nothing awaits these, so something has to catch them.**
         *
         * Handing three an array is what routes a frame's compile to
         * `createRenderPipelineAsync`, and not awaiting the result is the whole
         * point -- the pipeline object is cached synchronously and the draw
         * guard decides when it is usable. But a promise with no handler that
         * rejects is an unhandled rejection, and the day they all reject at once
         * is the day the GPU goes away:
         *
         *     WebGPU Device Lost: A valid external Instance reference no longer
         *     exists.
         *     Uncaught (in promise) OperationError: Instance dropped in
         *     popErrorScope        (x25, x19, x13, x13, x6 ...)
         *
         * Tabbing back after thirteen seconds lost the device, every in-flight
         * creation rejected, and this line was every stack in the wall. It did
         * not cause the loss; it turned one failure into fifty and buried the
         * event that mattered. A no-op catch costs nothing and keeps the console
         * readable on the one occasion anybody needs to read it.
         */
        for (const p of sink) {
          if (p !== null && typeof p === 'object' && typeof (p as { catch?: unknown }).catch === 'function') {
            void (p as Promise<unknown>).catch(() => {});
          }
        }
      }
      if (pipeline !== null && pipeline !== undefined) this.seen.add(pipeline);
      return pipeline;
    };

    const backend = backendEarly;
    const innerDraw = backend.draw.bind(backend);
    backend.draw = (renderObject: unknown, info: unknown): void => {
      const ro = renderObject as { pipeline?: unknown };
      const data = ro.pipeline === undefined ? undefined : backend.get(ro.pipeline);
      // `error` is three's own business -- it returns early on that itself, and
      // second-guessing it here would only hide a real failure. The case three
      // has no answer for is a pipeline that exists but is still compiling.
      if (data !== undefined && data.error !== true && data.pipeline === undefined) {
        this.skippedDraws++;
        return;
      }
      innerDraw(renderObject, info);
    };

    /*
     * --- The budget, at the only level that can decline safely.
     *
     * **The first version of this wrapped `Pipelines.getForRender` and bounded
     * almost nothing** -- 21 deferrals against 1,586 compiles, and frames still
     * spending 248 ms in `render`. `Pipelines.getForRender` only *reads* the
     * node state (`renderObject.getNodeBuilderState()`); the WGSL is generated
     * one line earlier in `_nodes.updateForRender`, and by then the frame has
     * already paid for it. Budgeting the half that was left was budgeting the
     * cheap half.
     *
     * **Why the whole call and not the node build.** `getForRenderDeferred`
     * exists in three for exactly this and is documented "use this in render()
     * path to enable non-blocking compilation" -- but returning its null from
     * inside the sequence is not survivable: `_geometries.updateForRender` and
     * `_bindings.updateForRender` both reach through `getNodeBuilderState()`,
     * which falls back to a blocking build, and a caller that gets null reads a
     * property off it and ends the frame. Declining the whole call leaves
     * nothing half-built, and three already treats a not-drawn object as normal
     * -- `_pipelines.isReady` gates the draw two lines further down.
     *
     * **The cheap test comes first.** While budget remains the wrapper only
     * times the call and charges anything slower than `FRESH_MS`; a settled
     * frame pays two clock reads per draw and no lookups. Only once the budget
     * is gone does it consult `_objects` to tell a cached draw from a build --
     * a nested-map walk it would be wrong to run per draw on a healthy frame,
     * and cheap against what it saves on a frame that is already in trouble.
     *
     * `budgetMs` is `Infinity` until a frame asks, so boot passes outside the
     * animation loop run unbudgeted and the world comes up whole.
     */
    const direct = host._renderObjectDirect;
    if (typeof direct === 'function') {
      this.gateHooked = true;
      const innerDirect = direct.bind(host);
      host._renderObjectDirect = (...args: unknown[]): void => {
        this.gateCalls++;
        /*
         * **Bound the observable, not a guess about where the cost is.**
         *
         * Two earlier versions charged only calls slower than `FRESH_MS` and a
         * real ride answered them: `budget on, 617285 draws`, `0 deferred`, on
         * a frame that spent 584 ms in `render`. The gate was on the path and
         * never charged, because the cost of a first sighting does not arrive
         * as one slow call -- and three guesses about where it does arrive have
         * now all been wrong.
         *
         * So this counts *every* call's wall time into one per-frame total and
         * stops admitting **new** objects once that total passes the budget.
         * It does not care whether the milliseconds are node building, pipeline
         * creation, a driver stall or something nobody has named yet: a frame
         * that has already spent its whole budget drawing does not take on more
         * work it has never done before. Objects it already knows keep drawing,
         * always, which is what keeps a settled scene on screen.
         *
         * At least one build a frame is let through regardless, so a machine
         * slow enough to exhaust the budget on ordinary draws still fills the
         * world in -- slowly, rather than never.
         */
        if (this.framed && this.spentMs > this.budgetMs) {
          // **Our own note, never `_objects.get`.** See `drawnIn`: that call
          // disposes render objects and takes their buffers with them.
          const pass = typeof args[7] === 'string' ? args[7] : '';
          const subject = args[0];
          const seen =
            typeof subject === 'object' && subject !== null ? this.drawnIn.get(subject) : undefined;
          const built = seen !== undefined && seen.has(pass);
          if (!built) {
            // One unbuilt object gets through per frame, so progress is never
            // zero even on a machine that blows the budget on ordinary draws.
            if (this.newWhileOver > 0) {
              this.deferredDraws++;
              return;
            }
            this.newWhileOver++;
          }
        }
        const t0 = performance.now();
        innerDirect(...args);
        this.spentMs += performance.now() - t0;
        // Guarded because this runs inside the draw path: a `WeakMap` given a
        // non-object throws, and a throw here takes the frame down rather than
        // costing a note. three always passes an `Object3D`; a stub in a check
        // might not, and neither should be able to stop a render.
        const drawnObj = args[0];
        if (typeof drawnObj === 'object' && drawnObj !== null) {
          const donePass = typeof args[7] === 'string' ? args[7] : '';
          let passes = this.drawnIn.get(drawnObj);
          if (passes === undefined) {
            passes = new Set<string>();
            this.drawnIn.set(drawnObj, passes);
          }
          passes.add(donePass);
        }
      };
    }
    return true;
  }
}

export function verifyAsyncPipes(): string[] {
  const failures: string[] = [];

  const seen: { promises: unknown }[] = [];
  const drawn: unknown[] = [];
  const backendData = new Map<unknown, { pipeline?: unknown; error?: boolean }>();

  const pipes = {
    getForRender: (_ro: unknown, promises?: unknown) => {
      seen.push({ promises });
      // Stand in for three filling the array on a cache miss.
      if (Array.isArray(promises)) promises.push(Promise.resolve());
      return { id: 'pipeline' };
    },
  };
  const backend = {
    draw: (ro: unknown, _info: unknown) => {
      drawn.push(ro);
    },
    get: (o: unknown) => backendData.get(o) ?? {},
  };
  const host: PipelineHost = { _pipelines: pipes, backend };

  const gate = new AsyncPipelines();

  // **Before `renderer.init()` three has not built these yet.** Installing then
  // threw and took the boot down; the caller needs to be told, not thrown at.
  if (gate.install({ _pipelines: null, backend: null })) {
    failures.push('claimed to install on a renderer that has not been initialised; that throws at boot.');
  }
  if (!gate.install(host)) failures.push('did not install on a ready renderer.');
  gate.install(host); // must not nest

  // A frame: three passes null, and that is the null check that routes it to
  // the blocking `createRenderPipeline`. It must not reach the inner call.
  pipes.getForRender({ id: 'ro' }, null);
  if (seen.length !== 1) failures.push('the pipeline call did not reach three.');
  else if (seen[0].promises === null || seen[0].promises === undefined) {
    failures.push(
      'a frame still asked three for a blocking pipeline compile; the frame stops' +
        ' dead on the first sight of any new material',
    );
  }
  if (gate.compiles !== 1) failures.push(`counted ${gate.compiles} off-frame compiles, expected 1.`);

  // `compileAsync` already collects its own promises. Passing it a fresh sink
  // would drop them on the floor and the boot pass would stop waiting for
  // anything.
  const theirs: unknown[] = [];
  pipes.getForRender({ id: 'ro2' }, theirs);
  if (seen[1].promises !== theirs) {
    failures.push("the warm-up's own promise array was replaced; nothing can await the boot compile.");
  }

  // A pipeline still compiling: skip the draw rather than handing WebGPU an
  // undefined pipeline, which ends the frame with a validation error.
  const compiling = { id: 'compiling' };
  backendData.set(compiling, {});
  backend.draw({ pipeline: compiling }, null);
  if (drawn.length !== 0) {
    failures.push(
      'drew an object whose pipeline was still compiling; setPipeline(undefined)' +
        ' takes the whole frame down',
    );
  }
  if (gate.skipped !== 1) failures.push(`counted ${gate.skipped} skipped draws, expected 1.`);

  // Ready: draw it. A gate that never opens is a world that never appears.
  const ready = { id: 'ready' };
  backendData.set(ready, { pipeline: { gpu: true } });
  backend.draw({ pipeline: ready }, null);
  if (drawn.length !== 1) failures.push('a ready pipeline was not drawn; the world would stay empty.');

  // A failed pipeline is three's own case; it returns early itself. Swallowing
  // it here would hide a real failure behind a silent skip.
  const broken = { id: 'broken' };
  backendData.set(broken, { error: true });
  backend.draw({ pipeline: broken }, null);
  if (drawn.length !== 2) failures.push('a failed pipeline was skipped here instead of by three.');
  if (gate.skipped !== 1) failures.push('a failed pipeline was counted as still compiling.');

  // --- Nothing is retained. A gate that holds every pipeline it sees is a leak,
  // and this one held 2,845 of them before the counter gave it away.
  {
    const g = new AsyncPipelines();
    const pipes = [{ id: 1 }, { id: 2 }, { id: 3 }];
    let i = 0;
    const inner = {
      getForRender: (_ro: unknown, promises?: unknown) => {
        if (Array.isArray(promises)) promises.push(Promise.resolve());
        return pipes[i++ % pipes.length];
      },
    };
    g.install({ _pipelines: inner, backend: { draw: () => {}, get: () => ({}) } });
    for (let k = 0; k < 30; k++) inner.getForRender({}, null);
    if (g.objects !== 3) {
      failures.push(`counted ${g.objects} distinct pipeline objects out of 3; the tally is not deduping.`);
    }
    if (g.compiles !== 30) failures.push(`counted ${g.compiles} compiles out of 30.`);
  }

  // An object with no pipeline at all is not this gate's business either.
  backend.draw({}, null);
  if (drawn.length !== 3) failures.push('an object with no pipeline was swallowed.');

  // --- The drift probe tells the two halves apart.
  //
  // This is the whole point of it. A probe that says "something moves" is the
  // four rounds of argument this file's header records; a probe that says
  // *which half* moves is a place to look. Both directions are asserted,
  // because one that always blames the dynamic half would have passed a test
  // that only ever moved the dynamic half.
  {
    const drifting = (mat: () => number, dyn: () => number, n: number): string => {
      const g = new AsyncPipelines();
      const inner = {
        getForRender: (_ro: unknown, promises?: unknown) => {
          if (Array.isArray(promises)) promises.push(Promise.resolve());
          return { id: 'p' };
        },
      };
      const host = { _pipelines: inner, backend: { draw: () => {}, get: () => ({}) } };
      g.install(host);
      for (let k = 0; k < n; k++) {
        inner.getForRender({ material: { name: 'probe' }, getMaterialCacheKey: mat, getDynamicCacheKey: dyn }, null);
      }
      return g.drift();
    };

    let tick = 0;
    const moving = drifting(() => 7, () => tick++, 10);
    if (!moving.includes('mat 1 / dyn 10')) {
      failures.push(`a moving dynamic half read as "${moving}"; the probe cannot name the half that drifts.`);
    }
    tick = 0;
    const other = drifting(() => tick++, () => 7, 10);
    if (!other.includes('mat 10 / dyn 1')) {
      failures.push(`a moving material half read as "${other}"; the probe blames the dynamic half either way.`);
    }
    const stable = drifting(() => 7, () => 7, 10);
    if (!stable.includes('mat 1 / dyn 1')) {
      failures.push(`a stable key read as "${stable}"; the probe invents drift that is not there.`);
    }
    if (!stable.includes('over 10')) failures.push(`the compile count is missing from "${stable}".`);
  }

  // --- A three that renamed these methods costs a blank column, not a crash.
  {
    const g = new AsyncPipelines();
    const inner = {
      getForRender: (_ro: unknown, promises?: unknown) => {
        if (Array.isArray(promises)) promises.push(Promise.resolve());
        return { id: 'p' };
      },
    };
    g.install({ _pipelines: inner, backend: { draw: () => {}, get: () => ({}) } });
    inner.getForRender({ material: { name: 'plain' } }, null);
    if (g.drift() !== 'drift: unmeasured') {
      failures.push(`a render object with no cache-key methods reported "${g.drift()}" instead of standing down.`);
    }
    // And one that throws must not take the frame with it.
    const boom = () => {
      throw new Error('three moved on');
    };
    inner.getForRender({ material: { name: 'boom' }, getMaterialCacheKey: boom, getDynamicCacheKey: boom }, null);
    if (g.compiles !== 2) failures.push('a throwing cache-key probe lost a compile from the count.');
  }

  // --- The compile budget bounds one frame and starves nothing.
  //
  // Four ways this is worse than the stall it replaces, and the first version
  // of it shipped with the first one wrong: it bounded `Pipelines.getForRender`,
  // which only reads the node state, and a real ride deferred 21 draws out of
  // 1,586 compiles while frames still spent 248 ms in `render`. So the first
  // assertion is that an expensive draw is actually *stopped*.
  {
    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    interface Rec {
      _nodeBuilderState?: unknown;
    }
    const state = new Map<unknown, Rec>();
    let ran = 0;
    const host = {
      _pipelines: { getForRender: () => ({ id: 'p' }) },
      backend: { draw: () => {}, get: () => ({}) },
      _objects: { get: (o: unknown) => state.get(o) ?? null },
      _currentRenderContext: null,
      // Stands in for three's per-draw path: a first sighting builds and is
      // slow, everything after it is a draw and is not.
      _renderObjectDirect: (o: unknown): void => {
        ran++;
        const rec = state.get(o);
        // Unbuilt is `null` here, the way three leaves it.
        if (rec !== undefined && (rec._nodeBuilderState === null || rec._nodeBuilderState === undefined)) {
          spin(3);
          rec._nodeBuilderState = {};
        }
      },
    };
    const g = new AsyncPipelines();
    if (!g.install(host as unknown as PipelineHost)) failures.push('the gate did not install on a full renderer.');

    const objs = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    // three sets this to `null` on construction, not absent -- the difference
    // is what let a wrong sentinel through to production.
    for (const o of objs) state.set(o, { _nodeBuilderState: null });

    g.frame(6);
    for (const o of objs) host._renderObjectDirect(o);
    // Loose on purpose. The property is that the frame is *bounded*, not that
    // it stops at an exact count: one unbuilt object is admitted per frame after
    // the budget is gone, and `performance.now()` is clamped to about 100 us in
    // a browser and is nanosecond-sharp under bun -- an exact bound passes in
    // one and fails in the other, which is how a boot check once refused to
    // start the live client.
    if (ran > 6) {
      failures.push(`a 6 ms budget ran ${ran} builds at 3 ms each; the frame is not bounded and can still stall.`);
    }
    if (ran === 0) failures.push('a 6 ms budget built nothing; the gate is shut rather than bounded.');
    if (g.deferrals === 0) failures.push('nothing was declined on an exhausted budget; the budget is not enforced.');

    // A draw whose node state is already built must still happen. Refusing
    // those is how a settled scene goes blank on its twentieth frame.
    const built = ran;
    host._renderObjectDirect(objs[0]);
    if (ran === built) failures.push('an already-built draw was declined with no budget left; the scene would go blank.');

    // The next frame reopens it, or a declined object never arrives at all.
    const before = ran;
    g.frame(6);
    for (const o of objs) host._renderObjectDirect(o);
    if (ran <= before) failures.push('`frame` did not reopen the budget; a declined object would never be built.');
  }

  // --- Before the first frame, the gate is open.
  //
  // Boot renders outside the animation loop -- ground-first, the shadow warm,
  // the precompiles -- and reach the same per-draw path. A gate that starts
  // closed declines all of them, and a declined draw does not happen: the world
  // comes up empty and stays empty until the first `frame()` call, which is
  // after the boot it was supposed to warm.
  {
    let ranAtBoot = 0;
    // **Unbuilt render objects, not nulls.** The first version of this check
    // handed the gate a `_objects` that returned null, which the wrapper reads
    // as "not mine, draw it" -- so it passed against a gate closed by default
    // and proved nothing. Boot's objects are real and unbuilt; model that.
    const bootObjs = Array.from({ length: 40 }, (_, i) => ({ n: i }));
    const bootState = new Map<unknown, { _nodeBuilderState?: unknown }>();
    for (const o of bootObjs) bootState.set(o, { _nodeBuilderState: null });
    const host = {
      _pipelines: { getForRender: () => ({ id: 'p' }) },
      backend: { draw: () => {}, get: () => ({}) },
      _objects: { get: (o: unknown) => bootState.get(o) ?? null },
      _currentRenderContext: null,
      _renderObjectDirect: (o: unknown): void => {
        ranAtBoot++;
        const rec = bootState.get(o);
        if (rec !== undefined) rec._nodeBuilderState = {};
      },
    };
    const fresh = new AsyncPipelines();
    fresh.install(host as unknown as PipelineHost);
    for (const o of bootObjs) host._renderObjectDirect(o);
    if (ranAtBoot !== 40) {
      failures.push(
        `before the first frame the gate ran ${ranAtBoot} of 40 draws; boot passes outside the animation ` +
          `loop would be declined and the world would come up empty.`,
      );
    }
    if (fresh.deferrals !== 0) failures.push('the gate declined boot work before any frame had opened a budget.');
  }

  // --- A gate that does nothing must say so.
  //
  // **This is the check that two play sessions bought.** The budget reported
  // `0 deferred` twice running, and `0` is what you see whether the gate never
  // wrapped the draw path, wrapped it and was never called, or is on the path
  // but cannot reach `_objects` -- three different bugs, one symptom, no way to
  // tell them apart from the console. The second of those was real: `_objects`
  // was captured at install, before three had filled it in, so the whole
  // deferral branch was dead. Now the state is a word on the frame line, and
  // the blind case degrades to a weaker test instead of to nothing.
  {
    const noHook = new AsyncPipelines();
    noHook.install({ _pipelines: { getForRender: () => ({}) }, backend: { draw: () => {}, get: () => ({}) } });
    if (!noHook.budgetState().startsWith('budget off')) {
      failures.push(`a gate with no draw hook reported "${noHook.budgetState()}" instead of saying it is off.`);
    }

    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    const objs = Array.from({ length: 10 }, (_, i) => ({ n: i }));
    const seen = new WeakSet<object>();
    // No `_objects` at all: the gate must notice, say so, and still bound the
    // frame rather than waving everything through.
    const host = {
      _pipelines: { getForRender: () => ({ id: 'p' }) },
      backend: { draw: () => {}, get: () => ({}) },
      _renderObjectDirect: (o: unknown): void => {
        if (!seen.has(o as object)) {
          seen.add(o as object);
          spin(3);
        }
      },
    };
    const gate = new AsyncPipelines();
    gate.install(host as unknown as PipelineHost);
    if (!gate.budgetState().startsWith('budget idle')) {
      failures.push(`a hooked gate that has never been called reported "${gate.budgetState()}".`);
    }
    gate.frame(6);
    for (const o of objs) host._renderObjectDirect(o);
    if (gate.deferrals === 0) {
      failures.push(`the gate declined nothing and reported "${gate.budgetState()}".`);
    }

    // --- **The gate must never ask three about a render object.**
    //
    // `RenderObjects.get()` reads like a lookup and is not: a render object
    // whose cache key has drifted is `dispose()`d and rebuilt, and `dispose`
    // frees its binding buffers. The gate used to call it once per declined
    // draw, every frame it was over budget, which disposed objects with a
    // `createRenderPipelineAsync` still in flight -- and the pending creation
    // then submitted against a destroyed buffer:
    //
    //     Async render pipeline creation failed (renderPipeline_foliage_102):
    //     [Buffer "bindingBuffer10952..."] used in submit while destroyed
    //
    // The game ran for thirty seconds. `_objects` is off the host type now, and
    // this fails if anything puts it back.
    {
      let asked = 0;
      const trap = {
        _pipelines: { getForRender: (): unknown => ({ id: 'p' }) },
        backend: { draw: (): void => {}, get: (): Record<string, never> => ({}) },
        _objects: {
          get: (): unknown => {
            asked++;
            return null;
          },
        },
        _currentRenderContext: null,
        _renderObjectDirect: (_o: unknown): void => {
          const until = performance.now() + 0.3;
          let sink = 0;
          while (performance.now() < until) sink++;
          if (sink === -1) throw new Error('unreachable');
        },
      };
      const g2 = new AsyncPipelines();
      g2.install(trap as unknown as PipelineHost);
      g2.frame(1);
      const trapObjs = Array.from({ length: 40 }, (_, i) => ({ n: i }));
      for (const o of trapObjs) trap._renderObjectDirect(o);
      if (asked > 0) {
        failures.push(
          `the gate called \`_objects.get\` ${asked} times. That disposes render objects and frees their ` +
            `binding buffers, and doing it to one with an async pipeline in flight kills the renderer.`,
        );
      }
    }
  }

  // --- The gate survives three's actual dispatch, not a convenient stand-in.
  //
  // Every other check here calls `_renderObjectDirect` straight off an object
  // literal. three does neither of those things: it is a prototype method, and
  // `render()` copies it into `_handleObjectFunction` at the top of every pass
  // and calls it through that. A gate that installs an own property and is
  // never reached would look exactly like a gate that is reached and declines
  // nothing -- both report `0 deferred` -- so the difference has to be a test
  // rather than an argument.
  {
    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    class FakeRenderer {
      _pipelines = {
        getForRender: (_ro: unknown, p?: unknown): unknown => {
          if (Array.isArray(p)) p.push(Promise.resolve());
          return { id: 1 };
        },
      };
      backend = { draw: (): void => {}, get: (): Record<string, never> => ({}) };
      state = new Map<unknown, { _nodeBuilderState?: unknown }>();
      _objects = { get: (o: unknown): unknown => this.state.get(o) ?? null };
      _currentRenderContext = null;
      _handleObjectFunction: ((o: unknown) => void) | null = null;
      ran = 0;
      _renderObjectDirect(o: unknown): void {
        const rec = this.state.get(o);
        // Unbuilt is `null` here, the way three leaves it.
        if (rec !== undefined && (rec._nodeBuilderState === null || rec._nodeBuilderState === undefined)) {
          spin(3);
          rec._nodeBuilderState = {};
        }
        this.ran++;
      }
      render(objs: unknown[]): void {
        // three re-reads the property here on every pass, which is the whole
        // reason an own property installed after construction is picked up.
        this._handleObjectFunction = (this as unknown as { _renderObjectDirect: (o: unknown) => void })
          ._renderObjectDirect;
        for (const o of objs) (this._handleObjectFunction as (o: unknown) => void)(o);
      }
    }

    const r = new FakeRenderer();
    const g = new AsyncPipelines();
    if (!g.install(r as unknown as PipelineHost)) failures.push('the gate did not install on a class-shaped renderer.');
    const objs = Array.from({ length: 20 }, (_, i) => ({ n: i }));
    for (const o of objs) r.state.set(o, {});
    g.frame(6);
    r.render(objs);
    if (!g.budgetState().startsWith('budget on')) {
      failures.push(
        `dispatched the way three dispatches, the gate reported "${g.budgetState()}" -- it is not on the ` +
          `draw path, and every frame line would say 0 deferred without saying why.`,
      );
    }
    if (g.deferrals === 0) {
      failures.push(`a 6 ms budget declined nothing across 20 builds of 3 ms dispatched through _handleObjectFunction.`);
    }
    if (r.ran > 6) failures.push(`${r.ran} of 20 builds ran on a 6 ms budget; the frame is not bounded.`);
  }

  // --- Many cheap calls, one enormous frame.
  //
  // **This is the shape that beat two versions of the budget.** A real ride
  // reported `budget on, 617285 draws` beside `0 deferred` on a frame that
  // spent 584 ms in `render`: the gate was on the draw path, called six hundred
  // thousand times, and charged nothing, because no single call was slow enough
  // to notice. Every earlier check here spun 3 ms per call and so could never
  // have caught it. The cost of a first sighting does not have to arrive as one
  // slow call, and a budget that only bounds slow calls bounds nothing.
  {
    const objs = Array.from({ length: 60 }, (_, i) => ({ n: i }));
    const state = new Map<unknown, { _nodeBuilderState?: unknown }>();
    // three sets this to `null` on construction, not absent -- the difference
    // is what let a wrong sentinel through to production.
    for (const o of objs) state.set(o, { _nodeBuilderState: null });
    let ran = 0;
    const host = {
      _pipelines: { getForRender: (): unknown => ({ id: 'p' }) },
      backend: { draw: (): void => {}, get: (): Record<string, never> => ({}) },
      _objects: { get: (o: unknown): unknown => state.get(o) ?? null },
      _currentRenderContext: null,
      // A few microseconds each -- far under `FRESH_MS` -- but four thousand of
      // them is a frame nobody can play through.
      // **Spun on the clock, not on an iteration count.** A browser clamps
      // `performance.now()` to about 100 us, so a few thousand adds measure as
      // exactly zero, the accumulator never moves and the check tests the clock
      // rather than the gate. Under bun the same loop is sharp enough to pass.
      _renderObjectDirect: (o: unknown): void => {
        ran++;
        const until = performance.now() + 0.3;
        let sink = 0;
        while (performance.now() < until) sink++;
        if (sink === -1) throw new Error('unreachable');
        const rec = state.get(o);
        if (rec !== undefined) rec._nodeBuilderState = {};
      },
    };
    const g = new AsyncPipelines();
    g.install(host as unknown as PipelineHost);
    g.frame(4);
    for (const o of objs) host._renderObjectDirect(o);
    if (g.deferrals === 0) {
      failures.push(
        `60 individually-cheap draws blew a 4 ms budget and the gate declined none of them ` +
          `("${g.budgetState()}"). A budget that only bounds calls slower than FRESH_MS bounds nothing, ` +
          `which is what a real ride reported as "budget on, 617285 draws, 0 deferred".`,
      );
    }
    if (ran === 0) failures.push('the gate declined everything, including the first build; nothing would ever appear.');
    if (!g.budgetState().includes('peak')) failures.push('the gate does not report the frame time it accumulated.');
  }

  // --- The second pass over an object it has already drawn.
  //
  // **This is the shape that held the gate shut on a live machine**, reported
  // as `peak 2376 ms` beside `0 deferred`: the accumulator watched one frame
  // spend two and a half seconds in the draw path and declined nothing. The
  // forward-progress guard asked whether the `Object3D` was new, and after the
  // first frame none of them are -- but the expensive builds are the *shadow*
  // passes of objects already drawn, a different render object and a different
  // pipeline behind the same object. Every other check here uses objects seen
  // for the first time and so could never have caught it.
  {
    const objs = Array.from({ length: 40 }, (_, i) => ({ n: i }));
    // Keyed on object *and* pass, the way three keys a render object.
    const state = new Map<string, { _nodeBuilderState?: unknown }>();
    const key = (o: unknown, pass: unknown): string => `${(o as { n: number }).n}|${String(pass)}`;
    for (const o of objs) {
      state.set(key(o, 'beauty'), { _nodeBuilderState: null });
      state.set(key(o, 'shadow'), { _nodeBuilderState: null });
    }
    let ran = 0;
    const host = {
      _pipelines: { getForRender: (): unknown => ({ id: 'p' }) },
      backend: { draw: (): void => {}, get: (): Record<string, never> => ({}) },
      _objects: { get: (...a: unknown[]): unknown => state.get(key(a[0], a[7])) ?? null },
      _currentRenderContext: null,
      _renderObjectDirect: (o: unknown, ...rest: unknown[]): void => {
        ran++;
        const until = performance.now() + 0.3;
        let sink = 0;
        while (performance.now() < until) sink++;
        if (sink === -1) throw new Error('unreachable');
        const rec = state.get(key(o, rest[6]));
        if (rec !== undefined) rec._nodeBuilderState = {};
      },
    };
    const g = new AsyncPipelines();
    g.install(host as unknown as PipelineHost);

    // Frame one: the beauty pass, with room to build everything. Every object
    // is now one this gate has drawn, which is the premise of frame two.
    g.frame(1000);
    for (const o of objs) host._renderObjectDirect(o, null, null, null, null, null, null, 'beauty');
    const afterBeauty = g.deferrals;

    // Frame two: the shadow pass over the same objects, none of it built, on a
    // budget the pass blows immediately.
    g.frame(2);
    for (const o of objs) host._renderObjectDirect(o, null, null, null, null, null, null, 'shadow');
    if (g.deferrals === afterBeauty) {
      failures.push(
        `a second pass over objects already drawn was never declined ("${g.budgetState()}"). ` +
          `The shadow pass builds a different render object behind the same Object3D, so a guard that ` +
          `asks whether the object is new holds the gate shut forever -- reported live as peak 2376 ms, 0 deferred.`,
      );
    }
    if (ran <= objs.length) failures.push('the shadow pass was declined whole; shadows would never appear.');
  }

  return failures;
}
