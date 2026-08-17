/**
 * The suggestions box: what players ask for, and how the asking is counted.
 *
 * Imported by `client/src/suggestions.ts` (the panel), by `server/suggestions.ts`
 * (the ledger and the GitHub mirror) and by `server/index.ts` (the socket), from
 * the same path and for `net/protocol.ts`'s founding reason: an encoder and a
 * decoder that are two files are two files that disagree, and here the
 * disagreement is a vote counted against the wrong week.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE FEATURE IS
 *
 * A player presses Escape with nothing else open, writes a sentence about a
 * mechanic they want changed, and it becomes a **GitHub issue on the repo**,
 * labelled `suggestion`, permanently. Everyone else sees it in the same panel,
 * ranked, and can up or down it. Four votes a week each. At the end of a week
 * the highest-scoring suggestion is the one that gets built.
 *
 * Nobody leaves the game to do any of it. That is the whole requirement, and it
 * is what every decision below is downstream of: there is no OAuth flow, no
 * "sign in with GitHub", no link that opens a tab. A player who has never heard
 * of GitHub can file a suggestion and vote on four of them.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE TWO HALVES LIVE, AND WHY THEY ARE TWO HALVES
 *
 * **The suggestions are GitHub's. The votes are ours.**
 *
 * The suggestion is the permanent record and it belongs somewhere permanent
 * that the person who curates it already reads. That is an issue: it survives
 * the server being rebuilt, it can be commented on, closed, labelled and
 * searched, and at the end of the week the user picks the top one off a list
 * they were going to look at anyway.
 *
 * The votes cannot go there, and the reason is not a preference. Every call
 * this server makes to GitHub is made with **one token belonging to one
 * account**, so a reaction added on a player's behalf is a reaction from the
 * bot -- a hundred players voting would be one 👍 that toggles. Reactions carry
 * exactly one bit per account and there is only ever one account. So the tally
 * is a local ledger keyed by a client id, and the *result* is mirrored into the
 * issue body so the curator can read it in the place they are curating from.
 *
 * The mirror is one-directional and the ledger wins. An issue body edited by
 * hand is overwritten on the next flush, which is stated in the block itself.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY, HONESTLY
 *
 * There is no login in this game and this feature does not add one. A vote is
 * attributed to a **client id**: a UUID minted in `localStorage` on first play,
 * beside the `sydney.name` that is already there, and sent with the vote.
 *
 * That is **a claim, not proof**, and the docs should not pretend otherwise:
 *
 *   - Clearing site data mints a new id and refills the weekly quota.
 *   - A private window is a fresh id.
 *   - Anyone who can open a WebSocket can send any id they like, including
 *     somebody else's -- which lets them *spend* another player's quota, not
 *     read anything of theirs. There is nothing behind the id to steal.
 *
 * The secondary cap is a **per-IP weekly limit**, `IP_VOTES_PER_WEEK`, which is
 * the speed bump rather than the lock: it means stuffing the ballot from one
 * machine costs a new address per handful of votes rather than a browser
 * refresh. It is defeated by a phone on mobile data and it is meant to be
 * defeatable by one. The address is stored **hashed** (see
 * `server/suggestions.ts`) because a plain list of the IP of everyone who ever
 * voted is not something this game needs to own.
 *
 * This is a friendly game and its suggestions box is not an election. The
 * honest summary is: it costs a determined person about a minute to add four
 * votes, and the curator has the final say every week regardless -- which is
 * the actual defence, and the only one that ever really works at this scale.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANIC
 *
 *   - **Score** is all-time ups minus all-time downs. Not per-week: the user's
 *     brief is that votes *stack up over time if someone consistently votes on
 *     something*, so a suggestion nobody has got to yet climbs steadily across
 *     the weeks rather than being reset every Monday and never winning.
 *   - **Four votes a week**, per client id, and **one vote per suggestion per
 *     week**. Those two rules together are the stacking mechanic: you cannot
 *     spend all four on your favourite today, but you can spend one on it every
 *     week for a month.
 *   - **A week is an ISO week in Australia/Sydney**, so it turns over at Monday
 *     00:00 local -- the same Monday the curator's week turns over on. See
 *     `weekKey`, which does the whole of the time-zone thinking in one place.
 *   - **Order** is score descending, then most recent activity, then issue
 *     number. Three keys because two is not a total order and a list that
 *     reshuffles between refreshes reads as a bug.
 */

// --- The wire ----------------------------------------------------------------

/**
 * The client's half of this feature, in **one** message id with a sub-op byte.
 *
 * `net/protocol.ts`'s `MSG` has a rule this has to live inside: *client messages
 * are under 0x80 and server messages are at or over it*, so a frame that arrives
 * at the wrong end is rejected by a range test rather than misparsed. This
 * feature was allocated 0x8c-0x8f, which is entirely in the server's half -- so
 * the two server-to-client messages take ids there (`MSG.SUGGEST_LIST`,
 * `MSG.SUGGEST_ACK`) and everything travelling the other way rides this single
 * low id, discriminated by its second byte.
 *
 * One id rather than three is not only about the range. Three client ids would
 * be three cases in `server/index.ts`'s switch for what is one conversation, and
 * the flood guard -- which is per-socket and counts *this feature's* traffic --
 * would have had to be summed across three arms of it.
 */
export const SUGGEST_OP = {
  /** "Send me the list." Also the panel's open. */
  LIST: 0,
  /** A new suggestion: title and body. */
  SUBMIT: 1,
  /** Up or down on one suggestion. */
  VOTE: 2,
} as const;

/** `SUGGEST_ACK`'s result byte. 0 is the only success. */
export const SUGGEST_RESULT = {
  OK: 0,
  /** Malformed, or a title that sanitised to nothing. */
  BAD: 1,
  /** Out of votes this week, or already voted on this one this week. */
  QUOTA: 2,
  /** Too fast. The flood guard, not the weekly quota. */
  RATE: 3,
  /** Voted on something that is not there -- closed, or never existed. */
  UNKNOWN: 4,
  /** Accepted and stored, but not yet on GitHub. See `SuggestionState`. */
  QUEUED: 5,
  /**
   * Refused: this socket has no account. See `client/src/net/accounts.ts`.
   *
   * A code of its own rather than folding into `BAD`, and it is worth the byte.
   * The panel colours `BAD` as "you did something wrong, fix it and try again"
   * and keeps the compose box; this is *"you cannot do this yet, here is how"*
   * and the panel answers it with a sign-up button rather than a red line. A
   * shared code is the only way both ends can agree which of those two a
   * refusal is -- the message text is a sentence for a human and is not
   * something the client should be matching on.
   *
   * Added without a protocol bump because `SUGGEST_ACK` has always carried the
   * result as an opaque byte and `SuggestionsPanel.ack` has always treated
   * anything that is not `OK`/`QUEUED` as a failure with a message. An older
   * client meeting this code shows the sentence in red, which is correct if
   * plainer.
   */
  ACCOUNT: 6,
} as const;

/**
 * A suggestion's relationship with GitHub, which is not the same as its
 * relationship with the game.
 *
 * `pending-sync` is the state that makes this feature work **before the user has
 * created a token at all**, and it is the reason the whole thing is not blocked
 * on a credential:
 *
 *   - `open`        on GitHub, has an issue number, votable.
 *   - `pending-sync` accepted, in the ledger, votable, **no issue number yet**.
 *                    Drains to GitHub the moment a token appears, keeping every
 *                    vote it collected in the meantime.
 *   - `closed`      closed on GitHub. Stays in the ledger with its score (it is
 *                    the record of a week that was won) and is not sent to the
 *                    panel.
 *   - `failed`      GitHub refused it -- a repo that does not exist, a token
 *                    without Issues:write. Retried on a slow backoff; visible in
 *                    the server log rather than to the player, who has already
 *                    been told it is queued.
 */
export type SuggestionState = 'open' | 'pending-sync' | 'closed' | 'failed';

// --- Text --------------------------------------------------------------------

/**
 * The caps, in **bytes** rather than characters, and that is deliberate.
 *
 * `server/index.ts` sets `maxPayloadLength: 1024` on the socket, which is a
 * frame budget this feature has to fit inside rather than a number to raise:
 * every other message on this wire is tens of bytes and the limit is what stops
 * a hostile client from making the server allocate. 4 + 36 + 120 + 600 = 760,
 * which leaves room and needs no change to a shared line.
 *
 * Characters would have been friendlier to write in the UI and wrong here: a
 * title of forty emoji is 160 bytes, and a cap that counts code points lets one
 * hostile client send four times what an honest one can.
 */
export const MAX_TITLE_BYTES = 120;
export const MAX_BODY_BYTES = 600;
/** What the panel's counters show. Bytes are what is enforced; see `fitBytes`. */
export const MAX_TITLE_CHARS = 90;
export const MAX_BODY_CHARS = 400;
export const MIN_TITLE_CHARS = 6;

/** A UUID as `crypto.randomUUID` writes it. 36 bytes, fixed, never variable. */
export const CLIENT_ID_BYTES = 36;

const ENC = new TextEncoder();
const DEC = new TextDecoder();

/**
 * The markers the tally block is delimited by, and the one sequence player text
 * is not allowed to contain.
 *
 * `server/suggestions.ts` rewrites everything between these two comments every
 * time a score changes, by finding them in the body it last wrote. A player who
 * could type `<!-- /sydney:tally -->` into their suggestion would end the block
 * early, and the next rewrite would eat the rest of their own text and then
 * somebody's score -- so `sanitiseText` neutralises **every** HTML comment
 * opener and closer rather than just these two strings. Blunt on purpose: a
 * suggestion has no legitimate use for `<!--`, and a filter that tried to allow
 * the harmless cases is a filter with an edge nobody has thought of.
 */
export const TALLY_OPEN = '<!-- sydney:tally -->';
export const TALLY_CLOSE = '<!-- /sydney:tally -->';

function invisible(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Player text, reduced to something that can be put in a GitHub issue and drawn
 * in a panel without lying about either.
 *
 * Run on **both ends** and idempotent, on `protocol.sanitiseName`'s exact
 * argument: the client runs it so the compose box shows what will be posted, the
 * server runs it again and does not trust the first run, and a second pass that
 * differed would be a suggestion that changes as it crosses the wire.
 *
 * What it does, and why each one is here rather than tolerated:
 *
 *   - **Control characters become spaces**, except the newline when newlines are
 *     allowed -- a body is a few lines and a title is one. A control character
 *     was a separator to whoever typed it, so deleting it joins two words.
 *   - **Invisibles are dropped.** A run of zero-width spaces is a suggestion
 *     that occupies a row and says nothing; a bidi override reverses everything
 *     the *panel* drew after it, including the score.
 *   - **HTML comment sequences are broken.** See `TALLY_OPEN`.
 *   - **Backticks and the markdown that eats a document are left alone**, with
 *     one exception. GitHub renders the body as markdown and that is fine --
 *     somebody who wants a bulleted list should get one. What is not fine is
 *     text that escapes its own block, and the only construct that can is the
 *     comment. A heading is just a big heading.
 *   - **Runs of blank lines collapse**, so a body cannot be a thousand newlines
 *     that push the tally block off the first screen of the issue.
 */
export function sanitiseText(raw: string, multiline: boolean): string {
  let cleaned = '';
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (multiline && ch === '\n') {
      cleaned += '\n';
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      cleaned += ' ';
      continue;
    }
    if (invisible(code)) continue;
    cleaned += ch;
  }
  // The comment sequences, broken rather than deleted, so the player can see
  // what happened to what they typed instead of finding characters missing.
  cleaned = cleaned.replace(/<!--/g, '<!‑-').replace(/-->/g, '-‑>');
  if (multiline) {
    // Horizontal whitespace collapses; vertical whitespace collapses to at most
    // one blank line. Two passes rather than one regex because `\s` matches the
    // newline and would flatten the body into a paragraph.
    cleaned = cleaned.replace(/[^\S\n]+/gu, ' ');
    cleaned = cleaned.replace(/[ ]*\n[ ]*/g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    cleaned = cleaned.replace(/\s+/gu, ' ');
  }
  return cleaned.trim();
}

/**
 * Clip to a byte budget **at a code-point boundary**.
 *
 * The naive `slice(0, n)` on the encoded array cuts a multi-byte sequence in
 * half, and `TextDecoder` turns the remainder into U+FFFD -- so a title of emoji
 * arrives on GitHub ending in a black diamond. Walking code points is O(n) on a
 * string that is at most a few hundred bytes.
 */
export function fitBytes(text: string, maxBytes: number): string {
  if (ENC.encode(text).length <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const n = ENC.encode(ch).length;
    if (used + n > maxBytes) break;
    out += ch;
    used += n;
  }
  return out.trim();
}

/** A title: one line, sanitised, clipped, and refused if there is nothing left. */
export function sanitiseTitle(raw: string): string {
  const t = fitBytes(sanitiseText(raw, false), MAX_TITLE_BYTES);
  return [...t].length < MIN_TITLE_CHARS ? '' : t;
}

/** A body: a few lines, sanitised, clipped. May legitimately be empty. */
export function sanitiseBody(raw: string): string {
  return fitBytes(sanitiseText(raw, true), MAX_BODY_BYTES);
}

/**
 * Is this a client id we are willing to key a ledger on?
 *
 * Shape only, and the shape is `crypto.randomUUID`'s. It proves nothing about
 * who sent it -- see this file's header -- and that is not what it is for: it is
 * for keeping the ledger's key space finite and its file readable. A client that
 * sent 36 bytes of anything else gets its own row and nobody else's.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function validClientId(id: string): boolean {
  return UUID_RE.test(id);
}

// --- The week ----------------------------------------------------------------

/**
 * The one place in this feature that knows what time it is in Sydney.
 *
 * Returns an ISO week key -- `2026-W32` -- for an instant, computed in
 * **Australia/Sydney** wall-clock time. Everything else in the feature compares
 * these strings and never touches a `Date`, which is what keeps the daylight
 * saving question answered once.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS DONE THIS WAY
 *
 * The tempting implementation is arithmetic on the epoch: divide by 604800000
 * and offset for the boundary. It is wrong twice a year, and the failure is
 * quiet -- one Sunday in April a player's quota resets an hour early, and one
 * Sunday in October an hour late, which nobody ever reports as a bug because
 * they were not counting.
 *
 * So: ask `Intl` for the **civil date in Sydney** at that instant -- which is
 * the one thing time-zone data actually knows and offset arithmetic does not --
 * and compute the ISO week from that date alone. A week boundary is Monday
 * 00:00 Sydney local, and mapping the instant to the local date makes that
 * automatic: the instant one second before the boundary is Sunday's date and the
 * instant after is Monday's, on a normal weekend and on both changeover
 * weekends, because `Intl` applied the right offset to each.
 *
 * `en-CA` for the format because it is `YYYY-MM-DD`, which parses with a slice
 * rather than a lookup table of month names.
 */
const SYDNEY_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Australia/Sydney',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The civil date in Sydney at `at`, as `[year, month, day]` with month 1-12. */
export function sydneyDate(at: number | Date): [number, number, number] {
  const s = SYDNEY_DATE.format(at instanceof Date ? at : new Date(at));
  // `en-CA` gives `2026-08-05`. Parsed by index because a locale that decided to
  // add an era would break a regex and not this.
  return [Number(s.slice(0, 4)), Number(s.slice(5, 7)), Number(s.slice(8, 10))];
}

/**
 * ISO 8601 week of a civil date: week 1 is the one containing the first
 * Thursday, weeks start on Monday, and the *year* is the week's year rather than
 * the date's -- so 1 January 2027 is `2026-W53`, which is the case a naive
 * implementation gets wrong on precisely one day a year.
 */
export function isoWeekOf(year: number, month: number, day: number): string {
  // A UTC date used purely as a calendar. There is no time zone in this
  // calculation at all -- the zone was applied by `sydneyDate` above, and doing
  // it twice is the classic double-offset bug.
  const d = new Date(Date.UTC(year, month - 1, day));
  // Shift to the Thursday of this ISO week: everything about ISO weeks is
  // defined by which year that Thursday lands in.
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0 .. Sunday 6
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDow = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** The ISO week an instant falls in, Sydney time. The ledger's only clock. */
export function weekKey(at: number | Date = Date.now()): string {
  const [y, m, d] = sydneyDate(at);
  return isoWeekOf(y, m, d);
}

/**
 * When the current week ends, as milliseconds from `at`.
 *
 * Only ever shown to a player ("votes reset in 3 days"), never used to decide
 * anything -- the decision is always a `weekKey` string comparison, because a
 * countdown that was a minute out would hand somebody a fifth vote. Found by
 * stepping forward a day at a time until the key changes and then bisecting to
 * the minute, which is slower than arithmetic and cannot be wrong across a
 * changeover: it asks the same function the quota asks.
 */
export function weekEndsInMs(at: number = Date.now()): number {
  const now = weekKey(at);
  const DAY = 86400000;
  let lo = at;
  let hi = at;
  for (let i = 0; i < 9 && weekKey(hi) === now; i++) hi += DAY;
  if (weekKey(hi) === now) return 7 * DAY;
  // Bisect to the minute. Ten steps over a day is 84 seconds; twelve is 21.
  for (let i = 0; i < 12; i++) {
    const mid = Math.floor((lo + hi) / 2);
    if (weekKey(mid) === now) lo = mid;
    else hi = mid;
  }
  return Math.max(0, hi - at);
}

// --- The rules ---------------------------------------------------------------

/**
 * Four votes a week, and the number is the user's.
 *
 * *"users get to up or down vote 4 things, once per week, so votes can stack up
 * over time if someone consistently votes on something"* -- so four is a budget
 * spent across four **different** suggestions (`ONE_VOTE_PER_ITEM_PER_WEEK`
 * below is what makes that true) and it refills on Monday.
 */
export const VOTES_PER_WEEK = 4;
/**
 * Two suggestions a week each.
 *
 * Lower than the vote quota on purpose: writing is the expensive half for
 * everyone else -- a suggestion is a row on a list a person reads -- and one
 * player who can file ten a week owns the panel. Two is enough for "I had
 * another idea" and not enough to be a feed.
 */
export const SUBMITS_PER_WEEK = 2;
/**
 * One vote per suggestion per week, which is the stacking mechanic itself
 * rather than a limit on it: next Monday you may vote on the same one again,
 * and the score is all-time, so a suggestion somebody believes in climbs.
 */
export const ONE_VOTE_PER_ITEM_PER_WEEK = true;
/**
 * The sock-puppet speed bump. See the header for how strong it is not.
 *
 * Three times the per-player quota rather than equal to it, because a share
 * house, a LAN party and a university NAT are all one address and the cap must
 * not make the *honest* multi-player case unplayable. It bites at the fourth
 * person on one address, which is where "a household" stops and "a script"
 * starts.
 */
export const IP_VOTES_PER_WEEK = VOTES_PER_WEEK * 3;
export const IP_SUBMITS_PER_WEEK = SUBMITS_PER_WEEK * 3;

/** How many rows the panel is sent. The list is ranked, so this is the top N. */
export const MAX_LIST = 40;

// --- The records -------------------------------------------------------------

/** One suggestion as the panel draws it. The wire form is below. */
export interface SuggestionView {
  /** The ledger's own id, stable and never reused. What a vote names. */
  localId: number;
  /** GitHub's number, or 0 while `pending-sync`. Drawn as `#12`, never linked. */
  issue: number;
  title: string;
  body: string;
  /** The in-game name of whoever submitted it, as the server assigned it. */
  author: string;
  ups: number;
  downs: number;
  /** `ups - downs`. Sent rather than derived so one function decides it. */
  score: number;
  /** Has *this* client voted on it this week, and which way? 0 no, 1 up, -1 down. */
  myVote: number;
  pending: boolean;
}

/** What `SUGGEST_LIST` carries: the ranked list plus this client's own standing. */
export interface SuggestionList {
  items: SuggestionView[];
  /** Votes this client has left this week, 0..`VOTES_PER_WEEK`. */
  votesLeft: number;
  /** Suggestions this client may still file this week. */
  submitsLeft: number;
  /** The ISO week these two numbers are about, for the panel's footer. */
  week: string;
  /** Milliseconds until they reset. Display only; see `weekEndsInMs`. */
  resetsInMs: number;
  /** Is a GitHub token configured? The panel says so honestly when not. */
  linked: boolean;
}

/**
 * The order the list is drawn in, and the only definition of it.
 *
 * Score descending, then most recent activity, then issue number ascending.
 * Three keys, and the third is what makes it a **total** order: two suggestions
 * filed in the same second with no votes would otherwise swap places between
 * refreshes, which reads as a rendering bug and is the same failure
 * `protocol.rankRoster` has a note about.
 *
 * Does not sort its argument -- the ledger's array is the ledger's.
 */
export function rankSuggestions<T extends { score: number; lastActivity: number; issue: number; localId: number }>(
  items: readonly T[],
): T[] {
  return [...items].sort(
    (a, b) =>
      b.score - a.score ||
      b.lastActivity - a.lastActivity ||
      (a.issue || Number.MAX_SAFE_INTEGER) - (b.issue || Number.MAX_SAFE_INTEGER) ||
      a.localId - b.localId,
  );
}

// --- Codecs ------------------------------------------------------------------

/**
 * Client to server, `MSG.SUGGEST`:
 *
 *     u8   type = MSG.SUGGEST
 *     u8   op            SUGGEST_OP.*
 *     u8   client id length (36)
 *     ...  the client id, ASCII
 *     -- LIST: nothing more
 *     -- VOTE: u32 localId, i8 direction (+1 / -1)
 *     -- SUBMIT: u8 title bytes, u16 body bytes, then both, UTF-8
 *
 * The client id is on **every** message rather than established once at hello,
 * and that is a deliberate cost of about 38 bytes on a message that is sent a
 * handful of times a session. Putting it in the hello would have meant editing
 * `encodeHello` -- a shared layout every other feature depends on -- to carry a
 * field only this one reads, and would have made a client that never opens the
 * panel pay for it on every join. It also keeps the whole feature removable by
 * deleting two files and a switch case.
 */
export interface SuggestRequest {
  op: number;
  clientId: string;
  /** VOTE only. */
  localId: number;
  /** VOTE only: +1 or -1. */
  dir: number;
  /** SUBMIT only. */
  title: string;
  body: string;
}

export function encodeSuggestList(type: number, clientId: string): ArrayBuffer {
  return head(type, SUGGEST_OP.LIST, clientId, 0).buffer;
}

export function encodeSuggestVote(type: number, clientId: string, localId: number, dir: number): ArrayBuffer {
  const { v, at, buffer } = head(type, SUGGEST_OP.VOTE, clientId, 5);
  v.setUint32(at, localId >>> 0, true);
  v.setInt8(at + 4, dir >= 0 ? 1 : -1);
  return buffer;
}

export function encodeSuggestSubmit(type: number, clientId: string, title: string, body: string): ArrayBuffer {
  const t = ENC.encode(fitBytes(title, MAX_TITLE_BYTES));
  const b = ENC.encode(fitBytes(body, MAX_BODY_BYTES));
  const { v, at, buffer } = head(type, SUGGEST_OP.SUBMIT, clientId, 3 + t.length + b.length);
  v.setUint8(at, t.length);
  v.setUint16(at + 1, b.length, true);
  const bytes = new Uint8Array(buffer);
  bytes.set(t, at + 3);
  bytes.set(b, at + 3 + t.length);
  return buffer;
}

function head(
  type: number,
  op: number,
  clientId: string,
  extra: number,
): { v: DataView; at: number; buffer: ArrayBuffer } {
  const id = ENC.encode(clientId).subarray(0, 255);
  const buffer = new ArrayBuffer(3 + id.length + extra);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setUint8(1, op);
  v.setUint8(2, id.length);
  new Uint8Array(buffer, 3).set(id);
  return { v, at: 3 + id.length, buffer };
}

/**
 * The server's decoder, and every read in it is bounded by what **arrived**
 * rather than by what a prefix claims.
 *
 * A length byte that overruns the frame is the cheapest thing a hostile client
 * can say, and `TextDecoder` on an out-of-range view throws -- inside the socket
 * callback, which takes the whole message pump for every player on the host.
 * Returns `null` rather than throwing, on `decodeRoster`'s rule.
 */
export function decodeSuggest(buffer: ArrayBuffer, type: number): SuggestRequest | null {
  if (buffer.byteLength < 3) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const op = v.getUint8(1);
  const idLen = Math.min(v.getUint8(2), CLIENT_ID_BYTES, buffer.byteLength - 3);
  if (idLen <= 0) return null;
  const clientId = DEC.decode(new Uint8Array(buffer, 3, idLen));
  const at = 3 + idLen;
  const out: SuggestRequest = { op, clientId, localId: 0, dir: 0, title: '', body: '' };
  if (op === SUGGEST_OP.LIST) return out;
  if (op === SUGGEST_OP.VOTE) {
    if (buffer.byteLength < at + 5) return null;
    out.localId = v.getUint32(at, true);
    out.dir = v.getInt8(at + 4) >= 0 ? 1 : -1;
    return out;
  }
  if (op === SUGGEST_OP.SUBMIT) {
    if (buffer.byteLength < at + 3) return null;
    const tn = Math.min(v.getUint8(at), MAX_TITLE_BYTES, buffer.byteLength - at - 3);
    const bn = Math.min(v.getUint16(at + 1, true), MAX_BODY_BYTES, buffer.byteLength - at - 3 - tn);
    out.title = tn > 0 ? DEC.decode(new Uint8Array(buffer, at + 3, tn)) : '';
    out.body = bn > 0 ? DEC.decode(new Uint8Array(buffer, at + 3 + tn, bn)) : '';
    return out;
  }
  return null;
}

/**
 * Server to client, `MSG.SUGGEST_LIST`:
 *
 *     u8   type
 *     u8   count
 *     u8   votesLeft
 *     u8   submitsLeft
 *     u8   flags        bit 0: a GitHub token is configured
 *     u32  resetsInMs
 *     u8   week length, then the week key, ASCII
 *     ...  count x record:
 *          u32  localId
 *          u16  issue          0 while pending-sync
 *          i16  score          ups - downs, clamped
 *          u16  ups
 *          u16  downs
 *          i8   myVote         -1, 0, +1
 *          u8   flags          bit 0: pending
 *          u8   title bytes, then the title
 *          u16  body bytes, then the body
 *          u8   author bytes, then the author
 *
 * **Not on the snapshot path and never sent unasked**, except once: the list is
 * pushed to everyone whose panel is open when a score changes, which is what
 * makes two people voting beside each other feel like one list rather than two.
 * That is a message a few times a minute across a room, against a snapshot
 * twenty times a second per player -- see `MSG.BIKES` for the same argument
 * about the same shape of data.
 */
export function encodeSuggestionList(type: number, list: SuggestionList): ArrayBuffer {
  const week = ENC.encode(list.week.slice(0, 16));
  let n = 10 + week.length;
  const rows = list.items.slice(0, MAX_LIST).map((s) => ({
    s,
    t: ENC.encode(fitBytes(s.title, MAX_TITLE_BYTES)),
    b: ENC.encode(fitBytes(s.body, MAX_BODY_BYTES)),
    a: ENC.encode(fitBytes(s.author, 48)),
  }));
  // 18 fixed bytes a row: 15 up to and including the title's length prefix, the
  // body's u16 prefix, and the author's u8 one. Counted here rather than
  // inferred, because an allocation one byte short of the layout is a decoder
  // that reads a plausible wrong list.
  for (const r of rows) n += 18 + r.t.length + r.b.length + r.a.length;
  const buffer = new ArrayBuffer(n);
  const v = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  v.setUint8(0, type);
  v.setUint8(1, rows.length);
  v.setUint8(2, Math.max(0, Math.min(255, list.votesLeft)));
  v.setUint8(3, Math.max(0, Math.min(255, list.submitsLeft)));
  v.setUint8(4, list.linked ? 1 : 0);
  v.setUint32(5, Math.max(0, Math.min(0xffffffff, Math.round(list.resetsInMs))), true);
  v.setUint8(9, week.length);
  bytes.set(week, 10);
  let at = 10 + week.length;
  for (const { s, t, b, a } of rows) {
    v.setUint32(at, s.localId >>> 0, true);
    v.setUint16(at + 4, Math.max(0, Math.min(65535, s.issue)), true);
    v.setInt16(at + 6, Math.max(-32768, Math.min(32767, s.score)), true);
    v.setUint16(at + 8, Math.max(0, Math.min(65535, s.ups)), true);
    v.setUint16(at + 10, Math.max(0, Math.min(65535, s.downs)), true);
    v.setInt8(at + 12, s.myVote > 0 ? 1 : s.myVote < 0 ? -1 : 0);
    v.setUint8(at + 13, s.pending ? 1 : 0);
    v.setUint8(at + 14, t.length);
    bytes.set(t, at + 15);
    at += 15 + t.length;
    v.setUint16(at, b.length, true);
    bytes.set(b, at + 2);
    at += 2 + b.length;
    v.setUint8(at, a.length);
    bytes.set(a, at + 1);
    at += 1 + a.length;
  }
  return buffer;
}

export function decodeSuggestionList(buffer: ArrayBuffer, type: number): SuggestionList | null {
  if (buffer.byteLength < 10) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const count = v.getUint8(1);
  const out: SuggestionList = {
    items: [],
    votesLeft: v.getUint8(2),
    submitsLeft: v.getUint8(3),
    linked: (v.getUint8(4) & 1) !== 0,
    resetsInMs: v.getUint32(5, true),
    week: '',
  };
  const wn = Math.min(v.getUint8(9), buffer.byteLength - 10);
  out.week = wn > 0 ? DEC.decode(new Uint8Array(buffer, 10, wn)) : '';
  let at = 10 + wn;
  // Bounded by the frame at every step and it **drops an incomplete tail**
  // rather than throwing, which is `decodeRoster`'s rule and exists for the same
  // reason: a throw here is inside the client's message pump.
  for (let i = 0; i < count; i++) {
    if (at + 15 > buffer.byteLength) break;
    const localId = v.getUint32(at, true);
    const issue = v.getUint16(at + 4, true);
    const score = v.getInt16(at + 6, true);
    const ups = v.getUint16(at + 8, true);
    const downs = v.getUint16(at + 10, true);
    const myVote = v.getInt8(at + 12);
    const pending = (v.getUint8(at + 13) & 1) !== 0;
    const tn = v.getUint8(at + 14);
    if (at + 15 + tn + 2 > buffer.byteLength) break;
    const title = tn > 0 ? DEC.decode(new Uint8Array(buffer, at + 15, tn)) : '';
    at += 15 + tn;
    const bn = v.getUint16(at, true);
    if (at + 2 + bn + 1 > buffer.byteLength) break;
    const body = bn > 0 ? DEC.decode(new Uint8Array(buffer, at + 2, bn)) : '';
    at += 2 + bn;
    const an = v.getUint8(at);
    if (at + 1 + an > buffer.byteLength) break;
    const author = an > 0 ? DEC.decode(new Uint8Array(buffer, at + 1, an)) : '';
    at += 1 + an;
    out.items.push({ localId, issue, title, body, author, ups, downs, score, myVote, pending });
  }
  return out;
}

/**
 * Server to client, `MSG.SUGGEST_ACK`:
 *
 *     u8   type
 *     u8   result       SUGGEST_RESULT.*
 *     u16  issue        the number it was posted as, or 0
 *     u8   message length, then the message, UTF-8
 *
 * The message is written by the server rather than looked up by the client from
 * the result code, and that is the one interesting choice here. A code plus a
 * client-side table means two builds disagreeing about what "quota" means the
 * day the quota changes; a sentence composed where the rule lives can say *"no
 * votes left -- 4 a week, back on Monday"* and stay true when the number moves.
 * The code is still there for the panel to colour the line and to know whether
 * to clear the compose box.
 */
export function encodeSuggestAck(type: number, result: number, issue: number, message: string): ArrayBuffer {
  const m = ENC.encode(fitBytes(message, 200));
  const buffer = new ArrayBuffer(5 + m.length);
  const v = new DataView(buffer);
  v.setUint8(0, type);
  v.setUint8(1, result);
  v.setUint16(2, Math.max(0, Math.min(65535, issue)), true);
  v.setUint8(4, m.length);
  new Uint8Array(buffer, 5).set(m);
  return buffer;
}

export function decodeSuggestAck(
  buffer: ArrayBuffer,
  type: number,
): { result: number; issue: number; message: string } | null {
  if (buffer.byteLength < 5) return null;
  const v = new DataView(buffer);
  if (v.getUint8(0) !== type) return null;
  const n = Math.min(v.getUint8(4), buffer.byteLength - 5);
  return {
    result: v.getUint8(1),
    issue: v.getUint16(2, true),
    message: n > 0 ? DEC.decode(new Uint8Array(buffer, 5, n)) : '',
  };
}

// --- The self-check ----------------------------------------------------------

/**
 * The week arithmetic, the sanitiser, the order and the two codecs.
 *
 * Run at boot on **both ends**, beside `verifyNet` and `verifyNames`, because
 * every failure here is silent in this repo's sense -- the panel opens, the
 * votes are accepted, and the count is simply wrong:
 *
 *   - A **week key that is off by an hour** at a daylight-saving changeover
 *     hands somebody a fifth vote twice a year, which nobody reports.
 *   - An **ISO week that uses the calendar year** puts the first days of January
 *     in week 1 of the wrong year, so on one day a year every quota resets
 *     twice.
 *   - A **sanitiser that misses the comment marker** lets a suggestion end the
 *     tally block early, and the next flush overwrites somebody's score with
 *     player text.
 *   - An **order that is not total** reshuffles the panel between refreshes.
 *   - A **length prefix written before the field it precedes** desynchronises
 *     every row after it, which draws a list of suggestions nobody wrote.
 *
 *     bun -e "import {verifySuggestions} from './client/src/net/suggestions.ts';
 *             console.log(verifySuggestions())"
 */
export function verifySuggestions(): string[] {
  const failures: string[] = [];

  // --- The ISO week itself, on the dates that break naive implementations.
  {
    const cases: Array<[number, number, number, string]> = [
      // 1 Jan 2027 is a Friday and belongs to the last week of 2026. The single
      // most common ISO-week bug, and it is a whole week of quota.
      [2027, 1, 1, '2026-W53'],
      [2026, 1, 1, '2026-W01'],
      // 4 Jan is in week 1 by definition, whatever day it falls on.
      [2026, 1, 4, '2026-W01'],
      [2026, 1, 5, '2026-W02'],
      [2026, 8, 5, '2026-W32'],
      [2026, 12, 31, '2026-W53'],
      [2024, 12, 30, '2025-W01'],
    ];
    for (const [y, m, d, want] of cases) {
      const got = isoWeekOf(y, m, d);
      if (got !== want) failures.push(`isoWeekOf(${y},${m},${d}) is ${got}, not ${want}.`);
    }
  }

  // --- The Sydney boundary, and both daylight-saving changeovers.
  //
  // The quota turns over at Monday 00:00 **Sydney**, which is 14:00 UTC on the
  // preceding Sunday in AEDT (UTC+11) and 13:00 UTC in AEST (UTC+10). A
  // fixed-offset implementation gets one of those two right and is an hour out
  // for half the year -- so both are asserted, with the minute either side.
  {
    // August 2026 is AEST (UTC+10): Monday 3 Aug 00:00 Sydney = 2 Aug 14:00 UTC.
    const beforeAest = Date.parse('2026-08-02T13:59:00Z');
    const afterAest = Date.parse('2026-08-02T14:01:00Z');
    if (weekKey(beforeAest) === weekKey(afterAest)) {
      failures.push(`The AEST week boundary did not turn over: both sides are ${weekKey(beforeAest)}.`);
    }
    if (weekKey(beforeAest) !== '2026-W31' || weekKey(afterAest) !== '2026-W32') {
      failures.push(
        `The AEST boundary gave ${weekKey(beforeAest)} -> ${weekKey(afterAest)}, not 2026-W31 -> 2026-W32.`,
      );
    }
    // January 2026 is AEDT (UTC+11): Monday 12 Jan 00:00 Sydney = 11 Jan 13:00 UTC.
    const beforeAedt = Date.parse('2026-01-11T12:59:00Z');
    const afterAedt = Date.parse('2026-01-11T13:01:00Z');
    if (weekKey(beforeAedt) === weekKey(afterAedt)) {
      failures.push(`The AEDT week boundary did not turn over: both sides are ${weekKey(beforeAedt)}.`);
    }
    // And the hour in between is decisive: under a fixed +10 the AEDT boundary
    // would still be an hour away, so this instant is the one that separates a
    // correct implementation from an off-by-one-hour one.
    if (weekKey(Date.parse('2026-01-11T13:30:00Z')) !== weekKey(afterAedt)) {
      failures.push('An instant half an hour into the AEDT week landed in the previous one.');
    }
  }

  // --- The changeover weekends themselves. 5 April 2026 is when the clocks go
  // back (03:00 -> 02:00) and 4 October is when they go forward (02:00 ->
  // 03:00). Neither is a Monday, so neither may move a week boundary at all --
  // which is exactly what epoch arithmetic gets wrong.
  {
    const dstBack = weekKey(Date.parse('2026-04-04T20:00:00Z')); // Sun 5 Apr, Sydney
    const dstBackLater = weekKey(Date.parse('2026-04-05T02:00:00Z')); // still Sun 5 Apr
    if (dstBack !== dstBackLater) {
      failures.push(`The April changeover split a Sunday across two weeks (${dstBack} / ${dstBackLater}).`);
    }
    const fwd = weekKey(Date.parse('2026-10-03T14:00:00Z')); // Sun 4 Oct, Sydney
    const fwdLater = weekKey(Date.parse('2026-10-03T18:00:00Z')); // past the 02:00 jump
    if (fwd !== fwdLater) {
      failures.push(`The October changeover split a Sunday across two weeks (${fwd} / ${fwdLater}).`);
    }
    // And the Sydney civil date is what actually moved, which is the thing the
    // whole implementation rests on: 16:30 UTC on 3 October is 03:30 on the 4th
    // in Sydney, an hour that a naive +10 would call 02:30 -- an hour that does
    // not exist that day.
    const [, mth, day] = sydneyDate(Date.parse('2026-10-03T16:30:00Z'));
    if (mth !== 10 || day !== 4) failures.push(`sydneyDate across the jump gave ${mth}/${day}, not 10/4.`);
  }

  // --- `weekEndsInMs` agrees with `weekKey`, which is the only thing it has to
  // do: the instant it points at must be in a different week and the instant
  // just before it must not.
  {
    const at = Date.parse('2026-08-05T04:00:00Z');
    const ms = weekEndsInMs(at);
    if (weekKey(at + ms) === weekKey(at)) failures.push('weekEndsInMs pointed inside its own week.');
    if (weekKey(at + ms - 120000) !== weekKey(at)) failures.push('weekEndsInMs overshot the boundary by minutes.');
    if (ms <= 0 || ms > 7 * 86400000) failures.push(`weekEndsInMs gave ${ms} ms, which is not inside a week.`);
  }

  // --- The sanitiser, case by case, and idempotent on every one of them.
  {
    const cases: Array<[string, boolean, string, string]> = [
      ['make the bat faster', false, 'make the bat faster', 'ordinary text survives untouched'],
      ['  spaced  out  ', false, 'spaced out', 'whitespace collapses and trims'],
      ['line\nbreak', false, 'line break', 'a title is one line'],
      ['line\nbreak', true, 'line\nbreak', 'a body keeps its lines'],
      ['a\n\n\n\n\nb', true, 'a\n\nb', 'a run of blank lines collapses to one'],
      ['zero​width', false, 'zerowidth', 'invisibles are dropped'],
      ['‮reversed', false, 'reversed', 'a bidi override is dropped, not drawn'],
      ['nul byte', false, 'nul byte', 'a NUL is a separator, not a deletion'],
    ];
    for (const [raw, multi, want, why] of cases) {
      const got = sanitiseText(raw, multi);
      if (got !== want) {
        failures.push(`sanitiseText(${JSON.stringify(raw)}, ${multi}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)} -- ${why}.`);
      }
      if (sanitiseText(got, multi) !== got) {
        failures.push(`sanitiseText is not idempotent on ${JSON.stringify(raw)}.`);
      }
    }
  }

  // --- The tally marker, which is the one injection this feature actually has.
  // A body containing the closing marker would end the machine-managed block
  // early, and the next flush would overwrite player text and then a score.
  {
    const hostile = `nice game ${TALLY_CLOSE} score: 9999 ${TALLY_OPEN} more`;
    const clean = sanitiseBody(hostile);
    if (clean.includes(TALLY_OPEN) || clean.includes(TALLY_CLOSE)) {
      failures.push('A body containing the tally markers survived the sanitiser intact.');
    }
    if (clean.includes('<!--') || clean.includes('-->')) {
      failures.push('A body kept an HTML comment sequence; the tally block can be closed early.');
    }
    // And it is still legible -- the point is to neutralise, not to delete, so
    // the player can see what happened to what they typed.
    if (!clean.includes('nice game')) failures.push('Neutralising the markers ate the surrounding text.');
  }

  // --- The caps, in bytes, clipped at a code point.
  {
    const wide = sanitiseTitle('🦘'.repeat(200));
    if (ENC.encode(wide).length > MAX_TITLE_BYTES) {
      failures.push(`A title of 200 emoji is ${ENC.encode(wide).length} bytes, over the ${MAX_TITLE_BYTES} cap.`);
    }
    if (wide.includes('�')) failures.push('A title of emoji was clipped inside a surrogate pair.');
    const body = sanitiseBody('a'.repeat(5000));
    if (ENC.encode(body).length > MAX_BODY_BYTES) failures.push('A 5,000 character body was not clipped.');
    // Too short is refused rather than padded, or the list fills with "hi".
    if (sanitiseTitle('hi') !== '') failures.push('A two-character title was accepted.');
    if (sanitiseTitle('   ​  ') !== '') failures.push('A title of invisibles was accepted.');
  }

  // --- The client id's shape.
  {
    if (!validClientId('3f2504e0-4f89-41d3-9a0c-0305e82c3301')) failures.push('A real UUID was refused.');
    if (validClientId('not-a-uuid')) failures.push('A non-UUID was accepted as a client id.');
    if (validClientId('3F2504E0-4F89-41D3-9A0C-0305E82C3301')) {
      failures.push('An upper-case UUID was accepted; the ledger key must be one canonical form.');
    }
  }

  // --- The order: total, and stable against an all-zero list.
  {
    const rows = [
      { localId: 1, issue: 3, score: 2, lastActivity: 100 },
      { localId: 2, issue: 1, score: 5, lastActivity: 50 },
      { localId: 3, issue: 2, score: 2, lastActivity: 900 },
      { localId: 4, issue: 4, score: -1, lastActivity: 999 },
    ];
    const order = rankSuggestions(rows).map((r) => r.localId).join(',');
    if (order !== '2,3,1,4') failures.push(`rankSuggestions gave ${order}; it must be score desc, then recency.`);
    const flat = rows.map((r) => ({ ...r, score: 0, lastActivity: 0 }));
    const once = rankSuggestions(flat).map((r) => r.localId).join(',');
    const twice = rankSuggestions([...flat].reverse()).map((r) => r.localId).join(',');
    if (once !== twice) failures.push(`An all-zero list ranked ${once} one way and ${twice} the other.`);
    // A pending suggestion has issue 0 and must not therefore sort to the top of
    // every tie -- 0 would win an ascending compare against every real number.
    const withPending = rankSuggestions([
      { localId: 9, issue: 0, score: 0, lastActivity: 0 },
      { localId: 8, issue: 7, score: 0, lastActivity: 0 },
    ]);
    if (withPending[0].localId !== 8) {
      failures.push('A pending suggestion (issue 0) sorted above a real one on an otherwise equal tie.');
    }
    if (rows[0].localId !== 1) failures.push('rankSuggestions sorted its argument in place.');
  }

  // --- The request codec, all three ops, through the real encoder.
  {
    const id = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    const T = 0x06;
    const list = decodeSuggest(encodeSuggestList(T, id), T);
    if (!list || list.op !== SUGGEST_OP.LIST || list.clientId !== id) failures.push('A LIST request did not round-trip.');
    const vote = decodeSuggest(encodeSuggestVote(T, id, 4000000000, -1), T);
    if (!vote || vote.localId !== 4000000000 || vote.dir !== -1) {
      failures.push(`A VOTE request round-tripped to ${vote?.localId}/${vote?.dir}.`);
    }
    const title = 'give the magpies a day off';
    const body = 'they swoop me every time I cross the park\n\nplease';
    const sub = decodeSuggest(encodeSuggestSubmit(T, id, title, body), T);
    if (!sub || sub.title !== title || sub.body !== body) {
      failures.push(`A SUBMIT request round-tripped to ${JSON.stringify(sub?.title)} / ${JSON.stringify(sub?.body)}.`);
    }
    // A frame at the caps must fit the socket's `maxPayloadLength`, which is
    // 1024 in `server/index.ts` -- a submit that could not be sent is a feature
    // that fails only for the players with the most to say.
    const big = encodeSuggestSubmit(T, id, 'x'.repeat(MAX_TITLE_BYTES), 'y'.repeat(MAX_BODY_BYTES));
    if (big.byteLength > 1024) {
      failures.push(`A maximum submit is ${big.byteLength} bytes, over the socket's 1024 byte payload limit.`);
    }
    // Truncation returns null rather than throwing, at every prefix.
    let threw = false;
    try {
      for (let n = 0; n < big.byteLength; n++) decodeSuggest(big.slice(0, n), T);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated suggest request threw rather than returning null.');
    // And a frame of the wrong type is refused by the type test rather than
    // parsed as this one.
    if (decodeSuggest(encodeSuggestList(T, id), 0x07) !== null) failures.push('A mistyped frame was decoded anyway.');
  }

  // --- The list codec, which is the one with three variable-length fields per
  // row and is therefore the one that desynchronises.
  {
    const T = 0x8c;
    const list: SuggestionList = {
      week: '2026-W32',
      votesLeft: 3,
      submitsLeft: 1,
      resetsInMs: 400000000,
      linked: true,
      items: [
        { localId: 1, issue: 12, title: 'ladders on the pylons', body: 'let us climb the bridge', author: 'Bazza', ups: 9, downs: 2, score: 7, myVote: 1, pending: false },
        // An empty body and an empty author are both reachable -- a body is
        // optional and a queued suggestion from a nameless client has neither --
        // and the decoder has to survive a zero-length field or it walks off the
        // end of the row before it.
        { localId: 2, issue: 0, title: 'faster ferries', body: '', author: '', ups: 0, downs: 0, score: 0, myVote: 0, pending: true },
        { localId: 3, issue: 65535, title: 'magpie 🦘 season', body: 'line one\nline two', author: 'Kev 🦘', ups: 65535, downs: 1, score: -32768, myVote: -1, pending: false },
      ],
    };
    const frame = encodeSuggestionList(T, list);
    const got = decodeSuggestionList(frame, T);
    if (!got || got.items.length !== list.items.length) {
      failures.push(`A ${list.items.length}-row list came back as ${got ? got.items.length : 'null'}.`);
    } else {
      for (let i = 0; i < list.items.length; i++) {
        const a = list.items[i];
        const b = got.items[i];
        if (b.localId !== a.localId || b.issue !== a.issue || b.score !== a.score) {
          failures.push(`Row ${a.localId}: ${a.localId}/${a.issue}/${a.score} came back as ${b.localId}/${b.issue}/${b.score}.`);
        }
        if (b.title !== a.title || b.body !== a.body || b.author !== a.author) {
          failures.push(`Row ${a.localId}: text came back as ${JSON.stringify(b.title)}/${JSON.stringify(b.body)}/${JSON.stringify(b.author)}.`);
        }
        if (b.ups !== a.ups || b.downs !== a.downs || b.myVote !== a.myVote || b.pending !== a.pending) {
          failures.push(`Row ${a.localId}: counts came back as ${b.ups}/${b.downs}/${b.myVote}/${b.pending}.`);
        }
      }
      if (got.votesLeft !== 3 || got.submitsLeft !== 1 || got.week !== '2026-W32' || !got.linked) {
        failures.push(`The list header came back as ${got.votesLeft}/${got.submitsLeft}/${got.week}/${got.linked}.`);
      }
    }
    // A truncated list drops its tail rather than throwing, at every prefix.
    let threw = false;
    try {
      for (let n = 0; n < frame.byteLength; n++) decodeSuggestionList(frame.slice(0, n), T);
    } catch {
      threw = true;
    }
    if (threw) failures.push('A truncated suggestion list threw rather than dropping its tail.');
  }

  // --- The ack.
  {
    const T = 0x8d;
    const ack = decodeSuggestAck(encodeSuggestAck(T, SUGGEST_RESULT.QUEUED, 0, 'queued — no GitHub link yet'), T);
    if (!ack || ack.result !== SUGGEST_RESULT.QUEUED || ack.message !== 'queued — no GitHub link yet') {
      failures.push(`An ack round-tripped to ${JSON.stringify(ack)}.`);
    }
    const posted = decodeSuggestAck(encodeSuggestAck(T, SUGGEST_RESULT.OK, 13, 'posted as #13'), T);
    if (!posted || posted.issue !== 13) failures.push('An ack lost its issue number.');
  }

  return failures;
}
