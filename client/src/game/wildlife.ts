/**
 * The wildlife: bush turkeys, ibises and magpies.
 *
 * The user's whole instruction, verbatim: *"Bush turkeys, appear in parks or
 * national parks, attack u, u get police attack u if u hurt one (u have to run)
 * - ibises should be similar but not attack u - magpies do attack u"*. Three
 * species, one of which is territorial, one of which is scenery with a criminal
 * record attached, and one of which is the only animal in this country that
 * genuinely alters people's route to work.
 *
 * This is a **consumer of `game/factions.ts`**, not an extension of it. It
 * registers three kinds, it places its own ambient actors, and its entire
 * dependency on the police is one call -- `reportCrime(id, REASON.WILDLIFE)`,
 * which was reserved with its banner string before this file existed. No
 * protocol byte moved to land this feature and no line of the framework was
 * edited except the three bytes claimed in `NPC_KIND`.
 *
 * ===========================================================================
 * 1. WHERE THE BIRDS ARE, and why none of it is on the wire
 *
 * Every anchor in this file is a **pure function of baked data both ends
 * already hold**, which is what lets a city's worth of birds cost zero bytes:
 *
 *   - **Turkeys** come out of `PARKS`, a table of 248 park polygons reduced to
 *     the largest circle that fits inside each one (see the table's own note).
 *     A park disc is tiled into `TURKEY_CELL` squares and a hash decides which
 *     cells hold a bird, so density is a property of *area* rather than of the
 *     park record -- Centennial Park does not get the same five turkeys a
 *     pocket park does, and the cost of asking is bounded by the query radius
 *     rather than by the size of the park being queried.
 *   - **Ibises** are the same grid over the same discs at a lower rate, plus a
 *     kerbside set derived from the footpath bands -- the bin chickens, working
 *     the strip rather than the lawn.
 *   - **Magpies** hang their nests off the footpath bands too: one band in
 *     `NEST_RATE` carries a nest, at a hashed fraction along it and
 *     `NEST_HEIGHT` up. A band is a street with a verge, and a verge in an
 *     inner-west suburb is a street tree -- which is where a magpie nests and,
 *     more to the point, is the thing you are walking past when it hits you.
 *
 * **The deviation, stated plainly.** The brief for this feature asked for
 * magpie nests and ibis anchors to be hung off the *streamed* tile data -- the
 * `.veg.bin` tree instances and the wheelie bins in `world/furniture.ts`. They
 * cannot be: `server/world.ts` loads collision, terrain, powerups and lanes and
 * **nothing else**, so a nest derived from a tree instance would exist on the
 * client and not on the authority. A swoop that only the client believed in
 * would do no damage online, and a magpie you batted would be a magpie the
 * server never had. The footpath bands are the densest thing both ends *do*
 * share, they are the same data `pedestrians.ts` and the police beats are built
 * on, and they run down exactly the streets the trees line. So the nests are
 * derived from bands, and the client's own street trees stand beside them
 * rather than under them.
 *
 * ---------------------------------------------------------------------------
 * 2. AMBIENT UNTIL YOU ARE CLOSE, and promoted for as long as you are
 *
 * `factions.MAX_ACTORS` is **24 across every faction** and it is a wire budget,
 * so a city with a thousand birds in it cannot promote them. The rule here:
 *
 *     ambient  --(a player inside WAKE_*)-->  promoted  --(they leave)-->  gone
 *
 * A promoted bird is pinned to its anchor by `homeX/homeZ` -- set explicitly
 * after `promote`, which otherwise homes an actor on the position it spawned at
 * -- so `stepWildlife` can ask "is this anchor already live?" with one distance
 * compare and never double-promote a bird that has run twenty metres. When the
 * player leaves, the actor resolves and the ambient one is simply there again,
 * because the ambient one was never anywhere else.
 *
 * `WILDLIFE_BUDGET` is 8 of the 24, and past that promotions are refused rather
 * than queued. That is the whole of this faction's answer to the cap, and it
 * composes with the framework's: a bird with no target scores `actorPriority`
 * 2, below every officer on a pursuit, so when the cap does bite it is a
 * seagull that gets evicted and not the police response somebody is running
 * from. A refused promotion is not an error and is not retried -- the bird
 * stays ambient, which is a perfectly good state for a bird.
 *
 * ---------------------------------------------------------------------------
 * 3. THE CRIME IS UNCONDITIONAL, and that is the point of the feature
 *
 * `strikeNpc` on any of these three reports `REASON.WILDLIFE` **with no witness
 * test**. Every other crime in this game needs somebody to have seen it; this
 * one does not, and the reason is not a shortcut:
 *
 *   - All three species are protected natives (NPW Act 1974). Hurting one is an
 *     offence whether or not a constable was standing there.
 *   - The user's instruction was *"u get police attack u if u hurt one (u have
 *     to run)"*. A witness test would make that "sometimes, if you are unlucky",
 *     which is a different and much worse feature: the player would never learn
 *     the rule, because the feedback would be intermittent.
 *   - It is the only crime in the game whose *shape* is "the world knows". That
 *     reads, in play, as the birds being the one thing in Sydney you genuinely
 *     cannot touch -- which is funnier and truer than any amount of line of
 *     sight.
 *
 * So `hitNpc` on the server and the swing path in `main.ts` both route these
 * three kinds straight to `REASON.WILDLIFE`, and `isProtected` below is the one
 * predicate that decides it.
 *
 * ---------------------------------------------------------------------------
 * 4. DETERMINISM. `factions.ts`'s rule 5, restated because this file leans on it
 * harder than the police do.
 *
 * There is **no `sin`, `cos`, `atan2` or `hypot` anywhere in this file**, and no
 * `Math.random`. Every choice is `traffic.carHash`, an integer hash of integers,
 * and every curve is a polynomial:
 *
 *   - A stroll is a **waypoint schedule** on `pedestrians.posePedestrian`'s
 *     exact pattern -- a hashed leg, a hashed dwell, a hashed phase, and a
 *     linear interpolation between two hashed points. Not an oscillator.
 *   - A swoop is a **cubic Bezier evaluated by de Casteljau**, which is nine
 *     multiplies and no transcendental. See `SWOOP_TICKS`.
 *
 * That matters more here than it does for the police because a bird's whole
 * existence is a lookup: the server promotes a turkey at the position the
 * client is already drawing it at, and a client and a server that disagreed
 * about that would pop every bird in the city at the moment it woke up.
 */

import type { CombatantState } from './combat.ts';
import {
  NPC_KIND,
  NPC_STATE,
  REASON,
  npcKind,
  registerNpcKind,
  reportCrime,
  type FactionCtx,
  type NpcActor,
} from './factions.ts';
import type { PedBand, PedestrianField } from './pedestrians.ts';
import { carHash, trafficSeconds } from './traffic.ts';
import { EYE_HEIGHT } from '../player/controller.ts';

function unit(h: number): number {
  return h / 4294967296;
}

// --- The parks -------------------------------------------------------------------

/**
 * One park, as the largest circle that fits inside it.
 *
 * **Baked, with provenance.** Extracted from `data/cache/sydney.osm.pbf` -- the
 * same file the world was built from -- by a read-only scratch script that read
 * the `multipolygons` layer through `sources/osm._read_layer`, kept every
 * `leisure` in {park, garden, nature_reserve, recreation_ground, village_green}
 * and every `landuse` in {grass, cemetery}, projected each ring through
 * `geo.lonlat_to_enu` and `geo.enu_to_world` -- the identical path every
 * building in the city took to reach its tile -- and then reduced each polygon
 * to a point and a radius.
 *
 * ---------------------------------------------------------------------------
 * **Why a circle rather than a polygon**, which is the only interesting
 * decision in this table.
 *
 * A turkey standing in the middle of Enmore Road is not a turkey, so a bird's
 * position has to be *inside the park* and provably so. The obvious way to get
 * that is to carry the rings and run a point-in-polygon test, which is 248
 * polygons, several thousand vertices, a decoder, a sidecar and a broadphase --
 * all of it in a module that compiles into the Bun server.
 *
 * The circle is four numbers and gets the same guarantee for free. `(x, z)` is
 * the **pole of inaccessibility** -- shapely's `polylabel`, the point furthest
 * from any edge, which is what a label sits on and is emphatically not the
 * centroid: Centennial Park's centroid is in a pond and Callan Park's is in a
 * building. `r` is the distance from that point to the nearest edge, inner
 * rings included. Every point within `r` of `(x, z)` is therefore inside the
 * polygon by construction, and no runtime test is needed at all.
 *
 * What it costs is the fringes: a long thin park is represented by the widest
 * disc in it, so Centennial's 192 ha becomes a 579 m circle covering 105 ha and
 * the Domain's tail along the Cahill is not turkey country. That is the right
 * trade -- birds appear where a park is *wide*, which is where a park reads as
 * parkland, and never in the 4 m strip between a fence and a road.
 *
 * 248 parks survive `area >= 4,000 m2` and `r >= 12 m`, from 969 candidate
 * polygons; the discs total 4.86 km2 of guaranteed-green ground. Sorted by
 * radius, so the table opens on the parks a player has heard of. The names are
 * OSM's, kept for the check messages and for the HUD; an unnamed polygon
 * carries its tag and its coordinates instead.
 */
export interface Park {
  readonly name: string;
  /** World metres, renderer axes: +X east, +Z south. The pole of inaccessibility. */
  readonly x: number;
  readonly z: number;
  /** Metres to the nearest edge. Everything inside this is inside the park. */
  readonly r: number;
}

export const PARKS: readonly Park[] = [
  { name: 'Centennial Park', x: 2452.5, z: 3279.5, r: 578.9 },
  { name: 'Randwick Racecourse', x: 2024.4, z: 4699.9, r: 427.7 },
  { name: 'Callan Park', x: -4576.4, z: -72.6, r: 338.7 },
  { name: 'Sydney Park', x: -2240.3, z: 4575.3, r: 265.4 },
  { name: 'Queens Park', x: 3686.8, z: 3557.1, r: 198.7 },
  { name: 'Royal Botanic Garden', x: 704.1, z: -457.7, r: 194.5 },
  { name: 'Leichhardt Park', x: -5128.9, z: 8.5, r: 166.1 },
  { name: 'Sydney Harbour National Park', x: 3810.4, z: -3615.2, r: 143.1 },
  { name: 'Ashton Park', x: 3343.0, z: -2365.9, r: 138.8 },
  { name: 'Parklands Sports Centre', x: 1414.0, z: 3189.0, r: 136.5 },
  { name: 'Sydney Harbour National Park', x: 3346.9, z: -2380.6, r: 132.9 },
  { name: 'The Domain', x: 527.1, z: -94.7, r: 127.8 },
  { name: 'Moore Park', x: 935.6, z: 2402.0, r: 126.8 },
  { name: 'park 864,2825', x: 864.0, z: 2824.9, r: 126.3 },
  { name: 'Wentworth Park', x: -1571.9, z: 787.2, r: 120.3 },
  { name: 'Victoria Park', x: -1538.3, z: 2002.8, r: 118.3 },
  { name: 'Hyde Park', x: 210.8, z: 298.4, r: 115.7 },
  { name: 'Hyde Park', x: 168.6, z: 761.9, r: 113.8 },
  { name: 'Balls Head Reserve', x: -1415.5, z: -2423.9, r: 113.6 },
  { name: 'park 1217,2288', x: 1217.1, z: 2287.9, r: 113.1 },
  { name: 'Domain Yurong Precinct', x: 1140.9, z: -771.2, r: 112.2 },
  { name: 'Rushcutters Bay Park', x: 2006.5, z: 706.2, r: 110.5 },
  { name: 'Domain Crescent Precinct', x: 572.8, z: 172.7, r: 104.1 },
  { name: 'Prince Alfred Park', x: -402.3, z: 2183.7, r: 102.5 },
  { name: 'grass 532,-967', x: 531.7, z: -967.1, r: 99.2 },
  { name: 'Birchgrove Park', x: -2606.0, z: -2070.2, r: 96.1 },
  { name: 'Kellys Bush', x: -3974.4, z: -2860.9, r: 95.8 },
  { name: 'Cooper Park', x: 4304.8, z: 1950.3, r: 93.7 },
  { name: 'Lyne Park', x: 4990.5, z: 218.3, r: 93.2 },
  { name: 'Rozelle Parklands', x: -3366.1, z: 148.5, r: 92.9 },
  { name: 'Clarkes Point Reserve', x: -3500.6, z: -2911.5, r: 89.1 },
  { name: 'Sacred Heart Monastery', x: 1086.6, z: 5023.9, r: 86.8 },
  { name: 'Jubilee Park', x: -2874.0, z: 659.8, r: 86.3 },
  { name: 'Pioneers Memorial Park', x: -4782.3, z: 1128.2, r: 85.9 },
  { name: 'Federal Park', x: -3069.3, z: 686.6, r: 85.5 },
  { name: 'Berry Island Reserve', x: -1974.1, z: -3178.8, r: 84.7 },
  { name: 'Badangi Reserve', x: -1528.1, z: -3702.1, r: 84.6 },
  { name: 'Woollahra Park', x: 5092.2, z: 729.9, r: 81.4 },
  { name: 'Trumper Park', x: 2278.1, z: 1234.5, r: 79.2 },
  { name: 'Alexandria Park', x: -1034.9, z: 3494.2, r: 78.0 },
  { name: 'Brightmore Reserve', x: 1455.9, z: -5066.5, r: 77.6 },
  { name: 'Sydney Harbour National Park', x: -1197.0, z: -1858.9, r: 77.6 },
  { name: 'Weigall Sports Ground', x: 1902.6, z: 1005.4, r: 77.2 },
  { name: 'Camperdown Park', x: -3005.3, z: 2336.0, r: 77.0 },
  { name: 'Redfern Park', x: -242.7, z: 2806.5, r: 75.4 },
  { name: 'recreation_ground 1863,3400', x: 1862.7, z: 3400.0, r: 75.3 },
  { name: 'Wentworth Park', x: -1348.5, z: 1121.3, r: 72.1 },
  { name: 'Barangaroo Reserve', x: -797.9, z: -1218.1, r: 71.8 },
  { name: 'Horse Paddock', x: -3696.1, z: -2866.2, r: 69.9 },
  { name: 'Ballast Point Park', x: -1900.6, z: -1794.7, r: 69.3 },
  { name: 'Whites Creek Valley Park', x: -3791.1, z: 1090.9, r: 68.4 },
  { name: 'park -1868,2362', x: -1867.9, z: 2362.4, r: 68.3 },
  { name: 'Bellevue Park', x: 4778.0, z: 1944.5, r: 67.5 },
  { name: 'St. John\'s Oval', x: -2453.3, z: 2078.3, r: 67.2 },
  { name: 'St Thomas Rest Park', x: -353.4, z: -4975.4, r: 66.2 },
  { name: 'Bicentennial Park', x: -2999.2, z: 547.6, r: 65.4 },
  { name: 'Brennan Park', x: -1080.3, z: -3774.2, r: 64.9 },
  { name: 'Steyne Park', x: 2996.0, z: 511.4, r: 64.2 },
  { name: 'Clifton Gardens Reserve', x: 3939.8, z: -3399.1, r: 64.1 },
  { name: 'Gore Creek Reserve', x: -2542.7, z: -4372.9, r: 63.4 },
  { name: 'Dawes Point Reserve', x: -35.5, z: -1535.7, r: 62.5 },
  { name: 'recreation_ground -1034,3492', x: -1034.2, z: 3492.1, r: 62.2 },
  { name: 'Easton Park', x: -3607.4, z: 117.8, r: 62.1 },
  { name: 'Reid Park', x: 2122.9, z: -3793.8, r: 61.4 },
  { name: 'recreation_ground 2018,3473', x: 2018.4, z: 3473.1, r: 61.2 },
  { name: 'White City', x: 2068.5, z: 1137.9, r: 60.3 },
  { name: 'King George Park', x: -4330.9, z: -583.7, r: 60.3 },
  { name: 'Forsyth Park', x: 393.8, z: -3796.7, r: 60.2 },
  { name: 'Waverton Park', x: -1084.0, z: -3100.1, r: 59.1 },
  { name: 'Bradfield Park', x: 263.5, z: -2204.5, r: 59.0 },
  { name: 'O’Dea Reserve', x: -3237.0, z: 2486.1, r: 57.4 },
  { name: 'Belmore Park', x: -152.0, z: 1413.4, r: 56.9 },
  { name: 'grass 4144,634', x: 4144.2, z: 634.4, r: 56.8 },
  { name: 'Waterloo Park', x: -315.3, z: 3591.1, r: 56.7 },
  { name: 'recreation_ground 2151,3608', x: 2150.5, z: 3608.4, r: 56.7 },
  { name: 'Manns Point Park', x: -2117.6, z: -2841.5, r: 56.4 },
  { name: 'Perry Park', x: -1112.6, z: 4410.8, r: 56.2 },
  { name: 'Curraghbeena Park', x: 2311.1, z: -3042.7, r: 56.1 },
  { name: 'Harold Park', x: -2827.0, z: 986.9, r: 55.9 },
  { name: 'grass 1321,1814', x: 1321.3, z: 1814.0, r: 55.6 },
  { name: 'Elkington Park', x: -3375.8, z: -1542.4, r: 54.7 },
  { name: 'Lough Playing Fields', x: 3513.6, z: 1655.1, r: 54.5 },
  { name: 'Waterfront Green', x: -4755.7, z: -289.8, r: 51.8 },
  { name: 'Gladstone Park', x: -2494.1, z: -1067.8, r: 51.6 },
  { name: 'Brett Park', x: -4851.0, z: -1275.1, r: 51.6 },
  { name: 'park -4041,-929', x: -4041.4, z: -929.4, r: 51.6 },
  { name: 'Carradah Park', x: -1150.1, z: -2819.9, r: 51.1 },
  { name: 'park -1421,-2859', x: -1421.3, z: -2859.1, r: 50.8 },
  { name: 'Tumbalong Park', x: -687.5, z: 777.1, r: 50.7 },
  { name: 'Anderson Park', x: 509.9, z: -3164.6, r: 50.5 },
  { name: 'War Memorial Park', x: -4191.5, z: 1125.6, r: 50.5 },
  { name: 'Vice Chancellor\'s Oval', x: -1151.2, z: 3129.0, r: 49.9 },
  { name: 'Cohen Park', x: -3681.4, z: 839.0, r: 49.2 },
  { name: 'Chinese Garden of Friendship', x: -600.4, z: 867.4, r: 49.1 },
  { name: 'grass -1591,2039', x: -1591.3, z: 2039.2, r: 49.0 },
  { name: 'Eveleigh Green', x: -1152.2, z: 3131.1, r: 49.0 },
  { name: 'Camperdown Cemetery', x: -2730.2, z: 2925.6, r: 47.9 },
  { name: 'Bird Sanctuary', x: 2278.7, z: 2928.8, r: 47.0 },
  { name: 'Harry Noble Reserve', x: -1763.0, z: 3602.8, r: 46.6 },
  { name: 'Smoothey Park', x: -1697.0, z: -4277.4, r: 46.4 },
  { name: 'Anzac Park', x: 143.8, z: -4670.7, r: 46.1 },
  { name: 'Mort Bay Park', x: -2282.1, z: -1578.4, r: 45.9 },
  { name: 'Watt Park', x: -326.6, z: -2792.4, r: 45.5 },
  { name: 'Milson Park', x: 475.5, z: -2707.9, r: 44.8 },
  { name: 'The Square', x: -2038.2, z: 2117.3, r: 44.1 },
  { name: 'Cook Park', x: 429.3, z: 483.0, r: 44.1 },
  { name: 'Sydney Harbour National Park', x: 4452.2, z: -1236.3, r: 43.9 },
  { name: 'Ward Park', x: 259.1, z: 2202.0, r: 43.9 },
  { name: 'Sirius Park', x: 2551.5, z: -3299.2, r: 43.8 },
  { name: 'Camperdown Memorial Rest Park', x: -2827.3, z: 2862.9, r: 43.3 },
  { name: 'Dunlop Reserve', x: -4205.6, z: -1467.5, r: 43.3 },
  { name: 'grass -1524,-3569', x: -1523.5, z: -3569.3, r: 43.2 },
  { name: 'Phillip Park', x: 475.8, z: 398.7, r: 43.2 },
  { name: 'Lachlan Reserve', x: 2357.0, z: 3342.6, r: 42.9 },
  { name: 'Blues Point Reserve', x: -570.8, z: -2090.9, r: 42.4 },
  { name: 'Green Park', x: 527.1, z: -5067.3, r: 41.5 },
  { name: 'Ted Mack Civic Park', x: -263.9, z: -3871.2, r: 41.1 },
  { name: 'Sydney Harbour National Park', x: 2936.1, z: -740.1, r: 40.9 },
  { name: 'Harbourview Park', x: 3535.2, z: 2109.6, r: 40.7 },
  { name: 'grass -66,-1506', x: -65.5, z: -1505.8, r: 40.2 },
  { name: 'Weekley Park', x: -3991.4, z: 2560.0, r: 39.3 },
  { name: 'Sydney Harbour National Park', x: -5198.2, z: -490.6, r: 38.9 },
  { name: 'Rodd Island', x: -5198.2, z: -490.6, r: 38.9 },
  { name: 'Raleigh Park', x: 839.8, z: 4066.7, r: 38.5 },
  { name: 'Sawmillers Reserve', x: -774.4, z: -2574.8, r: 38.1 },
  { name: 'Joynton Park', x: 267.5, z: 4057.1, r: 37.9 },
  { name: 'Blackwattle Bay Park', x: -2285.2, z: 320.3, r: 37.8 },
  { name: 'Cremorne Reserve', x: 2050.4, z: -2351.3, r: 37.7 },
  { name: 'Harry Howard Reserve', x: -1265.5, z: -3948.9, r: 37.4 },
  { name: 'Hollis Park', x: -2094.2, z: 2898.8, r: 37.0 },
  { name: 'Pirrama Park', x: -1658.5, z: -492.8, r: 36.8 },
  { name: 'park -121,2937', x: -121.1, z: 2937.1, r: 36.4 },
  { name: 'Memorial Gardens', x: 4480.4, z: 2656.2, r: 36.4 },
  { name: 'First Fleet Park', x: -37.0, z: -885.2, r: 36.2 },
  { name: 'Newlands Park', x: -1458.7, z: -4587.5, r: 36.1 },
  { name: 'The Column Garden', x: 2236.8, z: 3323.1, r: 36.1 },
  { name: 'Waterloo Park', x: -361.7, z: 3400.7, r: 35.3 },
  { name: 'Observatory Hill Park', x: -373.9, z: -1056.3, r: 34.7 },
  { name: 'recreation_ground -1936,2107', x: -1935.9, z: 2106.9, r: 34.4 },
  { name: 'recreation_ground -949,953', x: -948.9, z: 952.6, r: 34.3 },
  { name: 'Yarranabbe Park', x: 2446.5, z: 219.0, r: 34.1 },
  { name: 'Waterloo Green', x: -653.8, z: 3069.4, r: 33.9 },
  { name: 'park -2581,-643', x: -2581.4, z: -643.4, r: 33.9 },
  { name: 'grass 3276,-2412', x: 3276.4, z: -2412.4, r: 33.9 },
  { name: 'Goat Paddock', x: -3509.7, z: -3093.6, r: 33.6 },
  { name: 'Waterfront Park', x: -1904.3, z: -119.1, r: 33.3 },
  { name: 'Aquatic Park', x: -3649.9, z: -3696.1, r: 33.1 },
  { name: 'Domain Tarpeian Precinct', x: 387.0, z: -850.7, r: 32.9 },
  { name: 'Greendale Park', x: -1699.7, z: -4368.6, r: 32.9 },
  { name: 'Milray Reserve', x: -1913.8, z: -3892.0, r: 32.9 },
  { name: 'recreation_ground 3530,1431', x: 3529.9, z: 1431.2, r: 32.8 },
  { name: 'Smith, Hogan & Spindler Parks', x: -3109.5, z: 1365.9, r: 32.8 },
  { name: 'Harmony Park', x: 258.7, z: 1210.5, r: 32.7 },
  { name: 'Sweetacres Park', x: -305.0, z: 4912.7, r: 32.3 },
  { name: 'Victoria Park', x: 3890.9, z: 3411.5, r: 32.3 },
  { name: 'Clark Park', x: -82.8, z: -2797.7, r: 32.3 },
  { name: 'Green Park', x: 1029.8, z: 1174.2, r: 32.2 },
  { name: 'Yurulbin Park', x: -2188.4, z: -2397.5, r: 31.9 },
  { name: 'Greenwich Point Reserve', x: -2403.7, z: -3452.8, r: 31.7 },
  { name: 'Little Ashton Park', x: 2887.9, z: -3119.9, r: 31.5 },
  { name: 'Illoura Reserve', x: -1241.4, z: -1097.4, r: 31.4 },
  { name: 'Pulpit Point Reserve', x: -4498.2, z: -2625.0, r: 31.3 },
  { name: 'Foster Park', x: 3462.3, z: 588.9, r: 31.3 },
  { name: 'Pyrmont Bay Park', x: -1101.7, z: -35.6, r: 31.1 },
  { name: 'The Drying Green', x: -303.9, z: 4324.7, r: 31.0 },
  { name: 'grass 129,556', x: 129.1, z: 555.9, r: 30.9 },
  { name: 'Hickson Park', x: -655.6, z: -680.9, r: 30.9 },
  { name: 'grass 82,797', x: 82.0, z: 797.1, r: 30.8 },
  { name: 'Punch Park', x: -2845.8, z: -797.9, r: 30.6 },
  { name: 'park -2582,-3244', x: -2582.3, z: -3243.9, r: 30.5 },
  { name: 'Enmore TAFE Park', x: -3182.1, z: 3765.5, r: 30.5 },
  { name: 'Mary O\'Brien Reserve', x: -41.2, z: 4098.0, r: 30.3 },
  { name: 'Ewenton Park', x: -1780.7, z: -1077.5, r: 30.3 },
  { name: 'grass 2719,7', x: 2718.7, z: 7.0, r: 30.3 },
  { name: 'Birrung Park', x: -2190.7, z: -926.3, r: 30.2 },
  { name: 'Orphan School Creek', x: -2839.8, z: 1651.3, r: 30.2 },
  { name: 'park -1656,-1122', x: -1656.2, z: -1122.0, r: 30.2 },
  { name: 'Butterscotch Park', x: -114.5, z: 5030.6, r: 30.0 },
  { name: 'recreation_ground -1911,825', x: -1910.8, z: 825.2, r: 30.0 },
  { name: 'grass 151,623', x: 150.8, z: 622.8, r: 30.0 },
  { name: 'park -1577,716', x: -1577.2, z: 716.1, r: 29.9 },
  { name: 'grass -1599,2123', x: -1598.9, z: 2123.3, r: 29.7 },
  { name: 'Kurraba Point Reserve', x: 1220.3, z: -2704.8, r: 29.5 },
  { name: 'Knoll Park', x: -1875.0, z: 27.2, r: 29.5 },
  { name: 'Salton Reserve', x: -4347.1, z: -1498.5, r: 29.3 },
  { name: 'Edmund Resch Reserve', x: 545.0, z: 3018.0, r: 29.2 },
  { name: 'Royal Hospital for Women Park', x: 1498.9, z: 1496.1, r: 28.7 },
  { name: 'Giba Park', x: -1544.4, z: -502.3, r: 28.7 },
  { name: 'Evan Jones Playground', x: -4046.5, z: 1660.7, r: 28.6 },
  { name: 'Rose Bay Park', x: 4052.8, z: -0.3, r: 28.5 },
  { name: 'park -3141,-3326', x: -3141.2, z: -3325.9, r: 28.1 },
  { name: 'Kokoda Memorial Park', x: 1521.7, z: 4289.3, r: 28.0 },
  { name: 'Dr HJ Foley Rest Park', x: -2095.9, z: 1333.0, r: 27.5 },
  { name: 'park -1766,3243', x: -1766.3, z: 3243.3, r: 27.5 },
  { name: 'park -2463,-1646', x: -2462.6, z: -1646.3, r: 27.4 },
  { name: 'Mary Ann Street Park', x: -936.5, z: 1370.9, r: 27.2 },
  { name: 'Overflow Parking', x: 3031.0, z: -3022.1, r: 27.1 },
  { name: 'Metcalfe Park', x: -1221.9, z: -292.4, r: 26.7 },
  { name: 'The Coal Loader', x: -1481.9, z: -2755.5, r: 26.6 },
  { name: 'The Quadrangle', x: -1862.2, z: 1946.2, r: 26.5 },
  { name: 'Chippendale Green', x: -798.8, z: 1888.8, r: 26.5 },
  { name: 'park -2703,-505', x: -2703.5, z: -505.3, r: 26.2 },
  { name: 'Waterloo Green', x: -541.1, z: 3155.1, r: 26.1 },
  { name: 'Wadanggari Park', x: -1455.7, z: -4966.6, r: 26.0 },
  { name: 'Ryan Park', x: -3957.2, z: 3296.2, r: 25.9 },
  { name: 'Bradfield Park', x: 262.2, z: -2018.8, r: 25.6 },
  { name: 'grass -1443,1944', x: -1443.3, z: 1943.9, r: 25.6 },
  { name: 'McKell Park', x: 2817.3, z: -269.0, r: 25.6 },
  { name: 'Beaconsfield Park', x: -814.9, z: 4736.0, r: 25.3 },
  { name: 'Sir David Martin Reserve', x: 2410.3, z: 360.7, r: 25.3 },
  { name: 'Wills Reserve', x: 1046.5, z: 4307.7, r: 25.2 },
  { name: 'Memory Park', x: 2531.6, z: -4200.2, r: 25.0 },
  { name: 'Solander Park', x: -1751.2, z: 3411.8, r: 24.8 },
  { name: '36th Battalion Park', x: -4450.3, z: 1416.8, r: 24.5 },
  { name: 'Holloway Park', x: -1937.2, z: -3959.5, r: 24.5 },
  { name: 'Blackburn Gardens', x: 3599.8, z: 324.0, r: 24.3 },
  { name: 'Wynyard Park', x: -304.8, z: -373.5, r: 23.5 },
  { name: 'Wendy Whiteley\'s Garden', x: -141.4, z: -2771.1, r: 23.4 },
  { name: 'UTS Alumni Green', x: -779.3, z: 1603.1, r: 23.1 },
  { name: 'Beare Park', x: 1865.2, z: 147.5, r: 23.1 },
  { name: 'James Watkinson Reserve', x: -1425.8, z: -296.6, r: 23.0 },
  { name: 'park -2594,-1923', x: -2594.0, z: -1922.9, r: 22.9 },
  { name: 'park -1267,3184', x: -1267.0, z: 3184.0, r: 22.9 },
  { name: 'grass 4435,-1258', x: 4434.8, z: -1257.6, r: 22.9 },
  { name: 'Crown Park', x: 448.8, z: 3320.3, r: 22.8 },
  { name: 'Harnett Park', x: 1864.8, z: -3487.6, r: 21.9 },
  { name: 'Cremorne Reserve', x: 1780.2, z: -2540.3, r: 21.7 },
  { name: 'Brightmore Reserve', x: 1273.6, z: -4815.6, r: 21.6 },
  { name: 'Gibbons Street Reserve', x: -923.9, z: 2692.9, r: 21.1 },
  { name: 'Propeller Park', x: -1814.9, z: -1338.5, r: 20.9 },
  { name: 'Warringa Park', x: 298.2, z: -3446.4, r: 20.9 },
  { name: 'Pope Paul VI Reserve', x: -2660.7, z: 338.4, r: 20.1 },
  { name: 'Nuffield Park', x: 223.6, z: 4330.6, r: 19.9 },
  { name: 'Lloyd Rees Park', x: -2967.9, z: -4104.9, r: 19.8 },
  { name: 'garden 416,4044', x: 416.3, z: 4043.9, r: 19.5 },
  { name: 'O\'Connor Reserve', x: -3469.2, z: -210.5, r: 19.2 },
  { name: 'Eastern Apron', x: -3329.6, z: -2380.9, r: 19.0 },
  { name: 'Northern Apron Park', x: -3455.3, z: -2472.9, r: 18.7 },
  { name: 'park 365,-4887', x: 365.4, z: -4887.0, r: 18.5 },
  { name: 'Pelican Reserve', x: -4659.6, z: -2000.9, r: 18.3 },
  { name: 'grass 484,5121', x: 483.9, z: 5121.2, r: 17.8 },
  { name: 'Bradfield Park', x: 170.6, z: -2515.4, r: 17.8 },
  { name: 'Oyster Cove Reserve', x: -1486.7, z: -3395.5, r: 17.0 },
  { name: 'Clementson Park', x: 3489.6, z: 2683.7, r: 16.7 },
  { name: 'Jefferson Jackson Reserve', x: 273.0, z: -4469.4, r: 16.6 },
  { name: 'grass 2952,-663', x: 2951.5, z: -663.0, r: 16.0 },
  { name: 'Griffith Park', x: -3427.0, z: -3924.5, r: 15.1 },
  { name: 'Forbes Street Reserve', x: 998.4, z: 190.6, r: 13.0 },
];

/** The extent the parks were extracted inside. `verifyWildlife` asserts it. */
export const PARK_EXTENT_M = 5300;

// --- How many birds, and how far apart ---------------------------------------------

/**
 * Metres a side of the cell a park disc is tiled into, and the share of cells
 * that hold a turkey.
 *
 * Density rather than a count per park, for the reason stated in the header:
 * one bird per 62 m cell at 40% occupancy is **one turkey per 9,600 m2**, which
 * puts 23 in Sydney Park's disc, 108 in Centennial's and one or two in a pocket
 * park -- and costs the same lookup in all three, because a query only ever
 * visits the cells inside its own radius.
 *
 * 62 m is also what keeps a *promoted* turkey unambiguous. `LEASH` is 35 m, so
 * a bird that has chased somebody as far as it is allowed to is still nearer to
 * its own cell than to any other, which is what lets the renderer match a live
 * actor back to the ambient anchor it came from with a nearest-point test and
 * no identity on the wire. Drop the cell under 2x the leash and birds start
 * being drawn twice.
 */
const TURKEY_CELL = 62;
const TURKEY_OCCUPANCY = 0.4;

/** The same grid for ibises, coarser and sparser: they flock, but on the bins. */
const IBIS_CELL = 78;
const IBIS_OCCUPANCY = 0.3;

/**
 * One footpath band in this many carries a kerbside ibis, and one in this many
 * carries a magpie nest.
 *
 * A band is one side of one street between two intersections, so an inner-west
 * block face is a band and a long arterial is one too. At 1 in 4.5 a walk down
 * a residential street passes a nest every couple of blocks, which is the
 * spring the feature is imitating; at 1 in 7 there is an ibis on roughly every
 * third block, which is fewer than there are bins and about right for how many
 * of them have a bird in them at any moment.
 *
 * These are rates rather than counts because the band set *is* the city: a
 * count would have to be apportioned somewhere, and there is nowhere sensible
 * to do that when the two ends hold different subsets of the streets.
 */
const NEST_RATE = 1 / 4.5;
const KERB_IBIS_RATE = 1 / 7;

/** How high a nest sits above the footpath, metres. A street tree's first fork. */
const NEST_HEIGHT = 7.5;
/** And how far off the band, toward the verge. A footpath band is already kerbside. */
const NEST_OFFSET = 2.2;
/** A bin stands against the building line, not in the middle of the path. */
const KERB_IBIS_OFFSET = 1.1;

/**
 * How close a player has to be for a bird to become a real actor, metres.
 *
 * Each is comfortably outside the range at which that species does anything, so
 * the handoff from ambient to promoted is always invisible: a turkey is live
 * eighteen metres before it can aggro, a magpie is live before its nest radius,
 * and an ibis is live before it can be startled. A wake radius *inside* the
 * behaviour radius would mean the first frame of every encounter was the frame
 * the bird appeared, which is the one frame that gives the whole arrangement
 * away.
 */
const WAKE_TURKEY = 26;
const WAKE_IBIS = 14;
const WAKE_MAGPIE = 30;
/** And the hysteresis on the way out. A bird resolves at 1.35x its wake radius. */
const SLEEP_FACTOR = 1.35;

/**
 * Promoted birds at once, of `factions.MAX_ACTORS`.
 *
 * A third of the wire budget, and it is a *self-imposed* cap on top of the
 * framework's rather than a substitute for it. The framework's eviction would
 * already protect a pursuit from a flock -- a bird with no target scores below
 * every officer chasing somebody -- but nothing in it stops wildlife filling
 * the field with itself in a park with no police in it, and then a player who
 * commits a crime waits for birds to resolve before an officer can be promoted.
 * Eight is enough for the busiest thing this feature can produce (a nest, its
 * magpie, and the half-dozen turkeys of a park corner) and leaves two thirds of
 * the field for the people.
 */
export const WILDLIFE_BUDGET = 8;

/** Promotions a tick. A flock that woke all at once would be a spawn, not a park. */
const PROMOTIONS_PER_TICK = 2;

// --- Turkey tuning ------------------------------------------------------------------

/**
 * Metres. Inside this a bush turkey decides you are the problem.
 *
 * Eight, per the brief, and it is a genuinely aggressive number -- it is about
 * two car lengths, and a real *Alectura lathami* defending a mound will come at
 * you from further. What makes it playable rather than unfair is `GIVE_UP`: the
 * bird is faster than a walk and slower than a sprint, so the answer is always
 * available and is always the same answer, which is to leave.
 */
const TURKEY_AGGRO = 8;
/** And where it loses interest. Beyond this the chase ends. */
const TURKEY_GIVE_UP = 20;
/**
 * How far from its cell a turkey will go, metres.
 *
 * **Half `TURKEY_CELL`, and that is a constraint rather than a coincidence** --
 * `verifyWildlife` asserts it. The renderer matches a live bird back to the
 * ambient anchor it came from by distance, because the wire carries no anchor;
 * a bird that could get further from its own anchor than half the grid spacing
 * could be nearer its neighbour's, and then the neighbour is suppressed and
 * this one's ambient twin is drawn beside it. Two turkeys, one of them a ghost.
 *
 * It also happens to be the right number on its own terms: 30 m is about a park
 * path's width plus a lawn, which is as far as a real one chases before it
 * decides it has made its point.
 */
const LEASH = 30;
/** Metres. Inside this it pecks. A beak's reach plus a lunge. */
const PECK_RANGE = 1.5;
/** Pips a peck takes, and the ticks between them. A quarter pip a second. */
const PECK_DAMAGE = 0.25;
const PECK_INTERVAL_TICKS = 60;
/** How long the peck lasts as a state, ticks. One snapshot period; see `NPC_STATE.FIRE`. */
const STRIKE_STATE_TICKS = 3;

const TURKEY_RADIUS = 0.34;
const TURKEY_HEIGHT = 0.78;
const TURKEY_WALK = 0.6;
/** m/s. The brief's number, and it is between a player's walk and their sprint. */
const TURKEY_CHASE = 4.5;
/** Seconds a batted turkey is on the ground before it gets up, furious. */
const TURKEY_DOWN_SECONDS = 10;

// --- Ibis tuning --------------------------------------------------------------------

/** Metres. Where a bin chicken decides you are not worth it. */
const IBIS_FLEE = 3;
/** And how far it goes before it stops caring, metres. It is not in a hurry. */
const IBIS_FLEE_DISTANCE = 9;
const IBIS_FLEE_SPEED = 3;
const IBIS_RADIUS = 0.26;
const IBIS_HEIGHT = 0.85;
const IBIS_WALK = 0.45;
const IBIS_DOWN_SECONDS = 10;

// --- Magpie tuning ------------------------------------------------------------------

/**
 * Metres from the nest at which a magpie starts taking an interest. The brief's 20.
 *
 * **Entering is on you; staying is what costs.** Twenty metres buys the first
 * pass and nothing else -- every pass after it is gated on `DISENGAGE_RANGE`
 * and on not already leaving. See `breakingOff`.
 */
const SWOOP_RANGE = 20;
/**
 * Metres. Inside this the campaign continues; outside it, the magpie is done.
 *
 * The asymmetry against `SWOOP_RANGE` is the entire fix for *"de aggro based on
 * distance too slow"*. The old rule ended an engagement at the aggro radius, so
 * a player who turned and ran from eight metres still had to cover twelve
 * before the bird stopped -- and at a walk that is nearly three seconds, which
 * is two more swoops in the back of the head while already retreating. Twelve
 * is about a second and a half of walking or three quarters of a sprint, and
 * `breakingOff`'s velocity half usually fires before the distance does.
 */
const DISENGAGE_RANGE = 12;
/**
 * The alarm, ticks, before the dive it announces.
 *
 * **The warble leads the dive rather than accompanying it**, which is the other
 * half of the complaint (*"too hard to avoid"*). The old bird went from perched
 * to past your ear in 40 ticks with the call layered over the top of it, so the
 * first information you had about a swoop arrived at the same instant as the
 * swoop. Fifty ticks is 0.83 s of a magpie screaming at you from the branch
 * before it leaves it -- long enough to hear it, find it and move, and short
 * enough that standing there listening is still the wrong answer.
 *
 * `NPC_STATE.AIM` carries it, which is a byte the wire already has and no
 * faction of this one uses. `main.ts` plays the alarm off its rising edge and
 * the dive sound off `CHASE`'s, so the two cues are 0.83 s apart online and
 * offline alike, with no protocol change and no new event.
 */
const TELEGRAPH_TICKS = 50;
/**
 * How long one dive takes, ticks, and how long the climb-out and circle between
 * two of them takes.
 *
 * 40 ticks is two thirds of a second from the branch to past your ear, which is
 * about right and is deliberately too fast to react to -- by the time the bird
 * is off the branch the read has already happened, up in `TELEGRAPH_TICKS`.
 *
 * The circle was 110 ticks when the dive was the whole encounter. It is 55 now
 * because the telegraph has been added in front of every pass: a swoop cycle is
 * 50 + 40 + 55 = 145 ticks either way, so the *rhythm* is unchanged and what
 * moved is where inside it the player gets to act.
 */
const SWOOP_TICKS = 40;
const CIRCLE_TICKS = 55;
/**
 * And the climb-out after a **break-off**, which is a different thing.
 *
 * `CIRCLE_TICKS` is a rhythm: it is the pause that makes two swoops read as a
 * campaign rather than a stutter, and it is only ever spent on a player the
 * bird is still working on. A break-off has no rhythm to keep -- the player has
 * answered and the bird is going back to the branch -- so making it wait the
 * full circle just extends an engagement that has already ended by nearly a
 * second. Measured through the real controller, the acceleration ramp from a
 * standstill to `BREAK_OFF_SPEED` already costs about 0.7 s; with the full
 * circle behind it, "turn and run" took 1.65 s to be over, which is the thing
 * being fixed rather than a budget to spend.
 */
const BREAK_OFF_CIRCLE_TICKS = 24;
/**
 * Swoops per engagement before it perches and settles for a stare. The brief's 2-3.
 *
 * Two rather than three. Three was a seven-and-a-half second campaign, and with
 * the telegraph in front of each pass a third one is a bird still working on
 * you long after the joke has landed.
 */
const MAX_SWOOPS = 2;
/**
 * How far ahead of you the magpie aims, ticks of your own velocity, and the
 * furthest that lead may reach, metres.
 *
 * **This pair is the dodge.** The arc is committed once, at the top of the
 * telegraph, at `position + velocity * COMMIT_LEAD_TICKS` -- and then it is
 * *fixed*, so what lands is a bird arriving where you were going to be rather
 * than where you turned out to be. The two numbers decide who that catches:
 *
 *   - The bird leads by 46 ticks and the strike lands 70 ticks after the commit
 *     (`TELEGRAPH_TICKS` plus half of `SWOOP_TICKS`), so it is always **24 ticks
 *     short**. At a walk that is a 1.76 m error against a 1.15 m
 *     `SWOOP_HIT_RADIUS`, which sounds like a clean miss and is not: the arc's
 *     plan track runs straight down the ray it committed to, so a player walking
 *     *along* that ray is swept anyway and only one walking across it is missed.
 *     That is where the coin flip comes from, and it is the better coin flip --
 *     what decides it is the direction you chose, not the speed you chose.
 *   - The lead is **capped at 4 m**, which is a player moving at 5.2 m/s. A
 *     4.4 m/s walk wants 3.37 m and is read in full; an 8.2 m/s sprint wants
 *     6.3 m, gets 4, and is five and a half metres clear by the time the bird
 *     arrives. Sprinting past a nest is a dodge, which it should be.
 *
 * A direction change beats it at any speed, because the commit is a straight
 * line and you are no longer on it. Standing still beats nothing at all, which
 * is the joke working as intended.
 *
 * **Measured over twenty scripted passes a style**, on flat ground with the
 * player driven at a fixed velocity: standing 100% of dives land, dawdling at
 * 1.5 m/s 100%, walking 50%, walking with a 90-degree turn on the alarm 0%,
 * sprinting 0%. Those five numbers are the entire feature.
 *
 * Velocity rather than a remembered previous position, deliberately: it is
 * already on `CombatantState.body`, it costs no per-actor storage on a wire
 * record three factions share, and it is exactly as authoritative as the
 * position beside it.
 */
const COMMIT_LEAD_TICKS = 46;
const COMMIT_LEAD_MAX = 4;
/**
 * The shortest run the arc is ever built over, metres.
 *
 * A player standing directly under the nest gives a commit point on top of it,
 * and an arc with no plan run is a division by nothing followed by a bird
 * falling vertically through its own branch. Two metres is the floor.
 */
const COMMIT_MIN_RUN = 2;
/**
 * Ticks either side of the strike point in which a pass may connect.
 *
 * The hit test used to run over the whole dive, so the climb-out could clip
 * somebody the bottom of the arc had already missed -- a graze counted as a
 * strike, forty ticks wide. Six ticks either side of the bottom is a tenth of a
 * second of contact window, which is the part of the curve that is actually at
 * head height. Outside it the bird is either still coming down or already gone.
 *
 * **Measured, because it did not look like it would matter and it does.** The
 * arc carries `SWOOP_OVERSHOOT` -- seven metres -- past the commit point and
 * dips back through head height on the way up. Against a probe standing a
 * spread of distances beyond the commit, the whole-arc window landed 18 passes
 * in 20 and clipped players as much as **five metres** past where the bird was
 * aiming; six ticks lands 11 and almost nothing past two. Every one of the
 * seven it drops is the tail of a dive that had already gone by.
 */
const STRIKE_WINDOW_TICKS = 6;
/**
 * Metres per second of *outward* travel that calls the engagement off.
 *
 * Radial, against the nest: strafing past a tree is not leaving and does not
 * count, and neither does backing away at a shuffle. 3.2 m/s is comfortably
 * under a 4.4 m/s walk, so turning your back and walking is enough -- which is
 * what the user meant by wanting the de-aggro to be quicker. It is checked
 * every tick of the telegraph and over the back half of the dive, so the
 * answer to a magpie is available at all times and takes effect inside the
 * pass you are already in.
 */
const BREAK_OFF_SPEED = 3.2;
/**
 * Ticks a magpie stays bored after an engagement ends. Twenty seconds.
 *
 * Leaving and coming straight back used to buy a whole fresh campaign, so the
 * counterplay to a magpie was also a way of farming one. Inside the cooldown a
 * returning player gets **one** warning pass and then the stare; past it, the
 * full two. Held in `barkedAt` while the bird is perched with nobody in range
 * -- see the note on that field's double duty -- which means it lasts exactly
 * as long as the bird stays promoted. A player who walks 40 m away has resolved
 * the actor and is entitled to a fresh bird, which is also true of the one in
 * the tree.
 */
const REAGGRO_COOLDOWN_TICKS = 20 * 60;
/** Metres. How close the arc has to pass to a player's head to connect. */
const SWOOP_HIT_RADIUS = 1.15;
const SWOOP_DAMAGE = 0.25;
/** How far past you the arc carries before it climbs out, metres. */
const SWOOP_OVERSHOOT = 7;
/**
 * Where the strike point sits relative to your head: this far back along the
 * bird's approach, and this far up.
 *
 * The arc is built to pass **through** that point rather than to aim at it --
 * see `swoopPoint` -- so these two numbers are the closest approach, and the
 * closest approach is what decides whether the swoop ever connects. 35 cm short
 * of the head and 10 cm above it is a bird that goes past your ear, which is
 * what one does.
 */
const STRIKE_LEAD = 0.35;
const STRIKE_RISE = 0.1;
/** How far the bird drops off the branch before it commits to the run, metres. */
const SWOOP_HOLD_DROP = 0.5;
const MAGPIE_RADIUS = 0.22;
const MAGPIE_HEIGHT = 0.42;
/** A downed magpie stays down. Batting one out of the air is hard; it should count. */
const MAGPIE_DOWN_SECONDS = 12;

/**
 * The magpie's tuning, exported so a check can assert *against the simulation*
 * rather than against a copy of it.
 *
 * `server/integration-check.checkWildlife` reads these rather than restating
 * them, which is the difference between a check that fails when the tuning
 * moves and one that fails when the tuning is *wrong*. The first kind gets
 * edited until it passes; the second kind is worth having.
 */
export const MAGPIE_TUNING = {
  /** Metres. Entering this starts an engagement. */
  swoopRange: SWOOP_RANGE,
  /** Metres. Leaving this ends one. */
  disengageRange: DISENGAGE_RANGE,
  /** Ticks of alarm before the dive. */
  telegraphTicks: TELEGRAPH_TICKS,
  /** Ticks the dive itself takes. */
  swoopTicks: SWOOP_TICKS,
  /** Ticks of circling between passes. */
  circleTicks: CIRCLE_TICKS,
  /** And the shorter one after a break-off, which is just going home. */
  breakOffCircleTicks: BREAK_OFF_CIRCLE_TICKS,
  /** Passes in a full engagement. */
  maxSwoops: MAX_SWOOPS,
  /** Ticks of your velocity the commit point is thrown forward by. */
  commitLeadTicks: COMMIT_LEAD_TICKS,
  /** Metres that lead is capped at. */
  commitLeadMax: COMMIT_LEAD_MAX,
  /** Ticks either side of the bottom of the arc in which a pass may land. */
  strikeWindowTicks: STRIKE_WINDOW_TICKS,
  /** Metres. The sphere around the strike point. */
  hitRadius: SWOOP_HIT_RADIUS,
  /** m/s of outward travel that calls it off. */
  breakOffSpeed: BREAK_OFF_SPEED,
  /** Ticks before a returning player is worth a full campaign again. */
  cooldownTicks: REAGGRO_COOLDOWN_TICKS,
  /** Pips a pass takes. */
  swoopDamage: SWOOP_DAMAGE,
  /**
   * Ticks from the commit to the strike: the whole flight the lead has to cover
   * and deliberately does not. Derived here so nobody has to add it up again.
   */
  flightTicks: TELEGRAPH_TICKS + SWOOP_TICKS * 0.5,
} as const;

// --- Where an ambient bird is --------------------------------------------------------

/** One ambient bird, as `forEachWildlifeNear` reports it. Reused; never allocated per visit. */
export interface WildPose {
  /** Stable identity for the renderer's slot pool. A hash; see `anchorKey`. */
  key: number;
  kind: number;
  /** Where the bird is now, world metres. `y` is its feet, or its perch. */
  x: number;
  y: number;
  z: number;
  /** The anchor it belongs to. What a promoted actor is homed on. */
  ax: number;
  az: number;
  /** Unit heading. Never an angle -- `factions.ts` rule 5. */
  dx: number;
  dz: number;
  /** 0..1, advances with distance walked. Drives the renderer's bob. */
  gait: number;
  /** What it is doing: see `ACT`. Presentation only; nothing decides on it. */
  act: number;
}

/** Ambient sub-states. Presentation only -- the wire's `NPC_STATE` is for promoted birds. */
export const ACT = {
  WALK: 0,
  /** Standing. A turkey looking at you, an ibis thinking about it. */
  PAUSE: 1,
  /** Head down: a turkey scratching, an ibis in the bin. */
  FEED: 2,
  /** On a branch. Magpies only. */
  PERCH: 3,
} as const;

export function createWildPose(): WildPose {
  return { key: 0, kind: 0, x: 0, y: 0, z: 0, ax: 0, az: 0, dx: 0, dz: 1, gait: 0, act: 0 };
}

/** Scratch the band queries fill. One per caller, for the life of the process. */
export interface WildScratch {
  bands: PedBand[];
  picks: PedBand[];
}

export function createWildScratch(): WildScratch {
  return { bands: [], picks: [] };
}

/**
 * A bird's stable key. A hash of what it is and where it came from.
 *
 * Keyed on the *source* -- park index and cell, or band id and side -- rather
 * than on a running index, for `factions.stationSeed`'s reason: the first thing
 * anybody does to the park table is re-sort it, and a key that moved would hand
 * a renderer slot to a different bird and slide one across the park.
 */
function anchorKey(kind: number, a: number, b: number): number {
  return carHash(carHash(a, b), kind * 0x9e37 + 0x5bf0);
}

/**
 * How far a bird wanders from its anchor while nothing is happening, metres.
 *
 * Small on purpose. A turkey works a patch of leaf litter and an ibis works a
 * bin; both of them look wrong the moment they start crossing the park. It is
 * also what keeps `TURKEY_CELL` honest -- an ambient bird stays inside a
 * quarter of its own cell, so the grid never reads as a grid.
 */
const STROLL_RADIUS = 2.4;
const STROLL_LEG_MIN = 2.5;
const STROLL_LEG_SPAN = 4;
const STROLL_DWELL_MIN = 3.5;
const STROLL_DWELL_SPAN = 7;
/** Turns of gait phase per metre walked. A 0.5 m stride at 2 steps a cycle. */
const GAIT_PER_METRE = 1 / 0.5;

/** One hashed waypoint in a bird's patch. Square rather than disc: two hashes, no bearing. */
function strollPoint(seed: number, cycle: number, ax: number, az: number, out: [number, number]): void {
  const h = carHash(seed, cycle | 0);
  out[0] = ax + (unit(h) - 0.5) * 2 * STROLL_RADIUS;
  out[1] = az + (unit(carHash(h, 0x2f1d)) - 0.5) * 2 * STROLL_RADIUS;
}

const _from: [number, number] = [0, 0];
const _to: [number, number] = [0, 0];

/**
 * Where a ground bird is at `now`, as a waypoint schedule.
 *
 * `pedestrians.posePedestrian`'s shape exactly -- a hashed leg, a hashed dwell,
 * a hashed phase, and a linear walk between two hashed points -- and for the
 * same two reasons: it is a pure function of `(seed, now)` so every process
 * agrees without anybody sending anything, and it contains no oscillator, so
 * two birds beside each other are not two birds in step.
 */
function poseGround(seed: number, ax: number, az: number, now: number, out: WildPose): void {
  const h = carHash(seed, 0x57a1);
  const leg = STROLL_LEG_MIN + STROLL_LEG_SPAN * unit(h);
  const dwell = STROLL_DWELL_MIN + STROLL_DWELL_SPAN * unit(carHash(h, 0x2d4b));
  const period = leg + dwell;
  const age = now + unit(carHash(h, 0x9e37)) * period;
  const cycle = Math.floor(age / period);
  const u = age - cycle * period;

  strollPoint(seed, cycle, ax, az, _from);
  strollPoint(seed, cycle + 1, ax, az, _to);
  const dx = _to[0] - _from[0];
  const dz = _to[1] - _from[1];
  const d2 = dx * dx + dz * dz;
  const d = d2 > 1e-9 ? Math.sqrt(d2) : 0;

  if (u < leg) {
    const t = u / leg;
    out.x = _from[0] + dx * t;
    out.z = _from[1] + dz * t;
    out.gait = (d * t * GAIT_PER_METRE) % 1;
    out.act = ACT.WALK;
  } else {
    out.x = _to[0];
    out.z = _to[1];
    // Standing still, and what it does while standing is hashed off the leg it
    // just finished: mostly head down, which is what both of these birds are
    // doing whenever they are not walking or attacking you.
    const rest = (u - leg) / dwell;
    out.act = unit(carHash(h, cycle ^ 0x77)) < 0.65 ? ACT.FEED : ACT.PAUSE;
    // The gait keeps running through a pause at a crawl, so the renderer's bob
    // does not freeze into a statue between legs.
    out.gait = (d * GAIT_PER_METRE + rest * 0.35) % 1;
  }
  if (d > 1e-6) {
    out.dx = dx / d;
    out.dz = dz / d;
  } else {
    out.dx = 0;
    out.dz = 1;
  }
}

/**
 * Every ambient bird within `radius` of a point, at `tick`.
 *
 * The iteration order is fixed rather than incidental -- parks in table order,
 * cells in ascending (cx, cz), then the bands sorted by `(osmId, side)` --
 * because `stepWildlife` promotes out of this and two processes that promoted
 * in different orders would fill the last slot of the budget with different
 * birds. `PedestrianField.near` returns bands in whatever order its grid
 * buckets hold them, which on a browser is streaming order and on the server is
 * `Promise.all` completion order; the sort is what makes that irrelevant, and
 * it is the same fix `factions.catchmentBands` documents at length.
 *
 * `groundAt` is the terrain, handed in rather than imported: this module
 * compiles into the Bun server, where the ground is `factionWorld.groundHeight`
 * and there is no renderer to ask.
 *
 * Returns early if `visit` returns true, which is how a query that only wants
 * the nearest stops without posing the whole park.
 */
export function forEachWildlifeNear(
  peds: PedestrianField | null,
  x: number,
  z: number,
  radius: number,
  tick: number,
  groundAt: (x: number, z: number) => number,
  scratch: WildScratch,
  out: WildPose,
  visit: (pose: WildPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;

  // --- The parks: turkeys, then the lawn ibises, over the same discs.
  for (let p = 0; p < PARKS.length; p++) {
    const park = PARKS[p];
    const reach = park.r + radius;
    const pdx = park.x - x;
    const pdz = park.z - z;
    if (pdx * pdx + pdz * pdz > reach * reach) continue;
    if (parkCells(park, p, x, z, radius, r2, now, TURKEY_CELL, TURKEY_OCCUPANCY, NPC_KIND.TURKEY, groundAt, out, visit)) {
      return;
    }
    if (parkCells(park, p, x, z, radius, r2, now, IBIS_CELL, IBIS_OCCUPANCY, NPC_KIND.IBIS, groundAt, out, visit)) {
      return;
    }
  }

  // --- The streets: kerbside ibises and magpie nests.
  if (peds === null) return;
  peds.near(x, z, radius + NEST_OFFSET, scratch.bands);
  const picks = scratch.picks;
  picks.length = 0;
  for (const band of scratch.bands) {
    if (band.count < 2) continue;
    picks.push(band);
  }
  picks.sort((a, b) => a.osmId - b.osmId || a.side - b.side || a.minX - b.minX);

  for (const band of picks) {
    if (unit(carHash(band.seed, 0x1b15)) < KERB_IBIS_RATE) {
      if (bandAnchor(band, 0x1b15, KERB_IBIS_OFFSET, 0, NPC_KIND.IBIS, x, z, r2, now, out, visit)) return;
    }
    if (unit(carHash(band.seed, 0x4d2e)) < NEST_RATE) {
      if (bandAnchor(band, 0x4d2e, NEST_OFFSET, NEST_HEIGHT, NPC_KIND.MAGPIE, x, z, r2, now, out, visit)) return;
    }
  }
}

/**
 * One species' cells inside one park. Returns true if the visitor asked to stop.
 *
 * Split out rather than inlined twice because the turkeys and the lawn ibises
 * differ only in a cell size, a rate and a byte, which is exactly the kind of
 * difference that goes wrong when it is copied.
 */
function parkCells(
  park: Park,
  index: number,
  x: number,
  z: number,
  radius: number,
  r2: number,
  now: number,
  cell: number,
  occupancy: number,
  kind: number,
  groundAt: (x: number, z: number) => number,
  out: WildPose,
  visit: (pose: WildPose) => boolean | void,
): boolean {
  // Cells are indexed off the park's own origin, so a bird's cell does not move
  // when the query does. Clamped to the disc's own extent, because a query on
  // the far side of a big park should not walk the whole of it.
  const lo = -Math.ceil(park.r / cell);
  const hi = Math.ceil(park.r / cell);
  let cx0 = Math.floor((x - radius - park.x) / cell);
  let cx1 = Math.floor((x + radius - park.x) / cell);
  let cz0 = Math.floor((z - radius - park.z) / cell);
  let cz1 = Math.floor((z + radius - park.z) / cell);
  if (cx0 < lo) cx0 = lo;
  if (cz0 < lo) cz0 = lo;
  if (cx1 > hi) cx1 = hi;
  if (cz1 > hi) cz1 = hi;

  const seedBase = parkSeed(park, index);
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cz = cz0; cz <= cz1; cz++) {
      const h = carHash(carHash(seedBase, cx), cz ^ (kind << 8));
      if (unit(h) >= occupancy) continue;
      // Jittered inside the cell rather than at its centre, at 80% of the cell
      // so two birds in neighbouring cells cannot end up on top of each other.
      const ax = park.x + (cx + 0.5) * cell + (unit(carHash(h, 0x11)) - 0.5) * cell * 0.8;
      const az = park.z + (cz + 0.5) * cell + (unit(carHash(h, 0x22)) - 0.5) * cell * 0.8;
      const ox = ax - park.x;
      const oz = az - park.z;
      // Inside the inscribed disc is inside the polygon. See `Park`.
      if (ox * ox + oz * oz > park.r * park.r) continue;

      out.key = anchorKey(kind, seedBase, (cx << 12) ^ (cz & 0xfff));
      out.kind = kind;
      out.ax = ax;
      out.az = az;
      poseGround(out.key, ax, az, now, out);
      const dx = out.x - x;
      const dz = out.z - z;
      if (dx * dx + dz * dz > r2) continue;
      out.y = groundAt(out.x, out.z);
      if (visit(out) === true) return true;
    }
  }
  return false;
}

/**
 * A park's hash seed: its rounded coordinates, not its index.
 *
 * `factions.stationSeed`'s argument, and the index is passed in only so a table
 * that ever holds two discs at the same rounded point cannot make them the same
 * park. Keying on the position means a park's birds are the same birds in every
 * process and across every edit that does not move the park.
 */
function parkSeed(park: Park, index: number): number {
  return carHash(carHash(Math.round(park.x) | 0, Math.round(park.z) | 0), index | 0);
}

/**
 * One anchor hung off a band: a point at a hashed fraction along it, offset to
 * the left of travel, optionally lifted into a tree.
 *
 * Left of the heading is `(dz, -dx)` in renderer axes, which is the statement
 * `pedestrians.buildBand` makes about which side of a way is which. On a
 * footpath band that is the building line and away from the traffic, which is
 * where a bin stands and where a street tree is.
 */
function bandAnchor(
  band: PedBand,
  salt: number,
  offset: number,
  lift: number,
  kind: number,
  x: number,
  z: number,
  r2: number,
  now: number,
  out: WildPose,
  visit: (pose: WildPose) => boolean | void,
): boolean {
  const h = carHash(band.seed, salt ^ 0x71);
  // Never at the very ends: a bin on the corner is in the intersection, and a
  // nest at the end of a band is a nest in the middle of the road.
  const u = 0.18 + 0.64 * unit(h);
  const target = u * band.length;
  let i = 0;
  while (i < band.count - 2 && band.s[i + 1] < target) i++;
  const span = band.s[i + 1] - band.s[i];
  const t = span > 1e-6 ? (target - band.s[i]) / span : 0;
  const px = band.x[i] + (band.x[i + 1] - band.x[i]) * t;
  const pz = band.z[i] + (band.z[i + 1] - band.z[i]) * t;
  const py = band.y[i] + (band.y[i + 1] - band.y[i]) * t;
  const ux = band.ux[i];
  const uz = band.uz[i];

  const ax = px + uz * offset;
  const az = pz - ux * offset;
  out.key = anchorKey(kind, band.osmId ^ (band.side << 30), salt);
  out.kind = kind;
  out.ax = ax;
  out.az = az;

  if (lift > 0) {
    // A perch does not stroll. It sits on the branch it nests in, facing along
    // the street, which is what it is watching.
    out.x = ax;
    out.z = az;
    out.y = py + lift;
    out.dx = ux;
    out.dz = uz;
    out.act = ACT.PERCH;
    // A slow hashed shuffle on the branch, so a perched bird is not a fencepost.
    out.gait = (now * 0.35 + unit(carHash(out.key, 0x3c))) % 1;
  } else {
    poseGround(out.key, ax, az, now, out);
    out.y = py;
  }
  const dx = out.x - x;
  const dz = out.z - z;
  if (dx * dx + dz * dz > r2) return false;
  return visit(out) === true;
}

// --- The kinds ------------------------------------------------------------------------

/** Whether a kind is one of the three protected natives. The crime rule's whole test. */
export function isProtected(kind: number): boolean {
  return kind === NPC_KIND.TURKEY || kind === NPC_KIND.IBIS || kind === NPC_KIND.MAGPIE;
}

/**
 * The wake radius for a kind, metres, and the one place the three are compared.
 *
 * Zero for anything that is not wildlife, which is how `stepWildlife` stays out
 * of the way of a kind it does not own.
 */
export function wakeRadius(kind: number): number {
  return kind === NPC_KIND.TURKEY
    ? WAKE_TURKEY
    : kind === NPC_KIND.IBIS
      ? WAKE_IBIS
      : kind === NPC_KIND.MAGPIE
        ? WAKE_MAGPIE
        : 0;
}

/**
 * The nearest combatant worth reacting to, or null.
 *
 * A knocked-out player is not a target: a turkey standing over an unconscious
 * body pecking it is funny for about a second and then it is a player who
 * cannot respawn without taking damage. `server/sim.ts` makes the same call
 * about the police.
 */
function nearestTarget(actor: NpcActor, ctx: FactionCtx, within: number): CombatantState | null {
  let best: CombatantState | null = null;
  let best2 = within * within;
  for (const c of ctx.combatants) {
    if (c.phase === 'ko' || c.health <= 0) continue;
    const dx = c.body.position.x - actor.x;
    const dz = c.body.position.z - actor.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > best2) continue;
    best2 = d2;
    best = c;
  }
  return best;
}

function combatantById(ctx: FactionCtx, id: number): CombatantState | undefined {
  for (const c of ctx.combatants) if (c.id === id) return c;
  return undefined;
}

/** Plan distance between an actor and a combatant. No `hypot`; see rule 5. */
function planDistance(actor: NpcActor, c: CombatantState): number {
  const dx = c.body.position.x - actor.x;
  const dz = c.body.position.z - actor.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Walk an actor toward a point at a speed, sliding off buildings.
 *
 * `factions.walkToward`'s arithmetic, restated rather than imported because
 * that one is module-private and this file may not edit it. The capsule radius
 * and the step height are this faction's own, which is the part that actually
 * matters: a bird's shoulder is 40 cm off the ground, so resolving one at a
 * person's chest height would have it refuse to walk under a bench.
 */
function stepToward(actor: NpcActor, tx: number, tz: number, speed: number, ctx: FactionCtx, radius: number): number {
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
    const moved = ctx.collision.resolve(actor.x, actor.z, nx, nz, radius, actor.y + 0.3);
    nx = moved.x;
    nz = moved.z;
  }
  actor.x = nx;
  actor.z = nz;
  actor.y = ctx.groundHeight(nx, nz, actor.y);
  return d;
}

/** Whether every player has left, so this bird can go back to being a lookup. */
function abandoned(actor: NpcActor, ctx: FactionCtx, radius: number): boolean {
  const r2 = radius * radius;
  for (const c of ctx.combatants) {
    const dx = c.body.position.x - actor.x;
    const dz = c.body.position.z - actor.z;
    if (dx * dx + dz * dz <= r2) return false;
  }
  return true;
}

/** The despawn flag `FactionField.step` sweeps on. Stated once so it cannot drift. */
function resolveActor(actor: NpcActor): void {
  actor.health = -2;
}

/**
 * The bush turkey. Kind 4.
 *
 * *Alectura lathami*: a bird the size of a chicken with a bald red head, a
 * yellow wattle and no interest in your opinion. In the parks of the inner west
 * they are genuinely fearless, and the brief's instruction -- territorial
 * inside eight metres, gives up past twenty -- is a fair description of one
 * defending a mound.
 *
 * One pip of health, so any weapon in the game downs it in one hit, and ten
 * seconds on the ground before it gets up. It gets up because a dead turkey in
 * a park is a much worse object than a furious one, and because the crime has
 * already been reported by then either way.
 */
export const TURKEY = registerNpcKind({
  kind: NPC_KIND.TURKEY,
  name: 'bush turkey',
  radius: TURKEY_RADIUS,
  height: TURKEY_HEIGHT,
  maxHealth: 1,
  walkSpeed: TURKEY_WALK,
  chaseSpeed: TURKEY_CHASE,
  downSeconds: TURKEY_DOWN_SECONDS,
  // **No clips, and that is the design rather than an omission.** There are no
  // wildlife WAVs in this build and there should not be: a bird call is a
  // synthesiser's natural subject, so `audio.turkeyCall` builds one out of two
  // oscillators and the client fires it off the *state edge* -- an actor that
  // has just entered CHASE is an actor that has just gobbled at you. That works
  // identically online and offline, where an aggro event does not: the wire
  // deliberately carries no such event, which is `factions.bark`'s own note.
  aggroClips: [],
  aggroCooldownSeconds: 6,
  feedKo: '%s got flogged by a bush turkey',
  scoresKo: false,

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = NPC_STATE.IDLE;
        actor.stateTicks = 0;
        actor.target = -1;
      }
      return;
    }

    // The peck is held for exactly one snapshot period and then drops back, so
    // every peck is carried by exactly one snapshot and a client can play the
    // sound off the state byte alone. `factions.FIRE_STATE_TICKS`' arrangement,
    // and `NPC_STATE.FIRE` is reused rather than a new byte added: the state is
    // "a strike has just landed", which is what it already means.
    if (actor.state === NPC_STATE.FIRE) {
      if (actor.stateTicks >= STRIKE_STATE_TICKS) {
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
      }
      return;
    }

    const home2 = (actor.x - actor.homeX) * (actor.x - actor.homeX) + (actor.z - actor.homeZ) * (actor.z - actor.homeZ);
    const target = actor.target >= 0 ? combatantById(ctx, actor.target) : undefined;

    // --- Chasing somebody.
    if (target && target.phase !== 'ko' && target.health > 0) {
      const d = planDistance(actor, target);
      if (d > TURKEY_GIVE_UP || home2 > LEASH * LEASH) {
        actor.target = -1;
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
        return;
      }
      if (d > PECK_RANGE) {
        actor.state = NPC_STATE.CHASE;
        stepToward(actor, target.body.position.x, target.body.position.z, TURKEY_CHASE, ctx, TURKEY_RADIUS);
        return;
      }
      // In reach. Face them and peck on the cadence.
      const dx = target.body.position.x - actor.x;
      const dz = target.body.position.z - actor.z;
      const inv = d > 1e-6 ? 1 / d : 0;
      actor.dx = dx * inv;
      actor.dz = dz * inv;
      if (actor.fireCooldown > 0) {
        actor.state = NPC_STATE.CHASE;
        return;
      }
      actor.state = NPC_STATE.FIRE;
      actor.stateTicks = 0;
      actor.fireCooldown = PECK_INTERVAL_TICKS;
      actor.shotsFired++;
      ctx.damagePlayer(target.id, PECK_DAMAGE, actor);
      return;
    }

    // --- Nobody targeted. Anybody inside the territory becomes one, as long as
    // the bird is still within its leash -- a turkey halfway home from the last
    // chase will absolutely start another one, and a turkey at the end of its
    // leash will not, which is what stops one being walked across the suburb.
    actor.target = -1;
    const near = home2 < LEASH * LEASH ? nearestTarget(actor, ctx, TURKEY_AGGRO) : null;
    if (near) {
      actor.target = near.id;
      actor.state = NPC_STATE.CHASE;
      actor.stateTicks = 0;
      return;
    }
    if (home2 > 1.5 * 1.5) {
      actor.state = NPC_STATE.RETURN;
      stepToward(actor, actor.homeX, actor.homeZ, TURKEY_WALK * 2.4, ctx, TURKEY_RADIUS);
      if (abandoned(actor, ctx, WAKE_TURKEY * SLEEP_FACTOR)) resolveActor(actor);
      return;
    }
    actor.state = NPC_STATE.IDLE;
    // Nobody within the wake radius any more: back to being a hash. The bird is
    // standing on its own anchor, so the ambient one appears exactly here.
    if (abandoned(actor, ctx, WAKE_TURKEY * SLEEP_FACTOR)) resolveActor(actor);
  },
});

/**
 * The Australian white ibis. Kind 5. **Never attacks anything.**
 *
 * The user's instruction is one clause -- *"ibises should be similar but not
 * attack u"* -- and the "similar" is doing the work: similar means it is a
 * protected native, so hurting one brings the police, and it means it reacts to
 * you. It does not mean it fights, because a bin chicken does not fight. It
 * waddles off at a pace that makes it clear it was leaving anyway.
 *
 * `think` here has no branch that reads a combatant's health and no call to
 * `ctx.damagePlayer` at all, which is deliberate and is what `checkWildlife`
 * asserts: the guarantee "an ibis never hurts you" should be visible in the
 * shape of the function rather than in a flag somewhere above it.
 */
export const IBIS = registerNpcKind({
  kind: NPC_KIND.IBIS,
  name: 'ibis',
  radius: IBIS_RADIUS,
  height: IBIS_HEIGHT,
  maxHealth: 1,
  walkSpeed: IBIS_WALK,
  chaseSpeed: IBIS_FLEE_SPEED,
  downSeconds: IBIS_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 8,
  feedKo: '%s got done over a bin chicken',
  scoresKo: false,

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        actor.state = NPC_STATE.IDLE;
        actor.stateTicks = 0;
      }
      return;
    }

    // --- Mid-flee. `fireCooldown` counts the flee out rather than a weapon,
    // because an ibis has no weapon and the field is already on the record.
    if (actor.state === NPC_STATE.RETURN && actor.fireCooldown > 0) {
      stepToward(actor, actor.x + actor.dx * 10, actor.z + actor.dz * 10, IBIS_FLEE_SPEED, ctx, IBIS_RADIUS);
      return;
    }

    const near = nearestTarget(actor, ctx, IBIS_FLEE);
    if (near) {
      // Directly away, and the heading is set here rather than integrated so the
      // whole flee runs in a straight line from the instant it started -- a bird
      // that re-aimed every tick would circle its own pursuer.
      const dx = actor.x - near.body.position.x;
      const dz = actor.z - near.body.position.z;
      const d2 = dx * dx + dz * dz;
      const inv = d2 > 1e-6 ? 1 / Math.sqrt(d2) : 0;
      actor.dx = inv === 0 ? 0 : dx * inv;
      actor.dz = inv === 0 ? 1 : dz * inv;
      actor.state = NPC_STATE.RETURN;
      actor.stateTicks = 0;
      actor.fireCooldown = Math.round((IBIS_FLEE_DISTANCE / IBIS_FLEE_SPEED) * 60);
      return;
    }

    // --- Settled. Work the patch, and go back to being a lookup when the street
    // is empty again.
    const home2 = (actor.x - actor.homeX) * (actor.x - actor.homeX) + (actor.z - actor.homeZ) * (actor.z - actor.homeZ);
    if (home2 > 1.5 * 1.5) {
      actor.state = NPC_STATE.WALK;
      stepToward(actor, actor.homeX, actor.homeZ, IBIS_WALK * 2, ctx, IBIS_RADIUS);
    } else {
      actor.state = NPC_STATE.IDLE;
    }
    if (abandoned(actor, ctx, WAKE_IBIS * SLEEP_FACTOR)) resolveActor(actor);
  },
});

/**
 * The swoop: two quadratic Beziers joined at the strike point.
 *
 * Polynomials and no transcendental anywhere -- `traffic.poseCar`'s rule --
 * because the arc is evaluated on the authority and drawn on every client.
 *
 *     P0  the perch          the branch it launches off
 *     C1  half way, dropping the hold: it comes off the branch and *then* dives
 *     S   the strike point   your head, less `STRIKE_LEAD` along the run
 *     C2  the mirror of C1   which is what makes the join smooth
 *     E   past you, climbing the exit, which is why the second one has to come
 *
 * **Joined at S rather than aimed at it**, and that is the whole reason this is
 * two quadratics instead of the one cubic it started as. A cubic does not pass
 * through its control points: the first cut of this put the head at a control
 * point, and the curve's closest approach to a stationary player was **3.26 m**
 * -- a magpie that dived at everybody forever and connected with nobody, and
 * looked perfectly convincing while doing it. Interpolating the strike point
 * makes the closest approach a stated number (`STRIKE_LEAD`, `STRIKE_RISE`)
 * rather than an emergent one, and `verifySwoop` measures it.
 *
 * The two halves share a tangent direction at the join -- `C2` is `S` reflected
 * through `C1` and pulled in -- so the bird does not turn a corner mid-dive; it
 * merely decelerates as it climbs out, which is what one does.
 *
 * `s` runs 0..1 over `SWOOP_TICKS`. **`(tx, ty, tz)` is the commit point, not
 * the player**, and that is the change that made this feature playable. It used
 * to be re-derived every tick against wherever the player *was now*, so the
 * curve homed: a magpie could not be dodged by moving, only outrun, and the
 * reported symptom was exactly that -- *"too hard to avoid"*. It is now frozen
 * at the top of the telegraph by `commitSwoop`, 70 ticks before the strike, and
 * everything downstream of that -- who gets clipped, who gets missed -- falls
 * out of the difference between where you were going and where you went.
 *
 * The arc's plan projection lies **entirely on the ray from the nest through
 * the commit point**: `C1` is on the segment, `S` and `E` are on it, so every
 * control point is. That is why `MAGPIE.think` can store the whole aim as
 * `(dx, dz, barkedAt)` -- a unit heading and a run -- and why the bird's drawn
 * yaw is correct for the whole dive without anybody differencing a position.
 */
function swoopPoint(
  s: number,
  px: number, py: number, pz: number,
  tx: number, ty: number, tz: number,
  hx: number, hz: number,
  out: { x: number; y: number; z: number },
): void {
  const sx = tx - hx * STRIKE_LEAD;
  const sy = ty + STRIKE_RISE;
  const sz = tz - hz * STRIKE_LEAD;
  // The hold: over half the ground covered, having lost half a metre. The steep
  // part of the dive is therefore the second half of the first quadratic, which
  // is what makes it read as a stoop rather than as a glide.
  const c1x = px + (sx - px) * 0.55;
  const c1y = py - SWOOP_HOLD_DROP;
  const c1z = pz + (sz - pz) * 0.55;

  if (s <= 0.5) {
    const u = s * 2;
    const w = 1 - u;
    const a = w * w;
    const b = 2 * w * u;
    const c = u * u;
    out.x = a * px + b * c1x + c * sx;
    out.y = a * py + b * c1y + c * sy;
    out.z = a * pz + b * c1z + c * sz;
    return;
  }
  const u = (s - 0.5) * 2;
  const w = 1 - u;
  const a = w * w;
  const b = 2 * w * u;
  const c = u * u;
  const c2x = sx + (sx - c1x) * 0.32;
  const c2y = sy + (sy - c1y) * 0.32;
  const c2z = sz + (sz - c1z) * 0.32;
  const ex = sx + hx * SWOOP_OVERSHOOT;
  const ey = ty + 2.4;
  const ez = sz + hz * SWOOP_OVERSHOOT;
  out.x = a * sx + b * c2x + c * ex;
  out.y = a * sy + b * c2y + c * ey;
  out.z = a * sz + b * c2z + c * ez;
}

const _swoop = { x: 0, y: 0, z: 0 };

/**
 * Freeze the aim for one pass. Called once, at the top of the telegraph.
 *
 * Stores the whole commit as a **unit heading and a run** -- `(dx, dz)` and
 * `barkedAt` -- which is possible because `swoopPoint`'s plan projection lies on
 * the ray from the nest through the commit point and nowhere else. Two of those
 * three numbers are the bird's own drawn heading, which is what it should be
 * pointing at anyway; the third is a field this faction has to itself.
 *
 * The lead is `velocity * COMMIT_LEAD_TICKS`, clamped to `COMMIT_LEAD_MAX`, and
 * both halves of that matter -- see the constants. No trig: a dot, a sqrt and a
 * divide, all of which `planDistance` and `stepToward` already do.
 */
function commitSwoop(actor: NpcActor, target: CombatantState): void {
  const v = target.body.velocity;
  let lx = v.x * (COMMIT_LEAD_TICKS / 60);
  let lz = v.z * (COMMIT_LEAD_TICKS / 60);
  const l2 = lx * lx + lz * lz;
  if (l2 > COMMIT_LEAD_MAX * COMMIT_LEAD_MAX) {
    const k = COMMIT_LEAD_MAX / Math.sqrt(l2);
    lx *= k;
    lz *= k;
  }
  const hx = target.body.position.x + lx - actor.homeX;
  const hz = target.body.position.z + lz - actor.homeZ;
  const h2 = hx * hx + hz * hz;
  // Straight down the tree is not a run. See `COMMIT_MIN_RUN`.
  if (h2 < COMMIT_MIN_RUN * COMMIT_MIN_RUN) {
    const inv = h2 > 1e-6 ? 1 / Math.sqrt(h2) : 0;
    actor.dx = inv === 0 ? 0 : hx * inv;
    actor.dz = inv === 0 ? 1 : hz * inv;
    actor.barkedAt = COMMIT_MIN_RUN;
    return;
  }
  const inv = 1 / Math.sqrt(h2);
  actor.dx = hx * inv;
  actor.dz = hz * inv;
  actor.barkedAt = 1 / inv;
}

/**
 * Whether this player has already answered the magpie, and the campaign should
 * therefore stop.
 *
 * Two ways, whichever comes first, and both are measured against the **nest**
 * rather than against the bird -- a magpie halfway down its arc is 6 m nearer
 * you than its branch is, and a disengage test that used the bird's own
 * position would decide you were closer every time it dived at you.
 *
 *   - Past `range`. You have left.
 *   - Moving outward faster than `BREAK_OFF_SPEED`. You are leaving, and the
 *     bird does not make you finish the walk first. This is the half that
 *     actually fires: a player who turns and goes trips it on the tick they
 *     turn, roughly a second and a half before the distance test would.
 *
 * **`range` is the caller's, and the two callers pass different ones**, which
 * is not a subtlety so much as the whole disengage rule:
 *
 *   - Between passes, `DISENGAGE_RANGE`. Twelve metres. Continuing to swoop is
 *     a stricter test than starting to.
 *   - Inside a pass already under way -- the telegraph, or the back half of the
 *     dive -- `SWOOP_RANGE`. Twenty. A player who walked in at eighteen was
 *     *allowed* to be at eighteen, and aborting on the tick after the alarm
 *     started because they were outside a radius they never entered would mean
 *     no magpie in the city could ever swoop at anybody standing past twelve
 *     metres. Which is what it meant, for exactly as long as it took the
 *     hit-rate harness to report zero dives at every speed.
 *
 * Stateless on purpose. There is nowhere on `NpcActor` to accumulate "has been
 * going away for a while" that this faction is entitled to, and it turns out
 * not to need one: the radial dot product is already the question, and the
 * cost of the occasional early break-off is a magpie that gave up slightly
 * sooner, which is the direction the whole retune is going in.
 */
function breakingOff(actor: NpcActor, target: CombatantState, range: number): boolean {
  const rx = target.body.position.x - actor.homeX;
  const rz = target.body.position.z - actor.homeZ;
  const r2 = rx * rx + rz * rz;
  if (r2 > range * range) return true;
  if (r2 < 1e-6) return false;
  const inv = 1 / Math.sqrt(r2);
  const outward = (target.body.velocity.x * rx + target.body.velocity.z * rz) * inv;
  return outward >= BREAK_OFF_SPEED;
}

/**
 * Abandon the rest of the engagement: climb out, circle once, perch and glare.
 *
 * `shotsFired` is driven to `MAX_SWOOPS` rather than to some separate flag,
 * because "this campaign is over" is precisely what that value already means
 * everywhere else in this function -- the perched branch reads it as the cue to
 * stare, and the reset when the player finally leaves clears it.
 */
function breakOffSwoop(actor: NpcActor): void {
  actor.shotsFired = MAX_SWOOPS;
  actor.state = NPC_STATE.WALK;
  actor.stateTicks = 0;
  actor.fireCooldown = BREAK_OFF_CIRCLE_TICKS;
}

/**
 * The magpie. Kind 6. *Gymnorhina tibicen*, and the reason Australians wear
 * cable ties on their helmets for six weeks a year.
 *
 * Perches on its nest until somebody enters `SWOOP_RANGE`, then runs a
 * telegraph-and-dive cycle at them until they leave or it runs out of passes:
 *
 *     IDLE  --(inside 20 m)-->  AIM  --(50 ticks)-->  CHASE/FIRE  -->  WALK
 *      ^                         |                     |               |
 *      |                         `--- break off -------'               |
 *      `--------------------- circle 55 ticks ---------------------- --'
 *
 * The damage is a quarter pip a pass, which is small -- the swoop is not
 * supposed to kill you, it is supposed to make you go a different way.
 *
 * ---------------------------------------------------------------------------
 * **Three fields do double duty here**, and all three look like bugs until you
 * know which phase you are in. `NpcActor` is a wire record three factions share
 * and this one is not entitled to grow it, so the per-engagement state lives in
 * fields the framework does not read while a magpie is using them:
 *
 *   - **`downTicks`** -- outside `NPC_STATE.DOWN` nothing reads it and only
 *     `strikeNpc` writes it, so a dive borrows it as the "this pass has already
 *     connected" guard. `strikeNpc` overwrites it on a knockdown, which is
 *     exactly the moment the dive stops mattering.
 *   - **`barkedAt`** -- the framework's aggro-bark clock, which a magpie can
 *     never set: `FactionField.bark` returns on the first line for a kind with
 *     no `aggroClips`, and this one has none. From the top of a telegraph until
 *     the end of the dive it holds the **committed run in metres**; while
 *     perched with nobody in range it holds the **re-aggro cooldown in ticks**.
 *     Those two phases cannot overlap, and the transition between them is
 *     always through the perched branch, which sets it.
 *   - **`dx, dz`** -- the drawn heading, which for a committed dive *is* the
 *     unit direction of the whole arc. Storing the aim there costs nothing and
 *     removes the per-tick position differencing that used to compute it.
 */
export const MAGPIE = registerNpcKind({
  kind: NPC_KIND.MAGPIE,
  name: 'magpie',
  radius: MAGPIE_RADIUS,
  height: MAGPIE_HEIGHT,
  maxHealth: 1,
  walkSpeed: 1.2,
  chaseSpeed: 12,
  downSeconds: MAGPIE_DOWN_SECONDS,
  aggroClips: [],
  aggroCooldownSeconds: 5,
  feedKo: '%s got swooped into next week',
  scoresKo: false,

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        // Back to the branch rather than back to the ground it fell on.
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
        actor.shotsFired = 0;
        // And with a clean `barkedAt`, which was a committed run when it was
        // knocked out of the air. Left alone it would be read as a few ticks of
        // re-aggro cooldown, which is not wrong so much as meaningless.
        actor.barkedAt = 0;
      }
      return;
    }

    const target = actor.target >= 0 ? combatantById(ctx, actor.target) : undefined;
    // The branch, derived rather than stored: `NpcActor` has no `homeY` and this
    // faction is not entitled to add one to a wire record three factions share.
    // The nest was hung `NEST_HEIGHT` over the footpath, and the footpath is
    // what `groundHeight` answers at the nest's own x/z -- so the perch is the
    // same height in every process without a byte moving.
    //
    // **`-Infinity` for the feet, and it is load-bearing.** That argument is
    // `collision.roofHeight`'s "how high is the asker", and both authorities
    // fold a roof under it into the answer. A nest is derived from a footpath
    // band and offset toward the building line, so some of them stand inside a
    // footprint -- and asking from seven metres up would return the *roof* and
    // perch the bird on top of a terrace with another seven metres of air under
    // it. Asking from below every base in the city returns the terrain, which
    // is what a street tree is rooted in.
    const perchY = ctx.groundHeight(actor.homeX, actor.homeZ, -Infinity) + NEST_HEIGHT;

    // --- The telegraph. On the branch, screaming, aim already frozen.
    //
    // The aim is committed on the tick this state is *entered* rather than on
    // the tick it ends, which is the whole point: the player has the entire
    // `TELEGRAPH_TICKS` to invalidate a decision the bird has already made. A
    // magpie that recommitted at launch would merely be a magpie with a longer
    // wind-up, and would have exactly the old hit rate.
    if (actor.state === NPC_STATE.AIM) {
      actor.x = actor.homeX;
      actor.z = actor.homeZ;
      actor.y = perchY;
      // Answered before it ever left the branch. This is the cheapest possible
      // escape and it is meant to be: hear it, turn, go.
      if (!target || breakingOff(actor, target, SWOOP_RANGE)) {
        breakOffSwoop(actor);
        return;
      }
      if (actor.stateTicks >= TELEGRAPH_TICKS) {
        actor.downTicks = 0;
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
      }
      return;
    }

    // --- Mid-dive. The arc owns the position outright; nothing else moves it.
    // FIRE is entered inside the dive when the pass connects and is held for the
    // rest of it, so a client can play the impact off the rising edge of a state
    // byte it is already decoding -- and the dive keeps its own clock, because
    // `stateTicks` is the curve's parameter and restarting it would rewind the
    // bird to the branch.
    if ((actor.state === NPC_STATE.CHASE || actor.state === NPC_STATE.FIRE) && target) {
      const s = actor.stateTicks / SWOOP_TICKS;
      if (s >= 1) {
        actor.state = NPC_STATE.WALK;
        actor.stateTicks = 0;
        actor.fireCooldown = CIRCLE_TICKS;
        return;
      }
      // The commit, unpacked. A heading and a run, frozen by `commitSwoop`
      // `TELEGRAPH_TICKS` ago and not touched since -- so this curve is the same
      // curve on every tick of the dive, and a player who moved after the commit
      // is a player the bird is going to miss.
      //
      // **The commit's height is asked of the ground rather than of the
      // player**, and for `perchY`'s reason one field up: the strike point has
      // to be at the head height of somebody standing *there*, which is
      // `groundHeight` plus an eye. Reading `target.body.position.y` here would
      // re-introduce exactly the tracking the commit exists to remove -- a
      // player who jumped would drag the arc up with them.
      const run = actor.barkedAt;
      const cx = actor.homeX + actor.dx * run;
      const cz = actor.homeZ + actor.dz * run;
      const cy = ctx.groundHeight(cx, cz, -Infinity) + EYE_HEIGHT;
      swoopPoint(s, actor.homeX, perchY, actor.homeZ, cx, cy, cz, actor.dx, actor.dz, _swoop);
      const nx = _swoop.x;
      const ny = _swoop.y;
      const nz = _swoop.z;
      // No heading update: `(dx, dz)` already *is* the plan direction of this
      // arc for every tick of it -- see `swoopPoint` -- and overwriting it would
      // throw away the aim it is holding.
      actor.x = nx;
      actor.y = ny;
      actor.z = nz;

      // The pass. One connection a dive -- see the note on `downTicks` -- and
      // only in the `STRIKE_WINDOW_TICKS` around the bottom of the arc, so the
      // climb-out cannot collect somebody the dive itself went past.
      //
      // Measured against where the player **is**, not against the commit: the
      // commit decides where the bird goes and the player's real position
      // decides whether that was the right guess. Those being different numbers
      // is the feature.
      const fromStrike = actor.stateTicks - SWOOP_TICKS * 0.5;
      if (actor.downTicks === 0 && fromStrike >= -STRIKE_WINDOW_TICKS && fromStrike <= STRIKE_WINDOW_TICKS) {
        const ddx = nx - target.body.position.x;
        const ddy = ny - target.body.position.y;
        const ddz = nz - target.body.position.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz <= SWOOP_HIT_RADIUS * SWOOP_HIT_RADIUS) {
          actor.downTicks = 1;
          actor.state = NPC_STATE.FIRE;
          ctx.damagePlayer(target.id, SWOOP_DAMAGE, actor);
        }
      }

      // And the break-off, from the bottom of the arc onward. The dive itself is
      // committed -- a bird halfway through a stoop does not stop -- but the
      // *next* one is not, and cancelling it here rather than at the top of the
      // circle is what makes "turn and run" end the engagement inside the pass
      // you are already in rather than one after it.
      if (fromStrike >= 0 && actor.shotsFired < MAX_SWOOPS && breakingOff(actor, target, SWOOP_RANGE)) {
        actor.shotsFired = MAX_SWOOPS;
      }
      return;
    }

    // --- Between dives: circling. Held above the nest, which is where the
    // player looks for it, and it is where the next dive starts from.
    if (actor.state === NPC_STATE.WALK) {
      actor.x = actor.homeX;
      actor.z = actor.homeZ;
      actor.y = perchY + 2.5;
      if (actor.fireCooldown > 0) return;
      actor.state = NPC_STATE.IDLE;
      actor.stateTicks = 0;
      return;
    }

    // --- On the branch, or coming back to it.
    actor.x = actor.homeX;
    actor.z = actor.homeZ;
    actor.y = perchY;
    if (actor.state === NPC_STATE.RETURN) {
      actor.state = NPC_STATE.IDLE;
      actor.stateTicks = 0;
    }

    const near = nearestTarget(actor, ctx, SWOOP_RANGE);
    if (!near) {
      actor.target = -1;
      actor.state = NPC_STATE.IDLE;
      // Out of the radius. The campaign is over and the count resets -- and the
      // **cooldown is armed on the same edge**, which is what stops walking out
      // and straight back in being a way to farm a fresh pair of swoops. See
      // `REAGGRO_COOLDOWN_TICKS`.
      //
      // `shotsFired > 0` is the edge: it is non-zero for exactly as long as an
      // engagement has been running, so this arms once rather than every tick,
      // and the `else` is then free to run the cooldown down. That is also the
      // invariant that keeps `barkedAt`'s double duty honest -- every path to
      // `shotsFired === 0` outside a dive passes through here or through the
      // knockdown, and both of them write the field.
      if (actor.shotsFired > 0) {
        actor.shotsFired = 0;
        actor.barkedAt = REAGGRO_COOLDOWN_TICKS;
      } else if (actor.barkedAt > 0) {
        actor.barkedAt--;
      }
      if (abandoned(actor, ctx, WAKE_MAGPIE * SLEEP_FACTOR)) resolveActor(actor);
      return;
    }
    actor.target = near.id;
    if (actor.shotsFired >= MAX_SWOOPS) {
      // Perched, watching, and it will not go again until you have left. The
      // stare is the point: the bird has won and both of you know it.
      actor.state = NPC_STATE.IDLE;
      return;
    }
    // Mid-campaign, between passes: continuing is a stricter test than starting.
    // `SWOOP_RANGE` got you the first swoop; the rest are gated on
    // `DISENGAGE_RANGE` and on not already leaving, so a player who ran during
    // the circle does not get dived on when it ends.
    if (actor.shotsFired > 0 && breakingOff(actor, near, DISENGAGE_RANGE)) {
      breakOffSwoop(actor);
      return;
    }
    // A returning player, inside the cooldown: one warning pass, not a campaign.
    // The `++` below takes this to `MAX_SWOOPS`, so the pass happens and the
    // stare follows it immediately.
    if (actor.shotsFired === 0 && actor.barkedAt > 0) actor.shotsFired = MAX_SWOOPS - 1;
    actor.shotsFired++;
    // The aim, frozen here and read for the next `TELEGRAPH_TICKS + SWOOP_TICKS`
    // ticks. Everything about whether this pass lands was decided on this line.
    commitSwoop(actor, near);
    actor.state = NPC_STATE.AIM;
    actor.stateTicks = 0;
  },
});

// --- Promotion ---------------------------------------------------------------------------

/**
 * Wake the birds near the players. **Authority only**, once a tick, before
 * `FactionField.step`.
 *
 * This is the whole of the ambient-to-promoted transition and it is deliberately
 * outside the framework: `FactionField.recruit` is the *police's* rule for
 * getting officers onto a suspect, and a faction whose actors appear because
 * somebody walked past a tree has nothing to say to it. The order is fixed --
 * combatants ascending (the tick order `FactionCtx.combatants` promises), then
 * `forEachWildlifeNear`'s own fixed order -- so the same birds wake in the same
 * order on the server and in an offline browser.
 *
 * A refused promotion (the cap, or the budget) is a no-op. The bird stays
 * ambient, which is what it already was, and the player sees nothing at all.
 */
export function stepWildlife(ctx: FactionCtx, scratch: WildScratch, pose: WildPose): void {
  const field = ctx.field;
  let live = 0;
  for (const a of field.actors) if (isProtected(a.kind)) live++;
  if (live >= WILDLIFE_BUDGET) return;

  let budget = PROMOTIONS_PER_TICK;
  const ground = (x: number, z: number): number => ctx.groundHeight(x, z, Infinity);

  for (const c of ctx.combatants) {
    if (budget <= 0 || live >= WILDLIFE_BUDGET) return;
    if (c.phase === 'ko' || c.health <= 0) continue;
    const px = c.body.position.x;
    const pz = c.body.position.z;
    forEachWildlifeNear(ctx.peds, px, pz, WAKE_MAGPIE, ctx.tick, ground, scratch, pose, (p) => {
      if (budget <= 0 || live >= WILDLIFE_BUDGET) return true;
      // Each species has its own reach, and the query runs at the widest of
      // them: one pass over the anchors rather than three.
      const reach = wakeRadius(p.kind);
      const dx = p.x - px;
      const dz = p.z - pz;
      if (dx * dx + dz * dz > reach * reach) return;
      if (anchorLive(field.actors, p)) return;
      const actor = field.promote(p.kind, p.x, p.y, p.z, p.dx, p.dz, -1);
      if (actor === null) return true;
      // **Homed on the anchor, not on the spawn point.** `promote` sets
      // `homeX/homeZ` to wherever the actor appeared, which for a bird is
      // wherever its stroll had got to -- up to `STROLL_RADIUS` from the anchor.
      // Pinning it to the anchor instead is what makes `anchorLive` exact, what
      // makes a magpie dive from its own branch rather than from mid-air, and
      // what a `RETURN` walks back to.
      actor.homeX = p.ax;
      actor.homeZ = p.az;
      actor.state = NPC_STATE.IDLE;
      live++;
      budget--;
    });
  }
}

/**
 * Whether this anchor already has a live actor on it.
 *
 * A quarter-metre compare against `homeX/homeZ`, which `stepWildlife` pins to
 * the anchor exactly so this can be exact. The alternative -- matching on the
 * actor's *current* position -- would re-promote every turkey the moment it
 * chased somebody more than a metre, and the symptom is a park that slowly
 * fills with birds until the cap stops it.
 */
function anchorLive(actors: readonly NpcActor[], p: WildPose): boolean {
  for (const a of actors) {
    if (a.kind !== p.kind) continue;
    const dx = a.homeX - p.ax;
    const dz = a.homeZ - p.az;
    if (dx * dx + dz * dz < 0.0625) return true;
  }
  return false;
}

/**
 * Report the crime for a strike on a protected native. **Unconditional.**
 *
 * One call, from the two places a strike is adjudicated (`server/sim.hitNpc`
 * online, `main.ts`'s swing offline), and it is a function here rather than a
 * `reportCrime` at each of those sites so that the rule -- *which* kinds, and
 * *no* witness test -- is written once, in the module that owns the animals.
 * Returns whether anything was reported, which is what the caller uses to
 * decide whether to open its optimistic banner.
 */
export function reportWildlifeCrime(kind: number, attackerId: number): boolean {
  if (!isProtected(kind)) return false;
  reportCrime(attackerId, REASON.WILDLIFE);
  return true;
}

// --- The self-check -------------------------------------------------------------------

/**
 * Everything about this feature that fails by rendering a plausible city.
 *
 * The failures are all quiet, which is the criterion for being in here at all:
 *
 *   - A **park outside the built extent** puts birds on tiles that do not
 *     exist, where `groundAt` has nothing to answer with. They stand at the
 *     height of whoever asked last, which is a turkey hovering over the harbour
 *     and is visible from exactly one camera angle.
 *   - A **cell smaller than twice the leash** lets a chasing turkey get nearer
 *     to its neighbour's anchor than to its own, and the renderer -- which
 *     matches live actors back to anchors by distance, because the wire carries
 *     no identity -- then draws the ambient bird *and* the live one. Two
 *     turkeys, one of which is a ghost.
 *   - An **anchor scheme that is not a pure function** is a bird that is in a
 *     different place on the server than on the client, so the one you bat is
 *     not the one you can see. It is checked here by evaluating the same query
 *     twice and again from a different query centre, because a scheme keyed off
 *     the *query* rather than off the world passes the first test and fails the
 *     second.
 *   - A **swoop arc that does not pass through head height** is a magpie that
 *     dives at your feet, which reads as the bird being badly animated rather
 *     than as the hit test never firing.
 *   - A **swoop arc that still tracks** is the one the user reported. It is the
 *     quietest failure in this list because there is nothing to see: the bird
 *     dives beautifully, connects every time, and the only evidence is a player
 *     who has worked out that moving does not help. `verifySwoop` pins it from
 *     both ends -- a player who stayed on the commit point is hit, one who
 *     sprinted clear of it is not -- and the tuning block below pins the
 *     numbers that make the second of those true.
 *   - An **unregistered kind** draws nothing at all: the snapshot carries the
 *     byte, `npcKind` returns undefined, and `npcHitTest` skips it. A bird you
 *     can neither see nor hit, on a wire that says it is there.
 *
 * `kit` is `world/wildlife.WildlifeAssets`' triangle counts, handed in rather
 * than imported -- `verifyPolice(kitTriangles)`' precedent, and for the
 * identical reason: this module compiles into the Bun server and must not drag
 * the renderer in behind it.
 */
export function verifyWildlife(kit?: { turkey: number; ibis: number; magpie: number }): string[] {
  const failures: string[] = [];

  // --- The kinds, and the bytes they claimed.
  if (NPC_KIND.TURKEY !== 4 || NPC_KIND.IBIS !== 5 || NPC_KIND.MAGPIE !== 6) {
    failures.push(
      `The wildlife bytes are ${NPC_KIND.TURKEY}/${NPC_KIND.IBIS}/${NPC_KIND.MAGPIE}, not 4/5/6. ` +
        'They are on the wire: a client and a server that disagree draw a magpie as a police officer.',
    );
  }
  if (TURKEY !== NPC_KIND.TURKEY || IBIS !== NPC_KIND.IBIS || MAGPIE !== NPC_KIND.MAGPIE) {
    failures.push('A registration returned a byte other than the one it claimed.');
  }

  // --- The parks, against the extent they were extracted inside.
  if (PARKS.length < 100) {
    failures.push(`Only ${PARKS.length} parks are baked; the extract found 248.`);
  }
  for (const park of PARKS) {
    const d = Math.sqrt(park.x * park.x + park.z * park.z);
    if (d > PARK_EXTENT_M) {
      failures.push(
        `${park.name} is ${d.toFixed(0)} m from the origin, outside the ${PARK_EXTENT_M} m extent. ` +
          'Its birds would stand on tiles that do not exist.',
      );
    }
    if (!(park.r >= 12) || !Number.isFinite(park.r)) {
      failures.push(`${park.name} has an inscribed radius of ${park.r} m; the bake floor is 12.`);
    }
    if (!Number.isFinite(park.x) || !Number.isFinite(park.z)) {
      failures.push(`${park.name} has a coordinate that is not a number.`);
    }
  }
  // Sydney Park is the spawn park -- `spawn.SPAWN_TARGET` is 32 m from its pole
  // of inaccessibility -- and it is the first parkland any player stands in. A
  // table that lost it would still look complete.
  {
    const sx = -2236.379;
    const sz = 4543.317;
    let hit: Park | null = null;
    for (const park of PARKS) {
      const dx = park.x - sx;
      const dz = park.z - sz;
      if (dx * dx + dz * dz <= park.r * park.r) hit = park;
    }
    if (hit === null) {
      failures.push(
        'The spawn point is not inside any baked park. Players land in Sydney Park and the ' +
          'turkeys there are the first thing this feature is judged on.',
      );
    }
  }

  // --- The cell against the leash. See the header of `TURKEY_CELL`.
  if (TURKEY_CELL < LEASH * 2) {
    failures.push(
      `Turkey cells are ${TURKEY_CELL} m apart and a turkey may chase ${LEASH} m from its anchor. ` +
        'A live bird could be nearer another anchor than its own, and the renderer would draw both.',
    );
  }
  if (STROLL_RADIUS * 2 >= TURKEY_CELL / 2) {
    failures.push('An ambient bird wanders far enough to leave its own cell; the grid would show.');
  }

  // --- The tuning that has a right answer.
  if (TURKEY_AGGRO !== 8) failures.push(`Turkeys aggro at ${TURKEY_AGGRO} m, not the specified 8.`);
  if (TURKEY_GIVE_UP <= TURKEY_AGGRO) {
    failures.push('A turkey gives up inside its own aggro range, so it would attack and immediately stop.');
  }
  if (TURKEY_CHASE <= 4 || TURKEY_CHASE >= 6) {
    failures.push(
      `Turkeys chase at ${TURKEY_CHASE} m/s. It has to sit between a player's walk and their sprint, ` +
        'or the chase is either unloseable or pointless.',
    );
  }
  if (SWOOP_RANGE !== 20) failures.push(`Magpies engage at ${SWOOP_RANGE} m, not the specified 20.`);
  if (MAX_SWOOPS < 2 || MAX_SWOOPS > 3) failures.push(`Magpies swoop ${MAX_SWOOPS} times; the brief says 2-3.`);
  // --- The mercy, which is the half of the magpie that was reported broken.
  //
  // Every one of these fails as *a magpie that is not dodgeable*, which is a
  // thing the player experiences and no other check in this file can see: the
  // arc would still be continuous, still pass through head height, still be
  // bit-identical on both authorities, and still be the thing the user asked to
  // have fixed.
  if (DISENGAGE_RANGE >= SWOOP_RANGE) {
    failures.push(
      `Magpies engage at ${SWOOP_RANGE} m and disengage at ${DISENGAGE_RANGE} m. A disengage radius at or ` +
        'outside the aggro radius is the old behaviour: the engagement only ends where it would have ' +
        'started, so a fleeing player eats the rest of the campaign on the way out.',
    );
  }
  if (TELEGRAPH_TICKS < 42 || TELEGRAPH_TICKS > 60) {
    failures.push(
      `The alarm leads the dive by ${(TELEGRAPH_TICKS / 60).toFixed(2)} s. Under 0.7 there is no time to ` +
        'read it and over 1.0 the bird is announcing something that has stopped being a surprise.',
    );
  }
  if (COMMIT_LEAD_TICKS >= TELEGRAPH_TICKS + SWOOP_TICKS * 0.5) {
    failures.push(
      `The commit leads by ${COMMIT_LEAD_TICKS} ticks and the strike lands ` +
        `${TELEGRAPH_TICKS + SWOOP_TICKS * 0.5} ticks after it. A lead that covers the whole flight is a ` +
        'magpie that hits a player moving at constant velocity every single time -- which is the ' +
        'tracking swoop this was rebuilt to remove, wearing a telegraph.',
    );
  }
  if (COMMIT_LEAD_MAX * 60 / COMMIT_LEAD_TICKS >= 8.2) {
    failures.push(
      `The lead cap is ${COMMIT_LEAD_MAX} m over ${COMMIT_LEAD_TICKS} ticks, which reads a player moving at ` +
        `${(COMMIT_LEAD_MAX * 60 / COMMIT_LEAD_TICKS).toFixed(1)} m/s. A sprint is 8.2, so the cap has to ` +
        'bite below it or sprinting past a nest is not a dodge.',
    );
  }
  if (BREAK_OFF_SPEED >= 4.4) {
    failures.push(
      `A magpie breaks off at ${BREAK_OFF_SPEED} m/s of outward travel and a walk is 4.4. Turning your back ` +
        'and walking has to be enough, or the only answer to a magpie is a sprint.',
    );
  }
  if (STRIKE_WINDOW_TICKS * 2 >= SWOOP_TICKS) {
    failures.push(
      `The hit window is ${STRIKE_WINDOW_TICKS * 2} of the dive's ${SWOOP_TICKS} ticks, which is the whole ` +
        'arc. The climb-out would collect players the dive itself went past.',
    );
  }
  if (REAGGRO_COOLDOWN_TICKS < 10 * 60) {
    failures.push(
      `The re-aggro cooldown is ${(REAGGRO_COOLDOWN_TICKS / 60).toFixed(0)} s. Under ten, stepping out of ` +
        'the radius and back is a way of ordering more swoops.',
    );
  }
  if (PECK_DAMAGE !== 0.25 || SWOOP_DAMAGE !== 0.25) {
    failures.push('A peck or a swoop is not the specified quarter pip.');
  }
  if (PECK_INTERVAL_TICKS !== 60) failures.push(`Pecks land every ${PECK_INTERVAL_TICKS} ticks, not the specified 60.`);
  if (STRIKE_STATE_TICKS < 3) {
    failures.push(
      `A strike is held for ${STRIKE_STATE_TICKS} ticks and snapshots go out every 3. One peck in three ` +
        'would never be sampled, so a client would hear some of them and not others.',
    );
  }
  if (WILDLIFE_BUDGET >= 24) {
    failures.push(`The wildlife budget is ${WILDLIFE_BUDGET} of a 24-actor field; a flock would starve the police.`);
  }
  for (const [name, reach] of [['turkey', WAKE_TURKEY], ['magpie', WAKE_MAGPIE]] as const) {
    const behaviour = name === 'turkey' ? TURKEY_AGGRO : SWOOP_RANGE;
    if (reach <= behaviour) {
      failures.push(
        `A ${name} wakes at ${reach} m and acts at ${behaviour} m, so the first frame of every ` +
          'encounter is the frame the bird appears out of nothing.',
      );
    }
  }

  // --- The ibis has no way to hurt anybody, asserted from the registered
  // function's own source rather than from a comment above it.
  //
  // `Function.prototype.toString` is a blunt instrument and it is the right one
  // here: the guarantee is *"this function never calls damagePlayer"*, which is
  // a syntactic claim about a body, and every other way of testing it -- a flag
  // on the registration, a spy on the context -- tests something adjacent
  // instead. Read out of the framework's registry rather than off the local
  // `const`, so it is the function the authority will actually run.
  {
    const registered = npcKind(NPC_KIND.IBIS);
    if (registered === undefined) {
      failures.push('The ibis kind is not registered; the byte would arrive on the wire and draw nothing.');
    } else if (String(registered.think).includes('damagePlayer')) {
      failures.push('The ibis `think` calls damagePlayer. The user asked for one bird that does not attack.');
    }
    if (npcKind(NPC_KIND.TURKEY) === undefined) failures.push('The turkey kind is not registered.');
    if (npcKind(NPC_KIND.MAGPIE) === undefined) failures.push('The magpie kind is not registered.');
  }

  // --- The swoop arc: continuity, and that it comes through head height.
  failures.push(...verifySwoop());

  // --- Determinism of the anchors, twice over. See the header.
  failures.push(...verifyAnchors());

  // --- The kit, if the renderer built one.
  if (kit !== undefined) {
    if (kit.turkey <= 0 || kit.ibis <= 0 || kit.magpie <= 0) {
      failures.push('A wildlife model has no triangles in it; the bird would be invisible and still peck.');
    }
    if (kit.turkey > 320) failures.push(`The turkey is ${kit.turkey} triangles, over the 320 budget.`);
    if (kit.magpie > 220) failures.push(`The magpie is ${kit.magpie} triangles, over the 220 budget.`);
    if (kit.ibis > 220) failures.push(`The ibis is ${kit.ibis} triangles, over the 220 budget.`);
  }

  return failures;
}

/**
 * The arc, sampled, against the **commit point** it is now built around.
 *
 * Six assertions and each one is a different way it goes wrong: a curve that
 * does not start on the branch, one that does not finish past you, one that
 * never reaches head height, one with a discontinuity in it -- which draws as a
 * magpie teleporting mid-dive -- and, since the arc stopped tracking, the two
 * that describe what the commit is *for*: a player who is still on the commit
 * point gets clipped, and a player who has left it does not.
 *
 * **The last pair is the arc contract now.** Before the retune the curve was
 * re-derived every tick against the live player, so "does it connect" was a
 * property of the hit radius alone and the only interesting question was
 * whether the closest approach was inside it. Now the closest approach is to a
 * point the player has had `MAGPIE_TUNING.flightTicks` to leave, and the number
 * that decides an encounter is how far they got. Pinning only the old property
 * would pass on a magpie whose commit was recomputed at launch -- which is a
 * magpie with a longer wind-up and the identical hit rate.
 */
function verifySwoop(): string[] {
  const failures: string[] = [];
  const px = 0;
  const py = NEST_HEIGHT;
  const pz = 0;
  // The commit point: 14 m down the street, at the head height of somebody
  // standing there. `swoopPoint` is handed this rather than a live player.
  const cx = 0;
  const cy = EYE_HEIGHT;
  const cz = 14;
  const hx = 0;
  const hz = 1;
  const out = { x: 0, y: 0, z: 0 };
  const N = 64;
  let prevX = 0;
  let prevY = 0;
  let prevZ = 0;
  let maxStep = 0;
  let minHeadGap = Infinity;
  // And the same arc against a player who kept moving. Two of them: one who
  // carried straight on down the ray the bird committed to (the hardest case to
  // miss, because the overshoot follows them) and one who went across it.
  let minAlongGap = Infinity;
  let minAcrossGap = Infinity;
  // How far a sprint gets between the commit and the strike, less the lead the
  // magpie is allowed to apply. Derived rather than chosen, so the pin moves
  // when the tuning does and fails when the tuning stops working.
  const dodge = 8.2 * (MAGPIE_TUNING.flightTicks / 60) - COMMIT_LEAD_MAX;
  for (let i = 0; i <= N; i++) {
    const s = i / N;
    swoopPoint(s, px, py, pz, cx, cy, cz, hx, hz, out);
    if (i === 0) {
      if (Math.abs(out.x - px) > 1e-9 || Math.abs(out.y - py) > 1e-9 || Math.abs(out.z - pz) > 1e-9) {
        failures.push('The swoop does not start on the perch. The bird would appear beside the tree.');
      }
    } else {
      const dx = out.x - prevX;
      const dy = out.y - prevY;
      const dz = out.z - prevZ;
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (step > maxStep) maxStep = step;
    }
    // Only the part of the arc a pass may actually land in; outside the window
    // the hit test does not run, so a near approach there is not a hit.
    const fromStrike = Math.abs(s * SWOOP_TICKS - SWOOP_TICKS * 0.5);
    if (fromStrike <= STRIKE_WINDOW_TICKS) {
      minHeadGap = Math.min(minHeadGap, gapTo(out, cx, cy, cz));
      minAlongGap = Math.min(minAlongGap, gapTo(out, cx, cy, cz + dodge));
      minAcrossGap = Math.min(minAcrossGap, gapTo(out, cx + dodge, cy, cz));
    }
    prevX = out.x;
    prevY = out.y;
    prevZ = out.z;
  }
  if (minHeadGap > SWOOP_HIT_RADIUS) {
    failures.push(
      `The closest the arc comes to a player still standing on the commit point is ${minHeadGap.toFixed(2)} m, ` +
        `and the hit radius is ${SWOOP_HIT_RADIUS}. The magpie would dive past everybody forever.`,
    );
  }
  if (minAlongGap <= SWOOP_HIT_RADIUS || minAcrossGap <= SWOOP_HIT_RADIUS) {
    failures.push(
      `A player who sprinted ${dodge.toFixed(1)} m clear of the commit point between the alarm and the strike ` +
        `is still inside the hit radius (${Math.min(minAlongGap, minAcrossGap).toFixed(2)} m). The commit is ` +
        'not actually committed -- the arc is tracking, and nothing a player does with their feet matters.',
    );
  }
  // The curve is sampled 64 times over a run of about 20 m, so a step much over
  // a metre is a control point in the wrong place rather than a fast bird.
  if (maxStep > 1.5) {
    failures.push(`The swoop jumps ${maxStep.toFixed(2)} m between adjacent samples; the arc is discontinuous.`);
  }
  // And it has to finish beyond the commit point, or the bird lands on it.
  swoopPoint(1, px, py, pz, cx, cy, cz, hx, hz, out);
  if (out.z <= cz + 1 || out.y <= cy) {
    failures.push('The swoop does not climb out past the player; the magpie would end the dive on their head.');
  }
  return failures;
}

/** Distance from a sampled arc point to a head. Local to `verifySwoop`. */
function gapTo(p: { x: number; y: number; z: number }, x: number, y: number, z: number): number {
  const dx = p.x - x;
  const dy = p.y - y;
  const dz = p.z - z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The anchors, evaluated twice and from two different query centres.
 *
 * The second half is the one that catches a real bug: a scheme that hashes the
 * *query* rather than the world is perfectly repeatable and completely wrong,
 * and the only way to see it is to ask the same question from somewhere else.
 */
function verifyAnchors(): string[] {
  const failures: string[] = [];
  const scratch = createWildScratch();
  const pose = createWildPose();
  const ground = (): number => 0;
  const tick = 1_000_000;

  const gather = (qx: number, qz: number, radius: number): string[] => {
    const seen: string[] = [];
    forEachWildlifeNear(null, qx, qz, radius, tick, ground, scratch, pose, (p) => {
      seen.push(`${p.kind}:${p.ax.toFixed(3)},${p.az.toFixed(3)}`);
    });
    return seen;
  };

  // Sydney Park, which is where the players are.
  const a = gather(-2240, 4575, 140);
  const b = gather(-2240, 4575, 140);
  if (a.length === 0) {
    failures.push('No birds at all within 140 m of the middle of Sydney Park, which is the spawn park.');
  }
  if (a.join('|') !== b.join('|')) {
    failures.push('Two evaluations of the same anchor query disagreed. The scheme is not a pure function.');
  }
  // The same anchors from a query 60 m away: everything the smaller query found
  // that is still in range has to be identical, position included.
  const wide = new Set(gather(-2180, 4575, 220));
  let missing = 0;
  for (const key of a) if (!wide.has(key)) missing++;
  if (missing > 0) {
    failures.push(
      `${missing} of ${a.length} birds moved when the query centre did. The anchors are keyed off the ` +
        'query rather than off the world, so the server and the client would place them differently.',
    );
  }
  return failures;
}
