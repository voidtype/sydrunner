/**
 * compose.ts -- draft quests the way the skill says, and refuse to write a
 * draft that breaks a law.
 *
 *     bun run .claude/skills/quest-generation/compose.ts --count 2000 --out scripts/content/drafts/quests-2000.json
 *     bun run .claude/skills/quest-generation/compose.ts --count 60 --level 4 --area kings-cross --out /tmp/kx.json
 *     ... --packs <dir>   also write content/{quests,dialog}/area-*.json packs under <dir>, for the gates
 *
 * Deterministic (`--seed`, default 7). Every entry is validated with the same
 * three functions `entry-validate.ts` runs, checked for the ko/buy registries,
 * the faction spellings, title uniqueness, the shingle rule against every
 * blurb already shipped, first names against every giver within 2.5 km, and
 * a fingerprint -- area | level | goal | specific -- that never repeats.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { decodeRail } from '../../../client/src/game/rail.ts';
import { parseQuestPack, parseDialogPack, validateBundle } from '../../../client/src/game/questmodel.ts';
import { voiceFor, weave, cased } from '../../../scripts/content/voice.ts';

const REPO = join(dirname(new URL(import.meta.url).pathname), '../../..');
const HERE = dirname(new URL(import.meta.url).pathname);

// --- args --------------------------------------------------------------------
const arg = (k: string, d: string): string => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const COUNT = Number(arg('--count', '2000'));
const SEED = Number(arg('--seed', '7'));
const ONLY_LEVEL = Number(arg('--level', '0'));
const ONLY_AREA = arg('--area', '');
const OUT = arg('--out', join(REPO, 'scripts/content/drafts/quests.json'));
const PACKS = arg('--packs', '');

// --- rules the gates enforce, restated so this refuses first -------------------
const BREADCRUMB_M = 600;
const SHINGLE_MAX = 0.48; // the gate refuses at 0.5, measured the same way; the two points are margin
const WALK_M = 2600;
const PATTERN_SHARE = 0.6;
const NAME_REACH_M = 2500;
const GIVER_SPACING_M = 30;
const TRACK_CLEAR_M = 12; // the gate refuses under 6 m to a rail *segment*; measured that way below
const MAX_TITLE = 60;
const MAX_LINE = 240;
const MAX_CHOICE = 90;
const KO = new Set(['any', 'player', 'karen', 'police', 'drunk', 'tradie', 'eshay', 'rbt']);
const BUY = new Set(['any', 'flat white', 'training']);

// --- a small deterministic rng ---------------------------------------------------
let state = SEED >>> 0 || 1;
const rnd = (): number => {
  state ^= state << 13; state >>>= 0; state ^= state >>> 17; state ^= state << 5; state >>>= 0;
  return state / 4294967296;
};
const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const between = (lo: number, hi: number): number => lo + rnd() * (hi - lo);

// --- inputs ------------------------------------------------------------------
interface Area { id: string; name: string; station: string; level: number; next: string; sydney: string[]; people: string[] }
interface Archetype { role: string; pool: string; hello: string; what: string; small: string }
interface Goal { key: string; cat: string; steps: unknown[][]; title: string; core: string }
const areasFile = JSON.parse(readFileSync(join(HERE, 'areas.json'), 'utf8'));
const AREAS: Area[] = areasFile.areas;
const AREA_R: number = areasFile.radiusM;
const banks = JSON.parse(readFileSync(join(HERE, 'banks.json'), 'utf8'));
const NAMES: Record<string, string[]> = banks.names;
const ARCH: Record<string, Archetype> = banks.archetypes;
const GOALS: Goal[] = banks.goals.list;
const WHEN: string[] = banks.when;
const DAY: string[] = banks.day;

const railBuf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(railBuf.buffer.slice(railBuf.byteOffset, railBuf.byteOffset + railBuf.byteLength) as ArrayBuffer);
const STATION = new Map<string, { x: number; z: number }>();
for (const s of bake.stations as Array<{ name: string; x: number; z: number }>) STATION.set(s.name, { x: s.x, z: s.z });
const V: Float32Array = bake.vertices as Float32Array;
/** Distance to the nearest rail segment: consecutive vertices, skipping the jumps between sections. */
function trackDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], bx = V[i + 3], bz = V[i + 5];
    const dx = bx - ax, dz = bz - az; const len2 = dx * dx + dz * dz;
    if (len2 > 200 * 200) continue; // the gate's own cap: a longer hop is a jump between sections
    const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const ex = x - (ax + dx * t), ez = z - (az + dz * t); const d = ex * ex + ez * ez;
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}
// Buildings: a giver or a step inside one is refused, so the gate never has to walk it out.
import { loadWorld } from '../../../server/world.ts';
const world = await loadWorld(join(REPO, 'client/public/world'));
const prisms: any[] = [];
function insideBuilding(x: number, z: number): boolean {
  prisms.length = 0;
  world.collision!.prismsWithin(x, z, 40, prisms);
  for (const q of prisms) {
    if (q.structural) continue;
    const pts: Float32Array = q.points; const n = pts.length >> 1; let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[i * 2], zi = pts[i * 2 + 1], xj = pts[j * 2], zj = pts[j * 2 + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}
for (const a of AREAS) if (!STATION.has(a.station)) throw new Error(`areas.json: no station called ${a.station}`);

// --- the ledger: everything already shipped ------------------------------------
interface Giver { first: string; x: number; z: number }
const shippedTitles = new Set<string>();
const shippedGivers: Giver[] = [];
const shingleIndex = new Map<string, number[]>(); // shingle -> blurb ids
const blurbCount: number[] = []; // id -> shingle count
let blurbId = 0;
function shinglesOf(text: string): string[] {
  const w = text.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i + 5 <= w.length; i++) out.push(w.slice(i, i + 5).join(' '));
  return out;
}
function indexBlurb(text: string): number {
  const id = blurbId++;
  const sh = new Set(shinglesOf(text));
  blurbCount[id] = sh.size;
  for (const s of sh) {
    const list = shingleIndex.get(s);
    if (list) list.push(id); else shingleIndex.set(s, [id]);
  }
  return id;
}
/** Largest share of this blurb's shingles found in any single other blurb. */
function worstOverlap(text: string): number {
  const sh = new Set(shinglesOf(text));
  if (sh.size === 0) return 0;
  const tally = new Map<number, number>();
  for (const s of sh) for (const id of shingleIndex.get(s) ?? []) tally.set(id, (tally.get(id) ?? 0) + 1);
  let worst = 0;
  for (const [id, n] of tally) worst = Math.max(worst, n / Math.min(sh.size, blurbCount[id]));
  return worst;
}
for (const dir of ['content/quests', 'content/dialog']) {
  for (const f of readdirSync(join(REPO, dir))) {
    if (!f.endsWith('.json')) continue;
    const d = JSON.parse(readFileSync(join(REPO, dir, f), 'utf8'));
    for (const q of d.quests ?? []) { shippedTitles.add(q.title); indexBlurb(q.blurb ?? ''); }
    for (const n of d.npcs ?? []) shippedGivers.push({ first: String(n.name).split(',')[0].trim(), x: n.x, z: n.z });
  }
}

// --- placement ---------------------------------------------------------------
const placedGivers: Giver[] = [];
function clearOfGivers(x: number, z: number, m: number): boolean {
  for (const g of placedGivers) if (Math.hypot(g.x - x, g.z - z) < m) return false;
  for (const g of shippedGivers) if (Math.hypot(g.x - x, g.z - z) < m) return false;
  return true;
}
function nameTaken(first: string, x: number, z: number): boolean {
  for (const g of placedGivers) if (g.first === first && Math.hypot(g.x - x, g.z - z) < NAME_REACH_M) return true;
  for (const g of shippedGivers) if (g.first === first && Math.hypot(g.x - x, g.z - z) < NAME_REACH_M) return true;
  return false;
}
/** A point in the area's disc, off the rails. */
function areaPoint(a: Area, rMin: number, rMax: number): { x: number; z: number } {
  const s = STATION.get(a.station)!;
  for (let t = 0; t < 400; t++) {
    const ang = rnd() * Math.PI * 2; const r = between(rMin, rMax);
    const x = Math.round(s.x + Math.cos(ang) * r); const z = Math.round(s.z + Math.sin(ang) * r);
    if (trackDist(x, z) >= TRACK_CLEAR_M && !insideBuilding(x, z)) return { x, z };
  }
  throw new Error(`no clear point in ${a.id}`);
}
const besideCache = new Map<string, { x: number; z: number }>();
function besideStation(a: Area): { x: number; z: number } {
  const hit = besideCache.get(a.id);
  if (hit) return hit;
  const p = areaPoint(a, 30, 70);
  besideCache.set(a.id, p);
  return p;
}
function giverSpot(a: Area): { x: number; z: number } {
  for (let t = 0; t < 600; t++) {
    const p = areaPoint(a, 45, AREA_R);
    if (clearOfGivers(p.x, p.z, GIVER_SPACING_M)) return p;
  }
  throw new Error(`no room for another giver in ${a.id}`);
}
function nearSpot(a: Area, from: { x: number; z: number }, lo: number, hi: number): { x: number; z: number } {
  for (let t = 0; t < 400; t++) {
    const p = areaPoint(a, 30, AREA_R + 120);
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d >= lo && d <= hi) return p;
  }
  return areaPoint(a, 60, AREA_R);
}

// --- text --------------------------------------------------------------------
const fill = (t: string, m: Record<string, string>): string => t.replace(/\{(\w+)\}/g, (_x, k) => m[k] ?? `{${k}}`);
const trunc = (t: string, n: number): string => (t.length <= n ? t : t.slice(0, n - 1).replace(/\s+\S*$/, '') + '…');
const slug = (t: string): string => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// --- the draw ----------------------------------------------------------------
interface Entry { nonce: string; level: number; theme: string; quest: unknown; npc: unknown; draft: unknown }
const entries: Entry[] = [];
const titles = new Set<string>();
const fingerprints = new Set<string>();
const report = { perLevel: {} as Record<number, number>, perArea: {} as Record<string, number>, goals: {} as Record<string, number>, breadcrumbs: 0, chains: 0, refused: {} as Record<string, number> };
const refuse = (why: string): void => { report.refused[why] = (report.refused[why] ?? 0) + 1; };
let voiceCounter = 0;

const wanted = AREAS.filter((a) => (!ONLY_LEVEL || a.level === ONLY_LEVEL) && (!ONLY_AREA || a.id === ONLY_AREA));
const perArea = Math.ceil(COUNT / wanted.length);

for (const area of wanted) {
  const next = AREAS.find((a) => a.id === area.next)!;
  const station = STATION.get(area.station)!;
  const nextStation = STATION.get(next.station)!;
  const level = area.level;
  const needFlags = level === 1 ? ['act0:trained'] : ['act1:open'];
  let made = 0;
  let giverN = 0;
  const patternCount = new Map<string, number>();
  const goalOrder = GOALS.slice().sort(() => rnd() - 0.5);
  let goalCursor = 0;
  let specCursor = Math.floor(rnd() * area.sydney.length);
  let guard = 0;
  while (made < perArea && guard++ < perArea * 6) {
    // --- the giver: an archetype, a name nobody within 2.5 km has, a spot.
    const key = area.people[giverN % area.people.length];
    const arch = ARCH[key];
    if (!arch) throw new Error(`banks.json: no archetype ${key}`);
    const spot = giverSpot(area);
    const pool = NAMES[arch.pool] ?? NAMES.anglo;
    let first = '';
    for (let t = 0; t < pool.length * 2; t++) {
      const cand = pool[(giverN * 7 + t * 3 + Math.floor(rnd() * pool.length)) % pool.length];
      if (!nameTaken(cand, spot.x, spot.z)) { first = cand; break; }
    }
    if (first === '') {
      // Every bare name in reach is taken: "Thanh P." is one character in a
      // player's head and not another Thanh, which is what the gate protects.
      const initials = 'ABCDEFGHJKLMNPRSTVW';
      outer: for (let t = 0; t < pool.length; t++) {
        const bare = pool[(giverN * 5 + t) % pool.length];
        for (const ch of initials) {
          const cand = `${bare} ${ch}.`;
          if (!nameTaken(cand, spot.x, spot.z)) { first = cand; break outer; }
        }
      }
    }
    if (first === '') { refuse('no free first name in reach'); giverN++; continue; }
    giverN++;
    const giverId = `qg-${area.id}-${slug(first)}`.slice(0, 48);
    const specific = area.sydney[specCursor % area.sydney.length];
    specCursor++;
    const m = { place: area.name.replace(/ and .*$/, ''), specific, first, next: next.name.replace(/ and .*$/, ''), station: area.station };
    placedGivers.push({ first, x: spot.x, z: spot.z });

    // --- two or three jobs for this giver: the first two chain.
    const jobs = Math.min(3, perArea - made) >= 2 ? (rnd() < 0.5 ? 3 : 2) : 1;
    const questIds: string[] = [];
    const quests: any[] = [];
    const reportNodes: any[] = [];
    for (let j = 0; j < jobs; j++) {
      const crumb = (made + j) % 6 === 5;
      let goal: Goal | null = null;
      let spec = specific;
      const crumbs = GOALS.filter((x) => x.cat === 'crumb');
      for (let t = 0; t < GOALS.length * area.sydney.length && goal === null; t++) {
        const g = crumb ? crumbs[(made + j + t) % crumbs.length] : goalOrder[goalCursor++ % goalOrder.length];
        if (!crumb && g.cat === 'crumb') continue;
        spec = area.sydney[(specCursor + Math.floor(t / GOALS.length) + t) % area.sydney.length];
        const fp = `${area.id}|${level}|${g.key}|${spec}`;
        if (fingerprints.has(fp)) continue;
        const pattern = g.steps.map((s) => s[0]).join('+');
        const share = ((patternCount.get(pattern) ?? 0) + 1) / (made + 1);
        if (made > 6 && share > PATTERN_SHARE) continue;
        fingerprints.add(fp);
        patternCount.set(pattern, (patternCount.get(pattern) ?? 0) + 1);
        goal = g;
      }
      if (goal === null) { refuse('no unique goal left for the area'); break; }
      const mm = { ...m, specific: spec, when: WHEN[(made * 7 + j * 3 + level) % WHEN.length], day: DAY[(made * 5 + j + level * 2) % DAY.length] };
      const id = `qg-l${level}-${area.id}-${String(made + 1).padStart(3, '0')}`;
      const title = trunc(cased(fill(goal.title, mm)), MAX_TITLE);
      if (titles.has(title) || shippedTitles.has(title)) { refuse('title collision'); fingerprints.delete(`${area.id}|${level}|${goal.key}|${spec}`); continue; }
      const core = fill(goal.core, mm);
      const blurb = weave(core, voiceFor(voiceCounter++, SEED + AREAS.indexOf(area) * 3));
      if (worstOverlap(blurb) > SHINGLE_MAX) { refuse('blurb shares half a sentence'); fingerprints.delete(`${area.id}|${level}|${goal.key}|${spec}`); continue; }
      // steps
      const steps: any[] = [];
      let spot1: { x: number; z: number } | null = null;
      let spot2: { x: number; z: number } | null = null;
      let far = 0;
      const stepPoint = (tag: string): { x: number; z: number } => {
        // A station is *on* the tracks; the point beside it is found the way
        // every other point is, off the rails and out of the buildings.
        if (tag === '{nextspot}') return besideStation(next);
        if (tag === '{stationspot}') return besideStation(area);
        if (tag === '{spot2}') { spot2 ??= nearSpot(area, spot1 ?? spot, 120, 380); return spot2; }
        spot1 ??= nearSpot(area, spot, 110, 420); return spot1;
      };
      let walk = 0; let last = spot;
      for (const s of goal.steps) {
        const kind = String(s[0]);
        const label = fill(String(s[s.length - 1]), mm);
        if (kind === 'photo' || kind === 'goto') {
          const p = stepPoint(String(s[1]));
          steps.push({ kind, x: p.x, z: p.z, radius: kind === 'photo' ? 40 : 30, label });
          walk += Math.hypot(p.x - last.x, p.z - last.z); last = p;
          far = Math.max(far, Math.hypot(p.x - spot.x, p.z - spot.z));
        } else if (kind === 'ko') {
          steps.push({ kind, npc: String(s[1]), count: Number(s[2]), label });
        } else if (kind === 'buy') {
          steps.push({ kind, powerup: String(s[1]), count: Number(s[2]), label });
        } else if (kind === 'earn') {
          steps.push({ kind, dollars: Math.round(Number(s[1]) * (1 + (level - 1) * 0.12)), label });
        } else if (kind === 'ride') {
          steps.push({ kind, line: -1, from: area.station, to: next.station, label });
          last = nextStation; far = Math.max(far, Math.hypot(nextStation.x - spot.x, nextStation.z - spot.z));
        } else if (kind === 'dialog') {
          const node = `report-${j}`;
          steps.push({ kind, npc: giverId, node, label });
          reportNodes.push({ id: node, line: trunc(fill(pick([
            'Go on then. Slowly. I want the version you\'d tell the police, not the one you\'d tell the pub. -- {first} listens with both arms folded.',
            'Right. And you\'re sure it was {specific}? People say {specific} when they mean the bit next to it. -- {first} writes something down anyway.',
            'That\'s what I thought. That\'s exactly what I thought and nobody in {place} would say it to my face. Ta.',
          ]), mm), MAX_LINE), choices: [{ text: 'That\'s the lot.', goto: 'hello' }] });
        }
      }
      walk += Math.hypot(last.x - spot.x, last.z - spot.z);
      const hasRide = steps.some((s) => s.kind === 'ride');
      if (!hasRide && walk > WALK_M) { refuse('walk over 2.6 km'); fingerprints.delete(`${area.id}|${level}|${goal.key}|${spec}`); continue; }
      const errandOnly = steps.every((s) => s.kind === 'goto' || s.kind === 'dialog');
      if (errandOnly && far < BREADCRUMB_M) { refuse('errand that ends at nobody'); continue; }
      // reward, escalating along the chain
      const chained = j === 1 && questIds.length === 1;
      const base = { cash: Math.round(48 + 14.5 * level + between(-8, 12)), xp: Math.round(105 + 44 * level + between(-15, 25)) };
      const reward = chained ? { cash: Math.round(base.cash * 1.3), xp: Math.round(base.xp * 1.3), unlock: [] } : { ...base, unlock: [] };
      const quest = {
        id, act: 3, title, blurb, giver: giverId, level,
        requires: chained ? [questIds[0]] : [],
        repeatable: true,
        needFlags,
        steps,
        reward,
      };
      quests.push(quest);
      questIds.push(id);
      titles.add(title);
      indexBlurb(blurb);
      report.goals[goal.key] = (report.goals[goal.key] ?? 0) + 1;
      if (goal.cat === 'crumb') report.breadcrumbs++;
      if (chained) report.chains++;
      entries.push({
        nonce: id, level, theme: area.id, quest, npc: null,
        draft: {
          area: area.id, station: area.station, fingerprint: `${area.id}|${level}|${goal.key}|${spec}`,
          sydney: [area.name, spec, area.station],
          aussie: `${first}, ${arch.role}`,
          breadcrumb: goal.cat === 'crumb' || hasRide ? { to: next.id, station: next.station } : null,
          chain: chained ? { after: questIds[0] } : null,
          implement: 'entry-validate -> place-nudge -> place-check -> merge into content/{quests,dialog}/area-<area>-<n>.json (<= 64 quests, 32 npcs a pack; never pool-l<N>) -> place-clear --all --apply -> content-check && quest-quality -> commit content/ and push. Act 3, repeatable: the week resets it.',
        },
      });
      made++;
    }
    if (quests.length === 0) { placedGivers.pop(); continue; }
    // --- the giver's dialog: hello, what, jobs, done, small talk, and the report nodes.
    const persona = `${first}, ${arch.role} in ${m.place}, Sydney. Dry, specific, local; never says g'day or crikey; talks about ${specific} like everyone knows it.`;
    const npc = {
      id: giverId, name: `${first}, ${arch.role}`, x: spot.x, z: spot.z, radius: 5, root: 'hello',
      nodes: [
        { id: 'hello', line: trunc(fill(arch.hello, m), MAX_LINE), choices: [
          { text: 'What is it you do round here?', goto: 'what' },
          { text: 'Got any work going?', goto: 'jobs' },
          { text: 'I\'ve done what you asked.', goto: 'done' },
          { text: trunc(`What's ${m.place} like these days?`, MAX_CHOICE), goto: 'small' },
          { text: 'Nothing. Carry on.', goto: '' },
        ] },
        { id: 'what', line: trunc(fill(arch.what, m), MAX_LINE), choices: [{ text: 'Right. Anything I can do?', goto: 'jobs' }, { text: 'Fair enough.', goto: 'hello' }] },
        { id: 'jobs', line: trunc(quests.length === 1 ? `One thing, and it's ${quests[0].title.toLowerCase()}.` : `A couple of things, if you're serious. Start with the first; the rest follow.`, MAX_LINE), choices: [
          ...quests.map((q: any, i: number) => ({ text: trunc(q.title, MAX_CHOICE), accept: q.id, denyFlag: `w:${q.id}`, ...(i === 1 ? { needFlag: `w:${quests[0].id}` } : {}) })),
          { text: 'Not today.', goto: 'hello' },
        ] },
        { id: 'done', line: trunc(fill(pick([
          'Show me. -- {first} looks it over the way {place} looks over a new cafe. -- That\'ll do. Here.',
          'Took your time. -- {first} counts it out without looking up. -- Don\'t spend it all at {specific}.',
          'Good. Now I owe you and I hate that. -- {first} pays up on the spot.',
        ]), m), MAX_LINE), choices: [
          ...quests.map((q: any) => ({ text: trunc(`About ${q.title.toLowerCase()}.`, MAX_CHOICE), turnin: q.id })),
          { text: 'Not finished yet.', goto: 'hello' },
        ] },
        { id: 'small', line: trunc(fill(arch.small, m), MAX_LINE), improv: { persona: trunc(persona, 200), context: trunc(`Someone has asked what ${m.place} is like these days. You are standing near ${specific}.`, 200) }, choices: [{ text: 'Ha. Cheers.', goto: 'hello' }] },
        ...reportNodes,
      ],
    };
    for (const e of entries.slice(-quests.length)) e.npc = npc;
    report.perLevel[level] = (report.perLevel[level] ?? 0) + quests.length;
    report.perArea[area.id] = (report.perArea[area.id] ?? 0) + quests.length;
  }
}

// --- validate every entry exactly as entry-validate.ts would ---------------------
const errors: string[] = [];
for (const e of entries) {
  const q = parseQuestPack({ pack: 'draft', quests: [e.quest] }, 'draft-q');
  const d = parseDialogPack({ pack: 'draft', npcs: [e.npc] }, 'draft-d');
  const errs = [...(q.errors ?? []), ...(d.errors ?? [])];
  if (q.value && d.value) {
    // the giver's other quests are referenced by the npc's jobs/done nodes; validate with all of them
    const siblings = entries.filter((s) => (s.npc as any).id === (e.npc as any).id).map((s) => s.quest);
    const qq = parseQuestPack({ pack: 'draft', quests: siblings }, 'draft-q');
    if (qq.value) errs.push(...validateBundle(qq.value.quests, d.value.npcs));
  }
  for (const s of (e.quest as any).steps) {
    if (s.kind === 'ko' && !KO.has(String(s.npc).toLowerCase())) errs.push(`ko npc ${s.npc}`);
    if (s.kind === 'buy' && !BUY.has(String(s.powerup).toLowerCase())) errs.push(`buy powerup ${s.powerup}`);
  }
  const text = JSON.stringify(e);
  for (const w of ['marita', 'MARITA', 'Default', 'DEFAULT', 'default']) if (new RegExp(`\\b${w}\\b`).test(text)) errs.push(`spelling ${w}`);
  if (errs.length) errors.push(`${e.nonce}: ${errs.join('; ')}`);
}
if (errors.length) {
  console.error(`${errors.length} entries failed validation:\n` + errors.slice(0, 12).join('\n'));
  process.exit(1);
}

// --- write -------------------------------------------------------------------
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({ skill: 'quest-generation', seed: SEED, count: entries.length, report, entries }, null, 1));
if (PACKS) {
  for (const a of wanted) {
    const mine = entries.filter((e) => e.theme === a.id);
    const npcs = new Map<string, unknown>();
    for (const e of mine) npcs.set((e.npc as any).id, e.npc);
    const npcList = [...npcs.values()];
    // Packs are cut between givers, never through one: a giver's jobs and the
    // giver itself go in one file, so no npc id is written twice.
    const byGiver = new Map<string, Entry[]>();
    for (const e of mine) {
      const id = (e.npc as any).id;
      const list = byGiver.get(id);
      if (list) list.push(e); else byGiver.set(id, [e]);
    }
    const chunks: Entry[][] = [];
    let current: Entry[] = [];
    // Two caps, both the parser's: 64 quests and 32 npcs a pack, and a pack
    // over either is refused whole. Cut at 60 and 30 so a hand-edit has room.
    let giversIn = 0;
    for (const group of byGiver.values()) {
      if ((current.length + group.length > 60 || giversIn + 1 > 30) && current.length > 0) { chunks.push(current); current = []; giversIn = 0; }
      current.push(...group);
      giversIn++;
    }
    if (current.length) chunks.push(current);
    let n = 0;
    for (const chunk of chunks) {
      n++;
      const ids = new Set(chunk.map((e) => (e.npc as any).id));
      const pack = `area-${a.id}-${n}`;
      mkdirSync(join(PACKS, 'content/quests'), { recursive: true });
      mkdirSync(join(PACKS, 'content/dialog'), { recursive: true });
      writeFileSync(join(PACKS, 'content/quests', `${pack}.json`), JSON.stringify({ pack, quests: chunk.map((e) => e.quest) }, null, 1));
      writeFileSync(join(PACKS, 'content/dialog', `${pack}.json`), JSON.stringify({ pack, npcs: npcList.filter((x: any) => ids.has(x.id)) }, null, 1));
    }
  }
}
console.log(`wrote ${entries.length} entries to ${OUT}`);
console.log('per level', JSON.stringify(report.perLevel));
console.log('breadcrumbs', report.breadcrumbs, 'chains', report.chains, 'goals used', Object.keys(report.goals).length, 'refused', JSON.stringify(report.refused));
