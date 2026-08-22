/**
 * Walks a dialog giver out of the building they were written into, to the
 * nearest point on the street that is clear of every wall, every rail and every
 * other giver -- and drags the one or two quest steps that were pinned to their
 * feet along with them.
 *
 *     bun run scripts/content/place-clear.ts --all
 *     bun run scripts/content/place-clear.ts --all --apply
 *     bun run scripts/content/place-clear.ts pool-l6 quay-silver-man [--apply]
 *
 * ---------------------------------------------------------------------------
 * ## Why this is a script and not nineteen decisions
 *
 * `content-check.ts` grew a building test and immediately convicted nineteen
 * givers, and its own header says why it stops at the report: a giver in a wall
 * has several correct fixes and picking between them is a decision for whoever
 * is looking at the street. That is still true of *which* fix -- move the
 * giver, move the door, redraw the footprint -- but it stopped being true of
 * the nineteenth repetition of the same fix. Nineteen hand-nudges are nineteen
 * chances to put somebody 6 m from a rail, 20 m from the next giver, or on the
 * far side of a wall they were meant to be leaning on, and none of those show
 * up until the gate is run again, or worse, until a player walks there. So the
 * repetition is mechanised and the taste is left where it belongs: this only
 * ever moves a giver, it moves them the shortest distance that satisfies every
 * rule the gate already enforces, and it prints what it did so the two or three
 * placements that are *hero* placements can be read and overruled by eye.
 *
 * ## The twentieth
 *
 * `--all` found twenty, not nineteen, and the extra one is a hole in the gate
 * rather than a disagreement about taste. Priya, at (-11340, -4000) in Rhodes,
 * stands exactly on a tile line with a 19 m building whose footprint straddles
 * it -- and a footprint belongs to one tile's collision payload, the tile that
 * owns it, not to every tile it overhangs. `content-check.ts` loads only the
 * tile the giver stands in, so it read her as clear against a building she was
 * standing well inside. See `insideBuilding` for the ring this loads instead.
 * Worth fixing in the gate; not fixed here, because this file is not the gate.
 *
 * ## What "clear" means here, rule by rule
 *
 * A candidate point is clear when all five hold:
 *
 *   1. **Out of the walls.** Against every prism taller than
 *      `SOLID_MIN_HEIGHT_M` that is solid around a body standing on the terrain
 *      *at the candidate*. The solidity rule is `CollisionWorld.solidFor`'s, not
 *      the gate's -- see `solid` below for why the difference matters, and why
 *      taking the gate's own test would have let this script "fix" a giver by
 *      walking them one metre further into the same building. The point must be
 *      outside the footprint and `WALL_CLEAR_M` clear of its edges: a giver
 *      standing with their nose against a shopfront is technically outside the
 *      prism and is still a giver whose body clips the wall, since a body is a
 *      capsule and `content-check.ts` only ever asked about a point.
 *   2. **Off the rails.** `TRACK_CLEAR_M` from every track centreline, which is
 *      `place-nudge.ts`'s `CLEAR_M` rather than the gate's own 6 m -- if we are
 *      moving somebody anyway there is no reason to leave them track-adjacent.
 *      The distance is `place-check.ts`'s, over the same `decodeRail` bake.
 *   3. **Out of everyone's way.** `GIVER_CLEAR_M` from every other giver in
 *      `content/dialog/*.json`, which is `entry-add.ts`'s rule and the gate's.
 *      In an `--all` run the list is kept live, so the second giver moved is
 *      measured against where the first one *landed*, not where it was written.
 *   4. **Still near the train.** If `place-check.ts`'s station lookup puts the
 *      giver within `STATION_M` of a station, the new spot has to be within
 *      `STATION_M` of one too. A giver written at a station is a giver whose
 *      quest text is about that station; sixty metres is not enough to break
 *      that, but the rule costs nothing and says so out loud.
 *   5. **On known ground.** A candidate whose terrain reads `NaN` is a candidate
 *      on a tile this build did not bake, and "I don't know how high it is" is
 *      not somewhere to stand a person.
 *
 * ## The side of the street, and why the lanes answer it
 *
 * A giver written into the Newtown terraces belongs on the footpath they were
 * facing, not across four lanes of King Street, and the shortest clear point is
 * as happy to be across the road as beside it. The preference is cheap to ask
 * here because the geometry is already on disk: `tiles/<key>.lanes.bin` carries
 * the road centrelines, and `world/people.ts`'s footpath bands are *derived*
 * from exactly those centrelines (`centreline +/- (halfWidth + KERB_WIDTH +
 * footpathWidth / 2)`, see `game/pedestrians.ts`'s header), so which side of the
 * band you are on and which side of the way you are on are the same sign. We
 * therefore read the ways through `decodeLanes` -- the same decoder the client
 * and server use -- and never build the bands at all.
 *
 * It is a *preference*, not a rule, and it is bounded: the nearest same-side
 * candidate wins only if it costs no more than `SIDE_SLACK_M` extra. Beyond that
 * the shortest move wins, because a giver dragged 50 m up the road to stay on
 * the even numbers has been moved further from the thing their dialog is about
 * than the road was ever worth. Where the giver started within `SIDE_EPS_M` of
 * the centreline the sign is meaningless and the preference is skipped.
 *
 * ## Deterministic, and why the search is a spiral of rounded points
 *
 * Same input, same answer, every run. The scan is rings at `STEP_M` from the
 * original point outward to `SEARCH_MAX_M`, each ring walked from angle zero
 * with roughly `STEP_M` between neighbours, every candidate rounded to a
 * decimetre before it is tested -- so the point that is *tested* is the point
 * that is *written*, and a rounding that nudged a passing candidate back into a
 * wall cannot happen. Rounded duplicates are visited once. Nothing here reads a
 * clock, a random source or the order of a hash map.
 *
 * ## What `--apply` writes
 *
 * The giver's `x`/`z` in its dialog pack, and the `x`/`z` of any `goto`, `photo`
 * or `dialog` step of a quest *this giver gives* that sat within `PINNED_M` of
 * the old position -- those are the steps that meant "here, where I am
 * standing", and leaving them behind would turn a one-line errand into a walk
 * back to a wall. They move by the same delta rather than being re-solved, so
 * the shape of the errand is preserved. No other step is touched: a `photo` of
 * a bollard 200 m up the Quay is about the bollard.
 *
 * The edit is **surgical text**, not a parse-and-restringify. The packs are not
 * all in one hand -- `act0.json` and `handlers.json` keep their choice objects
 * on one line, the quest packs escape their em dashes and the dialog packs do
 * not -- and a round trip through `JSON.stringify` would reformat several
 * thousand lines to move two numbers, burying the change it came to make. So
 * this finds the giver's own `"id"`, takes the first `"x"`/`"z"` pair after it,
 * asserts the numbers it finds are the numbers it expected, and replaces just
 * those tokens. A mismatch is a hard error rather than a guess.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';
import { decodeLanes, type LaneWay } from '../../client/src/game/traffic.ts';
import { BODY_HEIGHT_M, CollisionWorld, pointInPolygon, type Prism } from '../../client/src/player/collision.ts';
import { TerrainField, decodeTerrain } from '../../client/src/world/terrain.ts';

const SCRIPTS = import.meta.dir;
const REPO = join(SCRIPTS, '..', '..');
const CONTENT = process.env.SYDNEY_CONTENT ?? join(REPO, 'content');
const WORLD_ROOT = process.env.SYDNEY_WORLD ?? join(REPO, 'client', 'public', 'world');

/** Tall enough to be a wall around a giver's feet, not a kerb. `content-check.ts`'s number. */
const SOLID_MIN_HEIGHT_M = 2;
/** How far a body has to stand off a footprint edge before it stops clipping the facade. */
const WALL_CLEAR_M = 1.5;
/** `place-nudge.ts`'s `CLEAR_M`. */
const TRACK_CLEAR_M = 22;
/** `entry-add.ts`'s and the gate's giver spacing. */
const GIVER_CLEAR_M = 25;
/** `place-check.ts`'s "FAR FROM ANY STATION" threshold. */
const STATION_M = 400;
const SEARCH_MAX_M = 60;
const STEP_M = 1;
/** What staying on the giver's own side of the road is worth, in extra metres walked. */
const SIDE_SLACK_M = 12;
/** Closer to the centreline than this and "which side" is not a question worth asking. */
const SIDE_EPS_M = 1.5;
/** A step this close to the giver meant "here, where I am standing". */
const PINNED_M = 1;

// --- The world, read the way the game reads it ---------------------------------------

const railBuf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const bake = decodeRail(
  railBuf.buffer.slice(railBuf.byteOffset, railBuf.byteOffset + railBuf.byteLength) as ArrayBuffer,
);
const V = bake.vertices;

interface TileEntry { key: string; b: number; bounds: [number, number, number, number]; }
const worldIndex = JSON.parse(readFileSync(join(WORLD_ROOT, 'index.json'), 'utf8')) as {
  tile_size: number;
  terrain: { grid: number };
  tiles: TileEntry[];
};
const TILE_SIZE = worldIndex.tile_size;
const tileByCorner = new Map<string, TileEntry>();
for (const t of worldIndex.tiles) tileByCorner.set(`${t.bounds[0]},${t.bounds[1]}`, t);

function tileFor(x: number, z: number): TileEntry | undefined {
  return tileByCorner.get(
    `${Math.floor(x / TILE_SIZE) * TILE_SIZE},${Math.floor(z / TILE_SIZE) * TILE_SIZE}`,
  );
}

/** Every tile whose square meets the axis-aligned box, deduped and in index order. */
function tilesOver(minX: number, minZ: number, maxX: number, maxZ: number): TileEntry[] {
  const out: TileEntry[] = [];
  const seen = new Set<string>();
  for (let x = Math.floor(minX / TILE_SIZE) * TILE_SIZE; x <= maxX; x += TILE_SIZE) {
    for (let z = Math.floor(minZ / TILE_SIZE) * TILE_SIZE; z <= maxZ; z += TILE_SIZE) {
      const t = tileByCorner.get(`${x},${z}`);
      if (t && !seen.has(t.key)) { seen.add(t.key); out.push(t); }
    }
  }
  return out;
}

/**
 * One `CollisionWorld` for the whole run, tiles adopted as the search reaches
 * them. Shared rather than per-tile (which is what `content-check.ts` does,
 * because it only ever asks about the one tile a giver stands in): a candidate
 * 50 m out can be over the tile line, and the wall it is 1.4 m from can belong
 * to the neighbour.
 */
const collision = new CollisionWorld();
function loadCollision(t: TileEntry): void {
  if (collision.hasTile(t.key)) return;
  const path = join(WORLD_ROOT, 'collision', `${t.key}.bin`);
  if (!existsSync(path)) return;
  const b = readFileSync(path);
  collision.addTile(
    t.key,
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    t.bounds[0],
    t.bounds[1] + TILE_SIZE,
    t.b,
  );
}

const terrain = new TerrainField(worldIndex.terrain.grid, TILE_SIZE, '');
const terrainSeen = new Set<string>();
function loadTerrain(t: TileEntry): void {
  if (terrainSeen.has(t.key)) return;
  terrainSeen.add(t.key);
  const path = join(WORLD_ROOT, 'tiles', `${t.key}.terr.bin`);
  if (!existsSync(path)) return;
  const b = readFileSync(path);
  const grid = decodeTerrain(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
    worldIndex.terrain.grid,
  );
  if (grid) terrain.adopt(t.key, grid);
}

const laneCache = new Map<string, LaneWay[]>();
function laneWays(t: TileEntry): LaneWay[] {
  const cached = laneCache.get(t.key);
  if (cached) return cached;
  const path = join(WORLD_ROOT, 'tiles', `${t.key}.lanes.bin`);
  let ways: LaneWay[] = [];
  if (existsSync(path)) {
    const b = readFileSync(path);
    const decoded = decodeLanes(
      b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
      t.bounds[0],
      t.bounds[1] + TILE_SIZE,
    );
    if (decoded) ways = decoded.ways;
  }
  laneCache.set(t.key, ways);
  return ways;
}

// --- Geometry ---------------------------------------------------------------------

/** Squared distance from (x, z) to segment (ax, az)-(bx, bz). */
function segDist2(x: number, z: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + t * dx - x, pz = az + t * dz - z;
  return px * px + pz * pz;
}

/** Distance from (x, z) to the nearest edge of a flattened x,z polygon. */
function polyEdgeDist(points: Float32Array, x: number, z: number): number {
  let best = Infinity;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const d = segDist2(x, z, points[j * 2], points[j * 2 + 1], points[i * 2], points[i * 2 + 1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

// --- The givers, and the packs that carry them --------------------------------------

interface Giver { id: string; name: string; x: number; z: number; pack: string; }

const dialogFiles = readdirSync(join(CONTENT, 'dialog')).filter((f) => f.endsWith('.json')).sort();
const questFiles = readdirSync(join(CONTENT, 'quests')).filter((f) => f.endsWith('.json')).sort();

const givers: Giver[] = [];
for (const f of dialogFiles) {
  for (const n of JSON.parse(readFileSync(join(CONTENT, 'dialog', f), 'utf8')).npcs ?? []) {
    givers.push({ id: n.id, name: n.name, x: n.x, z: n.z, pack: f });
  }
}
const giverById = new Map(givers.map((g) => [g.id, g]));

// --- Who is standing in a wall ------------------------------------------------------

/**
 * `content-check.ts`'s building test -- prisms over `SOLID_MIN_HEIGHT_M`, a plan
 * hit, and the feet in the prism's own `[base, top]` band -- asked over the
 * giver's tile **and its eight neighbours**.
 *
 * That neighbourhood is the one deliberate difference from the gate, and it
 * finds givers the gate cannot see. A footprint is written to exactly one tile's
 * collision payload, the one that owns it, and a building on a tile line sticks
 * out over the neighbour: `content-check.ts` loads only the tile the giver
 * stands in, so a giver just across the line from the owning tile reads as clear
 * against a wall that is right there. Loading the ring costs nine small files
 * and makes the answer both correct and independent of what an earlier giver in
 * the run happened to load -- the alternative, an isolated world per giver, is
 * deterministic and still wrong.
 */
function insideBuilding(x: number, z: number): Prism | null {
  const tile = tileFor(x, z);
  if (!tile) return null;
  for (const t of tilesOver(x - TILE_SIZE, z - TILE_SIZE, x + TILE_SIZE, z + TILE_SIZE)) {
    loadCollision(t);
    loadTerrain(t);
  }
  const feet = terrain.height(x, z);
  if (Number.isNaN(feet)) return null;
  for (const prism of collision.prismsWithin(x, z, 1)) {
    if (prism.height <= SOLID_MIN_HEIGHT_M) continue;
    if (feet < prism.base || feet >= prism.top) continue;
    if (pointInPolygon(prism.points, x, z)) return prism;
  }
  return null;
}

// --- The search ---------------------------------------------------------------------

interface Context {
  prisms: Prism[];
  /** Rail segments that could possibly come within `TRACK_CLEAR_M` of any candidate. */
  rail: number[];
  others: Array<{ x: number; z: number }>;
  needStation: boolean;
  stations: Array<{ x: number; z: number }>;
  /** The way the giver started beside, and which side of it they were on. `null` to skip. */
  side: { way: LaneWay; sign: number } | null;
}

function buildContext(g: Giver): Context {
  const reach = SEARCH_MAX_M + TRACK_CLEAR_M + WALL_CLEAR_M + 10;
  for (const t of tilesOver(g.x - reach, g.z - reach, g.x + reach, g.z + reach)) {
    loadCollision(t);
    loadTerrain(t);
  }
  const prisms = collision
    .prismsWithin(g.x, g.z, SEARCH_MAX_M + WALL_CLEAR_M + 1, [])
    .filter((p) => p.height > SOLID_MIN_HEIGHT_M);

  const rail: number[] = [];
  const railReach = SEARCH_MAX_M + TRACK_CLEAR_M + 1;
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], bx = V[i + 3], bz = V[i + 5];
    const dx = bx - ax, dz = bz - az;
    if (dx * dx + dz * dz > 200 * 200) continue; // a direction boundary, not a segment
    if (segDist2(g.x, g.z, ax, az, bx, bz) > railReach * railReach) continue;
    rail.push(ax, az, bx, bz);
  }

  const others = givers
    .filter((o) => o.id !== g.id)
    .filter((o) => Math.hypot(o.x - g.x, o.z - g.z) < GIVER_CLEAR_M + SEARCH_MAX_M)
    .map((o) => ({ x: o.x, z: o.z }));

  const stations = bake.stations
    .filter((s) => Math.hypot(s.x - g.x, s.z - g.z) < STATION_M + SEARCH_MAX_M)
    .map((s) => ({ x: s.x, z: s.z }));
  const needStation = stations.some((s) => Math.hypot(s.x - g.x, s.z - g.z) <= STATION_M);

  return { prisms, rail, others, needStation, stations, side: sideOf(g) };
}

/** Which side of the nearest road centreline the giver started on. See the header. */
function sideOf(g: Giver): { way: LaneWay; sign: number } | null {
  let best: { way: LaneWay; d2: number; cross: number } | null = null;
  for (const t of tilesOver(g.x - SEARCH_MAX_M, g.z - SEARCH_MAX_M, g.x + SEARCH_MAX_M, g.z + SEARCH_MAX_M)) {
    for (const way of laneWays(t)) {
      for (let i = 0; i + 1 < way.count; i++) {
        const ax = way.x[i], az = way.z[i], bx = way.x[i + 1], bz = way.z[i + 1];
        const d2 = segDist2(g.x, g.z, ax, az, bx, bz);
        if (best !== null && d2 >= best.d2) continue;
        best = { way, d2, cross: (bx - ax) * (g.z - az) - (bz - az) * (g.x - ax) };
      }
    }
  }
  if (best === null) return null;
  const d = Math.sqrt(best.d2);
  if (d < SIDE_EPS_M || d > SEARCH_MAX_M) return null;
  return { way: best.way, sign: best.cross >= 0 ? 1 : -1 };
}

/** The sign of a point against the way the giver was beside; zero when too close to say. */
function sideAt(way: LaneWay, x: number, z: number): number {
  let bestD2 = Infinity, cross = 0;
  for (let i = 0; i + 1 < way.count; i++) {
    const ax = way.x[i], az = way.z[i], bx = way.x[i + 1], bz = way.z[i + 1];
    const d2 = segDist2(x, z, ax, az, bx, bz);
    if (d2 >= bestD2) continue;
    bestD2 = d2;
    cross = (bx - ax) * (z - az) - (bz - az) * (x - ax);
  }
  if (bestD2 < SIDE_EPS_M * SIDE_EPS_M) return 0;
  return cross >= 0 ? 1 : -1;
}

/**
 * Is this prism a wall around a body whose feet are at `feet`?
 *
 * **`CollisionWorld.solidFor`'s rule, not `content-check.ts`'s**, and the
 * difference is the whole reason the first cut of this script produced
 * one-metre "fixes". The gate asks whether the feet lie in `[base, top)` for
 * every prism alike; but `base` is the *pad* a building stands on and the
 * terrain is sampled off a 31.25 m grid, so a giver standing at the foot of a
 * building reads feet within centimetres of `base` -- and one metre of walk is
 * enough to drop under it, clear the gate's test, and leave the giver seven
 * metres inside the same shop. `collision.ts` settled this already: a
 * **building** is solid from its top down to the terrain whatever its pad says,
 * because `mesh.py` draws its walls down to meet the ground, and only a
 * **structure** -- a deck, a viaduct, a bridge span -- gets the walk-under band.
 * So that is the rule here, with a standing body's own head height for the
 * soffit question.
 *
 * It is deliberately a superset of the gate's test: everything the gate would
 * convict, this convicts too, which is what makes "clear by this" imply "clear
 * by `content-check.ts`" rather than merely "not currently flagged".
 */
function solid(p: Prism, feet: number): boolean {
  if (p.height <= SOLID_MIN_HEIGHT_M) return false;
  if (feet >= p.top) return false;
  if (!p.structural) return true;
  return feet + BODY_HEIGHT_M > p.base;
}

function clear(c: Context, x: number, z: number): boolean {
  const feet = terrain.height(x, z);
  if (Number.isNaN(feet)) return false;

  for (const p of c.prisms) {
    // AABB first: the polygon walk is the expensive half and a prism whose box
    // is already further than the clearance cannot be closer than it.
    const dx = Math.max(p.minX - x, 0, x - p.maxX);
    const dz = Math.max(p.minZ - z, 0, z - p.maxZ);
    if (dx * dx + dz * dz > WALL_CLEAR_M * WALL_CLEAR_M) continue;
    if (!solid(p, feet)) continue;
    if (pointInPolygon(p.points, x, z)) return false;
    if (polyEdgeDist(p.points, x, z) < WALL_CLEAR_M) return false;
  }

  for (let i = 0; i < c.rail.length; i += 4) {
    if (segDist2(x, z, c.rail[i], c.rail[i + 1], c.rail[i + 2], c.rail[i + 3]) < TRACK_CLEAR_M * TRACK_CLEAR_M) {
      return false;
    }
  }

  for (const o of c.others) {
    if ((o.x - x) ** 2 + (o.z - z) ** 2 < GIVER_CLEAR_M * GIVER_CLEAR_M) return false;
  }

  if (c.needStation) {
    let near = false;
    for (const s of c.stations) {
      if ((s.x - x) ** 2 + (s.z - z) ** 2 <= STATION_M * STATION_M) { near = true; break; }
    }
    if (!near) return false;
  }

  return true;
}

const dm = (v: number): number => Math.round(v * 10) / 10;

interface Found { x: number; z: number; d: number; sameSide: boolean }

function search(g: Giver, c: Context): Found | null {
  let best: Found | null = null;
  let bestSame: Found | null = null;
  const seen = new Set<string>();

  for (let r = 0; r <= SEARCH_MAX_M; r += STEP_M) {
    // Stop once no ring left can beat what we have: the nearest clear point is
    // fixed, and the only thing still worth finding is a same-side one inside
    // the slack.
    if (best !== null && r > best.d + SIDE_SLACK_M) break;
    const n = r === 0 ? 1 : Math.max(8, Math.round((2 * Math.PI * r) / STEP_M));
    for (let k = 0; k < n; k++) {
      const a = (2 * Math.PI * k) / n;
      const x = dm(g.x + r * Math.cos(a));
      const z = dm(g.z + r * Math.sin(a));
      const key = `${x},${z}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!clear(c, x, z)) continue;
      const d = Math.hypot(x - g.x, z - g.z);
      const same = c.side !== null && sideAt(c.side.way, x, z) === c.side.sign;
      if (best === null || d < best.d) best = { x, z, d, sameSide: same };
      if (same && (bestSame === null || d < bestSame.d)) bestSame = { x, z, d, sameSide: true };
    }
  }

  if (best === null) return null;
  if (bestSame !== null && bestSame.d <= best.d + SIDE_SLACK_M) return bestSame;
  return best;
}

// --- Writing it down ----------------------------------------------------------------

const files = new Map<string, string>();
function text(path: string): string {
  let t = files.get(path);
  if (t === undefined) { t = readFileSync(path, 'utf8'); files.set(path, t); }
  return t;
}

/** `-9577` and `-9577.2`, never `-9577.0` and never `-0`. */
function num(v: number): string {
  const r = dm(v);
  return Object.is(r, -0) ? '0' : String(r);
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Pair { xAt: number; xLen: number; zAt: number; zLen: number; x: number; z: number; end: number }

/** The next `"x"`/`"z"` pair at or after `from`, as offsets into `src`. */
function nextXZ(src: string, from: number): Pair | null {
  const rx = /("x"\s*:\s*)(-?\d+(?:\.\d+)?)/g;
  rx.lastIndex = from;
  const mx = rx.exec(src);
  if (!mx) return null;
  const rz = /("z"\s*:\s*)(-?\d+(?:\.\d+)?)/g;
  rz.lastIndex = mx.index + mx[0].length;
  const mz = rz.exec(src);
  if (!mz) return null;
  return {
    xAt: mx.index + mx[1].length, xLen: mx[2].length,
    zAt: mz.index + mz[1].length, zLen: mz[2].length,
    x: Number(mx[2]), z: Number(mz[2]),
    end: mz.index + mz[0].length,
  };
}

/**
 * Rewrite one pair's two number tokens and nothing else -- the separator, the
 * indentation and every other byte of the file survive untouched.
 */
function writePair(src: string, p: Pair, x: number, z: number): string {
  return (
    src.slice(0, p.xAt) + num(x) + src.slice(p.xAt + p.xLen, p.zAt) + num(z) + src.slice(p.zAt + p.zLen)
  );
}

function anchorOf(src: string, id: string, where: string): number {
  const m = new RegExp(`"id"\\s*:\\s*"${esc(id)}"`).exec(src);
  if (!m) throw new Error(`${id}: not found in ${where}`);
  return m.index;
}

/** Move the giver's own `x`/`z` in its dialog pack. */
function applyGiver(g: Giver, nx: number, nz: number): void {
  const path = join(CONTENT, 'dialog', g.pack);
  const src = text(path);
  const p = nextXZ(src, anchorOf(src, g.id, g.pack));
  if (!p) throw new Error(`giver ${g.id}: no x/z after its id in ${g.pack}`);
  if (p.x !== g.x || p.z !== g.z) {
    throw new Error(`giver ${g.id}: expected (${g.x}, ${g.z}) in ${g.pack}, found (${p.x}, ${p.z})`);
  }
  files.set(path, writePair(src, p, nx, nz));
}

/**
 * Move every placed step of this giver's own quests that was pinned to their
 * feet, by the same delta. See the header for why only these and why by delta.
 *
 * The walk is positional: from the quest's own `"id"` -- the only `"id"` a
 * quest object carries, steps have none -- the n-th `"x"`/`"z"` pair is the
 * n-th placed step, and every pair passed over is checked against the parsed
 * step it should be before the cursor moves on. A pack that disagrees is an
 * error, not a silently misplaced marker.
 */
function applySteps(g: Giver, dx: number, dz: number): string[] {
  const moved: string[] = [];
  for (const f of questFiles) {
    const path = join(CONTENT, 'quests', f);
    for (const q of JSON.parse(text(path)).quests ?? []) {
      if (q.giver !== g.id) continue;
      const placed: Array<{ i: number; s: { kind: string; x: number; z: number } }> = [];
      q.steps.forEach((s: { kind: string; x?: number; z?: number }, i: number) => {
        if (typeof s.x === 'number' && typeof s.z === 'number') {
          placed.push({ i, s: s as { kind: string; x: number; z: number } });
        }
      });
      const pins = placed.filter(({ s }) => Math.hypot(s.x - g.x, s.z - g.z) <= PINNED_M);
      if (!pins.length) continue;

      let src = text(path);
      let cursor = anchorOf(src, q.id, f);
      for (const { i, s } of placed) {
        const p = nextXZ(src, cursor);
        if (!p) throw new Error(`${q.id} step ${i}: ran out of x/z pairs in ${f}`);
        if (p.x !== s.x || p.z !== s.z) {
          throw new Error(`${q.id} step ${i}: expected (${s.x}, ${s.z}) in ${f}, found (${p.x}, ${p.z})`);
        }
        if (!pins.some((pin) => pin.i === i)) { cursor = p.end; continue; }
        src = writePair(src, p, s.x + dx, s.z + dz);
        // The tokens can change length, so re-find rather than trusting `end`.
        const after = nextXZ(src, cursor);
        cursor = after ? after.end : src.length;
        moved.push(`${q.id} step ${i} (${s.kind})`);
      }
      files.set(path, src);
    }
  }
  return moved;
}

// --- The run -------------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const all = args.includes('--all');
const rest = args.filter((a) => !a.startsWith('--'));

let targets: Giver[];
if (all) {
  targets = givers.filter((g) => insideBuilding(g.x, g.z) !== null);
  if (!targets.length) console.log('no giver stands inside a building; nothing to do');
} else if (rest.length === 2) {
  const pack = rest[0].endsWith('.json') ? rest[0] : rest[0] + '.json';
  const g = giverById.get(rest[1]);
  if (!g) { console.log(`no giver "${rest[1]}" in content/dialog`); process.exit(1); }
  if (g.pack !== pack) { console.log(`${g.id} lives in ${g.pack}, not ${pack}`); process.exit(1); }
  targets = [g];
} else {
  console.log('usage: place-clear.ts (--all | <pack> <npc-id>) [--apply]');
  process.exit(1);
}

let stuck = 0;
for (const g of targets) {
  const context = buildContext(g);
  const found = search(g, context);
  if (!found) {
    console.log(`${g.id}: no clear spot within ${SEARCH_MAX_M} m of (${num(g.x)}, ${num(g.z)}); left where it was`);
    stuck++;
    continue;
  }
  // Only say anything about sides where a side was asked for. See `sideOf`.
  const side = context.side === null ? '' : found.sameSide ? '' : ' [crossed the road]';
  console.log(
    `${g.id}: (${num(g.x)}, ${num(g.z)}) -> (${num(found.x)}, ${num(found.z)}) ${found.d.toFixed(1)} m${side}`,
  );
  if (apply) {
    const steps = applySteps(g, found.x - g.x, found.z - g.z);
    applyGiver(g, found.x, found.z);
    for (const s of steps) console.log(`    moved with it: ${s}`);
  }
  // Later givers in an `--all` run measure against where this one landed.
  g.x = found.x;
  g.z = found.z;
}

if (apply) for (const [path, t] of files) writeFileSync(path, t);
if (targets.length) {
  console.log(
    `${targets.length - stuck}/${targets.length} placed${stuck ? `, ${stuck} left in place` : ''}` +
      (apply ? '; written' : '; dry run, pass --apply to write'),
  );
}
