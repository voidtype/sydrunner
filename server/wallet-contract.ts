/**
 * The wallet contract, from the server's side of the tree.
 *
 * **A re-export and nothing else.** The interface itself lives in
 * `client/src/game/wallet-contract.ts` because that is where the *consumer*
 * lives -- `game/characters.ts` is a shared module compiled into both the Bun
 * server and the browser, and a shared module cannot import out of `server/`.
 *
 * This file exists because the brief that commissioned it names both paths, and
 * because `server/index.ts` and `server/sim.ts` should not have to reach across
 * the tree with a `../client/src/game/...` specifier to install a wallet they
 * own. Every other server module that wants a shared type does exactly that
 * reach (see `server/sim.ts`'s import block), so this is a convenience rather
 * than a rule -- but it is the convenience the producing branch was told to
 * expect, and a second definition of `WalletLookup` on this side would be two
 * interfaces that agree by inspection, which is the failure mode this whole
 * file was written to avoid.
 *
 * There is deliberately no implementation here. The real wallet belongs to the
 * branch that owns the money; when it lands, its `Simulation.wallet` satisfies
 * `WalletLookup` and boot calls `setWallet(sim.wallet)`.
 */

export {
  NO_WALLET,
  setWallet,
  verifyWallet,
  wallet,
  type WalletLookup,
} from '../client/src/game/wallet-contract.ts';
