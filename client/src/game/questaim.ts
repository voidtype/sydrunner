/**
 * Where a job wants you, whatever state it is in.
 *
 * ---------------------------------------------------------------------------
 * ## Why this is not `activeWaypoint`
 *
 * `game/waypoint.activeWaypoint` answers a different question very well: *of the
 * jobs I have already taken, which open step is nearest?* It is the arrow's
 * automatic behaviour and it is right to be automatic.
 *
 * It cannot answer the question a player asks of a **list**, which is "take me to
 * that one" -- because two of the three things a player points at are invisible
 * to it. A job not yet accepted has no cursor, so `activeWaypoint` skips it
 * entirely; a job ready to hand in has no open step, so it skips that too, with
 * an honest note that "the giver is where you go" and the `?` over their head is
 * that feature. Both are true of the *arrow* and neither is true of a register
 * row with a button on it.
 *
 * So this takes the same three states and always produces somewhere to walk:
 *
 *   - **not taken** -> the giver, because that is where the job is.
 *   - **in progress** -> the open step if it has a position, and otherwise the
 *     NPC it names, and otherwise the giver. A `ko` step wants three eshays and
 *     has no coordinates, but "go back to the person who asked" is never wrong
 *     and is much better than an arrow that does not appear.
 *   - **ready to hand in** -> the giver again, which is the one case the arrow
 *     deliberately declines and the one a player most often wants.
 *
 * ## It needs the dialog pack, which is why it is here and not there
 *
 * Every branch above can end at a *person*, and `game/waypoint.ts` only ever had
 * quests and cursors. Positions live on `DialogNpc`, so this file takes both
 * halves of the bundle and `game/waypoint.ts` keeps its narrower one.
 */

import { openStep, type DialogNpc, type Quest, type QuestCursor, type QuestStep } from './questmodel.ts';
import { stepHasPosition } from './waypoint.ts';

/** Which of the three a target is, for the banner and for the check. */
export type AimKind = 'giver' | 'objective' | 'turnin';

export interface AimTarget {
  questId: string;
  x: number;
  z: number;
  kind: AimKind;
  /** The line over the arrow, in the author's words where there are any. */
  text: string;
  /** How close counts as arrived, metres. */
  radius: number;
}

/** How close is "at the giver". Bigger than a step's circle: it is a doorway. */
export const GIVER_RADIUS_M = 12;

/**
 * Where a step is, or `null`.
 *
 * `stepHasPosition` rather than a finiteness test on `x` and `z`, and the
 * difference is not pedantry: every step carries those fields and a `ko` step
 * carries them as **zero**, which is a real point in the middle of the city.
 * Asking the kind is what `game/waypoint.ts` does and there is one list of the
 * kinds that mean it.
 */
function stepPoint(step: QuestStep): { x: number; z: number } | null {
  return stepHasPosition(step) ? { x: step.x, z: step.z } : null;
}

/**
 * Where to point for `quest`, or `null` when there is genuinely nowhere -- a
 * quest whose giver is not in the pack, which is a content fault the register
 * still has to survive.
 */
export function questAim(
  quest: Quest,
  npcs: readonly DialogNpc[],
  cursor: QuestCursor | undefined,
): AimTarget | null {
  const npcById = (id: string): DialogNpc | undefined => npcs.find((n) => n.id === id);
  const giver = npcById(quest.giver);
  const atGiver = (kind: AimKind, text: string): AimTarget | null =>
    giver === undefined
      ? null
      : { questId: quest.id, x: giver.x, z: giver.z, kind, text, radius: GIVER_RADIUS_M };

  if (cursor === undefined) return atGiver('giver', giver ? `see ${giver.name}` : 'the giver');

  const step = openStep(cursor, quest);
  // No open step is a job with its hand out: every counter is full and the only
  // thing left is the walk back.
  if (step === null) return atGiver('turnin', giver ? `hand in to ${giver.name}` : 'hand it in');

  const point = stepPoint(step);
  const text = step.objective !== '' ? step.objective : step.label;
  if (point !== null) {
    return { questId: quest.id, x: point.x, z: point.z, kind: 'objective', text, radius: step.radius };
  }
  // A step with no coordinates. The NPC it names is the next best answer -- a
  // `dialog` step is literally "go and talk to them" -- and the giver is the one
  // after that.
  const named = step.npc !== '' && step.npc !== 'any' && step.npc !== 'player' ? npcById(step.npc) : undefined;
  if (named !== undefined) {
    return { questId: quest.id, x: named.x, z: named.z, kind: 'objective', text, radius: GIVER_RADIUS_M };
  }
  return atGiver('objective', text);
}

export function verifyQuestAim(): string[] {
  const failures: string[] = [];

  const npc = (id: string, x: number, z: number): DialogNpc =>
    ({ id, name: id, x, z, radius: 5, root: 'hello', marker: '', nodes: [] }) as unknown as DialogNpc;
  const npcs = [npc('clerk', 10, 20), npc('eshay', 300, 400)];
  const base = {
    id: 'j',
    act: 0,
    title: 'A Job',
    blurb: '',
    giver: 'clerk',
    level: 1,
    faction: '',
    requires: [],
    needFlags: [],
    denyFlags: [],
    repeatable: false,
    anyRung: false,
    grantsBike: false,
    reward: { cash: 0, xp: 0, unlock: [] },
  };
  const goto = { kind: 'goto', x: 500, z: 600, radius: 30, label: 'go there', objective: 'GO THERE', npc: '', count: 0, powerup: '', line: -1, from: '', to: '', node: '' };
  const ko = { kind: 'ko', x: 0, z: 0, radius: 0, label: 'bat three', objective: '', npc: 'eshay', count: 3, powerup: '', line: -1, from: '', to: '', node: '' };
  const quest = (steps: unknown[]): Quest => ({ ...base, steps } as unknown as Quest);
  const cursor = (s: number, d: boolean, c: number[] = [0]): QuestCursor => ({ s, d, c }) as unknown as QuestCursor;

  // --- Not taken: the giver.
  {
    const t = questAim(quest([goto]), npcs, undefined);
    if (t === null || t.kind !== 'giver' || t.x !== 10 || t.z !== 20) {
      failures.push(`An untaken job pointed at ${JSON.stringify(t)}, not its giver.`);
    }
  }
  // --- In progress on a positioned step: the step.
  {
    const t = questAim(quest([goto]), npcs, cursor(0, false));
    if (t === null || t.kind !== 'objective' || t.x !== 500 || t.z !== 600) {
      failures.push(`An open goto step pointed at ${JSON.stringify(t)}, not its coordinates.`);
    }
    if (t !== null && t.text !== 'GO THERE') failures.push(`The banner read "${t.text}" rather than the authored objective.`);
  }
  // --- In progress on a step with no position: the NPC it names.
  {
    const t = questAim(quest([ko]), npcs, cursor(0, false));
    if (t === null || t.x !== 300 || t.z !== 400) {
      failures.push(`A ko step pointed at ${JSON.stringify(t)} rather than the eshays it names.`);
    }
  }
  // --- ...and the giver when it names nobody findable.
  {
    const orphan = { ...ko, npc: 'nobody-here' };
    const t = questAim(quest([orphan]), npcs, cursor(0, false));
    if (t === null || t.x !== 10 || t.z !== 20) {
      failures.push('A step naming an NPC that is not in the pack did not fall back to the giver.');
    }
  }
  // --- Ready to hand in: the giver, which is the case the arrow declines.
  {
    const t = questAim(quest([goto]), npcs, cursor(0, true));
    if (t === null || t.kind !== 'turnin' || t.x !== 10 || t.z !== 20) {
      failures.push(`A finished job pointed at ${JSON.stringify(t)}, not back at its giver.`);
    }
  }
  // --- A giver who is not in the pack is survived rather than thrown over.
  {
    const t = questAim({ ...base, giver: 'ghost', steps: [ko] } as unknown as Quest, npcs, undefined);
    if (t !== null) failures.push('A quest whose giver is missing produced a target out of nowhere.');
  }
  // --- Every target carries a radius somebody can arrive inside.
  {
    for (const c of [undefined, cursor(0, false), cursor(0, true)]) {
      const t = questAim(quest([goto]), npcs, c);
      if (t !== null && !(t.radius > 0)) failures.push('A target had no arrival radius; nothing could ever reach it.');
    }
  }

  return failures;
}
