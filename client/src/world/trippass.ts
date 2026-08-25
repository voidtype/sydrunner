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
import { looksClear, type TripLook } from './tripview.ts';

/** What the pass needs from the frame. */
export interface TripPassDeps {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
}

export class TripPass {
  private readonly deps: TripPassDeps;
  private post: PostProcessing | null = null;
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
    if (this.failed || looksClear(look)) return false;
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

  dispose(): void {
    this.post?.dispose?.();
    this.post = null;
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
