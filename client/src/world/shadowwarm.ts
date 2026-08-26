/*
 * shadowwarm.ts -- the pass every warm-up in this client forgot.
 *
 * The turning stall survived three fixes because all three were aimed at the
 * beauty pass. The warm-up walked the tile, it cleared the frustum flags, it
 * bound the post pass's render target so the compile landed under the key the
 * frame looks up -- and the frame still stalled when the camera turned, and
 * still settled after a minute or two of driving around.
 *
 * The reason is one fact about three, and it is worth writing down because
 * nothing in the renderer's own documentation says it out loud:
 *
 *     `Renderer.compile()` walks the opaque and transparent render lists and
 *     nothing else. It never renders the shadow pass.
 *
 * The shadow pass is a second render, into a second target, of a *different
 * material*: `ShadowNode.updateShadow` resets the renderer state, sets
 * `scene.overrideMaterial` to a shared per-light `ShadowMaterial`, sets MRT to
 * null, binds the shadow map and renders the scene from the light. three keys a
 * pipeline on the render context, and the render context comes from the bound
 * target -- so every shadow-casting mesh in this world needs a *second*
 * pipeline that no warm-up here has ever built.
 *
 * It is not one pipeline either. `renderObject` copies the source material into
 * the override before the pipeline is made -- `_getShadowNodes(material)`,
 * `alphaTest`, `alphaMap`, `displacement*`, `side` -- so the shadow pipeline
 * varies per source material, exactly like the beauty one.
 *
 * So the missing compiles are paid on the frame a caster first enters the sun's
 * shadow frustum. The shadow camera tracks the player and the sun, which is why
 * this reads as "it happens when I turn", and why it goes quiet after a minute
 * or two: by then the common set is built.
 *
 * **How the rig is found.** Reaching into the node graph for the shadow map is
 * reaching into three's private state, and it would rot on the next release.
 * Instead this watches the door the renderer itself walks through: it wraps
 * `setRenderTarget` and notes the target bound while `scene.overrideMaterial`
 * is a shadow-pass material. That happens on the first frame that draws
 * shadows, and it is exactly the pair a warm needs. If the client ever runs
 * with shadows off, nothing is ever captured and every method here is a no-op.
 */

/** The subset of the renderer this needs. Kept narrow so a check can stub it. */
export interface ShadowWarmRenderer {
  setRenderTarget(target: unknown, ...rest: unknown[]): void;
  getRenderTarget(): unknown;
  setMRT(mrt: unknown): void;
  getMRT(): unknown;
}

/** The scene, seen only through the one field the shadow pass swaps. */
export interface OverridableScene {
  overrideMaterial: unknown;
}

/** What the shadow pass binds: its target, and the material it draws with. */
interface ShadowRig {
  target: unknown;
  material: unknown;
}

function isShadowMaterial(material: unknown): boolean {
  return (
    typeof material === 'object' &&
    material !== null &&
    (material as { isShadowPassMaterial?: unknown }).isShadowPassMaterial === true
  );
}

export class ShadowWarm {
  private rig: ShadowRig | null = null;
  private observed = false;

  /**
   * Wrap `setRenderTarget` so the first shadow render tells us what it binds.
   *
   * `updateShadow` sets the override material *before* it binds the target, so
   * by the time this sees the call the pair is complete. Idempotent: calling it
   * twice would nest the wrapper and double every bind.
   */
  observe(renderer: ShadowWarmRenderer, scene: OverridableScene): void {
    if (this.observed) return;
    this.observed = true;
    const inner = renderer.setRenderTarget.bind(renderer);
    renderer.setRenderTarget = (target: unknown, ...rest: unknown[]): void => {
      // **First one wins, and that is not tidiness -- it is the whole fix.**
      // `restoreRendererAndSceneState` calls `restoreRendererState` *before*
      // `restoreSceneState`, so the pass ends by re-binding the beauty target
      // while `scene.overrideMaterial` is still the shadow material. Last-wins
      // would capture that pair -- the beauty target with the shadow material --
      // every single frame, and every warm from then on would compile under a
      // key nothing looks up. Which is precisely the bug this file exists to
      // fix, reintroduced one layer down. The VSM blur pass binds its own
      // targets under the same material and is blocked by the same rule.
      if (
        this.rig === null &&
        target !== null &&
        target !== undefined &&
        isShadowMaterial(scene.overrideMaterial)
      ) {
        this.rig = { target, material: scene.overrideMaterial };
      }
      inner(target, ...rest);
    };
  }

  /** Whether a shadow render has happened and the rig is known. */
  get ready(): boolean {
    return this.rig !== null;
  }

  /**
   * Run `fn` with the shadow pass's context bound, so what it compiles is keyed
   * the way the shadow render will look it up.
   *
   * **The binding covers the synchronous prefix and nothing after it.** This is
   * the same rule `TripPass.warmInto` is built on and it is a correctness
   * requirement rather than tidiness: `compileAsync` resolves its render
   * context and builds its whole render list before its first yield, so the
   * prefix is enough -- and holding the binding across the await would leave
   * `scene.overrideMaterial` set to the shadow material for as long as a
   * compile takes. A frame landing in that window draws the entire world flat
   * black. Tiles warm continuously while somebody is playing, so that window
   * would be open more or less always.
   */
  warmInto<T>(renderer: ShadowWarmRenderer, scene: OverridableScene, fn: () => T): T {
    const rig = this.rig;
    if (rig === null) return fn();
    const prevTarget = renderer.getRenderTarget();
    const prevMrt = renderer.getMRT();
    const prevOverride = scene.overrideMaterial;
    scene.overrideMaterial = rig.material;
    renderer.setRenderTarget(rig.target);
    renderer.setMRT(null);
    try {
      return fn();
    } finally {
      scene.overrideMaterial = prevOverride;
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMrt);
    }
  }
}

/**
 * The catch-up sweep.
 *
 * Everything that streams in after the first frame is covered by the
 * precompiler, because by then the rig is known. What is *not* covered is the
 * set that was already resident when the first shadow render happened -- the
 * boot tiles, the far layer, the landmarks. Those would each still pay their
 * shadow pipeline on the frame they first cast, which is the first minute of
 * play: precisely the minute the owner reported.
 *
 * So once the rig is known, walk what is already in the scene, one group per
 * frame. One per frame rather than all at once because a warm is only cheap
 * relative to a frame if it is one warm; a sweep of the whole scene in a single
 * tick would be the stall it is trying to prevent, just moved.
 */
export class ShadowSweep {
  private queue: unknown[] | null = null;
  private done = 0;

  /** How many groups are still waiting. Zero before the sweep is armed. */
  get pending(): number {
    return this.queue === null ? 0 : this.queue.length;
  }

  /** How many have been warmed. For the boot log. */
  get swept(): number {
    return this.done;
  }

  /**
   * Take one group off the queue, arming the queue from `children` on first
   * use. Returns the group to warm, or null when there is nothing to do --
   * either the rig is not known yet or the sweep has finished.
   */
  next(ready: boolean, children: readonly unknown[]): unknown | null {
    if (!ready) return null;
    if (this.queue === null) this.queue = children.slice();
    const group = this.queue.pop();
    if (group === undefined) return null;
    this.done++;
    return group;
  }
}

export function verifyShadowWarm(): string[] {
  const failures: string[] = [];
  const shadowTarget = { id: 'shadow-map' };
  const shadowMaterial = { isShadowPassMaterial: true, id: 'shadow-material' };
  const beauty = { id: 'beauty-target' };
  const beautyMrt = { id: 'beauty-mrt' };
  const sceneMaterial = { id: 'no-override' };

  let bound: unknown = beauty;
  let mrt: unknown = beautyMrt;
  const renderer: ShadowWarmRenderer = {
    setRenderTarget: (t: unknown) => {
      bound = t;
    },
    getRenderTarget: () => bound,
    setMRT: (m: unknown) => {
      mrt = m;
    },
    getMRT: () => mrt,
  };
  const scene: OverridableScene = { overrideMaterial: null };

  const warm = new ShadowWarm();
  warm.observe(renderer, scene);
  warm.observe(renderer, scene); // must not nest

  // Before any shadow render there is nothing to bind, and a warm must still run.
  let ranEarly = false;
  warm.warmInto(renderer, scene, () => {
    ranEarly = true;
  });
  if (!ranEarly) failures.push('a warm before the first shadow render was swallowed.');
  if (warm.ready) failures.push('the shadow rig was claimed before any shadow render happened.');

  // A beauty-pass bind must not be mistaken for the shadow rig.
  scene.overrideMaterial = null;
  renderer.setRenderTarget(beauty);
  if (warm.ready) failures.push('a plain render target was captured as the shadow rig.');
  scene.overrideMaterial = sceneMaterial;
  renderer.setRenderTarget(beauty);
  if (warm.ready) {
    failures.push('a non-shadow override material was captured as the shadow rig.');
  }

  // The shadow render, in the order `ShadowNode.updateShadow` does it.
  scene.overrideMaterial = shadowMaterial;
  renderer.setRenderTarget(shadowTarget);
  renderer.setMRT(null);
  if (!warm.ready) {
    failures.push(
      'the shadow render was not recognised, so no warm in this client will ever' +
        ' compile for the pass that stalls the frame',
    );
  }
  // **The restore, in three's real order.** `restoreRendererAndSceneState`
  // restores the renderer first and the scene second, so the pass signs off by
  // binding the beauty target while the shadow material is still in place. A
  // last-wins observer captures that pair and every warm afterwards compiles
  // for a context no shadow render ever looks up -- silently, and forever.
  renderer.setRenderTarget(beauty);
  renderer.setMRT(beautyMrt);
  scene.overrideMaterial = null;

  let sawTarget: unknown = null;
  let sawMrt: unknown = 'unset';
  let sawOverride: unknown = null;
  warm.warmInto(renderer, scene, () => {
    sawTarget = bound;
    sawMrt = mrt;
    sawOverride = scene.overrideMaterial;
  });
  if (sawTarget === beauty) {
    failures.push(
      "warmInto bound the beauty target under the shadow material: the pass's own" +
        ' restore order was captured as the rig, so no warm compiles for the shadow pass',
    );
  } else if (sawTarget !== shadowTarget) {
    failures.push('warmInto did not bind the shadow map, so it compiled for the beauty pass again');
  }
  if (sawMrt !== null) failures.push('warmInto left an MRT bound; the shadow pass renders with none.');
  if (sawOverride !== shadowMaterial) {
    failures.push('warmInto did not set the shadow override material; the pipeline key is the material');
  }
  if (bound !== beauty || mrt !== beautyMrt || scene.overrideMaterial !== null) {
    failures.push(
      'warmInto did not restore the beauty pass; a frame after it would draw the' +
        ' world flat black through the shadow material',
    );
  }

  // Nothing may stay bound across an unfinished compile -- see the doc comment.
  let release: (() => void) | null = null;
  const pending = warm.warmInto(
    renderer,
    scene,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  if (scene.overrideMaterial !== null || bound !== beauty) {
    failures.push(
      'warmInto held the shadow material across an unfinished compile; a frame in' +
        ' that window renders the whole world as flat shadow black',
    );
  }
  (release as (() => void) | null)?.();
  void pending;

  // A throw restores too.
  try {
    warm.warmInto(renderer, scene, () => {
      throw new Error('compile failed');
    });
  } catch {
    // expected
  }
  if (scene.overrideMaterial !== null || bound !== beauty) {
    failures.push('warmInto left the shadow rig bound after a failed compile.');
  }

  // The sweep.
  const sweep = new ShadowSweep();
  if (sweep.next(false, ['a', 'b']) !== null) {
    failures.push('the sweep handed out work before the shadow rig was known.');
  }
  const kids = ['a', 'b', 'c'];
  const seen: unknown[] = [];
  for (let i = 0; i < 5; i++) {
    const g = sweep.next(true, kids);
    if (g !== null) seen.push(g);
  }
  if (seen.length !== 3) {
    failures.push(`the sweep covered ${seen.length} of 3 groups, one per tick.`);
  }
  if (new Set(seen).size !== 3) failures.push('the sweep warmed the same group twice.');
  if (sweep.pending !== 0) failures.push('the sweep did not finish.');
  // Children added after the sweep armed are the precompiler's job, not its own.
  kids.push('d');
  if (sweep.next(true, kids) !== null) {
    failures.push('the sweep re-armed from a grown scene; it is a one-time catch-up.');
  }
  return failures;
}
