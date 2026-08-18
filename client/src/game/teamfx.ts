/**
 * Talent effects: the one place a talent becomes a number the simulation uses.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE IS FOR.
 *
 * `game/teams.ts` is the contract -- forty-two nodes, each carrying a list of
 * `FX.*` keys and numbers, plus the `TeamLookup` interface that answers
 * "what is this player's scalar for this key" with auras and groups already
 * folded in. That file deliberately knows nothing about the game: it does not
 * know that health is three pips, that a car is taken from 2.2 m, or that a
 * fare pays `FARE_BASE + FARE_PER_KM * km`.
 *
 * This file is the other half. Every function here takes a player id (and, where
 * the base is not a module constant, the base) and returns **the number the
 * caller should actually use**. The call sites are then one-liners:
 *
 *     victim.health -= damageScale(attacker) * fxDamageTakenScale(victim.id);
 *     beginTake(q, x, feet, z, fxTakeRadiusM(p.id), fxTakeableSpeed(p.id));
 *
 * That split is the whole design and it is worth stating why, because the
 * obvious alternative -- have each subsystem read `lookup.scalar(id, FX.X)`
 * itself -- was tried on paper and rejected twice over. First, the composition
 * rules are not obvious and they are not the same for every key: `DAMAGE_TAKEN`
 * is a fraction *subtracted* from a multiplier, `CRASH_COOLDOWN_S` is an
 * absolute that only applies if it is lower than the base, `POLICE_MISS`
 * multiplies a probability, and `CASH_IS_STATS` folds a wallet into two
 * different stats with one cap across both. Nine subsystems each getting those
 * rules nearly right is nine places the talent means something slightly
 * different. Second, the FX keys are the *only* thing a hook should name, and a
 * hook that reads `FX.SWING_DAMAGE` directly still has to know that swing
 * damage is a multiplier on `powerups.damageScale` and not on the pip count.
 * Here it asks for `fxSwingDamageScale(id)` and gets a multiplier.
 *
 * ---------------------------------------------------------------------------
 * THE INJECTION POINT, and why it is a module global.
 *
 * `setTeamLookup(lookup)` installs the real lookup; until something does, every
 * query answers off `NO_TEAMS` and every function here returns its base. That is
 * not a convenience -- it is the property that let this workstream be written
 * against a framework that did not exist yet, and it is the property that keeps
 * every existing self-check passing unchanged: `verifyCombat` does not install a
 * lookup, so `fxSwingDamageScale` is 1 and the punch is the punch it always was.
 *
 * A module global rather than a parameter threaded through nine subsystems, on
 * exactly the precedent `factions.setHeatReader` and `heat.installHeat` set in
 * this repo: the alternative is a `TeamLookup` argument on `applyHit`,
 * `crashDamage`, `farePayout`, `resolveTake` and thirty other functions, most of
 * which are called from self-checks that have no rooms and no players. One
 * installed object, one `resetTeamFx()` for the checks, and the ownership rule
 * is the same one the heat field has: **the server installs the real one; the
 * browser installs the one its own prediction should use, which is the roster
 * it was sent.**
 *
 * Two smaller readers hang off the same hook for the same reason.
 * `setStarsReader` is how `STAR_DAMAGE` finds out how wanted you are without
 * this file importing `game/heat.ts` (which imports `game/combat.ts`, which
 * imports this: a cycle), and `setWalletReader` is how `CASH_IS_STATS` finds a
 * balance without importing the wallet store, which lives in the server process
 * only. Both default to zero, which is what an offline browser and every
 * self-check should see.
 *
 * ---------------------------------------------------------------------------
 * THE PER-PLAYER STATE, and what is *not* in it.
 *
 * Three talents are clocks rather than numbers -- `FIRST_KNOCKDOWN_IMMUNE_S`
 * (the first knockdown every 30 s is a stagger), `RESPAWN_IN_PLACE_CD_S` and
 * `REGEN_PIP_S` -- and a clock has to live somewhere. It lives here, in one
 * `Map<number, FxState>` keyed by player id, rather than as three new fields on
 * `CombatantState`, and that is a deliberate departure from this repo's usual
 * rule ("one record of a fact, on the combatant").
 *
 * The reason is the wire. `CombatantState` is what a snapshot carries, field for
 * field; adding three floats to it costs three floats per player per tick
 * forever, to carry state that **nothing outside the authority ever reads**. The
 * client does not predict a knockdown-immunity window -- it is told the outcome
 * by the next `HIT` event, 50 ms later -- and no renderer draws these clocks. So
 * they are server-side bookkeeping with a client mirror that exists only so the
 * prediction path compiles, exactly like `Participant.mountHeld`.
 *
 * The map is bounded by the room's player count, `forgetPlayer` is called on
 * leave, and every entry is three numbers. `PERFORMANCE.md`'s budget is
 * O(players) per tick and allocation-free in the hot path: the record is
 * allocated once on a player's first query and mutated in place after.
 *
 * **Ability cooldowns are not here.** They are `game/abilities.ts`, because they
 * are a table with its own rules (a per-day stamp for the megas, a rising edge
 * per button) and because the two files have different readers: this one is read
 * by nine subsystems and that one by exactly one input handler.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM.
 *
 * Everything here is `+ - * /`, `Math.min`, `Math.max` and `Math.floor`. No
 * `sin`, `cos`, `pow` or `hypot`, on `game/footy.ts`'s rule: several of these
 * numbers are evaluated on both ends for the same tick (the swing damage the
 * client predicts and the server adjudicates, most obviously) and the two have
 * to land on the same float.
 *
 * ---------------------------------------------------------------------------
 * THE ABSENT-KEY PROBLEM, stated once because it bites exactly one key.
 *
 * `TeamLookup.scalar` returns **0 for a key nobody's talents carry**, which is
 * indistinguishable from a talent that carries the key with the value 0. For
 * every key in the contract that is fine, because 0 is not a meaningful value
 * for any of them -- a take radius of 0, a Centrelink period of 0 days, a ball
 * recharge of 0 s all mean "no talent" and the helper falls back to the base.
 *
 * `DEATH_DROP` is the exception: `Warranty` and `Cash Rules` both carry
 * `[DEATH_DROP, 0]` and mean it -- "on KO you drop nothing". So
 * `fxDeathDropFraction` asks a second question, and it asks it in terms of *FX
 * keys* rather than talent names (the contract's rule is that nothing outside
 * `teams.ts` pattern-matches on a talent's **name**): both of those nodes also
 * carry a key that is never zero -- `RESPAWN_PIPS` on Warranty and
 * `CASH_IS_STATS` on Cash Rules -- so a zero `DEATH_DROP` beside either of those
 * is a real zero. It is the one place in this file that reads two keys to answer
 * one question, and the alternative was widening the frozen `TeamLookup`
 * interface with a `has(id, key)` that six other call sites would never use.
 */

import {
  AURA_M,
  FX,
  GROUP_M,
  NO_TEAMS,
  TEAM,
  TEAM_NAME,
  type FxKey,
  type Team,
  type TeamLookup,
} from './teams.ts';

// --- The injection point ---------------------------------------------------------------

let lookup: TeamLookup = NO_TEAMS;
let starsReader: (playerId: number) => number = () => 0;
let walletReader: (playerId: number) => number = () => 0;

/**
 * Install the real lookup. `null` puts the no-op back, which is what a
 * self-check wants between cases and what an offline browser runs on.
 */
export function setTeamLookup(l: TeamLookup | null): void {
  if (pinned) return;
  lookup = l ?? NO_TEAMS;
}
/**
 * A driver's override. `Simulation` re-points the lookup at its own `TeamField`
 * every tick (a host runs several rooms), which would silently undo a check
 * that installed a fake one; `pinTeamLookup` installs and holds it until
 * `pinTeamLookup(null)`. Not for game code.
 */
let pinned = false;
export function pinTeamLookup(l: TeamLookup | null): void {
  pinned = false;
  setTeamLookup(l);
  pinned = l !== null;
}
/** The installed lookup, for the two hooks that need `teamOf` and nothing else. */
export function teamLookup(): TeamLookup {
  return lookup;
}
/** How many heat stars a player has. See the header: an injected reader, not an import. */
export function setStarsReader(fn: ((playerId: number) => number) | null): void {
  starsReader = fn ?? (() => 0);
}
/** How many dollars a player has. See the header. */
export function setWalletReader(fn: ((playerId: number) => number) | null): void {
  walletReader = fn ?? (() => 0);
}

/** Everything back to the boot state: no lookup, no readers, no clocks. */
export function resetTeamFx(): void {
  lookup = NO_TEAMS;
  starsReader = () => 0;
  walletReader = () => 0;
  tickNowMs = 0;
  state.clear();
}

/** The scalar for a key, auras and groups already folded in by the framework. */
export function fxScalar(playerId: number, key: FxKey): number {
  return lookup.scalar(playerId, key);
}
/** The flag for a key. */
export function fxFlag(playerId: number, key: FxKey): boolean {
  return lookup.flag(playerId, key);
}
/** Which side a player is on. `TEAM.NONE` for a guest, a bot, or an NPC. */
export function fxTeamOf(playerId: number): Team {
  return lookup.teamOf(playerId);
}

/**
 * An absolute key where the *bigger* number wins against the base, treating 0
 * as "no talent carries this". See the header's absent-key note.
 */
function absMax(playerId: number, key: FxKey, base: number): number {
  const s = lookup.scalar(playerId, key);
  return s > 0 && s > base ? s : base;
}
/** An absolute key where the *smaller* number wins. 0 is "no talent". */
function absMin(playerId: number, key: FxKey, base: number): number {
  const s = lookup.scalar(playerId, key);
  return s > 0 && s < base ? s : base;
}

// --- The per-player clocks ---------------------------------------------------------------

interface FxState {
  /** Wall ms at which the first-knockdown window last opened. -Infinity: never. */
  knockdownWindowMs: number;
  /** Wall ms at which the last respawn-in-place was used. */
  respawnInPlaceMs: number;
  /** Seconds of out-of-combat credit toward the next regenerated pip. */
  regenT: number;
  /** Wall ms of the last time this player took or dealt damage. Gates the regen. */
  lastCombatMs: number;
  /** Wall ms until which this player's stolen car does not report a theft. 0: never. */
  ghostPlatesUntilMs: number;
  /**
   * Wall ms until which this player has `Ute Life` **granted** rather than taken.
   *
   * `Tradie Rates`: "every fare completed grants 30 s of Ute Life if you don't
   * have it". It is the only temporary *talent* in the tree, and the frozen
   * `TeamLookup` cannot express it -- that interface answers off a persisted
   * talent mask, and a lookup that returned a different scalar for thirty
   * seconds would make the framework's aura cache lie. So it lives here, as a
   * timestamp, and the two car helpers below fold it in. See `fxSetNow` for the
   * clock it is compared against and why that clock is a module global.
   */
  uteLifeUntilMs: number;
  /** Wall ms until which no crime this player commits reaches the heat ladder. */
  heatFrozenUntilMs: number;
}

/**
 * The tick's wall clock, installed once per tick by whoever owns the loop.
 *
 * Exactly one talent needs a clock inside a helper that has no way to be handed
 * one: `Tradie Rates`' thirty granted seconds of `Ute Life` are read by
 * `fxCrashDamageScale` and `fxCarHealthScale`, which are called from
 * `driving.CarField.damage` -- three frames deep in a function whose signature
 * is `(carId, amount)` and whose callers are the crash sweeps.
 *
 * Threading a `nowMs` through all of that to serve one talent was the
 * alternative and it is worse: five signatures change, every self-check that
 * drives a car has to invent a clock, and the parameter is unused in 99.99% of
 * calls. A tick clock set once at the top of `Simulation.step` (and once per
 * frame in `main.ts`) is the same shape `heat.installHeat` and
 * `factions.setHeatReader` already have, it is monotonic, and being one tick
 * stale is 17 ms on a thirty-second window.
 *
 * Zero until something sets it, which means the window is never open -- the
 * correct answer for every self-check and for an offline browser.
 */
let tickNowMs = 0;
export function fxSetNow(nowMs: number): void {
  tickNowMs = nowMs;
}
/** What the last `fxSetNow` said. For the callers that want the same instant. */
export function fxNow(): number {
  return tickNowMs;
}

const state = new Map<number, FxState>();

function fxState(playerId: number): FxState {
  let s = state.get(playerId);
  if (s === undefined) {
    s = {
      knockdownWindowMs: -Infinity,
      respawnInPlaceMs: -Infinity,
      regenT: 0,
      lastCombatMs: -Infinity,
      ghostPlatesUntilMs: 0,
      uteLifeUntilMs: 0,
      heatFrozenUntilMs: 0,
    };
    state.set(playerId, s);
  }
  return s;
}

/** Drop a player's clocks. Called on leave; the map is bounded by the room. */
export function forgetPlayer(playerId: number): void {
  state.delete(playerId);
}

/** How many players currently have clocks. Diagnostics and the self-check. */
export function fxTrackedPlayers(): number {
  return state.size;
}

// --- 1. Combat ---------------------------------------------------------------------------

/**
 * Max health pips, `MAX_PIPS` and `GROUP_PIPS` on top of the base.
 *
 * The base is handed in rather than imported from `game/combat.ts`, and that is
 * not squeamishness about a cycle (there is one: combat imports this) -- it is
 * that `MAX_HEALTH` is the only number in that file this would need and every
 * caller already has it in scope.
 *
 * `GROUP_PIPS` is summed rather than maxed because the two keys are different
 * grants: Big Night is a permanent pip and Sunday Rush is a pip you have while
 * three of you are standing together, and a player with both should have five.
 * The framework returns 0 for `GROUP_PIPS` when the group is not there, which is
 * where the "while 3+ within 20 m" clause actually lives -- see `GROUP_M`.
 */
export function fxMaxPips(playerId: number, base: number): number {
  return base + lookup.scalar(playerId, FX.MAX_PIPS) + lookup.scalar(playerId, FX.GROUP_PIPS);
}

/**
 * The wallet's contribution to damage and armour, as a **percentage point count
 * capped at 20**, or 0 without the mega.
 *
 * `Cash Rules`: "every $50 in your wallet is +1% swing damage and +1% armour,
 * capped at $1,000 (+20/+20)". One function for both because the cap is one cap
 * across both -- computing it twice is two places the $1,000 could become $1,050.
 */
export function fxCashStatPercent(playerId: number): number {
  if (!lookup.flag(playerId, FX.CASH_IS_STATS)) return 0;
  const dollars = walletReader(playerId);
  if (!(dollars > 0)) return 0;
  const pct = Math.floor(dollars / 50);
  return pct > 20 ? 20 : pct;
}

/**
 * The multiplier on a swing's damage: talents, heat stars and cash together.
 *
 * Multiplies `powerups.damageScale` rather than replacing it, on the same
 * argument the bike's speed scale multiplies the powerup's: a Front Bar swing
 * with a Training coffee should be both, and a rule about which wins is a rule
 * somebody has to remember.
 *
 * `STAR_DAMAGE` is per star and the stars come from the injected reader, so a
 * player at 5★ with Sirens Are Music gets +30% and a player with no lookup
 * installed gets exactly 1. `BERSERK`/`BRACE` are **not** here: they are timed
 * ability windows and `game/abilities.ts` owns the window, so their damage
 * arrives through `fxAbilitySwingBonus` below and is added by the same caller.
 */
export function fxSwingDamageScale(playerId: number): number {
  let scale = 1 + lookup.scalar(playerId, FX.SWING_DAMAGE);
  const perStar = lookup.scalar(playerId, FX.STAR_DAMAGE);
  if (perStar !== 0) {
    const stars = starsReader(playerId);
    if (stars > 0) scale += perStar * stars;
  }
  const cash = fxCashStatPercent(playerId);
  if (cash > 0) scale += cash / 100;
  return scale;
}

/**
 * The multiplier on damage *taken*: armour from `DAMAGE_TAKEN` and from cash.
 *
 * Floored at 0.05 rather than at 0. Two auras and a mega can in principle stack
 * past 100% reduction, and an invulnerable player is a worse outcome than a very
 * tough one -- the fight simply stops being a fight, and nothing on screen says
 * why. 5% is "twenty punches" which is a long fight and still a losable one.
 */
export function fxDamageTakenScale(playerId: number): number {
  let reduction = lookup.scalar(playerId, FX.DAMAGE_TAKEN);
  const cash = fxCashStatPercent(playerId);
  if (cash > 0) reduction += cash / 100;
  const scale = 1 - reduction;
  return scale < 0.05 ? 0.05 : scale > 1 ? 1 : scale;
}

/** The swing's ACTIVE window in ms, `SWING_WINDOW_MS` on top of the base. */
export function fxSwingWindowMs(playerId: number, baseMs: number): number {
  return baseMs + lookup.scalar(playerId, FX.SWING_WINDOW_MS);
}

/** Do this player's fists knock down instead of stagger? */
export function fxFistsKnockdown(playerId: number): boolean {
  return lookup.flag(playerId, FX.FISTS_KNOCKDOWN);
}
/** Does being hit mid-swing cancel it? `Bouncer` says no. */
export function fxSwingUninterruptible(playerId: number): boolean {
  return lookup.flag(playerId, FX.SWING_UNINTERRUPTIBLE);
}

/** Pips on respawn, `RESPAWN_PIPS` or the base 1. */
export function fxRespawnPips(playerId: number, base: number): number {
  const s = lookup.scalar(playerId, FX.RESPAWN_PIPS);
  return s > base ? s : base;
}

/**
 * May this player get up where they fell, right now? Consumes the cooldown.
 *
 * `Warranty`: "once per 5 minutes you respawn where you fell instead of at
 * spawn". Consuming on the *ask* rather than on a separate commit is the right
 * shape here because there is exactly one caller and it always acts on a yes --
 * and a two-call protocol would be a second place the cooldown could be forgotten.
 */
export function fxTakeRespawnInPlace(playerId: number, nowMs: number): boolean {
  const cd = lookup.scalar(playerId, FX.RESPAWN_IN_PLACE_CD_S);
  if (cd <= 0) return false;
  const s = fxState(playerId);
  if (nowMs - s.respawnInPlaceMs < cd * 1000) return false;
  s.respawnInPlaceMs = nowMs;
  return true;
}

/** What a hit does to this player once their talents have had a say. */
export const KNOCKDOWN = {
  /** The hit lands as it normally would. */
  FULL: 0,
  /** Absorbed into a 0.3 s stagger -- Big Night, or a group mega. */
  STAGGER: 1,
} as const;
export type KnockdownOutcome = (typeof KNOCKDOWN)[keyof typeof KNOCKDOWN];

/** Big Night's stagger, in seconds. Short enough to be a flinch, not a lockout. */
export const STAGGER_SECONDS = 0.3;

/**
 * Should this knockdown be absorbed?
 *
 * Two talents answer, in this order, and the order matters because only one of
 * them has a cost. `GROUP_NO_KNOCKDOWN` (Cronulla Line, while three of you are
 * together) is unconditional and free, so it answers first and **does not touch
 * the window** -- a player standing in their group should not be spending Big
 * Night's once-per-30-s on knockdowns that were never going to land.
 *
 * Then `FIRST_KNOCKDOWN_IMMUNE_S`: the first knockdown in each window becomes a
 * stagger, and the window opens *when it is spent* rather than on a fixed
 * schedule. "Every 30 s" read as a wall-clock grid would let a player time their
 * fights to the grid; read as a cooldown it means what the tooltip says -- one
 * free one, then thirty seconds.
 *
 * Called on the **authority only**, and that is worth stating: it mutates. The
 * client's prediction calls `fxKnockdownWouldAbsorb` instead, which asks the
 * same question and spends nothing.
 */
export function fxAbsorbKnockdown(playerId: number, nowMs: number): KnockdownOutcome {
  if (lookup.flag(playerId, FX.GROUP_NO_KNOCKDOWN)) return KNOCKDOWN.STAGGER;
  const window = lookup.scalar(playerId, FX.FIRST_KNOCKDOWN_IMMUNE_S);
  if (window <= 0) return KNOCKDOWN.FULL;
  const s = fxState(playerId);
  if (nowMs - s.knockdownWindowMs < window * 1000) return KNOCKDOWN.FULL;
  s.knockdownWindowMs = nowMs;
  return KNOCKDOWN.STAGGER;
}

/** The same question without spending it. For prediction and for the HUD. */
export function fxKnockdownWouldAbsorb(playerId: number, nowMs: number): KnockdownOutcome {
  if (lookup.flag(playerId, FX.GROUP_NO_KNOCKDOWN)) return KNOCKDOWN.STAGGER;
  const window = lookup.scalar(playerId, FX.FIRST_KNOCKDOWN_IMMUNE_S);
  if (window <= 0) return KNOCKDOWN.FULL;
  const s = state.get(playerId);
  if (s === undefined) return KNOCKDOWN.STAGGER;
  return nowMs - s.knockdownWindowMs < window * 1000 ? KNOCKDOWN.FULL : KNOCKDOWN.STAGGER;
}

/** Extra metres of knockback on this player's swings. Cronulla Line's 4 m. */
export function fxKnockbackExtraM(playerId: number): number {
  return lookup.scalar(playerId, FX.GROUP_KNOCKBACK_M);
}

/**
 * Out-of-combat pip regeneration, run once per tick per player on the authority.
 *
 * Returns the pips to hand back this tick, which is 0 on almost every tick and 1
 * on the tick a `REGEN_PIP_S` window completes. Whole pips rather than a
 * fraction, because health is drawn as pips and a bar that creeps is a different
 * mechanic from a pip that arrives.
 *
 * "Out of combat" is eight seconds since this player last dealt or took damage,
 * which the caller reports with `fxNoteCombat`. Eight rather than five because
 * five is inside the length of one exchange -- two players circling each other
 * between swings would both be regenerating.
 *
 * `GROUP_REGEN_X` (Sunday Rush) divides the period rather than multiplying the
 * rate, which is the same thing said in the units the key is in.
 */
export const REGEN_OUT_OF_COMBAT_S = 8;

export function fxRegenTick(playerId: number, dt: number, nowMs: number): number {
  let period = lookup.scalar(playerId, FX.REGEN_PIP_S);
  if (period <= 0) return 0;
  const faster = lookup.scalar(playerId, FX.GROUP_REGEN_X);
  if (faster > 1) period = period / faster;
  const s = fxState(playerId);
  if (nowMs - s.lastCombatMs < REGEN_OUT_OF_COMBAT_S * 1000) {
    s.regenT = 0;
    return 0;
  }
  s.regenT += dt;
  if (s.regenT < period) return 0;
  s.regenT -= period;
  return 1;
}

/** This player just dealt or took damage; the regen clock restarts. */
export function fxNoteCombat(playerId: number, nowMs: number): void {
  const s = fxState(playerId);
  s.lastCombatMs = nowMs;
  s.regenT = 0;
}

/** A KO on a police officer heals `Newtown Standoff` to full. */
export function fxKoOfficerHeals(playerId: number): boolean {
  return lookup.flag(playerId, FX.KO_OFFICER_HEALS);
}
/** A real-estate agent within 10 m of your KO is worth a pip. `Karen Rapport`. */
export function fxAgentCheer(playerId: number): boolean {
  return lookup.flag(playerId, FX.AGENT_CHEER);
}
/** How far an agent has to be to cheer. Not a talent number; the node says 10 m. */
export const AGENT_CHEER_M = 10;

// --- 2. Footy -----------------------------------------------------------------------------

/** Launch speed multiplier. `Long Bomb`'s +25%. */
export function fxThrowSpeedScale(playerId: number): number {
  return 1 + lookup.scalar(playerId, FX.THROW_SPEED);
}
/**
 * Range multiplier, and it is **not** the same as speed.
 *
 * `Set Shot` says "travel 25% further and flatter". Flatter is the whole
 * difference: `footy.LAUNCH_RISE` is the upward component added to the throw, and
 * a ball thrown 25% further on the same arc simply lands 25% further away with
 * the same time of flight, which is not what "flatter" means to anybody. So the
 * range scale raises the speed *and* divides the rise, and `fxThrowRiseScale` is
 * the second half of the pair.
 */
export function fxThrowRangeScale(playerId: number): number {
  return 1 + lookup.scalar(playerId, FX.THROW_RANGE);
}
/** The other half of `fxThrowRangeScale`: a flatter arc is less rise. */
export function fxThrowRiseScale(playerId: number): number {
  const r = lookup.scalar(playerId, FX.THROW_RANGE);
  return r > 0 ? 1 / (1 + r) : 1;
}
/** Seconds per ball returned. `BALL_RECHARGE_S` is absolute and min-wins. */
export function fxBallRechargeS(playerId: number, base: number): number {
  return absMin(playerId, FX.BALL_RECHARGE_S, base);
}
/** Does a returned-serve KO score two kills? `Long Bomb`. */
export function fxReturnServeDouble(playerId: number): boolean {
  return lookup.flag(playerId, FX.RETURN_SERVE_DOUBLE);
}
/**
 * The distance past which this player's footy knocks down rather than staggers,
 * or `Infinity` without the talent.
 *
 * `Infinity` rather than 0 so the call site is `distance >= fxFarHitKnockdownM(id)`
 * and reads the same with and without the talent -- a 0 would knock down every hit.
 */
export function fxFarHitKnockdownM(playerId: number): number {
  const m = lookup.scalar(playerId, FX.FAR_HIT_KNOCKDOWN_M);
  return m > 0 ? m : Infinity;
}

// --- 3. Cars ------------------------------------------------------------------------------

/** How far this player can reach for a car. `Sticky Fingers` 2.2 → 3.2 m. */
export function fxTakeRadiusM(playerId: number, base: number): number {
  return absMax(playerId, FX.TAKE_RADIUS_M, base);
}
/** How fast a car may still be moving and be takeable. 3 → 6 m/s. */
export function fxTakeableSpeed(playerId: number, base: number): number {
  return absMax(playerId, FX.TAKEABLE_SPEED, base);
}
/**
 * Grant `Ute Life` for a while. `Tradie Rates`, on every completed fare.
 *
 * "...if you don't have it" is honoured by *addition* rather than by a test: the
 * granted numbers are the node's own, and a player who already has Ute Life
 * taken would double them, so the two helpers below take the grant only when the
 * talent's own scalar is absent. That reads the same as the tooltip and needs no
 * second question about which node the scalar came from.
 */
export const UTE_LIFE_GRANT_HEALTH = 0.25;
export const UTE_LIFE_GRANT_CRASH = 0.3;

export function fxGrantUteLife(playerId: number, nowMs: number, seconds: number): void {
  if (!(seconds > 0)) return;
  const s = fxState(playerId);
  const until = nowMs + seconds * 1000;
  if (until > s.uteLifeUntilMs) s.uteLifeUntilMs = until;
}
/** Is the granted window open? Compared against the tick clock. See `fxSetNow`. */
function uteLifeGranted(playerId: number): boolean {
  const s = state.get(playerId);
  return s !== undefined && tickNowMs > 0 && tickNowMs < s.uteLifeUntilMs;
}

/** Multiplier on a car's maximum condition while this player drives it. */
export function fxCarHealthScale(playerId: number): number {
  const own = lookup.scalar(playerId, FX.CAR_HEALTH);
  if (own > 0) return 1 + own;
  return uteLifeGranted(playerId) ? 1 + UTE_LIFE_GRANT_HEALTH : 1;
}
/** Multiplier on crash damage to this player's car. `Ute Life`'s −30%. */
export function fxCrashDamageScale(playerId: number): number {
  let reduction = lookup.scalar(playerId, FX.CRASH_DAMAGE_TAKEN);
  if (reduction <= 0 && uteLifeGranted(playerId)) reduction = UTE_LIFE_GRANT_CRASH;
  const scale = 1 - reduction;
  return scale < 0 ? 0 : scale > 1 ? 1 : scale;
}
/**
 * The single multiplier `driving.CarField.damage` puts on an impact.
 *
 * Both car keys, folded into one number, and the folding is the point: "+25%
 * health" and "−30% crash damage" are two ways of saying the same thing to a
 * health bar that is fixed at 0..100 on the wire (`protocol.CAR_HEALTH_FULL`).
 * Raising the *ceiling* would mean re-scaling every reader of that byte -- the
 * dent grade, the smoke thresholds, the HUD -- for a talent; dividing the
 * *damage* by the same factor is arithmetically identical from the driver's seat
 * and touches one line. A `Ute Life` car therefore survives 1.25 / 0.7 = 1.79
 * times as much wall as a stock one, which is what its two clauses add up to.
 */
export function fxCarDamageScale(driverId: number): number {
  return fxCrashDamageScale(driverId) / fxCarHealthScale(driverId);
}

/** Seconds between two crashes counting. Absolute, min-wins. */
export function fxCrashCooldownS(playerId: number, base: number): number {
  return absMin(playerId, FX.CRASH_COOLDOWN_S, base);
}
/** m/s a written-off car can still limp at, or 0. `Ute Life`'s 6. */
export function fxWreckLimpSpeed(playerId: number): number {
  return lookup.scalar(playerId, FX.WRECK_LIMP_MS);
}
/** How far ambient traffic holds behind this player's car. Absolute, max-wins. */
export function fxTrafficHoldGapM(playerId: number, base: number): number {
  return absMax(playerId, FX.TRAFFIC_HOLD_GAP_M, base);
}
/** Is this player's parked car exempt from the recycler? `Park Anywhere`. */
export function fxCarNeverRecycles(playerId: number): boolean {
  return lookup.flag(playerId, FX.CAR_NEVER_RECYCLES);
}
/** How far a car snaps into a bay when this player leaves it. Absolute, max-wins. */
export function fxParkSnapM(playerId: number, base: number): number {
  return absMax(playerId, FX.PARK_SNAP_M, base);
}
/** Can highway patrol ram this player? `Right of Way` / `Sirens Are Music` say no. */
export function fxPatrolCannotRam(playerId: number): boolean {
  return lookup.flag(playerId, FX.PATROL_CANNOT_RAM);
}
/** Do passengers in this driver's car take crash damage? `Convoy` / `Rat Run`. */
export function fxPassengersSafe(driverId: number): boolean {
  return lookup.flag(driverId, FX.PASSENGERS_SAFE);
}

/**
 * `RAM` (Northern Beaches Tunnel): the two halves of "your car is a battering
 * ram", as two functions because two different call sites ask.
 *
 * The tooltip: "crashes at 10 m/s+ knock down every non-DeFAULT within 3 m of
 * the impact and cost you nothing under 20 m/s".
 */
export const RAM_KNOCKDOWN_SPEED = 10;
export const RAM_KNOCKDOWN_M = 3;
export const RAM_FREE_SPEED = 20;

/** Does a crash at `speed` m/s knock people down around this driver? */
export function fxRamKnocksDown(playerId: number, speed: number): boolean {
  if (!lookup.flag(playerId, FX.RAM)) return false;
  return (speed < 0 ? -speed : speed) >= RAM_KNOCKDOWN_SPEED;
}
/** Is this crash free to the car? Ram pays nothing under 20 m/s. */
export function fxRamFreeCrash(playerId: number, speed: number): boolean {
  if (!lookup.flag(playerId, FX.RAM)) return false;
  return (speed < 0 ? -speed : speed) < RAM_FREE_SPEED;
}

/**
 * Why `taker` may not take a car that `owner` left, or `''` if they may.
 *
 * `Park Anywhere`: "a car you leave ... is never takeable by Marita". Written as
 * a refusal string rather than a boolean because that is what the HUD wants and
 * because the string is the one place the other team is *named* -- through
 * `TEAM_NAME`, never a literal, which is the contract's standing rule and what
 * `verifyTeamFx` greps for.
 *
 * A car left by somebody with no team, or taken by somebody on the same side, or
 * taken by its own owner, is takeable. `TEAM.NONE` on either end means the
 * framework has not landed or the taker is a guest, and a lock that fired on a
 * guest would make the feature look broken to everybody who has not signed up.
 */
export function fxCarTakeRefusal(takerId: number, ownerId: number): string {
  if (takerId === ownerId) return '';
  if (!lookup.flag(ownerId, FX.CAR_TEAM_LOCK)) return '';
  const ownerTeam = lookup.teamOf(ownerId);
  const takerTeam = lookup.teamOf(takerId);
  if (ownerTeam === TEAM.NONE || takerTeam === TEAM.NONE) return '';
  if (ownerTeam === takerTeam) return '';
  return `${TEAM_NAME[ownerTeam]} car. locked.`;
}

// --- 4. Heat, police and the NPCs -----------------------------------------------------------

/**
 * Start this player's Ghost Plates window, if they have it. Called when a car is
 * stolen; `fxTheftReported` is the question the crime path then asks.
 */
export function fxNoteCarStolen(playerId: number, nowMs: number): void {
  const seconds = lookup.scalar(playerId, FX.HEAT_ON_STEAL_S);
  if (seconds <= 0) return;
  fxState(playerId).ghostPlatesUntilMs = nowMs + seconds * 1000;
}
/**
 * Should this theft be reported? False inside the Ghost Plates window.
 *
 * "...unless you hit somebody" is the tooltip's other half, and it is the
 * caller's: `fxBreakGhostPlates` is called from the same place `HIT` is emitted.
 */
export function fxTheftReported(playerId: number, nowMs: number): boolean {
  const s = state.get(playerId);
  if (s === undefined) return true;
  return nowMs >= s.ghostPlatesUntilMs;
}
/** You hit somebody. The plates are no longer ghosts. */
export function fxBreakGhostPlates(playerId: number): void {
  const s = state.get(playerId);
  if (s !== undefined) s.ghostPlatesUntilMs = 0;
}

/**
 * Freeze this player's heat for a while. `Cash Rules`' summoned ride.
 *
 * A window rather than a flag, and it is checked in `heat.HeatField.report` --
 * the one funnel every crime in the game passes through -- rather than at the
 * dozen places a crime is reported. Nothing *sheds* during it either way; the
 * ladder's own decay is unchanged. Frozen means new crimes do not land.
 */
export function fxFreezeHeat(playerId: number, nowMs: number, seconds: number): void {
  if (!(seconds > 0)) return;
  const s = fxState(playerId);
  const until = nowMs + seconds * 1000;
  if (until > s.heatFrozenUntilMs) s.heatFrozenUntilMs = until;
}
/** Is this player's heat frozen right now? Compared against the tick clock. */
export function fxHeatFrozen(playerId: number): boolean {
  const s = state.get(playerId);
  return s !== undefined && tickNowMs > 0 && tickNowMs < s.heatFrozenUntilMs;
}

/** Highway patrol's pursuit range against this player. Absolute, min-wins. */
export function fxPatrolRangeM(playerId: number, base: number): number {
  return absMin(playerId, FX.PATROL_RANGE_M, base);
}
/** Does boarding a train shed a star instantly? `Opal Hop`. */
export function fxBoardShedsStar(playerId: number): boolean {
  return lookup.flag(playerId, FX.BOARD_SHEDS_STAR);
}
/** Multiplier on Polair's lock-acquire time. Absolute-ish, max-wins, ≥ 1. */
export function fxPolairLockScale(playerId: number): number {
  const s = lookup.scalar(playerId, FX.POLAIR_LOCK_SLOW);
  return s > 1 ? s : 1;
}

/**
 * The multiplier on a police shot's chance of *hitting* this player.
 *
 * `Blue Line` carries `POLICE_MISS = 0.5` and reads "police shots against you
 * miss 2× as often". There are two arithmetics behind that sentence and only one
 * of them survives stacking: doubling the *miss* probability overflows past 1
 * for any base hit chance under 50% and is undefined for two Blue Lines, while
 * turning half the shots that *would have hit* into misses is well-defined,
 * composes, and is the same number at the 15 m engagement range the police model
 * is tuned around (`factions.hitChance` gives 0.55 there, so a miss goes 45% →
 * 72.5% and the hit halves). This file takes the second reading, floors the
 * scale at 0.05 so a stack cannot make the police literally harmless, and says
 * so here because it is the one place a tooltip and the code disagree by a word.
 */
export function fxPoliceHitScale(playerId: number): number {
  const miss = lookup.scalar(playerId, FX.POLICE_MISS);
  if (miss <= 0) return 1;
  const scale = 1 - miss;
  return scale < 0.05 ? 0.05 : scale;
}

/** Seconds of standing still an RBT arrest takes. Absolute, max-wins. */
export function fxRbtStandS(playerId: number, base: number): number {
  return absMax(playerId, FX.RBT_STAND_S, base);
}
/** Can this player simply drive through an RBT for a pip? `Blue Line`. */
export function fxRbtImmune(playerId: number): boolean {
  return lookup.flag(playerId, FX.RBT_IMMUNE);
}
/**
 * Should RBTs be drawn on this player's minimap, and set further ahead?
 *
 * `Toll Dodger`: "RBTs are set 300 m ahead instead of 150 and show on your
 * minimap". The distance is `fxRbtAheadM`; this flag is the marker source the
 * minimap draw reads -- the draw itself is the renderer workstream's or one
 * `for` loop, and either way it should be asking this rather than a talent id.
 */
export function fxRbtMinimap(playerId: number): boolean {
  return lookup.flag(playerId, FX.RBT_MINIMAP);
}
/** How far ahead an RBT is set for this player. Doubled by `Toll Dodger`. */
export function fxRbtAheadM(playerId: number, base: number): number {
  return lookup.flag(playerId, FX.RBT_MINIMAP) ? base * 2 : base;
}

/** The star count highway patrol should treat this player as having. */
export function fxHeatTreatStars(playerId: number, stars: number): number {
  const lower = lookup.scalar(playerId, FX.HEAT_TREAT_LOWER);
  if (lower <= 0) return stars;
  const s = stars - lower;
  return s < 0 ? 0 : s;
}

/** Do Karens ever report this player? `Karen Rapport` says never. */
export function fxKarenImmune(playerId: number): boolean {
  return lookup.flag(playerId, FX.KAREN_IMMUNE);
}
/**
 * Does a Karen at `distance` metres report this player's car theft?
 *
 * `Sticky Fingers`: "Karens only report your steals if they saw your face
 * (within 8 m)". Immunity wins outright; otherwise the 8 m gate.
 */
export const KAREN_FACE_M = 8;
export function fxKarenReportsSteal(playerId: number, distanceM: number): boolean {
  if (lookup.flag(playerId, FX.KAREN_IMMUNE)) return false;
  if (!lookup.flag(playerId, FX.KAREN_UNWITNESSED_STEAL)) return true;
  return distanceM <= KAREN_FACE_M;
}
/** Do meth heads and drunks fight for this player? `Meth-adone`. */
export function fxMethheadAlly(playerId: number): boolean {
  return lookup.flag(playerId, FX.METHHEAD_ALLY);
}
/** Do tradies leave this player alone? `Tradie Rates`. */
export function fxTradieAlly(playerId: number): boolean {
  return lookup.flag(playerId, FX.TRADIE_ALLY);
}
/** Must every officer within 40 m shoot only this player? `Newtown Standoff`. */
export function fxPoliceFocus(playerId: number): boolean {
  return lookup.flag(playerId, FX.POLICE_FOCUS);
}
/** How far the focus reaches. The mega's tooltip; not a talent number. */
export const POLICE_FOCUS_M = 40;
/** The star count above which the two "while 3★+" megas are live. */
export const MEGA_STAR_GATE = 3;

/** Enemies within this many metres show on the minimap through walls, or 0. */
export function fxEnemyMinimapM(playerId: number): number {
  return lookup.scalar(playerId, FX.ENEMY_MINIMAP_M);
}

// --- 5. Cash ---------------------------------------------------------------------------------

/** What Centrelink pays this player. Absolute, max-wins. */
export function fxCentrelinkAmount(playerId: number, base: number): number {
  return absMax(playerId, FX.CENTRELINK_AMOUNT, base);
}
/** How many in-game days between claims. Absolute, min-wins. */
export function fxCentrelinkDays(playerId: number, baseDays: number): number {
  return absMin(playerId, FX.CENTRELINK_DAYS, baseDays);
}
/** What a teammate's nearby claim pays this player. `Click & Collect`'s $20. */
export function fxCentrelinkNearby(playerId: number): number {
  return lookup.scalar(playerId, FX.CENTRELINK_NEARBY);
}
/** How near "nearby" is for the above. The node says 200 m. */
export const CENTRELINK_NEARBY_M = 200;

/** Multiplier on an NPC cash drop. `DROP_BONUS` sums across nodes and auras. */
export function fxDropScale(playerId: number): number {
  return 1 + lookup.scalar(playerId, FX.DROP_BONUS);
}

/**
 * The fraction of this player's wallet that hits the pavement on a KO.
 *
 * The one key where 0 from the lookup is ambiguous -- see the header's
 * absent-key note for why the second question is asked and why it is asked in
 * terms of FX keys rather than talent names.
 */
export function fxDeathDropFraction(playerId: number, base: number): number {
  const s = lookup.scalar(playerId, FX.DEATH_DROP);
  if (s > 0) return s < base ? s : base;
  if (lookup.scalar(playerId, FX.RESPAWN_PIPS) > 0) return 0;
  if (lookup.flag(playerId, FX.CASH_IS_STATS)) return 0;
  return base;
}

/** Is this player's death drop booby-trapped? `Loan Shark`. */
export function fxDropTrap(playerId: number): boolean {
  return lookup.flag(playerId, FX.DROP_TRAP);
}
/** What the trap costs a picker-up from the other side, and pays the owner. */
export const DROP_TRAP_DOLLARS = 20;
export const DROP_TRAP_PIPS = 1;

/**
 * The multiplier on a fare, given the day/night phase it was completed in.
 *
 * Two keys, and they are two different windows rather than one with a sign:
 * `FARE_NIGHT` is sunset→sunrise (Marita's `Surge`) and `FARE_DAY` is
 * sunrise→15:00 (DeFAULT's `Tradie Rates`). A player cannot have both -- they
 * are on different teams -- but the arithmetic adds rather than picks, because a
 * rule about which wins is a rule somebody has to remember and the sum is
 * correct for the case that cannot happen anyway.
 *
 * `phase` is `sky/cycle.cyclePhase`'s 0..1. `SUNRISE_PHASE` 0.25 and
 * `SUNSET_PHASE` 0.75 are that module's, restated as parameters rather than
 * imported so this file stays free of the sky.
 */
export function fxFareScale(playerId: number, phase: number, sunrise = 0.25, sunset = 0.75): number {
  let scale = 1;
  const night = lookup.scalar(playerId, FX.FARE_NIGHT);
  if (night !== 0 && (phase >= sunset || phase < sunrise)) scale += night;
  const day = lookup.scalar(playerId, FX.FARE_DAY);
  // "sunrise to 15:00 game time". 15:00 is 0.625 of a day, which sits between
  // the two constants above and is therefore written as arithmetic on them
  // rather than as a third magic number: sunrise + 3/8 of a cycle.
  if (day !== 0 && phase >= sunrise && phase < sunrise + 0.375) scale += day;
  // Everything earned goes up by the collective's cut as well. `TEAM_EARN` is an
  // aura the framework already stacked and capped at 3 (`Tip Jar`).
  scale += lookup.scalar(playerId, FX.TEAM_EARN);
  return scale;
}

/** The pickup radius for this player's SydRide offers. Absolute, max-wins. */
export function fxFareRadiusM(playerId: number, base: number): number {
  return absMax(playerId, FX.FARE_RADIUS_M, base);
}
/** The tip a quick fare earns, in dollars. `Surge`'s $10. */
export function fxFareTip(playerId: number): number {
  return lookup.scalar(playerId, FX.FARE_TIP);
}
/** Seconds of granted Ute Life after a completed fare. `Tradie Rates`' 30. */
export function fxFareUteLifeS(playerId: number): number {
  return lookup.scalar(playerId, FX.FARE_UTE_LIFE_S);
}
/**
 * The multiplier on everything *else* a player earns -- drops, Centrelink.
 *
 * The same `TEAM_EARN` term `fxFareScale` folds in, exposed on its own for the
 * two income paths that have no day/night phase to ask about.
 */
export function fxEarnScale(playerId: number): number {
  return 1 + lookup.scalar(playerId, FX.TEAM_EARN);
}
/** The fraction of a teammate's earnings this player is owed. `Tip Jar`'s 10%. */
export function fxTeamTithe(playerId: number): number {
  return lookup.scalar(playerId, FX.TEAM_TITHE);
}

// --- Self-check -------------------------------------------------------------------------------

/**
 * A `TeamLookup` that answers from a plain table. The fixture every case below
 * uses, and exported because `server/cardamage-check.ts` and
 * `server/take-check.ts` need the same thing against the real world.
 *
 * Deliberately **not** built from `NODES` and a mask: this file's job is to turn
 * a scalar into a game number, and a fixture that went through the real talent
 * tree would fail for reasons that belong to `verifyTeams`. The mask arithmetic
 * has its own check there.
 */
export function fakeTeamLookup(
  scalars: Partial<Record<FxKey, number>>,
  team: Team = TEAM.MARITA,
  only?: number,
): TeamLookup {
  const table = scalars as Record<string, number | undefined>;
  const mine = (id: number) => only === undefined || id === only;
  return {
    teamOf: (id) => (mine(id) ? team : TEAM.NONE),
    scalar: (id, key) => (mine(id) ? table[key] ?? 0 : 0),
    flag: (id, key) => (mine(id) ? (table[key] ?? 0) > 0 : false),
  };
}

export function verifyTeamFx(): string[] {
  const bad: string[] = [];
  const saveLookup = lookup;
  const saveStars = starsReader;
  const saveWallet = walletReader;
  const saveState = new Map(state);
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  try {
    // --- Nothing installed: every helper is its base. The property that lets
    //     `verifyCombat`, `verifyDriving` and `verifyCash` pass unchanged.
    resetTeamFx();
    if (fxMaxPips(1, 3) !== 3) bad.push('With no lookup, max pips moved off the base.');
    if (fxSwingDamageScale(1) !== 1) bad.push('With no lookup, swing damage is not x1.');
    if (fxDamageTakenScale(1) !== 1) bad.push('With no lookup, damage taken is not x1.');
    if (fxTakeRadiusM(1, 2.2) !== 2.2) bad.push('With no lookup, the take radius moved.');
    if (fxBallRechargeS(1, 1.6) !== 1.6) bad.push('With no lookup, the ball recharge moved.');
    if (fxDeathDropFraction(1, 0.1) !== 0.1) bad.push('With no lookup, the death drop moved.');
    if (fxFareScale(1, 0.9) !== 1) bad.push('With no lookup, a night fare is not x1.');
    if (fxAbsorbKnockdown(1, 0) !== KNOCKDOWN.FULL) bad.push('With no lookup, a knockdown was absorbed.');
    if (fxCarTakeRefusal(1, 2) !== '') bad.push('With no lookup, a car take was refused.');
    if (fxFarHitKnockdownM(1) !== Infinity) bad.push('With no lookup, a far footy hit knocks down.');

    // --- Swing damage +20% changes the damage number, and stacks with a star
    //     ladder and with cash exactly once each.
    setTeamLookup(fakeTeamLookup({ [FX.SWING_DAMAGE]: 0.2 }));
    if (!near(fxSwingDamageScale(1), 1.2)) {
      bad.push(`+20% swing damage gave x${fxSwingDamageScale(1)}, not x1.2.`);
    }
    setTeamLookup(fakeTeamLookup({ [FX.STAR_DAMAGE]: 0.06 }));
    setStarsReader(() => 5);
    if (!near(fxSwingDamageScale(1), 1.3)) {
      bad.push(`Sirens Are Music at 5 stars gave x${fxSwingDamageScale(1)}, not x1.3.`);
    }
    setStarsReader(null);
    setTeamLookup(fakeTeamLookup({ [FX.CASH_IS_STATS]: 1 }));
    setWalletReader(() => 700);
    if (fxCashStatPercent(1) !== 14) bad.push(`$700 is ${fxCashStatPercent(1)}%, not 14%.`);
    if (!near(fxSwingDamageScale(1), 1.14)) bad.push('Cash Rules did not reach swing damage.');
    if (!near(fxDamageTakenScale(1), 0.86)) bad.push('Cash Rules did not reach armour.');
    setWalletReader(() => 5000);
    if (fxCashStatPercent(1) !== 20) bad.push(`$5,000 is ${fxCashStatPercent(1)}%, not the 20% cap.`);
    setWalletReader(null);

    // --- Armour, floored rather than allowed to reach zero.
    setTeamLookup(fakeTeamLookup({ [FX.DAMAGE_TAKEN]: 0.3 }));
    if (!near(fxDamageTakenScale(1), 0.7)) bad.push('−30% damage taken is not a x0.7 multiplier.');
    setTeamLookup(fakeTeamLookup({ [FX.DAMAGE_TAKEN]: 2 }));
    if (fxDamageTakenScale(1) !== 0.05) bad.push('Stacked armour was not floored at 0.05.');

    // --- Max pips 3 → 4 with Big Night, → 5 in a Sunday Rush group.
    setTeamLookup(fakeTeamLookup({ [FX.MAX_PIPS]: 1 }));
    if (fxMaxPips(1, 3) !== 4) bad.push(`Big Night gave ${fxMaxPips(1, 3)} pips, not 4.`);
    setTeamLookup(fakeTeamLookup({ [FX.MAX_PIPS]: 1, [FX.GROUP_PIPS]: 1 }));
    if (fxMaxPips(1, 3) !== 5) bad.push('Big Night plus a group did not reach 5 pips.');

    // --- The first knockdown in the window is a stagger and the second is not,
    //     and the window is per player rather than global.
    setTeamLookup(fakeTeamLookup({ [FX.FIRST_KNOCKDOWN_IMMUNE_S]: 30 }));
    state.clear();
    if (fxAbsorbKnockdown(7, 1_000) !== KNOCKDOWN.STAGGER) bad.push('The first knockdown was not absorbed.');
    if (fxAbsorbKnockdown(7, 2_000) !== KNOCKDOWN.FULL) bad.push('A second knockdown 1 s later was absorbed.');
    if (fxAbsorbKnockdown(8, 2_000) !== KNOCKDOWN.STAGGER) {
      bad.push('The immunity window is shared between players; it must be per player.');
    }
    if (fxAbsorbKnockdown(7, 30_999) !== KNOCKDOWN.FULL) bad.push('The window reopened before 30 s.');
    if (fxAbsorbKnockdown(7, 31_001) !== KNOCKDOWN.STAGGER) bad.push('The window did not reopen after 30 s.');
    // And the group mega, which absorbs without ever spending the window.
    setTeamLookup(fakeTeamLookup({ [FX.FIRST_KNOCKDOWN_IMMUNE_S]: 30, [FX.GROUP_NO_KNOCKDOWN]: 1 }));
    state.clear();
    for (let i = 0; i < 5; i++) {
      if (fxAbsorbKnockdown(9, i * 100) !== KNOCKDOWN.STAGGER) bad.push('A group knockdown was not absorbed.');
    }
    if (fxKnockdownWouldAbsorb(9, 600) !== KNOCKDOWN.STAGGER) bad.push('The group absorb spent the window.');

    // --- Respawn in place, once per five minutes.
    setTeamLookup(fakeTeamLookup({ [FX.RESPAWN_IN_PLACE_CD_S]: 300 }));
    state.clear();
    if (!fxTakeRespawnInPlace(3, 0)) bad.push('The first respawn in place was refused.');
    if (fxTakeRespawnInPlace(3, 299_000)) bad.push('A second respawn in place inside 5 min was allowed.');
    if (!fxTakeRespawnInPlace(3, 301_000)) bad.push('The respawn-in-place cooldown did not expire.');

    // --- Regeneration: one pip per period, and only out of combat.
    setTeamLookup(fakeTeamLookup({ [FX.REGEN_PIP_S]: 20 }));
    state.clear();
    fxNoteCombat(4, 0);
    let pips = 0;
    for (let i = 1; i <= 60 * 30; i++) pips += fxRegenTick(4, 1 / 60, (i * 1000) / 60);
    // 30 s of ticks, the first 8 of which are in combat: one pip at t = 28 s.
    if (pips !== 1) bad.push(`Out of combat for 30 s regenerated ${pips} pips, not 1.`);
    state.clear();
    let inFight = 0;
    for (let i = 1; i <= 60 * 30; i++) {
      fxNoteCombat(5, (i * 1000) / 60);
      inFight += fxRegenTick(5, 1 / 60, (i * 1000) / 60);
    }
    if (inFight !== 0) bad.push(`A player in constant combat regenerated ${inFight} pips.`);

    // --- Take radius 3.2 takes at 3.0 m and refuses at 3.3.
    setTeamLookup(fakeTeamLookup({ [FX.TAKE_RADIUS_M]: 3.2, [FX.TAKEABLE_SPEED]: 6 }));
    const r = fxTakeRadiusM(1, 2.2);
    if (r !== 3.2) bad.push(`Sticky Fingers gave a take radius of ${r}, not 3.2.`);
    if (!(3.0 <= r)) bad.push('A car at 3.0 m was out of reach with Sticky Fingers.');
    if (3.3 <= r) bad.push('A car at 3.3 m was in reach with Sticky Fingers; the radius is 3.2.');
    if (fxTakeableSpeed(1, 3) !== 6) bad.push('Sticky Fingers did not raise the takeable speed to 6.');
    // A talent never *lowers* an absolute the base already beats.
    if (fxTakeRadiusM(1, 4) !== 4) bad.push('A 3.2 m talent lowered a 4 m base radius.');

    // --- The car team lock, and the name in its refusal.
    // Two sides, by hand: 2 is a DeFAULT who has taken Park Anywhere, 1 is a
    // Marita who has not. `fakeTeamLookup` cannot express that -- it is one
    // table for one player -- and the lock is the one hook whose answer depends
    // on *both* parties, which is exactly what needs asserting.
    setTeamLookup({
      teamOf: (id) => (id === 2 ? TEAM.DEFAULT : id === 1 ? TEAM.MARITA : TEAM.NONE),
      scalar: (id, key) => (id === 2 && key === FX.CAR_TEAM_LOCK ? 1 : 0),
      flag: (id, key) => id === 2 && key === FX.CAR_TEAM_LOCK,
    });
    const refusal = fxCarTakeRefusal(1, 2);
    if (refusal === '') bad.push('A DeFAULT-locked car was takeable by somebody with no team.');
    else if (!refusal.includes(TEAM_NAME[TEAM.DEFAULT])) {
      bad.push(`The lock refusal "${refusal}" does not name the team through TEAM_NAME.`);
    }
    if (fxCarTakeRefusal(2, 2) !== '') bad.push('The owner could not take their own locked car.');
    if (fxCarTakeRefusal(3, 2) !== '') bad.push('A guest was refused a locked car; the lock must not fire on TEAM.NONE.');

    // --- Ute Life: −30% crash damage, and the cooldown floor.
    setTeamLookup(fakeTeamLookup({ [FX.CRASH_DAMAGE_TAKEN]: 0.3, [FX.CRASH_COOLDOWN_S]: 0.3, [FX.CAR_HEALTH]: 0.25 }));
    if (!near(fxCrashDamageScale(1), 0.7)) bad.push('Ute Life is not a x0.7 on crash damage.');
    if (!near(fxCrashCooldownS(1, 0.5), 0.3)) bad.push('Ute Life did not shorten the crash cooldown.');
    if (!near(fxCarHealthScale(1), 1.25)) bad.push('Ute Life is not +25% car health.');

    // --- RAM: within 3 m at 10 m/s and not at 9.
    setTeamLookup(fakeTeamLookup({ [FX.RAM]: 1 }));
    if (!fxRamKnocksDown(1, 10)) bad.push('RAM did not knock down at 10 m/s.');
    if (!fxRamKnocksDown(1, 12)) bad.push('RAM did not knock down at 12 m/s.');
    if (fxRamKnocksDown(1, 9)) bad.push('RAM knocked down at 9 m/s; the gate is 10.');
    if (RAM_KNOCKDOWN_M !== 3) bad.push(`RAM's radius is ${RAM_KNOCKDOWN_M} m, not the tooltip's 3.`);
    if (!fxRamFreeCrash(1, 19)) bad.push('A 19 m/s ram was not free.');
    if (fxRamFreeCrash(1, 21)) bad.push('A 21 m/s ram was free; the tooltip caps it at 20.');
    setTeamLookup(NO_TEAMS);
    if (fxRamKnocksDown(1, 30)) bad.push('A player without the mega rammed anyway.');

    // --- Police miss doubles: the hit chance halves.
    setTeamLookup(fakeTeamLookup({ [FX.POLICE_MISS]: 0.5 }));
    if (!near(fxPoliceHitScale(1), 0.5)) {
      bad.push(`Blue Line gave a hit scale of ${fxPoliceHitScale(1)}, not 0.5.`);
    }
    setTeamLookup(fakeTeamLookup({ [FX.POLICE_MISS]: 3 }));
    if (fxPoliceHitScale(1) !== 0.05) bad.push('A stacked miss chance was not floored at 0.05.');

    // --- Heat treated lower, and never below zero.
    setTeamLookup(fakeTeamLookup({ [FX.HEAT_TREAT_LOWER]: 1 }));
    if (fxHeatTreatStars(1, 4) !== 3) bad.push('Blue Line did not lower the treated star count.');
    if (fxHeatTreatStars(1, 0) !== 0) bad.push('A treated star count went below zero.');

    // --- Ghost Plates: a theft inside the window is not reported, and hitting
    //     somebody ends it.
    setTeamLookup(fakeTeamLookup({ [FX.HEAT_ON_STEAL_S]: 60 }));
    state.clear();
    fxNoteCarStolen(6, 1_000);
    if (fxTheftReported(6, 30_000)) bad.push('A theft 29 s into Ghost Plates was reported.');
    if (!fxTheftReported(6, 62_000)) bad.push('Ghost Plates did not expire after 60 s.');
    fxNoteCarStolen(6, 100_000);
    fxBreakGhostPlates(6);
    if (!fxTheftReported(6, 101_000)) bad.push('Hitting somebody did not break Ghost Plates.');

    // --- Karens: the 8 m face rule, and outright immunity.
    setTeamLookup(fakeTeamLookup({ [FX.KAREN_UNWITNESSED_STEAL]: 1 }));
    if (fxKarenReportsSteal(1, 12)) bad.push('A Karen at 12 m reported a Sticky Fingers steal.');
    if (!fxKarenReportsSteal(1, 6)) bad.push('A Karen at 6 m did not report a steal; the gate is 8 m.');
    setTeamLookup(fakeTeamLookup({ [FX.KAREN_IMMUNE]: 1 }));
    if (fxKarenReportsSteal(1, 1)) bad.push('Karen Rapport did not stop a report at 1 m.');

    // --- Centrelink: $150 every 6 days.
    setTeamLookup(fakeTeamLookup({ [FX.CENTRELINK_AMOUNT]: 150, [FX.CENTRELINK_DAYS]: 6 }));
    if (fxCentrelinkAmount(1, 100) !== 150) bad.push('Tap On did not raise Centrelink to $150.');
    if (fxCentrelinkDays(1, 7) !== 6) bad.push('Tap On did not shorten the Centrelink period to 6 days.');
    setTeamLookup(fakeTeamLookup({ [FX.CENTRELINK_DAYS]: 5 }));
    if (fxCentrelinkAmount(1, 100) !== 100) bad.push('Click & Collect changed the Centrelink amount.');
    if (fxCentrelinkDays(1, 7) !== 5) bad.push('Click & Collect did not shorten the period to 5 days.');

    // --- The death drop, including the two nodes that mean a real zero.
    setTeamLookup(fakeTeamLookup({ [FX.DEATH_DROP]: 0.05 }));
    if (!near(fxDeathDropFraction(1, 0.1), 0.05)) bad.push('Tap On did not halve the death drop.');
    setTeamLookup(fakeTeamLookup({ [FX.DEATH_DROP]: 0, [FX.RESPAWN_PIPS]: 2 }));
    if (fxDeathDropFraction(1, 0.1) !== 0) bad.push('Warranty still dropped cash on death.');
    setTeamLookup(fakeTeamLookup({ [FX.DEATH_DROP]: 0, [FX.CASH_IS_STATS]: 1 }));
    if (fxDeathDropFraction(1, 0.1) !== 0) bad.push('Cash Rules still dropped cash on death.');

    // --- Fares: +40% at night and *only* at night.
    setTeamLookup(fakeTeamLookup({ [FX.FARE_NIGHT]: 0.4 }));
    if (!near(fxFareScale(1, 0.8), 1.4)) bad.push(`A fare just after sunset paid x${fxFareScale(1, 0.8)}, not x1.4.`);
    if (!near(fxFareScale(1, 0.05), 1.4)) bad.push('A fare before sunrise did not get the night bonus.');
    if (!near(fxFareScale(1, 0.5), 1)) bad.push('A fare at midday got the night bonus.');
    if (!near(fxFareScale(1, 0.25), 1)) bad.push('A fare exactly at sunrise got the night bonus.');
    setTeamLookup(fakeTeamLookup({ [FX.FARE_DAY]: 0.25 }, TEAM.DEFAULT));
    if (!near(fxFareScale(1, 0.3), 1.25)) bad.push('A morning fare did not get Tradie Rates.');
    if (!near(fxFareScale(1, 0.7), 1)) bad.push('A 4 pm fare got Tradie Rates; the window ends at 15:00.');
    if (!near(fxFareScale(1, 0.9), 1)) bad.push('A night fare got Tradie Rates.');

    // --- Throw speed and the flatter arc.
    setTeamLookup(fakeTeamLookup({ [FX.THROW_SPEED]: 0.25 }));
    if (!near(fxThrowSpeedScale(1), 1.25)) bad.push('Long Bomb is not +25% throw speed.');
    if (!near(fxThrowRiseScale(1), 1)) bad.push('Long Bomb flattened the arc; only Set Shot does.');
    setTeamLookup(fakeTeamLookup({ [FX.THROW_RANGE]: 0.25 }));
    if (!near(fxThrowRangeScale(1), 1.25)) bad.push('Set Shot is not +25% range.');
    if (!near(fxThrowRiseScale(1), 0.8)) bad.push('Set Shot did not flatten the arc.');
    setTeamLookup(fakeTeamLookup({ [FX.FAR_HIT_KNOCKDOWN_M]: 20 }));
    if (fxFarHitKnockdownM(1) !== 20) bad.push('Set Shot did not set the far-hit knockdown at 20 m.');

    // --- Nothing in this file is a speed buff. The owner's standing rule, and
    //     the cheapest possible place to keep checking it: `game/teams.ts`
    //     guards the *data*, and this guards the *hooks*, because a helper
    //     called `fxSprintScale` would sail past that check entirely.
    const speedy = ['fxSprint', 'fxRunSpeed', 'fxTopSpeed', 'fxMoveSpeed', 'fxWalkSpeed'];
    for (const name of speedy) {
      if (name in (globalThis as Record<string, unknown>)) bad.push(`${name} exists; the owner dislikes speed buffs.`);
    }

    // --- The clocks are bounded by the room.
    state.clear();
    setTeamLookup(fakeTeamLookup({ [FX.FIRST_KNOCKDOWN_IMMUNE_S]: 30 }));
    for (let i = 0; i < 16; i++) fxAbsorbKnockdown(i, 0);
    if (fxTrackedPlayers() !== 16) bad.push(`16 players left ${fxTrackedPlayers()} clock records.`);
    for (let i = 0; i < 16; i++) forgetPlayer(i);
    if (fxTrackedPlayers() !== 0) bad.push('forgetPlayer did not clear the clocks.');

    // --- The two constants the contract owns are still the ones the hooks assume.
    if (AURA_M !== 12) bad.push(`AURA_M is ${AURA_M}; every aura tooltip says 12 m.`);
    if (GROUP_M !== 20) bad.push(`GROUP_M is ${GROUP_M}; every group tooltip says 20 m.`);
  } finally {
    lookup = saveLookup;
    starsReader = saveStars;
    walletReader = saveWallet;
    state.clear();
    for (const [k, v] of saveState) state.set(k, v);
  }
  return bad;
}
