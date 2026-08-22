/**
 * Illegal night raves: where they are, when they are, what is playing, and who
 * is standing where.
 *
 * *"at night time put in illegal raves in warehouse areas, under bridges, in
 * crown land or big parks like sydney park right near spawn in the forest....
 * each with lights and where the attendees have lights on them too from
 * dressing up and like glow stuff."*
 *
 * This file is the half with no pictures in it. `world/rave.ts` is the rig, the
 * lasers, the haze and the crowd; `game/audio.ts` is the sound system. What is
 * here is the arithmetic all three of those agree about, and — the whole point —
 * that **every player in the world agrees about, having sent nothing.**
 *
 * **This file imports nothing from three.** `game/traffic.ts` and `game/footy.ts`
 * set that precedent and state it in the same words: the Bun server compiles
 * this module, and a `Vector3` reaching it would drag the whole renderer into a
 * process that draws nothing. `server/integration-check.ts` imports it directly
 * and runs the site draw, the beat clock and the crowd layout against the real
 * tables, which is only possible because of that rule.
 *
 * ---------------------------------------------------------------------------
 * 1. WHY THERE IS NO PROTOCOL FOR THIS, AND WHY THAT IS THE INTERESTING PART.
 *
 * A rave is the most *shared* thing in the game — four people standing in the
 * same crowd have to be hearing the same bar of the same track, watching the
 * same beam sweep the same way, with the same forty people around them — and it
 * costs **zero bytes on the wire**. Everything below is a pure function of two
 * integers: the wall clock, and the site's index in a table that is compiled
 * into both ends.
 *
 * That is the argument `game/traffic.ts` won for a fleet of cars and
 * `game/pedestrians.ts` won for nineteen thousand people, and it is worth more
 * here than in either of them, because a rave is *dense*. Fifty attendees, sixteen
 * light fixtures and a playhead position, times five live sites, replicated at
 * 20 Hz, is a feature that would have cost more bandwidth than the players do.
 * As a function of the clock it costs nothing at all, and a player who joins at
 * 3 am walks into a rave that has been going for twenty minutes without anybody
 * having had to tell them so.
 *
 * The rule that keeps it true is stated once and applies to every function
 * below: **no transcendentals in anything two ends compare.** Bun is
 * JavaScriptCore and the browser is V8, and `Math.sin` is not specified to the
 * last bit in either. `Math.imul`, `Math.floor`, `+`, `*` and `/` are. So the
 * hash is integer, the site draw is integer, the beat index is a floor of a
 * double multiply, and the one `Math.sin` in this file is in `danceBob`, which
 * moves an attendee's head by four centimetres and is *presentation* — the same
 * split `PedestrianCrowd` makes between the strike test and the picture.
 *
 * ---------------------------------------------------------------------------
 * 2. SITING: THE FOUR KINDS OF PLACE, AND THEY ARE ALL REAL.
 *
 * The brief named four and the world has data for all four. Nothing here is
 * invented geography.
 *
 *   - **Yards.** 110 `landuse=industrial` parcels reduced to their largest
 *     inscribed circle — the same primitive `wildlife.PARKS` already uses.
 *     Filtered to parcels with **at least three buildings standing within 160 m
 *     of that centre**, because a parcel with none is a paddock with an
 *     industrial tag on it and the brief is about Alexandria, not about a
 *     paddock. Glebe Island Container Terminal, the White Bay wharves,
 *     Eveleigh, the Marrickville depots, and the whole St Peters/Alexandria
 *     strip four hundred metres from the spawn.
 *
 *     **The sentence that used to be here was wrong, and a player found it.**
 *     It read: "the inscribed circle of a parcel is exactly the biggest clear
 *     space in it, which for an industrial parcel is the truck apron between
 *     the sheds." The first clause is true of the parcel *boundary* and says
 *     nothing whatever about what is standing inside it. A parcel that is one
 *     big warehouse has its largest inscribed circle **in the middle of the
 *     warehouse** — the centroid of a shed area is a shed. Measured against the
 *     shipped collision prisms: **57 of the 448 sites had their centre inside a
 *     building footprint**, seven of them in Alexandria alone. See
 *     `CLEARED_PACKED`, which is the pass that fixes it.
 *   - **Spans.** 74 `bridge=yes|viaduct` carriageways of 70 m or more, at their
 *     midpoint, **only where that midpoint is over land** — a rave under the
 *     Anzac Bridge's main span is a rave in Johnstons Bay. The Western
 *     Distributor, the Cahill, the Sydney Gateway ramps, Qantas Drive. The
 *     deck round gave every one of these a real soffit with a walkable void
 *     under it (`pipeline/sydney/decks.py`), which is what makes this a place
 *     and not a texture.
 *   - **Parks.** `wildlife.PARKS`, filtered to `r >= PARK_MIN_R`. That table is
 *     already the answer to "a big clear space inside a park", already loaded,
 *     and already validated to lie inside its own polygon — so a rave sited on
 *     one cannot be in the harbour or in the 4 m strip between a fence and a
 *     road. 270 of the 1,821 qualify.
 *   - **Sydney Park**, which the user named, is `PARKS[3]` and is **32 metres
 *     from the spawn pin**. It is not left to the general draw; see
 *     `SYDNEY_PARK_SHARE`.
 *
 * The three blocks are concatenated in a fixed order and a site's **index in
 * that array is its identity**, which every hash below is keyed on. Append only,
 * exactly as `mesh.MATERIALS`, `PARKS` and `POLICE_STATIONS` are append only and
 * for the identical reason: the world is cached for a year, and reordering the
 * table moves every rave that ever happened.
 *
 * ---------------------------------------------------------------------------
 * 3. SCALE AND RARITY: A RAVE IS AN EVENT, NOT SCENERY.
 *
 * 454 sites and `MAX_LIVE` of six means a given site is live about one night in
 * eighty. That is the number the whole feature turns on. Put a rave in every
 * warehouse and it is set dressing — the player learns that warehouses have
 * raves and stops looking at them. Put six in a 19.3 km city and finding one is
 * an event, the beams on the horizon mean something, and the yard you walked
 * through last night being empty tonight is what makes the world feel like it is
 * running without you.
 *
 * The draw is three rules and they are deliberately not one:
 *
 *   1. **Sydney Park is a fixture**, live on `SYDNEY_PARK_SHARE` of nights. The
 *      user asked for it by name and it is 32 m from where every player starts;
 *      a player who plays five sessions should walk over the rise and find it
 *      twice. Leaving that to a 1-in-80 draw would have honoured the letter of
 *      the brief and none of it.
 *   2. **One home rave, every night, always.** Drawn from the sites within
 *      `HOME_RADIUS` of the spawn — about a dozen of them, the Alexandria and
 *      St Peters yards, the Sydney Gateway viaducts, Sydney Park itself and the
 *      smaller parks around it. This is what makes "there is one within walking
 *      distance" a **structural guarantee** rather than a probability that fails
 *      on the night somebody is watching.
 *   3. **The rest of the city**, at `CITY_SHARE` each, capped at `MAX_LIVE` by
 *      taking the lowest hashes. The cap is what stops a freak night putting
 *      nineteen raves on at once; the hash-order tie-break is what keeps the cap
 *      deterministic, because "the first six found" would depend on iteration
 *      order and "a random six" would need a second draw.
 *
 * ---------------------------------------------------------------------------
 * 4. THE NIGHT: LOAD-IN, DOORS, PEAK, WIND-DOWN, AND THE MORNING AFTER.
 *
 * *"They should start after dark, build, and be gone by sunrise"* — and the
 * morning-after question in the brief is the one worth the most per line of
 * code, so the answer is yes: the site keeps its litter, its scorched pallet and
 * one speaker stack nobody has come back for, all through the following day.
 * It costs one instanced set that draws a handful of quads and it is the
 * difference between a light show and a place where something happened.
 *
 * `RAVE_STAGES` is the envelope. Five states, and the two at the ends are the
 * ones that are actually worth having:
 *
 *   - **Load-in** (first 6% of the night). The truss is up, one work light is
 *     on, four people are carrying boxes and there is no music. Arrive early
 *     enough and you watch it being built, which is a thing you can only see if
 *     somebody decided the rave has a beginning.
 *   - **Doors**, **Peak**, **Wind-down** — the crowd curve.
 *   - **Pack-up** (last 4%). Music off, house lights, the stack half loaded.
 *
 * `nightProgress` returns -1 by day, so every consumer has one branch and the
 * day case is not a special number that happens to be small.
 *
 * ---------------------------------------------------------------------------
 * 5. THE POLICE, WHICH IS THE "ILLEGAL" PART.
 *
 * A site within `WATCHED_RADIUS` of a police station is **known**, and a known
 * rave gets shut down at a time hashed off the night — somewhere in the middle
 * two thirds. The music stops, the house lights come up white, the crowd walks
 * out radially over `SCATTER_SPAN` of the night, and by the time you get there
 * it is a yard full of bottles and a sergeant. A rave that gets shut down at
 * 3 am is the joke completing itself, and it is free: `factions.POLICE_STATIONS`
 * is already a table both ends compile, and the officers who are genuinely
 * nearby are already there, because the beat system put them on that beat before
 * this feature existed.
 *
 * **The player cannot cause it, and that is deliberate rather than lazy.** A
 * bust triggered by a fight would be a rave that ended on one screen and not on
 * another — the one thing an ambient system that sends nothing is not allowed to
 * do. What the player gets instead is entirely local and cannot desync: the
 * banner, the barks, and the officers who were always going to be standing
 * there. See `bustAt`.
 *
 * A rave that is *not* watched runs to sunrise. About a third of them are
 * watched, which is the right proportion for the joke to land without becoming
 * the only thing that ever happens.
 *
 * ---------------------------------------------------------------------------
 * 6. THE CLOCK IS `sky/cycle.ts`'s, NOT A SECOND ONE.
 *
 * One real hour is one Sydney day: thirty minutes of light and thirty of dark,
 * a pure function of the wall clock, and `sky/cycle.ts` is the project's single
 * answer to "what time is it and how dark is it". This file **imports** its
 * epoch and its cycle length rather than restating them, because a rave that
 * disagreed with the sky about when night was would be a light show at three in
 * the afternoon — and importing is safe, since that module reaches only
 * `solar.ts` and `calibration.ts` and neither touches three.
 *
 * The one adaptation is `RAVE_DUSK_OFFSET_MS`: the sky closes its loop at solar
 * midnight, which cuts a night in half, so the rave clock is the sky's rotated a
 * quarter turn to put phase zero at sunset. That constant's own comment is the
 * long version.
 *
 * `verifyRaves` then does the thing that actually has teeth: it takes
 * `skyClock`'s darkness at the middle of a modelled night and at the middle of
 * the following day and asserts they are 1 and 0. That catches a rotation in the
 * wrong direction, a sign error, and any future change to either module's phase
 * convention — none of which a shared constant would have caught, because both
 * ends would have moved together and both ends would have been wrong.
 *
 * The renderer takes a second belt to that brace and multiplies every emissive
 * thing here by the same `nightLevel` the street lamps use, so even a
 * disagreement nobody caught is a rave that is present and unlit rather than
 * lasers over Alexandria at lunchtime.
 */

import { PARKS } from './wildlife.ts';
import { POLICE_STATIONS } from './factions.ts';
import { SPAWN_TARGET } from './spawn.ts';
import { CYCLE_EPOCH_MS, CYCLE_MS, SUNRISE_PHASE, SUNSET_PHASE, skyClock } from '../sky/cycle.ts';

// --- The clock -----------------------------------------------------------------

/**
 * The epoch and the cycle length, **taken from `sky/cycle.ts` rather than
 * restated**, because that module is the project's one answer to "what time is
 * it and how dark is it" and a rave that disagreed with the sky about when night
 * was would be a light show at three in the afternoon.
 *
 * It is safe to import: `sky/cycle.ts` reaches only `solar.ts` and
 * `calibration.ts`, neither of which touches three, so this file stays
 * compilable by the Bun server and `server/integration-check.ts` can run the
 * whole of it. That is the same test `game/traffic.ts` and `game/footy.ts` are
 * held to and it is checked by the suite importing this module at all.
 *
 * Re-exported so a consumer that already has `game/rave.ts` open does not need a
 * second import to ask what a cycle is.
 */
export const RAVE_EPOCH_MS = CYCLE_EPOCH_MS;
export const RAVE_CYCLE_MS = CYCLE_MS;

/**
 * How much of the cycle is dark, as a fraction. Half, and **derived** from the
 * sky's own two horizon phases so it cannot drift from them.
 */
export const RAVE_NIGHT_SHARE = 1 - (SUNSET_PHASE - SUNRISE_PHASE);

/**
 * How far the rave clock is rotated ahead of the sky's, in milliseconds.
 *
 * ---------------------------------------------------------------------------
 * **THE ONE PIECE OF ARITHMETIC IN THIS FILE THAT IS PURELY ABOUT AGREEING WITH
 * ANOTHER MODULE, AND IT IS WORTH THE PARAGRAPH.**
 *
 * `sky/cycle.ts` closes its loop at **solar midnight** — phase 0 is the dead of
 * night, 0.25 is sunrise, 0.75 is sunset — and it closes it there for a good
 * reason, which that file argues at length: the date seam has to land somewhere,
 * and landing it in a black sky is the only place nobody can see it.
 *
 * That convention cuts a *night* in half. The night that starts at sky phase
 * 0.75 finishes at sky phase 0.25 of the **next** cycle, so a rave that ran from
 * dusk to dawn would carry two different cycle indices, and every hash in this
 * file would have needed a "which half of the night am I in" bit — in a file
 * whose entire value is that a rave is one integer.
 *
 * So the rave clock is the sky's clock rotated forward by a quarter of a cycle,
 * which puts **rave phase 0 exactly at sunset**. One night is then one integer,
 * the party runs from phase 0 to `RAVE_NIGHT_SHARE`, and the litter on the
 * ground the next morning belongs to the same index rather than to the one
 * before. Nothing else in this file has to think about it again.
 */
export const RAVE_DUSK_OFFSET_MS = (1 - SUNSET_PHASE) * CYCLE_MS;

/** What night it is, and how far through it. */
export interface RaveNight {
  /** Nights since the epoch, counted from dusk. The seed everything is hashed on. */
  readonly index: number;
  /** 0 at dusk, `RAVE_NIGHT_SHARE` at dawn, 1 at the next dusk. */
  readonly phase: number;
}

/**
 * The shared clock. Wall time in, night and phase out.
 *
 * `Math.floor` of a double divide and one subtraction: both exactly specified,
 * so two processes handed the same millisecond produce the same integer and the
 * same phase to the last bit. Negative time — a machine whose clock is set
 * before 2026 — floors toward minus infinity, which keeps `phase` in [0, 1) on
 * that side too rather than producing a negative phase nothing downstream
 * expects.
 *
 * `nowMs` is the **scrubbed** instant where the caller has one, exactly as
 * `skyClock(nowMs, scrubMs)` takes it: a developer who scrubs the clock to 2 am
 * to look at the lighting has to find the raves there, and `sky/cycle.ts` makes
 * the same argument for the same reason — nothing in the simulation reads any of
 * this, so a scrubbing player simply gets their own night over everybody else's
 * city.
 */
export function raveNight(nowMs: number): RaveNight {
  const elapsed = nowMs - RAVE_EPOCH_MS + RAVE_DUSK_OFFSET_MS;
  const index = Math.floor(elapsed / RAVE_CYCLE_MS);
  return { index, phase: (elapsed - index * RAVE_CYCLE_MS) / RAVE_CYCLE_MS };
}

/**
 * When night `index` starts, in wall-clock milliseconds. `raveNight`'s inverse.
 *
 * Exported because two very different callers need it and both would otherwise
 * open-code the rotation: the self-checks, which have to walk a night from its
 * beginning, and the big map, which labels a marker with how long ago the rave
 * it is remembering was on.
 */
export function nightStartMs(index: number): number {
  return RAVE_EPOCH_MS - RAVE_DUSK_OFFSET_MS + index * RAVE_CYCLE_MS;
}

/**
 * How far through the *night* a phase is, or -1 if it is daylight.
 *
 * One branch for every consumer, and the day case is a value nothing can
 * mistake for "very early in the night" — which a plain 0 could, and which would
 * put the load-in crew on the site at 2 pm.
 */
export function nightProgress(phase: number): number {
  return phase < RAVE_NIGHT_SHARE ? phase / RAVE_NIGHT_SHARE : -1;
}

/**
 * How far through the *day after* a phase is, or -1 if it is still night.
 *
 * The aftermath's own clock. 0 at dawn, 1 at the next dusk.
 */
export function dayProgress(phase: number): number {
  return phase >= RAVE_NIGHT_SHARE ? (phase - RAVE_NIGHT_SHARE) / (1 - RAVE_NIGHT_SHARE) : -1;
}

// --- The hash ------------------------------------------------------------------

/**
 * `power.ts`'s hash, unchanged, so every deterministic population in this
 * project agrees about what a hash is.
 *
 * Integer throughout — `Math.imul` and the shifts are exactly specified in every
 * engine — with exactly one divide at the end to land in [0, 1). That is what
 * lets the Bun server and the browser draw the same six sites out of 454 without
 * anyone sending anything.
 */
function hash(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return ((h ^ (h >>> 13)) >>> 0) / 0xffffffff;
}

/** The same hash as an integer, for the tie-break in `liveRaves`. */
function hashInt(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h ^= Math.imul(p | 0, 0x27d4eb2d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b) >>> 0;
  }
  return (h ^ (h >>> 13)) >>> 0;
}

// --- What a site is ------------------------------------------------------------

/**
 * The three kinds, and the index is written into `RaveSite.kind`.
 *
 * **Append only.** The kind decides the rig's shape, the crowd's size and the
 * reverb, and it is hashed on in `paletteOf`, so renumbering would redecorate
 * every rave that has ever happened.
 */
export const SITE_KIND = { YARD: 0, SPAN: 1, PARK: 2 } as const;
export type SiteKind = (typeof SITE_KIND)[keyof typeof SITE_KIND];

export interface RaveSite {
  /** Index in `RAVE_SITES`. The identity every hash is keyed on. */
  readonly id: number;
  readonly kind: SiteKind;
  /** OSM's, or a generated label. Shown on the decks and on the big map. */
  readonly name: string;
  /** World metres, renderer axes: +X east, +Z south. */
  readonly x: number;
  readonly z: number;
  /** Metres of clear space about the centre. Everything inside this is on site. */
  readonly r: number;
  /**
   * Which way the rig faces, radians, or `NaN` for "hash one per night".
   *
   * Only a span has a real answer: a rave under a viaduct is laid out **along**
   * the deck, because that is the only direction with any room in it. A yard and
   * a park get a fresh bearing every night, which is also true of the real thing
   * — the sound system points wherever the truck could get to.
   */
  readonly bearing: number;
  /** Whether a police station is inside `WATCHED_RADIUS`. See `bustAt`. */
  readonly watched: boolean;
}

/**
 * The industrial parcels, packed.
 *
 * `name|x|z|r|sheds`, semicolon separated, in the order the bake emitted them
 * (nearest the origin first). Packed as one string for `wildlife.PARKS_MIDDLE_PACKED`'s
 * reason: 110 object literals is 660 lines of source and about 9 kB after
 * minification, where this is 110 rows in 4.6 kB and parses in under a
 * millisecond at module load.
 *
 * Baked read-only from `data/cache/sydney.osm.pbf` through the pipeline's own
 * readers — `data/scratch/bake_rave_anchors.py`, which writes nothing into
 * `pipeline/` and rebuilds no world. The `sheds` column is the count of OSM
 * buildings within 160 m of the clear centre and is the filter that separates
 * Alexandria from a paddock; it is kept because the rig's size reads off it.
 */
const YARDS_PACKED =
  'Overseas Passenger Terminal|42.0|-1130.9|24.7|44;railway yard|-1039.7|585.8|25.4|10;industrial ' +
  'yard|432.4|1550.7|32.3|71;railway yard|-255.8|1694.8|112.4|38;Hymix Cement|-1707.5|306.8|32.1|16;Sydney Ship' +
  ' Repair & Engineering|-1306.6|-1759.5|45.5|22;White Bay Cruise Terminal|-2138.7|-838.0|64.6|5;Glebe Island ' +
  'Container Terminal|-2290.8|-262.2|155.1|5;Sydney City Marine|-2398.5|-17.5|54.4|6;Balmain ' +
  'Shipyard|-2054.0|-1401.6|27.6|19;White Bay Container Terminal|-2430.8|-670.1|68.4|5;railway ' +
  'yard|-787.6|2435.7|43.3|54;industrial yard|-2564.5|-167.6|78.6|14;railway ' +
  'yard|-1093.8|2694.9|33.6|72;industrial yard|-2946.6|-358.3|53.5|9;railway yard|-73.6|-3005.9|23.8|95;Noakes ' +
  'Shipyard|-889.5|-2909.5|25.9|71;Polaris Marine|-3181.4|241.0|28.8|3;industrial ' +
  'yard|103.3|3301.7|43.5|17;Eveleigh Precinct|-1584.8|3039.4|65.8|18;industrial ' +
  'yard|30.0|3577.6|29.2|15;industrial yard|-3095.8|1848.1|37.2|45;TfNSW Track Work ' +
  'Depot|-2050.5|3225.3|24.8|25;Rozelle Motorway Operations Complex|-3797.7|528.6|54.8|10;Waverley Bus ' +
  'Depot|3059.3|2592.8|30.4|13;industrial yard|-4059.0|-66.2|32.6|3;Shell Oil ' +
  'Terminal|-2277.5|-3397.7|69.6|10;industrial yard|-1056.9|3960.8|76.6|11;Lilyfield ' +
  'Depot|-4079.2|608.3|31.8|22;industrial yard|-3571.3|-2125.4|26.5|36;industrial ' +
  'yard|-791.3|4080.4|69.3|19;Mitchell Industrial Estate|-1862.2|4023.0|80.8|25;CBD and South East Light Rail ' +
  'Depot|1740.5|4079.0|57.1|16;North Sydney Bus Depot|761.7|-4439.6|32.5|116;industrial ' +
  'yard|-3394.9|-3012.5|26.5|11;industrial yard|-2194.2|4086.4|33.9|25;Leichhardt Bus ' +
  'Depot|-4613.1|920.3|94.7|4;industrial yard|-1673.5|4463.8|57.8|16;Randwick Bus ' +
  'Depot|2547.9|4100.9|68.0|27;industrial yard|-1816.5|4651.3|46.2|8;industrial ' +
  'yard|-1508.8|4830.1|124.0|9;industrial yard|-5114.1|1098.1|30.2|7;industrial ' +
  'yard|-1906.1|4965.0|30.4|8;railway yard|-1510.4|-5317.8|30.2|36;industrial yard|-2068.9|5147.9|61.7|5;Sydney' +
  ' Metro Trains Facility South|-3269.4|4539.9|61.4|15;Westconnex Facility ' +
  'MOC5|-2598.2|5039.0|27.2|38;Appleseed Gardening|-3674.4|4335.3|25.9|25;industrial ' +
  'yard|-3859.9|4203.5|36.7|26;industrial yard|-2237.0|5307.6|24.9|3;U-Go Mobility Marrickville ' +
  'Depot|-3527.4|4649.3|31.1|13;industrial yard|-3266.2|4961.2|51.1|7;industrial ' +
  'yard|-4059.1|4348.6|27.8|22;industrial yard|-2019.9|5599.5|103.0|9;Southend ' +
  'Ln|-2372.9|5591.7|40.9|7;Westconnex Facility MOC4|-3047.7|5258.2|22.2|7;industrial ' +
  'yard|-3791.8|4769.0|26.8|12;industrial yard|6079.4|-904.7|33.8|3;industrial ' +
  'yard|-1846.2|5866.1|39.3|14;Artarmon Concrete Plant|-2208.2|-5782.1|38.5|15;industrial ' +
  'yard|-2759.3|5562.6|66.2|3;industrial yard|-5772.3|2408.5|25.2|12;industrial ' +
  'yard|-3679.3|5086.2|68.0|23;industrial yard|-4151.2|4778.1|38.8|5;industrial ' +
  'yard|-3924.3|5014.1|56.9|19;industrial yard|-2356.6|6000.4|115.5|16;industrial ' +
  'yard|-2721.4|5950.4|39.6|3;industrial yard|-4155.3|5089.1|22.5|17;industrial ' +
  'yard|-3619.1|5503.6|36.2|28;industrial yard|-6026.3|2938.0|25.9|46;Qantas|-2513.3|6238.6|119.4|3;Boral ' +
  'Concrete|-3085.9|6033.7|74.9|15;industrial yard|3496.7|5830.9|26.0|11;industrial ' +
  'yard|-1768.8|6596.5|86.2|50;industrial yard|-2816.3|6232.3|50.2|12;industrial ' +
  'yard|-2781.5|-6308.3|68.1|47;industrial yard|-4696.2|5244.1|27.0|16;railway ' +
  'yard|-4478.3|5491.3|126.0|16;industrial yard|-4811.4|5534.8|30.5|27;industrial ' +
  'yard|-1390.1|7242.7|27.4|21;South Head Signal Station|7136.3|-2154.0|23.2|4;Delivery Management ' +
  'North|-2807.6|-6915.2|53.4|38;industrial yard|-6752.6|3266.0|24.1|68;industrial ' +
  'yard|-2309.7|7140.3|48.3|14;industrial yard|-7465.9|773.6|28.1|47;industrial ' +
  'yard|-1163.1|7430.8|80.1|21;industrial yard|-4782.4|5886.0|42.8|18;industrial ' +
  'yard|-6384.3|4110.3|28.1|50;Tempe Bus Depot|-4442.6|6225.5|57.8|5;industrial ' +
  'yard|-2756.1|-7137.6|23.1|47;Willoughby Bus Depot|-633.4|-7808.9|57.5|29;railway ' +
  'yard|-4819.6|6331.1|34.4|6;industrial yard|-4479.1|6590.0|28.6|4;industrial yard|-1259.2|7975.7|59.1|4;Joint' +
  ' User Hydrant Installation|-4002.8|7033.6|71.4|19;industrial yard|-358.2|8256.1|27.4|25;industrial ' +
  'yard|-8280.1|293.6|85.3|16;Lane Cove Council Depot|-5596.1|-6114.2|26.0|12;Randwick Council ' +
  'Depot|3576.4|7561.4|66.1|5;industrial yard|-8528.4|296.3|30.7|30;industrial ' +
  'yard|-7795.0|3489.1|39.8|72;industrial yard|-6068.5|-6223.1|55.0|8;industrial ' +
  'yard|4144.2|7651.0|87.4|6;industrial yard|-2396.2|8376.8|33.5|13;industrial ' +
  'yard|-5250.0|7233.2|65.0|11;industrial yard|-5884.6|6820.1|62.3|44;industrial ' +
  'yard|-960.4|-8973.4|103.8|19;industrial yard|-6101.3|-6659.3|75.3|13;industrial ' +
  'yard|-4851.0|7623.5|36.4|10;industrial yard|255.9|9045.3|132.5|6';

/**
 * The bridge and viaduct midpoints, packed. `name|x|z|length|bearing`.
 *
 * `length` is the whole carriageway's, in metres, and is what decides how much
 * of the void the rig is allowed to fill; `bearing` is the deck's direction at
 * the midpoint, in radians on the renderer's own convention, taken from a 40 m
 * chord rather than from the end-to-end line so a curving ramp gives the
 * bearing *there* rather than an average of a bend.
 *
 * Thinned to one anchor per 300 m, because the Western Distributor's ramp stack
 * is eleven ways over the same two hundred metres of Pyrmont and eleven raves in
 * one car park is not eleven raves.
 */
const SPANS_PACKED =
  'Western Motorway|-18135.6|-4252.4|1869|-1.9080;Western Motorway|-18524.4|-4287.8|1089|-1.4522;Western ' +
  'Motorway|-17777.4|-4052.0|674|0.8719;Gore Hill Freeway|-1235.2|-6228.8|646|1.2122;M5 ' +
  'Motorway|-3675.0|8711.8|582|-1.6104;Southern Cross Drive|-1336.4|7801.8|578|2.4952;Qantas ' +
  'Drive|-3192.3|6312.7|504|-2.6894;Western Distributor|-521.2|-391.8|498|-0.3764;Roberts ' +
  'Road|-13054.6|2272.3|465|2.7237;Syd Einfeld Drive|3743.3|2375.6|459|-1.5718;Fairford ' +
  'Road|-15833.7|7571.3|455|2.9519;Sydney Gateway|-2249.6|6901.9|429|0.3739;Western ' +
  'Distributor|-911.1|599.0|419|1.9032;Cahill Expressway|80.7|-825.2|417|-1.6522;Western ' +
  'Motorway|-11151.3|-264.5|375|-1.8797;Western Distributor|-1507.5|314.5|334|0.8741;M2 Hills ' +
  'Motorway|-14075.6|-12158.5|319|1.6117;Warringah Freeway Onramp|268.5|-4829.4|319|0.7790;Western ' +
  'Motorway|-16665.0|-3423.1|308|1.0546;Western Motorway Onramp|-10696.8|-151.5|280|-1.7602;Western ' +
  'Motorway|-11769.1|-553.6|269|0.9164;Centenary Drive|-12886.1|1959.0|268|0.0733;Sydney ' +
  'Gateway|-2030.8|7212.2|256|-0.1399;Pacific Highway Offramp|-2936.7|-6201.9|249|-1.8033;Western ' +
  'Distributor|-1281.8|640.5|239|0.7004;Sydney Gateway|-2682.4|5306.6|232|-0.5183;The ' +
  'Crescent|-3375.1|333.9|230|-3.0136;Cahill Expressway|281.5|-2249.2|229|-0.0845;Cahill ' +
  'Expressway|-104.2|-1407.0|226|-0.4576;Shiers Avenue|-2576.1|7169.9|217|1.4165;Strathallen ' +
  'Avenue|181.6|-5751.2|196|0.2356;Western Motorway Onramp|-17437.5|-3800.5|191|0.7976;Departure ' +
  'Plaza|-3897.3|7205.1|187|0.4983;Lane Cove Road|-7013.2|-10195.9|184|0.0543;Victoria ' +
  'Road|-6025.3|-3259.1|183|1.3318;Henry Lawson Drive|-15267.7|10732.4|183|-0.8236;Stacey ' +
  'Street|-15483.4|5711.4|182|-0.2672;M5 Motorway|-4805.7|8012.8|181|-2.3755;Cahill ' +
  'Expressway|223.4|-2602.4|179|0.3094;M5 Motorway|-15348.3|8298.8|177|1.4244;M2 Hills ' +
  'Motorway|-10510.1|-11276.6|169|-1.6092;Pier Street|-666.2|948.6|166|2.0300;King Street ' +
  'Offramp|-596.7|188.4|151|3.1336;Airport Drive|-3228.5|5857.5|148|-1.0394;Departure ' +
  'Plaza|-3935.9|7647.4|146|-0.8081;Burton Street|1253.4|1235.3|142|0.7051;Stephen ' +
  'Road|93.5|8498.7|140|-2.7021;Silverwater Road|-14590.0|-6134.8|139|3.0172;motorway_link ' +
  'viaduct|-12536.3|-920.1|137|-1.9783;High Street|76.9|-2981.1|117|-1.7532;Darling ' +
  'Drive|-996.6|237.7|112|0.1399;Rosedale Road|-5084.2|-13037.0|109|3.0083;Southern Cross ' +
  'Drive|-17.2|7431.9|102|-1.2154;Homebush Bay Drive|-11874.8|-1870.8|102|2.7179;Epping ' +
  'Road|-7883.5|-8868.8|102|0.8448;Warringah Road|-880.8|-10496.0|100|1.9761;Centenary ' +
  'Drive|-13237.0|-269.9|97|-0.3089;Western Motorway Onramp|-12847.8|-1074.2|91|-0.7467;Western ' +
  'Motorway|-13662.9|-1345.1|90|1.0699;Homebush Bay Drive|-12245.9|-1412.5|87|-0.9722;Lawson ' +
  'Street|-903.1|2542.4|86|1.4139;Western Motorway|-14738.8|-2140.6|82|0.8239;Western Distributor ' +
  'Onramp|-599.1|562.2|78|-0.7720;Victoria Road|-17303.2|-6289.3|78|-1.5761;Gardeners ' +
  'Road|576.0|6165.2|77|-1.7700;Beecroft Road|-12211.4|-11493.9|76|0.7306;Warringah Freeway ' +
  'Onramp|401.7|-4556.8|76|-1.1175;Longport Street|-5959.0|2760.2|75|-1.9052;Gore Hill Freeway ' +
  'Onramp|-2311.6|-6095.6|72|1.4352;Epping Road|-5173.2|-6655.1|72|-2.6024;Epping ' +
  'Road|-6827.6|-7923.0|72|0.8155;Murray Farm Road|-13488.5|-11949.4|71|-3.1241;Miller ' +
  'Street|-14.7|-4951.1|71|-0.1749;City West Link|-4037.6|664.6|70|1.9337';

/**
 * How big a park has to be to hold a rave, metres of inscribed radius.
 *
 * 90 is a 180 m clearing, which is a *field*. Below that the disc is a lawn
 * between two paths and a forty-person crowd with a laser rig in it is standing
 * in somebody's front garden. 270 of the 1,821 baked discs qualify, which is
 * plenty of variety without the pool being mostly pocket parks.
 */
export const PARK_MIN_R = 90;

/**
 * How much of a site's inscribed circle the event is allowed to use, and the
 * ceiling on it.
 *
 * A rave does not fill a park. Centennial's disc is 579 m across and a crowd of
 * fifty in the middle of it occupies about sixty; the rest is the dark you walk
 * through to get there, which is most of the experience. `SITE_MAX_R` is the cap
 * that keeps a big park from producing a rave the size of a suburb, and the
 * fraction is what keeps a small yard's rig off the fence.
 */
const SITE_USE_FRACTION = 0.62;
const SITE_MAX_R = 62;
/** Below this there is not enough clear ground for a rig and a crowd. */
const SITE_MIN_R = 15;

/**
 * How near a police station a site has to be to be *known*. See section 5.
 *
 * 900 m, against `factions.CATCHMENT_MIN`'s 260 and `CATCHMENT_MAX`'s 520, and
 * the difference in kind matters: a catchment is the ground officers are
 * *dispatched over*, and this is the ground a rave can be heard across at two in
 * the morning with nothing else running. A sub-bass at 128 BPM carries a
 * kilometre over a flat industrial suburb, which is why the neighbours always
 * know.
 *
 * 78 of the 448 sites — a sixth — fall inside one, so about one rave a night in
 * the whole city gets shut down. That is the right rate for the joke: often
 * enough that a regular player has stood in one when it happened, rare enough
 * that it is never the thing that always happens.
 *
 * It also produces a fact nobody wrote down and which is exactly right: **Sydney
 * Park is not watched.** The nearest command is Newtown at 1,541 m, which is
 * why you would hold one there.
 */
export const WATCHED_RADIUS = 900;


/** The extent the tables were baked inside. `verifyRaves` asserts it. */
export const RAVE_EXTENT_M = 60000;
/**
 * How wide the void under a viaduct is treated as being, metres of half-extent.
 *
 * A two-carriageway urban viaduct is 20-26 m across the deck and the piers are
 * inboard of that, so 30 m of half-extent puts the crowd's outer edge just past
 * the drip line — which is exactly where a real one ends, because past the drip
 * line it is raining. Deliberately smaller than every other kind: an under-bridge
 * rave is *tight*, and it should feel it.
 */
const SPAN_HALF_WIDTH = 46;

/**
 * One candidate site as the three source tables describe it, before the
 * clearance pass and before the `SITE_MIN_R` filter.
 *
 * Split out from `RAVE_SITES` for exactly one reason: `CLEARED_PACKED` has to
 * address a row by index, and it must be an index that exists **whether or not
 * that row survives**. Keying the clearance pass on `RaveSite.id` would be a
 * table that renumbers itself when it drops a row, which is a table that is
 * wrong the first time it is used.
 *
 * `r` here is the raw radius the source table carries — a parcel's inscribed
 * circle, a span's half-strip, a park's disc — not the usable one. The scaling
 * to usable is `SITE_USE_FRACTION`'s and happens below.
 */
export interface RaveSourceRow {
  readonly kind: SiteKind;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly r: number;
  readonly bearing: number;
}

/**
 * Every candidate, yards then spans then parks, in that order and no other.
 *
 * The order is the invariance, and it is `wildlife.PARKS`' own words: a hash is
 * keyed on the site's **index**, so site 41 is the same yard on the same nights
 * before and after the span block existed only because site 41 is still the
 * Mitchell Industrial Estate. Appending a block is the whole trick.
 */
export const RAVE_SOURCE_ROWS: readonly RaveSourceRow[] = (() => {
  const out: RaveSourceRow[] = [];
  for (const rec of YARDS_PACKED.split(';')) {
    const f = rec.split('|');
    out.push({ kind: SITE_KIND.YARD, name: f[0], x: +f[1], z: +f[2], r: +f[3], bearing: NaN });
  }
  for (const rec of SPANS_PACKED.split(';')) {
    const f = rec.split('|');
    // A span's clear space is not an inscribed circle -- it is a strip of void
    // under a deck. `SPAN_HALF_WIDTH` is what a two-carriageway viaduct actually
    // shelters, and the length is capped by the same ceiling everything else is,
    // because a 1.8 km motorway viaduct is still one rave and not a linear park.
    out.push({
      kind: SITE_KIND.SPAN,
      name: f[0],
      x: +f[1],
      z: +f[2],
      r: Math.min(+f[3] * 0.35, SPAN_HALF_WIDTH),
      bearing: +f[4],
    });
  }
  for (const park of PARKS) {
    if (park.r < PARK_MIN_R) continue;
    // `wildlife.PARKS` now reaches 60 km (the anchor tables were extended ahead
    // of the world), but a rave needs ground for its crowd to stand on, so the
    // site table stops at the BUILT extent. Cheap and load-bearing both ways:
    // without it, 3,071 stage-4 park discs mint hundreds of sites whose tiles
    // do not exist; with it, source-row indices for everything inside the
    // extent are unchanged, because the stage-4 rows append strictly after the
    // curated rows this table was cleared against. When the 60 km world ships,
    // RAVE_EXTENT_M moves with it and `clear_rave_floors.ts` re-bakes against
    // the new collision -- the two must move together or verifyRaves fails on
    // exactly the assertion this comment is standing next to.
    if (Math.hypot(park.x, park.z) > RAVE_EXTENT_M) continue;
    out.push({ kind: SITE_KIND.PARK, name: park.name, x: park.x, z: park.z, r: park.r, bearing: NaN });
  }
  return out;
})();

/**
 * The clearance pass: every site whose dance floor stood in a building, and
 * where it moved to. `row|x|z|r`, semicolon separated, `r` already usable.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TABLE EXISTS.
 *
 * *"i found a rave inside a building in alexandria. it shouldnt be INSIDE a
 * building"* — and it was, at row 40, which is the `industrial yard` whose
 * inscribed centre `(-1508.8, 4830.1)` sits **26.7 m inside a 6 m warehouse
 * with a 111 x 126 m footprint**, 327 m from the Alexandria pin and 863 m from
 * the spawn. Section 2 has the root cause: a parcel's largest inscribed circle
 * is a fact about the parcel's *boundary*, and the shed standing in the middle
 * of the parcel is not in that calculation at all.
 *
 * Measured against the shipped collision prisms, at `raveFloorRadius`:
 *
 * ```
 *   centres inside a building            57 of 448
 *   floors clipping a building          161 of 448
 * ```
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS A SEPARATE TABLE RATHER THAN CORRECTED COORDINATES.
 *
 * Three reasons, and the third is the one that decided it.
 *
 *   1. `PARKS` is `wildlife.ts`'s and the wildlife reads it too. A park whose
 *      centre moved here would move every bird in it, for a reason that has
 *      nothing to do with birds.
 *   2. `YARDS_PACKED` and `SPANS_PACKED` are the record of what OSM says, baked
 *      by `data/scratch/bake_rave_anchors.py`. Editing numbers inside them
 *      would make the bake and the file disagree with no note of which is
 *      right, and the next person to re-run the bake would silently revert
 *      this.
 *   3. **The correction is derived from a different source than the sites are.**
 *      The rows come from OSM parcels; this comes from the shipped collision
 *      prisms. Two derivations, two tables, and the join between them is an
 *      index — which is the same shape every other baked join in this project
 *      has.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PASS ACTUALLY DID, PER SITE.
 *
 * It searched outward from the original centre in 2 m rings for the nearest
 * point whose whole `raveFloorRadius` disc clears every building footprint by
 * `CLEAR_MARGIN`, subject to two constraints that keep the answer honest:
 *
 *   - **It stays inside the source circle.** `dist <= source r`, so a relocated
 *     yard is still provably on its own parcel and a relocated park is still
 *     provably in the park. That is the one guarantee the source tables *do*
 *     carry, and it is what stops a nudge from putting a rave in the street
 *     outside.
 *   - **It stays out of the water**, against the same terrain and water tables
 *     the server stands players on. Half the yards in this table are wharves,
 *     and a wharf's nearest clear ground is the harbour.
 *
 * Where no such point exists the radius shrinks — a rave takes the apron it can
 * actually stand in — and the search runs again, because a smaller floor both
 * needs less room and is allowed to travel further. A row that cannot reach
 * `SITE_MIN_R` anywhere is dropped, with `r = 0` saying so.
 *
 * The ideal outcome, and the common one, is exactly what you would expect of
 * the real thing: the rave is now in the **car park beside the warehouse**
 * rather than in the warehouse.
 *
 * Regenerated by `data/scratch/clear_rave_floors.ts`. `checkRaves` re-derives
 * the whole assertion from the collision sidecars, so a stale row here fails
 * the build rather than shipping.
 *
 * ---------------------------------------------------------------------------
 * AND IT DID, ONCE, AND THE REPAIR IS ONE ROW RATHER THAN A REGENERATION.
 *
 * The partial retile of 2026-08-17 re-emitted 383 of the 18,113 tiles, and one
 * of them put a footprint 1.5 m inside the dance floor of row 125, the
 * **Western Distributor** span (site 97). `checkRaves` went red naming it,
 * which is the whole reason it re-derives rather than trusts.
 *
 * Re-running the pass over the new sidecars answers `125|-1510.6|311.9|28.5`
 * -- a 2.9 m nudge -- and that row is what was taken. What was *not* taken is
 * the rest of its output, and the reason is this file's own invariance: the
 * pass also now drops rows 3, 87 and 160 and rescues 61, 122 and 146, none of
 * which `checkRaves` has any complaint about, and a row that stops surviving
 * **renumbers every `RaveSite.id` after it**. Ids are what every hash in this
 * file is keyed on, so a wholesale paste would silently move the draw nights of
 * seven hundred raves to fix one. A row that stays alive changes nothing but
 * its own two coordinates, which is what an insert is.
 */
const CLEARED_PACKED =
  '0|62.8|-1118.9|15.3;1|-1027.8|584.2|15.7;3|-287.5|1670.4|62.0;4|-1700.1|309.9|19.9;5|-1302.2|-1793.2|24.7;6|-2142.1|-812.2|40.1;8|-2381.5|4.7|33.7;9|-2063.9|-1400.3|17.1;12|-2618.2|-221.3|42.6;14|0|0|0;16|-881.6|-2903.4|16.1;17|-3181.4|245|17.9;19|-1570.8|3091.6|40.8;20|0|0|0;21|0|0|0;23|-3851.2|535.6|29.7;24|3065.1|2591.2|18.8;25|0|0|0;26|-2321.9|-3431.8|43.2;27|0|0|0;28|-4077.1|616|19.7;29|-3563.4|-2119.3|16.4;30|-727.5|4063.3|37.6;31|-1924|4006.4|43.8;32|1737.3|4076.6|35.4;34|-3389.2|-3033.8|16.4;35|-2213.7|4061|18.4;36|-4591.3|923.2|58.7;37|0|0|0;38|2544.2|4096.1|42.2;39|-1805.1|4608.8|28.6;40|-1600.8|4900.7|54.3;41|0|0|0;42|0|0|0;45|-3269.4|4551.9|38.1;47|0|0|0;48|-3826.2|4199.1|22.8;50|-3525.8|4650.5|19.3;51|-3217.9|4974.1|27.7;52|0|0|0;56|0|0|0;61|0|0|0;62|-3662.2|5022.4|26.3;63|-4135.6|4787.1|24.1;64|0|0|0;68|0|0|0;69|0|0|0;76|-4683.5|5231.4|16.7;77|-4435|5516.3|62.0;78|0|0|0;84|-7450.3|764.6|17.4;86|0|0|0;87|0|0|0;88|-4442.6|6231.5|35.8;92|-4458.3|6602|17.7;93|-1259.2|8001.7|36.6;94|-4000.4|7036.8|44.3;96|-8340.1|293.6|26.4;99|-8552.2|314.6|19.0;100|-7804.7|3486.5|24.7;104|-5202|7213.3|40.3;105|-5868.6|6760.2|33.8;108|0|0|0;115|0|0|0;117|-534.4|-358.3|28.5;122|0|0|0;123|0|0|0;125|-1510.6|311.9|28.5;126|0|0|0;128|0|0|0;134|-1294.7|625.2|28.5;135|0|0|0;137|279.6|-2227.3|28.5;141|-17446.1|-3808.9|28.5;148|0|0|0;152|0|0|0;155|1270.3|1255.1|28.5;160|-996.3|239.7|15.0;170|-877.4|2546.5|18.7;184|2463.6|3288|62.0;186|-4654|-104.7|62.0;189|731.1|-410.9|62.0;190|-5181.3|76.7|62.0;199|-1538.3|2042.8|62.0;201|220.8|747.9|62.0;203|1213.6|2285.9|62.0;206|574.4|166.9|62.0;208|564.6|-924.3|61.5;213|-3363.5|168.3|57.6;233|-10343.9|-2500.6|62.0;259|-14522|-4456.9|62.0;265|-13265.4|426|62.0;274|-15058.4|1176.5|62.0;282|0|0|0;287|-1687.6|-6375.1|62.0;289|-11657.6|1945.8|62.0;305|-5785.5|10637|62.0;319|-9816.5|656.1|62.0;346|-8040.7|4181|62.0;348|-14462.1|-874.1|61.6;357|-5662.3|14136.5|60.1;358|-8500|-10707.5|60.1;362|5576.3|-9914.3|59.5;377|-6052.4|7484.3|57.3;380|6387.5|-9268.6|56.5;390|-4236.8|18125|62.0;402|-11933.1|-14368.4|62.0;405|-12273.4|10257.8|62.0;408|-12089.1|-13712.6|62.0;423|-17756.5|-1110.9|62.0;425|-15951.9|-10553.8|62.0;430|-15043.8|8214.1|62.0;439|-17784.8|2618|60.9;447|-18195.8|-389|57.2;448|-4514.2|-17637.9|57.1;450|-13802.9|10162.2|56.5;456|-19714.5|4764.6|62.0;458|-32624.1|2001.8|62.0;460|-42195.4|-9753.8|62.0;473|-44146.7|-11713|62.0;483|-45029.7|20940.5|62.0;498|-46277.1|-12419.5|62.0;500|-19606.7|-6387.1|62.0;506|-30000.2|-13188.6|62.0;510|-26073.6|-2351.5|62.0;514|-21239.4|-11106.5|62.0;530|-48574.6|-8432.2|62.0;532|-28799.6|-10857.5|62.0;533|-15550.3|-16337.4|62.0;539|-47639.3|-31212.3|62.0;542|-34893.7|-12333.9|62.0;545|-33373.6|3500.7|62.0;547|-33408.7|18529.7|62.0;548|-35745.2|19204.6|62.0;549|-22985.8|10074.3|62.0;564|-32988|17227.1|62.0;567|-41734.9|-8376.1|62.0;570|-27610.3|2297.1|62.0;580|-48562.9|-11246|62.0;582|-32764.1|2857|62.0;587|-33970.3|8030.5|62.0;591|-19445|4118.2|62.0;595|-39093|-7688.5|62.0;601|-31500|928.6|62.0;602|-19265.2|4423.7|62.0;603|-52120.8|-11154.2|62.0;610|14199.2|-56674.7|62.0;612|-33000.3|16887.1|62.0;613|-40503.9|-8793.6|62.0;614|13999.6|-41335.6|62.0;622|-26158.2|-8435.7|62.0;627|-21980.6|-10365.8|62.0;628|-21366.2|-3752.6|62.0;634|-40881.4|-9477.7|62.0;637|-22537.6|-12931|62.0;639|-30015.5|-15645.8|62.0;642|-22332.2|-13650.1|62.0;645|-37743.9|-9255.8|62.0;646|-29695.1|6535.2|62.0;651|-17663.5|16720.2|62.0;662|-29322.1|12759.7|62.0;664|-26067.2|-16921.6|62.0;670|-34443.4|-12872.4|62.0;675|-28519.8|-10778.1|62.0;679|-35718.6|23484.6|62.0;680|-27226.9|1526.2|62.0;681|-37479.8|-6299.5|62.0;687|-33110.2|-34866.1|62.0;691|-20462.6|2794.2|62.0;695|-25437.1|-17779.2|62.0;696|-48860.2|-12642.9|62.0;701|-33142.1|23304.3|62.0;702|-35770.9|20177.6|62.0;703|-30934.6|1461.3|62.0;704|-26696.4|-14767.3|62.0;707|-35138.4|26404.6|62.0;709|-29225.6|12527.2|62.0;713|-25125.3|-5455.2|62.0;715|-31396.9|-18772.7|62.0;718|-21533.4|7772.2|62.0;719|-40240.3|-6744.3|62.0;720|-22113.1|-16615.6|62.0;725|-36659.6|13120.6|62.0;732|-31501.1|23738.1|62.0;733|-29431|15252|62.0;736|-20767.6|10932.9|62.0;737|-37240|23044.5|62.0;741|-34092.3|22498|62.0;749|-17527.8|-10826|61.8;752|-18568.2|9516.4|61.4;753|-19755.9|-4846.7|61.3;757|-45344.2|-29795.1|60.9;758|-16186.7|-23078.2|60.9;760|-32650|8666.5|60.6;765|-43499.6|-9351.3|60.5;767|-33196.6|3934.4|60.4;769|-30600.2|-10941.8|60.3;779|-41043.4|20999.7|59.1;785|-29569.3|15997.1|58.9;787|-38606.8|-9811.9|58.8;790|-28818.6|-24447.5|58.7;791|-57329.1|-16867.5|58.7;799|-10403.4|17068.5|58.3;809|-25080.4|1943.9|57.4;810|-35073.1|-8567.1|57.3;816|-21164.4|3102.7|56.7;817|-47119.3|-13253.5|56.7;818|-28282|7999.1|56.7;822|-32339.7|-10685.1|56.5;824|-26499.9|-6244.2|56.3;826|-37999.9|-26342|56.2';

/** `CLEARED_PACKED` decoded: row index to its correction, or null for dropped. */
const CLEARED: ReadonlyMap<number, { x: number; z: number; r: number } | null> = (() => {
  const out = new Map<number, { x: number; z: number; r: number } | null>();
  if (CLEARED_PACKED.length === 0) return out;
  for (const rec of CLEARED_PACKED.split(';')) {
    const f = rec.split('|');
    const r = +f[3];
    out.set(+f[0], r > 0 ? { x: +f[1], z: +f[2], r } : null);
  }
  return out;
})();

/**
 * Every site that survived, in source-row order, `id` being its index here.
 *
 * Two filters, and they are different in kind: `CLEARED` drops a row that has
 * nowhere clear to stand, and `SITE_MIN_R` drops one that was never big enough
 * to begin with.
 */
export const RAVE_SITES: readonly RaveSite[] = (() => {
  const out: RaveSite[] = [];

  const near = (x: number, z: number): boolean => {
    const r2 = WATCHED_RADIUS * WATCHED_RADIUS;
    for (const s of POLICE_STATIONS) {
      const dx = s.x - x;
      const dz = s.z - z;
      if (dx * dx + dz * dz <= r2) return true;
    }
    return false;
  };

  for (let row = 0; row < RAVE_SOURCE_ROWS.length; row++) {
    const src = RAVE_SOURCE_ROWS[row];
    const fix = CLEARED.get(row);
    // `undefined` is "this row was already clear"; `null` is "the pass looked
    // and there was nowhere". The two are not the same answer and a `?? `
    // would have collapsed them.
    if (fix === null) continue;
    const x = fix === undefined ? src.x : fix.x;
    const z = fix === undefined ? src.z : fix.z;
    const use = fix === undefined ? Math.min(src.r * SITE_USE_FRACTION, SITE_MAX_R) : fix.r;
    if (use < SITE_MIN_R) continue;
    out.push({ id: out.length, kind: src.kind, name: src.name, x, z, r: use, bearing: src.bearing, watched: near(x, z) });
  }
  return out;
})();

/**
 * How much of a site's usable radius the crowd is allowed to reach, and the
 * margin that turns that into the disc which must be clear of buildings.
 *
 * 0.66 is `venueFor`'s `depth` — the crowd's front edge, and the furthest from
 * the centre any part of the event goes. Measured rather than assumed, by
 * running `attendeeAt` over every site across forty nights with the obstacle
 * rejection switched off: the furthest anybody ever stood from the centre was
 * **0.637 of the usable radius**, and the booth itself sits at exactly 0.660.
 * So `depth` bounds the whole event with 3.6% of slack already in it.
 *
 * The 2 m on top is for the rig rather than for the people. The booth stands at
 * exactly `depth`, and a stack of speakers whose *centre* is tangent to a wall
 * is still a stack of speakers in a wall.
 */
export const CROWD_DEPTH_FRACTION = 0.66;
export const RAVE_FLOOR_MARGIN = 2;

/**
 * The disc a rave occupies, metres about `site.x, site.z`.
 *
 * The one definition of "the dance floor", exported because three separate
 * things need to agree about it and none of them owns it: the clearance bake
 * that moved the sites, `checkRaves` which asserts none of them is in a
 * building, and this file's own `venueFor`.
 */
export function raveFloorRadius(r: number): number {
  return r * CROWD_DEPTH_FRACTION + RAVE_FLOOR_MARGIN;
}

// --- Which sites are live tonight ----------------------------------------------

/** At most this many raves in the whole city on one night. See section 3. */
export const MAX_LIVE = 6;

/**
 * The chance an ordinary site draws, per night.
 *
 * 0.010 over the 454-site table is an expectation of 4.5, which with the home
 * rave and Sydney Park's fixture lands the typical night at five and the cap at
 * six catches the tail. One site in a hundred nights is the number the header's
 * rarity argument is made of.
 */
const CITY_SHARE = 0.010;

/**
 * How far from the spawn counts as "walking distance". See rule 2 in section 3.
 *
 * 1,600 m is about a twenty-minute walk or six minutes at a sprint, and it is
 * the radius that contains the Alexandria and St Peters yards, the Sydney
 * Gateway viaducts, Sydney Park, Mitchell Industrial Estate and the Marrickville
 * depots — thirteen sites, which is enough variety that the home rave is not the
 * same place every night and few enough that it is always somewhere a player
 * could stumble into.
 */
export const HOME_RADIUS = 1600;

/**
 * Sydney Park's own share of nights, because the user asked for it by name.
 *
 * Two nights in five. The spawn is 32 m from its centre, so this is the rave a
 * player is most likely to meet first and the one the brief's own sentence is
 * about — *"in the forest.... right near spawn"*. It is drawn independently of
 * the home rave, so on the nights both land there are two within a kilometre,
 * which is a good night out.
 */
export const SYDNEY_PARK_SHARE = 0.4;

/** Which entry of `RAVE_SITES` is Sydney Park. Resolved once; asserted by `verifyRaves`. */
export const SYDNEY_PARK_SITE = RAVE_SITES.findIndex((s) => s.kind === SITE_KIND.PARK && s.name === 'Sydney Park');

/** The sites inside `HOME_RADIUS` of the spawn, in table order. */
const HOME_SITES: readonly number[] = RAVE_SITES.filter((s) => {
  const dx = s.x - SPAWN_TARGET.x;
  const dz = s.z - SPAWN_TARGET.z;
  return dx * dx + dz * dz <= HOME_RADIUS * HOME_RADIUS;
}).map((s) => s.id);

// --- What one rave is, once it has been drawn -----------------------------------

export interface RaveVenue {
  readonly site: RaveSite;
  /** The night this instance is. Everything below is hashed on `(site.id, night)`. */
  readonly night: number;
  /** Which way the rig faces, radians. The site's own if it has one, else hashed. */
  readonly bearing: number;
  /** Beats per minute. Drives the sweep, the strobe and the crowd's bounce. */
  readonly bpm: number;
  /** How many attendees at the peak. Tens; see `ATTENDEE_CAP`. */
  readonly attendees: number;
  /**
   * Where in the night the police arrive, as a fraction of it, or 1 for never.
   * See section 5 and `bustAt`.
   */
  readonly bust: number;
  /** Which of `PALETTES` the rig is wearing tonight. */
  readonly palette: number;
  /** Metres from the centre to the front of the crowd. The booth is behind that. */
  readonly depth: number;
}

/**
 * How many people, at most, at one rave.
 *
 * *"each with a crowd in the tens"*. 64 is the top of that and it is also where
 * the far tier's own arithmetic sits: `world/rave.ts` draws attendees as the
 * pedestrian impostor, three matrix composes each, so 64 is 192 composes for the
 * densest rave in the city — against `PedestrianCrowd`'s 0.17 ms for 53 people
 * with eleven skeletons in them. The rave's crowd has no skeletons past the
 * first eight, so it is cheaper per head than the street is.
 */
export const ATTENDEE_CAP = 64;

/**
 * How many colour schemes a rig can be wearing. Four, hashed per night.
 *
 * The colours themselves are in `world/rave.ts`, because they are radiometric
 * multipliers under a tone curve and belong beside the material that uses them.
 * What is here is the *index*, because it has to be the same index on every
 * screen and this is the file that guarantees that.
 */
export const PALETTE_COUNT = 4;

/**
 * Draw a night's raves. Pure, and cached on the night index.
 *
 * The cache is the only state in this file and it holds exactly one night. It is
 * not an optimisation of the arithmetic — 454 hashes is about twelve
 * microseconds — it is what stops the frame loop **allocating an array every
 * frame**, which at 60 Hz over an hour of play is 216,000 arrays for an answer
 * that changed once.
 */
let cachedNight = Number.NaN;
let cachedLive: readonly RaveVenue[] = [];

export function liveRaves(night: number): readonly RaveVenue[] {
  if (night === cachedNight) return cachedLive;
  cachedNight = night;
  cachedLive = drawRaves(night);
  return cachedLive;
}

/** The draw itself, exposed so `verifyRaves` can run it without touching the cache. */
export function drawRaves(night: number): readonly RaveVenue[] {
  const chosen = new Set<number>();

  // 1. The fixture. See `SYDNEY_PARK_SHARE`.
  if (SYDNEY_PARK_SITE >= 0 && hash(night, 0x5d) < SYDNEY_PARK_SHARE) chosen.add(SYDNEY_PARK_SITE);

  // 2. The home rave, and it is unconditional. `hashInt % length` rather than a
  // float scaled by the length: the float form has an exact-1.0 case at the top
  // of the range that would index off the end once every four billion nights,
  // and "once every four billion" is a bug that ships.
  if (HOME_SITES.length > 0) {
    chosen.add(HOME_SITES[hashInt(night, 0x1b) % HOME_SITES.length]);
  }

  // 3. The rest of the city, capped. The cap takes the *lowest hashes* rather
  // than the first found, because "the first six" would be a statement about
  // iteration order and a future append to the table would silently re-draw
  // every night in history.
  const extra: Array<{ id: number; key: number }> = [];
  for (const site of RAVE_SITES) {
    if (chosen.has(site.id)) continue;
    const h = hash(site.id, night, 0x9e);
    if (h < CITY_SHARE) extra.push({ id: site.id, key: h });
  }
  extra.sort((a, b) => a.key - b.key || a.id - b.id);
  for (const e of extra) {
    if (chosen.size >= MAX_LIVE) break;
    chosen.add(e.id);
  }

  const out: RaveVenue[] = [];
  for (const id of [...chosen].sort((a, b) => a - b)) out.push(venueFor(RAVE_SITES[id], night));
  return out;
}

/** Everything a drawn site decides for one night. Pure. */
export function venueFor(site: RaveSite, night: number): RaveVenue {
  // 124 to 136 in steps of two. The bottom is where a four-on-the-floor stops
  // being dance music and the top is where it stops being house; the step keeps
  // the number a thing a person would say out loud.
  const bpm = 124 + ((hashInt(site.id, night, 0x11) % 7) * 2);

  // How many people. A yard's apron and a park's clearing hold a crowd; the void
  // under a viaduct is a strip, and it is *tight*, which is what makes it feel
  // like a bridge rave rather than a smaller park one. Scaled by the site's own
  // usable radius so a 62 m clearing is fuller than a 16 m one, then jittered.
  // A yard's apron and a park's clearing hold a crowd loosely; the void under a
  // viaduct is a strip with a concrete ceiling and people stand in it *tightly*,
  // which is why the span multiplier is above one on a footprint that is already
  // the smallest of the three.
  const room = site.r * site.r * (site.kind === SITE_KIND.SPAN ? 1.4 : 1);
  const base = 12 + room * 0.008;
  const attendees = Math.max(9, Math.min(ATTENDEE_CAP, Math.round(base * (0.7 + hash(site.id, night, 0x2c) * 0.6))));

  return {
    site,
    night,
    // A span is laid out along its deck; everything else picks a bearing per
    // night, which is what the real thing does -- the rig points wherever the
    // truck could reverse to.
    bearing: Number.isNaN(site.bearing) ? hash(site.id, night, 0x37) * Math.PI * 2 : site.bearing,
    bpm,
    attendees,
    bust: bustAt(site, night),
    palette: hashInt(site.id, night, 0x43) % PALETTE_COUNT,
    // The crowd's front edge. Two thirds of the usable radius, so there is
    // always a rim of dark ground between the last dancer and whatever the site
    // is bounded by -- which is where you arrive, and arriving *at the edge of*
    // a crowd is different from arriving in the middle of one. Named rather
    // than written out, because `raveFloorRadius` is this same number and the
    // clearance bake is the thing that must not disagree about it.
    depth: site.r * CROWD_DEPTH_FRACTION,
  };
}

// --- The night's shape ----------------------------------------------------------

/**
 * The five states of a night, as the fraction of it each ends at.
 *
 * See section 4. The two that earn their place are the first and the last: a
 * rave with a load-in has a beginning you can watch, and a rave with a pack-up
 * has an end that is not a light switch.
 */
export const RAVE_STAGE = { LOADIN: 0, DOORS: 1, PEAK: 2, WINDDOWN: 3, PACKUP: 4, BUSTED: 5, GONE: 6 } as const;
export type RaveStage = (typeof RAVE_STAGE)[keyof typeof RAVE_STAGE];

const STAGE_END = [0.06, 0.22, 0.80, 0.96, 1.0] as const;

/**
 * How long the crowd takes to clear out after the police arrive, as a fraction
 * of the night.
 *
 * 0.04 of a 30-minute night is 72 seconds, which is about how long it takes four
 * hundred people to decide they were leaving anyway. Long enough that a player
 * who is standing in it watches it happen rather than finding an empty yard.
 */
const SCATTER_SPAN = 0.04;

/**
 * When the police arrive, as a fraction of the night, or 1 for never.
 *
 * Only a `watched` site is ever busted — see section 5. The window is the middle
 * two thirds: earlier than 0.38 and the rave never happened, later than 0.86 and
 * it was over anyway, and both of those are the joke not landing.
 */
export function bustAt(site: RaveSite, night: number): number {
  if (!site.watched) return 1;
  return 0.38 + hash(site.id, night, 0x77) * 0.48;
}

/** What a rave is doing right now. Everything a renderer or the mixer needs. */
export interface RaveState {
  /** Where in the night, 0..1, or -1 by day. */
  readonly t: number;
  readonly stage: RaveStage;
  /** How hard the rig is running, 0..1. Drives every emissive thing. */
  readonly intensity: number;
  /** What share of `attendees` is present, 0..1. */
  readonly crowd: number;
  /** Whether the sound system is on at all. */
  readonly playing: boolean;
  /**
   * How far out the scatter has pushed the crowd, metres. 0 unless busted.
   * The crowd walks *outward* from the booth, which is the only direction that
   * is away from the police.
   */
  readonly scatter: number;
  /** How much of the aftermath is still on the ground, 1 at dawn falling to 0. */
  readonly litter: number;
}

const DEAD: RaveState = {
  t: -1, stage: RAVE_STAGE.GONE, intensity: 0, crowd: 0, playing: false, scatter: 0, litter: 0,
};

/**
 * Evaluate a venue at an instant. Pure, allocates one object, no transcendentals.
 *
 * The one call every consumer makes. `world/rave.ts` reads `intensity` and
 * `crowd`, `game/audio.ts` reads `playing`, the big map reads `stage`, and the
 * aftermath reads `litter` — so there is exactly one place that decides what
 * time it is at a rave, and a renderer and the mixer can never disagree about
 * whether the music has stopped.
 */
export function raveState(venue: RaveVenue, nowMs: number): RaveState {
  const { index, phase } = raveNight(nowMs);
  if (index !== venue.night) return DEAD;

  const day = dayProgress(phase);
  if (day >= 0) {
    // The morning after. Litter for the first two thirds of the day, then the
    // council, or the promoter, or the rain. A linear fade rather than a step,
    // because the one thing that would give this away is a bottle disappearing
    // while somebody is looking at it.
    return { ...DEAD, litter: day < 0.66 ? 1 : Math.max(0, (1 - day) / 0.34) };
  }

  const t = phase / RAVE_NIGHT_SHARE;

  if (t >= venue.bust) {
    const since = (t - venue.bust) / SCATTER_SPAN;
    if (since >= 1) return { ...DEAD, t, stage: RAVE_STAGE.GONE, litter: 1 };
    // House lights: the rig is *on*, hard, and white -- which the renderer reads
    // off `stage` rather than off `intensity`, because the one thing a bust must
    // not look like is a fade-out.
    return {
      t,
      stage: RAVE_STAGE.BUSTED,
      intensity: 1,
      crowd: 1 - since,
      playing: false,
      scatter: since * SCATTER_DISTANCE,
      litter: since,
    };
  }

  let stage: RaveStage = RAVE_STAGE.PACKUP;
  for (let s = 0; s < STAGE_END.length; s++) {
    if (t < STAGE_END[s]) { stage = s as RaveStage; break; }
  }

  // The curve. Load-in is a work light and no music; doors ramps; peak is flat;
  // wind-down falls but never to nothing, because a rave at 0.95 of the night is
  // still a rave and the last twenty people are the best part of it.
  let intensity: number;
  let crowd: number;
  switch (stage) {
    case RAVE_STAGE.LOADIN:
      intensity = 0.12;
      crowd = 0.08;
      break;
    case RAVE_STAGE.DOORS: {
      const u = (t - STAGE_END[0]) / (STAGE_END[1] - STAGE_END[0]);
      intensity = 0.35 + u * 0.55;
      crowd = 0.15 + u * 0.6;
      break;
    }
    case RAVE_STAGE.PEAK:
      intensity = 1;
      crowd = 1;
      break;
    case RAVE_STAGE.WINDDOWN: {
      const u = (t - STAGE_END[2]) / (STAGE_END[3] - STAGE_END[2]);
      intensity = 1 - u * 0.45;
      crowd = 1 - u * 0.72;
      break;
    }
    default: {
      const u = (t - STAGE_END[3]) / (STAGE_END[4] - STAGE_END[3]);
      intensity = 0.2 * (1 - u);
      crowd = 0.14 * (1 - u);
      break;
    }
  }

  return {
    t,
    stage,
    intensity,
    crowd,
    playing: stage === RAVE_STAGE.DOORS || stage === RAVE_STAGE.PEAK || stage === RAVE_STAGE.WINDDOWN,
    scatter: 0,
    litter: 0,
  };
}

/** How far the scatter pushes the crowd out, metres. A minute's walk, briskly. */
const SCATTER_DISTANCE = 55;

// --- The beat -------------------------------------------------------------------

/**
 * Which beat it is, as a real number, at this venue.
 *
 * The single most important function in the file for the *feel* of the thing:
 * the sweep of every moving head, the strobe, the bounce of every dancer and the
 * bar the synthesised set is on are all this number, so a player who walks into
 * a rave sees a crowd moving **in time with what they are hearing** without any
 * of it being animated by anybody.
 *
 * Denominated from `RAVE_EPOCH_MS` and not from the night, so it does not reset
 * at dusk — and one divide from milliseconds, so the browser and the server land
 * on the same double. Fractional: `Math.floor` of it is the beat index the
 * scheduler uses, and the fraction is the phase the lights ride.
 */
export function beatAt(nowMs: number, bpm: number): number {
  return ((nowMs - RAVE_EPOCH_MS) * bpm) / 60000;
}

/** Which bar, four to the bar. The set's structure hangs off this. */
export function barAt(nowMs: number, bpm: number): number {
  return beatAt(nowMs, bpm) / 4;
}

// --- The record bag and the set list ---------------------------------------------

/**
 * One row of `client/public/audio/dj/tracks.json`. See that folder's README.
 *
 * `seconds` and `bpm` are optional and the feature is complete without either:
 * no `seconds` falls the set back onto nominal slots, and no `bpm` leaves the
 * lights on the venue's own hashed tempo. Both are written by
 * `scripts/dj-manifest.sh` when it can work them out.
 */
export interface RaveTrack {
  readonly file: string;
  readonly title: string;
  readonly bytes: number;
  readonly seconds?: number;
  readonly bpm?: number;
}

/** The whole bag, as the manifest describes it. May be empty; see `EMPTY_BAG`. */
export interface RecordBag {
  readonly tracks: readonly RaveTrack[];
  /** Sum of every duration, seconds, or 0 if any row is missing one. */
  readonly totalSeconds: number;
}

export const EMPTY_BAG: RecordBag = { tracks: [], totalSeconds: 0 };

/**
 * How long a nominal slot is when the manifest carries no durations, seconds.
 *
 * Six minutes, which is longer than any track anybody is likely to drop in and
 * therefore never truncates one — a short track simply loops back to its head
 * for the tail of its slot, which is a DJ riding an outro and is the least bad
 * thing to do without knowing where the track ends. With `seconds` present this
 * constant is never read; see `setPosition`.
 */
export const SET_SLOT_SECONDS = 360;

/** Build a bag from the parsed manifest, tolerating a row with anything missing. */
export function recordBag(rows: readonly Partial<RaveTrack>[]): RecordBag {
  const tracks: RaveTrack[] = [];
  for (const row of rows) {
    if (typeof row.file !== 'string' || row.file.length === 0) continue;
    tracks.push({
      file: row.file,
      title: typeof row.title === 'string' && row.title.length > 0 ? row.title : row.file,
      bytes: typeof row.bytes === 'number' ? row.bytes : 0,
      // A duration has to be a real, positive, finite number to be worth
      // anything; a zero would divide the set list by nothing.
      seconds: typeof row.seconds === 'number' && row.seconds > 1 ? row.seconds : undefined,
      bpm: typeof row.bpm === 'number' && row.bpm >= 60 && row.bpm <= 200 ? row.bpm : undefined,
    });
  }
  let total = 0;
  for (const t of tracks) {
    if (t.seconds === undefined) { total = 0; break; }
    total += t.seconds;
  }
  return { tracks, totalSeconds: total };
}

/**
 * The order this venue is playing the bag in tonight.
 *
 * A Fisher-Yates shuffle driven by the integer hash, so it is a genuine
 * permutation — every track once — rather than a per-slot draw, which would
 * play `Aliens` three times in a row about one night in sixteen. Two raves
 * across town on the same night get different orders because the site's id is
 * in the key; the same rave gets the same order for everybody, all night,
 * because nothing else is.
 *
 * Allocates, so it is memoised on the venue by `setPosition`'s own cache. Four
 * tracks means four swaps; this is not a hot path.
 */
export function setList(venue: RaveVenue, bag: RecordBag): readonly number[] {
  const n = bag.tracks.length;
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (let i = n - 1; i > 0; i--) {
    const j = hashInt(venue.site.id, venue.night, i, 0x61) % (i + 1);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  return order;
}

/** Where the needle is. -1 for a track index means the bag is empty. */
export interface SetPosition {
  /** Index into `bag.tracks`, or -1. */
  readonly track: number;
  /** Seconds into that track. Always inside its duration when one is known. */
  readonly offset: number;
  /** Seconds until the next record goes on. What the prefetch reads. */
  readonly remaining: number;
  /** Which track is next, for that prefetch. -1 with an empty bag. */
  readonly next: number;
}

const NO_POSITION: SetPosition = { track: -1, offset: 0, remaining: Infinity, next: -1 };

/**
 * Which record is on and how far into it, from the wall clock alone.
 *
 * ---------------------------------------------------------------------------
 * **THIS IS THE FUNCTION THAT MAKES A RAVE A SHARED PLACE.**
 *
 * A night is thirty minutes and the tracks are five to six, so a set is five or
 * six records deep and a player who arrives forty minutes in has missed most of
 * it. They must nonetheless walk into *exactly* the bar everybody already
 * standing there is dancing to — not the same track from the top, and not a
 * private playhead that started when their browser did.
 *
 * The whole thing is a modulo. The set list's durations sum to a cycle `T`; the
 * position in that cycle is `(wall seconds + a per-venue offset) mod T`; walking
 * the shuffled order until the accumulator passes it gives the track and the
 * offset into it. Nobody sends anything, nothing is stored, and two clients
 * handed the same millisecond produce the same second of the same file.
 *
 * The per-venue phase offset is the one non-obvious term. Every venue's cycle
 * has the *same* length, because it is the sum of the same four durations in a
 * different order — so without it every rave in the city would change record at
 * the same instant, which nobody would ever see but which is exactly the kind of
 * hidden correlation that turns up later as "why does the whole map do that".
 *
 * ---------------------------------------------------------------------------
 * WITHOUT DURATIONS. If any row of the manifest lacks `seconds` — an older
 * manifest, or a machine with neither `afinfo` nor `ffprobe` — the set falls
 * back to fixed `SET_SLOT_SECONDS` slots. Still shared, still a permutation,
 * still no wire traffic; the mixes simply happen on a clock rather than at the
 * ends of the records, and the audio layer loops a short track to fill its slot.
 * The offset it returns may exceed the eventual buffer's length, which is why
 * `game/audio.ts` takes it modulo the decoded duration rather than trusting it.
 */
export function setPosition(venue: RaveVenue, bag: RecordBag, nowMs: number): SetPosition {
  const n = bag.tracks.length;
  if (n === 0) return NO_POSITION;

  const order = setList(venue, bag);
  const wall = (nowMs - RAVE_EPOCH_MS) / 1000;

  if (bag.totalSeconds > 0) {
    const T = bag.totalSeconds;
    const shift = hash(venue.site.id, venue.night, 0x62) * T;
    let p = wall + shift;
    p -= Math.floor(p / T) * T;
    for (let k = 0; k < n; k++) {
      const track = order[k];
      const dur = bag.tracks[track].seconds ?? 0;
      if (p < dur) {
        return { track, offset: p, remaining: dur - p, next: order[(k + 1) % n] };
      }
      p -= dur;
    }
    // Floating-point residue at the very end of the cycle: land on the last
    // record's last instant rather than falling out of the loop with nothing.
    const track = order[n - 1];
    return { track, offset: Math.max(0, (bag.tracks[track].seconds ?? 0) - 1e-3), remaining: 1e-3, next: order[0] };
  }

  const slot = SET_SLOT_SECONDS;
  const shift = hash(venue.site.id, venue.night, 0x62) * slot * n;
  const p = wall + shift;
  const k = Math.floor(p / slot);
  const into = p - k * slot;
  const idx = ((k % n) + n) % n;
  return { track: order[idx], offset: into, remaining: slot - into, next: order[(idx + 1) % n] };
}

/**
 * What tempo the rig should be running at.
 *
 * The track's own if the person who made it put the number in the filename,
 * otherwise the venue's hashed guess. This is the difference between a light
 * show that is *near* the music and one that is *on* it, and it costs the author
 * of the track four characters — see the folder's README.
 */
export function venueBpm(venue: RaveVenue, bag: RecordBag, position: SetPosition): number {
  if (position.track >= 0) {
    const bpm = bag.tracks[position.track]?.bpm;
    if (bpm !== undefined) return bpm;
  }
  return venue.bpm;
}

/** What the decks say. The manifest's own title, or the empty-bag line. */
export function deckTitle(bag: RecordBag, position: SetPosition): string {
  if (position.track < 0) return NO_RECORD_BAG;
  return bag.tracks[position.track]?.title ?? NO_RECORD_BAG;
}

/**
 * What the decks read with nothing in the folder.
 *
 * Stated once, here, because three things display it — the booth banner, the
 * HUD line and the big map — and a feature whose empty case says three different
 * things is a feature whose empty case nobody tested.
 */
export const NO_RECORD_BAG = 'no record bag';

// --- Where everybody is standing -------------------------------------------------

/**
 * One attendee's place on the ground, written into a caller-owned record.
 *
 * Allocates nothing; `world/rave.ts` calls it up to `ATTENDEE_CAP` times a frame
 * for each drawn venue.
 */
export interface AttendeePose {
  x: number;
  z: number;
  /** Which way they are facing, as a unit vector. Mostly toward the booth. */
  dx: number;
  dz: number;
  /** 0 at the back, 1 hard against the barrier. Decides how hard they dance. */
  front: number;
  /** Which of the seven kits, and which glow colour. */
  kit: number;
  glow: number;
  /** A per-person phase so a crowd is not one animation. */
  phase: number;
}

export function createAttendeePose(): AttendeePose {
  return { x: 0, z: 0, dx: 0, dz: 1, front: 0, kit: 0, glow: 0, phase: 0 };
}

/**
 * Where the booth is, relative to the centre. Written into `out`.
 *
 * Behind the crowd on the bearing, which is what makes the layout read: you
 * arrive at the back of a crowd that is facing away from you, and the thing they
 * are facing is the thing you have to walk through them to see. The alternative
 * — the rig in the middle — is a stage, and a stage is a festival.
 */
export function boothPosition(venue: RaveVenue, out: { x: number; z: number }): void {
  const s = Math.sin(venue.bearing);
  const c = Math.cos(venue.bearing);
  out.x = venue.site.x - s * venue.depth;
  out.z = venue.site.z - c * venue.depth;
}

/**
 * Place attendee `i`, or return false if there is nowhere to put them.
 *
 * ---------------------------------------------------------------------------
 * THE SHAPE OF A CROWD, WHICH IS NOT A DISC.
 *
 * A crowd at a sound system is a **wedge that thins with distance**: packed
 * against the front, spreading and loosening backward, with people at the edges
 * who came to talk rather than to dance. So the radial coordinate is
 * `u^CROWD_PACK` over the depth — an exponent below 1 pulls the distribution
 * toward the front — and the angular spread *widens* with distance, which is
 * what turns a sector into a wedge.
 *
 * `front` falls out of the radial coordinate and is the number everything about
 * behaviour reads: how hard somebody dances, how bright their glow is, and
 * whether they are one of the eight who get a skeleton.
 *
 * ---------------------------------------------------------------------------
 * BUILDINGS, AND WHY THE REJECTION IS BOUNDED AT FOUR.
 *
 * A yard's inscribed circle is guaranteed clear of the parcel's boundary and
 * says nothing about the shipping container standing in the middle of it, and a
 * park's disc says nothing about the pavilion. So each attendee is offered four
 * hashed positions and takes the first that is not inside something; if all four
 * fail they are simply not there, and the crowd is that many people smaller.
 *
 * Four rather than "until it works" because this runs `ATTENDEE_CAP` times a
 * frame and an unbounded loop over a site that is genuinely full — a rave under
 * a viaduct whose piers are in the middle of it — is an unbounded loop in the
 * frame. Four is enough that a partially obstructed site loses a handful of
 * people rather than most of them, and the failure is graceful in the direction
 * that matters: a thinner crowd, never a person inside a wall.
 *
 * `solid` is the caller's — `main.ts` already has one over the collision world —
 * and may be null, which is what the server-side check uses to test the layout
 * arithmetic without a world.
 */
export type RaveSolid = ((x: number, y: number, z: number) => boolean) | null;

/**
 * How hard the crowd packs toward the front, as the exponent on the radial
 * coordinate. Above 0.5 — which is the uniform-over-area value — pulls it
 * forward.
 *
 * **5/8 exactly**, and the eighth is not a rounding of a taste decision: it is
 * what makes the curve computable in operations that are specified to the last
 * bit in every engine. `u**0.625` is `sqrt(sqrt(sqrt(u*u*u*u*u)))` — four
 * multiplies and three square roots, all IEEE-exact — where `Math.pow(u, 0.62)`
 * is a library call two engines are not required to agree about, on a value that
 * decides where a person is standing. See section 1 of the header.
 */
const CROWD_PACK = 0.625;
/** Angular half-spread at the barrier and at the back, radians. */
const CROWD_SPREAD_FRONT = 0.55;
const CROWD_SPREAD_BACK = 1.35;
/** How many places an attendee is offered before giving up. See the header. */
const CROWD_TRIES = 4;

export function attendeeAt(
  venue: RaveVenue,
  i: number,
  groundY: number,
  scatter: number,
  solid: RaveSolid,
  out: AttendeePose,
): boolean {
  const id = venue.site.id;
  const night = venue.night;
  const u = hash(id, night, i, 0x01);
  const v = hash(id, night, i, 0x02);

  // Radial, front-loaded. `Math.pow` is a transcendental and this is the one
  // place it would be on a hot path, so the exponent is expressed as a product
  // of a square root and a cube root of the same value -- which for 0.62 is
  // within 1.5% over the whole range and is four multiplies. Exactness is not
  // required here: it is the *same* approximation on every client, which is all
  // determinism asks.
  const packed = packCurve(u);
  const spread = CROWD_SPREAD_FRONT + packed * (CROWD_SPREAD_BACK - CROWD_SPREAD_FRONT);
  const angle = venue.bearing + (v - 0.5) * 2 * spread;
  const s = Math.sin(angle);
  const c = Math.cos(angle);

  out.front = 1 - packed;
  out.kit = ((hashInt(id, night, i, 0x03) % 7) + 7) % 7;
  out.glow = hashInt(id, night, i, 0x04) % GLOW_COLOUR_COUNT;
  out.phase = hash(id, night, i, 0x05);

  // The base radius: from the barrier out to the back of the wedge, plus
  // whatever the scatter has pushed everybody by.
  const base = CROWD_FRONT_GAP + packed * (venue.depth - CROWD_FRONT_GAP) + scatter;

  for (let attempt = 0; attempt < CROWD_TRIES; attempt++) {
    // A hashed jitter per attempt rather than a fixed step, so a rejected
    // attendee is offered a genuinely different place rather than being nudged
    // one metre into the same container.
    const jr = (hash(id, night, i, 0x10 + attempt) - 0.5) * 7;
    const ja = (hash(id, night, i, 0x20 + attempt) - 0.5) * 0.5;
    const r = Math.max(1.5, base + jr);
    const ax = venue.site.x - s * venue.depth + (s * Math.cos(ja) + c * Math.sin(ja)) * r;
    const az = venue.site.z - c * venue.depth + (c * Math.cos(ja) - s * Math.sin(ja)) * r;
    // Chest height rather than the feet: a body standing on a kerb is not inside
    // it, and `main.ts`'s solid test is a roof query that answers about the
    // volume above the asker.
    if (solid !== null && solid(ax, groundY + 1.1, az)) continue;
    out.x = ax;
    out.z = az;
    // Facing the booth, which is at the centre minus `depth` along the bearing.
    const bx = venue.site.x - s * venue.depth;
    const bz = venue.site.z - c * venue.depth;
    const fx = bx - ax;
    const fz = bz - az;
    const len = Math.hypot(fx, fz);
    if (len > 1e-4) {
      out.dx = fx / len;
      out.dz = fz / len;
    } else {
      out.dx = -s;
      out.dz = -c;
    }
    // ...except the ones at the edge, who are talking to each other. A sixth of
    // the crowd, hashed, turned by up to a right angle. Nothing sells a crowd
    // like the people in it not all facing the same way.
    if (out.front < 0.45 && hash(id, night, i, 0x06) < 0.34) {
      const turn = (hash(id, night, i, 0x07) - 0.5) * 2.4;
      const ts = Math.sin(turn);
      const tc = Math.cos(turn);
      const ndx = out.dx * tc - out.dz * ts;
      const ndz = out.dx * ts + out.dz * tc;
      out.dx = ndx;
      out.dz = ndz;
    }
    return true;
  }
  return false;
}

/** Metres of clear ground between the booth and the first row. The barrier. */
const CROWD_FRONT_GAP = 4.5;

/** How many glow colours an attendee can be wearing. See `world/rave.ts`. */
export const GLOW_COLOUR_COUNT = 6;

/**
 * `u ** 0.625`, in operations two engines are required to agree about.
 *
 * `u^5` is four multiplies and `^(1/8)` is three square roots, and IEEE-754
 * specifies both exactly — where `Math.pow` is a library routine V8 and
 * JavaScriptCore are free to implement differently in the last few bits. That
 * difference would be sub-millimetre on one attendee and would still mean two
 * players standing in the same crowd were looking at two different crowds, which
 * is precisely the failure this whole file exists to make impossible.
 */
function packCurve(u: number): number {
  const u5 = u * u * u * u * u;
  return Math.sqrt(Math.sqrt(Math.sqrt(u5)));
}

/**
 * The vertical bounce of one dancer, metres, and their sway, radians.
 *
 * **The only `Math.sin` in this file**, and it is presentation: it moves a head
 * by four centimetres and is never compared between two machines. Section 1
 * states the split; this is the other side of it.
 *
 * Two components, because a crowd bouncing in unison is a chorus line. The beat
 * term is shared -- that is the point, everyone is on the same beat -- and the
 * personal term is at 0.41 of it, an irrational-ish ratio that never lines back
 * up, so the crowd breathes rather than pulses.
 */
export function danceBob(beat: number, pose: AttendeePose): number {
  const own = pose.phase * Math.PI * 2;
  const hard = 0.35 + pose.front * 0.65;
  return (
    Math.max(0, Math.sin(beat * Math.PI * 2 - own)) * 0.11 * hard +
    Math.sin(beat * Math.PI * 0.82 + own * 2) * 0.02
  );
}

// --- Self-check -------------------------------------------------------------------

/** The sky's numbers, for the cross-check in section 6. */
export interface RaveClockContract {
  cycleMs: number;
  nightShare: number;
}

/**
 * What breaks here in a way that renders perfectly.
 *
 * Every failure this feature has is silent. A site draw that is not a pure
 * function of the night gives every player their own rave, which from inside one
 * browser looks exactly right — you would only ever find it by standing two
 * people in the same yard, which is the thing nobody does while developing. A
 * beat clock that disagrees between the browser and the server is a crowd
 * dancing to a track it is not hearing, and it looks like a tuning problem. A
 * crowd layout that puts people inside the shipping container in the middle of
 * the yard is forty bodies in a wall, which from the one angle a screenshot is
 * taken from is forty bodies. A track selection that is not shared is the whole
 * feature quietly not being the feature.
 *
 * So: **the draw is run twice and compared**, the beat clock is compared against
 * an independent evaluation, the layout is run against a synthetic obstacle and
 * every survivor is checked to be inside the site and outside the obstacle, and
 * the zero-track path is asserted to be the one the game boots with.
 *
 * `clock` is the sky's own cycle, handed in rather than imported — see section 6.
 */
export function verifyRaves(clock?: RaveClockContract): string[] {
  const failures: string[] = [];

  // --- The tables.
  if (RAVE_SITES.length < 300) {
    failures.push(`Only ${RAVE_SITES.length} rave sites were baked; the three blocks should total over 400.`);
  }
  const kinds = [0, 0, 0];
  for (const site of RAVE_SITES) {
    kinds[site.kind]++;
    if (Math.hypot(site.x, site.z) > RAVE_EXTENT_M) {
      failures.push(
        `Site ${site.id} (${site.name}) is at ${Math.hypot(site.x, site.z).toFixed(0)} m, outside the ` +
          `${RAVE_EXTENT_M} m built extent; its crowd would stand on tiles that do not exist.`,
      );
      break;
    }
    if (!(site.r >= SITE_MIN_R) || !(site.r <= SITE_MAX_R)) {
      failures.push(`Site ${site.id} (${site.name}) has a usable radius of ${site.r}, outside [${SITE_MIN_R}, ${SITE_MAX_R}].`);
      break;
    }
    if (site.kind === SITE_KIND.SPAN && Number.isNaN(site.bearing)) {
      failures.push(`Span site ${site.id} (${site.name}) has no bearing; a rave under a viaduct must run along it.`);
      break;
    }
    if (site.kind !== SITE_KIND.SPAN && !Number.isNaN(site.bearing)) {
      failures.push(`Site ${site.id} (${site.name}) carries a fixed bearing but is not a span.`);
      break;
    }
  }
  if (kinds[SITE_KIND.YARD] < 50) failures.push(`Only ${kinds[SITE_KIND.YARD]} warehouse yards survived the bake.`);
  if (kinds[SITE_KIND.SPAN] < 30) failures.push(`Only ${kinds[SITE_KIND.SPAN]} under-bridge sites survived the bake.`);
  if (kinds[SITE_KIND.PARK] < 100) failures.push(`Only ${kinds[SITE_KIND.PARK]} park sites survived the bake.`);

  // --- Sydney Park, which the user asked for by name and which is the one site
  // in the table whose absence would be invisible: the feature would work, near
  // the spawn, with a rave in the yard down the road, and the thing the brief
  // actually asked for would simply never happen.
  if (SYDNEY_PARK_SITE < 0) {
    failures.push('Sydney Park is not in the site table; the brief names it and the spawn is 32 m from its centre.');
  } else {
    const sp = RAVE_SITES[SYDNEY_PARK_SITE];
    const d = Math.hypot(sp.x - SPAWN_TARGET.x, sp.z - SPAWN_TARGET.z);
    if (d > 200) failures.push(`The Sydney Park site is ${d.toFixed(0)} m from the spawn pin; it should be within sight of it.`);
  }
  if (HOME_SITES.length < 5) {
    failures.push(
      `Only ${HOME_SITES.length} sites are inside HOME_RADIUS of the spawn, so the home rave would be the same ` +
        'place most nights.',
    );
  }

  // --- Determinism. The draw, run twice, over a long stretch of nights, with
  // the cache deliberately not involved.
  {
    let live = 0;
    let nightsWithHome = 0;
    let sydneyParkNights = 0;
    let differing = 0;
    const NIGHTS = 600;
    for (let n = 0; n < NIGHTS; n++) {
      const a = drawRaves(n);
      const b = drawRaves(n);
      if (a.length !== b.length) { differing++; continue; }
      for (let i = 0; i < a.length; i++) {
        if (
          a[i].site.id !== b[i].site.id ||
          a[i].bpm !== b[i].bpm ||
          a[i].attendees !== b[i].attendees ||
          a[i].bearing !== b[i].bearing ||
          a[i].palette !== b[i].palette ||
          a[i].bust !== b[i].bust
        ) { differing++; break; }
      }
      live += a.length;
      if (a.some((v) => HOME_SITES.includes(v.site.id))) nightsWithHome++;
      if (a.some((v) => v.site.id === SYDNEY_PARK_SITE)) sydneyParkNights++;
      if (a.length > MAX_LIVE) {
        failures.push(`Night ${n} drew ${a.length} raves, past the cap of ${MAX_LIVE}.`);
        break;
      }
    }
    if (differing > 0) {
      failures.push(`${differing} of ${NIGHTS} nights drew a different set on a second evaluation; the draw is not pure.`);
    }
    const mean = live / NIGHTS;
    if (mean < 2.5 || mean > MAX_LIVE) {
      failures.push(`The mean night has ${mean.toFixed(2)} raves in the whole city, outside the 2.5-${MAX_LIVE} band the design asks for.`);
    }
    if (nightsWithHome < NIGHTS) {
      failures.push(`${NIGHTS - nightsWithHome} of ${NIGHTS} nights had no rave within walking distance of the spawn; the home draw is unconditional.`);
    }
    const spShare = sydneyParkNights / NIGHTS;
    if (Math.abs(spShare - SYDNEY_PARK_SHARE) > 0.12) {
      failures.push(
        `Sydney Park was live on ${(spShare * 100).toFixed(0)}% of nights against a target of ` +
          `${(SYDNEY_PARK_SHARE * 100).toFixed(0)}%; the fixture hash has clumped.`,
      );
    }
  }

  // --- The night's shape: monotone where it should be, and the stages actually
  // reachable. A stage table that skipped `LOADIN` would still render a rave.
  {
    // An *unwatched* site, deliberately: a rave the police know about never
    // reaches its own wind-down, so running the envelope on a watched one would
    // report a hole in the curve that is really the bust doing its job.
    const openSite = RAVE_SITES.find((s) => !s.watched) ?? RAVE_SITES[0];
    const venue = venueFor(openSite, 12);
    const seen = new Set<RaveStage>();
    let lastLitter = 0;
    for (let k = 0; k <= 400; k++) {
      const phase = k / 400;
      const at = nightStartMs(12) + phase * RAVE_CYCLE_MS;
      const st = raveState(venue, at);
      seen.add(st.stage);
      if (st.intensity < 0 || st.intensity > 1) failures.push(`Rave intensity left [0, 1] at phase ${phase.toFixed(3)} (${st.intensity}).`);
      if (st.crowd < 0 || st.crowd > 1) failures.push(`Rave crowd share left [0, 1] at phase ${phase.toFixed(3)} (${st.crowd}).`);
      if (st.playing && st.intensity <= 0) failures.push(`The music is playing with the rig dark at phase ${phase.toFixed(3)}.`);
      lastLitter = st.litter;
    }
    if (lastLitter > 0.001) failures.push(`There is still ${lastLitter.toFixed(2)} of litter on the ground at the next dusk.`);
    for (const [stage, name] of [
      [RAVE_STAGE.LOADIN, 'load-in'], [RAVE_STAGE.DOORS, 'doors'], [RAVE_STAGE.PEAK, 'peak'],
      [RAVE_STAGE.WINDDOWN, 'wind-down'], [RAVE_STAGE.PACKUP, 'pack-up'], [RAVE_STAGE.GONE, 'the morning after'],
    ] as const) {
      if (!seen.has(stage)) failures.push(`A whole night never reached the ${name} stage; the envelope has a hole in it.`);
    }
    // And the bust, on a site that is watched.
    const watched = RAVE_SITES.find((s) => s.watched);
    if (!watched) failures.push('No site in the table is within earshot of a police station; nothing would ever be busted.');
    else {
      const w = venueFor(watched, 12);
      if (!(w.bust > 0.3 && w.bust < 0.9)) failures.push(`A watched site's bust lands at ${w.bust.toFixed(2)} of the night, outside the middle two thirds.`);
      const at = nightStartMs(12) + (w.bust + 0.005) * RAVE_NIGHT_SHARE * RAVE_CYCLE_MS;
      const st = raveState(w, at);
      if (st.stage !== RAVE_STAGE.BUSTED) failures.push(`A watched rave is in stage ${st.stage} just after its bust time rather than BUSTED.`);
      if (st.playing) failures.push('The music is still playing after the police arrived.');
    }
    const openAir = RAVE_SITES.find((s) => !s.watched);
    if (openAir && bustAt(openAir, 12) !== 1) failures.push('An unwatched site was given a bust time; only a known rave gets shut down.');
  }

  // --- The beat, against an independent evaluation. This is the one that
  // catches a clock that resets at dusk, which would look perfect from inside
  // one session and would put two players a bar apart.
  {
    const bpm = 128;
    const t0 = RAVE_EPOCH_MS + 3600_000 * 7 + 1234;
    const a = beatAt(t0, bpm);
    const b = ((t0 - RAVE_EPOCH_MS) / 1000 / 60) * bpm;
    if (Math.abs(a - b) > 1e-9) failures.push(`beatAt disagrees with minutes*bpm by ${Math.abs(a - b)}.`);
    if (Math.abs(beatAt(t0 + 60000, bpm) - a - bpm) > 1e-6) failures.push('A minute of wall time is not bpm beats.');
    if (Math.abs(barAt(t0, bpm) * 4 - a) > 1e-9) failures.push('barAt is not beatAt over four.');
    // And it must not restart at dusk.
    const dusk = RAVE_EPOCH_MS + 8 * RAVE_CYCLE_MS;
    if (Math.abs(beatAt(dusk, bpm) - beatAt(dusk - 1, bpm) - bpm / 60000) > 1e-6) {
      failures.push('The beat clock steps at dusk; it is denominated from the epoch, not from the night.');
    }
  }

  // --- The record bag, both ways round.
  //
  // The zero-track path is the one a fresh clone boots with, so it is the one
  // that has to be right first; and the timed path is the one that decides
  // whether two people standing in the same crowd are hearing the same bar,
  // which is the single claim this feature makes that a screenshot cannot check.
  {
    const venue = venueFor(RAVE_SITES[0], 5);

    // --- Empty.
    const empty = recordBag([]);
    if (empty.tracks.length !== 0 || empty.totalSeconds !== 0) failures.push('An empty manifest did not produce an empty bag.');
    const nowhere = setPosition(venue, empty, RAVE_EPOCH_MS + 1000);
    if (nowhere.track !== -1) failures.push('An empty record bag put a record on the decks.');
    if (deckTitle(empty, nowhere) !== NO_RECORD_BAG) failures.push(`The empty decks read "${deckTitle(empty, nowhere)}" rather than "${NO_RECORD_BAG}".`);
    if (venueBpm(venue, empty, nowhere) !== venue.bpm) failures.push('An empty bag did not fall back to the venue tempo.');

    // --- A malformed manifest must not take the boot down: a row with no file
    // is dropped, a zero duration is treated as unknown rather than as a
    // divide-by-nothing, and a nonsense tempo is ignored.
    const messy = recordBag([
      { file: 'a.mp3', title: 'A', bytes: 1, seconds: 200, bpm: 128 },
      { title: 'no file', bytes: 2 },
      { file: 'b.mp3', title: '', bytes: 3, seconds: 0, bpm: 9000 },
    ]);
    if (messy.tracks.length !== 2) failures.push(`A manifest with a fileless row produced ${messy.tracks.length} tracks rather than 2.`);
    if (messy.totalSeconds !== 0) failures.push('A bag with one unmeasured track claimed a total duration.');
    if (messy.tracks[1].title !== 'b.mp3') failures.push('A row with no title did not fall back to its filename.');
    if (messy.tracks[1].bpm !== undefined) failures.push('A 9000 BPM row was not rejected.');

    // --- The real shape: four tracks, five to six minutes, as the folder holds.
    const bag = recordBag([
      { file: 'Aliens.mp3', title: 'Aliens', bytes: 6572131, seconds: 344.555 },
      { file: 'Karmel.mp3', title: 'Karmel', bytes: 5727110, seconds: 310.674 },
      { file: 'Organism.mp3', title: 'Organism', bytes: 5994258, seconds: 357.538 },
      { file: 'Tanktastic.mp3', title: 'Tanktastic', bytes: 8040303, seconds: 328.359 },
    ]);
    if (Math.abs(bag.totalSeconds - 1341.126) > 1e-3) failures.push(`The bag's cycle is ${bag.totalSeconds} s rather than the sum of its four tracks.`);

    // The set list is a permutation, not a draw. A per-slot pick would play the
    // same record twice in a row about one night in sixteen, which is the tell
    // that nobody wrote a set list.
    for (let n = 0; n < 200; n++) {
      const order = setList(venueFor(RAVE_SITES[n % RAVE_SITES.length], n), bag);
      if (order.length !== 4 || new Set(order).size !== 4) {
        failures.push(`Night ${n}'s set list is ${order.join(',')}, which is not a permutation of the bag.`);
        break;
      }
    }

    // Walk a whole night at 5-second steps: the position must be pure, must
    // stay inside the record that is on, must reach every track, and must never
    // jump backwards inside one.
    {
      const v = venueFor(RAVE_SITES[0], 77);
      const seen = new Set<number>();
      let lastTrack = -2;
      let lastOffset = 0;
      let lastNext = -1;
      let impure = 0;
      let outside = 0;
      let backwards = 0;
      let mixes = 0;
      const start = nightStartMs(77);
      for (let s = 0; s <= 1800; s += 5) {
        const at = start + s * 1000;
        const p = setPosition(v, bag, at);
        const again = setPosition(v, bag, at);
        if (p.track !== again.track || p.offset !== again.offset) impure++;
        const dur = bag.tracks[p.track].seconds ?? 0;
        if (p.offset < 0 || p.offset > dur) outside++;
        if (Math.abs(p.remaining - (dur - p.offset)) > 1e-6) failures.push('`remaining` is not the time left in the record on the decks.');
        seen.add(p.track);
        if (p.track === lastTrack && p.offset < lastOffset - 1e-6) backwards++;
        if (p.track !== lastTrack && lastTrack !== -2) {
          mixes++;
          // The mix lands on the head of the next record, not somewhere in it.
          if (p.offset > 5.001) failures.push(`A mix dropped in ${p.offset.toFixed(1)} s into the next record rather than at its head.`);
          if (p.track !== lastNext) failures.push('The record that came on was not the one `next` promised, so the prefetch would fetch the wrong file.');
        }
        lastTrack = p.track;
        lastOffset = p.offset;
        lastNext = p.next;
      }
      if (impure > 0) failures.push(`${impure} set-position lookups answered differently on a second evaluation.`);
      if (outside > 0) failures.push(`${outside} set positions were outside the record they claimed to be playing.`);
      if (backwards > 0) failures.push(`${backwards} set positions ran backwards inside one record.`);
      if (seen.size < 3) failures.push(`Only ${seen.size} of 4 records were played across a 30-minute night; the set is too shallow.`);
      if (mixes < 2) failures.push(`Only ${mixes} mixes happened in a 30-minute night of 5-6 minute records.`);
    }

    // Two clients, two arrival times, one bar. This is the claim.
    {
      const v = venueFor(RAVE_SITES[9], 401);
      const at = nightStartMs(401) + 41 * 60_000 + 12_345;
      const early = setPosition(v, bag, at);
      const late = setPosition(v, bag, at);
      if (early.track !== late.track || Math.abs(early.offset - late.offset) > 1e-9) {
        failures.push('Two evaluations of the same instant put the needle in two different places.');
      }
      // And a second later is a second further in, not a second into something else.
      const then = setPosition(v, bag, at + 1000);
      if (then.track === early.track && Math.abs(then.offset - early.offset - 1) > 1e-6) {
        failures.push(`A second of wall time advanced the needle by ${(then.offset - early.offset).toFixed(4)} s.`);
      }
    }

    // Two raves across town are not in lockstep. Every venue's cycle is the same
    // length, so without the per-venue phase they would all mix together.
    {
      let together = 0;
      for (let n = 0; n < 200; n++) {
        const at = nightStartMs(n) + 600_000;
        const a = setPosition(venueFor(RAVE_SITES[0], n), bag, at);
        const b = setPosition(venueFor(RAVE_SITES[1], n), bag, at);
        if (a.track === b.track && Math.abs(a.offset - b.offset) < 1) together++;
      }
      if (together > 8) failures.push(`Two sites were on the same record at the same second on ${together} of 200 nights; the per-venue phase is not doing anything.`);
    }

    // The tempo comes off the track when the track states one.
    {
      const tagged = recordBag([{ file: 'k.mp3', title: 'K', bytes: 1, seconds: 300, bpm: 132 }]);
      const p = setPosition(venue, tagged, RAVE_EPOCH_MS + 10_000);
      if (venueBpm(venue, tagged, p) !== 132) failures.push('A track that states its BPM did not drive the rig.');
      if (deckTitle(tagged, p) !== 'K') failures.push('The decks did not show the manifest title.');
    }

    // --- And the fallback, which is what a manifest with no durations gets.
    {
      const blind = recordBag([
        { file: 'a.mp3', title: 'A', bytes: 1 },
        { file: 'b.mp3', title: 'B', bytes: 1 },
        { file: 'c.mp3', title: 'C', bytes: 1 },
      ]);
      if (blind.totalSeconds !== 0) failures.push('A bag with no measured durations claimed one.');
      const v = venueFor(RAVE_SITES[3], 5);
      const seen = new Set<number>();
      let lastTrack = -2;
      let outside = 0;
      for (let s = 0; s <= 1800; s += 5) {
        const p = setPosition(v, blind, nightStartMs(5) + s * 1000);
        if (p.track < 0 || p.track >= 3) { failures.push(`The slot fallback picked track ${p.track} of 3.`); break; }
        if (p.offset < 0 || p.offset > SET_SLOT_SECONDS) outside++;
        if (p.track !== lastTrack && lastTrack !== -2 && p.offset > 5.001) {
          failures.push('The slot fallback dropped in mid-record rather than at a slot boundary.');
        }
        seen.add(p.track);
        lastTrack = p.track;
      }
      if (outside > 0) failures.push(`${outside} slot-fallback offsets fell outside a ${SET_SLOT_SECONDS} s slot.`);
      if (seen.size < 2) failures.push('The slot fallback never changed record across a whole night.');
    }
  }

  // --- The crowd. Inside the site, out of the obstacle, and the same twice.
  {
    const venue = venueFor(RAVE_SITES[SYDNEY_PARK_SITE >= 0 ? SYDNEY_PARK_SITE : 0], 21);
    // A 9 m shipping container standing on the site's own centre: the exact
    // thing an inscribed circle cannot know about.
    const solid: RaveSolid = (x, _y, z) =>
      Math.abs(x - venue.site.x) < 4.5 && Math.abs(z - venue.site.z) < 4.5;
    const a = createAttendeePose();
    const b = createAttendeePose();
    let placed = 0;
    let inside = 0;
    let outOfBounds = 0;
    for (let i = 0; i < venue.attendees; i++) {
      const okA = attendeeAt(venue, i, 0, 0, solid, a);
      const okB = attendeeAt(venue, i, 0, 0, solid, b);
      if (okA !== okB) { failures.push(`Attendee ${i} was placed on one evaluation and not the other.`); break; }
      if (!okA) continue;
      if (a.x !== b.x || a.z !== b.z || a.kit !== b.kit || a.glow !== b.glow) {
        failures.push(`Attendee ${i} landed in two different places on two evaluations; the layout is not pure.`);
        break;
      }
      placed++;
      if (solid(a.x, 1.1, a.z)) inside++;
      // Inside the site's own clear circle, with a metre of slack for the jitter.
      if (Math.hypot(a.x - venue.site.x, a.z - venue.site.z) > venue.site.r + 8) outOfBounds++;
      if (Math.abs(Math.hypot(a.dx, a.dz) - 1) > 1e-6) { failures.push(`Attendee ${i}'s facing is not a unit vector.`); break; }
      if (a.front < 0 || a.front > 1) { failures.push(`Attendee ${i}'s front-of-crowd fraction is ${a.front}.`); break; }
      if (a.kit < 0 || a.kit > 6) { failures.push(`Attendee ${i} wears kit ${a.kit}, outside the seven the rig has.`); break; }
      if (a.glow < 0 || a.glow >= GLOW_COLOUR_COUNT) { failures.push(`Attendee ${i}'s glow colour is ${a.glow}.`); break; }
    }
    if (inside > 0) failures.push(`${inside} of ${placed} attendees were placed inside the obstacle; the rejection does not reject.`);
    if (outOfBounds > 0) failures.push(`${outOfBounds} of ${placed} attendees stood outside the site's clear circle.`);
    if (placed < venue.attendees * 0.55) {
      failures.push(`Only ${placed} of ${venue.attendees} attendees found a place around one 9 m obstacle; the rejection is too eager.`);
    }
    // With nothing in the way, everybody gets in.
    let free = 0;
    for (let i = 0; i < venue.attendees; i++) if (attendeeAt(venue, i, 0, 0, null, a)) free++;
    if (free !== venue.attendees) failures.push(`${venue.attendees - free} attendees could not be placed on an empty site.`);
    // The wedge is a wedge: the front third must be nearer the booth than the back third.
    const booth = { x: 0, z: 0 };
    boothPosition(venue, booth);
    let frontD = 0, frontN = 0, backD = 0, backN = 0;
    for (let i = 0; i < venue.attendees; i++) {
      if (!attendeeAt(venue, i, 0, 0, null, a)) continue;
      const d = Math.hypot(a.x - booth.x, a.z - booth.z);
      if (a.front > 0.66) { frontD += d; frontN++; } else if (a.front < 0.33) { backD += d; backN++; }
    }
    if (frontN > 0 && backN > 0 && frontD / frontN >= backD / backN) {
      failures.push('The front of the crowd is not nearer the booth than the back; the wedge is inside out.');
    }
    // And the scatter goes outward.
    attendeeAt(venue, 0, 0, 0, null, a);
    attendeeAt(venue, 0, 0, 40, null, b);
    if (Math.hypot(b.x - booth.x, b.z - booth.z) <= Math.hypot(a.x - booth.x, a.z - booth.z)) {
      failures.push('The scatter did not move the crowd away from the booth.');
    }
  }

  // --- The pack curve, since it is an approximation and approximations rot.
  {
    let worst = 0;
    for (let k = 0; k <= 100; k++) {
      const u = k / 100;
      worst = Math.max(worst, Math.abs(packCurve(u) - Math.pow(u, CROWD_PACK)));
    }
    if (worst > 1e-12) failures.push(`packCurve is ${worst.toExponential(2)} away from u**${CROWD_PACK} at its worst; the crowd's density has drifted.`);
    if (packCurve(0) !== 0 || Math.abs(packCurve(1) - 1) > 1e-9) failures.push('packCurve does not span [0, 1].');
  }

  // --- And the clock, against the sky's own solar solve. See section 6.
  //
  // This is the check with teeth. A quarter-turn rotation applied the wrong way
  // is a rave that runs from sunrise to sunset with the litter on the ground all
  // night, and it is completely invisible from inside this file: every function
  // above would still be pure, still be shared, still agree with itself.
  // Measuring the actual darkness at the times this file claims are night and
  // day is the only thing that can catch it.
  {
    const night = 4_000;
    const base = nightStartMs(night);
    const darkAt = base + RAVE_NIGHT_SHARE * 0.5 * RAVE_CYCLE_MS;
    const lightAt = base + (RAVE_NIGHT_SHARE + (1 - RAVE_NIGHT_SHARE) * 0.5) * RAVE_CYCLE_MS;

    const midnight = skyClock(darkAt);
    const noon = skyClock(lightAt);
    if (midnight.night < 0.999) {
      failures.push(
        `The middle of a rave's night is only ${midnight.night.toFixed(3)} dark (sun at ` +
          `${midnight.solar.altitude.toFixed(1)} deg, ${midnight.label}); the rave clock is not rotated onto ` +
          "the sky's night.",
      );
    }
    if (noon.night > 0.001) {
      failures.push(
        `The middle of a rave's morning-after is ${noon.night.toFixed(3)} dark (${noon.label}); the litter ` +
          'would be on the ground while the party was on.',
      );
    }
    // And the two edges are the two horizons, to within the ramp's own width.
    const dusk = skyClock(base);
    const dawn = skyClock(base + RAVE_NIGHT_SHARE * RAVE_CYCLE_MS);
    if (Math.abs(dusk.solar.altitude) > 1.5) failures.push(`Rave phase 0 has the sun ${dusk.solar.altitude.toFixed(2)} deg from the horizon; it should be sunset.`);
    if (Math.abs(dawn.solar.altitude) > 1.5) failures.push(`Rave phase ${RAVE_NIGHT_SHARE} has the sun ${dawn.solar.altitude.toFixed(2)} deg from the horizon; it should be sunrise.`);
    if (dusk.isDay) failures.push('Rave phase 0 is in daylight.');
    if (!skyClock(base + 0.02 * RAVE_CYCLE_MS).isDay === false) {
      failures.push('The sun is still up a fiftieth of a cycle after the rave clock says dusk.');
    }
  }

  // --- And the caller's own restatement, where it has one. Belt to the brace.
  if (clock) {
    if (clock.cycleMs !== RAVE_CYCLE_MS) {
      failures.push(`The caller says the cycle is ${clock.cycleMs} ms and sky/cycle.ts says ${RAVE_CYCLE_MS}.`);
    }
    if (Math.abs(clock.nightShare - RAVE_NIGHT_SHARE) > 1e-6) {
      failures.push(`The caller says ${clock.nightShare} of the cycle is dark and this file derives ${RAVE_NIGHT_SHARE}.`);
    }
  }

  return failures;
}
