/**
 * The wallet, as a **hole of a known shape**.
 *
 * There is no money in this build yet. A sibling branch is adding one --
 * `Simulation.wallet.debit(playerId, amount, why)` -- and `game/characters.ts`
 * needs it before it exists, because an eshay who rolls you and takes nothing
 * is an eshay who shoved you.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS RATHER THAN A `TODO`
 *
 * The two branches are being written at the same time against the same commit,
 * and there are exactly two ways that ends. Either the consumer guesses at the
 * producer's signature and the merge is a rewrite of every call site, or the
 * signature is written down once, in a file neither of them has to edit, and
 * the merge is one line: the lead calls `setWallet(sim.wallet)` at boot.
 *
 * So this is the interface and nothing else. It holds no state, it has no
 * opinion about what a dollar is, and it will not need to change when the real
 * wallet lands -- the real wallet is a `WalletLookup` and the installer takes
 * one.
 *
 * ---------------------------------------------------------------------------
 * THE DEFAULT IS A NO-OP AND THAT IS A WORKING CONFIGURATION
 *
 * `NO_WALLET` debits nothing, credits nothing and reports every balance as
 * zero, which is the truth in a build with no money in it. It is not a stub
 * that throws and it is not `null` at the call sites, on
 * `minimap.HazardSource`'s own argument in this codebase: a seam whose unwired
 * state is a crash is a seam that has to be wired before anything can be
 * tested, and a seam whose unwired state is a defensible answer can ship
 * halfway.
 *
 * What it costs is one behaviour: an eshay's roll takes $0 until the wallet is
 * installed, and the shove, the knockdown, the bark and the crime all happen
 * exactly as they will afterwards. `debit` **returns what was actually taken**
 * rather than a boolean for precisely this reason -- the caller writes its feed
 * line off the return value, so the no-op produces "they went through your
 * pockets and found nothing", which is a sentence about Sydney rather than a
 * placeholder.
 *
 * ---------------------------------------------------------------------------
 * THREE-FREE, AND ON BOTH ENDS
 *
 * `server/sim.ts` imports `game/characters.ts`, which imports this, so this
 * file may not touch three and may not touch the DOM. It imports nothing at
 * all, which makes it a leaf on `player/collision.ts`'s own terms.
 *
 * The installed wallet is **module-level**, exactly as `factions.pendingCrimes`
 * is and for the identical reason: there is one player, one city and one set of
 * consequences in a process, and threading a wallet through `FactionCtx` so a
 * faction could reach it would mean every future consumer of the context grew a
 * field it never reads. `reportCrime` is the precedent and it is the whole of
 * the argument.
 */

/**
 * Everything a faction may ask of a wallet. Three methods, and no more.
 *
 * `why` is a short lower-case phrase, `hud.ts`'s voice -- "rolled by eshays" --
 * and is for the ledger the producing branch keeps, not for display here. It is
 * required rather than optional because an unlabelled debit is a bug report
 * nobody can answer.
 */
export interface WalletLookup {
  /**
   * Take up to `amount` from a player. Returns **what was actually taken**,
   * which may be zero and may be less than asked for.
   *
   * Never negative, never more than `amount`, and never throws on an unknown
   * player -- an id nobody has a wallet for has nothing in it, which is the
   * same answer as an empty wallet and needs no second branch at the call site.
   */
  debit(id: number, amount: number, why: string): number;
  /** Give a player money. No return: a credit cannot partially fail. */
  credit(id: number, amount: number, why: string): void;
  /** What a player has. Zero for an unknown id. */
  balanceOf(id: number): number;
}

/**
 * The wallet in a build that has no money.
 *
 * Frozen, because it is a shared singleton and a caller that mutated it would
 * be mutating it for the whole process. Nothing in this repo would, and a
 * frozen object says so in a way a comment cannot.
 */
export const NO_WALLET: WalletLookup = Object.freeze({
  debit(_id: number, _amount: number, _why: string): number {
    return 0;
  },
  credit(_id: number, _amount: number, _why: string): void {
    /* nothing to credit into */
  },
  balanceOf(_id: number): number {
    return 0;
  },
});

let installed: WalletLookup = NO_WALLET;

/**
 * Point this process at a real wallet. **The lead's one-line merge.**
 *
 * Called at boot on the authority -- `server/index.ts` online, `main.ts`
 * offline -- and nowhere else. Passing `null` restores the no-op, which is what
 * a self-check that has to start from nothing does; see `verifyCharacters`.
 *
 * Idempotent by construction: it is an assignment. There is deliberately no
 * "already installed" throw, because the two authorities in this project are
 * two processes and a test harness is a third, and a guard would only ever fire
 * on a legitimate re-install inside one of them.
 */
export function setWallet(next: WalletLookup | null): void {
  installed = next ?? NO_WALLET;
}

/** The wallet in force. Never null; see `NO_WALLET`. */
export function wallet(): WalletLookup {
  return installed;
}

/**
 * The contract, checked from the outside.
 *
 * Two of these are about the *default* rather than about a real wallet, and
 * they are the ones that matter today: a `NO_WALLET.debit` that returned the
 * amount it was asked for rather than zero would make an eshay's feed line
 * claim twenty dollars that never moved, which is a lie in the kill feed and
 * not a crash anywhere. The third is the invariant every real implementation
 * has to satisfy and is checked here so the producing branch inherits a test
 * rather than a paragraph.
 */
export function verifyWallet(): string[] {
  const failures: string[] = [];
  const saved = installed;
  try {
    setWallet(null);
    const took = wallet().debit(1, 20, 'self-check');
    if (took !== 0) {
      failures.push(
        `NO_WALLET.debit reported taking ${took} of a requested 20. A build with no money in it has ` +
          'to report taking nothing, or every feed line about a robbery is a lie.',
      );
    }
    if (wallet().balanceOf(1) !== 0) {
      failures.push('NO_WALLET.balanceOf is not zero, so a faction could believe a player is carrying cash.');
    }
    // A hand-rolled wallet with fifty dollars in it, to assert the one rule
    // every real implementation has to keep: a debit is bounded by the ask and
    // by the balance, and it reports the smaller of the two.
    let held = 50;
    setWallet({
      debit(_id, amount) {
        const take = Math.min(amount, held);
        held -= take;
        return take;
      },
      credit(_id, amount) {
        held += amount;
      },
      balanceOf() {
        return held;
      },
    });
    if (wallet().debit(1, 20, 'self-check') !== 20) failures.push('A debit inside the balance did not report the full amount.');
    if (wallet().debit(1, 60, 'self-check') !== 30) failures.push('A debit over the balance did not report only what was there.');
    if (wallet().debit(1, 10, 'self-check') !== 0) failures.push('A debit on an empty wallet took something.');
  } finally {
    setWallet(saved);
  }
  return failures;
}
