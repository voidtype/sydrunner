/**
 * The stack of live mushroom buffs, and everything that reads it.
 *
 * ---------------------------------------------------------------------------
 * ## One object, two readers, no second opinion
 *
 * The screen, the buff bar and the simulation all need to know how many brown
 * caps are live and how long each has left, and there is exactly one place that
 * decides: this. `game/mushrooms.tripPowers` turns the count into multipliers
 * the sim applies the way it applies talent effects; `TripStack.icons` turns the
 * same list into what the bar draws. Neither derives the other.
 *
 * ## The clock is the world's, the countdown is the player's
 *
 * A buff lasts three *in-game* hours, which is the number that belongs in the
 * fiction and the number nobody can plan around: the sky runs faster than the
 * wall clock. So the stack stores in-game milliseconds -- the only thing that
 * can expire correctly when the world's clock is what moves -- and the bar
 * converts to real seconds for the icon, because "2:14" on a countdown has to
 * mean two minutes and fourteen seconds of a person's actual life or it is a
 * decoration rather than information. The owner asked for exactly this split.
 *
 * ## Death, and why it lives here
 *
 * A white cap kills. That is not a buff and it is not on the stack, but it is
 * the same swallow, so the *outcome* of eating anything is decided in one
 * function -- `bite` -- and a caller cannot handle the good case and forget the
 * one that kills. Returning a tagged union rather than mutating and hoping is
 * what makes that true at the type level.
 */

import {
  CAP_BROWN,
  CAP_ORANGE,
  CAP_WHITE,
  MAX_STACK,
  buffDurationMs,
  liveTrips,
  realSecondsLeft,
  slowDurationMs,
  tripPowers,
  type CapKind,
  type Trip,
  type TripPowers,
} from './mushrooms.ts';

/** What eating one did. */
export type Bite =
  | { kind: 'trip'; stack: number; addedMs: number }
  | { kind: 'poison'; damage: number; slowUntilMs: number }
  | { kind: 'death' }
  | { kind: 'full'; stack: number };

/** What the bar draws for one live buff. */
export interface TripIcon {
  /** The square. An emoji, because the owner asked for one and it needs no atlas. */
  glyph: string;
  /** Real seconds left, already converted. */
  seconds: number;
  /** The mouseover, in the player's words. */
  fact: string;
}

/** The seven faces of the stack, one per depth. Index 0 is never drawn. */
const GLYPHS: readonly string[] = ['', '🍄', '🍄', '🍄', '🍄', '🌀', '🌈', '👁'];

/**
 * What each depth tells you it is doing, on mouseover.
 *
 * Written as a *promise about the simulation* rather than as flavour, because
 * the whole point of a buff bar is that a player can decide whether to eat
 * another one -- and "you feel strange" is not a decision anybody can make.
 */
const FACTS: readonly string[] = [
  '',
  'Mushroom. You recover a little faster. The trees look interesting.',
  'Two. Recovery is noticeably quicker and the colours have opinions.',
  'Three. You take less, you hit harder, and you stop falling over.',
  'Four. Recovery outpaces a bad exchange. The edges have gone soft.',
  'Five. Nothing knocks you down. Only the middle of the world is still there.',
  'Six. Half the damage in, more than double out, healing through most of it.',
  'Seven. You are not here any more.',
];

/**
 * A countdown a person can read at a glance, in the units it is actually in.
 *
 * It was `m:ss` -- so three in-game hours, which really is seven and a half real
 * minutes, rendered as **"7:30"**, and the owner read it as seven hours and
 * reported the buff as lasting all evening. He was right about the label and the
 * duration was right all along. A colon means whatever the reader assumes; a
 * letter does not, so this never prints one without a unit beside it.
 */
export function countdownText(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? `${m}m` : `${m}m${String(rest).padStart(2, '0')}s`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m === 0 ? `${h}h` : `${h}h${String(m).padStart(2, '0')}m`;
}

export class TripStack {
  private trips: Trip[] = [];
  /** In-game ms until the orange slow lifts. Zero is not slowed. */
  private slowUntil = 0;

  /** How many are live at `nowMs` (in-game). Prunes as it counts. */
  count(nowMs: number): number {
    this.trips = liveTrips(this.trips, nowMs);
    return this.trips.length;
  }

  /** What the sim should apply. See `game/mushrooms.tripPowers`. */
  powers(nowMs: number): TripPowers {
    return tripPowers(this.count(nowMs));
  }

  /** Is the orange cap still in your legs? */
  slowed(nowMs: number): boolean {
    return this.slowUntil > nowMs;
  }

  /** Everything is gone: a knockout, a respawn, the Monday reset. */
  clear(): void {
    this.trips = [];
    this.slowUntil = 0;
  }

  /**
   * Eat one.
   *
   * `msPerGameHour` is how many in-game milliseconds an hour is, which the
   * caller has and this does not.
   */
  bite(cap: CapKind, nowMs: number, msPerGameHour: number): Bite {
    if (cap === CAP_WHITE) {
      // It does not go on the stack and it does not care what is on it.
      return { kind: 'death' };
    }
    if (cap === CAP_ORANGE) {
      this.slowUntil = Math.max(this.slowUntil, nowMs + slowDurationMs(msPerGameHour));
      return { kind: 'poison', damage: 1, slowUntilMs: this.slowUntil };
    }
    if (cap !== CAP_BROWN) return { kind: 'full', stack: this.count(nowMs) };
    const live = this.count(nowMs);
    if (live >= MAX_STACK) return { kind: 'full', stack: live };
    const addedMs = buffDurationMs(msPerGameHour);
    this.trips.push({ endsAtMs: nowMs + addedMs });
    return { kind: 'trip', stack: this.trips.length, addedMs };
  }

  /**
   * The bar, newest last.
   *
   * `gameMsPerRealMs` is the world clock's rate, so the seconds are the
   * player's. Sorted by what expires first, because a bar whose order changes
   * as things tick is a bar nobody can point at.
   */
  icons(nowMs: number, gameMsPerRealMs: number): TripIcon[] {
    const live = liveTrips(this.trips, nowMs).sort((a, b) => a.endsAtMs - b.endsAtMs);
    const depth = live.length;
    return live.map((t, i) => ({
      // Every icon shows the face of the *stack*, not of its own position: five
      // mushrooms are one state, not five separate small ones.
      glyph: GLYPHS[Math.min(depth, MAX_STACK)] || '🍄',
      seconds: realSecondsLeft(t, nowMs, gameMsPerRealMs),
      fact: i === depth - 1 ? FACTS[Math.min(depth, MAX_STACK)] : FACTS[Math.min(i + 1, MAX_STACK)],
    }));
  }
}

export function verifyTrips(): string[] {
  const failures: string[] = [];
  const HOUR = 3_600_000;

  // --- Brown stacks, and stops at seven.
  {
    const s = new TripStack();
    for (let i = 1; i <= MAX_STACK; i++) {
      const b = s.bite(CAP_BROWN, 0, HOUR);
      if (b.kind !== 'trip' || b.stack !== i) failures.push(`The ${i}th brown cap read ${JSON.stringify(b)}.`);
    }
    const over = s.bite(CAP_BROWN, 0, HOUR);
    if (over.kind !== 'full') failures.push('An eighth brown cap was swallowed; seven is the ceiling.');
    if (s.count(0) !== MAX_STACK) failures.push(`The stack holds ${s.count(0)}, not ${MAX_STACK}.`);
  }

  // --- White kills, whatever is on the stack, and does not join it.
  {
    const s = new TripStack();
    s.bite(CAP_BROWN, 0, HOUR);
    const b = s.bite(CAP_WHITE, 0, HOUR);
    if (b.kind !== 'death') failures.push(`A white cap read ${JSON.stringify(b)} rather than killing.`);
    if (s.count(0) !== 1) failures.push('A white cap changed the stack on its way past.');
  }

  // --- Orange costs a pip and takes the legs for half an hour.
  {
    const s = new TripStack();
    const b = s.bite(CAP_ORANGE, 0, HOUR);
    if (b.kind !== 'poison' || b.damage !== 1) failures.push(`An orange cap read ${JSON.stringify(b)}.`);
    if (!s.slowed(HOUR / 4)) failures.push('The slow had lifted a quarter of an hour in.');
    if (s.slowed(HOUR)) failures.push('The slow outlasted its half hour.');
    if (s.count(0) !== 0) failures.push('An orange cap joined the buff stack.');
  }

  // --- Expiry drops the stack a notch at a time.
  {
    const s = new TripStack();
    s.bite(CAP_BROWN, 0, HOUR);
    s.bite(CAP_BROWN, HOUR, HOUR);
    if (s.count(HOUR) !== 2) failures.push('Two live buffs did not read as two.');
    // The first was eaten at 0 and lasts three hours.
    if (s.count(HOUR * 3 + 1) !== 1) failures.push('The older buff did not expire first.');
    if (s.count(HOUR * 5) !== 0) failures.push('The stack never empties.');
  }

  // --- The powers follow the count, and a knockout clears everything.
  {
    const s = new TripStack();
    for (let i = 0; i < 5; i++) s.bite(CAP_BROWN, 0, HOUR);
    if (s.powers(0).regen !== tripPowers(5).regen) failures.push('The stack and the ladder disagree.');
    s.clear();
    if (s.count(0) !== 0 || s.slowed(0)) failures.push('A clear left something behind.');
  }

  // --- The bar counts down in the player's seconds and never reorders.
  {
    const s = new TripStack();
    s.bite(CAP_BROWN, 0, HOUR);
    s.bite(CAP_BROWN, HOUR, HOUR);
    const icons = s.icons(HOUR, 10);
    if (icons.length !== 2) failures.push(`The bar drew ${icons.length} icons for two buffs.`);
    if (icons[0].seconds > icons[1].seconds) failures.push('The bar is not ordered by what expires first.');
    for (const ic of icons) {
      if (!(ic.seconds > 0)) failures.push('A live buff showed no time left.');
      if (ic.glyph === '') failures.push('An icon had no face.');
      if (ic.fact === '') failures.push('An icon had no mouseover; a bar you cannot read is a decoration.');
    }
    // Ten game-ms per real-ms: two in-game hours left is 720 real seconds.
    const left = icons[icons.length - 1].seconds;
    if (Math.abs(left - (HOUR * 3) / 10 / 1000) > 1e-6) {
      failures.push(`A fresh buff read ${left.toFixed(1)} real seconds against the world clock's rate.`);
    }
  }

  // --- The countdown says what unit it is in, always.
  {
    const cases: Array<[number, string]> = [
      [0, '0s'],
      [1, '1s'],
      [45, '45s'],
      // Rounds *up*, so a fraction under a minute is a minute -- a countdown
      // that showed "60s" and then "1m" would tick backwards to a reader.
      [59.2, '1m'],
      [59, '59s'],
      [60, '1m'],
      [90, '1m30s'],
      [450, '7m30s'],
      [3600, '1h'],
      [3720, '1h02m'],
    ];
    for (const [secs, want] of cases) {
      const got = countdownText(secs);
      if (got !== want) failures.push(`${secs}s rendered as "${got}", not "${want}".`);
    }
    // The one that caused the report: three in-game hours must never look like
    // three real ones, or seven.
    if (!countdownText(450).includes('m')) failures.push('A minutes-long countdown does not say minutes.');
    if (countdownText(450).includes(':')) failures.push('The countdown uses a colon, which means whatever the reader assumes.');
    if (countdownText(-5) !== '0s') failures.push('An expired buff counted below zero.');
  }

  return failures;
}
