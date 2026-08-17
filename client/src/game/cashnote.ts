/**
 * What an NPC is worth, how fast you may be paid it, and what the money looks
 * like -- the three-free half of "killing an npc should drop cash".
 *
 * *"killing npc should drop cash (as its ausie make it look like aussie $50s)"*.
 * Three separable questions live in that sentence and this file answers all
 * three in the one place, because they are the parts that have to be identical
 * on both ends or checkable without a GPU:
 *
 *   1. **The table.** Which kind is worth what. The server pays it; nothing on
 *      the client needs it, but it is here rather than in `server/sim.ts` for
 *      `game/cash.ts`'s standing reason -- economy numbers belong in the module
 *      both ends import so a check can read them without a socket.
 *   2. **The rate.** A per-player bank, so a player standing at an ibis spawn
 *      cannot print money. See `bankAllow`.
 *   3. **The note.** A list of canvas operations that draw a stylised
 *      Australian fifty. `world/cashnote.ts` walks the list onto a real canvas;
 *      `verifyCashDrops` walks it into assertions. Neither of them owns the
 *      design, which is what makes "the note is 0.15 m long and has a window in
 *      it" a thing this repo can *test* rather than a thing somebody looked at
 *      once.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A RATE CAP AT ALL, AND WHY IT IS PER PLAYER
 *
 * Everything else that pays in this game is either scarce (a Centrelink claim is
 * once a fortnight per office), bounded by another player's wallet (a death
 * drop is 10% of somebody who had to earn it), or paid for with time (a fare is
 * a drive across the city). An NPC is none of those: `game/wildlife.ts` and
 * `game/streetlife.ts` produce them from a tile hash, forever, and there is an
 * ibis every fifteen metres along the Domain. Without a cap the optimal
 * strategy in this economy is to stand still and swing a bat, which is both the
 * least interesting thing the game contains and the fastest way to make every
 * other source of money pointless.
 *
 * **$200 a minute** is set against the two things it has to sit between. A
 * Centrelink claim is $100 and a fare across the city is $20-$60 for a couple of
 * minutes of driving, so a minute of committed violence paying $200 is
 * comfortably the best rate in the game -- which is correct, it is a brawler --
 * and is not so far ahead that the other two stop being worth doing. Four police
 * or ten karens is the whole minute's allowance.
 *
 * Per player rather than per room, because a shared bank is a bank the first
 * person to wake up empties, and per *player* rather than per *NPC kind*
 * because the thing being limited is income and not variety.
 *
 * ---------------------------------------------------------------------------
 * A NOTE ON WHAT THE PICTURE IS NOT
 *
 * The note drawn here is **stylised and deliberately not a reproduction**. It is
 * a gold ground, a lighter rounded window at one end, a large numeral and the
 * word AUSTRALIA. There is no portrait, no coat of arms, no microtext, no
 * signature and nothing traceable to the artwork of the actual note -- which is
 * Crown copyright and is not something to bake into a texture atlas in a public
 * repository. What a player has to read at three metres is "that is money and it
 * is Australian", and the colour and the clear window do the whole of that job:
 * they are the two things anybody in this country identifies a fifty by, and
 * neither is anyone's artwork.
 */

import { NPC_KIND } from './factions.ts';

// --- 1. What a body is worth ------------------------------------------------------

/**
 * Dollars dropped by each `NPC_KIND` on a knockout by a player.
 *
 * A dense array indexed by the kind byte rather than a `Map` or an object with
 * numeric keys, on `game/traffic.ts`'s rule about tables on a hot path: this is
 * read once per NPC knockout, which is rare, but the array is fifteen entries
 * long and a lookup that cannot allocate or miss is worth having anyway.
 *
 * The numbers are the instruction's, and the shape they make is worth stating
 * because it is not arbitrary: **the amount is how much trouble the body was.**
 * A constable and a real-estate agent are $50 because one shoots back and the
 * other is a four-star headache; a tradie is $30 because he decks you (see
 * `characterStruck`); an eshay and an influencer are $20; a karen, a meth head
 * and a drunk are $10, which is a beer.
 *
 * **Wildlife is zero and that is a rule rather than an omission.** A turkey, an
 * ibis and a magpie are protected under the NPW Act, hurting one is an
 * unconditional offence with no witness test (`sim.hitNpc`), and paying a player
 * for it would be the game offering a bounty on the thing it also sends the
 * police about. It would also be the single most farmable source in the city --
 * the Domain has an ibis every fifteen metres and they do not fight back.
 *
 * The three vehicle kinds are zero for the plainer reason: a highway patrol car,
 * an RBT and Polair are not people and have no pockets. `HIGHWAY_PATROL` is a
 * *car* -- see `NPC_KIND` -- so a $50 falling out of one would be a $50 falling
 * out of a Commodore.
 */
const DROP_BY_KIND: readonly number[] = (() => {
  const table: number[] = new Array(16).fill(0);
  table[NPC_KIND.POLICE] = 50;
  table[NPC_KIND.METHHEAD] = 10;
  table[NPC_KIND.DRUNK] = 10;
  table[NPC_KIND.TURKEY] = 0;
  table[NPC_KIND.IBIS] = 0;
  table[NPC_KIND.MAGPIE] = 0;
  table[NPC_KIND.HIGHWAY_PATROL] = 0;
  table[NPC_KIND.POLAIR] = 0;
  table[NPC_KIND.RBT] = 0;
  table[NPC_KIND.ESHAY] = 20;
  table[NPC_KIND.KAREN] = 10;
  table[NPC_KIND.TRADIE] = 30;
  table[NPC_KIND.INFLUENCER] = 20;
  table[NPC_KIND.AGENT] = 50;
  return table;
})();

/**
 * What this kind drops, in whole dollars. **0 for anything unlisted**, which is
 * the important half: a kind byte that was registered by a faction written after
 * this file pays nothing until somebody decides what it is worth, rather than
 * paying whatever the array's last entry happened to be. `verifyCashDrops`
 * asserts that every kind in `NPC_KIND` has an entry, so "unlisted" means
 * "genuinely new" and not "forgotten".
 */
export function npcDropAmount(kind: number): number {
  return DROP_BY_KIND[kind] ?? 0;
}

// --- 2. How fast you may be paid it -----------------------------------------------

/** The bank, in dollars, and the window it refills over. See the header. */
export const NPC_CASH_BANK = 200;
export const NPC_CASH_WINDOW_MS = 60_000;

/**
 * One player's NPC income, as a **sliding window counter**.
 *
 * Three numbers and no array, which is the whole reason this shape was picked:
 * the server box is 1 vCPU and this record lives on every `Participant` for the
 * life of their session, so a queue of timestamped payments -- the obvious
 * implementation of "no more than $200 in any 60 seconds" -- would be an
 * unbounded allocation per player to enforce a cap on a thing that happens a few
 * times a minute.
 *
 * The counter keeps the spend in the current window and the spend in the one
 * before it, and estimates the sliding total by pro-rating the previous window
 * by how much of it is still inside the last sixty seconds. That is the standard
 * two-bucket approximation and it is *tight*: the error is bounded by the
 * previous window's own spend, it never over-pays past `NPC_CASH_BANK` at the
 * moment of the check, and it costs one subtract and one multiply.
 *
 * The alternative -- a tumbling window that resets on the minute -- is one
 * number cheaper and allows $400 across a boundary, which is exactly the hole a
 * farmer finds. See `verifyCashDrops`, which drives a boundary crossing.
 */
export interface NpcCashBank {
  /** Wall-clock ms at which the current window opened. */
  windowStartMs: number;
  /** Dollars taken in the current window. */
  current: number;
  /** Dollars taken in the window before it. */
  previous: number;
}

/** A fresh, empty bank. One per participant, made on join. */
export function createNpcCashBank(): NpcCashBank {
  return { windowStartMs: 0, current: 0, previous: 0 };
}

/**
 * How much of `want` this player may actually be paid right now, and take it.
 *
 * **Partial rather than all-or-nothing**, and that is a deliberate answer to the
 * obvious alternative. If a player has $30 of allowance left and knocks over a
 * constable, they get $30 and not $50 -- and not nothing. All-or-nothing would
 * mean the last few dollars of every window were unspendable on the expensive
 * kinds, so the optimal play at the end of a minute would be to go and find a
 * karen, which is a strategy nobody should have to discover. Paying out the
 * remainder makes the cap read as "you have earned this minute's worth" rather
 * than as a lottery.
 *
 * Returns 0 when the bank is empty, which the caller treats as "no bundle" --
 * see `sim.dropNpcCash`. A zero-dollar pile on the pavement would be worse than
 * no pile: it is a thing to walk to that gives you nothing.
 *
 * `nowMs` is the caller's wall clock. Rolling the window forward here rather
 * than on a timer is what keeps this O(1) and means a player who does not fight
 * for an hour costs nothing at all -- the arithmetic only runs when they do.
 */
export function bankAllow(bank: NpcCashBank, want: number, nowMs: number): number {
  // `Number.isFinite` and not just `> 0`: an `Infinity` want passes a `> 0` test
  // and then `Math.min(Infinity, room)` is `room`, so a corrupt amount would
  // quietly empty the bank in one payment instead of being refused. Reachable
  // from a drop table entry computed rather than written down, which is the
  // shape the next kind's entry will probably take.
  if (!Number.isFinite(want) || want <= 0) return 0;
  roll(bank, nowMs);
  // The sliding estimate: all of this window, plus whatever fraction of the
  // previous one has not yet aged out. `elapsed` is 0..WINDOW by construction
  // after `roll`, so the weight is 1 at the instant a window opens (the previous
  // window counts in full) and 0 as it closes.
  const elapsed = nowMs - bank.windowStartMs;
  const weight = 1 - elapsed / NPC_CASH_WINDOW_MS;
  const used = bank.current + bank.previous * (weight > 0 ? weight : 0);
  const room = NPC_CASH_BANK - used;
  if (!(room > 0)) return 0;
  // Whole dollars only. Every amount in this economy is an integer -- see
  // `cash.formatMoney`, which has no cents -- and a bundle worth $12.4 would be
  // the first fractional thing in it.
  const pay = Math.floor(Math.min(want, room));
  if (pay <= 0) return 0;
  bank.current += pay;
  return pay;
}

/**
 * Advance the two buckets to `nowMs`. Idempotent and cheap.
 *
 * A **loop rather than a single shift**, because a player can go ten minutes
 * without touching an NPC and then knock one over: one shift would leave a
 * ten-minute-old spend sitting in `previous` and being pro-rated as though it
 * were recent. The loop runs at most twice in practice and is bounded by the
 * early exit at two windows, which is all the state there is -- anything older
 * than two windows is entirely gone whatever the arithmetic says.
 */
function roll(bank: NpcCashBank, nowMs: number): void {
  if (bank.windowStartMs === 0) {
    bank.windowStartMs = nowMs;
    return;
  }
  let elapsed = nowMs - bank.windowStartMs;
  // A clock that went backwards -- which on a server means somebody stepped
  // `Date.now` in a check, and in a browser means a suspended tab -- resets
  // rather than banking negative time.
  if (elapsed < 0) {
    bank.windowStartMs = nowMs;
    bank.current = 0;
    bank.previous = 0;
    return;
  }
  if (elapsed >= 2 * NPC_CASH_WINDOW_MS) {
    bank.windowStartMs = nowMs;
    bank.current = 0;
    bank.previous = 0;
    return;
  }
  while (elapsed >= NPC_CASH_WINDOW_MS) {
    bank.previous = bank.current;
    bank.current = 0;
    bank.windowStartMs += NPC_CASH_WINDOW_MS;
    elapsed -= NPC_CASH_WINDOW_MS;
  }
}

// --- 3. The note ------------------------------------------------------------------

/**
 * The note, in metres. A real Australian fifty is 151 x 65 mm.
 *
 * Used at full size, which is unusual for this project -- the bat's viewmodel is
 * 58% of a bat and the football is under a hand -- and is right here for the
 * opposite reason to the bat's: a note is *small*, and a stack of them lying on
 * a footpath thirty metres away is already at the edge of legibility. Shrinking
 * it would turn the drop into a yellow smudge, and the thing it has to say from
 * that distance is "money".
 */
export const NOTE_LENGTH_M = 0.15;
export const NOTE_HEIGHT_M = 0.065;
/**
 * And its thickness. A polymer note is 0.13 mm; this is 0.6.
 *
 * Nearly five times life, and the reason is that a 0.13 mm slab at 30 m is
 * under a hundredth of a pixel of edge and z-fights with the note beneath it in
 * the fan. 0.6 mm is still invisible as a *thickness* and is enough separation
 * for the depth buffer at this project's near plane. The same bargain
 * `world/nameplates.ts` strikes about its backing quad's offset.
 */
export const NOTE_THICKNESS_M = 0.0006;

/**
 * Pixels across the note's texture. 256 x 111, holding the note's own 151:65.
 *
 * A power of two on the long axis and whatever the aspect gives on the short
 * one, which is `world/texture-audit.ts`'s standing preference: WebGPU does not
 * require power-of-two but the mip chain is cleaner and the audit reports on it.
 * 256 px across 0.15 m is 1,700 px/m, which at the two metres a player picks a
 * bundle up from is comfortably past the screen's own density -- the numeral is
 * 60 px tall and is the only thing that has to survive minification.
 */
export const NOTE_TEXTURE_W = 256;
export const NOTE_TEXTURE_H = 111;

/**
 * One drawing operation, in texture pixels with the origin at the top left.
 *
 * A tagged union rather than a callback taking a `CanvasRenderingContext2D`,
 * and that is the whole reason this is testable: a callback can only be checked
 * by running it against a real canvas, which needs a DOM, which is exactly what
 * `server/index.ts` and a `bun -e` one-liner do not have. A list of records can
 * be walked by a renderer *and* asserted by a check, and the check is then about
 * the design ("the window is a lighter rectangle at one end") rather than about
 * pixels.
 *
 * The instruction was that the drop should "look like aussie $50s", which is a
 * claim about four things -- the colour, the window, the numeral and the word --
 * and each of them is one op below that `verifyCashDrops` can find by name.
 */
export type NoteOp =
  | { readonly op: 'fill'; readonly name: string; readonly colour: string; readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly radius: number }
  | { readonly op: 'text'; readonly name: string; readonly colour: string; readonly text: string; readonly x: number; readonly y: number; readonly px: number; readonly align: 'left' | 'centre' | 'right'; readonly weight: number };

/**
 * The whole of the note's design, as ops, at `NOTE_TEXTURE_W` x `NOTE_TEXTURE_H`.
 *
 * Taken in order and painted over each other. Deliberately eight operations --
 * the ground, a darker band, the window and its inner tint, two numerals, the
 * word and a small serial-ish tag -- because everything past that is detail that
 * does not survive minification to the 40 px a bundle occupies on screen at
 * five metres, and detail that does not survive is texture memory spent on
 * nothing.
 *
 * **The colours.** The Australian fifty is a deep yellow-gold that photographs
 * more orange than people remember. `#d6b260` is this interface's own money
 * gold -- the HUD balance, both maps' Centrelink dot -- and using it for the
 * ground is what ties the object on the pavement to the number in the corner of
 * the screen. The band under the window is that gold darkened, the window is it
 * lightened toward white, and the ink is a brown-black rather than a true black
 * because a pure black numeral on gold at this size reads as a hole.
 *
 * **The window is at the left end** because it is on the right end of the real
 * note and the geometry in `world/cashnote.ts` fans the stack from its left
 * edge -- so the windows end up on the outside of the fan, where they are
 * visible, rather than buried under the note above.
 */
export function noteOps(): readonly NoteOp[] {
  const W = NOTE_TEXTURE_W;
  const H = NOTE_TEXTURE_H;
  return [
    // The gold ground, the full sheet. Everything else is over it, so a renderer
    // that stopped after one op still draws something that reads as money.
    { op: 'fill', name: 'ground', colour: '#d6b260', x: 0, y: 0, w: W, h: H, radius: 6 },
    // A darker band across the bottom third: the note has a lot of printing down
    // there and at 40 px on screen what survives of it is a value change. It is
    // also what stops the note reading as a plain rectangle of one colour, which
    // is a Post-it.
    { op: 'fill', name: 'band', colour: '#b8934a', x: 0, y: Math.round(H * 0.68), w: W, h: Math.round(H * 0.32), radius: 0 },
    // The clear window: the single most identifiable feature of a polymer note,
    // and the one thing on it that is not ink. Drawn as a lighter rounded
    // rectangle rather than as actual transparency, because a hole in the
    // texture means an alpha-blended material and a second sort key for an
    // object there are up to 240 of in a street.
    { op: 'fill', name: 'window', colour: '#efdca8', x: Math.round(W * 0.045), y: Math.round(H * 0.12), w: Math.round(W * 0.13), h: Math.round(H * 0.76), radius: 8 },
    // A tint inside it, so the window has an edge rather than being a pale
    // patch. Two ops for a 33 x 84 px feature is the most detail anything on
    // this note gets, and it is spent here because this is the feature.
    { op: 'fill', name: 'window-inner', colour: '#f7edcf', x: Math.round(W * 0.06), y: Math.round(H * 0.19), w: Math.round(W * 0.1), h: Math.round(H * 0.62), radius: 6 },
    // The denomination, big, at the right end. The one thing that has to be
    // legible at range, so it is 54% of the sheet's height.
    { op: 'text', name: 'fifty', colour: '#4a3410', text: '50', x: Math.round(W * 0.9), y: Math.round(H * 0.42), px: Math.round(H * 0.54), align: 'right', weight: 800 },
    // And again, small, at the top left over the window -- notes carry the value
    // at both ends and the asymmetry of only one is what makes a rectangle look
    // like a label instead of currency.
    { op: 'text', name: 'fifty-small', colour: '#4a3410', text: '50', x: Math.round(W * 0.24), y: Math.round(H * 0.26), px: Math.round(H * 0.2), align: 'left', weight: 700 },
    // The word. Letter-spaced in the renderer; at this size it is a texture
    // rather than something anybody reads, and its job is to be the right
    // *shape* of word in the right place.
    { op: 'text', name: 'australia', colour: '#4a3410', text: 'AUSTRALIA', x: Math.round(W * 0.24), y: Math.round(H * 0.55), px: Math.round(H * 0.14), align: 'left', weight: 600 },
    // A serial-ish tag on the dark band. Six characters of nothing, and it is
    // here because the band is otherwise a plain stripe and one line of small
    // marks is what tells the eye the stripe is printed rather than painted.
    { op: 'text', name: 'serial', colour: '#e2c88c', text: 'AA 50 000', x: Math.round(W * 0.97), y: Math.round(H * 0.84), px: Math.round(H * 0.11), align: 'right', weight: 500 },
  ];
}

/**
 * How many notes are in the fan for an amount. 2..5.
 *
 * **Not `amount / 50`**, which is the obvious mapping and is wrong at both ends:
 * a $10 karen would drop a fifth of a note and a $2,000 wallet would drop forty.
 * What the count is *for* is telling a player from across the street whether the
 * pile is worth crossing it for, and three bands of thickness is all anybody can
 * read at that distance -- so it is a coarse ramp with a floor of two (one note
 * lying flat is a leaf) and a ceiling of five.
 *
 * The thresholds are the drop table's own steps, so an NPC's kind is legible in
 * the pile: $10 is two notes, $20-$30 is three, $50 is four, and anything above
 * -- which in practice means a death drop off a rich wallet -- is five.
 */
export function noteCount(amount: number): number {
  if (!(amount > 0)) return 2;
  if (amount < 20) return 2;
  if (amount < 50) return 3;
  if (amount < 100) return 4;
  return 5;
}

// --- The self-check ---------------------------------------------------------------

/**
 * The drop table, the rate bank and the note's design, asserted.
 *
 * Every failure here renders or pays out rather than throwing, which is the bar:
 *
 *   - **A kind with no entry.** A faction registered after this file silently
 *     pays nothing, which looks exactly like the drop feature not working for
 *     that kind and is reported as "the eshays don't drop money".
 *   - **Wildlife paying.** The Domain has an ibis every fifteen metres. This is
 *     the one entry whose being wrong turns the economy into a bird farm, and it
 *     is a single `0` in a table.
 *   - **A bank that does not bank.** The failure is invisible by construction:
 *     the money simply arrives, and the person testing it is delighted.
 *   - **A window boundary that pays double.** The reason this is a sliding
 *     counter and not a tumbling one, driven below.
 *   - **A note that is the wrong shape or has no window.** *"make it look like
 *     aussie $50s"* is the whole of the instruction on the visual, and a texture
 *     that quietly became a plain gold rectangle is a texture nobody files a bug
 *     about -- they just stop reading the pile as money.
 *
 * Three-free, and run on both ends:
 *
 *     bun -e "import {verifyCashDrops} from './client/src/game/cashnote.ts'; console.log(verifyCashDrops())"
 */
export function verifyCashDrops(): string[] {
  const failures: string[] = [];

  // --- The table: every kind accounted for, the instruction's numbers exactly,
  //     and nothing paid for a protected native.
  {
    const want: Array<[string, number, number]> = [
      ['police', NPC_KIND.POLICE, 50],
      ['eshay', NPC_KIND.ESHAY, 20],
      ['tradie', NPC_KIND.TRADIE, 30],
      ['agent', NPC_KIND.AGENT, 50],
      ['influencer', NPC_KIND.INFLUENCER, 20],
      ['karen', NPC_KIND.KAREN, 10],
      ['methhead', NPC_KIND.METHHEAD, 10],
      ['drunk', NPC_KIND.DRUNK, 10],
      ['turkey', NPC_KIND.TURKEY, 0],
      ['ibis', NPC_KIND.IBIS, 0],
      ['magpie', NPC_KIND.MAGPIE, 0],
    ];
    for (const [name, kind, dollars] of want) {
      const got = npcDropAmount(kind);
      if (got !== dollars) failures.push(`A ${name} drops $${got}; the instruction says $${dollars}.`);
    }
    // Every registered kind has an *entry*, which is a different claim from
    // every kind having the right entry: a new faction's byte falling off the
    // end of the array reads as "that one is worth nothing", which is a
    // legitimate answer and therefore an invisible mistake. The three vehicles
    // are exempt because they are the kinds whose answer genuinely is zero.
    const vehicles = new Set<number>([NPC_KIND.HIGHWAY_PATROL, NPC_KIND.POLAIR, NPC_KIND.RBT]);
    const wild = new Set<number>([NPC_KIND.TURKEY, NPC_KIND.IBIS, NPC_KIND.MAGPIE]);
    for (const [name, kind] of Object.entries(NPC_KIND) as Array<[string, number]>) {
      if (vehicles.has(kind) || wild.has(kind)) continue;
      if (kind >= DROP_BY_KIND.length) {
        failures.push(`NPC_KIND.${name} is byte ${kind}, past the end of the drop table; it will silently pay nothing.`);
        continue;
      }
      if (npcDropAmount(kind) <= 0) {
        failures.push(`NPC_KIND.${name} drops nothing. Every person in the city is worth something; only the wildlife and the cars are not.`);
      }
    }
    // And an unregistered byte pays nothing rather than the last row of the
    // table or `undefined` dollars.
    if (npcDropAmount(200) !== 0 || npcDropAmount(-1) !== 0) {
      failures.push(`An unknown kind byte dropped $${npcDropAmount(200)}.`);
    }
  }

  // --- The bank: pays, then stops, then pays again a minute later.
  {
    const bank = createNpcCashBank();
    const t0 = 1_000_000;
    let paid = 0;
    // Four constables in ten seconds is exactly the allowance.
    for (let i = 0; i < 4; i++) paid += bankAllow(bank, 50, t0 + i * 2_000);
    if (paid !== NPC_CASH_BANK) {
      failures.push(`Four $50 knockouts inside the window paid $${paid}; the bank is $${NPC_CASH_BANK}.`);
    }
    // The fifth pays nothing at all, and the body still falls over -- the caller
    // treats 0 as "no bundle", not as "no knockout".
    if (bankAllow(bank, 50, t0 + 9_000) !== 0) {
      failures.push('A fifth knockout inside one minute still paid. The bank does not bank.');
    }
    // Still nothing halfway through the *same* window: the spend is all in
    // `current`, and `current` does not decay. That is the counter being a
    // counter rather than a bucket that leaks -- a leaky bucket would let a
    // player take $100 at 0:00 and another $50 at 0:15, which is $150 in fifteen
    // seconds and is the burst the cap exists to stop.
    if (bankAllow(bank, 200, t0 + NPC_CASH_WINDOW_MS * 0.5) !== 0) {
      failures.push('The bank released money halfway through the window it was emptied in.');
    }
    // Half a window *past the roll*, the previous window is pro-rated to half
    // and about half the bank is back.
    const half = bankAllow(bank, 200, t0 + NPC_CASH_WINDOW_MS * 1.5);
    if (!(half > NPC_CASH_BANK * 0.4 && half < NPC_CASH_BANK * 0.6)) {
      failures.push(`Half a window after the roll the bank released $${half}; the sliding estimate should have freed about half.`);
    }
    // A long silence releases the lot.
    const later = createNpcCashBank();
    bankAllow(later, 200, t0);
    const after = bankAllow(later, 200, t0 + NPC_CASH_WINDOW_MS * 3);
    if (after !== NPC_CASH_BANK) {
      failures.push(`After three idle windows the bank released $${after} rather than the full $${NPC_CASH_BANK}.`);
    }
  }

  // --- The boundary, which is the entire reason this is a sliding counter.
  //
  // A tumbling window resets on the minute, so a farmer who empties the bank at
  // 0:59 and again at 1:01 takes $400 in two seconds. Driven here at exactly
  // that: the second burst must be refused almost entirely, because at one
  // second past the boundary the previous window still counts for 98% of itself.
  {
    const bank = createNpcCashBank();
    const t0 = 500_000;
    let first = 0;
    for (let i = 0; i < 4; i++) first += bankAllow(bank, 50, t0 + i * 100);
    let second = 0;
    for (let i = 0; i < 4; i++) second += bankAllow(bank, 50, t0 + NPC_CASH_WINDOW_MS + 1_000 + i * 100);
    if (first + second > NPC_CASH_BANK * 1.1) {
      failures.push(
        `Emptying the bank either side of a window boundary took $${first + second} in 61 seconds ` +
          `against a $${NPC_CASH_BANK} cap. That is the hole a tumbling window leaves and the reason ` +
          `this is a two-bucket sliding counter.`,
      );
    }
  }

  // --- Partial payment, so the tail of a window is not unspendable.
  {
    const bank = createNpcCashBank();
    const t0 = 42;
    bankAllow(bank, 170, t0);
    const rest = bankAllow(bank, 50, t0 + 100);
    if (rest !== 30) {
      failures.push(`With $30 of allowance left a $50 body paid $${rest}. The remainder is paid out rather than refused.`);
    }
    if (bankAllow(bank, 50, t0 + 200) !== 0) failures.push('The bank went negative.');
  }

  // --- Rubbish in. A negative or `NaN` amount must not credit anybody, and must
  //     not corrupt the bank for the next real payment.
  {
    const bank = createNpcCashBank();
    for (const silly of [0, -50, NaN, Infinity, -Infinity]) {
      if (bankAllow(bank, silly, 1000) !== 0) failures.push(`bankAllow paid out for a want of ${silly}.`);
    }
    if (bankAllow(bank, 50, 1000) !== 50) failures.push('A rubbish amount left the bank unable to pay a real one.');
  }

  // --- The note. The dimensions the instruction named, and the four features
  //     that make a gold rectangle read as a fifty.
  {
    if (Math.abs(NOTE_LENGTH_M - 0.15) > 1e-9 || Math.abs(NOTE_HEIGHT_M - 0.065) > 1e-9) {
      failures.push(`The note is ${NOTE_LENGTH_M} x ${NOTE_HEIGHT_M} m; the brief's slab is 0.15 x 0.065.`);
    }
    // The texture holds the note's own aspect, or the numeral is stretched.
    const paper = NOTE_LENGTH_M / NOTE_HEIGHT_M;
    const texture = NOTE_TEXTURE_W / NOTE_TEXTURE_H;
    if (Math.abs(paper - texture) > 0.05) {
      failures.push(
        `The note is ${paper.toFixed(2)}:1 and its texture is ${texture.toFixed(2)}:1. Everything drawn ` +
          `on it is stretched by the difference.`,
      );
    }

    const ops = noteOps();
    const by = (name: string): NoteOp | undefined => ops.find((o) => o.name === name);

    // Every op lands inside the sheet. One that did not would be clipped
    // silently by the canvas and the feature would simply be missing.
    for (const o of ops) {
      if (o.op === 'fill') {
        if (o.x < 0 || o.y < 0 || o.x + o.w > NOTE_TEXTURE_W || o.y + o.h > NOTE_TEXTURE_H) {
          failures.push(`The "${o.name}" fill runs off the sheet: ${o.x},${o.y} ${o.w}x${o.h} on ${NOTE_TEXTURE_W}x${NOTE_TEXTURE_H}.`);
        }
        if (!(o.w > 0 && o.h > 0)) failures.push(`The "${o.name}" fill has no area.`);
      } else {
        if (o.x < 0 || o.x > NOTE_TEXTURE_W || o.y < 0 || o.y > NOTE_TEXTURE_H) {
          failures.push(`The "${o.name}" text is placed at ${o.x},${o.y}, outside the sheet.`);
        }
        if (!(o.px > 0)) failures.push(`The "${o.name}" text has no size.`);
      }
      if (!/^#[0-9a-f]{6}$/i.test(o.colour)) failures.push(`The "${o.name}" op's colour ${JSON.stringify(o.colour)} is not a six-digit hex.`);
    }

    // 1. The ground covers the whole sheet. A note with an uncovered corner
    //    shows whatever the canvas was cleared to, which is transparent black.
    const ground = by('ground');
    if (!ground || ground.op !== 'fill' || ground.w < NOTE_TEXTURE_W || ground.h < NOTE_TEXTURE_H) {
      failures.push('The gold ground does not cover the whole note.');
    }
    // 2. The window: lighter than the ground, at one end, and a real fraction of
    //    the note. This is the feature anybody in this country identifies a
    //    polymer note by, and it is the one most likely to be quietly dropped in
    //    a "simplify the texture" pass.
    const win = by('window');
    if (!win || win.op !== 'fill') {
      failures.push('The note has no clear window. It is the single most identifiable thing about an Australian note.');
    } else {
      if (!(win.w >= NOTE_TEXTURE_W * 0.08 && win.w <= NOTE_TEXTURE_W * 0.25)) {
        failures.push(`The window is ${((win.w / NOTE_TEXTURE_W) * 100).toFixed(0)}% of the note's length; a real one is about 15%.`);
      }
      if (!(win.x < NOTE_TEXTURE_W * 0.3 || win.x + win.w > NOTE_TEXTURE_W * 0.7)) {
        failures.push('The window is in the middle of the note. It belongs at one end.');
      }
      if (!(win.radius > 0)) failures.push('The window has square corners; the real one is a rounded slot.');
      if (ground && ground.op === 'fill' && luminance(win.colour) <= luminance(ground.colour)) {
        failures.push('The window is not lighter than the ground, so it will not read as a window.');
      }
    }
    // 3. The numeral, large. This is the only thing on the note that has to
    //    survive being 40 px wide on screen.
    const fifty = by('fifty');
    if (!fifty || fifty.op !== 'text' || fifty.text !== '50') {
      failures.push(`The note's denomination is ${JSON.stringify(fifty && fifty.op === 'text' ? fifty.text : null)}, not "50".`);
    } else if (!(fifty.px >= NOTE_TEXTURE_H * 0.4)) {
      failures.push(`The "50" is ${((fifty.px / NOTE_TEXTURE_H) * 100).toFixed(0)}% of the note's height; under 40% it is gone at range.`);
    }
    // 4. The word, small.
    const word = by('australia');
    if (!word || word.op !== 'text' || word.text !== 'AUSTRALIA') {
      failures.push('The note does not say AUSTRALIA.');
    } else if (!(word.px < NOTE_TEXTURE_H * 0.25)) {
      failures.push('AUSTRALIA is drawn as large as the denomination; it is the small print.');
    }
    // 5. And nothing that is a reproduction. No op may carry a portrait, a
    //    signature or a coat of arms -- this is a check on the *design's* intent
    //    and it is cheap: the design is a list, so a future pass that adds one
    //    has to add a named op and this says no.
    for (const o of ops) {
      if (/portrait|face|head|arms|crest|signature|emu|kangaroo/i.test(o.name)) {
        failures.push(
          `The note carries a "${o.name}". It is deliberately a stylised note: no portrait, no crest, ` +
            `nothing traceable to the real artwork. See this file's header.`,
        );
      }
    }
  }

  // --- The fan: coarse, bounded, and monotone in the amount.
  {
    let previous = 0;
    for (const amount of [0, 10, 20, 30, 50, 80, 100, 5000]) {
      const n = noteCount(amount);
      if (n < 2 || n > 5) failures.push(`$${amount} draws ${n} notes; the fan is 2 to 5.`);
      if (n < previous) failures.push(`$${amount} draws fewer notes than the amount below it.`);
      previous = n;
    }
    if (noteCount(10) === noteCount(50)) {
      failures.push('A $10 karen and a $50 constable leave the same pile; the fan is meant to be readable from the far side of the street.');
    }
  }

  return failures;
}

/** Rec. 709 luma of a `#rrggbb`, for the "is the window lighter" test. */
function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
