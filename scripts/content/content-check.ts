/**
 * The gate a content drop has to clear before it ships: every pack in
 * `content/` validates the way the server validates them, no two givers share
 * a first name, no two givers stand within 25 m of each other, nothing --
 * giver or quest step -- stands on the tracks, the Act 2 register carries
 * exactly ten jobs on every rung and none of them opens before the story
 * does, and no giver stands inside a building.
 *
 *     bun run scripts/content/content-check.ts
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists as the whole-drop gate, and not just `entry-validate.ts`
 * run a hundred times
 *
 * `entry-validate.ts` proves one entry is well-formed in isolation. It cannot
 * prove the things that only exist once a hundred entries share one city: two
 * good entries can still name their giver "Dale", stand their giver 12 m from
 * somebody else's, or land ten quests on the wrong rung of the register
 * because the round that wrote them miscounted. Every one of those passes
 * `entry-validate.ts` and fails a player five minutes into the pool, and this
 * file is the one place that looks at the whole set at once, the way
 * `content/` is the whole set the server actually loads.
 *
 * It checks **every** quest and npc under `content/`, not only a `pool-`
 * pack -- the name, position and track rules apply to Denise the Centrelink
 * clerk exactly as they apply to the hundredth pool giver, because a player
 * cannot tell which act placed the body that is blocking their path. This is
 * the file `pool-complete.ts` (the scratch tool this grew from, one content
 * drop ago) narrowed to `selected.json` because that drop was being judged
 * entry by entry against a shortlist; this drop and the next one ship whole
 * packs, so the shortlist is gone and the check is the packs themselves.
 *
 * ---------------------------------------------------------------------------
 * ## The register rule
 *
 * `server/quests-check.ts` phase G already asserts this against the packs the
 * server actually ships, in a process that also boots a `Simulation` -- this
 * is the same two assertions, run here so a broken register is visible from a
 * laptop before a push rather than from the next `bun run server/quests-check.ts`.
 * Act 2 is a hundred-quest menu, ten to a rung of the register
 * (`REGISTER_LEVELS`, `client/src/game/questmodel.ts`), and a rung must not be
 * able to lure a player off the obligations before they are done: rung 1's
 * pool jobs wait for `act0:trained`, the chain's last flag, and every other
 * rung's wait for `act1:open`, the faction-choice review's. Get either wrong
 * and the bug is invisible in play -- the quest log just looks a little thin,
 * or a little early -- and only a count catches it.
 *
 * ---------------------------------------------------------------------------
 * ## The building check, and why it stops at a report
 *
 * `client/src/player/collision.ts`'s `CollisionWorld` is the one structure
 * that answers "is this point inside a solid" the way the client and server
 * both do it -- see `server/undrawn-solids-check.ts`'s header for the longer
 * argument against a second, hand-rolled reader of the same bytes. This loads
 * each giver's own tile and the ring of eight neighbours around it (a
 * hundred-odd givers touch a few hundred tiles at most this way, against
 * several thousand shipped), decodes each tile's collision sidecar once
 * through `addTile` exactly as the server does, and asks `pointInPolygon`
 * against every prism taller than 2 m -- tall enough to be a wall around a
 * giver's feet rather than a kerb or a low fence.
 *
 * **Why the ring, and not just the tile a giver's feet fall in.** A building's
 * footprint is written to exactly one tile's collision payload -- the tile
 * that owns it -- and a footprint that straddles a tile line still lives in
 * that one file, overhanging the neighbour. `priya-rhodes-engagement`, at
 * (-11340, -4000) in Rhodes, stood exactly on such a line: her own tile's
 * payload carried no building at her feet, the 19 m block she was actually
 * standing in was filed under the tile next door, and a test that opened only
 * the standing tile read her as clear. `place-clear.ts`'s `insideBuilding`
 * found this the hard way already and loads the same ring for the same reason
 * (see its header) -- nine small files bought once per giver, paid back the
 * moment a footprint crosses a line.
 *
 * **The height half, and the datum that makes it possible.** A prism is a solid
 * only between its `base` and its `top`, not from the ground up, and a plan hit
 * is not an "inside" until the giver's own feet are in that band. This asks the
 * ground the way `world/questmarkers.ts` does -- `TerrainField.height` over the
 * tile the giver falls in -- and only flags a giver whose feet lie between the
 * prism's `base` and `top`, not merely whose plan is inside its footprint.
 *
 * The two heights are the same datum, and that is the whole reason the test is
 * a subtraction and not a guess. `pipeline/sydney/terrain.py` writes every
 * terrain post as `DEM - base`, where `base` is the DEM at the ENU origin, and
 * the index carries it as `datum_ahd` (71.075 m AHD) with `sea_level_y` at
 * `-71.075`; `cli._report_terrain` states it as "y = 0 is 71.075 m AHD, the
 * ground at the ENU origin". A prism's `base` is the terrain at its pad, in the
 * same frame, so a prism whose `top` reads `-20 m` is a building at 51 m AHD --
 * above sea level, below the CBD origin -- and a giver whose terrain reads
 * `+30 m` is 50 m above that roof, not inside it. The negative tops the report
 * used to print are not a datum error and not a bug; they are real buildings in
 * suburbs that stand below the origin. What was wrong was the plan-only test,
 * which flagged a giver 50 m over a roof as if they were in the wall.
 *
 * It does not move anybody. A track violation has one correct fix
 * (`place-nudge.ts`'s perpendicular step, because there is only one geometry
 * to clear); a giver standing inside a building has several -- move the giver,
 * move the door they're meant to be waiting at, decide the footprint is wrong
 * -- and guessing which one is right is a decision for whoever is looking at
 * the placement, not for a script that cannot see the street.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodeRail } from '../../client/src/game/rail.ts';
import { CollisionWorld, pointInPolygon } from '../../client/src/player/collision.ts';
import { TerrainField, decodeTerrain } from '../../client/src/world/terrain.ts';
import { REGISTER_LEVELS } from '../../client/src/game/questmodel.ts';

const SCRIPTS = import.meta.dir;
const REPO = join(SCRIPTS, '..', '..');
const CONTENT = process.env.SYDNEY_CONTENT ?? join(REPO, 'content');
const WORLD_ROOT = process.env.SYDNEY_WORLD ?? join(REPO, 'client', 'public', 'world');

const bad: string[] = [];

// --- Every pack validates the way the server validates them -------------------------

const v = Bun.spawnSync(['bun', 'run', join(SCRIPTS, 'validate-content.ts'), CONTENT]);
if (v.exitCode !== 0) bad.push('validate-content: ' + v.stdout.toString().trim().replace(/\n/g, '\n    '));

// --- Read every quest and npc under content/, tagged with the pack that carries them --

interface RawQuest {
  id: string;
  act: number;
  level: number;
  giver: string;
  needFlags: string[];
  steps: Array<{ kind: string; x?: number; z?: number }>;
  pack: string;
}
interface RawNpc { id: string; name: string; x: number; z: number; pack: string; }

const quests = new Map<string, RawQuest>();
for (const f of readdirSync(join(CONTENT, 'quests'))) {
  if (!f.endsWith('.json')) continue;
  for (const q of JSON.parse(readFileSync(join(CONTENT, 'quests', f), 'utf8')).quests ?? []) {
    quests.set(q.id, { ...q, pack: f });
  }
}
const npcs: RawNpc[] = [];
for (const f of readdirSync(join(CONTENT, 'dialog'))) {
  if (!f.endsWith('.json')) continue;
  for (const n of JSON.parse(readFileSync(join(CONTENT, 'dialog', f), 'utf8')).npcs ?? []) {
    npcs.push({ ...n, pack: f });
  }
}

// --- No two givers *near each other* share a first name --------------------------------
//
// **This used to be a rule about the whole city and it stopped being one.**
//
// The requirement it protects is real and unchanged: a player must never be
// confused about which Dave. What changed is the arithmetic. At a hundred and
// nine givers, one Dave in Sydney was a fine way to guarantee that. At thirteen
// hundred it is a straitjacket -- the name pool is six hundred deep, so the rule
// was not producing clarity, it was producing a ceiling on how many people this
// city may contain.
//
// It is also, at that size, wrong about Sydney. A city of five million with
// exactly one Ahmad in it is a stranger claim than two of them forty kilometres
// apart.
//
// So the rule is now what it always meant: unique within `NAME_REACH_M`. That is
// wider than a hub, wider than a suburb, and comfortably wider than any distance
// over which a player holds two givers in their head at once -- you cannot be
// confused between a Dave at Redfern and a Dave at Penrith, because you will
// never see them in the same afternoon.
//
// O(n^2) over thirteen hundred givers is under two million distance tests and
// runs in well under a second, which is not worth a grid.

const NAME_REACH_M = 2500;
{
  const reach2 = NAME_REACH_M * NAME_REACH_M;
  const firstOf = npcs.map((n) => n.name.split(',')[0].trim());
  for (let i = 0; i < npcs.length; i++) {
    for (let j = i + 1; j < npcs.length; j++) {
      if (firstOf[i].toLowerCase() !== firstOf[j].toLowerCase()) continue;
      const dx = npcs[i].x - npcs[j].x;
      const dz = npcs[i].z - npcs[j].z;
      if (dx * dx + dz * dz > reach2) continue;
      bad.push(
        `two givers called "${firstOf[i]}" ${Math.round(Math.sqrt(dx * dx + dz * dz))} m apart: ` +
          `${npcs[i].id} (${npcs[i].pack}) and ${npcs[j].id} (${npcs[j].pack})`,
      );
    }
  }
}

// --- No two givers stand within 25 m of each other -------------------------------------

for (let i = 0; i < npcs.length; i++) {
  for (let j = i + 1; j < npcs.length; j++) {
    const d = Math.hypot(npcs[i].x - npcs[j].x, npcs[i].z - npcs[j].z);
    if (d < 25) bad.push(`${npcs[i].id} and ${npcs[j].id} stand ${d.toFixed(0)} m apart`);
  }
}

// --- Nothing stands on the tracks -------------------------------------------------------

const railBuf = readFileSync(join(REPO, 'client/public/rail/rail.bin'));
const V = decodeRail(railBuf.buffer.slice(railBuf.byteOffset, railBuf.byteOffset + railBuf.byteLength) as ArrayBuffer).vertices;
function trackDist(x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 5 < V.length; i += 3) {
    const ax = V[i], az = V[i + 2], dx = V[i + 3] - ax, dz = V[i + 5] - az, l2 = dx * dx + dz * dz;
    if (l2 > 200 * 200 || l2 === 0) continue;
    let t = ((x - ax) * dx + (z - az) * dz) / l2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = (ax + t * dx - x) ** 2 + (az + t * dz - z) ** 2; if (d < best) best = d;
  }
  return Math.sqrt(best);
}
for (const n of npcs) if (trackDist(n.x, n.z) < 6) bad.push(`giver ${n.id} (${n.pack}) stands on the tracks`);
for (const q of quests.values()) {
  q.steps.forEach((s, i) => {
    if (typeof s.x === 'number' && typeof s.z === 'number' && trackDist(s.x, s.z) < 6) {
      bad.push(`${q.id} (${q.pack}) step ${i} (${s.kind}) is on the tracks`);
    }
  });
}

// --- The register: Act 2 carries ten jobs on every rung, none open too early -----------

const pool = [...quests.values()].filter((q) => q.act === 2);
for (let rung = 1; rung <= REGISTER_LEVELS; rung++) {
  const on = pool.filter((q) => q.level === rung);
  if (on.length !== 10) bad.push(`rung ${rung} carries ${on.length} pool job(s), not ten`);
}
for (const q of pool) {
  const want = q.level === 1 ? 'act0:trained' : 'act1:open';
  if (!q.needFlags.includes(want)) bad.push(`${q.id} (rung ${q.level}) is missing needFlags "${want}"`);
}

// --- No giver stands inside a building --------------------------------------------------

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
  const minX = Math.floor(x / TILE_SIZE) * TILE_SIZE;
  const minZ = Math.floor(z / TILE_SIZE) * TILE_SIZE;
  return tileByCorner.get(`${minX},${minZ}`);
}

/**
 * Every tile whose square meets the axis-aligned box, deduped. `place-clear.ts`'s
 * `tilesOver`, mirrored rather than imported -- see the header for why a
 * giver's own tile is not enough to test against.
 */
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
 * One `CollisionWorld` for the whole drop, tiles adopted as givers reach them.
 * Two givers' rings can share a tile, and `hasTile` makes the second load free.
 */
const collision = new CollisionWorld();
function loadCollision(t: TileEntry): void {
  if (collision.hasTile(t.key)) return;
  const path = join(WORLD_ROOT, 'collision', `${t.key}.bin`);
  if (!existsSync(path)) return;
  const b = readFileSync(path);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  collision.addTile(t.key, buf, t.bounds[0], t.bounds[1] + TILE_SIZE, t.b);
}

/** Tall enough to be a wall around a giver's feet, not a kerb or a low fence. See header. */
const SOLID_MIN_HEIGHT_M = 2;

/**
 * The ground, off the disk, the way `server/world.ts` reads it. One field for
 * the whole drop: a giver's feet are the terrain height at their point, and the
 * building check asks whether those feet are in a prism's `[base, top]` band.
 * The grids are adopted under the tile's own key, which is the key `height`
 * derives from a world point, so the two halves meet.
 */
const terrain = new TerrainField(worldIndex.terrain.grid, TILE_SIZE, '');
const terrainLoaded = new Set<string>();
function terrainOf(t: TileEntry): void {
  if (terrainLoaded.has(t.key)) return;
  terrainLoaded.add(t.key);
  const path = join(WORLD_ROOT, 'tiles', `${t.key}.terr.bin`);
  if (!existsSync(path)) return;
  const b = readFileSync(path);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const grid = decodeTerrain(buf, worldIndex.terrain.grid);
  if (grid) terrain.adopt(t.key, grid);
}

for (const n of npcs) {
  const tile = tileFor(n.x, n.z);
  if (!tile) continue; // outside the baked world -- nothing to test this giver against
  // The giver's own tile and its eight neighbours: a footprint is filed under
  // whichever tile owns it, and one can straddle the line into this tile
  // while its payload lives in the neighbour's. See the header.
  for (const t of tilesOver(n.x - TILE_SIZE, n.z - TILE_SIZE, n.x + TILE_SIZE, n.z + TILE_SIZE)) {
    loadCollision(t);
    terrainOf(t);
  }
  const feet = terrain.height(n.x, n.z);
  for (const prism of collision.prismsWithin(n.x, n.z, 1)) {
    if (prism.height <= SOLID_MIN_HEIGHT_M) continue;
    if (!pointInPolygon(prism.points, n.x, n.z)) continue;
    // A plan hit is an "inside" only with the feet in the prism's own band. A
    // giver 50 m over a roof is not in the wall, and a prism's `base` is the
    // terrain at its pad, so feet below it are on the ground the building was
    // built on rather than in it. See the header for the datum.
    if (Number.isNaN(feet) || feet < prism.base || feet >= prism.top) continue;
    bad.push(`giver ${n.id} (${n.pack}) at (${n.x}, ${n.z}) stands inside a building, top ${prism.top.toFixed(1)} m`);
    break;
  }
}

// --- Verdict -----------------------------------------------------------------------------

if (bad.length) {
  console.log(bad.map((b) => '  - ' + b).join('\n'));
  process.exit(1);
}
console.log(
  `content complete: ${quests.size} quests, ${npcs.length} npcs, no name or position collisions, ` +
    'nothing on the tracks, the register checks out, no giver inside a building',
);
