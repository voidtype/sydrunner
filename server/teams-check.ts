/**
 * The teams check: level 2, a side, ten points, and an aura.
 *
 *     bun run server/teams-check.ts
 *
 * **Why this exists as a file rather than as more of `verifyTeams`.**
 *
 * `client/src/game/teams.ts`'s self-check covers everything the *rules* can get
 * wrong -- the tier arithmetic, the refund dependency, the spelling of the two
 * names -- and `game/teamfield.ts`'s covers the fold. Both run at boot in both
 * runtimes, which is where a check of that kind belongs. What neither can cover
 * is everything that only exists once the pieces are wired together, and this
 * feature is mostly seams:
 *
 *   - a knockout in a real `Simulation` reaching level 2 and **saying so**;
 *   - `CHOOSE` landing on a real `AccountStore` and being refused the second
 *     time, by the store rather than by the caller;
 *   - `TAKE` adjudicated against the contract, with the *server's* refusal
 *     sentence coming back through the pill;
 *   - the mega gate, which is two conditions (six in the tree **and** level 8)
 *     that are easy to satisfy one at a time;
 *   - the weekly flip clearing the points **and the side**, which is the
 *     one asymmetry in this feature and is invisible until a Monday;
 *   - a restart, because a build that does not survive one is not a build;
 *   - and an aura reaching a teammate five metres away through the real spatial
 *     index the real tick fills.
 *
 * Every one of those fails *silently* in this repo's sense: the game plays
 * perfectly and the wrong player has the talent, or the points are spent on a
 * level-1 character, or the side is gone on Tuesday.
 *
 * `server/accounts-check.ts` is the file this is modelled on, down to the
 * fixture: **an empty city** (`verifySim`'s), so it runs in about a second
 * instead of the 45 minutes `server/integration-check.ts` takes against the real
 * world. A city with no prisms and no terrain in it is all a punch needs, and
 * teams need less than a punch.
 *
 * There is no phase B here and none is wanted. `MSG.TEAM` is four bytes into
 * `Simulation.teamOp` and `MSG.TALENTS` is a broadcast out of
 * `Room.sendTalents`; the *bytes* are round-tripped by `verifyTeamsWire` at
 * every boot, and standing a socket up to prove that a switch case calls a
 * method would be testing Bun.
 *
 * Exit code 1 on any failure, so it can be wired into anything that cares.
 */

import { CollisionWorld } from '../client/src/player/collision.ts';
import { MAX_HEALTH } from '../client/src/game/combat.ts';
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { FLAT_WHITE, PowerupField, createPoint, type PowerupPoint } from '../client/src/game/powerups.ts';
// WORKSTREAM AA: the empty index every `ServerWorld` fixture now needs.
import { SpatialHash } from '../client/src/game/spatialhash.ts';
// WORKSTREAM Z: the four faction facts the new cases stand a body next to, and
// the two `teamfx` reads they assert through rather than around.
import { NPC_KIND, NPC_STATE, REASON } from '../client/src/game/factions.ts';
import { EVENT, EVENT_FLAG } from '../client/src/net/protocol.ts';
import { fxKarenReportsSteal, fxMaxPips } from '../client/src/game/teamfx.ts';
import { WalletStore } from './wallets.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { decodeRoster, encodeRoster } from '../client/src/net/protocol.ts';
import { XP_PER_KO, levelFor, weekOf } from '../client/src/net/accounts.ts';
import {
  AURA_M,
  FX,
  MEGA_LEVEL,
  NODES,
  TEAM,
  TEAM_NAME,
  countBits,
  hasNode,
  pointsFor,
} from '../client/src/game/teams.ts';
import { TEAM_OP, decodeTalents, encodeTalents } from '../client/src/net/teams.ts';
import { AccountStore } from './accounts.ts';
import { Simulation, type Participant, type TickOutput } from './sim.ts';
import type { ServerWorld } from './world.ts';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** `verifySim`'s fixture, for its reasons. See `server/accounts-check.emptyWorld`. */
function emptyWorld(): ServerWorld {
  return {
    index: { stage: 'test', radius_m: 0, tile_size: 500, terrain: { grid: 16, datum_ahd: 0, sea_level_y: 0 }, tiles: [] },
    hexes: [],
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
    // WORKSTREAM AA: an index over nothing, which is what `ServerWorld` now
    // requires and what a fixture with no powerups in it should hand back. See
    // `game/powerups.PowerupField.residentIndex`.
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

/** `accounts-check.squareUp`, verbatim and for its reasons. */
function squareUp(sim: Simulation, attacker: Participant, victim: Participant): void {
  attacker.combat.body.position.set(0, EYE_HEIGHT, 1.1);
  victim.combat.body.position.set(0, EYE_HEIGHT, 0);
  attacker.combat.body.yaw = 0;
  attacker.input.yaw = 0;
  victim.combat.body.yaw = 0;
  victim.input.yaw = 0;
  attacker.viewTicks = 0;
  attacker.history.seed(sim.tick, 0, EYE_HEIGHT, 1.1, 0);
  victim.history.seed(sim.tick, 0, EYE_HEIGHT, 0, 0);
}

/** Punch until the attacker's KO count moves, or give up. `accounts-check`'s. */
function knockDown(sim: Simulation, attacker: Participant, victim: Participant): boolean {
  const out = { tick: 0, events: [], snapshot: null };
  const want = attacker.kos + 1;
  for (let i = 0; i < 400 && attacker.kos < want; i++) {
    squareUp(sim, attacker, victim);
    attacker.input.punch = true;
    sim.step(out);
    attacker.input.punch = false;
    sim.step(out);
  }
  return attacker.kos >= want;
}

/** Out of the knockout phase, so the next punch is not thrown at a corpse. */
function letThemUp(sim: Simulation, p: Participant): void {
  const out = { tick: 0, events: [], snapshot: null };
  for (let t = 0; t < 400 && p.combat.phase === 'ko'; t++) sim.step(out);
}

/** The pill this player is holding, drained the way `Room.step` drains it. */
function pill(sim: Simulation, p: Participant): string {
  const held = p.walletNote;
  if (held !== '') return held;
  sim.drainNotes();
  return p.walletNote;
}

/** Clear it, so the next assertion is about the next sentence. */
function clearPill(p: Participant): void {
  p.walletNote = '';
}

/** Node ids by name, so the checks below read as the panel does. */
function nodeId(team: number, name: string): number {
  const nd = NODES.find((n) => n.team === team && n.name === name);
  if (!nd) throw new Error(`no node "${name}" for team ${team}`);
  return nd.id;
}

// --- The run --------------------------------------------------------------------

async function run(): Promise<void> {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  const accountPath = `${dir}/teams-check.json`;
  await Bun.$`rm -f ${accountPath}`.quiet().nothrow();

  const accounts = new AccountStore(accountPath);
  await accounts.load();
  const world = emptyWorld();
  const sim = new Simulation(world, { accounts });

  // --- A fresh account has no side and nothing spent.
  console.log('\n--- a side, and the level that forces it ---');
  const made = await accounts.signup('Bazza', 'hunter2hunter2', '', null);
  const record = accounts.byHandle('Bazza');
  if (!made.ok || !record) {
    check(false, 'the fixture signed up');
    return;
  }
  check(record.team === TEAM.NONE, 'a fresh account has no side', String(record.team));
  check(countBits(record.talents) === 0, 'and nothing spent');

  const hero = sim.join(0, null, record.handle, record);
  const sparring = sim.join(1, null, 'Davo');
  check(hero.team === TEAM.NONE && hero.level === 1, 'and joins unaligned at level 1');

  // Choosing below the gate is refused, before anything else happens. This is
  // the branch a hand-built client reaches and nothing else ever does.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.MARITA);
  check(hero.team === TEAM.NONE, 'a level-1 account cannot choose a side');
  check(/level 2/.test(pill(sim, hero)), 'and is told what it needs', JSON.stringify(hero.walletNote));

  // --- Ten knockouts, through the real ladder.
  let knocked = 0;
  for (let i = 0; i < 10; i++) {
    if (!knockDown(sim, hero, sparring)) break;
    knocked++;
    letThemUp(sim, sparring);
  }
  check(knocked === 10 && hero.level === 2, 'ten knockouts is level 2', `level ${hero.level} on ${record.kills} kills`);
  clearPill(hero);
  sim.drainNotes();
  check(/pick a side/.test(hero.walletNote), 'and the pill says to pick a side', JSON.stringify(hero.walletNote));

  // --- CHOOSE.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.MARITA);
  check(hero.team === TEAM.MARITA, `the choice took (${TEAM_NAME[TEAM.MARITA]})`, TEAM_NAME[hero.team]);
  check(record.team === TEAM.MARITA, 'and reached the account record, not just the body');
  check(new RegExp(TEAM_NAME[TEAM.MARITA]).test(pill(sim, hero)), 'and says so, spelt the one way', JSON.stringify(hero.walletNote));

  // --- The broadcast, through the real encoder.
  {
    const frame = encodeTalents(sim.talentsRecords());
    const back = decodeTalents(frame);
    const mine = back?.find((r) => r.playerId === hero.id);
    check(mine?.team === TEAM.MARITA && mine.level === 2, 'TALENTS carries the side and the level', JSON.stringify(mine));
    const unspent = mine === undefined ? -1 : pointsFor(mine.level) - countBits({ lo: mine.lo, hi: mine.hi });
    check(unspent === 2, 'a fresh level 2 has two points to spend', String(unspent));
    const guest = back?.find((r) => r.playerId === sparring.id);
    check(guest?.team === TEAM.NONE, 'and a guest is in the set with no side', JSON.stringify(guest));
    // The side is on the roster too, which is what everybody else draws from.
    const rows = decodeRoster(encodeRoster(sim.roster()));
    check(rows?.find((r) => r.id === hero.id)?.team === TEAM.MARITA, 'and the roster carries it for everybody else');
    check(rows?.find((r) => r.id === sparring.id)?.team === TEAM.NONE, 'a guest is unaligned on the roster');
  }

  // --- A second CHOOSE is refused by the store, permanently.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.DEFAULT);
  check(hero.team === TEAM.MARITA, 'a second choice is refused', TEAM_NAME[hero.team]);
  check(record.team === TEAM.MARITA, 'and the record did not move either');
  check(pill(sim, hero) !== '', 'and the player is told why', JSON.stringify(hero.walletNote));

  // --- Spending. The tier gates, in the order a player meets them.
  console.log('\n--- ten points, three tiers and a mega ---');
  const bigNight = nodeId(TEAM.MARITA, 'Big Night');
  const tapOn = nodeId(TEAM.MARITA, 'Tap On');
  const surge = nodeId(TEAM.MARITA, 'Surge');
  const servoPie = nodeId(TEAM.MARITA, 'Servo Pie');
  const loanShark = nodeId(TEAM.MARITA, 'Loan Shark');
  const tipJar = nodeId(TEAM.MARITA, 'Tip Jar');
  const cashRules = nodeId(TEAM.MARITA, 'Cash Rules');

  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, bigNight);
  check(hasNode(hero.talents, bigNight), 'Big Night is takeable at tier 1');
  check(hero.walletNote === '', 'and a success says nothing', JSON.stringify(hero.walletNote));
  check(hasNode(record.talents, bigNight), 'and it is on the account record');

  /*
   * **The fork, through the real op.** `TIER_REQ` is `[0, 1, 2, 5]`: one node
   * opens the tier above it, so Surge -- tier 2 of Servo -- is takeable on the
   * single point Big Night just spent. This probe used to be Surge and used to
   * expect a refusal, which is the ladder the owner complained about; it is a
   * *tier-3* node now, because that is the first gate one point cannot open.
   */
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, loanShark);
  check(!hasNode(hero.talents, loanShark), 'a tier-3 node on one point in the tree is refused');
  check(/needs 2 in Servo/.test(pill(sim, hero)), 'with the reason', JSON.stringify(hero.walletNote));

  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, tapOn);
  check(hasNode(hero.talents, tapOn), 'the second tier-1 node fits in the two points a level 2 has');
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, surge);
  check(!hasNode(hero.talents, surge), 'and the tier above is open now, but the points are gone');
  check(/no points left/.test(pill(sim, hero)), 'with that reason instead', JSON.stringify(hero.walletNote));

  // --- Level 10, so the rest of the tree can be bought.
  //
  // The record is moved directly rather than by ninety more knockouts, which is
  // the one shortcut in this file and is a deliberate one: `creditLadder` is
  // already proven above and in `accounts-check`, and eighty more punches would
  // add ten seconds to a check to re-test arithmetic that is asserted by
  // `verifyAccounts` on every boot. What is *not* shortcut is the path from the
  // record to the participant -- `rollWeeks` is what re-establishes the mirror,
  // and it is the real function.
  const setLevel = (level: number): void => {
    record.kills = (level - 1) * 10;
    // WORKSTREAM AK: the ladder is xp now and `levelFor` reads it, so a fixture
    // that seeds a level has to seed the currency the level is made of. The
    // knockouts stay beside it because they are the body count and the
    // leaderboard still draws them; `kills x XP_PER_KO` is exactly what those
    // knockouts would have paid. See `net/accounts.XP_PER_KO`.
    record.xp = record.kills * XP_PER_KO;
    record.level = levelFor(record.xp);
    hero.level = record.level;
  };
  setLevel(7);
  for (const id of [surge, servoPie, loanShark, tipJar]) {
    clearPill(hero);
    sim.teamOp(hero.id, TEAM_OP.TAKE, id);
    check(hasNode(hero.talents, id), `${NODES[id].name} went in`, JSON.stringify(hero.walletNote));
  }
  check(countBits(hero.talents) === 6, 'the Servo tree is full at six', String(countBits(hero.talents)));

  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, cashRules);
  check(!hasNode(hero.talents, cashRules), `the mega is refused at level 7`);
  check(new RegExp(`needs level ${MEGA_LEVEL}`).test(pill(sim, hero)), 'because of the level, not the tree', JSON.stringify(hero.walletNote));

  setLevel(MEGA_LEVEL);
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, cashRules);
  check(hasNode(hero.talents, cashRules), `and allowed at level ${MEGA_LEVEL}`, JSON.stringify(hero.walletNote));

  /*
   * --- Refunding out from under it, which needs one more step than it used to.
   *
   * `TIER_REQ[3]` is 5 and the tree holds six, so the mega has exactly one
   * spare: the first refund is legitimate and the tree still holds it up, and
   * the *second* is the one that would orphan it. Under the old whole-tree gate
   * there was no spare and the first refund was already the illegal one -- so
   * this reads as two steps now rather than one, and the extra step is the
   * fork's change showing up in the refund rule where it should.
   */
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.REFUND, bigNight);
  check(!hasNode(hero.talents, bigNight), 'a node the mega has a spare for refunds');
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.REFUND, tapOn);
  check(hasNode(hero.talents, tapOn), 'but the one the mega then stands on cannot be refunded');
  check(/depends on it/.test(pill(sim, hero)), 'and the reason names what depends on it', JSON.stringify(hero.walletNote));

  // The mega itself comes back out, and then the node under it does.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.REFUND, cashRules);
  check(!hasNode(hero.talents, cashRules), 'the mega refunds');
  sim.teamOp(hero.id, TEAM_OP.REFUND, tapOn);
  check(!hasNode(hero.talents, tapOn), 'and now so does the node it stood on');
  sim.teamOp(hero.id, TEAM_OP.TAKE, bigNight);
  check(hasNode(hero.talents, bigNight), 'and Big Night goes back in');

  // --- RESET_ALL, once a day.
  {
    const before = countBits(hero.talents);
    clearPill(hero);
    sim.teamOp(hero.id, TEAM_OP.RESET_ALL, 0);
    check(countBits(hero.talents) === 0, `reset gave back all ${before} points`, String(countBits(hero.talents)));
    check(countBits(record.talents) === 0, 'and the record went with it');
    sim.teamOp(hero.id, TEAM_OP.TAKE, bigNight);
    clearPill(hero);
    sim.teamOp(hero.id, TEAM_OP.RESET_ALL, 0);
    check(hasNode(hero.talents, bigNight), 'a second reset in the same in-game day is refused');
    check(/one reset a day/.test(pill(sim, hero)), 'and says so', JSON.stringify(hero.walletNote));
  }

  // --- A restart. The whole point of putting any of this on an account.
  console.log('\n--- the week, and the restart ---');
  {
    for (const id of [tapOn, surge]) sim.teamOp(hero.id, TEAM_OP.TAKE, id);
    const spentNow = countBits(hero.talents);
    await accounts.close();
    const reloaded = new AccountStore(accountPath);
    await reloaded.load();
    const back = reloaded.byHandle('Bazza');
    check(back?.team === TEAM.MARITA, 'the side survives a restart', TEAM_NAME[back?.team ?? TEAM.NONE]);
    check(back !== null && countBits(back.talents) === spentNow, 'and so does the build', `${countBits(back?.talents ?? { lo: 0, hi: 0 })} of ${spentNow}`);
    check(back !== null && hasNode(back.talents, bigNight), 'node for node');
    await reloaded.close();
  }

  // --- The weekly flip: the points go, and so does the side.
  {
    record.levelWeek = '2020-W01';
    clearPill(hero);
    sim.rollWeeks();
    check(hero.level === 1 && record.level === 1, 'a new week is level 1 again', `level ${hero.level}`);
    check(countBits(record.talents) === 0, 'the talents went with the level', JSON.stringify(record.talents));
    check(countBits(hero.talents) === 0, 'and the body stopped playing last week’s build');
    check(record.team === TEAM.NONE, 'and the side went with them', TEAM_NAME[record.team] || 'none');
    check(hero.team === TEAM.NONE, 'on the body too');
    check(record.levelWeek === weekOf(), 'stamped into this week', record.levelWeek);
    // And the choice is open again, which is the point of resetting it: a new
    // week is a clean slate and the interstitial comes back at level 2. The
    // gate is the level, so it is refused until the ladder is climbed again.
    sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.DEFAULT);
    check(hero.team === TEAM.NONE, 'and a level-1 account still cannot choose', TEAM_NAME[hero.team] || 'none');
    hero.level = 2;
    record.level = 2;
    sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.DEFAULT);
    check(hero.team === TEAM.DEFAULT, `a new week lets you pick again (${TEAM_NAME[TEAM.DEFAULT]})`, TEAM_NAME[hero.team]);
    check(record.team === TEAM.DEFAULT, 'and the record moved with it');
  }

  // --- Auras, through the tick that fills the real index.
  console.log('\n--- an aura, twelve metres wide ---');
  {
    const store = new AccountStore(`${accountPath}.aura`);
    await store.load();
    const fresh = emptyWorld();
    // With a wallet store, because this section now tests `Tip Jar`'s other
    // half and a room with no wallets answers every credit with a silent
    // no-op -- `moveWallet` refuses an id whose participant has no wallet, so
    // a payout check without this passes or fails for the wrong reason. It
    // cost three failing assertions to learn that, all of them reading $0.
    const auraWallets = new WalletStore(`${accountPath}.aura.wallets`);
    await auraWallets.load();
    const room = new Simulation(fresh, { accounts: store, wallets: auraWallets });

    const make = async (handle: string, team: number): Promise<Participant> => {
      await store.signup(handle, 'hunter2hunter2', '', null);
      const rec = store.byHandle(handle);
      if (!rec) throw new Error(`no ${handle}`);
      rec.kills = 90;
      rec.xp = rec.kills * XP_PER_KO;
      rec.level = levelFor(rec.xp);
      store.chooseTeam(rec, team as 1 | 2);
      return room.join(0, null, rec.handle, rec);
    };
    const giver = await make('Shazza', TEAM.MARITA);
    const taker = await make('Macca', TEAM.MARITA);
    const other = await make('Kev', TEAM.DEFAULT);

    // The giver buys Tip Jar the way a player does: Big Night first, because the
    // tier-3 node needs four in the tree, then the rest of the ladder up to it.
    for (const id of [bigNight, tapOn, surge, servoPie, tipJar]) room.teamOp(giver.id, TEAM_OP.TAKE, id);
    check(hasNode(giver.talents, tipJar), 'the aura fixture bought Tip Jar', JSON.stringify(giver.walletNote));

    const stand = (p: Participant, x: number): void => {
      p.combat.body.position.set(x, EYE_HEIGHT, 0);
      p.history.seed(room.tick, x, EYE_HEIGHT, 0, 0);
    };
    const out = { tick: 0, events: [], snapshot: null };

    stand(giver, 0);
    stand(taker, 5);
    stand(other, 5);
    room.step(out);
    check(
      Math.abs(room.teams.scalar(taker.id, FX.TEAM_EARN) - 0.1) < 1e-9,
      'a teammate five metres from a Tip Jar earns +10%',
      String(room.teams.scalar(taker.id, FX.TEAM_EARN)),
    );
    check(
      room.teams.scalar(other.id, FX.TEAM_EARN) === 0,
      `a ${TEAM_NAME[TEAM.DEFAULT]} standing in the same spot gets nothing`,
      String(room.teams.scalar(other.id, FX.TEAM_EARN)),
    );
    check(
      Math.abs(room.teams.scalar(giver.id, FX.MAX_PIPS) - 1) < 1e-9,
      'and the owner still has their own Big Night pip',
      String(room.teams.scalar(giver.id, FX.MAX_PIPS)),
    );
    check(
      room.teams.scalar(taker.id, FX.MAX_PIPS) === 0,
      'which a teammate does not, because Big Night is not an aura',
      String(room.teams.scalar(taker.id, FX.MAX_PIPS)),
    );

    // --- The other half of Tip Jar: the tithe, which had a query and no call
    // site until now. *"you get $2 of every $20 they make"* -- the holder is
    // paid beside the earner, and the earner is not taxed for it.
    {
      const before = room.wallet.balanceOf(giver.id);
      const earned = room.wallet.balanceOf(taker.id);
      // Paid the way Centrelink pays: straight through the wallet door, which
      // is the same call the three real income paths make.
      room.wallet.credit(taker.id, 20, 'fare');
      room.payTitheForCheck(taker.id, 20, 'tip jar');
      check(
        room.wallet.balanceOf(giver.id) - before === 2,
        'a Tip Jar holder gets $2 of a teammate\'s $20',
        `${room.wallet.balanceOf(giver.id) - before}`,
      );
      check(
        room.wallet.balanceOf(taker.id) - earned === 20,
        'and the earner keeps the whole $20 -- the cut is minted, not deducted',
        `${room.wallet.balanceOf(taker.id) - earned}`,
      );
      const enemyBefore = room.wallet.balanceOf(other.id);
      room.payTitheForCheck(other.id, 20, 'tip jar');
      check(
        room.wallet.balanceOf(giver.id) - before === 2,
        `and a ${TEAM_NAME[TEAM.DEFAULT]} earning beside the jar pays nothing into it`,
        `${room.wallet.balanceOf(giver.id) - before}`,
      );
      check(room.wallet.balanceOf(other.id) === enemyBefore, 'nor is the enemy charged');
    }

    stand(taker, 20);
    room.step(out);
    check(
      room.teams.scalar(taker.id, FX.TEAM_EARN) === 0,
      `and twenty metres is outside the ${AURA_M} m radius`,
      String(room.teams.scalar(taker.id, FX.TEAM_EARN)),
    );
    // Out of the aura, out of the jar: the payout and the fold share one walk,
    // so this cannot pass while the line above fails.
    {
      const before = room.wallet.balanceOf(giver.id);
      room.payTitheForCheck(taker.id, 20, 'tip jar');
      check(
        room.wallet.balanceOf(giver.id) === before,
        'and a teammate earning twenty metres away pays no tithe',
        `${room.wallet.balanceOf(giver.id) - before}`,
      );
    }

    // Walking back in turns it on again on the tick they arrive, not the one
    // after: the index is refilled from the positions the tick just produced.
    stand(taker, 6);
    room.step(out);
    check(room.teams.scalar(taker.id, FX.TEAM_EARN) > 0, 'and it comes back on the tick they walk in');

    // A departure takes the aura with it, which is the case `TeamField`'s prune
    // exists for -- an id that stopped being placed must stop granting anything.
    room.leave(giver.id);
    room.step(out);
    room.step(out);
    room.step(out);
    check(
      room.teams.scalar(taker.id, FX.TEAM_EARN) === 0,
      'and a Tip Jar that logged off stops paying',
      String(room.teams.scalar(taker.id, FX.TEAM_EARN)),
    );

    await store.close();
    await Bun.$`rm -f ${accountPath}.aura`.quiet().nothrow();
  }

  await runLiveTalents();

  await accounts.close();
  await Bun.$`rm -f ${accountPath}`.quiet().nothrow();
}

// --- WORKSTREAM Z: the nine that used to do nothing ------------------------------
//
// Every case below fails **silently** in this repo's sense, and in the sharpest
// possible version of it: before this workstream all nine of these talents had a
// `teamfx` helper, a tooltip and a bit on the wire, and the only thing missing
// was a caller. The game played perfectly. `verifyTeamFx` passed, because the
// helper it tests was correct; `verifyTalentLive` passes, because the arithmetic
// it tests is correct. What neither of them can see is that nobody asks.
//
// So these are seam tests by construction: each one buys the node the way a
// player buys it, puts a body in a place, runs the real `Simulation.step`, and
// asserts the thing the tooltip promises. A talent that is unwired again fails
// here and nowhere else.

/**
 * A level-10 account on a side, with a wallet and whatever build is asked for.
 *
 * Factored out because five of the cases below need one and the ceremony is
 * four calls -- signup, kills, `chooseTeam`, join -- none of which is what the
 * case is about. `NODES` is searched by name so the fixtures read the way the
 * talent panel does; `nodeId` above does the same for the cases further up.
 */
async function liveHero(
  room: Simulation,
  store: AccountStore,
  wallets: WalletStore,
  handle: string,
  team: number,
  build: readonly string[],
): Promise<Participant> {
  await store.signup(handle, 'hunter2hunter2', '', wallets);
  const rec = store.byHandle(handle);
  if (!rec) throw new Error(`no ${handle}`);
  rec.kills = 90;
  rec.xp = rec.kills * XP_PER_KO;
  rec.level = levelFor(rec.xp);
  if (team !== TEAM.NONE) store.chooseTeam(rec, team as 1 | 2);
  const p = room.join(0, null, rec.handle, rec);
  for (const name of build) room.teamOp(p.id, TEAM_OP.TAKE, nodeId(team, name));
  return p;
}

/**
 * One press of `R`, down and **up again**.
 *
 * The release step is the whole reason this is a function. `BTN.ABILITY_R` is
 * level-triggered and `resolveAbilities` takes the *rising* edge, so a case that
 * set the bit, stepped, and then cleared the field without stepping would leave
 * `abilityRHeld` true -- and the next press in the same fixture would not be a
 * press at all. Three of the four assertions below were silently testing nothing
 * before this existed, which is a fair advertisement for the edge rule.
 */
function pressR(room: Simulation, p: Participant, out: TickOutput): void {
  p.input.abilityR = true;
  room.step(out);
  p.input.abilityR = false;
  room.step(out);
}

/** Put a body somewhere and seed its rewind ring, as the aura block above does. */
function stand(room: Simulation, p: Participant, x: number, z: number): void {
  p.combat.body.position.set(x, EYE_HEIGHT, z);
  p.combat.body.velocity.set(0, 0, 0);
  p.history.seed(room.tick, x, EYE_HEIGHT, z, 0);
}

async function runLiveTalents(): Promise<void> {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  const path = `${dir}/teams-check-live.json`;
  const walletPath = `${dir}/teams-check-live-wallets.json`;
  await Bun.$`rm -f ${path} ${walletPath}`.quiet().nothrow();
  const store = new AccountStore(path);
  await store.load();
  const wallets = new WalletStore(walletPath);
  await wallets.load();
  // Typed, unlike the three untyped literals further up this file: the ally case
  // below reads `out.events` back, and an inferred `never[]` cannot be read.
  const out: TickOutput = { tick: 0, events: [], snapshot: null };

  // --- `Meth-adone`: the street does not pick you, and its knockouts are yours.
  console.log('\n--- Meth-adone: the street is on your side ---');
  {
    const world = emptyWorld();
    const room = new Simulation(world, { accounts: store, wallets });
    // Big Night and Long Bomb open Bloodhouse's tier 2, which is where the node
    // is. Bought through `teamOp` rather than written into the mask, because a
    // build that skipped the gates is a build a player cannot have.
    const hero = await liveHero(room, store, wallets, 'Methy', TEAM.MARITA, ['Front Bar', 'Long Bomb', 'Meth-adone']);
    const plain = await liveHero(room, store, wallets, 'Plainy', TEAM.MARITA, ['Front Bar']);
    check(hasNode(hero.talents, nodeId(TEAM.MARITA, 'Meth-adone')), 'the fixture bought Meth-adone', JSON.stringify(hero.walletNote));

    stand(room, hero, 0, 0);
    stand(room, plain, 60, 0);
    room.step(out);
    check(
      room.teams.flag(hero.id, FX.METHHEAD_ALLY),
      'and the fold hands the flag to the hook',
      String(room.teams.flag(hero.id, FX.METHHEAD_ALLY)),
    );
    check(!room.teams.flag(plain.id, FX.METHHEAD_ALLY), 'and not to somebody who did not buy it');

    // A drunk, promoted by hand and stood next to each of them in turn. By hand
    // because the promotion scan needs a pedestrian field and this fixture is an
    // empty city -- what is under test is `DRUNK.think`'s *choice*, which is the
    // line the talent changes, and that runs against `ctx.combatants` alone.
    const drunkAt = (x: number, z: number) => {
      const a = room.factions.promote(NPC_KIND.DRUNK, x, 0, z, 0, 1, -1);
      if (!a) throw new Error('the drunk would not promote');
      a.state = NPC_STATE.WALK;
      a.stateTicks = 0;
      return a;
    };
    const onHero = drunkAt(1.5, 0);
    // Long enough for `DRUNK_REACTION_TICKS` to elapse twice over.
    for (let i = 0; i < 120; i++) room.step(out);
    check(onHero.target !== hero.id, 'a drunk standing over a Meth-adone never snaps at them', `target ${onHero.target}`);

    onHero.health = -2;
    room.step(out);
    const onPlain = drunkAt(61.5, 0);
    for (let i = 0; i < 120; i++) room.step(out);
    check(
      onPlain.target === plain.id,
      'and the same drunk beside somebody without it does snap',
      `target ${onPlain.target} against ${plain.id}`,
    );

    // --- The assist. The hero swings at the plain one; the drunk beside them
    // joins in; the drunk's punch is the knockout and the hero is credited.
    //
    // The ally is stood **seven** metres away rather than three, and the number
    // is load-bearing in both directions: inside `ALLY_RECRUIT_M`'s eight so the
    // swing reaches them, and outside `DRUNK_SNAP`'s four so they do not simply
    // pick the victim on their own -- which would produce a knockout that looked
    // exactly like the one under test and was credited to nobody.
    onPlain.health = -2;
    room.step(out);
    // Back to full first. The drunk in the case above spent a hundred and twenty
    // ticks swinging at this body, so "has their health moved" -- which is how
    // the loop below detects a landed swing -- would answer yes before the hero
    // had thrown one, and the assertion would run against a swing still in its
    // wind-up. That is the shape of a check that passes for the wrong reason.
    plain.combat.health = MAX_HEALTH;
    for (let i = 0; i < 400 && plain.combat.phase === 'ko'; i++) room.step(out);
    plain.combat.health = MAX_HEALTH;
    const ally = drunkAt(7, 0);
    let landed = false;
    for (let i = 0; i < 400 && !landed; i++) {
      // `squareUp`'s geometry, by hand: the hero at z = 1.1 facing -Z, the
      // victim at the origin. Re-seeded every pass because the rewind ring is
      // what the swing is adjudicated against.
      stand(room, hero, 0, 1.1);
      stand(room, plain, 0, 0);
      hero.combat.body.yaw = 0;
      hero.input.yaw = 0;
      hero.viewTicks = 0;
      hero.input.punch = true;
      room.step(out);
      hero.input.punch = false;
      room.step(out);
      landed = plain.combat.health < MAX_HEALTH;
    }
    check(landed, 'the hero landed a swing', `victim on ${plain.combat.health}`);
    check(ally.target === plain.id, 'a swing within 8 m turns a drunk onto whoever you hit', `target ${ally.target}`);

    // --- And the credit. The ally's own swing, through `DRUNK.think`'s real
    // cadence rather than a poked health value: the whole point of the case is
    // that `FactionCtx.damagePlayer` -> `Simulation.shoot` reads the register,
    // and reaching past that would be testing the register instead of the seam.
    const before = hero.kos;
    plain.combat.health = 0.4;
    let allyEvent: { attacker: number; victim: number; flags: number } | undefined;
    for (let i = 0; i < 400 && plain.combat.phase !== 'ko'; i++) {
      room.step(out);
      for (const e of out.events) {
        if (e.kind !== EVENT.HIT) continue;
        if ((e.flags & EVENT_FLAG.ALLY) === 0) continue;
        allyEvent = e as { attacker: number; victim: number; flags: number };
      }
    }
    check(plain.combat.phase === 'ko', 'the ally put them down', plain.combat.phase);
    check(hero.kos === before + 1, 'and the knockout is credited to the player', `${hero.kos} against ${before}`);
    check(
      allyEvent !== undefined && allyEvent.attacker === hero.id && allyEvent.victim === plain.id,
      'and the feed is told it was an assist, not a bat',
      JSON.stringify(allyEvent),
    );
  }

  // --- `Tradie Rates` and `Karen Rapport`, the two DeFAULT "leave me alone"s.
  console.log('\n--- the DeFAULT who nobody bothers ---');
  {
    const world = emptyWorld();
    const room = new Simulation(world, { accounts: store, wallets });
    const mate = await liveHero(room, store, wallets, 'Tradey', TEAM.DEFAULT, ['Big Night', 'Sausage Sizzle', 'Tradie Rates']);
    const rort = await liveHero(room, store, wallets, 'Rorty', TEAM.DEFAULT, ['Bouncer', 'Set Shot', 'Karen Rapport']);
    const plain = await liveHero(room, store, wallets, 'Nobody', TEAM.DEFAULT, ['Bouncer']);
    stand(room, mate, 0, 0);
    stand(room, rort, 40, 0);
    stand(room, plain, 80, 0);
    room.step(out);
    check(room.teams.flag(mate.id, FX.TRADIE_ALLY), 'Tradie Rates is folded', String(room.teams.flag(mate.id, FX.TRADIE_ALLY)));
    check(room.teams.flag(rort.id, FX.KAREN_IMMUNE), 'Karen Rapport is folded');
    check(room.teams.flag(rort.id, FX.AGENT_CHEER), 'and so is its second clause');

    // A tradie who has just been hit, standing in reach, targeting each of them.
    const tradieAt = (x: number, z: number, target: number) => {
      const a = room.factions.promote(NPC_KIND.TRADIE, x, 0, z, 0, 1, target);
      if (!a) throw new Error('the tradie would not promote');
      return a;
    };
    const health = mate.combat.health;
    const t1 = tradieAt(1, 0, mate.id);
    for (let i = 0; i < 30; i++) room.step(out);
    check(mate.combat.health === health, 'a tradie never decks Tradie Rates', `${mate.combat.health} of ${health}`);
    check(t1.target === -1, 'and drops the grudge rather than standing there', `target ${t1.target}`);

    t1.health = -2;
    room.step(out);
    const plainHealth = plain.combat.health;
    tradieAt(81, 0, plain.id);
    for (let i = 0; i < 30; i++) room.step(out);
    check(plain.combat.health < plainHealth, 'and decks somebody without it', `${plain.combat.health} of ${plainHealth}`);

    // The Karen half, through the real witness gate: `fxKarenReportsSteal` is
    // what `karenReport` consults, and immunity wins outright at any distance.
    check(!fxKarenReportsSteal(rort.id, 1), 'a Karen at one metre does not report Karen Rapport');
    check(fxKarenReportsSteal(plain.id, 1), 'and does report somebody without it');
  }

  // --- `Newtown Standoff`: the officers have to choose you, and pay for it.
  console.log('\n--- Newtown Standoff: come on then ---');
  {
    const world = emptyWorld();
    const room = new Simulation(world, { accounts: store, wallets });
    const mega = await liveHero(room, store, wallets, 'Standoff', TEAM.MARITA, [
      'Front Bar', 'Long Bomb', 'Meth-adone', 'Off Your Face', 'Sirens Are Music', 'Glassing', 'Newtown Standoff',
    ]);
    const bystander = await liveHero(room, store, wallets, 'Bystander', TEAM.MARITA, ['Front Bar']);
    check(hasNode(mega.talents, nodeId(TEAM.MARITA, 'Newtown Standoff')), 'the mega fixture bought it', JSON.stringify(mega.walletNote));
    stand(room, mega, 0, 0);
    stand(room, bystander, 10, 0);
    room.step(out);
    check(room.teams.flag(mega.id, FX.POLICE_FOCUS), 'the mega is folded');
    check(room.teams.flag(mega.id, FX.KO_OFFICER_HEALS), 'and so is its second clause');

    // An officer already on the bystander, ten metres away and well inside the
    // forty. Below three stars the mega is asleep, which is the half of the
    // condition that is easiest to lose.
    const officer = room.factions.promote(NPC_KIND.POLICE, 5, 0, 0, 0, 1, bystander.id);
    if (!officer) throw new Error('the officer would not promote');
    room.factions.accuse(bystander.id, REASON.ASSAULT, room.tick);
    room.factions.accuse(mega.id, REASON.ASSAULT, room.tick);
    room.heat.debugSet(mega.id, 2, room.tick);
    room.step(out);
    check(officer.target === bystander.id, 'at two stars the officer stays on the other player', `target ${officer.target}`);

    room.heat.debugSet(mega.id, 3, room.tick);
    room.step(out);
    check(officer.target === mega.id, 'at three the mega takes them', `target ${officer.target}`);
    // And keeps them: the sweep runs after `recruit`, so a fresh dispatch to the
    // other player is stolen back on the tick it happens.
    officer.target = bystander.id;
    room.step(out);
    check(officer.target === mega.id, 'and cannot be re-targeted while the condition holds', `target ${officer.target}`);

    // An officer on nobody keeps patrolling, which is the starvation rule.
    const patrol = room.factions.promote(NPC_KIND.POLICE, 6, 0, 0, 0, 1, -1);
    if (!patrol) throw new Error('the patrol would not promote');
    room.step(out);
    check(patrol.target === -1, 'an officer with nobody to chase is not conscripted', `target ${patrol.target}`);

  }

  // --- `KO_OFFICER_HEALS`, in its own room and for a reason.
  //
  // The focus case above leaves its fixture at three stars with an officer
  // shooting at them, and a player on half a pip in that state is a player who
  // gets knocked out and **respawns at full** -- which is the same number this
  // assertion is looking for and would have passed for entirely the wrong
  // reason. A clean room, no heat, no investigation and one officer.
  console.log('\n--- and the officer you put down ---');
  {
    const world = emptyWorld();
    const room = new Simulation(world, { accounts: store, wallets });
    const mega = await liveHero(room, store, wallets, 'Refill', TEAM.MARITA, [
      'Front Bar', 'Long Bomb', 'Meth-adone', 'Off Your Face', 'Sirens Are Music', 'Glassing', 'Newtown Standoff',
    ]);
    stand(room, mega, 0, 1.1);
    room.step(out);
    check(room.teams.flag(mega.id, FX.KO_OFFICER_HEALS), 'the fixture has the heal');

    const officer = room.factions.promote(NPC_KIND.POLICE, 0, 0, 0, 0, 1, -1);
    if (!officer) throw new Error('the officer would not promote');
    // Home is half a kilometre away. `promote` sets `homeX/homeZ` to where the
    // actor was placed, and an officer with no investigation walks home and sets
    // `health = -2` the instant it is within two metres of it -- so an officer
    // promoted *at* its own home despawns on its first `think`, before any punch
    // can reach it. That is `POLICE.think`'s RETURN branch working correctly and
    // it is the whole reason this line exists.
    officer.homeX = 500;
    officer.homeZ = 500;
    // One pip, so the fixture is one punch rather than three -- which keeps the
    // player's half-pip out of range of the response their own swing provokes.
    officer.health = 1;
    mega.combat.health = 0.5;
    const max = fxMaxPips(mega.id, MAX_HEALTH);
    // Through the real swing, because the branch under test is in
    // `Simulation.hitNpc` and the only thing that reaches it is a punch that
    // connected. The officer is pinned each pass: with no investigation they are
    // in `RETURN` and would otherwise walk out of reach.
    // Looped until the **state** rather than the health says so: `strikeNpc`
    // stands a downed officer's health back up to `maxHealth` on the way down --
    // "hardy rather than immortal", see there -- so `health <= 0` is only ever
    // true for a kind with no downtime at all, and an assertion on it would have
    // spun this loop out and then failed on a knockout that did happen.
    for (let i = 0; i < 60 && officer.state !== NPC_STATE.DOWN; i++) {
      stand(room, mega, 0, 1.1);
      mega.combat.body.yaw = 0;
      mega.input.yaw = 0;
      mega.viewTicks = 0;
      officer.x = 0;
      officer.y = 0;
      officer.z = 0;
      mega.input.punch = true;
      room.step(out);
      mega.input.punch = false;
      room.step(out);
    }
    check(officer.state === NPC_STATE.DOWN, 'the officer went down to a bat', `state ${officer.state}`);
    check(
      Math.abs(mega.combat.health - max) < 1e-9,
      'and the KO refilled the mega to their own maximum',
      `${mega.combat.health} of ${max}`,
    );
  }

  // --- `R` at a Flat White point: the pie, the wallet and the two refusals.
  console.log('\n--- R, at a flat white ---');
  {
    const world = emptyWorld();
    // One cafe at the origin. `emptyWorld` has an empty point table, which is
    // exactly the "away from a point" case and is why the third assertion below
    // moves the *player* rather than emptying this.
    const cafes: PowerupPoint[] = [createPoint('cafe:0', FLAT_WHITE, 0, 0, 0)];
    (world as unknown as { points: readonly PowerupPoint[] }).points = cafes;
    const room = new Simulation(world, { accounts: store, wallets });
    const eater = await liveHero(room, store, wallets, 'Piey', TEAM.MARITA, ['Big Night', 'Tap On', 'Servo Pie']);
    check(hasNode(eater.talents, nodeId(TEAM.MARITA, 'Servo Pie')), 'the fixture bought Servo Pie', JSON.stringify(eater.walletNote));
    if (!eater.wallet) {
      check(false, 'the fixture has a wallet');
      return;
    }
    stand(room, eater, 0.5, 0);
    room.step(out);
    check(room.teams.flag(eater.id, FX.EAT), 'and the fold hands the hook its flag');

    // Broke, at the counter. Refused, and told why -- which is the whole reason
    // `R`'s refusal goes through `note` when `G`'s does not.
    eater.wallet.balance = 0;
    eater.combat.health = 1;
    clearPill(eater);
    pressR(room, eater, out);
    check(eater.wallet.balance === 0, 'a pie on $0 is refused', `$${eater.wallet.balance}`);
    check(pill(room, eater) !== '', 'and the player is told', JSON.stringify(eater.walletNote));

    // Twenty metres away, with the money. Refused for the other reason.
    eater.wallet.balance = 50;
    stand(room, eater, 20, 0);
    clearPill(eater);
    pressR(room, eater, out);
    check(eater.wallet.balance === 50, 'a pie twenty metres from any point is refused', `$${eater.wallet.balance}`);
    check(/flat white/.test(pill(room, eater)), 'and the reason names the place', JSON.stringify(eater.walletNote));

    // At the counter, with the money. $6, and the pips arrive over four seconds
    // rather than at once -- which is the pie's whole character.
    stand(room, eater, 0.5, 0);
    eater.combat.health = 1;
    clearPill(eater);
    pressR(room, eater, out);
    check(eater.wallet.balance === 44, 'a pie at the counter costs $6', `$${eater.wallet.balance}`);
    const rightAfter = eater.combat.health;
    check(rightAfter < 1.2, 'and nothing has arrived on the first tick', String(rightAfter));
    // Four seconds of ticks, and then one more so the last fraction lands.
    for (let i = 0; i < 4 * 60 + 10; i++) room.step(out);
    check(
      Math.abs(eater.combat.health - 3) < 1e-6,
      'and two pips are in by four seconds',
      String(eater.combat.health),
    );
    // The borrowed pip: Big Night's four plus the pie's one.
    check(
      fxMaxPips(eater.id, MAX_HEALTH) === 5,
      'and the pie is carrying an extra maximum pip',
      String(fxMaxPips(eater.id, MAX_HEALTH)),
    );
  }

  // --- The sausage, which is a different ability wearing the same key.
  console.log('\n--- and the sausage, which is for everybody ---');
  {
    const world = emptyWorld();
    const cafes: PowerupPoint[] = [createPoint('cafe:1', FLAT_WHITE, 0, 0, 0)];
    (world as unknown as { points: readonly PowerupPoint[] }).points = cafes;
    const room = new Simulation(world, { accounts: store, wallets });
    const cook = await liveHero(room, store, wallets, 'Snagger', TEAM.DEFAULT, ['Sausage Sizzle']);
    // A Marita standing beside the barbecue. The node says "bystanders", not
    // "teammates", and this is the case that keeps it that way.
    const other = await liveHero(room, store, wallets, 'Stranger', TEAM.MARITA, ['Front Bar']);
    if (!cook.wallet) {
      check(false, 'the sausage fixture has a wallet');
      return;
    }
    cook.wallet.balance = 20;
    stand(room, cook, 0.5, 0);
    stand(room, other, 3, 0);
    room.step(out);
    check(room.teams.flag(cook.id, FX.SIZZLE), 'the fixture has Sausage Sizzle');

    cook.combat.health = 1;
    other.combat.health = 1;
    // Four stars, which a pie would be refused at and a sausage is not -- the
    // cheap node is the one that always works, which is the whole shape of the
    // tier-1 / tier-2 split.
    room.heat.debugSet(cook.id, 4, room.tick);
    pressR(room, cook, out);
    check(cook.wallet.balance === 17, 'a sausage costs $3', `$${cook.wallet.balance}`);
    check(cook.combat.health >= 2, 'and one pip lands immediately', String(cook.combat.health));
    check(other.combat.health >= 2, 'and a bystander three metres away gets one too', String(other.combat.health));
    check(room.heat.starsOf(cook.id) === 3, 'and the crowd forgets one tier', `${room.heat.starsOf(cook.id)} stars`);
    for (let i = 0; i < 6 * 60 + 10; i++) room.step(out);
    // `>= 3 - 1e-6` rather than `>= 3`: the drip is a float accumulated over 360
    // ticks and lands on 2.9999999999999996, which is two pips by any reading a
    // player has. `verifyTeamFx`'s own food case uses the same epsilon.
    check(
      cook.combat.health >= 3 - 1e-6,
      'and the second pip is in by six seconds',
      String(cook.combat.health),
    );
  }

  await store.close();
  await wallets.close();
  await Bun.$`rm -f ${path} ${walletPath}`.quiet().nothrow();
}

await run();

console.log(`\n${failures.length === 0 ? 'teams-check: everything passed' : `teams-check: ${failures.length} failure(s)`}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
