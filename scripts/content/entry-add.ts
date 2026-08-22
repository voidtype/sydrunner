/**
 * Appends one pool entry's quest and NPC to the repo's per-level packs,
 * `content/quests/pool-l<N>.json` and `content/dialog/pool-l<N>.json`,
 * creating the pack when it is the level's first.
 *
 *     bun run scripts/content/entry-add.ts <entry.json>
 *
 * Takes the entry as a file path rather than a nonce looked up in some
 * session's own scratch directory, because the pack this reads from is a
 * property of *this run of the tool*, not of the repo -- a content drop
 * arrives as a pile of `{nonce, level, theme, quest, npc}` files wherever the
 * judging step for that round happened to leave them, and the only thing this
 * script should assume about that location is that it was told where it is.
 *
 * Refuses a second copy of the same quest or npc id, refuses a giver whose
 * first name is already taken (`entry.name.split(',')[0]` is what the player
 * sees above the dialog, and two givers called "Dale" are one character in
 * the player's head even if their ids differ), and refuses a giver standing
 * within 25 m of an existing one (two markers on one spot is a dialog you
 * cannot reach). All three checks run against **every** pack already in
 * `content/dialog`, not just the level's own, because a name or a doorway
 * collides across the whole city, not just within one rung.
 *
 * Then validates the whole content directory the way the server does at
 * boot, so a merge that broke something upstream -- a prereq the new quest's
 * `requires` was supposed to satisfy, say -- is caught in the same run rather
 * than left for `content-check.ts` to find later.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPTS = import.meta.dir;
const REPO = process.env.SYDNEY_CONTENT ?? join(SCRIPTS, '..', '..', 'content');

const entryPath = process.argv[2];
if (!entryPath) {
  console.log('usage: bun run scripts/content/entry-add.ts <entry.json>');
  process.exit(1);
}
const e = JSON.parse(readFileSync(entryPath, 'utf8'));
const level = e.level, pack = `pool-l${level}`;
const qp = join(REPO, 'quests', `${pack}.json`), dp = join(REPO, 'dialog', `${pack}.json`);
const quests = existsSync(qp) ? JSON.parse(readFileSync(qp, 'utf8')) : { pack, quests: [] };
const dialog = existsSync(dp) ? JSON.parse(readFileSync(dp, 'utf8')) : { pack, npcs: [] };

if (quests.quests.some((q: any) => q.id === e.quest.id)) {
  console.log(`refused: quest "${e.quest.id}" is already in ${pack}`);
  process.exit(1);
}
if (dialog.npcs.some((n: any) => n.id === e.npc.id)) {
  console.log(`refused: npc "${e.npc.id}" is already in ${pack}`);
  process.exit(1);
}

// Two givers with one first name are one character in the player's head.
const mine = e.npc.name.split(',')[0].trim().toLowerCase();
for (const f of readdirSync(join(REPO, 'dialog'))) {
  for (const n of JSON.parse(readFileSync(join(REPO, 'dialog', f), 'utf8')).npcs ?? []) {
    if (n.id !== e.npc.id && n.name.split(',')[0].trim().toLowerCase() === mine) {
      console.log(
        `refused: another giver is already called "${n.name.split(',')[0].trim()}" ("${n.name}", ${n.id} in ${f}); ` +
          'give this one a different first name, in the name and in every line that says it',
      );
      process.exit(1);
    }
  }
}
// Two givers on one spot are two markers on one spot and one dialog you cannot reach.
for (const f of readdirSync(join(REPO, 'dialog'))) {
  for (const n of JSON.parse(readFileSync(join(REPO, 'dialog', f), 'utf8')).npcs ?? []) {
    const d = Math.hypot(n.x - e.npc.x, n.z - e.npc.z);
    if (d < 25) {
      console.log(
        `refused: giver "${e.npc.id}" stands ${d.toFixed(0)} m from "${n.id}" (${f}) at (${n.x}, ${n.z}); ` +
          'move it at least 30 m away, and off the tracks',
      );
      process.exit(1);
    }
  }
}

quests.quests.push(e.quest);
dialog.npcs.push(e.npc);
writeFileSync(qp, JSON.stringify(quests, null, 2) + '\n');
writeFileSync(dp, JSON.stringify(dialog, null, 2) + '\n');
console.log(`added "${e.quest.title}" (${e.quest.id}, giver ${e.npc.id}) to ${pack}: now ${quests.quests.length} quest(s)`);

const v = Bun.spawnSync(['bun', 'run', join(SCRIPTS, 'validate-content.ts'), REPO]);
console.log(v.stdout.toString().trim() + v.stderr.toString().trim());
process.exit(v.exitCode ?? 1);
