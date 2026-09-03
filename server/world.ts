/**
 * The city, on the server, off the disk.
 *
 * Spec section 5: *"collision is always the simplified prism, never derived from
 * render meshes at runtime"*, and `player/collision.ts`'s own header says the
 * quiet part -- *"the same file is what the authoritative server will load"*.
 * This is that day. Nothing here parses anything: `CollisionWorld.addTile`,
 * `decodeTerrain` and `decodePowerups` are the client's decoders, imported
 * across the directory boundary and handed bytes.
 *
 * ---------------------------------------------------------------------------
 * COLLISION IS LOADED PER HEXAGON, ON DEMAND. Everything else is still whole.
 *
 * This file used to say that everything is loaded at boot and that the
 * alternative had been measured rather than assumed. The measurement was of the
 * *file* bytes -- 2.4 MB of collision for the inner ring -- and the file bytes
 * were never the cost. Measured again, on the shipped 19.3 km world, with a
 * process per subsystem so the number attributes rather than being apportioned:
 *
 *   | at boot          | files   | live heap | RSS delta |
 *   |------------------|--------:|----------:|----------:|
 *   | collision prisms | 25.4 MB | **193 MB**| **336 MB**|
 *   | lanes -> traffic | 13.9 MB |     53 MB |     92 MB |
 *   | lanes -> peds    |  (same) |     57 MB |     88 MB |
 *   | terrain grids    |  3.7 MB |    3.9 MB |    3.9 MB |
 *   | index.json       |  0.9 MB |    ~5 MB  |    ~5 MB  |
 *   | powerups         | 0.04 MB |    ~0 MB  |    ~0 MB  |
 *   | **whole load**   | 43.0 MB | **310 MB**| **517 MB**|
 *
 * A prism costs **428 bytes resident against 52 bytes on disk**: a ten-field
 * record, a `Float32Array` for its polygon, and one to four entries in the 32 m
 * broadphase grid whose keys are strings. 486,917 of them is the whole of the
 * difference between "2.4 MB, hold it" and a 1 GB box.
 *
 * At 60 km, EXPANSION.md's tile estimate is 7-8x this world, which puts
 * collision alone at 1.4-1.6 GB resident. So collision -- and only collision,
 * this pass -- is now held **per hexagon** and only near somebody:
 *
 *   - a hex is NEEDED when any participant is inside it or within one tile
 *     (`COLLISION_NEED_MARGIN_M`, 500 m) of its boundary;
 *   - loads are asynchronous and applied against a per-tick millisecond budget,
 *     so a 374-tile hexagon never lands inside one tick;
 *   - residency is capped by `SYDNEY_COLLISION_CAP_MB` (450 by default) and
 *     trimmed least-recently-needed-first;
 *   - **a needed hex is never evicted, over cap or not.** Cap violation with a
 *     logged warning beats a player falling through the world.
 *
 * The lane graph was measured on the same terms and deliberately left whole.
 * See `HexResidency`'s header for that verdict and the number behind it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A QUERY AGAINST A HEX THAT HAS NOT ARRIVED YET ANSWERS.
 *
 * The same thing the client's does, because it is the same class and the class
 * has no third answer. `CollisionWorld` has no notion of an unloaded tile: its
 * grid holds the prisms it has been given, `resolve` finds nothing to push out
 * of, `blocked` finds nothing to block, and `roofHeight` returns `-Infinity`.
 * There is no "unknown" and there is nothing to synthesise one from.
 *
 * So a hex in flight reads as **open ground**, and that is exactly what a
 * browser sees for a tile it has not fetched -- `main.ts` fetches collision on a
 * 420 m ring, so every tile beyond it is prism-free on the client too. Both ends
 * agree during the gap, which is the property client prediction needs: the
 * server does not rewind a player into a building the client let them walk
 * through.
 *
 * It fails **open** rather than closed, and that direction is chosen, not
 * inherited. `world/tile-lifecycle.ts` makes the identical argument for the
 * client's own eviction: prisms with no geometry is an invisible wall, which is
 * unplayable and unreportable, where geometry with no prisms is a wall you can
 * briefly walk through. And the *ground* never goes missing with it -- terrain
 * is still whole-world resident (3.9 MB), so `groundFor` always has a real
 * height and nobody falls. A missing hex costs a few seconds of walking through
 * a warehouse, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * The one thing this file must get exactly right is the tile origin, because
 * getting it wrong is invisible.
 *
 * Collision prisms are stored **tile-local** and are offset into world space on
 * decode. `main.ts` passes `(bounds[0], bounds[1] + tile_size)`, which reads
 * oddly until you write the frame down: a tile's bounds are
 * `[minX, minZ, maxX, maxZ]` in a **north-positive** frame, and the renderer's
 * z runs *south*. So the tile's local origin -- its south-west corner in ENU --
 * is at world z `-(bounds[1])`... except that the sidecar's local z is already
 * negative-going, which makes the offset `bounds[1] + tile_size`. It is copied
 * from `main.ts` verbatim rather than re-derived for that reason: a server whose
 * prisms are one tile north of the client's produces a game where players walk
 * through buildings and are stopped by empty air, and there is no frame on
 * either end that says so.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CollisionWorld } from '../client/src/player/collision.ts';
import { CUT_SUBDIVISION, TerrainField, decodeTerrain } from '../client/src/world/terrain.ts';
import { decodePowerups } from '../client/src/world/powerups.ts';
import { PowerupField, type PowerupPoint } from '../client/src/game/powerups.ts';
// WORKSTREAM AA: the type of `ServerWorld.pointIndex`. See there.
import type { SpatialHash } from '../client/src/game/spatialhash.ts';
import { EYE_HEIGHT, PLAYER_RADIUS } from '../client/src/player/controller.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { TrafficField, decodeLanes } from '../client/src/game/traffic.ts';
// --- WORKSTREAM S: the parked fleet, which this process used to refuse to know
// about. `game/driving.ts` section 1 carried the deviation in as many words --
// "the server has no idea the first one exists" -- and the consequence was that
// only about forty of the cars within a player's reach were takeable while
// 23,020 identical ones at the same kerbs were not. `.cars.bin` is now the third
// hexagon layer, on the prisms' and the lanes' own slots. See
// `STATIC_CARS_NEED_MARGIN_M` and `game/staticcars.ts`.
import {
  StaticCarField,
  decodeCars,
  estimateStaticCarBytes,
} from '../client/src/game/staticcars.ts';
import { PedestrianField } from '../client/src/game/pedestrians.ts';
import { spawnCentre } from '../client/src/game/spawn.ts';
import {
  armHexes,
  hexContract,
  hexDistance,
  hexesUsable,
  type HexContract,
  type HexEntry,
  type HexIndex,
} from '../client/src/world/hexes.ts';
import { bikePlan, placeBike, type BikeGround, type BikeSpot } from '../client/src/game/bikes.ts';
import type { Place } from '../client/src/game/teleport.ts';
import type { CombatWorld } from '../client/src/game/combat.ts';
import { decodeRail, verifyRail, type RailBake } from '../client/src/game/rail.ts';
import { RailCut } from '../client/src/world/rail-cut.ts';
// **The railway's solids, as arithmetic.** See `world/rail-solids.ts`: this
// process has never had `rail-geo`'s prisms -- trench walls, viaduct decks and
// piers, footbridges, station buildings, access stairs, subway shaft heads --
// because they are drawn per chunk in a browser, and every one of them is
// ground a player stands on. `RailSolidField` is the definition those prisms are
// now *also* derived from, so the two ends compute one number.
import { RailSolidField, buildNetwork } from '../client/src/world/rail-solids.ts';
// The lateral half of the same solids, which is this file's own module rather
// than a shared one: it is a *residency*, and only a process with participants
// in it has one. See `server/rail-lateral.ts`.
import { RailLateralField } from './rail-lateral.ts';
import { buildCorridor, corridorCut } from '../client/src/world/corridor.ts';
import type { VesselField } from '../client/src/world/vessel-field.ts';
import { setVesselsEnabled, vesselsEnabled } from '../client/src/world/vessel.ts';
import { RoadDeck } from '../client/src/world/road-deck.ts';
import { ClearanceEnvelope } from '../client/src/world/envelope.ts';
import { SPAN_TUNNEL } from '../client/src/game/rail.ts';

import {
  buildPlatforms,
  buildStationBoxes,
  accessWorldFrom,
  type AccessWorld,
  type PlatformField,
  type StationBoxField,
} from '../client/src/game/riding.ts';

// --- Hex-lazy collision ---------------------------------------------------------

/**
 * How close a participant has to be to a hexagon before its prisms are wanted.
 *
 * One tile, and the derivation is the fastest thing in the game rather than a
 * round number: a player on a lime bike does 39.4 m/s, so 500 m is **12.7
 * seconds** of warning. A hexagon's collision reads off local disk and applies
 * against `APPLY_BUDGET_MS` in about half a second for the fattest one in the
 * build, so the margin is twenty times the load.
 *
 * It is also the *only* hysteresis this needs. To make a hex flip between wanted
 * and unwanted a player has to cross 500 m of ground each way, which at a sprint
 * is a minute and a half -- where the equivalent client rule
 * (`tile-lifecycle.COLLISION_KEEP_RADIUS_M`) needs an explicit second radius
 * because it is compared against a 420 m fetch ring on every frame.
 */
export const COLLISION_NEED_MARGIN_M = 500;

/**
 * And how close before its **lanes** are wanted. Four times as far, and measured.
 *
 * Collision's 500 m is one tile, because collision is a query about the ground
 * you are standing on: `resolve` reaches `PLAYER_RADIUS` and `blocked` reaches a
 * sight line. Nothing in it asks about ground half a kilometre away.
 *
 * The lane graph is not like that, and two separate measurements say so.
 *
 *   - **A route runs out of its own tile.** `.lanes.bin` is filed under the tile
 *     a route *starts* in and the route keeps going; swept over all 23,734
 *     routes in the 19.3 km build, the worst one reaches **1,164.7 m** past its
 *     own tile's bounds (tile -31_-20, a motorway run). With a 500 m margin a
 *     car whose sidecar sits in an unloaded hexagon could be driving 660 m
 *     inside the loaded region -- through a player -- and the server would not
 *     be simulating it. That is precisely the failure this whole rule exists to
 *     rule out, and it is not hypothetical arithmetic: it is the widest route in
 *     the shipped city.
 *   - **The police read further than the physics does.** `factions.ts` gates a
 *     station's beat at `CATCHMENT_RESCUE_MAX + radius` from the query point --
 *     900 + `PROMOTE_RADIUS` 120 = 1,020 m -- and then picks that beat out of
 *     the bands within `CATCHMENT_RESCUE_MAX` of the *station*, another 900 m.
 *     So a band 1,920 m from a player can decide where an officer near that
 *     player is standing.
 *
 * 2,000 m covers both with room, and what it buys is worth stating plainly:
 * **within this margin the lazily-loaded server answers every lane query
 * exactly as a whole-world server would.** Not "closely" and not "the window is
 * small" -- identically, because the resident set around any participant is a
 * superset of everything any of these queries can reach. `checkServerSegments`
 * asserts the arithmetic against the constants it is derived from, so tuning the
 * catchment or widening a motorway cannot quietly invalidate it.
 *
 * It is not free, and the cost is small for the same reason the 500 m one is: a
 * hexagon is 6 km of circumradius, so a wider skirt only pulls in a neighbour
 * for players near a boundary. 62% of a hexagon's area is within 2 km of one
 * against 18% within 500 m, and a neighbour's *lanes* are 7-13 MB where its
 * prisms are 26 MB. Paying 13 MB to make the traffic exact is the trade.
 */
export const LANES_NEED_MARGIN_M = 2000;

/**
 * And how close before a hexagon's **parked cars** are wanted. The lanes' 2,000 m,
 * and it is the same number for a different reason.
 *
 * A `.cars.bin` does not run out of its own tile the way a route does -- a parked
 * car is inside the tile it is filed under, always -- so the argument that sized
 * the lane skirt does not apply. What sizes this one is the *other* end of the
 * wire.
 *
 * The browser holds a tile's parked cars only while the tile itself is built,
 * which is a ring of a few hundred metres around the camera, and it draws its
 * take prompt from `driving.resolveTake` over exactly that set. So the property
 * that has to hold is **the server's set is a superset of the client's**: a
 * prompt the browser offers must be a car this process can grant, or `E` promises
 * a car and does nothing -- which is the reported bug's exact shape and is what
 * `server/take-check.ts` bounds at two per sweep. 2,000 m is four times the
 * client's whole tile ring, so the superset is not close: it holds with a
 * kilometre and a half of slack in every direction.
 *
 * The reverse gap -- this process holding a car whose tile the browser has not
 * built yet -- is a keypress that works where no prompt was drawn, which is a
 * strictly better failure and is left alone.
 *
 * Sharing the lane margin also means the third layer adds **no distance sweep**:
 * `update` computes the needed set at 500 m and at 2,000 m as it always did, and
 * this layer reads the second one. See `HexResidency.update`.
 */
export const STATIC_CARS_NEED_MARGIN_M = LANES_NEED_MARGIN_M;

/** `SYDNEY_COLLISION_CAP_MB`'s default, megabytes of estimated resident prisms. */
export const DEFAULT_COLLISION_CAP_MB = 450;

/** `SYDNEY_LANES_CAP_MB`'s default, megabytes of estimated resident lane graph. */
export const DEFAULT_LANES_CAP_MB = 300;

/**
 * `SYDNEY_STATIC_CARS_CAP_MB`'s default, megabytes of estimated resident parked cars.
 *
 * **Twenty-four, and the whole city is forty-six.** 1,402,623 cars over 13,362
 * tiles at `staticcars.estimateStaticCarBytes` is 46.1 MB -- against 193 MB of
 * prisms and 132 MB of lane graph on a world a third this radius -- so this is by
 * far the cheapest of the three layers and the cap is a backstop rather than a
 * working limit. Unlike the other two, the figure is **RSS rather than live heap**
 * and needs no ratio applied to it; `staticcars.BYTES_PER_STATIC_CAR` says why.
 *
 * It is set *under* the whole-city figure on purpose. What the residency actually
 * holds is the hexagons within `STATIC_CARS_NEED_MARGIN_M` of somebody, and that
 * is **measured, at the spawn: 3 hexagons, 907 tiles, 141,823 cars, 4.5 MB.** So
 * 24 MB is five times what a room in one suburb needs and about half of Sydney;
 * the only thing that can reach it is a pathological spread of players across the
 * whole extent -- and at that point the needed set is a hard floor anyway
 * (`HexLayer.trim` logs and holds), exactly as it is for the other two layers.
 * Verified by booting at `SYDNEY_STATIC_CARS_CAP_MB=1`: the layer reports 4.5 MB
 * against the 1 MB cap and 17 refusals to evict, which is the rule working. A
 * default of 50 would never bind at all and would tell an operator nothing about
 * what this layer costs.
 */
export const DEFAULT_STATIC_CARS_CAP_MB = 24;

/**
 * What one prism and one polygon vertex cost resident, bytes.
 *
 * **Measured, not modelled**, one process per hexagon against the shipped 19.3
 * km world: load that hexagon's collision into a fresh `CollisionWorld`, force a
 * full GC, and read `heapUsed`. Sixteen points, and the fit
 * `prisms * 344 + vertices * 16` lands within **+0.2%** of the 208 MB total and
 * within +21%/-38% per hexagon -- the low outlier being a 1,384-prism hexagon
 * where the broadphase grid's fixed cost dominates, which is a hexagon nobody
 * has to budget for.
 *
 * The two terms are the two things a prism is. The polygon is `vertices * 8`
 * bytes of `Float32Array` plus its allocation rounding; everything else is the
 * ten-field record, its typed-array header, and its one-to-four entries in the
 * 32 m grid, whose keys are strings and whose buckets are arrays. That last part
 * is why the number is 344 and not the ~100 the fields add up to, and it is why
 * this cannot be estimated from the file size: the payload carries no grid.
 *
 * Re-derive these with a fresh sixteen-point sweep whenever `CollisionWorld`'s
 * layout changes. `checkServerSegments` asserts the estimator is within 2x of
 * the real heap delta, which catches a layout change without pinning a constant
 * that is allowed to drift.
 */
export const BYTES_PER_PRISM = 344;
export const BYTES_PER_PRISM_VERTEX = 16;

/**
 * And what the lane graph costs resident: a route, a route point, a way point.
 *
 * **Measured on the same terms as the prisms above** -- one Bun process per
 * hexagon, read every `.lanes.bin` in its manifest, `decodeLanes` it, adopt it
 * into a fresh `TrafficField` *and* a fresh `PedestrianField`, force both
 * broadphase grids to exist, `Bun.gc(true)`, read `heapUsed`. Fifteen points on
 * the 19.3 km build, and the fit
 * `routes * 2160 + routePoints * 112 + wayPoints * 84` lands **1.4% under** the
 * 131.9 MB total and within 0.94x-1.02x on every hexagon that carries a real
 * street. The two low outliers -- 0.58x and 0.68x -- are the two near-empty
 * hexagons out past Berowra, 0.8 MB and 1.4 MB, where the two `Map`s' fixed cost
 * dominates. Those are hexagons nobody has to budget for, and it is the same
 * shape of outlier `BYTES_PER_PRISM` reports for the same reason.
 *
 * The three terms are the three things the lane graph is. A route is a
 * fourteen-field record with four `Float32Array`s and up to sixteen entries in
 * the 256 m traffic grid; a route point is 16 bytes of those arrays plus
 * rounding; a way point is the six `Float32Array`s of the footpath band
 * `buildBands` derives from it, in the 128 m pedestrian grid. Bands are not a
 * term of their own because they are a function of the ways -- one or two per
 * way -- and counting them would mean asking `PedestrianField` a question at
 * apply time to learn something the ways already say.
 *
 * Re-derive with a fresh sweep whenever either field's layout changes.
 * `checkServerSegments` asserts the estimator within 2x of a real heap delta,
 * which catches a layout change without pinning a constant that may drift.
 */
export const BYTES_PER_ROUTE = 2160;
export const BYTES_PER_ROUTE_POINT = 112;
export const BYTES_PER_WAY_POINT = 84;

/**
 * How long one tick may spend decoding, across **both** payloads.
 *
 * `addTile` costs about 0.17 ms for an average tile, so a 374-tile hexagon is
 * 63 ms of decode -- four tick budgets, applied in one go, which is the stall
 * this budget exists to refuse. Two milliseconds a tick spreads the fattest
 * hexagon over about half a second and costs 12% of one core while a load is
 * running and nothing at all when none is.
 *
 * One budget for the two layers rather than one each, so adding the lane graph
 * did not double the residency's worst tick. Collision drains first because a
 * player falling through the world outranks a car that has not started driving
 * yet, and `LANES_FLOOR_MS` is what stops that priority becoming starvation.
 */
const APPLY_BUDGET_MS = 2;

/**
 * The slice the lane layer is guaranteed even when collision spent the lot.
 *
 * Without it a hexagon of prisms arriving every tick would hold the lane layer's
 * pending queue open indefinitely -- and that queue holds `ArrayBuffer`s, so
 * starving it is a memory leak with a decode budget on the front of it. Half a
 * millisecond is two or three lane tiles, which is enough to drain any queue the
 * reader can fill.
 */
const LANES_FLOOR_MS = 0.5;

// Measured against it, by `checkServerSegments` walking a player across three
// hexagons with a cap that cannot hold two: the worst single `update` call is
// **4.4 ms**, which is the budget plus one tile of overshoot -- the deadline is
// checked between tiles, and the fattest tile in the CBD is a couple of
// milliseconds on its own. Before eviction was budgeted the same walk peaked at
// **21.6 ms**, all of it in one `removeTile` sweep. See `HexSlot.releasing`.

/**
 * How often the needed set is recomputed, in ticks.
 *
 * Every fifteenth, which is 4 Hz. The whole point of a 500 m margin is that
 * noticing late is free: at 4 Hz the worst-case delay is 250 ms, which is 10 m
 * of travel on a bike against 500 m of lead. Recomputing every tick would cost
 * `players * hexes` distance tests at 60 Hz -- 0.08 ms a tick at 100 players and
 * 16 hexagons, measured, against an empty room's whole tick of 0.17 ms. The
 * apply budget still drains every tick; only the *decision* is throttled.
 */
const NEED_INTERVAL_TICKS = 15;

/** Hexagons whose files may be in flight at once. `hexes.CONCURRENCY`'s four, halved: this is a disk. */
const LOAD_CONCURRENCY = 2;

/** Tile payloads read in parallel within one hexagon. */
const READ_CONCURRENCY = 8;

/** How rarely the over-cap warning may repeat, milliseconds. */
const WARN_INTERVAL_MS = 10_000;

/** What a hexagon's collision is estimated to cost resident. See the constants. */
export function estimateCollisionBytes(prisms: number, vertices: number): number {
  return prisms * BYTES_PER_PRISM + vertices * BYTES_PER_PRISM_VERTEX;
}

/** And its lane graph, as both fields hold it. See the constants. */
export function estimateLaneBytes(routes: number, routePoints: number, wayPoints: number): number {
  return routes * BYTES_PER_ROUTE + routePoints * BYTES_PER_ROUTE_POINT + wayPoints * BYTES_PER_WAY_POINT;
}

/** Is any of these flat `x, z` pairs inside `margin` of this hexagon? */
function reaches(entry: HexEntry, points: readonly number[], margin: number): boolean {
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (hexDistance(entry, points[i], points[i + 1]) <= margin) return true;
  }
  return false;
}

/**
 * A tile's collision payload declares its own vertex count, for free.
 *
 * The format is a `u32` count then, per prism, two floats, a `u16` vertex count
 * and that many `f32` pairs -- so `4 + prisms * 10 + vertices * 8` is the file
 * length exactly, and the vertex total falls out of the length and the prism
 * count with no second walk over the buffer. See `player/collision.addTile`.
 */
function verticesInPayload(byteLength: number, prisms: number): number {
  return Math.max(0, (byteLength - 4 - prisms * 10) / 8);
}

/** One hexagon's tiles, extracted from its manifest and kept when its prisms are not. */
interface HexTiles {
  keys: string[];
  /** The `addTile` offsets, precomputed. See this file's header on the frame. */
  originX: Float64Array;
  originZ: Float64Array;
  /** The index's own building count per tile, for `Prism.structural`. */
  buildings: Int32Array;
}

/** A tile payload that has been read but not yet decoded. See `APPLY_BUDGET_MS`. */
interface PendingTile {
  at: number;
  buffer: ArrayBuffer;
}

type HexState = 'absent' | 'loading' | 'resident';

/**
 * One hexagon's residency **of one kind of payload**: prisms, or the lane graph.
 *
 * The split is what let the lane graph reuse every part of this class that was
 * already right. The needed set, the LRU clock, the manifest, the cap and the
 * budgeted applier were all keyed on hexagons rather than on prisms -- the
 * original header said so and said a lane loader would be "another `apply` and
 * another `drop` on the same slots" -- and this is that sentence made
 * structural: `HexSlot` still names a hexagon, and holds one of these per layer.
 */
interface LayerSlot {
  state: HexState;
  /** Payloads read and waiting for a decode budget. */
  pending: PendingTile[];
  /** Every tile key this layer currently holds, so an eviction is exact. */
  applied: string[];
  /**
   * Keys this hexagon has given up but not yet taken out of the index.
   *
   * **Eviction is as expensive as loading and this is what stops it landing in
   * one tick.** `CollisionWorld.removeTile` walks every prism in the tile and
   * splices it out of one to four broadphase cells, so dropping the fattest
   * hexagon in the build -- 374 tiles, 100,480 prisms -- was measured at
   * **21.6 ms**, which is a stall by `/stats`' own definition and was the first
   * thing `checkServerSegments` caught. So a drop is a *promise* to remove, paid
   * off by `drain` under the same millisecond budget the decode runs on.
   *
   * The lane layer needs it far less -- `TrafficField.drop` and
   * `PedestrianField.drop` are O(that tile) since the incremental index landed,
   * and a whole 374-tile hexagon comes out in 7.8 ms rather than 4,930 -- but it
   * costs nothing to pay it off the same way and it means one drain loop rather
   * than two shapes of one.
   */
  releasing: string[];
  /** Bumped to abandon an in-flight load. See `HexLayer.drop`. */
  generation: number;
  /** Has the reader finished queueing this hexagon's payloads? */
  read: boolean;
  /** Estimated resident bytes, and the file bytes behind them. */
  bytes: number;
  fileBytes: number;
  /** Prisms, for collision; routes, for the lane graph. Diagnostics. */
  items: number;
}

interface HexSlot {
  entry: HexEntry;
  /** The manifest's tiles, read once, shared by every layer, kept across evictions. */
  tiles: HexTiles | null;
  /** In flight, so two layers wanting the same manifest read it once. */
  reading: Promise<HexTiles | null> | null;
  /** The update counter at which this hexagon was last needed. The LRU key. */
  usedAt: number;
  collision: LayerSlot;
  lanes: LayerSlot;
  /** WORKSTREAM S: `.cars.bin`, the parked fleet. See `STATIC_CARS_NEED_MARGIN_M`. */
  staticCars: LayerSlot;
}

function emptyLayerSlot(): LayerSlot {
  return {
    state: 'absent',
    pending: [],
    applied: [],
    releasing: [],
    generation: 0,
    read: false,
    bytes: 0,
    fileBytes: 0,
    items: 0,
  };
}

/** What `/stats` and the checks read off one layer of the residency. */
export interface LayerStats {
  resident: number;
  loading: number;
  /** Estimated resident bytes, and the cap they are held under. */
  bytes: number;
  capBytes: number;
  tiles: number;
  /** Prisms, for collision; routes, for the lane graph; parked cars, for `.cars.bin`. */
  items: number;
  loads: number;
  evictions: number;
  /** Updates that ended over cap because every resident hexagon was needed. */
  overCap: number;
  /** Tile payloads still queued for a decode budget, plus those queued for removal. */
  pending: number;
  /** How far a participant may be before this layer's payload is dropped. */
  marginM: number;
  /** How many hexagons this layer's margin currently wants. */
  needed: number;
}

/** What `/stats` and the checks read off the residency. */
export interface SegmentStats {
  /** False on a world with no hex contract, where everything is resident. */
  enabled: boolean;
  hexes: number;
  /**
   * The collision layer, flattened onto this object.
   *
   * Kept flat rather than moved under `collision` because `/health`, `/stats`,
   * the boot line and every existing check read these names, and renaming a
   * shipped diagnostic to make a second layer symmetrical is a poor trade. The
   * lane layer is `lanes` below and the collision layer is also available under
   * `collision`, so anything new can be written symmetrically.
   */
  resident: number;
  loading: number;
  needed: number;
  bytes: number;
  capBytes: number;
  tiles: number;
  prisms: number;
  loads: number;
  evictions: number;
  overCap: number;
  pending: number;
  collision: LayerStats;
  lanes: LayerStats;
  /** WORKSTREAM S: the parked fleet. `items` is cars. */
  staticCars: LayerStats;
}

/**
 * What a layer has to know how to do with one tile. Four closures and two numbers.
 *
 * Everything else about residency -- when to want a hexagon, when to give it up,
 * how much of a tick to spend, how to abandon a load in flight -- is the same
 * for prisms and for lanes, and is in `HexLayer` once.
 */
interface LayerSpec {
  /** For the over-cap warning, and for `checkServerSegments`' output. */
  readonly name: string;
  /** The environment variable an operator would raise. */
  readonly capName: string;
  readonly capBytes: number;
  /** How close a participant has to be before this payload is wanted. */
  readonly marginM: number;
  /** Where one tile's payload lives, under the world root. */
  path(key: string): string;
  /** Is this tile's payload already held? A tile two hexagons both claim. */
  has(key: string): boolean;
  /** Decode and adopt one tile. Returns what it cost and what it added. */
  apply(key: string, buffer: ArrayBuffer, originX: number, originZ: number, buildings: number): {
    bytes: number;
    items: number;
  };
  /** Give one tile back. */
  remove(key: string): void;
}

/**
 * One kind of payload, held per hexagon, under its own cap.
 *
 * Two of these exist: the prisms and the lane graph. Everything that is the same
 * about holding them is here once -- start a read, decode against a millisecond
 * budget, abandon a load that has been superseded, give the memory back over the
 * following ticks, evict least-recently-needed-first, and refuse to evict a
 * hexagon somebody is standing in. What differs is four closures and two
 * numbers; see `LayerSpec`.
 *
 * The layer does **not** own the needed set, the LRU clock or the manifests.
 * Those are per hexagon rather than per payload, and `HexResidency` owns them:
 * one distance sweep answers both layers' questions, one manifest read serves
 * both layers' tiles, and one `usedAt` stamp orders both layers' evictions.
 */
class HexLayer {
  /** Hexagons this layer's margin currently wants. Filled by `HexResidency.update`. */
  readonly needed = new Set<string>();
  bytes = 0;
  fileBytes = 0;
  loads = 0;
  evictions = 0;
  overCap = 0;
  private inFlight = 0;
  private warnedAt = 0;
  /** Slots with payloads waiting on a decode budget, in the order they started. */
  private readonly applying = new Set<HexSlot>();
  /** Slots with tiles still to be taken out of the index. See `LayerSlot.releasing`. */
  private readonly releasing = new Set<HexSlot>();

  constructor(
    readonly spec: LayerSpec,
    private readonly root: string,
    private readonly slots: Map<string, HexSlot>,
    /** This layer's half of a slot. */
    private readonly of: (slot: HexSlot) => LayerSlot,
    /** The hexagon's manifest, read once for both layers. */
    private readonly manifest: (slot: HexSlot) => Promise<HexTiles | null>,
  ) {}

  isResident(slot: HexSlot): boolean {
    return this.of(slot).state === 'resident';
  }

  /** Anything in flight or waiting on a budget. `settle` waits on this. */
  get busy(): boolean {
    return this.applying.size > 0 || this.releasing.size > 0;
  }

  /**
   * Start reading a hexagon. Never awaited by the tick.
   *
   * A read that fails is a hexagon that goes back to `absent` and is started
   * again the next time it is needed, on `hexes.ensureHex`'s argument: a hexagon
   * that gives up after one flaky read is a part of the map the player can never
   * reach, which is worse than one that retries. On local disk the failure that
   * actually happens is a tile the pipeline did not emit, and `readOptional`
   * already treats that as an empty tile rather than an error.
   */
  start(slot: HexSlot): void {
    const mine = this.of(slot);
    if (mine.state !== 'absent' || this.inFlight >= LOAD_CONCURRENCY) return;
    // Not while its own payload is still coming out of the index: `read` skips a
    // tile the field already holds, so a hexagon restarted mid-release would
    // skip exactly the tiles the release is about to delete and come back
    // missing them. A few ticks of waiting against 12.7 s of margin.
    if (mine.releasing.length > 0) return;
    mine.state = 'loading';
    mine.read = false;
    mine.generation++;
    const generation = mine.generation;
    this.inFlight++;
    this.loads++;
    this.applying.add(slot);
    void this.read(slot, generation).finally(() => {
      this.inFlight--;
      if (mine.generation === generation) mine.read = true;
    });
  }

  private async read(slot: HexSlot, generation: number): Promise<void> {
    const mine = this.of(slot);
    if (slot.tiles === null) {
      const tiles = await this.manifest(slot);
      if (mine.generation !== generation) return;
      if (tiles === null) {
        mine.state = 'absent';
        this.applying.delete(slot);
        return;
      }
    }
    const keys = slot.tiles!.keys;
    for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
      const batch: Array<Promise<ArrayBuffer | null>> = [];
      for (let j = i; j < Math.min(i + READ_CONCURRENCY, keys.length); j++) {
        batch.push(readOptional(join(this.root, this.spec.path(keys[j]))));
      }
      const buffers = await Promise.all(batch);
      if (mine.generation !== generation) return;
      for (let j = 0; j < buffers.length; j++) {
        const buffer = buffers[j];
        // A tile already in the field is a tile another hexagon claimed -- which
        // `checkHexCoverage` says cannot happen, and which the adopters would
        // silently overwrite anyway, leaving this class thinking it owned bytes
        // it did not. Skipped explicitly so the accounting stays true.
        if (buffer === null || this.spec.has(keys[i + j])) continue;
        mine.pending.push({ at: i + j, buffer });
      }
    }
  }

  /**
   * Decode what has been read, until `deadline`.
   *
   * Oldest load first, so a hexagon somebody is walking into finishes rather
   * than sharing the budget with one they are walking out of. The deadline is
   * checked between tiles rather than inside the adopter, so the overshoot is
   * one tile: 0.17 ms for an average collision tile, and 0.03 ms for an average
   * lane one.
   */
  drain(deadline: number): void {
    // Give memory back before taking more, and before the deadline is spent on
    // decoding. A hexagon arriving can afford the eight ticks this costs -- the
    // margin is 12.7 s -- and the process being over cap for those eight ticks
    // is the thing the cap exists to stop.
    if (this.releasing.size > 0) {
      for (const slot of this.releasing) {
        const mine = this.of(slot);
        while (mine.releasing.length > 0) {
          if (performance.now() >= deadline) return;
          this.spec.remove(mine.releasing.pop()!);
        }
        this.releasing.delete(slot);
      }
    }
    if (this.applying.size === 0) return;
    for (const slot of this.applying) {
      const tiles = slot.tiles;
      if (tiles === null) continue;
      const mine = this.of(slot);
      while (mine.pending.length > 0) {
        if (performance.now() >= deadline) return;
        const next = mine.pending.pop()!;
        const at = next.at;
        const key = tiles.keys[at];
        const added = this.spec.apply(
          key,
          next.buffer,
          tiles.originX[at],
          tiles.originZ[at],
          tiles.buildings[at],
        );
        mine.applied.push(key);
        mine.items += added.items;
        mine.bytes += added.bytes;
        mine.fileBytes += next.buffer.byteLength;
        this.bytes += added.bytes;
        this.fileBytes += next.buffer.byteLength;
      }
      if (mine.read) {
        mine.state = 'resident';
        this.applying.delete(slot);
      }
    }
  }

  /** Read and decode one hexagon to completion. The boot path, and only that. */
  async loadNow(slot: HexSlot, clock: number): Promise<void> {
    const mine = this.of(slot);
    if (mine.state === 'resident') return;
    // Any of its own tiles still queued for removal come out **first**, for
    // `start`'s reason: `read` skips a tile the field already holds, so a
    // hexagon reloaded over its own pending release would come back missing
    // exactly those tiles. Synchronous here because this is boot and there is no
    // tick to protect.
    if (mine.releasing.length > 0) this.drain(Infinity);
    if (mine.state === 'absent') {
      mine.state = 'loading';
      mine.read = false;
      mine.generation++;
      // Stamped, so the boot walk's own evictions are least-recently-loaded
      // first rather than whatever order the slot map happens to be in.
      slot.usedAt = clock;
      this.loads++;
      this.applying.add(slot);
      await this.read(slot, mine.generation);
      mine.read = true;
    }
    this.drain(Infinity);
  }

  /**
   * Drop hexagons, least-recently-needed first, until under cap.
   *
   * The needed set is a hard floor and the loop gives up rather than crossing
   * it. See `HexResidency`'s header: over cap is a log line, and the alternative
   * is a player standing in a hexagon whose prisms have just been taken away.
   */
  trim(pinned: (slot: HexSlot) => boolean): void {
    while (this.bytes > this.spec.capBytes) {
      let victim: HexSlot | null = null;
      for (const slot of this.slots.values()) {
        if (this.of(slot).state === 'absent') continue;
        if (this.needed.has(slot.entry.id)) continue;
        if (pinned(slot)) continue;
        if (victim === null || slot.usedAt < victim.usedAt) victim = slot;
      }
      if (victim === null) {
        this.overCap++;
        const now = performance.now();
        if (now - this.warnedAt > WARN_INTERVAL_MS) {
          this.warnedAt = now;
          let held = 0;
          for (const other of this.slots.values()) if (this.of(other).state !== 'absent') held++;
          console.warn(
            `[sydney] ${this.spec.name} over cap: ${(this.bytes / 1e6).toFixed(1)} MB resident against a ` +
              `${(this.spec.capBytes / 1e6).toFixed(0)} MB cap, and all ${held} resident hexagon(s) are ` +
              'needed. Holding them anyway — a player standing in one would fall through the ' +
              `world. Raise ${this.spec.capName}, or accept that this many players this far ` +
              'apart costs this much.',
          );
        }
        return;
      }
      this.drop(victim);
      this.evictions++;
    }
  }

  /** Give a hexagon's payload back. Idempotent; keeps the manifest. */
  drop(slot: HexSlot): void {
    const mine = this.of(slot);
    mine.generation++;
    mine.pending.length = 0;
    this.applying.delete(slot);
    // The bytes come off the books now and the payload comes out of the index
    // over the next few ticks. The accounting therefore runs a little ahead of
    // the heap, which is the safe direction: `trim` believes it has already
    // recovered the memory and so evicts *less*, where the other order would
    // cascade -- every tick finding itself still over cap and giving up another
    // hexagon that the previous tick's release was about to pay for.
    for (const key of mine.applied) mine.releasing.push(key);
    if (mine.releasing.length > 0) this.releasing.add(slot);
    mine.applied.length = 0;
    this.bytes -= mine.bytes;
    this.fileBytes -= mine.fileBytes;
    mine.bytes = 0;
    mine.fileBytes = 0;
    mine.items = 0;
    mine.state = 'absent';
    mine.read = false;
  }

  dropAll(): void {
    for (const slot of this.slots.values()) if (this.of(slot).state !== 'absent') this.drop(slot);
    this.drain(Infinity);
  }

  stats(): LayerStats {
    let resident = 0;
    let loading = 0;
    let tiles = 0;
    let items = 0;
    let pending = 0;
    for (const slot of this.slots.values()) {
      const mine = this.of(slot);
      if (mine.state === 'resident') resident++;
      if (mine.state === 'loading') loading++;
      tiles += mine.applied.length;
      items += mine.items;
      pending += mine.pending.length + mine.releasing.length;
    }
    return {
      resident,
      loading,
      bytes: this.bytes,
      capBytes: this.spec.capBytes,
      tiles,
      items,
      loads: this.loads,
      evictions: this.evictions,
      overCap: this.overCap,
      pending,
      marginM: this.spec.marginM,
      needed: this.needed.size,
    };
  }
}

/**
 * Which hexagons' prisms and lane graphs this process is holding, and why.
 *
 * ---------------------------------------------------------------------------
 * WHY BOTH, AND WHY THE LANE GRAPH TOOK A SECOND ROUND TO GET HERE.
 *
 * Measured on the 19.3 km world, one process per subsystem: collision is
 * **193 MB of live heap** for 25.4 MB of files, and the lane graph is
 * **131.9 MB** for 13.9 MB -- 325 MB of a 1 GB box between them, and at
 * EXPANSION.md's 7-8x, 1.4-1.6 GB and 0.9-1.0 GB respectively. Neither fits at
 * 60 km and neither is optional: collision is what stops a player walking
 * through a warehouse, and the lane graph is every car and every footpath in
 * the city.
 *
 * Collision came first because the lane fields could not be streamed at all.
 * `TrafficField.adopt`/`drop` and `PedestrianField.adopt`/`drop` existed, but
 * both set a dirty flag and the next `near()` rebuilt the flat array and the
 * whole broadphase grid over *every* resident tile -- 14.42 ms at full
 * residency, 86% of a 60 Hz budget, paid on the first query after every single
 * tile arrival. That is a stall on every hexagon crossing, and it is why the
 * previous pass measured the lane graph, wrote the number down and left it
 * whole. Those two classes now maintain their indexes per tile and in a
 * canonical order (see `game/traffic.TrafficField`'s header for the design and
 * the measurement); the same tile change now costs **0.017 ms**, and a whole
 * 374-tile hexagon comes out in 7.8 ms instead of 4,930 ms.
 *
 * ---------------------------------------------------------------------------
 * TWO CAPS, ONE NEEDED SWEEP. Why the split falls where it does.
 *
 * What the two layers **share** is everything that is a fact about a hexagon
 * rather than about a payload: one distance sweep per recomputation answers both
 * margins, one manifest read serves both layers' tiles, one `usedAt` stamp
 * orders both layers' evictions, and one `APPLY_BUDGET_MS` bounds the tick.
 * Adding the lane graph did not add a millisecond to the residency's worst tick.
 *
 * What they do **not** share is the byte account, and that is deliberate:
 *
 *   - **The two numbers already mean different things and are already
 *     deployed.** `SYDNEY_COLLISION_CAP_MB` is documented in DEPLOY.md with a
 *     measured RSS ratio behind it. Folding the lane graph into it would
 *     silently change what every existing setting of that variable does, on a
 *     box that is sized to 1 GB.
 *   - **The failure modes are different, so an operator wants to tune them
 *     apart.** Missing prisms is a player walking through a wall -- visible,
 *     reportable, and briefly unfair. Missing lanes is a street with no traffic
 *     on it, which is invisible and costs nobody a fight. Those are not
 *     interchangeable megabytes.
 *   - **A shared cap could not trade between them anyway.** Evicting a
 *     hexagon's lanes does not free a prism, so a single account would trim
 *     whichever layer's victim happened to sort first and call it a saving.
 *     Two accounts trim the thing that is actually over.
 *
 * The consequence to be aware of: a hexagon can be lanes-resident and
 * collision-absent, or the reverse. That is correct rather than tolerated --
 * the lane margin is four times the collision margin on purpose (see
 * `LANES_NEED_MARGIN_M`), so the steady state near a boundary is exactly that.
 *
 * ---------------------------------------------------------------------------
 * WHAT A HEXAGON WHOSE LANES HAVE NOT ARRIVED ANSWERS: no traffic, no crowd.
 *
 * The same shape of answer the collision gap gives, and the same argument.
 * `TrafficField.near` finds no routes, so `carHitting` returns null and nobody
 * is run over; `PedestrianField.near` finds no bands, so no walker is posed and
 * no officer stands on a beat there. There is no "unknown" and nothing to
 * synthesise one from.
 *
 * **The server is authoritative for being hit by a car, so the direction this
 * fails in is not "invisible cars run people down".** A car the server is not
 * simulating cannot knock anybody over. What a player could in principle see is
 * the opposite: a client, which streams lanes for rendering, drawing a car that
 * passes through somebody with no knockdown.
 *
 * That window is closed rather than bounded, and `LANES_NEED_MARGIN_M` is where
 * the closing is argued: the widest route in the city reaches 1,164.7 m past its
 * own tile and the hit test reaches 6 m, so 2,000 m of margin means every car
 * that can touch a participant is in a hexagon that participant has already made
 * this process load. What is left is the load *gap* -- the half second between a
 * hexagon being wanted and its tiles being decoded -- and that is 250 ms of
 * needed-set latency plus a budgeted decode against 12.7 s of travel at the
 * fastest speed in the game. `checkServerSegments` walks it.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS CLASS WILL BREAK ITS OWN CAP FOR.
 *
 * A hexagon somebody is standing in is never evicted, cap or no cap. Going over
 * budget is a number in a log line; dropping the prisms out from under a player
 * is `world/tile-lifecycle.ts`'s "safety-critical to drop the ground out from
 * under somebody", and there is nothing downstream of it that can tell.
 */
export class HexResidency {
  private readonly root: string;
  private readonly slots = new Map<string, HexSlot>();
  private contract: HexContract | null = null;
  private readonly rootIndex: HexIndex | null;
  readonly capBytes: number;
  readonly lanesCapBytes: number;
  readonly staticCarsCapBytes: number;
  private readonly collisionLayer: HexLayer;
  private readonly lanesLayer: HexLayer;
  private readonly staticCarsLayer: HexLayer;

  /** Monotonic, bumped per needed-set recomputation. The LRU clock. */
  private clock = 0;
  private ticks = 0;
  /** Points that count as occupied whether or not anybody is there. See `pin`. */
  private anchors: readonly number[] = [];
  /**
   * Where everybody was on the **last** update, copied rather than referenced.
   *
   * The needed set is recomputed at 4 Hz and `trim` runs at 60, so for up to
   * 250 ms the set can be out of date -- and there is exactly one way to be
   * inside a hexagon that the set does not know about, which is to arrive
   * without crossing the margin first. That is `/tp <suburb>`. Without this the
   * teleport lands in a hexagon that is resident, unneeded and possibly the LRU
   * victim, and the player has the prisms taken out from under them by the very
   * next tick.
   *
   * So the eviction re-asks the question exactly, for the one hexagon it is
   * about to drop. That is O(players) per eviction rather than
   * O(players * hexagons) per tick, which is why it is here and not in `update`.
   *
   * Copied in place into an array this object owns, because the caller's is
   * `RoomHost.occupants`' reused scratch and will be overwritten before the next
   * eviction reads it.
   */
  private readonly lastPoints: number[] = [];

  constructor(
    root: string,
    rootIndex: HexIndex | null,
    collision: CollisionWorld,
    capBytes: number,
    traffic: TrafficField,
    peds: PedestrianField,
    lanesCapBytes: number,
    /**
     * The carriageways, which come out of the same sidecar as the traffic.
     *
     * A constructor argument rather than something the caller wires up
     * afterwards, because the lane layer's `apply` closure is built in here and
     * a deck attached later would miss every hexagon that had already landed.
     */
    roads: RoadDeck,
    /**
     * WORKSTREAM S: the parked fleet, on the roads' terms exactly -- a
     * constructor argument, because the third layer's `apply` closure is built in
     * here and a field attached afterwards would miss every hexagon that had
     * already landed.
     */
    staticCars: StaticCarField = new StaticCarField(),
    staticCarsCap: number = staticCarsCapBytes(),
  ) {
    this.root = root;
    this.rootIndex = rootIndex;
    this.capBytes = capBytes;
    this.lanesCapBytes = lanesCapBytes;
    this.staticCarsCapBytes = staticCarsCap;
    const manifest = (slot: HexSlot): Promise<HexTiles | null> => this.readManifest(slot);
    this.collisionLayer = new HexLayer(
      {
        name: 'collision',
        capName: 'SYDNEY_COLLISION_CAP_MB',
        capBytes,
        marginM: COLLISION_NEED_MARGIN_M,
        path: (key) => join('collision', `${key}.bin`),
        has: (key) => collision.hasTile(key),
        apply: (key, buffer, originX, originZ, buildings) => {
          const added = collision.addTile(key, buffer, originX, originZ, buildings);
          return {
            items: added,
            bytes: estimateCollisionBytes(added, verticesInPayload(buffer.byteLength, added)),
          };
        },
        remove: (key) => collision.removeTile(key),
      },
      root,
      this.slots,
      (slot) => slot.collision,
      manifest,
    );
    this.lanesLayer = new HexLayer(
      {
        name: 'lanes',
        capName: 'SYDNEY_LANES_CAP_MB',
        capBytes: lanesCapBytes,
        marginM: LANES_NEED_MARGIN_M,
        path: (key) => join('tiles', `${key}.lanes.bin`),
        has: (key) => traffic.hasTile(key),
        // The identical offset the prisms use, and `loadWorld`'s whole-world
        // path used before them: a car route runs out of its own tile and has no
        // group to inherit a translation from, so `decodeLanes` folds the origin
        // in once. The client applies the same pair in `streamer.loadLanes`.
        // `originZ` is already `bounds[1] + tile_size`; see `readTiles`.
        apply: (key, buffer, originX, originZ) => {
          const decoded = decodeLanes(buffer, originX, originZ);
          if (decoded === null) return { items: 0, bytes: 0 };
          traffic.adopt(key, decoded);
          // The footpaths, off the same decoded object. One file, two consumers,
          // and no second decode -- `PedestrianField.adopt` derives its bands
          // from the ways block the routes were built beside.
          peds.adopt(key, decoded);
          // ---------------------------------------------------------------
          // **And a third: the carriageways, as the ground the carve may not
          // take.** See `world/road-deck.ts`, and `groundFor` for what reads it.
          //
          // This is the cheap half of the road rule and it is worth being exact
          // about why, because the *other* half is still switched off two
          // paragraphs down and the two look alike from a distance.
          //
          // A deck is only ever **queried**, never applied to anything that is
          // already resident. `RailCut.cutAt` asks it at the moment somebody
          // wants a ground height, so a hexagon of roads landing late costs one
          // `Map.set` per strip and changes every future answer for free. The
          // browser does the identical thing per tile in `streamer.buildTile`,
          // off the identical bytes, so the two ends agree about where King
          // Street is without a byte on the wire.
          //
          // **What is still not done here is `ClearanceEnvelope.addRoads`**, and
          // the reason is a measurement rather than an oversight. A corridor
          // added to the envelope means **re-offering prisms that are already
          // resident** -- a building carved once has to be carved again when a
          // road it straddles arrives -- and that is an unbounded step in the
          // middle of a serial boot. Measured: the whole-disc load went from 34 s
          // to over ten minutes, and a standalone server never answered
          // `/health` in 300 s. The box's unit allows 20 seconds and 560 MB. That
          // is a fact about carving *solids* and none of it applies to a lookup.
          //
          // The road envelope belongs where `elevated.py` already does this cut,
          // at bake time, where the whole road graph is in hand at once and the
          // result is bytes rather than a boot step. `ROAD_CLEARANCE_M` and
          // `addRoads` are kept and self-checked against that day.
          roads.adopt(key, decoded.ways);
          let routePoints = 0;
          for (const route of decoded.routes) routePoints += route.count;
          let wayPoints = 0;
          for (const way of decoded.ways) wayPoints += way.count;
          return {
            items: decoded.routes.length,
            bytes: estimateLaneBytes(decoded.routes.length, routePoints, wayPoints),
          };
        },
        remove: (key) => {
          traffic.drop(key);
          peds.drop(key);
          // And the deck, so a hexagon out of range is not still holding a lid
          // over a railway. `streamer.dispose` drops it on exactly the same
          // argument at the other end of the wire.
          roads.drop(key);
        },
      },
      root,
      this.slots,
      (slot) => slot.lanes,
      manifest,
    );
    // --- WORKSTREAM S: the third layer, and it is the shortest of the three
    //     because everything hard about residency was already here.
    //
    // `.cars.bin` is a `u32` count and sixteen bytes a car, decoded by
    // `staticcars.decodeCars` -- the same function the browser's streamer runs,
    // moved out of `world/cars.ts` so this process can load it at all. There is
    // no second consumer and no envelope to feed: a parked car is a row in a
    // field and the only question anybody asks it is `resolveTake`'s.
    //
    // **A missing file is a tile with no parked cars, and that is deliberate.**
    // `HexLayer.read` uses `readOptional`, so a `.cars.bin` the box was never
    // sent reads as absent rather than as an error -- which matters more here
    // than for the other two layers, because until DEPLOY.md §A step 2 gains
    // `--include='*.cars.bin'` **that is every tile on the box**. A deployment
    // that has not shipped them behaves exactly as the server did before this
    // workstream: schedule cars are takeable, parked ones are not, nothing warns
    // and nothing breaks. `boot`'s log line reports the resident car count so the
    // difference is visible in one number.
    this.staticCarsLayer = new HexLayer(
      {
        name: 'static cars',
        capName: 'SYDNEY_STATIC_CARS_CAP_MB',
        capBytes: staticCarsCap,
        marginM: STATIC_CARS_NEED_MARGIN_M,
        path: (key) => join('tiles', `${key}.cars.bin`),
        has: (key) => staticCars.has(key),
        apply: (key, buffer, originX, originZ) => {
          // The tile key goes into the decoder because a parked car's identity is
          // `staticCarIdentity(tileKey, index)` and the sidecar carries none of
          // its own -- the browser passes the identical argument in
          // `streamer.buildTile`, which is what makes the two ends name the same
          // car. Without it `StaticCarField.adopt` refuses the tile outright.
          const decoded = decodeCars(buffer, key);
          if (decoded === null) return { items: 0, bytes: 0 };
          // The prisms' origin pair, verbatim: `originZ` is already
          // `bounds[1] + tile_size`. See `readTiles`, and this file's header on
          // what getting the frame wrong looks like (nothing, until a player
          // presses E at a car that is 250 m from where the server thinks it is).
          staticCars.adopt(key, decoded, originX, originZ);
          return {
            items: decoded.count,
            bytes: estimateStaticCarBytes(decoded.count, 1),
          };
        },
        remove: (key) => staticCars.drop(key),
      },
      root,
      this.slots,
      (slot) => slot.staticCars,
      manifest,
    );
    if (!hexesUsable(rootIndex)) return;
    this.arm();
    for (const entry of this.contract!.list) {
      this.slots.set(entry.id, {
        entry,
        tiles: null,
        reading: null,
        usedAt: 0,
        collision: emptyLayerSlot(),
        lanes: emptyLayerSlot(),
        staticCars: emptyLayerSlot(),
      });
    }
  }

  /** False on a world built before segmentation, where `loadWorld` reads everything. */
  get enabled(): boolean {
    return this.contract !== null;
  }

  /** Every hexagon in the contract, in the order the root index lists them. */
  get entries(): readonly HexEntry[] {
    return this.contract?.list ?? [];
  }

  /**
   * Point `hexDistance` at this world's contract, if something else has moved it.
   *
   * `world/hexes.ts` keeps the contract in module state -- it was written for a
   * browser, where there is one world and one client. In this process
   * `checkHexCoverage` arms it too, and `verifyHexes` arms a synthetic nine-by-
   * nine lattice with its own circumradius and restores afterwards. Rather than
   * depend on somebody else's save-and-restore discipline, this asks before
   * every decision whether the armed contract is still the one it was built on,
   * and re-arms if it is not. Sixteen `Map.set`s, and it makes the residency's
   * geometry its own problem.
   *
   * The alternative -- a copy of `hexDistance` on this side -- is the exact
   * duplication `world/hexes.ts`'s header exists to refuse, and the void chasm
   * in commit 8e544f6 is what one copy of that arithmetic disagreeing with the
   * other looks like.
   */
  private arm(): void {
    if (hexContract() === this.contract && this.contract !== null) return;
    armHexes(this.rootIndex, this.root, '');
    this.contract = hexContract();
  }

  /** How far a point is from a hexagon, zero inside it. `world/hexes.ts`'s own. */
  distance(entry: HexEntry, x: number, z: number): number {
    this.arm();
    return hexDistance(entry, x, z);
  }

  /** Read one hexagon's manifest, once, however many layers ask for it. */
  private readManifest(slot: HexSlot): Promise<HexTiles | null> {
    if (slot.tiles !== null) return Promise.resolve(slot.tiles);
    if (slot.reading === null) {
      slot.reading = this.readTiles(slot.entry).then((tiles) => {
        slot.reading = null;
        if (tiles !== null) slot.tiles = tiles;
        return tiles;
      });
    }
    return slot.reading;
  }

  /** Read one hexagon's manifest down to the eight bytes a tile needs from it. */
  private async readTiles(entry: HexEntry): Promise<HexTiles | null> {
    let manifest: {
      tile_size: number;
      tiles: Array<{ key: string; bounds: [number, number, number, number]; b?: number }>;
    };
    try {
      manifest = JSON.parse(
        await readFile(join(this.root, this.contract!.dir, `${entry.id}.json`), 'utf8'),
      );
    } catch {
      return null;
    }
    if (!Array.isArray(manifest.tiles)) return null;
    const n = manifest.tiles.length;
    const out: HexTiles = {
      keys: new Array<string>(n),
      originX: new Float64Array(n),
      originZ: new Float64Array(n),
      buildings: new Int32Array(n),
    };
    for (let i = 0; i < n; i++) {
      const tile = manifest.tiles[i];
      out.keys[i] = tile.key;
      // `loadWorld`'s offset verbatim, and copied rather than re-derived for the
      // reason in this file's header: prisms one tile north of the client's is a
      // game where players walk through buildings and are stopped by empty air.
      out.originX[i] = tile.bounds[0];
      out.originZ[i] = tile.bounds[1] + manifest.tile_size;
      out.buildings[i] = tile.b ?? 0;
    }
    return out;
  }

  /**
   * Points that are needed whether or not anybody is standing on them.
   *
   * There is exactly one, and it is the spawn. Every join is placed by
   * `Sim.joinSpot`, which probes the prisms to keep somebody out of a warehouse,
   * and a join is not a thing that can wait half a second for a hexagon: the
   * player is already in the room by the time the collision would land. So the
   * spawn's hexagon is held for the life of the process -- one hexagon, 26 MB of
   * prisms and 22 MB of lanes on this build -- rather than being evicted by an
   * empty server and re-fetched underneath the first person to arrive.
   *
   * `/tp <suburb>` is deliberately **not** pinned. A teleport is somewhere the
   * player already is by the next tick, so the ordinary rule picks it up 250 ms
   * later and they walk through a wall for a moment; pinning every suburb would
   * be pinning the map.
   */
  pin(points: readonly number[]): void {
    this.anchors = points;
  }

  /**
   * The hexagons a set of participants needs, by the collision margin rule.
   *
   * `points` is flat `x, z` pairs -- every connected player and every bot across
   * every room on this host, because the fields are shared by reference and a
   * hexagon room 3 needs is a hexagon room 5 is holding too. See `roomWorld`.
   */
  neededFor(points: readonly number[], out = new Set<string>()): Set<string> {
    return this.neededWithin(points, COLLISION_NEED_MARGIN_M, out);
  }

  /** The same question at an arbitrary margin. The lane layer asks at 2,000 m. */
  neededWithin(points: readonly number[], margin: number, out = new Set<string>()): Set<string> {
    out.clear();
    if (this.contract === null) return out;
    this.arm();
    for (const slot of this.slots.values()) {
      if (
        reaches(slot.entry, points, margin) ||
        (this.anchors.length > 0 && reaches(slot.entry, this.anchors, margin))
      ) {
        out.add(slot.entry.id);
      }
    }
    return out;
  }

  /** Is this hexagon's collision fully resident right now? */
  isResident(id: string): boolean {
    const slot = this.slots.get(id);
    return slot !== undefined && this.collisionLayer.isResident(slot);
  }

  /** And its lane graph? */
  isLanesResident(id: string): boolean {
    const slot = this.slots.get(id);
    return slot !== undefined && this.lanesLayer.isResident(slot);
  }

  /** And its parked cars? WORKSTREAM S. */
  isStaticCarsResident(id: string): boolean {
    const slot = this.slots.get(id);
    return slot !== undefined && this.staticCarsLayer.isResident(slot);
  }

  /** Is its collision wanted by somebody, as of the last needed-set recomputation? */
  isNeeded(id: string): boolean {
    return this.collisionLayer.needed.has(id);
  }

  /** And its lane graph, at the wider margin? */
  isLanesNeeded(id: string): boolean {
    return this.lanesLayer.needed.has(id);
  }

  /** The hexagon a point is in, or null out past the built extent. For `/tp` and the checks. */
  hexAt(x: number, z: number): HexEntry | null {
    if (this.contract === null) return null;
    this.arm();
    for (const slot of this.slots.values()) {
      if (hexDistance(slot.entry, x, z) === 0) return slot.entry;
    }
    return null;
  }

  /**
   * One tick of the residency: notice, start, decode, trim. Both layers.
   *
   * Called once per host tick from `server/index.ts`, before the rooms step, so
   * a hexagon started this tick has the whole tick's slack to read in. Nothing
   * here awaits: the reads are started and forgotten, and their payloads are
   * decoded by the budget below on later ticks.
   */
  update(points: readonly number[]): void {
    if (this.contract === null) return;
    this.lastPoints.length = 0;
    for (let i = 0; i < points.length; i++) this.lastPoints.push(points[i]);
    if (this.ticks++ % NEED_INTERVAL_TICKS === 0) {
      this.clock++;
      // One sweep for the collision margin and one for the lanes margin. Two
      // passes over `slots * points` rather than one, and it is 0.16 ms a
      // recomputation at 100 players and 16 hexagons -- 0.01 ms a tick at 4 Hz
      // -- because both are the same three multiplies against a hexagon centre.
      // Merging them into a single pass that computed the distance once would
      // save half of that and cost the two margins their independence.
      this.neededWithin(points, COLLISION_NEED_MARGIN_M, this.collisionLayer.needed);
      this.neededWithin(points, LANES_NEED_MARGIN_M, this.lanesLayer.needed);
      // **The third layer borrows the second's answer rather than sweeping
      // again.** `STATIC_CARS_NEED_MARGIN_M` *is* `LANES_NEED_MARGIN_M` -- see
      // that constant for why the two arrive at the same number from different
      // arguments -- so a third pass would compute a set already in hand.
      // Copied rather than aliased, so the two layers keep separate `Set`s and a
      // future change to either margin is one line here and nothing else.
      this.staticCarsLayer.needed.clear();
      for (const id of this.lanesLayer.needed) this.staticCarsLayer.needed.add(id);
      // The stamp is per hexagon, so a hexagon wanted by either layer is
      // recently-used for both. That is the right meaning: `usedAt` orders
      // evictions by how long ago anybody cared about this piece of the map, and
      // a hexagon whose lanes are wanted is one a player is walking toward.
      for (const id of this.lanesLayer.needed) this.slots.get(id)!.usedAt = this.clock;
      for (const id of this.collisionLayer.needed) {
        const slot = this.slots.get(id)!;
        slot.usedAt = this.clock;
        this.collisionLayer.start(slot);
      }
      for (const id of this.lanesLayer.needed) this.lanesLayer.start(this.slots.get(id)!);
      for (const id of this.staticCarsLayer.needed) this.staticCarsLayer.start(this.slots.get(id)!);
    }
    const began = performance.now();
    const deadline = began + APPLY_BUDGET_MS;
    this.collisionLayer.drain(deadline);
    // Whatever collision left, and never less than `LANES_FLOOR_MS`. See there.
    this.lanesLayer.drain(Math.max(deadline, performance.now() + LANES_FLOOR_MS));
    // And the parked cars, last and with the same floor, which is the right
    // priority for the same reason the lanes are behind the prisms: a player
    // falling through the world outranks a car that has not started driving,
    // which outranks a car that is not going anywhere at all. It is also the
    // cheapest of the three to decode -- `decodeCars` is 0.03 ms for an average
    // tile and does no indexing -- so the floor drains any queue the reader can
    // fill. `LANES_FLOOR_MS`' own argument applies verbatim: the pending queue
    // holds `ArrayBuffer`s, so starving it is a memory leak.
    this.staticCarsLayer.drain(Math.max(deadline, performance.now() + LANES_FLOOR_MS));
    // After the decode rather than before it, and every tick rather than every
    // fifteenth. The bytes only ever *arrive* in `drain`, so trimming ahead of it
    // measures the residency one budget out of date and leaves the process over
    // cap for the rest of the interval. Under cap this is one comparison.
    this.trim();
  }

  /**
   * The exact test, for the one hexagon a layer is about to give up.
   *
   * See `lastPoints`: a teleport is inside a hexagon the 4 Hz needed set has not
   * heard about yet. Asked at that layer's own margin, so the lane layer keeps
   * the wider skirt it was given.
   */
  private pinnedFor(layer: HexLayer): (slot: HexSlot) => boolean {
    const margin = layer.spec.marginM;
    return (slot) =>
      reaches(slot.entry, this.lastPoints, margin) || reaches(slot.entry, this.anchors, margin);
  }

  private trim(): void {
    // The distance tests below read `world/hexes.ts`'s module contract, and this
    // is a path `update` can reach without having gone through `neededWithin` on
    // this tick. See `arm`.
    this.arm();
    this.collisionLayer.trim(this.pinnedFor(this.collisionLayer));
    this.lanesLayer.trim(this.pinnedFor(this.lanesLayer));
    this.staticCarsLayer.trim(this.pinnedFor(this.staticCarsLayer));
  }

  /** Read and decode one hexagon's **collision** to completion. The boot path. */
  async loadNow(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    await this.collisionLayer.loadNow(slot, ++this.clock);
  }

  /** And its lane graph. For the checks, and for nothing on the boot path. */
  async loadLanesNow(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    await this.lanesLayer.loadNow(slot, ++this.clock);
  }

  /**
   * And its parked cars. WORKSTREAM S, and the boot walk calls this on the lane
   * layer's own terms -- see `loadWorld`, which stops the moment either cap bites.
   */
  async loadStaticCarsNow(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined) return;
    await this.staticCarsLayer.loadNow(slot, ++this.clock);
  }

  /** Wait for every load in flight to land. The boot path's `ensureHexesNear`. */
  async settle(): Promise<void> {
    // Ten seconds of local-disk reads is a disk that is not going to answer;
    // giving up leaves the hexagon absent and re-startable rather than holding
    // the boot open, which is `ensureHexesNear`'s own call.
    const until = performance.now() + 10_000;
    while (
      (this.collisionLayer.busy || this.lanesLayer.busy || this.staticCarsLayer.busy) &&
      performance.now() < until
    ) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      this.collisionLayer.drain(Infinity);
      this.lanesLayer.drain(Infinity);
      this.staticCarsLayer.drain(Infinity);
    }
  }

  /**
   * Trim to the cap during the boot walk, where nothing is needed yet.
   *
   * `loadWorld` visits every hexagon once to lay the bikes out (see
   * `layOutBikes`), and without this the walk would hold the whole world at its
   * peak -- which is the thing this class exists to stop. With it the peak is
   * the cap plus one hexagon.
   */
  trimToCap(): void {
    this.trim();
  }

  /** Evict everything, both layers. For the checks, which build a world and take it apart. */
  dropAll(): void {
    this.collisionLayer.dropAll();
    this.lanesLayer.dropAll();
    this.staticCarsLayer.dropAll();
  }

  /**
   * Is everything both layers currently want actually here?
   *
   * The boot walk's fixed point, and the checks'. False while anything is still
   * arriving, and false for good on a world whose cap cannot hold its own
   * needed set -- which is why every caller bounds its loop rather than
   * spinning on this.
   */
  neededAllResident(): boolean {
    for (const id of this.collisionLayer.needed) if (!this.isResident(id)) return false;
    for (const id of this.lanesLayer.needed) if (!this.isLanesResident(id)) return false;
    for (const id of this.staticCarsLayer.needed) if (!this.isStaticCarsResident(id)) return false;
    return true;
  }

  /** Resident collision file bytes, so the boot line can still say how much is held. */
  get residentFileBytes(): number {
    return this.collisionLayer.fileBytes;
  }

  /** And the lane sidecars'. */
  get residentLaneFileBytes(): number {
    return this.lanesLayer.fileBytes;
  }

  /** And the parked cars' sidecars. WORKSTREAM S. */
  get residentStaticCarFileBytes(): number {
    return this.staticCarsLayer.fileBytes;
  }

  stats(): SegmentStats {
    const collision = this.collisionLayer.stats();
    const lanes = this.lanesLayer.stats();
    const staticCars = this.staticCarsLayer.stats();
    return {
      enabled: this.contract !== null,
      hexes: this.slots.size,
      resident: collision.resident,
      loading: collision.loading,
      needed: collision.needed,
      bytes: collision.bytes,
      capBytes: collision.capBytes,
      tiles: collision.tiles,
      prisms: collision.items,
      loads: collision.loads,
      evictions: collision.evictions,
      overCap: collision.overCap,
      pending: collision.pending,
      collision,
      lanes,
      staticCars,
    };
  }
}

/**
 * The cap, from the environment, in bytes.
 *
 * Denominated in **estimated resident bytes** rather than in file bytes, and the
 * difference is the whole reason the cap is a real control: the 19.3 km world's
 * collision is 25.4 MB of files and 208 MB of heap, so a cap counted in file
 * bytes would never bind at any radius this project will ever build. See
 * `BYTES_PER_PRISM`.
 *
 * On the 1 GB production box the number to size against is RSS, and the measured
 * ratio of RSS to live heap for this data is about **1.9x** -- so 450 MB of
 * estimated prisms is roughly 850 MB of resident process, which is the ceiling
 * rather than the target. DEPLOY.md's box wants 150-250 here. The default is
 * high on purpose: it is a backstop against a pathological spread of players,
 * and what actually decides residency in ordinary play is the needed set, which
 * is three hexagons around a room that has not scattered.
 */
export function collisionCapBytes(): number {
  const raw = Number(process.env.SYDNEY_COLLISION_CAP_MB ?? DEFAULT_COLLISION_CAP_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COLLISION_CAP_MB;
  return mb * 1e6;
}

/**
 * And the lane graph's, in the same denomination and for the same reasons.
 *
 * 300 rather than 450 because the lane graph is smaller than the prisms at every
 * radius -- 131.9 MB against 193 MB at 19.3 km, and EXPANSION.md's 7-8x puts it
 * at 0.9-1.0 GB against 1.4-1.6 GB -- and because its margin is four times as
 * wide, so a default that is generous costs more hexagons here than it does
 * there. Like the collision cap it is a backstop against a pathological spread
 * of players and not the thing that decides ordinary residency; DEPLOY.md's 1 GB
 * box wants 100-150.
 *
 * Separate from `SYDNEY_COLLISION_CAP_MB` rather than folded into it. See
 * `HexResidency`'s header for the three reasons, of which the operational one is
 * that the two variables would otherwise silently change meaning under every
 * deployment that already sets one of them.
 *
 * ---------------------------------------------------------------------------
 * **At 60 km the whole lane graph estimates at 394.6 MB, so this default now
 * bites at boot.** Measured, not projected: 86 hexagons, 15,057 lane tiles,
 * 71,798 items, `estimateLaneBytes` = 394,583,136 B. EXPANSION.md's 7-8x on the
 * 131.9 MB figure above would have said 0.9-1.0 GB; it is under half that,
 * because the outer ring is paddocks and national park rather than more
 * Newtown.
 *
 * Three hundred is still the right default and nothing here changes: the boot
 * walk stops loading lanes the moment the cap bites (see `loadWorld`), and the
 * residency then loads what participants actually need at
 * `LANES_NEED_MARGIN_M`, which for any one player is three to seven hexagons at
 * about 4.6 MB apiece. A player standing in Penrith gets Penrith's footpaths.
 *
 * What it *does* change is that **a bare `loadWorld` no longer hands back the
 * whole city**, and anything that treats one as a picture of the world is now
 * wrong: it comes back with roughly the first two thirds of the hexagon walk,
 * and the third it drops is a contiguous slab of the map. `integration-check`'s
 * coverage checks hit exactly that and now open the world through
 * `loadWholeWorld`; see its header for the nine police stations and 168 suburbs
 * this quietly emptied.
 */
export function lanesCapBytes(): number {
  const raw = Number(process.env.SYDNEY_LANES_CAP_MB ?? DEFAULT_LANES_CAP_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LANES_CAP_MB;
  return mb * 1e6;
}

/**
 * And the parked fleet's, in the same denomination and for the same reasons.
 *
 * WORKSTREAM S. Twenty-four megabytes by default against 46.1 MB for every parked
 * car in Sydney -- see `DEFAULT_STATIC_CARS_CAP_MB` for why the default is under
 * the whole rather than over it.
 *
 * **"The same denomination" is not quite true and the difference is in this
 * layer's favour.** `collisionCapBytes` counts *live heap* and an operator has to
 * apply the measured ~1.9x heap-to-RSS ratio by hand to size a box. This layer is
 * six `ArrayBuffer`s a tile with no index over them, which JSC accounts as
 * external memory and does not report in `heapUsed` at all -- so
 * `staticcars.BYTES_PER_STATIC_CAR` was measured as an RSS delta instead, and 24
 * here means about 24 MB of resident process. No ratio, no arithmetic.
 *
 * A third variable rather than a share of one of the others, on `lanesCapBytes`'
 * three arguments verbatim: the two existing numbers are documented in DEPLOY.md
 * with measured ratios behind them and are already set on a 1 GB box, the failure
 * modes are not interchangeable (a missing parked car is a car you cannot steal;
 * a missing prism is a wall you walk through), and a shared account could not
 * trade between the layers anyway because evicting a car does not free a prism.
 */
export function staticCarsCapBytes(): number {
  const raw = Number(process.env.SYDNEY_STATIC_CARS_CAP_MB ?? DEFAULT_STATIC_CARS_CAP_MB);
  const mb = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STATIC_CARS_CAP_MB;
  return mb * 1e6;
}

/** A planned bike, put on the ground. See `layOutBikes`. */
export interface PlacedBike {
  id: number;
  spot: BikeSpot;
}

/**
 * The capsule a parked bike is tested against, and how high a kerb it may stand
 * on. The player's own, deliberately.
 *
 * A bike is about the width of the person pushing it, and the thing that
 * actually matters is that a bike must never be parked somewhere a player cannot
 * walk up to. Testing it with the *player's* radius is what guarantees that: any
 * spot that admits a bike admits the person coming to fetch it. The 0.42 is the
 * controller's step height, so a kerb is not an obstacle -- a bike parked on a
 * kerb is a bike parked correctly.
 *
 * Moved here from `server/sim.ts` when the layout moved: the placement is now
 * done once per process, against a hexagon that is resident for exactly as long
 * as it takes to place that hexagon's bikes, rather than once per room against a
 * whole world nobody holds any more.
 */
const PLACE_RADIUS = PLAYER_RADIUS;
const PLACE_STEP = 0.42;

/**
 * Put the planned bikes down, for the tiles named or for every tile.
 *
 * **This has to be called with the tile's own prisms resident, and that is why
 * it takes a tile filter.** `bikePlan` insets its point 40 m from every tile
 * edge and `placeBike`'s spiral reaches 30.5 m, so a bike is decided entirely by
 * its own tile -- which is what lets `loadWorld` walk the hexagons one at a time
 * and still produce the layout a whole-world load would have. `checkServerSegments`
 * asserts that equality rather than trusting the arithmetic.
 *
 * The ids are `bikePlan`'s 1..n over the **whole** index, unchanged, because
 * `net/protocol.ts` rests on a `u16` meaning the same bike on both ends -- see
 * `game/bikes.bikePlan`'s header on exactly this.
 */
export function layOutBikes(
  world: ServerWorld,
  keys?: ReadonlySet<string>,
  plans = bikePlan(world.index.tiles),
): PlacedBike[] {
  const placeWorld = groundFor(world);
  const ground: BikeGround = {
    groundHeight: (x, z, feetY) => placeWorld.groundHeight(x, z, feetY),
    // A null move against the prisms, which is `main.ts`'s own `placeClear` test
    // and `combat.pickRespawn`'s: `resolve` pushes a circle out of anything it
    // overlaps and reports whether it had to.
    clear: (x, z, y) => !world.collision.resolve(x, z, x, z, PLACE_RADIUS, y + PLACE_STEP).hit,
    waterSurface: (x, z) => world.water.surfaceAt(x, z),
  };
  const out: PlacedBike[] = [];
  for (const plan of plans) {
    if (keys !== undefined && !keys.has(plan.tileKey)) continue;
    const spot = placeBike(plan, ground);
    // A null is a tile with nowhere to park -- all building, all water, or out
    // over the harbour -- and is a normal outcome rather than a failure.
    if (spot) out.push({ id: plan.id, spot });
  }
  return out;
}

export interface TileEntry {
  key: string;
  /** `[minX, minZ, maxX, maxZ]`, north-positive. */
  bounds: [number, number, number, number];
  /**
   * Buildings in the tile.
   *
   * Picks a spawn, as `main.ts` does -- and, since the walk-under rule, splits
   * this tile's payload into structures and buildings for `CollisionWorld`. See
   * the `addTile` call in `loadWorld`.
   */
  b: number;
  /**
   * The water surface over this tile, world y, absent where there is none.
   *
   * The only field in the index this process reads that is not about *finding* a
   * file, and it is here because the wading rule has to be authoritative: a
   * client that predicted wading and a server that did not would fight over
   * every shoreline in the city. Both build the same table from this same field
   * -- see `client/src/world/wading.ts`, which is the whole of the agreement.
   */
  wy?: number;
}

export interface WorldIndex {
  stage: string;
  /**
   * The radius this build actually covers, metres -- the pipeline's own
   * statement of what it wrote. Read by `integration-check`'s coverage gate so
   * a table baked for a stage the world has not been rebuilt to yet is judged
   * against the ground that exists rather than against the ground it will have.
   */
  radius_m: number;
  tile_size: number;
  terrain: { grid: number; datum_ahd: number; sea_level_y: number };
  tiles: TileEntry[];
}

/**
 * The loaded world, plus the `CombatWorld` the shared simulation runs against.
 *
 * `ground` is deliberately **not** `CombatWorld.groundHeight`: that signature
 * takes a feet height and answers "how high is the world here", which folds in
 * roofs and therefore depends on who is asking. See `groundFor`.
 */
export interface ServerWorld {
  index: WorldIndex;
  /** The streaming hexagons, which are also the turf. Empty on an unsegmented world. See `game/territory.ts`. */
  hexes: readonly HexEntry[];
  collision: CollisionWorld;
  terrain: TerrainField;
  /**
   * Where the water is, from the index. Built here rather than derived per
   * combatant because it is immutable for the life of the process and is the
   * same object every `CombatWorld` reads.
   */
  water: WaterLevels;
  powerups: PowerupField;
  /** Every point, flat, in the order the fields were adopted. Ticked whole. */
  points: readonly PowerupPoint[];
  /**
   * WORKSTREAM AA: `points` filed by position, slots being indices into it.
   *
   * Built once, because on a server every tile is resident and the set never
   * changes after boot. It is what turns the pickup pass from 3,128 hash
   * queries a tick -- the largest single line in the tick, and one that ran at
   * full cost with nobody connected -- into one query per player. See
   * `game/powerups.tickPowerups` and `PowerupField.residentIndex`.
   */
  pointIndex: SpatialHash<number>;
  /** Tile keys that had a powerup sidecar, so a pickup can name its tile. */
  tileOf: Map<string, { tileX: number; tileZ: number }>;
  /**
   * Every lane graph **near somebody**, and therefore every moving car.
   *
   * Held per hexagon under `SYDNEY_LANES_CAP_MB`, on the prisms' own terms and
   * on the same slots -- see `HexResidency`. It used to be adopted whole at boot
   * on the argument that "the routes for the inner ring are 1.4 MB"; the file
   * bytes were never the cost, and the two lane fields together were measured at
   * **131.9 MB of live heap** on the 19.3 km build, which EXPANSION.md's 7-8x
   * puts near a gigabyte.
   *
   * Nothing about a car is ever sent to a client -- both ends evaluate the same
   * baked timetable at the same wall-clock tick -- so what a lazily-loaded field
   * has to guarantee is that it *answers* identically, which is what
   * `LANES_NEED_MARGIN_M` and `game/traffic.ts`'s canonical bucket order are
   * between them for. See `game/traffic.ts`.
   */
  traffic: TrafficField;
  /**
   * The footpaths, and therefore every walker and every officer on a beat.
   *
   * Derived from the **same decoded lane sidecar** the traffic is, in the same
   * loop, at no extra I/O -- `buildBands` reads the ways block the routes come
   * from and offsets it, which `game/pedestrians.ts` documents at length. That
   * is the whole reason this could be added to the server without a new file
   * format: the pipeline already emitted the geometry a footpath is derived
   * from, for the traffic.
   *
   * The server needs it for one reason and it is the police: a crime has to be
   * witnessed *here* rather than claimed by a client, and a witness is an
   * officer on a beat, and a beat is a reserved slot on one of these bands. The
   * crowd itself is still cosmetic and still client-local -- nothing on this
   * process poses a pedestrian except to re-run a strike a client claims to have
   * landed, which is exactly what `Sim.resolveStrike` now does.
   */
  peds: PedestrianField;
  /**
   * Every parked car **near somebody**, and therefore every car a player can
   * actually steal. WORKSTREAM S.
   *
   * Held per hexagon under `SYDNEY_STATIC_CARS_CAP_MB`, on the prisms' and the
   * lane graph's terms and on the same slots -- see `HexResidency`. It used to
   * not exist at all, and `game/driving.ts` section 1 spent three rounds
   * explaining why: `.cars.bin` was a renderer file. The measurement that made
   * the third layer obvious rather than expensive is in
   * `staticcars.BYTES_PER_STATIC_CAR` -- the whole city is 33 MB, an order of
   * magnitude under either of the other two layers, because a parked car is six
   * numbers and never moves.
   *
   * Nothing about a parked car is ever sent to a client. Both ends decode the
   * same bytes into the same field and `driving.resolveTake` asks both. What is
   * on the wire is only the `DrivenCar` record that exists *after* somebody has
   * taken one, which is the same `MSG.CARS` upsert a stolen schedule car has
   * always used -- the identity fits its `u32` and the protocol needed no change.
   *
   * **Optional on `segments`' own terms**, which is this file's convention for
   * something `loadWorld` always builds and a hand-made fixture never does:
   * absent means "no parked car is takeable", which is precisely the behaviour
   * that shipped before this workstream and is exactly right for the empty test
   * cities in `sim.verifySim`, `cardamage-check.ts` and `accounts-check.ts` --
   * none of which has a street, let alone a car parked in one. `loadWorld` sets
   * it unconditionally, so every real world has one.
   */
  staticCars?: StaticCarField;
  bytes: {
    collision: number;
    terrain: number;
    powerups: number;
    lanes: number;
    /** Optional for the reason `staticCars` above is: a fixture has no sidecars. */
    staticCars?: number;
  };
  /**
   * The decoded powerup sidecars, kept so a second room can have its own field
   * without a second read of the disk. See `roomWorld`.
   *
   * 14 kB for the inner ring, held for the life of the process. The alternative
   * -- re-reading and re-decoding 372 files per room -- would be 2.9 MB of I/O
   * and about 300 ms of boot **per room**, to produce arrays identical to these.
   */
  powerupSource: ReadonlyArray<{
    tileKey: string;
    kind: Uint8Array;
    worldX: Float32Array;
    worldY: Float32Array;
    worldZ: Float32Array;
  }>;
  /**
   * The **centre** of the join disc: Sydney Park, or the nearest point to it the
   * built extent can hold. See `game/spawn.ts`, which both ends compute from
   * this same index -- nobody is placed *on* it. `Sim.joinSpot` draws a
   * dithered point out of the disc around it, per join.
   */
  spawn: { x: number; z: number };
  /**
   * The suburb label nodes, for `/tp <suburb>`.
   *
   * The same `world/suburbs.json` the client's locator strip reads, loaded here
   * so the *server* can resolve a name — a teleport is an authoritative move, so
   * the destination must be chosen from data this process holds rather than from
   * anything a client sends. 16 kB and 316 names at 15.3 km.
   *
   * Empty rather than fatal when the file is missing: a world built before the
   * pipeline emitted suburbs still runs, and `/tp` simply cannot find anything
   * in it. See `game/teleport.ts`.
   */
  places: Place[];
  /**
   * Which hexagons' prisms are held, and the thing that decides. See
   * `HexResidency`.
   *
   * Absent on a world built before segmentation and on the synthetic worlds the
   * checks build, and in both cases the meaning is the old one: `collision`
   * holds everything there is, for the life of the process.
   */
  segments?: HexResidency;
  /**
   * Every lime e-bike, laid out once for the host rather than once per room.
   *
   * It used to be laid out in `Simulation`'s constructor, which was correct
   * while every prism in the city was resident and is not any more: with
   * collision held per hexagon, a room built at 10:00 and a room built at 10:05
   * would test their bikes against whatever happened to be loaded and park them
   * in different places. It also did the same 1,062 placements R times.
   *
   * So `loadWorld` walks the hexagons once, places each hexagon's bikes while
   * that hexagon is resident, and hands every room the same answer -- which is
   * what all the rooms already had, now stated rather than assumed. See
   * `layOutBikes`.
   */
  bikeSpots?: readonly PlacedBike[];
  /**
   * The train timetable, or null on a build with no rail bake beside the world.
   *
   * **The server needs this and never used to**, and the reason is a boarding
   * claim. `INPUT` carries a button and nothing else, so a client pressing `E`
   * beside a train is asking a question -- and the only way to answer it is to
   * evaluate `poseTrain` at this tick against this server's own idea of where
   * that player is standing. See `sim.resolveMount` and
   * `game/riding.findBoarding`.
   *
   * Nothing about a train is *sent* to a client, which is the whole shape of
   * this feature: the timetable is a closed-form function of the millisecond and
   * both ends read the identical bake. This is a read of the same 1 MB file the
   * browser fetches from `/rail/rail.bin`, decoded by the same
   * `game/rail.decodeRail`, and it costs 1.0 MB of file and about 3 MB resident
   * against the 310 MB the city already is.
   *
   * Optional, and absent is a working configuration rather than a broken one:
   * the checks build worlds by hand and a deployment whose pipeline predates the
   * rail round has no bake. Boarding is simply refused, which is the same answer
   * a player standing in the harbour gets.
   */
  rail?: RailBake | null;
  /**
   * Every station platform in the city, as rectangles. Null with no bake.
   *
   * Built once at boot from the same bake the browser draws its platform prisms
   * from, and folded into `groundFor` so that a body standing on a platform is
   * standing at the same height on both ends. See `game/riding.PlatformField`,
   * which is honest about this being a bug the riding round inherited: the
   * pipeline does not emit platform prisms, `world/rail-geo.ts` builds them at
   * runtime in a module that imports three, and this process has therefore never
   * had them.
   */
  platforms?: PlatformField | null;
  /**
   * The railway's own solids, evaluated. See `world/rail-solids.ts`.
   *
   * `platforms` above is the same idea, one structure wide, and its header says
   * why it exists: the drawn prisms are a browser's and this process has none.
   * This is the rest of the railway -- the trench wall a body walks the coping
   * of, the viaduct deck it stands on, the flight it climbs, the station
   * building it walks round -- answered from the same enumeration `rail-geo`
   * hands `CollisionWorld`, rather than not answered at all.
   */
  railSolids?: RailSolidField | null;
  /**
   * And the same solids as **lateral** collision, held near whoever is near them.
   *
   * `railSolids` above answers "how high is the railway over this point", which
   * is half of what a body asks. The other half is "may I walk here", and until
   * this field the answer on this process was yes everywhere -- a trench wall, a
   * pier and a station wall were things the browser was stopped by and this
   * process had never heard of, so the two ends disagreed about a wall the
   * player could see. `server/rail-lateral.ts` closes it by registering the
   * identical prisms `world/rail-geo.buildChunk` gives the browser into the
   * `CollisionWorld` this process already resolves against. Null with no rail
   * bake, exactly as `railSolids` is.
   */
  railLateral?: RailLateralField | null;
  /**
   * The rail corridor, so `groundFor` knows where the ground **is not**.
   *
   * `world/rail-cut.ts`'s header names this process as its second caller and
   * gives the reason it imports nothing but the flag constants: *"`server/world.ts`
   * needs the same corridor to answer 'how high is the ground' for a player
   * standing in a cutting"*. It was written for this and never wired up, and the
   * gap is a real one -- see `groundFor`.
   */
  railCut?: RailCut | null;
  /**
   * The railway as closed solids, and the ground query over them. Null unless
   * `SYDNEY_VESSELS=1`.
   *
   * **Phase 2a of `STATIONS.md`, behind its flag.** Where this answers, it
   * *replaces* the terrain rather than competing with it, for a stronger reason
   * than `PlatformField`'s: inside a vessel's rim ring the terrain is not merely
   * lower, it **is not there** -- `world/seam.ts` withheld it and the mesh is
   * triangulated to that very ring. The DEM over a cutting is a sheet across a
   * hole and always was; this is the first thing on either end that knows the
   * hole's exact outline rather than a 3.9 m staircase approximation of it.
   *
   * Built from `world/corridor.ts`, which `main.ts` also calls, so the two ends
   * are running one assembly rather than two that agree.
   */
  vessels?: VesselField | null;
  /**
   * Every carriageway resident on this process, as the ground the carve stops at.
   *
   * The fix for the report *"train at St Peters STILL covers the road at king
   * st ... Roads should be uninterrupted everywhere"*. Handed to `railCut` at
   * boot and filled per hexagon thereafter by the lane layer; `groundFor` never
   * touches it directly, because the whole point is that there is **one**
   * function that answers "is the ground here" and the road is folded into it.
   * See `world/road-deck.ts`.
   */
  roads?: RoadDeck;
  /**
   * The underground stations, as the volumes a body may be inside. Null with no bake.
   *
   * The third of the three fields `groundFor` consults, and the one that was
   * missing: a platform is 5.5 m wide, a cutting is open to the sky and
   * `RailCut.cutAt` declines on a bore, so the inside of a station box was
   * answered by the DEM twenty metres over the top of it. A client walking
   * across the Town Hall concourse was a client this process dragged up into
   * George Street at the correction rate. See `game/riding.StationBoxField`.
   */
  stationBoxes?: StationBoxField | null;
  /** `collision.tileCount` when `stationBoxes` was last built; see `boxesOf`. */
  stationBoxesTiles?: number;
}

/**
 * Read the whole extent.
 *
 * `root` is the directory the client serves tiles from -- `client/public/world`
 * -- which is the same path a browser fetches them over. Spec 9's answer was
 * "static tiles", so the server reads the files and serves none of them: vite
 * (or any static host) keeps that job, and this process never learns what a GLB
 * is.
 *
 * **Collision and the lane graph are read per hexagon**; the terrain, the
 * powerups, the index and the suburb names are still read whole. Between them
 * the two segmented layers were 325 MB of the 310 MB whole-world load's
 * measured heap -- the rest is 9 MB -- so what is left resident is the part that
 * does not grow with the radius in a way a 1 GB box would notice. This function
 * ends with the hexagons around the spawn resident and everything else on
 * demand, which is `hexes.ensureHexesNear`'s boot contract on the other side of
 * the wire.
 */
export async function loadWorld(
  root: string,
  capBytes = collisionCapBytes(),
  laneCapBytes = lanesCapBytes(),
  staticCarCapBytes = staticCarsCapBytes(),
): Promise<ServerWorld> {
  const index = JSON.parse(await readFile(join(root, 'index.json'), 'utf8')) as WorldIndex;

  // The segment contract. Optional on the same terms as the suburbs below: a
  // world built before `sydney hex-pack` existed carries no `hexes` block, and
  // `hexesUsable` is the same predicate `TileStreamer.loadIndex` asks before it
  // commits to a segmented client. When it says no, every prism is read at boot
  // exactly as this function always did.
  let rootIndex: HexIndex | null = null;
  try {
    rootIndex = JSON.parse(await readFile(join(root, 'root.json'), 'utf8')) as HexIndex;
  } catch {
    rootIndex = null;
  }

  // The suburb names, for `/tp`. Optional by construction: a world built before
  // the pipeline emitted this file is still a world, and the command reports
  // "not found" rather than the boot failing over a 16 kB convenience.
  let places: Place[] = [];
  try {
    places = JSON.parse(await readFile(join(root, 'suburbs.json'), 'utf8')) as Place[];
  } catch {
    places = [];
  }

  const collision = new CollisionWorld();
  /**
   * The corridors nothing may stand in. See `world/envelope.ts`.
   *
   * Constructed before the residency because the `lanes` layer feeds it as each
   * hexagon's carriageways land, and adopted by `collision` once the rail bake
   * is read, a hundred lines down. Empty until then, which carves nothing, which
   * is the honest answer for a process that has not been told where the railway
   * is yet.
   */
  const envelope = new ClearanceEnvelope();
  const traffic = new TrafficField();
  const peds = new PedestrianField();
  /**
   * Where the ground stays whatever the railway wants. See `world/road-deck.ts`.
   *
   * Constructed here, beside `envelope`, for the same reason: the lane layer
   * fills it as each hexagon's carriageways land, so it has to exist before the
   * residency does. Empty until then, which keeps nothing, which is the honest
   * answer for a process that has not read a street yet.
   */
  const roads = new RoadDeck();
  /**
   * The parked fleet, on `roads`' and `envelope`'s terms: constructed before the
   * residency because the third layer fills it as each hexagon's `.cars.bin`
   * lands, so it has to exist before the residency does. Its `groundAt` is
   * attached at the bottom of this function, once there is a `railCut` and a
   * `railSolids` for `groundFor` to fold in -- see `staticcars.ts` section 3 on
   * why the height is a query rather than a stored field.
   */
  const staticCars = new StaticCarField();
  const segments = new HexResidency(
    root, rootIndex, collision, capBytes, traffic, peds, laneCapBytes, roads,
    staticCars, staticCarCapBytes,
  );
  const terrain = new TerrainField(index.terrain.grid, index.tile_size, root);
  const powerups = new PowerupField();
  const tileOf = new Map<string, { tileX: number; tileZ: number }>();
  const points: PowerupPoint[] = [];
  const bytes = { collision: 0, terrain: 0, powerups: 0, lanes: 0, staticCars: 0 };
  const powerupSource: Array<{
    tileKey: string;
    kind: Uint8Array;
    worldX: Float32Array;
    worldY: Float32Array;
    worldZ: Float32Array;
  }> = [];

  // In parallel, because 663 small reads serialised behind each other is two
  // seconds of boot on a spinning disk and about 300 ms on this one -- and
  // because nothing here depends on anything else here.
  await Promise.all(
    index.tiles.map(async (entry) => {
      const [tileX, tileZ] = entry.key.split('_').map(Number);
      tileOf.set(entry.key, { tileX, tileZ });

      // The prisms are **not** read here on a segmented world -- `HexResidency`
      // owns them, per hexagon, and the walk below is where they arrive. On an
      // unsegmented world there is no hexagon to own them and this is still the
      // whole-world read it always was.
      //
      // The offset is `main.ts`'s, verbatim. See the header.
      //
      // **And the building count with it, which is now physics rather than a map
      // feature.** It marks the deck, viaduct and bridge volumes written ahead
      // of the buildings as `Prism.structural`, and `resolve` reads that flag to
      // decide whether a prism's `base` is a soffit to walk under or a pad with
      // a skirt drawn to the ground. A server that left it out would hold the
      // Cahill solid at street level while every client walked under it -- the
      // two authorities running different worlds, which is the one thing this
      // file exists to prevent. Client side it is `main.ts`'s `entry.b` on the
      // same index. `HexResidency` carries the identical three arguments out of
      // the hexagon manifest, which lists the same bounds and the same `b`.
      if (!segments.enabled) {
        const prisms = await readOptional(join(root, 'collision', `${entry.key}.bin`));
        if (prisms) {
          bytes.collision += prisms.byteLength;
          collision.addTile(
            entry.key,
            prisms,
            entry.bounds[0],
            entry.bounds[1] + index.tile_size,
            entry.b,
          );
        }
      }

      const grid = await readOptional(join(root, 'tiles', `${entry.key}.terr.bin`));
      if (grid) {
        const decoded = decodeTerrain(grid, index.terrain.grid);
        if (decoded) {
          bytes.terrain += grid.byteLength;
          terrain.adopt(entry.key, decoded);
        }
      }

      const picks = await readOptional(join(root, 'tiles', `${entry.key}.pow.bin`));
      if (picks) {
        const data = decodePowerups(picks);
        if (data) {
          bytes.powerups += picks.byteLength;
          // Tile-local to world, the conversion `streamer.ts` makes once on its
          // side. The tile group sits at `(bounds[0], 0, bounds[1] + tile_size)`
          // and `groundY` is already absolute.
          const originX = entry.bounds[0];
          const originZ = entry.bounds[1] + index.tile_size;
          const worldX = new Float32Array(data.count);
          const worldZ = new Float32Array(data.count);
          for (let i = 0; i < data.count; i++) {
            worldX[i] = data.x[i] + originX;
            worldZ[i] = data.z[i] + originZ;
          }
          powerups.adopt(entry.key, data.kind, worldX, data.groundY, worldZ);
          // Kept for `roomWorld`. `PowerupField.adopt` builds fresh
          // `PowerupPoint` objects from these arrays, so a second field built
          // from the same four typed arrays shares no mutable state with the
          // first -- which is the whole property a room needs.
          powerupSource.push({ tileKey: entry.key, kind: data.kind, worldX, worldY: data.groundY, worldZ });
        }
      }

      // The lane graph. Decoded straight into world metres by the same offset
      // the prisms use, because a car route runs out of its own tile and has no
      // group to inherit a translation from -- the client applies the identical
      // pair in `streamer.loadLanes`, and the two agreeing is what makes a
      // predicted knockdown and an authoritative one the same event.
      //
      // Not read here on a segmented world, on exactly the prisms' terms above:
      // `HexResidency`'s lane layer owns it, per hexagon, at
      // `LANES_NEED_MARGIN_M`. `HexTiles` carries the identical origin pair out
      // of the hexagon manifest, which lists the same bounds.
      // The parked fleet, on the prisms' and the lanes' terms: read here only on
      // an **unsegmented** world, where there is no hexagon to own it. That is
      // the synthetic worlds the checks build and any bake made before
      // `sydney hex-pack`; on the real 60 km build `HexResidency`'s third layer
      // owns this at `STATIC_CARS_NEED_MARGIN_M` and this branch never runs.
      //
      // Whole-world here is affordable *because of* the measurement in
      // `staticcars.BYTES_PER_STATIC_CAR`: 46 MB for every parked car in Sydney.
      // A pre-hex world already reads every prism and every lane at boot, which
      // is 325 MB, so this is a rounding error against a configuration that was
      // never going to fit a 1 GB box anyway.
      const parked = segments.enabled
        ? null
        : await readOptional(join(root, 'tiles', `${entry.key}.cars.bin`));
      if (parked) {
        const decoded = decodeCars(parked, entry.key);
        if (decoded) {
          bytes.staticCars += parked.byteLength;
          staticCars.adopt(entry.key, decoded, entry.bounds[0], entry.bounds[1] + index.tile_size);
        }
      }

      const lanes = segments.enabled
        ? null
        : await readOptional(join(root, 'tiles', `${entry.key}.lanes.bin`));
      if (lanes) {
        const decoded = decodeLanes(
          lanes,
          entry.bounds[0],
          entry.bounds[1] + index.tile_size,
        );
        if (decoded) {
          bytes.lanes += lanes.byteLength;
          traffic.adopt(entry.key, decoded);
          // The footpaths, off the same decoded object. One file, two consumers,
          // and no second decode -- `PedestrianField.adopt` derives its bands
          // from the ways block the routes were built beside.
          peds.adopt(entry.key, decoded);
          // ...and the third: the carriageways the terrain carve must not take.
          // The lane layer does the identical line for a segmented world; this
          // branch is the unsegmented one, where every tile is read at boot.
          roads.adopt(entry.key, decoded.ways);
        }
      }
    }),
  );

  // Every tile is resident on the server, so `resident()` is the whole world and
  // is snapshotted once rather than rebuilt per tick. `PowerupField` rebuilds
  // its flat array only when the resident set changes, which after boot is
  // never -- but taking a copy makes that a guarantee rather than an
  // implementation detail being relied on from another package.
  points.push(...powerups.resident());

  const world: ServerWorld = {
    index,
    hexes: rootIndex?.hexes?.list ?? [],
    collision,
    terrain,
    // One table for the process, off the index that has already been read. No
    // file is opened for it and none needs to be: a tile's water *level* is one
    // float in the index, and the sheets themselves are geometry this process
    // never draws.
    water: WaterLevels.fromIndex(index.tiles, index.tile_size),
    powerups,
    traffic,
    peds,
    staticCars,
    points,
    // WORKSTREAM AA. Off the same field, in the same order, at the same moment
    // -- the slots in here are indices into the array on the line above and the
    // two must be taken together or the pickup pass reads the wrong cafe.
    pointIndex: powerups.residentIndex(),
    tileOf,
    bytes,
    powerupSource,
    spawn: spawnCentre(index),
    places,
    segments: segments.enabled ? segments : undefined,
    rail: await loadRail(root),
    platforms: null,
    railCut: null,
    railSolids: null,
    railLateral: null,
    roads,
    stationBoxes: null,
    vessels: null,
  };
  world.platforms = world.rail ? buildPlatforms(world.rail) : null;
  world.railCut = world.rail ? new RailCut(world.rail) : null;
  world.stationBoxes = world.rail ? buildStationBoxes(world.rail, accessWorldOf(world)) : null;
  // The hole in the street each way in goes down through. See `riding.accessCutAt`.
  if (world.railCut && world.stationBoxes) world.railCut.setAccess(world.stationBoxes.plans, (x, z) => world.terrain.height(x, z));
  world.stationBoxesTiles = world.collision.tileCount;
  // **And the roads, which is where the carve stops.** `main.ts` writes the
  // identical line one statement after it builds its own `RailCut`, over a deck
  // built from the identical `.lanes.bin` bytes by the identical decoder. That
  // is the whole of what makes King Street solid on both ends: not two rules
  // that agree, one rule asked twice. See `world/road-deck.ts`.
  //
  // **And the foot paving out of the bake, for the same reason.** `.lanes.bin`
  // carries no footway, so the deck alone cannot keep the ground under the
  // plaza, the bridge cycleway or the crossings the player fell through at King
  // Street. `main.ts` makes this identical call over the identical bytes.
  if (world.rail) roads.adoptPaving(world.rail.paving);
  world.railCut?.setRoads(roads);
  // **And which lattice the ground is drawn on**, which is what stops this
  // process disagreeing with a browser's terrain mesh about where a cutting
  // starts. `main.ts` makes the identical call from the identical two index
  // fields. See `RailCut.groundCutAt` for the two-metre slot in King Street this
  // exists for.
  world.railCut?.setCarveLattice(index.tile_size / index.terrain.grid, CUT_SUBDIVISION);
  // The corridor opens out at a platform, and both ends have to agree about
  // where. This process cannot import `rail-geo` -- it draws things -- so the
  // anchors come from `riding.buildPlatforms`, and `main.ts` now reads the
  // **same** call, which is what makes the two answers the same number rather
  // than two numbers that agree today. Without it the server's corridor is 5.4 m
  // wide at a station where the client's is 9.4, and the four metres of
  // difference is exactly the strip the access stairs stand in.
  //
  // **This comment used to claim that and be wrong**, which Phase 2a measured
  // and Phase 3 fixed. `main.ts` handed `RailCut` the anchors out of
  // `rail-geo.buildNetwork().stations`, which adds a fallback for stations
  // *nothing calls at* -- 361 sites against this end's 358 -- and sampled every
  // 6 m along every platform, 87 of 29,479 points came out with a different
  // half-width, by up to the full 4.00 m of the flare. Two processes disagreeing
  // about where the ground is. Both ends now call this function.
  if (world.railCut && world.platforms) world.railCut.setStations(world.platforms.sites);

  // **And the rest of the railway, which this process has never had at all.**
  //
  // `railCut` above says where the ground is *not*; `platforms` says where one
  // of the things standing in the hole is. Everything else `world/rail-geo.ts`
  // builds -- the trench wall and its coping, the viaduct deck and its piers,
  // the footbridge, the station building, the access flights, the head of a
  // subway shaft -- existed only as a `CollisionWorld` prism written by a
  // browser inside `BUILD_RADIUS`, so this end answered the ground query without
  // any of it. Measured over every station envelope in the bake before this
  // line: the two ends disagreed at **54,293 of 670,437** lattice samples, worst
  // 14.0 m, and where they disagree the server wins and the player is corrected
  // into or out of geometry they can see.
  //
  // Built here, after `setStations`, because a trench wall's rim is
  // `RailCut.halfWidthAt` and the flare is what that call just installed. It is
  // lazy -- see `RailSolidField` -- so this line costs a segment grid and a
  // station grid and nothing else at boot.
  if (world.rail) {
    const net = buildNetwork(world.rail);
    const rawGround = (x: number, z: number): number => world.terrain.height(x, z);
    // `RailWorld`'s `ground` argument, which `main.ts` fills with
    // `groundHeightAt(x, z, -Infinity)` and which only a pier's foot reads.
    // Asking the ground query at `-Infinity` feet makes every roof clause --
    // this field's included -- answer `-Infinity`, so there is no circularity
    // here and no order to get wrong.
    let lastGround = 0;
    const wildGround = (x: number, z: number): number => {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      const boxFloor = world.stationBoxes?.floorAt(x, z, -Infinity) ?? -Infinity;
      if (boxFloor > -Infinity) return boxFloor;
      const floor = world.railCut?.groundCutAt(x, z, sampled) ?? Number.NaN;
      return Number.isFinite(floor) ? floor : lastGround;
    };
    // `buildChunk`'s `vesselled`, which is `() => false` with the flag down and
    // is `VesselField.surfaceAt` with it up. It has to be here as well as there:
    // inside a formation's footprint `writeTrench` draws and registers nothing,
    // so a field that still answered with a wall would be the divergence this
    // file removes, reintroduced by the flag. See `RailWorld.vesselFloorAt`.
    const vesselled = (x: number, z: number): boolean =>
      world.vessels !== null && world.vessels !== undefined && world.vessels.surfaceAt(x, z) > -Infinity;
    world.railSolids = new RailSolidField(net, world.railCut ?? null, rawGround, wildGround, vesselled);
    // And the lateral half, over the same field and the same `CollisionWorld`
    // every other layer of this world resolves against. It holds nothing until
    // `Rooms.step` tells it where somebody is; see `server/rail-lateral.ts` on
    // why the residency is by entity and why the radius is the browser's.
    world.railLateral = new RailLateralField(world.railSolids, world.collision);
  }

  // **The vessel path, off unless asked for.** Phase 2a: nothing here runs, and
  // nothing about the world changes, unless `SYDNEY_VESSELS=1`. The sweep needs
  // the DEM resident, which on this process it is -- every grid is read off disk
  // at boot and never evicted -- so this is the one end that can build the whole
  // corridor in one go and is where the walks in `checkVesselSeam` are made.
  if (process.env.SYDNEY_VESSELS === '1') setVesselsEnabled(true);
  if (vesselsEnabled() && world.rail) {
    const cut = corridorCut(world.rail);
    const lattice = { pitch: index.tile_size / index.terrain.grid / 8 };
    const built = buildCorridor(
      world.rail,
      cut,
      (x, z) => world.terrain.height(x, z),
      lattice,
    );
    world.vessels = built.field;
    console.log(
      `[vessels] ${built.tracks} tracks grouped into ${built.runs.length} formations, ` +
        `${built.triangles.toLocaleString()} triangles, ${built.refused.length} refused, ` +
        `${built.noTerrain} without terrain; ${built.doubleCells} of ` +
        `${built.claimedCells.toLocaleString()} claimed cells claimed twice ` +
        `(${built.crossings.length} grade separations)`,
    );
  }

  // **And the volume nothing may stand in**, which this process needs for the
  // same reason it needs the carve: a building standing across the railway is a
  // wall on one end of the wire and a tunnel on the other, and a client walking
  // through a hole the server has not opened is a client the server drags back.
  //
  // The railway goes in here, at boot, before a single prism is resident, so
  // every tile this process ever loads is carved on the way in. The roads go in
  // per hexagon with the lane sidecar -- see the `lanes` layer's `apply` -- and
  // re-offer the prisms that are already there. `ClearanceEnvelope` is additive
  // and `carve` is idempotent, so the two orders converge.
  if (world.rail) {
    envelope.addRail(world.rail, SPAN_TUNNEL);
    collision.setEnvelope(envelope);
    // Corridors only. The carve tally belongs to the hexagons, not to boot:
    // this line runs before a single prism is resident, as the paragraph above
    // says, so `collision.carved` is necessarily zero here. It used to be
    // printed anyway, and a permanent `0 prisms given an undercroft` reads as
    // "the rule never runs" -- it cost a whole investigation. A number that can
    // only ever be zero is worse than no number.
    console.log(`[envelope] ${envelope.count.toLocaleString()} rail corridors adopted before the first prism`);
  }

  // --- The bikes, and the one walk over every hexagon this boot makes ---------
  //
  // Every hexagon is visited once, its bikes are placed while its prisms are
  // resident, and it is then kept or dropped by the cap alone. Three things fall
  // out of that and each of them is load-bearing:
  //
  //   - **The layout is the whole-world layout.** A bike is decided entirely by
  //     its own tile (`bikePlan` insets 40 m; `placeBike`'s spiral reaches
  //     30.5 m), so visiting the city a hexagon at a time produces the identical
  //     answer -- asserted, not assumed, by `checkServerSegments`.
  //   - **The peak is the cap plus one hexagon**, not the whole world. That is
  //     the number the 1 GB box actually has to survive, and holding the world
  //     briefly at boot would have missed the point entirely.
  //   - **A world that fits under the cap ends up whole**, because nothing is
  //     trimmed until the cap is reached. So on the 19.3 km build with the
  //     default 450 MB this function returns exactly what it always returned,
  //     and every check that queries a building nobody is standing near still
  //     finds it.
  //
  // **The walk asks for collision and not for lanes, and that is checked rather
  // than assumed.** `bikePlan` needs the tile's bounds and three integer hashes;
  // `placeBike` needs `groundHeight` (terrain, whole-world resident),
  // `clear` (`collision.resolve`) and `waterSurface` (the index's own table).
  // No path through either reads a route or a band, so laying the bikes out with
  // the lane layer empty produces the identical layout -- which is what lets the
  // boot walk stay a collision-only walk and keeps its peak where it was.
  // `checkServerSegments` asserts the layout against a whole-world load, which
  // is the same assertion at a stronger point: if a bike ever did depend on a
  // lane, the capped and uncapped layouts would part company.
  if (segments.enabled) {
    const placed: PlacedBike[] = [];
    const seen = new Set<string>();
    // Planned once, filtered per hexagon: `bikePlan` hashes every tile in the
    // index, and re-running it per hexagon is 2.6 million hashes at 60 km to
    // produce the same list 121 times.
    const plans = bikePlan(index.tiles);
    for (const entry of segments.entries) {
      await segments.loadNow(entry.id);
      // And its lanes, **while the lane cap is not binding**.
      //
      // Nothing at boot needs a lane. This is here so that the property the
      // collision walk gives for free -- *a world that fits under its cap ends
      // up whole* -- holds for the lane graph too, because a great deal depends
      // on it: `SYDNEY_LANES_CAP_MB` unset on a dev box, and every one of the
      // hundred-odd checks in `integration-check.ts` that opens the real world
      // and asks it about traffic, footpaths, police beats or meth heads three
      // suburbs from where anybody is standing.
      //
      // It stops the moment the cap has actually bitten, and that is the whole
      // of the difference from the collision walk. Past that point every further
      // hexagon would be read off the disk, decoded, and evicted by the next
      // `trimToCap` -- 110 MB of file reads and a few seconds of `buildBands` at
      // 60 km, to arrive at exactly the residency this would have had anyway.
      // The prisms cannot do this because the bikes genuinely need them.
      if (segments.stats().lanes.evictions === 0) await segments.loadLanesNow(entry.id);
      // And its parked cars, on exactly the same terms and for exactly the same
      // reason: so that *a world that fits under its cap ends up whole*. That
      // property is what `server/take-check.ts` and every check that walks up to
      // a car three suburbs from the spawn depend on, and at 46 MB for the whole
      // city the default 24 MB cap means this walk covers about half of Sydney
      // before it stops. Past the first eviction every further hexagon would be
      // read, decoded and immediately trimmed.
      if (segments.stats().staticCars.evictions === 0) await segments.loadStaticCarsNow(entry.id);
      const mine = new Set<string>();
      for (const key of collision.residentTiles()) if (!seen.has(key)) mine.add(key);
      for (const bike of layOutBikes(world, mine, plans)) placed.push(bike);
      for (const key of mine) seen.add(key);
      segments.trimToCap();
    }
    // Tiles in `index.json` that no manifest claims. `checkHexCoverage` says
    // there are none and asserts it on the real build; if a future pipeline
    // leaves one behind, its bike is still placed -- against whatever is
    // resident, which for a tile in no hexagon is the honest answer.
    const orphans = new Set<string>();
    for (const entry of index.tiles) if (!seen.has(entry.key)) orphans.add(entry.key);
    if (orphans.size > 0) for (const bike of layOutBikes(world, orphans, plans)) placed.push(bike);
    // Back into `bikePlan`'s index order, because `bikeRecords` sends them in
    // the order the field holds them and a joiner's list should not depend on
    // which hexagon was walked first.
    placed.sort((a, b) => a.id - b.id);
    world.bikeSpots = placed;

    // And the spawn's own hexagons, awaited -- the one place a hexagon is waited
    // for, exactly as `hexes.ensureHexesNear` is the client's. Everybody joins
    // here, `Sim.joinSpot` probes the prisms to place them, and a spawn chosen
    // against an empty city is a player standing inside the first warehouse
    // somebody built there.
    //
    // Both layers, because `update` drives both: the spawn's lanes arrive here
    // too, which is what stops the first joiner standing on a street with no
    // traffic on it for the half second the lane layer would otherwise take.
    segments.pin([world.spawn.x, world.spawn.z]);
    // Driven to a fixed point rather than once, because `LOAD_CONCURRENCY` is
    // two per layer and the spawn's 2,000 m lane skirt can want three hexagons.
    // One `update` would start two of them, `settle` would return with the third
    // never begun, and the first joiner would stand on a street the server was
    // not driving. The inner loop is `NEED_INTERVAL_TICKS` because that is the
    // gate on the needed sweep; the outer one is bounded so a world whose cap
    // cannot hold its own spawn still boots.
    for (let round = 0; round < 40; round++) {
      for (let i = 0; i < NEED_INTERVAL_TICKS; i++) segments.update([]);
      await segments.settle();
      if (segments.neededAllResident()) break;
    }
    segments.trimToCap();
    bytes.collision = segments.residentFileBytes;
    bytes.lanes = segments.residentLaneFileBytes;
    bytes.staticCars = segments.residentStaticCarFileBytes;
  } else {
    world.bikeSpots = layOutBikes(world);
  }

  // --- WORKSTREAM S: and where the ground is, for the parked fleet.
  //
  // Last, because `groundFor` closes over `platforms`, `railCut`, `railSolids`,
  // `stationBoxes` and `vessels` at the moment it is called, and all five are
  // filled in above. A `CombatWorld` of its own rather than a shared one, on the
  // reason `groundFor`'s own header gives: it carries a `lastGround`, and one
  // shared with a combatant would let a car inherit the height of whoever was
  // standing on a warehouse roof.
  //
  // `feetY` reaches this from `resolveTake`'s asker, so the answer is "the ground
  // under this car, on the level the person pressing E is standing on" -- which is
  // the whole of how a car on the Cahill Expressway and a player on Alfred Street
  // stay each other's business or not. See `game/staticcars.ts` section 3.
  staticCars.groundAt = groundFor(world).groundHeight;

  return world;
}

/**
 * The train timetable, off the same file the browser fetches.
 *
 * `client/public/rail/rail.bin` sits beside `client/public/world`, which is the
 * `root` this module is handed, so it is one directory up and back down --
 * spelled out rather than parameterised, because there is exactly one of these
 * and a second path to keep in sync is a second path that goes stale. The
 * browser's `world/rail-geo.loadRailBake` fetches the identical bytes from
 * `/rail/rail.bin` and runs the identical decoder.
 *
 * Never throws. A world with no bake is a world where `E` beside a train does
 * nothing, which is what every hand-built check world already is, and a bake
 * that fails its own `verifyRail` is refused rather than half-trusted: a
 * timetable the two ends disagree about is worse than no timetable, because the
 * disagreement is a passenger standing in a train the server says is 400 m away.
 */
async function loadRail(root: string): Promise<RailBake | null> {
  const path = join(root, '..', 'rail', 'rail.bin');
  try {
    const buf = await readFile(path);
    const bake = decodeRail(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const bad = verifyRail(bake);
    if (bad.length > 0) {
      console.warn(`[sydney] rail bake at ${path} failed its own check: ${bad[0]}. Trains are scenery.`);
      return null;
    }
    return bake;
  } catch {
    return null;
  }
}

/**
 * A world for one room: the same city, its own coffees.
 *
 * PERFORMANCE.md phase 3. A host process runs R rooms and **loads the city
 * once** -- 2.4 MB of collision prisms, 249 kB of terrain and 1.4 MB of lane
 * graphs, which at eight rooms would otherwise be 33 MB and eight times the boot
 * -- so everything in a `ServerWorld` that is read-only is shared by reference
 * and nothing else is.
 *
 * **Exactly one field is not read-only, and finding it is the whole of this
 * function.** `PowerupPoint.active` and `PowerupPoint.respawnT` are mutated by
 * `tickPowerups` sixty times a second, so two rooms sharing a `PowerupField`
 * would be taking each other's coffees: a flat white collected in room 3 would
 * vanish from the pavement in room 5 and come back on room 3's clock. The
 * integration check already knew this -- `checkSpatialHash` builds its two
 * `Simulation`s against two separately-loaded worlds and says so in as many
 * words -- and this is that observation turned into the seam it implied.
 *
 * Everything else was audited and is genuinely immutable after load:
 *
 *   - `CollisionWorld` holds a per-query `seen` stamp on each prism, which is
 *     scratch *within* one synchronous query. Rooms tick one after another and
 *     never interleave inside a query, so the stamp is never observed across
 *     rooms. (This is the same property `game/powerups.ts`'s module scratch
 *     already relies on, asserted by `checkSpatialHash` section 7.)
 *   - `TerrainField`, `WaterLevels` and `TrafficField` are lookup tables. A car
 *     is a pure function of `trafficTick(Date.now())` -- see `game/traffic.ts`
 *     -- so every room sees the same fleet on the same timetable, which is
 *     correct: the traffic is the city, not the match. Both lane fields are now
 *     *mutated* by the residency rather than frozen after boot, and that changes
 *     nothing here for the reason `segments` gives below: one host-wide
 *     residency, driven once per host tick before any room steps.
 *   - `PedestrianField` is bands derived from the lane graph; the crowd's poses
 *     are computed into caller-owned scratch (`Simulation` holds its own). Its
 *     one piece of mutable state is the knockdown registry, which is keyed on
 *     `pedKey(osmId, side, slot)` rather than on a band object -- so a walker
 *     who was on the ground when their hexagon was evicted is still on the
 *     ground when it comes back, and a room does not notice either.
 *   - `index`, `tileOf` and `spawn` are data.
 *   - `segments` is host-wide **on purpose**, and it has to be: the rooms share
 *     one `CollisionWorld` and one pair of lane fields by reference, so there is
 *     one set of resident
 *     hexagons and it is the union of what every room's players need. A
 *     per-room residency would be R caches over one grid, each evicting tiles
 *     another room was standing on. `server/index.ts` gathers the positions from
 *     every room and updates it once per host tick, before any room steps.
 *   - `bikeSpots` is data, computed once in `loadWorld`.
 *
 * The bikes are still **claimed** per room and that has not changed: `BikeField`
 * lives on the `Simulation`, so each room owns its own riders over the same
 * layout. Two rooms therefore have a bike 12 in the same place with different
 * riders, which is exactly right. What moved is only *where the layout is
 * computed* -- once here rather than R times, because the prisms it is tested
 * against are no longer all resident at the moment a room is built. See
 * `ServerWorld.bikeSpots`.
 */
export function roomWorld(shared: ServerWorld): ServerWorld {
  const powerups = new PowerupField();
  for (const src of shared.powerupSource) {
    powerups.adopt(src.tileKey, src.kind, src.worldX, src.worldY, src.worldZ);
  }
  return {
    ...shared,
    powerups,
    // Snapshotted once, exactly as `loadWorld` does it and for its reason: every
    // tile is resident on a server, so the resident set never changes after
    // this and the flat array can be taken as a guarantee rather than as an
    // implementation detail relied on from another package.
    points: [...powerups.resident()],
    // And this room's own index over them. `roomWorld` gives every room its own
    // `PowerupField` so a cafe taken in room 0 is still standing in room 3, and
    // an index shared with another room's field would file this room's slots
    // against that room's array. Same order, same length, different object.
    pointIndex: powerups.residentIndex(),
  };
}

async function readOptional(path: string): Promise<ArrayBuffer | null> {
  try {
    const buf = await readFile(path);
    // `Buffer` is a view into a pooled `ArrayBuffer`, so handing `buf.buffer`
    // to a `DataView` reads whatever else Node put in that pool. The slice is
    // not defensive; without it every decoder in this project reads garbage.
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  } catch {
    return null;
  }
}

/**
 * A `CombatWorld` for one combatant, carrying its own last-known ground.
 *
 * Per combatant rather than one for the process, and `main.ts` makes the same
 * split for the same reason: `groundHeightAt` folds in `collision.roofHeight`,
 * which asks "what am I standing on" and can only be answered relative to how
 * high the asker already is. One shared `lastGround` would let a player walking
 * past a warehouse inherit the height of whoever was standing on its roof.
 *
 * The `NaN` fallback is `main.ts`'s verbatim: an unloaded tile must hold the
 * last height rather than claim zero, because zero is the ENU datum and is
 * thirty to forty metres above most of the city. On the server every tile is
 * loaded, so the only place it fires is over the harbour -- where there is no
 * tile at all and never will be until something renders water.
 */
/**
 * The station boxes as of the collision tiles now resident. `loadWorld` builds
 * them over the boot disc; a region that lands later brings the buildings a
 * mouth has to be planned around, so the field is rebuilt the first time it
 * is asked after the tile count changes. Cheap: twenty-eight stations.
 */
export function boxesOf(world: ServerWorld): StationBoxField | null {
  if (!world.rail) return null;
  const tiles = world.collision.tileCount;
  if (world.stationBoxes === null || world.stationBoxes === undefined || world.stationBoxesTiles !== tiles) {
    world.stationBoxes = buildStationBoxes(world.rail, accessWorldOf(world));
    if (world.railCut) world.railCut.setAccess(world.stationBoxes.plans, (x, z) => world.terrain.height(x, z));
    world.stationBoxesTiles = tiles;
  }
  return world.stationBoxes;
}

/** What `buildStationBoxes` asks the world; `main.ts` builds the same from the same prisms and grids. */
export function accessWorldOf(world: ServerWorld): AccessWorld {
  return accessWorldFrom(world.collision, (x, z) => world.terrain.height(x, z));
}

export function groundFor(world: ServerWorld): CombatWorld {
  let lastGround = 0;
  const platforms = world.platforms ?? null;
  const cut = world.railCut ?? null;
  const vessels = world.vessels ?? null;
  const rails = world.railSolids ?? null;
  return {
    collision: world.collision,
    groundHeight(x: number, z: number, feetY: number): number {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      // The station platforms. This is the *only* place the server learns that a
      // platform is a surface -- see `ServerWorld.platforms` -- and `main.ts`'s
      // `groundHeightAt` folds in the identical call beside the prisms
      // `world/rail-geo.ts` has already given it, so both ends compute the same
      // 1.05 m over the same rail head. Without it, a player who has just got
      // off a train at Central is dragged down through the platform at the
      // correction rate.
      //
      // **It replaces the terrain rather than competing with it**, which is not
      // how the roofs are folded in one line up, and the difference is a cutting.
      // `PlatformField.heightAt` answers at all only when the asker is within a
      // step below and a jump above the surface, so an answer here means "you are
      // standing on this platform" and not "there is a platform somewhere under
      // you". At St Leonards the terrain grid is eleven metres over the platform
      // -- the heightfield does not model the cutting -- and a max would put a
      // passenger who had just stepped off the train up on the paddock.
      const platform = platforms === null ? -Infinity : platforms.heightAt(x, z, feetY);
      // **The roof, and it is two sources on this end because it is two sources
      // on the other one.** `collision.roofHeight` is the pipeline's prisms --
      // buildings, decks, landmark podia -- and `RailSolidField.roofHeight` is
      // the railway's own solids, which this process has no renderer to build
      // and which `main.ts` gets from `world/rail-geo.ts` for free. The two are
      // `Math.max`ed rather than ordered because `roofHeight` already is a max
      // over everything a body could be standing on, and a rail solid is not a
      // different kind of answer -- it is more of the same answer.
      //
      // With no rail bake `railSolids` is null and this is the line that
      // shipped.
      const roof = Math.max(
        world.collision.roofHeight(x, z, feetY),
        rails === null ? -Infinity : rails.roofHeight(x, z, feetY),
      );
      // The boxes, read live: `boxesOf` rebuilds them when a collision tile
      // has landed since, because a mouth is planned around the buildings
      // that are resident and the boot's disc is not the whole city.
      const boxes = boxesOf(world);
      const boxFloor = boxes === null ? -Infinity : boxes.floorAt(x, z, feetY, sampled);
      // A platform under the concourse is under it: the lower of two
      // platforms at North Ryde is 0.9 m below the higher, and the floor is
      // the higher. See `RailStation.concourseY`.
      if (platform > -Infinity) return Math.max(platform, roof, boxFloor);
      // **And the rest of the station.** `main.ts`'s `groundHeightAt` carries
      // the identical clause in the identical position, and this one is not a
      // second opinion: both call `StationBoxField.floorAt` over a field both
      // built from the same bake. Without it the concourse at Town Hall, Museum
      // and every other box in the city was answered by the DEM twenty metres
      // overhead, and a player who walked off the platform was corrected up into
      // the street -- reported as *"moving anywhere on foot underground tps me
      // to surface"*. `cutAt` below cannot cover it: a bore is deliberately not
      // carved, because a tunnel has no surface expression to carve.
      if (boxFloor > -Infinity) return Math.max(boxFloor, roof);
      // **Inside a carved cutting the terrain is not there**, and until this
      // line nothing on either end knew it. `terrain.buildTerrainMesh` drops the
      // sub-quads the corridor crosses and `world/rail-geo.ts` builds a trench
      // in the hole, but `TerrainField.height` still samples the *uncarved* DEM
      // -- so a body over a cutting was held on an invisible sheet across a
      // visible railway. `PlatformField` hid it wherever a platform happened to
      // be under the asker and nowhere else.
      //
      // It is also what made a station in a cutting unenterable. The access
      // stairs `rail-geo.writeStationAccess` cuts into the trench wall are
      // *below* the DEM by construction, so a descending walk was a walk along
      // the top of the hole: reported at Chatswood as a plaza with the doors
      // 23 m away and no way down to them.
      //
      // `cutAt` answers with the rail head, and it is the identical function the
      // carve and the trench both call -- see `rail-cut.ts` on why none of the
      // three owns the answer -- so the floor a body stands on here is the same
      // surface the ballast is drawn on, on both ends of the wire.
      //
      // **And it is where the road rule lives too**, which is why there is no
      // fourth clause here for it. A point under a carriageway is one `cutAt`
      // declines on, so this falls through to the terrain and the body stands on
      // King Street instead of dropping 7.4 m into the Illawarra cutting -- which
      // is what it did, on both ends, until `RailCut.setRoads`. Folding the road
      // in at the corridor rather than beside it is the whole design: a second
      // clause here would be a second rule for the client to fail to copy.
      // **And the vessel, which is the same clause said exactly.** `cutAt` below
      // answers with the rail head wherever a strip's *disc* of half-width
      // covers the point; this answers with the surface of an actual solid,
      // whose footprint is the rim the terrain was triangulated to. Asked first
      // because where both answer the vessel is the one the ground was withheld
      // for, and asked in the same position as `cutAt` -- replacing the terrain,
      // not competing with it -- for the reason the paragraph below gives.
      //
      // Off unless `SYDNEY_VESSELS=1`, so with the flag down this line is a null
      // check and the world is byte for byte the one that shipped.
      if (vessels !== null) {
        const deck = vessels.heightAt(x, z, feetY);
        if (deck > -Infinity) return Math.max(deck, roof);
      }
      const floor = cut === null ? Number.NaN : cut.groundCutAt(x, z, sampled);
      if (Number.isFinite(floor)) return Math.max(floor, roof);
      return Math.max(lastGround, roof);
    },
    // Shared rather than per combatant, unlike the ground above it: this one
    // carries no state at all, because where the water is does not depend on who
    // is asking. The client's `main.ts` passes the identical closure over the
    // identical table, which is what makes a predicted wade and an authoritative
    // one the same trajectory.
    waterSurface(x: number, z: number): number {
      return world.water.surfaceAt(x, z);
    },
  };
}

/** The eye height at a spawn point, which is what `PlayerState.position` carries. */
export function eyeAt(world: CombatWorld, x: number, z: number): number {
  // `Infinity` for the feet, exactly as `main.ts` does when it places the local
  // player: a spawn is a tile centre and a tile centre lands inside a footprint
  // often enough to matter, and standing on the building has always been a
  // better answer there than starting inside it.
  return world.groundHeight(x, z, Infinity) + EYE_HEIGHT;
}
