/**
 * The accounts check: the ladder, the gates and the routes, end to end.
 *
 *     bun run server/accounts-check.ts                       # phase A only
 *     SYDNEY_CHECK_URL=http://localhost:8797 \
 *       bun run server/accounts-check.ts                     # both phases
 *
 * **Why this exists as a file rather than as more of `verifyAccounts`.**
 *
 * `client/src/net/accounts.ts`'s self-check covers everything this feature can
 * get wrong *arithmetically* -- the handle fold, the level formula, the week
 * reset, token expiry, the file parser -- and it runs at boot in both runtimes,
 * which is where a check of that kind belongs. What it cannot cover is
 * everything that only exists when the pieces are wired together:
 *
 *   - a knockout in a real `Simulation` reaching a real `AccountStore`;
 *   - the level arriving on a real `ROSTER` frame;
 *   - `POST /auth/signup` moving a guest's balance onto the account;
 *   - a `HELLO` with a token naming the participant, and a guest wearing a
 *     registered handle being refused;
 *   - the feedback gate refusing a guest's `SUGGEST` and admitting an account's;
 *   - **workstream N**: a sign-up carrying a live guest's kills and position
 *     onto the new account, a disconnect writing `lastPos` to disk, and a rejoin
 *     spawning on it -- including the three ways that last one is refused (a new
 *     week, a building now standing there, a spot that was never saved).
 *
 * That last group is phase C, and it is a phase of its own rather than more of
 * phase A for one reason: it needs a world it can **build a building in**, and
 * phase A's fixture is deliberately an empty city that nothing has touched.
 * Every check in it is a seam between the store, the simulation and
 * `game/spawn.ts`, and every one of them is silent in the worst way this feature
 * has: a player is put back *somewhere*, the game runs perfectly, and the only
 * evidence that it is the wrong somewhere is a person who remembers where they
 * logged off.
 *
 * Every one of those is a seam between two files, and every one of them fails
 * *silently* in this repo's sense: the game plays perfectly and the level is
 * wrong, or the money is on the wrong key, or the wrong person is wearing your
 * handle. `server/integration-check.ts` is where a check like this would
 * normally live and it takes 45 minutes against the built world; this runs in
 * about a second, because **phase A uses `verifySim`'s empty-city fixture**
 * rather than loading Sydney. A city with no prisms and no terrain in it is all
 * a punch needs.
 *
 * Phase B needs a server. It is skipped rather than failed when there is none,
 * so the file is runnable on a laptop with nothing else open.
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
import {
  MSG,
  PROTOCOL_VERSION,
  SNAPSHOT_HZ,
  decodeBye,
  decodeRoster,
  decodeWelcome,
  encodeHello,
  encodeRoster,
  encodeWelcome,
  frameType,
} from '../client/src/net/protocol.ts';
import {
  SUGGEST_RESULT,
  decodeSuggestAck,
  encodeSuggestSubmit,
} from '../client/src/net/suggestions.ts';
import { weekOf } from '../client/src/net/accounts.ts';
import { AccountStore, AuthGuards, handleAuthRequest, type LiveLookup } from './accounts.ts';
import { WalletStore } from './wallets.ts';
import { PROMPTED, SAVE_PROMPT_BALANCE, Simulation, type Participant } from './sim.ts';
import type { ServerWorld } from './world.ts';

const failures: string[] = [];
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

// --- Phase A: a knockout, a ladder, a wallet and a file -------------------------

/**
 * `verifySim`'s fixture, for its reasons: a real `CollisionWorld` with no prisms
 * and a real `TerrainField` with no grids, so every query runs through the same
 * `groundFor` the live server uses and nothing has to be stubbed.
 */
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

/**
 * Stand the attacker a metre in front of the victim, facing them, with both
 * histories seeded there.
 *
 * Re-applied after every knockout because a respawn moves the victim, and
 * because the lag-compensated hit test reads `history` rather than the body --
 * a repositioned combatant with a stale history is a punch that lands where
 * they were, which is `verifySim`'s own rewind check from the other side.
 */
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

/** Punch until the attacker's KO count moves, or give up. Returns whether it did. */
function knockDown(sim: Simulation, attacker: Participant, victim: Participant): boolean {
  const out = { tick: 0, events: [], snapshot: null };
  const want = attacker.kos + 1;
  for (let i = 0; i < 400 && attacker.kos < want; i++) {
    // Re-squared every tick: a landed punch throws the victim several metres
    // (spec 8.2's knockback), and a check that let them fly would be measuring
    // how far a body slides rather than how a ladder counts.
    squareUp(sim, attacker, victim);
    attacker.input.punch = true;
    sim.step(out);
    attacker.input.punch = false;
    sim.step(out);
  }
  return attacker.kos >= want;
}

async function phaseA(): Promise<void> {
  console.log('\n--- phase A: the ladder, in a real Simulation ---');
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  const accountPath = `${dir}/accounts-check.json`;
  const walletPath = `${dir}/accounts-check-wallets.json`;
  await Bun.$`rm -f ${accountPath} ${walletPath}`.quiet().nothrow();

  const wallets = new WalletStore(walletPath);
  await wallets.load();
  // A guest who has been playing, so sign-up has something to migrate.
  wallets.for('Bazza').balance = 137;
  const accounts = new AccountStore(accountPath);
  await accounts.load();

  // --- Sign up, and "would you like to save progress?" answered.
  const signed = await accounts.signup('Bazza', 'hunter2hunter2', 'Bazza', wallets);
  check(signed.ok && signed.token.length === 64, 'sign up mints a token', signed.message);
  const record = accounts.byHandle('bazza');
  if (!record) {
    check(false, 'the account exists after sign-up');
    return;
  }
  check(wallets.forAccount(record.id).balance === 137, 'the guest wallet migrated to the account', `$${wallets.forAccount(record.id).balance}`);
  check(!wallets.has('Bazza'), 'the guest row is gone, not copied');
  check(accounts.registered('  BAZZA  '), 'the handle is reserved however it is typed');
  check(!JSON.stringify(signed).includes('argon2'), 'the hash is never in a response');

  // --- Ten knockouts in a real simulation.
  const sim = new Simulation(emptyWorld(), { wallets, accounts });
  const hero = sim.join(0, null, record.handle, record);
  const victim = sim.join(1, null, 'Davo');
  check(hero.accountId === record.id, 'a logged-in participant carries its account id');
  check(hero.level === 1 && victim.level === 1, 'both start at level 1');
  check(victim.accountId === null, 'a guest carries no account id');

  let knocked = 0;
  for (let i = 0; i < 10; i++) {
    if (!knockDown(sim, hero, victim)) break;
    knocked++;
    if (knocked === 9) {
      check(hero.level === 1 && record.level === 1, 'nine knockouts is still level 1', `level ${hero.level}`);
    }
    // Out of the knockout phase before the next one; `hurt` refuses a body that
    // is already down, so punching a corpse would loop forever.
    const out = { tick: 0, events: [], snapshot: null };
    for (let t = 0; t < 400 && victim.combat.phase === 'ko'; t++) sim.step(out);
  }
  check(knocked === 10, 'ten knockouts landed', `${knocked} of 10`);
  check(hero.kos === 10, 'the scoreboard counted them', `${hero.kos} KOs`);
  check(record.kills === 10, 'the account counted them', `${record.kills} kills`);
  check(hero.level === 2 && record.level === 2, 'ten kills is level 2', `level ${hero.level}`);

  // --- The level is on the roster, and survives the wire.
  {
    const rows = sim.roster();
    const mine = rows.find((r) => r.id === hero.id);
    check(mine?.level === 2, 'the roster carries the level', `level ${mine?.level}`);
    const back = decodeRoster(encodeRoster(rows));
    const wire = back?.find((r) => r.id === hero.id);
    check(wire?.level === 2, 'and it survives encode/decode', `level ${wire?.level}`);
    check(back?.find((r) => r.id === victim.id)?.level === 1, 'a guest is level 1 on the wire');
  }

  // --- The guest was told, once, and did not level.
  check(victim.level === 1, 'a guest reaching the threshold stays level 1', `level ${victim.level}`);
  {
    // The guest needs kills of their own for the prompt; one knockout of the
    // hero is not enough, so drive the guest to ten the same way.
    let hit = 0;
    for (let i = 0; i < 10; i++) {
      if (!knockDown(sim, victim, hero)) break;
      hit++;
      const out = { tick: 0, events: [], snapshot: null };
      for (let t = 0; t < 400 && hero.combat.phase === 'ko'; t++) sim.step(out);
    }
    check(hit === 10, 'the guest scored ten too', `${hit}`);
    check(victim.level === 1, 'and is still level 1', `level ${victim.level}`);
    check((victim.prompted & PROMPTED.LEVEL) !== 0, 'the guest was told to sign up to level up');
    // The pill is very often already taken on the tenth knockout -- the victim
    // drops cash and the attacker walks over it -- so the sentence is queued
    // behind that. This is exactly the case that made `Simulation.note` queue
    // rather than drop; see its header.
    victim.walletNote = '';
    sim.drainNotes();
    check(/sign up to level up/.test(victim.walletNote), 'the note says so', JSON.stringify(victim.walletNote));
    // Once. The note is cleared by delivery, so a second threshold must not
    // write another.
    victim.walletNote = '';
    for (let i = 0; i < 10; i++) {
      if (!knockDown(sim, victim, hero)) break;
      const out = { tick: 0, events: [], snapshot: null };
      for (let t = 0; t < 400 && hero.combat.phase === 'ko'; t++) sim.step(out);
    }
    victim.walletNote = '';
    sim.drainNotes();
    check(!/sign up to level up/.test(victim.walletNote), 'and only once', JSON.stringify(victim.walletNote));
  }

  // --- The $100 crossing. Once, and never for an account.
  {
    const guest = sim.join(2, null, 'Macca');
    if (guest.wallet) guest.wallet.balance = SAVE_PROMPT_BALANCE - 5;
    guest.walletNote = '';
    sim.wallet.credit(guest.id, 10, 'fare');
    check((guest.prompted & PROMPTED.MONEY) !== 0, 'crossing $100 arms the save-progress prompt', `$${guest.wallet?.balance}`);
    // Queued behind the money sentence rather than overwriting it, which is the
    // whole reason `note` queues. See `Simulation.note`.
    check(/fare/.test(guest.walletNote), 'the money movement still owns the pill', JSON.stringify(guest.walletNote));
    guest.walletNote = '';
    sim.drainNotes();
    check(/save progress/.test(guest.walletNote), 'and the prompt lands next', JSON.stringify(guest.walletNote));
    // A second crossing says nothing.
    guest.walletNote = '';
    sim.wallet.debit(guest.id, 50, 'spent');
    guest.walletNote = '';
    sim.wallet.credit(guest.id, 80, 'fare');
    guest.walletNote = '';
    sim.drainNotes();
    check(!/save progress/.test(guest.walletNote), 'a second crossing is silent', JSON.stringify(guest.walletNote));
    // And an account is never asked at all.
    hero.prompted = 0;
    hero.walletNote = '';
    if (hero.wallet) hero.wallet.balance = SAVE_PROMPT_BALANCE - 5;
    sim.wallet.credit(hero.id, 10, 'fare');
    hero.walletNote = '';
    sim.drainNotes();
    check(!/save progress/.test(hero.walletNote), 'an account is never asked to save progress', JSON.stringify(hero.walletNote));
  }

  // --- A restart. The whole point of an account.
  await accounts.close();
  const reloaded = new AccountStore(accountPath);
  await reloaded.load();
  const back = reloaded.byHandle('Bazza');
  check(back?.level === 2 && back?.kills === 10, 'the level survives a restart', `level ${back?.level} on ${back?.kills} kills`);
  const login = await reloaded.login('bazza', 'hunter2hunter2');
  check(login.ok && login.account?.level === 2, 'and logging in reports it', `${login.message}, level ${login.account?.level}`);
  check(!(await reloaded.login('bazza', 'not the password')).ok, 'a wrong password is refused');
  await reloaded.close();

  // --- The weekly reset, driven the way the brief describes: edit the file.
  {
    const raw = (await Bun.file(accountPath).json()) as { accounts: Record<string, { levelWeek: string }> };
    for (const a of Object.values(raw.accounts)) a.levelWeek = '2020-W01';
    await Bun.write(accountPath, JSON.stringify(raw));
    const flipped = new AccountStore(accountPath);
    await flipped.load();
    const after = flipped.byHandle('Bazza');
    check(after?.level === 1 && after?.kills === 0, 'a new week resets to level 1', `level ${after?.level} on ${after?.kills} kills`);
    check(after?.levelWeek === weekOf(), 'and stamps this week', after?.levelWeek);
    // And a connected player sees it: the per-room minute sweep.
    const live = new Simulation(emptyWorld(), { wallets, accounts: flipped });
    const p = live.join(0, null, after!.handle, after!);
    p.level = 6;
    after!.levelWeek = '2020-W02';
    p.walletNote = '';
    live.rollWeeks();
    check(p.level === 1, 'a player standing still is rolled over too', `level ${p.level}`);
    check(/new week/.test(p.walletNote), 'and is told why', JSON.stringify(p.walletNote));
    await flipped.close();
  }

  await wallets.close();
  await Bun.$`rm -f ${accountPath} ${walletPath}`.quiet().nothrow();
}

// --- Phase C: the carry, the save and the restore -------------------------------

/**
 * Stand somebody at a point, the way logging off somewhere actually leaves them.
 *
 * The **eye** is set, because `CombatantState.body.position` is an eye height
 * everywhere in this repo (see `protocol.Welcome`), and the history is reseeded
 * because a body moved without its ring is a body the rewind still thinks is
 * where it was -- `squareUp` above learnt the same lesson from the other end.
 */
function standAt(sim: Simulation, p: Participant, x: number, z: number, yaw: number): void {
  p.combat.body.position.set(x, EYE_HEIGHT, z);
  p.combat.body.yaw = yaw;
  p.input.yaw = yaw;
  p.history.seed(sim.tick, x, EYE_HEIGHT, z, yaw);
}

/** A solid box on the ground, centred on a point. The building that ate your spot. */
function buildingAt(world: ServerWorld, key: string, x: number, z: number, half = 8): void {
  world.collision.addPrisms(key, [
    {
      points: new Float32Array([x - half, z - half, x + half, z - half, x + half, z + half, x - half, z + half]),
      height: 12,
      base: 0,
    },
  ]);
}

/**
 * `POST /auth/signup`, through the real route.
 *
 * The route rather than `AccountStore.signup` directly, and that is the point of
 * doing it here at all: the thing being tested is the **body parsing and the
 * identity check** -- `liveGuest` reading `playerId` and `room` off the JSON and
 * refusing to carry anything when the name does not match -- and calling the
 * store would skip every line of it. Phase B does the same request over a real
 * socket to a real box; this one runs on a laptop with nothing open.
 */
async function signupOverHttp(
  store: AccountStore,
  guards: AuthGuards,
  live: LiveLookup | null,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = new URL('http://check.local/auth/signup');
  const req = new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await handleAuthRequest(req, url, '203.0.113.7', store, guards, null, live);
  return (await res.json()) as Record<string, unknown>;
}

async function phaseC(): Promise<void> {
  console.log('\n--- phase C: sign-up carries, log-off saves, rejoin restores ---');
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  const accountPath = `${dir}/accounts-check-carry.json`;
  await Bun.$`rm -f ${accountPath}`.quiet().nothrow();

  const accounts = new AccountStore(accountPath);
  await accounts.load();
  const guards = new AuthGuards();
  const world = emptyWorld();
  const sim = new Simulation(world, { accounts });

  /**
   * The host's lookup, as `server/index.ts` builds it -- a single room, because
   * that is what a fixture is. The two refusals in it are the interesting part
   * and are copied deliberately rather than simplified away: a bot and an
   * account are both "not a guest", and carrying off either would be a way to
   * move somebody else's position onto a new handle.
   */
  const live: LiveLookup = {
    guest(room, playerId) {
      if (room !== 0) return null;
      const p = sim.participants.get(playerId);
      if (!p || p.bot !== null || p.account !== null) return null;
      return sim.carryOf(p);
    },
    ofAccount(accountId) {
      for (const p of sim.participants.values()) if (p.accountId === accountId) return sim.carryOf(p);
      return null;
    },
  };

  // --- A guest plays, walks somewhere, and signs up.
  //
  // Twelve knockouts because twelve is level 2 with two to spare, which is the
  // brief's number and is the one that would catch a carry that rounded to the
  // level rather than carrying the kills: 12 kills at level 2 and 20 kills at
  // level 2 are the same plate and a different amount of progress.
  const guest = sim.join(0, null, 'Dazza');
  const sparring = sim.join(1, null, 'Shazza');
  check(guest.account === null && guest.restored === false, 'a guest joins as a guest, on the spawn disc');
  let scored = 0;
  for (let i = 0; i < 12; i++) {
    if (!knockDown(sim, guest, sparring)) break;
    scored++;
    const out = { tick: 0, events: [], snapshot: null };
    for (let t = 0; t < 400 && sparring.combat.phase === 'ko'; t++) sim.step(out);
  }
  check(scored === 12 && guest.kos === 12, 'the guest scored twelve', `${guest.kos} KOs`);
  check(guest.level === 1, 'and is still level 1, being a guest', `level ${guest.level}`);

  // Newtown-ish: well outside the 100 m spawn disc at the fixture's origin, so
  // "the saved spot" and "the disc" can never be confused for one another.
  const SIGNUP_X = 1200;
  const SIGNUP_Z = -450;
  standAt(sim, guest, SIGNUP_X, SIGNUP_Z, 1.5);

  // The two refusals first, so a pass below cannot be the route carrying
  // everything to everybody.
  {
    const wrongName = await signupOverHttp(accounts, guards, live, {
      handle: 'Ratbag', password: 'hunter2hunter2', guestName: 'SomebodyElse', playerId: guest.id, room: 0,
    });
    const record = accounts.byHandle('Ratbag');
    check(
      wrongName.ok === true && record?.kills === 0 && record?.lastPos === null,
      'a sign-up naming a player it is not carries nothing',
      `${record?.kills} kills, spot ${record?.lastPos === null ? 'none' : 'taken'}`,
    );
    const noId = await signupOverHttp(accounts, guards, live, {
      handle: 'Nointel', password: 'hunter2hunter2', guestName: 'Dazza',
    });
    const anon = accounts.byHandle('Nointel');
    check(
      noId.ok === true && anon?.kills === 0 && anon?.lastPos === null,
      'a sign-up from the landing page, with no session, carries nothing',
      String(noId.message),
    );
  }

  const signed = await signupOverHttp(accounts, guards, live, {
    handle: 'Dazza', password: 'hunter2hunter2', guestName: 'Dazza', playerId: guest.id, room: 0,
  });
  const record = accounts.byHandle('Dazza');
  if (!record) {
    check(false, 'the account exists after signing up mid-session');
    return;
  }
  check(record.kills === 12, 'the sign-up carried the kills', `${record.kills}`);
  check(record.level === 2, 'and the level with them', `level ${record.level}`);
  check(record.levelWeek === weekOf(), 'stamped into this week', record.levelWeek);
  check(
    record.lastPos !== null &&
      Math.abs(record.lastPos.x - SIGNUP_X) < 0.01 &&
      Math.abs(record.lastPos.z - SIGNUP_Z) < 0.01,
    'and the spot came too',
    JSON.stringify(record.lastPos),
  );
  check(
    record.lastPos !== null && Math.abs(record.lastPos.y - 0) < 0.01,
    'saved as a **feet** height, not the eye',
    `y ${record.lastPos?.y} (the eye was ${EYE_HEIGHT})`,
  );
  check(
    /level 2/.test(String(signed.message)) && /spot/.test(String(signed.message)),
    'and the response says what came with them',
    String(signed.message),
  );
  const carried = signed.carried as { kills?: number; level?: number; spot?: boolean } | undefined;
  check(
    carried?.kills === 12 && carried.level === 2 && carried.spot === true,
    'as three fields as well as a sentence, so the client need not read English',
    JSON.stringify(carried),
  );

  // --- Logging off somewhere else moves the spot, and it reaches the disk.
  const LEAVE_X = 2500;
  const LEAVE_Z = 900;
  {
    const back = sim.join(2, null, record.handle, record);
    check(back.accountId === record.id, 'the account rejoins as itself');
    standAt(sim, back, LEAVE_X, LEAVE_Z, 2.5);
    sim.leave(back.id);
    check(
      record.lastPos !== null && Math.abs(record.lastPos.x - LEAVE_X) < 0.01 && Math.abs(record.lastPos.z - LEAVE_Z) < 0.01,
      'the disconnect saved the new spot',
      JSON.stringify(record.lastPos),
    );
    // Out of the room properly, or the next join is two bodies on one account
    // and `ofAccount` answers with whichever the map iterates first.
    const out = { tick: 0, events: [], snapshot: null };
    sim.step(out);
    await accounts.close();
    const onDisk = (await Bun.file(accountPath).json()) as {
      accounts: Record<string, { lastPos?: { x: number; z: number; savedMs: number } | null }>;
    };
    // By the key the store files rows under, which is `handleKey(handle)` -- not
    // by scanning for the first row that has a spot. The two other accounts this
    // phase created carry `lastPos: null`, and a scan would have found one of
    // them and asserted against nothing.
    const row = onDisk.accounts.dazza;
    check(
      row?.lastPos != null && Math.abs(row.lastPos.x - LEAVE_X) < 0.01 && Math.abs(row.lastPos.z - LEAVE_Z) < 0.01,
      'and it is on disk, not only in memory',
      JSON.stringify(row?.lastPos),
    );
  }

  // --- Rejoining puts the body back there, and says so on the welcome.
  {
    const reloaded = new AccountStore(accountPath);
    await reloaded.load();
    const fresh = reloaded.byHandle('Dazza');
    if (!fresh) {
      check(false, 'the account survived the restart');
      return;
    }
    check(fresh.lastPos !== null, 'the spot survived the restart too', JSON.stringify(fresh.lastPos));
    const back = new Simulation(world, { accounts: reloaded });
    const p = back.join(0, null, fresh.handle, fresh);
    const gap = Math.hypot(p.combat.body.position.x - LEAVE_X, p.combat.body.position.z - LEAVE_Z);
    check(gap < 0.5, 'a rejoin spawns on the saved spot', `${gap.toFixed(3)} m away`);
    check(p.restored === true, 'and the participant is marked restored');
    check(
      Math.abs(p.combat.body.position.y - (0 + EYE_HEIGHT)) < 0.01,
      'at eye height over today\'s ground, not the stored feet height',
      `y ${p.combat.body.position.y.toFixed(3)}`,
    );
    check(p.walletNote === '', 'and nothing apologetic in the pill', JSON.stringify(p.walletNote));
    // And the bit reaches the wire, which is the only way the client can say
    // "back where you left off" -- see `game/carry.ts`.
    const welcome = decodeWelcome(
      encodeWelcome({
        version: PROTOCOL_VERSION, id: p.id, colourway: p.colourway, snapshotHz: SNAPSHOT_HZ, room: 0,
        tick: back.tick, x: p.combat.body.position.x, y: p.combat.body.position.y, z: p.combat.body.position.z,
        yaw: p.combat.body.yaw, clockMs: Date.now(), restored: p.restored,
      }),
    );
    check(welcome?.restored === true, 'the WELCOME carries the restore flag');
    check(
      welcome !== null && Math.hypot(welcome.x - LEAVE_X, welcome.z - LEAVE_Z) < 0.5,
      'and the position the client will place the body at is the saved one',
      `(${welcome?.x.toFixed(2)}, ${welcome?.z.toFixed(2)})`,
    );
    back.leave(p.id);
    await reloaded.close();
  }

  // --- A spot from last week is not this week's spot.
  {
    const raw = (await Bun.file(accountPath).json()) as {
      accounts: Record<string, { lastPos?: { savedMs: number } }>;
    };
    for (const a of Object.values(raw.accounts)) {
      if (a.lastPos) a.lastPos.savedMs -= 8 * 24 * 3600 * 1000;
    }
    await Bun.write(accountPath, JSON.stringify(raw));
    const lastWeek = new AccountStore(accountPath);
    await lastWeek.load();
    const aged = lastWeek.byHandle('Dazza');
    check(aged?.lastPos === null, 'a spot saved last week is dropped by the parser', JSON.stringify(aged?.lastPos));
    const back = new Simulation(world, { accounts: lastWeek });
    const p = back.join(0, null, aged!.handle, aged!);
    const gap = Math.hypot(p.combat.body.position.x - LEAVE_X, p.combat.body.position.z - LEAVE_Z);
    check(gap > 100, 'and the rejoin lands on the spawn disc instead', `${gap.toFixed(0)} m from last week's spot`);
    check(p.restored === false, 'not marked restored');
    // Nothing apologetic either: a spot that expired on schedule is not a spot
    // that was lost, and a weekly reset already says "everyone is level 1 again".
    check(p.walletNote === '', 'and says nothing, because nothing went wrong', JSON.stringify(p.walletNote));
    back.leave(p.id);
    await lastWeek.close();
  }

  // --- A building where you left is a spot you cannot have back.
  {
    const store = new AccountStore(`${accountPath}.blocked`);
    await store.load();
    const made = await store.signup('Bluey', 'hunter2hunter2', '', null);
    const rec = store.byHandle('Bluey');
    if (!made.ok || !rec) {
      check(false, 'the blocked-spot fixture signed up');
      return;
    }
    // Saved honestly, through the same call a disconnect uses, and then a
    // warehouse is built on top of it.
    check(
      store.rememberSpot(rec, { name: 'Bluey', kills: 0, x: LEAVE_X, y: 0, z: LEAVE_Z, yaw: 0 }),
      'the blocked fixture saved a spot first',
    );
    buildingAt(world, 'carry-check-warehouse', LEAVE_X, LEAVE_Z);
    const back = new Simulation(world, { accounts: store });
    const p = back.join(0, null, rec.handle, rec);
    const gap = Math.hypot(p.combat.body.position.x - LEAVE_X, p.combat.body.position.z - LEAVE_Z);
    check(gap > 100, 'a spot with a building on it falls back to the spawn disc', `${gap.toFixed(0)} m away`);
    check(p.restored === false, 'and is not marked restored');
    check(/your spot was gone/.test(p.walletNote), 'and the player is told why', JSON.stringify(p.walletNote));
    check(rec.lastPos === null, 'and the dead spot is forgotten, not retried every join');
    // Twice, to prove the forgetting: the second join is an ordinary one.
    back.leave(p.id);
    const again = back.join(1, null, rec.handle, rec);
    check(again.walletNote === '', 'a second join says nothing, having already forgotten it', JSON.stringify(again.walletNote));
    await store.close();
    await Bun.$`rm -f ${accountPath}.blocked`.quiet().nothrow();
  }

  await Bun.$`rm -f ${accountPath}`.quiet().nothrow();
}

// --- Phase B: the routes and the wire -------------------------------------------

interface JoinResult {
  names: string[];
  levels: number[];
  bye: string;
  ack: { result: number; message: string } | null;
  /**
   * The join reply itself, for workstream N: the id (so a sign-up can name this
   * participant), the room, the spawn, and whether it was restored.
   */
  welcome: { id: number; room: number; x: number; z: number; restored: boolean } | null;
}

/**
 * Open a socket, say hello, optionally file a suggestion, and report what came
 * back.
 *
 * Deliberately a raw `WebSocket` and the real encoders rather than a
 * `NetClient`: what is being tested is the *server's* reading of a hello, and a
 * client that composed the frame the same way the server expects it would test
 * the two agreeing with themselves.
 */
function join(url: string, name: string, token: string, suggest = false): Promise<JoinResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
    ws.binaryType = 'arraybuffer';
    const out: JoinResult = { names: [], levels: [], bye: '', ack: null, welcome: null };
    ws.onopen = () => {
      ws.send(encodeHello(255, name, token));
      if (suggest) {
        setTimeout(() => {
          try {
            ws.send(
              encodeSuggestSubmit(
                MSG.SUGGEST,
                '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
                `a check ran at ${Date.now()}`,
                'filed by server/accounts-check.ts',
              ),
            );
          } catch {
            /* the socket went away; the assertion below reports it */
          }
        }, 400);
      }
    };
    ws.onmessage = (e) => {
      const frame = e.data as ArrayBuffer;
      const type = frameType(frame);
      if (type === MSG.WELCOME) {
        const w = decodeWelcome(frame);
        if (w) out.welcome = { id: w.id, room: w.room, x: w.x, z: w.z, restored: w.restored };
      } else if (type === MSG.ROSTER) {
        for (const r of decodeRoster(frame) ?? []) {
          out.names.push(r.name);
          out.levels.push(r.level);
        }
      } else if (type === MSG.BYE) {
        out.bye = decodeBye(frame) ?? '';
      } else if (type === MSG.SUGGEST_ACK) {
        const ack = decodeSuggestAck(frame, MSG.SUGGEST_ACK);
        if (ack) out.ack = { result: ack.result, message: ack.message };
      }
    };
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(out);
    }, 1600);
  });
}

/**
 * Join, wait for the welcome, do something **while still connected**, then leave.
 *
 * `join` above closes on a timer and reports what came back, which is the right
 * shape for every check that was here before this one. Workstream N needs the
 * other shape: a sign-up is an HTTP request made *by a player who is standing in
 * the world*, and the whole of what is being tested is the server finding that
 * body -- so the socket has to still be open when the request lands.
 *
 * Resolves with the welcome, so the caller knows which participant it was.
 */
function joinAndHold(
  url: string,
  name: string,
  token: string,
  during: (welcome: NonNullable<JoinResult['welcome']>) => Promise<void>,
): Promise<JoinResult['welcome']> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${url.replace(/^http/, 'ws')}/ws`);
    ws.binaryType = 'arraybuffer';
    let seen: JoinResult['welcome'] = null;
    let ran = false;
    const finish = (): void => {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
      resolve(seen);
    };
    ws.onmessage = (e) => {
      if (ran) return;
      const frame = e.data as ArrayBuffer;
      if (frameType(frame) !== MSG.WELCOME) return;
      const w = decodeWelcome(frame);
      if (!w) return;
      ran = true;
      seen = { id: w.id, room: w.room, x: w.x, z: w.z, restored: w.restored };
      void during(seen).then(finish, finish);
    };
    ws.onopen = () => ws.send(encodeHello(255, name, token));
    // A deadline, because a server that never welcomes would otherwise hang the
    // whole check rather than failing it.
    setTimeout(() => {
      if (!ran) finish();
    }, 4000);
  });
}

async function phaseB(url: string): Promise<void> {
  console.log(`\n--- phase B: the routes and the wire, against ${url} ---`);
  const json = async (path: string, init?: RequestInit): Promise<Record<string, unknown>> =>
    (await (await fetch(`${url}${path}`, init)).json()) as Record<string, unknown>;
  const post = (path: string, body: unknown, token = ''): Promise<Record<string, unknown>> =>
    json(path, {
      method: 'POST',
      headers: token
        ? { 'content-type': 'application/json', authorization: `Bearer ${token}` }
        : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // A fresh handle each run, so the check is repeatable against a live box.
  const handle = `Chk${Math.floor(Math.random() * 90000 + 10000)}`;

  const free = await json(`/auth/check?handle=${handle}`);
  check(free.available === true, 'an unused handle is available', JSON.stringify(free));

  const signed = await post('/auth/signup', { handle, password: 'hunter2hunter2' });
  check(signed.ok === true && typeof signed.token === 'string', 'signup', String(signed.message));
  const token = String(signed.token);

  const taken = await json(`/auth/check?handle=%20${handle.toLowerCase()}%20`);
  check(taken.available === false && taken.reason === 'taken by an account', 'the handle is now taken, folded', JSON.stringify(taken));

  const dup = await post('/auth/signup', { handle: handle.toUpperCase(), password: 'hunter2hunter2' });
  check(dup.ok === false, 'a duplicate handle is refused', String(dup.message));

  const short = await post('/auth/signup', { handle: `${handle}b`, password: 'abc' });
  check(short.ok === false && /8 characters/.test(String(short.message)), 'a short password is refused', String(short.message));

  const wrong = await post('/auth/login', { handle, password: 'not the password' });
  check(wrong.ok === false, 'a wrong password is refused', String(wrong.message));

  const me = await json('/auth/me', { headers: { authorization: `Bearer ${token}` } });
  check(me.ok === true, '/auth/me resolves the token', JSON.stringify(me.account));
  check(!JSON.stringify(me).includes('argon2') && !JSON.stringify(me).includes('passwordHash'), 'no hash on any response');

  const anon = await json('/auth/me');
  check(anon.ok === false, '/auth/me without a token is nobody');

  // --- The wire. A token names the participant; the name beside it is ignored.
  const authed = await join(url, 'NotMyHandle', token);
  check(authed.names.includes(handle), 'a token names the participant', authed.names.join(', '));
  check(!authed.names.includes('NotMyHandle'), 'and the name it was sent with is ignored');
  check(authed.levels.length > 0, 'the roster carries a level', authed.levels.join(', '));

  const impostor = await join(url, handle, '');
  check(/belongs to an account/.test(impostor.bye), 'a guest wearing a registered handle is refused', JSON.stringify(impostor.bye));

  const guest = await join(url, 'Davo', '');
  check(guest.bye === '' && guest.names.includes('Davo'), 'a guest still joins', guest.names.join(', '));

  // --- The feedback gate, over the socket.
  const guestSuggest = await join(url, 'Davo', '', true);
  check(
    guestSuggest.ack?.result === SUGGEST_RESULT.ACCOUNT && /sign up to send feedback/.test(guestSuggest.ack.message),
    "a guest's suggestion is refused with the sign-up message",
    JSON.stringify(guestSuggest.ack),
  );
  const accountSuggest = await join(url, '', token, true);
  check(
    accountSuggest.ack !== null && accountSuggest.ack.result !== SUGGEST_RESULT.ACCOUNT,
    "an account's suggestion is not refused for want of one",
    JSON.stringify(accountSuggest.ack),
  );

  // --- And the bug box, which is the same gate over HTTP.
  const bugGuest = await post('/bug', { clientId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'a check ran here' });
  check(
    bugGuest.ok === false && /sign up to send feedback/.test(String(bugGuest.message)),
    "a guest's bug report is refused",
    String(bugGuest.message),
  );
  const bugAccount = await post(
    '/bug',
    { clientId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301', title: 'a check ran here, with an account' },
    token,
  );
  check(
    !/sign up to send feedback/.test(String(bugAccount.message)),
    "an account's bug report gets past the gate",
    String(bugAccount.message),
  );

  /*
   * --- Workstream N, against the real world.
   *
   * Phase C proves the rules in an empty city. This proves the same journey over
   * a socket, through the routes, against **Sydney** -- which is the one thing a
   * fixture cannot check: that a spot the spawn disc handed out is a spot
   * `game/spawn.restoreSpawnPoint` will hand back. The disc is in Sydney Park,
   * so this is a real point on real terrain with the real prisms loaded, and a
   * restore that refused it would mean the two functions disagree about ground
   * that neither of them invented.
   *
   * A guest joins, signs up **while standing there**, and comes back with the
   * token. Nothing walks anywhere: the position the server chose at the join is
   * the position under test, which is enough and needs no input frames.
   */
  const carryHandle = `Cry${Math.floor(Math.random() * 90000 + 10000)}`;
  const guestName = `Gst${Math.floor(Math.random() * 90000 + 10000)}`;
  let carryToken = '';
  let stood: { x: number; z: number } | null = null;
  const spawnWelcome = await joinAndHold(url, guestName, '', async (welcome) => {
    check(welcome.restored === false, 'a guest is never restored', JSON.stringify(welcome));
    stood = { x: welcome.x, z: welcome.z };
    const out = await post('/auth/signup', {
      handle: carryHandle,
      password: 'hunter2hunter2',
      guestName,
      playerId: welcome.id,
      room: welcome.room,
    });
    check(out.ok === true, 'a mid-session sign-up succeeds', String(out.message));
    carryToken = typeof out.token === 'string' ? out.token : '';
    const carried = out.carried as { spot?: boolean } | undefined;
    check(carried?.spot === true, 'and it carried the spot the player was standing on', JSON.stringify(carried));
  });
  check(spawnWelcome !== null, 'the guest got a welcome to sign up from');

  if (carryToken !== '' && stood !== null) {
    // The socket above has closed by now, which is itself the disconnect path:
    // that participant was a guest, so nothing was saved on the way out and the
    // only spot on the record is the one the sign-up carried.
    const returning = await joinAndHold(url, '', carryToken, async () => {});
    const away = returning === null
      ? Infinity
      : Math.hypot(returning.x - (stood as { x: number; z: number }).x, returning.z - (stood as { x: number; z: number }).z);
    check(away < 0.5, 'coming back with the token spawns on that spot', `${away.toFixed(3)} m away`);
    check(returning?.restored === true, 'and the welcome says it was restored');

    // Logging out saves where the account is standing **now**, which on this
    // path is the same spot -- so what is actually being asserted is that the
    // route reached a live body at all and did not clear anything.
    await fetch(`${url}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${carryToken}` } });
    const gone = await json('/auth/me', { headers: { authorization: `Bearer ${carryToken}` } });
    check(gone.ok === false, 'and that token is dead after logging out');
  }

  // --- Logging out stops the token working, on the server and not only here.
  await fetch(`${url}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const dead = await json('/auth/me', { headers: { authorization: `Bearer ${token}` } });
  check(dead.ok === false, 'a logged-out token is dead');
}

// --- Run --------------------------------------------------------------------------

await phaseA();
await phaseC();
const url = process.env.SYDNEY_CHECK_URL ?? '';
if (url === '') {
  console.log('\n--- phase B skipped: set SYDNEY_CHECK_URL to a running server to include it ---');
} else {
  await phaseB(url.replace(/\/+$/, ''));
}

console.log(`\n${failures.length === 0 ? 'accounts-check: everything passed' : `accounts-check: ${failures.length} failure(s)`}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
