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

import {
  decodeStreetNames,
  translateStreetNames,
  type NamedSegment,
  type TileStreetNames,
} from './tile-decode.ts';

/**
 * The decode itself lives in `world/tile-decode.ts`, along with the record types
 * and the tile-local-to-world translation.
 *
 * It moved there for one reason: that file carries no `three` import, so
 * `world/decode.worker.ts` can read a `.names.bin` -- and lift it into world
 * metres, since the tile origin travels with the bytes -- on a thread that is
 * not the render thread. Re-exported from here because this module is still
 * where the argument above lives, and because `streamer.ts` and
 * `game/locator.ts` should keep naming it.
 */
export { decodeStreetNames, translateStreetNames };
export type { NamedSegment, TileStreetNames };

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
