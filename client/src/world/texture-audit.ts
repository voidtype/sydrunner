/**
 * Why a render exception must never be allowed to be silent, how a texture with
 * no image causes one, and why the renderer now *heals* rather than only
 * reporting.
 *
 * ---------------------------------------------------------------------------
 * THE REPORTED FAILURE, twice
 *
 *     Uncaught TypeError: Cannot read properties of null (reading 'complete')
 *         at Textures.updateTexture   (three.webgpu.js:34288)
 *         at Bindings._createBindings (three.webgpu.js:32835)
 *         at Bindings.getForRender    (three.webgpu.js:32714)
 *         at Renderer._renderObjectDirect
 *
 * The player saw the 3D world stop dead while the big map went on animating.
 * `renderer.render` is called once per frame from one place in `main.ts`; an
 * exception out of it aborts that frame *and every frame after it*, because the
 * condition is still there next time. The big map is a 2D canvas on its own
 * rAF, so it keeps painting, and the result is a live, responsive interface in
 * front of a world that has quietly stopped being drawn.
 *
 * The first cut of this module caught and reported that. It was not enough, and
 * the second occurrence is what proved it: the scene stayed down, every frame
 * throwing, and **the audit named nobody** -- the player had a red box with an
 * exception in it and no offender to paste. Two separate failures, both fixed
 * here:
 *
 *   1. The audit could not see the texture. It walked materials, and the three
 *      places a texture in this client actually hides are places it never
 *      looked. See "WHAT THE FIRST AUDIT COULD NOT SEE" below -- this was
 *      measured, not guessed.
 *   2. Reporting is not recovery. A named offender that keeps throwing is still
 *      a dead world. `quarantine` now repairs it in place, so one broken
 *      texture costs one wrong-looking surface instead of the entire 3D view.
 *
 * ---------------------------------------------------------------------------
 * THE THREE.JS DEFECT, read out of r185 rather than guessed
 *
 * `Textures.updateTexture` decides what to upload like this:
 *
 *     const { width, height, depth } = this.getSize( texture );   // line ~34255
 *     ...
 *     if ( texture.version > 0 ) {
 *         const image = texture.image;
 *         if ( image === undefined )           warn( '...image is undefined.' );
 *         else if ( image.complete === false ) warn( '...image is incomplete.' );
 *         else                                 { ...upload... }
 *     }
 *
 * `getSize`, thirty lines above, is explicitly written to tolerate a falsy
 * image -- `if ( image ) { ... } else { target.width = target.height = 1 }`.
 * The block below it is not: it guards `undefined` and not `null`. So a texture
 * whose `image` is **null** sails through `getSize`, fails `=== undefined`, and
 * dereferences `null.complete`.
 *
 * Both halves matter. A null image at `version === 0` is *ordinary*: that whole
 * block is skipped and the backend binds a placeholder, which is the state
 * every TSL node that was never handed a texture sits in quite happily. It is
 * the version bump -- some `needsUpdate = true` -- that turns a harmless empty
 * texture into one that dereferences null. That is also why the repair below
 * works: give the texture a 1x1 image and it becomes exactly the placeholder
 * three would have used anyway.
 *
 * It only throws on a **fresh bind group**: `Bindings.getForRender` calls
 * `_createBindings` once per render object ("bind groups are created once per
 * object"), so it lands the first time a newly-appearing object is drawn. Under
 * protocol v8's interest management that is constant -- a crowd produces 15+
 * INTEREST entrances a second, each one a new actor, new props and a new bind
 * group.
 *
 * ---------------------------------------------------------------------------
 * WHAT CARRIES A NULL IMAGE
 *
 * The client owns exactly two textures, and both hold their backing object for
 * their whole life:
 *
 *   - `world/nameplates.ts` -- one `CanvasTexture` over an `HTMLCanvasElement`
 *     created in the constructor. Never resized, never replaced; row eviction
 *     `clearRect`s *inside* it. `verifyNameplates` churns a thousand
 *     add/evict/re-add cycles and asserts the image is the same canvas after.
 *   - `world/params-atlas.ts` -- one `DataTexture` over a `Float32Array` sized
 *     once. Tile allocate/release move offsets within it.
 *
 * Neither can be null, and the AOI lifecycle does not touch them:
 * `dropRemoteActor` in `main.ts` disposes the footy, the bat and the bike and
 * removes the actor mesh, and disposes no material and no texture, because
 * every one of those is a shared asset owned by an `*Assets` object. Plates are
 * one shared mesh with one shared atlas; a remote leaving simply stops being
 * offered to `NameplateField.add`.
 *
 * The null-image texture that *does* exist in a three WebGPU app is three's
 * own. `texture()`, `textureLoad()` and `uniformTexture()` all default their
 * first argument to a **module-level shared `EmptyTexture` singleton** --
 * `const EmptyTexture = new Texture()`, whose image is `Texture.DEFAULT_IMAGE`,
 * which is null. Measured, in this build:
 *
 *     texture().value === texture().value        -> true
 *     texture().value === textureLoad().value    -> true
 *     ...value.image                             -> null
 *
 * One object, shared by every node that was handed `undefined`, reachable from
 * this module by asking for it the same way (`emptyTexture()` below). Because
 * it is shared, a `needsUpdate` set on it anywhere is set on it everywhere, and
 * every render object that binds it throws at once -- which is exactly the
 * persistent, whole-scene failure that was reported. It is the first thing the
 * audit checks and the first thing the repair fixes.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FIRST AUDIT COULD NOT SEE, and why the player had nothing to paste
 *
 * Measured against real three objects rather than reasoned about. Of six
 * deliberately planted null-image textures the first audit found three:
 *
 *     FOUND   colorNode = texture(t)                    (plain node)
 *     FOUND   textureLoad(t, ...).mul(...).add(...)     (nested arithmetic)
 *     FOUND   material.map                              (classic slot)
 *     MISSED  Fn(() => textureLoad(t, ...))()           (lazy Fn body)
 *     MISSED  scene.background
 *     MISSED  scene.environment
 *
 * The `Fn` miss is the important one and it is close to total for this
 * codebase. `Node.traverse` recurses through `getChildren()`, which enumerates
 * the node's *materialised* properties -- and an `Fn` body is a closure that
 * does not become nodes until the material is built. Nearly every material here
 * is that shape: `facade.ts` reaches the parameter atlas through a
 * `textureLoad` inside the material body, and `ground.ts`, `street.ts`,
 * `water.ts`, `awning.ts`, `landmarks.ts`, `vegetation.ts` and `fences.ts` all
 * build their colour in an `Fn`. So the one texture most likely to be bound by
 * a newly-streamed tile was the one texture the audit structurally could not
 * reach.
 *
 * The fix is not a cleverer traversal -- a closure cannot be walked. It is a
 * **registry**: the two modules that own a texture hand it to `registerTexture`
 * when they build it, and the audit checks the registry regardless of how the
 * graph is shaped. Traversal is kept as well, because it catches textures
 * nobody registered, and `scene.background`, `scene.environment` and
 * `scene.overrideMaterial` are now walked too.
 */

import type { Object3D } from 'three/webgpu';
import { texture as textureNode } from 'three/tsl';

// --- What to check ------------------------------------------------------------

interface MaybeTexture {
  isTexture?: boolean;
  isDataTexture?: boolean;
  isCubeTexture?: boolean;
  isCanvasTexture?: boolean;
  /**
   * The five flags that make three take `backend.createTexture` instead of the
   * branch that reads `image`. A texture with any of them set never has its
   * image dereferenced, so a null one is not a fault -- see
   * `wouldDereferenceNull`, which mirrors three's own condition.
   */
  isRenderTargetTexture?: boolean;
  isDepthTexture?: boolean;
  isFramebufferTexture?: boolean;
  isStorageTexture?: boolean;
  isExternalTexture?: boolean;
  name?: string;
  image?: unknown;
  version?: number;
  needsUpdate?: boolean;
}

interface MaybeNode {
  isNode?: boolean;
  isTextureNode?: boolean;
  value?: unknown;
  traverse?: (cb: (n: MaybeNode) => void) => void;
}

/**
 * Classic texture slots. `MeshStandardMaterial` and friends hold a `Texture`
 * directly on these; node materials mostly do not, which is what the registry
 * and the node walk are for.
 */
const CLASSIC_SLOTS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
  'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap',
  'specularMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap',
] as const;

/**
 * Every texture this client made, by the module that made it.
 */
/**
 * Pinned to a global rather than held as a module local, and this is not
 * ceremony -- it was caught lying.
 *
 * Vite's dev server serves an edited module as `...texture-audit.ts?t=<stamp>`,
 * so the app's graph and anything imported later from the console are **two
 * module instances with two separate registries**. Measured on the live client:
 * the plate atlas was registered in the app's instance and the console's said
 * zero, which is precisely the "the audit named nobody" failure this module
 * exists to prevent, reproduced in the debugging tool itself. A production
 * bundle has one instance and would never show it, which makes it worse rather
 * than better: the tool would only be wrong in the session where somebody was
 * trying to diagnose a crash with it.
 *
 * A `Set` of live references rather than a `WeakSet`, deliberately: there are
 * two of them, they live for the whole session, and the audit has to be able to
 * *enumerate* -- which is the entire point, since the graphs they are bound
 * through cannot be walked. See the header on the `Fn` miss.
 */
const REGISTRY_KEY = Symbol.for('sydney.textureAudit.registered');
const globals = globalThis as unknown as Record<symbol, Set<MaybeTexture> | undefined>;
const registered: Set<MaybeTexture> = globals[REGISTRY_KEY] ?? new Set<MaybeTexture>();
globals[REGISTRY_KEY] = registered;

/**
 * Declare a texture so the audit can always see it.
 *
 * Called by `world/nameplates.ts` and `world/params-atlas.ts` at construction.
 * Anything else that ever creates a texture should call this too, and the boot
 * check asserts the count is what this file expects so a third one cannot be
 * added silently.
 */
export function registerTexture(value: unknown): void {
  if (isTexture(value)) registered.add(value);
}

/**
 * Withdraw a texture that has been disposed.
 *
 * Called from both owners' `dispose`. Without it the registry would accumulate
 * dead textures -- `verifyNameplates` alone builds and disposes a whole
 * `NameplateField` at boot -- and the audit would go on reporting objects that
 * no longer exist, which is the same disease as not seeing the live ones.
 */
export function unregisterTexture(value: unknown): void {
  if (isTexture(value)) registered.delete(value);
}

/**
 * How many textures are registered right now.
 *
 * **Not** assertable from the boot self-checks, and the attempt is instructive:
 * the checks run before the world is built, so at that moment the answer is
 * zero, and `verifyNameplates` -- which runs just before -- constructs and then
 * disposes a field, so it is zero again afterwards. The count is only meaningful
 * once the streamer and the plate field exist, which is why it is reported on
 * the debug object (`sydney.render.report().registered`) rather than asserted
 * here. What the checks *can* prove, and do, is that a registered texture with
 * no image is found -- which is the property the registry exists for.
 */
export function registeredCount(): number {
  return registered.size;
}

function isTexture(value: unknown): value is MaybeTexture {
  return typeof value === 'object' && value !== null && (value as MaybeTexture).isTexture === true;
}

function isNode(value: unknown): value is MaybeNode {
  return typeof value === 'object' && value !== null && (value as MaybeNode).isNode === true;
}

/**
 * Three's shared `EmptyTexture` singleton -- the one object in a three WebGPU
 * app whose image is null by construction.
 *
 * Not exported by three, so it is fetched the way any node fetches it: a
 * `texture()` with no argument returns a node whose `value` *is* the singleton.
 * Cached, because it never changes.
 */
let emptyTextureCache: MaybeTexture | null = null;
export function emptyTexture(): MaybeTexture | null {
  if (emptyTextureCache === null) {
    try {
      const value = (textureNode() as unknown as { value?: unknown }).value;
      if (isTexture(value)) emptyTextureCache = value;
    } catch {
      // A three that stops defaulting to a shared texture is a three this
      // check has nothing to say about, which is not an error.
    }
  }
  return emptyTextureCache;
}

/**
 * Is this the texture that would throw?
 *
 * Both halves, for the reason the header gives: a null image at version 0 is
 * three's ordinary placeholder state and reporting it would bury the real one.
 */
function wouldThrow(texture: MaybeTexture): boolean {
  return texture.image === null && (texture.version ?? 0) > 0;
}

function describe(texture: MaybeTexture, owner: string): string {
  const name = texture.name ? `"${texture.name}"` : '(unnamed)';
  return `${owner}: texture ${name} image=null version=${texture.version ?? 0}`;
}

/** One offender, with the object that would need benching if it cannot be repaired. */
export interface Offender {
  texture: MaybeTexture;
  /** Human line, for the console and the HUD. */
  where: string;
  /** The meshes that bind it, so a texture that cannot be repaired can be hidden. */
  objects: Object3D[];
}

/**
 * Every texture that would make `Textures.updateTexture` throw, wherever it is
 * reachable from: the registry, three's shared empty singleton, every
 * material in the scene (classic slots and walkable node graphs), and the
 * scene's own background, environment and override material.
 *
 * This function must not throw. It runs inside the catch block that handles a
 * render exception, and an audit that threw there would replace the one
 * diagnostic anybody has with a second, less useful one. Every traversal is
 * wrapped for that reason.
 */
export function findOffenders(scene: Object3D): Offender[] {
  const byTexture = new Map<MaybeTexture, Offender>();
  const seenMaterials = new Set<unknown>();

  const note = (value: unknown, where: string, object: Object3D | null): void => {
    if (!isTexture(value) || !wouldThrow(value)) return;
    const existing = byTexture.get(value);
    if (existing) {
      if (object && !existing.objects.includes(object)) existing.objects.push(object);
      return;
    }
    byTexture.set(value, { texture: value, where: describe(value, where), objects: object ? [object] : [] });
  };

  // 1. Three's shared empty texture. First, because when this one is the
  // offender it is bound by *everything* and explains the whole scene at once.
  const empty = emptyTexture();
  if (empty) note(empty, "three's shared EmptyTexture (a TSL texture node was handed undefined)", null);

  // 2. The registry. The only way to see a texture bound through an `Fn` body.
  for (const t of registered) note(t, 'registered texture', null);

  // 3. The scene's own slots, which are not on any material.
  try {
    const s = scene as unknown as Record<string, unknown>;
    note(s.background, 'scene.background', null);
    note(s.environment, 'scene.environment', null);
    if (s.overrideMaterial) checkMaterial(s.overrideMaterial, 'scene.overrideMaterial', null);
  } catch {
    /* see the contract above */
  }

  function checkMaterial(material: unknown, owner: string, object: Object3D | null): void {
    if (typeof material !== 'object' || material === null || seenMaterials.has(material)) return;
    seenMaterials.add(material);
    const record = material as Record<string, unknown>;
    const label = typeof record.name === 'string' && record.name ? `${owner} / ${record.name}` : owner;

    for (const slot of CLASSIC_SLOTS) note(record[slot], `${label}.${slot}`, object);

    // Node graphs. `Object.keys` rather than a fixed list because `NodeMaterial`
    // grows fields between three releases and a slot this file had not heard of
    // is exactly the one that would hide the bug. Only reaches *materialised*
    // nodes -- an `Fn` body is a closure and is covered by the registry.
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (!isNode(value)) continue;
      try {
        if (typeof value.traverse === 'function') {
          value.traverse((n) => {
            if (n && n.isTextureNode === true) note(n.value, `${label}.${key}`, object);
          });
        } else if (value.isTextureNode === true) {
          note(value.value, `${label}.${key}`, object);
        }
      } catch {
        /* a graph that cannot be walked is not evidence of anything */
      }
    }
  }

  // 4. Every material in the scene.
  try {
    scene.traverse((object) => {
      const material = (object as unknown as { material?: unknown }).material;
      const owner = object.name || object.type;
      if (Array.isArray(material)) for (const m of material) checkMaterial(m, owner, object);
      else if (material) checkMaterial(material, owner, object);
    });
  } catch {
    /* see the contract above */
  }

  return [...byTexture.values()];
}

/** The offenders as human lines. The console and the HUD both want this. */
export function auditSceneTextures(scene: Object3D): string[] {
  return findOffenders(scene).map((o) => o.where);
}

// --- Repair -------------------------------------------------------------------

/**
 * A 1x1 image of the right shape for a texture, so it can be uploaded instead
 * of dereferenced.
 *
 * This is not a guess at what the texture should have contained -- nothing can
 * know that. It is precisely the placeholder three itself binds for a texture
 * at version 0, installed a moment later than three would have. A `DataTexture`
 * needs `{ data, width, height }` with a typed array, because the WebGPU
 * backend reads `image.data` for it; everything else is happy with a canvas,
 * which is what `CanvasTexture` and a plain `Texture` both expect.
 */
function placeholderImage(texture: MaybeTexture): unknown {
  if (texture.isDataTexture === true) {
    return { data: new Float32Array(4), width: 1, height: 1 };
  }
  if (texture.isCubeTexture === true) {
    // Six faces, because `getSize` reads `texture.images[0]` and the upload
    // walks all six. One canvas reused is fine: they are all the same texel.
    const face = onePixelCanvas();
    return [face, face, face, face, face, face];
  }
  return onePixelCanvas();
}

/**
 * `document` and the canvas shape, reached structurally.
 *
 * This module is imported -- transitively, through the render guard -- by code
 * the SERVER compiles, and `server/tsconfig.json` deliberately omits the DOM
 * lib so that nothing under `server/` can accidentally reach for a browser API
 * at runtime. Naming `HTMLCanvasElement` or `document` here therefore fails the
 * build the moment anything on the server's side of the graph pulls this file
 * in, which is exactly what happened. The same trick `cdn.ts` uses for `window`
 * and `invisible-walls.ts` uses for its hatch pattern: describe the shape that
 * is actually used, and reach the global through `globalThis`.
 *
 * It stays honest because the shape is the real one -- a width, a height and a
 * 2D context -- so a browser that stopped providing them would still fail here,
 * just at the call rather than at the type.
 */
interface AuditCanvas {
  width: number;
  height: number;
  getContext(id: '2d'): {
    fillStyle: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    clearRect(x: number, y: number, w: number, h: number): void;
  } | null;
}

const domScope = globalThis as unknown as {
  document?: { createElement(tag: string): AuditCanvas };
};

function onePixelCanvas(): AuditCanvas {
  const canvas = domScope.document!.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Transparent black. A magenta "error" texel was considered and rejected:
    // the surfaces this lands on are a whole city facade or every nameplate at
    // once, and a screen of flat magenta is harder to play through -- and
    // harder to screenshot usefully -- than a surface that has simply lost its
    // detail.
    ctx.clearRect(0, 0, 1, 1);
  }
  return canvas;
}

/**
 * Repair every offender so the scene can be drawn again, and say what was done.
 *
 * **Why repair rather than hide.** The alternative -- swap the material, or set
 * `mesh.visible = false` -- was the first design and it is worse on every axis.
 * The offending texture is shared: the parameter atlas is bound by every facade
 * material in the city and the plate atlas by the single mesh that draws every
 * nameplate, and three's `EmptyTexture` is bound by anything that was handed
 * `undefined`. Hiding "the mesh that binds it" therefore means hiding the whole
 * city, and swapping materials means compiling replacement pipelines during a
 * frame that is already failing. Giving the texture the 1x1 image three would
 * have used at version 0 fixes **every** binding of it at once, costs one
 * upload, compiles nothing, and leaves the geometry on screen.
 *
 * Hiding is kept only as the last resort for a texture whose image could not be
 * installed at all, which should be unreachable.
 *
 * Returns one line per repair, or an empty array if there was nothing to do --
 * and an empty array is meaningful: it means the exception was *not* a
 * null-image texture, and the caller should say so rather than claim a fix.
 */
export function quarantine(scene: Object3D): string[] {
  const done: string[] = [];
  for (const offender of findOffenders(scene)) {
    const texture = offender.texture;
    try {
      texture.image = placeholderImage(texture);
      texture.needsUpdate = true;
      done.push(`repaired ${offender.where} (1x1 placeholder installed)`);
    } catch {
      let hidden = 0;
      for (const object of offender.objects) {
        try {
          (object as unknown as { visible: boolean }).visible = false;
          hidden++;
        } catch {
          /* nothing left to try */
        }
      }
      done.push(`could not repair ${offender.where}; hid ${hidden} mesh(es)`);
    }
  }
  return done;
}

// --- The shim: intercepting at the throwing call site --------------------------

/** What `RenderGuard` and the shim need of the HUD. Structural, so the checks can drive it. */
export interface GuardReport {
  fatal(message: string): void;
  notice(message: string): void;
}

/**
 * Why there is a shim as well as an audit, and why searching was the wrong
 * strategy.
 *
 * The audit above is comprehensive over everything this client can *enumerate*:
 * the registry, three's shared `EmptyTexture`, every material in the scene
 * through both classic slots and walkable node graphs, and the scene's own
 * background, environment and override material. On the third occurrence it
 * found **nothing**, while the renderer went on throwing `null.complete` every
 * frame. That is a decisive negative result rather than a disappointment: the
 * offending texture is somewhere no traversal from `scene` reaches.
 *
 * There is a lot of somewhere. Three binds textures this client never sees --
 * shadow-map depth textures, PMREM and environment products, background
 * textures, internal render-target attachments, textures reached through the
 * *shadow pass's* material rather than the scene material, and anything hung on
 * an object parented to the camera rather than to the scene. Widening the
 * search to cover each of those is a losing game: every round adds a place to
 * look, and the failure mode of missing one is exactly the silent dead world
 * this whole module exists to prevent.
 *
 * So this stops searching and **intercepts the call that throws**.
 * `Textures.updateTexture` is the single function that dereferences the null,
 * and every texture three uploads goes through it, whatever its origin and
 * however it was reached. Wrapping it catches the fault one instruction before
 * three commits it, for *any* origin, and gets the identity for free -- which
 * is the thing three rounds of searching could not produce.
 *
 * --- How it fails safe
 *
 * The hook is on `renderer._textures`, a private field, so a three upgrade can
 * rename it out from under this. Every step is therefore checked and the
 * failure is a **logged no-op**: `install` returns a reason string, warns once,
 * and leaves `RenderGuard` as the net it already was. It never throws, so a
 * renamed internal cannot turn into a boot fatal. Inside the wrapper the
 * inspection is wrapped again and the original is called through a `finally`,
 * so a bug in this file cannot stop a frame that three would have drawn.
 *
 * --- The second hook, and why it is worth one more private field
 *
 * `updateTexture` receives only the texture, which names the object but not
 * where it was bound from. `Bindings.getForRender( renderObject )` is called
 * immediately above it in the same stack and *does* have the render object --
 * its mesh and its material. Recording that for the duration of the call turns
 * "some texture with no image" into "this texture, bound by this material, on
 * this mesh", which is the difference between a report we can act on and
 * another round of guessing. It is optional: if `_bindings` cannot be found the
 * shim installs anyway and simply reports less.
 */

/** One thing the shim caught, and how many times. Keyed by identity. */
const CATCH_KEY = Symbol.for('sydney.textureAudit.shimCatches');
const catchGlobals = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
const shimCatches: Map<string, number> = catchGlobals[CATCH_KEY] ?? new Map<string, number>();
catchGlobals[CATCH_KEY] = shimCatches;

/** Everything the shim has intercepted, most frequent first. One line each. */
export function shimCatchLines(): string[] {
  return [...shimCatches.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([identity, count]) => `${identity} [caught x${count}]`);
}

/** For the checks. */
export function resetShimCatches(): void {
  shimCatches.clear();
}

/**
 * Would three dereference null on this texture?
 *
 * Mirrors `Textures.updateTexture`'s own branch exactly, and the exclusions
 * matter as much as the test. A render-target, depth, framebuffer, storage or
 * external texture takes the `backend.createTexture` path and never reads
 * `image` at all, so one of those with a null image is **not** a fault and
 * installing an image on it would be damage rather than repair.
 */
function wouldDereferenceNull(texture: MaybeTexture): boolean {
  if (texture.isRenderTargetTexture === true) return false;
  if (texture.isDepthTexture === true) return false;
  if (texture.isFramebufferTexture === true) return false;
  if (texture.isStorageTexture === true) return false;
  if (texture.isExternalTexture === true) return false;
  return texture.image === null && (texture.version ?? 0) > 0;
}

/** The render object currently having its bindings built, if the probe is in. */
let currentRenderObject: Record<string, unknown> | null = null;

/**
 * Everything worth knowing about the texture that was about to throw.
 *
 * Deliberately verbose. This string is the entire product of the exercise: it
 * is what turns "a texture somewhere had no image" into a specific object with a
 * constructor, a uuid and a binding site, and it is what the next round will fix
 * at the origin. It is built defensively -- every field is read through a
 * `try` -- because an object that is already in a bad state is exactly the kind
 * that throws on a getter.
 */
function identify(texture: MaybeTexture): string {
  const parts: string[] = [];
  const push = (label: string, read: () => unknown): void => {
    try {
      const value = read();
      if (value !== undefined && value !== null && value !== '' && value !== false) {
        parts.push(`${label}=${String(value)}`);
      }
    } catch {
      parts.push(`${label}=<threw>`);
    }
  };
  const t = texture as unknown as Record<string, unknown>;
  push('class', () => (t.constructor as { name?: string } | undefined)?.name);
  push('name', () => t.name);
  push('uuid', () => t.uuid);
  push('version', () => t.version);
  push('source.uuid', () => (t.source as { uuid?: string } | undefined)?.uuid);
  push('source.dataReady', () => (t.source as { dataReady?: boolean } | undefined)?.dataReady);
  for (const flag of [
    'isCanvasTexture', 'isDataTexture', 'isCubeTexture', 'isArrayTexture', 'isData3DTexture',
    'isCompressedTexture', 'isVideoTexture', 'isDepthTexture', 'isRenderTargetTexture',
    'isFramebufferTexture', 'isStorageTexture', 'isExternalTexture', 'isHTMLTexture',
  ]) {
    push(flag, () => (t[flag] === true ? true : undefined));
  }
  push('mapping', () => t.mapping);
  push('format', () => t.format);
  push('type', () => t.type);
  push('colorSpace', () => t.colorSpace);
  push('mipmaps', () => (Array.isArray(t.mipmaps) ? t.mipmaps.length : undefined));

  // Where it was being bound from, if the bindings probe is installed.
  const ro = currentRenderObject;
  if (ro) {
    const object = ro.object as Record<string, unknown> | undefined;
    const material = ro.material as Record<string, unknown> | undefined;
    push('boundOn', () => object && (object.name || object.type));
    push('boundVia', () => material && (material.name || material.type));
    push('materialClass', () => (material?.constructor as { name?: string } | undefined)?.name);
    // A viewmodel or a nameplate field parented to the camera is not reachable
    // by walking `scene`, and is one of the places the audit could not look.
    push('underCamera', () => {
      let node = object as { parent?: Record<string, unknown>; isCamera?: boolean } | undefined;
      while (node) {
        if (node.isCamera === true) return true;
        node = node.parent as typeof node;
      }
      return undefined;
    });
  } else {
    parts.push('boundOn=<no bindings probe>');
  }
  return parts.join(' ');
}

/**
 * Install the interception. Returns a one-line account of what happened, which
 * the boot log prints and the debug object keeps.
 *
 * Never throws. Every failure degrades to a logged no-op.
 */
export function installTextureShim(renderer: unknown, report: GuardReport): string {
  try {
    const r = renderer as Record<string, unknown> | null;
    const textures = r?._textures as Record<string, unknown> | undefined;
    if (!textures || typeof textures.updateTexture !== 'function') {
      const why =
        'renderer._textures.updateTexture was not found -- three has probably renamed it. ' +
        'The render guard is still in place, but a null-image texture will crash the frame before it can be named.';
      console.warn('[render] texture shim NOT installed: ' + why);
      return 'not installed: ' + why;
    }
    if (textures.__sydneyShimmed === true) return 'already installed';

    const original = textures.updateTexture as (texture: unknown, options?: unknown) => unknown;
    textures.updateTexture = function (this: unknown, texture: unknown, options?: unknown): unknown {
      try {
        if (texture && typeof texture === 'object' && wouldDereferenceNull(texture as MaybeTexture)) {
          intercept(texture as MaybeTexture, report);
        }
      } catch {
        // A bug in the inspection must never cost a frame that three would
        // have drawn. The original call happens either way, below.
      }
      return original.call(this, texture, options);
    };
    textures.__sydneyShimmed = true;

    // Optional enrichment. See the header on the second hook.
    let probe = 'no bindings probe';
    try {
      const bindings = r?._bindings as Record<string, unknown> | undefined;
      if (bindings && typeof bindings.getForRender === 'function' && bindings.__sydneyProbed !== true) {
        const originalGet = bindings.getForRender as (renderObject: unknown) => unknown;
        bindings.getForRender = function (this: unknown, renderObject: unknown): unknown {
          currentRenderObject = renderObject as Record<string, unknown>;
          try {
            return originalGet.call(this, renderObject);
          } finally {
            currentRenderObject = null;
          }
        };
        bindings.__sydneyProbed = true;
        probe = 'bindings probe in';
      }
    } catch {
      /* enrichment only */
    }
    return `installed (${probe})`;
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    console.warn('[render] texture shim NOT installed: ' + why);
    return 'not installed: ' + why;
  }
}

/**
 * A texture reached the uploader with no image. Name it, repair it, let it
 * through.
 *
 * Repair is the same 1x1 placeholder `quarantine` installs, for the same
 * reason: it is precisely what three would have bound at version 0, so the
 * texture becomes uploadable and every binding of it is valid. The frame then
 * draws. The surface it lands on loses its detail; nothing else changes.
 *
 * Reported once per distinct identity. A texture that is wrong once is wrong on
 * every frame until something fixes its origin, and the point of the message is
 * the identity, not the repetition.
 */
function intercept(texture: MaybeTexture, report: GuardReport): void {
  const identity = identify(texture);
  const seen = shimCatches.get(identity) ?? 0;
  shimCatches.set(identity, seen + 1);

  try {
    texture.image = placeholderImage(texture);
    texture.needsUpdate = true;
  } catch {
    // Could not repair. Three is about to throw on it; `RenderGuard` catches
    // that, and the identity is recorded either way -- which is still strictly
    // more than the three previous occurrences produced.
  }

  if (seen === 0) {
    console.error(
      '[render] a texture reached the uploader with image === null and was repaired in place.\n' +
        '  ' + identity + '\n' +
        '  The frame was saved; this texture now draws a 1x1 placeholder. Its origin still needs fixing.',
    );
    report.notice(`texture repaired at the uploader: ${identity.slice(0, 120)}`);
  }
}

// --- Surviving a frame that throws --------------------------------------------

/**
 * Frames a render exception is allowed to be transient for before the player is
 * shown the error screen.
 *
 * **The loop keeps attempting frames rather than halting.** The condition is
 * per-bind-group and per-render-object, so a scene that lost one object still
 * draws every other object on the next attempt, and the repair above only takes
 * effect *because* there is a next attempt. Halting would turn a recoverable
 * fault into a dead session, and a caught exception costs nothing.
 *
 * Three frames rather than one because a single dropped frame is not worth a
 * full-screen error, and three at 60 Hz is 50 ms -- under the threshold at which
 * anybody perceives a stall. A repair that works lands on frame two, so the
 * common case never reaches the error screen at all.
 */
const TRANSIENT_FRAMES = 3;

/**
 * Runs the frame's render call, absorbs a throw, and repairs what it can.
 *
 * The rules, and why each one:
 *
 *   - **Repair first, on the very first throw.** Reporting a persistent failure
 *     is what the previous cut did, and a player lived through the result: a
 *     red box and a dead world. One broken texture must never take down the
 *     whole 3D view.
 *   - **The offender's name leads every message.** Players paste the red box,
 *     not the console, so the line naming the texture is the *first* line of
 *     both the notice and the fatal -- ahead of the exception, which on its own
 *     says only that something was null.
 *   - **Logged once per unique message**, with the full error. A render
 *     exception repeats every frame by construction and a console with four
 *     thousand copies of one stack is a console nobody reads.
 *   - **It never rethrows.** The HUD, the frame timing and the network run
 *     whether or not the scene drew.
 */
export class RenderGuard {
  /** Frames that threw, since boot. Nonzero is a bug; the debug object reads it. */
  failures = 0;
  /** Distinct messages seen. For the checks and the console. */
  readonly messages: string[] = [];
  /** Everything the guard has repaired or benched, in order. */
  readonly quarantined: string[] = [];
  private consecutive = 0;
  private fatalShown = false;
  private noticeShown = false;

  /**
   * Draw, and absorb a throw. Returns true if the frame drew.
   *
   * `draw` is a closure rather than `(renderer, scene, camera)` so this stays
   * usable from the checks, which have no renderer.
   */
  run(draw: () => void, scene: Object3D, report: GuardReport): boolean {
    try {
      draw();
    } catch (err) {
      this.onThrow(err, scene, report);
      return false;
    }
    // Recovered -- which after a repair is the expected outcome. Take the
    // transient notice back down, but never the fatal: a session that has
    // already been told the scene cannot be drawn has had its loading screen put
    // back up, and quietly clearing that would leave the player unable to tell
    // which state they are in.
    if (this.noticeShown && !this.fatalShown) {
      this.noticeShown = false;
      report.notice('');
    }
    this.consecutive = 0;
    return true;
  }

  private onThrow(err: unknown, scene: Object3D, report: GuardReport): void {
    this.failures++;
    this.consecutive++;
    const message = err instanceof Error ? err.message : String(err);
    const fresh = !this.messages.includes(message);
    if (fresh) this.messages.push(message);

    // Repair on every throw, not only the first: a second, different offender
    // can appear later in the session -- under interest management a new bind
    // group is created every time somebody walks into view -- and the guard
    // must not go quiet after the first one it fixed.
    const repaired = quarantine(scene);
    for (const line of repaired) this.quarantined.push(line);

    // What the shim caught at the uploader. This is the coherence the messaging
    // needs: when the shim has named a texture the audit could not reach, the
    // guard must report *that* rather than announcing it found nothing -- which
    // is exactly the misleading pair of lines the third occurrence produced.
    const caught = shimCatchLines();

    if (fresh) {
      console.error('[render] the frame threw; the 3D scene is not being drawn.', err);
      if (repaired.length > 0) {
        console.error('[render] quarantined:\n' + repaired.map((l) => '  - ' + l).join('\n'));
      } else if (caught.length > 0) {
        console.error(
          '[render] the scene audit found nothing, but the uploader shim caught and repaired:\n' +
            caught.map((l) => '  - ' + l).join('\n') +
            '\n  If the frame is still throwing, the fault is beyond a null image.',
        );
      } else {
        console.error(
          '[render] no null-image texture was found by the scene audit or the uploader shim, ' +
            'so this is not the known texture fault. The scene will keep being attempted; ' +
            '`sydney.render.audit()` re-runs the search and `sydney.render.shim()` lists what the uploader saw.',
        );
      }
    }

    // The offender's name leads. This is what the player pastes.
    const lead =
      repaired.length > 0
        ? repaired.join('\n')
        : caught.length > 0
          ? `repaired at the uploader:\n${caught.join('\n')}`
          : 'no null-image texture found (scene audit and uploader shim both clean)';

    if (this.consecutive >= TRANSIENT_FRAMES) {
      if (this.fatalShown) return;
      this.fatalShown = true;
      report.fatal(
        `${lead}\n\nThe 3D scene stopped being drawn.\n\n${message}\n\n` +
          'The rest of the interface is still live; the world is not.',
      );
    } else if (!this.noticeShown) {
      this.noticeShown = true;
      report.notice(
        repaired.length > 0
          ? `benched: ${repaired[0]}`
          : caught.length > 0
            ? `repaired at the uploader: ${caught[0]}`
            : 'a frame failed to draw',
      );
    }
  }
}

// --- The check ----------------------------------------------------------------

/**
 * Boot self-check, on this project's usual criterion: does every way this
 * breaks still *render*, and render something plausible?
 *
 * Every failure below does, which is the whole reason the feature exists. A
 * guard that swallows the exception without surfacing it is the bug it was
 * written to fix wearing a fix's clothes -- the world stops and nothing says
 * so. A guard that surfaces every frame floods the console until the tab dies,
 * losing the one stack that mattered in four thousand copies of it. An audit
 * that cannot reach the texture reports a clean scene during the exact failure
 * it exists to explain, which is worse than not running: it points the reader
 * away from the cause, and it is what actually happened on the second
 * occurrence. And a repair that does not repair leaves a red box in front of a
 * dead world, which is the state this whole module exists to prevent.
 */
export function verifyTextureAudit(): string[] {
  const failures: string[] = [];
  // The guard logs, and this check makes it throw a dozen times on purpose.
  // Left alone that is a screenful of `console.error` in front of every boot,
  // which trains the reader to scroll past exactly the message this module
  // exists to make them read. Restored in `finally` so a check that throws does
  // not leave the console muted.
  const realError = console.error;
  console.error = () => {};
  try {
    return checks(failures);
  } finally {
    console.error = realError;
  }
}

function checks(failures: string[]): string[] {
  const nullImaged = (name: string): MaybeTexture => ({ isTexture: true, name, image: null, version: 4 });
  const makeScene = (material: unknown): Object3D => {
    const mesh = { name: 'probe', type: 'Mesh', visible: true, material };
    return {
      background: null,
      environment: null,
      overrideMaterial: null,
      traverse(cb: (o: Object3D) => void) {
        cb(mesh as unknown as Object3D);
      },
    } as unknown as Object3D;
  };

  // --- Reach. Every place this client can hide a texture.
  const planted = nullImaged('planted');
  const found = findOffenders(makeScene({ name: 'probe_material', map: planted }));
  if (!found.some((o) => o.where.includes('planted'))) {
    failures.push('The audit did not find a null-image texture in a classic material slot.');
  }
  // A version-0 empty texture is three's ordinary placeholder and must not be
  // reported, or every healthy material in the game would be an offender.
  const quiet = { isTexture: true, name: 'quiet', image: null, version: 0 };
  if (findOffenders(makeScene({ name: 'm', map: quiet })).length !== 0) {
    failures.push('The audit reported a version-0 empty texture, which three binds a placeholder for.');
  }
  const healthy = { isTexture: true, name: 'fine', image: { width: 4, height: 4 }, version: 4 };
  if (findOffenders(makeScene({ name: 'm', map: healthy })).length !== 0) {
    failures.push('The audit reported a texture that has an image.');
  }
  // The scene's own slots, which the first cut of this file never looked at.
  const bg = makeScene(null) as unknown as Record<string, unknown>;
  bg.background = nullImaged('planted_background');
  if (!findOffenders(bg as unknown as Object3D).some((o) => o.where.includes('planted_background'))) {
    failures.push('The audit did not look at scene.background.');
  }
  const env = makeScene(null) as unknown as Record<string, unknown>;
  env.environment = nullImaged('planted_environment');
  if (!findOffenders(env as unknown as Object3D).some((o) => o.where.includes('planted_environment'))) {
    failures.push('The audit did not look at scene.environment.');
  }

  // --- The registry, which is the only way to see a texture bound through an
  // `Fn` body -- and nearly every material in this game is that shape. This is
  // the gap that left a player with a red box and no offender to paste.
  const registryProbe = nullImaged('planted_registered');
  registerTexture(registryProbe);
  try {
    if (!findOffenders(makeScene(null)).some((o) => o.where.includes('planted_registered'))) {
      failures.push('A registered texture with no image was not reported; an `Fn`-bound texture would be invisible.');
    }
  } finally {
    registered.delete(registryProbe);
  }
  // Registration is withdrawn on dispose, or the registry fills with dead
  // textures and the audit reports objects that no longer exist.
  const disposed = nullImaged('planted_disposed');
  registerTexture(disposed);
  unregisterTexture(disposed);
  if (findOffenders(makeScene(null)).some((o) => o.where.includes('planted_disposed'))) {
    failures.push('An unregistered texture was still reported; the registry never lets go.');
  }

  // --- Three's shared EmptyTexture, which is the one object that is null by
  // construction and is bound by everything that was handed `undefined`.
  const empty = emptyTexture();
  if (!empty) {
    failures.push("three's shared EmptyTexture could not be reached; the audit cannot check the likeliest offender.");
  } else {
    if (empty.image !== null) {
      failures.push('The shared EmptyTexture has an image; this check no longer proves anything.');
    }
    if ((empty.version ?? 0) > 0) {
      failures.push('The shared EmptyTexture has been marked for update; every node that defaulted to it would throw.');
    }
  }

  // --- Repair. The offending texture must come out uploadable, and the meshes
  // must stay visible -- hiding the city is not a fix.
  const repairScene = makeScene({ name: 'repair_material', map: nullImaged('to_repair') });
  const repaired = quarantine(repairScene);
  if (repaired.length !== 1) {
    failures.push(`Quarantine repaired ${repaired.length} textures in a scene with one offender.`);
  } else if (!repaired[0].includes('to_repair')) {
    failures.push('The quarantine line does not name the texture it repaired.');
  }
  if (findOffenders(repairScene).length !== 0) {
    failures.push('A repaired texture is still an offender; the scene would go on throwing forever.');
  }
  // Repair is idempotent and a clean scene is a no-op.
  if (quarantine(repairScene).length !== 0) {
    failures.push('Quarantine reported work on a scene it had already repaired.');
  }
  // A DataTexture needs a typed array, not a canvas: the WebGPU backend reads
  // `image.data` for it and a canvas there would throw somewhere far less
  // legible than here.
  const dataProbe: MaybeTexture = { isTexture: true, isDataTexture: true, name: 'data', image: null, version: 2 };
  quarantine(makeScene({ name: 'm', map: dataProbe }));
  const dataImage = dataProbe.image as { data?: unknown } | null;
  if (!dataImage || !(dataImage.data instanceof Float32Array)) {
    failures.push('A repaired DataTexture did not get a typed-array image; the backend reads `image.data`.');
  }

  // --- The shim. A fake `Textures` stands in for three's, because the real one
  // does not exist until `renderer.init()` has resolved and these checks run
  // long before that. What is being checked is the wrapping contract, which is
  // the part that can rot: the branch conditions, the repair, the identity, and
  // -- above all -- that every failure is a no-op rather than a boot fatal.
  {
    resetShimCatches();
    const uploaded: unknown[] = [];
    const fakeTextures = {
      updateTexture(texture: unknown) {
        // Stands in for three: reads `.complete` off the image, which is the
        // exact dereference that has crashed this client three times.
        const image = (texture as MaybeTexture).image as { complete?: boolean } | null;
        if ((texture as MaybeTexture).version! > 0 && image !== undefined) {
          void (image as { complete: boolean }).complete;
        }
        uploaded.push(texture);
      },
    };
    const probed: unknown[] = [];
    const fakeBindings = {
      getForRender(renderObject: unknown) {
        probed.push(renderObject);
        return [];
      },
    };
    const fakeRenderer = { _textures: fakeTextures, _bindings: fakeBindings };
    const quiet: GuardReport = { fatal: () => {}, notice: () => {} };
    const result = installTextureShim(fakeRenderer, quiet);
    if (!result.startsWith('installed')) {
      failures.push(`The shim did not install against a well-formed renderer: "${result}".`);
    }
    if (!result.includes('bindings probe in')) {
      failures.push('The shim installed without the bindings probe, so a catch could not name the mesh it was bound on.');
    }
    // Installing twice must not double-wrap; a stack of wrappers would report
    // one fault several times and slow every upload in the game.
    if (installTextureShim(fakeRenderer, quiet) !== 'already installed') {
      failures.push('Installing the shim twice wrapped the uploader twice.');
    }

    // The interception itself, driven the way three drives it: `getForRender`
    // builds the bindings and the upload happens *inside* that call, which is
    // what lets the probe attribute the texture to a mesh and a material.
    //
    // Built as a second, fresh pair rather than by re-installing over the first:
    // `install` returns early on an already-shimmed uploader, so re-installing
    // would silently skip the probe -- which is exactly the bug the first cut of
    // this check had, and it reported a false failure against a shim that works.
    const offender: MaybeTexture = {
      isTexture: true, name: 'shim_probe', image: null, version: 5, isCanvasTexture: true,
    };
    const mesh = { name: 'probe_mesh', type: 'Mesh', isCamera: false, parent: null };
    const material = { name: 'probe_material', type: 'MeshBasicNodeMaterial' };
    const liveTextures = {
      updateTexture(texture: unknown) {
        const image = (texture as MaybeTexture).image as { complete?: boolean } | null;
        if (((texture as MaybeTexture).version ?? 0) > 0 && image !== undefined) {
          void (image as { complete: boolean }).complete;
        }
      },
    };
    const liveRenderer = {
      _textures: liveTextures,
      _bindings: {
        getForRender(renderObject: unknown) {
          liveRenderer._textures.updateTexture(offender);
          return [renderObject];
        },
      },
    };
    const liveStatus = installTextureShim(liveRenderer, quiet);
    if (!liveStatus.includes('bindings probe in')) {
      failures.push(`The second install did not take the bindings probe: "${liveStatus}".`);
    }
    let threw = false;
    try {
      liveRenderer._bindings.getForRender({ object: mesh, material });
    } catch {
      threw = true;
    }
    if (threw) failures.push('The shim let the uploader throw on a null-image texture; the frame would still die.');
    if (offender.image === null) failures.push('The shim did not repair the texture it intercepted.');
    const caught = shimCatchLines();
    if (caught.length !== 1) {
      failures.push(`The shim recorded ${caught.length} catches for one intercepted texture.`);
    } else {
      for (const want of ['shim_probe', 'isCanvasTexture', 'version=5']) {
        if (!caught[0].includes(want)) failures.push(`The shim's identity line omits ${want}; the report would not identify the texture.`);
      }
      if (!caught[0].includes('probe_mesh') || !caught[0].includes('probe_material')) {
        failures.push('The shim did not record the binding site, which is the whole reason for the bindings probe.');
      }
    }

    // A render-target/depth/storage texture with a null image is NOT a fault --
    // three never reads `image` for those -- and installing one would be damage.
    for (const flag of ['isRenderTargetTexture', 'isDepthTexture', 'isStorageTexture', 'isExternalTexture', 'isFramebufferTexture']) {
      const rt: MaybeTexture = { isTexture: true, name: flag, image: null, version: 3, [flag]: true } as MaybeTexture;
      if (wouldDereferenceNull(rt)) {
        failures.push(`A texture with ${flag} was treated as a fault; three never reads its image.`);
      }
    }
    // And a healthy or version-0 texture must pass through untouched.
    const healthyTex: MaybeTexture = { isTexture: true, image: { width: 2 }, version: 3 };
    const quietTex: MaybeTexture = { isTexture: true, image: null, version: 0 };
    if (wouldDereferenceNull(healthyTex) || wouldDereferenceNull(quietTex)) {
      failures.push('The shim would repair a texture that three handles perfectly well.');
    }
    resetShimCatches();
  }

  // --- Failing safe. A three that renamed the internals must degrade to a
  // logged no-op, never to a boot fatal -- an instrumentation module that can
  // stop the game is worse than no instrumentation.
  for (const shape of [null, undefined, {}, { _textures: null }, { _textures: {} }, { _textures: { updateTexture: 3 } }]) {
    let result = '';
    try {
      result = installTextureShim(shape, { fatal: () => {}, notice: () => {} });
    } catch (err) {
      failures.push(`Installing the shim against ${JSON.stringify(shape)} threw: ${String(err)}. It must degrade quietly.`);
      continue;
    }
    if (!result.startsWith('not installed')) {
      failures.push(`The shim claimed "${result}" against a renderer with no usable uploader.`);
    }
  }

  // --- The guard, against the real exception.
  const scene = makeScene({ name: 'guard_material', map: nullImaged('guard_offender') });
  const fatals: string[] = [];
  const notices: string[] = [];
  const report: GuardReport = { fatal: (m) => void fatals.push(m), notice: (m) => void notices.push(m) };
  const guard = new RenderGuard();
  const thrower = () => {
    const image: { complete?: boolean } | null = null;
    return (image as unknown as { complete: boolean }).complete;
  };

  if (guard.run(() => void thrower(), scene, report) !== false) {
    failures.push('The guard reported a frame that threw as having drawn.');
  }
  if (guard.failures !== 1) failures.push(`One throw was counted ${guard.failures} times.`);
  // It must have repaired on the very first throw -- that is the difference
  // between this cut and the one the player lived through.
  if (guard.quarantined.length !== 1) {
    failures.push(`The guard quarantined ${guard.quarantined.length} things on the first throw, not 1.`);
  }
  if (findOffenders(scene).length !== 0) {
    failures.push('The guard did not repair the offender on the first throw; the scene would stay down.');
  }
  if (fatals.length !== 0) failures.push('A single dropped frame put up the fatal error screen.');
  if (notices.length !== 1) failures.push(`A single dropped frame posted ${notices.length} notices, not 1.`);
  // The notice has to name what was benched, not just say a frame failed.
  if (!notices[0]?.includes('guard_offender')) {
    failures.push('The notice does not name what was benched.');
  }

  // --- A fault that repair cannot fix must still escalate, and the offender
  // must lead the message the player pastes.
  const stubborn = makeScene({ name: 'stubborn_material', map: nullImaged('stubborn') });
  const guard2 = new RenderGuard();
  const fatals2: string[] = [];
  const report2: GuardReport = { fatal: (m) => void fatals2.push(m), notice: () => {} };
  for (let i = 0; i < TRANSIENT_FRAMES + 2; i++) {
    // Re-plant every frame, standing in for a fault the repair cannot hold down.
    (stubborn as unknown as { traverse: (cb: (o: Object3D) => void) => void }).traverse((o) => {
      (o as unknown as { material: Record<string, unknown> }).material.map = nullImaged('stubborn');
    });
    guard2.run(() => void thrower(), stubborn, report2);
  }
  if (fatals2.length !== 1) {
    failures.push(`A persistent render exception raised ${fatals2.length} fatal messages; it must raise exactly 1.`);
  } else {
    const first = fatals2[0].split('\n')[0];
    if (!first.includes('stubborn')) {
      failures.push(`The fatal message does not lead with the offender; its first line is "${first}". Players paste the box, not the console.`);
    }
    if (!fatals2[0].includes('complete')) {
      failures.push('The fatal message does not carry the exception message.');
    }
  }

  // --- Noise. One message, however many frames it throws for.
  const guard3 = new RenderGuard();
  const notices3: string[] = [];
  const report3: GuardReport = { fatal: () => {}, notice: (m) => void notices3.push(m) };
  for (let i = 0; i < 500; i++) guard3.run(() => void thrower(), makeScene(null), report3);
  if (guard3.messages.length !== 1) {
    failures.push(`${guard3.messages.length} distinct messages were recorded for one repeated exception.`);
  }
  guard3.run(() => { throw new Error('a second, different fault'); }, makeScene(null), report3);
  if (guard3.messages.length !== 2) {
    failures.push('A second, different exception was suppressed by the first one.');
  }

  // --- A frame that draws is reported as having drawn and is not charged.
  const before = guard3.failures;
  let drew = false;
  if (guard3.run(() => { drew = true; }, makeScene(null), report3) !== true) {
    failures.push('The guard reported a frame that drew as having thrown.');
  }
  if (!drew) failures.push('The guard did not call the draw closure.');
  if (guard3.failures !== before) failures.push('A frame that drew was counted as a failure.');

  return failures;
}
