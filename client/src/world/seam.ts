/**
 * The other end of the wire: the terrain, triangulated to the vessel's own rim.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR.
 *
 * `world/vessel.ts` builds the railway as a closed solid and emits its rim as an
 * ordered ring of **its own vertices, named by index**. Phase 1 proved that ring
 * is sound over 8,360 trenched segments. Nothing consumed it.
 *
 * This file is what consumes it. It answers two questions for
 * `terrain.buildTerrainMesh`, per sub-quad of the terrain lattice:
 *
 *   - **is this cell inside the footprint** -- in which case the terrain does
 *     not draw it, because the vessel supplies every surface there;
 *   - **is this cell crossed by the rim** -- in which case the terrain draws the
 *     part outside the ring, triangulated **to the ring's own vertices**, and
 *     stops exactly there.
 *
 * The old carve answered a coarser question -- is this sub-quad's *centre*
 * inside the corridor -- and left a 3.9 m staircase for `writeTrench` to lap its
 * coping over. There is nothing to lap here.
 *
 * ---------------------------------------------------------------------------
 * **THE SECOND SEAM, WHICH IS THE ONE PHASE 1 LEFT OPEN.**
 *
 * `buildTerrainMesh` is per tile and tile-local. Conforming to a world-space
 * ring means the ring has to be cut where it crosses a tile boundary -- and
 * *those cut points are a seam of exactly the same kind as the rim itself*. Two
 * tiles each clipping their own copy of the ring would disagree in the last bits
 * and reopen the hole one level down, which is the whole failure this redesign
 * exists to end, moved sideways rather than fixed.
 *
 * There are three ways out and only one of them is honest.
 *
 *   1. Let each tile clip, and compare the results with a tolerance. **This is
 *      the design failing.** It is the bug, restated.
 *   2. Compute each crossing once into a table both tiles read. Sound, and what
 *      Phase 1 prescribed.
 *   3. **Compute each crossing once and give it to the vessel**, which splits
 *      its own rim edge there -- so the crossing stops being a terrain vertex at
 *      all and becomes another rim vertex, named by index like every other one.
 *
 * This file does (3), and (3) is (2) with the table deleted, because the table's
 * one reader turns out to be the thing that should have owned the point in the
 * first place. `latticeCuts` walks the vessel's two seam polylines and returns
 * the crossings as `RimCut`s; the vessel is then swept a second time with them
 * in, and *that* vessel is the artifact both consumers read. There is no table,
 * no comparison and no epsilon: a tile asking about a crossing is asking about a
 * vertex of the mesh next to it.
 *
 * What (3) buys over (2) is the thing (2) could not: **no T-junctions.** Under
 * (2) the terrain would put a vertex in the middle of an edge the vessel draws
 * as one straight quad, which is not a hole but is two descriptions of one edge
 * again -- the same defect, one level further down, and the level below that is
 * where it stops being findable.
 *
 * The cost is one extra sweep per run (55-100 us) and about two extra vertices
 * per rim edge. Measured in `server/integration-check.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CELL WALK NEEDS NO POINT-IN-POLYGON, WHICH IS THE OTHER PLACE A
 * TOLERANCE WOULD HAVE CREPT IN.
 *
 * Inside a crossed cell the terrain owns everything outside the ring. Tracing
 * that region means walking the cell perimeter and the ring, and deciding at
 * every step which side of the ring you are on -- which sounds like a
 * point-in-polygon test near the boundary, which is exactly where such a test is
 * worst conditioned.
 *
 * It is not needed. Write the perimeter direction at a boundary point as
 * `p = rot90(n_out)`, which is what "counter-clockwise around the cell" means,
 * and the ring direction there as `r = a n_out + b p`. Then
 *
 *     cross(r, p) = a
 *
 * so the arc *after* a crossing is inside the footprint exactly when the ring is
 * leaving the cell (`a > 0`), and outside exactly when it is entering. The whole
 * classification is "is this the start of a chain or the end of one", which is
 * combinatorial, exact, and self-checking: entries and exits must alternate
 * around the perimeter or the cell is reported rather than drawn.
 *
 * ---------------------------------------------------------------------------
 * **This file imports one type and no code.** It runs in the server's process
 * for the same reason `vessel.ts` does: a client and a server that disagree
 * about which ground exists is a player who falls through on one end only.
 */

import type { RimCut, Vessel } from './vessel.ts';

/**
 * How a lattice line is named: world metres, and lines at exact multiples.
 *
 * The terrain's sub-quad lattice is `tile_size / terrain.grid / CUT_SUBDIVISION`
 * = 500 / 16 / 8 = **3.90625 m**, which is `125/32` and therefore exact in
 * binary, and every tile's bounds are a multiple of 500, so every lattice line
 * in the city is at an exact multiple of it in both axes. That is checked rather
 * than assumed -- see `checkSeam` -- because the whole arrangement below rests
 * on a crossing computed against `m * pitch` in one tile being the same number
 * as the crossing computed against `m * pitch` in the next.
 */
export interface Lattice {
  pitch: number;
}

/** A crossing of one rim edge with one lattice line. */
interface Crossing {
  t: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Where the rim crosses the terrain lattice, as cuts for the vessel to absorb.
 *
 * Walks the two seam polylines by index into the vessel's own `position` -- the
 * vertices `Vessel.ribSeam` names, which is `buildVessel`'s own statement of
 * where the rim is and the reason that array is published. Nothing is
 * re-approximated: the endpoints are the vessel's numbers and the crossing is
 * placed on the lattice line *exactly*, with only the other two coordinates
 * interpolated.
 *
 * **`ribSeam` and not `rib * perRib + point`, since Phase 3.** A transition rib
 * changes how many points a profile has, so there is no stride to multiply by
 * and no single loop index that means "the left rim" over a whole run. A module
 * that computed the vertex would be a module that could compute it wrong; this
 * one is told, by the object that knows.
 *
 * Returns an empty list for a disposition with no surface expression, because a
 * viaduct or a bore has no rim for the terrain to meet.
 */
export function latticeCuts(vessel: Vessel, lattice: Lattice): RimCut[] {
  if (vessel.ribSeam === null || vessel.ribCount < 2) return [];
  const { position, ribSeam } = vessel;
  const out: RimCut[] = [];
  const found: Crossing[] = [];
  for (const side of [0, 1] as const) {
    for (let i = 0; i < vessel.ribCount - 1; i++) {
      const a = ribSeam[i * 2 + side] * 3;
      const b = ribSeam[(i + 1) * 2 + side] * 3;
      found.length = 0;
      edgeCrossings(
        position[a], position[a + 1], position[a + 2],
        position[b], position[b + 1], position[b + 2],
        lattice.pitch, found,
      );
      for (const c of found) out.push({ rib: i, side, t: c.t, x: c.x, y: c.y, z: c.z });
    }
  }
  return out;
}

/**
 * Every lattice line one segment crosses, in order along it.
 *
 * The coordinate on the line it crosses is set to the line, not interpolated to
 * it: a point that is *meant* to be at `x = m * pitch` and is instead at
 * `m * pitch + 1e-13` is on one side of the line for one cell and the other side
 * for its neighbour, and that is a hole with no name. The other two coordinates
 * are interpolated, once, here.
 */
function edgeCrossings(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  pitch: number,
  out: Crossing[],
): void {
  const dx = bx - ax;
  const dz = bz - az;
  if (dx !== 0) {
    const lo = Math.min(ax, bx);
    const hi = Math.max(ax, bx);
    for (let m = Math.floor(lo / pitch) + 1; m * pitch < hi; m++) {
      const X = m * pitch;
      if (X <= lo) continue;
      const t = (X - ax) / dx;
      if (!(t > 0 && t < 1)) continue;
      out.push({ t, x: X, y: ay + (by - ay) * t, z: az + (bz - az) * t });
    }
  }
  if (dz !== 0) {
    const lo = Math.min(az, bz);
    const hi = Math.max(az, bz);
    for (let n = Math.floor(lo / pitch) + 1; n * pitch < hi; n++) {
      const Z = n * pitch;
      if (Z <= lo) continue;
      const t = (Z - az) / dz;
      if (!(t > 0 && t < 1)) continue;
      out.push({ t, x: ax + (bx - ax) * t, y: ay + (by - ay) * t, z: Z });
    }
  }
  out.sort((p, q) => p.t - q.t);
  // A segment through a lattice *corner* produces the same parameter twice. Both
  // points are the corner; keeping both would be two vertices at one place,
  // which `checkManifold` calls an unwelded seam and is right to. Compared on
  // `t` exactly -- two crossings that are merely close are two crossings, on two
  // different lines, and both are real.
  let w = 0;
  for (let r = 0; r < out.length; r++) {
    if (w > 0 && out[r].t === out[w - 1].t) continue;
    out[w++] = out[r];
  }
  out.length = w;
}

// --- The footprint ------------------------------------------------------------------

/** One node of a conformed cell: a lattice corner, or a point of the rim. */
export interface SeamNode {
  /**
   * Which corner of the cell, `0` south-west through `3` in the counter-
   * clockwise order below, or `-1` for a rim vertex.
   *
   * A corner is named rather than positioned because the terrain already has a
   * vertex there with a height, a normal and a UV it computed from its own grid,
   * and a second vertex at the same place would be the unwelded seam again.
   */
  corner: number;
  x: number;
  /** The rim's own height. Meaningless, and unread, for a corner. */
  y: number;
  z: number;
}

/** How a cell relates to the footprint. */
export const CELL_OUTSIDE = 0;
export const CELL_INSIDE = 1;
export const CELL_CROSSED = 2;

/**
 * One vessel's footprint, indexed on the terrain's own lattice.
 *
 * Built from the **cut** vessel -- the one whose rim edges have already absorbed
 * their lattice crossings -- so almost every rim edge already lies inside a
 * single cell and this constructor has nothing left to subdivide. The exception
 * is the two end **chords**: the rim ring closes across the open mouth of the
 * cutting at each end of a run, and that chord is not an edge of the mesh at all
 * (loop points 2 and 7 of a trench are not adjacent), so there is nothing there
 * to cut and the crossings on it are genuinely the terrain's own.
 */
export class Footprint {
  /** The subdivided ring: `x, y, z` per point, closed from the last back to 0. */
  readonly pts: Float64Array;
  /** Cell key -> the ring segments inside it, as indices of `pts`. */
  private readonly crossed = new Map<number, number[]>();
  /** Cell keys wholly inside the ring. */
  private readonly inside = new Set<number>();
  readonly pitch: number;
  readonly minM: number;
  readonly maxM: number;
  readonly minN: number;
  readonly maxN: number;
  /** Ring points that were not vertices of the vessel. See the class note. */
  readonly interpolated: number;
  /**
   * Ring segments lying exactly **along** a lattice line, which this cannot trace.
   *
   * The one degeneracy the cell walk does not survive, and it is named rather
   * than papered over. A segment collinear with a cell edge belongs to neither
   * cell either side of it: the cell it bounds has no interior arc for the walk
   * to follow, and the region it would enclose has zero area. A rim that lands
   * exactly on a 3.90625 m line is a coincidence a swept railway on a DEM does
   * not produce -- `server/integration-check.ts` asserts this is zero over the
   * real corridor -- but "does not produce" is not "cannot", so a cell holding
   * one is refused by name and dropped, and the count is on the outside of the
   * class where a check can see it.
   */
  readonly axisAligned: number;

  constructor(position: Float64Array, rim: Uint32Array, lattice: Lattice) {
    this.pitch = lattice.pitch;
    const pts: number[] = [];
    let interpolated = 0;
    const found: Crossing[] = [];
    for (let k = 0; k < rim.length; k++) {
      const a = rim[k] * 3;
      const b = rim[(k + 1) % rim.length] * 3;
      pts.push(position[a], position[a + 1], position[a + 2]);
      found.length = 0;
      edgeCrossings(
        position[a], position[a + 1], position[a + 2],
        position[b], position[b + 1], position[b + 2],
        lattice.pitch, found,
      );
      for (const c of found) {
        pts.push(c.x, c.y, c.z);
        interpolated++;
      }
    }
    this.pts = new Float64Array(pts);
    this.interpolated = interpolated;

    const n = this.pts.length / 3;
    let axisAligned = 0;
    let minM = Infinity;
    let maxM = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (let k = 0; k < n; k++) {
      const k2 = (k + 1) % n;
      // The cell a segment is in, from its midpoint. Both endpoints are on that
      // cell's boundary by construction, so the midpoint is the only point of it
      // guaranteed to be strictly inside.
      const mx = (this.pts[k * 3] + this.pts[k2 * 3]) / 2;
      const mz = (this.pts[k * 3 + 2] + this.pts[k2 * 3 + 2]) / 2;
      const m = Math.floor(mx / lattice.pitch);
      const nn = Math.floor(mz / lattice.pitch);
      if (mx === m * lattice.pitch || mz === nn * lattice.pitch) axisAligned++;
      const key = cellKey(m, nn);
      const list = this.crossed.get(key);
      if (list) list.push(k);
      else this.crossed.set(key, [k]);
      if (m < minM) minM = m;
      if (m > maxM) maxM = m;
      if (nn < minN) minN = nn;
      if (nn > maxN) maxN = nn;
    }
    this.minM = minM;
    this.maxM = maxM;
    this.minN = minN;
    this.maxN = maxN;
    this.axisAligned = axisAligned;

    // The interior, by scanline down the middle of each cell row.
    //
    // Exact, and it is worth saying why rather than treating a scanline as an
    // approximation of an area test. A cell with no ring segment in it is wholly
    // inside or wholly outside -- there is no third option, because a cell that
    // were partly both would have the boundary running through it. So one point
    // decides it, and the cell's own centre row is as good as any and costs one
    // sweep of the ring per row instead of one per cell.
    const xs: number[] = [];
    for (let row = minN; row <= maxN; row++) {
      const z = (row + 0.5) * lattice.pitch;
      xs.length = 0;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        const z0 = this.pts[k * 3 + 2];
        const z1 = this.pts[k2 * 3 + 2];
        if ((z0 <= z) === (z1 <= z)) continue;
        const x0 = this.pts[k * 3];
        const x1 = this.pts[k2 * 3];
        xs.push(x0 + ((z - z0) / (z1 - z0)) * (x1 - x0));
      }
      if (xs.length < 2) continue;
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const c0 = Math.floor(xs[s] / lattice.pitch);
        const c1 = Math.floor(xs[s + 1] / lattice.pitch);
        for (let m = c0; m <= c1; m++) {
          const key = cellKey(m, row);
          if (!this.crossed.has(key)) this.inside.add(key);
        }
      }
    }
  }

  /** How many cells the ring runs through, and how many it swallows. */
  get cells(): { crossed: number; inside: number } {
    return { crossed: this.crossed.size, inside: this.inside.size };
  }

  /**
   * Every lattice cell this footprint claims, as packed keys, `true` for the ones
   * it swallows whole.
   *
   * Published so a caller can ask whether **two** footprints claim one cell,
   * which is the question `STATIONS.md` Phase 3 is about and which cannot be
   * answered by walking a bounding box: a 4.8 km formation's box is a million
   * cells and its claim is nine thousand of them.
   */
  *claimed(): Generator<[number, boolean]> {
    for (const k of this.inside) yield [k, true];
    for (const k of this.crossed.keys()) yield [k, false];
  }

  /** `CELL_OUTSIDE`, `CELL_INSIDE` or `CELL_CROSSED`, for one lattice cell. */
  state(m: number, n: number): number {
    const key = cellKey(m, n);
    if (this.crossed.has(key)) return CELL_CROSSED;
    return this.inside.has(key) ? CELL_INSIDE : CELL_OUTSIDE;
  }

  /**
   * The rim, as it crosses one cell: ordered chains from boundary to boundary.
   *
   * A chain is a maximal run of consecutive ring segments filed in this cell, so
   * its two ends are on the cell's own boundary -- the segment before it and the
   * segment after it are somewhere else, and the point between them is therefore
   * a lattice crossing. Interior points of a chain are rim vertices lying inside
   * the cell.
   *
   * Returns null and names a reason where the cell cannot be made sense of. That
   * is a refusal, not a repair, and it is counted: a cell nobody could trace is
   * dropped and reported, where a cell traced *plausibly* is how three previous
   * rounds shipped a hole.
   */
  chainsIn(m: number, n: number, faults: string[]): SeamNode[][] | null {
    const segs = this.crossed.get(cellKey(m, n));
    if (segs === undefined) return null;
    const pitch = this.pitch;
    const total = this.pts.length / 3;
    for (const k of segs) {
      const k2 = (k + 1) % total;
      const mx = (this.pts[k * 3] + this.pts[k2 * 3]) / 2;
      const mz = (this.pts[k * 3 + 2] + this.pts[k2 * 3 + 2]) / 2;
      if (mx === Math.floor(mx / pitch) * pitch || mz === Math.floor(mz / pitch) * pitch) {
        faults.push(`cell ${m},${n}: a rim segment lies exactly along a lattice line`);
        return null;
      }
    }
    const set = new Set(segs);
    const out: SeamNode[][] = [];
    for (const k of segs) {
      // A chain starts where its predecessor is somewhere else.
      if (set.has((k + total - 1) % total)) continue;
      let end = k;
      let guard = total;
      while (set.has((end + 1) % total) && guard-- > 0) end = (end + 1) % total;
      const chain: SeamNode[] = [];
      for (let j = k; ; j = (j + 1) % total) {
        chain.push({ corner: -1, x: this.pts[j * 3], y: this.pts[j * 3 + 1], z: this.pts[j * 3 + 2] });
        if (j === end) break;
      }
      const last = (end + 1) % total;
      chain.push({ corner: -1, x: this.pts[last * 3], y: this.pts[last * 3 + 1], z: this.pts[last * 3 + 2] });
      out.push(chain);
    }
    if (out.length === 0) {
      // Every segment in the cell is part of one cycle with no start: the ring
      // never leaves this cell. A whole run inside 3.9 m is not a corridor.
      faults.push(`cell ${m},${n}: the ring closes inside one cell`);
      return null;
    }
    return out;
  }
}

/**
 * The part of one cell the terrain still owns, given every rim that crosses it.
 *
 * ---------------------------------------------------------------------------
 * **WHY THIS TAKES CHAINS FROM SEVERAL FOOTPRINTS AND NOT ONE.**
 *
 * Measured at Erskineville while building this: **61.5% of the lattice cells the
 * corridor claims are claimed by more than one run.** That is not a junction
 * artefact and it is not rare -- it is ordinary parallel double track. Each
 * track in the bake is its own polyline, so each becomes its own run, and two
 * running lines 4 m apart with a 5.4 m half-width overlap along their whole
 * length. Phase 1 measured closure per run and never measured this, because
 * nothing consumed a footprint.
 *
 * So the terrain's question is not "what does this vessel's rim keep" but "what
 * does the **union** of them keep", and the two are different everywhere two
 * tracks run beside each other -- which in Sydney is most of the network. A
 * conformer that answered the first would draw ground inside the neighbouring
 * trench.
 *
 * The union is taken here, at the cell, and exactly: a perimeter arc is the
 * terrain's only where it is inside **no** footprint. Crossing a chain inward
 * adds one to the depth and crossing it outward takes one away, and the arcs at
 * depth zero are the ones kept. Which way a crossing counts is combinatorial and
 * needs no geometry -- see the file header -- so this is a counter, not a
 * point-in-polygon test near a boundary.
 *
 * What it does **not** do is handle two rims that properly cross *inside* one
 * cell. There the arrangement has a vertex the cell walk has no node for, and
 * the depth bookkeeping goes inconsistent -- which is detected, named and
 * refused rather than drawn. That is the same class as the junction footprints
 * `STATIONS.md` enumerates and refuses, and it is measured with them.
 */
export function traceCell(
  m: number,
  n: number,
  pitch: number,
  chains: readonly SeamNode[][],
  owner: readonly number[],
  faults: string[],
): SeamNode[][] | null {
  const x0 = m * pitch;
  const x1 = (m + 1) * pitch;
  const z0 = n * pitch;
  const z1 = (n + 1) * pitch;

  /** Where a boundary point sits on the perimeter, in `0..4`. */
  const perimeterU = (px: number, pz: number): number => {
    if (pz === z0 && px >= x0 && px <= x1) return (px - x0) / pitch;
    if (px === x1 && pz >= z0 && pz <= z1) return 1 + (pz - z0) / pitch;
    if (pz === z1 && px >= x0 && px <= x1) return 2 + (x1 - px) / pitch;
    if (px === x0 && pz >= z0 && pz <= z1) return 3 + (z1 - pz) / pitch;
    return Number.NaN;
  };

  interface Node {
    u: number;
    /** `1` a chain start, `-1` a chain end, `0` a cell corner. */
    kind: number;
    chain: number;
    pt: SeamNode | null;
    corner: number;
  }
  const nodes: Node[] = [];
  for (let c = 0; c < 4; c++) {
    const cx = c === 0 || c === 3 ? x0 : x1;
    const cz = c === 0 || c === 1 ? z0 : z1;
    nodes.push({ u: c, kind: 0, chain: -1, pt: { corner: c, x: cx, y: Number.NaN, z: cz }, corner: c });
  }
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const enter = chain[0];
    const leave = chain[chain.length - 1];
    const ue = perimeterU(enter.x, enter.z);
    const ul = perimeterU(leave.x, leave.z);
    if (!Number.isFinite(ue) || !Number.isFinite(ul)) {
      faults.push(
        `cell ${m},${n}: a chain end is not on the cell boundary ` +
          `(${enter.x.toFixed(3)}, ${enter.z.toFixed(3)})`,
      );
      return null;
    }
    nodes.push({ u: ue, kind: 1, chain: ci, pt: enter, corner: -1 });
    nodes.push({ u: ul, kind: -1, chain: ci, pt: leave, corner: -1 });
  }
  nodes.sort((p, q) => p.u - q.u || Math.abs(p.kind) - Math.abs(q.kind));
  // A crossing exactly on a lattice corner leaves two nodes at one place. The
  // rim's own point wins: it carries the vessel's height, and the corner's does
  // not.
  const kept: Node[] = [];
  for (const nd of nodes) {
    const last = kept[kept.length - 1];
    if (last !== undefined && last.u === nd.u) {
      if (last.kind === 0) kept[kept.length - 1] = nd;
      continue;
    }
    kept.push(nd);
  }
  const K = kept.length;

  // --- How deep inside the union each perimeter arc is.
  //
  // **Per footprint first, then summed**, and the order matters. One
  // footprint's own chains settle its own in/out around the whole perimeter with
  // no anchor needed: a chain start means its rim is entering the cell, so what
  // follows round the perimeter is *outside* that footprint, and a chain end
  // means the opposite. That is the combinatorial rule the header derives and it
  // is absolute, not relative -- which is exactly what a running counter over
  // pooled chains is not. A counter anchored on its own minimum assumes some arc
  // is outside everything, and two rims can between them cover a cell that
  // neither covers alone.
  //
  // Alternation is checked per footprint, because a footprint whose entries and
  // exits do not alternate around the perimeter is one whose rim crosses another
  // inside this cell -- the case this refuses by name.
  const depth = new Int32Array(K);
  const owners = new Set<number>();
  for (const o of owner) owners.add(o);
  for (const o of owners) {
    let seed = -1;
    for (let i = 0; i < K; i++) {
      if (kept[i].kind !== 0 && owner[kept[i].chain] === o) { seed = i; break; }
    }
    if (seed < 0) continue;
    let st = kept[seed].kind === 1 ? 0 : 1;
    let last = 0;
    for (let s = 0; s < K; s++) {
      const i = (seed + s) % K;
      const nd = kept[i];
      if (nd.kind !== 0 && owner[nd.chain] === o) {
        if (nd.kind === last) {
          faults.push(`cell ${m},${n}: one rim crosses the perimeter twice the same way`);
          return null;
        }
        last = nd.kind;
        st = nd.kind === 1 ? 0 : 1;
      }
      if (st) depth[i]++;
    }
  }
  let anyOutside = false;
  for (let i = 0; i < K; i++) if (depth[i] === 0) anyOutside = true;
  if (!anyOutside) return null;

  // --- Trace. Every node has one way out or none, so this is a walk.
  const startOf = new Map<number, number>();
  for (let i = 0; i < K; i++) if (kept[i].kind === 1) startOf.set(kept[i].chain, i);
  const seen = new Uint8Array(K);
  const loops: SeamNode[][] = [];
  for (let s0 = 0; s0 < K; s0++) {
    if (seen[s0] || depth[s0] !== 0) continue;
    const loop: SeamNode[] = [];
    let i = s0;
    let guard = K * 2 + 8;
    for (;;) {
      if (seen[i]) break;
      seen[i] = 1;
      loop.push(kept[i].pt!);
      const prev = (i + K - 1) % K;
      if (kept[i].kind === -1 && depth[prev] === 0) {
        // The chain bounds the ground we are walking, so follow it back --
        // against the rim's own direction, because the terrain is on its right.
        const chain = chains[kept[i].chain];
        for (let j = chain.length - 2; j >= 1; j--) loop.push(chain[j]);
        const back = startOf.get(kept[i].chain);
        if (back === undefined) {
          faults.push(`cell ${m},${n}: a chain end has no matching start`);
          return null;
        }
        i = back;
      } else if (depth[i] === 0) {
        i = (i + 1) % K;
      } else {
        faults.push(`cell ${m},${n}: the walk ran into ground a vessel owns`);
        return null;
      }
      if (guard-- <= 0) {
        faults.push(`cell ${m},${n}: the perimeter walk did not close`);
        return null;
      }
      if (i === s0) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  if (loops.length === 0) {
    faults.push(`cell ${m},${n}: crossed, but the walk kept no ground at all`);
    return null;
  }
  return loops;
}

/**
 * Two 20-bit signed fields, `world/rail-cut.ts`' key at a finer pitch.
 *
 * At 3.90625 m a cell the 60 km world is +/-15,360 cells, which is well inside
 * the +/-524,288 the field holds, so there is no chance of a collision.
 */
function cellKey(m: number, n: number): number {
  return (m & 0xfffff) * 0x100000 + (n & 0xfffff);
}

// --- Many footprints, as one thing the terrain can ask ------------------------------

/**
 * Every corridor footprint in play, as the terrain sees it.
 *
 * A thin index over `Footprint`s, because a tile wants to ask about a cell
 * without knowing which run of railway that cell belongs to, and a run is
 * kilometres long while a tile is 500 m. Bucketed by tile-sized cells so a
 * tile's query touches one bucket.
 */
export class SeamField {
  private readonly prints: Footprint[] = [];
  private readonly buckets = new Map<number, number[]>();
  readonly pitch: number;
  /** Tile-sized bucket, in lattice cells. */
  private readonly bucket: number;

  constructor(lattice: Lattice, bucketMetres = 500) {
    this.pitch = lattice.pitch;
    this.bucket = Math.max(1, Math.round(bucketMetres / lattice.pitch));
  }

  add(print: Footprint): void {
    const at = this.prints.length;
    this.prints.push(print);
    const b = this.bucket;
    for (let m = Math.floor(print.minM / b); m <= Math.floor(print.maxM / b); m++) {
      for (let n = Math.floor(print.minN / b); n <= Math.floor(print.maxN / b); n++) {
        const key = cellKey(m, n);
        const list = this.buckets.get(key);
        if (list) list.push(at);
        else this.buckets.set(key, [at]);
      }
    }
  }

  get count(): number {
    return this.prints.length;
  }

  /** Which footprints could touch this cell at all. */
  private near(m: number, n: number): readonly number[] {
    return this.buckets.get(cellKey(Math.floor(m / this.bucket), Math.floor(n / this.bucket))) ?? EMPTY;
  }

  /**
   * What the **union** of the footprints makes of this cell.
   *
   * `CELL_INSIDE` beats `CELL_CROSSED`, and that ordering is the whole of the
   * union at cell granularity: a cell wholly inside one run's footprint is
   * ground the railway has taken, and the fact that a *second* run's rim also
   * clips it changes nothing about who owns it. Getting this the other way round
   * -- which the first draft did -- draws the second run's kept ground straight
   * across the first run's trench, which is a floor over a hole and looks exactly
   * like the world working.
   */
  state(m: number, n: number): number {
    let crossed = false;
    for (const i of this.near(m, n)) {
      const s = this.prints[i].state(m, n);
      if (s === CELL_INSIDE) return CELL_INSIDE;
      if (s === CELL_CROSSED) crossed = true;
    }
    return crossed ? CELL_CROSSED : CELL_OUTSIDE;
  }

  /** Is any footprint within `pad` metres of this box? The terrain's broad phase. */
  nearBox(wx0: number, wz0: number, wx1: number, wz1: number, pad: number): boolean {
    const p = this.pitch;
    const m0 = Math.floor((wx0 - pad) / p);
    const m1 = Math.floor((wx1 + pad) / p);
    const n0 = Math.floor((wz0 - pad) / p);
    const n1 = Math.floor((wz1 + pad) / p);
    for (let m = Math.floor(m0 / this.bucket); m <= Math.floor(m1 / this.bucket); m++) {
      for (let n = Math.floor(n0 / this.bucket); n <= Math.floor(n1 / this.bucket); n++) {
        const list = this.buckets.get(cellKey(m, n));
        if (list === undefined) continue;
        for (const i of list) {
          const f = this.prints[i];
          if (f.maxM < m0 || f.minM > m1 || f.maxN < n0 || f.minN > n1) continue;
          return true;
        }
      }
    }
    return false;
  }

  /**
   * The ground this cell still has, against **every** rim that crosses it.
   *
   * The chains of all the crossing footprints are pooled into one arrangement,
   * because at Erskineville 61.5% of the claimed cells are claimed by more than
   * one run and answering for one of them is answering the wrong question. See
   * `traceCell`.
   */
  conform(m: number, n: number, faults: string[]): SeamNode[][] | null {
    const chains: SeamNode[][] = [];
    const owner: number[] = [];
    for (const i of this.near(m, n)) {
      if (this.prints[i].state(m, n) !== CELL_CROSSED) continue;
      const got = this.prints[i].chainsIn(m, n, faults);
      if (got === null) return null;
      for (const c of got) {
        chains.push(c);
        owner.push(i);
      }
    }
    if (chains.length === 0) return null;
    return traceCell(m, n, this.pitch, chains, owner, faults);
  }
}

const EMPTY: readonly number[] = [];

// --- The self-check --------------------------------------------------------------------

/**
 * Everything this file claims, on synthetic footprints. Runs at boot and in CI.
 *
 * The failure modes here are all silent in the same way `vessel.ts`' are: a cell
 * traced the wrong way round is a triangle facing down, which is invisible from
 * above and looks like a hole; a cell classified inside when it is outside is a
 * missing patch of grass nobody walks on for a week. So the claims are asserted
 * by **area**, which is the one measure that cannot be satisfied by a plausible
 * wrong answer: the ground the terrain keeps plus the ground the ring encloses
 * must add up to the ground there was, cell by cell and in total.
 */
export function verifySeam(): string[] {
  const bad: string[] = [];
  const lattice: Lattice = { pitch: 3.90625 };

  /** A closed ring, as a plain polygon, at arbitrary height. */
  const ringOf = (xz: readonly number[]): { position: Float64Array; rim: Uint32Array } => {
    const position = new Float64Array((xz.length / 2) * 3);
    const rim = new Uint32Array(xz.length / 2);
    for (let i = 0; i < xz.length / 2; i++) {
      position[i * 3] = xz[i * 2];
      position[i * 3 + 1] = 10 + i * 0.01;
      position[i * 3 + 2] = xz[i * 2 + 1];
      rim[i] = i;
    }
    return { position, rim };
  };

  /** Twice the signed plan area of a traced loop. */
  const loopArea = (loop: SeamNode[]): number => {
    let a = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      a += p.x * q.z - q.x * p.z;
    }
    return a / 2;
  };

  const cases: Array<[string, number[]]> = [
    // A rectangle skewed off the lattice, so no edge lies on a line.
    ['a skew rectangle', [10.3, 20.7, 60.9, 22.1, 60.1, 34.6, 9.5, 33.2]],
    // A long thin corridor at an angle, which is the real shape.
    ['a thin diagonal corridor', [4.1, 4.9, 84.3, 60.2, 76.6, 71.1, -3.6, 15.8]],
    // A ring with two vertices sitting *exactly* on a lattice crossing, which
    // exercises the merge of a rim point with a cell corner -- the one place two
    // nodes can land on one point and the rim's must win, because the corner
    // carries the terrain's height and the rim carries the vessel's.
    ['a ring pinned to two lattice corners', [
      3.90625 * 4, 3.90625 * 6, 47.3, 25.1, 3.90625 * 13, 3.90625 * 10, 40.2, 51.9, 11.6, 44.4,
    ]],
    // And a ring whose edge passes through a lattice corner, so one segment
    // crosses two lines at the same parameter and the two crossings are one.
    ['a ring through a lattice corner', [
      0, 0, 41.7, -6.2, 3.90625 * 9, 3.90625 * 3, 3.90625 * 8, 3.90625 * 8,
    ]],
  ];

  for (const [name, xz] of cases) {
    const { position, rim } = ringOf(xz);
    const print = new Footprint(position, rim, lattice);
    // The polygon's own area, by the shoelace, against what the classification
    // says: inside cells whole, crossed cells by the part the ring keeps.
    let poly = 0;
    for (let i = 0; i < xz.length / 2; i++) {
      const j = (i + 1) % (xz.length / 2);
      poly += xz[i * 2] * xz[j * 2 + 1] - xz[j * 2] * xz[i * 2 + 1];
    }
    poly /= 2;
    if (!(poly > 0)) {
      bad.push(`${name}: the test ring is not counter-clockwise, so the check is meaningless`);
      continue;
    }
    const cell = lattice.pitch * lattice.pitch;
    let inside = 0;
    let kept = 0;
    let crossed = 0;
    const faults: string[] = [];
    for (let m = print.minM - 2; m <= print.maxM + 2; m++) {
      for (let n = print.minN - 2; n <= print.maxN + 2; n++) {
        const s = print.state(m, n);
        if (s === CELL_INSIDE) inside += cell;
        if (s !== CELL_CROSSED) continue;
        crossed++;
        const got = print.chainsIn(m, n, faults);
        const loops = got === null ? null : traceCell(m, n, lattice.pitch, got, got.map(() => 0), faults);
        if (loops === null) {
          bad.push(`${name}: cell ${m},${n} could not be conformed: ${faults[faults.length - 1] ?? '?'}`);
          continue;
        }
        for (const loop of loops) {
          const a = loopArea(loop);
          if (!(a > 0)) bad.push(`${name}: cell ${m},${n} traced a loop of area ${a.toFixed(4)}, so it is wound backwards`);
          kept += a;
        }
      }
    }
    if (crossed === 0) bad.push(`${name}: no cell is crossed, so nothing was conformed`);
    // The whole claim, as arithmetic: every crossed cell is exactly its kept
    // part plus its part of the polygon, so the two must close on the polygon's
    // own area. A tolerance is unavoidable *here* and only here -- it is a sum
    // of a few thousand floating-point areas, not a decision about identity --
    // and a millimetre squared over a 3,000 m2 footprint is four orders of
    // magnitude tighter than any wrong answer could be.
    const enclosed = crossed * cell - kept + inside;
    if (Math.abs(enclosed - poly) > 1e-6 * Math.max(1, Math.abs(poly))) {
      bad.push(
        `${name}: the cells enclose ${enclosed.toFixed(4)} m2 against the ring's own ` +
          `${poly.toFixed(4)} m2 -- ${(enclosed - poly).toFixed(6)} m2 of ground is owned twice or not at all`,
      );
    }
  }

  // --- The union, which is the case Phase 2a found in the field.
  //
  // Two parallel corridors overlapping laterally, which is what ordinary double
  // track *is*: at Erskineville 61.5% of the cells the railway claims are
  // claimed by more than one run. The claim asserted is the same area identity
  // as above, taken against the **union** of the two rather than against either,
  // and it is the assertion that fails if `SeamField` lets one footprint's kept
  // ground be drawn across the other's trench.
  {
    const p0 = [7.3, 5.9];
    const L = [61.7, 23.1];
    const W = [-9.4, 25.1];
    const k = 0.55;
    const quad = (shift: number): number[] => [
      p0[0] + W[0] * shift, p0[1] + W[1] * shift,
      p0[0] + L[0] + W[0] * shift, p0[1] + L[1] + W[1] * shift,
      p0[0] + L[0] + W[0] * (1 + shift), p0[1] + L[1] + W[1] * (1 + shift),
      p0[0] + W[0] * (1 + shift), p0[1] + W[1] * (1 + shift),
    ];
    const field = new SeamField(lattice);
    let minM = Infinity;
    let maxM = -Infinity;
    let minN = Infinity;
    let maxN = -Infinity;
    for (const shift of [0, k]) {
      const xz = quad(shift);
      let a = 0;
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        a += xz[i * 2] * xz[j * 2 + 1] - xz[j * 2] * xz[i * 2 + 1];
      }
      const wound = a > 0 ? xz : [xz[6], xz[7], xz[4], xz[5], xz[2], xz[3], xz[0], xz[1]];
      const { position, rim } = ringOf(wound);
      const print = new Footprint(position, rim, lattice);
      field.add(print);
      minM = Math.min(minM, print.minM);
      maxM = Math.max(maxM, print.maxM);
      minN = Math.min(minN, print.minN);
      maxN = Math.max(maxN, print.maxN);
    }
    // The union of two parallelograms sharing an edge direction and offset along
    // the other is one parallelogram, so its area is exact arithmetic and not a
    // clipping library.
    const unionArea = Math.abs(L[0] * W[1] - L[1] * W[0]) * (1 + k);
    const cell = lattice.pitch * lattice.pitch;
    let inside = 0;
    let kept = 0;
    let crossed = 0;
    let refused = 0;
    const faults: string[] = [];
    for (let m = minM - 2; m <= maxM + 2; m++) {
      for (let n = minN - 2; n <= maxN + 2; n++) {
        const st = field.state(m, n);
        if (st === CELL_INSIDE) inside += cell;
        if (st !== CELL_CROSSED) continue;
        crossed++;
        const loops = field.conform(m, n, faults);
        if (loops === null) {
          refused++;
          continue;
        }
        for (const loop of loops) {
          const a = loopArea(loop);
          if (!(a > 0)) bad.push(`the union: cell ${m},${n} traced a loop of area ${a.toFixed(4)}`);
          kept += a;
        }
      }
    }
    // A refused cell is **dropped**, so it counts as enclosed. That gives the
    // claim its exact two-sided form, and both sides say something:
    //
    //   - the terrain never draws ground *inside* the union. This is the side
    //     that matters, because ground drawn across a trench is a floor over a
    //     hole and looks exactly like the world working;
    //   - and it gives up no more than the refused cells, which are named,
    //     counted, and only ever where two rims properly cross inside one
    //     3.9 m cell -- the corners of the overlap here, and at a junction in
    //     the real network. That is the same class `STATIONS.md` enumerates and
    //     refuses, at cell scale.
    const enclosed = crossed * cell - kept + inside;
    if (enclosed < unionArea - 1e-6 * unionArea) {
      bad.push(
        `the union of two overlapping corridors keeps ground inside it: ${enclosed.toFixed(4)} m2 ` +
          `enclosed against the ${unionArea.toFixed(4)} m2 the two actually cover`,
      );
    }
    if (enclosed - unionArea > refused * cell + 1e-6 * unionArea) {
      bad.push(
        `the union gives up ${(enclosed - unionArea).toFixed(4)} m2 more than the ${refused} ` +
          `refused cell${refused === 1 ? '' : 's'} account for (${(refused * cell).toFixed(4)} m2)`,
      );
    }
    if (refused > 0 && !faults.some((f) => f.includes('the walk ran into ground') || f.includes('the same way'))) {
      bad.push(`the union refused ${refused} cells for a reason other than two rims crossing: ${faults[0]}`);
    }
  }

  // The crossings themselves: on the line, exactly, and in order.
  {
    const a = [1.5, -3.25, 41.75, 22.5];
    const found: Crossing[] = [];
    edgeCrossings(a[0], 7, a[1], a[2], 9, a[3], 3.90625, found);
    if (found.length === 0) bad.push('a segment across ten lattice cells produced no crossings');
    for (let i = 1; i < found.length; i++) {
      if (!(found[i].t > found[i - 1].t)) bad.push('the crossings of one segment are not in order along it');
    }
    for (const c of found) {
      const onX = c.x / 3.90625;
      const onZ = c.z / 3.90625;
      if (onX !== Math.round(onX) && onZ !== Math.round(onZ)) {
        bad.push(`a crossing at ${c.x}, ${c.z} is on neither lattice line, so it is an approximation of one`);
      }
    }
  }

  return bad;
}
