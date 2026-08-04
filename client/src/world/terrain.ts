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
        const resp = await fetch(`${this.baseUrl}/tiles/${key}.terr.bin${this.version}`, { signal });
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
): Mesh {
  const stride = gridN + 1;
  const posts = stride * stride;
  const spacing = tileSize / gridN;

  // Grid posts, then four skirt rails. The rails duplicate the edge posts'
  // positions dropped by SKIRT_DROP; the *top* of each skirt quad reuses the
  // grid's own vertices, so the two can never part company.
  const skirtCount = 4 * stride;
  const total = posts + skirtCount;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);

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

  const indices: number[] = [];
  for (let r = 0; r < gridN; r++) {
    for (let c = 0; c < gridN; c++) {
      const nw = r * stride + c;
      const ne = nw + 1;
      const sw = nw + stride;
      const se = sw + 1;
      // Split north-west to south-east, matching `sampleTileGrid` above and
      // `terrain.py`'s `sample`. Wound so both faces look up.
      indices.push(nw, se, ne, nw, sw, se);
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
      indices.push(rail[k], rail[k + 1], bottom[k + 1]);
      indices.push(rail[k], bottom[k + 1], bottom[k]);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
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
  mesh.frustumCulled = false; // culled with its tile, like every other primitive
  return mesh;
}
