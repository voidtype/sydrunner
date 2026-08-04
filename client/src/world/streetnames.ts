/**
 * The named street centrelines, decoded from `tiles/<key>.names.bin`.
 *
 * The only sidecar in the build that draws nothing. It exists so the client can
 * answer *"which street am I on"* at a point, which nothing shipped before it
 * could -- and the reason it could not is worth stating, because the client
 * looks like it already has the answer twice over and has it neither time.
 *
 * **The street geometry is not it.** A tile's carriageway arrives as a
 * triangulated ribbon in three material slots, unioned across every way that
 * touches the tile and cut against the terrain. There is no centreline in it and
 * no name on it: by the time asphalt is a mesh, King Street and the driveway
 * behind it are the same polygon.
 *
 * **The furniture blades are not it either.** They carry real names -- see
 * `world/furniture.ts` -- and `TileStreamer.streetNameNear` reads them, which
 * was the right answer for the job it was written for. But a blade stands at a
 * *junction*, on a post, naming one of the two streets crossing there. Halfway
 * down a Surry Hills block the nearest blade is forty to a hundred metres away,
 * and which of the two names it hands back is decided by which corner you are
 * nearer rather than by which street you are on. For a legend hanging in the
 * world that is fine. For a readout that says where you are it is wrong about
 * half the time, and wrong in a way a player can see out the window.
 *
 * So the pipeline ships the centrelines themselves, decimated, per tile, with a
 * string table: `pipeline/sydney/tiles.py::write_street_names`. Projecting the
 * player onto them is `game/locator.ts`, and this file is only the decode.
 *
 * ---------------------------------------------------------------------------
 * Per resident tile, and never a session-wide index.
 *
 * `TerrainField` keeps every grid it has ever loaded and never evicts one,
 * because a 17x17 grid is 1.2 kB and the player's *height* has to be answerable
 * anywhere they can fall. The temptation is to do the same here and it should be
 * resisted: these are polylines rather than a fixed-size grid, at 1.2 to 3.7 kB
 * a tile against the terrain grid's 1.2, and the query is only ever asked about
 * the ground within forty metres of a player who is standing on it. Forty metres
 * is inside the resident set by a factor of thirty, so a name index that
 * outlived its tile would hold kilobytes per tile for the rest of the session to
 * answer questions nobody asks. These go with the tile.
 *
 * ---------------------------------------------------------------------------
 * World metres, converted once at load.
 *
 * The sidecar is tile-local like every other, and `translateStreetNames` lifts a
 * whole tile's points into world space once, at load, for the reason
 * `streamer.ts` gives about the blade legends: the query compares distances
 * across several tiles at once, so it has to be in a frame they share, and doing
 * the addition per query instead would repeat it twice a second forever.
 *
 * Each segment carries its own axis-aligned bounds, computed in the same pass.
 * That is what makes the query cheap: a 40 m disc against a tile holding 139
 * runs rejects nearly all of them on four compares before any point is touched.
 */

/** One continuous run of one named street, in world metres. */
export interface NamedSegment {
  /**
   * The street's full display form -- 'King Street', never 'King St'.
   *
   * The pipeline abbreviates for the *blades* and deliberately does not here:
   * a readout is prose, and 'St' cannot be expanded back because Sydney has
   * both a Sussex Street and a St Johns Road. `game/locator.ts` shortens it for
   * itself in the one case that has to fit two names on one line.
   *
   * Shared by reference across every segment of the same street in a tile, out
   * of the file's own string table, so a name is one string however many runs
   * quote it.
   */
  readonly name: string;
  /** `[x0, z0, x1, z1, ...]`, at least two points. */
  readonly points: Float32Array;
  /** The run's own bounds, so the query rejects it without touching a point. */
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** One tile's worth, held on the `LoadedTile` and dropped with it. */
export interface TileStreetNames {
  /** Distinct street names in this tile, in the file's table order. */
  readonly names: readonly string[];
  readonly segments: readonly NamedSegment[];
  /** Total points across every run. Reported; nothing reads it. */
  readonly pointCount: number;
}

const decoder = new TextDecoder();

/**
 * Decode one tile's `.names.bin`, or null if there is nothing usable in it.
 *
 * Returns tile-local coordinates. `translateStreetNames` is what makes them
 * world coordinates and must be called before the segments are queried; the two
 * are separate because only the caller knows the tile's origin, and folding the
 * offset into the decoder would mean passing it through the fetch layer.
 *
 * Defensive against a truncated file at every step rather than at the top,
 * because the record is variable-stride -- the point count is per segment -- so
 * there is no single length test that proves the file is whole. A short read
 * returns what was decoded up to that point instead of throwing: a tile with
 * three of its forty streets is a worse readout, and a tile that fails to load
 * is a hole in the city.
 */
export function decodeStreetNames(buffer: ArrayBuffer): TileStreetNames | null {
  if (buffer.byteLength < 3) return null;
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let p = 0;

  const nameCount = view.getUint8(p);
  p += 1;
  const names: string[] = [];
  for (let i = 0; i < nameCount; i++) {
    if (p >= buffer.byteLength) return null;
    const len = view.getUint8(p);
    p += 1;
    if (p + len > buffer.byteLength) return null;
    names.push(decoder.decode(bytes.subarray(p, p + len)));
    p += len;
  }
  if (names.length === 0 || p + 2 > buffer.byteLength) return null;

  const segCount = view.getUint16(p, true);
  p += 2;
  const segments: NamedSegment[] = [];
  let pointCount = 0;
  for (let s = 0; s < segCount; s++) {
    if (p + 2 > buffer.byteLength) break;
    const nameIdx = view.getUint8(p);
    const n = view.getUint8(p + 1);
    p += 2;
    const need = n * 8;
    if (p + need > buffer.byteLength) break;
    // A name index past the table is a file this decoder does not understand,
    // and the run is dropped rather than clamped: clamping would put a piece of
    // some *other* street on the map under the wrong name, which is the one
    // failure a readout must not have. A short tile is visibly short; a
    // confidently wrong street name is not.
    if (nameIdx >= names.length || n < 2) {
      p += need;
      continue;
    }
    const points = new Float32Array(n * 2);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = view.getFloat32(p + i * 8, true);
      const z = view.getFloat32(p + i * 8 + 4, true);
      points[i * 2] = x;
      points[i * 2 + 1] = z;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    p += need;
    segments.push({ name: names[nameIdx], points, minX, minZ, maxX, maxZ });
    pointCount += n;
  }
  if (segments.length === 0) return null;
  return { names, segments, pointCount };
}

/**
 * Lift a decoded tile from tile-local metres into world metres, in place.
 *
 * Called once per tile at load with the tile group's own translation, which is
 * the same `(minX, minZ + tileSize)` every other per-tile payload is offset by.
 * Mutating rather than copying is deliberate -- the arrays were allocated by the
 * decode a moment ago and have no other owner.
 */
export function translateStreetNames(tile: TileStreetNames, dx: number, dz: number): void {
  for (const seg of tile.segments) {
    const pts = seg.points;
    for (let i = 0; i < pts.length; i += 2) {
      pts[i] += dx;
      pts[i + 1] += dz;
    }
    seg.minX += dx;
    seg.maxX += dx;
    seg.minZ += dz;
    seg.maxZ += dz;
  }
}

/**
 * Squared distance from a point to a polyline, in world metres.
 *
 * The whole of the projection the readout rests on. For each of the run's
 * segments, the point is projected onto the infinite line through it, the
 * parameter is clamped to `[0, 1]` so the answer is a distance to the *segment*
 * rather than to its extension, and the smallest wins.
 *
 * Squared throughout and rooted once by the caller: a square root per segment
 * per street per query is the only thing in this path that could be made to cost
 * anything, and it buys nothing -- the ordering of squared distances is the
 * ordering of distances.
 *
 * A zero-length segment -- two identical points, which decimation can leave at a
 * clip boundary -- falls out correctly rather than dividing by zero: `len2` is
 * tested before the divide and the point is measured to the vertex.
 */
export function distanceToPolylineSquared(pts: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const ax = pts[i];
    const az = pts[i + 1];
    const bx = pts[i + 2];
    const bz = pts[i + 3];
    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    let t = 0;
    if (len2 > 1e-12) {
      t = ((x - ax) * ex + (z - az) * ez) / len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const dx = x - (ax + ex * t);
    const dz = z - (az + ez * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return best;
}
