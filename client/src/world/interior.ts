/**
 * The inside of a building, generated from the building.
 *
 * `world/doorway.ts` answers *which building is this and where is its door*, and
 * `world/floorplan.ts` answers *what rooms are behind it*. This file is what
 * turns that plan into a place: walls with doorways in them, a floor, a shell
 * you cannot walk out of, and a `MoveResolver` both ends run so that the browser
 * predicting your steps and the server adjudicating them agree about which side
 * of a partition you are on.
 *
 * It imports nothing but the plan, because `server/sim.ts` builds one of these
 * per occupied building and `server/` may not see three.
 *
 * ## An interior is a world, at the building's own coordinates
 *
 * The owner's decision was a separate instance per building, WoW-style, rather
 * than a hollowed-out solid in the street -- see INTERIORS.md. What that leaves
 * open is *where* the instance is, and the answer here is: exactly where the
 * building is. The rooms are laid out on the real footprint, the floor is at the
 * real pad height, and the door is the real door.
 *
 * That is worth arguing for, because the obvious alternative -- a dedicated
 * region far outside the city, the way most engines do instances -- is worse on
 * every count that matters here:
 *
 *   - **Nothing has to be teleported anywhere.** Entering moves you a metre;
 *     leaving moves you back. There is no arrival corridor, no "returning you to
 *     the world" screen, and no way to lose somebody's outside position.
 *   - **The city's own collision is simply not consulted.** A participant in an
 *     interior is stepped against `Interior.resolver` and nothing else
 *     (`CombatWorld.mover`, which is exactly what a train carriage already
 *     does), so the building's own prism -- the solid you are standing inside --
 *     never pushes back. There is no facade to open and no manifold to carve,
 *     which was the owner's objection to the earlier design and is now not a
 *     question anyone has to answer.
 *   - **Positions separate themselves.** Two interiors are two different
 *     footprints and buildings do not overlap, so no two spaces ever occupy the
 *     same metres. `server/aoi.ts` still asks about the space before it measures
 *     a distance, and that is not belt-and-braces: somebody standing on the
 *     pavement is a metre from somebody standing inside, and without the filter
 *     they would draw each other through the wall.
 *
 * ## The door is not part of the interior
 *
 * One building, one inside, for everybody -- so the rooms are cached per space
 * and the *door* is not among them. Two players can walk into the same corner
 * pub from George Street and from the lane behind it, and each has to arrive
 * just inside the door they used and leave by it again ("you leave by the one
 * you came in", INTERIORS.md). So `buildInterior` takes no door and `arrivalAt`
 * is a separate question asked per entrant, which is also what stops the first
 * person through the door deciding where everybody else comes in.
 *
 * ## The ground floor, and what is not built yet
 *
 * One storey is walkable: the one you come in at. `floorPlan` generates every
 * storey of a 214 m tower and this file uses the ground one, because the storey
 * above needs a stair, a ramp in `groundHeight`, and walls selected by the
 * body's own height -- all of which this design admits (the resolver is handed
 * `feetY` already) and none of which is written. Said plainly here rather than
 * left for somebody to discover from a locked lobby.
 *
 * ## Why the walls are merged intervals rather than per-room rectangles
 *
 * The naive emit -- four edges per room -- draws every partition twice, from
 * both sides, and at a T-junction draws one wall in three overlapping pieces.
 * Duplicated collision is merely wasteful; duplicated *geometry* is coplanar
 * z-fighting, which is the one artefact a player reads as the game being
 * broken. So every edge in the plan is filed by the line it lies on, the
 * intervals on each line are unioned, and the doorways are subtracted from the
 * union. One wall per stretch, one doorway per opening, from either side.
 */

import { floorPlan, type FloorPlan, type Room } from './floorplan.ts';

/** Wall thickness, metres. Also how far the walkable shell is inset from the footprint. */
export const WALL_THICK_M = 0.16;

/**
 * A doorway's clear width, metres.
 *
 * 1.4 rather than a real 0.82 m door leaf. A player is a 0.35 m radius capsule
 * driven at 5 m/s by somebody who is looking somewhere else, and a doorway they
 * have to aim at is a doorway they bounce off. The same argument
 * `riding.GANGWAY_HALF_WIDTH_M` makes about a carriage ring.
 */
export const DOOR_GAP_M = 1.4;

/**
 * The narrowest contact between two rooms that can still become a doorway.
 *
 * Below this there is no opening a body fits through, so the two rooms are
 * simply not connected -- and `buildInterior` then drops whichever of them the
 * spawn cannot reach, rather than shipping a room with no way in.
 */
const MIN_CONTACT_M = 1.0;

/** Headroom, floor to ceiling slab. Under `floorplan.STOREY_M` by the slab's own depth. */
export const CEILING_M = 2.7;

/**
 * The narrowest building with an inside worth having, metres across.
 *
 * A body is 0.7 m wide and the walls take 0.32 of the span, so anything under
 * this is a corridor you cannot turn around in. Sydney has plenty of them --
 * light wells, lift overruns, the 0.8 m slivers between terraces that OSM
 * records as buildings -- and offering a door onto one is worse than offering
 * no door at all.
 */
export const INTERIOR_MIN_SPAN_M = 3.2;

/** The tallest thing with no storey in it. Mirrors `doorway.MIN_BUILDING_H`. */
const MIN_BUILDING_H = 2.4;

/**
 * The radius the arrival is cleared with, metres.
 *
 * Wider than `controller.PLAYER_RADIUS` (0.35) on purpose, and not imported
 * from it: this is not a collision radius, it is how much elbow room a body
 * gets on arrival so that the first tick's resolve has nothing to do. A spawn
 * that is merely *legal* is a spawn that shudders.
 */
const BODY_CLEARANCE_M = 0.5;

/** A wall's centre line, in world metres. Thickness is `WALL_THICK_M`, height is a storey. */
export interface InteriorWall {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** Half-plane of the walkable shell: inside is `nx * x + nz * z >= d`. */
export interface ShellPlane {
  nx: number;
  nz: number;
  d: number;
}

export interface Interior {
  /** `doorway.buildingSeed`. The building's name, and the plan's seed. */
  seed: number;
  /** Floor of the walkable storey, world metres. */
  base: number;
  /** Where the ceiling slab starts. */
  ceilingY: number;
  /** The whole plan, every storey, as generated. Only `rooms` below is walkable. */
  plan: FloorPlan;
  /** The ground-floor rooms the spawn can actually reach. */
  rooms: readonly Room[];
  /** Partitions between those rooms, doorways already subtracted. */
  walls: readonly InteriorWall[];
  /** The walkable shell: the footprint inset by a wall. Convex, world x,z pairs. */
  shell: Float32Array;
  /** The same shell as half-planes, which is what the resolver actually reads. */
  planes: readonly ShellPlane[];
  /** The footprint's centre. `arrivalAt` walks toward it; the view looks at it. */
  centreX: number;
  centreZ: number;
  /** What `CombatWorld.mover` is set to while a body is in here. */
  resolver: InteriorResolver;
}

/**
 * Is there an inside worth generating for this building?
 *
 * Both ends call it and they must agree: the browser gates the `E` prompt on it
 * and `server/sim.ts` gates the entry, so a building that fails this offers no
 * door rather than a door that does nothing -- which is the failure a player
 * reports as "it's broken" rather than as "you can't go in there".
 */
export function interiorAdmits(points: Float32Array, height: number): boolean {
  if (!Number.isFinite(height) || height < MIN_BUILDING_H) return false;
  const n = points.length >> 1;
  if (n < 3) return false;
  // The oriented box's short side, which is the honest measure of "can you turn
  // around in here" for a shape that is not a rectangle either.
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const z = points[i * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  // A cheap bound first: a footprint whose *axis-aligned* box is already too
  // small cannot have a wider oriented one.
  if (Math.min(maxX - minX, maxZ - minZ) < INTERIOR_MIN_SPAN_M) return false;
  // And the real test, over the polygon's own edges. `floorplan.orientedBox`
  // does the same walk; it is repeated rather than imported-and-called because
  // this runs on every frame a player is near a wall and the box allocates.
  let bestShort = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let dx = points[j * 2] - points[i * 2];
    let dz = points[j * 2 + 1] - points[i * 2 + 1];
    const len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 1e-6)) continue;
    dx /= len;
    dz /= len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let k = 0; k < n; k++) {
      const u = points[k * 2] * dx + points[k * 2 + 1] * dz;
      const v = -points[k * 2] * dz + points[k * 2 + 1] * dx;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const short = Math.min(maxU - minU, maxV - minV);
    if (short < bestShort) bestShort = short;
  }
  return bestShort >= INTERIOR_MIN_SPAN_M;
}

// --- The shell -----------------------------------------------------------------

/**
 * The footprint as inward half-planes, inset by a wall.
 *
 * Half-planes rather than a polygon because that is what both consumers want:
 * the resolver pushes a body back along a violated plane's normal, and the wall
 * clipper below is a Liang-Barsky over the same list. The polygon is recovered
 * from them once, for drawing.
 *
 * **The prisms are convex hulls** (see INTERIORS.md), so this is exact. Handed a
 * concave polygon it would produce the convex core instead, which is a smaller
 * room rather than a wrong one -- the safe direction, and worth stating because
 * nothing here checks.
 */
function shellPlanes(points: Float32Array, inset: number): ShellPlane[] {
  const n = points.length >> 1;
  const planes: ShellPlane[] = [];
  if (n < 3) return planes;
  // Winding, so the normals point in rather than out.
  let area2 = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    area2 += points[j * 2] * points[i * 2 + 1] - points[i * 2] * points[j * 2 + 1];
  }
  const ccw = area2 > 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const ax = points[j * 2];
    const az = points[j * 2 + 1];
    const bx = points[i * 2];
    const bz = points[i * 2 + 1];
    let dx = bx - ax;
    let dz = bz - az;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (!(len > 1e-6)) continue;
    dx /= len;
    dz /= len;
    const nx = ccw ? -dz : dz;
    const nz = ccw ? dx : -dx;
    planes.push({ nx, nz, d: nx * ax + nz * az + inset });
  }
  return planes;
}

/** The polygon those half-planes bound, for drawing. Consecutive lines, intersected. */
function shellPolygon(planes: readonly ShellPlane[]): Float32Array {
  const n = planes.length;
  if (n < 3) return new Float32Array(0);
  const out: number[] = [];
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = planes[j];
    const b = planes[i];
    const det = a.nx * b.nz - b.nx * a.nz;
    if (Math.abs(det) < 1e-9) continue;
    out.push((a.d * b.nz - b.d * a.nz) / det, (a.nx * b.d - b.nx * a.d) / det);
  }
  return new Float32Array(out);
}

// --- Walls ---------------------------------------------------------------------

/** One stretch on one line of the plan's own grid, in the building's frame. */
interface Span {
  /** 0: the line runs along v at a constant u. 1: along u at a constant v. */
  axis: 0 | 1;
  coord: number;
  lo: number;
  hi: number;
}

/** Merge overlapping and touching intervals. In place, sorted. */
function unionSpans(spans: Span[]): Span[] {
  spans.sort((p, q) => (p.axis - q.axis) || (p.coord - q.coord) || (p.lo - q.lo));
  const out: Span[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (
      last !== undefined && last.axis === s.axis &&
      Math.abs(last.coord - s.coord) < 1e-3 && s.lo <= last.hi + 1e-3
    ) {
      if (s.hi > last.hi) last.hi = s.hi;
      continue;
    }
    out.push({ axis: s.axis, coord: s.coord, lo: s.lo, hi: s.hi });
  }
  return out;
}

/** Where two rooms touch, in the building's own frame. */
interface Contact {
  a: number;
  b: number;
  axis: 0 | 1;
  coord: number;
  lo: number;
  hi: number;
}

function contactsBetween(rooms: readonly Room[]): Contact[] {
  const out: Contact[] = [];
  const EPS = 0.02;
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i];
      const b = rooms[j];
      // A shared line at a constant u: one room's east face against the other's
      // west, either way round.
      const touchU =
        Math.abs(a.u + a.ex - (b.u - b.ex)) < EPS ? a.u + a.ex :
        Math.abs(b.u + b.ex - (a.u - a.ex)) < EPS ? b.u + b.ex : NaN;
      if (Number.isFinite(touchU)) {
        const lo = Math.max(a.v - a.ez, b.v - b.ez);
        const hi = Math.min(a.v + a.ez, b.v + b.ez);
        if (hi - lo >= MIN_CONTACT_M) out.push({ a: i, b: j, axis: 0, coord: touchU, lo, hi });
        continue;
      }
      const touchV =
        Math.abs(a.v + a.ez - (b.v - b.ez)) < EPS ? a.v + a.ez :
        Math.abs(b.v + b.ez - (a.v - a.ez)) < EPS ? b.v + b.ez : NaN;
      if (Number.isFinite(touchV)) {
        const lo = Math.max(a.u - a.ex, b.u - b.ex);
        const hi = Math.min(a.u + a.ex, b.u + b.ex);
        if (hi - lo >= MIN_CONTACT_M) out.push({ a: i, b: j, axis: 1, coord: touchV, lo, hi });
      }
    }
  }
  return out;
}

/** Clip a world-space segment to the shell. Returns false if none of it is inside. */
function clipToShell(
  planes: readonly ShellPlane[],
  ax: number, az: number, bx: number, bz: number,
  out: { ax: number; az: number; bx: number; bz: number },
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dz = bz - az;
  for (const p of planes) {
    // Inside is `n . x >= d`. Along the segment that is `f(t) = n.(a + t d) - d`.
    const f0 = p.nx * ax + p.nz * az - p.d;
    const denom = p.nx * dx + p.nz * dz;
    if (Math.abs(denom) < 1e-9) {
      if (f0 < 0) return false;
      continue;
    }
    const t = -f0 / denom;
    if (denom > 0) {
      if (t > t0) t0 = t;
    } else if (t < t1) {
      t1 = t;
    }
    if (t0 > t1) return false;
  }
  out.ax = ax + dx * t0;
  out.az = az + dz * t0;
  out.bx = ax + dx * t1;
  out.bz = az + dz * t1;
  return true;
}

// --- Moving about --------------------------------------------------------------

/**
 * The one thing a body inside a building is stepped against.
 *
 * `CollisionWorld.resolve`'s shape exactly, because it is handed to
 * `CombatWorld.mover` and `game/combat.moverOf` returns one or the other. A
 * carriage already does this (`game/riding.carriageResolve`); this is the second
 * caller of a contract written for the first.
 *
 * **No vertical collision**, on the carriage's argument: there is no ceiling
 * anywhere in here, so a header that pushed back would be the only one and would
 * shove a jumping body sideways. `feetY` and `headY` are taken and ignored,
 * which is where a second walkable storey will read them.
 */
export class InteriorResolver {
  constructor(
    private readonly planes: readonly ShellPlane[],
    private readonly walls: readonly InteriorWall[],
  ) {}

  /**
   * How much room a body of zero radius has at this point, metres.
   *
   * Negative inside a wall or outside the shell. Separate from `resolve`
   * because a *push* and a *measurement* are different questions and only one
   * of them can be trusted to answer the other: `resolve` runs a fixed three
   * passes, and in the corner of a forty-sided outline the pushes can cycle to
   * a fixed point that is still inside something. `arrivalAt` asks this instead
   * of asking `resolve` twice and comparing, which is the version that shipped
   * for an hour and quietly let one door in forty land in a wall.
   */
  clearance(x: number, z: number): number {
    let least = Infinity;
    for (const p of this.planes) {
      const s = p.nx * x + p.nz * z - p.d;
      if (s < least) least = s;
    }
    for (const w of this.walls) {
      const dx = w.bx - w.ax;
      const dz = w.bz - w.az;
      const len2 = dx * dx + dz * dz;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / len2)) : 0;
      const ex = x - (w.ax + dx * t);
      const ez = z - (w.az + dz * t);
      const s = Math.sqrt(ex * ex + ez * ez) - WALL_THICK_M / 2;
      if (s < least) least = s;
    }
    return least;
  }

  resolve(
    fromX: number,
    fromZ: number,
    toX: number,
    toZ: number,
    radius: number,
    _feetY: number,
    _headY?: number,
  ): { x: number; z: number; hit: boolean } {
    let x = toX;
    let z = toZ;
    let hit = false;
    const half = WALL_THICK_M / 2;
    // Three passes, because a body wedged into a corner is pushed out of one
    // surface into another and one pass leaves it inside the second. Three is
    // what `CollisionWorld.resolve` settled on for the same reason.
    for (let pass = 0; pass < 3; pass++) {
      let moved = false;
      for (const p of this.planes) {
        const s = p.nx * x + p.nz * z - p.d;
        if (s < radius) {
          const push = radius - s;
          x += p.nx * push;
          z += p.nz * push;
          moved = true;
        }
      }
      for (const w of this.walls) {
        const dx = w.bx - w.ax;
        const dz = w.bz - w.az;
        const len2 = dx * dx + dz * dz;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - w.ax) * dx + (z - w.az) * dz) / len2)) : 0;
        const cx = w.ax + dx * t;
        const cz = w.az + dz * t;
        let ex = x - cx;
        let ez = z - cz;
        const want = radius + half;
        const d2 = ex * ex + ez * ez;
        if (d2 >= want * want) continue;
        let d = Math.sqrt(d2);
        if (d < 1e-6) {
          // Dead on the centre line. Push along the wall's own normal, on the
          // side the body came from -- which is the only information left about
          // which way "out" is, and using it is what stops a body that clips a
          // jamb being ejected through the wall it was walking beside.
          const len = Math.sqrt(len2) || 1;
          ex = -dz / len;
          ez = dx / len;
          if ((fromX - cx) * ex + (fromZ - cz) * ez < 0) {
            ex = -ex;
            ez = -ez;
          }
          d = 1;
        } else {
          ex /= d;
          ez /= d;
        }
        const push = want - d;
        x += ex * push;
        z += ez * push;
        moved = true;
      }
      if (!moved) break;
      hit = true;
    }
    return { x, z, hit };
  }
}

// --- The generator -------------------------------------------------------------

/**
 * Build the inside of one building.
 *
 * Null when the building has no inside worth having (`interiorAdmits`) or when
 * the plan degenerates to nothing a body fits in. Both ends call this with the
 * same four arguments off the same prism and must get the same rooms, which is
 * the whole reason nothing in here reads a clock, a random, or a `Math.sin`.
 *
 * No door: see the header. `arrivalAt` below is where one is used, once per
 * person who walks in.
 */
export function buildInterior(
  points: Float32Array,
  base: number,
  height: number,
  seed: number,
): Interior | null {
  if (!interiorAdmits(points, height)) return null;
  if (!Number.isFinite(base)) return null;

  const planes = shellPlanes(points, WALL_THICK_M);
  if (planes.length < 3) return null;
  const shell = shellPolygon(planes);
  if (shell.length < 6) return null;

  const plan = floorPlan(points, height, seed);
  const box = plan.box;
  // The ground floor, and only the part of it inside the shell.
  //
  // Two culls rather than one, because they answer different questions.
  // `floorPlan` already dropped the cells whose centres fall outside the
  // *polygon*, which is what makes an L-shape work. This drops the ones outside
  // the **walkable shell** -- the intersection of the outline's half-planes,
  // which for a convex hull is the outline inset by a wall and for anything
  // else is its convex core. Without it a concave footprint keeps rooms whose
  // walls are then clipped away to nothing, and the plan describes partitions
  // that do not exist.
  const ground = plan.rooms.filter((r) => {
    if (r.storey !== 0) return false;
    for (const pl of planes) {
      if (pl.nx * r.x + pl.nz * r.z - pl.d < 0.05) return false;
    }
    return true;
  });

  // --- Which rooms connect to which, and where the openings go.
  const contacts = contactsBetween(ground);
  const doorways: Span[] = [];
  for (const c of contacts) {
    // **Every contact becomes a doorway**, which is what makes connectivity a
    // property of the generator rather than something to check for afterwards:
    // two rooms that share a metre of wall share a way through it, so the room
    // graph *is* the contact graph and no part of a house can be sealed off.
    // `MIN_CONTACT_M` and the jamb below are sized so that this is always an
    // opening a body fits through -- see `contactsBetween`.
    const width = Math.min(DOOR_GAP_M, c.hi - c.lo - 0.1);
    const mid = (c.lo + c.hi) / 2;
    doorways.push({ axis: c.axis, coord: c.coord, lo: mid - width / 2, hi: mid + width / 2 });
  }

  // Every ground-floor room is kept. Nothing is dropped for being unreachable,
  // because nothing can be: every contact above opened a doorway, so the room
  // graph is the contact graph and it is connected wherever the subdivision was.
  const rooms = ground;

  // --- The walls: every edge of every room, unioned per line, with the
  // doorways cut out of the union.
  const edges: Span[] = [];
  for (const r of rooms) {
    edges.push({ axis: 0, coord: r.u - r.ex, lo: r.v - r.ez, hi: r.v + r.ez });
    edges.push({ axis: 0, coord: r.u + r.ex, lo: r.v - r.ez, hi: r.v + r.ez });
    edges.push({ axis: 1, coord: r.v - r.ez, lo: r.u - r.ex, hi: r.u + r.ex });
    edges.push({ axis: 1, coord: r.v + r.ez, lo: r.u - r.ex, hi: r.u + r.ex });
  }
  const merged = unionSpans(edges);

  const pieces: Span[] = [];
  for (const span of merged) {
    let parts: Array<{ lo: number; hi: number }> = [{ lo: span.lo, hi: span.hi }];
    for (const gap of doorways) {
      if (gap.axis !== span.axis || Math.abs(gap.coord - span.coord) > 1e-3) continue;
      const next: Array<{ lo: number; hi: number }> = [];
      for (const part of parts) {
        if (gap.hi <= part.lo || gap.lo >= part.hi) {
          next.push(part);
          continue;
        }
        if (gap.lo > part.lo) next.push({ lo: part.lo, hi: gap.lo });
        if (gap.hi < part.hi) next.push({ lo: gap.hi, hi: part.hi });
      }
      parts = next;
    }
    for (const part of parts) {
      if (part.hi - part.lo < 0.05) continue;
      pieces.push({ axis: span.axis, coord: span.coord, lo: part.lo, hi: part.hi });
    }
  }

  const walls: InteriorWall[] = [];
  const clipped = { ax: 0, az: 0, bx: 0, bz: 0 };
  for (const piece of pieces) {
    const au = piece.axis === 0 ? piece.coord : piece.lo;
    const av = piece.axis === 0 ? piece.lo : piece.coord;
    const bu = piece.axis === 0 ? piece.coord : piece.hi;
    const bv = piece.axis === 0 ? piece.hi : piece.coord;
    const ax = au * box.ux - av * box.uz;
    const az = au * box.uz + av * box.ux;
    const bx = bu * box.ux - bv * box.uz;
    const bz = bu * box.uz + bv * box.ux;
    // Clipped to the shell, because the plan is laid out on a box that
    // circumscribes the footprint: an outer room's edge runs past the wall and
    // would be drawn hanging over the street.
    if (!clipToShell(planes, ax, az, bx, bz, clipped)) continue;
    const dx = clipped.bx - clipped.ax;
    const dz = clipped.bz - clipped.az;
    if (dx * dx + dz * dz < 0.05 * 0.05) continue;
    walls.push({ ax: clipped.ax, az: clipped.az, bx: clipped.bx, bz: clipped.bz });
  }

  // The footprint's centre, for `arrivalAt` to walk toward and for a camera to
  // look at. The vertex mean rather than the area centroid: the outlines are
  // hulls with no long thin tails, the two agree to within a fraction of a
  // metre on every one of them, and this cannot divide by a zero area.
  let centreX = 0;
  let centreZ = 0;
  for (let i = 0; i < points.length; i += 2) {
    centreX += points[i];
    centreZ += points[i + 1];
  }
  centreX /= points.length / 2;
  centreZ /= points.length / 2;

  return {
    seed,
    base,
    ceilingY: base + CEILING_M,
    plan,
    rooms,
    walls,
    shell,
    planes,
    centreX,
    centreZ,
    resolver: new InteriorResolver(planes, walls),
  };
}

/**
 * Where a body arrives when it comes in by this door.
 *
 * Asked once per entrant rather than baked into the interior, because the
 * interior is shared and the door is not: two people walk into the same pub
 * from two streets and each arrives inside their own doorway.
 *
 * A metre in from the wall they knocked on, then **settled by the interior's
 * own resolver** with a radius wider than a player's. That second step is not
 * belt-and-braces: the plan's outermost partition runs parallel to the outer
 * wall by construction, so a point a metre inside the front door lands in a
 * party wall often, and a body that starts inside a wall is a body the first
 * tick shoves through it. Settling with 0.5 m rather than 0.35 means the
 * arrival is *clear* rather than merely legal, so it does not shudder.
 *
 * If a metre in is somehow still outside the shell -- a door on the short side
 * of something barely wide enough -- the point is walked toward the footprint's
 * centre until it is inside, rather than refused. A door that opens onto a
 * refusal is worse than a door that opens a foot further in than it should.
 */
export function arrivalAt(
  it: Interior,
  doorX: number,
  doorZ: number,
  doorNX: number,
  doorNZ: number,
): { x: number; z: number } {
  let x = doorX - doorNX * 1.0;
  let z = doorZ - doorNZ * 1.0;
  // Settle, test, and walk further in if it did not take. The resolver runs a
  // fixed three passes, which is enough for a body against a wall and not
  // always enough for one wedged into the corner of a forty-sided outline where
  // pushing out of one plane pushes into the next -- so the convergence is
  // here, in the one place that can afford to iterate, rather than in the
  // resolver, which runs sixty times a second per body.
  for (let tries = 0; tries < 20; tries++) {
    const settled = it.resolver.resolve(x, z, x, z, BODY_CLEARANCE_M, it.base);
    x = settled.x;
    z = settled.z;
    if (it.resolver.clearance(x, z) >= BODY_CLEARANCE_M) break;
    x += (it.centreX - x) * 0.2;
    z += (it.centreZ - z) * 0.2;
  }
  return { x, z };
}

/** Self-check. On both boot lists: geometry, and the only import is the plan. */
export function verifyInterior(): string[] {
  const failures: string[] = [];
  const poly = (...xz: number[]): Float32Array => new Float32Array(xz);

  const southDoor = (points: Float32Array, base = 0, height = 7, seed = 4242): Interior | null =>
    buildInterior(points, base, height, seed);

  const cases: Array<{ name: string; points: Float32Array; height: number; inside: boolean }> = [
    { name: 'a terrace', points: poly(0, 0, 6, 0, 6, 18, 0, 18), height: 7.4, inside: true },
    { name: 'a tower', points: poly(0, 0, 38, 0, 38, 41, 0, 41), height: 214, inside: true },
    { name: 'a warehouse', points: poly(0, 0, 120, 0, 120, 64, 0, 64), height: 9, inside: true },
    { name: 'a diagonal terrace', points: poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8), height: 6.5, inside: true },
    { name: 'a triangle', points: poly(0, 0, 14, 0, 7, 12), height: 5, inside: true },
    { name: 'a courtyard block', points: poly(0, 0, 30, 0, 30, 30, 0, 30), height: 12, inside: true },
    // A regular forty-gon, built by rotating one point by nine degrees forty
    // times. Two literal constants and no `Math.sin`, which is DESIGN.md rule
    // 5 -- and it is a *convex* forty-gon, which the version of this case that
    // `floorplan.ts` uses is not: that one traces a bowtie, which is fine for a
    // subdivider that only wants a polygon and is meaningless here, where the
    // whole of the shell is an intersection of the outline's own half-planes.
    { name: 'a forty-gon', points: (() => {
        const cos9 = 0.98768834059513777;
        const sin9 = 0.15643446504023087;
        const out: number[] = [];
        let x = 12;
        let z = 0;
        for (let i = 0; i < 40; i++) {
          out.push(x, z);
          const nx = x * cos9 - z * sin9;
          z = x * sin9 + z * cos9;
          x = nx;
        }
        return new Float32Array(out);
      })(), height: 18, inside: true },
    // And the ones with no inside. Each of these is a thing a player can walk
    // up to, so each has to be refused rather than crash.
    { name: 'a sliver', points: poly(0, 0, 40, 0.4, 40, 1.2, 0, 0.8), height: 4, inside: false },
    { name: 'a shed', points: poly(0, 0, 2.2, 0, 2.2, 2.4, 0, 2.4), height: 2.3, inside: false },
    { name: 'a fence', points: poly(0, 0, 20, 0, 20, 0.3, 0, 0.3), height: 1.1, inside: false },
    { name: 'three collinear points', points: poly(0, 0, 5, 0, 10, 0), height: 6, inside: false },
    { name: 'one point twice', points: poly(3, 3, 3, 3, 3, 3), height: 6, inside: false },
    { name: 'no points', points: poly(), height: 6, inside: false },
    { name: 'a NaN height', points: poly(0, 0, 8, 0, 8, 8, 0, 8), height: NaN, inside: false },
  ];

  // --- **Total.** Any wall in Greater Sydney can be walked up to, so every
  // footprint the bake can produce reaches this. A throw here is a crash on a
  // door press, found by a player.
  for (const c of cases) {
    let it: Interior | null = null;
    try {
      it = southDoor(c.points, 0, c.height);
    } catch (err) {
      failures.push(`${c.name} threw: ${String(err).slice(0, 90)}`);
      continue;
    }
    if (c.inside && it === null) {
      failures.push(`${c.name} was refused an inside; its door would prompt and do nothing.`);
      continue;
    }
    if (!c.inside) {
      if (it !== null) failures.push(`${c.name} was given an inside a body cannot stand up in.`);
      continue;
    }
    if (it === null) continue;
    if (it.rooms.length === 0) failures.push(`${c.name} generated no reachable rooms.`);
    if (it.shell.length < 6) failures.push(`${c.name} generated no shell.`);
    for (const w of it.walls) {
      if (!Number.isFinite(w.ax) || !Number.isFinite(w.az) || !Number.isFinite(w.bx) || !Number.isFinite(w.bz)) {
        failures.push(`${c.name} generated a wall with a non-finite end.`);
        break;
      }
    }
  }

  // --- The arrival is inside, and standing in clear floor.
  //
  // The one thing that has to be true of every interior in the game: you come
  // through the door and you are *in the building*, not in its wall and not on
  // the pavement. Tested by asking the resolver to move the body nowhere -- a
  // null move that returns a different point is a body that was already inside
  // something.
  for (const c of cases) {
    if (!c.inside) continue;
    const it = southDoor(c.points, 12.5, c.height);
    if (it === null) continue;
    // Every wall of the footprint, not just the south one: any of them can be
    // knocked on, and an arrival is computed per door.
    const n = c.points.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = c.points[j * 2];
      const az = c.points[j * 2 + 1];
      const bx = c.points[i * 2];
      const bz = c.points[i * 2 + 1];
      let ex = bx - ax;
      let ez = bz - az;
      const len = Math.hypot(ex, ez);
      if (!(len > 1e-6)) continue;
      ex /= len;
      ez /= len;
      // Outward, away from the centre.
      let nx = ez;
      let nz = -ex;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      if ((mx - it.centreX) * nx + (mz - it.centreZ) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const at = arrivalAt(it, mx, mz, nx, nz);
      const still = it.resolver.resolve(at.x, at.z, at.x, at.z, 0.35, it.base);
      const moved = Math.hypot(still.x - at.x, still.z - at.z);
      if (moved > 1e-3) {
        failures.push(`${c.name} lands a body ${moved.toFixed(2)} m inside its own geometry at one of its doors.`);
        break;
      }
    }
    if (it.base !== 12.5) failures.push(`${c.name} put its floor at ${it.base}, not at the building's pad.`);
  }

  // --- You cannot walk out through a wall.
  //
  // The shell is the whole of what makes an interior a place rather than a
  // decal. A body driven hard at every compass point from the middle must end
  // up inside the footprint every time.
  {
    const pts = poly(0, 0, 12, 0, 12, 20, 0, 20);
    const it = southDoor(pts, 0, 8);
    if (it === null) failures.push('a plain 12 x 20 m building generated no interior at all.');
    else {
      const planes = it.planes;
      let escapes = 0;
      for (let a = 0; a < 16; a++) {
        // Sixteen directions from integer arithmetic; no Math.sin anywhere in
        // this file, which is DESIGN.md rule 5 and is why two ends agree.
        const q = a / 16;
        const dx = q < 0.5 ? 1 - q * 4 : q * 4 - 3;
        const dz = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
        const len = Math.hypot(dx, dz) || 1;
        const r = it.resolver.resolve(6, 10, 6 + (dx / len) * 400, 10 + (dz / len) * 400, 0.35, 0);
        for (const p of planes) {
          if (p.nx * r.x + p.nz * r.z - p.d < 0.35 - 1e-2) {
            escapes++;
            break;
          }
        }
      }
      if (escapes > 0) failures.push(`${escapes} of 16 sprints left the building through a wall.`);
    }
  }

  // --- Every room is reachable from the door.
  //
  // Not a property of the generator's inputs but of what it returns: the rooms
  // it keeps are exactly the ones the arrival can walk to. A search over the
  // contacts must agree with the set, or the reachability filter has a hole in
  // it and somebody is standing in a room with no way out.
  {
    const cases2 = [
      poly(0, 0, 20, 0, 20, 8, 8, 8, 8, 20, 0, 20),
      poly(0, 0, 30, 0, 30, 30, 0, 30),
      poly(0, 0, 120, 0, 120, 64, 0, 64),
    ];
    for (const pts of cases2) {
      const it = southDoor(pts, 0, 9);
      if (it === null) continue;
      const seen = new Set<number>([0]);
      const q = [0];
      const cs = contactsBetween(it.rooms);
      const adj: number[][] = it.rooms.map(() => []);
      for (const c of cs) {
        if (Math.min(DOOR_GAP_M, c.hi - c.lo - 0.2) < 0.9) continue;
        adj[c.a].push(c.b);
        adj[c.b].push(c.a);
      }
      while (q.length > 0) {
        const at = q.pop() as number;
        for (const n of adj[at]) if (!seen.has(n)) { seen.add(n); q.push(n); }
      }
      if (seen.size !== it.rooms.length) {
        failures.push(`${it.rooms.length - seen.size} of ${it.rooms.length} rooms have no way in.`);
      }
    }
  }

  // --- A doorway is a hole a body actually fits through.
  //
  // The failure this catches is the whole feature not working: walls that meet
  // in the middle of every opening, so a player walks into a house and can
  // never leave the first room. Driven rather than measured -- the body is
  // pushed from one room's centre to its neighbour's and must arrive.
  {
    const it = southDoor(poly(0, 0, 24, 0, 24, 16, 0, 16), 0, 8);
    if (it === null) failures.push('a 24 x 16 m building generated no interior.');
    else {
      const cs = contactsBetween(it.rooms);
      const box = it.plan.box;
      const world = (u: number, v: number): [number, number] => [u * box.ux - v * box.uz, u * box.uz + v * box.ux];
      let blocked = 0;
      let tried = 0;
      for (const c of cs) {
        if (Math.min(DOOR_GAP_M, c.hi - c.lo - 0.2) < 0.9) continue;
        tried++;
        const a = it.rooms[c.a];
        const b = it.rooms[c.b];
        // Through the opening, not straight at the neighbour's centre. The two
        // rooms are different sizes, so the line between their centres crosses
        // the party wall wherever it likes and a straight walk would be
        // measuring whether the door happens to be on it. A player aims at the
        // door; so does this.
        const mid = (c.lo + c.hi) / 2;
        const gate = c.axis === 0 ? world(c.coord, mid) : world(mid, c.coord);
        let [x, z] = world(a.u, a.v);
        for (const [tx, tz] of [gate, world(b.u, b.v)]) {
          // Walk in small steps, resolving each -- which is what the controller
          // does at 60 Hz, only coarser.
          for (let step = 0; step < 400; step++) {
            const dx = tx - x;
            const dz = tz - z;
            const d = Math.hypot(dx, dz);
            if (d < 0.35) break;
            const nx = x + (dx / d) * Math.min(0.1, d);
            const nz = z + (dz / d) * Math.min(0.1, d);
            const r = it.resolver.resolve(x, z, nx, nz, 0.35, it.base);
            if (Math.hypot(r.x - x, r.z - z) < 1e-4) break;
            x = r.x;
            z = r.z;
          }
        }
        const [bx, bz] = world(b.u, b.v);
        if (Math.hypot(bx - x, bz - z) > 1.2) blocked++;
      }
      if (tried === 0) failures.push('a 24 x 16 m building has no doorways between its rooms at all.');
      if (blocked > 0) failures.push(`${blocked} of ${tried} doorways cannot be walked through.`);
    }
  }

  // --- Deterministic, which is the whole reason nothing about an interior is
  // on the wire. Two ends, one seed, one house.
  {
    const pts = poly(0, 0, 14, 0, 14, 22, 0, 22);
    const a = southDoor(pts, 3, 9, 555);
    const b = southDoor(pts, 3, 9, 555);
    const c = southDoor(pts, 3, 9, 556);
    if (a === null || b === null || c === null) failures.push('a plain building generated no interior.');
    else {
      if (JSON.stringify(a.walls) !== JSON.stringify(b.walls)) {
        failures.push('one building generated two different insides; the two ends would disagree about a wall.');
      }
      if (JSON.stringify(a.walls) === JSON.stringify(c.walls)) {
        failures.push('two buildings generated the same inside; the seed is doing nothing.');
      }
    }
  }

  // --- No wall hangs over the street.
  //
  // The plan is laid out on a box that *circumscribes* the footprint, so an
  // outer room's edge runs past the wall unless it is clipped. Unclipped, a
  // triangle's inside is a set of walls crossing the pavement.
  {
    for (const pts of [poly(0, 0, 14, 0, 7, 12), poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8)]) {
      const it = southDoor(pts, 0, 7);
      if (it === null) continue;
      let outside = 0;
      for (const w of it.walls) {
        for (const [x, z] of [[w.ax, w.az], [w.bx, w.bz], [(w.ax + w.bx) / 2, (w.az + w.bz) / 2]]) {
          for (const p of it.planes) {
            if (p.nx * x + p.nz * z - p.d < -0.05) {
              outside++;
              break;
            }
          }
        }
      }
      if (outside > 0) failures.push(`${outside} wall ends of a non-rectangular building stand outside it.`);
    }
  }

  return failures;
}
