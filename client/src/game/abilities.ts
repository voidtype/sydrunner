/**
 * The talent abilities: the four buttons, their cooldowns, and their windows.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FILE FROM `game/teamfx.ts`.
 *
 * Everything in `teamfx.ts` is a *stat*: something asks "how much damage does
 * this swing do" and a talent bends the answer. Nothing there has a button, a
 * cooldown or a duration, and nothing there can be *refused*.
 *
 * These ten things are the opposite of that. Each is pressed, each can fail
 * ("still on cooldown", "not enough cash", "already used today"), each has a
 * window during which the world behaves differently, and three of them cost
 * money. That is a table with a state machine on it, and the readers are
 * different too: `teamfx` is read by nine subsystems on every tick and this is
 * read by one input handler on a rising edge.
 *
 * ---------------------------------------------------------------------------
 * THE BUTTONS, and what each one means depending on your tree.
 *
 *   V  `DASH` (Marita, Bolt) or `CAR_BURST` (DeFAULT, Merge Late)
 *   G  `BERSERK` (Off Your Face) or `BRACE` (Sober Up); **held 2 s** it is
 *      `MEGA_SLAM` if you have Newtown Standoff or Cronulla Line
 *   T  `MEGA_TELEPORT` (Kings Cross Getaway / Northern Beaches Tunnel)
 *   R  at a Flat White point: `EAT` ($6) or `SIZZLE` ($3)
 *   4  in the phone: `MEGA_SUMMON_RIDE` ($200) or `MEGA_SIZZLE_TENT` ($200)
 *
 * A player can only ever hold one of each pair -- they are on opposite teams --
 * so `abilityForButton` resolves the pair by asking which flag the player has
 * rather than by asking which team they are on. That matters: an aura can grant
 * an ability's *cooldown* across a group (`Rat Run` halves Bolt's) and the code
 * that decides what V does should be reading the same lookup everything else
 * does rather than a second source of truth about who is on which side.
 *
 * ---------------------------------------------------------------------------
 * ONCE PER IN-GAME DAY, and what a day is.
 *
 * Four abilities are once per in-game day. The day is `sky/cycle.ts`'s:
 * `CYCLE_MS` is 3,600,000 (one in-game day is one real hour) and the day index
 * is therefore `floor(clockMs / CYCLE_MS)`. This file takes the **index** as a
 * parameter rather than importing the cycle, for the reason `teamfx.ts` takes
 * the sunrise phase as a parameter: the sky is a client concern with a server
 * clock behind it, and an ability table that imported it would drag the sky into
 * `server/sim.ts`'s import graph for one division.
 *
 * Storing the day index rather than a timestamp is what makes "once per day"
 * survive a server restart and a clock that jumps: the stamp is a small integer
 * that either equals today or does not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS PREDICTED, AND WHAT IS NOT.
 *
 * The brief's rule, and it is the right one: **the client predicts the dash
 * movement and nothing else.** A dash is 300 ms of travel and a player who saw
 * it 80 ms late would feel the input lag on the one ability whose whole point is
 * that it is instant, so the browser applies the impulse locally exactly as it
 * predicts a bike mount and `net/client.reconcile` corrects it from the next
 * snapshot. Everything else -- the berserk window, the slam, the teleport, the
 * tent -- is announced by the server and drawn when it arrives, because none of
 * them is a movement the player is steering and all of them can be refused.
 *
 * The consequence for this file is that `tryAbility` is safe to call on both
 * ends: it mutates a table keyed by player id, and a client only ever holds its
 * own row. A client that predicts a dash the server then refuses spends a
 * cooldown that the server did not, and the next `ABILITY` message resyncs it.
 *
 * ---------------------------------------------------------------------------
 * THE DASH IS NOT A SPEED BUFF, and the difference is load-bearing.
 *
 * The owner dislikes speed buffs and `game/teams.ts` says so twice. A dash is a
 * fixed displacement with a cooldown: it does not raise `WALK_SPEED`,
 * `SPRINT_SPEED` or `speedScale`, and a player using it every four seconds
 * covers 1.5 m/s more ground than one who does not while still being *slower*
 * than a sprint the whole time in between. It is implemented as a one-tick
 * velocity impulse through the controller's own friction, so it collides with
 * walls, falls off kerbs and is resolved by the same prisms a walk is.
 *
 * The distance arithmetic: `player/controller.step` steers velocity toward the
 * wish velocity at `FRICTION` m/s^2 when there is no input, so a body launched
 * at v with no key held travels `v^2 / (2 * FRICTION)` before stopping. Six
 * metres against 34 is 20.2 m/s. Holding a key changes the shape -- the
 * controller decelerates to the walk speed instead of to zero -- and that is
 * deliberate and is what "a dash in your move direction" should feel like; the
 * six metres is the *released-key* figure and it is what the self-check measures.
 */

import { FRICTION } from '../player/controller.ts';
import { FX, TEAM } from './teams.ts';
import { fakeTeamLookup, fxFlag, fxScalar, setTeamLookup, teamLookup } from './teamfx.ts';

// --- The table ------------------------------------------------------------------------

export const ABILITY = {
  NONE: 0,
  /** V, Marita: a 6 m dash in your move direction. */
  DASH: 1,
  /** V, DeFAULT: 0.8 s of grip and crash immunity in a car; a 5 m slide on foot. */
  CAR_BURST: 2,
  /** G, Marita: 5 s of +30% and no knockdowns, then 3 s of paying for it. */
  BERSERK: 3,
  /** G, DeFAULT: 6 s of immunity and +25%, then a pip. */
  BRACE: 4,
  /** G held 2 s, either mega: knock down everyone within 8 m. Once per day. */
  MEGA_SLAM: 5,
  /** R at a Flat White point, Marita: a $6 servo pie. */
  EAT: 6,
  /** R at a Flat White point, DeFAULT: a $3 sausage. */
  SIZZLE: 7,
  /** T, either mobility mega: the nearest station, heat halved. Once per day. */
  MEGA_TELEPORT: 8,
  /** 4 in the phone, Marita: $200 for a ride with heat frozen. Once per day. */
  MEGA_SUMMON_RIDE: 9,
  /** 4 in the phone, DeFAULT: $200 for a 60 s heal tent. Once per day. */
  MEGA_SIZZLE_TENT: 10,
} as const;
export type Ability = (typeof ABILITY)[keyof typeof ABILITY];
export const ABILITY_COUNT = 11;

/** The name the HUD says. Lower case, the game's voice. */
export const ABILITY_NAME: Readonly<Record<number, string>> = {
  [ABILITY.DASH]: 'bolt',
  [ABILITY.CAR_BURST]: 'merge late',
  [ABILITY.BERSERK]: 'off your face',
  [ABILITY.BRACE]: 'sober up',
  [ABILITY.MEGA_SLAM]: 'slam',
  [ABILITY.EAT]: 'servo pie',
  [ABILITY.SIZZLE]: 'sausage sizzle',
  [ABILITY.MEGA_TELEPORT]: 'getaway',
  [ABILITY.MEGA_SUMMON_RIDE]: 'summon a ride',
  [ABILITY.MEGA_SIZZLE_TENT]: 'sizzle tent',
};

// --- The numbers ---------------------------------------------------------------------

/** Bolt's default cooldown, seconds. `Rat Run`'s aura halves it to 2. */
export const DASH_CD_DEFAULT_S = 4;
/** Merge Late's cooldown, seconds. Its tooltip. */
export const CAR_BURST_CD_S = 5;
/** How long a car burst holds full grip and eats crashes, seconds. */
export const CAR_BURST_S = 0.8;
/** The slide it becomes on foot, metres. */
export const CAR_BURST_SLIDE_M = 5;
/** Both G abilities, seconds. Their tooltips agree. */
export const BERSERK_CD_S = 45;
/** Off Your Face: 5 s up, then 3 s down. */
export const BERSERK_UP_S = 5;
export const BERSERK_DOWN_S = 3;
export const BERSERK_DAMAGE = 0.3;
/** Sober Up: 6 s up, no down window -- the pip is taken on the way out. */
export const BRACE_UP_S = 6;
export const BRACE_DAMAGE = 0.25;
/** How long G must be held for the slam, seconds. */
export const SLAM_HOLD_S = 2;
export const SLAM_RADIUS_M = 8;
export const SLAM_PIPS = 1;
/** The two food abilities: a cooldown so R is not a health bar with a key. */
export const FOOD_CD_S = 20;
/** What each ability costs, in dollars. Zero for the free ones. */
export const ABILITY_COST: Readonly<Record<number, number>> = {
  [ABILITY.EAT]: 6,
  [ABILITY.SIZZLE]: 3,
  [ABILITY.MEGA_SUMMON_RIDE]: 200,
  [ABILITY.MEGA_SIZZLE_TENT]: 200,
};
/** Servo pie: 2 pips over 4 s, plus a temporary pip for 30 s. */
export const EAT_HEAL_PIPS = 2;
export const EAT_HEAL_S = 4;
export const EAT_TEMP_PIP_S = 30;
/** Sausage: 1 now, 1 over 6 s, and bystanders within 6 m get one. */
export const SIZZLE_HEAL_NOW = 1;
export const SIZZLE_HEAL_OVER = 1;
export const SIZZLE_HEAL_S = 6;
export const SIZZLE_BYSTANDER_M = 6;
/** The sizzle tent: 60 s, and the radius a DeFAULT has to touch it at. */
export const TENT_SECONDS = 60;
export const TENT_RADIUS_M = 4;
/** Heat frozen for this long after a summoned ride. See the fallback note below. */
export const SUMMON_HEAT_FREEZE_S = 60;
/** The star ceiling the tent clears. Its tooltip: "cleared of heat under 3★". */
export const TENT_CLEARS_UNDER_STARS = 3;

/**
 * The speed a dash of `metres` has to leave at, given the controller's ground
 * friction. See the header for the arithmetic and why it is not a speed buff.
 *
 * `Math.sqrt` rather than `Math.pow`: the determinism rule in `game/footy.ts`
 * names `sin`, `cos`, `pow` and `hypot`, and square root is the one of the five
 * that IEEE-754 requires to be correctly rounded, so two runtimes agree on it
 * bit for bit.
 */
export function dashSpeedFor(metres: number): number {
  return Math.sqrt(2 * FRICTION * metres);
}
/** The inverse, for the self-check: how far a launch at `v` carries. */
export function dashDistanceFor(speed: number): number {
  return (speed * speed) / (2 * FRICTION);
}

// --- Refusals --------------------------------------------------------------------------

export const ABILITY_OK = '';
export const REFUSE_NONE = 'you have not taken that';
export const REFUSE_COOLDOWN = 'not yet';
export const REFUSE_TODAY = 'once a day. come back tomorrow';
export const REFUSE_BROKE = 'not enough cash';

// --- The state ---------------------------------------------------------------------------

interface AbilityRow {
  /** Wall ms at which each ability is next usable. */
  readonly readyAtMs: Float64Array;
  /** The in-game day index each once-a-day ability was last used on, or -1. */
  readonly dayUsed: Int32Array;
  /** The ability whose *up* window is running, or `ABILITY.NONE`. */
  activeKind: number;
  /** Wall ms the up window ends. */
  activeUntilMs: number;
  /** Wall ms the *down* window ends (Off Your Face's three seconds). */
  penaltyUntilMs: number;
  /**
   * Wall ms G went down, or **-1** for "up".
   *
   * -1 rather than 0, and it is a real bug rather than a style: `nowMs` is a
   * wall clock everywhere in the live game and is *zero* in every self-check
   * that starts its timeline at the origin, so a press at t=0 with 0 as the
   * sentinel is a press the reader cannot see.
   */
  gDownMs: number;
  /** Set once per hold, so a 3 s hold is one slam rather than sixty. */
  gConsumed: boolean;
}

const rows = new Map<number, AbilityRow>();

function row(playerId: number): AbilityRow {
  let r = rows.get(playerId);
  if (r === undefined) {
    r = {
      readyAtMs: new Float64Array(ABILITY_COUNT),
      dayUsed: new Int32Array(ABILITY_COUNT).fill(-1),
      activeKind: ABILITY.NONE,
      activeUntilMs: 0,
      penaltyUntilMs: 0,
      gDownMs: -1,
      gConsumed: false,
    };
    rows.set(playerId, r);
  }
  return r;
}

/** Drop a player's row. Called on leave; the map is bounded by the room. */
export function forgetAbilities(playerId: number): void {
  rows.delete(playerId);
}
/** Everything back to boot. For the self-checks and for a room reset. */
export function resetAbilities(): void {
  rows.clear();
}
/** How many players have rows. Diagnostics and the self-check. */
export function trackedAbilities(): number {
  return rows.size;
}

// --- Which ability a button is, for this player ---------------------------------------

/**
 * What V does for this player, or `ABILITY.NONE`.
 *
 * Asks the lookup for the flag rather than the team, on the header's argument.
 * `DASH` is a scalar (its metres) rather than a flag, which is why it is read
 * with `fxScalar` -- a player with Bolt has `FX.DASH = 6`.
 */
export function abilityForV(playerId: number): Ability {
  if (fxScalar(playerId, FX.DASH) > 0) return ABILITY.DASH;
  if (fxFlag(playerId, FX.CAR_BURST)) return ABILITY.CAR_BURST;
  return ABILITY.NONE;
}
/** What a *tap* of G does. */
export function abilityForG(playerId: number): Ability {
  if (fxFlag(playerId, FX.BERSERK)) return ABILITY.BERSERK;
  if (fxFlag(playerId, FX.BRACE)) return ABILITY.BRACE;
  return ABILITY.NONE;
}
/** What a two-second *hold* of G does. */
export function abilityForGHold(playerId: number): Ability {
  return fxFlag(playerId, FX.MEGA_SLAM) ? ABILITY.MEGA_SLAM : ABILITY.NONE;
}
/** What T does. */
export function abilityForT(playerId: number): Ability {
  return fxFlag(playerId, FX.MEGA_TELEPORT) ? ABILITY.MEGA_TELEPORT : ABILITY.NONE;
}
/**
 * What `R` at a Flat White point does.
 *
 * --- WORKSTREAM Z: **`R`, not `F`.** This was `abilityForF` and had no caller,
 * which is how the collision went unnoticed: `F` is the torch and has been since
 * long before talents, and a contextual `F` would be one key doing two things in
 * the one place a player is most likely to be pressing it -- a cafe at night.
 * `R` was free, it is under the same hand, and it is the key this genre puts
 * "use the thing in front of you" on. See `protocol.BTN.ABILITY_R` for what it
 * cost on the wire.
 */
export function abilityForR(playerId: number): Ability {
  if (fxFlag(playerId, FX.EAT)) return ABILITY.EAT;
  if (fxFlag(playerId, FX.SIZZLE)) return ABILITY.SIZZLE;
  return ABILITY.NONE;
}
/** What 4 in the phone does. */
export function abilityForPhone4(playerId: number): Ability {
  if (fxFlag(playerId, FX.MEGA_SUMMON_RIDE)) return ABILITY.MEGA_SUMMON_RIDE;
  if (fxFlag(playerId, FX.MEGA_SIZZLE_TENT)) return ABILITY.MEGA_SIZZLE_TENT;
  return ABILITY.NONE;
}

/** Is this one of the four once-per-in-game-day abilities? */
export function isDaily(ability: Ability): boolean {
  return (
    ability === ABILITY.MEGA_SLAM ||
    ability === ABILITY.MEGA_TELEPORT ||
    ability === ABILITY.MEGA_SUMMON_RIDE ||
    ability === ABILITY.MEGA_SIZZLE_TENT
  );
}

/** This ability's cooldown for this player, seconds. 0 for the dailies. */
export function cooldownSeconds(playerId: number, ability: Ability): number {
  switch (ability) {
    case ABILITY.DASH: {
      // Absolute and min-wins: `Rat Run`'s aura halves Bolt's 4 s to 2, and the
      // lookup has already taken the minimum across the aura and the node.
      const s = fxScalar(playerId, FX.DASH_CD_S);
      return s > 0 && s < DASH_CD_DEFAULT_S ? s : DASH_CD_DEFAULT_S;
    }
    case ABILITY.CAR_BURST:
      return CAR_BURST_CD_S;
    case ABILITY.BERSERK:
    case ABILITY.BRACE:
      return BERSERK_CD_S;
    case ABILITY.EAT:
    case ABILITY.SIZZLE:
      return FOOD_CD_S;
    default:
      return 0;
  }
}

// --- Using one ---------------------------------------------------------------------------

/**
 * Try to use an ability. `''` if it fired; a refusal for the HUD otherwise.
 *
 * **Mutates on success only**, which is the property that lets the caller do
 * `const no = tryAbility(...); if (no) { hud.notice(no); return; }` and then
 * spend the money. The money is the caller's because the wallet lives in a
 * different process from half of this file's readers -- `dollars` is what the
 * caller has, and a `-1` there means "do not check", which is what the browser's
 * optimistic prediction passes.
 */
export function tryAbility(
  playerId: number,
  ability: Ability,
  nowMs: number,
  dayIndex: number,
  dollars = -1,
): string {
  if (ability === ABILITY.NONE) return REFUSE_NONE;
  const cost = ABILITY_COST[ability] ?? 0;
  if (cost > 0 && dollars >= 0 && dollars < cost) return REFUSE_BROKE;
  const r = row(playerId);
  if (isDaily(ability)) {
    if (r.dayUsed[ability] === dayIndex) return REFUSE_TODAY;
  } else if (nowMs < r.readyAtMs[ability]) {
    return REFUSE_COOLDOWN;
  }

  // Fired. The stamp first, then the window, so an ability that opens a window
  // cannot be re-entered from inside it.
  if (isDaily(ability)) r.dayUsed[ability] = dayIndex;
  else r.readyAtMs[ability] = nowMs + cooldownSeconds(playerId, ability) * 1000;

  if (ability === ABILITY.BERSERK) {
    r.activeKind = ABILITY.BERSERK;
    r.activeUntilMs = nowMs + BERSERK_UP_S * 1000;
    r.penaltyUntilMs = r.activeUntilMs + BERSERK_DOWN_S * 1000;
  } else if (ability === ABILITY.BRACE) {
    r.activeKind = ABILITY.BRACE;
    r.activeUntilMs = nowMs + BRACE_UP_S * 1000;
    r.penaltyUntilMs = 0;
  } else if (ability === ABILITY.CAR_BURST) {
    r.activeKind = ABILITY.CAR_BURST;
    r.activeUntilMs = nowMs + CAR_BURST_S * 1000;
    r.penaltyUntilMs = 0;
  }
  return ABILITY_OK;
}

/** Seconds until this ability is usable again, 0 if it is ready now. */
export function cooldownLeft(playerId: number, ability: Ability, nowMs: number): number {
  const r = rows.get(playerId);
  if (r === undefined) return 0;
  const left = (r.readyAtMs[ability] - nowMs) / 1000;
  return left > 0 ? left : 0;
}
/** Has this player already spent a daily today? */
export function usedToday(playerId: number, ability: Ability, dayIndex: number): boolean {
  const r = rows.get(playerId);
  return r !== undefined && r.dayUsed[ability] === dayIndex;
}

// --- The windows the rest of the game asks about --------------------------------------

/** Is a berserk/brace/burst window running, and which? `ABILITY.NONE` if not. */
export function activeAbility(playerId: number, nowMs: number): Ability {
  const r = rows.get(playerId);
  if (r === undefined || r.activeKind === ABILITY.NONE) return ABILITY.NONE;
  if (nowMs >= r.activeUntilMs) return ABILITY.NONE;
  return r.activeKind as Ability;
}

/**
 * The swing-damage bonus from a running window, as a fraction to add.
 *
 * Kept out of `teamfx.fxSwingDamageScale` on purpose: that function is a pure
 * read of talents and this one is a clock, and folding a clock into it would
 * make the "no lookup installed means x1" property depend on a table nobody
 * cleared. The caller adds the two.
 */
export function abilitySwingBonus(playerId: number, nowMs: number): number {
  const a = activeAbility(playerId, nowMs);
  if (a === ABILITY.BERSERK) return BERSERK_DAMAGE;
  if (a === ABILITY.BRACE) return BRACE_DAMAGE;
  return 0;
}

/** Is this player knockdown-immune right now because of an ability window? */
export function abilityKnockdownImmune(playerId: number, nowMs: number): boolean {
  const a = activeAbility(playerId, nowMs);
  return a === ABILITY.BERSERK || a === ABILITY.BRACE;
}
/** Is this player immune to *stagger* too? Sober Up says so; Off Your Face does not. */
export function abilityStaggerImmune(playerId: number, nowMs: number): boolean {
  return activeAbility(playerId, nowMs) === ABILITY.BRACE;
}
/** Is this driver's car on full grip and eating crashes? Merge Late's 0.8 s. */
export function abilityCrashImmune(playerId: number, nowMs: number): boolean {
  return activeAbility(playerId, nowMs) === ABILITY.CAR_BURST;
}

/**
 * Is Off Your Face's *down* window running -- the 3 s in which you cannot swing?
 *
 * Returns true only after the up window has closed, so the two never overlap.
 * The pip it costs is taken by the caller on the transition, which
 * `expirePenalty` reports exactly once.
 */
export function abilityPenaltyRunning(playerId: number, nowMs: number): boolean {
  const r = rows.get(playerId);
  if (r === undefined || r.penaltyUntilMs === 0) return false;
  return nowMs >= r.activeUntilMs && nowMs < r.penaltyUntilMs;
}

/**
 * Has a window just ended, and is a pip owed for it? Reports **once**.
 *
 * Both G abilities cost a pip, and they cost it at different moments -- Off Your
 * Face when its up window closes and the 3 s slump begins, Sober Up when its up
 * window closes and nothing else happens. One function for both, called every
 * tick by the authority, so there is one place a pip can be forgotten.
 */
export function expireAbilityWindow(playerId: number, nowMs: number): Ability {
  const r = rows.get(playerId);
  if (r === undefined || r.activeKind === ABILITY.NONE) return ABILITY.NONE;
  if (nowMs < r.activeUntilMs) return ABILITY.NONE;
  const kind = r.activeKind as Ability;
  // The burst costs nothing, so it simply lapses.
  r.activeKind = ABILITY.NONE;
  if (kind === ABILITY.CAR_BURST) return ABILITY.NONE;
  return kind;
}

// --- G, held ------------------------------------------------------------------------------

/** What a G edge produced this tick. */
export const G_RESULT = { NOTHING: 0, TAP: 1, SLAM: 2 } as const;
export type GResult = (typeof G_RESULT)[keyof typeof G_RESULT];

/**
 * Feed G's level-triggered bit in every tick; get back what it meant.
 *
 * Level-triggered on the wire and interpreted here, which is `BTN.MOUNT`'s rule
 * and is here for its reason plus one more: a *hold* cannot be edge-detected on
 * the sender at all, because the sender does not know how long the key will be
 * held. So the bit says "G is down" and this function keeps the moment it went
 * down.
 *
 * The slam fires **at two seconds, while the key is still down**, rather than on
 * release. Firing on release would make a 10 s hold a 10 s wind-up, and would
 * make the ability's timing a thing the player cannot see; firing at the
 * threshold means the player learns "hold two, it goes". `gConsumed` is what
 * stops the next fifty-eight ticks of the same hold firing it again.
 *
 * A tap -- down and up inside two seconds -- is the short ability, and it
 * resolves on **release** because until the key comes up a tap and a hold are
 * the same input. That costs the tap up to 2 s of latency in the hands of a
 * player who has the mega; it costs nothing at all to the players who do not,
 * which is everybody below level 8, and `abilityForGHold` returning `NONE` is
 * exactly the test that lets the tap resolve immediately for them.
 */
export function feedG(playerId: number, down: boolean, nowMs: number): GResult {
  const r = row(playerId);
  const hasHold = abilityForGHold(playerId) !== ABILITY.NONE;
  if (down) {
    if (r.gDownMs < 0) {
      r.gDownMs = nowMs;
      r.gConsumed = false;
      // No mega: there is nothing a hold could mean, so the tap fires on the
      // press and feels like a button rather than like a delay.
      if (!hasHold) {
        r.gConsumed = true;
        return G_RESULT.TAP;
      }
    }
    if (hasHold && !r.gConsumed && nowMs - r.gDownMs >= SLAM_HOLD_S * 1000) {
      r.gConsumed = true;
      return G_RESULT.SLAM;
    }
    return G_RESULT.NOTHING;
  }
  // Released.
  const wasDown = r.gDownMs >= 0;
  const consumed = r.gConsumed;
  r.gDownMs = -1;
  r.gConsumed = false;
  if (!wasDown || consumed) return G_RESULT.NOTHING;
  return G_RESULT.TAP;
}

// --- Self-check ------------------------------------------------------------------------------

/**
 * Run from `verifyTeamFx` rather than wired into the boot lists on its own.
 *
 * One entry in two boot lists is the contract this workstream owes; two would be
 * two things for the lead to merge and one more line in `main.ts`'s already
 * enormous `if`. The failures are prefixed so a boot failure still names the file.
 */
export function verifyAbilities(): string[] {
  const bad: string[] = [];
  const saved = new Map(rows);
  const savedLookup = teamLookup();
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
  try {
    rows.clear();

    // --- The dash is six metres, measured through the controller's own friction.
    const v = dashSpeedFor(6);
    if (!near(dashDistanceFor(v), 6)) {
      bad.push(`verifyAbilities: a ${v.toFixed(2)} m/s dash carries ${dashDistanceFor(v).toFixed(2)} m, not 6.`);
    }
    if (!(v > 15 && v < 25)) {
      bad.push(`verifyAbilities: a 6 m dash leaves at ${v.toFixed(2)} m/s, which is not a burst off a 6.4 m/s sprint.`);
    }
    if (!near(dashDistanceFor(dashSpeedFor(CAR_BURST_SLIDE_M)), CAR_BURST_SLIDE_M)) {
      bad.push('verifyAbilities: the on-foot slide is not 5 m.');
    }

    // --- Cooldowns. Nothing is installed, so `cooldownSeconds` is the default.
    if (cooldownSeconds(1, ABILITY.DASH) !== DASH_CD_DEFAULT_S) {
      bad.push('verifyAbilities: Bolt\'s default cooldown is not 4 s.');
    }
    if (tryAbility(1, ABILITY.DASH, 0, 0) !== ABILITY_OK) bad.push('verifyAbilities: the first dash was refused.');
    if (tryAbility(1, ABILITY.DASH, 3_900, 0) !== REFUSE_COOLDOWN) {
      bad.push('verifyAbilities: a dash 3.9 s later was allowed; the cooldown is 4 s.');
    }
    if (tryAbility(1, ABILITY.DASH, 4_100, 0) !== ABILITY_OK) {
      bad.push('verifyAbilities: the dash cooldown did not expire at 4 s.');
    }
    if (tryAbility(2, ABILITY.DASH, 4_100, 0) !== ABILITY_OK) {
      bad.push('verifyAbilities: cooldowns are shared between players.');
    }
    if (!near(cooldownLeft(1, ABILITY.DASH, 5_100), 3)) {
      bad.push(`verifyAbilities: 1 s into a 4 s cooldown reported ${cooldownLeft(1, ABILITY.DASH, 5_100)} s left.`);
    }

    // --- Once per in-game day, and the day is an index rather than a clock.
    rows.clear();
    if (tryAbility(1, ABILITY.MEGA_TELEPORT, 0, 12) !== ABILITY_OK) bad.push('verifyAbilities: the first teleport was refused.');
    if (tryAbility(1, ABILITY.MEGA_TELEPORT, 60_000, 12) !== REFUSE_TODAY) {
      bad.push('verifyAbilities: a second teleport on the same day was allowed.');
    }
    if (tryAbility(1, ABILITY.MEGA_TELEPORT, 60_000, 13) !== ABILITY_OK) {
      bad.push('verifyAbilities: the teleport did not come back the next day.');
    }

    // --- The money gate, and the -1 that skips it.
    rows.clear();
    if (tryAbility(1, ABILITY.MEGA_SUMMON_RIDE, 0, 1, 199) !== REFUSE_BROKE) {
      bad.push('verifyAbilities: a $200 ride was summoned on $199.');
    }
    if (tryAbility(1, ABILITY.MEGA_SUMMON_RIDE, 0, 1, 200) !== ABILITY_OK) {
      bad.push('verifyAbilities: a $200 ride was refused on exactly $200.');
    }
    rows.clear();
    if (tryAbility(1, ABILITY.EAT, 0, 1, -1) !== ABILITY_OK) {
      bad.push('verifyAbilities: a -1 wallet did not skip the cost check.');
    }

    // --- Off Your Face: up, then down, and the pip reported exactly once.
    rows.clear();
    if (tryAbility(1, ABILITY.BERSERK, 0, 0) !== ABILITY_OK) bad.push('verifyAbilities: berserk was refused.');
    if (!near(abilitySwingBonus(1, 1_000), BERSERK_DAMAGE)) bad.push('verifyAbilities: berserk gave no damage bonus.');
    if (!abilityKnockdownImmune(1, 1_000)) bad.push('verifyAbilities: berserk was not knockdown-immune.');
    if (abilityStaggerImmune(1, 1_000)) bad.push('verifyAbilities: berserk was stagger-immune; only Sober Up is.');
    if (abilitySwingBonus(1, 6_000) !== 0) bad.push('verifyAbilities: the berserk bonus outlived its 5 s.');
    if (!abilityPenaltyRunning(1, 6_000)) bad.push('verifyAbilities: the 3 s slump did not start.');
    if (abilityPenaltyRunning(1, 9_000)) bad.push('verifyAbilities: the 3 s slump outlived itself.');
    if (expireAbilityWindow(1, 6_000) !== ABILITY.BERSERK) bad.push('verifyAbilities: no pip was owed when berserk ended.');
    if (expireAbilityWindow(1, 6_100) !== ABILITY.NONE) bad.push('verifyAbilities: the berserk pip was charged twice.');
    // And the cooldown is 45 s from the press, not from the end of the window.
    if (tryAbility(1, ABILITY.BERSERK, 44_000, 0) !== REFUSE_COOLDOWN) bad.push('verifyAbilities: berserk recharged early.');
    if (tryAbility(1, ABILITY.BERSERK, 46_000, 0) !== ABILITY_OK) bad.push('verifyAbilities: berserk did not recharge at 45 s.');

    // --- Merge Late lapses without costing a pip.
    rows.clear();
    tryAbility(1, ABILITY.CAR_BURST, 0, 0);
    if (!abilityCrashImmune(1, 500)) bad.push('verifyAbilities: the car burst was not crash-immune.');
    if (abilityCrashImmune(1, 900)) bad.push('verifyAbilities: the car burst outlived its 0.8 s.');
    if (expireAbilityWindow(1, 900) !== ABILITY.NONE) bad.push('verifyAbilities: the car burst charged a pip.');

    // --- G with no mega taps on the press; nothing installed, so no hold exists.
    rows.clear();
    if (feedG(1, true, 0) !== G_RESULT.TAP) bad.push('verifyAbilities: G did not tap on the press without a mega.');
    if (feedG(1, true, 100) !== G_RESULT.NOTHING) bad.push('verifyAbilities: a held G tapped twice.');
    if (feedG(1, false, 200) !== G_RESULT.NOTHING) bad.push('verifyAbilities: releasing a consumed G tapped again.');

    // --- And with a mega installed, G waits: two seconds is a slam, and a short
    //     press is the tap it always was, resolved on the release.
    rows.clear();
    setTeamLookup(fakeTeamLookup({ [FX.BERSERK]: 1, [FX.MEGA_SLAM]: 1 }, TEAM.MARITA));
    if (abilityForG(1) !== ABILITY.BERSERK) bad.push('verifyAbilities: G did not resolve to Off Your Face.');
    if (abilityForGHold(1) !== ABILITY.MEGA_SLAM) bad.push('verifyAbilities: a held G did not resolve to the slam.');
    if (feedG(1, true, 0) !== G_RESULT.NOTHING) bad.push('verifyAbilities: G tapped on the press with a mega taken.');
    if (feedG(1, true, 1_900) !== G_RESULT.NOTHING) bad.push('verifyAbilities: the slam fired before 2 s.');
    if (feedG(1, true, 2_100) !== G_RESULT.SLAM) bad.push('verifyAbilities: a 2.1 s hold did not slam.');
    if (feedG(1, true, 3_000) !== G_RESULT.NOTHING) bad.push('verifyAbilities: one hold slammed twice.');
    if (feedG(1, false, 3_100) !== G_RESULT.NOTHING) bad.push('verifyAbilities: releasing after a slam also tapped.');
    if (feedG(1, true, 4_000) !== G_RESULT.NOTHING) bad.push('verifyAbilities: a fresh press tapped immediately.');
    if (feedG(1, false, 4_300) !== G_RESULT.TAP) bad.push('verifyAbilities: a short press did not tap on release.');
    // The dash cooldown an aura halves. `Rat Run` gives 2 s; the lookup has
    // already taken the minimum, so this only checks that the min-wins read here
    // does not let the 4 s default win.
    setTeamLookup(fakeTeamLookup({ [FX.DASH]: 6, [FX.DASH_CD_S]: 2 }));
    if (abilityForV(1) !== ABILITY.DASH) bad.push('verifyAbilities: V did not resolve to Bolt.');
    if (cooldownSeconds(1, ABILITY.DASH) !== 2) bad.push('verifyAbilities: Rat Run did not halve the dash cooldown.');
    setTeamLookup(fakeTeamLookup({ [FX.CAR_BURST]: 1 }, TEAM.DEFAULT));
    if (abilityForV(1) !== ABILITY.CAR_BURST) bad.push('verifyAbilities: V did not resolve to Merge Late.');

    if (trackedAbilities() === 0) bad.push('verifyAbilities: nothing was tracked; the table is not being written.');
    forgetAbilities(1);
    forgetAbilities(2);
  } finally {
    rows.clear();
    for (const [k, r] of saved) rows.set(k, r);
    setTeamLookup(savedLookup);
  }
  return bad;
}
