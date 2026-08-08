/**
 * Region bundles: one request for a square kilometre of city, instead of five
 * hundred.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES IS NOT BYTES. `pipeline/sydney/meshpack.py` took care
 * of those -- the world's geometry is 2.25x smaller raw and 1.82x smaller on
 * the wire. What is left is the *shape* of the traffic, and it is bad in a way
 * that no amount of compression touches:
 *
 *   - a tile is up to **twelve** files (`glb`, `params`, `terr`, `veg`,
 *     `power`, `furn`, `pow`, `names`, `water`, `cars`, `lanes`, `collision`)
 *   - `TileStreamer.loadRadius` is **1,800 m**, which is 41 tiles standing
 *     still and a couple of hundred over a short walk
 *   - `TileStreamer.concurrency` is 4
 *
 * So a kilometre of Surry Hills is on the order of **1,500 HTTP requests**,
 * four at a time, each a round trip to a CDN edge. On a good connection that is
 * the city arriving in a visible ripple; on a bad one the round trips are the
 * dominant cost of playing, and the 15 km stage multiplies the tile count by
 * four.
 *
 * A region is 2x2 tiles -- one square kilometre -- written by
 * `pipeline/sydney/regions.py` as a single file with an index at the front. It
 * is fetched when the player comes within `trigger_m`, sliced into its members,
 * and handed to the existing per-tile pipeline from memory.
 *
 * ---------------------------------------------------------------------------
 * HOW IT ATTACHES, and why this file is not wired into the streamer at all.
 *
 * `cdn.fetchWorldAsset` is already the one entry point every world asset goes
 * through -- geometry, sidecars, terrain grids, and the collision that
 * `main.ts` fetches on its own 420 m radius. `arm` registers this module as
 * that function's `LocalAssetSource`, so every one of those call sites is
 * served from a bundle with **no call site changed**. Nothing downstream knows
 * regions exist; there is no second place that knows what a tile's URL looks
 * like; and the CDN's health tracking, five-strike rule and per-asset origin
 * fallback are all exactly as they were, because a bundle miss simply returns
 * null and the request goes where it always went.
 *
 * ---------------------------------------------------------------------------
 * THE TRIGGER DISTANCE IS 2,200 m AND THE ASK WAS 500 m. That is not a
 * disagreement about taste, it is arithmetic: **the streamer loads on an
 * 1,800 m radius**. A region triggered at 500 m would be triggered 1,300 m
 * *after* its tiles were already being fetched one at a time, and would save
 * nothing at all -- every asset would have gone out on the per-tile path before
 * the bundle was even asked for.
 *
 * The trigger has to sit outside the load radius by enough lead for the bundle
 * to land before its nearest tile is wanted. 2,200 m gives 400 m of it, and
 * 400 m at the fastest travel in the game -- the tuned e-bike, 39.4 m/s -- is
 * **10.2 seconds**. Measured over the built bundles a region is p50 2.36 MB,
 * p95 5.42 MB and 6.61 MB at worst, which brotli-compresses 3.13x on the way
 * out, so the p95 bundle makes its deadline on **1.4 Mbit/s** and the largest
 * one in the build on 2.2 Mbit/s.
 *
 * Both are well under what travelling at that speed costs anyway: 39.4 m/s
 * across the 3.6 km-wide load disc consumes 0.142 km2 a second, the world is
 * 2.5 MB a square kilometre, so **2.9 Mbit/s is the floor for moving that fast
 * at all** -- bundles or no bundles. The trigger only has to cover latency and
 * burstiness on top of that, and it covers it four times over. Pushed no
 * further because the cost of the trigger is over-fetch and it is quadratic;
 * `sydney/regions.py` has the measured table that picked this number.
 *
 * ---------------------------------------------------------------------------
 * AND YET THERE IS STILL A FAST PATH, because "no realistic connection" is not
 * "no connection", and the failure mode is the one thing this client will not
 * ship: a player standing on collision prisms with no geometry around them --
 * an invisible wall. `world/invisible-walls.ts` exists to detect exactly that.
 *
 * So a tile inside `HOT_M` whose region has not landed is **not** made to wait
 * for the bundle: `asset` returns null for it and the per-tile path fetches it
 * immediately, in parallel with the region that is still coming for its
 * neighbours. The duplicated bytes are bounded by the handful of tiles that can
 * be within 600 m at once, they only happen when the prefetch has genuinely
 * fallen behind, and they buy the guarantee that the ground under the player is
 * never gated behind a multi-megabyte bundle. Everything past that ring waits
 * for the bundle, which is where all the request saving is anyway.
 *
 * ---------------------------------------------------------------------------
 * MEMORY. A region held in memory is many tiles' bytes, so three rules keep it
 * from growing without bound over a long traverse:
 *
 *   1. The buffer is **dropped once its geometry has been handed out** -- every
 *      `tiles/<k>.glb` in it served at least once, checked on the next eviction
 *      pass rather than on the take itself, for the ordering reason `take`
 *      explains. That is the common case and it is what stops the interior of
 *      the load radius accumulating. The unserved `collision/` slices are kept
 *      when the buffer goes, because collision is asked for on a *different*,
 *      later radius (420 m) and losing it would put the geometry and the prisms
 *      back on separate requests -- about 50 kB a region against the megabytes
 *      released.
 *   2. Anything further than the trigger plus `RETAIN_SLACK_M` from the player
 *      is dropped outright, slices and all.
 *   3. A hard byte budget, releasing furthest-first, as the backstop for a
 *      teleport or a spawn that lands mid-prefetch.
 *
 * Everything dropped is re-fetchable: the per-tile files are still published
 * beside the bundles, so a dropped region degrades to the world loading the way
 * it loaded before this file existed.
 */

import { fetchWorldAsset, setLocalAssetSource } from './cdn.ts';

/** `SYDR`, little-endian. **Must match `REGION_MAGIC` in `sydney/regions.py`.** */
const REGION_MAGIC = 0x52445953;

/** The only bundle layout this reads. See `sydney/regions.py`'s header. */
const REGION_VERSION = 1;

/**
 * Inside this distance a tile does not wait for its bundle.
 *
 * 600 m rather than `main.ts`'s 420 m collision radius: the margin is one tile
 * plus a hundred metres, so a tile is on the per-tile fast path *before* the
 * player is close enough to stand on its prisms rather than at the moment they
 * arrive. See the fast-path note in this file's header.
 */
const HOT_M = 600;

/**
 * How far past the trigger a bundle is kept once fetched. The trigger plus one
 * region edge, so a player who stops just outside a region and turns around
 * does not throw away a bundle they are about to want.
 */
const RETAIN_SLACK_M = 1000;

/**
 * The ceiling on resident bundle bytes. Sized against the measurement: the ring
 * between the load radius and the trigger is about 9.5 km2, which at 1 km
 * regions and a p50 of 2.4 MB is ~29 MB of genuinely-wanted prefetch. 64 MB is
 * twice that, so the budget never binds in ordinary play and is purely the
 * backstop for a spawn or a teleport that lands mid-prefetch.
 */
const BUDGET_BYTES = 64 * 1024 * 1024;

/**
 * Bundles the *prefetch* will have in flight at once. Four, matching
 * `TileStreamer.concurrency`, so the bundles coming for tiles the player has
 * not reached never crowd out the requests for the tiles they have. A bundle a
 * tile is actively waiting on is not subject to this -- see `ensure`.
 */
const CONCURRENCY = 4;

/** The index block that turns this on. Structural, so nothing here imports the streamer. */
export interface RegionEntry {
  key: string;
  /** `[minX, minZ, maxX, maxZ]` in world metres, like a tile's. */
  bounds: [number, number, number, number];
  /** Members in the bundle. Reported; nothing reads it. */
  n: number;
  size: number;
}

export interface RegionContract {
  version?: number;
  dir?: string;
  tiles_per_side?: number;
  size_m?: number;
  trigger_m?: number;
  count?: number;
  bytes?: number;
  max_bytes?: number;
  list?: RegionEntry[];
}

export interface RegionIndex {
  regions?: RegionContract;
}

/** Counters for the debug overlay, in the shape `cdnStats` uses. */
export interface RegionStats {
  /** Bundles fetched this session. */
  fetched: number;
  /** Bundle fetches that failed, leaving their tiles on the per-tile path. */
  failed: number;
  /** Assets served out of a resident bundle. */
  served: number;
  /** Assets a resident bundle turned out not to contain. A build defect if > 0. */
  missing: number;
  /** Assets let through to the network because the player was inside `HOT_M`. */
  hot: number;
  /** Bundle buffers released. */
  dropped: number;
  /** Bytes currently held. */
  bytes: number;
  /** Bundles currently held, whole or as retained collision slices. */
  resident: number;
  enabled: boolean;
}

interface Resident {
  entry: RegionEntry;
  /** Member path to `[offset, length]` into `buffer`, while the buffer lives. */
  table: Map<string, [number, number]> | null;
  buffer: ArrayBuffer | null;
  /**
   * Members kept after the buffer went: the unserved `collision/` slices. See
   * rule 1 in this file's header.
   */
  kept: Map<string, ArrayBuffer>;
  /** `tiles/<k>.glb` members not yet handed out. Empty means the buffer can go. */
  pendingGeometry: Set<string>;
  bytes: number;
}

const stats: RegionStats = {
  fetched: 0,
  failed: 0,
  served: 0,
  missing: 0,
  hot: 0,
  dropped: 0,
  bytes: 0,
  resident: 0,
  enabled: false,
};

let contract: RegionContract | null = null;
let baseUrl = '/world';
let version = '';
/** Every region in the build, by key. */
const catalogue = new Map<string, RegionEntry>();
/** Which region covers a given world-relative asset path. Built lazily. */
const owner = new Map<string, string>();
const resident = new Map<string, Resident>();
const inFlight = new Map<string, Promise<Resident | null>>();
let playerX = 0;
let playerZ = 0;
/**
 * Whether `updateRegions` has ever run. Until it has, the player is nowhere --
 * and "nowhere" is Town Hall, which is 5 km from the spawn at Sydney Park. An
 * eviction pass against that would throw away the very bundles a boot at the
 * spawn had just fetched, one frame before the position arrives.
 */
let positioned = false;

/** `?noregions` -- the pre-bundle behaviour, one reload away, for comparing them. */
const params =
  typeof location === 'object' && typeof location.search === 'string'
    ? new URLSearchParams(location.search)
    : new URLSearchParams();
const DISABLED = params.has('noregions');

/** A snapshot for the HUD. Copied, so a caller cannot edit the counters. */
export function regionStats(): RegionStats {
  return { ...stats, resident: resident.size, bytes: residentBytes() };
}

const globalScope = globalThis as unknown as {
  window?: unknown;
  __regions?: () => RegionStats;
};
if (typeof globalScope.window === 'object') {
  globalScope.__regions = regionStats;
}

function residentBytes(): number {
  let total = 0;
  for (const r of resident.values()) {
    total += r.buffer !== null ? r.bytes : 0;
    for (const kept of r.kept.values()) total += kept.byteLength;
  }
  return total;
}

/**
 * The tile key a world-relative asset path belongs to, or null.
 *
 * Parsed rather than looked up, because the alternative is a map with an entry
 * for every file in the world -- 3,928 today and ~25,000 at the 15 km stage --
 * built at boot to answer a question that is two `indexOf` calls. The two
 * shapes are `tiles/<key>.<ext...>` and `collision/<key>.bin`, and they are the
 * only two the pipeline emits per tile.
 */
function tileKeyOf(path: string): string | null {
  if (path.startsWith('tiles/')) {
    const dot = path.indexOf('.', 6);
    return dot < 0 ? null : path.slice(6, dot);
  }
  if (path.startsWith('collision/') && path.endsWith('.bin')) {
    return path.slice(10, path.length - 4);
  }
  return null;
}

/** The region key a tile key belongs to. Mirrors `regions.region_key`. */
function regionKeyOf(tileKey: string, perSide: number): string | null {
  const split = tileKey.indexOf('_', 1);
  if (split <= 0) return null;
  const tx = Number(tileKey.slice(0, split));
  const tz = Number(tileKey.slice(split + 1));
  if (!Number.isInteger(tx) || !Number.isInteger(tz)) return null;
  return `${Math.floor(tx / perSide)}_${Math.floor(tz / perSide)}`;
}

/** Which region covers this asset, memoised. Null for anything not per-tile. */
function regionFor(path: string): RegionEntry | null {
  const cached = owner.get(path);
  if (cached !== undefined) return catalogue.get(cached) ?? null;
  const tile = tileKeyOf(path);
  const perSide = contract?.tiles_per_side ?? 0;
  if (tile === null || perSide <= 0) return null;
  const key = regionKeyOf(tile, perSide);
  if (key === null) return null;
  owner.set(path, key);
  return catalogue.get(key) ?? null;
}

/** Distance from a point to a region's rectangle, zero inside it. */
function distanceTo(bounds: readonly number[], x: number, z: number): number {
  const dx = Math.max(bounds[0] - x, 0, x - bounds[2]);
  const dz = Math.max(bounds[1] - z, 0, z - bounds[3]);
  return Math.hypot(dx, dz);
}

/**
 * Read a bundle's index. Returns null for anything that is not one, which is
 * the same answer as a failed fetch -- see `parse`'s callers.
 *
 * Every length is checked against the buffer before it is read. A truncated
 * bundle is what a publish interrupted mid-upload leaves behind, and trusting
 * its offsets would hand a tile decoder a slice of some other tile's bytes.
 */
function parse(buffer: ArrayBuffer): Map<string, [number, number]> | null {
  if (buffer.byteLength < 16) return null;
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== REGION_MAGIC) return null;
  if (view.getUint32(4, true) !== REGION_VERSION) return null;
  const count = view.getUint32(8, true);
  const nameBytes = view.getUint32(12, true);
  const tableEnd = 16 + count * 12;
  if (tableEnd + nameBytes > buffer.byteLength) return null;

  const names = new Uint8Array(buffer, tableEnd, nameBytes);
  const utf8 = new TextDecoder();
  const table = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const at = 16 + i * 12;
    const nameOffset = view.getUint32(at, true);
    const dataOffset = view.getUint32(at + 4, true);
    const dataLength = view.getUint32(at + 8, true);
    if (nameOffset >= nameBytes) return null;
    if (dataOffset + dataLength > buffer.byteLength) return null;
    let end = nameOffset;
    while (end < nameBytes && names[end] !== 0) end++;
    table.set(utf8.decode(names.subarray(nameOffset, end)), [dataOffset, dataLength]);
  }
  return table;
}

/**
 * Point this module at the world the index describes.
 *
 * Called by `streamer.loadIndex` the moment `index.json` lands, on exactly the
 * terms `armCdn` is: before any other world asset is fetched, so the first tile
 * of the session already goes through a bundle. An index with no `regions`
 * block leaves this off, which is what every world built before this existed
 * has, and what `?noregions` forces.
 */
export function armRegions(index: RegionIndex | null | undefined, base: string, ver: string): void {
  reset();
  baseUrl = base;
  version = ver;
  const block = index?.regions;
  if (DISABLED || !block || block.version !== REGION_VERSION) return;
  if (!block.tiles_per_side || block.tiles_per_side <= 0) return;
  contract = block;
  // `list` is **optional** since the world was cut into hexes. On a segmented
  // world the contract arrives in `root.json` -- version, directory, tiles per
  // side, trigger distance, all the things this module needs before it has seen
  // a single region -- and the entries themselves arrive per hex, through
  // `addRegions`. An empty catalogue is a safe state and not a broken one:
  // `regionFor` finds nothing, `asset` returns null, and every tile takes the
  // per-tile path, which is the world loading the way it loaded before bundles
  // existed. See `world/hexes.ts`.
  for (const entry of block.list ?? []) catalogue.set(entry.key, entry);
  stats.enabled = true;
  setLocalAssetSource(asset);
}

/**
 * Add one hex's region entries to the catalogue.
 *
 * Called by `TileStreamer.loadIndex`'s hex listener as each manifest lands.
 * Idempotent by key, so a hex re-fetched after a failure cannot double-count,
 * and it deliberately does **not** touch `resident` or `inFlight`: a region
 * whose entry arrives late is simply one `updateRegions` had not considered
 * yet, and it is considered on the next frame.
 */
export function addRegions(entries: readonly RegionEntry[] | undefined): void {
  if (!stats.enabled || !entries) return;
  for (const entry of entries) catalogue.set(entry.key, entry);
}

/** Forget everything. Exported for the boot checks, which arm and disarm. */
export function reset(): void {
  contract = null;
  catalogue.clear();
  owner.clear();
  resident.clear();
  inFlight.clear();
  positioned = false;
  stats.enabled = false;
  setLocalAssetSource(null);
}

/**
 * The `LocalAssetSource` handed to `cdn.ts`. Bytes for one asset, or null to
 * mean "the network still has it".
 *
 * The three answers, in the order they are tested:
 *
 *   1. **Resident** -- slice it out and hand it over. No request.
 *   2. **Inside `HOT_M`** -- null, so the per-tile path fetches it now. The
 *      bundle is started anyway, for the neighbours.
 *   3. **In flight, or startable** -- await the bundle. This is where the
 *      request saving comes from: the tile is out towards the 1,800 m edge of
 *      the load radius and has ten seconds of lead, so waiting for the bundle
 *      costs nothing the player can see.
 */
async function asset(path: string): Promise<ArrayBuffer | null> {
  if (!stats.enabled) return null;
  const entry = regionFor(path);
  if (entry === null) return null;

  const held = resident.get(entry.key);
  if (held) {
    const bytes = take(held, path);
    if (bytes !== null) return bytes;
    // Resident but not in it. Either a build whose bundle and tile directory
    // disagree, or -- far more likely -- a member this region already handed
    // out and released. Both go to the network.
    if (held.buffer !== null) stats.missing += 1;
    return null;
  }

  if (distanceTo(entry.bounds, playerX, playerZ) <= HOT_M) {
    stats.hot += 1;
    void ensure(entry.key);
    return null;
  }

  const bundle = await ensure(entry.key);
  if (bundle === null) return null;
  return take(bundle, path);
}

/** One member out of a resident bundle, and the bookkeeping that follows it. */
function take(held: Resident, path: string): ArrayBuffer | null {
  const kept = held.kept.get(path);
  if (kept !== undefined) {
    held.kept.delete(path);
    stats.served += 1;
    return kept;
  }
  if (held.buffer === null || held.table === null) return null;
  const span = held.table.get(path);
  if (span === undefined) return null;
  const bytes = held.buffer.slice(span[0], span[0] + span[1]);
  stats.served += 1;
  held.pendingGeometry.delete(path);
  // **Not released here**, even though this is the moment the bundle has
  // finished its job. `TileStreamer.loadTile` asks for a tile's GLB and its ten
  // sidecars in one `Promise.all`, and a `Promise.all` evaluates its arguments
  // in order -- so the GLB is taken *first*, and releasing on it would drop the
  // buffer out from under the ten calls immediately behind it and send every
  // one of them to the network. That was measured, as ten extra requests per
  // region, on the last tile of each. The release happens on the eviction pass
  // instead, which runs once a frame and therefore always after the whole
  // batch. See `evict`.
  return bytes;
}

/** Drop a bundle's buffer, keeping the collision slices nothing has asked for yet. */
function release(held: Resident): void {
  if (held.buffer === null || held.table === null) return;
  for (const [path, span] of held.table) {
    if (!path.startsWith('collision/')) continue;
    held.kept.set(path, held.buffer.slice(span[0], span[0] + span[1]));
  }
  held.buffer = null;
  held.table = null;
  stats.dropped += 1;
}

/**
 * Fetch a bundle, or hand back the one already in flight.
 *
 * **No queue.** A call that gets here is either the prefetch, which
 * `updateRegions` has already gated to at most `CONCURRENCY` in flight, or a
 * tile that is *waiting* on this bundle right now -- and queueing the second
 * kind behind the first would be putting a tile the streamer wants behind a
 * bundle nobody has asked for. The demand-driven calls are bounded by
 * `TileStreamer.concurrency`, which is 4, so the worst case is the prefetch's
 * four plus a handful.
 */
function ensure(key: string): Promise<Resident | null> {
  const held = resident.get(key);
  if (held) return Promise.resolve(held);
  const flying = inFlight.get(key);
  if (flying) return flying;
  const entry = catalogue.get(key);
  if (!entry) return Promise.resolve(null);

  const job = (async (): Promise<Resident | null> => {
    try {
      const dir = contract?.dir ?? 'regions';
      // Straight through `fetchWorldAsset`, so a bundle is a world asset like
      // any other: the CDN with its probe and its strike counter, the origin
      // when that fails, and the `?v=<built>` suffix on the origin path that
      // keeps the immutability story intact. The `LocalAssetSource` hook cannot
      // recurse here -- `regionFor` returns null for a `regions/` path, because
      // `tileKeyOf` only recognises `tiles/` and `collision/`.
      const resp = await fetchWorldAsset(baseUrl, `${dir}/${key}.bin`, version);
      if (!resp.ok) throw new Error(String(resp.status));
      const buffer = await resp.arrayBuffer();
      const table = parse(buffer);
      if (table === null) throw new Error('not a region bundle');
      const pendingGeometry = new Set<string>();
      for (const path of table.keys()) if (path.endsWith('.glb')) pendingGeometry.add(path);
      const held: Resident = {
        entry,
        table,
        buffer,
        kept: new Map(),
        pendingGeometry,
        bytes: buffer.byteLength,
      };
      resident.set(key, held);
      stats.fetched += 1;
      return held;
    } catch {
      // Counted and forgotten. Every tile in it takes the per-tile path, which
      // is the world loading exactly as it did before bundles existed, and the
      // region is startable again on a later frame.
      stats.failed += 1;
      return null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, job);
  return job;
}

/** Rules 1, 2 and 3: consumed, then distance, then the byte budget. */
function evict(): void {
  if (!positioned) return;
  const retain = (contract?.trigger_m ?? 0) + RETAIN_SLACK_M;
  for (const [key, held] of resident) {
    // Rule 1. Every tile's geometry is out, so the megabytes have done their
    // job; the unserved collision slices are kept because collision is asked
    // for later, on `main.ts`'s own 420 m radius. Deferred to here rather than
    // done in `take` -- see the note there.
    if (held.pendingGeometry.size === 0) release(held);
    // Rule 2. Out of range entirely, buffer and slices alike.
    if (distanceTo(held.entry.bounds, playerX, playerZ) > retain) {
      resident.delete(key);
      if (held.buffer !== null) stats.dropped += 1;
    }
  }
  if (residentBytes() <= BUDGET_BYTES) return;
  const byDistance = [...resident.entries()].sort(
    (a, b) =>
      distanceTo(b[1].entry.bounds, playerX, playerZ) -
      distanceTo(a[1].entry.bounds, playerX, playerZ),
  );
  for (const [, held] of byDistance) {
    if (residentBytes() <= BUDGET_BYTES) break;
    if (held.buffer === null) continue;
    // The buffer goes; the collision slices stay, which is what `release` is
    // for. A region evicted for budget is one the player is furthest from, so
    // its geometry is the least likely thing to be wanted next.
    release(held);
  }
}

/**
 * Called every frame with the player's position. Starts the bundles that are
 * now within trigger distance and drops the ones that are not.
 *
 * A linear pass over the catalogue -- 110 entries today, ~570 at the 15 km
 * stage -- which is the same shape as the streamer's own pass over its tile
 * list and for the same reason: a spatial structure to answer a question this
 * cheap would be a structure to keep in sync for nothing.
 */
export function updateRegions(x: number, z: number): void {
  if (!stats.enabled) return;
  playerX = x;
  playerZ = z;
  positioned = true;
  const trigger = contract?.trigger_m ?? 0;
  if (trigger > 0 && inFlight.size < CONCURRENCY) {
    // Nearest first, so the bundle under the player's feet never queues behind
    // one at the far edge of the trigger ring.
    let best: RegionEntry | null = null;
    let bestDistance = Infinity;
    for (const entry of catalogue.values()) {
      if (resident.has(entry.key) || inFlight.has(entry.key)) continue;
      const d = distanceTo(entry.bounds, x, z);
      if (d <= trigger && d < bestDistance) {
        bestDistance = d;
        best = entry;
      }
    }
    if (best !== null) void ensure(best.key);
  }
  evict();
}

/**
 * Boot check: the bundle format, the ownership arithmetic, and the fallback.
 *
 * What is worth checking here is the half of a two-repo contract this file
 * cannot see the other side of, plus the two pieces of arithmetic whose failure
 * is silent rather than loud:
 *
 *   - **which region owns a tile**, because floor division and truncation agree
 *     on the positive half of the grid and disagree on the negative one, and
 *     Town Hall is at the origin. Getting it wrong means every asset west or
 *     north of the CBD is looked for in the wrong bundle, found to be missing,
 *     and quietly fetched one by one -- the world still loads, and the only
 *     symptom is the request count this module exists to remove;
 *   - **that a miss falls back**, because the alternative to falling back is a
 *     hole in the city.
 *
 * Never throws, and returns a list of failures like every other check here.
 */
export function verifyRegions(): string[] {
  const failures: string[] = [];

  // --- 1. Which region owns a tile, across the origin in both axes.
  const cases: Array<[string, number, string]> = [
    ['0_0', 2, '0_0'],
    ['1_1', 2, '0_0'],
    ['2_0', 2, '1_0'],
    ['-1_-1', 2, '-1_-1'],
    ['-2_-2', 2, '-1_-1'],
    ['-3_4', 2, '-2_2'],
    ['-10_-1', 2, '-5_-1'],
    ['5_-7', 3, '1_-3'],
  ];
  for (const [tile, perSide, want] of cases) {
    const got = regionKeyOf(tile, perSide);
    if (got !== want) failures.push(`region for tile ${tile} at ${perSide}x: expected ${want}, got ${got}`);
  }

  // --- 2. The path parse, against the paths the client actually builds.
  const paths: Array<[string, string | null]> = [
    ['tiles/-5_9.glb', '-5_9'],
    ['tiles/-5_9.params.bin', '-5_9'],
    ['tiles/12_-3.water.bin', '12_-3'],
    ['collision/-5_9.bin', '-5_9'],
    ['regions/-2_2.bin', null],
    ['suburbs.json', null],
    ['far.bin', null],
    ['landmarks.glb', null],
    ['street-names.bin', null],
  ];
  for (const [path, want] of paths) {
    const got = tileKeyOf(path);
    if (got !== want) failures.push(`tileKeyOf(${path}): expected ${want}, got ${got}`);
  }

  // --- 3. A synthetic bundle, round-tripped. The format is written in Python
  // and read here, and nothing else in the build compares the two halves.
  const members: Array<[string, Uint8Array]> = [
    ['collision/3_4.bin', new Uint8Array([1, 2, 3])],
    ['tiles/3_4.glb', new Uint8Array([9, 8, 7, 6, 5])],
    ['tiles/3_4.params.bin', new Uint8Array([4])],
  ];
  const bundle = packSyntheticRegion(members);
  const table = parse(bundle);
  if (table === null) {
    failures.push('a well-formed bundle failed to parse');
  } else {
    if (table.size !== members.length) {
      failures.push(`bundle held ${table.size} members, expected ${members.length}`);
    }
    for (const [path, want] of members) {
      const span = table.get(path);
      if (!span) {
        failures.push(`bundle lost member ${path}`);
        continue;
      }
      const got = new Uint8Array(bundle, span[0], span[1]);
      if (got.length !== want.length || got.some((b, i) => b !== want[i])) {
        failures.push(`bundle member ${path} came back as ${[...got]}, expected ${[...want]}`);
      }
    }
  }

  // --- 4. Truncation and corruption are refused rather than trusted.
  if (parse(bundle.slice(0, 8)) !== null) failures.push('a truncated bundle parsed');
  const wrongMagic = bundle.slice(0);
  new DataView(wrongMagic).setUint32(0, 0xdeadbeef, true);
  if (parse(wrongMagic) !== null) failures.push('a bundle with the wrong magic parsed');
  const wrongVersion = bundle.slice(0);
  new DataView(wrongVersion).setUint32(4, REGION_VERSION + 1, true);
  if (parse(wrongVersion) !== null) failures.push('a bundle from a future pipeline parsed');

  return failures;
}

/** `regions._pack`, in miniature, for `verifyRegions` only. */
function packSyntheticRegion(members: Array<[string, Uint8Array]>): ArrayBuffer {
  const sorted = [...members].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const encoder = new TextEncoder();
  const names: number[] = [];
  const nameOffsets: number[] = [];
  for (const [path] of sorted) {
    nameOffsets.push(names.length);
    for (const b of encoder.encode(path)) names.push(b);
    names.push(0);
  }
  while (names.length % 4) names.push(0);

  const header = 16 + sorted.length * 12;
  const payload: number[] = [];
  const spans: Array<[number, number]> = [];
  for (const [, data] of sorted) {
    while (payload.length % 4) payload.push(0);
    spans.push([header + names.length + payload.length, data.length]);
    for (const b of data) payload.push(b);
  }

  const out = new ArrayBuffer(header + names.length + payload.length);
  const view = new DataView(out);
  const bytes = new Uint8Array(out);
  view.setUint32(0, REGION_MAGIC, true);
  view.setUint32(4, REGION_VERSION, true);
  view.setUint32(8, sorted.length, true);
  view.setUint32(12, names.length, true);
  for (let i = 0; i < sorted.length; i++) {
    view.setUint32(16 + i * 12, nameOffsets[i], true);
    view.setUint32(16 + i * 12 + 4, spans[i][0], true);
    view.setUint32(16 + i * 12 + 8, spans[i][1], true);
  }
  bytes.set(new Uint8Array(names), header);
  bytes.set(new Uint8Array(payload), header + names.length);
  return out;
}
