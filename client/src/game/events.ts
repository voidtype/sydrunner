/**
 * Ambient events: five things that are happening somewhere in Sydney right now,
 * whether or not you go and look at them.
 *
 * The simulation half. `world/events.ts` is what they look like, and the split
 * is `game/rave.ts` against `world/rave.ts` exactly -- this file is compiled
 * into the Bun server and must not drag an `InstancedMesh` in behind a schedule
 * lookup.
 *
 * ---------------------------------------------------------------------------
 * 1. WHAT AN EVENT IS, AND WHAT IT COSTS
 *
 * A **site**: a position, a kind, a start phase and a duration, all four of them
 * derived by hashing `(dayIndex, cellX, cellZ)`. Nothing is stored, nothing is
 * sent, and nothing is decided at runtime -- `eventsAt(day, bounds)` is a pure
 * function that two processes evaluate to the same answer, which is
 * `rave.liveRaves`'s bargain and its whole reason for existing. The same day
 * really is the same events for everybody, including for a player who joins an
 * hour late and for the server that has been up for a week.
 *
 * That gets the schedule for nothing. What it does not get is the *people*, and
 * the second decision in this file is that most of them are free too.
 *
 * ---------------------------------------------------------------------------
 * 2. THE CAST IS AMBIENT, THE TROUBLE IS PROMOTED
 *
 * The obvious implementation of "a bin-night ibis riot" is twelve promoted
 * `NPC_KIND.IBIS` actors. That is half of `factions.MAX_ACTORS` for one event,
 * on a wire budget shared with the police -- and the guarantee this project
 * makes is that no faction can be the reason an officer could not be dispatched.
 * Twelve ibises would break it on the first bin night.
 *
 * So a site has two casts and they are separated by one question: **does this
 * body have to make a decision?**
 *
 *   - **The ambient cast** does not. A commuter in a queue that never moves, a
 *     driver gesturing at another driver, an ibis on a bin, a crowd filming a
 *     car -- every one of them is a pure function of `(site, index, tick)`, and
 *     `castOf` below is that function. Zero bytes of protocol, zero promoted
 *     slots, and `factions.ts` section 2's exact contract. This is where
 *     fourteen of the average event's sixteen bodies live.
 *   - **The promoted cast** does. A meth head who might bolt and two officers
 *     who might chase him are three actors with a `think`, so they are real
 *     actors out of the real `promote`, subject to the real cap, and they exist
 *     only while somebody is close enough to care.
 *
 * The props are on the ambient side too, and that includes **the cars**. A
 * fender-bender's Ranger and Camry are geometry at a fixed pose, not entries in
 * `game/traffic.ts`: traffic is a timetable lookup over baked routes with no
 * concept of a vehicle that has stopped, and teaching it one would be a change
 * to the busiest shared decoder in the build for two parked cars. The burnout's
 * hoon car is the same geometry on a deterministic circle. Both are described
 * here and drawn there.
 *
 * ---------------------------------------------------------------------------
 * 3. WHERE, AND THE THREE DIFFERENT ANSWERS
 *
 * The sites are hashed per **event cell** -- 2 km, so a cell is a suburb rather
 * than a street -- and the roll is weighted by `density.crowdMultiplier`, so
 * there are more of them where there are more people and none at all in the
 * national park. That is the default and three of the five kinds use it.
 *
 * Two do not, and both say so:
 *
 *   - **Trackwork** happens at a station, so its position is
 *     `characters.nearestStation` to the cell centre rather than a jittered
 *     point. A trackwork bus stop in the middle of a paddock would be the
 *     single most obviously broken thing this feature could ship.
 *   - **The burnout** wants a big-box retail car park, and there is no shop tag
 *     a three-free module can read -- the `attributes` block is per-tile and
 *     lives behind the streamer. So it is keyed on **low-to-middling census
 *     density on a Saturday night**, which is what a retail park is at that
 *     hour: nobody lives there, and the surrounding suburb does. It is the same
 *     substitution `characters.ts`' tradie bias makes and it is stated for the
 *     same reason -- a player will not find one outside an actual Bunnings, they
 *     will find one in the kind of place a Bunnings is.
 *
 * ---------------------------------------------------------------------------
 * 4. WHEN, AND HOW LONG
 *
 * The clock is `characters.dayAtTick`, which is `sky/cycle.ts` read off the
 * shared tick. Each kind declares a window it may start inside and a duration in
 * **real minutes**, converted to phase here rather than written as a phase,
 * because "three to eight minutes" is the thing that was decided and
 * `0.05 .. 0.133` is an implementation of it.
 *
 * The brief's own arithmetic is worth keeping: one in-game day is one real hour,
 * so two to six *game* minutes is five to fifteen real seconds, which is not an
 * event, it is a glimpse. Three to eight real minutes is 3 to 8 in-game hours,
 * which is far too long for a car crash and exactly right for a bin night. So
 * the durations below are **per kind** rather than one range, and the two that
 * are long are long on purpose.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM
 *
 * `game/factions.ts` rule 5 in force. Every roll is `rave.hash` -- restated
 * here rather than imported, because importing `game/rave.ts` for a hash would
 * pull four hundred baked warehouse sites into the server's module graph -- and
 * every angle is a hash index into a fixed table of unit vectors rather than a
 * `Math.cos`. `RING_COS`/`RING_SIN` below is that table, and it is
 * the only way to put twelve ibises around a bin without a transcendental.
 */

import { NPC_KIND, NPC_STATE, type FactionCtx } from './factions.ts';
import { crowdMultiplier } from './density.ts';
import {
  CHAR_CELL,
  STATIONS,
  STATION_COUNT,
  dayAtTick,
  daylight,
  nearestStation,
  saturdayAt,
  weekendAt,
  type GameDay,
} from './characters.ts';
import { CYCLE_MS } from '../sky/cycle.ts';
import { type PedBand, type PedestrianField } from './pedestrians.ts';
import { trafficSeconds } from './traffic.ts';

// --- The hash -------------------------------------------------------------------------

/**
 * `game/rave.ts`'s hash, unchanged, so every deterministic population in this
 * project agrees about what a hash is.
 *
 * Integer throughout -- `Math.imul` and the shifts are exactly specified in
 * every engine -- with exactly one divide at the end to land in [0, 1). It is
 * copied rather than imported for the reason the header gives: `game/rave.ts`
 * is 2,000 lines and 454 baked sites, and importing it here would put all of
 * that in the Bun server's graph to get eight lines of arithmetic.
 */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/** The same hash as an integer, for a table index. */
function hashInt(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return (h ^ (h >>> 13)) >>> 0;
}

/**
 * Sixteen unit vectors around a circle, baked.
 *
 * The replacement for every `Math.cos`/`Math.sin` this file would otherwise
 * want -- a ring of ibises around a bin, a crowd arc around a hoon car, a queue
 * curling round a station forecourt. `factions.ts` rule 5 forbids the
 * transcendentals on a shared path and `streetlife.triangle` is the same answer
 * for a different question (a wave, not a circle).
 *
 * Sixteen because that is the smallest ring in which two adjacent members are
 * not obviously adjacent: at 22.5 degrees apart, twelve ibises around a 1.2 m
 * bin are irregular enough to read as birds. The values are written to nine
 * decimal places, which is exact enough that the two engines agree to the last
 * bit of a float and short enough to read.
 */
const RING_COS: readonly number[] = [
  1, 0.923879533, 0.707106781, 0.382683432, 0, -0.382683432, -0.707106781, -0.923879533,
  -1, -0.923879533, -0.707106781, -0.382683432, 0, 0.382683432, 0.707106781, 0.923879533,
];
const RING_SIN: readonly number[] = [
  0, 0.382683432, 0.707106781, 0.923879533, 1, 0.923879533, 0.707106781, 0.382683432,
  0, -0.382683432, -0.707106781, -0.923879533, -1, -0.923879533, -0.707106781, -0.382683432,
];
const RING = 16;

// --- What an event is -----------------------------------------------------------------

/**
 * The five kinds. **Append only**: the byte is hashed on in `castOf` and shown
 * on the big map, so renumbering would move every event that has ever happened
 * and relabel the ones that did not move.
 */
export const EVENT_KIND = {
  FENDER: 0,
  STANDOFF: 1,
  IBIS_RIOT: 2,
  BURNOUT: 3,
  TRACKWORK: 4,
} as const;

export const EVENT_COUNT = 5;

/**
 * What the big map calls each one.
 *
 * Lower case and plain, `hud.ts`'s voice throughout, and named for **what you
 * would see** rather than for what the code calls it: nobody walks past a
 * `STANDOFF`, they walk past a bloke and two coppers.
 */
export const EVENT_NAME: readonly string[] = [
  'two-car nothing',
  'police and a bloke',
  'bin night',
  'car park burnout',
  'buses replace trains',
];

/** One scheduled event. Entirely derived; never stored and never sent. */
export interface EventSite {
  /**
   * Stable within a day, and **unique across the world on that day**: the cell
   * indices packed with the slot. Used as a hash seed, as the renderer's pool
   * key and as the map marker's identity, so it has to survive being computed
   * twice on two machines -- which is why it is packed arithmetic rather than an
   * incrementing counter.
   */
  id: number;
  kind: number;
  x: number;
  z: number;
  /** In-game day this belongs to. `characters.dayAtTick().index`. */
  day: number;
  /** Cycle phase it opens at, in [0, 1). */
  startPhase: number;
  /** How long it runs, in phase. See `DURATION_MINUTES`. */
  spanPhase: number;
  /** A per-site hash seed, so two events of a kind on one day are not identical. */
  seed: number;
}

function createSite(): EventSite {
  return { id: 0, kind: 0, x: 0, z: 0, day: 0, startPhase: 0, spanPhase: 0, seed: 0 };
}

// --- The schedule ---------------------------------------------------------------------

/**
 * The scheduling cell, metres. **2 km, which is a suburb.**
 *
 * `characters.CHAR_CELL` is 420 m because a character is a person on a street.
 * An event is a thing that happens in a suburb, and a 420 m grid would have put
 * one within four hundred metres of every other one -- which is not five events
 * in Sydney, it is a theme park. At 2 km the built extent holds about 3,600
 * cells and the roll below lights perhaps one in forty of them.
 */
export const EVENT_CELL = 2000;

/** Which event cell a coordinate is in. */
export function eventCell(v: number): number {
  return Math.floor(v / EVENT_CELL);
}

/** The centre of an event cell. Every roll is evaluated here. */
export function eventCentre(c: number): number {
  return c * EVENT_CELL + EVENT_CELL / 2;
}

/**
 * The scale factor on a cell's total desirability, and it is the one number in
 * this file that was tuned against a measurement rather than chosen.
 *
 * A cell's chance of holding an event is `SITE_CHANCE * total`, where `total` is
 * the sum of the five per-kind weights below and runs about 1.7 to 3.4. The
 * built extent inside 20 km holds four hundred event cells, so this lands
 * somewhere around thirty-five sites a day in that square -- a visible scatter on
 * the big map, roughly one live at any instant within a kilometre of the CBD,
 * and nothing at all out past Richmond. The durations are three to eight real
 * minutes out of a sixty-minute day, so about one site in ten is on when you
 * look at it, which is what makes finding one worth the walk.
 *
 * **The weights and the existence roll are the same number, and that is the
 * whole of the fix this constant carries.** The first cut rolled existence
 * against `crowdMultiplier` alone and then picked a kind from the weights, and
 * the consequence was measured rather than reasoned about: every one of the
 * eleven sites scheduled on one Saturday sat in a cell whose census multiplier
 * was 0.56 or higher, because a low-density cell almost never passed the gate.
 * A burnout wants a *car park*, which is by definition low density -- so the
 * burnout never once happened, in four weeks over 1,600 km2, while looking
 * entirely correct in the source. Rolling existence against the sum means a cell
 * that is a bad place for four kinds and a good place for the fifth is a cell
 * that holds the fifth.
 */
const SITE_CHANCE = 1 / 25;

/**
 * How long each kind runs, in **real minutes**.
 *
 * Converted to phase in `spanFor`, never written as a phase. See the header's
 * section 4 for why the brief's "2 to 6 game minutes" was not usable and why
 * these are per-kind rather than one range.
 *
 *   - a **fender-bender** is four minutes: long enough to walk over from the
 *     next street, short enough that the argument has an end.
 *   - a **standoff** is three: it resolves one way or the other.
 *   - **bin night** is eight, and it is the long one on purpose -- bins go out
 *     in the evening and the ibises are there until somebody moves them.
 *   - a **burnout** is three. They do not last.
 *   - **trackwork** is eight, and eight is generous rather than accurate. The
 *     joke is that it never ends; the schedule is what stops it actually never
 *     ending.
 */
const DURATION_MINUTES: readonly number[] = [4, 3, 8, 3, 8];

/** Real minutes to a fraction of a cycle. One in-game day is one real hour. */
function spanFor(kind: number): number {
  return ((DURATION_MINUTES[kind] ?? 4) * 60 * 1000) / CYCLE_MS;
}

/**
 * The window each kind may start inside, as `[from, to]` in cycle phase.
 *
 * 0 is solar midnight, 0.25 sunrise, 0.75 sunset. Two of these wrap past
 * midnight and `startFor` handles that rather than the table pretending it does
 * not -- a window written as `[0.8, 0.1]` and read naively schedules nothing.
 */
const START_WINDOW: readonly (readonly [number, number])[] = [
  [0.28, 0.72], // fender-bender: daylight, because you have to see the damage.
  [0.6, 0.95], // standoff: late afternoon into the night.
  [0.72, 0.98], // bin night: bins go out after dark. This is the one that is literally named for its window.
  [0.78, 0.05], // burnout: after dark, wrapping past midnight. Saturday only; see `kindFor`.
  [0.3, 0.6], // trackwork: the daytime shift. Weekends only.
];

/** Where in its window a site starts. Wrapping is handled here, once. */
function startFor(kind: number, seed: number): number {
  const [from, to] = START_WINDOW[kind] ?? [0.3, 0.7];
  const span = to >= from ? to - from : 1 - from + to;
  const at = from + hash(seed, 0x5f1a) * span;
  return at >= 1 ? at - 1 : at;
}

/**
 * How much each kind wants this cell, written into `out`, and the total.
 *
 * The calendar gates are here rather than in `START_WINDOW` because they are
 * about the *day* and that table is about the hour, and mixing them produced a
 * table nobody could read. Two kinds are gated:
 *
 *   - the **burnout** is Saturday night only, which is the brief's, and it is
 *     the only kind in the file that is rare on purpose rather than rare by
 *     density.
 *   - **trackwork** is the weekend, both days, because that is when it is. A
 *     Saturday-only trackwork would have been a joke that only half lands.
 *
 * The geography is the three keys the header describes: bin night wants houses,
 * the burnout wants a car park, and everything else wants people.
 */
function kindWeights(day: GameDay, cx: number, cz: number, out: number[]): number {
  const x = eventCentre(cx);
  const z = eventCentre(cz);
  const m = crowdMultiplier(x, z);
  const saturday = saturdayAt(day.index);
  const weekend = weekendAt(day.index);

  // Fender-bender: anywhere there is traffic, so straight density.
  out[EVENT_KIND.FENDER] = 0.9 * m;
  // Standoff: the field `game/streetlife.ts` puts meth heads on, which is
  // density with a floor -- a standoff in a quiet street is still a standoff.
  out[EVENT_KIND.STANDOFF] = 0.7 * (m + 0.15);
  // Bin night: houses. The same low-to-middling tent the agent's bias uses, and
  // for the identical reason -- a tower does not put its bins on a kerb.
  out[EVENT_KIND.IBIS_RIOT] = 1.1 * Math.max(0, 1 - Math.abs(m - 0.3) / 0.4);
  // Burnout: a car park, which is low density on a Saturday night and nothing
  // otherwise.
  out[EVENT_KIND.BURNOUT] = saturday ? 1.4 * Math.max(0, 1 - Math.abs(m - 0.22) / 0.3) : 0;
  // Trackwork: the weekend, and scaled by density because a station forecourt
  // with a queue in it is a station somebody uses. `siteIn` still refuses if
  // there is no station within a cell of here, which is the real filter; this is
  // only what stops the bush branch lines outnumbering the suburban ones.
  out[EVENT_KIND.TRACKWORK] = weekend ? 0.9 * Math.min(1, m * 2) : 0;

  let total = 0;
  for (let k = 0; k < EVENT_COUNT; k++) total += out[k];
  return total;
}

/** Draw a kind from the weights `kindWeights` wrote. -1 if they are all zero. */
function pickKind(w: readonly number[], total: number, seed: number): number {
  if (total <= 0) return -1;
  let r = hash(seed, 0x2b73) * total;
  for (let k = 0; k < EVENT_COUNT; k++) {
    r -= w[k];
    if (r <= 0) return k;
  }
  return EVENT_COUNT - 1;
}

/**
 * How far from a cell centre a trackwork site will look for a station, metres.
 *
 * One cell. Further than that and the site is not in the cell that rolled it,
 * which breaks the one property the cell grid buys: that two adjacent cells
 * cannot both put their event on the same corner.
 */
const STATION_REACH = EVENT_CELL;

/**
 * The site a cell holds on a day, or false.
 *
 * Writes into `out` and returns whether there is anything there, which is
 * `pedestrians.posePedestrian`'s contract and its argument: this is called for
 * every cell in a sweep and a returned object per empty cell would be an
 * allocation per empty cell.
 */
const siteWeights = new Array<number>(EVENT_COUNT).fill(0);

function siteIn(day: GameDay, cx: number, cz: number, out: EventSite): boolean {
  const cellId = (cx + 2048) * 4096 + (cz + 2048);
  const seed = hashInt(day.index, cellId);
  const x0 = eventCentre(cx);
  const z0 = eventCentre(cz);
  const total = kindWeights(day, cx, cz, siteWeights);
  if (hash(seed, 0x11d3) > SITE_CHANCE * total) return false;
  const kind = pickKind(siteWeights, total, seed);
  if (kind < 0) return false;

  let x: number;
  let z: number;
  if (kind === EVENT_KIND.TRACKWORK) {
    // A forecourt, or nothing. See `STATION_REACH`.
    const station = nearestStation(x0, z0);
    if (!station) return false;
    const dx = station.x - x0;
    const dz = station.z - z0;
    if (dx * dx + dz * dz > STATION_REACH * STATION_REACH) return false;
    // Twelve metres off the site, on the ring, which is the forecourt rather
    // than the platform: `rail.RailStation.siteX` is the mean of the calling
    // anchors, so it is between the tracks, and standing a queue there would put
    // twenty commuters on the ballast.
    const a = hashInt(seed, 0x74c1) % RING;
    x = station.x + RING_COS[a] * 26;
    z = station.z + RING_SIN[a] * 26;
  } else {
    // A jittered point inside the cell, drawn as a square rather than a disc --
    // a disc needs a sine, and the corners are a slightly higher chance of the
    // cell edge, which is not a property anybody can see. `poseMethhead`'s own
    // patch offset makes the identical trade.
    x = x0 + (hash(seed, 0x8a15) * 2 - 1) * (EVENT_CELL * 0.42);
    z = z0 + (hash(seed, 0xc031) * 2 - 1) * (EVENT_CELL * 0.42);
  }

  out.id = cellId * 8 + kind;
  out.kind = kind;
  out.x = x;
  out.z = z;
  out.day = day.index;
  out.startPhase = startFor(kind, seed);
  out.spanPhase = spanFor(kind);
  out.seed = seed;
  return true;
}

/**
 * Every event on a day inside a box. **The pure entry point.**
 *
 * The box is in world metres and is inclusive; the sweep is over event cells
 * that overlap it. `out` is reused by the caller and is truncated rather than
 * replaced, which is `protocol.decodeSnapshot`'s trick and is here for the same
 * reason: the minimap asks this question fifteen times a second forever.
 *
 * Sites are returned in cell row-major order, which is a fixed order two
 * processes agree on -- the same reason `forEachPoliceNear` fixes its own.
 */
export function eventsAt(
  dayIndex: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: EventSite[],
  phase = 0.5,
): EventSite[] {
  out.length = 0;
  const day: GameDay = { index: dayIndex, phase };
  const c0x = eventCell(minX);
  const c1x = eventCell(maxX);
  const c0z = eventCell(minZ);
  const c1z = eventCell(maxZ);
  const scratch = createSite();
  for (let cx = c0x; cx <= c1x; cx++) {
    for (let cz = c0z; cz <= c1z; cz++) {
      if (!siteIn(day, cx, cz, scratch)) continue;
      if (scratch.x < minX || scratch.x > maxX || scratch.z < minZ || scratch.z > maxZ) continue;
      out.push({ ...scratch });
    }
  }
  return out;
}

/**
 * How far through a site's run a phase is, in [0, 1], or -1 if it is not on.
 *
 * `rave.nightProgress`'s shape and its argument: the "not on" case has to be a
 * value nothing can mistake for "just started", which a plain 0 could -- and
 * which would put a car crash on every kerb in the city at every hour.
 *
 * Wrapping is handled, because two of the five windows cross midnight. The site
 * belongs to the day it *started* on, so a burnout that begins at phase 0.9 and
 * runs 0.05 finishes at phase 0.95 of the same day rather than at 0.0 of the
 * next -- and one that starts at 0.98 finishes at 0.03 of the next, which is the
 * case this branch exists for.
 */
export function eventProgress(site: EventSite, phase: number): number {
  const from = site.startPhase;
  const to = from + site.spanPhase;
  if (to <= 1) {
    return phase >= from && phase < to ? (phase - from) / site.spanPhase : -1;
  }
  // Wrapped: on from `from` to the end of the cycle, and again from 0 to `to-1`.
  if (phase >= from) return (phase - from) / site.spanPhase;
  if (phase < to - 1) return (phase + 1 - from) / site.spanPhase;
  return -1;
}

/**
 * How far a site will look for a footpath to stand on, metres, and **the fix
 * for events happening on the roof of a terrace in Chippendale.**
 *
 * `siteIn` jitters a point inside a 2 km cell, which is the right way to choose
 * *where in a suburb* something happens and completely the wrong way to choose
 * *what it is standing on*: measured, the first fender-bender scheduled near the
 * spawn landed in the middle of a block of Chippendale terraces, about eight
 * metres above the street, with two cars and four onlookers on the rooftops.
 *
 * `game/characters.ts` solved the identical problem for people by placing them
 * on `pedestrians.PedBand`s -- the centre lines of real footpaths -- and this is
 * that, one tier up. The difference is *where* it happens: a character's
 * placement is pure and needs the band field, so the whole placement lives
 * behind `poseCharacter`. An event's *schedule* has to stay pure and cheap,
 * because the big map and the minimap ask for it fifteen times a second and
 * neither of them is going to hold a band field for a site 40 km away.
 *
 * So the schedule stays pure and the **snap is a second, optional pass**:
 * `eventsAt` gives the nominal point and `liveEventsAt` moves it onto the
 * nearest kerb when it is handed a field. A caller with no field gets the
 * nominal point, which is right to within a couple of hundred metres and is all
 * a dot on a city map needs.
 *
 * **Sixty metres, and it is deliberately small.** The first cut used three
 * hundred, which fixed the rooftops and broke two other things at once: a
 * snapped site could move most of a block, so the dot on the big map -- which
 * has no band field and therefore no snap -- stopped agreeing with where the
 * cars were drawn, and a site whose nominal point was outside the caller's query
 * box could snap into it (and out of it) unseen. Sixty metres is a nudge onto
 * the nearest kerb rather than a relocation: it is under half a city block, it
 * is smaller than a marker dot at any map zoom, and it covers the case this
 * exists for -- a jittered point that landed in the middle of a block of
 * terraces instead of on the street beside them.
 *
 * A site with no footpath within sixty metres keeps its nominal point and is
 * drawn where the hash put it. Out past Wisemans Ferry that is a paddock, and a
 * paddock is a perfectly good place for a car to have stopped.
 */
export const SNAP_REACH = 60;

/**
 * Move a site onto the nearest footpath, in place.
 *
 * The **nearest point on the nearest band**, not a point at a hashed fraction
 * along it: `characters.CELL_STROLL` documents at length why a uniform fraction
 * of a band is not a position, and the argument is the same here with one
 * addition -- a site that moved when a tile streamed in would drag its whole
 * cast with it, and twenty-five people in a queue sliding two hundred metres
 * sideways is a great deal more visible than one loiterer doing it.
 *
 * Idempotent: snapping an already-snapped site is a no-op to within the band
 * geometry, because the nearest point on the band to a point already on the
 * band is itself.
 */
const snapScratch: PedBand[] = [];

export function snapSite(peds: PedestrianField, site: EventSite): void {
  peds.near(site.x, site.z, SNAP_REACH, snapScratch);
  if (snapScratch.length === 0) return;
  let bestX = site.x;
  let bestZ = site.z;
  let best2 = Infinity;
  for (const band of snapScratch) {
    for (let i = 0; i < band.count - 1; i++) {
      const ax = band.x[i];
      const az = band.z[i];
      const ex = band.x[i + 1] - ax;
      const ez = band.z[i + 1] - az;
      const len2 = ex * ex + ez * ez;
      let t = len2 > 1e-9 ? ((site.x - ax) * ex + (site.z - az) * ez) / len2 : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const px = ax + ex * t;
      const pz = az + ez * t;
      const dx = px - site.x;
      const dz = pz - site.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best2) {
        best2 = d2;
        bestX = px;
        bestZ = pz;
      }
    }
  }
  site.x = bestX;
  site.z = bestZ;
}

/**
 * Every event running *right now* inside a box, at a shared tick.
 *
 * `peds` is optional and is the snap; see `SNAP_REACH`. Both authorities and the
 * renderer pass one, and the two maps do not.
 */
export function liveEventsAt(
  tick: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
  out: EventSite[],
  peds: PedestrianField | null = null,
): EventSite[] {
  const day = dayAtTick(tick);
  // **The box is widened by the snap and narrowed again afterwards.** A site
  // whose nominal point is just outside the caller's box can snap into it, and
  // one just inside can snap out; querying at the nominal box alone makes an
  // event flicker in and out as the player walks along its edge. The widening is
  // one extra cell's worth of hashing at most, and the second filter below is
  // what the caller actually asked for.
  const pad = peds ? SNAP_REACH : 0;
  const all: EventSite[] = [];
  eventsAt(day.index, minX - pad, minZ - pad, maxX + pad, maxZ + pad, all, day.phase);
  out.length = 0;
  for (const s of all) if (eventProgress(s, day.phase) >= 0) out.push(s);
  // A site whose window wrapped past midnight belongs to *yesterday* and is
  // still on. Without this pass, every burnout in the city vanishes at solar
  // midnight and reappears as a different one, which reads as a streaming bug.
  const prev: EventSite[] = [];
  eventsAt(day.index - 1, minX - pad, minZ - pad, maxX + pad, maxZ + pad, prev, day.phase);
  for (const s of prev) {
    if (s.startPhase + s.spanPhase <= 1) continue;
    if (eventProgress(s, day.phase) >= 0) out.push(s);
  }
  // The snap, after both passes, so a wrapped site gets it too. `eventsAt`
  // returns fresh records rather than the shared scratch, so moving them here
  // cannot corrupt anybody else's copy.
  if (peds) {
    for (const s of out) snapSite(peds, s);
    // And the box the caller actually asked for, now that everybody has moved.
    for (let i = out.length - 1; i >= 0; i--) {
      const s = out[i];
      if (s.x < minX || s.x > maxX || s.z < minZ || s.z > maxZ) out.splice(i, 1);
    }
  }
  return out;
}

// --- The cast -------------------------------------------------------------------------------

/**
 * What one member of an ambient cast is.
 *
 * `role` is what the renderer switches on and it deliberately mixes people and
 * objects: from this file's point of view a Camry with its hazards on and a
 * bloke shouting at it are both "something at a pose that belongs to this
 * event", and giving them two enumerations would mean two sweeps, two pools and
 * two ways to get the ground height wrong.
 *
 * `y` is **always 0 on the way out** and is the caller's job. This module has no
 * terrain -- `FactionCtx.groundHeight` on the authority and the composed ground
 * query in `main.ts` are two different functions over two different residency
 * sets -- so a `y` computed here would be a lie on at least one of them.
 */
export const CAST_ROLE = {
  /** A person. `look` picks the kit; see `world/events.ts`. */
  BODY: 0,
  /** A person who is a police officer, drawn in the uniform. Ambient only. */
  COP: 1,
  /** A person who is a meth head. Ambient only; the promoted one is a real actor. */
  JUNKIE: 2,
  /** A bird. `world/wildlife.ts`'s ibis, drawn by this event's own pool. */
  IBIS: 3,
  /** A stopped car with its hazards on. */
  CAR: 4,
  /** The hoon's car, on a circle. Its own role because it moves. */
  HOON: 5,
  /** A kerbside bin. */
  BIN: 6,
  /** An A-frame sign. The text comes from the event kind. */
  SIGN: 7,
} as const;

export interface CastMember {
  /** Stable within the event, for the renderer's pool. `site.id * 64 + index`. */
  key: number;
  role: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  /** Per-individual look bits, and for a car the body variant. */
  look: number;
  /** 0..1, the idle clock. For `HOON` it is the position on the circle. */
  phase: number;
}

function createMember(): CastMember {
  return { key: 0, role: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1, look: 0, phase: 0 };
}

/**
 * How many bodies each kind puts on the ground, and it is the tuning table a
 * reader should look at first.
 *
 * The crowd sizes grow with `progress` for two of the five -- a fender-bender
 * gathers a crowd and a burnout gathers one -- which is the whole of what makes
 * them read as *events* rather than as tableaux. See `castOf`.
 */
const CAST_SIZE: readonly number[] = [
  8, // fender: 2 cars, 2 drivers, up to 4 onlookers
  4, // standoff: 1 junkie + 2 cops ambient, 1 onlooker (the promoted three replace them)
  14, // bin night: 2 bins + up to 12 ibises
  10, // burnout: 1 hoon car + up to 9 filming
  24, // trackwork: 1 sign + up to 23 in the queue
];

/** The most any event can ask for. Sizes the renderer's arrays. */
export const MAX_CAST = 24;

/**
 * The whole ambient cast of one site at one tick.
 *
 * A **pure function of `(site, tick)`**, writing into a caller-owned array of
 * reused records. Returns how many were written.
 *
 * Every position in here is built from `RING_COS`/`RING_SIN` and integer hashes,
 * so the server and the browser agree to the last bit -- which matters even
 * though nothing here is authoritative, because the promoted cast is seeded from
 * these positions and a promotion is on the wire.
 */
export function castOf(site: EventSite, tick: number, progress: number, out: CastMember[]): number {
  while (out.length < MAX_CAST) out.push(createMember());
  const now = trafficSeconds(tick);
  let n = 0;
  const put = (role: number, x: number, z: number, dx: number, dz: number, look: number, phase: number): void => {
    if (n >= MAX_CAST) return;
    const m = out[n];
    m.key = site.id * 64 + n;
    m.role = role;
    m.x = x;
    m.y = 0;
    m.z = z;
    m.dx = dx;
    m.dz = dz;
    m.look = look;
    m.phase = phase;
    n++;
  };
  /** A point on the site's ring, `r` metres out at ring index `a`. */
  const ring = (a: number, r: number): [number, number] => [
    site.x + RING_COS[a & 15] * r,
    site.z + RING_SIN[a & 15] * r,
  ];

  switch (site.kind) {
    case EVENT_KIND.FENDER: {
      // --- Two cars nose to tail at a slight angle, which is what a rear-ender
      // looks like: the one behind is not straight any more.
      //
      // The heading is a ring index rather than an angle, so the pair is aligned
      // with each other and with nothing else in the world. That is a real
      // limitation -- they are not aligned with the road -- and it is accepted
      // rather than fixed, because aligning them would mean this file querying
      // the lane geometry, which is a per-tile decode behind the streamer. At
      // the distance an event is legible the pair reads as two cars that have
      // stopped, and the exact angle to the kerb is not something a player
      // checks. `world/events.ts` does nudge them onto the ground plane.
      const a = hashInt(site.seed, 0x3311) % RING;
      const hx = RING_COS[a];
      const hz = RING_SIN[a];
      // The Ranger in front, the Camry into the back of it. Two look bytes,
      // fixed rather than hashed, because the joke is that it is always these
      // two cars.
      put(CAST_ROLE.CAR, site.x + hx * 2.6, site.z + hz * 2.6, hx, hz, 0, 0);
      put(CAST_ROLE.CAR, site.x - hx * 2.9, site.z - hz * 2.9, hx * 0.97 + hz * 0.24, hz * 0.97 - hx * 0.24, 1, 0);
      // The two drivers, out on the kerb side, facing each other. They gesture
      // on a triangle so the pair is never still and never in step.
      const sx = hz;
      const sz = -hx;
      put(CAST_ROLE.BODY, site.x + sx * 2.3 + hx * 0.6, site.z + sz * 2.3 + hz * 0.6, -sx, -sz, site.seed & 7, (now / 3.1) % 1);
      put(CAST_ROLE.BODY, site.x + sx * 2.3 - hx * 0.9, site.z + sz * 2.3 - hz * 0.9, sx, sz, (site.seed >>> 3) & 7, (now / 2.7 + 0.5) % 1);
      // And the crowd, arriving. One more onlooker every quarter of the run, up
      // to four -- which is the shape of a small crowd forming, and it is the
      // one thing that makes a static scene feel like it is happening.
      const onlookers = Math.min(4, Math.floor(progress * 5));
      for (let i = 0; i < onlookers; i++) {
        const ra = (hashInt(site.seed, 0x900d + i) % RING);
        const [ox, oz] = ring(ra, 5.5 + (hashInt(site.seed, i ^ 0x51) % 30) / 10);
        const ddx = site.x - ox;
        const ddz = site.z - oz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
        put(CAST_ROLE.BODY, ox, oz, ddx / d, ddz / d, hashInt(site.seed, i ^ 0x77) & 7, (now / 4 + i * 0.17) % 1);
      }
      break;
    }

    case EVENT_KIND.STANDOFF: {
      // Circling, which is the whole picture: two officers walking a slow
      // circuit around one bloke who is not going anywhere. The circuit is a
      // ring index that advances with time rather than an angle, so it steps
      // rather than sweeps -- at 0.9 seconds a step and eight metres out that is
      // a walk, and it is exact in both engines.
      const step = Math.floor(now / 0.9);
      put(CAST_ROLE.JUNKIE, site.x, site.z, RING_COS[step & 15], RING_SIN[step & 15], site.seed & 7, (now / 1.6) % 1);
      for (let i = 0; i < 2; i++) {
        const a = (step + i * 8) & 15;
        const [ox, oz] = ring(a, 4.2);
        const ddx = site.x - ox;
        const ddz = site.z - oz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
        put(CAST_ROLE.COP, ox, oz, ddx / d, ddz / d, i, (now / 2 + i * 0.5) % 1);
      }
      const [wx, wz] = ring(hashInt(site.seed, 0x1a) % RING, 11);
      put(CAST_ROLE.BODY, wx, wz, (site.x - wx) / 11, (site.z - wz) / 11, site.seed & 7, (now / 5) % 1);
      break;
    }

    case EVENT_KIND.IBIS_RIOT: {
      // Two bins, one of them over. The knocked one is the whole reason the
      // rubbish is out; the brief asked for a bin you could kick over and the
      // honest answer is that furniture in this build is baked scenery with no
      // hit test, so **one of them starts over** and the state is decided at
      // schedule time rather than by a player. Said plainly rather than
      // pretending a kick works.
      const a = hashInt(site.seed, 0x2211) % RING;
      put(CAST_ROLE.BIN, site.x + RING_COS[a] * 0.9, site.z + RING_SIN[a] * 0.9, RING_COS[a], RING_SIN[a], 0, 0);
      put(CAST_ROLE.BIN, site.x - RING_COS[a] * 0.9, site.z - RING_SIN[a] * 0.9, RING_COS[a], RING_SIN[a], 1, 0);
      // Eight to twelve ibises, on and around them. The count is hashed per
      // site so one bin night is not every bin night.
      const birds = 8 + (hashInt(site.seed, 0x77aa) % 5);
      for (let i = 0; i < birds; i++) {
        const ra = (i * 5 + (hashInt(site.seed, i) % 3)) & 15;
        const r = 0.6 + ((hashInt(site.seed, i ^ 0x31) % 26) / 10);
        const [ox, oz] = ring(ra, r);
        // Facing the middle, which is where the food is, with a hashed wobble so
        // twelve birds are not a compass rose.
        const fa = (ra + 8 + (hashInt(site.seed, i ^ 0x9) % 3) - 1) & 15;
        put(CAST_ROLE.IBIS, ox, oz, RING_COS[fa], RING_SIN[fa], hashInt(site.seed, i ^ 0xa1) & 7, (now / 1.3 + i * 0.11) % 1);
      }
      break;
    }

    case EVENT_KIND.BURNOUT: {
      // The car, going round. `phase` is where on the circle it is and the
      // renderer turns that into a position and a heading -- kept as a phase
      // rather than resolved here because the renderer runs between ticks and a
      // car resolved at 60 Hz and drawn at 144 stutters visibly at this radius.
      put(CAST_ROLE.HOON, site.x, site.z, 1, 0, site.seed & 3, (now / DONUT_SECONDS) % 1);
      // And the crowd, filming, arriving over the first third. They stand well
      // back, which is both what people do and what stops the renderer having to
      // solve a car driving through a person.
      const watchers = Math.min(9, 3 + Math.floor(progress * 18));
      for (let i = 0; i < watchers; i++) {
        const ra = (i * 3 + (hashInt(site.seed, i) % 2)) & 15;
        const [ox, oz] = ring(ra, DONUT_RADIUS + 5.5 + (hashInt(site.seed, i ^ 0x5) % 25) / 10);
        const ddx = site.x - ox;
        const ddz = site.z - oz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
        put(CAST_ROLE.BODY, ox, oz, ddx / d, ddz / d, hashInt(site.seed, i ^ 0xb3) & 7, (now / 3 + i * 0.13) % 1);
      }
      break;
    }

    case EVENT_KIND.TRACKWORK: {
      // The A-frame, facing out of the forecourt.
      const a = hashInt(site.seed, 0x4c) % RING;
      put(CAST_ROLE.SIGN, site.x, site.z, RING_COS[a], RING_SIN[a], 0, 0);
      // And the queue, which is the event. Fifteen to twenty-five of them in a
      // line that does not move -- a *line*, laid along the heading, because a
      // crowd is a crowd and a queue is a specific and immediately readable
      // thing. They shuffle on a triangle at four centimetres, which is the
      // amount of movement a queue that is not moving actually has.
      const queue = 15 + (hashInt(site.seed, 0x1234) % 11);
      const px = RING_SIN[a];
      const pz = -RING_COS[a];
      for (let i = 0; i < queue && n < MAX_CAST; i++) {
        const along = 1.6 + i * 0.85;
        const jitter = ((hashInt(site.seed, i ^ 0x2d) % 11) - 5) / 20;
        const x = site.x + RING_COS[a] * along + px * jitter;
        const z = site.z + RING_SIN[a] * along + pz * jitter;
        // The last one in the queue is the drunk, which is the correct place for
        // him and needs no extra role: `look` bit 7 is the renderer's flag for
        // "give this one the vest and the longneck".
        const drunk = i === queue - 1 ? 0x80 : 0;
        put(
          CAST_ROLE.BODY,
          x,
          z,
          -RING_COS[a],
          -RING_SIN[a],
          drunk | (hashInt(site.seed, i ^ 0xc4) & 7),
          (now / 6 + i * 0.07) % 1,
        );
      }
      break;
    }
  }
  return n;
}

/** The burnout's circle: radius in metres, and how long one lap takes. */
export const DONUT_RADIUS = 7.5;
export const DONUT_SECONDS = 4.2;

/**
 * How far an event's cast reaches from the site, metres.
 *
 * **Derived from the placements above, not measured**, on
 * `streetlife.METH_REACH`'s rule: a broadphase gate tighter than the thing that
 * placed somebody deletes them from the only enumeration there is. The furthest
 * anybody stands is the trackwork queue's twenty-fifth member, at `1.6 + 24 *
 * 0.85` = 22.0 m, and `verifyEvents` asserts that over every kind rather than
 * trusting this sentence.
 */
export const CAST_REACH = 26;

// --- The promoted cast ------------------------------------------------------------------------

/**
 * How close a player has to be for an event to promote anybody, metres.
 *
 * `factions.PROMOTE_RADIUS`' own number, and taken from there deliberately:
 * that is the distance at which this project has already decided a thing becomes
 * real, and a second answer would mean two kinds of "nearby".
 */
export const EVENT_PROMOTE_RADIUS = 120;

/**
 * How many promoted actors all live events may hold between them.
 *
 * Three, which is one standoff. It is the smallest budget that still lets the
 * one event with real behaviour have it, and it is small for the reason
 * `characters.MAX_CHARACTER_ACTORS` is: the shared cap is a wire budget and the
 * police guarantee comes first. Four events in view do not get four standoffs --
 * they get one, and the others stay entirely ambient, which at 120 m is
 * invisible.
 */
export const EVENT_ACTOR_BUDGET = 3;

/** How long after a burnout starts the police turn up, in seconds. The brief's 90. */
export const BURNOUT_POLICE_SECONDS = 90;

/**
 * One tick of the live events, on the authority.
 *
 * Called immediately after `FactionField.step`, beside `stepStreetlife`,
 * `stepWildlife` and `stepCharacters`, and the ordering rule is theirs: `step`
 * clears `FactionField.events` at the top of every call.
 *
 * What it actually does is small, and deliberately so. Almost every body in an
 * event is ambient and needs nothing from this function; what is left is:
 *
 *   1. **The standoff's three**, promoted when a player is inside
 *      `EVENT_PROMOTE_RADIUS`. Once promoted they are ordinary actors -- the
 *      meth head's own `think` from `game/streetlife.ts` decides whether he
 *      bolts, and the officers' `think` from `game/factions.ts` decides what to
 *      do about it. This function does not script them, which is the whole
 *      reason the standoff is the event with promoted actors: the script already
 *      exists and is better than one written here.
 *   2. **The burnout's officers**, after ninety seconds, walking toward the car.
 *      They are promoted with no target, which puts `POLICE.think` on its
 *      "nothing to investigate" branch -- they walk in, find nothing they are
 *      hostile to, and walk home. The heat workstream owns what happens if the
 *      player is in the car park doing something.
 *
 * Everything else -- the crowd, the queue, the birds, the cars -- is a pure
 * function and this function never touches it.
 *
 * Allocates nothing after the first call. The scratch is module-level, on
 * `FactionField.step`'s argument.
 */
const stepSites: EventSite[] = [];
const stepCast: CastMember[] = [];

export function stepEvents(ctx: FactionCtx): void {
  const field = ctx.field;
  let live = 0;
  for (const a of field.actors) if (a.eventId !== undefined) live++;
  if (live >= EVENT_ACTOR_BUDGET) return;

  const day = dayAtTick(ctx.tick);
  for (const c of ctx.combatants) {
    if (live >= EVENT_ACTOR_BUDGET) return;
    const px = c.body.position.x;
    const pz = c.body.position.z;
    liveEventsAt(
      ctx.tick,
      px - EVENT_PROMOTE_RADIUS,
      pz - EVENT_PROMOTE_RADIUS,
      px + EVENT_PROMOTE_RADIUS,
      pz + EVENT_PROMOTE_RADIUS,
      stepSites,
      ctx.peds,
    );
    for (const site of stepSites) {
      if (live >= EVENT_ACTOR_BUDGET) return;
      const dx = site.x - px;
      const dz = site.z - pz;
      if (dx * dx + dz * dz > EVENT_PROMOTE_RADIUS * EVENT_PROMOTE_RADIUS) continue;
      // Already attended? One integer compare per promoted actor; there are at
      // most `MAX_ACTORS` of them and usually none of ours.
      let attended = false;
      for (const a of field.actors) {
        if (a.eventId === site.id) {
          attended = true;
          break;
        }
      }
      if (attended) continue;

      const progress = eventProgress(site, day.phase);
      if (progress < 0) continue;

      if (site.kind === EVENT_KIND.STANDOFF) {
        const written = castOf(site, ctx.tick, progress, stepCast);
        for (let i = 0; i < written && live < EVENT_ACTOR_BUDGET; i++) {
          const m = stepCast[i];
          const kind =
            m.role === CAST_ROLE.COP ? NPC_KIND.POLICE : m.role === CAST_ROLE.JUNKIE ? NPC_KIND.METHHEAD : 0;
          if (kind === 0) continue;
          const y = ctx.groundHeight(m.x, m.z, Infinity);
          const actor = field.promote(kind, m.x, y, m.z, m.dx, m.dz, -1);
          if (actor === null) break;
          actor.eventId = site.id;
          live++;
        }
      } else if (site.kind === EVENT_KIND.BURNOUT) {
        // Ninety seconds in, as a fraction of the run rather than as a clock:
        // the site has no state and no clock of its own, and `progress` is the
        // only thing either end agrees about.
        const span = DURATION_MINUTES[EVENT_KIND.BURNOUT] * 60;
        if (progress * span < BURNOUT_POLICE_SECONDS) continue;
        // Approaching from the ring, so they arrive from a direction rather than
        // appearing beside the car.
        const a = hashInt(site.seed, 0x50) % RING;
        const ox = site.x + RING_COS[a] * (DONUT_RADIUS + 22);
        const oz = site.z + RING_SIN[a] * (DONUT_RADIUS + 22);
        const ddx = site.x - ox;
        const ddz = site.z - oz;
        const d = Math.sqrt(ddx * ddx + ddz * ddz) || 1;
        const y = ctx.groundHeight(ox, oz, Infinity);
        const actor = field.promote(NPC_KIND.POLICE, ox, y, oz, ddx / d, ddz / d, -1);
        if (actor !== null) {
          actor.eventId = site.id;
          // Walking toward the car rather than standing where they were put.
          // `homeX`/`homeZ` is what `RETURN` walks to and what `POLICE.think`
          // heads for when it has nothing to investigate, so setting it to the
          // car is the whole of "the police arrive" with no script at all.
          actor.homeX = site.x;
          actor.homeZ = site.z;
          actor.state = NPC_STATE.WALK;
          live++;
        }
      }
    }
  }
}

/**
 * Drop any promoted actor whose event has finished.
 *
 * Separate from `stepEvents` because it has to run even when the budget is full
 * -- which is the state it exists to get out of. An actor left behind by a
 * finished event is a constable standing in an empty car park for the rest of
 * the session, holding a slot the police need.
 *
 * `health = -2` is the despawn flag `FactionField.step` sweeps on, which is
 * `streetlife.goHome`'s own mechanism: there is nothing to hand back, because
 * the thing they came from was a pure function.
 */
const sweepSites: EventSite[] = [];

export function sweepEvents(ctx: FactionCtx): void {
  const field = ctx.field;
  let any = false;
  for (const a of field.actors) {
    if (a.eventId !== undefined) {
      any = true;
      break;
    }
  }
  if (!any) return;
  const day = dayAtTick(ctx.tick);
  for (const a of field.actors) {
    if (a.eventId === undefined) continue;
    // Still running? The site is re-derived rather than remembered, which is the
    // point of a pure schedule: there is no record to go stale.
    liveEventsAt(ctx.tick, a.x - 200, a.z - 200, a.x + 200, a.z + 200, sweepSites, ctx.peds);
    let alive = false;
    for (const s of sweepSites) {
      if (s.id !== a.eventId) continue;
      if (eventProgress(s, day.phase) >= 0) alive = true;
      break;
    }
    // An actor mid-fight is left alone whatever the clock says. A meth head who
    // was promoted by a standoff and is now chasing somebody is no longer part
    // of the standoff, and despawning him out from under a player would be the
    // one visible failure this whole function could have.
    if (!alive && a.target < 0 && a.state !== NPC_STATE.DOWN) a.health = -2;
  }
}

// --- The self-check -------------------------------------------------------------------------

/**
 * Everything about this scheduler that fails by rendering a plausible city.
 *
 * `verifyStreetlife`'s criterion, and there are six:
 *
 *   - **A schedule that is not a pure function of the day** puts different
 *     events on two clients' screens, and the symptom is a player describing a
 *     car crash nobody else can find.
 *   - **A window that wraps and is read naively** schedules nothing at all --
 *     the burnout simply never happens, and nobody notices because it is
 *     Saturday-only anyway.
 *   - **A cast that reaches past `CAST_REACH`** is deleted by every broadphase
 *     downstream of it, which is a queue with its tail missing.
 *   - **A site density that is wrong by an order of magnitude** is either a city
 *     with nothing in it or a city with a car crash on every corner, and both
 *     read as taste until somebody counts.
 *   - **A trackwork site off a station** is the single most obviously broken
 *     thing here: a bus stop sign in a paddock.
 *   - **A promoted budget that eats the shared cap** is the police failing to
 *     arrive, which is the guarantee this project makes.
 */
export function verifyEvents(): string[] {
  const failures: string[] = [];

  if (EVENT_NAME.length !== EVENT_COUNT) {
    failures.push(`There are ${EVENT_COUNT} event kinds and ${EVENT_NAME.length} names; the big map would label one wrongly.`);
  }
  if (DURATION_MINUTES.length !== EVENT_COUNT || START_WINDOW.length !== EVENT_COUNT || CAST_SIZE.length !== EVENT_COUNT) {
    failures.push('The per-kind tables are not all the same length; one kind is reading another kind\'s row.');
  }
  for (let k = 0; k < EVENT_COUNT; k++) {
    const minutes = DURATION_MINUTES[k];
    if (!(minutes >= 3 && minutes <= 8)) {
      failures.push(`Event ${EVENT_NAME[k]} runs ${minutes} real minutes; the brief's range is three to eight.`);
    }
    const span = spanFor(k);
    if (!(span > 0 && span < 0.25)) {
      failures.push(`Event ${EVENT_NAME[k]} spans ${span} of a cycle, which is either instant or most of a day.`);
    }
  }

  // --- Purity, from the other end. The same day and cell has to give the same
  // site twice, and a different day has to give a different schedule.
  {
    const a: EventSite[] = [];
    const b: EventSite[] = [];
    eventsAt(1234, -6000, -6000, 6000, 6000, a);
    eventsAt(1234, -6000, -6000, 6000, 6000, b);
    if (a.length !== b.length) {
      failures.push(`eventsAt is not a pure function of the day: two calls returned ${a.length} and ${b.length} sites.`);
    } else {
      for (let i = 0; i < a.length; i++) {
        if (a[i].id !== b[i].id || a[i].x !== b[i].x || a[i].startPhase !== b[i].startPhase) {
          failures.push('eventsAt returned two different schedules for the same day; nothing about this feature is shared.');
          break;
        }
      }
    }
    const c: EventSite[] = [];
    eventsAt(1235, -6000, -6000, 6000, 6000, c);
    const sameIds = a.length === c.length && a.every((s, i) => s.id === c[i].id);
    if (a.length > 0 && sameIds) {
      failures.push('Two consecutive days schedule identical events; the day index is not reaching the hash.');
    }
  }

  // --- Density, over a real slab of the city and a week of days.
  {
    let total = 0;
    const found: EventSite[] = [];
    const perKind = new Array<number>(EVENT_COUNT).fill(0);
    // **Four weeks, not one**, and the difference is not padding. Two of the
    // five kinds are gated on a calendar that holds one Saturday in seven, so a
    // one-week sample contains a single opportunity for a burnout -- and a
    // single opportunity that the density roll declines is indistinguishable
    // from a gate that never opens. Measured over 9000..9006: thirteen events on
    // the Wednesday and six on the Saturday, none of them a burnout, purely by
    // hash. Four weeks gives four Saturdays and turns a coin flip into a check.
    const DAYS = 28;
    for (let d = 0; d < DAYS; d++) {
      eventsAt(9000 + d, -20000, -20000, 20000, 20000, found);
      total += found.length;
      for (const s of found) perKind[s.kind]++;
    }
    const perDay = total / DAYS;
    // A 40 km square holds 400 event cells. At one in twelve times a density
    // that averages perhaps 0.35 over that square, the expectation is around
    // twelve a day. The bounds are wide because the point is to catch an order
    // of magnitude, not to pin a number that a retune is allowed to move.
    if (perDay < 2 || perDay > 60) {
      failures.push(
        `The inner 40 km square holds ${perDay.toFixed(1)} events a day. Under two is a city where nothing ` +
          'happens; over sixty is one where everything does.',
      );
    }
    for (let k = 0; k < EVENT_COUNT; k++) {
      if (perKind[k] === 0) {
        failures.push(
          `No "${EVENT_NAME[k]}" was scheduled anywhere in four weeks over 1,600 km2. That kind does not exist.`,
        );
      }
    }
  }

  // --- Trackwork lands on a station. Every one of them, over a fortnight.
  {
    const found: EventSite[] = [];
    let checked = 0;
    for (let d = 0; d < 14; d++) {
      eventsAt(9100 + d, -30000, -30000, 30000, 30000, found);
      for (const s of found) {
        if (s.kind !== EVENT_KIND.TRACKWORK) continue;
        checked++;
        let best = Infinity;
        for (let i = 0; i < STATION_COUNT; i++) {
          const dx = STATIONS[i].x - s.x;
          const dz = STATIONS[i].z - s.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
        // The forecourt offset is 26 m; anything past 30 is not a station.
        if (Math.sqrt(best) > 30) {
          failures.push(
            `A trackwork site sits ${Math.sqrt(best).toFixed(0)} m from the nearest station. That is a ` +
              '"buses replace trains" sign in the middle of nowhere.',
          );
          break;
        }
      }
    }
    if (checked === 0) failures.push('No trackwork sites were scheduled in a fortnight, so the check proved nothing.');
  }

  // --- The cast, over every kind, at both ends of its run.
  {
    const cast: CastMember[] = [];
    const site = createSite();
    for (let k = 0; k < EVENT_COUNT; k++) {
      site.id = 4242 * 8 + k;
      site.kind = k;
      site.x = 1000;
      site.z = -500;
      site.day = 9;
      site.seed = 0x51ed9 + k;
      site.startPhase = 0.4;
      site.spanPhase = spanFor(k);
      for (const progress of [0, 0.5, 1]) {
        const n = castOf(site, 123456, progress, cast);
        if (n === 0) {
          failures.push(`Event "${EVENT_NAME[k]}" has an empty cast at progress ${progress}; there is nothing to see.`);
          continue;
        }
        if (n > MAX_CAST) {
          failures.push(`Event "${EVENT_NAME[k]}" wrote ${n} cast members over a cap of ${MAX_CAST}.`);
        }
        const keys = new Set<number>();
        for (let i = 0; i < n; i++) {
          const m = cast[i];
          const dx = m.x - site.x;
          const dz = m.z - site.z;
          const d = Math.sqrt(dx * dx + dz * dz);
          if (d > CAST_REACH) {
            failures.push(
              `A cast member of "${EVENT_NAME[k]}" stands ${d.toFixed(1)} m from the site against a declared ` +
                `reach of ${CAST_REACH} m. Every broadphase downstream of this deletes them.`,
            );
            break;
          }
          if (!Number.isFinite(m.dx) || !Number.isFinite(m.dz)) {
            failures.push(`A cast member of "${EVENT_NAME[k]}" has a non-finite heading, which draws as an invisible person.`);
            break;
          }
          const len = Math.sqrt(m.dx * m.dx + m.dz * m.dz);
          if (Math.abs(len - 1) > 0.02) {
            failures.push(`A cast member of "${EVENT_NAME[k]}" has a heading of length ${len.toFixed(3)}; headings are unit.`);
            break;
          }
          if (keys.has(m.key)) {
            failures.push(`Two cast members of "${EVENT_NAME[k]}" share a key; the renderer would draw one of them twice.`);
            break;
          }
          keys.add(m.key);
        }
      }
    }
    // The two that grow. A crowd that does not form is a tableau.
    for (const k of [EVENT_KIND.FENDER, EVENT_KIND.BURNOUT]) {
      site.kind = k;
      site.id = 99 * 8 + k;
      const early = castOf(site, 123456, 0, cast);
      const late = castOf(site, 123456, 1, cast);
      if (late <= early) {
        failures.push(`"${EVENT_NAME[k]}" does not gather a crowd: ${early} at the start and ${late} at the end.`);
      }
    }
  }

  // --- The wrap. A window that crosses midnight has to actually schedule.
  {
    const site = createSite();
    site.kind = EVENT_KIND.BURNOUT;
    site.startPhase = 0.97;
    site.spanPhase = spanFor(EVENT_KIND.BURNOUT);
    if (eventProgress(site, 0.98) < 0) failures.push('A wrapped window is not on before midnight.');
    if (eventProgress(site, 0.005) < 0) failures.push('A wrapped window is not on after midnight.');
    if (eventProgress(site, 0.5) >= 0) failures.push('A wrapped window is on in the middle of the afternoon.');
    site.startPhase = 0.4;
    if (eventProgress(site, 0.39) >= 0 || eventProgress(site, 0.41) < 0) {
      failures.push('An unwrapped window does not open where it says it does.');
    }
  }

  // --- The budget, against the police guarantee. See `EVENT_ACTOR_BUDGET`.
  if (EVENT_ACTOR_BUDGET > 4) {
    failures.push(`EVENT_ACTOR_BUDGET is ${EVENT_ACTOR_BUDGET}; events would be competing with the police for the wire.`);
  }

  // --- And the calendar gates, which fail silently by never firing.
  {
    let burnouts = 0;
    let weekday = 0;
    const found: EventSite[] = [];
    for (let d = 0; d < 28; d++) {
      eventsAt(9200 + d, -20000, -20000, 20000, 20000, found);
      for (const s of found) {
        if (s.kind !== EVENT_KIND.BURNOUT) continue;
        burnouts++;
        if (!saturdayAt(s.day)) weekday++;
      }
    }
    if (burnouts === 0) failures.push('No burnout was scheduled in four weeks; the Saturday gate never opens.');
    if (weekday > 0) failures.push(`${weekday} burnouts were scheduled on a weekday; the Saturday gate leaks.`);
  }

  // A daylight event in the dark, from the other end: the fender-bender's window
  // has to be inside the day, or the one kind that needs to be seen happens at
  // three in the morning.
  {
    const [from, to] = START_WINDOW[EVENT_KIND.FENDER];
    if (!daylight(from) || !daylight(to)) {
      failures.push('The fender-bender can start outside daylight, and the damage is the whole point of looking.');
    }
  }

  // And the two grids, from the outside. An event cell has to be several
  // character cells across, or an event and the characters standing in it are
  // being placed at the same resolution -- which would make an event look like
  // a slightly denser patch of ordinary street rather than like a thing
  // happening. Four is the smallest ratio at which the difference reads.
  if (EVENT_CELL < CHAR_CELL * 4) {
    failures.push(
      `The event cell (${EVENT_CELL} m) is under four character cells (${CHAR_CELL} m) across, so an event ` +
        'is placed at the same resolution as the people standing in it.',
    );
  }

  return failures;
}
