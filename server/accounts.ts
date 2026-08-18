/**
 * The account store, and the four HTTP routes in front of it.
 *
 * `server/wallets.ts` is the file this one was grown from, and it is worth
 * saying which parts were copied deliberately rather than by habit: the
 * **atomic temp-file-and-rename** write, the **debounce**, the **move a broken
 * file aside rather than refusing to boot**, and the **re-derive every field off
 * disk** parser. All four exist because the state here is the same shape of
 * thing -- a few hundred rows, read once at boot, written a few times a minute,
 * on a box with one vCPU and no database -- and because that file already argued
 * every one of them out. Where this differs from wallets, it says so.
 *
 * The rules themselves are not here. `client/src/net/accounts.ts` holds the
 * handle fold, the level arithmetic, the week reset and the record parser,
 * because both runtimes need to agree about all four and this file cannot be
 * imported into a browser -- it touches `Bun.password`, `Bun.file` and the
 * filesystem. This is `wallet-contract.ts`'s split, and `verifyAccounts` is
 * re-exported at the bottom for the same reason that file re-exports its
 * interface: `server/index.ts` should not have to reach across the tree for a
 * check about a store it owns.
 *
 * ---------------------------------------------------------------------------
 * **WHAT THIS IS AND IS NOT DEFENDING**
 *
 * `wallets.ts` has a paragraph in capitals saying a name is a claim and not
 * proof. This one earns a smaller claim: a **handle is proof, and nothing else
 * here is.** Concretely --
 *
 *   - The password is argon2id via `Bun.password`, with the library's own
 *     parameters. Nothing in this file ever sees a plaintext password after the
 *     `await`, ever writes one to a log, and ever compares a hash by hand.
 *   - A token is 32 bytes of `crypto.getRandomValues`, which is 256 bits of
 *     entropy against a route that answers ten times a minute per address. It
 *     is a bearer credential in `localStorage` and it is exactly as strong as
 *     that implies: anybody who can run script on the page has it. That is
 *     acceptable *because of what is behind it* -- a level, a play-money
 *     balance, and the ability to file a suggestion.
 *   - There is **no email, no recovery and no reset**. A forgotten password is
 *     a lost account, and the sign-up form says so before it is submitted. This
 *     is not an oversight to be fixed later with a mail server; it is the
 *     reason there is no personal data on this box to lose.
 *   - Handle enumeration is **deliberate**. `/auth/check` exists to tell a guest
 *     at the landing page that a handle is registered, because the alternative
 *     is being refused with a `BYE` after the world has loaded. Any design where
 *     handles are globally unique and checkable at landing publishes the set of
 *     registered handles, and pretending otherwise would be a login route that
 *     lies about which half of the pair was wrong while the route next door
 *     answers honestly.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ROUTES ARE HTTP AND NOT MESSAGES
 *
 * Every other feature added to this server since v9 rides the socket. This one
 * does not, and the brief is explicit about it: *"HTTP only; simpler and it
 * works before the socket exists."* The join flow is the argument. A player logs
 * in **at the landing screen**, before a `NetClient` has been constructed, and a
 * socket-borne login would mean connecting as a guest, authenticating, and then
 * changing the participant's identity mid-session -- a rename, a wallet swap and
 * a roster rewrite, all on a live body. Logging in first and putting the token
 * on the `HELLO` makes the participant right on the tick it is created.
 *
 * It also means `maxPayloadLength: 1024` stays where it is, and that the auth
 * conversation cannot be reached at all by anybody who has not loaded the page.
 */

import {
  AUTH_PER_MIN,
  CHECK_PER_MIN,
  MAX_TOKENS_PER_ACCOUNT,
  TOKEN_TTL_MS,
  type AccountFile,
  type AccountRecord,
  type AccountView,
  type HandleCheck,
  type LastPos,
  carriedLine,
  handleKey,
  lastPosThisWeek,
  levelFor,
  passwordRefusal,
  resetIfNewWeek,
  sanitiseAccount,
  sanitiseHandle,
  sanitiseLastPos,
  tokenLive,
  tokenShaped,
  weekOf,
} from '../client/src/net/accounts.ts';
import { EMPTY_MASK, TEAM, type TalentMask, type Team } from '../client/src/game/teams.ts';
import { FloodGuard } from './suggestions.ts';
import { type WalletStore } from './wallets.ts';

/** Where the file lives. `SYDNEY_STATE_DIR` moves it, beside `wallets.json`. */
export function defaultAccountPath(): string {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  return `${dir.replace(/\/+$/, '')}/accounts.json`;
}

/**
 * One write every this many milliseconds, at most.
 *
 * Two seconds rather than the wallets' five, and the difference is what is being
 * risked. A wallet write that is lost costs a fare; an *account* write that is
 * lost can cost the sign-up itself -- a player who registers, is handed a token,
 * and finds after a crash that the handle was never written would be logged in
 * to an account that does not exist. Sign-up and login therefore also call
 * `save()` directly rather than waiting for the timer (see `signup`), and this
 * debounce only ever covers the cheap mutations: kills, levels and `lastSeenMs`.
 */
export const ACCOUNT_SAVE_DEBOUNCE_MS = 2000;

/**
 * How long an untouched account is kept. A year.
 *
 * Far longer than the wallets' ninety days, and for a reason that file states
 * from the other side: a wallet is a name and a number, and a name nobody has
 * used in three months is a name nobody is coming back to. An **account** is a
 * handle somebody chose and a level they earned, and reclaiming it hands their
 * identity to the next person who types it. A year is long enough that anybody
 * who comes back within a plausible "I played that last summer" still has their
 * handle, and short enough that the file does not accumulate forever.
 */
export const ACCOUNT_TTL_MS = 365 * 24 * 3600 * 1000;

/** What a route hands back. `token` is empty on every failure. */
export interface AuthOutcome {
  ok: boolean;
  status: number;
  /** A sentence for the player. Never mentions hashes, files or the store. */
  message: string;
  token: string;
  account: AccountView | null;
  /**
   * What came across from the guest session, on sign-up. Zeroed everywhere else.
   *
   * On the outcome rather than only in `message` because the client shows the
   * sentence *and* has to decide what to do next, and parsing a sentence to find
   * out whether a spot carried would be an English-language wire format. See
   * `carriedLine`, which composes the sentence from these same three fields.
   */
  carried: CarriedProgress;
}

/** The three things a sign-up can bring across from a guest session. */
export interface CarriedProgress {
  kills: number;
  level: number;
  /** Whether the guest's current position was saved onto the new account. */
  spot: boolean;
}

const CARRIED_NOTHING: CarriedProgress = { kills: 0, level: 1, spot: false };

/**
 * A live guest, as the sign-up route needs them. Filled in by `server/index.ts`.
 *
 * This file cannot see a `Participant` and must not learn to: `server/sim.ts`
 * imports three.js-free game modules and a `CollisionWorld`, and an
 * `AccountStore` that imported the simulation would be an HTTP route that could
 * not be constructed without a world. So the socket layer -- which owns both --
 * flattens a participant into these six numbers and hands them over, which is
 * exactly the shape `Simulation.join` already takes an `AccountRecord` in.
 *
 * `y` is the **feet** height and the position is the one a body would be dropped
 * at: a player who is aboard a train or driving when this is taken has already
 * been projected onto the ground beneath them by `Simulation.carryOf`. Riding
 * state is deliberately not part of this -- see that method.
 */
export interface LiveSpot {
  /** The participant's name as the room assigned it, for the identity check. */
  name: string;
  /** Player knockouts this session. */
  kills: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

/**
 * How this file finds a body. Two questions, both answered by `server/index.ts`.
 *
 * Injected rather than imported for the reason `LiveSpot` gives, and it is
 * nullable for a second one: `AccountStore` is constructed in tests and in
 * `server/accounts-check.ts` phase A with no host at all, and every route here
 * has to keep working when the answer to "where is this person standing" is
 * "there is no simulation".
 */
export interface LiveLookup {
  /** The participant at (room, playerId), or null. For the sign-up carry. */
  guest(room: number, playerId: number): LiveSpot | null;
  /** Where the account with this id is standing right now, or null. For logout. */
  ofAccount(accountId: string): LiveSpot | null;
}

export class AccountStore {
  readonly path: string;
  private file: AccountFile = { version: 1, accounts: {} };
  /**
   * Token to account, rebuilt from the records at load and maintained on every
   * mint and revoke.
   *
   * An index rather than a scan, because this is on the **join path**: every
   * `HELLO` that carries a token does one lookup, and a scan would be O(accounts)
   * per join on a box that is meant to be O(players) per tick. The two are kept
   * in step in exactly three places -- `load`, `mint` and `revoke` -- and
   * `verifyAccounts` cannot check that, which is why there are only three.
   */
  private readonly tokenIndex = new Map<string, AccountRecord>();
  private readonly idIndex = new Map<string, AccountRecord>();
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private swept = 0;
  private loaded = false;

  constructor(path: string = defaultAccountPath()) {
    this.path = path;
  }

  /**
   * Read the file, or start empty. A file that will not parse is **moved aside**.
   *
   * `WalletStore.load`'s call, made here for a stronger version of the same
   * reason: the balances are the only copy of something players accumulated, and
   * the accounts are the only copy of who they *are*. A server that refuses to
   * boot on a truncated JSON is a server that is down until somebody notices, and
   * one that deletes the file is a server that has taken everybody's handle.
   */
  async load(): Promise<void> {
    this.loaded = true;
    try {
      const f = Bun.file(this.path);
      if (!(await f.exists())) return;
      const raw = (await f.json()) as AccountFile;
      if (!raw || typeof raw !== 'object' || typeof raw.accounts !== 'object' || raw.accounts === null) {
        throw new Error('not an account file');
      }
      const now = Date.now();
      const accounts: Record<string, AccountRecord> = {};
      for (const value of Object.values(raw.accounts)) {
        const record = sanitiseAccount(value, now);
        if (record === null) {
          this.swept++;
          continue;
        }
        if (record.lastSeenMs > 0 && now - record.lastSeenMs > ACCOUNT_TTL_MS) {
          this.swept++;
          continue;
        }
        // **Filed under the key this process derived**, not under the key the
        // file used. A hand-edited file whose object key disagrees with its
        // record's handle would otherwise be an account that `check` says is
        // free and `signup` then collides with.
        if (accounts[record.handleKey] !== undefined) {
          // Two rows folding to one handle: keep the one seen most recently and
          // drop the other, rather than throwing. Refusing to boot over a
          // duplicate that a fold introduced would take the whole game down for
          // one row.
          const held = accounts[record.handleKey];
          if (held.lastSeenMs >= record.lastSeenMs) {
            this.swept++;
            continue;
          }
          this.swept++;
        }
        accounts[record.handleKey] = record;
      }
      this.file = { version: 1, accounts };
      for (const record of Object.values(accounts)) this.index(record);
      if (this.swept > 0) this.dirty = true;
    } catch (err) {
      const aside = `${this.path}.broken-${Date.now()}`;
      try {
        await Bun.write(aside, Bun.file(this.path));
      } catch {
        // Nothing further to try; the message below is the record.
      }
      console.error(`[sydney] accounts: ${this.path} would not parse (${String(err)}); moved to ${aside}`);
      this.file = { version: 1, accounts: {} };
    }
  }

  private index(record: AccountRecord): void {
    this.idIndex.set(record.id, record);
    for (const t of record.tokens) this.tokenIndex.set(t.token, record);
  }

  /** How many accounts exist. The boot line and `/health`. */
  get size(): number {
    return Object.keys(this.file.accounts).length;
  }

  describe(): string {
    if (!this.loaded) return `${this.path} (not loaded)`;
    const swept = this.swept > 0 ? `, ${this.swept} dropped` : '';
    return `${this.size} account(s)${swept} in ${this.path}`;
  }

  /** The record for a handle, however it was typed, or null. */
  byHandle(raw: string): AccountRecord | null {
    return this.file.accounts[handleKey(raw)] ?? null;
  }

  /** Is this handle spoken for? The **only** question a guest's name is asked. */
  registered(raw: string): boolean {
    return this.byHandle(raw) !== null;
  }

  byId(id: string): AccountRecord | null {
    return this.idIndex.get(id) ?? null;
  }

  /**
   * The account a bearer token names, or null.
   *
   * Rolled into the current week on the way out, so **every** door into an
   * account applies the reset -- see `resetIfNewWeek`, which is deliberately
   * called from more places than strictly necessary.
   */
  byToken(raw: string, now = Date.now()): AccountRecord | null {
    if (!tokenShaped(raw)) return null;
    const record = this.tokenIndex.get(raw);
    if (!record) return null;
    const live = record.tokens.find((t) => t.token === raw);
    if (!live || !tokenLive(live, now)) {
      // Expired between two requests. Dropped here rather than left for a sweep,
      // because this is the only code path that will ever look at it again.
      this.revoke(raw);
      return null;
    }
    if (resetIfNewWeek(record, now)) this.touch();
    return record;
  }

  /** `GET /auth/check`. Says *why* when the answer is no; see `HandleCheck`. */
  check(raw: string): HandleCheck {
    const handle = sanitiseHandle(raw);
    if (handle === '') {
      return { available: false, reason: 'two to sixteen characters', handle: '' };
    }
    if (this.registered(handle)) {
      return { available: false, reason: 'taken by an account', handle };
    }
    return { available: true, reason: '', handle };
  }

  /**
   * Register. The one route that creates state and the one that migrates money.
   *
   * `guestName` is what the player was playing as before they signed up, and it
   * is what "would you like to save progress?" actually means: their guest
   * wallet is keyed by that name (see `wallets.walletKey`) and this moves the
   * balance onto the account's key.
   *
   * **It is a claim and not proof**, exactly as the guest wallet itself is, and
   * that is the honest position rather than a hole: a wallet keyed by a name can
   * already be spent by anybody who types that name, so being able to *migrate*
   * one by typing the name is not a new capability -- it is the same capability,
   * exercised once, and it ends by making the balance safe from precisely that.
   * `server/wallets.ts`' header is where the underlying decision is argued.
   *
   * Saved synchronously rather than on the debounce. See
   * `ACCOUNT_SAVE_DEBOUNCE_MS`.
   */
  /**
   * ---------------------------------------------------------------------------
   * **AND THE LEVEL AND THE SPOT COME TOO.**
   *
   * *"if i sign up it should automatically transfer my level and location to the
   * new account."* `carry` is that, and it is the guest's live participant --
   * their session knockouts and where their body is standing -- flattened by
   * `server/index.ts` into a `LiveSpot`.
   *
   * **How the participant is found, and why it is stronger than the wallet's
   * rule.** The wallet migrates on the *name in the form*, which the paragraph
   * above defends as a claim that grants no new capability. The kills and the
   * spot could have been done the same way -- find whoever is playing as
   * "Bazza" and take their progress -- and that would have been strictly worse
   * than the wallet case rather than equal to it, because it is a capability
   * that did not previously exist: typing somebody else's name would *take their
   * position and their score* rather than a balance they could already spend.
   *
   * So the client sends the `playerId` and `room` its own `WELCOME` gave it, and
   * `server/index.ts` looks that participant up. The name is then checked
   * against the `guestName` on the form -- folded, so the room's "Bazza (2)"
   * still matches -- and a mismatch carries nothing. That is not proof either
   * (a hand-built client can send any id), but the id is not guessable from
   * outside the room and the check makes the two facts agree, which is as far as
   * this can be taken without a session secret for something worth a level.
   *
   * A carried record is stamped into **this** week (`levelWeek`), because a
   * guest's kills are this session's and a session is inside a week by
   * construction.
   *
   * Saved synchronously rather than on the debounce. See
   * `ACCOUNT_SAVE_DEBOUNCE_MS`.
   */
  async signup(
    rawHandle: string,
    password: string,
    guestName: string,
    wallets: WalletStore | null,
    carry: LiveSpot | null = null,
    now = Date.now(),
  ): Promise<AuthOutcome> {
    const handle = sanitiseHandle(rawHandle);
    if (handle === '') return refuse(400, 'pick a handle of two to sixteen characters');
    const badPassword = passwordRefusal(password);
    if (badPassword !== '') return refuse(400, badPassword);
    if (this.registered(handle)) return refuse(409, 'that handle belongs to an account already');

    // The guest's own numbers, taken **before** the hash's await: the
    // participant can leave during those tens of milliseconds, and a `LiveSpot`
    // is already a copy rather than a live reference for exactly that reason.
    const kills = carry === null ? 0 : Math.max(0, Math.min(1e9, Math.trunc(carry.kills)));
    const spot = carry === null ? null : sanitiseLastPos({ x: carry.x, y: carry.y, z: carry.z, yaw: carry.yaw, savedMs: now });

    const record: AccountRecord = {
      id: crypto.randomUUID(),
      handle,
      handleKey: handleKey(handle),
      passwordHash: await Bun.password.hash(password, 'argon2id'),
      createdMs: now,
      lastSeenMs: now,
      providers: {},
      tokens: [],
      kills,
      level: levelFor(kills),
      levelWeek: weekOf(now),
      lastPos: spot,
      // No side and nothing spent. A guest cannot have chosen -- the choice is
      // gated at level 2 and a guest cannot reach it -- so there is nothing to
      // carry across here the way the kills and the spot are, and a fresh
      // account being asked at its first level 2 is the whole of the feature.
      // See `AccountRecord.team`.
      team: TEAM.NONE,
      talents: { ...EMPTY_MASK },
    };
    // Re-checked **after** the await. Hashing is tens of milliseconds and this
    // process is single-threaded but not single-*task*: two sign-ups for one
    // handle can interleave across the `await` above, and without this the
    // second would overwrite the first -- taking the first player's account
    // with it while telling them both that they own the handle.
    if (this.registered(handle)) return refuse(409, 'that handle belongs to an account already');

    this.file.accounts[record.handleKey] = record;
    this.idIndex.set(record.id, record);
    const token = this.mint(record, now);

    // "Would you like to save progress?" -- answered here, once, at the moment
    // the account comes into existence. Nothing is moved if the guest had no
    // wallet, and nothing is moved twice: the account's wallet is created by
    // this call and never exists beforehand.
    if (wallets !== null && guestName !== '') wallets.migrateToAccount(guestName, record.id, now);

    await this.save();
    const carried: CarriedProgress = { kills: record.kills, level: record.level, spot: record.lastPos !== null };
    // "signed up as Bazza" when nothing came across -- which is the honest
    // sentence for somebody who registered from the landing page before joining
    // -- and "welcome, Bazza — level 2 and your spot came with you" when
    // something did. The second is `carriedLine`'s, in the shared module, so
    // `verifyAccounts` can drive the wording on both ends.
    const message = carried.kills === 0 && !carried.spot
      ? `signed up as ${handle}`
      : carriedLine(handle, carried.kills, carried.level, carried.spot);
    return { ok: true, status: 200, message, token, account: view(record), carried };
  }

  /** Log in. Answers the same sentence for a wrong handle and a wrong password. */
  async login(rawHandle: string, password: string, now = Date.now()): Promise<AuthOutcome> {
    const record = this.byHandle(rawHandle);
    // The message is deliberately identical to the one below it, even though
    // `/auth/check` will happily confirm whether the handle exists. Not because
    // it hides anything -- it does not, see the header -- but because a login
    // form that says "no such handle" invites a second guess at the handle when
    // the actual mistake was the password, which is the mistake people make.
    if (!record || record.passwordHash === '') return refuse(401, 'that handle and password do not match');
    const ok = await Bun.password.verify(password, record.passwordHash);
    if (!ok) return refuse(401, 'that handle and password do not match');
    record.lastSeenMs = now;
    resetIfNewWeek(record, now);
    const token = this.mint(record, now);
    await this.save();
    return {
      ok: true,
      status: 200,
      message: `welcome back, ${record.handle}`,
      token,
      account: view(record),
      carried: CARRIED_NOTHING,
    };
  }

  /**
   * Drop one token. Idempotent: logging out twice is a success both times.
   *
   * **And it saves your spot on the way out**, which is the one thing this route
   * does besides forgetting a string. `spot` is where `server/index.ts` found
   * this account standing, or null when they are not in a room -- logging out
   * from a landing page, from a second tab, or the morning after.
   *
   * Here as well as on the socket close, rather than only on the close, because
   * the two are different moments and a player who logs out *while playing* has
   * said something: the close will fire eventually and would save the same spot,
   * but "eventually" is whenever they shut the tab, and by then they may have
   * spent ten minutes walking somewhere as a guest. The spot that belongs to the
   * account is the one it had when it stopped being logged in.
   */
  logout(token: string, spot: LiveSpot | null = null, now = Date.now()): AuthOutcome {
    if (spot !== null) {
      const record = this.byToken(token, now);
      if (record !== null) this.rememberSpot(record, spot, now);
    }
    this.revoke(token);
    return { ok: true, status: 200, message: 'logged out', token: '', account: null, carried: CARRIED_NOTHING };
  }

  // --- Where you logged off ------------------------------------------------------

  /**
   * Write where this account is standing. Debounced, like the kills.
   *
   * On the cheap side of `ACCOUNT_SAVE_DEBOUNCE_MS`'s split deliberately: a lost
   * spot costs a returning player a walk back to Newtown, and a two-second
   * window on that is a trade the sign-up path was not allowed to make but this
   * one is. The alternative -- an `await this.save()` on every socket close --
   * would be a filesystem write per disconnect on a 1 vCPU box, which is a
   * write per player per reload.
   *
   * The record is re-derived through `sanitiseLastPos` rather than assigned
   * field by field, so the one parser is the only thing that has ever produced a
   * `LastPos`: a NaN yaw off a body that was mid-teleport would otherwise reach
   * the file, and the reader that refuses it is on the *next* boot.
   */
  rememberSpot(record: AccountRecord, spot: LiveSpot, now = Date.now()): boolean {
    // Rolled first, on `creditKill`'s argument exactly: a spot saved at 00:00:01
    // on Monday belongs to the new week, and stamping it before the roll would
    // have `resetIfNewWeek` throw it away a millisecond later.
    if (resetIfNewWeek(record, now)) this.touch();
    const parsed = sanitiseLastPos({ x: spot.x, y: spot.y, z: spot.z, yaw: spot.yaw, savedMs: now });
    if (parsed === null) return false;
    record.lastPos = parsed;
    record.lastSeenMs = now;
    this.touch();
    return true;
  }

  /**
   * Where this account should spawn, or null for the spawn disc.
   *
   * The week rule applied at the **read**, and a stale spot is cleared here
   * rather than left for the parser on the next boot. That is `byToken`'s
   * arrangement with `resetIfNewWeek` and it is deliberate for the same reason:
   * this is the only code path that will ever look at the value again, so
   * leaving it is leaving a row on disk that says something untrue.
   *
   * Whether the spot is still *standable* is not this file's question --
   * `Simulation.join` puts the answer through `game/spawn.restoreSpawnPoint`
   * against the world. See that call.
   */
  spotFor(record: AccountRecord, now = Date.now()): LastPos | null {
    if (resetIfNewWeek(record, now)) this.touch();
    const spot = record.lastPos;
    if (spot === null) return null;
    if (!lastPosThisWeek(spot, now)) {
      record.lastPos = null;
      this.touch();
      return null;
    }
    return spot;
  }

  /** Forget it. For a spot the world refused, so it is not re-tried every join. */
  clearSpot(record: AccountRecord): void {
    if (record.lastPos === null) return;
    record.lastPos = null;
    this.touch();
  }

  /**
   * Mint a token onto a record, evicting the oldest if the cap is reached.
   *
   * One of the three places `tokenIndex` is written. See its comment.
   */
  private mint(record: AccountRecord, now: number): string {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let token = '';
    for (const b of bytes) token += b.toString(16).padStart(2, '0');
    record.tokens.push({ token, issuedMs: now, expiresMs: now + TOKEN_TTL_MS });
    // Dead ones first, then the oldest live one, so a player who logs in from a
    // ninth device does not sign out a device they are actively using before a
    // device they closed a month ago.
    record.tokens = record.tokens.filter((t) => {
      if (tokenLive(t, now)) return true;
      this.tokenIndex.delete(t.token);
      return false;
    });
    while (record.tokens.length > MAX_TOKENS_PER_ACCOUNT) {
      const oldest = record.tokens.shift();
      if (oldest) this.tokenIndex.delete(oldest.token);
    }
    this.tokenIndex.set(token, record);
    this.touch();
    return token;
  }

  private revoke(token: string): void {
    const record = this.tokenIndex.get(token);
    this.tokenIndex.delete(token);
    if (!record) return;
    record.tokens = record.tokens.filter((t) => t.token !== token);
    this.touch();
  }

  /**
   * Credit one player knockout, and say what changed.
   *
   * The whole of the ladder's write path, called from `Simulation.creditKo`. It
   * returns rather than notifies because the caller is the only thing that knows
   * which participant this is and how to tell them -- see `sim.note`.
   *
   * The week is rolled **before** the kill is counted, so the first knockout of
   * a new week is that week's first kill rather than being added to last week's
   * total and then wiped by the next reader.
   */
  creditKill(record: AccountRecord, now = Date.now()): { level: number; levelled: boolean; reset: boolean } {
    const reset = resetIfNewWeek(record, now);
    const before = record.level;
    record.kills++;
    record.level = levelFor(record.kills);
    record.lastSeenMs = now;
    this.touch();
    return { level: record.level, levelled: record.level > before, reset };
  }

  // --- The side, and the points spent on it. Workstream V.

  /**
   * Write a side onto a record, once and never again.
   *
   * **The "once" is enforced here rather than at the call site**, and that is
   * the whole reason this is a method on the store instead of two lines in
   * `Simulation.teamOp`. A team is the only field on an account that is
   * permanent, so the code that refuses to overwrite it has to be the code that
   * owns the file -- a rule kept in the simulation would be a rule that a second
   * caller (a future admin route, a migration, a check) could simply not know
   * about. It returns whether it wrote, so the caller can say the right sentence
   * without asking a second question.
   *
   * Rolled into the week first, on `creditKill`'s argument: a choice made at
   * 00:00:01 on Monday belongs to the new week, and stamping the record after
   * the roll rather than before means the talents that come with the choice are
   * this week's.
   *
   * Debounced, like the kills. A lost write costs a re-choice at the next level
   * 2, which is the same size of loss the ladder already accepts; see
   * `ACCOUNT_SAVE_DEBOUNCE_MS` for why sign-up is the only path that does not.
   */
  chooseTeam(record: AccountRecord, team: Team, now = Date.now()): boolean {
    if (resetIfNewWeek(record, now)) this.touch();
    if (record.team !== TEAM.NONE) return false;
    if (team !== TEAM.MARITA && team !== TEAM.DEFAULT) return false;
    record.team = team;
    // Cleared rather than left, because a record that somehow carried a mask
    // with no side is a record whose points are already spent -- see
    // `sanitiseAccount`, which refuses the same combination off disk.
    record.talents = { ...EMPTY_MASK };
    record.lastSeenMs = now;
    this.touch();
    return true;
  }

  /**
   * Write a new spent-mask onto a record.
   *
   * Deliberately dumb: it does no validation at all, because every rule about
   * what may be spent lives in `game/teams.takeRefusal` and `refundRefusal` and
   * is applied by `Simulation.teamOp` before this is called. A second opinion
   * here would be a second copy of the tier gates, on the file-writing side,
   * where nothing renders when it disagrees.
   *
   * The mask is **copied** rather than aliased. The caller's object is very
   * often the participant's live one, and a record on disk that shares an object
   * with a body in the simulation is a record that changes under the serialiser.
   */
  writeTalents(record: AccountRecord, mask: Readonly<TalentMask>): void {
    record.talents = { lo: mask.lo >>> 0, hi: mask.hi >>> 0 };
    this.touch();
  }

  /** Roll a record into this week and report whether it moved. For the minute check. */
  rollWeek(record: AccountRecord, now = Date.now()): boolean {
    const moved = resetIfNewWeek(record, now);
    if (moved) this.touch();
    return moved;
  }

  /** Stamp a login-free sighting: a token-bearing join. */
  seen(record: AccountRecord, now = Date.now()): void {
    record.lastSeenMs = now;
    this.touch();
  }

  /** Write atomically. See `WalletStore.save`, which this is a copy of. */
  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      await Bun.write(tmp, JSON.stringify(this.file));
      await Bun.$`mv -f ${tmp} ${this.path}`.quiet();
    } catch (err) {
      this.dirty = true;
      console.error(`[sydney] accounts: could not write ${this.path}: ${String(err)}`);
    }
  }

  private touch(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, ACCOUNT_SAVE_DEBOUNCE_MS);
  }

  async close(): Promise<void> {
    await this.save();
  }
}

/** What a client is allowed to know about an account. **Never the hash.** */
export function view(record: AccountRecord): AccountView {
  return { handle: record.handle, level: record.level, kills: record.kills, week: record.levelWeek };
}

function refuse(status: number, message: string): AuthOutcome {
  return { ok: false, status, message, token: '', account: null, carried: CARRIED_NOTHING };
}

// --- The rate limits ---------------------------------------------------------------

/**
 * Two buckets per address and a sweeper, on `BugGuards`' pattern exactly.
 *
 * Two rather than one because the two kinds of request cost three orders of
 * magnitude apart: `/auth/check` is a map lookup fired on every keystroke of the
 * landing field, and `/auth/signup` is an argon2id hash. A single budget tight
 * enough for the second would make the first unusable, and one loose enough for
 * the first would leave the box's only vCPU available to anybody with `curl`.
 *
 * Keyed on `srv.requestIP`, which behind Caddy is Caddy's -- the same honest
 * limitation `server/suggestions.addressOf` and `BugGuards` both state. There is
 * no global ceiling here as there is in the bug box, and that is deliberate: the
 * work a flood buys is CPU rather than a permanent write into a public
 * repository, so the cost of getting the limit slightly wrong is a slow minute
 * rather than something that cannot be un-done.
 */
export class AuthGuards {
  private readonly heavy = new Map<string, { guard: FloodGuard; at: number }>();
  private readonly light = new Map<string, { guard: FloodGuard; at: number }>();
  private static readonly MAX_KEYS = 20_000;
  private static readonly TTL_MS = 3600_000;

  /** Signup and login: `AUTH_PER_MIN` per address. */
  heavyAllow(ip: string, now = Date.now()): boolean {
    this.sweep(now);
    return this.bucket(this.heavy, ip, AUTH_PER_MIN, AUTH_PER_MIN / 60, now).allow(now);
  }

  /** Check and me: `CHECK_PER_MIN` per address. */
  lightAllow(ip: string, now = Date.now()): boolean {
    return this.bucket(this.light, ip, CHECK_PER_MIN, CHECK_PER_MIN / 60, now).allow(now);
  }

  private bucket(
    map: Map<string, { guard: FloodGuard; at: number }>,
    key: string,
    burst: number,
    refill: number,
    now: number,
  ): FloodGuard {
    let found = map.get(key);
    if (!found) {
      // A map at its ceiling stops admitting new keys rather than evicting old
      // ones, verbatim for `BugGuards.bucket`'s reason: the key it would evict
      // is the attacker's from a minute ago.
      if (map.size >= AuthGuards.MAX_KEYS) return new FloodGuard(now, 0, 0);
      found = { guard: new FloodGuard(now, burst, refill), at: now };
      map.set(key, found);
    }
    found.at = now;
    return found.guard;
  }

  private sweep(now: number): void {
    for (const map of [this.heavy, this.light]) {
      if (map.size < 64) continue;
      for (const [key, entry] of map) {
        if (now - entry.at > AuthGuards.TTL_MS) map.delete(key);
      }
    }
  }
}

// --- The routes ---------------------------------------------------------------------

/** The bearer token on a request, or `''`. The one place the header is parsed. */
export function bearerOf(req: Request): string {
  const raw = req.headers.get('authorization') ?? '';
  if (!raw.toLowerCase().startsWith('bearer ')) return '';
  return raw.slice(7).trim();
}

/**
 * `/auth/*`, and the whole of what a client can reach without a socket.
 *
 * Four routes, one shape of answer, and every rejection is a literal in this
 * file. The status codes are for a proxy log; the player reads `message`.
 *
 * The order inside each route is `handleBugRequest`'s: rate limit, then parse,
 * then validate, then the expensive thing. The expensive thing here is argon2id
 * and it is the last line of both paths that reach it.
 */
export async function handleAuthRequest(
  req: Request,
  url: URL,
  ip: string,
  store: AccountStore,
  guards: AuthGuards,
  wallets: WalletStore | null,
  live: LiveLookup | null = null,
  now = Date.now(),
): Promise<Response> {
  if (req.method === 'OPTIONS') return authCors(new Response(null, { status: 204 }));
  const route = url.pathname.slice('/auth/'.length);

  if (route === 'check') {
    if (!guards.lightAllow(ip, now)) return authJson(429, { available: false, reason: 'slow down a moment', handle: '' });
    return authJson(200, store.check(url.searchParams.get('handle') ?? ''));
  }

  if (route === 'me') {
    if (!guards.lightAllow(ip, now)) return authJson(429, { ok: false, message: 'slow down a moment', account: null });
    const record = store.byToken(bearerOf(req), now);
    if (!record) return authJson(200, { ok: false, message: '', account: null });
    return authJson(200, { ok: true, message: '', account: view(record) });
  }

  if (route === 'logout') {
    if (req.method !== 'POST') return authJson(405, { ok: false, message: 'POST to log out', account: null });
    // Deliberately **not** rate limited. Logging out is the one operation here
    // that reduces this process's state, and a player who cannot log out of a
    // shared machine because somebody else on their address was hammering the
    // login form is the worst refusal in the feature.
    //
    // The record is resolved twice on this path -- once here to find the body,
    // once inside `logout` to write to it -- and that is two map lookups on a
    // route nobody calls twice a minute. The alternative is `logout` taking a
    // resolved record, which would put the "is this token even live" test at the
    // call site rather than in the store.
    const token = bearerOf(req);
    let standing: LiveSpot | null = null;
    if (live !== null && token !== '') {
      const record = store.byToken(token, now);
      if (record !== null) standing = live.ofAccount(record.id);
    }
    return outcome(store.logout(token, standing, now));
  }

  if (route === 'signup' || route === 'login') {
    if (req.method !== 'POST') return authJson(405, { ok: false, message: 'POST a handle and a password', account: null });
    if (!guards.heavyAllow(ip, now)) {
      return authJson(429, { ok: false, message: 'too many attempts — give it a minute', account: null });
    }
    let parsed: Record<string, unknown>;
    try {
      // Capped by hand rather than by `readCappedBody`: that function belongs to
      // the bug box and is sized for a four-megabyte screenshot, where this body
      // is two short strings. A `Content-Length` a client sets is not evidence,
      // so the cap is applied to what actually arrived.
      const text = await req.text();
      if (text.length > 4096) throw new Error('too long');
      const raw = JSON.parse(text) as unknown;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      parsed = raw as Record<string, unknown>;
    } catch {
      return authJson(400, { ok: false, message: 'that did not arrive intact', account: null });
    }
    const handle = typeof parsed.handle === 'string' ? parsed.handle : '';
    const password = typeof parsed.password === 'string' ? parsed.password : '';
    if (route === 'login') return outcome(await store.login(handle, password, now));
    const guestName = typeof parsed.guestName === 'string' ? parsed.guestName : '';
    return outcome(await store.signup(handle, password, guestName, wallets, liveGuest(parsed, guestName, live), now));
  }

  return authJson(404, { ok: false, message: 'no such route', account: null });
}

/**
 * The live guest a sign-up body names, if the two facts on it agree. Or null.
 *
 * The identity check `signup`'s header argues for, and it is three lines
 * because it is meant to be readable rather than clever:
 *
 *   1. a `playerId` and a `room` off the form, both parsed as numbers rather
 *      than believed -- `room` defaults to 0, which is the room a bare
 *      `wss://host/ws` lands in and therefore the right default;
 *   2. the participant at that address, or nothing;
 *   3. **the name that participant is actually wearing must fold to the name on
 *      the form.** `handleKey` rather than `===`, because the room may have
 *      deduped "Bazza" into "Bazza (2)" -- no, it may not: `uniqueName` produces
 *      a *different* string, so this compares what the client believes it is
 *      called with what it is called, and a disagreement means the client is
 *      confused or lying. Either way, nothing carries.
 *
 * A guest with no name on the form carries nothing, because there would be
 * nothing to check the participant against -- and that is the same guest whose
 * wallet does not migrate either, one line up in `handleAuthRequest`.
 */
function liveGuest(parsed: Record<string, unknown>, guestName: string, live: LiveLookup | null): LiveSpot | null {
  if (live === null || guestName === '') return null;
  const playerId = Number(parsed.playerId);
  const room = Number(parsed.room);
  if (!Number.isFinite(playerId) || playerId <= 0 || playerId > 65535) return null;
  const found = live.guest(Number.isFinite(room) ? room : 0, Math.trunc(playerId));
  if (found === null) return null;
  if (handleKey(found.name) !== handleKey(guestName)) return null;
  return found;
}

function outcome(out: AuthOutcome): Response {
  return authJson(out.status, {
    ok: out.ok,
    message: out.message,
    token: out.token,
    account: out.account,
    // What actually came across, so the client does not have to read the
    // sentence to find out. See `AuthOutcome.carried`.
    carried: out.carried,
  });
}

function authJson(status: number, body: unknown): Response {
  return authCors(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

/**
 * The CORS headers, for `handleBugRequest`'s reason and one addition.
 *
 * `authorization` is in the allowed-headers list, which the bug route does not
 * need: a bearer header makes even a `GET` a non-simple request, so without this
 * line `/auth/me` would fail its preflight from the vite origin in development
 * and work in production, which is the worst of the two ways round.
 */
function authCors(res: Response): Response {
  res.headers.set('access-control-allow-origin', '*');
  res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.headers.set('access-control-allow-headers', 'content-type, authorization');
  res.headers.set('access-control-max-age', '600');
  return res;
}

// --- The self-check ------------------------------------------------------------------

/**
 * Re-exported rather than re-implemented, exactly as `server/wallet-contract.ts`
 * re-exports its interface and for the same reason: `server/index.ts` should not
 * reach across the tree for a check about a store it owns, and a second
 * `verifyAccounts` on this side would be two checks that agree by inspection.
 */
export { verifyAccounts } from '../client/src/net/accounts.ts';
export { accountWalletKey } from './wallets.ts';
export type { AccountRecord, AccountView, LastPos } from '../client/src/net/accounts.ts';
