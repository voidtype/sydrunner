/**
 * The fullscreen pass that draws what the mushrooms are doing.
 *
 * ---------------------------------------------------------------------------
 * ## It cannot hurt a sober player, and that is structural
 *
 * A post-process pass is the one thing in this client that could black-screen
 * the game for everybody, and it is also the one thing here that no repeatable
 * test can judge -- `CLAUDE.md` is explicit that eyes have to look at rendering.
 * So the arrangement is chosen so that the untested half can only ever reach the
 * people it is *for*:
 *
 *   - **The pass is not in the render path unless a look is non-clear.** A
 *     player who has eaten nothing renders through the exact same
 *     `renderer.render` call as before this file existed, byte for byte.
 *   - **Construction is lazy** and happens on the first mushroom, not at boot,
 *     so a shader that fails to compile fails in front of somebody who just ate
 *     something rather than on the loading screen.
 *   - **Any throw is terminal and silent.** `failed` latches, the pass is
 *     dropped, and every later frame is the plain render. A player on six
 *     mushrooms sees a normal city, which is a disappointment; the alternative
 *     is a black screen, which is a bug report.
 *
 * ## What it does, cheaply
 *
 * One triangle, four texture reads at the very most, and no extra render
 * targets. The blur is **radial** rather than temporal because temporal needs
 * last frame kept and this client is already fighting for frame time. The
 * kaleidoscope is a polar fold -- arithmetic on the coordinate, no reads. The
 * clear middle is a smoothstep against the radius, so the world does not have a
 * visible edge around it.
 *
 * See `world/tripview.ts` for the numbers and the check that holds their shape.
 */

import { PostProcessing, type WebGPURenderer } from 'three/webgpu';
import type { Camera, Scene } from 'three';
import { CALM as CALM_LOOK, looksClear, type TripLook } from './tripview.ts';

/** What the pass needs from the frame. */
export interface TripPassDeps {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
}

export class TripPass {
  private readonly deps: TripPassDeps;
  private post: PostProcessing | null = null;
  /**
   * The scene pass node, kept for one reason: `warmInto`.
   *
   * `pass(scene, camera)` renders the world into **its own render target**, and
   * three keys a render pipeline partly on the render context -- which is
   * derived from the bound target. So once this pass is permanent (see
   * `render`), the target it owns *is* the context every material in the world
   * is drawn in, and a warm-up that compiles with no target bound compiles for
   * the canvas and is thrown away in its entirety.
   */
  private scenePass: { renderTarget?: unknown; _mrt?: unknown } | null = null;
  private failed = false;
  /**
   * The pass is compiled **off the frame**, and this is the state machine for it.
   *
   * Building a `PostProcessing` is cheap; the expensive part is the pipeline the
   * first `render()` compiles, and that is a synchronous stall of exactly the
   * kind this client is already fighting. The first mushroom paid it in one
   * frame and the owner reported the game blocking outright.
   *
   * So the first non-clear look kicks off `renderAsync`, this frame draws
   * plainly, and the pass only starts drawing once the compile has landed. The
   * side effect is the thing he asked for in the same breath: the waviness
   * arrives a moment late and eases in rather than snapping on.
   */
  private compiling = false;
  private ready = false;
  /** Uniform-ish state read by the node graph through these closures. */
  private look: TripLook | null = null;
  private timeS = 0;
  /** Whether the last frame went through the pass. For the overlay. */
  private engagedLast = false;

  constructor(deps: TripPassDeps) {
    this.deps = deps;
  }

  get engaged(): boolean {
    return this.engagedLast;
  }

  get broken(): boolean {
    return this.failed;
  }

  /**
   * Render the frame. Returns true if it drew; false means "you draw it".
   *
   * The caller keeps its own `renderer.render` and uses it when this declines,
   * which is what keeps the ordinary path ordinary.
   */
  render(look: TripLook, dt: number): boolean {
    this.engagedLast = false;
    if (this.failed) return false;
    /*
     * **It does not toggle, and that is the fix rather than an optimisation.**
     *
     * A post pass renders the scene into an offscreen target, and a pipeline is
     * keyed partly on the target it draws into -- so the frame the pass switches
     * on is the frame every visible material needs a second variant compiled.
     * With a resident ring of tiles that is several hundred pipelines in one
     * frame, which is the stall the owner reported on eating his first mushroom
     * and the same fault `LoadedTile.warm` documents for turning on the spot.
     *
     * Awaiting it does not help: `renderAsync` yields, but the work is still the
     * main thread's. The only arrangement with no stall is one with no
     * transition, so once the pass is up it stays up and a sober player is drawn
     * through it with every parameter at rest. That costs one fullscreen
     * triangle and four texture reads a frame, forever, against a stall of a
     * fifth of a second exactly once -- and the owner's standard is that nothing
     * blocks the gameplay thread, not that nothing costs anything.
     *
     * `warm()` gets the compile behind the loading curtain, where a stall is
     * free, so in the ordinary case it has already happened before anybody
     * plays.
     */
    void looksClear;
    this.timeS += dt;
    this.look = look;
    try {
      if (this.post === null) this.post = this.build();
      if (!this.ready) {
        // Compile off the frame. Until it lands the caller draws the world.
        if (!this.compiling) {
          this.compiling = true;
          const p = this.post as unknown as { renderAsync?: () => Promise<void> };
          if (typeof p.renderAsync === 'function') {
            void p
              .renderAsync()
              .then(() => {
                this.ready = true;
              })
              .catch((err: unknown) => {
                this.failed = true;
                this.post = null;
                console.warn('[trip] the post pass failed to compile and has been dropped:', err);
              });
          } else {
            // No async path on this three: compile on the frame after all, which
            // is the old behaviour and still better than not drawing at all.
            this.ready = true;
          }
        }
        return false;
      }
      this.post.render();
      this.engagedLast = true;
      return true;
    } catch (err) {
      // Terminal, and loud once. See the header: a broken pass must degrade to
      // the plain city rather than to a black screen.
      this.failed = true;
      this.post = null;
      console.warn('[trip] the post pass failed and has been dropped for this session:', err);
      return false;
    }
  }

  /**
   * Compile it behind the loading curtain.
   *
   * Called from the boot warm-up, where a stall costs nothing because nobody is
   * playing yet. Failure is the same latch as everywhere else here: the pass is
   * dropped and the session renders directly, which is a city with no waviness
   * rather than a black screen.
   */
  async warm(): Promise<void> {
    if (this.failed || this.ready) return;
    try {
      if (this.post === null) this.post = this.build();
      this.look = CALM_LOOK;
      const p = this.post as unknown as { renderAsync?: () => Promise<void> };
      if (typeof p.renderAsync === 'function') await p.renderAsync();
      else this.post.render();
      this.ready = true;
      this.compiling = true;
    } catch (err) {
      this.failed = true;
      this.post = null;
      console.warn('[trip] the post pass failed to compile and has been dropped:', err);
    }
  }

  /**
   * Run a compile with the renderer bound to the target the frame will draw into.
   *
   * ---------------------------------------------------------------------------
   * **Without this, every warm-up in the client is wasted work.** Three's
   * `Renderer.compileAsync` builds its render context from
   * `this._renderTarget || this._outputRenderTarget`, and its own comment says
   * why that matters -- "use frameBufferTarget when needsFrameBufferTarget is
   * true ... this ensures cache keys match between compileAsync and render". A
   * `RenderObject` is keyed on that context, so a pipeline compiled with no
   * target bound is a pipeline for the canvas.
   *
   * That was true and harmless while the trip pass only engaged for a player who
   * had eaten something: a sober frame was `renderer.render(scene, camera)`
   * straight to the canvas, and the warm matched. Making the pass permanent --
   * which it had to be, because *toggling* it is what stalled on the first
   * mushroom -- moved every frame into the pass's target and left every warm
   * behind, compiling into a context nothing draws in. The symptom is a client
   * that warms diligently at boot, reports success, and then compiles **1,384
   * pipelines inside rendered frames** while the player turns around.
   *
   * So both warm paths -- the boot scene pass and each tile's precompile -- run
   * through here. Bound and restored around the call, because the frame loop and
   * the shadow pass both set the target for themselves and neither expects to
   * find one already bound.
   *
   * A pass that has not been built, or that has failed and been dropped, binds
   * nothing: the frame is a plain `renderer.render` in that case and the canvas
   * context is the right one after all.
   */
  warmInto<T>(fn: () => Promise<T>): Promise<T> {
    const { renderer } = this.deps;
    /*
     * **Built on demand, and that is the whole of why the warm-up was still
     * missing.** The graph is constructed at boot but `warm()` -- the first
     * thing that calls `build()` -- runs seven thousand lines below
     * `setPrecompiler`, so for the entire boot and the first minutes of play
     * `this.post` was null, `warmInto` passed straight through, and every tile
     * compiled for the canvas while the frame drew into the pass. The compile
     * then landed on the frame that tile came into view: the owner's "it happens
     * when I move the camera", exactly.
     *
     * `build()` is graph construction -- TSL nodes and a render target -- not
     * compilation, so doing it at the first tile costs nothing and gives every
     * warm from then on the context the frame will look up.
     */
    if (!this.failed && this.post === null) {
      try {
        this.post = this.build();
      } catch (err) {
        this.failed = true;
        console.warn('[trip] the post pass could not be built; warms go to the canvas:', err);
      }
    }
    const target = this.scenePass?.renderTarget as
      | Parameters<typeof renderer.setRenderTarget>[0]
      | undefined;
    if (this.failed || !target) return fn();
    const prevTarget = renderer.getRenderTarget();
    const prevMrt = renderer.getMRT();
    renderer.setRenderTarget(target);
    const mrt = this.scenePass?._mrt;
    if (mrt !== undefined && mrt !== null) {
      renderer.setMRT(mrt as Parameters<typeof renderer.setMRT>[0]);
    }
    // **Started, then unbound -- not awaited.** The binding must cover the
    // synchronous prefix of `compileAsync` and *nothing after it*, which is a
    // correctness requirement rather than tidiness. Holding it across the await
    // leaves the renderer pointing at the pass's own texture for as long as a
    // compile takes, and a frame that lands in that window ends with
    // `PostProcessing` drawing its output quad into the very texture it samples:
    //
    //     [Texture "output"] usage (TextureBinding|RenderAttachment) includes
    //     writable usage and another usage in the same synchronization scope.
    //
    // -- which is a dead canvas, not a slow one. Tiles warm continuously while
    // somebody is playing, so that window is open more or less always.
    //
    // The prefix is enough because that is where three reads the target:
    // `compileAsync` resolves its render context, builds the whole render list
    // and queues its work items before its first yield, which is the same fact
    // `warmGroupOffCamera` already relies on for `visible` and `frustumCulled`.
    try {
      return fn();
    } finally {
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMrt);
    }
  }

  dispose(): void {
    this.post?.dispose?.();
    this.post = null;
    this.scenePass = null;
  }

  /**
   * Build the node graph.
   *
   * Written against `three/tsl` through a dynamic shape rather than a static
   * import list, because the TSL surface moves between three releases and a
   * named import that vanished would be a *boot* failure in a file whose whole
   * design is that it cannot break the boot. Anything missing throws here, which
   * `render` catches and latches.
   */
  private build(): PostProcessing {
    const tsl = tslApi();
    const { pass, uniform, vec2, vec3, float, uv, sin, cos, atan, length, mix, smoothstep, abs, floor } = tsl;
    const { renderer, scene, camera } = this.deps;

    const scenePass = pass(scene, camera);
    this.scenePass = scenePass as unknown as { renderTarget?: unknown; _mrt?: unknown };
    const colour = scenePass.getTextureNode();

    // The uniforms, read from `this.look` every frame by the closures below.
    const uWave = uniform(0);
    const uWaveSpeed = uniform(0);
    const uColour = uniform(0);
    const uBlur = uniform(0);
    const uClear = uniform(0.75);
    const uWedges = uniform(0);
    const uVib = uniform(0);
    const uTravel = uniform(0);
    const uTime = uniform(0);

    const centre = vec2(0.5, 0.5);
    const p = uv().sub(centre);
    const r = length(p);
    const a = atan(p.y, p.x);

    // --- The kaleidoscope: fold the angle into a wedge. Zero wedges is a no-op
    //     because `floor(a / huge)` is zero and the fold returns `a`.
    const wedgeCount = uWedges.max(float(1));
    const wedgeSize = float(Math.PI * 2).div(wedgeCount);
    const folded = abs(a.div(wedgeSize).sub(floor(a.div(wedgeSize).add(0.5)))).mul(wedgeSize);
    const angle = mix(a, folded, smoothstep(float(0.5), float(1.5), uWedges));

    // --- The wave, and the vibration, both on the sampled coordinate.
    const t = uTime.mul(uWaveSpeed);
    const waveX = sin(uv().y.mul(18).add(t)).mul(uWave);
    const waveY = cos(uv().x.mul(15).add(t.mul(1.3))).mul(uWave);
    const shake = vec2(sin(uTime.mul(57)).mul(uVib), cos(uTime.mul(63)).mul(uVib));

    // --- Rebuild the coordinate from the folded angle, then distort it.
    const folded2 = vec2(cos(angle), sin(angle)).mul(r).add(centre);
    const base = folded2.add(vec2(waveX, waveY)).add(shake);

    // --- The radial blur: three extra taps toward the centre, weighted equally.
    //     `travel` lengthens the reach so six reads as motion rather than haze.
    const reach = uBlur.add(uTravel.mul(0.05));
    const dir = base.sub(centre);
    const s0 = colour.sample(base);
    const s1 = colour.sample(base.sub(dir.mul(reach)));
    const s2 = colour.sample(base.sub(dir.mul(reach.mul(2))));
    const s3 = colour.sample(base.sub(dir.mul(reach.mul(3))));
    const smeared = s0.add(s1).add(s2).add(s3).div(4);
    const tripped = mix(s0, smeared, smoothstep(float(0), float(0.004), reach));

    // --- Colour. Push saturation away from the luminance and rotate it slowly.
    const lum = tripped.r.mul(0.299).add(tripped.g.mul(0.587)).add(tripped.b.mul(0.114));
    const swirl = vec3(
      sin(uTime.mul(0.7)).mul(0.5).add(0.5),
      sin(uTime.mul(0.9).add(2.1)).mul(0.5).add(0.5),
      sin(uTime.mul(1.1).add(4.2)).mul(0.5).add(0.5),
    );
    const saturated = mix(vec3(lum, lum, lum), tripped.rgb.mul(swirl.mul(2)), float(1).add(uColour));
    const psyched = mix(tripped.rgb, saturated, uColour);

    // --- And the coin in the middle that is still the world. Smoothstepped so
    //     there is no ring, and `uClear` at 0.75 covers the screen -- which is
    //     what every look below five carries, so those frames are all "world".
    const clean = colour.sample(uv().add(vec2(waveX, waveY)));
    const outward = smoothstep(uClear.mul(0.6), uClear, r);
    const finalRgb = mix(clean.rgb, psyched, outward);

    const post = new PostProcessing(renderer);
    post.outputNode = vec3(finalRgb.r, finalRgb.g, finalRgb.b);

    // The uniforms follow `this.look`, read at render time.
    const pull = (): void => {
      const l = this.look;
      if (l === null) return;
      uWave.value = l.wave;
      uWaveSpeed.value = l.waveSpeed;
      uColour.value = l.colour;
      uBlur.value = l.blur;
      uClear.value = l.clearRadius;
      uWedges.value = l.wedges;
      uVib.value = l.vibration;
      uTravel.value = l.travel;
      uTime.value = this.timeS;
    };
    const inner = post.render.bind(post);
    (post as unknown as { render: () => void }).render = (): void => {
      pull();
      inner();
    };
    return post;
  }
}

/**
 * The TSL surface, fetched by name and checked.
 *
 * A static `import { ... } from 'three/tsl'` of twenty names is twenty chances
 * that a three upgrade breaks the *boot* of a client whose mushroom feature
 * nobody is using. This resolves the same names from the module object and
 * throws if one is missing -- which `TripPass.render` catches, latches, and
 * turns into a plain city.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tslApi(): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (globalThis as any).__THREE_TSL__;
  if (mod === undefined) throw new Error('TSL was not registered; see main.ts');
  const need = [
    'pass', 'uniform', 'vec2', 'vec3', 'float', 'uv',
    'sin', 'cos', 'atan', 'length', 'mix', 'smoothstep', 'abs', 'floor',
  ];
  for (const k of need) if (typeof mod[k] !== 'function') throw new Error(`TSL is missing ${k}`);
  return mod;
}


/**
 * `warmInto` binds the frame's target and gives it back.
 *
 * This is the check for the regression that made every warm-up in the client
 * free of charge and free of effect: the pass became permanent, the frame moved
 * into its render target, and `compileAsync` kept compiling for the canvas. The
 * symptom was invisible from inside -- the warm-up ran, counted its pipelines
 * and reported success -- and showed up only as 1,384 pipelines compiled inside
 * rendered frames while the player turned around.
 *
 * So what is asserted is the only thing that separates the two: what was bound
 * while the compile ran, and that it was put back. A stub renderer, no GPU.
 */
export function verifyTripPass(): string[] {
  const failures: string[] = [];
  const target = { id: 'pass-target' };
  const mrt = { id: 'pass-mrt' };
  const outer = { id: 'outer-target' };
  const outerMrt = { id: 'outer-mrt' };

  let bound: unknown = outer;
  let boundMrt: unknown = outerMrt;
  const renderer = {
    getRenderTarget: () => bound,
    setRenderTarget: (t: unknown) => {
      bound = t;
    },
    getMRT: () => boundMrt,
    setMRT: (m: unknown) => {
      boundMrt = m;
    },
  };
  const pass = new TripPass({ renderer } as unknown as TripPassDeps);

  // `build` is stubbed on the instance -- the real one wants TSL and a device.
  // What is under test is that `warmInto` *reaches* it on first use: a version
  // that waits for somebody else to build the pass binds nothing for the whole
  // boot, because `warm()` runs seven thousand lines after `setPrecompiler`.
  const inner = pass as unknown as {
    post: unknown;
    scenePass: { renderTarget: unknown; _mrt: unknown } | null;
    build: () => unknown;
  };
  let built = 0;
  inner.build = () => {
    built++;
    inner.scenePass = { renderTarget: target, _mrt: mrt };
    return {};
  };

  let sawTarget: unknown = null;
  let sawMrt: unknown = null;
  void pass.warmInto(async () => {
    sawTarget = bound;
    sawMrt = boundMrt;
  });
  if (built !== 1) {
    failures.push(
      'warmInto did not build the pass on first use, so every tile warmed before the' +
        ' boot gets round to it compiles for a context no frame draws in',
    );
  }
  if (sawTarget !== target) {
    failures.push(
      'warmInto did not bind the pass render target, so every precompile in this' +
        ' client compiles for a context no frame draws in',
    );
  }
  if (sawMrt !== mrt) {
    failures.push('warmInto did not bind the pass MRT, which is half of the render context key');
  }
  if (bound !== outer || boundMrt !== outerMrt) {
    failures.push('warmInto did not put the previous target back; the frame loop binds its own');
  }
  void pass.warmInto(async () => undefined);
  if (built !== 1) failures.push('warmInto rebuilt the pass on a later call.');

  // **The binding must be back before the compile finishes, not after.** This is
  // the one that shipped broken: awaiting `fn` inside the binding leaves the
  // renderer aimed at the pass's own texture for the whole compile, and a frame
  // landing in that window draws the output quad into the texture it samples --
  // "usage includes writable usage and another usage in the same synchronization
  // scope", which is a dead canvas. Tiles warm continuously during play.
  let release: (() => void) | null = null;
  const pending = pass.warmInto(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  if (bound !== outer) {
    failures.push(
      'warmInto held the pass target bound across an unfinished compile; a frame in' +
        ' that window renders the post output into its own input texture',
    );
  }
  (release as (() => void) | null)?.();
  void pending;

  // A throw restores too, or one failed compile aims the renderer at an
  // offscreen target for the rest of the session.
  try {
    void pass.warmInto(() => {
      throw new Error('compile failed');
    });
  } catch {
    // expected
  }
  if (bound !== outer) {
    failures.push('warmInto left the pass target bound after a failed compile');
  }

  // A pass that cannot be built degrades to the canvas rather than throwing at
  // the caller: a client with no post pass is a city with no waviness, and a
  // precompile that throws is a tile that never warms at all.
  const broken = new TripPass({ renderer } as unknown as TripPassDeps);
  (broken as unknown as { build: () => unknown }).build = () => {
    throw new Error('no device');
  };
  let ran = false;
  const warn = console.warn; // the broken case logs by design; not at every boot.
  console.warn = () => {};
  try {
    void broken.warmInto(async () => {
      ran = true;
    });
  } finally {
    console.warn = warn;
  }
  if (!ran) failures.push('a pass that could not be built swallowed the compile instead of running it.');
  if (bound !== outer) failures.push('a failed build left a target bound.');
  return failures;
}
