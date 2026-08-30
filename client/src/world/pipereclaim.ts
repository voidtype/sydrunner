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
 * Frames between an eviction and the disposal it causes.
 *
 * See the header: this is the window in which a pipeline already being built
 * asynchronously for a mesh that has just gone can still submit against buffers
 * this would otherwise have freed underneath it.
 */
export const RETIRE_DELAY_FRAMES = 3;

/**
 * Disposals allowed in one frame.
 *
 * A teleport evicts every resident tile at once -- 49 of them at the streaming
 * radius, each with a dozen instanced meshes and two passes apiece -- and doing
 * all of that in the frame it comes due would be a stall of exactly the kind
 * the compile budget exists to prevent. The queue is drained at a rate instead,
 * and a backlog simply takes a few more frames to clear.
 */
export const MAX_DISPOSE_PER_FRAME = 96;

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
  dueFrame: number;
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
  /** Meshes retired but not yet due. */
  private queue: Pending[] = [];
  /** Already queued, so a double eviction cannot queue a mesh twice. */
  private readonly queued = new WeakSet<ReclaimObject>();
  private frameNo = 0;

  /** Render objects successfully disposed. */
  reclaimed = 0;
  /** Meshes handed over by the streamer. */
  retired = 0;
  /** Meshes that had come back by the time they were due, and were left alone. */
  spared = 0;
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
    const due = this.frameNo + RETIRE_DELAY_FRAMES;
    for (const child of kids) {
      if (child.isMesh !== true) continue;
      if (this.queued.has(child)) continue;
      this.queued.add(child);
      this.queue.push({ mesh: child, dueFrame: due });
      this.retired++;
    }
  }

  /**
   * One frame. Drains whatever has come due, up to the per-frame cap.
   *
   * Call it at the top of the frame, before anything renders: the point of the
   * delay is that nothing is mid-submission, and the top of a frame is the only
   * moment that is reliably true.
   */
  frame(): void {
    this.frameNo++;
    if (this.queue.length === 0) return;
    let budget = MAX_DISPOSE_PER_FRAME;
    const keep: Pending[] = [];
    for (const entry of this.queue) {
      if (budget <= 0 || entry.dueFrame > this.frameNo) {
        keep.push(entry);
        continue;
      }
      this.queued.delete(entry.mesh);
      // It came back. Leave it entirely alone -- it is on screen.
      if (attachedToScene(entry.mesh)) {
        this.spared++;
        continue;
      }
      const set = this.byObject.get(entry.mesh);
      if (set === undefined) continue;
      this.byObject.delete(entry.mesh);
      for (const ro of set) {
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
    return (
      `reclaim ${this.reclaimed} freed, ${this.pending} queued` +
      (this.spared > 0 ? `, ${this.spared} spared` : '') +
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
 * import three and the whole reason the server can run these.
 */
export function verifyPipeReclaim(): string[] {
  const failures: string[] = [];

  const mk = (): { ro: ReclaimRenderObject; disposed: () => number } => {
    let n = 0;
    return { ro: { dispose: (): void => { n++; } }, disposed: (): number => n };
  };

  // --- The shape of the leak, and that this closes it.
  {
    const scene: ReclaimObject = { isScene: true, children: [] };
    const group: ReclaimObject = { parent: scene, children: [] };
    const a = mk();
    const b = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];

    const r = new PipelineReclaim();
    const host: ReclaimHost = {
      _objects: {
        createRenderObject: (...args: unknown[]): unknown => (args[3] === mesh ? a.ro : b.ro),
      },
    };
    if (!r.install(host)) failures.push('the reclaimer did not install on a renderer that has `_objects`.');
    // Three builds two render objects for it: the colour pass and the shadow.
    (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(0, 0, 0, mesh);
    const second = mk();
    const inner = host._objects as { createRenderObject: (...a: unknown[]) => unknown };
    // A second, different render object for the same mesh -- the shadow pass.
    const host2: ReclaimHost = { _objects: { createRenderObject: (): unknown => second.ro } };
    r.install(host2);
    (host2._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(0, 0, 0, mesh);
    void inner;

    // Evict: detached first, the way `TileStreamer.dispose` does it.
    group.parent = null;
    r.retire(group);
    if (r.retired !== 1) failures.push(`retiring a group of one mesh queued ${r.retired}.`);

    // Not yet. The whole point is that it is not yet.
    r.frame();
    if (a.disposed() !== 0) {
      failures.push('a render object was disposed on the frame of its eviction; an in-flight pipeline could still submit against it.');
    }
    for (let i = 0; i < RETIRE_DELAY_FRAMES; i++) r.frame();
    if (a.disposed() !== 1) failures.push(`after ${RETIRE_DELAY_FRAMES} frames the colour-pass render object was disposed ${a.disposed()} times, not once.`);
    if (second.disposed() !== 1) failures.push('the shadow-pass render object was not disposed; a mesh has one per pass and both leak.');
    if (r.reclaimed !== 2) failures.push(`reclaimed ${r.reclaimed} render objects for a mesh that had two.`);
    if (r.pending !== 0) failures.push(`${r.pending} meshes still queued after the queue drained.`);
  }

  // --- A tile that comes back before the queue drains is left alone.
  //
  // A player reversing over a tile boundary evicts and reloads inside three
  // frames. Disposing then would blank a mesh that is on screen.
  {
    const scene: ReclaimObject = { isScene: true, children: [] };
    const group: ReclaimObject = { parent: null, children: [] };
    const a = mk();
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    r.install({ _objects: { createRenderObject: (): unknown => a.ro } });
    (r as unknown as { byObject: WeakMap<ReclaimObject, Set<ReclaimRenderObject>> }).byObject.set(mesh, new Set([a.ro]));
    r.retire(group);
    group.parent = scene; // it came back
    for (let i = 0; i <= RETIRE_DELAY_FRAMES; i++) r.frame();
    if (a.disposed() !== 0) failures.push('a mesh that was back in the scene was disposed anyway; it would have gone blank.');
    if (r.spared !== 1) failures.push(`a returned mesh was not counted as spared (${r.spared}).`);
  }

  // --- Detachment is the parent chain, not the immediate parent.
  //
  // `releaseGroupGeometry` runs after `root.remove(group)`, so the mesh's own
  // parent is still the group and only the group is detached. A check that
  // looked one level up would refuse to ever free anything.
  {
    const scene: ReclaimObject = { isScene: true };
    const live: ReclaimObject = { parent: { parent: { parent: scene } } };
    if (!attachedToScene(live)) failures.push('a mesh three levels under the scene was called detached; nothing would ever be reclaimed.');
    const dead: ReclaimObject = { parent: { parent: { parent: null } } };
    if (attachedToScene(dead)) failures.push('a mesh whose chain ends in null was called attached; nothing would ever be reclaimed.');
    if (attachedToScene(null)) failures.push('null was called attached.');
    // A cycle must not hang the frame.
    const x: ReclaimObject = {};
    const y: ReclaimObject = { parent: x };
    x.parent = y;
    if (attachedToScene(x)) failures.push('a parent cycle reported a scene that is not there.');
  }

  // --- The per-frame cap holds, and the backlog still clears.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const kids: ReclaimObject[] = [];
    const counters: Array<() => number> = [];
    const r = new PipelineReclaim();
    const total = MAX_DISPOSE_PER_FRAME * 2 + 5;
    for (let i = 0; i < total; i++) {
      const m = mk();
      counters.push(m.disposed);
      const mesh: ReclaimObject = { isMesh: true, parent: group };
      kids.push(mesh);
      (r as unknown as { byObject: WeakMap<ReclaimObject, Set<ReclaimRenderObject>> }).byObject.set(mesh, new Set([m.ro]));
    }
    group.children = kids;
    r.retire(group);
    for (let i = 0; i < RETIRE_DELAY_FRAMES; i++) r.frame();
    if (r.reclaimed > MAX_DISPOSE_PER_FRAME) {
      failures.push(`one frame disposed ${r.reclaimed}, over the cap of ${MAX_DISPOSE_PER_FRAME}; a teleport would stall.`);
    }
    if (r.reclaimed === 0) failures.push('the capped drain freed nothing at all.');
    for (let i = 0; i < 6; i++) r.frame();
    if (r.pending !== 0) failures.push(`a backlog of ${total} did not clear in six further frames (${r.pending} left).`);
    if (r.reclaimed !== total) failures.push(`the backlog freed ${r.reclaimed} of ${total}.`);
    if (counters.some((c) => c() !== 1)) failures.push('a queued mesh was disposed other than exactly once.');
  }

  // --- A dispose that throws costs a pipeline, never the frame.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    (r as unknown as { byObject: WeakMap<ReclaimObject, Set<ReclaimRenderObject>> }).byObject.set(
      mesh,
      new Set([{ dispose: (): void => { throw new Error('gpu gone'); } }]),
    );
    r.retire(group);
    let threw = false;
    try {
      for (let i = 0; i <= RETIRE_DELAY_FRAMES; i++) r.frame();
    } catch {
      threw = true;
    }
    if (threw) failures.push('a render object whose dispose threw took the frame with it.');
    if (r.failed !== 1) failures.push(`a throwing dispose was not counted (${r.failed}); it would leak in silence.`);
  }

  // --- Double eviction does not queue a mesh twice.
  {
    const group: ReclaimObject = { parent: null, children: [] };
    const mesh: ReclaimObject = { isMesh: true, parent: group };
    group.children = [mesh];
    const r = new PipelineReclaim();
    r.retire(group);
    r.retire(group);
    if (r.pending !== 1) failures.push(`the same mesh queued ${r.pending} times; its render objects would be disposed twice.`);
  }

  // --- Groups with no meshes, and a renderer of the wrong shape.
  {
    const r = new PipelineReclaim();
    r.retire(null);
    r.retire({ children: undefined });
    r.retire({ children: [{ isMesh: false }] });
    if (r.pending !== 0) failures.push('a group with nothing drawable in it queued something.');
    if (r.install({})) failures.push('the reclaimer claimed to install on a renderer with no `_objects`.');
    if (r.install({ _objects: {} })) failures.push('the reclaimer claimed to install with no `createRenderObject` to wrap.');
    if (r.state() !== 'reclaim off') failures.push(`an uninstalled reclaimer reported "${r.state()}".`);
    // And it must still be safe to run frames on one that never installed.
    r.frame();
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
    const got = (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(
      1, 2, 3, { isMesh: true }, 5,
    );
    if (got !== sentinel) failures.push('the wrapper did not return three\'s own render object; every draw would break.');
    if (sawArgs.length !== 5) failures.push(`the wrapper passed ${sawArgs.length} of 5 arguments through.`);
    // A creation whose object argument is not an object must not throw.
    (host._objects as { createRenderObject: (...a: unknown[]) => unknown }).createRenderObject(1, 2, 3, null, 5);
  }

  return failures;
}
