/**
 * The handful of stations whose real layout the procedural rule cannot reach.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHY IT IS NINE ENTRIES AND NOT TWO HUNDRED.
 *
 * `world/track-atlas.ts` decides how much of a corridor a track may build in,
 * and `platform-spine.platformSlots` turns that into a platform or into nothing.
 * That rule is right, and where it says *no room* it is usually telling the
 * truth: two running lines four metres apart cannot have a platform between them
 * and drawing one is how the owner ended up riding through slabs.
 *
 * It is wrong in one specific way. At a big interchange the bake's stopping
 * anchor sits on a **through road**, with the platforms on roads either side of
 * it, and the slot rule -- which asks only about the anchored road's own two
 * sides -- answers *no room* at a station that plainly has platforms. Measured
 * after the slot landed: 25 of 361 sites lost both sides, and five station
 * *names* lost every platform they had. Hornsby is one of them, and Hornsby is
 * where the owner's end-to-end ride finishes.
 *
 * So the fallback is not to relax the rule -- that would put the slabs back
 * everywhere -- but to say, for these few, *a platform is really here*, and let
 * the geometry build the widest one the gauge permits. `RAIL-CORRIDOR.md`:
 *
 *   > If a real schematic says a platform exists where the bake's track spacing
 *   > cannot legally hold one, prefer a narrower-than-standard deck over
 *   > nothing, floored at the width the gauge allows -- a thin platform is
 *   > honest, an absent one at Hornsby is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN AN ENTRY, AND WHAT DELIBERATELY IS NOT.
 *
 * **Facts, with a source, and nothing that looks like a drawing.** Each entry
 * carries the platform count and the island/side split, because those are things
 * a published schematic states and a reader can check. What no entry carries is
 * a *position*: not a coordinate, not an offset, not a length. Positions come
 * from the bake, which is georeferenced, and a hand-typed offset would be a
 * guess wearing the same clothes as a measurement -- exactly the failure
 * `STATIONS.md` records about accepting a CAD fit without rendering it.
 *
 * `faces` and `arrangement` are therefore **documentation and a cross-check**;
 * `insist` is the only field the geometry acts on. That is a deliberately small
 * lever. It says "build here", not "build it like this".
 *
 * ---------------------------------------------------------------------------
 * **Three-free.** `riding.buildPlatforms` reads it on the server and
 * `rail-solids.planStation` reads it in the browser, and they have to agree
 * about which stations are in the table for the same reason they have to agree
 * about the slot: a deck the client narrows and the server does not is invisible
 * floor.
 */

/**
 * The narrowest deck an insisted platform may be built to, metres.
 *
 * ---------------------------------------------------------------------------
 * **Eighty centimetres, and it is a person rather than a standard.**
 * `MIN_PLATFORM_DECK` is 1.25 m and is what the *procedural* rule requires
 * before it will volunteer a platform, which is right: a platform nobody asked
 * for should be comfortably usable or not exist. This is the other question --
 * a platform a schematic says is really there, in a slot the bake's track
 * spacing has left tight -- and the floor is the narrowest strip a body can
 * stand on and walk along. The player capsule is 0.4 m across.
 *
 * It cannot go below zero-plus-epsilon on gauge grounds, because the deck's
 * inner face is `PLATFORM_INNER` and that *is* the gauge's edge, so any
 * positive width is legal to a train. The floor is set by the passenger, not by
 * the train, and a station that cannot even give 0.8 m is one the bake has
 * placed somewhere a platform is not, which is a different bug and should be
 * left visible rather than papered over.
 */
export const INSISTED_MIN_DECK = 0.8;

export interface StationLayout {
  /**
   * How many platform faces the real station has.
   *
   * Documentation and a cross-check, not an instruction: nothing sizes geometry
   * from it. It is here so that a future round which *can* place faces has the
   * number to check itself against, and so a reader can tell a sourced entry
   * from a remembered one.
   */
  faces: number;
  /** The island/side split as the source states it. Prose, deliberately. */
  arrangement: string;
  /**
   * Build a platform here even where the slot is under `MIN_PLATFORM_DECK`.
   *
   * The one field the geometry reads. See `INSISTED_MIN_DECK`.
   */
  insist: boolean;
  /** Where the two numbers above came from. Never empty. */
  source: string;
}

/**
 * Keyed by the name the bake uses, which is the name in `bake.stations[].name`
 * and in every calling stop. A key that matches no station is inert and is
 * reported by `verifyStationLayouts` rather than being silently ignored --
 * a table entry for a station that does not exist is a typo, and a typo here
 * looks exactly like a station that simply never needed help.
 */
export const STATION_LAYOUTS: Record<string, StationLayout> = {
  // Five platforms in three structures, so two of the three are between running
  // roads and the anchored through road has no room either side of it -- which
  // is precisely the case the slot rule reads as "no platform". It is also the
  // owner's end-to-end destination, so an absent platform here is the most
  // visible possible outcome of P1.
  Hornsby: {
    faces: 5,
    arrangement: '1 side, 2 island',
    insist: true,
    source: 'Wikipedia, Hornsby railway station, infobox platform count (retrieved 2026-08-22)',
  },

  // Two side platforms and nothing between them, which makes the slot rule's
  // refusal surprising: it is refusing because the *anchor* sits between the two
  // roads rather than beside one. Insisted, and the narrow result is honest --
  // the bake's spacing here is genuinely tight.
  Cabramatta: {
    faces: 2,
    arrangement: '2 side',
    insist: true,
    source: 'Wikipedia, Cabramatta railway station, infobox platform count (retrieved 2026-08-22)',
  },

  // Three platforms of which one is not in regular use; the island sits between
  // the suburban pair with the main lines running past. The anchor lands on a
  // main line, which has a platform on neither side of it.
  'Summer Hill': {
    faces: 3,
    arrangement: '1 side, 1 island, and a third platform not in regular use',
    insist: true,
    source: 'Wikipedia, Summer Hill railway station, infobox platform count (retrieved 2026-08-22)',
  },

  // Twelve platforms, ten of them at ground level in five islands, and the
  // remaining two on a diverging underground alignment. Every ground-level
  // platform is between two roads, so every anchor the bake puts here is on a
  // road with platforms it cannot see.
  Redfern: {
    faces: 12,
    arrangement: '5 island, 2 side; platforms 11-12 underground on a diverging alignment',
    insist: true,
    source: 'Wikipedia, Redfern railway station, infobox platform count (retrieved 2026-08-22)',
  },

  // The through platforms are islands and the terminating country platforms are
  // a separate structure the modelled network largely does not reach. Insisting
  // recovers the through roads, which is what a player riding into the city
  // actually stands on; the terminal is a building-shaped problem and is not
  // solved by a slot.
  Central: {
    faces: 26,
    arrangement: '14 terminating, 12 through/island, 4 underground',
    insist: true,
    source: 'Wikipedia, Central railway station Sydney, infobox platform count (retrieved 2026-08-22)',
  },

  // --- Deliberately absent, and this list is part of the table --------------
  //
  // **Museum and QVB are left procedural**, which is a decision rather than an
  // omission. Museum is a cut-and-cover box on the City Circle and QVB is a
  // light-rail stop the bake records with zero platforms and an `underground`
  // vertical; neither has a surface slot for a rule about corridor spacing to
  // have an opinion about. `stationSolids` already sends an `underground`
  // station down `undergroundSolids` and never builds a surface platform there
  // at all, so an `insist` here would be a flag nothing reads.
  //
  // What they actually need is the station box -- `RAIL-CORRIDOR.md`'s P3, the
  // bore opened into a room within the station footprint and resealed outside
  // it -- and half-building that to make a table entry look complete is how a
  // player ends up falling through a lid. Named here so the next round knows
  // they were considered and skipped on purpose.
};

/**
 * Should this station be given a platform even where the corridor is tight?
 *
 * The one question the geometry asks of this file.
 */
export function insistsOnPlatform(name: string): boolean {
  const entry = STATION_LAYOUTS[name];
  return entry !== undefined && entry.insist;
}

/**
 * The table's own self-check, for both boot lists.
 *
 * `names` is every station name the bake carries, so the check can tell a typo
 * from a station that never needed help -- an entry keyed on a name nothing
 * matches is inert, and an inert override is indistinguishable from a working
 * one until somebody rides to Hornsby and finds no platform.
 *
 * Called with no names -- which is what the client boot list does before the
 * bake has landed -- it checks only the properties internal to the table.
 */
export function verifyStationLayouts(names?: readonly string[]): string[] {
  const bad: string[] = [];
  for (const [name, entry] of Object.entries(STATION_LAYOUTS)) {
    if (entry.faces <= 0) bad.push(`${name} claims ${entry.faces} platform faces`);
    if (entry.source.trim() === '') {
      bad.push(
        `${name} carries no source. A hand-typed layout with no provenance is ` +
          `indistinguishable from a guess a year from now.`,
      );
    }
    if (entry.arrangement.trim() === '') bad.push(`${name} states no island/side arrangement`);
    if (names !== undefined && !names.includes(name)) {
      bad.push(
        `${name} is in the layout table and in no station in the bake. ` +
          `An override nothing matches is inert; check the spelling against bake.stations[].name.`,
      );
    }
  }
  if (INSISTED_MIN_DECK <= 0) bad.push('INSISTED_MIN_DECK is not positive');
  return bad;
}
