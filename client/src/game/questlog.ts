/**
 * The job list, as rows: what you are on, and where the rest of it is.
 *
 * ---------------------------------------------------------------------------
 * ## Why this is not `dialog.registerRows`
 *
 * The register answers *"what does Centrelink have for somebody on my rung"*,
 * and it answers it well, because that is what Act 0 through 2 are: a menu, ten
 * jobs to a rung, read at a desk. It was written when the whole city held a
 * hundred and nine quests.
 *
 * There are six hundred now and there will be more, and every one of them is at
 * a place. Listed by rung, that is a scroll of several hundred rows in a 300 px
 * handset, sorted by a number the player cannot see from where they are
 * standing. The owner, twice: *"i was hoping opening the map etc would help me
 * find quests"*, and *"im not happy with how hard to discover the quest ux is,
 * rebuild it"*.
 *
 * So this asks the other question -- **where is the work** -- and it answers it
 * in the two sections a player actually has:
 *
 *   1. **On the go.** Every job with a live cursor, wherever it is and whatever
 *      rung it belongs to, ready-to-hand-in first. This is the quest log.
 *   2. **Where the work is.** The nearest hubs out of `game/questhubs.ts`, each
 *      with its name, its distance and the jobs you could take there. This is
 *      the part that is meant to make somebody stand up and go somewhere.
 *
 * There is deliberately no third section listing every job in the city. A list
 * that cannot be walked to the bottom of is a list nobody reads to the bottom
 * of, and the rung summary the register already draws is the honest version of
 * "there is more".
 *
 * ## Grouped by hub rather than by suburb, and the hubs are the tracker's
 *
 * The same `QuestHub[]` the corner is drawing from, passed in rather than
 * recomputed. Two clusterers would eventually put Redfern in two places, and a
 * player reading a log that disagrees with the tracker beside it has caught the
 * game lying about something it has no reason to be uncertain about.
 *
 * ## Three-free and pure
 *
 * `client/src/questlog.ts` is the panel. This decides every row and every word
 * in it, so `verifyQuestLog` runs on the server's boot list too.
 */

import { hubCountText, hubRangeText, type QuestHub } from './questhubs.ts';
import { questAim } from './questaim.ts';
import {
  REGISTER_LEVELS,
  openStep,
  questRefusal,
  questStanding,
  stepCounter,
  rungOf,
  stepLabel,
  type ContentBundle,
  type PlayerFacts,
  type Quest,
  type QuestCursors,
  type QuestStanding,
} from './questmodel.ts';

/** The kinds of row the panel knows how to draw. */
export type LogRowKind = 'section' | 'hub' | 'job' | 'step' | 'note';

export interface LogRow {
  kind: LogRowKind;
  label: string;
  /** The right-hand column: a standing, a count of jobs, a distance. */
  value: string;
  /** Set on `job` rows. `''` elsewhere, so a click on a header does nothing. */
  questId: string;
  /** Metres, on `job` and `hub` rows. `-1` where there is nowhere. */
  rangeM: number;
  /** `job` rows only, and it drives the colour rather than the words. */
  standing: QuestStanding | '';
}

/** How many hubs the second section lists. Beyond this is a different city. */
export const MAX_LOG_HUBS = 14;

/** And how many jobs under one of them. A hub with more is a hub, not a list. */
export const MAX_LOG_JOBS_PER_HUB = 12;

/** What each standing says in the right-hand column. `dialog.ts`'s words. */
const STANDING_WORD: Record<QuestStanding, string> = {
  on: 'on it',
  ready: 'ready to hand in',
  available: 'take it',
  done: 'done',
  locked: 'locked',
};

/** Just enough of a giver for the grouping. `givermap.GiverDot` satisfies it. */
export interface LogGiver {
  id: string;
  x: number;
  z: number;
}

export interface LogPose {
  x: number;
  z: number;
}

/**
 * The whole panel, as rows.
 *
 * `hubs` and `givers` are the pair `questHubs` was called with -- a hub's
 * `members` are indices into `givers` -- and passing them together rather than
 * as one array of joined objects is what keeps `game/questhubs.ts` ignorant of
 * quests, which is why the map can use it too.
 */
export function questLogRows(
  bundle: ContentBundle,
  cursors: QuestCursors,
  facts: PlayerFacts,
  hubs: readonly QuestHub[],
  givers: readonly LogGiver[],
  pose: LogPose,
): LogRow[] {
  const rows: LogRow[] = [];
  const row = (
    kind: LogRowKind, label: string, value: string, questId = '', rangeM = -1, standing: QuestStanding | '' = '',
  ): void => {
    rows.push({ kind, label, value, questId, rangeM, standing });
  };

  /*
   * The pack, indexed once.
   *
   * This was `bundle.quests.find(...)` per row, which was fine at a hundred and
   * nine quests and is a linear scan of two thousand per row now -- fifty rows
   * three times a second, on the frame thread, while the panel is open. The map
   * is built once per draw and thrown away with it.
   */
  const questById = new Map<string, Quest>();
  for (const q of bundle.quests) questById.set(q.id, q);

  const rangeOf = (id: string): number => {
    const quest = questById.get(id);
    if (quest === undefined) return -1;
    const aim = questAim(quest, bundle.npcs, cursors[id]);
    if (aim === null) return -1;
    return Math.sqrt((aim.x - pose.x) ** 2 + (aim.z - pose.z) ** 2);
  };

  // --- 1. On the go. Payday first, then whatever is nearest.
  const live = bundle.quests
    .filter((q) => cursors[q.id] !== undefined)
    .map((q) => ({ quest: q, ready: cursors[q.id].d, rangeM: rangeOf(q.id) }))
    .sort((a, b) => Number(b.ready) - Number(a.ready) || a.rangeM - b.rangeM);

  row('section', 'on the go', live.length === 0 ? '' : String(live.length));
  if (live.length === 0) {
    row('note', 'Nothing on. Take something from the list below.', '');
  }
  for (const { quest, rangeM } of live) {
    const standing = questStanding(quest, facts, cursors);
    row('job', quest.title, STANDING_WORD[standing], quest.id, rangeM, standing);
    // The open step under the job it belongs to, and only the open one: a log
    // that draws every step of every live job is a log the size of the pack.
    const cursor = cursors[quest.id];
    const step = openStep(cursor, quest);
    if (step !== null) {
      const count = stepCounter(step, cursor.c[cursor.s] ?? 0);
      row('step', stepLabel(step, 64), count);
    } else {
      row('step', `hand it in to ${giverName(bundle, quest.giver)}`, '');
    }
  }

  // --- 2. Where the work is.
  const byGiver = new Map<string, string[]>();
  for (const q of bundle.quests) {
    const list = byGiver.get(q.giver);
    if (list === undefined) byGiver.set(q.giver, [q.id]);
    else list.push(q.id);
  }

  const hubRows: LogRow[] = [];
  let listed = 0;
  for (const hub of hubs) {
    if (listed >= MAX_LOG_HUBS) break;
    const offers: Array<{ id: string; title: string; standing: QuestStanding; rangeM: number }> = [];
    for (const m of hub.members) {
      const giver = givers[m];
      if (giver === undefined) continue;
      for (const id of byGiver.get(giver.id) ?? []) {
        if (cursors[id] !== undefined) continue; // already in section 1
        const quest = questById.get(id);
        if (quest === undefined) continue;
        const standing = questStanding(quest, facts, cursors);
        if (standing !== 'available') continue;
        offers.push({ id, title: quest.title, standing, rangeM: rangeOf(id) });
      }
    }
    if (offers.length === 0) continue;
    listed++;
    offers.sort((a, b) => a.rangeM - b.rangeM || (a.title < b.title ? -1 : 1));
    hubRows.push({
      kind: 'hub',
      label: hub.name !== '' ? hub.name : 'off the network',
      value: hubCountText({ ...hub, offers: offers.length }),
      questId: '',
      rangeM: hub.distanceM,
      standing: '',
    });
    for (const o of offers.slice(0, MAX_LOG_JOBS_PER_HUB)) {
      hubRows.push({
        kind: 'job', label: o.title, value: STANDING_WORD[o.standing],
        questId: o.id, rangeM: o.rangeM, standing: o.standing,
      });
    }
    if (offers.length > MAX_LOG_JOBS_PER_HUB) {
      hubRows.push({
        kind: 'step', label: `and ${offers.length - MAX_LOG_JOBS_PER_HUB} more here`, value: '',
        questId: '', rangeM: -1, standing: '',
      });
    }
  }

  row('section', 'where the work is', listed === 0 ? '' : `${listed} place${listed === 1 ? '' : 's'}`);
  if (hubRows.length === 0) {
    // The one case this must not be silent about, because it is indistinguishable
    // from a broken panel: there is genuinely nothing on offer in reach.
    const why = nothingWhy(bundle, facts, cursors);
    row('note', why, '');
  }
  rows.push(...hubRows);

  /*
   * --- 3. The ladder.
   *
   * The one thing the register in the phone said that neither section above
   * does, carried across rather than deleted with the screen it was on: how far
   * up the Centrelink ladder you are, and how much is still shut. A count per
   * rung and not a list, for `dialog.registerRows`' own reason -- the rungs
   * ahead of you are a spoiler and a scroll, and the number is the part that
   * makes you want to climb.
   */
  const rung = rungOf(facts.level);
  const ladder: LogRow[] = [];
  for (let level = 1; level <= REGISTER_LEVELS; level++) {
    const on = bundle.quests.filter((q) => q.level === level && q.act <= 2);
    if (on.length === 0) continue;
    const done = on.filter((q) => questStanding(q, facts, cursors) === 'done').length;
    const shut = level > rung;
    ladder.push({
      kind: 'step',
      label: `level ${level}${shut ? ' — not yet' : ''}`,
      value: `${done} of ${on.length}`,
      questId: '',
      rangeM: -1,
      standing: '',
    });
  }
  if (ladder.length > 0) {
    row('section', 'the register', `level ${rung}`);
    rows.push(...ladder);
  }
  return rows;
}

/** The giver's name, or their id, which is better than nothing on a bad pack. */
function giverName(bundle: ContentBundle, id: string): string {
  for (const n of bundle.npcs) if (n.id === id) return n.name;
  return id;
}

/**
 * Why the second section is empty, in a sentence.
 *
 * Three genuinely different situations and a player cannot tell them apart from
 * an empty list: the content never arrived, everything nearby is finished, or
 * everything nearby is gated. Saying which is the difference between a panel
 * that looks broken and one that is telling you something.
 */
function nothingWhy(bundle: ContentBundle, facts: PlayerFacts, cursors: QuestCursors): string {
  if (bundle.quests.length === 0) return 'No jobs have loaded. The content server may be having a day.';
  let locked = 0;
  let done = 0;
  for (const q of bundle.quests) {
    const standing = questStanding(q, facts, cursors);
    if (standing === 'locked') locked++;
    else if (standing === 'done') done++;
  }
  if (locked > 0 && locked >= done) {
    const sample = bundle.quests.find((q) => questStanding(q, facts, cursors) === 'locked');
    const why = sample === undefined ? '' : questRefusal(sample, facts, cursors);
    return why === '' ? 'Nothing open to you yet.' : `Nothing open near you yet — ${why}.`;
  }
  if (done > 0) return 'Nothing left near you. Get on a train.';
  return 'Nothing near you. Get on a train.';
}

/** The distance column, or nothing. Shared so the two sections line up. */
export function logRangeText(rangeM: number): string {
  return rangeM < 0 ? '' : hubRangeText(rangeM);
}

export function verifyQuestLog(): string[] {
  const failures: string[] = [];

  const npc = (id: string, x: number, z: number): unknown => ({
    id, name: id, x, z, radius: 5, root: 'hello', marker: '', nodes: [],
  });
  const step = (kind: string, x: number, z: number, extra: Record<string, unknown> = {}): unknown => ({
    kind, x, z, radius: 30, label: `do ${kind}`, objective: '', npc: '', count: 0,
    powerup: '', line: -1, from: '', to: '', node: '', dollars: 0, ...extra,
  });
  const quest = (id: string, giver: string, level = 1): unknown => ({
    id, act: 0, title: id.toUpperCase(), blurb: '', giver, level, faction: '',
    requires: [], needFlags: [], denyFlags: [], repeatable: false, anyRung: false,
    grantsBike: false, reward: { cash: 0, xp: 0, unlock: [] }, steps: [step('goto', 100, 0)],
  });

  const bundle = {
    revision: '1',
    npcs: [npc('abbie', 0, 0), npc('doug', 40, 0), npc('kez', 9000, 0)],
    quests: [quest('a1', 'abbie'), quest('a2', 'abbie'), quest('d1', 'doug'), quest('k1', 'kez')],
  } as unknown as ContentBundle;
  const facts: PlayerFacts = { level: 9, faction: '', story: new Set<string>(), cash: 0 };
  const givers: LogGiver[] = [
    { id: 'abbie', x: 0, z: 0 },
    { id: 'doug', x: 40, z: 0 },
    { id: 'kez', x: 9000, z: 0 },
  ];
  const hubs: QuestHub[] = [
    { x: 20, z: 0, radiusM: 90, offers: 2, turnins: 0, name: 'Redfern', distanceM: 20, members: [0, 1] },
    { x: 9000, z: 0, radiusM: 90, offers: 1, turnins: 0, name: 'Kogarah', distanceM: 9000, members: [2] },
  ];
  const pose = { x: 0, z: 0 };
  const cursor = (s: number, d: boolean, c: number[]): unknown => ({ s, d, c });

  // --- The shape: two sections, and the hubs are named and in order.
  {
    const rows = questLogRows(bundle, {}, facts, hubs, givers, pose);
    const sections = rows.filter((r) => r.kind === 'section').map((r) => r.label);
    if (sections.join('|') !== 'on the go|where the work is|the register') {
      failures.push(`The log drew sections ${sections.join(', ')}.`);
    }
    const hubNames = rows.filter((r) => r.kind === 'hub').map((r) => r.label);
    if (hubNames.join('|') !== 'Redfern|Kogarah') failures.push(`The hubs listed as ${hubNames.join(', ')}.`);
    const jobs = rows.filter((r) => r.kind === 'job').map((r) => r.questId);
    if (jobs.length !== 4) failures.push(`${jobs.length} jobs listed, not 4.`);
    for (const r of rows) {
      if (r.kind === 'job' && r.questId === '') failures.push('A job row carried no quest id; its button would do nothing.');
      if (r.kind !== 'job' && r.questId !== '') failures.push(`A ${r.kind} row carried a quest id; a header would be clickable.`);
    }
  }

  // --- A job on the go leaves the hub list, so it is never in two places.
  {
    const rows = questLogRows(bundle, { a1: cursor(0, false, [0]) } as QuestCursors, facts, hubs, givers, pose);
    const ids = rows.filter((r) => r.kind === 'job').map((r) => r.questId);
    if (ids.filter((i) => i === 'a1').length !== 1) failures.push('A job on the go was listed twice.');
    const first = rows.findIndex((r) => r.questId === 'a1');
    const section = rows.findIndex((r) => r.kind === 'section' && r.label === 'where the work is');
    if (first < 0 || first > section) failures.push('A job on the go was not in the on-the-go section.');
    const under = rows[first + 1];
    if (under === undefined || under.kind !== 'step') failures.push('A live job drew no open step under it.');
  }

  // --- Ready to hand in leads the section, whatever it costs in distance.
  {
    const rows = questLogRows(
      bundle,
      { a1: cursor(0, false, [0]), k1: cursor(1, true, [1]) } as QuestCursors,
      facts, hubs, givers, pose,
    );
    const jobs = rows.filter((r) => r.kind === 'job').map((r) => r.questId);
    if (jobs[0] !== 'k1') failures.push(`The log led with "${jobs[0]}" rather than the job that is ready to hand in.`);
    const handIn = rows.find((r) => r.kind === 'step' && r.label.startsWith('hand it in'));
    if (handIn === undefined) failures.push('A finished job did not say who to hand it in to.');
    else if (!handIn.label.includes('kez')) failures.push(`The hand-in row reads "${handIn.label}".`);
  }

  // --- An empty city says which kind of empty it is.
  {
    const empty = { revision: '1', npcs: [], quests: [] } as unknown as ContentBundle;
    const rows = questLogRows(empty, {}, facts, [], [], pose);
    const note = rows.find((r) => r.kind === 'note' && r.label.includes('content server'));
    if (note === undefined) failures.push('A log with no content at all did not say so.');
  }
  {
    const high = { ...bundle, quests: [quest('late', 'abbie', 9)] } as unknown as ContentBundle;
    const low: PlayerFacts = { level: 1, faction: '', story: new Set<string>(), cash: 0 };
    const rows = questLogRows(high, {}, low, hubs, givers, pose);
    const note = rows.find((r) => r.kind === 'note' && r.label.toLowerCase().includes('nothing'));
    if (note === undefined) failures.push('A log whose every job is gated drew an empty section and no reason.');
    if (rows.some((r) => r.kind === 'job')) failures.push('A gated job was offered as takeable.');
  }

  // --- The hub cap holds, and a capped hub says how many it dropped.
  {
    const many = {
      revision: '1',
      npcs: [npc('abbie', 0, 0)],
      quests: Array.from({ length: 30 }, (_, i) => quest(`q${i}`, 'abbie')),
    } as unknown as ContentBundle;
    const one: QuestHub[] = [{ x: 0, z: 0, radiusM: 90, offers: 30, turnins: 0, name: 'Redfern', distanceM: 0, members: [0] }];
    const rows = questLogRows(many, {}, facts, one, [{ id: 'abbie', x: 0, z: 0 }], pose);
    const jobs = rows.filter((r) => r.kind === 'job').length;
    if (jobs > MAX_LOG_JOBS_PER_HUB) failures.push(`A hub listed ${jobs} jobs, past the cap of ${MAX_LOG_JOBS_PER_HUB}.`);
    if (!rows.some((r) => r.label.includes('more here'))) failures.push('A capped hub dropped jobs silently.');
  }

  // --- The ladder survived the screen it used to be on.
  {
    const rows = questLogRows(bundle, {}, facts, hubs, givers, pose);
    const section = rows.find((r) => r.kind === 'section' && r.label === 'the register');
    if (section === undefined) failures.push('The rung summary was lost with the phone screen it was on.');
    const ladder = rows.filter((r) => r.kind === 'step' && r.label.startsWith('level '));
    if (ladder.length === 0) failures.push('The register section listed no rungs.');
    if (!ladder.every((r) => /^\d+ of \d+$/.test(r.value))) {
      failures.push(`A rung row reads "${ladder[0]?.value}" rather than a count.`);
    }
    // Act 3 is the field work and is deliberately not on the ladder: it is not
    // ten-to-a-rung and counting it would make every rung read as 0 of 400.
    const field = { ...bundle, quests: [{ ...(quest('f1', 'abbie') as Record<string, unknown>), act: 3 }] } as unknown as ContentBundle;
    const fieldRows = questLogRows(field, {}, facts, hubs, givers, pose);
    if (fieldRows.some((r) => r.kind === 'section' && r.label === 'the register')) {
      failures.push('A city of nothing but field work still drew a Centrelink ladder.');
    }
  }

  // --- Distances are on the rows that can be walked to, and nowhere else.
  {
    const rows = questLogRows(bundle, {}, facts, hubs, givers, pose);
    for (const r of rows) {
      const wants = r.kind === 'job' || r.kind === 'hub';
      if (wants && r.rangeM < 0) failures.push(`A ${r.kind} row had no distance; the column would be blank.`);
      if (!wants && r.rangeM >= 0) failures.push(`A ${r.kind} row carried a distance it cannot mean.`);
    }
    if (logRangeText(-1) !== '') failures.push('An unknown distance drew something.');
    if (logRangeText(2100) !== '2.1 km') failures.push(`2100 m reads "${logRangeText(2100)}".`);
  }

  return failures;
}
