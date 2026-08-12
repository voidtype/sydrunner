/**
 * How high the railway is under your feet, asked of the sweep and not of a mesh.
 *
 * ---------------------------------------------------------------------------
 * THE QUESTION PHASE 1 LEFT, AND WHAT `STATIONS.md` DECIDED ABOUT IT.
 *
 * `CollisionWorld` indexes prisms and a vessel is not a prism set. The two
 * obvious answers were both refused, for stated reasons:
 *
 *   - **decompose the vessel into prisms** -- a third description of one
 *     boundary, kept in step by diligence, which is the failure the whole
 *     redesign exists to end;
 *   - **hand collision a triangle mesh and a BVH** -- honest, but it makes every
 *     ground query a ray cast against geometry where today it is arithmetic, and
 *     the ground query runs per player per tick on the server.
 *
 * The resolution recorded there is: **the sweep is the authority, the mesh is
 * one rendering of it, and the collision answer is an evaluation of it.** A
 * point query projects to the centreline, and the profile there says what is
 * under the point. `world/riding.PlatformField` is the precedent -- the drawn
 * prisms exist only in a browser and only near the player, so the arithmetic
 * version is the one the server can answer from -- and this generalises it.
 *
 * ---------------------------------------------------------------------------
 * **WHERE THAT PRESCRIPTION IS WRONG, MEASURED RATHER THAN ARGUED.**
 *
 * "Interpolate the profile at `s`, take the lateral offset, test that 2D
 * polygon" is a **bilinear** surface: linear along the run between two ribs, and
 * linear across between two profile points. The sweep does not draw a bilinear
 * surface. It draws two triangles per quad, and *a swept quad on a turning
 * centreline is not planar*: its four corners are two segments at different
 * heights on two rib lines that are neither parallel nor intersecting, which is
 * the definition of skew. Bilinear and planar agree on the four corners and
 * nowhere else in between.
 *
 * Measured over the Erskineville corridor -- see `checkVesselField` -- the two
 * answers differ by up to a **centimetre** in the middle of a quad on the
 * turning parts of the run. That is small, and it is exactly the size of thing
 * that gets a player stood a centimetre inside the floor, corrected upward, and
 * reported as jitter six months later. More to the point it is a *disagreement
 * between two descriptions of one surface*, which is the thing this design is
 * about, so the answer is not to tolerate it.
 *
 * So the correction: **the sweep's authority includes its triangulation rule.**
 * The definition is the ribs *and* how the faces between them are cut, and both
 * the drawn mesh and this evaluation read that one definition. Concretely this
 * file indexes `Vessel.index` off the centreline via `Vessel.sideFace` and
 * evaluates the plane of the face it finds.
 *
 * **That is not the triangle BVH the document refused, and the difference is not
 * a quibble.** A BVH is a second structure built by walking geometry, that
 * knows nothing about what the geometry means, and is descended by ray casting.
 * What is here is a lookup from a plan cell to *a rib segment of the sweep* --
 * the centreline index the document prescribes -- and then a walk of the eight
 * faces that rib segment emitted. It is O(1), it is arithmetic, it allocates
 * nothing per query, and there is exactly one array of triangles in the design,
 * which this points into rather than copying. Rebuilding the profile arithmetic
 * here instead would have been a *second implementation of the sweep's own zip*,
 * which is the duplication under a different name.
 *
 * ---------------------------------------------------------------------------
 * WHAT "THE SURFACE" MEANS ON A SHELL.
 *
 * A trench vessel's faces include its floor, its two coping strips, its two
 * battered walls, its two vertical outer faces, its buried underside and its two
 * end caps. Only some of those are ground:
 *
 *   - a face whose normal has **positive Y** is something you can stand on;
 *   - one with zero Y is a wall -- the outer faces and both end caps, which lie
 *     in a plane containing the Y axis;
 *   - one with negative Y is the underside, which is inside the earth.
 *
 * **That middle line used to end "and therefore have *exactly* zero", and Phase
 * 3a measured it and it is not true.** `n.y` is `uz*vx - ux*vz` over world
 * coordinates; at 30 km from the origin those products are ~1e9 with 1e-7
 * between representable doubles, so the cancellation is only sometimes exact.
 * Over the extract 98,051 of 172,766 vertical faces are non-zero and **49,280
 * are positive**, which the `ny > 0` below therefore calls standable. It is
 * unreachable rather than lucky: a face that near-vertical has at most 1.4e-10
 * m² of plan area, so the barycentric test below cannot be satisfied by any
 * point a body could occupy, and the height it would return is on the wall
 * between the floor and the rim. Asserted, with those numbers, in
 * `checkVesselSeam` section 10h.
 *
 * So the answer at a point is the **highest upward-facing face over it**, and on
 * a trench that is unambiguous: the coping, the batter and the floor tile the
 * footprint in plan without overlapping. A bore has a lid as well as a floor and
 * will need the same banding `PlatformField.heightAt` uses; there is no bore in
 * Phase 2a and the band is not written speculatively.
 *
 * ---------------------------------------------------------------------------
 * **This file imports one type and no code**, for `vessel.ts`' reason: the
 * server answers ground queries from it, and a client and a server that disagree
 * about the floor is a player who falls through on one end only.
 */

import type { Rib, Vessel } from './vessel.ts';

/** One swept run: the sweep, and the ribs that define it. */
export interface FieldRun {
  vessel: Vessel;
  ribs: readonly Rib[];
}

/**
 * How coarse the plan index is, metres.
 *
 * `world/rail-cut.ts`' own 64 m, and for the same reason: a corridor is ten
 * metres wide and a rib segment is eight metres long, so at this pitch a cell
 * holds a handful of rib segments and a query looks at one cell. Sharing the
 * constant with the module next door is deliberate -- two indexes over the same
 * railway at two pitches is two things to reason about for no gain.
 */
export const FIELD_CELL_M = 64;

function cellKey(cx: number, cz: number): number {
  return (cx & 0xfffff) * 0x100000 + (cz & 0xfffff);
}

/**
 * Every corridor vessel in play, as the one question a body asks of it.
 *
 * Built once from the swept runs and then read per player per tick. Holds
 * references to the vessels' own arrays and copies nothing.
 */
export class VesselField {
  private readonly runs: FieldRun[] = [];
  /** Cell -> pairs of `(run, rib segment)`, interleaved. */
  private readonly cells = new Map<number, number[]>();

  add(run: FieldRun): void {
    const at = this.runs.length;
    this.runs.push(run);
    const { vessel } = run;
    const p = vessel.position;
    for (let i = 0; i < vessel.ribCount - 1; i++) {
      // The plan box of the two ribs' outer loops, which is the box of every
      // face this rib segment emitted -- rim cuts included, because a cut lies
      // on the segment between two of these very vertices.
      let x0 = Infinity;
      let x1 = -Infinity;
      let z0 = Infinity;
      let z1 = -Infinity;
      for (let j = vessel.ribOffset[i]; j < vessel.ribOffset[i + 2]; j++) {
        const v = j * 3;
        if (p[v] < x0) x0 = p[v];
        if (p[v] > x1) x1 = p[v];
        if (p[v + 2] < z0) z0 = p[v + 2];
        if (p[v + 2] > z1) z1 = p[v + 2];
      }
      for (let cx = Math.floor(x0 / FIELD_CELL_M); cx <= Math.floor(x1 / FIELD_CELL_M); cx++) {
        for (let cz = Math.floor(z0 / FIELD_CELL_M); cz <= Math.floor(z1 / FIELD_CELL_M); cz++) {
          const key = cellKey(cx, cz);
          const list = this.cells.get(key);
          if (list) list.push(at, i);
          else this.cells.set(key, [at, i]);
        }
      }
    }
  }

  get count(): number {
    return this.runs.length;
  }

  /** How many rib segments the index holds, and how many cells it spans. */
  get size(): { segments: number; cells: number } {
    let segments = 0;
    for (const r of this.runs) segments += Math.max(0, r.vessel.ribCount - 1);
    return { segments, cells: this.cells.size };
  }

  /**
   * The highest surface of the railway over a point, or `-Infinity` for a point
   * the corridor does not cover.
   *
   * `-Infinity` is a statement about the footprint and not about the ground:
   * outside the rim ring this vessel has nothing to say and the terrain -- which
   * is still drawn out there, conformed to that very rim -- answers instead.
   */
  surfaceAt(x: number, z: number): number {
    const list = this.cells.get(cellKey(Math.floor(x / FIELD_CELL_M), Math.floor(z / FIELD_CELL_M)));
    if (list === undefined) return -Infinity;
    let best = -Infinity;
    for (let e = 0; e < list.length; e += 2) {
      const run = this.runs[list[e]];
      const i = list[e + 1];
      const y = faceHeight(run.vessel, run.vessel.sideFace[i], run.vessel.sideFace[i + 1], x, z);
      if (y > best) best = y;
    }
    return best;
  }

  /**
   * The same answer, in the shape the two ground queries want.
   *
   * `feetY` is accepted and ignored, and that is worth a sentence because
   * `PlatformField.heightAt` next door bands on it hard. A platform can sit
   * eleven metres under the terrain grid, so an answer there has to mean "you
   * are standing on this" rather than "there is one somewhere below you". A
   * corridor vessel is different in kind: inside its rim ring **the terrain does
   * not exist** -- `world/seam.ts` withheld it and the mesh proves the vessel
   * covers exactly that footprint -- so there is nothing for the answer to
   * compete with and nothing for a band to disambiguate. The argument is kept in
   * the signature so the two ground queries call this the way they call every
   * other field, and so a lid disposition can start banding without changing
   * either caller.
   */
  heightAt(x: number, z: number, _feetY: number): number {
    return this.surfaceAt(x, z);
  }
}

/**
 * The highest upward-facing face of one rib segment over a point.
 *
 * Deliberately a free function over the vessel's own arrays: there is no
 * geometry here that the sweep did not already emit, and the only thing being
 * decided is *which* of the faces it emitted is the one under your feet.
 */
function faceHeight(vessel: Vessel, from: number, to: number, x: number, z: number): number {
  const p = vessel.position;
  const ix = vessel.index;
  let best = -Infinity;
  for (let f = from; f < to; f++) {
    const a = ix[f * 3] * 3;
    const b = ix[f * 3 + 1] * 3;
    const c = ix[f * 3 + 2] * 3;
    const ax = p[a];
    const az = p[a + 2];
    const ux = p[b] - ax;
    const uz = p[b + 2] - az;
    const vx = p[c] - ax;
    const vz = p[c + 2] - az;
    // The Y of `(b - a) x (c - a)`. Positive is a face you can stand on; zero is
    // a wall and is exactly zero on the vertical faces, so no threshold decides
    // it. This doubles as the plan orientation: an upward face is clockwise in
    // `(x, z)`, because `twice = -n.y`.
    const ny = uz * vx - ux * vz;
    if (!(ny > 0)) continue;
    // Barycentric in plan, against the same three vertices the face is drawn
    // from. `twice` is non-zero because `ny` is.
    const twice = ux * vz - uz * vx;
    const px = x - ax;
    const pz = z - az;
    const l2 = (px * vz - pz * vx) / twice;
    if (l2 < 0) continue;
    const l3 = (pz * ux - px * uz) / twice;
    if (l3 < 0) continue;
    const l1 = 1 - l2 - l3;
    if (l1 < 0) continue;
    const y = l1 * p[a + 1] + l2 * p[b + 1] + l3 * p[c + 1];
    if (y > best) best = y;
  }
  return best;
}

/**
 * The same query written the way `STATIONS.md` prescribed it: interpolate the
 * profile along the run and across it, and read the height off that.
 *
 * **Kept only to be disagreed with.** It is the bilinear surface the sweep's
 * corners lie on, and the sweep does not draw it -- see the header. The check
 * measures the gap between this and `VesselField.surfaceAt` over a real
 * corridor, which is the evidence for the correction rather than an assertion
 * that one is right. Nothing in the game calls it.
 */
export function profileHeight(run: FieldRun, x: number, z: number): number {
  const { ribs } = run;
  let best = -Infinity;
  for (let i = 0; i < ribs.length - 1; i++) {
    const a = ribs[i];
    const b = ribs[i + 1];
    // Where between the two ribs, by projection onto the chord. A rib's own
    // plane is not perpendicular to the chord on a bend, which is one more way
    // this is an approximation of the sweep rather than the sweep.
    const ex = b.cx - a.cx;
    const ez = b.cz - a.cz;
    const len2 = ex * ex + ez * ez;
    if (!(len2 > 0)) continue;
    const t = ((x - a.cx) * ex + (z - a.cz) * ez) / len2;
    if (t < 0 || t > 1) continue;
    const cx = a.cx + ex * t;
    const cz = a.cz + ez * t;
    const ux = a.ux + (b.ux - a.ux) * t;
    const uz = a.uz + (b.uz - a.uz) * t;
    const ul = Math.hypot(ux, uz);
    if (!(ul > 0)) continue;
    const o = ((x - cx) * -(uz / ul) + (z - cz) * (ux / ul));
    const la = a.loops[0];
    const lb = b.loops[0];
    const m = la.length / 2;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const o0 = la[j * 2] + (lb[j * 2] - la[j * 2]) * t;
      const o1 = la[j2 * 2] + (lb[j2 * 2] - la[j2 * 2]) * t;
      // Upward-facing means the profile runs from higher offset to lower, since
      // the loop is counter-clockwise in `(o, y)`.
      if (!(o1 < o0)) continue;
      if (o < o1 || o > o0) continue;
      const y0 = la[j * 2 + 1] + (lb[j * 2 + 1] - la[j * 2 + 1]) * t;
      const y1 = la[j2 * 2 + 1] + (lb[j2 * 2 + 1] - la[j2 * 2 + 1]) * t;
      const f = o0 === o1 ? 0 : (o0 - o) / (o0 - o1);
      const y = y0 + (y1 - y0) * f;
      if (y > best) best = y;
    }
  }
  return best;
}

/**
 * The mesh's own answer, found by brute force over every face of the vessel.
 *
 * The oracle for the index. `VesselField.surfaceAt` reaches one cell of a plan
 * index and looks at eight faces; this looks at all of them, in the same
 * arithmetic, so what the comparison proves is precisely what could be wrong
 * with the fast path -- the wrong cell, a missed rib segment, a face outside the
 * range `sideFace` claims, or the wrong one chosen where two overlap. The
 * arithmetic being shared is the point and not a weakness: it is one definition,
 * asked twice.
 */
export function meshHeight(vessel: Vessel, x: number, z: number): number {
  return faceHeight(vessel, 0, vessel.index.length / 3, x, z);
}
