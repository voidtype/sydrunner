/**
 * Hexagonal segments: the part of the world's table of contents you are
 * standing near, instead of all of it.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM IS THE THREE WHOLE-WORLD FILES, and it is a boot problem rather
 * than a streaming one. Measured against the shipped 19.3 km build:
 *
 *     index.json         851 kB   fetched **uncached every session**; it is the
 *                                 version pivot, so it cannot be cached behind
 *                                 the version it names
 *     street-names.bin  2.46 MB   one request on the first press of `M`
 *     far.bin           3.08 MB   loaded at boot and never evicted
 *
 * Every one of them grows linearly with the map. `EXPANSION.md` measures the
 * 60 km world at ~22,000 emitted tiles, which is roughly 7x each: ~5 MB of
 * table of contents before the player sees anything, ~15 MB of street names on
 * one keypress, ~20 MB of skyline held for the session. None of that is
 * geometry and none of it is optional under the old packaging.
 *
 * So the world is cut into **hexagons** -- `pipeline/sydney/hexes.py` has the
 * geometry and the argument -- and each of those three files is cut with it:
 *
 *     root.json                  8.6 kB   the boot pivot, and flat in the map
 *     hexes/<id>.json          ~85 kB     one hex's tiles and regions
 *     hexes/<id>.names.bin    ~300 kB     one hex's centrelines, for the map
 *     hexes/<id>.far.bin      ~300 kB     one hex's skyline
 *
 * A player who never leaves the inner city fetches the root and one or two
 * hexes. A player who rides to Penrith fetches them one at a time as they get
 * there, and the numbers above do not move.
 *
 * ---------------------------------------------------------------------------
 * HEXES SIT ABOVE REGIONS. THEY DO NOT REPLACE THEM.
 *
 * A region bundle (`world/regions.ts`) is one square kilometre of tile
 * *payloads* packed into one request; a hex is the manifest that says those
 * tiles and those regions exist at all. The two nest exactly -- a region's
 * centre puts it in exactly one hex -- and they load on different distances for
 * different reasons: a region is 2.4 MB of bytes the streamer would otherwise
 * fetch a thousand at a time, a hex is 85 kB of JSON without which the streamer
 * does not know there is anything there to fetch.
 *
 * That is why this module is arm-and-update in the same shape as `regions.ts`
 * and is called from the same two places in `TileStreamer`, and why it hands
 * its region entries *to* that module rather than doing anything with them.
 *
 * ---------------------------------------------------------------------------
 * THE APPROACH RULE, which is the only interesting decision in this file.
 *
 * A hex is fetched when the player comes within `approach_m` of **the hexagon
 * itself** -- not its centre and not its bounding box. Distance to the centre
 * would be wrong by up to `circumradius - apothem` = 804 m depending on which
 * way the boundary happened to face; distance to the box would over-fetch the
 * corners, which is the same defect a square grid's diagonal neighbours have
 * and one of the three reasons the segment is a hexagon in the first place.
 * Distance to a convex hexagon is six segment distances and a containment test,
 * which is nothing at 16 hexes today and ~70 at 60 km.
 *
 * **Why 4,000 m** is `hexes.APPROACH_M` in the pipeline, which ships it in the
 * contract so there is one number rather than two. In short: 1,800 m is the
 * correctness floor because that is `TileStreamer.loadRadius` and a tile inside
 * it is inside a hex within 1,800 m; the extra 2,200 m is arrival lead, worth
 * 56 seconds at the fastest travel in the game, and it is five times the lead
 * the region bundles take because the failure it buys off is categorically
 * worse. A late region is a tile that loads the slow way. A late hex is a tile
 * the client does not know exists -- ground the player can walk onto with
 * nothing on it, which is the one thing this client will not ship. That is what
 * `world/invisible-walls.ts` measures and what the boundary-traverse check in
 * `server/integration-check.ts` holds at zero.
 *
 * Because a hexagon has **six equidistant neighbours**, "the ring around me" is
 * one distance rather than two: at a hex centre the player is 5,196 m from
 * every neighbour and holds one manifest; at a corner they are touching three
 * and hold three. There is no diagonal to tune.
 *
 * ---------------------------------------------------------------------------
 * NOTHING IS EVER UNLOADED, and that is deliberate.
 *
 * A hex manifest is 85 kB of entries the streamer keeps in one array. Dropping
 * them would mean a tile list that shrinks under the player, an `index.tiles`
 * that different subsystems disagree about, and a re-fetch every time somebody
 * walks back over a boundary. At 60 km a player who visited every hex in one
 * session would hold ~6 MB of manifest, which is two tiles' worth of geometry.
 * The far layer is the one thing here with a real byte cost and it *is* evicted
 * -- see `world/far.ts` and `far_cut_m`.
 *
 * ---------------------------------------------------------------------------
 * FRAMES. There is **one frame here and no conversion**, which is the opposite
 * of what this file said when it shipped, and the difference was a hole in the
 * world.
 *
 * A hex's `c` and `bounds` are in the same frame as `index.json`'s tile bounds,
 * because the pipeline computes both from the same tile coordinates: `h+00+01`
 * spans `z 5196..15588` and the tiles it lists span `z 5000..15500`. That frame
 * is the renderer's -- the streamer compares `camera.z` straight against a
 * tile's bounds -- so a player's `(x, z)` is directly comparable to a hexagon's
 * and must not be flipped.
 *
 * The original `toEnu` negated `z` on the way in, which mirrored every hexagon
 * about `z = 0`. A player 686 m from `h-01+01` was told they were 4,571 m from
 * `h-01+00`, so the manifest for the ground they were about to walk onto was
 * never fetched: 25 of the 56 tiles inside the load radius at the Sydney Park
 * spawn, and a wanted-but-unasked tile at 844 of 1,912 positions swept across
 * the world. Those tiles never entered the streamer's index, so they never
 * loaded -- no ground, no buildings -- while the far layer kept drawing their
 * skyline slabs, because a slab is only hidden when its own tile is resident.
 * On screen: a void chasm ringed by hundred-metre grey boxes.
 *
 * It survived its own boot check because the check probed the coverage rule
 * through the same negation it was testing, so the sign cancelled. The guard
 * that actually holds this down now runs against the real manifests and the
 * real tile bounds -- `checkHexCoverage` in `server/integration-check.ts`.
 *
 * DEV TOGGLE: `?nohex` ignores the hex contract entirely and loads `index.json`
 * whole, which is the pre-segmentation client, one reload away, for comparing
 * the two.
 */

import { fetchWorldAsset } from './cdn.ts';

/** Bumped in `sydney/hexes.py` when the manifest layout changes. */
const HEX_VERSION = 1;

/**
 * How many manifests may be in flight at once.
 *
 * Four, matching `regions.CONCURRENCY` and `TileStreamer.concurrency`, because
 * these share a connection pool with both. A manifest is small enough that the
 * limit almost never binds -- it binds exactly once, on a teleport into an
 * unvisited part of the map, which is the case it exists for.
 */
const CONCURRENCY = 4;

/** One hexagon, as the root index lists it. See `sydney/hexes.py`. */
export interface HexEntry {
  /** `h-01+01`: axial (q, r), signed and zero-padded. Stable for ever. */
  id: string;
  q: number;
  r: number;
  /** Centre in ENU metres, `[east, north]`. */
  c: [number, number];
  /** The hexagon's axis-aligned box in ENU metres, `[minE, minN, maxE, maxN]`. */
  bounds: [number, number, number, number];
  /** Emitted tiles in it. Zero hexes are not listed at all. */
  tiles: number;
  regions: number;
  index_bytes: number;
  /** Bytes of `hexes/<id>.names.bin`, absent when the hex has no named street. */
  names?: number;
  /** The far contract for `hexes/<id>.far.bin`, absent when it has no slabs. */
  far?: { count: number; plan_verts: number; bytes: number };
  /** Tile and region payload bytes, for publish planning. Not fetched by anything. */
  bytes: number;
}

/** The `hexes` block in `root.json`. */
export interface HexContract {
  version: number;
  /** Where the manifests live. `hexes`. */
  dir: string;
  circumradius_m: number;
  /** Centre-to-centre of all six neighbours, `sqrt(3) * circumradius`. */
  neighbour_m: number;
  /** How close the player gets before a manifest is fetched. See the header. */
  approach_m: number;
  /** How far a hex's far-layer slabs are worth carrying. See `world/far.ts`. */
  far_cut_m: number;
  count: number;
  list: HexEntry[];
}

/** The index fields this reads. Structural, so nothing here imports the streamer. */
export interface HexIndex {
  hexes?: HexContract;
}

/** One hex's manifest: the entries `index.json` used to carry for its tiles. */
export interface HexManifest {
  v: number;
  id: string;
  tile_size: number;
  tiles: HexTileEntry[];
  regions: HexRegionEntry[];
}

/**
 * A tile entry, as loose as `streamer.TileEntry` needs it to be.
 *
 * Deliberately not an import of `TileEntry`: this module is compiled into the
 * Bun server through `server/integration-check.ts`, and `streamer.ts` carries
 * `three`. The manifest is passed through verbatim, so a field added to the
 * pipeline's index entry arrives at the streamer without this file knowing.
 */
export interface HexTileEntry {
  key: string;
  bounds: [number, number, number, number];
  [k: string]: unknown;
}

export interface HexRegionEntry {
  key: string;
  bounds: [number, number, number, number];
  /** Members in the bundle, and its size in bytes. See `regions.RegionEntry`. */
  n: number;
  size: number;
}

/** Counters for the debug overlay and the checks. */
export interface HexStats {
  enabled: boolean;
  /** Manifests that have landed. */
  resident: number;
  /** Manifests in flight right now. */
  inFlight: number;
  /** Tiles the streamer knows about because a manifest brought them. */
  tiles: number;
  /** Manifest fetches that failed and will be retried. */
  failed: number;
  /** Hexes in the catalogue at all. */
  known: number;
}

const catalogue = new Map<string, HexEntry>();
const resident = new Map<string, HexManifest>();
const inFlight = new Map<string, Promise<HexManifest | null>>();
const failures = new Map<string, number>();
let contract: HexContract | null = null;
let baseUrl = '/world';
let version = '';
let armed = false;
let tileCount = 0;

/** Called with each manifest as it lands, in the order the manifests land. */
export type HexListener = (manifest: HexManifest, entry: HexEntry) => void;
const listeners: HexListener[] = [];

/**
 * `?nohex` -- read once, guarded because this module is compiled into the Bun
 * server where `location` does not exist, on `cdn.ts`'s argument.
 */
const DISABLED =
  typeof location === 'object' && typeof location.search === 'string'
    ? new URLSearchParams(location.search).has('nohex')
    : false;

/** Is this world segmented at all? False for every build before this pass. */
export function hexesArmed(): boolean {
  return armed;
}

/** The contract, for the two callers that need a distance out of it. */
export function hexContract(): HexContract | null {
  return contract;
}

// There is deliberately no frame conversion in this file. A hexagon's `c` and
// `bounds` are already in the frame the player's `(x, z)` is in -- see FRAMES at
// the top, and the hole in the world that the conversion which used to live here
// put in front of players.

/**
 * The six corners of a hexagon, ENU metres, anticlockwise from due east.
 *
 * Derived from the entry's centre and the contract's circumradius rather than
 * from an axial-to-pixel formula repeated on this side of the wire. The client
 * therefore has **no model of the grid at all**: it cannot disagree with the
 * pipeline about where a hex is, and a build that changed the circumradius
 * would move these without a client change. `sydney/hexes.py::corners_of` is
 * the other half and produces the same six points.
 */
function corners(entry: HexEntry, radius: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i;
    out.push(entry.c[0] + radius * Math.cos(a), entry.c[1] + radius * Math.sin(a));
  }
  return out;
}

/** Squared distance from a point to a segment. `streetnames.ts`'s inner loop. */
function segmentDistance2(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): number {
  const ex = bx - ax;
  const ey = by - ay;
  const len2 = ex * ex + ey * ey;
  let t = 0;
  if (len2 > 1e-12) {
    t = ((px - ax) * ex + (py - ay) * ey) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const dx = px - (ax + ex * t);
  const dy = py - (ay + ey * t);
  return dx * dx + dy * dy;
}

/**
 * Distance from a point in **renderer** metres to a hexagon, zero inside it.
 *
 * The bounding box is tested first and is a pure saving: a point outside the
 * box is outside the hexagon, and the box rejects every hex in the catalogue
 * but the handful nearby on four compares. When the box does not reject, the
 * six edges are measured exactly.
 *
 * The containment test is six cross products, and it is deliberately **agnostic
 * about the ring's winding**: inside means they all share a sign, rather than
 * all being non-negative. `corners` walks the six angles with `+sin`, so which
 * way the ring turns depends on which way the second axis points -- and hard-
 * coding "anticlockwise" is half of the bug this replaces. A hexagon is convex
 * either way, so one extra sign test buys immunity to the whole question.
 *
 * Exported because `world/far.ts` and `mapatlas.ts` both ask the same question
 * on different distances, and two copies of a hexagon's geometry is exactly the
 * duplication this file exists to avoid.
 */
export function hexDistance(entry: HexEntry, x: number, z: number): number {
  const radius = contract?.circumradius_m ?? 0;
  const b = entry.bounds;
  const bx = Math.max(b[0] - x, 0, x - b[2]);
  const bz = Math.max(b[1] - z, 0, z - b[3]);
  if (bx > 0 || bz > 0) {
    const boxDistance = Math.hypot(bx, bz);
    // The box is inscribed *around* the hexagon, so its distance is a lower
    // bound and never an answer. Fall through to the edges whenever the point
    // is close enough for the difference to matter to any caller.
    if (boxDistance > radius) return boxDistance;
  }
  const pts = corners(entry, radius);
  let positive = 0;
  let negative = 0;
  let best = Infinity;
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const ax = pts[i * 2];
    const ay = pts[i * 2 + 1];
    const cx = pts[j * 2];
    const cy = pts[j * 2 + 1];
    const cross = (cx - ax) * (z - ay) - (cy - ay) * (x - ax);
    if (cross > 0) positive++;
    else if (cross < 0) negative++;
    const d2 = segmentDistance2(ax, ay, cx, cy, x, z);
    if (d2 < best) best = d2;
  }
  return positive === 0 || negative === 0 ? 0 : Math.sqrt(best);
}

/**
 * Point this module at the world the root index describes.
 *
 * Called by `streamer.loadIndex` on exactly `armCdn`'s and `armRegions`' terms:
 * before any other world asset is fetched, so the first tile of the session
 * already comes out of a manifest. A root index with no `hexes` block leaves
 * this off, which is what every world built before this existed has and what
 * `?nohex` forces -- and in that state the streamer reads `index.json` whole,
 * exactly as it always did.
 */
export function armHexes(index: HexIndex | null | undefined, base: string, ver: string): void {
  resetHexes();
  baseUrl = base;
  version = ver;
  if (!hexesUsable(index)) return;
  const block = index?.hexes as HexContract;
  contract = block;
  for (const entry of block.list) catalogue.set(entry.id, entry);
  armed = true;
}

/**
 * Would `armHexes` arm on this index?
 *
 * Split out because **`TileStreamer.loadIndex` has to know before it commits**:
 * a segmented root index carries no tile list, so a client that booted from one
 * and then failed to arm -- `?nohex`, a contract from a future pipeline, a
 * circumradius of zero -- would hold a world with no tiles in it and no way to
 * get any. The streamer asks this first and falls back to `index.json` whole
 * when the answer is no, which is what makes `?nohex` mean "the pre-
 * segmentation client" rather than "an empty world".
 *
 * The same predicate both callers use, rather than two lists of conditions that
 * have to be kept in step.
 */
export function hexesUsable(index: HexIndex | null | undefined): boolean {
  const block = index?.hexes;
  if (DISABLED || !block?.list?.length || block.version !== HEX_VERSION) return false;
  return block.circumradius_m > 0 && block.approach_m > 0;
}

/** Forget everything. Exported for the boot checks, which arm and disarm. */
export function resetHexes(): void {
  contract = null;
  armed = false;
  tileCount = 0;
  catalogue.clear();
  resident.clear();
  inFlight.clear();
  failures.clear();
  listeners.length = 0;
}

/**
 * Be told about every manifest, as it lands.
 *
 * The whole of this module's outward API, and a subscription rather than a
 * return value because the manifests arrive over minutes of play rather than at
 * boot. Four things listen: `TileStreamer` appends the tiles to `index.tiles`,
 * `regions.ts` takes the region entries, and `main.ts` folds the wet tiles into
 * `WaterLevels` and the new tiles into the offline bike plan. Every one of them
 * was previously a single pass over the whole index at boot, and every one of
 * them is now that same pass run once per hex.
 *
 * A listener registered after a manifest has already landed is caught up
 * immediately, because boot order is not something a subscriber should have to
 * reason about -- `setFarCity` makes the same promise for the same reason.
 */
export function onHexTiles(listener: HexListener): void {
  listeners.push(listener);
  for (const [id, manifest] of resident) {
    const entry = catalogue.get(id);
    if (entry) listener(manifest, entry);
  }
}

/**
 * Fetch one manifest, or hand back the one already in flight.
 *
 * A failure is counted and forgotten rather than remembered as permanent: the
 * hex is startable again on the next frame that finds it in range, on
 * `TileRetryLedger`'s argument. A hex that never loads is a part of the map the
 * player cannot reach, which is bad; a hex that gives up after one flaky
 * request is a part of the map they can *never* reach, which is worse.
 */
export function ensureHex(id: string): Promise<HexManifest | null> {
  const held = resident.get(id);
  if (held) return Promise.resolve(held);
  const flying = inFlight.get(id);
  if (flying) return flying;
  const entry = catalogue.get(id);
  if (!entry || !contract) return Promise.resolve(null);

  const job = (async (): Promise<HexManifest | null> => {
    try {
      // Straight through `fetchWorldAsset`, so a manifest is a world asset like
      // any other: the CDN with its probe and its strike counter, the origin
      // when that fails, and the `?v=<built>` suffix that keeps the
      // immutability story intact. A manifest is immutable for a given build,
      // which is exactly what the root index is *not* -- see `world/version.ts`
      // on why the pivot is the one file that carries no suffix.
      const resp = await fetchWorldAsset(baseUrl, `${contract.dir}/${id}.json`, version);
      if (!resp.ok) throw new Error(String(resp.status));
      const manifest = (await resp.json()) as HexManifest;
      if (manifest?.v !== HEX_VERSION || !Array.isArray(manifest.tiles)) {
        throw new Error('not a hex manifest');
      }
      resident.set(id, manifest);
      failures.delete(id);
      tileCount += manifest.tiles.length;
      for (const listener of listeners) listener(manifest, entry);
      return manifest;
    } catch {
      failures.set(id, (failures.get(id) ?? 0) + 1);
      return null;
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, job);
  return job;
}

/**
 * Every hex within `approach_m` of a point, nearest first.
 *
 * Nearest first for `updateRegions`' reason: the manifest under the player's
 * feet must never queue behind one at the far edge of the ring.
 */
export function hexesNear(x: number, z: number, approach?: number): HexEntry[] {
  if (!armed || !contract) return [];
  const reach = approach ?? contract.approach_m;
  const out: Array<[number, HexEntry]> = [];
  for (const entry of catalogue.values()) {
    const d = hexDistance(entry, x, z);
    if (d <= reach) out.push([d, entry]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.map((pair) => pair[1]);
}

/**
 * Every hex whose hexagon overlaps a **renderer-frame** box, for the big map.
 *
 * The map draws its roads out of the street-name centrelines, so it needs the
 * hexes it can currently see and no others. Its widest zoom is 9 km across,
 * which is two to four hexes wherever the player stands and stays two to four
 * hexes when the world is 60 km wide -- see `mapatlas.ts`.
 *
 * The test is against the bounding box rather than the hexagon, and that is the
 * right way round for this caller: a box that clips a hexagon's corner without
 * touching the hexagon is a hex the map does not strictly need, and fetching
 * one extra manifest is cheaper than a label missing off the edge of the view.
 */
export function hexesInBox(minX: number, minZ: number, maxX: number, maxZ: number): HexEntry[] {
  if (!armed) return [];
  // No inversion: `mapatlas.ensureHexNames` passes the view box in the same
  // frame a hexagon's bounds are in. This used to flip z, which fetched the
  // hexagons mirrored about z = 0 -- the big map drew streets near the origin
  // (where the mirror happens to land inside the same hexagon) and none further
  // out. Same root cause as `hexDistance`; see FRAMES at the top.
  const out: HexEntry[] = [];
  for (const entry of catalogue.values()) {
    const b = entry.bounds;
    if (b[2] < minX || b[0] > maxX || b[3] < minZ || b[1] > maxZ) continue;
    out.push(entry);
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

/**
 * Start the manifests now in range, at most `CONCURRENCY` at a time.
 *
 * Called every frame from `TileStreamer.update`, immediately before
 * `updateRegions` and for a reason worth stating: a hex started this frame
 * cannot have landed by the time the tile pass runs, and it is not meant to.
 * The 2,200 m of lead outside the load radius is what makes it early rather
 * than late, and the ordering here only guarantees that a teleport is acted on
 * in the frame it happens rather than the frame after.
 */
export function updateHexes(x: number, z: number): void {
  if (!armed || inFlight.size >= CONCURRENCY) return;
  for (const entry of hexesNear(x, z)) {
    if (resident.has(entry.id) || inFlight.has(entry.id)) continue;
    void ensureHex(entry.id);
    if (inFlight.size >= CONCURRENCY) return;
  }
}

/**
 * Await every manifest in range of a point.
 *
 * The boot path, and the one place a hex is *waited* for. `main.ts` places the
 * player by searching `index.tiles` for buildable ground, loads the collision
 * and terrain under the spawn, and picks a point that is not inside a warehouse
 * or a pond -- every one of which answers "no" against an empty tile list. So
 * the spawn's own hexes are awaited before that runs, and nothing else ever is.
 *
 * Resolves when they have all settled, including the ones that failed: a hex
 * that will not load must not hold the boot open, because the world minus one
 * hex still starts and the alternative is a client that never gets past the
 * loading screen because of a flaky 90 kB request.
 */
export async function ensureHexesNear(x: number, z: number, approach?: number): Promise<void> {
  if (!armed) return;
  await Promise.all(hexesNear(x, z, approach).map((entry) => ensureHex(entry.id)));
}

/**
 * Boot check: the frame conversion, the approach rule's coverage guarantee, and
 * the id contract.
 *
 * What is worth checking here is the half of a two-language contract this file
 * cannot see the other side of, and the one piece of arithmetic whose failure
 * is silent rather than loud.
 *
 *   - **The frame**, because `z = -north` applied once too often files the
 *     player in the hex mirrored about the harbour, and the symptom is a world
 *     that loads perfectly everywhere except that the manifests arrive for
 *     somewhere else.
 *   - **The coverage guarantee**, because the approach rule is the only thing
 *     standing between the player and ground with nothing on it. The property
 *     is stated as: *any point within `TileStreamer.loadRadius` of the player
 *     lies in a hex the rule has already asked for.* It is checked by brute
 *     force over a grid of player positions and offsets rather than argued,
 *     because an off-by-one in a margin here is a hole in the city.
 *   - **The distance function's agreement with itself**: zero inside, exact on
 *     the boundary, and monotone going out.
 *
 * Never throws, and returns a list of failures like every other check here.
 */
export function verifyHexes(): string[] {
  const failures: string[] = [];
  const R = 6000;
  const S3 = Math.sqrt(3);

  // Everything, snapshotted. `verifyStreaming` runs this **after** `loadIndex`
  // on a live client, so a check that armed a synthetic grid and walked away
  // would leave the session holding a nine-by-nine lattice of hexes that do not
  // exist and no manifests at all.
  const saved = {
    contract,
    armed,
    tileCount,
    catalogue: [...catalogue.entries()],
    resident: [...resident.entries()],
    inFlight: [...inFlight.entries()],
    listeners: [...listeners],
  };

  /** The pipeline's `centre_of` and `hex_id`, for building a synthetic grid. */
  const centreOf = (q: number, r: number): [number, number] => [
    1.5 * R * q,
    S3 * R * (q / 2 + r),
  ];
  const idOf = (q: number, r: number): string =>
    `h${q < 0 ? '-' : '+'}${String(Math.abs(q)).padStart(2, '0')}${r < 0 ? '-' : '+'}${String(Math.abs(r)).padStart(2, '0')}`;
  /** The pipeline's `axial_of`: flat-top pixel-to-hex plus a cube round. */
  const axialOf = (e: number, n: number): [number, number] => {
    const fq = ((2 / 3) * e) / R;
    const fr = (-e / 3 + (S3 / 3) * n) / R;
    const fs = -fq - fr;
    let q = Math.round(fq);
    let r = Math.round(fr);
    const s = Math.round(fs);
    const dq = Math.abs(q - fq);
    const dr = Math.abs(r - fr);
    const ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return [q, r];
  };

  const list: HexEntry[] = [];
  for (let q = -4; q <= 4; q++) {
    for (let r = -4; r <= 4; r++) {
      const c = centreOf(q, r);
      list.push({
        id: idOf(q, r),
        q,
        r,
        c,
        bounds: [c[0] - R, c[1] - (S3 / 2) * R, c[0] + R, c[1] + (S3 / 2) * R],
        tiles: 1,
        regions: 0,
        index_bytes: 0,
        bytes: 0,
      });
    }
  }
  const approach = 4000;
  armHexes(
    {
      hexes: {
        version: HEX_VERSION,
        dir: 'hexes',
        circumradius_m: R,
        neighbour_m: S3 * R,
        approach_m: approach,
        far_cut_m: 20000,
        count: list.length,
        list,
      },
    },
    '/world',
    '',
  );
  if (!armed) failures.push('a well-formed hex contract did not arm');

  const byId = new Map(list.map((e) => [e.id, e]));

  // --- 1. The id is a pure function of the centre, at both signs and across
  // the origin. This is the property that lets a 60 km build reuse a 19.3 km
  // client's cache, and it is the only thing in this file that must never
  // change.
  for (const entry of list) {
    const [q, r] = axialOf(entry.c[0], entry.c[1]);
    if (idOf(q, r) !== entry.id) {
      failures.push(`hex centre ${entry.c} rounded to ${idOf(q, r)}, not ${entry.id}`);
      break;
    }
  }
  if (idOf(0, 0) !== 'h+00+00') failures.push(`idOf(0,0) is ${idOf(0, 0)}`);
  if (idOf(-1, 1) !== 'h-01+01') failures.push(`idOf(-1,1) is ${idOf(-1, 1)}`);

  // --- 2. The frame. A point due **north** of the origin is at negative z in
  // the renderer, and must land in the hex the pipeline would file it under.
  {
    const north = 5000;
    const [q, r] = axialOf(0, north);
    const want = byId.get(idOf(q, r));
    const got = hexesNear(0, -north, 1).map((e) => e.id);
    if (!want || !got.includes(want.id)) {
      failures.push(`a point 5 km north sits in ${want?.id}, but the rule found [${got}]`);
    }
    // And the mirror: the *same* renderer z with the sign flipped must not.
    const mirrored = hexesNear(0, north, 1).map((e) => e.id);
    if (want && mirrored.includes(want.id) && want.id !== idOf(0, 0)) {
      failures.push('a point 5 km south was filed in the hex 5 km north of the origin');
    }
  }

  // --- 3. Distance: zero inside, zero on the boundary, and the corner is
  // exactly `circumradius` from the centre.
  {
    const home = byId.get('h+00+00') as HexEntry;
    if (hexDistance(home, 0, 0) !== 0) failures.push('the centre of a hex is not inside it');
    if (hexDistance(home, R - 1, 0) !== 0) failures.push('a point just inside the +east vertex is outside');
    const out = hexDistance(home, R + 1000, 0);
    if (Math.abs(out - 1000) > 1) failures.push(`1,000 m past the +east vertex measured ${out.toFixed(1)} m`);
    // Due north of the centre the boundary is the apothem, not the circumradius.
    const apothem = (S3 / 2) * R;
    const northOut = hexDistance(home, 0, -(apothem + 500));
    if (Math.abs(northOut - 500) > 1) {
      failures.push(`500 m past the north edge measured ${northOut.toFixed(1)} m`);
    }
  }

  // --- 4. THE COVERAGE GUARANTEE. Every point the streamer could want a tile
  // at -- anywhere inside `loadRadius` -- must be inside a hex the approach
  // rule has already asked for at that player position. Brute force over player
  // positions spread across a hexagon and its boundary, and offsets around the
  // whole load disc, because this is the property whose failure is a hole in
  // the world and an argument is not evidence.
  {
    const loadRadius = 1800;
    let worst = '';
    for (let px = -R; px <= R && !worst; px += 400) {
      for (let pz = -R; pz <= R && !worst; pz += 400) {
        const asked = new Set(hexesNear(px, pz).map((e) => e.id));
        for (let a = 0; a < 32 && !worst; a++) {
          const th = (a / 32) * Math.PI * 2;
          // The far corner of a 500 m tile whose centre is at the load radius:
          // the streamer wants a tile whose *bounds* reach that far, so the
          // point that has to be covered is the tile centre, which is at most
          // half a diagonal beyond it.
          const reach = loadRadius + 354;
          const tx = px + Math.cos(th) * reach;
          const tz = pz + Math.sin(th) * reach;
          const [q, r] = axialOf(tx, tz);
          const owner = idOf(q, r);
          // Only hexes the synthetic grid actually holds; the ring at q,r = +/-4
          // has neighbours outside it that no rule could ask for.
          if (!byId.has(owner)) continue;
          if (!asked.has(owner)) {
            worst = `at (${px}, ${pz}) a tile ${reach} m away is in ${owner}, which was not asked for`;
          }
        }
      }
    }
    if (worst) failures.push(worst);
  }

  // --- 5. The approach ring is bounded. A player at a hex centre holds one
  // manifest and a player at a corner holds three -- the property that makes
  // "the ring around me" one rule, and the number that decides what a session
  // costs.
  {
    const atCentre = hexesNear(0, 0).length;
    if (atCentre !== 1) failures.push(`a player at a hex centre is in range of ${atCentre} hexes, not 1`);
    // A vertex of h+00+00, where three hexagons meet.
    const atCorner = hexesNear(R, 0).length;
    if (atCorner < 3) failures.push(`a player at a hex corner is in range of ${atCorner} hexes, fewer than 3`);
    if (atCorner > 7) failures.push(`a player at a hex corner is in range of ${atCorner} hexes, which is over-fetching`);
  }

  // --- 6. A half-written contract leaves this off rather than half-on, because
  // half-on is a world with no tiles in it.
  {
    const good = contract as HexContract;
    for (const [label, index] of [
      ['null index', null],
      ['no hexes block', {}],
      ['empty list', { hexes: { ...good, list: [] } }],
      ['future version', { hexes: { ...good, version: HEX_VERSION + 1 } }],
      ['zero circumradius', { hexes: { ...good, circumradius_m: 0 } }],
      ['zero approach', { hexes: { ...good, approach_m: 0 } }],
    ] as Array<[string, HexIndex | null]>) {
      armHexes(index, '/world', '');
      if (armed) failures.push(`armHexes armed on ${label}`);
    }
  }

  resetHexes();
  contract = saved.contract;
  armed = saved.armed;
  tileCount = saved.tileCount;
  for (const [id, entry] of saved.catalogue) catalogue.set(id, entry);
  for (const [id, manifest] of saved.resident) resident.set(id, manifest);
  for (const [id, job] of saved.inFlight) inFlight.set(id, job);
  listeners.push(...saved.listeners);
  return failures;
}
