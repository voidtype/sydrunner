/**
 * The two street factions: **meth heads** and **drunks**.
 *
 * The simulation half. `world/streetlife.ts` is what they look like, and the
 * split is `game/factions.ts` against `world/police.ts` exactly and for the
 * identical reason: this file is compiled into the Bun server and must not drag
 * a `SkinnedMesh` in behind an aggro test.
 *
 * Everything here is a *consumer* of `game/factions.ts` and edits none of it.
 * Two kind bytes were reserved there for this faction and are claimed below;
 * the lifecycle, the eviction, the damage door, the crime call and the witness
 * query all come from that module unchanged. What this file adds is three
 * things that module deliberately does not have an opinion about: **where these
 * people stand**, **what makes them come at you**, and **whether hitting one is
 * a crime**.
 *
 * ---------------------------------------------------------------------------
 * 1. TWO FACTIONS, TWO TRIGGERS, AND WHY THAT IS THE WHOLE DESIGN
 *
 * The user's brief is two sentences and they differ in exactly one word:
 *
 *   - meth heads *"based on crime stats per area, attack u"* -- **on sight**,
 *     at `METH_SIGHT` metres with a clear line, whether you were doing anything
 *     or not. They are the aggressor, so fighting one is not a crime and the
 *     police do not care.
 *   - drunks *"only aggressive if u get too close to them"* -- **on
 *     proximity**, at `DRUNK_SNAP` metres, and not before. Until then they are
 *     bystanders, so batting one *is* a crime, and `policeHostileTo` points the
 *     police at them the moment they start swinging.
 *
 * That single difference is what makes them read as two different kinds of
 * trouble rather than as two skins on one enemy, and it is why every number
 * below is paired: a sight radius against a personal space, a chase against a
 * shove, a crime that never fires against one that fires only while they are
 * calm.
 *
 * ---------------------------------------------------------------------------
 * 2. ANCHORS: ONE TABLE OF SUBURBS, ONE OF PUBS, BOTH BAKED
 *
 * `SUBURBS` is `place=suburb|neighbourhood` out of the same
 * `data/cache/sydney.osm.pbf` the city was built from, projected through the
 * identical `geo.lonlat_to_enu` -> `geo.enu_to_world` path, curated down to the
 * ones inside the extent that a player will actually walk. `VENUE_XZ` is every
 * `amenity=pub|bar|biergarten` in the same extent -- 422 of them after a 30 m
 * dedupe that folds a pub mapped as both a node and its own building outline
 * into one venue.
 *
 * **The coordinates are data and the weights are taste**, and the whole of this
 * feature's honesty is in keeping those two apart. `POLICE_STATIONS` says the
 * same thing about the same problem: NSW publishes incident counts by Local
 * Area Command, the LAC boundaries are not in this build, and dressing a number
 * scraped from a PDF as a simulation would be worse than saying plainly what
 * this is. So `crime` and `booze` are **stylised**: Redfern, Waterloo, Kings
 * Cross, Darlinghurst and Surry Hills are heavy, the harbour-side suburbs are
 * light, and that is the shape the real figures have and the shape a player
 * expects walking from Cleveland Street to Mosman.
 *
 * ---------------------------------------------------------------------------
 * 3. WHERE AN AMBIENT ONE ACTUALLY STANDS
 *
 * Not on a reserved pedestrian slot. `factions.POLICE_SLOT_BASE` takes eight of
 * the sixteen identities `pedKey` has spare and walks officers down the band
 * schedule, which is exactly right for a *beat* -- two people going somewhere.
 * A loiterer is not going anywhere, and a walker rescheduled to a stop is a
 * walker with a broken schedule.
 *
 * So these are placed **on** the bands rather than **through** them: a suburb
 * or a venue picks a small pool of nearby footpaths, a hash chooses one and a
 * position along it, and the person stands there and paces. The band geometry
 * is doing what it is good at -- guaranteeing the spot is a footpath rather
 * than the middle of a road or the inside of a terrace -- and none of the
 * schedule machinery is involved.
 *
 * The pool is biased by lane class, which is what "laneways and back streets"
 * has to mean in this data: `traffic.LANE_CLASSES` index 13 is `service` and 10
 * is `residential`, and `CLASS_BIAS` prefers them for meth heads and leaves
 * drunks on whatever fronts their pub. It is the same trick `beatBand` uses
 * against a station and it inherits the same caveat, stated once here rather
 * than rediscovered: **the two ends do not always hold the same bands**. The
 * server has the whole extent and a browser has a ring around the player, so an
 * ambient loiterer near the edge of what a client has streamed may be a few
 * metres from where the server has them. Nothing is decided off that position
 * except a promotion, which the authority does alone and puts on the wire.
 *
 * ---------------------------------------------------------------------------
 * 4. THE PROMOTION RULE, AND THE PASSIVE DRUNK
 *
 * A drunk is promoted at `DRUNK_NOTICE` -- *further* than they aggro at -- and
 * that gap is load-bearing rather than a fudge. An ambient actor cannot be hit:
 * `npcHitTest` walks `field.actors` and nothing else, so a drunk who only
 * became real at the instant they turned on you would be a drunk who was
 * **never strikeable while passive**, and "batting a passive drunk is a crime"
 * would be a rule that could not fire. Promoting them at 7 m and letting them
 * aggro at 4 gives three metres of a real, hittable, entirely peaceable person
 * standing outside a pub -- which is the whole of the interaction the user
 * asked for.
 *
 * `NpcActor.target < 0` is therefore the passive/aggro flag, and it is one the
 * framework already maintains: `promote(..., target)` sets it, `actorPriority`
 * scores a targetless actor below a pursuing one so a passive drunk is the
 * first thing evicted when the shared 24-actor cap bites, and `strikeCrime`
 * below reads it to decide whether the police should care.
 *
 * ---------------------------------------------------------------------------
 * 5. DETERMINISM, restated because this file is full of hashes
 *
 * `game/factions.ts`'s rule 5 in full, and one addition. No `Math.hypot`, no
 * `sin`, `cos` or `atan2` on any shared path, every random choice out of
 * `traffic.carHash`.
 *
 * The addition is the **idle**. A pacing loiterer and a swaying drunk both want
 * a periodic function of time, and the obvious one is a sine -- which is
 * implementation-defined and would put a meth head a metre from where the
 * server has them. `triangle` below is the replacement: a fold of the
 * fractional part, three adds and a multiply, exact in both engines. It is not
 * a compromise. A twitchy pacing step reads *better* as a triangle than as a
 * sine, because a sine spends most of its time at the ends of the stroke and a
 * person pacing does not.
 */

import { type CombatantState } from './combat.ts';
import {
  NPC_KIND,
  NPC_STATE,
  REASON,
  policeHostileTo,
  registerNpcKind,
  type FactionCtx,
  type NpcActor,
} from './factions.ts';
import { createBeatPose, forEachPoliceNear } from './factions.ts';
import { createPedPose, type PedBand, type PedPose, type PedestrianField } from './pedestrians.ts';
import { carHash, trafficSeconds } from './traffic.ts';
import { EYE_HEIGHT } from '../player/controller.ts';

// --- The suburbs -------------------------------------------------------------------

/**
 * One suburb, its OSM centroid, and how much trouble it is.
 *
 * `crime` drives how many meth heads loiter in it and `booze` how many drunks a
 * pub in it carries. Two columns rather than one because they genuinely
 * disagree: Double Bay has bars and no meth heads, Waterloo has meth heads and
 * almost no bars, and a single "trouble" number would make both of them wrong
 * in the same direction.
 */
export interface Suburb {
  readonly name: string;
  /** World metres, renderer frame: +X east, +Z south. Baked from OSM. */
  readonly x: number;
  readonly z: number;
  /** 0..1, stylised. See the header. */
  readonly crime: number;
  /** 0..1, stylised. How hard the pubs in this suburb go. */
  readonly booze: number;
}

/**
 * The curated set: every `place=suburb|neighbourhood` centroid inside the
 * extent that a player can reach, with the two weights.
 *
 * Fifty-two of the eighty-five the extract found. The ones dropped are water
 * features, industrial spans and the handful of neighbourhood labels that name
 * a single building -- "Quay Quarter", "The Hungry Mile" -- which would put a
 * loiterer in a lobby.
 *
 * Kings Cross has no `place` node in OSM at all, which is a fact about the data
 * rather than about the Cross: it is mapped as a locality inside Potts Point.
 * The coordinate below is the `railway=station` node, which is the middle of
 * Darlinghurst Road and is exactly where the user means.
 *
 * ---------------------------------------------------------------------------
 * **St Peters is the same hole, and it was the expensive one.** Players spawn
 * in Sydney Park, at (-2236, +4543), which is the St Peters corner of
 * Erskineville and Alexandria -- and a re-extract of every
 * `place=suburb|neighbourhood|quarter|locality` inside the extent returns 173
 * features and not one of them is St Peters. So the suburb a player *starts in*
 * had no anchor, and the nearest ones that did were Alexandria at 728 m and
 * Erskineville at 818 m, both with a spread of about 220 m. Measured over forty
 * ticks, the count of meth heads within **600 m** of the spawn was **zero**, and
 * the first six hundred metres of a walk up Sydney Park Road met none either.
 * The user's report was "I never saw any police or meth heads", and for this
 * half of it the table was simply missing the suburb.
 *
 * The coordinate is the `railway=station` node, on the Kings Cross precedent:
 * it is real extracted data rather than a guess, and St Peters station sits on
 * the Princes Highway a block from the King Street shops, which is where the
 * suburb actually happens.
 *
 * `Newtown South` is the second addition and is not a suburb at all -- it is the
 * representative point of the Newtown *polygon*, which lands at the King Street
 * end nearest the spawn while the existing `Newtown` row is the `place` node up
 * at the station. One row per end of a 1.4 km high street, because a single
 * anchor at one end of King Street leaves the other end empty and King Street is
 * the walk this whole fix exists to populate.
 */
export const SUBURBS: readonly Suburb[] = [
  // --- Heavy. The user's own list first.
  { name: 'Redfern', x: -440.5, z: 2703.8, crime: 1.0, booze: 0.45 },
  { name: 'Kings Cross', x: 1207.1, z: 609.9, crime: 0.95, booze: 1.0 },
  { name: 'Waterloo', x: -122.8, z: 3493.8, crime: 0.9, booze: 0.3 },
  { name: 'Darlinghurst', x: 936.5, z: 1041.8, crime: 0.85, booze: 0.9 },
  { name: 'Surry Hills', x: 97.9, z: 1741.3, crime: 0.8, booze: 0.8 },
  { name: 'Woolloomooloo', x: 923.7, z: 325.1, crime: 0.75, booze: 0.55 },
  // --- The inner ring.
  { name: 'Haymarket', x: -423.9, z: 1409.6, crime: 0.65, booze: 0.6 },
  { name: 'Sydney', x: 35.7, z: -3.9, crime: 0.6, booze: 0.8 },
  { name: 'Chippendale', x: -842.8, z: 1959.2, crime: 0.6, booze: 0.55 },
  { name: 'Newtown', x: -2639.3, z: 3076.3, crime: 0.6, booze: 0.95 },
  { name: 'Chinatown', x: -465.5, z: 1069.4, crime: 0.55, booze: 0.5 },
  { name: 'Darlington', x: -1444.9, z: 2472.6, crime: 0.55, booze: 0.3 },
  // The King Street end of Newtown, and the industrial inner south. See the
  // header: `Newtown South` and `St Peters` are holes the extract cannot fill,
  // and Alexandria was weighted as a warehouse estate rather than as the corner
  // it actually is.
  //
  // The three weights are the same taste decision every weight in this table is
  // -- read the header on what `crime` is and is not -- and they are set as a
  // *class*: this is the King Street corridor south of the university, and it
  // gets Newtown's and Chippendale's number rather than Double Bay's, which is
  // the shape the user's own list has. What that produces, measured from the
  // spawn: three loiterers inside 500 m where there were none inside 600 m.
  { name: 'Newtown South', x: -2827.5, z: 3500.8, crime: 0.55, booze: 0.75 },
  { name: 'Alexandria', x: -1509.8, z: 4503.3, crime: 0.55, booze: 0.35 },
  { name: 'St Peters', x: -2572.9, z: 4314.5, crime: 0.6, booze: 0.5 },
  { name: 'Macdonaldtown', x: -1470.8, z: 3301.9, crime: 0.5, booze: 0.3 },
  { name: 'Ultimo', x: -984.4, z: 1201.1, crime: 0.5, booze: 0.45 },
  { name: 'Glebe', x: -2115.9, z: 1033.1, crime: 0.5, booze: 0.6 },
  { name: 'Potts Point', x: 1386.2, z: -165.8, crime: 0.5, booze: 0.75 },
  { name: 'Erskineville', x: -2091.2, z: 3738.7, crime: 0.45, booze: 0.5 },
  { name: 'Eveleigh', x: -1605.8, z: 2934.5, crime: 0.4, booze: 0.2 },
  { name: 'Enmore', x: -3483.3, z: 3488.8, crime: 0.35, booze: 0.7 },
  { name: 'Zetland', x: -24.9, z: 4311.4, crime: 0.35, booze: 0.25 },
  { name: 'Beaconsfield', x: -748.3, z: 4746.4, crime: 0.35, booze: 0.2 },
  { name: 'Pyrmont', x: -1566.0, z: 73.4, crime: 0.35, booze: 0.45 },
  { name: 'The Rocks', x: -107.5, z: -975.2, crime: 0.3, booze: 0.85 },
  { name: 'Elizabeth Bay', x: 1762.0, z: 290.1, crime: 0.3, booze: 0.4 },
  { name: 'Rushcutters Bay', x: 1710.0, z: 662.2, crime: 0.3, booze: 0.4 },
  { name: 'Camperdown', x: -2660.5, z: 2355.4, crime: 0.3, booze: 0.35 },
  { name: 'Bondi Junction', x: 3822.1, z: 2619.0, crime: 0.3, booze: 0.5 },
  { name: 'Strawberry Hills', x: -42.7, z: 2265.4, crime: 0.3, booze: 0.3 },
  { name: 'Stanmore', x: -3989.1, z: 2829.1, crime: 0.25, booze: 0.35 },
  { name: 'Forest Lodge', x: -2841.5, z: 1354.0, crime: 0.25, booze: 0.3 },
  { name: 'Kensington', x: 1026.6, z: 4743.2, crime: 0.25, booze: 0.3 },
  { name: 'Moore Park', x: 1221.6, z: 2977.6, crime: 0.2, booze: 0.2 },
  { name: 'Paddington', x: 1692.3, z: 1674.2, crime: 0.2, booze: 0.6 },
  { name: 'Annandale', x: -3518.7, z: 1440.2, crime: 0.2, booze: 0.35 },
  { name: 'Leichhardt', x: -4916.8, z: 1543.8, crime: 0.2, booze: 0.4 },
  { name: 'North Sydney', x: -115.4, z: -3568.8, crime: 0.2, booze: 0.35 },
  { name: 'Barangaroo', x: -718.5, z: -807.4, crime: 0.15, booze: 0.5 },
  { name: 'Balmain', x: -2662.9, z: -1107.0, crime: 0.15, booze: 0.55 },
  { name: 'Rozelle', x: -3241.2, z: -420.0, crime: 0.15, booze: 0.4 },
  { name: 'Lilyfield', x: -4406.5, z: 320.5, crime: 0.15, booze: 0.2 },
  { name: 'Edgecliff', x: 2501.1, z: 1173.5, crime: 0.15, booze: 0.25 },
  { name: 'Crows Nest', x: -807.6, z: -4775.0, crime: 0.15, booze: 0.45 },
  { name: 'Millers Point', x: -485.7, z: -1067.5, crime: 0.12, booze: 0.4 },
  { name: 'McMahons Point', x: -649.1, z: -2702.2, crime: 0.1, booze: 0.2 },
  { name: 'Milsons Point', x: 163.9, z: -2407.2, crime: 0.1, booze: 0.25 },
  { name: 'Neutral Bay', x: 757.4, z: -3841.5, crime: 0.1, booze: 0.3 },
  // --- Light. The harbour, where the user says this does not happen.
  { name: 'Kirribilli', x: 561.9, z: -2354.2, crime: 0.08, booze: 0.2 },
  { name: 'Waverton', x: -1165.9, z: -3448.3, crime: 0.08, booze: 0.15 },
  { name: 'Double Bay', x: 3081.5, z: 816.2, crime: 0.08, booze: 0.35 },
  { name: 'Woollahra', x: 3250.2, z: 1829.3, crime: 0.08, booze: 0.3 },
  { name: 'Cremorne', x: 1410.5, z: -4771.3, crime: 0.07, booze: 0.2 },
  { name: 'Greenwich', x: -2271.8, z: -4263.1, crime: 0.06, booze: 0.1 },
  { name: 'Bellevue Hill', x: 4359.0, z: 1135.5, crime: 0.06, booze: 0.15 },
  { name: 'Rose Bay', x: 5206.2, z: 505.8, crime: 0.06, booze: 0.2 },
  { name: 'Point Piper', x: 3908.3, z: -197.3, crime: 0.05, booze: 0.1 },
  { name: 'Mosman', x: 3165.2, z: -4055.6, crime: 0.05, booze: 0.2 },
];

/** The extent both tables were extracted inside. `verifyStreetlife` asserts it. */
export const STREET_EXTENT_M = 5300;

/**
 * Every `amenity=pub|bar|biergarten` in the extent, as flat integer x, z pairs.
 *
 * **Packed rather than records**, and it is the one place this file departs
 * from `POLICE_STATIONS`' shape. Nineteen stations with names is a table a
 * reader can check by eye; four hundred and twenty-two named venues is five
 * pages nobody reads, and the names are not used for anything -- a drunk does
 * not know which pub they came out of. Metres, rounded: a pub's front door is
 * not a surveyed point and the loiterer is placed on the nearest footpath in
 * any case.
 *
 * Extracted the same way the stations were: a read-only scratch script over
 * `data/cache/sydney.osm.pbf`, projected through `sydney.geo.lonlat_to_enu` and
 * `enu_to_world`, the points and multipolygon layers merged and deduped at 30 m
 * so a pub mapped as both a node and its own building outline arrives once.
 */
export const VENUE_XZ: readonly number[] = [
  61, -48, 69, 49, -7, -88, -73, -51, 90, -15, -56, 84, 136, -83, -29, 189,
  -199, -25, -34, -201, -87, -214, -134, -190, -268, -23, -255, 90, -33, -290, -301, -83,
  -321, -19, -183, -280, -340, -44, -327, 107, -359, 12, -332, 188, -176, 342, -386, -11,
  -375, 113, -342, -218, -116, 390, -410, 77, -404, 125, -120, -406, -390, 170, -451, -5,
  -398, 212, -411, -210, 385, -255, -391, -257, -252, -397, 46, 475, -380, -298, -443, -199,
  262, -427, -448, -234, -346, 369, -92, -511, -311, 432, -545, -4, -478, 274, -59, -550,
  -164, -543, -520, -228, -563, -102, 231, -530, -134, -580, -390, 482, -536, -321, 33, -636,
  -189, -616, -611, 212, -94, 650, -147, 657, -557, -401, 13, -690, -128, -688, -84, -696,
  -157, 689, 700, -111, -49, -711, -347, 626, -720, -160, 86, -757, -118, -766, 495, 607,
  0, -784, 117, -775, -734, -287, -664, 430, -701, -382, -631, -498, 703, 399, -274, 770,
  -284, -774, -40, 870, -248, 840, -356, 816, 613, 648, -86, 892, -570, -701, -412, 808,
  -294, 858, 668, 621, 564, 718, 916, -8, -197, 900, -96, -925, 557, 750, 939, 12,
  -458, 827, -301, 899, 312, -896, -591, 767, 354, 916, 596, 782, 262, 977, -85, -1013,
  1024, -16, -285, 986, -136, 1018, 247, 1004, 1032, 82, -228, -1012, 33, 1052, -139, 1052,
  -174, 1052, -798, -707, -287, 1029, -75, -1075, -1070, 134, -422, 999, -131, -1085, 86, 1120,
  -65, -1125, -195, -1114, -342, 1082, 1141, 121, 1056, 462, -721, 916, -170, 1165, 693, 972,
  482, 1094, 567, 1069, 128, 1204, -355, 1159, 51, 1231, -564, -1097, 400, -1168, 14, 1238,
  515, 1128, -323, 1209, -446, 1178, 64, 1261, -337, -1226, 1100, 661, -604, -1136, 770, 1036,
  -567, -1165, -109, -1293, 1219, 479, 1140, 645, 521, 1216, 617, 1174, 568, 1210, -205, -1342,
  606, 1215, 1188, 661, -396, 1306, -672, -1192, -1340, 306, 177, 1376, 561, 1276, -1399, 131,
  1281, 606, -973, 1048, 1316, 566, 1348, 489, 668, 1276, -530, 1342, 583, 1321, 709, 1259,
  1282, 671, 548, 1342, 1404, 367, -1449, 102, -1146, 895, 1062, 1006, 699, 1303, 88, 1483,
  1348, 643, 1371, 595, 1497, 9, 1135, 977, 675, 1338, -256, 1489, -1518, -96, 1124, 1042,
  1428, 578, -222, 1534, 780, 1347, -1562, -116, 1475, 544, -413, 1523, 49, 1578, -449, 1518,
  213, 1573, 1446, 678, 259, 1592, 843, 1378, 695, 1483, 330, 1606, 105, 1647, 1481, 770,
  81, 1678, 920, 1417, -55, 1705, 676, 1587, 207, 1736, 171, 1744, 253, 1746, 885, 1532,
  -547, 1695, -623, 1671, 497, 1713, -687, 1668, 488, 1750, -53, 1816, 357, 1795, -637, 1726,
  1053, 1554, -698, 1745, -151, 1874, 452, 1834, -176, 1900, -782, 1746, -690, 1787, -664, 1814,
  847, 1741, -651, 1849, 41, 1964, -83, 1965, -1330, 1457, 1160, 1606, -1803, 834, -647, 1880,
  -1576, -1213, -947, 1757, 460, 1945, 769, 1858, 114, 2035, 1276, 1598, -1522, 1424, 207, 2085,
  -1174, 1774, 941, 1942, -1184, 1804, 584, 2086, -1213, 1822, -1364, 1721, -1289, 1797, 55, -2214,
  397, 2190, -698, 2118, -926, 2051, -946, 2083, -1688, 1580, 1795, 1477, -1803, 1515, -102, 2358,
  -1964, 1350, -2039, 1239, 319, -2394, 41, 2417, 131, 2420, -2244, 936, 368, 2419, -2316, 797,
  -1320, 2105, 138, -2481, -1276, 2148, -977, 2307, 356, 2499, 324, 2542, -2318, -1118, 283, -2561,
  446, 2541, 503, 2553, -313, 2595, -538, -2558, 1940, 1785, 1866, 1882, 708, 2582, -741, 2584,
  -735, 2614, -467, 2680, -650, 2652, -2250, 1569, -789, 2627, -1140, 2496, -752, 2661, 1726, 2184,
  -2534, -1196, -2245, 1726, -2797, -460, -1977, 2037, 2352, 1614, -1684, 2353, -2489, -1504, -2660, -1192,
  -459, -2888, -2641, 1301, -838, 2828, -850, 2863, -2646, -1420, 2444, 1802, 2159, 2155, -903, 2918,
  -2572, -1657, -1144, 2843, -20, 3076, -160, -3099, -1583, 2670, -3018, -761, 2996, 880, -2869, -1275,
  2632, 1732, -2980, -1035, -2976, -1070, -228, -3157, 1503, 2816, -1536, 2798, -866, 3093, -191, 3277,
  -943, 3148, -180, -3292, 3186, 925, -3312, -229, -113, -3347, 2597, 2122, -2027, 2674, -3326, -623,
  -2614, 2180, -3414, -262, -782, 3350, -196, -3449, -3167, -1484, -2910, 2003, 2676, 2319, -1467, 3238,
  -230, -3563, -2946, 2055, -3515, -813, -3602, -211, 563, 3565, -3405, -1272, -2354, 2774, -2381, 2759,
  -2381, 2806, 462, 3657, -3152, 1928, -701, 3657, -2400, 2870, -3766, -371, -664, 3739, -3753, -596,
  -3537, 1479, -2514, 2972, -3922, -251, -1771, 3521, -465, -3919, 3193, 2343, -310, 3954, -2571, 3062,
  386, 4054, -3469, 2134, -2672, 3110, -2207, 3495, -2330, 3419, -1590, 3829, 3366, 2446, -2811, 3071,
  -476, 4147, -2409, 3412, -3866, 1600, -2738, 3187, -2730, 3228, -167, -4225, -2990, 3006, -2780, 3293,
  1046, -4219, -3782, 2168, 1263, -4191, -2871, 3313, 842, -4312, -2937, 3319, -2959, 3353, 3678, 2553,
  -3017, 3339, -4540, 452, -3183, 3295, -3154, 3323, -2808, 3620, -677, -4533, 3804, 2558, -3137, 3362,
  3744, 2714, -3183, 3369, -832, -4567, -547, 4620, -3252, 3400, -810, -4661, -2616, 3952, -3586, -3109,
  -3340, 3392, -851, -4695, 1717, -4477, 1782, -4472, -3405, 3408, -3449, 3425, -2569, 4156, -4405, 2225,
  -3509, 3477, -4129, 2798, -850, -4948, -4821, 1497, 1500, 4846, -4584, 2180, -4840, 1548, -1141, -4961,
  -1813, 4843, 3199, -4107, -3285, 4048, -4727, 2209, -1388, -5052, -1352, -5089,
];

export const VENUE_COUNT = VENUE_XZ.length / 2;

// --- How many of each, and where they reach --------------------------------------

/**
 * Loiterers a suburb at `crime = 1` puts on its back streets, and the floor.
 *
 * Six, and it is a *density* decision rather than a population one, on
 * `factions.CATCHMENT_MIN`'s hard-won argument: what matters is how often you
 * meet one inside a 200 m draw radius, not how many exist. Six over
 * `SPREAD_MAX` is about one in view at a time in Redfern, which is the right
 * number for something that runs at you unprovoked -- two is a mob and a third
 * of one is a rumour.
 *
 * The floor is **zero**, unlike the police's `MIN_PAIRS`. A station with nobody
 * outside it is just a building; a suburb with no meth heads is Mosman, and the
 * user asked for exactly that.
 */
const METH_AT_FULL_CRIME = 6;

/**
 * The floor, and the crime weight you have to clear to get it.
 *
 * `Math.round(crime * 6)` was doing this implicitly and getting it *nearly*
 * right -- it happens to return 1 down to a weight of 0.084 and 0 below that,
 * which is very close to the line this table wants. Written down rather than
 * inherited from a rounding rule, because the two halves of it are both real
 * decisions somebody could otherwise retune by accident:
 *
 *   - **Every walkable suburb has at least one.** A suburb in the inner city
 *     with a crime weight and no loiterer is a hole a player walks through, and
 *     it is invisible from the table -- the row says 0.1 and reads as populated.
 *   - **Mosman still has none.** The floor is gated on `METH_FLOOR_CRIME`
 *     rather than applied unconditionally, so the ten harbour suburbs the user
 *     asked to keep empty stay empty. `verifyStreetlife` asserts that from the
 *     other end.
 */
export const METH_FLOOR_CRIME = 0.1;
const METH_MIN_LOITERERS = 1;

/**
 * How far a suburb's loiterers spread from its centroid, metres, at crime 0 and
 * 1.
 *
 * **This used to be a lie, and the lie is why the inner south was empty.** The
 * spread was handed to `anchorBands` as a *search radius* and every loiterer in
 * a suburb then drew from that one shared pool -- the ten nearest, shortest
 * streets to the centroid. Ten nearest out of the several hundred bands inside
 * 220 m means all of them, so measured, every loiterer in every suburb stood
 * within about 200 m of its centroid no matter what this said. Redfern's six and
 * Alexandria's two were each a knot on one corner rather than a suburb with
 * people in it, and the 340 m end of this range had never once been reached.
 *
 * `poseMethhead` now draws a **per-loiterer patch** inside the spread and
 * searches `LOITER_REACH` around *that*, so the number below finally means what
 * it says. See there.
 */
const SPREAD_MIN = 130;
const SPREAD_MAX = 340;

export function methLoiterers(s: Suburb): number {
  const n = Math.round(s.crime * METH_AT_FULL_CRIME);
  if (s.crime >= METH_FLOOR_CRIME && n < METH_MIN_LOITERERS) return METH_MIN_LOITERERS;
  return n;
}

export function methSpread(s: Suburb): number {
  return SPREAD_MIN + (SPREAD_MAX - SPREAD_MIN) * s.crime;
}

/** A suburb's hash seed: its rounded position, never its index. See `stationSeed`. */
export function suburbSeed(s: Suburb): number {
  return carHash(Math.round(s.x) | 0, Math.round(s.z) | 0);
}

/** A venue's hash seed, on the same argument. The table is packed, so this is the identity. */
export function venueSeed(venue: number): number {
  return carHash(VENUE_XZ[venue * 2] | 0, VENUE_XZ[venue * 2 + 1] | 0);
}

/**
 * How many drunks a venue carries: one to three, or none at all.
 *
 * A hash **gated by the suburb's `booze` weight**, which is what makes this "a
 * weighted subset" rather than "every pub in Sydney". A venue in the Cross
 * carries two or three; one in Greenwich usually carries nobody, and there are
 * three pubs in Greenwich, so Greenwich has a drunk about as often as it should.
 *
 * Computed once at module load into `VENUE_DRUNKS` rather than per query,
 * because the nearest-suburb search behind it is 58 distance tests and the
 * answer is a constant -- both tables are frozen at compile time. Deterministic
 * for the same reason: integer hashes and comparisons over literal numbers,
 * evaluated identically by JavaScriptCore and V8.
 */
const DRUNKS_MAX = 3;

/** Which suburb a point is in, by centroid. Diagnostics only -- see `sydney.streetReport`. */
export function nearestSuburbName(x: number, z: number): string {
  return nearestSuburb(x, z).name;
}

function nearestSuburb(x: number, z: number): Suburb {
  let best = SUBURBS[0];
  let best2 = Infinity;
  for (const s of SUBURBS) {
    const dx = s.x - x;
    const dz = s.z - z;
    const d2 = dx * dx + dz * dz;
    if (d2 < best2) {
      best2 = d2;
      best = s;
    }
  }
  return best;
}

const VENUE_DRUNKS: readonly number[] = (() => {
  const out: number[] = [];
  for (let v = 0; v < VENUE_COUNT; v++) {
    const x = VENUE_XZ[v * 2];
    const z = VENUE_XZ[v * 2 + 1];
    const booze = nearestSuburb(x, z).booze;
    // 0..1 out of the venue's own seed, then compared against the weight. A
    // venue that clears the gate carries 1 + (0..2) scaled by how far it
    // cleared it, so a heavy suburb gets threes and a light one gets ones.
    const roll = carHash(venueSeed(v), 0x7b21) / 4294967296;
    if (roll > booze) {
      out.push(0);
      continue;
    }
    const size = booze <= 0 ? 0 : 1 - roll / booze;
    out.push(1 + Math.min(DRUNKS_MAX - 1, Math.floor(size * DRUNKS_MAX)));
  }
  return out;
})();

export function venueDrunks(venue: number): number {
  return VENUE_DRUNKS[venue] ?? 0;
}

// --- The idle, without a transcendental ---------------------------------------------

/**
 * A triangle wave over `u`, in [-1, 1], with period 1.
 *
 * The replacement for every `Math.sin` this file would otherwise want. See the
 * header's rule 5: a sine is implementation-defined and would put a paced
 * loiterer a metre from where the server has them, and a triangle is exact
 * arithmetic in both engines. It also happens to read better -- a person pacing
 * moves at a constant speed and turns around, which is a triangle.
 */
export function triangle(u: number): number {
  const f = u - Math.floor(u);
  return f < 0.5 ? 4 * f - 1 : 3 - 4 * f;
}

// --- Ambient placement ----------------------------------------------------------------

/** Where one ambient street person is. Reused by the caller; never allocated per visit. */
export interface StreetPose {
  /** Stable identity, for the renderer's rig pool. Distinct across both kinds. */
  key: number;
  /** `NPC_KIND.METHHEAD` or `NPC_KIND.DRUNK`. */
  kind: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  /** The anchor's own point -- the spot they pace around, and a promotion's home. */
  baseX: number;
  baseZ: number;
  /** Index into `SUBURBS` or into the venue table. Diagnostics, and the seed. */
  anchor: number;
  /** Which suburb/venue slot this is. */
  index: number;
  /**
   * 0..1. What the renderer's idle runs off: the swig cycle for a drunk, the
   * twitch phase for a meth head.
   */
  phase: number;
  /** Per-individual look bits. See `world/streetlife.ts`; kept here so both tiers agree. */
  look: number;
}

export function createStreetPose(): StreetPose {
  return {
    key: 0, kind: 0, x: 0, y: 0, z: 0, dx: 0, dz: 1,
    baseX: 0, baseZ: 0, anchor: 0, index: 0, phase: 0, look: 0,
  };
}

/**
 * A stable key per ambient identity, in a space that cannot collide with
 * `pedestrians.pedKey` or with a promoted actor's negative id.
 *
 * Meth heads take the even numbers and drunks the odd, above a base that clears
 * every `pedKey` in the build. `pedKey` is `(osmId * 2 + side) * 64 + slot` on a
 * 32-bit osmId, so it can reach 2^39; this starts at 2^40 and adds at most
 * `VENUE_COUNT * 8`, which stays exact in a double with eleven bits to spare.
 */
const KEY_BASE = 1099511627776; // 2^40
export function streetKey(kind: number, anchor: number, index: number): number {
  return KEY_BASE + (anchor * 8 + index) * 2 + (kind === NPC_KIND.DRUNK ? 1 : 0);
}

/**
 * The band pool an anchor draws from, cached against the resident set.
 *
 * `factions.catchmentBands` in miniature and for the same reason: `near` walks a
 * grid, rejects duplicates and allocates, and the answer only changes when a
 * tile is streamed in or evicted. `PedestrianField.generation` makes the
 * invalidation exact rather than heuristic.
 *
 * The score is the police's -- closest approach of the band's bounds plus the
 * variance term `length^2 / 12`, so a short side street beats a long arterial
 * that merely passes the door -- with `CLASS_BIAS` added. That bias is the only
 * new idea here: a meth head belongs on a service lane and a drunk belongs on
 * whatever their pub fronts, and `traffic.LANE_CLASSES` already tells us which
 * is which.
 */
interface PoolCache {
  gen: number;
  byKey: Map<number, PedBand[]>;
}

const poolCache = new WeakMap<PedestrianField, PoolCache>();

/**
 * Metres of score subtracted per lane class, squared -- the score is a squared
 * distance, so a bias of 40 m is `40 * 40`. Negative pulls a class toward the
 * front of the pool.
 *
 * Index is `traffic.LANE_CLASSES`: 10 residential, 12 living_street, 13 service.
 * The back-street bias is deliberately mild. A meth head who only ever appeared
 * in a service lane would be a meth head nobody ever met, because a player walks
 * down George Street; what the bias buys is that when there *is* a lane beside
 * you, that is where they are.
 *
 * **Deepened once**, with `poseMethhead`'s per-loiterer patch. While every
 * loiterer in a suburb drew from one pool of the ten streets nearest the
 * centroid, a strong bias would have moved all of them onto the same lane
 * together -- so the bias had to stay mild to stop them stacking. Now that each
 * of them searches their own block, preferring the lane inside *that* block
 * spreads them across the suburb's back streets instead of concentrating them,
 * and the class preference the user asked for can actually be expressed. The
 * arterials are pushed further out for the mirrored reason:
 * `factions.ARTERIAL_BIAS` is now pulling patrols onto them, and the two should
 * not be fighting over the same footpath.
 */
const BACKSTREET_BIAS: readonly number[] = [
  0, 0, // motorway, motorway_link
  0, 0, // trunk, trunk_link
  110 * 110, 0, // primary: pushed away
  75 * 75, 0, // secondary
  40 * 40, 0, // tertiary
  -45 * 45, // residential
  -25 * 25, // unclassified
  -60 * 60, // living_street
  -85 * 85, // service -- the laneway
  0, // other
];

/** How many nearby footpaths an anchor picks from. See `factions.BEAT_BAND_POOL`. */
const POOL_SIZE = 10;

/**
 * How far a loiterer searches around **their own patch**, metres, and how far
 * the diagonal of a square patch reaches.
 *
 * A hundred metres is about a block, which is the right size for "the corner
 * this one holds up": short enough that they are on a specific street rather
 * than anywhere in the suburb, long enough to find a real footpath from the
 * middle of a rail corridor or a park. See `methSpread` for what this replaced.
 *
 * The patch offset is drawn as a **square** rather than a disc because a disc
 * needs a sine and this file does not have one -- see the header's rule 5 -- so
 * the furthest a loiterer can be from their centroid is the spread times root
 * two. `SPREAD_DIAGONAL` is that, rounded *up*: it is used only to widen the
 * early-out gate in `forEachMethheadNear`, and a gate that is fractionally too
 * generous costs a distance test while one that is fractionally too tight drops
 * a person who was really there.
 */
const LOITER_REACH = 100;
const SPREAD_DIAGONAL = 1.415;

function anchorBands(
  field: PedestrianField,
  key: number,
  x: number,
  z: number,
  radius: number,
  backstreets: boolean,
  out: PedBand[],
): PedBand[] {
  let entry = poolCache.get(field);
  if (entry === undefined || entry.gen !== field.generation) {
    entry = { gen: field.generation, byKey: new Map() };
    poolCache.set(field, entry);
  }
  const cached = entry.byKey.get(key);
  if (cached !== undefined) return cached;
  field.near(x, z, radius, out);
  const score = (b: PedBand): number => {
    const dx = Math.max(b.minX - x, 0, x - b.maxX);
    const dz = Math.max(b.minZ - z, 0, z - b.maxZ);
    const bias = backstreets ? (BACKSTREET_BIAS[b.klass] ?? 0) : 0;
    return dx * dx + dz * dz + (b.length * b.length) / 12 + bias;
  };
  // The trailing keys make the comparison total: distance alone ties constantly,
  // because the two sides of one street are the same distance from everything,
  // and `near` returns bands in whatever order its grid buckets hold them --
  // streaming order on a browser, `Promise.all` completion order on the server.
  const bands = [...out]
    .sort((a, b) => score(a) - score(b) || a.osmId - b.osmId || a.side - b.side || a.minX - b.minX)
    .slice(0, POOL_SIZE);
  entry.byKey.set(key, bands);
  return bands;
}

/**
 * A point a fraction of the way along a band, and the direction of travel there.
 *
 * `posePedestrian`'s binary search without the schedule: a loiterer has no
 * traversal, no dwell and no speed, so all that is wanted from the band is a
 * spot on the concrete. Writes into `out` and returns nothing.
 */
function pointOnBand(band: PedBand, t: number, out: StreetPose): void {
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
 * How far a loiterer paces, metres, and how long the stroke takes.
 *
 * Four seconds for two and a half metres is 0.6 m/s, which is a shuffle rather
 * than a walk and is the whole read: somebody who is *not going anywhere* and
 * cannot stand still. The twitch on top runs eight times faster at four
 * centimetres, which is invisible as movement and entirely visible as agitation.
 */
const PACE_AMPLITUDE = 1.25;
const PACE_SECONDS = 4;
const TWITCH_AMPLITUDE = 0.04;
const TWITCH_SECONDS = 0.5;

/** A drunk's sway: slower and smaller than a pace, and lateral rather than along. */
const SWAY_AMPLITUDE = 0.16;
const SWAY_SECONDS = 3.4;
/** How long one swig cycle takes. Long: a longneck is not a shot. */
export const SWIG_SECONDS = 11;
/** The fraction of that cycle the bottle is actually up. */
export const SWIG_DUTY = 0.22;

/**
 * One ambient meth head, or false if this suburb has no band under it.
 *
 * A pure function of `(suburb, index, tick)` and the resident band set, which is
 * the contract `factions.ts`'s section 2 asks of an ambient tier: zero bytes of
 * protocol, evaluated identically by the client drawing it and the authority
 * deciding whether it has seen you.
 */
export function poseMethhead(
  peds: PedestrianField,
  suburb: number,
  index: number,
  now: number,
  scratch: PedBand[],
  out: StreetPose,
): boolean {
  const s = SUBURBS[suburb];
  const seed = suburbSeed(s);
  const h = carHash(seed, index ^ 0x2f19);
  // --- This loiterer's own patch, drawn inside the suburb's spread.
  //
  // The change that makes `methSpread` mean anything: the pool used to be one
  // shared set of the ten streets nearest the centroid, so every loiterer in a
  // suburb stood on the same corner and the spread was decorative. Each of them
  // now takes a point inside the spread and searches `LOITER_REACH` around it,
  // which is what puts three Erskineville meth heads on three different streets
  // instead of on one.
  //
  // A square rather than a disc, because a disc needs a sine; the corners are a
  // slightly higher chance of the far edge of the suburb, which is not a
  // property anybody can see. The pool cache key is per (suburb, loiterer)
  // rather than per suburb, which is a few dozen more entries in a map that is
  // already rebuilt whenever a tile is streamed in.
  const spread = methSpread(s);
  const px = s.x + (((carHash(h, 0x6b1f) % 2001) - 1000) / 1000) * spread;
  const pz = s.z + (((carHash(h, 0xc70d) % 2001) - 1000) / 1000) * spread;
  let bands = anchorBands(peds, carHash(seed, index ^ 0x11a3), px, pz, LOITER_REACH, true, scratch);
  if (bands.length === 0) {
    // The patch landed on a rail corridor, in a park, or over water -- which
    // around Sydney Park and Eveleigh is a lot of the ground. Fall back to the
    // suburb's own pool rather than returning false, because returning false
    // here does not mean "not visible from where you asked", it means **this
    // person does not exist at all**: a suburb whose patches happened to land
    // badly would quietly carry fewer loiterers than its row says, which is
    // exactly the class of silent thinning this whole fix is about.
    //
    // `factions.CATCHMENT_RESCUE_MAX` is the same idea for a beat, and the
    // shape of the answer is the same: widen until there is a real footpath,
    // and put the person on it.
    bands = anchorBands(peds, seed, s.x, s.z, spread, true, scratch);
  }
  if (bands.length === 0) return false;
  const band = bands[h % bands.length];
  pointOnBand(band, (carHash(h, 0x51ab) % 4096) / 4096, out);

  out.key = streetKey(NPC_KIND.METHHEAD, suburb, index);
  out.kind = NPC_KIND.METHHEAD;
  out.anchor = suburb;
  out.index = index;
  out.baseX = out.x;
  out.baseZ = out.z;
  // Against the wall rather than in the middle of the footpath: left of the
  // heading is `(dz, -dx)` in renderer axes, which is `pedestrians.buildBand`'s
  // own statement about which side of a way is which.
  const lean = ((carHash(h, 0x8c31) % 2) * 2 - 1) * 0.55;
  out.baseX += out.dz * lean;
  out.baseZ -= out.dx * lean;

  // The pace, along the footpath, plus the twitch. Both are triangles; see the
  // header's rule 5.
  const phase = (carHash(h, 0x1d0b) % 1024) / 1024;
  const pace = triangle(now / PACE_SECONDS + phase) * PACE_AMPLITUDE;
  const twitch = triangle(now / TWITCH_SECONDS + phase * 7) * TWITCH_AMPLITUDE;
  out.x = out.baseX + out.dx * (pace + twitch);
  out.z = out.baseZ + out.dz * (pace + twitch);
  // Facing the way they are pacing. The stroke's sign is the triangle's slope,
  // which flips at the ends -- so they turn around when they turn around.
  const f = now / PACE_SECONDS + phase;
  const forward = f - Math.floor(f) < 0.5 ? 1 : -1;
  out.dx *= forward;
  out.dz *= forward;
  out.phase = phase;
  out.look = h >>> 8;
  return true;
}

/** One ambient drunk, on the same contract. */
export function poseDrunk(
  peds: PedestrianField,
  venue: number,
  index: number,
  now: number,
  scratch: PedBand[],
  out: StreetPose,
): boolean {
  const vx = VENUE_XZ[venue * 2];
  const vz = VENUE_XZ[venue * 2 + 1];
  const seed = venueSeed(venue);
  // Tight: a drunk outside a pub is outside *that* pub. 45 m is far enough to
  // find the footpath a corner hotel actually fronts and near enough that
  // nobody is standing outside the wrong one.
  const bands = anchorBands(peds, seed, vx, vz, 45, false, scratch);
  if (bands.length === 0) return false;
  const h = carHash(seed, index ^ 0x63d7);
  const band = bands[h % bands.length];
  pointOnBand(band, (carHash(h, 0x9e17) % 4096) / 4096, out);

  out.key = streetKey(NPC_KIND.DRUNK, venue, index);
  out.kind = NPC_KIND.DRUNK;
  out.anchor = venue;
  out.index = index;
  out.baseX = out.x;
  out.baseZ = out.z;
  const lean = ((carHash(h, 0x4477) % 2) * 2 - 1) * 0.5;
  out.baseX += out.dz * lean;
  out.baseZ -= out.dx * lean;

  const phase = (carHash(h, 0x2b63) % 1024) / 1024;
  // Swaying **across** the footpath rather than along it, which is the
  // difference between a drunk and a sentry. Small: 16 cm is a weight shift.
  const sway = triangle(now / SWAY_SECONDS + phase) * SWAY_AMPLITUDE;
  out.x = out.baseX + out.dz * sway;
  out.z = out.baseZ - out.dx * sway;
  // Facing the street they are drinking on, not up it. `(dz, -dx)` again.
  const face = (carHash(h, 0x7f2d) % 2) * 2 - 1;
  const fx = out.dz * face;
  const fz = -out.dx * face;
  out.dx = fx;
  out.dz = fz;
  out.phase = phase;
  out.look = h >>> 8;
  return true;
}

/**
 * How far a swig has got, 0 to 1, or -1 when the bottle is down.
 *
 * Exported because both tiers need the identical answer and neither owns it: the
 * renderer tilts the bottle off this, and `verifyStreetlife` asserts the cycle
 * is a cycle. A promoted drunk swigs off their actor id and an ambient one off
 * their key, which is why the seed is a parameter rather than a pose.
 */
export function swigPhase(seed: number, now: number): number {
  const offset = (carHash(seed, 0x5d3f) % 1024) / 1024;
  const u = now / SWIG_SECONDS + offset;
  const f = u - Math.floor(u);
  if (f > SWIG_DUTY) return -1;
  return f / SWIG_DUTY;
}

// --- Walking the ambient tiers -------------------------------------------------------

/**
 * Every ambient meth head within `radius`, at `tick`.
 *
 * Iteration order is fixed -- suburbs in table order, loiterers ascending -- for
 * `forEachPoliceNear`'s reason: the promotion scan takes them in order and two
 * processes have to break ties the same way. Returns early if `visit` returns
 * true.
 */
export function forEachMethheadNear(
  peds: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: PedBand[],
  out: StreetPose,
  visit: (pose: StreetPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;
  for (let s = 0; s < SUBURBS.length; s++) {
    const suburb = SUBURBS[s];
    // The suburb's spread, out to the corner of the square patch, plus the reach
    // of a patch's own band search, plus the query's. Anything tighter than this
    // drops a loiterer who is genuinely inside `radius` -- see `LOITER_REACH`.
    const gate = methSpread(suburb) * SPREAD_DIAGONAL + LOITER_REACH + radius;
    const sdx = suburb.x - x;
    const sdz = suburb.z - z;
    if (sdx * sdx + sdz * sdz > gate * gate) continue;
    const n = methLoiterers(suburb);
    for (let i = 0; i < n; i++) {
      if (!poseMethhead(peds, s, i, now, scratch, out)) continue;
      const dx = out.x - x;
      const dz = out.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (visit(out) === true) return;
    }
  }
}

/** Every ambient drunk within `radius`, on the same contract. */
export function forEachDrunkNear(
  peds: PedestrianField,
  x: number,
  z: number,
  radius: number,
  tick: number,
  scratch: PedBand[],
  out: StreetPose,
  visit: (pose: StreetPose) => boolean | void,
): void {
  const now = trafficSeconds(tick);
  const r2 = radius * radius;
  // A venue's drunks stand within a few dozen metres of it, so the gate is the
  // query radius plus the band search. Four hundred and twenty-two squared
  // distances is one pass over a flat array of numbers -- cheaper than the grid
  // walk a spatial index would need for a set this size.
  const gate = 60 + radius;
  const gate2 = gate * gate;
  for (let v = 0; v < VENUE_COUNT; v++) {
    const vdx = VENUE_XZ[v * 2] - x;
    const vdz = VENUE_XZ[v * 2 + 1] - z;
    if (vdx * vdx + vdz * vdz > gate2) continue;
    const n = venueDrunks(v);
    for (let i = 0; i < n; i++) {
      if (!poseDrunk(peds, v, i, now, scratch, out)) continue;
      const dx = out.x - x;
      const dz = out.z - z;
      if (dx * dx + dz * dz > r2) continue;
      if (visit(out) === true) return;
    }
  }
}

// --- Tuning -----------------------------------------------------------------------------

/**
 * How far a meth head sees you, metres, and it is the loudest number in the
 * file.
 *
 * Twenty-five is under `factions.WITNESS_RANGE` on purpose: a meth head who
 * spotted you from further than a police officer can see a crime would be the
 * one thing in the city with better eyes than the police. It is also about the
 * width of a street plus a footpath, so crossing the road is a real answer --
 * which, with the line-of-sight test, is what makes a lane a genuinely
 * different place from a square.
 */
export const METH_SIGHT = 25;
/** Erratic, and faster than a player's walk (4.4) but under their sprint (8.2). */
export const METH_CHASE_SPEED = 5.8;
/** How far the zigzag carries them off the straight line, metres, and its period. */
const ZIGZAG_AMPLITUDE = 2.6;
const ZIGZAG_SECONDS = 1.15;
/** Past this they lose interest and walk off, metres. A leash, not a wall. */
export const METH_GIVEUP = 70;
/** Pips a swipe does, and the cadence, ticks. */
export const MELEE_DAMAGE = 0.5;
export const METH_SWIPE_TICKS = 72; // 1.2 s
/** How close a swipe lands, metres, plan. Their own reach plus a player's radius. */
export const MELEE_REACH = 1.6;
export const METH_MAX_HEALTH = 2;
export const METH_DOWN_SECONDS = 8;

/** How close you have to be for a drunk to become real, metres. See the header's section 4. */
export const DRUNK_NOTICE = 7;
/** And to be *in* their personal space. The user's own number. */
export const DRUNK_SNAP = 4;
/**
 * How long a drunk takes to act on somebody standing in their personal space.
 *
 * Three-quarters of a second, and it is the number that makes the crime rule a
 * rule rather than dead code -- see the `NPC_STATE.IDLE` branch in `think`,
 * where the whole argument is written down. A bat's wind-up is eight ticks, so
 * 45 leaves a player a comfortable window to hit a bystander and a very short
 * one to change their mind about it.
 */
export const DRUNK_REACTION_TICKS = 45;
/** Past this a promoted-but-passive drunk goes back to being scenery. */
const DRUNK_DROP = 11;
/** How far you have to get for an aggro'd drunk to start forgetting, and for how long. */
export const DRUNK_FORGET = 15;
export const DRUNK_FORGET_TICKS = 5 * 60;
/** A shove, not a chase: a drunk closes at a fast walk and swings slower than a meth head. */
export const DRUNK_CHASE_SPEED = 3.4;
export const DRUNK_SWING_TICKS = 90; // 1.5 s
export const DRUNK_MAX_HEALTH = 2;
export const DRUNK_DOWN_SECONDS = 10;

/**
 * Promoted street actors alive at once, out of `factions.MAX_ACTORS`' twenty-four.
 *
 * Ten, and the point of the number is that it is **well under the cap**. The
 * cap is shared with the police and with whatever lands next, and a faction that
 * filled it would be a faction that stopped the police arriving -- the wire
 * budget is not a resource this file gets to spend on its own behalf.
 * `FactionField.promote` would evict fairly anyway; this makes it not have to.
 */
export const MAX_STREET_ACTORS = 10;

/** Both kinds' capsule. A person, on the police's own figures. */
const STREET_RADIUS = 0.32;
const STREET_HEIGHT = 1.7;

/** The user's own files, staged at `/audio/`. Played on aggro, on the framework's cooldown. */
export const METHHEAD_CLIPS: readonly string[] = [
  '/audio/Methhead.wav',
  '/audio/Methhead_1.wav',
  '/audio/Methhead_2.wav',
  '/audio/Methhead_3.wav',
];
export const DRUNK_CLIPS: readonly string[] = [
  '/audio/Drunk.wav',
  '/audio/Drunk_1.wav',
  '/audio/Drunk_2.wav',
  '/audio/Drunk_3.wav',
  '/audio/Drunk_4.wav',
  '/audio/Drunk_5.wav',
  '/audio/Drunk_6.wav',
];

// --- Moving one -------------------------------------------------------------------------

/**
 * Toward a point, at a speed, sliding off buildings.
 *
 * `factions.walkToward`'s twin, restated rather than exported from there for the
 * reason that file restates `segmentDistance`: fifteen lines against an edit to
 * a module this one is a consumer of. Resolved against the same prisms a player
 * is, so a meth head takes the corner you took.
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
    const moved = ctx.collision.resolve(actor.x, actor.z, nx, nz, STREET_RADIUS, actor.y + 0.42);
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

/** Whether a combatant can be attacked at all: upright, alive, in the world. */
function engageable(c: CombatantState): boolean {
  return c.phase !== 'ko' && c.health > 0;
}

/**
 * Swing at a player, if the clock allows it. Returns whether one landed.
 *
 * `NPC_STATE.FIRE` is the state a swing is carried in, borrowed from the police
 * rather than given a byte of its own -- it means "an attack just left this
 * actor", the client draws it off the state alone, and it is held for
 * `FIRE_STATE_TICKS` so exactly one snapshot samples it. `fireCooldown` is the
 * generic countdown `NpcActor` already carries and counts **simulation ticks**,
 * which is the whole of why an integration check running fifteen hundred ticks
 * in four milliseconds sees fifteen hundred ticks' worth of swings rather than
 * one.
 */
function swing(actor: NpcActor, target: CombatantState, cadence: number, ctx: FactionCtx): boolean {
  if (actor.fireCooldown > 0) return false;
  actor.fireCooldown = cadence;
  actor.shotsFired++;
  actor.state = NPC_STATE.FIRE;
  actor.stateTicks = 0;
  ctx.damagePlayer(target.id, MELEE_DAMAGE, actor);
  return true;
}

/** Walk home and vanish on arrival. Both kinds resolve the same way. */
function goHome(actor: NpcActor, speed: number, ctx: FactionCtx): void {
  actor.target = -1;
  if (actor.state !== NPC_STATE.RETURN) {
    actor.state = NPC_STATE.RETURN;
    actor.stateTicks = 0;
  }
  const left = walkToward(actor, actor.homeX, actor.homeZ, ctx.dt > 0 ? speed : 0, ctx);
  // `health <= -1` is the despawn flag `FactionField.step` sweeps on. An actor
  // that reached its anchor simply stops being promoted and goes back to being
  // the ambient function it always was -- there is nothing to hand back.
  if (left < 1.5 || actor.stateTicks > 20 * 60) actor.health = -2;
}

// --- The meth heads ----------------------------------------------------------------------

export const METHHEAD = registerNpcKind({
  kind: NPC_KIND.METHHEAD,
  name: 'meth head',
  radius: STREET_RADIUS,
  height: STREET_HEIGHT,
  // Two bat swings. Not three like an officer: a shirtless bloke is not wearing
  // a stab vest, and the fight has to be winnable while a second one is already
  // coming at you.
  maxHealth: METH_MAX_HEALTH,
  walkSpeed: 1.1,
  chaseSpeed: METH_CHASE_SPEED,
  downSeconds: METH_DOWN_SECONDS,
  aggroClips: METHHEAD_CLIPS,
  aggroCooldownSeconds: 6,
  // The victim's name, which is what `%s` is everywhere this template is used.
  feedKo: '%s got rolled by a meth head',
  // No leaderboard credit, in either direction, on `POLICE`'s own argument: a
  // scoreboard is a record of what players did to each other.
  scoresKo: false,

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    // --- On the ground. Eight seconds, and then they wander off rather than
    // getting back up angry: a meth head who re-engaged the instant they stood
    // would make the bat useless against them, and the user asked for two hits.
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

    const target = targetOf(actor, ctx);
    if (!target || !engageable(target)) {
      goHome(actor, METH_CHASE_SPEED * 0.5, ctx);
      return;
    }

    const tx = target.body.position.x;
    const tz = target.body.position.z;
    const dx = tx - actor.x;
    const dz = tz - actor.z;
    const range2 = dx * dx + dz * dz;

    // --- The leash. Seventy metres is about three blocks, which is long enough
    // that outrunning one is a decision and short enough that they do not
    // follow you to Newtown.
    if (range2 > METH_GIVEUP * METH_GIVEUP) {
      goHome(actor, METH_CHASE_SPEED * 0.5, ctx);
      return;
    }

    if (range2 <= MELEE_REACH * MELEE_REACH) {
      const d = Math.sqrt(range2);
      if (d > 1e-6) {
        actor.dx = dx / d;
        actor.dz = dz / d;
      }
      if (!swing(actor, target, METH_SWIPE_TICKS, ctx) && actor.state !== NPC_STATE.FIRE) {
        actor.state = NPC_STATE.CHASE;
      }
      return;
    }

    // --- The chase, with the zigzag.
    //
    // Applied as an offset to the *aim point* rather than to the position, which
    // is what keeps it a run rather than a wobble: the actor is genuinely
    // running at a point two and a half metres to the side of you, and then at a
    // point two and a half metres to the other side, so the path has corners in
    // it and the heading follows. Offsetting the position instead would slide
    // them sideways while facing straight ahead, which reads as a bug.
    //
    // A triangle, not a sine. See the header's rule 5.
    if (actor.state !== NPC_STATE.CHASE) {
      actor.state = NPC_STATE.CHASE;
      actor.stateTicks = 0;
    }
    const d = Math.sqrt(range2);
    const phase = (carHash(actor.id, 0x33f1) % 1024) / 1024;
    const zig = triangle(trafficSeconds(ctx.tick) / ZIGZAG_SECONDS + phase) * ZIGZAG_AMPLITUDE;
    // Perpendicular to the line to the target: `(dz, -dx)` normalised.
    const inv = d > 1e-6 ? 1 / d : 0;
    // Faded out as they close, or the swipe never lands -- a zigzag at two
    // metres is somebody walking around you.
    const fade = d > 12 ? 1 : d / 12;
    const aimX = tx + dz * inv * zig * fade;
    const aimZ = tz - dx * inv * zig * fade;
    walkToward(actor, aimX, aimZ, METH_CHASE_SPEED, ctx);
  },
});

// --- The drunks ---------------------------------------------------------------------------

export const DRUNK = registerNpcKind({
  kind: NPC_KIND.DRUNK,
  name: 'drunk',
  radius: STREET_RADIUS,
  height: STREET_HEIGHT,
  maxHealth: DRUNK_MAX_HEALTH,
  walkSpeed: 0.8,
  chaseSpeed: DRUNK_CHASE_SPEED,
  downSeconds: DRUNK_DOWN_SECONDS,
  aggroClips: DRUNK_CLIPS,
  aggroCooldownSeconds: 8,
  feedKo: '%s got king hit by a drunk',
  scoresKo: false,

  think(actor, ctx) {
    if (actor.fireCooldown > 0) actor.fireCooldown--;

    if (actor.state === NPC_STATE.DOWN) {
      actor.downTicks--;
      if (actor.downTicks <= 0) {
        // Back up, and back to being a bystander. Ten seconds on the footpath
        // takes the fight out of one, which is also what stops a player being
        // locked into a loop with somebody they only meant to walk past.
        actor.target = -1;
        actor.state = NPC_STATE.WALK;
        actor.stateTicks = 0;
      }
      return;
    }

    if (actor.state === NPC_STATE.FIRE && actor.stateTicks < 3) return;

    // --- Passive. The state they are promoted into, and the one the crime rule
    // cares about. Sway at the anchor, watch the street, and snap at anybody who
    // walks inside `DRUNK_SNAP`.
    if (actor.target < 0) {
      if (actor.state === NPC_STATE.RETURN) {
        goHome(actor, DRUNK_CHASE_SPEED * 0.4, ctx);
        return;
      }
      let nearest: CombatantState | undefined;
      let best2 = Infinity;
      for (const c of ctx.combatants) {
        if (!engageable(c)) continue;
        const dx = c.body.position.x - actor.x;
        const dz = c.body.position.z - actor.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < best2) {
          best2 = d2;
          nearest = c;
        }
      }
      // --- Inside their personal space. **Noticed, and not yet acting on it.**
      //
      // `NPC_STATE.IDLE` is the squint, and the delay in front of it is the
      // correction this branch most needed -- without it the whole "batting a
      // passive drunk is a crime" rule is unreachable code, and the integration
      // check is what proved it rather than an argument.
      //
      // The arithmetic: a drunk snaps at `DRUNK_SNAP` = 4 m and a bat reaches
      // 1.55 m, so a player can only ever swing at one from *inside* the radius
      // that turns them hostile. With an instant reaction the drunk was aggro'd
      // one tick after the player crossed 4 m and hostile long before the eight
      // ticks of swing wind-up finished -- so every drunk anybody ever hit was
      // an aggro'd one, `strikeCrime` correctly answered "self-defence" every
      // single time, and the bystander branch could not have fired in a real
      // session no matter what a player did.
      //
      // Three-quarters of a second fixes it in the direction the character was
      // already pointing: a drunk is *slow*. Walk up and hit one and they were a
      // bystander and the police will have opinions; stand in front of one for a
      // moment and they are on you. Both branches are now things a player can
      // actually do, which is what the rule was for.
      if (nearest && best2 <= DRUNK_SNAP * DRUNK_SNAP) {
        if (actor.state !== NPC_STATE.IDLE) {
          actor.state = NPC_STATE.IDLE;
          actor.stateTicks = 0;
          return;
        }
        if (actor.stateTicks < DRUNK_REACTION_TICKS) return;
        actor.target = nearest.id;
        actor.state = NPC_STATE.CHASE;
        actor.stateTicks = 0;
        // The bark, on the transition and nowhere else. `FactionField.bark`
        // owns the per-actor cooldown and the hashed clip choice, so seven
        // files rotate without two drunks ever saying the same thing at once.
        ctx.field.bark(actor, ctx);
        return;
      }
      // Nobody near enough to be worth being a real actor for. Back to scenery.
      if (!nearest || best2 > DRUNK_DROP * DRUNK_DROP) {
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
        return;
      }
      // Standing there. The sway and the swig are the renderer's, off the same
      // `swigPhase` an ambient one uses -- nothing about a promoted drunk's
      // *idle* is simulated, because none of it affects anything.
      if (actor.state !== NPC_STATE.WALK) {
        actor.state = NPC_STATE.WALK;
        actor.stateTicks = 0;
      }
      return;
    }

    const target = targetOf(actor, ctx);
    if (!target || !engageable(target)) {
      actor.target = -1;
      actor.state = NPC_STATE.RETURN;
      actor.stateTicks = 0;
      return;
    }

    const tx = target.body.position.x;
    const tz = target.body.position.z;
    const dx = tx - actor.x;
    const dz = tz - actor.z;
    const range2 = dx * dx + dz * dz;

    // --- Losing interest, which is a *timer* rather than a distance, and during
    //     which they **stop**.
    //
    // The user's rule is "gives up once you are past fifteen metres for about
    // five seconds", and both halves of that are load-bearing. The five seconds
    // is what stops a drunk being a yo-yo: one who dropped you the instant you
    // crossed a line could be turned on and off by stepping over it.
    //
    // The standing still is what makes the five seconds mean anything, and it is
    // the correction this branch actually needed. The first cut had them keep
    // walking after you at half speed while the clock ran, which sounds harmless
    // and is not: a stationary player 23 m away is 15 m away four seconds later,
    // the range test drops back under `DRUNK_FORGET`, the state goes back to
    // CHASE and the clock resets -- so the drunk *never* gives up, they simply
    // arrive. The check that found it had a player standing still, which is
    // exactly what a player who thinks they have got away does.
    //
    // Somebody who has lost the thread stops and sways, which is both the
    // correct picture and the only version where the timer can finish.
    // `NPC_STATE.WALK` is where the clock is kept -- `stateTicks` is already
    // counting -- and they keep facing you, so it reads as being stared at
    // rather than as being ignored.
    if (range2 > DRUNK_FORGET * DRUNK_FORGET) {
      if (actor.state !== NPC_STATE.WALK) {
        actor.state = NPC_STATE.WALK;
        actor.stateTicks = 0;
      }
      if (actor.stateTicks >= DRUNK_FORGET_TICKS) {
        actor.target = -1;
        actor.state = NPC_STATE.RETURN;
        actor.stateTicks = 0;
        return;
      }
      const d = Math.sqrt(range2);
      if (d > 1e-6) {
        actor.dx = dx / d;
        actor.dz = dz / d;
      }
      return;
    }

    if (range2 <= MELEE_REACH * MELEE_REACH) {
      const d = Math.sqrt(range2);
      if (d > 1e-6) {
        actor.dx = dx / d;
        actor.dz = dz / d;
      }
      if (!swing(actor, target, DRUNK_SWING_TICKS, ctx) && actor.state !== NPC_STATE.FIRE) {
        actor.state = NPC_STATE.CHASE;
      }
      return;
    }

    if (actor.state !== NPC_STATE.CHASE) {
      actor.state = NPC_STATE.CHASE;
      actor.stateTicks = 0;
    }
    walkToward(actor, tx, tz, DRUNK_CHASE_SPEED, ctx);
  },
});

// --- What the police think of all this -------------------------------------------------

/**
 * The drunks' half of `game/factions.ts`'s section 3, in one call.
 *
 * At module load rather than from a setup function, so a process that imported
 * this file for any reason has the police pointed at drunks -- there is no order
 * of initialisation in which the two disagree.
 */
policeHostileTo(NPC_KIND.DRUNK);

/**
 * Whether hitting one of these is a crime, and which one. `REASON.NONE` for
 * none.
 *
 * **The whole of the passive-versus-aggro rule**, in one pure function of the
 * actor, so that the two authorities cannot implement it differently. The
 * server calls it in `Sim.hitNpc` before `reportIfWitnessed`; an offline browser
 * calls it on the same swing through the same door. A client's *claim* is never
 * involved -- there is no message that says "that one was aggro'd" and there
 * could not be, because the server has the actor in front of it.
 *
 * **Call it before `strikeNpc`, never after.** The strike may put the actor on
 * the ground, and this is a question about the person who was standing there a
 * moment ago: a drunk who was minding their own business until the bat landed is
 * a bystander, and asking afterwards finds them unconscious and answers no. Both
 * authorities do it in that order and it is the one ordering rule this function
 * has.
 *
 *   - **A meth head is never a crime.** They came at you. The user's words are
 *     "no crime for fighting them", and the framework's default -- every
 *     non-police kind is a bystander -- would have made every fight you did not
 *     start a fight the police open an investigation into.
 *   - **A drunk is a crime while they are passive**, which is exactly
 *     `target < 0`: promoted because you walked near their pub, not yet
 *     swinging. Once they have snapped at you it is self-defence and the police
 *     are already on their way to break it up on their own account, through
 *     `policeHostileTo`.
 *   - **Anything else keeps the framework's answer**, `REASON.ASSAULT`, so a
 *     faction that lands after this one is unaffected by it.
 */
export function strikeCrime(actor: NpcActor): number {
  if (actor.kind === NPC_KIND.METHHEAD) return REASON.NONE;
  if (actor.kind === NPC_KIND.DRUNK) {
    return actor.target < 0 && actor.state !== NPC_STATE.DOWN ? REASON.ASSAULT : REASON.NONE;
  }
  return REASON.ASSAULT;
}

/** Whether a kind byte belongs to this file. The renderer and the audio path both ask. */
export function isStreetKind(kind: number): boolean {
  return kind === NPC_KIND.METHHEAD || kind === NPC_KIND.DRUNK;
}

// --- The promotion scan ------------------------------------------------------------------

/**
 * One tick of the ambient tiers: who has seen you, and who you have walked into.
 *
 * **Called by the authority immediately after `FactionField.step`**, and the
 * order is not free. `step` clears `FactionField.events` at the top of every
 * call, so a bark queued *before* it would be wiped before anybody drained it --
 * which presents as street people who occasionally aggro in total silence, on
 * whichever tick the two happened to land in the wrong order. Running after it
 * costs a promoted actor one tick of thinking, which is sixteen milliseconds and
 * has never been visible.
 *
 * Allocates nothing. The scratch is module-level and reused, on
 * `FactionField.step`'s own argument: this runs sixty times a second forever.
 */
const scanBands: PedBand[] = [];
const scanPose: StreetPose = createStreetPose();
const copBands: PedBand[] = [];
const copPed: PedPose = createPedPose();
const copBeat = createBeatPose();

export function stepStreetlife(ctx: FactionCtx): void {
  const peds = ctx.peds;
  if (!peds) return;
  const field = ctx.field;

  respondToBrawls(ctx);

  let live = 0;
  for (const a of field.actors) if (isStreetKind(a.kind)) live++;
  if (live >= MAX_STREET_ACTORS) return;

  for (const c of ctx.combatants) {
    if (!engageable(c)) continue;
    const cx = c.body.position.x;
    const cy = c.body.position.y;
    const cz = c.body.position.z;

    // --- The meth heads: on sight, with a clear line.
    //
    // The line of sight is the police's own geometry -- an eye at `EYE_HEIGHT`
    // over the loiterer's feet to chest height on the player -- so a terrace
    // between you is a terrace, and a world with no collision loaded counts as
    // clear. That is the correct failure: an offline first second in which
    // nobody can see anything is worse than one in which somebody occasionally
    // sees through a tile that has not arrived.
    forEachMethheadNear(peds, cx, cz, METH_SIGHT, ctx.tick, scanBands, scanPose, (p) => {
      if (live >= MAX_STREET_ACTORS) return true;
      if (occupied(field, NPC_KIND.METHHEAD, p.baseX, p.baseZ)) return;
      if (
        ctx.collision !== null &&
        ctx.collision.blocked(p.x, p.y + EYE_HEIGHT, p.z, cx, cy + 1.1, cz)
      ) {
        return;
      }
      const actor = field.promote(NPC_KIND.METHHEAD, p.x, p.y, p.z, p.dx, p.dz, c.id);
      if (actor === null) return true;
      actor.homeX = p.baseX;
      actor.homeZ = p.baseZ;
      live++;
      field.bark(actor, ctx);
    });

    if (live >= MAX_STREET_ACTORS) return;

    // --- The drunks: promoted at `DRUNK_NOTICE` with **no target**, which is
    // the passive state the crime rule reads. No sight test: a drunk who has to
    // see you would be a drunk who cannot be surprised, and seven metres on a
    // footpath is not a distance you can hide inside.
    forEachDrunkNear(peds, cx, cz, DRUNK_NOTICE, ctx.tick, scanBands, scanPose, (p) => {
      if (live >= MAX_STREET_ACTORS) return true;
      if (occupied(field, NPC_KIND.DRUNK, p.baseX, p.baseZ)) return;
      const actor = field.promote(NPC_KIND.DRUNK, p.x, p.y, p.z, p.dx, p.dz, -1);
      if (actor === null) return true;
      actor.homeX = p.baseX;
      actor.homeZ = p.baseZ;
      live++;
    });
  }
}

/**
 * How far a beat officer will come off their beat for a drunk who has started
 * swinging, metres. The police's own witness range: they deal with what they can
 * see from where they are.
 */
const POLICE_RESPONSE = 40;

/**
 * Get an officer onto a drunk who is having a go at somebody.
 *
 * The **other** half of `policeHostileTo`, and it lives here rather than in
 * `game/factions.ts` because of which question each half answers.
 * `POLICE.think` answers "what does an officer do about a hostile in front of
 * them", which is a fact about policing and belongs in that file. This answers
 * "is there an officer in front of them at all", which is a promotion, and a
 * promotion is a claim on the shared actor cap -- so it is made by the faction
 * that is causing the trouble, out of the same public `promote` every faction
 * gets, and `game/factions.ts` never learns that drunks exist.
 *
 * One officer per brawl, not a pair and not a van: `hostileNear` will pull in
 * anybody else already promoted nearby, and a single constable putting a bloke
 * on the footpath outside a pub is both the correct picture and the cheapest.
 */
function respondToBrawls(ctx: FactionCtx): void {
  const peds = ctx.peds;
  if (!peds) return;
  const field = ctx.field;
  for (const a of field.actors) {
    if (a.kind !== NPC_KIND.DRUNK) continue;
    if (a.target < 0 || a.state === NPC_STATE.DOWN || a.state === NPC_STATE.RETURN) continue;
    // Somebody already on it. Promoted officers are few, so this is a handful of
    // integer compares rather than a query.
    let attended = false;
    for (const o of field.actors) {
      if (o.kind !== NPC_KIND.POLICE) continue;
      const dx = o.x - a.x;
      const dz = o.z - a.z;
      if (dx * dx + dz * dz < POLICE_RESPONSE * POLICE_RESPONSE) {
        attended = true;
        break;
      }
    }
    if (attended) continue;
    forEachPoliceNear(peds, a.x, a.z, POLICE_RESPONSE, ctx.tick, copBands, copPed, copBeat, (p) => {
      // Target -1: this officer is not investigating anybody. `POLICE.think`
      // takes the "nothing to investigate" branch, finds the drunk through
      // `hostileNear` and deals with them, and walks home when there is nobody
      // left to deal with -- which is the whole of the arrangement.
      const officer = field.promote(NPC_KIND.POLICE, p.x, p.y, p.z, p.dx, p.dz, -1);
      if (officer !== null) field.bark(officer, ctx);
      return true;
    });
  }
}

/**
 * Whether this anchor already has somebody standing on it.
 *
 * Keyed on the **anchor** rather than on the live position, which is the whole
 * reason `promote` is followed by two lines that overwrite `homeX`/`homeZ`: a
 * promoted actor walks away from where it started, so "is this one already out"
 * asked against its current position would say no the moment it took a step and
 * the same loiterer would be promoted every tick until the cap refused.
 */
function occupied(
  field: { actors: Iterable<NpcActor> },
  kind: number,
  baseX: number,
  baseZ: number,
): boolean {
  for (const a of field.actors) {
    if (a.kind !== kind) continue;
    const dx = a.homeX - baseX;
    const dz = a.homeZ - baseZ;
    if (dx * dx + dz * dz < 1) return true;
  }
  return false;
}

// --- The self-check ---------------------------------------------------------------------

/**
 * Everything about this faction that fails by rendering a plausible city.
 *
 * The criterion is `verifyPolice`'s: none of these throws, and every one of them
 * would ship as a tuning complaint rather than as a bug.
 *
 *   - An **anchor outside the built extent** puts a loiterer over the harbour,
 *     where there are no bands, so that suburb silently contributes nobody. The
 *     symptom is "meth heads feel thin in the east", which reads as taste.
 *   - A **swig cycle that is not a cycle** -- a duty over 1, a period of 0 --
 *     leaves a drunk with the bottle permanently at their mouth or permanently
 *     down, and both look like the prop failed to parent rather than like the
 *     arithmetic being wrong.
 *   - **Aggro radii in the wrong order** is the whole feature inverted: a drunk
 *     who aggros before they are promoted cannot be hit while passive, so the
 *     crime rule never fires and nobody ever finds out.
 *   - **A triangle that is not periodic** puts a pacing loiterer on a ramp to
 *     infinity, several kilometres from their suburb, some minutes in.
 */
export function verifyStreetlife(): string[] {
  const failures: string[] = [];

  // --- The two tables, against the extent they were extracted inside.
  if (SUBURBS.length < 20) {
    failures.push(`Only ${SUBURBS.length} suburbs are baked; the crime table is meant to cover the extent.`);
  }
  const names = new Set<string>();
  for (const s of SUBURBS) {
    const d = Math.sqrt(s.x * s.x + s.z * s.z);
    if (d > STREET_EXTENT_M) {
      failures.push(
        `${s.name} is ${d.toFixed(0)} m from the origin, outside the ${STREET_EXTENT_M} m extent. ` +
          'Its loiterers would be placed on tiles that do not exist, so it would contribute nobody.',
      );
    }
    if (!(s.crime >= 0 && s.crime <= 1)) failures.push(`${s.name} has a crime weight of ${s.crime}; it must be in [0, 1].`);
    if (!(s.booze >= 0 && s.booze <= 1)) failures.push(`${s.name} has a booze weight of ${s.booze}; it must be in [0, 1].`);
    if (names.has(s.name)) failures.push(`Two suburbs are both called "${s.name}".`);
    names.add(s.name);
  }
  // The user's own list has to be the heavy end, or the weights say something
  // about Sydney that the brief does not.
  {
    let heaviest = SUBURBS[0];
    for (const s of SUBURBS) if (s.crime > heaviest.crime) heaviest = s;
    if (heaviest.name !== 'Redfern' && heaviest.name !== 'Kings Cross' && heaviest.name !== 'Waterloo') {
      failures.push(
        `The heaviest crime weight is ${heaviest.name}. The table is stylised on the user's own list -- ` +
          'Redfern, Waterloo, Kings Cross, Darlinghurst, Surry Hills -- and this one says otherwise.',
      );
    }
    const mosman = SUBURBS.find((s) => s.name === 'Mosman');
    if (mosman && methLoiterers(mosman) > 0) {
      failures.push(`Mosman carries ${methLoiterers(mosman)} meth heads. The brief says the harbour side is light.`);
    }

    // --- The floor, from both ends. See `METH_FLOOR_CRIME`.
    //
    // A suburb with a real crime weight and nobody in it is a hole a player
    // walks through, and it is invisible from the table -- the row says 0.15 and
    // reads as populated. The other end matters just as much: a floor applied
    // unconditionally would put meth heads in Mosman, which is the one thing the
    // user asked this table not to do.
    for (const s of SUBURBS) {
      if (s.crime >= METH_FLOOR_CRIME && methLoiterers(s) < 1) {
        failures.push(
          `${s.name} carries a crime weight of ${s.crime} and no loiterers at all. The floor is not being ` +
            'applied, so a suburb that reads as populated is empty.',
        );
      }
      if (s.crime < METH_FLOOR_CRIME && methLoiterers(s) > 0) {
        failures.push(
          `${s.name} is under the ${METH_FLOOR_CRIME} floor at ${s.crime} and still carries ` +
            `${methLoiterers(s)}. The harbour suburbs are meant to be empty.`,
        );
      }
    }

    // --- The inner south, which is where a player actually starts.
    //
    // Players spawn in Sydney Park at (-2236, +4543). Before these rows the
    // nearest anchor was 728 m away and there was not one meth head inside 600 m
    // of the spawn -- see the `SUBURBS` header. Asserted by name because the
    // failure is a table that silently lost a row, and the symptom is the exact
    // complaint that produced them: "I never saw any meth heads".
    for (const name of ['St Peters', 'Alexandria', 'Erskineville', 'Newtown', 'Newtown South', 'Waterloo']) {
      const s = SUBURBS.find((v) => v.name === name);
      if (!s) {
        failures.push(`${name} is not in the table. It is on the King Street corridor a player spawns onto.`);
      } else if (methLoiterers(s) < 2) {
        failures.push(
          `${name} carries ${methLoiterers(s)} meth head(s) at a crime weight of ${s.crime}. The corridor ` +
            'south of the university is the first ten minutes of the game and it has to be populated.',
        );
      }
    }
    // Somebody has to be reachable from the spawn disc, and "reachable" is a
    // property of the constants rather than of the draw: a suburb places its
    // loiterers inside `methSpread * SPREAD_DIAGONAL + LOITER_REACH` of its
    // centroid, so if no anchor is that close to the spawn, no arrangement of
    // hashes can put one there.
    {
      const SPAWN_X = -2236.4;
      const SPAWN_Z = 4543.3;
      let best = Infinity;
      let who = '';
      for (const s of SUBURBS) {
        if (methLoiterers(s) < 1) continue;
        const d = Math.sqrt((s.x - SPAWN_X) ** 2 + (s.z - SPAWN_Z) ** 2);
        const gap = d - (methSpread(s) * SPREAD_DIAGONAL + LOITER_REACH);
        if (gap < best) {
          best = gap;
          who = s.name;
        }
      }
      if (best > 0) {
        failures.push(
          `The nearest suburb that could place a loiterer on the spawn is ${who}, and its reach stops ` +
            `${best.toFixed(0)} m short. Nothing in this table can put a meth head where a player starts.`,
        );
      }
    }
  }

  if (VENUE_XZ.length % 2 !== 0) {
    failures.push(`The venue table has ${VENUE_XZ.length} numbers, which is not a whole number of x, z pairs.`);
  }
  if (VENUE_COUNT < 100) {
    failures.push(`Only ${VENUE_COUNT} venues are baked; the extract found 422 inside the extent.`);
  }
  {
    let outside = 0;
    for (let v = 0; v < VENUE_COUNT; v++) {
      const x = VENUE_XZ[v * 2];
      const z = VENUE_XZ[v * 2 + 1];
      if (x * x + z * z > STREET_EXTENT_M * STREET_EXTENT_M) outside++;
    }
    if (outside > 0) {
      failures.push(
        `${outside} venues are outside the ${STREET_EXTENT_M} m extent. Their drunks would be placed on ` +
          'tiles that do not exist and would silently never appear.',
      );
    }
    let withDrunks = 0;
    let total = 0;
    for (let v = 0; v < VENUE_COUNT; v++) {
      const n = venueDrunks(v);
      if (n > 0) withDrunks++;
      total += n;
      if (n > DRUNKS_MAX) failures.push(`Venue ${v} carries ${n} drunks, over the ${DRUNKS_MAX} the brief asks for.`);
    }
    if (withDrunks === 0) failures.push('No venue carries a drunk at all; the booze gate rejects everything.');
    if (withDrunks === VENUE_COUNT) {
      failures.push('Every venue carries a drunk; the weighted subset is not a subset.');
    }
    if (total < 50) failures.push(`Only ${total} drunks exist in the whole city; the anchors are too thin to meet.`);
  }

  // --- The aggro geometry, in the order it has to be in.
  if (DRUNK_NOTICE <= DRUNK_SNAP) {
    failures.push(
      `Drunks are promoted at ${DRUNK_NOTICE} m and aggro at ${DRUNK_SNAP} m. Promotion has to happen ` +
        'first, or a passive drunk is never a real actor, is never strikeable, and the "hitting a ' +
        'bystander is a crime" rule can never fire.',
    );
  }
  if (DRUNK_DROP <= DRUNK_NOTICE) {
    failures.push(
      `A passive drunk is dropped at ${DRUNK_DROP} m and promoted at ${DRUNK_NOTICE} m. Without hysteresis ` +
        'between the two, one standing at the boundary is promoted and dropped on alternate ticks.',
    );
  }
  if (DRUNK_FORGET <= DRUNK_SNAP) {
    failures.push('A drunk forgets you closer than they snap at you, so an aggro would end on the tick it began.');
  }
  // The reaction window against the bat's own wind-up, which is what decides
  // whether the bystander half of the crime rule is reachable at all. A swing is
  // eight ticks of wind-up before its active window opens; a drunk who turned
  // hostile inside that could never be hit while passive, and `strikeCrime`
  // would answer "self-defence" for every drunk anybody ever hit.
  if (DRUNK_REACTION_TICKS < 20) {
    failures.push(
      `A drunk acts ${DRUNK_REACTION_TICKS} ticks after noticing you, which is inside a bat's own wind-up. ` +
        'Every drunk a player could reach would already be hostile, so "batting a bystander is a crime" ' +
        'would be code that cannot run.',
    );
  }
  if (DRUNK_REACTION_TICKS > 2 * 60) {
    failures.push(`A drunk takes ${(DRUNK_REACTION_TICKS / 60).toFixed(1)} s to react, which is not "aggressive if you get too close".`);
  }
  if (METH_SIGHT > 40) {
    failures.push(
      `Meth heads see ${METH_SIGHT} m, past the police's own ${40} m witness range. Nothing in this city ` +
        'should have better eyes than the police.',
    );
  }
  if (METH_GIVEUP <= METH_SIGHT) {
    failures.push('A meth head gives up closer than they aggro, so a chase would end on the tick it started.');
  }
  if (METH_CHASE_SPEED <= 4.4 || METH_CHASE_SPEED >= 8.2) {
    failures.push(
      `Meth heads chase at ${METH_CHASE_SPEED} m/s. It has to sit between a player's walk (4.4) and their ` +
        'sprint (8.2), or the chase is either unloseable or pointless.',
    );
  }
  if (DRUNK_CHASE_SPEED >= METH_CHASE_SPEED) {
    failures.push('A drunk closes faster than a meth head, which inverts the whole difference between them.');
  }
  if (MAX_STREET_ACTORS >= 24) {
    failures.push(
      `This faction may hold ${MAX_STREET_ACTORS} of the shared 24 promoted actors, which would leave the ` +
        'police unable to reach a suspect. The cap is shared and this file does not get to spend it all.',
    );
  }

  // --- The health and the down clocks, against the brief.
  if (METH_MAX_HEALTH !== 2 || DRUNK_MAX_HEALTH !== 2) {
    failures.push('Both kinds were specified at two bat hits; the registration says otherwise.');
  }
  if (METH_DOWN_SECONDS < 4 || DRUNK_DOWN_SECONDS < 4) {
    failures.push('A downtime under four seconds is a knockdown a player cannot walk away from.');
  }

  // --- The crime rule, on synthetic actors. The one thing here a player can
  // actually be wronged by, so it is asserted rather than reasoned about.
  {
    const fake = (kind: number, target: number, state: number): NpcActor => ({
      id: 1, kind, x: 0, y: 0, z: 0, dx: 0, dz: 1, state,
      health: 2, downTicks: 0, stateTicks: 0, target, homeX: 0, homeZ: 0,
      fireCooldown: 0, shotsFired: 0, barkedAt: 0, struckAt: 0, seen: 0,
    });
    if (strikeCrime(fake(NPC_KIND.METHHEAD, 3, NPC_STATE.CHASE)) !== REASON.NONE) {
      failures.push('Hitting a meth head is being reported as a crime. They are the aggressor.');
    }
    if (strikeCrime(fake(NPC_KIND.METHHEAD, -1, NPC_STATE.WALK)) !== REASON.NONE) {
      failures.push('Hitting an idle meth head is being reported as a crime.');
    }
    if (strikeCrime(fake(NPC_KIND.DRUNK, -1, NPC_STATE.WALK)) !== REASON.ASSAULT) {
      failures.push('Batting a passive drunk is not being reported as an assault. They are a bystander until they swing.');
    }
    if (strikeCrime(fake(NPC_KIND.DRUNK, 3, NPC_STATE.CHASE)) !== REASON.NONE) {
      failures.push('Batting a drunk who is already swinging at you is being reported as a crime rather than self-defence.');
    }
    if (strikeCrime(fake(NPC_KIND.POLICE, -1, NPC_STATE.WALK)) !== REASON.ASSAULT) {
      failures.push('The crime rule changed the answer for a kind this file does not own.');
    }
  }

  // --- The idle arithmetic. A triangle that is not a triangle is a loiterer on
  // a ramp to infinity.
  {
    if (Math.abs(triangle(0) + 1) > 1e-12) failures.push('triangle(0) is not -1; the pace does not start at one end of its stroke.');
    if (Math.abs(triangle(0.5) - 1) > 1e-12) failures.push('triangle(0.5) is not +1; the pace does not reach the other end.');
    if (Math.abs(triangle(0.25)) > 1e-12) failures.push('triangle(0.25) is not 0; the wave is not centred.');
    for (const u of [0.13, 0.61, 0.99, 7.4]) {
      if (Math.abs(triangle(u) - triangle(u + 1)) > 1e-12) {
        failures.push(`triangle is not periodic at ${u}; a paced loiterer would drift out of their suburb.`);
      }
      if (triangle(u) < -1 - 1e-12 || triangle(u) > 1 + 1e-12) {
        failures.push(`triangle(${u}) left [-1, 1]; the pace amplitude is not what it says it is.`);
      }
    }
    // And negative time, which a check that rehearses ticks before the epoch
    // will hand it. `Math.floor` of a negative is the trap; the fold has to
    // survive it.
    if (Math.abs(triangle(-0.25)) > 1e-12) {
      failures.push('triangle(-0.25) is not 0; the fold does not handle negative time and a loiterer would jump.');
    }
  }

  // --- The swig cycle: up sometimes, down mostly, and both for everybody.
  if (!(SWIG_DUTY > 0 && SWIG_DUTY < 0.5)) {
    failures.push(`The swig duty is ${SWIG_DUTY}. Over a half and the bottle is at their mouth more than it is not.`);
  }
  if (SWIG_SECONDS <= 1) {
    failures.push(`A swig cycle of ${SWIG_SECONDS} s is somebody sculling, not somebody nursing a longneck.`);
  }
  {
    let up = 0;
    let down = 0;
    const step = SWIG_SECONDS / 240;
    for (let i = 0; i < 240; i++) {
      const p = swigPhase(12345, i * step);
      if (p < 0) down++;
      else {
        up++;
        if (p > 1) failures.push('A swig phase left the 0..1 range; the bottle would over-rotate.');
      }
    }
    if (up === 0) failures.push('The bottle never comes up over a whole swig cycle.');
    if (down === 0) failures.push('The bottle never goes down; a drunk would drink permanently.');
    // Determinism: the same seed at the same time is the same answer, which is
    // what stops a swig looking different on two screens.
    if (swigPhase(999, 3.25) !== swigPhase(999, 3.25)) {
      failures.push('swigPhase is not a pure function of its arguments.');
    }
  }

  // --- The kinds, registered on the bytes `factions.ts` reserved.
  if (METHHEAD !== NPC_KIND.METHHEAD) failures.push('The meth head did not register on its reserved byte.');
  if (DRUNK !== NPC_KIND.DRUNK) failures.push('The drunk did not register on its reserved byte.');

  // --- The audio the user supplied. A missing clip is silence, which reads as
  // the aggro not having fired at all.
  if (METHHEAD_CLIPS.length < 4) failures.push(`Only ${METHHEAD_CLIPS.length} meth head clips are wired; there are 4 files.`);
  if (DRUNK_CLIPS.length < 7) failures.push(`Only ${DRUNK_CLIPS.length} drunk clips are wired; there are 7 files.`);
  for (const clip of [...METHHEAD_CLIPS, ...DRUNK_CLIPS]) {
    if (!clip.startsWith('/audio/')) failures.push(`"${clip}" is not served from /audio/ and would 404 on aggro.`);
  }

  // --- The ambient keys, which must not collide with a pedestrian's or with
  // each other. A collision is two people sharing one rig, which at a glance is
  // one person.
  {
    const seen = new Set<number>();
    for (let a = 0; a < 64; a++) {
      for (let i = 0; i < 8; i++) {
        for (const kind of [NPC_KIND.METHHEAD, NPC_KIND.DRUNK]) {
          const key = streetKey(kind, a, i);
          if (seen.has(key)) failures.push(`Street key ${key} is claimed twice; two people would share one rig.`);
          seen.add(key);
          if (!Number.isSafeInteger(key)) failures.push(`Street key ${key} is not exact in a double.`);
        }
      }
    }
    // `pedKey` reaches (2^32 * 2 + 1) * 64 + 39, a shade under 2^39. Anything
    // this file emits has to clear it.
    if (KEY_BASE < 2 ** 39) failures.push('The street key base overlaps pedKey; a loiterer and a walker would share an identity.');
  }

  return failures;
}
