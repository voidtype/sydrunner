/**
 * Validates one pool entry -- `{nonce, level, theme, quest, npc}` -- against
 * the real parser, before it is anywhere near `content/`.
 *
 *     bun run scripts/content/entry-validate.ts <entry.json>
 *
 * A pool entry is the unit a content drop arrives in: one giver, one quest,
 * written by a round of prompting and judged before it is merged into the
 * shipped per-level pack. `entry-add.ts` is where it is merged; this is the
 * gate before that, and it runs `parseQuestPack` / `parseDialogPack` /
 * `validateBundle` from `client/src/game/questmodel.ts` -- the exact functions
 * `bundleFrom` calls on every pack the server ships -- over a one-quest,
 * one-npc pack, so a broken entry is caught at the entry stage rather than
 * discovered wrapped inside 99 good ones.
 *
 * It does **not** import `server/sim.ts` the way `validate-content.ts` does,
 * and that is deliberate rather than an oversight: booting the registry costs
 * real time and this runs once per candidate entry, of which a hundred get
 * judged for every ten that ship. The `ko`/`buy` name checks below are read
 * live off `game/factions.npcKinds()` and `game/powerups.KIND_NAME` instead --
 * the same two registries `worldRefusals` in `server/quests.ts` checks
 * against -- which costs importing the faction and powerup modules but not the
 * whole `Simulation`. `content-check.ts`, the gate a whole drop has to clear
 * before it ships, does pay for the full boot and re-checks this exactly.
 */
import { readFileSync } from 'node:fs';
import { parseQuestPack, parseDialogPack, validateBundle } from '../../client/src/game/questmodel.ts';
import { npcKinds } from '../../client/src/game/factions.ts';
import { KIND_NAME } from '../../client/src/game/powerups.ts';

const path = process.argv[2];
const entry = JSON.parse(readFileSync(path, 'utf8'));
const errors: string[] = [];

if (!entry.nonce || !entry.level || !entry.quest || !entry.npc) errors.push('entry needs nonce, level, quest, npc');
if (entry.quest && entry.quest.level !== entry.level) errors.push(`quest.level ${entry.quest?.level} != entry.level ${entry.level}`);
if (!(entry.level >= 1 && entry.level <= 10)) errors.push('level must be 1..10');

const q = parseQuestPack({ pack: 'pool', quests: [entry.quest] }, 'pool-q');
const d = parseDialogPack({ pack: 'pool', npcs: [entry.npc] }, 'pool-d');
errors.push(...(q.errors ?? []), ...(d.errors ?? []));
if (q.value && d.value) errors.push(...validateBundle(q.value.quests, d.value.npcs));

// The same two registries `server/quests.ts`'s `worldRefusals` checks a `ko`
// step's npc and a `buy` step's powerup against -- read live rather than
// copied, so a kind added to `game/characters.ts` after this file was written
// does not read here as a typo.
const KO = new Set(['any', 'player', ...npcKinds().map((k) => k.name.toLowerCase())]);
const BUY = new Set(['any', ...Object.values(KIND_NAME).map((n) => n.toLowerCase())]);
for (const s of entry.quest?.steps ?? []) {
  if (s.kind === 'ko' && s.npc && !KO.has(String(s.npc).toLowerCase())) {
    errors.push(`ko npc "${s.npc}" is not one of ${[...KO].sort().join(', ')}`);
  }
  if (s.kind === 'buy' && s.powerup && !BUY.has(String(s.powerup).toLowerCase())) {
    errors.push(`buy powerup "${s.powerup}" is not one of ${[...BUY].sort().join(', ')}`);
  }
}

// The two factions' names, spelled exactly one way in every line that says
// them. `server/quests-check.ts` phase G checks the shipped packs for the same
// slips; this catches one entry before it is anywhere near them.
for (const w of ['marita', 'MARITA', 'Default', 'DEFAULT', 'default']) {
  const text = JSON.stringify(entry);
  if (new RegExp(`\\b${w}\\b`).test(text)) errors.push(`spelling: "${w}" -- the factions are written Marita and DeFAULT, exactly`);
}

if (errors.length === 0) {
  console.log('OK', entry.nonce, 'level', entry.level, '--', entry.quest.title);
  process.exit(0);
}
console.log(errors.map((e) => '  - ' + e).join('\n'));
process.exit(1);
