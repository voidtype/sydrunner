/**
 * Giving back the pipelines an evicted tile leaves behind.
 *
 * A five-minute drive across Sydney ended with 8,183 live render pipelines,
 * `ShadowMaterial[inst] x3336` among them, and a tab that had been in the
 * background for a minute came back to a dead WebGPU device and a game that
 * stopped without saying anything. Those two facts are the same fact, and this
 * file is why.
 *
 * ## What leaks, and why it is nobody's fault
 *
 * Three's WebGPU backend caches one `RenderObject` per (object, material,
 * render context, lights) tuple, and each one owns a pipeline, a bind group and
 * a compiled node graph. It is released in exactly one way: `RenderObject`
 * subscribes to its **material's** `dispose` event, and that is the only thing
 * that fires `onDispose` and unhooks the pipeline --
 * `RenderObject.js` wires it, `RenderObjects.createRenderObject` defines what it
 * does, and `Pipelines.delete` is where the reference count finally drops.
 * Geometry's dispose event is handled too, but all it does is drop the cached
 * attribute list; the render object itself survives it.
 *
 * Our tiles do the correct thing and are punished for it. `releaseGroupGeometry`
 * frees each tile's geometry and each `InstancedMesh`'s instance buffers, and it
 * deliberately does **not** touch the materials, because six materials are
 * shared by the whole world and disposing one would blank every other tile.
 * So the tile's meshes are detached, their buffers are gone -- and their render
 * objects are still in three's chain map, still holding a pipeline, still
 * holding a `dispose` listener on the shared material they will never hear from.
 *
 * Then the cache key makes it unbounded rather than merely untidy. Three appends
 * `object.uuid` to the material cache key for every `InstancedMesh` (its own TODO
 * points at three.js#29066), so two tiles' trees are never the same render
 * object even though they are the same species drawn with the same material.
 * One leaked pipeline per instanced mesh per tile, for every tile the player has
 * ever driven through, for the length of the session. Nothing evicts it, because
 * from three's point of view nothing has been disposed.
 *
 * ## What this does
 *
 * It watches `RenderObjects.createRenderObject`, which three calls exactly once
 * per render object and never on a cache hit -- so the bookkeeping costs nothing
 * on the draw path, which matters when the draw path is fifteen thousand calls a
 * frame. It records object -> render objects. When the streamer evicts a tile it
 * hands the group over, and three frames later the render objects for those
 * meshes are disposed properly, through three's own `dispose`, which decrements
 * the pipeline's use count, releases the vertex and fragment programs when they
 * reach zero, drops the bind group and the node state, removes the entry from
 * the chain map, and unhooks the listener from the shared material.
 *
 * ## Why three frames, and why detachment is checked twice
 *
 * Disposing a render object frees its binding buffers, and a pipeline being
 * built by `createRenderPipelineAsync` for that same object will happily submit
 * against them afterwards: `[Buffer "bindingBuffer10952..."] used in submit while
 * destroyed` is what that looks like, and it is how an earlier version of the
 * compile gate killed a session after thirty seconds. An evicted tile is not
 * being drawn, so nothing new can start; the delay covers what was already in
 * flight when it went. Three frames is 50 ms at 60 Hz and 100 ms on the kind of
 * machine that needs this most.
 *
 * The detachment check is the other half. A tile can be evicted and stream back
 * before the queue drains -- a player reversing over a boundary does exactly
 * that -- and disposing a render object for a mesh that is on screen would blank
 * it until three rebuilt it. So every mesh is asked, at the moment of disposal,
 * whether it can still reach a scene through its parents. If it can, it is
 * dropped from the queue untouched.
 *
 * Nothing here imports three. It is written against the shape of the objects
 * rather than their classes, which is what lets the whole thing be checked on
 * the server's boot list with plain literals standing in for the renderer.
 */

/** The shape of an `Object3D` this file needs: a parent chain and children. */
export interface ReclaimObject {
  parent?: ReclaimObject | null;
  children?: ReclaimObject[];
  isMesh?: boolean;
  isScene?: boolean;
}

/** The shape of a three `RenderObject`: something with a `dispose`. */
export interface ReclaimRenderObject {
  dispose: () => void;
}

/** The shape of the renderer this installs onto. */
export interface ReclaimHost {
  _objects?: {
    createRenderObject?: (...args: unknown[]) => unknown;
  };
}

/**
 * How long an evicted tile keeps its pipelines before they are given back.
 *
 * **This replaced a three-frame delay, and the story is worth keeping.** The
 * first version waited three frames on the reasoning that nothing could still
 * be in flight by then. A ride disproved it:
 *
 *     Async render pipeline creation failed (renderPipeline_street_furniture_108):
 *     [Buffer "bindingBuffer9640_render_(vertex,fragment,compute)"] used in
 *     submit while destroyed.
 *
 * Three frames is 75 ms at the 40 fps that ride was getting, and the same log
 * has frames of 3,105 ms in it. A frame count is not a clock, and it was never
 * the right question anyway -- `AsyncPipelines.isBuilding` answers the real one
 * exactly, and this queue now asks it before every disposal.
 *
 * Given a correct guard, the delay is free to be about something else, and
 * twenty seconds buys the thing the three-frame version was actively costing:
 * **a tile you come back to still has its pipelines.** Riding a bike along a
 * street and turning round crosses the same boundary twice in a few seconds,
 * and the first version threw the pipelines away on the way out and rebuilt
 * every one of them on the way back -- paying the most expensive thing in this
 * renderer, twice, for nothing. Twenty seconds is long enough that ordinary
 * doubling back is free and short enough that a session cannot accumulate a
 * city.
 */
export const RETIRE_GRACE_MS = 20_000;

/**
 * Retired render objects held before the grace period stops being honoured.
 *
 * The grace above is a cache, and a cache with no size is the leak this file
 * was written to end wearing a longer name. Past this many waiting, the oldest
 * go early -- memory pressure is what loses the device, and a recompile is only
 * a stutter. The busy guard is *not* waived by this, ever: that one is a crash.
 */
export const MAX_PENDING = 2_500;

/**
 * Disposals allowed in one frame.
 *
 * A teleport evicts every resident tile at once -- 58 of them at the streaming
 * radius, each with a dozen instanced meshes and two passes apiece, which
 * measured as a queue 2,189 deep -- and doing all of that in the frame it comes
 * due would be a stall of exactly the kind the compile budget exists to
 * prevent. The queue is drained at a rate instead.
 *
 * 256 rather than the 96 this shipped with, because the cost was measured
 * rather than guessed: draining 96 costs 0.1-0.4 ms against a live client on
 * the box. It is map deletes and a reference count, not GPU work.
 */
export const MAX_DISPOSE_PER_FRAME = 256;

/**
 * Can this object still be reached from a scene through its parents?
 *
 * Exported because it is the whole of the safety argument for disposing
 * anything, and it is three lines of pointer-walking that would otherwise be
 * checked by reading them. The loop is bounded rather than `while (true)`:
 * a parent cycle is not supposed to exist, and if one ever does it should not
 * take the frame with it.
 */
export function attachedToScene(o: ReclaimObject | null | undefined): boolean {
  let node: ReclaimObject | null | undefined = o;
  for (let hops = 0; hops < 64 && node !== null && node !== undefined; hops++) {
    if (node.isScene === true) return true;
    node = node.parent;
  }
  return false;
}

/** One mesh waiting to have its render objects disposed. */
interface Pending {
  mesh: ReclaimObject;
  /** When it was evicted, on the caller's clock. */
  atMs: number;
}

/**
 * The reclaimer.
 *
 * Install it on the renderer once, hand it every group the streamer evicts, and
 * call `frame()` once per frame from the animation loop.
 */
export class PipelineReclaim {
  /** Every render object three has built for a given object, while it lives. */
  private readonly byObject = new WeakMap<ReclaimObject, Set<ReclaimRenderObject>>();
  /** Meshes retired but not yet due, oldest first. */
  private queue: Pending[] = [];
  /** Already queued, so a double eviction cannot queue a mesh twice. */
  private readonly queued = new WeakSet<ReclaimObject>();
  /** The clock, and the only reason this file is testable. */
  private nowMs = 0;
  /**
   * Asks whether a pipeline is still being built for a render object.
   *
   * Null until `main.ts` wires `AsyncPipelines.isBuilding` in. **A reclaimer
   * with no probe disposes nothing**, which is the only safe default: the
   * alternative is freeing binding buffers under live pipeline creation, which
   * is precisely the crash this guard exists for.
   */
  private busy: ((renderObject: ReclaimRenderObject) => boolean) | null = null;
  /**
   * Asks whether a render object was ever actually drawn.
   *
   * **The second crash, and the subtler one.** `Bindings.deleteForRender`
   * decrements a bind group's `usedTimes` unconditionally, but `_createBindings`
   * only *increments* it for a render object that reached `getForRender` -- and
   * bind groups are shared, so the count is what keeps a uniform buffer alive
   * for everyone using it.
   *
   * The compile gate one file over declines draws by the thousand (`6250
   * deferred` in the ride that produced this), and a declined draw never runs
   * `updateForRender`, so its render object exists with bindings that were
   * never initialised. Disposing one of those takes a reference it never held.
   * The count reaches zero with live objects still pointing at the buffer, and
   * the next frame to touch it says:
   *
   *     Failed to execute 'writeBuffer' on 'GPUQueue': parameter 1 is not of
   *     type 'GPUBuffer'.
   *
   * -- from `Bindings._update`, on somebody else's render object entirely.
   * Which is why the screen went black rather than one thing disappearing.
   *
   * The happy part: a render object that never drew holds **no pipeline and no
   * bindings**, both of which are created inside the same `updateForRender` it
   * never reached. There is nothing to reclaim from it, so skipping it costs
   * exactly nothing and is not a compromise.
   */
  private drawn: ((renderObject: ReclaimRenderObject) => boolean) | null = null;

  /** Render objects successfully disposed. */
  reclaimed = 0;
  /** Meshes handed over by the streamer. */
  retired = 0;
  /** Meshes that had come back by the time they were due, and were left alone. */
  spared = 0;
  /** Disposals held back because a pipeline was still being built. */
  heldBusy = 0;
  /** Render objects dropped un-disposed because they never drew, so held nothing. */
  undrawn = 0;
  /** Disposals taken early because the queue was over `MAX_PENDING`. */
  forced = 0;
  /** Disposals that threw. Never zero silently -- it goes on the frame line. */
  failed = 0;
  /** True once `install` has taken. */
  installed = false;

  /**
   * Wrap `RenderObjects.createRenderObject`.
   *
   * Returns false rather than throwing when the renderer is not the shape this
   * expects, because a three upgrade that moves this is a reason to lose the
   * reclaim, not a reason to lose the client. The caller says so on the boot
   * line and the game runs exactly as it did before this file existed.
   */
  /**
   * Wire the in-flight probe. Until this is called nothing is ever disposed.
   */
  setBusyProbe(probe: (renderObject: ReclaimRenderObject) => boolean): void {
    this.busy = probe;
  }

  /**
   * Wire the was-it-drawn probe. Until this is called nothing is ever disposed.
   *
   * Same safe default as the busy probe and for a sharper reason: without it
   * every declined draw's render object looks disposable, and disposing those
   * is what destroys other objects' uniform buffers. See `drawn`.
   */
  setDrawnProbe(probe: (renderObject: ReclaimRenderObject) => boolean): void {
    this.drawn = probe;
  }

  install(host: ReclaimHost): boolean {
    const objects = host._objects;
    if (objects === undefined || objects === null) return false;
    const inner = objects.createRenderObject;
    if (typeof inner !== 'function') return false;
    const self = this;
    objects.createRenderObject = function (this: unknown, ...args: unknown[]): unknown {
      const ro = inner.apply(this, args) as unknown;
      // Argument 3 is the `Object3D`; see `RenderObjects.createRenderObject`.
      const obj = args[3];
      if (
        typeof obj === 'object' &&
        obj !== null &&
        typeof ro === 'object' &&
        ro !== null &&
        typeof (ro as ReclaimRenderObject).dispose === 'function'
      ) {
        const key = obj as ReclaimObject;
        let set = self.byObject.get(key);
        if (set === undefined) {
          set = new Set<ReclaimRenderObject>();
          self.byObject.set(key, set);
        }
        set.add(ro as ReclaimRenderObject);
      }
      return ro;
    };
    this.installed = true;
    return true;
  }

  /**
   * Take an evicted tile's group.
   *
   * Walks one level, which is what a tile group is: the streamer's meshes are
   * its direct children. Called from `releaseGroupGeometry`, the single path
   * both eviction sites already share, so a future third way to drop a tile
   * gets this for free.
   */
  retire(group: ReclaimObject | null | undefined): void {
    if (group === null || group === undefined) return;
    const kids = group.children;
    if (kids === undefined) return;
    for (const child of kids) {
      if (child.isMesh !== true) continue;
      if (this.queued.has(child)) continue;
      this.queued.add(child);
      this.queue.push({ mesh: child, atMs: this.nowMs });
      this.retired++;
    }
  }

  /**
   * One frame. Call it at the top, before anything renders.
   *
   * Three things have to be true before a render object is disposed, and they
   * are three different questions:
   *
   * - **Is it still on screen?** A tile can be evicted and stream back inside
   *   the grace period -- a player reversing over a boundary does exactly that
   *   -- and disposing a mesh that is drawn again would blank it.
   * - **Is anything still building for it?** The one that crashed a ride. See
   *   `RETIRE_GRACE_MS`; a frame count could never answer this and
   *   `AsyncPipelines.isBuilding` answers it exactly.
   * - **Has it waited long enough?** Only to save the recompile when a player
   *   doubles back, and the only one of the three that pressure may waive.
   */
  frame(nowMs: number): void {
    this.nowMs = nowMs;
    if (this.queue.length === 0) return;
    // Past this depth the grace stops being a kindness and starts being the
    // leak again. The busy guard is never waived; that one is a crash.
    const pressed = this.queue.length > MAX_PENDING;
    let budget = MAX_DISPOSE_PER_FRAME;
    const keep: Pending[] = [];
    for (const entry of this.queue) {
      if (budget <= 0) {
        keep.push(entry);
        continue;
      }
      if (!pressed && nowMs - entry.atMs < RETIRE_GRACE_MS) {
        keep.push(entry);
        continue;
      }
      // It came back. Drop it from the queue entirely and leave it alone.
      if (attachedToScene(entry.mesh)) {
        this.queued.delete(entry.mesh);
        this.spared++;
        continue;
      }
      const set = this.byObject.get(entry.mesh);
      if (set === undefined) {
        this.queued.delete(entry.mesh);
        continue;
      }
      // **No probes, no disposal.** A reclaimer that cannot ask whether a
      // pipeline is in flight, or whether the object ever drew, must not free
      // anything: one of those questions guards a destroyed buffer in a live
      // submit, and the other guards a shared uniform buffer's reference count.
      const busyProbe = this.busy;
      const drawnProbe = this.drawn;
      if (busyProbe === null || drawnProbe === null) {
        keep.push(entry);
        continue;
      }
      let building = false;
      let anyDrawn = false;
      for (const ro of set) {
        try {
          if (drawnProbe(ro)) anyDrawn = true;
          if (busyProbe(ro)) {
            building = true;
            break;
          }
        } catch {
          // A probe that throws is a probe that cannot clear this object.
          building = true;
          break;
        }
      }
      if (building) {
        this.heldBusy++;
        keep.push(entry);
        continue;
      }
      this.queued.delete(entry.mesh);
      this.byObject.delete(entry.mesh);
      // Never drawn, so it holds no pipeline and no bindings -- and disposing
      // it would take a bind-group reference it never took. Drop it untouched.
      if (!anyDrawn) {
        this.undrawn++;
        continue;
      }
      if (pressed) this.forced++;
      for (const ro of set) {
        // Per render object, because a mesh's colour pass can have drawn while
        // its shadow pass was declined, and only the one that drew owns
        // anything worth giving back.
        let everDrew = false;
        try {
          everDrew = drawnProbe(ro);
        } catch {
          everDrew = false;
        }
        if (!everDrew) {
          this.undrawn++;
          continue;
        }
        budget--;
        try {
          ro.dispose();
          this.reclaimed++;
        } catch {
          // A dispose that throws is a leaked pipeline, which is the state we
          // were in before this file. It is never a reason to drop the frame.
          this.failed++;
        }
      }
    }
    this.queue = keep;
  }

  /** How many meshes are waiting. */
  get pending(): number {
    return this.queue.length;
  }

  /** One clause for the frame line. */
  state(): string {
    if (!this.installed) return 'reclaim off';
    if (this.busy === null || this.drawn === null) return `reclaim unprobed, ${this.pending} queued`;
    return (
      `reclaim ${this.reclaimed} freed, ${this.pending} queued` +
      (this.spared > 0 ? `, ${this.spared} spared` : '') +
      (this.heldBusy > 0 ? `, ${this.heldBusy} held` : '') +
      (this.undrawn > 0 ? `, ${this.undrawn} undrawn` : '') +
      (this.forced > 0 ? `, ${this.forced} forced` : '') +
      (this.failed > 0 ? `, ${this.failed} FAILED` : '')
    );
  }
}

/**
 * The one installed on the renderer, for the streamer to reach without being
 * handed one.
 *
 * A module-level handle rather than a constructor argument because the
 * alternative is threading a renderer-shaped dependency through `TileStreamer`,
 * its two eviction sites and the free function they share, to reach two lines.
 * The indirection is a `null` check; the coupling it avoids is four signatures.
 */
let active: PipelineReclaim | null = null;

/** Install (or, with `null`, remove) the reclaimer the streamer talks to. */
export function setActiveReclaim(r: PipelineReclaim | null): void {
  active = r;
}

/** Hand an evicted group over, if anything is listening. */
export function retireGroup(group: ReclaimObject | null | undefined): void {
  if (active !== null) active.retire(group);
}

/**
 * Self-check. On both boot lists.
 *
 * Everything here is duck-typed: a "render object" is `{ dispose }` and a
 * "mesh" is `{ isMesh, parent }`, which is the whole reason this file does not
 * import three and the whole reason the server can run these. The clock is a
 * number the caller passes in, so every wait below is exact rather than timed.
 */
export function verifyPipeReclaim(): string[] {
  const failures: string[] = [];

  const mk = (): { ro: ReclaimRenderObject; disposed: () => number } => {
    let n = 0;
    return { ro: { dispose: (): void => { n++; } }, disposed: (): number => n };
  };
  /**
   * A reclaimer with nothing in flight and everything drawn: the ordinary case,
   * and the one every block below wants unless it says otherwise.
   */
  const idle = (r: PipelineReclaim): void => {
    r.setBusyProbe(() => false);
    r.setDrawnProbe(() => true);
  };
  const put = (r: PipelineReclaim, mesh: ReclaimObject, ros: ReclaimRenderObject[]): void => {
    (r as unknown as { byObject: WeakMap<ReclaimObject, Set<ReclaimRenderObject>> }).byObject.set(mesh, new Set(ros));
  };

  // --- The shape of the leak, and that this closes it.
  {
    const scene: ReclaimObject = { isScene: true, children: [] };
    const group: ReclaimObject = { parent: scene, children: [] };
    const colour = mk();
    const shadow = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];

    const r = new PipelineReclaim();
    idle(r);
    const host: ReclaimHost = { _objects: { createRenderObject: (): unknown => colour.ro } };
    if (!r.install(host)) failures.push('the reclaimer did not install on a renderer that has `_objects`.');
    (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(0, 0, 0, mesh);
    // Three builds the shadow pass as a separate render object for the same mesh.
    put(r, mesh, [colour.ro, shadow.ro]);

    r.frame(0);
    group.parent = null;
    r.retire(group);
    if (r.retired !== 1) failures.push(`retiring a group of one mesh queued ${r.retired}.`);

    r.frame(RETIRE_GRACE_MS - 1);
    if (colour.disposed() !== 0) {
      failures.push('a render object was disposed inside the grace period; a tile you doubled back to would recompile.');
    }
    r.frame(RETIRE_GRACE_MS + 1);
    if (colour.disposed() !== 1) failures.push(`the colour-pass render object was disposed ${colour.disposed()} times, not once.`);
    if (shadow.disposed() !== 1) failures.push('the shadow-pass render object was not disposed; a mesh has one per pass and both leak.');
    if (r.reclaimed !== 2) failures.push(`reclaimed ${r.reclaimed} render objects for a mesh that had two.`);
    if (r.pending !== 0) failures.push(`${r.pending} meshes still queued after the queue drained.`);
  }

  // --- **A pipeline still being built is never freed under.**
  //
  // The one that crashed a real ride: `[Buffer "bindingBuffer9640..."] used in
  // submit while destroyed`, from an async creation that outlived a three-frame
  // delay. No amount of waiting substitutes for asking.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    let inFlight = true;
    r.setBusyProbe(() => inFlight);
    r.setDrawnProbe(() => true);
    put(r, mesh, [a.ro]);
    r.retire(group);
    for (let t = 0; t <= RETIRE_GRACE_MS * 20; t += RETIRE_GRACE_MS) r.frame(t);
    if (a.disposed() !== 0) {
      failures.push('a render object was disposed while a pipeline was still being built for it; that is the crash this guard exists for.');
    }
    if (r.heldBusy === 0) failures.push('a busy render object was not counted as held.');
    inFlight = false;
    r.frame(RETIRE_GRACE_MS * 21);
    if (a.disposed() !== 1) failures.push('a render object was never freed after its build finished; the leak would come back.');
  }

  // --- **A render object that never drew is never disposed.**
  //
  // The second crash, and the one that blacked the screen out:
  // `writeBuffer: parameter 1 is not of type 'GPUBuffer'`, thrown from
  // `Bindings._update` on a render object we never touched.
  // `Bindings.deleteForRender` decrements a shared bind group's `usedTimes`
  // unconditionally; `_createBindings` only increments it for an object that
  // reached `getForRender`. The compile gate declines thousands of draws, each
  // leaving a render object whose bindings were never initialised, and
  // disposing one takes a reference it never held -- so a uniform buffer other
  // objects are still using is destroyed under them.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const never = mk();
    const drew = mk();
    const meshA: ReclaimObject = { isMesh: true, parent: group };
    const meshB: ReclaimObject = { isMesh: true, parent: group };
    group.children = [meshA, meshB];
    const r = new PipelineReclaim();
    r.setBusyProbe(() => false);
    r.setDrawnProbe((ro) => ro === drew.ro);
    put(r, meshA, [never.ro]);
    put(r, meshB, [drew.ro]);
    r.retire(group);
    r.frame(RETIRE_GRACE_MS + 1);
    if (never.disposed() !== 0) {
      failures.push('a render object that never drew was disposed; that decrements a bind group it never took a reference to, and destroys a live uniform buffer.');
    }
    if (drew.disposed() !== 1) failures.push('a render object that did draw was not reclaimed; the leak would come back.');
    if (r.undrawn === 0) failures.push('an undrawn render object was not counted.');
  }

  // --- One mesh, one pass drawn and one declined.
  //
  // The ordinary case in a real frame: the colour pass drew and the shadow pass
  // was declined by the budget. Only the one that drew owns anything.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const colour = mk();
    const shadow = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    r.setBusyProbe(() => false);
    r.setDrawnProbe((ro) => ro === colour.ro);
    put(r, mesh, [colour.ro, shadow.ro]);
    r.retire(group);
    r.frame(RETIRE_GRACE_MS + 1);
    if (colour.disposed() !== 1) failures.push('the drawn pass of a half-drawn mesh was not reclaimed.');
    if (shadow.disposed() !== 0) {
      failures.push('the declined pass of a half-drawn mesh was disposed; per-mesh is not a fine enough grain for this guard.');
    }
  }

  // --- No drawn probe, nothing disposed.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    r.install({ _objects: { createRenderObject: (): unknown => a.ro } });
    r.setBusyProbe(() => false);                   // busy wired, drawn deliberately not
    put(r, mesh, [a.ro]);
    r.retire(group);
    r.frame(RETIRE_GRACE_MS * 10);
    if (a.disposed() !== 0) failures.push('a reclaimer with no drawn probe disposed something anyway.');
    if (!r.state().includes('unprobed')) failures.push(`a half-probed reclaimer reported "${r.state()}" and did not say so.`);
  }

  // --- Pressure waives the grace. It never waives the busy guard.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const kids: ReclaimObject[] = [];
    const r = new PipelineReclaim();
    idle(r);
    const total = MAX_PENDING + 40;
    for (let i = 0; i < total; i++) {
      const m = mk();
      const mesh: ReclaimObject = { isMesh: true, parent: group };
      kids.push(mesh);
      put(r, mesh, [m.ro]);
    }
    group.children = kids;
    r.retire(group);
    r.frame(1);
    if (r.reclaimed === 0) failures.push('a queue over MAX_PENDING froze behind the grace period; the grace is a cache with no size.');
    if (r.reclaimed > MAX_DISPOSE_PER_FRAME) {
      failures.push(`one frame disposed ${r.reclaimed}, over the cap of ${MAX_DISPOSE_PER_FRAME}; a teleport would stall.`);
    }
    if (r.forced === 0) failures.push('an early disposal under pressure was not counted as forced.');

    const r2 = new PipelineReclaim();
    r2.setBusyProbe(() => true);
    r2.setDrawnProbe(() => true);
    const g2: ReclaimObject = { parent: null, children: [] };
    const k2: ReclaimObject[] = [];
    for (let i = 0; i < total; i++) {
      const m = mk();
      const mesh: ReclaimObject = { isMesh: true, parent: g2 };
      k2.push(mesh);
      put(r2, mesh, [m.ro]);
    }
    g2.children = k2;
    r2.retire(g2);
    r2.frame(1);
    if (r2.reclaimed !== 0) failures.push('pressure waived the busy guard; that trades a stutter for a crash.');
  }

  // --- No probe wired, nothing disposed.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();               // installed, but deliberately no setBusyProbe
    r.install({ _objects: { createRenderObject: (): unknown => a.ro } });
    put(r, mesh, [a.ro]);
    r.retire(group);
    r.frame(RETIRE_GRACE_MS * 10);
    if (a.disposed() !== 0) failures.push('a reclaimer with no in-flight probe disposed something anyway.');
    if (!r.state().includes('unprobed')) failures.push(`an unprobed reclaimer reported "${r.state()}" and did not say so.`);
  }

  // --- A tile that comes back inside the grace is left alone.
  {
    const scene: ReclaimObject = { isScene: true, children: [] };
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    idle(r);
    put(r, mesh, [a.ro]);
    r.retire(group);
    group.parent = scene;
    r.frame(RETIRE_GRACE_MS + 1);
    if (a.disposed() !== 0) failures.push('a mesh that was back in the scene was disposed anyway; it would have gone blank.');
    if (r.spared !== 1) failures.push(`a returned mesh was not counted as spared (${r.spared}).`);
    if (r.pending !== 0) failures.push('a spared mesh stayed in the queue.');
  }

  // --- Detachment is the parent chain, not the immediate parent.
  {
    const scene: ReclaimObject = { isScene: true };
    const live: ReclaimObject = { parent: { parent: { parent: scene } } };
    if (!attachedToScene(live)) failures.push('a mesh three levels under the scene was called detached; nothing would ever be reclaimed.');
    const dead: ReclaimObject = { parent: { parent: { parent: null } } };
    if (attachedToScene(dead)) failures.push('a mesh whose chain ends in null was called attached; nothing would ever be reclaimed.');
    if (attachedToScene(null)) failures.push('null was called attached.');
    const x: ReclaimObject = {};
    const y: ReclaimObject = { parent: x };
    x.parent = y;
    if (attachedToScene(x)) failures.push('a parent cycle reported a scene that is not there.');
  }

  // --- A dispose that throws costs a pipeline, never the frame.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    idle(r);
    put(r, mesh, [{ dispose: (): void => { throw new Error('gpu gone'); } }]);
    r.retire(group);
    let threw = false;
    try {
      r.frame(RETIRE_GRACE_MS + 1);
    } catch {
      threw = true;
    }
    if (threw) failures.push('a render object whose dispose threw took the frame with it.');
    if (r.failed !== 1) failures.push(`a throwing dispose was not counted (${r.failed}); it would leak in silence.`);
  }

  // --- A probe that throws is treated as busy, not as clear.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    r.setBusyProbe(() => { throw new Error('gate gone'); });
    r.setDrawnProbe(() => true);
    put(r, mesh, [a.ro]);
    r.retire(group);
    r.frame(RETIRE_GRACE_MS + 1);
    if (a.disposed() !== 0) failures.push('a probe that threw was read as "not building" and the object was freed anyway.');
  }

  // --- Double eviction does not queue a mesh twice.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    idle(r);
    r.retire(group);
    r.retire(group);
    if (r.pending !== 1) failures.push(`the same mesh queued ${r.pending} times; its render objects would be disposed twice.`);
  }

  // --- Groups with no meshes, and a renderer of the wrong shape.
  {
    const r = new PipelineReclaim();
    idle(r);
    r.retire(null);
    r.retire({ children: undefined });
    r.retire({ children: [{ isMesh: false }] });
    if (r.pending !== 0) failures.push('a group with nothing drawable in it queued something.');
    if (r.install({})) failures.push('the reclaimer claimed to install on a renderer with no `_objects`.');
    if (r.install({ _objects: {} })) failures.push('the reclaimer claimed to install with no `createRenderObject` to wrap.');
    if (r.state() !== 'reclaim off') failures.push(`an uninstalled reclaimer reported "${r.state()}".`);
    r.frame(0);
  }

  // --- The wrapper returns what three returns, and records nothing odd.
  {
    const r = new PipelineReclaim();
    const sentinel = { dispose: (): void => {} };
    let sawArgs: unknown[] = [];
    const host: ReclaimHost = {
      _objects: {
        createRenderObject: (...args: unknown[]): unknown => {
          sawArgs = args;
          return sentinel;
        },
      },
    };
    r.install(host);
    const got = (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(1, 2, 3, { isMesh: true }, 5);
    if (got !== sentinel) failures.push("the wrapper did not return three's own render object; every draw would break.");
    if (sawArgs.length !== 5) failures.push(`the wrapper passed ${sawArgs.length} of 5 arguments through.`);
    (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(1, 2, 3, null, 5);
  }

  return failures;
}
