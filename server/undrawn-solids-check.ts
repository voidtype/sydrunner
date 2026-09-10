/**
 * Solids the player is stopped by with nothing drawn there, measured from the bake.
 *
 *     bun run server/undrawn-solids-check.ts
 *     bun run server/undrawn-solids-check.ts --worst 40
 *     bun run server/undrawn-solids-check.ts --near -2884,-7417 --radius 400
 *
 * ---------------------------------------------------------------------------
 * ## Why this exists, and why neither of the two audits either side of it is it
 *
 * A player driving up the Pacific Highway is stopped by nothing. There is no
 * wall in front of them, the street runs on, and they cannot go. That is the
 * worst class of defect this world can ship, because it is the one the player
 * cannot diagnose from inside the game: a wall you can see is a wall you drive
 * round, and a wall you cannot see is a bug report that says *"why is there an
 * invisible wall here"* and nothing more.
 *
 * Two things already measure a *part* of this and neither closes it:
 *
 *   - `cli.cmd_carriageway_audit` counts collision prisms standing on the
 *     emitted carriageway, which is the right question with one word missing.
 *     It never asks whether the prism is **drawn**. A terrace whose footprint
 *     genuinely overhangs the kerb is in its count and is not this defect: the
 *     player sees a building, walks round it, and files nothing.
 *   - `world/invisible-walls.ts` asks exactly the drawn question and asks it
 *     **per tile**, live, in the browser: collision resident, geometry not.
 *     That is the streaming gap, it clears itself in a second, and its
 *     permanent half was retired when `resolve` learned to walk under a soffit.
 *     A single prism inside a tile that is fully built is invisible to it --
 *     `hazardAt` answers by tile cell, so a wall standing in one street of a
 *     tile that drew everything else is not a hazard it can name.
 *
 * The intersection of the two is the defect, and nothing measured it. This does:
 * **a solid the player is stopped by, standing on a drivable lane, with no
 * geometry over it in the file that is supposed to draw it.**
 *
 * ---------------------------------------------------------------------------
 * ## The four sources, and why all four are read rather than derived
 *
 *   - **The lanes.** `tiles.write_lanes`' ways block: centreline, solved height
 *     and kerb-to-kerb half width, per tile, clipped to the tile. The
 *     carriageway is the polyline swept by `halfWidth`, which is the same
 *     geometry `world/road-deck.ts` and `game/pedestrians.ts` already derive
 *     from these bytes -- so a road is where the *shipped lane graph* says it
 *     is, not where OSM said it was.
 *   - **The collision.** `CollisionWorld.addTile` on the real payload, with the
 *     index's own `b`, so `Prism.structural` is set here exactly as it is on
 *     both authorities. Read through the class rather than re-parsed, because a
 *     second reader of that format in a check is a check of a copy.
 *   - **The geometry.** `parseTileGlb`, the same decoder `decode.worker.ts`
 *     runs, and the material slot names decide what a primitive is: a building
 *     is drawn in walls, roofs, the contact skirt and the awning fascia; a deck
 *     is drawn in `road_asphalt`/`footpath_concrete`, which is what
 *     `decks.SLOT_DECK` and `decks.SLOT_STRUCTURE` alias to.
 *   - **The landmark file.** `landmarks.glb`, opened once with the loader
 *     `scripts/render-landmark-sheet.mjs` already reads it with, each node's
 *     own transform applied. The four hero landmarks are the one place in this
 *     world where the two halves live in different files: `landmarks.py` files
 *     their collision under the tile holding each prism's centre, like a
 *     building's, and their geometry is in no tile at all. A check that read
 *     only the tiles therefore reported the Harbour Bridge's parapets, the
 *     Opera House podium and the whole of Luna Park as invisible walls -- 34 of
 *     them, carried in the budget below as an admitted lie for two rounds. See
 *     `readLandmarkPlan`, and item 5 of `runControl`, which is what proves the
 *     vertices came out where the landmark stands.
 *
 * ---------------------------------------------------------------------------
 * ## What "drawn" means here, and why it is a vertex test rather than a cover
 *
 * A prism is **drawn** when the tile's geometry has vertices inside its own
 * footprint. Not a coverage fraction, not a triangle rasterisation: the
 * pipeline's own contract is that *"THE COLLISION POLYGON IS THE DRAWN
 * POLYGON"* (`tiles.write_collision`), and `mesh.build_walls` runs a wall up
 * every edge of that same ring. So a building that was drawn has its own
 * outline's worth of vertices standing on its own ring, and a building that was
 * not has none at all.
 *
 * **The separation is real but it is not enormous, and the check reports it
 * every run rather than asserting it here.** Over the shipped bake, of the
 * 27,381 prisms standing on a carriageway the drawn one that came nearest the
 * line had **7** vertices inside its ring against a threshold of 4, and the
 * undrawn class had none at all. Seven is a margin, not a chasm -- a small
 * four-sided footprint most of whose wall vertices are shared with the party
 * walls either side of it does not have many of its own -- which is exactly why
 * `closestCall` is printed beside the count. If that number ever comes down to
 * the threshold the verdict has become a guess and the test needs a better
 * predicate, and the run that discovers it should be the run that says so.
 *
 * The ring is inflated by `RING_SLOP_M` before the test, and without it the
 * whole thing collapses: a wall vertex sits *on* the ring and the GLB position
 * stream is quantised (`index.geometry.max_position_error_mm` is 5.0 mm on this
 * build), so an exact point-in-polygon test against the ring is a coin toss per
 * vertex. Measured on ten footprints picked for having the fewest hits, the
 * strict ring found 0 to 3 vertices inside and the inflated ring found 26 to 45
 * of the same tile's -- so the strict test would have reported dozens of
 * perfectly ordinary drawn buildings as invisible walls. 0.25 m is fifty times
 * the quantisation error and far under the narrowest gap between two buildings
 * the merge pass will leave.
 *
 * ---------------------------------------------------------------------------
 * ## What is deliberately not counted
 *
 *   - **Anything the player walks under.** A prism whose base clears
 *     `WALKABLE_UNDER_M` over the terrain under it is a viaduct, and `resolve`
 *     has let a body walk under a soffit since the walk-under round. This is
 *     `cli.WALKABLE_UNDER_M` and `invisible-walls.HEAD_ROOM_M`, the third
 *     writing of the same 2.2 m, and it must stay the same number: a check that
 *     drew the line somewhere else would be disagreeing with both authorities
 *     about which volumes are bridges. **And the ground it is measured from is
 *     the drawn one** -- two triangles per cell, north-west to south-east --
 *     because a threshold of 2.2 m asked at the centre of a footprint is asked
 *     at exactly the point where a bilinear patch is furthest from the surface
 *     the pipeline cut and the client draws. See `sampleGround`, which was
 *     bilinear until `clash-check.ts` convicted the identical function, and
 *     item 4 of `runControl`, which is what says so every run.
 *   - **The railway's own solids.** `world/rail-geo.ts` builds platforms,
 *     piers, trench walls and station boxes on the client and registers them
 *     through `CollisionWorld.addPrisms`, and `RailSolidField` is the shared
 *     definition the server derives the same volumes from. They are not in any
 *     tile's bytes, so a file-based check cannot see them and does not pretend
 *     to. `server/rail-gauge-check.ts` and RAIL-CORRIDOR.md's structure gauge
 *     are what hold that side; this file holds the baked side.
 *   - **Overlap under `MIN_ON_ROAD_M2`.** A footprint that clips the corner of
 *     a carriageway quad by a fraction of a square metre is the kerb line
 *     disagreeing with the lane half-width, not a wall.
 *
 * ---------------------------------------------------------------------------
 * ## The budget is a ratchet
 *
 * `UNDRAWN_BUDGET` is set a little above what the shipped bake measures, on
 * `rail-clearance-check.ts`' terms: it is a fence and not a target. The number
 * it guards cannot improve on its own and can get worse from a dozen directions
 * -- a merge pass that drops a mesh but keeps a ring, a station clear that
 * deletes geometry and not collision, a classifier that stops emitting walls
 * for a footprint shape. Whoever lowers the measurement lowers the budget with
 * it. Raising it is how a handful becomes a hundred with nobody noticing.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
// The landmark file's reader. See `readLandmarkPlan`: this is the loader
// `scripts/render-landmark-sheet.mjs` already opens `landmarks.glb` with, and a
// check that hand-rolled a second one would be a check of a copy.
import { NodeIO } from '@gltf-transform/core';
import { CollisionWorld, type Prism } from '../client/src/player/collision.ts';
import { parseTileGlb } from '../client/src/world/tile-decode.ts';
import { decodeStreetNames, translateStreetNames } from '../client/src/world/tile-decode.ts';
import { decodeLanes } from '../client/src/game/traffic.ts';

// --- The budgets -----------------------------------------------------------------

/**
 * How many undrawn solids may stand on a drivable lane, network-wide.
 *
 * Set at the shipped bake's measurement plus a little air. See the header: a
 * ratchet, not a tolerance. Lower it when the count comes down.
 */
export const UNDRAWN_BUDGET = 0;

/**
 * And how much of the carriageway they may cover between them, m2.
 *
 * The second fence, for the same reason `rail-clearance-check.ts` keeps a
 * kilometrage beside a percentage: one big invisible slab and forty small ones
 * are different defects, and a count alone cannot tell them apart.
 */
export const UNDRAWN_AREA_BUDGET_M2 = 0;

/**
 * And how many undrawn solids may stand **anywhere at all**, on a lane or off it.
 *
 * ---------------------------------------------------------------------------
 * THE LANE FILTER WAS A BLIND SPOT AND THIS IS THE LINE THAT ADMITS IT.
 *
 * The first version of this check tested only the prisms standing on a
 * carriageway, on the reasoning that a wall in the road is the one a player
 * drives into. That reasoning was wrong twice over. A player on foot is off the
 * carriageway most of the time -- the footpath, the verge, a park, a car park,
 * the strip between a building and its kerb -- and every one of those is
 * somewhere an invisible wall stops them. And the filter *hid a real class*:
 * with it on the check measured zero, and with it off the same build measures
 * **17**, and the 17 were not one class. Fourteen were `decks.py`'s per-segment
 * versus mitred-frame mismatch: `prisms` built its rings from the segment
 * normal while `_emit_run` drew from `_frames`' mitred per-station normal, so on
 * a curve the solid stood up to 1.06 m from the barrier the player can see, and
 * `_mitred_ring` is the one frame both now use.
 *
 * **The retile of 2026-08-23 ran, and the fourteen are gone.** 1,646 tiles
 * re-emitted; this check then measured **3**, and they were the same three the
 * prediction named, to the metre: Millers Point, (-301.1, -1097.0), (-298.4,
 * -1102.4) and (-257.9, -1075.3) -- `landmarks.BRIDGE_PARAPET_HEIGHT` hero
 * parapets whose geometry lives in `landmarks.glb`, which this check did not
 * open, so they read as undrawn and a landmark-aware check was named as what
 * would clear them. The budget was 3 for exactly those three.
 *
 * **The round of 2026-09-08 measured 34, and every one of the 31 new ones was
 * the same blind spot.** 24 were the Opera House podium and its monumental
 * steps in tile `1_2` (base at sea level, tops climbing -62 to -55 m, 62 to
 * 1,484 m2 each), and 7 were Luna Park in `0_4` -- the two entrance towers, the
 * big top and four posts -- whose collision that retile emits from
 * `landmarks.py` while their meshes live in `landmarks.glb`. Nothing a player
 * could see was missing; the check could not see the landmark file. The budget
 * went to 34 with the fix named in the same breath.
 *
 * ---------------------------------------------------------------------------
 * **THAT FIX IS IN, AND THE NUMBER IS BACK TO ZERO.** `readLandmarkPlan` opens
 * `landmarks.glb` beside the tiles, puts every node's 42,752 vertices into
 * world metres through the node's own transform, and hands them to the *same*
 * predicate the tile geometry goes through -- the same inflated ring, the same
 * vertex count, the same `DRAWN_VERTEX_MIN`. On the 2026-09-08 world all 34
 * are drawn by the landmark file and by no tile -- the nearest of them to the
 * line an Opera House step, at 11 vertices inside its own ring against a
 * threshold of 4 -- and the anywhere count over 1,371,905 prisms is **0**, for
 * 15 s more than the same scan cost while blind. So this is a
 * ratchet at zero again rather than a fence around a known lie, and the number
 * the run prints beside it -- `drawn by landmarks.glb and by no tile` -- is the
 * size of what used to be carried here. A build where that line reads 0 while
 * the landmarks are still in the index has lost the landmark read, and item 5
 * of `runControl` fails before this budget can.
 *
 * So the scan is over every prism now and the lane test is kept only as a
 * *severity* split -- a wall in a trunk carriageway is worse than a wall in a
 * back garden, and the table sorts by it. Both counts are ratcheted, because
 * they can regress independently.
 */
export const UNDRAWN_ANYWHERE_BUDGET = 0;

/**
 * How far a prism's underside must clear the ground before it stops being a
 * wall and becomes something the player walks under, metres.
 *
 * `cli.WALKABLE_UNDER_M` and `invisible-walls.HEAD_ROOM_M`, written a third
 * time on this side. See the header on why it must not drift.
 */
export const WALKABLE_UNDER_M = 2.2;

/**
 * How much carriageway a prism has to stand on before it counts, m2.
 *
 * Below this it is the kerb line disagreeing with the lane's half width rather
 * than a wall. Deliberately the same order as
 * `cmd_carriageway_audit --min-area`.
 */
export const MIN_ON_ROAD_M2 = 4;

/**
 * How far outside its own ring a wall vertex may sit and still be that wall's,
 * metres. See the header: fifty times the position quantisation.
 */
export const RING_SLOP_M = 0.25;

/**
 * How many vertices inside a footprint mean the thing was drawn.
 *
 * Four, and it sits between a measured 7 and a measured 0: over the shipped
 * bake the drawn on-road prism nearest this line had seven vertices inside its
 * own ring, and every undrawn candidate had none. Four rather than one because
 * a single vertex inside a footprint is a neighbour's wall corner clipping in
 * under `RING_SLOP_M`, and rather than six because the margin above is thin
 * enough already. The scan prints the live margin every run; see `MARGIN_CAP`
 * and the header.
 */
export const DRAWN_VERTEX_MIN = 4;

/**
 * How far past `DRAWN_VERTEX_MIN` the vertex count is worth taking.
 *
 * The count exists only to report how near the nearest drawn prism came to
 * being called undrawn, so there is nothing to learn past a couple of dozen and
 * a cap keeps the inner loop off a curtain wall's ten thousand vertices.
 */
const MARGIN_CAP = 32;

// --- The slots -------------------------------------------------------------------

/**
 * The material slots a **building** is drawn in: walls, roofs, the contact
 * skirt and the awning fascia. `mesh.MATERIALS`, minus the street.
 */
const BUILDING_SLOTS = new Set([
  'brick_red', 'brick_cream', 'brick_brown', 'sandstone', 'concrete_precast',
  'curtain_wall', 'corrugated_steel', 'render_painted', 'fibro',
  'roof_terracotta', 'roof_steel', 'contact_ao', 'awning_fascia',
]);

/**
 * And the slots a **deck** is drawn in.
 *
 * `decks.SLOT_DECK` is `road_asphalt` and `decks.SLOT_STRUCTURE` is
 * `footpath_concrete` -- a viaduct reuses the street's materials rather than
 * carrying two of its own, which is why the drawn test for a structural prism
 * cannot be the building one.
 */
const DECK_SLOTS = new Set(['road_asphalt', 'footpath_concrete']);

// --- Options ---------------------------------------------------------------------

function flag(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}
const WORST = Number(flag('worst', '20'));
const NEAR = flag('near', '');
const RADIUS = Number(flag('radius', '400'));
const ROOT = process.env.SYDNEY_WORLD ?? new URL('../client/public/world', import.meta.url).pathname;

const say = (s: string): void => console.log(s);
const pad = (s: string, n: number): string => (s.length >= n ? s : ' '.repeat(n - s.length) + s);
const padR = (s: string, n: number): string => (s.length >= n ? s : s + ' '.repeat(n - s.length));

// --- Geometry --------------------------------------------------------------------

/** Signed-area magnitude of a flat `[x, z, ...]` ring. */
function polyArea(p: ArrayLike<number>): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * A way segment as a CCW quad of half width `hw` -- the carriageway.
 *
 * Per segment rather than per way, because a buffered polyline is a union and
 * this only ever needs the *maximum* overlap with one of its pieces. A prism
 * standing on a road stands on one of its segments; nothing here needs the
 * union's exact area and computing one would need a clipper this file does not
 * have.
 */
function segQuad(x0: number, z0: number, x1: number, z1: number, hw: number): number[] | null {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-6) return null;
  const nx = (-dz / len) * hw;
  const nz = (dx / len) * hw;
  const q = [x0 + nx, z0 + nz, x1 + nx, z1 + nz, x1 - nx, z1 - nz, x0 - nx, z0 - nz];
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    a += q[i * 2] * q[j * 2 + 1] - q[j * 2] * q[i * 2 + 1];
  }
  if (a < 0) return [q[6], q[7], q[4], q[5], q[2], q[3], q[0], q[1]];
  return q;
}

/**
 * Sutherland-Hodgman: the part of `subj` inside the **convex** `clip`.
 *
 * The clip is always a carriageway quad and a quad is convex, which is the
 * whole precondition this algorithm has. The subject is a building footprint
 * and may be concave -- the result can then carry a degenerate edge, and its
 * *area* is still exact, which is the only thing read out of it.
 */
function clipPoly(subj: number[], clip: number[]): number[] {
  let out = subj;
  const m = clip.length / 2;
  for (let e = 0; e < m && out.length > 0; e++) {
    const ax = clip[e * 2];
    const az = clip[e * 2 + 1];
    const bx = clip[((e + 1) % m) * 2];
    const bz = clip[((e + 1) % m) * 2 + 1];
    const ex = bx - ax;
    const ez = bz - az;
    const next: number[] = [];
    const n = out.length / 2;
    for (let i = 0; i < n; i++) {
      const px = out[i * 2];
      const pz = out[i * 2 + 1];
      const qx = out[((i + 1) % n) * 2];
      const qz = out[((i + 1) % n) * 2 + 1];
      const sp = ex * (pz - az) - ez * (px - ax);
      const sq = ex * (qz - az) - ez * (qx - ax);
      if (sp >= 0) next.push(px, pz);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push(px + (qx - px) * t, pz + (qz - pz) * t);
      }
    }
    out = next;
  }
  return out;
}

/** Is `(x, z)` inside the ring? Even-odd, on the ring's own points. */
function inRing(pts: ArrayLike<number>, x: number, z: number): boolean {
  let hit = false;
  const n = pts.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i * 2];
    const zi = pts[i * 2 + 1];
    const xj = pts[j * 2];
    const zj = pts[j * 2 + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/**
 * The ring pushed out by `RING_SLOP_M` about its own centroid.
 *
 * A centroid scale rather than a proper polygon offset, and it is enough for
 * what it is for: absorbing 5 mm of position quantisation on a vertex that is
 * *on* the ring. A real offset would need the edge normals and a self-
 * intersection pass, and would move a 6 m footprint's corners by the same
 * quarter metre this does.
 */
function inflate(pts: ArrayLike<number>, by: number): number[] {
  const n = pts.length / 2;
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) { cx += pts[i * 2]; cz += pts[i * 2 + 1]; }
  cx /= n;
  cz /= n;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const dx = pts[i * 2] - cx;
    const dz = pts[i * 2 + 1] - cz;
    const d = Math.sqrt(dx * dx + dz * dz) || 1;
    out.push(cx + dx * (1 + by / d), cz + dz * (1 + by / d));
  }
  return out;
}

// --- The world ---------------------------------------------------------------------

interface TileEntry { key: string; b: number; bounds: [number, number, number, number]; }
/** What `landmarks.LandmarkContract` puts in the index. Only the two fields read here. */
interface LandmarkContract {
  file: string;
  items: Array<{ name: string; anchor_world: [number, number, number] }>;
}
interface WorldIndex {
  tile_size: number;
  terrain: { grid: number };
  tiles: TileEntry[];
  /** Absent on a world built before the hero landmarks. See `readLandmarkPlan`. */
  landmarks?: LandmarkContract;
}

const index = JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')) as WorldIndex;
const SIZE = index.tile_size;
const GRID = index.terrain.grid;
const byKey = new Map<string, TileEntry>(index.tiles.map((t) => [t.key, t]));

function read(key: string, ext: string): ArrayBuffer | null {
  const p = join(ROOT, ext === 'bin' ? 'collision' : 'tiles', ext === 'bin' ? `${key}.bin` : `${key}.${ext}`);
  if (!existsSync(p)) return null;
  const b = readFileSync(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** One tile's prisms, through the real class so `structural` is the real flag. */
function prismsOf(t: TileEntry): Prism[] {
  const buf = read(t.key, 'bin');
  if (buf === null) return [];
  const w = new CollisionWorld();
  w.addTile(t.key, buf, t.bounds[0], t.bounds[1] + SIZE, t.b);
  return w.prismsWithin((t.bounds[0] + t.bounds[2]) / 2, (t.bounds[1] + t.bounds[3]) / 2, SIZE * 1.5);
}

/** One tile's terrain grid, or null. Row 0 is the northern edge. */
function groundOf(key: string): Float32Array | null {
  const buf = read(key, 'terr.bin');
  if (buf === null) return null;
  return new Float32Array(buf);
}
/**
 * The ground at a point in one tile: **two triangles per cell, split north-west
 * to south-east**, which is the surface the pipeline cut and the client draws.
 *
 * ---------------------------------------------------------------------------
 * **This was bilinear, and `server/clash-check.ts` had already convicted the
 * identical function.** That file's `sampleGround` header names this one by
 * name -- *"`undrawn-solids-check.sampleGround` is still bilinear"* -- and the
 * row it produced over there was 63,089 water vertices out of nothing at all:
 * the two surfaces differ by the cell's *twist*, `(nw + se - ne - sw) / 4`,
 * which is zero on a footpath and metres on a harbour cliff.
 *
 * What that costs **here** is smaller and is worth stating exactly, because it
 * is not nothing. The only thing this file asks the ground is the walk-under
 * rule: `p.base - g >= WALKABLE_UNDER_M` decides whether a prism is a viaduct
 * the player walks under or a wall they are stopped by, and it asks it at the
 * *centre of the footprint* -- which is the one place in a cell where the twist
 * peaks. So a bilinear read moved that one comparison by up to the twist of the
 * cell the prism stands in, in either direction, and 2.2 m is a threshold a
 * decimetre either way can cross. A prism excused as a bridge that is really a
 * wall is a silent hole in a ratchet that reads zero.
 *
 * `terrain.Terrain.sample`'s note -- *"Change one and all three must change
 * together"* -- has four readers and this is the fourth. `runControl` asserts
 * the split with a hand-made twisted cell rather than trusting this paragraph:
 * a pole check cannot tell the two surfaces apart, which is exactly how the
 * bilinear read survived in `clash-check.ts` for as long as it did.
 */
function sampleGround(g: Float32Array, t: TileEntry, x: number, z: number): number {
  const lx = ((x - t.bounds[0]) / SIZE) * GRID;
  const lz = ((z - t.bounds[1]) / SIZE) * GRID;
  const c0 = Math.max(0, Math.min(GRID - 1, Math.floor(lx)));
  const r0 = Math.max(0, Math.min(GRID - 1, Math.floor(lz)));
  const fc = Math.max(0, Math.min(1, lx - c0));
  const fr = Math.max(0, Math.min(1, lz - r0));
  const at = (r: number, c: number): number => g[r * (GRID + 1) + c];
  const nw = at(r0, c0);
  const ne = at(r0, c0 + 1);
  const sw = at(r0 + 1, c0);
  const se = at(r0 + 1, c0 + 1);
  // The diagonal runs north-west to south-east, so it is the line fr === fc. On
  // the north-east side of it the triangle is NW/NE/SE; on the other, NW/SE/SW.
  // Both expressions agree along the diagonal, so there is no seam inside a cell.
  return fc >= fr
    ? nw + (ne - nw) * fc + (se - ne) * fr
    : nw + (sw - nw) * fr + (se - sw) * fc;
}

/** The plan positions of everything drawn in `slots`, in world metres. */
function planPoints(t: TileEntry, slots: Set<string>): Float64Array {
  const buf = read(t.key, 'glb');
  if (buf === null) return new Float64Array(0);
  let glb;
  try { glb = parseTileGlb(buf, 0); } catch { return new Float64Array(0); }
  const ox = t.bounds[0];
  const oz = t.bounds[1] + SIZE;
  const xs: number[] = [];
  for (const p of glb.primitives) {
    if (!slots.has(p.material)) continue;
    const pos = p.attributes.find((a) => a.name === 'position');
    if (pos === undefined) continue;
    const a = pos.array as Float32Array;
    for (let i = 0; i + 2 < a.length; i += 3) xs.push(a[i] + ox, a[i + 2] + oz);
  }
  return Float64Array.from(xs);
}

// --- The landmark file -------------------------------------------------------------

/**
 * Which tile a world point falls in, by the index's own arithmetic.
 *
 * `index.json` writes a tile's bounds as `[tx*S, -(tz+1)*S, (tx+1)*S, -tz*S]` --
 * x runs east with the key's first field and z runs *south*, against the second,
 * because the world frame is `(east, up, -north)`. This is that relation read
 * backwards, and `runControl` asserts it against every tile in the build rather
 * than leaving it as a comment: a key derived one tile out would file the Opera
 * House's vertices under the tile next door, and the only symptom would be an
 * offender count that stayed exactly where it was.
 */
function tileKeyAt(x: number, z: number): string {
  return `${Math.floor(x / SIZE)}_${Math.floor(-z / SIZE)}`;
}

/**
 * The hero landmarks' own vertices, in world metres, filed under the tile that
 * holds each one.
 *
 * ---------------------------------------------------------------------------
 * **This file is the fourth source and the reason the anywhere count was a lie
 * for two rounds.** `landmarks.py` emits a collision prism for every volume of
 * the bridge, the Opera House, the tower and Luna Park, and files each one under
 * the tile holding its centre -- so the prisms arrive in `collision/<tile>.bin`
 * like any building's. Their *geometry* does not: it is in one `landmarks.glb`
 * loaded once beside `far.bin` (`world/landmarks.ts`), and never in a tile's
 * `.glb` at all. A check that opened only the tile files therefore found 34
 * solids with nothing drawn over them in a city where a player can see all 34,
 * and the budget carried them as an admitted blind spot.
 *
 * The vertices come out in **world** metres, which is where the two frames meet:
 * the GLB puts each landmark's positions in metres about its own anchor so a
 * 1.7 km bridge keeps millimetre resolution in float32, and the anchor rides on
 * the node above the mesh as `(east, 0, -north)`. So the node transform is the
 * whole registration and it is applied here exactly as `loadLandmarks` bakes it
 * into the geometry on the client and as `render-landmark-sheet.mjs` applies it
 * to draw the sheet -- `getWorldMatrix`, per node, per vertex. Drop it and every
 * landmark lands on the Town Hall with the same triangle count, which is the
 * failure the control's positive half is aimed at.
 *
 * Bucketed by tile because the scan is by tile and the alternative is 42,752
 * vertices tested against all 1.37 million prisms. A prism is filed by its own
 * centre and can overhang its tile -- by half a deck segment at the worst, which
 * is 12.5 m -- so the scan gathers the eight neighbours too, the same 3 x 3 the
 * lanes are gathered over.
 */
interface LandmarkPlan {
  /** `[x, z, ...]` per tile key, world metres. */
  buckets: Map<string, Float64Array>;
  /** Each node's plan extent, `[minX, minZ, maxX, maxZ]`. For the control. */
  extent: Map<string, [number, number, number, number]>;
  /** The node names built, in file order. */
  names: string[];
  vertices: number;
}

const NO_POINTS = new Float64Array(0);

/**
 * Read `landmarks.glb` once, through the loader the landmark sheet already uses.
 *
 * Loud on every failure that is not "this world has no landmark set at all",
 * because the quiet version of this function is a check that reports zero
 * undrawn solids by reading no geometry. A build whose index carries a
 * `landmarks` block and whose file will not open is a build whose 34 landmark
 * prisms would be excused by an empty vertex list -- the exact defect the
 * blind spot was. `runControl` is the other half: it proves the vertices that
 * did come out are standing where the landmark is.
 */
async function readLandmarkPlan(): Promise<LandmarkPlan> {
  const plan: LandmarkPlan = { buckets: new Map(), extent: new Map(), names: [], vertices: 0 };
  const contract = index.landmarks;
  if (contract === undefined) return plan;

  const path = join(ROOT, contract.file);
  if (!existsSync(path)) {
    throw new Error(
      `index.json names a landmark set at ${contract.file} and ${path} does not exist. ` +
        `Every hero landmark's collision is in the tiles and none of its geometry is, so this ` +
        `run would report all of it as invisible walls.`,
    );
  }
  // Plain `NodeIO`, no extensions registered: the shipped file uses none, and a
  // build that started quantising positions should stop this check dead rather
  // than have it read a mesh it half understands. `render-landmark-sheet.mjs`
  // registers the Khronos set and is the place to copy from when that day comes.
  const doc = await new NodeIO().read(path);

  const loose = new Map<string, number[]>();
  const v = [0, 0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh === null) continue;
    const name = node.getName();
    plan.names.push(name);
    const m = node.getWorldMatrix();
    let box = plan.extent.get(name);
    if (box === undefined) {
      box = [Infinity, Infinity, -Infinity, -Infinity];
      plan.extent.set(name, box);
    }
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION');
      if (pos === null) continue;
      for (let i = 0; i < pos.getCount(); i++) {
        pos.getElement(i, v);
        // Column-major, as glTF stores it: translation in 12/13/14. Only x and z
        // are kept -- the drawn test is a plan test, here as for a building.
        const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
        const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
        const key = tileKeyAt(x, z);
        let bucket = loose.get(key);
        if (bucket === undefined) { bucket = []; loose.set(key, bucket); }
        bucket.push(x, z);
        if (x < box[0]) box[0] = x;
        if (z < box[1]) box[1] = z;
        if (x > box[2]) box[2] = x;
        if (z > box[3]) box[3] = z;
        plan.vertices++;
      }
    }
  }
  for (const [key, pts] of loose) plan.buckets.set(key, Float64Array.from(pts));
  return plan;
}

const LANDMARKS = await readLandmarkPlan();

/** This tile's lane ways, in world metres, or an empty list. */
function waysOf(t: TileEntry): Array<{ x: Float32Array; z: Float32Array; halfWidth: number; klass: number; osmId: number }> {
  const buf = read(t.key, 'lanes.bin');
  if (buf === null) return [];
  const lanes = decodeLanes(buf, t.bounds[0], t.bounds[1] + SIZE);
  return lanes === null ? [] : lanes.ways;
}

/** The nearest named centreline to a point, for the table. */
function streetAt(t: TileEntry, x: number, z: number): string {
  const buf = read(t.key, 'names.bin');
  if (buf === null) return '';
  const names = decodeStreetNames(buf);
  if (names === null) return '';
  translateStreetNames(names, t.bounds[0], t.bounds[1] + SIZE);
  let best = Infinity;
  let name = '';
  for (const seg of names.segments) {
    if (x < seg.minX - 60 || x > seg.maxX + 60 || z < seg.minZ - 60 || z > seg.maxZ + 60) continue;
    for (let i = 0; i + 1 < seg.points.length / 2; i++) {
      const dx = x - seg.points[i * 2];
      const dz = z - seg.points[i * 2 + 1];
      const d = dx * dx + dz * dz;
      if (d < best) { best = d; name = seg.name; }
    }
  }
  return name;
}

// --- The scan ------------------------------------------------------------------------

interface Offender {
  key: string;
  onRoad: number;
  area: number;
  base: number;
  top: number;
  structural: boolean;
  x: number;
  z: number;
  klass: number;
  osmId: number;
}

const CLASSES: string[] = (JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')).lanes?.classes ?? []) as string[];

let centre: [number, number] | null = null;
if (NEAR !== '') {
  const [a, b] = NEAR.split(',').map(Number);
  centre = [a, b];
}

const scope = centre === null
  ? index.tiles
  : index.tiles.filter((t) => {
      const dx = Math.max(t.bounds[0] - centre![0], 0, centre![0] - t.bounds[2]);
      const dz = Math.max(t.bounds[1] - centre![1], 0, centre![1] - t.bounds[3]);
      return dx * dx + dz * dz <= RADIUS * RADIUS;
    });

say(
  `undrawn solids -- ${scope.length.toLocaleString()} tiles` +
    (centre === null ? '' : ` within ${RADIUS} m of (${centre[0]}, ${centre[1]})`),
);

const waysCache = new Map<string, ReturnType<typeof waysOf>>();
function neighbourWays(t: TileEntry): ReturnType<typeof waysOf> {
  const [tx, tz] = t.key.split('_').map(Number);
  const out: ReturnType<typeof waysOf> = [];
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const k = `${tx + ax}_${tz + az}`;
      const n = byKey.get(k);
      if (n === undefined) continue;
      let w = waysCache.get(k);
      if (w === undefined) { w = waysOf(n); waysCache.set(k, w); }
      out.push(...w);
    }
  }
  return out;
}

const landmarkCache = new Map<string, Float64Array>();
/**
 * Every landmark vertex near one tile: its own bucket and its eight neighbours'.
 *
 * The same 3 x 3 `neighbourWays` takes, for the same reason -- a prism is filed
 * under the tile holding its centre and its ring can hang over the edge -- and
 * one shared empty array for the 22,900 tiles that have no landmark near them,
 * so the tiles that are not the harbour pay a map lookup and nothing else.
 */
function landmarksNear(key: string): Float64Array {
  const cached = landmarkCache.get(key);
  if (cached !== undefined) return cached;
  const [tx, tz] = key.split('_').map(Number);
  const parts: Float64Array[] = [];
  let n = 0;
  for (let ax = -1; ax <= 1; ax++) {
    for (let az = -1; az <= 1; az++) {
      const b = LANDMARKS.buckets.get(`${tx + ax}_${tz + az}`);
      if (b === undefined) continue;
      parts.push(b);
      n += b.length;
    }
  }
  let out = NO_POINTS;
  if (n > 0) {
    out = new Float64Array(n);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
  }
  landmarkCache.set(key, out);
  return out;
}

const offenders: Offender[] = [];
let prismsSeen = 0;
let onRoadPrisms = 0;
let onRoadArea = 0;
let walkUnder = 0;
let tilesWithRoad = 0;
/**
 * The fewest vertices any *drawn* on-road prism had inside its own ring.
 *
 * The margin on `DRAWN_VERTEX_MIN`. A number close to the threshold means the
 * separation this check rests on has stopped being total and the verdict has
 * become a guess -- see the header on why the test is a vertex count.
 */
let closestCall = Number.POSITIVE_INFINITY;
/**
 * How many prisms nothing in a tile draws and `landmarks.glb` does.
 *
 * The size of the blind spot, reported every run rather than remembered in a
 * comment: this is the population the anywhere budget used to carry. If it ever
 * reads zero on a build that has a landmark set, the landmark read has come
 * apart and the control below is what says so.
 */
let landmarkDrawn = 0;
/** The margin on `DRAWN_VERTEX_MIN` for that population, kept apart. See `closestCall`. */
let closestLandmark = Number.POSITIVE_INFINITY;
const t0 = Date.now();

for (const t of scope) {
  const prisms = prismsOf(t);
  if (prisms.length === 0) continue;
  // A tile with no lane sidecar still gets scanned -- its prisms are off-lane
  // by definition, and the class this check was blind to lives exactly there.
  const ways = neighbourWays(t);
  tilesWithRoad++;
  prismsSeen += prisms.length;

  // Every prism, with how much carriageway it stands on -- which is a severity
  // number now rather than a filter. See UNDRAWN_ANYWHERE_BUDGET.
  const standing: Array<{ p: Prism; on: number; klass: number; osmId: number }> = [];
  for (const p of prisms) {
    let best = 0;
    let klass = -1;
    let osmId = 0;
    for (const w of ways) {
      if (w.halfWidth <= 0) continue;
      const hw = w.halfWidth;
      for (let i = 0; i + 1 < w.x.length; i++) {
        const lo = Math.min(w.x[i], w.x[i + 1]) - hw;
        const hi = Math.max(w.x[i], w.x[i + 1]) + hw;
        if (p.maxX < lo || p.minX > hi) continue;
        const zlo = Math.min(w.z[i], w.z[i + 1]) - hw;
        const zhi = Math.max(w.z[i], w.z[i + 1]) + hw;
        if (p.maxZ < zlo || p.minZ > zhi) continue;
        const q = segQuad(w.x[i], w.z[i], w.x[i + 1], w.z[i + 1], hw);
        if (q === null) continue;
        const a = polyArea(clipPoly(Array.from(p.points), q));
        if (a > best) { best = a; klass = w.klass; osmId = w.osmId; }
      }
    }
    standing.push({ p, on: best >= MIN_ON_ROAD_M2 ? best : 0, klass, osmId });
    if (best >= MIN_ON_ROAD_M2) onRoadPrisms++;
  }
  if (standing.length === 0) continue;

  // The walk-under rule, before the geometry is opened: a viaduct over a street
  // is not a wall and its GLB is not worth reading.
  const ground = groundOf(t.key);
  const live = standing.filter(({ p }) => {
    if (ground === null) return true;
    const g = sampleGround(ground, t, (p.minX + p.maxX) / 2, (p.minZ + p.maxZ) / 2);
    if (!Number.isFinite(g)) return true;
    if (p.base - g >= WALKABLE_UNDER_M) { walkUnder++; return false; }
    return true;
  });
  if (live.length === 0) continue;

  const bld = planPoints(t, BUILDING_SLOTS);
  const deck = planPoints(t, DECK_SLOTS);
  // And what the landmark file draws over this tile, which is nothing at all for
  // every tile that is not on the harbour or under the tower. See LandmarkPlan.
  const lmk = landmarksNear(t.key);
  for (const { p, on, klass, osmId } of live) {
    const ring = inflate(p.points, RING_SLOP_M);
    /**
     * How many of `verts` fall inside this prism's ring, counted to `MARGIN_CAP`.
     *
     * Counted rather than short-circuited at `DRAWN_VERTEX_MIN`, and the extra
     * work buys the one number that says whether the threshold is arbitrary:
     * `closestCall` below. A test whose verdict is a threshold has to report
     * how near anything came to it, or the day the separation stops being
     * total is the day this silently starts guessing.
     */
    const insideCount = (verts: Float64Array): number => {
      let n = 0;
      for (let i = 0; i < verts.length; i += 2) {
        const x = verts[i];
        const z = verts[i + 1];
        if (x < p.minX - RING_SLOP_M || x > p.maxX + RING_SLOP_M) continue;
        if (z < p.minZ - RING_SLOP_M || z > p.maxZ + RING_SLOP_M) continue;
        if (inRing(ring, x, z) && ++n >= MARGIN_CAP) return n;
      }
      return n;
    };
    // Either slot family answers, because a prism does not carry which module
    // drew it and a deck is drawn in the street's materials. See DECK_SLOTS.
    const tileHits = Math.max(insideCount(bld), insideCount(deck));
    // And the landmark file answers last, on the identical predicate -- the same
    // inflated ring, the same vertex count, the same threshold -- because "drawn"
    // must not mean two different things depending on which file drew it. Asked
    // only when the tiles have already failed to draw the thing, so the harbour
    // pays for it and the other 22,900 tiles do not.
    const lmkHits = tileHits >= DRAWN_VERTEX_MIN || lmk.length === 0 ? 0 : insideCount(lmk);
    const hits = Math.max(tileHits, lmkHits);
    if (hits >= DRAWN_VERTEX_MIN) {
      // The two margins are kept apart on purpose: the tile population is 1.37
      // million prisms and the landmark one is 380, and averaging a hero
      // landmark's thousands of vertices into `closestCall` would hide the day
      // the city's own separation stopped being total.
      if (tileHits >= DRAWN_VERTEX_MIN) {
        if (tileHits < closestCall) closestCall = tileHits;
      } else {
        landmarkDrawn++;
        if (lmkHits < closestLandmark) closestLandmark = lmkHits;
      }
      continue;
    }
    if (on > 0) onRoadArea += on;
    offenders.push({
      key: t.key, onRoad: on, area: polyArea(p.points), base: p.base, top: p.top,
      structural: p.structural, x: (p.minX + p.maxX) / 2, z: (p.minZ + p.maxZ) / 2, klass, osmId,
    });
  }
}

const secs = (Date.now() - t0) / 1000;
const onLane = offenders.filter((o) => o.onRoad > 0).length;
say(`  ${tilesWithRoad.toLocaleString()} tiles carry a prism; ${prismsSeen.toLocaleString()} prisms read in ${secs.toFixed(0)} s`);
say(`  ${onRoadPrisms.toLocaleString()} of them stand on a carriageway by ${MIN_ON_ROAD_M2} m2 or more`);
say(`  ${walkUnder.toLocaleString()} clear ${WALKABLE_UNDER_M} m over the ground and are walked under, not into`);
say(
  `  ${landmarkDrawn.toLocaleString()} are drawn by landmarks.glb and by no tile -- ` +
    `${LANDMARKS.vertices.toLocaleString()} vertices over ${LANDMARKS.names.length} nodes ` +
    `(${LANDMARKS.names.join(', ') || 'none in this build'})`,
);
say(`  ${offenders.length.toLocaleString()} are SOLID AND UNDRAWN anywhere at all`);
say(`  ${onLane.toLocaleString()} of those stand on a drivable lane -- ${onRoadArea.toFixed(0)} m2 of carriageway`);
say(
  `  margin: the drawn prism nearest the line had ` +
    `${Number.isFinite(closestCall) ? closestCall : 0} vertices inside its own ring, against a ` +
    `threshold of ${DRAWN_VERTEX_MIN}${closestCall >= MARGIN_CAP ? ' (capped)' : ''}`,
);
say(
  `  margin: the landmark-drawn prism nearest the line had ` +
    `${Number.isFinite(closestLandmark) ? closestLandmark : 0} vertices inside its own ring` +
    `${Number.isFinite(closestLandmark) && closestLandmark >= MARGIN_CAP ? ' (capped)' : ''}`,
);

if (offenders.length > 0) {
  offenders.sort((a, b) => b.onRoad - a.onRoad);
  say('');
  say('   on road    plan  base   top  S  class         street                      tile     centre');
  for (const o of offenders.slice(0, WORST)) {
    const t = byKey.get(o.key)!;
    const street = streetAt(t, o.x, o.z);
    say(
      `  ${pad(o.onRoad.toFixed(0), 7)} ${pad(o.area.toFixed(0), 7)} ${pad(o.base.toFixed(1), 6)} ${pad(o.top.toFixed(1), 5)}  ` +
        `${o.structural ? 'S' : 'b'}  ${padR(CLASSES[o.klass] ?? '?', 13)} ${padR(street || '(unnamed)', 27)} ` +
        `${padR(o.key, 8)} (${o.x.toFixed(1)}, ${o.z.toFixed(1)})`,
    );
  }
  if (offenders.length > WORST) say(`  ... and ${offenders.length - WORST} more; --worst N for more`);
}

// --- THE CONTROL --------------------------------------------------------------------
//
// **A zero here is worthless without this and the pipeline already knows it.**
// `cli.cmd_station_clear_audit` says it in as many words -- *"Zero there means
// the envelope is empty or the test is blind, and either way the pass above
// means nothing"* -- and this check reports zero over the whole build, so it is
// exactly the audit that has to prove it can see one.
//
// The control is a synthetic prism dropped on a real carriageway with nothing
// drawn over it, and it is dropped at **Pacific Highway at Critchett Road, West
// Chatswood** on purpose: that is the spot a player reported an invisible wall
// at, this check found no baked solid there, and the way to say "there is
// nothing there" honestly is to show that a wall in that exact place would be
// named. It is put through the same three predicates the scan runs -- standing
// on a carriageway, not walked under, no geometry inside its ring -- and if any
// of them lets it past, the scan above is blind and this exits non-zero
// whatever the count said.
export const CONTROL_X = -2884.1;
export const CONTROL_Z = -7417.7;
/** A 12 m box, which is a small building and comfortably over MIN_ON_ROAD_M2. */
const CONTROL_HALF = 6;

/**
 * And the landmark half of the control: which node it stands under.
 *
 * The Opera House, because 24 of the 31 solids the last round added to the
 * blind spot were its podium and its steps, and because its anchor is the one
 * point about it this file can name without hard-coding a number that a retile
 * could move -- `index.json` carries `anchor_world` per landmark and the
 * pipeline puts it at the OSM footprint's own centroid, which is under the
 * building by construction.
 *
 * The positive half is what catches the failure this whole section is exposed
 * to: `readLandmarkPlan` applies each node's transform, and a read that dropped
 * it would come back with the right vertex count, the right extent *shape*, and
 * every landmark stacked on the Town Hall. Nothing in the counts above would
 * move -- the offenders would go on reading undrawn and the budget would go on
 * being blamed. A box under the shells with nothing in it is the one thing that
 * says so out loud.
 */
export const CONTROL_LANDMARK = 'opera_house';
/**
 * And how far past that landmark's own easternmost vertex its negative twin
 * stands, metres.
 *
 * Five, and measured from the **extent** rather than from a hand-picked empty
 * spot, because that is the only way to say "outside it" about a shape this
 * file does not otherwise model: past the extent there is no vertex of that
 * landmark at any y, so a hit there is the ring test answering yes to a place
 * the landmark cannot reach. Five metres rather than fifty because the twin has
 * to stay in the same tile bucket as the positive: a negative that passed by
 * being somewhere else entirely would prove nothing about the predicate.
 */
const CONTROL_CLEAR_M = 5;

function runControl(): string[] {
  const bad: string[] = [];
  const t = index.tiles.find(
    (e) => CONTROL_X >= e.bounds[0] && CONTROL_X < e.bounds[2] && CONTROL_Z >= e.bounds[1] && CONTROL_Z < e.bounds[3],
  );
  if (t === undefined) return ['the control point is not in any tile of this build'];

  const ring = [
    CONTROL_X - CONTROL_HALF, CONTROL_Z - CONTROL_HALF,
    CONTROL_X + CONTROL_HALF, CONTROL_Z - CONTROL_HALF,
    CONTROL_X + CONTROL_HALF, CONTROL_Z + CONTROL_HALF,
    CONTROL_X - CONTROL_HALF, CONTROL_Z + CONTROL_HALF,
  ];

  // 1. It stands on a carriageway.
  let on = 0;
  let klass = -1;
  for (const w of neighbourWays(t)) {
    if (w.halfWidth <= 0) continue;
    for (let i = 0; i + 1 < w.x.length; i++) {
      const q = segQuad(w.x[i], w.z[i], w.x[i + 1], w.z[i + 1], w.halfWidth);
      if (q === null) continue;
      const a = polyArea(clipPoly(ring.slice(), q));
      if (a > on) { on = a; klass = w.klass; }
    }
  }
  if (on < MIN_ON_ROAD_M2) {
    bad.push(
      `the control prism at (${CONTROL_X}, ${CONTROL_Z}) overlaps the carriageway by only ` +
        `${on.toFixed(1)} m2. Either the lane sidecar for tile ${t.key} stopped carrying the ` +
        `Pacific Highway, or the carriageway sweep is broken -- in which case the scan above ` +
        `looked at no road at all.`,
    );
  }

  // 2. It is not walked under. The control's base is the ground it stands on,
  //    which is what a wall is, so the soffit rule must let it through -- a
  //    walk-under threshold that had drifted to zero or below would silently
  //    excuse every wall in the city and this is the line that catches it.
  const ground = groundOf(t.key);
  const g = ground === null ? 0 : sampleGround(ground, t, CONTROL_X, CONTROL_Z);
  if (!(WALKABLE_UNDER_M > 0)) {
    bad.push(
      `WALKABLE_UNDER_M is ${WALKABLE_UNDER_M}, so a prism whose base is the ground under it ` +
        `is excused as something the player walks under. Every wall in the city would pass.`,
    );
  }
  if (ground === null || !Number.isFinite(g)) {
    bad.push(
      `tile ${t.key} has no readable terrain, so the walk-under rule could not be applied there ` +
        `and every prism on it was counted as a wall.`,
    );
  }

  // 3. And nothing is drawn inside it. This is the predicate that actually
  //    decides the scan, so a control that could not fail it would prove
  //    nothing. The deck slots *are* the street and a box on a road does
  //    contain road vertices, so what is asserted is the building half: a wall
  //    standing here would be drawn in a building slot, and 9 m from the
  //    Critchett Road junction, in the middle of the carriageway, none is.
  const inflated = inflate(ring, RING_SLOP_M);
  let bldVerts = 0;
  const bldSet = planPoints(t, BUILDING_SLOTS);
  for (let i = 0; i < bldSet.length; i += 2) {
    if (inRing(inflated, bldSet[i], bldSet[i + 1])) bldVerts++;
  }
  if (bldVerts >= DRAWN_VERTEX_MIN) {
    bad.push(
      `the control found ${bldVerts} building vertices inside a 12 m box in the middle of the ` +
        `Pacific Highway, so the drawn test cannot tell a wall from an empty street.`,
    );
  }

  // 4. And the ground under all of it is read the way the world is *drawn* --
  //    two triangles per cell, split north-west to south-east -- which is a
  //    thing only a control can say. Item 2 above cannot: it asks whether the
  //    terrain is readable and finite, and a bilinear patch is both. Nor can a
  //    real place, because the two surfaces differ by the cell's *twist* and
  //    every cell a footpath crosses has none -- which is exactly how the
  //    bilinear read survived in `clash-check.ts` until a harbour sheet found
  //    it. So the twist is put in by hand, on that file's own numbers: a cell
  //    with nw=0, ne=10, sw=10, se=0 read at its centre is 5 m under either
  //    surface (the two agree along the diagonal), so the probe is off the
  //    diagonal at three quarters east and one quarter south, where the
  //    NW/NE/SE triangle gives 0 + 10(0.75) - 10(0.25) = 5.00 and bilinear
  //    gives (10)(0.75)(0.75) + (10)(0.25)(0.25) = 6.25.
  const twistProbe = ((): number => {
    const n = GRID + 1;
    const cell = new Float32Array(n * n);
    cell[0] = 0; cell[1] = 10; cell[n] = 10; cell[n + 1] = 0;
    const fake: TileEntry = { key: '0_0', b: 0, bounds: [0, 0, SIZE, SIZE] };
    const post = SIZE / GRID;
    return sampleGround(cell, fake, 0.75 * post, 0.25 * post);
  })();
  if (Math.abs(twistProbe - 5.0) > 1e-6) {
    bad.push(
      `the terrain read is not the north-west-to-south-east split: a twisted cell reads ` +
        `${twistProbe.toFixed(2)} m where the triangle it is in says 5.00 (bilinear would say 6.25). ` +
        `The walk-under rule is a 2.2 m threshold asked at the centre of a footprint, which is ` +
        `where a cell's twist peaks, so a prism can be excused as a bridge that is really a wall. ` +
        `terrain.Terrain.sample, tiles.write_terrain, world/terrain.ts sampleTileGrid and ` +
        `clash-check.sampleGround are the other four readers of this split.`,
    );
  }

  // 5. And a box under a landmark is drawn, while the same box outside it is
  //    not. The whole of this round is one predicate -- "landmarks.glb has
  //    vertices inside this ring" -- and it can fail in two directions that a
  //    count cannot tell apart. A read that lost the node transforms answers no
  //    everywhere, which looks exactly like the blind spot it replaced; a read
  //    that answered yes for any prism *near* a landmark would excuse a genuine
  //    invisible wall standing beside the Opera House, which is worse than the
  //    blind spot because it is silent. So the positive and the negative are
  //    both asserted, on one box and its own translation.
  const landmarkBox = (cx: number, cz: number): number => {
    const boxRing = inflate(
      [
        cx - CONTROL_HALF, cz - CONTROL_HALF, cx + CONTROL_HALF, cz - CONTROL_HALF,
        cx + CONTROL_HALF, cz + CONTROL_HALF, cx - CONTROL_HALF, cz + CONTROL_HALF,
      ],
      RING_SLOP_M,
    );
    const cloud = landmarksNear(tileKeyAt(cx, cz));
    let n = 0;
    for (let i = 0; i < cloud.length; i += 2) {
      if (inRing(boxRing, cloud[i], cloud[i + 1])) n++;
    }
    return n;
  };
  let under = 0;
  let beside = 0;
  let lmX = 0;
  let lmZ = 0;
  const item = index.landmarks?.items.find((i) => i.name === CONTROL_LANDMARK);
  const extent = LANDMARKS.extent.get(CONTROL_LANDMARK);
  if (index.landmarks === undefined) {
    bad.push(
      `this build's index.json has no landmarks block, so nothing was read out of a landmark ` +
        `file and every hero landmark's collision -- the bridge's parapets, the Opera House ` +
        `podium and steps, Luna Park -- would be counted as an invisible wall.`,
    );
  } else if (item === undefined || extent === undefined) {
    bad.push(
      `${CONTROL_LANDMARK} is not in this build: the index names ` +
        `${index.landmarks.items.map((i) => i.name).join(', ') || 'nothing'} and landmarks.glb ` +
        `carries ${LANDMARKS.names.join(', ') || 'no node with a mesh'}. The control cannot ask ` +
        `its question and the landmark half of the scan is unproven.`,
    );
  } else {
    lmX = item.anchor_world[0];
    lmZ = item.anchor_world[2];
    under = landmarkBox(lmX, lmZ);
    beside = landmarkBox(extent[2] + CONTROL_CLEAR_M + CONTROL_HALF, lmZ);
    if (under < DRAWN_VERTEX_MIN) {
      bad.push(
        `a ${CONTROL_HALF * 2} m box under ${CONTROL_LANDMARK}'s own anchor ` +
          `(${lmX.toFixed(1)}, ${lmZ.toFixed(1)}) holds ${under} landmark vertices, against a ` +
          `threshold of ${DRAWN_VERTEX_MIN}. Either the node transforms were dropped -- in which ` +
          `case every landmark is stacked on the Town Hall and reads as undrawn where it stands ` +
          `-- or the set no longer draws its own anchor. The anywhere count is back to being blind.`,
      );
    }
    if (beside >= DRAWN_VERTEX_MIN) {
      bad.push(
        `the same box moved ${CONTROL_CLEAR_M} m past ${CONTROL_LANDMARK}'s easternmost vertex ` +
          `still holds ${beside} landmark vertices, so the drawn test is answering yes to a place ` +
          `the landmark does not reach and a real invisible wall beside it would be excused.`,
      );
    }
  }

  // 6. And the bucketing agrees with the index, on every tile in the build. A
  //    key derived one tile out files the Opera House under its neighbour, and
  //    the only symptom is a count that does not move. Cheap enough to ask of
  //    all 22,928 rather than of a sample.
  let misfiled = '';
  for (const e of index.tiles) {
    const k = tileKeyAt((e.bounds[0] + e.bounds[2]) / 2, (e.bounds[1] + e.bounds[3]) / 2);
    if (k !== e.key) { misfiled = `${e.key} -> ${k}`; break; }
  }
  if (misfiled !== '') {
    bad.push(
      `tileKeyAt disagrees with index.json about which tile a point is in (${misfiled}), so the ` +
        `landmark vertices are bucketed under the wrong tiles and the 3 x 3 gather can miss them ` +
        `entirely. See tileKeyAt on the bounds relation it inverts.`,
    );
  }

  say('');
  say(
    `  CONTROL  a ${CONTROL_HALF * 2} m box at Pacific Highway x Critchett Road ` +
      `(${CONTROL_X}, ${CONTROL_Z}), tile ${t.key}:`,
  );
  say(
    `           stands on ${on.toFixed(0)} m2 of ${CLASSES[klass] ?? '?'} carriageway, ground ${g.toFixed(1)} m, ` +
      `${bldVerts} building vertices inside it`,
  );
  say(
    `           twisted-cell probe ${twistProbe.toFixed(2)} m (the NW-SE split says 5.00, bilinear 6.25)`,
  );
  say(
    `           the same box under ${CONTROL_LANDMARK} (${lmX.toFixed(1)}, ${lmZ.toFixed(1)}) holds ` +
      `${under} landmark vertices, and ${CONTROL_CLEAR_M} m past its eastern edge, ${beside}`,
  );
  say(
    bad.length === 0
      ? '           -> classified UNDRAWN AND ON THE ROAD. The scan can see one; the zero above is real.'
      : '           -> NOT classified. The scan is blind and its count means nothing.',
  );
  return bad;
}

if (centre !== null) {
  say('');
  say('  (a --near run measures one place and cannot move the ratchet; run it whole to gate)');
  process.exit(0);
}

const failures: string[] = runControl();
if (onLane > UNDRAWN_BUDGET) {
  failures.push(
    `${onLane} solids stand on a drivable lane with nothing drawn over them, against a budget of ` +
      `${UNDRAWN_BUDGET}. This is the class a player reports as "why is there an invisible wall here" and ` +
      `cannot diagnose from inside the game.`,
  );
}
if (offenders.length > UNDRAWN_ANYWHERE_BUDGET) {
  failures.push(
    `${offenders.length} solids stand somewhere with nothing drawn over them, against a budget of ` +
      `${UNDRAWN_ANYWHERE_BUDGET}. A player on foot is off the carriageway most of the time; see ` +
      `UNDRAWN_ANYWHERE_BUDGET for why this count exists beside the one above.`,
  );
}
if (onRoadArea > UNDRAWN_AREA_BUDGET_M2) {
  failures.push(
    `${onRoadArea.toFixed(0)} m2 of carriageway is covered by a solid nothing draws, against a budget of ` +
      `${UNDRAWN_AREA_BUDGET_M2} m2.`,
  );
}

if (failures.length > 0) {
  say('');
  say('  FAIL');
  for (const f of failures) say(`    ${f}`);
  say('');
  say('  The table above names the street. If a new offender is genuine and cannot be fixed,');
  say('  raise the budget in this file AND record the new measurement -- see the header.');
  process.exit(1);
}

say('');
say(
  `  PASS -- ${onLane} / ${UNDRAWN_BUDGET} on a lane (${onRoadArea.toFixed(0)} / ${UNDRAWN_AREA_BUDGET_M2} m2), ` +
    `${offenders.length} / ${UNDRAWN_ANYWHERE_BUDGET} anywhere`,
);
process.exit(0);
