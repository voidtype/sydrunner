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
 *   * **11,893 runs, 30,154 points** -- 241 kB of `Float32Array` for the entire
 *     street network of the inner ring, because the sidecar is decimated to 2.5
 *     points a run. That is a fifth of *one* tile's GLB.
 *   * **338 kB over 213 requests**, one per tile that has a street on it (eight
 *     tiles in the build have none: the harbour and the industrial edge). On
 *     HTTP/2 that is one connection and a burst of small frames, and every URL
 *     carries the build stamp so the second visit is served from the disk cache
 *     without a round trip. See `world/version.ts`.
 *   * **1,967 distinct names**, which is what the labels are drawn from and what
 *     makes ranking them possible at all -- see `importanceOf`.
 *
 * The rule this file follows instead of "with the tile" is **once, and only when
 * asked**: nothing here is fetched at boot. A player who never opens the map
 * pays nothing, and a player who opens it once pays 436 kB and then nothing for
 * the rest of the session, however many times they open it again.
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
 * opens on the first press with the suburbs, the harbour and whatever tiles have
 * arrived, and fills in underneath itself; `revision` is the counter a drawing
 * layer watches to know something changed. The alternative -- holding the panel
 * closed until 213 requests finish -- would put a spinner in front of a feature
 * whose whole value is that it is instant.
 *
 * The order is deliberate and is by *value per byte*: the suburbs first (4.7 kB
 * and the single most useful thing on the map), then the harbour (98 kB, and the
 * one region whose absence would be actively misleading -- see `minimap.ts` on
 * water), then the streets (338 kB, and the only part that is a slow drip).
 */

import { decodeStreetNames, translateStreetNames } from './world/streetnames.ts';
import { fetchWorldAsset } from './world/cdn.ts';
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

export interface MapIndex {
  tile_size: number;
  tiles: MapIndexTile[];
  /** The hero set's anchors. Absent on a world built before the landmark pass. */
  landmarks?: { items?: ReadonlyArray<{ name: string; anchor_world?: number[] }> };
  /** Present with a `far` block when there is a `far-water.bin` to fetch. */
  water?: { far?: unknown };
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
 * How many tile sidecars are in flight at once.
 *
 * Ten rather than all 213, and rather than one at a time. All at once hands the
 * browser two hundred entries to schedule against the *same* connection the
 * streamer is pulling 1.5 MB tiles down -- the map would arrive faster and the
 * city under the player would stall, which is the wrong trade for a panel that
 * is already usable. One at a time is 213 sequential round trips, which on a
 * 40 ms link is nine seconds.
 *
 * Ten keeps the pipe busy, finishes in about a second on a normal connection,
 * and leaves the streamer's own requests interleaved rather than queued behind
 * a wall of two hundred.
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

export class MapAtlas {
  private readonly index: MapIndex;
  private readonly baseUrl: string;
  private readonly version: string;

  /** Every run in the build, in the order the tiles happened to arrive. */
  private readonly runs: RoadRun[] = [];
  /** The name table. `nameId` indexes all three of these in lockstep. */
  private readonly names: string[] = [];
  private readonly labels: string[] = [];
  /** Metres of every run sharing a name, across the whole build. See `importanceOf`. */
  private readonly totals: number[] = [];
  private readonly nameIds = new Map<string, number>();

  /** Built from `runs` on demand, and rebuilt when more of the city lands. */
  private lines: LabelLine[] = [];
  private linesRevision = -1;

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

  private started = false;
  /** The street load has finished, however few tiles it turned out to be. */
  private namesDone = false;
  private tilesWanted = 0;
  private tilesDone = 0;
  private fetches = 0;
  private failures = 0;
  private revisionCounter = 0;
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
    void this.loadSuburbs();
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
   * A linear scan over all 11,893 runs with a box reject, and no spatial index,
   * which is a deliberate refusal rather than an omission: at the city zoom the
   * box is the whole build and an index would reject nothing, and at the closest
   * zoom the scan is four compares apiece for 11,800 of them. Measured against a
   * rebuild that then strokes 30,000 points and rasterises fifty labels, the
   * scan is not the part worth indexing.
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
    const runs = this.runs;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i];
      if (r.maxX < minX || r.minX > maxX || r.maxZ < minZ || r.minZ > maxZ) continue;
      if (minImportance > 0 && this.totals[r.nameId] < minImportance) continue;
      out.push(r);
    }
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
    for (const line of this.lines) {
      if (minImportance > 0 && this.totals[line.nameId] < minImportance) continue;
      const r = line.straight / 2;
      if (line.x + r < minX || line.x - r > maxX || line.z + r < minZ || line.z - r > maxZ) {
        continue;
      }
      out.push(line);
    }
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
   */
  private ensureLabelLines(): void {
    if (this.linesRevision === this.revisionCounter) return;
    this.linesRevision = this.revisionCounter;
    const lines: LabelLine[] = [];

    const byName = new Map<number, RoadRun[]>();
    for (const run of this.runs) {
      const list = byName.get(run.nameId);
      if (list === undefined) byName.set(run.nameId, [run]);
      else list.push(run);
    }

    for (const [nameId, runs] of byName) {
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
    }
    this.lines = lines;
  }

  /** What was loaded and what it cost, for `window.sydney.bigmap`. */
  stats(): {
    started: boolean;
    complete: boolean;
    progress: number;
    /** HTTP requests this atlas has made, ever. The "fetched once" check. */
    fetches: number;
    failures: number;
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
     * it is 0.7 ms and it is wasted on a session that never opens the map.
     * See `ensureLabelLines`.
     */
    labelLines: number;
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
      tiles: this.tilesWanted,
      tilesLoaded: this.tilesDone,
      runs: this.runs.length,
      points,
      names: this.names.length,
      suburbs: this.suburbNodes.length,
      landmarks: this.landmarkNodes.length,
      waterTriangles: this.waterTriangleCount,
      labelLines: this.lines.length,
      loadMs: Math.round(this.finishedMs),
      // What this is holding, near enough: the centreline points, plus what the
      // harbour's path is carrying (six floats a triangle, once).
      bytesApprox: points * 8 + this.waterTriangleCount * 24,
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
   * nine kilometres they are not. The far sheet is the entire harbour in 98 kB
   * and 3,564 triangles, already in world metres -- `world/water.ts` builds it
   * into the scene from the same buffer without an offset.
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
      let triangles = 0;
      for (const sheet of data.sheets) {
        const idx = sheet.indices;
        const v = sheet.vertices;
        for (let i = 0; i + 2 < idx.length; i += 3) {
          // Vertices are interleaved (x, z, depth) -- see `WaterSheet`. The y is
          // the sheet's own surface and this is a plan, so it is dropped here.
          const a = idx[i] * 3;
          const b = idx[i + 1] * 3;
          const c = idx[i + 2] * 3;
          shape.moveTo(v[a], v[a + 1]);
          shape.lineTo(v[b], v[b + 1]);
          shape.lineTo(v[c], v[c + 1]);
          shape.closePath();
          triangles++;
        }
      }
      this.waterShape = shape;
      this.waterTriangleCount = triangles;
      this.revisionCounter++;
    } catch {
      this.failures++;
    }
  }

  /**
   * Every tile's `.names.bin`, ten at a time.
   *
   * The tile list comes from the index the client booted with rather than a
   * fresh fetch, which matters on a rebuild: the pipeline may lay a new build
   * down mid-session and move the `built` stamp, and a map that mixed this
   * session's stamp with next build's tile list would ask for URLs that are
   * either 404s or -- worse -- a different city. One index, one stamp, one map.
   */
  private async loadNames(): Promise<void> {
    const tiles = this.index.tiles.filter((t) => (t.sn ?? 0) > 0);
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
   * One tile, decoded and folded into the index.
   *
   * Never throws: a tile that 404s or arrives truncated is a hole in the map's
   * street names and nothing else, and the same 213 requests that would have to
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
        this.runs.push({
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
      this.runs.push({
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
