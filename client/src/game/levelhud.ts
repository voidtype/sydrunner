/**
 * The player's level and the kills under it, as a line of text and a bar width.
 *
 * *"i cant se my level or XP anywhere. to be clear player level and wanted level
 * are different"* -- and both halves of that sentence are a separate bug, which
 * is why this file exists rather than three lines inside `hud.ts`.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT WAS INVISIBLE, AND WHY IT WAS INVISIBLE ON PURPOSE
 *
 * Two places drew a level before this pass and both of them **suppressed it at
 * level 1**, each with a written argument for doing so:
 *
 *   - `hud.level` drew `lvl 3` beside the balance and nothing at all at 1,
 *     because *"every guest and every bot in the city is level 1, so a `lvl 1`
 *     on screen would be a permanent label that says nothing about anybody"*.
 *   - `world/nameplates.levelRow` did the same over every head, for the same
 *     reason at five times the ink.
 *
 * Both arguments are correct about a *label* and both are wrong about a
 * *ladder*. A player who has never levelled is exactly the player who needs to
 * be told there is a ladder, and the version of this feature that hides itself
 * until you are already winning is a feature nobody discovers. What the old
 * reasoning was really objecting to is a bare `lvl 1` -- a noun with no verb --
 * and the answer is not to hide it but to say the thing that is actually
 * interesting, which is **how far through it you are**: `LVL 1 · 3/10`.
 *
 * So the suppression is gone here, in `hud.ts` and in `nameplates.levelRow`,
 * and it is gone deliberately rather than by omission. The nameplate keeps its
 * quiet form (`lvl 1`, small, on the left of the badge row) because a plate is
 * read at a glance across a street; the HUD gets the progress, because it is
 * six inches from the player's eye and is the only place a fraction is legible.
 *
 * ---------------------------------------------------------------------------
 * 2. LEVEL IS NOT HEAT, AND THE LAYOUT HAS TO SAY SO
 *
 * *"player level and wanted level are different"* is a report that the interface
 * conflated them, and it did: the nameplate drew `lvl 4 ★★☆☆☆` as one centred
 * group with a small gap, which at plate distance is one badge with a number and
 * some stars in it. They are opposites -- one is what you have earned and one is
 * what you are about to lose -- and the fix is spatial rather than textual:
 * **level on the left of the badge row, stars on the right, and the stars only
 * when there are any.** See `world/nameplates.ts`, which already had the two
 * sides and only had to stop hiding the left one.
 *
 * On the HUD they are not adjacent at all -- the level line is in the vitals
 * cluster in the bottom-left and the star row is over the investigation banner
 * in the middle -- so nothing more was needed there.
 *
 * ---------------------------------------------------------------------------
 * 3. WHY THIS IS A THREE-FREE MODULE WITH A CHECK
 *
 * Everything here is `(level, kills, guest) -> string` and `-> fraction`, which
 * is the shape `hud.ts` cannot be tested in: that file reaches for
 * `document.getElementById` in a field initialiser, so it cannot be imported
 * outside a browser and neither can anything it contains. `game/cash.formatMoney`
 * made the same move for the same reason and `verifyCash` asserts it on both
 * ends; this follows it exactly, and `verifyLevelHud` runs in the browser *and*
 * in `server/index.ts`.
 *
 * The failures are all silent in this repo's sense -- they render. A fraction
 * that is off by one draws `10/10` on a player who has just levelled; a bar
 * width that is not clamped draws a fill wider than its track, which in a
 * `overflow: hidden` box is simply a full bar that never moves again; and a
 * guest line without its suffix is a bar that fills and then does nothing, which
 * is the single most annoying thing a progress bar can do.
 */

import { KILLS_PER_LEVEL, MAX_LEVEL, killsForLevel } from '../net/accounts.ts';

/**
 * How far through the current level a kill count is.
 *
 * Returned as a record rather than three functions, because every caller wants
 * at least two of the three and computing them separately is three chances for
 * the line and the bar to disagree about the same player -- which draws a bar
 * at 100% beside the text `7/10`.
 */
export interface LevelProgress {
  /** Kills earned *since* this level began. 0..`need`. */
  readonly into: number;
  /** Kills needed to finish it. `KILLS_PER_LEVEL`, or 0 at the ceiling. */
  readonly need: number;
  /** `into / need`, clamped to 0..1. 1 at the ceiling. */
  readonly fraction: number;
  /** Is this the top of the ladder, where there is no next level? */
  readonly capped: boolean;
}

/**
 * Where a player is inside their level.
 *
 * **Derived from the level and the kills together rather than from the kills
 * alone**, and that is the one non-obvious decision in this file. `kills % 10`
 * would be shorter and is wrong in the two cases that actually happen:
 *
 *   - **A guest.** Their kills accrue and their level never moves (see
 *     `server/sim.creditLadder`), so at 23 session knockouts `kills % 10` is 3
 *     and the honest answer is that they are 23 kills into level 1 with no
 *     ceiling in sight. Anchoring to `killsForLevel(level)` gives 13/10 --
 *     which is then clamped, so the bar sits full and the line says *"sign up
 *     to level up"*. That is the truth: the bar is full and nothing is
 *     happening, which is exactly the state they are in.
 *   - **The week boundary.** `accounts.resetIfNewWeek` puts the kills back to
 *     zero and the level back to 1 as one operation, but the roster and the
 *     client's mirror of it are separately timed -- so for up to two seconds a
 *     client can hold last week's level beside this week's kills. Anchored, that
 *     draws a bar pinned at empty for two seconds; on `kills % 10` it would draw
 *     a *random* fraction of a level the player no longer has.
 *
 * Clamped at both ends, so no arithmetic below ever has to trust its input.
 */
export function levelProgress(level: number, kills: number): LevelProgress {
  const lvl = clampLevel(level);
  const k = Number.isFinite(kills) && kills > 0 ? Math.floor(kills) : 0;
  if (lvl >= MAX_LEVEL) {
    // The ceiling. `need` is 0 rather than `KILLS_PER_LEVEL` so a caller that
    // divides gets an infinity it can see rather than a plausible fraction of a
    // level that does not exist, and `fraction` is 1 because the bar is full --
    // which is the true statement about somebody at the top of the ladder.
    return { into: 0, need: 0, fraction: 1, capped: true };
  }
  const base = killsForLevel(lvl);
  const into = Math.max(0, Math.min(KILLS_PER_LEVEL, k - base));
  return { into, need: KILLS_PER_LEVEL, fraction: into / KILLS_PER_LEVEL, capped: false };
}

/**
 * The line under the balance: `LVL 1 · 3/10`, or a guest's version of it.
 *
 * **`LVL` in capitals and `·` between the halves**, which is `index.html`'s
 * house style for this cluster rather than a free choice: the element is
 * `text-transform: uppercase` with `.16em` of tracking, so lowercase input would
 * be rendered in capitals anyway and the source would be the only place the two
 * disagreed. The middle dot is the same separator the fare line and the
 * Centrelink prompt use.
 *
 * **The guest suffix is part of the line rather than a second element**, and it
 * has to be: a guest's bar fills to 10/10 and then stops moving forever, and a
 * bar that is full and inert with no explanation beside it is a bug report. The
 * words are `server/sim.creditLadder`'s own once-per-session pill message,
 * repeated permanently here on purpose -- the pill is a moment and this is the
 * state, which is the distinction `Hud.derived`'s header draws at length.
 *
 * At the ceiling the fraction is replaced by `MAX` rather than by `0/0`.
 */
export function levelLine(level: number, kills: number, guest: boolean): string {
  const lvl = clampLevel(level);
  const p = levelProgress(lvl, kills);
  const head = p.capped ? `LVL ${lvl} · MAX` : `LVL ${lvl} · ${p.into}/${p.need}`;
  return guest ? `${head} · sign up to level up` : head;
}

/**
 * The XP bar's fill, as a CSS width.
 *
 * A percentage string rather than a number, on `hud.ballBlockWidth`'s exact
 * contract and for its stated reason: the caller writes it straight into
 * `style.width` and a caller that had to format it would be a second place the
 * clamp could be forgotten. `'0'` rather than `'0%'` at empty, again matching
 * that function -- a zero width needs no unit and the string comparison the HUD
 * does before writing is cheaper on the shorter one.
 *
 * Rounded to whole percent. The bar is 80 CSS pixels at the default vitals
 * scale, so a tenth of a percent is a twelfth of a pixel and the only thing
 * finer granularity buys is a `style.width` write on frames where nothing
 * visibly changed.
 */
export function xpBarWidth(level: number, kills: number): string {
  const f = levelProgress(level, kills).fraction;
  if (!(f > 0)) return '0';
  return `${Math.round(Math.min(1, f) * 100)}%`;
}

/** 1..`MAX_LEVEL`, whatever arrived. A decode error draws a wrong number, not `NaN`. */
function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 1;
  return Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
}

// --- The self-check -------------------------------------------------------------

/**
 * The level line and the bar, asserted.
 *
 * Every failure below renders rather than throws, which is this repo's bar for
 * a check existing at all:
 *
 *   - **A level-1 player shown nothing.** The whole report. Silent by
 *     construction, because the person who wrote the suppression was level 6.
 *   - **An off-by-one fraction.** `10/10` on somebody who has just levelled, or
 *     `0/10` on somebody with nine kills. Both are plausible-looking numbers.
 *   - **A guest with no suffix.** A bar that fills and then does nothing.
 *   - **A bar wider than its track.** `overflow: hidden` turns that into a full
 *     bar that never moves again, which reads as the feature being finished.
 *   - **The ceiling dividing by zero.** `NaN%` in a `style.width` is silently
 *     ignored by every browser, so the bar keeps whatever width it last had.
 *
 * Runs in the browser and in `server/index.ts`. Three-free:
 *
 *     bun -e "import {verifyLevelHud} from './client/src/game/levelhud.ts'; console.log(verifyLevelHud())"
 */
export function verifyLevelHud(): string[] {
  const failures: string[] = [];

  // --- The report itself: a brand-new player is told something.
  //
  // Asserted as "the string contains the level and a fraction" rather than as an
  // exact match, so a change to the separator does not fail this -- what is
  // being defended is that *nothing is hidden*, which is the bug.
  const fresh = levelLine(1, 0, false);
  if (fresh === '' || !fresh.includes('1') || !fresh.includes('0/10')) {
    failures.push(
      `A brand-new player's level line is ${JSON.stringify(fresh)}. It must show the level and the ` +
        `progress: the whole report was "i cant se my level or XP anywhere", and level 1 was the ` +
        `case both the HUD and the nameplate deliberately drew nothing for.`,
    );
  }

  // --- The fraction, at every boundary of one level and across two.
  {
    const cases: Array<[number, number, number]> = [
      // level, kills, expected `into`
      [1, 0, 0],
      [1, 1, 1],
      [1, 9, 9],
      [2, 10, 0], // the kill that levelled them starts the next bar empty
      [2, 13, 3],
      [2, 19, 9],
      [3, 20, 0],
      [7, 65, 5],
    ];
    for (const [level, kills, want] of cases) {
      const got = levelProgress(level, kills).into;
      if (got !== want) {
        failures.push(`Level ${level} with ${kills} kills is ${got}/10 through it; it is ${want}/10.`);
      }
    }
    // The threshold, stated as the property rather than as a table: crossing a
    // level must empty the bar, and `levelFor` is the function that decides when
    // that happens. If these two ever disagree the bar jumps from 9/10 to 1/10
    // and skips the moment the feature exists for.
    for (let kills = 0; kills <= 60; kills++) {
      const level = 1 + Math.floor(kills / KILLS_PER_LEVEL);
      const p = levelProgress(level, kills);
      if (p.into !== kills % KILLS_PER_LEVEL) {
        failures.push(`At ${kills} kills (level ${level}) the bar reads ${p.into}/10, not ${kills % 10}/10.`);
        break;
      }
    }
  }

  // --- A guest, whose kills run past their level and whose bar has to stop.
  {
    const line = levelLine(1, 23, true);
    if (!line.includes('sign up')) {
      failures.push(`A guest's level line is ${JSON.stringify(line)}; it must say how to make the bar mean something.`);
    }
    const p = levelProgress(1, 23);
    if (p.into !== KILLS_PER_LEVEL || p.fraction !== 1) {
      failures.push(
        `A guest 23 kills into a level they can never leave shows ${p.into}/${p.need}. The count is ` +
          `clamped to full: their kills genuinely do accrue and their level genuinely does not move.`,
      );
    }
    // And an account is not given the suffix, which would be the same words
    // shown to somebody who already did what they say.
    if (levelLine(3, 25, false).includes('sign up')) {
      failures.push('A signed-in player was told to sign up.');
    }
  }

  // --- The ceiling: no division by zero and no `0/0` on the screen.
  {
    const p = levelProgress(MAX_LEVEL, 999999);
    if (!p.capped || p.fraction !== 1 || p.need !== 0) {
      failures.push(`At level ${MAX_LEVEL} the progress is ${p.into}/${p.need} at ${p.fraction}; it should be a full, capped bar.`);
    }
    const line = levelLine(MAX_LEVEL, 999999, false);
    if (line.includes('/0') || line.includes('NaN')) {
      failures.push(`The top of the ladder draws ${JSON.stringify(line)}.`);
    }
    const width = xpBarWidth(MAX_LEVEL, 999999);
    if (width !== '100%') failures.push(`A maxed bar is ${width} wide, not 100%.`);
  }

  // --- The bar width: monotone, clamped, and never `NaN%`.
  {
    let previous = -1;
    for (let kills = 0; kills <= 10; kills++) {
      const w = xpBarWidth(1, kills);
      const pct = w === '0' ? 0 : Number.parseInt(w, 10);
      if (!Number.isFinite(pct)) {
        failures.push(`xpBarWidth(1, ${kills}) is ${JSON.stringify(w)}, which a browser silently ignores.`);
        break;
      }
      if (pct < previous) failures.push(`The XP bar went backwards at ${kills} kills: ${previous}% then ${pct}%.`);
      if (pct > 100) failures.push(`The XP bar is ${pct}% wide at ${kills} kills; the track is 100%.`);
      previous = pct;
    }
    if (xpBarWidth(1, 0) !== '0') failures.push(`An empty bar is ${xpBarWidth(1, 0)} rather than a bare zero.`);
    if (xpBarWidth(1, 5) !== '50%') failures.push(`Half a level is ${xpBarWidth(1, 5)} of the bar.`);
  }

  // --- Rubbish in. Every one of these is reachable from a truncated roster
  //     frame or an `?offline` session, and every one of them would otherwise
  //     put `NaN` or `undefined` in front of the player.
  for (const [level, kills] of [[NaN, NaN], [0, -4], [-9, 3], [1e9, 1e9], [2.7, 14.9]] as Array<[number, number]>) {
    const line = levelLine(level, kills, false);
    if (/NaN|undefined|Infinity/.test(line)) {
      failures.push(`levelLine(${level}, ${kills}) drew ${JSON.stringify(line)}.`);
    }
    const width = xpBarWidth(level, kills);
    if (/NaN|undefined|Infinity/.test(width)) {
      failures.push(`xpBarWidth(${level}, ${kills}) is ${JSON.stringify(width)}.`);
    }
  }

  return failures;
}
