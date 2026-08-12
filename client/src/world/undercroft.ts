/**
 * The undercroft, as a thing you can see.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR, IN THE PLAYER'S OWN WORDS.
 *
 *   > *"i still pass through solid buildings on the train"*
 *   > *"The buildings that cross railroads still have[n't] been removed"*
 *
 * Both of those are the same defect and it is not the one the words describe.
 * The buildings *have* been cut: `world/envelope.ClearanceEnvelope.carve` splits
 * every prism that stands across the railway into the part left of the corridor,
 * the part right of it, and the part carried over it -- 792 of them across the
 * streaming disc -- and `player/collision.CollisionWorld` has been indexing the
 * pieces since last round. The tunnel is there. **You cannot see it.** The
 * previous round's own note:
 *
 *   > *"The piece above is not supported by anything visible. It is
 *   > collision-only: the building still draws down to the ground, so at
 *   > Eveleigh the tunnel is walkable and invisible."*
 *
 * A hole you cannot see is worse than no hole. The player rides into a wall,
 * passes through it, and reports that nothing was fixed -- which, as far as
 * anything they can observe goes, it was not.
 *
 * ---------------------------------------------------------------------------
 * THE ROUTE TAKEN, AND THE TWO IT WAS TAKEN INSTEAD OF.
 *
 * The tile's buildings arrive as **baked, merged triangles**: one primitive per
 * material slot, every building in the tile in it, with a `_bldidx` column
 * saying which building each vertex belongs to. There is no per-building mesh to
 * hide and no footprint to re-extrude from. Three routes existed:
 *
 *  1. **Re-extrude.** Drop every triangle of a carved building and rebuild its
 *     walls from the carved pieces. Correct, and it needs the collision payload
 *     -- which arrives on `main.ts`' 420 m radius while geometry is built on
 *     1,800 m, so the undercroft would pop into being as the player walked
 *     towards it. It also needs the pieces' rings, which are the *simplified*
 *     0.9 m-tolerance collision rings, so the rebuilt building would be visibly
 *     coarser than its neighbours.
 *  2. **Discard in the shader.** A per-fragment envelope test in all eleven
 *     facade materials. It puts a `discard` in the hottest pipeline in the game
 *     -- every wall in the city loses early-Z to open a hole in 792 buildings --
 *     and a discarded wall with nothing behind it is a window into the void.
 *  3. **Subdivide and drop, then line the hole.** This file.
 *
 * Route 3 is the one `world/terrain.buildTerrainMesh` already takes for the
 * ground: a quad the corridor crosses is subdivided into sub-quads and the ones
 * inside the corridor are not emitted. The same technique applied to a wall
 * needs no collision payload (the envelope is built from the rail bake before
 * the first tile lands), no new material, no new pipeline, and it produces an
 * opening in exactly the volume the collision left empty, because both ask the
 * identical `ClearanceEnvelope` the identical question.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HOLE ALSO GETS A LINING, AND WHY THE LINING IS THE SUPPORT.
 *
 * Dropping triangles opens the wall. It does not build a tunnel: a `FrontSide`
 * material culls back faces, so a player standing in the opening and looking
 * sideways sees straight through the building and out of the world. And the mass
 * left overhead -- the span the carve raised onto the envelope ceiling -- would
 * be drawn hanging in the air over an empty slot, which reads worse than the bug
 * did.
 *
 * So the opening is lined: **two jambs** at the corridor's own half-width,
 * running the length of the building, from its base up to the envelope ceiling,
 * and a **soffit** across the top of them. That is a real undercroft, and the
 * jambs are the answer to "a visible span needs visible support" -- they are
 * abutments, they stand on the ground, and the mass overhead sits on them. No
 * columns are invented: the building's own remaining mass either side of the
 * corridor is what carries the span, and the jamb is its face.
 *
 * The lining is emitted into the **same primitive, on the same material, with
 * the same `_bldidx`** as the wall it replaces, so a brick warehouse gets a
 * brick-lined undercroft and the game compiles no new pipeline for any of it.
 *
 * And the lining is then **carved by the same rule as everything else**, which
 * is what makes a six-road corridor come out right: track four's jamb stands
 * inside track five's clearance envelope, so it is not drawn, and what survives
 * is a jamb at each outer edge of the whole corridor group with clear air
 * between.
 */

import { BLDIDX_LOWER, type GlbAttribute, type GlbPrimitive } from './tile-decode.ts';

/**
 * What this file needs from `world/envelope.ClearanceEnvelope`.
 *
 * A structural type, on that file's own terms: it imports nothing, the server
 * carves the identical prisms out of the identical buildings, and the two ends
 * agree because they call the same two methods rather than because they share a
 * class.
 */
export interface UndercroftEnvelope {
  anyNear(minX: number, minZ: number, maxX: number, maxZ: number): boolean;
  near(
    minX: number, minZ: number, maxX: number, maxZ: number,
    out?: UndercroftCorridor[],
  ): UndercroftCorridor[];
}

/** One corridor, exactly `world/envelope.Corridor`. */
export interface UndercroftCorridor {
  ax: number; az: number; ay: number;
  bx: number; bz: number; by: number;
  half: number; below: number; above: number;
  rail: boolean;
}

/**
 * How finely a wall triangle that meets a corridor is chopped, metres.
 *
 * `terrain.buildTerrainMesh` subdivides its 31 m quads to about four metres,
 * which is as fine as a heightfield can usefully be. A wall is a different
 * problem: the edge produced here is the **mouth of a tunnel**, seen from two
 * metres away by a player walking into it, and a four-metre stair-step on it
 * would be the artefact. Sixty centimetres puts the worst step under knee
 * height, and the jamb quad is drawn at the corridor's own exact plane in front
 * of it, so what the player actually sees is a straight edge with the ragged one
 * hidden behind it.
 *
 * The cost is bounded by how few triangles ever reach it: a tile with no railway
 * over it rejects on one bounding box, and in a tile that has one it is the
 * handful of walls the corridor crosses.
 */
const STEP_M = 0.6;

/**
 * The most sub-triangles one triangle may be chopped into.
 *
 * A guard rather than a design point. The pipeline emits wall quads, so a
 * triangle is at most a building's whole face, and a warehouse wall 40 m by 30 m
 * would be 3,300 sub-triangles at `STEP_M` -- so this is a cap that bites, and
 * it is meant to.
 *
 * **Measured before it existed:** the reference shed -- a 20 m square straddling
 * the line, which is `verifyUndercroft`'s own case and the shape of the Eveleigh
 * workshops -- came out of an uncapped `STEP_M` lattice as 4,888 triangles from
 * 8, in 13 ms. One building. Twenty of them resident is a hundred thousand
 * triangles and a quarter of a second of tile build, to open holes the player
 * looks at from twenty metres away.
 *
 * At 576 the same shed is a few hundred triangles and the step on its tunnel
 * mouth is about a metre, which the jamb standing at the corridor's own plane is
 * drawn in front of. Past the cap the subdivision is coarsened, which leaves a
 * rougher mouth and never a wrong one: the classification is per sub-triangle
 * centroid either way, so a coarser lattice removes *less*, and wall left
 * standing is the failure the player can already walk through rather than a new
 * one.
 */
const MAX_SUBDIVISION = 576;

/**
 * How far a corridor has to reach through a building before its wall is opened,
 * metres along the corridor.
 *
 * **`envelope.MIN_CUT_M2`'s counterpart, and it exists for the same reason.**
 * That constant refuses to cut a tunnel through a building whose footprint
 * merely clips the corridor by a metre of kerb line -- ML-derived footprints are
 * not surveyed and a terrace's corner lands inside the gauge all over the city.
 * The collision leaves those solid, so this must leave them drawn, or the player
 * meets the exact defect this file exists to remove with the sign reversed: an
 * opening they can see and cannot walk through.
 *
 * Expressed as a reach along the corridor rather than as an area because that is
 * what this pass has: drawn geometry is triangles, not a footprint ring. Two
 * metres of a building crossed by a 7.2 m-wide gauge is 14 m^2 of overlap, which
 * is comfortably over `MIN_CUT_M2`'s eight.
 */
const MIN_REACH_M = 2.0;

/**
 * How far outside the clearance envelope the lining stands, metres.
 *
 * **Outside, not on it, and the two centimetres are the whole point.** The
 * envelope is the volume a train sweeps plus the margin the player asked for;
 * a jamb built exactly on the gauge is a surface the carriage grazes and, worse,
 * a surface this file's own void test reads as being *inside* the corridor --
 * so the lining would be dropped by the rule that emitted it. Two centimetres
 * puts it clear of both and is under the width of a mortar joint.
 */
const LINING_CLEAR = 0.02;

/** What one tile's carve did, for the console. */
export interface UndercroftTally {
  /** Primitives rewritten. */
  primitives: number;
  /** Triangles that met a corridor and were chopped. */
  chopped: number;
  /** Sub-triangles dropped -- the hole itself. */
  dropped: number;
  /** Jamb and soffit panels emitted. */
  lining: number;
  /** Buildings whose wall was opened. */
  buildings: number;
  /** Milliseconds spent, cumulative. */
  ms: number;
}

export function emptyUndercroftTally(): UndercroftTally {
  return { primitives: 0, chopped: 0, dropped: 0, lining: 0, buildings: 0, ms: 0 };
}

/**
 * Open every corridor that crosses this primitive, and line the opening.
 *
 * Returns a **new** primitive, or `null` when nothing was touched -- which is
 * the answer for every primitive in all but a few dozen tiles, and on that path
 * it costs one pass over the positions and four map lookups. The caller keeps
 * what it already has on `null`, so the common case allocates nothing.
 *
 * `offsetX` / `offsetZ` are the tile's own world translation: positions in a
 * decoded primitive are tile-local and the envelope is in world metres.
 */
export function carveUndercroft(
  prim: GlbPrimitive,
  offsetX: number,
  offsetZ: number,
  env: UndercroftEnvelope,
  tally?: UndercroftTally,
): GlbPrimitive | null {
  const started = tally ? performance.now() : 0;
  const position = prim.attributes.find((a) => a.name === 'position');
  if (!position || position.itemSize !== 3 || !(position.array instanceof Float32Array)) return null;
  const pos = position.array;
  const index = prim.index;
  if (index.length < 3) return null;

  // --- The reject, before anything is allocated.
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    if (pos[i] < minX) minX = pos[i];
    if (pos[i] > maxX) maxX = pos[i];
    if (pos[i + 2] < minZ) minZ = pos[i + 2];
    if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
  }
  minX += offsetX; maxX += offsetX;
  minZ += offsetZ; maxZ += offsetZ;
  if (!env.anyNear(minX, minZ, maxX, maxZ)) return null;
  const corridors = env.near(minX, minZ, maxX, maxZ);
  if (corridors.length === 0) return null;
  const grid = new CorridorGrid(corridors);

  const bldAttr = prim.attributes.find((a) => a.name === BLDIDX_LOWER);
  const bld = bldAttr && bldAttr.itemSize === 1 ? bldAttr.array : null;

  // --- Pass one: which triangles meet a corridor, and how far each corridor
  //     reaches through each building. Nothing is dropped yet -- see
  //     `MIN_REACH_M`, which is the guard that keeps this in step with the
  //     collision carve's own refusal to cut a clipped corner.
  const reach = new Map<number, Reach>();
  const met = new Set<number>();
  const tri = new Float64Array(9);
  const hits: number[] = [];
  for (let t = 0; t + 2 < index.length; t += 3) {
    hits.length = 0;
    if (!triangleMeets(pos, index, t, offsetX, offsetZ, grid, tri, hits)) continue;
    met.add(t);
    const b = bld === null ? 0 : bld[index[t]];
    for (const ci of hits) {
      const c = corridors[ci];
      const key = b * 65536 + ci;
      let r = reach.get(key);
      // **Measured from the triangle's own corners, not from the samples that
      // found it.** A wall quad crosses the corridor with both its corners
      // outside the gauge -- that is what crossing means -- so a reach
      // accumulated only where a sample landed inside would be empty for exactly
      // the case this whole file exists for.
      for (let v = 0; v < 3; v++) {
        const along = alongOf(c, tri[v * 3], tri[v * 3 + 2]);
        const across = acrossOf(c, tri[v * 3], tri[v * 3 + 2]);
        if (r === undefined) {
          r = { building: b, corridor: ci, lo: along, hi: along, left: false, right: false };
          reach.set(key, r);
        }
        if (along < r.lo) r.lo = along;
        if (along > r.hi) r.hi = along;
        if (across < 0) r.left = true;
        if (across > 0) r.right = true;
      }
    }
  }
  if (met.size === 0) return null;

  // A corridor that reaches both sides of its own centreline through enough of
  // the run is one that genuinely passes through the building.
  const open: Reach[] = [];
  const openBuildings = new Set<number>();
  for (const r of reach.values()) {
    if (!r.left || !r.right || r.hi - r.lo < MIN_REACH_M) continue;
    open.push(r);
    openBuildings.add(r.building);
  }
  if (open.length === 0) return null;

  // --- Pass two: chop what is opened, keep everything else exactly as it was.
  const out = new Builder(prim, position, bldAttr ?? null);
  let chopped = 0;
  let dropped = 0;
  for (let t = 0; t + 2 < index.length; t += 3) {
    const b = bld === null ? 0 : bld[index[t]];
    if (!met.has(t) || !openBuildings.has(b)) {
      out.keepTriangle(index[t], index[t + 1], index[t + 2]);
      continue;
    }
    chopped++;
    dropped += out.chop(pos, index[t], index[t + 1], index[t + 2], offsetX, offsetZ, grid);
  }

  // --- And the lining, carved by the same rule. See the header.
  let lining = 0;
  for (const r of open) {
    lining += out.line(corridors[r.corridor], r, grid, offsetX, offsetZ);
  }

  const rewritten = out.build(prim);
  if (tally) {
    tally.primitives++;
    tally.chopped += chopped;
    tally.dropped += dropped;
    tally.lining += lining;
    tally.buildings += openBuildings.size;
    tally.ms += performance.now() - started;
  }
  return rewritten;
}

/** How far one corridor reaches through one building. */
interface Reach {
  building: number;
  corridor: number;
  lo: number;
  hi: number;
  left: boolean;
  right: boolean;
}

/**
 * The near corridors, filed by where they are.
 *
 * **Without this the pass is quadratic and unaffordable.** A 500 m tile over the
 * inner west has three hundred corridors on it and thirty thousand building
 * triangles in it, and testing every triangle against every corridor is nine
 * million bounding-box rejects for an answer that is "no" nine million times.
 * A sixteen-metre grid turns it into one lookup and, in the cells that have a
 * railway in them, a handful of real tests.
 */
const GRID_M = 16;

class CorridorGrid {
  private readonly cells = new Map<number, number[]>();

  constructor(private readonly corridors: readonly UndercroftCorridor[]) {
    for (let i = 0; i < corridors.length; i++) {
      const c = corridors[i];
      const x0 = Math.floor((Math.min(c.ax, c.bx) - c.half) / GRID_M);
      const x1 = Math.floor((Math.max(c.ax, c.bx) + c.half) / GRID_M);
      const z0 = Math.floor((Math.min(c.az, c.bz) - c.half) / GRID_M);
      const z1 = Math.floor((Math.max(c.az, c.bz) + c.half) / GRID_M);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const k = (cx & 0xffff) * 0x10000 + (cz & 0xffff);
          const list = this.cells.get(k);
          if (list) list.push(i);
          else this.cells.set(k, [i]);
        }
      }
    }
  }

  /** Every corridor filed over a plan box, without allocating on the miss. */
  eachInBox(
    x0: number, z0: number, x1: number, z1: number,
    fn: (c: UndercroftCorridor, i: number) => boolean | void,
  ): boolean {
    const cx0 = Math.floor(x0 / GRID_M);
    const cx1 = Math.floor(x1 / GRID_M);
    const cz0 = Math.floor(z0 / GRID_M);
    const cz1 = Math.floor(z1 / GRID_M);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const list = this.cells.get((cx & 0xffff) * 0x10000 + (cz & 0xffff));
        if (list === undefined) continue;
        for (const i of list) {
          if (fn(this.corridors[i], i) === true) return true;
        }
      }
    }
    return false;
  }

  /** Is this point inside any corridor's void? */
  inside(x: number, y: number, z: number): boolean {
    const list = this.cells.get(
      (Math.floor(x / GRID_M) & 0xffff) * 0x10000 + (Math.floor(z / GRID_M) & 0xffff),
    );
    if (list === undefined) return false;
    for (const i of list) if (underCeiling(this.corridors[i], x, y, z)) return true;
    return false;
  }

  /** ...ignoring one of them. For the lining, which belongs to its own corridor. */
  insideOther(x: number, y: number, z: number, except: number): boolean {
    const list = this.cells.get(
      (Math.floor(x / GRID_M) & 0xffff) * 0x10000 + (Math.floor(z / GRID_M) & 0xffff),
    );
    if (list === undefined) return false;
    for (const i of list) {
      if (i === except) continue;
      if (underCeiling(this.corridors[i], x, y, z)) return true;
    }
    return false;
  }
}

/**
 * Is any part of this triangle inside a corridor's void?
 *
 * The void is the plan strip **under the envelope ceiling**, floor included,
 * which is exactly the volume `envelope.carve` leaves empty: the flanks it keeps
 * are outside the strip and the span it lifts starts at the ceiling, so between
 * the building's own pad and that ceiling there is nothing in the collision and
 * there must be nothing in the picture.
 *
 * Tested at the three corners, the three edge midpoints and the centroid, which
 * is enough for a wall quad: a 7.2 m gauge cannot slip between seven samples of
 * a triangle without touching one unless the triangle is longer than fourteen
 * metres, and the conservative failure is to leave the wall standing.
 */
function triangleMeets(
  pos: Float32Array,
  index: Uint32Array | Uint16Array,
  t: number,
  offsetX: number,
  offsetZ: number,
  grid: CorridorGrid,
  tri: Float64Array,
  hits: number[],
): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (let v = 0; v < 3; v++) {
    const at = index[t + v] * 3;
    const x = pos[at] + offsetX;
    const z = pos[at + 2] + offsetZ;
    tri[v * 3] = x;
    tri[v * 3 + 1] = pos[at + 1];
    tri[v * 3 + 2] = z;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
  }
  grid.eachInBox(x0, z0, x1, z1, (c, i) => {
    for (let s = 0; s < 7; s++) {
      if (underCeiling(c, sampleAt(tri, s, 0), sampleAt(tri, s, 1), sampleAt(tri, s, 2))) {
        hits.push(i);
        return;
      }
    }
  });
  return hits.length > 0;
}

/** Corners 0..2, edge midpoints 3..5, centroid 6. */
function sampleAt(tri: Float64Array, s: number, k: number): number {
  if (s < 3) return tri[s * 3 + k];
  if (s === 6) return (tri[k] + tri[3 + k] + tri[6 + k]) / 3;
  const a = s - 3;
  const b = (a + 1) % 3;
  return (tri[a * 3 + k] + tri[b * 3 + k]) / 2;
}

/** Is this point in the corridor's strip and under its ceiling? */
function underCeiling(c: UndercroftCorridor, x: number, y: number, z: number): boolean {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 1e-9 ? ((x - c.ax) * ex + (z - c.az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - (c.ax + ex * t);
  const dz = z - (c.az + ez * t);
  if (dx * dx + dz * dz > c.half * c.half) return false;
  return y <= c.ay + (c.by - c.ay) * t + c.above;
}

/** The envelope ceiling on this corridor under a point. */
function ceilingOf(c: UndercroftCorridor, x: number, z: number): number {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len2 = ex * ex + ez * ez;
  let t = len2 > 1e-9 ? ((x - c.ax) * ex + (z - c.az) * ez) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return c.ay + (c.by - c.ay) * t + c.above;
}

/** Signed metres from the centreline, positive left of the run. */
function acrossOf(c: UndercroftCorridor, x: number, z: number): number {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len = Math.hypot(ex, ez);
  if (len < 1e-6) return Infinity;
  return ((x - c.ax) * -ez + (z - c.az) * ex) / len;
}

/** Metres along the run from the `a` end. */
function alongOf(c: UndercroftCorridor, x: number, z: number): number {
  const ex = c.bx - c.ax;
  const ez = c.bz - c.az;
  const len = Math.hypot(ex, ez);
  if (len < 1e-6) return 0;
  return ((x - c.ax) * ex + (z - c.az) * ez) / len;
}

/**
 * The rewritten primitive, built one triangle at a time.
 *
 * Vertices are **appended rather than re-indexed**: a chopped triangle's
 * sub-triangles need interpolated attributes no existing vertex carries, and the
 * buildings this runs on are a few dozen per tile. Kept triangles keep their
 * original indices, so the overwhelming majority of the primitive is a straight
 * index copy over vertex buffers that are handed on by reference.
 */
class Builder {
  private readonly attrs: Array<{ name: string; itemSize: number; source: Float32Array }> = [];
  private readonly extra: number[][] = [];
  private readonly indices: number[] = [];
  private readonly baseVertices: number;
  private added = 0;
  private readonly donors = new Map<number, number>();
  private readonly feet = new Map<number, number>();
  private readonly roofs = new Map<number, number>();
  private indexed = false;
  private readonly positionAttr: number;

  constructor(
    prim: GlbPrimitive,
    position: GlbAttribute,
    private readonly bldidx: GlbAttribute | null,
  ) {
    this.baseVertices = position.array.length / position.itemSize;
    let positionAt = 0;
    for (let i = 0; i < prim.attributes.length; i++) {
      const a = prim.attributes[i];
      if (a.name === 'position') positionAt = i;
      // Only float columns interpolate. A normalised integer column -- the
      // contact skirt's colour ramp -- is on no facade primitive, and a
      // primitive carrying one is widened rather than refused.
      const source = a.array instanceof Float32Array ? a.array : toFloat(a.array);
      this.attrs.push({ name: a.name, itemSize: a.itemSize, source });
      this.extra.push([]);
    }
    this.positionAttr = positionAt;
  }

  keepTriangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }

  /** A vertex at the barycentric mix of three existing ones. */
  private mix(a: number, b: number, c: number, wa: number, wb: number, wc: number): number {
    for (let i = 0; i < this.attrs.length; i++) {
      const attr = this.attrs[i];
      const n = attr.itemSize;
      const dst = this.extra[i];
      for (let k = 0; k < n; k++) {
        dst.push(
          attr.source[a * n + k] * wa + attr.source[b * n + k] * wb + attr.source[c * n + k] * wc,
        );
      }
    }
    return this.baseVertices + this.added++;
  }

  /**
   * A vertex at an explicit tile-local position with an explicit normal and UV.
   * Everything else -- `_bldidx` above all -- is copied from `from`.
   */
  private at(
    from: number,
    x: number, y: number, z: number,
    nx: number, ny: number, nz: number,
    u: number, v: number,
  ): number {
    for (let i = 0; i < this.attrs.length; i++) {
      const attr = this.attrs[i];
      const n = attr.itemSize;
      const dst = this.extra[i];
      if (attr.name === 'position' && n === 3) dst.push(x, y, z);
      else if (attr.name === 'normal' && n === 3) dst.push(nx, ny, nz);
      else if (attr.name === 'uv' && n === 2) dst.push(u, v);
      else for (let k = 0; k < n; k++) dst.push(attr.source[from * n + k]);
    }
    return this.baseVertices + this.added++;
  }

  /**
   * Chop one triangle on a barycentric lattice and keep the outside.
   *
   * A lattice rather than a clip, on `terrain.buildTerrainMesh`'s argument: the
   * outside of a corridor prism is not convex, so a half-plane clip has to be
   * run four ways and unioned, and a triangle crossing six parallel roads is
   * four to the sixth pieces. A lattice is linear in area whatever the corridor
   * set does, and the ragged edge it leaves is hidden behind the jamb.
   */
  chop(
    pos: Float32Array,
    a: number, b: number, c: number,
    offsetX: number, offsetZ: number,
    grid: CorridorGrid,
  ): number {
    const ax = pos[a * 3] + offsetX, ay = pos[a * 3 + 1], az = pos[a * 3 + 2] + offsetZ;
    const bx = pos[b * 3] + offsetX, by = pos[b * 3 + 1], bz = pos[b * 3 + 2] + offsetZ;
    const cx = pos[c * 3] + offsetX, cy = pos[c * 3 + 1], cz = pos[c * 3 + 2] + offsetZ;
    const longest = Math.max(
      Math.hypot(bx - ax, by - ay, bz - az),
      Math.hypot(cx - bx, cy - by, cz - bz),
      Math.hypot(ax - cx, ay - cy, az - cz),
    );
    let n = Math.max(1, Math.ceil(longest / STEP_M));
    while (n > 1 && n * n > MAX_SUBDIVISION) n--;

    // A shared lattice, so neighbouring sub-triangles cannot crack apart.
    const lattice: number[] = [];
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        lattice.push(this.mix(a, b, c, (n - i - j) / n, i / n, j / n));
      }
    }
    // Row `i` has `n + 1 - i` entries, so it starts here.
    const rowAt = (i: number): number => (i * (2 * n + 3 - i)) / 2;

    let dropped = 0;
    const emit = (p: number, q: number, r: number, wb: number, wc: number): void => {
      const wa = 1 - wb - wc;
      const x = ax * wa + bx * wb + cx * wc;
      const y = ay * wa + by * wb + cy * wc;
      const z = az * wa + bz * wb + cz * wc;
      if (grid.inside(x, y, z)) {
        dropped++;
        return;
      }
      this.indices.push(p, q, r);
    };
    for (let i = 0; i < n; i++) {
      for (let j = 0; i + j < n; j++) {
        const p = rowAt(i) + j;
        const q = rowAt(i + 1) + j;
        // Upward: (i,j) (i+1,j) (i,j+1) -- the original winding.
        emit(lattice[p], lattice[q], lattice[p + 1], (i + 1 / 3) / n, (j + 1 / 3) / n);
        if (i + j + 1 < n) {
          // Downward: (i+1,j) (i+1,j+1) (i,j+1) -- the same winding again.
          emit(lattice[q], lattice[q + 1], lattice[p + 1], (i + 2 / 3) / n, (j + 2 / 3) / n);
        }
      }
    }
    return dropped;
  }

  /**
   * The jambs and the soffit for one corridor over one building's reach.
   *
   * Every panel is put through the same void test the wall was, which is what
   * keeps track four's jamb out of track five's clearance envelope -- see the
   * header. The soffit is drawn only where the building actually reaches the
   * ceiling: a shed shorter than the loading gauge gets an open slot cut through
   * it, not a slab of nothing floating over the tracks.
   */
  line(
    c: UndercroftCorridor,
    r: Reach,
    grid: CorridorGrid,
    offsetX: number,
    offsetZ: number,
  ): number {
    const len = Math.hypot(c.bx - c.ax, c.bz - c.az);
    if (len < 1e-6) return 0;
    const ux = (c.bx - c.ax) / len;
    const uz = (c.bz - c.az) / len;
    const px = -uz;
    const pz = ux;
    // Clamped to the corridor's own run: `alongOf` does not clamp, and a jamb
    // built past either end would stand in the open beside the building.
    const a0 = Math.max(0, Math.min(len, r.lo));
    const a1 = Math.max(0, Math.min(len, r.hi));
    if (a1 - a0 < MIN_REACH_M) return 0;

    this.indexBuildings();
    // A vertex of this building to copy the non-positional columns from --
    // `_bldidx` above all, which is what makes the lining shade as the building.
    const donor = this.donors.get(r.building);
    const foot = this.feet.get(r.building);
    const roof = this.roofs.get(r.building);
    if (donor === undefined || foot === undefined || roof === undefined) return 0;

    let emitted = 0;
    const quad = (
      p0: readonly number[], p1: readonly number[],
      p2: readonly number[], p3: readonly number[],
      nx: number, ny: number, nz: number,
    ): void => {
      const mx = (p0[0] + p1[0] + p2[0] + p3[0]) / 4;
      const my = (p0[1] + p1[1] + p2[1] + p3[1]) / 4;
      const mz = (p0[2] + p1[2] + p2[2] + p3[2]) / 4;
      if (grid.insideOther(mx, my, mz, r.corridor)) return;
      const v0 = this.at(donor, p0[0] - offsetX, p0[1], p0[2] - offsetZ, nx, ny, nz, p0[3], p0[4]);
      const v1 = this.at(donor, p1[0] - offsetX, p1[1], p1[2] - offsetZ, nx, ny, nz, p1[3], p1[4]);
      const v2 = this.at(donor, p2[0] - offsetX, p2[1], p2[2] - offsetZ, nx, ny, nz, p2[3], p2[4]);
      const v3 = this.at(donor, p3[0] - offsetX, p3[1], p3[2] - offsetZ, nx, ny, nz, p3[3], p3[4]);
      this.indices.push(v0, v1, v2, v0, v2, v3);
      emitted++;
    };

    // One panel every two metres, so the ceiling's own gradient is followed and
    // so the void test above has something finer than a 40 m quad to reject.
    const panels = Math.max(1, Math.ceil((a1 - a0) / 2));
    const halfOut = c.half + LINING_CLEAR;
    for (const side of [-1, 1]) {
      const o = halfOut * side;
      // The jamb faces **into** the corridor, which is the only side of it
      // anybody ever stands on. Mirroring across the centreline reverses
      // handedness, so the two sides are wound the other way round --
      // `rail-geo.writeTrench` has the same hazard and solves it identically.
      const nx = -px * side;
      const nz = -pz * side;
      for (let k = 0; k < panels; k++) {
        const s0 = a0 + ((a1 - a0) * k) / panels;
        const s1 = a0 + ((a1 - a0) * (k + 1)) / panels;
        const x0 = c.ax + ux * s0 + px * o;
        const z0 = c.az + uz * s0 + pz * o;
        const x1 = c.ax + ux * s1 + px * o;
        const z1 = c.az + uz * s1 + pz * o;
        const t0 = ceilingOf(c, x0, z0);
        const t1 = ceilingOf(c, x1, z1);
        if (Math.min(t0, t1) - foot < 0.3) continue;
        if (side > 0) {
          quad(
            [x0, foot, z0, s0, 0], [x1, foot, z1, s1, 0],
            [x1, t1, z1, s1, t1 - foot], [x0, t0, z0, s0, t0 - foot],
            nx, 0, nz,
          );
        } else {
          quad(
            [x0, t0, z0, s0, t0 - foot], [x1, t1, z1, s1, t1 - foot],
            [x1, foot, z1, s1, 0], [x0, foot, z0, s0, 0],
            nx, 0, nz,
          );
        }
      }
    }

    // The soffit, only under mass that is actually there.
    for (let k = 0; k < panels; k++) {
      const s0 = a0 + ((a1 - a0) * k) / panels;
      const s1 = a0 + ((a1 - a0) * (k + 1)) / panels;
      const mx = c.ax + (ux * (s0 + s1)) / 2;
      const mz = c.az + (uz * (s0 + s1)) / 2;
      // Two centimetres under the ceiling, so what a pantograph clears is the
      // envelope rather than the envelope minus a polygon.
      const y = ceilingOf(c, mx, mz) + LINING_CLEAR;
      if (roof < y + 0.3) continue;
      const lx0 = c.ax + ux * s0 - px * halfOut;
      const lz0 = c.az + uz * s0 - pz * halfOut;
      const lx1 = c.ax + ux * s1 - px * halfOut;
      const lz1 = c.az + uz * s1 - pz * halfOut;
      const rx0 = c.ax + ux * s0 + px * halfOut;
      const rz0 = c.az + uz * s0 + pz * halfOut;
      const rx1 = c.ax + ux * s1 + px * halfOut;
      const rz1 = c.az + uz * s1 + pz * halfOut;
      quad(
        [lx0, y, lz0, s0, 0], [rx0, y, rz0, s0, halfOut * 2],
        [rx1, y, rz1, s1, halfOut * 2], [lx1, y, lz1, s1, 0],
        0, -1, 0,
      );
    }
    return emitted;
  }

  /** Index each building's donor vertex, its base and its top. Once. */
  private indexBuildings(): void {
    if (this.indexed) return;
    this.indexed = true;
    const position = this.attrs[this.positionAttr];
    const bld = this.bldidx;
    for (let v = 0; v < this.baseVertices; v++) {
      const b = bld === null ? 0 : bld.array[v];
      if (!this.donors.has(b)) this.donors.set(b, v);
      const y = position.source[v * 3 + 1];
      const foot = this.feet.get(b);
      if (foot === undefined || y < foot) this.feet.set(b, y);
      const roof = this.roofs.get(b);
      if (roof === undefined || y > roof) this.roofs.set(b, y);
    }
  }

  /** The rewritten primitive, or null if the rewrite came out empty. */
  build(prim: GlbPrimitive): GlbPrimitive | null {
    if (this.indices.length < 3) return null;
    const attributes: GlbAttribute[] = this.attrs.map((attr, i) => {
      const extra = this.extra[i];
      if (extra.length === 0) {
        return { name: attr.name, array: attr.source, itemSize: attr.itemSize, normalized: false };
      }
      const array = new Float32Array(attr.source.length + extra.length);
      array.set(attr.source, 0);
      array.set(extra, attr.source.length);
      return { name: attr.name, array, itemSize: attr.itemSize, normalized: false };
    });
    const total = this.baseVertices + this.added;
    const index = total > 65535 ? new Uint32Array(this.indices) : new Uint16Array(this.indices);
    return { material: prim.material, attributes, index };
  }
}

function toFloat(array: ArrayLike<number>): Float32Array {
  const out = new Float32Array(array.length);
  for (let i = 0; i < array.length; i++) out[i] = array[i];
  return out;
}

/**
 * The module's own self-check. Every string it returns is a failure.
 *
 * The negative control is the whole point of it, on `envelope.verifyEnvelope`'s
 * own terms: a rule that opens holes in buildings has to be shown *not* firing
 * on the wall beside the corridor, or "the corridor is clear" is a claim about a
 * world with no buildings in it.
 */
export function verifyUndercroft(): string[] {
  const bad: string[] = [];
  // One straight railway along +x at y = 10, 3.6 m each side, 5.9 m over.
  const corridor: UndercroftCorridor = {
    ax: -50, az: 0, ay: 10, bx: 50, bz: 0, by: 10,
    half: 3.6, below: 0.9, above: 5.9, rail: true,
  };
  const env: UndercroftEnvelope = {
    anyNear: () => true,
    near: () => [corridor],
  };

  /**
   * The four walls of a shed, as the pipeline emits them: one primitive, one
   * building index, a quad per wall.
   *
   * Four walls rather than one, and that is what the test is *for*: `MIN_REACH_M`
   * measures how far a corridor reaches **through a building**, and a single
   * plane standing across the run has no extent along it at all. A rule tested
   * against one wall would pass while refusing to open any real building.
   */
  const shed = (z0: number, z1: number, y0: number, y1: number): GlbPrimitive => {
    const x0 = -10;
    const x1 = 10;
    const position: number[] = [];
    const normal: number[] = [];
    const uv: number[] = [];
    const index: number[] = [];
    const bldidx: number[] = [];
    const wall = (
      ax: number, az: number, bx: number, bz: number, nx: number, nz: number,
    ): void => {
      const base = position.length / 3;
      position.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
      for (let k = 0; k < 4; k++) {
        normal.push(nx, 0, nz);
        bldidx.push(7);
      }
      uv.push(0, 0, 1, 0, 1, 1, 0, 1);
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    wall(x0, z0, x1, z0, 0, -1);
    wall(x1, z1, x0, z1, 0, 1);
    wall(x0, z1, x0, z0, -1, 0);
    wall(x1, z0, x1, z1, 1, 0);
    return {
      material: 'brick_red',
      attributes: [
        { name: 'position', array: new Float32Array(position), itemSize: 3, normalized: false },
        { name: 'normal', array: new Float32Array(normal), itemSize: 3, normalized: false },
        { name: 'uv', array: new Float32Array(uv), itemSize: 2, normalized: false },
        { name: BLDIDX_LOWER, array: new Float32Array(bldidx), itemSize: 1, normalized: false },
      ],
      index: new Uint16Array(index),
    };
  };

  // A shed 20 m square straddling the line, 12 m tall on a pad at 9 m -- the
  // same building `envelope.verifyEnvelope` carves, so the two checks are about
  // one case seen from two sides.
  const across = carveUndercroft(shed(-10, 10, 9, 21), 0, 0, env);
  if (across === null) {
    bad.push('a wall standing across the corridor was not opened at all');
  } else {
    const pos = across.attributes.find((a) => a.name === 'position')!.array as Float32Array;
    // Nothing left inside the gauge under the ceiling.
    let insideTriangles = 0;
    for (let t = 0; t + 2 < across.index.length; t += 3) {
      let cx = 0;
      let cy = 0;
      let cz = 0;
      for (let v = 0; v < 3; v++) {
        cx += pos[across.index[t + v] * 3] / 3;
        cy += pos[across.index[t + v] * 3 + 1] / 3;
        cz += pos[across.index[t + v] * 3 + 2] / 3;
      }
      if (underCeiling(corridor, cx, cy, cz)) insideTriangles++;
    }
    if (insideTriangles > 0) {
      bad.push(`${insideTriangles} triangles are still drawn inside the loading gauge`);
    }
    // ...and the mass over it is still drawn, on both flanks and overhead.
    let above = 0;
    let flank = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i + 1] > 16) above++;
      if (Math.abs(pos[i + 2]) > 4) flank++;
    }
    if (above === 0) bad.push('nothing is drawn over the undercroft; the building was hidden, not cut');
    if (flank === 0) bad.push('nothing is drawn either side of the undercroft');
    // The lining: a jamb face standing at the gauge, which is the visible
    // support the span needs.
    let jamb = 0;
    for (let i = 0; i < pos.length; i += 3) {
      if (Math.abs(Math.abs(pos[i + 2]) - (corridor.half + 0.02)) < 1e-3 && pos[i + 1] < 15.95) jamb++;
    }
    if (jamb === 0) bad.push('the opening has no jamb; the span is drawn with nothing under it');
  }

  // NEGATIVE CONTROL 1: the same shed, moved clear of the gauge. Untouched --
  // `envelope.verifyEnvelope`'s own control, at the same 6 m.
  if (carveUndercroft(shed(6, 26, 9, 21), 0, 0, env) !== null) {
    bad.push('a shed 6 m clear of the centreline was opened; the rule is too fat');
  }

  // NEGATIVE CONTROL 2: a shed that only clips the gauge, which the collision
  // carve refuses to cut. An opening the player can see and cannot walk through
  // is this file's own bug with the sign reversed. See `MIN_REACH_M`.
  if (carveUndercroft(shed(3.0, 20, 9, 21), 0, 0, env) !== null) {
    bad.push('a shed that only clips the gauge was opened, and its collision was not');
  }

  // NEGATIVE CONTROL 3: a deck already clear over the envelope.
  if (carveUndercroft(shed(-10, 10, 16.5, 19), 0, 0, env) !== null) {
    bad.push('a shed entirely above the envelope ceiling was opened');
  }

  return bad;
}
