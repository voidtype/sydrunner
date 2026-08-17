/**
 * Accounts, handles and levels -- the rules, in the file both ends import.
 *
 * `server/wallets.ts` opens with a paragraph in capitals: **the key is a name,
 * and a name is not authentication.** It then says what would have to change if
 * that ever stopped being good enough -- *"Anything stronger means an account
 * system, which is a different feature in a different pass."* This is that pass,
 * and this file is the half of it that both runtimes need to agree about.
 *
 * The split is `game/wallet-contract.ts`'s exactly, and it is made for the same
 * reason. Everything here is arithmetic and string handling: it has no `Bun`, no
 * filesystem, no `crypto.subtle`, no DOM. `server/accounts.ts` is the store --
 * the file on disk, the password hash, the tokens, the HTTP routes -- and
 * `client/src/accounts.ts` is the browser's side of the same conversation. Both
 * of them import this, and `verifyAccounts` below is run in **both** runtimes at
 * boot, which is the property that makes "one set of rules" true rather than
 * hoped.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ACCOUNT IS FOR, AND WHAT IT IS DELIBERATELY NOT FOR
 *
 * The owner's words: *"make a simple account sign up, but gate only at stuff
 * like sending feedback (cant without account) more than 100 dollars (would u
 * like to save progress)? and level up"*. Three gates and no more. An account is
 * not required to play, is not required to earn, is not required to fight, and
 * nothing behind one is taken from a guest who does not want one. That is a
 * design constraint rather than a phase: the moment signing up is the only way
 * to do something a player was already doing, this stops being "keep your
 * progress" and starts being a wall, and a browser game with a wall in front of
 * it is a browser game nobody plays.
 *
 * So what an account actually buys is **durability of identity**:
 *
 *   - Your **handle is globally unique** and nobody else can wear it. A guest
 *     who types a registered handle is refused at the door -- that is the
 *     "checked at landing" half of the brief, and it is the one thing an account
 *     takes *away* from guests. It has to: a handle that anybody can borrow is a
 *     handle that means nothing, which is `server/wallets.ts`' honest complaint
 *     about names, stated one paragraph after it says accounts would fix it.
 *   - Your **wallet moves off the name key and onto the account id**, so it can
 *     no longer be spent by whoever types your name next.
 *   - Your **level persists** across a restart, which a guest's cannot, because
 *     there is nothing durable to hang it on.
 *
 * ---------------------------------------------------------------------------
 * ROOM FOR SOCIAL
 *
 * `AccountRecord.providers` is an empty object today and is the whole of the
 * provision made for "leave room for social". It is a map from a provider name
 * to that provider's subject id, which is the shape every OAuth/OIDC identity
 * arrives in -- so adding Google is a route that verifies an id token, looks the
 * subject up in this map, and creates or binds an account. Nothing else in this
 * feature has to change: the token this file mints is already the only thing the
 * game reads, and a socially-authenticated account gets one the same way a
 * password-authenticated one does.
 *
 * A field rather than a comment because the alternative is a migration. An
 * account file written for a year without it would need one the day social
 * lands, and `sanitiseAccount` would have to invent the empty case anyway.
 *
 * ---------------------------------------------------------------------------
 * LEVELS, AND WHY THEY RESET
 *
 * *"10 kills levels u up"*, and *"everyone resets to lvl1 on the weekly reset
 * cycle"*. Both are one line of arithmetic (`levelFor`) and one comparison
 * (`weekOf`), and the second one is the interesting half.
 *
 * A ladder that never resets is a ladder where the answer to "what level are
 * you" is "how long have you been playing", which stops being information about
 * a player after the first month and turns the number over somebody's head into
 * a join date. Resetting weekly makes the level a statement about *this week* --
 * the same thing the suggestions box's votes are, which is why this reuses that
 * feature's `weekKey` rather than inventing a second week. There is exactly one
 * Monday in this game and it is Sydney's; see `net/suggestions.weekKey`.
 *
 * The reset is **lazy** rather than scheduled, which is the only version that is
 * correct on a box that was switched off over the weekend: a record carries the
 * week it was last counted in (`levelWeek`), and anything that reads or writes
 * kills checks it first. A cron job would have had to run, and a cron job that
 * did not run leaves a player at level 8 in a week where everybody else is at 1.
 *
 * ---------------------------------------------------------------------------
 * YOUR SPOT, AND WHY IT LIVES AND DIES WITH THE LEVEL
 *
 * *"logging off should save my location till next log in (persisted to end of
 * week)"*. That is `AccountRecord.lastPos`, and the parenthesis is the whole of
 * its lifetime rule: a spot is **this week's spot**, on the same Monday the
 * ladder resets on, and `resetIfNewWeek` clears it in the same three lines that
 * zero the kills.
 *
 * Tying the two together was a decision rather than a convenience. The
 * alternatives were a spot that never expired -- which is a player returning in
 * March to a suburb they were passing through in January, next to nobody, with
 * no memory of why they are there -- and a spot with a lifetime of its own,
 * which is a second calendar to explain and a second one to get wrong. A week is
 * long enough that "log off in Newtown on Tuesday, come back Thursday, still in
 * Newtown" holds, which is the whole of what was asked for, and short enough
 * that the answer to "why am I back at the park?" is the answer everybody
 * already knows: it is a new week and everything reset.
 *
 * The stored `y` is a **feet** height, not the eye, because everything that
 * validates a spot works in feet -- `game/spawn.isSpawnable` takes the number
 * `spawnGround` returns, and the call sites add `EYE_HEIGHT` themselves. Storing
 * the eye would mean every reader had to know which of the two it had.
 *
 * Nothing here decides whether a saved spot is still *standable*. That is
 * `game/spawn.restoreSpawnPoint`, against a world this module cannot see: a
 * building can be built over your spot, a tile can stop being in the build, and
 * a record from a week where the pipeline drew the terrain differently is a
 * record that would drop somebody through the ground. This file owns the week
 * rule and the parser; that one owns the ground.
 */

import { MAX_NAME_CHARS, sanitiseName } from './protocol.ts';
import { weekKey } from './suggestions.ts';

// --- Handles -------------------------------------------------------------------

/**
 * The key a handle is filed under: NFKC-folded, trimmed, whitespace-collapsed,
 * lower-cased.
 *
 * `walletKey` in `server/wallets.ts` does three of those four and this does one
 * more, and the extra one is the whole reason handles can be *unique* where
 * wallet names only had to be *stable*. NFKC folds the compatibility forms --
 * the fullwidth Latin block, the enclosed alphanumerics, the mathematical
 * alphabets -- so `Ｂａｚｚａ` and `𝐁𝐚𝐳𝐳𝐚` and `Bazza` are one handle rather
 * than three accounts a person cannot tell apart in a kill feed. That is an
 * impersonation defence and it is the only one this feature has: everything
 * else about a handle is decoration, and a scoreboard row that looks exactly
 * like somebody else's row is the attack.
 *
 * It is deliberately **not** a full confusables fold. `rn` still looks like `m`
 * in a proportional font and there is no normalisation that fixes that; a table
 * of homoglyphs would be a table to maintain, and the honest position is that
 * this stops the mechanical duplicates and not a determined person with a
 * lookalike. Stated rather than implied, because the next person to touch this
 * will otherwise assume it does more than it does.
 *
 * `toLowerCase` and not `toLocaleLowerCase`, verbatim for `walletKey`'s reason:
 * a Turkish locale lower-cases `I` to a dotless `ı`, and a key that depended on
 * the box's `LANG` would hand somebody else's account to whoever restarted the
 * server after an environment change.
 */
export function handleKey(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/**
 * A handle a player may register, or `''`.
 *
 * `sanitiseName` and nothing more, which is the point: a handle **is** an
 * in-game name -- it is what goes over your head, in the kill feed and on the
 * board -- so a second set of rules here would be a handle that could be
 * registered and then not drawn. The 2-16 cap, the invisible-character strip and
 * the whitespace collapse are all that file's, already asserted by
 * `verifyNames`, and already run on both ends.
 *
 * NFKC first, so the *stored* handle is the folded form rather than only its
 * key. Without that, `Ｂａｚｚａ` would register, be refused a second time as a
 * duplicate of itself, and be drawn in fullwidth glyphs over a body -- three
 * behaviours that disagree about what the handle is.
 */
export function sanitiseHandle(raw: string): string {
  return sanitiseName(raw.normalize('NFKC'));
}

// --- Passwords -----------------------------------------------------------------

/**
 * Eight characters, which is the brief's floor and is deliberately not a
 * composition rule.
 *
 * No "one number and one capital". Those rules are known to produce *worse*
 * passwords -- they push people to `Password1!` -- and the thing actually
 * protecting an account here is that there is nothing behind it but a level and
 * a play-money balance. The length floor exists to stop `1234` and `aaa`, and
 * the ceiling exists because a hash is computed on this server: argon2id over a
 * megabyte of input is a denial of service with a text field in front of it.
 */
export const MIN_PASSWORD_CHARS = 8;
export const MAX_PASSWORD_CHARS = 200;

/** Why this password is refused, or `''` if it is fine. */
export function passwordRefusal(raw: string): string {
  const n = [...raw].length;
  if (n < MIN_PASSWORD_CHARS) return `passwords are at least ${MIN_PASSWORD_CHARS} characters`;
  if (n > MAX_PASSWORD_CHARS) return `that password is too long — ${MAX_PASSWORD_CHARS} characters at most`;
  return '';
}

// --- Tokens --------------------------------------------------------------------

/**
 * Thirty days, per the brief.
 *
 * Long because the failure it trades against is not a stolen token, it is a
 * player who comes back on Saturday and finds themselves logged out and their
 * level gone -- which is the exact experience accounts exist to prevent. What
 * makes thirty days affordable is what is behind the token: no email, no
 * payment, no personal data, and a password that cannot be read back out of the
 * record (see `AccountRecord.passwordHash`).
 */
export const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * How many live tokens one account may hold.
 *
 * A cap rather than one-token-per-account, because a person with a desktop and a
 * phone is the ordinary case and a login that silently signed the other device
 * out would be reported as "it keeps logging me out". Eight is well past that
 * and well short of a record that grows every time somebody clears their cookies
 * -- and the *oldest* is dropped when a ninth is minted, which is the only
 * eviction order that cannot log out the session doing the minting.
 */
export const MAX_TOKENS_PER_ACCOUNT = 8;

/** How long a token is: 32 bytes of `crypto.getRandomValues`, hex. */
export const TOKEN_CHARS = 64;

export interface SessionToken {
  token: string;
  issuedMs: number;
  expiresMs: number;
}

/** Is this a token this build minted, by shape alone? Cheap, and pre-lookup. */
export function tokenShaped(raw: string): boolean {
  return raw.length === TOKEN_CHARS && /^[0-9a-f]+$/.test(raw);
}

/** Is this token still good at `now`? The **only** expiry test in the feature. */
export function tokenLive(t: SessionToken, now: number): boolean {
  return t.expiresMs > now;
}

// --- Levels --------------------------------------------------------------------

/** *"10 kills levels u up"*. */
export const KILLS_PER_LEVEL = 10;

/**
 * The one place the ladder is computed. `1 + floor(kills / 10)`.
 *
 * Level 1 at zero kills rather than level 0, because the number is drawn over a
 * body and "lvl 0" reads as an error state. Clamped at the top to what the
 * roster's `u8` can carry: a `level` of 300 would arrive as 44, and a plate that
 * silently disagreed with the leaderboard is the kind of failure this repo's
 * checks exist for.
 */
export const MAX_LEVEL = 255;

export function levelFor(kills: number): number {
  if (!Number.isFinite(kills) || kills <= 0) return 1;
  return Math.min(MAX_LEVEL, 1 + Math.floor(kills / KILLS_PER_LEVEL));
}

/** The kill count at which `level` is reached. The inverse, for the HUD's "3 to go". */
export function killsForLevel(level: number): number {
  return Math.max(0, (Math.max(1, Math.floor(level)) - 1) * KILLS_PER_LEVEL);
}

/**
 * The ISO week, in Sydney, that a level belongs to.
 *
 * A one-line re-export in function clothing, and it is here rather than imported
 * at every call site so that "the level week" and "the suggestions week" are
 * visibly the same week. The brief names `weekKey` as *the* weekly reset; two
 * features reading one function is what makes that true rather than a
 * coincidence that survives until somebody changes one of them.
 */
export function weekOf(at: number | Date = Date.now()): string {
  return weekKey(at);
}

// --- Where you were standing ---------------------------------------------------

/**
 * How far from the origin a saved spot may be before it is not a spot.
 *
 * Greater Sydney as this game builds it is a 60 km square around Town Hall, so
 * anything past 200 km is a hand-edited file, a corrupted read, or a coordinate
 * that arrived in the wrong units. It is a *sanity* bound and not a world
 * boundary -- `game/spawn.restoreSpawnPoint` is what actually decides whether a
 * spot is standable, and it will refuse a point a kilometre off the built edge
 * long before this does. This exists so that a `1e300` in the file cannot reach
 * the ground query at all, on `sanitiseAccount`'s standing argument that a
 * number off disk is a claim.
 */
export const LAST_POS_LIMIT_M = 200_000;

/**
 * Where an account was standing when it last logged off.
 *
 * `y` is the **feet** height, per the header. `savedMs` is the only lifetime
 * this record has: see `lastPosThisWeek`.
 */
export interface LastPos {
  x: number;
  /** Feet, not the eye. See the header. */
  y: number;
  z: number;
  yaw: number;
  /** `Date.now()` when this was written. The week rule reads this and nothing else. */
  savedMs: number;
}

/**
 * Is this spot still this week's?
 *
 * The one comparison in the feature, and it is deliberately against `savedMs`
 * rather than against `AccountRecord.levelWeek`. The two agree in every ordinary
 * case -- `resetIfNewWeek` clears both together -- but they can disagree in the
 * one case that matters: a hand-edited file, which is exactly the file this
 * module's parser exists to distrust. Reading the timestamp the spot carries
 * means a row whose `levelWeek` says Monday and whose spot was saved in
 * September is refused on the evidence rather than on the label.
 */
export function lastPosThisWeek(pos: LastPos, at: number | Date = Date.now()): boolean {
  return weekOf(pos.savedMs) === weekOf(at);
}

/**
 * One saved spot off disk, or null.
 *
 * `sanitiseAccount`'s discipline applied to five numbers, and the fifth is the
 * reason it is a function rather than four `Number.isFinite` calls inline: a
 * `savedMs` that is not a number makes `weekOf` answer for the epoch, which is
 * always a different week, which would make every spot on the box stale. That
 * fails safe rather than dangerously, and it fails *silently* -- which is the
 * class of thing this repo writes checks for. So it is refused here instead.
 */
export function sanitiseLastPos(value: unknown): LastPos | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Partial<LastPos>;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const z = Number(raw.z);
  const yaw = Number(raw.yaw);
  const savedMs = Number(raw.savedMs);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  if (!Number.isFinite(yaw) || !Number.isFinite(savedMs) || savedMs <= 0) return null;
  if (Math.abs(x) > LAST_POS_LIMIT_M || Math.abs(z) > LAST_POS_LIMIT_M || Math.abs(y) > LAST_POS_LIMIT_M) {
    return null;
  }
  return { x, y, z, yaw, savedMs };
}

/**
 * What the sign-up route says came across with the new account.
 *
 * A pure function of three facts rather than a sentence built at the call site,
 * for `joinPane`'s reason exactly: it is the one part of that response with a
 * *rule* in it -- what carried and what did not -- and a rule is a property of
 * the feature rather than of the route that happens to answer. `verifyAccounts`
 * drives it in both runtimes.
 *
 * There is deliberately **no suburb in it**. The owner's phrasing was *"your
 * spot at Newtown came with you"*, and the server cannot say Newtown: the suburb
 * table is a map atlas the browser loads (`client/src/mapatlas.ts`) and the
 * server has no copy and no reason to grow one for one sentence. The client says
 * the suburb on the *restore*, where it has the atlas in hand -- see
 * `game/carry.restoredLine`. Here it is "your spot", which is true and short.
 */
export function carriedLine(handle: string, kills: number, level: number, spot: boolean): string {
  const bits: string[] = [];
  if (kills > 0) bits.push(level > 1 ? `level ${level}` : `${kills} ${kills === 1 ? 'kill' : 'kills'}`);
  if (spot) bits.push('your spot');
  if (bits.length === 0) return `welcome, ${handle}`;
  const carried = bits.length === 1 ? bits[0] : `${bits[0]} and ${bits[1]}`;
  return `welcome, ${handle} — ${carried} came with you`;
}

// --- The record ------------------------------------------------------------------

/**
 * One account, as it sits on disk and in memory.
 *
 * `passwordHash` is an argon2id string from `Bun.password.hash`. It is **never
 * logged, never echoed, never sent to a client and never compared by hand** --
 * `Bun.password.verify` is the only thing that reads it, in `server/accounts.ts`,
 * and this type is the only place it appears in a shared file. Stated on the
 * field because the failure is silent: a `/auth/me` that spread the record into
 * its JSON would publish every hash on the box and every response would still
 * look correct.
 */
export interface AccountRecord {
  /** A UUID. The wallet key, the roster's identity, and the thing tokens name. */
  id: string;
  /** As registered and as drawn: `sanitiseHandle`'s output. */
  handle: string;
  /** `handleKey(handle)`. The uniqueness key. Re-derived at load, never trusted. */
  handleKey: string;
  /** argon2id. See the type's note. */
  passwordHash: string;
  createdMs: number;
  lastSeenMs: number;
  /** Room for social: `'google' | 'discord' | ...` to that provider's subject. */
  providers: Record<string, string>;
  tokens: SessionToken[];
  /** Player KOs this week. Reset by `resetIfNewWeek`. */
  kills: number;
  /** `levelFor(kills)`, stored so a read costs nothing and a change is detectable. */
  level: number;
  /** The `weekOf` the kills above were counted in. */
  levelWeek: string;
  /**
   * Where this account logged off, or null.
   *
   * Written on socket close and on `/auth/logout`, cleared by the weekly reset,
   * and read once per join. Null rather than a zeroed record on `Participant`'s
   * argument: every path that restores a spot begins with the same test, and
   * (0, 0, 0) is a real point in this world -- it is Town Hall.
   */
  lastPos: LastPos | null;
}

/** What the file on disk looks like. Versioned, on `WalletFile`'s terms. */
export interface AccountFile {
  version: 1;
  /** Keyed by `handleKey`. */
  accounts: Record<string, AccountRecord>;
}

/**
 * Roll a record into the current week if it is behind. Returns whether it moved.
 *
 * The **only** place kills are zeroed **and the only place a saved spot is
 * dropped by the calendar**, called from every path that reads or
 * writes them (load, login, join, a knockout, and the per-room minute check).
 * That redundancy is the design: a lazy reset that is only applied on one of
 * those paths is a player whose level resets when they happen to reconnect and
 * not otherwise, which is worse than not resetting at all because it is
 * unpredictable.
 *
 * Idempotent, so calling it five times in a tick costs four string compares.
 */
export function resetIfNewWeek(record: AccountRecord, at: number | Date = Date.now()): boolean {
  const week = weekOf(at);
  if (record.levelWeek === week) return false;
  record.levelWeek = week;
  record.kills = 0;
  record.level = 1;
  // *"persisted to end of week"*, and this is the end of the week. Cleared in
  // the same three lines as the ladder rather than in a rule of its own, so
  // there is exactly one Monday in this feature -- see the header.
  record.lastPos = null;
  return true;
}

/**
 * One record off disk, or null if it is not one.
 *
 * Every field re-derived rather than trusted, verbatim for
 * `wallets.sanitiseRecord`'s reason and one stronger: this file is
 * hand-editable by whoever runs the box, and a `tokens` array containing a
 * number would reach the token index as a `[object Object]` key that every
 * request then matches. A record missing its hash is refused outright -- an
 * account nobody can log into is worse than no account, because the handle it
 * holds is then unavailable to everybody including its owner.
 */
export function sanitiseAccount(value: unknown, now = Date.now()): AccountRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Partial<AccountRecord>;
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= 64 ? raw.id : '';
  const handle = sanitiseHandle(typeof raw.handle === 'string' ? raw.handle : '');
  const passwordHash = typeof raw.passwordHash === 'string' ? raw.passwordHash : '';
  // A social-only account has no password and is legitimate; an account with
  // neither a password nor a provider is a row that can never be used again.
  const providers: Record<string, string> = {};
  if (typeof raw.providers === 'object' && raw.providers !== null && !Array.isArray(raw.providers)) {
    for (const [name, subject] of Object.entries(raw.providers)) {
      if (typeof subject === 'string' && name.length <= 24 && subject.length <= 128) providers[name] = subject;
    }
  }
  if (id === '' || handle === '') return null;
  if (passwordHash === '' && Object.keys(providers).length === 0) return null;

  const tokens: SessionToken[] = [];
  if (Array.isArray(raw.tokens)) {
    for (const t of raw.tokens) {
      if (typeof t !== 'object' || t === null) continue;
      const entry = t as Partial<SessionToken>;
      if (typeof entry.token !== 'string' || !tokenShaped(entry.token)) continue;
      const issuedMs = Number(entry.issuedMs);
      const expiresMs = Number(entry.expiresMs);
      if (!Number.isFinite(expiresMs)) continue;
      // Expired tokens are dropped **at load** rather than kept and filtered on
      // every request: the index built from this array is what a request hits,
      // and an index full of dead entries is a map that grows for the life of
      // the process for no reader.
      if (expiresMs <= now) continue;
      tokens.push({
        token: entry.token,
        issuedMs: Number.isFinite(issuedMs) ? issuedMs : now,
        // Clamped, so a hand-edited `expiresMs` of 1e300 cannot mint a
        // permanent credential by being typed into a text editor.
        expiresMs: Math.min(expiresMs, now + TOKEN_TTL_MS),
      });
      if (tokens.length >= MAX_TOKENS_PER_ACCOUNT) break;
    }
  }

  const createdMs = Number(raw.createdMs);
  const lastSeenMs = Number(raw.lastSeenMs);
  const kills = Number(raw.kills);
  const record: AccountRecord = {
    id,
    handle,
    // Re-derived, never read: a hand-edited file whose `handleKey` disagreed
    // with its `handle` would be an account reachable under one name and drawn
    // under another, which is the impersonation this key exists to prevent.
    handleKey: handleKey(handle),
    passwordHash,
    createdMs: Number.isFinite(createdMs) ? createdMs : now,
    lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : now,
    providers,
    tokens,
    kills: Number.isFinite(kills) ? Math.max(0, Math.min(1e9, Math.trunc(kills))) : 0,
    // Derived rather than read, for `handleKey`'s reason: a stored level that
    // disagreed with the kills beside it is the one number a player checks.
    level: 1,
    levelWeek: typeof raw.levelWeek === 'string' ? raw.levelWeek : '',
    // **Absent is the ordinary case, not an error.** Every account written
    // before this feature existed has no `lastPos`, and so does every account
    // that has never logged off since the last Monday. A parser that treated a
    // missing spot as a bad row would have refused the whole file on the deploy
    // that introduced it.
    lastPos: sanitiseLastPos(raw.lastPos),
  };
  record.level = levelFor(record.kills);
  // A spot from a week that has ended, on a row whose `levelWeek` says
  // otherwise. `resetIfNewWeek` below cannot catch this one -- it compares the
  // *label* -- and the case is real: a hand-edited file, and a file written by a
  // build whose clock was wrong. Refused on the evidence; see `lastPosThisWeek`.
  if (record.lastPos !== null && !lastPosThisWeek(record.lastPos, now)) record.lastPos = null;
  // And rolled forward before anybody sees it, so a box that was off over the
  // weekend does not serve last week's ladder for the first minute of this one.
  resetIfNewWeek(record, now);
  return record;
}

// --- What the routes answer with ---------------------------------------------------

/**
 * `GET /auth/check?handle=` -- the landing page's live availability test.
 *
 * A shape rather than a boolean, because "no" has three different reasons and
 * the field a player is typing into has to say which: a handle that is *taken*
 * is a different instruction from a handle that is *too short*.
 */
export interface HandleCheck {
  available: boolean;
  /** Empty when available. A sentence, lower case, for the field's note line. */
  reason: string;
  /** The handle as it would actually be registered. Echoed so the UI can show it. */
  handle: string;
}

/** `GET /auth/me`, and what `POST /auth/signup`/`login` answer with. */
export interface AccountView {
  handle: string;
  level: number;
  kills: number;
  /** `weekOf` the kills belong to, so a client can notice a rollover itself. */
  week: string;
}

/**
 * Rate limits on the auth routes, per IP: ten a minute, per the brief.
 *
 * The same token-bucket shape `server/bugs.ts` uses and the same reasoning about
 * where it sits: signup and login are the two routes in this process that do
 * *work* on an unauthenticated request -- argon2id is deliberately expensive, at
 * tens of milliseconds a call -- so an unlimited login route is a way to spend
 * this box's single vCPU from a text field. Ten a minute is far above a person
 * mistyping their password and far below what a loop does in a second.
 *
 * `/auth/check` is deliberately on a **looser** budget than that: it is fired on
 * every keystroke of the landing field (debounced to 300 ms), it does no hashing,
 * and a limit tight enough to matter would break the feature it is protecting.
 */
export const AUTH_PER_MIN = 10;
export const CHECK_PER_MIN = 120;

// --- The landing panel's one decision ------------------------------------------------

/** Which of the join panel's three panes is showing. See `joinPane`. */
export type JoinPane = 'quick' | 'account' | 'signedin';

/**
 * Which pane the landing panel shows, from the two facts that decide it.
 *
 * A pure function in the **shared** module rather than a method on the panel,
 * and the reason is that it is the only part of that UI with a rule in it. The
 * rest of `client/src/accounts.ts` is listeners, `fetch` and `classList` -- code
 * whose correctness is "does the button do the thing", which a check cannot
 * assert without a browser. This is the bit that can be *wrong*: a logged-in
 * player shown the name box is being asked a question they have answered, and a
 * guest shown the signed-in pane has a "play as" button with nobody to be.
 *
 * Here rather than beside the panel so `verifyAccounts` can drive it in both
 * runtimes, on `rankRoster`'s argument in `net/protocol.ts`: an order -- or in
 * this case a state machine -- is a property of the feature, not of the element
 * that happens to draw it.
 */
export function joinPane(signedIn: boolean, tab: 'quick' | 'account'): JoinPane {
  if (tab === 'account') return 'account';
  return signedIn ? 'signedin' : 'quick';
}

/**
 * What the feedback gate says, from the two facts that decide *it*.
 *
 * `'none'` hides the gate and shows the compose box. The other two are the
 * honest split described in `client/src/accounts.ts`'s header: a guest is asked
 * to sign up, and somebody who signed up **after** joining is asked to reload,
 * because the token binds to a participant on the `HELLO` and this session's
 * participant is still a guest. Telling those two apart is the whole of the
 * rule, and getting it wrong shows a compose box whose submissions the server
 * refuses -- which reads as the feature being broken rather than as a step
 * being missing.
 */
export function feedbackGate(signedIn: boolean, boundAtJoin: boolean): 'none' | 'signup' | 'reload' {
  if (!signedIn) return 'signup';
  return boundAtJoin ? 'none' : 'reload';
}

// --- The self-check ----------------------------------------------------------------

/**
 * Everything in this feature that can be wrong without throwing.
 *
 * Run at boot in **both** runtimes (`main.ts` and `server/index.ts`), which is
 * the arrangement `verifyNames` established and is worth restating here because
 * the failures are asymmetric:
 *
 *   - A **handle key that does not fold** lets two accounts register handles
 *     that render identically. Nothing anywhere reports it; the second player
 *     simply finds that their kills are going somewhere else.
 *   - A **level formula off by one** puts the wrong number over every body in
 *     the city and is completely invisible until somebody counts their kills.
 *   - A **week comparison that is not the suggestions box's week** means the
 *     ladder resets on a different day from the votes, which nobody notices for
 *     six days and then everybody notices at once.
 *   - A **token expiry that is not enforced** is the only security-shaped
 *     failure in the file and it is silent by construction: every request
 *     succeeds.
 *   - A **parser that trusts the file** turns a hand-edited row into an account
 *     whose stored level disagrees with its kills, or -- worse -- one holding a
 *     token that never expires.
 *   - A **saved spot that outlives its week** puts a player back in a suburb
 *     they were in a fortnight ago, and one that is dropped a week early puts
 *     them at the park on Tuesday. Neither throws, neither logs, and both are
 *     one string compare away from the other.
 *
 * No disk, no network, no hashing: `Bun.password` is exercised by the running
 * server and a check that awaited a hash would add tens of milliseconds to every
 * boot to test a dependency.
 */
export function verifyAccounts(): string[] {
  const failures: string[] = [];

  // --- The handle key folds the things it claims to, and is idempotent.
  {
    const same: Array<[string, string]> = [
      ['Bazza', 'bazza'],
      ['  Bazza  ', 'bazza'],
      ['BAZZA', 'bazza'],
      ['Bazza  Two', 'bazza two'],
      // NFKC: fullwidth Latin, which is the mechanical impersonation this fold
      // exists for. The escapes spell "Bazza" in the fullwidth block; written that
      // way rather than pasted, because a reviewer cannot tell the two apart.
      ['\uFF22\uFF41\uFF5A\uFF5A\uFF41', 'bazza'],
    ];
    for (const [raw, want] of same) {
      const got = handleKey(raw);
      if (got !== want) failures.push(`handleKey(${JSON.stringify(raw)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
      if (handleKey(got) !== got) failures.push(`handleKey is not idempotent on ${JSON.stringify(raw)}.`);
    }
    if (handleKey('Bazza') === handleKey('Shazza')) {
      failures.push('Two different handles fold to one key; every account would be the same account.');
    }
    // A registered handle must survive being drawn: it is the in-game name.
    const registered = sanitiseHandle('  Bazza  ');
    if (registered !== 'Bazza') failures.push(`A handle sanitised to ${JSON.stringify(registered)} rather than "Bazza".`);
    if (sanitiseHandle('a') !== '') failures.push('A one-character handle was accepted; the name rules say two.');
    if ([...sanitiseHandle('x'.repeat(40))].length > MAX_NAME_CHARS) {
      failures.push('A long handle was not clipped to the name cap; the roster would truncate it mid-record.');
    }
    if (sanitiseHandle('\u200B\u200B\u200B') !== '') {
      failures.push('A handle of zero-width spaces was accepted; it would occupy a leaderboard row invisibly.');
    }
  }

  // --- Passwords: the floor, the ceiling, and nothing in between.
  {
    if (passwordRefusal('x'.repeat(MIN_PASSWORD_CHARS)) !== '') {
      failures.push(`A password of exactly ${MIN_PASSWORD_CHARS} characters was refused.`);
    }
    if (passwordRefusal('x'.repeat(MIN_PASSWORD_CHARS - 1)) === '') {
      failures.push(`A password of ${MIN_PASSWORD_CHARS - 1} characters was accepted.`);
    }
    if (passwordRefusal('x'.repeat(MAX_PASSWORD_CHARS + 1)) === '') {
      failures.push('An unbounded password was accepted; the hash is computed on this box.');
    }
    // Emoji count as code points, not as bytes: a passphrase of eight emoji is
    // eight characters to the person who typed it.
    if (passwordRefusal('\u{1F99C}'.repeat(MIN_PASSWORD_CHARS)) !== '') {
      failures.push('An eight-emoji password was refused; the floor is counting bytes rather than characters.');
    }
  }

  // --- The ladder. Ten kills a level, level 1 at the bottom, capped at the u8.
  {
    const cases: Array<[number, number]> = [
      [0, 1], [1, 1], [9, 1], [10, 2], [19, 2], [20, 3], [100, 11],
    ];
    for (const [kills, want] of cases) {
      const got = levelFor(kills);
      if (got !== want) failures.push(`${kills} kills is level ${got}, not ${want}.`);
    }
    if (levelFor(-5) !== 1) failures.push('A negative kill count produced a level other than 1.');
    if (levelFor(NaN) !== 1) failures.push('A NaN kill count produced a level other than 1.');
    if (levelFor(1e9) > 255) failures.push('A level over 255 was produced; the roster carries it as a u8.');
    // The inverse has to agree with the forward direction at every boundary, or
    // the HUD's "3 kills to go" counts down to a level-up that does not happen.
    for (let level = 1; level <= 12; level++) {
      const at = killsForLevel(level);
      if (levelFor(at) !== level) failures.push(`killsForLevel(${level}) is ${at}, which is level ${levelFor(at)}.`);
      if (at > 0 && levelFor(at - 1) !== level - 1) {
        failures.push(`One kill short of level ${level} is level ${levelFor(at - 1)}, not ${level - 1}.`);
      }
    }
  }

  // --- The week. The suggestions box's, and the reset it drives.
  {
    const now = Date.UTC(2026, 7, 17, 3, 0, 0); // a Monday afternoon in Sydney
    if (weekOf(now) !== weekKey(now)) {
      failures.push('The level week is not the suggestions week; the ladder and the votes would reset on different days.');
    }
    const record = fakeAccount(now);
    record.kills = 34;
    record.level = levelFor(34);
    if (resetIfNewWeek(record, now)) failures.push('A record already in the current week was reset.');
    if (record.kills !== 34) failures.push('A same-week reset zeroed the kills anyway.');
    record.levelWeek = '2020-W01';
    if (!resetIfNewWeek(record, now)) failures.push('A record from an old week was not reset.');
    if (record.kills !== 0 || record.level !== 1) {
      failures.push(`A weekly reset left ${record.kills} kills at level ${record.level}; both must go to the floor.`);
    }
    if (record.levelWeek !== weekOf(now)) failures.push('A weekly reset did not stamp the new week; it would reset again next tick.');
    if (resetIfNewWeek(record, now)) failures.push('The weekly reset is not idempotent; it would fire on every read.');
  }

  // --- Tokens: the shape test, and the expiry that is the whole of the security.
  {
    const now = 1_800_000_000_000;
    if (!tokenShaped('a'.repeat(TOKEN_CHARS))) failures.push('A well-formed token was refused by the shape test.');
    if (tokenShaped('a'.repeat(TOKEN_CHARS - 1))) failures.push('A short token passed the shape test.');
    if (tokenShaped('Z'.repeat(TOKEN_CHARS))) failures.push('A non-hex token passed the shape test.');
    if (tokenShaped('')) failures.push('An empty token passed the shape test; every unauthenticated request would carry one.');
    if (!tokenLive({ token: '', issuedMs: now, expiresMs: now + 1000 }, now)) {
      failures.push('A token expiring in a second was treated as dead.');
    }
    if (tokenLive({ token: '', issuedMs: now, expiresMs: now }, now)) {
      failures.push('A token expiring exactly now was treated as live; expiry must be strict or it never happens.');
    }
    if (tokenLive({ token: '', issuedMs: now, expiresMs: now - 1 }, now)) {
      failures.push('An expired token was accepted. Every session on the box is permanent.');
    }
    if (!(TOKEN_TTL_MS >= 24 * 3600 * 1000 && TOKEN_TTL_MS <= 90 * 24 * 3600 * 1000)) {
      failures.push(`The token lifetime is ${TOKEN_TTL_MS} ms, outside the day-to-a-quarter the header argues for.`);
    }
  }

  // --- The parser, on the rows a hand-edited file can really contain.
  {
    const now = 1_800_000_000_000;
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      ['bazza', 'a string'],
      [[], 'an array'],
      [{ id: 'x', handle: 'Bazza' }, 'no password and no provider'],
      [{ id: '', handle: 'Bazza', passwordHash: '$argon2id$x' }, 'no id'],
      [{ id: 'x', handle: 'a', passwordHash: '$argon2id$x' }, 'a handle that does not survive the name rules'],
    ];
    for (const [row, why] of bad) {
      if (sanitiseAccount(row, now) !== null) failures.push(`A record with ${why} was accepted off disk.`);
    }
    // A good row survives, with everything derived rather than believed.
    const good = sanitiseAccount(
      {
        id: 'abc',
        handle: 'Bazza',
        handleKey: 'NOT-THE-KEY',
        passwordHash: '$argon2id$v=19$m=65536,t=2,p=1$x$y',
        createdMs: 1,
        lastSeenMs: 2,
        providers: { google: 'sub-123' },
        tokens: [
          { token: 'a'.repeat(TOKEN_CHARS), issuedMs: now, expiresMs: now + 1000 },
          { token: 'b'.repeat(TOKEN_CHARS), issuedMs: now, expiresMs: now - 1000 },
          { token: 'not a token', issuedMs: now, expiresMs: now + 1000 },
          { token: 'c'.repeat(TOKEN_CHARS), issuedMs: now, expiresMs: 1e300 },
        ],
        kills: 25,
        level: 99,
        levelWeek: weekOf(now),
      },
      now,
    );
    if (!good) {
      failures.push('A well-formed account record was refused off disk.');
    } else {
      if (good.handleKey !== 'bazza') failures.push(`A hand-edited handleKey survived as ${JSON.stringify(good.handleKey)}.`);
      if (good.level !== levelFor(25)) failures.push(`A stored level of 99 survived beside ${good.kills} kills.`);
      if (good.tokens.length !== 2) failures.push(`${good.tokens.length} tokens survived the parser; the dead and malformed ones must not.`);
      if (good.tokens.some((t) => t.expiresMs > now + TOKEN_TTL_MS)) {
        failures.push('A token with an absurd expiry was kept unclamped; a text editor could mint a permanent session.');
      }
      if (good.providers.google !== 'sub-123') failures.push('A social provider binding was dropped by the parser.');
    }
    // Too many tokens on one row cannot grow the record without bound.
    const many = sanitiseAccount(
      {
        ...fakeAccount(now),
        tokens: Array.from({ length: 40 }, (_, i) => ({
          token: i.toString(16).padStart(TOKEN_CHARS, '0'),
          issuedMs: now,
          expiresMs: now + 1000,
        })),
      },
      now,
    );
    if (many && many.tokens.length > MAX_TOKENS_PER_ACCOUNT) {
      failures.push(`${many.tokens.length} tokens were loaded against a cap of ${MAX_TOKENS_PER_ACCOUNT}.`);
    }
  }

  // --- The saved spot: the parser, the week rule, and the sentence.
  {
    // A Wednesday in the same ISO week as the Monday the section above uses, so
    // "this week" and "last week" here are the calendar's and not a guess.
    const now = Date.UTC(2026, 7, 19, 3, 0, 0);
    const lastWeek = now - 8 * 24 * 3600 * 1000;

    // The parser, on the rows a hand-edited file can really contain.
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'a missing spot'],
      ['Newtown', 'a string'],
      [[], 'an array'],
      [{ x: 1, y: 2, z: 3, yaw: 0 }, 'no savedMs'],
      [{ x: 1, y: 2, z: 3, yaw: 0, savedMs: 0 }, 'a savedMs of zero'],
      [{ x: 1, y: 2, z: 3, yaw: Number.NaN, savedMs: now }, 'a NaN yaw'],
      [{ x: 'here', y: 2, z: 3, yaw: 0, savedMs: now }, 'a non-numeric x'],
      [{ x: 1e300, y: 2, z: 3, yaw: 0, savedMs: now }, 'an x past the end of the world'],
      [{ x: 1, y: 2, z: -1e9, yaw: 0, savedMs: now }, 'a z past the end of the world'],
    ];
    for (const [row, why] of bad) {
      if (sanitiseLastPos(row) !== null) failures.push(`A saved spot with ${why} was accepted off disk.`);
    }
    const spot = sanitiseLastPos({ x: -2236.4, y: 12.5, z: 4543.3, yaw: 1.25, savedMs: now });
    if (!spot) {
      failures.push('A well-formed saved spot was refused off disk.');
    } else if (spot.x !== -2236.4 || spot.y !== 12.5 || spot.z !== 4543.3 || spot.yaw !== 1.25) {
      failures.push(`A saved spot came back as (${spot.x}, ${spot.y}, ${spot.z}) yaw ${spot.yaw}; it must be exact.`);
    }

    // The week rule, which is the whole of the lifetime.
    if (spot && !lastPosThisWeek(spot, now)) failures.push("This week's saved spot was treated as stale.");
    if (spot && lastPosThisWeek({ ...spot, savedMs: lastWeek }, now)) {
      failures.push('A spot saved last week was treated as current; the reset that zeroes the level must drop it too.');
    }

    // A record parses **with and without** a spot -- the second is every account
    // written before this feature and every account that has not logged off
    // since Monday, so a parser that refused it would refuse the whole file.
    const withSpot = sanitiseAccount({ ...fakeAccount(now), lastPos: { x: 10, y: 0, z: 20, yaw: 0, savedMs: now } }, now);
    if (!withSpot) failures.push('An account carrying a saved spot was refused off disk.');
    else if (withSpot.lastPos === null) failures.push('An account carrying a saved spot lost it in the parser.');
    const without = sanitiseAccount(fakeAccount(now), now);
    if (!without) failures.push('An account with no saved spot was refused off disk; every old row is one.');
    else if (without.lastPos !== null) failures.push('An account with no saved spot came back with one.');

    // A spot from last week does not survive the parser, whatever the row's
    // `levelWeek` claims. This is the case `resetIfNewWeek` cannot see.
    const stale = sanitiseAccount(
      { ...fakeAccount(now), levelWeek: weekOf(now), lastPos: { x: 10, y: 0, z: 20, yaw: 0, savedMs: lastWeek } },
      now,
    );
    if (stale?.lastPos !== null) {
      failures.push("A spot saved last week survived on a row labelled with this week's level week.");
    }

    // And the reset drops it, in the same call that zeroes the ladder.
    const record = fakeAccount(now);
    record.lastPos = { x: 10, y: 0, z: 20, yaw: 0, savedMs: now };
    if (resetIfNewWeek(record, now)) failures.push('A record already in the current week was reset.');
    if (record.lastPos === null) failures.push('A same-week reset dropped the saved spot anyway.');
    record.levelWeek = '2020-W01';
    resetIfNewWeek(record, now);
    if (record.lastPos !== null) failures.push('A weekly reset kept the saved spot; a spot outlives its week.');

    // The sentence the sign-up route answers with.
    const lines: Array<[number, number, boolean, string]> = [
      [12, 2, true, 'welcome, Bazza — level 2 and your spot came with you'],
      [12, 2, false, 'welcome, Bazza — level 2 came with you'],
      [4, 1, true, 'welcome, Bazza — 4 kills and your spot came with you'],
      [1, 1, false, 'welcome, Bazza — 1 kill came with you'],
      [0, 1, true, 'welcome, Bazza — your spot came with you'],
      [0, 1, false, 'welcome, Bazza'],
    ];
    for (const [kills, level, hasSpot, want] of lines) {
      const got = carriedLine('Bazza', kills, level, hasSpot);
      if (got !== want) failures.push(`carriedLine(${kills}, ${level}, ${hasSpot}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
    }
  }

  // --- The landing panel's state machine, and the gate's.
  {
    const panes: Array<[boolean, 'quick' | 'account', JoinPane]> = [
      [false, 'quick', 'quick'],
      [false, 'account', 'account'],
      [true, 'quick', 'signedin'],
      [true, 'account', 'account'],
    ];
    for (const [signedIn, tab, want] of panes) {
      const got = joinPane(signedIn, tab);
      if (got !== want) failures.push(`joinPane(${signedIn}, ${tab}) is ${got}, not ${want}.`);
    }
    // The two that matter, said as rules rather than as a table: a logged-in
    // player is never asked for a name, and a guest is never offered a "play
    // as" button with nobody to be.
    if (joinPane(true, 'quick') === 'quick') failures.push('A logged-in player is shown the name box.');
    if (joinPane(false, 'quick') === 'signedin') failures.push('A guest is shown the signed-in pane.');

    const gates: Array<[boolean, boolean, string]> = [
      [false, false, 'signup'],
      [false, true, 'signup'],
      [true, false, 'reload'],
      [true, true, 'none'],
    ];
    for (const [signedIn, bound, want] of gates) {
      const got = feedbackGate(signedIn, bound);
      if (got !== want) failures.push(`feedbackGate(${signedIn}, ${bound}) is ${got}, not ${want}.`);
    }
    // The one that is easy to get wrong, and the one whose failure is a compose
    // box the server will refuse: signed in, but this session joined as a guest.
    if (feedbackGate(true, false) === 'none') {
      failures.push('Somebody who signed up mid-session is shown a compose box the server will refuse.');
    }
  }

  // --- And the rate limits are limits rather than decoration.
  if (!(AUTH_PER_MIN >= 3 && AUTH_PER_MIN <= 60)) {
    failures.push(`The auth budget is ${AUTH_PER_MIN}/min, outside the range a password hash on one vCPU can absorb.`);
  }
  if (CHECK_PER_MIN <= AUTH_PER_MIN) {
    failures.push('The handle check is limited at least as tightly as login; the landing field would rate-limit itself.');
  }

  return failures;
}

/** A minimal valid record, for the checks above. Not exported: nothing else wants one. */
function fakeAccount(now: number): AccountRecord {
  return {
    id: 'test',
    handle: 'Bazza',
    handleKey: 'bazza',
    passwordHash: '$argon2id$test',
    createdMs: now,
    lastSeenMs: now,
    providers: {},
    tokens: [],
    kills: 0,
    level: 1,
    levelWeek: weekOf(now),
    lastPos: null,
  };
}
