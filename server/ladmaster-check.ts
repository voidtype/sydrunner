/**
 * The first thirty seconds of this game, walked end to end.
 *
 *     bun run server/ladmaster-check.ts
 *
 * A fresh account at level 1 stands in Sydney Park, takes the tutorial off the
 * Ladmaster, gets a lime bike within five metres, is pointed at Redfern, rides
 * there, hands it to Rabbitohs Ray, is $10 and 2 xp better off, and is refused
 * the job the second time. Against the **shipped** `content/` packs, a real
 * `Simulation`, the real `QuestEngine`, the real wallet and the real account
 * store -- so every seam between them is under test and none of the content is
 * a fixture.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT MORE OF `quests-check.ts`
 *
 * `server/quests-check.ts` phase G already reads the shipped packs and asserts
 * everything about them that is true **on paper**: the tutorial is on rung 1,
 * nothing gates it, it grants a bike, its banner says GET TO REDFERN, and the
 * step lands on Ray. Every one of those can be true while the thing does not
 * happen, because the properties this feature actually has are all *between*
 * files:
 *
 *   - a quest with `"bike": true` reaching `Simulation.loanBike` at all, which
 *     is three optional hops (`Quest.grantsBike` -> `QuestWorld.loanBike` ->
 *     `sim.bikes.adopt`) and any of them missing is silence;
 *   - the loan bike being **1 to 5 m** from the body the server has, not from
 *     the one the client thinks it has;
 *   - the loan going out **on the wire**, which is the failure the queue in
 *     `Simulation.bikeLoans` exists for -- a bike adopted from the socket pump
 *     and cleared by the next `step` before `Room.sendBikes` ever saw it is a
 *     bicycle the server believes in and no client has heard of;
 *   - the waypoint pointing at Redfern out of a **real cursor** rather than out
 *     of a hand-built one;
 *   - the arrow **retiring** when the step closes, driven by the engine's own
 *     sweep rather than by this file moving a number;
 *   - the turn-in being **Ray's**, not the giver's, which is the one thing in
 *     the content that `validateBundle` cannot check: it asks that *somebody*
 *     turns each quest in, and getting that somebody wrong is a player standing
 *     in front of the wrong person in Redfern.
 *
 * It runs in about a second on `verifySim`'s empty-city fixture, on
 * `quests-check`'s own argument: a city with no prisms in it is all a walk
 * needs, and a check that had to load Sydney is a check nobody runs on a
 * content edit. The one thing that costs is that an empty city has no ground
 * and no rails, so the placement is exercised against a flat world here and
 * against the real prisms by `verifyBikes`' fixtures.
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
import { XP_PER_LEVEL } from '../client/src/net/accounts.ts';
import {
  NPC_MARKER,
  completionFlag,
  markerFor,
  questRefusal,
  questView,
  type PlayerFacts,
} from '../client/src/game/questmodel.ts';
import { BIKE_LOAN_ID_BASE, LOAN_MAX_M, LOAN_MIN_M, isLoanBike, loanBikeId } from '../client/src/game/bikes.ts';
import {
  activeWaypoint,
  screenBearing,
  waypointRange,
  waypointRangeText,
} from '../client/src/game/waypoint.ts';
import { QUEST_OP } from '../client/src/net/quests.ts';
import { AccountStore } from './accounts.ts';
import { WalletStore } from './wallets.ts';
import { Simulation, type Participant } from './sim.ts';
import { ContentStore, ImprovCache, QuestEngine, type QuestWorld } from './quests.ts';
import type { ServerWorld } from './world.ts';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** `verifySim`'s fixture, for its reasons. `quests-check.emptyWorld`, verbatim. */
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
    pointIndex: new SpatialHash<number>(),
    tileOf: new Map(),
    bytes: { collision: 0, terrain: 0, powerups: 0, lanes: 0 },
    powerupSource: [],
    spawn: { x: 0, z: 0 },
    places: [],
  };
}

/** `quests-check`'s clock, for its reason: a walk must not trip the flood guard. */
let clock = 1_800_000_000_000;
function at(): number {
  clock += 250;
  return clock;
}

/** Put a body somewhere, feet on the fixture's flat ground. */
function stand(p: Participant, x: number, z: number): void {
  p.combat.body.position.set(x, EYE_HEIGHT, z);
}

async function main(): Promise<void> {
  const scratch = `${process.env.SYDNEY_STATE_DIR ?? './data/state'}/ladmaster-check`;
  await Bun.$`rm -rf ${scratch}`.quiet().nothrow();

  // --- Phase A: the shipped content, and the two people in it ----------------------
  console.log('--- phase A: the Ladmaster and Ray, out of content/ ---');
  const content = new ContentStore({
    dir: new URL('../content', import.meta.url).pathname,
    ledgerPath: `${scratch}/ledger.json`,
    timers: false,
  });
  const loadErrors = await content.load();
  check(loadErrors.length === 0, 'content/ validates', loadErrors.slice(0, 2).join('; '));

  const lad = content.bundle.npcs.find((n) => n.id === 'ladmaster');
  const ray = content.bundle.npcs.find((n) => n.id === 'rabbitohs-ray');
  const quest = content.bundle.quests.find((q) => q.id === 'act0-ladmaster');
  if (!lad || !ray || !quest) {
    check(false, 'the tutorial, the Ladmaster and Ray are all in the bundle', `${!!lad} ${!!ray} ${!!quest}`);
    return;
  }
  check(lad.marker === NPC_MARKER.HERO, 'the Ladmaster wears the hero mark', lad.marker);
  check(ray.marker === NPC_MARKER.NONE, 'and Ray does not', ray.marker);
  // The Ladmaster stands where a player can see him from the spawn. Not asserted
  // against a hard-coded pair -- `game/spawn.SPAWN_TARGET` is the pin and
  // `spawnCentre` resolves it -- but against the distance that matters, which is
  // "inside the hero mark's reach from anywhere in the dither disc".
  {
    const { SPAWN_DITHER_RADIUS, SPAWN_TARGET } = await import('../client/src/game/spawn.ts');
    const { HERO_RANGE_M } = await import('../client/src/world/questmarkers.ts');
    const fromCentre = Math.hypot(lad.x - SPAWN_TARGET.x, lad.z - SPAWN_TARGET.z);
    check(fromCentre < SPAWN_DITHER_RADIUS, 'he stands inside the spawn disc itself', `${fromCentre.toFixed(0)} m from the pin`);
    check(
      fromCentre + SPAWN_DITHER_RADIUS < HERO_RANGE_M,
      `and his mark reaches every point of the disc: ${(fromCentre + SPAWN_DITHER_RADIUS).toFixed(0)} m worst case, under ${HERO_RANGE_M}`,
    );
  }
  // The verbatim line, which is the owner's and is not this repo's to tidy.
  const job = lad.nodes.find((n) => n.id === 'job');
  check(
    job?.line ===
      'Adlay, you need some more ascay! Get down to Cenno and tell em you did 5 job interviews this week, eshay bruv! ' +
        'Grab this lime bike and ride down to the fern cuz, its just straight down here then right!',
    'his line survived the parser word for word',
    job?.line?.slice(0, 48),
  );
  // The doors: he offers it, Ray takes it back. `validateBundle` asks only that
  // *somebody* does each; which somebody is the content's whole shape here.
  check(
    lad.nodes.some((n) => n.choices.some((c) => c.accept === quest.id)),
    'the Ladmaster is the door in',
  );
  check(
    ray.nodes.some((n) => n.choices.some((c) => c.turnin === quest.id)),
    'and Ray is the door out',
  );
  check(
    !lad.nodes.some((n) => n.choices.some((c) => c.turnin === quest.id)),
    'the Ladmaster cannot take it back; that is the walk',
  );

  // --- Phase B: a fresh account at level 1 -----------------------------------------
  console.log('\n--- phase B: a brand new player, in the park ---');
  const wallets = new WalletStore(`${scratch}/wallets.json`);
  await wallets.load();
  const accounts = new AccountStore(`${scratch}/accounts.json`);
  await accounts.load();
  const signed = await accounts.signup('Shazza', 'hunter2hunter2', '', wallets);
  const record = accounts.byHandle('shazza');
  if (!signed.ok || !record) {
    check(false, 'the check account exists');
    return;
  }
  check(record.level === 1 && record.xp === 0, 'a fresh account is level 1 with no xp', `${record.xp} xp`);
  check(record.story.length === 0, 'and no story at all', JSON.stringify(record.story));

  const sim = new Simulation(emptyWorld(), { wallets, accounts });
  const hero = sim.join(0, null, record.handle, record);
  const bikesAtJoin = sim.bikes.size;

  const sent: Array<{ id: number; frame: ArrayBuffer }> = [];
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
    levelled: (id, level) => {
      const p = sim.participants.get(id);
      if (p) p.level = level;
    },
    rideStation: () => null,
    // The one line `server/index.ts` has, in miniature. Without it the whole
    // feature is a quest that says grab the bike and hands over nothing.
    loanBike: (id, seed) => sim.loanBike(id, seed),
    send: (id, frame) => {
      sent.push({ id, frame });
    },
  };
  const engine = new QuestEngine(content, new ImprovCache({ url: '', key: '' }), world, accounts);
  sim.setQuestSink(engine);

  // Standing at the Ladmaster's feet, which is where a player who walked to the
  // `!` is. The fixture city is empty, so the coordinates are the real ones and
  // the ground under them is flat -- see the header on what that costs.
  stand(hero, lad.x, lad.z);

  /*
   * **Offered at level 1 with no flags at all.** The register is exact, and the
   * whole claim of this feature is that the first thing in the game is offered
   * to somebody who has nothing -- so the refusal is asked for directly rather
   * than inferred from the accept working.
   */
  const facts = (): PlayerFacts => ({
    level: hero.level,
    faction: '',
    story: new Set(record.story),
    cash: sim.wallet.balanceOf(hero.id),
  });
  const view = () => questView(content.bundle.quests, record.quests);
  check(questRefusal(quest, facts(), record.quests) === '', 'the tutorial refuses nobody at level 1', questRefusal(quest, facts(), record.quests));
  check(engine.offers(hero.id).some((q) => q.id === quest.id), 'and it is in the register');
  check(markerFor(lad, facts(), view()) === 'offer', 'so the Ladmaster draws the "!"');
  check(markerFor(ray, facts(), view()) === 'none', 'and Ray draws nothing yet');

  // --- Phase C: the accept, and the bike --------------------------------------------
  console.log('\n--- phase C: "grab this lime bike" ---');
  engine.handle(hero.id, QUEST_OP.ACCEPT, quest.id, '', 0, at());
  check(record.quests[quest.id] !== undefined, 'the tutorial was accepted');

  const loanId = loanBikeId(hero.id);
  const bike = sim.bikes.get(loanId);
  check(bike !== undefined, 'a bike appeared', `id ${loanId}`);
  check(isLoanBike(loanId), 'with an id in the loan band, outside anything bikePlan hands out', `${loanId} >= ${BIKE_LOAN_ID_BASE}`);
  check(sim.bikes.size === bikesAtJoin + 1, 'exactly one bike appeared', `${sim.bikes.size - bikesAtJoin}`);
  if (bike) {
    const gap = Math.hypot(bike.x - lad.x, bike.z - lad.z);
    check(gap >= LOAN_MIN_M - 1e-6, `it is not inside the player: ${gap.toFixed(2)} m, at least ${LOAN_MIN_M}`);
    check(gap <= LOAN_MAX_M + 1e-6, `and it is within reach: ${gap.toFixed(2)} m, at most ${LOAN_MAX_M}`);
    check(bike.rider === 0, 'unclaimed, so the player just gets on it', `rider ${bike.rider}`);
    // Standing on the ground the server has, not floating over it.
    check(Math.abs(bike.y - 0) < 1e-6, 'and on the ground', `y ${bike.y}`);
  }

  /*
   * **It goes out on the wire**, which is the queue in `Simulation.bikeLoans`
   * doing its job. The accept happened off the socket pump; the next `step`
   * clears `bikeChanges` at the top, and a loan pushed straight there would be
   * gone before `Room.sendBikes` read it.
   */
  const out = { tick: 0, events: [], snapshot: null };
  sim.step(out);
  const delta = sim.bikeDelta();
  check(
    delta.some((b) => b.id === loanId),
    'the loan is in the tick\'s bike delta, so every client is told about it',
    delta.map((b) => b.id).join(', '),
  );
  // And it is not re-sent forever: one tick, one record.
  sim.step(out);
  check(!sim.bikeDelta().some((b) => b.id === loanId), 'and only on the one tick');

  // Accepting again is refused, and does not litter Sydney with a second bike.
  engine.handle(hero.id, QUEST_OP.ACCEPT, quest.id, '', 0, at());
  check(sim.bikes.size === bikesAtJoin + 1, 'a second accept does not conjure a second bike', `${sim.bikes.size - bikesAtJoin}`);

  // --- Phase D: the waypoint ---------------------------------------------------------
  console.log('\n--- phase D: GET TO REDFERN ---');
  {
    const wp = activeWaypoint(content.bundle.quests, record.quests, lad.x, lad.z);
    if (wp === null) {
      check(false, 'the accepted job produced a waypoint');
    } else {
      check(wp.questId === quest.id, 'the waypoint is the tutorial\'s', wp.questId);
      check(wp.text === 'GET TO REDFERN', 'and the banner reads GET TO REDFERN', wp.text);
      check(wp.x !== null && wp.z !== null, 'it has somewhere to point');
      const range = waypointRange(lad.x, lad.z, wp.x ?? 0, wp.z ?? 0);
      check(range > 2000, 'Redfern is a ride away', waypointRangeText(range));
      // The needle. Redfern is north and east of Sydney Park, so a player facing
      // due north sees the arrow to their right -- clockwise, positive. This is
      // the one number in the feature that is invisible when it is backwards.
      const facingNorth = screenBearing(lad.x, lad.z, wp.x ?? 0, wp.z ?? 0, 0);
      check(facingNorth > 0 && facingNorth < Math.PI / 2, 'facing north, the needle points up and to the right', `${((facingNorth * 180) / Math.PI).toFixed(0)} deg`);
      // Turn to face it and the needle comes to the top of the frame.
      const yawAtIt = Math.atan2(-((wp.x ?? 0) - lad.x), -((wp.z ?? 0) - lad.z));
      check(
        Math.abs(screenBearing(lad.x, lad.z, wp.x ?? 0, wp.z ?? 0, yawAtIt)) < 1e-9,
        'and facing it brings the needle to straight up',
      );
    }
  }

  // --- Phase E: the ride, and the arrival --------------------------------------------
  console.log('\n--- phase E: down to the fern ---');
  stand(hero, ray.x, ray.z);
  engine.tick(1);
  const cursor = engine.cursorFor(hero.id, quest.id);
  check(cursor?.d === true, 'standing at Ray finishes the step', `done=${cursor?.d}`);
  check(markerFor(ray, facts(), view()) === 'turnin', 'and Ray draws the "?"');
  /*
   * **The arrow retires.** Not by anybody clearing it -- the cursor moved and
   * `activeWaypoint` reads the cursor, which is the whole design. This is the
   * assertion that would fail if the waypoint were ever cached anywhere.
   */
  check(
    activeWaypoint(content.bundle.quests, record.quests, ray.x, ray.z) === null,
    'and the waypoint retires on its own, because it was never a copy of anything',
  );

  // --- Phase F: the turn-in ----------------------------------------------------------
  console.log('\n--- phase F: ten bucks and two xp ---');
  const cashBefore = sim.wallet.balanceOf(hero.id);
  const xpBefore = record.xp;
  engine.handle(hero.id, QUEST_OP.TURNIN, quest.id, '', 0, at());
  check(sim.wallet.balanceOf(hero.id) === cashBefore + 10, 'the turn-in paid $10', `$${sim.wallet.balanceOf(hero.id) - cashBefore}`);
  check(record.xp === xpBefore + 2, 'and 2 xp', `${record.xp - xpBefore} xp`);
  check(record.level === 1, 'which is nothing, so the player is still on rung 1', `level ${record.level}`);
  check(record.xp < XP_PER_LEVEL, `and ${record.xp} xp is a long way under the ${XP_PER_LEVEL} that would move them off it`);
  check(record.story.includes('act0:shown'), 'the "you have been shown the ropes" flag is set', JSON.stringify(record.story));
  check(record.story.includes(completionFlag(quest.id)), 'and the permanent completion mark');
  check(record.quests[quest.id] === undefined, 'the cursor is gone');

  // --- Phase G: and it refuses -------------------------------------------------------
  console.log('\n--- phase G: and never again ---');
  const refusal = questRefusal(quest, facts(), record.quests);
  check(refusal !== '', 'the tutorial now refuses', JSON.stringify(refusal));
  stand(hero, lad.x, lad.z);
  engine.handle(hero.id, QUEST_OP.ACCEPT, quest.id, '', 0, at());
  check(record.quests[quest.id] === undefined, 'and cannot be taken a second time');
  check(markerFor(lad, facts(), view()) === 'none', 'so the Ladmaster stops shouting');
  check(!engine.offers(hero.id).some((q) => q.id === quest.id), 'and it is out of the register');
  // The one thing a hand-in must never do: pay twice.
  const paid = sim.wallet.balanceOf(hero.id);
  engine.handle(hero.id, QUEST_OP.TURNIN, quest.id, '', 0, at());
  check(sim.wallet.balanceOf(hero.id) === paid, 'handing it in again pays nothing', `$${sim.wallet.balanceOf(hero.id)}`);

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
console.log('ladmaster-check: all good.');
