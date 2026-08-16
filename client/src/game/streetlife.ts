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
 * `amenity=pub|bar|biergarten` in the same extent -- 611 of them after a 30 m
 * dedupe that folds a pub mapped as both a node and its own building outline
 * into one venue.
 *
 * Both tables grew with the world: 59 suburbs and 422 venues at 5,300 m, 255 and
 * 611 at 15,300 m. Both grew by **appending**, and the appended block is fenced
 * off with a comment in each table saying so. Nothing above the fence moved, and
 * `verifyStreetlife` will not let it: what a player meets in the inner city is
 * decided by a row's own numbers and its index, and both of those are the same
 * numbers and the same indices they were before the middle ring existed.
 *
 * 611 is well short of the ~900 the ring's area would suggest, and the reason is
 * real rather than a missed layer: the whole extract holds 833 pub/bar features
 * inside 40 km of Town Hall, of which 479 are inside the old 5,300 m ring. The
 * CBD, the Cross and the inner west are simply where Sydney's bars are, and the
 * middle ring is mostly houses.
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
  npcKind,
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
 * Fifty-two of the eighty-five the inner-ring extract found, plus the additions
 * below, plus the middle ring's 196. The ones dropped are water features,
 * industrial spans and the handful of neighbourhood labels that name a single
 * building -- "Quay Quarter", "The Hungry Mile" -- which would put a loiterer in
 * a lobby.
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
 *
 * ---------------------------------------------------------------------------
 * **This is the curated block only.** The 19,300 - 60,000 m ring lives in
 * `SUBURBS_STAGE4_PACKED` below and is concatenated onto the end of this array
 * by `SUBURBS`; nothing here moves, and the split is what makes "nothing here
 * moves" a thing a diff can show rather than a thing to take on trust. It is
 * `wildlife.PARKS_INNER`'s arrangement, for `wildlife.PARKS`' reason.
 */
const SUBURBS_CURATED: readonly Suburb[] = [
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

  // ===========================================================================
  // The 5,300 - 15,300 m middle ring. 196 rows, appended rather than merged.
  //
  // Everything above this line is the inner-ring bake and is FROZEN -- same
  // rows, same order, same numbers. `methLoiterers`, `methSpread` and
  // `suburbSeed` are functions of the row (and `streetKey` of its index), so a
  // frozen block is a frozen set of loiterers, and `VENUE_DRUNKS` below reads
  // `booze` through a nearest-centroid search that a *new* row could otherwise
  // have quietly re-pointed. Measured: of the 422 inner-ring venues, exactly
  // three change which centroid is nearest -- two Crows Nest pubs to St Leonards
  // and one Greenwich pub to Longueville -- and both of those rows are weighted
  // to their neighbour's `booze` on purpose, so every one of the 422 keeps the
  // drunk count it has today. See `verifyStreetlife`.
  //
  // The extract finds 278 `place=suburb|neighbourhood|town` nodes inside
  // 15,300 m. The 80 inside the old ring are dropped wholesale -- the inner ring's 59 rows
  // are curated and adding the ones it deliberately left out (water features,
  // industrial spans, labels that name one building) would move loiterers a
  // player already knows. Two more are dropped by name: OSM's `Mosman` and
  // `St Peters` nodes sit outside 5,300 m but the curated table already carries
  // both under hand-picked coordinates, and a second row would double the
  // suburb.
  //
  // The weights are the header's taste rule pushed outward and nothing more:
  // the night-time strips (Bondi, Bondi Beach, Coogee, Marrickville, Dee Why,
  // Chatswood, Burwood) carry the booze; the high streets along the western and
  // southern rail lines carry the crime; the harbour, the upper north shore and
  // the peninsula suburbs carry neither. Nothing out here reaches the Cross:
  // the heaviest new row is Marrickville at 0.5 against Redfern's 1.0, which is
  // the ordering `checkStreetlife` asserts and the one a player would expect.
  // ===========================================================================
  { name: 'Marrickville', x: -4840.7, z: 4700.4, crime: 0.5, booze: 0.7 },
  { name: 'Campsie', x: -9720.5, z: 5231.9, crime: 0.5, booze: 0.35 },
  { name: 'Lakemba', x: -12325.2, z: 5861.9, crime: 0.5, booze: 0.2 },
  { name: 'Ashfield', x: -7533.4, z: 2428.2, crime: 0.45, booze: 0.4 },
  { name: 'Greenacre', x: -13875.8, z: 3967.3, crime: 0.45, booze: 0.15 },
  { name: 'Wiley Park', x: -12978.8, z: 6254.1, crime: 0.45, booze: 0.15 },
  { name: 'Petersham', x: -4932.9, z: 2938.9, crime: 0.4, booze: 0.55 },
  { name: 'Burwood', x: -9716.7, z: 1247.6, crime: 0.4, booze: 0.45 },
  { name: 'Hurstville', x: -9889.1, z: 10373.4, crime: 0.4, booze: 0.4 },
  { name: 'Maroubra', x: 3510.6, z: 8430.4, crime: 0.4, booze: 0.4 },
  { name: 'Sydenham', x: -3721.6, z: 5576.9, crime: 0.4, booze: 0.4 },
  { name: 'Rockdale', x: -6205.3, z: 9590.9, crime: 0.4, booze: 0.35 },
  { name: 'Canterbury', x: -8447.2, z: 5056.9, crime: 0.4, booze: 0.3 },
  { name: 'Belmore', x: -11126.6, z: 5814.6, crime: 0.4, booze: 0.2 },
  { name: 'Bondi Beach', x: 5879.1, z: 2328.4, crime: 0.35, booze: 0.8 },
  { name: 'Bondi', x: 5043.9, z: 2604.1, crime: 0.35, booze: 0.75 },
  { name: 'Dulwich Hill', x: -6467.5, z: 4084.7, crime: 0.35, booze: 0.45 },
  { name: 'Kogarah', x: -6631.3, z: 11147.7, crime: 0.35, booze: 0.35 },
  { name: 'Arncliffe', x: -5762.2, z: 7805.0, crime: 0.35, booze: 0.2 },
  { name: 'Eastlakes', x: 311.5, z: 6902.6, crime: 0.35, booze: 0.2 },
  { name: 'Belfield', x: -11332.3, z: 4166.5, crime: 0.35, booze: 0.15 },
  { name: 'Hillsdale', x: 1836.6, z: 9302.5, crime: 0.35, booze: 0.15 },
  { name: 'Coogee', x: 4400.9, z: 5792.5, crime: 0.3, booze: 0.7 },
  { name: 'Randwick', x: 3018.9, z: 4975.3, crime: 0.3, booze: 0.5 },
  { name: 'Brighton-Le-Sands', x: -5066.5, z: 9995.5, crime: 0.3, booze: 0.45 },
  { name: 'Dee Why', x: 7026.2, z: -13003.1, crime: 0.3, booze: 0.45 },
  { name: 'Kingsford', x: 1759.8, z: 5825.7, crime: 0.3, booze: 0.45 },
  { name: 'Lewisham', x: -5742.9, z: 3051.2, crime: 0.3, booze: 0.4 },
  { name: 'Mascot', x: -1189.1, z: 6694.0, crime: 0.3, booze: 0.35 },
  { name: 'Strathfield', x: -11831.1, z: 1359.3, crime: 0.3, booze: 0.35 },
  { name: 'Tempe', x: -4010.0, z: 6278.0, crime: 0.3, booze: 0.35 },
  { name: 'Botany', x: -793.1, z: 8780.6, crime: 0.3, booze: 0.3 },
  { name: 'Rosebery', x: -329.8, z: 5528.6, crime: 0.3, booze: 0.3 },
  { name: 'Beverly Hills', x: -11633.1, z: 9189.7, crime: 0.3, booze: 0.25 },
  { name: 'Banksia', x: -6238.9, z: 8549.0, crime: 0.3, booze: 0.2 },
  { name: 'Croydon Park', x: -9824.3, z: 3363.6, crime: 0.3, booze: 0.2 },
  { name: 'Enfield', x: -10445.4, z: 2546.6, crime: 0.3, booze: 0.2 },
  { name: 'Homebush West', x: -13224.2, z: -517.0, crime: 0.3, booze: 0.2 },
  { name: 'Lidcombe', x: -15148.6, z: -360.2, crime: 0.3, booze: 0.2 },
  { name: 'Matraville', x: 2412.8, z: 10511.3, crime: 0.3, booze: 0.2 },
  { name: 'Roselands', x: -12148.5, z: 7452.0, crime: 0.3, booze: 0.2 },
  { name: 'Clemton Park', x: -9725.3, z: 6501.4, crime: 0.3, booze: 0.15 },
  { name: 'Chullora', x: -14892.2, z: 2900.4, crime: 0.3, booze: 0.1 },
  { name: 'Summer Hill', x: -6650.6, z: 2846.7, crime: 0.25, booze: 0.45 },
  { name: 'Waverley', x: 4371.5, z: 3600.6, crime: 0.25, booze: 0.4 },
  { name: 'Brookvale', x: 5482.8, z: -11842.6, crime: 0.25, booze: 0.3 },
  { name: 'Croydon', x: -8645.0, z: 1152.3, crime: 0.25, booze: 0.3 },
  { name: 'Earlwood', x: -7094.5, z: 6330.0, crime: 0.25, booze: 0.3 },
  { name: 'Monterey', x: -5460.5, z: 11546.7, crime: 0.25, booze: 0.3 },
  { name: 'Homebush', x: -11922.0, z: -711.0, crime: 0.25, booze: 0.25 },
  { name: 'Hurlstone Park', x: -7381.1, z: 4702.0, crime: 0.25, booze: 0.25 },
  { name: 'Ramsgate Beach', x: -5614.5, z: 12701.8, crime: 0.25, booze: 0.25 },
  { name: 'Wolli Creek', x: -4928.8, z: 6975.0, crime: 0.25, booze: 0.25 },
  { name: 'Allawah', x: -8553.0, z: 11680.7, crime: 0.25, booze: 0.2 },
  { name: 'Bexley', x: -8262.9, z: 9416.8, crime: 0.25, booze: 0.2 },
  { name: 'Burwood Heights', x: -9709.1, z: 2464.3, crime: 0.25, booze: 0.2 },
  { name: 'Carlton', x: -7927.1, z: 11455.9, crime: 0.25, booze: 0.2 },
  { name: 'Eastgardens', x: 1606.5, z: 8399.0, crime: 0.25, booze: 0.2 },
  { name: 'Kingsgrove', x: -10002.9, z: 7765.9, crime: 0.25, booze: 0.2 },
  { name: 'Malabar', x: 3759.8, z: 10382.2, crime: 0.25, booze: 0.2 },
  { name: 'Pagewood', x: 1119.0, z: 7775.2, crime: 0.25, booze: 0.2 },
  { name: 'Ramsgate', x: -6188.1, z: 12746.8, crime: 0.25, booze: 0.2 },
  { name: 'Bexley North', x: -8554.1, z: 8333.0, crime: 0.25, booze: 0.15 },
  { name: 'Chifley', x: 2985.5, z: 11205.7, crime: 0.25, booze: 0.15 },
  { name: 'Daceyville', x: 1584.6, z: 6643.0, crime: 0.25, booze: 0.15 },
  { name: 'La Perouse', x: 2336.2, z: 13252.2, crime: 0.25, booze: 0.15 },
  { name: 'Strathfield South', x: -12006.3, z: 3308.3, crime: 0.25, booze: 0.15 },
  { name: 'Turrella', x: -6201.9, z: 6929.3, crime: 0.25, booze: 0.15 },
  { name: 'Undercliffe', x: -6024.7, z: 6309.0, crime: 0.25, booze: 0.15 },
  { name: 'Banksmeadow', x: 757.4, z: 9465.4, crime: 0.25, booze: 0.1 },
  { name: 'North Bondi', x: 6275.0, z: 1395.9, crime: 0.2, booze: 0.5 },
  { name: 'Charing Cross', x: 4156.4, z: 3418.2, crime: 0.2, booze: 0.45 },
  { name: 'Dee Why Beach', x: 7784.9, z: -12945.4, crime: 0.2, booze: 0.4 },
  { name: 'Six Ways', x: 5691.4, z: 2152.7, crime: 0.2, booze: 0.4 },
  { name: 'Manly Vale', x: 5084.3, z: -9595.4, crime: 0.2, booze: 0.35 },
  { name: 'Seven Ways', x: 5976.1, z: 1736.5, crime: 0.2, booze: 0.35 },
  { name: 'Haberfield', x: -6467.1, z: 1294.4, crime: 0.2, booze: 0.3 },
  { name: 'Ryde', x: -9155.2, z: -6077.3, crime: 0.2, booze: 0.3 },
  { name: 'Eastwood', x: -11712.9, z: -8530.6, crime: 0.2, booze: 0.25 },
  { name: 'North Strathfield', x: -11188.3, z: -905.9, crime: 0.2, booze: 0.25 },
  { name: 'West Ryde', x: -11544.2, z: -6376.6, crime: 0.2, booze: 0.25 },
  { name: 'Ashbury', x: -8375.6, z: 3623.1, crime: 0.2, booze: 0.15 },
  { name: 'Bardwell Park', x: -7765.9, z: 7544.1, crime: 0.2, booze: 0.15 },
  { name: 'Bardwell Valley', x: -7157.1, z: 7743.3, crime: 0.2, booze: 0.15 },
  { name: 'Kyeemagh', x: -4332.6, z: 8997.7, crime: 0.2, booze: 0.1 },
  { name: 'Phillip Bay', x: 2376.8, z: 12159.9, crime: 0.2, booze: 0.1 },
  { name: 'Port Botany', x: 992.7, z: 11593.6, crime: 0.2, booze: 0.05 },
  { name: 'St Leonards', x: -1659.0, z: -5099.7, crime: 0.15, booze: 0.45 },
  { name: 'Bronte', x: 5105.9, z: 3840.6, crime: 0.15, booze: 0.4 },
  { name: 'Clovelly', x: 4938.0, z: 4778.2, crime: 0.15, booze: 0.4 },
  { name: 'Freshwater', x: 6781.5, z: -10509.5, crime: 0.15, booze: 0.4 },
  { name: 'Five Dock', x: -7425.8, z: 154.7, crime: 0.15, booze: 0.3 },
  { name: 'Gladesville', x: -7753.4, z: -4443.4, crime: 0.15, booze: 0.3 },
  { name: 'Queenscliff', x: 6880.1, z: -9702.2, crime: 0.15, booze: 0.3 },
  { name: 'Sydney Olympic Park', x: -12705.7, z: -2643.1, crime: 0.15, booze: 0.3 },
  { name: 'Macquarie Park', x: -7912.3, z: -9543.9, crime: 0.15, booze: 0.25 },
  { name: 'Rhodes', x: -11362.6, z: -4204.0, crime: 0.15, booze: 0.25 },
  { name: 'South Coogee', x: 4250.6, z: 6960.3, crime: 0.15, booze: 0.25 },
  { name: 'Concord West', x: -10898.7, z: -2647.4, crime: 0.15, booze: 0.2 },
  { name: 'Dolls Point', x: -5723.7, z: 13947.4, crime: 0.15, booze: 0.2 },
  { name: 'Meadowbank', x: -11287.7, z: -5487.8, crime: 0.15, booze: 0.2 },
  { name: 'North Manly', x: 5503.2, z: -10731.7, crime: 0.15, booze: 0.2 },
  { name: 'North Ryde', x: -7728.9, z: -7766.6, crime: 0.15, booze: 0.2 },
  { name: 'Wentworth Point', x: -12285.5, z: -4426.8, crime: 0.15, booze: 0.2 },
  { name: 'Beverley Park', x: -6963.1, z: 12326.7, crime: 0.15, booze: 0.15 },
  { name: 'Ermington', x: -13929.1, z: -6257.5, crime: 0.15, booze: 0.15 },
  { name: 'Kogarah Bay', x: -7664.8, z: 12659.0, crime: 0.15, booze: 0.15 },
  { name: 'Little Bay', x: 3707.7, z: 12652.0, crime: 0.15, booze: 0.15 },
  { name: 'Marsfield', x: -10001.0, z: -9916.1, crime: 0.15, booze: 0.15 },
  { name: 'Balgowlah', x: 4963.4, z: -8342.3, crime: 0.12, booze: 0.3 },
  { name: 'Drummoyne', x: -5177.8, z: -1764.5, crime: 0.12, booze: 0.3 },
  { name: 'Lane Cove', x: -3749.5, z: -5939.4, crime: 0.12, booze: 0.3 },
  { name: 'Tamarama', x: 5770.5, z: 3222.9, crime: 0.12, booze: 0.3 },
  { name: 'Concord', x: -9511.9, z: -1285.9, crime: 0.12, booze: 0.25 },
  { name: 'Curl Curl', x: 7266.0, z: -11101.5, crime: 0.12, booze: 0.25 },
  { name: 'Willoughby', x: -1039.7, z: -6826.0, crime: 0.12, booze: 0.25 },
  { name: 'Artarmon', x: -2411.4, z: -6657.3, crime: 0.12, booze: 0.2 },
  { name: 'Chatswood North', x: -2863.4, z: -8816.6, crime: 0.12, booze: 0.15 },
  { name: 'Chatswood West', x: -4732.0, z: -7991.9, crime: 0.12, booze: 0.15 },
  { name: 'East Ryde', x: -6956.2, z: -6432.3, crime: 0.12, booze: 0.15 },
  { name: 'Narraweena', x: 5779.1, z: -13253.9, crime: 0.12, booze: 0.15 },
  { name: 'Melrose Park', x: -12689.4, z: -5700.8, crime: 0.12, booze: 0.1 },
  { name: 'Ben Buckler', x: 6970.2, z: 2401.0, crime: 0.1, booze: 0.25 },
  { name: 'Canada Bay', x: -8717.5, z: -302.4, crime: 0.1, booze: 0.2 },
  { name: 'Fairlight', x: 6103.6, z: -8185.1, crime: 0.1, booze: 0.2 },
  { name: 'Lane Cove North', x: -4389.2, z: -6948.1, crime: 0.1, booze: 0.2 },
  { name: 'Naremburn', x: -847.4, z: -5701.0, crime: 0.1, booze: 0.2 },
  { name: 'North Curl Curl', x: 7314.5, z: -11860.4, crime: 0.1, booze: 0.2 },
  { name: 'Allambie', x: 4459.6, z: -10667.2, crime: 0.1, booze: 0.15 },
  { name: 'Beacon Hill', x: 4478.4, z: -13056.8, crime: 0.1, booze: 0.15 },
  { name: 'Frenchs Forest', x: 1617.1, z: -13428.6, crime: 0.1, booze: 0.15 },
  { name: 'Gore Hill', x: -2404.6, z: -5925.9, crime: 0.1, booze: 0.15 },
  { name: 'Lane Cove West', x: -5591.9, z: -6208.6, crime: 0.1, booze: 0.15 },
  { name: 'Mortlake', x: -9602.5, z: -2907.3, crime: 0.1, booze: 0.15 },
  { name: 'Newington', x: -14265.9, z: -3575.9, crime: 0.1, booze: 0.15 },
  { name: 'North Willoughby', x: -1055.9, z: -8250.6, crime: 0.1, booze: 0.15 },
  { name: 'Wareemba', x: -7178.1, z: -1125.8, crime: 0.1, booze: 0.15 },
  { name: 'Willoughby East', x: -429.7, z: -7716.9, crime: 0.1, booze: 0.15 },
  { name: 'Wingala', x: 7223.5, z: -12001.5, crime: 0.1, booze: 0.15 },
  { name: 'Allambie Heights', x: 3619.4, z: -11531.6, crime: 0.1, booze: 0.12 },
  { name: 'Denistone', x: -11300.5, z: -7550.2, crime: 0.1, booze: 0.1 },
  { name: 'Denistone East', x: -10418.1, z: -7857.4, crime: 0.1, booze: 0.1 },
  { name: 'Denistone West', x: -12402.1, z: -7344.7, crime: 0.1, booze: 0.1 },
  { name: 'Liberty Grove', x: -11658.2, z: -2830.6, crime: 0.1, booze: 0.1 },
  { name: 'Midway', x: -10052.6, z: -7940.5, crime: 0.1, booze: 0.1 },
  { name: 'Spit Junction', x: 2840.4, z: -4961.3, crime: 0.08, booze: 0.2 },
  { name: 'Abbotsford', x: -7395.0, z: -1892.5, crime: 0.08, booze: 0.15 },
  { name: 'Cabarita', x: -8684.6, z: -2207.3, crime: 0.08, booze: 0.15 },
  { name: 'Forestville', x: 330.3, z: -11843.1, crime: 0.08, booze: 0.15 },
  { name: 'North Balgowlah', x: 3680.3, z: -9010.1, crime: 0.08, booze: 0.15 },
  { name: 'Russell Lea', x: -6283.3, z: -1027.1, crime: 0.08, booze: 0.12 },
  { name: 'Red Hill', x: 4276.4, z: -13725.7, crime: 0.08, booze: 0.1 },
  { name: 'Chiswick', x: -6645.2, z: -1985.9, crime: 0.07, booze: 0.12 },
  { name: 'Putney', x: -9604.3, z: -4568.4, crime: 0.07, booze: 0.12 },
  { name: 'Rodd Point', x: -6085.3, z: -220.8, crime: 0.07, booze: 0.12 },
  { name: 'Watsons Bay', x: 6731.0, z: -2946.4, crime: 0.06, booze: 0.25 },
  { name: 'Hunters Hill', x: -6023.7, z: -3796.1, crime: 0.06, booze: 0.15 },
  { name: 'Northbridge', x: 647.7, z: -6410.6, crime: 0.06, booze: 0.15 },
  { name: 'Balgowlah Heights', x: 5037.2, z: -6886.8, crime: 0.06, booze: 0.12 },
  { name: 'Gordon', x: -5544.1, z: -12482.7, crime: 0.06, booze: 0.12 },
  { name: 'North Harbour', x: 6866.6, z: -6062.7, crime: 0.06, booze: 0.12 },
  { name: 'Roseville', x: -3075.4, z: -9292.4, crime: 0.06, booze: 0.12 },
  { name: 'Seaforth', x: 2972.9, z: -8672.7, crime: 0.06, booze: 0.12 },
  { name: 'Breakfast Point', x: -9137.8, z: -2778.8, crime: 0.06, booze: 0.1 },
  { name: 'Henley', x: -6830.6, z: -2809.3, crime: 0.06, booze: 0.1 },
  { name: 'Jamieson Square', x: 494.3, z: -11960.4, crime: 0.06, booze: 0.1 },
  { name: 'Riverview', x: -4649.8, z: -4975.6, crime: 0.06, booze: 0.1 },
  { name: 'Tennyson Point', x: -8619.6, z: -3996.9, crime: 0.06, booze: 0.1 },
  { name: 'Crimson Hill', x: -4595.6, z: -8915.9, crime: 0.06, booze: 0.08 },
  { name: 'Fullers Bridge', x: -5523.4, z: -7719.2, crime: 0.06, booze: 0.08 },
  { name: 'Balmoral', x: 3797.8, z: -4184.5, crime: 0.05, booze: 0.15 },
  { name: 'Lindfield', x: -3924.2, z: -10258.8, crime: 0.05, booze: 0.12 },
  { name: 'Castle Cove', x: 305.9, z: -9131.6, crime: 0.05, booze: 0.1 },
  { name: 'Castlecrag', x: 838.1, z: -7608.1, crime: 0.05, booze: 0.1 },
  { name: 'Clontarf', x: 4021.7, z: -7023.0, crime: 0.05, booze: 0.1 },
  { name: 'Davidson', x: -1645.6, z: -14274.6, crime: 0.05, booze: 0.1 },
  { name: 'Dover Heights', x: 6645.7, z: 461.5, crime: 0.05, booze: 0.1 },
  { name: 'East Killara', x: -3287.0, z: -12673.4, crime: 0.05, booze: 0.1 },
  { name: 'East Lindfield', x: -2217.7, z: -11207.5, crime: 0.05, booze: 0.1 },
  { name: 'Huntleys Cove', x: -6703.2, z: -3260.6, crime: 0.05, booze: 0.1 },
  { name: 'Huntleys Point', x: -6083.5, z: -3117.8, crime: 0.05, booze: 0.1 },
  { name: 'Killara', x: -4753.9, z: -11313.1, crime: 0.05, booze: 0.1 },
  { name: 'Killarney Heights', x: 635.4, z: -10402.5, crime: 0.05, booze: 0.1 },
  { name: 'Linley Point', x: -5568.6, z: -4513.7, crime: 0.05, booze: 0.1 },
  { name: 'Longueville', x: -3842.3, z: -4328.9, crime: 0.05, booze: 0.1 },
  { name: 'Middle Cove', x: 33.6, z: -8431.3, crime: 0.05, booze: 0.1 },
  { name: 'Northwood', x: -2950.8, z: -4478.1, crime: 0.05, booze: 0.1 },
  { name: 'Pymble', x: -6429.9, z: -13617.3, crime: 0.05, booze: 0.1 },
  { name: 'Roseville Chase', x: -1017.1, z: -10418.3, crime: 0.05, booze: 0.1 },
  { name: 'Vaucluse', x: 6155.5, z: -1541.0, crime: 0.05, booze: 0.1 },
  { name: 'West Pymble', x: -7369.7, z: -11418.7, crime: 0.05, booze: 0.1 },
  { name: 'Bantry Bay', x: 1742.5, z: -12271.9, crime: 0.05, booze: 0.08 },
  { name: 'Barra Brui', x: -4078.9, z: -13291.6, crime: 0.05, booze: 0.08 },
  { name: 'Oxford Falls', x: 2944.1, z: -14659.8, crime: 0.05, booze: 0.08 },
  // The two `place=town` centres in the ring, on the frozen block's own
  // precedent: `Sydney` and `North Sydney` are a `city` and a `town` node and
  // are in the table because a reader would not accept a Sydney with no
  // Sydney in it. Chatswood and Manly are the same argument out here -- each
  // has its own command in `POLICE_STATIONS`, and the `suburb` extract has
  // neither, only their fringes (Chatswood North, Chatswood West, Fairlight).
  { name: 'Manly', x: 7146.6, z: -8064.7, crime: 0.25, booze: 0.6 },
  { name: 'Chatswood', x: -2719.4, z: -7946.2, crime: 0.25, booze: 0.45 },

  // ===========================================================================
  // The 15,300 - 19,300 m outer ring. 77 rows, appended rather than merged, on
  // exactly the rule the middle ring used.
  //
  // Everything above this line is frozen. The 19,300 m re-extract of
  // `place=suburb|neighbourhood|town` returns 355 nodes; the 278 inside the old
  // 15,300 m line are dropped wholesale, which is what keeps every existing
  // centroid, loiterer and `nearestSuburbName` answer where it was. None of the
  // 77 collides by name with a row above, so no suburb is doubled.
  //
  // The weights are the header's taste rule pushed one ring further: the
  // western line (Bankstown, Auburn, Granville, Punchbowl, Yagoona) and the
  // St George line (Riverwood, Mortdale, Penshurst) carry the crime; the
  // beaches (Narrabeen, Collaroy) and the Parramatta eat street carry what
  // booze there is; the upper north shore, the Georges River waterfront and
  // the Sutherland bays carry neither and are Mosman's rule on holiday.
  // Nothing out here reaches the Cross: the heaviest new row is Bankstown at
  // 0.5, level with Marrickville and Campsie and half of Redfern's 1.0.
  //
  // **One existing venue changes which centroid it reads.** `VENUE_DRUNKS` takes
  // its `booze` from `nearestSuburb`, so a new row can re-point a pub that is
  // itself frozen. Measured over all 611: exactly one moves -- venue 608, on
  // Frenchs Forest's edge at (684, -15064), from Frenchs Forest 1,883 m away to
  // Belrose 345 m away, which is the better answer on the merits. `Belrose` is
  // therefore weighted to Frenchs Forest's `booze` of 0.15 **on purpose**, the
  // same trick the middle ring used for the two Crows Nest pubs, so the venue
  // keeps the drunks it has today. Change that 0.15 and venue 608 changes with
  // it.
  // ===========================================================================
  { name: 'Bankstown', x: -16152.1, z: 5663.6, crime: 0.5, booze: 0.35 },
  { name: 'Granville', x: -18879.8, z: -3456.6, crime: 0.45, booze: 0.3 },
  { name: 'Auburn', x: -17027.2, z: -1266.8, crime: 0.45, booze: 0.2 },
  { name: 'Punchbowl', x: -14401.6, z: 6909.1, crime: 0.45, booze: 0.15 },
  { name: 'Riverwood', x: -14289.0, z: 8959.9, crime: 0.4, booze: 0.2 },
  { name: 'South Granville', x: -18409.3, z: -884.2, crime: 0.4, booze: 0.15 },
  { name: 'Yagoona', x: -17652.8, z: 4205.9, crime: 0.4, booze: 0.15 },
  { name: 'Harris Park', x: -18374.1, z: -4809.5, crime: 0.35, booze: 0.3 },
  { name: 'Birrong', x: -17444.5, z: 2878.5, crime: 0.35, booze: 0.12 },
  { name: 'Condell Park', x: -18197.5, z: 6324.2, crime: 0.35, booze: 0.12 },
  { name: 'Mount Lewis', x: -14855.7, z: 5663.5, crime: 0.35, booze: 0.12 },
  { name: 'Regents Park', x: -16957.4, z: 1775.5, crime: 0.35, booze: 0.12 },
  { name: 'Sefton', x: -18339.4, z: 2390.6, crime: 0.35, booze: 0.12 },
  { name: 'Little India', x: -18632.1, z: -4802.5, crime: 0.3, booze: 0.35 },
  { name: 'Mortdale', x: -12478.9, z: 11153.1, crime: 0.3, booze: 0.25 },
  { name: 'Penshurst', x: -11304.5, z: 10857.0, crime: 0.3, booze: 0.25 },
  { name: 'Padstow', x: -16405.9, z: 9172.8, crime: 0.3, booze: 0.2 },
  { name: 'South Hurstville', x: -9328.0, z: 12250.5, crime: 0.3, booze: 0.2 },
  { name: 'Berala', x: -16172.7, z: 1027.1, crime: 0.3, booze: 0.15 },
  { name: 'Potts Hill', x: -16266.7, z: 2895.5, crime: 0.3, booze: 0.1 },
  { name: 'Rosehill', x: -16625.5, z: -4400.9, crime: 0.25, booze: 0.25 },
  { name: 'Narwee', x: -12777.7, z: 8746.4, crime: 0.25, booze: 0.15 },
  { name: 'Peakhurst', x: -13703.1, z: 10548.8, crime: 0.25, booze: 0.15 },
  { name: 'Clyde', x: -17412.4, z: -3593.4, crime: 0.25, booze: 0.1 },
  { name: 'Silverwater', x: -15074.3, z: -3488.4, crime: 0.25, booze: 0.1 },
  { name: 'Rydalmere', x: -15674.0, z: -6047.7, crime: 0.2, booze: 0.15 },
  { name: 'Telopea', x: -15732.5, z: -8019.9, crime: 0.2, booze: 0.12 },
  { name: 'Camellia', x: -16260.6, z: -5141.1, crime: 0.2, booze: 0.08 },
  { name: 'Collaroy', x: 8119.9, z: -14622.5, crime: 0.15, booze: 0.35 },
  { name: 'Narrabeen', x: 7903.8, z: -17353.1, crime: 0.15, booze: 0.35 },
  { name: 'Epping', x: -12667.9, z: -10525.7, crime: 0.15, booze: 0.25 },
  { name: 'Oatley', x: -12241.5, z: 12726.7, crime: 0.15, booze: 0.25 },
  { name: 'Sans Souci', x: -6734.8, z: 13856.8, crime: 0.15, booze: 0.25 },
  { name: 'Carlingford', x: -15164.3, z: -10185.9, crime: 0.15, booze: 0.2 },
  { name: 'Blakehurst', x: -9071.8, z: 13591.6, crime: 0.15, booze: 0.15 },
  { name: 'Dundas', x: -15425.1, z: -7024.2, crime: 0.15, booze: 0.15 },
  { name: 'Dundas Valley', x: -14347.6, z: -8073.6, crime: 0.15, booze: 0.12 },
  { name: 'Hurstville Grove', x: -10538.5, z: 12254.3, crime: 0.15, booze: 0.12 },
  { name: 'Peakhurst Heights', x: -14101.9, z: 12247.4, crime: 0.15, booze: 0.12 },
  { name: 'Taren Point', x: -7706.5, z: 16913.0, crime: 0.15, booze: 0.1 },
  { name: 'Collaroy Beach', x: 8180.2, z: -15361.4, crime: 0.12, booze: 0.3 },
  { name: 'Pennant Hills', x: -13003.2, z: -14223.5, crime: 0.12, booze: 0.2 },
  { name: 'Sandringham', x: -6151.5, z: 14344.8, crime: 0.12, booze: 0.2 },
  { name: 'Sylvania', x: -9921.9, z: 16299.6, crime: 0.12, booze: 0.2 },
  { name: 'Cromer', x: 5956.0, z: -14552.9, crime: 0.12, booze: 0.15 },
  { name: 'Kurnell', x: -1664.7, z: 17050.4, crime: 0.12, booze: 0.15 },
  { name: 'Carss Park', x: -8303.1, z: 13259.3, crime: 0.1, booze: 0.15 },
  { name: 'Oatlands', x: -17141.1, z: -7613.9, crime: 0.1, booze: 0.12 },
  { name: 'Beecroft', x: -13527.9, z: -12960.4, crime: 0.08, booze: 0.15 },
  { name: 'Belrose', x: 644.4, z: -15407.0, crime: 0.08, booze: 0.15 },
  { name: 'Collaroy Plateau', x: 7306.6, z: -15478.1, crime: 0.08, booze: 0.15 },
  { name: 'St Ives', x: -4893.2, z: -15398.9, crime: 0.08, booze: 0.15 },
  { name: 'Turramurra', x: -7744.8, z: -14939.7, crime: 0.08, booze: 0.15 },
  { name: 'Wahroonga', x: -8802.5, z: -16533.6, crime: 0.08, booze: 0.15 },
  { name: 'Normanhurst', x: -10617.6, z: -15887.6, crime: 0.08, booze: 0.12 },
  { name: 'North Epping', x: -10877.0, z: -12028.2, crime: 0.08, booze: 0.12 },
  { name: 'Sylvania Heights', x: -10316.6, z: 16077.0, crime: 0.08, booze: 0.12 },
  { name: 'Wheeler Heights', x: 6345.2, z: -15650.4, crime: 0.08, booze: 0.12 },
  { name: 'Connells Point', x: -10397.6, z: 13293.9, crime: 0.08, booze: 0.1 },
  { name: 'Elizabeth Farm', x: -17708.7, z: -5148.0, crime: 0.08, booze: 0.1 },
  { name: 'Mobbs Hill', x: -14551.6, z: -9520.8, crime: 0.08, booze: 0.1 },
  { name: 'Cromer Heights', x: 4850.9, z: -15271.3, crime: 0.07, booze: 0.1 },
  { name: 'Sylvania Waters', x: -8669.4, z: 16771.7, crime: 0.06, booze: 0.12 },
  { name: 'Caravan Head', x: -11281.9, z: 14573.5, crime: 0.06, booze: 0.1 },
  { name: 'Cheltenham', x: -12424.3, z: -12184.4, crime: 0.06, booze: 0.1 },
  { name: 'East St Ives', x: -4111.7, z: -15139.9, crime: 0.06, booze: 0.1 },
  { name: 'Kangaroo Point', x: -10141.0, z: 14967.2, crime: 0.06, booze: 0.1 },
  { name: 'Kyle Bay', x: -9935.1, z: 13597.1, crime: 0.06, booze: 0.1 },
  { name: 'North St Ives', x: -4144.6, z: -16988.1, crime: 0.06, booze: 0.1 },
  { name: 'Oyster Bay', x: -11568.1, z: 15127.4, crime: 0.06, booze: 0.1 },
  { name: 'South Turramurra', x: -9567.7, z: -12886.1, crime: 0.06, booze: 0.1 },
  { name: 'St Ives Chase', x: -4399.8, z: -18308.6, crime: 0.06, booze: 0.1 },
  { name: 'Warrawee', x: -8247.0, z: -15475.2, crime: 0.06, booze: 0.1 },
  { name: 'Experiment Farm', x: -18296.2, z: -5019.8, crime: 0.06, booze: 0.08 },
  { name: 'Greenhills Beach', x: -3923.9, z: 18624.7, crime: 0.05, booze: 0.1 },
  { name: 'Bungaroo', x: -2567.5, z: -15167.2, crime: 0.05, booze: 0.08 },
  { name: 'Pearce’s Corner', x: -9647.4, z: -16523.1, crime: 0.05, booze: 0.08 },
];

/**
 * The 19,300 - 60,000 m stage-4 ring: 505 more suburbs, packed into a string,
 * with **weights a model produced rather than a person**.
 *
 * `name|x|z|crime|booze`, records separated by `;`, parsed once at module load
 * into the same `Suburb` shape -- `wildlife.PARKS_MIDDLE_PACKED`'s format and
 * its argument: 332 records is a table a reader checks by eye, 837 is fifteen
 * pages nobody reads, and the frozen block above stays legible by staying a
 * literal.
 *
 * ---------------------------------------------------------------------------
 * **Why the weights are computed here and chosen above.**
 *
 * Everything above this line was set by hand and says so. The disc this block
 * covers is 11,310 km2 and reaches Penrith, Katoomba's foothills, Gosford and
 * Wollongong's northern beaches; hand-curating five hundred suburbs would be
 * five hundred opinions nobody could check. So the opinions above were turned
 * into a model and the model was fitted against them, in
 * `data/scratch/bake_anchors_60km.py` over `data/cache/sydney-60km.osm.pbf`.
 *
 * Each suburb's `place` node gets a neighbourhood profile:
 *
 *   - **A800** street-level doors within 800 m: every `shop`, plus
 *     restaurants, cafes, takeaways, pubs, bars, banks, pharmacies, cinemas.
 *   - **B700** the licensed subset within 700 m, plus bottle shops.
 *   - **M1500** marinas, yacht and sailing clubs, golf courses within 1,500 m.
 *   - **RAIL** whether there is a railway station within 700 m.
 *   - **POOLS** `leisure=swimming_pool` and back-garden tennis courts within
 *     1 km, both as a raw count and as a rate per detached dwelling.
 *
 * Then a least-squares fit in log space, and the resulting *score* is
 * quantile-mapped onto the curated weights -- so a new row is given the weight
 * of the curated suburb with as much going on. Fitted on all 332 rows above:
 *
 *     crime = -1.5508 +0.4486*ln(1+B700) -0.2511*ln(1+M1500) +0.2080*RAIL
 *                     -0.0269*ln(1+POOLRATE) -0.1585*ln(1+POOLRAW)
 *     booze = -2.2213 +0.1608*ln(1+A800) +0.2225*ln(1+B700) -0.0249*ln(1+POOLRATE)
 *
 * **The pools are the interesting term and they are not a joke, or not only
 * one.** OSM carries no income column, and the retail proxy cannot do this job
 * alone: Roseville has *more* shops within 800 m than Earlwood and a fifth of
 * the curated crime weight. What OSM does carry, because aerial-imagery tracers
 * went suburb by suburb, is the back yards. The upper north shore and the
 * harbour are wall-to-wall pools; Mount Druitt and Lakemba are not.
 *
 * The second interesting term is a negative result: **A800 does not survive
 * into the crime fit and B700 does.** An exhaustive sweep over every subset of
 * the seven features picked pub-and-bottle-shop density over shop density, by
 * six percentage points. Read charitably that is a licensed strip rather than a
 * retail one. Read the other way it is the same joke this file has been making
 * since Kings Cross was given a 0.95.
 *
 * ---------------------------------------------------------------------------
 * **What it reproduces, honestly: 153 of the 332 curated rows within 30%, and
 * 195 of 332 for `booze`.** That is 46% and 59%, and it is not 90%, and saying
 * so is the point. Where it fails it fails in a describable direction: it
 * cannot reach Redfern's 1.00 (it says 0.60) or Kings Cross's 0.95 (0.50),
 * because no combination of shopfronts and swimming pools explains why the
 * inner city is the inner city -- and the only feature that would, distance
 * from Town Hall, would also declare Mount Druitt to be Killara. The
 * *ordering* is right where the level is not: Redfern, Kings Cross, Newtown and
 * Marrickville are still the top of the curated set under the model, which is
 * what the quantile map is reading.
 *
 * A second known bias, corrected rather than hidden: every deprivation signal
 * here is an *absence*, so a suburb the map has not finished yet reads as
 * rough. The first cut declared Schofields, Oran Park, Grantham Farm and North
 * Kellyville -- all paddocks in 2015 -- the roughest places in the state. Each
 * score is therefore shrunk toward the median in proportion to how much of the
 * suburb is actually mapped, one-sidedly, because no thin suburb was ever
 * scoring too *low*.
 *
 * And four rows are hand-set over the model's head, which the header above
 * makes the tradition:
 *
 *   - **Blacktown** 0.45/0.30. The OSM `place` node is 1.3 km from the town
 *     centre in a residential pocket, so the model sees 97 doors, no railway
 *     station and eight pools where the real centre is a Westfield, the
 *     junction and the biggest bus interchange in the west. Model said 0.10.
 *   - **Campbelltown** 0.45/0.35. The same failure -- the node sits off Queen
 *     Street with 54 dwellings inside a kilometre, so the evidence shrink pulls
 *     it to the middle of the ladder. It is a regional city with a reputation.
 *     Model said 0.25.
 *   - **Thornton** 0.20/0.15 and **Jamisontown** 0.20/0.25. Two subdivisions
 *     either side of Penrith station that inherit Penrith's entire activity
 *     disc while having almost no mapped dwellings of their own; Thornton came
 *     out at 0.55, the heaviest row in the ring, and it is new houses.
 *
 * ---------------------------------------------------------------------------
 * **One venue in the frozen block changes its drunks**, and it is written down
 * rather than smoothed over. `VENUE_DRUNKS` reads `booze` through a
 * nearest-centroid search, so a new row can steal a venue that already exists.
 * Measured over all 642: exactly one moves -- **venue 640**, the pub at
 * (-18379, -5523) in Parramatta, which was attached to the `Experiment Farm`
 * locality label at `booze` 0.08 and is now attached to `Parramatta` at 0.55.
 * Its roll is 0.0384, so it goes from **two drunks to three**. That is a
 * correction and not a regression: it is a Parramatta pub, and it was reading
 * off a label that names a 1793 farmhouse museum. Every other one of the 642
 * keeps the count it has today.
 *
 * The extract found 1,632 `place=suburb|neighbourhood|town` nodes inside 60 km.
 * 671 inside the frozen ring are dropped wholesale (the curation above wins in
 * its own ring), 232 more within 400 m of a curated centroid, 198 that would
 * duplicate a name already in the table, 24 whose node lands in mapped water
 * and 2 with no name at all.
 */
const SUBURBS_STAGE4_PACKED =
  'Parramatta|-18749.1|-5638.4|0.55|0.55;Liverpool|-26125.1|6152.3|0.55|0.50;Mount Druitt|-36193.9|' +
  '-10201.2|0.55|0.40;Rooty Hill|-34155.3|-10019.8|0.50|0.30;Campbelltown|-35388.8|22445.6|0.45|0.3' +
  '5;Blacktown|-28492.8|-9980.1|0.45|0.30;Jannali|-12763.3|16545.7|0.45|0.25;Bidwill|-36020.1|-1448' +
  '8.6|0.45|0.15;Hebersham|-35805.1|-12981.2|0.45|0.15;Penrith|-47948.9|-12089.7|0.40|0.45;Kirrawee' +
  '|-12291.3|18470.8|0.40|0.35;Cabramatta|-25360.4|3750.8|0.40|0.30;Emerton|-37523.2|-13241.7|0.40|' +
  '0.30;Kingswood|-45267.3|-11011.0|0.40|0.30;Blaxland|-55104.8|-12476.7|0.35|0.35;Cronulla|-4887.9' +
  '|21022.7|0.35|0.35;Ettalong Beach|10928.8|-39333.1|0.35|0.30;Sutherland|-13769.5|18273.2|0.35|0.' +
  '30;Westmead|-20630.2|-6402.4|0.35|0.30;Menai|-17524.2|16520.5|0.35|0.25;Ourimbah|13778.7|-56109.' +
  '8|0.35|0.25;Panania|-19184.7|9922.0|0.35|0.25;Thirroul|-25850.6|50155.7|0.35|0.25;Berowra|-5763.' +
  '7|-26568.8|0.35|0.20;Pendle Hill|-23269.5|-7384.4|0.35|0.20;Erskine Park|-37879.0|-5942.9|0.35|0' +
  '.15;Werrington|-42020.1|-11395.4|0.35|0.15;East Hills|-20279.6|10587.8|0.35|0.10;Mount Kuring-Ga' +
  'i|-7158.1|-23586.2|0.35|0.10;Plumpton|-34167.9|-11784.8|0.35|0.10;Shalvey|-37581.2|-14918.2|0.35' +
  '|0.10;Whalan|-37255.7|-11719.7|0.35|0.10;St Marys|-41095.5|-10710.4|0.30|0.30;Windsor|-36450.5|-' +
  '28505.4|0.30|0.30;Camden|-47011.0|21401.3|0.30|0.25;Canley Heights|-26168.9|1919.5|0.30|0.25;Car' +
  'nes Hill|-33036.2|8292.2|0.30|0.25;East Blaxland|-54632.3|-12565.5|0.30|0.25;Fairfield|-23503.5|' +
  '479.5|0.30|0.25;Wentworthville|-22479.1|-6474.6|0.30|0.25;Chester Hill|-19231.6|1782.0|0.30|0.20' +
  ';Gymea|-11096.0|18543.0|0.30|0.20;Heckenberg|-29306.9|4903.0|0.30|0.20;South Penrith|-47408.3|-9' +
  '626.2|0.30|0.20;Berowra Heights|-6964.9|-28204.6|0.30|0.15;Caddens|-43922.2|-9864.8|0.30|0.15;Ca' +
  'mbridge Gardens|-45532.3|-13532.9|0.30|0.15;Lemongrove|-46291.7|-12022.1|0.30|0.15;Mount Colah|-' +
  '9108.9|-21808.4|0.30|0.15;Warwick Farm|-25296.3|5315.9|0.30|0.15;Camden South|-46514.3|24618.9|0' +
  '.30|0.10;Glendenning|-33075.0|-12798.7|0.30|0.10;Grose Wold|-49436.0|-28778.5|0.30|0.10;Hoxton P' +
  'ark|-32388.4|7415.0|0.30|0.10;Minchinbury|-35310.9|-8366.9|0.30|0.10;Niagara Park|12257.2|-54237' +
  '.3|0.30|0.10;Oxley Ridge|-44582.7|14733.2|0.30|0.10;Tregear|-38542.6|-12576.7|0.30|0.10;Wilberfo' +
  'rce|-33451.2|-34429.5|0.30|0.10;Willmot|-38770.4|-15199.6|0.30|0.10;Hornsby|-10394.0|-18092.6|0.' +
  '25|0.35;Avalon Beach|10658.2|-25946.2|0.25|0.30;Bella Vista|-23831.3|-13656.8|0.25|0.20;Bundeena' +
  '|-4939.9|24021.0|0.25|0.20;Canley Vale|-24254.7|2234.2|0.25|0.20;Como|-13307.3|14995.5|0.25|0.20' +
  ';Ingleburn|-31786.1|15669.3|0.25|0.20;Kings Park|-28100.9|-13334.2|0.25|0.20;Merrylands|-20690.0' +
  '|-3385.8|0.25|0.20;Mount Pritchard|-28245.2|4297.4|0.25|0.20;North Kellyville|-24059.0|-19836.8|' +
  '0.25|0.20;Schofields|-31676.3|-17953.2|0.25|0.20;Wallacia|-52586.0|677.1|0.25|0.20;Asquith|-9192' +
  '.5|-19849.5|0.25|0.15;Avoca Beach|20148.5|-45116.7|0.25|0.15;Busby|-29946.9|5694.9|0.25|0.15;Cam' +
  'bridge Park|-44918.2|-12278.4|0.25|0.15;Coledale|-23565.4|47385.0|0.25|0.15;Grays Point|-11474.0' +
  '|21055.9|0.25|0.15;Macquarie Fields|-29265.7|14122.6|0.25|0.15;Mulgrave|-35499.3|-26119.4|0.25|0' +
  '.15;North St Marys|-39448.3|-11919.4|0.25|0.15;Stanwell Park|-19675.2|40318.4|0.25|0.15;Toongabb' +
  'ie|-23390.6|-8056.6|0.25|0.15;Woonona|-27142.8|53409.6|0.25|0.15;Ashcroft|-28405.8|5663.3|0.25|0' +
  '.10;Austinmer|-25054.3|48524.6|0.25|0.10;Bar Point|-4909.7|-39206.2|0.25|0.10;Bensville|15559.2|' +
  '-41349.3|0.25|0.10;Carramar|-22695.3|2096.6|0.25|0.10;Chatsworth|-41055.5|-8864.2|0.25|0.10;Coly' +
  'ton|-38432.2|-8867.3|0.25|0.10;Currawong Beach|7669.1|-30459.8|0.25|0.10;Edmondson Park|-32105.2' +
  '|11256.1|0.25|0.10;Ellis Lane|-48981.7|19325.4|0.25|0.10;Great Mackerel Beach|7737.6|-30897.5|0.' +
  '25|0.10;Hassall Grove|-34614.7|-14535.9|0.25|0.10;Hawkesbury Heights|-52852.3|-20967.5|0.25|0.10' +
  ';Hewitt|-39512.0|-8897.6|0.25|0.10;Lethbridge Park|-38039.0|-13707.2|0.25|0.10;Loftus|-14326.2|1' +
  '9634.8|0.25|0.10;Marsden Park|-35627.3|-17703.9|0.25|0.10;Miller|-30293.7|6318.5|0.25|0.10;Mount' +
  ' Riverview|-53326.8|-14586.2|0.25|0.10;Oakhurst|-34959.4|-13925.7|0.25|0.10;Oxley Park|-38560.9|' +
  '-10150.8|0.25|0.10;Spring Farm|-44103.9|23135.3|0.25|0.10;Tallawong|-29894.7|-19207.7|0.25|0.10;' +
  'Vineyard|-32100.2|-23847.5|0.25|0.10;Woronora Heights|-16198.4|18632.3|0.25|0.10;Yarrawarrah|-15' +
  '755.7|20863.6|0.25|0.10;Waitara|-9989.4|-17333.8|0.20|0.30;Jamisontown|-49496.0|-9989.9|0.20|0.2' +
  '5;Cabramatta West|-27207.5|3053.2|0.20|0.20;Cardinal Gilroy Village|-22162.4|-3024.0|0.20|0.20;H' +
  'eathcote|-18213.2|24303.5|0.20|0.20;Narellan|-43205.3|20059.6|0.20|0.20;The Ponds|-28130.4|-1745' +
  '6.7|0.20|0.20;Ambarvale|-37246.4|24690.7|0.20|0.15;Arndell Park|-30443.4|-8137.6|0.20|0.15;Baulk' +
  'ham Hills|-20390.4|-11569.2|0.20|0.15;Bonnyrigg|-29518.7|3290.7|0.20|0.15;Booker Bay|12154.4|-39' +
  '570.4|0.20|0.15;Bossley Park|-30067.5|-158.4|0.20|0.15;Edensor Park|-30731.9|1688.2|0.20|0.15;Em' +
  'u Heights|-51973.2|-13553.1|0.20|0.15;Emu Plains|-50400.4|-12356.0|0.20|0.15;Fairfield East|-217' +
  '98.0|1148.1|0.20|0.15;Fairfield Heights|-24848.7|286.2|0.20|0.15;Grantham Farm|-31251.6|-22153.9' +
  '|0.20|0.15;Helensburgh|-20302.9|36106.2|0.20|0.15;Huntingwood|-30310.9|-7334.6|0.20|0.15;Kellyvi' +
  'lle|-23862.7|-16525.9|0.20|0.15;Killcare|13536.7|-38129.7|0.20|0.15;Lilli Pilli|-8225.4|22253.7|' +
  '0.20|0.15;Minto|-32757.7|18698.1|0.20|0.15;Northmead|-19669.5|-9046.2|0.20|0.15;Pemulwuy|-26098.' +
  '8|-5316.0|0.20|0.15;Quakers Hill|-29185.1|-14937.5|0.20|0.15;Raby|-35903.5|17461.9|0.20|0.15;Ros' +
  'ary Village|-22390.4|278.5|0.20|0.15;Sadleir|-29403.1|5890.6|0.20|0.15;Seven Hills|-24868.3|-982' +
  '6.6|0.20|0.15;South Wentworthville|-22091.6|-4796.2|0.20|0.15;Wakeley|-27805.8|1058.9|0.20|0.15;' +
  'West Pennant Hills|-16374.6|-13120.4|0.20|0.15;Wetherill Park|-28556.9|-1730.3|0.20|0.15;Thornto' +
  'n|-47471.6|-12531.1|0.20|0.15;Airds|-34187.1|24742.1|0.20|0.10;Bardia|-31904.0|12532.2|0.20|0.10' +
  ';Blair Athol|-37113.1|22165.1|0.20|0.10;Bradbury|-35717.3|24308.7|0.20|0.10;Cawdor|-48503.1|2553' +
  '7.4|0.20|0.10;Eagle Vale|-36280.7|19467.2|0.20|0.10;Fairfield West|-26361.4|510.4|0.20|0.10;Geor' +
  'ges Hall|-20242.2|4708.2|0.20|0.10;Glossodia|-39424.3|-36715.5|0.20|0.10;Grasmere|-49328.1|21811' +
  '.5|0.20|0.10;Hornsby Heights|-10328.4|-22638.2|0.20|0.10;Jordan Springs|-43654.3|-14815.3|0.20|0' +
  '.10;Jordan Springs East|-42714.5|-14373.0|0.20|0.10;Kirkham|-45618.6|19230.0|0.20|0.10;Len Water' +
  's Estate|-32836.8|5710.6|0.20|0.10;Morning Bay|6828.5|-26786.8|0.20|0.10;Quarry Hill|-42599.0|-8' +
  '830.7|0.20|0.10;Rosemeadow|-37929.3|27094.7|0.20|0.10;Somersby|6024.9|-55985.2|0.20|0.10;St Hele' +
  'ns Park|-36060.0|26989.2|0.20|0.10;St Johns Park|-28382.1|2073.8|0.20|0.10;The Sanctuary at Voya' +
  'ger Point|-21582.4|11224.8|0.20|0.10;The Slopes|-47556.3|-36172.1|0.20|0.10;Wamberal|20866.9|-48' +
  '808.2|0.20|0.10;Werrington Downs|-44444.0|-13267.2|0.20|0.10;Westleigh|-13412.0|-16819.1|0.20|0.' +
  '10;Wisemans Ferry|-21640.0|-52112.1|0.20|0.10;Yennora|-22189.1|-371.7|0.20|0.10;Gosford|11405.4|' +
  '-49517.6|0.15|0.30;Myrtle Glen Stanhope Gardens|-26530.6|-15741.5|0.15|0.30;Hookhams Corner|-105' +
  '57.8|-19497.2|0.15|0.25;Lansvale|-23796.2|3938.5|0.15|0.20;North Narrabeen|7414.9|-18491.0|0.15|' +
  '0.20;Umina Beach|8904.9|-38983.3|0.15|0.20;Woolooware|-6071.5|19267.9|0.15|0.20;Blackett|-36791.' +
  '5|-13766.5|0.15|0.15;Clarendon|-39487.2|-27879.9|0.15|0.15;Constitution Hill|-21756.9|-7985.7|0.' +
  '15|0.15;Dolans Bay|-7258.8|21624.2|0.15|0.15;Erina|16233.3|-47829.7|0.15|0.15;Greystanes|-24319.' +
  '6|-4482.0|0.15|0.15;Hammondville|-22701.6|9489.2|0.15|0.15;Leumeah|-33939.1|21178.9|0.15|0.15;Mo' +
  'orebank|-23079.3|8807.6|0.15|0.15;Oran Park|-42801.6|14376.5|0.15|0.15;Revesby|-17932.3|8637.6|0' +
  '.15|0.15;Rouse Hill|-27553.7|-20704.9|0.15|0.15;Wattle Grove|-24587.2|9617.3|0.15|0.15;Woodbine|' +
  '-35189.4|20289.5|0.15|0.15;Abbotsbury|-31692.7|658.8|0.15|0.10;Agnes Banks|-46683.3|-27288.8|0.1' +
  '5|0.10;Akuna Bay|1907.3|-24489.0|0.15|0.10;Angus|-34383.3|-20258.0|0.15|0.10;Annangrove|-24824.1' +
  '|-22979.6|0.15|0.10;Appin|-36479.8|38735.2|0.15|0.10;Arcadia|-14273.0|-27039.1|0.15|0.10;Austral' +
  '|-36786.0|6822.5|0.15|0.10;Badgerys Creek|-43013.8|1883.4|0.15|0.10;Bangor|-15952.3|16567.0|0.15' +
  '|0.10;Bankstown Aerodrome|-20159.2|6441.3|0.15|0.10;Bass Hill|-19426.6|3886.6|0.15|0.10;Bateau B' +
  'ay|23246.7|-54039.9|0.15|0.10;Berkshire Park|-39750.3|-19988.1|0.15|0.10;Bickley Vale|-50127.1|2' +
  '4326.7|0.15|0.10;Blairmount|-37887.1|20988.6|0.15|0.10;Blaxlands Ridge|-38030.3|-43448.8|0.15|0.' +
  '10;Bligh Park|-38590.7|-24820.9|0.15|0.10;Bouddi|16985.5|-39245.6|0.15|0.10;Bow Bowing|-33768.2|' +
  '16997.3|0.15|0.10;Box Head|12011.2|-37169.1|0.15|0.10;Box Hill|-29651.1|-23333.9|0.15|0.10;Bradf' +
  'ield|-43993.8|6028.2|0.15|0.10;Brooklyn|1800.8|-31956.5|0.15|0.10;Bulli|-26404.9|51990.5|0.15|0.' +
  '10;Calga|-51.5|-48488.5|0.15|0.10;Canoelands|-11726.9|-40638.0|0.15|0.10;Castlereagh|-49662.4|-1' +
  '9174.5|0.15|0.10;Cataract|-34549.8|47770.7|0.15|0.10;Cattai|-27813.5|-35039.8|0.15|0.10;Cecil Hi' +
  'lls|-33087.1|2986.3|0.15|0.10;Cecil Park|-36555.6|3309.7|0.15|0.10;Cheero Point|-2255.0|-39577.4' +
  '|0.15|0.10;Claremont Meadows|-42595.8|-9628.4|0.15|0.10;Claymore|-36498.8|20493.5|0.15|0.10;Clif' +
  'ton|-21408.3|43584.6|0.15|0.10;Cliftonville|-27946.6|-48031.6|0.15|0.10;Coalcliff|-20979.1|42004' +
  '.2|0.15|0.10;Coasters Retreat|7820.1|-29400.5|0.15|0.10;Coba Point|-6640.7|-36034.8|0.15|0.10;Co' +
  'gra Bay|1166.3|-38265.6|0.15|0.10;Copacabana|20190.3|-42344.5|0.15|0.10;Cumberland Reach|-30005.' +
  '3|-44682.4|0.15|0.10;Darkes Forest|-27176.5|39355.7|0.15|0.10;Denham Court|-34793.2|13198.8|0.15' +
  '|0.10;Dharruk|-36724.4|-12511.4|0.15|0.10;Dunheved|-40835.7|-13210.6|0.15|0.10;East Kurrajong|-3' +
  '8429.1|-39558.7|0.15|0.10;Eastern Creek|-33251.1|-6846.0|0.15|0.10;Ebenezer|-30574.2|-38490.9|0.' +
  '15|0.10;Elderslie|-45049.7|21857.6|0.15|0.10;Elvina Bay|5758.8|-25640.7|0.15|0.10;Engadine|-1812' +
  '4.1|21271.6|0.15|0.10;Erina Heights|18146.4|-49249.9|0.15|0.10;Eschol Park|-37374.6|18796.2|0.15' +
  '|0.10;Fiddletown|-11518.1|-33855.2|0.15|0.10;Forest Glen|-18400.1|-35214.0|0.15|0.10;Freemans Re' +
  'ach|-38166.9|-32502.4|0.15|0.10;Gables|-28459.3|-26080.7|0.15|0.10;Galston|-14033.1|-24254.1|0.1' +
  '5|0.10;Gilead|-38767.4|27716.5|0.15|0.10;Glenfield|-28771.4|12144.3|0.15|0.10;Glenhaven|-19645.1' +
  '|-18060.6|0.15|0.10;Glenorie|-18959.9|-29241.5|0.15|0.10;Glenworth Valley|-3183.0|-50283.0|0.15|' +
  '0.10;Green Point|13178.2|-45009.1|0.15|0.10;Green Valley|-31325.3|4349.0|0.15|0.10;Greendale|-49' +
  '981.6|6129.2|0.15|0.10;Greenfield Park|-29343.8|1275.3|0.15|0.10;Greengrove|-5648.0|-54113.2|0.1' +
  '5|0.10;Gronos Point|-31039.6|-33650.5|0.15|0.10;Grose Vale|-49680.1|-30144.2|0.15|0.10;Guildford' +
  '|-19804.0|-744.4|0.15|0.10;Guildford West|-22576.3|-1853.3|0.15|0.10;Gunderman|-13981.0|-47315.2' +
  '|0.15|0.10;Gymea Bay|-10917.2|20252.2|0.15|0.10;Hardys Bay|12807.2|-38129.6|0.15|0.10;Hillside|-' +
  '21387.4|-29609.5|0.15|0.10;Hinchinbrook|-31746.4|6014.7|0.15|0.10;Hobartville|-43709.0|-28455.6|' +
  '0.15|0.10;Holgate|17726.1|-51549.6|0.15|0.10;Holroyd|-19678.8|-3972.9|0.15|0.10;Holsworthy|-2376' +
  '1.2|10532.3|0.15|0.10;Horsley Park|-33486.6|-2279.4|0.15|0.10;Kariong|4548.4|-45946.4|0.15|0.10;' +
  'Kearns|-37306.6|17467.7|0.15|0.10;Kemps Creek|-39255.9|767.1|0.15|0.10;Kenthurst|-22056.8|-24567' +
  '.0|0.15|0.10;Kincumber|16313.9|-44484.0|0.15|0.10;Kings Langley|-25433.1|-12642.2|0.15|0.10;Ku-r' +
  'ing-gai Chase|-1206.2|-24219.3|0.15|0.10;Lalor Park|-26173.0|-11025.0|0.15|0.10;Laughtondale|-17' +
  '345.7|-47529.2|0.15|0.10;Leets Vale|-24845.9|-48031.6|0.15|0.10;Leppington|-37534.2|11402.6|0.15' +
  '|0.10;Little Wobby|3184.4|-35479.8|0.15|0.10;Llandilo|-42880.5|-17110.4|0.15|0.10;Londonderry|-4' +
  '4147.1|-22952.0|0.15|0.10;Lovett Bay|5765.7|-26299.0|0.15|0.10;Lower Mangrove|-5507.9|-50242.1|0' +
  '.15|0.10;Lower Portland|-30112.3|-46729.2|0.15|0.10;Lucas Heights|-21408.1|19217.8|0.15|0.10;Lug' +
  'arno|-14983.0|12763.9|0.15|0.10;MacMasters Beach|18499.6|-41487.1|0.15|0.10;Macquarie Links|-308' +
  '20.9|13109.9|0.15|0.10;Maddens Plains|-23454.1|43656.4|0.15|0.10;Maianbar|-6878.9|23368.2|0.15|0' +
  '.10;Mangrove Creek|-8408.3|-56873.2|0.15|0.10;Maraylya|-27268.6|-29949.7|0.15|0.10;Marlow|-4875.' +
  '6|-44281.9|0.15|0.10;Maroota|-21832.1|-45191.9|0.15|0.10;Matcham|19290.1|-50649.2|0.15|0.10;McGr' +
  'aths Hill|-34508.2|-27717.7|0.15|0.10;Melonba|-38699.8|-18198.1|0.15|0.10;Melville|-41015.5|-701' +
  '5.8|0.15|0.10;Menangle Park|-41234.8|26592.2|0.15|0.10;Middle Heights Estate|-24244.6|47960.3|0.' +
  '15|0.10;Mill Dam Falls|-50532.0|-21594.6|0.15|0.10;Mooney Mooney Creek|130.1|-44563.8|0.15|0.10;' +
  'Mornington|-23082.6|10650.6|0.15|0.10;Mount Annan|-40858.8|22469.1|0.15|0.10;Mount Vernon|-36921' +
  '.5|-178.1|0.15|0.10;Mulgoa|-51540.5|-4849.2|0.15|0.10;Nelson|-27133.7|-24004.6|0.15|0.10;North R' +
  'ichmond|-46356.4|-32596.4|0.15|0.10;North Rocks|-17880.5|-9984.5|0.15|0.10;Oakville|-31740.9|-26' +
  '369.5|0.15|0.10;Old Guildford|-20771.1|-167.8|0.15|0.10;Orchard Hills|-44096.5|-5947.1|0.15|0.10' +
  ';Otford|-18371.3|37946.1|0.15|0.10;Peach Trees|-3535.4|-26243.0|0.15|0.10;Peats Ridge|1310.0|-59' +
  '603.7|0.15|0.10;Picketts Valley|17597.0|-45925.6|0.15|0.10;Pitt Town|-31842.5|-30958.8|0.15|0.10' +
  ';Pitt Town Bottoms|-34355.7|-30580.1|0.15|0.10;Prestons|-30770.8|8588.4|0.15|0.10;Richards|-3339' +
  '2.7|-21689.6|0.15|0.10;Richmond|-40885.6|-28455.6|0.15|0.10;Ropes Crossing|-40014.8|-14699.5|0.1' +
  '5|0.10;Rossmore|-40495.6|8299.2|0.15|0.10;Ruse|-33364.8|22880.3|0.15|0.10;Sackville|-31040.2|-40' +
  '643.1|0.15|0.10;Sackville North|-28097.8|-41838.4|0.15|0.10;Scarborough|-22205.9|44648.4|0.15|0.' +
  '10;Scheyville|-30050.4|-28871.3|0.15|0.10;Shanes Park|-39019.4|-17137.4|0.15|0.10;Singletons Mil' +
  'l|-12870.5|-44471.1|0.15|0.10;Smeaton Grange|-41374.9|19507.3|0.15|0.10;Smithfield|-24880.6|-180' +
  '4.6|0.15|0.10;South Maroota|-24565.2|-39038.7|0.15|0.10;Spencer|-6783.8|-45507.6|0.15|0.10;Sprin' +
  'gfield|14683.9|-49176.4|0.15|0.10;St Andrews|-34681.2|17536.7|0.15|0.10;Stanwell Tops|-20444.6|3' +
  '9412.4|0.15|0.10;Summit Estate|-53639.2|-12344.0|0.15|0.10;Sunny Corner|-5482.7|-36871.5|0.15|0.' +
  '10;Tennyson|-44750.5|-36523.2|0.15|0.10;The Hills of Carmel|-30073.1|-23255.6|0.15|0.10;Tumbi Um' +
  'bi|19155.7|-54688.0|0.15|0.10;Varroville|-35894.8|15990.6|0.15|0.10;Villawood|-20828.5|2263.4|0.' +
  '15|0.10;Waterfall|-19724.9|28572.8|0.15|0.10;Wedderburn|-35041.8|31111.5|0.15|0.10;Wendoree Park' +
  '|-5324.4|-45716.0|0.15|0.10;Windsor Downs|-37388.8|-22582.4|0.15|0.10;Winmalee|-55449.3|-20231.6' +
  '|0.15|0.10;Winston Hills|-21274.5|-9781.9|0.15|0.10;Wombarra|-23003.2|45712.3|0.15|0.10;Wondabyn' +
  'e|1707.3|-40563.5|0.15|0.10;Woy Woy|5960.1|-40664.7|0.15|0.10;Yarramundi|-50672.1|-25279.0|0.15|' +
  '0.10;Yattalunga|13829.0|-44680.4|0.15|0.10;Castle Hill|-19015.4|-14854.0|0.10|0.35;Mona Vale|832' +
  '6.3|-21408.6|0.10|0.30;St Clair|-39311.9|-7091.6|0.10|0.30;Caringbah|-7419.7|18634.9|0.10|0.25;E' +
  'ast Gosford|12664.7|-48319.2|0.10|0.25;Miranda|-9437.6|18413.7|0.10|0.25;Newport|9530.6|-23420.9' +
  '|0.10|0.20;Norwest|-22962.7|-14633.1|0.10|0.20;Terrey Hills|622.7|-19763.6|0.10|0.20;Beaumont Hi' +
  'lls|-25236.4|-18285.3|0.10|0.15;Caringbah South|-7917.9|20662.8|0.10|0.15;Casula|-28785.8|9826.7' +
  '|0.10|0.15;Kellyville Ridge|-26948.4|-17839.6|0.10|0.15;Marayong|-29630.3|-12710.9|0.10|0.15;Mur' +
  'ray Farm|-16395.4|-11215.1|0.10|0.15;North Parramatta|-18440.6|-7817.9|0.10|0.15;Palm Beach|1004' +
  '8.5|-29924.6|0.10|0.15;Parklea|-27445.6|-15436.5|0.10|0.15;Prospect|-26746.7|-7102.7|0.10|0.15;R' +
  'egentville|-50857.0|-9803.3|0.10|0.15;Rogans Hill|-17487.5|-15839.9|0.10|0.15;Stanhope Gardens|-' +
  '26383.4|-16497.2|0.10|0.15;Thompsons Corner|-15006.6|-13140.6|0.10|0.15;Warriewood|7532.7|-19927' +
  '.4|0.10|0.15;Werrington County|-42914.1|-12650.6|0.10|0.15;Woodcroft|-30607.6|-12027.8|0.10|0.15' +
  ';Woronora|-14831.7|17577.1|0.10|0.15;Acacia Gardens|-27622.9|-14412.0|0.10|0.10;Alfords Point|-1' +
  '6881.1|13079.6|0.10|0.10;Barden Ridge|-18038.9|18345.7|0.10|0.10;Berrilee|-10122.7|-28223.2|0.10' +
  '|0.10;Bilgola Plateau|9375.4|-24999.8|0.10|0.10;Bonnet Bay|-14143.6|15875.7|0.10|0.10;Bonnyrigg ' +
  'Heights|-31318.6|3078.5|0.10|0.10;Bungarribee|-32051.4|-8986.7|0.10|0.10;Burraneer|-6120.2|21740' +
  '.8|0.10|0.10;Cartwright|-29227.6|6738.8|0.10|0.10;Catherine Field|-40900.2|13833.1|0.10|0.10;Chi' +
  'pping Norton|-22737.5|5544.8|0.10|0.10;Clareville|8808.8|-26026.9|0.10|0.10;Colebee|-33016.6|-15' +
  '383.8|0.10|0.10;Crestwood|-22414.1|-13596.1|0.10|0.10;Currans Hill|-39857.5|20517.0|0.10|0.10;Da' +
  'leys Point|12227.5|-40614.3|0.10|0.10;Davistown|13252.7|-42819.7|0.10|0.10;Dean Park|-32624.2|-1' +
  '4144.1|0.10|0.10;Doonside|-31779.9|-12025.0|0.10|0.10;Duncraig Estate|-22322.1|-18233.5|0.10|0.1' +
  '0;Dural|-15230.7|-20051.7|0.10|0.10;Elizabeth Hills|-33242.6|4170.0|0.10|0.10;Englorie Park|-377' +
  '42.1|24248.7|0.10|0.10;Forresters Beach|22841.1|-51381.7|0.10|0.10;Girraween|-24558.0|-7194.6|0.' +
  '10|0.10;Gledswood Hills|-39373.6|16466.6|0.10|0.10;Glen Alpine|-38773.4|25299.2|0.10|0.10;Glenmo' +
  're Park|-48980.3|-7467.0|0.10|0.10;Glenwood|-25949.2|-14149.5|0.10|0.10;Grey Gum Estate|-25577.7' +
  '|-19749.6|0.10|0.10;Harrington Park|-42828.3|18145.5|0.10|0.10;Horningsea Park|-33685.6|9221.3|0' +
  '.10|0.10;Horsfield Bay|7891.5|-41833.3|0.10|0.10;Illawong|-15114.8|14535.2|0.10|0.10;Ingleside|4' +
  '196.6|-20087.8|0.10|0.10;Ingleside Heights|5078.3|-21835.0|0.10|0.10;Kareela|-11539.3|16511.2|0.' +
  '10|0.10;Killcare Heights|14539.8|-38577.7|0.10|0.10;Lansdowne|-21650.7|3453.3|0.10|0.10;Long Poi' +
  'nt|-28530.5|16394.1|0.10|0.10;Lurnea|-28718.1|7981.2|0.10|0.10;Mays Hill|-20531.4|-4970.3|0.10|0' +
  '.10;McCarrs Creek|5894.1|-25122.0|0.10|0.10;Middle Dural|-18206.6|-25231.5|0.10|0.10;Middleton G' +
  'range|-33815.7|5699.0|0.10|0.10;Mooney Mooney|-1215.5|-38238.2|0.10|0.10;Mount Elliot|15455.0|-5' +
  '1512.3|0.10|0.10;Mount White|-2327.7|-45676.1|0.10|0.10;Mulgoa Sanctuary|-49790.1|-6109.9|0.10|0' +
  '.10;Narara|10795.8|-52669.5|0.10|0.10;Nirimba Fields|-31491.3|-15911.2|0.10|0.10;North Gosford|1' +
  '2598.5|-50134.4|0.10|0.10;Old Toongabbie|-22323.3|-8787.2|0.10|0.10;Padstow Heights|-15946.6|115' +
  '83.0|0.10|0.10;Patonga|5014.6|-35290.3|0.10|0.10;Pearl Beach|8234.8|-36368.4|0.10|0.10;Picnic Po' +
  'int|-18472.5|11673.3|0.10|0.10;Pleasure Point|-20267.3|11879.7|0.10|0.10;Port Hacking|-7315.1|22' +
  '220.4|0.10|0.10;Prairiewood|-28116.5|-92.7|0.10|0.10;Pretty Beach|12190.7|-37971.6|0.10|0.10;Rev' +
  'esby Heights|-17392.3|11367.1|0.10|0.10;Riverstone|-31835.0|-20881.7|0.10|0.10;Round Corner|-179' +
  '00.4|-19046.9|0.10|0.10;Sandy Point|-19693.5|12191.0|0.10|0.10;Saratoga|12439.2|-43834.5|0.10|0.' +
  '10;South Windsor|-38010.8|-25719.4|0.10|0.10;St Huberts Island|12037.2|-41552.1|0.10|0.10;Tascot' +
  't|8898.6|-46173.0|0.10|0.10;Voyager Point|-21549.8|10334.6|0.10|0.10;Wagstaffe|11631.2|-38568.0|' +
  '0.10|0.10;West Hoxton|-34531.1|7639.8|0.10|0.10;Woodpark|-23097.2|-2611.3|0.10|0.10;Yowie Bay|-9' +
  '430.5|20301.8|0.10|0.10;Thornleigh|-12174.3|-15881.3|0.05|0.15;West Gosford|9662.1|-49836.2|0.05' +
  '|0.15;Bilgola Beach|10345.4|-25029.8|0.05|0.10;Blackwall|10454.5|-40614.6|0.05|0.10;Cherrybrook|' +
  '-15403.6|-15918.7|0.05|0.10;Church Point|6806.9|-24125.6|0.05|0.10;Cranebrook|-46519.9|-17023.1|' +
  '0.05|0.10;Elanora Heights|5492.6|-18829.8|0.05|0.10;Empire Bay|13479.8|-41624.5|0.05|0.10;Gregor' +
  'y Hills|-39675.1|18403.4|0.05|0.10;Kincumber South|14905.4|-42959.2|0.05|0.10;Koolewong|9358.9|-' +
  '44855.6|0.05|0.10;Leonay|-51902.9|-10471.8|0.05|0.10;Lisarow|15337.5|-53846.6|0.05|0.10;Loquat V' +
  'alley|7394.4|-23431.8|0.05|0.10;Milperra|-20630.4|8150.6|0.05|0.10;Mulgoa Rise|-49055.7|-6070.5|' +
  '0.05|0.10;Narellan Vale|-42426.8|21154.3|0.05|0.10;North Avalon|11336.4|-26871.6|0.05|0.10;North' +
  ' Avoca|20224.6|-46107.4|0.05|0.10;North Turramurra|-5710.5|-19584.5|0.05|0.10;Phegans Bay|8400.6' +
  '|-42324.4|0.05|0.10;Point Clare|9615.8|-47676.7|0.05|0.10;Point Frederick|11591.5|-47391.7|0.05|' +
  '0.10;Terrigal|19461.8|-47229.7|0.05|0.10;Twin Creeks|-41708.7|-1893.4|0.05|0.10;Whale Beach|1074' +
  '6.6|-28631.9|0.05|0.10;Woy Woy Bay|8952.1|-42877.1|0.05|0.10;Wyoming|13076.1|-51477.4|0.05|0.10;' +
  'Bayview|6873.5|-23329.6|0.05|0.05;Duffys Forest|-1908.5|-21650.3|0.05|0.05;Kentlyn|-30975.7|2171' +
  '2.2|0.05|0.05;Minto Heights|-30571.2|19035.6|0.05|0.05;North Wahroonga|-7828.1|-18318.1|0.05|0.0' +
  '5';

/**
 * Every suburb: the curated block, then the stage-4 ring, in that order.
 *
 * The order is the invariance, exactly as it is in `wildlife.PARKS`.
 * `suburbSeed` is a function of the row and `streetKey` of its index, so a
 * suburb keeps its loiterers only because it keeps its position -- and
 * appending is the whole trick.
 */
export const SUBURBS: readonly Suburb[] = (() => {
  const out: Suburb[] = SUBURBS_CURATED.slice();
  for (const rec of SUBURBS_STAGE4_PACKED.split(';')) {
    const f = rec.split('|');
    out.push({ name: f[0], x: +f[1], z: +f[2], crime: +f[3], booze: +f[4] });
  }
  return out;
})();

/**
 * The extent both tables were extracted inside. `verifyStreetlife` asserts it.
 *
 * **Sixty kilometres against a world on disk that reaches 19,300 m.** An anchor
 * past the built extent is dormant, not broken: `forEachMethheadNear` and
 * `forEachDrunkNear` both place their people on the footpath bands
 * `PedestrianField.near` hands back, and outside the built world it hands back
 * an empty list -- so the anchor poses nobody, costs one squared distance a
 * query, and no frame anywhere has to know. `integration-check`'s `builtGate`
 * names the same state from the other side and reports the skipped count.
 */
export const STREET_EXTENT_M = 60000;

/**
 * The extent the frozen prefix of each table was baked inside, and how long that
 * prefix is.
 *
 * The invariance contract in three numbers. Rows `[0, SUBURB_INNER_COUNT)` of
 * `SUBURBS` and venues `[0, VENUE_INNER_COUNT)` of `VENUE_XZ` are the 5,300 m
 * bake, unchanged and in their original order, so every seed, index, key and
 * count derived from them is unchanged too. `verifyStreetlife` asserts the
 * prefix is still inside the ring it came from.
 */
export const STREET_INNER_EXTENT_M = 5300;
export const SUBURB_INNER_COUNT = 59;
export const VENUE_INNER_COUNT = 422;

/**
 * Every `amenity=pub|bar|biergarten` in the extent, as flat integer x, z pairs.
 *
 * **Packed rather than records**, and it is the one place this file departs
 * from `POLICE_STATIONS`' shape. Ninety-three stations with names is a table a
 * reader can check by eye; eight hundred and seventy-five named venues is ten
 * pages nobody reads, and the names are not used for anything -- a drunk does
 * not know which pub they came out of. Metres, rounded: a pub's front door is
 * not a surveyed point and the loiterer is placed on the nearest footpath in
 * any case.
 *
 * Extracted the same way the stations were: a read-only scratch script over
 * `data/cache/sydney.osm.pbf` for the first 642 and
 * `data/cache/sydney-60km.osm.pbf` for the rest, projected through
 * `sydney.geo.lonlat_to_enu` and `enu_to_world`, the points and multipolygon
 * layers merged and deduped at 30 m so a pub mapped as both a node and its own
 * building outline arrives once.
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
  // --- The 5,300 - 15,300 m middle ring: 189 more, appended. Everything above
  // is the inner-ring bake at its original indices; see `VENUE_INNER_COUNT`.
  4142, 3428, -508, 5371, -5102, -1839, 4164, 3484, -3732, 3990, 3124, -4542, -1507, 5311,
  1719, 5261, -3783, 4048, -4560, 3164, -3037, 4658, 5606, 32, 3599, 4352, -4905, 2816,
  2722, -4995, -3990, 4077, -5437, 1823, 3160, 4810, -4983, 2946, 3130, 4886, -4049, 4223,
  -4064, 4334, -1073, 5880, -3314, 4993, -4366, 4106, -158, 6015, 1736, 5772, -5924, -1215,
  -4204, 4367, -5193, 3193, -3125, 5266, 5805, 1973, 5757, 2149, 5898, 1846, 5538, 2793,
  -5740, 2474, 3107, 5443, -5391, 3228, 5871, 2257, -4235, 4672, -4040, 4855, 42, -6334,
  1841, 6078, -4107, 4853, -1909, 6075, 5935, 2466, -2271, -6022, 5998, 2393, 6066, 2256,
  6103, 2197, -3877, 5220, 3250, 5672, 6156, 2210, -4057, 5184, -4396, 4917, -4623, 4796,
  -4679, 4773, -4599, 4852, -4636, 4830, -4924, 4629, -4822, 4748, -4898, 4776, -1065, -6813,
  -6541, 2514, -1284, 6905, -4993, 4941, -6531, 2698, -3686, -6084, 5219, 4840, -6008, 3886,
  -3745, -6146, 4458, 5705, -6128, 3967, 6708, -2981, -7351, 188, -7362, 256, -7399, 32,
  6850, -2846, -2939, -7001, -7712, 568, -2798, 7323, -4531, 6512, -2649, 7548, -7657, 2466,
  -7751, 2316, -6980, 4171, -1238, -8060, -7849, 2318, -3890, 7348, -2833, -7856, -3507, 7590,
  -3572, 7596, -3714, 7536, -3681, 7563, -2716, -7973, -3625, 7608, -1357, -8355, -1070, 8405,
  -2834, -7997, -3594, 7737, -2720, -8093, -4568, 7223, -3844, 7678, -1357, 8525, -7727, -3859,
  -1195, 8585, -3887, 7794, -3872, 7918, -3921, 7931, -3954, 7940, -629, 9295, -5530, 7566,
  -8194, 4965, 4514, 8500, -9639, 200, -9761, 1061, -9779, 1143, 3949, 9090, -9451, 3184,
  -7646, 6519, 291, 10071, 581, 10157, -9940, 2241, 6530, -7841, 2178, 10080, 6868, -7702,
  6863, -7747, 6896, -7730, 6884, -7806, -10551, 493, 6978, -7962, 6970, -8039, -10673, 731,
  7073, -8044, 7045, -8074, 7187, -7967, -9693, 4644, 7114, -8089, -9665, 4826, 7120, -8126,
  -9886, 4880, -10833, 2374, -11212, -474, -9768, -5560, 5792, -9632, -9631, -5875,
  -6387, 9319, -4771, 10295, -4763, 10375, -7234, -8863, -11448, -184, -8567, 7847,
  -11621, 2779, 7088, -9907, -11554, 3952, 6894, -10080, -11057, 5631, -12591, -789,
  -6888, 10712, -12724, -743, -5170, -11668, -9751, 8251, -9813, 8183, -12156, -4621,
  -12875, -2201, 5538, -11839, -11236, -6682, -9138, -9529, -11463, -6635, -13156, -2091,
  -13253, -2182, 5784, -12145, -7645, 11223, -9053, -10451, -8595, 11391, -5901, 13093,
  6701, -12735, -6552, 12933, -11836, -8430, -9597, 10973, -9476, 11117, -11947, -8454,
  -9740, 10986, -9778, 10957, -11682, 9248, -14587, 3371, 684, -15064, 7845, -12913,
  -15278, -378,
  // --- The 15,300 - 19,300 m outer ring: 31 more, appended. The 19,300 m
  // re-extract seeded its 30 m dedupe with the 611 rows above and produced
  // **no new venue inside 15,300 m at all**, so every index above keeps its
  // coordinate, its `venueSeed` and its drunks.
  -5763, 14310, -12610, 8905, -9465, 12247, -11020, 10877, -9456, 12357, -14555, -5722,
  -14221, 6624, -12025, -10447, -16211, -1832, -11730, 11628, -16477, -1728, -15979, 4440,
  -7695, 14699, -15627, -6014, -7008, 15229, -14107, 9107, -13392, 10342, -15916, 5789,
  -16192, 5660, -11684, 12580, -16115, 5973, -16320, 5638, 8252, -15354, -16441, 5889,
  -14973, -9249, -18128, 1955, -9397, 15691, -18073, -3802, -16102, 9586, -18379, -5523,
  -12901, -14219,
  // --- The 19,300 - 60,000 m stage-4 ring: 233 more, appended. Extracted from
  // `data/cache/sydney-60km.osm.pbf` by `data/scratch/bake_anchors_60km.py`,
  // same projection, same 30 m dedupe seeded with all 642 rows above, so no
  // index above changes its coordinate, its `venueSeed` or its drunks.
  //
  // The 60 km extract finds 712 `amenity=pub|bar|biergarten` inside the frozen
  // 19,300 m line against the 642 baked above -- OSM has kept mapping. The 70
  // are **not** appended: an insertion anywhere would be fine (the table is
  // positional, not sorted) but a *new inner venue* is a drunk in a street a
  // player already walks, and the rings above are frozen. They will arrive the
  // next time the frozen line is redrawn.
  //
  // Two hundred and thirty-three past the line is thin for the whole western
  // basin, and that is the data rather than the filter: OSM's pub coverage is
  // excellent inside the harbour ring and patchy past Parramatta. One candidate
  // was dropped for landing in mapped water; twelve deduped.
  -17572, 8135, -18961, -4172, -19401, 1910, -12841, 14746, -18830, -5290, 585, -19605,
  -18840, -5764, -18998, -5233, -19072, -5012, -19059, -5505, -18829, -6284, -19009, -5780,
  -19030, -5913, -4635, 19475, -19201, -5710, -10162, -17312, -19268, -5762, -9993, -17491,
  -19368, -5577, -19351, 5684, 6194, -19304, -19335, -6556, -20252, -3203, -6428, 19555,
  -7514, 19359, -7547, 19377, -4717, 20335, -9656, 18547, -4689, 20389, -4729, 20390,
  -7625, 19523, -10744, -18016, -13040, 16435, -10407, -18220, -19480, -7857, -5003, 20435,
  -4973, 20447, -8929, -19116, -10651, -18270, -19405, 8583, -10866, 18360, -4697, 20909,
  -20581, -6367, -19277, 9790, -11175, 18592, -12007, 18279, -22001, 460, -10302, -19608,
  -5975, 21590, -22360, -3467, -13699, 18140, -22078, -6226, -13704, 18423, -13807, 18349,
  -23110, 562, 8589, -21468, -23101, -1553, -20601, 10814, -23270, 903, -20299, -11496,
  -23354, 762, -16367, 16881, -23561, 997, -19234, -14638, -24034, -4006, -4780, 23924,
  -22197, -10134, -4915, 24025, -23503, -7087, -24708, 2430, 8811, -23250, 8851, -23285,
  -24821, 2419, -24878, 2847, -23919, 7442, -24892, 3328, -23141, 10027, -25029, 3455,
  -17144, -18653, -24146, -8569, -24370, 9966, -26284, 2135, -21591, -15256, -26220, 6060,
  -26061, 6736, -26260, 6074, -26252, 6133, -26299, 6000, -26304, 6363, -26283, 6483,
  -26331, -6539, -26344, 6626, -23058, -14370, -27234, 1955, -27465, 3516, -5810, -27153,
  -26866, 7260, 10650, -25824, 10709, -25923, 10906, -26028, -17718, 22248, -28541, 3686,
  -28670, 3552, -7128, -28237, -26997, -11088, -28505, -6303, -28941, 4360, -28024, -10505,
  -27420, -13238, -30456, 101, -30459, 144, -29602, 7410, -29980, 6171, -18415, 24530,
  -29045, -10517, -29713, 10483, -28809, -13092, -30809, 7246, -26365, -18130, -31613, -11229,
  -27190, -19730, -27909, -21074, -31615, 14995, -19412, -29312, -33905, -10007, -34065, -10148,
  922, -35585, -34260, -13012, -35187, -11473, -35855, -10714, -36140, -10468, -36152, -10680,
  -36334, 11684, -34386, -16623, -37086, -9937, -36619, 12566, -36059, -14550, -31503, -23060,
  -37923, -9373, -37209, -13160, 9733, -38687, -35644, 18093, -34602, 21042, -34825, 20852,
  10944, -39483, 11132, -39535, -20317, 36067, -20551, 35960, -40685, -8201, -40508, -10417,
  -40877, -10236, -36013, 22470, -36151, 24528, 10070, -42824, 9976, -42862, 10948, -42685,
  -37355, 23406, -42830, -11531, -40682, 17859, -35309, -27489, -37287, 24822, -33065, -30729,
  -42784, 15049, -41183, 20957, -36446, -28421, -36356, -28573, -36432, -28506, -36538, -28417,
  -36639, -28333, -37019, -28012, -37340, -27646, -45511, -11279, 15335, -44567, -46331, -9311,
  -43260, 19803, -45831, -13214, -43789, 20046, 7009, -47790, -47212, -10291, -39546, -28129,
  -47702, -11754, -47813, -12130, -47901, -11840, -47914, -12131, 11480, -48105, -47832, -13000,
  12689, -47935, -47949, -13739, -22023, 44875, -48348, -12800, -48895, -11306, 10342, -49271,
  -48914, -12652, -49032, -12504, -49692, -10039, 15431, -48309, 11536, -49438, -49895, -12559,
  -46870, 21432, 20944, -47095, 21118, -47048, 21072, -47114, -46941, 21475, 21044, -47147,
  20985, -47210, -46977, 21537, -46995, 21504, -47095, 21595, -42952, -29038, -42884, -29256,
  -47219, 21667, -47247, 21610, 20576, -47738, -42972, -29303, -52577, 620, 20334, -49013,
  12352, -51738, -38163, 37494, -47073, 25641, -45550, -31149, -45789, -30862, 12457, -54112,
  -55975, 3201, -25534, 49990, -25967, 50256, -55476, -11157, -26054, 50235, -55883, -12721,
  -21867, -53320, 14043, -56286, 23512, -53358, -27061, 53228, -56112, -20861,
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
 * because the nearest-suburb search behind it is 255 distance tests and the
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
  byKey: Map<number, Pool>;
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

/**
 * How far a **suburb** will widen its search when its own spread holds no
 * footpath at all, metres. `factions.CATCHMENT_RESCUE_MAX` for a loiterer, and
 * the same shape of answer: double until there is real concrete, and put the
 * person on it.
 *
 * ---------------------------------------------------------------------------
 * Why a suburb needs one, measured against the shipped 60 km world.
 *
 * A `Suburb` row is a `place=suburb` **node**, which OSM puts wherever the
 * label belongs and not where the streets are. In the inner city those are the
 * same place. Out past Blacktown they routinely are not, and the extent now
 * reaches far enough that the difference is a hole rather than a curiosity:
 *
 *   - **Marsden Park** is a greenfield estate whose node sits in the paddock
 *     that has not been subdivided yet. 157 lane routes and 472 bands within a
 *     kilometre; **none** within its 183 m spread.
 *   - **Bankstown Aerodrome**'s node is on the runway.
 *   - **Woy Woy**'s node is over Brisbane Water; the town is 1.3 km away.
 *   - **Ku-ring-gai Chase** is a national park.
 *
 * Thirty-seven of the 693 suburbs that carry loiterers on a built tile placed
 * **nobody** for this reason -- not "nobody visible from here", but
 * `poseMethhead` returning false, which means those people do not exist. That
 * is exactly the silent thinning the per-loiterer patch fallback below was
 * written to stop, one rung further out. With this rung: 990 of 990.
 *
 * ---------------------------------------------------------------------------
 * Why 1,400 and not the police's 900.
 *
 * Measured, per starved suburb, as the doubling rung at which
 * `PedestrianField.near` first returns a band around the centroid: nine land at
 * 646 m, one at 688, three at 1,292, one at 1,376, and three past 2,500. Nine
 * hundred would have left **Woy Woy** empty, which is a town of ten thousand
 * people and reads as a bug; 1,400 reaches every suburb in the table whose
 * centroid is on land anybody can drive to.
 *
 * The two it does not reach -- **Coba Point** and **Sunny Corner** -- are
 * boat-access-only Hawkesbury settlements whose nearest street is kilometres
 * away across the river. They place nobody, which is the honest answer:
 * `checkStreetlife` counts and names them rather than pretending, on
 * `integration-check.builtGate`'s own argument that an anchor the world cannot
 * hold is inert rather than broken.
 *
 * **It is a rescue, not a widening.** The pool is searched at the suburb's own
 * spread first and this only runs when that came back empty, so no loiterer who
 * is placed today moves by a millimetre: the frozen inner ring's 122 across 59
 * suburbs is the same 122 in the same places.
 */
export const METH_RESCUE_MAX = 1400;

/**
 * The furthest a loiterer can possibly stand from their suburb's centroid,
 * metres -- **derived from the search that places them, not measured**, exactly
 * as `DRUNK_REACH` is derived from `VENUE_BAND_RADIUS`.
 *
 * Three terms, and the middle one is the one that is easy to forget.
 * `PedestrianField.near` selects on a band's **axis-aligned bounding box**
 * against the query *square*, so a band admitted at radius `r` can have its
 * nearest real point out at the corner of that square -- `r * sqrt(2)`, which
 * is what `SPREAD_DIAGONAL` already is elsewhere in this file. On top of that
 * the rescue branch adds at most `LOITER_REACH` of stroll along the kerb.
 *
 * Measured against the shipped 60 km world, the worst loiterer in the city
 * stands **1,903 m** from their centroid -- Ku-ring-gai Chase, whose node is in
 * the middle of a national park and whose nearest footpath really is that far
 * away -- against the 2,081 m this derivation allows. `checkStreetlife` asserts
 * the bound over every loiterer in the built city rather than trusting it,
 * which is the assertion the drunks have had since the frontage fix and the
 * meth heads did not.
 */
export const METH_REACH = METH_RESCUE_MAX * SPREAD_DIAGONAL + LOITER_REACH;

/**
 * The band pool around a point, and **the radius it was actually found at**.
 *
 * `factions.Beat` verbatim, and here for the same reason: a rescued anchor
 * reaches past the radius it was asked for, and every broadphase gate
 * downstream of it has to be widened by the search that actually placed the
 * person rather than by the one that was asked for. See
 * `forEachMethheadNear`'s gate.
 */
interface Pool {
  bands: PedBand[];
  reach: number;
}

function anchorBands(
  field: PedestrianField,
  key: number,
  x: number,
  z: number,
  radius: number,
  backstreets: boolean,
  out: PedBand[],
  rescueMax = 0,
): Pool {
  let entry = poolCache.get(field);
  if (entry === undefined || entry.gen !== field.generation) {
    entry = { gen: field.generation, byKey: new Map() };
    poolCache.set(field, entry);
  }
  const cached = entry.byKey.get(key);
  if (cached !== undefined) return cached;
  let reach = radius;
  field.near(x, z, reach, out);
  // Doubling rather than stepping, so the common case costs one grid walk and
  // the starved case costs four. `catchmentBands`' loop, with the pool size
  // that matters here being one -- a suburb with a single band under it can
  // still stand its loiterer somewhere, and widening past that would move
  // people who already have a street for no reason.
  while (out.length === 0 && reach < rescueMax) {
    reach = Math.min(reach * 2, rescueMax);
    field.near(x, z, reach, out);
  }
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
  const pool: Pool = { bands, reach };
  entry.byKey.set(key, pool);
  return pool;
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

/**
 * The arc length of the point on `band` closest to `(x, z)`, and how far that is.
 *
 * **The whole of the drunk-placement fix, in one function**, and what it
 * replaces is worth writing down because the bug was invisible in the code and
 * enormous in the world.
 *
 * `poseDrunk` used to pick a band near the venue and then call `pointOnBand`
 * with a *uniform* fraction -- a spot anywhere along the whole thing. That reads
 * as harmless until you remember what a band is: not "the bit of footpath
 * outside the pub" but an entire OSM way's kerb, which on King Street is most of
 * a kilometre. `anchorBands` selects on the band's **bounding box**, so a pub
 * whose corner clips the end of a long way got the whole way to stand on, and
 * the drunk was dropped uniformly along it.
 *
 * Measured against the built city, before this existed: the median drunk stood
 * **58 m** from the pub they were supposedly drinking outside, the 90th
 * percentile 123 m and the furthest **291 m** -- around a corner, down a
 * residential street, nowhere near a licenced premises. The 502 drunks were not
 * missing, they were *smeared* off the pub strips into the back streets, one
 * every hundred metres of nothing, which is exactly the report: you walk a road
 * lined with pubs and meet nobody.
 *
 * The fix is to project the venue onto the band and stand there, so the answer
 * to "which spot on this footpath" is "the one out the front". The search is a
 * point-to-segment over `count - 1` segments, run once per drunk per query, and
 * the bands are already the small cached pool `anchorBands` returns.
 */
function nearestOnBand(band: PedBand, x: number, z: number): { s: number; d2: number } {
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
  return { s: bestS, d2: best2 };
}

/**
 * How far from a venue a footpath still counts as that venue's frontage, metres.
 *
 * Was a literal 45 inside `poseDrunk`. It is a named constant now because
 * `DRUNK_REACH` is derived from it and the derivation has to be visible: change
 * this and the query gate moves with it instead of silently going wrong.
 */
const VENUE_BAND_RADIUS = 45;

/**
 * How far along the frontage a drunk drifts from the projected point, metres.
 *
 * Twelve metres either way is the width of a pub's footpath frontage plus a bit
 * -- enough that a venue's two or three do not stand in a stack, small enough
 * that all of them are recognisably *at that pub*. It is drift along the kerb,
 * not a radius: the lateral offset is `lean`, and it is half a metre.
 */
const DRUNK_SPREAD = 12;

/**
 * The guaranteed gap between two drunks of the same venue, metres along the
 * kerb -- and the number the **renderer's** `CLAIM_SNAP` is derived from.
 *
 * It exists because of what pairs an ambient to its promoted actor. The
 * renderer has no identity to match on -- `protocol.NPC_BYTES` does not carry an
 * actor's home -- so it claims the ambient the actor is standing *on* and then
 * holds that claim by key. The claim is only unambiguous while no second
 * ambient is inside the snap, so the sim owes the renderer a floor on how close
 * two of one pub's drinkers can ever be, and this is it.
 *
 * The dependency runs one way, sim to renderer, which is why the constant lives
 * here and `CLAIM_SNAP` is half of it rather than the two being tuned apart.
 * Getting this wrong is what "the drunks teleport when I get close to them"
 * was: two ambients inside the snap, the wrong one hidden, and the pairing
 * changing its mind between frames.
 *
 * The slot layout in `poseDrunk` yields a gap of at least half a slot, so a
 * venue needs `2 * count * DRUNK_MIN_GAP` of frontage to hold its people --
 * 15 m for a pub with three, which is a normal shopfront and is why the filter
 * costs so few venues.
 */
export const DRUNK_MIN_GAP = 2.5;

/**
 * How many of the frontage candidates a drunk picks between.
 *
 * A corner hotel has a footpath on two streets and both are correct, so the
 * choice is real rather than decorative; past the nearest three it stops being
 * a frontage and starts being the next street over.
 */
const FRONTAGE_CHOICES = 3;

/**
 * The furthest a drunk can possibly stand from their venue, metres -- **derived,
 * not measured**, and `forEachDrunkNear`'s broadphase gate is exactly this.
 *
 * The other half of the bug above, and it is the half that dropped people from
 * the world outright. The gate used to be a literal `60 + radius` against the
 * *venue's* position while the placement had no bound at all, so a drunk who was
 * genuinely thirty metres in front of you but whose pub was two hundred metres
 * behind you was **never returned by the query** -- not drawn, not promoted, not
 * there. Measured across 2,700 footpath points before the fix: 116 of 1,490
 * drunk sightings at the 150 m draw radius and 34 of 219 at 60 m were silently
 * dropped, 8% and 16%.
 *
 * With the projection, a placement is at most `VENUE_BAND_RADIUS` from the
 * venue plus `DRUNK_SPREAD` of drift along the kerb (arc length, so never less
 * than the straight line it covers), plus the lean and the sway. The margin
 * covers those last two with room to spare, and `checkStreetlife` asserts the
 * bound holds over every drunk in the built city rather than trusting it.
 */
const DRUNK_STAND_MARGIN = 2;
export const DRUNK_REACH = VENUE_BAND_RADIUS + DRUNK_SPREAD + DRUNK_STAND_MARGIN;

/**
 * `poseDrunk`'s frontage shortlist. Module-level and reused, on `scanBands`'
 * own argument: `poseDrunk` is called for every drunk in the draw radius on
 * every frame and on every authority tick, and it must allocate nothing.
 *
 * Not re-entrant, and does not need to be: nothing in this file calls
 * `poseDrunk` from inside a `poseDrunk` visit.
 */
const frontD2 = new Float64Array(FRONTAGE_CHOICES);
const frontS = new Float64Array(FRONTAGE_CHOICES);
const frontBand: Array<PedBand | null> = new Array(FRONTAGE_CHOICES).fill(null);

/** A drunk's sway: slower and smaller than a pace, and lateral rather than along. */
export const SWAY_AMPLITUDE = 0.16;
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
  let pool = anchorBands(peds, carHash(seed, index ^ 0x11a3), px, pz, LOITER_REACH, true, scratch);
  // Set only by the rescue rung below, never by the two tight ones. An explicit
  // flag rather than comparing `pool.reach` to `spread` at the placement, so
  // that this cannot start meaning something else if `SPREAD_MIN` ever drops
  // under `LOITER_REACH`.
  let rescued = false;
  if (pool.bands.length === 0) {
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
    //
    // And this rung widens too, out to `METH_RESCUE_MAX`, because the suburb's
    // own spread is not always enough either: a `place=suburb` node lands where
    // the label belongs, which out west is regularly a paddock, a runway or the
    // middle of Brisbane Water. See `METH_RESCUE_MAX` for the measurement. The
    // widening is inside `anchorBands` rather than a second call here so that
    // the pool cache holds one entry per anchor and the *reach* that found it,
    // which is what `forEachMethheadNear` gates on.
    pool = anchorBands(peds, seed, s.x, s.z, spread, true, scratch, METH_RESCUE_MAX);
    rescued = pool.reach > spread;
  }
  const bands = pool.bands;
  if (bands.length === 0) return false;
  const band = bands[h % bands.length];
  if (rescued) {
    // --- Rescued, and therefore **projected rather than dropped uniformly**.
    //
    // A band is a whole OSM way clipped to a tile, so it can be most of a
    // kilometre long, and `near` selects on its *bounding box*. Taking a
    // uniform fraction of a band found 1.4 km away puts somebody an unbounded
    // distance from the suburb that owns them: measured before this branch
    // existed, the worst rescued loiterer stood **1,921 m** from their
    // centroid, at Ku-ring-gai Chase. That is the same bug `nearestOnBand`'s
    // header describes for the drunks, and it costs the same two things -- a
    // person standing nowhere near what they belong to, and a broadphase gate
    // that can no longer be derived, so `forEachMethheadNear` silently deletes
    // them.
    //
    // So the rescue stands them at the point on the band closest to the suburb,
    // plus a hashed stroll of at most `LOITER_REACH` along the kerb. What that
    // buys is a *derivable* bound -- `METH_REACH`, which is where the search
    // could have found a band plus that stroll -- rather than "the length of
    // the longest band in Sydney", which is not a number this file can know.
    //
    // Only on the rescued path. The two tight rungs keep the uniform fraction
    // they shipped with, so no loiterer who is placed today moves.
    const at = nearestOnBand(band, s.x, s.z).s +
      (((carHash(h, 0x51ab) % 2001) - 1000) / 1000) * LOITER_REACH;
    const clamped = at < 0 ? 0 : at > band.length ? band.length : at;
    pointOnBand(band, band.length > 1e-6 ? clamped / band.length : 0, out);
  } else {
    pointOnBand(band, (carHash(h, 0x51ab) % 4096) / 4096, out);
  }

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
  // No rescue rung here, deliberately. A drunk stands outside *their own pub*,
  // and `DRUNK_REACH` is derived from `VENUE_BAND_RADIUS` -- widening the search
  // would put somebody outside the wrong pub and would silently break the bound
  // `forEachDrunkNear` gates on. A pub with no frontage carries nobody.
  const bands = anchorBands(peds, seed, vx, vz, VENUE_BAND_RADIUS, false, scratch).bands;
  if (bands.length === 0) return false;
  const h = carHash(seed, index ^ 0x63d7);

  // --- The frontage: the nearest `FRONTAGE_CHOICES` bands **by their closest
  // point** rather than by their bounding box, which is the distinction the old
  // placement missed entirely. See `nearestOnBand`.
  //
  // A band whose closest point is further than `VENUE_BAND_RADIUS` is not this
  // pub's frontage however near its box came -- it is a long way that happens to
  // pass by -- and it is dropped rather than stood on. That is what makes
  // `DRUNK_REACH` a bound and not a hope. A venue whose every candidate fails
  // contributes nobody, exactly as one with no band at all does: ten of the 263
  // pubs that carry a drunk, which is the bar inside the shopping centre again.
  //
  // No allocation: the candidates are two parallel scratch arrays, module-level,
  // because this runs for every drunk in the draw radius sixty times a second.
  const count = venueDrunks(venue) || 1;
  let picked = 0;
  for (const band of bands) {
    const near = nearestOnBand(band, vx, vz);
    if (near.d2 > VENUE_BAND_RADIUS * VENUE_BAND_RADIUS) continue;
    // A frontage without room to stand this venue's drinkers along is not a
    // frontage for them. The test is the room **either side of the projection**
    // rather than the band's total length, because the window below is centred
    // on the pub: a long way whose far end is 300 m up the road is no use if the
    // pub sits five metres from where it starts. See `DRUNK_MIN_GAP` -- without
    // this the slots collapse onto the end of a stub of footpath and two men
    // stand in each other, measured at 14 of 297 pairs, the closest 1 cm apart.
    if (
      Math.min(DRUNK_SPREAD, near.s) + Math.min(DRUNK_SPREAD, band.length - near.s) <
      2 * count * DRUNK_MIN_GAP
    ) {
      continue;
    }
    // Insertion sort into the top `FRONTAGE_CHOICES` by distance. The band index
    // is the tie-break, and the pool `anchorBands` returns is already in a total
    // order, so two processes rank identically.
    let at = picked;
    while (at > 0 && frontD2[at - 1] > near.d2) {
      if (at < FRONTAGE_CHOICES) {
        frontD2[at] = frontD2[at - 1];
        frontS[at] = frontS[at - 1];
        frontBand[at] = frontBand[at - 1];
      }
      at--;
    }
    if (at < FRONTAGE_CHOICES) {
      frontD2[at] = near.d2;
      frontS[at] = near.s;
      frontBand[at] = band;
    }
    if (picked < FRONTAGE_CHOICES) picked++;
  }
  if (picked === 0) return false;

  // The frontage is the **venue's**, not the drunk's, and that is load-bearing
  // rather than tidy. A corner hotel has a footpath on two streets and picking
  // per-drunk put one of them round the corner from the other -- which reads
  // fine and breaks the slot layout below, because two drunks on two different
  // bands have no shared arc length to be spaced along and can land on the same
  // half metre where the bands cross. Measured: 8 pairs standing inside a metre
  // of each other, every one of them a corner. One frontage per venue makes the
  // spacing a guarantee instead of a hope, and the variety survives across
  // venues rather than inside one.
  const chosen = carHash(seed, 0x5c1f) % picked;
  const band = frontBand[chosen]!;
  // --- Drift along the kerb from the projected point, **by slot**.
  //
  // A venue's drunks share a frontage, so a free hash on both would sometimes
  // put two of them in the same half metre -- measured at 11 of the 160 venues
  // that carry more than one, which is two blokes standing inside each other.
  // Each index gets its own share of the spread and jitters inside the middle
  // half of it, which leaves a guaranteed gap between neighbours and still looks
  // unplanned. Clamped to the band afterwards, and the clamp only ever brings
  // them *closer* to the projection -- so `DRUNK_REACH` still bounds it.
  //
  // The gap is what the renderer's `CLAIM_SNAP` is sized against: an actor is
  // promoted standing exactly on its own ambient, so the claim is unambiguous
  // only while no *other* ambient is within the snap.
  //
  // The window stays **centred on the pub** and shrinks to fit, which is the
  // difference between a guarantee and a near miss -- and the two wrong answers
  // either side of it are both worth naming. Clamping each drunk independently,
  // which this did first, collapses every slot that overran the end onto the
  // same endpoint and stands two men in the same half metre. Sliding the whole
  // window inward instead keeps them apart but walks them up to twelve metres
  // off the pub they are drinking outside, which cost eight points of "standing
  // at their own pub" and is the thing the frontage fix existed to buy.
  //
  // So the window takes whatever room the band gives it on each side, up to
  // `DRUNK_SPREAD`, and is **not** required to be symmetric: insisting on that
  // orphaned every corner pub whose frontage begins at the corner, 25 venues
  // against 10. The candidate filter above has already guaranteed the two sides
  // add up to room for the whole party.
  const centre = frontS[chosen];
  const before = Math.min(DRUNK_SPREAD, centre);
  const after = Math.min(DRUNK_SPREAD, band.length - centre);
  const slot = (before + after) / count;
  const jitter = ((carHash(h, 0x9e17) % 4096) / 4096) * slot * 0.5;
  const s = centre - before + index * slot + slot * 0.25 + jitter;
  pointOnBand(band, band.length > 1e-6 ? s / band.length : 0, out);

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
    //
    // **Floored at `METH_RESCUE_MAX + LOITER_REACH`**, which is the bound
    // `poseMethhead`'s rescue branch is written to satisfy: a rescued loiterer
    // stands at the point on their band nearest the suburb, plus at most
    // `LOITER_REACH` of stroll along the kerb. A gate tighter than the search
    // that placed somebody deletes them from the query -- not "does not draw
    // them", *deletes* them, because this is the only enumeration there is --
    // which is exactly the bug `DRUNK_REACH`'s header describes one tier over.
    //
    // It is a broadphase and nothing else, so being generous costs one squared
    // distance per suburb and a cached pool lookup, while being tight costs a
    // person. Measured against the built city at the spawn, the whole ambient
    // placement inside 150 m is 0.019 ms a frame against a 4 ms budget.
    // `METH_REACH` subsumes the old term rather than sitting beside it: at
    // `SPREAD_MAX` the tight rungs reach 581 m and this is 2,081 m, so one
    // constant covers both rungs and there is one derivation to keep honest.
    const gate = METH_REACH + radius;
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
  // A venue's drunks stand within `DRUNK_REACH` of it -- **derived from the
  // placement rather than guessed at**, which is the whole point of the
  // constant: this was a literal 60 against an unbounded placement, and it
  // dropped one drunk in six at pub-front range. Four hundred and twenty-two
  // squared distances is one pass over a flat array of numbers -- cheaper than
  // the grid walk a spatial index would need for a set this size.
  const gate = DRUNK_REACH + radius;
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
 *   - **Anything else asks its own registration**, through the optional
 *     `NpcKindDef.strikeReason` hook, and gets the framework's answer --
 *     `REASON.ASSAULT` -- when it has no opinion. That last clause is the one
 *     line of this function that has changed since it shipped, and it changed
 *     for `game/characters.ts`: five more kinds landed, one of which (the real
 *     estate agent) needs a different sentence on the banner. The alternative
 *     was five more names in the two `if`s above, which would have made a file
 *     the meth heads own into a registry of everybody else's crimes. See
 *     `factions.NpcKindDef.strikeReason`.
 */
export function strikeCrime(actor: NpcActor): number {
  if (actor.kind === NPC_KIND.METHHEAD) return REASON.NONE;
  if (actor.kind === NPC_KIND.DRUNK) {
    return actor.target < 0 && actor.state !== NPC_STATE.DOWN ? REASON.ASSAULT : REASON.NONE;
  }
  const def = npcKind(actor.kind);
  if (def?.strikeReason) return def.strikeReason(actor);
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
  if (SUBURBS.length <= SUBURB_INNER_COUNT) {
    failures.push(
      `Only ${SUBURBS.length} suburbs are baked and the frozen inner ring is ${SUBURB_INNER_COUNT} of them; ` +
        'the crime table is meant to cover the extent, and the middle ring would carry nobody.',
    );
  }
  if (VENUE_COUNT <= VENUE_INNER_COUNT) {
    failures.push(
      `Only ${VENUE_COUNT} venues are baked and the frozen inner ring is ${VENUE_INNER_COUNT} of them; ` +
        'every pub outside the old ring would have nobody outside it.',
    );
  }
  // --- The frozen prefixes, from the other end.
  //
  // The inner ring's invariance is not a comment, it is these two loops. A row
  // inserted into or reordered inside either prefix changes `suburbSeed`'s
  // neighbours, `streetKey`'s anchor index and `VENUE_DRUNKS`' whole array --
  // none of which is visible from the table and all of which a player in
  // Newtown would see. Every frozen row is still inside the ring it was baked
  // in; anything past the prefix is the middle ring and is allowed out there.
  for (let i = 0; i < SUBURB_INNER_COUNT && i < SUBURBS.length; i++) {
    const s = SUBURBS[i];
    const d = Math.sqrt(s.x * s.x + s.z * s.z);
    if (d > STREET_INNER_EXTENT_M) {
      failures.push(
        `Row ${i} of the frozen suburb block is ${s.name} at ${d.toFixed(0)} m, outside the ` +
          `${STREET_INNER_EXTENT_M} m bake it came from. The block has been reordered.`,
      );
    }
  }
  for (let v = 0; v < VENUE_INNER_COUNT && v < VENUE_COUNT; v++) {
    const x = VENUE_XZ[v * 2];
    const z = VENUE_XZ[v * 2 + 1];
    if (x * x + z * z > STREET_INNER_EXTENT_M * STREET_INNER_EXTENT_M) {
      failures.push(
        `Venue ${v} is at (${x}, ${z}), outside the ${STREET_INNER_EXTENT_M} m ring the frozen block was ` +
          'baked in. The packed table has been reordered and every drunk in the inner city has moved.',
      );
      break;
    }
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
    failures.push(`Only ${VENUE_COUNT} venues are baked; the extract found 875 inside the extent.`);
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
