/**
 * Why a render exception must never be allowed to be silent, and how a texture
 * with no image causes one.
 *
 * ---------------------------------------------------------------------------
 * THE REPORTED FAILURE, and the shape of it
 *
 *     Uncaught TypeError: Cannot read properties of null (reading 'complete')
 *         at Textures.updateTexture   (three.webgpu.js:34288)
 *         at Bindings._createBindings (three.webgpu.js:32835)
 *         at Bindings.getForRender    (three.webgpu.js:32714)
 *         at Renderer._renderObjectDirect
 *
 * The player saw the 3D world stop dead while the big map went on animating,
 * which is exactly what this stack produces and is the reason it has to be
 * caught here rather than left to the console. `renderer.render` is called once
 * per frame from one place in `main.ts`; an exception out of it aborts that
 * frame *and every following frame*, because the condition that caused it is
 * still there next time. Nothing else in the client notices. The big map is a
 * 2D canvas on its own rAF, so it keeps painting, and the result is a live,
 * responsive interface in front of a world that has quietly stopped being
 * drawn. That is the worst failure mode this client has: it looks like a
 * graphics stutter rather than a crash, so it does not get reported as one.
 *
 * ---------------------------------------------------------------------------
 * THE THREE.JS DEFECT, read out of r185 rather than guessed
 *
 * `Textures.updateTexture` decides what to upload for a texture like this:
 *
 *     const { width, height, depth } = this.getSize( texture );   // line ~34255
 *     ...
 *     if ( texture.version > 0 ) {
 *         const image = texture.image;
 *         if ( image === undefined )          warn( '...image is undefined.' );
 *         else if ( image.complete === false ) warn( '...image is incomplete.' );
 *         else                                 { ...upload... }
 *     }
 *
 * `getSize`, thirty lines above, is explicitly written to tolerate a falsy
 * image -- `if ( image ) { ... } else { target.width = target.height = 1 }`.
 * The block below it is not: it guards `undefined` and not `null`. So a texture
 * whose `image` is **null** sails through `getSize`, fails `=== undefined`, and
 * dereferences `null.complete`. `image` is `texture.source.data`, so this is any
 * texture whose source carries no data while its `version` has been bumped past
 * zero.
 *
 * A version of 0 is safe: that branch is skipped entirely and the backend binds
 * a placeholder. It is the *combination* -- no image, and `needsUpdate` having
 * been set at some point -- that throws. And it only throws on a **fresh bind
 * group**: `Bindings.getForRender` calls `_createBindings` once per render
 * object ("bind groups are created once per object"), so the crash lands the
 * first time some newly-appearing object is drawn, not at boot. A streamed
 * tile, a spawned prop, a player who just joined.
 *
 * ---------------------------------------------------------------------------
 * WHAT CARRIES A NULL IMAGE, and what this client actually owns
 *
 * The only textures in the client are two, and both hold their backing object
 * for their whole life:
 *
 *   - `world/nameplates.ts` -- one `CanvasTexture` over an `HTMLCanvasElement`
 *     created in the constructor. The canvas is never resized, never replaced
 *     and never released; eviction rewrites *rows inside* it. See
 *     `verifyNameplates`, which now churns a thousand add/evict/re-add cycles
 *     and asserts the image is the same non-null canvas at the end of them.
 *   - `world/params-atlas.ts` -- one `DataTexture` over a `Float32Array` sized
 *     once in the constructor. Allocation and release move offsets within it.
 *
 * Neither can be null, and nothing in the client assigns `.image`, assigns
 * `.source`, constructs a bare `new Texture()`, or loads an image from a URL.
 *
 * The null-image texture that *does* exist in a three WebGPU app is three's
 * own: `texture()`, `textureLoad()` and `uniformTexture()` all default their
 * first argument to a module-level shared `EmptyTexture` singleton --
 * `const EmptyTexture = new Texture()`, whose image is `Texture.DEFAULT_IMAGE`,
 * which is null. Anything handed `undefined` gets that shared object, and
 * because it is shared, a `needsUpdate` set on it anywhere is set on it
 * everywhere. This client's two call sites both pass real textures
 * (`nameplates.ts` its own canvas texture, `facade.ts` the atlas handed down
 * from `streamer.ts`, whose `atlas` is a field initialiser and so always
 * constructed), which is why this was never reproducible from the client's own
 * code -- but it is the class of object the stack is describing, and it is
 * reachable through any three-internal node default.
 *
 * So the honest position, and the one this module takes: the invariant is
 * **"nothing this client draws may bind a texture whose image is null"**, it
 * cannot be established by reading the client's own two textures alone, and it
 * therefore has to be *checked* rather than assumed. `auditSceneTextures` names
 * the offending object when the invariant breaks, which turns an
 * unattributable `null.complete` into a line saying which mesh, which material
 * and which texture -- and `RenderGuard` makes sure somebody sees it.
 */

import type { Object3D } from 'three/webgpu';

// --- Finding a texture with no image ------------------------------------------

/**
 * A material's texture-bearing fields, as this client's materials actually use
 * them.
 *
 * Two shapes have to be covered. Classic slots (`map`, `normalMap`, ...) hold a
 * `Texture` directly and are what a `MeshStandardMaterial` uses. TSL node
 * fields (`colorNode`, `positionNode`, ...) hold a node *graph*, and a texture
 * inside one is a `TextureNode` several levels down -- `facade.ts` reaches its
 * atlas through a `textureLoad` nested under arithmetic under an `Fn`, which no
 * amount of looking at the material's own properties would find. Node graphs
 * are walked with three's own `Node.traverse`.
 */
const CLASSIC_SLOTS = [
  'map', 'alphaMap', 'aoMap', 'bumpMap', 'displacementMap', 'emissiveMap',
  'envMap', 'lightMap', 'metalnessMap', 'normalMap', 'roughnessMap',
  'specularMap', 'clearcoatMap', 'sheenColorMap', 'transmissionMap',
] as const;

interface MaybeTexture {
  isTexture?: boolean;
  name?: string;
  image?: unknown;
  version?: number;
}

interface MaybeNode {
  isNode?: boolean;
  isTextureNode?: boolean;
  value?: unknown;
  traverse?: (cb: (n: MaybeNode) => void) => void;
}

function isTexture(value: unknown): value is MaybeTexture {
  return typeof value === 'object' && value !== null && (value as MaybeTexture).isTexture === true;
}

function isNode(value: unknown): value is MaybeNode {
  return typeof value === 'object' && value !== null && (value as MaybeNode).isNode === true;
}

/**
 * Is this the texture that would throw?
 *
 * Both halves of the condition matter and the second one is the reason this is
 * not simply `image == null`. A null image with `version === 0` is *ordinary*:
 * three binds a placeholder for it and every TSL node that was never handed a
 * texture is in exactly that state, so reporting those would bury the real one
 * in noise. It is the version bump -- some `needsUpdate = true` -- that turns a
 * harmless empty texture into the one that dereferences null.
 */
function wouldThrow(texture: MaybeTexture): boolean {
  const image = texture.image;
  return image === null && (texture.version ?? 0) > 0;
}

function describe(texture: MaybeTexture, owner: string): string {
  const name = texture.name ? `"${texture.name}"` : '(unnamed)';
  return `${owner}: texture ${name} has image === null with version ${texture.version ?? 0}`;
}

/**
 * Every texture bound by the scene whose image is null and whose version has
 * been bumped -- the exact condition `Textures.updateTexture` throws on.
 *
 * Returns one human line per offender, or an empty array when the invariant
 * holds. Cheap enough to run at boot and after a failure, and **never** run per
 * frame: it walks every material's whole node graph.
 *
 * This function must not throw. It is called from inside the catch block that
 * handles a render exception, and an audit that threw there would replace the
 * one diagnostic anybody has with a second, less useful one. Every traversal is
 * wrapped for that reason.
 */
export function auditSceneTextures(scene: Object3D): string[] {
  const failures: string[] = [];
  const seenTextures = new Set<unknown>();
  const seenMaterials = new Set<unknown>();

  const checkTexture = (value: unknown, owner: string): void => {
    if (!isTexture(value) || seenTextures.has(value)) return;
    seenTextures.add(value);
    if (wouldThrow(value)) failures.push(describe(value, owner));
  };

  const checkMaterial = (material: unknown, owner: string): void => {
    if (typeof material !== 'object' || material === null || seenMaterials.has(material)) return;
    seenMaterials.add(material);
    const record = material as Record<string, unknown>;
    const label = typeof record.name === 'string' && record.name ? `${owner} / ${record.name}` : owner;

    for (const slot of CLASSIC_SLOTS) checkTexture(record[slot], `${label}.${slot}`);

    // The node graphs. `Object.keys` rather than a fixed list because
    // `NodeMaterial` grows fields between three releases and a slot this file
    // had not heard of is exactly the one that would hide the bug.
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (!isNode(value)) continue;
      try {
        if (typeof value.traverse === 'function') {
          value.traverse((node) => {
            if (node && node.isTextureNode === true) checkTexture(node.value, `${label}.${key}`);
          });
        } else if (value.isTextureNode === true) {
          checkTexture(value.value, `${label}.${key}`);
        }
      } catch {
        // A node graph that cannot be walked is not evidence of anything, and
        // this function's whole job is to survive being called at a bad moment.
      }
    }
  };

  try {
    scene.traverse((object) => {
      const material = (object as unknown as { material?: unknown }).material;
      if (Array.isArray(material)) {
        for (const m of material) checkMaterial(m, object.name || object.type);
      } else if (material) {
        checkMaterial(material, object.name || object.type);
      }
    });
  } catch {
    // Same argument.
  }

  return failures;
}

// --- Surviving a frame that throws --------------------------------------------

/** What `RenderGuard` needs of the HUD. Structural, so the checks can drive it. */
export interface GuardReport {
  fatal(message: string): void;
  notice(message: string): void;
}

/**
 * Frames a render exception is allowed to be transient for before the player is
 * told the world has stopped.
 *
 * The choice this number encodes: **keep attempting frames rather than halting.**
 * Halting is tempting -- a loop that throws sixty times a second is not doing
 * anything useful -- but it is wrong here for two reasons. The condition that
 * throws is per-bind-group and per-render-object, so a scene that lost one
 * object to it still draws every other object correctly on the next attempt; and
 * the specific failure is a *first-bind* race, which the very next attempt can
 * resolve once the texture's data lands. Halting would turn a recoverable
 * hiccup into a dead session. Whereas an attempt that keeps failing costs
 * nothing but a caught exception, and the guard stops it being noisy.
 *
 * Three frames rather than one because a single dropped frame is not worth a
 * full-screen error, and three at 60 Hz is 50 ms -- under the threshold at which
 * anybody perceives a stall, so nothing is shown for a failure nobody saw.
 */
const TRANSIENT_FRAMES = 3;

/**
 * Runs the frame's render call and makes sure a throw out of it is *seen*.
 *
 * The rules, and why each one:
 *
 *   - **Logged once per unique message, with the full error.** A render
 *     exception repeats every frame by construction, and a console with four
 *     thousand copies of one stack in it is a console nobody reads. The first
 *     one carries the stack, which is the only part that identifies the cause.
 *   - **Audited on first sight.** `auditSceneTextures` runs once per unique
 *     message and names the object, because `null.complete` on its own does not
 *     say which texture and the answer is not recoverable from the stack.
 *   - **Surfaced to the player, not just the console.** A transient failure gets
 *     the pill; one that persists past `TRANSIENT_FRAMES` gets `hud.fatal`,
 *     which is the loading screen in its error styling -- the same treatment
 *     `hud.gpuError` gives an uncaptured WebGPU error, for the same reason. The
 *     failure this exists for is one where everything *except* the 3D view goes
 *     on working, so the interface has to say so itself.
 *   - **It never rethrows.** The rest of the frame -- the HUD update, the frame
 *     timing, the network -- runs whether or not the scene drew.
 */
export class RenderGuard {
  /** Frames that threw, since boot. Nonzero is a bug; the debug object reads it. */
  failures = 0;
  /** Distinct messages seen. For the checks and the console. */
  readonly messages: string[] = [];
  /** The last message surfaced, so a recovery can take its notice back down. */
  private consecutive = 0;
  private fatalShown = false;
  private noticeShown = false;

  /**
   * Draw, and absorb a throw. Returns true if the frame drew.
   *
   * `draw` is passed as a closure rather than `(renderer, scene, camera)` so
   * this stays usable for the checks, which have no renderer.
   */
  run(draw: () => void, scene: Object3D, report: GuardReport): boolean {
    try {
      draw();
    } catch (err) {
      this.onThrow(err, scene, report);
      return false;
    }
    // Recovered. Take back the transient notice, but never the fatal: a session
    // that has already been told the scene cannot be drawn has had its loading
    // screen put back up, and quietly clearing that would be worse than leaving
    // it -- the player has no way to know which state they are in.
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

    if (!this.messages.includes(message)) {
      this.messages.push(message);
      console.error('[render] the frame threw; the 3D scene is not being drawn.', err);
      const audit = auditSceneTextures(scene);
      if (audit.length > 0) {
        console.error(
          '[render] bound textures with no image -- this is the cause:\n' +
            audit.map((line) => '  - ' + line).join('\n'),
        );
      }
    }

    if (this.consecutive >= TRANSIENT_FRAMES) {
      if (this.fatalShown) return;
      this.fatalShown = true;
      const audit = auditSceneTextures(scene);
      report.fatal(
        'The 3D scene stopped being drawn.\n\n' +
          message +
          (audit.length > 0 ? '\n\n' + audit.join('\n') : '') +
          '\n\nThe rest of the interface is still live; the world is not.',
      );
    } else if (!this.noticeShown) {
      this.noticeShown = true;
      report.notice('a frame failed to draw');
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
 * written to fix, wearing a fix's clothes -- the world stops and nothing says
 * so. A guard that surfaces every frame floods the console until the tab dies,
 * which loses the one stack that mattered in four thousand copies of it. A
 * guard that rethrows is no guard at all. And an audit that cannot find a
 * null-image texture reports a clean scene during the exact failure it exists
 * to explain, which is worse than not running: it actively points the reader
 * away from the cause.
 */
export function verifyTextureAudit(): string[] {
  const failures: string[] = [];
  // The guard logs, and this check makes it throw a dozen times on purpose.
  // Left alone that is four `console.error`s and two stacks in front of every
  // boot, which trains the reader to scroll past exactly the message this whole
  // module exists to make them read. Silenced for the duration and restored in
  // `finally`, so a check that throws does not leave the console muted.
  const realError = console.error;
  console.error = () => {};
  try {
    return run(failures);
  } finally {
    console.error = realError;
  }
}

function run(failures: string[]): string[] {

  // A scene stand-in. `auditSceneTextures` only needs `traverse`, and building
  // a real `Scene` here would drag the renderer into a check that must run
  // before there is one.
  const nullImaged = { isTexture: true, name: 'planted', image: null, version: 4 };
  const healthy = { isTexture: true, name: 'fine', image: { width: 4, height: 4 }, version: 4 };
  const quiet = { isTexture: true, name: 'quiet', image: null, version: 0 };
  const makeScene = (...textures: unknown[]): Object3D =>
    ({
      traverse(cb: (o: Object3D) => void) {
        cb({
          name: 'probe',
          type: 'Mesh',
          material: { name: 'probe_material', map: textures[0], colorNode: null },
        } as unknown as Object3D);
        for (let i = 1; i < textures.length; i++) {
          cb({
            name: `probe_${i}`,
            type: 'Mesh',
            material: { name: `probe_material_${i}`, map: textures[i] },
          } as unknown as Object3D);
        }
      },
    }) as unknown as Object3D;

  // --- The audit finds the planted one, and only it.
  const found = auditSceneTextures(makeScene(nullImaged, healthy, quiet));
  if (found.length !== 1) {
    failures.push(`The texture audit found ${found.length} null-image textures in a scene with exactly one.`);
  } else if (!found[0].includes('planted')) {
    failures.push(`The texture audit named "${found[0]}" rather than the planted texture.`);
  }
  // A version-0 empty texture is three's ordinary placeholder state and must not
  // be reported: every TSL node that was never handed a texture is in it.
  if (auditSceneTextures(makeScene(quiet)).length !== 0) {
    failures.push('The texture audit reported a version-0 empty texture, which three binds a placeholder for.');
  }
  if (auditSceneTextures(makeScene(healthy)).length !== 0) {
    failures.push('The texture audit reported a texture that has an image.');
  }

  // --- The guard. A synthetic throw, exactly as `Textures.updateTexture` raises
  // it, has to be caught, counted, surfaced, and not repeated.
  const scene = makeScene(nullImaged);
  const fatals: string[] = [];
  const notices: string[] = [];
  const report: GuardReport = {
    fatal: (m) => void fatals.push(m),
    notice: (m) => void notices.push(m),
  };
  const guard = new RenderGuard();

  const thrower = () => {
    const image: { complete?: boolean } | null = null;
    // The real failure, reproduced: three reads `.complete` off a null image.
    return (image as unknown as { complete: boolean }).complete;
  };

  if (guard.run(() => void thrower(), scene, report) !== false) {
    failures.push('The render guard reported a frame that threw as having drawn.');
  }
  if (guard.failures !== 1) failures.push(`One throw was counted ${guard.failures} times.`);
  // Below the transient threshold: a pill, not the loading screen.
  if (fatals.length !== 0) failures.push('A single dropped frame put up the fatal error screen.');
  if (notices.length !== 1) failures.push(`A single dropped frame posted ${notices.length} notices, not 1.`);

  // Persisting past the threshold: now the player is told properly.
  for (let i = 0; i < TRANSIENT_FRAMES; i++) guard.run(() => void thrower(), scene, report);
  if (fatals.length !== 1) {
    failures.push(`A render exception that persisted past ${TRANSIENT_FRAMES} frames raised ${fatals.length} fatal messages, not 1.`);
  } else {
    if (!fatals[0].includes('complete')) {
      failures.push('The fatal message does not carry the exception message; there would be nothing to report.');
    }
    if (!fatals[0].includes('planted')) {
      failures.push('The fatal message does not name the offending texture, which is the only clue the stack lacks.');
    }
  }
  // Once per unique message, forever.
  for (let i = 0; i < 500; i++) guard.run(() => void thrower(), scene, report);
  if (guard.messages.length !== 1) {
    failures.push(`${guard.messages.length} distinct messages were recorded for one repeated exception.`);
  }
  if (fatals.length !== 1) failures.push(`A repeated exception raised ${fatals.length} fatal messages; it must raise 1.`);

  // A different message is a different fault and is allowed through once.
  guard.run(() => { throw new Error('a second, different fault'); }, scene, report);
  if (guard.messages.length !== 2) {
    failures.push('A second, different exception was suppressed by the first one.');
  }

  // --- A frame that draws must be reported as having drawn, and must not be
  // charged a failure.
  const before = guard.failures;
  let drew = false;
  if (guard.run(() => { drew = true; }, scene, report) !== true) {
    failures.push('The render guard reported a frame that drew as having thrown.');
  }
  if (!drew) failures.push('The render guard did not call the draw closure.');
  if (guard.failures !== before) failures.push('A frame that drew was counted as a failure.');

  return failures;
}
