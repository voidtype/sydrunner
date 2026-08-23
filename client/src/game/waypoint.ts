/**
 * Which way the job is, in one arrow and four words.
 *
 * The problem this exists for is arithmetic rather than taste. A quest giver
 * draws a `!` inside `world/questmarkers.MARKER_RANGE_M`, which is 150 m; ten
 * givers on a rung is therefore about 0.7 km^2 of a 4,528 km^2 world, and a
 * player who has accepted a job in Sydney Park and has to reach a service
 * centre in Redfern has been told the target exists and nothing whatever about
 * where it is. The obligations app carries the tracker line, the big map
 * carries a Centrelink dot, and both of them are screens you have to *decide*
 * to open. What was missing is the thing every game that ships a hundred quests
 * has: a pointer, on the screen you are already looking at, that retires the
 * instant it is satisfied.
 *
 * ---------------------------------------------------------------------------
 * A GENERAL MECHANISM, AND THE ONE RULE THAT MAKES IT SAFE
 *
 * This is deliberately **not** "point at Redfern". The active quest's current
 * step already knows its target -- a `goto` and a `photo` both carry `(x, z)`
 * and a radius, which is the same circle `questmodel.withinStep` closes the
 * step on -- so the waypoint is a *read* of the cursor the server is already
 * keeping, and the hundredth pool quest gets one for free.
 *
 * The rule that makes it safe is that it reads **cursors, never offers**:
 *
 *   - A cursor exists only for a quest the player accepted, and an accept has
 *     already been through `questmodel.questRefusal` on the server. So the
 *     pointer can never name a step the register would not let you take -- it
 *     is pointing at a job you are demonstrably already on.
 *   - The step it points at is `openStep(cursor, quest)`, so it advances with
 *     the cursor and **retires the moment the step completes**: the same frame
 *     the server's sweep moves `cursor.s` past a `goto`, `activeWaypoint`
 *     returns the next positioned step or nothing at all. There is no separate
 *     "clear the waypoint" path to forget to call, which is the failure a
 *     hand-driven pointer always eventually has.
 *   - A step with no position -- `ko`, `buy`, `earn`, `ride`, `dialog` -- has
 *     nowhere to point, and the honest answer to "which way is *knock over
 *     three eshays*" is no arrow rather than a stale one. Those steps show
 *     the banner text with no bearing; see `stepHasPosition`.
 *
 * ---------------------------------------------------------------------------
 * WHY A NEEDLE IN A FIXED BEZEL AND NOT A CHEVRON CLAMPED TO THE SCREEN EDGE
 *
 * Both were on the table and the edge-clamped chevron is the more fashionable
 * one. It was refused for three reasons, in order of how much they cost:
 *
 *   1. **It moves.** A chevron that slides along the frame is a thing the eye
 *      has to find before it can be read, on every glance, and it is competing
 *      with a melee game's actual foreground. A needle that is always in the
 *      same place is learnt once. Skyrim's compass and GTA's minimap arrow are
 *      both fixed for this reason; the edge chevron belongs to games where the
 *      target is a thing you shoot.
 *   2. **It occludes.** The edge of the frame is where the minimap, the vitals,
 *      the controls line and the hint pill already live, and a chevron that
 *      tracks a target 200 degrees round would walk across all four.
 *   3. **It is not testable.** An edge clamp needs the projection matrix, the
 *      viewport and the FOV, which is three things this file would have to be
 *      handed and `verifyWaypoint` would have to fake. A needle needs
 *      `(player x, z, yaw)` and `(target x, z)`, which is five numbers and one
 *      pure function -- and the whole state of the feature is therefore
 *      reachable from a check that runs on a server with no screen.
 *
 * So: a needle at the top of the frame, straight up for dead ahead, the
 * objective under it in capitals, and the distance under that. Everything this
 * file exports is pure and three-free -- `client/src/waypoint.ts` is the ten
 * lines of DOM that spend the answer.
 *
 * ---------------------------------------------------------------------------
 * THE SIGN OF THE BEARING, STATED ONCE, BECAUSE IT IS THE ONE THING HERE THAT
 * IS INVISIBLE WHEN IT IS WRONG
 *
 * This project's yaw is `game/giverbodies.yawOf`: `atan2(-dx, -dz)`, so north
 * (`-z`) is 0, east (`+x`) is `-pi/2`, south is `pi` and west is `+pi/2` --
 * yaw *decreases* clockwise seen from above. CSS `rotate()` is the other way
 * round. Rather than leave a caller to work that out at the point where a sign
 * error is a needle that points at the opposite side of Sydney and looks
 * perfectly plausible, `screenBearing` returns **radians clockwise from
 * straight up on the screen**, which is exactly what the transform wants, and
 * `verifyWaypoint` pins all four compass points.
 */

import { STEP_KIND, openStep, type Quest, type QuestCursors, type QuestStep } from './questmodel.ts';

// --- What a waypoint is ----------------------------------------------------------

/**
 * Which step kinds have somewhere to point.
 *
 * The same two `questmodel.parseStep` fills `x` and `z` for, named here rather
 * than tested by hand at the two call sites so that a third positioned kind
 * arrives in one place.
 */
export const POSITIONED_KINDS: readonly string[] = [STEP_KIND.GOTO, STEP_KIND.PHOTO];

/** Does this step know where it is? */
export function stepHasPosition(step: QuestStep): boolean {
  return POSITIONED_KINDS.includes(step.kind);
}

/** The live objective, resolved. Everything the banner and the needle need. */
export interface Waypoint {
  /** Which job. For the check, and so a caller can tell two apart. */
  questId: string;
  /** The step's index in the quest, so a caller can see it move. */
  stepIndex: number;
  /** The banner line, already clipped and in the author's words. */
  text: string;
  /** Where, world metres, or `null` for a step with nowhere to point. */
  x: number | null;
  z: number | null;
  /** How close counts as arrived. Metres; `questmodel.withinStep`'s circle. */
  radius: number;
}

/**
 * The banner line for a step: the authored objective, or the label.
 *
 * Clipped here rather than trusted, because the fallback is a `label` bounded
 * by `MAX_TITLE_CHARS` (60) and the banner is bounded by `MAX_OBJECTIVE_CHARS`
 * (24) -- so a step that never grew an objective would otherwise put sixty
 * characters across the top of the city. An ellipsis rather than a hard cut, so
 * a clipped line reads as clipped rather than as a typo.
 */
export function waypointBanner(step: QuestStep, max = 24): string {
  const text = step.objective !== '' ? step.objective : step.label;
  const chars = [...text];
  if (chars.length <= max) return text;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * The step this player is being asked for right now, or null.
 *
 * **Nearest first among the open cursors**, which is the one judgement call in
 * this file. A player may hold up to `questmodel.MAX_OPEN` jobs at once and only
 * one arrow can be drawn; the alternatives were "the one accepted most
 * recently" (which a cursor map does not record, and which would swap the arrow
 * out from under somebody halfway across town) and "the first by id" (which is
 * alphabetical order, i.e. nothing). Nearest is the one a player can predict:
 * the arrow points at whichever of your errands you are closest to finishing in
 * metres, and walking toward one never changes which one it is.
 *
 * A positioned step always beats an unpositioned one, because an arrow is
 * strictly more use than a banner with no arrow. Among unpositioned steps the
 * first by quest id serves, and it is genuinely arbitrary -- there is nothing to
 * order them by and nothing on screen that moves.
 *
 * Pure over `(quests, cursors, x, z)`. No `Math.hypot`; squared metres, on this
 * repo's determinism rule -- not because the server evaluates it (it does not)
 * but because the check does, and a comparison that can disagree with itself
 * across two builds is not worth the one call it saves.
 */
export function activeWaypoint(
  quests: readonly Quest[],
  cursors: QuestCursors,
  x: number,
  z: number,
): Waypoint | null {
  let best: Waypoint | null = null;
  let bestD2 = Infinity;
  let fallback: Waypoint | null = null;
  for (const quest of quests) {
    const cursor = cursors[quest.id];
    if (cursor === undefined) continue;
    const step = openStep(cursor, quest);
    // `null` is a cursor that is ready to hand in. There is nowhere to point --
    // the giver is where you go, and the `?` over their head is that feature.
    if (step === null) continue;
    const text = waypointBanner(step);
    if (!stepHasPosition(step)) {
      if (fallback === null) {
        fallback = { questId: quest.id, stepIndex: cursor.s, text, x: null, z: null, radius: step.radius };
      }
      continue;
    }
    const dx = step.x - x;
    const dz = step.z - z;
    const d2 = dx * dx + dz * dz;
    if (best !== null && d2 >= bestD2) continue;
    bestD2 = d2;
    best = { questId: quest.id, stepIndex: cursor.s, text, x: step.x, z: step.z, radius: step.radius };
  }
  return best ?? fallback;
}

// --- The needle ------------------------------------------------------------------

/** `-pi..pi`. `game/giverbodies.wrapPi`, duplicated so this file imports nothing that draws. */
export function wrapPi(a: number): number {
  const twoPi = Math.PI * 2;
  let out = a % twoPi;
  if (out > Math.PI) out -= twoPi;
  if (out < -Math.PI) out += twoPi;
  return out;
}

/**
 * Radians **clockwise from straight up on the screen**. See the header.
 *
 * Zero means the target is dead ahead and the needle points at the top of the
 * frame; `+pi/2` means it is to the player's right. The target being where the
 * player is standing returns zero rather than a `NaN` out of `atan2(0, 0)` --
 * an arrow spinning on the spot at the moment you arrive is the one frame this
 * has to be boring on.
 */
export function screenBearing(px: number, pz: number, tx: number, tz: number, yaw: number): number {
  const dx = tx - px;
  const dz = tz - pz;
  if (dx * dx + dz * dz < 1e-12) return 0;
  // `giverbodies.yawToward` inlined rather than imported: that module reaches
  // into the pedestrian bands and this one must stay importable by the server's
  // boot list with nothing behind it.
  return wrapPi(yaw - Math.atan2(-dx, -dz));
}

/** Metres between two points on the plane. The banner's second line. */
export function waypointRange(px: number, pz: number, tx: number, tz: number): number {
  const dx = tx - px;
  const dz = tz - pz;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * How far, as a person would say it.
 *
 * Metres to a whole number under a kilometre and kilometres to one decimal over
 * it, which is the only place this repo rounds a distance for a human. The
 * crossover is at 1,000 rather than at some hedged 950, because a readout that
 * says "1.0 km" and then "990 m" as you walk toward it looks like it is
 * counting the wrong way.
 */
export function waypointRangeText(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) return '';
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Is this waypoint satisfied where the player is standing?
 *
 * `questmodel.withinStep`'s circle, restated over a `Waypoint` so the banner can
 * go quiet on the frame the player arrives rather than on the tick the server's
 * 4 Hz sweep notices. The two agree by construction -- same centre, same radius,
 * same squared comparison -- so the client never shows an arrow the server has
 * already retired, nor the reverse for longer than 250 ms.
 */
export function waypointReached(w: Waypoint, x: number, z: number): boolean {
  if (w.x === null || w.z === null) return false;
  const dx = x - w.x;
  const dz = z - w.z;
  return dx * dx + dz * dz <= w.radius * w.radius;
}

// --- The self-check ----------------------------------------------------------------

/**
 * Four things, and every one of them is a feature that looks like it is
 * working.
 *
 *   - **A sign error on the bearing** is a needle that points at the far side
 *     of Sydney. It is not detectable by looking at one screenshot, because an
 *     arrow always points somewhere; you find it by walking half a kilometre
 *     the wrong way. All four compass points are pinned below.
 *   - **A waypoint that does not retire** is the whole feature failing in the
 *     one way a player will report as "the game is broken": an arrow still
 *     pointing at a service centre you are standing inside. The cursor moving
 *     past the step is what retires it, so the check moves a cursor.
 *   - **Pointing at a quest nobody is on** would be the register leaking -- an
 *     arrow to a job the rung will refuse -- and it is prevented structurally by
 *     reading `cursors` rather than the bundle, which is exactly the kind of
 *     guarantee that survives right up until somebody "helpfully" widens the
 *     input. Asserted.
 *   - **A banner that is not clipped** wraps across the top of the frame, which
 *     is invisible until somebody authors a long label.
 */
export function verifyWaypoint(): string[] {
  const failures: string[] = [];

  // --- The four compass points, from a player facing north at the origin.
  {
    const cases: Array<[string, number, number, number]> = [
      ['north', 0, -100, 0],
      ['east', 100, 0, Math.PI / 2],
      ['south', 0, 100, Math.PI],
      ['west', -100, 0, -Math.PI / 2],
    ];
    for (const [where, tx, tz, want] of cases) {
      const got = screenBearing(0, 0, tx, tz, 0);
      // South is the wrap point and either sign is the same direction.
      const ok = Math.abs(wrapPi(got - want)) < 1e-9 || Math.abs(Math.abs(got) - Math.PI) < 1e-9;
      if (!ok) {
        failures.push(
          `Facing north, a target due ${where} gives a needle at ${((got * 180) / Math.PI).toFixed(1)} degrees ` +
            `clockwise, not ${((want * 180) / Math.PI).toFixed(0)}.`,
        );
      }
    }
    // And the needle turns with the player rather than with the world: face
    // east and the target due east is now dead ahead.
    if (Math.abs(screenBearing(0, 0, 100, 0, -Math.PI / 2)) > 1e-9) {
      failures.push('Turning to face the target did not bring the needle to straight up.');
    }
    if (screenBearing(50, -20, 50, -20, 0) !== 0) failures.push('A target underfoot produced a spinning needle.');
  }

  // --- The distance text.
  {
    const cases: Array<[number, string]> = [
      [0, '0 m'],
      [239.4, '239 m'],
      [999, '999 m'],
      [1000, '1.0 km'],
      [2340, '2.3 km'],
    ];
    for (const [m, want] of cases) {
      const got = waypointRangeText(m);
      if (got !== want) failures.push(`${m} m reads as ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
    }
    if (waypointRangeText(Number.NaN) !== '') failures.push('A NaN distance drew something.');
    if (Math.abs(waypointRange(0, 0, 3, 4) - 5) > 1e-9) failures.push('waypointRange is not the plane distance.');
  }

  // --- The register, and the retirement. Driven through real cursors.
  {
    const step = (kind: string, x: number, z: number, label: string, objective = ''): QuestStep => ({
      kind: kind as QuestStep['kind'],
      label,
      objective,
      count: 1,
      x,
      z,
      radius: 30,
      npc: 'any',
      powerup: 'any',
      landmark: '',
      line: -1,
      from: '',
      to: '',
      dollars: 0,
      npcId: '',
      node: '',
    });
    const quest = (id: string, steps: QuestStep[]): Quest => ({
      id,
      act: 0,
      title: id,
      blurb: '',
      giver: 'lad',
      level: 1,
      faction: '',
      requires: [],
      needFlags: [],
      denyFlags: [],
      repeatable: false,
    anyRung: false,
      grantsBike: false,
      steps,
      reward: { cash: 0, xp: 0, unlock: [] },
    });
    const tutorial = quest('tut', [
      step(STEP_KIND.GOTO, -925, 2645, 'get to the Redfern service centre', 'GET TO REDFERN'),
      step(STEP_KIND.KO, 0, 0, 'network with locals'),
    ]);
    const other = quest('other', [step(STEP_KIND.GOTO, 0, 0, 'get to the town hall')]);
    const quests = [tutorial, other];

    // Nobody is on anything: no arrow, however many quests exist.
    if (activeWaypoint(quests, {}, 0, 0) !== null) failures.push('A player on no quests was given a waypoint.');

    // On the tutorial: the arrow is the tutorial's, and it is the authored line.
    const cursors: QuestCursors = { tut: { s: 0, c: [0, 0], d: false } };
    const first = activeWaypoint(quests, cursors, -2236, 4543);
    if (first === null) failures.push('A player on a positioned step was given no waypoint.');
    else {
      if (first.questId !== 'tut') failures.push(`The waypoint named ${first.questId}, not the job the player is on.`);
      if (first.text !== 'GET TO REDFERN') failures.push(`The banner read ${JSON.stringify(first.text)}.`);
      if (first.x !== -925 || first.z !== 2645) failures.push('The waypoint is not at the step it names.');
      if (waypointReached(first, -2236, 4543)) failures.push('A waypoint 2.3 km away read as reached.');
      if (!waypointReached(first, -925, 2645)) failures.push('A waypoint read as unreached from its own centre.');
      if (!waypointReached(first, -925 + 29, 2645)) failures.push('A waypoint 29 m inside a 30 m radius read as unreached.');
      if (waypointReached(first, -925 + 31, 2645)) failures.push('A waypoint 31 m outside a 30 m radius read as reached.');
    }

    /*
     * **The retirement.** The cursor moves past the `goto` and the arrow must
     * go with it -- not to the next quest, and not to nothing, but to the step
     * the player is now actually being asked for, which has no position.
     */
    cursors.tut = { s: 1, c: [1, 0], d: false };
    const second = activeWaypoint(quests, cursors, -925, 2645);
    if (second === null) failures.push('Advancing past a goto retired the whole waypoint rather than the step.');
    else {
      if (second.x !== null) failures.push('A ko step was given somewhere to point.');
      if (second.text !== 'network with locals') failures.push(`The banner fell back to ${JSON.stringify(second.text)}.`);
      if (second.stepIndex !== 1) failures.push(`The waypoint is on step ${second.stepIndex}, not the open one.`);
    }
    // And a cursor that is ready to hand in points at nothing at all: the `?`
    // over the giver's head is that feature, not this one.
    cursors.tut = { s: 2, c: [1, 3], d: true };
    if (activeWaypoint(quests, cursors, 0, 0) !== null) failures.push('A finished quest still carried a waypoint.');

    // Two open jobs: the nearer positioned one wins, and walking does not swap
    // the arrow out from under the player.
    const both: QuestCursors = { tut: { s: 0, c: [0, 0], d: false }, other: { s: 0, c: [0], d: false } };
    const nearRedfern = activeWaypoint(quests, both, -900, 2600);
    if (nearRedfern?.questId !== 'tut') failures.push('Standing in Redfern, the arrow did not point at the Redfern job.');
    const nearTownHall = activeWaypoint(quests, both, 20, 20);
    if (nearTownHall?.questId !== 'other') failures.push('Standing at the town hall, the arrow did not point at the town hall job.');

    // A positioned step beats an unpositioned one however far away it is.
    const mixed: QuestCursors = { tut: { s: 1, c: [1, 0], d: false }, other: { s: 0, c: [0], d: false } };
    if (activeWaypoint(quests, mixed, -2236, 4543)?.questId !== 'other') {
      failures.push('An arrow to a distant positioned step lost to a banner with no arrow.');
    }

    // The clip, which is what stops a tracker line crossing the whole frame.
    const wordy = step(STEP_KIND.GOTO, 0, 0, 'get to the Redfern service centre before it closes at four');
    const clipped = waypointBanner(wordy);
    if ([...clipped].length > 24) failures.push(`A ${wordy.label.length}-character label produced a ${clipped.length}-character banner.`);
    if (!clipped.endsWith('…')) failures.push('A clipped banner does not read as clipped.');
    if (waypointBanner(step(STEP_KIND.GOTO, 0, 0, 'short')) !== 'short') failures.push('A short label was clipped anyway.');
    if (stepHasPosition(step(STEP_KIND.KO, 0, 0, 'k'))) failures.push('A ko step claims to know where it is.');
    if (!stepHasPosition(step(STEP_KIND.PHOTO, 0, 0, 'p'))) failures.push('A photo step claims not to know where it is.');
  }

  return failures;
}
