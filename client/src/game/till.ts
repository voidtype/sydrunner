/**
 * The till: what a real dollar is worth in Sydney, and what you may buy with
 * one. Arithmetic over a table, with no money in it.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DUMMY TILL AND IT SAYS SO ON THE SCREEN
 *
 * Nothing here touches a payment processor, a card, or a cent of anybody's
 * money. A player picks a pack, the server credits the wallet, and the receipt
 * says **test**. That is the whole feature, and it is deliberately the whole
 * feature: the expensive half of taking money is not the crediting, it is the
 * shape around it -- a catalogue that is server-side truth, an order that is
 * idempotent, a credit that is authoritative, and a front door a player can
 * find. All four of those are here and are the parts that are hard to change
 * later. When Stripe lands, the only new thing is *who says the order is paid*:
 * today it is the client asking and the server agreeing, tomorrow it is a
 * webhook, and `Simulation.topUp` is the one function that learns the
 * difference.
 *
 * **Do not put a card form in front of this.** A screen that collects card
 * numbers into nothing is worse than no screen at all -- it teaches players to
 * type a card number into this game, which is a habit worth exactly nothing to
 * us and worth a great deal to whoever copies the page later. The test till is
 * honest instead: it looks like a shop, it says it is a test, and it charges
 * nobody.
 *
 * ---------------------------------------------------------------------------
 * THE RATE, AND WHY IT IS TEN THOUSAND
 *
 * `AUD_TO_GAME` is 10,000: one Australian dollar is ten thousand in game. The
 * number is the owner's and it is the right one, for a reason worth writing
 * down because every future pack has to respect it.
 *
 * The game's earned money is small and slow on purpose. A fare is `FARE_BASE`
 * plus `FARE_PER_KM`, so four to twenty dollars. Centrelink is
 * `CENTRELINK_PAYMENT` a week per office. A quest tops out around five hundred.
 * A player who works all evening is a few thousand dollars better off, and that
 * is the economy the fights, the fares and the ladder are balanced against.
 *
 * Ten thousand to one puts the smallest pack -- five real dollars -- at fifty
 * thousand in game, which is more than an evening's work and less than a house.
 * That gap is the entire design. It has to be big enough that buying is a real
 * choice, and small enough that a house is not *only* purchasable, because the
 * moment the only route to a house is a credit card this stops being a game
 * about Sydney and becomes a shop with a Sydney skybox. The rule that keeps it
 * honest is stated once, here: **money buys property and cosmetics, and it
 * never buys damage, speed or reach.** `DESIGN.md`'s eight rules already forbid
 * the second half; this is the economic restatement of it.
 *
 * The joke underneath is the true part. A player who works every job in the
 * city all night still cannot afford a house, and the shop is right there, and
 * that is precisely what living here is like.
 *
 * ---------------------------------------------------------------------------
 * WHY BIGGER PACKS ARE BETTER VALUE
 *
 * `perAud` climbs from 10,000 to 15,000 across the table, which is the ordinary
 * shape of every shop like this and is checked rather than assumed -- see
 * `verifyTill`. It is worth one sentence of justification because the
 * alternative is defensible: a flat rate is simpler and does not push anybody
 * toward the big end. The reason it is not flat is that the *interesting*
 * purchase in this game is a house, a house is millions, and a flat rate makes
 * that purchase forty separate five-dollar transactions. A ladder means the
 * player who is actually buying the thing this feature exists for buys it once.
 *
 * ---------------------------------------------------------------------------
 * WHOLE DOLLARS BOTH WAYS
 *
 * Game money is integer dollars (`game/cash.ts`) and real money is integer
 * cents. Neither is ever a float here, and `verifyTill` refuses a table where
 * either has a fraction in it -- a pack that credited 49,999.999999 dollars
 * would round somewhere, and the somewhere would be a different somewhere on
 * the two ends.
 */

import { MAX_BALANCE } from './cash.ts';

/**
 * Game dollars per Australian dollar, at the smallest pack. The header argues
 * the number; every pack in the table is this or better.
 */
export const AUD_TO_GAME = 10_000;

/**
 * The least time between two purchases by one player, milliseconds.
 *
 * Not a spending cap, which would be theatre: a wallet is keyed by a name
 * anybody can type (`server/wallets.ts` says so at length), so a player who
 * wanted more than a cap allowed would type a second name. This is the
 * narrower thing a cooldown is actually good for -- a held-down button or a
 * script cannot mint a billion dollars between two ticks, and the honest
 * refusal it produces is a sentence rather than silence.
 */
export const TILL_COOLDOWN_MS = 3_000;

/** One row of the shop. `cents` is real money; `dollars` is game money. */
export interface Pack {
  /** Stable key. On the wire this row is its **index**, so never reorder. */
  id: string;
  /** What the button says. Lower case, on the phone's voice. */
  name: string;
  /** The blurb under it. */
  blurb: string;
  /** Australian cents, integer. */
  cents: number;
  /** Game dollars credited, integer. */
  dollars: number;
}

/**
 * The catalogue, cheapest first.
 *
 * **The order is the wire format.** A `PHONE_OP.TOPUP` carries the index of the
 * row, so inserting a pack in the middle would sell yesterday's client a
 * different thing from the one it drew. Append only; to retire a row, leave it
 * and stop drawing it.
 *
 * The names are what the money is actually for in this city, in the order you
 * meet them: a schooner, then a slab, then the rego, then the bond on a place,
 * then a deposit you do not have, then the stamp duty on top of the deposit you
 * do not have.
 */
export const PACKS: readonly Pack[] = [
  { id: 'schooner', name: 'schooner', blurb: 'about what one costs now', cents: 500, dollars: 50_000 },
  { id: 'slab', name: 'slab', blurb: 'and one for the road', cents: 1_000, dollars: 110_000 },
  { id: 'rego', name: 'rego', blurb: 'twelve months and a pink slip', cents: 2_500, dollars: 300_000 },
  { id: 'bond', name: 'bond', blurb: 'four weeks in advance', cents: 5_000, dollars: 650_000 },
  { id: 'deposit', name: 'deposit', blurb: 'still not enough for a deposit', cents: 10_000, dollars: 1_400_000 },
  { id: 'stampduty', name: 'stamp duty', blurb: "the government's cut, on top", cents: 20_000, dollars: 3_000_000 },
];

/** The pack a wire index names, or null. Bounds and integers, both checked. */
export function packAt(index: number): Pack | null {
  if (!Number.isInteger(index) || index < 0 || index >= PACKS.length) return null;
  return PACKS[index];
}

/** Game dollars per real dollar for this pack. */
export function perAud(pack: Pack): number {
  return Math.round((pack.dollars * 100) / pack.cents);
}

/**
 * Australian cents as money: `A$10`, `A$12.50`.
 *
 * The `A$` is not decoration. Half this game's players are not in Australia and
 * a bare `$` next to a game balance that is also written with a `$` is the one
 * ambiguity a shop screen cannot afford.
 */
export function formatAud(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return rest === 0 ? `A$${whole}` : `A$${whole}.${String(rest).padStart(2, '0')}`;
}

/** The receipt line a credit carries, e.g. `slab (test)`. Lower case. */
export function receiptFor(pack: Pack): string {
  return `${pack.name} (test)`;
}

export function verifyTill(): string[] {
  const failures: string[] = [];
  if (PACKS.length === 0) failures.push('the shop has nothing in it.');

  const ids = new Set<string>();
  let lastCents = 0;
  let lastRate = 0;
  for (const p of PACKS) {
    if (ids.has(p.id)) failures.push(`two packs are called ${p.id}.`);
    ids.add(p.id);
    if (!Number.isInteger(p.cents) || p.cents <= 0) failures.push(`${p.id} costs a fraction of a cent.`);
    if (!Number.isInteger(p.dollars) || p.dollars <= 0) failures.push(`${p.id} pays a fraction of a dollar.`);
    if (p.cents <= lastCents) failures.push(`${p.id} is not dearer than the pack above it; the list is cheapest first.`);
    const rate = perAud(p);
    if (rate < lastRate) failures.push(`${p.id} is worse value than a smaller pack; nobody would ever buy it.`);
    if (rate < AUD_TO_GAME) failures.push(`${p.id} pays less than the base rate of ${AUD_TO_GAME}.`);
    if (p.dollars > MAX_BALANCE) failures.push(`${p.id} pays more than a wallet can hold.`);
    lastCents = p.cents;
    lastRate = rate;
  }

  // The smallest pack *is* the rate. If this drifts the header is a lie.
  const base = PACKS[0];
  if (base !== undefined && perAud(base) !== AUD_TO_GAME) {
    failures.push(`the cheapest pack pays ${perAud(base)} per dollar, not the documented ${AUD_TO_GAME}.`);
  }

  // The index is the wire format, so the bounds are the wire's bounds.
  if (packAt(-1) !== null || packAt(PACKS.length) !== null) failures.push('a pack index off the end resolved.');
  if (packAt(1.5) !== null || packAt(NaN) !== null) failures.push('a fractional pack index resolved.');
  if (packAt(0) !== PACKS[0]) failures.push('index 0 is not the first pack.');

  for (const [cents, want] of [[500, 'A$5'], [1_000, 'A$10'], [1_250, 'A$12.50'], [1_205, 'A$12.05'], [0, 'A$0']] as const) {
    if (formatAud(cents) !== want) failures.push(`${cents} cents formatted as ${formatAud(cents)}, not ${want}.`);
  }

  // Every pack, bought back to back, must still fit a wallet -- the shop is the
  // one place a balance can climb without a fight or a fare.
  let all = 0;
  for (const p of PACKS) all += p.dollars;
  if (all > MAX_BALANCE) failures.push('one of each pack overflows a wallet.');

  return failures;
}
