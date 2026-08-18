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
 *   - the weekly flip clearing the points and **keeping the side**, which is the
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
import { EYE_HEIGHT } from '../client/src/player/controller.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { PowerupField } from '../client/src/game/powerups.ts';
import { TerrainField } from '../client/src/world/terrain.ts';
import { TrafficField } from '../client/src/game/traffic.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { decodeRoster, encodeRoster } from '../client/src/net/protocol.ts';
import { levelFor, weekOf } from '../client/src/net/accounts.ts';
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
import { Simulation, type Participant } from './sim.ts';
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
    collision: new CollisionWorld(),
    terrain: new TerrainField(16, 500, ''),
    water: WaterLevels.fromIndex([], 500),
    powerups: new PowerupField(),
    traffic: new TrafficField(),
    peds: new PedestrianField(),
    points: [],
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

  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, surge);
  check(!hasNode(hero.talents, surge), 'a tier-2 node on one point in the tree is refused');
  check(/needs 2 in Servo/.test(pill(sim, hero)), 'with the reason', JSON.stringify(hero.walletNote));

  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, tapOn);
  check(hasNode(hero.talents, tapOn), 'the second tier-1 node fits in the two points a level 2 has');
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.TAKE, surge);
  check(!hasNode(hero.talents, surge), 'and now the tier is open but the points are gone');
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
    record.level = levelFor(record.kills);
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

  // --- Refunding out from under it is refused.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.REFUND, bigNight);
  check(hasNode(hero.talents, bigNight), 'a node the mega stands on cannot be refunded');
  check(/depends on it/.test(pill(sim, hero)), 'and the reason names what depends on it', JSON.stringify(hero.walletNote));

  // The mega itself comes back out, and then the node under it does.
  clearPill(hero);
  sim.teamOp(hero.id, TEAM_OP.REFUND, cashRules);
  check(!hasNode(hero.talents, cashRules), 'the mega refunds');
  sim.teamOp(hero.id, TEAM_OP.REFUND, bigNight);
  check(!hasNode(hero.talents, bigNight), 'and now so does the node it stood on');
  sim.teamOp(hero.id, TEAM_OP.TAKE, bigNight);
  check(hasNode(hero.talents, bigNight), 'and goes back in');

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

  // --- The weekly flip: the points go, the side stays.
  {
    record.levelWeek = '2020-W01';
    clearPill(hero);
    sim.rollWeeks();
    check(hero.level === 1 && record.level === 1, 'a new week is level 1 again', `level ${hero.level}`);
    check(countBits(record.talents) === 0, 'the talents went with the level', JSON.stringify(record.talents));
    check(countBits(hero.talents) === 0, 'and the body stopped playing last week’s build');
    check(record.team === TEAM.MARITA, 'and the side did **not**', TEAM_NAME[record.team]);
    check(hero.team === TEAM.MARITA, 'on the body either');
    check(record.levelWeek === weekOf(), 'stamped into this week', record.levelWeek);
    // And a second CHOOSE is still refused, which is the whole reason the side
    // is not reset: a player does not get to change sides by waiting.
    sim.teamOp(hero.id, TEAM_OP.CHOOSE, TEAM.DEFAULT);
    check(hero.team === TEAM.MARITA, 'a new week does not reopen the choice');
  }

  // --- Auras, through the tick that fills the real index.
  console.log('\n--- an aura, twelve metres wide ---');
  {
    const store = new AccountStore(`${accountPath}.aura`);
    await store.load();
    const fresh = emptyWorld();
    const room = new Simulation(fresh, { accounts: store });

    const make = async (handle: string, team: number): Promise<Participant> => {
      await store.signup(handle, 'hunter2hunter2', '', null);
      const rec = store.byHandle(handle);
      if (!rec) throw new Error(`no ${handle}`);
      rec.kills = 90;
      rec.level = levelFor(rec.kills);
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

    stand(taker, 20);
    room.step(out);
    check(
      room.teams.scalar(taker.id, FX.TEAM_EARN) === 0,
      `and twenty metres is outside the ${AURA_M} m radius`,
      String(room.teams.scalar(taker.id, FX.TEAM_EARN)),
    );

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

  await accounts.close();
  await Bun.$`rm -f ${accountPath}`.quiet().nothrow();
}

await run();

console.log(`\n${failures.length === 0 ? 'teams-check: everything passed' : `teams-check: ${failures.length} failure(s)`}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
