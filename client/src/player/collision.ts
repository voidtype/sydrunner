/**
 * Collision against the pipeline's prism payload.
 *
 * Spec section 5: collision is always the simplified prism, never derived from
 * render meshes at runtime. The pipeline emits `collision/<tile>.bin` for exactly
 * this, and the same file is what the authoritative server will load.
 *
 * Binary layout, little-endian. **Format v2** -- `base` is new, and it arrived
 * with terrain:
 *     u32  building count
 *     per building:
 *       f32       height    floor to roof
 *       f32       base      the pad the building stands on
 *       u16       vertex count
 *       f32[2n]   x, z pairs, tile-local metres
 *
 * A prism occupies **[base, base + height]**. Before terrain every building
 * stood on zero and the two were the same number; now a terrace on the Surry
 * Hills ridge has a base 40 m above one in Alexandria, and every height question
 * in this file has to say which of the two it means.
 *
 * There is no version word in the payload, deliberately -- see
 * `tiles.write_collision` for the argument. The short version is that the two
 * ends of this format ship together and a v1 file read as v2 misparses on the
 * first building rather than producing subtly wrong heights, so a stale file
 * announces itself. Re-emit every tile when this changes.
 */

export interface Prism {
  /** World-space polygon, flattened x,z pairs. */
  points: Float32Array;
  /** Floor-to-roof, metres. */
  height: number;
  /** Ground height of the building's pad, metres. */
  base: number;
  /** `base + height`: the roof, in world y. Precomputed; it is asked for often. */
  top: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /**
   * `prismsWithin`'s visit stamp, and nothing else's -- see it for the argument.
   *
   * On the record rather than in a `Set` beside it because a building 15 m
   * across is filed in one to four of the 32 m grid's cells, so a query that
   * scans a hundred cells meets a few thousand prisms and has to reject the
   * repeats. An integer compare on a field that is already in cache is free
   * where a `Set` of a few thousand object identities is a tenth of a
   * millisecond, and this runs fifteen times a second next to a frame.
   */
  seen: number;
}

/** Uniform grid over prisms, so a move query touches only nearby buildings. */
export class CollisionWorld {
  private readonly cells = new Map<string, Prism[]>();
  private readonly cellSize: number;
  private readonly tiles = new Set<string>();
  private count = 0;
  /** `prismsWithin`'s query counter. See `Prism.seen`. */
  private visit = 0;

  constructor(cellSize = 32) {
    this.cellSize = cellSize;
  }

  get buildingCount(): number {
    return this.count;
  }

  hasTile(key: string): boolean {
    return this.tiles.has(key);
  }

  /** Decode one tile's collision payload and index it. */
  addTile(key: string, buffer: ArrayBuffer, offsetX: number, offsetZ: number): number {
    if (this.tiles.has(key)) return 0;
    this.tiles.add(key);

    const view = new DataView(buffer);
    let p = 0;
    const total = view.getUint32(p, true);
    p += 4;

    let added = 0;
    for (let i = 0; i < total; i++) {
      if (p + 10 > buffer.byteLength) break;
      const height = view.getFloat32(p, true);
      p += 4;
      const base = view.getFloat32(p, true);
      p += 4;
      const n = view.getUint16(p, true);
      p += 2;
      if (p + n * 8 > buffer.byteLength) break;

      const points = new Float32Array(n * 2);
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (let v = 0; v < n; v++) {
        const x = view.getFloat32(p, true) + offsetX;
        p += 4;
        const z = view.getFloat32(p, true) + offsetZ;
        p += 4;
        points[v * 2] = x;
        points[v * 2 + 1] = z;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

      const prism: Prism = { points, height, base, top: base + height, minX, minZ, maxX, maxZ, seen: 0 };
      this.insert(prism);
      added++;
      this.count++;
    }
    return added;
  }

  private insert(prism: Prism): void {
    const c = this.cellSize;
    for (let cx = Math.floor(prism.minX / c); cx <= Math.floor(prism.maxX / c); cx++) {
      for (let cz = Math.floor(prism.minZ / c); cz <= Math.floor(prism.maxZ / c); cz++) {
        const k = `${cx},${cz}`;
        const list = this.cells.get(k);
        if (list) list.push(prism);
        else this.cells.set(k, [prism]);
      }
    }
  }

  /** Every prism whose bounds could contain a circle of `radius` at (x, z). */
  private near(x: number, z: number, radius: number): Prism[] {
    const c = this.cellSize;
    const out: Prism[] = [];
    const seen = new Set<Prism>();
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (seen.has(prism)) continue;
          seen.add(prism);
          out.push(prism);
        }
      }
    }
    return out;
  }

  /**
   * Every prism within `radius` of (x, z), for a reader that wants the
   * *buildings* rather than a collision answer.
   *
   * `near` above is the collision path's own query and is deliberately not this:
   * it takes the union of whole grid cells, so at a 160 m radius it would return
   * everything in a 384 m box and leave the caller to reject a fifth of it, and
   * it allocates an array and a `Set` on every call. This is the same walk with
   * the two things a per-frame reader needs -- the prism's own bounds tested
   * against the query disc, and an `out` array the caller owns and reuses.
   *
   * The test is the closest point of the prism's AABB to the centre, which is
   * `main.ts`'s own tile test at building scale: a footprint whose box merely
   * touches the disc is inside it, and one in the corner of the bounding square
   * is not.
   *
   * What this exists for is `minimap.ts`, whose 160 m is comfortably inside the
   * 420 m ring `main.ts` keeps loaded, so the answer is always complete and
   * never has to wait on a fetch. Nothing here mutates anything a caller can
   * see -- the prisms are handed out by reference because they are immutable
   * once decoded and copying a few thousand polygons at 15 Hz would be the most
   * expensive thing on the map.
   */
  prismsWithin(x: number, z: number, radius: number, out: Prism[] = []): Prism[] {
    out.length = 0;
    const c = this.cellSize;
    const r2 = radius * radius;
    // Pre-incremented, so the value on a prism from any earlier query can never
    // match this one and no clearing pass is needed.
    const stamp = ++this.visit;
    for (let cx = Math.floor((x - radius) / c); cx <= Math.floor((x + radius) / c); cx++) {
      for (let cz = Math.floor((z - radius) / c); cz <= Math.floor((z + radius) / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (prism.seen === stamp) continue;
          prism.seen = stamp;
          const dx = Math.max(prism.minX - x, 0, x - prism.maxX);
          const dz = Math.max(prism.minZ - z, 0, z - prism.maxZ);
          if (dx * dx + dz * dz > r2) continue;
          out.push(prism);
        }
      }
    }
    return out;
  }

  /**
   * Slide a capsule of `radius` from `from` to `to` in the XZ plane.
   *
   * Resolves by pushing out along the wall normal and re-testing, which produces
   * sliding along a facade rather than sticking. Two passes handles the inside of
   * a corner, where the first push can move the player into the other wall.
   *
   * Returns the resolved position. `feetY` decides whether a prism is even in the
   * way -- you can stand on top of a low building and walk over it.
   */
  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    radius: number,
    feetY: number,
  ): { x: number; z: number; hit: boolean } {
    let x = toX;
    let z = toZ;
    let hit = false;

    for (let pass = 0; pass < 2; pass++) {
      let moved = false;
      for (const prism of this.near(x, z, radius)) {
        // Standing above the roofline: not an obstacle. Against `top` rather
        // than `height`, and that is the whole of what terrain changed here --
        // a 9 m warehouse on a pad 30 m up is 39 m of obstacle, not 9.
        if (feetY >= prism.top - 0.05) continue;
        if (
          x + radius < prism.minX ||
          x - radius > prism.maxX ||
          z + radius < prism.minZ ||
          z - radius > prism.maxZ
        ) {
          continue;
        }
        const push = pushOut(prism.points, x, z, radius);
        if (push) {
          x = push.x;
          z = push.z;
          hit = true;
          moved = true;
        }
      }
      if (!moved) break;
    }

    // If resolution failed to find a free spot, refuse the move rather than
    // letting the player through a wall.
    if (hit && this.overlaps(x, z, radius, feetY)) {
      return { x: fromX, z: fromZ, hit: true };
    }
    return { x, z, hit };
  }

  private overlaps(x: number, z: number, radius: number, feetY: number): boolean {
    for (const prism of this.near(x, z, radius)) {
      if (feetY >= prism.top - 0.05) continue;
      if (pointInPolygon(prism.points, x, z)) return true;
    }
    return false;
  }

  /**
   * Is there a building between these two points?
   *
   * The one question in this file that is not about *moving*, and it exists for
   * `game/factions.ts`: a police officer cannot witness a crime through a
   * terrace. Everything else here resolves a capsule against a footprint in
   * plan; this is a **segment against a prism in three dimensions**, because the
   * whole point of it is that a shot from a rooftop clears the wall a shot from
   * the footpath does not.
   *
   * The test, per prism, in the order it is cheapest to fail:
   *
   *   1. the segment's own AABB against the prism's, which rejects almost
   *      everything for two compares an axis;
   *   2. the segment's height range against `[base, top]`, which rejects every
   *      building the sight line passes cleanly over -- the common case in a city
   *      where most of the roofline is under the eye of anybody on a rise;
   *   3. the plan segment against each edge of the footprint, and **the height of
   *      the sight line at the crossing** against the prism's own band. That
   *      third clause is the whole reason this is not a 2D test: a line that
   *      crosses a footprint's outline 30 m up has not been blocked by a 9 m
   *      warehouse, and a purely planar test would say it had -- which reads as
   *      police who cannot see you across a car park.
   *
   * A segment that *starts or ends inside* a footprint counts as blocked, which
   * is the honest answer for the two ways it happens: somebody standing in a
   * doorway the prism swallows, and a cop whose capsule centre has been pushed a
   * few centimetres into a wall by `resolve`. Both should fail to see rather than
   * see through, because the alternative is an officer shooting you from inside a
   * building.
   *
   * No `Math.hypot` and no transcendental anywhere in it: subtract, multiply,
   * divide, compare. `game/factions.ts` runs this on the server and in the
   * browser and both have to answer identically -- an LOS test that disagreed
   * across the wire is a player who is fired at by police they cannot see, with
   * nothing on either end that says so.
   */
  blocked(ax: number, ay: number, az: number, bx: number, by: number, bz: number): boolean {
    const minX = ax < bx ? ax : bx;
    const maxX = ax < bx ? bx : ax;
    const minZ = az < bz ? az : bz;
    const maxZ = az < bz ? bz : az;
    const minY = ay < by ? ay : by;
    const maxY = ay < by ? by : ay;

    const c = this.cellSize;
    const stamp = ++this.visit;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cz = Math.floor(minZ / c); cz <= Math.floor(maxZ / c); cz++) {
        const list = this.cells.get(`${cx},${cz}`);
        if (!list) continue;
        for (const prism of list) {
          if (prism.seen === stamp) continue;
          prism.seen = stamp;
          if (prism.maxX < minX || prism.minX > maxX || prism.maxZ < minZ || prism.minZ > maxZ) continue;
          // Wholly over the roof, or wholly under the pad. Both are common and
          // both are two compares.
          if (minY >= prism.top || maxY <= prism.base) continue;
          if (segmentThroughPrism(prism, ax, ay, az, bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /**
   * The highest roof a player at `feetY` is standing on top of, or `-Infinity`.
   *
   * Two conditions, and the second one is what terrain added. The point has to
   * be inside the footprint, as it always did -- and the player has to be at or
   * above the building's **base**. Without that test a bare "highest roof under
   * the point" rule turns every building on a hill into a floor for whoever
   * walks past its foot: the pads all used to be zero, so the base was never
   * above anybody and the question never came up.
   *
   * It cannot let a falling player through a roof, which is the failure the old
   * rule was carefully avoiding. Landing on a roof means feet at `top`, which is
   * above `base`; falling from higher still is further above it. The only way to
   * be under the base *and* inside the footprint is to be inside the building's
   * volume, and `resolve` above is what keeps that from happening -- it treats
   * exactly the same prism as solid.
   *
   * `-Infinity` rather than 0 for "nothing here", because zero is a real height
   * now: it is the ground at the ENU origin, some tens of metres above most of
   * the city.
   */
  roofHeight(x: number, z: number, feetY: number): number {
    let best = -Infinity;
    for (const prism of this.near(x, z, 0.5)) {
      if (prism.top <= best) continue;
      if (feetY < prism.base - 0.05) continue;
      if (pointInPolygon(prism.points, x, z)) best = prism.top;
    }
    return best;
  }
}

/**
 * Push a circle out of a polygon, or return null if it is already clear.
 *
 * Handles both cases that matter: the centre inside the polygon (push to the
 * nearest edge and out) and the centre outside but within `radius` of an edge
 * (push along that edge's normal).
 */
function pushOut(
  points: Float32Array,
  x: number,
  z: number,
  radius: number,
): { x: number; z: number } | null {
  const inside = pointInPolygon(points, x, z);

  let bestDist = Infinity;
  let bestX = 0;
  let bestZ = 0;

  const n = points.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2];
    const az = points[i * 2 + 1];
    const bx = points[((i + 1) % n) * 2];
    const bz = points[((i + 1) % n) * 2 + 1];

    const ex = bx - ax;
    const ez = bz - az;
    const len2 = ex * ex + ez * ez;
    if (len2 < 1e-9) continue;
    let t = ((x - ax) * ex + (z - az) * ez) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t;
    const pz = az + ez * t;
    const dx = x - px;
    const dz = z - pz;
    const d = Math.hypot(dx, dz);
    if (d < bestDist) {
      bestDist = d;
      bestX = px;
      bestZ = pz;
    }
  }

  if (bestDist === Infinity) return null;
  if (!inside && bestDist >= radius) return null;

  let dx = x - bestX;
  let dz = z - bestZ;
  const d = Math.hypot(dx, dz);
  if (d < 1e-6) {
    // Dead centre on an edge: pick any direction rather than dividing by zero.
    dx = 1;
    dz = 0;
  } else {
    dx /= d;
    dz /= d;
  }
  // Inside means the nearest-edge direction points the wrong way.
  const sign = inside ? -1 : 1;
  return {
    x: bestX + dx * sign * radius,
    z: bestZ + dz * sign * radius,
  };
}

/**
 * Does the segment A-B pass through this prism's volume? See `blocked`.
 *
 * Endpoints inside the footprint are tested first and against the prism's own
 * height band, so a sight line that starts on a roof is not blocked by the
 * building holding it up.
 */
function segmentThroughPrism(
  prism: Prism,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): boolean {
  const points = prism.points;
  if (ay > prism.base && ay < prism.top && pointInPolygon(points, ax, az)) return true;
  if (by > prism.base && by < prism.top && pointInPolygon(points, bx, bz)) return true;

  const dx = bx - ax;
  const dz = bz - az;
  const dy = by - ay;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const px = points[j * 2];
    const pz = points[j * 2 + 1];
    const ex = points[i * 2] - px;
    const ez = points[i * 2 + 1] - pz;
    // Standard 2D segment-segment intersection by cross products. `denom` near
    // zero is a sight line parallel to the wall, which cannot cross it -- and
    // which the *endpoint* tests above already cover for a line running along
    // the inside of one.
    const denom = dx * ez - dz * ex;
    if (denom > -1e-12 && denom < 1e-12) continue;
    const rx = px - ax;
    const rz = pz - az;
    const t = (rx * ez - rz * ex) / denom;
    if (t < 0 || t > 1) continue;
    const u = (rx * dz - rz * dx) / denom;
    if (u < 0 || u > 1) continue;
    // The height of the sight line where it crosses the wall. This is the clause
    // that makes the test three-dimensional; see `blocked`.
    const y = ay + dy * t;
    if (y > prism.base && y < prism.top) return true;
  }
  return false;
}

/** Standard ray-crossing test. */
function pointInPolygon(points: Float32Array, x: number, z: number): boolean {
  let inside = false;
  const n = points.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = points[i * 2];
    const zi = points[i * 2 + 1];
    const xj = points[j * 2];
    const zj = points[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}
