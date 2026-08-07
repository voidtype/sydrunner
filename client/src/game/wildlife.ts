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
 *   - **Turkeys** come out of `PARKS`, a table of 1,345 park polygons reduced to
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
 * that is to carry the rings and run a point-in-polygon test, which is 1,345
 * polygons, tens of thousands of vertices, a decoder, a sidecar and a broadphase --
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
 * 248 parks survive `area >= 4,000 m2` and `r >= 12 m` inside the 5,300 m inner
 * ring and 1,097 more inside 15,300 m, from 7,812 candidate polygons; the discs
 * total 25.94 km2 of guaranteed-green ground, up from 4.86. Sorted by radius
 * **within each block**, so the table opens on the parks a player has heard of
 * and the middle ring opens on Rookwood. The names are
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

const PARKS_INNER: readonly Park[] = [
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

/**
 * The 5,300 - 15,300 m middle ring: 1,097 more discs, packed into a string.
 *
 * **Packed, and this is `streetlife.VENUE_XZ`'s argument arriving at the parks.**
 * Two hundred and forty-eight records with names is a table a reader checks by
 * eye and it is why the block above is still a record literal; thirteen hundred
 * is twenty pages nobody reads, and as a record literal it would be 70 kB of
 * source for 44 kB of information. `name|x|z|r`, records separated by `;`,
 * parsed once at module load into the same `Park` shape -- so nothing
 * downstream knows there are two blocks, and the frozen one stays legible.
 *
 * Names carry their OSM value where there is one and the inner block's
 * synthesised `tag x,z` where there is not, so a check message reads the same
 * either side of the fence.
 */
const PARKS_MIDDLE_PACKED =
  'Rookwood Cemetery|-14184.2|798.5|804.6;Manly Warringah War Memorial State Park|2614.8|-11515' +
  '.7|514.1;park -13363,-4110|-13363.2|-4109.7|466.6;North Head Private Nature Reserve|8082.9|-' +
  '6178.5|363.2;Lane Cove National Park|-5825.1|-8362.9|362.0;Macquarie Park Cemetery and Crema' +
  'torium|-6589.4|-8482.2|326.0;Garigal National Park|1225.4|-11336.2|318.0;Heffron Park|2531.0' +
  '|8933.9|314.0;Sydney Harbour National Park|7284.6|-5790.6|309.2;Bicentennial Park|-12138.6|-' +
  '2022.6|291.7;Malabar Headland National Park|5066.9|10626.4|286.0;Sydney Harbour National Par' +
  'k|5659.9|-6733.9|264.4;Field of Mars Reserve|-7259.4|-5913.9|232.9;Sydney Showground|-13196.' +
  '1|-2656.6|222.8;Harold Reid Reserve|771.1|-8248.3|214.7;George Kendall Riverside Park|-13676' +
  '.1|-4987.5|212.6;Eastern Suburbs Memorial Park|1974.1|11634.2|211.1;Newington Nature Reserve' +
  '|-13077.2|-4576.7|210.2;Boronia Park|-6376.4|-4733.2|199.4;Majors Bay Reserve|-10343.9|-2422' +
  '.6|197.1;Tempe Reserve|-4399.2|6887.4|196.1;park 6644,-11533|6644.0|-11533.0|190.7;Nielsen P' +
  'ark|5311.7|-1900.9|190.6;Explosives Reserve|1570.1|-9051.5|186.5;Lane Cove National Park|-56' +
  '02.7|-7822.0|185.1;Kamay Botany Bay National Park|4042.9|13582.4|184.8;Yaralla Estate|-10522' +
  '.5|-2786.9|181.5;Headland Park|4228.1|-3739.8|179.8;Old She-Oak Reserve|-2086.1|-12841.4|179' +
  '.0;Blaxland Riverside Park|-13948.0|-4467.6|172.9;Frenchs Forest Bushland Cemetery|-1030.5|-' +
  '14239.6|166.8;Scarborough Park|-6023.6|12056.3|165.4;Malabar Headland National Park|3939.8|9' +
  '520.1|163.1;Mason Park|-11877.7|-1279.1|162.9;Field of Mars Cemetery|-7675.8|-6058.1|162.4;B' +
  'lackman Park|-5763.2|-5892.1|161.8;park -6077,12406|-6076.7|12406.4|161.5;park -12506,-3256|' +
  '-12505.9|-3256.2|161.2;Meadowbank Park|-11691.6|-5516.5|160.4;Waverley Cemetery|5463.5|4381.' +
  '0|157.7;Civic Avenue Reserve|-5823.9|11268.9|154.0;Sydney Harbour National Park|5142.5|-4887' +
  '.8|153.2;Greenwood Park|-9090.0|-8956.5|152.8;North Arm Reserve|225.6|-8796.9|152.3;Waverley' +
  ' Park|4524.6|2795.1|151.9;Wilson Park|-14529.9|-4463.0|151.3;Surgeon White Reserve|-3218.3|-' +
  '14885.4|150.5;Northern Suburbs Memorial Gardens and Crematorium|-5341.7|-8082.8|147.9;Ku-rin' +
  'g-gai Bicentennial Park|-7323.5|-11535.6|147.2;Sir Phillip Game Reserve|-4933.2|-9410.6|145.' +
  '9;park -10411,-3826|-10410.8|-3825.7|145.2;Hudson District Park (East)|-13209.4|411.0|144.6;' +
  'Pioneers Park|3809.1|10010.7|141.6;Waterworth Park|-5169.4|6461.0|140.4;Sir Joseph Banks Par' +
  'k|-459.9|9757.3|140.0;park -13660,-3078|-13659.6|-3078.4|139.1;Nolan Reserve|5681.6|-10162.5' +
  '|137.3;Astrolabe Park|1255.1|6715.1|137.0;Flat Rock Gully|-2.1|-5700.1|136.8;Lane Cove Natio' +
  'nal Park|-6543.5|-6743.4|136.3;South Western Sydney Institute TAFE - Lidcombe Campus|-15055.' +
  '0|1202.3|134.8;Lane Cove National Park|-6471.6|-7375.6|132.7;Cabarita Park|-8434.7|-2701.0|1' +
  '32.5;Timbrell Park|-6496.3|283.6|131.8;Lane Cove National Park|-9703.5|-11568.4|129.8;Newing' +
  'ton Nature Reserve|-13154.5|-3947.6|128.4;Forestville War Memorial Playing Fields|-212.5|-11' +
  '457.8|127.7;Queen Elizabeth Park|-9830.0|-427.0|126.3;Lane Cove National Park|-8213.5|-10655' +
  '.6|126.2;Lane Cove National Park|-8591.7|-11130.6|125.9;grass -2067,10623|-2067.4|10623.0|12' +
  '5.8;Randwick Environment Park|3770.5|6882.8|125.6;Beaman Park|-6456.0|5430.6|125.2;Artarmon ' +
  'Reserve|-1654.3|-6361.3|124.9;Five Dock Park|-6901.1|-158.6|124.2;Strathfield Park|-11669.6|' +
  '1925.0|124.0;park -13372,-2981|-13372.2|-2981.1|121.6;Wiley Park|-12470.3|6801.1|121.5;Sydne' +
  'y Harbour National Park|6832.6|-3120.0|120.7;Tania Park|5211.4|-6718.7|119.4;Blue Gum Reserv' +
  'e|-3989.8|-8493.7|118.9;St Josephs College Playing Fields|-6956.9|-4465.4|118.8;Jellicoe Par' +
  'k|1702.9|7619.6|117.8;Aquatic Reserve|2421.4|-12390.7|117.0;Arthur Byrne Reserve|4297.9|8967' +
  '.3|116.8;Bicentennial Reserve|-661.6|-6246.4|116.6;Tempe Lands|-4117.3|6592.1|115.4;recreati' +
  'on_ground 1511,6927|1511.1|6927.3|114.8;Rowland Park|1854.9|6865.4|114.6;Koola Park|-3647.7|' +
  '-12499.1|114.6;Bardwell Valley Parklands|-7856.9|8238.0|114.6;Bicentennial Park|-5785.5|1064' +
  '1.0|114.1;Balmoral Park|4089.0|-4415.9|113.9;park -13577,-3479|-13577.1|-3479.3|113.9;Turrel' +
  'la Reserve|-6532.3|6679.7|113.6;Vaucluse House|5864.5|-1612.9|113.2;Ashfield Park|-6919.9|20' +
  '11.2|113.2;Coral Sea Park|3413.2|8715.8|113.0;Gough Whitlam Park|-5318.8|6245.9|112.7;Kamay ' +
  'Botany Bay National Park|2861.4|12974.0|112.0;Pembroke Park|-10811.6|-10267.5|111.9;Castlecr' +
  'ag Northern Escarpment|771.2|-7901.3|111.7;Roberts Park|-13934.8|5141.7|111.2;Lionel Watts P' +
  'ark|-20.7|-14241.5|111.2;Jindabyne Reserve|1506.2|-13769.2|109.7;Burwood Park|-9810.5|645.7|' +
  '109.5;Brookvale Park|5728.9|-12197.3|109.2;North Ryde Common|-8240.1|-7375.6|107.8;grass -12' +
  '60,11569|-1260.5|11569.3|107.7;grass -406,-6769|-406.2|-6768.9|107.3;Yarra Bay Bicentennial ' +
  'Park|2020.4|11952.1|107.0;Magdala Park|-6265.8|-6969.0|106.9;Lane Cove National Park|-4385.2' +
  '|-8623.5|106.4;park -13905,-3178|-13905.1|-3177.8|105.9;Gore Hill Memorial Cemetery|-2017.8|' +
  '-5047.8|104.9;Commemoration Flat|1367.8|14927.9|104.4;Christison Park|6943.9|-1496.0|104.0;H' +
  'enson Park|-4635.7|4022.5|103.2;Cahill Park|-4823.5|7189.1|103.1;Gladesville Reserve|-6631.7' +
  '|-2968.9|102.9;Lane Cove National Park|-7206.2|-10578.6|102.8;Mutch Park|1067.2|8139.1|101.6' +
  ';Barton Park|-4955.0|8806.1|101.4;Peace Park|-7935.9|3444.5|101.3;Beverley Job Park|6116.6|-' +
  '13128.4|101.2;Denistone Park|-10920.0|-7591.1|101.1;recreation_ground -8522,-5062|-8521.9|-5' +
  '061.5|100.9;St Lukes Park|-9176.5|-125.0|100.8;Marsfield Park|-9877.2|-10637.7|100.7;Wolli C' +
  'reek Regional Park|-7549.6|6881.6|100.5;Beacon Hill Reserve|4698.6|-12821.2|100.5;Campbell P' +
  'ark|-6642.4|-1644.3|100.4;Canterbury Park|-8061.9|4159.8|100.1;Snape Park|2371.6|7318.4|100.' +
  '1;Phillips Park|-14464.2|-881.8|99.4;park -8931,-2587|-8931.1|-2587.2|99.2;Graham Reserve|61' +
  '70.5|-8910.8|98.9;Henley Park|-10460.0|2864.8|98.9;Frenchs Forest Showground|277.9|-14199.6|' +
  '98.8;Steel Park|-5792.8|5855.1|98.0;grass -7632,-7391|-7631.7|-7391.0|97.9;Rudd Park|-10864.' +
  '1|4177.4|97.6;Miller Reserve|5091.1|-10011.7|97.4;Cook Park|-5682.3|14171.1|96.9;Christie Pa' +
  'rk|-8534.0|-10707.5|96.9;Wallumatta Nature Reserve|-7562.9|-6800.4|96.6;Richmond Park|-5210.' +
  '6|-13283.7|96.3;Burrows Park|5725.9|4866.8|96.1;Passmore Reserve|5581.8|-9912.0|96.0;H J Mah' +
  'ony Memorial Reserve|-6188.5|5966.0|95.4;Booralee Park|-628.2|8071.1|95.3;Latham Park|3816.4' +
  '|7303.3|95.3;park -2876,-10974|-2876.2|-10973.6|95.2;Wangal Park|-8739.1|729.1|95.1;Beverly ' +
  'Hills Park|-10937.2|8619.8|94.9;Petersham Park|-5401.6|2580.2|94.5;Ryde Park|-9317.6|-5888.2' +
  '|94.3;Seaforth Oval|2292.3|-9642.4|94.3;grass -2492,9410|-2492.0|9409.8|93.9;Waterloo Park|-' +
  '9521.9|-10888.4|93.7;Lane Cove Bushland Park|-2870.3|-5125.2|93.5;Flora and Ritchie Roberts ' +
  'Reserve|7808.0|-11412.6|92.9;Drummoyne Park|-5470.8|-1818.4|92.8;Arncliffe Park|-6053.9|7480' +
  '.6|92.4;Eastwood District Rugby Union Football Club|-10423.7|-10021.9|92.1;grass -3454,6992|' +
  '-3453.6|6992.3|91.6;Keirle Park|6369.5|-9299.8|91.2;Clemton Park|-10654.2|7392.0|90.7;Kamay ' +
  'Botany Bay National Park|3276.3|13058.9|90.5;grass -1806,7834|-1805.8|7833.9|90.4;Warraroon ' +
  'Reserve|-3886.4|-4722.4|90.3;Princes Park|-4975.8|-9934.6|90.0;Flockhart Park|-10211.8|3910.' +
  '3|89.5;Bexley Park|-8242.1|9199.5|89.3;Strickland House Estate|5431.1|-1502.5|89.1;Lionel Bo' +
  'wen Park|-1620.7|6343.3|89.1;Bronte Park|5398.9|3752.0|88.7;Killara Park|-3742.1|-11994.0|88' +
  '.5;Mackey Park|-4971.8|6001.6|88.2;Hallstrom Park|-918.8|-6279.8|88.0;Gardiner Park|-6700.8|' +
  '8427.3|87.9;Wentworth Common|-12524.9|-3284.0|87.8;Ewen Park|-7232.2|5267.9|86.8;Morrison Ba' +
  'y Park|-8961.5|-4247.8|86.4;Cromwell Park|3951.4|10211.1|86.4;Naremburn Park|-1443.1|-5751.5' +
  '|85.5;Croydon Park|-9182.3|3786.1|85.4;Forsyth Park|-10973.8|-10087.4|85.1;Breakfast Point V' +
  'illage Green|-9194.7|-2499.4|84.7;Robson Park|-6071.3|366.0|84.7;park 3196,-8815|3196.4|-881' +
  '5.3|84.6;Barra Brui Reserve|-4098.1|-13853.8|84.6;park -8367,3283|-8367.0|3283.3|84.3;Regime' +
  'ntal Park|-4956.2|-11307.4|83.8;Gannam Park|-8450.1|-6844.7|83.7;grass 2339,13287|2339.1|132' +
  '86.6|83.6;park -7082,-6606|-7082.5|-6606.1|83.3;Airey Park|-12536.7|160.9|83.1;Cooke Park|-1' +
  '1914.0|3591.7|82.6;Beauchamp Park|-2302.6|-8575.4|82.4;Somerville Park|-11622.1|-9326.5|81.8' +
  ';Balmoral Oval|4066.0|-4395.0|81.6;Riverglade Reserve|-6623.8|-3319.8|81.5;grass 4140,7659|4' +
  '140.4|7658.8|81.5;Cook Park|-5499.1|13698.9|81.3;Goddard Park|-9951.7|-228.0|80.4;Begnell Fi' +
  'eld|-12052.4|3839.1|80.3;Buffalo Creek Reserve|-6720.2|-5706.3|80.2;Willoughby Park|-340.3|-' +
  '7920.6|80.0;Parramatta River Regional Park|-7252.3|-3077.5|79.6;Kensington Park|1268.6|5693.' +
  '9|79.5;Edwards Park|-9505.4|-1428.6|79.4;Bushcare Site - Prince Henry|3402.3|12663.0|79.4;Hu' +
  'rstville Oval|-9983.9|10440.2|79.2;park -5259,9564|-5259.1|9564.3|79.2;grass -13905,-4426|-1' +
  '3904.9|-4425.6|79.0;Stony Range Regional Botanic Garden|6624.4|-12419.3|78.9;Dunbar Park|-96' +
  '10.7|-9572.7|78.6;Primrose Park|1256.9|-5159.7|78.2;Quarantine Reserve|-8010.2|-2137.4|78.1;' +
  'Paine Reserve|2539.2|6104.2|78.1;park -14267,-2299|-14267.2|-2298.7|78.1;Marrickville Park|-' +
  '5210.8|3774.4|77.9;James Meehan Reserve|7783.7|-13156.1|77.9;Parkside Drive Reserve|-8052.7|' +
  '12676.4|77.8;Randwick Cemetery|4325.4|6657.9|77.8;University Oval|-14780.2|1982.1|77.8;Frog ' +
  'Conservation Area|-12250.2|4106.6|77.6;Yeo Park|-7239.8|3750.3|77.5;Killarney Heights Oval|4' +
  '83.2|-10638.4|77.4;recreation_ground -647,-6296|-647.2|-6296.3|77.2;park -11226,-7745|-11226' +
  '.5|-7745.0|77.1;Trenerry Reserve|4828.5|6430.1|77.1;Riverview 1st Field|-4769.1|-4635.2|77.1' +
  ';Belmore Sports Ground|-10480.5|5481.2|76.7;Bressington Park|-12104.5|-1402.0|75.9;Pratten P' +
  'ark|-7943.7|2816.6|75.8;grass -13392,-4338|-13392.2|-4338.3|75.4;Grant Reserve|4622.3|6192.5' +
  '|75.4;Forestville Park|1368.2|-12155.7|75.4;Putney Park|-9332.5|-3673.2|75.2;Pidding Park|-8' +
  '113.2|-6107.0|75.2;Bark Huts Park|-11505.5|3549.9|75.1;Rockdale Park|-5586.7|9401.7|75.0;Den' +
  'ce Park|-11002.9|-10295.5|74.9;Melwood Oval|-169.6|-11409.9|74.7;Fraser Park|-4272.6|5226.0|' +
  '74.2;Earlwood Oval|-8147.4|6317.0|74.1;grass -2547,10802|-2546.6|10802.1|74.1;Brays Bay Rese' +
  'rve|-11150.5|-3846.5|74.1;Roseville Park|-2810.4|-10167.7|74.0;Rosherville Reserve|3465.3|-5' +
  '999.7|73.9;park 2915,-4713|2914.7|-4712.6|73.4;Gordon Park|-4383.9|-12825.9|73.3;Allum Park|' +
  '-13528.2|4400.8|73.2;Nagle Park|2366.0|8183.5|73.1;Wolli Creek Regional Park|-8437.1|7501.5|' +
  '72.9;grass -12752,-3572|-12752.3|-3572.4|72.7;grass -2683,7849|-2682.8|7849.2|72.5;L\'Estrang' +
  'e Park|-679.2|6988.1|72.5;Batten Reserve|-4465.1|-6747.2|72.4;Enmore Park|-3658.3|4054.9|72.' +
  '2;Pioneer Park|-9836.8|-10062.0|71.9;Noel Seiffert Reserve|-6327.4|13870.9|71.8;H.D. Robb Re' +
  'serve|36.7|-9587.1|71.8;Rosedale Reserve|-9737.9|3821.7|71.6;Santa Rosa Park|-9489.1|-7947.0' +
  '|71.4;Parriwi Park|3423.6|-6776.5|71.1;Little Manly Point|7152.8|-6865.4|71.1;Memorial Park|' +
  '-5452.5|10626.5|71.0;Rothwell Park|-9692.2|-832.9|71.0;grass -7940,-7688|-7939.6|-7687.7|70.' +
  '9;Pat O\'Connor Reserve|-8447.8|5659.9|70.8;Clontarf Reserve|3909.6|-6990.9|70.5;Harbord Park' +
  '|6663.4|-10856.4|70.4;Tunks Park|699.6|-5687.4|70.4;park -9466,3691|-9465.8|3691.3|70.3;gras' +
  's -13867,-2766|-13866.9|-2766.2|70.3;Glades Bay Park|-8146.8|-3609.7|70.1;North Harbour Rese' +
  'rve|5006.1|-7872.8|70.1;Tasker Park|-8677.2|4943.4|69.9;Centenary Park|-8315.7|962.9|69.9;Fe' +
  'rndale Park|-3799.5|-7531.0|69.8;Darvall Park|-11721.2|-7581.9|69.6;Tuckwell Park|-7176.2|-9' +
  '878.4|69.6;Gwarra Reserve|-333.4|-12386.7|69.6;Peter Moore Fields|-10339.5|5418.9|69.6;Yarra' +
  ' Recreation Reserve|2288.5|12310.0|69.4;grass -3216,6963|-3216.2|6963.1|69.2;grass -2387,104' +
  '90|-2386.9|10490.4|69.2;Charles Heath Reserve|-8462.6|95.4|69.0;grass -1611,10169|-1611.3|10' +
  '168.9|68.8;Jack Vanny Reserve|5255.8|7974.7|68.7;Tantallon Park|-4725.5|-6522.9|68.6;Northbr' +
  'idge Park|858.0|-6218.9|68.2;The Village Green|1802.7|5470.4|68.1;grass -3286,6648|-3286.3|6' +
  '647.7|68.0;Claydon Reserve|-6930.7|12918.0|67.9;Blenheim Park|-7027.5|-7970.8|67.8;grass -29' +
  '23,8214|-2923.2|8214.5|67.3;Tonbridge Street Reserve|-5909.2|12743.8|67.2;Burns Bay Reserve|' +
  '-5279.3|-5103.6|67.1;The Gap|7025.8|-2619.1|67.0;The Jack Pearson Playing Fields|-10246.4|-1' +
  '0969.2|67.0;Cathy Freeman Park|-13305.4|-2327.9|66.9;Rodney Reserve|6889.0|393.6|66.8;Camden' +
  'ville Park|-2850.1|4499.2|66.7;Castle Cove Park|-500.0|-9660.3|66.5;Fontenoy Park|-7520.3|-1' +
  '0165.3|65.9;park -464,7876|-464.2|7876.3|65.8;Tennyson Park|-4697.5|-5521.0|65.7;park 89,872' +
  '2|89.2|8721.8|65.6;Ivanhoe Park|6803.8|-8184.3|65.5;Lane Cove National Park|-5297.6|-9161.6|' +
  '65.4;North Ryde Park|-6864.1|-7355.2|65.2;David Thomas Playing Fields|4766.2|-10091.3|65.0;D' +
  'unningham Park|4954.7|5306.7|65.0;Chatswood Park|-2674.2|-7598.4|64.8;Banjo Paterson Park|-7' +
  '618.3|-3113.7|64.4;Memorial Park|-11363.5|-5211.2|64.3;Dean Reserve|-12028.7|3142.3|64.3;gra' +
  'ss 5107,-4848|5106.7|-4847.7|64.3;park -2887,5405|-2886.7|5405.3|64.3;Riverine Park|-5214.7|' +
  '8436.6|64.2;Davidson Park Reserve|-797.4|-11152.7|64.0;Gumbooyah Reserve|4576.8|-10775.3|64.' +
  '0;Middle Head Oval|4788.8|-4720.2|63.9;Lysaght Park|-6470.0|-1719.7|63.6;Lawry Plunkett Rese' +
  'rve|3709.1|-4475.9|63.6;park 1374,8612|1373.7|8611.5|63.5;park -8205,7774|-8205.0|7774.2|63.' +
  '4;Hodgson Park|-4182.4|-4419.8|63.3;Seaforth Park|-7244.2|9631.9|63.3;Scarbourgh Park East|-' +
  '5861.4|12022.5|63.3;grass -1411,11218|-1410.6|11217.8|63.2;Henley Park|-10242.3|-787.8|63.2;' +
  'Cintra Park Tennis and Sports Centre|-9027.9|-11.2|63.1;Parry Park|-12901.0|5201.8|63.1;park' +
  ' -14170,-5274|-14170.5|-5273.8|62.9;John Mountford Reserve|-12472.7|8425.3|62.6;grass 4097,-' +
  '3838|4097.1|-3838.0|62.6;grass -3386,8286|-3385.9|8285.8|62.5;Woomera Reserve|2894.5|12147.5' +
  '|62.5;Whiteoak Reserve|-5120.1|9419.8|62.2;Coolibah Reserve|-6881.4|7323.1|62.0;Hudson Distr' +
  'ict Park (West)|-13516.3|181.5|61.8;Mascot Memorial Park|-1252.2|6377.2|61.6;Pottery Green|-' +
  '3552.7|-5923.7|61.6;Coogee Oval|4400.7|5531.0|61.2;St Aloysius Oval|-358.2|-8312.0|61.2;Russ' +
  'ell Park|-6122.6|-1586.0|61.0;East Lindfield Park|-1665.9|-11691.2|60.8;Barwon Park|2635.4|9' +
  '968.7|60.7;grass -9212,-10630|-9212.3|-10630.1|60.5;Robertson Park|6768.0|-2919.0|60.4;Fairl' +
  'ight Cemetery|5621.6|-8577.7|60.0;Bantry Bay Reserve|2829.3|-9790.6|60.0;grass -3680,8369|-3' +
  '680.3|8369.3|59.6;Tambourine Bay Reserve|-4632.9|-4572.7|59.5;Lovetts Reserve|-5816.5|-5519.' +
  '3|59.5;Hews Reserve|413.8|-15078.4|59.4;park -9293,3923|-9293.4|3922.9|59.3;grass -2786,8122' +
  '|-2786.0|8122.2|59.3;Hughes Park|-8618.1|6191.8|59.1;Taplin Park|-5643.7|-1983.4|59.0;H.C. P' +
  'ress Park|1709.9|-8688.9|58.9;grass -2250,7733|-2250.4|7732.6|58.6;Monash Park|-7700.3|-4901' +
  '.9|58.3;Lillihina Avenue Reserve|5727.5|-14084.4|58.2;Penshurst Park|-10843.6|10485.5|58.1;g' +
  'rass -3262,7654|-3261.9|7654.1|58.0;grass -12912,-6982|-12911.5|-6981.7|58.0;Hands Quarry Re' +
  'serve|-5048.5|-6380.7|57.9;Manly West Park|5388.3|-8975.3|57.8;park 7913,-11731|7912.7|-1173' +
  '1.3|57.7;Westminster Park|-7666.2|-5037.0|57.6;Sydenham Green|-3732.2|5399.3|57.6;grass -260' +
  '3,10462|-2603.2|10461.6|57.4;grass -2806,9598|-2805.7|9598.5|57.4;Lindfield Oval|-2879.1|-10' +
  '943.2|57.3;grass -3113,7458|-3113.2|7457.5|57.1;grass -3179,8006|-3179.3|8006.3|57.0;grass -' +
  '1831,9180|-1830.9|9179.7|56.9;Ismay Reserve|-11419.1|-436.5|56.9;Bradley Bushland Reserve|37' +
  '86.4|-3898.2|56.9;grass -7852,-7373|-7852.0|-7373.3|56.8;grass -2789,8833|-2789.1|8832.7|56.' +
  '7;Bayview Park|-8171.0|-1083.8|56.7;Bales Park|-1586.5|-7881.4|56.5;Purcell Park|1738.6|1035' +
  '5.2|56.3;grass -3133,8202|-3133.3|8201.7|56.3;grass -3023,8669|-3022.8|8669.1|56.3;Newington' +
  ' Reserve|-14696.9|-3900.2|56.3;Silver Jubilee Park|-7250.2|8034.4|56.2;Forrester Park|-11314' +
  '.4|-9421.8|56.1;South Head General Cemetery|6660.5|-1222.4|56.0;grass -2979,8874|-2978.9|887' +
  '3.5|55.9;park -14536,-2254|-14536.2|-2253.6|55.9;Lees Park|-8932.7|4041.6|55.6;Muston Park|-' +
  '1524.4|-8884.5|55.5;Hinkler Park|6557.5|-9529.3|55.4;Smalls Park|-9181.7|-7549.4|55.4;grass ' +
  '-2998,7956|-2997.9|7956.1|55.3;Hogben Park|-6699.5|9959.4|55.1;Riverview 4th Field|-5069.8|-' +
  '4847.2|55.1;Bangor Park|3645.2|6296.4|54.9;Villa Maria Reserve|-6827.9|-3518.2|54.9;Bambara ' +
  'Oval|677.3|-14215.3|54.8;Elliott Reserve|-11187.4|3595.8|54.5;Rhodes Park|-11081.0|-3633.9|5' +
  '4.5;Riverview 2nd Field|-4754.4|-4363.4|54.4;Greenlees Park|-9488.0|-1183.0|54.3;Granny Smit' +
  'h Memorial Park|-10143.3|-8967.1|54.3;Bremner Park|-8709.3|-4622.2|54.3;Spit West Reserve|32' +
  '75.9|-6816.0|54.2;grass 2395,8378|2395.3|8378.4|54.2;Eastwood Park|-12010.2|-8612.0|54.1;Sti' +
  'rgess Reserve|7002.4|-11359.1|54.1;Tony Baker Reserve|-5258.6|9907.6|54.1;Loyal Henry Park|-' +
  '3909.4|-9037.4|54.0;Allan Small Oval|-2739.8|-12734.0|53.9;Sydney Harbour National Park|6224' +
  '.0|-3208.4|53.6;Kendrick Park|-4673.2|6564.3|53.3;Evatt Park|-8890.3|9778.5|53.3;Hammond Res' +
  'erve|-6527.4|-12770.0|53.3;park -6359,13504|-6359.0|13503.7|53.2;Tarban Creek Reserve|-6958.' +
  '2|-3734.8|53.2;grass -3878,6563|-3878.0|6562.7|53.2;Hammond Park|-7659.8|1148.5|53.0;Edenbor' +
  'ough Park|-4534.4|-9411.0|52.8;grass -2831,7915|-2831.4|7915.3|52.7;Jack Mundey Reserve|186.' +
  '0|6261.1|52.7;Central Park|-3585.6|-4891.5|52.5;Beaumont Park|-9100.0|7384.8|52.3;grass 7212' +
  ',-6188|7212.5|-6188.3|52.2;park -8562,3987|-8562.0|3987.2|52.1;Marks Park|6142.5|3203.5|52.1' +
  ';Blair Park|-8694.3|929.1|52.0;Prince Edward Park|-8377.5|-1630.6|51.7;Jim Walsh Park|-11051' +
  '.1|-8916.8|51.7;Forsyth Park|5419.1|5115.8|51.7;Red Hill Reserve|4021.8|-13921.5|51.6;Macfar' +
  'lane Reserve|-2025.9|-14387.1|51.5;park -13911,3029|-13911.2|3029.1|51.4;Blenheim Park|4508.' +
  '6|6427.4|51.4;Echo Point Park|-408.6|-10175.9|51.2;grass -13534,-4378|-13534.3|-4377.5|51.1;' +
  'Arlington Recreation Reserve|-6651.8|3832.4|51.0;Arthur Walker Reserve|-10498.9|-2431.8|51.0' +
  ';Ford Park|-11538.0|3300.2|51.0;park -5267,-7562|-5267.3|-7562.5|50.9;Tillman Park|-4056.8|5' +
  '375.2|50.7;park -8943,-4488|-8942.6|-4487.9|50.7;recreation_ground -563,-6167|-562.6|-6166.8' +
  '|50.6;grass 6930,1562|6929.5|1562.0|50.6;Bardon Park|4171.5|5253.5|50.6;Sando Reserve|-10031' +
  '.7|3881.2|50.5;St John\'s Church Grounds|-7515.6|1552.0|50.5;Frenchmans Bay Reserve|2268.2|12' +
  '724.3|50.3;Warringah Recreation Centre|5412.1|-10498.4|50.2;Dudley Page Reserve|6606.9|7.7|5' +
  '0.1;Burrows Park|-8964.9|-5799.3|50.1;Yamble Reserve|-9540.7|-7412.5|49.9;Cook Park|-4135.4|' +
  '9228.7|49.9;Kingsgrove Avenue Reserve|-9183.3|7758.2|49.8;Brereton Park|-6747.5|-6420.2|49.8' +
  ';Greenacre Civic Centre Reserve|-14175.2|4551.4|49.7;Blackmore Park|-5457.3|752.5|49.6;Looki' +
  'ng Glass Bay Park|-7693.0|-3281.9|49.5;Kingsford Smith Oval|-4018.8|-4146.1|49.4;park 3651,1' +
  '1873|3650.6|11872.6|49.3;Anzac Park|-10945.3|-6682.2|49.2;Brick Pit Reserve|2016.4|-12854.5|' +
  '49.1;Rockdale Womens Sportsfields|-5439.1|9454.1|49.0;Kotara Park|-9897.6|-8906.6|49.0;Rotar' +
  'y Park|-5860.8|12855.1|48.7;Central Park|-10471.4|-1131.8|48.7;Bill Mitchell Park|-8373.8|-3' +
  '911.5|48.6;Gifford Park|-11550.6|9974.0|48.6;Henry Lawson Park|-7769.7|-1960.7|48.5;Yatama P' +
  'ark|-9596.5|6619.5|48.5;Halliday Park|-7477.5|-652.4|48.4;Parsley Bay Reserve|6325.6|-1949.1' +
  '|48.4;park -5185,9181|-5184.7|9180.9|48.4;Malabar Wetland|3534.7|9733.1|48.4;Munda Street Re' +
  'serve|3600.1|6840.6|48.3;Terry Lamb Reserve|-10757.4|5587.7|48.3;grass -6897,-9627|-6896.6|-' +
  '9627.4|48.2;Norfolk Reserve|-13514.8|3075.9|48.2;Ku-ring-gai Flying Fox Reserve|-4695.2|-128' +
  '53.7|48.2;Weerona Reserve|-9846.5|-11303.3|48.1;Ararat Reserve|1730.6|-11809.3|47.9;Sangrado' +
  ' Reserve|2693.0|-7836.9|47.8;park -7019,-1994|-7018.9|-1993.7|47.7;Tyagarah Park|-8777.0|-48' +
  '12.2|47.7;Reg Coady Reserve|-6812.0|664.4|47.7;Broadarrow Reserve|4283.2|8670.6|47.6;Johnson' +
  ' Park|-6573.1|3697.9|47.6;Turruwul Park|-401.0|5685.6|47.6;Kerry Reserve|4371.8|-13201.4|47.' +
  '6;grass -520,6468|-519.7|6467.8|47.6;Lighthouse Reserve|7032.3|-1883.9|47.1;Wingara Reserve|' +
  '-225.2|-14464.7|47.0;Coast Hospital Cemetery and Dharawal Resting Place|3971.1|13546.6|46.9;' +
  'Algie Park|-6632.0|1091.4|46.6;Swain Gardens|-3682.1|-11177.1|46.4;Lovedale Place|-10974.6|-' +
  '3515.8|46.4;grass 4580,9509|4579.8|9508.6|46.3;grass -2240,10684|-2240.3|10684.3|46.2;Clarke' +
  ' Reserve|6991.2|-1334.7|46.0;Jack Shanahan Park|-6411.3|4637.5|45.9;Bicentennial Park East|-' +
  '5385.8|10187.2|45.9;Queen Elizabeth Reserve|-5779.9|-9707.9|45.8;Blankers Koen Park|-14673.1' +
  '|-2599.6|45.7;Varna Park|4464.3|4124.4|45.6;Fry\'s Reserve|-6902.5|10225.3|45.5;Kamay Botany ' +
  'Bay National Park|2261.8|13640.2|45.3;Wicks Park|-4199.0|4599.2|45.3;Robert Pymble Park|-648' +
  '8.8|-13839.8|45.3;George Kendall Park Dog Off-Leash Area|-13342.8|-5153.5|45.3;Parry Park|-1' +
  '2757.5|5088.8|45.2;park -9773,-3549|-9772.7|-3549.2|45.1;Woodstock Park|-9686.1|1634.8|44.9;' +
  'Doctor Walters Park|3109.8|11512.1|44.7;Corella Street Reserve|7082.8|-10886.2|44.7;Lardelli' +
  ' Park|-9335.5|-5254.4|44.7;park -10413,1206|-10412.9|1206.5|44.6;grass -3060,7629|-3060.2|76' +
  '28.6|44.6;Macartney Reserve|3602.8|12132.7|44.5;Wadim Bill Jegorow Reserve|-7310.9|675.2|44.' +
  '5;Vimera Reserve|-11384.2|-9509.8|44.4;Little Tasker Park|-8722.1|4593.4|44.4;Coast Hospital' +
  ' Memorial Park|3816.8|12358.3|44.4;Warren Park|-5374.3|6012.0|44.3;Cromwell Park|4081.5|1045' +
  '9.4|44.2;Sir Phillip Game Reserve South|-5050.8|-8863.1|44.1;Kissing Point Park|-10010.1|-41' +
  '12.0|44.0;Dickson Park|5115.5|2373.1|43.9;Peel Park|-8275.0|-4305.3|43.8;grass -2874,9266|-2' +
  '874.4|9265.8|43.7;grass -4944,3833|-4944.3|3833.1|43.7;The Willis Recreation and Sport Centr' +
  'e|-843.4|-9136.6|43.5;East Gordon Park|-4219.8|-13037.2|43.5;Woodford Bay Reserve|-3356.6|-4' +
  '524.6|43.2;park -8265,4308|-8264.7|4308.1|43.2;Allambie Heights Oval|3387.7|-11440.3|43.2;pa' +
  'rk -5746,3443|-5745.8|3443.3|43.2;Golfers Glen|-7256.6|-12965.1|43.1;Lane Cove National Park' +
  '|-5187.3|-8337.3|42.9;Gaiarine Gardens|-26.0|8171.4|42.9;Spooner Park|-6919.9|11910.0|42.9;T' +
  'indale Reserve|-7871.8|10976.9|42.8;Thomas Hogan Reserve|5011.2|2173.3|42.8;Dacey Gardens|17' +
  '98.7|6267.1|42.5;Tamarama Park|5533.0|3184.4|42.4;recreation_ground 589,6431|588.7|6430.7|42' +
  '.4;Mallee Reserve|-8694.9|-4752.6|42.0;Baker Park|3811.5|5909.3|41.9;Jackson Park|-10761.8|3' +
  '518.1|41.8;Jacka Park|6818.0|-10480.3|41.8;Maze Park|-12584.1|-6782.3|41.8;Wyargine Reserve|' +
  '3909.0|-5572.6|41.7;Cattle Judging Lawn|-13413.0|-2591.3|41.7;Memorial Reserve|3111.6|9345.7' +
  '|41.6;Walsh Avenue Reserve|-10997.5|3685.7|41.4;Lesley Muir Reserve|-8200.2|5174.6|41.4;McCa' +
  'rthy Reserve|-5594.2|9703.3|41.4;Cambridge Road Reserve|-5597.0|-2694.9|41.4;grass -7821,397' +
  '9|-7820.9|3979.4|41.4;Thistle Park|-10433.2|-5460.7|41.4;Helen Street Reserve|-3132.9|-6713.' +
  '2|41.3;Roly Poly Hill|-10837.1|-7522.2|41.3;grass 3946,13868|3946.5|13867.9|41.2;Manly Vale ' +
  '- Calabria Bowling Sports and Social Club|5755.2|-9829.6|41.2;park -7073,-4082|-7073.2|-4081' +
  '.8|41.2;Wilga Park|-8624.8|-9611.1|40.9;park 3766,-8594|3765.7|-8594.2|40.8;Stewart Park|-10' +
  '210.8|-10416.8|40.6;Signal Hill Reserve|7121.7|-2086.5|40.4;recreation_ground -9052,8367|-90' +
  '52.5|8367.4|40.4;Woodville Reserve|-9129.6|10886.4|40.3;McIlwaine Park|-11164.1|-4125.5|40.3' +
  ';park -12537,-7583|-12536.7|-7583.1|40.3;Federation Reserve|-10202.4|4079.4|40.2;park -10927' +
  ',3857|-10926.7|3856.8|40.2;Jessie Stewart Reserve|-9502.9|-1067.6|40.2;Alison Park|2966.8|47' +
  '46.1|40.1;North Goldstein Reserve|4566.6|5573.2|40.1;park -9011,-4427|-9011.3|-4426.6|40.1;D' +
  'arrell Jackson Gardens|-6764.2|2518.1|40.0;Osborne Park|-3101.9|-4953.6|40.0;Hunter Park|599' +
  '2.8|2882.4|40.0;Miriam Park|-11285.0|-7073.1|40.0;park -6297,13241|-6297.3|13241.4|39.9;Nort' +
  'hcote Park|-13971.3|3850.2|39.8;Allison Park|-6840.8|-1722.3|39.7;Bennelong Park|-10064.1|-4' +
  '317.3|39.5;Rhodes Street Reserve|1952.8|9442.5|39.5;Cleland Park|-2155.1|-6285.8|39.5;Jinker' +
  's Green|-6030.7|-10025.8|39.4;Pemberton Reserve|-5910.7|13156.3|39.4;London Reserve|-3456.8|' +
  '-13486.1|39.4;Hartman Hill Reserve|-5260.0|-5281.0|39.4;Warrawong Reserve|-12704.3|-7622.6|3' +
  '9.3;Quakers Hat Park|2348.7|-6370.5|39.1;Mill Park|-11323.9|-4836.8|39.1;Maria Reserve|-1155' +
  '4.6|3424.0|39.1;Hunter Park|3708.4|-4959.0|39.0;John Shore Park|4279.0|8558.7|39.0;St Crispe' +
  'ns Green|-6416.5|-9800.4|39.0;Condover Street Reserve|4300.5|-9315.0|39.0;Fred Hollows Reser' +
  've|3643.9|4786.2|38.9;A E Watson Reserve|-7605.7|9572.5|38.7;grass -14052,-4479|-14052.5|-44' +
  '78.9|38.6;Thorpe Park|-10361.2|9555.6|38.5;Freshwater Beach Reserve|7249.7|-9913.7|38.5;Bare' +
  'ena Park|4680.6|-7031.6|38.5;Opala Reserve|73.4|-14506.9|38.5;grass -4213,-14114|-4213.1|-14' +
  '114.5|38.5;Grant Park|-10325.8|2575.7|38.4;Betts Park|-6116.8|-3115.1|38.3;grass -9014,-1052' +
  '3|-9013.9|-10522.6|38.3;garden -7115,-9585|-7114.6|-9584.8|38.3;Lane Cove National Park|-418' +
  '8.2|-8330.6|38.2;Charles Bean Sportsfield|-4696.5|-8837.3|38.2;grass -4643,4151|-4642.8|4151' +
  '.1|38.2;recreation_ground -8986,-157|-8986.4|-156.7|38.2;grass 7869,-11486|7868.9|-11485.9|3' +
  '8.1;Barracluff Park|5613.8|1569.7|38.0;grass -12268,-1976|-12267.6|-1976.3|38.0;Kooloora Res' +
  'erve|3716.6|11673.9|38.0;Eve Street Reserve|-5037.9|7956.7|38.0;park -22,-15003|-22.3|-15002' +
  '.7|37.9;grass -13689,-4553|-13689.3|-4553.0|37.8;Lance Studdert Reserve|-4851.0|9129.8|37.8;' +
  'Diamond Bay Reserve|6702.4|-883.5|37.8;park -9098,8279|-9098.0|8278.9|37.8;Freshwater Park|-' +
  '12586.7|1592.3|37.8;Illoura Reserve|-8404.9|7458.7|37.8;park 5991,2549|5990.7|2548.6|37.7;Pe' +
  'ter Low Reserve|-10410.0|8987.4|37.7;Lee Park|-13447.2|3558.7|37.7;AS Tanner Reserve|-5665.0' +
  '|11537.6|37.6;grass -12078,-1840|-12077.7|-1839.5|37.5;Roselands Aquatic Centre|-12643.8|739' +
  '1.0|37.5;St Jude\'s Cemetery|3074.0|4677.9|37.5;Fisher Road Park|6804.5|-13428.5|37.4;grass -' +
  '4172,8329|-4171.5|8329.1|37.4;Lindsay Reserve|498.3|-12537.3|37.3;Rodd Park|-5584.1|-247.2|3' +
  '7.3;park -10092,-10996|-10091.9|-10995.7|37.3;Moore Park|-11529.2|-8988.1|37.2;Dowsett Park|' +
  '-9592.1|8557.0|37.2;Shepherd Parade Reserve|-6938.7|7480.1|37.1;Nield Park|-6015.4|-355.5|37' +
  '.0;grass -1669,9784|-1669.1|9784.0|37.0;Muraborah Reserve|4325.2|8285.5|37.0;Wayne Schimansk' +
  'i Reserve|-1817.7|-14501.6|36.9;Richard Healy Reserve|-1150.3|-13437.8|36.9;Beach Paddock|59' +
  '10.1|-1796.5|36.8;grass -13356,-1940|-13355.8|-1940.0|36.8;Wilkins Green|-5039.2|3727.4|36.8' +
  ';Cadigal Reserve|-5952.8|2627.2|36.7;Edwards Park|-11718.1|2568.5|36.6;Fullers Park|-4829.5|' +
  '-8512.2|36.6;Kamay Ferry Wharves|2121.3|13282.6|36.5;Kingsland Road Reserve|-7824.0|8772.3|3' +
  '6.3;Bradley Reserve|-11596.5|-3085.3|36.3;Wolli Creek Regional Park|-5787.8|6515.3|36.2;Syde' +
  'nham Green|-3730.2|5572.4|36.2;Haynes Reserve|-8177.9|5328.9|36.1;Bancroft Park|-2498.0|-936' +
  '3.8|36.1;park -5667,-10470|-5667.4|-10470.3|36.1;Cook Street Reserve|713.1|-11474.2|36.1;par' +
  'k -5857,-3007|-5856.6|-3007.0|36.1;Sutton Reserve|-7828.9|5257.9|36.0;grass 7029,-1758|7029.' +
  '3|-1758.4|36.0;park -197,-7041|-196.7|-7041.2|36.0;Village Green|-11618.3|-2749.3|36.0;park ' +
  '3370,12047|3369.7|12047.2|36.0;Hughes Park|-5482.7|-5185.4|36.0;McNeilly Park|-5265.8|5065.6' +
  '|35.9;Fig Tree Park|-6280.5|-3889.9|35.9;grass -2266,10971|-2266.3|10970.9|35.9;grass -8618,' +
  '-10147|-8617.9|-10147.3|35.9;Frogmore Park|-7841.5|-12476.1|35.8;Western Suburbs Lawn Tennis' +
  '|-7841.0|2730.5|35.7;Phoenix Park|-11449.8|-4342.1|35.7;Thomson Park|-2471.9|-6383.8|35.6;Gr' +
  'ace Campbell Reserve|1595.0|9302.8|35.5;Lowanna Park|-3975.1|-7865.9|35.5;Ted Jackson Reserv' +
  'e|7891.3|-12798.5|35.5;Merv Lynch Reserve|-11977.2|9351.7|35.5;grass -10305,-8563|-10304.9|-' +
  '8562.6|35.4;Bryce Oval|-3522.9|-14119.1|35.4;Ludowici Reserve|-5118.0|-5551.0|35.4;Croot Par' +
  'k|-9291.0|10189.2|35.2;park -8384,6741|-8384.0|6741.3|35.2;Cleves Park|-9931.4|-4532.1|35.1;' +
  'Warners Park|50.6|-6964.8|35.1;Sequoia Park|-7930.2|-11588.4|35.1;South Bronte Reserve|5621.' +
  '0|4178.0|35.1;park 4036,11490|4036.2|11490.5|35.1;Kogarah Park|-7120.5|11657.7|35.1;Leonard ' +
  'Reserve|-11071.6|6863.4|35.0;Bondi Park|6218.3|2301.5|34.9;Neill Place|-1912.9|-10990.1|34.9' +
  ';Bromley Reserve|-14384.7|4724.8|34.8;South Goldstein Reserve|4512.8|5873.2|34.8;grass -1298' +
  '4,-3114|-12983.9|-3113.9|34.7;Linley Point Reserve|-5542.7|-4929.7|34.6;park -7873,7076|-787' +
  '3.0|7076.3|34.6;Quarry Reserve|3767.9|7572.0|34.5;Wallis Reserve|-11918.4|1918.1|34.5;Halvor' +
  'sen Park|-14316.1|-4811.5|34.4;Lagoon Park|6535.7|-9400.6|34.3;South Creek Reserve|5344.9|-1' +
  '4294.7|34.3;Lane Cove National Park|-4947.0|-7530.3|34.2;grass -2483,5397|-2483.2|5396.8|34.' +
  '2;Greville Street Reserve|-3887.6|-8293.8|34.1;Anderson Park|-10708.5|-5108.2|34.0;Campbell ' +
  'Park|-3394.4|-6996.3|34.0;park 1948,7239|1947.5|7239.4|33.9;Gollan Park|4347.5|7202.5|33.9;g' +
  'rass 87,8670|86.6|8670.5|33.9;Fullers Park|-4339.5|-8402.9|33.7;Moore Park|-7120.7|12003.8|3' +
  '3.7;park -1689,-6553|-1688.6|-6552.8|33.6;grass -1609,6600|-1608.8|6600.1|33.6;Currie Road D' +
  'og Park|1204.4|-12187.9|33.5;Chant Reserve|1721.2|7356.9|33.4;Woolgoolga Reserve|3297.5|-933' +
  '5.8|33.4;Smith Park|-10145.4|8338.1|33.3;park -13963,2490|-13963.1|2489.8|33.3;Saint Thomas ' +
  'Anglican Cemetery|-10849.7|2672.1|33.2;Gordon Recreation Grounds|-5053.4|-12373.6|33.1;Cashe' +
  'l Cresent Reserve|-502.4|-11394.2|33.1;grass -4141,-14362|-4141.0|-14361.6|33.1;Empress Park' +
  '|-9188.6|11550.4|33.0;Kendall Village Green|-7154.7|-12106.1|32.8;Cudal Reserve|-9030.2|-493' +
  '5.1|32.8;Dick Reserve|4202.4|5380.9|32.8;Brown\'s Reserve|-10503.2|3888.8|32.7;Quarantine Sta' +
  'tion Cemetery|7420.0|-5711.2|32.7;Doyle Gardens|-11085.8|9667.9|32.7;Flinders Park|-9274.2|-' +
  '8252.3|32.6;Forrester Reserve|-10041.0|7901.3|32.5;park -11102,-1822|-11102.3|-1821.8|32.5;G' +
  'ilchrist Park|-9061.4|8113.2|32.5;Elouera Park|-8597.9|-9855.9|32.5;grass 4344,9974|4344.4|9' +
  '974.4|32.5;Lions Park|-12092.1|-6766.8|32.4;Tamarama Park|5625.0|3335.5|32.4;Jersey Road Res' +
  'erve|-2685.7|-6345.4|32.4;Tweedie Park|-13227.5|2628.5|32.4;park -5803,1399|-5803.2|1399.3|3' +
  '2.2;park -8606,-9422|-8606.4|-9421.9|32.2;McPherson Reserve|-7077.8|6208.6|32.1;grass -2505,' +
  '5502|-2505.2|5501.9|32.1;grass -3977,8500|-3976.9|8500.3|31.9;Sydney Harbour National Park|4' +
  '462.9|-6446.2|31.8;Buruwang Park|-14273.8|-3104.0|31.8;Soldiers Memorial Park|-5506.9|-14248' +
  '.9|31.7;Inveresk Park|-11945.3|707.9|31.7;Brucke Miller reserve|-13648.0|-5819.9|31.7;Gilles' +
  ' Reserve|4875.8|-13086.8|31.7;Maundrell Park|-4585.0|3069.2|31.6;park -5500,6806|-5499.8|680' +
  '6.3|31.6;grass -3095,8475|-3094.6|8475.2|31.6;Jarvie Park|-4837.1|4343.5|31.5;park -7775,-64' +
  '54|-7774.7|-6453.5|31.5;Patricia Gardner Reserve|-5667.9|-10046.0|31.5;Coronation View Point' +
  '|-2784.5|-5618.7|31.4;park -5351,12496|-5351.0|12496.1|31.4;Allman Park|-7244.7|2696.9|31.3;' +
  'Keith Smith Park|-9182.8|2412.6|31.3;Carara Reserve|-10410.5|-6959.7|31.3;Storey Park|-7165.' +
  '3|-479.9|31.2;Girrahween Park|-7656.1|6939.2|31.2;Lane Cove National Park|-4897.8|-8418.4|31' +
  '.1;Bay Street Reserve,Stan McCabe Park|2692.8|-5865.4|31.1;grass -935,-7292|-935.2|-7292.4|3' +
  '1.1;Artarmon Park|-1883.9|-6154.7|31.1;Barwell Park|-8011.3|10437.9|31.1;grass -9841,-8953|-' +
  '9841.3|-8953.0|31.1;grass -4820,6752|-4820.5|6752.2|31.0;Lambert Park|-13063.8|-7720.0|31.0;' +
  'Harcourt Reserve|-10346.6|4299.9|30.7;park -8047,5649|-8046.9|5649.1|30.5;Follies Park|-1932' +
  '.1|-10590.0|30.5;park -12222,2837|-12222.1|2837.4|30.5;Bob A Day Park|3636.0|12637.3|30.5;pa' +
  'rk -6743,-2082|-6743.4|-2081.8|30.4;grass -2865,8399|-2865.4|8398.7|30.4;Lever Reserve|-1030' +
  '.8|6058.7|30.3;park -7796,5156|-7796.0|5155.9|30.2;Leighton Park|-7399.9|12361.9|30.2;park -' +
  '8882,-7420|-8881.5|-7420.4|30.2;park -9876,4023|-9875.5|4023.3|30.1;Mortlock Reserve|782.8|-' +
  '5601.1|30.1;Village Green|-7636.0|-11722.9|30.1;Patanga Park|2929.5|-13179.7|30.1;Physics La' +
  'wn|1961.7|5526.9|30.0;Caffyn Park|6466.2|325.1|30.0;Duke Kahanamoku Park|7666.9|-9957.6|30.0' +
  ';Hoskins Park|-6326.5|3558.6|29.9;Wire Mill Reserve|-7218.5|-1990.0|29.9;Simpson Park|-2875.' +
  '0|4709.2|29.8;grass -10976,-5909|-10976.3|-5908.6|29.8;Wolli Creek Regional Park|-5677.7|651' +
  '1.5|29.7;St Anne\'s Churchyard|-9813.5|-5723.7|29.7;Burnie Park|4789.6|4527.9|29.7;Bower Stre' +
  'et Reserve|8048.5|-7512.3|29.7;Symon\'s Reserve|-11399.7|-7493.2|29.6;Rhodes Foreshore Park|-' +
  '11717.9|-4110.3|29.6;Aitken Reserve|6770.0|-9537.2|29.6;grass -5593,6787|-5592.9|6787.0|29.5' +
  ';Biddigal Reserve|6843.7|2368.9|29.3;Writtle Park|2593.3|5040.3|29.3;Silkstone Park|-9174.1|' +
  '-2908.2|29.3;Stringybark Reserve|-3620.1|-6565.0|29.2;Kendall Reserve|-8827.0|-2250.7|29.2;P' +
  'ierre de Coubertin Park|-14106.8|-3370.5|29.1;Bridget Tight Reserve|145.9|6131.2|29.1;grass ' +
  '7276,-5748|7275.5|-5748.0|29.1;King Reserve South|4856.0|-9613.1|29.1;Samuel Park|6337.6|-13' +
  '56.4|29.0;grass -2713,8454|-2712.8|8454.5|29.0;grass -10617,-243|-10616.7|-243.2|29.0;Richar' +
  'd Murden Reserve|-5888.8|1408.8|28.9;Montague Park|-5286.3|-1027.1|28.9;grass -2590,8528|-25' +
  '90.1|8528.0|28.9;grass -9227,-10345|-9226.6|-10344.7|28.9;Pierre de Coubertin Park|-14162.2|' +
  '-3463.4|28.8;Dukes Green|-2206.5|-11237.7|28.8;Croker Park|-7403.8|599.4|28.7;grass -5008,63' +
  '64|-5008.0|6364.5|28.7;Gough Reserve|-7296.7|3910.4|28.6;KIngsbury Reserve|-9648.0|7705.4|28' +
  '.6;park 5555,4924|5554.9|4924.5|28.6;grass -2966,6793|-2966.4|6792.7|28.6;Glen Reserve|-1232' +
  '4.3|-8373.9|28.5;Peppercorn Park|2044.3|-14005.2|28.5;grass -7890,-7201|-7889.5|-7200.6|28.5' +
  ';park -13543,-6939|-13542.9|-6938.9|28.4;park 4237,-10973|4237.3|-10973.2|28.4;Peel Park|-11' +
  '687.8|5535.1|28.3;Hurlstone Memorial Reserve|-7148.1|4544.3|28.3;grass 5585,-12233|5585.2|-1' +
  '2232.7|28.3;Patongal Park|2007.4|-13403.4|28.3;grass -10711,-249|-10710.6|-248.9|28.2;park -' +
  '8140,5567|-8140.1|5566.9|28.1;grass -3512,6176|-3511.7|6176.3|28.0;Turrumburra Park|-4459.3|' +
  '-6353.8|28.0;grass -12475,-1646|-12475.1|-1645.8|28.0;park -4602,7293|-4602.4|7293.2|27.9;El' +
  'aroo Avenue Reserve|2372.1|12638.3|27.9;park -5378,5909|-5377.7|5909.1|27.8;Bell Park|-13193' +
  '.3|-7300.5|27.8;MacPherson Park|4761.4|4056.3|27.7;recreation_ground -12520,-5370|-12520.5|-' +
  '5370.1|27.7;Coolabah Reserve|-11797.6|7960.0|27.6;Lane Cove National Park|-4429.5|-8477.2|27' +
  '.5;park -12749,-3677|-12748.6|-3677.4|27.4;park -9023,4238|-9023.1|4238.2|27.4;grass -12034,' +
  '-2232|-12034.2|-2232.1|27.4;Boden Reserve|-12836.1|807.9|27.3;Ron Gosling Reserve|-7113.3|71' +
  '63.5|27.2;Graeme Green|-5852.1|4052.0|27.0;St Johns Anglican Church Cemetery|-5526.3|-12295.' +
  '5|26.9;park -7861,7257|-7861.1|7257.2|26.9;park -11722,-1567|-11721.9|-1566.6|26.9;Sanders P' +
  'ark|-1129.5|-6837.6|26.8;West Denistone Park|-12286.0|-7353.8|26.8;Fred Hutley Reserve|-353.' +
  '5|-5462.2|26.8;park -12597,-2557|-12596.9|-2557.3|26.7;Ellerys Punt Reserve|3340.8|-7546.7|2' +
  '6.7;park 2524,-6120|2524.0|-6120.3|26.7;Parry Park|-9210.9|-4949.6|26.7;grass 7624,-7260|762' +
  '3.5|-7259.7|26.6;Arrowsmith Park|-10302.8|11028.5|26.6;Walter Williamson Park|3410.8|7559.1|' +
  '26.6;grass -3842,8248|-3842.5|8248.3|26.4;grass -3387,8111|-3387.1|8110.8|26.3;grass 182,-14' +
  '996|181.9|-14995.8|26.3;Malabar Headland National Park|4255.6|9235.7|26.2;Inglis Park|2756.8' +
  '|5851.1|26.1;Anzac Park|-9808.3|4914.1|25.9;park -7499,-6341|-7498.6|-6341.4|25.9;Outlook Pa' +
  'rk|-11953.7|-7942.0|25.9;Joels Reserve|2187.6|-5787.7|25.8;Adventure Park|-9691.0|-6910.2|25' +
  '.7;Blue Gum Reserve|-3930.8|-5316.8|25.6;grass 7994,-5843|7993.6|-5843.4|25.5;Bundock Park|5' +
  '477.9|4904.8|25.5;Finucane Reserve|2990.0|9978.2|25.5;grass -2337,9180|-2336.9|9179.6|25.5;T' +
  'allawalla Street Reserve East|-11119.1|8176.6|25.5;Battersea Park|-7664.0|-2432.8|25.3;grass' +
  ' -2670,8700|-2670.0|8700.3|25.3;Fairmount Street Reserve|-12753.6|5659.1|25.3;Mindarie Park|' +
  '-4992.6|-6878.3|25.3;grass -3122,7338|-3121.6|7338.0|25.2;Laxton Reserve|-6678.0|3956.9|25.2' +
  ';park -5600,403|-5600.1|402.9|25.2;grass -1929,9084|-1928.9|9083.6|25.2;Brimebecon Park|4625' +
  '.5|-7788.1|25.2;Emily McCarthy Park|4238.4|6721.7|25.2;grass -1956,9212|-1956.2|9211.6|25.1;' +
  'Kings Park|-10348.1|-7987.9|25.1;Manly Dam Picnic Area|3957.3|-9623.3|25.1;Coronation Reserv' +
  'e|-11052.0|3580.3|25.0;Cooinoo Reserve|-10757.7|2785.4|25.0;park -10722,6605|-10722.0|6605.3' +
  '|25.0;Lindfield Village Green|-3822.8|-10343.9|24.9;Bligh Park|2845.7|-9552.3|24.9;grass 703' +
  '2,-5924|7031.6|-5924.3|24.9;park -5437,8600|-5437.4|8600.2|24.9;Weerona Park|5713.3|-8594.6|' +
  '24.8;Walter Gors Park|7243.6|-13008.6|24.8;Greendale Reserve|1143.5|-14110.3|24.8;Howse Park' +
  '|-9753.1|-2290.1|24.8;park -6237,13065|-6237.2|13065.3|24.8;grass -9245,-10773|-9245.0|-1077' +
  '2.7|24.8;grass -7761,-7293|-7761.3|-7293.4|24.8;Leahy Park|3734.3|-5304.8|24.7;park -9728,-4' +
  '068|-9728.5|-4068.4|24.7;grass -11959,-1932|-11958.7|-1932.1|24.7;Melville Reserve|-12858.0|' +
  '241.8|24.6;Tindarra Reserve|-9128.7|-8525.4|24.6;park -6258,-13466|-6258.3|-13465.9|24.6;gra' +
  'ss -7976,4375|-7975.9|4375.1|24.6;Dalley Park|6653.9|-8015.5|24.5;Pukara Place Reserve|5841.' +
  '5|-14032.7|24.4;Bill Boyce Reserve|-11881.1|-665.5|24.4;Dog Judging Lawn|-12947.0|-2534.0|24' +
  '.3;Roseanne Reserve|-12784.4|8005.3|24.2;Southern Cross Drive Reserve|260.0|5876.4|24.2;Loft' +
  's Garden|-9703.5|4452.2|24.2;grass -2478,9121|-2477.5|9121.0|24.2;Warrane Reserve|-897.0|-88' +
  '60.4|24.2;Wassell Street Reserve|2658.9|10566.9|24.2;Lane Cove National Park|-5017.1|-8233.8' +
  '|24.1;park -10086,10380|-10085.9|10380.3|24.1;Bushcare Site - Prince Henry|3575.2|12002.7|24' +
  '.1;Sydney Harbour National Park|5525.0|-946.3|24.0;Todd Reserve|-875.9|7316.8|24.0;Mount Oly' +
  'mpus Heritage Gardens|-4878.5|6882.9|24.0;Ferdinand Street Reserve|-5287.7|-4093.9|23.9;Werr' +
  'ell Reserve|-7494.8|-2588.5|23.9;Dominey Reserve|-7886.1|10053.9|23.9;grass 2340,13418|2340.' +
  '1|13418.1|23.9;Flynns Reserve|-9167.5|9742.2|23.8;Pilgrim Park|-12379.4|451.4|23.8;Kangaroo ' +
  'Park|6831.8|-8478.9|23.8;park -9806,3536|-9806.2|3536.2|23.8;Careden Reserve|4903.8|-13336.6' +
  '|23.7;park 3340,-12445|3339.8|-12445.4|23.7;Saint Malo Reserve|-5969.2|-4109.7|23.6;Lawry Pl' +
  'unkett Reserve|3851.1|-4379.3|23.5;park 548,6194|547.8|6193.8|23.5;park -9962,3488|-9961.6|3' +
  '488.0|23.5;grass -7009,-9660|-7009.2|-9659.9|23.4;Broad Street Reserve|-9693.0|3562.3|23.3;K' +
  'eegan Reserve|262.3|-11233.4|23.3;Goroka Park|3714.0|-12416.1|23.3;Federation Place|-6568.7|' +
  '1363.4|23.3;Neptune Park|4702.1|6324.9|23.2;grass -1447,7185|-1447.2|7184.8|23.1;Cunninghams' +
  ' Reach|-5606.5|-4728.7|22.9;Kegworth Public School Playground|-5638.8|2044.1|22.9;grass 3410' +
  ',11808|3409.5|11808.4|22.9;grass 3489,11853|3489.2|11852.9|22.9;Charity Creek Cascades|-1031' +
  '7.5|-6083.5|22.7;Fitzgerald Park|-11714.5|323.1|22.6;grass -2610,8462|-2610.2|8461.5|22.6;gr' +
  'ass -2470,5615|-2469.6|5614.8|22.6;Francis Street Reserve|-4441.6|-3072.0|22.6;grass -8943,-' +
  '7087|-8943.3|-7087.2|22.5;park -5300,433|-5300.4|433.4|22.5;park -11924,3256|-11923.7|3256.4' +
  '|22.5;grass -5057,-8411|-5057.3|-8410.6|22.4;Lewis Berger Park|-11643.2|-3565.0|22.3;Charles' +
  ' Daly Reserve|-7665.9|7335.4|22.3;Balmoral Park|-10025.4|3507.2|22.2;Bob Clark RSL Memorial ' +
  'Grove|3569.1|10520.0|22.1;park -14126,-4833|-14125.5|-4833.3|22.1;grass -9887,-8743|-9886.6|' +
  '-8742.7|22.0;Beattie Park|-10130.9|-7351.8|21.8;grass -9304,-10415|-9304.2|-10415.3|21.8;Pad' +
  'dy Pallin Reserve|-4719.5|-10346.8|21.7;grass -12747,-1451|-12746.6|-1451.1|21.7;Howley Park' +
  '|-6029.9|-2627.9|21.6;Murray-Prior Reserve|-6207.2|-3609.1|21.6;grass 3495,11728|3494.8|1172' +
  '7.5|21.4;park -8597,-1146|-8596.9|-1146.2|21.3;grass -4202,8107|-4201.9|8107.4|21.3;Whiddon ' +
  'Reserve|-10610.7|3850.1|21.1;grass -10713,-8492|-10713.1|-8491.9|21.1;grass -3775,8128|-3774' +
  '.7|8127.7|21.1;recreation_ground -13959,-4824|-13959.4|-4823.9|21.1;Albert Park|-7045.8|6680' +
  '.0|21.1;grass -6259,-4888|-6258.6|-4888.2|20.8;Springvale Reserve|616.2|-13579.0|20.8;park 6' +
  '289,-7833|6288.6|-7833.3|20.7;grass -3429,8023|-3429.2|8023.1|20.7;Bob Smith Reserve|-5487.3' +
  '|-2477.2|20.7;grass -8638,-10082|-8638.2|-10081.8|20.5;Gaerloch Reserve|5853.4|3279.5|20.4;g' +
  'rass -11929,-2315|-11929.2|-2315.0|20.4;grass -1774,9687|-1773.8|9687.0|20.3;Tennyson Park|-' +
  '8902.5|-3936.2|20.3;grass -3687,8713|-3686.6|8712.7|20.2;Hawthorne Canal Reserve|-5691.6|130' +
  '1.5|20.1;park 6899,-991|6899.1|-991.1|20.0;park -5846,263|-5845.7|263.4|20.0;Kogarah Park|-7' +
  '182.5|11455.3|20.0;Mornington Reserve|-4318.2|-3367.3|19.9;park -8802,7835|-8801.6|7835.0|19' +
  '.8;John K Stewart Reserve|-12283.6|7806.4|19.8;grass -2361,9109|-2360.6|9108.6|19.8;grass -5' +
  '206,-8957|-5205.5|-8957.3|19.7;Lockyer Reserve|-13808.8|-6499.4|19.7;grass -13033,-3704|-130' +
  '32.6|-3703.7|19.7;park -6050,10852|-6049.9|10851.7|19.5;grass -6193,-5727|-6193.1|-5726.8|19' +
  '.3;park -12404,-5250|-12404.0|-5250.0|19.3;grass -5199,-8813|-5198.6|-8812.7|19.1;grass -361' +
  '6,6796|-3616.4|6796.4|19.0;grass -13043,-1361|-13043.3|-1361.0|19.0;Haberfield Gardens|-7183' +
  '.2|1038.3|19.0;park -5107,6036|-5106.7|6035.7|18.9;grass -12532,2250|-12531.7|2250.1|18.8;Ra' +
  'bbett Reserve|1423.6|-13536.8|18.7;Marlow St Reserve|-1665.4|-7108.7|18.6;grass 3800,-11822|' +
  '3800.4|-11822.5|18.6;park 2622,6777|2621.6|6776.9|18.6;park -12141,2388|-12141.3|2387.8|18.6' +
  ';Wandella Reserve|4291.3|-10485.9|18.5;Gilbert Park|6822.7|-7982.2|18.4;park 2681,6911|2681.' +
  '3|6910.7|18.4;Robertson Street Reserve|-7074.8|10391.1|18.3;Popplewell Park|4592.5|7276.8|18' +
  '.3;grass 1200,-12690|1199.7|-12690.5|18.1;park -8552,4610|-8551.6|4610.0|18.1;park 2460,6635' +
  '|2460.5|6634.8|18.1;Reading Avenue Reserve|-3268.6|-12759.8|18.0;grass 563,5368|562.9|5368.2' +
  '|17.9;park 3227,9453|3227.4|9453.2|17.8;John Curtin Memorial Reserve|-1531.5|6921.0|17.8;gra' +
  'ss -3047,7040|-3047.2|7039.5|17.7;park 6873,-535|6873.4|-535.2|17.7;park 1852,-13977|1852.5|' +
  '-13976.7|17.7;park -10565,-153|-10564.6|-152.9|17.7;park 3408,9666|3408.0|9666.3|17.6;Kimber' +
  'ley Reserve|283.5|5302.3|17.5;grass -12105,-1926|-12105.2|-1925.5|17.4;Hampden Road reserve|' +
  '-12563.8|5437.2|17.3;park 3135,9057|3135.0|9056.7|17.1;park -5928,2108|-5928.5|2108.1|17.1;p' +
  'ark -6595,5696|-6594.9|5695.9|17.0;grass -2563,9306|-2562.8|9306.0|17.0;grass -2375,9262|-23' +
  '75.2|9262.1|16.9;park 3123,8995|3122.7|8995.1|16.9;grass -5451,-1906|-5450.7|-1906.3|16.9;gr' +
  'ass -14742,-148|-14741.6|-148.2|16.9;recreation_ground -276,-6756|-275.6|-6755.8|16.7;park 3' +
  '072,8758|3072.5|8757.9|16.7;Kobada Park|-5101.6|-7994.3|16.7;park 1260,-15073|1259.7|-15072.' +
  '9|16.6;grass 2388,10964|2388.0|10964.0|16.6;park -5968,2724|-5967.6|2723.9|16.4;grass -2741,' +
  '8708|-2740.8|8707.9|16.1;park 2764,7303|2764.4|7302.8|16.0;grass 633,5615|633.0|5615.4|15.9;' +
  'Albert Parade Reserve|-7973.0|1728.9|15.8;park 5201,4767|5200.6|4767.4|15.6;park 2302,6524|2' +
  '302.3|6523.6|15.6;Black Forest Reserve|-11080.9|8240.4|15.5;grass 700,5684|699.9|5684.5|15.4' +
  ';Nanbaree Reserve|4951.6|-7349.5|15.4;grass 1748,-12632|1747.8|-12632.5|15.3;East Esplanade ' +
  'Park|7049.2|-7524.7|15.3;Jennifer Park|-12576.1|-5910.7|15.2;park -6375,4537|-6374.9|4537.4|' +
  '15.1;grass -10853,-8534|-10853.1|-8533.6|14.9;grass -3354,7888|-3354.2|7888.2|14.8;park -718' +
  '9,10108|-7189.4|10108.5|14.8;park 2747,7229|2746.9|7228.8|14.7;West Esplanade Park|6582.3|-7' +
  '911.2|14.4;grass 7084,-8978|7083.8|-8977.9|13.9;grass -12845,-3623|-12845.1|-3622.9|13.3;Cor' +
  'onation Reserve|-10893.1|2479.5|13.1;Yarramar Reserve|-11499.4|-9282.4|13.1;grass -12412,-39' +
  '04|-12411.7|-3904.2|12.9;garden -4774,6767|-4773.9|6767.4|12.8;grass -13363,-1783|-13363.4|-' +
  '1782.7|12.1';

/**
 * The 15,300 - 19,300 m outer ring, 476 discs, in the same packing.
 *
 * A **separate constant rather than more records on the end of
 * `PARKS_MIDDLE_PACKED`**, and the reason is the same reason the middle block
 * exists at all: kept apart, the middle string is byte-identical to what it was
 * before this ring was baked, and "byte-identical" is a thing a diff can show
 * rather than a thing a reader has to take on trust. Concatenated, every park in
 * the city would sit on one line that changed.
 *
 * The 19,300 m re-extract reproduced **all 1,345 rows above to 0.1 m** -- same
 * recipe, same `MIN_AREA`, same `MIN_R`, same aquatic-reserve exclusion, same
 * pole of inaccessibility at the same tolerance.
 *
 * Twenty-one discs inside the old 15,300 m line did *not* match a baked row and
 * are **dropped rather than appended**, which is the same call the 15,300 m bake
 * made about three of them. They are not new parks: they are polygons the
 * smaller bbox had *clipped*, whose pole of inaccessibility therefore sat
 * somewhere else -- Sydney Harbour National Park, Rawson Park, Gore Hill Park,
 * Wolli Creek, the Parramatta River reserves, and a dozen ovals on the old rim.
 * Read whole they land somewhere better, but "somewhere better" inside the
 * frozen region is still a flock that moved, and the append-only rule says the
 * inner rings do not move. They will be right the next time the frozen line
 * itself is redrawn.
 *
 * Two further discs are dropped for a different reason: both halves of **Towra
 * Point Nature Reserve**, whose poles of inaccessibility land on Botany Bay
 * tidal mudflat that the pipeline emits no tile for. The 15,300 m ring met this
 * as marine reserves and excluded them by `protection_title == 'Aquatic
 * Reserve'`; Towra Point is tagged a plain land `Nature Reserve`, so the tag is
 * not the discriminator and the built tile set is. The appended block is
 * therefore filtered against `index.json`'s own tile keys -- which is exactly
 * what `integration-check` asserts from the other end, so the two agree by
 * construction rather than by coincidence.
 */
const PARKS_OUTER_PACKED =
  'Garigal National Park|3151.4|-18620.0|1121.0;Garigal National Park|-2194.0|-15853.6|508.6;Kamay ' +
  'Botany Bay National Park|1693.3|15283.4|432.9;Ku-ring-gai Wildflower Garden|-3555.3|-18091.7|406' +
  '.2;Towra Point Nature Reserve|-4319.9|18090.6|327.0;Lane Cove National Park|-11195.0|-12982.7|32' +
  '6.9;St Ives Showground|-2580.2|-18244.2|306.8;Endeavour Heights Reserve|-46.3|18546.5|288.7;Twin' +
  's Creek Reserve|-9204.2|-14117.8|272.6;Cronulla State Park|-2245.4|18196.4|272.2;Terramerragal R' +
  'eserve|-5339.9|-18102.0|244.8;Oatley Park|-13409.5|12617.0|240.8;Rofe Park|-8267.4|-13504.3|213.' +
  '9;Bradley Reserve|-10100.4|-12734.3|205.3;Lane Cove National Park|-10583.6|-13393.5|201.1;Campbe' +
  'll Hill Pioneer Reserve|-19167.6|484.3|169.5;Baden-Powell Activity Centre|-11944.1|-14387.5|167.' +
  '1;Salt Pan Creek Reserve|-15172.4|8554.7|166.3;Lane Cove National Park|-10817.9|-14283.8|165.8;O' +
  'lds Park|-12283.3|10267.7|148.0;Wyatt Park|-15742.5|-1217.1|143.1;Galaringi Reserve|-14487.2|-91' +
  '60.4|138.7;Pennant Hills Park|-12082.2|-13708.6|135.8;The Collaroy Centre|7949.7|-14984.9|134.2;' +
  'Cowells Lane Reserve|-13700.3|-6848.9|132.8;Brush Farm Park|-13251.7|-7978.5|130.5;park -14268,1' +
  '1497|-14267.5|11496.9|129.9;Wategora Reserve|-18196.1|298.5|129.7;O\'Neill Park|-17110.5|3938.3|1' +
  '29.1;Auburn Botanic Gardens|-17851.9|-854.0|127.1;Lucknow Park|-10703.5|-11048.3|123.1;Mona Park' +
  '|-17565.9|-1854.3|120.2;Kyle Williams Recreational Reserve|-9359.5|13811.4|119.6;Cox Park|-14782' +
  '.4|-9023.0|118.7;park -8003,13358|-8003.1|13358.1|118.5;Towra Point Nature Reserve|-220.4|16456.' +
  '6|118.2;Norford Park|-18231.2|1165.4|117.9;Oriole Park|-17756.5|-1124.9|115.4;Everley Park|-1830' +
  '6.2|806.8|114.3;North Rocks Park|-15990.0|-10575.8|110.5;Riverwood Park|-14942.4|9273.1|107.9;Er' +
  'ic Primrose Reserve|-14816.7|-4911.9|107.2;Hunts Creek Reserve|-16543.5|-9686.0|106.5;Upjohn Par' +
  'k|-14841.7|-6561.9|106.3;McLaughlin Oval|-15045.1|8204.2|104.8;Maluga Passive Park|-17848.1|2981' +
  '.0|104.8;Gwawley Park|-7966.5|17258.6|102.3;Horlyck Reserve|-17883.8|-1755.6|100.9;Punchbowl Par' +
  'k|-14818.4|7182.6|100.6;Jensen Park|-17648.6|1962.4|100.5;Epping Oval|-11405.2|-11473.3|99.9;Dun' +
  'das Park|-14485.7|-7954.6|98.8;North Turramurra Recreation Area|-5936.9|-18218.7|98.3;Jim Ring R' +
  'eserve|-17793.2|2597.7|98.2;Auluba Reserve|-9312.1|-12845.3|97.9;Coleman Park|-15643.9|726.9|96.' +
  '6;Hassall Park|-3728.1|-16881.1|95.4;Griffith Park|8551.0|-14358.3|95.0;Saint Matthews Farm Rese' +
  'rve|6097.4|-14957.7|93.1;West Epping Park|-13306.6|-10671.3|93.1;grass -1530,17048|-1530.3|17048' +
  '.3|92.9;Ray Marshall Reserve|-18151.5|-407.4|92.2;park -4528,-17646|-4528.1|-17645.9|92.1;Moore ' +
  'Reserve|-10984.9|12497.3|91.7;Peakhurst Park|-13838.0|10147.7|91.2;Apsley Place Baseball Fields|' +
  '-8093.6|17105.2|90.5;Dalrymple-Hay Nature Reserve|-4999.9|-14485.4|90.2;Turramurra Memorial Park' +
  '|-7473.0|-15733.8|90.1;Carss Bush Park|-8274.6|13711.6|89.8;Bonna Reserve|-1411.2|15481.8|89.7;P' +
  'arramatta City Tennis Courts|-17373.3|-6945.0|89.6;Bennett Park|-13276.5|8196.2|89.3;Lane Cove N' +
  'ational Park|-11823.5|-11761.0|88.8;Barton Park|-17599.9|-7178.8|88.5;Canoon Road Recreation Are' +
  'a|-10181.6|-13114.1|88.2;Peter Hislop Park|-18093.2|617.6|87.0;park -18853,3695|-18852.9|3694.8|' +
  '86.3;Cromer Park|6583.4|-14427.9|86.2;Mobbs Lane Reserve|-13447.4|-9271.8|85.7;St Ives Village G' +
  'reen|-4848.0|-15474.3|84.9;Ruse Park|-15940.9|6715.3|84.5;Fred Spurway Park|-13374.7|-9014.0|83.' +
  '9;Sheldon Forest|-7723.3|-13870.6|83.4;Boronia Park|-12358.6|-10314.6|82.7;Bankstown Memorial Pa' +
  'rk|-16279.3|6199.2|82.5;Progress Park|-17852.8|-355.9|82.2;park -6191,-16093|-6191.0|-16093.1|81' +
  '.1;Grover Avenue Reserve|5900.2|-14829.8|81.0;Princes Park|-18127.7|941.2|80.4;Bankstown City Sp' +
  'orts Complex|-17125.7|6981.7|80.3;Kendall Reserve|-7069.7|14653.7|80.1;Thornleigh Park|-11628.8|' +
  '-14500.9|80.0;Ron Payne Park|-10620.3|-12567.6|79.5;Todd Park|-8664.8|13378.6|78.5;Myles Dunphy ' +
  'Bushland Reserve|-12022.6|12914.0|77.6;Rydalmere Park|-15789.4|-5749.6|76.9;Playford Park|-16623' +
  '.1|8887.9|76.7;Padstow Park|-15740.4|9322.8|76.6;Gillespie Field|-8150.1|-16172.5|76.4;North Epp' +
  'ing Park|-10214.9|-12046.6|76.2;park -9214,-16030|-9213.5|-16030.4|74.5;Beecroft Park|-13764.4|-' +
  '12264.6|74.0;Tulich Reserve|7306.4|-13803.3|73.9;Graf Park|-16297.8|4326.5|73.9;Gosling Park|-14' +
  '880.5|4026.3|73.6;grass -17180,-6204|-17180.3|-6204.4|73.3;Bannockburn Oval|-6655.5|-14753.1|72.' +
  '5;Cheltenham Park|-13125.1|-11779.4|72.5;Sturt Park|-15341.2|-7581.9|72.4;Oatley Pleasure Ground' +
  '|-11364.4|13234.6|71.8;Renown Reserve|-11173.9|11894.5|71.0;Wise Reserve|-13472.1|8427.3|69.6;Au' +
  'burn Park|-16250.0|-2395.9|69.1;Rotary Park|-13753.2|8615.8|68.4;Wyatt Reserve|246.7|-16087.6|68' +
  '.3;Maddison Reserve|-5928.0|-15053.4|67.8;Waldon Road Reserve|345.0|-17108.7|67.7;Thomas Wemys P' +
  'ark|-14253.3|-6770.4|67.7;Lane Cove National Park|-11732.9|-12452.1|67.5;park -11422,15377|-1142' +
  '1.5|15376.7|67.4;Marton Park|491.8|15810.2|66.9;Somerset Park|-10529.5|-11152.1|66.7;Sir Thomas ' +
  'Mitchell Reserve|-14470.4|-8373.2|66.6;park -14112,-12059|-14111.5|-12058.6|66.5;Field 2|-5867.1' +
  '|-18216.0|66.5;Acron Oval|-3142.4|-15636.2|65.9;F S Garside Park|-17960.5|-3806.3|65.7;Granville' +
  ' Memorial Park|-18178.5|-3409.0|65.3;P H Jeffery Reserve|-17419.8|-7108.2|64.8;George Gollan Res' +
  'erve|-17470.5|-7868.8|64.2;Bankstown Oval|-16342.0|6343.0|64.1;Marri Badoo Reserve|-15468.9|-722' +
  '2.2|64.1;Woorarra Lookout Reserve|6247.7|-18143.7|63.9;Collaroy Plateau Park|7399.7|-15657.0|63.' +
  '6;Wahroonga Park|-8814.5|-16747.9|63.5;John Wearn Reserve|-16162.1|-10379.7|63.5;Band Hall Reser' +
  've|-17494.4|3426.2|63.5;Fred Robertson Park|-16537.7|-7031.4|62.9;Rotary Park|-13962.2|8384.6|62' +
  '.6;Colquhoun Park|-18745.8|-1948.3|62.3;Shipwrights Bay Reserve|-8982.2|14411.6|62.2;Chilworth R' +
  'eserve|-13903.1|-12220.1|62.2;Kingsdene Oval|-16433.9|-9094.8|62.0;Equestrian Park|-6385.1|14376' +
  '.7|62.0;Robin Thomas Reserve|-18314.6|-5376.0|61.8;Harold West Reserve|-14998.6|-10099.4|61.5;Cl' +
  'areville Park|-6410.1|14561.3|61.5;Stuart Street Reserve|-15742.0|8810.1|60.5;Washington Avenue ' +
  'Reserve|5484.9|-15065.0|60.2;Little Duck Creek Reserve|-18911.4|-1365.4|60.2;Poulton Park|-10022' +
  '.9|12417.6|59.9;Samuel King Park|-6086.0|-17431.6|58.5;park -13989,-10645|-13988.9|-10645.3|58.2' +
  ';Kentucky Road Reserve|-14859.1|8824.2|58.2;Lyne Road Reserve|-12402.9|-11687.4|57.7;park -16033' +
  ',-6487|-16032.6|-6486.9|57.6;Eccles Park|-14494.3|-6165.9|57.3;grass -17031,-6139|-17031.2|-6139' +
  '.0|57.3;James Ruse Reserve|-18349.0|-5262.0|57.1;Middleton Park|-18440.3|4066.8|56.7;Ponds Creek' +
  ' Reserve|-14689.4|-8108.2|56.4;Karuah Oval|-7538.7|-15575.0|56.0;Church Street Native Flora Rese' +
  'rve|-8716.0|13729.5|55.9;Wattawa Reserve|-18065.0|5856.1|55.8;Rapanea Community Forest|-15057.3|' +
  '-8478.1|55.7;Como Pleasure Grounds|-12585.8|14515.5|55.6;Harry Gapes Reserve|-18821.6|-1766.6|55' +
  '.6;Stuart Park|-8994.3|13576.7|55.4;The Green|-9694.1|13301.6|55.0;Yanung Reserve|-14129.2|-1138' +
  '7.9|54.3;Canberra Road Reserve|-9027.9|16022.4|54.2;Mount Lewis Park|-14668.3|5600.8|54.2;Silver' +
  'water Park|-14820.9|-4563.2|54.1;Elizabeth Farm Reserve|-17772.0|-4988.2|53.9;grass -4089,-15317' +
  '|-4088.8|-15316.7|53.9;Truman Reserve|4885.6|-15393.6|53.5;Homelands Reserve|-15551.2|-8546.9|53' +
  '.4;recreation_ground -13312,-10711|-13311.7|-10710.7|52.9;recreation_ground -15561,-767|-15561.4' +
  '|-767.0|52.3;Williams Reserve|-15777.8|-6814.9|52.2;Burnside Gollan Reserve|-17716.4|-7560.3|52.' +
  '1;grass -7853,16759|-7852.9|16758.7|52.1;Duck River Reserve|-17934.8|-1268.8|52.0;recreation_gro' +
  'und -12246,-12100|-12246.0|-12099.9|52.0;Howson Oval|-9667.8|-13987.9|51.4;Deakin Park|-15436.9|' +
  '-2766.7|51.3;Guillfoyle Park|-16971.4|1813.2|51.0;Allder Park|-18521.9|2708.9|50.9;Forest Park|-' +
  '11709.0|-10159.3|50.7;Bilarong Reserve|6986.3|-17664.7|50.7;Lane Cove National Park|-11665.7|-12' +
  '275.3|50.0;park -6904,-14367|-6903.7|-14366.7|49.6;Bankstown City Gardens|-16102.6|6207.6|49.6;p' +
  'ark -13787,-12508|-13786.6|-12507.7|49.6;Booth Park|-13256.7|-12621.6|49.5;Beatty Reserve|-12953' +
  '.2|11504.5|49.4;Hurstville Quarry Reserve (South)|-10031.0|11966.2|49.3;WRCS Flying Field|2583.8' +
  '|-17313.1|49.2;Japanese Gardens|-17711.3|-749.6|49.1;Jubilee Park|-11899.0|11957.5|49.0;recreati' +
  'on_ground -17693,-604|-17692.7|-604.0|48.9;Marion Reserve|-18317.3|5540.2|48.1;Boundary Reserve|' +
  '-12942.0|10501.1|48.0;Smail Reserve|-16817.7|3375.6|47.8;Morona Avenue Reserve|-10424.6|-13617.8' +
  '|47.7;park -13134,-11587|-13134.3|-11586.7|47.7;park -14636,-11420|-14635.7|-11419.6|47.7;park -' +
  '8409,-13473|-8408.7|-13472.6|47.7;Baraba Reserve|-18074.4|-1335.6|47.6;Middle Creek Reserve|5363' +
  '.4|-16822.5|47.5;North Rocks Catholic Cemetery|-15818.4|-10813.6|47.4;Roselea Park|-15120.2|-113' +
  '15.3|47.3;Kurnell Boarding Stables and Riding School|-1615.6|17192.8|47.0;Claude Cameron Grove|-' +
  '7189.6|-17287.5|46.9;Acacia Park|-14938.8|-7990.0|46.6;Revesby Flood Reserve|-17208.4|7787.4|46.' +
  '5;Steam Roller Park|-13557.3|12736.2|46.1;recreation_ground -18348,-5774|-18347.6|-5774.0|45.8;D' +
  'onnelly Park|-10185.2|13617.3|45.6;park 8507,-13916|8507.3|-13916.2|45.6;Elizabeth Macarthur Par' +
  'k|-15821.6|-8170.5|45.3;Cook Park|-7143.2|15171.0|45.2;garden -17263,1297|-17263.4|1297.4|45.2;T' +
  'ucker Reserve|-13980.9|12410.7|44.9;Clarke Reserve|-15826.3|9915.2|44.4;Gillman Reserve|-18464.0' +
  '|4744.7|43.9;Dunrossil Park|-14281.4|-10709.7|43.9;Bald Face Point Reserve|-9592.4|14789.5|43.8;' +
  'James Morgan Reserve|6463.1|-14231.0|43.8;Hawkesbury Park|-8061.0|16481.3|43.6;park -15260,1720|' +
  '-15260.2|1719.8|43.5;Gazzard Park|-17046.7|4349.5|43.5;Greenacre Heights Reserve|-15041.1|5044.8' +
  '|43.5;Cutting Reserve|-15464.4|9938.5|43.4;North Epping Bowling Club|-11126.2|-12559.6|43.4;Rose' +
  ' Park|-18088.9|3302.2|43.3;Scout Memorial Park|-18505.1|-3162.0|43.0;recreation_ground -4818,-15' +
  '618|-4818.2|-15618.1|42.9;Maybrook Ave Bushland Reserve|5280.9|-14558.1|42.9;grass 945,15281|944' +
  '.6|15280.7|42.8;Mahratta|-8719.5|-15557.2|42.7;Greenhills fields|-1987.8|17375.0|42.4;Rangihou R' +
  'eserve|-18091.7|-5605.3|42.4;Bright Park|-19123.9|-1032.0|42.3;grass -18907,1097|-18907.4|1097.4' +
  '|42.1;Scott Park|-6475.0|14697.8|42.1;Taren Point Shorebird Reserve|-7500.2|16528.0|41.9;Shirley' +
  ' Street Reserve|-15072.7|-9451.8|41.8;park 378,-15876|378.0|-15875.6|41.8;McRaes Park|-11169.9|1' +
  '1407.4|41.7;Ray Park|-13849.2|-11193.8|41.7;Rorie Reserve|-15646.1|10795.4|41.6;park -13164,-782' +
  '5|-13164.1|-7824.9|41.5;Lane Cove National Park|-12327.6|-12776.7|41.3;Browns Field|-9613.4|-147' +
  '23.2|40.8;Scott Park|-6493.8|14820.9|40.8;Hamilton Park|-8463.8|-14066.8|40.5;Bloxsome Park|-165' +
  '06.0|2781.2|40.4;Toolang Playing Field|-5007.4|-16780.5|40.3;Kibo Park|-16346.1|1556.4|40.1;Arth' +
  'ur Park|-15377.6|6818.1|39.9;Robert Green Forest|-16682.2|-7155.2|39.9;Connells Point Reserve|-1' +
  '0652.3|13685.3|39.5;Duck River Reserve|-17948.5|-2315.7|39.5;Stay Upright Motorcycle Training|-1' +
  '7434.8|-3755.9|39.4;Thella Reserve|-17789.5|5541.4|39.1;Schaefer Park|-16995.0|-5747.9|38.7;Stev' +
  'ens Reserve|-15677.0|6151.3|38.5;Paul Keating Park|-16057.9|5489.1|38.4;Jim Crowgey Reserve|-164' +
  '72.6|-6513.8|38.1;Lumeah Reserve|5926.8|-18165.0|38.1;Bedes Forest|-4003.9|-15159.5|38.0;Winsor ' +
  'Park|-15170.1|3859.7|37.6;Woodstock Reserve|-15295.8|-10529.5|37.6;Experiment Farm Reserve|-1829' +
  '0.6|-5161.0|37.5;Blackbutt Park|-5729.0|-14580.0|37.5;Freeman Avenue Reserve|-13064.5|13074.6|37' +
  '.5;Lambert Reserve|-13920.3|11597.4|37.3;Hurstville Quarry Reserve (North)|-10237.2|11706.6|37.1' +
  ';Field 1|-5970.2|-18250.8|37.1;Furlough Park|8094.4|-17190.4|36.8;Beale Reserve|-13679.0|11099.5' +
  '|36.2;Wimbledon Reserve|7424.3|-17263.0|36.2;park -6738,-14068|-6737.5|-14067.6|36.1;Ruse Park|-' +
  '16056.8|7127.7|36.0;Pine Tree Park|-15427.8|-11236.7|36.0;Collett Park|-17609.1|-6384.5|35.9;Ter' +
  'esa Place Reserve|5393.8|-14460.7|35.9;park -19222,-945|-19222.2|-945.0|35.8;park -17933,-2111|-' +
  '17933.0|-2110.9|35.8;Wabash Reserve|6018.6|-15131.2|35.6;Hambledon Cottage Reserve|-18100.5|-520' +
  '9.8|35.5;New Settlers Park|-16964.5|-6892.9|35.5;Green Point Reserve|-12121.5|14568.1|35.4;park ' +
  '-13494,-12637|-13494.5|-12637.0|35.0;park -12742,9326|-12742.0|9325.7|35.0;William Wade Park|-15' +
  '942.4|-7439.9|34.7;Allan Cunningham Reserve|-14066.1|-8509.2|34.6;RAAF Stores Park|-17558.1|969.' +
  '7|34.0;Cavan Green|-12837.3|-9096.1|34.0;Sir Robert Menzies Park|-9991.9|-14450.2|34.0;Urimbirra' +
  ' Park|-18807.3|-533.9|33.9;Baralyly Park|-14469.6|-8729.7|33.8;park -12388,9196|-12387.9|9196.1|' +
  '33.8;Maunder Avenue Reserve|-3936.2|-16391.3|33.8;Lorraine Taylor Reserve|-2895.0|-16187.2|33.3;' +
  'Magney Reserve|-17147.4|2344.2|33.3;grass 5742,-17955|5742.1|-17954.8|33.2;Tyagarah Place Reserv' +
  'e|5477.7|-14519.9|33.2;Lidcombe Remembrance Park|-15306.1|-60.0|33.1;Windarra Reserve|-12694.7|8' +
  '606.7|33.1;Apex Reserve|-15607.3|4480.6|33.0;RM Campbell Reserve Park|-15706.5|5204.9|33.0;Bango' +
  'r Park|-17804.6|-2079.1|33.0;Grannys Springs|-7959.2|-14779.3|32.9;garden -17804,-4970|-17803.8|' +
  '-4970.0|32.9;nature_reserve -8671,-14535|-8671.4|-14534.6|32.6;Dog Park|-9314.9|-12691.1|32.4;Su' +
  'ffolk Avenue Reserve|7757.0|-14535.2|32.3;park -7990,13173|-7989.6|13173.1|32.2;Lindisfarne Cres' +
  'cent Reserve|-15866.9|-10149.7|32.1;park -13281,8622|-13281.3|8621.8|31.9;Salmon Reserve|-14817.' +
  '4|6741.3|31.9;Spencer Park|-16538.4|1374.5|31.9;Cutliffe Reserve|-15893.6|2302.1|31.8;park 6502,' +
  '-18018|6501.5|-18018.5|31.8;Dorothy Street Reserve|5587.9|-14663.5|31.7;park -12702,11871|-12701' +
  '.8|11870.7|31.6;Foveaux Park|-17761.6|-6029.9|31.6;Scott Park|-13561.4|7256.3|31.3;Carlingford M' +
  'emorial Park|-14694.7|-9549.1|31.2;park -16586,8987|-16586.3|8987.0|31.2;Dandarbong Reserve|-141' +
  '39.2|-8822.9|31.2;grass -18634,-3022|-18633.5|-3021.6|31.2;Carlingford Anglican Cemetery|-14008.' +
  '5|-9223.3|31.0;Kilpack Park|-14335.9|-10049.8|30.9;Fitzgerald Forest|-14880.2|-8723.9|30.9;Mortd' +
  'ale Memorial Park|-12171.8|11637.4|30.8;Norman Park|-16790.8|-40.9|30.8;park -7656,-15108|-7656.' +
  '1|-15107.7|30.6;Cherrywood Reserve|-6805.9|-17312.2|30.6;Prairie Vale Reserve|-15180.3|5494.7|30' +
  '.5;Granville Waratah Scoccer Football Club|-18314.2|-5478.1|30.4;David Scott Reserve|-12904.5|-9' +
  '906.3|30.3;Iona Creek Reserve|-14182.2|-7969.1|30.2;George Cayley Reserve|-14481.7|7616.8|30.1;M' +
  'emorial Avenue Reserve|-4621.2|-16187.8|30.1;Illoura Reserve|-19036.7|-2960.5|30.0;James Hoskin ' +
  'Reserve|-13570.1|-8768.8|29.9;park -12571,11780|-12571.1|11780.4|29.8;park -16752,-9256|-16752.5' +
  '|-9255.5|29.7;Berry Reserve|7644.7|-16592.5|29.7;park -18584,-637|-18584.3|-637.0|29.6;Chattan P' +
  'ark|7534.7|-17579.3|29.5;Civic Park|-16458.8|-720.5|29.4;grass -62,-18876|-61.6|-18875.8|29.2;gr' +
  'ass -5979,-16910|-5979.2|-16909.6|29.1;Bell Park|-9894.0|11822.5|28.9;Dover Park|-8308.3|14087.4' +
  '|28.9;park -17741,-5625|-17741.3|-5624.6|28.9;Silver Beach Reserve|-818.4|15468.7|28.8;James Whe' +
  'el Place Reserve|5892.0|-15982.9|28.7;Broadoaks Park|-14767.0|-5309.1|28.7;Orange Green Park|-59' +
  '18.9|-16856.9|28.5;grass -17699,2428|-17699.1|2428.5|28.5;Sans Souci Park|-7372.1|15074.5|28.3;p' +
  'ark -16170,-6462|-16169.8|-6461.9|28.2;Johnstone Reserve|-14713.1|10235.2|28.2;Prairievale Reser' +
  've|-9301.1|12767.5|28.0;Hume Park|-15338.4|-2948.5|28.0;New Glasgow Park|-17917.1|-2590.6|28.0;g' +
  'rass -16945,-6168|-16945.2|-6167.9|28.0;McLeod Reserve|-16308.5|4646.0|27.9;Irish Town Grove|-62' +
  '94.9|-15753.3|27.8;Basil Street Reserve|-15163.1|9683.1|27.8;Alice Park|-16541.3|4878.1|27.7;Pea' +
  'rce Avenue Reserve|-13564.8|10205.8|27.6;Eric Mobbs Memorial Park|-14584.9|-9467.2|27.5;park -10' +
  '404,-11741|-10403.6|-11741.3|27.5;Charles Reserve|-13480.8|9441.4|27.3;Harley Park|-12423.8|-933' +
  '4.0|27.3;Queens Wharf Park|-18093.5|-5476.4|27.1;park -14960,5256|-14960.3|5255.9|27.1;park -164' +
  '22,5961|-16422.0|5961.3|27.0;recreation_ground -18320,-5988|-18319.8|-5987.5|26.8;nature_reserve' +
  ' -9704,-12956|-9704.3|-12955.7|26.8;Neverfail Bay Reserve|-12218.3|13888.3|26.6;Dorothy Park|-14' +
  '909.3|6194.3|26.4;grass -6962,14964|-6962.1|14964.0|26.3;park -14612,-11872|-14612.3|-11872.0|26' +
  '.2;Oatley Memorial Park|-11779.2|12958.6|26.2;park -14210,-7573|-14209.6|-7573.3|26.2;102 Roseda' +
  'le Road (Gazettal in Progress)|-4928.6|-14647.4|26.0;Padstow Bowling and Recreation Club|-16203.' +
  '5|9320.8|25.9;Barra Wood|-4040.3|-14859.3|25.8;Toronto Avenue Reserve|5984.1|-15199.2|25.8;grass' +
  ' -5959,-14970|-5959.3|-14970.4|25.7;grass -17185,-5806|-17184.7|-5806.5|25.6;park -14854,7941|-1' +
  '4853.8|7941.4|25.6;Eyles Reserve|-13770.4|-8336.2|25.5;park -6476,-15642|-6475.9|-15642.5|25.4;T' +
  'erry Street Reserve|-9206.8|12755.8|25.3;Berry Reserve|7752.1|-17165.3|25.3;Simpson Reserve|-123' +
  '39.4|13696.3|25.2;Kulgun Park|-16946.8|390.5|25.1;Duncan Park|-12563.6|-10154.5|25.0;Laura Osbor' +
  'ne Houison Sanctuary|-8708.8|-15132.6|25.0;Grove Park|-10395.8|11731.6|24.9;Transmission Park|-4' +
  '291.3|-18377.5|24.9;Oatley Memorial Gardens|-11734.9|12616.6|24.8;Basil Cook Reserve|-13708.7|-1' +
  '0556.4|24.6;Richard Podmore Reserve|-13102.3|8478.7|24.5;grass 812,15664|811.6|15664.0|24.5;gras' +
  's -10542,-14974|-10541.6|-14973.5|24.5;Maxwell Park|-17556.8|5283.3|24.5;park -414,-15324|-414.1' +
  '|-15324.2|24.3;Auburn Memorial Park|-16247.1|-1784.2|24.0;Aqua Flora Park|-6276.6|14612.2|23.9;g' +
  'rass 1024,15802|1024.5|15802.0|23.9;Lachlan Macquarie Park|-14074.9|-7646.3|23.6;Surfrider Garde' +
  'ns|8055.5|-17007.7|23.3;park -7399,15811|-7398.8|15810.7|23.0;park -16021,8936|-16020.8|8936.4|2' +
  '2.9;Gardenia Reserve|-15379.4|6022.9|22.8;Tallowwood Avenue Reserve|-14989.2|12033.8|22.8;Henry ' +
  'Lawson Drive Reserve|-14108.0|10470.2|22.6;park 8364,-15110|8364.4|-15109.8|22.1;grass -18947,-3' +
  '144|-18947.1|-3144.0|22.1;grass -7080,15092|-7079.6|15091.8|22.1;park -15638,-10319|-15638.1|-10' +
  '319.2|21.4;grass -4495,-18481|-4495.2|-18480.8|21.3;park -17891,-5639|-17891.4|-5639.1|21.3;gras' +
  's -13436,-9169|-13435.5|-9169.2|21.3;Silver Beach Reserve|561.2|15416.0|21.2;Georges River Natio' +
  'nal Park|-15087.6|10693.3|20.7;York Street Park|-16737.2|746.0|20.7;Harvey Dixon Park|-14962.8|1' +
  '0455.4|20.7;Jacob Park|-16752.8|2779.5|20.6;park 7348,-14735|7347.6|-14734.8|20.3;Henty Park|-18' +
  '158.7|3875.4|20.3;Rosella Park|-18565.2|-4658.1|20.3;Charles Fraser Park|-14429.4|-8854.2|20.1;K' +
  'eppel Avenue Reserve|-14612.6|9646.2|20.0;grass 263,15616|262.9|15616.3|19.9;grass -16866,8328|-' +
  '16865.8|8327.6|19.8;park 8610,-15022|8610.4|-15022.4|19.8;Lane Cove National Park|-10355.4|-1150' +
  '0.4|19.4;Jinna Road Reserve|-13697.3|12224.2|19.2;park -12411,11554|-12411.3|11553.6|19.0;Willia' +
  'm Lamb Park|-18580.7|-1400.0|18.4;18th Brigade Remembrance Drive Reserve|-18458.1|4368.8|18.2;pa' +
  'rk -16636,5190|-16635.9|5190.0|18.0;Reid Park|-16037.4|-5299.4|17.9;18th Brigade Remembrance Dri' +
  've Reserve|-18185.5|4401.8|17.7;Braemar Park|-12721.1|-8611.4|17.7;park -12425,-10800|-12425.0|-' +
  '10799.7|17.7;Herbert Rumsey Reserve|-15214.4|-8778.7|17.6;park -14649,-4768|-14648.8|-4768.0|17.' +
  '3;Ambleside Reserve|6079.3|-15363.9|16.9;park 7395,-16503|7395.0|-16503.0|16.4;grass -16876,-613' +
  '6|-16875.9|-6136.5|16.2;RAAF Site Park 1|-18122.5|1354.9|16.1;Progress Park|-12907.4|9227.0|15.8' +
  ';park -16681,5427|-16680.7|5427.1|15.8;park -15733,-10939|-15733.4|-10939.4|15.3;Young Street Re' +
  'serve|-10434.1|15583.5|15.3;park -13680,7506|-13680.1|7505.8|15.1;park -13852,-9564|-13852.5|-95' +
  '63.7|14.9;grass -17404,-2235|-17404.5|-2235.4|14.9;park -11586,-14765|-11585.7|-14765.3|14.6;Ova' +
  'l|-15620.9|-9484.7|14.2;park -11188,15168|-11188.5|15168.3|13.6;Saint Johns Reserve|-17129.1|829' +
  '.2|13.0;park 7916,-17596|7916.5|-17596.4|13.0;Kennington Oval|-17297.0|803.3|12.9;Don Stewart Pa' +
  'rk|-13714.9|-9528.9|12.6';

/**
 * Every park, inner block then middle, in that order and no other.
 *
 * The order is the invariance. `parkCells` hashes on the park's **index**, so
 * park 12 is the same twenty-three turkeys before and after the middle ring
 * existed only because park 12 is still Blackwattle Bay Park. Appending is the
 * whole trick: nothing above `PARKS_INNER.length` moves, and `verifyWildlife`
 * asserts the prefix is still inside the ring it was baked in.
 */
export const PARKS: readonly Park[] = (() => {
  const out: Park[] = PARKS_INNER.slice();
  for (const packed of [PARKS_MIDDLE_PACKED, PARKS_OUTER_PACKED]) {
    for (const rec of packed.split(';')) {
      const f = rec.split('|');
      out.push({ name: f[0], x: +f[1], z: +f[2], r: +f[3] });
    }
  }
  return out;
})();

/** The extent the parks were extracted inside. `verifyWildlife` asserts it. */
export const PARK_EXTENT_M = 19300;

/**
 * The extent the frozen prefix was baked inside, and how long it is.
 *
 * See `PARKS`. `factions.STATION_INNER_EXTENT_M` is the same idea in the same
 * words, for the same reason.
 */
export const PARK_INNER_EXTENT_M = 5300;
export const PARK_INNER_COUNT = PARKS_INNER.length;

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
  /** Candidate park indices from `PARK_GRID`, ascending. See `forEachWildlifeNear`. */
  parks: number[];
}

export function createWildScratch(): WildScratch {
  return { bands: [], picks: [], parks: [] };
}

/**
 * Which parks are near a point, without walking the whole table.
 *
 * **A broadphase, added when the table went from 248 discs to 1,345.** The
 * scan in `forEachWildlifeNear` was a reach test against every row, which is
 * the right shape at 248 and measured 1.7 us a query; at 1,345 the same loop
 * measured 10.5 us, and it runs per player per tick as well as per frame. A
 * stage-3 bake would make it 55.
 *
 * **Re-measured at 1,821**, which is what the 19,300 m ring takes it to: the
 * linear reach test is 5.3 us a query and the grid is 0.36 us -- 15x, and the
 * grid figure includes posing the birds it finds while the scan only rejects.
 * The index costs 2,820 (cell, park) pairs, about 22 kB, and
 * `PARK_GRID_COVERAGE` is 1,821 of 1,821, so no disc has fallen out of the
 * grid.
 *
 * The grid is built once at module load and never touched again: a park is
 * registered in every cell its **disc bounding box** overlaps, so a query whose
 * own bounding box overlaps that box shares at least one cell with it, and the
 * circle test that follows is the same circle test as before. It is a superset,
 * not a substitute -- nothing is decided here except which rows are worth
 * asking about.
 *
 * **The order is the invariance**, and it is why this returns indices rather
 * than parks and why they are sorted. `forEachWildlifeNear` walks parks in table
 * order and its visitor may stop the walk; a broadphase that returned them in
 * bucket order would change which bird a stopping query stopped on, which is a
 * different bird in two processes. Sorted ascending, the candidate list is
 * exactly the old loop with the far rows skipped -- and the far rows were going
 * to be skipped by the reach test anyway.
 */
const PARK_GRID_CELL = 512;

function parkGridKey(cx: number, cz: number): number {
  return ((cx | 0) << 16) ^ (cz & 0xffff);
}

const PARK_GRID = (() => {
  const grid = new Map<number, number[]>();
  for (let p = 0; p < PARKS.length; p++) {
    const park = PARKS[p];
    const x0 = Math.floor((park.x - park.r) / PARK_GRID_CELL);
    const x1 = Math.floor((park.x + park.r) / PARK_GRID_CELL);
    const z0 = Math.floor((park.z - park.r) / PARK_GRID_CELL);
    const z1 = Math.floor((park.z + park.r) / PARK_GRID_CELL);
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const key = parkGridKey(cx, cz);
        // Pushed in ascending `p`, so every bucket is already sorted and the
        // merge below only has to dedupe across buckets.
        const cell = grid.get(key);
        if (cell === undefined) grid.set(key, [p]);
        else cell.push(p);
      }
    }
  }
  return grid;
})();

/** How many (cell, park) pairs the grid holds. Reported by `verifyWildlife`. */
export const PARK_GRID_ENTRIES = (() => {
  let n = 0;
  for (const cell of PARK_GRID.values()) n += cell.length;
  return n;
})();

/**
 * How many distinct parks the grid can actually reach.
 *
 * The one thing a broadphase can get wrong that nothing else would notice: a
 * park registered in no cell is a park with no birds, at no cost, with no
 * error. It cannot happen -- every disc has a bounding box and every box
 * overlaps at least one cell -- which is exactly the kind of "cannot happen"
 * that is worth one line of arithmetic at module load. `verifyWildlife` asserts
 * it equals `PARKS.length`.
 */
export const PARK_GRID_COVERAGE = (() => {
  const seen = new Set<number>();
  for (const cell of PARK_GRID.values()) for (const p of cell) seen.add(p);
  return seen.size;
})();

function parksNear(x: number, z: number, radius: number, out: number[]): number[] {
  out.length = 0;
  const x0 = Math.floor((x - radius) / PARK_GRID_CELL);
  const x1 = Math.floor((x + radius) / PARK_GRID_CELL);
  const z0 = Math.floor((z - radius) / PARK_GRID_CELL);
  const z1 = Math.floor((z + radius) / PARK_GRID_CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const cell = PARK_GRID.get(parkGridKey(cx, cz));
      if (cell === undefined) continue;
      for (let i = 0; i < cell.length; i++) out.push(cell[i]);
    }
  }
  // Ascending, then adjacent duplicates dropped: a park whose box spans four of
  // the visited cells arrives four times. Numeric compare rather than the
  // default lexicographic one, which would put 10 before 9.
  out.sort((a, b) => a - b);
  let w = 0;
  for (let i = 0; i < out.length; i++) {
    if (i === 0 || out[i] !== out[i - 1]) out[w++] = out[i];
  }
  out.length = w;
  return out;
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
  //
  // `parksNear` is a broadphase over the same table in the same order, not a
  // different traversal: see its note. The reach test below is unchanged and
  // still decides.
  const candidates = parksNear(x, z, radius, scratch.parks);
  for (let c = 0; c < candidates.length; c++) {
    const p = candidates[c];
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
  if (PARKS.length <= PARK_INNER_COUNT) {
    failures.push(
      `Only ${PARKS.length} parks are baked and the frozen inner ring is ${PARK_INNER_COUNT} of them; ` +
        'the middle-ring extract found 1,345. The new ring would have no parkland birds at all.',
    );
  }
  // The frozen prefix. `parkCells` hashes on the index, so a row inserted above
  // `PARK_INNER_COUNT` would silently re-roll every turkey in the inner city --
  // which is invisible from the table and obvious from a park. Every inner row
  // is inside the ring it was baked in and the block is still sorted by radius.
  for (let i = 0; i < PARK_INNER_COUNT && i < PARKS.length; i++) {
    const park = PARKS[i];
    const d = Math.sqrt(park.x * park.x + park.z * park.z);
    if (d > PARK_INNER_EXTENT_M) {
      failures.push(
        `Row ${i} of the frozen inner-ring block is ${park.name} at ${d.toFixed(0)} m, outside the ` +
          `${PARK_INNER_EXTENT_M} m bake it came from. The block has moved and every bird in it with it.`,
      );
    }
    if (i > 0 && PARKS[i - 1].r < park.r) {
      failures.push(`The frozen inner-ring park block is no longer sorted by radius at row ${i} (${park.name}).`);
    }
  }
  // The packed middle block has to have survived its own parse: a record that
  // lost a field arrives as NaN, and a NaN radius rejects every cell silently.
  for (let i = PARK_INNER_COUNT; i < PARKS.length; i++) {
    const park = PARKS[i];
    if (park.name === '' || !Number.isFinite(park.x) || !Number.isFinite(park.z) || !Number.isFinite(park.r)) {
      failures.push(`Middle-ring park row ${i} did not parse out of PARKS_MIDDLE_PACKED: ${JSON.stringify(park)}.`);
      break;
    }
  }
  if (PARK_GRID_COVERAGE !== PARKS.length) {
    failures.push(
      `The park broadphase reaches ${PARK_GRID_COVERAGE} of ${PARKS.length} parks. The ones it does not ` +
        'hold have no birds at all, and there is no frame anywhere that says so.',
    );
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
