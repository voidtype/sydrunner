/**
 * The content store, the quest engine and the AI seam.
 *
 * `client/src/game/questmodel.ts` is the contract -- the schema, the parser and
 * the arithmetic -- and `client/src/net/quests.ts` is the wire. This is the
 * half only the server has: a directory of JSON that is polled from GitHub, a
 * ledger holding the last good copy, the cursors that decide what each player
 * is being asked to do, and one guarded call to a language model.
 *
 * `server/suggestions.ts` is the file this one was grown from and the parts
 * copied deliberately are worth naming, because each of them was argued out
 * there and is not re-argued here: the **GitHub read on a timer**, the
 * **atomic temp-file-and-rename** write, the **status code and nothing else**
 * in every error line, the **no-token-is-a-supported-state** posture, and the
 * rule that an unreachable GitHub is *not* a failure of the feature -- the
 * ledger is the last good copy and it is already what is being served.
 *
 * Where this differs, it says so. The two big differences are both about what
 * the data *is*:
 *
 *   - A suggestion is **written by players and mirrored to GitHub**. A quest
 *     pack is **written on GitHub and mirrored to players**. The arrow is the
 *     other way round, so there is no queue, no vote ledger and no POST -- this
 *     file only ever reads, and it reads two directories.
 *   - A malformed suggestion is one bad row. A malformed pack is **refused
 *     whole**, which is the single most important rule in this file and is the
 *     one the owner's brief states outright. Half a pack is worse than none: it
 *     is a player standing in Marrickville whose fourth step no longer exists,
 *     with a cursor pointing at it, and nothing anywhere that says why.
 *
 * ---------------------------------------------------------------------------
 * THE PUBLISH PATH, END TO END
 *
 *     1. Edit `content/quests/act0.json` on github.com. Commit.
 *     2. Within five minutes this server's timer fetches the directory
 *        listing and every file in it (`content/quests/` and `content/dialog/`).
 *     3. Every file is parsed by `parseQuestPack` / `parseDialogPack` and the
 *        whole set by `validateBundle` -- prereqs exist, the graph is acyclic,
 *        every dialog reference lands, every quest has a way in and a way out.
 *        **Plus this file's own pass**, which the shared validator cannot do:
 *        an NPC kind named by a `ko` step must be a kind this build actually
 *        registered, because `questmodel.ts` has never heard of `NPC_KIND`.
 *     4. One error anywhere and the whole fetch is discarded with a log line.
 *        The previously good bundle keeps serving. Nobody notices.
 *     5. No error, and the new bundle becomes live: written to the ledger, the
 *        revision stamp changes, and every client picks it up from `/content`
 *        on its next ETag check.
 *
 * `SYDNEY_CONTENT_DIR` short-circuits steps 1-2 and reads a local directory
 * instead, which is what development and `server/quests-check.ts` use. The
 * repo's own `content/` is the default and is read at boot **as a gate**: the
 * bundled packs are part of the build, so a bad one is a build that must not
 * start. A pack fetched at *runtime* is refused-and-kept instead, because a bad
 * commit must not be able to take the game down.
 *
 * ---------------------------------------------------------------------------
 * THE AI SEAM, AND THE RULE THAT MAKES IT SAFE
 *
 * A dialog node may carry `improv: { persona, context }`, and when the three
 * environment variables are set this file renders that node's line through an
 * external model. Five rules, and all five are structural rather than careful:
 *
 *   1. **Improv is cosmetic.** The schema forbids `accept`, `turnin` and `cost`
 *      on a node marked improv and `verifyDialog` refuses a pack that breaks
 *      it. The model paints; the data decides. Nothing a model returns can
 *      move a cursor, set a flag or touch a wallet, because there is no field
 *      on an improv node that could.
 *   2. **Nothing player-generated ever goes into a prompt.** The persona and
 *      the context are authored strings out of a content pack in this repo.
 *      No player name, no handle, no chat line, no suggestion text, no
 *      position, no quest state. This is a third-party endpoint on the other
 *      side of the world and the game sends it nothing a player typed. It is a
 *      rule, not a preference: `buildPrompt` below takes a `DialogNode` and
 *      nothing else, and that signature is the enforcement.
 *   3. **Off the tick, always.** The fetch is fired and forgotten; the node
 *      serves whatever is in the cache *right now*, which on a cache miss is
 *      the authored line. A model that hangs for thirty seconds costs a stale
 *      line and never a late tick.
 *   4. **One call per node per week.** The cache is keyed `(npc, node, week)`
 *      on the same Monday everything else in this game turns over
 *      (`net/suggestions.weekKey`), so a node a hundred players walk past costs
 *      one request, and the NPC says a slightly different thing each week --
 *      which is the whole of what improv is for.
 *   5. **Rate limits are invisible.** The tier this runs on is free, so fills
 *      are single-flight (one request in the air, the rest queued) with
 *      exponential backoff on 429 and 5xx. A throttled fill serves the
 *      authored line and says nothing to anybody.
 *
 * The output is display text and is treated as hostile: `questmodel.
 * clampImprov` strips markup, flattens newlines and clips to 200 characters
 * before it is stored, let alone sent.
 *
 *     SYDNEY_DIALOG_AI_URL    an OpenAI-compatible base, e.g. .../v1
 *     SYDNEY_DIALOG_AI_KEY    the bearer. **Never logged, never echoed.**
 *     SYDNEY_DIALOG_AI_MODEL  defaults to `glm-4.7-flash`
 *
 * With no key the feature is **off, not broken**: every improv node serves its
 * authored line, which is why the schema requires one. That is the ordinary
 * configuration -- a laptop, a check, a fresh box -- and it is a supported
 * state rather than a degraded one, exactly as `SuggestionStore` says about its
 * own missing token.
 *
 * ---------------------------------------------------------------------------
 * GUESTS
 *
 * A guest can take a quest, walk it and turn it in. What they cannot do is keep
 * it: their cursors live in a `Map` on this object and their story flags in a
 * `Set` beside it, both keyed by player id, and both are gone when the socket
 * closes. That is the same honest split every other feature here makes -- the
 * ladder, the wallet, the team -- and it is stated rather than enforced by a
 * refusal, because a guest who is told "sign up to take a job" is being shown
 * the wall this whole accounts design refuses to be.
 */

import { MSG } from '../client/src/net/protocol.ts';
import { TEAM_NAME, type Team } from '../client/src/game/teams.ts';
import { npcKinds } from '../client/src/game/factions.ts';
import { KIND_NAME } from '../client/src/game/powerups.ts';
import { weekKey } from '../client/src/net/suggestions.ts';
import { isWeekly, completionFlag,
  EMPTY_BUNDLE,
  STEP_KIND,
  addProgress,
  blankCursor,
  MAX_NPCS_PER_BUNDLE,
  MAX_QUESTS_PER_BUNDLE,
  choiceRefusal,
  clampImprov,
  doneFlag,
  openStep,
  parseDialogPack,
  parseQuestPack,
  questRefusal,
  reconcileCursor,
  validateBundle,
  withinStep,
  type ContentBundle,
  type DialogNode,
  type DialogNpc,
  type PlayerFacts,
  type Quest,
  type QuestCursor,
  type QuestCursors,
} from '../client/src/game/questmodel.ts';
import { NODE_OPENED, QUEST_OP, encodeQuestState, type QuestStateFrame, type WireCursor } from '../client/src/net/quests.ts';
import { setWeeklySweep, MAX_STORY_FLAGS, type AccountRecord } from '../client/src/net/accounts.ts';
import type { AccountStore } from './accounts.ts';
import { FloodGuard } from './suggestions.ts';

// --- Where the content comes from -------------------------------------------------

/** The repo's own packs. Read at boot **as a gate**; see the header. */
export function bundledContentDir(): string {
  return process.env.SYDNEY_CONTENT_DIR ?? new URL('../content', import.meta.url).pathname;
}

/** Whether a local directory was named, which turns the GitHub poll off. */
export function contentIsLocal(): boolean {
  return (process.env.SYDNEY_CONTENT_DIR ?? '') !== '';
}

/** The ledger's home, beside the accounts and the wallets. Never rsynced over. */
export function defaultContentLedgerPath(): string {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  return `${dir.replace(/\/+$/, '')}/quest-content.json`;
}

export function contentRepo(): string {
  return process.env.SYDNEY_GITHUB_REPO ?? 'voidtype/sydrunner';
}

export function contentBranch(): string {
  return process.env.SYDNEY_CONTENT_REF ?? 'main';
}

/** The two directories, in the order they are read. Quests first, for the log. */
const CONTENT_DIRS = ['content/quests', 'content/dialog'] as const;

/** How often GitHub is asked. Five minutes, `SuggestionStore.refresh`'s number. */
export const CONTENT_POLL_MS = 5 * 60_000;

/**
 * A set of raw files, keyed by their path. What the ledger holds and what a
 * revision is computed over.
 */
type RawFiles = Record<string, string>;

/**
 * Turn a set of raw files into a bundle, or into a list of complaints.
 *
 * **The one place a pack becomes live**, run identically over the bundled
 * directory, over a GitHub fetch and over the check's fixture -- which is what
 * makes "it validated on my laptop" mean something.
 *
 * `extra` is this file's own referential pass, and it is here rather than in
 * `validateBundle` because it needs things the shared module has never heard
 * of: the `NPC_KIND` registry and the powerup table are both server-and-client
 * runtime state, not schema, and a validator that imported them would stop
 * being loadable by a tool that just wants to lint a JSON file.
 */
export function bundleFrom(files: RawFiles): { bundle: ContentBundle; errors: string[] } {
  const errors: string[] = [];
  const quests: Quest[] = [];
  const npcs: DialogNpc[] = [];
  for (const path of Object.keys(files).sort()) {
    const text = files[path];
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (err) {
      errors.push(`${path}: not JSON (${String(err).slice(0, 120)}).`);
      continue;
    }
    const name = path.split('/').pop()?.replace(/\.json$/i, '') ?? path;
    if (path.includes('/dialog/')) {
      const parsed = parseDialogPack(raw, name);
      errors.push(...parsed.errors);
      npcs.push(...parsed.value.npcs);
    } else {
      const parsed = parseQuestPack(raw, name);
      errors.push(...parsed.errors);
      quests.push(...parsed.value.quests);
    }
  }
  // Every file parsed clean and the merge is still refusable: the client reads
  // this bundle back with the *bundle* caps, and a merge past them is a merge
  // every browser drops on the floor without saying so. Refused here instead,
  // where a reason reaches the log and the last good pack keeps serving --
  // which is what the pipeline promises for every other kind of bad pack.
  if (quests.length > MAX_QUESTS_PER_BUNDLE) {
    errors.push(
      `the merged bundle carries ${quests.length} quests, over the ${MAX_QUESTS_PER_BUNDLE} every client parses it with.`,
    );
  }
  if (npcs.length > MAX_NPCS_PER_BUNDLE) {
    errors.push(
      `the merged bundle carries ${npcs.length} npcs, over the ${MAX_NPCS_PER_BUNDLE} every client parses it with.`,
    );
  }
  errors.push(...validateBundle(quests, npcs));
  errors.push(...worldRefusals(quests));
  return { bundle: { quests, npcs, revision: revisionOf(files) }, errors };
}

/**
 * What the shared validator cannot check: names that must exist *in this build*.
 *
 * A `ko` step naming "eshey" is a step nobody can ever satisfy -- there is no
 * such NPC kind, so no knockout ever matches it, and the quest silently never
 * advances. Same for a powerup. Both are one-line typos in a text file and both
 * produce a game that runs perfectly and a job that cannot be finished, which
 * is precisely the class of failure this repo writes checks for.
 *
 * The refusal names the valid set, because the author is reading this in a
 * server log five minutes after a commit and the useful thing to tell them is
 * what they could have typed.
 */
function worldRefusals(quests: readonly Quest[]): string[] {
  const errors: string[] = [];
  const kinds = new Set(npcKinds().map((k) => k.name.toLowerCase()));
  const powerups = new Set(Object.values(KIND_NAME).map((n) => n.toLowerCase()));
  /*
   * **An empty registry is "nothing has loaded yet", not "no kinds exist".**
   *
   * `NPC_KIND` is populated by module side effects -- `game/characters.ts`,
   * `game/wildlife.ts`, `game/streetlife.ts` and `game/heat.ts` each call
   * `registerNpcKind` at import time -- and this module imports none of them,
   * deliberately, because a content validator that pulled in the whole faction
   * system could not be run by a linting script. In the two processes that
   * matter it is fully populated by the time a pack is validated, because both
   * construct a `Simulation` first.
   *
   * If it somehow is not, refusing every pack that names an eshay would be a
   * validator taking the game down over its own import order. Skipping is the
   * conservative direction and it costs the check that catches a typo, which
   * is the smaller of the two losses.
   */
  const checkKinds = kinds.size > 0;
  for (const q of quests) {
    for (const step of q.steps) {
      if (checkKinds && step.kind === STEP_KIND.KO && step.npc !== 'any' && step.npc !== 'player' && !kinds.has(step.npc)) {
        errors.push(
          `Quest "${q.id}": no npc kind is called "${step.npc}". This build has ${[...kinds].sort().join(', ')}, ` +
            'plus "player" and "any".',
        );
      }
      if (step.kind === STEP_KIND.BUY && step.powerup !== 'any' && !powerups.has(step.powerup)) {
        errors.push(
          `Quest "${q.id}": no powerup is called "${step.powerup}". This build has ${[...powerups].sort().join(', ')}, plus "any".`,
        );
      }
    }
  }
  return errors;
}

/**
 * A stamp over the raw bytes. The `/content` ETag and the "did anything change".
 *
 * Over the **files** rather than over the parsed bundle, deliberately: a
 * comment or a reordering in the JSON should produce a new revision, because
 * the author changed the file and the honest answer to "is this what is live"
 * is about the file. It also means the stamp can be computed before anything
 * is parsed, which is what lets the poll skip a re-validation when GitHub
 * hands back exactly what is already loaded.
 */
export function revisionOf(files: RawFiles): string {
  const h = new Bun.CryptoHasher('sha256');
  for (const path of Object.keys(files).sort()) {
    h.update(path);
    h.update('\0');
    h.update(files[path]);
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}

interface LedgerFile {
  version: 1;
  revision: string;
  fetchedMs: number;
  files: RawFiles;
}

/**
 * The packs, wherever they came from, and the machinery that keeps them fresh.
 */
/**
 * Tell the week which flags it sweeps: the completion marks and the unlock
 * flags of every weekly quest in the live bundle. `net/accounts.resetIfNewWeek`
 * reads the set on every Monday and on the one-off reset; without this it
 * would clear a weekly job's `w:` mark and leave the unlock flag its offer is
 * denied on, which is a job done once and never offered again.
 */
function announceWeekly(bundle: ContentBundle): void {
  const flags = new Set<string>();
  for (const q of bundle.quests) {
    if (!isWeekly(q)) continue;
    flags.add(completionFlag(q.id));
    for (const f of q.reward.unlock) if (!f.startsWith('act')) flags.add(f);
  }
  setWeeklySweep(flags);
}

export class ContentStore {
  private readonly ledgerPath: string;
  private readonly repo: string;
  private readonly branch: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dir: string;
  private readonly local: boolean;

  private live: ContentBundle = EMPTY_BUNDLE;
  private files: RawFiles = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  /** The last thing that went wrong, for `/health` and the log. Never a token. */
  lastError = '';
  lastFetchMs = 0;
  /** How many times a fetch was refused whole. The number an operator wants. */
  refusals = 0;
  /** Why the most recent refusal happened, first line only. */
  lastRefusal = '';

  constructor(options: {
    ledgerPath?: string;
    dir?: string;
    repo?: string;
    branch?: string;
    token?: string;
    timers?: boolean;
    fetch?: typeof fetch;
  } = {}) {
    this.ledgerPath = options.ledgerPath ?? defaultContentLedgerPath();
    this.dir = options.dir ?? bundledContentDir();
    this.local = options.dir !== undefined || contentIsLocal();
    this.repo = options.repo ?? contentRepo();
    this.branch = options.branch ?? contentBranch();
    this.token = options.token ?? process.env.SYDNEY_GITHUB_TOKEN ?? '';
    this.fetchImpl = options.fetch ?? fetch;
    if (options.timers !== false && !this.local) {
      this.timer = setInterval(() => void this.poll(), CONTENT_POLL_MS);
    }
  }

  get bundle(): ContentBundle {
    return this.live;
  }

  get revision(): string {
    return this.live.revision;
  }

  /** One line for the boot log. Incapable of leaking a credential. */
  describe(): string {
    const where = this.local ? this.dir : `${this.repo}@${this.branch}`;
    const refused = this.refusals > 0 ? `, ${this.refusals} refused` : '';
    return `${this.live.quests.length} quest(s), ${this.live.npcs.length} npc(s) from ${where} (rev ${this.revision})${refused}`;
  }

  /**
   * Read the packs at boot, and say what is wrong with them.
   *
   * **Returns the errors rather than throwing**, so `server/index.ts` can put
   * them in its self-check list beside everything else and refuse to start with
   * one message. That is the gate the header describes: the bundled packs are
   * part of the build, so a bad one is a build that must not run.
   *
   * The ledger is preferred over the directory when it is **newer and good**,
   * and that is not an optimisation -- it is the whole of "content without a
   * deploy surviving a restart". A box that has been fetching packs from GitHub
   * for three weeks and is then restarted must come back on the packs it was
   * serving, not on whatever shipped in the tarball. A ledger that will not
   * parse or will not validate is ignored and logged, and the directory serves.
   */
  async load(): Promise<string[]> {
    const disk = await this.readDir(this.dir);
    const built = bundleFrom(disk);
    if (built.errors.length > 0) {
      // Not a refusal-and-keep: there is nothing to keep. Reported to the boot
      // gate, which is the caller's to act on.
      return built.errors.map((e) => `bundled content: ${e}`);
    }
    this.files = disk;
    this.live = built.bundle;
    announceWeekly(this.live);

    if (!this.local) {
      const stored = await this.readLedger();
      if (stored !== null && stored.revision !== this.live.revision) {
        const fromLedger = bundleFrom(stored.files);
        if (fromLedger.errors.length === 0) {
          this.files = stored.files;
          this.live = fromLedger.bundle;
          announceWeekly(this.live);
          this.lastFetchMs = stored.fetchedMs;
          console.log(`[sydney] quests: serving rev ${this.revision} from the ledger (fetched ${new Date(stored.fetchedMs).toISOString()})`);
        } else {
          console.error(`[sydney] quests: the ledger at ${this.ledgerPath} no longer validates; serving the bundled packs.`);
          for (const e of fromLedger.errors.slice(0, 5)) console.error(`  ${e}`);
        }
      }
    }
    return [];
  }

  /** Every `*.json` under a directory, keyed by `content/<kind>/<name>.json`. */
  private async readDir(root: string): Promise<RawFiles> {
    const out: RawFiles = {};
    for (const rel of CONTENT_DIRS) {
      const dir = `${root.replace(/\/+$/, '')}/${rel.split('/')[1]}`;
      let names: string[] = [];
      try {
        // `Bun.$` rather than `node:fs`, on this repo's standing preference in
        // the server half. A missing directory is not an error: a deployment
        // that ships no dialog packs is a deployment with no dialog, which is
        // a state the game runs perfectly in.
        const listed = await Bun.$`ls -1 ${dir}`.quiet().nothrow();
        if (listed.exitCode !== 0) continue;
        names = listed.stdout.toString().split('\n').map((s) => s.trim()).filter((s) => s.endsWith('.json'));
      } catch {
        continue;
      }
      for (const name of names.sort()) {
        try {
          out[`${rel}/${name}`] = await Bun.file(`${dir}/${name}`).text();
        } catch (err) {
          out[`${rel}/${name}`] = `<<unreadable: ${String(err).slice(0, 80)}>>`;
        }
      }
    }
    return out;
  }

  // --- GitHub -------------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'sydney-quests',
    };
    // The one place the token is used. Never in a URL, never in a log line,
    // never in an error message. `SuggestionStore.headers`' rule verbatim.
    if (this.token) h.authorization = `Bearer ${this.token}`;
    return h;
  }

  /**
   * Ask GitHub for both directories and apply the result, or keep what we have.
   *
   * **Refused whole**, which is the rule this whole file exists to hold. One
   * parse error, one dangling prereq, one NPC kind spelt wrong, and *nothing*
   * changes: the previous bundle keeps serving, the errors go to the log, and
   * every player carries on inside the world they were already in.
   *
   * A network failure is not even a refusal -- it is nothing at all. GitHub
   * being unreachable is `SuggestionStore.refresh`'s "not a failure of this
   * feature": the ledger is the last good copy and that is what is being
   * served.
   */
  async poll(): Promise<{ changed: boolean; errors: string[] }> {
    if (this.polling || this.local) return { changed: false, errors: [] };
    this.polling = true;
    try {
      const fetched: RawFiles = {};
      for (const rel of CONTENT_DIRS) {
        const listing = await this.list(rel);
        if (listing === null) return { changed: false, errors: [] };
        for (const [path, url] of listing) {
          const text = await this.download(url);
          if (text === null) return { changed: false, errors: [] };
          fetched[path] = text;
        }
      }
      this.lastFetchMs = Date.now();
      const revision = revisionOf(fetched);
      if (revision === this.live.revision) return { changed: false, errors: [] };
      const built = bundleFrom(fetched);
      if (built.errors.length > 0) {
        this.refusals++;
        this.lastRefusal = built.errors[0];
        console.error(
          `[sydney] quests: rev ${revision} REFUSED WHOLE (${built.errors.length} problem(s)); ` +
            `still serving rev ${this.live.revision}.`,
        );
        for (const e of built.errors.slice(0, 10)) console.error(`  ${e}`);
        if (built.errors.length > 10) console.error(`  ... and ${built.errors.length - 10} more`);
        return { changed: false, errors: built.errors };
      }
      this.files = fetched;
      this.live = built.bundle;
    announceWeekly(this.live);
      await this.writeLedger();
      console.log(
        `[sydney] quests: rev ${revision} live — ${built.bundle.quests.length} quest(s), ${built.bundle.npcs.length} npc(s)`,
      );
      return { changed: true, errors: [] };
    } finally {
      this.polling = false;
    }
  }

  /** `[path, downloadUrl]` for every JSON file in one directory, or null. */
  private async list(rel: string): Promise<Array<[string, string]> | null> {
    try {
      const url = `https://api.github.com/repos/${this.repo}/contents/${rel}?ref=${encodeURIComponent(this.branch)}`;
      const res = await this.fetchImpl(url, { headers: this.headers() });
      if (!res.ok) {
        // **The status and nothing else.** `SuggestionStore.createIssue`'s rule
        // and its reason: GitHub's error bodies quote request context back at
        // you and the credential this process holds is broad.
        this.lastError = `GET /contents/${rel} -> ${res.status}`;
        return null;
      }
      const rows = (await res.json()) as Array<{ name?: string; type?: string; download_url?: string | null }>;
      if (!Array.isArray(rows)) return null;
      const out: Array<[string, string]> = [];
      for (const row of rows) {
        if (row.type !== 'file' || typeof row.name !== 'string' || !row.name.endsWith('.json')) continue;
        if (typeof row.download_url !== 'string' || row.download_url === '') continue;
        out.push([`${rel}/${row.name}`, row.download_url]);
      }
      this.lastError = '';
      return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
    } catch (err) {
      this.lastError = `GET /contents/${rel} threw: ${String(err).slice(0, 160)}`;
      return null;
    }
  }

  /** One file's text, capped. A pack is kilobytes; a megabyte is a mistake. */
  private async download(url: string): Promise<string | null> {
    try {
      const res = await this.fetchImpl(url, { headers: { 'user-agent': 'sydney-quests' } });
      if (!res.ok) {
        this.lastError = `GET raw -> ${res.status}`;
        return null;
      }
      const text = await res.text();
      if (text.length > MAX_PACK_BYTES) {
        this.lastError = `a content file is ${text.length} bytes, over the ${MAX_PACK_BYTES} cap`;
        return null;
      }
      return text;
    } catch (err) {
      this.lastError = `GET raw threw: ${String(err).slice(0, 160)}`;
      return null;
    }
  }

  private async readLedger(): Promise<LedgerFile | null> {
    try {
      const f = Bun.file(this.ledgerPath);
      if (!(await f.exists())) return null;
      const raw = (await f.json()) as LedgerFile;
      if (!raw || typeof raw !== 'object' || typeof raw.files !== 'object' || raw.files === null) return null;
      const files: RawFiles = {};
      for (const [path, text] of Object.entries(raw.files)) {
        if (typeof text === 'string' && text.length <= MAX_PACK_BYTES) files[path] = text;
      }
      return { version: 1, revision: revisionOf(files), fetchedMs: Number(raw.fetchedMs) || 0, files };
    } catch (err) {
      console.error(`[sydney] quests: ${this.ledgerPath} would not parse (${String(err).slice(0, 120)}); ignoring it.`);
      return null;
    }
  }

  /** Atomic, on `SuggestionStore.save`'s argument: a rename or the old file. */
  private async writeLedger(): Promise<void> {
    const body: LedgerFile = { version: 1, revision: this.live.revision, fetchedMs: this.lastFetchMs, files: this.files };
    const tmp = `${this.ledgerPath}.tmp-${process.pid}`;
    try {
      await Bun.write(tmp, JSON.stringify(body));
      await Bun.$`mv -f ${tmp} ${this.ledgerPath}`.quiet();
    } catch (err) {
      console.error(`[sydney] quests: could not write ${this.ledgerPath}: ${String(err).slice(0, 120)}`);
    }
  }

  /**
   * The serialised bundle and its gzip, keyed on the revision that produced it.
   *
   * One object rather than two fields so the two can never be a revision apart:
   * a gzip of yesterday's quests served under today's ETag is the kind of bug
   * that looks like a caching problem for a week.
   */
  private wire: { revision: string; json: string; gzip: Uint8Array<ArrayBuffer> | null } | null = null;

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** What `GET /content` serves. The client walks this and nothing else. */
  serialise(): string {
    const cached = this.wire;
    if (cached !== null && cached.revision === this.live.revision) return cached.json;
    const json = JSON.stringify({ revision: this.live.revision, quests: this.live.quests, npcs: this.live.npcs });
    this.wire = { revision: this.live.revision, json, gzip: null };
    return json;
  }

  /**
   * The same bytes, gzipped, built once per revision.
   *
   * **This became necessary rather than nice on the day the city went from six
   * hundred quests to two thousand.** The bundle is 6.4 MB of JSON now, it is
   * fetched on every cold load, and DESIGN.md rule 8 makes the egress budget a
   * design constraint rather than an ops detail: at 6.4 MB a month's 20 GB buys
   * about three thousand page loads. Gzipped it is 718 kB, which buys thirty
   * thousand, and the ETag means a returning player pays neither.
   *
   * Compressed **here** and not at Caddy deliberately. Caddy would recompress
   * the same six megabytes on every request on a one-vCPU box; this pays for it
   * once, when the ledger changes, which in practice is once a day. Level 9
   * because the cost is amortised over every fetch until the next content
   * commit -- there is no reason to be quick about it.
   *
   * Returns null if compression fails, and `contentResponse` then serves the
   * plain JSON. A content endpoint that 500s because a compressor was unhappy
   * would take every quest in the game down with it.
   */
  gzipped(): Uint8Array<ArrayBuffer> | null {
    const json = this.serialise();
    const wire = this.wire;
    if (wire === null) return null;
    if (wire.gzip !== null) return wire.gzip;
    try {
      // Copied into a fresh buffer rather than handed over as the view Bun
      // returns: `Response` wants a body backed by a plain `ArrayBuffer`, and
      // one 718 kB copy per content revision -- which is about one a day -- is
      // not a cost worth a cast to get around.
      wire.gzip = new Uint8Array(Bun.gzipSync(new TextEncoder().encode(json), { level: 9 }));
    } catch (err) {
      console.error(`[sydney] quests: could not gzip the bundle: ${String(err).slice(0, 120)}`);
      return null;
    }
    return wire.gzip;
  }
}

/** A single content file's ceiling. A pack is kilobytes; this is generous. */
export const MAX_PACK_BYTES = 512 * 1024;

// --- The AI seam ------------------------------------------------------------------

/**
 * The model, named by env so a provider's rename costs a log line.
 *
 * It cost exactly that on 2026-08-23: the provider stopped listing
 * `glm-4.7-flash` and the boot probe said so -- *"which the provider does not
 * list. Improv nodes will serve their authored lines"* -- which is the seam
 * working as designed, and is also the whole reason the probe exists. Every
 * dialog node had been serving its authored line for as long as that was true,
 * and nothing else in the game could have told you. The successor here is the
 * cheapest model the provider lists that can hold a persona for two sentences
 * -- $0.04 in and $0.07 out per million tokens, against the flash model's
 * several times that -- because an improv line is forty tokens of small talk
 * and the budget is capped. The env var on the box is the real setting and this
 * is only what a machine with no `/etc/sydney/secrets.env` falls back to.
 */
export const DEFAULT_DIALOG_MODEL = 'qwen3-5-4b';

interface CacheEntry {
  /** The clamped line, or `''` while a fill is in flight or has failed. */
  line: string;
  week: string;
}

/**
 * One call per node per week, and a queue in front of it.
 *
 * The whole of the AI integration. Everything about how it degrades is in this
 * class and nowhere else, which is the property that makes "no key configured"
 * a supported state rather than a path nobody exercises: with no key, `lineFor`
 * returns `''` on the first branch and every caller already handles `''` by
 * serving the authored line -- the same branch a cache miss takes, which every
 * single conversation takes the first time.
 */
export class ImprovCache {
  private readonly url: string;
  private readonly key: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  private readonly cache = new Map<string, CacheEntry>();
  /** The week the cache currently holds. See `lineFor`. */
  private cacheWeek = '';
  /** Nodes waiting for a turn. Single-flight; see `pump`. */
  private readonly queue: Array<{ key: string; node: DialogNode; week: string }> = [];
  private inFlight = false;
  /** Consecutive 429s and 5xxs. Resets on a success. */
  private failures = 0;
  private nextAllowedMs = 0;

  /** For `/health` and the log. Counts, never content and never the key. */
  calls = 0;
  errors = 0;
  lastError = '';

  constructor(options: { url?: string; key?: string; model?: string; fetch?: typeof fetch; now?: () => number } = {}) {
    this.url = (options.url ?? process.env.SYDNEY_DIALOG_AI_URL ?? '').replace(/\/+$/, '');
    this.key = options.key ?? process.env.SYDNEY_DIALOG_AI_KEY ?? '';
    this.model = options.model ?? process.env.SYDNEY_DIALOG_AI_MODEL ?? DEFAULT_DIALOG_MODEL;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether a model is configured. Says nothing about the key. */
  get enabled(): boolean {
    return this.url !== '' && this.key !== '';
  }

  describe(): string {
    if (!this.enabled) return 'improv off (no SYDNEY_DIALOG_AI_URL/_KEY) — authored lines';
    return `improv via ${this.model} (${this.cache.size} cached, ${this.calls} call(s), ${this.errors} error(s))`;
  }

  /**
   * Ask the provider which models it has, once, at boot.
   *
   * A **warning and nothing else**, which is the point: provider catalogues get
   * renamed, and the failure that causes is a mute NPC in three weeks' time
   * with a 404 buried in a log nobody greps. Naming the configured id at boot
   * turns that into one line an operator reads on the deploy. It never refuses
   * to start and it never disables anything -- a listing that does not include
   * the model may simply be a listing endpoint the provider does not implement
   * the way this expects.
   */
  async probe(): Promise<string> {
    if (!this.enabled) return '';
    try {
      const res = await this.fetchImpl(`${this.url}/models`, { headers: this.authHeaders() });
      if (!res.ok) return `[sydney] quests: ${this.url}/models answered ${res.status}; improv will try anyway.`;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? '')) : [];
      if (ids.length === 0) return '';
      if (!ids.includes(this.model)) {
        return (
          `[sydney] quests: SYDNEY_DIALOG_AI_MODEL is "${this.model}", which the provider does not list. ` +
            `Improv nodes will serve their authored lines. Listed: ${ids.slice(0, 12).join(', ')}`
        );
      }
      return '';
    } catch (err) {
      return `[sydney] quests: could not reach ${this.url}/models (${String(err).slice(0, 120)}); improv will try anyway.`;
    }
  }

  private authHeaders(): Record<string, string> {
    return {
      // The one place the key is used. Never logged, never in a URL, never in
      // an error message -- `SuggestionStore`'s rule about its own token.
      authorization: `Bearer ${this.key}`,
      'content-type': 'application/json',
      accept: 'application/json',
    };
  }

  /**
   * This node's line right now, or `''` for "use the authored one".
   *
   * **Synchronous and never awaited**, which is rule 3 in the header: the
   * caller is on a socket message handler and a model that hangs must cost a
   * stale line rather than a stalled read. A miss queues a fill and returns
   * empty; the next player through the same node this week gets the answer.
   */
  lineFor(npcId: string, node: DialogNode, atMs = this.now()): string {
    if (node.improv === null || !this.enabled) return '';
    const week = weekKey(atMs);
    // **Last week's lines go when this week's first one is asked for.** The key
    // carries the week so a line is re-improvised weekly, which meant every
    // week added a full set and never dropped the one before -- bounded per
    // week by the content, unbounded across weeks by the uptime. One sweep on
    // the week rolling over is cheaper than an eviction policy and is exactly
    // as often as the cache is allowed to be wrong.
    if (week !== this.cacheWeek) {
      for (const [k, v] of this.cache) if (v.week !== week) this.cache.delete(k);
      this.cacheWeek = week;
    }
    const key = `${npcId}\x00${node.id}\x00${week}`;
    const hit = this.cache.get(key);
    if (hit) return hit.line;
    // A placeholder so a hundred players walking past one NPC queue one fill.
    this.cache.set(key, { line: '', week });
    if (this.queue.length < MAX_IMPROV_QUEUE) this.queue.push({ key, node, week });
    void this.pump();
    return '';
  }

  /**
   * Drain the queue, one request at a time, with backoff.
   *
   * Single-flight because the tier this runs on is free and a room walking past
   * a new NPC would otherwise be twenty simultaneous requests, all of which get
   * 429 and none of which produce a line. One at a time is slower and finishes;
   * twenty at once is faster and does not.
   */
  private async pump(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.nextAllowedMs - this.now();
        if (wait > 0) await Bun.sleep(Math.min(wait, MAX_BACKOFF_MS));
        const job = this.queue.shift();
        if (!job) break;
        // The week turned over while this sat in the queue. The key is stale
        // and the next reader will queue a fresh one; filling it would write a
        // line into a week nobody will ever ask for.
        if (job.week !== weekKey(this.now())) continue;
        const line = await this.ask(job.node);
        if (line === null) {
          this.failures++;
          // Exponential, capped, and the entry is left empty so the authored
          // line keeps serving. A rate limit is invisible to a player.
          this.nextAllowedMs = this.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.min(this.failures, 6));
          continue;
        }
        this.failures = 0;
        this.nextAllowedMs = 0;
        if (line !== '') this.cache.set(job.key, { line, week: job.week });
      }
    } finally {
      this.inFlight = false;
    }
  }

  /** One request. `null` is "try again later"; `''` is "nothing usable came back". */
  private async ask(node: DialogNode): Promise<string | null> {
    this.calls++;
    try {
      const res = await this.fetchImpl(`${this.url}/chat/completions`, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify({
          model: this.model,
          messages: buildPrompt(node),
          max_tokens: 90,
          temperature: 0.9,
        }),
        signal: AbortSignal.timeout(IMPROV_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        this.errors++;
        this.lastError = `POST /chat/completions -> ${res.status}`;
        return null;
      }
      if (!res.ok) {
        // A 4xx that is not a rate limit is a configuration problem -- a wrong
        // model id, a revoked key -- and retrying it forever would be a request
        // a second against a wall. Reported as "nothing usable", so the
        // authored line serves and no backoff is entered.
        this.errors++;
        this.lastError = `POST /chat/completions -> ${res.status}`;
        return '';
      }
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
      const raw = body?.choices?.[0]?.message?.content;
      const line = clampImprov(raw);
      this.lastError = '';
      return line;
    } catch (err) {
      this.errors++;
      // The message and not the request, so nothing about the key can be in it.
      this.lastError = `POST /chat/completions threw: ${String(err).slice(0, 120)}`;
      return null;
    }
  }
}

export const MAX_IMPROV_QUEUE = 64;
export const BASE_BACKOFF_MS = 2000;
export const MAX_BACKOFF_MS = 120_000;
export const IMPROV_TIMEOUT_MS = 12_000;

/**
 * The whole prompt, and **the signature is the safety property**.
 *
 * It takes a `DialogNode` and nothing else. There is no parameter for a player
 * name, a handle, a chat line, a position or a quest cursor, and that is not an
 * omission to be filled in later -- it is rule 2 in this file's header, made
 * structural. Everything sent to a third-party endpoint is a string an author
 * wrote into a JSON file in this repository.
 *
 * The authored line goes in as the example rather than being withheld, because
 * the job is *"say this, differently"* rather than *"invent something"* -- the
 * authored line is the one that has been read and approved, and it is also the
 * one that serves when this whole path is off, so a rewrite that drifts far
 * from it would make the feature's presence or absence visible.
 */
export function buildPrompt(node: DialogNode): Array<{ role: string; content: string }> {
  const improv = node.improv;
  return [
    {
      role: 'system',
      content:
        'You write one line of dialogue for a character in a comedy video game set in Sydney, Australia. ' +
        'Reply with the line only: no quotation marks, no name prefix, no stage directions, no markdown. ' +
        'One or two short sentences, at most 200 characters. Dry, deadpan, lower case. ' +
        'Do not invent quests, prices, instructions or names.',
    },
    {
      role: 'user',
      content:
        `Character: ${improv?.persona ?? ''}\n` +
        (improv?.context ? `Situation: ${improv.context}\n` : '') +
        `They would normally say: "${node.line}"\n` +
        'Say the same thing in their own words.',
    },
  ];
}

// --- What the engine needs from the simulation --------------------------------------

/**
 * The seam, and it is deliberately narrower than `Simulation`.
 *
 * Structural rather than an import, on `SuggestSocket`'s argument exactly:
 * nothing about quests should be wired into the type every other part of the
 * server shares, and this file must stay constructible in a check with no world
 * in it. What it wants is a position, an identity, a wallet and a way to talk.
 */
export interface QuestWorld {
  /** Every live player, across every room on this host. */
  eachPlayer(fn: (playerId: number) => void): void;
  positionOf(playerId: number): { x: number; z: number } | null;
  /** The account behind this player, or null for a guest or a bot. */
  accountOf(playerId: number): AccountRecord | null;
  /** Whether this is a bot. Bots do not quest. */
  isBot(playerId: number): boolean;
  levelOf(playerId: number): number;
  teamOf(playerId: number): Team;
  cashOf(playerId: number): number;
  /** Pay. `why` becomes the sentence in the next `WALLET` frame. */
  credit(playerId: number, amount: number, why: string): void;
  /** Take. Returns what actually moved, **negative**, per `sim.wallet.debit`. */
  debit(playerId: number, amount: number, why: string): number;
  /** One sentence in the pill. */
  note(playerId: number, text: string): void;
  /**
   * This player's level moved because a quest paid xp. Workstream AN.
   *
   * Optional, so a check can leave it out, and it exists because the register
   * made a standing gap load-bearing. `AccountStore.creditXp` moves the level on
   * the **record**; `levelOf` reads it off the **participant**, which until now
   * was only ever updated by `Simulation.creditLadder` on a knockout. So a
   * player who levelled purely on quest rewards kept being gated as if they had
   * not -- invisible while `quest.level` was a minimum and merely generous, and
   * a wall the moment it became a rung: their whole next rung of content would
   * have stayed hidden until they happened to knock somebody over.
   */
  levelled?(playerId: number, level: number): void;
  /** Which station this player's train is standing at, or null. */
  rideStation(playerId: number): { line: number; station: string } | null;
  /**
   * Put a lime bike on clear ground beside this player, or answer null.
   * Workstream AP.
   *
   * Optional, and absent is a working configuration rather than a broken one --
   * `levelled`'s contract, for its reason: a check that only wants to walk a
   * conversation should not have to build a `Simulation` to do it, and a quest
   * with `"bike": true` on a host that cannot lend one simply does not lend one.
   * The player is told either way; see `accept`.
   *
   * `seed` makes the placement reproducible over `(x, z, seed)`. The engine
   * passes its own sweep counter rather than `Date.now()`, so a replayed accept
   * in a check puts the bike in the same centimetre twice.
   */
  loanBike?(playerId: number, seed: number): { x: number; y: number; z: number } | null;
  /** Put a frame on this player's socket. A no-op for anyone who has left. */
  send(playerId: number, frame: ArrayBuffer): void;
}

/**
 * What the simulation tells the engine about. Workstream AK.
 *
 * Three verbs, one method, and **no event bus**. The brief's rule was to
 * subscribe to what already fires rather than to invent a parallel path, and
 * these are three lines added at three funnels `server/sim.ts` already has: the
 * knockout funnel every weapon in the game passes through, the powerup pickup
 * that is already an `EVENT.PICKUP`, and `moveWallet`, which is the only place
 * in the process a balance goes up.
 */
export interface QuestSink {
  /**
   * `kind` is `'ko'`, `'pickup'` or `'earn'`.
   *
   * One method with a discriminator rather than three, because the call sites
   * are inside hot-ish paths and this way each of them is a single optional
   * call with no object allocated: `this.quests?.signal(p.id, 'ko', 'eshay', 1)`.
   */
  signal(playerId: number, kind: 'ko' | 'pickup' | 'earn', what: string, amount: number): void;
}

// --- The engine ----------------------------------------------------------------------

/** A guest's progress: alive for as long as the socket is. See the header. */
interface GuestState {
  cursors: QuestCursors;
  story: Set<string>;
}

/** How often the position sweep runs. See `tick`. */
export const SWEEP_HZ = 4;

export class QuestEngine implements QuestSink {
  private readonly content: ContentStore;
  private readonly improv: ImprovCache;
  private readonly world: QuestWorld;
  private readonly accounts: AccountStore | null;

  /** Guests, by player id. Dropped on `forget`. */
  private readonly guests = new Map<number, GuestState>();
  /** How many sweeps have run. The loan bike's placement seed; see `tick`. */
  private sweeps = 0;
  /** Per-socket budget, so a hammered panel cannot spend the box. */
  private readonly guards = new Map<number, FloodGuard>();
  /** Whose state frame is owed on the next flush. */
  private readonly pending = new Set<number>();
  /** A sentence to ride along with the next frame, per player. */
  private readonly notes = new Map<number, string>();
  /** The improv line owed to one player, per player. */
  private readonly lines = new Map<number, { npc: string; node: string; line: string }>();
  /** The last station each player was seen standing at, so an arrival fires once. */
  private readonly lastStation = new Map<number, string>();
  /** Cursors reconciled against the live revision, per player. */
  private readonly reconciledAt = new Map<number, string>();

  private sinceSweep = 0;

  constructor(content: ContentStore, improv: ImprovCache, world: QuestWorld, accounts: AccountStore | null = null) {
    this.content = content;
    this.improv = improv;
    this.world = world;
    this.accounts = accounts;
  }

  // --- Lookups ---------------------------------------------------------------------

  private questById(id: string): Quest | null {
    return this.content.bundle.quests.find((q) => q.id === id) ?? null;
  }

  private npcById(id: string): DialogNpc | null {
    return this.content.bundle.npcs.find((n) => n.id === id) ?? null;
  }

  /**
   * This player's cursors, whether they are an account or a guest.
   *
   * **The account's own object, aliased rather than copied**, which is the one
   * place this engine touches a record directly. The alternative -- read a
   * copy, mutate it, write it back -- would mean a knockout on a tick where two
   * quests both advance writes the record twice and the second write loses the
   * first's counter. `AccountStore.writeQuests` copies on the way *out*, which
   * is where a copy actually protects something (the serialiser).
   */
  private cursorsOf(playerId: number): QuestCursors {
    const account = this.world.accountOf(playerId);
    if (account !== null) return account.quests;
    let guest = this.guests.get(playerId);
    if (!guest) {
      guest = { cursors: {}, story: new Set() };
      this.guests.set(playerId, guest);
    }
    return guest.cursors;
  }

  private storyOf(playerId: number): Set<string> {
    const account = this.world.accountOf(playerId);
    if (account !== null) return new Set(account.story);
    let guest = this.guests.get(playerId);
    if (!guest) {
      guest = { cursors: {}, story: new Set() };
      this.guests.set(playerId, guest);
    }
    return guest.story;
  }

  private setFlag(playerId: number, flag: string): void {
    const account = this.world.accountOf(playerId);
    if (account !== null && this.accounts !== null) {
      this.accounts.setStoryFlag(account, flag);
      return;
    }
    // A guest's flags exist for exactly as long as they are standing there. The
    // cap is applied anyway, because a `Set` on a long-lived socket is still a
    // thing that grows.
    const guest = this.guests.get(playerId);
    if (guest && guest.story.size < MAX_STORY_FLAGS) guest.story.add(flag);
  }

  private facts(playerId: number): PlayerFacts {
    return {
      level: this.world.levelOf(playerId),
      faction: TEAM_NAME[this.world.teamOf(playerId)],
      story: this.storyOf(playerId),
      cash: this.world.cashOf(playerId),
    };
  }

  /** Persist a player's cursors, if there is anywhere to persist them to. */
  private save(playerId: number): void {
    const account = this.world.accountOf(playerId);
    if (account !== null && this.accounts !== null) this.accounts.writeQuests(account, account.quests);
    this.pending.add(playerId);
  }

  /**
   * Bring a player's cursors into line with the live pack, once per revision.
   *
   * The content can change under a live player -- that is the entire point of
   * the feature -- so this is called before anything reads a cursor. A quest
   * that has been **deleted** takes its cursor with it, which is the only
   * honest answer: leaving it would be a tracker line for a job nobody can
   * finish. Everything else is `questmodel.reconcileCursor`'s.
   *
   * Keyed on the revision so it is one string compare per read after the first,
   * rather than a walk of every cursor on every knockout.
   */
  private reconcile(playerId: number): void {
    const revision = this.content.revision;
    if (this.reconciledAt.get(playerId) === revision) return;
    this.reconciledAt.set(playerId, revision);
    const cursors = this.cursorsOf(playerId);
    let moved = false;
    for (const id of Object.keys(cursors)) {
      const quest = this.questById(id);
      if (!quest) {
        delete cursors[id];
        moved = true;
        continue;
      }
      if (reconcileCursor(cursors[id], quest)) moved = true;
    }
    if (moved) this.save(playerId);
  }

  // --- The ops ----------------------------------------------------------------------

  /** One `MSG.QUEST` frame, already decoded. Returns nothing; answers by frame. */
  handle(playerId: number, op: number, id: string, node: string, choice: number, nowMs = Date.now()): void {
    if (this.world.isBot(playerId)) return;
    let guard = this.guards.get(playerId);
    if (!guard) {
      guard = new FloodGuard(nowMs, QUEST_BURST, QUEST_REFILL_PER_SEC);
      this.guards.set(playerId, guard);
    }
    // Checked before anything is looked up or written, on `SuggestionHub`'s
    // argument: the point of a budget is to make the expensive path unreachable
    // rather than to reject at the end of it. A refused op answers with
    // nothing at all -- there is no state change to report and a pill saying
    // "slow down" for a click the player did not consciously make would be
    // noise. See `QUEST_BURST` for the size.
    if (!guard.allow(nowMs)) return;
    this.reconcile(playerId);

    switch (op) {
      case QUEST_OP.LIST:
        this.pending.add(playerId);
        return;
      case QUEST_OP.ACCEPT:
        this.accept(playerId, id);
        return;
      case QUEST_OP.TURNIN:
        this.turnin(playerId, id);
        return;
      case QUEST_OP.ABANDON:
        this.abandon(playerId, id);
        return;
      case QUEST_OP.NODE:
        this.node(playerId, id, node, choice, nowMs);
        return;
      case QUEST_OP.PHOTO:
        this.photo(playerId, id);
        return;
      default:
        return;
    }
  }

  /**
   * Take a quest.
   *
   * Every gate is `questmodel.questRefusal`'s -- the same function the panel
   * greys the choice out with -- and the refusal the player reads is **this
   * side's sentence**, on `Simulation.teamOp`'s argument: when the two ends
   * disagree (a stale tab, an old pack), what should be on screen is the
   * authority's reason rather than a second copy of the rule that happens to be
   * nearby.
   *
   * The one gate that is *not* in the shared function is the giver's: a client
   * may not accept a quest by naming it, only by being offered it, so there has
   * to be a choice on the giver's tree that accepts this id. That is checked
   * here because it is a fact about the *bundle*, and `questRefusal` takes a
   * quest rather than a bundle.
   */
  private accept(playerId: number, questId: string): void {
    const quest = this.questById(questId);
    if (!quest) return;
    const cursors = this.cursorsOf(playerId);
    if (Object.keys(cursors).length >= MAX_OPEN) {
      this.say(playerId, 'you have enough on');
      return;
    }
    const refusal = questRefusal(quest, this.facts(playerId), cursors);
    if (refusal !== '') {
      this.say(playerId, refusal);
      return;
    }
    if (!this.offeredBy(quest)) return;
    cursors[quest.id] = blankCursor(quest);
    // Evaluated immediately, so a `goto` whose target is where the player
    // already stands clears on accept rather than waiting for an event that may
    // never come -- see `addProgress`, which advances over as many steps as are
    // already satisfied.
    this.sweepOne(playerId);
    this.save(playerId);
    this.say(playerId, quest.title.toLowerCase().slice(0, 40));
    /*
     * --- WORKSTREAM AP: the loan bike, **after** the cursor and the save.
     *
     * The ordering is the same argument `turnin` makes about paying last: a
     * crash between the cursor and the bike is a player on the job with no
     * bicycle, which they can fix by walking; a crash between the bike and the
     * cursor would be a bicycle handed out for a job nobody is on, forever,
     * because `MSG.BIKES` has no delete. The survivable failure is the one this
     * order picks.
     *
     * A host that cannot lend -- no `loanBike`, or nowhere within five metres of
     * a player standing in a stairwell -- says so in the pill rather than failing
     * the accept. The quest is still taken; the Ladmaster's line still says to
     * grab the bike; and "no room for the bike here" is a sentence a player can
     * act on by stepping into the street, which is the whole of what the
     * degraded case needs to be.
     */
    if (quest.grantsBike && this.world.loanBike) {
      const spot = this.world.loanBike(playerId, this.sweeps);
      this.say(playerId, spot === null ? 'no room for the bike here' : 'a lime bike, for you');
    }
  }

  /** Is there a dialog choice anywhere on the giver's tree that accepts this? */
  private offeredBy(quest: Quest): boolean {
    const npc = this.npcById(quest.giver);
    if (!npc) return false;
    return npc.nodes.some((nd) => nd.choices.some((c) => c.accept === quest.id));
  }

  /**
   * Hand a quest in, and pay for it.
   *
   * The order is deliberate and is the one thing here that would be a real bug
   * the other way round: the cursor is **removed first**, then the flags are
   * written, then the money and the xp. A crash between the pay and the removal
   * would be a quest that can be handed in twice; a crash between the removal
   * and the pay is a quest handed in for nothing, which is a complaint rather
   * than an exploit. Neither is likely -- none of these awaits -- but the
   * ordering costs nothing and picks the survivable failure.
   */
  private turnin(playerId: number, questId: string): void {
    const quest = this.questById(questId);
    if (!quest) return;
    const cursors = this.cursorsOf(playerId);
    const cursor = cursors[questId];
    if (!cursor) return;
    if (!cursor.d) {
      const step = openStep(cursor, quest);
      this.say(playerId, step === null ? 'not yet' : step.label.slice(0, 40));
      return;
    }
    delete cursors[questId];
    /*
     * The implicit completion mark, and **which** mark is `repeatable`'s to
     * decide. WORKSTREAM AN.
     *
     * This used to write `q:<id>` for a story quest and *nothing at all* for a
     * repeatable, and the nothing was a bug wearing a design's clothes: a job
     * `content/quests/act1.json` calls weekly could be handed in and taken
     * again in the same breath, and the phone had no way to draw it as done
     * because there was nothing to read. Now every turn-in writes a mark and
     * the prefix carries the lifetime -- `q:` forever, `w:` until Monday sweeps
     * it in `net/accounts.resetIfNewWeek`. See `questmodel.doneFlag`, which is
     * the one place the choice is made.
     */
    this.setFlag(playerId, doneFlag(quest));
    for (const flag of quest.reward.unlock) this.setFlag(playerId, flag);
    if (quest.reward.cash > 0) this.world.credit(playerId, quest.reward.cash, questWhy(quest));
    if (quest.reward.xp > 0) this.awardXp(playerId, quest.reward.xp);
    this.save(playerId);
  }

  /**
   * Experience, and the level-up sentence that goes with it.
   *
   * A guest gets **nothing**, silently, and that is the ladder's existing rule
   * rather than a new one: `Simulation.creditLadder` already refuses to advance
   * a guest's level because there is nowhere durable to keep it, and paying xp
   * into a number that vanishes at the next reload would be worse than not
   * paying it -- it would be a level-up they watch disappear.
   */
  private awardXp(playerId: number, xp: number): void {
    const account = this.world.accountOf(playerId);
    if (account === null || this.accounts === null) return;
    const out = this.accounts.creditXp(account, xp);
    this.pending.add(playerId);
    if (out.levelled) {
      // The record moved; the body has to hear about it, or the next rung of
      // the register stays shut. See `QuestWorld.levelled`.
      this.world.levelled?.(playerId, out.level);
      this.world.note(playerId, `level ${out.level}`);
    }
  }

  /** Give one up. A story quest's mark is not written, so it can be taken again. */
  private abandon(playerId: number, questId: string): void {
    const cursors = this.cursorsOf(playerId);
    if (cursors[questId] === undefined) return;
    delete cursors[questId];
    this.save(playerId);
  }

  /**
   * A dialog click, re-walked on this side.
   *
   * The **destination is the pack's** rather than a node id the client chose,
   * which is what makes the whole conversation safe: a client says "I clicked
   * choice 2 on node `hello`", and this looks up choice 2 on node `hello` in
   * its own copy and goes where *that* says. A client cannot walk to a node it
   * was not offered, cannot skip a gate, and cannot reach a bribe's destination
   * without the bribe being taken.
   *
   * `NODE_OPENED` means the conversation was just opened, which lands on the
   * NPC's root with no choice applied -- the one arrival that is not the result
   * of a click.
   */
  private node(playerId: number, npcId: string, nodeId: string, choice: number, nowMs: number): void {
    const npc = this.npcById(npcId);
    if (!npc) return;
    // The range test. Not a courtesy: the whole reason a dialog step is safe to
    // trust is that the server checked the player was standing there.
    const at = this.world.positionOf(playerId);
    if (at === null) return;
    const dx = at.x - npc.x;
    const dz = at.z - npc.z;
    const reach = npc.radius + DIALOG_SLACK_M;
    if (dx * dx + dz * dz > reach * reach) return;

    let arrived: DialogNode | null = null;
    if (choice === NODE_OPENED) {
      arrived = npc.nodes.find((nd) => nd.id === npc.root) ?? null;
    } else {
      const from = npc.nodes.find((nd) => nd.id === nodeId);
      const picked = from?.choices[choice];
      if (!from || !picked) return;
      const refusal = choiceRefusal(picked, this.facts(playerId));
      if (refusal !== '') {
        this.say(playerId, refusal);
        return;
      }
      if (picked.cost > 0) {
        // **Through the wallet door**, which is the only way money moves in
        // this process. A short debit is a refusal rather than a part-payment:
        // `sim.wallet.debit` returns what actually moved, and anything less
        // than the price means the player did not have it -- in which case
        // nothing happens and they keep what they had.
        const moved = -this.world.debit(playerId, picked.cost, 'bribe');
        if (moved < picked.cost) {
          this.say(playerId, 'not enough on you');
          return;
        }
      }
      if (picked.goto === '') return; // a goodbye
      arrived = npc.nodes.find((nd) => nd.id === picked.goto) ?? null;
    }
    if (arrived === null) return;

    // A `dialog` step is satisfied by *arriving* at its node, and the arrival
    // is this side's conclusion rather than the client's claim.
    this.progress(playerId, (step) => step.kind === STEP_KIND.DIALOG && step.npcId === npcId && step.node === arrived.id, 1);

    // And the improv line, if this node has one and there is a model. Empty is
    // the ordinary answer -- no key, a cache miss, a throttled fill -- and the
    // panel serves the authored line for all three.
    const line = this.improv.lineFor(npcId, arrived, nowMs);
    if (line !== '') this.lines.set(playerId, { npc: npcId, node: arrived.id, line });
    this.pending.add(playerId);
  }

  /**
   * "I photographed this." The **one** step whose occurrence is trusted.
   *
   * There is no way for this process to know a shutter was pressed: the camera
   * is a canvas grab in the browser and the photograph never leaves it (see
   * `game/phone.ts`'s album). So the assertion is taken and the *place* is
   * checked, which is the half that matters -- a step that says "photograph the
   * Harbour Bridge" is really asking the player to go and stand there, and that
   * is exactly what this verifies.
   */
  private photo(playerId: number, landmark: string): void {
    const at = this.world.positionOf(playerId);
    if (at === null) return;
    this.progress(
      playerId,
      (step) =>
        step.kind === STEP_KIND.PHOTO &&
        (step.landmark === '' || step.landmark === landmark) &&
        withinStep(step, at.x, at.z),
      1,
    );
  }

  // --- What the simulation tells us ------------------------------------------------

  /** `QuestSink`. Three verbs at three funnels; see the interface. */
  signal(playerId: number, kind: 'ko' | 'pickup' | 'earn', what: string, amount: number): void {
    if (amount <= 0 || this.world.isBot(playerId)) return;
    // No cursors, nothing to do, and this is on the knockout path -- so the
    // cheap test comes before `reconcile`, which walks them.
    const account = this.world.accountOf(playerId);
    const cursors = account !== null ? account.quests : this.guests.get(playerId)?.cursors;
    if (!cursors || Object.keys(cursors).length === 0) return;
    this.reconcile(playerId);
    if (kind === 'ko') {
      this.progress(playerId, (step) => step.kind === STEP_KIND.KO && (step.npc === 'any' || step.npc === what), amount);
    } else if (kind === 'pickup') {
      this.progress(playerId, (step) => step.kind === STEP_KIND.BUY && (step.powerup === 'any' || step.powerup === what), amount);
    } else {
      this.progress(playerId, (step) => step.kind === STEP_KIND.EARN, amount);
    }
  }

  /**
   * Add progress to every open step this player has that matches.
   *
   * **Every** one, rather than the first: two quests can both be asking for
   * eshays, and a knockout that only counted for the older of them would be a
   * player watching one tracker move and the other not, with no way to tell
   * which quest a punch is "for". A knockout is a knockout.
   */
  private progress(playerId: number, matches: (step: ReturnType<typeof openStep> & object) => boolean, amount: number): void {
    const cursors = this.cursorsOf(playerId);
    let moved = false;
    for (const id of Object.keys(cursors)) {
      const quest = this.questById(id);
      if (!quest) continue;
      const step = openStep(cursors[id], quest);
      if (step === null || !matches(step)) continue;
      if (addProgress(cursors[id], quest, amount)) moved = true;
      if (cursors[id].d) this.say(playerId, `${quest.title.toLowerCase().slice(0, 30)}: done`);
    }
    if (moved) this.save(playerId);
  }

  /**
   * The position sweep: `goto` steps and train arrivals.
   *
   * At `SWEEP_HZ` rather than on the tick, and the number is the whole of the
   * cost argument. A `goto` radius is metres and a player moves at most 8 m/s,
   * so a quarter-second sample cannot miss a circle it passed through -- and at
   * 60 Hz this would be a distance test per open quest per player per tick on a
   * box with one vCPU, to notice something that happens once a minute.
   *
   * A **train arrival** is edge-triggered off the station name, because
   * `rideStation` answers the same station for every tick the train is stopped
   * and a level-triggered read would count one arrival forty times.
   */
  tick(dt: number): void {
    this.sinceSweep += dt;
    if (this.sinceSweep < 1 / SWEEP_HZ) return;
    this.sinceSweep = 0;
    // WORKSTREAM AP: the seed a loan bike's placement is deterministic over.
    // A counter rather than `Date.now()` for the reason `game/footy.ts` gives
    // about ambient things: a wall clock is a number no check can reproduce, and
    // "the same accept always parks the bike in the same place" is only a true
    // sentence if the input is something a check can set.
    this.sweeps++;
    this.world.eachPlayer((playerId) => {
      const account = this.world.accountOf(playerId);
      const cursors = account !== null ? account.quests : this.guests.get(playerId)?.cursors;
      if (!cursors || Object.keys(cursors).length === 0) {
        this.lastStation.delete(playerId);
        return;
      }
      this.reconcile(playerId);
      this.sweepOne(playerId);
    });
  }

  /** One player's position-shaped steps. Also called on accept; see `accept`. */
  private sweepOne(playerId: number): void {
    const at = this.world.positionOf(playerId);
    if (at !== null) {
      this.progress(playerId, (step) => step.kind === STEP_KIND.GOTO && withinStep(step, at.x, at.z), 1);
    }
    const stop = this.world.rideStation(playerId);
    const key = stop === null ? '' : `${stop.line}\x00${stop.station}`;
    if (key !== (this.lastStation.get(playerId) ?? '')) {
      this.lastStation.set(playerId, key);
      if (stop !== null) {
        this.progress(
          playerId,
          (step) =>
            step.kind === STEP_KIND.RIDE &&
            (step.line < 0 || step.line === stop.line) &&
            (step.to === '' || step.to === stop.station),
          1,
        );
      }
    }
  }

  // --- Talking back ------------------------------------------------------------------

  /** Queue a sentence for the next state frame. One per player, newest wins. */
  private say(playerId: number, text: string): void {
    this.notes.set(playerId, text.slice(0, 60));
    this.pending.add(playerId);
  }

  /**
   * Send every state frame that is owed. Called once per tick from the pump.
   *
   * Batched rather than sent at the moment of the change, because a single
   * knockout can advance three quests, complete one, pay money and set a flag
   * -- five reasons to send, one frame's worth of news. This is `Room`'s
   * version-and-flush arrangement in miniature.
   */
  flush(): void {
    if (this.pending.size === 0) return;
    for (const playerId of this.pending) {
      try {
        this.world.send(playerId, encodeQuestState(MSG.QUEST_STATE, this.frameFor(playerId)));
      } catch {
        // A socket that closed between the decision and the reply. The decision
        // is already on the record, which is the part that mattered.
      }
    }
    this.pending.clear();
    this.notes.clear();
    this.lines.clear();
  }

  /** What one player is told. Exported shape; see `net/quests.QuestStateFrame`. */
  frameFor(playerId: number): QuestStateFrame {
    this.reconcile(playerId);
    const account = this.world.accountOf(playerId);
    const cursors = this.cursorsOf(playerId);
    const rows: WireCursor[] = [];
    for (const [id, c] of Object.entries(cursors)) rows.push({ id, step: c.s, done: c.d, counts: [...c.c] });
    const line = this.lines.get(playerId);
    return {
      xp: account?.xp ?? 0,
      level: this.world.levelOf(playerId),
      flags: [...this.storyOf(playerId)],
      cursors: rows,
      note: this.notes.get(playerId) ?? '',
      lineNpc: line?.npc ?? '',
      lineNode: line?.node ?? '',
      line: line?.line ?? '',
    };
  }

  /** A socket went away. Called from `index.ts`'s `close`. */
  forget(playerId: number): void {
    this.guests.delete(playerId);
    this.guards.delete(playerId);
    this.pending.delete(playerId);
    this.notes.delete(playerId);
    this.lines.delete(playerId);
    this.lastStation.delete(playerId);
    this.reconciledAt.delete(playerId);
  }

  /**
   * For the checks: one cursor **as the engine holds it**, reconciled.
   *
   * The reconcile is the whole of why this is not a one-line getter. Every
   * other reader in this class -- `handle`, `signal`, `tick`, `frameFor`,
   * `offers` -- brings a player's cursors into line with the live pack before
   * it looks at them, so "as the engine holds it" is *reconciled* and an
   * accessor that skipped it would answer with a shape the engine never
   * actually acts on. `server/quests-check.ts` caught that directly: it read a
   * cursor written against a three-step quest, through a store holding the
   * four-step version, and got three counters back.
   */
  cursorFor(playerId: number, questId: string): QuestCursor | null {
    this.reconcile(playerId);
    return this.cursorsOf(playerId)[questId] ?? null;
  }

  /**
   * For the checks and the register: what this player could take **right now**.
   *
   * WORKSTREAM AN. "Now" got narrower when the level became a rung rather than
   * a floor: this used to be everything at or below the player's level and is
   * now everything *on* it, which is the phone's whole register in one line and
   * is what `server/quests-check.ts` asserts the exact-level rule against.
   */
  offers(playerId: number): Quest[] {
    this.reconcile(playerId);
    const facts = this.facts(playerId);
    const cursors = this.cursorsOf(playerId);
    return this.content.bundle.quests.filter((q) => questRefusal(q, facts, cursors) === '');
  }
}

/** How many quests one player may have open at once. */
export const MAX_OPEN = 8;

/**
 * How much further than an NPC's own radius the server will reach.
 *
 * The same half-metre-of-slack idea `MSG.SUN_PRESS` states: the client draws
 * the prompt at the pack's radius, the player clicks, and by the time the frame
 * arrives they have walked a tick. Two metres absorbs that without making the
 * range test decorative.
 */
export const DIALOG_SLACK_M = 2;

/**
 * The per-player budget for this feature's traffic.
 *
 * **Twenty-four, and the first cut of this was twelve, which was too tight** --
 * which is word for word what `SUGGEST_BURST`'s own comment says happened to
 * it, and it happened here for the same reason and was caught the same way.
 * `server/quests-check.ts` walks one job end to end -- accept, a refused
 * duplicate, a goto, two knockouts, a dialog click out of range, one in range,
 * a turn-in, a refused second turn-in -- and that is twelve ops before the
 * check has even reached the weekly. A player reading through a dialog tree
 * spends one op per click, and Denise's tree is six choices deep in places.
 *
 * The number has to sit above what a determined **person** can do and below
 * what a loop does in a millisecond, and those two are three orders of
 * magnitude apart -- so being generous costs nothing and being stingy breaks
 * the feature for whoever uses it most. That is the suggestions box's
 * conclusion and there was no reason to relearn it; the only excuse is that
 * this conversation looked smaller than that one and is not.
 *
 * Refilled continuously at four a second rather than reset on a window, so a
 * player who reads a node for a moment is not punished for the click after it.
 */
export const QUEST_BURST = 24;
export const QUEST_REFILL_PER_SEC = 4;

/** The sentence a reward's `WALLET` frame carries. Composed here, never a literal. */
function questWhy(quest: Quest): string {
  return quest.act === 0 ? 'centrelink' : 'job';
}

// --- What `/content` answers with -------------------------------------------------

/**
 * `GET /content` -- the whole pack, ETag'd.
 *
 * Its own route beside `/rooms` and `/health`, and it is a **strong ETag over
 * the revision** rather than a cache-control lifetime. The reason is the
 * feature's own promise: a content edit is live within five minutes, so a
 * `max-age` long enough to be worth having would be longer than the promise.
 * An ETag makes the ordinary case -- a client that already has this revision --
 * a 304 with no body, which is a few dozen bytes on a join.
 *
 * No credential, no per-player anything, and deliberately public: the packs are
 * in a public repository already, and a client cannot walk a dialog tree it
 * cannot read.
 */
export function contentResponse(store: ContentStore, req: Request): Response {
  const etag = `"${store.revision}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { etag, 'access-control-allow-origin': '*' } });
  }
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    etag,
    // Short, because the ETag is doing the work and this only decides how
    // often a client bothers to ask.
    'cache-control': 'public, max-age=60',
    'access-control-allow-origin': '*',
    // The response body differs by encoding, so a shared cache must not hand a
    // gzip to a client that did not ask for one. One header, and it is the
    // difference between working and working until somebody puts a proxy in
    // front of it.
    vary: 'accept-encoding',
  };
  const wantsGzip = (req.headers.get('accept-encoding') ?? '').toLowerCase().includes('gzip');
  const gzip = wantsGzip ? store.gzipped() : null;
  if (gzip !== null) {
    headers['content-encoding'] = 'gzip';
    return new Response(gzip, { status: 200, headers });
  }
  return new Response(store.serialise(), { status: 200, headers });
}
