/**
 * Every station in the bake, seven ways, with no human walking anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS, AND WHAT IT IS ALLOWED TO CLAIM
 *
 * Every rail defect found in the week before this was written was found by a
 * person walking into it, and several of them were reported *fixed* on checks
 * that could not have seen them:
 *
 *   - an extent-wide "0 m2 of drawn carriageway removed" that sampled
 *     carriageways only, while the player fell through a plaza beside one;
 *   - a platform field whose arithmetic was perfect at 358 sites while no body
 *     could be walked onto a deck at Newtown or Roseville, because every
 *     assertion in the suite queried the model and none of them drove a body.
 *
 * So the rule this file is written to, and the one to judge any addition to it
 * by: **if a check cannot fail on today's code at a station where the player
 * found a defect, it is not a check.** Where an assertion here would pass at
 * every station, it is treated as a suspect rather than as good news, and it
 * carries a negative control that proves it can go red -- see `runControls`.
 *
 * The seven, in the order the coordinator asked for them:
 *
 *   1. **reach**   -- from a real footpath outside, a body driven through
 *                     `player/controller.step` against `player/collision` ends
 *                     up standing on a platform deck. Not pathfound over an
 *                     abstraction; not answered by `PlatformField`.
 *   2. **stand**   -- a body on the deck walks its whole length and is still on
 *                     it, neither dropped, sunk nor lifted onto a roof.
 *   3. **holes**   -- dense sampling over the station envelope: wherever ground
 *                     is *drawn* a body is supported; a body walked at the
 *                     corridor from walkable ground does not end up in it; and
 *                     the ground the client computes is the ground the server
 *                     computes, bit for bit.
 *   4. **clear**   -- nothing solid inside the loading gauge, and no rail asset
 *                     -- fence, mast, coping, platform deck -- standing in a
 *                     drawn paved surface, on the *wide* definition of paving.
 *   5. **ttt**     -- no two carriages of two different trains ever occupy the
 *                     same world space. Geometric, in metres, independent of
 *                     the block model, because the block model already reports
 *                     zero violations while the player watches trains cross.
 *   6. **tworld**  -- no carriage intersects a building prism, a paved surface
 *                     or the terrain along its run past this station.
 *   7. **vert**    -- `RAIL-VERTICAL.md`: the label agrees with the measured
 *                     clearance, no drawn non-tunnel track sits under the
 *                     visible surface without a trench, and the deck stands the
 *                     right height over its own railhead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT RUNS AGAINST
 *
 * The **shipping path**, flag off. `SYDNEY_VESSELS` is not set here and must
 * not be: `STATIONS.md`'s vessel work is Phase 2 and behind a flag, and a suite
 * that measured the flagged world would be scoring geometry no player has.
 *
 * Two worlds are compared at every sample, and they are the two that exist:
 *
 *   - **the server's**, which is `server/world.groundFor` over
 *     `server/world.loadWorld`'s collision -- the pipeline's prisms and nothing
 *     else, because this process has never had a renderer;
 *   - **the client's**, which is `main.ts`'s `groundHeightAt` restated line for
 *     line over the same collision world *with `world/rail-geo.RailWorld`'s
 *     prisms added to it* -- trench walls, viaduct decks and piers, footbridge
 *     spans, station buildings, access stairs, subway shafts.
 *
 * The rail prisms are attached and detached around each sample pass through
 * `RailSolids`, which is a two-method interface `rail-geo` already takes, so
 * "with the railway drawn" and "without it" are the same collision world a
 * `removeTile` apart rather than two loads of a 300 MB city.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 *
 * Nothing here reads a wall clock. The train instants are
 * `(k + 1/2) * bake.cycleS / K` for a fixed K, which is a function of the bake;
 * the walks are fixed-step at 60 Hz through the same `step` the browser calls;
 * the sample lattices are derived from each station's own frame. Two runs on
 * two machines produce the same scorecard, and that is asserted rather than
 * hoped for -- see the `ttt` sweep, which is re-run against a second module
 * instance.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT STILL CANNOT SEE, SAID OUT LOUD
 *
 * Three gaps, each of which would let a real defect through, written here
 * because a suite whose limits are undocumented is the thing this one replaces.
 *
 *   1. **The drawn world is modelled, not rasterised.** "Is the DEM sheet drawn
 *      at this point" is `RailCut.cutAt`, which is exactly the predicate
 *      `terrain.buildTerrainMesh` uses to drop a sub-quad, so that half is
 *      faithful. But `world/rail-geo.ts`'s own geometry -- the trench floor, the
 *      cess, the coping, the canopy -- is only checked where it also registers a
 *      **collision prism**, and it draws a good deal that it does not. A
 *      triangle drawn with nothing solid under it, or a floor rail-geo declined
 *      to build inside a hole the carve opened, is invisible here. Closing it
 *      means rasterising `rail.group`'s buffers into a top-surface field over
 *      each envelope; it is a day's work and it is the next thing this file
 *      should grow.
 *   2. **Paving is what `lanes.py` exports.** Check 4 asks `RoadDeck.deckAt`,
 *      which is the wide reading -- carriageway plus footway -- and is the right
 *      question. A plaza `streets.py` draws with no centreline behind it is in
 *      neither the deck nor this check, which is precisely how King Street got
 *      through. The foot-paving round lands that geometry in `RoadDeck`, and
 *      when it does this check gets it for nothing and with no change here.
 *   3. **Check 3's analytic half is weak on its own** and is known to be. Where
 *      the terrain stands, `clientGround` returns the terrain, so "drawn ground
 *      is supported" is close to a tautology and fires only where a roof, a box
 *      floor or a platform intercepts underneath. That is why a share of the
 *      lattice is handed to a falling body instead, and why the rim is walked
 *      rather than measured: the arithmetic is the cheap sweep and the body is
 *      the assertion.
 *
 * ---------------------------------------------------------------------------
 * HOW TO RUN IT
 *
 *     bun run server/integration-check.ts                 # not included; see below
 *     SYDNEY_CHECK_ONLY=stations bun run server/integration-check.ts
 *     SYDNEY_CHECK_ONLY=stations SYDNEY_STATION=Redfern bun run server/integration-check.ts
 *     SYDNEY_CHECK_ONLY=stations SYDNEY_STATIONS_DEEP=1 bun run ...   # the deep sweep
 *
 * It is **not** in the default `main()` run, and that is a decision rather than
 * an oversight: on today's world it is red at most stations, and folding a
 * hundred honest failures into the file that gates every commit would stop the
 * suite from being usable for anything else while the burn-down runs. It is one
 * `SYDNEY_CHECK_ONLY` branch in `integration-check.ts`, so wiring it into the
 * default run once the queue is empty is a two-line change.
 */

import { readFile } from 'node:fs/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  createTrainPose,
  liveTripCount,
  poseTrain,
  railAt,
  tripIndexAt,
  type RailBake,
  type RailDirection,
  type TrainPose,
} from '../client/src/game/rail.ts';
import {
  PLATFORM_HALF_LENGTH_M,
  PLATFORM_INNER_M,
  PLATFORM_OUTER_M,
  PLATFORM_TOP_M,
  PLATFORM_WIDTH_M,
  carFrameAt,
  consistOf,
  consistOffset,
  createCarFrame,
  type CarFrame,
  type PlatformSite,
} from '../client/src/game/riding.ts';
import { EYE_HEIGHT, createPlayerState, step } from '../client/src/player/controller.ts';
import { drawnAsTunnel } from '../client/src/world/rail-cut.ts';
import { loadWorld, type ServerWorld } from './world.ts';
import type { PedBand } from '../client/src/game/pedestrians.ts';

// --- The seven columns ------------------------------------------------------------

/**
 * The scorecard's columns, in the coordinator's own order.
 *
 * A tuple rather than an enum because it is also the header row of the table
 * this writes to disk, and a second list of names beside it is a second list to
 * keep in step.
 */
const CHECKS = ['reach', 'stand', 'holes', 'clear', 'ttt', 'tworld', 'vert'] as const;
type CheckId = (typeof CHECKS)[number];

/**
 * One cell.
 *
 * `n/a` is a real answer and is not a pass: a station nothing calls at has no
 * platform to reach, and scoring it green would put 77 free rows on the card.
 * `skip` is the world's fault rather than the station's -- outside the built
 * extent, or on ground the pipeline emitted no tile for.
 */
type Verdict = 'PASS' | 'FAIL' | 'n/a' | 'skip';

interface Row {
  name: string;
  /** Metres from Central's platform anchor. The order the queue is worked in. */
  dist: number;
  served: boolean;
  verdicts: Record<CheckId, Verdict>;
  /** One line per failing check, naming the measurement. Goes on the card. */
  notes: Partial<Record<CheckId, string>>;
}

/**
 * The stations a player has already reported, by name.
 *
 * Not an allow-list and not a filter: the suite runs over all 267 either way.
 * These get their own block on the card so that "does the suite see what the
 * player saw" is answerable at a glance, which is the one question that decides
 * whether any of the rest of the numbers are worth reading.
 */
const KNOWN_BROKEN = [
  'Central', 'Redfern', 'Erskineville', 'Newtown', 'St Peters', 'Sydenham',
  'Chatswood', 'Roseville', 'Lindfield',
] as const;

// --- Restated constants -----------------------------------------------------------
//
// Every number below belongs to a module this file is checking, and every one of
// them is **restated rather than imported**, on `checkRailCutting`'s own terms: a
// check that read the constant out of the module under test could not notice the
// module changing it. Where the value is also imported above -- the platform
// rectangle -- it is imported because the *geometry* of the rectangle is what is
// being driven over rather than asserted.

/** `world/rail-geo.MAST_HEIGHT`, `MAST_BASE_DROP`, `MAST_OFFSET`. */
const MAST_HEIGHT = 7.4;
const MAST_BASE_DROP = 0.25;
const MAST_OFFSET = 3.15;
/** `world/rail-geo.FENCE_OFFSET`, `FENCE_CLEAR`, `FENCE_HEIGHT`. */
const FENCE_OFFSET = 6.4;
const FENCE_CLEAR = 0.9;
const FENCE_HEIGHT = 1.8;
/** `world/rail-geo.TRENCH_COPING_RISE`. */
const TRENCH_COPING_RISE = 0.12;
/** `world/road-deck.DECK_THICKNESS_M`. */
const DECK_THICKNESS = 0.45;
/** `world/rail-geo.STAIR_INNER`/`STAIR_OUTER` midpoint and `ACCESS_ALONG`. */
const STAIR_MID = (PLATFORM_INNER_M + PLATFORM_WIDTH_M + 0.12 + PLATFORM_OUTER_M) / 2;
const ACCESS_ALONG = 44;
/** The middle of the passenger deck, across from the track centre. */
const DECK_MID = PLATFORM_INNER_M + PLATFORM_WIDTH_M / 2;

/**
 * The body of a carriage, in its own frame. Metres.
 *
 * `riding.INTERIORS` measures the *inside* of each vehicle off the shipped GLBs
 * -- bulkhead to bulkhead, and 1.30 to 1.42 m to the side walls. The outside is
 * that plus a bodyshell, and `consistOf().pitch` is the coupling pitch, which is
 * a body plus a gangway. So the box swept here is the pitch less a coupling, by
 * `CAR_GAP_M`, at the widest interior plus a wall.
 *
 * **These do not need to be exact and it is worth saying why**, because a
 * tolerance chosen to make a number look good is the failure mode this whole
 * file exists to catch. Two trains that pass through each other do so by tens of
 * metres of overlap along their whole length -- they are on the same centreline
 * -- so a 20 cm error in the half width changes no verdict anywhere. What the
 * dimensions must not do is *over*-state the vehicle, which would invent
 * overlaps between trains on adjacent tracks 4 m apart: at 1.6 m half width two
 * boxes on 4 m centres still have 0.8 m of daylight between them.
 */
const CAR_GAP_M = 0.6;
const CAR_HALF_WIDTH = 1.6;
/** The bodyshell over the railhead: above the bogies, under the pantograph. */
const CAR_FLOOR_OVER_RAIL = 0.4;
const CAR_ROOF_OVER_RAIL = 4.2;

/** `game/rail.SPAN_TUNNEL`. Restated; `drawnAsTunnel` is imported for the rule. */
const SPAN_TUNNEL = 1;

// --- Options ----------------------------------------------------------------------

interface Options {
  /** The deep sweep: finer lattices, longer walks, four times the train instants. */
  deep: boolean;
  /** One station by name, or null for the whole bake. */
  only: string | null;
}

function readOptions(): Options {
  const only = process.env.SYDNEY_STATION ?? '';
  return {
    // A single station is always deep. Nobody asks for one station and wants the
    // coarse answer: the reason to name a station is that it is on the queue.
    deep: process.env.SYDNEY_STATIONS_DEEP === '1' || only !== '',
    only: only === '' ? null : only,
  };
}

// --- The rail prisms, attachable ---------------------------------------------------

/**
 * `world/rail-geo.RailSolids`, with a hand on the switch.
 *
 * The client's collision world is the server's plus the railway's own solids,
 * and that difference *is* the thing check 3 measures -- so the two have to be
 * the same object in two states rather than two objects that might differ for
 * some other reason. `detach` takes every rail tile back out of the collision
 * world and keeps the prisms; `attach` puts them back. Nothing is rebuilt, so
 * the comparison is exact by construction.
 *
 * It also means the walks in checks 1 and 2 run against the world a browser
 * has: station buildings have walls, access stairs are climbable, and a
 * footbridge is something you can be standing on. A walk over the server's
 * collision alone would be a walk through the station wall, and would score
 * *better* than the truth.
 */
class RailPrisms {
  private readonly held = new Map<string, ReadonlyArray<{ points: Float32Array; height: number; base: number }>>();
  private attached = true;
  constructor(private readonly world: ServerWorld) {}

  addPrisms(key: string, prisms: ReadonlyArray<{ points: Float32Array; height: number; base: number }>): number {
    this.held.set(key, prisms);
    return this.attached ? this.world.collision.addPrisms(key, prisms) : 0;
  }

  removeTile(key: string): number {
    this.held.delete(key);
    return this.world.collision.removeTile(key);
  }

  /** How many rail tiles are standing in the collision world right now. */
  get tiles(): number {
    return this.held.size;
  }

  detach(): void {
    if (!this.attached) return;
    for (const key of this.held.keys()) this.world.collision.removeTile(key);
    this.attached = false;
  }

  attach(): void {
    if (this.attached) return;
    for (const [key, prisms] of this.held) this.world.collision.addPrisms(key, prisms);
    this.attached = true;
  }
}

// --- Geometry helpers ---------------------------------------------------------------

/** `player/collision.pointInPolygon`, which is not exported. Even-odd crossing. */
function pointInsidePolygon(points: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const zi = points[i * 2 + 1];
    const xj = points[j * 2];
    const zj = points[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** One carriage as an oriented box: centre, plan heading, half extents, and a Y span. */
interface CarBox {
  cx: number;
  cz: number;
  /** Unit plan heading. The box's long axis. */
  fx: number;
  fz: number;
  halfLength: number;
  halfWidth: number;
  y0: number;
  y1: number;
  /** `(line, direction, trip)`, as a tuple rather than a hash. See `whoOf`. */
  who: number;
  /** Which rail the block model says this carriage is on, or -1 off a block run. */
  rail: number;
  /** Is this carriage inside a bore? Then it is under the terrain on purpose. */
  tunnel: boolean;
  line: string;
  dirIndex: number;
  trip: number;
  car: number;
}

/**
 * The span flags at arc length `s` along a direction. `sampleAlong`'s search,
 * asked of `vertexFlags` instead of `vertices`.
 *
 * Needed by exactly one caller and it is check 6: a Metro carriage thirty
 * metres under George Street is not passing through the world, it is in a bore,
 * and a check that could not tell those apart would report the whole M1 as a
 * defect. Written out here rather than folded into `poseAll`'s sampler because
 * the sampler is `rail.ts`'s and must not grow a field for a check's benefit.
 */
function flagsAlong(bake: RailBake, dir: RailDirection, s: number): number {
  const c = bake.cum;
  let lo = dir.vertexOff;
  let hi = dir.vertexOff + dir.vertexCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (c[mid] <= s) lo = mid;
    else hi = mid - 1;
  }
  if (lo >= dir.vertexOff + dir.vertexCount - 1) lo = dir.vertexOff + dir.vertexCount - 2;
  return bake.vertexFlags[lo] | bake.vertexFlags[lo + 1];
}

/**
 * Do two oriented boxes overlap? Separating-axis, four axes, exact arithmetic.
 *
 * Two boxes in the plane with a shared up axis need only the four face normals:
 * a 2D OBB pair has no edge-cross axes to test. The Y test is an interval
 * overlap, because both boxes are upright -- a carriage leans on a grade by up
 * to two degrees and the bodyshell is 3.8 m tall, so treating it as upright
 * over-states its height by 7 cm and can only make this test *more* forgiving,
 * never less.
 */
function boxesOverlap(a: CarBox, b: CarBox): boolean {
  if (a.y1 <= b.y0 || b.y1 <= a.y0) return false;
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const axes = [a.fx, a.fz, -a.fz, a.fx, b.fx, b.fz, -b.fz, b.fx];
  for (let i = 0; i < 8; i += 2) {
    const nx = axes[i];
    const nz = axes[i + 1];
    const ra = Math.abs(a.fx * nx + a.fz * nz) * a.halfLength + Math.abs(-a.fz * nx + a.fx * nz) * a.halfWidth;
    const rb = Math.abs(b.fx * nx + b.fz * nz) * b.halfLength + Math.abs(-b.fz * nx + b.fx * nz) * b.halfWidth;
    if (Math.abs(dx * nx + dz * nz) > ra + rb) return false;
  }
  return true;
}

/**
 * How much of one carriage is inside the other, along the first one's own
 * length. Metres.
 *
 * **Deliberately not the minimum translation vector**, and the first version of
 * this file returned that and was misleading. Two trains on one centreline
 * running at each other overlap completely across their 3.2 m of width and by
 * fifteen or twenty metres along their length; the MTV picks the smallest axis,
 * reports 3.2 m, and reads like a graze. The number a reader wants for *"the
 * trains pass through each other"* is the long one, so this projects onto the
 * axis that carries the meaning.
 *
 * Only ever called on a pair `boxesOverlap` has already accepted, so it cannot
 * be negative.
 */
function overlapAlong(a: CarBox, b: CarBox): number {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const reach = Math.abs(b.fx * a.fx + b.fz * a.fz) * b.halfLength +
    Math.abs(-b.fz * a.fx + b.fx * a.fz) * b.halfWidth;
  return a.halfLength + reach - Math.abs(dx * a.fx + dz * a.fz);
}

/**
 * A trip's identity for this sweep: the tuple, not a hash.
 *
 * `rail.trainIdentity` would read better and would be wrong here for the reason
 * `separationSweep` gives about its own `who`: a 32-bit hash can collide, and a
 * collision in *this* function hides an overlap by making two trains look like
 * one train, which is the failure mode the whole check exists to find.
 */
function whoOf(lineIndex: number, dirIndex: number, trip: number): number {
  return (lineIndex * 2 + dirIndex) * 1_000_003 + (((trip % 100_000) + 100_000) % 100_000);
}

// --- Posing every train at one instant -----------------------------------------------

/**
 * Every carriage in the city at time `t`, as world-space boxes.
 *
 * Posed through **`poseTrain` and `carFrameAt`** -- the very functions
 * `world/trains.ts` calls to place the model a player looks at -- rather than
 * through any re-derivation, because a check that re-derived the pose would be
 * asserting that its own arithmetic does not self-intersect. The consist, the
 * pitch and the per-carriage arc length are `riding.consistOf` and
 * `riding.consistOffset`, which is the same pair the renderer and the rider
 * code share.
 */
function poseAll(
  bake: RailBake, t: number, pose: TrainPose, frame: CarFrame, pool: CarBox[],
): number {
  let n = 0;
  for (let li = 0; li < bake.lines.length; li++) {
    const line = bake.lines[li];
    for (const dir of line.dirs) {
      const live = liveTripCount(dir);
      for (let j = 0; j <= live; j++) {
        const trip = tripIndexAt(dir, t, j);
        if (!poseTrain(bake, dir, trip, t, pose)) continue;
        const consist = consistOf(dir, trip);
        const cars = consist.cars.length;
        const who = whoOf(li, dir.index, trip);
        const rail = railAt(dir, pose.s);
        for (let c = 0; c < cars; c++) {
          const s = consistOffset(pose.s, c, cars, consist.pitch);
          carFrameAt(bake, dir, s, consist.cars[c].flip, frame);
          // **Pooled, and it is the difference between a minute and ten
          // seconds.** The deep sweep poses six million carriages; allocating
          // an object for each of them spends the whole run in the collector,
          // and nothing downstream keeps a box past the instant it was made.
          let b = pool[n];
          if (b === undefined) {
            b = {
              cx: 0, cz: 0, fx: 1, fz: 0, halfLength: 0, halfWidth: 0, y0: 0, y1: 0,
              who: 0, rail: -1, tunnel: false, line: '', dirIndex: 0, trip: 0, car: 0,
            };
            pool[n] = b;
          }
          b.cx = frame.ox;
          b.cz = frame.oz;
          b.fx = frame.fx;
          b.fz = frame.fz;
          b.halfLength = consist.pitch / 2 - CAR_GAP_M / 2;
          b.halfWidth = CAR_HALF_WIDTH;
          b.y0 = frame.oy + CAR_FLOOR_OVER_RAIL;
          b.y1 = frame.oy + CAR_ROOF_OVER_RAIL;
          b.who = who;
          b.rail = rail;
          b.tunnel = (flagsAlong(bake, dir, s) & SPAN_TUNNEL) !== 0;
          b.line = line.id;
          b.dirIndex = dir.index;
          b.trip = trip;
          b.car = c;
          n++;
        }
      }
    }
  }
  return n;
}

// --- Check 5: trains through trains ---------------------------------------------------

/**
 * Why two carriages of two different trains are in the same place.
 *
 * The three mechanisms the measurement actually found, named rather than
 * lumped, because they need three different fixes and belong to three different
 * owners:
 *
 *   - `opposite-slot`: the two are on the **same block** running **opposite
 *     ways**, so `rail.railKey` calls them different rails and the separation
 *     solver is, on its own terms, correct. It is correct about a double-track
 *     railway drawn as two tracks. The bake draws both directions on **one
 *     centreline** over much of the network, so the two rails are the same
 *     steel and the trains cross in plain sight. The fix is in the bake's
 *     geometry, not in the timetable.
 *   - `same-rail`: same block, same slot. A genuine headway violation, and one
 *     `separationSweep` should already have caught. A non-zero count here is
 *     the block model disagreeing with itself.
 *   - `same-service`: two trips of the **same direction**. The block model
 *     separates them by `physics.sepS` *seconds*; a train is 163 m of *metres*.
 *     Near a station, where the leader is standing in a 15 s dwell, a legal time
 *     gap is not a legal distance gap and the follower's nose arrives inside the
 *     leader's tail.
 *   - `cross-line`: different lines, different blocks, coincident geometry. Two
 *     services the bake believes are on separate railways and the drawing puts
 *     on one.
 */
type OverlapKind = 'opposite-slot' | 'same-line-both-ways' | 'same-rail' | 'same-service' | 'cross-line';

/** Every kind, in the order the report prints them. Headline mechanism first. */
const OVERLAP_KINDS: readonly OverlapKind[] = [
  'opposite-slot', 'same-line-both-ways', 'cross-line', 'same-service', 'same-rail',
];

interface OverlapCluster {
  kind: OverlapKind;
  key: string;
  count: number;
  worst: number;
  x: number;
  z: number;
}

interface TrainSweep {
  instants: number;
  boxes: number;
  pairsTested: number;
  overlaps: number;
  worst: number;
  clusters: OverlapCluster[];
  /** Overlap sites, for attributing a failure to the station it happens at. */
  sites: Array<{ x: number; z: number; depth: number; kind: OverlapKind; key: string }>;
  byKind: Record<OverlapKind, number>;
}

function classify(a: CarBox, b: CarBox): OverlapKind {
  if (a.line === b.line && a.dirIndex === b.dirIndex) return 'same-service';
  if (a.rail >= 0 && a.rail === b.rail) return 'same-rail';
  // The block is the rail without its slot. Same block, different rail means
  // the two are running through the same section in opposite directions.
  if (a.rail >= 0 && b.rail >= 0 && a.rail >> 1 === b.rail >> 1) return 'opposite-slot';
  // The same line's up and down roads, on two *different* blocks that the bake
  // has nonetheless drawn on one centreline. Told apart from `cross-line`
  // because it is the headline mechanism and the first report read `T2:0 x
  // T2:1 -- cross-line`, which is two directions of the T2 called two lines.
  if (a.line === b.line) return 'same-line-both-ways';
  return 'cross-line';
}

/**
 * The world-space separation sweep. **Independent of the block model.**
 *
 * `rail.separationSweep` walks the same clock and asks which *rail* each train
 * is on; it reports 1,033,022 occupancies and zero violations, and the player
 * can see trains crossing. Both are true, and the only way to hold both is to
 * measure metres instead of block ids -- which is what this does. The block id
 * is read here for one purpose only, and it is diagnosis: it says *which* of the
 * mechanisms above produced each overlap.
 *
 * The broad phase is a uniform grid at `CELL_M`, rebuilt per instant. Every box
 * is filed into the cells its plan bounding circle touches, and a pair is
 * narrow-phased once however many cells it shares -- the `seen` set is what
 * makes `pairsTested` an honest number rather than a count with duplicates in
 * it.
 */
function sweepTrains(bake: RailBake, instants: number): TrainSweep {
  const pose = createTrainPose();
  const frame = createCarFrame();
  const pool: CarBox[] = [];
  const clusters = new Map<string, OverlapCluster>();
  const sites: TrainSweep['sites'] = [];
  const byKind: Record<OverlapKind, number> = {
    'opposite-slot': 0,
    'same-line-both-ways': 0,
    'same-rail': 0,
    'same-service': 0,
    'cross-line': 0,
  };
  const CELL_M = 32;
  let boxes = 0;
  let pairsTested = 0;
  let overlaps = 0;
  let worst = 0;

  const grid = new Map<number, number[]>();
  const seen = new Set<number>();
  for (let k = 0; k < instants; k++) {
    // Derived from the bake and nothing else. Half-open at both ends of the
    // cycle so no instant lands exactly on a departure, where a trip is being
    // created and its `age` is zero -- an edge worth sampling either side of
    // rather than exactly on.
    const t = ((k + 0.5) * bake.cycleS) / instants;
    const live = poseAll(bake, t, pose, frame, pool);
    boxes += live;

    grid.clear();
    for (let i = 0; i < live; i++) {
      const b = pool[i];
      const reach = b.halfLength;
      const c0 = Math.floor((b.cx - reach) / CELL_M);
      const c1 = Math.floor((b.cx + reach) / CELL_M);
      const r0 = Math.floor((b.cz - reach) / CELL_M);
      const r1 = Math.floor((b.cz + reach) / CELL_M);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cz = r0; cz <= r1; cz++) {
          const key = cx * 1_000_003 + cz;
          let bucket = grid.get(key);
          if (bucket === undefined) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
    seen.clear();
    for (const bucket of grid.values()) {
      for (let p = 0; p < bucket.length; p++) {
        for (let q = p + 1; q < bucket.length; q++) {
          const i = bucket[p];
          const j = bucket[q];
          const a = pool[i];
          const b = pool[j];
          if (a.who === b.who) continue;
          const pairKey = i < j ? i * 1_000_000 + j : j * 1_000_000 + i;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          pairsTested++;
          if (!boxesOverlap(a, b)) continue;
          overlaps++;
          const depth = overlapAlong(a, b);
          if (depth > worst) worst = depth;
          const kind = classify(a, b);
          byKind[kind]++;
          const ka = `${a.line}:${a.dirIndex}`;
          const kb = `${b.line}:${b.dirIndex}`;
          const key = ka <= kb ? `${ka} x ${kb}` : `${kb} x ${ka}`;
          const cluster = clusters.get(key);
          if (cluster === undefined) {
            clusters.set(key, { kind, key, count: 1, worst: depth, x: a.cx, z: a.cz });
          } else {
            cluster.count++;
            if (depth > cluster.worst) {
              cluster.worst = depth;
              cluster.x = a.cx;
              cluster.z = a.cz;
            }
          }
          // One site per overlap is a hundred thousand objects on the deep
          // sweep, and the only consumer is "which station is this at". A
          // 12 m lattice is finer than a platform is long and collapses the
          // set to the places rather than the instants.
          sites.push({ x: Math.round(a.cx / 12) * 12, z: Math.round(a.cz / 12) * 12, depth, kind, key });
        }
      }
    }
  }

  return {
    instants,
    boxes,
    pairsTested,
    overlaps,
    worst,
    clusters: [...clusters.values()].sort((p, q) => q.count - p.count),
    sites,
    byKind,
  };
}

/**
 * How far apart the up and down roads of each line are actually drawn.
 *
 * **The root cause behind `opposite-slot`, measured rather than asserted.**
 * `rail.railKey` says two trains running opposite ways through a block are on
 * different rails and are not a conflict, and that is right about a
 * double-track railway *drawn as two tracks four metres apart*. This walks one
 * direction's polyline and asks how far the other one is, and where the answer
 * is a few centimetres the two "different rails" are the same steel -- which is
 * exactly how a timetable with zero separation violations puts two trains
 * through each other in plain sight.
 *
 * Sampled every seventh vertex against every vertex of the other direction:
 * O(n*m) with n and m in the hundreds, which is milliseconds once.
 */
interface RoadPair {
  line: string;
  samples: number;
  coincidentShare: number;
  meanM: number;
}

function roadSeparation(bake: RailBake): RoadPair[] {
  const out: RoadPair[] = [];
  for (const line of bake.lines) {
    if (line.dirs.length < 2) continue;
    const [a, b] = line.dirs;
    let n = 0;
    let sum = 0;
    let coincident = 0;
    for (let i = a.vertexOff; i < a.vertexOff + a.vertexCount; i += 7) {
      const ax = bake.vertices[i * 3];
      const az = bake.vertices[i * 3 + 2];
      let best = Infinity;
      for (let j = b.vertexOff; j < b.vertexOff + b.vertexCount; j++) {
        const dx = bake.vertices[j * 3] - ax;
        const dz = bake.vertices[j * 3 + 2] - az;
        const d = dx * dx + dz * dz;
        if (d < best) best = d;
      }
      best = Math.sqrt(best);
      n++;
      sum += best;
      // Half a metre. Two tracks are four metres apart centre to centre and a
      // carriage is 3.2 m wide, so anything under half a metre is not a second
      // track at all -- it is the same line drawn twice.
      if (best < 0.5) coincident++;
    }
    if (n === 0) continue;
    out.push({ line: line.id, samples: n, coincidentShare: coincident / n, meanM: sum / n });
  }
  return out.sort((p, q) => q.coincidentShare - p.coincidentShare);
}

// --- Check 6: trains through the world -------------------------------------------------

/** The eight plan corners and mid-edges of a carriage box, for probing solids. */
function carPlanProbes(b: CarBox, out: number[]): void {
  out.length = 0;
  const px = -b.fz;
  const pz = b.fx;
  for (const along of [-b.halfLength + 0.5, 0, b.halfLength - 0.5]) {
    for (const across of [-b.halfWidth, 0, b.halfWidth]) {
      out.push(b.cx + b.fx * along + px * across, b.cz + b.fz * along + pz * across);
    }
  }
}

// --- The suite ---------------------------------------------------------------------

export interface StationSuiteResult {
  rows: Row[];
  sweep: TrainSweep;
  runtimeMs: number;
  cardPath: string;
}

/**
 * Run it.
 *
 * `emit` and `note` are `integration-check.ts`'s own `check` and `say`, passed
 * in rather than imported, so this file adds one branch to that file and no
 * shared state. See the header for why it is not in the default run.
 */
export async function runStationSuite(
  emit: (ok: boolean, line: string) => void,
  note: (line: string) => void,
): Promise<StationSuiteResult | null> {
  const began = performance.now();
  const opts = readOptions();
  note(
    `--- Stations: every station in the bake, seven ways, no camera and no keyboard ` +
      `(${opts.deep ? 'DEEP' : 'coarse'}${opts.only ? `, only ${opts.only}` : ''})`,
  );

  const root = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;
  const world = await loadWorld(root);
  const bake = world.rail;
  const field = world.platforms;
  const cut = world.railCut ?? null;
  const boxesField = world.stationBoxes ?? null;
  if (!bake || !field) {
    note('    this build carries no rail bake. Skipped.');
    return null;
  }
  if (world.vessels) {
    // The coordinator's constraint, asserted rather than trusted: the vessel
    // path is not what players get, and a suite that scored it would be
    // scoring a world behind a flag.
    emit(false, 'SYDNEY_VESSELS is set. This suite tests the shipping path and must be run with the flag down');
    return null;
  }

  /**
   * `world/rail-geo.ts`, structurally typed.
   *
   * `checkPlatformStanding`'s reason, restated because it bites in this file
   * too: `rail-geo` reaches for `document` to bake its sign textures, so a
   * `typeof import` of it drags the DOM lib into `server/tsconfig.json` and
   * `npm run typecheck` fails on a module that runs perfectly under bun.
   */
  const geoMod = (await import(new URL('../client/src/world/rail-geo.ts', import.meta.url).pathname)) as {
    buildNetwork(bake: unknown): {
      segments: Array<{
        ax: number; ay: number; az: number;
        bx: number; by: number; bz: number;
        ux: number; uz: number; len: number; flags: number;
      }>;
    };
    RailAssets: new () => unknown;
    RailWorld: new (
      net: unknown,
      assets: unknown,
      ground: (x: number, z: number) => number,
      solids: unknown,
      cut: unknown,
      rawGround: (x: number, z: number) => number,
    ) => { update(x: number, z: number): void };
  };

  // --- The two ground queries -----------------------------------------------------
  //
  // The server's is `server/world.groundFor`'s, restated here rather than called,
  // for one reason: `groundFor` closes over a `lastGround` that the *client*
  // query also has, and two closures sharing one variable would make the
  // comparison depend on the order the two were asked in. Restating gives each
  // its own, which is what the two processes actually have.
  const rails = new RailPrisms(world);
  const platforms = field;

  /**
   * `main.ts`'s `groundHeightAt`, to the line, with its three sources as
   * arguments.
   *
   * Arguments rather than closed-over constants for one reason and it is the
   * negative controls: the world *as it shipped last round* is this same
   * function with a `RailCut` that was never given roads, or with no platform
   * field at all, and building the control that way means the control cannot
   * drift from the rule -- there is no second code path to keep honest. See
   * `runWorldControls`.
   */
  const makeGround = (
    withPlatforms: typeof platforms | null,
    withCut: typeof cut,
  ): ((x: number, z: number, feetY: number) => number) => {
    let lastGround = 0;
    return (x: number, z: number, feetY: number): number => {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      const platform = withPlatforms === null ? -Infinity : withPlatforms.heightAt(x, z, feetY);
      const roof = world.collision.roofHeight(x, z, feetY);
      if (platform > -Infinity) return Math.max(platform, roof);
      const boxFloor = boxesField === null ? -Infinity : boxesField.floorAt(x, z, feetY);
      if (boxFloor > -Infinity) return Math.max(boxFloor, roof);
      const cutFloor = withCut === null ? Number.NaN : withCut.cutAt(x, z, sampled);
      if (Number.isFinite(cutFloor)) return Math.max(cutFloor, roof);
      return Math.max(lastGround, roof);
    };
  };
  /** The browser's, over a collision world the railway's solids are in. */
  const clientGround = makeGround(platforms, cut);
  /** This process's, over the same collision world with them taken back out. */
  const serverGround = makeGround(platforms, cut);

  const net = geoMod.buildNetwork(bake);
  const assets = new geoMod.RailAssets();
  const rawGround = (x: number, z: number): number => world.terrain.height(x, z);
  const rail = new geoMod.RailWorld(net, assets, rawGround, rails, cut, rawGround);

  // --- Walking ----------------------------------------------------------------------

  /** Walk toward a target for `secs` at 60 Hz, through the shipped controller. */
  const walk = (
    sx: number, sz: number, sy: number, tx: number, tz: number, secs: number,
    ground = clientGround,
  ): { x: number; z: number; feet: number } => {
    const s = createPlayerState(sx, sz);
    s.position.y = sy + EYE_HEIGHT;
    const steps = Math.round(secs * 60);
    for (let i = 0; i < steps; i++) {
      const yaw = Math.atan2(-(tx - s.position.x), -(tz - s.position.z));
      step(s, { forward: 1, right: 0, jump: false, sprint: false, yaw, pitch: 0 }, 1 / 60, world.collision, ground);
    }
    return { x: s.position.x, z: s.position.z, feet: s.position.y - EYE_HEIGHT };
  };

  /** Stand still and let gravity have its say. Where does the body come to rest? */
  const drop = (sx: number, sz: number, sy: number, secs: number, ground = clientGround): number => {
    const s = createPlayerState(sx, sz);
    s.position.y = sy + EYE_HEIGHT;
    const steps = Math.round(secs * 60);
    for (let i = 0; i < steps; i++) {
      step(s, { forward: 0, right: 0, jump: false, sprint: false, yaw: 0, pitch: 0 }, 1 / 60, world.collision, ground);
    }
    return s.position.y - EYE_HEIGHT;
  };

  /** Is this body standing on this platform's deck, in the platform's own frame? */
  const onDeck = (site: PlatformSite, p: { x: number; z: number; feet: number }): boolean => {
    const dx = p.x - site.x;
    const dz = p.z - site.z;
    const along = dx * site.ux + dz * site.uz;
    const across = Math.abs(dx * -site.uz + dz * site.ux);
    return (
      Math.abs(along) <= PLATFORM_HALF_LENGTH_M &&
      across >= PLATFORM_INNER_M && across <= PLATFORM_OUTER_M &&
      Math.abs(p.feet - (site.y + PLATFORM_TOP_M)) < 0.5
    );
  };

  // --- The station list, ordered by distance from Central --------------------------

  const central = bake.stations.find((s) => s.name === 'Central') ?? null;
  const originX = central?.siteX ?? 0;
  const originZ = central?.siteZ ?? 0;
  const sitesByName = new Map<string, PlatformSite[]>();
  for (const site of platforms.sites) {
    const list = sitesByName.get(site.name);
    if (list === undefined) sitesByName.set(site.name, [site]);
    else list.push(site);
  }

  const wanted = bake.stations
    .filter((s) => opts.only === null || s.name.toLowerCase() === opts.only.toLowerCase())
    .map((s) => ({ station: s, dist: Math.hypot(s.siteX - originX, s.siteZ - originZ) }))
    .sort((a, b) => a.dist - b.dist);
  if (wanted.length === 0) {
    emit(false, `SYDNEY_STATION=${opts.only} names no station in the bake`);
    return null;
  }

  // --- Check 5, once, for the whole city --------------------------------------------
  //
  // Global rather than per station, because a train is 163 m long and the pair
  // that crosses at Redfern is the same pair that crossed at Erskineville forty
  // seconds earlier. Run once, then attributed to whichever station each site
  // sits nearest.
  const INSTANTS = opts.deep ? 2880 : 720;
  const sweepBegan = performance.now();
  const sweep = sweepTrains(bake, INSTANTS);
  const sweepMs = performance.now() - sweepBegan;

  // Determinism, on `checkClearance`'s terms: a second module instance, a second
  // decode of the same bytes, and the identical answer. A sweep that depended on
  // module state would be a scorecard that changed between runs.
  {
    const two = (await import(
      `${new URL('../client/src/game/rail.ts', import.meta.url).pathname}?instance=2`
    )) as typeof import('../client/src/game/rail.ts');
    const bytes = await readFile(join(root, '..', 'rail', 'rail.bin'));
    const second = two.decodeRail(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    const control = sweepTrains(second, 32);
    const mine = sweepTrains(bake, 32);
    emit(
      control.overlaps === mine.overlaps && Object.is(control.worst, mine.worst),
      `the world-space train sweep is deterministic: a second decode of the same bake in a second ` +
        `module instance finds ${control.overlaps} overlaps to ${mine.overlaps}, worst ` +
        `${control.worst.toFixed(3)} m to ${mine.worst.toFixed(3)} m, compared with Object.is`,
    );
  }

  /** Overlap sites near a station, for the per-station verdict. */
  const siteGrid = new Map<number, Array<{ depth: number; kind: OverlapKind; key: string }>>();
  for (const s of sweep.sites) {
    const key = Math.round(s.x / 200) * 100_003 + Math.round(s.z / 200);
    let bucket = siteGrid.get(key);
    if (bucket === undefined) {
      bucket = [];
      siteGrid.set(key, bucket);
    }
    bucket.push({ depth: s.depth, kind: s.kind, key: s.key });
  }
  const overlapsNear = (x: number, z: number): Array<{ depth: number; kind: OverlapKind; key: string }> => {
    const out: Array<{ depth: number; kind: OverlapKind; key: string }> = [];
    const cx = Math.round(x / 200);
    const cz = Math.round(z / 200);
    for (let a = cx - 1; a <= cx + 1; a++) {
      for (let b = cz - 1; b <= cz + 1; b++) {
        const bucket = siteGrid.get(a * 100_003 + b);
        if (bucket) out.push(...bucket);
      }
    }
    return out;
  };

  // --- The per-station loop ------------------------------------------------------------

  const rows: Row[] = [];
  const pose = createTrainPose();
  const frame = createCarFrame();
  const carPool: CarBox[] = [];
  const bands: PedBand[] = [];
  const probes: number[] = [];
  let clientServerSamples = 0;
  let clientServerSplits = 0;
  let worstSplit = 0;
  let worstSplitAt = '';

  const builtRadius2 = world.index.radius_m * world.index.radius_m;
  const tileKeys = new Set(world.index.tiles.map((t) => t.key));
  const tileSize = world.index.tile_size;
  const onBuiltGround = (x: number, z: number): boolean =>
    x * x + z * z <= builtRadius2 &&
    tileKeys.has(`${Math.floor(x / tileSize)}_${Math.floor(-z / tileSize)}`);

  for (const { station, dist } of wanted) {
    // A line every twenty-five, because the coarse sweep is ten minutes and a
    // run that prints nothing for ten minutes is a run people stop trusting is
    // alive. It also puts the elapsed cost per station in the log, which is the
    // number to argue about when this moves into the default run.
    if (rows.length > 0 && rows.length % 25 === 0) {
      note(
        `    ... ${rows.length}/${wanted.length} stations, ${((performance.now() - began) / 1000).toFixed(0)} s ` +
          `(at ${station.name}, ${(dist / 1000).toFixed(1)} km out)`,
      );
    }
    const row: Row = {
      name: station.name,
      dist,
      served: station.servedDirs.length > 0,
      verdicts: { reach: 'n/a', stand: 'n/a', holes: 'n/a', clear: 'n/a', ttt: 'n/a', tworld: 'n/a', vert: 'n/a' },
      notes: {},
    };
    rows.push(row);

    const sx = station.siteX;
    const sz = station.siteZ;
    if (!onBuiltGround(sx, sz)) {
      for (const c of CHECKS) row.verdicts[c] = 'skip';
      continue;
    }

    // Bring the city under this station into memory: prisms, lanes, and the
    // carriageways the lane layer folds into the road deck. `settle` twice
    // because `update` starts reads and never awaits them, and the second call
    // is what promotes the hexagons the first one's arrival made reachable.
    if (world.segments) {
      world.segments.update([sx, sz]);
      await world.segments.settle();
      world.segments.update([sx, sz]);
      await world.segments.settle();
    }
    rail.update(sx, sz);

    const mySites = sitesByName.get(station.name) ?? [];

    // === 1. reach, and 2. stand ==================================================
    if (mySites.length > 0) {
      let reached = 0;
      let stayed = 0;
      const sealed: string[] = [];
      const slipped: string[] = [];
      const roofed: string[] = [];
      for (const site of mySites) {
        const top = site.y + PLATFORM_TOP_M;
        const nx = -site.uz;
        const nz = site.ux;

        // --- reach. Two families of start point, and the second is the one the
        //     coordinator asked for: *the public street or footpath outside*.
        //
        //     The four generated stair mouths are where `rail-geo` puts access
        //     by construction (RAIL-VERTICAL.md section 4), so a body that
        //     cannot get in from one of those cannot get in at all. The
        //     footpath starts are the honest version of the same question: a
        //     real `PedestrianField` band point within 150 m, which is a
        //     pavement the pipeline drew and a pedestrian walks on.
        const starts: Array<[number, number]> = [];
        for (const side of [-1, 1]) {
          for (const end of [1, -1]) {
            starts.push([
              site.x + site.ux * (ACCESS_ALONG + 22) * end + nx * STAIR_MID * side,
              site.z + site.uz * (ACCESS_ALONG + 22) * end + nz * STAIR_MID * side,
            ]);
          }
        }
        world.peds.near(site.x, site.z, 150, bands);
        // Deterministic: the nearest point of each of the first few bands in the
        // field's own order, not a random draw.
        let taken = 0;
        for (const band of bands) {
          if (taken >= (opts.deep ? 6 : 3)) break;
          let best = -1;
          let bestD = Infinity;
          for (let i = 0; i < band.count; i++) {
            const d = (band.x[i] - site.x) ** 2 + (band.z[i] - site.z) ** 2;
            if (d < bestD) {
              bestD = d;
              best = i;
            }
          }
          // A plain radius, and here it is the right shape where `samePlatform`
          // argues it is the wrong one: this is not asking "is this the same
          // platform", it is asking "is this start point safely *outside* the
          // station". Thirty metres clears the deck's 9.4 m half width in every
          // direction and clears most of its length too, so a band inside it is
          // dropped rather than risked -- a start that was already standing on
          // the platform would make this check pass by construction.
          if (best < 0 || bestD < 30 * 30) continue;
          starts.push([band.x[best], band.z[best]]);
          taken++;
        }

        let got = false;
        for (const [ax, az] of starts) {
          if (got) break;
          const ay = clientGround(ax, az, Infinity);
          if (!Number.isFinite(ay)) continue;
          const at = walk(ax, az, ay + 0.1, site.x + nx * DECK_MID, site.z + nz * DECK_MID, opts.deep ? 30 : 20);
          if (onDeck(site, at)) got = true;
        }
        if (got) reached++;
        else sealed.push(`${site.x.toFixed(0)},${site.z.toFixed(0)}`);

        // --- stand. The deck's whole length, both ways, and a drop test at the
        //     far end: a body that arrives on the deck and then sinks through it
        //     on the next tick has not stayed on it.
        let held = true;
        for (const dir of [1, -1]) {
          const from = -70 * dir;
          const to = 70 * dir;
          const p = walk(
            site.x + site.ux * from + nx * DECK_MID, site.z + site.uz * from + nz * DECK_MID, top + 0.1,
            site.x + site.ux * to + nx * DECK_MID, site.z + site.uz * to + nz * DECK_MID,
            opts.deep ? 20 : 14,
          );
          if (onDeck(site, p)) {
            const rest = drop(p.x, p.z, p.feet, 1.5);
            if (rest < top - 0.5) held = false;
            continue;
          }
          held = false;
          if (p.feet > top + 0.5 && world.collision.roofHeight(p.x, p.z, p.feet) >= p.feet - 0.05) {
            roofed.push(`${(p.feet - top).toFixed(1)} m up on a solid`);
          } else {
            slipped.push(`${(p.feet - top).toFixed(2)} m off`);
          }
        }
        if (held) stayed++;
      }
      row.verdicts.reach = reached === mySites.length ? 'PASS' : 'FAIL';
      if (reached !== mySites.length) {
        row.notes.reach = `${reached}/${mySites.length} decks reachable on foot; sealed at ${sealed.join(' ')}`;
      }
      row.verdicts.stand = stayed === mySites.length ? 'PASS' : 'FAIL';
      if (stayed !== mySites.length) {
        const bits: string[] = [];
        if (roofed.length) bits.push(`${roofed.length} lifted onto a solid (${roofed[0]})`);
        if (slipped.length) bits.push(`${slipped.length} left the deck (${slipped[0]})`);
        row.notes.stand = `${stayed}/${mySites.length} decks walkable end to end; ${bits.join('; ')}`;
      }
    }

    // === 3. holes ==================================================================
    //
    // Three claims over one lattice in the station's own frame.
    {
      const ux = station.siteDx || 1;
      const uz = station.siteDz || 0;
      const nx = -uz;
      const nz = ux;
      const ALONG = PLATFORM_HALF_LENGTH_M + 40;
      const ACROSS = 45;
      const stepM = opts.deep ? 1.5 : 3;

      let drawnUnsupported = 0;
      let invisibleSheet = 0;
      let sampled = 0;
      let worstDrop = 0;
      let worstAt = '';
      let split = 0;
      let stationWorstSplit = 0;
      let dropped = 0;
      let droppedThrough = 0;
      let worstDropThrough = 0;

      // **A body, on one sample in eight.** The analytic pass above is a claim
      // about two functions agreeing; this is a claim about a person. Every
      // check that shipped a hole passed an arithmetic test first, so a share
      // of the lattice is handed to `controller.step` with gravity on and
      // nothing else, and asked where it ends up. One in eight rather than all
      // of them because a drop is ninety fixed steps and the lattice is ten
      // thousand points; the stride is a constant so two runs drop at the same
      // places.
      const DROP_STRIDE = opts.deep ? 4 : 8;
      let lattice = -1;

      // **The lattice is walked twice and the railway is detached once**, which
      // is the difference between four seconds and forty. Taking the rail tiles
      // out of the collision world and putting them back is an index rebuild;
      // doing it per sample did it twenty thousand times a station and spent the
      // entire run in `addPrisms`. The client's answers are collected first, the
      // railway comes out, the server's are collected, and it goes back.
      const clientY: number[] = [];
      const spots: number[] = [];

      for (let a = -ALONG; a <= ALONG; a += stepM) {
        for (let c = -ACROSS; c <= ACROSS; c += stepM) {
          lattice++;
          const x = sx + ux * a + nx * c;
          const z = sz + uz * a + nz * c;
          const terr = world.terrain.height(x, z);
          if (!Number.isFinite(terr)) continue;
          sampled++;

          // `world/terrain.buildTerrainMesh` drops a sub-quad exactly when
          // `RailCut.cutAt` answers for its centre, and keeps it with a soffit
          // when `deckedAt` does. So "is the DEM sheet drawn here" is that one
          // predicate and not an approximation of it.
          const carved = cut !== null && Number.isFinite(cut.cutAt(x, z, terr));

          // -- 3a. the client's ground, with the railway's solids standing.
          const g = clientGround(x, z, terr + 0.1);
          if (!carved) {
            // Drawn terrain. A body standing on it must be held at it.
            const fall = terr - g;
            if (fall > 0.5) {
              drawnUnsupported++;
              if (fall > worstDrop) {
                worstDrop = fall;
                worstAt = `${x.toFixed(0)},${z.toFixed(0)}`;
              }
            }
          } else if (Math.abs(g - terr) < 0.05 && terr - (cut?.cutAt(x, z, terr) ?? terr) > 1) {
            // Carved away, and the ground query still answers with the DEM: an
            // invisible sheet across a visible railway, which is the exact
            // failure `groundFor`'s `cutAt` clause was added to kill.
            invisibleSheet++;
          }

          // -- 3a'. and the same question asked of a body rather than of a
          //    function. Started at the surface the ground query itself
          //    answers, so this is not "is the DEM right" a second time: it is
          //    "does a person standing where the ground is stay there".
          if (lattice % DROP_STRIDE === 0 && Number.isFinite(g)) {
            dropped++;
            const rest = drop(x, z, g + 0.1, 1.5);
            const through = g - rest;
            if (through > 1.0) {
              droppedThrough++;
              if (through > worstDropThrough) worstDropThrough = through;
            }
          }

          // -- 3b. client against server, exactly. Collected now, compared
          //    after the railway has come out of the collision world once.
          spots.push(x, z, terr);
          clientY.push(g);
        }
      }

      rails.detach();
      for (let i = 0, k = 0; i < spots.length; i += 3, k++) {
        const sg = serverGround(spots[i], spots[i + 1], spots[i + 2] + 0.1);
        clientServerSamples++;
        if (Object.is(clientY[k], sg)) continue;
        const gap = Math.abs(clientY[k] - sg);
        split++;
        clientServerSplits++;
        if (gap > stationWorstSplit) stationWorstSplit = gap;
        if (gap > worstSplit) {
          worstSplit = gap;
          worstSplitAt = `${station.name} at ${spots[i].toFixed(0)},${spots[i + 1].toFixed(0)}`;
        }
      }
      rails.attach();

      // -- 3c. can a body walk off drawn ground into the corridor?
      //
      //    The player's report, in one sentence: *"if i do jump onto the fenced
      //    section of road, i can fall through down into the railroad"*. Driven
      //    rather than measured: a body on the ground twelve metres out, walked
      //    straight at the centreline, must not finish at the railhead.
      let fellIn = 0;
      const rimSamples = opts.deep ? 13 : 7;
      for (let i = 0; i < rimSamples; i++) {
        const a = -ALONG + (2 * ALONG * i) / (rimSamples - 1);
        for (const side of [-1, 1]) {
          const ox = sx + ux * a + nx * 12 * side;
          const oz = sz + uz * a + nz * 12 * side;
          const terr = world.terrain.height(ox, oz);
          if (!Number.isFinite(terr)) continue;
          if (cut !== null && Number.isFinite(cut.cutAt(ox, oz, terr))) continue; // Already in it.
          const start = clientGround(ox, oz, terr + 0.1);
          if (!Number.isFinite(start)) continue;
          const at = walk(ox, oz, start + 0.1, sx + ux * a, sz + uz * a, 6);
          const rest = drop(at.x, at.z, at.feet, 1.5);
          if (rest < start - 2.0) fellIn++;
        }
      }

      const holeFail = drawnUnsupported > 0 || invisibleSheet > 0 || fellIn > 0 || droppedThrough > 0;
      row.verdicts.holes = sampled === 0 ? 'skip' : holeFail ? 'FAIL' : 'PASS';
      if (holeFail) {
        const bits: string[] = [];
        if (drawnUnsupported > 0) {
          bits.push(`${drawnUnsupported}/${sampled} drawn-ground samples unsupported (worst ${worstDrop.toFixed(1)} m at ${worstAt})`);
        }
        if (droppedThrough > 0) {
          bits.push(`${droppedThrough}/${dropped} bodies dropped through the surface they were standing on (worst ${worstDropThrough.toFixed(1)} m)`);
        }
        if (invisibleSheet > 0) bits.push(`${invisibleSheet} invisible sheets over a carved corridor`);
        if (fellIn > 0) bits.push(`${fellIn} of ${rimSamples * 2} bodies walked off the rim into the corridor`);
        row.notes.holes = bits.join('; ');
      }
      // The client/server split is reported and does **not** decide the cell.
      // It is a whole-city defect with one cause -- this process has no rail
      // geometry at all -- and putting it in every row would drown the station
      // specific findings the queue is meant to be worked from. It gets its own
      // assertion at the foot of this function.
      if (split > 0) {
        row.notes.holes = `${row.notes.holes ?? ''}${row.notes.holes ? '; ' : ''}` +
          `client/server ground splits at ${split} samples (worst ${stationWorstSplit.toFixed(1)} m)`;
      }
    }

    // === 4. clear ===================================================================
    {
      let gaugeIntruders = 0;
      let gaugeSampled = 0;
      let inPaving = 0;
      let pavingExplained = 0;
      let firstIntruder = '';
      let firstPaving = '';

      // -- 4a. the loading gauge. Every open-railway vertex in the envelope, with
      //    a body's worth of the gauge probed against the prisms that are there.
      const p = bake.vertices;
      const vf = bake.vertexFlags;
      // Against the **pipeline's** prisms only, and the railway comes out once
      // for the whole walk rather than once per probe: a trench wall inside its
      // own loading gauge is not what this asks about, and an index rebuild per
      // vertex is what made the first version of this file unrunnable.
      rails.detach();
      const scratch: Array<{ points: Float32Array; base: number; top: number }> = [];
      for (const line of bake.lines) {
        for (const dir of line.dirs) {
          if (sx + 400 < dir.minX || sx - 400 > dir.maxX || sz + 400 < dir.minZ || sz - 400 > dir.maxZ) continue;
          for (let i = dir.vertexOff; i < dir.vertexOff + dir.vertexCount; i++) {
            if ((vf[i] & SPAN_TUNNEL) !== 0) continue;
            const x = p[i * 3];
            const y = p[i * 3 + 1];
            const z = p[i * 3 + 2];
            if (Math.hypot(x - sx, z - sz) > 250) continue;
            gaugeSampled++;
            const around = world.collision.prismsWithin(x, z, 8, scratch as never);
            for (const probe of [y + 0.5, y + 2.0, y + 4.0]) {
              let hit = false;
              for (const prism of around) {
                if (probe < prism.base || probe >= prism.top) continue;
                if (!pointInsidePolygon(prism.points, x, z)) continue;
                hit = true;
                break;
              }
              if (!hit) continue;
              gaugeIntruders++;
              if (firstIntruder === '') firstIntruder = `${x.toFixed(0)},${z.toFixed(0)} at ${probe.toFixed(1)} m`;
              break;
            }
          }
        }
      }
      rails.attach();

      // -- 4b. rail furniture standing in a drawn paved surface.
      //
      //    **On the wide definition of paving**, which is `RoadDeck.deckAt`:
      //    `streets.py` buffers a centreline by `half_width + footpath_width`
      //    and draws the lot, and the narrow carriageway-only reading is what
      //    let King Street through. `RoadDeck` is filled from the same
      //    `.lanes.bin` the game reads, per hexagon, and the hexagons under this
      //    station are resident by the time this runs.
      //
      //    The honest limit, stated because a suite that hid it would be the
      //    thing it exists to replace: `lanes.py` exports ways, and a plaza that
      //    `streets.py` draws with no centreline behind it is in neither the
      //    deck nor this check. Foot paving is in flight elsewhere; when it
      //    lands in `RoadDeck` this check gets it for nothing.
      //    The call goes through a structural type rather than `RoadDeck`'s own
      //    because the foot-paving round is changing `deckAt`'s arity underneath
      //    this file: a draped paving strip carries no height and needs the
      //    ground the caller is about to use, exactly as `RailCut.cutAt` does.
      //    Passing the terrain height is the right argument under the new
      //    signature and is ignored under the old one, so this file is correct
      //    on either side of that change instead of racing it.
      const roads = world.roads;
      const deckOf = roads as unknown as { deckAt: (x: number, z: number, groundY?: number) => number } | undefined;
      const surfaceAt = (x: number, z: number): number =>
        deckOf === undefined ? Number.NaN : deckOf.deckAt(x, z, world.terrain.height(x, z));

      for (const seg of net.segments) {
        if (drawnAsTunnel(seg.flags)) continue;
        if (Math.hypot((seg.ax + seg.bx) / 2 - sx, (seg.az + seg.bz) / 2 - sz) > 300) continue;
        const px = -seg.uz;
        const pz = seg.ux;
        const steps = Math.max(1, Math.round(seg.len / 6));
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cx = seg.ax + seg.ux * (t * seg.len);
          const cz = seg.az + seg.uz * (t * seg.len);
          const railY = seg.ay + (seg.by - seg.ay) * t;
          for (const side of [-1, 1]) {
            const fo = Math.max(FENCE_OFFSET, (cut?.halfWidthAt(cx, cz) ?? FENCE_OFFSET) + FENCE_CLEAR);
            for (const [ox, top, what] of [
              [fo, railY + FENCE_HEIGHT, 'fence'],
              [cut?.halfWidthAt(cx, cz) ?? FENCE_OFFSET, railY + TRENCH_COPING_RISE, 'coping'],
            ] as Array<[number, number, string]>) {
              const x = cx + px * ox * side;
              const z = cz + pz * ox * side;
              const surface = surfaceAt(x, z);
              if (!Number.isFinite(surface)) continue;
              if (top <= surface - 0.05) continue;
              // Explained: the railway is genuinely above the road here, so its
              // own furniture standing over the deck is a viaduct, not a defect.
              if (railY > surface) {
                pavingExplained++;
                continue;
              }
              inPaving++;
              if (firstPaving === '') firstPaving = `${what} at ${x.toFixed(0)},${z.toFixed(0)}`;
            }
          }
        }
      }

      // The catenary masts, off the bake, same rule.
      {
        const st = bake.stanchions;
        const kinds = bake.stanchionKinds;
        for (let i = 0; i < kinds.length; i++) {
          const mx = st[i * 5];
          const my = st[i * 5 + 1];
          const mz = st[i * 5 + 2];
          if (Math.hypot(mx - sx, mz - sz) > 300) continue;
          const kind = kinds[i];
          const offset = kind === 2 ? 0 : MAST_OFFSET * (kind === 1 ? -1 : 1);
          const x = mx + -st[i * 5 + 4] * offset;
          const z = mz + st[i * 5 + 3] * offset;
          const top = my - MAST_BASE_DROP + MAST_HEIGHT;
          const surface = surfaceAt(x, z);
          if (!Number.isFinite(surface) || top <= surface - 0.05) continue;
          if (my > surface) {
            pavingExplained++;
            continue;
          }
          // The shipped rule: a mast whose head reaches the soffit is not drawn.
          if (top > surface - DECK_THICKNESS) continue;
          inPaving++;
          if (firstPaving === '') firstPaving = `mast at ${x.toFixed(0)},${z.toFixed(0)}`;
        }
      }

      // And the platform decks, which is the fourth asset class.
      for (const site of mySites) {
        const nx2 = -site.uz;
        const nz2 = site.ux;
        for (let a = -PLATFORM_HALF_LENGTH_M; a <= PLATFORM_HALF_LENGTH_M; a += 8) {
          for (const side of [-1, 1]) {
            for (let c = PLATFORM_INNER_M; c <= PLATFORM_OUTER_M; c += 2) {
              const x = site.x + site.ux * a + nx2 * c * side;
              const z = site.z + site.uz * a + nz2 * c * side;
              const surface = surfaceAt(x, z);
              if (!Number.isFinite(surface)) continue;
              const top = site.y + PLATFORM_TOP_M;
              if (top <= surface - 0.05) continue;
              if (site.y > surface) {
                pavingExplained++;
                continue;
              }
              // A kerb of slack: a deck flush with the road it meets is a
              // forecourt, not an obstruction. `checkRoadDeck`'s own allowance.
              if (top - surface <= 0.45) {
                pavingExplained++;
                continue;
              }
              inPaving++;
              if (firstPaving === '') firstPaving = `platform at ${x.toFixed(0)},${z.toFixed(0)}`;
            }
          }
        }
      }

      const clearFail = gaugeIntruders > 0 || inPaving > 0;
      row.verdicts.clear = gaugeSampled === 0 ? 'n/a' : clearFail ? 'FAIL' : 'PASS';
      if (clearFail) {
        const bits: string[] = [];
        if (gaugeIntruders > 0) bits.push(`${gaugeIntruders}/${gaugeSampled} gauge probes hit a building prism (${firstIntruder})`);
        if (inPaving > 0) bits.push(`${inPaving} rail assets stand in drawn paving (${firstPaving})`);
        if (pavingExplained > 0) bits.push(`${pavingExplained} explained by the railway being over the road`);
        row.notes.clear = bits.join('; ');
      }
    }

    // === 5. ttt, attributed ===========================================================
    {
      const near = overlapsNear(sx, sz);
      if (near.length === 0) row.verdicts.ttt = 'PASS';
      else {
        row.verdicts.ttt = 'FAIL';
        let worst = 0;
        const kinds = new Map<string, number>();
        for (const o of near) {
          if (o.depth > worst) worst = o.depth;
          kinds.set(`${o.kind} ${o.key}`, (kinds.get(`${o.kind} ${o.key}`) ?? 0) + 1);
        }
        const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
        row.notes.ttt = `${near.length} carriage overlaps within 200 m, worst ${worst.toFixed(1)} m deep; commonest ${top[0]} (${top[1]})`;
      }
    }

    // === 6. tworld ====================================================================
    //
    // Every carriage that passes this station over the cycle, against the
    // pipeline's prisms, the drawn paving and the terrain. Sampled at the same
    // deterministic instants, filtered to this station's 300 m.
    {
      let tested = 0;
      let throughBuilding = 0;
      let throughGround = 0;
      let firstHit = '';
      const passes = opts.deep ? 180 : 60;
      const scratch: Array<{ points: Float32Array; base: number; top: number }> = [];
      // Once, for the whole sweep. See the gauge walk above.
      rails.detach();
      for (let k = 0; k < passes; k++) {
        const t = ((k + 0.5) * bake.cycleS) / passes;
        const live = poseAll(bake, t, pose, frame, carPool);
        for (let bi = 0; bi < live; bi++) {
          const b = carPool[bi];
          // A carriage in a bore is under the terrain because that is where the
          // railway is. Without this the whole M1 reads as a defect and the
          // check says nothing about anything.
          if (b.tunnel) continue;
          if (Math.hypot(b.cx - sx, b.cz - sz) > 300) continue;
          tested++;
          carPlanProbes(b, probes);
          let hitBuilding = false;
          let sunk = false;
          for (let i = 0; i < probes.length; i += 2) {
            const x = probes[i];
            const z = probes[i + 1];
            if (!hitBuilding) {
              for (const prism of world.collision.prismsWithin(x, z, 2, scratch as never)) {
                if (b.y1 <= prism.base || b.y0 >= prism.top) continue;
                if (!pointInsidePolygon(prism.points, x, z)) continue;
                hitBuilding = true;
                break;
              }
            }
            if (!sunk) {
              const terr = world.terrain.height(x, z);
              if (Number.isFinite(terr)) {
                // Drawn terrain only: a carriage under a carved corridor is in
                // a cutting, which is where it belongs, and one under a bore is
                // not drawn against anything at all.
                const carved = cut !== null && Number.isFinite(cut.cutAt(x, z, terr));
                if (!carved && terr - (b.y0 - CAR_FLOOR_OVER_RAIL) > 1.0) sunk = true;
              }
            }
          }
          if (hitBuilding) {
            throughBuilding++;
            if (firstHit === '') firstHit = `${b.line}:${b.dirIndex} car ${b.car} at ${b.cx.toFixed(0)},${b.cz.toFixed(0)} through a prism`;
          }
          if (sunk) {
            throughGround++;
            if (firstHit === '') firstHit = `${b.line}:${b.dirIndex} car ${b.car} at ${b.cx.toFixed(0)},${b.cz.toFixed(0)} under drawn terrain`;
          }
        }
      }
      rails.attach();
      const worldFail = throughBuilding > 0 || throughGround > 0;
      row.verdicts.tworld = tested === 0 ? 'n/a' : worldFail ? 'FAIL' : 'PASS';
      if (worldFail) {
        row.notes.tworld =
          `${throughBuilding} carriage poses inside a building prism and ${throughGround} under drawn terrain, ` +
          `of ${tested} sampled within 300 m (${firstHit})`;
      }
    }

    // === 7. vert ======================================================================
    {
      const bits: string[] = [];

      // 7a. The label against the measurement, RAIL-VERTICAL.md section 2 and
      //     the precedence of section 3, **restated** from `rail.classify_
      //     vertical`: `tunnel=yes` wins outright, then a clearance over
      //     `ELEVATED_MIN_M` is elevated, and everything else -- including a
      //     deep cutting, which is open to the sky and therefore a surface
      //     station -- is surface. Restated rather than imported because a
      //     check that read the pipeline's own threshold could not notice the
      //     pipeline moving it.
      const ELEVATED_MIN_M = 4.0;
      const derived =
        station.structure === 'tunnel' ? 'underground'
          : station.clearance > ELEVATED_MIN_M ? 'elevated'
            : 'surface';
      if (station.vertical === 'unknown') {
        // A fourth value the table above cannot produce. `classify_vertical`
        // writes it where it found no way near the station to measure against,
        // and RAIL-VERTICAL.md section 2's whole point is that the label is an
        // *output* of a measurement -- so `unknown` is a station whose vertical
        // profile was never taken, not a station that is fine.
        bits.push(`vertical is 'unknown': the profile was never measured here, so nothing derives the label`);
      } else if (station.vertical !== derived) {
        bits.push(
          `vertical says '${station.vertical}', and structure '${station.structure}' with a median ` +
            `clearance of ${station.clearance.toFixed(2)} m derives '${derived}'`,
        );
      }
      // The DEM cross-check, and **only where a train stops**. `siteY` is the
      // mean of the calling anchors, so at a station nothing calls at it is
      // zero -- and comparing zero against a terrain forty-five metres up
      // reports every unserved light-rail stop in the city as buried. That is
      // an artefact of the field, not a defect in the world; the real defect at
      // those stops is the `unknown` label above.
      const dem = world.terrain.height(sx, sz);
      if (row.served && Number.isFinite(dem)) {
        const measured = station.siteY - dem;
        if (Math.abs(measured - station.clearance) > 3) {
          bits.push(
            `the bake's clearance is ${station.clearance.toFixed(2)} m and the shipped DEM measures ` +
              `${measured.toFixed(2)} m at the site`,
          );
        }
      }

      // 7b. No drawn non-tunnel track under the visible surface without a trench.
      let buried = 0;
      let vertices = 0;
      const p2 = bake.vertices;
      const vf2 = bake.vertexFlags;
      for (const line of bake.lines) {
        for (const dir of line.dirs) {
          if (sx + 300 < dir.minX || sx - 300 > dir.maxX || sz + 300 < dir.minZ || sz - 300 > dir.maxZ) continue;
          for (let i = dir.vertexOff; i < dir.vertexOff + dir.vertexCount; i++) {
            if ((vf2[i] & SPAN_TUNNEL) !== 0) continue;
            const x = p2[i * 3];
            const y = p2[i * 3 + 1];
            const z = p2[i * 3 + 2];
            if (Math.hypot(x - sx, z - sz) > 250) continue;
            const terr = world.terrain.height(x, z);
            if (!Number.isFinite(terr)) continue;
            vertices++;
            if (terr - y <= 1.0) continue;
            // Under the surface. Legal only if the ground here was carved away.
            if (cut !== null && Number.isFinite(cut.cutAt(x, z, terr))) continue;
            buried++;
          }
        }
      }
      if (buried > 0) bits.push(`${buried}/${vertices} drawn track vertices sit more than a metre under uncarved terrain`);

      // 7c. The deck stands `PLATFORM_TOP_M` over its own railhead. Not a
      //     tautology: the site's `y` is the railhead the *bake* recorded and
      //     the deck is drawn off the platform anchor, and the two are separate
      //     numbers that have disagreed before.
      //     Asked at the **middle of the deck** and not at the site, which is
      //     the track centre: `PlatformField.heightAt` declines inside the
      //     inner face by design -- there is no platform between the rails --
      //     and the first version of this asked there and reported -Infinity
      //     at every station in the city.
      for (const site of mySites) {
        const nx3 = -site.uz;
        const nz3 = site.ux;
        const want = site.y + PLATFORM_TOP_M;
        const surface = platforms.heightAt(site.x + nx3 * DECK_MID, site.z + nz3 * DECK_MID, want);
        // `>= want`, not `== want`, and the difference is a neighbour. Central
        // has eight decks whose rectangles overlap on the approach and
        // `heightAt` answers with the highest, so an answer five centimetres
        // *above* this deck's own top is the deck next to it and is
        // `samePlatform`'s business, not this check's. What must not happen is
        // an answer below the deck -- or none at all, which is what a body
        // stepping off a train falls through.
        if (!(surface >= want - 0.01)) {
          bits.push(
            `a platform deck answers ${surface.toFixed(2)} m where its railhead plus ` +
              `${PLATFORM_TOP_M} m is ${want.toFixed(2)} m`,
          );
          break;
        }
      }

      row.verdicts.vert = bits.length === 0 ? 'PASS' : 'FAIL';
      if (bits.length > 0) row.notes.vert = bits.join('; ');
    }
  }

  // --- The negative controls, against the real world -------------------------------------
  //
  // The synthetic ones live in `runControls` and prove the *predicates* can go
  // red. These prove the predicates go red **on this city**, which is the claim
  // that matters: a check that only fails on a fixture is a check that has never
  // met the data it is meant to police.
  //
  // Each control is the real rule with one input taken away, on
  // `checkRoadDeck`'s terms -- *not a flag, not a second code path*. A world
  // with no platform field is the world before the riding round; a `RailCut`
  // with no roads is the world before the King Street fix. If either of those
  // does not fail loudly, the rule under test is doing nothing.
  {
    const control = rows.find((r) => r.verdicts.reach === 'PASS' && r.verdicts.holes === 'PASS')
      ?? rows.find((r) => r.verdicts.reach === 'PASS')
      ?? rows[0];
    const site = (sitesByName.get(control.name) ?? [])[0];
    if (site !== undefined) {
      if (world.segments) {
        world.segments.update([site.x, site.z]);
        await world.segments.settle();
      }
      rail.update(site.x, site.z);
      const nx = -site.uz;
      const nz = site.ux;

      // 1. reach, in the world this *server* has: no platform field in the
      //    ground query and no rail geometry in the collision world.
      //
      //    Both have to go, and the first version of this control took only the
      //    first and did not fail. That was the control earning its keep before
      //    it ever ran green: `rail-geo` registers the platform deck as a
      //    **prism** as well, so `roofHeight` still stood the body on it and one
      //    of the four flights still worked. There are two independent
      //    statements in the client that a platform is a surface, which is worth
      //    knowing on its own -- and it is the same two the server has neither
      //    of. See the client/server assertion at the foot of this function.
      const noDeck = makeGround(null, cut);
      let reachedWithout = 0;
      rails.detach();
      for (const side of [-1, 1]) {
        for (const end of [1, -1]) {
          const ax = site.x + site.ux * (ACCESS_ALONG + 22) * end + nx * STAIR_MID * side;
          const az = site.z + site.uz * (ACCESS_ALONG + 22) * end + nz * STAIR_MID * side;
          const ay = noDeck(ax, az, Infinity);
          if (!Number.isFinite(ay)) continue;
          const at = walk(ax, az, ay + 0.1, site.x + nx * DECK_MID, site.z + nz * DECK_MID, 20, noDeck);
          if (onDeck(site, at)) reachedWithout++;
        }
      }
      rails.attach();
      emit(
        reachedWithout === 0,
        `CONTROL: in the world this process has -- no platform field in the ground query and no ` +
          `rail geometry in the collision world -- no body reaches the deck at ${control.name} from ` +
          `any of its four generated flights (${reachedWithout} did). A pass here would mean the ` +
          `reachability check is not driving anything`,
      );

      // 2. stand, dropped one carriage-width off the deck. The rectangle has to
      //    be able to say no, or "on the deck" means "somewhere near a station".
      const off = walk(
        site.x + nx * (PLATFORM_OUTER_M + 25), site.z + nz * (PLATFORM_OUTER_M + 25),
        site.y + PLATFORM_TOP_M, site.x + nx * (PLATFORM_OUTER_M + 26), site.z + nz * (PLATFORM_OUTER_M + 26), 1,
      );
      emit(!onDeck(site, off), 'CONTROL: a body 25 m behind the platform is not reported as standing on it');

      // 3. holes, with the carve knowing nothing about roads. `RailCut.setRoads`
      //    is the whole of the King Street fix, so a cut without it is the world
      //    the player fell through, and the rim walk must find it.
      const cutMod = (await import(
        new URL('../client/src/world/rail-cut.ts', import.meta.url).pathname
      )) as typeof import('../client/src/world/rail-cut.ts');
      const bare = new cutMod.RailCut(bake);
      bare.setStations(platforms.sites);
      const bareGround = makeGround(platforms, bare);
      // Walked at the corridor from a carriageway, which is where the report
      // was: King Street, St Peters. Every station is tried until one has a
      // road over its corridor, because not every station has one.
      //    Swept over the nearest forty stations and over a band of offsets
      //    rather than one: Redfern is a six-track formation, so a probe at a
      //    fixed 14 m from the *station's* centreline is inside another track's
      //    corridor and never stands on anything to start with. The control has
      //    to look where the geometry actually is.
      let bareFell = 0;
      let bareTried = 0;
      let where = '';
      const nearest = bake.stations
        .map((s) => ({ s, d: Math.hypot(s.siteX - originX, s.siteZ - originZ) }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 40);
      for (const { s: st } of nearest) {
        if (bareFell > 0) break;
        if (!onBuiltGround(st.siteX, st.siteZ)) continue;
        const ux = st.siteDx || 1;
        const uz = st.siteDz || 0;
        for (let a = -200; a <= 200 && bareFell === 0; a += 20) {
          for (const across of [12, 16, 20, 26, 34]) {
            for (const side of [-1, 1]) {
              const ox = st.siteX + ux * a + -uz * across * side;
              const oz = st.siteZ + uz * a + ux * across * side;
              const terr = world.terrain.height(ox, oz);
              if (!Number.isFinite(terr)) continue;
              if (Number.isFinite(bare.cutAt(ox, oz, terr))) continue;
              const start = bareGround(ox, oz, terr + 0.1);
              bareTried++;
              const at = walk(ox, oz, start + 0.1, st.siteX + ux * a, st.siteZ + uz * a, 8, bareGround);
              const rest = drop(at.x, at.z, at.feet, 1.5, bareGround);
              if (rest < start - 2.0) {
                bareFell++;
                where = `${st.name} at ${ox.toFixed(0)},${oz.toFixed(0)}, ${(start - rest).toFixed(1)} m down`;
                break;
              }
            }
            if (bareFell > 0) break;
          }
        }
      }
      emit(
        bareFell > 0,
        `CONTROL: with the carve given no roads -- the world before RailCut.setRoads -- a body ` +
          `walked at the corridor falls into it (${bareFell} of ${bareTried} probes; ${where || 'none found'}). ` +
          `The rim walk can therefore see a body fall, which is the only reason to believe it when it says none did`,
      );

      // 4. clear, with a wall put on the railhead. The gauge probe has to find a
      //    prism that is genuinely there, or "no intruders" means "no probe".
      const vx = bake.vertices[0];
      const vy = bake.vertices[1];
      const vz = bake.vertices[2];
      world.collision.addPrisms('station-suite:control', [{
        points: new Float32Array([vx - 4, vz - 4, vx + 4, vz - 4, vx + 4, vz + 4, vx - 4, vz + 4]),
        height: 8,
        base: vy - 1,
      }]);
      let found = false;
      for (const prism of world.collision.prismsWithin(vx, vz, 8)) {
        if (vy + 2 < prism.base || vy + 2 >= prism.top) continue;
        if (!pointInsidePolygon(prism.points, vx, vz)) continue;
        found = true;
        break;
      }
      world.collision.removeTile('station-suite:control');
      emit(found, 'CONTROL: a wall put across the first rail vertex is found by the loading-gauge probe');

      // 5. vert, against the station RAIL-VERTICAL.md opens with. Chatswood's
      //    label has since been re-derived and now reads `surface`, but the
      //    disagreement it was derived *from* is still recorded on the record,
      //    and losing that would be losing the evidence.
      const chatswood = bake.stations.find((s) => s.name === 'Chatswood');
      emit(
        chatswood !== undefined && chatswood.conflict !== '' && chatswood.clearance < -5,
        `CONTROL: Chatswood still carries its structure/DEM conflict on the record ` +
          `(clearance ${chatswood ? chatswood.clearance.toFixed(2) : '?'} m, structure ` +
          `'${chatswood?.structure}', label '${chatswood?.vertical}'). RAIL-VERTICAL.md's opening row ` +
          `is a bridge deck seven metres under the ground it is over, and a bake that had quietly ` +
          `stopped recording it would read as fixed`,
      );
    }
  }

  // --- The assertions ------------------------------------------------------------------

  const judged = rows.filter((r) => r.verdicts.reach !== 'skip');
  const counts: Record<CheckId, { pass: number; fail: number; na: number }> = {} as never;
  for (const c of CHECKS) {
    counts[c] = { pass: 0, fail: 0, na: 0 };
    for (const r of judged) {
      const v = r.verdicts[c];
      if (v === 'PASS') counts[c].pass++;
      else if (v === 'FAIL') counts[c].fail++;
      else counts[c].na++;
    }
  }
  const perfect = judged.filter((r) => CHECKS.every((c) => r.verdicts[c] !== 'FAIL'));
  /**
   * **The honest headline, and the first version of it was not.**
   *
   * "19 of 267 stations pass all seven" reads as good news and is not news at
   * all: seventeen of those nineteen are stations **nothing calls at** --
   * Cronulla, Thirroul, Glenbrook, the whole South Coast and the Cronulla
   * branch, which are in the station table and not in the timetable. They have
   * no platform to walk onto, no train to pass another train, and their nearest
   * rail vertex is between four and twenty-two kilometres away, so five of the
   * seven columns are `n/a` and they pass by not being asked.
   *
   * A station a player can actually catch a train from is the subject of this
   * suite, so that is the number reported.
   */
  const served = judged.filter((r) => r.served);
  const servedPerfect = served.filter((r) => CHECKS.every((c) => r.verdicts[c] !== 'FAIL'));

  for (const c of CHECKS) {
    emit(
      counts[c].fail === 0,
      `${c}: ${counts[c].pass} of ${counts[c].pass + counts[c].fail} judged stations pass ` +
        `(${counts[c].fail} fail, ${counts[c].na} not applicable)`,
    );
  }
  emit(
    servedPerfect.length === served.length,
    `${servedPerfect.length} of ${served.length} **served** stations pass all seven checks ` +
      `(${perfect.length} of ${judged.length} counting the ${judged.length - served.length} the ` +
      `timetable never reaches, which pass mostly by not being asked)`,
  );

  // The one whole-city claim that is not per station, kept out of the rows on
  // purpose: it has one cause and 267 rows saying so would bury the queue.
  emit(
    clientServerSplits === 0,
    `the ground the client computes equals the ground the server computes at ` +
      `${(clientServerSamples - clientServerSplits).toLocaleString()} of ${clientServerSamples.toLocaleString()} ` +
      `lattice samples over every station envelope, compared with Object.is` +
      (clientServerSplits > 0 ? ` -- worst ${worstSplit.toFixed(1)} m at ${worstSplitAt}` : ''),
  );

  emit(
    sweep.overlaps === 0,
    `no two carriages of two different trains occupy the same world space: ` +
      `${sweep.overlaps.toLocaleString()} overlapping pairs over ${sweep.instants} deterministic instants, ` +
      `${sweep.boxes.toLocaleString()} carriage poses and ${sweep.pairsTested.toLocaleString()} narrow-phase pairs` +
      (sweep.overlaps > 0 ? `, worst ${sweep.worst.toFixed(1)} m of interpenetration` : ''),
  );

  // --- The report ---------------------------------------------------------------------

  const totalMs = performance.now() - began;
  const roads = roadSeparation(bake);
  note(`    ${wanted.length} stations, ${judged.length} judged, ${rows.length - judged.length} outside the built extent`);
  note(
    `    ${(totalMs / 1000).toFixed(1)} s total, of which ${(sweepMs / 1000).toFixed(1)} s is the ` +
      `${INSTANTS}-instant train sweep; ${((totalMs - sweepMs) / 1000 / Math.max(1, judged.length)).toFixed(2)} s per judged station`,
  );
  note(`    rail solids in the collision world at the last station: ${rails.tiles} tiles`);
  note('    trains through trains, by mechanism:');
  for (const kind of OVERLAP_KINDS) {
    note(`      ${kind.padEnd(20)} ${sweep.byKind[kind].toLocaleString()}`);
  }
  note('    and why: how far apart each line draws its own up and down roads');
  for (const r of roads) {
    note(
      `      ${r.line.padEnd(4)} ${(r.coincidentShare * 100).toFixed(0).padStart(3)}% of ${r.samples} ` +
        `samples within 0.5 m of the other direction's polyline (mean ${r.meanM.toFixed(1)} m apart)`,
    );
  }
  note('    the ten worst direction pairs:');
  for (const c of sweep.clusters.slice(0, 10)) {
    note(`      ${c.key.padEnd(18)} ${String(c.count).padStart(6)} overlaps, worst ${c.worst.toFixed(1)} m, at ${c.x.toFixed(0)},${c.z.toFixed(0)}`);
  }

  const cardPath = new URL('../data/scratch/stations-scorecard.md', import.meta.url).pathname;
  await mkdir(dirname(cardPath), { recursive: true });
  await writeFile(
    cardPath,
    renderCard(rows, counts, servedPerfect.length, served.length, perfect.length, sweep, roads, opts, totalMs),
    'utf8',
  );
  note(`    scorecard written to ${cardPath}`);

  return { rows, sweep, runtimeMs: performance.now() - began, cardPath };
}

// --- The scorecard ---------------------------------------------------------------------

function renderCard(
  rows: Row[],
  counts: Record<CheckId, { pass: number; fail: number; na: number }>,
  servedPerfect: number,
  served: number,
  perfect: number,
  sweep: TrainSweep,
  roads: RoadPair[],
  opts: Options,
  ms: number,
): string {
  const out: string[] = [];
  out.push('# Station scorecard');
  out.push('');
  out.push(
    `Written by \`server/station-suite.ts\`, ${opts.deep ? 'deep' : 'coarse'} sweep, ` +
      `${(ms / 1000).toFixed(1)} s. Ordered by distance from Central: **this is the work queue**, ` +
      'and it is worked from the top.',
  );
  out.push('');
  out.push('Columns are the seven checks. `n/a` means the station has no platform to ask about');
  out.push('(nothing calls there); `skip` means it is outside the built extent.');
  out.push('');
  out.push('| # | station | km | served | ' + CHECKS.join(' | ') + ' |');
  out.push('|---:|---|---:|:-:|' + CHECKS.map(() => ':-:').join('|') + '|');
  rows.forEach((r, i) => {
    const cells = CHECKS.map((c) => {
      const v = r.verdicts[c];
      return v === 'PASS' ? 'ok' : v === 'FAIL' ? '**X**' : v;
    });
    out.push(`| ${i + 1} | ${r.name} | ${(r.dist / 1000).toFixed(2)} | ${r.served ? 'yes' : 'no'} | ${cells.join(' | ')} |`);
  });
  out.push('');
  out.push('## The stations already known broken');
  out.push('');
  out.push('Named in the round brief, reproduced here so the suite can be seen catching them');
  out.push('rather than taken on trust. A row of `ok` against a station a player has fallen');
  out.push('through would be the suite failing, not the world passing.');
  out.push('');
  out.push('| station | ' + CHECKS.join(' | ') + ' |');
  out.push('|---|' + CHECKS.map(() => ':-:').join('|') + '|');
  for (const name of KNOWN_BROKEN) {
    const r = rows.find((q) => q.name === name);
    if (r === undefined) continue;
    const cells = CHECKS.map((c) => {
      const v = r.verdicts[c];
      return v === 'PASS' ? 'ok' : v === 'FAIL' ? '**X**' : v;
    });
    out.push(`| ${name} | ${cells.join(' | ')} |`);
  }
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| check | pass | fail | n/a |');
  out.push('|---|---:|---:|---:|');
  for (const c of CHECKS) out.push(`| ${c} | ${counts[c].pass} | ${counts[c].fail} | ${counts[c].na} |`);
  out.push('');
  out.push(`**${servedPerfect} of ${served} served stations pass all seven.**`);
  out.push('');
  out.push(
    `${perfect} of ${rows.length} pass counting the ${rows.length - served} stations the timetable ` +
      'never reaches -- but those have no platform to walk onto and no train to hit anything, so ' +
      'five of their seven columns are `n/a` and they pass by not being asked. The served number ' +
      'is the one to work from.',
  );
  out.push('');
  out.push('## Trains through trains');
  out.push('');
  out.push(
    `${sweep.overlaps.toLocaleString()} overlapping carriage pairs over ${sweep.instants} instants ` +
      `(${sweep.boxes.toLocaleString()} poses, ${sweep.pairsTested.toLocaleString()} narrow-phase pairs), ` +
      `worst ${sweep.worst.toFixed(1)} m of interpenetration.`,
  );
  out.push('');
  out.push('| mechanism | overlapping pairs |');
  out.push('|---|---:|');
  for (const kind of OVERLAP_KINDS) {
    out.push(`| ${kind} | ${sweep.byKind[kind].toLocaleString()} |`);
  }
  out.push('');
  out.push('And the root cause behind `opposite-slot`: `rail.railKey` calls two trains running');
  out.push('opposite ways through a block *different rails*, which is right about a double-track');
  out.push('railway drawn as two tracks. Measured, the bake draws a great deal of it as one:');
  out.push('');
  out.push('| line | samples | within 0.5 m of the other direction | mean apart |');
  out.push('|---|---:|---:|---:|');
  for (const r of roads) {
    out.push(`| ${r.line} | ${r.samples} | ${(r.coincidentShare * 100).toFixed(0)}% | ${r.meanM.toFixed(1)} m |`);
  }
  out.push('');
  out.push('| direction pair | overlaps | worst | at |');
  out.push('|---|---:|---:|---|');
  for (const c of sweep.clusters.slice(0, 30)) {
    out.push(`| ${c.key} | ${c.count} | ${c.worst.toFixed(1)} m | ${c.x.toFixed(0)}, ${c.z.toFixed(0)} |`);
  }
  out.push('');
  out.push('## Notes, per failing station');
  out.push('');
  for (const r of rows) {
    const keys = (Object.keys(r.notes) as CheckId[]).filter((k) => r.notes[k]);
    if (keys.length === 0) continue;
    out.push(`### ${r.name} (${(r.dist / 1000).toFixed(2)} km)`);
    for (const k of keys) out.push(`- **${k}**: ${r.notes[k]}`);
    out.push('');
  }
  return out.join('\n');
}

// --- The negative controls ---------------------------------------------------------------

/**
 * Every check, proved able to fail.
 *
 * The coordinator's rule: *"where a check passes at every station on today's
 * code, be suspicious of the check rather than pleased"*. These are the proofs,
 * and each one is the real predicate driven over a world it must reject rather
 * than a re-implementation of it that could drift.
 */
export function runControls(emit: (ok: boolean, line: string) => void): void {
  // 1. The OBB overlap test itself, which everything about check 5 rests on.
  const base: CarBox = {
    cx: 0, cz: 0, fx: 1, fz: 0, halfLength: 10, halfWidth: 1.6, y0: 0.4, y1: 4.2,
    who: 1, rail: 0, tunnel: false, line: 'X', dirIndex: 0, trip: 0, car: 0,
  };
  const headOn = { ...base, who: 2, cx: 5, fx: -1 };
  const alongside = { ...base, who: 2, cz: 4 };
  const above = { ...base, who: 2, y0: 6, y1: 10 };
  const endToEnd = { ...base, who: 2, cx: 20.6 };
  emit(boxesOverlap(base, headOn), 'CONTROL: two carriages head on at five metres are reported as overlapping');
  emit(
    overlapAlong(base, headOn) > 14,
    `CONTROL: ...and by ${overlapAlong(base, headOn).toFixed(1)} m of one train inside the other, not by a hair`,
  );
  emit(!boxesOverlap(base, alongside), 'CONTROL: two carriages on adjacent tracks four metres apart are not');
  emit(!boxesOverlap(base, above), 'CONTROL: nor one six metres above the other on a flyover');
  emit(!boxesOverlap(base, endToEnd), 'CONTROL: nor two coupled end to end');

  // 2. The classifier, which is what makes the diagnosis worth reading.
  //    Every fixture below differs in `dirIndex` or `line`, because two boxes
  //    that agree on both are the *same service* whatever their block says, and
  //    the first version of these controls did not and tested nothing.
  emit(
    classify({ ...base, rail: 8 }, { ...base, who: 2, dirIndex: 1, rail: 9 }) === 'opposite-slot',
    'CONTROL: same block, opposite slot classifies as opposite-slot -- the mechanism railKey permits by design',
  );
  emit(
    classify({ ...base, rail: 8 }, { ...base, who: 2, dirIndex: 1, rail: 8 }) === 'same-rail',
    'CONTROL: same block, same slot classifies as same-rail, which is a block-model violation',
  );
  emit(
    classify({ ...base, trip: 1 }, { ...base, who: 2, trip: 2 }) === 'same-service',
    'CONTROL: two trips of one direction classify as same-service, which is headway in seconds against a train in metres',
  );
  emit(
    classify({ ...base, line: 'T2', rail: 4 }, { ...base, who: 2, line: 'T8', rail: 90 }) === 'cross-line',
    'CONTROL: two lines on different blocks in the same place classify as cross-line',
  );

  // 3. The plan-polygon test the gauge and the carriage-through-a-building
  //    checks both stand on.
  const square = new Float32Array([-5, -5, 5, -5, 5, 5, -5, 5]);
  emit(pointInsidePolygon(square, 0, 0), 'CONTROL: a point inside a square reads as inside it');
  emit(!pointInsidePolygon(square, 9, 0), 'CONTROL: and a point outside it does not');
}
