/**
 * The four lines in the corner: what you are doing, or where the work is.
 *
 * ---------------------------------------------------------------------------
 * ## Why a fifth quest surface, when there are already four
 *
 * There are: a `!` over a giver's head, a gold dot on the compass, a circle on
 * the big map, and the register in the phone. The owner has now twice said the
 * quests are hard to find anyway -- *"im not happy with how hard to discover the
 * quest ux is, rebuild it - should engage ppl"* -- and the reason all four can
 * be working and the complaint still be true is that **every one of them has to
 * be gone and looked at.** Three are pictures you must already be pointing at,
 * and the fourth is two presses inside a handset.
 *
 * What is missing is the thing WoW put in the top right in 2004 and has never
 * taken out: a short list, always up, that says what you are on and how far
 * through it you are. It is not a better map. It is the only quest surface a
 * player does not have to decide to consult, and that is the whole of its value.
 *
 * ## It is never blank, and that is the feature
 *
 * A tracker that empties when you have no job is a tracker that is empty exactly
 * when a player most needs telling something. So the frame has a **fourth
 * state**: with nothing accepted it draws the nearest hub out of
 * `game/questhubs.ts` -- *REDFERN, 4 jobs, 2.1 km* -- and the compass needle can
 * be pointed at it like any other objective.
 *
 * That is the answer to "super clear guiding to new quest areas", and it is
 * deliberately the *same widget* rather than a second one that appears when the
 * first is empty. A player learns one place to look.
 *
 * ## Rule 6, which this is close enough to be worth defending against
 *
 * DESIGN.md: *"The city reacts; the UI does not shout. Prefer the world noticing
 * the player over a toast congratulating them."* There is therefore no completion
 * banner here, no fanfare and no arrival pop-up. A step going from `now` to
 * `done` moves one line of small text; walking into Redfern changes four words in
 * a corner. The tracker is persistent precisely so that it never has to
 * interrupt -- a thing that is always there does not need to announce itself,
 * and that is a cheaper way to obey rule 6 than a toast with a shorter timeout.
 *
 * ## Pure, and the reason is the usual one
 *
 * `client/src/questtracker.ts` is the DOM half and holds four `textContent`
 * writes. Everything that decides anything is here, so the boot list on a server
 * with no screen checks it -- `client/src/waypoint.ts` and `client/src/dialog.ts`
 * are split the same way and for the same reason.
 */

import { questAim, type AimTarget } from './questaim.ts';
import { hubBearingWord, hubCountText, nearestHub, type QuestHub } from './questhubs.ts';
import {
  openStep,
  stepCounter,
  stepLabel,
  type ContentBundle,
  type Quest,
  type QuestCursor,
  type QuestCursors,
} from './questmodel.ts';

/** What the frame is about. `idle` draws nothing at all. */
export type TrackKind = 'objective' | 'turnin' | 'hub' | 'idle';

/** A step's standing in the list. Three, because `done` is worth seeing. */
export type TrackStepState = 'done' | 'now' | 'next';

export interface TrackStep {
  label: string;
  state: TrackStepState;
  /** `2 of 3`, `$40 of $100`, or `''`. `questmodel.stepCounter`'s. */
  counter: string;
}

/** Everything drawn in the corner, and where the arrow should point. */
export interface TrackFrame {
  kind: TrackKind;
  /** The job's title, or the hub's name. */
  title: string;
  /** The line under it: what to do about the title. */
  note: string;
  steps: TrackStep[];
  x: number | null;
  z: number | null;
  /** Metres to `x, z`, or `-1` when there is nowhere. */
  rangeM: number;
  /** `''` for a hub, so a caller can tell a job from a place without a switch. */
  questId: string;
  /** Jobs on the go that this frame is not the one showing. */
  others: number;
}

export const IDLE_FRAME: TrackFrame = {
  kind: 'idle',
  title: '',
  note: '',
  steps: [],
  x: null,
  z: null,
  rangeM: -1,
  questId: '',
  others: 0,
};

/**
 * How many steps the corner will draw.
 *
 * Six. Every authored quest in the pack is at or under it, and a job that
 * somehow is not gets its remainder rolled into the `others` line rather than
 * pushing the vitals off the bottom of a laptop screen.
 */
export const MAX_TRACK_STEPS = 6;

export interface TrackPose {
  x: number;
  z: number;
}

/**
 * Which job the tracker is about, and everything it says about it.
 *
 * The order of preference, which is the only interesting thing in here:
 *
 *   1. **A job the player asked for.** `pinned` comes from the register's *take
 *      me there* and outranks everything, including a nearer job and a finished
 *      one -- an explicit request that gets silently overridden is worse than no
 *      button at all. `client/src/waypoint.ts` reached the same conclusion about
 *      the needle and this is deliberately the same pin.
 *   2. **A finished job**, nearest first. A `?` is money already earned.
 *   3. **The nearest open job**, by how far its next target is rather than by
 *      how far the giver is: a player halfway through something wants the step,
 *      not the desk.
 *   4. **The nearest hub**, when nothing is accepted at all.
 *
 * `pinned` naming a job with no cursor is honoured rather than dropped, and the
 * frame points at its giver -- that is `questAim`'s `'giver'` case and it is
 * exactly what the register's button means when you press it on a job you have
 * not taken.
 */
export function trackFrame(
  bundle: ContentBundle,
  cursors: QuestCursors,
  pose: TrackPose,
  hubs: readonly QuestHub[],
  pinned = '',
): TrackFrame {
  const byId = new Map<string, Quest>();
  for (const q of bundle.quests) byId.set(q.id, q);

  const range = (t: AimTarget): number => Math.sqrt((t.x - pose.x) ** 2 + (t.z - pose.z) ** 2);

  // --- The candidates: every job with a live cursor, plus the pin.
  type Live = { quest: Quest; cursor: QuestCursor | undefined; aim: AimTarget; ready: boolean };
  const live: Live[] = [];
  for (const id of Object.keys(cursors)) {
    const quest = byId.get(id);
    if (quest === undefined) continue;
    const cursor = cursors[id];
    const aim = questAim(quest, bundle.npcs, cursor);
    if (aim === null) continue;
    live.push({ quest, cursor, aim, ready: cursor.d });
  }

  let chosen: Live | null = null;
  if (pinned !== '') {
    const already = live.find((l) => l.quest.id === pinned);
    if (already !== undefined) chosen = already;
    else {
      const quest = byId.get(pinned);
      const aim = quest === undefined ? null : questAim(quest, bundle.npcs, undefined);
      if (quest !== undefined && aim !== null) chosen = { quest, cursor: undefined, aim, ready: false };
    }
  }
  if (chosen === null) {
    for (const l of live) {
      if (chosen === null) {
        chosen = l;
        continue;
      }
      if (l.ready !== chosen.ready) {
        if (l.ready) chosen = l;
        continue;
      }
      if (range(l.aim) < range(chosen.aim)) chosen = l;
    }
  }

  if (chosen !== null) {
    const { quest, cursor, aim } = chosen;
    const steps: TrackStep[] = [];
    const shown = Math.min(quest.steps.length, MAX_TRACK_STEPS);
    for (let i = 0; i < shown; i++) {
      const step = quest.steps[i];
      const at = cursor === undefined ? -1 : cursor.s;
      // A finished job has its cursor past the end, so every step is `done` and
      // none of them is `now`. That is the state the note is about.
      const state: TrackStepState = cursor === undefined ? 'next' : i < at ? 'done' : i === at ? 'now' : 'next';
      steps.push({
        label: stepLabel(step, 44),
        state,
        counter: stepCounter(step, cursor?.c[i] ?? 0),
      });
    }
    const others = live.length - (live.some((l) => l.quest.id === quest.id) ? 1 : 0);
    const open = cursor === undefined ? null : openStep(cursor, quest);
    const note =
      cursor === undefined
        ? aim.text
        : open === null
          ? aim.text
          : open.objective !== ''
            ? open.objective
            : stepLabel(open, 44);
    return {
      kind: aim.kind === 'turnin' ? 'turnin' : 'objective',
      title: quest.title,
      note,
      steps,
      x: aim.x,
      z: aim.z,
      rangeM: range(aim),
      questId: quest.id,
      others,
    };
  }

  // --- Nothing accepted. Where is the work?
  const hub = nearestHub(hubs);
  if (hub === null) return IDLE_FRAME;
  const dx = hub.x - pose.x;
  const dz = hub.z - pose.z;
  return {
    kind: 'hub',
    // A hub with no station near it still gets a name a player can act on,
    // which is a direction. See `hubBearingWord`.
    title: hub.name !== '' ? hub.name : `${hubBearingWord(dx, dz)} of here`,
    note: hubCountText(hub),
    steps: [],
    x: hub.x,
    z: hub.z,
    rangeM: Math.sqrt(dx * dx + dz * dz),
    questId: '',
    others: 0,
  };
}

/** `and 3 more on the go`, or `''`. Kept here so the check can read it. */
export function othersText(others: number): string {
  if (others <= 0) return '';
  return `and ${others} more on the go`;
}

export function verifyQuestTrack(): string[] {
  const failures: string[] = [];

  const npc = (id: string, x: number, z: number): unknown => ({
    id, name: id, x, z, radius: 5, root: 'hello', marker: '', nodes: [],
  });
  const step = (kind: string, x: number, z: number, extra: Record<string, unknown> = {}): unknown => ({
    kind, x, z, radius: 30, label: `do ${kind}`, objective: '', npc: '', count: 0,
    powerup: '', line: -1, from: '', to: '', node: '', dollars: 0, ...extra,
  });
  const quest = (id: string, giver: string, steps: unknown[]): unknown => ({
    id, act: 0, title: id.toUpperCase(), blurb: '', giver, level: 1, faction: '',
    requires: [], needFlags: [], denyFlags: [], repeatable: false, anyRung: false,
    grantsBike: false, reward: { cash: 0, xp: 0, unlock: [] }, steps,
  });

  const bundle = {
    revision: '1',
    npcs: [npc('clerk', 0, 0), npc('deb', 5000, 0)],
    quests: [
      quest('near', 'clerk', [step('goto', 100, 0), step('ko', 0, 0, { npc: 'clerk', count: 3 })]),
      quest('far', 'deb', [step('goto', 6000, 0)]),
    ],
  } as unknown as ContentBundle;
  const pose = { x: 0, z: 0 };
  const cursor = (s: number, d: boolean, c: number[]): QuestCursor => ({ s, d, c }) as unknown as QuestCursor;
  const hubs: QuestHub[] = [
    { x: 800, z: 0, radiusM: 90, offers: 4, turnins: 0, name: 'Redfern', distanceM: 800, members: [0, 1, 2, 3] },
    { x: 200, z: 0, radiusM: 90, offers: 0, turnins: 0, name: 'Empty', distanceM: 200, members: [] },
  ];

  // --- THE ONE THAT MATTERS. Nothing accepted still says somewhere to go.
  {
    const f = trackFrame(bundle, {}, pose, hubs);
    if (f.kind !== 'hub') failures.push(`With no job accepted the tracker drew "${f.kind}", not a hub.`);
    if (f.title !== 'Redfern') failures.push(`The tracker sent the player to "${f.title}".`);
    if (f.note !== '4 jobs') failures.push(`The hub line reads "${f.note}".`);
    if (f.x !== 800) failures.push('The tracker had nowhere to point at a hub it named.');
  }

  // --- A hub with nobody in it is not somewhere to go, even at 200 m.
  {
    const f = trackFrame(bundle, {}, pose, [hubs[1]]);
    if (f.kind !== 'idle') failures.push('An empty hub was offered as work.');
  }

  // --- Truly nothing: blank rather than a lie.
  {
    const f = trackFrame(bundle, {}, pose, []);
    if (f.kind !== 'idle' || f.title !== '') failures.push('An empty city produced a tracker frame.');
  }

  // --- A job in progress beats the hub, and the step states are right.
  {
    const f = trackFrame(bundle, { near: cursor(1, false, [1, 2]) }, pose, hubs);
    if (f.kind !== 'objective') failures.push(`An accepted job drew "${f.kind}".`);
    if (f.questId !== 'near') failures.push(`The tracker followed "${f.questId}".`);
    if (f.steps.length !== 2) failures.push(`A two-step job drew ${f.steps.length} lines.`);
    else {
      if (f.steps[0].state !== 'done') failures.push('A step the player is past is not struck through.');
      if (f.steps[1].state !== 'now') failures.push('The open step is not marked as the open one.');
      if (f.steps[1].counter !== '2 of 3') failures.push(`The counter reads "${f.steps[1].counter}", not "2 of 3".`);
      if (f.steps[0].counter !== '') failures.push('A single-shot step drew "0 of 1".');
    }
  }

  // --- A finished job outranks a nearer unfinished one. A `?` is money.
  {
    const f = trackFrame(
      bundle,
      { near: cursor(0, false, [0, 0]), far: cursor(1, true, [1]) },
      pose,
      hubs,
    );
    if (f.questId !== 'far') failures.push(`Holding a finished job five kilometres away, the tracker showed "${f.questId}".`);
    if (f.kind !== 'turnin') failures.push(`A finished job drew "${f.kind}", not a hand-in.`);
    if (f.x !== 5000) failures.push('A finished job did not point back at its giver.');
    if (f.others !== 1) failures.push(`The tracker said ${f.others} other jobs were on the go, not 1.`);
    if (f.steps.some((s) => s.state === 'now')) failures.push('A finished job still had an open step.');
  }

  // --- Nearest by the *step*, not by the giver.
  {
    const f = trackFrame(bundle, { near: cursor(0, false, [0, 0]), far: cursor(0, false, [0]) }, pose, hubs);
    if (f.questId !== 'near') failures.push('The tracker did not choose the job whose next step is nearest.');
  }

  // --- The pin outranks both, including on a job not yet taken.
  {
    const on = trackFrame(bundle, { near: cursor(0, false, [0, 0]) }, pose, hubs, 'far');
    if (on.questId !== 'far') failures.push('A pinned job was overridden by a nearer one.');
    const untaken = trackFrame(bundle, {}, pose, hubs, 'far');
    if (untaken.questId !== 'far' || untaken.x !== 5000) {
      failures.push('Asking to be taken to a job not yet accepted did not point at its giver.');
    }
    if (untaken.steps.some((s) => s.state !== 'next')) {
      failures.push('An untaken job showed progress it cannot have.');
    }
  }

  // --- A pin naming nothing falls through rather than blanking the corner.
  {
    const f = trackFrame(bundle, {}, pose, hubs, 'a-quest-that-was-deleted');
    if (f.kind !== 'hub') failures.push('A stale pin emptied the tracker instead of falling through to a hub.');
  }

  // --- A cursor for a quest that is no longer in the pack is survived.
  {
    const f = trackFrame(bundle, { ghost: cursor(0, false, [0]) }, pose, hubs);
    if (f.kind !== 'hub') failures.push('A cursor on a deleted quest broke the tracker.');
  }

  // --- The step list is bounded.
  {
    const many = { ...bundle, quests: [quest('many', 'clerk', Array.from({ length: 20 }, () => step('goto', 1, 1)))] } as unknown as ContentBundle;
    const f = trackFrame(many, { many: cursor(0, false, new Array(20).fill(0)) }, pose, hubs);
    if (f.steps.length > MAX_TRACK_STEPS) failures.push(`A 20-step job drew ${f.steps.length} lines in the corner.`);
  }

  if (othersText(0) !== '') failures.push('The tracker offered to count zero other jobs.');
  if (othersText(3) !== 'and 3 more on the go') failures.push(`The others line reads "${othersText(3)}".`);

  return failures;
}
