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

import { EMPTY_MASK, NODE_COUNT, TEAM, TEAM_NAME, type TalentMask, type Team } from '../game/teams.ts';
import { MAX_NAME_CHARS, sanitiseName } from './protocol.ts';
import { weekKey } from './suggestions.ts';
// WORKSTREAM AK: one parser for a cursor, imported rather than copied. The
// module is three-free and content-free at this level; see `sanitiseCursor`.
import { WEEKLY_FLAG_PREFIX, completionFlag, sanitiseCursor, type QuestCursor } from '../game/questmodel.ts';

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

/**
 * --- WORKSTREAM AK: the ladder is **experience** now, and a knockout is
 * 100 of it.
 *
 * *"10 kills levels u up"* is still exactly true and the numbers below are
 * chosen so that it is **bit-for-bit** true rather than approximately: a
 * knockout pays `XP_PER_KO` and a level is `XP_PER_LEVEL`, and 100 x 10 is
 * 1000, so every player who has only ever punched people is at precisely the
 * level they were at before this changed. Nothing about today's behaviour
 * moves; what moves is that there is now somewhere else for a level to come
 * from.
 *
 * Why xp rather than "kills plus a bonus counter": because the alternative is
 * two ladders. A quest that paid kills would put a number in the *kills* column
 * of the leaderboard that nobody was knocked over for, and a quest that paid a
 * second counter would need every reader of `levelFor` to add the two -- which
 * is the second derivation this file's header spends a paragraph refusing.
 * `kills` stays what it says on the tin (bodies), `xp` is the ladder, and
 * exactly one function turns one into the other.
 *
 * The broader sources -- fares, rides, escaping a pursuit -- are deliberately
 * **not** here. They are a later pass; this one adds the field and the one
 * source that already existed.
 */
export const XP_PER_LEVEL = 1000;
export const XP_PER_KO = 100;

/** *"10 kills levels u up"*, derived rather than stated, so the two cannot drift. */
export const KILLS_PER_LEVEL = XP_PER_LEVEL / XP_PER_KO;

/**
 * The one place the ladder is computed. `1 + floor(xp / 1000)`.
 *
 * Level 1 at zero xp rather than level 0, because the number is drawn over a
 * body and "lvl 0" reads as an error state. Clamped at the top to what the
 * roster's `u8` can carry: a `level` of 300 would arrive as 44, and a plate that
 * silently disagreed with the leaderboard is the kind of failure this repo's
 * checks exist for.
 */
export const MAX_LEVEL = 255;

export function levelFor(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return Math.min(MAX_LEVEL, 1 + Math.floor(xp / XP_PER_LEVEL));
}

/** The xp at which `level` is reached. The inverse, for the HUD's bar. */
export function xpForLevel(level: number): number {
  return Math.max(0, (Math.max(1, Math.floor(level)) - 1) * XP_PER_LEVEL);
}

/**
 * The same inverse in knockouts, which is what the HUD's "3 to go" counts in.
 *
 * Kept as its own export rather than left to the call sites to divide, because
 * the roster carries progress in **knockout-equivalents** (`RosterEntry.kills`)
 * and the bar is drawn against this: two derivations of the same boundary is
 * exactly the disagreement `verifyLevelHud` exists to catch.
 */
export function killsForLevel(level: number): number {
  return xpForLevel(level) / XP_PER_KO;
}

/**
 * Experience as the roster's `u16` carries it: whole knockout-equivalents.
 *
 * The roster field predates xp and is a `u16` of *kills toward the next level*.
 * Widening it would be a protocol change on the one message that is re-sent
 * every two seconds for every player in the room, to carry a number the HUD
 * immediately divides by 100 to draw a bar. So the division happens here, once,
 * on the way out -- and a quest paying 250 xp moves the bar two and a half
 * knockouts, which floors to two on the plate and is exact in `levelFor`.
 *
 * 255 levels is 255,000 xp is 2,550 knockout-equivalents, comfortably inside a
 * `u16`, so the field cannot wrap before the level clamps.
 */
export function koEquivalent(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 0;
  return Math.min(65535, Math.floor(xp / XP_PER_KO));
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
  /**
   * The building this position is *inside*, or 0 for the street.
   *
   * `world/doorway.buildingSeed` -- the building's own name, hashed out of its
   * footprint -- rather than `net/spaces.ts`'s space id, and the two are not
   * interchangeable here: the space is derived from the seed and not the other
   * way round, and the server needs the seed to find the building again among
   * the prisms near this position and rebuild the same rooms. The space falls
   * out of it in one call.
   *
   * **Zero is the street, and absence is zero.** Every account written before
   * interiors has no such field, and the missing value has to mean outside --
   * the same rule `spaces.CITY_SPACE` is zero for. A row that meant "in an
   * unknown building" would be a returning player in a room that may not exist.
   *
   * The owner's decision: *"if u log out inside u log in there"*. This is the
   * whole of that feature's storage.
   */
  building: number;
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
  // **A bad building is the street, not a refusal.** The rest of this parser
  // returns null on a value it cannot trust, because a position with a NaN in it
  // is not a position -- but a spot whose building field is missing, absent or
  // rubbish is a perfectly good spot that happens to be outdoors, and refusing
  // the whole row would throw away the position too. Every account on the box
  // takes this branch on the deploy that introduces the field.
  const raw2 = raw as { building?: unknown };
  const b = Number(raw2.building);
  const building = Number.isFinite(b) && b > 0 && b <= 0xffffffff ? Math.trunc(b) >>> 0 : 0;
  return { x, y, z, yaw, building, savedMs };
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
  /**
   * The ladder currency this week. See `XP_PER_LEVEL`.
   *
   * Reset with the kills, and it must be: it *is* the level, and the level goes
   * to one on Monday. Every account written before workstream AK has no such
   * field, and `sanitiseAccount` reconstructs it as `kills * XP_PER_KO`, which
   * is exact rather than approximate -- see that function.
   */
  xp: number;
  /** `levelFor(xp)`, stored so a read costs nothing and a change is detectable. */
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
  /**
   * Marita, DeFAULT, or neither. **The one thing on this record that outlives
   * the week.**
   *
   * `game/teams.ts`'s header states the rule and it is worth restating from the
   * persistence side, because the field sits three lines from two that behave
   * the opposite way: the level resets on Monday, the talents reset on Monday,
   * and **the side you picked does not**. A team that reset weekly would be a
   * choice made at level 2 every Tuesday, which is a menu rather than an
   * allegiance -- and the whole of what the choice is worth is that your mates
   * can see it from across the street next week too.
   *
   * `TEAM.NONE` until it is chosen, and chosen at most once ever, which is
   * enforced in `Simulation.teamOp` rather than here: this file owns the shape
   * of the record and the calendar, and `server/sim.ts` owns the rules.
   *
   * A guest has no record and therefore no team. That falls out of accounts
   * existing at all rather than being a rule of its own, and it is why
   * `TEAM_CHOICE_LEVEL` is 2: a guest cannot reach level 2 (see
   * `Simulation.creditLadder`), so a guest is never asked to choose.
   */
  team: Team;
  /**
   * Which talents are spent, as a 64-bit mask in two halves. **Reset by the
   * week, with the kills and the level.**
   *
   * The opposite lifetime to `team` one field up, and for the reason that file
   * argues: a point is granted per level and the levels go back to one on
   * Monday, so talents that survived would be ten points spent on a level-1
   * character. `resetIfNewWeek` clears this in the same three lines that zero
   * the kills, which is what makes "there is one Monday in this game" true
   * rather than hoped.
   *
   * Stored as `{lo, hi}` rather than a `BigInt` for `game/teams.TalentMask`'s
   * reason, and it survives `JSON.stringify` as two ordinary numbers -- which a
   * `BigInt` does not, at all: `JSON.stringify(1n)` throws, and it would have
   * thrown inside `AccountStore.save`, on the debounce, with nothing on screen.
   */
  talents: TalentMask;
  /**
   * --- WORKSTREAM AK. **The story flags, and the one thing on this record that
   * survives Monday.**
   *
   * `team` used to be that thing and stopped being it on 2026-08-19 (see
   * `resetIfNewWeek`, which now clears the side with everything else). This is
   * the replacement, and it is a *different kind* of thing rather than the same
   * exception moved: a side is a preference and re-asking is the feature; an
   * **act is a story**, and a story that resets weekly is not one. A player who
   * finished Mutual Obligations in March must not be handed the first job again
   * in April, and there is no version of that where the flag lives in something
   * the calendar clears.
   *
   * Three kinds of string live in here and they are told apart by a prefix:
   *
   *   - `q:<questId>` -- written by the engine when a **story** quest is turned
   *     in. "Have I done this" and "did the story branch" are then the same
   *     question against the same set, which is why there is no separate
   *     "completed" list. Permanent.
   *   - `w:<questId>` -- WORKSTREAM AN. The same mark for a **repeatable**, and
   *     the one kind of flag in here that Monday takes: `resetIfNewWeek` drops
   *     every `w:` and keeps everything else, so a weekly job is done for the
   *     week rather than done forever. `questmodel.doneFlag` picks between this
   *     and the line above, and `repeatable` is the whole of the switch.
   *   - anything else -- an authored `unlock` from a content pack.
   *
   * The weekly marks live here rather than in a field of their own because the
   * client already receives this list on `MSG.QUEST_STATE` and draws the
   * phone's register and the world's `!` markers off it. A second list would
   * have been a wire change to say something the wire already carries.
   *
   * Bounded at `MAX_STORY_FLAGS`, because this is a list a *content file* can
   * grow and a content file is edited on github.com by a person in a hurry.
   */
  story: string[];
  /**
   * --- WORKSTREAM AK. In-progress quest cursors, keyed by quest id.
   *
   * **The opposite lifetime to `story` one field up**, and deliberately: the
   * obligations are weekly and so is the paperwork. A job abandoned halfway
   * through on Saturday is not waiting on Monday, which is correct -- and it
   * means this field cannot grow without bound on an account that starts things
   * and does not finish them.
   *
   * Content-free by construction. This file has never read a quest pack and
   * must not learn to: `sanitiseCursor` keeps what is on disk, bounded, and the
   * engine reconciles the shape against the real quest the first time it looks
   * (`questmodel.reconcileCursor`). That ordering is what lets an author add a
   * step to a quest people are halfway through without resetting anybody.
   */
  quests: Record<string, QuestCursor>;
}

/**
 * How many story flags one account may hold, and how long each may be.
 *
 * A cap because this is the one field on a record that a **content file** can
 * grow: a pack with a hundred quests in it, each unlocking four flags, is four
 * hundred strings on every account that plays through it, in a JSON file
 * rewritten on a two-second debounce. 256 is far past every act this game is
 * ever going to have and far short of a file that is a problem.
 *
 * Reached rather than exceeded is a *drop*, not a refusal -- see
 * `sanitiseAccount`. An account that somehow accumulated more flags than this
 * keeps the oldest, because the oldest are the story and the newest is one
 * quest.
 */
export const MAX_STORY_FLAGS = 1024;
// 256 was sized before the content pool existed; see `net/quests.MAX_WIRE_FLAGS`
// for the arithmetic that moved both together. The two are equal on purpose:
// a flag the account can hold is a flag the frame can carry.
export const MAX_OPEN_QUESTS = 24;

/** What the file on disk looks like. Versioned, on `WalletFile`'s terms. */
export interface AccountFile {
  version: 1;
  /** Keyed by `handleKey`. */
  accounts: Record<string, AccountRecord>;
}

/**
 * Roll a record into the current week if it is behind. Returns whether it moved.
 *
 * ---------------------------------------------------------------------------
 * **WHAT SURVIVES MONDAY, AND IT IS EXACTLY ONE FIELD.**
 *
 * Everything on a record is cleared here -- kills, xp, level, the saved spot,
 * the talents, the side -- with one deliberate exception: `record.story`.
 *
 * The reason is that a story is not a score. The rest of this record is a
 * statement about *this week* and the whole point of clearing it is that "what
 * level are you" should not decay into "how long have you been playing" (the
 * header argues that at length). An **act** is the opposite kind of thing: it
 * happened, it is behind you, and the world is supposed to remember. A player
 * who finished the Mutual Obligations arc in March and is handed the first job
 * again in April has not been given a fresh week, they have been told the
 * previous one did not happen.
 *
 * So story flags -- and only story flags -- persist. `record.quests`, which is
 * *in-progress* cursors, is cleared here with the xp: the obligations are
 * weekly and so is the paperwork, and a job abandoned halfway through on
 * Saturday is not waiting on Monday. A quest that was actually finished left a
 * `q:<id>` mark in `story` and is therefore still finished. See
 * `AccountRecord.story` for the kinds of string in that list and
 * `game/questmodel.ts`'s header for the whole arrangement.
 *
 * **WORKSTREAM AN: the exception has an exception, and it is one prefix wide.**
 * A repeatable quest's completion is a statement about *this week* wearing the
 * same clothes as the story -- so it is written `w:<id>` and swept here. That
 * is what makes `content/quests/act1.json`'s two jobs actually weekly rather
 * than merely called weekly: before this they wrote no mark at all and could be
 * handed in and taken again in the same breath. The prefix is
 * `questmodel.WEEKLY_FLAG_PREFIX` rather than a literal, because a Monday that
 * swept the wrong two characters would erase an act and nothing would say so.
 *
 * ---------------------------------------------------------------------------
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
  // The ladder currency itself, which *is* the level -- see `XP_PER_LEVEL`.
  // Zeroed beside the kills rather than derived from them, because after
  // workstream AK the kills are no longer the only source.
  record.xp = 0;
  record.level = 1;
  // In-progress quest cursors, cleared with the xp. **`record.story` is not**;
  // it is the one field on this record that survives, and the block above says
  // why at length.
  record.quests = {};
  // ...except for the weekly completion marks inside it. WORKSTREAM AN; see the
  // header. Reassigned only when something actually goes, so the ordinary
  // Monday for a player with no repeatables behind them costs one walk and no
  // allocation.
  if (record.story.some((flag) => flag.startsWith(WEEKLY_FLAG_PREFIX))) {
    record.story = record.story.filter((flag) => !flag.startsWith(WEEKLY_FLAG_PREFIX));
  }
  // *"persisted to end of week"*, and this is the end of the week. Cleared in
  // the same three lines as the ladder rather than in a rule of its own, so
  // there is exactly one Monday in this feature -- see the header.
  record.lastPos = null;
  // And the talents, for the reason `AccountRecord.talents` gives: a point is a
  // level and the levels have just gone back to one.
  record.talents = { lo: 0, hi: 0 };
  // **And the side.** The owner's call, 2026-08-19: a week is a clean slate,
  // including which of Marita and DeFAULT you are on. The level-2 interstitial
  // therefore comes back every Monday, which is the feature rather than a cost
  // -- the rivalry is re-rolled, nobody is stuck behind a choice they made a
  // fortnight ago, and a player who wants the other side does not have to ask
  // anybody. `TEAM.NONE` is 0 and `Simulation.teamOp` re-opens `CHOOSE` on it
  // with no extra branch.
  record.team = 0;
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
    // Filled in below, once the kills are known: an account written before
    // workstream AK has no `xp` and its ladder position is `kills * XP_PER_KO`.
    xp: 0,
    // Derived rather than read, for `handleKey`'s reason: a stored level that
    // disagreed with the xp beside it is the one number a player checks.
    level: 1,
    levelWeek: typeof raw.levelWeek === 'string' ? raw.levelWeek : '',
    // **Absent is the ordinary case, not an error.** Every account written
    // before this feature existed has no `lastPos`, and so does every account
    // that has never logged off since the last Monday. A parser that treated a
    // missing spot as a bad row would have refused the whole file on the deploy
    // that introduced it.
    lastPos: sanitiseLastPos(raw.lastPos),
    // **Absent is the ordinary case here too**, and more so than for `lastPos`:
    // every account written before teams existed has neither field, and a
    // parser that refused a row without them would have refused the whole file
    // on the deploy that introduced the feature.
    team: sanitiseTeam(raw.team),
    talents: sanitiseTalents(raw.talents),
    // **Absent is the ordinary case for both of these too**, and will be for
    // every row on the box on the deploy that introduces them. See below for
    // the migration, which is exact rather than lossy.
    story: sanitiseStory(raw.story),
    quests: sanitiseQuestCursors(raw.quests),
  };
  /*
   * --- WORKSTREAM AK: the xp migration, in one line, and it is **exact**.
   *
   * Every account written before this pass has kills and no xp. Reconstructing
   * the xp as `kills * XP_PER_KO` is not an approximation: a knockout was the
   * only source of a level before quests existed, so the number this produces
   * is the number that would have been stored had the field always been there,
   * and `levelFor` on it returns bit-for-bit what `levelFor(kills)` returned
   * yesterday.
   *
   * Derived rather than read **when it is absent**, and read when it is
   * present, because once quests are paying, `xp` and `kills * 100` genuinely
   * differ and the stored one is the truth. The `undefined` test is therefore
   * load-bearing and cannot be a `|| 0`: a legitimate row with `xp: 0` and 40
   * kills is a player who was reset this morning, and rebuilding 4000 xp for
   * them would hand back a level the week just took away.
   */
  const storedXp = Number(raw.xp);
  record.xp =
    raw.xp === undefined || !Number.isFinite(storedXp)
      ? record.kills * XP_PER_KO
      : Math.max(0, Math.min(1e9, Math.trunc(storedXp)));
  record.level = levelFor(record.xp);
  // Talents without a side are talents nobody can have spent -- a hand-edited
  // row, or a `team` that was cleared without the mask beside it. Dropped here
  // rather than left for `TeamField`, which would refuse them silently on the
  // team test and leave the *count* of spent points wrong, which is a panel
  // that says "no points left" over an empty tree.
  if (record.team === TEAM.NONE) record.talents = { lo: 0, hi: 0 };
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

/**
 * The story flags off disk: strings, deduplicated, bounded, lower-cased.
 *
 * `sanitiseTalents`' discipline applied to a list, and the reason it is a
 * function rather than a filter inline is that all three of its bounds protect
 * something different. **Lower-casing** makes `q:Act0-Report` and
 * `q:act0-report` one flag rather than a completed quest that is offered again.
 * **Deduplicating** stops a repeatable-turned-story quest writing its mark
 * every week for a year. And the **cap** is the only defence this record has
 * against a content file, which is a thing a person edits on github.com with no
 * compiler in the way.
 *
 * The cap keeps the **oldest** and drops the newest, which is the opposite of
 * what a cache would do and is right here: the oldest flags are the story so
 * far and the newest is one quest. Losing the story to keep the newest job is
 * the wrong half to lose.
 */
export function sanitiseStory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const flag = item.trim().toLowerCase().slice(0, 64);
    if (flag === '' || seen.has(flag)) continue;
    seen.add(flag);
    out.push(flag);
    if (out.length >= MAX_STORY_FLAGS) break;
  }
  return out;
}

/**
 * In-progress cursors off disk, keyed by quest id.
 *
 * Every value re-derived through `questmodel.sanitiseCursor`, which is the same
 * arrangement `lastPos` has with `sanitiseLastPos`: there is one parser for a
 * cursor and this file is not a second copy of it. What this adds is the
 * **key** discipline -- an id that is not an id is dropped rather than becoming
 * a key nothing will ever look up -- and the count bound.
 *
 * Content-free, and it has to be: this runs at load, before any pack has been
 * fetched, so it cannot know whether "act0-doorknock" still exists or how many
 * steps it has. `questmodel.reconcileCursor` is the second half; see its note.
 */
export function sanitiseQuestCursors(value: unknown): Record<string, QuestCursor> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: Record<string, QuestCursor> = {};
  let n = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = key.trim().toLowerCase().slice(0, 64);
    if (id === '' || !/^[a-z0-9][a-z0-9:_-]*$/.test(id)) continue;
    const cursor = sanitiseCursor(raw);
    if (cursor === null) continue;
    out[id] = cursor;
    if (++n >= MAX_OPEN_QUESTS) break;
  }
  return out;
}

/**
 * A team off disk, or `TEAM.NONE`.
 *
 * `sanitiseAccount`'s discipline applied to one number, and the reason it is a
 * function rather than a ternary inline is the same one `sanitiseLastPos` gives:
 * the failure is silent and downstream. A `3` in this field reaches
 * `TEAM_COLOUR[3]`, which is `undefined`, which is a property read on undefined
 * inside the nameplate loop -- the frame, and every frame after it.
 */
export function sanitiseTeam(value: unknown): Team {
  const n = Number(value);
  return n === TEAM.MARITA || n === TEAM.DEFAULT ? (n as Team) : TEAM.NONE;
}

/**
 * A talent mask off disk, with anything that is not a real node dropped.
 *
 * Both halves coerced through `>>> 0` because a hand-edited `1e30` or a `-1`
 * would otherwise reach `hasNode`'s shift arithmetic, where a non-integer
 * produces answers that are stable, wrong and completely invisible: the mask
 * would report nodes nobody took and `countBits` would say the points are
 * spent.
 *
 * The high half is masked to the bits that are actually nodes, on
 * `net/teams.decodeTalents`' argument -- a bit past the last node is a point
 * `countBits` charges for and nothing anywhere draws.
 */
export function sanitiseTalents(value: unknown): TalentMask {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ...EMPTY_MASK };
  const raw = value as Partial<TalentMask>;
  const lo = Number(raw.lo);
  const hi = Number(raw.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { ...EMPTY_MASK };
  const hiMask = NODE_COUNT <= 32 ? 0 : (0xffffffff >>> (64 - NODE_COUNT)) | 0;
  const loMask = NODE_COUNT >= 32 ? -1 : (0xffffffff >>> (32 - NODE_COUNT)) | 0;
  return { lo: (Math.trunc(lo) & loMask) >>> 0, hi: (Math.trunc(hi) & hiMask) >>> 0 };
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

// --- Signing in with somebody else's account -------------------------------------------

/**
 * The handle a social sign-in gets, given who is already registered.
 *
 * **The rule that matters is the one it refuses to break: a provider identity
 * never lands on an account that already exists.** Reddit hands back a name,
 * and somewhere in a city of players there is already a Bazza -- so "log in
 * with Reddit as Bazza, be given Bazza's account" is account takeover wearing a
 * convenience feature. If the obvious handle is taken, the new player gets a
 * free variant and the existing Bazza never learns any of this happened.
 *
 * The *identity* is the provider's subject id, never the name: Reddit lets
 * people rename, and a link keyed on the name would silently follow the name to
 * whoever picks it up next.
 *
 * Returns `''` when nothing usable can be made, which the caller must treat as
 * a refusal rather than as a blank handle.
 */
export function providerHandle(raw: string, taken: (handle: string) => boolean): string {
  const base = sanitiseHandle(raw);
  if (base !== '' && !taken(base)) return base;
  // A short numeric suffix rather than a random string: it stays inside the
  // sixteen-character cap, it reads as a person rather than as a hash, and it
  // is what every forum has done since forums existed.
  const stem = base === '' ? 'player' : base;
  for (let n = 2; n <= 999; n++) {
    const suffix = String(n);
    const room = MAX_NAME_CHARS - suffix.length;
    const candidate = sanitiseHandle(stem.slice(0, Math.max(1, room)) + suffix);
    if (candidate !== '' && !taken(candidate)) return candidate;
  }
  return '';
}

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
  //
  // WORKSTREAM AK: **written in kills and asserted through xp**, which is the
  // point. The whole claim of that change is that `1000 xp per level` and
  // `100 xp per knockout` reproduce `10 kills per level` exactly, and a table
  // written in xp would be a table that agreed with the new constants rather
  // than with the old behaviour. These are the same six rows as before, put
  // through the conversion.
  {
    const cases: Array<[number, number]> = [
      [0, 1], [1, 1], [9, 1], [10, 2], [19, 2], [20, 3], [100, 11],
    ];
    for (const [kills, want] of cases) {
      const got = levelFor(kills * XP_PER_KO);
      if (got !== want) failures.push(`${kills} kills is level ${got}, not ${want}. The xp ladder must reproduce the kill ladder exactly.`);
    }
    if (KILLS_PER_LEVEL !== 10) failures.push(`${KILLS_PER_LEVEL} kills a level; the owner's rule is ten.`);
    if (levelFor(-5) !== 1) failures.push('Negative xp produced a level other than 1.');
    if (levelFor(NaN) !== 1) failures.push('NaN xp produced a level other than 1.');
    if (levelFor(1e9) > 255) failures.push('A level over 255 was produced; the roster carries it as a u8.');
    // The roster's `u16` cannot wrap before the level clamps, or a player past
    // level 66 watches their bar reset while their level does not.
    if (koEquivalent(xpForLevel(MAX_LEVEL)) > 65535) {
      failures.push(`Level ${MAX_LEVEL} is ${koEquivalent(xpForLevel(MAX_LEVEL))} ko-equivalents, past the roster's u16.`);
    }
    if (koEquivalent(250) !== 2) failures.push(`250 xp is ${koEquivalent(250)} ko-equivalents on the roster, not 2.`);
    if (koEquivalent(-1) !== 0 || koEquivalent(NaN) !== 0) failures.push('Nonsense xp produced a non-zero roster field.');
    // The inverse, in the currency the bar is drawn in.
    for (let level = 1; level <= 12; level++) {
      if (levelFor(xpForLevel(level)) !== level) {
        failures.push(`xpForLevel(${level}) is ${xpForLevel(level)}, which is level ${levelFor(xpForLevel(level))}.`);
      }
    }
    // The inverse has to agree with the forward direction at every boundary, or
    // the HUD's "3 kills to go" counts down to a level-up that does not happen.
    for (let level = 1; level <= 12; level++) {
      const at = killsForLevel(level);
      if (!Number.isInteger(at)) failures.push(`killsForLevel(${level}) is ${at}, which is not a whole number of knockouts.`);
      if (levelFor(at * XP_PER_KO) !== level) {
        failures.push(`killsForLevel(${level}) is ${at}, which is level ${levelFor(at * XP_PER_KO)}.`);
      }
      if (at > 0 && levelFor((at - 1) * XP_PER_KO) !== level - 1) {
        failures.push(`One kill short of level ${level} is level ${levelFor((at - 1) * XP_PER_KO)}, not ${level - 1}.`);
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
    record.xp = 34 * XP_PER_KO;
    record.level = levelFor(record.xp);
    // WORKSTREAM AK: the two new fields, one on each side of Monday. Set here
    // rather than in a section of their own because the *contrast* is the rule
    // -- reading them ten lines apart is what makes "story survives, cursors do
    // not" checkable rather than remembered.
    // WORKSTREAM AN: three flags, and the middle one is the whole point --
    // `w:` is a completion that is only true this week and must not be here on
    // the other side of the reset, while the two beside it must.
    record.story = ['q:act0-report', 'w:act1-marita-roundup', 'act0:reported'];
    record.quests = { 'act0-doorknock': { s: 1, c: [1, 0], d: false } };
    if (resetIfNewWeek(record, now)) failures.push('A record already in the current week was reset.');
    if (record.kills !== 34) failures.push('A same-week reset zeroed the kills anyway.');
    if (record.xp !== 3400) failures.push('A same-week reset zeroed the xp anyway.');
    record.levelWeek = '2020-W01';
    if (!resetIfNewWeek(record, now)) failures.push('A record from an old week was not reset.');
    if (record.kills !== 0 || record.level !== 1) {
      failures.push(`A weekly reset left ${record.kills} kills at level ${record.level}; both must go to the floor.`);
    }
    if (record.xp !== 0) failures.push(`A weekly reset left ${record.xp} xp; the xp is the level and the level is 1.`);
    // **The one field that survives.** A story that resets weekly is not one;
    // see `resetIfNewWeek`'s header, which argues it at length.
    if (record.story.length !== 2 || !record.story.includes('q:act0-report') || !record.story.includes('act0:reported')) {
      failures.push(
        `A weekly reset left ${JSON.stringify(record.story)} in the story flags. They must survive Monday, or a ` +
          'player who finished an act in March is handed the first job again in April.',
      );
    }
    // WORKSTREAM AN: and the one that must **not** survive, which is the other
    // half of the same rule. A weekly mark left standing is a repeatable that
    // never comes round again -- silently, for the rest of that account's life.
    if (record.story.some((f) => f.startsWith(WEEKLY_FLAG_PREFIX))) {
      failures.push(
        `A weekly reset kept ${JSON.stringify(record.story.filter((f) => f.startsWith(WEEKLY_FLAG_PREFIX)))}. ` +
          'A "done this week" mark that survives the week is a weekly job that never comes back.',
      );
    }
    // And the one beside it that does not.
    if (Object.keys(record.quests).length !== 0) {
      failures.push('A weekly reset kept an in-progress quest cursor; the obligations are weekly and so is the paperwork.');
    }
    if (record.levelWeek !== weekOf(now)) failures.push('A weekly reset did not stamp the new week; it would reset again next tick.');
    if (resetIfNewWeek(record, now)) failures.push('The weekly reset is not idempotent; it would fire on every read.');
  }

  // --- WORKSTREAM AK: the xp field's migration, the story list, and the
  // cursors, off the rows that will really be on the box.
  {
    const now = Date.UTC(2026, 7, 19, 3, 0, 0);
    /*
     * **The migration, which is the one that costs a level when it is wrong.**
     *
     * Every account on the box on the deploy that lands this has kills and no
     * `xp`, and the claim is that reconstructing it is exact. If it is not, the
     * whole box drops to level 1 on a restart and there is nothing on screen
     * that says why.
     */
    const old = sanitiseAccount({ id: 'x', handle: 'Bazza', passwordHash: '$argon2id$x', kills: 34, levelWeek: weekOf(now) }, now);
    if (!old) {
      failures.push('An account written before xp existed was refused off disk.');
    } else {
      if (old.xp !== 3400) failures.push(`A pre-xp row with 34 kills came back with ${old.xp} xp, not 3400.`);
      if (old.level !== 4) failures.push(`A pre-xp row with 34 kills came back at level ${old.level}, not 4.`);
      if (old.story.length !== 0) failures.push('A pre-quests row came back with story flags.');
      if (Object.keys(old.quests).length !== 0) failures.push('A pre-quests row came back with quest cursors.');
    }
    // And the case that makes the `undefined` test load-bearing rather than a
    // `|| 0`: a row reset this morning legitimately has 0 xp beside 0 kills,
    // and one mid-week has xp that is **not** kills x 100 because a quest paid.
    const paid = sanitiseAccount({ ...fakeAccount(now), kills: 3, xp: 900 }, now);
    if (paid?.xp !== 900) failures.push(`A row whose xp is not kills x 100 was rewritten to ${paid?.xp}; quest xp would vanish.`);
    if (paid?.level !== 1) failures.push(`900 xp came back as level ${paid?.level}, not 1.`);
    const zeroed = sanitiseAccount({ ...fakeAccount(now), kills: 40, xp: 0 }, now);
    if (zeroed?.xp !== 0) failures.push('A row with a stored xp of 0 had it rebuilt from the kills; the week would be un-done.');

    // The story list: folded, deduplicated, bounded.
    const messy = sanitiseStory(['Q:Act0-Report', 'q:act0-report', '  act0:reported  ', 42, '', null]);
    if (messy.length !== 2) failures.push(`A messy story list came back with ${messy.length} flags, not 2.`);
    if (messy[0] !== 'q:act0-report') failures.push(`A story flag came back as ${JSON.stringify(messy[0])}; they fold to lower case.`);
    const flood = sanitiseStory(Array.from({ length: MAX_STORY_FLAGS + 50 }, (_, i) => `f${i}`));
    if (flood.length > MAX_STORY_FLAGS) failures.push(`${flood.length} story flags survived, over the ${MAX_STORY_FLAGS} cap.`);
    if (flood[0] !== 'f0') failures.push('The story cap dropped the oldest flags; the oldest are the story.');
    for (const raw of [null, 'act0', 42, {}]) {
      if (sanitiseStory(raw).length !== 0) failures.push(`sanitiseStory(${JSON.stringify(raw)}) produced flags.`);
    }

    // The cursors: keys checked, values through the one parser, count bounded.
    const cursors = sanitiseQuestCursors({
      'act0-doorknock': { s: 1, c: [1, 0], d: false },
      'NOT AN ID': { s: 0, c: [0] },
      'act0-bad': 'halfway',
    });
    if (Object.keys(cursors).length !== 1) failures.push(`${Object.keys(cursors).length} cursors survived, not 1.`);
    if (cursors['act0-doorknock']?.s !== 1) failures.push('A well-formed cursor lost its step index.');
    const many = sanitiseQuestCursors(
      Object.fromEntries(Array.from({ length: MAX_OPEN_QUESTS + 10 }, (_, i) => [`q${i}`, { s: 0, c: [0] }])),
    );
    if (Object.keys(many).length > MAX_OPEN_QUESTS) failures.push(`${Object.keys(many).length} cursors survived, over the cap.`);
    for (const raw of [null, [], 'nope']) {
      if (Object.keys(sanitiseQuestCursors(raw)).length !== 0) failures.push(`sanitiseQuestCursors(${JSON.stringify(raw)}) produced cursors.`);
    }

    // A record carrying both survives a round trip through the parser, which is
    // the whole of "progress persists".
    const full = sanitiseAccount(
      { ...fakeAccount(now), xp: 1200, story: ['q:act0-report'], quests: { 'act0-doorknock': { s: 0, c: [2], d: false } } },
      now,
    );
    if (full?.story[0] !== 'q:act0-report') failures.push('A record lost its story flags in the parser.');
    if (full?.quests['act0-doorknock']?.c[0] !== 2) failures.push('A record lost its quest progress in the parser.');
    if (full?.level !== 2) failures.push(`1200 xp came back as level ${full?.level}, not 2.`);
    // The completion mark's spelling, which is the only thing standing between
    // "you have done that" and a story quest that is offered every day.
    if (completionFlag('act0-report') !== 'q:act0-report') {
      failures.push(`completionFlag is ${JSON.stringify(completionFlag('act0-report'))}; the engine and the parser must agree.`);
    }
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
      if (good.level !== levelFor(25 * XP_PER_KO)) failures.push(`A stored level of 99 survived beside ${good.kills} kills.`);
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
    // --- The building, and its one rule: bad is the street, not a refusal.
    //
    // Every account on the box takes the "absent" branch on the deploy that
    // introduces the field, and a parser that refused those rows would have
    // thrown away every saved position in Sydney to add a feature about two of
    // them. See `LastPos.building`.
    {
      const outside = sanitiseLastPos({ x: 1, y: 2, z: 3, yaw: 0, savedMs: now });
      if (outside === null || outside.building !== 0) {
        failures.push('a spot saved before interiors did not come back as being outdoors.');
      }
      for (const bad of [-1, 0, 1e12, Number.NaN, 'pub', null, {}]) {
        const got = sanitiseLastPos({ x: 1, y: 2, z: 3, yaw: 0, building: bad, savedMs: now });
        if (got === null) failures.push(`a spot with a building of ${String(bad)} was refused entirely; its position went with it.`);
        else if (got.building !== 0) failures.push(`a building of ${String(bad)} survived as ${got.building}; a player would log in inside a room that does not exist.`);
      }
      const inside = sanitiseLastPos({ x: 1, y: 2, z: 3, yaw: 0, building: 0xdeadbeef, savedMs: now });
      if (inside === null || inside.building !== 0xdeadbeef) {
        failures.push('a spot saved indoors did not survive; logging off inside would not bring you back.');
      }
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
    record.lastPos = { x: 10, y: 0, z: 20, yaw: 0, building: 0, savedMs: now };
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

  // --- The side and the points, which both go on Monday. There is no way to
  // notice getting this wrong until a Monday, so it is asserted here.
  {
    const now = Date.UTC(2026, 7, 19, 3, 0, 0);
    const record = fakeAccount(now);
    record.team = TEAM.MARITA;
    record.talents = { lo: 0b1001, hi: 1 };
    record.kills = 34;
    record.xp = 34 * XP_PER_KO;
    record.level = levelFor(record.xp);
    if (resetIfNewWeek(record, now)) failures.push('A record already in the current week was reset.');
    if (record.talents.lo !== 0b1001) failures.push('A same-week reset cleared the talents anyway.');
    record.levelWeek = '2020-W01';
    resetIfNewWeek(record, now);
    // Read through a widened local: TypeScript narrowed the field to `MARITA`
    // at the assignment above and cannot see that `resetIfNewWeek` moved it.
    const sideAfter = record.team as Team;
    if (sideAfter !== TEAM.NONE) {
      failures.push(`A weekly reset left the account on ${TEAM_NAME[sideAfter]}; the side goes with the level, so Monday asks again.`);
    }
    if (record.talents.lo !== 0 || record.talents.hi !== 0) {
      failures.push(`A weekly reset left ${JSON.stringify(record.talents)} spent on a level-1 character.`);
    }

    // The parser, on the rows a file can really contain -- including every row
    // written before this feature existed, which has neither field.
    const old = sanitiseAccount(
      { id: 'x', handle: 'Bazza', passwordHash: '$argon2id$x', kills: 0, levelWeek: weekOf(now) },
      now,
    );
    if (!old) failures.push('An account written before teams existed was refused off disk.');
    else if (old.team !== TEAM.NONE || old.talents.lo !== 0 || old.talents.hi !== 0) {
      failures.push(`A pre-teams row came back as team ${old.team} / ${JSON.stringify(old.talents)}.`);
    }
    const chosen = sanitiseAccount(
      { ...fakeAccount(now), team: 2, talents: { lo: 5, hi: 2 } },
      now,
    );
    if (chosen?.team !== TEAM.DEFAULT || chosen.talents.lo !== 5 || chosen.talents.hi !== 2) {
      failures.push(`A chosen side and a spent mask came back as ${chosen?.team} / ${JSON.stringify(chosen?.talents)}.`);
    }
    // And the rows a text editor produces.
    for (const [raw, want] of [[3, TEAM.NONE], [-1, TEAM.NONE], ['Marita', TEAM.NONE], [1, TEAM.MARITA]] as Array<[unknown, Team]>) {
      if (sanitiseTeam(raw) !== want) failures.push(`sanitiseTeam(${JSON.stringify(raw)}) is ${sanitiseTeam(raw)}, not ${want}.`);
    }
    for (const raw of [null, 'all of them', [], { lo: Number.NaN, hi: 0 }, { lo: 1e300, hi: 0 }]) {
      const mask = sanitiseTalents(raw);
      if (!Number.isInteger(mask.lo) || !Number.isInteger(mask.hi) || mask.lo < 0 || mask.hi < 0) {
        failures.push(`sanitiseTalents(${JSON.stringify(raw)}) gave ${JSON.stringify(mask)}, which is not a pair of u32s.`);
      }
    }
    // Bits past the last real node are points `countBits` would charge for and
    // nothing would ever draw.
    const wide = sanitiseTalents({ lo: 0xffffffff, hi: 0xffffffff });
    if (wide.hi >= 2 ** (NODE_COUNT - 32)) {
      failures.push(`A mask with bits past node ${NODE_COUNT - 1} survived as ${wide.hi.toString(16)}.`);
    }
    // A mask with no side behind it is not a build.
    const orphan = sanitiseAccount({ ...fakeAccount(now), team: 0, talents: { lo: 0xff, hi: 0 } }, now);
    if (orphan?.talents.lo !== 0) failures.push('Talents survived on a record with no team; they are points nobody can have spent.');
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

  // --- **A social sign-in never lands on somebody else's account.**
  //
  // Reddit hands back a name, and somewhere in a city of players there is
  // already a Bazza. "Log in with Reddit as Bazza, be given Bazza's account" is
  // account takeover wearing a convenience feature, and it is the one way this
  // feature can hurt somebody who never used it.
  {
    const registered = new Set(['bazza', 'shazza']);
    const taken = (h: string): boolean => registered.has(h.toLowerCase());

    const free = providerHandle('Drongo', taken);
    if (free !== 'Drongo') failures.push(`an unused handle was not granted as-is (${JSON.stringify(free)}).`);

    const clash = providerHandle('Bazza', taken);
    if (clash === '') failures.push('a social sign-in whose name is taken was refused a handle entirely.');
    if (taken(clash)) {
      failures.push(
        `a social sign-in was handed ${JSON.stringify(clash)}, which already belongs to somebody -- ` +
          `that is account takeover.`,
      );
    }
    if (!clash.toLowerCase().startsWith('bazza')) {
      failures.push(`a clashing handle became ${JSON.stringify(clash)}, which no longer resembles the name asked for.`);
    }

    // A name that sanitises away entirely still gets somebody a handle.
    const junk = providerHandle('***', taken);
    if (junk === '') failures.push('a name that sanitises to nothing left the player with no handle at all.');
    if (taken(junk)) failures.push('the fallback handle collided with a registered one.');

    // The suffix must stay inside the wire's cap, or the handle is unsendable.
    const longName = providerHandle('x'.repeat(40), taken);
    if ([...longName].length > MAX_NAME_CHARS) {
      failures.push(`a long provider name produced a ${[...longName].length}-character handle, over the ${MAX_NAME_CHARS} cap.`);
    }

    // And a crowded namespace still terminates rather than looping or
    // returning something taken.
    const crowded = new Set<string>();
    for (let i = 0; i < 200; i++) crowded.add(providerHandle('Bazza', (h) => crowded.has(h.toLowerCase())).toLowerCase());
    if (crowded.has('')) failures.push('a crowded namespace eventually returned an empty handle.');
    if (crowded.size !== 200) failures.push(`200 sign-ins for one name produced ${crowded.size} distinct handles; two players would share one.`);
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
    xp: 0,
    level: 1,
    levelWeek: weekOf(now),
    lastPos: null,
    team: TEAM.NONE,
    talents: { ...EMPTY_MASK },
    story: [],
    quests: {},
  };
}
