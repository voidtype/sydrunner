/**
 * The register check: no shipped job may be lost by levelling up.
 *
 *     bun run server/register-check.ts
 *
 * **Why this exists as a file of its own.**
 *
 * `verifyQuests` proves the rung arithmetic on a fixture -- a rung-3 job offered
 * at 3, 4, 9 and past the tenth-rung landing -- and it runs at boot in both
 * runtimes, which is where a check of that kind belongs. What it cannot do is
 * ask the question of the **content this repo actually ships**, which is the
 * only place the question was ever answered wrong.
 *
 * The bug it remembers had nothing to do with the arithmetic. `level` was an
 * exact rung: a job was offered while `rungOf(player.level) === level` and at no
 * other time, which is a defensible design and was argued for at length in
 * `questmodel.ts`'s header. Then a player rode from Sydney Park to Redfern,
 * batted a few eshays on the way -- a knockout pays xp, and the register never
 * saw it coming -- and arrived at the Centrelink counter on rung 2. All five of
 * Act 0's mutual obligations sit on rung 1. Every one of them answered
 * `level 1 only`. `act0-review` is what unlocks `act1:open`, so Act 1 and the
 * hundred-job pool went with them. The game had nothing left to say to a player
 * who had done nothing wrong except play the other half of it.
 *
 * The rung is a floor now. This walks every shipped quest at every level from
 * its own rung to past the landing and asserts the register still has it -- so
 * the reversal is a property of the content rather than a note in a header, and
 * a pack that reintroduces the trapdoor fails here rather than at a counter.
 *
 * **It reads the shipped packs through the real loader**, not the JSON, so a
 * quest the parser silently drops is a quest this cannot pass on.
 *
 * The last section is a control. Every gate in this repo that only ever passed
 * is a gate nobody knows the sense of, so the floor is convicted too: below its
 * rung a job must still refuse, and it must refuse pointing *up*.
 */

import { REGISTER_LEVELS, completionFlag, questRefusal, type Quest } from '../client/src/game/questmodel.ts';
import { ContentStore } from './quests.ts';
/*
 * **Imported for their side effects, and that is not a tidy-up to delete.**
 *
 * `NPC_KIND` is a registry these modules fill by calling `registerNpcKind` at
 * import time, and `quests.worldRefusals` validates a `ko` step's `npc` against
 * it. A checker that imports none of them sees a registry holding `police` and
 * judges the shipped packs against it -- which is how this file's first run
 * refused `act0-jobsearch` for naming an eshay. The server gets these through
 * its own import graph; a check has to ask for them.
 */
import '../client/src/game/characters.ts';
import '../client/src/game/factions.ts';
import '../client/src/game/streetlife.ts';
import '../client/src/game/wildlife.ts';
import '../client/src/game/heat.ts';

/** How far past the tenth-rung landing to keep asking. `rungOf` clamps here. */
const OVERSHOOT = REGISTER_LEVELS + 4;

let failures = 0;
function check(ok: boolean, what: string, detail = ''): void {
  if (ok) {
    console.log(`  PASS  ${what}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${what}${detail ? `  -- ${detail}` : ''}`);
}

/**
 * A player this quest has no reason to refuse **except** the rung.
 *
 * Every other gate is satisfied on purpose: the faction is the quest's own, the
 * prerequisites are marked done, the needed flags are set and the denied ones
 * are not. So an empty refusal means the rung let it through, and a non-empty
 * one names the rung -- which is the only thing this file is asking about.
 */
function facts(quest: Quest, level: number) {
  const story = new Set<string>();
  for (const need of quest.requires) story.add(completionFlag(need));
  for (const flag of quest.needFlags) story.add(flag);
  return { level, faction: quest.faction, story, cash: 1_000_000 };
}

const store = new ContentStore({
  dir: new URL('../content', import.meta.url).pathname,
  ledgerPath: `${process.env.SYDNEY_STATE_DIR ?? './data/state'}/register-check-ledger.json`,
  timers: false,
});
const errs = await store.load();
check(errs.length === 0, 'content/ validates through the real loader', errs.slice(0, 3).join('; '));

const quests = store.bundle.quests;
check(quests.length > 0, `the shipped bundle has quests to check`, `${quests.length}`);

console.log(`\n--- every shipped job, from its own rung to level ${OVERSHOOT} ---`);
{
  const lost: string[] = [];
  let asked = 0;
  for (const quest of quests) {
    for (let level = quest.level; level <= OVERSHOOT; level++) {
      asked++;
      const why = questRefusal(quest, facts(quest, level), {});
      if (why !== '') lost.push(`${quest.id} (rung ${quest.level}) at level ${level}: ${why}`);
    }
  }
  check(
    lost.length === 0,
    `no job is refused above its own rung -- ${quests.length} quests, ${asked} offers asked`,
    lost.slice(0, 5).join(' | '),
  );
}

console.log('\n--- the story spine, at the level a player really arrives on ---');
{
  // The exact case that was reported: Act 0 asked by somebody who levelled on
  // the way down. Named by id rather than swept, because these are the jobs
  // whose loss ends the game rather than costs a job.
  const SPINE = [
    'act0-ladmaster',
    'act0-report',
    'act0-jobsearch',
    'act0-evidence',
    'act0-travel',
    'act0-training',
    'act0-review',
    'act1-marita-roundup',
    'act1-default-audit',
  ];
  const missing = SPINE.filter((id) => !quests.some((q) => q.id === id));
  check(missing.length === 0, 'the story spine is all in the bundle', missing.join(', '));
  const refused: string[] = [];
  for (const id of SPINE) {
    const quest = quests.find((q) => q.id === id);
    if (!quest) continue;
    // **From its own rung upward**, not from level 1: a rung-2 job refusing a
    // level-1 player is the floor doing its job, and the floor is the half of
    // this rule that survived. What must never happen again is the other
    // direction -- the review sitting on rung 2 and vanishing at rung 3.
    for (const level of [quest.level, quest.level + 1, 5, 10, OVERSHOOT]) {
      if (level < quest.level) continue;
      const why = questRefusal(quest, facts(quest, level), {});
      if (why !== '') refused.push(`${id} at level ${level}: ${why}`);
    }
  }
  check(refused.length === 0, 'and every one of it is offered at its own rung and every level above it', refused.slice(0, 5).join(' | '));

  /*
   * One thing the floor does not fix, named here so it is not rediscovered at a
   * counter: `act0-review` sits on rung 2 and the five obligations pay 700 xp
   * between them against the 1000 a level costs. A player who does only the
   * five arrives at the review still on rung 1 and is told "level 2 first".
   *
   * That is survivable in a way the old bug was not -- the way out is to play,
   * and playing now only ever *opens* work -- and `act0-jobsearch` asks for
   * three knockouts, which pay. It is asserted rather than assumed so that a
   * content edit which drops the review's rung, or the knockouts, has to look
   * at this sentence first.
   */
  const review = quests.find((q) => q.id === 'act0-review');
  if (review) {
    check(review.level <= 2, 'the review sits no higher than rung 2, which the obligations can reach', `rung ${review.level}`);
  }
}

console.log('\n--- the control: the floor still bites, and it points up ---');
{
  // A gate only ever seen passing is a gate nobody knows the sense of. These
  // are the jobs with a rung above the first, asked one rung below their own.
  const above = quests.filter((q) => q.level > 1 && !q.anyRung);
  check(above.length > 0, 'there are jobs above rung 1 to test the floor with', `${above.length}`);
  const leaked: string[] = [];
  for (const quest of above) {
    const why = questRefusal(quest, facts(quest, quest.level - 1), {});
    if (why !== `level ${quest.level} first`) leaked.push(`${quest.id} one rung below reads ${JSON.stringify(why)}`);
  }
  check(leaked.length === 0, 'every one of them refuses one rung below itself, pointing up', leaked.slice(0, 5).join(' | '));

  // And the exemption still exempts, or `anyRung` has quietly stopped meaning
  // anything now that the ceiling is gone.
  const exempt = quests.filter((q) => q.anyRung && q.level > 1);
  if (exempt.length > 0) {
    const held = exempt.filter((q) => questRefusal(q, facts(q, 1), {}) === '');
    check(held.length === exempt.length, 'an anyRung job is still takeable below its rung', `${held.length}/${exempt.length}`);
  } else {
    console.log('  ....  no anyRung job sits above rung 1; nothing to say about the exemption');
  }
}

console.log(failures === 0 ? '\nregister-check: OK' : `\nregister-check: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
