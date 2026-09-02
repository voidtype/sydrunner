/**
 * Five more people who live here: the **eshay**, the **Karen**, the **tradie**,
 * the **Bondi influencer** and the **real estate agent**.
 *
 * The simulation half. `world/characters.ts` is what they look like, and the
 * split is `game/streetlife.ts` against `world/streetlife.ts` exactly and for
 * the identical reason: this file is compiled into the Bun server and must not
 * drag a `SkinnedMesh` in behind a proximity test.
 *
 * Everything here is a *consumer* of `game/factions.ts` and edits three lines of
 * it: five kind bytes claimed in `NPC_KIND`, one reason code in `REASON`, and
 * one optional hook on `NpcKindDef` that lets a faction say what hitting it
 * means without the meth heads having to know. The lifecycle, the eviction, the
 * damage door, the crime call and the witness query all come from that module
 * unchanged.
 *
 * ---------------------------------------------------------------------------
 * 1. FIVE CHARACTERS, FIVE VERBS, AND WHY THAT IS THE WHOLE DESIGN
 *
 * `game/streetlife.ts` earned its two factions by making them differ in exactly
 * one word -- *on sight* against *on proximity*. Five is too many to separate
 * that way, so they are separated by **what they do to you**, and no two of
 * them do the same thing:
 *
 *   - the **eshay** *takes* -- a shove, a knockdown and twenty dollars, and the
 *     only faction in the game that reaches for `wallet-contract.ts`.
 *   - the **Karen** *reports* -- she is a witness, and she is the only thing in
 *     the build besides a constable that can turn an unwitnessed crime into a
 *     witnessed one.
 *   - the **tradie** *helps* -- he picks you up off the footpath, and he is the
 *     only NPC in the game that does something a player wants.
 *   - the **influencer** *obstructs* -- she stands in the middle of the
 *     footpath and everybody paths around her, and she is the only ambient
 *     person in the city with a collision consequence.
 *   - the **agent** *talks* -- and nothing else, ever, which is the joke.
 *
 * If two of them shared a verb, one of them would be a reskin. They do not, so
 * the five of them are five encounters, and the whole of the tuning below is in
 * service of that list rather than of any individual number.
 *
 * ---------------------------------------------------------------------------
 * 2. WHERE THEY STAND: A CELL GRID, NOT AN ANCHOR TABLE
 *
 * `game/streetlife.ts` hangs its loiterers off two baked tables -- 837 suburb
 * centroids and 642 pub doorways -- because a meth head belongs to a *suburb*
 * and a drunk belongs to a *pub*, and those are real objects with real
 * coordinates. None of these five belongs to an object like that. A tradie
 * belongs to "wherever there is building going on", a Karen to "a suburban
 * shopping strip", an agent to "in front of a house". Baking a table of those
 * would be baking five opinions and calling them data, which is the thing
 * `POLICE_STATIONS`' header spends two pages refusing to do.
 *
 * So the anchor is the **cell**: a 420 m square grid over the whole extent,
 * exactly `factions.PATROL_CELL`'s arrangement one size up. For a cell, each
 * character kind asks two questions --
 *
 *     count = round( CELL_BASE * crowdMultiplier(cx, cz) * bias(cx, cz, phase) )
 *
 * -- and then places that many people on real footpath bands inside the cell.
 * `density.crowdMultiplier` is the ABS 2021 census field and carries the
 * geography; `bias` is this file's taste and carries the character. The split is
 * `density.ts`'s own and it is the reason both halves can be argued separately:
 * nobody has to defend "the inner west has more Karens per resident" and "the
 * inner west has more residents" in the same sentence.
 *
 * The bias functions are a **table** rather than five methods, and they are
 * pure functions of `(x, z, phase)` with no branches on anything else, because
 * `verifyCharacters` walks the table and asserts every one of them is finite,
 * non-negative and actually different from the others. A bias that quietly
 * returned 1 everywhere would put eshays in Mosman and nothing would throw.
 *
 * **The ABS field is per-SA1 rendered onto 500 m cells** (`density-data.ts`), so
 * it is smoother than a suburb boundary and much smoother than a street. That
 * is the right resolution for this: the question being asked is "is this the
 * kind of area where you meet one of these", not "is this the specific corner".
 *
 * ---------------------------------------------------------------------------
 * 3. AND WHEN: THE SERVER'S CLOCK, NOT THE WALL'S
 *
 * Four of the five are time-gated, and the gate is `sky/cycle.ts`'s phase --
 * 0 at solar midnight, 0.25 at sunrise, 0.75 at sunset -- taken from the shared
 * tick rather than from `Date.now()`. `game/rave.ts` makes the identical
 * argument at length and it is not restated: a character who disagreed with the
 * sky about what time it is would be an eshay at a station in the afternoon.
 *
 * `TRAFFIC_EPOCH_MS` and `CYCLE_EPOCH_MS` are the same millisecond, which is
 * what makes `dayAt(tick)` two divides and no wall clock at all. `verifyCycle`
 * would not catch them drifting apart, so `verifyCharacters` does.
 *
 * "Saturday" is **every seventh in-game day**, `index % 7 === 6`. It is
 * arbitrary and it is written down; the alternative offered was "every day from
 * 10:00 to 14:00", which is not a Saturday, it is lunchtime. One in-game day is
 * one real hour, so a Saturday comes round every seven hours of real play and a
 * player who never sees one is a player who played for six hours -- which is why
 * `SATURDAY_MODULUS` is checked by the self-check rather than trusted, and why
 * `saturdayAt` is exported for the two events that need the same answer.
 *
 * ---------------------------------------------------------------------------
 * 4. THEY DO NOT TALK OVER THE WIRE
 *
 * Every line of dialogue in this file is a **string constant read by the
 * client**, delivered as a `hud.notice`, and none of it is authoritative.
 *
 * There is no audio for these five. `client/public/audio` holds fourteen clips
 * and they are a police officer, a drunk and a meth head; handing an eshay the
 * drunk's recording would be worse than silence, and generating four hundred
 * kilobytes of synthetic speech for a bit would fail the brief's own budget. So
 * `aggroClips` is empty on all five, which `FactionField.bark` already treats as
 * "this kind does not bark" -- the framework needed no change for it.
 *
 * What replaces it is text, and text has one property audio does not: it can be
 * a pure function of the person and the tick, so it needs no wire at all. See
 * `lineFor`. The client asks who is nearby, asks this file what they are
 * saying, and prints it. The server never knows and never has to.
 *
 * ---------------------------------------------------------------------------
 * 5. THE AGENT, AND THE ONE EDITORIAL DECISION WORTH DEFENDING
 *
 * `REASON.REAL_ESTATE`'s banner reads *"assaulting a real estate agent
 * (understandable)"*, and it is the only line in this project where the
 * interface has an opinion about what you did.
 *
 * It is there because the alternative reads worse. The banner's job is to tell
 * you which of your last four actions started the countdown; for four of these
 * five characters "assaulting a bystander" does that job exactly. For the agent
 * it does not, because the player did not experience it as assaulting a
 * bystander -- and a banner that describes an interaction differently from the
 * way the player experienced it is a banner they stop reading. The police still
 * come. The countdown is the same length. The joke costs one reason byte and
 * changes no behaviour, which is the only kind of joke this codebase can afford.
 *
 * ---------------------------------------------------------------------------
 * 6. DETERMINISM. `game/factions.ts` rule 5, in force, plus one.
 *
 * No `Math.hypot`, no `sin`, `cos` or `atan2` on any shared path, every random
 * choice out of `traffic.carHash`. The idle is `streetlife.triangle`, imported
 * rather than re-derived -- a second triangle wave in this project would be a
 * second answer to a question with one.
 *
 * The addition is the **bias table**. Every function in it is arithmetic on
 * `(x, z, phase)` with `Math.sqrt`, `Math.min`, `Math.max` and `Math.abs` and
 * nothing else. `Math.sqrt` is exact in IEEE-754 and the other three are
 * comparisons; there is deliberately no `Math.exp` in the table even though a
 * Gaussian falloff would read slightly nicer than the linear one, because
 * `Math.exp` is implementation-defined and a Karen half a metre out of place on
 * the server is a Karen who reports a crime the client thinks she could not see.
 * `density.crowdMultiplier` does call `Math.exp` -- but it is called with the
 * *cell centre*, an exactly representable multiple of 500 minus 62,000, so both
 * engines are evaluating the same finite set of inputs and the count that comes
 * out is rounded to an integer. `verifyCharacters` asserts the rounding has
 * margin at every cell it samples rather than assuming it.
 */

import { type CombatantState } from './combat.ts';
import { isAboard } from './riding.ts';
import {
  MAX_ACTORS,
  NPC_KIND,
  NPC_STATE,
  REASON,
  registerNpcKind,
  reportCrime,
  type FactionCtx,
  type FactionField,
  type NpcActor,
} from './factions.ts';
import { crowdMultiplier } from './density.ts';
import { PedestrianField, syntheticGrid, type PedBand } from './pedestrians.ts';
import { triangle } from './streetlife.ts';
import { TRAFFIC_EPOCH_MS, carHash, trafficSeconds } from './traffic.ts';
import { CYCLE_EPOCH_MS, CYCLE_MS, SUNRISE_PHASE, SUNSET_PHASE } from '../sky/cycle.ts';
import { EYE_HEIGHT } from '../player/controller.ts';
import { wallet } from './wallet-contract.ts';
// WORKSTREAM Z: `Tradie Rates`' third clause and `Karen Rapport`'s second. Both
// are one question to the talent lookup; see `game/teamfx.ts`.
import { fxTradieAlly } from './teamfx.ts';
import type { CollisionWorld } from '../player/collision.ts';

// --- The clock ------------------------------------------------------------------------

/**
 * What in-game day it is, and how far through it, from the **shared tick**.
 *
 * `traffic.TRAFFIC_EPOCH_MS` and `cycle.CYCLE_EPOCH_MS` are the same
 * millisecond, which is the only reason this is arithmetic rather than a wall
 * clock read. `verifyCharacters` asserts it: the day they drift apart, every
 * character in this file is active at the wrong time of day and the sky is the
 * only thing that says so.
 *
 * The phase convention is `sky/cycle.cyclePhase`'s exactly -- 0 in the dead of
 * night, 0.25 at sunrise, 0.75 at sunset -- and **not** `rave.raveNight`'s
 * dusk-rotated one. The rotation exists there because a rave spans a night and
 * would otherwise carry two indices; nothing here spans midnight, so the plain
 * convention is the right one and adopting the rave's would have made "Saturday"
 * start at six in the evening on Friday.
 */
export interface GameDay {
  /** In-game days since the epoch. The seed everything is hashed on. */
  readonly index: number;
  /** 0 at solar midnight, 0.25 sunrise, 0.75 sunset. Always in [0, 1). */
  readonly phase: number;
}

/** Milliseconds since the epoch for a shared tick. One multiply; exactly specified. */
export function tickMs(tick: number): number {
  return TRAFFIC_EPOCH_MS + trafficSeconds(tick) * 1000;
}

/** The day and phase at a wall-clock instant. `cyclePhase`, with the index kept. */
export function dayAt(nowMs: number): GameDay {
  const elapsed = nowMs - CYCLE_EPOCH_MS;
  const index = Math.floor(elapsed / CYCLE_MS);
  return { index, phase: (elapsed - index * CYCLE_MS) / CYCLE_MS };
}

/** The day and phase at a shared tick. What every consumer in this file uses. */
export function dayAtTick(tick: number): GameDay {
  return dayAt(tickMs(tick));
}

/**
 * How many in-game days there are in a week. **Seven, and it is a decision.**
 *
 * One in-game day is one real hour (`cycle.CYCLE_MS`), so a seven-day week is
 * seven hours of real time and a Saturday comes round about once a session-day.
 * A shorter week would make the Saturday content ordinary and a longer one would
 * make it unreachable. It is exported because `game/events.ts` schedules two of
 * its five events on the same answer and a second copy of the modulus would be a
 * second calendar.
 */
export const WEEK_DAYS = 7;
export const SATURDAY_MODULUS = 6;
export const SUNDAY_MODULUS = 0;

/** Whether an in-game day index is the Saturday-equivalent. See `WEEK_DAYS`. */
export function saturdayAt(dayIndex: number): boolean {
  // `((i % n) + n) % n` rather than `i % n`, because a machine whose clock is
  // set before the epoch produces a negative index and `%` in JavaScript keeps
  // the sign. Everything else in this file floors toward minus infinity; this is
  // the one place a raw `%` would not.
  return ((dayIndex % WEEK_DAYS) + WEEK_DAYS) % WEEK_DAYS === SATURDAY_MODULUS;
}

/** And the Sunday-equivalent, for the half of the weekend trackwork also ruins. */
export function sundayAt(dayIndex: number): boolean {
  return ((dayIndex % WEEK_DAYS) + WEEK_DAYS) % WEEK_DAYS === SUNDAY_MODULUS;
}

/** Either of them. `game/events.ts`'s weekend gate. */
export function weekendAt(dayIndex: number): boolean {
  return saturdayAt(dayIndex) || sundayAt(dayIndex);
}

/** Whether a phase is between sunrise and sunset. One comparison pair, stated once. */
export function daylight(phase: number): boolean {
  return phase >= SUNRISE_PHASE && phase < SUNSET_PHASE;
}

/**
 * How lit the far city's slabs are at this phase, 0..1: full by day, a
 * fraction at night, and a short ramp either side of sunrise and sunset so
 * the horizon dims with the sky rather than switching. `NIGHT_SLAB` is not
 * zero: a black slab against a dark sky is a hole in the skyline, and the
 * city's own glow keeps a silhouette readable. `world/far.ts` applies it.
 */
export const NIGHT_SLAB = 0.14;
export const SLAB_RAMP = 0.02;
export function slabLight(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  const ramp = (edge: number, t: number): number => Math.max(0, Math.min(1, (t - edge) / SLAB_RAMP + 0.5));
  const day = Math.min(ramp(SUNRISE_PHASE, p), 1 - ramp(SUNSET_PHASE, p));
  return NIGHT_SLAB + (1 - NIGHT_SLAB) * day;
}

// --- The stations ------------------------------------------------------------------------

/**
 * Every railway station in the built extent, as a forecourt position.
 *
 * **Baked, with provenance.** Extracted from `client/public/rail/rail.bin` --
 * the same bake `world/trains.ts` draws from and `server/ride-acceptance.ts`
 * tests against -- by a read-only scratch driver that took each station's
 * `siteX`/`siteZ` and nothing else. 267 stations after a 30 m dedupe, which
 * folded nothing: no two calling sites in the bake are within 30 m of each
 * other, and the figure is `streetlife.VENUE_XZ`'s so the two tables cannot
 * disagree about what a duplicate is.
 *
 * `siteX`/`siteZ` rather than the OSM station node, and `game/rail.RailStation`
 * argues that at length from the other side: the node is wherever a mapper put a
 * dot -- 126 m from the platform at Central -- and the *site* is the mean of
 * every calling anchor, which is where a station box, a stair and a name board
 * belong. It is therefore where a forecourt is, which is the only thing this
 * file wants from a station.
 *
 * ---------------------------------------------------------------------------
 * **A table rather than a read of the bake, and the reason is the server.**
 *
 * `rail.bin` is 1.8 MB and is loaded by the renderer. This module is compiled
 * into the Bun server, where nothing loads it, and into `server/sim.ts`'s hot
 * path, where an async load has nowhere to go. `factions.POLICE_STATIONS` faced
 * exactly this and gave exactly this answer: 267 records is 7 kB of source, the
 * coordinates cannot change without the world changing, and a sidecar would be a
 * fetch, a decoder, a version word and a failure mode.
 *
 * Sorted by distance from Town Hall and **append-only from here**, on
 * `POLICE_STATIONS`' terms: `stationSeed` is the rounded position rather than
 * the index, so a re-sort would not move anybody -- but `verifyCharacters`
 * asserts the ordering anyway, because a table that claims to be sorted and is
 * not is a table whose `nearestStation` early-outs are wrong.
 *
 * `name|x|z`, records separated by `;`, parsed once at module load.
 * `streetlife.SUBURBS_STAGE4_PACKED`'s format and its argument.
 */
const STATIONS_PACKED =
  'Martin Place|97.5|-126.3;St James|236.4|225.8;QVB|-210.4|311.0;Wynyard|-323.5|-259.6;Bridge Stre'
  + 'et|-179.6|-515.4;Gadigal|-56.1|561.8;Town Hall|-217.8|548.4;Museum|80.8|783.3;Circular Quay|87.9'
  + '|-831.1;Pyrmont Bay|-1083.1|88.3;Convention|-1031.5|437.1;Chinatown|-326.9|1094.3;Barangaroo|-63'
  + '4.6|-1007.8;Capitol Square|-314.4|1226.2;Exhibition Centre|-876.0|952.4;The Star|-1298.0|-103.6;'
  + 'Paddy\'s Markets|-588.7|1177.1;Kings Cross|1207.1|610.0;Haymarket|-340.2|1409.5;Central Grand Con'
  + 'course|-212.1|1513.4;Wentworth Park|-1400.7|644.7;Bank Street|-1555.7|264.4;John Street Square|-'
  + '1599.7|-124.0;Central Chalmers Street|-121.7|1712.0;Central|-237.3|1739.8;Surry Hills|275.1|2136'
  + '.0;Glebe|-2007.9|968.2;Milsons Point|188.1|-2548.3;Edgecliff|2502.1|1116.5;Redfern|-969.5|2604.2'
  + ';Jubilee Park|-2815.7|784.8;Moore Park|1204.9|2733.5;North Sydney|-223.3|-3055.3;Waterloo|-773.6'
  + '|3219.9;Rozelle Bay|-3377.8|399.5;Waverton|-1138.3|-3386.2;Victoria Cross|-232.6|-3619.9;Macdona'
  + 'ldtown|-2108.7|3143.2;Lilyfield|-4081.0|667.4;Green Square|-562.0|4158.8;Erskineville|-2151.0|36'
  + '06.3;Newtown|-2678.5|3269.3;ES Marks|1426.2|4060.0;Bondi Junction|3654.6|2421.7;Royal Randwick|1'
  + '878.0|4002.3;Wollstonecraft|-1698.9|-4084.3;Kensington|1378.1|4481.8;Crows Nest|-1011.0|-4758.5;'
  + 'St Peters|-2568.2|4324.4;Stanmore|-4149.9|2918.0;Leichhardt North|-5090.1|776.2;Wansey Road|2474'
  + '.9|4583.2;St Leonards|-1489.6|-5116.6;UNSW Anzac Parade|1627.7|5282.6;Petersham|-4941.8|2858.3;U'
  + 'NSW High Street|2517.9|5234.6;Hawthorne|-5720.8|1296.0;Randwick|2982.5|5309.5;Kingsford|1726.7|5'
  + '847.6;Marion|-5906.6|1788.0;Lewisham|-5652.5|2816.8;Taverners Hill|-5883.2|2363.5;Mascot|-1931.8'
  + '|6067.6;Sydenham|-3908.3|5163.8;Juniors Kingsford|1948.2|6206.6;Lewisham West|-6045.2|2884.8;Sum'
  + 'mer Hill|-6477.6|2493.7;Artarmon|-2352.1|-6608.3;Marrickville|-5061.0|5100.0;Waratah Mills|-6337'
  + '.0|3439.9;Arlington|-6519.8|3786.4;Dulwich Grove|-6426.3|4133.5;Domestic Airport|-2502.7|7238.5;'
  + 'Tempe|-4778.0|6268.2;Dulwich Hill|-6290.8|4775.6;Ashfield|-7680.5|2218.9;Chatswood|-2763.2|-7863'
  + '.1;International Airport|-3886.3|7410.0;Wolli Creek|-5016.0|6698.7;Hurlstone Park|-7085.5|4762.7'
  + ';Croydon|-8639.3|1755.2;Turrella|-6291.3|6892.8;Arncliffe|-5587.1|7605.5;Canterbury|-8299.2|4946'
  + '.5;Burwood|-9720.2|1096.6;Roseville|-3102.4|-9312.2;Bardwell Park|-7682.3|7103.0;North Ryde|-672'
  + '8.8|-8148.8;Banksia|-6217.5|8602.2;Strathfield|-10634.5|512.7;Campsie|-9780.5|4808.3;Lindfield|-'
  + '3887.3|-10271.4;North Strathfield|-11234.1|-880.7;Homebush|-11371.4|-9.2;Rockdale|-6519.0|9338.0'
  + ';Concord West|-11489.3|-2055.3;Bexley North|-8723.2|7782.3;Macquarie Park|-7657.0|-9152.7;Rhodes'
  + '|-11386.6|-4038.9;Killara|-4608.6|-11379.2;Belmore|-11055.6|5568.2;Meadowbank|-11136.2|-5666.5;K'
  + 'ogarah|-6905.4|10480.8;Kingsgrove|-9905.4|8139.0;Flemington|-12898.8|-202.6;West Ryde|-11138.6|-'
  + '6651.8;Olympic Park|-12982.5|-2222.8;Macquarie University|-8622.2|-9973.0;Gordon|-5314.6|-12439.'
  + '0;Carlton|-7640.3|11176.3;Lakemba|-12237.0|5914.7;Denistone|-11422.3|-7443.9;Allawah|-8564.2|113'
  + '52.8;Wiley Park|-13019.6|6244.2;Eastwood|-11915.6|-8512.6;Hurstville|-9675.5|11119.0;Beverly Hil'
  + 'ls|-11698.1|9117.0;Pymble|-6476.3|-13652.3;Lidcombe|-15162.9|-267.2;Penshurst|-10911.1|10997.1;P'
  + 'unchbowl|-14084.9|6536.2;Narwee|-12698.5|8969.5;Epping|-11963.7|-10427.8;Berala|-16367.7|645.4;M'
  + 'ortdale|-11644.7|11531.7;Auburn|-16365.8|-1865.8;Turramurra|-7761.7|-15002.8;Bankstown|-16011.8|'
  + '5723.7;Regents Park|-17086.0|1870.7;Riverwood|-14366.6|9436.8;Oatley|-11819.4|12607.1;Birrong|-1'
  + '7075.6|2996.8;Cheltenham|-12330.9|-12323.2;Telopea|-15712.9|-7966.6;Yagoona|-17031.9|4522.0;Dund'
  + 'as|-16426.6|-6909.8;Carlingford|-15179.9|-9356.3;Yallamundi|-16779.3|-6220.3;Warrawee|-8396.0|-1'
  + '5890.6;Rosehill Gardens|-17204.5|-5305.0;Clyde|-17856.3|-3310.4;Sefton|-18264.4|2161.2;Tramway A'
  + 'venue|-17759.9|-5397.9;Granville|-18291.0|-3625.3;Beecroft|-13470.5|-12976.5;Padstow|-16194.5|95'
  + '16.4;Wahroonga|-8844.8|-16622.2;Robin Thomas|-18436.8|-5416.3;Pennant Hills|-12924.9|-14287.8;Ha'
  + 'rris Park|-18751.8|-4698.6;Normanhurst|-10687.1|-16221.1;Thornleigh|-12402.6|-14978.3;Chester Hi'
  + 'll|-19384.0|1992.9;Parramatta|-18974.0|-5338.9;Parramatta Square|-19002.1|-5557.2;Como|-12782.5|'
  + '15269.1;Prince Alfred Square|-19004.3|-6276.2;Church Street|-19147.8|-5843.6;Fennell Street|-189'
  + '59.3|-6708.2;Waitara|-10038.4|-17437.4;Revesby|-17803.3|9616.1;Merrylands|-20141.3|-3176.7;Benau'
  + 'd Oval|-19086.7|-7190.8;Ngara|-19379.3|-7113.6;Woolooware|-5673.6|19942.7;Caringbah|-7656.7|1930'
  + '6.0;Leightonfield|-20701.4|1796.2;Guildford|-20828.9|-1221.2;Hornsby|-10602.2|-18145.3;Miranda|-'
  + '9518.1|18754.1;Jannali|-13076.0|16562.0;Childrens Hospital|-20149.7|-6973.2;Cronulla|-4977.3|208'
  + '24.9;Westmead Hospital|-20419.2|-6732.8;Westmead|-20635.0|-6320.2;Villawood|-21540.6|1741.1;Gyme'
  + 'a|-11107.3|18626.2;Panania|-19377.0|9846.8;Cherrybrook|-16697.5|-14359.8;Yennora|-22039.8|-52.6;'
  + 'Asquith|-9731.0|-19806.8;Kirrawee|-12363.1|18656.5;Sutherland|-13721.7|18312.9;Wentworthville|-2'
  + '2025.9|-6426.4;Carramar|-22888.4|2148.1;East Hills|-20576.4|10709.9;Fairfield|-23332.0|836.5;Mou'
  + 'nt Colah|-9167.3|-21671.8;Castle Hill|-18937.4|-14884.8;Loftus|-14239.7|19844.7;Pendle Hill|-235'
  + '39.3|-7027.2;Canley Vale|-24533.3|2500.9;Mount Kuring-gai|-7133.1|-23793.4;Cabramatta|-24965.4|3'
  + '374.7;Toongabbie|-24031.1|-8574.3;Holsworthy|-23181.1|10906.4;Hills Showground|-20834.0|-15256.9'
  + ';Warwick Farm|-25267.3|5414.3;Liverpool|-25926.8|6666.0;Norwest|-22991.5|-14498.1;Seven Hills|-2'
  + '5468.8|-9999.3;Berowra|-5677.4|-27102.9;Engadine|-17571.8|22407.5;Casula|-27333.9|9542.2;Bella V'
  + 'ista|-24845.6|-14867.1;Blacktown|-28135.9|-10614.5;Heathcote|-18125.8|24648.2;Kellyville|-25710.'
  + '1|-16787.1;Cowan|-4014.2|-30507.4;Glenfield|-29018.7|12025.6;Marayong|-28873.8|-13057.1;Rouse Hi'
  + 'll|-26773.8|-19132.8;Macquarie Fields|-30298.9|13446.0;Doonside|-31779.6|-11023.1;Quakers Hill|-'
  + '30185.3|-15078.3;Edmondson Park|-32209.1|11765.9;Tallawong|-28478.3|-19119.3;Ingleburn|-31563.5|'
  + '14848.6;Rooty Hill|-33926.2|-10141.1;Waterfall|-19306.7|29833.6;Hawkesbury River|959.0|-35703.7;'
  + 'Schofields|-31417.6|-17648.3;Mount Druitt|-36229.8|-10306.2;Minto|-33555.9|18223.8;Leppington|-3'
  + '6917.7|10214.7;Riverstone|-32723.8|-20419.5;Helensburgh|-19172.8|34540.4;Leumeah|-34614.5|20856.'
  + '7;Vineyard|-33634.3|-23588.2;St Marys|-40418.7|-11049.1;Otford|-18084.8|38263.9;Campbelltown|-36'
  + '068.2|22319.3;Werrington|-42020.8|-11334.0;Woy Woy|9841.2|-42639.8;Mulgrave|-35610.0|-26181.8;Ma'
  + 'carthur|-37627.6|23272.8;Stanwell Park|-20327.4|40048.5;Koolewong|9377.2|-44792.7;Windsor|-37445'
  + '.4|-27576.2;Coalcliff|-20625.6|41805.9;Kingswood|-45536.8|-11360.7;Tascott|9358.5|-46510.4;Point'
  + ' Clare|10263.4|-47049.0;Clarendon|-39595.8|-28095.6;Penrith|-47772.6|-12232.2;Scarborough|-21654'
  + '.0|44346.7;Menangle Park|-42383.1|26893.2;Gosford|11451.1|-49595.9;Wombarra|-22773.3|45575.2;Eas'
  + 't Richmond|-42283.3|-28800.1;Menangle|-42383.6|29294.8;Emu Plains|-50069.7|-12652.4;Richmond|-42'
  + '895.3|-29108.3;Coledale|-23674.9|47126.2;Lapstone|-52656.2|-9482.0;Narara|11655.8|-52780.1;Austi'
  + 'nmer|-24926.0|49027.9;Niagara Park|12575.5|-54078.9;Glenbrook|-54705.9|-9960.9;Lisarow|14013.7|-'
  + '54204.8;Thirroul|-25848.7|50344.9;Blaxland|-55800.4|-12754.6;Douglas Park|-45387.5|35792.3;Bulli'
  + '|-26193.6|52155.7;Ourimbah|13972.0|-56711.6;Warrimoo|-56532.4|-15216.8;Woonona|-26118.1|53835.9';

/** One station forecourt. Names are kept: the trackwork event puts one on a sign. */
export interface StationSite {
  readonly name: string;
  readonly x: number;
  readonly z: number;
}

export const STATIONS: readonly StationSite[] = (() => {
  const out: StationSite[] = [];
  for (const record of STATIONS_PACKED.split(';')) {
    const parts = record.split('|');
    if (parts.length !== 3) continue;
    out.push({ name: parts[0], x: Number(parts[1]), z: Number(parts[2]) });
  }
  return out;
})();

export const STATION_COUNT = STATIONS.length;

/**
 * A flat `x, z, x, z, ...` copy of the same table.
 *
 * The hot query is "how far is the nearest station", asked once per cell per
 * placement pass, and walking 267 objects to read two numbers off each is 267
 * pointer chases through a heap the GC is free to have scattered.
 * `streetlife.VENUE_XZ` is packed for the identical reason and measured it:
 * a flat array of numbers beats a grid walk for a set this size.
 */
const STATION_XZ: Float64Array = (() => {
  const out = new Float64Array(STATION_COUNT * 2);
  for (let i = 0; i < STATION_COUNT; i++) {
    out[i * 2] = STATIONS[i].x;
    out[i * 2 + 1] = STATIONS[i].z;
  }
  return out;
})();

/** The squared plan distance to the nearest station. `Infinity` if the table is empty. */
export function nearestStationDist2(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i < STATION_COUNT; i++) {
    const dx = STATION_XZ[i * 2] - x;
    const dz = STATION_XZ[i * 2 + 1] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}

/** The nearest station itself, for a consumer that wants its name. */
export function nearestStation(x: number, z: number): StationSite | null {
  let best: StationSite | null = null;
  let best2 = Infinity;
  for (let i = 0; i < STATION_COUNT; i++) {
    const dx = STATION_XZ[i * 2] - x;
    const dz = STATION_XZ[i * 2 + 1] - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best2) {
      best2 = d2;
      best = STATIONS[i];
    }
  }
  return best;
}

// --- The beaches -------------------------------------------------------------------------

/**
 * Sixteen points that mean "the beach, or the strip that thinks it is".
 *
 * **Curated, and it says so.** There is no coastline in this build that a
 * three-free module can query -- `world/water.ts` has the geometry and it is on
 * the renderer's side of the wall -- and a coastline would be the wrong answer
 * anyway: the influencer belongs to *Bondi*, not to the eight hundred kilometres
 * of Hawkesbury foreshore that a distance-to-water field would light up.
 *
 * So it is sixteen hand-placed points, projected through
 * `sydney.geo.lonlat_to_enu` -> `enu_to_world` -- the identical path every
 * building in the city took to reach its tile -- and rounded to a tenth of a
 * metre. Twelve are surf beaches, one is a harbour beach that behaves like one
 * (Balmoral), and three are the eastern-suburbs strips the brief asked for and
 * that nobody would call a beach (Bondi Junction, Double Bay, Paddington).
 *
 * The last three are the honest part. A player who meets an influencer outside
 * a Paddington cafe should not be able to tell that this table calls that a
 * beach; what the table really encodes is "where this person is photographed",
 * and the name `BEACHES` is a slight lie kept because `INFLUENCER_ANCHORS` reads
 * like a variable somebody was embarrassed by.
 */
export const BEACHES: readonly { readonly name: string; readonly x: number; readonly z: number }[] = [
  { name: 'Bondi Beach', x: 6053.9, z: 2336.8 },
  { name: 'Tamarama', x: 5737.4, z: 3318.3 },
  { name: 'Bronte Beach', x: 5504.6, z: 3777.0 },
  { name: 'Coogee Beach', x: 4509.8, z: 5657.5 },
  { name: 'Maroubra Beach', x: 4565.0, z: 8906.7 },
  { name: 'Manly', x: 7147.5, z: -8097.3 },
  { name: 'Freshwater', x: 7299.8, z: -10085.4 },
  { name: 'Dee Why Beach', x: 8039.3, z: -12981.6 },
  { name: 'Narrabeen', x: 8285.0, z: -17755.3 },
  { name: 'Palm Beach', x: 10112.8, z: -30230.4 },
  { name: 'Cronulla Beach', x: -4674.4, z: 21004.9 },
  { name: 'Balmoral', x: 3871.2, z: -4703.4 },
  { name: 'Bondi Junction', x: 3807.9, z: 2452.5 },
  { name: 'Double Bay', x: 3133.0, z: 855.5 },
  { name: 'Paddington', x: 1668.4, z: 1768.1 },
  { name: 'Rose Bay', x: 5523.0, z: -72.4 },
];

/** Squared plan distance to the nearest one. Sixteen squared distances; no index needed. */
function nearestBeachDist2(x: number, z: number): number {
  let best = Infinity;
  for (const b of BEACHES) {
    const dx = b.x - x;
    const dz = b.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}

// --- WORKSTREAM AC: the three geometric fields, remembered per point ------------------
//
// **Every bias below is a function of the same three numbers and of the phase**,
// and only the phase moves. The distance to the nearest station, the distance to
// the nearest beach and the census multiplier are properties of a *place*: they
// were fixed when the tables above were baked and they cannot change while the
// process runs.
//
// They were being recomputed on every evaluation anyway, and the eshay's is the
// expensive one -- `nearestStationDist2` is a linear scan of 267 stations, about
// 400 ns, and at night (when it is the only bias that is not gated off on its
// first line) `forEachCharacterNear` was paying it for each of the ~56 cells in
// its sweep, **22 us of a tick that is supposed to cost 60**. That cost is
// invisible in a daylight profile, which is how it survived workstream AA: the
// three-thousand-tick run lands wherever the wall clock happens to be, and half
// the day it never runs the eshay's first line at all.
//
// A direct-mapped table keyed by the *exact* coordinate pair, on
// `countInCached`'s terms and for its reasons: a slot holds the identity of what
// is in it, a mismatch recomputes, and removing the whole thing changes nothing
// but the time. The keys in practice are `charCentre` values -- a few hundred
// distinct cells around wherever anybody is standing -- so the table is hit on
// essentially every call after the first tick in a place.
//
// The three are filled **together** on a miss, rather than lazily one at a time,
// because a per-field valid bit is three more branches on the hot path to save
// 450 ns once per cell per process. `verifyCharacters` asserts the cached
// answers equal the uncached ones over a spread of points, which is the check
// that would catch a hash that dropped a bit of the key.
//
// ---------------------------------------------------------------------------
// **The slot is a tiling of the cell grid, not a hash**, and that is the second
// thing this pass got wrong before it got right. The first cut reused workstream
// AA's mixer -- `imul(x, K1) ^ imul(z, K2)`, masked -- and measured a *ninety
// per cent* miss rate on a table holding fifty entries: multiplication modulo a
// power of two only sees the low bits of its operands, so the fifty-odd cells of
// one sweep, which differ by one in each index, landed on twenty-five slots.
// A cache that thrashes is worse than no cache, and it is silent.
//
// Cell indices modulo 32 are collision-free by construction for any 32-by-32
// block of cells -- 13.4 km on a side, so **one player can never collide with
// themselves**, whatever the sweep radius. Two players more than that apart can
// share a slot, and then both recompute, which costs exactly what it cost before
// this table existed. That is the right shape for a cache: no aliasing in the
// case that happens, and a graceful return to the old cost in the case that
// does not.
const GEOM_SLOTS = 1024;
const geomX = new Float64Array(GEOM_SLOTS);
const geomZ = new Float64Array(GEOM_SLOTS);
const geomFilled = new Uint8Array(GEOM_SLOTS);
const geomStation = new Float64Array(GEOM_SLOTS);
const geomBeach = new Float64Array(GEOM_SLOTS);
const geomCrowd = new Float64Array(GEOM_SLOTS);

/**
 * The slot for a point, as its cell indices modulo 32. Shared with `cellSlot`,
 * which tiles the same grid the same way; see the note above.
 */
function gridSlot(cx: number, cz: number): number {
  return ((cx & 31) << 5) | (cz & 31);
}

/** The slot holding `(x, z)`'s three fields, computing them if it does not. */
function geomAt(x: number, z: number): number {
  const slot = gridSlot(charCell(x), charCell(z));
  if (geomFilled[slot] === 1 && geomX[slot] === x && geomZ[slot] === z) return slot;
  geomX[slot] = x;
  geomZ[slot] = z;
  geomStation[slot] = nearestStationDist2(x, z);
  geomBeach[slot] = nearestBeachDist2(x, z);
  geomCrowd[slot] = crowdMultiplier(x, z);
  geomFilled[slot] = 1;
  return slot;
}

// --- The cell grid ------------------------------------------------------------------------

/**
 * The anchor cell, metres. `factions.PATROL_CELL` one size up, and the size is
 * chosen against the two things it has to be between.
 *
 * Smaller than a suburb, because a suburb is where `game/streetlife.ts` already
 * works and a second per-suburb population would put everybody on the same
 * corner. Larger than a block, because a cell holds a whole *count* -- at 100 m
 * every cell would hold zero or one person and the density weighting would be a
 * coin flip rather than a gradient.
 *
 * 420 m is a little under `density.DENSITY_CELL_M`'s 500, deliberately: two
 * character cells fall inside most census cells, so the bilinear interpolation
 * in `crowdMultiplier` is actually doing something between neighbours rather
 * than handing every character cell the same byte.
 */
export const CHAR_CELL = 420;

/** Which cell a coordinate is in. Floored, so it is exact for negatives too. */
export function charCell(v: number): number {
  return Math.floor(v / CHAR_CELL);
}

/** The centre of a cell. Every count and every bias is evaluated here, never at a corner. */
export function charCentre(c: number): number {
  return c * CHAR_CELL + CHAR_CELL / 2;
}

/**
 * A cell's hash seed: its **rounded centre**, never its indices.
 *
 * `factions.stationSeed` and `streetlife.suburbSeed`'s rule, and the reason is
 * the same one both of them give: an index-derived seed re-rolls every person in
 * the city the day the grid origin moves, and a position-derived one does not.
 */
export function charSeed(cx: number, cz: number): number {
  return carHash(Math.round(charCentre(cx)) | 0, Math.round(charCentre(cz)) | 0);
}

// --- The bias table --------------------------------------------------------------------------

/**
 * A per-character regional and temporal weight, in `[0, ~3]`.
 *
 * Multiplied onto `density.crowdMultiplier` to get a cell's population of one
 * kind. **Zero means none here, ever**, and it is the gate that makes four of
 * the five time-of-day characters: a tradie's bias is exactly 0 outside working
 * hours, so no arithmetic downstream has to know about the sun.
 *
 * Pure functions of `(x, z, phase)` and nothing else. No day index: a bias that
 * varied with the calendar would put a character in a place on Tuesday and not
 * on Wednesday, which is a different feature (see `game/events.ts`, which is
 * that feature). The one calendar-dependent character, the agent, gets his
 * Saturday gate in `countIn` rather than here, so that the table stays a
 * statement about *geography* and the calendar stays in one place.
 */
export interface CharacterBias {
  readonly name: string;
  readonly kind: number;
  weight(x: number, z: number, phase: number): number;
}

/**
 * A falloff from a point, in `[0, 1]`: 1 at the point, 0 at `far`, linear.
 *
 * Linear rather than a Gaussian, and the header's rule 6 is the whole reason:
 * `Math.exp` is implementation-defined and this result decides how many people
 * exist. A linear ramp reads a shade harder at the edge and is exact in both
 * engines, which is not a trade at all once it is written down.
 */
function nearness(d2: number, far: number): number {
  const d = Math.sqrt(d2);
  return d >= far ? 0 : 1 - d / far;
}

/**
 * How far west of Town Hall a point is, as a `[0, 1]` ramp out to 30 km.
 *
 * World x is **east** metres, so west is negative x. Thirty kilometres is
 * Penrith-ish, which is where the ramp should saturate: everything from
 * Parramatta out reads the same to this weighting, which is correct, because the
 * thing being modelled is not a gradient in distance, it is a gradient in what
 * kind of suburb it is, and that stops changing somewhere around Blacktown.
 */
function westness(x: number): number {
  return Math.min(1, Math.max(0, -x / 30000));
}

/** And south of it, on the same ramp, out to 20 km. The south-west is both at once. */
function southness(z: number): number {
  return Math.min(1, Math.max(0, z / 20000));
}

/**
 * The north shore and the inner west, as one `[0, 1]` field.
 *
 * Two overlapping discs rather than a boundary test, because the boundary is
 * not in this build and the shape wanted is soft anyway: "leafier as you go
 * north over the bridge, and again along Parramatta Road inside about eight
 * kilometres". The centres are Chatswood-ish and Ashfield-ish, taken off
 * `factions.POLICE_STATIONS`' own rows rather than invented, so the two tables
 * are describing the same two places.
 */
function northShoreOrInnerWest(x: number, z: number): number {
  const nx = x - -2264.7;
  const nz = z - -7948.7;
  const wx = x - -7259.3;
  const wz = z - 2587.1;
  return Math.max(nearness(nx * nx + nz * nz, 12000), nearness(wx * wx + wz * wz, 9000));
}

/**
 * The five biases, and every one of them is a taste decision written down.
 *
 * The order is `NPC_KIND`'s. `verifyCharacters` walks this table and asserts
 * that no two rows agree everywhere, that none of them is ever negative or
 * non-finite, and that each is actually zero somewhere -- a bias that never
 * reaches zero is a character who is everywhere, which is the failure the whole
 * table exists to prevent and which is invisible from any one street corner.
 */
export const CHARACTER_BIAS: readonly CharacterBias[] = [
  {
    name: 'eshay',
    kind: NPC_KIND.ESHAY,
    /**
     * Stations and shopping strips at night, heavier in the west and
     * south-west.
     *
     * Three terms and a hard gate. The gate is night -- outside it they are
     * simply not here, which is a stronger statement than "fewer", and it is the
     * right one: an eshay at a station at two in the afternoon is a teenager.
     * The station term is the dominant one and it is tight (250 m), because the
     * brief's word was *at* stations and a 600 m falloff would have made it "in
     * the suburb of". The regional term is a floor rather than a multiplier so
     * that the eastern suburbs still get some and Mount Druitt gets more, rather
     * than one getting all of them.
     */
    weight(x, z, phase) {
      if (daylight(phase)) return 0;
      // WORKSTREAM AC: the same 267 squared distances, taken from the per-point
      // cache rather than walked again. See `geomAt`.
      const station = nearness(geomStation[geomAt(x, z)], 250);
      const region = 0.35 + 0.9 * Math.max(westness(x), southness(z) * 0.8);
      return (0.25 + 1.75 * station) * region;
    },
  },
  {
    name: 'karen',
    kind: NPC_KIND.KAREN,
    /**
     * Suburban strips and school zones by day, north shore and inner west
     * heavier.
     *
     * There are no school zones in this build -- OSM's `amenity=school` is not
     * carried into any runtime table -- and inventing one would be a bake for a
     * multiplier. What a school zone *is*, for this purpose, is a residential
     * area with a shopping strip in it, and `crowdMultiplier` already answers
     * that; so the bias is the regional term and the daylight gate, and the
     * honesty is in saying that rather than in naming a constant `SCHOOL_ZONE`.
     *
     * The morning is heavier than the afternoon by half again, which is the one
     * temporal shape in this table that is not a gate: school drop-off and the
     * coffee after it are a real peak, and phase 0.25 to 0.45 is that window.
     */
    weight(x, z, phase) {
      if (!daylight(phase)) return 0;
      const morning = phase < 0.45 ? 1.5 : 1;
      return (0.5 + 1.3 * northShoreOrInnerWest(x, z)) * morning;
    },
  },
  {
    name: 'tradie',
    kind: NPC_KIND.TRADIE,
    /**
     * Sunrise to mid-afternoon, and **peaked at middling density** rather than
     * rising with it.
     *
     * This is the one bias whose shape is not monotone and it is the most
     * defensible row in the table. Building sites, big-box retail and service
     * stations are not in the CBD and they are not in Dural; they are in the
     * band in between -- Alexandria, Silverwater, Seven Hills -- which in
     * `crowdMultiplier`'s terms is a multiplier around 0.35 to 0.6. So the bias
     * is a tent over that band, and it is keyed on the census field rather than
     * on a shop tag because the shop tags are per-tile attributes that a
     * three-free module has no access to. That is a real limitation and it is
     * stated rather than papered over: a tradie will not preferentially appear
     * outside an actual Bunnings, he will appear in the kind of place a Bunnings
     * is.
     *
     * Knock-off is at phase 0.60, which on a 0.25-sunrise 0.75-sunset day is
     * about three in the afternoon. The brief said mid-afternoon; this is that,
     * and it is a hard gate for `daylight`'s reason.
     */
    weight(x, z, phase) {
      if (phase < SUNRISE_PHASE || phase > 0.6) return 0;
      const m = geomCrowd[geomAt(x, z)];
      // A tent peaking at 0.45 and reaching zero at 0.05 and 0.95. Absolute
      // value rather than a square, so it is three operations and no rounding.
      const tent = Math.max(0, 1 - Math.abs(m - 0.45) / 0.5);
      return 0.3 + 1.9 * tent;
    },
  },
  {
    name: 'bondi influencer',
    kind: NPC_KIND.INFLUENCER,
    /**
     * Beach zones and eastern-suburbs strips, in daylight, and **nowhere else at
     * all**.
     *
     * The only bias in the table with no floor term: away from `BEACHES` it is
     * exactly zero, so there is not one influencer in Bankstown. That is
     * deliberate and it is the joke landing rather than a modelling failure --
     * the character is defined by where she is, and diluting her across the
     * whole city to be fair to the census would be the tourism-board version of
     * this.
     *
     * 1,200 m of falloff is wide for a beach and it is what makes Bondi read as
     * a *zone*: the beach, Campbell Parade, the streets behind it and the walk
     * to Tamarama are all one continuous place at that radius, which is what it
     * is.
     */
    weight(x, z, phase) {
      if (!daylight(phase)) return 0;
      return 2.6 * nearness(geomBeach[geomAt(x, z)], 1200);
    },
  },
  {
    name: 'real estate agent',
    kind: NPC_KIND.AGENT,
    /**
     * In front of houses, in daylight, and thickest where the houses are worth
     * arguing about.
     *
     * Peaked at *low-to-middling* density -- an open home is a freestanding
     * house or a terrace, not a tower -- and lifted again over the north shore
     * and the inner west, which is where the auctions with crowds at them are.
     * The Saturday gate is not here; see `CharacterBias` for why the calendar
     * lives in `countIn`.
     */
    weight(x, z, phase) {
      if (!daylight(phase)) return 0;
      const m = geomCrowd[geomAt(x, z)];
      const houses = Math.max(0, 1 - Math.abs(m - 0.3) / 0.42);
      return (0.25 + 1.4 * houses) * (1 + 0.8 * northShoreOrInnerWest(x, z));
    },
  },
];

/** The bias row for a kind, or undefined. A five-entry linear scan; not a hot path. */
export function biasFor(kind: number): CharacterBias | undefined {
  for (const b of CHARACTER_BIAS) if (b.kind === kind) return b;
  return undefined;
}

// --- How many of each, per cell -----------------------------------------------------------

/**
 * The population of one kind in one cell, at full weight. **Multiplied by the
 * census field and the bias, then rounded.**
 *
 * Three, and it is small on purpose. A 420 m cell is about four city blocks of
 * frontage; three of anybody in four blocks is a *presence* rather
 * than a crowd, and the crowd is already there (`game/pedestrians.ts` schedules
 * nineteen thousand walkers). These five are the people you notice, and you stop
 * noticing them at about four.
 *
 * The eshay's cap is separately three because his unit is a group of three; see
 * `ESHAY_GROUP`.
 */
const CELL_BASE = 3;

/** A group of eshays is three of them. The brief's number, and the unit of placement. */
export const ESHAY_GROUP = 3;

/**
 * How many of `kind` stand in cell `(cx, cz)` on this day at this phase.
 *
 * Rounded, and the rounding is where the whole feature's determinism actually
 * lives: two engines that disagreed about `crowdMultiplier`'s last bit would
 * still round to the same integer everywhere except at an exact half, and there
 * is no exact half in a product of a census exponential and a linear bias.
 * `verifyCharacters` samples the margin rather than trusting that sentence.
 *
 * The Saturday gate for the agent is here rather than in the bias table, so that
 * the table stays a statement about geography. See `CharacterBias`.
 */
export function countIn(kind: number, cx: number, cz: number, day: GameDay): number {
  const bias = biasFor(kind);
  if (bias === undefined) return 0;
  return countOf(bias, charCentre(cx), charCentre(cz), day);
}

/**
 * `countIn` with the row and the cell centre already in hand.
 *
 * WORKSTREAM AC: the per-tick cell record fills five counts for one cell, and
 * through `countIn` that was five linear scans of `CHARACTER_BIAS` to find a row
 * the loop is already holding, plus ten `charCentre` divides for one point. Both
 * are small and both are on the only path that still costs anything at eight
 * players, which is exactly where small things are worth taking out. The
 * arithmetic below is `countIn`'s, unchanged, and `countIn` is now one call into
 * it -- so there is still one definition of how many people a cell holds.
 */
function countOf(bias: CharacterBias, x: number, z: number, day: GameDay): number {
  const kind = bias.kind;
  if (kind === NPC_KIND.AGENT && !saturdayAt(day.index)) return 0;
  const w = bias.weight(x, z, day.phase);
  if (!(w > 0)) return 0;
  // WORKSTREAM AC: the census field for this cell, from the per-point cache. The
  // same `crowdMultiplier(x, z)`, evaluated once per place rather than once per
  // kind per cell per tick. See `geomAt`.
  const n = Math.round(CELL_BASE * geomCrowd[geomAt(x, z)] * w);
  // **An eshay cell holds a group or nobody.** The brief's word was "in
  // threes", and a cell that rounded to two would produce a pair -- which is
  // two blokes, not a group, and reads as the placement having failed rather
  // than as a smaller group. So the rounded count is a *threshold* for these
  // and a count for everybody else. It makes them rarer as well as more
  // legible, which is the right direction: three of them is an event.
  if (kind === NPC_KIND.ESHAY) return n >= 1 ? ESHAY_GROUP : 0;
  return Math.min(CELL_BASE + 1, Math.max(0, n));
}

// --- Ambient placement -----------------------------------------------------------------------

/** Where one ambient character is. Reused by the caller; never allocated per visit. */
export interface CharacterPose {
  /** Stable identity, for the renderer's rig pool. Distinct from every other key space. */
  key: number;
  kind: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  /** The cell's own point -- the spot they hold, and a promotion's home. */
  baseX: number;
  baseZ: number;
  cx: number;
  cz: number;
  /** Which slot in the cell this is. For an eshay, `floor(index / 3)` is the group. */
  index: number;
  /** 0..1. The renderer's idle clock. */
  phase: number;
  /** Per-individual look bits. See `world/characters.ts`; kept here so both tiers agree. */
  look: number;
}

export function createCharacterPose(): CharacterPose {
  return {
    key: 0, kind: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    baseX: 0, baseZ: 0, cx: 0, cz: 0, index: 0, phase: 0, look: 0,
  };
}

/**
 * A stable key per ambient identity, in a space that cannot collide with
 * `pedestrians.pedKey`, with `streetlife.streetKey`, or with a promoted actor's
 * negative id.
 *
 * `streetKey` starts at 2^40 and adds at most `VENUE_COUNT * 8 * 2`, about
 * 10,300 -- so it occupies `[2^40, 2^40 + 2^14)`. This starts at **2^41**,
 * which clears that whole range with twenty-six bits to spare, and adds a
 * cell-and-slot index that stays exact in a double: the cell indices are within
 * +/-150 for the built extent, the pack below is `((cx + 4096) * 8192 + (cz +
 * 4096)) * 32 + slot`, which tops out under 2^38.
 *
 * Exact-integer arithmetic all the way, so two engines produce the same double
 * and the renderer's slot pairing is stable across the wire. `streetKey`'s
 * header makes the same argument about the same trap.
 */
const KEY_BASE = 2199023255552; // 2^41
export function characterKey(kind: number, cx: number, cz: number, index: number): number {
  const cell = (cx + 4096) * 8192 + (cz + 4096);
  return KEY_BASE + (cell * 32 + index) * 8 + (kind - NPC_KIND.ESHAY);
}

/**
 * The band pool a cell draws from, cached against the resident set.
 *
 * `streetlife.anchorBands` in miniature, restated here rather than exported from
 * there for the reason that file restates `factions.walkToward`: it is thirty
 * lines against an edit to a module this one is a consumer of, and the scoring
 * differs -- there is no lane-class bias here, because none of these five
 * belongs on a laneway. A Karen belongs on the high street and so does everybody
 * else in this file, so the pool is simply "the nearest real footpaths".
 *
 * `PedestrianField.generation` makes the invalidation exact rather than
 * heuristic, which is the whole reason the cache is safe: a tile streaming in
 * changes the answer and bumps the generation in the same breath.
 */
interface Pool {
  bands: PedBand[];
  reach: number;
  /**
   * WORKSTREAM AA: the union of the pool's bands' bounding boxes.
   *
   * Everybody this pool ever places stands **on one of these bands**, so this
   * box plus `POSE_SLOP` bounds where they can be -- exactly, rather than by
   * the `CHARACTER_REACH` worst case the cell sweep has to assume. It is what
   * lets `poseCharacter` refuse a person a kilometre away before it does the
   * nearest-point search that finds out where they are. Empty pools keep the
   * inverted box, which fails every test, and are already refused a line
   * earlier.
   */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

interface PoolCache {
  gen: number;
  byKey: Map<number, Pool>;
}

const poolCache = new WeakMap<PedestrianField, PoolCache>();

/** How many nearby footpaths a cell picks from. `streetlife.POOL_SIZE`. */
const POOL_SIZE = 8;

/**
 * How far a cell's search widens when its own square holds no footpath at all,
 * metres.
 *
 * `streetlife.METH_RESCUE_MAX` is 1,400 for a *suburb centroid*, which can be in
 * the middle of a national park. A cell centre cannot be that far from a street
 * and still be a cell anybody visits, and widening past a kilometre would let
 * one cell reach into three others and stack its people on the same kerb. Six
 * hundred metres is a little over one cell's diagonal, which is the honest
 * bound: it rescues a cell whose centre landed on a rail corridor, a park or a
 * reservoir, and it gives up on a cell that is genuinely all water.
 *
 * A cell that finds nothing places nobody, which is the correct answer and is
 * counted rather than hidden -- see `verifyCharacters`.
 */
const CELL_RESCUE_MAX = 600;

/**
 * The pool for a cell.
 *
 * **WORKSTREAM AC: keyed by the cell, and it always could have been.** This took
 * `carHash(seed, (kind * 32 + unit) ^ 0x2c1b)` -- a key per *person* -- and the
 * search behind it does not depend on the person at all: the query point is the
 * cell centre, the radius is `CHAR_CELL * 0.5`, the rescue ladder is the same
 * and the scoring function closes over nothing else. Forty keys per cell were
 * therefore forty entries in the map holding forty copies of one answer, and the
 * first visit to a cell paid `PedestrianField.near` and a sort forty times over.
 *
 * What it buys is not only the duplicate work. A pool per *cell* means the
 * pool's extent is a property of the cell, which is what lets
 * `forEachCharacterNear` do the box refusal **once per cell** instead of once
 * per person -- see there. `verifyCharacters` asserts the two keyings return the
 * same bands, because "the search does not depend on the person" is exactly the
 * kind of sentence that stops being true one edit later.
 */
function cellBands(field: PedestrianField, cx: number, cz: number, out: PedBand[]): Pool {
  let entry = poolCache.get(field);
  if (entry === undefined || entry.gen !== field.generation) {
    entry = { gen: field.generation, byKey: new Map() };
    poolCache.set(field, entry);
  }
  // Exact integer identity for the cell, on `characterKey`'s packing and inside
  // the same bound: the built extent's cells are within +/-150 of the origin.
  const key = (cx + 4096) * 8192 + (cz + 4096);
  const cached = entry.byKey.get(key);
  if (cached !== undefined) return cached;
  const x = charCentre(cx);
  const z = charCentre(cz);
  let reach = CHAR_CELL * 0.5;
  field.near(x, z, reach, out);
  while (out.length === 0 && reach < CELL_RESCUE_MAX) {
    reach = Math.min(reach * 2, CELL_RESCUE_MAX);
    field.near(x, z, reach, out);
  }
  const score = (b: PedBand): number => {
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    // The variance term is `streetlife.anchorBands`': a short side street beats
    // a long arterial that merely passes the cell.
    return dx * dx + dz * dz + (b.length * b.length) / 12;
  };
  // The trailing keys make the comparison total. `near` returns bands in
  // whatever order its grid buckets hold them -- streaming order in a browser,
  // completion order on the server -- and a comparison that ties would order
  // them differently on the two ends and move everybody.
  const bands = [...out]
    .sort((a, b) => score(a) - score(b) || a.osmId - b.osmId || a.side - b.side || a.minX - b.minX)
    .slice(0, POOL_SIZE);
  // The pool's own extent, folded once at build time and then cached with it.
  // Bands do not move and the cache is invalidated by
  // `PedestrianField.generation`, so this is as stable as the pool is.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const b of bands) {
    if (b.minX < minX) minX = b.minX;
    if (b.minZ < minZ) minZ = b.minZ;
    if (b.maxX > maxX) maxX = b.maxX;
    if (b.maxZ > maxZ) maxZ = b.maxZ;
  }
  const pool: Pool = { bands, reach, minX, minZ, maxX, maxZ };
  entry.byKey.set(key, pool);
  return pool;
}

/**
 * A point a fraction of the way along a band, and the direction of travel there.
 *
 * `streetlife.pointOnBand`, restated for the same reason `cellBands` is. Writes
 * into `out` and returns nothing.
 */
function pointOnBand(band: PedBand, t: number, out: CharacterPose): void {
  const target = t * band.length;
  let lo = 0;
  let hi = band.count - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (band.s[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = band.s[lo + 1] - band.s[lo];
  const f = span > 1e-6 ? (target - band.s[lo]) / span : 0;
  out.x = band.x[lo] + (band.x[lo + 1] - band.x[lo]) * f;
  out.y = band.y[lo] + (band.y[lo + 1] - band.y[lo]) * f;
  out.z = band.z[lo] + (band.z[lo + 1] - band.z[lo]) * f;
  out.dx = band.ux[lo];
  out.dz = band.uz[lo];
}

/**
 * The arc length of the point on `band` closest to `(x, z)`, and how far that
 * is.
 *
 * `streetlife.nearestOnBand` verbatim, restated on that file's own argument for
 * `walkToward`. It is what turns "somewhere on this footpath" into "the part of
 * this footpath nearest the cell", and see `CELL_STROLL` for why that matters
 * more here than it did there.
 */
function nearestOnBand(band: PedBand, x: number, z: number): number {
  let bestS = 0;
  let best2 = Infinity;
  for (let i = 0; i < band.count - 1; i++) {
    const ax = band.x[i];
    const az = band.z[i];
    const ex = band.x[i + 1] - ax;
    const ez = band.z[i + 1] - az;
    const len2 = ex * ex + ez * ez;
    let t = len2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const px = ax + ex * t;
    const pz = az + ez * t;
    const dx = px - x;
    const dz = pz - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best2) {
      best2 = d2;
      bestS = band.s[i] + (band.s[i + 1] - band.s[i]) * t;
    }
  }
  return bestS;
}

/**
 * How far along the kerb from their cell's centre somebody may stand, metres.
 *
 * **The fix for a bug that cost this feature an afternoon of screenshots**, and
 * it is `poseMethhead`'s rescue branch generalised to every placement rather
 * than to the starved case.
 *
 * The first cut took a **uniform fraction of the whole band**. A `PedBand` is an
 * OSM way clipped to a 500 m tile, so it can be five hundred metres long, and
 * `PedestrianField.near` selects on its *bounding box* -- so a band admitted for
 * being near the cell centre can run most of a kilometre away from it. Three
 * eshays whose cell was at St Peters were measured standing 283 m from where the
 * query was, and worse, they **moved every time a tile streamed in**: the pool
 * cache is keyed on `PedestrianField.generation`, so a new tile re-picks the
 * band, and a re-picked band at a uniform fraction is a completely different
 * place. The symptom was a group of three who were 11 m away, then 283 m away,
 * then nowhere.
 *
 * Standing them at the point on the band nearest their cell centre, plus a
 * hashed stroll of at most this, fixes both halves at once: they stay in the
 * cell that owns them, and a re-picked band puts them in almost the same place
 * because *every* nearby band's closest point to the cell centre is near the
 * cell centre.
 *
 * Sixty metres is about a block frontage, which is enough that three characters
 * in one cell are not standing on one corner and short enough that
 * `CHARACTER_REACH` stays a number rather than "the longest band in Sydney".
 */
const CELL_STROLL = 60;

/**
 * How far each of them drifts on the spot, metres, and how long a stroke takes.
 *
 * Five characters, five idles, and they are the cheapest characterisation in the
 * whole feature -- a triangle wave with two numbers in it, evaluated identically
 * on both ends:
 *
 *   - the **eshay** rocks: short and quick, 0.35 m over 2.6 s.
 *   - the **Karen** does not move at all. She is standing there with a coffee.
 *   - the **tradie** paces a short beat, 0.9 m over 5 s, which is a man waiting
 *     for a delivery.
 *   - the **influencer** is the important zero: she stops in the middle of the
 *     footpath and *stays there*, which is the whole of her obstruction.
 *   - the **agent** paces the longest and slowest, 1.6 m over 7 s, in front of
 *     the sign.
 */
const IDLE_AMPLITUDE: Readonly<Record<number, number>> = {
  [NPC_KIND.ESHAY]: 0.35,
  [NPC_KIND.KAREN]: 0,
  [NPC_KIND.TRADIE]: 0.9,
  [NPC_KIND.INFLUENCER]: 0,
  [NPC_KIND.AGENT]: 1.6,
};
const IDLE_SECONDS: Readonly<Record<number, number>> = {
  [NPC_KIND.ESHAY]: 2.6,
  [NPC_KIND.KAREN]: 6,
  [NPC_KIND.TRADIE]: 5,
  [NPC_KIND.INFLUENCER]: 6,
  [NPC_KIND.AGENT]: 7,
};

/**
 * How far off the band's centre line somebody stands, metres, by kind.
 *
 * The **sign is hashed** and the magnitude is small, and both of those are the
 * fix for a bug this file shipped with for an afternoon. `poseMethhead` leans
 * `+/-0.55` with a hashed sign for the same reason and it is worth restating
 * rather than inheriting silently:
 *
 * A `PedBand` is the *centre line of a footpath*, and `pedestrians.
 * NARROW_FOOTPATH_M` says a narrow one is two metres wide -- so there is about a
 * metre of concrete either side of the line and no more. The first cut of this
 * table leaned every character the same way (always left of the heading) at up
 * to 0.7 m, and stacked the eshay group's own 0.75 m of cross-path formation on
 * top of it, for 1.45 m of lateral offset on a 1.0 m half-width.
 *
 * The result was measured rather than guessed at: a group of three eshays at
 * St Peters stood **inside a brick terrace**, with `CollisionWorld.blocked`
 * returning true from their position to every point within four metres in every
 * direction including straight up. They were drawn, they were hittable, and they
 * were invisible, because they were in a wall. Nothing threw and nothing in any
 * self-check could see it -- the only symptom was a screenshot with nobody in
 * it.
 *
 * So: **the total lateral offset of any character must stay under one metre.**
 * The numbers below are the lean's half of that budget and `ESHAY_ACROSS` is the
 * other half; `verifyCharacters` asserts their sum.
 *
 * **The influencer's is zero and that is the feature**, not an omission. Every
 * other character in this file steps out of the way; she is in the middle of the
 * footpath, which is what the brief asked for and what makes her an obstacle
 * rather than scenery. See `INFLUENCER_RADIUS`.
 */
const KERB_LEAN: Readonly<Record<number, number>> = {
  [NPC_KIND.ESHAY]: 0.34,
  [NPC_KIND.KAREN]: 0.4,
  [NPC_KIND.TRADIE]: 0.45,
  [NPC_KIND.INFLUENCER]: 0,
  [NPC_KIND.AGENT]: 0.42,
};

/**
 * The most any character is displaced across the footpath, metres, and the
 * budget `KERB_LEAN` and `ESHAY_ACROSS` share.
 *
 * Nine tenths of `pedestrians.NARROW_FOOTPATH_M / 2`. The tenth is the margin
 * for a footpath narrower than the narrow case -- there is no guarantee in the
 * bake that two metres is a floor, only that it is what the crowd's own
 * scheduler treats as narrow.
 */
export const MAX_LATERAL = 0.9;


/** How far across the footpath the third member of an eshay group stands. */
const ESHAY_ACROSS = 0.45;

/**
 * How far off its band pool a posed character can finish, metres.
 *
 * **Derived from the three displacements `poseCharacter` applies**, on
 * `CHARACTER_REACH`'s rule and for its reason: a gate tighter than the thing it
 * gates does not fail to draw somebody, it deletes them. The three are the kerb
 * lean (across the footpath, hashed sign), the eshay group's formation offset
 * (along the kerb and a little across), and the idle drift (along the kerb,
 * bounded by the amplitude table). Every one of them is applied to a unit
 * direction, so each contributes its own magnitude and no more.
 *
 * Rounded **up** to a whole metre, which is not laziness. The number is used as
 * a conservative bound and nothing else, so a slack metre costs a few extra
 * pose evaluations at the boundary and buys the one property that matters: two
 * runtimes summing three float constants cannot land either side of an integer
 * that the true worst case is a whole metre short of. See `verifyCharacters`,
 * which asserts the bound against the tables rather than against this line.
 */
export const POSE_SLOP = (() => {
  let lean = 0;
  for (const v of Object.values(KERB_LEAN)) if (v > lean) lean = v;
  let idle = 0;
  for (const v of Object.values(IDLE_AMPLITUDE)) if (v > idle) idle = v;
  // The eshay formation: 1.15 along at most, `ESHAY_ACROSS` across at most.
  // Added as a sum rather than as a hypotenuse, which is both an over-estimate
  // (correct direction) and free of `Math.hypot` -- see `game/traffic.ts`'s
  // header on why a shared module does not reach for it.
  const group = 1.15 + ESHAY_ACROSS;
  return Math.ceil(lean + idle + group);
})();

/**
 * One ambient character, or false if this cell has no band under it.
 *
 * A pure function of `(kind, cell, index, tick)` and the resident band set,
 * which is the contract `factions.ts`'s section 2 asks of an ambient tier: zero
 * bytes of protocol, evaluated identically by the client drawing it and the
 * authority deciding whether it has been walked into.
 *
 * **Eshays are placed as a group.** `index` is the individual, `floor(index /
 * ESHAY_GROUP)` is the group, and the group picks the band point while the
 * individual takes a fixed offset within it. Three people standing in a triangle
 * on a footpath is a specific and recognisable arrangement, and placing them
 * independently would have produced three people who happen to be near each
 * other -- which is what a crowd already looks like.
 */
export function poseCharacter(
  peds: PedestrianField,
  kind: number,
  cx: number,
  cz: number,
  index: number,
  now: number,
  scratch: PedBand[],
  out: CharacterPose,
  // --- WORKSTREAM AA: the caller's query, for the early refusal below.
  //
  // Optional and defaulting to "no gate". **WORKSTREAM AC: no caller in the
  // project passes one any more** -- `forEachCharacterNear` makes the identical
  // refusal against the identical box once per cell instead of once per person
  // (see `cellSlot`), so repeating it here would be four compares for an answer
  // the caller already holds. It is kept because it is the honest shape of this
  // function's contract: anybody posing a character to answer "is one of these
  // near me" can hand in the query and be refused early, and the next consumer
  // of this module should not have to rediscover the box.
  qx = 0,
  qz = 0,
  qr = -1,
): boolean {
  const seed = charSeed(cx, cz);
  // The *group* is what searches for a footpath, so three eshays share one.
  const unit = kind === NPC_KIND.ESHAY ? Math.floor(index / ESHAY_GROUP) : index;
  const h = carHash(seed ^ (kind * 0x9e37), unit ^ 0x51ed);
  const px = charCentre(cx);
  const pz = charCentre(cz);
  const pool = cellBands(peds, cx, cz, scratch);
  const bands = pool.bands;
  if (bands.length === 0) return false;

  // --- WORKSTREAM AA: is this person even in the neighbourhood?
  //
  // `forEachCharacterNear` has to sweep cells out to `CHARACTER_REACH` -- 1.3 km
  // -- because a cell whose centre landed on a reservoir rescues its footpaths
  // from up to `CELL_RESCUE_MAX` away, and the sweep cannot know which cells did
  // that without asking. So a 9 m promotion scan enumerated about 250
  // cell-and-kind pairs and posed everybody in all of them, then threw away
  // every one further than 9 m. That was 0.23 ms a tick with one player on the
  // server, the largest thing left in the tick after the pickups.
  //
  // The pool knows better than the sweep does. Its bands are where this person
  // can actually stand, `POSE_SLOP` bounds how far off one they finish, and the
  // box test below is therefore **exact in the only sense that matters**: it
  // refuses nobody the full pose could have placed inside `qr`. What it skips is
  // `nearestOnBand`'s walk over the band's vertices and `pointOnBand`'s binary
  // search, which is nearly all of the cost.
  //
  // Box against box rather than disc against box, on `game/spatialhash.ts`'
  // terms: the caller does its own exact circle test over a shorter list, and a
  // conservative superset plus an unchanged exact test is identical output.
  if (qr >= 0) {
    const slop = qr + POSE_SLOP;
    if (
      pool.minX - qx > slop || qx - pool.maxX > slop ||
      pool.minZ - qz > slop || qz - pool.maxZ > slop
    ) {
      return false;
    }
  }

  const band = bands[h % bands.length];
  // The point on this footpath nearest the cell, plus a hashed stroll along the
  // kerb. **Never a uniform fraction of the band** -- see `CELL_STROLL` for the
  // measurement that rules that out.
  const at = nearestOnBand(band, px, pz) + (((carHash(h, 0x51ab) % 2001) - 1000) / 1000) * CELL_STROLL;
  const clamped = at < 0 ? 0 : at > band.length ? band.length : at;
  pointOnBand(band, band.length > 1e-6 ? clamped / band.length : 0, out);

  out.key = characterKey(kind, cx, cz, index);
  out.kind = kind;
  out.cx = cx;
  out.cz = cz;
  out.index = index;
  out.baseX = out.x;
  out.baseZ = out.z;
  // Left of the heading is `(dz, -dx)` in renderer axes -- `pedestrians.
  // buildBand`'s own statement about which side of a way is which. The **sign
  // is hashed**, so half of them stand on the kerb side and half against the
  // shopfronts rather than every character in the city hugging the same edge.
  // See `KERB_LEAN` for what the first cut of this line cost.
  const lean = (KERB_LEAN[kind] ?? 0.4) * ((carHash(h, 0x8c31) % 2) * 2 - 1);
  out.baseX += out.dz * lean;
  out.baseZ -= out.dx * lean;
  // The group formation: one at the point, one a step along the kerb, one a step
  // back and out. Fixed offsets rather than hashed ones, because a *formation*
  // is the thing being drawn and a hashed one is three people at random.
  if (kind === NPC_KIND.ESHAY) {
    const member = index - unit * ESHAY_GROUP;
    // Spread mostly **along** the footpath rather than across it, which is both
    // what three people standing together on a footpath actually do and what
    // keeps the group inside `MAX_LATERAL`. See `KERB_LEAN`.
    const along = member === 1 ? 1.15 : member === 2 ? -0.7 : 0;
    const across = member === 2 ? ESHAY_ACROSS * (lean >= 0 ? -1 : 1) : 0;
    out.baseX += out.dx * along + out.dz * across;
    out.baseZ += out.dz * along - out.dx * across;
  }

  const phase = (carHash(h, 0x1d0b + index) % 1024) / 1024;
  const amp = IDLE_AMPLITUDE[kind] ?? 0;
  const period = IDLE_SECONDS[kind] ?? 5;
  const drift = amp > 0 ? triangle(now / period + phase) * amp : 0;
  out.x = out.baseX + out.dx * drift;
  out.z = out.baseZ + out.dz * drift;
  if (amp > 0) {
    // Facing the way they are pacing; the stroke's sign is the triangle's slope,
    // which flips at the ends. `poseMethhead`'s trick, and it is the reason a
    // pacing figure turns around rather than moonwalking.
    const f = now / period + phase;
    const forward = f - Math.floor(f) < 0.5 ? 1 : -1;
    out.dx *= forward;
    out.dz *= forward;
  } else {
    // Standing still, and facing **across** the footpath rather than along it,
    // which is what somebody talking to you (or filming) does. `(dz, -dx)` is
    // left of the heading; the hash bit picks which way they turned.
    const side = (h & 1) === 0 ? 1 : -1;
    const tx = out.dz * side;
    const tz = -out.dx * side;
    out.dx = tx;
    out.dz = tz;
  }
  out.phase = phase;
  out.look = h >>> 8;
  return true;
}

/**
 * How far each kind's ambient tier reaches past its cell centre, metres.
 *
 * **Derived from the search that places them, not measured.**
 * `streetlife.METH_REACH`'s rule, and the same trap it documents: a broadphase
 * gate tighter than the search that placed somebody does not fail to *draw*
 * them, it **deletes** them, because this enumeration is the only one there is.
 *
 * Three terms, and the third is the one `CELL_STROLL` bought. `CELL_RESCUE_MAX`
 * is the furthest the pool search can look; `PedestrianField.near` selects on a
 * band's axis-aligned bounding box against the query square, so a band admitted
 * at radius `r` can have its nearest real point out at that square's corner,
 * which is the `sqrt(2)`; and a person stands at that point plus at most
 * `CELL_STROLL` along the kerb, plus a cell for the query point itself being a
 * cell centre rather than the caller's position.
 *
 * **It is a derivation rather than a measurement**, which is the whole reason
 * the placement no longer uses a uniform fraction of the band: that term was
 * unbounded, so this constant could not be derived at all and the gate had to
 * be a guess. A gate tighter than the search that placed somebody does not fail
 * to draw them, it **deletes** them.
 */
export const CHARACTER_REACH = CELL_RESCUE_MAX * 1.415 + CELL_STROLL + CHAR_CELL;

/**
 * Every ambient character of every kind within `radius`, at `tick`.
 *
 * Iteration order is fixed -- cells in row-major order, kinds in `NPC_KIND`
 * order, slots ascending -- for `forEachPoliceNear`'s reason: the promotion scan
 * takes them in order and two processes have to break ties the same way.
 * Returns early if `visit` returns true.
 *
 * The cell sweep is bounded by `radius + CHARACTER_REACH`, which at the 150 m
 * draw radius is a 5-by-5 block of cells for five kinds -- 125 `countIn` calls,
 * each of which is one census read and one bias evaluation, and most of which
 * return zero on the first branch of a gate. The pool searches behind them are
 * cached against the resident set, so the second frame in a place costs nothing
 * at all.
 */
// --- WORKSTREAM AC: one record per cell per tick, and every player reads it ----
//
// This replaces workstream AA's `countInCached`, which memoised `countIn` alone.
// The lesson of that pass is the shape of this one: **nothing the cell sweep
// evaluates depends on who is asking.** The five counts are a function of
// `(cell, day)`; the band pool and its extent are a function of `(cell,
// resident set)`. Only the final radius test knows where the player is.
//
// So `stepCharacters` running the sweep once per combatant was eight players
// asking the same 56 cells the same five questions and then, for each of the
// ~260 people those answers describe, doing a hash, a map lookup and a box test
// that had the same answer for all eight. Memoising `countIn` fixed the first
// half of that and left the second, which is where the 0.10 ms at eight players
// still was: **the pose attempts, not the counts.**
//
// One record holds both halves:
//
//   - the five counts and their sum, so a cell that holds nobody costs one slot
//     read and a branch, and the pool behind it is never touched (which is what
//     keeps a cold cell from paying for a `PedestrianField.near` it does not
//     need -- see `cellBands`);
//   - the pool's bounding box, so the refusal `poseCharacter` does per *person*
//     can be done once per *cell*. It is the identical test against the
//     identical box -- the pool no longer varies by kind or slot -- so it
//     refuses exactly the same people, which is the property `verifyCharacters`
//     asserts by running the sweep with the gate off.
//
// A direct-mapped table with a generation stamp rather than a `Map`, on
// `countInCached`'s own argument: a `Map.get` is about 25 ns, a slot read is two
// array loads, and this is on the path 56 times per player per tick.
// **Collisions are correct rather than tolerated**: a slot holds the exact
// integer identity of the cell in it and a mismatch recomputes, so removing the
// table changes nothing but the time. The slot is `gridSlot`'s tiling of the
// cell grid and not a multiplicative hash, for the reason set out there -- a
// hash of two small adjacent integers collides, and this table measured a 90%
// miss rate with one before the tiling replaced it.
//
// The table is also keyed on the *field*, which the counts do not need and the
// box does. Two `PedestrianField`s in one process is not a game configuration --
// the browser has one and the host shares one across its rooms -- but
// `verifyCharacters` builds its own, and a box remembered from somebody else's
// street grid would be a check that passes because it is comparing a cache with
// itself. A reference compare and a generation compare per call; the whole table
// is dropped when either moves.
const CELL_SLOTS = 1024; // 32 x 32 cells; see `gridSlot`.
/**
 * Derived from the table rather than written as 5, so a sixth character is a
 * wider record and not a character the sweep silently never enumerates. The
 * record's per-kind counts are indexed by `CHARACTER_BIAS`' own order.
 */
const KIND_COUNT = CHARACTER_BIAS.length;
const cellId = new Float64Array(CELL_SLOTS);
const cellStamp = new Int32Array(CELL_SLOTS);
/** Per kind, in `CHARACTER_BIAS` order. */
const cellCount = new Int32Array(CELL_SLOTS * KIND_COUNT);
/** The sum of the five, so the common "nobody here" case is one read. */
const cellTotal = new Int32Array(CELL_SLOTS);
/** `minX, minZ, maxX, maxZ` of the cell's band pool, or the inverted box. */
const cellBox = new Float64Array(CELL_SLOTS * 4);
let cellTick = Number.NaN;
let cellGen = 0;
let cellField: PedestrianField | null = null;
let cellFieldGen = -1;

/**
 * The slot describing `(cx, cz)` on this tick, filling it if it does not.
 *
 * Returns the slot index rather than a record object, because a record object
 * is an allocation per cell per tick and this runs sixty times a second forever
 * -- `FactionField.step`'s rule, and `Pool` is the one place in this file that
 * is allowed a heap object because it is cached across ticks.
 */
function cellSlot(peds: PedestrianField, cx: number, cz: number, day: GameDay, tick: number): number {
  if (tick !== cellTick || peds !== cellField || peds.generation !== cellFieldGen) {
    cellTick = tick;
    cellField = peds;
    cellFieldGen = peds.generation;
    cellGen = (cellGen + 1) | 0;
    // The wrap, once every 400 days of uptime at 60 Hz. Without it a stamp
    // could match a slot written two billion ticks ago, and the count of eshays
    // at Redfern would be last year's for one tick. Cheap to be right.
    if (cellGen === 0) cellStamp.fill(-1);
  }
  const id = (cx + 4096) * 8192 + (cz + 4096);
  const slot = gridSlot(cx, cz);
  if (cellStamp[slot] === cellGen && cellId[slot] === id) return slot;

  const px = charCentre(cx);
  const pz = charCentre(cz);
  let total = 0;
  for (let k = 0; k < KIND_COUNT; k++) {
    const n = countOf(CHARACTER_BIAS[k], px, pz, day);
    cellCount[slot * KIND_COUNT + k] = n;
    total += n;
  }
  cellTotal[slot] = total;
  // The pool, and therefore the box, **only if somebody stands here**. A cell
  // that holds nobody must not pay for the band search: the search is a grid
  // walk and a sort, it is cached only until the next tile streams in, and the
  // sweep touches fifty-odd cells of which most are empty at any hour.
  if (total > 0) {
    const pool = cellBands(peds, cx, cz, poolScratch);
    cellBox[slot * 4] = pool.minX;
    cellBox[slot * 4 + 1] = pool.minZ;
    cellBox[slot * 4 + 2] = pool.maxX;
    cellBox[slot * 4 + 3] = pool.maxZ;
    // A cell with a count and no footpath under it places nobody -- exactly
    // what `poseCharacter` returns false for -- and the inverted box the empty
    // pool carries would fail every test anyway. Zeroing the total here saves
    // the caller a second branch and says the same thing.
    if (pool.bands.length === 0) cellTotal[slot] = 0;
  }
  cellStamp[slot] = cellGen;
  cellId[slot] = id;
  return slot;
}

/** The scratch `cellBands` fills. Module-level; see `stepCharacters`. */
const poolScratch: PedBand[] = [];

export function forEachCharacterNear(
  peds: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: PedBand[],
  out: CharacterPose,
  visit: (pose: CharacterPose) => boolean | void,
  /**
   * WORKSTREAM AA: pass false to pose everybody the cell sweep enumerates,
   * however far away, instead of refusing them off their cell's band pool's
   * extent. **For `verifyCharacters` only** -- it is the "before" of the
   * comparison that proves the gate is exact, and nothing in the game ever
   * turns it off. See `poseCharacter`.
   */
  poseGate = true,
): void {
  const now = trafficSeconds(tick);
  const day = dayAtTick(tick);
  const r2 = radius * radius;
  const span = radius + CHARACTER_REACH;
  const c0x = charCell(x - span);
  const c1x = charCell(x + span);
  const c0z = charCell(z - span);
  const c1z = charCell(z + span);
  const cellGate = span + CHAR_CELL;
  const cellGate2 = cellGate * cellGate;
  // WORKSTREAM AC: the box refusal, hoisted out of `poseCharacter` and applied
  // to the cell. See `cellSlot`: the pool is the cell's, so this is the same
  // comparison against the same numbers, made once instead of once per person.
  const slop = radius + POSE_SLOP;
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      // The cell's own gate, before any placement work: the furthest anybody in
      // this cell can be is half a diagonal plus the reach.
      const ddx = charCentre(cx) - x;
      const ddz = charCentre(cz) - z;
      if (ddx * ddx + ddz * ddz > cellGate2) continue;
      const slot = cellSlot(peds, cx, cz, day, tick);
      if (cellTotal[slot] === 0) continue;
      if (poseGate) {
        const b = slot * 4;
        if (
          cellBox[b] - x > slop || x - cellBox[b + 2] > slop ||
          cellBox[b + 1] - z > slop || z - cellBox[b + 3] > slop
        ) {
          continue;
        }
      }
      for (let k = 0; k < KIND_COUNT; k++) {
        const n = cellCount[slot * KIND_COUNT + k];
        if (n === 0) continue;
        const kind = CHARACTER_BIAS[k].kind;
        for (let i = 0; i < n; i++) {
          // The pose is asked for ungated: the box test above has already made
          // the identical refusal for the whole cell, and asking `poseCharacter`
          // to repeat it would be four compares per person for an answer we
          // hold. It still takes the query for callers that have not.
          if (!poseCharacter(peds, kind, cx, cz, i, now, scratch, out)) continue;
          const dx = out.x - x;
          const dz = out.z - z;
          if (dx * dx + dz * dz > r2) continue;
          if (visit(out) === true) return;
        }
      }
    }
  }
}

// --- Tuning ----------------------------------------------------------------------------------

/** Everybody's capsule. A person, on `game/streetlife.ts`'s own figures. */
const BODY_RADIUS = 0.32;
const BODY_HEIGHT = 1.7;

/**
 * How close you have to be for one of these to become real, metres.
 *
 * `streetlife.DRUNK_NOTICE`'s 7 m generalised, and the gap between noticing and
 * acting is load-bearing for exactly the reason that file gives: **an ambient
 * actor cannot be hit**, because `npcHitTest` walks `field.actors` and nothing
 * else. A character who only became real at the instant they acted on you would
 * be a character who could never be hit while passive, and "hitting a bystander
 * is a crime" would be a rule that could not fire.
 *
 * Nine rather than seven, because four of these five never act at all and the
 * only thing promotion buys them is being hittable and being a solid object.
 * Nine metres is about the distance at which you have decided to walk around
 * somebody.
 */
export const NOTICE_RANGE = 9;

/**
 * How many of these may be promoted at once, across all five kinds.
 *
 * Eight, against `factions.MAX_ACTORS`' twenty-four and
 * `streetlife.MAX_STREET_ACTORS`' ten. The three budgets are deliberately
 * under-subscribed: 8 + 10 + the wildlife's third is not 24, and it is not meant
 * to be. The shared cap is a *wire* budget and the per-faction ones are a
 * promise that **no faction can be the reason an officer could not be
 * dispatched** -- which is the "police presence near spawn" guarantee
 * `verifyPolice` asserts, and it is the one property of this file that a
 * reviewer should check first.
 *
 * `FactionField.actorPriority` is the second line of defence and it already
 * works in our favour: every character here is promoted with `target = -1`
 * except an eshay mid-roll, and a targetless actor scores 2 where a fresh
 * pursuing officer scores 3, so the eviction takes a Karen before it takes a
 * constable. The cap is what stops us reaching the eviction in the first place.
 */
export const MAX_CHARACTER_ACTORS = 8;

/**
 * The eshay's trigger, and the two conditions the brief made of it.
 *
 * *"Passive until you are alone with low health or holding cash"*. Both halves
 * are here:
 *
 *   - **alone** is no other combatant within `ESHAY_ALONE`. In a sixteen-player
 *     melee that is a real state rather than a formality.
 *   - **vulnerable** is health at or under `ESHAY_LOW_HEALTH` pips, *or* a
 *     wallet with anything in it. The `or` matters: a full-health player with
 *     cash is a target, and a broke player on two pips is also a target, and a
 *     player at full health with nothing is left alone. That is three states,
 *     and getting one of them wrong makes them either muggers of everybody or
 *     scenery.
 *
 * `ESHAY_SIGHT` is under `factions.WITNESS_RANGE` on `METH_SIGHT`'s argument:
 * they should not start something they can be seen starting from further away
 * than they can see you.
 */
export const ESHAY_SIGHT = 18;
export const ESHAY_ALONE = 28;
export const ESHAY_LOW_HEALTH = 1.5;
/** Twenty dollars. The brief's number, and the only figure in this file with a currency. */
export const ESHAY_TAKE = 20;
/** A shove is half a pip and a knockdown; it is not a beating. */
export const ESHAY_SHOVE_DAMAGE = 0.5;
export const ESHAY_SHOVE_TICKS = 78;
export const ESHAY_REACH = 1.7;
export const ESHAY_CHASE_SPEED = 5.2;
export const ESHAY_GIVEUP = 55;
export const ESHAY_MAX_HEALTH = 2;
export const ESHAY_DOWN_SECONDS = 9;

/**
 * How far a Karen sees a crime, metres, and it is deliberately **under** the
 * police's forty.
 *
 * Twenty-five is the brief's number and it is the right one for a reason worth
 * writing down: she is not a police officer, she is a person on a footpath, and
 * a witness range equal to a constable's would make her strictly better at
 * policing than the police -- at which point the officers stop mattering. At 25
 * m with a line of sight she covers the near half of a block, which is "she was
 * standing right there" rather than "somebody somewhere saw you".
 */
export const KAREN_RANGE = 25;
export const KAREN_MAX_HEALTH = 1;
export const KAREN_DOWN_SECONDS = 14;

/**
 * How long you have to be down near a tradie before he picks you up, and how
 * close, and how much he gives back.
 *
 * Three seconds, four metres, one pip. The delay is the whole read: he finishes
 * what he was doing. Instant help would be a healing pickup with a face on it;
 * three seconds of him walking over is a bloke noticing.
 *
 * One pip rather than a full heal, because a full heal from an ambient NPC makes
 * every fight in the city winnable by standing next to a building site.
 */
export const TRADIE_HELP_SECONDS = 3;
export const TRADIE_HELP_RANGE = 4;
export const TRADIE_HELP_PIPS = 1;
/**
 * --- WORKSTREAM Z: how much sooner a tradie picks up somebody on `Tradie Rates`.
 *
 * One second off the three, which the node describes as "helps them up 1 s
 * sooner". A second rather than instant, and the second that is left is the one
 * that carries the read: the whole point of the delay is that he *finishes what
 * he was doing*, and a tradie who teleported into a heal would be a pickup with
 * a hard hat on. Two seconds is still visibly him walking over.
 *
 * Clamped in the branch that uses it so the number can never reach zero if
 * somebody retunes `TRADIE_HELP_SECONDS` down.
 */
export const TRADIE_HELP_MATES_RATES_S = 1;
/** And what he does if you hit him. Two pips, once, and then back to work. */
export const TRADIE_DECK_DAMAGE = 2;
export const TRADIE_DECK_TICKS = 90;
export const TRADIE_REACH = 1.8;
export const TRADIE_MAX_HEALTH = 3;
export const TRADIE_DOWN_SECONDS = 8;

/**
 * The influencer's collision radius, metres, and it is **wider than her body**.
 *
 * 0.55 against a 0.32 capsule. The extra 23 cm is the phone at arm's length and
 * the personal space of somebody who has stopped: a player who clips her elbow
 * should be pushed around her, not through her. It is the number the brief's
 * "a real obstacle" turns into, and it is the only place in this file that
 * touches the collision system at all.
 */
export const INFLUENCER_RADIUS = 0.55;
export const INFLUENCER_MAX_HEALTH = 1;
export const INFLUENCER_DOWN_SECONDS = 12;
/** How far the "posted" notice reaches. The brief's number. */
export const POSTED_RANGE = 100;

export const AGENT_MAX_HEALTH = 1;
export const AGENT_DOWN_SECONDS = 12;

// --- What they say -------------------------------------------------------------------------

/**
 * Every line, by kind. **Text, not audio; see the header's section 4.**
 *
 * Three each, and the constraint they were written under is the brief's: funny
 * the way a Sydney person is funny about Sydney, which means specific, deadpan,
 * and about a *behaviour* rather than about a group of people. Nothing here is
 * about anybody's race, and nothing here is a landmark -- a joke about the
 * Opera House is a joke written by somebody who has been here for a weekend.
 *
 * They are indexed by hash rather than cycled, so two of the same kind standing
 * together do not speak in unison. `FactionField.bark` does exactly this with
 * clips and this is the text version of it.
 */
export const CHARACTER_LINES: Readonly<Record<number, readonly string[]>> = {
  [NPC_KIND.ESHAY]: ['eshay ba', 'got a durry?', 'run ya pockets'],
  [NPC_KIND.KAREN]: [
    'I’m calling the police',
    'I want to speak to your manager',
    'I’ve got all this on video',
  ],
  [NPC_KIND.TRADIE]: ['yeah nah, she’ll be right', 'knock off’s at three', 'watch ya step through there'],
  [NPC_KIND.INFLUENCER]: [
    'don’t mind me, just filming',
    'can you go around',
    'that’s going on the story',
  ],
  [NPC_KIND.AGENT]: [
    'auction on the lawn, reserve not met',
    'a renovator’s delight',
    'strong interest from the eastern suburbs',
  ],
};

/** The Karen's line the instant she reports you. Always this one; it is her whole function. */
export const KAREN_REPORT_LINE = CHARACTER_LINES[NPC_KIND.KAREN][0];

/** What the tradie says when he picks you up. Not in the rotation; it is a response. */
export const TRADIE_HELP_LINE = 'you right mate';

/**
 * --- WORKSTREAM Z: what an agent says when `Karen Rapport` knocks somebody out
 * within ten metres of them. Not in the rotation; it is a response, like the
 * tradie's line above and drawn by the same path in `main.ts`.
 *
 * The pip is the server's -- `Simulation.cheerFor` -- and the *line* is the
 * client's, off a range test rather than a wire message, which is the
 * arrangement `TRADIE_HELP_LINE` already established: there is no state byte for
 * "applauding", adding one would be a protocol change for a sentence, and the
 * client already knows both that its own knockout landed and where every agent
 * near it is standing.
 *
 * It is written as an agent's own reaction rather than as congratulation --
 * "outstanding result" is a thing said about a *price*, and the joke of the node
 * is that the man cheering has not understood what he just watched.
 */
export const AGENT_APPLAUSE_LINE = 'outstanding result. absolutely outstanding';

/**
 * The influencer's KO line, and it took several goes.
 *
 * The brief rejected *"%s got ratioed by a bondi influencer"* and it was right
 * to: "ratioed" is a word about the internet, and the joke here is not about the
 * internet, it is about the fact that the *footage exists*. So the line is
 * written as a caption on somebody else's post -- which is what actually happens
 * to you -- and the deadpan is in the engagement number being unremarkable.
 *
 * `%s` is the player, on `NpcKindDef.feedKo`'s convention.
 */
export const POSTED_LINE = '%s is now in someone’s story. 340 views.';

/** And the version everybody else within `POSTED_RANGE` sees. See `world/characters.ts`. */
export const POSTED_LINE_BYSTANDER = 'someone just got put in a story';

/**
 * What one ambient character is saying at `tick`, or null for most of the time.
 *
 * A **pure function of the person and the tick**, which is what lets it exist
 * with no wire and no authority: the client asks, gets the same answer the
 * server would have given, and prints it. Nothing downstream of it decides
 * anything -- see the header's section 4.
 *
 * `SPEAK_PERIOD` is the length of one person's cycle and `SPEAK_WINDOW` is how
 * much of it they are talking for. Twenty-two seconds with a two-second window
 * means one line in eleven seconds of standing next to somebody, which is about
 * how often a person says something unprompted. The phase is hashed off the key
 * so a strip of them is not a chorus.
 */
const SPEAK_PERIOD = 22;
const SPEAK_WINDOW = 2;

export function lineFor(kind: number, key: number, nowSeconds: number): string | null {
  const lines = CHARACTER_LINES[kind];
  if (!lines || lines.length === 0) return null;
  // The key is a large double; `carHash` wants integers, so it is folded to 32
  // bits first. `>>> 0` on a value over 2^32 is a modulo, which is exactly the
  // fold wanted and is exactly specified in both engines.
  const seed = (key % 2147483647) >>> 0;
  const offset = (carHash(seed, 0x77a1) % 1000) / 1000;
  const u = nowSeconds / SPEAK_PERIOD + offset;
  const cycle = Math.floor(u);
  if ((u - cycle) * SPEAK_PERIOD > SPEAK_WINDOW) return null;
  return lines[carHash(seed, cycle) % lines.length];
}

// --- Moving one ----------------------------------------------------------------------------

/**
 * Toward a point, at a speed, sliding off buildings.
 *
 * `streetlife.walkToward`'s twin, restated on that file's own argument: fifteen
 * lines against an edit to a module this one is a consumer of. Resolved against
 * the same prisms a player is, so an eshay takes the corner you took.
 */
function walkToward(actor: NpcActor, tx: number, tz: number, speed: number, ctx: FactionCtx): number {
  const dx = tx - actor.x;
  const dz = tz - actor.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) return 0;
  const d = Math.sqrt(d2);
  const inv = 1 / d;
  actor.dx = dx * inv;
  actor.dz = dz * inv;
  const step = speed * ctx.dt;
  let nx = actor.x + actor.dx * step;
  let nz = actor.z + actor.dz * step;
  if (ctx.collision) {
    const moved = ctx.collision.resolve(actor.x, actor.z, nx, nz, BODY_RADIUS, actor.y + 0.42);
    nx = moved.x;
    nz = moved.z;
  }
  actor.x = nx;
  actor.z = nz;
  actor.y = ctx.groundHeight(nx, nz, actor.y);
  return d;
}

/** The combatant an actor is after, or undefined. `target < 0` is nobody -- never `0`. */
function targetOf(actor: NpcActor, ctx: FactionCtx): CombatantState | undefined {
  if (actor.target < 0) return undefined;
  for (const c of ctx.combatants) if (c.id === actor.target) return c;
  return undefined;
}

/** Whether a combatant can be engaged at all: upright, alive, in the world. */
function engageable(c: CombatantState): boolean {
  // And ON the world. A passenger inside a moving train is not somebody an
  // eshay on the footpath can reach: before this line, the actor would walk to
  // the outside of the carriage, swing at the wall, and debit the wallet of a
  // person doing 100 km/h past him -- the e2e ride acceptance caught the pip
  // half of that (sim.shoot now guards, like every other damage door) and this
  // is the targeting half. Declined here rather than at each caller, because
  // "can this person be engaged" is exactly the question this function is.
  if (isAboard(c.aboard)) return false;
  return c.phase !== 'ko' && c.health > 0;
}

/** Walk back to the anchor and vanish on arrival. Every kind here resolves the same way. */
function goHome(actor: NpcActor, speed: number, ctx: FactionCtx): void {
  actor.target = -1;
  if (actor.state !== NPC_STATE.RETURN) {
    actor.state = NPC_STATE.RETURN;
    actor.stateTicks = 0;
  }
  const left = walkToward(actor, actor.homeX, actor.homeZ, ctx.dt > 0 ? speed : 0, ctx);
  // `health <= -1` is the despawn flag `FactionField.step` sweeps on. An actor
  // that reached its anchor stops being promoted and goes back to being the
  // ambient function it always was -- there is nothing to hand back.
  if (left < 1.2 || actor.stateTicks > 20 * 60) actor.health = -2;
}

/**
 * Stand still and face somebody, without moving. Four of the five do this.
 *
 * A heading write and nothing else. It is a function because "turn to face the
 * player" written five times is five chances to normalise by the wrong distance,
 * and because the guard against a zero-length vector has to be in exactly one
 * place -- a `1/0` here produces a `NaN` heading, which the snapshot encoder
 * turns into a `NaN` yaw and the renderer turns into an invisible person.
 */
function faceToward(actor: NpcActor, tx: number, tz: number): void {
  const dx = tx - actor.x;
  const dz = tz - actor.z;
  const d2 = dx * dx + dz * dz;
  if (d2 < 1e-6) return;
  const inv = 1 / Math.sqrt(d2);
  actor.dx = dx * inv;
  actor.dz = dz * inv;
}

/** The nearest engageable combatant and how far away they are, or null. */
function nearestCombatant(actor: NpcActor, ctx: FactionCtx): { c: CombatantState; d2: number } | null {
  let best: CombatantState | undefined;
  let best2 = Infinity;
  for (const c of ctx.combatants) {
    if (!engageable(c)) continue;
    const dx = c.body.position.x - actor.x;
    const dz = c.body.position.z - actor.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best2) {
      best2 = d2;
      best = c;
    }
  }
  return best ? { c: best, d2: best2 } : null;
}

// --- The eshays ------------------------------------------------------------------------------

/**
 * Whether this combatant is worth rolling. See `ESHAY_SIGHT`'s header for the
 * three states this produces.
 *
 * The wallet read is the only place in the simulation that touches
 * `wallet-contract.ts`, and it goes through `balanceOf` rather than through a
 * speculative `debit`, which matters: a `debit` here would take the money on the
 * *decision* rather than on the shove, so a player who ran would arrive
 * somewhere else twenty dollars poorer with nothing having happened to them.
 */
function worthRolling(c: CombatantState, actor: NpcActor, ctx: FactionCtx): boolean {
  if (c.health > ESHAY_LOW_HEALTH) {
    if (wallet().balanceOf(c.id) <= 0) return false;
  }
  // Alone: nobody else upright within `ESHAY_ALONE`. Their own group does not
  // count -- they are not combatants -- and neither does a downed player.
  for (const other of ctx.combatants) {
    if (other.id === c.id || !engageable(other)) continue;
    const dx = other.body.position.x - c.body.position.x;
    const dz = other.body.position.z - c.body.position.z;
    if (dx * dx + dz * dz < ESHAY_ALONE * ESHAY_ALONE) return false;
  }
  void actor;
  return true;
}

export const ESHAY = registerNpcKind({
  kind: NPC_KIND.ESHAY,
  name: 'eshay',
  radius: BODY_RADIUS,
  height: BODY_HEIGHT,
  // Two swings, `streetlife.METH_MAX_HEALTH`'s figure and its argument: a
  // teenager in a polo is not wearing a stab vest, and the fight has to be
  // winnable while the other two are already on you.
  maxHealth: ESHAY_MAX_HEALTH,
  walkSpeed: 1.2,
  chaseSpeed: ESHAY_CHASE_SPEED,
  downSeconds: ESHAY_DOWN_SECONDS,
  // No audio for any of these five; see the header's section 4. An empty list is
  // already "this kind does not bark" to `FactionField.bark`.
  aggroClips: [],
  aggroCooldownSeconds: 6,
  feedKo: '%s got run for their pockets',
  scoresKo: false,

  /**
   * Hitting one **first** is an ordinary assault; hitting one who is already
   * rolling you is not.
   *
   * `target >= 0` is the aggro flag the framework already maintains, and
   * `streetlife.strikeCrime` reads exactly the same bit for a drunk. The
   * asymmetry is the brief's and it is the correct one: they started it, and a
   * police force that opened an investigation into a mugging victim for
   * defending themselves would be a police force nobody could read.
   */
  strikeReason(actor) {
    return actor.target < 0 && actor.state !== NPC_STATE.DOWN ? REASON.ASSAULT : REASON.NONE;
  },

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.target = -1;
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }

    // One snapshot period of the shove pose before anything else happens. See
    // `NPC_STATE.FIRE`, which is what "an attack just left this actor" means.
    if (actor.state === NPC_STATE.FIRE && actor.stateTicks < 3) return;

    // --- Passive. Standing on the corner, deciding whether you are worth it.
    if (actor.target < 0) {
      if (actor.state === NPC_STATE.RETURN) {
        goHome(actor, ESHAY_CHASE_SPEED * 0.35, ctx);
        return;
      }
      const near = nearestCombatant(actor, ctx);
      if (near && near.d2 <= ESHAY_SIGHT * ESHAY_SIGHT && worthRolling(near.c, actor, ctx)) {
        actor.target = near.c.id;
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
        // And so do the other two. A roll is a group action, and the group is
        // whoever else of this kind is promoted within a shout -- which is the
        // formation `poseCharacter` put them in, still standing together.
        //
        // Done here rather than by each of them noticing you independently,
        // because independent notice produces three people who arrive over four
        // seconds, and the thing being modelled arrives at once.
        for (const mate of ctx.field.actors) {
          if (mate === actor || mate.kind !== NPC_KIND.ESHAY) continue;
          if (mate.target >= 0 || mate.state === NPC_STATE.DOWN) continue;
          const mdx = mate.x - actor.x;
          const mdz = mate.z - actor.z;
          if (mdx * mdx + mdz * mdz > 14 * 14) continue;
          mate.target = near.c.id;
          mate.state = NPC_STATE.CHASE;
          mate.stateTicks = 0;
        }
      } else if (near) {
        faceToward(actor, near.c.body.position.x, near.c.body.position.z);
      }
      return;
    }

    const target = targetOf(actor, ctx);
    if (!target || !engageable(target)) {
      goHome(actor, ESHAY_CHASE_SPEED * 0.35, ctx);
      return;
    }

    const tx = target.body.position.x;
    const tz = target.body.position.z;
    const dx = tx - actor.x;
    const dz = tz - actor.z;
    const range2 = dx * dx + dz * dz;

    // The leash. Shorter than a meth head's seventy: this is a mugging, not a
    // vendetta, and they have somewhere to be.
    if (range2 > ESHAY_GIVEUP * ESHAY_GIVEUP) {
      goHome(actor, ESHAY_CHASE_SPEED * 0.35, ctx);
      return;
    }

    if (range2 <= ESHAY_REACH * ESHAY_REACH) {
      faceToward(actor, tx, tz);
      if (actor.fireCooldown <= 0) {
        actor.fireCooldown = ESHAY_SHOVE_TICKS;
        actor.shotsFired++;
        actor.state = NPC_STATE.FIRE;
        actor.stateTicks = 0;
        ctx.damagePlayer(target.id, ESHAY_SHOVE_DAMAGE, actor);
        // --- And the money. **Once per shove, on the authority, through the
        // contract.** See `game/wallet-contract.ts`: until the wallet lands this
        // returns 0 and takes nothing, and every other part of the interaction
        // is unchanged. The `why` string is the ledger's, not the player's.
        wallet().debit(target.id, ESHAY_TAKE, 'rolled by eshays');
      } else if (actor.state !== NPC_STATE.FIRE) {
        actor.state = NPC_STATE.CHASE;
      }
      return;
    }

    if (actor.state !== NPC_STATE.CHASE) {
      actor.state = NPC_STATE.CHASE;
      actor.stateTicks = 0;
    }
    walkToward(actor, tx, tz, ESHAY_CHASE_SPEED, ctx);
  },
});

// --- The Karen -------------------------------------------------------------------------------

export const KAREN = registerNpcKind({
  kind: NPC_KIND.KAREN,
  name: 'karen',
  radius: BODY_RADIUS,
  height: BODY_HEIGHT,
  maxHealth: KAREN_MAX_HEALTH,
  walkSpeed: 1.0,
  chaseSpeed: 1.0,
  downSeconds: KAREN_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 10,
  // Never fires: `damagePlayer` is not called anywhere in her `think`, and there
  // is no other path from a Karen to a player's health. It is here because
  // `feedKo` is required and a required field with a lie in it is worse than a
  // required field with a joke in it. If it ever appears in the feed, something
  // else is wrong.
  feedKo: '%s was reported to the council',
  scoresKo: false,

  /**
   * An ordinary assault -- and she reports it herself, with no police needed.
   *
   * That second half is not implemented here and does not need to be, which is
   * the neat part: both authorities route a strike's crime through
   * `karenWitness` before deciding, and she is standing zero metres from the
   * crime, so she is always inside `KAREN_RANGE` of her own assault. The rule
   * falls out of the witness rather than being a special case bolted onto it.
   */
  strikeReason() {
    return REASON.ASSAULT;
  },

  think(actor, ctx) {
    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }
    if (actor.state === NPC_STATE.RETURN) {
      goHome(actor, 1.1, ctx);
      return;
    }
    // Standing there, facing whoever is nearest. She does not walk, she does not
    // chase, and she never touches you. Her entire contribution to the
    // simulation is `karenWitness`, which is a query somebody else runs.
    actor.state = NPC_STATE.IDLE;
    const near = nearestCombatant(actor, ctx);
    if (near) faceToward(actor, near.c.body.position.x, near.c.body.position.z);
  },
});

/**
 * Did a Karen see that? **The whole of her function, and it is a query.**
 *
 * Called by both authorities from the one place a crime is adjudicated --
 * `server/sim.reportIfWitnessed` online and `main.accuse` offline -- immediately
 * after `policeWitness` comes back empty. If she saw it, the crime is reported
 * exactly as though a constable had seen it: same `REASON`, same countdown, same
 * banner. She is not a second kind of heat and she does not own a ladder; the
 * heat workstream owns the ladder and this is one more thing that can push a
 * crime onto it.
 *
 * **Both tiers are searched, ambient first**, which is the opposite of
 * `policeWitness`'s order and is right for the same reason that one is: a
 * promoted Karen is one you have walked up to, and by construction there are at
 * most eight of those in the city, while the ambient tier is every Karen on
 * every strip within the query radius. Checking the many first costs one band
 * pool lookup that is already cached and finds the common case immediately.
 *
 * The line of sight is `policeWitness`' geometry exactly -- her eye at
 * `EYE_HEIGHT` over her feet to chest height at the crime -- so a terrace
 * between you is a terrace, and a world with no collision loaded counts as
 * clear. That last is the correct failure and `policeWitness` argues it at
 * length: an authority that can see nothing until the prisms arrive is worse
 * than one that occasionally sees through a tile that has not streamed.
 */
const witnessBands: PedBand[] = [];
const witnessPose: CharacterPose = createCharacterPose();

export function karenWitness(
  x: number,
  z: number,
  tick: number,
  ctx: {
    peds: PedestrianField | null;
    collision: CollisionWorld | null;
    field: { actors: Iterable<NpcActor> } | null;
  },
): boolean {
  const clear = (fx: number, fy: number, fz: number): boolean =>
    ctx.collision === null || !ctx.collision.blocked(fx, fy + EYE_HEIGHT, fz, x, fy + 1.1, z);

  if (ctx.peds) {
    let seen = false;
    // `forEachCharacterNear` walks every kind; the filter is one integer compare
    // and it is cheaper than a second enumeration that only knew about Karens,
    // because the expensive part -- the cell sweep and the pool lookups -- is
    // shared and cached.
    forEachCharacterNear(ctx.peds, x, z, KAREN_RANGE, tick, witnessBands, witnessPose, (p) => {
      if (p.kind !== NPC_KIND.KAREN) return;
      if (!clear(p.x, p.y, p.z)) return;
      seen = true;
      return true;
    });
    if (seen) return true;
  }

  if (ctx.field) {
    const r2 = KAREN_RANGE * KAREN_RANGE;
    for (const a of ctx.field.actors) {
      if (a.kind !== NPC_KIND.KAREN) continue;
      if (a.state === NPC_STATE.DOWN) continue;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (!clear(a.x, a.y, a.z)) continue;
      return true;
    }
  }
  return false;
}

/**
 * She saw it, so she called it in. **The authority's door**; `karenWitness` is
 * the query behind it.
 *
 * Two functions rather than one because the two callers want different things.
 * The *authority* wants the crime reported and does not care who saw it, so it
 * calls this and gets a `reportCrime` for free -- which is the framework's
 * stated one-line dependency (`factions.ts` section 3), drained by
 * `FactionField.step` at the top of the next step in the order it was reported.
 * A *predicting client* is not allowed to report anything -- there is no message
 * that says "a Karen saw me" and there could not be, because the server has her
 * in front of it -- so it calls `karenWitness` and opens its own optimistic
 * banner, exactly as it already does off `policeWitness`.
 *
 * Returns whether she saw it, so the caller can also decide to say something.
 */
export function karenReport(
  playerId: number,
  reason: number,
  x: number,
  z: number,
  tick: number,
  ctx: {
    peds: PedestrianField | null;
    collision: CollisionWorld | null;
    field: { actors: Iterable<NpcActor> } | null;
  },
): boolean {
  if (!karenWitness(x, z, tick, ctx)) return false;
  reportCrime(playerId, reason);
  return true;
}

// --- The tradie ------------------------------------------------------------------------------

export const TRADIE = registerNpcKind({
  kind: NPC_KIND.TRADIE,
  name: 'tradie',
  radius: BODY_RADIUS,
  height: BODY_HEIGHT,
  // Three, which is a constable's. He is the sturdiest non-police body in the
  // game and that is the joke landing as a number.
  maxHealth: TRADIE_MAX_HEALTH,
  walkSpeed: 1.3,
  chaseSpeed: 3.0,
  downSeconds: TRADIE_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 8,
  feedKo: '%s got decked by a tradie',
  scoresKo: false,

  strikeReason() {
    return REASON.ASSAULT;
  },

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.target = -1;
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }
    if (actor.state === NPC_STATE.FIRE && actor.stateTicks < 3) return;

    // --- He hit back, once. `target >= 0` means somebody hit him, which is set
    // by the promotion path below rather than by him noticing anybody: a tradie
    // never starts anything.
    const target = targetOf(actor, ctx);
    // --- WORKSTREAM Z: `Tradie Rates` -- "tradies never deck you".
    //
    // The **whole strike branch** is skipped rather than only the damage line,
    // and that is the difference between the talent working and the talent
    // half-working: leaving the chase in would give a tradie who jogs across the
    // road, stands in your face and does nothing, which reads as a bug in the
    // tradie rather than as a talent on you. Dropping the target here drops him
    // straight into the idle-and-help pass below on the same tick, which is
    // exactly where a tradie who has decided not to bother belongs -- and it is
    // the branch the node's *other* clause lives in, so a Marita who hits one
    // and goes down gets picked up by the man they hit. That is the joke the
    // node is making and it only lands if he is still standing there.
    if (target && fxTradieAlly(target.id)) actor.target = -1;
    else if (target && engageable(target)) {
      const dx = target.body.position.x - actor.x;
      const dz = target.body.position.z - actor.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 30 * 30) {
        // Out of range: back to work. The leash is short because the whole
        // interaction is one punch, not a pursuit.
        actor.target = -1;
        goHome(actor, 1.6, ctx);
        return;
      }
      if (d2 <= TRADIE_REACH * TRADIE_REACH) {
        faceToward(actor, target.body.position.x, target.body.position.z);
        if (actor.fireCooldown <= 0) {
          actor.fireCooldown = TRADIE_DECK_TICKS;
          actor.shotsFired++;
          actor.state = NPC_STATE.FIRE;
          actor.stateTicks = 0;
          ctx.damagePlayer(target.id, TRADIE_DECK_DAMAGE, actor);
          // **And then he is done.** One deck, and back to the ute. This is the
          // single most important line in his `think`: a tradie who kept
          // swinging would be a drunk with a better hat, and the brief's word
          // was "then goes back to work".
          actor.target = -1;
        }
        return;
      }
      if (actor.state !== NPC_STATE.CHASE) {
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
      }
      walkToward(actor, target.body.position.x, target.body.position.z, 3.0, ctx);
      return;
    }

    if (actor.state === NPC_STATE.RETURN) {
      goHome(actor, 1.6, ctx);
      return;
    }

    // --- The help. Somebody on the ground inside `TRADIE_HELP_RANGE` for three
    // seconds gets a pip back and a line.
    //
    // `stateTicks` is the clock and it is the right one: it is already
    // maintained by `FactionField.step`, it resets whenever the state changes,
    // and it counts *simulation* ticks -- so an authority running faster than
    // real time helps somebody up in three simulated seconds rather than in
    // three wall-clock ones. `NpcActor.fireCooldown`'s header makes the same
    // argument about the same trap.
    let helping = false;
    for (const c of ctx.combatants) {
      if (c.phase !== 'ko') continue;
      const dx = c.body.position.x - actor.x;
      const dz = c.body.position.z - actor.z;
      if (dx * dx + dz * dz > TRADIE_HELP_RANGE * TRADIE_HELP_RANGE) continue;
      helping = true;
      faceToward(actor, c.body.position.x, c.body.position.z);
      if (actor.state !== NPC_STATE.IDLE) {
        actor.state = NPC_STATE.IDLE;
        actor.stateTicks = 0;
      }
      // --- WORKSTREAM Z: `Tradie Rates` -- "and helps them up 1 s sooner".
      //
      // Read off the **person on the ground** rather than off the tradie, which
      // is the only reading that makes sense of a talent: it is a fact about who
      // you are, not about which tradie found you. `Math.max` keeps it a delay
      // rather than a teleport if `TRADIE_HELP_SECONDS` is ever tuned to one.
      const wait = fxTradieAlly(c.id)
        ? Math.max(1, TRADIE_HELP_SECONDS - TRADIE_HELP_MATES_RATES_S)
        : TRADIE_HELP_SECONDS;
      if (actor.stateTicks >= wait * 60 && actor.fireCooldown <= 0) {
        // A negative pip count is a heal. `FactionCtx.damagePlayer` is the only
        // door to a player's health that both authorities implement, and
        // routing the heal through it rather than writing `c.health` directly is
        // what makes the server emit its `HIT` and the offline browser play its
        // feedback -- the same argument that member's own header makes.
        ctx.damagePlayer(c.id, -TRADIE_HELP_PIPS, actor);
        actor.fireCooldown = 5 * 60;
      }
      break;
    }
    if (!helping && actor.state !== NPC_STATE.IDLE) {
      actor.state = NPC_STATE.IDLE;
      actor.stateTicks = 0;
    }
  },
});

// --- The influencer --------------------------------------------------------------------------

export const INFLUENCER = registerNpcKind({
  kind: NPC_KIND.INFLUENCER,
  name: 'bondi influencer',
  // **Wider than everybody else**, and it is the feature. See
  // `INFLUENCER_RADIUS`: the capsule `strikeNpc` tests is also the capsule a
  // player is pushed out of, so one number makes her both easier to hit and
  // impossible to walk through.
  radius: INFLUENCER_RADIUS,
  height: BODY_HEIGHT,
  maxHealth: INFLUENCER_MAX_HEALTH,
  walkSpeed: 0.55,
  chaseSpeed: 0.55,
  downSeconds: INFLUENCER_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 12,
  feedKo: '%s walked into the shot',
  scoresKo: false,

  strikeReason() {
    return REASON.ASSAULT;
  },

  think(actor, ctx) {
    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }
    if (actor.state === NPC_STATE.RETURN) {
      goHome(actor, 0.55, ctx);
      return;
    }
    // She stands there with the phone up. Facing whoever is nearest, because a
    // person filming turns to follow the thing they are filming, and because it
    // is the only cue that tells you the phone is pointed at *you*.
    actor.state = NPC_STATE.IDLE;
    const near = nearestCombatant(actor, ctx);
    if (near && near.d2 < 18 * 18) faceToward(actor, near.c.body.position.x, near.c.body.position.z);
  },
});

// --- The real estate agent -------------------------------------------------------------------

export const AGENT = registerNpcKind({
  kind: NPC_KIND.AGENT,
  name: 'real estate agent',
  radius: BODY_RADIUS,
  height: BODY_HEIGHT,
  maxHealth: AGENT_MAX_HEALTH,
  walkSpeed: 1.1,
  chaseSpeed: 1.1,
  downSeconds: AGENT_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 12,
  feedKo: '%s was talked into an auction',
  scoresKo: false,

  /** See `REASON.REAL_ESTATE`, and the header's section 5. */
  strikeReason() {
    return REASON.REAL_ESTATE;
  },

  think(actor, ctx) {
    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
      }
      return;
    }
    if (actor.state === NPC_STATE.RETURN) {
      goHome(actor, 1.1, ctx);
      return;
    }
    actor.state = NPC_STATE.IDLE;
    const near = nearestCombatant(actor, ctx);
    if (near && near.d2 < 20 * 20) faceToward(actor, near.c.body.position.x, near.c.body.position.z);
  },
});

// --- The promotion scan ------------------------------------------------------------------------

/** Whether a kind byte belongs to this file. The renderer and the crime path both ask. */
export function isCharacterKind(kind: number): boolean {
  return kind >= NPC_KIND.ESHAY && kind <= NPC_KIND.AGENT;
}

/**
 * One tick of the ambient tier: who you have walked up to.
 *
 * **Called by the authority immediately after `FactionField.step`**, beside
 * `stepStreetlife` and `stepWildlife`, and the ordering rule is theirs: `step`
 * clears `FactionField.events` at the top of every call, so anything queued
 * before it is wiped before it is drained.
 *
 * Allocates nothing. The scratch is module-level and reused, on
 * `FactionField.step`'s own argument: this runs sixty times a second forever.
 *
 * **WORKSTREAM AC changed nothing in this function, deliberately.** The cost was
 * all in `forEachCharacterNear` and it was the same question asked once per
 * combatant; what that pass did was memoise the answer, not reorder the scan.
 * The visit stream this loop consumes -- cells row-major, kinds in table order,
 * slots ascending, positions to the last bit -- is unchanged, which is what
 * makes the promotion *timing* unchanged: the same person becomes solid on the
 * same tick, and the same person wins the shared cap when it binds.
 * `verifyCharacters` asserts that stream against an independent enumeration
 * built out of `countIn` and `poseCharacter`, rather than asserting it here.
 *
 * Every promotion here is with `target = -1` -- **passive**. Nobody in this file
 * is promoted already angry. The eshay decides to roll you in his own `think` on
 * the tick after, which costs sixteen milliseconds and buys the property that
 * `strikeReason` reads: there is always at least one tick in which he is a
 * hittable bystander, and hitting him then is a crime.
 */
const scanBands: PedBand[] = [];
const scanPose: CharacterPose = createCharacterPose();

export function stepCharacters(ctx: FactionCtx): void {
  const peds = ctx.peds;
  if (!peds) return;
  const field = ctx.field;

  let live = 0;
  for (const a of field.actors) if (isCharacterKind(a.kind)) live++;
  if (live >= MAX_CHARACTER_ACTORS) return;

  for (const c of ctx.combatants) {
    // A knocked-out player still promotes, and it is deliberate: the tradie's
    // whole interaction is with somebody on the ground, so gating the scan on
    // `engageable` would have made the one helpful NPC in the game unreachable
    // by the only people who need him.
    if (c.health <= 0 && c.phase !== 'ko') continue;
    const cx = c.body.position.x;
    const cz = c.body.position.z;
    forEachCharacterNear(peds, cx, cz, NOTICE_RANGE, ctx.tick, scanBands, scanPose, (p) => {
      if (live >= MAX_CHARACTER_ACTORS) return true;
      if (occupied(field, p.kind, p.baseX, p.baseZ)) return;
      const actor = field.promote(p.kind, p.x, p.y, p.z, p.dx, p.dz, -1);
      if (actor === null) return true;
      actor.homeX = p.baseX;
      actor.homeZ = p.baseZ;
      live++;
    });
    if (live >= MAX_CHARACTER_ACTORS) return;
  }
}

/**
 * Whether this anchor already has somebody standing on it.
 *
 * `streetlife.occupied` verbatim, and the reason it is keyed on the **anchor**
 * rather than on the live position is that file's: a promoted actor walks away
 * from where it started, so "is this one already out" asked against its current
 * position says no the moment it takes a step, and the same person is promoted
 * every tick until the cap refuses.
 */
function occupied(field: { actors: Iterable<NpcActor> }, kind: number, baseX: number, baseZ: number): boolean {
  for (const a of field.actors) {
    if (a.kind !== kind) continue;
    const dx = a.homeX - baseX;
    const dz = a.homeZ - baseZ;
    if (dx * dx + dz * dz < 1) return true;
  }
  return false;
}

/**
 * Somebody hit a tradie. Point him at them.
 *
 * The one thing in this file that has to be told about a strike, and it is
 * called from the two places that adjudicate one -- `server/sim.hitNpc` and
 * `main.ts`'s swing path -- immediately after `strikeNpc`. **After**, not
 * before, which is the opposite of `strikeCrime`'s rule and for the mirrored
 * reason: `strikeCrime` asks about the person who was standing there a moment
 * ago, and this tells the person who is standing there now what to do about it.
 *
 * A no-op for every other kind, so the call site is one line with no `switch` in
 * it. That is the same shape `reportCrime` has and it is deliberate: a consumer
 * of this module should never have to know which of the five it is holding.
 */
export function characterStruck(actor: NpcActor, attackerId: number): void {
  if (actor.kind !== NPC_KIND.TRADIE) return;
  if (actor.state === NPC_STATE.DOWN) return;
  if (attackerId < 0) return;
  actor.target = attackerId;
  actor.state = NPC_STATE.CHASE;
  actor.stateTicks = 0;
}

// --- The self-check -----------------------------------------------------------------------------

/**
 * Everything about these five that fails by rendering a plausible city.
 *
 * `verifyStreetlife`'s criterion: none of these throws, and every one of them
 * would ship as a tuning complaint rather than as a bug.
 *
 *   - **The two epochs drifting apart** makes every time gate in this file
 *     wrong by however far they drifted, so tradies knock off at midnight and
 *     eshays appear at lunchtime -- and the *sky* is the only thing that says
 *     so, three hours into a session.
 *   - **A bias that is never zero** is a character who is everywhere, which
 *     from any one street corner looks exactly like a character who is in the
 *     right place.
 *   - **Two biases that agree** is five characters that are one character in
 *     five costumes, and it is invisible unless somebody walks from Bondi to
 *     Blacktown counting.
 *   - **A count that rounds near a half** is the only determinism failure this
 *     feature can actually have: two engines would place a different *number*
 *     of people in a cell, and the renderer would draw a Karen the server does
 *     not think exists.
 *   - **A promotion budget that eats the shared cap** is the police failing to
 *     arrive, which reads as the heat system being broken rather than as this
 *     file being greedy.
 *   - **A key space that collides** with `streetKey` or `pedKey` hands the
 *     renderer's rig pool one identity for two people, and the symptom is
 *     somebody's clothes changing as you walk past.
 */
export function verifyCharacters(): string[] {
  const failures: string[] = [];
  // --- The far city's light follows the sky: full at noon, a fraction at
  // midnight, and never a step.
  {
    const noon = slabLight((SUNRISE_PHASE + SUNSET_PHASE) / 2);
    const midnight = slabLight(((SUNSET_PHASE + 1 + SUNRISE_PHASE) / 2) % 1);
    if (noon !== 1) failures.push(`the far city is ${noon} lit at noon, not 1.`);
    if (Math.abs(midnight - NIGHT_SLAB) > 1e-9) failures.push(`the far city is ${midnight} lit at midnight, not ${NIGHT_SLAB}.`);
    let prev = slabLight(0);
    let jump = 0;
    for (let i = 1; i <= 2000; i++) {
      const v = slabLight(i / 2000);
      jump = Math.max(jump, Math.abs(v - prev));
      prev = v;
    }
    if (jump > 0.06) failures.push(`the far city's light steps by ${jump.toFixed(3)} in a two-thousandth of a day.`);
  }

  // --- The two epochs. See `dayAt`.
  if (TRAFFIC_EPOCH_MS !== CYCLE_EPOCH_MS) {
    failures.push(
      `The traffic epoch (${TRAFFIC_EPOCH_MS}) and the sky's (${CYCLE_EPOCH_MS}) differ, so ` +
        '`dayAtTick` returns a phase the sun disagrees with and every time gate in this file is wrong.',
    );
  }
  // And the calendar, from the other end: a week has to contain exactly one of
  // each named day, or "Saturday" is either never or twice.
  {
    let saturdays = 0;
    let sundays = 0;
    for (let d = 0; d < WEEK_DAYS; d++) {
      if (saturdayAt(d)) saturdays++;
      if (sundayAt(d)) sundays++;
    }
    if (saturdays !== 1 || sundays !== 1) {
      failures.push(
        `A ${WEEK_DAYS}-day week contains ${saturdays} Saturdays and ${sundays} Sundays; it must contain one of each.`,
      );
    }
    // Negative day indices, which a machine whose clock is set before 2026
    // produces. `%` keeps the sign in JavaScript and would make every one of
    // these false forever, so the whole weekend would silently never happen.
    if (!saturdayAt(SATURDAY_MODULUS - WEEK_DAYS * 3)) {
      failures.push('saturdayAt is false for a negative day index; the modulus is not folded.');
    }
  }

  // --- The bias table.
  if (CHARACTER_BIAS.length !== 5) {
    failures.push(`The bias table has ${CHARACTER_BIAS.length} rows and there are five characters.`);
  }
  {
    const kinds = new Set<number>();
    for (const b of CHARACTER_BIAS) {
      if (kinds.has(b.kind)) failures.push(`Two bias rows both claim kind ${b.kind} ("${b.name}").`);
      kinds.add(b.kind);
      if (!isCharacterKind(b.kind)) failures.push(`Bias row "${b.name}" claims kind ${b.kind}, which is not one of ours.`);
    }
    for (const kind of [NPC_KIND.ESHAY, NPC_KIND.KAREN, NPC_KIND.TRADIE, NPC_KIND.INFLUENCER, NPC_KIND.AGENT]) {
      if (!kinds.has(kind)) failures.push(`Kind ${kind} is registered but has no bias row, so it exists nowhere.`);
    }
  }
  // A lattice of real places -- the CBD, the inner west, the north shore, the
  // beach, the south-west, the fringe -- crossed with four times of day. Every
  // row is evaluated at every point, which is 24 evaluations per row and is what
  // makes the three assertions below meaningful rather than anecdotal.
  {
    const probes: Array<[string, number, number]> = [
      ['Town Hall', 0, 0],
      ['Newtown', -2679, 3269],
      ['Chatswood', -2763, -7863],
      ['Bondi', 6054, 2337],
      ['Bankstown', -16384, 5634],
      ['Penrith', -47295, -11788],
    ];
    const phases = [0.05, 0.3, 0.55, 0.85];
    const seen = new Map<string, string>();
    for (const b of CHARACTER_BIAS) {
      let everZero = false;
      let everPositive = false;
      const signature: number[] = [];
      for (const [name, x, z] of probes) {
        for (const phase of phases) {
          const w = b.weight(x, z, phase);
          if (!Number.isFinite(w) || w < 0) {
            failures.push(`Bias "${b.name}" returned ${w} at ${name} phase ${phase}; it must be finite and non-negative.`);
          }
          if (w === 0) everZero = true;
          if (w > 0) everPositive = true;
          signature.push(Math.round(w * 1000));
        }
      }
      if (!everZero) {
        failures.push(
          `Bias "${b.name}" is never zero over the probe lattice, so this character is everywhere. ` +
            'A bias with no off state is a bias that is not doing anything.',
        );
      }
      if (!everPositive) {
        failures.push(`Bias "${b.name}" is zero everywhere on the probe lattice, so nobody of this kind exists.`);
      }
      const key = signature.join(',');
      const twin = seen.get(key);
      if (twin !== undefined) {
        failures.push(`Biases "${twin}" and "${b.name}" agree at every probe; two of the five characters are the same character.`);
      }
      seen.set(key, b.name);
    }
  }

  // --- The rounding margin. See the header's section 6 and `countIn`.
  //
  // The determinism claim is that two engines round `CELL_BASE * census * bias`
  // to the same integer. That is true unless the product lands within a
  // floating-point hair of a half, so this walks a real slab of the city and
  // reports the closest approach rather than asserting the claim.
  {
    const day: GameDay = { index: 6, phase: 0.35 };
    let worst = 0.5;
    let worstAt = '';
    for (let cx = -40; cx <= 20; cx += 3) {
      for (let cz = -30; cz <= 30; cz += 3) {
        for (const b of CHARACTER_BIAS) {
          const x = charCentre(cx);
          const z = charCentre(cz);
          const w = b.weight(x, z, day.phase);
          if (!(w > 0)) continue;
          const raw = CELL_BASE * crowdMultiplier(x, z) * w;
          const margin = Math.abs(raw - Math.floor(raw) - 0.5);
          if (margin < worst) {
            worst = margin;
            worstAt = `${b.name} at cell (${cx}, ${cz})`;
          }
        }
      }
    }
    // 1e-9 of a person. Two IEEE-754 doubles produced by the same sequence of
    // exactly-specified operations are bit-identical; the only operation in the
    // chain that is not is `crowdMultiplier`'s `Math.exp`, whose worst-case
    // disagreement between engines is a handful of ULPs -- about 1e-16 relative.
    // A margin nine orders of magnitude above that is not a coincidence, it is
    // headroom, and the check exists to notice the day a retune removes it.
    if (worst < 1e-9) {
      failures.push(
        `A cell population rounds ${worst.toExponential(2)} from a half (${worstAt}). Two engines could ` +
          'round it differently, and the client would draw somebody the server does not have.',
      );
    }
  }

  // --- The budgets, against the shared cap and the police's guarantee.
  if (MAX_CHARACTER_ACTORS >= MAX_ACTORS) {
    failures.push(
      `MAX_CHARACTER_ACTORS is ${MAX_CHARACTER_ACTORS} against a shared cap of ${MAX_ACTORS}; this faction ` +
        'alone could fill the wire and no officer could ever be dispatched.',
    );
  }
  // The three faction budgets plus a pursuit have to fit. `PURSUIT_TARGET` is 4
  // and `streetlife.MAX_STREET_ACTORS` is 10; the wildlife takes a third. This
  // asserts the sum leaves room rather than trusting three files to stay polite.
  if (MAX_CHARACTER_ACTORS + 10 + Math.floor(MAX_ACTORS / 3) + 4 > MAX_ACTORS + 8) {
    failures.push(
      'The per-faction promotion budgets no longer leave room for a four-officer pursuit inside the shared cap.',
    );
  }

  // --- The key space, against the two it has to clear.
  //
  // `streetKey` occupies [2^40, 2^40 + VENUE_COUNT * 16) and `pedKey` cannot
  // reach 2^40 at all. This asserts our base clears the top of that range and
  // that our own packing stays inside a double's exact-integer window.
  {
    const STREET_KEY_TOP = 1099511627776 + 65536;
    if (KEY_BASE <= STREET_KEY_TOP) {
      failures.push(`The character key base ${KEY_BASE} does not clear streetKey's range; two people would share an identity.`);
    }
    const extreme = characterKey(NPC_KIND.AGENT, 150, 150, 31);
    if (!Number.isSafeInteger(extreme)) {
      failures.push(`characterKey(${150}, ${150}, 31) is ${extreme}, which is not an exact integer; keys would collide at random.`);
    }
    const a = characterKey(NPC_KIND.ESHAY, 3, -4, 0);
    const b = characterKey(NPC_KIND.KAREN, 3, -4, 0);
    const c = characterKey(NPC_KIND.ESHAY, 3, -4, 1);
    const d = characterKey(NPC_KIND.ESHAY, 4, -4, 0);
    if (a === b || a === c || a === d) failures.push('characterKey collides across kind, slot or cell.');
  }

  // --- The dialogue, which fails by being absent rather than by being wrong.
  for (const kind of [NPC_KIND.ESHAY, NPC_KIND.KAREN, NPC_KIND.TRADIE, NPC_KIND.INFLUENCER, NPC_KIND.AGENT]) {
    const lines = CHARACTER_LINES[kind];
    if (!lines || lines.length < 2) {
      failures.push(`Kind ${kind} has fewer than two lines, so it repeats itself the second time you meet one.`);
    }
    for (const line of lines ?? []) {
      if (line.length === 0 || line.length > 60) {
        failures.push(`A line for kind ${kind} is ${line.length} characters; the notice bar shows about sixty.`);
      }
    }
  }
  // And the speech clock, which fails by being always-on or never-on. Over a
  // thousand seconds one person should speak between thirty and sixty times;
  // the window is 2 s in 22, so the expectation is 45.
  {
    let spoke = 0;
    const key = characterKey(NPC_KIND.AGENT, 2, 3, 1);
    for (let s = 0; s < 10000; s++) {
      if (lineFor(NPC_KIND.AGENT, key, s * 0.1) !== null) spoke++;
    }
    // 10,000 samples at 0.1 s is 1,000 seconds; the duty is 2/22, so about 909.
    if (spoke < 600 || spoke > 1200) {
      failures.push(`One character spoke on ${spoke} of 10,000 samples; the speech duty cycle is broken.`);
    }
  }

  // --- The eshay's arithmetic, which inverts the feature when it is wrong.
  if (ESHAY_SIGHT >= ESHAY_GIVEUP) {
    failures.push('An eshay gives up closer than he notices, so he would aggro and immediately walk home, forever.');
  }
  if (ESHAY_TAKE <= 0) failures.push('An eshay takes nothing, which makes the roll a shove.');
  if (ESHAY_GROUP < 2) failures.push('An eshay group is smaller than two; the brief’s word was "in threes".');

  // --- The lateral budget, which is the one thing in this file that has
  // actually put people inside a wall. See `KERB_LEAN`.
  for (const [kind, lean] of Object.entries(KERB_LEAN)) {
    const across = Number(kind) === NPC_KIND.ESHAY ? ESHAY_ACROSS : 0;
    if (Math.abs(lean) + across > MAX_LATERAL) {
      failures.push(
        `Kind ${kind} is displaced ${(Math.abs(lean) + across).toFixed(2)} m across the footpath against a ` +
          `budget of ${MAX_LATERAL} m. A footpath band is the centre line of a two-metre path, so anything ` +
          'past this stands inside the building beside it -- drawn, hittable and completely invisible.',
      );
    }
  }
  // The eshay formation's own reach, from the other end: three of them share one
  // band point, and the furthest of them must still be on the concrete.
  if (ESHAY_ACROSS > MAX_LATERAL) failures.push('An eshay group is wider than the footpath it stands on.');

  // --- WORKSTREAM AA: the pose gate refuses nobody.
  //
  // `poseCharacter` now returns false, before it works out where somebody is,
  // when their cell's band pool cannot reach the caller's query. That took
  // `stepCharacters` from 0.23 ms a tick to a fifth of it, and it is only sound
  // if it is **exact**: a person the ungated sweep would have found inside the
  // radius and the gated one refuses is a character who is drawn by a client
  // running one version and is not there on a server running the other -- an
  // NPC you can walk through, or one who mugs you from nowhere.
  //
  // So both sweeps are run over a real `PedestrianField` -- the synthetic CBD
  // grid `verifyPedestrians` measures its own density against -- at a spread of
  // query points, radii and ticks, and the sets of keys are compared. The
  // radii deliberately bracket the two real callers: `NOTICE_RANGE` (9 m, the
  // promotion scan, which is where the cost was) and something near
  // `CHARACTER_DRAW_RADIUS` (the renderer's, where the gate barely bites).
  {
    const grid = syntheticGrid();
    if (grid === null) {
      failures.push('verifyCharacters could not build its synthetic street grid; the pose gate is unproven.');
    } else {
      const peds = new PedestrianField();
      peds.adopt('grid', grid);
      const bands: PedBand[] = [];
      const pose = createCharacterPose();
      const keysWithin = (x: number, z: number, r: number, tick: number, gate: boolean): string => {
        const found: string[] = [];
        forEachCharacterNear(peds, x, z, r, tick, bands, pose, (p) => {
          found.push(`${p.kind}:${p.cx},${p.cz}#${p.index}`);
        }, gate);
        // The visit order is the sweep's and is identical either way -- cells
        // row-major, kinds in table order, slots ascending -- so the join is a
        // comparison of order as well as of membership, which is the stronger
        // statement and the one a promotion scan needs (it takes the first).
        return found.join('|');
      };
      let mismatch = '';
      // A day's worth of ticks at a coarse stride, so every bias's gate --
      // night for the eshays, daylight for the Karens, Saturday for the agents
      // -- is open at some point in the sweep.
      outer: for (let tick = 0; tick < 240_000 && mismatch === ''; tick += 9_137) {
        for (const r of [NOTICE_RANGE, 40, 150]) {
          for (let q = 0; q < 9; q++) {
            const x = -100 + (q % 3) * 180;
            const z = -260 + Math.floor(q / 3) * 150;
            const gated = keysWithin(x, z, r, tick, true);
            const plain = keysWithin(x, z, r, tick, false);
            if (gated !== plain) {
              mismatch =
                `at (${x}, ${z}) r=${r} tick=${tick}: gated found [${gated}], ungated found [${plain}]`;
              break outer;
            }
          }
        }
      }
      if (mismatch !== '') {
        failures.push(
          `The pose gate changed who is nearby ${mismatch}. POSE_SLOP (${POSE_SLOP} m) does not cover ` +
            'everything `poseCharacter` displaces somebody by, so characters are being deleted rather than skipped.',
        );
      }
    }
  }

  // --- ...and the bound it rests on, from the tables rather than from the
  // fixture above. A synthetic grid exercises the kinds it happens to place; the
  // arithmetic has to hold for all five whatever the fixture found.
  {
    let worst = 0;
    for (const kind of Object.keys(KERB_LEAN)) {
      const k = Number(kind);
      const lean = Math.abs(KERB_LEAN[k] ?? 0);
      const idle = IDLE_AMPLITUDE[k] ?? 0;
      const group = k === NPC_KIND.ESHAY ? 1.15 + ESHAY_ACROSS : 0;
      const sum = lean + idle + group;
      if (sum > worst) worst = sum;
    }
    if (POSE_SLOP < worst) {
      failures.push(
        `POSE_SLOP is ${POSE_SLOP} m against a worst-case displacement of ${worst.toFixed(2)} m. ` +
          'The pose gate would refuse somebody who is actually within range, which deletes them from the world.',
      );
    }
  }

  // --- WORKSTREAM AC: the per-point geometry cache answers what the functions
  // behind it answer.
  //
  // Three fields, one of which -- the distance to the nearest of 267 stations --
  // decides how many eshays exist. A cache that returned a neighbouring cell's
  // answer would put a group of three outside a station that is not there, on
  // both ends, consistently, which is a bug no determinism check can see and no
  // screenshot can either. The points below are walked **twice, interleaved with
  // a second set**, so that a slot which was quietly stolen and refilled is
  // caught rather than a slot which was merely never contended.
  {
    let wrong = 0;
    let example = '';
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 240; i++) {
        // Two sequences 32 cells apart, which is exactly the aliasing distance
        // of `gridSlot`'s tiling -- the case the cache is allowed to miss and is
        // not allowed to get wrong.
        const cx = (i % 40) - 20 + (pass === 0 ? 0 : 32);
        const cz = Math.floor(i / 40) * 7 - 20;
        const x = charCentre(cx);
        const z = charCentre(cz);
        const slot = geomAt(x, z);
        const station = nearestStationDist2(x, z);
        const beach = nearestBeachDist2(x, z);
        const crowd = crowdMultiplier(x, z);
        if (geomStation[slot] !== station || geomBeach[slot] !== beach || geomCrowd[slot] !== crowd) {
          wrong++;
          if (example === '') {
            example =
              `cell (${cx}, ${cz}): cached station ${geomStation[slot].toFixed(1)} against ${station.toFixed(1)}, ` +
              `beach ${geomBeach[slot].toFixed(1)} against ${beach.toFixed(1)}, ` +
              `crowd ${geomCrowd[slot].toFixed(4)} against ${crowd.toFixed(4)}`;
          }
        }
      }
    }
    if (wrong > 0) {
      failures.push(
        `The per-cell geometry cache returned somebody else's answer at ${wrong} of 480 points -- ${example}. ` +
          'Every count in this file is derived from those three numbers, so the city would be populated off a ' +
          'neighbouring cell.',
      );
    }
  }

  // --- WORKSTREAM AC: the per-tick cell record, against a sweep that has none,
  // and against a second field on the same tick.
  //
  // `forEachCharacterNear` now reads a direct-mapped record per cell per tick --
  // five counts, the pool's bounding box -- and every player in a room reads the
  // same one. Three things can go wrong with that and all three are silent:
  //
  //   1. **A stale record.** The stamp is the tick; a tick that did not
  //      invalidate would hand the next tick the last one's counts, and the
  //      symptom is a Karen who exists for one frame after her hour ends.
  //   2. **A record from somebody else's world.** The box comes from a
  //      `PedestrianField`, and two fields on one tick -- which is exactly what
  //      this check itself creates -- must not see each other's boxes.
  //   3. **The hoisted box refusing somebody.** The refusal `poseCharacter` made
  //      per person is now made once per cell. It is the same box (the pool is
  //      the cell's, not the person's) but "it is the same box" is a sentence,
  //      and this is the measurement.
  //
  // The reference is built out of the two exported primitives -- `countIn` and
  // an ungated `poseCharacter` -- in the sweep's own order, so it is the same
  // enumeration written a second way rather than the same code called twice.
  // Positions are compared, not just identities: a record that returned the
  // right *number* of people in the wrong *place* is the failure mode a key
  // comparison cannot see.
  {
    const gridA = syntheticGrid(0, 0);
    const gridB = syntheticGrid(-2000, 4500);
    if (gridA === null || gridB === null) {
      failures.push('verifyCharacters could not build its second street grid; the per-tick cell record is unproven.');
    } else {
      const a = new PedestrianField();
      a.adopt('a', gridA);
      a.adopt('b', gridB);
      // A second field with the identical content, standing in for the other end
      // of the wire. Queries against the two are interleaved below.
      const b = new PedestrianField();
      b.adopt('a', gridA);
      b.adopt('b', gridB);
      // And a **third field whose streets are somewhere the other two have
      // none**, queried in between them. Two identical fields cannot catch a
      // record that forgot which field it came from -- they agree by
      // construction -- and that is the bug this check was written for and did
      // not catch until this field existed. Over `gridC`'s block the first two
      // fields hold nothing, so their record says "no footpath here, nobody
      // stands in this cell"; a record that leaked would delete every character
      // on the third field's streets, which is the whole failure in one line.
      const gridC = syntheticGrid(2000, 2000);
      const c = gridC === null ? null : new PedestrianField();
      if (c !== null && gridC !== null) c.adopt('c', gridC);
      const bands: PedBand[] = [];
      const pose = createCharacterPose();
      const line = (p: CharacterPose): string =>
        `${p.kind}:${p.cx},${p.cz}#${p.index}@${p.x.toFixed(4)},${p.z.toFixed(4)},${p.dx.toFixed(4)}`;
      /** The sweep, written out longhand with no record and no gate. */
      const reference = (peds: PedestrianField, x: number, z: number, r: number, tick: number): string[] => {
        const found: string[] = [];
        const now = trafficSeconds(tick);
        const day = dayAtTick(tick);
        const span = r + CHARACTER_REACH;
        const cellGate = span + CHAR_CELL;
        const scratch: PedBand[] = [];
        const out = createCharacterPose();
        for (let cx = charCell(x - span); cx <= charCell(x + span); cx++) {
          for (let cz = charCell(z - span); cz <= charCell(z + span); cz++) {
            const ddx = charCentre(cx) - x;
            const ddz = charCentre(cz) - z;
            if (ddx * ddx + ddz * ddz > cellGate * cellGate) continue;
            for (const bias of CHARACTER_BIAS) {
              const n = countIn(bias.kind, cx, cz, day);
              for (let i = 0; i < n; i++) {
                if (!poseCharacter(peds, bias.kind, cx, cz, i, now, scratch, out)) continue;
                const dx = out.x - x;
                const dz = out.z - z;
                if (dx * dx + dz * dz > r * r) continue;
                found.push(line(out));
              }
            }
          }
        }
        return found;
      };
      let recordMismatch = '';
      let fieldMismatch = '';
      let placed = 0;
      // Several densities: the two grids sit over different census cells and at
      // different distances from the station and beach tables, so the counts
      // differ between them rather than the same fixture being checked twice.
      const spots: Array<[number, number]> = [
        [0, 0], [150, -150], [-100, -260], [-2000, 4500], [-1850, 4350], [-1700, 4600],
        // Over the third field's block, where the first two have no streets.
        [2000, 2000], [2150, 1850],
      ];
      outer: for (let tick = 0; tick < 240_000; tick += 26_669) {
        for (const r of [NOTICE_RANGE, KAREN_RANGE, 150]) {
          for (const [x, z] of spots) {
            const live: string[] = [];
            const other: string[] = [];
            const third: string[] = [];
            // Interleaved on purpose, and on the same tick: a record keyed on
            // the tick and not on the field would hand `b` the boxes it just
            // filled for `a`, and `c` -- whose streets are somewhere else --
            // would be answered off `a`'s pools.
            forEachCharacterNear(a, x, z, r, tick, bands, pose, (p) => { live.push(line(p)); });
            forEachCharacterNear(b, x, z, r, tick, bands, pose, (p) => { other.push(line(p)); });
            if (c !== null) forEachCharacterNear(c, x, z, r, tick, bands, pose, (p) => { third.push(line(p)); });
            const want = reference(a, x, z, r, tick);
            const wantThird = c === null ? [] : reference(c, x, z, r, tick);
            placed += live.length;
            if (recordMismatch === '' && live.join('|') !== want.join('|')) {
              recordMismatch = `at (${x}, ${z}) r=${r} tick=${tick}: swept [${live.join('|')}], reference [${want.join('|')}]`;
            }
            if (recordMismatch === '' && third.join('|') !== wantThird.join('|')) {
              recordMismatch =
                `on a third field at (${x}, ${z}) r=${r} tick=${tick}: swept [${third.join('|')}], ` +
                `reference [${wantThird.join('|')}] -- the record is answering one field's query off another's pools`;
            }
            if (fieldMismatch === '' && live.join('|') !== other.join('|')) {
              fieldMismatch = `at (${x}, ${z}) r=${r} tick=${tick}: one field [${live.join('|')}], the other [${other.join('|')}]`;
            }
            if (recordMismatch !== '' && fieldMismatch !== '') break outer;
          }
        }
      }
      if (placed === 0) {
        failures.push(
          'The cell-record comparison placed nobody over two grids, three radii and nine ticks, so it proves ' +
            'nothing. The fixture has drifted away from the bias table.',
        );
      }
      if (recordMismatch !== '') {
        failures.push(
          `The per-tick cell record changed who is nearby ${recordMismatch}. The sweep no longer agrees with ` +
            'countIn and poseCharacter, which are what the renderer and the authority each believe.',
        );
      }
      if (fieldMismatch !== '') {
        failures.push(
          `Two identical band sets placed different people on one tick ${fieldMismatch}. The per-tick record is ` +
            'keyed on the tick but not on the field it came from.',
        );
      }

      // --- A tile arriving mid-tick changes the answer mid-tick.
      //
      // The record's box is a property of the resident band set, and on the host
      // that set changes **hundreds of times a second** while a hexagon streams
      // in -- `PedestrianField.generation` bumps per tile. A record stamped only
      // with the tick would answer the rest of that tick off the world as it was
      // before the tile landed, which is a character who is not there for one
      // frame and is there the next, or worse is missing for the frame in which
      // a player walks past them. Cheap to be right: one integer compare.
      if (c !== null && gridC !== null) {
        const tick = 60_000;
        const want: string[] = [];
        forEachCharacterNear(c, 2000, 2000, 150, tick, bands, pose, (p) => { want.push(line(p)); });
        const late = new PedestrianField();
        const got: string[] = [];
        // Queried empty first, on the same tick, so there is a record to be
        // stale, and then again with the streets in.
        forEachCharacterNear(late, 2000, 2000, 150, tick, bands, pose, () => {});
        late.adopt('c', gridC);
        forEachCharacterNear(late, 2000, 2000, 150, tick, bands, pose, (p) => { got.push(line(p)); });
        if (want.length === 0) {
          failures.push('The mid-tick streaming check found nobody to stream in; it proves nothing.');
        } else if (want.join('|') !== got.join('|')) {
          failures.push(
            `A tile adopted mid-tick did not change who is nearby: the field that had it all along found ` +
              `${want.length} character(s) and the one it arrived on found ${got.length}. The per-tick cell ` +
              'record is not keyed on `PedestrianField.generation`, so a streaming host answers off the world ' +
              'as it was at the top of the tick.',
          );
        }
      }

      // --- And the box the hoisted refusal rests on: everybody a cell places is
      // inside that cell's pool box, grown by `POSE_SLOP`.
      //
      // This is the invariant, rather than a consequence of it. The check above
      // would catch a box that is too small *for the query points it tries*;
      // this catches one that is too small for anybody, which is the property
      // the refusal actually needs.
      {
        const day = dayAtTick(120_000);
        const now = trafficSeconds(120_000);
        const scratch: PedBand[] = [];
        const out = createCharacterPose();
        let outside = 0;
        let example = '';
        for (let cx = -8; cx <= 8; cx++) {
          for (let cz = -8; cz <= 8; cz++) {
            const pool = cellBands(a, cx, cz, scratch);
            if (pool.bands.length === 0) continue;
            for (const bias of CHARACTER_BIAS) {
              const n = countIn(bias.kind, cx, cz, day);
              for (let i = 0; i < n; i++) {
                if (!poseCharacter(a, bias.kind, cx, cz, i, now, scratch, out)) continue;
                const over = Math.max(
                  pool.minX - out.x, out.x - pool.maxX, pool.minZ - out.z, out.z - pool.maxZ,
                );
                if (over > POSE_SLOP) {
                  outside++;
                  if (example === '') {
                    example = `kind ${bias.kind} in cell (${cx}, ${cz}) stands ${over.toFixed(2)} m outside its pool box`;
                  }
                }
              }
            }
          }
        }
        if (outside > 0) {
          failures.push(
            `${outside} placed character(s) finish further than POSE_SLOP (${POSE_SLOP} m) outside their cell's ` +
              `band pool -- ${example}. The cell-level box refusal deletes them from the sweep.`,
          );
        }
      }
    }
  }

  // --- And the influencer's radius, which is the whole of her obstruction.
  if (INFLUENCER_RADIUS <= BODY_RADIUS) {
    failures.push(
      `The influencer's radius (${INFLUENCER_RADIUS}) is not wider than a body's (${BODY_RADIUS}), so she is ` +
        'not an obstacle and the one thing she does is nothing.',
    );
  }

  return failures;
}

/** Keep the imports honest: `FactionField` is used only as a type in `karenWitness`. */
export type { FactionField };
