/**
 * How far in the past to draw remotes, decided from the network rather than
 * written down.
 *
 *     const d = new InterpDelay();
 *     d.arrived(performance.now());   // on every snapshot
 *     d.update(dtSeconds);            // once a frame
 *     const renderTick = serverTick - (d.ms / 1000) * TICK_HZ;
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists
 *
 * `INTERP_DELAY_MS` is 100 and the snapshot interval is 50, so the jitter margin
 * -- the amount a packet may be late before the interpolator has nothing to draw
 * -- is **50 ms, for everybody, forever**. `net/snapshotrate.ts` says so in as
 * many words while arguing about rates: *"a client whose network jitter exceeds
 * that"*. On a good connection 50 ms is enormous. On hotel wifi, a phone
 * tethering, or anyone on the wrong side of the Pacific it is nothing, and what
 * that player sees is not a smooth game with lag -- it is remotes **freezing and
 * jumping**, because `interpolate` deliberately never extrapolates and holds the
 * last position instead.
 *
 * That rule is right and is not what this changes. A frozen remote is the
 * *symptom* of a buffer that ran dry, and the cure is to stop it running dry:
 * measure how unevenly snapshots actually arrive, and hold the render clock
 * further back when they arrive unevenly.
 *
 * ## The ceiling is the rewind window, and it is not a taste decision
 *
 * A client draws remotes `ms` in the past and punches what it sees. The server
 * validates that punch by rewinding, capped at `MAX_REWIND_MS` (250) -- so the
 * delay plus the one-way trip has to fit inside that window or the punch lands
 * on a body the server will not rewind far enough to find, and melee starts
 * missing for exactly the players this was meant to help. `INTERP_DELAY_MAX_MS`
 * is therefore 180, which leaves 70 ms of one-way trip inside the cap;
 * `verifyInterpDelay` asserts the relationship rather than the number, so moving
 * `MAX_REWIND_MS` moves this.
 *
 * ## It eases, and that is the whole of the care
 *
 * The delay is a **clock offset**. Changing it by 40 ms in one frame moves every
 * remote 40 ms through their own history in that frame -- a visible jump, which
 * is the thing this file exists to prevent. So the target may move as fast as
 * the measurement likes and `ms` follows it at `EASE_MS_PER_S`, which is slow
 * enough that a walking remote's position error is under a centimetre a frame.
 *
 * **Up fast, down slow.** Widening is urgent -- the buffer is dry *now* -- so it
 * eases up four times as quickly as it eases back down. Narrowing is pure
 * profit-taking and there is no cost to doing it lazily; narrowing eagerly on a
 * quiet second is how a connection that jitters every few seconds ends up
 * sawing the clock back and forth.
 */

import { INTERP_DELAY_MS, MAX_REWIND_MS, SNAPSHOT_HZ } from './protocol.ts';

/** Never tighter than the shipped constant: spec 10's number is the floor. */
export const INTERP_DELAY_MIN_MS = INTERP_DELAY_MS;

/**
 * Never wider than this. See the header: the delay plus a one-way trip must fit
 * inside `MAX_REWIND_MS` or punches stop landing.
 */
export const INTERP_DELAY_MAX_MS = 180;

/** How much of a one-way trip the ceiling leaves inside the rewind window. */
export const REWIND_HEADROOM_MS = MAX_REWIND_MS - INTERP_DELAY_MAX_MS;

/** Arrival gaps kept. 48 at 20 Hz is 2.4 s -- long enough to see a burst. */
export const WINDOW = 48;

/** How fast `ms` may move toward the target, widening and narrowing. */
export const EASE_UP_MS_PER_S = 160;
export const EASE_DOWN_MS_PER_S = 40;

/**
 * On top of the measured spread, so the buffer is not sized to *exactly* the
 * worst gap seen -- the next one is allowed to be slightly worse than every one
 * before it without starving anything.
 */
export const SAFETY_MS = 12;

/**
 * How much a *proven* starvation adds to the target, and how fast that fades.
 *
 * The gap measurement is a prediction and this is the correction. A dry buffer
 * is not a warning that the delay might be too small -- it is the delay being
 * too small, observed, with a frozen remote on screen as the receipt. Waiting
 * for the arrival window to work that out means the same freeze happens again
 * next second on a connection that is misbehaving in a shape the widest-gap rule
 * does not see: a packet that never arrives leaves no gap to measure, because
 * the gap it would have made is folded into its successor's.
 *
 * It **decays** rather than latching so a single bad moment does not cost the
 * rest of the session 40 ms of extra delay; two seconds of quiet takes it back.
 */
export const STARVE_BOOST_MS = 40;
export const STARVE_DECAY_MS_PER_S = 20;

export class InterpDelay {
  private readonly gaps = new Float64Array(WINDOW);
  private filled = 0;
  private next = 0;
  private last = -1;
  /** Buffer-ran-dry events, for `/stats` and the HUD. Never reset. */
  starved = 0;
  /** The live correction a recent starvation is still asking for, ms. */
  private boost = 0;
  private delay = INTERP_DELAY_MIN_MS;

  /** The delay to draw at, milliseconds. */
  get ms(): number {
    return this.delay;
  }

  /** Where it is heading, for the overlay. */
  get target(): number {
    return this.wanted();
  }

  /** How many gaps have been seen. Under `WINDOW` this is still warming up. */
  get samples(): number {
    return this.filled;
  }

  /**
   * A snapshot landed. `atMs` is `performance.now()`, the same clock
   * `TimedSnapshot.at` is stamped from.
   */
  arrived(atMs: number): void {
    if (this.last >= 0) {
      const gap = atMs - this.last;
      // A gap of a minute is a tab that was backgrounded, not a network that got
      // worse; letting it into the window would peg the delay at its ceiling for
      // the next two seconds of a session that is otherwise fine.
      if (gap >= 0 && gap < 2000) {
        this.gaps[this.next] = gap;
        this.next = (this.next + 1) % WINDOW;
        if (this.filled < WINDOW) this.filled++;
      }
    }
    this.last = atMs;
  }

  /**
   * The interpolator found nothing to draw. Counted **and acted on**: this is
   * the measurement being proven wrong, so it widens the target at once rather
   * than waiting for the arrival window to agree. See `STARVE_BOOST_MS`.
   */
  starve(): void {
    this.starved++;
    this.boost = STARVE_BOOST_MS;
  }

  /** Ease toward the target. `dt` is seconds. */
  update(dt: number): number {
    // The correction fades on the frame clock, so a connection that behaves
    // gives the delay back on its own.
    this.boost = Math.max(0, this.boost - STARVE_DECAY_MS_PER_S * Math.max(0, dt));
    const want = this.wanted();
    const rate = want > this.delay ? EASE_UP_MS_PER_S : EASE_DOWN_MS_PER_S;
    const step = rate * Math.max(0, dt);
    if (want > this.delay) this.delay = Math.min(want, this.delay + step);
    else this.delay = Math.max(want, this.delay - step);
    return this.delay;
  }

  /**
   * The delay the measured arrivals ask for.
   *
   * The **widest** gap in the window rather than a percentile, because the
   * quantity being covered is precisely the worst case: one late packet is one
   * frozen remote, and a p95 that ignores the one gap in twenty that actually
   * starved the buffer is a statistic about a problem rather than an answer to
   * it. The window is short enough (2.4 s) that a single bad burst ages out.
   */
  private wanted(): number {
    if (this.filled === 0) {
      return Math.min(INTERP_DELAY_MAX_MS, INTERP_DELAY_MIN_MS + this.boost);
    }
    let worst = 0;
    for (let i = 0; i < this.filled; i++) if (this.gaps[i] > worst) worst = this.gaps[i];
    const nominal = 1000 / SNAPSHOT_HZ;
    // The buffer has to cover the nominal spacing *plus* however much later than
    // nominal the worst arrival was. A perfectly even stream asks for exactly
    // the floor.
    const late = Math.max(0, worst - nominal);
    const want = nominal + late + SAFETY_MS + this.boost;
    return Math.max(INTERP_DELAY_MIN_MS, Math.min(INTERP_DELAY_MAX_MS, want));
  }
}

export function verifyInterpDelay(): string[] {
  const failures: string[] = [];

  // --- The ceiling is the rewind window's, not a number somebody liked.
  if (INTERP_DELAY_MAX_MS >= MAX_REWIND_MS) {
    failures.push(
      `The interpolation ceiling is ${INTERP_DELAY_MAX_MS} ms against a ${MAX_REWIND_MS} ms rewind cap: ` +
        'a client drawing that far back punches bodies the server will not rewind far enough to find.',
    );
  }
  if (REWIND_HEADROOM_MS < 50) {
    failures.push(`Only ${REWIND_HEADROOM_MS} ms of one-way trip fits inside the rewind window; 50 is the least worth shipping.`);
  }
  if (INTERP_DELAY_MIN_MS !== INTERP_DELAY_MS) {
    failures.push('The floor drifted off `INTERP_DELAY_MS`; spec 10 s number is meant to be the tightest this ever draws.');
  }

  // --- An even stream asks for the floor and nothing more.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW + 4; i++) {
      t += 1000 / SNAPSHOT_HZ;
      d.arrived(t);
    }
    if (Math.abs(d.target - INTERP_DELAY_MIN_MS) > 1e-9) {
      failures.push(`A perfectly even 20 Hz stream asked for ${d.target.toFixed(1)} ms rather than the ${INTERP_DELAY_MIN_MS} ms floor.`);
    }
  }

  // --- A jittery stream asks for more, and never for more than the ceiling.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += i % 8 === 0 ? 140 : 37; // a burst every eighth packet
      d.arrived(t);
    }
    if (d.target <= INTERP_DELAY_MIN_MS) {
      failures.push(`A stream with 140 ms gaps asked for only ${d.target.toFixed(1)} ms; the buffer would run dry.`);
    }
    if (d.target > INTERP_DELAY_MAX_MS) {
      failures.push(`A jittery stream asked for ${d.target.toFixed(1)} ms, over the ${INTERP_DELAY_MAX_MS} ms ceiling.`);
    }
  }

  // --- A pathological stream is clamped rather than believed.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += 900;
      d.arrived(t);
    }
    if (d.target !== INTERP_DELAY_MAX_MS) {
      failures.push(`900 ms gaps asked for ${d.target.toFixed(1)} ms rather than clamping to ${INTERP_DELAY_MAX_MS}.`);
    }
  }

  // --- A backgrounded tab does not poison the window.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += 50;
      d.arrived(t);
    }
    t += 60_000;
    d.arrived(t);
    if (Math.abs(d.target - INTERP_DELAY_MIN_MS) > 1e-9) {
      failures.push(`A minute-long tab-away moved the target to ${d.target.toFixed(1)} ms; it is not a network measurement.`);
    }
  }

  // --- It eases, and it eases up faster than it eases down.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += i % 8 === 0 ? 140 : 37;
      d.arrived(t);
    }
    const start = d.ms;
    const afterOneFrame = d.update(1 / 60);
    if (afterOneFrame <= start) failures.push('A widened target did not move the delay at all.');
    if (afterOneFrame - start > EASE_UP_MS_PER_S / 60 + 1e-9) {
      failures.push(`The delay moved ${(afterOneFrame - start).toFixed(2)} ms in one frame, over the ease rate.`);
    }
    // A one-frame jump a player would see is the failure this rate exists to
    // prevent: 160 ms/s is 2.7 ms on a 60 Hz frame.
    if (EASE_UP_MS_PER_S / 60 > 4) {
      failures.push(`Easing up moves ${(EASE_UP_MS_PER_S / 60).toFixed(1)} ms a frame, which reads as a jump.`);
    }
    if (EASE_DOWN_MS_PER_S >= EASE_UP_MS_PER_S) {
      failures.push('Narrowing is not slower than widening; a connection that jitters in bursts will saw the clock.');
    }
  }

  // --- And it converges on the target rather than overshooting it.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += i % 8 === 0 ? 140 : 37;
      d.arrived(t);
    }
    const want = d.target;
    for (let i = 0; i < 600; i++) d.update(1 / 60);
    if (Math.abs(d.ms - want) > 1e-6) {
      failures.push(`After ten seconds the delay is ${d.ms.toFixed(2)} ms against a target of ${want.toFixed(2)}.`);
    }
  }

  // --- A proven starvation widens the target, and gives it back.
  {
    const d = new InterpDelay();
    let t = 0;
    for (let i = 0; i < WINDOW; i++) {
      t += 1000 / SNAPSHOT_HZ;
      d.arrived(t);
    }
    const calm = d.target;
    d.starve();
    if (d.target <= calm) {
      failures.push(`A dry buffer did not widen the target: still ${d.target.toFixed(1)} ms.`);
    }
    if (d.target > INTERP_DELAY_MAX_MS) {
      failures.push(`A dry buffer pushed the target to ${d.target.toFixed(1)} ms, over the ceiling.`);
    }
    if (d.starved !== 1) failures.push(`The starvation counter reads ${d.starved} after one event.`);
    // ...and two quiet seconds hand it back, so one bad moment does not cost
    // the rest of the session.
    for (let i = 0; i < 60 * 4; i++) d.update(1 / 60);
    if (Math.abs(d.target - calm) > 1e-6) {
      failures.push(`Four quiet seconds left the target at ${d.target.toFixed(1)} ms rather than back at ${calm.toFixed(1)}.`);
    }
    if (d.starved !== 1) failures.push('The counter was reset by the decay; it is a session total.');
  }

  // --- And it works before any arrival has been measured, which is exactly
  //     when a bad connection starves: the first second of a session.
  {
    const d = new InterpDelay();
    d.starve();
    if (d.target <= INTERP_DELAY_MIN_MS) {
      failures.push('A starvation before the first gap was measured did not widen anything.');
    }
  }

  return failures;
}
