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
 * ## The door is where you came in
 *
 * *"ideally, where i enter is where the door goes"* -- the owner, and it is
 * the third design for this door, so the history is worth keeping:
 *
 * 1. **Per entrant, from the wall you knocked on.** Right, but a player restored
 *    into a building had no wall to derive one from, so the restore put a door
 *    beside wherever they were standing. Reported.
 * 2. **The building's, from its footprint.** Fixed the restore and broke the
 *    thing that mattered: the inside door was nowhere near where you had come
 *    in -- and for a concave outline the hull's longest edge is the air across
 *    a notch, 21 m from any wall. Reported.
 * 3. **Per entrant, and saved with the spot.** The door you came in by travels
 *    with your account beside your position (`accounts.LastPos`), so a restore
 *    has the real one. That is this.
 *
 * `Interior.door` still exists, derived from the footprint, as the **fallback**:
 * the door for a spot saved before doors were, and the one furniture must keep
 * clear of when nobody is in the room to ask. Everything drawn, entered or
 * exited uses the entrant's own.
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
// What people put in the room, as against what the generator put there. One
// direction only: `placeables.ts` knows nothing about interiors.
import {
  PLACEABLE,
  PLACEABLES,
  boxClearance,
  boxOf,
  boxesOverlap,
  cornersOf,
  pushOutOfBox,
  type PlacedBox,
  type Placement,
} from './placeables.ts';

/** Wall thickness, metres. Also how far the walkable shell is inset from the footprint. */
export const WALL_THICK_M = 0.16;

/**
 * A doorway's clear width, metres.
 *
 * 2.0 rather than a real 0.82 m door leaf, and it was 1.4. A player is a 0.35 m
 * radius capsule driven at seven metres a second by somebody who is looking
 * somewhere else, and a doorway they have to aim at is a doorway they bounce
 * off. The same argument `riding.GANGWAY_HALF_WIDTH_M` makes about a carriage
 * ring, and the same report that widened the rooms.
 */
export const DOOR_GAP_M = 2.0;

/**
 * The narrowest contact between two rooms that can still become a doorway.
 *
 * Sized against `DOOR_GAP_M` plus a jamb each side, so that **every** contact
 * this admits becomes an opening a body fits through -- which is what makes
 * connectivity a property of the generator rather than something to check for
 * afterwards. Below it the two rooms are simply not adjacent.
 */
const MIN_CONTACT_M = 2.2;

/** Headroom, floor to ceiling slab. Under `floorplan.STOREY_M` by the slab's own depth. */
export const CEILING_M = 2.7;

/**
 * Head height of an opening between two rooms, metres.
 *
 * The wall carries on above it -- see `Interior.headers`. 2.1 rather than a
 * real 2.04 m door head, because the extra six centimetres is free and a
 * player jumping through a doorway should not clip a lintel that is not there
 * as far as collision is concerned.
 */
export const DOOR_HEAD_M = 2.1;

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

/** A building's one door, derived from its footprint. See the header. */
export interface InteriorDoor {
  /** On the outline, world metres. */
  x: number;
  z: number;
  /** Outward normal, unit length: the way out. */
  nx: number;
  nz: number;
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
  /**
   * The wall over each opening -- the lintel, and what makes a gap a doorway.
   *
   * **Drawing only. Deliberately not in `walls`, which is collision**: you walk
   * under a header, and a resolver that saw one would put a wall across every
   * doorway in the building.
   */
  headers: readonly InteriorWall[];
  /** The walkable shell: the footprint inset by a wall. Convex, world x,z pairs. */
  shell: Float32Array;
  /** The same shell as half-planes, which is what the resolver actually reads. */
  planes: readonly ShellPlane[];
  /** The footprint's centre. `arrivalAt` walks toward it; the view looks at it. */
  centreX: number;
  centreZ: number;
  /** The one door. Derived from the footprint; see the header. */
  door: InteriorDoor;
  /**
   * What people have put in the room, as boxes, for the mesh to draw.
   *
   * The same list `InteriorResolver.setPlaced` holds, kept here as well so that
   * the drawing and the collision cannot describe different rooms. `setPlacements`
   * writes both in one call and is the only thing that writes either.
   */
  placedBoxes: PlacedBox[];
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

// --- The hull ------------------------------------------------------------------

/**
 * The convex hull of a footprint, as x,z pairs, counter-clockwise.
 *
 * Andrew's monotone chain: a sort and two sweeps, integer-exact cross products,
 * no trig. `n log n` over polygons that are at most a few dozen corners.
 *
 * ## Why the room is built on the hull and not on the outline
 *
 * INTERIORS.md said the prisms were convex hulls. They are not: measured over
 * the 1,182 enterable buildings within 800 m of the spawn, **441 are concave**,
 * and for 107 of those the old shell -- the intersection of the outline's own
 * edge half-planes -- was *empty*. Not a smaller room, as the comment claimed;
 * no room at all. Every point inside the building measured thirty metres
 * "outside", the resolver pushed the body thirty metres every tick, and the
 * player could not take a step. That was the owner, in a 26-corner shed in
 * Erskineville, reporting "I can't move inside the room".
 *
 * The hull is the smallest convex shape the outline fits in, so every piece of
 * this file that needs convexity -- the half-planes, the fan floor, the door on
 * the longest edge -- is exact again. What it costs is fidelity in the notches:
 * a U-shaped building gets a room across the mouth of the U. Nobody can see
 * that from inside, because the city is on another layer, and the plan's
 * rooms are still culled against the *real* outline, so the notch is open
 * floor rather than a room somebody could be put in.
 */
export function convexHull(points: Float32Array): Float32Array {
  const n = points.length >> 1;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(points[i * 2]) && Number.isFinite(points[i * 2 + 1])) idx.push(i);
  }
  if (idx.length < 3) return new Float32Array(0);
  idx.sort((a, b) => points[a * 2] - points[b * 2] || points[a * 2 + 1] - points[b * 2 + 1]);
  const cross = (o: number, a: number, b: number): number =>
    (points[a * 2] - points[o * 2]) * (points[b * 2 + 1] - points[o * 2 + 1]) -
    (points[a * 2 + 1] - points[o * 2 + 1]) * (points[b * 2] - points[o * 2]);
  const lower: number[] = [];
  for (const i of idx) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop();
    lower.push(i);
  }
  const upper: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop();
    upper.push(i);
  }
  lower.pop();
  upper.pop();
  const ring = lower.concat(upper);
  const out = new Float32Array(ring.length * 2);
  for (let k = 0; k < ring.length; k++) {
    out[k * 2] = points[ring[k] * 2];
    out[k * 2 + 1] = points[ring[k] * 2 + 1];
  }
  return out;
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
  /**
   * What people have put in the room, as boxes.
   *
   * Mutable, where everything else in this class is fixed at construction, and
   * that asymmetry is the feature: the *rooms* are derived and identical for
   * everybody forever, and the couches are not -- they arrive on the wire, they
   * change while a player is standing in the room, and both ends have to start
   * stepping bodies around them on the same tick. Replaced wholesale rather
   * than patched, because a placement list is at most 64 entries and the frame
   * that carries it is the whole list.
   */
  private placed: readonly PlacedBox[] = [];

  constructor(
    private readonly planes: readonly ShellPlane[],
    private readonly walls: readonly InteriorWall[],
  ) {}

  /** Adopt this room's furniture. See `placed`. */
  setPlaced(boxes: readonly PlacedBox[]): void {
    this.placed = boxes;
  }

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
    for (const b of this.placed) {
      const s = boxClearance(b, x, z);
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
      // And the furniture, in the same pass as the walls so a body wedged
      // between a couch and a wall is pushed out of both before the pass ends.
      for (const b of this.placed) {
        const r = pushOutOfBox(b, x, z, radius);
        if (!r.hit) continue;
        x = r.x;
        z = r.z;
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

  // The hull, for the shell, the floor and the door. See `convexHull`. The
  // plan below still reads the real outline, which is what keeps rooms out of
  // the notches.
  const hull = convexHull(points);
  if (hull.length < 6) return null;
  const planes = shellPlanes(hull, WALL_THICK_M);
  if (planes.length < 3) return null;
  const shell = shellPolygon(planes);
  if (shell.length < 6) return null;
  // **The shell is consistent**, or there is no room. Every vertex of it must
  // satisfy every plane; a half-plane intersection that is empty produces
  // vertices that violate the others by metres, and a body placed in it is
  // pushed every tick. This cannot happen on a hull. It is checked anyway,
  // because the last comment that said "cannot happen" here was wrong.
  for (let i = 0; i < shell.length; i += 2) {
    for (const pl of planes) {
      if (pl.nx * shell[i] + pl.nz * shell[i + 1] - pl.d < -0.05) return null;
    }
  }

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
  /*
   * The wall **above** each opening, which is what makes it a doorway.
   *
   * A gap subtracted from a wall over its whole height is not a door, it is a
   * missing wall -- reported as *"missing doors and stuff"* the first time
   * anybody looked at a finished room. A real opening is 2.1 m tall with the
   * wall carrying on over it, and the lintel is most of what the eye reads: it
   * is the thing that says "this is a way through" rather than "this partition
   * stops here".
   *
   * Kept apart from `walls` rather than given a height, because `walls` is
   * **collision** and a header must not be: you walk under it. Two lists, one
   * of which the resolver never sees, is a smaller change than teaching
   * `InteriorResolver` about a vertical extent it would then have to be trusted
   * to ignore -- and it keeps `verifyInterior`'s walk-through-every-doorway
   * check testing exactly what it tested before.
   */
  const headerSpans: Span[] = [];
  for (const span of merged) {
    let parts: Array<{ lo: number; hi: number }> = [{ lo: span.lo, hi: span.hi }];
    for (const gap of doorways) {
      if (gap.axis !== span.axis || Math.abs(gap.coord - span.coord) > 1e-3) continue;
      // Where this gap actually cuts *this* wall is where a header goes. A
      // doorway on a line with no wall along it needs none, and would be a
      // lintel standing on nothing.
      const lo = Math.max(gap.lo, span.lo);
      const hi = Math.min(gap.hi, span.hi);
      if (hi - lo > 0.05) headerSpans.push({ axis: span.axis, coord: span.coord, lo, hi });
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
    // And not the outer wall again. The plan is laid out on a box that
    // circumscribes the footprint, so the outermost partition runs along the
    // outside wall by construction; clipped to the shell it lands on it or a
    // few centimetres inside it. Kept, that is a second wall over the first --
    // two surfaces at the same depth, which is z-fighting, and one of its two
    // faces points out of the room -- and it walls off a slot no body could
    // stand in anyway. The shell already stops a body there and already draws
    // it.
    //
    // The threshold is a **whole** wall thickness rather than the half that
    // would be exactly enough, because a partition is drawn as two faces offset
    // half a thickness off its centre line: a line 8 cm inside the shell puts a
    // face exactly on it, which is what this was written for.
    let onShell = false;
    for (const pl of planes) {
      if (
        Math.abs(pl.nx * clipped.ax + pl.nz * clipped.az - pl.d) < WALL_THICK_M &&
        Math.abs(pl.nx * clipped.bx + pl.nz * clipped.bz - pl.d) < WALL_THICK_M
      ) {
        onShell = true;
        break;
      }
    }
    if (onShell) continue;
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

  /*
   * --- The door: the midpoint of the longest edge, facing out.
   *
   * Derived from the footprint, so it is the same door on every machine, in
   * every session, for everybody in the building -- which is the property the
   * rooms already have and the door did not. The longest edge is a frontage
   * often enough to be a good guess and is unambiguous always; ties go to the
   * earlier edge so a perfectly square building still has exactly one door.
   *
   * The normal is flipped away from the centre rather than trusted from the
   * winding, which is `doorway.doorAt`'s rule and is right for a convex hull
   * however it was wound.
   */
  let door: InteriorDoor = { x: centreX, z: centreZ, nx: 0, nz: -1 };
  {
    // On the **hull**, not the outline: the longest edge of a concave outline
    // can be the side of a notch, and a door there steps "out" into the
    // building's own collision on the city side. A hull edge is either a real
    // wall or the air across a notch, and both are outside the room.
    const n = hull.length >> 1;
    let bestLen = -1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = hull[j * 2];
      const az = hull[j * 2 + 1];
      const bx = hull[i * 2];
      const bz = hull[i * 2 + 1];
      const len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      if (!(len > bestLen)) continue;
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      let nx = (bz - az) / len;
      let nz = -(bx - ax) / len;
      if ((mx - centreX) * nx + (mz - centreZ) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      bestLen = len;
      door = { x: mx, z: mz, nx, nz };
    }
  }

  // The headers, through the same conversion and the same clip as the walls.
  const headers: InteriorWall[] = [];
  for (const piece of headerSpans) {
    const au = piece.axis === 0 ? piece.coord : piece.lo;
    const av = piece.axis === 0 ? piece.lo : piece.coord;
    const bu = piece.axis === 0 ? piece.coord : piece.hi;
    const bv = piece.axis === 0 ? piece.hi : piece.coord;
    const ax = au * box.ux - av * box.uz;
    const az = au * box.uz + av * box.ux;
    const bx = bu * box.ux - bv * box.uz;
    const bz = bu * box.uz + bv * box.ux;
    if (!clipToShell(planes, ax, az, bx, bz, clipped)) continue;
    const dx = clipped.bx - clipped.ax;
    const dz = clipped.bz - clipped.az;
    if (dx * dx + dz * dz < 0.05 * 0.05) continue;
    headers.push({ ax: clipped.ax, az: clipped.az, bx: clipped.bx, bz: clipped.bz });
  }

  const it: Interior = {
    seed,
    base,
    ceilingY: base + CEILING_M,
    plan,
    rooms,
    walls,
    headers,
    shell,
    planes,
    centreX,
    centreZ,
    door,
    placedBoxes: [],
    resolver: new InteriorResolver(planes, walls),
  };
  // **And a body can stand in it.** Both ends run this same line before either
  // offers a door, so a building the generator cannot make a clear arrival in
  // has no prompt on the client and no entry on the server -- the same
  // agreement `interiorAdmits` already gives, one step later and against the
  // finished geometry rather than the footprint. Before the hull this refused
  // 107 of the 1,182 buildings near the spawn; now it should refuse none, and
  // it stays because the last time this file said "cannot happen" it could.
  if (arrivalAt(it).stuck) return null;
  return it;
}

/**
 * Where a body arrives when it comes in by this door.
 *
 * One door, so one arrival: everybody who walks into a building comes out on
 * the inside in the same place. See the header for why the door stopped being
 * per entrant.
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
export function arrivalAt(it: Interior, door: InteriorDoor = it.door): { x: number; z: number; stuck?: boolean } {
  let x = door.x - door.nx * 1.0;
  let z = door.z - door.nz * 1.0;
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
    if (it.resolver.clearance(x, z) >= BODY_CLEARANCE_M) return { x, z };
    x += (it.centreX - x) * 0.2;
    z += (it.centreZ - z) * 0.2;
  }
  // Never clear, even at the centre. Say so rather than hand back a point the
  // resolver will push every tick: the caller refuses the door, which is a
  // building you cannot enter instead of one you cannot leave.
  return { x, z, stuck: true };
}

// --- What people put in it -----------------------------------------------------

/**
 * How much room a doorway keeps around itself, metres.
 *
 * Nothing may be placed within this of an opening. It is the one anti-grief
 * rule in a feature that is otherwise wide open by the owner's decision --
 * *"for now just make it anyone can customise it"* -- and it is the one worth
 * having: a couch across a doorway is a room somebody else cannot get into, and
 * unlike a couch in the middle of the floor it cannot be walked around.
 */
export const OPENING_CLEAR_M = 0.6;

/**
 * And the same for the way out, which is bigger because it matters more.
 *
 * Leaving does not test a reach (`sim.leaveInterior` says why), so a couch in
 * front of the door cannot actually trap anybody. What it can do is hide the
 * one panel in the building that says where the way out is, which for a new
 * player is the same thing.
 */
export const DOOR_CLEAR_M = 1.4;

/**
 * How finely a wall is sampled when testing whether something fits against it.
 *
 * Segment-against-oriented-box is exact and fiddly; sampling a wall every
 * 20 cm and asking the box how far away each sample is uses the distance
 * function the collision already has, and 20 cm against a body 70 cm across
 * cannot let anything through. Stated rather than hidden, because it is an
 * approximation and the reader is entitled to know which way it errs: toward
 * refusing a placement that would just have fitted.
 */
const WALL_SAMPLE_M = 0.2;

/** Is this segment far enough from this box? Sampled; see `WALL_SAMPLE_M`. */
function clearOfSegment(
  b: PlacedBox,
  ax: number, az: number, bx: number, bz: number,
  want: number,
): boolean {
  const len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
  const steps = Math.max(1, Math.ceil(len / WALL_SAMPLE_M));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (boxClearance(b, ax + (bx - ax) * t, az + (bz - az) * t) < want) return false;
  }
  return true;
}

/**
 * May this thing be put here?
 *
 * **The server's answer, and the browser runs it too** -- not because the
 * browser is trusted, but so the ghost a player is aiming with turns red on
 * exactly the frames the server would refuse. A rule enforced only on the
 * authority is a rule a player discovers by being told no.
 *
 * Five questions, in the order that makes the cheap ones first:
 *
 *   1. Is it a thing at all, and is the room already full?
 *   2. Is every corner of it inside the room? A couch half through the outside
 *      wall is a couch hanging over the street.
 *   3. Is it clear of the partitions?
 *   4. Is it clear of the openings and of the way out? See `OPENING_CLEAR_M`.
 *   5. Is it clear of everything already here?
 */
export function placementFits(
  it: Interior,
  existing: readonly Placement[],
  p: Placement,
  doors: readonly InteriorDoor[] = [it.door],
): boolean {
  const kind = PLACEABLES[p.kind];
  if (kind === undefined) return false;
  const box = boxOf(p, it.plan.box.ux, it.plan.box.uz);

  // Inside the room, corners and all.
  const corners = cornersOf(box);
  for (let i = 0; i < corners.length; i += 2) {
    for (const pl of it.planes) {
      if (pl.nx * corners[i] + pl.nz * corners[i + 1] - pl.d < 0.02) return false;
    }
  }
  // Clear of the partitions, by half a wall so it stands against one rather
  // than in one.
  for (const w of it.walls) {
    if (!clearOfSegment(box, w.ax, w.az, w.bx, w.bz, WALL_THICK_M / 2)) return false;
  }
  // Clear of every opening, which is the rule that keeps a building walkable.
  for (const h of it.headers) {
    if (!clearOfSegment(box, h.ax, h.az, h.bx, h.bz, OPENING_CLEAR_M)) return false;
  }
  // Every door anybody in the room came in by, not just the building's own:
  // the door is per entrant (see the header), and a couch across the one you
  // used is the one you cannot find.
  for (const d of doors) {
    if (boxClearance(box, d.x, d.z) < DOOR_CLEAR_M) return false;
  }
  // And clear of everything already in the room.
  for (const other of existing) {
    if (boxesOverlap(box, boxOf(other, it.plan.box.ux, it.plan.box.uz))) return false;
  }
  return true;
}

/**
 * Hand this room its furniture, so bodies start walking around it.
 *
 * One call rather than a setter per list, because the resolver and the mesh
 * must never disagree about what is in the room: a body stepped around a couch
 * nobody can see is worse than either of the two halves being wrong.
 */
export function setPlacements(it: Interior, list: readonly Placement[]): void {
  const boxes: PlacedBox[] = [];
  for (const p of list) boxes.push(boxOf(p, it.plan.box.ux, it.plan.box.uz));
  it.resolver.setPlaced(boxes);
  it.placedBoxes = boxes;
}

// --- Saying what it is ---------------------------------------------------------

/**
 * One line about the building you have just walked into.
 *
 * The owner allowed a loading screen on first entry *"as long as it
 * interestingly describes the phases"*. There are no phases to describe:
 * generating an interior is a few hundred microseconds of integer arithmetic
 * over a footprint the browser already had, so a progress bar would be a
 * fabricated wait -- and the reason WoW's works is that something is genuinely
 * happening behind it.
 *
 * What the permission was really for is the moment landing: a hard cut from a
 * sunlit street into a dim room, with nothing said about where you are. So this
 * is the honest version of it -- one line, on the pill the HUD already has,
 * describing the room the generator just made out of this particular building.
 *
 * It is a pure function of the plan, so two people in one pub read the same
 * sentence, and it **says what is not there**: the storeys above you exist in
 * the plan and are not walkable yet, and a player who is told that is a player
 * who has been told the truth rather than one who spends five minutes looking
 * for the stairs.
 */
export function interiorLine(it: Interior): string {
  const rooms = it.rooms.length;
  const above = Math.max(0, it.plan.storeys - 1);
  // How big the floor is, from the plan's own box rather than from the rooms:
  // the box is the building and the rooms are what was fitted into it.
  const w = Math.round(it.plan.box.ex * 2);
  const d = Math.round(it.plan.box.ez * 2);
  const long = Math.max(w, d);
  const short = Math.min(w, d);
  const shape =
    long >= 60 ? 'A shed the size of a street' :
    long >= 30 ? 'A big floor' :
    short <= 6 ? 'A narrow terrace' :
    long / Math.max(1, short) >= 2.4 ? 'A long room' :
    'Inside';
  const count = rooms === 1 ? 'one room' : `${rooms} rooms`;
  const upstairs =
    above === 0 ? 'and no way up' :
    above === 1 ? 'with a floor above you, shut' :
    `with ${above} floors above you, shut`;
  return `${shape}: ${count}, ${upstairs}.`;
}

// --- Drawing it ----------------------------------------------------------------

/**
 * One couch, pushed into a triangle soup.
 *
 * A free function rather than a closure inside `interiorMesh`, because the
 * **ghost** needs the same seven boxes: a preview drawn from different code
 * than the thing it previews is a preview that lies, and the one place a player
 * would notice is the one place it matters -- lining a couch up against a wall.
 *
 * Seven boxes rather than one, and it can afford to be: nothing in an interior
 * is ever drawn by anybody in the street, which is the owner's own argument for
 * why an inside is its own instance.
 *
 * `tint` overrides the cloth outright, which is what the ghost uses to be green
 * or red. Null takes the colour from where the couch stands -- deterministic,
 * so everybody in the building sees the same one, and derived from the position
 * so a couch keeps its colour when it is nudged and forgets it when it is moved
 * across the room, which is the honest behaviour for a thing with no identity
 * of its own.
 */
export function couchInto(
  pos: number[],
  nor: number[],
  col: number[],
  b: PlacedBox,
  floorY: number,
  tint: { r: number; g: number; b: number } | null = null,
): void {
  const seat = 0.42;
  const back = b.height;
  const arm = 0.58;
  const tone = 0.55 + hash2(Math.round(b.x * 4), Math.round(b.z * 4)) * 0.5;
  const cloth = tint ?? {
    r: Math.min(1, 0.34 * tone + 0.14),
    g: Math.min(1, 0.30 * tone + 0.12),
    b: Math.min(1, 0.36 * tone + 0.16),
  };
  const dark = { r: cloth.r * 0.62, g: cloth.g * 0.62, b: cloth.b * 0.62 };
  const shade = (c: { r: number; g: number; b: number }, k: number): number[] => [
    Math.min(1, c.r * k), Math.min(1, c.g * k), Math.min(1, c.b * k),
  ];
  const quad = (
    ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, dx: number, dy: number, dz: number,
    nx: number, ny: number, nz: number, rgb: number[],
  ): void => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 6; i++) nor.push(nx, ny, nz);
    for (let i = 0; i < 6; i++) col.push(rgb[0], rgb[1], rgb[2]);
  };
  /** An upright box in the placement's own frame. `cu`/`cv` its centre, `hu`/`hv` its half-extents. */
  const slab = (
    cu: number, cv: number, hu: number, hv: number, y0: number, y1: number,
    rgb: { r: number; g: number; b: number },
  ): void => {
    const px = (u: number, v: number): [number, number] => [
      b.x + u * b.ax - v * b.az,
      b.z + u * b.az + v * b.ax,
    ];
    const c0 = px(cu - hu, cv - hv);
    const c1 = px(cu + hu, cv - hv);
    const c2 = px(cu + hu, cv + hv);
    const c3 = px(cu - hu, cv + hv);
    const side = (p: [number, number], q: [number, number], k: number): void => {
      let nx = q[1] - p[1];
      let nz = -(q[0] - p[0]);
      const l = Math.sqrt((nx) * (nx) + (nz) * (nz)) || 1;
      nx /= l;
      nz /= l;
      quad(p[0], y0, p[1], q[0], y0, q[1], q[0], y1, q[1], p[0], y1, p[1], nx, 0, nz, shade(rgb, k));
    };
    side(c0, c1, 1);
    side(c1, c2, 0.86);
    side(c2, c3, 0.74);
    side(c3, c0, 0.86);
    // The top, which is the surface anybody actually looks at.
    quad(
      c0[0], y1, c0[1], c1[0], y1, c1[1], c2[0], y1, c2[1], c3[0], y1, c3[1],
      0, 1, 0, shade(rgb, 1.12),
    );
  };
  slab(0, 0, b.hx, b.hz, floorY, floorY + 0.16, dark);
  slab(-b.hx * 0.45, 0.06, b.hx * 0.42, b.hz * 0.74, floorY + 0.16, floorY + seat, cloth);
  slab(b.hx * 0.45, 0.06, b.hx * 0.42, b.hz * 0.74, floorY + 0.16, floorY + seat, cloth);
  slab(0, -b.hz + 0.11, b.hx, 0.11, floorY + 0.16, floorY + back, cloth);
  slab(-b.hx + 0.09, 0.09, 0.09, b.hz * 0.9, floorY + 0.16, floorY + arm, dark);
  slab(b.hx - 0.09, 0.09, 0.09, b.hz * 0.9, floorY + 0.16, floorY + arm, dark);
}

/**
 * One placement on its own, for the customiser's ghost.
 *
 * Green when the server would take it, red when it would not. The same
 * `couchInto` the room is drawn with, which is the point -- see its note.
 */
export function ghostMesh(it: Interior, p: Placement, ok: boolean): InteriorMesh {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  couchInto(
    pos, nor, col,
    boxOf(p, it.plan.box.ux, it.plan.box.uz),
    it.base + 0.01,
    ok ? { r: 0.35, g: 0.85, b: 0.45 } : { r: 0.9, g: 0.3, b: 0.28 },
  );
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    colors: new Float32Array(col),
    triangles: pos.length / 9,
  };
}



/**
 * The interior as triangles: positions, normals and vertex colours.
 *
 * Data rather than a mesh, so this file stays three-free and the server can
 * import it -- and so the one thing worth checking about the geometry (that it
 * is closed, finite, and the right way round) is checkable without a GPU.
 * `world/interiorview.ts` is the twenty lines that make a `Mesh` of it.
 *
 * ## One material, and why the shading is in the vertices
 *
 * INTERIORS.md's constraint: **one shared material** for every interior in the
 * game. Per-building materials would rebuild exactly the pipeline explosion
 * `world/instancepool.ts` was written to fix -- three's `RenderObject` keys its
 * node graph and its WGSL on the material, so a hundred buildings would be a
 * hundred compiles.
 *
 * So the shading is baked into the vertex colours and the material is
 * unlit. That is not a compromise made for the budget; it is the cheaper and
 * *more* controllable of the two, because an interior is a windowless box and a
 * real light in it would have to be a real light per room. A floor lighter than
 * its walls and walls darker at the skirting is what reads as a room, and both
 * are one multiply here.
 *
 * The hue comes from the building's own seed, so a warehouse and the terrace
 * next door are not the same grey -- deterministically, from the same integer
 * hash everything else in this feature uses, so two people in one pub see one
 * room.
 */
export interface InteriorMesh {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** Triangles. `positions.length / 9`. */
  triangles: number;
}

/** Is this point on the outer wall rather than in the middle of the room? */
function onShell(it: Interior, x: number, z: number): boolean {
  for (const pl of it.planes) {
    if (Math.abs(pl.nx * x + pl.nz * z - pl.d) < 0.03) return true;
  }
  return false;
}

/**
 * A deterministic 0..1 out of two integers. The project's own FNV-ish hash.
 *
 * Every "random" thing about how an interior looks comes through here, so that
 * two people in one pub are standing on the same floorboards. No `Math.random`
 * and no `Math.sin`; DESIGN.md rule 5.
 */
function hash2(a: number, b: number): number {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (b | 0), 0xc2b2ae35) >>> 0;
  h ^= h >>> 15;
  return (h >>> 8) / 0x1000000;
}

/** What this building is finished in. A pure function of its seed. */
export const FLOOR = { BOARDS: 0, CARPET: 1, TILE: 2 } as const;
export const WALLS = { PAINT: 0, BRICK: 1, PANEL: 2 } as const;

/**
 * The finishes, from the building's own seed.
 *
 * *"random floorboard vs carpet on ground, walls and windows"* -- the owner.
 * Random per building and identical for everybody who walks into that building,
 * which is the same guarantee the rooms themselves have and for the same
 * reason: it is derived, so it costs nothing on the wire and survives a reload.
 *
 * The floor is weighted rather than uniform. Boards are the Sydney default --
 * every terrace, every pub, every warehouse -- so they get half of all
 * buildings, carpet a third (offices, older flats) and tile the rest (shops,
 * kitchens, foyers). A uniform third each would make the city read as more
 * carpeted than it is.
 */
function finishOf(seed: number): { floor: number; walls: number } {
  const f = hash2(seed, 0x100);
  const w = hash2(seed, 0x200);
  return {
    floor: f < 0.5 ? FLOOR.BOARDS : f < 0.83 ? FLOOR.CARPET : FLOOR.TILE,
    walls: w < 0.55 ? WALLS.PAINT : w < 0.82 ? WALLS.BRICK : WALLS.PANEL,
  };
}

/**
 * How many quads the floor covering may cost.
 *
 * A 120 x 64 m warehouse at a realistic 130 mm board is a quarter of a million
 * quads for a floor nobody is looking at closely, so the covering is sized to
 * fit this budget instead: a terrace gets real boards, a warehouse gets planks
 * a metre wide, and neither costs more than the other. The number is generous
 * because this is *one* mesh in *one* draw call with no texture fetch, built
 * once when a player walks through a door.
 */
const MAX_FLOOR_QUADS = 1600;

/** The tint of one building's plaster, from its own seed. */
function shadeOf(seed: number): { r: number; g: number; b: number } {
  // FNV-ish, the integer hash this project uses everywhere. Three bytes out of
  // one word, kept in a narrow band: an interior is plaster and floorboards,
  // and a building that came out lime green would read as a bug.
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  const r = 0.62 + ((h & 0xff) / 255) * 0.18;
  const g = 0.60 + (((h >>> 8) & 0xff) / 255) * 0.18;
  const b = 0.56 + (((h >>> 16) & 0xff) / 255) * 0.18;
  return { r, g, b };
}

/**
 * Build the triangles.
 *
 * The door comes off the interior, so every player in the building sees the
 * panel on the same wall. It is drawn at all because *the way out has to be
 * visible from inside*, which is the one thing a player in a windowless room
 * has no other way to learn.
 */
export function interiorMesh(it: Interior, door: InteriorDoor = it.door): InteriorMesh {
  const { x: doorX, z: doorZ, nx: doorNX, nz: doorNZ } = door;
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const tint = shadeOf(it.seed);
  const finish = finishOf(it.seed);
  /**
   * The carpet, which is the one surface that is not a shade of the plaster.
   *
   * A carpet the colour of the walls is not a carpet; it is a floor somebody
   * forgot to finish. Four hues out of the seed -- the reds, greens and greys
   * an Australian pub or office block is actually laid with -- and they are
   * muted, because a saturated floor in an unlit room reads as a bug.
   */
  /**
   * What a window is full of.
   *
   * The material is unlit, so this is not a reflection or a sky -- it is the
   * one deliberately bright surface in the building, and its whole job is to be
   * the brightest thing in the room so a player's eye goes to it. Slightly
   * blue, because daylight is.
   */
  const daylight = { r: 0.80, g: 0.88, b: 0.97 };
  const carpet = (() => {
    const pick = Math.floor(hash2(it.seed, 0x300) * 4);
    const v = 0.9 + hash2(it.seed, 0x301) * 0.25;
    const swatch =
      pick === 0 ? { r: 0.42, g: 0.20, b: 0.20 } :
      pick === 1 ? { r: 0.22, g: 0.30, b: 0.24 } :
      pick === 2 ? { r: 0.30, g: 0.28, b: 0.36 } :
      { r: 0.34, g: 0.32, b: 0.28 };
    return { r: swatch.r * v, g: swatch.g * v, b: swatch.b * v };
  })();
  /** A colour times a shade, clamped. The buffers must stay inside 0..1. */
  const scaled = (c: { r: number; g: number; b: number }, k: number): { r: number; g: number; b: number } => ({
    r: Math.min(1, c.r * k),
    g: Math.min(1, c.g * k),
    b: Math.min(1, c.b * k),
  });
  const floorY = it.base;
  const ceilY = it.base + CEILING_M;

  /**
   * One triangle, with a flat normal and a flat colour.
   *
   * `shade` multiplies the building's own tint, which is how every surface in
   * the room is coloured. `rgb`, when given, replaces it outright — used by the
   * door, which must not be a shade of the plaster it is set into.
   */
  const tri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    nx: number, ny: number, nz: number,
    shade: number,
    rgb: { r: number; g: number; b: number } | null = null,
  ): void => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    for (let i = 0; i < 3; i++) nor.push(nx, ny, nz);
    const r = rgb === null ? tint.r * shade : rgb.r;
    const g = rgb === null ? tint.g * shade : rgb.g;
    const b = rgb === null ? tint.b * shade : rgb.b;
    for (let i = 0; i < 3; i++) col.push(r, g, b);
  };

  /**
   * A quad standing on the ground, from `a` to `b`, facing `(nx, nz)`.
   *
   * Two triangles with the skirting darker than the picture rail, which is the
   * whole of the "lighting". `lo`/`hi` are the shades at floor and ceiling.
   */
  const wall = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, lo: number, hi: number,
    y0 = floorY, y1 = ceilY,
    rgb: { r: number; g: number; b: number } | null = null,
  ): void => {
    // Split into two triangles that each carry one shade, rather than a real
    // gradient: the material is unlit and per-vertex colour would need the two
    // triangles to share vertices, which a flat-normal buffer cannot do.
    tri(ax, y0, az, bx, y0, bz, bx, y1, bz, nx, 0, nz, lo, rgb);
    tri(ax, y0, az, bx, y1, bz, ax, y1, az, nx, 0, nz, hi, rgb);
  };

  /**
   * A wall with a finish on it: skirting, courses, a dado rail.
   *
   * The same two triangles as `wall` for every band, and the bands are the
   * whole of the "texture" -- *"texture the inside ... walls"*. There is no
   * image anywhere in this feature and there must not be: one unlit material
   * with vertex colours is what keeps every interior in the game to a single
   * pipeline (see the header), and a texture would mean an atlas, a fetch and a
   * second material variant.
   *
   * What each finish is doing, and none of it is decoration:
   *
   *   - **A skirting board on every wall.** It is a dark band 14 cm tall at the
   *     floor, and it is the single cheapest thing that makes a room read as a
   *     room -- it gives the eye the floor/wall join, which an unlit box
   *     otherwise has to infer from a shade change. It also hides the ragged
   *     centimetres where the floor covering stops short of the shell.
   *   - **Brick** is eight courses of alternating shade. Coarse for a brick, and
   *     right for a warehouse or a pub's back wall at the distance anybody
   *     stands from it.
   *   - **Panel** puts a dado rail at a metre, which is the one horizontal line
   *     a person's eye uses to judge how big a room is.
   */
  const finishedWall = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, lo: number, hi: number,
  ): void => {
    const top = ceilY - floorY;
    const band = (y0: number, y1: number, shade: number): void => {
      if (y1 <= y0) return;
      wall(ax, az, bx, bz, nx, nz, shade, shade, floorY + y0, floorY + y1);
    };
    const skirt = Math.min(0.14, top * 0.06);
    band(0, skirt, lo * 0.62);
    if (finish.walls === WALLS.BRICK) {
      // Eight courses, alternating, over whatever is left above the skirting.
      const COURSES = 8;
      const h = (top - skirt) / COURSES;
      for (let i = 0; i < COURSES; i++) {
        const k = i & 1 ? 0.94 : 1.04;
        // A hairline of variation per course, from the wall's own position, so
        // two walls of one building are not the same eight stripes.
        const j = hash2(it.seed ^ Math.round(ax * 100), i * 37 + Math.round(az * 100)) * 0.06;
        band(skirt + i * h, skirt + (i + 1) * h, (lo + (hi - lo) * (i / COURSES)) * (k + j));
      }
      return;
    }
    if (finish.walls === WALLS.PANEL) {
      const rail = Math.min(1.0, top * 0.42);
      band(skirt, rail, lo * 0.9);
      band(rail, rail + 0.09, lo * 0.55);
      band(rail + 0.09, top - 0.1, hi);
      band(top - 0.1, top, hi * 0.72);
      return;
    }
    // Paint: body, and a cornice so the ceiling has an edge.
    band(skirt, top - 0.1, (lo + hi) / 2);
    band(top - 0.1, top, hi * 0.78);
  };

  /**
   * A flat rectangle standing on a wall, inset off it. Frames, glass, sills.
   *
   * `wall` with an explicit colour and an explicit height, plus the inset that
   * keeps three coplanar rectangles from fighting over the same depth.
   */
  const finishedFrame = (
    ax: number, az: number, bx: number, bz: number,
    nx: number, nz: number, y0: number, y1: number, inset: number,
    rgb: { r: number; g: number; b: number },
  ): void => {
    wall(ax + nx * inset, az + nz * inset, bx + nx * inset, bz + nz * inset, nx, nz, 1, 1, y0, y1, rgb);
  };

  // --- The floor and the ceiling, as fans over the shell.
  //
  // A fan is exact here and only here: the shell is an intersection of
  // half-planes and so is convex by construction. Nothing else in this file
  // relies on that; this does, and it is the reason the shell is built the way
  // it is rather than as a polygon offset.
  {
    const n = it.shell.length >> 1;
    const ox = it.shell[0];
    const oz = it.shell[1];
    for (let i = 1; i + 1 < n; i++) {
      const ax = it.shell[i * 2];
      const az = it.shell[i * 2 + 1];
      const bx = it.shell[(i + 1) * 2];
      const bz = it.shell[(i + 1) * 2 + 1];
      // Floorboards are the lightest surface in the room, and the ceiling is
      // the darkest: that ordering is what makes an unlit box read as a room
      // rather than as a flat wash.
      tri(ox, floorY, oz, ax, floorY, az, bx, floorY, bz, 0, 1, 0, 1.0);
      tri(ox, ceilY, oz, bx, ceilY, bz, ax, ceilY, az, 0, -1, 0, 0.45);
    }
  }

  /*
   * --- What the floor is finished in. Boards, carpet or tile.
   *
   * Laid as a grid of quads four millimetres over the fan above, **in the
   * building's own frame** so the boards run with the walls rather than with
   * the compass -- which is the same reason the rooms are laid out in that
   * frame, and is the difference between a floor and a doormat.
   *
   * A quad is emitted only when its centre is inside the shell. That leaves a
   * ragged few centimetres at the wall where the fan shows through, which is
   * exactly what a skirting board covers in a real room and reads as one here.
   * Clipping each quad properly would be a polygon clip per quad for a seam
   * nobody can see.
   *
   * The cell size is chosen from the floor's own area against
   * `MAX_FLOOR_QUADS`, so a terrace gets 130 mm boards and a warehouse gets
   * planks -- and neither costs more than the other.
   */
  {
    const box = it.plan.box;
    // The floor's extent in its own frame, from the shell rather than the box:
    // the box circumscribes the footprint and the shell is the footprint.
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (let i = 0; i < it.shell.length; i += 2) {
      const u = it.shell[i] * box.ux + it.shell[i + 1] * box.uz;
      const v = -it.shell[i] * box.uz + it.shell[i + 1] * box.ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const spanU = Math.max(0.5, maxU - minU);
    const spanV = Math.max(0.5, maxV - minV);
    // The natural size of one piece of this covering, and its aspect: a board
    // is long and narrow, a carpet tile and a floor tile are square.
    const wide = finish.floor === FLOOR.BOARDS ? 0.16 : finish.floor === FLOOR.TILE ? 0.45 : 0.7;
    const longM = finish.floor === FLOOR.BOARDS ? 1.9 : wide;
    // Grown together until the count fits the budget, which keeps the aspect.
    let grow = 1;
    while ((spanU / (wide * grow)) * (spanV / (longM * grow)) > MAX_FLOOR_QUADS) grow *= 1.25;
    const cu = wide * grow;
    const cv = longM * grow;
    const y = floorY + 0.004;
    const nu = Math.ceil(spanU / cu);
    const nv = Math.ceil(spanV / cv);
    for (let i = 0; i < nu; i++) {
      for (let j = 0; j < nv; j++) {
        const u0 = minU + i * cu;
        const v0 = minV + j * cv;
        const u1 = Math.min(u0 + cu, maxU);
        const v1 = Math.min(v0 + cv, maxV);
        const mu = (u0 + u1) / 2;
        const mv = (v0 + v1) / 2;
        const wx = mu * box.ux - mv * box.uz;
        const wz = mu * box.uz + mv * box.ux;
        let inside = true;
        for (const pl of it.planes) {
          if (pl.nx * wx + pl.nz * wz - pl.d < 0.02) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        /*
         * The shade of this one piece, and it is the whole of the "texture".
         *
         * Boards take a wide per-plank spread and **stagger their joins**: the
         * row index is offset by the column, so the short ends do not line up
         * across the floor, which is the single thing that makes a grid of
         * quads read as a floor rather than as graph paper. Carpet takes a
         * narrow spread, because a carpet with visible tiles is a carpet tile.
         * Tile alternates two shades in a chequer and keeps a darker grout line
         * by leaving the fan showing at every edge.
         */
        let shade: number;
        if (finish.floor === FLOOR.BOARDS) {
          shade = 0.86 + hash2(it.seed ^ (i * 7919), j + ((i * 3) % 5)) * 0.28;
        } else if (finish.floor === FLOOR.CARPET) {
          shade = 0.70 + hash2(it.seed ^ (i * 131), j * 17) * 0.08;
        } else {
          shade = ((i + j) & 1 ? 0.98 : 0.86) + hash2(it.seed, i * 31 + j) * 0.04;
        }
        // Tile keeps a grout line; boards keep a hairline join. Both are the
        // fan below showing through, which costs no geometry at all.
        const gap = finish.floor === FLOOR.TILE ? 0.02 : finish.floor === FLOOR.BOARDS ? 0.012 : 0;
        const a0 = u0 + gap;
        const a1 = u1 - gap;
        const b0 = v0 + gap;
        const b1 = v1 - gap;
        if (a1 <= a0 || b1 <= b0) continue;
        const p00x = a0 * box.ux - b0 * box.uz;
        const p00z = a0 * box.uz + b0 * box.ux;
        const p10x = a1 * box.ux - b0 * box.uz;
        const p10z = a1 * box.uz + b0 * box.ux;
        const p11x = a1 * box.ux - b1 * box.uz;
        const p11z = a1 * box.uz + b1 * box.ux;
        const p01x = a0 * box.ux - b1 * box.uz;
        const p01z = a0 * box.uz + b1 * box.ux;
        // Carpet is not the building's plaster tint. Boards and tile are, which
        // is what keeps a room looking like one material rather than three.
        const rgb = finish.floor === FLOOR.CARPET ? carpet : null;
        tri(p00x, y, p00z, p10x, y, p10z, p11x, y, p11z, 0, 1, 0, shade, rgb === null ? null : scaled(rgb, shade));
        tri(p00x, y, p00z, p11x, y, p11z, p01x, y, p01z, 0, 1, 0, shade, rgb === null ? null : scaled(rgb, shade));
      }
    }
  }

  // --- The outer wall, inward-facing, and the door panel in it.
  {
    const n = it.shell.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = it.shell[j * 2];
      const az = it.shell[j * 2 + 1];
      const bx = it.shell[i * 2];
      const bz = it.shell[i * 2 + 1];
      let ex = bx - ax;
      let ez = bz - az;
      const len = Math.sqrt((ex) * (ex) + (ez) * (ez));
      if (!(len > 1e-6)) continue;
      ex /= len;
      ez /= len;
      // **`planes[j]`, not `planes[i]`.** `shellPolygon` makes vertex `k` the
      // intersection of planes `k-1` and `k`, so the edge running from vertex
      // `j` to vertex `i` is the one lying on plane `j`. Getting that off by one
      // points every outer wall out of the room, which is a building rendered
      // entirely by its backfaces -- and therefore not rendered at all.
      const pl = it.planes[j] ?? it.planes[0];
      finishedWall(ax, az, bx, bz, pl.nx, pl.nz, 0.72, 0.86);

      /*
       * --- And the windows in it.
       *
       * *"walls and windows"* -- the owner, and they are worth more than the
       * word suggests: an interior generated out of a footprint is by
       * construction a windowless box, and a windowless box is the one shape
       * that reads as unfinished however well it is finished. A bright rectangle
       * at eye height is also the only thing in here that says which way is out.
       *
       * Spaced along the wall rather than placed, because there is nothing in
       * the data that knows where a window goes -- the same reason the door is
       * the nearest point on the perimeter. Every 3.6 m, centred in what the
       * wall can hold, and **skipped wherever the door is**, which is the one
       * place a window certainly is not.
       *
       * They are drawn, not cut. A hole would need the shell to stop being an
       * intersection of half-planes, and there is nothing to see through it: the
       * city is on another layer.
       */
      const WINDOW_EVERY_M = 3.6;
      const WINDOW_W = 1.25;
      const WINDOW_H = 1.3;
      const SILL_M = 0.95;
      // A metre and a half of wall each side, so a window is a window in a
      // wall rather than a glass wall with a bit of brick round it.
      if (len >= WINDOW_W + 1.6 && ceilY - floorY > SILL_M + WINDOW_H + 0.25) {
        const count = Math.max(1, Math.floor(len / WINDOW_EVERY_M));
        const pitch = len / count;
        for (let w = 0; w < count; w++) {
          const t = (w + 0.5) * pitch;
          const wx = ax + ex * t;
          const wz = az + ez * t;
          // Not over the door, and not half over it either.
          if (Math.sqrt((wx - doorX) * (wx - doorX) + (wz - doorZ) * (wz - doorZ)) < DOOR_GAP_M * 0.9 + WINDOW_W / 2) continue;
          const half = WINDOW_W / 2;
          // Frame first, then the glass a further two centimetres in, so
          // neither can z-fight with the wall or with the other.
          finishedFrame(
            wx - ex * (half + 0.09), wz - ez * (half + 0.09),
            wx + ex * (half + 0.09), wz + ez * (half + 0.09),
            pl.nx, pl.nz, floorY + SILL_M - 0.09, floorY + SILL_M + WINDOW_H + 0.09, 0.05,
            { r: 0.20, g: 0.18, b: 0.15 },
          );
          finishedFrame(
            wx - ex * half, wz - ez * half,
            wx + ex * half, wz + ez * half,
            pl.nx, pl.nz, floorY + SILL_M, floorY + SILL_M + WINDOW_H, 0.09,
            daylight,
          );
          // A sill, because a window with no sill is a poster of a window.
          finishedFrame(
            wx - ex * (half + 0.14), wz - ez * (half + 0.14),
            wx + ex * (half + 0.14), wz + ez * (half + 0.14),
            pl.nx, pl.nz, floorY + SILL_M - 0.14, floorY + SILL_M - 0.09, 0.14,
            { r: 0.62, g: 0.60, b: 0.56 },
          );
        }
      }
    }
  }

  // --- The way out, drawn on the wall it is in.
  //
  // A player in a windowless room has no other way to learn which of eight
  // identical walls they came through, and the alternative -- a HUD arrow --
  // would be a second thing to build and a worse answer. The owner's first
  // report from inside a building was *"need a door at exit tho so i can
  // leave"*, so this is deliberately not subtle:
  //
  //   - A **frame** behind a **panel**, at two depths, so it reads as a doorway
  //     rather than as a stain on the plaster.
  //   - An **explicit colour** rather than a shade of the building's own tint.
  //     The tint is the whole room; a door that is a darker shade of it is a
  //     door you have to already know about to find. This one is warm and light
  //     against plaster that is neither.
  //   - **Two metres twenty tall and as wide as the doorways inside**, so it is
  //     the largest single feature of any wall in the building.
  //
  // Inset off the wall in two steps so neither piece can z-fight with the wall
  // or with the other.
  {
    const inX = -doorNX;
    const inZ = -doorNZ;
    // Along the wall: the door's normal turned a quarter.
    const tx = -inZ;
    const tz = inX;
    const half = DOOR_GAP_M / 2;
    const frame = { r: 0.16, g: 0.13, b: 0.10 };
    const leaf = { r: 0.93, g: 0.78, b: 0.42 };
    /*
     * --- Off the **shell**, not off the footprint. Reported invisible.
     *
     * The door point the server sends is on the building's real outline, and
     * the wall the player is looking at is the *walkable shell* -- the same
     * outline inset by `WALL_THICK_M`. Drawing the door five centimetres in
     * from the outline therefore put it eleven centimetres **behind** the wall
     * surface, inside the wall, where it was hidden by the very wall it was
     * meant to be set into. It was there the whole time and nobody could see
     * it: *"door still not showing inside (its there but invisible)"*.
     *
     * Everything else on a wall is drawn from the shell's own planes and none
     * of them had this problem, which is exactly why it survived a check that
     * asserts every window is within 25 cm of a plane -- the door was never in
     * that test.
     */
    const fx = doorX + inX * (WALL_THICK_M + 0.02);
    const fz = doorZ + inZ * (WALL_THICK_M + 0.02);
    wall(
      fx - tx * (half + 0.18), fz - tz * (half + 0.18),
      fx + tx * (half + 0.18), fz + tz * (half + 0.18),
      inX, inZ, 1, 1,
      floorY + 0.005, floorY + 2.4,
      frame,
    );
    const px = doorX + inX * (WALL_THICK_M + 0.06);
    const pz = doorZ + inZ * (WALL_THICK_M + 0.06);
    wall(
      px - tx * half, pz - tz * half,
      px + tx * half, pz + tz * half,
      inX, inZ, 1, 1,
      floorY + 0.01, floorY + 2.2,
      leaf,
    );
  }

  // --- The partitions, from both sides, with their ends capped.
  for (const w of it.walls) {
    let ex = w.bx - w.ax;
    let ez = w.bz - w.az;
    const len = Math.sqrt((ex) * (ex) + (ez) * (ez));
    if (!(len > 1e-6)) continue;
    ex /= len;
    ez /= len;
    const nx = ez;
    const nz = -ex;
    const h = WALL_THICK_M / 2;
    // The two faces, each offset half a thickness off the centre line and each
    // facing outward from it.
    finishedWall(w.ax + nx * h, w.az + nz * h, w.bx + nx * h, w.bz + nz * h, nx, nz, 0.66, 0.80);
    finishedWall(w.bx - nx * h, w.bz - nz * h, w.ax - nx * h, w.az - nz * h, -nx, -nz, 0.66, 0.80);
    // And the two ends, which are what a doorway's reveal is: without them a
    // partition is a sheet of paper and every opening in the building shows it.
    //
    // **Except where the end is the outer wall.** A partition clipped to the
    // shell ends exactly on it, and a cap there is coplanar with the outside
    // wall and faces the opposite way -- two surfaces at one depth, one of them
    // pointing out of the room. There is nothing to reveal at that end: it is
    // buried in the wall. Collision is untouched, because a cap is drawing.
    if (!onShell(it, w.ax, w.az)) {
      wall(w.ax - nx * h, w.az - nz * h, w.ax + nx * h, w.az + nz * h, -ex, -ez, 0.58, 0.62);
    }
    if (!onShell(it, w.bx, w.bz)) {
      wall(w.bx + nx * h, w.bz + nz * h, w.bx - nx * h, w.bz - nz * h, ex, ez, 0.58, 0.62);
    }
    // And the top, so a doorway's head is a surface rather than a hole.
    tri(
      w.ax - nx * h, ceilY, w.az - nz * h,
      w.bx - nx * h, ceilY, w.bz - nz * h,
      w.bx + nx * h, ceilY, w.bz + nz * h,
      0, 1, 0, 0.5,
    );
    tri(
      w.ax - nx * h, ceilY, w.az - nz * h,
      w.bx + nx * h, ceilY, w.bz + nz * h,
      w.ax + nx * h, ceilY, w.az + nz * h,
      0, 1, 0, 0.5,
    );
  }

  // --- And what people have put in the room. See `couchInto`.
  for (const b of it.placedBoxes) couchInto(pos, nor, col, b, floorY);

  // --- The wall over every opening, and the frame round it.
  //
  // What turns a hole into a door. Four pieces, and each is doing a job the eye
  // actually uses: the **lintel** faces, which carry the wall on above the
  // opening; the **soffit**, the underside of it, which is the surface that
  // tells you the wall has thickness; the **architrave**, a darker band under
  // the soffit, which is the line a person reads as a door frame; and the
  // **jambs**, the two vertical returns at the ends. Without the last two an
  // opening reads as a bite taken out of a wall.
  for (const h of it.headers) {
    let ex = h.bx - h.ax;
    let ez = h.bz - h.az;
    const len = Math.sqrt((ex) * (ex) + (ez) * (ez));
    if (!(len > 1e-6)) continue;
    ex /= len;
    ez /= len;
    const nx = ez;
    const nz = -ex;
    const t = WALL_THICK_M / 2;
    const head = floorY + DOOR_HEAD_M;
    // The two faces of the wall above the opening.
    wall(h.ax + nx * t, h.az + nz * t, h.bx + nx * t, h.bz + nz * t, nx, nz, 0.70, 0.80, head + 0.06, ceilY);
    wall(h.bx - nx * t, h.bz - nz * t, h.ax - nx * t, h.az - nz * t, -nx, -nz, 0.70, 0.80, head + 0.06, ceilY);
    // The architrave: a darker band under them, on both sides, which is the
    // horizontal line that says "frame".
    wall(h.ax + nx * t, h.az + nz * t, h.bx + nx * t, h.bz + nz * t, nx, nz, 0.44, 0.44, head, head + 0.06);
    wall(h.bx - nx * t, h.bz - nz * t, h.ax - nx * t, h.az - nz * t, -nx, -nz, 0.44, 0.44, head, head + 0.06);
    // The soffit: the underside of the opening, looking down.
    tri(
      h.ax - nx * t, head, h.az - nz * t,
      h.bx - nx * t, head, h.bz - nz * t,
      h.bx + nx * t, head, h.bz + nz * t,
      0, -1, 0, 0.5,
    );
    tri(
      h.ax - nx * t, head, h.az - nz * t,
      h.bx + nx * t, head, h.bz + nz * t,
      h.ax + nx * t, head, h.az + nz * t,
      0, -1, 0, 0.5,
    );
    // And the two jambs: the reveal you see when you look through the opening
    // side-on. The partitions each side already cap their own ends, but they
    // stop at the head, so without these the frame has no sides above a
    // player's shoulders.
    wall(h.ax - nx * t, h.az - nz * t, h.ax + nx * t, h.az + nz * t, -ex, -ez, 0.5, 0.5, floorY, head);
    wall(h.bx + nx * t, h.bz + nz * t, h.bx - nx * t, h.bz - nz * t, ex, ez, 0.5, 0.5, floorY, head);
    // The top, so the header's own head is a surface rather than a hole.
    tri(
      h.ax - nx * t, ceilY, h.az - nz * t,
      h.bx - nx * t, ceilY, h.bz - nz * t,
      h.bx + nx * t, ceilY, h.bz + nz * t,
      0, 1, 0, 0.5,
    );
    tri(
      h.ax - nx * t, ceilY, h.az - nz * t,
      h.bx + nx * t, ceilY, h.bz + nz * t,
      h.ax + nx * t, ceilY, h.az + nz * t,
      0, 1, 0, 0.5,
    );
  }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    colors: new Float32Array(col),
    triangles: pos.length / 9,
  };
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
    // A real one: the 26-corner shed in Erskineville the owner logged off in
    // and could not take a step inside. Concave -- eleven left turns and
    // fifteen right -- and the outline's own half-planes intersect in nothing,
    // so the old shell measured every point inside it as thirty metres
    // outside. Kept verbatim, to two centimetres, as the regression it was.
    { name: "the Erskineville shed", points: poly(
        0, 0, -0.75, 6.06, -5.36, 5.65, -7.37, 17.66, 43.77, 26.64, 44.79, 21.06, 46.65, 21.27, 50.73, -0.9,
        49.61, -1, 56.98, -40.02, 50.5, -41.27, 51.3, -45.36, 36.13, -47.81, 35.07, -44.08, 29.97, -44.86,
        29.4, -41.89, 28.16, -42.11, 26.93, -34.68, 39.13, -32.19, 38.92, -29.83, 42.41, -29.15, 40.82, -21.1,
        38.58, -21.31, 36.26, -5.46, 39.87, -4.65, 38.07, 6.24,
      ), height: 9.5, inside: true },
    // And a horseshoe, which is the shape whose outline half-planes are most
    // obviously contradictory: the mouth's two inner walls face each other.
    { name: 'a horseshoe', points: poly(0, 0, 30, 0, 30, 24, 20, 24, 20, 8, 10, 8, 10, 24, 0, 24), height: 7, inside: true },
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
      const len = Math.sqrt((ex) * (ex) + (ez) * (ez));
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
      const at = arrivalAt(it);
      const still = it.resolver.resolve(at.x, at.z, at.x, at.z, 0.35, it.base);
      const moved = Math.sqrt((still.x - at.x) * (still.x - at.x) + (still.z - at.z) * (still.z - at.z));
      if (moved > 1e-3) {
        failures.push(`${c.name} lands a body ${moved.toFixed(2)} m inside its own geometry at one of its doors.`);
        break;
      }
    }
    if (it.base !== 12.5) failures.push(`${c.name} put its floor at ${it.base}, not at the building's pad.`);
  }

  // --- **Every building with an inside has an arrival a body can stand in and
  //     walk from.** The property the Erskineville shed broke: the shell was
  //     empty, so the arrival had negative clearance and the resolver pushed
  //     the body thirty metres a tick. Driven, not measured -- sixty resolves
  //     forward from the arrival must go somewhere.
  for (const c of cases) {
    if (!c.inside) continue;
    const it = southDoor(c.points, 0, c.height);
    if (it === null) continue;
    const at = arrivalAt(it);
    if (at.stuck) {
      failures.push(`${c.name} has no arrival a body can stand in; buildInterior should have refused it.`);
      continue;
    }
    if (it.resolver.clearance(at.x, at.z) < 0.34) {
      failures.push(`${c.name}'s arrival is ${it.resolver.clearance(at.x, at.z).toFixed(2)} m clear; a body there is shoved every tick.`);
    }
    // Sixty 10 cm steps in the direction with the most room, sliding.
    let best = 0;
    for (let dir = 0; dir < 8; dir++) {
      const q = dir / 8;
      const dx = q < 0.5 ? 1 - q * 4 : q * 4 - 3;
      const dz = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      let x = at.x;
      let z = at.z;
      for (let step = 0; step < 60; step++) {
        const r = it.resolver.resolve(x, z, x + (dx / len) * 0.1, z + (dz / len) * 0.1, 0.34, it.base);
        x = r.x;
        z = r.z;
      }
      const went = Math.sqrt((x - at.x) * (x - at.x) + (z - at.z) * (z - at.z));
      if (went > best) best = went;
    }
    if (best < 2) failures.push(`${c.name}: sixty steps from the arrival went ${best.toFixed(2)} m in the best direction; the room is a vice.`);
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
        const len = Math.sqrt((dx) * (dx) + (dz) * (dz)) || 1;
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
      // A building whose plan fell entirely outside the walkable shell is one
      // open hall with no partitions, which is a perfectly good interior and
      // has no graph to search.
      if (it.rooms.length === 0) continue;
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
            const d = Math.sqrt((dx) * (dx) + (dz) * (dz));
            if (d < 0.35) break;
            const nx = x + (dx / d) * Math.min(0.1, d);
            const nz = z + (dz / d) * Math.min(0.1, d);
            const r = it.resolver.resolve(x, z, nx, nz, 0.35, it.base);
            if (Math.sqrt((r.x - x) * (r.x - x) + (r.z - z) * (r.z - z)) < 1e-4) break;
            x = r.x;
            z = r.z;
          }
        }
        const [bx, bz] = world(b.u, b.v);
        if (Math.sqrt((bx - x) * (bx - x) + (bz - z) * (bz - z)) > 1.2) blocked++;
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

  // --- The line a player is shown on the way in.
  //
  // Cheap to check and worth checking: it is the one string in this feature a
  // player reads, it is generated from numbers that can be degenerate, and a
  // sentence saying "0 rooms" or "NaN rooms" is the whole feature looking
  // broken at the exact moment somebody first sees it.
  {
    for (const c of cases) {
      if (!c.inside) continue;
      const it = southDoor(c.points, 0, c.height);
      if (it === null) continue;
      const line = interiorLine(it);
      if (line.length < 12 || line.length > 90) failures.push(`${c.name}'s line is ${line.length} characters: "${line}"`);
      if (/NaN|undefined|Infinity/.test(line)) failures.push(`${c.name}'s line reads "${line}".`);
      if (/\b0 rooms\b/.test(line)) failures.push(`${c.name} announced a room with nothing in it.`);
      if (interiorLine(it) !== line) failures.push(`${c.name} described itself two different ways.`);
    }
  }

  // --- The triangles: finite, closed over the room, and the right way round.
  //
  // Only the pure half of the drawing can be checked -- CLAUDE.md's rule, and
  // the honest scope of it. What that still catches is every way this has
  // actually gone wrong: a NaN in the buffer (one bad vertex takes the whole
  // draw call with it, and the symptom is an empty screen rather than a wrong
  // one), a floor that is not under the arrival, and normals that point out of
  // the room instead of into it -- which is a building whose every surface is
  // backface-culled and which therefore renders as nothing at all.
  {
    for (const pts of [poly(0, 0, 12, 0, 12, 20, 0, 20), poly(0, 0, 14, 0, 7, 12)]) {
      const it = southDoor(pts, 4.5, 9);
      if (it === null) {
        failures.push('a plain building generated no interior to draw.');
        continue;
      }
      const at = arrivalAt(it);
      const mesh = interiorMesh(it);
      if (mesh.triangles < 12) failures.push(`an interior drew ${mesh.triangles} triangles; it is not a room.`);
      let bad = 0;
      let above = 0;
      let below = 0;
      for (let i = 0; i < mesh.positions.length; i++) {
        if (!Number.isFinite(mesh.positions[i])) bad++;
      }
      for (let i = 0; i < mesh.normals.length; i++) if (!Number.isFinite(mesh.normals[i])) bad++;
      for (let i = 0; i < mesh.colors.length; i++) {
        const c = mesh.colors[i];
        if (!Number.isFinite(c) || c < 0 || c > 1) bad++;
      }
      if (bad > 0) failures.push(`${bad} non-finite or out-of-range numbers in an interior's buffers; the draw call would render nothing.`);
      for (let i = 1; i < mesh.positions.length; i += 3) {
        if (mesh.positions[i] > it.base + CEILING_M + 0.02) above++;
        if (mesh.positions[i] < it.base - 0.02) below++;
      }
      if (above > 0 || below > 0) {
        failures.push(`${above + below} vertices fall outside the storey they belong to (${it.base.toFixed(1)} to ${(it.base + CEILING_M).toFixed(1)} m).`);
      }
      // The floor is under the arrival and the ceiling is over it: a room the
      // player stands beside rather than in is a wrong origin, and the plan's
      // frame is the one place that has bitten this feature already.
      let floorUnder = false;
      for (let t = 0; t < mesh.triangles; t++) {
        const i = t * 9;
        if (mesh.normals[t * 9 + 1] < 0.9) continue;
        if (Math.abs(mesh.positions[i + 1] - it.base) > 0.02) continue;
        const ax = mesh.positions[i];
        const az = mesh.positions[i + 2];
        const bx = mesh.positions[i + 3];
        const bz = mesh.positions[i + 5];
        const cx = mesh.positions[i + 6];
        const cz = mesh.positions[i + 8];
        // Barycentric sign test, which is exact for a triangle.
        const d1 = (at.x - bx) * (az - bz) - (ax - bx) * (at.z - bz);
        const d2 = (at.x - cx) * (bz - cz) - (bx - cx) * (at.z - cz);
        const d3 = (at.x - ax) * (cz - az) - (cx - ax) * (at.z - az);
        const neg = d1 < 0 || d2 < 0 || d3 < 0;
        const pos2 = d1 > 0 || d2 > 0 || d3 > 0;
        if (!(neg && pos2)) {
          floorUnder = true;
          break;
        }
      }
      if (!floorUnder) failures.push('there is no floor under the point a body arrives at.');
      // And the outer wall faces in. Each shell quad's normal must point toward
      // the middle of the room, or the whole building is culled away.
      let outward = 0;
      for (let t = 0; t < mesh.triangles; t++) {
        const i = t * 9;
        const ny = mesh.normals[i + 1];
        if (Math.abs(ny) > 0.01) continue;
        const cxp = (mesh.positions[i] + mesh.positions[i + 3] + mesh.positions[i + 6]) / 3;
        const czp = (mesh.positions[i + 2] + mesh.positions[i + 5] + mesh.positions[i + 8]) / 3;
        // Only the shell's own faces, and told apart by their normal rather
        // than by their position: a partition clipped to the shell has its end
        // cap *on* the shell, facing along it, and a cap is neither in nor out.
        // So a triangle lying on a plane counts only when its normal is that
        // plane's own, one way or the other -- and the wrong way is the failure.
        for (const pl of it.planes) {
          if (Math.abs(pl.nx * cxp + pl.nz * czp - pl.d) > 0.05) continue;
          const along = pl.nx * mesh.normals[i] + pl.nz * mesh.normals[i + 2];
          // The plane's normal points *into* the room, so this is the outward
          // face of an outer wall: a building drawn entirely by its backfaces.
          if (along < -0.9) outward++;
          break;
        }
      }
      if (outward > 0) failures.push(`${outward} outer-wall triangles face out of the room; the building would render as nothing.`);
    }
  }

  // --- The finishes: deterministic, bounded, and actually there.
  //
  // *"random floorboard vs carpet on ground, walls and windows"*. Four things
  // to hold, and the first is the one that would be invisible until two people
  // stood in one room and described different floors to each other.
  {
    // Deterministic per building, and different between buildings. The whole
    // reason none of this is on the wire.
    const pts = poly(0, 0, 16, 0, 16, 24, 0, 24);
    const a = southDoor(pts, 0, 9, 111);
    const b = southDoor(pts, 0, 9, 111);
    if (a === null || b === null) failures.push('a plain building generated nothing to finish.');
    else {
      const ma = interiorMesh(a);
      const mb = interiorMesh(b);
      if (ma.colors.length !== mb.colors.length) failures.push('one building generated two different meshes.');
      else {
        let differs = 0;
        for (let i = 0; i < ma.colors.length; i++) if (ma.colors[i] !== mb.colors[i]) differs++;
        if (differs > 0) failures.push(`${differs} vertex colours differ between two builds of one building; two players would see different floors.`);
      }
    }
    // And every finish is reachable. A weighting that never picked carpet would
    // be a feature that shipped as one branch, and nothing else would say so.
    const floors = new Set<number>();
    const walls = new Set<number>();
    for (let seed = 1; seed < 400; seed++) {
      const f = finishOf(seed);
      floors.add(f.floor);
      walls.add(f.walls);
    }
    if (floors.size !== 3) failures.push(`only ${floors.size} of 3 floor finishes are ever chosen.`);
    if (walls.size !== 3) failures.push(`only ${walls.size} of 3 wall finishes are ever chosen.`);
  }

  // --- Bounded. A floor covering laid at its natural size over a warehouse is
  // a quarter of a million quads, and this is one mesh built on a door press.
  {
    for (const [what, pts, height] of [
      ['a terrace', poly(0, 0, 6, 0, 6, 18, 0, 18), 7.4],
      ['a 30 m block', poly(0, 0, 30, 0, 30, 30, 0, 30), 12],
      ['a warehouse', poly(0, 0, 400, 0, 400, 260, 0, 260), 9],
    ] as Array<[string, Float32Array, number]>) {
      const it = southDoor(pts, 0, height, 9);
      if (it === null) continue;
      const mesh = interiorMesh(it);
      // The floor is the only unbounded thing in here; everything else is a
      // constant per wall. Twice the quad budget, in triangles, plus room for
      // the walls and their courses.
      if (mesh.triangles > MAX_FLOOR_QUADS * 2 + 6000) {
        failures.push(`${what} drew ${mesh.triangles} triangles; the floor covering is not bounded.`);
      }
      if (mesh.triangles < 40) failures.push(`${what} drew only ${mesh.triangles} triangles; it has no finish on it.`);
    }
  }

  // --- Windows: on the outer wall, never over the door, inside the storey.
  {
    const pts = poly(0, 0, 18, 0, 18, 26, 0, 26);
    const it = southDoor(pts, 6, 9, 7);
    if (it === null) failures.push('an 18 x 26 m building generated no interior.');
    else {
      const mesh = interiorMesh(it);
      // The glass is the one deliberately bright surface in the building, and
      // that is how it is counted: nothing else is over 0.78 on all three
      // channels. If this ever finds none, the windows have stopped being drawn.
      let glass = 0;
      let overDoor = 0;
      for (let t = 0; t < mesh.triangles; t++) {
        const i = t * 9;
        const c = t * 9;
        if (mesh.colors[c] < 0.78 || mesh.colors[c + 1] < 0.85 || mesh.colors[c + 2] < 0.9) continue;
        glass++;
        const cx = (mesh.positions[i] + mesh.positions[i + 3] + mesh.positions[i + 6]) / 3;
        const cz = (mesh.positions[i + 2] + mesh.positions[i + 5] + mesh.positions[i + 8]) / 3;
        if (Math.sqrt((cx - 9) * (cx - 9) + (cz - 0) * (cz - 0)) < DOOR_GAP_M / 2) overDoor++;
      }
      if (glass === 0) failures.push('a building with 26 m walls has no windows in it.');
      if (overDoor > 0) failures.push(`${overDoor} window triangles are drawn over the door.`);
      // And every one of them is **in the outer wall**, not floating in the
      // middle of a room. A window that missed its wall would be a bright
      // rectangle hanging in the air, and it would look deliberate.
      let adrift = 0;
      for (let t = 0; t < mesh.triangles; t++) {
        const i = t * 9;
        const c = t * 9;
        if (mesh.colors[c] < 0.78 || mesh.colors[c + 1] < 0.85 || mesh.colors[c + 2] < 0.9) continue;
        const cx = (mesh.positions[i] + mesh.positions[i + 3] + mesh.positions[i + 6]) / 3;
        const cz = (mesh.positions[i + 2] + mesh.positions[i + 5] + mesh.positions[i + 8]) / 3;
        let onWall = false;
        for (const pl of it.planes) {
          if (Math.abs(pl.nx * cx + pl.nz * cz - pl.d) < 0.25) onWall = true;
        }
        if (!onWall) adrift++;
      }
      if (adrift > 0) failures.push(`${adrift} window triangles are not on any outer wall.`);
    }
  }

  // --- Every opening has a wall over it, and none of them is collision.
  //
  // *"missing doors and stuff"* -- the owner, looking at a finished room. A gap
  // cut through a wall over its whole height is not a doorway, it is a missing
  // wall, and nothing about that is visible in a number. Three properties, and
  // the middle one is the one that would quietly wall the building up.
  {
    const it = southDoor(poly(0, 0, 26, 0, 26, 34, 0, 34), 0, 9, 31);
    if (it === null) failures.push('a 26 x 34 m building generated no interior.');
    else {
      if (it.rooms.length > 1 && it.headers.length === 0) {
        failures.push(`a building with ${it.rooms.length} rooms has no wall over any of its openings.`);
      }
      // **A header is not a wall.** If one ever reaches `walls`, the resolver
      // puts a partition across every doorway in the building and a player is
      // sealed into the room they arrived in.
      for (const h of it.headers) {
        for (const w of it.walls) {
          if (
            Math.abs(h.ax - w.ax) < 1e-6 && Math.abs(h.az - w.az) < 1e-6 &&
            Math.abs(h.bx - w.bx) < 1e-6 && Math.abs(h.bz - w.bz) < 1e-6
          ) {
            failures.push('a doorway header is in the collision walls; every opening in the building is blocked.');
            break;
          }
        }
      }
      // And a header stands over an opening rather than over solid wall: its
      // midpoint must be somewhere the resolver lets a body stand.
      let solid = 0;
      for (const h of it.headers) {
        const mx = (h.ax + h.bx) / 2;
        const mz = (h.az + h.bz) / 2;
        if (it.resolver.clearance(mx, mz) < 0) solid++;
      }
      if (solid > 0) failures.push(`${solid} headers stand over solid wall rather than over an opening.`);
      // The drawn lintel sits between head height and the ceiling, nowhere else.
      const mesh = interiorMesh(it);
      let low = 0;
      for (let i = 1; i < mesh.positions.length; i += 3) {
        const y = mesh.positions[i];
        if (y > it.base + CEILING_M + 0.02 || y < it.base - 0.02) low++;
      }
      if (low > 0) failures.push(`${low} vertices of the door frames fall outside the storey.`);
    }
  }

  // --- One building, one door, and it is the building's.
  //
  // The owner's report from a restore: *"the door incorrectly rendered where i
  // spawned, but door should be on fixed position"*. It was per entrant, so a
  // player put back into a building they had logged off in got a door beside
  // wherever they happened to be standing -- and two people in one pub saw the
  // way out on two different walls, which contradicts the first thing decided
  // about interiors.
  {
    for (const pts of [
      poly(0, 0, 14, 0, 14, 22, 0, 22),
      poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8),
      poly(0, 0, 30, 0, 30, 30, 0, 30),
    ]) {
      const a = southDoor(pts, 0, 8, 5);
      const b = southDoor(pts, 0, 8, 5);
      if (a === null || b === null) continue;
      // Two builds of one building put the door in the same place. Nothing
      // about it depends on who asked, which is the whole of the fix.
      if (a.door.x !== b.door.x || a.door.z !== b.door.z || a.door.nx !== b.door.nx) {
        failures.push('one building produced two doors; two people in it would leave by different walls.');
      }
      // It is on the outline, and it faces out of the room.
      let onEdge = false;
      const n = pts.length >> 1;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = pts[j * 2];
        const az = pts[j * 2 + 1];
        const bx = pts[i * 2];
        const bz = pts[i * 2 + 1];
        const ex = bx - ax;
        const ez = bz - az;
        const len2 = ex * ex + ez * ez;
        const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((a.door.x - ax) * ex + (a.door.z - az) * ez) / len2)) : 0;
        const gx = a.door.x - (ax + ex * t);
        const gz = a.door.z - (az + ez * t);
        if (Math.sqrt(gx * gx + gz * gz) < 1e-6) onEdge = true;
      }
      if (!onEdge) failures.push('the door is not on the building.');
      if (Math.abs(Math.sqrt((a.door.nx) * (a.door.nx) + (a.door.nz) * (a.door.nz)) - 1) > 1e-9) failures.push('the door normal is not a unit vector.');
      if ((a.door.x - a.centreX) * a.door.nx + (a.door.z - a.centreZ) * a.door.nz <= 0) {
        failures.push('the door faces into the building; leaving would step further in.');
      }
      // And the arrival is inside, at that door, for everybody.
      const at = arrivalAt(a);
      if (a.resolver.clearance(at.x, at.z) < 0.35) failures.push('the arrival at the building door is not clear.');
      const back = Math.sqrt((at.x - a.door.x) * (at.x - a.door.x) + (at.z - a.door.z) * (at.z - a.door.z));
      if (back > 3) failures.push(`the arrival is ${back.toFixed(1)} m from the door it is supposed to be just inside.`);
    }
  }

  // --- The way out is drawn **in front of** the wall, not inside it.
  //
  // The bug this exists for shipped and was reported from the room: the door
  // point is on the building's real outline and the wall a player sees is the
  // shell, inset by a wall's thickness, so a panel drawn five centimetres in
  // from the outline sat eleven centimetres *behind* the surface it was meant
  // to be set into. Invisible, and completely silent about it -- the window
  // check could not catch it because the door is not a window, and the geometry
  // was otherwise perfect.
  //
  // The assertion is signed: **inside** the shell, and close to it. A panel
  // floating in the middle of the room would be as wrong as one buried in the
  // wall, and only one of the two has ever happened.
  {
    for (const pts of [poly(0, 0, 14, 0, 14, 22, 0, 22), poly(0, 0, 4.2, 4.2, 16, -7.6, 11.8, -11.8)]) {
      const it = southDoor(pts, 0, 8, 5);
      if (it === null) continue;
      // The door on the first edge, which is where `southArrival` would knock.
      const ax = pts[0];
      const az = pts[1];
      const bx = pts[2];
      const bz = pts[3];
      const mx = (ax + bx) / 2;
      const mz = (az + bz) / 2;
      const len = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az)) || 1;
      let nx = (bz - az) / len;
      let nz = -(bx - ax) / len;
      if ((mx - it.centreX) * nx + (mz - it.centreZ) * nz < 0) {
        nx = -nx;
        nz = -nz;
      }
      const mesh = interiorMesh(it);
      // The leaf has a colour nothing else in the building has: warm, and the
      // only surface whose red channel is over 0.9 while its blue is under 0.5.
      let leaf = 0;
      let buried = 0;
      let adrift = 0;
      for (let t = 0; t < mesh.triangles; t++) {
        const c = t * 9;
        if (!(mesh.colors[c] > 0.9 && mesh.colors[c + 2] < 0.5)) continue;
        leaf++;
        const i = t * 9;
        const cx = (mesh.positions[i] + mesh.positions[i + 3] + mesh.positions[i + 6]) / 3;
        const cz = (mesh.positions[i + 2] + mesh.positions[i + 5] + mesh.positions[i + 8]) / 3;
        let least = Infinity;
        for (const pl of it.planes) {
          const d = pl.nx * cx + pl.nz * cz - pl.d;
          if (d < least) least = d;
        }
        if (least < 0) buried++;
        else if (least > 0.5) adrift++;
      }
      if (leaf === 0) failures.push('the way out is not drawn at all.');
      if (buried > 0) failures.push(`${buried} triangles of the exit door are behind the wall they are set into; it is invisible.`);
      if (adrift > 0) failures.push(`${adrift} triangles of the exit door float ${'>'}0.5 m off the wall.`);
    }
  }

  // --- Furniture: it fits where it is allowed to and nowhere else, and a body
  //     walks round it rather than through it.
  //
  // The owner's first customisation, and the rules that keep an open sandbox
  // from becoming a locked building. Everything here is driven rather than
  // measured, because "may this couch go here" is a decision and the only
  // honest test of a decision is to make it.
  {
    const pts = poly(0, 0, 16, 0, 16, 22, 0, 22);
    const it = southDoor(pts, 0, 8, 77);
    if (it === null) failures.push('a 16 x 22 m building generated no interior to furnish.');
    else {
      const at = arrivalAt(it);

      // **Nothing goes outside the room.** A couch pushed at the far wall must
      // be refused rather than left hanging over the street.
      let outside = 0;
      for (let i = 0; i < 24; i++) {
        const t = i / 24;
        const p: Placement = { kind: PLACEABLE.COUCH, x: -2 + t * 22, z: -2 + t * 28, turn: i & 3 };
        if (!placementFits(it, [], p)) continue;
        const box = boxOf(p, it.plan.box.ux, it.plan.box.uz);
        const corners = cornersOf(box);
        for (let c = 0; c < corners.length; c += 2) {
          for (const pl of it.planes) {
            if (pl.nx * corners[c] + pl.nz * corners[c + 1] - pl.d < 0) outside++;
          }
        }
      }
      if (outside > 0) failures.push(`${outside} corners of accepted couches fall outside the building.`);

      // **The way out stays visible**, which is the rule that matters most to
      // somebody who has just walked in.
      if (
        placementFits(it, [], {
          kind: PLACEABLE.COUCH,
          x: it.door.x - it.door.nx * 0.8,
          z: it.door.z - it.door.nz * 0.8,
          turn: 0,
        })
      ) {
        failures.push('a couch was allowed in front of the way out.');
      }

      // **Doorways stay walkable.** A couch across an opening is the one piece
      // of griefing an open sandbox has no answer to, because unlike a couch in
      // the middle of a floor it cannot be walked around.
      let blocked = 0;
      for (const h of it.headers) {
        const mx = (h.ax + h.bx) / 2;
        const mz = (h.az + h.bz) / 2;
        if (placementFits(it, [], { kind: PLACEABLE.COUCH, x: mx, z: mz, turn: 0 })) blocked++;
        if (placementFits(it, [], { kind: PLACEABLE.COUCH, x: mx, z: mz, turn: 1 })) blocked++;
      }
      if (blocked > 0) failures.push(`${blocked} couches were allowed to stand in a doorway.`);

      // **Two things cannot share a spot**, whichever order they arrive in.
      // Well away from the door, so this is testing the overlap rule rather
      // than the door clearance one.
      // Somewhere clear, found the way a player finds one: a ring out from the
      // arrival. Fixing on the centre would be fixing on whatever the plan put
      // there, which as often as not is a partition.
      let first: Placement | null = null;
      for (let ring = 1; ring <= 12 && first === null; ring++) {
        for (let dir = 0; dir < 8 && first === null; dir++) {
          const q = dir / 8;
          const dx = q < 0.5 ? 1 - q * 4 : q * 4 - 3;
          const dz = q < 0.25 ? q * 4 : q < 0.75 ? 2 - q * 4 : q * 4 - 4;
          const len = Math.sqrt((dx) * (dx) + (dz) * (dz)) || 1;
          const want: Placement = {
            kind: PLACEABLE.COUCH,
            x: at.x + (dx / len) * ring * 0.9,
            z: at.z + (dz / len) * ring * 0.9,
            turn: 0,
          };
          if (placementFits(it, [], want)) first = want;
        }
      }
      if (first === null) {
        failures.push('no couch could be placed anywhere in an empty 16 x 22 m room.');
        return failures;
      }
      if (placementFits(it, [first], { ...first })) failures.push('two couches were allowed in the same spot.');
      if (placementFits(it, [first], { ...first, x: first.x + 0.4 })) {
        failures.push('a couch was allowed 40 cm inside another one.');
      }
      if (!placementFits(it, [first], { ...first, x: first.x + 2.2 })) {
        failures.push('a couch was refused beside another one with clear air between them.');
      }

      // **And a body walks round what is there.** The resolver has to start
      // pushing on the tick the list arrives, or a placement is a decal.
      setPlacements(it, [first]);
      const into = it.resolver.resolve(
        first.x + 3, first.z, first.x, first.z, 0.35, it.base,
      );
      if (!into.hit) failures.push('a body walked into a couch and was not stopped.');
      if (it.resolver.clearance(into.x, into.z) < 0.35 - 1e-6) {
        failures.push('a body stopped by a couch is standing inside it.');
      }
      if (it.placedBoxes.length !== 1) failures.push('the drawing and the collision hold different rooms.');
      // And it is drawn.
      const bare = interiorMesh(it).triangles;
      setPlacements(it, [first, { ...first, x: first.x + 2.4 }]);
      const furnished = interiorMesh(it).triangles;
      if (furnished <= bare) failures.push('adding a couch drew no more triangles; furniture is invisible.');
      setPlacements(it, []);
      if (it.resolver.clearance(first.x, first.z) < 0) failures.push('a removed couch is still in the collision.');
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
