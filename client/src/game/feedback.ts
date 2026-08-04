/**
 * What a hit feels like: camera shake, a red pulse, and the reticle.
 *
 * Spec 8.2's feedback clause is "screen shake, loud unrealistic impact, brief
 * hitstop on the attacker" and, separately, "sell it through audio and camera,
 * not gore". Audio is `game/audio.ts`, the hitstop is a phase of the simulation
 * in `game/combat.ts`, and this is the camera half plus the two pieces of screen
 * furniture that go with it.
 *
 * ---------------------------------------------------------------------------
 * Why the shake, the vignette and the reticle are one object.
 *
 * They are one event. A hit taken is 200 ms of shake *and* 200 ms of red, and
 * the two decaying on separate clocks in separate files is the sort of thing
 * that is correct on the day it is written and 30 ms apart six months later. So
 * `hitTaken()` starts both, `update()` decays both, and there is one place to go
 * when the timing needs adjusting. `hud.ts` keeps the *readouts* -- pips,
 * stamina, the respawn countdown, the debug overlay -- which have no timing at
 * all and are pure functions of state.
 *
 * ---------------------------------------------------------------------------
 * The shake is applied after `controller.applyToCamera` and is never written
 * back.
 *
 * This is the one rule in the file. `PlayerState` is the thing prediction and
 * server rewind reconcile against; a screen-shake term inside it would mean the
 * client's yaw and the server's yaw differ by a random number for 200 ms after
 * every punch, and the reconciliation would fight it. So the shake is an offset
 * *composed onto the camera* after the player's own orientation has been set,
 * and `applyToCamera` next frame overwrites it from clean state. Nothing
 * accumulates and nothing leaks.
 *
 * The noise is two sines per axis at 9.8 and 17.9 Hz with an irrational ratio,
 * rather than `Math.random()` per frame. Two reasons, and the second is the one
 * that matters: white noise on the camera at frame rate is *frame-rate
 * dependent* -- it looks like grain at 144 Hz and like a seizure at 30 -- and a
 * sum of sines evaluated at a wall-clock time looks the same at any rate. It is
 * also band-limited, which is what makes 0.6 degrees read as a punch landing
 * rather than as a rendering fault.
 *
 * 0.6 degrees on landing a hit and 1.5 on taking one. The asymmetry is
 * deliberate: the thing the player needs to know when they are hit is *that they
 * were hit*, and the thing they need when they land one is to still be able to
 * aim the next one.
 */

const DEG = Math.PI / 180;

/** Spec 8.2, and the two numbers this file exists to get right. */
const LAND_SECONDS = 0.12;
const LAND_DEGREES = 0.6;
const TAKE_SECONDS = 0.2;
const TAKE_DEGREES = 1.5;

/** How long the red pulse runs. The same window as the shake it accompanies. */
const VIGNETTE_SECONDS = 0.45;
const VIGNETTE_PEAK = 0.62;

/** The reticle's kick. Short -- it is a confirmation, not an animation. */
const RETICLE_SECONDS = 0.16;

/* ---------------------------------------------------------------------------
 * Spec 8.3's Flat White: "Mild screen shake and raised FOV for the duration."
 *
 * Both halves are here rather than anywhere else, for the reason at the top of
 * this file: they are the camera, and the camera is composed after the player's
 * own orientation and never written back. The buzz in particular *must* be --
 * a 0.15-degree jitter inside `PlayerState` would be a permanent disagreement
 * between the client's yaw and the server's for thirty seconds at a time.
 *
 * The two numbers are the only judgement in this block.
 *
 * **0.15 degrees**, against `LAND_DEGREES`'s 0.6 for landing a punch and 1.5
 * for taking one. It has to be an order under the punch, because unlike a hit
 * this runs for thirty seconds continuously and anything a player can
 * consciously see for that long is nausea rather than character. At 0.15 the
 * horizon moves about two pixels at 1440 lines and 72 degrees, which reads as
 * being wired rather than as a rendering fault. It also uses *faster* noise
 * than the impact shake -- the caffeine is a tremor, not a stagger -- and no
 * roll at all, which is the axis that tips a continuous effect into motion
 * sickness fastest.
 *
 * **72 to 80 degrees over 0.5 s.** Eight degrees is the smallest FOV change
 * that reads as speed rather than as a resize, and 0.5 s in and out is slow
 * enough that neither end is a cut. It is eased on the same exponential the
 * knockout camera uses, so a Flat White taken while one is already running does
 * nothing visible at all -- the target has not moved.
 * ------------------------------------------------------------------------- */
const BUZZ_DEGREES = 0.15;
/** The base field of view, and what a Flat White raises it to. */
export const FOV_BASE = 72;
export const FOV_BOOSTED = 80;
/** Time constant of the ease, seconds. */
const FOV_TAU = 0.5;

interface Rotatable {
  rotation: { x: number; y: number; z: number };
}

/** What `applyToCamera` needs. A `PerspectiveCamera` satisfies it. */
interface Viewable extends Rotatable {
  fov: number;
  updateProjectionMatrix(): void;
}

export class Feedback {
  private shakeT = 0;
  private shakeDuration = 0;
  private shakeAmplitude = 0;
  /** Wall-clock seconds, so the noise phase does not restart with each shake. */
  private clock = 0;

  private vignetteT = 0;
  private reticleT = 0;

  /** Spec 8.3's Flat White: 0 or 1, and the eased value chasing it. */
  private buzzTarget = 0;
  private buzz = 0;

  private readonly vignette: HTMLElement | null;
  private readonly reticle: HTMLElement | null;

  constructor() {
    this.vignette = document.getElementById('vignette');
    this.reticle = document.getElementById('reticle');
  }

  /**
   * Turn spec 8.3's Flat White camera on or off.
   *
   * Level-triggered rather than edge-triggered -- `main.ts` passes
   * `flatWhiteT > 0` every frame -- because unlike every other method here this
   * is a *state* and not an event. Calling it sixty times a second with the same
   * value costs one assignment, and it means a powerup that expires while the
   * tab is backgrounded still eases out correctly on the frame it comes back
   * rather than staying on until something remembers to cancel it.
   */
  setCaffeinated(on: boolean): void {
    this.buzzTarget = on ? 1 : 0;
  }

  /**
   * A punch of yours landed on someone else.
   *
   * A knockout you land gets a bigger one, but still under half of what taking a
   * hit gets: it is the only asymmetry in this file and it is the whole reason
   * there are two numbers. The camera you are aiming with should be disturbed by
   * your own successes as little as the impact allows.
   */
  hitLanded(ko = false): void {
    this.startShake(LAND_SECONDS * (ko ? 1.5 : 1), LAND_DEGREES * (ko ? 1.7 : 1) * DEG);
    this.reticleT = RETICLE_SECONDS;
  }

  /** Someone landed one on you. */
  hitTaken(): void {
    this.startShake(TAKE_SECONDS, TAKE_DEGREES * DEG);
    this.vignetteT = VIGNETTE_SECONDS;
  }

  /** The last pip. The same red, held longer, so a knockout reads as more than a hit. */
  knockedOut(): void {
    this.startShake(TAKE_SECONDS * 1.6, TAKE_DEGREES * 1.5 * DEG);
    this.vignetteT = VIGNETTE_SECONDS * 2.2;
  }

  /**
   * Take the stronger of the running shake and the new one rather than adding.
   *
   * Two hits 40 ms apart would otherwise sum to three degrees of camera and read
   * as a rendering fault rather than as a fight. What the new shake is compared
   * against is the *remaining* energy of the running one rather than its peak,
   * so a heavy shake that has almost decayed does not swallow a fresh light one;
   * and a lighter event can only ever extend the clock, never the amplitude, and
   * never past the window that amplitude was authored for.
   */
  private startShake(seconds: number, amplitude: number): void {
    const running = this.shakeT > 0 ? this.shakeAmplitude * (this.shakeT / Math.max(this.shakeDuration, 1e-6)) : 0;
    if (amplitude >= running) {
      this.shakeAmplitude = amplitude;
      this.shakeDuration = seconds;
      this.shakeT = seconds;
    } else {
      this.shakeT = Math.min(this.shakeDuration, Math.max(this.shakeT, seconds * 0.5));
    }
  }

  /** Frame delta, not the fixed step: this is presentation. */
  update(dt: number): void {
    this.clock += dt;
    // Exponential ease, the same one `main.ts` uses for the knockout camera
    // drop. Frame-rate independent by construction, which a linear step toward
    // the target is not.
    this.buzz += (this.buzzTarget - this.buzz) * Math.min(1, 1 - Math.exp(-dt / FOV_TAU));
    if (this.shakeT > 0) this.shakeT = Math.max(0, this.shakeT - dt);
    if (this.vignetteT > 0) {
      this.vignetteT = Math.max(0, this.vignetteT - dt);
      if (this.vignette) {
        // Squared decay: the pulse should be gone well before its clock is, or a
        // long tail reads as "you are still being hurt".
        const k = this.vignetteT / VIGNETTE_SECONDS;
        this.vignette.style.opacity = String(Math.min(1, k * k) * VIGNETTE_PEAK);
      }
    }
    if (this.reticleT > 0) {
      this.reticleT = Math.max(0, this.reticleT - dt);
      if (this.reticle) {
        const k = this.reticleT / RETICLE_SECONDS;
        this.reticle.style.transform = `scale(${1 + k * 2.6})`;
        this.reticle.style.opacity = String(0.72 + k * 0.28);
      }
    }
  }

  /**
   * Compose the shake onto a camera whose orientation is already set.
   *
   * Must run **after** `controller.applyToCamera` and must never write back. See
   * the header.
   */
  applyToCamera(camera: Viewable): void {
    const t = this.clock;

    // Spec 8.3's raised FOV. Written unconditionally while the ease is running
    // *or* settled away from the base, and skipped once it has arrived, because
    // `updateProjectionMatrix` rebuilds a matrix and there is no reason to do
    // that sixty times a second for a player who has not had a coffee.
    const fov = FOV_BASE + (FOV_BOOSTED - FOV_BASE) * this.buzz;
    if (Math.abs(camera.fov - fov) > 1e-3) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }

    // Spec 8.3's "mild screen shake", which is a continuous tremor rather than
    // an event -- higher frequency than the impact shake below and no roll at
    // all. See the constants block for both reasons.
    if (this.buzz > 0.002) {
      const b = this.buzz * BUZZ_DEGREES * DEG;
      camera.rotation.x += b * (Math.sin(t * 143.0) * 0.6 + Math.sin(t * 231.7 + 1.1) * 0.4);
      camera.rotation.y += b * (Math.sin(t * 167.3 + 2.2) * 0.6 + Math.sin(t * 199.1 + 0.4) * 0.4);
    }

    if (this.shakeT <= 0) return;
    // Cubic-ish envelope. A linear decay leaves a visible last frame of tilt; the
    // exponent takes the tail under a tenth of a degree by 60% of the window.
    const k = this.shakeT / Math.max(this.shakeDuration, 1e-6);
    const envelope = k * k * (0.35 + 0.65 * k);
    const a = this.shakeAmplitude * envelope;
    camera.rotation.x += a * (Math.sin(t * 61.7) * 0.62 + Math.sin(t * 112.3 + 1.7) * 0.38);
    camera.rotation.y += a * (Math.sin(t * 54.1 + 2.4) * 0.62 + Math.sin(t * 97.9 + 0.6) * 0.38);
    // Roll at 60%: a rolling camera is the loudest of the three and the one that
    // most easily tips a punch into nausea.
    camera.rotation.z += a * 0.6 * (Math.sin(t * 43.3 + 4.1) * 0.7 + Math.sin(t * 88.7 + 3.2) * 0.3);
  }

  /** For the dev handle: is anything running? */
  get active(): boolean {
    return this.shakeT > 0 || this.vignetteT > 0 || this.reticleT > 0 || this.buzz > 0.002;
  }

  /** For the dev handle and the overlay: how far into the Flat White camera, 0..1. */
  get caffeine(): number {
    return this.buzz;
  }
}
