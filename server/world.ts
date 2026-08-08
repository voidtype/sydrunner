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
import { TerrainField, decodeTerrain } from '../client/src/world/terrain.ts';
import { decodePowerups } from '../client/src/world/powerups.ts';
import { PowerupField, type PowerupPoint } from '../client/src/game/powerups.ts';
import { EYE_HEIGHT, PLAYER_RADIUS } from '../client/src/player/controller.ts';
import { WaterLevels } from '../client/src/world/wading.ts';
import { TrafficField, decodeLanes } from '../client/src/game/traffic.ts';
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

/** `SYDNEY_COLLISION_CAP_MB`'s default, megabytes of estimated resident prisms. */
export const DEFAULT_COLLISION_CAP_MB = 450;

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
 * How long one tick may spend decoding collision.
 *
 * `addTile` costs about 0.17 ms for an average tile, so a 374-tile hexagon is
 * 63 ms of decode -- four tick budgets, applied in one go, which is the stall
 * this budget exists to refuse. Two milliseconds a tick spreads the fattest
 * hexagon over about half a second and costs 12% of one core while a load is
 * running and nothing at all when none is.
 */
const APPLY_BUDGET_MS = 2;

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

/** Is any of these flat `x, z` pairs inside the margin of this hexagon? */
function reaches(entry: HexEntry, points: readonly number[]): boolean {
  for (let i = 0; i + 1 < points.length; i += 2) {
    if (hexDistance(entry, points[i], points[i + 1]) <= COLLISION_NEED_MARGIN_M) return true;
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

interface HexSlot {
  entry: HexEntry;
  state: HexState;
  /** The manifest's tiles, read once and kept across evictions. ~9 kB a hexagon. */
  tiles: HexTiles | null;
  /** Payloads read and waiting for a decode budget. */
  pending: PendingTile[];
  /** Every tile key currently in the `CollisionWorld`, so an eviction is exact. */
  applied: string[];
  /**
   * Keys this hexagon has given up but not yet taken out of the grid.
   *
   * **Eviction is as expensive as loading and this is what stops it landing in
   * one tick.** `CollisionWorld.removeTile` walks every prism in the tile and
   * splices it out of one to four broadphase cells, so dropping the fattest
   * hexagon in the build -- 374 tiles, 100,480 prisms -- was measured at
   * **21.6 ms**, which is a stall by `/stats`' own definition and was the first
   * thing `checkServerSegments` caught. So a drop is a *promise* to remove, paid
   * off by `drain` under the same millisecond budget the decode runs on.
   */
  releasing: string[];
  /** Bumped to abandon an in-flight load. See `drop`. */
  generation: number;
  /** Has the reader finished queueing this hexagon's payloads? */
  read: boolean;
  /** Estimated resident bytes, and the file bytes behind them. */
  bytes: number;
  fileBytes: number;
  prisms: number;
  /** The update counter at which this hexagon was last needed. The LRU key. */
  usedAt: number;
}

/** What `/stats` and the checks read off the residency. */
export interface SegmentStats {
  /** False on a world with no hex contract, where everything is resident. */
  enabled: boolean;
  hexes: number;
  resident: number;
  loading: number;
  needed: number;
  /** Estimated resident bytes, and the cap they are held under. */
  bytes: number;
  capBytes: number;
  tiles: number;
  prisms: number;
  loads: number;
  evictions: number;
  /** Updates that ended over cap because every resident hexagon was needed. */
  overCap: number;
  /** Tile payloads still queued for a decode budget. */
  pending: number;
}

/**
 * Which hexagons' prisms this process is holding, and why.
 *
 * ---------------------------------------------------------------------------
 * WHY COLLISION AND NOT THE LANE GRAPH, WHICH IS THE OTHER THIRD.
 *
 * Measured on the same 19.3 km world, one process per subsystem: the lane
 * sidecars cost **53 MB of live heap as `TrafficField` and another 57 MB as
 * `PedestrianField`** -- 111 MB of the 310 MB whole-world load, against
 * collision's 193 MB. At EXPANSION.md's 7-8x it is 780-890 MB on its own, so
 * "routes are small" is not an argument that survives contact with the numbers,
 * and this is not a subsystem that fits at 60 km.
 *
 * It is nonetheless **deliberately left whole in this pass**, because the same
 * machinery is not cheap here and the reason is measurable rather than
 * aesthetic. `TrafficField.adopt`/`drop` and `PedestrianField.adopt`/`drop`
 * exist and are exactly the seam this would use -- but both set a dirty flag,
 * and the next `near()` rebuilds the flat array and the whole broadphase grid
 * over *every* resident tile. Timed at full residency on this world:
 *
 *   | resident tiles | traffic rebuild | pedestrian rebuild | total |
 *   |---------------:|----------------:|-------------------:|------:|
 *   | 3,017          |         3.44 ms |           11.16 ms | **14.6 ms** |
 *   | 1,509          |         2.71 ms |            7.04 ms |  9.8 ms |
 *   |   754          |         0.85 ms |            2.86 ms |  3.7 ms |
 *   |   302          |         0.34 ms |            1.00 ms |  1.3 ms |
 *
 * That lands **inside the tick**, on the first query after any load or eviction:
 * 14.6 ms is 88% of a 60 Hz budget, and even at the reduced residency a lazy
 * loader would run at, every hexagon crossing would cost a 4 ms spike. The fix
 * is an incremental rebuild inside those two classes -- they would have to
 * splice one tile's bands out of `flat` and the grid instead of discarding both
 * -- and those two classes are `client/src/game/`, shared with the browser,
 * where the same change has to be right for a renderer as well as for this. It
 * is a round of its own with its own proof, and it is the next one.
 *
 * Nothing here is wasted on it when it comes: the needed set, the LRU, the cap
 * and the budgeted applier are all keyed on hexagons rather than on prisms, and
 * a lane loader is another `apply` and another `drop` on the same slots.
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
  private readonly collision: CollisionWorld;

  /** Monotonic, bumped per needed-set recomputation. The LRU clock. */
  private clock = 0;
  private ticks = 0;
  private bytes = 0;
  private fileBytes = 0;
  private needed = new Set<string>();
  private inFlight = 0;
  private loads = 0;
  private evictions = 0;
  private overCap = 0;
  private warnedAt = 0;
  /** Slots with payloads waiting on a decode budget, in the order they started. */
  private readonly applying = new Set<HexSlot>();
  /** Slots with tiles still to be taken out of the grid. See `HexSlot.releasing`. */
  private readonly releasing = new Set<HexSlot>();
  /** Points that count as occupied whether or not anybody is there. See `pin`. */
  private anchors: readonly number[] = [];
  /**
   * Where everybody was on the **last** update, copied rather than referenced.
   *
   * The needed set is recomputed at 4 Hz and `trim` runs at 60, so for up to
   * 250 ms the set can be out of date -- and there is exactly one way to be
   * inside a hexagon that the set does not know about, which is to arrive
   * without crossing the 500 m margin first. That is `/tp <suburb>`. Without
   * this the teleport lands in a hexagon that is resident, unneeded and possibly
   * the LRU victim, and the player has the prisms taken out from under them by
   * the very next tick.
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

  constructor(root: string, rootIndex: HexIndex | null, collision: CollisionWorld, capBytes: number) {
    this.root = root;
    this.rootIndex = rootIndex;
    this.collision = collision;
    this.capBytes = capBytes;
    if (!hexesUsable(rootIndex)) return;
    this.arm();
    for (const entry of this.contract!.list) {
      this.slots.set(entry.id, {
        entry,
        state: 'absent',
        tiles: null,
        pending: [],
        applied: [],
        releasing: [],
        generation: 0,
        read: false,
        bytes: 0,
        fileBytes: 0,
        prisms: 0,
        usedAt: 0,
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

  /**
   * Points that are needed whether or not anybody is standing on them.
   *
   * There is exactly one, and it is the spawn. Every join is placed by
   * `Sim.joinSpot`, which probes the prisms to keep somebody out of a warehouse,
   * and a join is not a thing that can wait half a second for a hexagon: the
   * player is already in the room by the time the collision would land. So the
   * spawn's hexagon is held for the life of the process -- one hexagon, 26 MB on
   * this build -- rather than being evicted by an empty server and re-fetched
   * underneath the first person to arrive.
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
   * The hexagons a set of participants needs, by the margin rule.
   *
   * `points` is flat `x, z` pairs -- every connected player and every bot across
   * every room on this host, because the collision is shared by reference and a
   * hexagon room 3 needs is a hexagon room 5 is holding too. See `roomWorld`.
   */
  neededFor(points: readonly number[], out = new Set<string>()): Set<string> {
    out.clear();
    if (this.contract === null) return out;
    this.arm();
    for (const slot of this.slots.values()) {
      if (
        reaches(slot.entry, points) ||
        (this.anchors.length > 0 && reaches(slot.entry, this.anchors))
      ) {
        out.add(slot.entry.id);
      }
    }
    return out;
  }

  /** Is this hexagon's collision fully resident right now? */
  isResident(id: string): boolean {
    return this.slots.get(id)?.state === 'resident';
  }

  /** Is it wanted by somebody, as of the last needed-set recomputation? */
  isNeeded(id: string): boolean {
    return this.needed.has(id);
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
   * One tick of the residency: notice, start, decode, trim.
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
      this.neededFor(points, this.needed);
      for (const id of this.needed) {
        const slot = this.slots.get(id)!;
        slot.usedAt = this.clock;
        if (slot.state === 'absent') this.start(slot);
      }
    }
    this.drain(APPLY_BUDGET_MS);
    // After the decode rather than before it, and every tick rather than every
    // fifteenth. The bytes only ever *arrive* in `drain`, so trimming ahead of it
    // measures the residency one budget out of date and leaves the process over
    // cap for the rest of the interval. Under cap this is one comparison.
    this.trim();
  }

  /**
   * Decode what has been read, for at most `budgetMs`.
   *
   * Oldest load first, so a hexagon somebody is walking into finishes rather
   * than sharing the budget with one they are walking out of. The deadline is
   * checked between tiles rather than inside `addTile`, so the overshoot is one
   * tile: 0.17 ms for an average one, and the worst whole call measured over a
   * three-hexagon walk is 4.4 ms against the 2 ms budget.
   */
  private drain(budgetMs: number): void {
    const deadline = performance.now() + budgetMs;
    // Give memory back before taking more, and before the deadline is spent on
    // decoding. A hexagon arriving can afford the eight ticks this costs -- the
    // margin is 12.7 s -- and the process being over cap for those eight ticks
    // is the thing the cap exists to stop.
    if (this.releasing.size > 0) {
      for (const slot of this.releasing) {
        while (slot.releasing.length > 0) {
          if (performance.now() >= deadline) return;
          this.collision.removeTile(slot.releasing.pop()!);
        }
        this.releasing.delete(slot);
      }
    }
    if (this.applying.size === 0) return;
    for (const slot of this.applying) {
      const tiles = slot.tiles;
      if (tiles === null) continue;
      while (slot.pending.length > 0) {
        if (performance.now() >= deadline) return;
        const next = slot.pending.pop()!;
        const at = next.at;
        const key = tiles.keys[at];
        const added = this.collision.addTile(
          key,
          next.buffer,
          tiles.originX[at],
          tiles.originZ[at],
          tiles.buildings[at],
        );
        slot.applied.push(key);
        slot.prisms += added;
        const bytes = estimateCollisionBytes(added, verticesInPayload(next.buffer.byteLength, added));
        slot.bytes += bytes;
        slot.fileBytes += next.buffer.byteLength;
        this.bytes += bytes;
        this.fileBytes += next.buffer.byteLength;
      }
      if (slot.read) {
        slot.state = 'resident';
        this.applying.delete(slot);
      }
    }
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
   * Start reading a hexagon. Never awaited by the tick.
   *
   * A read that fails is a hexagon that goes back to `absent` and is started
   * again the next time it is needed, on `hexes.ensureHex`'s argument: a hexagon
   * that gives up after one flaky read is a part of the map the player can never
   * reach, which is worse than one that retries. On local disk the failure that
   * actually happens is a tile the pipeline did not emit, and `readOptional`
   * already treats that as an empty tile rather than an error.
   */
  private start(slot: HexSlot): void {
    if (slot.state !== 'absent' || this.inFlight >= LOAD_CONCURRENCY) return;
    // Not while its own prisms are still coming out of the grid: `read` skips a
    // tile the world already holds, so a hexagon restarted mid-release would
    // skip exactly the tiles the release is about to delete and come back
    // missing them. A few ticks of waiting against 12.7 s of margin.
    if (slot.releasing.length > 0) return;
    slot.state = 'loading';
    slot.read = false;
    slot.generation++;
    const generation = slot.generation;
    this.inFlight++;
    this.loads++;
    this.applying.add(slot);
    void this.read(slot, generation).finally(() => {
      this.inFlight--;
      if (slot.generation === generation) slot.read = true;
    });
  }

  private async read(slot: HexSlot, generation: number): Promise<void> {
    if (slot.tiles === null) {
      const tiles = await this.readTiles(slot.entry);
      if (slot.generation !== generation) return;
      if (tiles === null) {
        slot.state = 'absent';
        this.applying.delete(slot);
        return;
      }
      slot.tiles = tiles;
    }
    const keys = slot.tiles.keys;
    for (let i = 0; i < keys.length; i += READ_CONCURRENCY) {
      const batch: Array<Promise<ArrayBuffer | null>> = [];
      for (let j = i; j < Math.min(i + READ_CONCURRENCY, keys.length); j++) {
        batch.push(readOptional(join(this.root, 'collision', `${keys[j]}.bin`)));
      }
      const buffers = await Promise.all(batch);
      if (slot.generation !== generation) return;
      for (let j = 0; j < buffers.length; j++) {
        const buffer = buffers[j];
        // A tile already in the world is a tile another hexagon claimed -- which
        // `checkHexCoverage` says cannot happen, and which `addTile` would
        // silently no-op on anyway, leaving this class thinking it owned prisms
        // it did not. Skipped explicitly so the accounting stays true.
        if (buffer === null || this.collision.hasTile(keys[i + j])) continue;
        slot.pending.push({ at: i + j, buffer });
      }
    }
  }

  /** Read and decode one hexagon to completion. The boot path, and only that. */
  async loadNow(id: string): Promise<void> {
    const slot = this.slots.get(id);
    if (slot === undefined || slot.state === 'resident') return;
    // Any of its own tiles still queued for removal come out **first**, for
    // `start`'s reason: `read` skips a tile the world already holds, so a
    // hexagon reloaded over its own pending release would come back missing
    // exactly those tiles. Synchronous here because this is boot and there is no
    // tick to protect.
    if (slot.releasing.length > 0) this.drain(Infinity);
    if (slot.state === 'absent') {
      slot.state = 'loading';
      slot.read = false;
      slot.generation++;
      // Stamped, so the boot walk's own evictions are least-recently-loaded
      // first rather than whatever order the slot map happens to be in.
      slot.usedAt = ++this.clock;
      this.loads++;
      this.applying.add(slot);
      await this.read(slot, slot.generation);
      slot.read = true;
    }
    this.drain(Infinity);
  }

  /** Wait for every load in flight to land. The boot path's `ensureHexesNear`. */
  async settle(): Promise<void> {
    // Ten seconds of local-disk reads is a disk that is not going to answer;
    // giving up leaves the hexagon absent and re-startable rather than holding
    // the boot open, which is `ensureHexesNear`'s own call.
    const until = performance.now() + 10_000;
    while ((this.applying.size > 0 || this.releasing.size > 0) && performance.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      this.drain(Infinity);
    }
  }

  /**
   * Drop hexagons, least-recently-needed first, until under cap.
   *
   * The needed set is a hard floor and the loop gives up rather than crossing
   * it. See the class header: over cap is a log line, and the alternative is a
   * player standing in a hexagon whose prisms have just been taken away.
   */
  private trim(): void {
    while (this.bytes > this.capBytes) {
      // The distance tests below read `world/hexes.ts`'s module contract, and
      // this is a path `update` can reach without having gone through
      // `neededFor` on this tick. See `arm`.
      this.arm();
      let victim: HexSlot | null = null;
      for (const slot of this.slots.values()) {
        if (slot.state === 'absent') continue;
        if (this.needed.has(slot.entry.id)) continue;
        // The exact test, for the one hexagon this is about to give up. See
        // `lastPoints`: a teleport is inside a hexagon the 4 Hz needed set has
        // not heard about yet.
        if (reaches(slot.entry, this.lastPoints) || reaches(slot.entry, this.anchors)) continue;
        if (victim === null || slot.usedAt < victim.usedAt) victim = slot;
      }
      if (victim === null) {
        this.overCap++;
        const now = performance.now();
        if (now - this.warnedAt > WARN_INTERVAL_MS) {
          this.warnedAt = now;
          let held = 0;
          for (const other of this.slots.values()) if (other.state !== 'absent') held++;
          console.warn(
            `[sydney] collision over cap: ${(this.bytes / 1e6).toFixed(1)} MB resident against a ` +
              `${(this.capBytes / 1e6).toFixed(0)} MB cap, and all ${held} resident hexagon(s) are ` +
              'needed. Holding them anyway — a player standing in one would fall through the ' +
              'world. Raise SYDNEY_COLLISION_CAP_MB, or accept that this many players this far ' +
              'apart costs this much.',
          );
        }
        return;
      }
      this.drop(victim);
      this.evictions++;
    }
  }

  /** Give a hexagon's prisms back. Idempotent; keeps the manifest. */
  private drop(slot: HexSlot): void {
    slot.generation++;
    slot.pending.length = 0;
    this.applying.delete(slot);
    // The bytes come off the books now and the prisms come out of the grid over
    // the next few ticks. The accounting therefore runs a little ahead of the
    // heap, which is the safe direction: `trim` believes it has already
    // recovered the memory and so evicts *less*, where the other order would
    // cascade -- every tick finding itself still over cap and giving up another
    // hexagon that the previous tick's release was about to pay for.
    for (const key of slot.applied) slot.releasing.push(key);
    if (slot.releasing.length > 0) this.releasing.add(slot);
    slot.applied.length = 0;
    this.bytes -= slot.bytes;
    this.fileBytes -= slot.fileBytes;
    slot.bytes = 0;
    slot.fileBytes = 0;
    slot.prisms = 0;
    slot.state = 'absent';
    slot.read = false;
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

  /** Evict everything. For the checks, which build a world and then take it apart. */
  dropAll(): void {
    for (const slot of this.slots.values()) if (slot.state !== 'absent') this.drop(slot);
    this.drain(Infinity);
  }

  /** Resident file bytes, so the boot line can still say how much collision is held. */
  get residentFileBytes(): number {
    return this.fileBytes;
  }

  stats(): SegmentStats {
    let resident = 0;
    let loading = 0;
    let tiles = 0;
    let prisms = 0;
    let pending = 0;
    for (const slot of this.slots.values()) {
      if (slot.state === 'resident') resident++;
      if (slot.state === 'loading') loading++;
      tiles += slot.applied.length;
      prisms += slot.prisms;
      pending += slot.pending.length + slot.releasing.length;
    }
    return {
      enabled: this.contract !== null,
      hexes: this.slots.size,
      resident,
      loading,
      needed: this.needed.size,
      bytes: this.bytes,
      capBytes: this.capBytes,
      tiles,
      prisms,
      loads: this.loads,
      evictions: this.evictions,
      overCap: this.overCap,
      pending,
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
  /** Tile keys that had a powerup sidecar, so a pickup can name its tile. */
  tileOf: Map<string, { tileX: number; tileZ: number }>;
  /**
   * Every lane graph in the extent, and therefore every moving car.
   *
   * Adopted whole at boot like everything else here: the routes for the inner
   * ring are 1.4 MB, which is half a tile's GLB, and a server that streamed them
   * would be a cache with an `await` in a 60 Hz tick to avoid holding a
   * megabyte. Nothing about a car is ever sent to a client -- both ends evaluate
   * the same baked timetable at the same wall-clock tick. See `game/traffic.ts`.
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
  bytes: { collision: number; terrain: number; powerups: number; lanes: number };
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
 * Everything but the collision is still read whole, and the header has the
 * measurement that says which of those is worth streaming next. Collision is
 * read per hexagon: this function ends with the hexagons around the spawn
 * resident and everything else on demand, which is `hexes.ensureHexesNear`'s
 * boot contract on the other side of the wire.
 */
export async function loadWorld(root: string, capBytes = collisionCapBytes()): Promise<ServerWorld> {
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
  const segments = new HexResidency(root, rootIndex, collision, capBytes);
  const terrain = new TerrainField(index.terrain.grid, index.tile_size, root);
  const powerups = new PowerupField();
  const tileOf = new Map<string, { tileX: number; tileZ: number }>();
  const points: PowerupPoint[] = [];
  const traffic = new TrafficField();
  const peds = new PedestrianField();
  const bytes = { collision: 0, terrain: 0, powerups: 0, lanes: 0 };
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
      const lanes = await readOptional(join(root, 'tiles', `${entry.key}.lanes.bin`));
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
    points,
    tileOf,
    bytes,
    powerupSource,
    spawn: spawnCentre(index),
    places,
    segments: segments.enabled ? segments : undefined,
  };

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
  if (segments.enabled) {
    const placed: PlacedBike[] = [];
    const seen = new Set<string>();
    // Planned once, filtered per hexagon: `bikePlan` hashes every tile in the
    // index, and re-running it per hexagon is 2.6 million hashes at 60 km to
    // produce the same list 121 times.
    const plans = bikePlan(index.tiles);
    for (const entry of segments.entries) {
      await segments.loadNow(entry.id);
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
    segments.pin([world.spawn.x, world.spawn.z]);
    segments.update([]);
    await segments.settle();
    segments.trimToCap();
    bytes.collision = segments.residentFileBytes;
  } else {
    world.bikeSpots = layOutBikes(world);
  }

  return world;
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
 *     correct: the traffic is the city, not the match.
 *   - `PedestrianField` is bands derived from the lane graph; the crowd's poses
 *     are computed into caller-owned scratch (`Simulation` holds its own).
 *   - `index`, `tileOf` and `spawn` are data.
 *   - `segments` is host-wide **on purpose**, and it has to be: the rooms share
 *     one `CollisionWorld` by reference, so there is one set of resident
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
export function groundFor(world: ServerWorld): CombatWorld {
  let lastGround = 0;
  return {
    collision: world.collision,
    groundHeight(x: number, z: number, feetY: number): number {
      const sampled = world.terrain.height(x, z);
      if (Number.isFinite(sampled)) lastGround = sampled;
      return Math.max(lastGround, world.collision.roofHeight(x, z, feetY));
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
