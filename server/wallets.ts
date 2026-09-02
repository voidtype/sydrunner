/**
 * The one thing in this game that outlives a session: how much money you have.
 *
 * `server/index.ts`'s shutdown hook used to say the suggestions ledger was
 * *"the **only** thing in this process with state worth flushing"*, and this
 * file is the second. Spec 12 rules out accounts and storage, the scoreboard
 * dies with the process, and every id is a connection -- all of that stands.
 * What changed is that money is worthless if it evaporates on a restart: the
 * whole point of a balance is that it is the number you had last time, and a
 * wallet that reset on every deploy would make the fares and the Centrelink
 * runs a slot machine with no payout.
 *
 * ---------------------------------------------------------------------------
 * **THE KEY IS A NAME, AND A NAME IS NOT AUTHENTICATION.**
 *
 * There is no login in this game and this file does not add one. A wallet is
 * keyed by the player's in-game name, lower-cased and trimmed, and that is
 * **a claim, not proof** -- exactly the honesty `net/suggestions.ts` states
 * about its client ids, one step weaker:
 *
 *   - Anybody who joins as `bazza` **is** bazza, and gets bazza's money.
 *   - A name is offered at the prompt and can be anything; the server
 *     sanitises it and dedupes it *within a room* (`Simulation.pickName`), so
 *     two bazzas in one room become "Bazza" and "Bazza (2)" -- **two different
 *     wallets** -- but a bazza in room 1 and a bazza in room 2 are one wallet
 *     being written by two people.
 *   - Clearing site data and picking a new name mints a fresh $20.
 *
 * That is not a flaw to be fixed here; it is a consequence of a design decision
 * this project made deliberately (no accounts) and the right response is to
 * keep the stakes proportionate. There is nothing behind a wallet to steal but
 * play money, the amounts are two or three figures, and the defence that
 * actually works is that taking somebody's balance requires knowing and typing
 * their name -- at which point they can type it too. Anything stronger means an
 * account system, which is a different feature in a different pass.
 *
 * Stated here rather than assumed because the *next* thing anybody builds on
 * this will be tempted to make the balance buy something scarce, and the
 * moment it does, this paragraph becomes the reason not to.
 *
 * ---------------------------------------------------------------------------
 * WHY A JSON FILE AND NOT SQLITE
 *
 * `data/ledger.sqlite` exists in this repo and is the pipeline's. This is a few
 * hundred rows of `{balance, centrelink, lastSeenMs}` read once at boot and
 * written at most every five seconds, on a box with one vCPU. A database would
 * be a dependency, a schema, a migration and a connection for a file that fits
 * in a cache line per player -- and `server/suggestions.ts` already established
 * the pattern for exactly this shape of state, down to the atomic write.
 *
 * **Atomically**, for `SuggestionStore.save`'s reason verbatim: `Bun.write`
 * straight over the path is a truncate followed by a write, and a process
 * killed between the two leaves a zero-byte file where everybody's money was. A
 * temporary file beside it and a rename within one directory is atomic on every
 * filesystem this will run on, so the file on disk is either the old wallets or
 * the new ones and never a prefix of either.
 *
 * **Debounced to one write every five seconds**, which is twenty times slower
 * than the suggestions ledger's quarter second and deliberately so: a busy room
 * moves money on every knockout and every fare, which is several times a
 * second, and re-serialising every wallet on the host for each of them is the
 * one part of this feature that could show up in a tick budget. Five seconds of
 * exposure is at most a fare, and the shutdown hook closes the window on every
 * ordinary stop.
 *
 * ---------------------------------------------------------------------------
 * BOTS HAVE NO WALLET
 *
 * Enforced at the one door -- `Simulation` never calls `for()` for a
 * participant with a `bot` -- rather than by a name filter here, because a
 * filter would have to know that "Bazza" is a bot name and "Bazza" is also
 * something a player can type. A bot that earned money would put rows in this
 * file for every room on the host at every restart, and a bot that *dropped*
 * money on death would make farming the two bots in your room the best-paying
 * job in Sydney.
 */

import {
  MAX_BALANCE,
  STARTING_BALANCE,
  createWallet,
  type WalletRecord,
} from '../client/src/game/cash.ts';
// One import for one check and one assertion: the account key space is proved
// disjoint from the name one by the character cap, and the cap lives there.
import { MAX_NAME_CHARS } from '../client/src/net/protocol.ts';

/** What the file on disk looks like. Versioned so a later shape can be read. */
interface WalletFile {
  version: 1;
  /** Keyed by `walletKey(name)`. */
  wallets: Record<string, WalletRecord>;
}

/**
 * The key a wallet is filed under: lower-cased, trimmed, collapsed whitespace.
 *
 * The **same** normalisation on the way in and the way out, which is the only
 * property that matters: "Bazza", "bazza" and " Bazza " are one wallet, and
 * anything else would let a player accumulate three balances by typing their
 * own name with a capital some days. `sanitiseName` has already run on the
 * server by the time a name reaches here (see `Simulation.pickName`), so this
 * is folding case rather than defending against a hostile string.
 *
 * `toLowerCase` rather than `toLocaleLowerCase`: a Turkish locale lower-cases
 * `I` to a dotless `ı`, and a key that depended on the server's locale would
 * move somebody's money when the box's `LANG` changed.
 */
export function walletKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The key an **account's** wallet is filed under.
 *
 * The header above says at length that a name is a claim and not proof, and
 * ends by saying the fix is an account system in a different pass. That pass
 * landed (`server/accounts.ts`), and this is the one line of it that reaches
 * into this file: a player who is logged in gets a wallet keyed by their
 * account's UUID rather than by the name they are wearing, so it cannot be
 * spent by whoever types that name next. Guests are unchanged and keep
 * `walletKey`, which is what makes the account optional rather than a wall.
 *
 * **The two key spaces cannot collide**, and that is a property rather than a
 * hope: `walletKey` runs on a name that `sanitiseName` has already clipped to
 * `MAX_NAME_CHARS` (sixteen), and `account:` is eight characters followed by a
 * 36-character UUID. There is no name a player can type that reaches 44
 * characters, so no guest can ever land on an account's row.
 *
 * Lower-cased for `walletKey`'s reason, even though a UUID from
 * `crypto.randomUUID` is already lower-case: the two keys go into one map and a
 * second normalisation rule in the same map is a second rule to get wrong.
 */
export function accountWalletKey(accountId: string): string {
  return `account:${accountId}`.toLowerCase();
}

/** Where the file lives. `SYDNEY_STATE_DIR` moves the whole directory. */
export function defaultWalletPath(): string {
  const dir = process.env.SYDNEY_STATE_DIR ?? './data/state';
  return `${dir.replace(/\/+$/, '')}/wallets.json`;
}

/**
 * How long a name is kept after it was last seen, before the sweep drops it.
 *
 * Ninety days. The file is the only thing here that grows without bound -- a
 * public host sees a new name every few minutes forever -- and a wallet nobody
 * has touched in three months is a name nobody is coming back to. It is *not* a
 * privacy measure and should not be described as one: the file holds a name and
 * a number and nothing that identifies a person.
 *
 * Swept at load rather than on a timer, so the cost is paid once at boot on a
 * file that is already being parsed.
 */
export const WALLET_TTL_MS = 90 * 24 * 3600 * 1000;

/** One write every this many milliseconds, at most. See the header. */
export const SAVE_DEBOUNCE_MS = 5000;

export class WalletStore {
  readonly path: string;
  private file: WalletFile = { version: 1, wallets: {} };
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * Set when the file would not parse **and** could not be copied aside.
   *
   * While true, `save` refuses. The bytes on disk are then the only copy of
   * whatever the parser rejected, and a debounced write of an empty store over
   * them is the single most destructive thing this file can do. An operator
   * moves the file and restarts; nothing here unfreezes.
   */
  private frozen = false;
  /** How many rows were dropped by the boot sweep, for the log line. */
  private swept = 0;
  private loaded = false;

  constructor(path: string = defaultWalletPath()) {
    this.path = path;
  }

  /**
   * Read the file, or start empty.
   *
   * A file that will not parse is **moved aside rather than deleted or thrown
   * on**, which is `SuggestionStore.load`'s call and is made here for the same
   * reason: the balances are the only copy of something players accumulated
   * across sessions, and a server that refuses to boot on a truncated JSON is a
   * server that is down until somebody notices. Renaming leaves the evidence
   * and lets the game keep running.
   */
  async load(): Promise<void> {
    this.loaded = true;
    try {
      const f = Bun.file(this.path);
      if (!(await f.exists())) return;
      const raw = (await f.json()) as WalletFile;
      if (!raw || typeof raw !== 'object' || typeof raw.wallets !== 'object' || raw.wallets === null) {
        throw new Error('not a wallet file');
      }
      const now = Date.now();
      const wallets: Record<string, WalletRecord> = {};
      for (const [key, value] of Object.entries(raw.wallets)) {
        const record = sanitiseRecord(value);
        if (record === null) continue;
        // A stamp in the future is a machine whose clock was wrong; kept
        // rather than swept, because dropping somebody's money over a clock
        // skew is the worse of the two errors.
        if (record.lastSeenMs > 0 && now - record.lastSeenMs > WALLET_TTL_MS) {
          this.swept++;
          continue;
        }
        wallets[key] = record;
      }
      this.file = { version: 1, wallets };
      if (this.swept > 0) this.dirty = true;
    } catch (err) {
      const aside = `${this.path}.broken-${Date.now()}`;
      let asideOk = true;
      try {
        await Bun.write(aside, Bun.file(this.path));
      } catch (copyErr) {
        // **The one failure this file must not shrug off.** The original will
        // not parse and the copy of it just failed, so the only bytes anybody
        // has are the ones on disk right now -- and the next debounced save
        // would overwrite them with an empty store. Freezing writes is what
        // turns "everybody's wallets is gone" into "the server needs a human".
        asideOk = false;
        this.frozen = true;
        console.error(`[sydney] wallets: could NOT copy ${this.path} aside (${String(copyErr)}); writes are frozen until an operator moves it by hand.`);
      }      console.error(
        `[sydney] wallets: ${this.path} would not parse (${String(err)}); ` +
          (asideOk ? `moved to ${aside}` : 'and it was NOT moved aside -- see the line above'),
      );
      this.file = { version: 1, wallets: {} };
    }
  }

  /**
   * This name's wallet, created on first sight.
   *
   * Creating on read rather than on an explicit `open` is what makes a joiner's
   * first `WALLET` frame carry `STARTING_BALANCE` instead of zero, and it is
   * safe because the only caller is `Simulation.join` and it is called once per
   * human per join. A `for()` in a per-tick loop would grow the file with a row
   * for every misspelling anybody ever typed, so there is not one.
   */
  for(name: string, nowMs = Date.now()): WalletRecord {
    const key = walletKey(name);
    let record = this.file.wallets[key];
    if (record === undefined) {
      record = createWallet(STARTING_BALANCE);
      this.file.wallets[key] = record;
    }
    record.lastSeenMs = nowMs;
    this.touch();
    return record;
  }

  /** Does this name already have a wallet? For the check, and for `/health`. */
  has(name: string): boolean {
    return this.file.wallets[walletKey(name)] !== undefined;
  }

  /**
   * An **account's** wallet, created on first sight. See `accountWalletKey`.
   *
   * A second door rather than a flag on `for`, because the two take different
   * kinds of string and mixing them would be one function whose caller has to
   * remember which. `Simulation.join` picks between them once, on whether the
   * participant is bound to an account, and nothing else in the codebase calls
   * either.
   */
  forAccount(accountId: string, nowMs = Date.now()): WalletRecord {
    const key = accountWalletKey(accountId);
    let record = this.file.wallets[key];
    if (record === undefined) {
      record = createWallet(STARTING_BALANCE);
      this.file.wallets[key] = record;
    }
    record.lastSeenMs = nowMs;
    this.touch();
    return record;
  }

  /**
   * "Would you like to save progress?" -- the guest's balance onto the account.
   *
   * Called once, from `AccountStore.signup`, at the moment an account comes into
   * existence. Three things about how it is written:
   *
   *   - It **moves rather than adds**, and the guest row is deleted. Leaving it
   *     would be a balance that the next person to type that name inherits,
   *     which is the exact behaviour signing up is supposed to end.
   *   - It refuses to overwrite an account wallet that already has more than the
   *     starting balance in it. That cannot happen on today's call path -- the
   *     account was created milliseconds ago -- and it is checked anyway,
   *     because the day social login lands, `signup` becomes a route that can be
   *     reached for an account that already existed, and a migration that
   *     clobbered would be somebody's money gone with no error.
   *   - It does nothing at all if the guest name has no wallet, which is the
   *     ordinary case for a player who signed up from the landing page before
   *     ever joining.
   *
   * Returns what moved, so the caller can say so if it ever wants to.
   */
  migrateToAccount(guestName: string, accountId: string, nowMs = Date.now()): number {
    const from = walletKey(guestName);
    const guest = this.file.wallets[from];
    if (guest === undefined) return 0;
    const to = accountWalletKey(accountId);
    const held = this.file.wallets[to];
    if (held !== undefined && held.balance > STARTING_BALANCE) return 0;
    // The whole record travels, not only the balance: the Centrelink claim
    // stamps are what stop a player claiming at the same office twice in an
    // hour, and a migration that dropped them would make signing up worth $100
    // at every office in the city.
    guest.lastSeenMs = nowMs;
    this.file.wallets[to] = guest;
    delete this.file.wallets[from];
    this.touch();
    return guest.balance;
  }

  /**
   * Move money and mark the file dirty. The **only** mutation path.
   *
   * The arithmetic itself is `moveBalance` below rather than inline here, so
   * the self-check can drive it without constructing a store -- a store schedules
   * a debounced write on its first mutation, and a boot check that left a timer
   * armed against a path chosen for a test is a boot check that writes a file.
   */
  move(record: WalletRecord, delta: number): number {
    const moved = moveBalance(record, delta);
    if (moved !== 0) this.touch();
    return moved;
  }

  /**
   * "Something in a record I handed out has changed; write it."
   *
   * The door for callers that hold a `WalletRecord` and mutate it through
   * `moveBalance` directly -- which `server/sim.ts` does, because the record it
   * holds *is* the one in this store's map and there is nothing to copy back.
   * Without this the store would never learn about a knockout's drop and the
   * file would only be written when somebody joined.
   */
  markDirty(): void {
    this.touch();
  }

  /** Stamp a Centrelink claim at one office. See `cash.claimWaitMs`. */
  recordClaim(record: WalletRecord, officeId: string, atMs: number): void {
    record.centrelink[officeId] = atMs;
    this.touch();
  }

  /** How many names are on file. The boot line, and `/health`. */
  get size(): number {
    return Object.keys(this.file.wallets).length;
  }

  describe(): string {
    if (!this.loaded) return `${this.path} (not loaded)`;
    const swept = this.swept > 0 ? `, ${this.swept} expired` : '';
    return `${this.size} wallet(s)${swept} in ${this.path}`;
  }

  /**
   * Write atomically. See the header for why it is a temp file and a rename.
   *
   * Left dirty on failure, so the next debounce tries again rather than
   * silently dropping the write -- `SuggestionStore.save`'s behaviour, and the
   * difference between "the disk was full for ten seconds" and "everybody's
   * money is gone".
   */
  async save(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty) return;
    if (this.frozen) {
      // See `load`'s catch. The file on disk is the only copy of something the
      // parser refused and the copy-aside failed; writing over it is the one
      // thing this process must not do on its own.
      console.error(`[sydney] wallets: not saving ${this.path}; writes are frozen after a failed copy-aside.`);
      return;
    }
    this.dirty = false;
    const tmp = `${this.path}.tmp-${process.pid}`;
    try {
      // The directory may not exist on a fresh box. `Bun.write` creates parents
      // for the file it is given, which covers both this and the rename target.
      await Bun.write(tmp, JSON.stringify(this.file));
      await Bun.$`mv -f ${tmp} ${this.path}`.quiet();
    } catch (err) {
      this.dirty = true;
      console.error(`[sydney] wallets: could not write ${this.path}: ${String(err)}`);
    }
  }

  /** Mark dirty and schedule a write. Debounced; see `SAVE_DEBOUNCE_MS`. */
  private touch(): void {
    this.dirty = true;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Stop the timer and get everything on disk. For the shutdown hook. */
  async close(): Promise<void> {
    await this.save();
  }
}

/**
 * Add (or subtract) dollars, clamped, and report what actually moved.
 *
 * The clamp lives here rather than at the call sites for the reason every clamp
 * in this project does: a balance that went negative would be a HUD reading
 * `-$40` with no rule in the game that can produce one, and a balance over
 * `MAX_BALANCE` would silently truncate on an `i32` the next time it crossed
 * the wire. The return value is how a caller finds out a debit was short --
 * `Simulation.wallet.debit` uses it to refuse a purchase rather than part-pay
 * for one.
 *
 * `Math.trunc` because every rule in `game/cash.ts` produces integers and a
 * stray float here would be a balance that renders as `$12.999999999`.
 */
export function moveBalance(record: WalletRecord, delta: number): number {
  const before = record.balance;
  const after = Math.max(0, Math.min(MAX_BALANCE, before + Math.trunc(delta)));
  record.balance = after;
  return after - before;
}

/**
 * One record off disk, or null if it is not one.
 *
 * Every field is re-derived rather than trusted, because this file is
 * hand-editable by whoever runs the box and a `balance` of `"1e9999"` or an
 * array where the claim table should be would otherwise reach the wire as
 * `NaN` -- which `DataView.setInt32` writes as zero, so a bad row on disk would
 * silently take somebody's money rather than being refused.
 */
function sanitiseRecord(value: unknown): WalletRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Partial<WalletRecord>;
  const balance = Number(raw.balance);
  const centrelink: Record<string, number> = {};
  if (typeof raw.centrelink === 'object' && raw.centrelink !== null && !Array.isArray(raw.centrelink)) {
    for (const [id, at] of Object.entries(raw.centrelink)) {
      const ms = Number(at);
      if (Number.isFinite(ms) && ms > 0 && id.length <= 24) centrelink[id] = ms;
    }
  }
  const lastSeen = Number(raw.lastSeenMs);
  return {
    balance: Number.isFinite(balance) ? Math.max(0, Math.min(MAX_BALANCE, Math.trunc(balance))) : 0,
    centrelink,
    lastSeenMs: Number.isFinite(lastSeen) ? lastSeen : 0,
  };
}

// --- The self-check --------------------------------------------------------------

/**
 * The key, the clamp and the file parser -- everything that can lose money
 * without throwing.
 *
 * Run at boot in `server/index.ts` because every failure here is silent in this
 * repo's sense:
 *
 *   - A **key that does not fold case** gives one player three wallets and
 *     presents as "my money keeps resetting", which is the exact complaint the
 *     persistence exists to prevent.
 *   - A **clamp that admits a negative** draws `-$40` on a HUD that has no rule
 *     that can produce one.
 *   - A **parser that trusts the file** turns one hand-edited row into a `NaN`
 *     balance, which the wire writes as zero -- somebody's money, gone, with no
 *     error anywhere.
 *
 * Deliberately **does no disk I/O**: `save` is exercised by the running server
 * and a check that wrote a temp file would be a check that fails on a read-only
 * filesystem for reasons that have nothing to do with wallets.
 */
export function verifyWallets(): string[] {
  const failures: string[] = [];

  // --- The key folds case, whitespace and nothing else.
  {
    const cases: Array<[string, string]> = [
      ['Bazza', 'bazza'],
      ['  Bazza  ', 'bazza'],
      ['BAZZA', 'bazza'],
      ['Bazza  Two', 'bazza two'],
      ['Bazza (2)', 'bazza (2)'],
      ['🦘', '🦘'],
    ];
    for (const [name, want] of cases) {
      const got = walletKey(name);
      if (got !== want) failures.push(`walletKey(${JSON.stringify(name)}) is ${JSON.stringify(got)}, not ${JSON.stringify(want)}.`);
    }
    // Idempotent, or a key round-tripped through the file changes.
    for (const [name] of cases) {
      if (walletKey(walletKey(name)) !== walletKey(name)) {
        failures.push(`walletKey is not idempotent on ${JSON.stringify(name)}.`);
      }
    }
    // And "Bazza (2)" -- the name `uniqueName` invents for a second Bazza in a
    // room -- is emphatically **not** the same wallet as "Bazza". That is the
    // rule stated in the header and it has to be true rather than assumed.
    if (walletKey('Bazza (2)') === walletKey('Bazza')) {
      failures.push('A deduped name shares a wallet with the name it was deduped from.');
    }
  }

  // --- The account key space, which must not overlap the name one.
  //
  // The failure this catches is the worst one in the file: an account key a
  // guest could reach by typing a name is one player spending another's balance
  // with no error anywhere. `accountWalletKey` argues that it is unreachable
  // from the character cap; this asserts it rather than trusting the argument.
  {
    const id = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    const key = accountWalletKey(id);
    if (!key.startsWith('account:')) failures.push(`An account wallet key is ${key}, which is not namespaced.`);
    if (accountWalletKey(id) !== accountWalletKey(id.toUpperCase())) {
      failures.push('Account wallet keys do not fold case; one account would have two balances.');
    }
    if (key.length <= MAX_NAME_CHARS) {
      failures.push(`An account key is ${key.length} characters, which a ${MAX_NAME_CHARS}-character name could reach.`);
    }
    // And the other direction: the longest name anybody can type, keyed, is
    // still shorter than the shortest account key.
    const longest = walletKey('x'.repeat(MAX_NAME_CHARS));
    if (longest.length >= key.length) {
      failures.push(`A ${longest.length}-character name key can reach the account key space.`);
    }
  }

  // --- The clamp, in both directions, through the only mutation path.
  {
    const w = createWallet(50);
    if (moveBalance(w, 30) !== 30 || w.balance !== 80) failures.push(`Crediting $30 to $50 gave $${w.balance}.`);
    if (moveBalance(w, -100) !== -80 || w.balance !== 0) {
      failures.push(`Debiting $100 from $80 left $${w.balance}; it should stop at zero and report -80.`);
    }
    const rich = createWallet(MAX_BALANCE - 5);
    moveBalance(rich, 1000);
    if (rich.balance !== MAX_BALANCE) failures.push(`A balance over the cap came out at $${rich.balance}.`);
    const frac = createWallet(0);
    moveBalance(frac, 12.9);
    if (frac.balance !== 12) failures.push(`Crediting $12.9 gave $${frac.balance}, not $12.`);
  }

  // --- The file parser, on the rows a hand-edited file can really contain.
  {
    const bad: Array<[unknown, string]> = [
      [null, 'null'],
      ['forty dollars', 'a string'],
      [{ balance: 'lots' }, 'a non-numeric balance'],
      [{ balance: NaN }, 'a NaN balance'],
      [{ balance: -500 }, 'a negative balance'],
      [{ balance: 1e300 }, 'an absurd balance'],
      [{ balance: 10, centrelink: ['cl000'] }, 'an array where the claim table goes'],
      [{ balance: 10, centrelink: { cl000: 'yesterday' } }, 'a non-numeric claim stamp'],
    ];
    for (const [row, why] of bad) {
      const got = sanitiseRecord(row);
      if (got === null) continue; // refused outright is a fine answer
      if (!Number.isFinite(got.balance) || got.balance < 0 || got.balance > MAX_BALANCE) {
        failures.push(`A record with ${why} produced a balance of ${got.balance}.`);
      }
      for (const at of Object.values(got.centrelink)) {
        if (!Number.isFinite(at)) failures.push(`A record with ${why} produced a non-finite claim stamp.`);
      }
    }
    // A good row survives intact, which is the other half of the same test.
    const good = sanitiseRecord({ balance: 1234, centrelink: { cl017: 1_800_000_000_000 }, lastSeenMs: 5 });
    if (!good || good.balance !== 1234 || good.centrelink.cl017 !== 1_800_000_000_000 || good.lastSeenMs !== 5) {
      failures.push(`A well-formed record came back as ${JSON.stringify(good)}.`);
    }
  }

  // --- The path honours `SYDNEY_STATE_DIR` and lands on `wallets.json`.
  {
    const path = defaultWalletPath();
    if (!path.endsWith('/wallets.json')) failures.push(`The wallet path is ${path}, which is not a wallets.json.`);
  }

  // --- And the debounce is slow enough to be worth having and fast enough
  // that a crash costs at most one fare.
  {
    if (!(SAVE_DEBOUNCE_MS >= 1000 && SAVE_DEBOUNCE_MS <= 15000)) {
      failures.push(`The save debounce is ${SAVE_DEBOUNCE_MS} ms, outside the 1-15 s the header argues for.`);
    }
  }

  return failures;
}
