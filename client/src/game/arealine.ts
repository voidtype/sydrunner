/**
 * The hero line: the name of where you have just arrived, big, once.
 *
 * The owner: *"just like in GTA and Skyrim i want hero text when i enter a new
 * area, that cleanly and smoothly fades in and out."* Both games do the same
 * thing for the same reason -- a place name said once, large, and gone, is how
 * a world tells you it has places without a map ever having to -- and they
 * differ only in where: GTA writes it low and to the left in a sign-painter's
 * script, Skyrim centres it under the compass in geometric capitals with a
 * rule. This is the Skyrim placement in Sydney's own type; `UI.md` says why.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES A NEW AREA, AND WHY THE ANSWER IS NOT "THE NEAREST LABEL".
 *
 * The bake has no suburb polygons, only the 870 label points in
 * `suburbs.json`, and `game/locator.ts` already names the nearest one for the
 * strip under the map, re-read every three seconds. Announcing every change of
 * *that* would announce a lot: Sydney's suburbs are small, their labels are
 * where the cartographer put them rather than at any centre, and a road along
 * a boundary flips the nearest label every block. So this module owns the
 * decision separately, with three rules the strip does not need:
 *
 * - **Dwell.** A suburb is announced only after it has been the nearest one
 *   for `DWELL_S` continuous seconds. A boundary crossed at speed is one
 *   reading; a suburb you are actually in is many.
 * - **No encores.** A name is not said again within `ENCORE_S` of being said.
 *   The boundary road problem is exactly two names alternating; with the
 *   dwell this makes it say each once and then be quiet.
 * - **One at a time.** A new arrival while one is on screen waits for the
 *   fade-out rather than cutting it: a place name that gets interrupted by
 *   another place name is two names nobody read.
 *
 * ---------------------------------------------------------------------------
 * THE FADE IS ARITHMETIC HERE, NOT A CSS TRANSITION.
 *
 * `opacity` is computed from a clock this module owns and written once a
 * frame by `client/src/arealine.ts`, rather than toggling a class and letting
 * the stylesheet animate. The reason is the same one `world/ground-first.ts`
 * gives for its reveal: a fade the game computes is a fade the game can
 * *check* -- every number below is asserted by `verifyAreaLine` on both boot
 * lists, and the shape of it (a slow rise, a hold, a slower fall, never a
 * step) is the kind of thing that is broken by a refactor and noticed by a
 * player and by nothing in between. The stylesheet still owns how it looks;
 * this owns when.
 *
 * No `Math.sin`; the ease is a cubic, which is all an ease needs to be and
 * keeps the file under DESIGN.md rule 5 should the server ever want it.
 */

/** Seconds the same suburb has to stay nearest before it is announced. */
export const DWELL_S = 2.5;

/** Seconds before a name may be said again. */
export const ENCORE_S = 90;

/** The rise, the hold and the fall, seconds. GTA holds ~3 s; Skyrim ~4 s. */
export const RISE_S = 0.7;
export const HOLD_S = 2.6;
export const FALL_S = 1.3;

/** What the DOM shell draws each frame. */
export interface AreaLineFrame {
  /** The name on screen, or null when nothing is. */
  text: string | null;
  /** 0..1, the curve applied. */
  opacity: number;
  /** 0..1 progress through rise+hold+fall, for the rule's width and the drift. */
  progress: number;
}

/** Ease-out cubic on [0,1]. Pure. */
export function easeOut(t: number): number {
  const u = 1 - Math.max(0, Math.min(1, t));
  return 1 - u * u * u;
}

/** Ease-in-out cubic on [0,1]. Pure. */
export function easeInOut(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 4 * x * x * x : 1 - ((-2 * x + 2) ** 3) / 2;
}

export class AreaLine {
  /** The suburb currently being dwelt in, and for how long. */
  private candidate: string | null = null;
  private dwelt = 0;
  /** What is on screen, and how far through its life. */
  private showing: string | null = null;
  private age = 0;
  /** Waiting for the current one to finish. */
  private queued: string | null = null;
  /** When each name was last said, in this module's own seconds. */
  private readonly said = new Map<string, number>();
  private clock = 0;
  /** The last name announced, for the strip under the map to agree with. */
  private lastSaid: string | null = null;

  /**
   * Advance by `dt` seconds with the nearest suburb as the locator has it
   * (null when it has none yet). Returns what to draw.
   */
  /** A line asked for outright -- a lift arriving at a level -- shown next, dwell and encore be damned. */
  private forced: string | null = null;

  /**
   * Say this now: the lift's *"LEVEL 12"*, in the same device as the suburb.
   * No dwell, no encore rule, and it does not disturb a suburb mid-fade: it
   * follows the line that is up, or begins at once if none is.
   */
  announce(text: string): void {
    if (this.showing === null) this.begin(text);
    else if (this.showing !== text) this.forced = text;
  }

  update(dt: number, nearest: string | null): AreaLineFrame {
    if (!(dt > 0)) dt = 0;
    this.clock += dt;

    // --- Dwell: is the nearest name settled enough to count as arriving?
    if (nearest !== this.candidate) {
      this.candidate = nearest;
      this.dwelt = 0;
    } else {
      this.dwelt += dt;
    }
    if (
      this.candidate !== null &&
      this.dwelt >= DWELL_S &&
      this.candidate !== this.lastSaid &&
      this.candidate !== this.showing &&
      this.candidate !== this.queued
    ) {
      const last = this.said.get(this.candidate);
      if (last === undefined || this.clock - last >= ENCORE_S) {
        if (this.showing === null) this.begin(this.candidate);
        else this.queued = this.candidate;
      }
    }

    // --- The one on screen.
    if (this.showing !== null) {
      this.age += dt;
      const total = RISE_S + HOLD_S + FALL_S;
      if (this.age >= total) {
        this.showing = null;
        this.age = 0;
        if (this.forced !== null) {
          const next = this.forced;
          this.forced = null;
          this.begin(next);
        } else if (this.queued !== null) {
          const next = this.queued;
          this.queued = null;
          // Still the place we are in? Otherwise it was a road we crossed.
          if (next === this.candidate) this.begin(next);
        }
      }
    }
    if (this.showing === null) return { text: null, opacity: 0, progress: 0 };
    const total = RISE_S + HOLD_S + FALL_S;
    const progress = Math.min(1, this.age / total);
    let opacity: number;
    if (this.age < RISE_S) opacity = easeOut(this.age / RISE_S);
    else if (this.age < RISE_S + HOLD_S) opacity = 1;
    else opacity = 1 - easeInOut((this.age - RISE_S - HOLD_S) / FALL_S);
    return { text: this.showing, opacity, progress };
  }

  private begin(name: string): void {
    this.showing = name;
    this.age = 0;
    this.said.set(name, this.clock);
    this.lastSaid = name;
  }

  /** For the debug overlay. */
  stats(): { showing: string | null; queued: string | null; candidate: string | null; dwelt: number } {
    return { showing: this.showing, queued: this.queued, candidate: this.candidate, dwelt: this.dwelt };
  }
}

/** Self-check, on both boot lists. */
export function verifyAreaLine(): string[] {
  const failures: string[] = [];
  // --- An announcement shows at once, and a second one follows the first.
  {
    const line = new AreaLine();
    line.announce('LEVEL 12');
    const f0 = line.update(0.05, null);
    if (f0.text !== 'LEVEL 12') failures.push('an announced line did not show at once.');
    line.announce('LEVEL 13');
    let seen13 = false;
    for (let t = 0; t < 12; t += 0.05) {
      const f = line.update(0.05, null);
      if (f.text === 'LEVEL 13') seen13 = true;
    }
    if (!seen13) failures.push('a line announced during another was dropped.');
  }
  const step = 1 / 60;
  const run = (line: AreaLine, seconds: number, nearest: string | null, onFrame?: (f: AreaLineFrame, t: number) => void): void => {
    for (let t = 0; t < seconds; t += step) {
      const f = line.update(step, nearest);
      onFrame?.(f, t);
    }
  };

  // --- A place is said after the dwell, not before.
  {
    const line = new AreaLine();
    let shownAt = -1;
    run(line, DWELL_S + 0.5, 'Newtown', (f, t) => {
      if (f.text !== null && shownAt < 0) shownAt = t;
    });
    if (shownAt < 0) failures.push('Newtown was never announced.');
    else if (shownAt < DWELL_S - step * 2) failures.push(`Newtown was announced at ${shownAt.toFixed(2)} s, before the ${DWELL_S} s dwell.`);
  }

  // --- The fade rises, holds at one, falls to zero, and never steps.
  {
    const line = new AreaLine();
    let prev = 0;
    let peak = 0;
    let maxJump = 0;
    let holdFrames = 0;
    let began = -1;
    let ended = -1;
    const total = RISE_S + HOLD_S + FALL_S;
    run(line, DWELL_S + total + 1, 'Marrickville', (f, t) => {
      if (f.text !== null && began < 0) began = t;
      if (began < 0) return;
      if (f.opacity > peak) peak = f.opacity;
      if (f.opacity === 1) holdFrames++;
      const jump = Math.abs(f.opacity - prev);
      if (jump > maxJump) maxJump = jump;
      prev = f.opacity;
      if (f.text === null && ended < 0) ended = t - began;
    });
    if (peak < 0.999) failures.push(`the fade peaked at ${peak.toFixed(3)}, never fully in.`);
    if (holdFrames < (HOLD_S - 0.1) * 60) failures.push(`the hold lasted ${(holdFrames / 60).toFixed(2)} s, not ${HOLD_S}.`);
    if (maxJump > 0.08) failures.push(`the fade stepped by ${maxJump.toFixed(3)} in one frame; it should be smooth.`);
    if (ended < 0) failures.push('the line never went away.');
    else if (Math.abs(ended - total) > 0.1) failures.push(`the line lasted ${ended.toFixed(2)} s, not ${total.toFixed(2)}.`);
  }

  // --- A boundary road: two names alternating each second. Each is said
  // once at most, and only if it settles.
  {
    const line = new AreaLine();
    const seen = new Map<string, number>();
    let last: string | null = null;
    for (let t = 0; t < 60; t += step) {
      const nearest = Math.floor(t) % 2 === 0 ? 'Enmore' : 'Stanmore';
      const f = line.update(step, nearest);
      if (f.text !== null && f.text !== last) seen.set(f.text, (seen.get(f.text) ?? 0) + 1);
      last = f.text;
    }
    if (seen.size > 0) failures.push(`a road along a boundary announced ${[...seen.keys()].join(' and ')}; nothing settled for the dwell.`);
  }

  // --- No encores: leave and come straight back, and it stays quiet.
  {
    const line = new AreaLine();
    const shown: string[] = [];
    let last: string | null = null;
    const note = (f: AreaLineFrame): void => {
      if (f.text !== null && f.text !== last) shown.push(f.text);
      last = f.text;
    };
    run(line, 10, 'Glebe', note);
    run(line, 10, 'Forest Lodge', note);
    run(line, 10, 'Glebe', note);
    if (shown.join(',') !== 'Glebe,Forest Lodge') failures.push(`leave and return said: ${shown.join(', ')}; expected Glebe, Forest Lodge.`);
    // And after the encore window, it may be said again.
    run(line, ENCORE_S, 'Forest Lodge');
    run(line, 10, 'Glebe', note);
    if (shown[shown.length - 1] !== 'Glebe' || shown.length !== 3) {
      failures.push(`after ${ENCORE_S} s Glebe should be said again; the record is ${shown.join(', ')}.`);
    }
  }

  // --- One at a time: a second arrival during a fade waits, and only shows
  // if it is still where you are.
  {
    const line = new AreaLine();
    run(line, DWELL_S + 0.5, 'Redfern');
    const shown: string[] = [];
    let last: string | null = null;
    const note = (f: AreaLineFrame): void => {
      if (f.text !== null && f.text !== last) shown.push(f.text);
      last = f.text;
    };
    run(line, DWELL_S + 0.2, 'Waterloo', note);
    run(line, 8, 'Waterloo', note);
    if (shown.join(',') !== 'Redfern,Waterloo') failures.push(`a queued arrival came out as ${shown.join(', ')}.`);
    let overlap = false;
    // Never two names in one frame is trivially true of a single text field;
    // what can go wrong is a cut: check the opacity went to zero between them.
    const line2 = new AreaLine();
    run(line2, DWELL_S + 0.5, 'Redfern');
    let sawZero = false;
    let sawSecond = false;
    run(line2, DWELL_S + 8, 'Waterloo', (f) => {
      if (f.text === 'Redfern' && f.opacity === 0) sawZero = true;
      if (f.text === null) sawZero = true;
      if (f.text === 'Waterloo') {
        sawSecond = true;
        if (!sawZero) overlap = true;
      }
    });
    if (!sawSecond) failures.push('the queued name was never shown.');
    if (overlap) failures.push('the second name cut in before the first had faded out.');
  }

  // --- Nothing, nowhere: null never announces, and a NaN dt is a zero.
  {
    const line = new AreaLine();
    let any = false;
    run(line, 10, null, (f) => {
      if (f.text !== null) any = true;
    });
    if (any) failures.push('an unknown suburb was announced.');
    const f = line.update(NaN, 'Newtown');
    if (f.text !== null || !(f.opacity === 0)) failures.push('a NaN dt did something.');
  }

  // --- The eases are eases.
  if (easeOut(0) !== 0 || easeOut(1) !== 1 || easeOut(0.5) <= 0.5) failures.push('easeOut is not an ease-out.');
  if (easeInOut(0) !== 0 || easeInOut(1) !== 1 || Math.abs(easeInOut(0.5) - 0.5) > 1e-9) failures.push('easeInOut is not symmetric.');

  return failures;
}
