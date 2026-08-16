/**
 * Money: what a dollar is, what it is worth, and every rule that moves one.
 *
 * The half of the wallet a **server** keeps, written to `game/powerups.ts`'s
 * three rules and for the same reason -- this file is imported by
 * `server/sim.ts`, by `server/wallets.ts`, by the client's HUD and by the
 * phone, and every one of them has to agree about what a fare pays:
 *
 *   1. **Every function here is a pure function of explicit state.** Nothing
 *      reads a clock, a keyboard or a scene graph. Where an instant is needed
 *      it arrives as an argument, exactly as `tickPowerups` takes its `dt`.
 *   2. **Presentation is a return value, never a side effect.** `tickBundles`
 *      returns which bundles were collected; the chime, the HUD notice and the
 *      +$34 float are the caller's problem.
 *   3. **No import from three at all.** This is numbers and strings.
 *
 * ---------------------------------------------------------------------------
 * A DOLLAR IS AN INTEGER, AND IT IS A WHOLE DOLLAR
 *
 * No cents anywhere. The temptation is to store cents and divide on the way
 * out, which is the correct answer for a ledger and the wrong one here: the
 * smallest thing in this economy is a $5 cash bundle, the largest is a $100
 * Centrelink payment, and a cent would be four decimal digits of precision
 * carried on the wire forever to represent a quantity no rule in the game can
 * produce. `farePayout` rounds once, at the end, and everything downstream of
 * it is exact integer arithmetic -- which is what makes the balance on the HUD,
 * the balance in the file on disk and the balance the server is adjudicating
 * against the *same number* rather than three roundings of one.
 *
 * The wire carries it as an `i32`, so the ceiling is two billion dollars and
 * the floor is a debt nothing here can create (`debit` clamps at zero).
 *
 * ---------------------------------------------------------------------------
 * WHY DEATH DROPS TEN PER CENT
 *
 * A melee game where money accumulates and nothing takes it away is a game
 * where the first hour decides the leaderboard. But a *full* drop makes a
 * player who has just earned $300 unwilling to leave a rooftop, which is worse
 * -- the money would make people stop playing the game rather than play it
 * harder.
 *
 * Ten per cent with a $5 floor is the number that makes both true: it is always
 * worth punching somebody (there is always at least a fiver on them, unless
 * they have nothing at all) and it is never catastrophic to be punched. The
 * bundle lies on the pavement for thirty seconds and **anybody** can take it,
 * including the person who dropped it, which is the clause that makes a fight
 * over one interesting rather than a formality: the killer has to walk to it.
 *
 * ---------------------------------------------------------------------------
 * THE CENTRELINK CLOCK IS THE GAME'S CLOCK, NOT THE WALL'S
 *
 * "Once every seven days" is seven *in-game* days -- `7 * CYCLE_MS`, seven real
 * hours -- because a day in this world is `sky/cycle.ts`'s hour and a rule
 * quoted in days has to mean the days the player can see going past. Seven real
 * days would make the payment unreachable for everybody: nobody plays the same
 * server on two consecutive Tuesdays. Seven in-game days is a long afternoon,
 * which is the right rhythm for a fallback income.
 *
 * The timer is per office, so a player with a car can run a circuit of them --
 * that is deliberate and it is the whole reason the timer is not global. The
 * table has 31 offices spread over 60 km; visiting five of them is a genuine
 * drive and pays $500, which is about what three good fares pay for about the
 * same time. Neither route dominates.
 */

import { CENTRELINKS, type CentrelinkOffice } from './centrelink-data.ts';
import { CYCLE_MS } from '../sky/cycle.ts';
import { PICKUP_HEIGHT, PICKUP_RADIUS } from './powerups.ts';
import { EYE_HEIGHT } from '../player/controller.ts';
import type { CombatantState } from './combat.ts';
import type { SpatialHash } from './spatialhash.ts';

// --- Formatting ----------------------------------------------------------------

/**
 * `$1,234`. The one place a balance becomes text.
 *
 * Grouped by hand rather than through `Intl.NumberFormat`, and the reason is
 * the reason `suggestions.weekKey` goes the *other* way: `Intl` is right when
 * the answer depends on a locale (a week boundary in Sydney does) and wrong
 * when it does not. This string is drawn in a HUD whose every other number is
 * ASCII, on a page that may be rendered under any locale in the world, and
 * `Intl` would put a space or a full stop in the thousands separator depending
 * on the browser's language -- so the HUD would read `$1.234` for a German
 * player, which is a different amount of money.
 *
 * Negative is unreachable (`debit` clamps) and is handled anyway, because a
 * formatter that produced `$-,500` from a number that should not exist is a
 * bug you find in a screenshot.
 */
export function formatMoney(dollars: number): string {
  const n = Math.trunc(dollars);
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n));
  let grouped = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits[i];
  }
  return `${sign}$${grouped}`;
}

/**
 * A duration as the phone and the prompt say it: `5 days 3 h`, `4 h`, `12 min`.
 *
 * In **in-game** days and hours, which is the only unit the Centrelink rule is
 * ever quoted in, so the conversion happens here once rather than at each of
 * the three call sites. An in-game day is `CYCLE_MS` and an in-game hour is a
 * twenty-fourth of it -- 150 real seconds -- so "come back in 3 h" is two and a
 * half real minutes, which is a wait a player will actually sit through and is
 * exactly the point of quoting it in game time.
 *
 * Never returns an empty string and never returns "0 min": anything under a
 * game-minute is "any moment", because a countdown that reads zero while the
 * claim is still refused is the one thing this string must not say.
 */
export function formatGameWait(ms: number): string {
  if (ms <= 0) return 'now';
  const days = Math.floor(ms / CYCLE_MS);
  const hourMs = CYCLE_MS / 24;
  const hours = Math.floor((ms - days * CYCLE_MS) / hourMs);
  if (days > 0) return hours > 0 ? `${days} days ${hours} h` : `${days} days`;
  if (hours > 0) return `${hours} h`;
  const minutes = Math.floor((ms / hourMs) * 60);
  return minutes > 0 ? `${minutes} min` : 'any moment';
}

// --- The wallet ----------------------------------------------------------------

/**
 * One player's money, as it is held in memory and written to disk.
 *
 * Keyed by lower-cased trimmed name in `server/wallets.ts`, which is stated
 * there at length and restated here in one line because it is the load-bearing
 * limitation of the whole feature: **names are unauthenticated.** Anybody who
 * joins as "bazza" is bazza's wallet. See `server/wallets.ts`.
 */
export interface WalletRecord {
  /** Whole dollars, never negative. */
  balance: number;
  /** Office id -> the `Date.now()` of the last successful claim there. */
  centrelink: Record<string, number>;
  /** When this name was last seen, for the eviction sweep. */
  lastSeenMs: number;
}

export function createWallet(balance = STARTING_BALANCE): WalletRecord {
  return { balance, centrelink: {}, lastSeenMs: 0 };
}

/**
 * What a new name starts with.
 *
 * **Twenty dollars, not zero.** A player who joins with nothing has no reason
 * to look at the phone at all -- the wallet app is an empty row and the drop
 * rule does nothing to them, so their first encounter with the entire feature
 * is a Centrelink office they have to be told about. Twenty is a fifth of a
 * Centrelink payment and four fares: enough that the number on the HUD is a
 * number rather than a placeholder, little enough that it is obviously not
 * where the money comes from.
 */
export const STARTING_BALANCE = 20;

/** The most one balance can hold, so an `i32` on the wire cannot be overflowed. */
export const MAX_BALANCE = 2_000_000_000;

// --- Death drops ---------------------------------------------------------------

/** Spec of the drop, and the one place the percentage is written. */
export const DROP_FRACTION = 0.1;
export const DROP_MINIMUM = 5;

/**
 * What falls out of a wallet when its owner goes down, in whole dollars.
 *
 * Zero below the minimum rather than "whatever is left", which is the clause
 * that stops a player on $3 from being farmed for a dollar at a time: the
 * bundle would be worth less than the walk to it and the feed line would be
 * noise. `Math.floor` after the multiply, so $54 drops $5 and not $5.40.
 */
export function dropOnDeath(balance: number): number {
  if (balance < DROP_MINIMUM) return 0;
  return Math.max(DROP_MINIMUM, Math.floor(balance * DROP_FRACTION));
}

/**
 * A pile of cash on the pavement.
 *
 * **Not a `PowerupPoint`, and that was a real decision rather than an
 * oversight.** `game/powerups.ts`'s field is keyed by tile and sidecar index --
 * `adopt` takes a tile key and a set of parallel arrays from the pipeline, the
 * id is `tileKey:index`, and the whole machinery exists so that a respawn clock
 * survives a tile being evicted and reloaded. Every one of those properties is
 * about a point that was *mapped*. A cash bundle is created at a position
 * nothing mapped, at a moment nothing scheduled, and is gone in thirty seconds;
 * pushing it through `PowerupField` would mean inventing a tile key for it,
 * teaching `MSG.POWERUPS` a kind whose position is not implied by its id, and
 * giving the client a respawn clock for an object that never comes back.
 *
 * So it is its own small record with its own list on the room, ticked with the
 * same radius and height gate the pickups use (imported, not copied -- a bundle
 * you can collect through a roof is the same bug at the same 2.5 m).
 */
export interface CashBundle {
  /** Unique within a room for the life of the bundle. See `MSG.WALLET`. */
  readonly id: number;
  /** World metres. `y` is the **ground** the pile sits on, as a powerup's is. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly amount: number;
  /** Who dropped it, so a feed line can name them. 0 for nobody. */
  readonly from: number;
  /** Seconds left before it evaporates. */
  ttl: number;
}

/**
 * How long a bundle lies there, seconds.
 *
 * Thirty, and the number is doing one job: it has to be long enough that
 * somebody across the street can decide to come and get it and short enough
 * that a bundle is never a landmark. At a sprint of 8.2 m/s, thirty seconds is
 * 246 m -- about two Sydney blocks, which is roughly the distance at which the
 * minimap stops being able to tell you it is there.
 */
export const BUNDLE_SECONDS = 30;

/** As many as one room will carry at once. See `MSG.WALLET`'s size note. */
export const MAX_BUNDLES = 48;

/** What one collection was. Returned rather than acted on -- rule 2. */
export interface BundlePickup {
  bundle: CashBundle;
  combatant: CombatantState;
}

const bundleScratch: CombatantState[] = [];

/**
 * Age every bundle by one fixed step, collect the ones somebody is standing on,
 * and compact the list in place.
 *
 * `tickPowerups`' shape exactly, including the tie rule -- combatant order, not
 * distance, because two players reaching one bundle on the same tick have to
 * resolve the same way on every machine and "the caller's array order" is a
 * rule a server can state where "the nearer one" is a float comparison two
 * builds can disagree about.
 *
 * The one difference is that this **removes**: a collected or expired bundle is
 * gone rather than waiting to respawn, so the list is compacted here instead of
 * carrying a dead flag. Compaction is a single pass with a write cursor, which
 * is O(bundles) with no allocation -- and `bundles` is at most `MAX_BUNDLES`.
 */
export function tickBundles(
  bundles: CashBundle[],
  combatants: readonly CombatantState[],
  dt: number,
  out: BundlePickup[] = [],
  index: SpatialHash<CombatantState> | null = null,
): BundlePickup[] {
  out.length = 0;
  const radius2 = PICKUP_RADIUS * PICKUP_RADIUS;
  let write = 0;
  for (let read = 0; read < bundles.length; read++) {
    const b = bundles[read];
    b.ttl -= dt;
    if (b.ttl <= 0) continue;

    let taken = false;
    const near = index === null ? combatants : index.collectWithin(b.x, b.z, PICKUP_RADIUS, bundleScratch);
    for (const c of near) {
      // A body sliding through it does not go shopping. `tickPowerups` makes
      // the identical test and deliberately does not share it: "can be hit" and
      // "can pick up" happen to have the same answer today.
      if (c.phase === 'ko' || c.health <= 0) continue;
      const dx = c.body.position.x - b.x;
      const dz = c.body.position.z - b.z;
      if (dx * dx + dz * dz > radius2) continue;
      const feet = c.body.position.y - EYE_HEIGHT;
      if (Math.abs(feet - b.y) > PICKUP_HEIGHT) continue;
      out.push({ bundle: b, combatant: c });
      taken = true;
      break;
    }
    if (taken) continue;
    bundles[write++] = b;
  }
  bundles.length = write;
  return out;
}

// --- Centrelink ----------------------------------------------------------------

/** What one claim is worth. */
export const CENTRELINK_PAYMENT = 100;

/**
 * Seven in-game days between claims **at one office**. See the header.
 *
 * Written as a multiple of `CYCLE_MS` rather than as 25,200,000 so that moving
 * the day length moves this with it -- the rule is "seven days", and the day is
 * `sky/cycle.ts`'s to define.
 */
export const CENTRELINK_PERIOD_MS = 7 * CYCLE_MS;

/**
 * How close you have to stand, metres.
 *
 * Six, which is the brief's, and it is generous on purpose: the office point is
 * a shopfront node or a building centroid (see `scripts/centrelinks.py`), and a
 * centroid can be ten metres inside a wall. Six metres from the point is
 * reliably "at the door" for a node and "against the front of the building" for
 * a polygon, and it is small enough that you cannot claim from a passing car --
 * which matters, because `PICKUP_RADIUS` is 1.6 and this is nearly four times
 * it for exactly that reason.
 */
export const CLAIM_RADIUS_M = 6;

export type { CentrelinkOffice };
export { CENTRELINKS };

/** The office within `CLAIM_RADIUS_M` of a position, or null. */
export function officeAt(x: number, z: number): CentrelinkOffice | null {
  const r2 = CLAIM_RADIUS_M * CLAIM_RADIUS_M;
  for (const o of CENTRELINKS) {
    const dx = o.x - x;
    const dz = o.z - z;
    if (dx * dx + dz * dz <= r2) return o;
  }
  return null;
}

/**
 * The nearest `count` offices to a position, nearest first, appended to `out`.
 *
 * A full scan of the table, and it is the right implementation: 31 offices is
 * 31 subtractions and a partial sort, called when a phone app is open and on
 * the map's redraw at 15 Hz. A spatial index for thirty-one points would be
 * more code than the loop and slower than it.
 */
export function nearestOffices(
  x: number,
  z: number,
  count: number,
  out: Array<{ office: CentrelinkOffice; distance: number }> = [],
): Array<{ office: CentrelinkOffice; distance: number }> {
  out.length = 0;
  for (const office of CENTRELINKS) {
    const dx = office.x - x;
    const dz = office.z - z;
    // `Math.sqrt` of a sum rather than `Math.hypot`: `game/footy.ts`'s header
    // has the rule, and this value is shown to a player and compared between
    // two ends.
    out.push({ office, distance: Math.sqrt(dx * dx + dz * dz) });
  }
  out.sort((a, b) => a.distance - b.distance || (a.office.id < b.office.id ? -1 : 1));
  out.length = Math.min(out.length, count);
  return out;
}

/**
 * Milliseconds until this office will pay again, or 0 if it will pay now.
 *
 * `lastClaimMs` of 0 means never claimed, which is the state every wallet
 * starts in and is deliberately not spelled as `undefined`: the record on disk
 * is a plain object and a missing key and a zero have to mean the same thing or
 * a hand-edited file changes the rules.
 *
 * A `lastClaimMs` in the **future** -- a server whose clock was moved back, or
 * a file copied from a machine in another timezone with a wrong clock -- is
 * clamped to the full period rather than trusted, so the worst a bad clock can
 * do is make somebody wait seven days.
 */
export function claimWaitMs(lastClaimMs: number, nowMs: number): number {
  if (!(lastClaimMs > 0)) return 0;
  const since = nowMs - lastClaimMs;
  if (since < 0) return CENTRELINK_PERIOD_MS;
  return since >= CENTRELINK_PERIOD_MS ? 0 : CENTRELINK_PERIOD_MS - since;
}

// --- SydRide -------------------------------------------------------------------

/**
 * The fare's states, in the order one goes through them.
 *
 * `none` covers both "not online" and "online, waiting for the next offer",
 * and that is on purpose: the difference is a cooldown the server is counting
 * and the client has nothing to draw for it either way. The HUD line and the
 * markers key off `toPickup` and `toDropoff`; `offered` is the two-second
 * window in which the pickup marker appears before the timer starts.
 */
export type FareState = 'none' | 'offered' | 'toPickup' | 'toDropoff' | 'done';

/** Wire order. See `net/cash.ts`. */
export const FARE_STATES: readonly FareState[] = ['none', 'offered', 'toPickup', 'toDropoff', 'done'];

/** Spec of the payment: `$ = 4 + 1.6 x km`, rounded once at the end. */
export const FARE_BASE = 4;
export const FARE_PER_KM = 1.6;
/** +50% for beating `distance / FARE_TARGET_SPEED`. */
export const FARE_FAST_BONUS = 1.5;
/** -50% for knocking anybody down during the trip. */
export const FARE_ROUGH_PENALTY = 0.5;
/** The pace the bonus is measured against, m/s. About 43 km/h. */
export const FARE_TARGET_SPEED = 12;

/** How far away a pickup is offered, metres. */
export const PICKUP_MIN_M = 300;
export const PICKUP_MAX_M = 900;
/** And how much further the dropoff is, metres. */
export const TRIP_MIN_M = 600;
export const TRIP_MAX_M = 3000;

/** Stop within this of the pickup, and of the dropoff. Metres. */
export const PICKUP_STOP_M = 5;
export const DROPOFF_STOP_M = 6;
/** Held still for this long, seconds, before the passenger moves. */
export const STOP_SECONDS = 1.5;
/** "Still" is under this, m/s. A car idling at a kerb is not moving. */
export const STOPPED_SPEED = 1.5;
/** Out of the car for longer than this cancels the fare, seconds. */
export const ABANDON_SECONDS = 20;
/** And this long between one fare finishing and the next being offered. */
export const FARE_COOLDOWN_SECONDS = 10;

/**
 * What a trip pays, in whole dollars.
 *
 * One rounding, at the very end, after both multipliers -- so a $12.40 fare
 * driven fast and roughly is `12.4 * 1.5 * 0.5 = 9.3 -> 9` and not
 * `round(round(12.4 * 1.5) * 0.5)`, which is 9 by luck here and off by one
 * elsewhere. The two multipliers compose rather than override, which is
 * `powerups.damageScale`'s arrangement and reads the same way: a fast rough
 * trip is 75% of the base, which is still more than a slow rough one.
 *
 * `seconds` of 0 or less never earns the bonus. That is not a division guard --
 * there is no division -- it is a rule: a trip that took no time is a trip that
 * did not happen, and the only way to produce one is a bug or a teleport.
 */
export function farePayout(metres: number, seconds: number, knockedSomeoneDown: boolean): number {
  const km = Math.max(0, metres) / 1000;
  let pay = FARE_BASE + FARE_PER_KM * km;
  const target = metres / FARE_TARGET_SPEED;
  if (seconds > 0 && seconds < target) pay *= FARE_FAST_BONUS;
  if (knockedSomeoneDown) pay *= FARE_ROUGH_PENALTY;
  return Math.max(1, Math.round(pay));
}

/**
 * What the passenger says, on board and at the kerb.
 *
 * Eight lines, lower case, deadpan, and none of them is about the driver -- a
 * passenger who commented on your driving would be a rating system, and this is
 * a person in the back seat looking at their phone. They are the only writing
 * in the game with a voice that is not the HUD's, which is why they are all
 * short enough to read while driving.
 *
 * Chosen by a hash of the fare rather than at random, so the two ends could
 * agree if the line ever went on the wire (it does not today -- the server
 * sends the index nowhere and the client picks from the same seed).
 */
export const PASSENGER_LINES: readonly string[] = [
  'just take the tunnel',
  'can you not use the m5',
  'my opal is on twelve cents',
  'anywhere near the lights is fine',
  'sorry, the dog is at the vet',
  'is it still raining out there',
  'i said parramatta road, not the road to parramatta',
  'no worries if you miss the turn',
];

/**
 * One of the lines, from a seed. `game/traffic.ts`'s hash, at a smaller scale.
 *
 * Integer arithmetic only -- no `Math.sin`, no `Math.random` -- because this is
 * evaluated on two machines and the determinism rule in `game/footy.ts`'s
 * header applies to anything both ends compute. `Math.imul` keeps the multiply
 * exact in 32 bits, which is the whole reason it is used rather than `*`.
 */
export function passengerLine(seed: number): string {
  let h = seed | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = (h ^ (h >>> 16)) >>> 0;
  return PASSENGER_LINES[h % PASSENGER_LINES.length];
}

// --- The self-check -------------------------------------------------------------

const STEP_DT = 1 / 60;

/**
 * Every rule above, asserted, because every failure in this file is silent in
 * this repo's sense -- it pays, it renders, and the number is wrong:
 *
 *   - A **drop that floors before the minimum** takes $5 off a player with $6
 *     and $0 off one with $49, which reads as the drop being random.
 *   - A **bundle list that is not compacted** leaves collected piles in the
 *     array; they are invisible (the client draws what it is sent) and they
 *     silently fill `MAX_BUNDLES`, after which nobody drops anything ever
 *     again.
 *   - A **claim period computed in real days** is 604,800,000 rather than
 *     25,200,000 and makes the payment unreachable, which nobody reports
 *     because nobody waits a week to find out.
 *   - A **fare that rounds twice** is off by a dollar on about a third of
 *     trips, in the direction of the house.
 *   - And a **money formatter that uses `Intl`** draws `$1.234` for a German
 *     player, which is a different amount of money.
 *
 *     bun -e "import {verifyCash} from './client/src/game/cash.ts';
 *             console.log(verifyCash())"
 */
export function verifyCash(): string[] {
  const failures: string[] = [];

  // --- The formatter, including the two cases nothing else produces.
  {
    const cases: Array<[number, string]> = [
      [0, '$0'],
      [7, '$7'],
      [100, '$100'],
      [1000, '$1,000'],
      [1234, '$1,234'],
      [999999, '$999,999'],
      [1000000, '$1,000,000'],
      [-40, '-$40'],
    ];
    for (const [n, want] of cases) {
      const got = formatMoney(n);
      if (got !== want) failures.push(`formatMoney(${n}) is ${got}, not ${want}.`);
    }
  }

  // --- The drop: ten per cent, a $5 floor, and nothing at all under it.
  {
    const cases: Array<[number, number]> = [
      [0, 0],
      [4, 0],
      [5, 5],
      [49, 5],
      [50, 5],
      [54, 5],
      [100, 10],
      [1234, 123],
    ];
    for (const [balance, want] of cases) {
      const got = dropOnDeath(balance);
      if (got !== want) {
        failures.push(
          `A player on $${balance} drops $${got}; the rule is ${DROP_FRACTION * 100}% with a ` +
            `$${DROP_MINIMUM} floor and nothing below it, which is $${want}.`,
        );
      }
    }
  }

  // --- Bundles: collected, expired, compacted, and never twice.
  {
    const c = fakeCombatant(1, 0, 0);
    const near: CashBundle = { id: 1, x: 1.0, y: 0, z: 0, amount: 30, from: 2, ttl: BUNDLE_SECONDS };
    const far: CashBundle = { id: 2, x: 40, y: 0, z: 0, amount: 30, from: 2, ttl: BUNDLE_SECONDS };
    const bundles = [near, far];
    const took = tickBundles(bundles, [c], STEP_DT);
    if (took.length !== 1 || took[0].bundle.id !== 1) {
      failures.push(`A combatant standing 1 m from one bundle and 40 m from another collected ${took.length}.`);
    }
    if (bundles.length !== 1 || bundles[0].id !== 2) {
      failures.push(`After one collection the list held ${bundles.map((b) => b.id).join(',')}; it must hold only 2.`);
    }
    if (tickBundles(bundles, [c], STEP_DT).length !== 0) {
      failures.push('A bundle 40 m away was collected on the next tick.');
    }
    // Expiry, counted in fixed steps, and the list empties.
    const dying: CashBundle[] = [{ id: 3, x: 500, y: 0, z: 0, amount: 5, from: 0, ttl: BUNDLE_SECONDS }];
    let ticks = 0;
    while (dying.length > 0 && ticks < Math.round(BUNDLE_SECONDS / STEP_DT) * 2) {
      tickBundles(dying, [c], STEP_DT);
      ticks++;
    }
    const elapsed = ticks * STEP_DT;
    if (Math.abs(elapsed - BUNDLE_SECONDS) > 0.05) {
      failures.push(`A bundle lasted ${elapsed.toFixed(2)} s; it should be ${BUNDLE_SECONDS} s.`);
    }
    // A knocked-out body does not collect, on `verifyPowerups`' own case.
    const down = fakeCombatant(2, 0, 0);
    down.phase = 'ko';
    const onTop: CashBundle[] = [{ id: 4, x: 0, y: 0, z: 0, amount: 9, from: 0, ttl: BUNDLE_SECONDS }];
    if (tickBundles(onTop, [down], STEP_DT).length !== 0) {
      failures.push('A knocked-out combatant collected a cash bundle.');
    }
    // And a bundle on the roof of the building you are standing in does not
    // fall into your pocket. Same gate, same reason as `PICKUP_HEIGHT`.
    const upstairs = fakeCombatant(3, 0, 0);
    upstairs.body.position.y += PICKUP_HEIGHT + 1;
    const below: CashBundle[] = [{ id: 5, x: 0, y: 0, z: 0, amount: 9, from: 0, ttl: BUNDLE_SECONDS }];
    if (tickBundles(below, [upstairs], STEP_DT).length !== 0) {
      failures.push(`A combatant ${PICKUP_HEIGHT + 1} m above a bundle collected it.`);
    }
  }

  // --- The Centrelink clock: seven **game** days, per office, and the wait
  // string that is shown for it.
  {
    if (CENTRELINK_PERIOD_MS !== 7 * CYCLE_MS) {
      failures.push(`The claim period is ${CENTRELINK_PERIOD_MS} ms, not seven cycles (${7 * CYCLE_MS}).`);
    }
    if (CENTRELINK_PERIOD_MS > 86_400_000) {
      failures.push(
        `The claim period is ${(CENTRELINK_PERIOD_MS / 3_600_000).toFixed(1)} real hours. Seven ` +
          'days means seven of this game\'s days -- seven real weeks of waiting is a payment ' +
          'nobody in this game will ever collect.',
      );
    }
    const t0 = 1_800_000_000_000;
    if (claimWaitMs(0, t0) !== 0) failures.push('An office never claimed at refused a claim.');
    if (claimWaitMs(t0, t0) !== CENTRELINK_PERIOD_MS) {
      failures.push(`A claim made this instant left ${claimWaitMs(t0, t0)} ms to wait, not the full period.`);
    }
    if (claimWaitMs(t0, t0 + CENTRELINK_PERIOD_MS) !== 0) {
      failures.push('An office was still refusing exactly one period after its last claim.');
    }
    if (claimWaitMs(t0, t0 - 60_000) !== CENTRELINK_PERIOD_MS) {
      failures.push('A last-claim stamp in the future was trusted rather than clamped.');
    }
    const halfway = claimWaitMs(t0, t0 + CENTRELINK_PERIOD_MS / 2);
    if (Math.abs(halfway - CENTRELINK_PERIOD_MS / 2) > 1) {
      failures.push(`Halfway through the period the wait was ${halfway} ms.`);
    }
    if (formatGameWait(0) !== 'now') failures.push(`formatGameWait(0) is ${formatGameWait(0)}.`);
    const fiveDaysThree = 5 * CYCLE_MS + 3 * (CYCLE_MS / 24);
    if (formatGameWait(fiveDaysThree) !== '5 days 3 h') {
      failures.push(`formatGameWait(5 days 3 h) is ${formatGameWait(fiveDaysThree)}.`);
    }
    if (formatGameWait(4 * (CYCLE_MS / 24)) !== '4 h') {
      failures.push(`formatGameWait(4 game hours) is ${formatGameWait(4 * (CYCLE_MS / 24))}.`);
    }
    // Under a game-minute must never read "0 min".
    if (formatGameWait(100) === '0 min') failures.push('A wait under a game-minute was drawn as "0 min".');
  }

  // --- The table itself, which is generated and must still be sane.
  {
    if (CENTRELINKS.length < 10) {
      failures.push(`Only ${CENTRELINKS.length} Centrelink offices in the table; scripts/centrelinks.py has not run.`);
    }
    const ids = new Set<string>();
    for (const o of CENTRELINKS) {
      if (ids.has(o.id)) failures.push(`Two Centrelink offices share the id ${o.id}.`);
      ids.add(o.id);
      if (!Number.isFinite(o.x) || !Number.isFinite(o.z)) failures.push(`Office ${o.id} has a non-finite position.`);
      if (o.name.length === 0) failures.push(`Office ${o.id} has no name.`);
    }
    // No two offices inside one claim radius, which would be two claims from
    // one doorway and is exactly what the script's dedupe pass exists to stop.
    for (let i = 0; i < CENTRELINKS.length; i++) {
      for (let j = i + 1; j < CENTRELINKS.length; j++) {
        const a = CENTRELINKS[i];
        const b = CENTRELINKS[j];
        const d2 = (a.x - b.x) ** 2 + (a.z - b.z) ** 2;
        if (d2 < (CLAIM_RADIUS_M * 2) ** 2) {
          failures.push(`${a.id} and ${b.id} are ${Math.sqrt(d2).toFixed(1)} m apart -- one doorway, two claims.`);
        }
      }
    }
    // And `officeAt` finds one when you stand on it and not when you stand a
    // block away, which is the whole of the server's position check.
    const first = CENTRELINKS[0];
    if (officeAt(first.x, first.z)?.id !== first.id) {
      failures.push('officeAt failed to find an office from its own coordinates.');
    }
    if (officeAt(first.x + CLAIM_RADIUS_M + 1, first.z) !== null) {
      failures.push(`officeAt matched from ${CLAIM_RADIUS_M + 1} m away; the radius is ${CLAIM_RADIUS_M} m.`);
    }
    const near = nearestOffices(first.x, first.z, 3);
    if (near.length !== Math.min(3, CENTRELINKS.length) || near[0].office.id !== first.id) {
      failures.push('nearestOffices did not put the office you are standing on first.');
    }
    for (let i = 1; i < near.length; i++) {
      if (near[i].distance < near[i - 1].distance) failures.push('nearestOffices came back out of order.');
    }
  }

  // --- The fare, including both multipliers and the single rounding.
  {
    // 1 km, driven slowly, no knockdowns: 4 + 1.6 = $5.60 -> $6.
    const slow = farePayout(1000, 1000, false);
    if (slow !== 6) failures.push(`A slow 1 km fare paid $${slow}; 4 + 1.6 x 1 rounds to 6.`);
    // The same trip inside 1000/12 = 83.3 s is +50%: 5.6 x 1.5 = 8.4 -> $8.
    const fast = farePayout(1000, 60, false);
    if (fast !== 8) failures.push(`A fast 1 km fare paid $${fast}; 5.6 x 1.5 rounds to 8.`);
    // Exactly on the target time is **not** a bonus -- the rule is "under".
    const exact = farePayout(1000, 1000 / FARE_TARGET_SPEED, false);
    if (exact !== slow) failures.push(`A fare driven at exactly the target pace paid $${exact}, not $${slow}.`);
    // Rough halves it: 5.6 x 0.5 = 2.8 -> $3.
    const rough = farePayout(1000, 1000, true);
    if (rough !== 3) failures.push(`A rough 1 km fare paid $${rough}; 5.6 x 0.5 rounds to 3.`);
    // Both compose rather than one overriding the other: 5.6 x 1.5 x 0.5 = 4.2.
    const both = farePayout(1000, 60, true);
    if (both !== 4) failures.push(`A fast rough 1 km fare paid $${both}; 5.6 x 1.5 x 0.5 rounds to 4.`);
    if (!(both > rough)) failures.push('A fast rough trip paid no more than a slow rough one.');
    // A long one, and the arithmetic is the spec's verbatim: 3 km slow is
    // 4 + 4.8 = $8.80 -> $9.
    if (farePayout(3000, 10_000, false) !== 9) {
      failures.push(`A 3 km fare paid $${farePayout(3000, 10_000, false)}; 4 + 1.6 x 3 rounds to 9.`);
    }
    // Never zero and never negative, whatever it is handed.
    for (const m of [0, -50, 1, 1e9]) {
      if (farePayout(m, 1, true) < 1) failures.push(`A ${m} m fare paid less than a dollar.`);
    }
    // A trip that took no time earns no bonus -- see the function.
    if (farePayout(1000, 0, false) !== slow) failures.push('A zero-second trip was paid the fast bonus.');
    // And the offered geometry is a band a road can actually be found in.
    if (!(PICKUP_MIN_M < PICKUP_MAX_M && TRIP_MIN_M < TRIP_MAX_M && TRIP_MIN_M > 0)) {
      failures.push('The pickup or trip distance band is inverted.');
    }
  }

  // --- The passenger, who is deterministic and never says nothing.
  {
    const seen = new Set<string>();
    for (let seed = 0; seed < 400; seed++) {
      const line = passengerLine(seed);
      if (!PASSENGER_LINES.includes(line)) failures.push(`passengerLine(${seed}) said ${JSON.stringify(line)}.`);
      if (line !== passengerLine(seed)) failures.push(`passengerLine(${seed}) is not a pure function.`);
      seen.add(line);
    }
    if (seen.size < PASSENGER_LINES.length) {
      failures.push(`Only ${seen.size} of ${PASSENGER_LINES.length} passenger lines are reachable over 400 seeds.`);
    }
    // Negative seeds happen -- an id difference, a hashed pair -- and must not
    // index off the front of the array.
    for (const seed of [-1, -999, -2147483648]) {
      if (!PASSENGER_LINES.includes(passengerLine(seed))) {
        failures.push(`passengerLine(${seed}) fell off the end of the table.`);
      }
    }
    // Lower case, as the HUD's voice is. See `factions.REASON_TEXT`.
    for (const line of PASSENGER_LINES) {
      if (line !== line.toLowerCase()) failures.push(`The passenger line ${JSON.stringify(line)} is not lower case.`);
    }
  }

  return failures;
}

/**
 * A combatant-shaped object for the check, built by hand.
 *
 * `combat.createCombatant` would be the obvious thing and is deliberately not
 * used: it drags the whole controller and its collision types into a check that
 * only needs a position, a phase and a health, and `game/powerups.ts` can
 * afford that import because it *is* the combat pair. This file is not, and an
 * import cycle between the wallet and the fight would be a cycle nothing needs.
 */
function fakeCombatant(id: number, x: number, z: number): CombatantState {
  return {
    id,
    phase: 'idle',
    health: 3,
    body: { position: { x, y: EYE_HEIGHT, z } },
  } as unknown as CombatantState;
}
