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
   * Every pipeline this client has ever built, held so three cannot free it.
   *
   * **This is the fix for the whole thing.** three reference-counts a pipeline
   * and releases it when the last render object using it goes away:
   *
   *     if ( previousPipeline ) previousPipeline.usedTimes --;
   *     ...
   *     if ( previousPipeline && previousPipeline.usedTimes === 0 )
   *         this._releasePipeline( previousPipeline );
   *
   * Correct for a scene that loads once. This is a sixty-kilometre city that
   * streams: drive a few blocks, a tile is evicted, the last user of `foliage`
   * goes with it, the pipeline is freed -- and the next tile with a tree in it
   * compiles the identical shader again. The owner's numbers are the signature:
   * 2,314 compiles across **94 distinct keys**, the count climbing with
   * distance travelled while the key count sits still, and the shadow pass
   * worst of all because shadow-casting instanced meshes cycle with every tile.
   * It is not a warm-up that never finishes; it is a cache being thrown away
   * and rebuilt several hundred times between here and Parramatta.
   *
   * So each pipeline is pinned once, on creation: one extra reference on it and
   * on both its programs, which makes the release test bottom out at one and
   * never fire. The cost is ~90 pipelines resident for the session, which is
   * nothing; the saving is every recompile after the first.
   */
  private readonly pinned = new Set<unknown>();

  get skipped(): number {
    return this.skippedDraws;
  }

  get compiles(): number {
    return this.started;
  }

  /**
   * Hold one reference to a pipeline forever, so three never frees it.
   *
   * Once per pipeline object, tracked in a set: the counter is decremented on
   * every `getForRender` that had a previous pipeline, so a second pin would
   * only raise the floor and a missing pin would let the floor reach zero. The
   * programs are pinned too, because `_releaseProgram` runs off their own
   * counts and a released program invalidates the stage ids the pipeline key is
   * built from -- which puts us straight back to recompiling.
   */
  private pin(pipeline: unknown): void {
    if (pipeline === null || pipeline === undefined || this.pinned.has(pipeline)) return;
    this.pinned.add(pipeline);
    const p = pipeline as {
      usedTimes?: number;
      vertexProgram?: { usedTimes?: number };
      fragmentProgram?: { usedTimes?: number };
    };
    if (typeof p.usedTimes === 'number') p.usedTimes++;
    if (p.vertexProgram !== undefined && typeof p.vertexProgram.usedTimes === 'number') {
      p.vertexProgram.usedTimes++;
    }
    if (p.fragmentProgram !== undefined && typeof p.fragmentProgram.usedTimes === 'number') {
      p.fragmentProgram.usedTimes++;
    }
  }

  /** How many distinct pipelines are held. A streaming client plateaus here. */
  get resident(): number {
    return this.pinned.size;
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
      }
      this.pin(pipeline);
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

  // --- The pin: three must not be able to free a pipeline this client built.
  {
    const pipe = { usedTimes: 1, vertexProgram: { usedTimes: 1 }, fragmentProgram: { usedTimes: 1 } };
    const g = new AsyncPipelines();
    const inner = {
      getForRender: (_ro: unknown, promises?: unknown) => {
        if (Array.isArray(promises)) promises.push(Promise.resolve());
        return pipe;
      },
    };
    g.install({ _pipelines: inner, backend: { draw: () => {}, get: () => ({}) } });
    inner.getForRender({}, null);
    if (pipe.usedTimes !== 2) {
      failures.push(
        'a new pipeline was not pinned: three frees it when the last tile using it is evicted,' +
          ' and the next tile compiles the identical shader again -- which is the whole stall',
      );
    }
    inner.getForRender({}, null);
    if (pipe.usedTimes !== 2) failures.push('the same pipeline was pinned twice; the floor would drift.');
    if (pipe.vertexProgram.usedTimes !== 2 || pipe.fragmentProgram.usedTimes !== 2) {
      failures.push('the programs were not pinned; a released program invalidates the pipeline key.');
    }
    if (g.resident !== 1) failures.push(`resident reported ${g.resident}, expected 1.`);
  }

  // An object with no pipeline at all is not this gate's business either.
  backend.draw({}, null);
  if (drawn.length !== 3) failures.push('an object with no pipeline was swallowed.');
  return failures;
}
