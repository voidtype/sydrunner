/**
 * Validates `content/` exactly the way the server does at boot -- every pack
 * parsed, every prereq resolved, and every `ko` npc and `buy` powerup checked
 * against the kinds this build actually registers.
 *
 *     bun run scripts/content/validate-content.ts
 *     bun run scripts/content/validate-content.ts <content-dir>
 *
 * `server/quests.ts`'s `bundleFrom` is the server's own gate: five minutes
 * after a commit lands on GitHub, the poller fetches `content/quests/` and
 * `content/dialog/`, runs this exact function over them, and either replaces
 * the live pack or logs the refusal and keeps serving the last good one. A
 * content pack goes live with no deploy and no review gate in front of it --
 * DEPLOY.md's runbook is for code, not for this -- so the only backstop
 * between a typo and a hundred players standing in front of a giver with no
 * dialog is whoever runs this file before they push.
 *
 * The `server/sim.ts` import two lines down is not decoration. `bundleFrom`'s
 * `worldRefusals` pass checks a `ko` step's npc name against the registry that
 * `game/characters.ts`, `game/wildlife.ts`, `game/streetlife.ts` and
 * `game/heat.ts` build by calling `registerNpcKind` at module load -- and an
 * *empty* registry is read as "the kind system hasn't loaded yet, skip the
 * check" rather than "no kind exists", specifically so this validator cannot
 * take a real pack down over its own import order (see `worldRefusals`'s own
 * comment in `server/quests.ts`). Importing the one server module that already
 * pulls all four in for their side effects is what makes the registry here the
 * same one the server checks against, rather than an empty one that happens to
 * let everything through.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import '../../server/sim.ts'; // registers every NPC kind, the way the server does at boot
import { bundleFrom } from '../../server/quests.ts';

const REPO = join(import.meta.dir, '..', '..');
const root = process.argv[2] ?? join(REPO, 'content');

const files: Record<string, string> = {};
for (const kind of ['quests', 'dialog']) {
  for (const f of readdirSync(join(root, kind))) {
    if (f.endsWith('.json')) files[`content/${kind}/${f}`] = readFileSync(join(root, kind, f), 'utf8');
  }
}

const { bundle, errors } = bundleFrom(files);
if (errors.length) {
  console.log(errors.map((e) => '  - ' + e).join('\n'));
  process.exit(1);
}
console.log(`content OK: ${bundle.quests.length} quests, ${bundle.npcs.length} npcs`);
