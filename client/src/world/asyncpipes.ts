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
const COMPILE_BUDGET_MS = 6;

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
  /**
   * Cache keys that have already produced a compile, so a *second* sighting is
   * known to be free before three is asked.
   *
   * The budget is unenforceable without this. A miss only announces itself
   * after `getForRender` returns a non-empty promise sink -- by which point the
   * WGSL has been built and the frame has already paid. `initialCacheKey` is a
   * plain field on the render object, set in its constructor, so reading it
   * costs nothing and turns "did this cost us" into "will this cost us".
   *
   * A key that is not in here may still turn out to be a cache *hit* -- two
   * render objects can share a key. Deferring one of those costs a single frame
   * of invisibility and corrects itself the moment the first one through adds
   * the key, which is the right way round for a guess this cheap to be wrong.
   */
  private readonly compiledKeys = new Set<number>();
  /** Draws deferred because the frame's compile budget was spent. */
  private deferredDraws = 0;
  /** Render objects this frame declined to build. Weak: three owns them. */
  private readonly deferred = new WeakSet<object>();

  get skipped(): number {
    return this.skippedDraws;
  }

  /** Draws deferred because the frame ran out of compile budget. */
  get deferrals(): number {
    return this.deferredDraws;
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
    this.budgetMs = budgetMs;
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
      /*
       * --- The budget.
       *
       * `initialCacheKey` is read *before* three is asked, because a miss only
       * announces itself afterwards and by then the WGSL is built and the frame
       * has paid. A key this gate has already seen go through is known to be
       * cached, so it is never charged and never deferred -- which is every
       * object in a settled scene, every frame.
       *
       * Three's own return value is discarded by `_renderObjectDirect`, which
       * calls this for its side effect on `renderObject.pipeline`. So declining
       * is safe here and is caught by the draw guard below.
       */
      const ro = renderObject as { initialCacheKey?: number };
      const key = ro.initialCacheKey;
      const known = key === undefined || this.compiledKeys.has(key);
      if (!known && this.budgetMs <= 0) {
        this.deferredDraws++;
        this.deferred.add(renderObject as object);
        return undefined;
      }

      const sink: unknown[] = [];
      // The clock is only read for a possible miss. A settled frame pays
      // nothing for this gate beyond a `Set.has`.
      const began = known ? 0 : performance.now();
      const pipeline = innerGet(renderObject, sink);
      if (!known) this.budgetMs -= performance.now() - began;
      if (sink.length > 0) {
        this.started += sink.length;
        this.note(renderObject);
      }
      // Whether or not it compiled, this key has now been through three and is
      // cached; a later sighting must not be charged for it.
      if (key !== undefined) this.compiledKeys.add(key);
      this.deferred.delete(renderObject as object);
      if (pipeline !== null && pipeline !== undefined) this.seen.add(pipeline);
      return pipeline;
    };

    const backend = backendEarly;
    const innerDraw = backend.draw.bind(backend);
    backend.draw = (renderObject: unknown, info: unknown): void => {
      // **Deferred by the budget.** three was never asked to build this one, so
      // `renderObject.pipeline` is whatever it was -- `undefined` on a first
      // sighting, which `setPipeline` turns into a validation error that ends
      // the frame. Exactly the hazard the still-compiling case below exists
      // for, arrived at from the other direction.
      if (this.deferred.has(renderObject as object)) {
        this.skippedDraws++;
        return;
      }
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
  // Four properties, and the gate is dangerous without any one of them: it must
  // stop, it must not stop everything, a deferred object must not be drawn (an
  // undefined pipeline ends the frame on a validation error), and a scene that
  // has settled must never be throttled by its own history.
  {
    const g = new AsyncPipelines();
    let built = 0;
    const spin = (ms: number): void => {
      const until = performance.now() + ms;
      let sink = 0;
      while (performance.now() < until) sink++;
      if (sink === -1) throw new Error('unreachable');
    };
    const inner = {
      getForRender: (_ro: unknown, promises?: unknown) => {
        if (Array.isArray(promises)) promises.push(Promise.resolve());
        built++;
        spin(3);
        return { id: built };
      },
    };
    const drawnHere: unknown[] = [];
    const back = {
      draw: (ro: unknown, _i: unknown) => {
        drawnHere.push(ro);
      },
      get: () => ({ pipeline: { gpu: true } }),
    };
    g.install({ _pipelines: inner, backend: back });

    // Ten first sightings, 6 ms of budget, 3 ms each.
    g.frame(6);
    const objs = Array.from({ length: 10 }, (_, i) => ({ initialCacheKey: i, pipeline: undefined }));
    for (const o of objs) inner.getForRender(o, null);
    if (built > 3) {
      failures.push(`a 6 ms budget built ${built} pipelines at 3 ms each; a frame is not bounded and can still stall.`);
    }
    if (built === 0) failures.push('a 6 ms budget built nothing; the gate is shut rather than bounded.');
    if (g.deferrals === 0) failures.push('nothing was deferred on an exhausted budget; the budget is not enforced.');

    // The deferred ones must not be drawn.
    const last = objs[objs.length - 1];
    back.draw(last, null);
    if (drawnHere.includes(last)) {
      failures.push('a deferred object was drawn; setPipeline(undefined) ends the frame on a validation error.');
    }

    // The next frame reopens it, or deferred work never arrives at all.
    const before = built;
    g.frame(6);
    for (const o of objs) inner.getForRender(o, null);
    if (built <= before) failures.push('`frame` did not reopen the budget; a deferred object would never be built.');

    // A key already through the gate is free forever, budget or no budget.
    // Without this a settled scene would stop drawing on its twentieth frame.
    g.frame(0);
    const settled = built;
    inner.getForRender(objs[0], null);
    if (built === settled) failures.push('a known key was refused with an empty budget; a settled scene would go blank.');

    // And the warm-up is never budgeted -- it passes its own promise array.
    g.frame(0);
    const boot = built;
    inner.getForRender({ initialCacheKey: 9999 }, []);
    if (built === boot) failures.push('the warm-up was refused by the frame budget; boot would compile nothing.');

    // --- Before the first frame, the gate is open.
    //
    // Boot renders outside the animation loop and reaches this with a null
    // promise array, indistinguishable from a frame. A gate that starts closed
    // defers all of them, and a deferred draw does not happen: the world comes
    // up empty and stays empty until the first `frame()` call, which is after
    // the boot it was supposed to warm.
    {
      const fresh = new AsyncPipelines();
      let madeAtBoot = 0;
      const bootInner = {
        getForRender: (_ro: unknown, promises?: unknown) => {
          if (Array.isArray(promises)) promises.push(Promise.resolve());
          madeAtBoot++;
          return { id: madeAtBoot };
        },
      };
      fresh.install({ _pipelines: bootInner, backend: { draw: () => {}, get: () => ({}) } });
      for (let i = 0; i < 40; i++) bootInner.getForRender({ initialCacheKey: 1000 + i }, null);
      if (madeAtBoot !== 40) {
        failures.push(
          `before the first frame the gate built ${madeAtBoot} of 40; boot renders outside the animation ` +
            `loop would be deferred and the world would come up empty.`,
        );
      }
      if (fresh.deferrals !== 0) failures.push('the gate deferred boot work before any frame had opened a budget.');
    }
  }

  return failures;
}
