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
 * only the tiles the drop's own givers fall in (a hundred-odd points touch a
 * hundred-odd tiles at most, against several thousand shipped), decodes each
 * tile's collision sidecar once through `addTile` exactly as the server does,
 * and asks `pointInPolygon` against every prism taller than 2 m -- tall enough
 * to be a wall around a giver's feet rather than a kerb or a low fence.
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
import { CollisionWorld, pointInPolygon, type Prism } from '../../client/src/player/collision.ts';
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

// --- No two givers share a first name ------------------------------------------------

const first = new Map<string, string>();
for (const n of npcs) {
  const k = n.name.split(',')[0].trim().toLowerCase();
  if (first.has(k)) bad.push(`two givers called "${n.name.split(',')[0].trim()}": ${first.get(k)} and ${n.id} (${n.pack})`);
  else first.set(k, n.id);
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

/** One tile's prisms, loaded once and cached -- a drop's givers touch at most a hundred-odd tiles. */
const prismCache = new Map<string, Prism[]>();
function prismsOf(t: TileEntry): Prism[] {
  const cached = prismCache.get(t.key);
  if (cached) return cached;
  const path = join(WORLD_ROOT, 'collision', `${t.key}.bin`);
  if (!existsSync(path)) { prismCache.set(t.key, []); return []; }
  const b = readFileSync(path);
  const buf = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  const world = new CollisionWorld();
  world.addTile(t.key, buf, t.bounds[0], t.bounds[1] + TILE_SIZE, t.b);
  const prisms = world.prismsWithin((t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2, TILE_SIZE * 1.5);
  prismCache.set(t.key, prisms);
  return prisms;
}

/** Tall enough to be a wall around a giver's feet, not a kerb or a low fence. See header. */
const SOLID_MIN_HEIGHT_M = 2;

for (const n of npcs) {
  const tile = tileFor(n.x, n.z);
  if (!tile) continue; // outside the baked world -- nothing to test this giver against
  for (const prism of prismsOf(tile)) {
    if (prism.height <= SOLID_MIN_HEIGHT_M) continue;
    if (pointInPolygon(prism.points, n.x, n.z)) {
      bad.push(`giver ${n.id} (${n.pack}) at (${n.x}, ${n.z}) stands inside a building, top ${prism.top.toFixed(1)} m`);
      break;
    }
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
