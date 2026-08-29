/**
 * quest-quality.ts -- the gate that asks whether a job is worth doing.
 *
 * `content-check.ts` is the gate that asks whether a pack is *well-formed*: it
 * parses, nobody shares a first name, nobody stands on the tracks or inside a
 * building, the register carries ten to a rung. Every one of those can pass on
 * a pack of four hundred identical errands.
 *
 * The owner, looking at six hundred of them: *"letzs come up with a pipeline
 * which ensures they are fun and unique just like wow? they shouldnt just be
 * random boring go here talk to this person quests, only if they are taking to
 * a new area"*.
 *
 * That sentence contains a rule sharp enough to check, and it is the same rule
 * WoW arrived at and the reason its "go and speak to X" quests do not read as
 * filler: **a courier job is a breadcrumb, and a breadcrumb has to lead
 * somewhere.** Vanilla is full of "take this letter to Westfall" and none of
 * them are boring, because every one of them ends at a camp with five more
 * quests in it. The same errand ending three hundred metres away at nobody is
 * the thing the owner is complaining about.
 *
 *     bun run scripts/content/quest-quality.ts            # gate: exits 1 on a fault
 *     bun run scripts/content/quest-quality.ts --report   # survey: exits 0, prints the shape
 *
 * ---------------------------------------------------------------------------
 * ## The eight rules, and why each one is a rule about fun
 *
 * Every check here had to earn its place by naming a specific way a job is
 * unfun. A rule that merely enforces tidiness belongs in `content-check.ts`.
 *
 *   1. **The courier rule.** A quest whose every step is `goto` or `dialog` is
 *      an errand. It passes only as a breadcrumb: its furthest point is at
 *      least `BREADCRUMB_M` from its giver *and* lands in a hub -- two or more
 *      other givers within `HUB_M` of it. An errand that ends at nobody is
 *      refused, in the owner's words exactly.
 *   2. **The place rule.** DESIGN.md rule 1: *"Sydney is the content. Every
 *      mechanic names a real thing."* A quest must name a real place in its
 *      title or its blurb -- a station, or one of the suburbs the stations are
 *      named for. "Go and find the bloke" is refused; "the Lisarow regular" is
 *      not.
 *   3. **The distinctiveness rule.** No two blurbs may share more than
 *      `SHINGLE_MAX` of their five-word shingles. Exact-match dedup is not
 *      enough and never was: a generator that swaps one noun produces four
 *      hundred blurbs that are all different strings and all the same sentence.
 *   4. **Titles are unique.** A job list with two rows called "The Runner" is a
 *      job list a player cannot use.
 *   5. **The walk rule.** The round trip -- giver, every positioned step in
 *      order, back to the giver -- must be under `WALK_M`, unless the quest has
 *      a `ride` step, which is a train job and is *meant* to cross the city.
 *      A four-kilometre walk with no train in it is not content, it is a
 *      commute.
 *   6. **The variety rule.** Inside one hub, no single step-kind pattern may
 *      account for more than `PATTERN_SHARE` of the jobs. This is the check
 *      that convicts an archetype crossed with three hundred stations: every
 *      job at Redfern being goto+photo+dialog is what "boring" means, even when
 *      each one is individually fine.
 *   7. **Labels are authored.** Every step needs a `label`, because the tracker
 *      in the corner draws it and `questmodel.defaultLabel` writes "go there".
 *   8. **A chain escalates.** Along a `requires` edge the reward must not go
 *      down. A second job that pays less than the first is a chain a player
 *      stops climbing.
 *
 * ## What this deliberately does not check
 *
 * Whether the writing is any good. Nothing here can, and a rule that pretended
 * to would be worse than the absence: it would be gamed by the generator it was
 * written to police, which is exactly how rule 3 came to exist -- the first
 * pass refused only *verbatim* repeats, and what shipped was four hundred
 * blurbs that differed by a noun.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';

const REPO = join(import.meta.dir, '..', '..');
const CONTENT = join(REPO, 'content');
const REPORT = process.argv.includes('--report');

// --- The numbers, all of them in one place so a change is a decision ----------

/** How far a breadcrumb must carry you before it counts as taking you anywhere. */
const BREADCRUMB_M = 600;
/** How close two givers are and still the same errand. `questhubs.HUB_LINK_M`. */
const HUB_M = 380;
/** How many other givers make a place worth being sent to. */
const HUB_MIN = 2;
/** The longest round trip a job with no train in it may ask for, metres. */
const WALK_M = 2600;
/** Shared five-word shingles, above which two blurbs are the same sentence. */
const SHINGLE_MAX = 0.5;
/** The share of one hub's jobs that may have the same step-kind pattern. */
const PATTERN_SHARE = 0.6;
/** A hub with fewer jobs than this is too small for rule 6 to mean anything. */
const PATTERN_MIN_JOBS = 4;

// --- The city -----------------------------------------------------------------

const railBuf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(
  railBuf.buffer.slice(railBuf.byteOffset, railBuf.byteOffset + railBuf.byteLength) as ArrayBuffer,
);
/**
 * Every name rule 2 accepts.
 *
 * The station list, plus the words inside a compound station name, so "Macquarie
 * Park" is matched by a blurb that says Macquarie and "North Sydney" by one that
 * says Sydney. Two-letter fragments are dropped -- otherwise "St" in "St
 * Marys" makes every sentence with a saint in it a place.
 */
const PLACES = new Set<string>();
for (const st of bake.stations) {
  const name = st.name.toLowerCase();
  PLACES.add(name);
  for (const word of name.split(/[^a-z]+/)) {
    if (word.length > 3) PLACES.add(word);
  }
}
/*
 * The real things that are not stations.
 *
 * Short and hand-kept on purpose. Every entry is something a player can walk to,
 * ride, or be means-tested by, and the list stops rather than growing into a
 * gazetteer -- a rule whose vocabulary is large enough to match anything has
 * stopped being a rule. It exists because the station list alone called
 * "Centrelink" and "the Opera House" imaginary.
 */
for (const real of [
  'centrelink', 'opal', 'services australia', 'opera house', 'harbour bridge',
  'sydney park', 'the domain', 'darling harbour', 'circular quay', 'bondi',
  'parramatta road', 'the m4', 'the m5', 'anzac bridge', 'the gong', 'mounty county',
]) PLACES.add(real);

// --- The content --------------------------------------------------------------

interface Step {
  kind: string;
  x: number;
  z: number;
  radius: number;
  label?: string;
  npc?: string;
}
interface Quest {
  id: string;
  act?: number;
  title: string;
  blurb: string;
  giver: string;
  steps: Step[];
  requires?: string[];
  reward?: { cash?: number; xp?: number };
}
interface Npc {
  id: string;
  name: string;
  x: number;
  z: number;
}

const quests: Array<{ quest: Quest; pack: string }> = [];
const npcs = new Map<string, Npc>();
for (const file of readdirSync(join(CONTENT, 'quests'))) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(readFileSync(join(CONTENT, 'quests', file), 'utf8')) as { quests?: Quest[] };
  for (const q of raw.quests ?? []) quests.push({ quest: q, pack: file });
}
for (const file of readdirSync(join(CONTENT, 'dialog'))) {
  if (!file.endsWith('.json')) continue;
  const raw = JSON.parse(readFileSync(join(CONTENT, 'dialog', file), 'utf8')) as { npcs?: Npc[] };
  for (const n of raw.npcs ?? []) npcs.set(n.id, n);
}

// --- The helpers --------------------------------------------------------------

/** Which step kinds have coordinates worth walking to. `waypoint.stepHasPosition`. */
const POSITIONED = new Set(['goto', 'photo', 'buy']);

/** The kinds that are somebody handing you a sentence rather than a thing to do. */
const COURIER_KINDS = new Set(['goto', 'dialog']);

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.sqrt((ax - bx) ** 2 + (az - bz) ** 2);
}

/** Five-word shingles, lower-cased and stripped of punctuation. */
function shingles(text: string): Set<string> {
  const words = text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) out.add(words.slice(i, i + 5).join(' '));
  // A blurb shorter than five words has no shingles and cannot be compared; it
  // is its own whole string instead, which is the exact-match rule as a floor.
  if (out.size === 0 && words.length > 0) out.add(words.join(' '));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const s of a) if (b.has(s)) shared++;
  return shared / Math.min(a.size, b.size);
}

function namesAPlace(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean);
  for (const w of words) if (PLACES.has(w)) return true;
  // Two-word station names, which the single-word pass above cannot see when
  // both halves are short ("St Marys", "Kings Cross").
  for (let i = 0; i + 1 < words.length; i++) {
    if (PLACES.has(`${words[i]} ${words[i + 1]}`)) return true;
    if (i + 2 < words.length && PLACES.has(`${words[i]} ${words[i + 1]} ${words[i + 2]}`)) return true;
  }
  return false;
}

/** The kinds a quest asks for, in order, as one comparable string. */
function pattern(q: Quest): string {
  return q.steps.map((s) => s.kind).join('+');
}

// --- The rules ----------------------------------------------------------------

const faults: string[] = [];
const notes = new Map<string, number>();
const note = (rule: string): void => notes.set(rule, (notes.get(rule) ?? 0) + 1);
const fault = (rule: string, text: string): void => {
  note(rule);
  faults.push(`[${rule}] ${text}`);
};

// Rule 1 and rule 5 both need every giver's position, so build the index once.
const giverPoints: Array<{ id: string; x: number; z: number }> = [];
for (const n of npcs.values()) giverPoints.push({ id: n.id, x: n.x, z: n.z });

/** How many *other* givers stand within `HUB_M` of a point. */
function neighboursNear(x: number, z: number, exclude: string): number {
  let count = 0;
  for (const g of giverPoints) {
    if (g.id === exclude) continue;
    if (dist(x, z, g.x, g.z) <= HUB_M) count++;
  }
  return count;
}

for (const { quest, pack } of quests) {
  const giver = npcs.get(quest.giver);
  const where = `${quest.id} (${pack})`;

  // --- Rule 7. Cheap and first, because a missing label makes the rest vaguer.
  for (const step of quest.steps) {
    if ((step.label ?? '') === '') {
      fault('label', `${where}: a ${step.kind} step has no label; the tracker would draw "go there".`);
      break;
    }
  }

  /*
   * --- Rule 2, and why it is a refusal for generated work and a note for
   * hand-written work.
   *
   * DESIGN.md rule 1 is *"every mechanic names a real thing"*, and a station is
   * only one kind of real thing. Act 0's obligations are about Centrelink, which
   * is as real as Redfern and considerably more frightening; a story quest in
   * Act 2 can be about the 7:12 or about Mounty County. Forcing a suburb into
   * "Participation Review" would make that quest worse, and a rule that makes
   * writing worse is a rule that is wrong.
   *
   * What the rule is actually for is the failure mode of a *generator*: an
   * archetype crossed with a place, where a blurb that does not name the place
   * could have been written anywhere and therefore was. That is act 3, and
   * there it refuses.
   */
  if (!namesAPlace(`${quest.title} ${quest.blurb}`)) {
    if ((quest.act ?? 3) >= 3) fault('place', `${where}: names no real place. "${quest.title}"`);
    else note('place-note');
  }

  /*
   * --- Rule 1, and the one exemption that is not about breadcrumbs.
   *
   * **Act 0 is the tutorial**, and a tutorial's job is to teach a verb by making
   * you do it once with nothing else going on. "Go and see Denise" is the quest
   * that teaches a player that people have `!` over their heads and that `E`
   * opens them; wrapping it in a fight so it passes a rule would be teaching two
   * things at once to somebody who has been in the world for ninety seconds.
   *
   * This is the same shape as rule 2's exemption and rests on the same
   * distinction: these rules police *generated* work, where an errand that ends
   * at nobody is a template failing to notice it has nothing to say. A
   * hand-written tutorial errand is a decision.
   */
  const tutorial = (quest.act ?? 3) === 0;
  const courier = quest.steps.length > 0 && quest.steps.every((s) => COURIER_KINDS.has(s.kind));
  let breadcrumb = tutorial;
  if (courier && !tutorial) {
    let reachM = 0;
    let far: Step | null = null;
    for (const step of quest.steps) {
      if (!POSITIONED.has(step.kind)) continue;
      const d = giver === undefined ? 0 : dist(giver.x, giver.z, step.x, step.z);
      if (d > reachM) {
        reachM = d;
        far = step;
      }
    }
    const lands = far === null ? 0 : neighboursNear(far.x, far.z, quest.giver);
    breadcrumb = reachM >= BREADCRUMB_M && lands >= HUB_MIN;
    if (!breadcrumb) {
      fault(
        'courier',
        `${where}: go-and-talk with nothing to do, ${Math.round(reachM)} m away, ` +
          `${lands} giver(s) where it lands. A courier job has to be a breadcrumb.`,
      );
    }
  }

  /*
   * --- Rule 5, and the two exemptions.
   *
   * A `ride` quest is meant to cross the city; that was always in the rule. A
   * **breadcrumb** is exempt for a reason the first version of this file did not
   * see and its own output taught it: a breadcrumb is a *one-way trip*. Rule 1
   * has just required it to be at least six hundred metres and to land in a hub,
   * and this rule then measured the round trip and refused it for being long.
   * Two rules, one job, opposite verdicts. The walk rule exists to catch a
   * four-kilometre errand that ends where it started; the whole point of a
   * breadcrumb is that it does not.
   */
  if (!breadcrumb && !tutorial && !quest.steps.some((s) => s.kind === 'ride') && giver !== undefined) {
    let walk = 0;
    let x = giver.x;
    let z = giver.z;
    for (const step of quest.steps) {
      if (!POSITIONED.has(step.kind)) continue;
      walk += dist(x, z, step.x, step.z);
      x = step.x;
      z = step.z;
    }
    walk += dist(x, z, giver.x, giver.z);
    if (walk > WALK_M) {
      fault('walk', `${where}: a ${(walk / 1000).toFixed(1)} km round trip on foot, with no train in it.`);
    }
  }

  // --- Rule 8.
  for (const need of quest.requires ?? []) {
    const prior = quests.find((e) => e.quest.id === need);
    if (prior === undefined) continue;
    const before = (prior.quest.reward?.xp ?? 0) + (prior.quest.reward?.cash ?? 0);
    const after = (quest.reward?.xp ?? 0) + (quest.reward?.cash ?? 0);
    if (after < before) {
      fault('chain', `${where}: pays ${after} after ${need} paid ${before}; a chain that pays less is one nobody climbs.`);
    }
  }
}

// --- Rule 4.
{
  const seen = new Map<string, string>();
  for (const { quest } of quests) {
    const key = quest.title.trim().toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) fault('title', `"${quest.title}" is the title of both ${first} and ${quest.id}.`);
    else seen.set(key, quest.id);
  }
}

// --- Rule 3. O(n^2) over the blurbs, which at a few thousand is a second.
{
  const shingled = quests.map((e) => ({ id: e.quest.id, blurb: e.quest.blurb, set: shingles(e.quest.blurb) }));
  let worst = { a: '', b: '', share: 0 };
  const reported = new Set<string>();
  for (let i = 0; i < shingled.length; i++) {
    for (let j = i + 1; j < shingled.length; j++) {
      const share = overlap(shingled[i].set, shingled[j].set);
      if (share > worst.share) worst = { a: shingled[i].id, b: shingled[j].id, share };
      if (share <= SHINGLE_MAX) continue;
      // One report per quest rather than per pair: a generator that produced
      // forty identical blurbs would otherwise print eight hundred lines.
      if (reported.has(shingled[i].id)) continue;
      reported.add(shingled[i].id);
      fault(
        'samey',
        `${shingled[i].id} and ${shingled[j].id} share ${Math.round(share * 100)}% of their sentence: ` +
          `"${shingled[i].blurb.slice(0, 70)}..."`,
      );
    }
  }
  if (REPORT) console.log(`  worst blurb overlap: ${Math.round(worst.share * 100)}% (${worst.a} / ${worst.b})`);
}

// --- Rule 6. Cluster the givers, then look at what each cluster hands out.
{
  const owner = new Int32Array(giverPoints.length);
  for (let i = 0; i < owner.length; i++) owner[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (owner[r] !== r) r = owner[r];
    return r;
  };
  for (let i = 0; i < giverPoints.length; i++) {
    for (let j = i + 1; j < giverPoints.length; j++) {
      if (dist(giverPoints[i].x, giverPoints[i].z, giverPoints[j].x, giverPoints[j].z) > HUB_M) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) owner[a] = b;
    }
  }
  const hubOf = new Map<string, number>();
  for (let i = 0; i < giverPoints.length; i++) hubOf.set(giverPoints[i].id, find(i));

  const byHub = new Map<number, Quest[]>();
  for (const { quest } of quests) {
    const hub = hubOf.get(quest.giver);
    if (hub === undefined) continue;
    const list = byHub.get(hub);
    if (list === undefined) byHub.set(hub, [quest]);
    else list.push(quest);
  }
  let hubs = 0;
  for (const [hub, list] of byHub) {
    if (list.length < PATTERN_MIN_JOBS) continue;
    hubs++;
    const counts = new Map<string, number>();
    for (const q of list) counts.set(pattern(q), (counts.get(pattern(q)) ?? 0) + 1);
    for (const [pat, n] of counts) {
      if (n / list.length <= PATTERN_SHARE) continue;
      const name = npcs.get(giverPoints[hub]?.id ?? '')?.name ?? `hub ${hub}`;
      fault(
        'samey-hub',
        `${n} of ${list.length} jobs around ${name} are the same shape (${pat}); ` +
          'a hub of one archetype is what boring means.',
      );
    }
  }
  if (REPORT) console.log(`  ${hubs} hub(s) with ${PATTERN_MIN_JOBS}+ jobs`);
}

// --- The verdict --------------------------------------------------------------

if (REPORT) {
  console.log(`\nquest-quality: ${quests.length} quest(s), ${npcs.size} giver(s)`);
  const kinds = new Map<string, number>();
  for (const { quest } of quests) for (const s of quest.steps) kinds.set(s.kind, (kinds.get(s.kind) ?? 0) + 1);
  console.log('  step kinds: ' + [...kinds].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', '));
  const pats = new Map<string, number>();
  for (const { quest } of quests) pats.set(pattern(quest), (pats.get(pattern(quest)) ?? 0) + 1);
  console.log(`  ${pats.size} distinct step patterns over ${quests.length} quests`);
  console.log('  commonest: ' + [...pats].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p, n]) => `${p} x${n}`).join(', '));
  console.log('\n  faults by rule:');
  for (const [rule, n] of [...notes].sort((a, b) => b[1] - a[1])) console.log(`    ${rule.padEnd(12)} ${n}`);
  console.log(`\n  ${faults.length} fault(s) total. Examples:`);
  const shown = new Set<string>();
  for (const f of faults) {
    const rule = f.slice(1, f.indexOf(']'));
    if (shown.has(rule)) continue;
    shown.add(rule);
    console.log(`    ${f}`);
  }
  process.exit(0);
}

if (faults.length > 0) {
  console.error(`quest-quality: ${faults.length} fault(s) over ${quests.length} quest(s).\n`);
  console.error(faults.slice(0, 40).map((f) => '  - ' + f).join('\n'));
  if (faults.length > 40) console.error(`  ... and ${faults.length - 40} more.`);
  process.exit(1);
}
console.log(`quest-quality: ${quests.length} quest(s) over ${npcs.size} giver(s) -- all eight rules pass.`);
