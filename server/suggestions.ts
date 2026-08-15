/**
 * The suggestions ledger: who asked for what, who voted, and what GitHub is
 * told about it.
 *
 * `client/src/net/suggestions.ts` is the half both ends import -- the week
 * arithmetic, the sanitiser, the order and the codecs. This is the half that
 * only the server has: a durable file, the quota decisions, and a one-way mirror
 * into GitHub issues.
 *
 * ---------------------------------------------------------------------------
 * THE STORAGE SPLIT, RESTATED IN CONCRETE TERMS
 *
 * A suggestion lives in **two** places and they are not copies of each other:
 *
 *   - **GitHub** has the permanent record -- the title, the text, the number,
 *     the ability to comment on it and close it. That is what the user curates
 *     from at the end of a week, and it survives this process being deleted.
 *   - **This ledger** has the votes, because a vote cannot be a GitHub reaction:
 *     every call is made with one token belonging to one account, so a hundred
 *     players voting would be one 👍 that toggles. It also has a *copy* of the
 *     title and body, and that copy is load-bearing rather than redundant -- it
 *     is what the panel serves when GitHub is unreachable, and what a suggestion
 *     *is* before it has ever reached GitHub at all.
 *
 * The mirror runs one way: the ledger writes a machine-managed block into the
 * issue body and never reads a score back out of it. An issue edited by hand
 * gets its block rewritten on the next flush, which the block says in its own
 * text so nobody discovers it by losing an edit.
 *
 * ---------------------------------------------------------------------------
 * NO TOKEN IS A SUPPORTED STATE, NOT A DEGRADED ONE
 *
 * This shipped before the fine-grained PAT existed, and it had to work anyway --
 * a suggestions box that refuses suggestions until a credential appears is a
 * feature nobody can try. So:
 *
 *   - A suggestion with no token is **accepted, stored and votable**, in state
 *     `pending-sync`. The player is told *"queued — it'll be posted when the
 *     server's GitHub link is configured"*, which is true rather than reassuring.
 *   - Votes accumulate against it normally. They are ours, and they never needed
 *     GitHub.
 *   - When a token appears, `drain` posts every queued suggestion **oldest
 *     first**, backfills the issue numbers, and immediately writes the tally
 *     block with whatever score it accumulated in the meantime. Nothing is lost
 *     and nothing is re-voted.
 *
 * Reading is separate from writing and needs no token at all: the repo is
 * public, so `GET /issues` unauthenticated works at 60 requests an hour per
 * address, and the refresh is every five minutes. With a token it uses it, for
 * the 5,000/hr and for nothing else.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN ITSELF
 *
 * Read from `SYDNEY_GITHUB_TOKEN` at boot and **never** from a client, never
 * logged, never echoed in an error, and never put in a URL. Every GitHub call in
 * here reports `res.status` and **nothing else** -- not the response body, which
 * quotes request context back at you. `describe()` exists so the boot line can
 * say *whether* there is a token without saying anything about it.
 *
 * The deployed credential is currently the user's **broad `gh` OAuth token**
 * (repo scope across their whole account) rather than a fine-grained,
 * issues-only PAT, and that raises the cost of every mistake in this file from
 * "one repo's issues" to "everything they own". Three rules follow from it, and
 * all three are enforced structurally rather than by care:
 *
 *   - **The repo is `SYDNEY_GITHUB_REPO` and nothing else can name it.** There
 *     is no code path from a client message to a URL: `api()` is the only place
 *     one is built and it interpolates a field read once from the environment at
 *     construction. A client cannot ask this server to touch another repo
 *     because there is no argument that would carry the request.
 *   - **Only the issues endpoints of that repo are ever called** -- three of
 *     them: POST /issues, PATCH /issues/:n, GET /issues. Nothing enumerates
 *     repos, reads code, or touches anything a suggestions box has no business
 *     with.
 *   - **No GitHub response text ever reaches a player.** Every message in a
 *     `SUGGEST_ACK` is a literal in this file.
 *
 * Swapping it for a fine-grained PAT later is a one-line change to
 * `/etc/sydney/secrets.env` and a restart -- nothing in this file knows or cares
 * which kind of token it holds, which is the property that makes the downgrade
 * free whenever the user wants it.
 *
 *     SYDNEY_GITHUB_TOKEN=github_pat_...   Issues: read & write, that repo only
 *     SYDHEY_GITHUB_REPO=owner/name        defaults to voidtype/sydrunner
 *     SYDNEY_SUGGESTIONS=/path/file.json   defaults to beside the world
 */

import { MSG } from '../client/src/net/protocol.ts';
import {
  IP_SUBMITS_PER_WEEK,
  IP_VOTES_PER_WEEK,
  MAX_LIST,
  ONE_VOTE_PER_ITEM_PER_WEEK,
  SUBMITS_PER_WEEK,
  SUGGEST_OP,
  SUGGEST_RESULT,
  TALLY_CLOSE,
  TALLY_OPEN,
  VOTES_PER_WEEK,
  decodeSuggest,
  encodeSuggestAck,
  encodeSuggestionList,
  rankSuggestions,
  sanitiseBody,
  sanitiseTitle,
  validClientId,
  weekEndsInMs,
  weekKey,
  type SuggestionList,
  type SuggestionState,
  type SuggestionView,
} from '../client/src/net/suggestions.ts';

/**
 * The three ids this feature uses, named once.
 *
 * Pulled out of `MSG` into constants so the codecs in `net/suggestions.ts` can
 * stay ignorant of the message table -- they take a type byte as an argument,
 * which is what lets the self-check exercise them without importing the
 * protocol at all.
 */
const MSG_SUGGEST = MSG.SUGGEST;
const MSG_SUGGEST_LIST = MSG.SUGGEST_LIST;
const MSG_SUGGEST_ACK = MSG.SUGGEST_ACK;

// --- The file ----------------------------------------------------------------

interface StoredSuggestion {
  localId: number;
  /** GitHub's number, or 0 while it has never been posted. */
  issue: number;
  title: string;
  body: string;
  /** The in-game name at the moment of submitting. A name, not an identity. */
  author: string;
  /** Who filed it, for the weekly submit quota. See the header on identity. */
  clientId: string;
  /** Hashed, never the address itself. See `hashIp`. */
  ipHash: string;
  createdAt: number;
  lastActivity: number;
  state: SuggestionState;
  /**
   * The score last written into the issue body, or null if never.
   *
   * What makes the mirror cheap: a flush compares this against the live score
   * and skips every issue that has not moved, so a quiet week costs zero API
   * calls rather than one per suggestion per minute.
   */
  syncedScore: number | null;
  /** Consecutive failed posts, for the backoff. Reset on success. */
  failures?: number;
}

interface StoredVote {
  clientId: string;
  localId: number;
  /** The ISO week in Sydney it was cast in. The quota's only key. */
  week: string;
  dir: 1 | -1;
  at: number;
  ipHash: string;
}

interface LedgerFile {
  version: 1;
  nextLocalId: number;
  suggestions: StoredSuggestion[];
  votes: StoredVote[];
}

/**
 * A stable, non-reversible stand-in for an address.
 *
 * The per-IP cap needs to know *"has this address already voted twelve times
 * this week"* and nothing else, and that question is answerable from a hash. A
 * plain list of the address of everyone who has ever voted is a thing this game
 * would then be responsible for, in a JSON file, for no gain -- so it is not
 * kept. The salt is per-process and random, so the file is not even a rainbow
 * table across restarts; the cost is that the cap resets when the server does,
 * which is the right trade for a speed bump.
 */
const IP_SALT = crypto.randomUUID();

function hashIp(ip: string): string {
  const h = new Bun.CryptoHasher('sha256');
  h.update(IP_SALT);
  h.update(ip);
  return h.digest('hex').slice(0, 16);
}

// --- The store ---------------------------------------------------------------

export interface SuggestOutcome {
  result: number;
  issue: number;
  message: string;
  /** Did anything change that everybody's open panel should be told about? */
  changed: boolean;
}

export interface SuggestionStoreOptions {
  path: string;
  repo: string;
  token: string;
  /** Off in tests, which drive `flush` and `refresh` by hand. */
  timers?: boolean;
  /** Injectable so the checks can run the whole sync path without a network. */
  fetch?: typeof fetch;
  now?: () => number;
}

export class SuggestionStore {
  private readonly path: string;
  readonly repo: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private file: LedgerFile = { version: 1, nextLocalId: 1, suggestions: [], votes: [] };

  /** Set by anything that mutates; cleared by `save`. */
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  /** One flush at a time. Two concurrent drains would post an issue twice. */
  private syncing = false;

  /** The last thing GitHub told us, for the log and for `/health`. */
  lastGithubError = '';
  lastRefreshAt = 0;

  constructor(options: SuggestionStoreOptions) {
    this.path = options.path;
    this.repo = options.repo;
    this.token = options.token;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
    if (options.timers !== false) {
      // Sixty seconds, and the number is the whole anti-thrash design: a vote
      // must never be an API call, or a room of twenty people voting is twenty
      // PATCHes a minute against a rate limit shared with every other thing this
      // token does. A score that is a minute stale in a GitHub issue is a score
      // that is a minute stale in a GitHub issue.
      this.syncTimer = setInterval(() => void this.sync(), 60_000);
      // Five minutes for the read, which is what picks up an issue the user
      // closed or wrote by hand. Unauthenticated that is 12 calls an hour
      // against a limit of 60.
      this.refreshTimer = setInterval(() => void this.refresh(), 5 * 60_000);
    }
  }

  /** Whether a token is configured. Says nothing about the token. */
  get linked(): boolean {
    return this.token.length > 0;
  }

  /** One line for the boot log. Deliberately incapable of leaking the token. */
  describe(): string {
    const pending = this.file.suggestions.filter((s) => s.state === 'pending-sync').length;
    return (
      `${this.file.suggestions.length} suggestion(s), ${this.file.votes.length} vote(s)` +
      (this.linked
        ? `, GitHub ${this.repo} (token set)`
        : `, GitHub ${this.repo} read-only (no SYDNEY_GITHUB_TOKEN — ${pending} queued)`)
    );
  }

  // --- Persistence ------------------------------------------------------------

  /**
   * Read the ledger, or start an empty one.
   *
   * A file that will not parse is **moved aside rather than deleted or thrown
   * on**: the votes in it are the only copy of something players spent a week
   * accumulating, and a server that refuses to boot on a truncated JSON is a
   * server that is down until somebody notices. Renaming it leaves the evidence
   * and lets the game keep running, which is the same call `world.ts` makes
   * about a tile it cannot read.
   */
  async load(): Promise<void> {
    try {
      const f = Bun.file(this.path);
      if (!(await f.exists())) return;
      const raw = (await f.json()) as LedgerFile;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.suggestions) || !Array.isArray(raw.votes)) {
        throw new Error('not a ledger');
      }
      this.file = {
        version: 1,
        nextLocalId: Math.max(1, Number(raw.nextLocalId) || 1),
        suggestions: raw.suggestions,
        votes: raw.votes,
      };
      // The counter is repaired from the data rather than trusted, because a
      // truncated write could leave it behind the highest id -- and a reused
      // localId puts one suggestion's votes onto another's.
      for (const s of this.file.suggestions) {
        if (s.localId >= this.file.nextLocalId) this.file.nextLocalId = s.localId + 1;
      }
    } catch (err) {
      const aside = `${this.path}.broken-${Date.now()}`;
      try {
        await Bun.write(aside, Bun.file(this.path));
      } catch {
        // Nothing further to try; the message below is the record.
      }
      console.error(`[sydney] suggestions: ${this.path} would not parse (${String(err)}); moved to ${aside}`);
      this.file = { version: 1, nextLocalId: 1, suggestions: [], votes: [] };
    }
  }

  /**
   * Write the ledger **atomically**: a temporary file beside it, then a rename.
   *
   * `Bun.write` straight over the path is a truncate followed by a write, and a
   * process killed between the two leaves a zero-byte file where the votes were.
   * A rename within one directory is atomic on every filesystem this will ever
   * run on, so the file is either the old ledger or the new one and never a
   * prefix of either.
   */
  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      await Bun.write(tmp, JSON.stringify(this.file, null, 1));
      await Bun.$`mv -f ${tmp} ${this.path}`.quiet();
    } catch (err) {
      // Left dirty, so the next debounce tries again rather than silently
      // dropping the write that failed.
      this.dirty = true;
      console.error(`[sydney] suggestions: could not write ${this.path}: ${String(err)}`);
    }
  }

  /**
   * Mark dirty and schedule a write.
   *
   * Debounced by a quarter second rather than written per vote: a room voting at
   * once is a handful of mutations inside one tick, and re-serialising the whole
   * ledger for each of them is the only part of this feature that could ever
   * show up in a tick budget.
   */
  private touch(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, 250);
  }

  /** Stop the timers and get everything on disk and on GitHub. For shutdown. */
  async close(): Promise<void> {
    if (this.syncTimer !== null) clearInterval(this.syncTimer);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    this.syncTimer = null;
    this.refreshTimer = null;
    // The tally flush on the way out is what makes the 60 s debounce safe: a
    // server stopped 59 seconds after the last vote would otherwise leave that
    // vote out of the issue until somebody voted again.
    await this.sync();
    await this.save();
  }

  // --- Reading ----------------------------------------------------------------

  /** Everything the panel draws, from one client's point of view. */
  list(clientId: string, at = this.now()): SuggestionList {
    const week = weekKey(at);
    const mine = new Map<number, number>();
    let spent = 0;
    for (const v of this.file.votes) {
      if (v.clientId !== clientId || v.week !== week) continue;
      spent++;
      mine.set(v.localId, v.dir);
    }
    // Ranked with `lastActivity` attached and then stripped of it, because that
    // field is the order's second key and is **not on the wire**: a client draws
    // the list in the order it arrives and has nothing to re-sort by. Carrying a
    // timestamp per row so the panel could reproduce a sort it never performs
    // would be eight bytes a row to enable a disagreement.
    const views: Array<SuggestionView & { lastActivity: number }> = [];
    for (const s of this.file.suggestions) {
      // Closed is closed: it was built, or it was declined, and either way it is
      // not something to spend this week's four votes on. It stays in the ledger
      // because it is the record of a week that was won.
      if (s.state === 'closed') continue;
      const { ups, downs } = this.tally(s.localId);
      views.push({
        localId: s.localId,
        issue: s.issue,
        title: s.title,
        body: s.body,
        author: s.author,
        ups,
        downs,
        score: ups - downs,
        myVote: mine.get(s.localId) ?? 0,
        pending: s.state !== 'open',
        lastActivity: s.lastActivity,
      });
    }
    const submitted = this.file.suggestions.filter(
      (s) => s.clientId === clientId && weekKey(s.createdAt) === week,
    ).length;
    return {
      items: rankSuggestions(views)
        .slice(0, MAX_LIST)
        .map(({ lastActivity, ...view }) => {
          void lastActivity;
          return view;
        }),
      votesLeft: Math.max(0, VOTES_PER_WEEK - spent),
      submitsLeft: Math.max(0, SUBMITS_PER_WEEK - submitted),
      week,
      resetsInMs: weekEndsInMs(at),
      linked: this.linked,
    };
  }

  /**
   * All-time ups and downs for one suggestion, counted from the vote records.
   *
   * Derived rather than stored, and that is the decision that makes the whole
   * ledger auditable: there is no counter to drift, no double-decrement on a
   * changed vote, and the answer to *"why is this on 7"* is seven rows. It is
   * O(votes) per call, which at the scale this feature operates at -- a few
   * hundred votes a month -- is nothing, and `list` is called on a panel open
   * rather than per tick.
   */
  private tally(localId: number): { ups: number; downs: number } {
    let ups = 0;
    let downs = 0;
    for (const v of this.file.votes) {
      if (v.localId !== localId) continue;
      if (v.dir > 0) ups++;
      else downs++;
    }
    return { ups, downs };
  }

  // --- Writing ----------------------------------------------------------------

  /**
   * A new suggestion.
   *
   * Everything is checked here rather than trusted from the client, including
   * the things the client already checked: the text is sanitised again (the
   * first run happened inside something a player controls), the quota is counted
   * from the ledger rather than from a number the panel sent, and the id's shape
   * is validated so the key space stays finite.
   *
   * Posted to GitHub **immediately** when there is a token, rather than waiting
   * for the next flush, and that is the one place this feature spends an API
   * call eagerly. The reason is the acknowledgement: a player who has just
   * written something wants to be told *"posted as #13"*, and a number that
   * arrives up to a minute later arrives after they have closed the panel.
   */
  async submit(
    clientId: string,
    ip: string,
    author: string,
    rawTitle: string,
    rawBody: string,
    at = this.now(),
  ): Promise<SuggestOutcome> {
    if (!validClientId(clientId)) {
      return { result: SUGGEST_RESULT.BAD, issue: 0, message: 'this client has no id — reload the page', changed: false };
    }
    const title = sanitiseTitle(rawTitle);
    if (title === '') {
      return { result: SUGGEST_RESULT.BAD, issue: 0, message: 'give it a title — a short line about the change', changed: false };
    }
    const body = sanitiseBody(rawBody);
    const week = weekKey(at);
    const ipHash = hashIp(ip);
    const mine = this.file.suggestions.filter((s) => s.clientId === clientId && weekKey(s.createdAt) === week);
    if (mine.length >= SUBMITS_PER_WEEK) {
      return {
        result: SUGGEST_RESULT.QUOTA,
        issue: 0,
        message: `${SUBMITS_PER_WEEK} suggestions a week — yours are back on Monday`,
        changed: false,
      };
    }
    const fromHere = this.file.suggestions.filter((s) => s.ipHash === ipHash && weekKey(s.createdAt) === week);
    if (fromHere.length >= IP_SUBMITS_PER_WEEK) {
      return {
        result: SUGGEST_RESULT.QUOTA,
        issue: 0,
        message: 'this connection has filed its share this week',
        changed: false,
      };
    }
    // Near-duplicates are refused rather than merged. Merging needs a human to
    // decide two sentences are the same thought, and the curator is that human
    // once a week -- what this stops is the accidental double-submit, which is a
    // player clicking twice on a slow connection.
    const dupe = this.file.suggestions.find(
      (s) => s.state !== 'closed' && s.title.toLowerCase() === title.toLowerCase(),
    );
    if (dupe) {
      return {
        result: SUGGEST_RESULT.BAD,
        issue: dupe.issue,
        message: dupe.issue > 0 ? `already suggested — that's #${dupe.issue}, vote for it` : 'already suggested — vote for it',
        changed: false,
      };
    }

    const s: StoredSuggestion = {
      localId: this.file.nextLocalId++,
      issue: 0,
      title,
      body,
      author,
      clientId,
      ipHash,
      createdAt: at,
      lastActivity: at,
      state: 'pending-sync',
      syncedScore: null,
    };
    this.file.suggestions.push(s);
    this.touch();

    if (!this.linked) {
      return {
        result: SUGGEST_RESULT.QUEUED,
        issue: 0,
        message: "queued — it'll post to GitHub once the server's link is set up. votes count now.",
        changed: true,
      };
    }
    const posted = await this.createIssue(s);
    if (posted) {
      return { result: SUGGEST_RESULT.OK, issue: s.issue, message: `posted as #${s.issue}`, changed: true };
    }
    return {
      result: SUGGEST_RESULT.QUEUED,
      issue: 0,
      message: 'queued — GitHub did not answer. votes count now; it posts on the next sync.',
      changed: true,
    };
  }

  /**
   * One vote. The whole mechanic is these twenty lines.
   *
   * Order of the checks matters and is deliberate: shape, then existence, then
   * *already voted on this one*, then the weekly budget, then the address cap.
   * Putting "already voted" before the budget is what makes the message useful
   * -- a player who clicks the same arrow twice should be told they already
   * voted for it rather than told they are out of votes, which they are not.
   */
  vote(clientId: string, ip: string, localId: number, dir: number, at = this.now()): SuggestOutcome {
    if (!validClientId(clientId)) {
      return { result: SUGGEST_RESULT.BAD, issue: 0, message: 'this client has no id — reload the page', changed: false };
    }
    const s = this.file.suggestions.find((x) => x.localId === localId);
    if (!s || s.state === 'closed') {
      return { result: SUGGEST_RESULT.UNKNOWN, issue: 0, message: 'that one is gone — refreshing the list', changed: true };
    }
    const week = weekKey(at);
    if (ONE_VOTE_PER_ITEM_PER_WEEK) {
      const already = this.file.votes.find(
        (v) => v.clientId === clientId && v.localId === localId && v.week === week,
      );
      if (already) {
        return {
          result: SUGGEST_RESULT.QUOTA,
          issue: s.issue,
          // The stacking rule, said out loud at the moment it applies, because
          // it is the one part of this mechanic that is not obvious from the UI.
          message: 'already voted on this one this week — you can vote for it again on Monday',
          changed: false,
        };
      }
    }
    const spent = this.file.votes.filter((v) => v.clientId === clientId && v.week === week).length;
    if (spent >= VOTES_PER_WEEK) {
      return {
        result: SUGGEST_RESULT.QUOTA,
        issue: s.issue,
        message: `no votes left — ${VOTES_PER_WEEK} a week, back on Monday`,
        changed: false,
      };
    }
    const ipHash = hashIp(ip);
    const fromHere = this.file.votes.filter((v) => v.ipHash === ipHash && v.week === week).length;
    if (fromHere >= IP_VOTES_PER_WEEK) {
      return {
        result: SUGGEST_RESULT.QUOTA,
        issue: s.issue,
        message: 'this connection has used its votes this week',
        changed: false,
      };
    }
    this.file.votes.push({ clientId, localId, week, dir: dir >= 0 ? 1 : -1, at, ipHash });
    s.lastActivity = at;
    this.touch();
    const left = VOTES_PER_WEEK - spent - 1;
    return {
      result: SUGGEST_RESULT.OK,
      issue: s.issue,
      message: left === 0 ? 'counted — that was your last vote this week' : `counted — ${left} left this week`,
      changed: true,
    };
  }

  // --- GitHub -----------------------------------------------------------------

  private api(path: string): string {
    return `https://api.github.com/repos/${this.repo}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sydney-suggestions',
    };
    // The one place the token is used, and it never goes anywhere else -- not
    // into a URL, not into a log line, not into an error message.
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * The body of an issue as this server writes it.
   *
   * Three parts, and the order is for the reader rather than for the parser:
   * what the player said, who said it, and then the machine-managed block. The
   * curator opens this to decide what to build, so the sentence is first and the
   * numbers are last.
   */
  private issueBody(s: StoredSuggestion): string {
    const { ups, downs } = this.tally(s.localId);
    const when = new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney',
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(s.createdAt));
    const voters = new Set(this.file.votes.filter((v) => v.localId === s.localId).map((v) => v.clientId)).size;
    return (
      `${s.body || '_(no detail given)_'}\n\n` +
      `---\n` +
      `Suggested in-game by **${s.author || 'someone'}** · ${when} (Sydney)\n\n` +
      `${TALLY_OPEN}\n` +
      `### Score ${ups - downs}\n\n` +
      `| up | down | voters | week |\n|---:|---:|---:|:---|\n` +
      `| ${ups} | ${downs} | ${voters} | ${weekKey(this.now())} |\n\n` +
      `_In-game votes. ${VOTES_PER_WEEK} per player per week, one per suggestion per week, ` +
      `score is all-time. This block is written by the game server — edits inside it are overwritten._\n` +
      `${TALLY_CLOSE}`
    );
  }

  /** POST one queued suggestion. Returns whether it is now on GitHub. */
  private async createIssue(s: StoredSuggestion): Promise<boolean> {
    if (!this.linked) return false;
    try {
      const res = await this.fetchImpl(this.api('/issues'), {
        method: 'POST',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ title: s.title, body: this.issueBody(s), labels: ['suggestion'] }),
      });
      if (!res.ok) {
        s.failures = (s.failures ?? 0) + 1;
        // **The status and nothing else.** Not the response body, not the
        // request, not a header. GitHub's error bodies quote request context
        // back at you, and the credential this server holds is the user's broad
        // `gh` OAuth token rather than a repo-scoped PAT -- so the blast radius
        // of one leaked string is their whole account, and the only safe amount
        // of GitHub's prose to keep is none. A status code is enough to tell
        // 401 (bad token) from 403 (rate limit) from 404 (wrong repo), which is
        // the whole of what an operator needs from this line.
        this.lastGithubError = `POST /issues -> ${res.status}`;
        if (s.failures >= 5) s.state = 'failed';
        this.touch();
        return false;
      }
      const issue = (await res.json()) as { number?: number };
      if (typeof issue.number !== 'number') return false;
      s.issue = issue.number;
      s.state = 'open';
      s.failures = 0;
      s.syncedScore = this.tally(s.localId).ups - this.tally(s.localId).downs;
      this.lastGithubError = '';
      this.touch();
      console.log(`[sydney] suggestions: posted "${s.title}" as ${this.repo}#${s.issue}`);
      return true;
    } catch (err) {
      s.failures = (s.failures ?? 0) + 1;
      this.lastGithubError = `POST /issues threw: ${String(err).slice(0, 200)}`;
      this.touch();
      return false;
    }
  }

  /** PATCH one issue's body so the tally block matches the ledger. */
  private async pushTally(s: StoredSuggestion): Promise<boolean> {
    if (!this.linked || s.issue <= 0) return false;
    try {
      const res = await this.fetchImpl(this.api(`/issues/${s.issue}`), {
        method: 'PATCH',
        headers: { ...this.headers(), 'content-type': 'application/json' },
        body: JSON.stringify({ body: this.issueBody(s) }),
      });
      if (!res.ok) {
        // Status only. See `createIssue` for why none of GitHub's prose is kept.
        this.lastGithubError = `PATCH /issues/${s.issue} -> ${res.status}`;
        return false;
      }
      const { ups, downs } = this.tally(s.localId);
      s.syncedScore = ups - downs;
      this.lastGithubError = '';
      this.touch();
      return true;
    } catch (err) {
      this.lastGithubError = `PATCH /issues/${s.issue} threw: ${String(err).slice(0, 200)}`;
      return false;
    }
  }

  /**
   * The flush: drain the queue, then push every tally that moved.
   *
   * Guarded by `syncing` because the shutdown path calls it while the timer may
   * already be inside it, and two concurrent drains would POST the same queued
   * suggestion twice -- which is a duplicate issue that cannot be un-filed.
   *
   * Returns what it did, which is what the checks assert on.
   */
  async sync(): Promise<{ posted: number; patched: number }> {
    if (this.syncing || !this.linked) return { posted: 0, patched: 0 };
    this.syncing = true;
    let posted = 0;
    let patched = 0;
    try {
      // Oldest first, so the issue numbers come out in the order they were
      // suggested. `failed` is retried too -- a token that was wrong when the
      // server booted is usually right by the time somebody notices.
      const queued = this.file.suggestions
        .filter((s) => s.state === 'pending-sync' || s.state === 'failed')
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const s of queued) {
        if (await this.createIssue(s)) posted++;
      }
      for (const s of this.file.suggestions) {
        if (s.state !== 'open' || s.issue <= 0) continue;
        const { ups, downs } = this.tally(s.localId);
        if (s.syncedScore === ups - downs) continue;
        if (await this.pushTally(s)) patched++;
      }
    } finally {
      this.syncing = false;
    }
    if (posted > 0 || patched > 0) {
      console.log(`[sydney] suggestions: synced ${posted} new issue(s), ${patched} tally update(s)`);
      await this.save();
    }
    return { posted, patched };
  }

  /**
   * Read the issue list back, and merge it.
   *
   * Two things this catches that the ledger cannot know on its own:
   *
   *   - **The user closed one.** That is how a week ends -- the winning
   *     suggestion is built and closed -- and the panel has to stop offering it
   *     as somewhere to spend a vote.
   *   - **The user (or anybody) wrote one on GitHub directly.** Adopted into the
   *     ledger with author `github`, so it appears in the panel and can be voted
   *     on like any other. That is what makes the issue list the source of truth
   *     for *what exists* while the ledger stays the source of truth for *what it
   *     scored*.
   *
   * Unauthenticated when there is no token, because the repo is public and the
   * whole point is that reading works before the credential does. A failure here
   * is **not** an error state: the last good list is already in the ledger and
   * that is what the panel keeps serving.
   */
  async refresh(): Promise<{ adopted: number; closed: number }> {
    let adopted = 0;
    let closed = 0;
    try {
      const res = await this.fetchImpl(this.api('/issues?labels=suggestion&state=all&per_page=100'), {
        headers: this.headers(),
      });
      if (!res.ok) {
        this.lastGithubError = `GET /issues -> ${res.status}`;
        return { adopted, closed };
      }
      const issues = (await res.json()) as Array<{
        number: number;
        title: string;
        body: string | null;
        state: string;
        pull_request?: unknown;
        user?: { login?: string };
      }>;
      if (!Array.isArray(issues)) return { adopted, closed };
      const seen = new Set<number>();
      for (const gh of issues) {
        // The issues endpoint returns pull requests too, and a PR labelled
        // `suggestion` is not a suggestion.
        if (gh.pull_request) continue;
        seen.add(gh.number);
        const known = this.file.suggestions.find((s) => s.issue === gh.number);
        if (known) {
          const shouldBe: SuggestionState = gh.state === 'closed' ? 'closed' : 'open';
          if (known.state !== shouldBe) {
            known.state = shouldBe;
            closed += shouldBe === 'closed' ? 1 : 0;
            this.touch();
          }
          // The title is GitHub's to edit -- the curator rewording a suggestion
          // is a normal thing to do and the panel should show the reworded one.
          const title = sanitiseTitle(gh.title);
          if (title && title !== known.title) {
            known.title = title;
            this.touch();
          }
          continue;
        }
        if (gh.state === 'closed') continue; // never lived in this ledger; nothing to adopt
        const title = sanitiseTitle(gh.title);
        if (!title) continue;
        this.file.suggestions.push({
          localId: this.file.nextLocalId++,
          issue: gh.number,
          title,
          // Everything before the tally block, so an adopted issue does not come
          // back with a score table inside its own body.
          body: sanitiseBody(stripTally(gh.body ?? '')),
          author: gh.user?.login ? `@${gh.user.login}` : 'github',
          clientId: '',
          ipHash: '',
          createdAt: this.now(),
          lastActivity: this.now(),
          state: 'open',
          syncedScore: null,
        });
        adopted++;
        this.touch();
      }
      this.lastRefreshAt = this.now();
      this.lastGithubError = '';
    } catch (err) {
      // GitHub being unreachable is not a failure of this feature. The ledger is
      // the last good list and the panel is already being served from it.
      this.lastGithubError = `GET /issues threw: ${String(err).slice(0, 200)}`;
    }
    if (adopted > 0 || closed > 0) {
      console.log(`[sydney] suggestions: refresh adopted ${adopted}, closed ${closed}`);
      await this.save();
    }
    return { adopted, closed };
  }

  /** For the checks: the raw records, read-only. */
  get records(): { suggestions: readonly StoredSuggestion[]; votes: readonly StoredVote[] } {
    return { suggestions: this.file.suggestions, votes: this.file.votes };
  }

  /** For the checks and for `/health`: what the mirror would write. */
  renderIssueBody(localId: number): string {
    const s = this.file.suggestions.find((x) => x.localId === localId);
    return s ? this.issueBody(s) : '';
  }
}

/**
 * Everything before the machine-managed block.
 *
 * Used when adopting an issue written on GitHub, and when re-reading one this
 * server wrote: without it, a body would accumulate a tally block inside a tally
 * block on every round trip.
 */
export function stripTally(body: string): string {
  const i = body.indexOf(TALLY_OPEN);
  if (i < 0) return body.trim();
  const j = body.indexOf(TALLY_CLOSE, i);
  const rest = j < 0 ? '' : body.slice(j + TALLY_CLOSE.length);
  return (body.slice(0, i) + rest).replace(/\n?---\n[\s\S]*$/, '').trim();
}

// --- The flood guard ----------------------------------------------------------

/**
 * A token bucket per socket, for this feature's traffic only.
 *
 * The weekly quotas stop a player from *deciding* too much; this stops a client
 * from *asking* too much. They are different failures with different costs: a
 * quota rejection is cheap, and a client that sends ten thousand LIST requests a
 * second would have the server serialise ten thousand lists -- which is a denial
 * of service made entirely out of messages that are individually legal.
 *
 * Twenty-four, refilled at two a second. The first cut of this was twelve and it
 * was **too tight**, which the integration check caught: opening the panel,
 * filing a suggestion and spending four votes is a dozen requests on its own,
 * and a player who does all of that briskly is not flooding anything. The number
 * has to sit above what a determined *person* can do and below what a loop does
 * in a millisecond, and those two are three orders of magnitude apart -- so
 * being generous costs nothing and being stingy breaks the feature for whoever
 * uses it most.
 *
 * Refilled continuously rather than reset on a window, so a client that behaves
 * for nine seconds is not punished at the tenth.
 */
/*
 * The size and the refill rate are **arguments with the suggestions numbers as
 * defaults**, so every existing call site reads exactly as it did. That is not
 * generality for its own sake: `server/bugs.ts` needs the same bucket at a
 * completely different scale -- three tokens refilling one every ten minutes,
 * where this is twenty-four refilling two a second -- and the requirement was to
 * reuse this shape rather than invent a second one. Two rate limiters is two
 * sets of boundary conditions to get right, and this one has already been
 * argued about and re-tuned once.
 */
export class FloodGuard {
  private readonly burst: number;
  private readonly refillPerSec: number;
  private tokens: number;
  private at = 0;

  constructor(now = Date.now(), burst = SUGGEST_BURST, refillPerSec = SUGGEST_REFILL_PER_SEC) {
    this.burst = burst;
    this.refillPerSec = refillPerSec;
    this.tokens = burst;
    this.at = now;
  }

  allow(now = Date.now()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.refillPerSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

export const SUGGEST_BURST = 24;
export const SUGGEST_REFILL_PER_SEC = 2;

// --- The socket seam ----------------------------------------------------------

/**
 * What `server/index.ts` talks to: one method on the message path, one on close.
 *
 * The same shape `ChatHub` takes, and for the same reason -- a feature that
 * needs three cases in the central switch is a feature that has put itself in
 * the middle of the server. This one is two lines there and everything else is
 * here.
 *
 * It holds **which sockets have a panel open**, which is the only per-connection
 * state the feature has. A socket joins that set by asking for a list and leaves
 * it when it closes, and the set is what a change is broadcast to: two people
 * voting beside each other should be looking at one list, and polling for that
 * would be a message a second per open panel to say nothing has happened.
 */
export class SuggestionHub {
  private readonly store: SuggestionStore;
  /** Open panels: socket to the client id that opened it, and its flood budget. */
  private readonly open = new Map<SuggestSocket, { clientId: string; guard: FloodGuard }>();

  constructor(store: SuggestionStore) {
    this.store = store;
  }

  /**
   * One `MSG.SUGGEST` frame.
   *
   * Every failure path here **returns without answering** rather than closing
   * the socket, which is this server's rule for a malformed frame everywhere
   * else: a client that sends rubbish is far more often an old build or a
   * truncated write than an attack, and dropping a player out of a game they are
   * standing in is a disproportionate answer to a bad byte.
   */
  async handle(ws: SuggestSocket, frame: ArrayBuffer, now = Date.now()): Promise<void> {
    const req = decodeSuggest(frame, MSG_SUGGEST);
    if (!req) return;
    if (!validClientId(req.clientId)) return;

    // The flood budget is per socket and covers this feature's whole
    // conversation -- see `FloodGuard`. Checked before anything is parsed
    // further or written, because the point is to make the expensive path
    // unreachable rather than to reject at the end of it.
    let seat = this.open.get(ws);
    if (!seat) {
      seat = { clientId: req.clientId, guard: new FloodGuard(now) };
      this.open.set(ws, seat);
    }
    seat.clientId = req.clientId;
    if (!seat.guard.allow(now)) {
      send(ws, encodeSuggestAck(MSG_SUGGEST_ACK, SUGGEST_RESULT.RATE, 0, 'slow down a moment'));
      return;
    }

    const ip = addressOf(ws);
    if (req.op === SUGGEST_OP.LIST) {
      this.sendList(ws, req.clientId, now);
      return;
    }
    if (req.op === SUGGEST_OP.VOTE) {
      const out = this.store.vote(req.clientId, ip, req.localId, req.dir, now);
      send(ws, encodeSuggestAck(MSG_SUGGEST_ACK, out.result, out.issue, out.message));
      if (out.changed) this.broadcast(now);
      else this.sendList(ws, req.clientId, now);
      return;
    }
    if (req.op === SUGGEST_OP.SUBMIT) {
      // The in-game name, taken from the **participant on this socket** rather
      // than from anything the client sent. It is the one field in a suggestion
      // that is not the player's to choose here, because the server already
      // assigned it at join (sanitised and deduped) and a second name supplied
      // on this path would let somebody file a suggestion as somebody else.
      const author = ws.data?.participant?.name ?? '';
      const out = await this.store.submit(req.clientId, ip, author, req.title, req.body, now);
      send(ws, encodeSuggestAck(MSG_SUGGEST_ACK, out.result, out.issue, out.message));
      if (out.changed) this.broadcast(now);
      return;
    }
  }

  /** A socket went away. Called from `index.ts`'s `close`. */
  forget(ws: SuggestSocket): void {
    this.open.delete(ws);
  }

  private sendList(ws: SuggestSocket, clientId: string, now: number): void {
    send(ws, encodeSuggestionList(MSG_SUGGEST_LIST, this.store.list(clientId, now)));
  }

  /**
   * Push the list to every open panel.
   *
   * **Per socket rather than one encoded frame fanned out**, which is the one
   * place this feature deliberately does not do what the snapshot path does.
   * `server/room.ts` deduplicates identical snapshot bodies across clients
   * because a snapshot is a function of the working set and nothing else; a
   * suggestion list carries `myVote` and `votesLeft`, which are facts about the
   * *recipient*, so there is no shared body to encode once. The cost is one
   * encode per open panel per vote, which at a handful of panels and a few votes
   * a minute is not a cost.
   *
   * A dead socket is dropped rather than retried: `send` throws on a closed
   * connection in Bun, and a hub that let that propagate would take the message
   * pump down for everyone on the host.
   */
  broadcast(now = Date.now()): void {
    for (const [ws, seat] of this.open) {
      try {
        this.sendList(ws, seat.clientId, now);
      } catch {
        this.open.delete(ws);
      }
    }
  }

  /** How many panels are open. For the log line and the checks. */
  get openPanels(): number {
    return this.open.size;
  }
}

/**
 * The socket shape this hub needs, which is deliberately narrower than
 * `room.Socket`.
 *
 * Structural rather than an import, so nothing about the suggestions feature is
 * wired into the room type that every other part of the server shares. What it
 * wants is: something to send on, the participant's name, and an address.
 */
export interface SuggestSocket {
  data?: { participant?: { name?: string } | null } | null;
  send(data: ArrayBuffer | Uint8Array): number;
  remoteAddress?: string;
}

function send(ws: SuggestSocket, frame: ArrayBuffer): void {
  try {
    ws.send(frame);
  } catch {
    // A socket that closed between the decision and the reply. The decision is
    // already in the ledger, which is the part that mattered.
  }
}

/**
 * The address behind a socket, or a constant when there is not one.
 *
 * `'unknown'` rather than an empty string, and rather than skipping the cap:
 * every connection with no discoverable address shares one bucket, which is the
 * conservative direction. A test harness on a unix socket and a proxy that hides
 * the peer both land there, and the effect is that they collectively get the
 * per-address allowance rather than an unlimited one.
 *
 * **This is the address as the socket sees it**, which behind Caddy is Caddy.
 * That is stated rather than worked around: `X-Forwarded-For` is a header a
 * client can set, so trusting it would replace a weak cap with a decorative one.
 * The consequence is honest and worth knowing -- behind a reverse proxy the
 * per-IP cap collapses to a per-deployment cap, and the client id is doing
 * essentially all of the work. See `net/suggestions.ts` on how much work that is.
 */
function addressOf(ws: SuggestSocket): string {
  return ws.remoteAddress ?? 'unknown';
}

// --- Where the file lives -----------------------------------------------------

/**
 * The ledger's path: `SYDNEY_SUGGESTIONS`, or `data/suggestions.json`.
 *
 * **`data/`, and emphatically not beside the world.** The first cut of this put
 * it next to `client/public/world/`, which is one directory up from the world
 * and is therefore inside `client/public/` -- and `client/public/` is *served*.
 * The ledger was live at `http://host/suggestions.json`, which is a public list
 * of every client id and address hash that has ever voted. It was also
 * untracked-but-not-ignored, so the next `git add -A` would have published the
 * same file to a public repo permanently.
 *
 * `data/` is the right home on both counts and for the reason the world
 * directory looked right: it is already this project's durable-state directory
 * (`data/ledger.sqlite` lives there), it is already `.gitignore`d in full, and
 * nothing serves it. A deployment that mounts one writable directory should
 * mount this one.
 *
 * Resolved from this module's own URL rather than from the world root, so the
 * answer does not move when somebody points `SYDNEY_WORLD` somewhere else --
 * the ledger has nothing to do with which city is loaded.
 */
export function defaultLedgerPath(worldRoot: string): string {
  void worldRoot;
  return process.env.SYDNEY_SUGGESTIONS ?? new URL('../data/suggestions.json', import.meta.url).pathname;
}

export function githubRepo(): string {
  return process.env.SYDNEY_GITHUB_REPO ?? 'voidtype/sydrunner';
}

export function githubToken(): string {
  return process.env.SYDNEY_GITHUB_TOKEN ?? '';
}
