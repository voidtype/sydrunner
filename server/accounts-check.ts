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
 *   - the feedback gate refusing a guest's `SUGGEST` and admitting an account's.
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
  decodeBye,
  decodeRoster,
  encodeHello,
  encodeRoster,
  frameType,
} from '../client/src/net/protocol.ts';
import {
  SUGGEST_RESULT,
  decodeSuggestAck,
  encodeSuggestSubmit,
} from '../client/src/net/suggestions.ts';
import { weekOf } from '../client/src/net/accounts.ts';
import { AccountStore } from './accounts.ts';
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

// --- Phase B: the routes and the wire -------------------------------------------

interface JoinResult {
  names: string[];
  levels: number[];
  bye: string;
  ack: { result: number; message: string } | null;
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
    const out: JoinResult = { names: [], levels: [], bye: '', ack: null };
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
      if (type === MSG.ROSTER) {
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

  // --- Logging out stops the token working, on the server and not only here.
  await fetch(`${url}/auth/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  const dead = await json('/auth/me', { headers: { authorization: `Bearer ${token}` } });
  check(dead.ok === false, 'a logged-out token is dead');
}

// --- Run --------------------------------------------------------------------------

await phaseA();
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
