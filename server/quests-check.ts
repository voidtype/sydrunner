/**
 * The quests check: a content pack, a real `Simulation`, and a job walked end
 * to end.
 *
 *     bun run server/quests-check.ts
 *
 * **Why this exists as a file rather than as more of `verifyQuests`.**
 *
 * `client/src/game/questmodel.ts`'s self-check covers everything this feature
 * can get wrong *on paper* -- the parser, the ceilings, the cycle detector, the
 * step arithmetic, the improv rule -- and it runs at boot in both runtimes,
 * which is where a check of that kind belongs. What it cannot cover is
 * everything that only exists once the pieces are wired together:
 *
 *   - a directory of JSON becoming a live bundle, and a **bad** one being
 *     refused whole while the good one keeps serving;
 *   - a knockout in a real `Simulation` reaching a real cursor through the sink
 *     `server/sim.ts` calls;
 *   - a `goto` satisfied by a body actually standing there;
 *   - a dialog click re-walked on the server, with the range test in the way;
 *   - a turn-in paying real money through the wallet door and real xp onto a
 *     real `AccountRecord`, and the level moving because of it;
 *   - **an improv node with no AI configured serving its authored line**, which
 *     is the ordinary configuration and therefore the one that must be tested;
 *   - a guest's story flags not surviving where an account's do;
 *   - the Monday reset clearing the xp and **not** the story;
 *   - **the rung**, which is workstream AN's whole feature: a job offered at
 *     level 3 and refused at 2 *and at 4*, through the op a client really
 *     sends, against a level the engine really reads. `verifyQuests` proves the
 *     arithmetic; only this can prove the wiring, because `levelOf` comes off
 *     the participant and the participant is a thing only a `Simulation` has;
 *   - a repeatable's `w:` mark stopping it being taken twice in one week, and
 *     Monday putting it back.
 *
 * Every one of those is a seam between two files and every one of them fails
 * *silently* in this repo's sense: the game plays perfectly and the quest never
 * advances, or the money is paid twice, or the story resets.
 *
 * It runs in about a second, because it uses **`verifySim`'s empty-city
 * fixture** rather than loading Sydney -- `server/accounts-check.ts` phase A's
 * arrangement, made for its reason: a city with no prisms and no terrain in it
 * is all a punch needs, and this check has to be cheap enough to run on every
 * content edit.
 *
 * The last phase validates the **packs this repo actually ships**, which is the
 * thing an author wants before they push: it is the same `bundleFrom` the
 * server runs five minutes after a commit, so "it validated locally" and "it
 * went live" are the same sentence.
 *
 * **No key is set and none is needed.** The AI seam is exercised in its
 * off state deliberately -- see phase D. A check that required a credential
 * would be a check nobody runs.
 *
 * Exit code 1 on any failure.
 */

import { CollisionWorld } from '../client/src/player/collision.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { SpatialHash } from '../client/src/game/spatialhash.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { XP_PER_KO, XP_PER_LEVEL, resetIfNewWeek, weekOf } from '../client/src/net/accounts.ts';
import {
  REGISTER_LEVELS,
  completionFlag,
  markerFor,
  questView,
  verifyDialog,
  verifyQuests,
  weeklyFlag,
  type PlayerFacts,
} from '../client/src/game/questmodel.ts';
import { QUEST_OP, verifyQuestWire } from '../client/src/net/quests.ts';
import { AccountStore } from './accounts.ts';
import { WalletStore } from './wallets.ts';
import { Simulation, type Participant } from './sim.ts';
import { ContentStore, ImprovCache, QuestEngine, bundleFrom, type QuestWorld } from './quests.ts';
import type { ServerWorld } from './world.ts';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** `verifySim`'s fixture, for its reasons. See `accounts-check.emptyWorld`. */
function emptyWorld(): ServerWorld {
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

/** `accounts-check.squareUp`, verbatim in intent: face them, seed both histories. */
function squareUp(sim: Simulation, attacker: Participant, victim: Participant, x: number, z: number): void {
  attacker.combat.body.position.set(x, EYE_HEIGHT, z + 1.1);
  victim.combat.body.position.set(x, EYE_HEIGHT, z);
  attacker.combat.body.yaw = 0;
  attacker.input.yaw = 0;
  victim.combat.body.yaw = 0;
  victim.input.yaw = 0;
  attacker.viewTicks = 0;
  attacker.history.seed(sim.tick, x, EYE_HEIGHT, z + 1.1, 0);
  victim.history.seed(sim.tick, x, EYE_HEIGHT, z, 0);
}

/** Punch until the attacker's KO count moves. `accounts-check.knockDown`. */
function knockDown(sim: Simulation, attacker: Participant, victim: Participant, x: number, z: number): boolean {
  const out = { tick: 0, events: [], snapshot: null };
  const want = attacker.kos + 1;
  for (let i = 0; i < 400 && attacker.kos < want; i++) {
    squareUp(sim, attacker, victim, x, z);
    attacker.input.punch = true;
    sim.step(out);
    attacker.input.punch = false;
    sim.step(out);
  }
  // Out of the knockout phase before the next one, or punching a corpse loops.
  for (let t = 0; t < 400 && victim.combat.phase === 'ko'; t++) sim.step(out);
  return attacker.kos >= want;
}

/** Where the body is put for a `goto`. Away from the origin, so it is a move. */
const SITE_X = 120;
const SITE_Z = -80;

/**
 * A clock that moves, and every op is driven off it.
 *
 * The first run of this check failed three assertions in phase E and the cause
 * was **this file's own traffic against the engine's flood guard**: forty ops
 * inside one millisecond is not a thing a person does, so the budget refused
 * the last of them and the check reported it as a quest being unavailable.
 * That was worth catching -- the burst was genuinely too tight and
 * `QUEST_BURST` now says so -- but a walk that silently depends on the budget
 * is a check that breaks the day somebody adds three assertions to it, for a
 * reason that has nothing to do with what they changed.
 *
 * So the walk runs on a clock that advances a quarter-second an op, which is
 * about the rate a person clicks, and the budget is tested **on purpose** in
 * its own block instead. See `floodCheck`.
 */
let clock = 1_800_000_000_000;
function at(): number {
  clock += 250;
  return clock;
}

/**
 * The fixture, written the way a content author writes one.
 *
 * Deliberately **not** the shipped Act 0 pack: this has to exercise every step
 * kind the driver can reach in an empty city, and it has to keep working when
 * somebody rewrites Denise's dialogue. Phase E is where the real packs are
 * checked, and it checks them the way the server will.
 */
const FIXTURE_QUESTS = {
  pack: 'check',
  quests: [
    {
      id: 'check-run',
      act: 0,
      title: 'The Run',
      blurb: 'Get there, drop two, come back and say so.',
      giver: 'clerk',
      steps: [
        { kind: 'goto', x: SITE_X, z: SITE_Z, radius: 20, label: 'get to the site' },
        { kind: 'ko', npc: 'player', count: 2, label: 'drop two' },
        { kind: 'dialog', npc: 'clerk', node: 'done', label: 'report back' },
      ],
      reward: { cash: 40, xp: 250, unlock: ['check:ran'] },
    },
    {
      id: 'check-weekly',
      act: 1,
      title: 'The Weekly',
      blurb: 'Comes round again.',
      giver: 'clerk',
      repeatable: true,
      requires: ['check-run'],
      steps: [{ kind: 'earn', dollars: 30, label: 'earn thirty' }],
      reward: { cash: 10, xp: 100 },
    },
    /*
     * WORKSTREAM AN: the rung, and it has a **giver of its own**.
     *
     * Not another pair of choices on Denise's node, because that node is
     * already at `MAX_CHOICES`. A second NPC is also the shape the content pool
     * is being written in -- one self-contained giver per job -- so the
     * exact-level walk below exercises the arrangement the packs will actually
     * arrive in rather than a fixture nothing resembles.
     */
    {
      id: 'check-rung3',
      act: 1,
      title: 'Rung Three',
      blurb: 'Only while you are level three. Not before, and not after.',
      giver: 'clerk3',
      level: 3,
      steps: [{ kind: 'earn', dollars: 5, label: 'earn five' }],
      reward: { cash: 5, xp: 10 },
    },
  ],
};

const FIXTURE_DIALOG = {
  pack: 'check',
  npcs: [
    {
      id: 'clerk',
      name: 'A clerk',
      x: 0,
      z: 0,
      radius: 5,
      root: 'hello',
      nodes: [
        {
          id: 'hello',
          line: 'take a number.',
          choices: [
            { text: 'give me the run', accept: 'check-run' },
            { text: 'give me the weekly', accept: 'check-weekly' },
            { text: 'done the run', turnin: 'check-run' },
            { text: 'done the weekly', turnin: 'check-weekly' },
            { text: 'reporting back', goto: 'done' },
            { text: 'how long is the wait', goto: 'waiting' },
          ],
        },
        { id: 'done', line: 'noted.', choices: [{ text: 'right', goto: 'hello' }] },
        {
          id: 'waiting',
          // The improv demonstration. With no key set -- which is how this
          // check runs and how a laptop runs -- this exact string is what
          // serves. See phase D.
          line: 'forty minutes. the screen says twelve. the screen is aspirational.',
          improv: { persona: 'a bored clerk', context: 'the queue display is wrong and always has been' },
          choices: [{ text: "i'll sit down", goto: 'hello' }],
        },
      ],
    },
    /** The rung-3 job's own giver. See `check-rung3`. */
    {
      id: 'clerk3',
      name: 'Another clerk',
      x: 0,
      z: 0,
      radius: 5,
      root: 'hello',
      nodes: [
        {
          id: 'hello',
          line: 'not for you. not yet, anyway.',
          choices: [
            { text: 'the rung three job', accept: 'check-rung3' },
            { text: 'done the rung three job', turnin: 'check-rung3' },
          ],
        },
      ],
    },
  ],
};

/** Write a pack directory under the scratch root and hand back its path. */
async function writePack(dir: string, quests: unknown, dialog: unknown): Promise<void> {
  await Bun.$`mkdir -p ${dir}/quests ${dir}/dialog`.quiet();
  await Bun.write(`${dir}/quests/check.json`, JSON.stringify(quests, null, 2));
  await Bun.write(`${dir}/dialog/check.json`, JSON.stringify(dialog, null, 2));
}

async function main(): Promise<void> {
  // --- Phase 0: the three boot checks, in this process, before anything else.
  //
  // Run here as well as in the two boot lists because this file is what an
  // author runs after editing content, and a failure in one of these means
  // every verdict below is about a broken validator rather than about a pack.
  for (const [name, out] of [
    ['verifyQuests', verifyQuests()],
    ['verifyDialog', verifyDialog()],
    ['verifyQuestWire', verifyQuestWire()],
  ] as Array<[string, string[]]>) {
    check(out.length === 0, `${name} passes`, out.slice(0, 3).join('; '));
  }

  const scratch = `${process.env.SYDNEY_STATE_DIR ?? './data/state'}/quests-check`;
  await Bun.$`rm -rf ${scratch}`.quiet().nothrow();
  const contentDir = `${scratch}/content`;
  await writePack(contentDir, FIXTURE_QUESTS, FIXTURE_DIALOG);

  // --- Phase A: the content store ------------------------------------------------
  console.log('\n--- phase A: a directory of JSON becomes a bundle ---');
  const content = new ContentStore({ dir: contentDir, ledgerPath: `${scratch}/ledger.json`, timers: false });
  const loadErrors = await content.load();
  check(loadErrors.length === 0, 'the fixture pack loads clean', loadErrors.slice(0, 2).join('; '));
  check(content.bundle.quests.length === 3, 'all three quests are live', `${content.bundle.quests.length}`);
  check(content.bundle.npcs.length === 2, 'both clerks are live', `${content.bundle.npcs.length}`);
  const goodRevision = content.revision;
  check(goodRevision !== '' && goodRevision !== '0', 'the bundle has a revision', goodRevision);

  // The ETag contract, which is the whole of how a client avoids re-fetching.
  {
    const etag = `"${goodRevision}"`;
    const fresh = await (await import('./quests.ts')).contentResponse(content, new Request('http://x/content'));
    check(fresh.status === 200 && fresh.headers.get('etag') === etag, 'GET /content answers 200 with an ETag');
    const again = (await import('./quests.ts')).contentResponse(
      content,
      new Request('http://x/content', { headers: { 'if-none-match': etag } }),
    );
    check(again.status === 304, 'and 304s a client that already has that revision', `${again.status}`);
  }

  /*
   * **A malformed pack is refused whole and the old one keeps serving.**
   *
   * The single most important assertion in this file. Half a pack is worse
   * than none: it is a player standing in Marrickville whose fourth step no
   * longer exists, with a cursor pointing at it, and nothing anywhere saying
   * why. Four different kinds of wrong are tried, because they fail at four
   * different stages -- the JSON parser, the schema, the ceilings and the
   * cross-file references -- and a store that caught three of them would look
   * completely healthy.
   */
  {
    const cases: Array<[string, unknown, string]> = [
      ['not JSON at all', '{ "quests": [', 'raw'],
      ['a step kind nobody wrote', { quests: [{ id: 'x', giver: 'clerk', steps: [{ kind: 'befriend' }] }] }, 'json'],
      [
        'a reward over the ceiling',
        { quests: [{ id: 'x', giver: 'clerk', steps: [{ kind: 'earn', dollars: 5 }], reward: { cash: 1000000 } }] },
        'json',
      ],
      [
        'a prereq that does not exist',
        { quests: [{ id: 'x', giver: 'clerk', requires: ['ghost'], steps: [{ kind: 'earn', dollars: 5 }] }] },
        'json',
      ],
    ];
    for (const [why, body, form] of cases) {
      const files = {
        'content/quests/check.json': form === 'raw' ? (body as string) : JSON.stringify(body),
        'content/dialog/check.json': JSON.stringify(FIXTURE_DIALOG),
      };
      const built = bundleFrom(files);
      check(built.errors.length > 0, `a pack with ${why} is refused`, built.errors[0]?.slice(0, 70) ?? '');
    }
    // And the store keeps serving what it had. Driven through the same
    // `bundleFrom` the poll uses, then asserted against the live bundle.
    check(content.revision === goodRevision, 'the live revision did not move while bad packs were rejected');
    check(content.bundle.quests.length === 3, 'and the good pack is still being served', `${content.bundle.quests.length} quest(s)`);
  }

  // --- Phase B: a quest walked through a real Simulation --------------------------
  console.log('\n--- phase B: goto, ko, dialog, turn in ---');
  const walletPath = `${scratch}/wallets.json`;
  const accountPath = `${scratch}/accounts.json`;
  const wallets = new WalletStore(walletPath);
  await wallets.load();
  const accounts = new AccountStore(accountPath);
  await accounts.load();
  const signed = await accounts.signup('Bazza', 'hunter2hunter2', '', wallets);
  const record = accounts.byHandle('bazza');
  if (!signed.ok || !record) {
    check(false, 'the check account exists');
    return;
  }
  check(record.xp === 0 && record.level === 1, 'a fresh account starts at 0 xp, level 1', `${record.xp} xp`);

  const sim = new Simulation(emptyWorld(), { wallets, accounts });
  const hero = sim.join(0, null, record.handle, record);
  const victim = sim.join(1, null, 'Davo');

  /**
   * The one host in this check. `server/index.ts`'s `questWorld`, in miniature.
   *
   * Frames are recorded **with the player they were addressed to**, because
   * `flush` sends to everybody who is pending and a bare count would answer
   * "did anything go out to anyone" when the question is always "did anything
   * go out to *this* player". The first cut counted the array and reported a
   * failure that was really the hero's frame arriving beside the clicker's.
   */
  const sent: Array<{ id: number; frame: ArrayBuffer }> = [];
  const framesFor = (id: number): number => sent.filter((f) => f.id === id).length;
  const world: QuestWorld = {
    eachPlayer(fn) {
      for (const p of sim.participants.values()) if (p.bot === null) fn(p.id);
    },
    positionOf(id) {
      const p = sim.participants.get(id);
      return p ? { x: p.combat.body.position.x, z: p.combat.body.position.z } : null;
    },
    accountOf: (id) => sim.participants.get(id)?.account ?? null,
    isBot: (id) => (sim.participants.get(id)?.bot ?? null) !== null,
    levelOf: (id) => sim.participants.get(id)?.level ?? 1,
    teamOf: (id) => sim.participants.get(id)?.team ?? 0,
    cashOf: (id) => sim.wallet.balanceOf(id),
    credit: (id, amount, why) => {
      sim.wallet.credit(id, amount, why);
    },
    debit: (id, amount, why) => sim.wallet.debit(id, amount, why),
    note: (id, text) => sim.note(id, text),
    // WORKSTREAM AN: `server/index.ts`'s two lines, in miniature. Without this
    // the participant's level never follows the record's when a quest pays xp,
    // and every rung above the first would be gated on knockouts alone.
    levelled: (id, level) => {
      const p = sim.participants.get(id);
      if (p) p.level = level;
    },
    rideStation: () => null,
    send: (id, frame) => {
      sent.push({ id, frame });
    },
  };
  // **No url and no key.** The ordinary configuration; see phase D.
  const improv = new ImprovCache({ url: '', key: '' });
  const engine = new QuestEngine(content, improv, world, accounts);
  sim.setQuestSink(engine);

  // Accept it, through the op the client actually sends.
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
  let cursor = engine.cursorFor(hero.id, 'check-run');
  check(cursor !== null, 'the quest was accepted');
  check(cursor?.s === 0, 'and opens on its first step', `step ${cursor?.s}`);
  check(record.quests['check-run'] !== undefined, 'the cursor is on the account record, not beside it');

  // A gate the server has to hold: you cannot take the same job twice.
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
  check(Object.keys(record.quests).length === 1, 'accepting it twice is refused', `${Object.keys(record.quests).length} open`);
  // Nor one whose prereq is unmet.
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-weekly', '', 0, at());
  check(record.quests['check-weekly'] === undefined, 'a quest whose prereq is unmet is refused');

  // Step 1: the goto. Not satisfied from the origin, satisfied at the site.
  engine.tick(1);
  check(engine.cursorFor(hero.id, 'check-run')?.s === 0, 'the goto is not satisfied from the wrong place');
  hero.combat.body.position.set(SITE_X, EYE_HEIGHT, SITE_Z);
  engine.tick(1);
  check(engine.cursorFor(hero.id, 'check-run')?.s === 1, 'standing on the spot advances it', `step ${engine.cursorFor(hero.id, 'check-run')?.s}`);

  // Step 2: two real knockouts, through `creditKo`'s funnel and the sink.
  const beforeXp = record.xp;
  let knocked = 0;
  for (let i = 0; i < 2; i++) if (knockDown(sim, hero, victim, SITE_X, SITE_Z)) knocked++;
  check(knocked === 2, 'two knockouts landed', `${knocked}`);
  cursor = engine.cursorFor(hero.id, 'check-run');
  check(cursor?.s === 2, 'two of two advances past the ko step', `step ${cursor?.s}`);
  check(record.xp === beforeXp + 2 * XP_PER_KO, 'each knockout paid xp', `${record.xp} xp`);

  // A partial count is visible, which is the only feedback the tracker has.
  // Driven on the *other* quest so the walk above is untouched.
  {
    engine.handle(victim.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
    victim.combat.body.position.set(SITE_X, EYE_HEIGHT, SITE_Z);
    engine.tick(1);
    knockDown(sim, victim, hero, SITE_X, SITE_Z);
    const partial = engine.cursorFor(victim.id, 'check-run');
    check(partial?.s === 1 && partial.c[1] === 1, 'one of two is held as progress rather than lost', `${partial?.c[1]} of 2`);
  }

  // Step 3: the dialog. The range test first -- a click from 120 m away is
  // refused, which is what makes a dialog step safe to trust at all.
  engine.handle(hero.id, QUEST_OP.NODE, 'clerk', 'hello', 4, at());
  check(engine.cursorFor(hero.id, 'check-run')?.s === 2, 'a dialog click from out of range does nothing');
  hero.combat.body.position.set(0, EYE_HEIGHT, 0);
  engine.handle(hero.id, QUEST_OP.NODE, 'clerk', 'hello', 4, at());
  cursor = engine.cursorFor(hero.id, 'check-run');
  check(cursor?.d === true, 'arriving at the node in range finishes the quest', `done=${cursor?.d}`);

  // The turn-in: the money, the xp, the level and the flag.
  const cashBefore = sim.wallet.balanceOf(hero.id);
  const xpBefore = record.xp;
  engine.handle(hero.id, QUEST_OP.TURNIN, 'check-run', '', 0, at());
  check(sim.wallet.balanceOf(hero.id) === cashBefore + 40, 'the turn-in paid $40', `$${sim.wallet.balanceOf(hero.id)}`);
  check(record.xp === xpBefore + 250, 'and 250 xp', `${record.xp} xp`);
  check(record.level === 1 + Math.floor(record.xp / 1000), 'and the level follows the xp', `level ${record.level} on ${record.xp}`);
  check(record.story.includes('check:ran'), 'the authored unlock flag was set');
  check(record.story.includes(completionFlag('check-run')), 'and the implicit completion mark');
  check(record.quests['check-run'] === undefined, 'the cursor is gone');

  // Paid once. A second turn-in of a quest already handed in must do nothing.
  const afterCash = sim.wallet.balanceOf(hero.id);
  engine.handle(hero.id, QUEST_OP.TURNIN, 'check-run', '', 0, at());
  check(sim.wallet.balanceOf(hero.id) === afterCash, 'handing it in twice pays nothing', `$${sim.wallet.balanceOf(hero.id)}`);
  // And it is not offered again: the completion mark is what says so.
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
  check(record.quests['check-run'] === undefined, 'a finished story quest cannot be taken again');

  // --- Phase C: the repeatable, and the earn step ---------------------------------
  console.log('\n--- phase C: the weekly, and money as progress ---');
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-weekly', '', 0, at());
  check(record.quests['check-weekly'] !== undefined, 'the prereq is now met and the weekly opens');
  sim.wallet.credit(hero.id, 20, 'fare');
  check(engine.cursorFor(hero.id, 'check-weekly')?.d !== true, '$20 of $30 is not enough');
  sim.wallet.credit(hero.id, 10, 'fare');
  check(engine.cursorFor(hero.id, 'check-weekly')?.d === true, '$30 of $30 finishes it');
  // A debit must not un-earn it. A step that asked for $60 and was undone by
  // buying something would be unreachable for anybody who spends money.
  sim.wallet.debit(hero.id, 25, 'bribe');
  check(engine.cursorFor(hero.id, 'check-weekly')?.d === true, 'spending money does not un-earn the step');
  engine.handle(hero.id, QUEST_OP.TURNIN, 'check-weekly', '', 0, at());
  /*
   * WORKSTREAM AN. A repeatable used to write **nothing**, which meant a job
   * the content file calls weekly could be handed in and taken again in the
   * same breath. It now writes `w:<id>`, which Monday sweeps and a story mark
   * never is -- so "weekly" is true rather than merely written down, and the
   * register has something to draw when it says done.
   */
  check(!record.story.includes(completionFlag('check-weekly')), 'a repeatable writes no permanent completion mark');
  check(record.story.includes(weeklyFlag('check-weekly')), 'it writes a weekly one instead', JSON.stringify(record.story));
  engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-weekly', '', 0, at());
  check(record.quests['check-weekly'] === undefined, 'so it cannot be taken twice in the same week');

  // --- Phase C2: the register, and a level that is a floor ------------------------
  //
  // The feature workstream AN exists for, walked through the ops a client
  // really sends against a level the engine really reads. `verifyQuests` proves
  // the arithmetic in isolation; this is the only thing that can prove the
  // wiring, because `levelOf` comes off a `Participant` and a `Participant` is
  // a thing only a `Simulation` has.
  console.log('\n--- phase C2: refused at 2, offered at 3 and still offered at 4 ---');
  {
    const clerk3 = content.bundle.npcs.find((n) => n.id === 'clerk3');
    if (!clerk3) {
      check(false, "the rung-3 job's own giver is in the bundle");
    } else {
      // The two halves of "who is this player", assembled the way the engine
      // assembles them. `faction` is empty because nothing in this fixture is
      // side-gated and the two spellings are `verifyQuests`' business.
      const facts = (): PlayerFacts => ({
        level: hero.level,
        faction: '',
        story: new Set(record.story),
        cash: sim.wallet.balanceOf(hero.id),
      });
      const view = () => questView(content.bundle.quests, record.quests);
      const offered = (): boolean => engine.offers(hero.id).some((q) => q.id === 'check-rung3');
      // In range of both clerks, so nothing below is refused by distance.
      hero.combat.body.position.set(0, EYE_HEIGHT, 0);

      hero.level = 2;
      engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-rung3', '', 0, at());
      check(record.quests['check-rung3'] === undefined, 'a rung-3 job is refused one rung below it');
      check(!offered(), 'and is not in the register at level 2');
      check(markerFor(clerk3, facts(), view()) === 'none', 'and its giver draws no "!" at level 2');

      /*
       * **And still offered from above**, which is the reversal this phase was
       * rewritten for. It asserted the opposite once -- a rung-3 job refused at
       * 4 -- on the argument that a register which forgets makes a level a
       * place you were rather than a number you passed. That argument lost to a
       * player who reached the Centrelink counter on rung 2 because he had
       * batted a few eshays on the ride down, and found all five of Act 0's
       * obligations answering `level 1 only`. The only way to out-level a rung
       * is to play. Nothing is accepted here: the rung-3 case below needs the
       * job still untaken.
       */
      hero.level = 4;
      check(offered(), 'a rung-3 job is still in the register one rung **above** it');
      check(markerFor(clerk3, facts(), view()) === 'offer', 'and its giver still draws the "!" at level 4');
      check(record.quests['check-rung3'] === undefined, 'and asking about it took nothing');

      hero.level = 3;
      check(offered(), 'on the rung itself it is in the register');
      check(markerFor(clerk3, facts(), view()) === 'offer', 'and its giver draws the "!"');
      engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-rung3', '', 0, at());
      check(record.quests['check-rung3'] !== undefined, 'and it can be taken');
      check(markerFor(clerk3, facts(), view()) === 'none', 'while it is being walked the giver draws nothing');

      /*
       * Levelling up mid-job does not strand it. The rung gates the **offer**
       * and nothing else -- so the walking, the completion and the turn-in all
       * still work from the rung above, which is what stops the register being
       * a trap rather than a schedule.
       */
      hero.level = 4;
      sim.wallet.credit(hero.id, 5, 'fare');
      check(engine.cursorFor(hero.id, 'check-rung3')?.d === true, 'a job in progress completes after levelling past its rung');
      check(markerFor(clerk3, facts(), view()) === 'turnin', 'and its giver draws the "?"');
      const paid = sim.wallet.balanceOf(hero.id);
      engine.handle(hero.id, QUEST_OP.TURNIN, 'check-rung3', '', 0, at());
      check(sim.wallet.balanceOf(hero.id) === paid + 5, 'and it hands in from the rung above', `$${sim.wallet.balanceOf(hero.id)}`);
      check(record.story.includes(completionFlag('check-rung3')), 'leaving a permanent mark; it is not repeatable');
      check(markerFor(clerk3, facts(), view()) === 'none', 'and the giver goes quiet');
    }
    // Back to the rung everything after this assumes. The engine reads the
    // participant's level and this file has been writing it by hand.
    hero.level = 1;
  }

  // --- Phase D: the AI seam, off ---------------------------------------------------
  console.log('\n--- phase D: an improv node with no model configured ---');
  {
    check(!improv.enabled, 'the improv cache is off with no url and no key');
    const node = content.bundle.npcs[0].nodes.find((n) => n.id === 'waiting');
    check(node?.improv !== null && node?.improv !== undefined, 'the fixture node is marked improv');
    // The authored line is what serves, and `lineFor` says so by answering
    // empty -- which is the single branch every caller takes for a missing key,
    // a cache miss and a throttled fill alike.
    check(improv.lineFor('clerk', node!) === '', 'lineFor answers empty, so the authored line serves');
    check(
      node?.line === 'forty minutes. the screen says twelve. the screen is aspirational.',
      'and the authored line is intact',
      node?.line,
    );
    // Walking to it must work exactly as any other node does: no throw, no
    // stall, and the state frame still goes out.
    const before = framesFor(hero.id);
    engine.handle(hero.id, QUEST_OP.NODE, 'clerk', 'hello', 5, at());
    engine.flush();
    check(framesFor(hero.id) > before, 'walking onto an improv node still answers with a state frame');
    check(improv.calls === 0, 'and made no outbound call', `${improv.calls}`);
    check(improv.describe().includes('improv off'), 'the boot line says it is off', improv.describe());
    // The schema's guarantee, restated against the live bundle rather than
    // against a fixture in the unit check: nothing on an improv node decides.
    for (const npc of content.bundle.npcs) {
      for (const nd of npc.nodes) {
        if (nd.improv === null) continue;
        const decides = nd.choices.some((c) => c.accept !== '' || c.turnin !== '' || c.cost > 0);
        check(!decides, `improv node ${npc.id}.${nd.id} decides nothing`);
      }
    }
  }

  // --- Phase E: what survives Monday, and what a guest keeps ------------------------
  console.log('\n--- phase E: the week, the guest, and the story ---');
  {
    // A guest takes a job and gets a flag, in memory.
    const guest = sim.join(2, null, 'Macca');
    check(guest.account === null, 'the guest has no account');
    engine.handle(guest.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
    check(engine.cursorFor(guest.id, 'check-run') !== null, 'a guest can take a job');
    guest.combat.body.position.set(SITE_X, EYE_HEIGHT, SITE_Z);
    engine.tick(1);
    check(engine.cursorFor(guest.id, 'check-run')?.s === 1, "and walk it -- a guest's quest is a real quest");
    // Then the socket closes.
    engine.forget(guest.id);
    check(engine.cursorFor(guest.id, 'check-run') === null, "a guest's progress does not survive the socket");

    // The account's does, and the reset is where the two halves separate.
    check(record.story.includes('check:ran'), 'the account still holds its story flag');
    const xpBeforeMonday = record.xp;
    check(xpBeforeMonday > 0, 'and has xp to lose', `${xpBeforeMonday} xp`);
    record.levelWeek = '2020-W01';
    const moved = resetIfNewWeek(record);
    check(moved, 'a record from an old week rolls');
    check(record.xp === 0 && record.level === 1, 'the week cleared the xp and the level', `${record.xp} xp, level ${record.level}`);
    check(Object.keys(record.quests).length === 0, 'and every in-progress cursor');
    check(
      record.story.includes('check:ran') && record.story.includes(completionFlag('check-run')),
      '**and left the story flags alone** — the one thing on a record that outlives the week',
      JSON.stringify(record.story),
    );
    check(record.levelWeek === weekOf(), 'the new week is stamped');
    // WORKSTREAM AN: and the *weekly* mark went with it, which is the other
    // half of "the story survives". A `w:` left standing is a weekly job that
    // never comes back, silently, for the life of the account.
    check(
      !record.story.includes(weeklyFlag('check-weekly')),
      'and the weekly completion mark did **not** survive Monday',
      JSON.stringify(record.story),
    );
    // Which means the story quest is *still* finished on the other side of
    // Monday. This is the assertion the whole persistence design exists for.
    engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-run', '', 0, at());
    check(record.quests['check-run'] === undefined, 'a story quest finished last week is still finished this week');
    // While the repeatable comes round again.
    engine.handle(hero.id, QUEST_OP.ACCEPT, 'check-weekly', '', 0, at());
    check(record.quests['check-weekly'] !== undefined, 'and the weekly is available again');
  }

  // --- Phase E2: the budget, tested on purpose -----------------------------------------
  console.log('\n--- phase E2: the flood guard ---');
  {
    /*
     * Both directions, because a budget is only correct if it is loose enough
     * for a person and tight enough for a loop, and the first cut of this was
     * neither -- it was tight enough for a loop *and* for a person. See
     * `QUEST_BURST`, whose comment now says so.
     *
     * A fresh player id, so nothing above has spent this guard.
     */
    const clicker = sim.join(3, null, 'Shazza');
    let accepted = 0;
    // A person reading through a dialog tree: one op every 250 ms. Denise's
    // real tree is six choices deep in places and a player who wanders it
    // twice must not be throttled.
    for (let i = 0; i < 40; i++) {
      engine.handle(clicker.id, QUEST_OP.NODE, 'clerk', 'hello', 5, at());
      accepted++;
    }
    check(accepted === 40, 'forty clicks at a human rate are all admitted', `${accepted}`);
    // And a loop: forty ops inside one millisecond. The budget must stop it,
    // and must stop it *before* the burst is very far exceeded.
    const instant = clock + 1;
    let refused = 0;
    for (let i = 0; i < 200; i++) {
      const before = sim.wallet.balanceOf(clicker.id);
      engine.handle(clicker.id, QUEST_OP.ACCEPT, 'check-run', '', 0, instant);
      if (sim.wallet.balanceOf(clicker.id) === before) refused++;
    }
    check(refused > 0, 'a loop inside one millisecond is throttled');
    // The refusal is silent: no frame, no pill. A "slow down" for a click the
    // player did not consciously make would be noise.
    const quiet = framesFor(clicker.id);
    for (let i = 0; i < 100; i++) engine.handle(clicker.id, QUEST_OP.LIST, '', '', 0, instant);
    engine.flush();
    check(
      framesFor(clicker.id) - quiet <= 1,
      'and answers with at most one frame, not a hundred',
      `${framesFor(clicker.id) - quiet}`,
    );
    engine.forget(clicker.id);
  }

  // --- Phase F: a cursor surviving a content edit -------------------------------------
  console.log('\n--- phase F: the content changes under a live cursor ---');
  {
    // A fourth step is added to a quest somebody is halfway through, which is
    // the thing this whole feature is built to allow and the thing most likely
    // to go wrong the first week it ships.
    // Round-tripped through JSON rather than `structuredClone`d into its own
    // literal type, because that is what it is: a **document**, of the shape a
    // content author hands the server, and the parser is the only thing that
    // has an opinion about its fields. Typing it as the literal above would
    // make TypeScript insist a new step carry every key every other step has.
    const grown = JSON.parse(JSON.stringify(FIXTURE_QUESTS)) as {
      quests: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    grown.quests[0].steps.push({ kind: 'goto', x: 0, z: 0, radius: 25, label: 'and back again' });
    await writePack(contentDir, grown, FIXTURE_DIALOG);
    const after = new ContentStore({ dir: contentDir, ledgerPath: `${scratch}/ledger2.json`, timers: false });
    const errs = await after.load();
    check(errs.length === 0, 'the edited pack loads clean', errs[0] ?? '');
    check(after.revision !== goodRevision, 'and has a new revision');

    /*
     * Both cursors are written **before the first read**, which is not a
     * convenience -- it is what actually happens. Cursors arrive on a record
     * one way: off disk, at join, all at once, before anything has looked at
     * them. `reconcile` is memoised on the revision for exactly that shape (it
     * is otherwise a walk of every cursor on every knockout), so a cursor
     * conjured onto a record *after* the engine has already reconciled that
     * revision is a situation the engine does not have and this check should
     * not invent. The first cut of this wrote the second cursor after the
     * first read and reported a failure that could not happen in play.
     */
    record.quests['check-run'] = { s: 2, c: [1, 2, 0], d: false };
    // A quest that has been deleted outright since this cursor was written.
    record.quests['ghost-quest'] = { s: 0, c: [0], d: false };
    const engine2 = new QuestEngine(after, improv, world, accounts);
    const reconciled = engine2.cursorFor(hero.id, 'check-run');
    check(reconciled?.c.length === 4, 'a live cursor grew to the new step count', `${reconciled?.c.length}`);
    check(reconciled?.s === 2, 'without losing the progress already earned', `step ${reconciled?.s}`);
    check(reconciled?.d !== true, 'and was not handed a completion it no longer has');
    // The deleted one takes its cursor with it rather than leaving a tracker
    // line for a job nobody can finish.
    check(record.quests['ghost-quest'] === undefined, 'a cursor for a quest that no longer exists is dropped');
  }

  // --- Phase G: the packs this repo actually ships -------------------------------------
  console.log('\n--- phase G: the shipped content, validated the way the server will ---');
  {
    const shipped = new ContentStore({ dir: new URL('../content', import.meta.url).pathname, ledgerPath: `${scratch}/ledger3.json`, timers: false });
    const errs = await shipped.load();
    check(errs.length === 0, 'content/ validates', errs.slice(0, 3).join('; '));
    /*
     * --- WORKSTREAM AP: act 0 is the obligations **and the tutorial**, and this
     * block used to be able to say "act 0" and mean "Denise's".
     *
     * `act0-ladmaster` is act 0 too -- it is the first thing that happens in
     * this game and it belongs to the same story -- and it is given by the
     * Ladmaster in Sydney Park rather than by the clerk in Redfern. So the two
     * assertions that used to read `q.act === 0` are split: the obligations are
     * named **by id**, because that is what they actually are and a count is
     * exactly the thing that stopped being true when a sixth act-0 job arrived,
     * and the tutorial is asserted separately with the two properties that make
     * it the tutorial -- nothing gates it, and it hands over a bike.
     */
    const OBLIGATIONS = ['act0-report', 'act0-jobsearch', 'act0-evidence', 'act0-travel', 'act0-training'] as const;
    const act0 = shipped.bundle.quests.filter((q) => q.act === 0);
    check(act0.length === OBLIGATIONS.length + 2, 'Act 0 is the tutorial, five obligations and the review', `${act0.length}`);
    const obligations = OBLIGATIONS.map((id) => shipped.bundle.quests.find((q) => q.id === id)).filter(
      (q): q is NonNullable<typeof q> => q !== undefined,
    );
    check(obligations.length === OBLIGATIONS.length, 'the five obligations are all there, by id', obligations.map((q) => q.id).join(', '));
    check(
      obligations.every((q) => q.giver === 'centrelink-clerk'),
      'and all five come from the one clerk',
    );

    /*
     * --- The tutorial itself: the first thing in the game, and nothing gates it.
     *
     * Every clause here is a way the onboarding silently does not happen. A rung
     * other than 1 and a fresh account never sees it. A `requires` or a
     * `needFlags` and it waits for a flag a new player cannot have. A giver who
     * is not the hero and there is no giant `!` to find. No `bike` and the line
     * says grab the lime bike beside an empty footpath. No `goto` and the
     * waypoint has nothing to point at, which is the whole discoverability
     * answer gone. And an `unlock` that nothing writes is a "you have been shown
     * the ropes" check that can never be true.
     */
    const tutorial = shipped.bundle.quests.find((q) => q.id === 'act0-ladmaster');
    if (!tutorial) {
      check(false, 'the tutorial is in the shipped content');
    } else {
      check(tutorial.act === 0, 'the tutorial is act 0', `act ${tutorial.act}`);
      check(tutorial.level === 1, 'the tutorial stands on rung 1', `level ${tutorial.level}`);
      check(
        tutorial.requires.length === 0 && tutorial.needFlags.length === 0 && tutorial.denyFlags.length === 0,
        'and nothing gates it: it is the first thing in the game',
        `${tutorial.requires.length} requires, ${tutorial.needFlags.length} needFlags`,
      );
      check(tutorial.faction === '', 'nor does it belong to a side');
      check(!tutorial.repeatable, 'and it is done once, so its mark survives Monday');
      check(tutorial.grantsBike, 'accepting it lends a lime bike');
      check(tutorial.reward.unlock.includes('act0:shown'), 'and finishing it sets act0:shown', tutorial.reward.unlock.join(', '));
      check(tutorial.reward.cash === 10 && tutorial.reward.xp === 2, 'it pays $10 and 2 xp', `$${tutorial.reward.cash}, ${tutorial.reward.xp} xp`);
      const first = tutorial.steps[0];
      check(tutorial.steps.length === 1 && first?.kind === 'goto', 'it is one goto and nothing else', `${tutorial.steps.length} step(s)`);
      // The literal moves with the content, and it is pinned rather than loosened
      // because the banner is the one line of the tutorial a player reads while
      // riding. It said GET TO REDFERN until the destination became a real
      // Centrelink -- the Redfern point was a hand-looked-up backstop OSM had
      // nothing for, and the nearest office OSM actually tags is in St Peters.
      check((first?.objective ?? '') === 'GET TO CENNO', 'whose banner reads GET TO CENNO', JSON.stringify(first?.objective));
      // The step points at Ray rather than at Denise: he is the one who takes it
      // back, and a waypoint that landed the player at a counter with nothing to
      // hand over is the tutorial's one unrecoverable moment.
      const ray = shipped.bundle.npcs.find((n) => n.id === 'rabbitohs-ray');
      const gap = ray && first ? Math.hypot(first.x - ray.x, first.z - ray.z) : Infinity;
      check(gap <= (first?.radius ?? 0), 'and lands the player on Ray, who takes it back', `${gap.toFixed(1)} m`);
      // Exactly one hero in the whole of `content/`. Two would be two tutorials.
      const heroes = shipped.bundle.npcs.filter((n) => n.marker === 'hero');
      check(heroes.length === 1 && heroes[0].id === 'ladmaster', 'exactly one giver in Sydney wears the hero mark', heroes.map((n) => n.id).join(', '));
      check(tutorial.giver === 'ladmaster', 'and he is the one who gives the tutorial', tutorial.giver);
    }
    // The arc has a spine: every job but the first requires the one before it,
    // and the last is gated at the level the faction choice happens.
    const last = shipped.bundle.quests.find((q) => q.id === 'act0-review');
    check(last?.level === 2, 'the review sits on the faction-choice rung', `level ${last?.level}`);
    check(last?.reward.unlock.includes('act1:open') === true, 'and opens Act 1');

    /*
     * --- WORKSTREAM AN: the register the shipped packs actually make, and the
     * one sum a content author has to keep true.
     *
     * A rung is exact, so the jobs standing on it must not pay enough xp
     * between them to push the player off it before the last of them is taken.
     * Act 0's five obligations are a chain -- each requires the one before --
     * so if their rewards summed past a level the fifth would be unreachable to
     * anybody who did the first four, every week, and nothing would say why.
     * That is not a bug you find by playing carefully; it is a bug you find by
     * adding up.
     */
    const rungs = [...new Set(shipped.bundle.quests.map((q) => q.level))].sort((a, b) => a - b);
    check(
      rungs.every((l) => l >= 1 && l <= REGISTER_LEVELS),
      `every shipped job sits on a rung of the register (1-${REGISTER_LEVELS})`,
      rungs.join(', '),
    );
    /*
     * The sum that a content author owns, re-run now that the tutorial stands
     * on the same rung. It pays **2 xp**, which is deliberately nothing -- it is
     * a handshake rather than a job -- so rung 1's act-0 total went from 700 to
     * **702** against the 1,000 that would level a player off it. There is 298
     * xp of headroom, which is a knockout and a bit; the day somebody wants to
     * pay the tutorial properly, this is the line that says what it costs.
     */
    const rung1 = shipped.bundle.quests.filter((q) => q.level === 1 && q.act === 0);
    check(
      rung1.length === OBLIGATIONS.length + 1,
      'rung 1 of Act 0 is the five obligations and the tutorial',
      rung1.map((q) => q.id).join(', '),
    );
    check(
      OBLIGATIONS.every((id) => rung1.some((q) => q.id === id)),
      'and the five obligations are on it by id, not by count',
    );
    const rung1Xp = rung1.reduce((sum, q) => sum + q.reward.xp, 0);
    check(
      rung1Xp === 702,
      `rung 1 pays ${rung1Xp} xp between the tutorial and its five obligations, which is the 702 the pack's comment claims`,
    );
    check(
      rung1Xp < XP_PER_LEVEL,
      `and ${rung1Xp} is under the ${XP_PER_LEVEL} that would level a player off the rung before the last of them is taken`,
    );
    // Act 2 is the city's own work: the hundred-quest pool, ten to a rung. A
    // rung may hold more than a player can finish -- that is a menu, not a
    // chain -- but it must not be able to lure a player off rung 1 before the
    // obligations are done, or the story is locked until Monday. So rung 1's
    // pool waits for the chain's last flag and every other rung's for the
    // review's. The sum rule above is the chain's alone.
    const pool = shipped.bundle.quests.filter((q) => q.act === 2);
    check(pool.length === 100, 'Act 2 is a hundred jobs', `${pool.length}`);
    for (let rung = 1; rung <= REGISTER_LEVELS; rung++) {
      const on = pool.filter((q) => q.level === rung);
      check(on.length === 10, `rung ${rung} carries ten of them`, `${on.length}`);
    }
    check(
      pool.every((q) => q.needFlags.includes(q.level === 1 ? 'act0:trained' : 'act1:open')),
      'and none of them opens before the story does: rung 1 waits for act0:trained, the rest for act1:open',
    );
    check(
      pool.every((q) => !q.repeatable),
      'the pool is story work, done once',
    );
    // `Quest.anyRung` is the register's one exemption and it belongs to the
    // jobs that teach the game. A pool quest wearing it would be a hundred
    // markers on every rung, which is the register turned back into a pile.
    const exempt = shipped.bundle.quests.filter((q) => q.anyRung);
    check(
      pool.every((q) => !q.anyRung),
      `no Act 2 job is exempt from the rung (${exempt.filter((q) => q.act === 2).length} would be)`,
    );
    check(
      exempt.length <= 2,
      `and the exemption stays rare: ${exempt.length} job(s) carry it (${exempt.map((q) => q.id).join(', ') || 'none'})`,
    );
    const act1 = shipped.bundle.quests.filter((q) => q.act === 1);
    check(act1.length > 0 && act1.every((q) => q.level === last?.level), 'the faction work stands on the rung its door opens onto');
    check(act1.every((q) => q.repeatable), 'and both faction jobs are repeatable, so they come round with the week');
    // The two spellings, in the strings a player reads. `verifyTeams` cannot
    // see a content file and `verifyQuests` only checks the `faction` field.
    const prose = JSON.stringify(shipped.bundle);
    for (const wrong of ['DEFAULT', 'Default', 'marita', 'MARITA', 'Marita ']) {
      if (wrong === 'Marita ') continue;
      const bad = prose.includes(`"${wrong}"`) || prose.includes(` ${wrong} `) || prose.includes(`${wrong},`);
      check(!bad, `no content string spells a side "${wrong}"`);
    }
    check(prose.includes('Marita') && prose.includes('DeFAULT'), 'both sides are named, correctly spelt');
    // Two improv demonstrations, with authored fallbacks, as the brief asks.
    const improvNodes = shipped.bundle.npcs.flatMap((n) => n.nodes.filter((nd) => nd.improv !== null));
    check(improvNodes.length >= 2, 'two nodes demonstrate improv', `${improvNodes.length}`);
    check(improvNodes.every((n) => n.line !== ''), 'and every one of them has an authored fallback');
    // Every step kind in the DSL is exercised somewhere in the shipped content,
    // which is what "the content is the proof the DSL is sufficient" means.
    const kinds = new Set(shipped.bundle.quests.flatMap((q) => q.steps.map((s) => s.kind)));
    for (const kind of ['goto', 'ko', 'buy', 'photo', 'ride', 'earn', 'dialog']) {
      check(kinds.has(kind as never), `the shipped content exercises "${kind}"`);
    }
  }

  await accounts.close();
  await wallets.close();
  content.close();
  await Bun.$`rm -rf ${scratch}`.quiet().nothrow();
}

await main();

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('quests-check: all good.');
