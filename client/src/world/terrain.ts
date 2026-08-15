/**
 * The ground: the sidecar, the mesh, and the one function that answers "how high
 * is the world here".
 *
 * The pipeline emits `tiles/<key>.terr.bin` for every tile it emits at all --
 * a bare `(N+1) x (N+1)` grid of float32 heights in metres above the datum,
 * row-major, **row 0 is the tile's northern edge**, column 0 its western one.
 * Rows advance southward, which is the direction +Z points, so the array walks
 * straight into a grid mesh with no transpose anywhere. N comes from
 * `index.json` rather than being written down twice.
 *
 * ---------------------------------------------------------------------------
 * Three things share this module because all three must agree to the last bit,
 * and the cheapest way to make them agree is to give them one implementation.
 *
 * **`TerrainField.height`** is what the player stands on. It is a triangulated
 * lookup, not a bilinear one, and the difference matters: a bilinear surface is
 * a hyperbolic paraboloid inside each cell and the mesh below draws two flat
 * triangles, so bilinear physics would have the player floating a few
 * centimetres over half the ground and sunk into the other half. Each cell is
 * split along its **north-west to south-east** diagonal, exactly as
 * `terrain.py`'s `sample` does -- the pipeline drapes every road and plants
 * every tree against that same split, so all three surfaces are the same
 * surface.
 *
 * **`buildTerrainMesh`** is what you see, and it is the same grid displaced.
 *
 * **`sampleTileGrid`** is what trees and parked cars sit on, in tile-local
 * metres, because their sidecars are tile-local and their instances are added to
 * the tile's own group.
 *
 * ---------------------------------------------------------------------------
 * **Grids are loaded once and never evicted.** The streamer disposes a tile's
 * geometry when it streams out, but the physics has a longer reach than the
 * renderer does -- collision loads on its own 420 m radius and the player must
 * not fall through ground that was merely turned away from -- and a grid is
 * 1,156 bytes. The whole inner ring is 254 kB and the 35 km stage would be about
 * 14 MB, so the eviction policy that is obviously right here is not to have one.
 * It also means a tile that streams back in gets its mesh rebuilt from memory
 * with no refetch.
 */

import { BufferAttribute, BufferGeometry, Mesh, type Material } from 'three/webgpu';
import { fetchWorldAsset } from './cdn.ts';
import { DECK_THICKNESS_M } from './road-deck.ts';
import { CELL_CROSSED, CELL_OUTSIDE, type SeamField } from './seam.ts';
import { earClip } from './vessel.ts';

/**
 * The rail corridor, as much of it as this module needs: where to stop drawing
 * ground, in this tile's own world frame.
 *
 * A hook rather than a `RailCut` import, on `rail-geo.RailSolids`' argument --
 * the terrain is about the ground and the corridor is about the railway, and
 * the only thing they must agree on is a half-width and a floor. It also means
 * the mesh builds exactly as it always did when there is no bake, which is what
 * a check and a world built before the railway existed both get.
 *
 * See `world/rail-cut.ts` for what fills the hole and why the two must never
 * hold separate opinions about where its rim is.
 */
export interface TileCut {
  /** World X of this tile's local origin: its south-west corner. */
  originX: number;
  /** World Z of the same corner. Tile-local z runs `-tileSize..0` from here. */
  originZ: number;
  /** Is any rail corridor within `pad` of this world point? The broad phase. */
  near(x: number, z: number, pad: number): boolean;
  /**
   * The rail head the ground must be cut down to here, or `NaN` to leave it.
   * `groundY` is the height this mesh is about to draw at that point, so the
   * test is made against the sheet being cut and not a second opinion.
   */
  cutAt(x: number, z: number, groundY: number): number;
  /**
   * The rail head a **road** is holding the ground up over, or `NaN`.
   *
   * `cutAt` and this are exclusive: a point in a corridor is either carved or
   * decked, never both. Where this answers, the ground is kept and needs an
   * underside -- see `DECK_THICKNESS_M` and the soffit block below.
   */
  deckedAt(x: number, z: number, groundY: number): number;
}

/**
 * The rim of the railway, as the terrain must meet it.
 *
 * ---------------------------------------------------------------------------
 * **The other half of `STATIONS.md`' seam rule, and the half Phase 1 could not
 * build because nothing emitted a ring yet.**
 *
 * `TileCut` above is the old arrangement and it is a *carve*: the terrain asks
 * "is this sub-quad's centre inside the corridor", drops it if so, and leaves a
 * 3.9 m staircase for `rail-geo.writeTrench` to lap half a metre of coping over
 * -- a lap that exists purely to hide the fact that two modules hold separate
 * opinions about where the rim is.
 *
 * This is not that. The vessel emits its rim as an ordered ring of **its own
 * vertices**, and the terrain is triangulated *to those vertices*: inside the
 * ring it draws nothing, across the ring it draws the part outside and stops
 * exactly on the ring's points. There is no lap because there is no
 * disagreement, and there is no epsilon anywhere in the path -- see
 * `world/seam.ts`, which also says why the tile boundary does not reopen the
 * question one level down.
 *
 * Supplied alongside `TileCut` rather than instead of it, and the interaction is
 * narrow and stated: **where a seam is given, the seam decides the corridor and
 * `cutAt` is not consulted at all.** `deckedAt` still is, because a street over
 * a cutting holds the ground up and that is true whichever module drew the
 * cutting. What is deliberately *not* handled in Phase 2a is the disposition
 * changing under a road -- trench to bore and back -- which is `STATIONS.md`'
 * third strain and is a change of topology mid-sweep, not a terrain question.
 */
export interface TileSeam {
  /** World X of this tile's local origin: its south-west corner, as `TileCut`. */
  originX: number;
  /** World Z of the same corner. */
  originZ: number;
  /** The footprints. */
  field: SeamField;
}

/**
 * How fine a terrain quad the corridor crosses is subdivided, per side.
 *
 * At `post_m` 31.25 this is 3.9 m sub-quads, which is a third of the corridor
 * width -- fine enough that the rim of the hole follows a curving cutting
 * without visible stair-stepping from the street above it, and coarse enough
 * that a fully-refined quad is 128 triangles rather than a thousand.
 *
 * **Only quads that actually lose a sub-quad are refined**, and the ones the
 * corridor covers entirely lose all sixty-four and cost nothing at all, so the
 * bill is two rows of sub-quads either side of the railway and nothing else.
 */
export const CUT_SUBDIVISION = 8;

/**
 * How far the skirt around each tile hangs below its edge, metres.
 *
 * Belt and braces, not the fix. Neighbouring tiles share their edge posts by
 * construction -- the pipeline reads both out of one global lattice, so the
 * values are bit-identical and the meshes meet exactly -- and this exists for
 * the two cases that guarantee cannot cover: a tile whose neighbour has not
 * streamed in yet, and the edge of coverage itself, where without it you would
 * see the far plane through a hairline at eye level. Two metres is more than any
 * float error and less than the shallowest visible cliff.
 */
const SKIRT_DROP = 2.0;

/** Nothing known about this point. See `TerrainField.height`. */
export const NO_GROUND = Number.NaN;

/**
 * One tile's terrain, decoded. `null` for anything that is not a grid of the
 * expected size -- a truncated file or a stale one from a build with a different
 * `TERRAIN_GRID` must read as "no terrain here" rather than as garbage heights,
 * because garbage heights are a hole the player falls into.
 */
export function decodeTerrain(buffer: ArrayBuffer, gridN: number): Float32Array | null {
  const posts = (gridN + 1) * (gridN + 1);
  if (buffer.byteLength !== posts * 4) return null;
  return new Float32Array(buffer);
}

/**
 * Height at a point in **tile-local** metres, from one tile's grid.
 *
 * Tile-local x runs 0..tileSize west to east and z runs -tileSize..0 north to
 * south, which is the frame every tile-local sidecar is written in: the tile's
 * group is translated so its origin sits at the tile's south-west corner.
 */
export function sampleTileGrid(
  grid: Float32Array,
  gridN: number,
  tileSize: number,
  localX: number,
  localZ: number,
): number {
  const spacing = tileSize / gridN;
  const stride = gridN + 1;

  const cf = clamp(localX / spacing, 0, gridN);
  const rf = clamp((localZ + tileSize) / spacing, 0, gridN);
  const c = Math.min(Math.floor(cf), gridN - 1);
  const r = Math.min(Math.floor(rf), gridN - 1);
  const fc = cf - c;
  const fr = rf - r;

  const nw = grid[r * stride + c];
  const ne = grid[r * stride + c + 1];
  const sw = grid[(r + 1) * stride + c];
  const se = grid[(r + 1) * stride + c + 1];

  // The diagonal runs north-west to south-east, so it is the line fr === fc.
  // On the north-east side of it the triangle is NW/NE/SE; on the other,
  // NW/SE/SW. Both expressions agree along the diagonal itself, so there is no
  // seam inside a cell to get wrong.
  return fc >= fr
    ? nw + (ne - nw) * fc + (se - ne) * fr
    : nw + (sw - nw) * fr + (se - sw) * fc;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Every loaded tile's ground, and the world-space query over it.
 */
/**
 * How long a `terr.bin` fetch is given before it is abandoned, milliseconds.
 *
 * Not a nicety. `fetch` has no timeout of its own, and a browser serialises
 * requests over six connections per host — so a 1,156-byte sidecar queued behind
 * four 1.7 MB tile payloads on a dev server that two tabs are hammering can sit
 * for a very long time indeed. A request that has not answered in eight seconds
 * is not going to answer usefully: the caller wants a ground height *now*, and
 * `NO_GROUND` plus the caller's last-known height is a better answer than a
 * promise that never settles. See `ensure`.
 */
const FETCH_TIMEOUT_MS = 8000;

/**
 * How long before a *transient* failure is retried, milliseconds.
 *
 * A 404 or a wrong-sized payload is a fact about the build and is remembered
 * forever — asking again would 404 again for the life of the session. A thrown
 * fetch is a fact about the *network* and is not: the tab was offline for a
 * moment, or the request was abandoned by the timeout above. Treating those the
 * same is the bug this constant exists to prevent, and it is a bad one, because
 * a tile whose ground is permanently unknown is a tile the player walks across
 * on a stale height forever.
 */
const RETRY_AFTER_MS = 5000;

export class TerrainField {
  private readonly grids = new Map<string, Float32Array>();
  /**
   * Keys the build genuinely does not have: a 404, or a payload of the wrong
   * size for this `TERRAIN_GRID`. Permanent, because both are facts about what
   * was emitted rather than about this moment.
   */
  private readonly missing = new Set<string>();
  /** Keys whose last attempt failed transiently, and when. See `RETRY_AFTER_MS`. */
  private readonly failedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<Float32Array | null>>();

  constructor(
    readonly gridN: number,
    readonly tileSize: number,
    private readonly baseUrl: string,
    /**
     * The build stamp, as a query suffix. Empty for a world built before the
     * pipeline stamped one; see `world/version.ts` for why every asset carries
     * it and `index.json` does not.
     */
    private readonly version = '',
  ) {}

  get loadedTiles(): number {
    return this.grids.size;
  }

  grid(key: string): Float32Array | undefined {
    return this.grids.get(key);
  }

  /**
   * Hand this field a grid that was obtained some other way.
   *
   * `ensure` above fetches over HTTP, which is the only way a browser can read a
   * file and is not how the authoritative server reads one: `server/world.ts`
   * opens `client/public/world/tiles/<key>.terr.bin` off the disk at boot and
   * has 221 decoded grids in hand before the first tick.
   *
   * The alternative was for the server to keep its own `Map` and re-derive the
   * world-to-tile arithmetic beside it, which is four lines and exactly the
   * wrong four: `height`'s `floor(-z / tileSize)` is the one place in the
   * project that knows world z runs south while ENU north does not, and a second
   * copy of it that drifted by one tile would put every server-side ground query
   * 500 m from the client's. Two answers to "how high is the ground here" is the
   * disagreement `game/combat.ts`'s header spends a paragraph designing out for
   * player positions; it is the same argument for the floor they stand on.
   *
   * Idempotent, and never overwrites: a grid already held is the one every
   * height query so far was answered from.
   */
  adopt(key: string, grid: Float32Array): void {
    if (!this.grids.has(key)) this.grids.set(key, grid);
  }

  /**
   * Fetch and hold one tile's grid. Idempotent, and safe to call from several
   * places at once: the streamer wants it to build a mesh and `main.ts` wants it
   * for the player, on two different radii, and neither should cause a second
   * request.
   *
   * **Never rejects, and never returns a promise that does not settle.** Both
   * halves of that are load-bearing and both were learned the hard way, because
   * every caller of this either `await`s it inside a boot sequence or fires it
   * and forgets it, and the first kind wedges the whole client.
   *
   * Three things guard it, and each one closes a specific way this used to fail:
   *
   *   1. **The in-flight entry is registered before the request runs.** The
   *      previous shape started an async IIFE and assigned `inFlight` on the
   *      line *after* it. That is correct only because `fetch` happens to
   *      suspend on its first await — and if it ever threw synchronously (a
   *      malformed base URL is enough) the IIFE would run to completion, its
   *      `finally` would delete a key that had not been added yet, and the
   *      *already-settled* promise would then be stored under that key and
   *      returned to every future caller for the life of the page. A dedup map
   *      that can be poisoned by an ordering accident is not a dedup map.
   *   2. **The request is abandoned after `FETCH_TIMEOUT_MS`.** `fetch` has no
   *      timeout, and a browser gives one origin six connections: a 1,156-byte
   *      sidecar queued behind four 1.7 MB tile payloads can sit for minutes. An
   *      abandoned request resolves `null`, which every caller already handles,
   *      instead of pinning the dedup entry and any `await` behind it forever.
   *   3. **Transient failures are retried; permanent ones are not.** A 404 or a
   *      wrong-sized payload says what the *build* contains and is remembered
   *      forever. A thrown or abandoned fetch says what the *network* did in one
   *      moment and must not be — the old code put both in `missing`, so a
   *      single hiccup meant that tile's ground was unknown for the rest of the
   *      session and the player walked across it on a stale height.
   */
  ensure(key: string): Promise<Float32Array | null> {
    const have = this.grids.get(key);
    if (have) return Promise.resolve(have);
    if (this.missing.has(key)) return Promise.resolve(null);
    const flying = this.inFlight.get(key);
    if (flying) return flying;
    const failed = this.failedAt.get(key);
    if (failed !== undefined && Date.now() - failed < RETRY_AFTER_MS) return Promise.resolve(null);

    // Registered first, then run. See rule 1 above: the entry must exist before
    // anything inside the request body can execute, including a synchronous
    // throw, or the map can be left holding a settled promise for good.
    let settle: (grid: Float32Array | null) => void = () => {};
    const request = new Promise<Float32Array | null>((resolve) => {
      settle = resolve;
    });
    this.inFlight.set(key, request);

    const finish = (grid: Float32Array | null): void => {
      this.inFlight.delete(key);
      settle(grid);
    };

    void (async (): Promise<void> => {
      // `AbortSignal.timeout` rather than a racing `setTimeout`: it cancels the
      // request itself, so an abandoned fetch stops occupying one of the six
      // connections the next one is queued behind. Racing a timer would leave
      // the socket held and make the *next* attempt slower than this one.
      const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      try {
        const resp = await fetchWorldAsset(this.baseUrl, `tiles/${key}.terr.bin`, this.version, {
          signal,
        });
        if (!resp.ok) {
          this.missing.add(key);
          finish(null);
          return;
        }
        const grid = decodeTerrain(await resp.arrayBuffer(), this.gridN);
        if (!grid) {
          this.missing.add(key);
          finish(null);
          return;
        }
        this.grids.set(key, grid);
        this.failedAt.delete(key);
        finish(grid);
      } catch {
        // Transient: aborted by the timeout, offline, or a dev server that
        // dropped the connection. Retryable, and never a rejection -- a tile
        // without terrain is a tile the player walks across on the last height
        // they knew, which is survivable, where a rejection thrown into a boot
        // sequence is not.
        this.failedAt.set(key, Date.now());
        finish(null);
      }
    })();

    return request;
  }

  /** For the debug overlay: what this field has failed to fetch, and how. */
  get loadReport(): { loaded: number; missing: number; retrying: number; inFlight: number } {
    return {
      loaded: this.grids.size,
      missing: this.missing.size,
      retrying: this.failedAt.size,
      inFlight: this.inFlight.size,
    };
  }

  /**
   * Ground height at a world point, or `NO_GROUND` where nothing is loaded.
   *
   * The sentinel is deliberate and it is not defensiveness. Returning zero for
   * an unloaded tile would be a claim -- that the ground is at the datum, which
   * over most of the city is thirty or forty metres above where it really is --
   * and the player would be fired into the air the instant they stepped onto a
   * tile that had not arrived. `NaN` says "I don't know", and the caller in
   * `main.ts` answers it by leaving the player on the ground they already had.
   */
  height(x: number, z: number): number {
    const tx = Math.floor(x / this.tileSize);
    // World z runs south, ENU north runs the other way, so the tile's north
    // index is derived from -z. A tile's local frame has its origin at the
    // south-west corner, which puts local z in -tileSize..0.
    const tz = Math.floor(-z / this.tileSize);
    const grid = this.grids.get(`${tx}_${tz}`);
    if (!grid) return NO_GROUND;
    return sampleTileGrid(
      grid,
      this.gridN,
      this.tileSize,
      x - tx * this.tileSize,
      z + tz * this.tileSize,
    );
  }
}

/**
 * One tile's ground as a displaced grid mesh, in tile-local metres.
 *
 * `gridN` quads a side plus a skirt: 512 triangles of ground and 128 of skirt at
 * N = 16, which against the 5,000-plus a tile's roads already cost is not a
 * number worth optimising.
 *
 * Normals come from the height field rather than from `computeVertexNormals`,
 * for two reasons. The skirt is vertical, so averaging face normals would drag
 * every edge post's normal a quarter-turn over and draw a dark band around every
 * tile; and a central difference over the grid is both cheaper and smoother than
 * averaging eight triangles. Edge posts fall back to a one-sided difference,
 * which differs from the neighbour tile's answer by one cell of curvature --
 * about a degree on this DEM, which is well under what a shading discontinuity
 * needs to be visible.
 */
export function buildTerrainMesh(
  grid: Float32Array,
  gridN: number,
  tileSize: number,
  material: Material,
  cut: TileCut | null = null,
  seam: TileSeam | null = null,
): Mesh {
  const stride = gridN + 1;
  const posts = stride * stride;
  const spacing = tileSize / gridN;

  // Grid posts, then four skirt rails. The rails duplicate the edge posts'
  // positions dropped by SKIRT_DROP; the *top* of each skirt quad reuses the
  // grid's own vertices, so the two can never part company.
  //
  // Refined sub-posts, where a corridor crosses a quad, are appended after all
  // of that and are the only reason these are growable arrays rather than the
  // exactly-sized typed ones this used to allocate. A tile with no railway in it
  // appends nothing and comes out byte-identical to the version before the
  // carve existed.
  const skirtCount = 4 * stride;
  const total = posts + skirtCount;
  const position: number[] = new Array(total * 3).fill(0);
  const normal: number[] = new Array(total * 3).fill(0);
  const uv: number[] = new Array(total * 2).fill(0);

  const heightAt = (r: number, c: number): number => grid[r * stride + c];

  for (let r = 0; r < stride; r++) {
    for (let c = 0; c < stride; c++) {
      const i = r * stride + c;
      position[i * 3] = c * spacing;
      position[i * 3 + 1] = heightAt(r, c);
      // Row 0 is the northern edge, and north is -Z, so the first row sits a
      // whole tile back from the local origin at the south-west corner.
      position[i * 3 + 2] = r * spacing - tileSize;

      // Central difference where there is one on both sides, one-sided at the
      // edges. dh/dx east, dh/dz south.
      const c0 = Math.max(c - 1, 0);
      const c1 = Math.min(c + 1, gridN);
      const r0 = Math.max(r - 1, 0);
      const r1 = Math.min(r + 1, gridN);
      const dhdx = (heightAt(r, c1) - heightAt(r, c0)) / ((c1 - c0) * spacing);
      const dhdz = (heightAt(r1, c) - heightAt(r0, c)) / ((r1 - r0) * spacing);
      const nx = -dhdx;
      const nz = -dhdz;
      const len = Math.hypot(nx, 1, nz);
      normal[i * 3] = nx / len;
      normal[i * 3 + 1] = 1 / len;
      normal[i * 3 + 2] = nz / len;

      uv[i * 2] = c / gridN;
      uv[i * 2 + 1] = r / gridN;
    }
  }

  // --- The quads, and the holes cut in them.
  //
  // **Why a refined quad cannot crack against an unrefined neighbour**, which is
  // the one thing that had to be true before any of this was worth building: two
  // adjacent quads share an edge, and a sub-post placed on that edge is placed
  // by `subHeight` below, which on all four boundaries reduces to the straight
  // line between the two posts the neighbour's own edge already is. The
  // neighbour may be a single segment and this side eight, but every one of the
  // eight lands on that segment. Only the *interior* of a refined quad differs
  // from the two triangles it replaces -- and it differs from them by nothing
  // either, because `subHeight`'s interior branch is `sampleTileGrid`'s
  // north-west-to-south-east split verbatim. The visible ground, the ground the
  // player walks on and the ground the pipeline draped every road against stay
  // one surface.
  const indices: number[] = [];
  /**
   * Height inside a quad, in the quad's own `fc, fr` in `0..1`.
   *
   * The four boundary cases are written out rather than left to the general
   * expression, and they are not redundant: the general form reaches the east
   * edge as `nw + (ne - nw) + (se - ne) * fr`, and `nw + (ne - nw)` is not
   * bit-identical to `ne` in floating point. One ulp of daylight along every
   * refined quad boundary in the city is not a crack anybody would see, but it
   * is also four lines to not have.
   */
  const subHeight = (
    nw: number, ne: number, sw: number, se: number, fc: number, fr: number,
  ): number => {
    if (fr === 0) return nw + (ne - nw) * fc;
    if (fr === 1) return sw + (se - sw) * fc;
    if (fc === 0) return nw + (sw - nw) * fr;
    if (fc === 1) return ne + (se - ne) * fr;
    return fc >= fr
      ? nw + (ne - nw) * fc + (se - ne) * fr
      : nw + (sw - nw) * fr + (se - sw) * fc;
  };
  /** Bilinear over the four corner values. For normals and UVs. */
  const lerp4 = (a: number, b: number, c2: number, d: number, fc: number, fr: number): number =>
    (a + (b - a) * fc) * (1 - fr) + (c2 + (d - c2) * fc) * fr;

  /**
   * Where this tile's local frame sits in the world.
   *
   * Taken from whichever of the two corridor hooks is present, and asserted to
   * agree when both are: a seam and a carve that disagreed by a tile would each
   * be answering about a different piece of Sydney, and nothing on either end
   * would say so.
   */
  const originX = cut?.originX ?? seam?.originX ?? 0;
  const originZ = cut?.originZ ?? seam?.originZ ?? 0;

  /** How much of this tile's ground the corridor took, in square metres. */
  let cutArea = 0;
  /**
   * ...and how much of it a road kept, in square metres.
   *
   * The number that says the road rule fired at all. `integration-check` asserts
   * it is non-zero over a tile whose railway is known to run under a street, on
   * exactly `cutArea`'s terms: it is the only cheap way to prove from outside
   * that a rule inside a mesh builder ran.
   */
  let deckArea = 0;
  /** Cells the rim crossed that could not be traced, and why. See `TileSeam`. */
  let seamRefused = 0;
  let seamTriangles = 0;
  const seamFaults: string[] = [];
  const sub = CUT_SUBDIVISION;
  // Half the diagonal of a quad: the radius that finds a corridor touching any
  // part of it from its centre.
  const quadReach = spacing * Math.SQRT1_2;
  /** Per sub-quad: 0 kept as ordinary ground, 1 carved away, 2 kept by a road. */
  const state = new Uint8Array(sub * sub);
  const keep = new Uint8Array(sub * sub);
  const lattice = new Int32Array((sub + 1) * (sub + 1));
  /** The soffit's own posts, allocated only in a quad a road crosses. */
  const under = new Int32Array((sub + 1) * (sub + 1));

  /**
   * Is the sub-quad at these **tile-wide** sub-indices one the corridor took?
   *
   * The neighbour test the soffit's fascia needs, and it has to work across a
   * quad boundary: a road deck's edge lands wherever the road's kerb does, which
   * is almost never on a 31 m grid line. Outside the tile it answers `false` --
   * the neighbouring tile's grid is not in hand here, and a missing fascia at a
   * tile seam is a hairline where a wrong one would be a wall.
   *
   * Replays `buildTerrainMesh`'s own decision rather than approximating it: same
   * `subHeight`, same sub-quad centre, same `cutAt`. It is called only for the
   * four neighbours of a decked sub-quad, which over the whole city is a few
   * thousand calls.
   */
  const droppedAtSub = (gr: number, gc: number): boolean => {
    if (cut === null) return false;
    if (gr < 0 || gc < 0 || gr >= gridN * sub || gc >= gridN * sub) return false;
    const r = Math.floor(gr / sub);
    const c = Math.floor(gc / sub);
    const i = r * stride + c;
    const fc = ((gc - c * sub) + 0.5) / sub;
    const fr = ((gr - r * sub) + 0.5) / sub;
    const h = subHeight(grid[i], grid[i + 1], grid[i + stride], grid[i + stride + 1], fc, fr);
    const wx = cut.originX + (c + fc) * spacing;
    const wz = cut.originZ + (r + fr) * spacing - tileSize;
    return Number.isFinite(cut.cutAt(wx, wz, h));
  };

  /** One vertex, with its own normal. Returns its index. */
  const pushVertex = (
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
  ): number => {
    const at = position.length / 3;
    position.push(x, y, z);
    normal.push(nx, ny, nz);
    uv.push(u, v);
    return at;
  };

  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      const inw = r * stride + c;
      const ine = inw + 1;
      const isw = inw + stride;
      const ise = isw + 1;
      // Split north-west to south-east, matching `sampleTileGrid` above and
      // `terrain.py`'s `sample`. Wound so both faces look up.
      const plain = (): void => {
        indices.push(inw, ise, ine, inw, isw, ise);
      };
      if (cut === null && seam === null) {
        plain();
        continue;
      }
      const wx0 = originX + c * spacing;
      const wz0 = originZ + r * spacing - tileSize;
      const nearCut = cut !== null && cut.near(wx0 + spacing / 2, wz0 + spacing / 2, quadReach);
      // The seam's broad phase is a box rather than a radius, because a
      // footprint is an arbitrary polygon and the only cheap thing true of it is
      // which lattice cells it spans.
      const nearSeam =
        seam !== null && seam.field.nearBox(wx0, wz0, wx0 + spacing, wz0 + spacing, 0);
      if (!nearCut && !nearSeam) {
        plain();
        continue;
      }

      const nw = grid[inw];
      const ne = grid[ine];
      const sw = grid[isw];
      const se = grid[ise];
      let dropped = 0;
      let decked = 0;
      let conformed = 0;
      // Which lattice cell this quad's north-west sub-post is. The lattice is
      // global -- every tile's bounds are a multiple of `tile_size` and
      // `tile_size` is a whole number of sub-quads -- so `m` and `n` mean the
      // same cell in every tile that can see it, which is the whole reason two
      // tiles cannot disagree about a crossing. `checkSeam` asserts the
      // divisibility rather than trusting this paragraph.
      const pitch = spacing / sub;
      const m0 = Math.round(wx0 / pitch);
      const n0 = Math.round(wz0 / pitch);
      for (let sr = 0; sr < sub; sr++) {
        for (let sc = 0; sc < sub; sc++) {
          const fc = (sc + 0.5) / sub;
          const fr = (sr + 0.5) / sub;
          const h = subHeight(nw, ne, sw, se, fc, fr);
          const wx = wx0 + fc * spacing;
          const wz = wz0 + fr * spacing;
          if (seam !== null) {
            // **The seam decides the corridor outright.** `cutAt` is not asked,
            // because two rules for where the ground stops is the defect, not
            // the belt and braces. `deckedAt` still is: a street over a cutting
            // holds the ground up whoever drew the cutting under it.
            const st = seam.field.state(m0 + sc, n0 + sr);
            if (st === CELL_OUTSIDE) {
              state[sr * sub + sc] = 0;
              keep[sr * sub + sc] = 1;
              continue;
            }
            if (st === CELL_CROSSED) {
              state[sr * sub + sc] = 3;
              keep[sr * sub + sc] = 0;
              conformed++;
              continue;
            }
            const paved = cut !== null && Number.isFinite(cut.deckedAt(wx, wz, h));
            state[sr * sub + sc] = paved ? 2 : 1;
            keep[sr * sub + sc] = paved ? 1 : 0;
            if (paved) decked++;
            else dropped++;
            continue;
          }
          const gone = cut !== null && Number.isFinite(cut.cutAt(wx, wz, h));
          // Exclusive by construction -- `RailCut.deckedAt` answers only where
          // `cutAt` declined *because of a road* -- so the branch is an ordering
          // and not a precedence. Asked second because it is the rarer answer and
          // the more expensive one.
          const road = !gone && cut !== null && Number.isFinite(cut.deckedAt(wx, wz, h));
          state[sr * sub + sc] = gone ? 1 : road ? 2 : 0;
          keep[sr * sub + sc] = gone ? 0 : 1;
          if (gone) dropped++;
          else if (road) decked++;
        }
      }
      // **`decked` is in the test as well as `dropped`, and that is the road
      // rule's only cost to a quad that keeps all its ground**: a quad wholly
      // under a street that roofs the corridor loses no sub-quad at all, so the
      // old test sent it down the two-triangle path -- and then a player in the
      // trench looks up through King Street and out of the world, because
      // nothing built it an underside. It happens where a road runs *along* a
      // cutting rather than across one, which in this extract is a few dozen
      // quads.
      if (dropped === 0 && decked === 0 && conformed === 0) {
        // The corridor is near this quad but takes nothing from it. The common
        // case beside a railway at grade, and it must cost two triangles.
        plain();
        continue;
      }
      cutArea += (dropped / (sub * sub)) * spacing * spacing;
      deckArea += (decked / (sub * sub)) * spacing * spacing;
      if (dropped === sub * sub) continue; // wholly inside the corridor

      // Refine. Every sub-post is emitted, kept quads index into them; the
      // handful nothing references are eight floats each and are cheaper than
      // the bookkeeping that would drop them.
      for (let sr = 0; sr <= sub; sr++) {
        for (let sc = 0; sc <= sub; sc++) {
          const fc = sc / sub;
          const fr = sr / sub;
          const at = position.length / 3;
          lattice[sr * (sub + 1) + sc] = at;
          position.push(
            wx0 - originX + fc * spacing,
            subHeight(nw, ne, sw, se, fc, fr),
            wz0 - originZ + fr * spacing,
          );
          // The corner normals, interpolated. Along a shared edge this is linear
          // between the two posts' own normals, which is exactly what the
          // neighbour quad shades to, so a refined quad does not draw a seam.
          const nx = lerp4(normal[inw * 3], normal[ine * 3], normal[isw * 3], normal[ise * 3], fc, fr);
          const ny = lerp4(normal[inw * 3 + 1], normal[ine * 3 + 1], normal[isw * 3 + 1], normal[ise * 3 + 1], fc, fr);
          const nz = lerp4(normal[inw * 3 + 2], normal[ine * 3 + 2], normal[isw * 3 + 2], normal[ise * 3 + 2], fc, fr);
          const len = Math.hypot(nx, ny, nz) || 1;
          normal.push(nx / len, ny / len, nz / len);
          uv.push((c + fc) / gridN, (r + fr) / gridN);
        }
      }
      for (let sr = 0; sr < sub; sr++) {
        for (let sc = 0; sc < sub; sc++) {
          if (keep[sr * sub + sc] === 0) continue;
          const a = lattice[sr * (sub + 1) + sc];
          const b = a + 1;
          const d = lattice[(sr + 1) * (sub + 1) + sc];
          const e = d + 1;
          indices.push(a, e, b, a, d, e);
        }
      }

      // ---------------------------------------------------------------------
      // THE CONFORMED CELLS: where the ground stops being a lattice and becomes
      // the vessel's own rim.
      //
      // **This is the seam rule, discharged.** A cell the rim crosses is not
      // dropped and not kept: the part outside the ring is traced by
      // `world/seam.ts` and triangulated here, and every boundary vertex of it
      // is either a lattice sub-post this loop has already emitted or **a vertex
      // of the vessel, at the vessel's own coordinates**. Not a vertex near one.
      // The same one, carried through from `Vessel.position` without being
      // recomputed, which is why there is no tolerance anywhere on this path and
      // why `writeTrench`' half-metre coping lap has nothing left to hide.
      //
      // Wound the opposite way to the trace, because a loop that is counter-
      // clockwise in `(x, z)` is a face pointing *down*: the ground's own quads
      // are `(nw, se, ne)`, which is clockwise in plan and up in world. Getting
      // that backwards draws a hole that is only visible from underneath.
      if (conformed > 0 && seam !== null) {
        for (let sr = 0; sr < sub; sr++) {
          for (let sc = 0; sc < sub; sc++) {
            if (state[sr * sub + sc] !== 3) continue;
            const loops = seam.field.conform(m0 + sc, n0 + sr, seamFaults);
            if (loops === null) {
              seamRefused++;
              continue;
            }
            for (const loop of loops) {
              const ids: number[] = [];
              for (const node of loop) {
                if (node.corner >= 0) {
                  const cr = node.corner === 0 || node.corner === 1 ? sr : sr + 1;
                  const cc = node.corner === 0 || node.corner === 3 ? sc : sc + 1;
                  ids.push(lattice[cr * (sub + 1) + cc]);
                  continue;
                }
                const fc = (node.x - wx0) / spacing;
                const fr = (node.z - wz0) / spacing;
                const nx = lerp4(normal[inw * 3], normal[ine * 3], normal[isw * 3], normal[ise * 3], fc, fr);
                const ny = lerp4(normal[inw * 3 + 1], normal[ine * 3 + 1], normal[isw * 3 + 1], normal[ise * 3 + 1], fc, fr);
                const nz = lerp4(normal[inw * 3 + 2], normal[ine * 3 + 2], normal[isw * 3 + 2], normal[ise * 3 + 2], fc, fr);
                const len = Math.hypot(nx, ny, nz) || 1;
                ids.push(pushVertex(
                  node.x - originX, node.y, node.z - originZ,
                  nx / len, ny / len, nz / len,
                  (c + fc) / gridN, (r + fr) / gridN,
                ));
              }
              const flat = new Float64Array(loop.length * 2);
              for (let k = 0; k < loop.length; k++) {
                flat[k * 2] = loop[k].x;
                flat[k * 2 + 1] = loop[k].z;
              }
              const tri = earClip(flat);
              if (tri === null) {
                seamRefused++;
                seamFaults.push(`cell ${m0 + sc},${n0 + sr}: the kept ground could not be triangulated`);
                continue;
              }
              for (let t = 0; t < tri.length; t += 3) {
                indices.push(ids[tri[t]], ids[tri[t + 2]], ids[tri[t + 1]]);
                seamTriangles++;
              }
            }
          }
        }
      }

      // ---------------------------------------------------------------------
      // THE SOFFIT, and why a kept sub-quad over a trench is not finished.
      //
      // The road rule keeps the ground under a carriageway, which is the whole
      // fix -- but the terrain sheet is a single-sided upward surface, so from
      // down in the cutting the deck it makes is *invisible*: a `FrontSide`
      // material culls it and the player looks up through King Street at the
      // sky. What is drawn instead is a slab: the kept ground on top, a second
      // sheet `DECK_THICKNESS_M` below it facing down, and a fascia closing the
      // gap on every edge where the neighbouring sub-quad was carved away.
      //
      // Deliberately built here rather than in `world/rail-geo.ts`, where the
      // rest of the corridor's structure lives, and the reason is the one this
      // whole module exists for: the soffit has to follow the kept ground
      // exactly, and the only place the kept ground's own interpolated heights
      // are in hand is inside the loop that computed them. A second module
      // re-deriving them would be the seam `rail-cut.ts`' header spends a page
      // refusing. It is the ground's own underside, not an invented structure --
      // no piers and no parapet, which are `elevated.py`'s job and a world
      // rebuild.
      if (decked === 0) continue;
      for (let sr = 0; sr <= sub; sr++) {
        for (let sc = 0; sc <= sub; sc++) {
          const fc = sc / sub;
          const fr = sr / sub;
          under[sr * (sub + 1) + sc] = pushVertex(
            wx0 - originX + fc * spacing,
            subHeight(nw, ne, sw, se, fc, fr) - DECK_THICKNESS_M,
            wz0 - originZ + fr * spacing,
            0, -1, 0,
            (c + fc) / gridN,
            (r + fr) / gridN,
          );
        }
      }
      for (let sr = 0; sr < sub; sr++) {
        for (let sc = 0; sc < sub; sc++) {
          if (state[sr * sub + sc] !== 2) continue;
          const a = under[sr * (sub + 1) + sc];
          const b = a + 1;
          const d = under[(sr + 1) * (sub + 1) + sc];
          const e = d + 1;
          // The top's winding, reversed: this face looks down.
          indices.push(a, b, e, a, e, d);

          // The fascia. Only against a hole -- an edge shared with another
          // decked sub-quad is inside the deck, and one shared with ordinary
          // ground is inside the ground.
          const gr = r * sub + sr;
          const gc = c * sub + sc;
          const holeAt = (dr: number, dc: number): boolean => {
            const nr = sr + dr;
            const nc = sc + dc;
            if (nr >= 0 && nr < sub && nc >= 0 && nc < sub) return state[nr * sub + nc] === 1;
            return droppedAtSub(gr + dr, gc + dc);
          };
          const topAt = (sr2: number, sc2: number): number => lattice[sr2 * (sub + 1) + sc2];
          const underAt = (sr2: number, sc2: number): number => under[sr2 * (sub + 1) + sc2];
          /**
           * One fascia quad, given its four corners **in perimeter order** --
           * two along the top, then the two beneath them coming back.
           *
           * Its own vertices rather than the lattice posts, because those carry
           * the ground's up normal and the soffit's down normal: a vertical face
           * shaded off either of them reads as a smear of the surface it came
           * from rather than as the edge of a deck. Four vertices a quad, and
           * there are a handful of quads at each crossing in the city.
           *
           * Perimeter order is what makes the two triangles agree, and the order
           * for each of the four sides is derived below rather than guessed --
           * see `rail-geo.writeTrench`'s `face` for the same hazard stated at
           * length. A fascia facing the wrong way is invisible from the trench
           * and visible from inside the ground, which is the worse of the two.
           */
          const fascia = (
            a: number, b: number, cc: number, dd: number,
            nx: number, nz: number,
          ): void => {
            const at = (src: number): number => pushVertex(
              position[src * 3], position[src * 3 + 1], position[src * 3 + 2],
              nx, 0, nz,
              uv[src * 2], uv[src * 2 + 1],
            );
            const p0 = at(a);
            const p1 = at(b);
            const p2 = at(cc);
            const p3 = at(dd);
            indices.push(p0, p1, p2, p0, p2, p3);
          };
          if (holeAt(-1, 0)) {
            // North, facing -Z: west to east along the top, back underneath.
            fascia(topAt(sr, sc), topAt(sr, sc + 1), underAt(sr, sc + 1), underAt(sr, sc), 0, -1);
          }
          if (holeAt(1, 0)) {
            // South, facing +Z: the mirror, east to west.
            fascia(topAt(sr + 1, sc + 1), topAt(sr + 1, sc), underAt(sr + 1, sc), underAt(sr + 1, sc + 1), 0, 1);
          }
          if (holeAt(0, -1)) {
            // West, facing -X: south to north along the top.
            fascia(topAt(sr + 1, sc), topAt(sr, sc), underAt(sr, sc), underAt(sr + 1, sc), -1, 0);
          }
          if (holeAt(0, 1)) {
            // East, facing +X: north to south.
            fascia(topAt(sr, sc + 1), topAt(sr + 1, sc + 1), underAt(sr + 1, sc + 1), underAt(sr, sc + 1), 1, 0);
          }
        }
      }
    }
  }

  // The skirt. Walked with the tile's interior always on the right, which is
  // what makes one winding rule produce an outward face on all four sides:
  // north edge west to east, east edge north to south, south edge east to west,
  // west edge south to north.
  const rails: number[][] = [[], [], [], []];
  for (let k = 0; k < stride; k++) {
    rails[0].push(0 * stride + k); // north, west -> east
    rails[1].push(k * stride + gridN); // east, north -> south
    rails[2].push(gridN * stride + (gridN - k)); // south, east -> west
    rails[3].push((gridN - k) * stride); // west, south -> north
  }

  let next = posts;
  for (const rail of rails) {
    const bottom: number[] = [];
    for (const top of rail) {
      position[next * 3] = position[top * 3];
      position[next * 3 + 1] = position[top * 3 + 1] - SKIRT_DROP;
      position[next * 3 + 2] = position[top * 3 + 2];
      // The skirt takes its post's ground normal rather than a horizontal one,
      // so where it is not hiding anything it shades as the ground continuing
      // rather than as a wall around every tile.
      normal[next * 3] = normal[top * 3];
      normal[next * 3 + 1] = normal[top * 3 + 1];
      normal[next * 3 + 2] = normal[top * 3 + 2];
      uv[next * 2] = uv[top * 2];
      uv[next * 2 + 1] = uv[top * 2 + 1];
      bottom.push(next);
      next++;
    }
    for (let k = 0; k < rail.length - 1; k++) {
      // **The skirt gets cut too.** Without this the two-metre apron around
      // every tile draws a wall straight across the trench wherever a cutting
      // crosses a tile boundary -- which on the inner west is every 500 m, and
      // is the one artefact that would make the carve look like a bug rather
      // than like a railway.
      if (cut !== null || seam !== null) {
        const a = rail[k];
        const b = rail[k + 1];
        const mx = originX + (position[a * 3] + position[b * 3]) / 2;
        const mz = originZ + (position[a * 3 + 2] + position[b * 3 + 2]) / 2;
        // Linear between two posts along a grid line, which is exactly what the
        // quad's own edge is, so the skirt and the sheet make the same decision.
        const mh = (position[a * 3 + 1] + position[b * 3 + 1]) / 2;
        if (seam !== null) {
          // The apron stops wherever the corridor reaches the tile edge, on the
          // cell the sheet itself stopped on. A skirt across the mouth of a
          // cutting is the one artefact that would make this look like a bug
          // rather than like a railway -- `CUT_SUBDIVISION`'s note says the same
          // about the carve.
          const p = spacing / sub;
          if (seam.field.state(Math.floor(mx / p), Math.floor(mz / p)) !== CELL_OUTSIDE) continue;
        } else if (cut !== null && Number.isFinite(cut.cutAt(mx, mz, mh))) {
          continue;
        }
      }
      indices.push(rail[k], rail[k + 1], bottom[k + 1]);
      indices.push(rail[k], bottom[k + 1], bottom[k]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normal), 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  geometry.setIndex(indices);

  const mesh = new Mesh(geometry, material);
  mesh.name = 'terrain';
  // Receives, and never casts -- the same reasoning the flat plane it replaces
  // carried. Its only contribution to the depth map would be the ground itself,
  // and every fragment it wrote there is a fragment the buildings have to fight
  // for. It is the surface the shadows land on.
  //
  // `userData.surface` is what `streamer.ts` reads to keep it out of the depth
  // pass on every later frame as well.
  mesh.receiveShadow = true;
  mesh.castShadow = false;
  mesh.userData.surface = true;
  // Square metres of ground this tile gave up to the railway. Nothing draws it;
  // the debug overlay reports it and `integration-check` asserts it is not zero
  // over a tile whose railway is known to be in a cutting, which is the only
  // cheap way to prove from outside that the carve ran at all.
  mesh.userData.cutArea = cutArea;
  // And how much of the corridor a carriageway kept, in square metres. The one
  // number that says the road rule fired in this tile at all; `integration-check`
  // asserts it over a tile whose railway is known to run under a street, and
  // `streamer.recutGround` compares it to decide whether a re-cut changed
  // anything worth swapping a mesh for.
  mesh.userData.deckArea = deckArea;
  // And the seam: how many triangles were built *to the vessel's rim* and how
  // many cells the trace refused. `integration-check` asserts the first is
  // non-zero and the second is exactly zero over a real corridor, which is the
  // only cheap way to prove from outside that the conformer ran and got a clean
  // answer everywhere it ran.
  mesh.userData.seamTriangles = seamTriangles;
  mesh.userData.seamRefused = seamRefused;
  mesh.userData.seamFaults = seamFaults;
  mesh.frustumCulled = false; // culled with its tile, like every other primitive
  return mesh;
}
