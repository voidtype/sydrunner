/**
 * Where the world intersects itself, counted by pair of populations.
 *
 *     bun run server/clash-check.ts
 *     bun run server/clash-check.ts --worst 20
 *     bun run server/clash-check.ts --near -300,-1100 --radius 1200
 *     bun run server/clash-check.ts --sample 8       (every 8th tile, for a sweep)
 *     bun run server/clash-check.ts --kerb-inset 1.5 (the fence audit's terms)
 *
 * The round report -- the table, and which pipeline pass would remove each of
 * the three worst rows -- is `docs/CLASH-ROUND.md`. DEPLOY.md §B step 2 is where
 * this sits in the runbook.
 *
 * ---------------------------------------------------------------------------
 * ## The report this exists for
 *
 * The owner, on the shipped build:
 *
 *   > *"The world overlaps with itself a lot, like the different 3d models
 *   > intersect everywhere all the time"*
 *
 * That is one sentence and it is not one defect. It is the *sum* of a dozen
 * defects that have nothing in common except where the player stands, and the
 * only way to answer it is to stop treating it as a sentence and turn it into a
 * table: which two populations are inside each other, how often, and how badly.
 * A single number here would be useless -- 300,000 tree-in-building hits and
 * 300,000 car-in-car hits are two completely different rounds of pipeline work,
 * and a total that mixed them would send whoever reads it at the wrong one.
 *
 * So this file is **twelve checks that share a tile loop**, each with its own
 * predicate, its own budget and its own control. Nothing here fixes anything;
 * `undrawn-solids-check.ts` and `overpass-clearance-check.ts` are the family and
 * this is the third member, on the same terms: read the shipped bytes, ask a
 * question with no tag in it, print counts with worst examples, ratchet with a
 * budget constant, and end on a control that proves the scan can convict.
 *
 * ---------------------------------------------------------------------------
 * ## What it reads, and why it never opens a `.glb`
 *
 * The 5.7 GB of tile `.glb` in this build is the one file family this
 * deliberately does not touch, and dropping it is what puts a whole-world run at
 * **622 s** over 22,928 tiles instead of an hour. It is not a compromise,
 * because for every population here the *authored* geometry is somewhere
 * cheaper:
 *
 *   - **Buildings and decks**: `collision/<key>.bin`, through the real
 *     `CollisionWorld.addTile` with the index's own `b`. The pipeline's contract
 *     is `tiles.write_collision`'s -- *"THE COLLISION POLYGON IS THE DRAWN
 *     POLYGON"* -- so the ring in that file is the footprint a player sees, and
 *     `Prism.structural` is the same positional split both authorities use: the
 *     records ahead of the last `b` are decks, viaducts, parapets and landmark
 *     podiums, and the rest are buildings.
 *   - **Trees, poles, bins, blades, signals, parked cars, water**: their own
 *     sidecars, through the same decoders `decode.worker.ts` and
 *     `world/cars.ts` run. Every one of these is an *instance list* -- a
 *     position and a size -- so the drawn object is recoverable exactly, and a
 *     mesh would tell us nothing the row does not.
 *   - **The ground**: `<key>.terr.bin`, sampled bilinearly. That sampling was
 *     validated rather than assumed: over 60,000 poles the terrain read here
 *     agrees with `TilePower.groundY` -- which the pipeline wrote from its own
 *     DEM -- to a mean of **18 mm**, and the mirrored row order disagrees by
 *     6.9 m. Row 0 is the northern edge, and there is now a measurement that
 *     says so; `runControls` repeats it every run over 2,000 poles, because a
 *     grid that transposed would turn two of these pairs into noise silently.
 *
 *     **It is bilinear and the client draws triangles, and the two are not the
 *     same surface.** `water._wet_pieces` says it in as many words -- *"a sheet
 *     spanning a whole 31.25 m cell would carry a depth that is the bilinear
 *     interpolation of its corners while the ground under it is two flat
 *     triangles"* -- and the gap between them peaks at the cell centre, at a
 *     quarter of the cell's own diagonal curvature. Bilinear is used anyway
 *     because it is what `TilePower.groundY` agrees with to 18 mm and what
 *     `undrawn-solids-check.sampleGround` already reads, so the two audits
 *     answer "where is the ground" the same way. The consequence is stated
 *     rather than corrected: `DECK_UNDER_TERRAIN` and `WATER_OVER_TERRAIN` both
 *     carry thresholds (1.0 m and 0.5 m) set well over that residue, and a
 *     disagreement under a metre on a rough cell is not evidence of anything.
 *   - **The railway**: `rail/rail.bin` and `world/track-atlas.ts`, exactly as
 *     `server/rail-gauge-check.ts` reads them.
 *
 * ---------------------------------------------------------------------------
 * ## The twelve pairs, and why these twelve
 *
 * Each is a plan-and-height test that a player would see as one object standing
 * inside another. They are grouped by *which pipeline pass would remove them*,
 * because that is what a round is planned from:
 *
 *   1.  `TREE_IN_BUILDING`      a stem inside a footprint
 *   2.  `FURNITURE_IN_BUILDING` a pole, bin, blade post or signal inside one
 *   3.  `FURNITURE_ON_ROAD`     the same four standing in a live carriageway
 *   4.  `CAR_IN_BUILDING`       a parked car's body box inside a footprint
 *   5.  `CAR_IN_CAR`            two parked cars in the same bay
 *   6.  `BUILDING_IN_BUILDING`  two footprints overlapping in plan
 *   7.  `DECK_IN_BUILDING`      a deck or viaduct through a building
 *   8.  `DECK_UNDER_TERRAIN`    a deck whose whole solid is inside the hill
 *   9.  `RAIL_GAUGE`            anything baked, inside the volume a train sweeps
 *   10. `STATION_IN_BUILDING`   a station room or access incline inside one
 *   11. `WATER_OVER_TERRAIN`    a sheet whose bed and the shipped ground differ
 *   12. `BUILDING_UNDER_WATER`  a footprint standing under a water surface
 *
 * **The grouping is by fix and not by object**, which is why poles and street
 * furniture share two rows rather than having four: `power.py` and
 * `furniture.py` place their four kinds by the same rule against the same
 * footpath, and the keep-out that would clear one clears all of them, so
 * splitting them would be four rows one commit closes together. For the same
 * reason "a deck inside the world" is *two* rows: a deck through a building is
 * the clearance envelope and a deck inside the hill is the DSM under
 * `decks.py`'s own solve, and one number over the two would send whoever reads
 * it at the wrong file. The kind breakdown is printed under each row, so a
 * grouping that turns out to be wrong is visible without changing the pairs.
 *
 * ---------------------------------------------------------------------------
 * ## What is deliberately not counted
 *
 *   - **Adjacency.** Two terraces sharing a party wall are not a defect, and a
 *     quantised ring is 5 mm wide of where the wall is. `MIN_OVERLAP_M2` and
 *     `OVERLAP_FRACTION` are both required, so a pair only counts when the
 *     overlap is real area *and* a real share of the smaller building.
 *   - **Anything drawn over open air.** A tree under a viaduct, a bin under an
 *     awning, a car under a flyover: a structural prism is a soffit with room
 *     under it (`collision.Prism.structural`) and nothing here treats one as a
 *     building.
 *   - **The kerb line's own slop.** `KERB_INSET_M` is how far inside a
 *     carriageway edge a post has to stand before it is in the road rather than
 *     on the line that says where the road stops.
 *   - **A landmark's own kit.** `landmarks.glb` is not opened; its podium
 *     prisms are in `collision/` and are structural, so they take part as decks
 *     and not as buildings.
 *
 * ---------------------------------------------------------------------------
 * ## Every budget is a ratchet, and this round set every one of them
 *
 * `undrawn-solids-check.ts`' rule, twelve times: each `BUDGET_*` is what the
 * shipped bake measures on the day it was written plus nothing, and it is a
 * fence and not a target. Whoever lowers a measurement lowers its budget with
 * it. **Raising one is how a handful becomes a hundred with nobody noticing**,
 * and with twelve of them side by side that is easier to do quietly than
 * anywhere else in this family -- so a raise wants the same sentence in the
 * commit that a new measurement gets.
 *
 * ---------------------------------------------------------------------------
 * ## The controls, and why there are twelve of those too
 *
 * `cli.cmd_station_clear_audit`: *"Zero there means the envelope is empty or the
 * test is blind, and either way the pass above means nothing"*. Three of these
 * pairs measure 1, 2 and 29 over populations in the millions -- which is either
 * a pipeline pass that works or a predicate that does not run, and the table
 * cannot tell those apart. So each predicate is written as a **pure function of
 * synthetic inputs** and `runControls` drops a made-up offender through the real
 * one and asserts it is named.
 *
 * **And, where the distinction is the whole point, it drops the *legal* case
 * through too and asserts it is not**, because a control that could only ever
 * convict proves only that the arithmetic runs. A party wall against a real
 * overlap, a post on the kerb against a post in the road, two cars nose to tail
 * against two in one bay, a square in an L's notch against a square inside a
 * square, an object 4 m from a running line against one standing on it. Two of
 * them go further and exercise the *shipped* data rather than a synthetic: a
 * post dropped on a real running line's own midpoint must be found by the real
 * rail index, and the terrain read is re-validated every run against 2,000
 * poles' own `groundY`. Between them those are the two failures that would make
 * this whole file quietly measure nothing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CollisionWorld, type Prism } from '../client/src/player/collision.ts';
import {
  decodeVegetation,
  decodePower,
  decodeFurniture,
  decodeWater,
  decodeStreetNames,
  translateStreetNames,
  type TileWater,
} from '../client/src/world/tile-decode.ts';
import { decodeCars, STATIC_CAR_CLEARANCE_Y } from '../client/src/game/staticcars.ts';
import { CAR_BODY_SIZE } from '../client/src/game/traffic.ts';
import { decodeLanes } from '../client/src/game/traffic.ts';
import { decodeRail, SPAN_TUNNEL, SPAN_DEEP, type RailBake } from '../client/src/game/rail.ts';
import { buildTrackAtlas, ownsAlignment } from '../client/src/world/track-atlas.ts';
import { buildStationBoxes, BOX_HEADROOM_M, type StationBox } from '../client/src/game/riding.ts';
import {
  CAR_BODY_HALF_M,
  CAR_BODY_FLOOR_M,
  CAR_BODY_ROOF_M,
  STRUCTURE_MARGIN_M,
} from '../client/src/world/envelope.ts';

// =====================================================================================
// The budgets. One per pair, each a ratchet, every one of them set by the
// whole-build run of 2026-09-07 over `index.built` 1788586540 -- 22,928 tiles,
// 622 s, 17,433,402 stems, 808,701 furniture, 1,398,902 parked cars, 1,297,775
// buildings, 72,021 structures and 7,623,838 water vertices. See the header:
// every one is a fence and none is a target.
// =====================================================================================

/**
 * Stems standing inside a building's own footprint.
 *
 * **718, and every one of them is a surveyed tree**, which is not a guess: the
 * street placer's `_position_is_clear`, the park scatter and the bush scatter
 * all test `_streets.buildings_near` at `vegetation.CLEAR_OF_BUILDING`, and
 * shapely's `poly.distance(p)` is 0 for a point inside the polygon, so a
 * procedural stem inside a footprint is not expressible. The one source with no
 * building keep-out is the `natural=tree` node, which the module states is
 * *"never moved, never thinned and never overridden"*. 718 of 17.4 million.
 */
export const BUDGET_TREE_IN_BUILDING = 718;

/**
 * Poles, bins, blade posts and signal heads standing inside a footprint.
 *
 * 29 of 808,701, and the number is small for a reason worth recording rather
 * than passing over: `furniture._blocked_at` and `power._blocked_at` both carry
 * a building keep-out and both work. This row is the control on the row below.
 */
export const BUDGET_FURNITURE_IN_BUILDING = 29;

/**
 * ...and the same four standing inside a live carriageway.
 *
 * **14,562, and neither placer has a carriageway keep-out at all** --
 * `furniture._blocked_at` tests junction, pole, tree and building, and
 * `power._blocked_at` the same list. Each item is set outside *its own* way's
 * kerb by construction, and `lanes.py` and `streets._half_width` compute the
 * identical `0.5 * clamp(width)`, so a same-way offender is not expressible
 * either. Every one of these is inside a **different** way's carriageway. The
 * proof is in the table: `furniture.BIN_CLASSES` is
 * `{residential, unclassified, living_street, tertiary}` and bins are reported
 * standing in `primary` and `service` carriageways, which their own placer will
 * not put them on.
 */
export const BUDGET_FURNITURE_ON_ROAD = 14562;

/**
 * Parked cars whose body box is inside a building footprint.
 *
 * One, of 1,398,902. `parking._place` tests `buildings_near(p.buffer(BAY_RADIUS))`
 * at the footprint's *circumradius* rather than its half-length, and its own
 * comment says why -- *"a 2.7 m circle leaves the four corners of the bay
 * outside it, and a wall sitting in that crescent slips through"*. It holds.
 */
export const BUDGET_CAR_IN_BUILDING = 1;

/**
 * Pairs of parked cars in the same bay.
 *
 * Two, of 1,398,902, and both are seam cases: `parking._clear_of_each_other`
 * runs per tile over `instances(tile_key)`, so a pair straddling a tile line is
 * the one thing its easting-window scan cannot see. That this file finds exactly
 * two is the strongest evidence in the table that its own pair walk is right.
 */
export const BUDGET_CAR_IN_CAR = 2;

/**
 * Pairs of building footprints that genuinely overlap in plan.
 *
 * 4,850, and the top of the table is **exact duplicates** -- `61,572 m2 shared
 * of 61,572 m2`, twice, which is one footprint mapped twice. `merge.merge()`
 * deduplicates Microsoft against OSM at `OVERLAP_FRACTION` 0.35 and takes the
 * OSM list whole: `out = [_from_osm(b) for b in osm_buildings]`, unconditionally.
 * Nothing in the build compares OSM against OSM.
 */
export const BUDGET_BUILDING_IN_BUILDING = 4850;

/**
 * Decks, viaducts and parapets whose solid passes through a building.
 *
 * 513. `elevated.ROAD_CLEARANCE_M` lifts a *building* over a road; nothing lifts
 * a road over a building, and `decks._crossing_demand` reads carriageways only.
 */
export const BUDGET_DECK_IN_BUILDING = 513;

/**
 * Decks whose whole solid is under the terrain that is drawn over them.
 *
 * 34, and they are **one deck**: every one of the twelve worst is within four
 * metres of (501, -1204), because `decks.prisms` emits one prism per segment and
 * a buried run buries all of them. A count of prisms, not of places.
 */
export const BUDGET_DECK_UNDER_TERRAIN = 34;

/**
 * Baked instances standing inside the volume a train sweeps.
 *
 * 222: 183 decks, 12 parked cars, 10 poles, 9 buildings, 5 bins, 2 posts and a
 * signal. `vegetation.py` is the only one of these placers that asks
 * `railenv.in_corridor`, and it is the only population absent from the list.
 */
export const BUDGET_RAIL_GAUGE = 222;

/**
 * Station rooms and access inclines whose plan is inside a building.
 *
 * ---------------------------------------------------------------------------
 * **The Queen Victoria Building is not this defect and the first version of
 * this pair convicted it.** `buildStationBoxes` builds a box only for an
 * underground station, and `railenv.StationEnvelope.surface` deliberately keeps
 * those out of `_clear_stations` in as many words: *"Town Hall's box is a volume
 * between the platform and the footpath over it, and a building at the footpath
 * stands on its **ceiling** -- so a plan test against the box deletes the Queen
 * Victoria Building for standing over the Metro"*. A plan-plus-band test with no
 * margin reads a building resting on the lid as a building inside the room,
 * because its pad *is* the lid.
 *
 * So the band test takes `riding.BOX_HEADROOM_M` off the ceiling -- the same
 * 1.5 m `StationBoxField.floorAt` uses to decide *"above `ceilY -
 * BOX_HEADROOM_M` you are in the street over Town Hall"*. A building whose pad
 * is above that line is in the street; below it, it is in the concourse.
 *
 * With that margin in, 65 -- Wynyard, Crows Nest, Edgecliff, Cherrybrook,
 * St Leonards, Hills Showground, North Sydney, Bondi Junction, Kings Cross.
 * Every one of them is a station `_clear_stations` never looked at, because
 * `railenv.load` hands it `[s for s in self.stations if s.surface]`.
 */
export const BUDGET_STATION_IN_BUILDING = 65;

/**
 * Water vertices whose own bed and the shipped terrain disagree.
 *
 * 63,089 of 7,623,838, which is 0.83 %: 38,076 where the bed the sheet was cut
 * against is over the ground that shipped, and 25,013 where the ground stands
 * out of the water. The second half contradicts `water.py`'s own stated
 * guarantee -- *"every post inside a water polygon is at least
 * `SHORE_CLEARANCE_M` below that polygon's surface, so no ground pokes through a
 * drawn sheet"* -- and `_wet_pieces` exists to enforce it, so this is not a rule
 * nobody wrote. It is a rule enforced against one terrain and shipped beside
 * another.
 */
export const BUDGET_WATER_OVER_TERRAIN = 63089;

/**
 * Building footprints standing under a water surface.
 *
 * 400, and 399 of them are the *same* 0.80 m: a roof at world y -71.9 under a
 * surface at -71.075, which is 0.8 m below the AHD datum against sea level
 * exactly. One number repeated 399 times is a systematic footprint rather than
 * four hundred flooded houses, and the outlier -- 12.68 m under a pond at
 * (-24710, 27141) -- is the one that is not. `tiles.write_water`'s header says
 * *"The whole sheet is emitted even where a building stands on it. Nothing in
 * the extent does"*; measured, four hundred do.
 */
export const BUDGET_BUILDING_UNDER_WATER = 400;

// =====================================================================================
// The thresholds that are decisions
// =====================================================================================

/**
 * How much two footprints have to share before it is an overlap, m2.
 *
 * `envelope.MIN_PIECE_M2`, restated: the smallest piece the clearance envelope
 * will keep after a carve, so anything under it is not a piece of building in
 * this world's own terms either.
 */
export const MIN_OVERLAP_M2 = 2.0;

/**
 * ...and what share of the smaller of the two it has to be.
 *
 * **Both are required, and without the second the count is party walls.** A
 * terrace row is thirty footprints that touch along their long edges; the ring
 * is quantised to 5 mm (`index.geometry.max_position_error_mm`), the walls are
 * 200 mm thick, and a 20 m party wall overlapping by 100 mm is 2 m2 -- over the
 * absolute floor and nothing a player can see. A tenth of the smaller building
 * is a corner genuinely inside another building.
 */
export const OVERLAP_FRACTION = 0.1;

/**
 * How far inside a carriageway's edge a post has to stand to be in the road.
 *
 * The lane half width is centreline to kerb (`traffic.LaneWay.halfWidth`) and a
 * pole stands *at* the kerb by design, so a test on the bare edge would convict
 * every pole in the city on quantisation. 0.4 m is over the widest of these
 * objects' own radius -- a 240 L bin's half-diagonal is 0.47 m and it is meant
 * to be on the footpath, not straddling the kerb -- and far under a lane width.
 *
 * ---------------------------------------------------------------------------
 * **`cli.cmd_fence_road_audit` uses 1.5 m for the same question and this is
 * deliberately tighter, so the two are not in disagreement.** That check's
 * `ROAD_KERB_SLACK_M` is `checkPavedIntegrity`'s own number and it is sweeping a
 * *fence ribbon*: a continuous strip run along a property line for a whole
 * street, where the slack has to absorb every metre of disagreement between the
 * kerb the fence was drawn from and the lane graph. These four are point
 * objects placed at a computed offset from the *same centreline the lane
 * sidecar carries* -- `lanes.py` and `streets._half_width` compute the identical
 * `0.5 * clamp(width)` -- so the only slack one needs is its own radius. Set it
 * to 1.5 with `--kerb-inset` to read this pair on the fence audit's terms; the
 * round report quotes both.
 */
export const KERB_INSET_M = Number(
  (() => {
    const i = process.argv.indexOf('--kerb-inset');
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : '0.4';
  })(),
);

/**
 * How deep under the terrain a deck's own roof has to be to be buried, metres.
 *
 * The terrain grid is 31.25 m post to post (`index.terrain.post_m`), so a deck
 * crossing a cutting is sampled against a ground that is interpolated over a
 * span far wider than the deck -- half a metre of that is interpolation and not
 * a defect. A metre is the deck's running surface a body-height under the hill.
 */
export const DECK_BURIED_M = 1.0;

/**
 * How far a water sheet's own bed may sit from the shipped terrain, metres.
 *
 * A sheet carries `surface` and a per-vertex `depth`, so `surface - depth` is
 * the ground `water.tile_sheets` cut the triangle against. Over 60,000 sampled
 * vertices that number agrees with `.terr.bin` to a mean of **39 mm**, so the
 * two are the same ground and a disagreement is one of them having moved. Half
 * a metre is twelve times the agreement and under a step.
 */
export const WATER_FLOAT_M = 0.5;

/** A stem's trunk radius for the gauge test. `vegetation.ts`' butt, near enough. */
export const TRUNK_RADIUS_M = 0.2;

/**
 * The drawn sizes of the four furniture kinds, mirrored from the private
 * constants in `world/furniture.ts` and `world/power.ts`.
 *
 * Restated rather than imported because both of those files are `three`
 * geometry builders and this runs on the Bun side, which
 * `client/src/game/traffic.ts`' header forbids pulling three in behind. The
 * numbers are `SHAFT_RADIUS_BUTT`, `BIN_WIDTH`/`BIN_DEPTH`/`BIN_HEIGHT`,
 * `POST_RADIUS`/`POST_HEIGHT` and `SIGNAL_POLE_RADIUS`/`SIGNAL_POLE_HEIGHT`.
 * If they drift, this check gets a pole 5 cm too thin and nothing else.
 */
const FURNITURE_SPEC: Record<string, { radius: number; height: number }> = {
  pole: { radius: 0.16, height: 0 },     // height comes from the sidecar
  bin: { radius: 0.47, height: 1.07 },
  post: { radius: 0.0325, height: 2.72 },
  signal: { radius: 0.07, height: 4.2 },
};

/** How many offenders to keep per pair before trimming. Ten are printed. */
const KEEP_PER_PAIR = 64;

// =====================================================================================
// Options
// =====================================================================================

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const WORST = Number(flag('worst', '10'));
const NEAR = flag('near', '');
const RADIUS = Number(flag('radius', '600'));
/** Take every Nth tile. A scoped run; it cannot move a ratchet. See the verdict. */
const SAMPLE = Math.max(1, Number(flag('sample', '1')));
/**
 * Was a threshold moved on the command line?
 *
 * A run with a hand-set `--kerb-inset` is measuring a *different question* from
 * the one the budgets were set against, so it is treated exactly as `--near` is
 * and cannot gate. Without this the flag is a way to pass the check by widening
 * the definition of the road, which is the failure mode every budget in this
 * family is written to refuse.
 */
const TUNED = process.argv.includes('--kerb-inset');
const ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
const RAIL_PATH = process.env.SYDNEY_RAIL ?? new URL('../client/public/rail/rail.bin', import.meta.url).pathname;

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// =====================================================================================
// Geometry. Every one of these is a pure function; the controls call them directly.
// =====================================================================================

/** Signed-area magnitude of a flat `[x, z, ...]` ring. `undrawn-solids-check.polyArea`. */
export function polyArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/** Is `(x, z)` inside the ring? Even-odd. `undrawn-solids-check.inRing`. */
export function inRing(pts: ArrayLike<number>, x: number, z: number): boolean {
  let hit = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2];
    const zi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const zj = pts[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * Sutherland-Hodgman: the part of `subj` inside the **convex** `clip`.
 *
 * `undrawn-solids-check.clipPoly`, and the same precondition applies -- the clip
 * has to be convex. Here it is always a quad (a carriageway span, a car body, an
 * oriented station box) or a triangle, and the subject may be concave.
 */
export function clipPoly(subj: number[], clip: number[]): number[] {
  let out = subj;
  const m = clip.length / 2;
  for (let e = 0; e < m && out.length > 0; e++) {
    const ax = clip[e * 2];
    const az = clip[e * 2 + 1];
    const bx = clip[((e + 1) % m) * 2];
    const bz = clip[((e + 1) % m) * 2 + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const next: number[] = [];
    const n = out.length / 2;
    for (let i = 0; i < n; i++) {
      const px = out[i * 2];
      const pz = out[i * 2 + 1];
      const qx = out[((i + 1) % n) * 2];
      const qz = out[((i + 1) % n) * 2 + 1];
      const sp = ex * (pz - az) - ez * (px - ax);
      const sq = ex * (qz - az) - ez * (qx - ax);
      if (sp >= 0) next.push(px, pz);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push(px + (qx - px) * t, pz + (qz - pz) * t);
      }
    }
    out = next;
  }
  return out;
}

/** A ring wound counter-clockwise, which is `clipPoly`'s precondition on the clip. */
export function ccw(p: number[]): number[] {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  if (a >= 0) return p;
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

/**
 * How much of the concave `a` is inside the convex `b`, m2.
 *
 * Only ever called with a convex `b` -- see `clipPoly`. A footprint pair goes
 * through `overlapArea` below, which is the one that has to handle two concave
 * rings.
 */
export function clipArea(a: ArrayLike<number>, b: number[]): number {
  return polyArea(clipPoly(Array.from(a), ccw(b)));
}

/**
 * How much two possibly-concave footprints share, m2, by **signed** triangle fan.
 *
 * ---------------------------------------------------------------------------
 * **The sign is the whole thing, and the first run of this file proved it.**
 * Sutherland-Hodgman needs a convex clip, so `b` has to be cut into convex
 * pieces; the obvious cut is a fan about its first vertex, and an unsigned fan
 * over a concave ring covers the reflex pockets *outside* it as well as the ring
 * -- which is not a small error. Over the CBD the unsigned version reported
 * `1,594 m2 shared of 1,530 m2`, an overlap larger than the smaller of the two
 * buildings, which is arithmetically impossible and would have set a budget off
 * a number that could not be true.
 *
 * Signed, the fan is exact for any simple polygon. For a point `p`, the sum of
 * the *signed* indicator functions of the fan triangles `(b0, bi, bi+1)` is the
 * winding number of `b` about `p` -- 1 inside, 0 outside, with the reflex
 * pockets cancelling to zero because they are covered once positively and once
 * negatively. Integrating that identity over `a` gives the intersection area,
 * so each triangle contributes `sign(area(b0, bi, bi+1)) * area(a & tri)` and
 * the pockets take themselves back out.
 *
 * `a` may be concave too and needs no treatment: clipping a concave subject
 * against a convex clip can leave a degenerate edge in the *outline*, and its
 * area is still exact -- which is `undrawn-solids-check.clipPoly`'s own note,
 * and the only property read out of it here.
 */
export function overlapArea(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = b.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  const subj = Array.from(a);
  for (let i = 1; i + 1 < n; i++) {
    const x0 = b[0], z0 = b[1];
    const x1 = b[i * 2], z1 = b[i * 2 + 1];
    const x2 = b[(i + 1) * 2], z2 = b[(i + 1) * 2 + 1];
    const cross = (x1 - x0) * (z2 - z0) - (x2 - x0) * (z1 - z0);
    if (cross === 0) continue;
    const tri = ccw([x0, z0, x1, z1, x2, z2]);
    sum += (cross > 0 ? 1 : -1) * polyArea(clipPoly(subj, tri));
  }
  return sum < 0 ? -sum : sum;
}

/**
 * How far inside a ring `(x, z)` is, metres, or 0 outside it.
 *
 * The score for every point-in-footprint pair. A count alone cannot sort a table
 * -- a stem 0.1 m inside a wall and a stem in the middle of a lounge room are
 * the same row -- and the distance to the nearest edge is the one number that
 * separates a clear placed against a footprint edge from a clear that never ran.
 */
export function depthInRing(pts: ArrayLike<number>, x: number, z: number): number {
  if (!inRing(pts, x, z)) return 0;
  let best = Infinity;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = toSegment(pts[j * 2], pts[j * 2 + 1], pts[i * 2], pts[i * 2 + 1], x, z).d;
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : 0;
}

/** An oriented box as a CCW quad: centre, unit heading, half length along it, half width across. */
export function obb(
  x: number, z: number, ux: number, uz: number, halfAlong: number, halfAcross: number,
): number[] {
  const vx = -uz;
  const vz = ux;
  return ccw([
    x - ux * halfAlong - vx * halfAcross, z - uz * halfAlong - vz * halfAcross,
    x + ux * halfAlong - vx * halfAcross, z + uz * halfAlong - vz * halfAcross,
    x + ux * halfAlong + vx * halfAcross, z + uz * halfAlong + vz * halfAcross,
    x - ux * halfAlong + vx * halfAcross, z - uz * halfAlong + vz * halfAcross,
  ]);
}

/** A way segment swept to `hw` either side, CCW. `undrawn-solids-check.segQuad`. */
export function segQuad(x0: number, z0: number, x1: number, z1: number, hw: number): number[] | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return null;
  const nx = (-dz / len) * hw;
  const nz = (dx / len) * hw;
  return ccw([x0 + nx, z0 + nz, x1 + nx, z1 + nz, x1 - nx, z1 - nz, x0 - nx, z0 - nz]);
}

/** How far `(x, z)` is from the segment `a->b`, and where along it that lands. */
export function toSegment(
  ax: number, az: number, bx: number, bz: number, x: number, z: number,
): { d: number; t: number } {
  const ex = bx - ax;
  const ez = bz - az;
  const len2 = ex * ex + ez * ez;
  let t = len2 < 1e-12 ? 0 : ((x - ax) * ex + (z - az) * ez) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const dx = x - (ax + ex * t);
  const dz = z - (az + ez * t);
  return { d: Math.sqrt(dx * dx + dz * dz), t };
}

/**
 * The nearest approach between the segment `a->b` and a ring, and where on the
 * segment it lands.
 *
 * **A polygon is not its centre, and testing one as if it were is how a 200 m
 * viaduct reads as clear of a railway its deck lies across.** The first run of
 * this file tested structural prisms against the rail gauge at their centroid,
 * which convicted the ones that happened to be centred on a track and excused
 * every one that merely crossed it. This is the honest test: zero when the two
 * cross or one contains the other, and the true nearest approach otherwise.
 */
export function segRingDistance(
  ax: number, az: number, bx: number, bz: number, pts: ArrayLike<number>,
): { d: number; t: number } {
  const n = pts.length / 2;
  if (n < 3) return { d: Infinity, t: 0 };
  // Crossing, or the segment inside the ring: either way there is nothing between.
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const cx = pts[j * 2], cz = pts[j * 2 + 1];
    const dx = pts[i * 2], dz = pts[i * 2 + 1];
    const r1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
    const r2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
    const s1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
    const s2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
    if (r1 * r2 < 0 && s1 * s2 < 0) return { d: 0, t: 0.5 };
  }
  if (inRing(pts, (ax + bx) / 2, (az + bz) / 2)) return { d: 0, t: 0.5 };
  let best = Infinity;
  let at = 0;
  for (let i = 0; i < n; i++) {
    const r = toSegment(ax, az, bx, bz, pts[i * 2], pts[i * 2 + 1]);
    if (r.d < best) { best = r.d; at = r.t; }
  }
  for (let i = 0, j = n - 1; i < n; j = i++) {
    for (const [px, pz, t] of [[ax, az, 0], [bx, bz, 1]] as const) {
      const r = toSegment(pts[j * 2], pts[j * 2 + 1], pts[i * 2], pts[i * 2 + 1], px, pz);
      if (r.d < best) { best = r.d; at = t; }
    }
  }
  return { d: best, t: at };
}

/**
 * Do two height bands overlap? `[a0, a1)` against `[b0, b1)`.
 *
 * The half-metre of slack is deliberate and it is `STATIC_CAR_CLEARANCE_Y`'s
 * order rather than a guess: every one of these bands is a solid resting on a
 * sampled ground, and two solids on the same ground whose bands miss by a
 * centimetre are still one object inside another to a player.
 */
export function bandsOverlap(a0: number, a1: number, b0: number, b1: number): boolean {
  return a0 < b1 && b0 < a1;
}

// =====================================================================================
// The predicates. Each pair's whole verdict, as a pure function. The controls
// call exactly these.
// =====================================================================================

/** A footprint, as the scan sees one. `Prism`, minus what the predicates never read. */
export interface Foot {
  points: Float32Array;
  base: number;
  top: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  area: number;
}

/**
 * Is a point-like object (stem, pole, bin, post, signal) inside a footprint?
 *
 * Plan first: the object's centre inside the ring. Then height: the object has
 * to reach above the building's pad, because a stem whose whole crown is under
 * a raised podium is a different thing from a tree through a living room -- and
 * `base` for a **building** is a pad rather than a soffit, so the band is
 * `[base, top)` and everything drawn from the ground up is inside it.
 */
export function pointInFoot(f: Foot, x: number, z: number, y0: number, y1: number): boolean {
  if (x < f.minX || x > f.maxX || z < f.minZ || z > f.maxZ) return false;
  if (!bandsOverlap(y0, y1, f.base, f.top)) return false;
  return inRing(f.points, x, z);
}

/**
 * How much carriageway a plan shape stands on, m2, given the spans near it.
 *
 * The half width is reduced by `KERB_INSET_M` before the sweep: see that
 * constant. Returns the *largest* single span's overlap rather than the union,
 * on `undrawn-solids-check.segQuad`'s argument -- a post stands on one span, and
 * a union would need a clipper this file does not have.
 */
export function onCarriageway(
  shape: number[],
  spans: ReadonlyArray<{ x0: number; z0: number; x1: number; z1: number; hw: number; klass?: number }>,
): { area: number; klass: number } {
  let best = 0;
  let klass = -1;
  for (const s of spans) {
    const hw = s.hw - KERB_INSET_M;
    if (hw <= 0) continue;
    const q = segQuad(s.x0, s.z0, s.x1, s.z1, hw);
    if (q === null) continue;
    const a = polyArea(clipPoly(shape.slice(), q));
    if (a > best) { best = a; klass = s.klass ?? -1; }
  }
  return { area: best, klass };
}

/**
 * Do two footprints genuinely overlap, or are they neighbours? Returns the
 * shared area when it is an overlap and 0 when it is adjacency.
 *
 * Both `MIN_OVERLAP_M2` and `OVERLAP_FRACTION` have to be satisfied. See
 * `OVERLAP_FRACTION` for why one alone is a party-wall counter.
 */
export function footOverlap(a: Foot, b: Foot): number {
  if (a.maxX < b.minX || b.maxX < a.minX || a.maxZ < b.minZ || b.maxZ < a.minZ) return 0;
  const shared = overlapArea(a.points, b.points);
  if (shared < MIN_OVERLAP_M2) return 0;
  const smaller = a.area < b.area ? a.area : b.area;
  if (smaller <= 0 || shared < smaller * OVERLAP_FRACTION) return 0;
  return shared;
}

/**
 * Is a point inside the volume a train sweeps here?
 *
 * `envelope.structureGauge` asked of a *band* rather than of a height, because
 * everything in this file is a solid with a top and a bottom and the gauge is a
 * band too. Returns the depth into the gauge, or 0.
 */
export function gaugeDepth(offset: number, railY: number, y0: number, y1: number): number {
  if (!bandsOverlap(y0, y1, railY + CAR_BODY_FLOOR_M, railY + CAR_BODY_ROOF_M)) return 0;
  const limit = CAR_BODY_HALF_M + STRUCTURE_MARGIN_M;
  const a = offset < 0 ? -offset : offset;
  return a < limit ? limit - a : 0;
}

/**
 * How far a water vertex's own bed is from the shipped ground, metres, signed.
 *
 * Positive: the bed the sheet was cut against is **above** the terrain that
 * shipped, so the water is a slab over a hollow. Negative: the terrain is above
 * that bed, and once it passes the surface the ground is standing out of the
 * pond. See `WATER_FLOAT_M`.
 */
export function waterBedError(surface: number, depth: number, terrain: number): number {
  return surface - depth - terrain;
}

// =====================================================================================
// The world
// =====================================================================================

interface TileEntry { key: string; b: number; bounds: [number, number, number, number]; }
const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8'));
const SIZE: number = index.tile_size;
const GRID: number = index.terrain.grid;
const CLASSES: string[] = (index.lanes?.classes ?? []) as string[];
const tiles: TileEntry[] = index.tiles;
const byKey = new Map<string, TileEntry>(tiles.map((t) => [t.key, t]));

/** The tile a world point is in, by arithmetic. `z = -north`, so the row inverts. */
function keyAt(x: number, z: number): string {
  return `${Math.floor(x / SIZE)}_${-(Math.floor(z / SIZE) + 1)}`;
}

function readTile(key: string, ext: string): ArrayBuffer | null {
  const p = ext === 'bin'
    ? join(ROOT, 'collision', `${key}.bin`)
    : join(ROOT, 'tiles', `${key}.${ext}`);
  if (!existsSync(p)) return null;
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/**
 * A least-recently-used map over one sidecar family.
 *
 * The scan needs a tile's eight neighbours for every pair that can straddle a
 * seam, and the tile list is sorted by `(tx, tz)` before the sweep, so the
 * working set is three columns of tiles. A cap of a thousand holds them with
 * room over; nothing here is large (collision is 143 MB over 22,928 tiles).
 */
class Lru<T> {
  private readonly map = new Map<string, T>();
  constructor(private readonly cap: number, private readonly load: (key: string) => T) {}
  get(key: string): T {
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    const made = this.load(key);
    this.map.set(key, made);
    if (this.map.size > this.cap) {
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    return made;
  }
}

/** One tile's prisms, through the real class so `structural` is the real flag. */
function loadPrisms(key: string): { buildings: Foot[]; structures: Foot[] } {
  const t = byKey.get(key);
  if (t === undefined) return { buildings: [], structures: [] };
  const buf = readTile(key, 'bin');
  if (buf === null) return { buildings: [], structures: [] };
  const w = new CollisionWorld();
  w.addTile(key, buf, t.bounds[0], t.bounds[1] + SIZE, t.b);
  const all: Prism[] = w.prismsWithin(
    (t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2, SIZE * 1.5,
  );
  const buildings: Foot[] = [];
  const structures: Foot[] = [];
  for (const p of all) {
    const f: Foot = {
      points: p.points, base: p.base, top: p.top,
      minX: p.minX, minZ: p.minZ, maxX: p.maxX, maxZ: p.maxZ,
      area: polyArea(p.points),
    };
    (p.structural ? structures : buildings).push(f);
  }
  return { buildings, structures };
}
const prismCache = new Lru(1200, loadPrisms);

/** One tile's terrain grid, or null. Row 0 is the northern edge -- see the header. */
function loadGround(key: string): Float32Array | null {
  const buf = readTile(key, 'terr.bin');
  return buf === null ? null : new Float32Array(buf);
}
const groundCache = new Lru(1200, loadGround);

function sampleGround(g: Float32Array, t: TileEntry, x: number, z: number): number {
  const lx = ((x - t.bounds[0]) / SIZE) * GRID;
  const lz = ((z - t.bounds[1]) / SIZE) * GRID;
  const c0 = Math.max(0, Math.min(GRID - 1, Math.floor(lx)));
  const r0 = Math.max(0, Math.min(GRID - 1, Math.floor(lz)));
  const fx = Math.max(0, Math.min(1, lx - c0));
  const fz = Math.max(0, Math.min(1, lz - r0));
  const at = (r: number, c: number): number => g[r * (GRID + 1) + c];
  return (
    (at(r0, c0) * (1 - fx) + at(r0, c0 + 1) * fx) * (1 - fz) +
    (at(r0 + 1, c0) * (1 - fx) + at(r0 + 1, c0 + 1) * fx) * fz
  );
}

/** The ground anywhere in the build, or NaN off the extent. */
function groundAt(x: number, z: number): number {
  const t = byKey.get(keyAt(x, z));
  if (t === undefined) return Number.NaN;
  const g = groundCache.get(t.key);
  if (g === null) return Number.NaN;
  return sampleGround(g, t, x, z);
}

interface Span { x0: number; z0: number; x1: number; z1: number; hw: number; klass: number; }
function loadSpans(key: string): Span[] {
  const t = byKey.get(key);
  if (t === undefined) return [];
  const buf = readTile(key, 'lanes.bin');
  if (buf === null) return [];
  const lanes = decodeLanes(buf, t.bounds[0], t.bounds[1] + SIZE);
  if (lanes === null) return [];
  const out: Span[] = [];
  for (const w of lanes.ways) {
    if (w.halfWidth <= 0) continue;
    for (let i = 0; i + 1 < w.x.length; i++) {
      out.push({ x0: w.x[i], z0: w.z[i], x1: w.x[i + 1], z1: w.z[i + 1], hw: w.halfWidth, klass: w.klass });
    }
  }
  return out;
}
const spanCache = new Lru(1200, loadSpans);

interface ParkedCar { x: number; z: number; heading: number; body: number; }
function loadCars(key: string): ParkedCar[] {
  const t = byKey.get(key);
  if (t === undefined) return [];
  const buf = readTile(key, 'cars.bin');
  if (buf === null) return [];
  const c = decodeCars(buf);
  if (c === null) return [];
  const ox = t.bounds[0];
  const oz = t.bounds[1] + SIZE;
  const out: ParkedCar[] = new Array(c.count);
  for (let i = 0; i < c.count; i++) {
    out[i] = { x: ox + c.x[i], z: oz + c.z[i], heading: c.heading[i], body: c.body[i] };
  }
  return out;
}
const carCache = new Lru(1200, loadCars);

/** The nearest named centreline to a point. `overpass-clearance-check.streetAt`. */
const nameCache = new Map<string, ReturnType<typeof decodeStreetNames>>();
function streetAt(x: number, z: number): string {
  const key = keyAt(x, z);
  const t = byKey.get(key);
  if (t === undefined) return '';
  let names = nameCache.get(key);
  if (names === undefined) {
    const buf = readTile(key, 'names.bin');
    names = buf === null ? null : decodeStreetNames(buf);
    if (names !== null && names !== undefined) translateStreetNames(names, t.bounds[0], t.bounds[1] + SIZE);
    if (nameCache.size > 400) nameCache.clear();
    nameCache.set(key, names);
  }
  if (names === null || names === undefined) return '';
  let best = Infinity;
  let name = '';
  for (const seg of names.segments) {
    if (x < seg.minX - 80 || x > seg.maxX + 80 || z < seg.minZ - 80 || z > seg.maxZ + 80) continue;
    for (let i = 0; i < seg.points.length / 2; i++) {
      const dx = x - seg.points[i * 2];
      const dz = z - seg.points[i * 2 + 1];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; name = seg.name; }
    }
  }
  return name;
}

// =====================================================================================
// The railway, as one global segment index
// =====================================================================================

/**
 * Every metre of open, owned running line, in a 64 m plan grid.
 *
 * **Owned**, on `rail-gauge-check.ts`' argument: two services mapped on one
 * alignment are one railway, and sweeping both would count every foul twice.
 *
 * **Open**, and here that is `SPAN_TUNNEL | SPAN_DEEP` rather than
 * `rail-gauge-check.ts`' `SPAN_TUNNEL` alone -- the one place this file departs
 * from its sibling, and the reason is that the two are asking about different
 * populations. That check sweeps *the railway's own kit*, all of which is built
 * beside the track wherever the track is, so a bore's own ballast is still worth
 * convicting. This one sweeps **the city**: buildings, trees, bins, parked cars.
 * A terrace over an untagged bore is not inside a train, it is on top of one,
 * and counting it would put every street above Wynyard in the table. `SPAN_DEEP`
 * is exactly the bit that names those -- *"the track is buried deeper than
 * `DEEP_M` at this vertex by the pipeline's own measurement, whatever OSM tagged
 * the way"*, derived at decode and read by every writer that carves.
 */
interface RailSeg { ax: number; ay: number; az: number; bx: number; by: number; bz: number; }
const RAIL_CELL = 64;
const railGrid = new Map<number, number[]>();
const railSegs: RailSeg[] = [];
function railCell(cx: number, cz: number): number { return (cx & 0xffff) * 65536 + (cz & 0xffff); }

let railVertices = 0;
{
  const bake: RailBake = decodeRail(readFileSync(RAIL_PATH).buffer.slice(0) as ArrayBuffer);
  const atlas = buildTrackAtlas(bake);
  const p = bake.vertices;
  railVertices = p.length / 3;
  for (const line of bake.lines) {
    for (const dir of line.dirs) {
      const first = dir.vertexOff;
      const last = dir.vertexOff + dir.vertexCount - 1;
      for (let v = first; v < last; v++) {
        if (((bake.vertexFlags[v] | bake.vertexFlags[v + 1]) & (SPAN_TUNNEL | SPAN_DEEP)) !== 0) continue;
        if (!ownsAlignment(atlas, v)) continue;
        const s: RailSeg = {
          ax: p[v * 3], ay: p[v * 3 + 1], az: p[v * 3 + 2],
          bx: p[(v + 1) * 3], by: p[(v + 1) * 3 + 1], bz: p[(v + 1) * 3 + 2],
        };
        const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
        if (len < 0.05 || len > 2000) continue;
        const i = railSegs.push(s) - 1;
        const x0 = Math.floor(Math.min(s.ax, s.bx) / RAIL_CELL);
        const x1 = Math.floor(Math.max(s.ax, s.bx) / RAIL_CELL);
        const z0 = Math.floor(Math.min(s.az, s.bz) / RAIL_CELL);
        const z1 = Math.floor(Math.max(s.az, s.bz) / RAIL_CELL);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cz = z0; cz <= z1; cz++) {
            const k = railCell(cx, cz);
            const list = railGrid.get(k);
            if (list === undefined) railGrid.set(k, [i]);
            else list.push(i);
          }
        }
      }
    }
  }
}

/** Every span whose cell touches this plan box, without repeats. */
function railNear(minX: number, minZ: number, maxX: number, maxZ: number): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const x0 = Math.floor(minX / RAIL_CELL);
  const x1 = Math.floor(maxX / RAIL_CELL);
  const z0 = Math.floor(minZ / RAIL_CELL);
  const z1 = Math.floor(maxZ / RAIL_CELL);
  for (let cx = x0; cx <= x1; cx++) {
    for (let cz = z0; cz <= z1; cz++) {
      const list = railGrid.get(railCell(cx, cz));
      if (list === undefined) continue;
      for (const i of list) if (!seen.has(i)) { seen.add(i); out.push(i); }
    }
  }
  return out;
}

/** The deepest this point-and-band reaches into the gauge. */
function railFoul(x: number, z: number, y0: number, y1: number, radius: number): number {
  let worst = 0;
  for (const i of railNear(x - RAIL_CELL, z - RAIL_CELL, x + RAIL_CELL, z + RAIL_CELL)) {
    const s = railSegs[i];
    const { d, t } = toSegment(s.ax, s.az, s.bx, s.bz, x, z);
    const offset = d - radius;
    if (offset >= CAR_BODY_HALF_M + STRUCTURE_MARGIN_M) continue;
    const depth = gaugeDepth(offset, s.ay + (s.by - s.ay) * t, y0, y1);
    if (depth > worst) worst = depth;
  }
  return worst;
}

/** The same, for a footprint: the whole ring against the line, not its centre. */
function railFoulFoot(f: Foot): number {
  let worst = 0;
  const m = CAR_BODY_HALF_M + STRUCTURE_MARGIN_M;
  for (const i of railNear(f.minX - m, f.minZ - m, f.maxX + m, f.maxZ + m)) {
    const s = railSegs[i];
    if (Math.min(s.ax, s.bx) > f.maxX + m || Math.max(s.ax, s.bx) < f.minX - m) continue;
    if (Math.min(s.az, s.bz) > f.maxZ + m || Math.max(s.az, s.bz) < f.minZ - m) continue;
    const { d, t } = segRingDistance(s.ax, s.az, s.bx, s.bz, f.points);
    if (d >= m) continue;
    const depth = gaugeDepth(d, s.ay + (s.by - s.ay) * t, f.base, f.top);
    if (depth > worst) worst = depth;
  }
  return worst;
}

// =====================================================================================
// The tally
// =====================================================================================

interface Offender { x: number; z: number; score: number; note: string; }
interface PairTally {
  id: string;
  what: string;
  unit: string;
  budget: number;
  count: number;
  total: number;
  worst: Offender[];
  /** Sub-populations, for the table under the pair. */
  by: Map<string, number>;
}

const pairs = new Map<string, PairTally>();
function pair(id: string, what: string, unit: string, budget: number): PairTally {
  const p: PairTally = { id, what, unit, budget, count: 0, total: 0, worst: [], by: new Map() };
  pairs.set(id, p);
  return p;
}
const P_TREE = pair('TREE_IN_BUILDING', 'tree stem x building footprint', 'stems', BUDGET_TREE_IN_BUILDING);
const P_FURN_B = pair('FURNITURE_IN_BUILDING', 'pole/bin/post/signal x building footprint', 'items', BUDGET_FURNITURE_IN_BUILDING);
const P_FURN_R = pair('FURNITURE_ON_ROAD', 'pole/bin/post/signal x carriageway', 'items', BUDGET_FURNITURE_ON_ROAD);
const P_CAR_B = pair('CAR_IN_BUILDING', 'parked car body x building footprint', 'cars', BUDGET_CAR_IN_BUILDING);
const P_CAR_C = pair('CAR_IN_CAR', 'parked car body x parked car body', 'pairs', BUDGET_CAR_IN_CAR);
const P_BLD_B = pair('BUILDING_IN_BUILDING', 'building footprint x building footprint', 'pairs', BUDGET_BUILDING_IN_BUILDING);
const P_DECK_B = pair('DECK_IN_BUILDING', 'deck/structure x building footprint', 'pairs', BUDGET_DECK_IN_BUILDING);
const P_DECK_T = pair('DECK_UNDER_TERRAIN', 'deck/structure x the terrain over it', 'decks', BUDGET_DECK_UNDER_TERRAIN);
const P_RAIL = pair('RAIL_GAUGE', 'baked instance x the volume a train sweeps', 'items', BUDGET_RAIL_GAUGE);
const P_STN = pair('STATION_IN_BUILDING', 'station room/access x building footprint', 'pairs', BUDGET_STATION_IN_BUILDING);
const P_WATER = pair('WATER_OVER_TERRAIN', 'water sheet bed x the shipped terrain', 'vertices', BUDGET_WATER_OVER_TERRAIN);
const P_BLD_W = pair('BUILDING_UNDER_WATER', 'building footprint x water surface', 'buildings', BUDGET_BUILDING_UNDER_WATER);

function hit(p: PairTally, x: number, z: number, score: number, note: string, kind: string): void {
  p.count++;
  p.total += score;
  p.by.set(kind, (p.by.get(kind) ?? 0) + 1);
  p.worst.push({ x, z, score, note });
  if (p.worst.length > KEEP_PER_PAIR * 4) {
    p.worst.sort((a, b) => b.score - a.score);
    p.worst.length = KEEP_PER_PAIR;
  }
}

// =====================================================================================
// The scan
// =====================================================================================

let centre: [number, number] | null = null;
if (NEAR !== '') {
  const [a, b] = NEAR.split(',').map(Number);
  centre = [a, b];
}
const scoped = centre === null
  ? tiles
  : tiles.filter((t) => {
      const dx = Math.max(t.bounds[0] - centre![0], 0, centre![0] - t.bounds[2]);
      const dz = Math.max(t.bounds[1] - centre![1], 0, centre![1] - t.bounds[3]);
      return dx * dx + dz * dz <= RADIUS * RADIUS;
    });
// Sorted by (tx, tz) so the neighbour caches hold three columns rather than
// thrashing on the index's own string order -- see `Lru`.
const scope = scoped
  .slice()
  .sort((a, b) => {
    const [ax, az] = a.key.split('_').map(Number);
    const [bx, bz] = b.key.split('_').map(Number);
    return ax - bx || az - bz;
  })
  .filter((_, i) => i % SAMPLE === 0);

say(
  `clash -- ${scope.length.toLocaleString()} tiles` +
    (centre === null ? '' : ` within ${RADIUS} m of (${centre[0]}, ${centre[1]})`) +
    (SAMPLE > 1 ? `, every ${SAMPLE}th` : '') +
    `; ${railSegs.length.toLocaleString()} open running-line spans of ${railVertices.toLocaleString()} vertices`,
);

/** This tile's key and its eight neighbours', for the pairs that straddle a seam. */
function ring9(key: string): string[] {
  const [tx, tz] = key.split('_').map(Number);
  const out: string[] = [];
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const k = `${tx + ax}_${tz + az}`;
      if (byKey.has(k)) out.push(k);
    }
  }
  return out;
}

let stems = 0;
let furnItems = 0;
let carsSeen = 0;
let buildingsSeen = 0;
let structuresSeen = 0;
let waterVerts = 0;
let tilesRead = 0;
const t0 = Date.now();

for (const t of scope) {
  tilesRead++;
  const ox = t.bounds[0];
  const oz = t.bounds[1] + SIZE;
  const near = ring9(t.key);

  const own = prismCache.get(t.key);
  buildingsSeen += own.buildings.length;
  structuresSeen += own.structures.length;

  // Every building in reach, with which tile wrote it, so a seam-straddling pair
  // is tested once: the owning keys are compared and only the lower one walks it.
  const nearBuildings: Array<{ key: string; f: Foot }> = [];
  for (const k of near) for (const f of prismCache.get(k).buildings) nearBuildings.push({ key: k, f });

  const spans: Span[] = [];
  for (const k of near) spans.push(...spanCache.get(k));

  const ground = groundCache.get(t.key);
  const groundHere = (x: number, z: number): number => {
    if (x >= t.bounds[0] && x < t.bounds[2] && z >= t.bounds[1] && z < t.bounds[3] && ground !== null) {
      return sampleGround(ground, t, x, z);
    }
    return groundAt(x, z);
  };

  // --- 1. trees ---------------------------------------------------------------
  const vegBuf = readTile(t.key, 'veg.bin');
  const veg = vegBuf === null ? null : decodeVegetation(vegBuf);
  if (veg !== null) {
    stems += veg.count;
    for (let i = 0; i < veg.count; i++) {
      const x = ox + veg.x[i];
      const z = oz + veg.z[i];
      const g = groundHere(x, z);
      const y0 = Number.isFinite(g) ? g : 0;
      const y1 = y0 + veg.height[i];
      for (const { f } of nearBuildings) {
        if (!pointInFoot(f, x, z, y0, y1)) continue;
        hit(
          P_TREE, x, z, depthInRing(f.points, x, z),
          `${veg.height[i].toFixed(1)} m stem, ${depthInRing(f.points, x, z).toFixed(1)} m inside a ` +
            `${f.area.toFixed(0)} m2 footprint`,
          'stem',
        );
        break;
      }
      const foul = railFoul(x, z, y0, y1, TRUNK_RADIUS_M);
      if (foul > 0) hit(P_RAIL, x, z, foul, `tree, ${veg.height[i].toFixed(1)} m`, 'tree');
    }
  }

  // --- 2 and 3. poles, bins, blade posts, signals ------------------------------
  const items: Array<{ kind: string; x: number; z: number; y0: number; y1: number; r: number }> = [];
  const powBuf = readTile(t.key, 'power.bin');
  const pow = powBuf === null ? null : decodePower(powBuf);
  if (pow !== null) {
    for (let i = 0; i < pow.poleCount; i++) {
      items.push({
        kind: 'pole', x: ox + pow.x[i], z: oz + pow.z[i],
        y0: pow.groundY[i], y1: pow.groundY[i] + pow.height[i], r: FURNITURE_SPEC.pole.radius,
      });
    }
  }
  const furnBuf = readTile(t.key, 'furn.bin');
  const furn = furnBuf === null ? null : decodeFurniture(furnBuf);
  if (furn !== null) {
    for (let i = 0; i < furn.binCount; i++) {
      items.push({
        kind: 'bin', x: ox + furn.binX[i], z: oz + furn.binZ[i],
        y0: furn.binGroundY[i], y1: furn.binGroundY[i] + FURNITURE_SPEC.bin.height, r: FURNITURE_SPEC.bin.radius,
      });
    }
    for (let i = 0; i < furn.postCount; i++) {
      items.push({
        kind: 'post', x: ox + furn.postX[i], z: oz + furn.postZ[i],
        y0: furn.postGroundY[i], y1: furn.postGroundY[i] + FURNITURE_SPEC.post.height, r: FURNITURE_SPEC.post.radius,
      });
    }
    for (let i = 0; i < furn.signalCount; i++) {
      items.push({
        kind: 'signal', x: ox + furn.signalX[i], z: oz + furn.signalZ[i],
        y0: furn.signalGroundY[i], y1: furn.signalGroundY[i] + FURNITURE_SPEC.signal.height, r: FURNITURE_SPEC.signal.radius,
      });
    }
  }
  furnItems += items.length;
  for (const it of items) {
    for (const { f } of nearBuildings) {
      if (!pointInFoot(f, it.x, it.z, it.y0, it.y1)) continue;
      hit(
        P_FURN_B, it.x, it.z, depthInRing(f.points, it.x, it.z),
        `${it.kind} ${depthInRing(f.points, it.x, it.z).toFixed(1)} m inside a ${(f.top - f.base).toFixed(1)} m building`,
        it.kind,
      );
      break;
    }
    // A square about the item is enough of a plan shape: the biggest of these is
    // a bin at 0.74 m and the inset is 0.4, so the shape's own width is inside
    // the tolerance the inset already grants.
    const box = ccw([
      it.x - it.r, it.z - it.r, it.x + it.r, it.z - it.r,
      it.x + it.r, it.z + it.r, it.x - it.r, it.z + it.r,
    ]);
    const onRoad = onCarriageway(box, spans);
    if (onRoad.area > 0) {
      hit(
        P_FURN_R, it.x, it.z, onRoad.area,
        `${it.kind} on ${onRoad.area.toFixed(2)} m2 of ${CLASSES[onRoad.klass] ?? '?'} carriageway`,
        it.kind,
      );
    }
    const foul = railFoul(it.x, it.z, it.y0, it.y1, it.r);
    if (foul > 0) hit(P_RAIL, it.x, it.z, foul, it.kind, it.kind);
  }

  // --- 4 and 5. parked cars ----------------------------------------------------
  const ownCars = carCache.get(t.key);
  carsSeen += ownCars.length;
  if (ownCars.length > 0) {
    // Every car in reach, tagged with its tile, on the same lower-key rule the
    // building pairs use. A bay across a seam is one bay.
    const nearCars: Array<{ key: string; c: ParkedCar }> = [];
    for (const k of near) {
      if (k !== t.key) {
        // Only the ones that could reach over the seam: the longest body is
        // 5.4 m, so anything more than that from this tile cannot touch it.
        for (const c of carCache.get(k)) {
          if (c.x < t.bounds[0] - 6 || c.x > t.bounds[2] + 6) continue;
          if (c.z < t.bounds[1] - 6 || c.z > t.bounds[3] + 6) continue;
          nearCars.push({ key: k, c });
        }
      }
    }
    for (let i = 0; i < ownCars.length; i++) {
      const c = ownCars[i];
      const size = CAR_BODY_SIZE[c.body];
      // The nose is local +X rotated by `heading` -- `world/cars.buildTileCars`.
      const ux = Math.cos(c.heading);
      const uz = -Math.sin(c.heading);
      const quad = obb(c.x, c.z, ux, uz, size.length / 2, size.width / 2);
      const g = groundHere(c.x, c.z);
      const y0 = (Number.isFinite(g) ? g : 0) + STATIC_CAR_CLEARANCE_Y;
      const y1 = y0 + size.height;
      for (const { f } of nearBuildings) {
        if (f.maxX < c.x - 3 || f.minX > c.x + 3 || f.maxZ < c.z - 3 || f.minZ > c.z + 3) continue;
        if (!bandsOverlap(y0, y1, f.base, f.top)) continue;
        const shared = clipArea(f.points, quad);
        if (shared < MIN_OVERLAP_M2) continue;
        hit(P_CAR_B, c.x, c.z, shared, `${shared.toFixed(1)} m2 of car inside a building`, 'car');
        break;
      }
      const foul = railFoul(c.x, c.z, y0, y1, size.width / 2);
      if (foul > 0) hit(P_RAIL, c.x, c.z, foul, 'parked car', 'car');
      // Against the other cars: own tile above `i`, plus any neighbour whose key
      // sorts higher, so the pair is walked exactly once in the whole build.
      const test = (o: ParkedCar): void => {
        const dx = o.x - c.x;
        const dz = o.z - c.z;
        if (dx * dx + dz * dz > 36) return;
        const os = CAR_BODY_SIZE[o.body];
        const oux = Math.cos(o.heading);
        const ouz = -Math.sin(o.heading);
        const oquad = obb(o.x, o.z, oux, ouz, os.length / 2, os.width / 2);
        const shared = polyArea(clipPoly(quad.slice(), oquad));
        if (shared < MIN_OVERLAP_M2) return;
        hit(P_CAR_C, (c.x + o.x) / 2, (c.z + o.z) / 2, shared, `${shared.toFixed(1)} m2 of two cars in one bay`, 'car');
      };
      for (let j = i + 1; j < ownCars.length; j++) test(ownCars[j]);
      for (const { key, c: o } of nearCars) if (key > t.key) test(o);
    }
  }

  // --- 6, 7 and 8. buildings and decks ------------------------------------------
  //
  // Only the tile whose key sorts lower walks a seam-straddling pair, and within
  // this tile only the later index, so every pair in the build is tested exactly
  // once however many of the nine neighbourhoods it appears in.
  const otherBuildings = nearBuildings.filter((n) => n.key > t.key);
  for (let i = 0; i < own.buildings.length; i++) {
    const a = own.buildings[i];
    for (let j = i + 1; j < own.buildings.length; j++) {
      const b = own.buildings[j];
      const shared = footOverlap(a, b);
      if (shared <= 0) continue;
      const cx = (a.minX + a.maxX + b.minX + b.maxX) / 4;
      const cz = (a.minZ + a.maxZ + b.minZ + b.maxZ) / 4;
      hit(P_BLD_B, cx, cz, shared, `${shared.toFixed(0)} m2 shared of ${Math.min(a.area, b.area).toFixed(0)} m2`, 'building');
    }
    for (const { f: b } of otherBuildings) {
      const shared = footOverlap(a, b);
      if (shared <= 0) continue;
      const cx = (a.minX + a.maxX + b.minX + b.maxX) / 4;
      const cz = (a.minZ + a.maxZ + b.minZ + b.maxZ) / 4;
      hit(P_BLD_B, cx, cz, shared, `${shared.toFixed(0)} m2 shared of ${Math.min(a.area, b.area).toFixed(0)} m2`, 'building');
    }
    // A building inside a train. Whole ring against the line -- see `railFoulFoot`.
    const foulB = railFoulFoot(a);
    if (foulB > 0) hit(P_RAIL, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2, foulB, 'building', 'building');
  }
  for (const s of own.structures) {
    // A deck through a building. The band matters: `structural` means `base` is a
    // soffit with air under it, so a viaduct over a terrace is legal and only an
    // overlap of the two bands is not.
    for (const { f: b } of nearBuildings) {
      if (!bandsOverlap(s.base, s.top, b.base, b.top)) continue;
      const shared = overlapArea(s.points, b.points);
      if (shared < MIN_OVERLAP_M2) continue;
      const cx = (s.minX + s.maxX) / 2;
      const cz = (s.minZ + s.maxZ) / 2;
      hit(P_DECK_B, cx, cz, shared, `${shared.toFixed(0)} m2 of deck inside a building`, 'deck');
      break;
    }
    // A deck inside the hill. The deck's own roof against the ground over it.
    const cx = (s.minX + s.maxX) / 2;
    const cz = (s.minZ + s.maxZ) / 2;
    const g = groundHere(cx, cz);
    if (Number.isFinite(g) && g - s.top > DECK_BURIED_M) {
      hit(P_DECK_T, cx, cz, g - s.top, `deck top ${s.top.toFixed(1)} m, ground ${g.toFixed(1)} m`, 'deck');
    }
    const foul = railFoulFoot(s);
    if (foul > 0) hit(P_RAIL, cx, cz, foul, 'deck/structure', 'deck');
  }

  // --- 11 and 12. water ----------------------------------------------------------
  const waterBuf = readTile(t.key, 'water.bin');
  const water: TileWater | null = waterBuf === null ? null : decodeWater(waterBuf);
  if (water !== null && ground !== null) {
    for (const sh of water.sheets) {
      for (let i = 0; i < sh.count; i++) {
        const x = ox + sh.vertices[i * 3];
        const z = oz + sh.vertices[i * 3 + 1];
        waterVerts++;
        if (x < t.bounds[0] || x >= t.bounds[2] || z < t.bounds[1] || z >= t.bounds[3]) continue;
        const terr = sampleGround(ground, t, x, z);
        const err = waterBedError(sh.surface, sh.vertices[i * 3 + 2], terr);
        if (err > WATER_FLOAT_M) {
          hit(P_WATER, x, z, err, `bed ${err.toFixed(1)} m over the ground; the sheet hangs`, 'floating');
        } else if (terr - sh.surface > WATER_FLOAT_M) {
          // The other sign, and only the half of it a player can see. A bed the
          // terrain sits *over* is an ordinary DEM disagreement until the terrain
          // passes the water's own surface -- and then it is ground standing out
          // of a pond, which is the defect. Anything between is the 31.25 m
          // terrain post interpolating across a shoreline and is not counted.
          hit(P_WATER, x, z, terr - sh.surface, `ground ${(terr - sh.surface).toFixed(1)} m out of the water`, 'proud');
        }
      }
    }
    // A building standing under a surface. The sheet's own triangles decide
    // whether the footprint is in the water rather than a bounding box, because
    // a harbourside tile's box covers half the suburb behind it.
    for (const a of own.buildings) {
      const cx = (a.minX + a.maxX) / 2;
      const cz = (a.minZ + a.maxZ) / 2;
      for (const sh of water.sheets) {
        if (a.top >= sh.surface) continue;
        let inside = false;
        for (let k = 0; k + 2 < sh.indices.length && !inside; k += 3) {
          const tri: number[] = [];
          for (let e = 0; e < 3; e++) {
            const v = sh.indices[k + e];
            tri.push(ox + sh.vertices[v * 3], oz + sh.vertices[v * 3 + 1]);
          }
          if (Math.min(tri[0], tri[2], tri[4]) > cx || Math.max(tri[0], tri[2], tri[4]) < cx) continue;
          if (Math.min(tri[1], tri[3], tri[5]) > cz || Math.max(tri[1], tri[3], tri[5]) < cz) continue;
          if (inRing(tri, cx, cz)) inside = true;
        }
        if (!inside) continue;
        hit(P_BLD_W, cx, cz, sh.surface - a.top, `roof ${a.top.toFixed(1)} m, surface ${sh.surface.toFixed(1)} m`, 'building');
        break;
      }
    }
  }
}

// --- 10. the station boxes, once, globally ---------------------------------------
//
// Not in the tile loop: there are 270-odd stations and each writes a room, an
// access incline and a tunnel, so the whole population is under a thousand
// oriented boxes and walking it per tile would be a thousand pointless
// intersections a tile. `buildStationBoxes` is the same function `main.ts` and
// `server/world.ts` both call, so the boxes tested here are the boxes a body
// stands in.
{
  const bake: RailBake = decodeRail(readFileSync(RAIL_PATH).buffer.slice(0) as ArrayBuffer);
  const field = buildStationBoxes(bake);
  for (const box of field.boxes as StationBox[]) {
    const quad = obb(box.x, box.z, box.ux, box.uz, box.halfLength, box.halfWidth);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < 4; i++) {
      if (quad[i * 2] < minX) minX = quad[i * 2];
      if (quad[i * 2] > maxX) maxX = quad[i * 2];
      if (quad[i * 2 + 1] < minZ) minZ = quad[i * 2 + 1];
      if (quad[i * 2 + 1] > maxZ) maxZ = quad[i * 2 + 1];
    }
    if (centre !== null) {
      const dx = box.x - centre[0];
      const dz = box.z - centre[1];
      if (dx * dx + dz * dz > RADIUS * RADIUS) continue;
    }
    const seen = new Set<string>();
    for (let x = minX; x <= maxX + SIZE; x += SIZE) {
      for (let z = minZ; z <= maxZ + SIZE; z += SIZE) {
        const k = keyAt(x, z);
        if (seen.has(k) || !byKey.has(k)) continue;
        seen.add(k);
        for (const f of prismCache.get(k).buildings) {
          if (f.maxX < minX || f.minX > maxX || f.maxZ < minZ || f.minZ > maxZ) continue;
          // The lid, not the room: see BUDGET_STATION_IN_BUILDING.
          if (!bandsOverlap(box.floorY, box.ceilY - BOX_HEADROOM_M, f.base, f.top)) continue;
          const shared = clipArea(f.points, quad);
          if (shared < MIN_OVERLAP_M2) continue;
          const kind = box.name.endsWith(' access') ? 'access'
            : box.name.endsWith(' tunnel') ? 'tunnel' : 'room';
          hit(P_STN, box.x, box.z, shared, `${box.name}: ${shared.toFixed(0)} m2 inside a building`, kind);
        }
      }
    }
  }
}

// =====================================================================================
// The report
// =====================================================================================

const secs = (Date.now() - t0) / 1000;
say(
  `  ${tilesRead.toLocaleString()} tiles read in ${secs.toFixed(0)} s -- ` +
    `${stems.toLocaleString()} stems, ${furnItems.toLocaleString()} furniture, ` +
    `${carsSeen.toLocaleString()} parked cars, ${buildingsSeen.toLocaleString()} buildings, ` +
    `${structuresSeen.toLocaleString()} structures, ${waterVerts.toLocaleString()} water vertices`,
);
say('');
say('  pair                    what                                             count   budget      total');
for (const p of pairs.values()) {
  say(
    `  ${padR(p.id, 22)}  ${padR(p.what, 47)} ${pad(p.count.toLocaleString(), 9)} ${pad(p.budget.toLocaleString(), 8)} ` +
      `${pad(p.total.toFixed(0), 10)} ${p.unit}`,
  );
}

for (const p of pairs.values()) {
  if (p.count === 0) continue;
  p.worst.sort((a, b) => b.score - a.score);
  say('');
  const by = [...p.by.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v.toLocaleString()}`).join(', ');
  say(`  ${p.id} -- ${p.count.toLocaleString()} ${p.unit} (${by})`);
  for (const o of p.worst.slice(0, WORST)) {
    say(
      `    ${pad(o.score.toFixed(2), 9)}  (${pad(o.x.toFixed(0), 8)}, ${pad(o.z.toFixed(0), 8)})  ` +
        `${padR(streetAt(o.x, o.z) || '(unnamed)', 26)} ${o.note}`,
    );
  }
  if (p.count > WORST) say(`    ... and ${(p.count - WORST).toLocaleString()} more; --worst N for more`);
}

// =====================================================================================
// THE CONTROLS
// =====================================================================================
//
// **Twelve counts are worthless without twelve demonstrations that the scan can
// see one**, and several of these pairs measure numbers small enough that a
// blind predicate and a clean world are indistinguishable from the table above.
// Every predicate this file gates on is a pure function; each control drops a
// synthetic offender through the real one and asserts it is convicted, and where
// the *distinction* is the point -- a party wall against a real overlap, a tree
// under a viaduct against a tree in a lounge room -- it drops the legal case
// through too and asserts it is not.

function runControls(): string[] {
  const bad: string[] = [];
  const box = (cx: number, cz: number, h: number): Foot => {
    const pts = Float32Array.from([cx - h, cz - h, cx + h, cz - h, cx + h, cz + h, cx - h, cz + h]);
    return {
      points: pts, base: 10, top: 25,
      minX: cx - h, minZ: cz - h, maxX: cx + h, maxZ: cz + h, area: (2 * h) ** 2,
    };
  };

  // 1. TREE_IN_BUILDING -- a stem in the middle of a 20 m building, and the same
  //    stem 30 m away, which must not be named.
  const b = box(0, 0, 10);
  if (!pointInFoot(b, 0, 0, 10, 22)) bad.push('TREE_IN_BUILDING: a stem in the middle of a footprint is not inside it');
  if (pointInFoot(b, 30, 0, 10, 22)) bad.push('TREE_IN_BUILDING: a stem 30 m outside a footprint reads as inside it');
  // ...and a stem whose whole crown is under a raised podium is not this defect.
  if (pointInFoot({ ...b, base: 40, top: 60 }, 0, 0, 10, 22)) {
    bad.push('TREE_IN_BUILDING: a stem entirely under a raised structure is convicted, so the band test does nothing');
  }

  // 2. FURNITURE_ON_ROAD -- a post in the middle of a 12 m carriageway, and a
  //    post on the kerb line, which is where a post goes.
  const span = [{ x0: -50, z0: 0, x1: 50, z1: 0, hw: 6 }];
  const post = (x: number, z: number): number[] =>
    ccw([x - 0.3, z - 0.3, x + 0.3, z - 0.3, x + 0.3, z + 0.3, x - 0.3, z + 0.3]);
  if (onCarriageway(post(0, 0), span).area <= 0) {
    bad.push('FURNITURE_ON_ROAD: a post in the middle of a carriageway is not on it, so the sweep is broken');
  }
  if (onCarriageway(post(0, 6.1), span).area > 0) {
    bad.push(`FURNITURE_ON_ROAD: a post 0.1 m outside the kerb is convicted; KERB_INSET_M is ${KERB_INSET_M} and does nothing`);
  }

  // 3. BUILDING_IN_BUILDING -- a real overlap against a party wall. This is the
  //    control the pair exists for: without the fraction test the count is
  //    every terrace in the inner west.
  const a1 = box(0, 0, 10);
  const a2 = box(12, 0, 10);          // 8 m of genuine overlap, 160 m2
  const party = box(20.05, 0, 10);    // touching, 0.1 m of quantisation
  if (footOverlap(a1, a2) <= 0) bad.push('BUILDING_IN_BUILDING: two footprints overlapping by 160 m2 are not convicted');
  if (footOverlap(a1, party) > 0) {
    bad.push('BUILDING_IN_BUILDING: a party wall 0.1 m deep is convicted, so the count is terraces');
  }

  // 3b. ...and the arithmetic under it. `overlapArea` is the one function in
  //     this file that can be wrong by an amount that still looks plausible, and
  //     the unsigned version shipped a shared area larger than the building it
  //     was shared with. Two assertions: a square wholly inside another gives
  //     exactly its own area, and an **L** -- the concave case the sign exists
  //     for -- gives the true overlap and not the pocket. The L below is a 20 m
  //     square with its north-east 10 m quadrant bitten out, so its area is
  //     300 m2 and the 10 m square sitting in the bite must share nothing.
  const outer = [-10, -10, 10, -10, 10, 10, -10, 10];
  const inner = [-5, -5, 5, -5, 5, 5, -5, 5];
  if (Math.abs(overlapArea(inner, outer) - 100) > 0.01) {
    bad.push(`overlapArea: a 10 m square inside a 20 m square shares ${overlapArea(inner, outer).toFixed(1)} m2, not 100`);
  }
  const ell = [-10, -10, 10, -10, 10, 0, 0, 0, 0, 10, -10, 10];
  const bite = [0.5, 0.5, 9.5, 0.5, 9.5, 9.5, 0.5, 9.5];
  if (overlapArea(bite, ell) > 0.01) {
    bad.push(
      `overlapArea: a square in the notch of an L shares ${overlapArea(bite, ell).toFixed(1)} m2 with it. ` +
        'The fan is unsigned and every reflex pocket in the build is being counted as building.',
    );
  }
  if (Math.abs(overlapArea(ell, ell) - 300) > 0.01) {
    bad.push(`overlapArea: an L against itself shares ${overlapArea(ell, ell).toFixed(1)} m2, not its own 300`);
  }

  // 3c. `depthInRing`, which sorts four of the twelve tables.
  if (Math.abs(depthInRing(outer, 0, 0) - 10) > 0.01) {
    bad.push(`depthInRing: the centre of a 20 m square reads ${depthInRing(outer, 0, 0).toFixed(2)} m in, not 10`);
  }
  if (depthInRing(outer, 20, 0) !== 0) bad.push('depthInRing: a point outside a ring is reported as inside it');

  // 3d. `segRingDistance`, which decides whether a viaduct is inside a train.
  //     A line straight across the square, one alongside it, one far off.
  if (segRingDistance(-20, 0, 20, 0, outer).d !== 0) {
    bad.push('segRingDistance: a line straight through a footprint is not touching it, so a deck across a track reads clear');
  }
  if (Math.abs(segRingDistance(-20, 14, 20, 14, outer).d - 4) > 0.01) {
    bad.push(`segRingDistance: a line 4 m clear of a footprint reads ${segRingDistance(-20, 14, 20, 14, outer).d.toFixed(2)} m`);
  }

  // 4. CAR_IN_CAR -- two sedans in one bay, and two in the bay behind.
  const one = obb(0, 0, 1, 0, 2.3, 0.9);
  const same = obb(1.0, 0, 1, 0, 2.3, 0.9);
  const behind = obb(6.0, 0, 1, 0, 2.3, 0.9);
  if (polyArea(clipPoly(one.slice(), same)) < MIN_OVERLAP_M2) {
    bad.push('CAR_IN_CAR: two cars a metre apart do not overlap, so the body box is wrong');
  }
  if (polyArea(clipPoly(one.slice(), behind)) >= MIN_OVERLAP_M2) {
    bad.push('CAR_IN_CAR: two cars parked nose to tail are convicted, so every kerb in the city is a defect');
  }

  // 5. RAIL_GAUGE -- a pole on the centreline at platform height, and the same
  //    pole four metres out, which is where the fence goes.
  if (gaugeDepth(0, 0, 0.5, 4.0) <= 0) bad.push('RAIL_GAUGE: an object on the centreline at body height is not in the gauge');
  if (gaugeDepth(4, 0, 0.5, 4.0) > 0) bad.push('RAIL_GAUGE: an object 4 m from the centreline is in the gauge, so everything lineside is');
  if (gaugeDepth(0, 0, 8.0, 9.0) > 0) {
    bad.push('RAIL_GAUGE: an object 8 m over the railhead is in the gauge, so the height band does nothing');
  }

  // 6. WATER_OVER_TERRAIN -- a sheet whose bed is 3 m over the ground, and one
  //    that agrees with it.
  if (waterBedError(0, 1, -4) <= WATER_FLOAT_M) bad.push('WATER_OVER_TERRAIN: a bed 3 m over the terrain is not named');
  if (Math.abs(waterBedError(0, 4, -4)) > WATER_FLOAT_M) {
    bad.push('WATER_OVER_TERRAIN: a bed that agrees with the terrain is named, so every sheet in the harbour is');
  }

  // 7. The rail index itself. A gauge test over an empty index would pass every
  //    control above and convict nothing in the world, which is exactly the
  //    "the scan is blind" failure this family exists to refuse.
  if (railSegs.length < 1000) {
    bad.push(`RAIL_GAUGE: the rail index holds ${railSegs.length} spans, so nothing in the world was tested against a train`);
  }
  // And it has to be able to convict a real place: a synthetic object dropped on
  // a real running line's own first vertex must be named by the real index.
  if (railSegs.length > 0) {
    const s = railSegs[Math.floor(railSegs.length / 2)];
    const mx = (s.ax + s.bx) / 2;
    const mz = (s.az + s.bz) / 2;
    const my = (s.ay + s.by) / 2;
    if (railFoul(mx, mz, my + 0.5, my + 3.5, 0.2) <= 0) {
      bad.push(`RAIL_GAUGE: a post dropped on the running line at (${mx.toFixed(0)}, ${mz.toFixed(0)}) is not found by the index`);
    }
    if (railFoul(mx + 40, mz + 40, my + 0.5, my + 3.5, 0.2) > 0) {
      bad.push('RAIL_GAUGE: a post 56 m from the line is inside the gauge, so the plan test does nothing');
    }
  }

  // 8. The terrain read, which four pairs rest on. Row 0 is the northern edge and
  //    the mirrored reading is 6.9 m out; if the grid ever transposes, the deck
  //    and water pairs silently become noise. Asserted against the poles' own
  //    `groundY`, which the pipeline wrote from its own DEM.
  let checked = 0;
  let sum = 0;
  for (const t of tiles) {
    if (checked >= 2000) break;
    const buf = readTile(t.key, 'power.bin');
    if (buf === null) continue;
    const pw = decodePower(buf);
    const g = groundCache.get(t.key);
    if (pw === null || g === null) continue;
    for (let i = 0; i < pw.poleCount && checked < 2000; i++) {
      const x = t.bounds[0] + pw.x[i];
      const z = t.bounds[1] + SIZE + pw.z[i];
      sum += Math.abs(sampleGround(g, t, x, z) - pw.groundY[i]);
      checked++;
    }
  }
  const mean = checked === 0 ? Infinity : sum / checked;
  if (!(mean < 0.25)) {
    bad.push(
      `the terrain read disagrees with TilePower.groundY by a mean of ${mean.toFixed(2)} m over ${checked} poles. ` +
        'Row 0 is the northern edge; if that has changed, DECK_UNDER_TERRAIN and WATER_OVER_TERRAIN are noise.',
    );
  } else {
    say('');
    say(`  control: terrain agrees with ${checked} poles' own groundY to a mean of ${(mean * 1000).toFixed(0)} mm`);
  }
  return bad;
}

const control = runControls();
say('');
if (control.length > 0) {
  for (const line of control) say(`  CONTROL FAILED: ${line}`);
} else {
  say('  control: every pair convicts a synthetic offender and excuses its legal neighbour');
}

// =====================================================================================
// The verdict
// =====================================================================================

if (centre !== null || SAMPLE > 1 || TUNED) {
  say('');
  say(
    TUNED
      ? '  (--kerb-inset asks a different question from the one the budgets were set against, so this run cannot gate)'
      : '  (a --near or --sample run measures part of the build and cannot move a ratchet; run it whole to gate)',
  );
  process.exit(control.length > 0 ? 1 : 0);
}

const fail: string[] = [...control];
for (const p of pairs.values()) {
  if (p.count > p.budget) {
    fail.push(`${p.id}: ${p.count.toLocaleString()} ${p.unit} against a budget of ${p.budget.toLocaleString()}`);
  }
}
say('');
if (fail.length > 0) {
  for (const line of fail) say(`  FAIL: ${line}`);
  say('');
  say('  The tables above name the street. Lower a budget when a retile lowers its measurement;');
  say('  raising one needs the new number written down beside it -- see the header.');
  process.exit(1);
}
say('  PASS -- every pair is at or under its budget.');
process.exit(0);
