/**
 * The whole city, in the two thousand words it is made of: every named street
 * centreline in the build, the harbour, and the ninety-four suburb nodes --
 * fetched once, the first time somebody presses `M`.
 *
 * `bigmap.ts` draws this. This file is only the acquisition and the index, and
 * it is a separate file because the two have completely different lifetimes: the
 * drawing happens while a panel is open and must cost nothing when it is not,
 * and this happens exactly once per session and then never again.
 *
 * ---------------------------------------------------------------------------
 * Why a session-wide index here, when `world/streetnames.ts` argues against one.
 *
 * That file is emphatic that the decoded centrelines go with the tile, and it is
 * right for the job it was written for: `game/locator.ts` asks "what street am I
 * standing on", the answer is never more than forty metres away, and forty metres
 * is inside the resident set by a factor of thirty. A name index that outlived
 * its tile would hold kilobytes per tile for the rest of the session to answer
 * questions nobody asks.
 *
 * A city map asks a different question and it asks it about *everywhere at once*.
 * The player wants to know where Newtown is from Circular Quay, and the tiles
 * around Newtown are not resident and must not be -- they are 1.5 MB of GLB
 * apiece and the streamer evicts them precisely so the session does not hold the
 * city in memory. What this holds instead is the part of the city that is a map:
 *
 *   * **18,788 runs, 47,666 points** -- 381 kB of `Float32Array` for the entire
 *     street network of the inner ring, because the sidecar is decimated to 2.5
 *     points a run. That is a fifth of *one* tile's GLB.
 *   * **475 kB in one request**: `world/street-names.bin`, the whole build's
 *     centrelines repacked into a single file by
 *     `pipeline/sydney/tiles.py::write_street_name_bundle`. The URL carries the
 *     build stamp, so the second visit is served from the disk cache without a
 *     round trip. See `world/version.ts`, and `loadNameBundle` below for what
 *     this replaced and why the thing it replaced is still here.
 *   * **2,870 distinct names**, which is what the labels are drawn from and what
 *     makes ranking them possible at all -- see `importanceOf`.
 *
 * The rule this file follows instead of "with the tile" is **once, and only when
 * asked**: nothing here is fetched at boot. A player who never opens the map
 * pays nothing, and a player who opens it once pays 578 kB in three requests and
 * then nothing for the rest of the session, however many times they open it
 * again.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER ABOVE IS FROM THE 19.3 KM WORLD, and the world is 60 km.
 *
 * They are left as written because they are the *design*, and because the gap
 * between them and what the build now holds is the whole story of this file's
 * last pass. What the same three sentences describe today:
 *
 *   * the whole-world bundle is **7.37 MB**, not 475 kB -- and is not fetched at
 *     all on a segmented world, whose names arrive per hexagon (`ensureHexNames`);
 *   * the fallback behind it is **14,815 sidecars**, not 357, which is why it is
 *     now capped (`MAX_FALLBACK_TILES`);
 *   * the street network is **234,094 runs and 742,230 points**, not 18,788 and
 *     47,666, which is why the queries go through a grid (`CELL_M`) and the
 *     chaining is incremental (`ensureLabelLines`);
 *   * the harbour is **282,567 triangles**, not 3,564 -- and building a path out
 *     of it with a `closePath` per triangle is the 150 seconds that froze a
 *     player's laptop on the first press of `M` (`buildWaterPlan`).
 *
 * The pattern is one thing four times: an operation that is linear-and-small at
 * 19.3 km, written down as a measurement, and never asked again. Anything added
 * here should be indifferent to the next doubling by construction, and
 * `server/integration-check.ts` holds the four above to that against the world
 * that actually ships.
 *
 * ---------------------------------------------------------------------------
 * The street network is also the *geometry*, which is why there is no second
 * source for the roads.
 *
 * `minimap.ts` draws a figure-ground plan and its header explains at length that
 * this client has no street network to draw -- streets exist in the build as a
 * triangulated ribbon in three material slots with no centreline in them. That
 * was true when it was written and it is still true of the *tiles*. It is not
 * true of this sidecar, which is centrelines and nothing else: the pipeline ships
 * them so the client can name a street, and a polyline you can measure a distance
 * to is a polyline you can stroke.
 *
 * So the big map draws real roads where the small one draws their absence, and
 * the two are not in conflict -- the minimap's void-between-the-buildings reads
 * at 160 m with the tiles resident, and this reads at nine kilometres with
 * nothing resident at all. Neither could do the other's job.
 *
 * ---------------------------------------------------------------------------
 * Progressive, and never awaited.
 *
 * `start` returns immediately and everything lands whenever it lands. The map
 * opens on the first press with the suburbs, the harbour and whatever has
 * arrived, and fills in underneath itself; `revision` is the counter a drawing
 * layer watches to know something changed. The alternative -- holding the panel
 * closed until the streets finish -- would put a spinner in front of a feature
 * whose whole value is that it is instant. That was worth a great deal more when
 * the streets were 357 requests than it is now they are one, and it is kept
 * because the fallback path is still 357 requests and because the panel opening
 * instantly is the behaviour, not an accident of how slow the load was.
 *
 * The order is deliberate and is by *value per byte*: the suburbs first (4.7 kB
 * and the single most useful thing on the map), then the harbour (98 kB, and the
 * one region whose absence would be actively misleading -- see `minimap.ts` on
 * water), then the streets (475 kB, and the largest single payload).
 */

import { decodeStreetNames, translateStreetNames } from './world/streetnames.ts';
import { fetchWorldAsset } from './world/cdn.ts';
// The world's segments. On a segmented world the map's street names arrive per
// hexagon and per view box rather than as one whole-world bundle -- see
// `ensureHexNames`.
import { hexContract, hexesArmed, hexesInBox } from './world/hexes.ts';
import { decodeWater } from './world/water.ts';
import { abbreviateStreet } from './game/locator.ts';

/**
 * The `index.json` fields this reads.
 *
 * Structural rather than an import of `WorldIndex`, on `world/version.ts`'s own
 * argument for the same thing: what this needs from the index is four fields,
 * and stating them is both the documentation and the contract. It also keeps
 * this file out of the streamer's dependency graph entirely, which is what lets
 * `verifyMapAtlas` build one out of a literal.
 */
export interface MapIndexTile {
  key: string;
  /** [minX, minZ, maxX, maxZ] in world metres. */
  bounds: [number, number, number, number];
  /** Named centreline runs in this tile's `.names.bin`. Absent or 0 means none. */
  sn?: number;
}

/**
 * The `street_names` block: one file holding every tile's centrelines.
 *
 * Absent on a world built before the bundle existed, which is the entire
 * fallback condition -- see `loadNames`. `path` is world-relative, like every
 * other asset name the client builds a URL out of, and the counts are here for
 * `stats()` and for the build report rather than for the decode, which reads
 * its own header. See `pipeline/sydney/tiles.py::write_street_name_bundle`.
 */
export interface MapNameBundle {
  path?: string;
  format?: number;
  runs?: number;
  names?: number;
  tiles?: number;
  points?: number;
  bytes?: number;
}

export interface MapIndex {
  tile_size: number;
  tiles: MapIndexTile[];
  /** The hero set's anchors. Absent on a world built before the landmark pass. */
  landmarks?: { items?: ReadonlyArray<{ name: string; anchor_world?: number[] }> };
  /** Present with a `far` block when there is a `far-water.bin` to fetch. */
  water?: { far?: unknown };
  /** The one-request street-name bundle. Absent on an older world. */
  street_names?: MapNameBundle;
}

/** One continuous run of one named street, in world metres. */
export interface RoadRun {
  /** Index into the atlas's name table. See `nameOf` and `importanceOf`. */
  readonly nameId: number;
  /** `[x0, z0, x1, z1, ...]`, at least two points. The decoder's own array. */
  readonly points: Float32Array;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  /** This run's own length, metres. Labels are anchored on the longest. */
  readonly length: number;
}

/**
 * Somewhere one street name can be lettered, and how much room there is.
 *
 * The product of the chaining pass below -- see `buildLabelLines` for why the
 * runs cannot be lettered as they arrive.
 */
export interface LabelLine {
  readonly nameId: number;
  /** Midpoint of the straight stretch, world metres. Where the text is centred. */
  readonly x: number;
  readonly z: number;
  /** The stretch's bearing, radians, `atan2(dz, dx)`. Which way the text lies. */
  readonly angle: number;
  /** The stretch's length, metres. What the text has to fit inside. */
  readonly straight: number;
  /** The whole chain's length, metres. Reported; the map ranks on importance. */
  readonly length: number;
}

/** One suburb label node, world metres, as it arrives in `world/suburbs.json`. */
export interface SuburbNode {
  name: string;
  x: number;
  z: number;
}

/** One hero landmark, reduced to a point and a display name. */
export interface MapLandmark {
  name: string;
  x: number;
  z: number;
}

/**
 * How many tile sidecars are in flight at once, **on the fallback path only**.
 *
 * Nothing reaches this on a world with a `street_names` block, which is every
 * world this pipeline builds -- see `loadNameBundle`. It is what an older world
 * still loads by, and the number is unchanged because the argument for it is:
 *
 * Ten rather than all 357, and rather than one at a time. All at once hands the
 * browser three hundred entries to schedule against the *same* connection the
 * streamer is pulling 1.5 MB tiles down -- the map would arrive faster and the
 * city under the player would stall, which is the wrong trade for a panel that
 * is already usable. One at a time is 357 sequential round trips, which on a
 * 40 ms link is fourteen seconds.
 *
 * Ten keeps the pipe busy, finishes in about a second on a normal connection,
 * and leaves the streamer's own requests interleaved rather than queued behind
 * a wall of three hundred.
 */
const CONCURRENCY = 10;

/**
 * The hero landmarks' display names, keyed by the pipeline's identifiers.
 *
 * A table rather than a title-case of the key, because "Sydney Tower" is not
 * what a title-case of `sydney_tower` gives you on the two that matter: the
 * Harbour Bridge is *the* Harbour Bridge and the Opera House is not the "Opera
 * House" of anywhere. A key with no entry falls back to the underscore-stripped
 * form, so a fourth landmark appearing in the build is on the map the day it
 * ships rather than the day this table is updated.
 */
const LANDMARK_NAMES: Record<string, string> = {
  harbour_bridge: 'Harbour Bridge',
  opera_house: 'Opera House',
  sydney_tower: 'Sydney Tower',
};

/**
 * How near two runs' endpoints must be to count as the same point, metres.
 *
 * The joins this has to find are of two kinds and they have different error.
 * Inside a tile, two ways of the same street share an OSM node exactly and the
 * endpoints are bit-identical. Across a tile boundary the pipeline *clips* the
 * way twice, once into each tile, and the two clipped ends are the same
 * coordinate computed in two different tile-local frames and then lifted back --
 * so they agree to float32's precision at a few thousand metres, which is
 * centimetres rather than exactly.
 *
 * Half a metre clears that by an order of magnitude and is far under the
 * distance between two genuinely different junctions, which is a carriageway
 * width at worst.
 */
const JOIN_EPS = 0.5;

/**
 * How much a street may bend and still be one straight stretch to letter along,
 * radians. Eight degrees.
 *
 * The number is set by what the *text* can tolerate rather than by what the
 * street is doing: a label lettered as one straight line along a run that bends
 * by eight degrees over its length sits within half a character height of the
 * centreline at both ends, which reads as "on the street". At fifteen degrees it
 * visibly leaves the road at the ends, and curved-text rendering -- laying each
 * glyph on its own tangent -- is a different feature and a much larger one.
 */
const STRAIGHT_TOL = (8 * Math.PI) / 180;

/**
 * How many tile sidecars the fallback path will ever ask for.
 *
 * The fallback fetches one `.names.bin` per tile with a street on it, and the
 * comment on `CONCURRENCY` above is written against the 357 tiles that was when
 * the bundle shipped. **It is 14,815 tiles at 60 km**, and the condition that
 * reaches it is one failed fetch of `street-names.bin` -- a CDN blip on a world
 * that has the block. Fifteen thousand requests on a key press is not a slow
 * map, it is a browser that stops answering and a radio that never sleeps.
 *
 * So the fan-out is capped at the number the path was designed for, rounded up,
 * and the tiles kept are the ones nearest the world origin. That is a
 * deliberately dumb rule and it is the right one here: this path only runs on a
 * world with no bundle (which is a world from before the 19.3 km build, where
 * 400 tiles *is* the city) or on a bundled world whose bundle failed (where the
 * honest outcome is a partial map that says so through `stats().failures`,
 * rather than a locked-up tab). `progress` still reports against what was
 * actually asked for, so the shimmer does not lie about a load it has finished.
 */
const MAX_FALLBACK_TILES = 400;

// --- The spatial index --------------------------------------------------------
//
// WHY THERE IS ONE NOW, when `roadsWithin` used to argue at length that there
// must not be. The argument was: at the city zoom the box is the whole build so
// an index rejects nothing, and at the closest zoom the scan is four compares
// apiece for 11,893 runs. Both halves were true of a 19.3 km world and both
// have been overtaken by a 60 km one, where the same scan is 234,094 runs and
// 101,981 label lines -- **4.1 ms and 10.9 ms measured, every redraw**, and the
// map redraws on open, on zoom, on pan and on every hexagon that lands. Fifteen
// milliseconds of a 33 ms budget, spent deciding what not to draw.
//
// The grid below is sized so the next doubling changes nothing: the query cost
// is the number of cells the *view box* covers, which is a property of the zoom
// ladder and not of the world, plus whatever is in them. Measured against the
// whole 60 km city held at once -- 234,094 runs, 101,993 label lines:
//
//     rung             runs walked    drawn   lines walked   lettered
//     neighbourhood          2,313      543            702         91
//     district               9,362    4,875          1,916        803
//     city                  36,040   31,078          8,128      6,232
//     region               119,506  113,312         29,703     27,251
//
// The two close rungs are where the map opens and where it letters, and they
// now walk thousands rather than a third of a million: the district redraw's
// two queries went from **14.96 ms to 0.21 ms**. The wide rungs walk a lot
// because they genuinely draw a lot -- the overdraw there is 1.05x, which is
// the index working rather than failing, and `server/integration-check.ts`
// asserts the ratio rather than the count for exactly that reason.

/**
 * The cell edge of both indexes, metres.
 *
 * 512 rather than the 500 m tile, and not because the arithmetic is faster --
 * because the thing being indexed is a *run*, which is 53 m at the median and
 * 177 m at the ninth decile after decimation. A cell comfortably wider than the
 * items in it is what keeps `reach` (below) at one cell, and `reach` is what
 * the query pays for.
 */
const CELL_M = 512;

/**
 * How many cells an item may span before it is held apart from the grid.
 *
 * A loose grid files each item in the cell of its **minimum corner** and widens
 * every query by the largest span it has ever accepted, which is what lets it
 * skip the deduplication a multi-cell insert would need. The whole scheme rests
 * on that span staying small, and one motorway-long label line -- `straight` is
 * kilometres on the Warringah Freeway -- would widen every query in the map by
 * twenty cells each way and give back exactly the linear scan this replaces.
 *
 * So anything wider than this goes in `oversize`, which *is* scanned linearly.
 * That is not a hole in the bound, it is where the bound is stated: `oversize`
 * is the arterial skeleton, it is a fraction of a percent of the items, and
 * `server/integration-check.ts` asserts its size against the real world so a
 * build that made it the common case fails rather than gets slow.
 */
const MAX_SPAN_CELLS = 2;

/**
 * Cells either side of the origin a key can address: +/- 2,097 km at `CELL_M`.
 *
 * A key is `(cx + BIAS) * STRIDE + (cz + BIAS)`, which stays under 2^26 and
 * therefore stays a small integer in V8 -- a `Map` of small integers is a very
 * different thing from a `Map` of strings, and the string version of this was
 * measurably slower than the scan it replaced. Coordinates outside the range
 * are clamped rather than rejected: two far-flung items sharing the edge cell
 * is a false positive the exact test below rejects, where a wrapped key would
 * be a run drawn in the wrong place.
 */
const CELL_BIAS = 4096;
const CELL_STRIDE = CELL_BIAS * 2;

function cellOf(v: number): number {
  const c = Math.floor(v / CELL_M);
  if (c < -CELL_BIAS) return -CELL_BIAS;
  if (c > CELL_BIAS - 1) return CELL_BIAS - 1;
  return c;
}

/** What an index is holding and what the last query cost. See `indexStats`. */
export interface GridStats {
  items: number;
  cells: number;
  /** Items too wide to file in a cell, scanned on every query. See `MAX_SPAN_CELLS`. */
  oversize: number;
  /** Cells the widest accepted item reaches past the one it is filed in. */
  reach: number;
  /** Items the most recent query walked. The number the whole index exists to bound. */
  lastWalked: number;
}

/**
 * A loose uniform grid: insert by box, query by box, no allocation per query.
 *
 * Deliberately not a quadtree or an R-tree. What this indexes is a city, which
 * is *uniformly* dense at the scale of a street -- there is no empty quadrant to
 * subdivide away and no clustering for a tree to exploit -- and a grid over a
 * uniform field is the structure with the least per-item overhead and no
 * rebalancing. It is also the only one whose worst case can be written down in
 * a sentence, which is what the check asserts against.
 */
class LooseGrid<T> {
  private readonly cells = new Map<number, T[]>();
  private readonly oversize: T[] = [];
  private reach = 0;
  private count = 0;
  private walked = 0;
  /** The occupied extent, so a query wider than the world walks the world. */
  private minCX = Infinity;
  private minCZ = Infinity;
  private maxCX = -Infinity;
  private maxCZ = -Infinity;

  get size(): number {
    return this.count;
  }

  stats(): GridStats {
    return {
      items: this.count,
      cells: this.cells.size,
      oversize: this.oversize.length,
      reach: this.reach,
      lastWalked: this.walked,
    };
  }

  insert(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    this.count++;
    const cx = cellOf(minX);
    const cz = cellOf(minZ);
    const spanX = cellOf(maxX) - cx;
    const spanZ = cellOf(maxZ) - cz;
    const span = spanX > spanZ ? spanX : spanZ;
    if (span > MAX_SPAN_CELLS) {
      this.oversize.push(item);
      return;
    }
    if (span > this.reach) this.reach = span;
    if (cx < this.minCX) this.minCX = cx;
    if (cz < this.minCZ) this.minCZ = cz;
    if (cx > this.maxCX) this.maxCX = cx;
    if (cz > this.maxCZ) this.maxCZ = cz;
    const key = (cx + CELL_BIAS) * CELL_STRIDE + (cz + CELL_BIAS);
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [item]);
    else bucket.push(item);
  }

  /**
   * Take an item back out. Only the label lines need this -- a name whose runs
   * changed is re-chained and its old lines are no longer anywhere -- and it is
   * exact rather than a tombstone because a map that accumulated dead lines
   * would drift back toward the linear scan one hexagon at a time.
   *
   * The box must be the one it went in with, which is why both sides compute it
   * from the item's own geometry rather than caching it.
   */
  remove(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    const cx = cellOf(minX);
    const cz = cellOf(minZ);
    const spanX = cellOf(maxX) - cx;
    const spanZ = cellOf(maxZ) - cz;
    const span = spanX > spanZ ? spanX : spanZ;
    const bucket =
      span > MAX_SPAN_CELLS
        ? this.oversize
        : this.cells.get((cx + CELL_BIAS) * CELL_STRIDE + (cz + CELL_BIAS));
    if (bucket === undefined) return;
    const at = bucket.indexOf(item);
    if (at < 0) return;
    // Swap-remove: order inside a cell is not meaningful to any caller, and the
    // alternative is a splice down a bucket that can hold a whole suburb.
    bucket[at] = bucket[bucket.length - 1];
    bucket.pop();
    this.count--;
  }

  /**
   * Visit everything whose box *might* meet this one. The caller does the exact
   * test; this only promises not to miss anything.
   *
   * Two ways round the cells, and the cheaper one wins. Walking the coordinate
   * range is what makes a view query cost the view rather than the world -- but
   * `verifyBigMap` and the label pass both ask boxes of +/- 1e9, where the
   * coordinate range is 8,192 cells square and the map is 234. So when the box
   * covers more cells than the grid *has*, the occupied cells are iterated
   * directly and the query is bounded by the index rather than by the request.
   */
  query(minX: number, minZ: number, maxX: number, maxZ: number, visit: (item: T) => void): void {
    let walked = this.oversize.length;
    for (let i = 0; i < this.oversize.length; i++) visit(this.oversize[i]);
    if (this.cells.size === 0) {
      this.walked = walked;
      return;
    }
    const x0 = Math.max(cellOf(minX) - this.reach, this.minCX);
    const z0 = Math.max(cellOf(minZ) - this.reach, this.minCZ);
    const x1 = Math.min(cellOf(maxX), this.maxCX);
    const z1 = Math.min(cellOf(maxZ), this.maxCZ);
    if (x1 < x0 || z1 < z0) {
      this.walked = walked;
      return;
    }
    const spanned = (x1 - x0 + 1) * (z1 - z0 + 1);
    if (spanned > this.cells.size) {
      for (const bucket of this.cells.values()) {
        for (let i = 0; i < bucket.length; i++) {
          walked++;
          visit(bucket[i]);
        }
      }
      this.walked = walked;
      return;
    }
    for (let cx = x0; cx <= x1; cx++) {
      const base = (cx + CELL_BIAS) * CELL_STRIDE + CELL_BIAS;
      for (let cz = z0; cz <= z1; cz++) {
        const bucket = this.cells.get(base + cz);
        if (bucket === undefined) continue;
        for (let i = 0; i < bucket.length; i++) {
          walked++;
          visit(bucket[i]);
        }
      }
    }
    this.walked = walked;
  }
}

/** The box a label line reserves: its anchor, widened by half its own text. */
function lineBox(line: LabelLine): [number, number, number, number] {
  const r = line.straight / 2;
  return [line.x - r, line.z - r, line.x + r, line.z + r];
}

/** Squared metres from the world origin to a tile's centre. The fallback's rank. */
function tileOriginDistance(tile: MapIndexTile): number {
  const x = (tile.bounds[0] + tile.bounds[2]) / 2;
  const z = (tile.bounds[1] + tile.bounds[3]) / 2;
  return x * x + z * z;
}

export class MapAtlas {
  private readonly index: MapIndex;
  private readonly baseUrl: string;
  private readonly version: string;

  /** Every run in the build, in the order the tiles happened to arrive. */
  private readonly runs: RoadRun[] = [];
  /** The same runs, filed by where they are. See `LooseGrid` and `roadsWithin`. */
  private readonly runGrid = new LooseGrid<RoadRun>();
  /** The same runs again, filed by name. The chaining pass's input. */
  private readonly runsByName = new Map<number, RoadRun[]>();
  /** The name table. `nameId` indexes all three of these in lockstep. */
  private readonly names: string[] = [];
  private readonly labels: string[] = [];
  /** Metres of every run sharing a name, across the whole build. See `importanceOf`. */
  private readonly totals: number[] = [];
  private readonly nameIds = new Map<string, number>();

  /**
   * Where a name can be lettered, by name and by place. Built per *name*, on
   * demand, and rebuilt for a name only when that name's runs change -- see
   * `ensureLabelLines`.
   */
  private readonly linesByName = new Map<number, LabelLine[]>();
  private readonly lineGrid = new LooseGrid<LabelLine>();
  /** Names whose runs changed since they were last chained. */
  private readonly dirtyNames = new Set<number>();
  /**
   * Names the last `ensureLabelLines` actually re-chained.
   *
   * The one number that says whether the pass is incremental, and it is a
   * *count* rather than a duration because that is what can be asserted in CI:
   * a delivery must re-chain the names it carried, and never the 35,268 the
   * atlas is holding. See `server/integration-check.ts`.
   */
  private lastRechained = 0;

  private suburbNodes: SuburbNode[] = [];
  private landmarkNodes: MapLandmark[] = [];
  /**
   * The harbour, as a path in **world metres**, built once.
   *
   * A `Path2D` rather than the triangle soup the minimap takes, and it is the
   * single largest performance decision in this feature. Measured on the real
   * sheet at the district zoom, walking 3,564 triangles into the context with
   * `moveTo`/`lineTo` costs **25 ms** -- and essentially all of it is the ten
   * thousand canvas calls rather than the rasterising, because the same figure
   * comes back with the fill removed and comes back with the harbour entirely
   * off screen. Filling a path that was built once, through the canvas transform,
   * is **0.04 ms**. That is the difference between a map that drops a frame every
   * time it is opened and one that does not.
   *
   * It works here and not in `minimap.ts` because of what each is drawing: the
   * small map's water is per *tile*, arrives and is evicted with the tile, and is
   * queried against a moving disc, so there is nothing stable to build a path
   * out of. This is one sheet, for the whole harbour, for the session.
   */
  private waterShape: Path2D | null = null;
  private waterTriangleCount = 0;
  /**
   * Canvas path operations the harbour cost to build. Three a triangle, and the
   * reason that is a counter rather than a comment is in `buildWaterPlan`.
   */
  private waterPathOps = 0;
  /**
   * Tile sidecars the fallback refused to fetch. See `MAX_FALLBACK_TILES`.
   * Non-zero means the map is missing streets and is not going to get them.
   */
  private fallbackDropped = 0;

  private started = false;
  /** The street load has finished, however few tiles it turned out to be. */
  private namesDone = false;
  /**
   * The streets came from `street-names.bin` rather than 357 sidecars.
   *
   * Reported rather than acted on, and it is the one thing about this feature a
   * screenshot cannot show: both paths produce the same map, so the only way to
   * know which one ran is to ask. `window.sydney.bigmap` is where that is asked
   * from, and a `false` here on a world that has the block means the fetch or
   * the decode failed and the fallback quietly carried it.
   */
  private bundled = false;
  private tilesWanted = 0;
  private tilesDone = 0;
  private fetches = 0;
  private failures = 0;
  private revisionCounter = 0;
  /**
   * Which hexagons' name bundles have been asked for, on a segmented world.
   * Set before the fetch and removed again on failure, so a hexagon is in
   * flight at most once and a failed one is retried on the next rebuild.
   */
  private readonly hexNames = new Map<string, boolean>();
  /** Tiles the folded hexagons cover, for the progress readout. */
  private hexTiles = 0;
  private startedAt = 0;
  private finishedMs = 0;

  constructor(index: MapIndex, baseUrl = '/world', version = '') {
    this.index = index;
    this.baseUrl = baseUrl;
    this.version = version;
  }

  /**
   * Begin the one-time load. Idempotent, never throws, never worth awaiting.
   *
   * The idempotence is the feature and it is what the "fetched once" claim rests
   * on: `bigmap.ts` calls this on *every* open, because the alternative is a
   * flag in the caller that says whether it has called it, and a flag in the
   * caller is a flag that can be wrong. The second call returns on the first
   * line.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = performance.now();
    void this.ensureSuburbs();
    void this.loadWater();
    void this.loadNames();
  }

  /**
   * Bumped whenever something arrived that changes what the map would draw.
   *
   * A counter rather than a callback, because the consumer is a canvas that
   * redraws on a clock anyway: it compares this against the revision it last
   * drew and rebuilds if they differ, which collapses a burst of ten tiles
   * landing in the same frame into one rebuild instead of ten.
   */
  get revision(): number {
    return this.revisionCounter;
  }

  /**
   * Every street sidecar is in. The map is complete; nothing more will arrive.
   *
   * A flag set where the load ends rather than a comparison of two counters, and
   * the difference is a world with no `.names.bin` anywhere -- one built before
   * the pipeline wrote them. There, `tilesWanted` is zero and every counter
   * comparison is either vacuously true before the fetch starts or vacuously
   * false forever, and the second of those leaves "loading street names… 100%"
   * pulsing over a finished map for the rest of the session.
   */
  get complete(): boolean {
    return this.namesDone;
  }

  /** 0 to 1 across the street sidecars, which are all of the load that is slow. */
  get progress(): number {
    if (!this.started) return 0;
    if (this.tilesWanted === 0) return 1;
    return this.tilesDone / this.tilesWanted;
  }

  get suburbs(): readonly SuburbNode[] {
    return this.suburbNodes;
  }

  get landmarks(): readonly MapLandmark[] {
    return this.landmarkNodes;
  }

  /** The harbour in world metres, or null until `far-water.bin` lands. */
  get waterPlan(): Path2D | null {
    return this.waterShape;
  }

  /** The full display form -- 'King Street'. */
  nameOf(id: number): string {
    return this.names[id] ?? '';
  }

  /** The signage form -- 'King St'. What the map letters, because a map is tight. */
  labelOf(id: number): string {
    return this.labels[id] ?? '';
  }

  /**
   * Metres of street carrying this name, across the whole build.
   *
   * The map's only measure of *importance*, and it exists because the sidecar
   * carries no road class -- the pipeline writes a name and a polyline and
   * nothing about whether it is a motorway or the lane behind a pub. Length is a
   * remarkably good stand-in for the thing that is missing, because the two
   * correlate almost perfectly in a real street network: arterials run for
   * kilometres by definition and laneways are one block long by definition.
   *
   * Swept over the build the distribution is 228 m at the median, 1,035 m at the
   * ninth decile, and the top of it is Warringah Freeway at 11.1 km, Western
   * Distributor at 10.9, Cahill Expressway at 8.8, then Oxford Street and
   * Elizabeth Street -- which is a defensible list of the roads a Sydneysider
   * would name first, produced without a class tag anywhere in it.
   *
   * The one thing it gets wrong is that two unrelated streets sharing a name are
   * summed into one, so the four Church Streets of the inner ring look like one
   * four-kilometre road. That inflates a handful of common names by a factor of
   * two or three, which moves them a decile at most and is not visible in the
   * only thing this decides: which labels get drawn first.
   */
  importanceOf(id: number): number {
    return this.totals[id] ?? 0;
  }

  /**
   * Every run whose bounds meet the box, above an importance floor.
   *
   * A sink array rather than a returned one, on `TileStreamer.namedStreetsNear`'s
   * argument -- this is called on every rebuild and the caller owns one array for
   * the life of the panel.
   *
   * Through the grid rather than over every run, which is a reversal of what
   * this comment used to say and the note above `CELL_M` is why. The exact test
   * is unchanged and still the run's own bounds against the box -- the index
   * only decides which runs get asked.
   */
  roadsWithin(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    minImportance: number,
    out: RoadRun[],
  ): RoadRun[] {
    out.length = 0;
    const totals = this.totals;
    this.runGrid.query(minX, minZ, maxX, maxZ, (r) => {
      if (r.maxX < minX || r.minX > maxX || r.maxZ < minZ || r.minZ > maxZ) return;
      if (minImportance > 0 && totals[r.nameId] < minImportance) return;
      out.push(r);
    });
    return out;
  }

  /**
   * Every place a street name could be lettered inside the box, above an
   * importance floor.
   *
   * The label pass's query, kept apart from `roadsWithin` because the two want
   * different things out of the same data: the drawing wants every run that
   * touches the view, and the lettering wants one *long straight stretch* per
   * street, which no single run is. See `buildLabelLines`.
   *
   * The cull is the anchor point against the box, widened by half the stretch so
   * a label whose centre is just off screen but whose text would reach into it is
   * still offered -- which is what stops every street being unlabelled along the
   * four edges of the panel.
   */
  labelLinesWithin(
    minX: number,
    minZ: number,
    maxX: number,
    maxZ: number,
    minImportance: number,
    out: LabelLine[],
  ): LabelLine[] {
    this.ensureLabelLines();
    out.length = 0;
    const totals = this.totals;
    this.lineGrid.query(minX, minZ, maxX, maxZ, (line) => {
      if (minImportance > 0 && totals[line.nameId] < minImportance) return;
      const r = line.straight / 2;
      if (line.x + r < minX || line.x - r > maxX || line.z + r < minZ || line.z - r > maxZ) return;
      out.push(line);
    });
    return out;
  }

  /**
   * Chain the runs of each street together, then find the longest straight
   * stretch of each chain. Once per delivery of new tiles, not per redraw.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS EXISTS. A run cannot be lettered, and the numbers say so plainly.
   *
   * OSM splits a street into a way per block, the pipeline clips those to tiles
   * and then decimates them, so a "run" in this payload is 53 m at the median and
   * 177 m at the ninth decile -- 2.5 points long. Text at the district zoom needs
   * about 5.7 m of street per character, so "Botany Rd" wants 290 m of straight
   * road to sit on. Swept over the build, **11% of eligible names had a single
   * run long enough** at that zoom, and in an inner suburb of short blocks the
   * answer was none at all: the first cut of this map drew a perfect street
   * network with not one name on it above the closest zoom.
   *
   * Chaining is what recovers it. Botany Road arrives as fourteen runs that meet
   * end to end; joined, it is two kilometres with several straight kilometres-long
   * stretches in it, and the label goes on the longest.
   *
   * ---------------------------------------------------------------------------
   * The join is by shared endpoint, which is exactly what a way split is.
   *
   * Runs of the same name whose ends coincide within `JOIN_EPS` are the same
   * street continuing -- that is what splitting a way *means*, and it is why this
   * needs no geometry beyond an endpoint hash. Two streets of the same name in
   * different suburbs never touch and are never joined; a street that genuinely
   * forks is walked down one arm and the other becomes a second chain, which is
   * the right answer for a label either way.
   *
   * The hash is quantised to `JOIN_EPS` and each endpoint is offered to the four
   * cells its rounding could have gone to, because two coordinates a millimetre
   * apart can land either side of a cell boundary -- the failure mode of not
   * doing that is a chain that silently stops at one join in a few hundred.
   *
   * ---------------------------------------------------------------------------
   * The straight stretch is greedy and single-pass.
   *
   * From each break point, the walk extends while every new segment stays within
   * `STRAIGHT_TOL` of the bearing the stretch started with, and the chord from
   * first point to last is the length. That is O(points) rather than the O(n^2)
   * of testing every start, and it gives up nothing that matters: the two differ
   * only when a stretch would have been better started one segment later, which
   * moves a label a few metres along a road it is already on.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT PRECOMPUTED, now that the runs arrive as one bundle and the
   * pipeline could just as easily ship the chains.
   *
   * It is the obvious next thing and it was measured before it was refused:
   * chaining the whole build is **18,788 runs into 6,348 chains in 46 ms**, once
   * per session, on the first frame that draws a label. That is a real number
   * and not a small one -- it is a dropped frame or three -- and it is the only
   * argument in favour.
   *
   * Against it, three, of which the third is decisive:
   *
   *   * **The runs are needed anyway.** `roadsWithin` culls the drawn network by
   *     each *run's* own bounds, and a chain's bounds are the union of a whole
   *     street's -- Botany Road's box is two kilometres on a side and rejects
   *     nothing. A bundle of chains would have to carry the runs as well, so it
   *     is strictly larger than this one rather than smaller.
   *   * **Importance would drift.** `importanceOf` sums run lengths, and a chain
   *     is not quite the sum of its parts: the join drops one of the two
   *     coincident endpoints, so every join moves the total by up to `JOIN_EPS`.
   *     Ranking on a slightly different number reorders the labels near a tie.
   *   * **It could not be proved identical.** A chain's anchor is `atan2` and
   *     `sqrt` of float32 sums, and CPython's libm and V8's are not obliged to
   *     agree in the last bit. Every label would land within a micrometre of
   *     where it lands today and *none of them could be shown to*, which is the
   *     opposite of what this change set out to do -- the whole bundle is built
   *     to be bit-identical to the sidecars precisely so the map cannot move.
   *
   * So the chaining stays here, on the client, over runs that are the same bits
   * either path delivered them by.
   *
   * ---------------------------------------------------------------------------
   * IT IS INCREMENTAL, and that is what the 60 km world forced.
   *
   * This used to rebuild every chain in the atlas whenever `revision` moved, on
   * the 46 ms measured over 18,788 runs. The world is 234,094 runs now and the
   * same pass is **1,287 ms measured** -- and `revision` moves once per hexagon
   * that lands, so running across the city with the map open paid it again and
   * again. That is the shape of the whole failure: a number that was a dropped
   * frame at 19.3 km is a locked-up second at 60 km, and nothing about the code
   * changed in between.
   *
   * What makes it incremental is that **chaining is per name and names do not
   * interact**. A join is an endpoint shared by two runs *of the same name*, so
   * the chains of Botany Road are a pure function of the runs called Botany
   * Road; a hexagon landing with 2,994 names in it invalidates those 2,994 and
   * nothing else. So the runs are filed by name as they arrive (`runsByName`),
   * the names touched are marked (`dirtyNames`), and this re-chains those and
   * leaves the rest of the city alone. The cost is proportional to the delivery
   * rather than to the accumulation, which is the property that survives the
   * next doubling.
   *
   * The output is identical to the whole-atlas pass, not merely equivalent: a
   * dirty name is re-chained over **all** of its runs, old and new, in the order
   * they arrived, by the same code. What changes is only which names are asked.
   * Measured both ways over the same eight hexagons -- 73,989 runs -- the two
   * produce the same 28,118 label lines with every anchor identical, and:
   *
   *     per delivery, ms   1    2    3    4    5    6    7    8   total  worst
   *     whole atlas      114  377  345  360  399  416  489  407   2,907    489
   *     per name         290  118  130  125  169  116   54  275   1,277    290
   *
   * The totals matter less than the shapes. The old row climbs, because every
   * delivery redoes every one before it; the new row is flat, because a delivery
   * costs what it delivered. At 86 hexagons the old row is quadratic in the
   * number of hexagons a session walks through, which is what a player running
   * across Sydney with the map open was paying.
   */
  private ensureLabelLines(): void {
    this.lastRechained = this.dirtyNames.size;
    if (this.dirtyNames.size === 0) return;
    for (const nameId of this.dirtyNames) {
      const previous = this.linesByName.get(nameId);
      if (previous !== undefined) {
        for (const line of previous) {
          const box = lineBox(line);
          this.lineGrid.remove(line, box[0], box[1], box[2], box[3]);
        }
      }
      const runs = this.runsByName.get(nameId);
      const built = runs === undefined ? [] : chainName(nameId, runs);
      this.linesByName.set(nameId, built);
      for (const line of built) {
        const box = lineBox(line);
        this.lineGrid.insert(line, box[0], box[1], box[2], box[3]);
      }
    }
    this.dirtyNames.clear();
  }

  /**
   * One run into the index, and into both of the things that are asked about it.
   *
   * The single door every delivery path goes through -- the whole-world bundle,
   * a per-hexagon bundle, a tile sidecar and the self-check's literals -- so
   * there is one place that decides what an arriving run costs. See `foldBundle`
   * for why the three fetch paths have to stay indistinguishable.
   */
  private addRun(run: RoadRun): void {
    this.runs.push(run);
    this.runGrid.insert(run, run.minX, run.minZ, run.maxX, run.maxZ);
    const byName = this.runsByName.get(run.nameId);
    if (byName === undefined) this.runsByName.set(run.nameId, [run]);
    else byName.push(run);
    this.dirtyNames.add(run.nameId);
  }

  /** What was loaded and what it cost, for `window.sydney.bigmap`. */
  stats(): {
    started: boolean;
    complete: boolean;
    progress: number;
    /** HTTP requests this atlas has made, ever. The "fetched once" check. */
    fetches: number;
    failures: number;
    /** The streets arrived as one bundle. See `bundled` and `loadNameBundle`. */
    bundle: boolean;
    tiles: number;
    tilesLoaded: number;
    runs: number;
    points: number;
    names: number;
    suburbs: number;
    landmarks: number;
    waterTriangles: number;
    /**
     * Chains built from the runs; where a street name can go.
     *
     * Zero until the map has drawn labels once, because the chaining is lazy --
     * it is 46 ms over the whole build and it is wasted on a session that never
     * opens the map. See `ensureLabelLines`, which also says why it is not done
     * in the pipeline instead.
     */
    labelLines: number;
    /** Canvas operations the harbour path cost. Three a triangle -- `buildWaterPlan`. */
    waterPathOps: number;
    /** Sidecars the capped fallback refused. See `MAX_FALLBACK_TILES`. */
    fallbackDropped: number;
    loadMs: number;
    bytesApprox: number;
  } {
    let points = 0;
    for (const r of this.runs) points += r.points.length >> 1;
    return {
      started: this.started,
      complete: this.complete,
      progress: Math.round(this.progress * 1000) / 1000,
      fetches: this.fetches,
      failures: this.failures,
      bundle: this.bundled,
      tiles: this.tilesWanted,
      tilesLoaded: this.tilesDone,
      runs: this.runs.length,
      points,
      names: this.names.length,
      suburbs: this.suburbNodes.length,
      landmarks: this.landmarkNodes.length,
      waterTriangles: this.waterTriangleCount,
      labelLines: this.lineGrid.size,
      waterPathOps: this.waterPathOps,
      fallbackDropped: this.fallbackDropped,
      loadMs: Math.round(this.finishedMs),
      // What this is holding, near enough: the centreline points, plus what the
      // harbour's path is carrying (six floats a triangle, once).
      bytesApprox: points * 8 + this.waterTriangleCount * 24,
    };
  }

  /**
   * What the two spatial indexes hold and what the last query walked.
   *
   * Separate from `stats()` because it is about the *shape* of the index rather
   * than about the map, and because it is what `server/integration-check.ts`
   * asserts against the real shipped world: the whole claim of this file is that
   * opening the map costs the view rather than the city, and `lastWalked` is
   * where that claim is either true or is not. A number nobody can read is a
   * bound nobody can hold.
   */
  indexStats(): { runs: GridStats; lines: GridStats; rechained: number } {
    return {
      runs: this.runGrid.stats(),
      lines: this.lineGrid.stats(),
      rechained: this.lastRechained,
    };
  }

  // --- The loads ---------------------------------------------------------------

  /**
   * The suburb nodes, from the same URL `game/locator.ts` already asked for.
   *
   * Deliberately a second fetch rather than a getter on the locator, and it is
   * free: the locator asked for the identical stamped URL at boot, so this is a
   * memory-cache hit with no round trip and no bytes. What it buys is that this
   * class has no reference to the locator and works in a client that has none --
   * which is what makes it constructible in a self-check.
   *
   * Filtered rather than trusted, on the locator's own argument: one record with
   * a NaN coordinate would win every nearest test and every label placement from
   * then on, because every comparison against NaN is false.
   */
  /**
   * The suburb names alone, for whoever needs them before the map is opened:
   * the turf feed says "Marita took Parramatta" and has to know the word.
   * Once; `start` goes through here too.
   */
  ensureSuburbs(): Promise<void> {
    if (this.suburbsLoad === null) this.suburbsLoad = this.loadSuburbs();
    return this.suburbsLoad;
  }

  private suburbsLoad: Promise<void> | null = null;

  private async loadSuburbs(): Promise<void> {
    try {
      this.fetches++;
      const resp = await fetchWorldAsset(this.baseUrl, 'suburbs.json', this.version);
      if (!resp.ok) {
        this.failures++;
        return;
      }
      const raw = (await resp.json()) as SuburbNode[];
      this.suburbNodes = raw.filter(
        (s) =>
          typeof s?.name === 'string' &&
          s.name.length > 0 &&
          Number.isFinite(s.x) &&
          Number.isFinite(s.z),
      );
      this.revisionCounter++;
    } catch {
      this.failures++;
    }
  }

  /**
   * The harbour, from the always-resident far sheet.
   *
   * `far-water.bin` rather than the streamer's per-tile plans, and the reason is
   * the whole reason this map exists: the streamed sheets cover the tiles the
   * player is standing in, and the question the big map answers is about the
   * nine kilometres they are not. The far sheet is the entire harbour, already in
   * world metres -- `world/water.ts` builds it into the scene from the same
   * buffer without an offset. It was 98 kB and 3,564 triangles when this was
   * written and it is **9.7 MB and 282,567 triangles** at 60 km, which is the
   * number every sentence below now has to survive.
   *
   * De-indexed straight into a `Path2D` in world metres -- see `waterShape` for
   * the 25 ms that buys, and note that the index is walked exactly once ever
   * rather than once per redraw. Every sheet is taken rather than the largest,
   * unlike the tile version: there is only one here today, and a second one is a
   * lake this map has room to show.
   *
   * One path with the nonzero rule, so a triangulated bay composites at a single
   * alpha exactly as its outline would -- `minimap.ts`'s argument for its own
   * water and its footprints both, and the reason no outline has to be recovered
   * from the triangulation.
   */
  private async loadWater(): Promise<void> {
    if (!this.index.water?.far) return;
    try {
      this.fetches++;
      const resp = await fetchWorldAsset(this.baseUrl, 'far-water.bin', this.version);
      if (!resp.ok) {
        this.failures++;
        return;
      }
      const data = decodeWater(await resp.arrayBuffer());
      if (data === null) {
        this.failures++;
        return;
      }
      const shape = new Path2D();
      const built = buildWaterPlan(data.sheets, shape);
      this.waterShape = shape;
      this.waterTriangleCount = built.triangles;
      this.waterPathOps = built.ops;
      this.revisionCounter++;
    } catch {
      this.failures++;
    }
  }

  /**
   * The streets: one request if this world has a bundle, 357 if it does not.
   *
   * The tile list comes from the index the client booted with rather than a
   * fresh fetch, which matters on a rebuild: the pipeline may lay a new build
   * down mid-session and move the `built` stamp, and a map that mixed this
   * session's stamp with next build's tile list would ask for URLs that are
   * either 404s or -- worse -- a different city. One index, one stamp, one map.
   *
   * And the fan-out is capped, because the tile list is the thing that grows
   * with the world: it was 357 tiles when this was written and is 14,815 at
   * 60 km. See `MAX_FALLBACK_TILES`.
   */
  private async loadNames(): Promise<void> {
    if (await this.loadNameBundle()) {
      this.namesDone = true;
      this.finishedMs = performance.now() - this.startedAt;
      this.revisionCounter++;
      return;
    }
    // `?? []` rather than trusting the field: a segmented world boots from
    // `root.json`, which carries no tile list at all, and reaching this line
    // with one would be a `TypeError` inside an un-awaited promise -- a map
    // that silently never loads.
    const named = (this.index.tiles ?? []).filter((t) => (t.sn ?? 0) > 0);
    let tiles = named;
    if (named.length > MAX_FALLBACK_TILES) {
      // Nearest the world origin, which is the centre of the build and the only
      // position this class knows. Sorted on a copy: `index.tiles` belongs to
      // the streamer and the spawn search reads it in tile-key order.
      tiles = named
        .slice()
        .sort((a, b) => tileOriginDistance(a) - tileOriginDistance(b))
        .slice(0, MAX_FALLBACK_TILES);
      this.fallbackDropped = named.length - tiles.length;
    }
    this.tilesWanted = tiles.length;
    if (tiles.length === 0) {
      this.namesDone = true;
      return;
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= tiles.length) return;
        await this.loadTileNames(tiles[i]);
      }
    };
    const pool: Array<Promise<void>> = [];
    for (let i = 0; i < Math.min(CONCURRENCY, tiles.length); i++) pool.push(worker());
    await Promise.all(pool);
    this.namesDone = true;
    this.finishedMs = performance.now() - this.startedAt;
    this.revisionCounter++;
  }

  /**
   * The whole city's street names in one request. True if it worked.
   *
   * ---------------------------------------------------------------------------
   * WHAT THIS REPLACED. Every tile with a street on it has a `.names.bin`, and
   * this file used to fetch all of them -- 357 requests on the first press of
   * `M`, ten at a time, for half a megabyte. The bytes were never the problem
   * and are not what changed: the bundle is 475 kB against the sidecars' 522 and
   * would be worth doing if it were larger. What changed is the *count*, which
   * is charged separately by everything between here and the disk -- a CDN edge
   * that must miss 357 times on a cold ref, an HTTP/2 window with 357 streams
   * fighting the streamer's tiles for it, and a phone radio that pays a wake-up
   * per burst. At the 15 km stage the same map is ~2,000 tiles, and 2,000 is not
   * a number a first press of a key should ever produce.
   *
   * ---------------------------------------------------------------------------
   * THE SIDECARS STAY, and not only for older worlds. `world/furniture.ts` reads
   * them for the blade legends and `game/locator.ts` for the "King Street,
   * Newtown" readout, both per resident tile and both with the tile's own bytes
   * -- `world/streetnames.ts` argues that case and it is still right. This
   * bundle is the *map's* copy, which is a different question asked about
   * everywhere at once, and the pipeline builds it by reading those same
   * sidecars back so the two cannot disagree about a single point.
   *
   * ---------------------------------------------------------------------------
   * THE FALLBACK IS THE OLD PATH, UNCHANGED. Three things land here:
   *
   *   - a world built before the bundle existed, which has no `street_names`
   *     block and never asks for the file;
   *   - the fetch failing, which is the CDN and the origin both having failed,
   *     since `fetchWorldAsset` has already tried both;
   *   - the file decoding to nothing, which is a truncated or half-written
   *     bundle.
   *
   * All three return false and the 357 requests happen instead. That is the
   * same promise every optional block in `index.json` makes, and it is why this
   * is a `loadNames` fast path rather than a replacement for it: there is
   * exactly one street-name loading path in this file that has ever been
   * shipped, and it is still here.
   *
   * The fold is deliberately the same three lines `loadTileNames` runs --
   * `intern`, accumulate `totals`, push a `RoadRun` -- in run order, which is
   * what makes the atlas the bundle produces indistinguishable from the one 357
   * sequential sidecars produce, name ids included. `verifyBigMap` asserts that
   * against a payload laid out by hand, and the equivalence over the real build
   * rests on it.
   */
  /**
   * The street names for one hexagon, folded in on demand.
   *
   * ---------------------------------------------------------------------------
   * THE MAP'S ROADS *ARE* THE STREET NAMES. `drawRoads` renders the centrelines
   * out of this index -- there is no separate road geometry on the big map --
   * so "which names does the map need" is exactly "which part of the city is on
   * screen", and the answer is a rectangle rather than the world.
   *
   * **So the rule is: the hexagons whose bounds overlap the view box, and no
   * others.** The widest rung of the zoom ladder is 9 km across, which at a
   * 6 km circumradius is two to four hexagons wherever the player is standing
   * -- and it is *still* two to four hexagons when the world is 60 km wide,
   * which is the whole point. The alternative rules were both considered and
   * both rejected: fetching every hexagon on the first press of `M` is the
   * 15 MB this pass exists to avoid, and gating on the label zoom would leave
   * the city zoom with no roads on it at all.
   *
   * It is called on every rebuild -- an open, a zoom, a pan, a re-anchor --
   * which is a handful of times a minute, and it is a `Map.has` per hexagon
   * when there is nothing to do.
   *
   * The fold is `foldBundle`, the same three lines the whole-world bundle and
   * the 357 sidecars both go through, so nothing about what the map draws
   * depends on which of the three paths delivered the points. What *is*
   * different is the order names are interned in -- it now follows the player
   * rather than the tile key -- and the label ranking is by total length with
   * the name id only as a last tie-break. `server/integration-check.ts` holds
   * that down by ranking the real build both ways and comparing the labels.
   */
  async ensureHexNames(minX: number, minZ: number, maxX: number, maxZ: number): Promise<void> {
    if (!hexesArmed()) return;
    const contract = hexContract();
    if (!contract) return;
    const jobs: Array<Promise<void>> = [];
    for (const entry of hexesInBox(minX, minZ, maxX, maxZ)) {
      if (entry.names === undefined) continue;
      if (this.hexNames.has(entry.id)) continue;
      this.hexNames.set(entry.id, true);
      jobs.push(
        (async () => {
          try {
            this.fetches++;
            const resp = await fetchWorldAsset(
              this.baseUrl,
              `${contract.dir}/${entry.id}.names.bin`,
              this.version,
            );
            if (!resp.ok) throw new Error(String(resp.status));
            const decoded = decodeStreetNameBundle(await resp.arrayBuffer());
            if (decoded === null) throw new Error('not a name bundle');
            this.foldBundle(decoded);
            // The counter `bigmap.ts` watches. Without it the runs land in the
            // index and the map never repaints, which is a map with suburbs and
            // a harbour on it and no streets -- and it looks exactly like a
            // world that has no street names in it at all.
            this.revisionCounter++;
            this.hexTiles += decoded.tiles;
            this.tilesWanted = this.hexTiles;
            this.tilesDone = this.hexTiles;
          } catch {
            // Retryable: the hexagon is dropped from the set so the next
            // rebuild asks again. A hexagon that gave up would be a permanent
            // blank rectangle in the middle of the map.
            this.hexNames.delete(entry.id);
            this.failures++;
          }
        })(),
      );
    }
    if (jobs.length === 0) return;
    await Promise.all(jobs);
  }

  private async loadNameBundle(): Promise<boolean> {
    // A segmented world has no whole-world bundle to fetch and must not fall
    // through to the 357-sidecar path either -- its names come from
    // `ensureHexNames`, driven by the view box. Reporting "done" here is
    // honest: there is nothing left for `loadNames` to do.
    if (hexesArmed()) {
      this.bundled = true;
      this.tilesWanted = 1;
      this.tilesDone = 1;
      return true;
    }
    const path = this.index.street_names?.path;
    if (!path) return false;
    // Reported before the fetch so the shimmer has something to say: a bundle
    // is one request and goes 0% to 100%, where the fan-out crept.
    this.tilesWanted = this.index.street_names?.tiles ?? 1;
    try {
      this.fetches++;
      const resp = await fetchWorldAsset(this.baseUrl, path, this.version);
      if (!resp.ok) {
        this.failures++;
        return false;
      }
      const decoded = decodeStreetNameBundle(await resp.arrayBuffer());
      if (decoded === null) {
        this.failures++;
        return false;
      }
      this.foldBundle(decoded);
      return true;
    } catch {
      this.failures++;
      return false;
    }
  }

  /**
   * A decoded bundle, into the index. The same three lines `loadTileNames`
   * runs, in run order, which is what makes the two paths interchangeable.
   */
  private foldBundle(decoded: StreetNameBundle): void {
    for (const run of decoded.runs) {
      const id = this.intern(decoded.names[run.nameIdx]);
      const length = polylineLength(run.points);
      this.totals[id] += length;
      this.addRun({
        nameId: id,
        points: run.points,
        minX: run.minX,
        minZ: run.minZ,
        maxX: run.maxX,
        maxZ: run.maxZ,
        length,
      });
    }
    this.bundled = true;
    this.tilesWanted = decoded.tiles;
    this.tilesDone = decoded.tiles;
  }

  /**
   * One tile, decoded and folded into the index. The fallback path's unit of
   * work; a world with a bundle never calls this.
   *
   * Never throws: a tile that 404s or arrives truncated is a hole in the map's
   * street names and nothing else, and the same 357 requests that would have to
   * be retried are the ones that would have to be *waited on* to know whether to
   * retry. The count of what did not make it is in `stats().failures`.
   *
   * The world-space lift is the streamer's own translation --
   * `(bounds.minX, bounds.minZ + tileSize)`, which is where `TileStreamer` puts
   * each tile's group -- applied once here rather than per query, on
   * `world/streetnames.ts`'s argument.
   */
  private async loadTileNames(tile: MapIndexTile): Promise<void> {
    try {
      this.fetches++;
      const resp = await fetchWorldAsset(this.baseUrl, `tiles/${tile.key}.names.bin`, this.version);
      if (!resp.ok) {
        this.failures++;
        return;
      }
      const decoded = decodeStreetNames(await resp.arrayBuffer());
      if (decoded === null) {
        this.failures++;
        return;
      }
      translateStreetNames(decoded, tile.bounds[0], tile.bounds[1] + this.index.tile_size);
      for (const seg of decoded.segments) {
        const id = this.intern(seg.name);
        const length = polylineLength(seg.points);
        this.totals[id] += length;
        this.addRun({
          nameId: id,
          points: seg.points,
          minX: seg.minX,
          minZ: seg.minZ,
          maxX: seg.maxX,
          maxZ: seg.maxZ,
          length,
        });
      }
    } catch {
      this.failures++;
    } finally {
      this.tilesDone++;
      // Every eighth tile rather than every one. A rebuild is a few milliseconds
      // and ten requests are in flight at a time, so bumping per tile would ask
      // the panel to redraw itself two hundred times over the second the load
      // takes, for a picture that changes by one suburb's streets each time.
      // The last tile always bumps -- `loadNames` does it after the pool drains
      // -- so the final state is never left one tile short of drawn.
      if (this.tilesDone % 8 === 0) this.revisionCounter++;
    }
  }

  /**
   * The name table. Shared by reference across every run that quotes a name, so
   * the 11,893 runs cost 1,967 strings and the abbreviation is computed once per
   * *name* rather than once per run or once per label per redraw.
   */
  private intern(name: string): number {
    const seen = this.nameIds.get(name);
    if (seen !== undefined) return seen;
    const id = this.names.length;
    this.nameIds.set(name, id);
    this.names.push(name);
    this.labels.push(abbreviateStreet(name));
    this.totals.push(0);
    return id;
  }

  /**
   * Load decoded segments straight in, without a fetch -- in **world** metres,
   * since there is no tile origin to lift them from.
   *
   * For `verifyBigMap`, which has to assert the importance measure and the
   * chaining against geometry whose answers are known, and neither of those can
   * be asserted against Sydney: "does Botany Road chain" has no ground truth in
   * the payload to compare with.
   */
  addSegmentsForTest(
    segments: ReadonlyArray<{
      name: string;
      points: Float32Array;
      minX: number;
      minZ: number;
      maxX: number;
      maxZ: number;
    }>,
  ): void {
    for (const seg of segments) {
      const id = this.intern(seg.name);
      const length = polylineLength(seg.points);
      this.totals[id] += length;
      this.addRun({
        nameId: id,
        points: seg.points,
        minX: seg.minX,
        minZ: seg.minZ,
        maxX: seg.maxX,
        maxZ: seg.maxZ,
        length,
      });
    }
    this.tilesWanted = Math.max(this.tilesWanted, 1);
    this.tilesDone = this.tilesWanted;
    this.revisionCounter++;
  }

  /**
   * Fold a bundle's bytes straight in, without a fetch. True if it decoded.
   *
   * For `verifyBigMap`, which asserts the bundle path against the per-tile path
   * by building one atlas each way over the same geometry and comparing what
   * comes out. It deliberately runs the **same fold** `loadNameBundle` runs
   * rather than a second copy of it -- a check against a parallel
   * implementation would pass while the shipped one drifted.
   */
  addBundleForTest(buffer: ArrayBuffer): boolean {
    const decoded = decodeStreetNameBundle(buffer);
    if (decoded === null) return false;
    this.foldBundle(decoded);
    this.revisionCounter++;
    return true;
  }

  /** The landmark anchors, straight out of the index. No fetch: they are in it. */
  readLandmarks(): void {
    const items = this.index.landmarks?.items;
    if (!items) return;
    const out: MapLandmark[] = [];
    for (const item of items) {
      const a = item.anchor_world;
      if (!a || a.length < 3 || !Number.isFinite(a[0]) || !Number.isFinite(a[2])) continue;
      out.push({
        name: LANDMARK_NAMES[item.name] ?? item.name.replace(/_/g, ' '),
        x: a[0],
        z: a[2],
      });
    }
    this.landmarkNodes = out;
  }
}

// --- The harbour plan ---------------------------------------------------------

/**
 * Whatever a triangle can be written into. `Path2D` is one; the check is another.
 *
 * Structural rather than `Path2D`, and not for taste: `server/integration-check.ts`
 * runs in Bun, where there is no canvas at all, and the thing that has to be
 * asserted about this walk is *how many operations it issues*. A sink it can
 * implement is the only way to assert that against the real `far-water.bin`
 * rather than against a description of it.
 */
export interface PlanSink {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
}

/** One de-indexed water sheet: interleaved `x, z, depth` and a triangle list. */
export interface PlanSheet {
  readonly vertices: Float32Array;
  readonly indices: Uint32Array | Uint16Array;
}

/**
 * De-index the harbour into a fill path. Returns what it drew and what it cost.
 *
 * ---------------------------------------------------------------------------
 * THERE IS NO `closePath` HERE, AND THAT IS THE WHOLE POINT.
 *
 * This walk used to end each triangle with `shape.closePath()`, which is the
 * obvious thing to write and is semantically free -- `fill` closes every subpath
 * implicitly, so the path with the calls and the path without them rasterise to
 * the same pixels. It is not free at all. **Chrome's canvas path builder is
 * quadratic in the number of closed subpaths**, measured on the real thing:
 *
 *     triangles     with closePath      without
 *        25,000         1,193 ms          ~1 ms
 *        50,000         4,672 ms          ~3 ms
 *       200,000                            ~8 ms
 *
 * Four times the work for twice the triangles is a clean n^2, and 282,567
 * triangles extrapolates to **about 150 seconds of unbroken main thread**. That
 * is what pressing `M` did on a 60 km world: `start()` fetched 9.7 MB of harbour
 * and then wedged the tab -- and, on a laptop, the machine -- for two and a half
 * minutes building a path that draws the same picture in eight milliseconds. The
 * shape was 3,564 triangles when the call was written, where the same defect is
 * 24 ms and invisible.
 *
 * So the rule this file now holds, and the one the check asserts: **three
 * operations a triangle, a move and two lines, and nothing else.** `ops` is
 * returned so that is a number somebody can test rather than a comment somebody
 * can delete.
 *
 * (The same trap is live anywhere a per-item `closePath` meets a payload that
 * grew: `bigmap.ts`'s footprint fill closes per prism, which is hundreds and
 * therefore fine, and `minimap.ts` does the same. Neither is near the knee. This
 * one was three hundred thousand.)
 */
export function buildWaterPlan(
  sheets: ReadonlyArray<PlanSheet>,
  sink: PlanSink,
): { triangles: number; ops: number } {
  let triangles = 0;
  let ops = 0;
  for (const sheet of sheets) {
    const idx = sheet.indices;
    const v = sheet.vertices;
    for (let i = 0; i + 2 < idx.length; i += 3) {
      // Vertices are interleaved (x, z, depth) -- see `WaterSheet`. The y is
      // the sheet's own surface and this is a plan, so it is dropped here.
      const a = idx[i] * 3;
      const b = idx[i + 1] * 3;
      const c = idx[i + 2] * 3;
      sink.moveTo(v[a], v[a + 1]);
      sink.lineTo(v[b], v[b + 1]);
      sink.lineTo(v[c], v[c + 1]);
      ops += 3;
      triangles++;
    }
  }
  return { triangles, ops };
}

/**
 * Every place one street name can be lettered, from that name's runs alone.
 *
 * Lifted out of `ensureLabelLines` unchanged so it can be called for one name
 * at a time; `MapAtlas.ensureLabelLines` documents the join, the straightness
 * walk and why the pass is per name in the first place.
 */
function chainName(nameId: number, runs: readonly RoadRun[]): LabelLine[] {
  const lines: LabelLine[] = [];
  // Endpoint index, over this name's runs only.
  const ends = new Map<string, number[]>();
  const add = (key: string, i: number): void => {
    const list = ends.get(key);
    if (list === undefined) ends.set(key, [i]);
    else list.push(i);
  };
  const keysFor = (x: number, z: number): string[] => {
    const qx = x / JOIN_EPS;
    const qz = z / JOIN_EPS;
    const fx = Math.floor(qx);
    const fz = Math.floor(qz);
    // The four cells the point could have rounded into. See the header.
    return [`${fx},${fz}`, `${fx + 1},${fz}`, `${fx},${fz + 1}`, `${fx + 1},${fz + 1}`];
  };
  for (let i = 0; i < runs.length; i++) {
    const p = runs[i].points;
    for (const k of keysFor(p[0], p[1])) add(k, i);
    for (const k of keysFor(p[p.length - 2], p[p.length - 1])) add(k, i);
  }

  const used = new Uint8Array(runs.length);
  for (let seed = 0; seed < runs.length; seed++) {
    if (used[seed]) continue;
    used[seed] = 1;
    // The chain, as a growing flat list of x, z. Built from the seed
    // outward: forward off the tail, then backward off the head.
    const chain: number[] = Array.from(runs[seed].points);
    for (let direction = 0; direction < 2; direction++) {
      for (;;) {
        const tail = direction === 0;
        const ex = tail ? chain[chain.length - 2] : chain[0];
        const ez = tail ? chain[chain.length - 1] : chain[1];
        let found = -1;
        let flip = false;
        for (const key of keysFor(ex, ez)) {
          const list = ends.get(key);
          if (list === undefined) continue;
          for (const j of list) {
            if (used[j]) continue;
            const p = runs[j].points;
            if (near(p[0], p[1], ex, ez)) {
              found = j;
              flip = false;
              break;
            }
            if (near(p[p.length - 2], p[p.length - 1], ex, ez)) {
              found = j;
              flip = true;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) break;
        used[found] = 1;
        const p = runs[found].points;
        const n = p.length;
        // Skip the shared endpoint itself, or the chain gets a zero-length
        // segment at every join and the straightness walk trips over it.
        if (tail) {
          if (flip) for (let i = n - 4; i >= 0; i -= 2) chain.push(p[i], p[i + 1]);
          else for (let i = 2; i < n; i += 2) chain.push(p[i], p[i + 1]);
        } else {
          // Both branches collect the new piece **far end first**, which is
          // the order that leaves the chain contiguous once it is prepended:
          // the point nearest the old head ends up immediately before it.
          // `flip` says the incoming run already runs toward the head, so it
          // is taken as it lies, minus its last point; otherwise it runs away
          // from the head and is taken backwards, minus its first.
          const head: number[] = [];
          if (flip) for (let i = 0; i < n - 2; i += 2) head.push(p[i], p[i + 1]);
          else for (let i = n - 2; i >= 2; i -= 2) head.push(p[i], p[i + 1]);
          chain.unshift(...head);
        }
      }
    }
    const line = longestStraight(Float32Array.from(chain), nameId);
    if (line !== null) lines.push(line);
  }
  return lines;
}

/** Are two points the same junction, to `JOIN_EPS`? Squared, so no root. */
function near(ax: number, az: number, bx: number, bz: number): boolean {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz <= JOIN_EPS * JOIN_EPS;
}

/**
 * The longest stretch of a polyline that is straight enough to letter along.
 *
 * Greedy and single-pass: a stretch runs from a break point for as long as every
 * segment stays within `STRAIGHT_TOL` of the bearing it opened with, and its
 * length is the *chord* -- first point to last -- rather than the distance
 * walked, because the chord is what the text actually occupies.
 *
 * Exported for the self-check, which is where the two failures that have no
 * frame are caught: a tolerance test that compares against the previous segment
 * instead of the stretch's first will follow a road round a bend one degree at a
 * time and letter a name across a curve, and an angle subtraction that does not
 * wrap will break every stretch that happens to cross due west.
 */
export function longestStraight(points: Float32Array, nameId: number): LabelLine | null {
  const n = points.length >> 1;
  if (n < 2) return null;
  let bestStart = 0;
  let bestEnd = 1;
  let best = -1;
  let start = 0;
  let bearing = Math.atan2(points[3] - points[1], points[2] - points[0]);
  for (let i = 1; i < n; i++) {
    const dx = points[i * 2] - points[i * 2 - 2];
    const dz = points[i * 2 + 1] - points[i * 2 - 1];
    // A zero-length segment -- which decimation leaves at a clip boundary -- has
    // no bearing at all and must not break a stretch; `atan2(0, 0)` is 0, which
    // would break every stretch that is not running due east.
    if (dx !== 0 || dz !== 0) {
      const a = Math.atan2(dz, dx);
      let d = a - bearing;
      // Wrapped into [-pi, pi), or a stretch crossing due west compares 179
      // degrees against -179 and reads as a hairpin.
      while (d >= Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > STRAIGHT_TOL) {
        // The stretch ends at the previous point; a new one opens here.
        start = i - 1;
        bearing = a;
      }
    }
    const cx = points[i * 2] - points[start * 2];
    const cz = points[i * 2 + 1] - points[start * 2 + 1];
    const chord = Math.sqrt(cx * cx + cz * cz);
    if (chord > best) {
      best = chord;
      bestStart = start;
      bestEnd = i;
    }
  }
  if (best <= 0) return null;
  const ax = points[bestStart * 2];
  const az = points[bestStart * 2 + 1];
  const bx = points[bestEnd * 2];
  const bz = points[bestEnd * 2 + 1];
  return {
    nameId,
    x: (ax + bx) / 2,
    z: (az + bz) / 2,
    angle: Math.atan2(bz - az, bx - ax),
    straight: best,
    length: polylineLength(points),
  };
}

// --- The street-name bundle ---------------------------------------------------

/**
 * `street-names.bin`'s header. **Must match `NAME_BUNDLE_MAGIC` and
 * `NAME_BUNDLE_VERSION` in `pipeline/sydney/tiles.py`.** Exported because
 * `verifyBigMap` lays out a payload against them by hand, and a check that made
 * up its own magic would prove nothing about the file the pipeline emits.
 */
export const NAME_BUNDLE_MAGIC = 0x44424e53; // 'SNBD', little-endian
export const NAME_BUNDLE_VERSION = 1;
/** Eight u32s, so every block after it starts 4-byte aligned. */
export const NAME_BUNDLE_HEADER = 32;

/** One run out of the bundle, already lifted into world metres. */
export interface BundleRun {
  /** Index into the bundle's own string table, not into the atlas's. */
  readonly nameIdx: number;
  /** `[x0, z0, ...]` in world metres -- a **view** into the shared buffer. */
  readonly points: Float32Array;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface StreetNameBundle {
  readonly names: readonly string[];
  readonly runs: readonly BundleRun[];
  /** Tiles the bundle carried runs for. Reported; nothing reads it. */
  readonly tiles: number;
  readonly points: number;
}

const utf8 = new TextDecoder();

/** The next 4-byte boundary at or after `n`. Every block in the file sits on one. */
function align4(n: number): number {
  return (n + 3) & ~3;
}

/**
 * Decode `world/street-names.bin`. `null` for anything that is not one.
 *
 * ---------------------------------------------------------------------------
 * THE LAYOUT, which `write_street_name_bundle` documents from the other side:
 *
 *     u32  magic, version, names, tiles, runs, points, tableBytes, idxWidth
 *     -- string table: per name, u16 length and its UTF-8; padded to 4
 *     -- u32 x tiles      runs in each tile
 *     -- f32 x 2 x tiles  each tile's world origin
 *     -- idx x runs       each run's name index (idxWidth is 2 or 4); padded
 *     -- u8  x runs       each run's point count; padded
 *     -- f32 x 2 x points tile-local metres, run order
 *
 * ---------------------------------------------------------------------------
 * WHY THE POINTS ARRIVE TILE-LOCAL AND ARE LIFTED HERE, rather than arriving in
 * world metres with the origins already folded in.
 *
 * This has to produce **bit-identical arrays** to the ones the per-tile path
 * produces, because the whole feature is a packaging change and the labels are
 * not allowed to move. The per-tile path computes a world coordinate as
 * `float32(float32(local) + origin)` -- the add happens in double and the store
 * into a `Float32Array` rounds -- and a run's bounds as `double(local) + origin`,
 * which is *not* rounded. Those two answers differ in the last bits, and no
 * single pre-folded number can be both. Doing the same two operations here, on
 * the same tile-local float32 the sidecar carries, means the question does not
 * arise. See `translateStreetNames`, whose loop this is.
 *
 * ---------------------------------------------------------------------------
 * ONE BUFFER, and every run a view into it. The per-tile path allocates a
 * `Float32Array` per run, which across the build is 18,788 typed arrays and
 * their headers; here the coordinate block is copied out once and each run is a
 * `subarray`. The usual objection to a view -- that it pins a large buffer alive
 * to read a small part of it, which is why `tile-decode.ts` slices instead --
 * does not apply, because this buffer *is* the payload: every byte of it is one
 * of the runs being held.
 *
 * Strict rather than salvaging, unlike the per-tile decoder. A short `.names.bin`
 * is decoded as far as it goes because the alternative is a hole in one tile;
 * here the alternative is the fallback path, which fetches the same streets from
 * the same sidecars and produces the whole map. A bundle that does not add up is
 * better refused.
 */
export function decodeStreetNameBundle(buffer: ArrayBuffer): StreetNameBundle | null {
  if (buffer.byteLength < NAME_BUNDLE_HEADER) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== NAME_BUNDLE_MAGIC) return null;
  // An unknown *future* version is refused rather than guessed at, on
  // `decodeFurniture`'s argument: a newer pipeline against an older client is a
  // deployment mistake, and falling back to the sidecars is a far better
  // symptom of it than a map of NaN centrelines.
  if (view.getUint32(4, true) !== NAME_BUNDLE_VERSION) return null;
  const nameCount = view.getUint32(8, true);
  const tileCount = view.getUint32(12, true);
  const runCount = view.getUint32(16, true);
  const pointCount = view.getUint32(20, true);
  const tableBytes = view.getUint32(24, true);
  const idxWidth = view.getUint32(28, true);
  if (nameCount === 0 || runCount === 0 || pointCount === 0) return null;
  if (idxWidth !== 2 && idxWidth !== 4) return null;
  if (tableBytes % 4 !== 0) return null;

  const tableEnd = NAME_BUNDLE_HEADER + tableBytes;
  if (tableEnd > buffer.byteLength) return null;
  const bytes = new Uint8Array(buffer);
  const names: string[] = [];
  let p = NAME_BUNDLE_HEADER;
  for (let i = 0; i < nameCount; i++) {
    if (p + 2 > tableEnd) return null;
    const len = view.getUint16(p, true);
    p += 2;
    if (p + len > tableEnd) return null;
    names.push(utf8.decode(bytes.subarray(p, p + len)));
    p += len;
  }

  p = tableEnd;
  const tileRunsBytes = tileCount * 4;
  const originBytes = tileCount * 8;
  const nameIdxBytes = align4(runCount * idxWidth);
  const pointCountBytes = align4(runCount);
  const coordBytes = pointCount * 8;
  if (p + tileRunsBytes + originBytes + nameIdxBytes + pointCountBytes + coordBytes > buffer.byteLength) {
    return null;
  }

  const tileRuns = new Uint32Array(buffer.slice(p, p + tileRunsBytes));
  p += tileRunsBytes;
  const origins = new Float32Array(buffer.slice(p, p + originBytes));
  p += originBytes;
  const nameIdx =
    idxWidth === 2
      ? new Uint16Array(buffer.slice(p, p + runCount * 2))
      : new Uint32Array(buffer.slice(p, p + runCount * 4));
  p += nameIdxBytes;
  const runPoints = new Uint8Array(buffer.slice(p, p + runCount));
  p += pointCountBytes;
  const coords = new Float32Array(buffer.slice(p, p + coordBytes));

  const runs: BundleRun[] = [];
  let r = 0;
  let at = 0;
  for (let t = 0; t < tileCount; t++) {
    const dx = origins[t * 2];
    const dz = origins[t * 2 + 1];
    const n = tileRuns[t];
    for (let k = 0; k < n; k++) {
      if (r >= runCount) return null;
      const count = runPoints[r];
      const idx = nameIdx[r];
      r++;
      const start = at;
      at += count * 2;
      if (at > coords.length) return null;
      // A name index past the table is dropped rather than clamped, exactly as
      // `decodeStreetNames` drops it: clamping would put a piece of some other
      // street on the map under the wrong name.
      if (count < 2 || idx >= nameCount) continue;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let i = start; i < at; i += 2) {
        const x = coords[i];
        const z = coords[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      for (let i = start; i < at; i += 2) {
        coords[i] += dx;
        coords[i + 1] += dz;
      }
      runs.push({
        nameIdx: idx,
        points: coords.subarray(start, at),
        minX: minX + dx,
        minZ: minZ + dz,
        maxX: maxX + dx,
        maxZ: maxZ + dz,
      });
    }
  }
  // The three counts in the header have to agree with each other, or the file
  // describes a world that is not the one in it.
  if (r !== runCount || at !== coords.length || runs.length === 0) return null;
  return { names, runs, tiles: tileCount, points: pointCount };
}

/** Metres along a flattened `x, z` polyline. */
export function polylineLength(points: Float32Array): number {
  let total = 0;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const dx = points[i + 2] - points[i];
    const dz = points[i + 3] - points[i + 1];
    total += Math.sqrt(dx * dx + dz * dz);
  }
  return total;
}
